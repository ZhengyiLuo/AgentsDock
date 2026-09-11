import type { Event, QueuedTurn } from '../types'
import {
  isCrossChatDeliveryQueuedTurn,
  isDeliveryBarrierQueuedTurn,
  isUserQueuedTurn,
  isVisibleQueuedTurn,
  isNativeGoalSteerEvent,
  queueSnapshotRequiresRefresh,
  queuedMoveCrossesDeliveryBarrier,
  queuedTurnHasEarlierDeliveryBarrier,
  resolveNewQueuedTurn,
  updateQueuedTurns,
} from './queue'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function event(type: string, patch: Partial<Event> = {}): Event {
  return { id: `event-${type}`, session_id: 'chat-1', seq: 1, type, ts: '2026-07-19T00:00:00Z', ...patch }
}

let queue: QueuedTurn[] = []
queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'first', prompt: 'First', position: 2 }))
queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'second', prompt: 'Second', position: 1 }))
assert(queue.map(turn => turn.queued_id).join(',') === 'second,first', 'new queued turns must follow server position')

const reference = {
  session_id: 'target',
  display_title_snapshot: 'Target',
  source_text_start: 7,
  source_text_end: 14,
  action: 'request_reply' as const,
}
queue = updateQueuedTurns(queue, event('turn_queue_updated', { queued_id: 'first', prompt: 'Edited @Target', chat_references: [reference], position: 0 }))
assert(queue[0]?.queued_id === 'first' && queue[0]?.prompt === 'Edited @Target', 'queue edits must update and reorder the visible row')
assert(queue[0]?.chat_references?.[0]?.action === 'request_reply', 'queue edits must preserve structured cross-chat authority')
queue = updateQueuedTurns(queue, event('turn_queue_reordered', { positions: [{ queued_id: 'first', position: 3 }, { queued_id: 'second', position: 1 }] }))
assert(queue.map(turn => turn.queued_id).join(',') === 'second,first', 'position packets must reorder regardless of event type')
queue = updateQueuedTurns(queue, event('turn_started', { queued_id: 'second' }))
assert(queue.map(turn => turn.queued_id).join(',') === 'first', 'a promoted turn must leave the queue immediately')
queue = updateQueuedTurns(queue, event('turn_queue_run_now', { queued_id: 'first' }))
assert(queue.length === 0, 'a run-now acknowledgement must remove the promoted turn before turn_started arrives')

queue = updateQueuedTurns(queue, event('turn_queue_delivery_fenced', {
  queued_id: 'first',
  prompt: 'Visible retry',
  request_prompt: 'Provider retry payload',
  display_file_ids: ['visible-file'],
  backend: 'codex',
  model: 'gpt-5.4',
  effort: 'high',
}))
assert(queue[0]?.queued_id === 'first', 'a durable native-delivery fence must restore the visible queued row')
assert(queue[0]?.prompt === 'Visible retry', 'a durable native-delivery fence must preserve the user-facing prompt')
assert(queue[0]?.file_ids[0] === 'visible-file', 'a durable native-delivery fence must preserve visible attachments')
assert(queue[0]?.model === 'gpt-5.4' && queue[0]?.effort === 'high', 'a durable native-delivery fence must preserve runtime choices')

const digest = updateQueuedTurns([], event('turn_queued', { queued_id: 'digest', purpose: 'handoff_digest', prompt: 'Digest' }))[0]
assert(!isUserQueuedTurn(digest), 'handoff digest work must stay out of the user queue shelf')
const crossChat = updateQueuedTurns([], event('turn_queued', { queued_id: 'handoff', purpose: 'cross_chat_handoff_delivery', prompt: 'Synthetic relay' }))[0]
assert(!isUserQueuedTurn(crossChat), 'cross-chat delivery plumbing must stay out of the user queue shelf')
assert(isCrossChatDeliveryQueuedTurn(crossChat), 'local cross-chat delivery must be identified as an immutable FIFO barrier')
assert(isDeliveryBarrierQueuedTurn(crossChat), 'local cross-chat deliveries must participate in FIFO barrier ordering')
assert(!isVisibleQueuedTurn(crossChat), 'local cross-chat delivery plumbing must not duplicate its chronological timeline card in the composer shelf')
const securePeer = updateQueuedTurns([], event('turn_queued', { queued_id: 'secure-peer', purpose: 'secure_peer_handoff_delivery', prompt: 'Private relay' }))[0]
assert(!isUserQueuedTurn(securePeer), 'secure-peer delivery plumbing must never become user-editable')
assert(!isVisibleQueuedTurn(securePeer), 'secure-peer delivery plumbing must stay hidden from the local queue shelf')
assert(isDeliveryBarrierQueuedTurn(securePeer), 'hidden secure-peer deliveries must still participate in FIFO barrier ordering')

const barrierQueue: QueuedTurn[] = [
  { queued_id: 'after-secure', session_id: 'chat-1', prompt: 'After secure', file_ids: [], position: 4 },
  { ...crossChat, position: 1 },
  { queued_id: 'before', session_id: 'chat-1', prompt: 'Before', file_ids: [], position: 0 },
  { ...securePeer, position: 3 },
  { queued_id: 'after-local', session_id: 'chat-1', prompt: 'After local', file_ids: [], position: 2 },
]
assert(queuedMoveCrossesDeliveryBarrier(barrierQueue, 'before', 'down'), 'a user turn must not move across a local delivery barrier')
assert(queuedMoveCrossesDeliveryBarrier(barrierQueue, 'after-local', 'up'), 'a user turn must not move backward across a local delivery barrier')
assert(queuedMoveCrossesDeliveryBarrier(barrierQueue, 'after-local', 'down'), 'a user turn must not move across a hidden secure-peer barrier')
assert(queuedMoveCrossesDeliveryBarrier(barrierQueue, 'after-secure', 'up'), 'a user turn must not move backward across a hidden secure-peer barrier')
assert(!queuedMoveCrossesDeliveryBarrier(barrierQueue, 'before', 'up'), 'moving at an outer queue edge is not a barrier crossing')
assert(!queuedTurnHasEarlierDeliveryBarrier(barrierQueue, 'before'), 'run now should remain available before all delivery barriers')
assert(queuedTurnHasEarlierDeliveryBarrier(barrierQueue, 'after-local'), 'run now must remain FIFO behind a local cross-chat delivery')
assert(queuedTurnHasEarlierDeliveryBarrier(barrierQueue, 'after-secure'), 'run now must remain FIFO behind a hidden secure-peer delivery')

