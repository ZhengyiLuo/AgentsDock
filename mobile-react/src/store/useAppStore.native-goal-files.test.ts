import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, Health, QueuedTurn, Session, TimelinePage } from '../types'
import { projectTimeline } from '../lib/timeline'
import { client, useAppStore } from './useAppStore'

const session: Session = { id: 'native-file-chat', title: 'Synthetic native files', backend: 'codex' }
const queued: QueuedTurn = { queued_id: 'native-input', session_id: session.id, prompt: '', file_ids: ['visible-file'] }
const unrelated: QueuedTurn = { ...queued, queued_id: 'other-input', file_ids: ['other-file'] }
const health: Health = { ok: true, server_identity: 'uninitialized', server_instance_id: 'native-files', api_contract_version: 8,
  active: [session.id], active_runs: [{ session_id: session.id, run_id: 'same-goal-owner' }] }
const original = { stream: client.stream, page: client.sessionPage, queue: client.queue, remove: client.removeQueued,
  fetch: globalThis.fetch, sync: useAppStore.getState().syncSelectedSession, markRead: useAppStore.getState().markRead,
  refreshSessions: useAppStore.getState().refreshSessions }
let emit!: (event: Event) => void
let seq = 1_000
let boot = 0
let publicQueue: QueuedTurn[] = []
let remoteEvents: Event[] = []
let pageLatest = seq
function packet(type: string, patch: Partial<Event> = {}): Event {
  return { id: `native-file-event-${++seq}`, seq, session_id: session.id, run_id: 'same-goal-owner', backend: 'codex',
    type, ts: '2026-09-15T12:00:00Z', ...patch }
}
function acknowledgement(patch: Partial<Event> = {}): Event {
  return packet('turn_steered', { queued_id: queued.queued_id, prompt: '', file_ids: [], native_goal_steer: true,
    native_steer: true, purpose: 'codex_goal_resume', provider_user_authored: true, ...patch })
}
function page(): TimelinePage {
  return { session, events: remoteEvents, queued_turns: publicQueue, has_more: false, before: null, total: remoteEvents.length, latest_seq: pageLatest }
}
async function flush() { for (let count = 0; count < 40; count += 1) await Promise.resolve() }
async function reset(turns: QueuedTurn[] = []) {
  await flush()
  client.markValidated()
  seq += 100; pageLatest = seq; boot += 1
  publicQueue = turns; remoteEvents = []
  client.queue = async () => publicQueue
  client.sessionPage = async () => page()
  client.removeQueued = async () => { publicQueue = publicQueue.filter(turn => turn.queued_id !== queued.queued_id) }
  useAppStore.setState({ initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    health: { ...health, server_instance_id: `native-files-${boot}` }, runtime: null,
    sessions: [session], selectedSessionId: session.id, error: null, syncError: null,
    queuedRunStatus: {}, pendingQueuedRunIds: new Set(), activeSessionIds: new Set([session.id]),
    snapshots: { [session.id]: { session, events: [], queuedTurns: [], files: [], filesTotal: 0, hasMore: false,
      latestSeq: seq, cachedAt: Date.now() } },
    markRead: async () => {}, refreshSessions: async () => {}, syncSelectedSession: async () => {},
  })
  await original.sync('recovery')
  const snapshot = useAppStore.getState().snapshots[session.id]
  useAppStore.setState({ snapshots: { [session.id]: { ...snapshot, files: [
    { id: 'visible-file', filename: 'user-image.png', session_id: session.id },
    { id: 'other-file', filename: 'other.txt', session_id: session.id },
    { id: 'runtime-file', filename: 'runtime-only.txt', session_id: session.id },
  ] } } })
}
function seedLive(patch: Partial<Event> = {}) {
  const event = packet('turn_queued', { queued_id: queued.queued_id, prompt: '', file_ids: queued.file_ids, ...patch })
  emit(event)
  return event
}
function snapshot() { return useAppStore.getState().snapshots[session.id] }
function nativeFiles(id: string) { return snapshot().events.find(event => event.id === id)?.file_ids }
function users() { return projectTimeline(snapshot().events, snapshot().files).filter(row => row.kind === 'message' && row.role === 'user') }

