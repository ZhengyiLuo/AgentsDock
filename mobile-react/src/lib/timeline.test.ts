import type { AgentFile, Event } from '../types'
import { messageText } from './format'
import {
  ACTIVE_TRACE_PROGRESS_CHARACTER_LIMIT,
  ACTIVE_TRACE_PROGRESS_LINE_LIMIT,
  ACTIVE_TRACE_PROGRESS_VISIBLE_LIMIT,
  activeTraceProgress,
  activeTraceProgressEvents,
  activeTraceProgressPreview,
  codexLifecycleSemanticKey,
  crossChatSemanticKey,
  isTimelineError,
  jobDisplayEvents,
  jobDisplaySelection,
  jobResultPresentation,
  jobRunCount,
  jobRunIdentity,
  jobRunStatus,
  latestJobDisplayEvent,
  latestJobStatusEvent,
  mergeJobHistoryEvents,
  providerInteractionAuditSummary,
  projectPresentableHistory,
  projectTimeline,
  rowText,
} from './timeline'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function event(seq: number, type: string, extra: Partial<Event> = {}): Event {
  return {
    id: `event-${seq}`,
    seq,
    session_id: 'chat-1',
    type,
    ts: `2026-07-16T00:00:0${seq}Z`,
    ...extra,
  }
}

const rows = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-job-1', prompt: 'Check training status' }),
  event(2, 'job_ran', {
    run_id: 'run-job-1',
    job_id: 'job-1',
    job: { id: 'job-1', session_id: 'chat-1', title: 'Training status', prompt: 'Check training status', interval_seconds: 3600 },
  }),
  event(3, 'assistant_text', { run_id: 'run-job-1', text: 'Training is healthy.' }),
  event(4, 'turn_finished', { run_id: 'run-job-1', result_text: 'Training is healthy.' }),
], [])

assert(
  projectPresentableHistory([event(0, 'raw_event', { raw: '{"transport":"only"}' })], []) === null,
  'transport-only history must not be allowed to cover a displayable live timeline',
)
assert(
  projectPresentableHistory([event(0, 'assistant_text', { text: 'Older visible reply' })], [])?.length === 1,
  'displayable older messages must remain eligible for history browsing',
)
const serverBookkeepingTypes = [
  'turn_queue_updated',
  'turn_queue_reordered',
  'turn_queue_paused',
  'turn_queue_delivery_fenced',
  'subagent_state',
  'job_updated',
  'job_deleted',
  'claude_subagents_stopped',
]
assert(
  projectTimeline(serverBookkeepingTypes.map((type, index) => event(100 + index, type)), []).length === 0,
  'server queue, subagent, and job bookkeeping must not render as legacy timeline rows',
)

assert(
  crossChatSemanticKey(event(1, 'cross_chat_handoff_queued', { handoff_id: 'handoff-1' })) === 'cross-chat:handoff:handoff-1',
  'cross-chat handoffs should use their durable envelope identity',
)
assert(
  crossChatSemanticKey(event(2, 'cross_chat_watch_updated', { watch_id: 'watch-1' })) === 'cross-chat:watch:watch-1',
  'cross-chat watches should use their durable watch identity',
)
assert(
  crossChatSemanticKey(event(3, 'cross_chat_exchange_leg_queued', { cross_chat_exchange_id: 'exchange-1', cross_chat_exchange_leg_id: 'leg-1' })) === 'cross-chat-exchange:exchange-1',
  'every leg in one exchange should project to the same conversation identity',
)

const collapsedHandoff = projectTimeline([
  event(10, 'cross_chat_handoff_registered', { handoff_id: 'handoff-1', handoff_status: 'registered' }),
  event(11, 'cross_chat_handoff_queued', { handoff_id: 'handoff-1', handoff_status: 'queued' }),
  event(12, 'cross_chat_handoff_delivered', { handoff_id: 'handoff-1', handoff_status: 'delivered' }),
], [])
assert(collapsedHandoff.length === 1 && collapsedHandoff[0].kind === 'system', 'one handoff lifecycle should render as one card')
assert(collapsedHandoff[0].key === 'cross-chat:handoff:handoff-1', 'handoff card should retain its semantic key')
assert(collapsedHandoff[0].seq === 10, 'handoff card should retain its first stable list anchor')
assert(collapsedHandoff[0].event.handoff_status === 'delivered', 'handoff card should expose the newest lifecycle state')
assert(
  collapsedHandoff[0].representedEventIds?.join('|') === 'event-10|event-11|event-12',
  'semantic handoff cards should retain every represented lifecycle event identity',
)

const internalDelivery = projectTimeline([
  event(20, 'turn_started', {
    run_id: 'cross-chat-delivery',
    purpose: 'cross_chat_handoff_delivery',
    prompt: 'Internal authority-bearing relay that must not impersonate the user.',
  }),
  event(21, 'reasoning_summary', { run_id: 'cross-chat-delivery', phase: 'commentary', text: 'Working on the relayed request.' }),
  event(22, 'assistant_text', { run_id: 'cross-chat-delivery', text: 'Relayed work result.' }),
  event(23, 'turn_finished', { run_id: 'cross-chat-delivery', result_text: 'Relayed work result.' }),
], [])
assert(!internalDelivery.some(row => row.kind === 'message' && row.role === 'user'), 'synthetic cross-chat delivery prompts must never render as user messages')
assert(internalDelivery.some(row => row.kind === 'message' && row.role === 'assistant'), 'cross-chat delivery assistant output should remain visible')
assert(internalDelivery.some(row => row.kind === 'trace'), 'cross-chat delivery reasoning should remain visible')

const mailboxWakeFailure = projectTimeline([
  event(24, 'chat_conversation_message_received', {
    message: 'Agent mail stored in the chat inbox.',
    source_session_id: 'sender',
    target_session_id: 'chat-1',
  }),
  event(25, 'turn_started', {
    run_id: 'mailbox-wake',
    purpose: 'chat_mailbox_wake',
    prompt: 'Internal mailbox wake prompt that must not look user-authored.',
  }),
  event(26, 'turn_finished', {
    run_id: 'mailbox-wake',
    purpose: 'chat_mailbox_wake',
    exit_code: 143,
  }),
], [])
assert(
  mailboxWakeFailure.some(row => row.kind === 'system' && row.event.type === 'chat_conversation_message_received'),
  'mailbox receipt lifecycle should remain visible in the chat timeline',
)
assert(!mailboxWakeFailure.some(row => row.kind === 'message' && row.role === 'user'), 'synthetic mailbox wake prompts must never render as user messages')
const mailboxWakeFailureRow = mailboxWakeFailure.find(row => row.kind === 'system' && row.event.type === 'turn_finished')
assert(mailboxWakeFailureRow?.kind === 'system' && isTimelineError(mailboxWakeFailureRow.event), 'failed mailbox wake terminals should render as error rows')
assert(rowText(mailboxWakeFailureRow) === 'Agent turn failed with exit code 143.', 'failed mailbox wake terminals should explain the exit code')

const contiguousOccurrences = projectTimeline([
  event(27, 'job_ran', {
    run_id: 'scheduled-run-1',
    job_id: 'job-occurrences',
    job_title: 'Occurrence monitor',
    job_occurrence_id: 'occurrence-1',
  }),
  event(28, 'reasoning_summary', { run_id: 'scheduled-run-1', text: 'First occurrence reasoning.' }),
  event(29, 'job_finished', {
    run_id: 'scheduled-run-1',
    job_id: 'job-occurrences',
    job_occurrence_id: 'occurrence-1',
    result_text: 'First occurrence result.',
  }),
  event(30, 'job_ran', {
    run_id: 'scheduled-run-2',
    job_id: 'job-occurrences',
    job_title: 'Occurrence monitor',
    job_occurrence_id: 'occurrence-2',
  }),
  event(31, 'job_finished', {
    run_id: 'scheduled-run-2',
    job_id: 'job-occurrences',
    job_occurrence_id: 'occurrence-2',
    result_text: 'Second occurrence result.',
  }),
], [])
assert(
  contiguousOccurrences.length === 1 && contiguousOccurrences[0]?.kind === 'job' && contiguousOccurrences[0].seq === 27,
  'contiguous occurrences of one job must share one card anchored at the segment start',
)
assert(
  contiguousOccurrences[0]?.kind === 'job' && jobDisplayEvents(contiguousOccurrences[0].events).map(candidate => candidate.result_text).join('|') === 'First occurrence result.|Second occurrence result.',
  'a contiguous job card must retain the substantive result from every occurrence',
)
assert(
  contiguousOccurrences[0]?.kind === 'job' && contiguousOccurrences[0].events.some(candidate => candidate.type === 'reasoning_summary'),
  'scheduled provider reasoning must remain attached to its exact occurrence',
)

const splitOccurrences = projectTimeline([
  event(29, 'job_ran', { run_id: 'split-run-1', job_id: 'job-split', job_occurrence_id: 'split-1' }),
  event(30, 'job_finished', { run_id: 'split-run-1', job_id: 'job-split', job_occurrence_id: 'split-1', result_text: 'Before boundary.' }),
  event(31, 'error', { message: 'Visible boundary.' }),
  event(32, 'job_ran', { run_id: 'split-run-2', job_id: 'job-split', job_occurrence_id: 'split-2' }),
  event(33, 'job_finished', { run_id: 'split-run-2', job_id: 'job-split', job_occurrence_id: 'split-2', result_text: 'After boundary.' }),
], [])
assert(
  splitOccurrences.map(row => row.key).join('|') === 'job:job-split|event:event-31|job:job-split:segment:32',
  'a visible non-job event must split repeated scheduled occurrences into chronological cards',
)