const existing: QueuedTurn = { queued_id: 'existing', session_id: 'chat-1', prompt: 'Earlier', file_ids: [] }
const created: QueuedTurn = { queued_id: 'created', session_id: 'chat-1', prompt: 'Send this now', file_ids: [] }
assert(resolveNewQueuedTurn(' Send this now ', new Set(['existing']), [existing, created]) === 'created', 'older server responses must resolve the exact newly queued message')

const waiting: QueuedTurn[] = [
  { queued_id: 'first', session_id: 'chat-1', prompt: 'Same text', file_ids: [], position: 1 },
  { queued_id: 'second', session_id: 'chat-1', prompt: 'Same text', file_ids: [], position: 2 },
  { ...crossChat, position: 3 },
]
const nativeGoalSteer = event('turn_steered', {
  queued_id: 'first', run_id: 'active-goal-run', native_goal_steer: true,
  native_steer: true, backend: 'codex', purpose: 'codex_goal_resume', provider_user_authored: true,
})
assert(isNativeGoalSteerEvent(nativeGoalSteer), 'the complete native goal acknowledgement must be recognized')
assert(updateQueuedTurns(waiting, nativeGoalSteer).map(turn => turn.queued_id).join(',') === 'second,handoff', 'goal steering must drain only its exact queued owner, even when another prompt has the same text')
for (const patch of [
  { type: 'turn_steer_requested' }, { native_goal_steer: false }, { native_steer: false },
  { backend: 'claude' as const }, { purpose: 'ordinary' }, { provider_user_authored: false },
  { run_id: '' }, { run_id: '   ' },
]) {
  assert(!isNativeGoalSteerEvent({ ...nativeGoalSteer, ...patch }), 'a partial or unrelated steering event must not count as delivered')
  assert(updateQueuedTurns(waiting, { ...nativeGoalSteer, ...patch }) === waiting, 'partial native steering metadata must not drain the queue')
}
assert(updateQueuedTurns(waiting, { ...nativeGoalSteer, queued_id: null }) === waiting, 'goal steering without a queued identity must not infer one from text')
assert(updateQueuedTurns(waiting, { ...nativeGoalSteer, queued_id: 'unknown' }) === waiting, 'unknown native steering identity must preserve the existing queue reference')

const drained = updateQueuedTurns(waiting, event('turn_queue_run_now', { queued_id: 'second', superseded_queued_ids: ['first'] }))
assert(drained.length === 1 && drained[0] === waiting[2], 'run now must remove the exact selected and superseded IDs while retaining unrelated incoming deliveries')
assert(updateQueuedTurns(waiting, event('turn_queue_run_now', { queued_id: 'unknown', superseded_queued_ids: ['first', 'first', 'missing'] })).map(turn => turn.queued_id).join(',') === 'second,handoff', 'supersession remains effective if the selected row already left the local queue')
assert(updateQueuedTurns(waiting, event('unrelated_event', { superseded_queued_ids: ['first', 'second'] })) === waiting, 'unrelated events cannot use retained supersession metadata to remove queued messages')
assert(updateQueuedTurns(waiting, event('turn_queue_run_now', { superseded_queued_ids: ['first'] })) === waiting, 'run-now metadata without its exact selected identity must not drain rows')

const positions = waiting.map(turn => ({ queued_id: turn.queued_id, position: turn.position! }))
assert(!queueSnapshotRequiresRefresh(event('queue_snapshot', { positions }), waiting), 'complete known membership needs only the existing order reducer')
assert(queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: [] }), waiting), 'an empty snapshot must request an authoritative read when local rows remain')
assert(!queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: [] }), []), 'empty local and snapshot queues must not cause redundant reads')
assert(queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: positions.slice(1) }), waiting), 'missing cached IDs must request a full queue read without assuming a broad clear')
assert(queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: [{ queued_id: 'unknown', position: 1 }] }), waiting), 'unknown queued IDs require details from the public queue endpoint')
assert(queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: [positions[0], positions[0], positions[2]] }), waiting), 'duplicate snapshot identities cannot stand in for complete membership')
assert(queueSnapshotRequiresRefresh(event('queue_snapshot', { positions: [{ queued_id: 'first', position: NaN }] }), waiting), 'malformed ordering must be repaired from the public endpoint')
assert(!queueSnapshotRequiresRefresh(event('turn_queue_reordered', { positions: [] }), waiting), 'partial reorder events do not acquire snapshot semantics')
assert(!queueSnapshotRequiresRefresh(event('queue_snapshot'), waiting), 'missing snapshot positions must not invent authoritative membership')
assert(updateQueuedTurns(waiting, event('queue_snapshot', { positions: [] })) === waiting, 'the reducer must not clear cached rows directly from a position-only snapshot')
assert(updateQueuedTurns(waiting, event('queue_snapshot', { positions: positions.slice(1) })).length === waiting.length, 'a partial position list must preserve unlisted IDs until authoritative refresh')

console.log('queue reconciliation regressions passed')
