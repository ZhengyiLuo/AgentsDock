import type { Event } from './types'
import { isImportedCodexGoalContext } from './provider-origin'

export const SEMANTIC_HIDDEN_EVENT_TYPES = [
  'turn_queued',
  'turn_unqueued',
  'turn_queue_updated',
  'turn_queue_reordered',
  'turn_queue_run_now',
  'queue_snapshot',
  'subagent_state',
  'job_updated',
  'job_deleted',
  'file_uploaded',
  'raw_event',
  // Native thread status is durable runtime/header state. It is deliberately
  // not transcript content and must not consume history page slots.
  'codex_thread_status',
  // Goal state belongs to the persistent Codex controls, not the transcript.
  'codex_goal_updated',
  'codex_goal_cleared',
  // Usage is durable control/header state, not a transcript row.
  'codex_token_usage',
  // Durable acknowledgement of an internal SDK context hook, not chat content.
  'claude_background_task_reconciliation_consumed',
] as const

export const SEMANTIC_JOB_EVENT_TYPES = [
  'job_created',
  'job_ran',
  'job_started',
  'job_deferred',
  'job_finished',
  'job_error'
] as const

const hiddenTypes = new Set<string>(SEMANTIC_HIDDEN_EVENT_TYPES)
const jobTypes = new Set<string>(SEMANTIC_JOB_EVENT_TYPES)

export interface TimelineSemanticUnit {
  key: string
  anchorSeq: number
  events: Event[]
}

/** A genuine user boundary within one still-running native Codex goal owner. */
export function isNativeGoalSteerEvent(event: Event): boolean {
  return event.type === 'turn_steered'
    && event.native_goal_steer === true
    && event.native_steer === true
    && event.backend === 'codex'
    && event.purpose === 'codex_goal_resume'
    && event.provider_user_authored === true
    && Boolean(event.run_id?.trim())
}

export function timelineSemanticUnits(events: Event[]): TimelineSemanticUnit[] {
  const ordered = events.filter(event => !isImportedCodexGoalContext(event)).sort((left, right) => left.seq - right.seq)
  const occurrenceByEvent = new Map<Event, Map<string, string>>()
  const currentOccurrenceByRun = new Map<string, { key: string; started: boolean }>()
  for (const event of ordered) {
    const primaryRunId = event.run_id?.trim() || ''
    const stableOccurrenceId = semanticJobOccurrenceIdentity(event)
    if (primaryRunId) {
      let occurrence = currentOccurrenceByRun.get(primaryRunId)
      if (stableOccurrenceId) {
        const stable = {
          key: `${primaryRunId}\0occurrence:${stableOccurrenceId}`,
          started: event.type === 'turn_started'
        }
        if (!occurrence || occurrence.key === stable.key || event.type === 'turn_started') {
          currentOccurrenceByRun.set(primaryRunId, stable)
        }
      } else if (!occurrence) {
        occurrence = { key: primaryRunId, started: event.type === 'turn_started' }
      } else if (event.type === 'turn_started') {
        occurrence = occurrence.started
          ? { key: `${primaryRunId}\0start:${event.seq}`, started: true }
          : { ...occurrence, started: true }
      }
      if (!stableOccurrenceId && occurrence) currentOccurrenceByRun.set(primaryRunId, occurrence)
    }
    const eventOccurrences = new Map<string, string>()
    for (const runId of semanticEventJobRunIds(event)) {
      if (stableOccurrenceId) {
        eventOccurrences.set(runId, `${runId}\0occurrence:${stableOccurrenceId}`)
        continue
      }
      let occurrence = currentOccurrenceByRun.get(runId)
      if (!occurrence) {
        occurrence = { key: runId, started: false }
        currentOccurrenceByRun.set(runId, occurrence)
      }
      eventOccurrences.set(runId, occurrence.key)
    }
    occurrenceByEvent.set(event, eventOccurrences)
  }

  const jobByOccurrence = new Map<string, string>()
  const jobGroupByOccurrence = new Map<string, string>()
  const jobByExplicitGroup = new Map<string, string>()
  for (const event of ordered) {
    const jobId = explicitSemanticEventJobId(event)
    const groupId = event.job_timeline_group_id?.trim() || ''
    if (jobId && groupId) jobByExplicitGroup.set(groupId, jobId)
    for (const runId of semanticEventJobRunIds(event)) {
      const occurrenceKey = occurrenceByEvent.get(event)?.get(runId) || runId
      if (jobId) jobByOccurrence.set(occurrenceKey, jobId)
      if (groupId) jobGroupByOccurrence.set(occurrenceKey, groupId)
    }
  }

  const units = new Map<string, TimelineSemanticUnit>()
  const jobIdByGroup = new Map<string, string>()
  const latestGroupByJob = new Map<string, string>()
  const segmentCountByJob = new Map<string, number>()
  const goalSegmentByRun = new Map<string, string>()
  let latestCreatedKey: string | null = null
  for (const event of ordered) {
    const runId = event.run_id?.trim() || ''
    if (isNativeGoalSteerEvent(event)) goalSegmentByRun.set(runId, `run:${runId}:start-${event.seq}`)
    const explicitJobId = explicitSemanticEventJobId(event)
    const stableOccurrenceId = semanticJobOccurrenceIdentity(event)
    const occurrenceKey = occurrenceByEvent.get(event)?.get(runId) || (
      stableOccurrenceId && explicitJobId
        ? `${explicitJobId}\0occurrence:${stableOccurrenceId}`
        : runId
    )
    const jobId = explicitJobId || jobByOccurrence.get(occurrenceKey) || (
      event.purpose === 'scheduled_job' ? runId : ''
    )
    // Native steering retires an ordinary logical chat turn invisibly. When
    // the interrupted run is a scheduled job, however, turn_stopped is its
    // durable terminal status and must remain in the job semantic unit.
    if (hiddenTypes.has(event.type) || (isNativeSteerTransitionStop(event) && !jobId)) continue
    let key = ''
    // A team send receipt has its own durable system-row identity. It carries
    // the originating run_id for auditability, but must never be folded into
    // that run (or its scheduled-job card) when semantic history is rebuilt.
    if (event.type === 'team_message_sent') {
      key = `event:${event.id || event.seq}`
    } else if (jobId) {
      const occurrenceGroupId = jobGroupByOccurrence.get(occurrenceKey) || ''
      key = event.job_timeline_group_id?.trim() || (
        !occurrenceGroupId
        || !jobByExplicitGroup.get(occurrenceGroupId)
        || jobByExplicitGroup.get(occurrenceGroupId) === jobId
          ? occurrenceGroupId
          : ''
      )
      if (!key && event.type === 'job_summary') key = latestGroupByJob.get(jobId) || ''
      if (!key && latestCreatedKey && jobIdByGroup.get(latestCreatedKey) === jobId) {
        key = latestCreatedKey
      }
      if (!key) {
        const segmentCount = segmentCountByJob.get(jobId) ?? 0
        key = segmentCount === 0
          ? `job:${jobId}`
          : `job:${jobId}:segment:${event.seq}`
        segmentCountByJob.set(jobId, segmentCount + 1)
      }
      jobIdByGroup.set(key, jobId)
      if (occurrenceKey) jobGroupByOccurrence.set(occurrenceKey, key)
      for (const linkedRunId of semanticEventJobRunIds(event)) {
        const linkedOccurrence = occurrenceByEvent.get(event)?.get(linkedRunId) || linkedRunId
        jobGroupByOccurrence.set(linkedOccurrence, key)
      }
    } else {
      key = timelineSemanticUnitKey(event)
      if (key === `run:${runId}`) key = goalSegmentByRun.get(runId) ?? key
    }
    const current = units.get(key)
    if (current) {
      current.events.push(event)
      current.anchorSeq = anchorsAtLatestEvent(key)
        ? Math.max(current.anchorSeq, event.seq)
        : Math.min(current.anchorSeq, event.seq)
    } else {
      units.set(key, { key, anchorSeq: event.seq, events: [event] })
      latestCreatedKey = key
      if (jobId) latestGroupByJob.set(jobId, key)
    }
  }
  return [...units.values()]
    .map(unit => ({ ...unit, events: unit.events.sort((left, right) => left.seq - right.seq) }))
    .sort((left, right) => left.anchorSeq - right.anchorSeq)
}