const authoritativeJobGroups = projectTimeline([
  event(34, 'job_ran', { run_id: 'group-run-1', job_id: 'job-groups', job_timeline_group_id: 'group-a' }),
  event(35, 'job_finished', { run_id: 'group-run-1', job_id: 'job-groups', job_timeline_group_id: 'group-a', result_text: 'Group A.' }),
  event(36, 'job_ran', { run_id: 'group-run-2', job_id: 'job-groups', job_timeline_group_id: 'group-b' }),
  event(37, 'job_finished', { run_id: 'group-run-2', job_id: 'job-groups', job_timeline_group_id: 'group-b', result_text: 'Group B.' }),
], [])
assert(
  authoritativeJobGroups.map(row => row.key).join('|') === 'group-a|group-b',
  'distinct authoritative job timeline group IDs must always produce distinct cards',
)

const recycledRunOccurrences = projectTimeline([
  event(38, 'job_ran', { run_id: 'recycled-run', job_id: 'job-recycled', job_occurrence_id: 'recycled-1' }),
  event(39, 'reasoning_summary', { run_id: 'recycled-run', text: 'Reasoning for first recycled occurrence.' }),
  event(40, 'job_finished', { run_id: 'recycled-run', job_id: 'job-recycled', job_occurrence_id: 'recycled-1', result_text: 'First recycled result.' }),
  event(41, 'error', { message: 'Separate recycled occurrences.' }),
  event(42, 'job_ran', { run_id: 'recycled-run', job_id: 'job-recycled', job_occurrence_id: 'recycled-2' }),
  event(43, 'reasoning_summary', { run_id: 'recycled-run', text: 'Reasoning for second recycled occurrence.' }),
  event(44, 'job_finished', { run_id: 'recycled-run', job_id: 'job-recycled', job_occurrence_id: 'recycled-2', result_text: 'Second recycled result.' }),
], [])
const recycledJobRows = recycledRunOccurrences.filter(row => row.kind === 'job')
assert(recycledJobRows.length === 2, 'recycled run IDs with distinct occurrence IDs must route to distinct chronological segments')
assert(
  recycledJobRows[0]?.kind === 'job'
  && recycledJobRows[0].events.some(candidate => candidate.text === 'Reasoning for first recycled occurrence.')
  && !recycledJobRows[0].events.some(candidate => candidate.text === 'Reasoning for second recycled occurrence.')
  && recycledJobRows[1]?.kind === 'job'
  && recycledJobRows[1].events.some(candidate => candidate.text === 'Reasoning for second recycled occurrence.'),
  'run-scoped provider packets must attach to the correct recycled occurrence segment',
)

const providerInteractionAudit = projectTimeline([
  event(40, 'claude_interaction_requested', {
    run_id: 'permission-run',
    interaction_id: 'permission-a',
    request_method: 'item/commandExecution/requestApproval',
  }),
  event(41, 'claude_interaction_resolved', { run_id: 'permission-run', interaction_id: 'permission-a', message: 'Approved', resolution: 'answered' }),
  event(42, 'claude_interaction_requested', {
    run_id: 'permission-run',
    interaction: {
      id: 'permission-b',
      session_id: 'chat-1',
      method: 'item/fileChange/requestApproval',
      params: {},
      created_at: '2026-07-16T00:00:42Z',
      thread_id: 'thread-1',
    },
  }),
  event(43, 'claude_interaction_resolved', { run_id: 'permission-run', interaction_id: 'permission-b', message: 'Denied', resolution: 'denied' }),
], [])
assert(providerInteractionAudit.length === 1 && providerInteractionAudit[0]?.kind === 'system', 'provider permission history must fold into one audit row per run')
assert(providerInteractionAudit[0]?.key === 'provider-interaction-audit:claude:permission-run', 'provider audit identity must remain stable across request and resolution packets')
assert(providerInteractionAudit[0]?.kind === 'system' && providerInteractionAudit[0].events?.length === 4 && providerInteractionAudit[0].seq === 43, 'provider audit row must retain its lifecycle and track the latest transition')
if (providerInteractionAudit[0]?.kind !== 'system') throw new Error('expected provider audit system row')
const providerAuditDetail = providerInteractionAuditSummary(providerInteractionAudit[0].events ?? [providerInteractionAudit[0].event])
assert(providerAuditDetail.requestCount === 2 && providerAuditDetail.resolvedCount === 2, 'provider audit detail must count request and resolution lifecycles')
assert(providerAuditDetail.entries.map(entry => entry.id).join('|') === 'permission-b|permission-a', 'provider audit entries must group by interaction identity newest first')
assert(providerAuditDetail.entries[0]?.label === 'File change approval' && providerAuditDetail.entries[0]?.status === 'Resolved · Denied', 'provider audit entries must expose semantic labels and resolution detail')
assert(providerAuditDetail.entries[1]?.label === 'Command approval' && providerAuditDetail.entries[1]?.status === 'Resolved', 'answered provider requests must show a compact resolved state')

const emergencyRows = projectTimeline([
  event(44, 'emergency_alert_raised', { emergency_alert_id: 'alert-1', message: 'Immediate user attention required.' }),
  event(45, 'emergency_alert_acknowledged', { emergency_alert_id: 'alert-1' }),
], [])
assert(emergencyRows.length === 1 && emergencyRows[0]?.kind === 'system' && emergencyRows[0].event.type === 'emergency_alert_raised', 'emergency acknowledgement bookkeeping must not duplicate the visible alert card')

const scheduledEmergencyRows = projectTimeline([
  event(46, 'job_ran', { run_id: 'alert-job-run', job_id: 'alert-job' }),
  event(47, 'emergency_alert_raised', { run_id: 'alert-job-run', job_id: 'alert-job', emergency_alert_id: 'scheduled-alert', message: 'Scheduled work needs attention.' }),
  event(48, 'job_finished', { run_id: 'alert-job-run', job_id: 'alert-job', result_text: 'Scheduled work stopped.' }),
], [])
assert(
  scheduledEmergencyRows.some(row => row.kind === 'system' && row.event.type === 'emergency_alert_raised' && row.seq === 47),
  'an emergency raised inside a scheduled run must remain a top-level chronological card',
)
assert(
  scheduledEmergencyRows.every(row => row.kind !== 'job' || !row.events.some(candidate => candidate.type === 'emergency_alert_raised')),
  'scheduled job folding must never swallow emergency alerts',
)

const scheduledNativeStop = projectTimeline([
  event(49, 'job_ran', { run_id: 'scheduled-steer-run', job_id: 'scheduled-steer-job' }),
  event(50, 'turn_stopped', {
    run_id: 'scheduled-steer-run',
    native_steer: true,
    superseded_by_run_id: 'scheduled-steer-successor',
    message: 'Scheduled turn stopped.',
  }),
], [])
assert(
  scheduledNativeStop.length === 1
  && scheduledNativeStop[0]?.kind === 'job'
  && scheduledNativeStop[0].events.some(candidate => candidate.type === 'turn_stopped'),
  'a native-steer stop inside scheduled work is durable job status, not an invisible ordinary transition',
)

const terminalExchange = projectTimeline([
  event(30, 'cross_chat_exchange_leg_queued', {
    exchange_id: 'exchange-terminal',
    exchange_leg_id: 'leg-request',
    exchange_status: 'active',
    exchange_leg_status: 'queued',
  }),
  event(31, 'cross_chat_exchange_cancelled', {
    exchange_id: 'exchange-terminal',
    exchange_status: 'cancelled',
  }),
  event(32, 'cross_chat_exchange_leg_delivered', {
    exchange_id: 'exchange-terminal',
    exchange_leg_id: 'leg-request',
    exchange_status: 'active',
    exchange_leg_status: 'delivered',
  }),
], [])
const terminalExchangeRows = terminalExchange.filter(row => row.kind === 'system' && row.key.startsWith('cross-chat-exchange:'))
assert(terminalExchangeRows.length === 1, 'one exchange lifecycle should render as one conversation card')
assert(
  terminalExchangeRows.every(row => row.kind === 'system' && row.event.exchange_status === 'cancelled'),
  'a terminal exchange state must dominate every stale late conversation packet',
)
assert(
  terminalExchangeRows[0]?.kind === 'system' && terminalExchangeRows[0].events?.length === 3,
  'the conversation card should retain all lifecycle packets for its messages and controls',
)

const failedLegDoesNotPoisonExchange = projectTimeline([
  event(33, 'cross_chat_exchange_leg_failed', {
    exchange_id: 'exchange-with-retry',
    exchange_leg_id: 'leg-failed',
    exchange_status: 'active',
    exchange_leg_status: 'failed',
  }),
  event(34, 'cross_chat_exchange_leg_queued', {
    exchange_id: 'exchange-with-retry',
    exchange_leg_id: 'leg-retry',
    exchange_status: 'active',
    exchange_leg_status: 'queued',
  }),
], [])
assert(
  failedLegDoesNotPoisonExchange.every(row => row.kind !== 'system' || row.event.exchange_status === 'active'),
  'a leg-level failure must not infer a terminal state for the entire exchange',
)

