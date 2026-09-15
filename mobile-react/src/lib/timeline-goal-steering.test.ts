import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentFile, Event, QueuedTurn } from '../types'
import { mergeEvents, messageText } from './format'
import { isNativeGoalSteerEvent } from './native-goal-steering'
import { historicalTimelineEvents, sanitizeTimelineEvent } from './timeline-memory'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { projectPresentableHistory, projectTimeline, rowText, traceEventsWithinRow, type MessageRow, type TimelineRow, type TraceRow } from './timeline'
import { updateQueuedTurns } from './queue'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `goal-event-${seq}`, seq, type, session_id: 'chat', run_id: 'goal-owner', backend: 'codex',
  ts: new Date(Date.UTC(2026, 8, 15, 10, 0, seq)).toISOString(), ...patch,
})
const steer = (seq = 5, patch: Partial<Event> = {}): Event => event(seq, 'turn_steered', {
  purpose: 'codex_goal_resume', native_steer: true, native_goal_steer: true, provider_user_authored: true,
  queued_id: `queued-${seq}`, prompt: `Follow-up ${seq}`, file_ids: [], ...patch,
})
const history = (): Event[] => [
  event(1, 'turn_started', { prompt: 'Keep working on the goal.' }),
  event(2, 'reasoning_summary', { phase: 'analysis', text: 'Earlier private reasoning.' }),
  event(3, 'assistant_text', { phase: 'final_answer', text: 'Earlier goal result.' }),
  event(4, 'reasoning_summary', { phase: 'commentary', text: 'Progress before the follow-up.' }),
  steer(),
  event(6, 'reasoning_summary', { phase: 'analysis', text: 'After first follow-up.' }),
  event(7, 'assistant_text', { phase: 'final_answer', text: 'The follow-up is incorporated.' }),
  event(8, 'reasoning_summary', { phase: 'commentary', text: 'The same goal continues.' }),
  steer(9),
  event(10, 'reasoning_summary', { phase: 'commentary', text: 'Continuing after the second follow-up.' }),
]
const messages = (rows: TimelineRow[], role: 'user' | 'assistant'): MessageRow[] => rows.filter((row): row is MessageRow => row.kind === 'message' && row.role === role)
const traces = (rows: TimelineRow[]): TraceRow[] => rows.filter((row): row is TraceRow => row.kind === 'trace')
const file = (id: string, session_id?: string): AgentFile => ({ id, filename: `${id}.txt`, mime_type: 'text/plain', session_id })

test('native goal follow-ups preserve every user and assistant segment in chronological order without changing the owner', () => {
  const source = history(), before = JSON.stringify(source)
  const rows = projectTimeline(source, [])
  assert.deepEqual(messages(rows, 'user').map(row => [row.key, row.seq, rowText(row)]), [
    ['turn:goal-owner:user', 1, 'Keep working on the goal.'],
    ['turn:goal-owner:start-5:user', 5, 'Follow-up 5'],
    ['turn:goal-owner:start-9:user', 9, 'Follow-up 9'],
  ])
  assert.deepEqual(rows.filter(row => row.kind === 'message').map(row => row.seq), [1, 3, 5, 7, 9])
  assert.deepEqual(messages(rows, 'assistant').map(rowText), ['Earlier goal result.', 'The follow-up is incorporated.'])
  assert(traces(rows).every(row => row.runId === 'goal-owner'))
  assert.equal(JSON.stringify(source), before)
  assert(!rows.some(row => row.kind === 'system' && row.event.type === 'turn_stopped'))
})

test('native segment trace bounds prevent full-run lazy detail reads from absorbing another follow-up', () => {
  const source = history(), rows = projectTimeline(source, [])
  assert.deepEqual(traces(rows).map(row => [row.afterSeq, row.throughSeq, row.active, row.continues]), [
    [undefined, 4, false, true], [5, 8, false, true],
  ])
  assert.deepEqual(traces(rows).map(row => traceEventsWithinRow(row, source).map(value => value.seq)), [[1, 2, 3, 4], [6, 7, 8]])
  const progress = rows.find(row => row.kind === 'progress')!
  assert.equal(progress.kind, 'progress')
  assert.equal(progress.afterSeq, 9)
  assert.deepEqual(progress.events.map(value => value.seq), [10])
})

test('active and paused goal status packets do not suppress verified follow-ups or ordinary new messages', () => {
  for (const status of ['active', 'paused']) {
    const source = [...history(), event(11, 'codex_goal_updated', { goal: { status } }), event(12, 'turn_started', { run_id: 'ordinary-new-owner', prompt: 'A normal message after the goal changed.' })]
    assert.deepEqual(messages(projectTimeline(source, []), 'user').map(row => rowText(row)), ['Keep working on the goal.', 'Follow-up 5', 'Follow-up 9', 'A normal message after the goal changed.'])
  }
})

