import assert from 'node:assert/strict'
import type { Event, Snapshot } from '../types'
import { projectTimeline } from './timeline'
import { importedCrossChatDelivery } from './imported-cross-chat-delivery'
import {
  HISTORY_TIMELINE_CHARACTER_BUDGET,
  HISTORY_WINDOW_EVENT_LIMIT,
  IN_MEMORY_SNAPSHOT_LIMIT,
  LIVE_TIMELINE_EVENT_LIMIT,
  TIMELINE_CHARACTER_BUDGET,
  boundHistoricalTimelineEvents,
  boundLiveTimelineEvents,
  historicalTimelineEvents,
  liveTimelineEventsWereTrimmed,
  mergeHistoryWithLiveSnapshot,
  sanitizeTimelineEvent,
  sanitizeTimelineFile,
  snapshotMapWith,
} from './timeline-memory'

const event = (seq: number, type = 'assistant_text', text = `event ${seq}`): Event => ({
  id: `event-${seq}`,
  session_id: 'chat',
  seq,
  type,
  ts: '2026-07-19T12:00:00Z',
  text,
})

const omittedTypes = [
  'raw_event', 'reasoning_summary', 'tool_started', 'tool_finished', 'process_started',
  'provider_session', 'cwd_fallback', 'history_imported', 'backend_changed', 'artifact_error',
  'session_created', 'idle_warning', 'code_diff', 'codex_thread_status',
]
const compact = historicalTimelineEvents([
  ...omittedTypes.map((type, index) => event(index + 1, type)),
  event(100, 'turn_started'),
  event(101, 'assistant_text'),
  event(102, 'turn_finished'),
  event(103, 'artifact_created'),
  event(104, 'job_finished'),
  event(105, 'error'),
])
assert.equal(compact.map(value => value.type).join(','), [
  'turn_started', 'assistant_text', 'turn_finished', 'artifact_created', 'job_finished', 'error',
].join(','))

const linkedCommentary = event(20, 'reasoning_summary', 'Public progress')
linkedCommentary.phase = 'commentary'
linkedCommentary.run_id = 'run-linked'
const privateAnalysis = event(21, 'reasoning_summary', 'Private analysis')
privateAnalysis.phase = 'analysis'
privateAnalysis.run_id = 'run-linked'
const unrelatedCommentary = event(22, 'reasoning_summary', 'Unrelated progress')
unrelatedCommentary.phase = 'commentary'
unrelatedCommentary.run_id = 'run-unrelated'
const emptyCommentary = event(23, 'reasoning_summary', '   ')
emptyCommentary.phase = 'commentary'
emptyCommentary.run_id = 'run-linked'
const postSuccessorCommentary = event(31, 'reasoning_summary', 'Too late')
postSuccessorCommentary.phase = 'commentary'
postSuccessorCommentary.run_id = 'run-linked'
const successor = event(30, 'turn_started')
successor.run_id = 'run-successor'
successor.steer_interrupted_run_id = 'run-linked'
const contextFiltered = historicalTimelineEvents([
  linkedCommentary,
  privateAnalysis,
  unrelatedCommentary,
  emptyCommentary,
  postSuccessorCommentary,
  event(24, 'tool_finished'),
], [successor])
assert.equal(
  JSON.stringify(contextFiltered.map(value => value.id)),
  JSON.stringify([linkedCommentary.id]),
  'history should retain only nonempty commentary explicitly linked to a later native steer',
)

const samePageCommentary = event(40, 'reasoning_summary', 'Same-page progress')
samePageCommentary.phase = 'commentary'
samePageCommentary.run_id = 'run-same-page'
const samePageSuccessor = event(41, 'turn_started')
samePageSuccessor.steer_interrupted_run_id = 'run-same-page'
assert.equal(
  JSON.stringify(historicalTimelineEvents([samePageCommentary, samePageSuccessor]).map(value => value.id)),
  JSON.stringify([samePageCommentary.id, samePageSuccessor.id]),
  'history should resolve linked commentary when the successor is in the same page',
)

