import assert from 'node:assert/strict'
import type { Event } from '../types'
import { crossChatSemanticKey, isAsyncCrossChatMessage, projectTimeline, rowText } from './timeline'
import { sanitizeTimelineEvent, historicalTimelineEvents } from './timeline-memory'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { timelineTargetIsRepresented, timelineTargetRowIndex } from './timeline-history-navigation'

const message = (seq: number, status: string, patch: Partial<Event> = {}): Event => ({
  id: `message-event-${seq}`, session_id: 'recipient', seq, ts: `2026-09-10T10:00:${String(seq).padStart(2, '0')}Z`,
  type: `chat_conversation_message_${status}`, conversation_mode: 'async_route_v1',
  conversation_id: 'pair-a', message_id: 'message-a', handoff_id: 'message-a', cross_chat_envelope_id: 'message-a',
  source_session_id: 'sender', target_session_id: 'recipient', source_title: 'Research agent', target_title: 'Mobile agent',
  handoff_status: status, handoff_action: 'instruction', handoff_preview: 'Review the keyboard behavior.',
  ...patch,
})
const pending = [message(1, 'received'), message(2, 'queued', { queued_id: 'queued-a' })]
assert.deepEqual(projectTimeline(pending, []), [])
assert.deepEqual(projectTimeline([...pending, message(3, 'cancelled')], []), [], 'cancelled pending messages must remain exclusively in queue history')
assert.deepEqual(projectTimeline([...pending, message(3, 'failed')], []), [], 'unstarted incoming failures must not duplicate pending content')

