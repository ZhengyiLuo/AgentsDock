import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { QueueReconciliationState } from './queue-reconciliation'
import { updateQueuedTurns } from './queue'

function event(type: string, patch: Partial<Event> = {}): Event {
  return { id: `event-${type}`, session_id: 'target', seq: 1, type, ts: '2026-09-11T00:00:00Z', ...patch }
}

const nativeGoalSteer = event('turn_steered', {
  queued_id: 'sent', run_id: 'active-goal-run', native_goal_steer: true,
  native_steer: true, backend: 'codex', purpose: 'codex_goal_resume', provider_user_authored: true,
})

await test('a full HTTP snapshot covers late queue packets but not fresh packets or timeline content', () => {
  const state = new QueueReconciliationState()
  assert.equal(state.revision, 0)
  assert.equal(state.coveredSeq, null)
  state.commitSnapshot(30)
  const revision = state.revision
  assert.equal(state.observe(event('turn_queued', { queued_id: 'already-sent', seq: 11 })), false)
  assert.equal(state.observe(event('turn_queued', { queued_id: 'already-sent', seq: 30 })), false)
  assert.equal(state.revision, revision)
  assert.equal(state.observe(event('assistant_message', { seq: 11 })), true)
  assert.equal(state.observe(event('turn_started', { seq: 11 })), true)
  assert.equal(state.revision, revision, 'non-queue content must not invalidate queue reads')
  assert.equal(state.observe(event('turn_queued', { queued_id: 'fresh', seq: 31 })), true)
  assert.equal(state.revision, revision + 1)
  assert.equal(state.coveredSeq, 30, 'a streamed event is not a full queue snapshot')
})

await test('no-op drains invalidate requests even when the local queue array is unchanged', () => {
  for (const packet of [
    event('turn_started', { queued_id: 'sent' }),
    event('turn_unqueued', { queued_id: 'sent' }),
    event('turn_queue_run_now', { queued_id: 'sent', superseded_queued_ids: ['superseded'] }),
    nativeGoalSteer,
  ]) {
    const state = new QueueReconciliationState()
    const queue: ReturnType<typeof updateQueuedTurns> = []
    const requestRevision = state.revision
    assert.equal(updateQueuedTurns(queue, packet), queue)
    assert.equal(state.observe(packet), true)
    assert.notEqual(state.revision, requestRevision, `${packet.type} must invalidate the old queue response`)
  }
})

await test('only the complete native goal steering discriminator affects queue observations', () => {
  for (const patch of [
    { type: 'turn_steer_requested' }, { native_goal_steer: false }, { native_steer: false },
    { backend: 'claude' as const }, { purpose: 'ordinary' }, { provider_user_authored: false },
    { run_id: '' }, { run_id: '   ' }, { queued_id: null },
  ]) {
    const state = new QueueReconciliationState()
    state.commitSnapshot(30)
    const revision = state.revision
    assert.equal(state.observe({ ...nativeGoalSteer, ...patch }), true)
    assert.equal(state.revision, revision)
  }
  const state = new QueueReconciliationState()
  state.commitSnapshot(30)
  assert.equal(state.observe(nativeGoalSteer), false)
  assert.equal(state.observe({ ...nativeGoalSteer, seq: 31 }), true)
})

await test('target cross-chat lifecycle invalidates no-op reads only with the exact async discriminator', () => {
  const lifecycle = event('chat_conversation_message_delivered', {
    queued_id: 'delivery', target_session_id: 'target', source_session_id: 'source',
    conversation_mode: 'async_route_v1', conversation_id: 'conversation', message_id: 'message',
  })
  for (const packet of [lifecycle, { ...lifecycle, type: 'cross_chat_handoff_started' }, { ...lifecycle, type: 'cross_chat_exchange_leg_completed' }]) {
    const state = new QueueReconciliationState()
    assert.equal(state.observe(packet), true)
    assert.equal(state.revision, 1)
    state.commitSnapshot(30)
    assert.equal(state.observe(packet), false)
  }
  for (const patch of [
    { session_id: 'source' }, { target_session_id: undefined }, { queued_id: null },
    { conversation_mode: undefined }, { type: 'chat_conversation_message_future' },
    { type: 'cross_chat_exchange_completed' },
  ]) {
    const state = new QueueReconciliationState()
    state.commitSnapshot(30)
    const revision = state.revision
    assert.equal(state.observe({ ...lifecycle, ...patch }), true)
    assert.equal(state.revision, revision)
  }
})

await test('every queue reducer packet and empty position snapshot invalidates reads', () => {
  const packets = [
    ...['turn_queued', 'turn_queue_delivery_fenced', 'turn_unqueued', 'turn_started', 'turn_queue_run_now', 'turn_queue_updated', 'turn_queue_paused']
      .map(type => event(type, { queued_id: 'owner' })),
    event('turn_queue_paused', { queued_ids: ['owner'] }),
    event('queue_snapshot', { positions: [] }),
    event('queue_snapshot', { positions: [{ queued_id: 'owner', position: 0 }] }),
    event('turn_queue_reordered', { positions: [{ queued_id: 'owner', position: 0 }] }),
    event('future_position_packet', { positions: [{ queued_id: 'owner', position: 0 }] }),
  ]
  for (const packet of packets) {
    const state = new QueueReconciliationState()
    assert.equal(state.observe(packet), true)
    assert.equal(state.revision, 1, packet.type)
    state.commitSnapshot(30)
    assert.equal(state.observe(packet), false, packet.type)
  }
})

await test('unsequenced reads invalidate competing reads without claiming event coverage', () => {
  const state = new QueueReconciliationState()
  const requestRevision = state.revision
  state.commitSnapshot()
  assert.notEqual(state.revision, requestRevision)
  assert.equal(state.coveredSeq, null)
  state.commitSnapshot(null)
  assert.equal(state.coveredSeq, null)
  assert.equal(state.observe(event('turn_queued', { queued_id: 'owner' })), true)
  state.commitSnapshot(30)
  state.commitSnapshot()
  assert.equal(state.coveredSeq, 30)
  assert.equal(state.observe(event('turn_queued', { queued_id: 'owner', seq: 31 })), true)
})

await test('only explicit nonnegative safe snapshot sequences monotonically advance coverage', () => {
  const state = new QueueReconciliationState()
  for (const sequence of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const revision = state.revision
    state.commitSnapshot(sequence)
    assert.equal(state.revision, revision + 1)
    assert.equal(state.coveredSeq, null)
  }
  state.commitSnapshot(0)
  assert.equal(state.coveredSeq, 0)
  state.commitSnapshot(30)
  state.commitSnapshot(10)
  assert.equal(state.coveredSeq, 30)
  state.commitSnapshot(Number.MAX_SAFE_INTEGER)
  assert.equal(state.coveredSeq, Number.MAX_SAFE_INTEGER)
})

await test('events without a finite sequence cannot be claimed covered by a snapshot', () => {
  const state = new QueueReconciliationState()
  state.commitSnapshot(30)
  for (const seq of [NaN, Infinity, -Infinity]) {
    const revision = state.revision
    assert.equal(state.observe(event('turn_started', { queued_id: 'owner', seq })), true)
    assert.equal(state.revision, revision + 1)
  }
})
