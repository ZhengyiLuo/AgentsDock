import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerError } from '../api/AgentServerClient'
import type { Event, Health, QueuedTurn, Session, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

const session: Session = { id: 'queue-reconciliation', title: 'Queue reconciliation', backend: 'codex' }
const health: Health = { ok: true, server_identity: 'uninitialized', server_instance_id: 'queue-test', api_contract_version: 8 }
const first: QueuedTurn = { queued_id: 'first', session_id: session.id, prompt: 'Same message', file_ids: [] }
const second: QueuedTurn = { ...first, queued_id: 'second' }
const original = {
  page: client.sessionPage, queue: client.queue, stream: client.stream, update: client.updateQueued,
  run: client.runQueuedNow, fetch: globalThis.fetch,
  markRead: useAppStore.getState().markRead, refreshSessions: useAppStore.getState().refreshSessions,
  sync: useAppStore.getState().syncSelectedSession,
}
let emit!: (event: Event) => void
let seq = 100
let publicQueue: QueuedTurn[] = []
let queueCalls = 0
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function page(turns = publicQueue, latest = seq): TimelinePage {
  return { session, events: [], queued_turns: turns, has_more: false, before: null, total: 0, latest_seq: latest }
}
function event(type: string, patch: Partial<Event> = {}): Event {
  seq += 1
  return { id: `event-${seq}`, session_id: session.id, seq, type, ts: '2026-09-11T00:00:00Z', ...patch }
}
function queuedIds() { return useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id) }
async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve() }
function reset(turns: QueuedTurn[] = [first]) {
  client.markValidated()
  seq += 100
  publicQueue = turns
  queueCalls = 0
  client.queue = async () => { queueCalls += 1; return publicQueue }
  client.sessionPage = async () => page()
  client.updateQueued = async () => {}
  client.runQueuedNow = async () => ({ ok: true })
  useAppStore.setState({
    initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false, health,
    sessions: [session], selectedSessionId: session.id, error: null, syncError: null,
    queuedRunStatus: {}, pendingQueuedRunIds: new Set(), activeSessionIds: new Set(),
    snapshots: { [session.id]: { session, events: [], queuedTurns: turns, files: [], filesTotal: 0, hasMore: false, latestSeq: seq, cachedAt: Date.now() } },
    markRead: async () => {}, refreshSessions: async () => {}, syncSelectedSession: original.sync,
  })
}