assert(rows.length === 1, `expected one folded job row, received ${rows.length}`)
assert(rows[0].kind === 'job', `expected job row, received ${rows[0].kind}`)
assert(rows[0].title === 'Training status', `expected job title, received ${rows[0].title}`)
assert(rows[0].seq === 1, `expected job row at its first occurrence anchor, received seq ${rows[0].seq}`)
const updates = jobDisplayEvents(rows[0].events)
assert(updates.length === 1, `expected one display update, received ${updates.length}`)
assert(updates[0].type === 'turn_finished', `expected final result, received ${updates[0].type}`)
assert(rowText(rows[0]) === 'Training is healthy.', `expected final result text, received ${rowText(rows[0])}`)

const repeated = projectTimeline([
  event(1, 'job_ran', { run_id: 'run-1', job_id: 'job-1', job_title: 'Status check' }),
  event(2, 'turn_finished', { run_id: 'run-1', result_text: 'First result' }),
  event(3, 'job_ran', { run_id: 'run-2', job_id: 'job-1', job_title: 'Status check' }),
  event(4, 'assistant_text', { run_id: 'run-2', text: 'Second result' }),
], [])
assert(repeated.length === 1 && repeated[0]?.kind === 'job', 'contiguous scheduled runs for one job must fold into one chronological card')
assert(
  repeated[0]?.kind === 'job' && jobDisplayEvents(repeated[0].events).map(value => value.text || value.result_text).join('|') === 'First result|Second result',
  'the folded job card must retain every scheduled run result',
)

const semanticJobEvents = [
  event(5, 'turn_finished', { run_id: 'run-old', result_text: 'Completed result' }),
  event(6, 'job_summary', {
    job_id: 'job-semantic',
    job_run_count: 32,
    result_text: '{"queue_status":"completed","collector":"canola","collector_status":"advanced","error":null}',
  }),
]
assert(latestJobDisplayEvent(semanticJobEvents)?.type === 'job_summary', 'newest semantic job summary should represent the job')
assert(jobRunCount(semanticJobEvents) === 32, 'semantic job run totals should survive bounded event history')
assert(
  jobRunCount([...semanticJobEvents, event(7, 'job_started', { run_id: 'run-after-summary' })]) === 33,
  'live runs after a semantic summary should increment its reported total',
)
const structuredJob = jobResultPresentation(semanticJobEvents[1])
assert(structuredJob.structured, 'JSON job output should be recognized as structured data')
assert(
  structuredJob.preview === 'Queue: Completed · Collector: Canola · Collector status: Advanced',
  `structured job preview should expose useful state, received ${structuredJob.preview}`,
)
assert(structuredJob.detail.includes('\n  "queue_status": "completed"'), 'expanded structured output should be readable')
assert(jobResultPresentation(event(7, 'job_finished', { message: 'x'.repeat(500) })).preview.length <= 240, 'plain job previews should be character bounded')

const duplicateResults = [
  event(10, 'turn_finished', { id: 'run-one-result', run_id: 'run-one', job_id: 'job-duplicates', result_text: 'Same useful result' }),
  event(20, 'turn_finished', { id: 'run-two-result', run_id: 'run-two', job_id: 'job-duplicates', result_text: 'Same useful result' }),
  event(30, 'job_summary', {
    id: 'job-duplicates-summary',
    job_id: 'job-duplicates',
    result_text: 'Same useful result',
    job_run_count: 2,
  }),
]
const duplicateSelection = jobDisplaySelection(duplicateResults)
assert(duplicateSelection.latest?.id === 'job-duplicates-summary', 'semantic summary should remain the latest job display')
assert(duplicateSelection.latestSource?.id === 'run-two-result', 'summary should retain the newest matching run as its source')
assert(
  duplicateSelection.previous.map(value => value.id).join('|') === 'run-one-result',
  'summary dedupe must remove only its own representative, not a different run with identical output',
)

const mergedHistory = mergeJobHistoryEvents(
  [
    event(10, 'turn_finished', { id: 'run-one-old', run_id: 'run-one', result_text: 'Old result' }),
    event(11, 'turn_finished', { id: 'run-two', run_id: 'run-two', result_text: 'Second result' }),
  ],
  [event(12, 'turn_finished', {
    id: 'job_run:run:run-one',
    run_id: 'run-one',
    job_status_seq: 10,
    result_text: 'New result',
  })],
)
assert(
  mergedHistory.map(value => `${value.run_id}:${value.seq}`).join('|') === 'run-one:12|run-two:11',
  'lazy and bundled representatives of the same attempt must dedupe newest-first',
)
assert(
  mergeJobHistoryEvents([
    event(20, 'turn_finished', { id: 'reused-first', run_id: 'reused-run', result_text: 'First result' }),
    event(30, 'turn_finished', { id: 'reused-second', run_id: 'reused-run', result_text: 'Second result' }),
  ]).length === 2,
  'distinct attempts must survive when a backend reuses its run ID',
)
const rawRunlessFailure = event(15, 'job_error', {
  id: 'raw-runless-failure',
  job_id: 'job-runless',
  error: 'Scheduler failed',
})
const lazyRunlessFailure = event(15, 'job_error', {
  id: 'job_run:status:job-runless:15',
  job_id: 'job-runless',
  job_status: 'failed',
  job_status_seq: 15,
  error: 'Scheduler failed',
})
assert(
  jobRunIdentity(rawRunlessFailure) === jobRunIdentity(lazyRunlessFailure)
  && mergeJobHistoryEvents([rawRunlessFailure], [lazyRunlessFailure]).length === 1,
  'raw and synthesized runless attempts must share one stable history identity',
)
assert(
  jobRunStatus(event(31, 'job_summary', {
    job_status: 'running',
    result_text: '{"status":"completed"}',
  })).label === 'Running',
  'authoritative current job status must override older structured output state',
)
const fastFinished = event(41, 'turn_finished', {
  id: 'fast-finished',
  run_id: 'fast-run',
  job_id: 'job-fast',
  result_text: 'Fast result',
})
const lateJobRan = event(42, 'job_ran', {
  id: 'late-job-ran',
  run_id: 'fast-run',
  job_id: 'job-fast',
  message: 'Scheduled job ran',
})
assert(
  latestJobStatusEvent([
    event(40, 'turn_started', { run_id: 'fast-run', job_id: 'job-fast' }),
    fastFinished,
    lateJobRan,
  ])?.id === fastFinished.id,
  'a late job_ran marker must not regress a completed attempt to running',
)
const reusedRunStarted = event(43, 'turn_started', {
  id: 'reused-run-started',
  run_id: 'fast-run',
  job_id: 'job-fast',
})
assert(
  latestJobStatusEvent([fastFinished, lateJobRan, reusedRunStarted])?.id === reusedRunStarted.id,
  'a later turn_started remains an explicit new attempt when a backend reuses a run ID',
)
assert(
  jobDisplayEvents([
    event(32, 'job_created', { job_id: 'job-runless' }),
    event(33, 'job_deferred', { job_id: 'job-runless', message: 'Deferred tick' }),
    event(34, 'job_error', { job_id: 'job-runless', error: 'Failed tick' }),
  ]).map(value => value.type).join('|') === 'job_deferred|job_error',
  'runless deferred and failed attempts must survive while job creation stays out of run history',
)

const appServerStatus = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-status', prompt: 'Use app server' }),
  event(2, 'codex_thread_status', { message: 'Codex is working.' }),
  event(3, 'codex_thread_status', { message: 'Codex is idle.' }),
  event(4, 'turn_finished', { run_id: 'run-status', result_text: 'Done.' }),
  event(5, 'error', { message: 'A real server error.' }),
], [])
assert(
  !appServerStatus.some(row => row.kind === 'system' && row.event.type === 'codex_thread_status'),
  'transient app-server status changes must not become transcript cards',
)
assert(
  appServerStatus.some(row => row.kind === 'system' && row.event.type === 'error'),
  'real server errors must remain visible after status suppression',
)

const compactedLifecycle = projectTimeline([
  event(1, 'codex_goal_updated', { message: 'Goal is active.' }),
  event(2, 'codex_compaction_started', {
    operation_id: 'explicit-compact',
    message: 'Context compaction started.',
  }),
  event(3, 'codex_compaction_completed', {
    operation_id: 'explicit-compact',
    message: 'Context compaction completed.',
  }),
  event(4, 'codex_compaction_completed', {
    turn_id: 'provider-turn-a',
    item_id: 'compaction-item-a',
    message: 'Codex completed automatic context compaction.',
  }),
  event(5, 'codex_compaction_completed', {
    turn_id: 'provider-turn-a',
    item_id: 'compaction-item-b',
    message: 'Codex completed automatic context compaction.',
  }),
  event(6, 'codex_compaction_completed', {
    turn_id: 'provider-turn-b',
    item_id: 'compaction-item-c',
    message: 'Codex completed automatic context compaction.',
  }),
  event(7, 'codex_token_usage', {
    context_tokens: 92_000,
    context_window: 100_000,
    context_percent: 92,
  }),
], [])
const compactionRows = compactedLifecycle.filter(row =>
  row.kind === 'system' && row.event.type === 'codex_compaction_completed'
)
assert(compactionRows.length === 3, `expected explicit plus two logical automatic compaction rows, received ${compactionRows.length}`)
assert(
  compactionRows.map(row => row.key).join('|')
    === 'codex:compaction:explicit-compact|codex:compaction:provider-turn-a|codex:compaction:provider-turn-b',
  'compaction rows must use the same semantic identity as Mac and the server',
)
assert(
  compactionRows[1].kind === 'system' && compactionRows[1].seq === 5 && compactionRows[1].event.item_id === 'compaction-item-b',
  'same-turn automatic compactions must retain only the newest completion',
)
assert(
  !compactedLifecycle.some(row => row.kind === 'system' && ['codex_goal_updated', 'codex_token_usage', 'codex_compaction_started'].includes(row.event.type)),
  'routine Codex goal, usage, and in-progress compaction state must stay out of the transcript',
)
assert(
  codexLifecycleSemanticKey(event(7, 'codex_goal_budget_limited')) === 'codex:goal-budget',
  'goal budget warnings must retain their durable semantic identity',
)

