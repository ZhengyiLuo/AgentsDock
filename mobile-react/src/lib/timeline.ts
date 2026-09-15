import type { AgentFile, Event } from '../types'
import { messageText } from './format'
import { foldMarkdownSource } from './math'
import { importedCrossChatDelivery, type ImportedCrossChatDelivery } from './imported-cross-chat-delivery'
import { isChatMailboxEvent } from './chat-mailbox'
import { isVerifiedSilentHistory } from './history'
import { isNativeGoalSteerEvent } from './native-goal-steering'
import {
  hasProviderUserProvenance, isImportedHistoryRecord, isImportedClaudeControlCompanion,
  isImportedCodexRuntimeContext, isImportedProviderControlMetadata, isImportedProviderInterruption,
  isImportedSourceProvenRepair, isImportedSourceProvenAssistantReplay, isImportedSourceProvenNativeReplay,
} from './provider-origin'

export type TimelineRow = MessageRow | TraceRow | ProgressRow | MediaRow | SystemRow | JobRow
export interface MessageRow { kind: 'message'; key: string; seq: number; role: 'user' | 'assistant'; events: Event[]; files: AgentFile[] }
export interface TraceRow {
  kind: 'trace'; key: string; seq: number; events: Event[]; promotedCommentaryIds: string[]; runId?: string | null; active: boolean
  /** Preserve the unsplit live-commentary policy when only the last segment is active. */
  runActive?: boolean
  afterSeq?: number; throughSeq?: number; terminalSeq?: number; continues?: boolean
  toolStartSequences?: Readonly<Record<string, number>>
}
export interface ProgressRow {
  kind: 'progress'; key: string; seq: number; events: Event[]; hiddenCount: number
  afterSeq?: number; throughSeq?: number; continues?: boolean
}
export interface MediaRow { kind: 'media'; key: string; seq: number; files: AgentFile[] }
export interface SystemRow {
  kind: 'system'
  key: string
  seq: number
  event: Event
  /** Folded provider audit or cross-chat conversation lifecycle. */
  events?: Event[]
  /** Durable lifecycle packets represented by a semantically folded card. */
  representedEventIds?: string[]
  representedEventSeqs?: number[]
  /** Read-only imported content; contains no recovered route authority. */
  importedDelivery?: ImportedCrossChatDelivery
  /** Independent async messages use delivery-time placement and ordinary replies. */
  crossChatMessage?: boolean
  anchorTs?: string
  /** Adjacent passive messages from the exact same sender/recipient pair. */
  mailboxMessages?: SystemRow[]
}
export interface JobRow { kind: 'job'; key: string; seq: number; title: string; events: Event[]; jobId?: string; timelineGroupId?: string | null }

interface Turn {
  key: string
  runId?: string | null
  seq: number
  user?: Event
  assistant: Event[]
  assistantNormalizedSet: Set<string>
  trace: Event[]
  promotedCommentaryIds: string[]
  files: AgentFile[]
  finishedAt?: string
  finishedSeq?: number
  failedAt?: string
  stoppedAt?: string
  historical?: boolean
  /** Native goal messages divide display slices without replacing the run owner. */
  afterSeq?: number
  throughSeq?: number
  continues?: boolean
}

// A terminal exchange summary must override stale "active" leg packets, but
// cloning every leg on every timeline projection defeats FlashList row reuse.
// Reuse the normalized event for a given immutable server packet and status;
// the WeakMap releases entries with the snapshot that owns the packet.
const terminalNormalizedCrossChatEvents = new WeakMap<
  Event,
  Map<NonNullable<Event['exchange_status']>, Event>
>()
const importedDeliveryPresentationEvents = new WeakMap<Event, Event>()
const mailboxStateEvents = new WeakMap<Event, Map<NonNullable<Event['inbox_state']>, Event>>()
const interruptionPresentationEvents = new WeakMap<Event, Event>()

const hidden = new Set([
  'turn_queued',
  'turn_unqueued',
  'turn_queue_run_now',
  'queue_snapshot',
  // Queue, subagent, and scheduled-job bookkeeping updates the surrounding
  // controls/store. Legacy history pages may still contain these packets, but
  // they are not transcript content and must never become generic system rows.
  'turn_queue_updated',
  'turn_queue_reordered',
  'turn_queue_paused',
  'turn_queue_delivery_fenced',
  'history_imported',
  'subagent_state',
  'job_updated',
  'job_deleted',
  'emergency_alert_acknowledged',
  'claude_subagents_stopped',
  // App-server thread status is transient runtime state. The Codex status
  // control renders the current value; durable active/idle transitions would
  // otherwise become a misleading wall of historical transcript cards.
  'codex_thread_status',
  'codex_goal_updated',
  'codex_goal_cleared',
  'codex_token_usage',
  'codex_compaction_started',
])
const traces = new Set([
  'reasoning_summary', 'tool_started', 'tool_finished', 'raw_event', 'process_started',
  'provider_session', 'cwd_fallback', 'history_imported', 'backend_changed', 'artifact_error',
  'session_created', 'idle_warning', 'code_diff',
])
const jobs = new Set(['job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error'])

// Semantic job summaries can carry the current execution through one of the
// status/latest aliases while leaving run_id empty. Provider activity for that
// execution often omits job_id and purpose, so every advertised run identity
// must be linked before projection. This mirrors the Mac projector and keeps
// scheduled reasoning, tools, and output inside the job card.
function jobLinkedRunIds(event: Event): string[] {
  return [...new Set([
    event.run_id,
    event.job_status_run_id,
    event.job_latest_status_run_id,
    event.job_latest_run_id,
  ].map(value => value?.trim() || '').filter(Boolean))]
}

interface JobProjectionAssignment {
  jobId: string
  groupKey: string
}

/**
 * Mirror the Mac semantic projector: adjacent occurrences of one job share a
 * card, visible non-job content opens a new segment, and authoritative group
 * IDs/occurrence identities route late or recycled-run packets precisely.
 */