export function timelineSemanticItemCount(events: Event[]): number {
  return timelineSemanticUnits(events).length
}

export function incompleteLeadingRunId(events: Event[]): string | null {
  const ordered = events.filter(event => !isImportedCodexGoalContext(event)).sort((left, right) => left.seq - right.seq)
  const runId = ordered
    .map(event => event.run_id?.trim() || '')
    .find(Boolean)
  if (!runId) return null
  return ordered.some(event => (event.type === 'turn_started' || isNativeGoalSteerEvent(event)) && event.run_id?.trim() === runId)
    ? null
    : runId
}

function timelineSemanticUnitKey(event: Event): string {
  const digestId = event.digest_job_id?.trim()
  if (digestId && (event.purpose === 'handoff_digest' || event.type.startsWith('handoff_digest_'))) {
    return `digest:${digestId}`
  }
  const codexLifecycleKey = codexLifecycleSemanticKey(event)
  if (codexLifecycleKey) return codexLifecycleKey
  const interactionAuditKey = providerInteractionAuditKey(event)
  if (interactionAuditKey) return interactionAuditKey
  const crossChatKey = crossChatSemanticUnitKey(event)
  if (crossChatKey) return crossChatKey
  const runId = event.run_id?.trim() || ''
  const jobId = explicitSemanticEventJobId(event)
  if (jobId) return `job:${jobId}`
  if (jobTypes.has(event.type) || event.purpose === 'scheduled_job') {
    return `job:${runId || `event-${event.id || event.seq}`}`
  }
  if (isSemanticTimelineError(event)) return `event:${event.id || event.seq}`
  return runId ? `run:${runId}` : `event:${event.id || event.seq}`
}

/**
 * Provider interaction events are durable audit records, not one transcript
 * card per request transition. The active request remains available through
 * the provider interaction shelf; history pagination treats the lifecycle as
 * one compact provider audit unit.
 */
