import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, Health, QueuedTurn, Session, TeamReference } from '../types'
import { client, useAppStore } from './useAppStore'

// Exercise real store admission and HTTP bodies. No transport escapes these
// synthetic handlers, and any unexpected goal/stop/send endpoint fails closed.
const session: Session = { id: 'goal-chat', title: 'Synthetic goal', backend: 'codex', model: 'test-model', effort: 'high',
  codex_goal: { threadId: 'provider-thread', objective: 'Synthetic goal objective', status: 'active',
    tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 1 } }
const capabilities = ['codex_interactive_v1', 'codex_goal_steer_v1']
const health: Health = { ok: true, server_identity: 'synthetic-server', server_instance_id: 'boot',
  active: [session.id], active_runs: [{ session_id: session.id, run_id: 'goal-owner' }],
  capabilities: { codex_controls: { available: true, version: 2, interactive_client_capability: 'codex_interactive_v1' } } }
const prior: QueuedTurn = { queued_id: 'other-message', session_id: session.id, prompt: 'Keep unrelated work', file_ids: [], position: 1 }
const followup: QueuedTurn = { queued_id: 'goal-followup', session_id: session.id, prompt: 'Additional context', file_ids: ['attached-file'], position: 2 }
type Request = { path: string; method: string; body: Record<string, unknown> }
const requests: Request[] = []
const originalFetch = globalThis.fetch
const originalSync = useAppStore.getState().syncSelectedSession
let queue: QueuedTurn[] = []
let syncs = 0
let boot = 0
let respond: (request: Request) => Promise<Response>
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let index = 0; index < 30; index += 1) await Promise.resolve() }
function event(type: string, patch: Partial<Event> = {}): Event {
  return { id: `synthetic-${type}`, type, session_id: session.id, seq: 20, ts: '2026-09-15T12:00:00Z', ...patch }
}
function reset(draft = followup.prompt, goalStatus: 'active' | 'paused' = 'active') {
  client.markValidated()
  requests.length = 0; syncs = 0; queue = [prior]; boot += 1
  const selected = { ...session, codex_goal: { ...session.codex_goal!, status: goalStatus } }
  useAppStore.setState({ initialized: true, serverConfigured: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false, selectedSessionId: session.id,
    sessions: [selected], health: { ...health, server_instance_id: `boot-${boot}` }, runtime: null,
    activeSessionIds: new Set(goalStatus === 'active' ? [session.id] : []),
    drafts: { [session.id]: draft }, chatReferencesBySession: {}, teamReferencesBySession: {},
    uploads: { [session.id]: [{ id: 'attached-file', filename: 'context.txt' }] }, uploadPending: {}, uploadFailed: {}, sendingSessionIds: new Set(), turnAdmissionTokens: {},
    pendingQueuedRunIds: new Set(), queuedRunStatus: {}, stoppingSessionIds: new Set(), error: null,
    snapshots: { [session.id]: { session: selected, events: [], queuedTurns: queue, files: [], filesTotal: 0,
      hasMore: false, latestSeq: 10, cachedAt: Date.now() } }, historyWindow: null,
    syncSelectedSession: async () => { syncs += 1 },
  })
  respond = async request => {
    if (request.method === 'GET' && request.path === `/api/sessions/${session.id}`) return json({ session, events: [], queued_turns: queue })
    throw new Error(`Unexpected synthetic endpoint: ${request.method} ${request.path}`)
  }
}
function installQueue(turns: QueuedTurn[]) {
  queue = turns
  const snapshot = useAppStore.getState().snapshots[session.id]
  useAppStore.setState({ snapshots: { [session.id]: { ...snapshot, queuedTurns: turns } } })
}
function acceptSend(request: Request): Response {
  assert.deepEqual(request.body.client_capabilities, capabilities)
  assert.deepEqual(request.body.file_ids, followup.file_ids)
  assert.equal(request.path, `/api/sessions/${session.id}/turns`)
  assert.equal(request.method, 'POST')
  queue = [...queue, followup]
  return json({ session: useAppStore.getState().sessions[0], queued: true, queued_id: followup.queued_id,
    event: event('turn_queued', { queued_id: followup.queued_id, prompt: followup.prompt, file_ids: followup.file_ids, position: queue.length }) })
}
const send = (steer = false) => useAppStore.getState().sendPrompt(steer, 0, session.id)
const run = () => useAppStore.getState().runQueuedNow(session.id, followup.queued_id, 0)
const rejection = () => json({ detail: { code: 'force_send_blocked', guard: 'active_goal_requires_native_steer', queued_id: followup.queued_id, retryable: true,
  message: 'This follow-up cannot safely steer the active Codex goal. It remains queued; the goal was not paused.' } }, 409)