function jobProjectionAssignments(events: readonly Event[]): Map<Event, JobProjectionAssignment> {
  const ordered = events.filter(event => !isImportedProviderControlMetadata(event)).sort((left, right) => left.seq - right.seq)
  const occurrenceByEvent = new Map<Event, Map<string, string>>()
  const currentOccurrenceByRun = new Map<string, { key: string; started: boolean }>()
  for (const event of ordered) {
    const primaryRunId = event.run_id?.trim() || ''
    const stableOccurrenceId = jobOccurrenceIdentity(event)
    if (primaryRunId) {
      let occurrence = currentOccurrenceByRun.get(primaryRunId)
      if (stableOccurrenceId) {
        const startsOccurrence = event.type === 'turn_started' || event.type === 'job_ran' || event.type === 'job_started'
        const stable = { key: `${primaryRunId}\0occurrence:${stableOccurrenceId}`, started: startsOccurrence }
        if (!occurrence || occurrence.key === stable.key || startsOccurrence) currentOccurrenceByRun.set(primaryRunId, stable)
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
    for (const runId of jobLinkedRunIds(event)) {
      if (stableOccurrenceId) eventOccurrences.set(runId, `${runId}\0occurrence:${stableOccurrenceId}`)
      else {
        let occurrence = currentOccurrenceByRun.get(runId)
        if (!occurrence) {
          occurrence = { key: runId, started: false }
          currentOccurrenceByRun.set(runId, occurrence)
        }
        eventOccurrences.set(runId, occurrence.key)
      }
    }
    occurrenceByEvent.set(event, eventOccurrences)
  }

  const jobByOccurrence = new Map<string, string>()
  const groupByOccurrence = new Map<string, string>()
  const jobByExplicitGroup = new Map<string, string>()
  for (const event of ordered) {
    const jobId = String(event.job_id || event.job?.id || '').trim()
    const groupId = event.job_timeline_group_id?.trim() || ''
    if (jobId && groupId) jobByExplicitGroup.set(groupId, jobId)
    for (const runId of jobLinkedRunIds(event)) {
      const occurrence = occurrenceByEvent.get(event)?.get(runId) || runId
      if (jobId) jobByOccurrence.set(occurrence, jobId)
      if (groupId) groupByOccurrence.set(occurrence, groupId)
    }
  }

  const assignments = new Map<Event, JobProjectionAssignment>()
  const createdKeys = new Set<string>()
  const jobIdByGroup = new Map<string, string>()
  const latestGroupByJob = new Map<string, string>()
  const segmentCountByJob = new Map<string, number>()
  let latestCreatedKey: string | null = null
  for (const event of ordered) {
    if (hidden.has(event.type)) continue
    const runId = event.run_id?.trim() || ''
    const explicitJobId = String(event.job_id || event.job?.id || '').trim()
    const stableOccurrenceId = jobOccurrenceIdentity(event)
    const occurrence = occurrenceByEvent.get(event)?.get(runId) || (
      stableOccurrenceId && explicitJobId ? `${explicitJobId}\0occurrence:${stableOccurrenceId}` : runId
    )
    const topLevel = event.type === 'emergency_alert_raised'
      || isNativeGoalSteerEvent(event)
      || Boolean(providerInteractionAuditKey(event))
      || Boolean(codexLifecycleSemanticKey(event))
      || isHandoffDigestEvent(event)
      || event.type.startsWith('cross_chat_')
      || isAsyncCrossChatMessage(event)
    const jobId = topLevel ? '' : explicitJobId || jobByOccurrence.get(occurrence) || (event.purpose === 'scheduled_job' ? runId : '')
    if (!jobId) {
      const boundaryKey = providerInteractionAuditKey(event)
        || codexLifecycleSemanticKey(event)
        || crossChatSemanticKey(event)
        || (isNativeGoalSteerEvent(event) ? `turn:${event.run_id}:start-${event.seq}` : null)
        || (event.run_id ? `turn:${event.run_id}` : `event:${event.id}`)
      if (!createdKeys.has(boundaryKey)) {
        createdKeys.add(boundaryKey)
        latestCreatedKey = boundaryKey
      }
      continue
    }

    const occurrenceGroup = groupByOccurrence.get(occurrence) || ''
    let groupKey = event.job_timeline_group_id?.trim() || (
      !occurrenceGroup
      || !jobByExplicitGroup.get(occurrenceGroup)
      || jobByExplicitGroup.get(occurrenceGroup) === jobId
        ? occurrenceGroup
        : ''
    )
    if (!groupKey && event.type === 'job_summary') groupKey = latestGroupByJob.get(jobId) || ''
    if (!groupKey && latestCreatedKey && jobIdByGroup.get(latestCreatedKey) === jobId) groupKey = latestCreatedKey
    if (!groupKey) {
      const segmentCount = segmentCountByJob.get(jobId) ?? 0
      groupKey = segmentCount === 0 ? `job:${jobId}` : `job:${jobId}:segment:${event.seq}`
      segmentCountByJob.set(jobId, segmentCount + 1)
    }
    jobIdByGroup.set(groupKey, jobId)
    if (occurrence) groupByOccurrence.set(occurrence, groupKey)
    for (const linkedRunId of jobLinkedRunIds(event)) {
      groupByOccurrence.set(occurrenceByEvent.get(event)?.get(linkedRunId) || linkedRunId, groupKey)
    }
    assignments.set(event, { jobId, groupKey })
    if (!createdKeys.has(groupKey)) {
      createdKeys.add(groupKey)
      latestCreatedKey = groupKey
      latestGroupByJob.set(jobId, groupKey)
    }
  }
  return assignments
}

export function projectTimeline(events: Event[], knownFiles: AgentFile[]): TimelineRow[] {
  const filesById = new Map(knownFiles.map(file => [file.id, file]))
  const items: Array<Turn | SystemRow | JobRow> = []
  const turns = new Map<string, Turn>()
  const jobRows = new Map<string, JobRow>()
  const jobAssignments = jobProjectionAssignments(events)
  const jobTitles = new Map<string, string>()
  const digestRows = new Map<string, SystemRow>()
  const codexLifecycleRows = new Map<string, SystemRow>()
  const crossChatRows = new Map<string, SystemRow>()
  const crossChatRowsByExchange = new Map<string, Set<SystemRow>>()
  const crossChatTerminalStatusByExchange = new Map<string, NonNullable<Event['exchange_status']>>()
  const stopRows = new Map<string, SystemRow>()
  const providerInteractionRows = new Map<string, SystemRow>()
  const nativeGoalInputIds = new Set<string>()
  const nativeGoalInputKeys = new Set<string>()
  const queuedInputFileIds = new Map<string, string[]>()
  let active: Turn | null = null

  // Provider output from scheduled work does not always repeat job_title.
  for (const event of events) {
    const jobId = String(event.job_id || event.job?.id || '').trim()
    if (!jobId) continue
    const title = String(event.job_title || event.job?.title || '').trim()
    if (title) jobTitles.set(jobId, title)
  }

  const createTurn = (event: Event, key: string): Turn => {
    const turn: Turn = {
      key,
      runId: event.run_id,
      seq: event.seq,
      assistant: [],
      assistantNormalizedSet: new Set(),
      trace: [],
      promotedCommentaryIds: [],
      files: [],
      historical: isImportedHistoryRecord(event),
    }
    items.push(turn)
    return turn
  }

  const turnFor = (event: Event): Turn => {
    const id = event.run_id || active?.runId || `seq-${event.seq}`
    const existing = turns.get(id)
    if (existing) return existing
    const turn = createTurn(event, `turn:${id}`)
    turns.set(id, turn)
    return turn
  }

  const startTurn = (event: Event): Turn => {
    if (!isImportedHistoryTurn(event)) return turnFor(event)
    // One provider-history import intentionally reuses a single run_id for the
    // whole transcript. Each imported user event is nevertheless a distinct
    // turn. Key it by the durable event id so prepending older history cannot
    // renumber rows that are already on screen.
    const turn = createTurn(event, `turn:${event.run_id}:start:${event.id}`)
    turns.set(event.run_id!, turn)
    return turn
  }

  const appendDigestEvent = (event: Event): void => {
    const digestId = String(event.digest_job_id || '').trim()
    if (!digestId) return
    const existing = digestRows.get(digestId)
    if (existing) {
      const nextPriority = digestDisplayPriority(event)
      const currentPriority = digestDisplayPriority(existing.event)
      if (nextPriority > currentPriority || nextPriority === currentPriority && event.seq >= existing.event.seq) {
        existing.event = event
      }
      return
    }
    const row: SystemRow = { kind: 'system', key: `digest:${digestId}`, seq: event.seq, event }
    digestRows.set(digestId, row)
    items.push(row)
  }

  const appendCodexLifecycleEvent = (event: Event): boolean => {
    const key = codexLifecycleSemanticKey(event)
    if (!key) return false
    const existing = codexLifecycleRows.get(key)
    if (existing) {
      if (event.seq >= existing.event.seq) {
        existing.seq = event.seq
        existing.event = event
      }
      return true
    }
    const row: SystemRow = { kind: 'system', key, seq: event.seq, event }
    codexLifecycleRows.set(key, row)
    items.push(row)
    return true
  }

  const appendCrossChatEvent = (event: Event): boolean => {
    const key = crossChatSemanticKey(event)
    if (!key) return false

    const exchangeId = crossChatExchangeId(event)
    const eventTerminalStatus = crossChatTerminalStatus(event)
    if (exchangeId && eventTerminalStatus) {
      crossChatTerminalStatusByExchange.set(exchangeId, eventTerminalStatus)
      // A terminal exchange summary owns the state of every leg. Updating the
      // already-projected cards here prevents a stale late "active" packet
      // from resurrecting reply or cancel controls on an older page.
      for (const row of crossChatRowsByExchange.get(exchangeId) ?? []) {
        row.event = crossChatEventWithStatus(row.event, eventTerminalStatus)
        if (row.events) row.events = row.events.map(candidate => crossChatEventWithStatus(candidate, eventTerminalStatus))
      }
    }
    const terminalStatus = exchangeId
      ? crossChatTerminalStatusByExchange.get(exchangeId)
      : undefined
    const effectiveEvent = terminalStatus && event.exchange_status !== terminalStatus
      ? crossChatEventWithStatus(event, terminalStatus)
      : event
    const existing = crossChatRows.get(key)
    if (existing) {
      if (!existing.representedEventIds?.includes(effectiveEvent.id)) {
        existing.representedEventIds = [...existing.representedEventIds ?? [existing.event.id], effectiveEvent.id]
        existing.representedEventSeqs = [...existing.representedEventSeqs ?? [existing.event.seq], effectiveEvent.seq]
      }
      if (!existing.events?.some(candidate => candidate.id === effectiveEvent.id)) {
        existing.events = [...existing.events ?? [existing.event], effectiveEvent]
          .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
      }
      if (effectiveEvent.seq >= existing.event.seq) existing.event = effectiveEvent
      return true
    }
    const row: SystemRow = {
      kind: 'system',
      key,
      seq: effectiveEvent.seq,
      event: effectiveEvent,
      events: [effectiveEvent],
      representedEventIds: [effectiveEvent.id],
      representedEventSeqs: [effectiveEvent.seq],
    }
    crossChatRows.set(key, row)
    if (exchangeId) {
      const exchangeRows = crossChatRowsByExchange.get(exchangeId) ?? new Set<SystemRow>()
      exchangeRows.add(row)
      crossChatRowsByExchange.set(exchangeId, exchangeRows)
    }
    items.push(row)
    return true
  }

  for (const event of events) {
    if (isImportedClaudeControlCompanion(event) || isImportedSourceProvenAssistantReplay(event)
      || isImportedSourceProvenNativeReplay(event) && event.type !== 'turn_started') continue
    if (isImportedSourceProvenRepair(event) || isImportedSourceProvenNativeReplay(event)) {
      // One import can contain many logical inputs. Hide only the proven copy,
      // keeping an empty boundary so an unmatched answer remains independent.
      const previous = event.run_id ? turns.get(event.run_id) : undefined
      if (previous) { previous.finishedAt ||= event.ts; previous.finishedSeq ||= event.seq }
      active = startTurn(event)
      continue
    }
    if (isImportedCodexRuntimeContext(event)) continue
    if (isImportedProviderInterruption(event)) {
      const key = `provider-interruption:${event.session_id}:${event.provider_origin.event_id.toLowerCase()}`
      const existing = stopRows.get(key)
      if (existing) {
        existing.representedEventIds = [...existing.representedEventIds ?? [existing.event.id], event.id]
        existing.representedEventSeqs = [...existing.representedEventSeqs ?? [existing.event.seq], event.seq]
      } else {
        let presentation = interruptionPresentationEvents.get(event)
        if (!presentation) {
          presentation = { ...event, ts: event.provider_origin.timestamp, prompt: null, text: null, result_text: null }
          interruptionPresentationEvents.set(event, presentation)
        }
        const row: SystemRow = { kind: 'system', key, seq: event.seq,
          event: presentation }
        stopRows.set(key, row)
        items.push(row)
      }
      continue
    }
    const queuedInputKey = typeof event.session_id === 'string' && event.session_id.trim()
      && typeof event.queued_id === 'string' && event.queued_id.trim()
      ? JSON.stringify([event.session_id, event.queued_id]) : null
    if (queuedInputKey) {
      if (event.type === 'turn_queued' || event.type === 'turn_queue_updated' && event.file_ids != null) {
        const ids = event.file_ids ?? []
        if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.trim())) {
          queuedInputFileIds.set(queuedInputKey, [...ids])
        } else queuedInputFileIds.delete(queuedInputKey)
      } else if (event.type === 'turn_unqueued' || event.type === 'turn_started') {
        queuedInputFileIds.delete(queuedInputKey)
      }
    }
    const deliveredDigest = digestBody(event)
    if (deliveredDigest) {
      appendDigestEvent({
        ...event,
        type: 'handoff_digest_received',
        digest_job_id: `legacy-${event.run_id || event.id}`,
        digest: deliveredDigest,
        message: 'Context digest was delivered to this chat.',
      })
    }
    if (isHandoffDigestEvent(event)) {
      appendDigestEvent(event)
      continue
    }
    if (appendCrossChatEvent(event)) continue
    if (event.type.startsWith('chat_conversation_message_')) {
      // Unknown protocol versions remain ordinary audit content, never an
      // authenticated message card or a source of message-detail controls.
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
      continue
    }
    if (hidden.has(event.type)) continue
    const interactionKey = providerInteractionAuditKey(event)
    if (interactionKey) {
      const existing = providerInteractionRows.get(interactionKey)
      const grouped = [...new Map([...(existing?.events ?? []), event].map(candidate => [candidate.id, candidate])).values()].sort((left, right) => left.seq - right.seq)
      if (existing) {
        existing.events = grouped
        existing.event = grouped[grouped.length - 1]
        existing.seq = existing.event.seq
      } else {
        const row: SystemRow = { kind: 'system', key: interactionKey, seq: event.seq, event, events: grouped }
        providerInteractionRows.set(interactionKey, row)
        items.push(row)
      }
      continue
    }
    if (appendCodexLifecycleEvent(event)) continue
    if (isNativeSteerSupersession(event) && !jobAssignments.has(event)) {
      // Native turn/steer keeps one provider turn alive while creating a new
      // logical transcript turn. Retire only the superseded logical trace;
      // presenting this boundary as "Turn stopped" falsely implies failure.
      const superseded: Turn | null | undefined = event.run_id ? turns.get(event.run_id) : active
      if (superseded) {
        promoteNativeSteerCommentary(superseded)
        superseded.finishedAt ||= event.ts
        superseded.finishedSeq ||= event.seq
        if (active?.key === superseded.key) active = null
      }
      continue
    }
    // Emergency alerts are always chronological top-level transcript cards,
    // even when the server emits them from inside a scheduled job run.
    if (event.type === 'emergency_alert_raised') {
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
      continue
    }
    const jobAssignment = jobAssignments.get(event)
    if (jobAssignment) {
      const { jobId, groupKey } = jobAssignment
      const existing = jobRows.get(groupKey)
      const title = event.job_title || event.job?.title || jobTitles.get(jobId) || 'Scheduled job'
      if (existing) {
        if (!existing.events.some(candidate => candidate.id === event.id)) existing.events.push(event)
        existing.seq = Math.min(existing.seq, event.seq)
        if (existing.title === 'Scheduled job' && title !== 'Scheduled job') existing.title = title
      }
      else {
        const row: JobRow = { kind: 'job', key: groupKey, seq: event.seq, title, events: [event], jobId, timelineGroupId: event.job_timeline_group_id ?? null }
        jobRows.set(groupKey, row)
        items.push(row)
      }
      continue
    }
    if (event.type === 'turn_stopped') {
      const terminalTurn: Turn | null | undefined = event.run_id ? turns.get(event.run_id) : active
      if (terminalTurn) {
        promoteInterruptedCommentary(terminalTurn)
        terminalTurn.stoppedAt ||= event.ts
        terminalTurn.finishedAt = event.ts
        terminalTurn.finishedSeq = event.seq
        if (active?.key === terminalTurn.key) active = null
      }
      const stopKey = terminalTurn ? `${terminalTurn.key}:stop` : `event:${event.id}`
      const existingStop = stopRows.get(stopKey)
      if (existingStop) {
        if (event.seq >= existingStop.event.seq) existingStop.event = event
      } else {
        const stopRow: SystemRow = { kind: 'system', key: stopKey, seq: event.seq, event }
        stopRows.set(stopKey, stopRow)
        items.push(stopRow)
      }
      continue
    }
    const timelineError = isTimelineError(event)
    if (timelineError) {
      const terminalTurn: Turn | null = event.run_id ? turnFor(event) : active
      if (terminalTurn) {
        terminalTurn.finishedAt = event.ts
        terminalTurn.finishedSeq = event.seq
        terminalTurn.failedAt = event.ts
        if (active?.key === terminalTurn.key) active = null
      }
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
      continue
    }
    if (isNativeGoalSteerEvent(event)) {
      const key = `turn:${event.run_id}:start-${event.seq}`
      const identity = typeof event.id === 'string' && event.id.trim() ? `${event.session_id}\0${event.run_id}\0${event.id}` : null
      // HTTP and live-stream receipts can replay the same authoritative packet.
      // Never collapse different inputs merely because their text is equal.
      if ((identity && nativeGoalInputIds.has(identity)) || nativeGoalInputKeys.has(key)) continue
      if (identity) nativeGoalInputIds.add(identity)
      nativeGoalInputKeys.add(key)
      // Native acknowledgements may omit attachments. The exact same-chat
      // queued item owns its latest file selection, including an empty update.
      // This is presentation only: never infer files from text or another run.
      const queuedFiles = queuedInputKey ? queuedInputFileIds.get(queuedInputKey) : undefined
      const input = queuedFiles ? { ...event, file_ids: [...queuedFiles] } : event
      if (queuedInputKey) queuedInputFileIds.delete(queuedInputKey)
      const previous = turns.get(event.run_id!)
      if (previous) {
        previous.continues = !previous.finishedAt
        previous.finishedAt ||= event.ts
        previous.throughSeq = Math.min(previous.finishedSeq ?? event.seq - 1, event.seq - 1)
      }
      const next = createTurn(event, key)
      next.afterSeq = event.seq
      if (messageText(input).trim() || input.file_ids?.length) next.user = input
      for (const id of input.file_ids ?? []) {
        const file = filesById.get(id)
        if (file && nativeGoalFileBelongsToSession(file, event.session_id)
          && !next.files.some(value => value.id === id)) next.files.push(file)
      }
      turns.set(event.run_id!, next)
      active = next
      continue
    }
    if (event.type === 'turn_started') {
      const interruptedRunId = event.steer_interrupted_run_id?.trim()
      const predecessor = interruptedRunId ? turns.get(interruptedRunId) : null
      if (predecessor) {
        // Semantic history intentionally omits the native transition stop.
        // The successor link reconstructs the same presentation on reload.
        promoteNativeSteerCommentary(predecessor)
        predecessor.finishedAt ||= event.ts
        predecessor.finishedSeq ||= event.seq
        if (active?.key === predecessor.key) active = null
      }
      active = startTurn(event)
      // Sanitized provider-only transcript records remain useful attempt
      // boundaries, but must not leave an empty user bubble behind. Keep
      // attachment-only human turns visible.
      const hasVisibleUserContent = Boolean(messageText(event).trim() || event.file_ids?.length)
      if (!isInternalDeliveryTurn(event) && hasVisibleUserContent) active.user = event
      // Imported history can retain the original internal delivery purpose.
      // Recover only a verified historical envelope; live/unknown internal
      // prompts must remain hidden and cannot acquire conversation controls.
      else if (event.purpose === 'cross_chat_handoff_delivery' && importedCrossChatDelivery(event)) active.user = event
      for (const id of event.file_ids ?? []) {
        const file = filesById.get(id)
        if (file && !active.files.some(value => value.id === id)) active.files.push(file)
      }
      continue
    }
    if (event.type === 'assistant_text' || event.type === 'turn_finished') {
      const turn = turnFor(event)
      const text = event.type === 'turn_finished' ? event.result_text : event.text
      if (text?.trim()) appendAssistant(turn, event, text, event.type === 'turn_finished')
      if (event.type === 'turn_finished') {
        if (event.stopped) {
          promoteInterruptedCommentary(turn)
          turn.stoppedAt ||= event.ts
        }
        turn.finishedAt = event.ts
        turn.finishedSeq = event.seq
        if (active?.key === turn.key) active = null
      }
      continue
    }
    if (traces.has(event.type)) {
      const turn = turnFor(event)
      turn.trace.push(event)
      // The final commentary item can race slightly behind the stop packet.
      // Preserve it as visible assistant output just as the Mac projector does.
      if (turn.stoppedAt) promoteInterruptedCommentary(turn)
      continue
    }
    if (event.type === 'file_uploaded') {
      // Upload receipts populate the session file catalog, but they are still
      // composer drafts until a turn explicitly references their file IDs.
      // Associating an unscoped upload with whichever run is active makes the
      // draft appear as generated media before send and duplicates it on the
      // eventual user message.
      const file = event.artifact || event.file
      if (file) {
        if (!filesById.has(file.id)) filesById.set(file.id, file)
        // A history page can contain the owning turn before its upload receipt
        // while omitting the separate file catalog. Resolve that edge only by
        // the turn's explicit file_ids; never fall back to the active run.
        for (const item of items) {
          if (
            'kind' in item
            || !item.user?.file_ids?.includes(file.id)
            || isNativeGoalSteerEvent(item.user) && !nativeGoalFileBelongsToSession(file, item.user.session_id)
            || item.files.some(value => value.id === file.id)
          ) continue
          item.files.push(file)
        }
      }
      continue
    }
    if (event.type === 'artifact_created') {
      const file = event.artifact || event.file
      if (!file) continue
      // A publication receipt can arrive after a newer turn has already
      // started. Explicit run ownership must beat whichever turn is active.
      const turn = event.run_id ? turnFor(event) : active ?? turnFor(event)
      if (!turn.files.some(value => value.id === file.id)) turn.files.push(file)
      continue
    }
    if (event.run_id && active) { active.trace.push(event); continue }
    if (messageText(event).trim() || event.type === 'turn_stopped') {
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
    }
  }

  let currentTurn: Turn | null = null
  for (const item of items) {
    if ('kind' in item) continue
    if (!currentTurn || item.seq >= currentTurn.seq) currentTurn = item
  }

  const rows: TimelineRow[] = []
  let liveProgress: ProgressRow | null = null
  const completedAssistantRows: Array<{
    row: MessageRow
    mediaRow: MediaRow | null
    displaySeq: number
  }> = []
  // Pending incoming messages belong exclusively to the ordinary queue. Once
  // admitted, anchor them at execution start before ordering around user work.
  const displayItems = items.flatMap(item => {
    if (!('kind' in item) || item.kind !== 'system' || !(item.events ?? [item.event]).some(isAsyncCrossChatMessage)) return [item]
    // A later legacy compatibility receipt must not replace the negotiated
    // async lifecycle's status, identity, or body provenance (same as Mac).
    const asyncLifecycle = (item.events ?? [item.event]).filter(isAsyncCrossChatMessage)
    const mailboxLifecycle = asyncLifecycle.filter(isChatMailboxEvent)
    const lifecycle = mailboxLifecycle.length ? mailboxLifecycle : asyncLifecycle
    let latest = lifecycle.at(-1)!
    const incoming = latest.target_session_id === latest.session_id && latest.source_session_id !== latest.session_id
    const mailbox = mailboxLifecycle.length > 0
    if (mailbox) {
      const priority = { unread: 1, read: 2, cancelled: 3, deleted: 4 }
      const terminal = lifecycle.reduce<Event | undefined>((current, event) => event.inbox_state
        && priority[event.inbox_state] > (current?.inbox_state ? priority[current.inbox_state] : 0) ? event : current, undefined)
      if (terminal?.inbox_state && latest.inbox_state !== terminal.inbox_state) {
        let normalized = mailboxStateEvents.get(latest)
        if (!normalized) { normalized = new Map(); mailboxStateEvents.set(latest, normalized) }
        let effective = normalized.get(terminal.inbox_state)
        if (!effective) { effective = { ...latest, inbox_state: terminal.inbox_state }; normalized.set(terminal.inbox_state, effective) }
        latest = effective
      }
    }
    if (mailbox && incoming && latest.inbox_state === 'deleted') return []
    const arrived = incoming ? lifecycle.find(event => (
      mailbox && (event.type === 'chat_conversation_message_received' || event.type === 'chat_conversation_message_mailbox_migrated')
      || event.type === 'chat_conversation_message_started' || event.type === 'chat_conversation_message_delivered'
    )) : lifecycle[0]
    return arrived ? [{ ...item, seq: arrived.seq, anchorTs: mailbox ? latest.received_at || arrived.ts : arrived.ts, event: latest, events: lifecycle, crossChatMessage: true }] : []
  })
  for (const item of displayItems.sort((a, b) => a.seq - b.seq)) {
    if ('kind' in item) { rows.push(item); continue }
    const inputFileIds = new Set(item.user?.file_ids ?? [])
    const inputFiles = item.files.filter(file => inputFileIds.has(file.id))
    const outputFiles = item.files.filter(file => !inputFileIds.has(file.id))
    const mediaRow: MediaRow | null = outputFiles.length ? {
      kind: 'media',
      key: `${item.key}:media`,
      seq: outputFiles[0].seq ?? item.seq,
      files: outputFiles,
    } : null
    if (item.user) {
      const importedDelivery = importedCrossChatDelivery(item.user)
      if (importedDelivery) {
        let presentationEvent = importedDeliveryPresentationEvents.get(item.user)
        if (!presentationEvent) {
          presentationEvent = {
            ...item.user,
            type: 'cross_chat_imported_delivery',
            prompt: null,
            display_prompt: null,
            text: importedDelivery.body,
            source_title: importedDelivery.sender,
          }
          importedDeliveryPresentationEvents.set(item.user, presentationEvent)
        }
        rows.push({
          kind: 'system', key: `imported-cross-chat-delivery:${item.user.id}`, seq: item.user.seq,
          event: presentationEvent, importedDelivery,
        })
        if (inputFiles.length) rows.push({
          kind: 'media', key: `${item.key}:delivery-files`, seq: item.user.seq, files: inputFiles,
        })
      } else rows.push({ kind: 'message', key: `${item.key}:user`, seq: item.user.seq, role: 'user', events: [item.user], files: inputFiles })
    }
    if (item.assistant.length) {
      const assistantRow: MessageRow = {
        kind: 'message',
        key: `${item.key}:assistant`,
        // Keep the row's identity anchor stable while streamed/final packets
        // arrive. Its live-edge placement uses displaySeq separately below.
        seq: item.assistant[0].seq,
        role: 'assistant',
        events: item.assistant,
        files: [],
      }
      rows.push(assistantRow)
      if (
        item.finishedAt
        && !item.stoppedAt
        && !item.failedAt
      ) {
        completedAssistantRows.push({
          row: assistantRow,
          mediaRow,
          displaySeq: Math.max(item.assistant.at(-1)!.seq, item.finishedSeq ?? 0),
        })
      }
    }
    const traceActive = !item.historical && !item.finishedAt && item.assistant.length === 0
    // Commentary is public assistant progress while a turn is active. Private
    // reasoning stays in the trace, and commentary returns to the settled
    // trace after completion unless it was promoted into durable output.
    const traceEvents = traceActive
      ? item.trace.filter(event => event.phase !== 'commentary')
      : item.trace
    if (traceHasContent(traceEvents)) {
      rows.push({
        kind: 'trace',
        key: `${item.key}:trace`,
        seq: traceEvents[0].seq,
        events: traceEvents,
        promotedCommentaryIds: item.promotedCommentaryIds,
        runId: item.runId,
        active: traceActive,
        runActive: traceActive,
        terminalSeq: item.finishedSeq,
        ...(item.afterSeq !== undefined ? { afterSeq: item.afterSeq } : {}),
        ...(item.throughSeq !== undefined ? { throughSeq: item.throughSeq } : {}),
        ...(item.continues ? { continues: true } : {}),
      })
    }
    if (traceActive && currentTurn?.key === item.key) {
      const progress = activeTraceProgressEvents({ active: true, events: item.trace })
      if (progress.length) {
        const visibleProgress = progress.slice(-ACTIVE_TRACE_PROGRESS_VISIBLE_LIMIT)
        liveProgress = {
          kind: 'progress',
          // Reuse the eventual assistant identity so FlashList updates this
          // live surface in place when the final response arrives.
          key: `${item.key}:assistant`,
          seq: progress.at(-1)!.seq,
          events: visibleProgress,
          hiddenCount: progress.length - visibleProgress.length,
          ...(item.afterSeq !== undefined ? { afterSeq: item.afterSeq } : {}),
        }
      }
    }
    if (mediaRow) rows.push(mediaRow)
  }
  // A successful answer is displayed where its terminal packet occurred,
  // while its row sequence remains anchored to the first streamed text for
  // recycling. Keep output media in the same presentation group so an
  // artifact emitted before turn_finished cannot float above its answer.
  // Keys and anchor sequences stay unchanged for stable FlashList recycling.
  const orderedRows = placeCompletedAssistantRows(rows, completedAssistantRows)

  // Live commentary belongs at the physical edge of the active turn. Keeping
  // it after lifecycle markers and already-positioned completed answers mirrors
  // Mac without allowing a successor's progress to reshuffle older rows.
  return interleaveCrossChatMessages(liveProgress ? [...orderedRows, liveProgress] : orderedRows, completedAssistantRows)
}