test('every incremental append, duplicate receipt and cold reconstruction keep unique stable message identities', () => {
  let source: Event[] = [], cached: TimelineRow[] = []
  for (const next of history()) {
    source = mergeEvents(source, [next])
    cached = reuseStableTimelineRows(cached, projectTimeline(source, []))
    assert.deepEqual(cached, projectTimeline(source.map(value => ({ ...value })), []))
    assert.equal(new Set(cached.map(row => row.key)).size, cached.length)
  }
  const duplicatePackets = [...source, { ...steer() }, { ...steer(9) }]
  assert.deepEqual(projectTimeline(duplicatePackets, []), projectTimeline(source, []))
  const replayed = mergeEvents(mergeEvents([], source.slice(4)), source)
  assert.deepEqual(projectTimeline(replayed, []), projectTimeline(source, []))
})

test('equal user text and equal assistant text on different native inputs remain distinct', () => {
  const source = [event(1, 'turn_started', { prompt: 'Same words' }), event(2, 'assistant_text', { text: 'Same answer' }),
    steer(3, { prompt: 'Same words' }), event(4, 'assistant_text', { text: 'Same answer' }),
    steer(5, { prompt: 'Same words' }), event(6, 'assistant_text', { text: 'Same answer' })]
  const rows = projectTimeline(source, [])
  assert.deepEqual(messages(rows, 'user').map(rowText), ['Same words', 'Same words', 'Same words'])
  assert.deepEqual(messages(rows, 'assistant').map(rowText), ['Same answer', 'Same answer', 'Same answer'])
})

test('an exact queued receipt becomes one native user bubble while only that queue ID is drained', () => {
  const queued = event(3, 'turn_queued', { queued_id: 'queued-5', prompt: 'Follow-up 5', file_ids: [] })
  const runNow = event(4, 'turn_queue_run_now', { queued_id: 'queued-5', native_steer: true, native_goal_steer: true })
  const other: QueuedTurn = { queued_id: 'other', session_id: 'chat', prompt: 'Same text is a different message', file_ids: [] }
  let queue = updateQueuedTurns([other], queued)
  queue = updateQueuedTurns(updateQueuedTurns(queue, runNow), steer())
  assert.deepEqual(queue.map(value => value.queued_id), ['other'])
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Goal input' }), queued, runNow, steer(), steer()], [])
  assert.deepEqual(messages(rows, 'user').map(rowText), ['Goal input', 'Follow-up 5'])
})

test('a partial history page beginning with native input keeps the same stable user key and is presentable', () => {
  const full = projectTimeline(history(), []), partial = projectPresentableHistory(history().slice(4), [])!
  assert(partial)
  assert.equal(messages(partial, 'user')[0].key, messages(full, 'user')[1].key)
  assert.equal(messages(partial, 'user')[0].seq, 5)
  assert.equal(rowText(messages(partial, 'user')[0]), 'Follow-up 5')
})

test('attachment-only native input remains a user message on a partial page and cold history', () => {
  const input = steer(5, { prompt: '', file_ids: ['file-1'] }), attachment = file('file-1', 'chat')
  for (const source of [[input], historicalTimelineEvents([sanitizeTimelineEvent(input)])]) {
    const rows = projectPresentableHistory(source, [attachment])!
    assert(rows)
    assert.deepEqual(messages(rows, 'user')[0].files, [attachment])
    assert.equal(rowText(messages(rows, 'user')[0]), '')
    assert.equal(rows.filter(row => row.kind === 'media').length, 0)
  }
})

test('an attachment-only native acknowledgement recovers its exact queued files across replay and history reload', () => {
  const queued = event(1, 'turn_queued', { queued_id: 'queued-5', prompt: '', file_ids: ['input-file'] })
  const promoted = event(3, 'turn_queue_run_now', { queued_id: 'queued-5', file_ids: [] })
  const input = steer(5, { prompt: '', file_ids: [] }), attachment = file('input-file', 'chat')
  const source = [queued, promoted, input], before = JSON.stringify(source)
  const expected = projectTimeline(source, [attachment])
  assert.deepEqual(messages(expected, 'user').map(row => row.files.map(value => value.id)), [['input-file']])
  assert.equal(messages(expected, 'user')[0].key, 'turn:goal-owner:start-5:user')
  for (const history of [source, [...source, { ...input }], historicalTimelineEvents(source.map(sanitizeTimelineEvent))]) {
    const rows = messages(projectTimeline(history, [attachment]), 'user')
    assert.deepEqual(rows.map(row => [row.key, rowText(row), row.files]), [['turn:goal-owner:start-5:user', '', [attachment]]])
  }
  assert.equal(reuseStableTimelineRows(expected, projectTimeline(source, [attachment])), expected)
  assert.equal(JSON.stringify(source), before, 'file recovery must not rewrite source acknowledgement or queue events')
})

