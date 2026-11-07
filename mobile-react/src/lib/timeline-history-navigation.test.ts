import assert from 'node:assert/strict'
import type { AgentFile, Event } from '../types'
import type { TimelineRow } from './timeline'
import { projectTimeline, rowText } from './timeline'
import { reuseStableTimelineRows } from './timeline-row-reuse'
import {
  LIVE_TIMELINE_MAINTAIN_VISIBLE_POSITION,
  SEARCH_TIMELINE_MAINTAIN_VISIBLE_POSITION,
  liveTimelineAdvanced,
  shouldShowInitialTimelineLoading,
  shouldShowTimelineLatest,
  timelineMaintainVisiblePosition,
  timelineRowSequenceRange,
  timelineTargetIsRepresented,
  timelineTargetRowIndex,
} from './timeline-history-navigation'

const event = (id: string, seq: number): Event => ({
  id,
  seq,
  session_id: 'chat',
  type: 'reasoning_summary',
  ts: '2026-07-31T00:00:00Z',
  text: id,
})

const trace: TimelineRow = {
  kind: 'trace',
  key: 'turn:run:trace',
  seq: 100,
  events: [event('trace-start', 100), event('trace-match', 112), event('trace-end', 118)],
  promotedCommentaryIds: [],
  runId: 'run',
  active: false,
}
const answer: TimelineRow = {
  kind: 'message',
  key: 'turn:run:assistant',
  seq: 120,
  role: 'assistant',
  events: [event('answer', 120)],
  files: [],
}
const file: AgentFile = { id: 'file-match', filename: 'result.png', seq: 130 }
const media: TimelineRow = { kind: 'media', key: 'turn:run:media', seq: 130, files: [file] }
const rows = [trace, answer, media]

const streamedAnswer = { ...event('streamed-answer', 11), type: 'assistant_text', run_id: 'same-answer', text: 'FIXED READY' }
const finishedAnswer = { ...event('finished-answer', 13), type: 'turn_finished', run_id: 'same-answer', result_text: 'FIXED READY', text: undefined }
const streamedRows = projectTimeline([streamedAnswer], [])
const finishedRows = projectTimeline([streamedAnswer, finishedAnswer], [])
assert.equal(finishedRows.filter(row => row.kind === 'message').length, 1)
assert.equal(rowText(finishedRows[0]), 'FIXED READY', 'search metadata must not duplicate visible content')
assert.equal(finishedRows[0].seq, streamedRows[0].seq, 'completion must not move the streamed anchor')
assert.equal(timelineTargetIsRepresented(finishedRows, { eventId: finishedAnswer.id, seq: finishedAnswer.seq }), true,
  'a deduplicated terminal answer still represents its exact search result')
assert.equal(timelineTargetIsRepresented(reuseStableTimelineRows(streamedRows, finishedRows), { eventId: finishedAnswer.id, seq: finishedAnswer.seq }), true,
  'row reuse must retain newly learned search identities')
assert.equal(timelineTargetIsRepresented(finishedRows, { eventId: 'unrelated-gap', seq: 12 }), false,
  'an alias must not widen sequence containment to unrelated omitted events')

assert.deepEqual(timelineRowSequenceRange(trace), [100, 118])
assert.equal(timelineTargetRowIndex(rows, { eventId: 'trace-match', seq: 112 }), 0, 'exact event identity should win')
assert.equal(timelineTargetRowIndex(rows, { eventId: 'compacted-away', seq: 115 }), 0, 'semantic sequence range should find a compacted event')
assert.equal(timelineTargetRowIndex(rows, { eventId: 'file-match', seq: 130 }), 2, 'media identity should be searchable')
assert.equal(timelineTargetRowIndex(rows, { eventId: 'missing', seq: 119 }), 1, 'a compact semantic gap should choose the next row')
assert.equal(timelineTargetRowIndex(rows, { eventId: 'missing', seq: 999 }), 2, 'an end anchor should fall back to the final row')
assert.equal(timelineTargetRowIndex([], { eventId: 'missing', seq: 1 }), -1)
assert.equal(timelineTargetIsRepresented(rows, { eventId: 'compacted-away', seq: 115 }), true)
assert.equal(timelineTargetIsRepresented(rows, { eventId: 'missing', seq: 119 }), false, 'a nearby row is not proof that the search hit loaded')

const job: TimelineRow = {
  kind: 'job',
  key: 'job:scheduled',
  seq: 90,
  title: 'Scheduled report',
  events: [event('job-old', 90), event('job-new', 150)],
}
assert.equal(
  timelineTargetIsRepresented([job], { eventId: 'omitted-job-run', seq: 120 }),
  false,
  'an aggregated job range must not claim an omitted run was loaded',
)
assert.equal(timelineTargetIsRepresented([job], { eventId: 'compacted-job-packet', seq: 150 }), true)

const crossChatLifecycle: TimelineRow = {
  kind: 'system',
  key: 'cross-chat:handoff:handoff-search',
  seq: 160,
  event: { ...event('handoff-delivered', 170), type: 'cross_chat_handoff_delivered' },
  representedEventIds: ['handoff-registered', 'handoff-queued', 'handoff-delivered'],
  representedEventSeqs: [160, 165, 170],
}
assert.equal(
  timelineTargetIsRepresented([crossChatLifecycle], { eventId: 'handoff-queued', seq: 165 }),
  true,
  'a semantically folded cross-chat card must retain intermediate lifecycle search identity',
)

assert.equal(shouldShowTimelineLatest(3, true, true), true, 'detached history must expose an escape at its local bottom')
assert.equal(shouldShowTimelineLatest(3, true, false), false)
assert.equal(shouldShowTimelineLatest(3, false, false), true)
assert.equal(shouldShowTimelineLatest(0, false, true), false)

assert.equal(shouldShowInitialTimelineLoading({ rowCount: 0, loading: false, hasKnownHistory: true, syncStatus: 'cached' }), true, 'an empty stale cache for a known non-empty chat should keep showing a loading state')
assert.equal(shouldShowInitialTimelineLoading({ rowCount: 0, loading: false, hasKnownHistory: false, syncStatus: 'cached' }), false, 'a genuinely empty new chat should not show a spinner')
assert.equal(shouldShowInitialTimelineLoading({ rowCount: 0, loading: false, hasKnownHistory: false, syncStatus: 'syncing' }), true, 'an uncached selection should show sync progress')
assert.equal(shouldShowInitialTimelineLoading({ rowCount: 2, loading: false, hasKnownHistory: true, syncStatus: 'syncing' }), false, 'cached visible messages should remain on screen while refreshing')
assert.equal(shouldShowInitialTimelineLoading({ rowCount: 0, loading: false, hasKnownHistory: true, syncStatus: 'live' }), false, 'a completed sync should not leave an empty chat spinner')

assert.equal(liveTimelineAdvanced(200, 200), false, 'publishing older rows must not trigger live-edge following')
assert.equal(liveTimelineAdvanced(200, 201), true)

assert.equal(
  timelineMaintainVisiblePosition(false),
  LIVE_TIMELINE_MAINTAIN_VISIBLE_POSITION,
  'live chats should continue rendering and anchoring from the bottom',
)
assert.equal(
  timelineMaintainVisiblePosition(true),
  SEARCH_TIMELINE_MAINTAIN_VISIBLE_POSITION,
  'detached search windows must not let bottom anchoring displace the selected result',
)

console.log('timeline history navigation tests passed')