const nativeSteer = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-before-steer', prompt: 'Original request' }),
  event(2, 'reasoning_summary', { run_id: 'run-before-steer', text: 'Working on the original request.' }),
  event(3, 'reasoning_summary', {
    run_id: 'run-before-steer',
    phase: 'commentary', item_id: 'commentary-before-steer-a',
    text: 'Completed commentary before steering.',
  }),
  event(4, 'reasoning_summary', {
    run_id: 'run-before-steer',
    phase: 'commentary', item_id: 'commentary-before-steer-b',
    text: 'Completed commentary before steering.',
  }),
  event(5, 'turn_stopped', {
    run_id: 'run-before-steer',
    native_steer: true,
    superseded_by_run_id: 'run-after-steer',
  }),
  event(6, 'turn_started', {
    run_id: 'run-after-steer',
    steer_interrupted_run_id: 'run-before-steer',
    prompt: 'Steering instruction',
  }),
], [])
const supersededTrace = nativeSteer.find(row => row.kind === 'trace' && row.runId === 'run-before-steer')
assert(supersededTrace?.kind === 'trace' && !supersededTrace.active, 'native steer should retire the superseded logical trace')
assert(
  supersededTrace.events.map(value => value.text).join('|') === 'Working on the original request.',
  'native steer should keep private reasoning in the folded predecessor trace',
)
assert(
  supersededTrace.promotedCommentaryIds.join('|') === 'event-3|event-4',
  'native steer should remember commentary IDs removed from the trace',
)
const promotedSteerMessage = nativeSteer.find(row =>
  row.kind === 'message'
  && row.role === 'assistant'
  && row.key === 'turn:run-before-steer:assistant'
)
assert(
  promotedSteerMessage?.kind === 'message'
  && promotedSteerMessage.events.length === 2
  && promotedSteerMessage.events.every(value => value.text === 'Completed commentary before steering.'),
  'completed pre-steer commentary should become one assistant message and retain distinct event IDs even when text matches',
)
assert(
  !nativeSteer.some(row => row.kind === 'system' && row.event.type === 'turn_stopped'),
  'native steer must not present its logical boundary as a stopped turn',
)
assert(
  nativeSteer.some(row => row.kind === 'message' && row.role === 'user' && rowText(row) === 'Steering instruction'),
  'native steer should expose the new logical user turn',
)

const reloadedNativeSteers = projectTimeline([
  event(10, 'turn_started', { run_id: 'run-a', prompt: 'Original request' }),
  event(11, 'reasoning_summary', {
    run_id: 'run-a',
    phase: 'commentary',
    item_id: 'commentary-a',
    text: 'Progress from A.',
  }),
  // Semantic history omits native transition stops. The successor link is
  // therefore the only durable reconstruction signal on reload.
  event(12, 'turn_started', {
    run_id: 'run-b',
    native_steer: true,
    steer_interrupted_run_id: 'run-a',
    prompt: 'First steer',
  }),
  event(13, 'reasoning_summary', {
    run_id: 'run-b',
    phase: 'commentary',
    item_id: 'commentary-b',
    text: 'Progress from B.',
  }),
  event(14, 'turn_started', {
    run_id: 'run-c',
    native_steer: true,
    steer_interrupted_run_id: 'run-b',
    prompt: 'Second steer',
  }),
], [])
const reloadedPromotedMessages = reloadedNativeSteers.filter(row =>
  row.kind === 'message' && row.role === 'assistant'
)
assert(
  reloadedPromotedMessages.map(row => rowText(row)).join('|') === 'Progress from A.|Progress from B.',
  'successor metadata should reconstruct every promoted commentary segment across repeated steering',
)
assert(
  reloadedNativeSteers
    .filter(row => row.kind === 'message')
    .map(row => `${row.role}:${rowText(row)}`)
    .join('|')
    === 'user:Original request|assistant:Progress from A.|user:First steer|assistant:Progress from B.|user:Second steer',
  'reloaded native steering must keep each promoted predecessor update before its successor prompt',
)
assert(
  !reloadedNativeSteers.some(row => row.kind === 'trace'),
  'commentary-only retired traces should disappear after reload promotion',
)

const inputFile: AgentFile = { id: 'input-file', filename: 'question.png', seq: 1 }
const outputFile: AgentFile = { id: 'output-file', filename: 'answer.mp4', seq: 3 }
const draftFile: AgentFile = { id: 'draft-file', filename: 'draft.png', seq: 3 }
const draftUploadEvents = [
  event(1, 'turn_started', { run_id: 'run-active', prompt: 'Keep working' }),
  event(2, 'assistant_text', { run_id: 'run-active', text: 'Still working.' }),
  event(3, 'file_uploaded', { file: draftFile }),
]
const beforeDraftSend = projectTimeline(draftUploadEvents, [])
assert(
  !beforeDraftSend.some(row => row.kind === 'media'),
  'a composer upload must not appear as standalone media before its message is sent',
)
assert(
  beforeDraftSend.find(row => row.kind === 'message' && row.role === 'user')?.kind === 'message'
  && beforeDraftSend.find(row => row.kind === 'message' && row.role === 'user')?.files.length === 0,
  'a composer upload must not attach itself to an unrelated active turn',
)
const afterDraftSend = projectTimeline([
  ...draftUploadEvents,
  event(4, 'turn_finished', { run_id: 'run-active', result_text: 'Done.' }),
  event(5, 'turn_started', { run_id: 'run-draft', prompt: 'Review this', file_ids: [draftFile.id] }),
], [])
const draftUserRows = afterDraftSend.filter(row => row.kind === 'message' && row.role === 'user')
assert(
  !afterDraftSend.some(row => row.kind === 'media')
  && draftUserRows.length === 2
  && draftUserRows[0].files.length === 0
  && draftUserRows[1].files.map(file => file.id).join(',') === draftFile.id,
  'a composer upload must appear exactly once on the user turn that references it',
)
const delayedUploadRows = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-delayed-upload', prompt: 'Review this', file_ids: [draftFile.id] }),
  event(2, 'file_uploaded', { file: draftFile }),
], [])
assert(
  delayedUploadRows.length === 1
  && delayedUploadRows[0].kind === 'message'
  && delayedUploadRows[0].role === 'user'
  && delayedUploadRows[0].files.map(file => file.id).join(',') === draftFile.id,
  'a late upload receipt must resolve only the user turn that explicitly owns its file ID',
)
const attachments = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-files', prompt: 'Review this image', file_ids: [inputFile.id] }),
  event(2, 'file_uploaded', { run_id: 'run-files', file: inputFile }),
  event(3, 'artifact_created', { run_id: 'run-files', artifact: outputFile }),
  event(4, 'turn_finished', { run_id: 'run-files', result_text: 'Rendered the result.' }),
], [inputFile, outputFile])
const userAttachment = attachments.find(row => row.kind === 'message' && row.role === 'user')
const attachmentAssistantIndex = attachments.findIndex(row => row.kind === 'message' && row.role === 'assistant')
const attachmentMediaIndex = attachments.findIndex(row => row.kind === 'media')
const outputMedia = attachments.find(row => row.kind === 'media')
assert(userAttachment?.kind === 'message', 'expected a user message row')
assert(userAttachment.files.map(file => file.id).join(',') === inputFile.id, 'expected the input attachment exactly once on the user message')
assert(outputMedia?.kind === 'media', 'expected a generated-media row')
assert(outputMedia.files.map(file => file.id).join(',') === outputFile.id, 'expected only generated output in the standalone media row')
assert(
  attachmentAssistantIndex >= 0 && attachmentMediaIndex === attachmentAssistantIndex + 1,
  'generated media emitted before turn completion must render immediately after its assistant answer',
)
assert(
  attachments[attachmentAssistantIndex]?.key === 'turn:run-files:assistant'
  && attachments[attachmentMediaIndex]?.key === 'turn:run-files:media',
  'assistant and media rows must retain stable run-scoped keys',
)

const lateOutputFile: AgentFile = { id: 'late-output-file', filename: 'late-answer.mp4', seq: 5 }
const lateArtifactRows = projectTimeline([
  event(1, 'turn_started', { run_id: 'run-artifact-owner', prompt: 'Render the first result' }),
  event(2, 'turn_finished', { run_id: 'run-artifact-owner', result_text: 'The first result is ready.' }),
  event(3, 'turn_started', { run_id: 'run-new-active', prompt: 'Start the next task' }),
  event(4, 'reasoning_summary', { run_id: 'run-new-active', phase: 'commentary', text: 'Working on the next task.' }),
  event(5, 'artifact_created', { run_id: 'run-artifact-owner', artifact: lateOutputFile }),
], [lateOutputFile])
const lateOwnerAssistantIndex = lateArtifactRows.findIndex(row => row.key === 'turn:run-artifact-owner:assistant')
const lateOwnerMediaIndex = lateArtifactRows.findIndex(row => row.key === 'turn:run-artifact-owner:media')
const lateSuccessorIndex = lateArtifactRows.findIndex(row => row.key === 'turn:run-new-active:user')
assert(
  lateOwnerAssistantIndex >= 0
  && lateOwnerMediaIndex === lateOwnerAssistantIndex + 1
  && lateSuccessorIndex > lateOwnerMediaIndex,
  'a late run-scoped artifact must stay after its owning answer and before the successor turn',
)
assert(
  !lateArtifactRows.some(row => row.key === 'turn:run-new-active:media'),
  'a late artifact must never attach to the newer active turn',
)

