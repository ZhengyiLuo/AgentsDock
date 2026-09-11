import assert from 'node:assert/strict'
import type { AgentFile, Event } from '../types'
import { projectTimeline, type TimelineRow } from './timeline'
import { reuseStableTimelineRows, sameTimelineRow } from './timeline-row-reuse'

const event = (id: string, seq: number): Event => ({
  id,
  seq,
  session_id: 'session',
  type: 'assistant_text',
  ts: '2026-07-26T00:00:00Z',
  text: id,
})
const file = (id: string, seq: number): AgentFile => ({
  id,
  seq,
  filename: `${id}.png`,
})

const first = event('first', 1)
const second = event('second', 2)
const poster = file('poster', 3)
const previous: TimelineRow[] = [
  { kind: 'message', key: 'message:first', seq: 1, role: 'assistant', events: [first], files: [] },
  { kind: 'media', key: 'media:poster', seq: 3, files: [poster] },
]
const appended: TimelineRow[] = [
  { kind: 'message', key: 'message:first', seq: 1, role: 'assistant', events: [first], files: [] },
  { kind: 'media', key: 'media:poster', seq: 3, files: [poster] },
  { kind: 'message', key: 'message:second', seq: 2, role: 'assistant', events: [second], files: [] },
]
const stable = reuseStableTimelineRows(previous, appended)
assert.equal(stable[0], previous[0], 'unchanged message rows must retain their object identity')
assert.equal(stable[1], previous[1], 'unchanged media rows must retain their object identity')
assert.equal(stable[2], appended[2], 'new rows must remain new')

const replacement = { ...first, text: 'updated' }
const previousMessage = previous[0] as Extract<TimelineRow, { kind: 'message' }>
assert.equal(
  sameTimelineRow(previousMessage, { ...previousMessage, events: [replacement] }),
  false,
  'same-ID event replacements with changed content must invalidate the row',
)

const prepended = reuseStableTimelineRows(previous, [
  { kind: 'message', key: 'message:older', seq: 0, role: 'user', events: [event('older', 0)], files: [] },
  { kind: 'message', key: 'message:first', seq: 1, role: 'assistant', events: [first], files: [] },
  { kind: 'media', key: 'media:poster', seq: 3, files: [poster] },
])
assert.equal(prepended[1], previous[0], 'prepending history must reuse existing message rows')
assert.equal(prepended[2], previous[1], 'prepending history must reuse existing media rows')

const commentary = {
  ...event('commentary', 4),
  type: 'reasoning_summary',
  phase: 'commentary',
}
const activeTrace: TimelineRow = {
  kind: 'trace',
  key: 'trace:active',
  seq: 4,
  events: [commentary],
  promotedCommentaryIds: [],
  runId: 'run-active',
  active: true,
}
assert.equal(
  sameTimelineRow(activeTrace, { ...activeTrace, active: false }),
  false,
  'trace rows must invalidate when active commentary becomes complete',
)
assert.equal(
  sameTimelineRow({ ...activeTrace, active: false, runActive: true }, { ...activeTrace, active: false, runActive: false }),
  false,
  'an earlier trace segment must invalidate when its owning live commentary finishes',
)
assert.equal(
  sameTimelineRow(activeTrace, { ...activeTrace, promotedCommentaryIds: ['commentary'] }),
  false,
  'trace rows must invalidate when commentary is promoted out of the trace',
)

const progress: TimelineRow = {
  kind: 'progress',
  key: 'progress:active',
  seq: commentary.seq,
  events: [commentary],
  hiddenCount: 0,
}
assert.equal(
  sameTimelineRow(progress, { ...progress }),
  true,
  'unchanged live progress should retain its recycled row',
)
assert.equal(
  sameTimelineRow(progress, { ...progress, events: [{ ...commentary, text: 'New activity' }] }),
  false,
  'live progress must invalidate when its event content changes',
)
assert.equal(
  sameTimelineRow(progress, { ...progress, hiddenCount: 1 }),
  false,
  'live progress must invalidate when its hidden-update count changes',
)

const terminalExchangeEvents = [
  {
    ...event('cross-chat-leg', 5),
    type: 'cross_chat_exchange_leg_delivered',
    exchange_id: 'exchange-stable',
    exchange_leg_id: 'leg-stable',
    exchange_status: 'active' as const,
    exchange_leg_status: 'delivered' as const,
  },
  {
    ...event('cross-chat-terminal', 6),
    type: 'cross_chat_exchange_completed',
    exchange_id: 'exchange-stable',
    exchange_status: 'completed' as const,
  },
]
const terminalExchangeFirst = projectTimeline(terminalExchangeEvents, [])
const terminalExchangeProjectedAgain = projectTimeline(terminalExchangeEvents, [])
assert.equal(
  terminalExchangeProjectedAgain.find(row => row.key === 'cross-chat-exchange:exchange-stable')?.event,
  terminalExchangeFirst.find(row => row.key === 'cross-chat-exchange:exchange-stable')?.event,
  'terminal normalization should cache its clone by immutable packet and status',
)
const terminalExchangeSecond = reuseStableTimelineRows(
  terminalExchangeFirst,
  terminalExchangeProjectedAgain,
)
assert.equal(
  terminalExchangeSecond.find(row => row.key === 'cross-chat-exchange:exchange-stable'),
  terminalExchangeFirst.find(row => row.key === 'cross-chat-exchange:exchange-stable'),
  'terminal-status normalization must not remount an unchanged conversation on every live append',
)

