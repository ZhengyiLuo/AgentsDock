import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, QueuedTurn } from '../types'
import { mergeEvents } from './format'
import { projectTimeline, projectPresentableHistory, rowText } from './timeline'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import { updateQueuedTurns } from './queue'
import { QueueReconciliationState } from './queue-reconciliation'
import { historicalTimelineEvents, mergeAndSanitizeIncomingEvents } from './timeline-memory'
import { cronMailboxReplayFixture } from './test-fixtures/cron-mailbox-replay'
import { peerMailboxWakePagingFixture } from './test-fixtures/peer-mailbox-wake-paging'

const userIds = (events: Event[]) => projectTimeline(events, []).flatMap(row => row.kind === 'message' && row.role === 'user' ? row.events.map(event => event.id) : [])
const answers = (events: Event[]) => projectTimeline(events, []).filter(row => row.kind === 'message' && row.role === 'assistant').map(rowText)

for (const [label, fixture] of [['mixed cron/mailbox', cronMailboxReplayFixture()], ['paged mailbox', peerMailboxWakePagingFixture()]] as const) {
  test(`${label} keeps original work, exact mailbox read state, and identical genuine user input`, () => {
    assert.ok(userIds(fixture.beforeEvents).includes('mixed-102'), 'unproven provider text must stay visible')
    assert.deepEqual(userIds(fixture.afterEvents), ['mixed-106'])
    assert.deepEqual(answers(fixture.afterEvents), [fixture.wakeAnswer, fixture.humanAnswer])
    const rows = projectTimeline(fixture.afterEvents, [])
    const inbox = rows.filter(row => row.kind === 'system' && row.mailboxMessages)
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].seq, 4)
    if (inbox[0].kind === 'system') assert.equal(inbox[0].mailboxMessages?.[0].event.inbox_state, 'read')
    assert.equal(rows.filter(row => row.kind === 'job').length, label === 'mixed cron/mailbox' ? 1 : 0)
    assert.equal(rows.some(row => row.kind === 'progress' || row.kind === 'trace' && row.active), false)
  })

  test(`${label} corrections survive older-page overlap, stale replay, compaction and JSON hydration`, () => {
    const initialRows = projectTimeline(fixture.beforeEvents, [])
    const corrected = mergeEvents(fixture.beforeEvents, fixture.corrected)
    const rows = projectTimeline(corrected, [])
    assert.notEqual(reuseStableTimelineRows(initialRows, rows), initialRows)
    assert.equal(mergeEvents(corrected, fixture.staleEvents), corrected)
    assert.equal(reuseStableTimelineRows(rows, projectTimeline(corrected, [])), rows)
    const tail = fixture.afterEvents.filter(event => event.seq >= 102)
    const paged = mergeEvents(tail, fixture.afterEvents.filter(event => event.seq <= 103))
    assert.deepEqual(userIds(paged), ['mixed-106'])
    assert.deepEqual(answers(paged), [fixture.wakeAnswer, fixture.humanAnswer])
    const compact = historicalTimelineEvents(mergeAndSanitizeIncomingEvents([], corrected))
    for (const proof of fixture.corrected) assert.ok(compact.some(event => event.id === proof.id), 'repair tombstones survive trace compaction')
    const reopened = JSON.parse(JSON.stringify(compact)) as Event[]
    const afterStale = mergeEvents(reopened, mergeAndSanitizeIncomingEvents(reopened, fixture.staleEvents))
    assert.equal(afterStale, reopened)
    assert.deepEqual(userIds(afterStale), ['mixed-106'])
    assert.deepEqual(answers(afterStale), [fixture.wakeAnswer, fixture.humanAnswer])
  })
}

test('a silent partial-page boundary retains only its unmatched answer without borrowing earlier input', () => {
  const fixture = peerMailboxWakePagingFixture()
  const proof = fixture.corrected[0]
  const prior: Event = { ...fixture.genuine[0], id: 'prior-question', seq: 100, prompt: 'A distinct genuine question.' }
  const priorAnswer: Event = { ...fixture.genuine[1], type: 'assistant_text', id: 'prior-answer', seq: 101, text: 'Answer to prior question.', result_text: undefined }
  const answer: Event = { ...fixture.genuine[1], id: 'unmatched-fork-answer', seq: 103, result_text: 'Unmatched later answer.' }
  const partial = [prior, priorAnswer, proof, answer]
  assert.deepEqual(userIds(partial), ['prior-question'])
  assert.deepEqual(answers(partial), ['Answer to prior question.', 'Unmatched later answer.'])
  assert.deepEqual(projectTimeline([proof], []), [])
  assert.deepEqual(projectPresentableHistory([proof], []), [])
  assert.equal(projectPresentableHistory([{ ...proof, type: 'raw_event', metadata_only: undefined, provider_history_repair: undefined }], []), null)
  assert.deepEqual(answers([proof, answer]), ['Unmatched later answer.'])
})

test('import notifications, repairs and empty checkpoint prefixes cannot consume the live queue', () => {
  const fixture = cronMailboxReplayFixture()
  const queue: QueuedTurn[] = [{ queued_id: 'queued', prompt: 'Actual waiting user input', file_ids: [] }]
  const tracker = new QueueReconciliationState()
  const checkpoint: Event = { ...fixture.corrected[0], id: 'checkpoint', seq: 99, type: 'history_imported',
    provider_history_repair: undefined, message: 'Imported historical records.' }
  const terminal: Event = { ...checkpoint, id: 'terminal', seq: 105, type: 'turn_finished', result_text: '' }
  const batch = [checkpoint, ...fixture.corrected, terminal]
  for (const event of batch) {
    const packet = { ...event, queued_id: 'queued' }
    assert.equal(updateQueuedTurns(queue, packet), queue)
    assert.equal(tracker.observe(packet), true)
    assert.equal(tracker.revision, 0)
  }
  for (let length = 1; length <= batch.length; length += 1) assert.deepEqual(projectTimeline(batch.slice(0, length), []), [])
  tracker.observe({ ...terminal, type: 'turn_started', imported: false, run_id: 'native', queued_id: 'queued' })
  assert.equal(tracker.revision, 1, 'a real admission still invalidates reads')
})

test('source-proven runtime notices do not hide an unmatched continuation or literal user quotation', () => {
  const fixture = peerMailboxWakePagingFixture()
  for (const kind of ['subagent_notification', 'turn_aborted', 'provider_notice'] as const) {
    const proof: Event = { ...fixture.corrected[0], provider_history_repair: undefined, provider_user_authored: false,
      provider_runtime_context: kind, provider_origin: { ...fixture.corrected[0].provider_origin!, kind } }
    const answer: Event = { ...fixture.genuine[1], id: 'continuation', result_text: 'A distinct continuation.' }
    assert.deepEqual(answers([proof, answer]), ['A distinct continuation.'])
    const human = { ...proof, provider_user_authored: true, prompt: `<${kind}>A literal quotation</${kind}>` }
    assert.deepEqual(userIds([human, answer]), [human.id])
  }
})
