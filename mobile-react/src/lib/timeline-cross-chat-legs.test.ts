import assert from 'node:assert/strict'
import type { Event } from '../types'
import { projectTimeline, rowText } from './timeline'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { timelineTargetIsRepresented, timelineTargetRowIndex } from './timeline-history-navigation'

const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'source', seq, type, ts: `2026-10-30T12:00:0${seq}Z`, ...fields,
})
const events = [
  event(1, 'cross_chat_exchange_leg_registered', { exchange_id: 'exchange', exchange_leg_id: 'request', exchange_leg_kind: 'request', exchange_ordinal: 1, handoff_preview: 'Request', exchange_status: 'active' }),
  event(2, 'turn_started', { run_id: 'work', prompt: 'Separate human work' }),
  event(3, 'turn_finished', { run_id: 'work', result_text: 'Human answer' }),
  event(4, 'cross_chat_exchange_leg_delivered', { exchange_id: 'exchange', exchange_leg_id: 'reply', exchange_leg_kind: 'reply', exchange_ordinal: 2, handoff_preview: 'Peer reply', exchange_status: 'active' }),
  event(5, 'cross_chat_exchange_completed', { exchange_id: 'exchange', exchange_status: 'completed' }),
]
const rows = projectTimeline(events, [])
const messages = rows.filter(row => row.kind === 'system')
assert.equal(messages.length, 2, 'legacy request and reply render as separate compact messages, not one exchange panel')
assert.deepEqual(messages.map(row => row.crossChatLegId), ['request', 'reply'])
assert.deepEqual(messages.map(row => row.seq), [1, 4])
assert.deepEqual(messages.map(row => row.key), ['cross-chat-exchange:exchange:message:request', 'cross-chat-exchange:exchange:message:reply'])
assert.ok(messages.every(row => row.event.exchange_status === 'completed'), 'terminal exchange state still owns every rendered leg')
assert.ok(rows.indexOf(messages[0]) < rows.findIndex(row => rowText(row) === 'Separate human work'))
assert.ok(rows.indexOf(messages[1]) > rows.findIndex(row => rowText(row) === 'Human answer'))
assert.equal(reuseStableTimelineRows(rows, projectTimeline(events, [])), rows)
assert.equal(timelineTargetRowIndex(rows, { eventId: events[3].id, seq: 4 }), rows.indexOf(messages[1]), 'search for a reply must not jump to its earlier request')
assert.equal(timelineTargetIsRepresented(rows, { eventId: events[4].id, seq: 5 }), true, 'terminal summary remains represented without its own duplicate card')
assert.equal(projectTimeline([events[4]], []).length, 1, 'an exchange with no retained leg keeps one recoverable placeholder')
console.log('cross-chat per-leg timeline regressions passed')
