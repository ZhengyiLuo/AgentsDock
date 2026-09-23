import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { projectTimeline, rowText, traceEventsWithinRow, type TimelineRow, type TraceRow } from './timeline'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { historicalTimelineEvents, sanitizeTimelineEvent } from './timeline-memory'
import { timelineRowSequenceRange, timelineTargetIsRepresented, timelineTargetRowIndex } from './timeline-history-navigation'

function event(seq: number, type: string, patch: Partial<Event> = {}): Event {
  return { id: `event-${seq}`, session_id: 'chat', seq, type, ts: new Date(Date.UTC(2026, 8, 11, 12, 0, seq)).toISOString(), run_id: 'run', ...patch }
}
const sent = (seq: number, patch: Partial<Event> = {}) => event(seq, 'chat_conversation_message_registered', {
  conversation_mode: 'async_route_v1', message_id: 'message', cross_chat_envelope_id: 'message', conversation_id: 'pair',
  source_session_id: 'chat', target_session_id: 'target', handoff_preview: 'Sent context', ...patch,
})
const commentary = (seq: number, text: string) => event(seq, 'reasoning_summary', { phase: 'commentary', text })
function containing(rows: TimelineRow[], text: string): number { return rows.findIndex(row => rowText(row).includes(text)) }

const legacyLeg = (seq: number, id: string, patch: Partial<Event> = {}) => event(seq, 'cross_chat_exchange_leg_registered', {
  exchange_id: 'legacy', exchange_leg_id: id, exchange_leg_kind: id === 'request' ? 'request' : 'reply',
  exchange_ordinal: id === 'request' ? 1 : 2, exchange_status: 'active',
  source_session_id: id === 'request' ? 'chat' : 'peer', target_session_id: id === 'request' ? 'peer' : 'chat',
  handoff_preview: `${id} body`, ...patch,
})

await test('legacy request and reply keep separate anchors around ongoing work and terminal receipts', () => {
  const source = [event(1, 'turn_started', { prompt: 'Work' }), commentary(2, 'Before request'),
    legacyLeg(3, 'request'), commentary(4, 'Between request and reply'), legacyLeg(5, 'reply'), commentary(6, 'After reply')]
  const finished = [...source, event(7, 'cross_chat_exchange_completed', { exchange_id: 'legacy', exchange_status: 'completed' }),
    legacyLeg(8, 'reply', { type: 'cross_chat_exchange_leg_delivered', exchange_leg_status: 'delivered' })]
  for (const events of [source, finished]) {
    const rows = projectTimeline(events, [])
    const deliveries = rows.filter(row => row.kind === 'system' && row.key.startsWith('cross-chat-exchange:'))
    assert.deepEqual(deliveries.map(row => row.seq), [3, 5], 'each message needs its own chronological row, not one exchange container')
    assert(containing(rows, 'Before request') < rows.indexOf(deliveries[0]))
    assert(containing(rows, 'Between request and reply') > rows.indexOf(deliveries[0]))
    assert(containing(rows, 'Between request and reply') < rows.indexOf(deliveries[1]))
    assert(containing(rows, 'After reply') > rows.indexOf(deliveries[1]))
    assert(rows.at(-1)?.kind === 'progress', 'splitting messages must preserve the continuing live edge')
    assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
    for (const row of deliveries) {
      assert(row.kind === 'system')
      assert.equal(row.anchorTs, source.find(event => event.seq === row.seq)?.ts)
      assert.equal(row.events?.length, events === source ? 2 : 4, 'each row retains the full lifecycle for participant/status validation')
      assert.equal(row.event.exchange_status, events === source ? 'active' : 'completed', 'terminal state dominates stale late active packets on every message')
    }
    const replyIndex = rows.indexOf(deliveries[1])
    assert.equal(timelineTargetRowIndex(rows, { eventId: 'event-5', seq: 5 }), replyIndex)
    assert.equal(timelineTargetIsRepresented([deliveries[0]], { eventId: 'event-5', seq: 5 }), false, 'the request must not claim a reply search result')
    if (events === finished) {
      assert.equal(timelineTargetRowIndex(rows, { eventId: 'event-7', seq: 7 }), replyIndex, 'exchange terminal summaries remain seekable on the last message')
      assert.equal(timelineTargetIsRepresented([deliveries[0]], { eventId: 'event-7', seq: 7 }), false)
      assert.equal(timelineTargetRowIndex(rows, { eventId: 'event-8', seq: 8 }), replyIndex)
      assert.equal(timelineTargetIsRepresented([deliveries[0]], { eventId: 'compacted-receipt', seq: 8 }), false)
      assert.equal(timelineTargetIsRepresented([deliveries[1]], { eventId: 'compacted-receipt', seq: 8 }), true)
      assert.deepEqual(timelineRowSequenceRange(deliveries[0]), [3, 3], 'aggregate status cannot inflate another message range')
    }
  }
})