const completedTraceStart = event(50, 'turn_started', 'Completed prompt')
completedTraceStart.run_id = 'run-completed'
const completedThought = event(51, 'reasoning_summary', 'Completed reasoning')
completedThought.run_id = 'run-completed'
const completedDiff = event(52, 'code_diff', 'Completed diff')
completedDiff.run_id = 'run-completed'
const completedTool = event(53, 'tool_finished', 'Completed tool')
completedTool.run_id = 'run-completed'
completedTool.tool = { name: 'shell' }
const completedProviderSession = event(54, 'provider_session', '')
completedProviderSession.run_id = 'run-completed'
const completedAnswer = event(55, 'turn_finished', 'Completed answer')
completedAnswer.run_id = 'run-completed'
completedAnswer.result_text = 'Completed answer'
const completedHistory = historicalTimelineEvents([
  completedTraceStart,
  completedThought,
  completedDiff,
  completedTool,
  completedProviderSession,
  completedAnswer,
])
assert.equal(
  JSON.stringify(completedHistory.map(value => value.id)),
  JSON.stringify([completedTraceStart.id, completedDiff.id, completedTool.id, completedAnswer.id]),
  'completed history must retain its reviewable diff and one renderable lazy trace anchor',
)
assert(
  projectTimeline(completedHistory, []).some(row => row.kind === 'trace' && row.runId === 'run-completed'),
  'the retained trace anchor must keep completed reasoning discoverable after paging',
)

const huge = event(1, 'tool_finished', 'x'.repeat(100_000))
huge.output = 'o'.repeat(100_000)
huge.raw = 'r'.repeat(100_000)
huge.request_prompt = 'q'.repeat(100_000)
huge.display_prompt = 'd'.repeat(100_000)
huge.handoff_preview = 'h'.repeat(100_000)
huge.source_title = 's'.repeat(100_000)
huge.target_title = 't'.repeat(100_000)
huge.requester_title = 'q'.repeat(100_000)
huge.responder_title = 'r'.repeat(100_000)
huge.tool = { name: 'shell', input: { payload: 'i'.repeat(100_000) } }
const sanitized = sanitizeTimelineEvent(huge)
assert.equal(huge.output?.length, 100_000, 'sanitizing must not mutate the server event')
assert((sanitized.text?.length ?? 0) <= 48_000)
assert((sanitized.request_prompt?.length ?? 0) <= 48_000)
assert((sanitized.display_prompt?.length ?? 0) <= 48_000)
assert((sanitized.handoff_preview?.length ?? 0) <= 48_000)
assert((sanitized.source_title?.length ?? 0) <= 1_000)
assert((sanitized.target_title?.length ?? 0) <= 1_000)
assert((sanitized.requester_title?.length ?? 0) <= 1_000)
assert((sanitized.responder_title?.length ?? 0) <= 1_000)
assert((sanitized.output?.length ?? 0) <= 8_000)
assert.equal(sanitized.raw, undefined)
assert.equal(typeof sanitized.tool?.input, 'string')
assert(JSON.stringify(sanitized.tool?.input).length <= 8_100)

const generatedAuthority = [
  '[AgentsDock provider authority]',
  'authority-file=/Users/example/.agentsdock/cross_chat_authority/run_a39d8f33ad864075-732f636e8745bb38.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)',
  'actions=cross_chat_instruction,team_send',
  'usage: see AgentsDock instructions',
  '[End AgentsDock provider authority]',
].join('\n')
const nearLimitPrompt = `${'p'.repeat(47_800)}\n\n${generatedAuthority}`
assert(nearLimitPrompt.length > 48_000, 'authority truncation fixture must cross the mobile message limit')
const sanitizedAuthorityEvent = sanitizeTimelineEvent({
  ...event(20, 'turn_started'),
  prompt: nearLimitPrompt,
})
assert.equal(
  sanitizedAuthorityEvent.prompt,
  'p'.repeat(47_800),
  'provider authority must be removed before prompt truncation can cut its end marker',
)
const interactionEvent = event(2, 'codex_interaction_requested')
interactionEvent.interaction = {
  id: 'interaction-1',
  session_id: 'chat',
  thread_id: 'thread-1',
  method: 'item/tool/requestUserInput',
  params: { prompt: 'p'.repeat(100_000), options: ['Allow', 'Deny'] },
  created_at: '2026-07-19T12:00:00Z',
}
const sanitizedInteraction = sanitizeTimelineEvent(interactionEvent)
assert.equal(
  String(interactionEvent.interaction.params.prompt).length,
  100_000,
  'interaction sanitizing must not mutate the server event',
)
assert.notEqual(sanitizedInteraction.interaction, interactionEvent.interaction)
assert(
  JSON.stringify(sanitizedInteraction.interaction?.params).length <= 8_000,
  'interaction parameters must stay within the trace payload limit',
)
assert(
  sanitizedInteraction.interaction?.params._mobile_truncated != null,
  'oversized interaction parameters must carry an explicit truncation marker',
)

