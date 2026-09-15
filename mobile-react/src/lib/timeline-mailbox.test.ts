import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { isAsyncCrossChatMessage, projectTimeline, rowText, type SystemRow } from './timeline'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { historicalTimelineEvents, sanitizeTimelineEvent } from './timeline-memory'
import { timelineTargetRowIndex } from './timeline-history-navigation'

function message(seq: number, id = 'one', patch: Partial<Event> = {}): Event {
  return {
    id: `event-${seq}`, session_id: 'target', seq, ts: `2026-09-11T12:00:${String(seq).padStart(2, '0')}Z`,
    type: 'chat_conversation_message_received', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox',
    message_id: id, handoff_id: id, cross_chat_envelope_id: id, conversation_id: 'pair',
    source_session_id: 'source', target_session_id: 'target', source_title: 'Sender', inbox_state: 'unread',
    handoff_preview: `Message ${id}`, message_revision: 0, ...patch,
  }
}

await test('passive receipt appears without a run and only adjacent exact sender pairs group', () => {
  const events = [message(1), message(2, 'two'), message(3, 'other', { source_session_id: 'other' }), message(4, 'four')]
  const rows = projectTimeline(events, []) as SystemRow[]
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0].mailboxMessages?.map(row => row.event.message_id), ['one', 'two'])
  assert.deepEqual(rows[2].mailboxMessages?.map(row => row.event.message_id), ['four'])
  assert.equal(rowText(rows[0]), 'Message one\n\nMessage two')
  assert.equal(timelineTargetRowIndex(rows, { eventId: 'event-2', seq: 2 }), 0)
  assert.equal(events[0].type, 'chat_conversation_message_received', 'projection must not create provider starts or mutate receipt state')
  assert.equal(rows.some(row => row.event.type === 'turn_started'), false)
  const withUser = projectTimeline([message(1), message(2, 'human', { type: 'turn_started', run_id: 'run', prompt: 'Human boundary' }), message(3, 'two')], [])
  assert.equal(withUser.filter(row => row.kind === 'system').length, 2)
})

await test('provider read/cancel/delete state is monotonic and compatibility queue packets cannot downgrade mailbox', () => {
  const events = [message(1), message(2, 'one', { type: 'chat_conversation_message_read', inbox_state: 'read' }), message(3)]
  const read = projectTimeline(events, []) as SystemRow[]
  assert.equal(read[0].event.inbox_state, 'read')
  assert.equal(read[0].seq, 1)
  assert.equal(reuseStableTimelineRows(read, projectTimeline(events, [])), read)
  const cancelled = projectTimeline([...events, message(4, 'one', { type: 'chat_conversation_message_cancelled', inbox_state: 'cancelled' }), message(5)], []) as SystemRow[]
  assert.equal(cancelled[0].event.inbox_state, 'cancelled')
  assert.deepEqual(projectTimeline([...events, message(4, 'one', { type: 'chat_conversation_message_deleted', inbox_state: 'deleted' }), message(5)], []), [])
  const legacy = message(4, 'one', { type: 'chat_conversation_message_queued', delivery_mode: undefined, inbox_state: undefined, queued_id: 'legacy' })
  const mixed = projectTimeline([...events, legacy], []) as SystemRow[]
  assert.equal(mixed[0].event.delivery_mode, 'mailbox')
  assert.equal(mixed[0].event.inbox_state, 'read')
  assert.equal(timelineTargetRowIndex(mixed, { eventId: legacy.id, seq: legacy.seq }), 0)
})

await test('migration retains received timestamp; mailbox markers never upgrade legacy async delivery', () => {
  const receivedAt = '2026-09-10T12:00:00Z'
  const migrated = message(4, 'one', { type: 'chat_conversation_message_mailbox_migrated', received_at: receivedAt })
  const rows = projectTimeline([migrated], []) as SystemRow[]
  assert.equal(rows[0].anchorTs, receivedAt)
  assert.equal(rows[0].mailboxMessages?.length, 1)
  for (const type of ['chat_conversation_message_mailbox_migrated', 'chat_conversation_message_read', 'chat_conversation_message_deleted']) {
    assert.equal(isAsyncCrossChatMessage({ ...migrated, type, delivery_mode: undefined }), false)
    assert.equal(isAsyncCrossChatMessage({ ...migrated, type }), true)
  }
  assert.deepEqual(projectTimeline([message(1, 'legacy', { delivery_mode: undefined })], []), [])
  const outgoing = projectTimeline([message(1, 'sent', { session_id: 'source', type: 'chat_conversation_message_registered' })], []) as SystemRow[]
  assert.equal(outgoing[0].mailboxMessages, undefined, 'sender receipt remains an ordinary sent message')
})

await test('group row reuse accounts for every child read/revision/deletion and never mutates old rows', () => {
  const events = [message(1), message(2, 'two')]
  const previous = projectTimeline(events, []) as SystemRow[]
  assert.equal(reuseStableTimelineRows(previous, projectTimeline(events, [])), previous)
  const read = projectTimeline([...events, message(3, 'two', { type: 'chat_conversation_message_read', inbox_state: 'read' })], []) as SystemRow[]
  assert.notEqual(reuseStableTimelineRows(previous, read)[0], previous[0])
  const revised = projectTimeline([events[0], { ...events[1], message_revision: 1, message_body: 'Edited', message_edited_by_user: true }], [])
  assert.notEqual(reuseStableTimelineRows(previous, revised)[0], previous[0])
  const removed = projectTimeline([...events, message(3, 'two', { type: 'chat_conversation_message_deleted', inbox_state: 'deleted' })], []) as SystemRow[]
  assert.equal(removed[0].mailboxMessages?.length, 1)
  assert.equal(previous[0].mailboxMessages?.length, 2)
  assert.deepEqual(previous[0].representedEventIds, ['event-1', 'event-2'])
})

await test('cache preserves passive identities while oversized text cannot masquerade as complete CAS body', () => {
  const raw = message(1, 'one', { message_body: 'x'.repeat(60_000), message_revision: 3, message_edited_by_user: true })
  const safe = sanitizeTimelineEvent(raw)
  assert.equal(safe.message_body, undefined)
  assert.equal(safe.handoff_body_truncated, true)
  assert.equal(safe.message_revision, 3)
  assert.equal(safe.delivery_mode, 'mailbox')
  assert.equal(safe.inbox_state, 'unread')
  const cached = JSON.parse(JSON.stringify([safe])) as Event[]
  assert.deepEqual(projectTimeline(historicalTimelineEvents(cached.map(sanitizeTimelineEvent)), []), projectTimeline([safe], []))
})