await test('legacy summaries keep a fallback card and status-only leg metadata cannot invent a message', () => {
  const summary = event(1, 'cross_chat_exchange_completed', { exchange_id: 'summary-only', exchange_status: 'completed' })
  const fallback = projectTimeline([summary], [])
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].key, 'cross-chat-exchange:summary-only')
  assert.equal(timelineTargetIsRepresented(fallback, { eventId: summary.id, seq: summary.seq }), true)
  const rows = projectTimeline([legacyLeg(3, 'request'), legacyLeg(4, 'status', { exchange_leg_kind: 'status' }), legacyLeg(5, 'reply')], [])
  assert.deepEqual(rows.filter(row => row.kind === 'system').map(row => row.seq), [3, 5])
  assert.equal(timelineTargetIsRepresented(rows, { eventId: 'event-4', seq: 4 }), true, 'status metadata stays represented without a new body row')
})

await test('sparse reopened legacy history retains an activity anchor on each side of every message', () => {
  const events = [event(1, 'turn_started', { prompt: 'Work' }), commentary(2, 'Before request'),
    legacyLeg(3, 'request'), commentary(4, 'Between request and reply'), legacyLeg(5, 'reply'), commentary(6, 'After reply'),
    event(7, 'turn_finished', { result_text: 'Finished work' })].map(sanitizeTimelineEvent)
  const bounded = historicalTimelineEvents(events)
  assert.deepEqual(bounded.filter(event => event.type === 'reasoning_summary').map(event => event.seq), [2, 4, 6])
  const reopened = projectTimeline(bounded, [])
  assert(containing(reopened, 'Between request and reply') > reopened.findIndex(row => row.seq === 3 && row.kind === 'system'))
  assert(containing(reopened, 'Between request and reply') < reopened.findIndex(row => row.seq === 5 && row.kind === 'system'))
  assert.deepEqual(projectTimeline((JSON.parse(JSON.stringify(bounded)) as Event[]).map(sanitizeTimelineEvent), []), reopened)
  assert.deepEqual(historicalTimelineEvents(events.slice(3), events.slice(0, 3)).filter(event => event.type === 'reasoning_summary').map(event => event.seq), [4, 6], 'paging context retains the distinct reply boundary')
})

await test('async send divides visible commentary before/after without ending the live run', () => {
  const events = [event(1, 'turn_started', { prompt: 'Work' }), commentary(2, 'Before send'), sent(3), commentary(4, 'After send')]
  const rows = projectTimeline(events, [])
  const messageIndex = rows.findIndex(row => row.kind === 'system' && row.crossChatMessage)
  assert(containing(rows, 'Before send') < messageIndex)
  assert(containing(rows, 'After send') > messageIndex)
  const progress = rows.filter(row => row.kind === 'progress')
  assert.equal(progress.length, 2)
  assert.equal(progress[0].continues, true)
  assert.equal(progress[1].continues, false)
  const beforeNextActivity = projectTimeline(events.slice(0, -1), [])
  assert(beforeNextActivity.at(-1)?.kind === 'progress', 'an empty continuing live edge must remain below the message')
  const final = projectTimeline([...events, event(5, 'turn_finished', { result_text: 'Final answer' })], [])
  assert(containing(final, 'Final answer') > final.findIndex(row => row.kind === 'system' && row.crossChatMessage))
})