const compactJob = event(2, 'job_created')
compactJob.job = {
  id: 'job-with-redacted-prompt',
  session_id: 'chat',
  title: 'Data Repeater',
  interval_seconds: 300,
} as NonNullable<Event['job']>
const sanitizedCompactJob = sanitizeTimelineEvent(compactJob)
assert.equal(sanitizedCompactJob.job?.prompt, '', 'compact job events may omit their private prompt')
const [compactJobRow] = projectTimeline([sanitizedCompactJob], [])
assert.equal(compactJobRow?.kind, 'job')
assert.equal(compactJobRow?.kind === 'job' ? compactJobRow.title : null, 'Data Repeater')

const oversizedFile = { id: 'file', filename: 'large.txt', text: 'f'.repeat(100_000) }
const sanitizedFile = sanitizeTimelineFile(oversizedFile)
assert.equal(oversizedFile.text.length, 100_000, 'file sanitizing must not mutate the server payload')
assert((sanitizedFile?.text?.length ?? 0) <= 12_000)

const many = Array.from({ length: LIVE_TIMELINE_EVENT_LIMIT + 10 }, (_, index) => event(index + 1))
const live = boundLiveTimelineEvents(many)
assert.equal(live.length, LIVE_TIMELINE_EVENT_LIMIT)
assert.equal(live[0]?.seq, 11)
assert.equal(live.at(-1)?.seq, LIVE_TIMELINE_EVENT_LIMIT + 10)

const compactStatuses = boundLiveTimelineEvents([
  event(1, 'assistant_text', 'Visible before status changes'),
  event(2, 'codex_thread_status', 'Codex is working.'),
  event(3, 'codex_thread_status', 'Codex is idle.'),
  event(4, 'assistant_text', 'Visible after status changes'),
])
assert(
  compactStatuses.map(value => `${value.seq}:${value.type}`).join(',') === [
    '1:assistant_text',
    '3:codex_thread_status',
    '4:assistant_text',
  ].join(','),
  'the live tail should retain only the newest runtime-refresh status signal',
)
const statusOnlySource = [
  event(1, 'codex_thread_status'),
  event(2, 'codex_thread_status'),
]
assert(
  !liveTimelineEventsWereTrimmed(statusOnlySource, boundLiveTimelineEvents(statusOnlySource)),
  'coalescing superseded status signals must not imply that older messages are available',
)
assert(
  liveTimelineEventsWereTrimmed(many, live),
  'event-limit eviction should still mark the live tail as genuinely trimmed',
)

const historical = boundHistoricalTimelineEvents(Array.from(
  { length: HISTORY_WINDOW_EVENT_LIMIT + 10 },
  (_, index) => event(index + 1),
))
assert.equal(historical.length, HISTORY_WINDOW_EVENT_LIMIT)
assert.equal(historical[0]?.seq, 11)
assert.equal(historical.at(-1)?.seq, HISTORY_WINDOW_EVENT_LIMIT + 10)

const costly = Array.from({ length: 500 }, (_, index) => event(index + 1, 'assistant_text', 'x'.repeat(48_000)))
const budgeted = boundLiveTimelineEvents(costly)
assert(budgeted.length < costly.length)
assert(budgeted.reduce((sum, value) => sum + (value.text?.length ?? 0), 0) <= TIMELINE_CHARACTER_BUDGET)

const costlyHandoffPreviews = Array.from({ length: 500 }, (_, index) => ({
  ...event(index + 1, 'cross_chat_handoff_queued', ''),
  handoff_id: `handoff-${index}`,
  handoff_preview: 'h'.repeat(48_000),
}))
const budgetedHandoffPreviews = boundLiveTimelineEvents(costlyHandoffPreviews)
assert(budgetedHandoffPreviews.length < costlyHandoffPreviews.length, 'cross-chat previews must participate in the live character budget')
assert(
  budgetedHandoffPreviews.reduce((sum, value) => sum + (value.handoff_preview?.length ?? 0), 0) <= TIMELINE_CHARACTER_BUDGET,
  'bounded cross-chat previews must stay within the live character budget',
)

