import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event, Health, PublicServerProfile, QueuedTurn, Session, TimelinePage } from '../types'
import { isImportedSourceProvenNativeReplay } from '../lib/provider-origin'
import { projectTimeline } from '../lib/timeline'
import { client, useAppStore } from './useAppStore'

const session: Session = { id: 'history-activity', title: 'Synthetic history', backend: 'codex',
  latest_event_seq: 10, latest_agent_event_seq: 10, last_read_agent_event_seq: 10 }
const profile: PublicServerProfile = { id: 'uninitialized', name: 'Synthetic profile', serverURL: 'https://example.invalid',
  serverIdentity: 'uninitialized', serverConfigured: true, credentialVersion: 1,
  createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z', hasAccessToken: false,
  connectionState: 'online', cachedUnreadCount: 0 }
const queued: QueuedTurn = { queued_id: 'waiting', session_id: session.id, prompt: 'Actual waiting message', file_ids: [] }
const original = { fetch: globalThis.fetch, page: client.sessionPage, stream: client.stream, health: client.health,
  sessions: client.sessions, queue: client.queue, runtime: client.runtimeCatalog, stop: client.stopTurn,
  markRead: useAppStore.getState().markRead, refresh: useAppStore.getState().refreshSessions,
  sync: useAppStore.getState().syncSelectedSession, refreshFiles: useAppStore.getState().refreshFiles }
let emit!: (event: Event) => void
let sequence = 1_000
let boot = 0
let currentHealth: Health
let remoteEvents: Event[] = []
let queueReads = 0
let readReceipts = 0
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let index = 0; index < 30; index += 1) await Promise.resolve() }
function packet(type: string, patch: Partial<Event> = {}): Event {
  const seq = ++sequence
  return { id: `history-event-${seq}`, session_id: session.id, seq, type, ts: '2026-09-14T12:00:00Z', ...patch }
}
function page(): TimelinePage {
  return { session, events: remoteEvents, queued_turns: [queued], has_more: false, before: null,
    total: remoteEvents.length, latest_seq: Math.max(sequence, ...remoteEvents.map(event => event.seq)) }
}
async function reset(active = false) {
  client.markValidated()
  sequence += 1_000
  boot += 1
  currentHealth = { ok: true, api_contract_version: 8, server_identity: 'uninitialized', server_instance_id: `boot-${boot}`,
    active: active ? [session.id] : [], active_runs: active ? [{ session_id: session.id, run_id: 'current-run' }] : [] }
  remoteEvents = []
  client.health = async () => currentHealth
  client.sessions = async () => [session]
  client.sessionPage = async () => page()
  client.queue = async () => { queueReads += 1; return [queued] }
  client.runtimeCatalog = async () => ({ backends: {} })
  useAppStore.setState({ initialized: true, activeProfileId: profile.id, profileGeneration: 0,
    profiles: [profile], connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    serverConfigured: true, health: currentHealth, sessions: [session], selectedSessionId: session.id,
    error: null, syncError: null, activeSessionIds: new Set(active ? [session.id] : []),
    queuedRunStatus: {}, pendingQueuedRunIds: new Set(), stoppingSessionIds: new Set(),
    snapshots: { [session.id]: { session, events: [], queuedTurns: [queued], files: [], filesTotal: 0,
      hasMore: false, latestSeq: sequence, cachedAt: Date.now() } },
    markRead: async () => { readReceipts += 1 }, refreshFiles: async () => {},
    refreshSessions: original.refresh, syncSelectedSession: original.sync,
  })
  await original.refresh()
  await original.sync('recovery')
  useAppStore.setState({ refreshSessions: async () => {} })
  queueReads = 0; readReceipts = 0
}

