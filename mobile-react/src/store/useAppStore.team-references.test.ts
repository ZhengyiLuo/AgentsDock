import assert from 'node:assert/strict'
import test from 'node:test'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ChatReference, Health, QueuedTurn, Session, TeamReference, WorkspacePreferences } from '../types'
import { mergeWorkspacePreferences } from '../lib/cache-migration'
import { loadWorkspacePreferences, saveWorkspacePreferences } from '../storage/cache'
import { client, useAppStore } from './useAppStore'

// Exercise real store admission, API JSON encoding, and cache normalization.
// Every transport is intercepted in memory; no server or credentials are used.
const SESSION = 'team-reference-chat'
const session: Session = { id: SESSION, title: 'Team references', backend: 'codex', model: 'test-model', effort: 'high' }
const health: Health = {
  ok: true,
  server_identity: 'server-local',
  capabilities: {
    codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1' },
    agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
    team_hub_v1: { available: true, version: 1, designated_host: false, base_path: null, server_session_base_path: '/api/team-hub-server', hub_id: 'hub-1', host_server_identity: 'server-hub' },
  },
}

function reference(text: string, name = 'DPark', target = 'server-peer'): TeamReference {
  const start = text.indexOf(`@@${name}`)
  assert(start >= 0)
  return { kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: target, display_name_snapshot: name, source_text_start: start, source_text_end: start + name.length + 2, grant_intent: true }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function response(value: unknown = { session }, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
const originalFetch = globalThis.fetch
const originalQueue = client.queue
const originalSync = useAppStore.getState().syncSelectedSession
let respond = async (): Promise<Response> => response()
globalThis.fetch = async (input, init) => {
  requests.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) })
  return respond()
}
client.queue = async () => useAppStore.getState().snapshots[SESSION]?.queuedTurns ?? []

function reset(draft = 'Ask @@DPark for help.', references = [reference(draft)]): void {
  client.markValidated()
  requests.length = 0
  respond = async () => response()
  useAppStore.setState({
    initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    serverURL: 'http://127.0.0.1:7850', connected: true, connecting: false,
    switchingProfileId: null, workspaceAdopting: false, selectedSessionId: SESSION,
    health, runtime: null, sessions: [session], drafts: { [SESSION]: draft },
    chatReferencesBySession: {}, teamReferencesBySession: { [SESSION]: references },
    uploads: {}, uploadPending: {}, uploadFailed: {}, snapshots: {}, historyWindow: null,
    sendingSessionIds: new Set(), turnAdmissionTokens: {}, error: null,
    syncSelectedSession: async () => {},
  })
}

function setQueue(prompt: string, references: TeamReference[], patch: Partial<QueuedTurn> = {}): QueuedTurn {
  const queued: QueuedTurn = { queued_id: 'queued-team-message', prompt, file_ids: ['queued-file'], team_references: references, ...patch }
  useAppStore.setState({ snapshots: { [SESSION]: { session, events: [], queuedTurns: [queued], files: [], filesTotal: 0, hasMore: false, cachedAt: Date.now() } } })
  return queued
}

const send = () => useAppStore.getState().sendPrompt(false, 0, SESSION)
const update = (prompt: string, generation = 0, references?: TeamReference[]) => useAppStore.getState().updateQueued(SESSION, 'queued-team-message', prompt, undefined, generation, references)