const costlyCrossChatTitles = Array.from({ length: 500 }, (_, index) => ({
  ...event(index + 1, 'cross_chat_exchange_registered', ''),
  exchange_id: `exchange-title-${index}`,
  source_title: 's'.repeat(48_000),
  target_title: 't'.repeat(48_000),
  requester_title: 'q'.repeat(48_000),
  responder_title: 'r'.repeat(48_000),
}))
assert(
  boundLiveTimelineEvents(costlyCrossChatTitles).length < costlyCrossChatTitles.length,
  'duplicated cross-chat title snapshots must participate in the live character budget',
)

let serializedPayloadReads = 0
const cachedCostEvent = event(10_000, 'tool_finished')
cachedCostEvent.tool = {
  name: 'shell',
  input: Object.defineProperty({}, 'payload', {
    enumerable: true,
    get() {
      serializedPayloadReads += 1
      return 'stable payload'
    },
  }),
}
boundLiveTimelineEvents([cachedCostEvent])
boundLiveTimelineEvents([cachedCostEvent])
assert.equal(serializedPayloadReads, 1, 'immutable event payload cost should be serialized only once')

const costlyHistory = boundHistoricalTimelineEvents(Array.from(
  { length: 500 },
  (_, index) => event(index + 1, 'assistant_text', 'x'.repeat(48_000)),
))
assert(costlyHistory.length < 500, 'history should enforce its independent character budget')
assert.equal(costlyHistory.at(-1)?.seq, 500, 'history character eviction must retain the current tail')
assert(
  costlyHistory.reduce((sum, value) => sum + (value.text?.length ?? 0), 0)
    <= HISTORY_TIMELINE_CHARACTER_BUDGET,
)

const costlyInteractions = Array.from({ length: 100 }, (_, index) => {
  const value = event(index + 1, 'codex_interaction_requested')
  value.interaction = {
    id: `interaction-${index}`,
    session_id: 'chat',
    thread_id: 'thread-1',
    method: 'item/tool/requestUserInput',
    params: { prompt: 'p'.repeat(100_000) },
    created_at: '2026-07-19T12:00:00Z',
  }
  return value
})
assert(
  boundLiveTimelineEvents(costlyInteractions).length < costlyInteractions.length,
  'interaction parameter text must count against the live timeline character budget',
)

const snapshot = (id: string, cachedAt: number): Snapshot => ({
  cacheVersion: 3,
  session: { id, title: id, backend: 'codex' },
  events: [], queuedTurns: [], files: [], filesTotal: 0, hasMore: false, latestSeq: 0, cachedAt,
})