test('the latest exact queue file edit owns native attachments, including removal, without treating absent fields as edits', () => {
  const queued = event(1, 'turn_queued', { queued_id: 'queued-5', file_ids: ['old-file'] })
  const input = steer(5, { prompt: 'Visible input', file_ids: ['old-file'] })
  const files = [file('old-file', 'chat'), file('new-file', 'chat')]
  for (const [update, expected] of [
    [{ file_ids: ['new-file'] }, ['new-file']],
    [{ file_ids: [] }, []],
    [{ prompt: 'Edited text only' }, ['old-file']],
  ] as const) {
    const edited = event(3, 'turn_queue_updated', { queued_id: 'queued-5', ...update, ...('file_ids' in update ? { file_ids: [...update.file_ids] } : {}) })
    const rows = projectTimeline([queued, edited, input], files)
    assert.deepEqual(messages(rows, 'user')[0].files.map(value => value.id), expected)
    assert.deepEqual(messages(rows, 'user')[0].events[0].file_ids, expected)
  }
  const updateOnly = event(3, 'turn_queue_updated', { queued_id: 'queued-5', file_ids: ['new-file'] })
  assert.deepEqual(messages(projectTimeline([updateOnly, input], files), 'user')[0].files.map(value => value.id), ['new-file'])
})

test('queue removal and previous consumption invalidate native attachment recovery without reusing equal-text inputs', () => {
  const queued = event(1, 'turn_queued', { queued_id: 'queued-5', prompt: 'Equal text', file_ids: ['input-file'] })
  const input = steer(5, { prompt: '', file_ids: [] }), files = [file('input-file', 'chat')]
  for (const type of ['turn_unqueued', 'turn_started']) {
    const consumed = event(3, type, { queued_id: 'queued-5', prompt: 'Earlier consumption', file_ids: [] })
    assert.equal(messages(projectTimeline([queued, consumed, input], files), 'user').some(row => row.seq === 5), false)
  }
  const later = steer(9, { queued_id: 'queued-5', prompt: '', file_ids: [] })
  assert.deepEqual(messages(projectTimeline([queued, input, later], files), 'user').map(row => row.seq), [5])
  assert.equal(messages(projectTimeline([queued, steer(5, { queued_id: 'different', prompt: '', file_ids: [] })], files), 'user').length, 0)
})

test('native file recovery requires exact nonblank chat and queue identities and rejects foreign file ownership', () => {
  const input = steer(5, { prompt: '', file_ids: [] }), files = [file('input-file', 'chat'), file('foreign-file', 'other-chat')]
  for (const patch of [
    { session_id: 'other-chat' }, { session_id: '' }, { session_id: ' chat' },
    { queued_id: 'queued-5 ' }, { queued_id: '' }, { queued_id: undefined },
  ]) {
    const queued = event(1, 'turn_queued', { queued_id: 'queued-5', file_ids: ['input-file'], ...patch })
    assert.equal(messages(projectTimeline([queued, input], files), 'user').length, 0)
  }
  const queued = event(1, 'turn_queued', { queued_id: 'queued-5', file_ids: ['input-file', 'foreign-file'] })
  const otherChatEdit = event(3, 'turn_queue_updated', { session_id: 'other-chat', queued_id: 'queued-5', file_ids: [] })
  const otherChatRemoval = event(4, 'turn_unqueued', { session_id: 'other-chat', queued_id: 'queued-5' })
  assert.deepEqual(messages(projectTimeline([queued, otherChatEdit, otherChatRemoval, input], files), 'user')[0].files.map(value => value.id), ['input-file'])
})

test('an ack-only partial page uses explicit native files but never guesses from unrelated known files', () => {
  const attachment = file('input-file', 'chat')
  for (const ids of [undefined, []]) assert.equal(messages(projectTimeline([steer(5, { prompt: '', file_ids: ids })], [attachment]), 'user').length, 0)
  assert.deepEqual(messages(projectTimeline([steer(5, { prompt: '', file_ids: ['input-file'] })], [attachment]), 'user')[0].files, [attachment])
})