await test('trace split keeps tool results at the original call, including full trace loads', () => {
  const call = event(2, 'tool_started', { tool_id: 'same', tool: { id: 'same', name: 'Read' } })
  const result = event(5, 'tool_finished', { tool_id: 'same', output: 'Result' })
  const thought = event(4, 'reasoning_summary', { text: 'After send thinking' })
  const events = [event(1, 'turn_started', { prompt: 'Work' }), call, sent(3), thought, result]
  const rows = projectTimeline(events, [])
  const traces = rows.filter((row): row is TraceRow => row.kind === 'trace')
  assert.equal(traces.length, 2)
  assert.deepEqual(traces[0].events.map(value => value.id), [call.id, result.id])
  assert.deepEqual(traces[1].events.map(value => value.id), [thought.id])
  assert.equal(traces[0].continues, true)
  assert.equal(traces[0].active, false)
  assert.equal(traces[0].runActive, true, 'earlier segments retain the unsplit live commentary policy')
  assert.equal(traces[1].active, true)
  assert.equal(traces[1].runActive, true)
  assert.deepEqual(traceEventsWithinRow(traces[0], [call, thought, result]).map(value => value.id), [call.id, result.id])
  assert.deepEqual(traceEventsWithinRow(traces[1], [call, thought, result]).map(value => value.id), [thought.id])
  const otherRun = event(6, 'tool_finished', { run_id: 'other', tool_id: 'same' })
  assert(!traceEventsWithinRow(traces[0], [call, result, otherRun]).includes(otherRun), 'same tool ID in a different run cannot borrow the earlier start')
  const sparse: TraceRow = { ...traces[1], toolStartSequences: {} }
  assert.deepEqual(traceEventsWithinRow(sparse, [call, thought, result]), [thought], 'loaded starts refine a metadata-light sample')
})

await test('late receipts do not move the message, earlier answers, or stopped activity across it', () => {
  const events = [event(1, 'turn_started', { prompt: 'Work' }), commentary(2, 'Before send'), sent(3), commentary(4, 'After send'), event(5, 'turn_stopped', { stopped: true })]
  const rows = projectTimeline(events, [])
  const messageIndex = rows.findIndex(row => row.kind === 'system' && row.crossChatMessage)
  assert(containing(rows, 'Before send') < messageIndex)
  assert(containing(rows, 'After send') > messageIndex)
  assert(rows.findIndex(row => row.kind === 'system' && row.event.type === 'turn_stopped') > messageIndex)
  const late = projectTimeline([...events, sent(9, { type: 'chat_conversation_message_delivered', handoff_status: 'delivered' })], [])
  assert.deepEqual(late.map(row => [row.kind, row.key, row.seq]), rows.map(row => [row.kind, row.key, row.seq]))
  const reused = reuseStableTimelineRows(rows, late)
  for (let index = 0; index < rows.length; index++) if (index !== messageIndex) assert.equal(reused[index], rows[index])
})

await test('messages from one sender do not fold across intervening agent activity', () => {
  const inbox = (seq: number, id: string) => sent(seq, {
    type: 'chat_conversation_message_received', delivery_mode: 'mailbox', inbox_state: 'unread',
    message_id: id, cross_chat_envelope_id: id, source_session_id: 'sender', target_session_id: 'chat',
  })
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Work' }), inbox(2, 'one'), commentary(3, 'Between messages'), inbox(4, 'two')], [])
  const groups = rows.filter(row => row.kind === 'system' && row.mailboxMessages)
  assert.equal(groups.length, 2)
  assert(groups.every(row => row.kind === 'system' && row.mailboxMessages?.length === 1))
})

await test('reopened history retains bounded trace anchors on both sides and original tool ownership', () => {
  const events = [
    event(1, 'turn_started', { prompt: 'Work' }),
    event(2, 'tool_started', { tool_id: 'read', tool: { id: 'read', name: 'Read' } }),
    sent(3), event(4, 'reasoning_summary', { text: 'After send' }),
    event(5, 'tool_finished', { tool_id: 'read', output: 'Complete' }),
    event(6, 'turn_finished', { result_text: 'Final' }),
  ].map(sanitizeTimelineEvent)
  const bounded = historicalTimelineEvents(events)
  assert(bounded.some(event => event.seq === 2), 'original tool start must survive alongside a selected late result')
  assert(bounded.some(event => event.seq === 4), 'a distinct post-message trace segment must retain its lazy anchor')
  const rows = projectTimeline(bounded, [])
  const traces = rows.filter((row): row is TraceRow => row.kind === 'trace')
  assert.equal(traces.length, 2)
  assert(traces.every(row => row.runActive === false), 'completed segments permit historical commentary in loaded traces')
  assert.deepEqual(traces[0].events.map(event => event.seq), [2, 5])
  assert.deepEqual(traces[1].events.map(event => event.seq), [4])
  const cached = JSON.parse(JSON.stringify(bounded)) as Event[]
  assert.deepEqual(projectTimeline(historicalTimelineEvents(cached.map(sanitizeTimelineEvent)), []), rows)
})