try {
  globalThis.fetch = async () => { throw new Error('Activity-history tests must not contact a live endpoint') }
  client.stream = (_id, _after, onEvent, onState) => { emit = onEvent; onState(true); return () => {} }
  await test('silent imported starts, answers and terminals preserve unread, queue and live ownership', async () => {
    for (const active of [false, true]) {
      await reset(active)
      const before = useAppStore.getState()
      const packets = [packet('history_imported', { imported: true, metadata_only: true, run_id: 'import_history', backend: 'codex' }),
        packet('turn_started', { imported: true, run_id: 'import_history', backend: 'codex', prompt: '' }),
        packet('assistant_text', { imported: true, run_id: 'import_history', backend: 'codex', text: 'A historical answer' }),
        packet('turn_finished', { imported: true, run_id: 'import_history', backend: 'codex', result_text: '' })]
      for (const event of packets) emit({ ...event, queued_id: 'waiting' })
      await flush()
      const after = useAppStore.getState()
      assert.equal(after.sessions, before.sessions)
      assert.deepEqual(after.activeSessionIds, before.activeSessionIds)
      assert.equal(after.snapshots[session.id].queuedTurns, before.snapshots[session.id].queuedTurns)
      assert.equal(after.profiles[0].cachedUnreadCount, 0)
      assert.equal(readReceipts, 0)
      assert.equal(queueReads, 0)
      assert.ok(after.snapshots[session.id].events.some(event => event.text === 'A historical answer'), 'history remains displayable without announcing new activity')
    }
  })
  await test('a live start after a health request wins over its delayed idle response', async () => {
    await reset()
    const healthRead = deferred<Health>()
    client.health = () => healthRead.promise
    const pending = original.refresh()
    emit(packet('turn_started', { run_id: 'new-run', prompt: 'Current work' }))
    healthRead.resolve(currentHealth)
    await pending
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
    assert.equal(useAppStore.getState().health?.active_runs?.find(row => row.session_id === session.id)?.run_id, 'new-run')
  })
  await test('a stale terminal and an error cannot clear a different health-owned live run', async () => {
    await reset(true)
    emit(packet('turn_finished', { run_id: 'old-run', result_text: '' }))
    emit(packet('error', { run_id: 'current-run', message: 'Nonterminal provider warning' }))
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
    emit(packet('turn_finished', { run_id: 'current-run', result_text: '' }))
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), false)
  })
  await test('a delayed Stop response cannot stop a newer run', async () => {
    await reset(true)
    const stop = deferred<Awaited<ReturnType<typeof client.stopTurn>>>()
    client.stopTurn = () => stop.promise
    const pending = useAppStore.getState().stopTurn(0, session.id)
    emit(packet('turn_started', { run_id: 'replacement-run', prompt: 'Replacement work' }))
    stop.resolve({ stopped: true })
    await pending
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
    assert.equal(useAppStore.getState().health?.active_runs?.find(row => row.session_id === session.id)?.run_id, 'replacement-run')
  })
  await test('authoritative native subagent state remains cached but is not a transcript row or unread event', async () => {
    await reset()
    const state = packet('subagent_state', { backend: 'codex', subagent_id: 'worker', subagent_title: 'Synthetic worker title',
      subagent_task: 'Check fixture behavior', subagent_status: 'running', run_id: 'parent-run' })
    const before = useAppStore.getState().sessions
    emit(state)
    const snapshot = useAppStore.getState().snapshots[session.id]
    assert.equal(snapshot.events.find(event => event.id === state.id)?.subagent_title, 'Synthetic worker title')
    assert.equal(useAppStore.getState().sessions, before)
    assert.deepEqual(projectTimeline(snapshot.events, []), [])
  })
  await test('live and HTTP ingress compare complete same-ID source proof before 48k clipping', async () => {
    await reset()
    const body = 'Synthetic source proof bytes. '.repeat(3_000)
    const stale = packet('turn_started', { backend: 'codex', imported: true, run_id: 'import_history', provider_user_authored: true, prompt: body })
    const proof: Event = { ...stale, prompt: '', metadata_only: true, provider_history_repair: 'source_proven_native_replay',
      provider_origin: { provider: 'codex', kind: 'user', event_id: 'source-item', session_id: 'thread', turn_id: 'provider-turn',
        native_event_id: 'native-input', timestamp: stale.ts, source_text_sha256: bytesToHex(sha256(utf8ToBytes(body))) } }
    emit(proof)
    const retained = useAppStore.getState().snapshots[session.id].events.find(event => event.id === proof.id)!
    emit(stale)
    assert.equal(useAppStore.getState().snapshots[session.id].events.find(event => event.id === proof.id), retained)
    remoteEvents = [stale]
    await original.sync('recovery')
    assert.equal(isImportedSourceProvenNativeReplay(useAppStore.getState().snapshots[session.id].events.find(event => event.id === proof.id)!), true)
    emit({ ...stale, prompt: `${body} A genuinely changed suffix.` })
    assert.equal(isImportedSourceProvenNativeReplay(useAppStore.getState().snapshots[session.id].events.find(event => event.id === proof.id)!), false)
  })
  await test('older paging uses the latest batch-local proof before sanitizing a repeated long record', async () => {
    await reset()
    const body = 'Synthetic repeated page source. '.repeat(3_000)
    const stale = packet('turn_started', { seq: 100, backend: 'codex', imported: true,
      run_id: 'import_history', provider_user_authored: true, prompt: body })
    const proof: Event = { ...stale, prompt: '', metadata_only: true, provider_history_repair: 'source_proven_native_replay',
      provider_origin: { provider: 'codex', kind: 'user', event_id: 'source-page-item', session_id: 'thread', turn_id: 'provider-turn',
        native_event_id: 'native-input', timestamp: stale.ts, source_text_sha256: bytesToHex(sha256(utf8ToBytes(body))) } }
    const tail = packet('turn_finished', { run_id: 'current-tail', result_text: 'Current visible answer.' })
    const snapshot = useAppStore.getState().snapshots[session.id]
    useAppStore.setState({ historyWindow: null, snapshots: { [session.id]: { ...snapshot, events: [tail],
      hasMore: true, semanticPaging: false, nextBefore: tail.seq } } })
    client.sessionPage = async () => ({ ...page(), events: [stale, proof, stale], has_more: false, total: 4 })
    await useAppStore.getState().loadOlder(session.id)
    const history = useAppStore.getState().historyWindow?.snapshot
    assert.ok(history, 'older history should publish a verified window')
    assert.equal(isImportedSourceProvenNativeReplay(history.events.find(event => event.id === proof.id)!), true)
  })
  await test('a newly observed server version revalidates only the opened chat once, then resumes deltas', async () => {
    await reset()
    const stale = packet('turn_finished', { run_id: 'import_old', imported: true, result_text: 'Old cached copy' })
    const snapshot = useAppStore.getState().snapshots[session.id]
    const unopened = { ...snapshot, session: { ...session, id: 'unopened-chat' }, events: [stale] }
    useAppStore.setState({ snapshots: { [session.id]: { ...snapshot, events: [stale] }, 'unopened-chat': unopened } })
    const requests: Parameters<typeof client.sessionPage>[1][] = []
    client.sessionPage = async (id, options) => {
      assert.equal(id, session.id, 'version changes must never fan out to unopened chats')
      requests.push(options)
      return page()
    }
    currentHealth = { ...currentHealth, server_version: 'synthetic-1' }
    useAppStore.setState({ health: currentHealth })
    await original.sync('recovery')
    assert.equal(requests.at(-1)?.tail, true, 'missing cache proof requires an authoritative tail')
    assert.deepEqual(useAppStore.getState().snapshots[session.id].events, [], 'revalidation replaces stale cached records')
    assert.equal(useAppStore.getState().snapshots[session.id].verifiedServerVersion, 'synthetic-1')
    assert.equal(useAppStore.getState().snapshots['unopened-chat'], unopened)
    await original.sync('recovery')
    assert.equal(requests.at(-1)?.tail, false, 'same observed version resumes incremental reads')
    assert.equal(typeof requests.at(-1)?.after, 'number')
    currentHealth = { ...currentHealth, server_version: 'synthetic-2' }
    useAppStore.setState({ health: currentHealth })
    await original.sync('recovery')
    assert.equal(requests.at(-1)?.tail, true, 'an observed upgrade revalidates the selected chat')
    assert.equal(useAppStore.getState().snapshots[session.id].verifiedServerVersion, 'synthetic-2')
    await original.sync('recovery')
    assert.equal(requests.at(-1)?.tail, false)
    assert.equal(useAppStore.getState().snapshots['unopened-chat'], unopened)
  })
  await test('a tail fetched across an observed server upgrade cannot verify or replace the cache', async () => {
    await reset()
    const before = useAppStore.getState().snapshots[session.id]
    const pendingPage = deferred<TimelinePage>()
    client.sessionPage = () => pendingPage.promise
    currentHealth = { ...currentHealth, server_version: 'synthetic-1' }
    useAppStore.setState({ health: currentHealth })
    const pending = original.sync('recovery')
    currentHealth = { ...currentHealth, server_version: 'synthetic-2' }
    useAppStore.setState({ health: currentHealth })
    pendingPage.resolve(page())
    await pending
    assert.equal(useAppStore.getState().snapshots[session.id], before)
    let retriedTail = false
    client.sessionPage = async (_id, options) => { retriedTail = options?.tail === true; return page() }
    await original.sync('recovery')
    assert.equal(retriedTail, true)
    assert.equal(useAppStore.getState().snapshots[session.id].verifiedServerVersion, 'synthetic-2')
  })
  await flush()
} finally {
  client.sessionPage = original.page; client.stream = original.stream; client.health = original.health
  client.sessions = original.sessions; client.queue = original.queue; client.runtimeCatalog = original.runtime; client.stopTurn = original.stop
  globalThis.fetch = original.fetch
  useAppStore.setState({ connected: false, markRead: original.markRead, refreshSessions: original.refresh,
    syncSelectedSession: original.sync, refreshFiles: original.refreshFiles })
}