const pairedFirstFile: AgentFile = { id: 'paired-first-file', filename: 'first.mp4', seq: 11 }
const pairedSecondFile: AgentFile = { id: 'paired-second-file', filename: 'second.mp4', seq: 16 }
const pairedCompletedRows = projectTimeline([
  event(10, 'turn_started', { run_id: 'run-paired-first', prompt: 'Render the first video' }),
  event(11, 'artifact_created', { run_id: 'run-paired-first', artifact: pairedFirstFile }),
  event(13, 'turn_finished', { run_id: 'run-paired-first', result_text: 'First video ready.' }),
  event(14, 'codex_compaction_completed', { operation_id: 'between-media-turns', message: 'Context compaction completed.' }),
  event(15, 'turn_started', { run_id: 'run-paired-second', prompt: 'Render the second video' }),
  event(16, 'artifact_created', { run_id: 'run-paired-second', artifact: pairedSecondFile }),
  event(18, 'turn_finished', { run_id: 'run-paired-second', result_text: 'Second video ready.' }),
], [pairedFirstFile, pairedSecondFile])
assert(
  pairedCompletedRows.map(row => row.key).join('|')
    === [
      'turn:run-paired-first:user',
      'turn:run-paired-first:assistant',
      'turn:run-paired-first:media',
      'codex:compaction:between-media-turns',
      'turn:run-paired-second:user',
      'turn:run-paired-second:assistant',
      'turn:run-paired-second:media',
    ].join('|'),
  'multiple completed turns must keep each media row paired with its answer across intervening lifecycle rows',
)

const importedEvents = [
  event(1, 'history_imported', { run_id: 'import_shared', message: 'Imported provider history.' }),
  event(2, 'turn_started', { run_id: 'import_shared', prompt: 'Injected context' }),
  event(3, 'turn_started', { run_id: 'import_shared', prompt: 'First user message' }),
  event(4, 'assistant_text', { run_id: 'import_shared', text: 'First answer' }),
  event(5, 'turn_started', { run_id: 'import_shared', prompt: 'Second user message' }),
  event(6, 'assistant_text', { run_id: 'import_shared', text: 'Second answer' }),
]
const imported = projectTimeline(importedEvents, [])
const importedMessages = imported.filter(row => row.kind === 'message')
assert(importedMessages.length === 5, `expected five distinct imported messages, received ${importedMessages.length}`)
assert(
  importedMessages.map(row => `${row.role}:${rowText(row)}`).join('|') === 'user:Injected context|user:First user message|assistant:First answer|user:Second user message|assistant:Second answer',
  'expected reused import run id to preserve user-turn boundaries and attach each answer to the latest user turn',
)
assert(new Set(importedMessages.map(row => row.key)).size === importedMessages.length, 'expected a unique stable key for every imported message row')
const importedWithoutPreamble = projectTimeline(importedEvents.slice(1), []).filter(row => row.kind === 'message')
assert(
  importedWithoutPreamble.map(row => row.key).join('|') === importedMessages.map(row => row.key).join('|'),
  'expected imported message keys to remain stable when an older preamble is prepended',
)

const compactProviderAuthorityPrompt = [
  'Send the status to the other chat.',
  '',
  '[AgentsDock provider authority]',
  'authority-file=/Users/example/.agentsdock/cross_chat_authority/run_a39d8f33ad864075-732f636e8745bb38.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)',
  'actions=cross_chat_instruction,team_send',
  'usage: see AgentsDock instructions',
  '[End AgentsDock provider authority]',
].join('\n')
assert(
  messageText(event(8, 'turn_started', { prompt: compactProviderAuthorityPrompt })) === 'Send the status to the other chat.',
  'generated provider authority must never render inside a mobile user message',
)
const authorityOnlyPrompt = compactProviderAuthorityPrompt.slice(compactProviderAuthorityPrompt.indexOf('[AgentsDock provider authority]'))
assert(
  messageText(event(81, 'turn_started', { prompt: authorityOnlyPrompt })) === '',
  'an authority-only provider echo must not leave an internal-only user bubble',
)
const windowsProviderAuthorityPrompt = compactProviderAuthorityPrompt.replace(
  '/Users/example/.agentsdock/cross_chat_authority/run_a39d8f33ad864075-732f636e8745bb38.json',
  'C:\\Users\\example\\.agentsdock\\cross_chat_authority\\run_a39d8f33ad864075-732f636e8745bb38.json',
)
assert(
  messageText(event(811, 'turn_started', { prompt: windowsProviderAuthorityPrompt })) === 'Send the status to the other chat.',
  'a provider authority echo migrated from Windows must never render on mobile',
)
const verboseProviderAuthorityPrompt = [
  'Continue the work.',
  '',
  '[AgentsDock provider authority]',
  'This authority file is bound to this server, chat, and live run.',
  'Do not read, print, quote, or expose the authority file. [End AgentsDock provider authority]',
].join('\n')
assert(
  messageText(event(82, 'turn_started', { prompt: verboseProviderAuthorityPrompt })) === 'Continue the work.',
  'a legacy verbose authority block with an inline end marker must never render',
)

const providerAuthorityLookalike = 'Document this example:\n\n[AgentsDock provider authority]\nnot a generated block\n[End AgentsDock provider authority]'
assert(
  messageText(event(9, 'turn_started', { prompt: providerAuthorityLookalike })) === providerAuthorityLookalike,
  'ordinary user-authored provider-authority lookalike text must remain visible',
)

const generatedAuthorityWithFollowingUserContent = `${compactProviderAuthorityPrompt}\n\nKeep this user-authored follow-up.`
assert(
  messageText(event(10, 'turn_started', { prompt: generatedAuthorityWithFollowingUserContent })) === generatedAuthorityWithFollowingUserContent,
  'a provider-authority-shaped block followed by content must not truncate that content',
)

assert(
  messageText(event(11, 'turn_started', {
    prompt: compactProviderAuthorityPrompt,
    display_prompt: 'Use the immutable display prompt.',
  })) === 'Use the immutable display prompt.',
  'mobile user messages must prefer an authoritative display prompt over a provider prompt',
)

const importedTaskNotification = [
  '<task-notification>',
  '<summary>',
  'A provider subtask completed.',
  '</summary>',
  '</task-notification>',
].join('\n')
const importedTaskRows = projectTimeline([
  event(12, 'turn_started', {
    run_id: 'import_task_notice',
    backend: 'claude',
    imported: true,
    prompt: importedTaskNotification,
  }),
  event(13, 'assistant_text', {
    run_id: 'import_task_notice',
    backend: 'claude',
    imported: true,
    text: 'The useful provider response remains visible.',
  }),
], [])
assert(
  importedTaskRows.length === 1
  && importedTaskRows[0].kind === 'message'
  && importedTaskRows[0].role === 'assistant'
  && rowText(importedTaskRows[0]) === 'The useful provider response remains visible.',
  'an imported Claude task notification must be hidden without swallowing its following assistant response',
)
assert(
  messageText(event(14, 'turn_started', {
    run_id: 'run-live-task-tag',
    backend: 'claude',
    prompt: importedTaskNotification,
  })) === importedTaskNotification,
  'a live user message containing a full task-notification example must remain visible',
)
assert(
  messageText(event(141, 'turn_started', {
    run_id: 'import_sanitized_task_tag',
    backend: 'claude',
    imported: true,
    provider_history_sanitized: true,
    prompt: importedTaskNotification,
  })) === importedTaskNotification,
  'an imported prompt already classified by the server must preserve a legitimate exact wrapper',
)
assert(
  messageText(event(15, 'turn_started', {
    run_id: 'import_codex_task_tag',
    backend: 'codex',
    imported: true,
    prompt: importedTaskNotification,
  })) === importedTaskNotification,
  'a non-Claude imported task-notification lookalike must remain visible',
)
const prefixedTaskNotification = `Please analyze this example:\n${importedTaskNotification}`
assert(
  messageText(event(16, 'turn_started', {
    run_id: 'import_prefixed_task_tag',
    backend: 'claude',
    imported: true,
    prompt: prefixedTaskNotification,
  })) === prefixedTaskNotification,
  'an imported user message containing task-notification markup plus human text must remain visible',
)

const streamed = projectTimeline([
  event(20, 'turn_started', { run_id: 'run-stream', prompt: 'Stream this' }),
  event(21, 'assistant_text', { run_id: 'run-stream', text: 'First chunk' }),
  event(22, 'assistant_text', { run_id: 'run-stream', text: 'Second   chunk' }),
  event(23, 'assistant_text', { run_id: 'run-stream', text: 'Second chunk' }),
  event(24, 'turn_finished', { run_id: 'run-stream', result_text: 'First chunk\nSecond chunk' }),
], [])
assert(streamed.length === 2, `expected one normal user/assistant turn, received ${streamed.length} rows`)
assert(streamed[0].key === 'turn:run-stream:user', `expected the normal streamed user key to remain stable, received ${streamed[0].key}`)
assert(streamed[1].key === 'turn:run-stream:assistant', `expected the normal streamed assistant key to remain stable, received ${streamed[1].key}`)
assert(streamed[1].kind === 'message' && streamed[1].events.length === 1 && streamed[1].events[0].type === 'turn_finished', 'expected normalized duplicate chunks to collapse into the final aggregate')