test('files attach only to the exact native follow-up, not an earlier user or generated output row', () => {
  const first = file('first', 'chat'), second = file('second', 'chat'), generated = file('generated', 'chat')
  const source = [event(1, 'turn_started', { prompt: 'Initial input', file_ids: ['first'] }),
    steer(5, { prompt: 'With file', file_ids: ['second', 'second'] }), event(6, 'artifact_created', { artifact: generated })]
  const rows = projectTimeline(source, [first, second])
  assert.deepEqual(messages(rows, 'user').map(row => row.files.map(value => value.id)), [['first'], ['second']])
  assert.deepEqual(rows.filter(row => row.kind === 'media').flatMap(row => row.files.map(value => value.id)), ['generated'])
})

test('late upload receipts resolve native input files without accepting a different chat owner', () => {
  const input = steer(5, { prompt: '', file_ids: ['safe', 'foreign', 'legacy'] })
  const safe = file('safe', 'chat'), foreign = file('foreign', 'other-chat'), legacy = file('legacy')
  const rows = projectTimeline([input, event(6, 'file_uploaded', { file: safe }), event(7, 'file_uploaded', { file: foreign }), event(8, 'file_uploaded', { file: legacy })], [])
  assert.deepEqual(messages(rows, 'user')[0].files.map(value => value.id), ['safe', 'legacy'])
  assert.deepEqual(messages(projectTimeline([input], [safe, foreign, legacy]), 'user')[0].files.map(value => value.id), ['safe', 'legacy'])
})

test('real stop and finish affect only the latest native segment and never remove earlier inputs or replies', () => {
  for (const terminal of [event(11, 'turn_stopped'), event(11, 'turn_finished', { result_text: 'Final follow-up result.' })]) {
    const rows = projectTimeline([...history(), event(10.5, 'reasoning_summary', { text: 'Newest reasoning', phase: 'analysis' }), terminal], [])
    assert.equal(messages(rows, 'user').length, 3)
    assert(traces(rows).every(row => !row.active))
    assert.equal(traces(rows).filter(row => row.terminalSeq === 11).length, 1)
    assert(messages(rows, 'assistant').some(row => rowText(row).includes('Earlier goal result.')))
    assert(messages(rows, 'assistant').some(row => rowText(row).includes('The follow-up is incorporated.')))
    if (terminal.type === 'turn_stopped') assert.equal(rows.filter(row => row.kind === 'system' && row.event.type === 'turn_stopped').length, 1)
  }
})

test('completed earlier owner does not absorb native user input and the later actual completion remains distinct', () => {
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Earlier input' }), event(2, 'turn_finished', { result_text: 'Earlier result' }),
    steer(5), event(6, 'turn_finished', { result_text: 'Follow-up result' })], [])
  assert.deepEqual(rows.filter(row => row.kind === 'message').map(rowText), ['Earlier input', 'Earlier result', 'Follow-up 5', 'Follow-up result'])
})

test('display_prompt owns native visible text and exact generated authority suffixes are stripped', () => {
  const suffix = '\n\n[AgentsDock provider authority]\nauthority-file=/example/cross_chat_authority/run_example.json chat-id=sess_a123\nactions=cross_chat_instruction\nusage: see AgentsDock instructions\n[End AgentsDock provider authority]'
  const native = steer(5, { prompt: `Provider prompt${suffix}`, display_prompt: `Visible input${suffix}` })
  assert.equal(messageText(native), 'Visible input')
  assert.equal(rowText(messages(projectTimeline([native], []), 'user')[0]), 'Visible input')
  assert.equal(messageText(steer(6, { prompt: 'Must not replace explicit empty display text', display_prompt: '' })), '')
  assert.equal(messages(projectTimeline([steer(6, { prompt: 'Must not replace explicit empty display text', display_prompt: '' })], []), 'user').length, 0)
  assert.equal(messageText(steer(7, { prompt: `Visible input${suffix}` })), 'Visible input')
})

test('literal lookalikes and user text after a provider-shaped block remain byte-for-byte visible', () => {
  const lookalike = 'Explain this marker:\n\n[AgentsDock provider authority]\nnot a generated block\n[End AgentsDock provider authority]'
  const after = 'Example:\n\n[AgentsDock provider authority]\nauthority-file=/example/cross_chat_authority/run_example.json\n[End AgentsDock provider authority]\n\nKeep this user-authored conclusion.'
  for (const prompt of [lookalike, after, '<task-notification>Literal user example</task-notification>']) assert.equal(messageText(steer(5, { prompt })), prompt)
})

