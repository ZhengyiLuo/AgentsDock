import type { Event, QueuedTurn } from '../types'
import {
  isCrossChatDeliveryQueuedTurn,
  isDeliveryBarrierQueuedTurn,
  isUserQueuedTurn,
  isVisibleQueuedTurn,
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

console.log('queue reconciliation regressions passed')