const activeCommentaryEvents = [
  event(30, 'turn_started', { run_id: 'run-progress', prompt: 'Keep me posted' }),
  event(31, 'reasoning_summary', { run_id: 'run-progress', phase: 'analysis', text: 'Internal analysis' }),
  event(32, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: 'Checking the release build.' }),
  event(33, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: 'Waiting for validation.' }),
  event(34, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: 'Uploading the validated build.' }),
  event(35, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: 'Waiting for TestFlight.' }),
  event(36, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: 'Build is ready for testing.' }),
  event(37, 'reasoning_summary', { run_id: 'run-progress', phase: 'commentary', text: '   ' }),
]
const activeCommentaryRows = projectTimeline(activeCommentaryEvents, [])
const activeCommentary = activeCommentaryRows.find(row => row.kind === 'trace')
const activeProgress = activeCommentaryRows.find(row => row.kind === 'progress')
assert(activeCommentary?.kind === 'trace', 'expected active reasoning to produce a trace row')
assert(activeCommentary.active, 'trace should remain active before assistant output or turn completion')
assert(
  activeCommentary.events.map(value => value.text).join('|') === 'Internal analysis',
  'active trace should retain private reasoning without duplicating commentary',
)
assert(
  activeProgress?.kind === 'progress'
  && activeProgress.events.map(value => value.text).join('|')
    === 'Checking the release build.|Waiting for validation.|Uploading the validated build.|Waiting for TestFlight.|Build is ready for testing.',
  'live progress should expose every substantive commentary update like Mac',
)
assert(
  activeProgress?.kind === 'progress'
  && activeProgress.key === 'turn:run-progress:assistant'
  && activeProgress.hiddenCount === 0
  && activeCommentaryRows.at(-1) === activeProgress,
  'live progress must reuse the eventual assistant key at the physical timeline edge',
)

const commentaryOnlyRows = projectTimeline([
  event(38, 'turn_started', { run_id: 'run-commentary-only', prompt: 'Report status' }),
  event(39, 'reasoning_summary', {
    run_id: 'run-commentary-only',
    phase: 'commentary',
    text: 'Public progress only.',
  }),
], [])
assert(
  !commentaryOnlyRows.some(row => row.kind === 'trace')
  && commentaryOnlyRows.some(row => row.kind === 'progress' && rowText(row) === 'Public progress only.'),
  'commentary-only live turns should render progress once without an empty duplicate trace',
)
const commentaryBeforeAnswerEvents = [
  event(38, 'turn_started', { run_id: 'run-commentary-to-answer', prompt: 'Report status' }),
  event(39, 'reasoning_summary', {
    run_id: 'run-commentary-to-answer',
    phase: 'commentary',
    text: 'Still working.',
  }),
]
const commentaryBeforeAnswerRows = projectTimeline(commentaryBeforeAnswerEvents, [])
const commentaryThenAnswerRows = projectTimeline([
  ...commentaryBeforeAnswerEvents,
  event(40, 'assistant_text', { run_id: 'run-commentary-to-answer', text: 'Done.' }),
], [])
assert(
  commentaryBeforeAnswerRows.find(row => row.kind === 'progress')?.key
    === commentaryThenAnswerRows.find(row => row.kind === 'message' && row.role === 'assistant')?.key,
  'live commentary and its final assistant response should use the same row-key shape',
)

const manyProgressRows = projectTimeline([
  event(120, 'turn_started', { run_id: 'run-many-progress', prompt: 'Keep reporting' }),
  ...Array.from({ length: ACTIVE_TRACE_PROGRESS_VISIBLE_LIMIT + 7 }, (_, index) =>
    event(121 + index, 'reasoning_summary', {
      run_id: 'run-many-progress',
      phase: 'commentary',
      text: `Progress ${index + 1}`,
    })
  ),
], [])
const boundedLiveProgress = manyProgressRows.find(row => row.kind === 'progress')
assert(
  boundedLiveProgress?.kind === 'progress'
  && boundedLiveProgress.events.length === ACTIVE_TRACE_PROGRESS_VISIBLE_LIMIT
  && boundedLiveProgress.hiddenCount === 7
  && boundedLiveProgress.events[0].text === 'Progress 8',
  'mobile live progress should show twenty recent updates and keep older updates in the trace',
)

const shortProgressPreview = activeTraceProgressPreview(event(38, 'reasoning_summary', {
  text: '  Rendering $x^2$ safely.  ',
}))
assert(shortProgressPreview === 'Rendering $x^2$ safely.', 'short progress previews should remain complete and trim outer whitespace')

const longFormulaPreview = activeTraceProgressPreview(event(39, 'reasoning_summary', {
  text: `${'a'.repeat(1_188)} before $${'x'.repeat(100)}$ after`,
}))
assert(
  longFormulaPreview.length <= ACTIVE_TRACE_PROGRESS_CHARACTER_LIMIT,
  'character-bounded progress must include its ellipsis within the limit',
)
assert(longFormulaPreview.endsWith('…'), 'folded character-bounded progress should end with an ellipsis')
assert(!longFormulaPreview.includes('$'), 'progress folding must not cut through or partially expose a formula')

const longCodePreview = activeTraceProgressPreview(event(40, 'reasoning_summary', {
  text: `${'b'.repeat(1_188)} before \`${'z'.repeat(100)}\` after`,
}))
assert(!longCodePreview.includes('`'), 'progress folding must not cut through or partially expose inline code')

const emojiPreview = activeTraceProgressPreview(event(41, 'reasoning_summary', {
  text: `${'c'.repeat(1_198)}😀after`,
}))
const emojiBeforeEllipsis = emojiPreview.charCodeAt(emojiPreview.length - 2)
assert(
  emojiBeforeEllipsis < 0xD800 || emojiBeforeEllipsis > 0xDBFF,
  'progress folding must not leave an unmatched high surrogate before the ellipsis',
)

const multilinePreview = activeTraceProgressPreview(event(42, 'reasoning_summary', {
  text: Array.from({ length: 12 }, (_, index) => `Progress line ${index + 1}`).join('\n'),
}))
assert(
  multilinePreview.split('\n').length <= ACTIVE_TRACE_PROGRESS_LINE_LIMIT,
  'progress previews must remain within the visual line limit',
)
assert(multilinePreview.endsWith('…'), 'line-bounded progress should end with an ellipsis')

const postCompactionRows = projectTimeline([
  event(50, 'turn_started', { run_id: 'run-after-compaction', prompt: 'Keep working' }),
  event(51, 'tool_started', { run_id: 'run-after-compaction', tool: { id: 'tool-a', name: 'exec', input: {} } }),
  event(52, 'codex_compaction_completed', {
    operation_id: 'compact-live',
    message: 'Context compaction completed.',
  }),
  event(53, 'reasoning_summary', {
    run_id: 'run-after-compaction',
    phase: 'commentary',
    text: 'The release is still publishing.',
  }),
  event(54, 'reasoning_summary', {
    run_id: 'run-after-compaction',
    text: 'Checking the signed package.',
  }),
  event(55, 'reasoning_summary', {
    run_id: 'run-after-compaction',
    text: 'Verifying the release feed.',
  }),
], [])
const compactionMarkerIndex = postCompactionRows.findIndex(row =>
  row.kind === 'system' && row.event.type === 'codex_compaction_completed'
)
const postCompactionProgressIndex = postCompactionRows.findIndex(row => row.kind === 'progress')
assert(compactionMarkerIndex >= 0, 'expected a completed compaction marker')
assert(
  postCompactionProgressIndex > compactionMarkerIndex,
  'post-compaction reasoning must remain at the physical edge below the lifecycle marker',
)
const postCompactionProgress = postCompactionRows[postCompactionProgressIndex]
assert(
  postCompactionProgress.kind === 'progress'
  && postCompactionProgress.events.map(value => value.text).join('|')
    === 'The release is still publishing.',
  'private activity must not leak into commentary progress',
)
const postCompactionTrace = postCompactionRows.find(row => row.kind === 'trace')
assert(
  postCompactionTrace?.kind === 'trace'
  && postCompactionTrace.events
    .filter(value => value.type === 'reasoning_summary')
    .map(value => value.text).join('|') === 'Checking the signed package.|Verifying the release feed.',
  'private activity should remain available in the active trace',
)

const commentaryAfterActivity = projectTimeline([
  event(60, 'turn_started', { run_id: 'run-activity-first', prompt: 'Continue' }),
  event(61, 'reasoning_summary', { run_id: 'run-activity-first', text: 'Inspecting the implementation.' }),
  event(62, 'reasoning_summary', {
    run_id: 'run-activity-first',
    phase: 'commentary',
    text: 'I found the relevant code path.',
  }),
], []).find(row => row.kind === 'progress')
assert(
  commentaryAfterActivity?.kind === 'progress'
  && commentaryAfterActivity.events.map(value => value.text).join('|') === 'I found the relevant code path.',
  'internal activity older than the latest commentary must not be resurrected',
)