const active = [
  ...pending,
  message(3, 'started', { queued_id: 'queued-a', handoff_status: 'running' }),
  message(4, 'started', { type: 'turn_started', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', prompt: '[Internal delivery wrapper]', queued_id: 'queued-a' }),
  message(5, 'delivered', { type: 'turn_finished', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', result_text: 'The review is complete.' }),
  message(6, 'delivered'),
]
const rows = projectTimeline(active, [])
assert.equal(rows.length, 2)
assert.equal(rows[0].kind, 'system')
if (rows[0].kind !== 'system') throw new Error('Missing async message')
assert.equal(rows[0].key, 'cross-chat:handoff:message-a')
assert.equal(rows[0].crossChatMessage, true)
assert.equal(rows[0].seq, 3)
assert.equal(rows[0].anchorTs, active[2].ts)
assert.equal(rows[0].event.handoff_status, 'delivered')
assert.deepEqual(rows[0].representedEventIds, ['message-event-1', 'message-event-2', 'message-event-3', 'message-event-6'])
assert.equal(rowText(rows[1]), 'The review is complete.')
assert.equal(rows.some(row => row.kind === 'message' && row.role === 'user'), false)
assert.equal(timelineTargetIsRepresented(rows, { eventId: 'message-event-2', seq: 2 }), true)
assert.equal(timelineTargetRowIndex(rows, { eventId: 'message-event-6', seq: 6 }), 0)
assert.equal(reuseStableTimelineRows(rows, projectTimeline(active, [])), rows, 'unchanged lifecycle projections preserve recycled rows')

const independent = projectTimeline([
  message(1, 'registered', { session_id: 'sender' }),
  message(2, 'started', { session_id: 'sender', source_session_id: 'recipient', target_session_id: 'sender', message_id: 'message-b', handoff_id: 'message-b', cross_chat_envelope_id: 'message-b' }),
  message(3, 'delivered', { session_id: 'sender' }),
], [])
assert.deepEqual(independent.map(row => row.key), ['cross-chat:handoff:message-a', 'cross-chat:handoff:message-b'])
assert.deepEqual(independent.map(row => row.seq), [1, 2], 'replies sharing a conversation remain separately anchored messages')

for (const field of ['cross_chat_envelope_id', 'handoff_id', 'message_id'] as const) {
  const value = message(1, 'registered', { cross_chat_envelope_id: undefined, handoff_id: undefined, message_id: undefined, [field]: 'only-id' })
  assert.equal(crossChatSemanticKey(value), 'cross-chat:handoff:only-id')
}
for (const event of [
  message(1, 'received', { type: 'cross_chat_handoff_received', conversation_mode: undefined }),
  message(1, 'received', { conversation_mode: undefined }),
  message(1, 'future'),
]) {
  assert.equal(isAsyncCrossChatMessage(event), false)
  const projected = projectTimeline([event], [])
  assert.equal(projected.length, 1)
  assert.equal(projected[0].kind === 'system' && projected[0].crossChatMessage, undefined)
}

const busyEvents: Event[] = []
for (const next of [
  message(1, 'started', { type: 'turn_started', run_id: 'busy-run', prompt: 'Finish existing work' }),
  message(2, 'received'), message(3, 'queued'),
  message(4, 'delivered', { type: 'assistant_text', run_id: 'busy-run', text: 'Existing result' }),
  message(5, 'delivered', { type: 'turn_finished', run_id: 'busy-run', result_text: 'Existing result' }),
  message(6, 'started'),
  message(7, 'started', { type: 'turn_started', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', prompt: '[Internal delivery wrapper]' }),
  message(8, 'delivered', { type: 'turn_finished', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', result_text: 'Message handled' }),
  message(9, 'delivered'),
]) {
  busyEvents.push(next)
  const hydrated = JSON.parse(JSON.stringify(busyEvents.map(sanitizeTimelineEvent))) as Event[]
  assert.deepEqual(projectTimeline(busyEvents.map(sanitizeTimelineEvent), []), projectTimeline(historicalTimelineEvents(hydrated.map(sanitizeTimelineEvent)), []), 'live events and hydrated history must agree at every delivery transition')
}
const busyRows = projectTimeline(busyEvents, [])
assert.equal(busyRows.findIndex(row => row.kind === 'system' && row.crossChatMessage), 2)
assert.equal(busyRows[2].seq, 6)
assert.deepEqual(busyRows.filter(row => row.kind === 'message').map(rowText), ['Finish existing work', 'Existing result', 'Message handled'])

const prepended = projectTimeline([message(0, 'received'), ...active], [])
assert.equal(prepended[0].key, rows[0].key)
assert.equal(prepended[0].seq, rows[0].seq, 'older pending packets must not move an admitted message')
const sparse = projectTimeline([message(10, 'delivered')], [])
assert.equal(sparse[0].seq, 10, 'compact history may use delivered as its earliest retained admission')
const cancelledAfterStart = projectTimeline([message(1, 'started'), message(2, 'cancelled')], [])
assert.equal(cancelledAfterStart.length, 1)
assert.equal(cancelledAfterStart[0].seq, 1)
assert.equal(cancelledAfterStart[0].kind === 'system' && cancelledAfterStart[0].event.handoff_status, 'cancelled')

const replacement = active.map(value => value.seq === 1 ? { ...value, handoff_preview: 'Updated retained preview' } : value)
assert.notEqual(reuseStableTimelineRows(rows, projectTimeline(replacement, []))[0], rows[0], 'an earlier lifecycle replacement must refresh the current card')

// Mixed compatibility histories may append a legacy queue receipt after the
// exact async lifecycle. That receipt must neither duplicate a pending message
// nor downgrade an admitted message to the legacy queued card.
const legacyQueued = (seq: number, patch: Partial<Event> = {}) => message(seq, 'queued', {
  type: 'cross_chat_handoff_queued', conversation_mode: undefined,
  handoff_preview: 'Stale compatibility preview', ...patch,
})
assert.deepEqual(projectTimeline([...pending, legacyQueued(3)], []), [], 'late legacy receipts cannot expose incoming messages that are still pending')
for (const session_id of ['recipient', 'sender']) {
  const lifecycle = [
    message(1, 'received', { session_id }), message(2, 'queued', { session_id }),
    message(3, 'started', { session_id, handoff_status: 'running' }), message(4, 'delivered', { session_id }),
  ]
  const mixedRows = projectTimeline([...lifecycle, legacyQueued(5, { session_id })], [])
  assert.equal(mixedRows.length, 1)
  assert.equal(mixedRows[0].kind, 'system')
  if (mixedRows[0].kind !== 'system') throw new Error('Missing mixed async message')
  assert.equal(mixedRows[0].crossChatMessage, true, 'any exact async lifecycle keeps the grouped message on the async renderer')
  assert.equal(mixedRows[0].event, lifecycle[3], 'only the latest exact async event owns display status and body provenance')
  assert.deepEqual(mixedRows[0].events, lifecycle, 'legacy compatibility packets cannot enter the async body lifecycle')
  assert.equal(mixedRows[0].seq, session_id === 'recipient' ? 3 : 1)
  assert.equal(timelineTargetIsRepresented(mixedRows, { eventId: 'message-event-5', seq: 5 }), true)
  const previous = projectTimeline(lifecycle.slice(0, 3), [])
  assert.notEqual(reuseStableTimelineRows(previous, mixedRows)[0], previous[0], 'recycled started cards must receive the delivered event')
  const hydrated = historicalTimelineEvents([...lifecycle, legacyQueued(5, { session_id })].map(sanitizeTimelineEvent))
  assert.deepEqual(projectTimeline(hydrated, []), projectTimeline([...lifecycle, legacyQueued(5, { session_id })].map(sanitizeTimelineEvent), []))
}
for (const invalid of [
  message(1, 'delivered', { conversation_mode: undefined }),
  message(1, 'delivered', { conversation_mode: 'async_route_v1 ' as Event['conversation_mode'] }),
  message(1, 'delivered', { type: 'chat_conversation_message_delivered_extra' }),
  message(1, 'delivered', { type: 'cross_chat_handoff_delivered' }),
]) {
  const invalidRows = projectTimeline([invalid, legacyQueued(2)], [])
  assert.equal(invalidRows.some(value => value.kind === 'system' && value.crossChatMessage), false, 'inexact protocol markers cannot recover async identity from a legacy receipt')
}
const separateIdentityRows = projectTimeline([
  message(1, 'started'), message(2, 'delivered'),
  legacyQueued(3, { handoff_id: 'different-message', correlation_id: 'message-a', handoff_preview: message(2, 'delivered').handoff_preview }),
], [])
assert.equal(separateIdentityRows.length, 2, 'matching conversation, alternate IDs, and prompt text cannot merge different exact message identities')
assert.equal(separateIdentityRows[0].kind === 'system' && separateIdentityRows[0].crossChatMessage, true)
assert.equal(separateIdentityRows[1].kind === 'system' && separateIdentityRows[1].crossChatMessage, undefined)
console.log('async cross-chat timeline regressions passed')
