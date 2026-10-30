import assert from 'node:assert/strict'
import type { Event } from '../types'
import { crossChatSemanticKey, isAsyncCrossChatMessage, projectTimeline, rowText } from './timeline'
import { historicalTimelineEvents, sanitizeTimelineEvent } from './timeline-memory'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { timelineTargetIsRepresented, timelineTargetRowIndex } from './timeline-history-navigation'

const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'recipient', seq, type,
  ts: new Date(1_780_000_000_000 + seq * 1000).toISOString(), ...fields,
})
const message = (seq: number, id: string, state = 'unread', fields: Partial<Event> = {}): Event => event(seq,
  `chat_conversation_message_${state === 'unread' ? 'received' : state}`, {
    message_id: id, cross_chat_envelope_id: id, conversation_id: 'pair', conversation_mode: 'async_route_v1',
    delivery_mode: 'mailbox', inbox_state: state, source_session_id: 'sender', source_title: 'Actual Sender',
    target_session_id: 'recipient', handoff_preview: `Body ${id}`,
    received_at: new Date(1_780_000_000_000 + Number(id.slice(-1)) * 1000).toISOString(),
    ...fields,
  } as Partial<Event>)
const mailboxRows = (events: Event[]) => projectTimeline(events, []).filter(row => row.kind === 'system')

const received = message(1, 'message-1')
const receiptRows = mailboxRows([received])
assert.equal(receiptRows.length, 1, 'accepted passive incoming messages must be visible before any wake or provider read')
assert.equal(receiptRows[0].crossChatMessage, true)
assert.equal(receiptRows[0].seq, received.seq)
assert.equal(receiptRows[0].anchorTs, received.received_at)
assert.equal(receiptRows[0].mailboxMessages?.[0].event.message_id, 'message-1')

for (const type of ['mailbox_migrated', 'read', 'deleted']) {
  const value = message(2, 'message-1', 'read', { type: `chat_conversation_message_${type}` })
  assert.equal(isAsyncCrossChatMessage(value), true)
  assert.equal(crossChatSemanticKey(value), 'cross-chat:handoff:message-1')
  assert.equal(isAsyncCrossChatMessage({ ...value, delivery_mode: undefined }), false, 'new lifecycle requires exact mailbox protocol')
  assert.equal(isAsyncCrossChatMessage({ ...value, conversation_mode: undefined }), false)
}

const beforeRead = [received, message(2, 'message-2')]
const grouped = mailboxRows(beforeRead)
assert.equal(grouped.length, 1)
assert.deepEqual(grouped[0].mailboxMessages?.map(row => row.event.message_id), ['message-1', 'message-2'])
assert.equal(timelineTargetIsRepresented(grouped, { eventId: 'event-2', seq: 2 }), true)
assert.equal(timelineTargetRowIndex(grouped, { eventId: 'event-2', seq: 2 }), 0)
assert.equal(reuseStableTimelineRows(grouped, mailboxRows(beforeRead)), grouped, 'unchanged message groups reuse their native rows')
Object.freeze(grouped[0].mailboxMessages)
const appended = mailboxRows([...beforeRead, message(3, 'message-3')])
assert.equal(grouped[0].mailboxMessages?.length, 2, 'append must not mutate a previously rendered group')
assert.equal(appended[0].mailboxMessages?.length, 3)
assert.notEqual(reuseStableTimelineRows(grouped, appended)[0], grouped[0], 'a new child refreshes the group')

const read = message(3, 'message-2', 'read')
const readGroup = mailboxRows([...beforeRead, read])
assert.equal(readGroup[0].seq, received.seq)
assert.equal(readGroup[0].mailboxMessages?.[1].event.inbox_state, 'read')
assert.notEqual(reuseStableTimelineRows(grouped, readGroup)[0], grouped[0], 'later-child read state must not be swallowed by reuse')
assert.equal(timelineTargetIsRepresented(readGroup, { eventId: read.id, seq: read.seq }), true)

const terminalEvents = [received, message(2, 'message-1', 'read'), message(3, 'message-1', 'cancelled'), message(4, 'message-1')]
const cancelled = mailboxRows(terminalEvents)
assert.equal(cancelled[0].event.inbox_state, 'cancelled', 'a stale unread packet must not revive cancelled delivery')
assert.equal(reuseStableTimelineRows(cancelled, mailboxRows(terminalEvents)), cancelled, 'normalized terminal state remains stable')
assert.equal(mailboxRows([...terminalEvents, message(5, 'message-1', 'deleted'), message(6, 'message-1')]).length, 0)