const largeCrossChatPreview = 'x'.repeat(48_000)
const crossChatSystemRow: TimelineRow = {
  kind: 'system',
  key: 'cross-chat:handoff:large-preview',
  seq: 7,
  event: { ...event('large-cross-chat', 7), type: 'cross_chat_handoff_queued', handoff_preview: largeCrossChatPreview },
}
assert.equal(
  sameTimelineRow(crossChatSystemRow, { ...crossChatSystemRow, event: { ...crossChatSystemRow.event } }),
  false,
  'cross-chat row reuse must not deep-compare large lifecycle previews',
)

const beforeTerminalAggregate = projectTimeline([
  {
    ...event('turn-start', 10),
    type: 'turn_started',
    run_id: 'run-final',
    prompt: 'Finish',
  },
  {
    ...event('assistant-stream', 11),
    type: 'assistant_text',
    run_id: 'run-final',
    text: 'Already streamed.',
  },
  {
    ...event('compaction', 12),
    type: 'codex_compaction_completed',
    operation_id: 'compact-final',
    message: 'Context compaction completed.',
  },
], [])
const beforeTerminalAssistant = beforeTerminalAggregate.find(row =>
  row.kind === 'message' && row.role === 'assistant'
)
const afterTerminalAggregate = reuseStableTimelineRows(beforeTerminalAggregate, projectTimeline([
  {
    ...event('turn-start', 10),
    type: 'turn_started',
    run_id: 'run-final',
    prompt: 'Finish',
  },
  {
    ...event('assistant-stream', 11),
    type: 'assistant_text',
    run_id: 'run-final',
    text: 'Already streamed.',
  },
  {
    ...event('compaction', 12),
    type: 'codex_compaction_completed',
    operation_id: 'compact-final',
    message: 'Context compaction completed.',
  },
  {
    ...event('turn-finished', 13),
    type: 'turn_finished',
    run_id: 'run-final',
    result_text: 'Already streamed.',
  },
], []))
const afterTerminalAssistant = afterTerminalAggregate.find(row =>
  row.kind === 'message' && row.role === 'assistant'
)
assert.equal(
  afterTerminalAssistant,
  beforeTerminalAssistant,
  'a duplicate terminal aggregate may move to the edge without replacing its unchanged assistant cell',
)
assert.equal(
  afterTerminalAggregate.at(-1),
  afterTerminalAssistant,
  'the stable assistant cell should become the physical edge after post-compaction completion',
)

const generatedVideo = file('generated-video', 22)
const mediaStart: Event = {
  ...event('media-turn-start', 20),
  type: 'turn_started',
  run_id: 'run-media-final',
  prompt: 'Render a video',
}
const mediaAssistant: Event = {
  ...event('media-assistant', 21),
  type: 'assistant_text',
  run_id: 'run-media-final',
  text: 'The render is ready.',
}
const mediaArtifact: Event = {
  ...event('media-artifact', 22),
  type: 'artifact_created',
  run_id: 'run-media-final',
  artifact: generatedVideo,
}
const mediaCompaction: Event = {
  ...event('media-compaction', 23),
  type: 'codex_compaction_completed',
  operation_id: 'media-final-compaction',
  message: 'Context compaction completed.',
}
const mediaFinished: Event = {
  ...event('media-finished', 24),
  type: 'turn_finished',
  run_id: 'run-media-final',
  result_text: 'The render is ready.',
}
const beforeMediaTerminal = projectTimeline([
  mediaStart,
  mediaAssistant,
  mediaArtifact,
  mediaCompaction,
], [generatedVideo])
const beforeMediaAssistant = beforeMediaTerminal.find(row => row.key === 'turn:run-media-final:assistant')
const beforeMediaRow = beforeMediaTerminal.find(row => row.key === 'turn:run-media-final:media')
const afterMediaTerminal = reuseStableTimelineRows(beforeMediaTerminal, projectTimeline([
  mediaStart,
  mediaAssistant,
  mediaArtifact,
  mediaCompaction,
  mediaFinished,
], [generatedVideo]))
const afterMediaAssistantIndex = afterMediaTerminal.findIndex(row => row.key === 'turn:run-media-final:assistant')
const afterMediaRowIndex = afterMediaTerminal.findIndex(row => row.key === 'turn:run-media-final:media')
assert.equal(
  afterMediaTerminal[afterMediaAssistantIndex],
  beforeMediaAssistant,
  'terminal relocation must reuse the unchanged assistant cell',
)
assert.equal(
  afterMediaTerminal[afterMediaRowIndex],
  beforeMediaRow,
  'terminal relocation must reuse the unchanged media cell',
)
assert.equal(
  afterMediaRowIndex,
  afterMediaAssistantIndex + 1,
  'terminal relocation must keep generated media immediately after its assistant answer',
)

const olderSystem: Event = {
  ...event('older-system', 1),
  type: 'error',
  message: 'An older retained event.',
}
const prependedMediaTerminal = reuseStableTimelineRows(afterMediaTerminal, projectTimeline([
  olderSystem,
  mediaStart,
  mediaAssistant,
  mediaArtifact,
  mediaCompaction,
  mediaFinished,
], [generatedVideo]))
assert.equal(
  prependedMediaTerminal.find(row => row.key === 'turn:run-media-final:assistant'),
  afterMediaTerminal[afterMediaAssistantIndex],
  'prepending history must preserve the relocated assistant cell identity',
)
assert.equal(
  prependedMediaTerminal.find(row => row.key === 'turn:run-media-final:media'),
  afterMediaTerminal[afterMediaRowIndex],
  'prepending history must preserve the relocated media cell identity',
)

console.log('timeline row reuse tests passed')