const historySnapshot: Snapshot = {
  ...snapshot('chat', 100),
  cacheVersion: 7,
  session: { id: 'chat', title: 'History title', backend: 'codex' },
  events: [
    event(1, 'assistant_text', 'oldest'),
    event(2, 'assistant_text', 'stale shared event'),
  ],
  files: [
    { id: 'old-file', session_id: 'chat', filename: 'old.txt', seq: 1 },
    { id: 'shared-file', session_id: 'chat', filename: 'old-name.txt', seq: 2 },
  ],
  filesTotal: 2,
  hasMore: true,
  total: 999,
  latestSeq: 2,
  nextBefore: 1,
  semanticPaging: true,
}
const liveSharedEvent = { ...event(2, 'assistant_text', 'updated shared event') }
const liveNewestEvent = event(3, 'assistant_text', 'current bottom')
const liveSnapshot: Snapshot = {
  ...snapshot('chat', 200),
  session: { id: 'chat', title: 'Live title', backend: 'codex', latest_event_seq: 3 },
  events: [liveSharedEvent, liveNewestEvent],
  queuedTurns: [{
    queued_id: 'queued-live',
    session_id: 'chat',
    prompt: 'live queued prompt',
    file_ids: [],
  }],
  files: [
    { id: 'shared-file', session_id: 'chat', filename: 'updated-name.txt', seq: 2 },
    { id: 'new-file', session_id: 'chat', filename: 'new.txt', seq: 3 },
  ],
  filesTotal: 4,
  hasMore: false,
  total: 3,
  latestSeq: 3,
  nextBefore: null,
  semanticPaging: false,
}
const mergedSnapshot = mergeHistoryWithLiveSnapshot(historySnapshot, liveSnapshot)
assert.equal(mergedSnapshot.session, liveSnapshot.session, 'the displayed session metadata must be current')
assert.equal(mergedSnapshot.queuedTurns, liveSnapshot.queuedTurns, 'the displayed queue must be current')
assert.equal(JSON.stringify(mergedSnapshot.events.map(value => value.seq)), JSON.stringify([1, 2, 3]))
assert.equal(
  mergedSnapshot.events.find(value => value.id === liveSharedEvent.id)?.text,
  'updated shared event',
  'a current live event must replace its stale history copy',
)
assert.equal(mergedSnapshot.events.at(-1)?.text, 'current bottom')
assert.equal(
  JSON.stringify(mergedSnapshot.files.map(value => `${value.id}:${value.filename}`)),
  JSON.stringify(['old-file:old.txt', 'shared-file:updated-name.txt', 'new-file:new.txt']),
)
assert.equal(mergedSnapshot.filesTotal, 4)
assert.equal(mergedSnapshot.latestSeq, 3)
assert.equal(mergedSnapshot.cachedAt, 200)
assert.equal(mergedSnapshot.cacheVersion, 7)
assert.equal(mergedSnapshot.hasMore, true, 'history must retain ownership of older-page availability')
assert.equal(mergedSnapshot.total, 999, 'history must retain ownership of its paging total')
assert.equal(mergedSnapshot.nextBefore, 1, 'history must retain ownership of its older-page cursor')
assert.equal(mergedSnapshot.semanticPaging, true, 'history must retain ownership of its paging mode')

const coveredHistorySnapshot: Snapshot = {
  ...historySnapshot,
  events: [liveSharedEvent, liveNewestEvent],
  files: liveSnapshot.files,
  latestSeq: liveSnapshot.latestSeq,
}
const coveredTimeline = mergeHistoryWithLiveSnapshot(coveredHistorySnapshot, liveSnapshot)
assert.equal(coveredTimeline.events, coveredHistorySnapshot.events, 'an already-covered live tail must preserve history event identity for projection reuse')
assert.equal(coveredTimeline.files, coveredHistorySnapshot.files, 'already-covered live files must preserve history file identity for projection reuse')

const unrelatedLive = snapshot('other-chat', 300)
assert.equal(
  mergeHistoryWithLiveSnapshot(historySnapshot, unrelatedLive),
  historySnapshot,
  'a live snapshot from another session must never contaminate history',
)

let snapshots: Record<string, Snapshot> = {}
for (let index = 0; index < 10; index += 1) {
  snapshots = snapshotMapWith(snapshots, `chat-${index}`, snapshot(`chat-${index}`, index))
}
assert.equal(Object.keys(snapshots).length, IN_MEMORY_SNAPSHOT_LIMIT)
assert(snapshots['chat-9'])
assert(snapshots['chat-8'])

function importedEnvelope(source: string, body: string): Event {
  return {
    id: 'long-imported-delivery', session_id: 'chat', seq: 1, type: 'turn_started', ts: '2026-09-09T12:00:00Z',
    backend: 'claude', imported: true, run_id: 'import_long',
    prompt: '[AgentsDock delivery kind=reply leg=2/2 origin=route from=Peer]\n'
      + `[Source user instruction — verbatim, user-authored]\n${source}\n[End source user instruction]\n`
      + `[Agent-prepared reply/result]\n${body}\n[End agent-prepared reply/result]\n`
      + 'reply: use Chats respond-current through the AgentsDock provider tool only if a reply or follow-up is needed.\n[End delivery]',
  }
}