function nativeGoalFileBelongsToSession(file: AgentFile, sessionId: string): boolean {
  const owner = String(file.session_id ?? '').trim()
  return !owner || owner === sessionId
}

function traceToolKey(event: Event): string {
  const id = event.tool_id?.trim() || event.tool?.id?.trim()
  return id ? `${event.run_id?.trim() || 'runless'}:${id}` : ''
}

/** Full trace pages may expose starts missing from the compact timeline sample. */
function traceToolStartSequences(events: readonly Event[], known: Readonly<Record<string, number>> = {}): Record<string, number> {
  const starts = { ...known }
  for (const event of events) {
    const key = traceToolKey(event)
    if (event.type === 'tool_started' && key) starts[key] = Math.min(starts[key] ?? event.seq, event.seq)
  }
  return starts
}

function traceEventSequence(event: Event, starts: Readonly<Record<string, number>>): number {
  return (event.type === 'tool_started' || event.type === 'tool_finished')
    ? starts[traceToolKey(event)] ?? event.seq : event.seq
}

/** Apply this to merged sampled/loaded trace events before display, copy or export. */
export function traceEventsWithinRow(row: TraceRow, events: readonly Event[]): Event[] {
  if (row.afterSeq === undefined && row.throughSeq === undefined) return events as Event[]
  const starts = traceToolStartSequences(events, row.toolStartSequences)
  return events.filter(event => {
    const seq = traceEventSequence(event, starts)
    return (row.afterSeq === undefined || seq > row.afterSeq)
      && (row.throughSeq === undefined || seq <= row.throughSeq)
  })
}