try {
  await test('send trims text and UTF-16 offsets while retaining explicit target metadata and provider capabilities', async () => {
    const draft = '\n  🧭 Ask @@DPark for help.  '
    const selected = { ...reference(draft), transport_hint: 'not-public' }
    reset(draft, [selected])
    useAppStore.setState({ uploads: { [SESSION]: [{ id: 'attached-file', filename: 'notes.txt' }] } })
    assert.equal(await send(), true)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.match(requests[0].url, /\/api\/sessions\/team-reference-chat\/turns$/u)
    assert.deepEqual(requests[0].body, {
      prompt: draft.trim(), file_ids: ['attached-file'], model: 'test-model', effort: 'high',
      client_capabilities: ['codex_interactive_v1', 'codex_goal_steer_v1'], team_references: [reference(draft.trim())],
    })
    assert.equal(useAppStore.getState().drafts[SESSION], '')
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], [])
    assert.deepEqual(useAppStore.getState().uploads[SESSION], [])
    assert.equal(selected.source_text_start, draft.indexOf('@@DPark'), 'sending must not mutate the admission snapshot')
  })

  await test('plain double-@ text never creates recipient authority', async () => {
    reset('Ask @@DPark for help.', [])
    assert.equal(await send(), true)
    assert.equal(Object.hasOwn(requests[0].body, 'team_references'), false)
    assert.equal(Object.hasOwn(requests[0].body, 'chat_references'), false)
  })

  await test('invalid or edited team references block sending without consuming the composer', async () => {
    for (const patch of [
      { grant_intent: false }, { recipient_kind: 'all_servers', target_id: 'all_servers' },
      { team_id: '' }, { target_id: ' peer ' }, { source_text_start: 0 },
      { display_name_snapshot: 'Renamed' },
    ]) {
      const draft = 'Ask @@DPark for help.'
      const invalid = { ...reference(draft), ...patch } as TeamReference
      reset(draft, [invalid])
      assert.equal(await send(), false, JSON.stringify(patch))
      assert.equal(requests.length, 0)
      assert.equal(useAppStore.getState().drafts[SESSION], draft)
      assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], [invalid])
      assert.match(useAppStore.getState().error ?? '', /Team Network reference/u)
    }
  })

  await test('send requires the exact message contract and approved proxy', async () => {
    const variants: Health[] = [
      { ...health, capabilities: { ...health.capabilities, agent_team_messages_v1: { available: true, version: 2, mention_sigil: '@@', send_requires_mention: true } } },
      { ...health, capabilities: { ...health.capabilities, agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@', send_requires_mention: true } } },
      { ...health, capabilities: { ...health.capabilities, agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: false } } },
      { ...health, capabilities: { ...health.capabilities, team_hub_v1: undefined } },
    ]
    for (const unavailable of variants) {
      reset()
      useAppStore.setState({ health: unavailable })
      assert.equal(await send(), false)
      assert.equal(requests.length, 0)
      assert.equal(useAppStore.getState().teamReferencesBySession[SESSION]?.length, 1)
    }
  })

  await test('stale profile generation, profile identity, and revoked validation cannot send stored recipients', async () => {
    for (const patch of [{ profileGeneration: 1 }, { activeProfileId: 'different-profile' }, { connecting: true }]) {
      reset()
      useAppStore.setState(patch)
      assert.equal(await send(), false)
      assert.equal(requests.length, 0)
      assert.equal(useAppStore.getState().teamReferencesBySession[SESSION]?.length, 1)
    }
    reset()
    client.revokeValidation()
    assert.equal(await send(), false)
    assert.equal(requests.length, 0)
    client.markValidated()
    const before = useAppStore.getState().teamReferencesBySession[SESSION]
    useAppStore.getState().setTeamReferencesForSession(SESSION, [], 99)
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], before)
  })

  await test('failed send restores the original draft and shifted references for newly typed text', async () => {
    const admitted = '\n Ask @@DPark for help. '
    const newer = 'Also ask @@Other for a review.'
    reset(admitted)
    const gate = deferred<Response>()
    respond = () => gate.promise
    const sending = send()
    assert.equal(useAppStore.getState().drafts[SESSION], '')
    useAppStore.setState({ drafts: { [SESSION]: newer }, teamReferencesBySession: { [SESSION]: [reference(newer, 'Other', 'server-other')] } })
    gate.resolve(response({ detail: 'Temporary send failure' }, 503))
    assert.equal(await sending, false)
    const restored = `${admitted}\n\n${newer}`
    assert.equal(useAppStore.getState().drafts[SESSION], restored)
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], [reference(restored), reference(restored, 'Other', 'server-other')])
    const saved = await loadWorkspacePreferences('profile:uninitialized')
    assert.equal(saved.drafts[SESSION], restored)
    assert.deepEqual(saved.teamReferencesBySession?.[SESSION], useAppStore.getState().teamReferencesBySession[SESSION])
  })

  await test('a successful admitted send preserves a newer composer and its recipient selection', async () => {
    const admitted = 'Ask @@DPark for help.'
    const newer = 'Also ask @@Other for a review.'
    reset(newer, [reference(newer, 'Other', 'server-other')])
    assert.equal(await useAppStore.getState().sendPrompt(false, 0, SESSION, { admittedDraft: admitted, admittedFiles: [], teamReferences: [reference(admitted)] }), true)
    assert.deepEqual(requests[0].body.team_references, [reference(admitted)])
    assert.equal(useAppStore.getState().drafts[SESSION], newer)
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], [reference(newer, 'Other', 'server-other')])
  })

  await test('a late response after identity validation is revoked cannot consume a newer recipient draft', async () => {
    const admitted = 'Ask @@DPark for help.'
    const newer = 'Also ask @@Other for a review.'
    reset(admitted)
    const gate = deferred<Response>()
    respond = () => gate.promise
    const sending = send()
    useAppStore.setState({ drafts: { [SESSION]: newer }, teamReferencesBySession: { [SESSION]: [reference(newer, 'Other', 'server-other')] } })
    client.revokeValidation()
    gate.resolve(response())
    assert.equal(await sending, false)
    const restored = `${admitted}\n\n${newer}`
    assert.equal(useAppStore.getState().drafts[SESSION], restored)
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], [reference(restored), reference(restored, 'Other', 'server-other')])
    client.markValidated()
  })

  await test('composer-independent sends cannot reuse stored or explicitly supplied recipients', async () => {
    reset()
    const before = useAppStore.getState().teamReferencesBySession[SESSION]
    assert.equal(await useAppStore.getState().sendPrompt(false, 0, SESSION, { consumeComposer: false, promptOverride: 'Continue.', teamReferences: before }), true)
    assert.equal(Object.hasOwn(requests[0].body, 'team_references'), false)
    assert.deepEqual(useAppStore.getState().teamReferencesBySession[SESSION], before)
  })

  await test('queue edits preserve exact recipients, shifted spans, text, and interactive capabilities', async () => {
    reset()
    const original = 'Ask @@DPark for help.'
    setQueue(original, [reference(original)])
    const revised = '  Please ask @@DPark for help today.  '
    assert.equal(await update(revised, 0, [reference(revised)]), true)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'PATCH')
    assert.deepEqual(requests[0].body, {
      prompt: revised.trim(), chat_references: [], client_capabilities: ['codex_interactive_v1', 'codex_goal_steer_v1'],
      team_references: [reference(revised.trim())],
    })
    assert.deepEqual(useAppStore.getState().snapshots[SESSION].queuedTurns[0].file_ids, ['queued-file'])
  })

  await test('local @Chat grants and cross-server @@ recipients coexist through send and queue edits', async () => {
    const prompt = 'Ask @Local and @@DPark for help.'
    const local: ChatReference = { session_id: 'chat-local', display_title_snapshot: 'Local', action: 'route', grant_intent: true, source_text_start: 4, source_text_end: 10 }
    const mixedHealth: Health = { ...health, capabilities: { ...health.capabilities, cross_chat_handoffs_v1: {
      available: true, version: 7, actions: ['route'], supported_target_backends: ['codex', 'claude'],
      features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false },
      agent_routes: { policy: 'default_deny', client_capability: 'agent_cross_chat_routes_v2' },
    } } }
    const configureMixed = () => useAppStore.setState({ health: mixedHealth, sessions: [session, { id: 'chat-local', title: 'Local', backend: 'claude' }], chatReferencesBySession: { [SESSION]: [local] } })
    reset(prompt)
    configureMixed()
    assert.equal(await send(), true)
    assert.deepEqual(requests[0].body.chat_references, [local])
    assert.deepEqual(requests[0].body.team_references, [reference(prompt)])
    assert.deepEqual(requests[0].body.client_capabilities, ['codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2', 'agent_cross_chat_routes_v2'])
    reset(prompt)
    configureMixed()
    setQueue(prompt, [reference(prompt)], { chat_references: [local] })
    const revised = `Please ${prompt}`
    assert.equal(await update(revised), true)
    assert.deepEqual(requests[0].body.chat_references, [{ ...local, source_text_start: 11, source_text_end: 17 }])
    assert.deepEqual(requests[0].body.team_references, [reference(revised)])
  })

  await test('unambiguous queue prefix edits preserve the existing selected recipient without a new grant', async () => {
    reset()
    const original = 'Ask @@DPark for help.'
    setQueue(original, [reference(original)])
    const revised = `Please ${original}`
    assert.equal(await update(revised), true)
    assert.deepEqual(requests[0].body.team_references, [reference(revised)])
  })

  await test('ambiguous queue edits without tracked metadata refuse to silently drop an unchanged recipient', async () => {
    reset()
    const original = 'Ask @@DPark for help.'
    setQueue(original, [reference(original)])
    assert.equal(await update('Please ask @@DPark for help today.'), false)
    assert.equal(requests.length, 0)
    assert.deepEqual(useAppStore.getState().snapshots[SESSION].queuedTurns[0].team_references, [reference(original)])
  })

  await test('editing or deleting a queued marker revokes its team authority without changing other text', async () => {
    for (const revised of ['Ask @@DParks for help.', 'Ask for help.']) {
      reset()
      const original = 'Ask @@DPark for help.'
      setQueue(original, [reference(original)])
      assert.equal(await update(revised), true)
      assert.equal(requests[0].body.prompt, revised)
      assert.deepEqual(requests[0].body.team_references, [])
    }
  })

  await test('unchanged unsupported queue recipients are rejected rather than silently dropping their permissions', async () => {
    for (const unsupported of [
      { kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team-1', target_id: 'all_servers', display_name_snapshot: 'all', source_text_start: 4, source_text_end: 9, grant_intent: true },
      { kind: 'skill', team_id: 'team-1', target_id: 'skill-1', display_name_snapshot: 'all', source_text_start: 4, source_text_end: 9, grant_intent: true },
      { ...reference('Ask @@all for help.', 'all'), grant_intent: false },
    ]) {
      reset()
      const queued = setQueue('Ask @@all for help.', [unsupported as TeamReference])
      assert.equal(await update(queued.prompt), false)
      assert.equal(requests.length, 0)
      assert.deepEqual(useAppStore.getState().snapshots[SESSION].queuedTurns[0].team_references, [unsupported])
    }
  })

  await test('queue edits reject missing capabilities, stale generation, and immutable incoming deliveries', async () => {
    for (const reason of ['capability', 'generation', 'incoming']) {
      reset()
      const prompt = 'Ask @@DPark for help.'
      setQueue(prompt, [reference(prompt)], reason === 'incoming' ? { purpose: 'cross_chat_handoff_delivery' } : {})
      if (reason === 'capability') useAppStore.setState({ health: { ok: true } })
      assert.equal(await update(prompt, reason === 'generation' ? 99 : 0), false)
      assert.equal(requests.length, 0)
    }
  })

  await test('draft persistence retains only valid public references in their own namespace', async () => {
    reset()
    await AsyncStorage.clear()
    const draft = 'Ask @@DPark for help.'
    const selected = { ...reference(draft), transport_hint: 'not-public' }
    useAppStore.getState().setTeamReferencesForSession(SESSION, [selected], 0)
    selected.target_id = 'mutated-after-selection'
    await new Promise(resolve => setTimeout(resolve, 400))
    const saved = await loadWorkspacePreferences('profile:uninitialized')
    assert.equal(saved.drafts[SESSION], draft)
    assert.deepEqual(saved.teamReferencesBySession?.[SESSION], [reference(draft)])
    const other: WorkspacePreferences = { selectedSessionId: SESSION, drafts: { [SESSION]: 'Other @@DPark draft.' }, folderOrder: [], collapsedFolders: [] }
    await saveWorkspacePreferences('server-other', other)
    assert.equal((await loadWorkspacePreferences('server-other')).teamReferencesBySession, undefined)
    const merged = mergeWorkspacePreferences(saved, { ...other, drafts: { [SESSION]: draft } })
    assert.equal(merged.teamReferencesBySession, undefined, 'a destination draft owns the absence of recipient authority even when its text matches')
    const migrated = mergeWorkspacePreferences(saved, { ...other, drafts: {} })
    assert.deepEqual(migrated.teamReferencesBySession?.[SESSION], [reference(draft)])
  })
} finally {
  client.queue = originalQueue
  useAppStore.setState({ syncSelectedSession: originalSync })
  globalThis.fetch = originalFetch
}