try {
  globalThis.fetch = async () => { throw new Error('Native file tests must never contact a live server') }
  client.stream = (_id, _after, onEvent, onState) => { emit = onEvent; onState(true); return () => {} }
  await test('real live queue/run-now/native-ack ingress retains the exact attachment without storing queue packets', async () => {
    await reset([unrelated])
    seedLive()
    emit(packet('turn_queue_run_now', { queued_id: queued.queued_id, native_steer: true, native_goal_steer: true }))
    assert.deepEqual(snapshot().queuedTurns.map(turn => turn.queued_id), [unrelated.queued_id])
    const ack = acknowledgement()
    emit(ack)
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
    assert.equal(users().length, 1)
    assert.equal(users()[0].kind === 'message' && users()[0].files[0]?.id, 'visible-file')
    assert.equal(snapshot().events.some(event => ['turn_queued', 'turn_queue_run_now'].includes(event.type)), false)
    assert.equal(useAppStore.getState().health?.active_runs?.[0].run_id, 'same-goal-owner')
    assert.deepEqual(snapshot().queuedTurns.map(turn => turn.queued_id), [unrelated.queued_id])
  })
  await test('a current HTTP queue read may drain before the native acknowledgement and cover its sequence', async () => {
    await reset([queued])
    const ack = acknowledgement()
    publicQueue = []; pageLatest = ack.seq + 10
    await original.sync('recovery')
    assert.deepEqual(snapshot().queuedTurns, [])
    emit(ack)
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
    assert.equal(users().length, 1)
  })
  await test('an unsequenced queue-only GET drain retains a previously proven file owner', async () => {
    await reset([queued])
    publicQueue = []
    emit(packet('queue_snapshot', { positions: [] }))
    await flush()
    assert.deepEqual(snapshot().queuedTurns, [])
    const ack = acknowledgement()
    emit(ack)
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
  })
  await test('a fresh HTTP-only delta acknowledgement uses ownership proven before the request', async () => {
    await reset()
    seedLive()
    const after = snapshot().latestSeq
    const ack = acknowledgement()
    publicQueue = []; remoteEvents = [ack]; pageLatest = ack.seq
    useAppStore.setState({ liveConnected: false })
    client.sessionPage = async (_id, options) => {
      assert.equal(options?.after, after, 'only a forward delta is eligible for live attachment handoff')
      return page()
    }
    await original.sync('recovery')
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
    assert.equal(users().length, 1)
    assert.deepEqual(snapshot().queuedTurns, [])
    assert.equal(snapshot().events.some(event => event.type === 'turn_queued'), false)
  })
  await test('an HTTP-only acknowledgement retains proven files when native run-now drains during the request', async () => {
    await reset()
    seedLive()
    let resolvePage!: (value: TimelinePage) => void
    client.sessionPage = () => new Promise(resolve => { resolvePage = resolve })
    const pending = original.sync('recovery')
    emit(packet('turn_queue_run_now', { queued_id: queued.queued_id, native_steer: true, native_goal_steer: true }))
    const ack = acknowledgement()
    publicQueue = []; remoteEvents = [ack]; pageLatest = ack.seq
    resolvePage(page())
    await pending
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
    assert.equal(users().length, 1)
    assert.deepEqual(snapshot().queuedTurns, [])
  })
  await test('an HTTP acknowledgement cannot borrow a later queue edit, removal, or newly learned owner', async () => {
    for (const change of ['edit', 'remove', 'new-owner']) {
      await reset()
      if (change !== 'new-owner') seedLive()
      let resolvePage!: (value: TimelinePage) => void
      client.sessionPage = () => new Promise(resolve => { resolvePage = resolve })
      const pending = original.sync('recovery')
      if (change === 'edit') emit(packet('turn_queue_updated', { queued_id: queued.queued_id, file_ids: ['other-file'] }))
      else if (change === 'remove') emit(packet('turn_unqueued', { queued_id: queued.queued_id }))
      else seedLive()
      const ack = acknowledgement()
      publicQueue = []; remoteEvents = [ack]; pageLatest = ack.seq
      resolvePage(page())
      await pending
      assert.deepEqual(nativeFiles(ack.id), [], change)
      assert.equal(users().length, 0, change)
      await flush()
    }
  })
  await test('HTTP-only attachment handoff rejects a changed validation scope or a full historical tail', async () => {
    for (const change of ['validation', 'full-tail', 'imported', 'response-only-owner']) {
      await reset()
      if (change !== 'response-only-owner') seedLive()
      let resolvePage!: (value: TimelinePage) => void
      client.sessionPage = () => new Promise(resolve => { resolvePage = resolve })
      const pending = original.sync(change === 'full-tail' ? 'manual' : 'recovery')
      if (change === 'validation') { client.revokeValidation(); client.markValidated() }
      const ack = acknowledgement(change === 'imported' ? { imported: true } : {})
      publicQueue = change === 'response-only-owner' ? [queued] : []; remoteEvents = [ack]; pageLatest = ack.seq
      resolvePage(page())
      await pending
      assert.deepEqual(nativeFiles(ack.id) ?? [], [], change)
      assert.equal(users().length, 0, change)
      await flush()
    }
  })
  await test('same-ID stream and HTTP metadata-only acknowledgement replays retain proof without adding user rows', async () => {
    await reset()
    seedLive()
    const ack = acknowledgement()
    emit(ack); emit({ ...ack, file_ids: [] })
    remoteEvents = [{ ...ack, file_ids: [] }]; pageLatest = ack.seq
    await original.sync('recovery')
    assert.deepEqual(nativeFiles(ack.id), ['visible-file'])
    assert.equal(users().length, 1)
    remoteEvents = [{ ...ack, file_ids: [], display_file_ids: [] }]
    await original.sync('recovery')
    assert.deepEqual(nativeFiles(ack.id), [])
    assert.equal(users().length, 0, 'an explicit display-file clear overrides retained acknowledgement proof')
  })
  await test('visible queue file overrides including empty arrays never expose runtime or replayed attachments', async () => {
    for (const visible of [['visible-file'], []]) {
      await reset()
      seedLive({ file_ids: ['runtime-file'], display_file_ids: visible })
      const ack = acknowledgement({ file_ids: ['runtime-file'] })
      emit(ack)
      assert.deepEqual(nativeFiles(ack.id), visible)
      assert.equal(users().length, visible.length ? 1 : 0)
    }
  })
  await test('explicit native display-file clears override a known queued attachment', async () => {
    await reset()
    seedLive()
    const ack = acknowledgement({ display_file_ids: [], file_ids: ['runtime-file'] })
    emit(ack)
    assert.deepEqual(nativeFiles(ack.id), [])
    assert.equal(users().length, 0)
  })
  await test('queue file edits replace the association and explicit file removal cannot reveal the old selection', async () => {
    for (const files of [['other-file'], []]) {
      await reset()
      seedLive()
      emit(packet('turn_queue_updated', { queued_id: queued.queued_id, file_ids: files }))
      const ack = acknowledgement()
      emit(ack)
      assert.deepEqual(nativeFiles(ack.id), files)
    }
  })
  await test('explicit remote removal, ordinary consumption, and stale queue replays cannot revive native file ownership', async () => {
    for (const type of ['turn_unqueued', 'turn_started']) {
      await reset()
      const old = seedLive()
      emit(packet(type, { queued_id: queued.queued_id, prompt: 'Ordinary consumption', file_ids: [] }))
      emit(old)
      const ack = acknowledgement()
      emit(ack)
      assert.deepEqual(nativeFiles(ack.id), [])
    }
  })
  await test('accepted explicit Remove invalidates ownership even before its stream event arrives', async () => {
    await reset([queued])
    assert.equal(await useAppStore.getState().removeQueued(session.id, queued.queued_id, 0), true)
    const ack = acknowledgement()
    emit(ack)
    assert.deepEqual(nativeFiles(ack.id), [])
    assert.equal(users().length, 0)
  })
  await test('profile, generation, validation, and server changes cannot reuse cached queue file ownership', async () => {
    for (const change of ['profile', 'generation', 'validation', 'boot', 'identity']) {
      await reset()
      seedLive()
      if (change === 'validation') { client.revokeValidation(); client.markValidated() }
      else if (change === 'profile') useAppStore.setState({ activeProfileId: 'replacement-profile' })
      else if (change === 'generation') useAppStore.setState({ profileGeneration: 1 })
      else useAppStore.setState({ health: { ...health,
        server_instance_id: change === 'boot' ? 'replacement-boot' : useAppStore.getState().health?.server_instance_id,
        server_identity: change === 'identity' ? 'different-server' : health.server_identity } })
      const ack = acknowledgement()
      emit(ack)
      assert.deepEqual(nativeFiles(ack.id), [], change)
      assert.equal(users().length, 0)
    }
  })
  await test('historical and imported acknowledgements cannot inherit a current live queued attachment', async () => {
    await reset()
    seedLive()
    const historical = acknowledgement({ id: 'historical-ack', seq: seq - 10 })
    remoteEvents = [historical]; pageLatest = seq
    await original.sync('recovery')
    assert.deepEqual(nativeFiles(historical.id), [])
    const imported = acknowledgement({ imported: true, id: 'imported-ack' })
    emit(imported)
    assert.deepEqual(nativeFiles(imported.id), [])
    const actual = acknowledgement()
    emit(actual)
    assert.deepEqual(nativeFiles(actual.id), ['visible-file'], 'historical/imported packets must not consume the current association')
  })
  await test('a freshly read queue must not enrich an older replayed acknowledgement or a different queued ID', async () => {
    await reset([queued])
    const older = acknowledgement({ seq: pageLatest - 1 })
    emit(older)
    assert.deepEqual(nativeFiles(older.id), [])
    const different = acknowledgement({ queued_id: unrelated.queued_id })
    emit(different)
    assert.deepEqual(nativeFiles(different.id), [])
    const current = acknowledgement()
    emit(current)
    assert.deepEqual(nativeFiles(current.id), ['visible-file'])
  })
  await test('a newer authoritative HTTP file edit cannot be applied to an older acknowledgement', async () => {
    await reset([queued])
    const old = acknowledgement()
    publicQueue = [{ ...queued, file_ids: ['other-file'] }]
    pageLatest = old.seq + 10
    await original.sync('recovery')
    emit(old)
    assert.deepEqual(nativeFiles(old.id), [])
    seq = pageLatest
    const current = acknowledgement()
    emit(current)
    assert.deepEqual(nativeFiles(current.id), ['other-file'])
  })
  await test('a different chat or unvalidated stream callback cannot consume the current chat association', async () => {
    await reset()
    seedLive()
    const foreign = acknowledgement({ session_id: 'different-chat' })
    emit(foreign)
    assert.equal(snapshot().events.some(event => event.id === foreign.id), false)
    useAppStore.setState({ connected: false })
    const unvalidated = acknowledgement()
    emit(unvalidated)
    assert.deepEqual(nativeFiles(unvalidated.id), [])
    useAppStore.setState({ connected: true })
    const current = acknowledgement()
    emit(current)
    assert.deepEqual(nativeFiles(current.id), ['visible-file'])
  })
  await test('non-user delivery queue files never become a native user attachment', async () => {
    for (const purpose of ['scheduled_job', 'cross_chat_handoff_delivery', 'secure_peer_handoff_delivery', 'handoff_digest']) {
      await reset([{ ...queued, purpose }])
      seedLive({ purpose })
      const ack = acknowledgement()
      emit(ack)
      assert.deepEqual(nativeFiles(ack.id), [], purpose)
    }
  })
} finally {
  await flush()
  client.stream = original.stream; client.sessionPage = original.page; client.queue = original.queue; client.removeQueued = original.remove
  globalThis.fetch = original.fetch
  useAppStore.setState({ syncSelectedSession: original.sync, markRead: original.markRead, refreshSessions: original.refreshSessions })
}