const newerCommentary = projectTimeline([
  event(70, 'turn_started', { run_id: 'run-new-commentary', prompt: 'Continue' }),
  event(71, 'reasoning_summary', {
    run_id: 'run-new-commentary',
    phase: 'commentary',
    text: 'I am checking the renderer.',
  }),
  event(72, 'reasoning_summary', { run_id: 'run-new-commentary', text: 'Inspecting the projection cache.' }),
  event(73, 'reasoning_summary', {
    run_id: 'run-new-commentary',
    phase: 'commentary',
    text: 'The renderer now follows the native event hierarchy.',
  }),
], []).find(row => row.kind === 'progress')
assert(
  newerCommentary?.kind === 'progress'
  && newerCommentary.events.map(value => value.text).join('|')
    === 'I am checking the renderer.|The renderer now follows the native event hierarchy.',
  'newer commentary must retire an older transient activity line',
)

const activityOnlyRows = projectTimeline([
  event(80, 'turn_started', { run_id: 'run-activity-only', prompt: 'Continue' }),
  event(81, 'reasoning_summary', { run_id: 'run-activity-only', text: 'Planning the next step.' }),
  event(82, 'reasoning_summary', { run_id: 'run-activity-only', text: 'Checking the current implementation.' }),
  event(83, 'codex_compaction_completed', {
    operation_id: 'compact-activity-only',
    message: 'Context compaction completed.',
  }),
], [])
const activityOnlyProgress = activityOnlyRows.find(row => row.kind === 'progress')
assert(
  activityOnlyProgress == null,
  'providers without explicit commentary must not expose private activity as assistant progress',
)
const activityOnlyTrace = activityOnlyRows.find(row => row.kind === 'trace')
assert(
  activityOnlyTrace?.kind === 'trace'
  && activityOnlyTrace.events.map(value => value.text).join('|')
    === 'Planning the next step.|Checking the current implementation.',
  'private-only activity must remain in the trace',
)

const restoredPartialRunRows = projectTimeline([
  event(84, 'codex_compaction_completed', {
    operation_id: 'compact-restored-tail',
    message: 'Context compaction completed.',
  }),
  event(85, 'reasoning_summary', {
    run_id: 'run-restored-tail',
    phase: 'commentary',
    text: 'Continuing after the app returned to foreground.',
  }),
], [])
const restoredPartialProgress = restoredPartialRunRows.find(row => row.kind === 'progress')
assert(
  restoredPartialProgress?.kind === 'progress'
  && rowText(restoredPartialProgress) === 'Continuing after the app returned to foreground.'
  && restoredPartialRunRows.at(-1) === restoredPartialProgress,
  'a bounded tail without turn_started must still restore the newest active progress at the live edge',
)

const answeredCommentary = projectTimeline([
  ...activeCommentaryEvents,
  event(43, 'assistant_text', { run_id: 'run-progress', text: 'Validation passed.' }),
], [])
const answeredTrace = answeredCommentary.find(row => row.kind === 'trace')
assert(answeredTrace?.kind === 'trace' && !answeredTrace.active, 'assistant output should retire the active commentary progress')
assert(activeTraceProgress(answeredTrace) === null, 'inactive traces must not expose stale commentary progress')
assert(activeTraceProgressEvents(answeredTrace).length === 0, 'answered traces must not expose a stale commentary window')
assert(!answeredCommentary.some(row => row.kind === 'progress'), 'assistant output must remove the live-edge progress row')

const answeredAfterCompactionRows = projectTimeline([
  event(50, 'turn_started', { run_id: 'run-final-after-compaction', prompt: 'Finish this' }),
  event(51, 'reasoning_summary', {
    run_id: 'run-final-after-compaction',
    text: 'Working before compaction.',
  }),
  event(52, 'codex_compaction_completed', {
    operation_id: 'compact-before-final',
    message: 'Context compaction completed.',
  }),
  event(53, 'reasoning_summary', {
    run_id: 'run-final-after-compaction',
    phase: 'commentary',
    text: 'Continuing after compaction.',
  }),
  event(54, 'turn_finished', {
    run_id: 'run-final-after-compaction',
    result_text: 'The final answer is ready.',
  }),
], [])
const finalAfterCompaction = answeredAfterCompactionRows.at(-1)
const answeredCompactionIndex = answeredAfterCompactionRows.findIndex(row =>
  row.kind === 'system' && row.event.type === 'codex_compaction_completed'
)
const answeredMessageIndex = answeredAfterCompactionRows.findIndex(row =>
  row.kind === 'message' && row.role === 'assistant'
)
assert(
  finalAfterCompaction?.kind === 'message'
  && finalAfterCompaction.role === 'assistant'
  && rowText(finalAfterCompaction) === 'The final answer is ready.',
  'terminal output after compaction must become the physical timeline bottom',
)
assert(
  answeredMessageIndex > answeredCompactionIndex,
  'the completed compaction marker must stay above later terminal output',
)
assert(
  !answeredAfterCompactionRows.some(row => row.kind === 'progress'),
  'terminal output after compaction must replace the live progress row',
)

const duplicateFinalAfterCompactionRows = projectTimeline([
  event(55, 'turn_started', { run_id: 'run-stream-before-compaction', prompt: 'Finish this too' }),
  event(56, 'assistant_text', {
    run_id: 'run-stream-before-compaction',
    text: 'Already streamed answer.',
  }),
  event(57, 'codex_compaction_completed', {
    operation_id: 'compact-after-stream',
    message: 'Context compaction completed.',
  }),
  event(58, 'turn_finished', {
    run_id: 'run-stream-before-compaction',
    result_text: 'Already streamed answer.',
  }),
], [])
assert(
  duplicateFinalAfterCompactionRows.at(-1)?.kind === 'message'
  && rowText(duplicateFinalAfterCompactionRows.at(-1)!) === 'Already streamed answer.',
  'a duplicate terminal aggregate must still keep its already-streamed answer below a later compaction marker',
)

const answeredAfterCompactionWithSuccessor = projectTimeline([
  event(50, 'turn_started', { run_id: 'run-final-after-compaction', prompt: 'Finish this' }),
  event(51, 'reasoning_summary', {
    run_id: 'run-final-after-compaction',
    text: 'Working before compaction.',
  }),
  event(52, 'codex_compaction_completed', {
    operation_id: 'compact-before-final',
    message: 'Context compaction completed.',
  }),
  event(53, 'reasoning_summary', {
    run_id: 'run-final-after-compaction',
    phase: 'commentary',
    text: 'Continuing after compaction.',
  }),
  event(54, 'turn_finished', {
    run_id: 'run-final-after-compaction',
    result_text: 'The final answer is ready.',
  }),
  event(55, 'turn_started', { run_id: 'run-successor', prompt: 'Next request' }),
  event(56, 'reasoning_summary', {
    run_id: 'run-successor',
    phase: 'commentary',
    text: 'Working on the next request.',
  }),
], [])
const completedTraceIndex = answeredAfterCompactionWithSuccessor.findIndex(row =>
  row.kind === 'trace' && row.runId === 'run-final-after-compaction'
)
const completedCompactionIndex = answeredAfterCompactionWithSuccessor.findIndex(row =>
  row.kind === 'system' && row.event.type === 'codex_compaction_completed'
)
const completedAnswerIndex = answeredAfterCompactionWithSuccessor.findIndex(row =>
  row.kind === 'message' && row.role === 'assistant' && rowText(row) === 'The final answer is ready.'
)
const nextRequestIndex = answeredAfterCompactionWithSuccessor.findIndex(row =>
  row.kind === 'message' && row.role === 'user' && rowText(row) === 'Next request'
)
assert(
  completedTraceIndex >= 0
  && completedTraceIndex < completedCompactionIndex
  && completedCompactionIndex < completedAnswerIndex
  && completedAnswerIndex < nextRequestIndex,
  'appending a successor with live progress must not reshuffle a completed answer above its trace or compaction marker',
)
assert(
  answeredAfterCompactionWithSuccessor.at(-1)?.kind === 'progress'
  && rowText(answeredAfterCompactionWithSuccessor.at(-1)!) === 'Working on the next request.',
  'the successor progress must remain the physical live edge after preserving older completed ordering',
)

const finishedCommentaryRows = projectTimeline([
  ...activeCommentaryEvents,
  event(43, 'turn_finished', { run_id: 'run-progress' }),
], [])
const finishedCommentary = finishedCommentaryRows.find(row => row.kind === 'trace')
assert(finishedCommentary?.kind === 'trace' && !finishedCommentary.active, 'turn completion without assistant text should still retire commentary progress')
assert(activeTraceProgressEvents(finishedCommentary).length === 0, 'finished traces must not expose a stale commentary window')
assert(!finishedCommentaryRows.some(row => row.kind === 'progress'), 'turn completion must remove live progress')