export function providerInteractionAuditKey(event: Event): string | null {
  const match = /^(claude|codex|cursor)_interaction_(?:requested|resolved)$/.exec(event.type)
  if (!match) return null
  const runKey = event.run_id?.trim() || event.turn_id?.trim() || 'session'
  return `provider-interaction-audit:${match[1]}:${runKey}`
}

/**
 * Pagination keeps a delivered handoff card and its internal target turn
 * together. Every leg in a V2 exchange shares one semantic unit so paging can
 * never split the visible agent conversation into separate cards. The target
 * assistant answer remains ordinary chat output.
 */
function crossChatSemanticUnitKey(event: Event): string | null {
  const projectedKey = crossChatSemanticKey(event)
  if (projectedKey) return projectedKey
  if (event.purpose !== 'cross_chat_handoff_delivery') return null
  const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim()
  if (exchangeId) {
    return `cross-chat-exchange:${exchangeId}`
  }
  const handoffId = event.cross_chat_envelope_id?.trim()
  return handoffId ? `cross-chat:handoff:${handoffId}` : null
}

/** Lifecycle events for one handoff/watch or V2 exchange share one row. */
export function crossChatSemanticKey(event: Event): string | null {
  if (isAsyncCrossChatMessage(event)) {
    const envelopeId = event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || event.message_id?.trim()
    return envelopeId ? `cross-chat:handoff:${envelopeId}` : null
  }
  if (!event.type.startsWith('cross_chat_')) return null
  const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim()
  if (exchangeId && event.type.startsWith('cross_chat_exchange_')) {
    return `cross-chat-exchange:${exchangeId}`
  }
  const watchId = event.watch_id?.trim()
  if (watchId && event.type.startsWith('cross_chat_watch_')) return `cross-chat:watch:${watchId}`
  const handoffId = event.handoff_id?.trim() || event.correlation_id?.trim()
  if (handoffId) return `cross-chat:handoff:${handoffId}`
  if (watchId) return `cross-chat:watch:${watchId}`
  return null
}

/** Only the negotiated one-way envelope protocol uses individual message cards. */
export function isAsyncCrossChatMessage(event: Event): boolean {
  return event.conversation_mode === 'async_route_v1'
    && (/^chat_conversation_message_(registered|received|queued|started|delivered|cancelled|failed)$/.test(event.type)
      || event.delivery_mode === 'mailbox' && /^chat_conversation_message_(mailbox_migrated|read|deleted)$/.test(event.type))
}

export function isNativeSteerTransitionStop(event: Event): boolean {
  return event.type === 'turn_stopped' && (
    event.native_steer === true
    || Boolean(event.superseded_by_run_id?.trim())
  )
}

/**
 * A Codex compaction and a goal-budget warning are compact semantic timeline
 * markers. Compaction start/completion events share one stable identity so a
 * live "Compacting" row can become "Compacted" without changing position.
 */
export function codexLifecycleSemanticKey(event: Event): string | null {
  if (event.type === 'codex_goal_budget_limited') return 'codex:goal-budget'
  if (event.type === 'codex_compaction_started' || event.type === 'codex_compaction_completed') {
    const compactionId = event.compaction_id?.trim()
    if (compactionId) return `codex:compaction:${compactionId}`
    const operationId = event.operation_id?.trim()
    if (operationId) return `codex:compaction:${operationId}`
    const nativeId = event.turn_id?.trim() || event.item_id?.trim() || event.id || String(event.seq)
    return `codex:compaction:${nativeId}`
  }
  return null
}

function anchorsAtLatestEvent(key: string): boolean {
  return (
    key.startsWith('provider-interaction-audit:')
    || key.startsWith('codex:') && !key.startsWith('codex:compaction:')
  )
}

function explicitSemanticEventJobId(event: Event): string {
  return event.job_id?.trim() || event.job?.id?.trim() || ''
}

function semanticEventJobRunIds(event: Event): string[] {
  return [...new Set([
    event.run_id,
    event.job_status_run_id,
    event.job_latest_status_run_id,
    event.job_latest_run_id
  ].map(value => value?.trim() || '').filter(Boolean))]
}

function semanticJobOccurrenceIdentity(event: Event): string {
  const explicit = event.job_occurrence_id?.trim() || ''
  if (explicit) return `id:${explicit.slice(0, 160)}`
  const scheduledAt = event.job_scheduled_run_at ?? event.job?.scheduled_run_at
  if (scheduledAt != null && Number.isFinite(Number(scheduledAt))) {
    return `scheduled:${Number(scheduledAt).toFixed(6)}`
  }
  const scheduledAtIso = event.job_scheduled_run_at_iso?.trim()
    || event.job?.scheduled_run_at_iso?.trim()
    || ''
  return scheduledAtIso ? `scheduled-iso:${scheduledAtIso.slice(0, 160)}` : ''
}

function isSemanticTimelineError(event: Event): boolean {
  if (event.type === 'tool_started' || event.type === 'tool_finished' || event.type === 'raw_event') return false
  return event.type === 'error'
    || event.type.endsWith('_error')
    || event.is_error === true
    || Boolean(event.error)
}