try {
  globalThis.fetch = async () => { throw new Error('Queue tests must never contact a live server') }
  client.stream = (_id, _after, onEvent, onState) => { emit = onEvent; onState(true); return () => {} }
  reset()
  await original.sync('recovery')

  await test('a delayed timeline page cannot resurrect a message admitted by the live stream', async () => {
    reset()
    const pendingPage = deferred<TimelinePage>()
    const stale = page([first])
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    publicQueue = []
    emit(event('turn_started', { queued_id: first.queued_id }))
    assert.deepEqual(queuedIds(), [])
    pendingPage.resolve(stale)
    await pending
    await flush()
    assert.deepEqual(queuedIds(), [])
  })

  await test('a delayed empty page preserves a distinct newly queued message with identical text', async () => {
    reset([])
    const pendingPage = deferred<TimelinePage>()
    const stale = page([])
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    publicQueue = [second]
    emit(event('turn_queued', { queued_id: second.queued_id, prompt: second.prompt }))
    pendingPage.resolve(stale)
    await pending
    await flush()
    assert.deepEqual(queuedIds(), ['second'])
  })

  await test('a no-op drain also invalidates an older timeline queue response', async () => {
    reset([])
    const pendingPage = deferred<TimelinePage>()
    const stale = page([first])
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    emit(event('turn_started', { queued_id: first.queued_id }))
    pendingPage.resolve(stale)
    await pending
    await flush()
    assert.deepEqual(queuedIds(), [])
  })

  await test('empty and partial snapshot membership triggers an authoritative queue refresh', async () => {
    reset([first, second])
    publicQueue = [second]
    emit(event('queue_snapshot', { positions: [{ queued_id: 'second', position: 0 }] }))
    await flush()
    assert.deepEqual(queuedIds(), ['second'])
    publicQueue = []
    emit(event('queue_snapshot', { positions: [] }))
    await flush()
    assert.deepEqual(queuedIds(), [])
    assert.equal(queueCalls, 2)
  })

  await test('matching snapshot membership requires no redundant queue read', async () => {
    reset([first, second])
    emit(event('queue_snapshot', { positions: [{ queued_id: 'second', position: 0 }, { queued_id: 'first', position: 1 }] }))
    await flush()
    assert.deepEqual(queuedIds(), ['second', 'first'])
    assert.equal(queueCalls, 0)
  })

  await test('malformed position hints cannot crash ingestion or prevent authoritative queue repair', async () => {
    reset()
    publicQueue = []
    emit(event('queue_snapshot', { positions: [null, { queued_id: 'first', position: -1 }] as unknown as Event['positions'] }))
    await flush()
    assert.deepEqual(queuedIds(), [])
    assert.equal(queueCalls, 1)
  })

  await test('native goal steering clears only the acknowledged message and its queued banner', async () => {
    reset([first, second])
    useAppStore.setState({ queuedRunStatus: { [session.id]: { queued_id: 'first', tone: 'info', message: 'Still queued' } } })
    emit(event('turn_steered', { queued_id: 'first', native_goal_steer: true, native_steer: true, backend: 'codex', purpose: 'codex_goal_resume', provider_user_authored: true, run_id: 'native-run' }))
    assert.deepEqual(queuedIds(), ['second'])
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
  })

  await test('queue edit refresh retries if a delivery arrives during its HTTP read', async () => {
    reset()
    useAppStore.setState({ syncSelectedSession: async () => {} })
    const pendingQueue = deferred<QueuedTurn[]>()
    client.queue = async () => { queueCalls += 1; return queueCalls === 1 ? pendingQueue.promise : publicQueue }
    const pending = useAppStore.getState().updateQueued(session.id, 'first', 'Edited', [], 0)
    await flush()
    publicQueue = []
    emit(event('turn_started', { queued_id: 'first' }))
    pendingQueue.resolve([first])
    assert.equal(await pending, true)
    assert.deepEqual(queuedIds(), [])
    assert.equal(queueCalls, 2)
  })

  await test('run-now refresh cannot turn a delivered message back into a queued failure', async () => {
    reset()
    useAppStore.setState({ syncSelectedSession: async () => {} })
    const pendingQueue = deferred<QueuedTurn[]>()
    client.queue = async () => { queueCalls += 1; return queueCalls === 1 ? pendingQueue.promise : publicQueue }
    const pending = useAppStore.getState().runQueuedNow(session.id, 'first', 0)
    await flush()
    publicQueue = []
    emit(event('turn_started', { queued_id: 'first' }))
    pendingQueue.resolve([first])
    assert.equal(await pending, true)
    assert.deepEqual(queuedIds(), [])
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
  })

  await test('an authoritative timeline watermark rejects older queued packets, not newer ones', async () => {
    reset([])
    const covered = seq + 10
    client.sessionPage = async () => page([], covered)
    await original.sync('recovery')
    emit(event('turn_queued', { queued_id: 'first', prompt: first.prompt }))
    assert.deepEqual(queuedIds(), [])
    await flush()
    assert.equal(queueCalls, 1, 'covered signals are confirmed because queue snapshots are not atomically versioned')
    assert.deepEqual(queuedIds(), [])
    seq = covered
    publicQueue = [second]
    emit(event('turn_queued', { queued_id: 'second', prompt: second.prompt }))
    assert.deepEqual(queuedIds(), ['second'])
  })

  await test('late deferred or unsuccessful run-now responses never label an absent message still queued', async () => {
    for (const response of [{ ok: true, deferred: true }, { ok: false }]) {
      reset()
      useAppStore.setState({ syncSelectedSession: async () => {} })
      const pendingResponse = deferred<typeof response>()
      client.runQueuedNow = () => pendingResponse.promise
      const pending = useAppStore.getState().runQueuedNow(session.id, 'first', 0)
      await flush()
      publicQueue = []
      emit(event('turn_started', { queued_id: 'first' }))
      pendingResponse.resolve(response)
      assert.equal(await pending, false, 'absence alone does not prove this button started the message')
      assert.deepEqual(queuedIds(), [])
      assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
    }
  })

  await test('uncertain delivery warnings clear on exact admission, not on unrelated messages or cancellation', async () => {
    reset([first, second])
    const status = { queued_id: 'first', tone: 'error' as const, delivery_uncertain: true, message: 'Delivery not confirmed' }
    useAppStore.setState({ queuedRunStatus: { [session.id]: status } })
    emit(event('turn_started', { queued_id: 'second' }))
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], status)
    emit(event('turn_unqueued', { queued_id: 'first' }))
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], status)
    emit(event('turn_started', { queued_id: 'first' }))
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
  })

  await test('a late uncertainty error cannot overwrite exact admission or reactivate completed work', async () => {
    for (const acknowledged of [true, false]) {
      reset()
      useAppStore.setState({ syncSelectedSession: async () => {} })
      const responseReady = deferred<void>()
      client.runQueuedNow = async () => {
        await responseReady.promise
        throw new ServerError(409, 'Delivery could not be confirmed', { delivery_uncertain: true })
      }
      const pending = useAppStore.getState().runQueuedNow(session.id, 'first', 0)
      await flush()
      publicQueue = []
      if (acknowledged) {
        emit(event('turn_started', { queued_id: 'first' }))
        emit(event('turn_finished'))
      } else emit(event('turn_unqueued', { queued_id: 'first' }))
      responseReady.resolve()
      assert.equal(await pending, acknowledged)
      assert.deepEqual(queuedIds(), [])
      assert.equal(useAppStore.getState().activeSessionIds.has(session.id), false)
      assert.equal(Boolean(useAppStore.getState().queuedRunStatus[session.id]?.delivery_uncertain), !acknowledged)
    }
  })

  await test('an overtaken sparse queue read retries even when the drain was a local no-op', async () => {
    reset([])
    const pendingQueue = deferred<QueuedTurn[]>()
    client.queue = async () => { queueCalls += 1; return queueCalls === 1 ? pendingQueue.promise : publicQueue }
    emit(event('queue_snapshot', { positions: [{ queued_id: 'first', position: 0 }] }))
    emit(event('turn_started', { queued_id: 'first' }))
    pendingQueue.resolve([first])
    await flush()
    assert.deepEqual(queuedIds(), [])
    assert.equal(queueCalls, 2)
  })

  await test('workspace adoption blocks queue mutations before they are sent', async () => {
    reset()
    let mutations = 0
    client.updateQueued = async () => { mutations += 1 }
    useAppStore.setState({ workspaceAdopting: true })
    assert.equal(await useAppStore.getState().updateQueued(session.id, 'first', 'Edited', [], 0), false)
    assert.equal(mutations, 0)
    assert.equal(queueCalls, 0)
  })

  await test('server restart and revoked validation discard a pending queue read', async () => {
    for (const change of ['restart', 'validation'] as const) {
      reset()
      useAppStore.setState({ syncSelectedSession: async () => {} })
      const pendingQueue = deferred<QueuedTurn[]>()
      client.queue = () => pendingQueue.promise
      const pending = useAppStore.getState().updateQueued(session.id, 'first', 'Edited', [], 0)
      await flush()
      if (change === 'restart') useAppStore.setState({ health: { ...health, server_instance_id: 'restarted' } })
      else client.revokeValidation()
      pendingQueue.resolve([])
      assert.equal(await pending, false)
      assert.deepEqual(queuedIds(), ['first'])
    }
  })
} finally {
  client.sessionPage = original.page
  client.queue = original.queue
  client.stream = original.stream
  client.updateQueued = original.update
  client.runQueuedNow = original.run
  globalThis.fetch = original.fetch
  useAppStore.setState({ connected: false, markRead: original.markRead, refreshSessions: original.refreshSessions, syncSelectedSession: original.sync })
}