const stoppedCommentaryRows = projectTimeline([
  ...activeCommentaryEvents,
  event(43, 'turn_stopped', { run_id: 'run-progress', message: 'Stopped by user.' }),
], [])
const stoppedCommentary = stoppedCommentaryRows.find(row => row.kind === 'trace')
assert(stoppedCommentary?.kind === 'trace' && !stoppedCommentary.active, 'turn stop should retire commentary progress')
assert(activeTraceProgress(stoppedCommentary) === null, 'stopped traces must not expose stale commentary progress')
assert(activeTraceProgressEvents(stoppedCommentary).length === 0, 'stopped traces must not expose a stale commentary window')
assert(
  stoppedCommentary.events.map(value => value.text?.trim()).filter(Boolean).join('|') === 'Internal analysis',
  'stopped turns should keep private reasoning folded in the trace',
)
const stoppedAssistant = stoppedCommentaryRows.find(row => row.kind === 'message' && row.role === 'assistant')
assert(
  stoppedAssistant?.kind === 'message'
  && stoppedAssistant.events.map(value => value.text?.trim()).filter(Boolean).join('|')
    === 'Checking the release build.|Waiting for validation.|Uploading the validated build.|Waiting for TestFlight.|Build is ready for testing.',
  'completed commentary should become durable assistant output when a turn genuinely stops',
)
assert(!stoppedCommentaryRows.some(row => row.kind === 'progress'), 'stopped turns must remove live progress')
assert(
  stoppedCommentaryRows.some(row => row.kind === 'system' && row.key === 'turn:run-progress:stop'),
  'genuine stops should retain one stable lifecycle row',
)

const duplicateStoppedRows = projectTimeline([
  event(44, 'turn_started', { run_id: 'run-duplicate-stop', prompt: 'Stop once' }),
  event(45, 'turn_stopped', { run_id: 'run-duplicate-stop', message: 'Stopping.' }),
  event(46, 'turn_stopped', { run_id: 'run-duplicate-stop', message: 'Stopped.' }),
], []).filter(row => row.kind === 'system' && row.event.type === 'turn_stopped')
assert(
  duplicateStoppedRows.length === 1
  && duplicateStoppedRows[0].kind === 'system'
  && duplicateStoppedRows[0].event.message === 'Stopped.',
  'repeated stop packets should update one stable lifecycle row instead of duplicating it',
)

const stoppedFinishedRows = projectTimeline([
  ...activeCommentaryEvents,
  event(43, 'turn_finished', { run_id: 'run-progress', stopped: true }),
], [])
assert(
  stoppedFinishedRows.some(row => row.kind === 'message' && row.role === 'assistant'
    && row.events.filter(value => value.phase === 'commentary').length === 5),
  'a stopped turn_finished packet should preserve completed commentary too',
)
assert(!stoppedFinishedRows.some(row => row.kind === 'progress'), 'stopped turn completion must remove live progress')

const lateStoppedCommentaryRows = projectTimeline([
  event(90, 'turn_started', { run_id: 'run-late-stop', prompt: 'Stop soon' }),
  event(91, 'turn_stopped', { run_id: 'run-late-stop', message: 'Stopped by user.' }),
  event(92, 'reasoning_summary', {
    run_id: 'run-late-stop',
    phase: 'commentary',
    text: 'Last completed update.',
  }),
], [])
assert(
  lateStoppedCommentaryRows.some(row =>
    row.kind === 'message' && row.role === 'assistant' && rowText(row) === 'Last completed update.'
  ),
  'commentary delivered just after a stop packet must still become durable output',
)
assert(!lateStoppedCommentaryRows.some(row => row.kind === 'progress'), 'late stopped commentary must never revive progress')

const lateStoppedCommentaryWithSuccessor = projectTimeline([
  event(93, 'turn_started', { run_id: 'run-stopped-a', prompt: 'First request' }),
  event(94, 'turn_stopped', { run_id: 'run-stopped-a', message: 'Stopped by user.' }),
  event(95, 'turn_started', { run_id: 'run-current-b', prompt: 'Second request' }),
  event(96, 'reasoning_summary', {
    run_id: 'run-stopped-a',
    phase: 'commentary',
    text: 'Late completed update from the first request.',
  }),
], [])
const lateStoppedAssistantIndex = lateStoppedCommentaryWithSuccessor.findIndex(row =>
  row.kind === 'message' && row.role === 'assistant'
)
const lateStoppedStopIndex = lateStoppedCommentaryWithSuccessor.findIndex(row =>
  row.kind === 'system' && row.event.type === 'turn_stopped'
)
const successorUserIndex = lateStoppedCommentaryWithSuccessor.findIndex(row =>
  row.kind === 'message' && row.role === 'user' && rowText(row) === 'Second request'
)
assert(
  lateStoppedAssistantIndex >= 0
  && lateStoppedAssistantIndex < lateStoppedStopIndex
  && lateStoppedStopIndex < successorUserIndex,
  'late commentary from a stopped predecessor must remain grouped before its stop and successor',
)

const failedCommentary = projectTimeline([
  ...activeCommentaryEvents,
  event(43, 'error', { run_id: 'run-progress', message: 'Provider failed.' }),
], []).find(row => row.kind === 'trace')
assert(failedCommentary?.kind === 'trace' && !failedCommentary.active, 'terminal turn errors should retire commentary progress')
assert(activeTraceProgress(failedCommentary) === null, 'failed traces must not expose stale commentary progress')
assert(activeTraceProgressEvents(failedCommentary).length === 0, 'failed traces must not expose a stale commentary window')

const staleUnfinishedRows = projectTimeline([
  event(100, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
  event(101, 'reasoning_summary', {
    run_id: 'stale-run',
    phase: 'commentary',
    text: 'Old progress from a truncated run.',
  }),
  event(102, 'turn_started', { run_id: 'current-run', prompt: 'Current request' }),
], [])
assert(
  !staleUnfinishedRows.some(row => row.kind === 'progress'),
  'an older unfinished turn must never reappear as the live edge',
)

const currentProgressRows = projectTimeline([
  event(110, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
  event(111, 'reasoning_summary', {
    run_id: 'stale-run',
    phase: 'commentary',
    text: 'Old progress from a truncated run.',
  }),
  event(112, 'turn_started', { run_id: 'current-run', prompt: 'Current request' }),
  event(113, 'reasoning_summary', {
    run_id: 'current-run',
    phase: 'commentary',
    text: 'Current progress.',
  }),
], [])
const onlyCurrentProgress = currentProgressRows.filter(row => row.kind === 'progress')
assert(
  onlyCurrentProgress.length === 1
  && onlyCurrentProgress[0].kind === 'progress'
  && rowText(onlyCurrentProgress[0]) === 'Current progress.',
  'only the newest logical turn may own the live-edge progress row',
)

const operationalTrace = projectTimeline([
  event(40, 'turn_started', { run_id: 'run-operational', prompt: 'Run a long task' }),
  event(41, 'idle_warning', { run_id: 'run-operational', idle_seconds: 90 }),
  event(42, 'artifact_error', { run_id: 'run-operational', error: 'Manifest file was missing.' }),
], [])
const operationalTraceRow = operationalTrace.find(row => row.kind === 'trace')
assert(operationalTraceRow?.kind === 'trace', 'idle and artifact diagnostics should stay in the run trace')
assert(
  operationalTraceRow.events.map(value => value.type).join('|') === 'idle_warning|artifact_error',
  'expected both operational trace types to remain ordered in the active run',
)
assert(
  !operationalTrace.some(row => row.kind === 'system'),
  'artifact diagnostics attached to a run should not escape into a separate system row',
)

const stressEvents: Event[] = [event(100, 'turn_started', { run_id: 'run-stress', prompt: 'Stress test' })]
for (let index = 0; index < 5_000; index += 1) {
  stressEvents.push(event(101 + index, 'assistant_text', { run_id: 'run-stress', text: `Unique assistant update ${index}` }))
}
const stressStartedAt = performance.now()
const stressRows = projectTimeline(stressEvents, [])
const stressElapsed = performance.now() - stressStartedAt
const stressAssistant = stressRows.find(row => row.kind === 'message' && row.role === 'assistant')
assert(stressAssistant?.kind === 'message' && stressAssistant.events.length === 5_000, 'expected the stress turn to preserve every unique assistant update')
assert(stressElapsed < 1_500, `expected near-linear assistant projection, took ${Math.round(stressElapsed)}ms`)

const completedTurnStressEvents: Event[] = []
for (let index = 0; index < 600; index += 1) {
  const base = 10_000 + index * 4
  const runId = `completed-run-${index}`
  completedTurnStressEvents.push(
    event(base, 'turn_started', { run_id: runId, prompt: `Prompt ${index}` }),
    event(base + 1, 'assistant_text', { run_id: runId, text: `Answer ${index}` }),
    event(base + 2, 'codex_compaction_completed', { operation_id: `compaction-${index}`, message: `Compacted ${index}` }),
    event(base + 3, 'turn_finished', { run_id: runId, result_text: `Answer ${index}` }),
  )
}
const completedTurnStressStartedAt = performance.now()
const completedTurnStressRows = projectTimeline(completedTurnStressEvents, [])
const completedTurnStressElapsed = performance.now() - completedTurnStressStartedAt
assert(completedTurnStressRows.length === 1_800, `expected three rows for each completed stress turn, received ${completedTurnStressRows.length}`)
for (let index = 0; index < 600; index += 1) {
  const assistantIndex = completedTurnStressRows.findIndex(row => row.key === `turn:completed-run-${index}:assistant`)
  const compactionIndex = completedTurnStressRows.findIndex(row => row.key === `codex:compaction:compaction-${index}`)
  assert(compactionIndex >= 0 && assistantIndex === compactionIndex + 1, `completed answer ${index} must remain immediately after its compaction marker`)
}
assert(completedTurnStressElapsed < 1_500, `expected near-linear completed-turn placement, took ${Math.round(completedTurnStressElapsed)}ms`)

console.log('timeline projection regressions passed')