function firstAnchorAtOrAfter(anchors: readonly SystemRow[], seq: number): number {
  let low = 0, high = anchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (anchors[middle].seq < seq) low = middle + 1
    else high = middle
  }
  return low
}

/** A message divides presentation only; it does not finish the owning run. */
function splitActivityAtMessages(rows: TimelineRow[], messages: readonly SystemRow[], presentedAt: Map<string, number>): TimelineRow[] {
  return rows.flatMap((row): TimelineRow[] => {
    if (row.kind !== 'trace' && row.kind !== 'progress' && !(row.kind === 'message' && row.role === 'assistant')) return [row]
    const startSeq = Math.min(row.seq, ...row.events.map(event => event.seq))
    const endSeq = row.kind === 'trace'
      ? row.terminalSeq ?? (row.active ? Infinity : Math.max(row.seq, ...row.events.map(event => event.seq)))
      : row.kind === 'progress' ? Infinity : Math.max(row.seq, ...row.events.map(event => event.seq))
    const cuts = messages.slice(firstAnchorAtOrAfter(messages, startSeq), firstAnchorAtOrAfter(messages, endSeq))
    if (!cuts.length) return [row]
    const starts = row.kind === 'trace' ? traceToolStartSequences(row.events, row.toolStartSequences) : {}
    const originalPresentation = presentedAt.get(row.key)
    const buckets = Array.from({ length: cuts.length + 1 }, (): Event[] => [])
    for (const event of row.events) buckets[firstAnchorAtOrAfter(cuts, traceEventSequence(event, starts))].push(event)
    return buckets.flatMap((events, index): TimelineRow[] => {
      const last = index === cuts.length
      if (!events.length && !(last && (row.kind === 'progress' || row.kind === 'trace' && row.active))) return []
      const before = cuts[index - 1]
      const key = before ? `${row.key}:after:message:${before.key}` : row.key
      if (row.kind === 'message') {
        const seq = events[0].seq
        presentedAt.set(key, last ? originalPresentation ?? seq : seq)
        return [{ ...row, key, seq, events }]
      }
      const bounds = {
        key, seq: before ? before.seq : startSeq, events, continues: !last,
        afterSeq: before?.seq ?? row.afterSeq, throughSeq: last ? row.throughSeq : cuts[index].seq,
      }
      return row.kind === 'trace'
        ? [{ ...row, ...bounds, active: last && row.active, terminalSeq: last ? row.terminalSeq : undefined, toolStartSequences: starts }]
        : [{ ...row, ...bounds, hiddenCount: index === 0 ? row.hiddenCount : 0 }]
    })
  })
}