const largeImported = importedEnvelope(`Source opening. ${'s'.repeat(65_000)} Source ending.`, `Result opening. ${'b'.repeat(65_000)} Result ending.`)
const boundedImported = sanitizeTimelineEvent(largeImported)
assert((boundedImported.prompt?.length ?? 0) <= 48_000, 'the complete persisted delivery must fit the ordinary prompt budget')
assert((largeImported.prompt?.length ?? 0) > 120_000, 'bounding must not mutate the server envelope')
const parsedBoundedImported = importedCrossChatDelivery(boundedImported)
assert(parsedBoundedImported, 'sanitize must preserve enough verified structure to render a large imported delivery')
assert(parsedBoundedImported.sourceRequest.startsWith('Source opening.'))
assert(parsedBoundedImported.body.startsWith('Result opening.'))
assert(parsedBoundedImported.sourceRequest.endsWith('[Content truncated on mobile.]'))
assert(parsedBoundedImported.body.endsWith('[Content truncated on mobile.]'))
assert(parsedBoundedImported.body.length > parsedBoundedImported.sourceRequest.length, 'retain more of the prepared answer when both sections exceed the budget')
assert(!parsedBoundedImported.body.includes('[Source user instruction'), 'the body must never fall back to the source wrapper')
const restoredImported = sanitizeTimelineEvent(JSON.parse(JSON.stringify(boundedImported)) as Event)
assert.equal(restoredImported.prompt, boundedImported.prompt, 'cached delivery bounding must be idempotent across JSON persistence')
assert.deepEqual(importedCrossChatDelivery(restoredImported), parsedBoundedImported)
const boundedImportedRows = projectTimeline([restoredImported, {
  ...event(2, 'assistant_text', 'The following answer is retained.'), run_id: 'import_long',
}], [])
assert.equal(boundedImportedRows[0].kind, 'system')
assert.equal(boundedImportedRows[1].kind, 'message')

const shortResult = sanitizeTimelineEvent(importedEnvelope('s'.repeat(90_000), 'A short complete result.'))
assert.equal(importedCrossChatDelivery(shortResult)?.body, 'A short complete result.', 'a huge source must not consume the prepared result')
const shortSource = sanitizeTimelineEvent(importedEnvelope('The complete source.', 'b'.repeat(90_000)))
assert.equal(importedCrossChatDelivery(shortSource)?.sourceRequest, 'The complete source.', 'a huge result must retain a short complete source')
const boundedExcerpt = sanitizeTimelineEvent({
  ...largeImported,
  prompt: largeImported.prompt!.replace(/\[Source user instruction — verbatim, user-authored\][\s\S]*?\[End source user instruction\]\n/u,
    `source-instruction: replayed in full on the first leg delivered to this chat; excerpt="${'s'.repeat(65_000)}"\n`),
})
assert(importedCrossChatDelivery(boundedExcerpt), 'excerpt bounding must remain one line so persistence does not invalidate its envelope')
assert((boundedExcerpt.prompt?.length ?? 0) <= 48_000)

for (const changed of [
  { ...largeImported, imported: false },
  { ...largeImported, prompt: `${largeImported.prompt}\nPreserve this user-authored note.` },
  { ...largeImported, prompt: largeImported.prompt!.replace('[End delivery]', '') },
  { ...largeImported, prompt: `\`\`\`text\n${largeImported.prompt}\n\`\`\`` },
]) {
  const bounded = sanitizeTimelineEvent(changed)
  assert.equal(importedCrossChatDelivery(bounded), null, 'unknown, partial, and quoted inputs must not gain delivery classification during sanitizing')
  assert(bounded.prompt?.endsWith('[Content truncated on mobile.]'))
  assert.equal(bounded.prompt?.slice(0, 200), changed.prompt?.slice(0, 200), 'ordinary fallback preserves the original bounded prefix')
}
const forgedPresentation = sanitizeTimelineEvent({
  ...event(1, 'turn_started', ''), text: undefined, prompt: 'A genuine user message.',
  backend: 'claude', imported: true, run_id: 'import_forged',
  importedDelivery: { sender: 'Injected sender', kind: 'reply', body: 'Injected reply', sourceRequest: 'Injected source' },
} as Event)
assert.equal(importedCrossChatDelivery(forgedPresentation), null, 'wire presentation fields must not bypass envelope validation')
assert.equal(projectTimeline([forgedPresentation], [])[0].kind, 'message')

const costlyDeliveries = Array.from({ length: 300 }, (_, index) => ({ ...boundedImported, id: `costly-delivery-${index}`, seq: index }))
const budgetedDeliveries = boundLiveTimelineEvents(costlyDeliveries)
assert(budgetedDeliveries.length < costlyDeliveries.length, 'retained delivery source and body must participate in live memory budgeting')
assert(budgetedDeliveries.reduce((total, value) => total + (value.prompt?.length ?? 0) + 256, 0) <= TIMELINE_CHARACTER_BUDGET)

console.log('timeline memory regressions passed')