test('unproven native-looking packets never create trusted user boundaries or gain display-prompt handling', () => {
  for (const patch of [{ native_goal_steer: false }, { native_steer: false }, { backend: 'claude' as const }, { purpose: 'scheduled_job' },
    { provider_user_authored: undefined }, { provider_user_authored: false }, { run_id: undefined }, { run_id: ' ' }, { type: 'turn_steer_requested' }]) {
    const input = steer(5, { prompt: 'Unproven packet', display_prompt: 'Not a proven input', ...patch })
    assert.equal(isNativeGoalSteerEvent(input), false)
    assert.equal(messages(projectTimeline([input], []), 'user').length, 0)
    assert.equal(messageText(input), 'Unproven packet')
  }
})

test('long sanitized and imported history retains native boundaries and all distinct user text', () => {
  const long = 'Preserve this long user context. '.repeat(3000)
  const source = [event(1, 'turn_started', { imported: true, run_id: 'import_original', prompt: 'Imported user text' }),
    event(2, 'assistant_text', { imported: true, run_id: 'import_original', text: 'Imported answer' }),
    steer(5, { prompt: long }), event(6, 'assistant_text', { text: 'Independent answer' }),
    steer(9, { imported: true, prompt: 'Imported native input' })]
  const compact = historicalTimelineEvents(source.map(sanitizeTimelineEvent))
  const rows = projectTimeline(compact, [])
  const users = messages(rows, 'user')
  assert.equal(users.length, 3)
  assert.equal(rowText(users[0]), 'Imported user text')
  assert(rowText(users[1]).startsWith('Preserve this long user context. '))
  assert(rowText(users[1]).length < long.length)
  assert.equal(rowText(users[2]), 'Imported native input')
  assert.deepEqual(messages(rows, 'assistant').map(rowText), ['Imported answer', 'Independent answer'])
})

test('many native inputs keep deterministic identities after history trimming, prepend and exact packet replay', () => {
  const source = Array.from({ length: 80 }, (_, index) => [steer(index * 3 + 1, { prompt: `User ${index}` }), event(index * 3 + 2, 'assistant_text', { text: `Answer ${index}` })]).flat()
  const full = projectTimeline(source, []), partialSource = source.slice(60), partial = projectTimeline(partialSource, [])
  assert.equal(messages(full, 'user').length, 80)
  assert.equal(messages(full, 'assistant').length, 80)
  const keys = new Set(messages(full, 'user').map(row => row.key))
  assert(messages(partial, 'user').every(row => keys.has(row.key)))
  assert.deepEqual(projectTimeline(mergeEvents(partialSource, source), []), full)
  assert.deepEqual(messages(projectTimeline(historicalTimelineEvents(source), []), 'user').map(row => row.key), messages(full, 'user').map(row => row.key))
})

test('cross-chat lifecycle cards remain chronological between native goal user boundaries', () => {
  const handoff = event(6, 'cross_chat_handoff_delivered', { source_session_id: 'chat', target_session_id: 'peer', handoff_id: 'handoff', message: 'An independent chat message.' })
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Initial' }), steer(5), handoff, steer(9)], [])
  assert.deepEqual(rows.map(row => row.seq), [1, 5, 6, 9])
  assert.equal(rows[2].kind, 'system')
  assert.equal(messages(rows, 'user').length, 3)
})

test('a native user input breaks adjacent scheduled-job cards even when the goal owner was already displayed', () => {
  const job = (seq: number, run: string) => event(seq, 'job_finished', { run_id: run, job_id: 'job-one', job_title: 'Scheduled check', result_text: 'Job result' })
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Goal start' }), job(2, 'job-run-a'), steer(5), job(7, 'job-run-b')], [])
  assert.deepEqual(rows.map(row => [row.kind, row.seq]), [['message', 1], ['job', 2], ['message', 5], ['job', 7]])
})

test('same-ID acknowledgement metadata replacement updates the native bubble without changing its key', () => {
  const input = steer(5), source = [event(1, 'turn_started', { prompt: 'Initial' }), input]
  const first = projectTimeline(source, [])
  const updated = mergeEvents(source, [{ ...input, display_prompt: 'Authoritative display text' }])
  const next = reuseStableTimelineRows(first, projectTimeline(updated, []))
  assert.equal(messages(next, 'user')[0], messages(first, 'user')[0])
  assert.equal(messages(next, 'user')[1].key, messages(first, 'user')[1].key)
  assert.notEqual(messages(next, 'user')[1], messages(first, 'user')[1])
  assert.equal(rowText(messages(next, 'user')[1]), 'Authoritative display text')
})