function interleaveCrossChatMessages(rows: TimelineRow[], completed: readonly { row: MessageRow; displaySeq: number; mediaRow: MediaRow | null }[]): TimelineRow[] {
  const messages = rows.filter((row): row is SystemRow => row.kind === 'system' && crossChatSemanticKey(row.event) !== null)
    .sort((left, right) => left.seq - right.seq)
  if (!messages.length) return rows
  const presentedAt = new Map<string, number>()
  for (const value of completed) {
    presentedAt.set(value.row.key, value.displaySeq)
    if (value.mediaRow) presentedAt.set(value.mediaRow.key, value.displaySeq)
  }
  const messageKeys = new Set(messages.map(row => row.key))
  const content = splitActivityAtMessages(rows.filter(row => !messageKeys.has(row.key)), messages, presentedAt)
    .sort((left, right) => (presentedAt.get(left.key) ?? left.seq) - (presentedAt.get(right.key) ?? right.seq))
  const bySequence = content.map((row, index) => ({ row, index }))
    .sort((left, right) => (presentedAt.get(left.row.key) ?? left.row.seq) - (presentedAt.get(right.row.key) ?? right.row.seq) || left.index - right.index)
  const buckets = Array.from({ length: content.length + 1 }, (): TimelineRow[] => [])
  let cursor = 0, lastIndex = -1
  for (const message of messages) {
    while (cursor < bySequence.length) {
      const { row, index } = bySequence[cursor]
      const seq = presentedAt.get(row.key) ?? row.seq
      if (seq > message.seq || seq === message.seq
        && (row.kind === 'trace' || row.kind === 'progress') && row.afterSeq === message.seq) break
      lastIndex = Math.max(lastIndex, index)
      cursor += 1
    }
    buckets[lastIndex + 1].push(message)
  }
  const ordered: TimelineRow[] = [...buckets[0]]
  for (let index = 0; index < content.length; index += 1) ordered.push(content[index], ...buckets[index + 1])
  return groupAdjacentMailboxRows(ordered)
}

function groupAdjacentMailboxRows(rows: TimelineRow[]): TimelineRow[] {
  const grouped: TimelineRow[] = []
  for (const row of rows) {
    if (row.kind !== 'system' || !isChatMailboxEvent(row.event)
      || !row.event.source_session_id || !row.event.target_session_id
      || row.event.target_session_id !== row.event.session_id || row.event.source_session_id === row.event.session_id) {
      grouped.push(row)
      continue
    }
    const previous = grouped.at(-1)
    const children = row.mailboxMessages ?? [row]
    if (previous?.kind === 'system' && previous.mailboxMessages
      && previous.event.source_session_id === row.event.source_session_id
      && previous.event.target_session_id === row.event.target_session_id) {
      previous.mailboxMessages.push(...children)
      previous.representedEventIds = [...previous.representedEventIds ?? [], ...row.representedEventIds ?? [row.event.id]]
      previous.representedEventSeqs = [...previous.representedEventSeqs ?? [], ...row.representedEventSeqs ?? [row.event.seq]]
    } else grouped.push({ ...row, mailboxMessages: [...children] })
  }
  return grouped
}

function jobOccurrenceIdentity(event: Event): string {
  const explicit = event.job_occurrence_id?.trim()
  if (explicit) return `id:${explicit.slice(0, 160)}`
  const scheduledAt = event.job_scheduled_run_at ?? event.job?.scheduled_run_at
  if (scheduledAt != null && Number.isFinite(Number(scheduledAt))) return `scheduled:${Number(scheduledAt).toFixed(6)}`
  const iso = event.job_scheduled_run_at_iso?.trim() || event.job?.scheduled_run_at_iso?.trim()
  return iso ? `scheduled-iso:${iso.slice(0, 160)}` : ''
}

/**
 * Relocate completed answers without repeatedly scanning and splicing the full
 * transcript. Each answer belongs immediately before the first remaining row
 * whose presentation sequence reaches its terminal packet; answers that share
 * an edge retain the legacy last-processed-first behavior. Media moves as one
 * adjacent group with its answer while the row identities and anchor sequences
 * remain unchanged for FlashList.
 */