try {
  globalThis.fetch = async (input, init) => {
    const request = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) }
    requests.push(request)
    return respond(request)
  }
  await test('normal Send during an active goal queues exactly once with native-steer support and no goal mutation', async () => {
    reset()
    const goal = useAppStore.getState().sessions[0].codex_goal
    respond = async request => acceptSend(request)
    assert.equal(await send(), true)
    assert.equal(requests.length, 1)
    assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id), [prior.queued_id, followup.queued_id])
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, goal)
    assert.equal(useAppStore.getState().health?.active_runs?.[0].run_id, 'goal-owner')
    assert.equal(useAppStore.getState().drafts[session.id], '')
  })
  for (const accepted of [true, false]) await test(`explicit goal steering ${accepted ? 'accepts' : 'rejects'} without changing owner, goal, other queue or next draft`, async () => {
    reset()
    const goal = useAppStore.getState().sessions[0].codex_goal
    const admitted = deferred<void>(); const finish = deferred<void>()
    respond = async request => {
      if (request.path.endsWith('/turns')) return acceptSend(request)
      if (request.method === 'GET' && request.path === `/api/sessions/${session.id}`) return json({ session, events: [], queued_turns: queue })
      assert.equal(request.path, `/api/sessions/${session.id}/queue/${followup.queued_id}/run-now`)
      assert.deepEqual(request.body, { accept_deferred_queue_response: true })
      admitted.resolve(); await finish.promise
      if (!accepted) return rejection()
      queue = queue.filter(turn => turn.queued_id !== followup.queued_id)
      return json({ ok: true, queued_id: followup.queued_id, native_steer: true })
    }
    const pending = send(true)
    await admitted.promise
    assert.equal(useAppStore.getState().pendingQueuedRunIds.has(followup.queued_id), true)
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, goal)
    assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id), [prior.queued_id, followup.queued_id])
    useAppStore.getState().setSessionDraft(session.id, 'Keep my next unsent draft', 0)
    assert.equal(await send(true), false, 'a pending send must not duplicate admission')
    const duplicateRun = run()
    finish.resolve()
    assert.equal(await pending, true, 'the message remains accepted into the queue even if steering is refused')
    assert.equal(await duplicateRun, accepted)
    assert.equal(requests.filter(request => request.path.endsWith('/turns')).length, 1)
    assert.equal(requests.filter(request => request.path.endsWith('/run-now')).length, 1)
    assert.equal(useAppStore.getState().pendingQueuedRunIds.size, 0)
    assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id), accepted ? [prior.queued_id] : [prior.queued_id, followup.queued_id])
    assert.equal(useAppStore.getState().drafts[session.id], 'Keep my next unsent draft')
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, goal)
    assert.equal(useAppStore.getState().health?.active_runs?.[0].run_id, 'goal-owner')
    if (!accepted) {
      assert.match(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /still queued.*goal was not paused/u)
      assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.goal_steer_rejected, true)
      assert.match(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /If this message.*before the app update.*same queued message.*Do not resend/u)
    }
  })
  await test('an explicit Save upgrades an old queued item at its existing ID, preserving attachments and requiring a separate Run now', async () => {
    reset('Unrelated composer draft')
    installQueue([prior, followup])
    useAppStore.setState({ queuedRunStatus: { [session.id]: { queued_id: followup.queued_id, tone: 'error', message: 'Previous goal rejection', goal_steer_rejected: true } } })
    let persistedCapabilities: string[] = ['codex_interactive_v1']
    respond = async request => {
      if (request.method === 'GET' && request.path === `/api/sessions/${session.id}`) return json({ session, events: [], queued_turns: queue })
      if (request.method === 'PATCH') {
        assert.equal(request.path, `/api/sessions/${session.id}/queue/${followup.queued_id}`)
        assert.deepEqual(request.body, { client_capabilities: capabilities }, 'unchanged Save must preserve body, files and hidden saved route snapshots')
        persistedCapabilities = request.body.client_capabilities as string[]
        return json({ ok: true })
      }
      assert.equal(request.path, `/api/sessions/${session.id}/queue/${followup.queued_id}/run-now`)
      assert.equal(persistedCapabilities.includes('codex_goal_steer_v1'), true)
      queue = [prior]
      return json({ ok: true, native_steer: true })
    }
    assert.equal(await useAppStore.getState().updateQueued(session.id, followup.queued_id, followup.prompt, undefined, 0), true)
    assert.equal(requests.some(request => request.method === 'POST'), false, 'Save must not send or steer automatically')
    assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns, [prior, followup])
    assert.deepEqual(queue[1].file_ids, ['attached-file'])
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined, 'Save only clears the old rejection; it does not claim delivery')
    assert.equal(await run(), true)
    assert.equal(requests.some(request => request.path.endsWith('/turns')), false, 'upgrade must never duplicate the old message')
    assert.equal(useAppStore.getState().drafts[session.id], 'Unrelated composer draft')
  })
  await test('unchanged attachment-only Save upgrades the exact queued item without empty prompt, file reupload, route edits or a new turn', async () => {
    reset('Keep composer draft')
    const attached = { ...followup, prompt: '' }
    const savedRoutes = [{ route_id: 'existing-saved-route', target_session_id: 'existing-target', action: 'instruction' }]
    const serverItem = { ...attached, provider_cross_chat_route_snapshot: savedRoutes }
    const originalServerItem = structuredClone(serverItem)
    installQueue([prior, attached])
    respond = async request => {
      if (request.method === 'GET') return json({ session, events: [], queued_turns: queue })
      assert.equal(request.method, 'PATCH')
      assert.equal(request.path, `/api/sessions/${session.id}/queue/${followup.queued_id}`)
      assert.deepEqual(request.body, { client_capabilities: capabilities })
      assert.deepEqual(serverItem, originalServerItem, 'capability-only request has no body, file or saved route changes')
      assert.equal(serverItem.provider_cross_chat_route_snapshot, savedRoutes)
      return json({ ok: true })
    }
    assert.equal(await useAppStore.getState().updateQueued(session.id, followup.queued_id, '', undefined, 0), true)
    assert.deepEqual(queue, [prior, attached])
    assert.equal(useAppStore.getState().drafts[session.id], 'Keep composer draft')
    assert.equal(requests.some(request => request.method === 'POST'), false)
    installQueue([prior, followup])
    const before = requests.length
    assert.equal(await useAppStore.getState().updateQueued(session.id, followup.queued_id, '', undefined, 0), false,
      'attachment recovery must never silently discard a nonempty prompt')
    assert.equal(requests.length, before)
  })
  await test('a successful Save cannot clear a newer rejection for the same queued ID', async () => {
    reset(); installQueue([prior, followup])
    const old = { queued_id: followup.queued_id, tone: 'error' as const, message: 'Old goal rejection', goal_steer_rejected: true }
    const newer = { ...old, message: 'New independent rejection' }
    useAppStore.setState({ queuedRunStatus: { [session.id]: old } })
    const finish = deferred<void>()
    respond = async request => {
      if (request.method === 'GET') return json({ session, events: [], queued_turns: queue })
      await finish.promise; return json({ ok: true })
    }
    const pending = useAppStore.getState().updateQueued(session.id, followup.queued_id, followup.prompt, undefined, 0)
    useAppStore.setState({ queuedRunStatus: { [session.id]: newer } })
    finish.resolve()
    assert.equal(await pending, true)
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], newer)
  })
  await test('goal-recovery guidance is absent for different guards, mismatched IDs, uncertainty, or unconfirmed queue reads', async () => {
    for (const variant of ['guard', 'code', 'identity', 'uncertain', 'unconfirmed', 'controls', 'promoted', 'foreign', 'agent']) {
      reset(); installQueue([prior, followup])
      if (variant === 'controls') useAppStore.setState({ health: { ...health, capabilities: {} } })
      if (variant === 'promoted') installQueue([prior, { ...followup, promoted: true }])
      if (variant === 'foreign') installQueue([prior, { ...followup, session_id: 'other-chat' }])
      if (variant === 'agent') {
        installQueue([prior, { ...followup, purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1',
          cross_chat_envelope_id: 'incoming-message', source_session_id: 'source-chat', target_session_id: session.id, message_revision: 0 }])
        useAppStore.setState({ health: { ...health, capabilities: { ...health.capabilities,
          cross_chat_handoffs_v1: { available: true, features: { async_queued_message_controls: true } } } } })
      }
      respond = async request => request.method === 'GET'
        ? variant === 'unconfirmed' ? json({ detail: 'Synthetic queue unavailable' }, 503) : json({ session, events: [], queued_turns: queue })
        : json({ detail: { code: variant === 'code' ? 'other_error' : 'force_send_blocked',
          guard: variant === 'guard' ? 'active_goal_requires_native_steer_near_miss' : 'active_goal_requires_native_steer',
          queued_id: variant === 'identity' ? 'other-queued-id' : followup.queued_id,
          delivery_uncertain: variant === 'uncertain', message: 'Synthetic refusal' } }, 409)
      assert.equal(await run(), false)
      assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.goal_steer_rejected, undefined, variant)
      assert.doesNotMatch(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /choose Edit/u)
    }
  })
  await test('a rejected old queued item is neither silently edited nor automatically resent', async () => {
    reset(); installQueue([prior, followup])
    respond = async request => request.method === 'GET' ? json({ session, events: [], queued_turns: queue }) : rejection()
    assert.equal(await run(), false)
    assert.equal(requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(requests.some(request => request.method === 'PATCH' || request.path.endsWith('/turns')), false)
    assert.deepEqual(queue, [prior, followup])
  })
  await test('the exact older-server text fallback offers conditional recovery but unrelated errors do not', async () => {
    for (const detail of [
      'This follow-up cannot safely steer the active Codex goal. It remains queued; the goal was not paused.',
      'This follow-up cannot safely steer the active Codex goal. Unknown outcome.',
    ]) {
      reset(); installQueue([prior, followup])
      respond = async request => request.method === 'GET' ? json({ session, events: [], queued_turns: queue }) : json({ detail }, 409)
      assert.equal(await run(), false)
      assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.goal_steer_rejected, detail.endsWith('was not paused.') ? true : undefined)
    }
  })
  await test('paused goals do not block sending, and failed admission restores text typed while waiting', async () => {
    reset('Original paused-goal question', 'paused')
    const goal = useAppStore.getState().sessions[0].codex_goal
    const finish = deferred<void>()
    respond = async request => { assert.deepEqual(request.body.client_capabilities, capabilities); await finish.promise; return json({ detail: 'Synthetic send rejection' }, 409) }
    const pending = send()
    assert.equal(useAppStore.getState().drafts[session.id], '')
    useAppStore.getState().setSessionDraft(session.id, 'New unsent follow-up', 0)
    finish.resolve()
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().drafts[session.id], 'Original paused-goal question\n\nNew unsent follow-up')
    assert.equal(useAppStore.getState().sessions[0].codex_goal, goal)
    assert.match(useAppStore.getState().error ?? '', /Synthetic send rejection/u)
  })
  await test('sends and explicit queue saves recompute client capabilities after an awaited Team validation', async () => {
    const all = { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 16 }
    const alias: TeamReference = { kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team', target_id: 'all_servers',
      display_name_snapshot: 'all', source_text_start: 0, source_text_end: 5, grant_intent: true }
    const hub = { hub_id: 'hub', capabilities: { team_messages_v1: { available: true, version: 1 }, team_all_servers_alias_v1: all } }
    for (const action of ['send', 'save', 'changed-save']) {
      reset('@@all Context')
      const aliasHealth: Health = { ...useAppStore.getState().health!, capabilities: { ...health.capabilities,
        agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
        team_hub_v1: { available: true, version: 1, designated_host: false, base_path: null,
          server_session_base_path: '/api/team-hub-server', hub_id: 'hub', host_server_identity: 'host' }, team_all_servers_alias_v1: all } }
      const queued = { ...followup, prompt: '@@all Context', team_references: [alias] }
      installQueue([prior, queued])
      useAppStore.setState({ health: aliasHealth, teamReferencesBySession: { [session.id]: [alias] } })
      const checked = deferred<void>(); const finish = deferred<void>()
      respond = async request => {
        if (request.path.endsWith('/v1/health')) { checked.resolve(); await finish.promise; return json(hub) }
        if (request.method === 'GET') return json({ session, events: [], queued_turns: queue })
        assert.equal(request.method, action === 'send' ? 'POST' : 'PATCH')
        assert.deepEqual(request.body.client_capabilities ?? [], [], 'revoked Codex controls must not be re-advertised after waiting')
        if (action !== 'send') assert.deepEqual(Object.keys(request.body), ['client_capabilities'], 'unchanged references and grants must remain omitted')
        return json({ session })
      }
      const pending = action !== 'send'
        ? useAppStore.getState().updateQueued(session.id, followup.queued_id, queued.prompt, undefined, 0)
        : send()
      await checked.promise
      if (action === 'changed-save') installQueue([prior, { ...queued, file_ids: ['different-attachment'] }])
      useAppStore.setState({ health: { ...aliasHealth, capabilities: { ...aliasHealth.capabilities, codex_controls: {
        available: false, version: 2, interactive_client_capability: 'codex_interactive_v1',
      } } } })
      finish.resolve()
      assert.equal(await pending, action !== 'changed-save')
      assert.equal(requests.filter(request => request.method !== 'GET').length, action === 'changed-save' ? 0 : 1)
    }
  })
  for (const sameIdentity of [true, false]) await test(`a successful old-instance POST ${sameIdentity ? 'reconciles its selected server' : 'does not touch a different server identity'} without replay`, async () => {
    reset()
    const admittedFile = { id: 'sent-file', filename: 'sent.txt' }
    const nextFile = { id: 'next-file', filename: 'next.txt' }
    const newlyPickedSameId = { ...admittedFile }
    useAppStore.setState({ uploads: { [session.id]: [admittedFile] } })
    const goal = useAppStore.getState().sessions[0].codex_goal
    const finish = deferred<void>()
    respond = async () => { await finish.promise; return json({ session, event: event('turn_started', { run_id: 'old-instance-run', prompt: followup.prompt }) }) }
    const pending = send(true)
    useAppStore.getState().setSessionDraft(session.id, 'Preserve my next draft', 0)
    useAppStore.setState({ uploads: { [session.id]: [admittedFile, nextFile, newlyPickedSameId] } })
    useAppStore.setState({ health: { ...health, server_instance_id: 'replacement', server_identity: sameIdentity ? health.server_identity : 'different-server' } })
    finish.resolve()
    assert.equal(await pending, false)
    assert.equal(requests.length, 1, 'a successful response must never cause a duplicate POST')
    assert.equal(useAppStore.getState().drafts[session.id], 'Preserve my next draft')
    assert.equal(useAppStore.getState().sessions[0].codex_goal, goal)
    assert.equal(useAppStore.getState().health?.active_runs?.[0].run_id, 'goal-owner')
    assert.deepEqual(useAppStore.getState().uploads[session.id], sameIdentity ? [nextFile, newlyPickedSameId] : [admittedFile, nextFile, newlyPickedSameId])
    assert.deepEqual(useAppStore.getState().snapshots[session.id].events, [], 'old-instance events must never enter the replacement snapshot')
    assert.equal(syncs, sameIdentity ? 1 : 0)
    if (sameIdentity) assert.match(useAppStore.getState().error ?? '', /accepted.*connection changed.*before sending it again/u)
    else assert.equal(useAppStore.getState().error, null)
  })
} finally {
  await flush()
  globalThis.fetch = originalFetch
  useAppStore.setState({ syncSelectedSession: originalSync })
}