const otherSender = message(3, 'message-3', 'unread', { source_session_id: 'other-sender' })
assert.equal(mailboxRows([...beforeRead, otherSender]).length, 2, 'different peers never merge into one sender group')
const outgoing = message(4, 'message-4', 'unread', { session_id: 'sender', type: 'chat_conversation_message_registered' })
assert.equal(mailboxRows([outgoing])[0].mailboxMessages, undefined, 'outgoing receipts stay independent')
assert.equal(mailboxRows([event(1, 'assistant_text', { text: 'I sent a message.' })]).length, 0, 'ordinary assistant prose is not a receipt')

const busy = [event(1, 'turn_started', { run_id: 'busy', prompt: 'Keep working' }), message(2, 'message-1'),
  event(3, 'reasoning_summary', { run_id: 'busy', phase: 'commentary', text: 'Independent work continues' }),
  message(4, 'message-2'), event(5, 'turn_finished', { run_id: 'busy', result_text: 'Own final' })]
const busyRows = projectTimeline(busy, [])
assert.equal(busyRows.filter(row => row.kind === 'system').length, 2, 'actual work separates sender bursts')
assert.deepEqual(busyRows.filter(row => row.kind === 'message').map(rowText), ['Keep working', 'Own final'])
assert.deepEqual(busyRows.map(row => row.seq), [1, 2, 3, 4, 5], 'completed trace and final preserve mailbox arrival chronology')

const active = [event(1, 'turn_started', { run_id: 'active', prompt: 'Keep working' }),
  event(2, 'reasoning_summary', { run_id: 'active', phase: 'commentary', text: 'Before mail' }),
  message(3, 'message-1'), event(4, 'reasoning_summary', { run_id: 'active', phase: 'commentary', text: 'After first mail' }),
  message(5, 'message-2'), event(6, 'reasoning_summary', { run_id: 'active', phase: 'commentary', text: 'After second mail' })]
const activeRows = projectTimeline(active, [])
assert.deepEqual(activeRows.map(row => row.kind), ['message', 'progress', 'system', 'progress', 'system', 'progress'])
assert.deepEqual(activeRows.map(row => row.seq), [1, 2, 3, 4, 5, 6], 'passive delivery must not move live progress or interrupt provider ownership')
assert.deepEqual(activeRows.filter(row => row.kind === 'progress').flatMap(row => row.events.map(value => value.text)), ['Before mail', 'After first mail', 'After second mail'])
assert.equal(new Set(activeRows.map(row => row.key)).size, activeRows.length)
assert.equal(reuseStableTimelineRows(activeRows, projectTimeline(active, [])), activeRows)

const original = message(2, 'message-1', 'unread', { delivery_mode: undefined, inbox_state: undefined })
assert.equal(mailboxRows([original]).length, 0, 'legacy execution deliveries remain invisible until admission')
const migrated = message(6, 'message-1', 'unread', { type: 'chat_conversation_message_mailbox_migrated', received_at: original.ts })
const migration = mailboxRows([original, migrated])
assert.equal(migration.length, 1)
assert.equal(migration[0].seq, original.seq)
assert.equal(migration[0].anchorTs, original.ts)
for (let length = 1; length <= terminalEvents.length; length++) {
  const prefix = terminalEvents.slice(0, length).map(sanitizeTimelineEvent)
  assert.deepEqual(projectTimeline(prefix, []), projectTimeline(historicalTimelineEvents((JSON.parse(JSON.stringify(prefix)) as Event[]).map(sanitizeTimelineEvent)), []), 'live and hydrated history agree')
}
const oversized = message(1, 'message-1', 'unread', {
  message_body: 'Recipient text. '.repeat(5_000), handoff_body_chars: 90_000,
  handoff_body_sha256: 'a'.repeat(64), message_revision: 3, message_edited_by_user: true,
  provider_user_authored: true,
})
const bounded = sanitizeTimelineEvent(oversized)
assert.ok((bounded.message_body?.length ?? 0) <= 48_000)
assert.equal(bounded.handoff_body_truncated, true)
assert.equal(bounded.handoff_body_chars, 90_000)
assert.equal(bounded.handoff_body_sha256, oversized.handoff_body_sha256, 'retain the original full-body hash for authenticated detail validation')
assert.equal(bounded.message_revision, 3)
assert.equal(bounded.provider_user_authored, true, 'bounds must not erase positive user provenance')
assert.equal(sanitizeTimelineEvent(bounded).handoff_body_chars, 90_000, 'hydration retains original size, not the bounded preview size')
console.log('passive cross-chat inbox timeline regressions passed')