function placeCompletedAssistantRows(
  rows: TimelineRow[],
  completed: Array<{ row: MessageRow; mediaRow: MediaRow | null; displaySeq: number }>,
): TimelineRow[] {
  if (!completed.length) return rows
  const rowKeys = new Set(rows.map(row => row.key))
  const placements = completed
    .map((value, order) => ({ ...value, order }))
    .filter(value => rowKeys.has(value.row.key))
    .sort((left, right) => left.displaySeq - right.displaySeq || right.order - left.order)
  if (!placements.length) return rows

  const relocatedKeys = new Set<string>()
  for (const placement of placements) {
    relocatedKeys.add(placement.row.key)
    if (placement.mediaRow) relocatedKeys.add(placement.mediaRow.key)
  }

  const ordered: TimelineRow[] = []
  let placementIndex = 0
  const appendPlacement = () => {
    const placement = placements[placementIndex++]!
    ordered.push(placement.row)
    if (placement.mediaRow) ordered.push(placement.mediaRow)
  }
  for (const row of rows) {
    if (relocatedKeys.has(row.key)) continue
    while (
      placementIndex < placements.length
      && placements[placementIndex]!.displaySeq <= row.seq
    ) appendPlacement()
    ordered.push(row)
  }
  while (placementIndex < placements.length) appendPlacement()
  return ordered
}

function promoteNativeSteerCommentary(turn: Turn): void {
  promoteInterruptedCommentary(turn)
}

function promoteInterruptedCommentary(turn: Turn): void {
  const commentary = turn.trace.filter(event => (
    event.type === 'reasoning_summary'
    && event.phase === 'commentary'
    && Boolean(event.text?.trim())
  ))
  if (!commentary.length) return

  const promotedIds = new Set(commentary.map(event => event.id))
  turn.trace = turn.trace.filter(event => !promotedIds.has(event.id))
  turn.promotedCommentaryIds = [...new Set([
    ...turn.promotedCommentaryIds,
    ...promotedIds,
  ])]
  const assistantIds = new Set(turn.assistant.map(event => event.id))
  for (const event of commentary) {
    if (assistantIds.has(event.id)) continue
    turn.assistant.push(event)
    assistantIds.add(event.id)
  }
  turn.assistant.sort((left, right) => left.seq - right.seq)
}

/** Empty transport-only history must never replace a displayable live tail. */
export function projectPresentableHistory(events: Event[], knownFiles: AgentFile[]): TimelineRow[] | null {
  const rows = projectTimeline(events, knownFiles)
  return rows.length || isVerifiedSilentHistory(events) ? rows : null
}

export const ACTIVE_TRACE_PROGRESS_CHARACTER_LIMIT = 1_200
export const ACTIVE_TRACE_PROGRESS_LINE_LIMIT = 8
export const ACTIVE_TRACE_PROGRESS_VISIBLE_LIMIT = 20

/**
 * Match the Mac live edge: only explicit commentary is assistant-facing live
 * progress. Private reasoning remains available in the trace disclosure.
 */
export function activeTraceProgressEvents(
  row: Pick<TraceRow, 'active' | 'events'>,
): Event[] {
  if (!row.active) return []
  return row.events.filter(event => (
    event.type === 'reasoning_summary'
    && event.phase === 'commentary'
    && Boolean(event.text?.trim())
  ))
}

/**
 * Bound inline progress without cutting a formula or code span. The complete
 * event remains available in the expanded trace.
 */
export function activeTraceProgressPreview(event: Pick<Event, 'text'>): string {
  const source = event.text?.trim() || ''
  if (!source) return ''

  let lineCutIndex = source.length
  let lineBreaks = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n') continue
    lineBreaks += 1
    if (lineBreaks === ACTIVE_TRACE_PROGRESS_LINE_LIMIT) {
      lineCutIndex = index
      break
    }
  }

  const visibleCharacterLimit = ACTIVE_TRACE_PROGRESS_CHARACTER_LIMIT - 1
  const requestedCutIndex = Math.min(lineCutIndex, visibleCharacterLimit)
  if (requestedCutIndex >= source.length) return source

  const fold = foldMarkdownSource(source, requestedCutIndex)
  return `${fold.visible.trimEnd()}…`
}

export function activeTraceProgress(row: TraceRow): Event | null {
  return activeTraceProgressEvents(row).at(-1) ?? null
}

export function isHandoffDigestEvent(event: Event): boolean {
  return Boolean(event.digest_job_id)
    && (event.purpose === 'handoff_digest' || event.type.startsWith('handoff_digest_'))
}

export function rowText(row: TimelineRow): string {
  if (row.kind === 'message') return row.events.map(messageText).map(value => value.trim()).filter(Boolean).join('\n\n')
  if (row.kind === 'trace') return row.events.map(messageText).filter(Boolean).join('\n')
  if (row.kind === 'progress') return row.events.map(messageText).map(value => value.trim()).filter(Boolean).join('\n\n')
  if (row.kind === 'system') return row.mailboxMessages
    ? row.mailboxMessages.map(child => child.event.message_body ?? child.event.handoff_preview ?? messageText(child.event)).join('\n\n')
    : messageText(row.event)
  if (row.kind === 'job') {
    const latest = latestJobDisplayEvent(row.events)
    return latest ? messageText(latest) || row.title : row.title
  }
  return row.files.map(file => file.title || file.filename).join(', ')
}

export interface JobResultPresentation {
  detail: string
  preview: string
  structured: boolean
}

const JOB_PREVIEW_CHARACTER_LIMIT = 240

/** Keep machine output useful on a phone without discarding its full detail. */
export function jobResultPresentation(event: Event): JobResultPresentation {
  const detail = messageText({ ...event, prompt: null }).trim() || 'Scheduled job started. Waiting for agent output.'
  const structured = parseStructuredResult(detail)
  if (structured != null) {
    return {
      detail: JSON.stringify(structured, null, 2),
      preview: structuredJobPreview(structured),
      structured: true,
    }
  }
  return {
    detail,
    preview: truncateJobPreview(detail.replace(/\s+/g, ' ').trim()),
    structured: false,
  }
}

export interface JobDisplaySelection {
  latest: Event | null
  latestSource: Event | null
  previous: Event[]
  updates: Event[]
}

/**
 * Prefer the semantic summary without rendering the same run output again in
 * history. Run identity, rather than result text, still owns normal dedupe.
 */
export function jobDisplaySelection(events: Event[]): JobDisplaySelection {
  const updates = jobDisplayEvents(events)
  const newestUpdate = updates.at(-1)
  const summary = [...events].reverse().find(event =>
    event.type === 'job_summary' && Boolean(messageText(event).trim())
  )
  if (!summary || (newestUpdate && summary.seq < newestUpdate.seq)) {
    const latest = newestUpdate ?? events.at(-1) ?? null
    return {
      latest,
      latestSource: latest,
      previous: newestUpdate ? updates.slice(0, -1) : [],
      updates,
    }
  }

  const summaryText = normalizeAssistantOutput(messageText(summary))
  let duplicateIndex = -1
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    if (normalizeAssistantOutput(messageText(updates[index])) === summaryText) {
      duplicateIndex = index
      break
    }
  }
  return {
    latest: summary,
    latestSource: duplicateIndex >= 0 ? updates[duplicateIndex] : summary,
    previous: updates.filter((_event, index) => index !== duplicateIndex),
    updates,
  }
}

/** Prefer the server's semantic summary when it covers the newest job state. */
export function latestJobDisplayEvent(events: Event[]): Event | null {
  return jobDisplaySelection(events).latest
}

export function jobRunCount(events: Event[]): number {
  const runFirstSeq = new Map<string, number>()
  let reported = 0
  let reportedAtSeq = 0
  for (const event of events) {
    const runId = String(event.run_id || '').trim()
    if (runId) {
      const current = runFirstSeq.get(runId)
      if (current == null || event.seq < current) runFirstSeq.set(runId, event.seq)
    }
    for (const candidate of [event.job_run_count, event.job?.run_count]) {
      if (
        typeof candidate === 'number'
        && Number.isFinite(candidate)
        && candidate >= 0
        && event.seq >= reportedAtSeq
      ) {
        reported = Math.floor(candidate)
        reportedAtSeq = event.seq
      }
    }
  }
  const runsAfterSummary = reportedAtSeq
    ? [...runFirstSeq.values()].filter(seq => seq > reportedAtSeq).length
    : 0
  return Math.max(runFirstSeq.size, reported + runsAfterSummary)
}

export function jobDisplayEvents(events: Event[]): Event[] {
  const standalone: Event[] = []
  const byRun = new Map<string, Event>()
  for (const event of events) {
    const runId = String(event.run_id || '').trim()
    if (!runId) {
      if (jobDisplayPriority(event)) standalone.push(event)
      continue
    }
    const priority = jobDisplayPriority(event)
    if (!priority) continue
    const current = byRun.get(runId)
    const currentPriority = current ? jobDisplayPriority(current) : 0
    if (!current || priority > currentPriority || priority === currentPriority && event.seq >= current.seq) {
      byRun.set(runId, event)
    }
  }
  return [...standalone, ...byRun.values()].sort((left, right) => left.seq - right.seq)
}

/** Merge lazy and bundled run history newest-first without duplicate attempts. */
export function mergeJobHistoryEvents(...groups: Event[][]): Event[] {
  const byRun = new Map<string, Event>()
  for (const event of groups.flat()) {
    const key = jobRunIdentity(event) ?? `event:${event.id}`
    const current = byRun.get(key)
    if (!current || event.seq > current.seq) byRun.set(key, event)
  }
  return [...byRun.values()].sort((left, right) => right.seq - left.seq)
}

/**
 * Stable identity shared by bundled timeline events and the server's
 * synthesized lazy-history representatives. Runless scheduler attempts use
 * their authoritative lifecycle sequence because their transport IDs differ.
 */
export function jobRunIdentity(event: Event): string | null {
  const runId = String(
    event.job_status_run_id
    || event.job_latest_status_run_id
    || event.job_latest_run_id
    || event.run_id
    || ''
  ).trim()
  if (runId) return `run:${runId}:status:${jobStatusSequence(event)}`
  if (!jobStatusEvent(event) && jobDisplayPriority(event) <= 0) return null
  const jobId = String(event.job_id || '').trim()
  if (!jobId) return `event:${event.id}`
  return `status:${jobId}:${jobStatusSequence(event)}`
}

export type JobRunStatusTone = 'completed' | 'running' | 'queued' | 'stopped' | 'error' | 'updated'
export interface JobRunStatus { label: string; tone: JobRunStatusTone }

export function latestJobStatusEvent(events: Event[]): Event | null {
  interface Candidate {
    event: Event
    statusSeq: number
    terminal: boolean
    authoritative: boolean
  }
  const byRun = new Map<string, Candidate>()
  const standalone: Candidate[] = []
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (!jobStatusEvent(event)) continue
    const runId = String(
      event.job_status_run_id
      || event.job_latest_status_run_id
      || event.job_latest_run_id
      || event.run_id
      || ''
    ).trim()
    const statusSeq = jobStatusSequence(event)
    const tone = jobRunStatus(event).tone
    const candidate: Candidate = {
      event,
      statusSeq,
      terminal: tone === 'completed' || tone === 'error' || tone === 'stopped',
      authoritative: event.type === 'job_summary',
    }
    if (!runId) {
      standalone.push(candidate)
      continue
    }
    const current = byRun.get(runId)
    if (candidate.authoritative) {
      if (
        !current
        || statusSeq > current.statusSeq
        || (statusSeq === current.statusSeq && !current.authoritative)
      ) byRun.set(runId, candidate)
      continue
    }
    // A new turn_started is an explicit attempt boundary, even when a backend
    // reuses its run ID. By contrast job_ran/job_started can arrive after a
    // fast terminal event and must not regress that attempt to "Running."
    if (event.type === 'turn_started') {
      byRun.set(runId, candidate)
    } else if (
      !current
      || (candidate.terminal && statusSeq >= current.statusSeq)
      || (!current.terminal && statusSeq >= current.statusSeq)
    ) {
      byRun.set(runId, candidate)
    }
  }
  return [...byRun.values(), ...standalone].reduce<Candidate | null>((latest, candidate) => {
    if (!latest || candidate.statusSeq > latest.statusSeq) return candidate
    if (candidate.statusSeq === latest.statusSeq && candidate.authoritative && !latest.authoritative) return candidate
    return latest
  }, null)?.event ?? null
}

export function jobRunStatus(event: Event, presentation = jobResultPresentation(event)): JobRunStatus {
  if (isTimelineError(event) || event.type === 'job_error') return { label: 'Failed', tone: 'error' }
  if (event.type === 'turn_stopped') return { label: 'Stopped', tone: 'stopped' }
  const genericStatus = typeof event.status === 'string' ? event.status.trim() : ''
  const status = (
    event.job_status
    || event.job_latest_status
    || event.job_run_status
    || genericStatus
  ).toLowerCase()
  if (['failed', 'error'].includes(status)) return { label: 'Failed', tone: 'error' }
  if (['stopped', 'cancelled', 'canceled'].includes(status)) return { label: 'Stopped', tone: 'stopped' }
  if (status === 'deferred' || event.type === 'job_deferred') return { label: 'Deferred', tone: 'queued' }
  if (
    ['running', 'active', 'started'].includes(status)
    || event.type === 'turn_started'
    || event.type === 'job_started'
    || event.type === 'job_ran'
  ) return { label: 'Running', tone: 'running' }
  if (['queued', 'pending'].includes(status)) return { label: 'Queued', tone: 'queued' }
  if (
    ['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)
    || event.type === 'turn_finished'
    || event.type === 'job_finished'
  ) return { label: 'Completed', tone: 'completed' }
  if (presentation.structured) {
    try {
      const parsed = JSON.parse(presentation.detail) as Record<string, unknown>
      const structuredStatus = String(parsed.status || parsed.queue_status || '').trim().toLowerCase()
      if (['failed', 'error'].includes(structuredStatus)) return { label: 'Failed', tone: 'error' }
      if (['stopped', 'cancelled', 'canceled'].includes(structuredStatus)) return { label: 'Stopped', tone: 'stopped' }
      if (structuredStatus === 'deferred') return { label: 'Deferred', tone: 'queued' }
      if (['running', 'active', 'started'].includes(structuredStatus)) return { label: 'Running', tone: 'running' }
      if (['queued', 'pending'].includes(structuredStatus)) return { label: 'Queued', tone: 'queued' }
      if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(structuredStatus)) {
        return { label: 'Completed', tone: 'completed' }
      }
    } catch { /* Structured presentation is best-effort UI data. */ }
  }
  return { label: 'Updated', tone: 'updated' }
}

function jobDisplayPriority(event: Event): number {
  if (isTimelineError(event) || event.type === 'turn_stopped' || event.type === 'job_error') return 5
  if (event.type === 'turn_finished' && messageText(event).trim()) return 4
  if (event.type === 'assistant_text' && messageText(event).trim()) return 3
  if (event.type === 'job_finished') return 3
  if (event.type === 'job_deferred') return 2
  if (event.type === 'job_ran' || event.type === 'job_started') return 2
  if (event.type === 'turn_started') return 1
  return 0
}

function jobStatusEvent(event: Event): boolean {
  if (
    event.job_status?.trim()
    || event.job_latest_status?.trim()
    || event.job_run_status?.trim()
  ) return true
  if (isTimelineError(event)) return true
  return [
    'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error',
    'turn_started', 'turn_finished', 'turn_stopped',
  ].includes(event.type)
}

function jobStatusSequence(event: Event): number {
  for (const value of [
    event.job_run_status_seq,
    event.job_status_seq,
    event.job_latest_status_seq,
    event.seq,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return event.seq
}

function normalizeAssistantOutput(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function parseStructuredResult(value: string): Record<string, unknown> | unknown[] | null {
  const first = value[0]
  if (first !== '{' && first !== '[') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed != null && typeof parsed === 'object'
      ? parsed as Record<string, unknown> | unknown[]
      : null
  } catch {
    return null
  }
}

function structuredJobPreview(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `Structured result · ${value.length} ${value.length === 1 ? 'item' : 'items'}`
  const fields: Array<[string, string]> = [
    ['error', 'Error'],
    ['status', 'Status'],
    ['queue_status', 'Queue'],
    ['collector', 'Collector'],
    ['collector_status', 'Collector status'],
    ['mode', 'Mode'],
    ['next_collector', 'Next collector'],
    ['message', 'Message'],
  ]
  const parts: string[] = []
  for (const [key, label] of fields) {
    const scalar = jobScalar(value[key])
    if (!scalar) continue
    parts.push(`${label}: ${scalar}`)
    if (parts.length === 3) break
  }
  if (parts.length) return truncateJobPreview(parts.join(' · '))
  const count = Object.keys(value).length
  return `Structured result · ${count} ${count === 1 ? 'field' : 'fields'}`
}

function jobScalar(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  const compact = String(value).replace(/[_\s]+/g, ' ').trim()
  if (!compact) return ''
  const readable = compact.length > 1 ? `${compact[0].toUpperCase()}${compact.slice(1)}` : compact.toUpperCase()
  return truncateJobPreview(readable, 72)
}

function truncateJobPreview(value: string, limit = JOB_PREVIEW_CHARACTER_LIMIT): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

export function isTimelineError(event: Event): boolean {
  if (traces.has(event.type)) return false
  if (event.type === 'turn_finished' && event.stopped !== true && typeof event.exit_code === 'number' && event.exit_code !== 0) return true
  return event.type === 'error' || event.type.endsWith('_error') || event.is_error === true || event.error != null
}

export function providerInteractionAuditKey(event: Event): string | null {
  const match = /^(claude|codex|cursor)_interaction_(?:requested|resolved)$/.exec(event.type)
  if (!match) return null
  const runKey = event.run_id?.trim() || event.turn_id?.trim() || 'session'
  return `provider-interaction-audit:${match[1]}:${runKey}`
}

export interface ProviderInteractionAuditEntry {
  id: string
  latest: Event
  requested?: Event
  resolved?: Event
  label: string
  status: string
}

export interface ProviderInteractionAuditSummary {
  requestCount: number
  resolvedCount: number
  entries: ProviderInteractionAuditEntry[]
}

/**
 * Fold transport retries and request/resolution packets by the provider's
 * durable interaction identity. Newest entries appear first, matching Mac,
 * while the active approval shelf remains the only actionable surface.
 */
export function providerInteractionAuditSummary(events: readonly Event[]): ProviderInteractionAuditSummary {
  const grouped = new Map<string, Omit<ProviderInteractionAuditEntry, 'label' | 'status'>>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const id = event.interaction_id?.trim() || event.interaction?.id?.trim() || event.id
    const existing = grouped.get(id)
    const entry = existing
      ? { ...existing, latest: event.seq >= existing.latest.seq ? event : existing.latest }
      : { id, latest: event }
    if (event.type.endsWith('_interaction_requested')) entry.requested = event
    if (event.type.endsWith('_interaction_resolved')) entry.resolved = event
    grouped.set(id, entry)
  }
  const entries = [...grouped.values()]
    .sort((left, right) => right.latest.seq - left.latest.seq)
    .map(entry => ({
      ...entry,
      label: providerInteractionAuditLabel(entry),
      status: providerInteractionAuditStatus(entry),
    }))
  return {
    requestCount: entries.filter(entry => entry.requested).length,
    resolvedCount: entries.filter(entry => entry.resolved).length,
    entries,
  }
}

function providerInteractionAuditLabel(entry: Pick<ProviderInteractionAuditEntry, 'latest' | 'requested' | 'resolved'>): string {
  const event = entry.requested ?? entry.resolved ?? entry.latest
  const method = event.interaction?.method || event.request_method || ''
  const normalized = method.toLowerCase()
  if (normalized.includes('commandexecution') || normalized.includes('command_execution')) return 'Command approval'
  if (normalized.includes('filechange') || normalized.includes('applypatch') || normalized.includes('file_change')) return 'File change approval'
  if (normalized.includes('requestuserinput') || normalized.includes('user_input')) return 'User input request'
  if (normalized.includes('elicitation') || normalized.includes('mcp')) return 'MCP input request'
  if (normalized.includes('permission')) return 'Permission approval'
  if (normalized.includes('tool')) return 'Tool approval'
  if (normalized.includes('approval') || normalized.includes('requestapproval')) return 'Approval request'
  return 'Interaction request'
}

function providerInteractionAuditStatus(entry: Pick<ProviderInteractionAuditEntry, 'resolved'>): string {
  if (!entry.resolved) return 'Requested'
  const resolution = entry.resolved.resolution?.trim()
  if (!resolution || resolution.toLowerCase() === 'answered') return 'Resolved'
  const readable = resolution.replaceAll('_', ' ').replace(/\b\w/g, match => match.toUpperCase())
  return `Resolved · ${readable}`
}

export function isNativeSteerSupersession(event: Pick<Event, 'type' | 'native_steer' | 'superseded_by_run_id'>): boolean {
  return event.type === 'turn_stopped'
    && (event.native_steer === true || Boolean(event.superseded_by_run_id))
}

/**
 * Match the server/Mac semantic identity for durable Codex lifecycle markers.
 * Automatic compaction can happen more than once inside one provider turn;
 * the transcript needs one latest marker for that logical turn, not one card
 * for every underlying compaction item.
 */
export function codexLifecycleSemanticKey(
  event: Pick<Event, 'type' | 'operation_id' | 'turn_id' | 'item_id' | 'id' | 'seq'>,
): string | null {
  if (event.type === 'codex_goal_budget_limited') return 'codex:goal-budget'
  if (event.type !== 'codex_compaction_completed') return null
  const operationId = event.operation_id?.trim()
  if (operationId) return `codex:compaction:${operationId}`
  const nativeId = event.turn_id?.trim()
    || event.item_id?.trim()
    || event.id?.trim()
    || String(event.seq)
  return `codex:compaction:${nativeId}`
}

function traceHasContent(events: Event[]): boolean {
  return events.some(event => [
    'reasoning_summary', 'tool_started', 'tool_finished', 'idle_warning', 'artifact_error', 'code_diff',
  ].includes(event.type) || messageText(event).trim())
}

function appendAssistant(turn: Turn, event: Event, candidate: string, aggregate: boolean): void {
  const normalized = candidate.replace(/\s+/g, ' ').trim()
  if (!normalized || turn.assistantNormalizedSet.has(normalized)) return
  if (aggregate && normalizedAggregateCovers(turn.assistantNormalizedSet, normalized)) {
    turn.assistant.splice(0, turn.assistant.length, event)
    turn.assistantNormalizedSet.clear()
    turn.assistantNormalizedSet.add(normalized)
    return
  }
  turn.assistant.push(event)
  turn.assistantNormalizedSet.add(normalized)
}

function normalizedAggregateCovers(previous: Set<string>, aggregate: string): boolean {
  if (!previous.size) return false
  for (const part of previous) {
    if (!aggregate.includes(part)) return false
  }
  return true
}

function isImportedHistoryTurn(event: Event): boolean {
  return event.type === 'turn_started'
    && Boolean(event.run_id)
    && (event.run_id?.startsWith('import_') === true || event.imported === true)
}

const CONTEXT_DIGEST_HEADINGS = ['# AgentsDock Context Digest', '# ZenithDock Context Digest']

function digestBody(event: Event): string {
  if (event.type !== 'turn_started') return ''
  const prompt = event.prompt?.trim() || ''
  return CONTEXT_DIGEST_HEADINGS.some(heading => prompt.startsWith(heading)) ? prompt : ''
}

function isDigestDeliveryTurn(event: Event): boolean {
  return event.purpose === 'handoff_digest_delivery' || Boolean(digestBody(event))
}

function isInternalDeliveryTurn(event: Event): boolean {
  if (hasProviderUserProvenance(event)) return false
  return isDigestDeliveryTurn(event)
    || event.purpose === 'cross_chat_handoff_delivery'
    || event.purpose === 'chat_mailbox_wake' && event.imported !== true
      && !event.run_id?.startsWith('import_') && !hasProviderUserProvenance(event)
}

/** Match the server/Mac semantic identity for cross-chat lifecycle packets. */
export function crossChatSemanticKey(event: Event): string | null {
  if (isAsyncCrossChatMessage(event)) {
    const envelopeId = event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || event.message_id?.trim()
    return envelopeId ? `cross-chat:handoff:${envelopeId}` : null
  }
  if (!event.type.startsWith('cross_chat_')) return null
  const exchangeId = crossChatExchangeId(event)
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

/** Only the exact negotiated one-way protocol uses independent message cards. */
export function isAsyncCrossChatMessage(event: Event): boolean {
  return event.conversation_mode === 'async_route_v1'
    && (/^chat_conversation_message_(registered|received|queued|started|delivered|cancelled|failed)$/u.test(event.type)
      || event.delivery_mode === 'mailbox' && /^chat_conversation_message_(mailbox_migrated|read|deleted)$/u.test(event.type))
}

function crossChatExchangeId(event: Event): string {
  return event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim() || ''
}

function crossChatTerminalStatus(event: Event): NonNullable<Event['exchange_status']> | null {
  const status = event.exchange_status
  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired') return status
  // Only exchange-summary packets can infer terminal exchange state. A
  // failed/cancelled/expired leg is terminal for that leg, but treating it as
  // terminal for the whole exchange can incorrectly disable later replies.
  if (event.type === 'cross_chat_exchange_completed') return 'completed'
  if (event.type === 'cross_chat_exchange_failed') return 'failed'
  if (event.type === 'cross_chat_exchange_cancelled') return 'cancelled'
  if (event.type === 'cross_chat_exchange_expired') return 'expired'
  return null
}

function crossChatEventWithStatus(
  event: Event,
  status: NonNullable<Event['exchange_status']>,
): Event {
  if (event.exchange_status === status) return event
  let byStatus = terminalNormalizedCrossChatEvents.get(event)
  if (!byStatus) {
    byStatus = new Map()
    terminalNormalizedCrossChatEvents.set(event, byStatus)
  }
  const cached = byStatus.get(status)
  if (cached) return cached
  const normalized = { ...event, exchange_status: status }
  byStatus.set(status, normalized)
  return normalized
}

function digestDisplayPriority(event: Event): number {
  if (event.type === 'handoff_digest_error') return 50
  if (event.type === 'handoff_digest_sent' || event.type === 'handoff_digest_received') return 40
  if (event.type === 'handoff_digest_ready' || event.type === 'handoff_digest_submitted') return 30
  if (event.type === 'handoff_digest_started') return 20
  return event.purpose === 'handoff_digest' ? 10 : 0
}
