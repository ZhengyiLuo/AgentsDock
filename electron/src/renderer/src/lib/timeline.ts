import type { AgentFile, CodeDiffFileSummary, Event } from '@shared/types'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { hasTimelineChangeSignal } from '@shared/timeline-change-signal'
import { agentFileBelongsToSession, eventFileForSession } from '@shared/session-files'
import { hasProviderUserProvenance, isImportedClaudeControlCompanion, isImportedCodexRuntimeContext, isImportedProviderControlMetadata, isImportedProviderInterruption, isImportedSourceProvenRepair, isImportedSourceProvenAssistantReplay, isImportedSourceProvenNativeReplay } from '@shared/provider-origin'
import { codexLifecycleSemanticKey, crossChatSemanticKey, isAsyncCrossChatMessage, isNativeGoalSteerEvent, isNativeSteerTransitionStop, providerInteractionAuditKey } from '@shared/semantic-timeline'
import { isChatMailboxEvent } from '@shared/chat-inbox'

export type TimelineItem = TurnItem | SystemItem | JobItem
export type RenderTimelineItem = MessageItem | TraceItem | ProgressItem | MediaItem | SystemItem | JobItem

export interface MessageItem {
  kind: 'message'
  id: string
  key: string
  seq: number
  event: Event
  events: Event[]
  role: 'user' | 'assistant'
  files: AgentFile[]
}

export interface TraceItem {
  kind: 'trace'
  id: string
  key: string
  seq: number
  events: Event[]
  promotedCommentaryIds: string[]
  active: boolean
}

export interface ProgressItem {
  kind: 'progress'
  id: string
  key: string
  seq: number
  /** All user-visible run activity, including commentary, reasoning, and tools. */
  events: Event[]
  /** Unfiltered compact activity retained for merging full trace pages before normalization. */
  sourceEvents?: Event[]
  /** Live commentary stays visible; terminal tool details can collapse. */
  active?: boolean
  /** A separate assistant response exists; false preserves otherwise-hidden interrupted output. */
  hasFinalResponse?: boolean
  /** Canonical output used to keep remotely loaded activity separate from the final answer. */
  finalEvents?: Event[]
  /** Final timestamps that prove delayed commentary belongs before its arrival sequence. */
  orderingFinalEvents?: Event[]
  /** Sequence bounds keep on-demand details inside this continuation. */
  afterSeq?: number
  throughSeq?: number
  startedAt?: string
  finishedAt?: string
  stoppedAt?: string
  /** Explicit terminal arrival, including stops with no assistant output. */
  terminalSeq?: number
  /** Lifecycle rows embedded chronologically in the one live progress surface. */
  lifecycle?: SystemItem[]
  /** A message boundary is not completion of the owning provider run. */
  continues?: boolean
  /** Keep a tool's result with its original call across message boundaries. */
  toolStartSequences?: Readonly<Record<string, number>>
}

export interface MediaItem {
  kind: 'media'
  id: string
  key: string
  seq: number
  files: AgentFile[]
}

export interface TurnItem {
  kind: 'turn'
  id: string
  key: string
  runId?: string | null
  /** Root provider thread that owns this turn, when Codex reported it. */
  providerThreadId?: string | null
  seq: number
  user?: Event
  assistant: Event[]
  trace: Event[]
  promotedCommentaryIds: string[]
  files: AgentFile[]
  startedAt?: string
  finishedAt?: string
  stoppedAt?: string
  /** Presentation boundary only; never changes provider/run ownership. */
  terminalSeq?: number
  purpose?: string | null
  /** Presentation-only native-goal input slice, with unchanged runtime ownership. */
  afterSeq?: number
  throughSeq?: number
}

export interface TimelineProjectionScope {
  /** Current root Codex thread for the selected chat. */
  rootThreadId?: string | null
  /** AgentsDock run currently executing on that root thread. */
  activeRunId?: string | null
}

export interface SystemItem {
  kind: 'system'
  id: string
  key: string
  seq: number
  event: Event
  /** Coalesced lifecycle audit events represented by this compact row. */
  events?: Event[]
  anchorTs?: string
  /** Display-only recovery of a provider-imported delivery; carries no route authority. */
  importedDelivery?: ImportedCrossChatDelivery
  /** One explicitly negotiated asynchronous agent message, never a whole exchange panel. */
  crossChatMessage?: boolean
  /** Adjacent incoming messages only; each child retains its exact semantic owner. */
  mailboxMessages?: SystemItem[]
  /** One historical exchange leg, presented independently without changing its lifecycle. */
  crossChatLegId?: string
}

export interface ImportedCrossChatDelivery {
  sender: string
  kind: 'instruction' | 'request' | 'reply' | 'final_result' | 'status' | 'message'
  body: string
  sourceRequest: string
  ordinal?: number
  maxLegs?: number
  mode?: 'async_route_v1'
  editedByUser?: boolean
}

export interface JobItem {
  kind: 'job'
  id: string
  key: string
  /** Logical schedule identity, independent of the contiguous card key. */
  jobId?: string
  /** Server-owned contiguous segment identity, when supported. */
  timelineGroupId?: string | null
  /** One display representative per firing, including recycled provider run IDs. */
  displayUpdates?: Event[]
  seq: number
  title: string
  events: Event[]
  latest: Event
  latestStatus?: Event
  eventCount: number
  runCount: number
  startSeq: number
  endSeq: number
}

const traceTypes = new Set([
  'reasoning_summary', 'tool_started', 'tool_finished', 'raw_event', 'process_started',
  'provider_session', 'cwd_fallback', 'history_imported', 'backend_changed', 'artifact_error',
  'session_created', 'idle_warning', 'code_diff'
])
const hiddenTypes = new Set([
  'turn_queued', 'turn_unqueued', 'turn_queue_updated', 'turn_queue_reordered',
  'turn_queue_run_now', 'turn_queue_paused', 'turn_queue_delivery_fenced', 'queue_snapshot',
  'subagent_state', 'claude_subagents_stopped', 'job_updated', 'job_deleted',
  'codex_thread_status', 'codex_goal_updated', 'codex_goal_cleared', 'codex_token_usage',
  'emergency_alert_acknowledged',
  'claude_background_task_reconciliation_consumed',
])
const jobTypes = new Set(['job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error'])
const jobStatusTypes = new Set([
  'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error',
  'turn_started', 'turn_finished', 'turn_stopped'
])

function jobLinkedRunIds(event: Event): string[] {
  return [...new Set([
    event.run_id,
    event.job_status_run_id,
    event.job_latest_status_run_id,
    event.job_latest_run_id
  ].map(value => value?.trim() || '').filter(Boolean))]
}

export function isHandoffDigestEvent(event: Event): boolean {
  return Boolean(event.digest_job_id) &&
    (event.purpose === 'handoff_digest' || event.type.startsWith('handoff_digest_'))
}

interface JobProjectionState {
  jobId: string
  authoritativeGroupId: string | null
  item: JobItem
  /** Occurrence identities, not raw provider run IDs (which may be recycled). */
  runIds: Set<string>
  runFirstSeq: Map<string, number>
  reportedRunCount: number
  reportedAtSeq: number
  bestByRun: Map<string, Event>
  standalone: Event[]
  latestRunId: string | null
  latestRunExtras: Event[]
  latestStatus?: Event
}

interface AssistantProjectionState {
  parts: string[]
  seen: Set<string>
}

interface NativeCrossChatDelivery {
  start: Event
  finish?: Event
  deliveryKey: string
}

function crossChatDeliveryKey(event: Event): string | null {
  if (event.conversation_mode === 'async_route_v1') {
    const envelope = event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || event.message_id?.trim()
    const conversation = event.conversation_id?.trim()
    return envelope && conversation ? `async:${conversation}:${envelope}` : null
  }
  const exchange = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim()
  const leg = event.exchange_leg_id?.trim() || event.cross_chat_exchange_leg_id?.trim()
  return exchange && leg ? `legacy:${exchange}:${leg}` : null
}

interface NativeCommentaryRecord {
  event: Event
  backend: Event['backend']
  second: number
  text: string
}

const MAX_NATIVE_COMMENTARY_RECORDS = 512

function commentaryTimestampSecond(event: Event): number | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(event.ts)) return null
  const timestamp = Date.parse(event.ts)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

const MAX_STANDALONE_JOB_UPDATES = 64
const MAX_BUNDLED_JOB_RUNS = 20
// Keep only a tiny visible seed for the latest job run. Expanding the trace
// pages the complete reasoning/tool history from the server, so retaining a
// large raw-event tail here only makes long-running monitors expensive.
const MAX_LATEST_JOB_EXTRAS = 6
const terminalCrossChatExchangeStatuses = new Set<NonNullable<Event['exchange_status']>>([
  'completed', 'failed', 'cancelled', 'expired'
])

function terminalCrossChatExchangeStatus(event: Event): NonNullable<Event['exchange_status']> | null {
  if (event.exchange_status && terminalCrossChatExchangeStatuses.has(event.exchange_status)) return event.exchange_status
  if (event.type === 'cross_chat_exchange_completed') return 'completed'
  if (event.type === 'cross_chat_exchange_failed') return 'failed'
  if (event.type === 'cross_chat_exchange_cancelled') return 'cancelled'
  if (event.type === 'cross_chat_exchange_expired') return 'expired'
  return null
}

export class TimelineProjector {
  private readonly filesById: Map<string, AgentFile>
  private itemsValue: TimelineItem[] = []
  private readonly itemIndex = new Map<string, number>()
  private readonly turnByRun = new Map<string, TurnItem>()
  private readonly latestJobById = new Map<string, JobProjectionState>()
  private readonly jobByGroupId = new Map<string, JobProjectionState>()
  private readonly jobStateByJobRun = new Map<string, JobProjectionState>()
  private readonly jobStateByOccurrence = new Map<string, JobProjectionState>()
  private readonly jobOccurrenceByJobRun = new Map<string, string>()
  private readonly startedJobOccurrences = new Set<string>()
  private readonly jobSegmentCountById = new Map<string, number>()
  private readonly jobByRun = new Map<string, string>()
  private readonly jobTitles = new Map<string, string>()
  private readonly digestById = new Map<string, SystemItem>()
  private readonly codexLifecycleByKey = new Map<string, SystemItem>()
  private readonly crossChatByKey = new Map<string, SystemItem>()
  private readonly providerInteractionAuditByKey = new Map<string, SystemItem>()
  private readonly crossChatTerminalStatusByExchange = new Map<string, NonNullable<Event['exchange_status']>>()
  private readonly nativeCrossChatDeliveries = new Map<string, NativeCrossChatDelivery>()
  private readonly nativeCrossChatFinishesByProviderTurn = new Map<string, Map<string, Event>>()
  private readonly crossChatDeliveryReceipts = new Map<string, Event>()
  private readonly conflictingCrossChatReceiptRuns = new Set<string>()
  private readonly importedCrossChatInputs = new Map<string, Event>()
  private readonly importedCrossChatAliases = new Set<string>()
  private readonly importedCrossChatInputByRun = new Map<string, string>()
  private readonly importedCrossChatOutputs = new Map<string, { event: Event; inputId: string }>()
  private readonly importedCrossChatOutputProviderIds = new Set<string>()
  private readonly nativeCrossChatOutputs = new Map<string, Event>()
  private readonly importedCrossChatOutputAliases = new Set<string>()
  private readonly queuedInputFileIds = new Map<string, string[]>()
  private readonly assistantByTurn = new Map<string, AssistantProjectionState>()
  private readonly rootThreadByRun = new Map<string, string>()
  private readonly suppressedProviderEchoRuns = new Set<string>()
  private readonly silentInputRuns = new Set<string>()
  private nativeCommentaryRecords: NativeCommentaryRecord[] = []
  private discardedCommentaryThroughSecond = Number.NEGATIVE_INFINITY
  private readonly scope: TimelineProjectionScope
  private activeTurn: TurnItem | null = null
  private writableKeys = new Set<string>()
  private movedKeys = new Set<string>()

  constructor(knownFiles: AgentFile[], scope: TimelineProjectionScope = {}) {
    this.filesById = new Map(knownFiles.map(file => [file.id, file]))
    this.scope = scope
  }

  get items(): TimelineItem[] { return this.itemsValue }

  updateKnownFiles(files: AgentFile[]): boolean {
    const replacements = new Map<string, AgentFile>()
    for (const file of files) {
      const previous = this.filesById.get(file.id)
      if (previous === file) continue
      this.filesById.set(file.id, file)
      replacements.set(file.id, file)
    }
    if (!replacements.size) return false

    const updates: Array<{ turn: TurnItem; files: AgentFile[] }> = []
    for (const item of this.itemsValue) {
      if (item.kind !== 'turn') continue
      const sessionId = item.user?.session_id
        ?? item.assistant[0]?.session_id
        ?? item.trace[0]?.session_id
        ?? ''
      const nextFiles = item.files.map(file => {
        const replacement = replacements.get(file.id)
        return replacement && (!sessionId || agentFileBelongsToSession(replacement, sessionId))
          ? replacement
          : file
      })
      for (const id of item.user?.file_ids ?? []) {
        const file = this.filesById.get(id)
        if (
          file
          && agentFileBelongsToSession(file, item.user!.session_id)
          && !nextFiles.some(candidate => candidate.id === id)
        ) nextFiles.push(file)
      }
      if (!sameReferences(nextFiles, item.files)) updates.push({ turn: item, files: nextFiles })
    }
    if (!updates.length) return false

    this.itemsValue = [...this.itemsValue]
    this.writableKeys = new Set()
    this.movedKeys = new Set()
    for (const update of updates) {
      this.writableTurn(update.turn).files = update.files
    }
    this.reindex()
    return true
  }

  append(events: Event[]): boolean {
    if (!events.length) return true
    if (!this.rememberCrossChatDeliveryAliases(events)) return false

    // A late job link can retroactively turn an already-projected ordinary
    // turn into a scheduled-job run. That rare transition needs one rebuild;
    // ordinary live tail traffic remains strictly incremental.
    for (const event of events) {
      if (isImportedProviderControlMetadata(event)) continue
      const jobId = event.job_id?.trim() || event.job?.id?.trim() || ''
      if (!jobId) continue
      for (const runId of jobLinkedRunIds(event)) {
        const priorFallback = this.latestJobById.has(runId)
        if (!this.jobByRun.has(runId) && (this.turnByRun.has(runId) || priorFallback)) return false
      }
    }

    for (const event of events) {
      if (isImportedProviderControlMetadata(event)) continue
      const jobId = event.job_id?.trim() || event.job?.id?.trim() || ''
      if (!jobId) continue
      const title = String(event.job_title || event.job?.title || '').trim()
      if (title) this.jobTitles.set(jobId, title)
      // Explicit server job ownership also appears on metadata-light output
      // and job_summary pages without purpose or a retained start event.
      for (const runId of jobLinkedRunIds(event)) this.jobByRun.set(runId, jobId)
    }

    const initialProjection = this.itemsValue.length === 0
    this.itemsValue = [...this.itemsValue]
    this.writableKeys = new Set()
    this.movedKeys = new Set()
    for (const event of events) this.appendEvent(event)
    if (initialProjection) this.itemsValue.sort((left, right) => left.seq - right.seq)
    else if (this.movedKeys.size) this.repositionMovedItems()
    this.reindex()
    return true
  }

  private appendEvent(event: Event): void {
    // Providers can deliver public updates through either text event shape.
    // Only an explicit phase makes an assistant text update activity.
    if (event.type === 'assistant_text' && isPublicCommentary(event)) {
      event = { ...event, type: 'reasoning_summary' }
    }
    // Checkpoint/finish companions of a proven control-only import batch are
    // not logical turns. In particular, they must not retire current work.
    if (isImportedClaudeControlCompanion(event) || isImportedSourceProvenAssistantReplay(event)
      || isImportedSourceProvenNativeReplay(event) && event.type !== 'turn_started') return
    if (this.importedCrossChatOutputAliases.has(event.id)) {
      if (event.type !== 'turn_finished') return
      event = { ...event, result_text: null, text: null }
    }
    // Keep a silent input boundary in mixed imports so later output cannot
    // become the answer to a preceding genuine question in the same run.
    if (isImportedSourceProvenRepair(event) || isImportedSourceProvenNativeReplay(event) || this.importedCrossChatAliases.has(event.id)) {
      const prior = event.run_id ? this.turnByRun.get(event.run_id) : undefined
      if (prior) {
        this.writableTurn(prior).finishedAt ||= event.ts
        this.assistantByTurn.delete(prior.key)
      }
      this.activeTurn = this.writableTurn(this.ensureTurn(event, Boolean(prior)))
      if (event.run_id) this.silentInputRuns.add(event.run_id)
      return
    }
    if (isImportedCodexRuntimeContext(event)) {
      // One import batch may first replay a suppressed native prompt/answer,
      // then contain a genuinely new runtime continuation. The metadata starts
      // a new input slice, even though it never becomes a user bubble.
      if (event.run_id) this.suppressedProviderEchoRuns.delete(event.run_id)
      return
    }
    // A server-proven transcript control is historical metadata, never a
    // user turn or a stop signal for whichever run happens to be live now.
    // Provider identity also deduplicates overlapping history imports.
    if (isImportedProviderInterruption(event)) {
      const key = `provider-interruption:${event.session_id}:${event.provider_origin.event_id.toLowerCase()}`
      const priorIndex = this.itemIndex.get(key)
      const prior = priorIndex == null ? undefined : this.itemsValue[priorIndex]
      this.replaceItem({ kind: 'system', id: key, key, seq: prior?.seq ?? event.seq, event: {
        ...event, ts: event.provider_origin.timestamp, prompt: null, text: null, result_text: null
      } })
      return
    }
    const runId = event.run_id?.trim() || ''
    if (event.type === 'turn_started' && runId.startsWith('import_')) {
      if (!hasProviderUserProvenance(event) && hasInjectedProviderAuthority(event.prompt || '')
        // Unknown delivery formats remain visible rather than being mistaken
        // for an entire native prompt echo and losing their following answer.
        && !event.prompt?.trimStart().startsWith('[AgentsDock delivery ')) {
        this.suppressedProviderEchoRuns.add(runId)
      } else {
        // One import run may contain many user/assistant pairs. Suppression
        // belongs only to the echoed pair, not later deliveries or user turns.
        this.suppressedProviderEchoRuns.delete(runId)
      }
    }
    // Provider transcript catch-up can replay an AgentsDock-authored turn
    // after its native events. The injected authority suffix proves this is
    // our own provider echo, so suppress this imported turn slice instead of
    // showing the user's message and assistant response twice.
    if (runId && this.suppressedProviderEchoRuns.has(runId)) return
    if (isInternalProviderDiagnostic(event)) return
    if (this.isReplayedPublicCommentary(event)) return
    const providerBackgroundTask = importedClaudeBackgroundTask(event)
    if (providerBackgroundTask) {
      const key = `provider-background-task:${event.id}`
      this.addItem({
        kind: 'system',
        id: key,
        key,
        seq: event.seq,
        event: {
          ...event,
          type: 'provider_background_task_update',
          prompt: null,
          message: providerBackgroundTask
        }
      })
      return
    }
    if (event.type === 'provider_session') this.rememberRootProviderThread(event)
    if (isLeakedChildCompaction(event, this.expectedRootThreadForCompaction(event))) return
    const transitionJobId = String(
      event.job_id
      || event.job?.id
      || (event.run_id ? this.jobByRun.get(event.run_id) : '')
      || (event.purpose === 'scheduled_job' ? event.run_id : '')
      || ''
    ).trim()
    // Ordinary native-steer stops are transport boundaries, not transcript
    // rows. A scheduled-job stop is different: it is the terminal lifecycle
    // event for that job run. Route it through the job projector so the card
    // becomes Stopped and its completed trace can be paged instead of leaving
    // a false RUNNING card with inaccessible reasoning.
    if (isNativeSteerTransitionStop(event) && !transitionJobId) {
      this.retireNativeSteerLogicalTurn(event)
      return
    }
    const queuedId = String(event.queued_id || '').trim()
    if (queuedId && event.type === 'turn_queued') {
      this.queuedInputFileIds.set(queuedId, [...(event.file_ids ?? [])])
    } else if (queuedId && event.type === 'turn_queue_updated' && event.file_ids) {
      this.queuedInputFileIds.set(queuedId, [...event.file_ids])
    } else if (queuedId && event.type === 'turn_unqueued') {
      this.queuedInputFileIds.delete(queuedId)
      this.removeItem(`turn-deferred:${queuedId}`)
    } else if (queuedId && (event.type === 'turn_started' || isNativeGoalSteerEvent(event))) {
      const ownedFileIds = this.queuedInputFileIds.get(queuedId)
      if (ownedFileIds) event = { ...event, file_ids: [...ownedFileIds] }
      this.queuedInputFileIds.delete(queuedId)
      this.removeItem(`turn-deferred:${queuedId}`)
    }
    const deliveredDigest = digestBody(event)
    if (deliveredDigest) {
      this.appendDigestEvent({
        ...event,
        type: 'handoff_digest_received',
        digest_job_id: `legacy-${event.run_id || event.id}`,
        digest: deliveredDigest,
        message: 'Context digest was delivered to this chat.'
      })
    }
    // Digest generation intentionally runs as a real turn in the source
    // provider session so it can use that chat's context. It is workflow
    // plumbing, though, not a user/assistant exchange. Collapse every event
    // from that internal turn and its lifecycle into one status row.
    if (isHandoffDigestEvent(event)) {
      this.appendDigestEvent(event)
      return
    }
    const crossChatKey = crossChatSemanticKey(event)
    if (crossChatKey) {
      event = this.applyCrossChatTerminalStatus(event)
      const existing = this.crossChatByKey.get(crossChatKey)
      const groupedEvents = deduplicateEvents([
        ...(existing?.events ?? (existing ? [existing.event] : [])),
        event
      ])
      const anchorSeq = groupedEvents[0]?.seq ?? event.seq
      const item: SystemItem = {
        kind: 'system',
        id: crossChatKey,
        key: crossChatKey,
        seq: anchorSeq,
        event: groupedEvents[groupedEvents.length - 1],
        events: groupedEvents
      }
      this.crossChatByKey.set(crossChatKey, item)
      this.replaceItem(item)
      if (existing && anchorSeq !== existing.seq) this.movedKeys.add(crossChatKey)
      return
    }
    // Codex can publish an authoritative idle thread status without a
    // matching turn_finished/turn_stopped/error event (for example after a
    // goal is cleared). Do not leave that orphaned turn presented as live.
    // Preserve its commentary, reasoning, and tools in one completed activity
    // disclosure without inventing an assistant response.
    const codexThreadStatusType = event.codex_thread_status?.type
      ?? (
        event.status
        && typeof event.status === 'object'
        && !Array.isArray(event.status)
          ? String((event.status as Record<string, unknown>).type ?? '')
          : ''
      )
    if (
      event.type === 'codex_thread_status'
      && codexThreadStatusType === 'idle'
      && this.activeTurnBackend() === 'codex'
    ) {
      this.retireActiveTurnAtIdle(event.ts)
    }
    if (hiddenTypes.has(event.type)) return

    const interactionAuditKey = providerInteractionAuditKey(event)
    if (interactionAuditKey) {
      const existing = this.providerInteractionAuditByKey.get(interactionAuditKey)
      const events = deduplicateEvents([...(existing?.events ?? []), event])
      const latest = events[events.length - 1]
      const item: SystemItem = {
        kind: 'system',
        id: interactionAuditKey,
        key: interactionAuditKey,
        seq: latest.seq,
        event: latest,
        events
      }
      this.providerInteractionAuditByKey.set(interactionAuditKey, item)
      this.replaceItem(item)
      if (existing?.seq !== item.seq) this.movedKeys.add(interactionAuditKey)
      return
    }

    // Codex lifecycle markers have their own stable semantic identity even
    // when the provider includes a scheduled-job run ID. Classify them before
    // job routing so live projection matches a semantic-history reload.
    const codexLifecycleKey = codexLifecycleSemanticKey(event)
    if (codexLifecycleKey) {
      this.appendCodexLifecycleEvent(event, codexLifecycleKey)
      return
    }

    // An explicit emergency must preserve its chronological position even
    // when it was raised from a scheduled-job run. Never fold it into the
    // job card or the provider trace.
    if (event.type === 'emergency_alert_raised') {
      this.addItem({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
      return
    }

    // A team send receipt is a durable user-visible action, even though the
    // server associates it with the run that performed the send. Classify it
    // before scheduled-job and generic run routing so it cannot disappear
    // into a job card or the active turn's folded trace.
    if (event.type === 'team_message_sent') {
      const key = `event:${event.id || event.seq}`
      this.addItem({ kind: 'system', id: key, key, seq: event.seq, event })
      return
    }

    const explicitJobId = event.job_id?.trim() || event.job?.id?.trim() || ''
    const jobId = explicitJobId || this.jobByRun.get(event.run_id || '') || (
      jobTypes.has(event.type) || event.purpose === 'scheduled_job'
        ? event.run_id || `job-${event.seq}`
        : ''
    )
    if (jobId) {
      this.appendJobEvent(event, jobId)
      return
    }

    // Repeated steer requests while a provider is still starting refer to
    // the same queued message. Keep one live status row for that queue item,
    // including when older servers already persisted duplicate notices.
    if (event.type === 'turn_deferred' && queuedId) {
      const key = `turn-deferred:${queuedId}`
      this.replaceItem({
        kind: 'system',
        id: key,
        key,
        seq: event.seq,
        event
      })
      this.movedKeys.add(key)
      return
    }

    if (event.type === 'turn_stopped') {
      const stoppedTurn = event.run_id
        ? this.turnByRun.get(event.run_id)
        : this.activeTurn
      this.retireLogicalTurn(event, true)
      if (!stoppedTurn) {
        this.addItem({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
      }
      return
    }

    // Errors belong in the visible timeline even when they carry the active
    // run ID. Handle them before the generic run/trace branches below.
    if (isTimelineError(event)) {
      this.addItem({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
      if (event.type === 'turn_finished' && this.activeTurn?.runId === event.run_id) this.activeTurn = null
      return
    }

    if (isNativeGoalSteerEvent(event)) {
      // Native steering keeps the same goal/run alive. End only the previous
      // display slice so its activity and trace cannot absorb the new input.
      const prior = this.turnByRun.get(event.run_id!)
      if (prior) {
        const retired = this.writableTurn(prior)
        retired.finishedAt ||= event.ts
        retired.throughSeq = event.seq - 1
        this.assistantByTurn.delete(retired.key)
      }
      const turn = this.writableTurn(this.ensureTurn(event, true))
      turn.user = event
      turn.afterSeq = event.seq
      for (const id of event.file_ids ?? []) {
        const file = this.filesById.get(id)
        if (file && agentFileBelongsToSession(file, event.session_id)) turn.files.push(file)
      }
      this.activeTurn = turn
      return
    }

    if (event.type === 'turn_started') {
      const interruptedRunId = event.steer_interrupted_run_id?.trim()
      if (interruptedRunId) this.retireNativeSteerPredecessor(interruptedRunId, event.ts)
      const previousActive = this.activeTurn
      if (previousActive && previousActive.runId !== event.run_id) {
        const retired = this.writableTurn(previousActive)
        retired.finishedAt ||= event.ts
        this.assistantByTurn.delete(retired.key)
        this.activeTurn = null
      }
      const prior = event.run_id ? this.turnByRun.get(event.run_id) : this.activeTurn
      const followsSilentInput = event.run_id ? this.silentInputRuns.delete(event.run_id) : false
      this.activeTurn = this.writableTurn(this.ensureTurn(event, Boolean(prior?.user) || followsSilentInput))
      if (!isDigestDeliveryTurn(event) && !isNativeMailboxWakeInput(event)) this.activeTurn.user = event
      this.activeTurn.seq = Math.min(this.activeTurn.seq, event.seq)
      this.activeTurn.startedAt = event.ts
      this.activeTurn.purpose = event.purpose
      for (const id of event.file_ids ?? []) {
        const file = this.filesById.get(id)
        if (
          file
          && agentFileBelongsToSession(file, event.session_id)
          && !this.activeTurn.files.some(candidate => candidate.id === id)
        ) this.activeTurn.files.push(file)
      }
      return
    }

    if (event.type === 'assistant_text' || event.type === 'turn_finished') {
      const turn = this.writableTurn(this.ensureTurn(event))
      const text = event.type === 'turn_finished' ? event.result_text : event.text
      if (text?.trim()) this.appendAssistantOutput(turn, event, text, event.type === 'turn_finished')
      if (event.type === 'turn_finished') {
        if (event.stopped) {
          turn.stoppedAt ||= event.ts
        }
        turn.finishedAt = event.ts
        turn.terminalSeq = event.seq
        this.assistantByTurn.delete(turn.key)
        if (this.activeTurn?.id === turn.id) this.activeTurn = null
      }
      return
    }

    if (traceTypes.has(event.type)) {
      const turn = this.writableTurn(this.ensureTurn(event))
      turn.trace.push(event)
      return
    }

    if (event.type === 'file_uploaded') {
      const file = eventFile(event)
      if (file && !this.filesById.has(file.id)) this.filesById.set(file.id, file)
      return
    }

    if (event.type === 'artifact_created') {
      const file = eventFile(event)
      if (file) {
        // Publication receipts can arrive after the provider has already
        // started a later turn. A run-scoped artifact belongs to that exact
        // logical turn, never whichever turn happens to be active now.
        const turn = this.writableTurn(
          event.run_id ? this.ensureTurn(event) : this.activeTurn ?? this.ensureTurn(event)
        )
        if (!turn.files.some(candidate => candidate.id === file.id)) turn.files.push(file)
      }
      return
    }

    if (event.run_id && this.activeTurn) {
      this.writableTurn(this.activeTurn).trace.push(event)
      return
    }

    this.addItem({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
  }

  private isReplayedPublicCommentary(event: Event): boolean {
    const run = event.run_id?.trim()
    if (!run) return false
    const knownBackend = event.backend === 'codex' || event.backend === 'claude' ? event.backend : undefined
    if (event.imported !== true && !run.startsWith('import_')) {
      // Older native commentary omitted backend. The owning native start or
      // finish supplies that evidence; message text never selects a provider.
      if (knownBackend && (event.type === 'turn_started' || event.type === 'turn_finished')) {
        for (const record of this.nativeCommentaryRecords) {
          if (record.event.run_id !== run || record.event.session_id !== event.session_id) continue
          record.backend = record.backend === null || (record.backend && record.backend !== knownBackend)
            ? null : knownBackend
        }
      }
      if (!isPublicCommentary(event)) return false
      if (event.backend && !knownBackend) return false
      const second = commentaryTimestampSecond(event)
      if (second == null || second <= this.discardedCommentaryThroughSecond) return false
      if (this.nativeCommentaryRecords.length >= MAX_NATIVE_COMMENTARY_RECORDS) {
        // A dropped candidate must never turn an ambiguous old match unique.
        this.discardedCommentaryThroughSecond = Math.max(...this.nativeCommentaryRecords.map(record => record.second))
        this.nativeCommentaryRecords = []
        if (second <= this.discardedCommentaryThroughSecond) return false
      }
      const owner = this.turnByRun.get(run)?.user
      const ownerBackend = owner?.session_id === event.session_id ? owner.backend : undefined
      this.nativeCommentaryRecords.push({ event, second, text: normalizeAssistantOutput(event.text ?? ''), backend: knownBackend
        ?? (ownerBackend === 'codex' || ownerBackend === 'claude' ? ownerBackend : undefined) })
      return false
    }
    if (event.imported !== true || !run.startsWith('import_') || !knownBackend || !isPublicCommentary(event)) return false
    const second = commentaryTimestampSecond(event)
    if (second == null || second <= this.discardedCommentaryThroughSecond) return false
    const text = normalizeAssistantOutput(event.text ?? '')
    const itemId = event.provider_message_id?.trim() || event.item_id?.trim()
    const matches = this.nativeCommentaryRecords.filter(record => {
      const native = record.event
      if (record.backend !== knownBackend || native.session_id !== event.session_id || native.seq >= event.seq
        || record.text !== text) return false
      const nativeItemId = native.provider_message_id?.trim() || native.item_id?.trim()
      if (itemId && nativeItemId) return itemId === nativeItemId
      // Native timestamps historically had second precision; imported source
      // timestamps retain milliseconds. This narrow fallback requires both
      // exact full text and the same second, and never hides native updates.
      return record.second === second && (
        /T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/i.test(native.ts)
        || Date.parse(native.ts) === Date.parse(event.ts)
      )
    })
    return matches.length === 1
  }

  private rememberCrossChatDeliveryAliases(events: Event[]): boolean {
    let changed = false
    for (const event of events) {
      if ((event.type.startsWith('cross_chat_exchange_leg_') || isAsyncCrossChatMessage(event)) && event.target_run_id
        && /^[0-9a-f]{64}$/i.test(event.handoff_body_sha256 || '')) {
        const prior = this.crossChatDeliveryReceipts.get(event.target_run_id)
        if (prior && (prior.handoff_body_sha256 !== event.handoff_body_sha256
          || crossChatDeliveryKey(prior) !== crossChatDeliveryKey(event)
          || prior.source_session_id !== event.source_session_id || prior.target_session_id !== event.target_session_id)) {
          this.conflictingCrossChatReceiptRuns.add(event.target_run_id)
        }
        this.crossChatDeliveryReceipts.set(event.target_run_id, event)
        changed = true
      }
      const runId = event.run_id?.trim()
      if (!runId) continue
      if (event.imported === true) {
        if (event.type === 'turn_started') {
          this.importedCrossChatInputByRun.delete(runId)
          if (event.provider_origin && importedCrossChatDeliveryCandidate(event)) {
            this.importedCrossChatInputs.set(event.id, event)
            this.importedCrossChatInputByRun.set(runId, event.id)
            changed = true
          } else if (this.importedCrossChatInputs.delete(event.id)) changed = true
        } else if ((event.type === 'assistant_text' || event.type === 'turn_finished') && event.provider_origin) {
          const inputId = this.importedCrossChatInputByRun.get(runId)
          if (inputId) {
            this.importedCrossChatOutputs.set(event.id, { event, inputId })
            if (event.provider_origin.event_id) this.importedCrossChatOutputProviderIds.add(event.provider_origin.event_id)
            changed = true
          }
        }
        if (event.type === 'turn_finished') this.importedCrossChatInputByRun.delete(runId)
        continue
      }
      if (this.nativeCrossChatDeliveries.has(runId) && event.provider_message_id
        && (event.type === 'assistant_text' || event.type === 'reasoning_summary')) {
        this.nativeCrossChatOutputs.set(`${runId}:${event.provider_message_id}`, event)
        // Ordinary streaming output must not rescan earlier imported history.
        if (this.importedCrossChatOutputProviderIds.has(event.provider_message_id)) changed = true
      }
      if (event.purpose !== 'cross_chat_handoff_delivery'
        || event.target_session_id !== event.session_id
        || !event.source_session_id || event.source_session_id === event.session_id) continue
      const deliveryKey = crossChatDeliveryKey(event)
      if (!deliveryKey) continue
      if (event.type === 'turn_started') {
        this.nativeCrossChatDeliveries.set(runId, { start: event, deliveryKey })
        changed = true
      } else if (event.type === 'turn_finished' && crossChatProviderSessionId(event)) {
        const providerTurnKey = codexProviderTurnKey(event.provider_thread_id, event.provider_turn_id)
        if (providerTurnKey) {
          const owners = this.nativeCrossChatFinishesByProviderTurn.get(providerTurnKey) ?? new Map<string, Event>()
          owners.set(runId, event)
          this.nativeCrossChatFinishesByProviderTurn.set(providerTurnKey, owners)
          changed = true
        }
        const native = this.nativeCrossChatDeliveries.get(runId)
        if (native && native.deliveryKey === deliveryKey
          && native.start.backend === event.backend && native.start.session_id === event.session_id) {
          native.finish = event
          changed = true
        }
      }
    }
    if (!changed || !this.importedCrossChatInputs.size && !this.importedCrossChatAliases.size) return true
    const byHash = new Map<string, NativeCrossChatDelivery[]>()
    for (const [runId, native] of this.nativeCrossChatDeliveries) {
      const receipt = this.crossChatDeliveryReceipts.get(runId)
      if (!native.finish || !receipt || this.conflictingCrossChatReceiptRuns.has(runId)
        || receipt.session_id !== native.start.session_id
        || crossChatDeliveryKey(receipt) !== native.deliveryKey
        || receipt.source_session_id !== native.start.source_session_id
        || receipt.target_session_id !== native.start.target_session_id) continue
      const hash = receipt.handoff_body_sha256!.toLowerCase()
      byHash.set(hash, [...(byHash.get(hash) ?? []), native])
    }
    const candidates = new Map<string, string>()
    const originsByRun = new Map<string, Set<string>>()
    for (const event of this.importedCrossChatInputs.values()) {
      const delivery = importedCrossChatDeliveryCandidate(event)!
      const origin = event.provider_origin!
      if (typeof origin.timestamp !== 'string') continue
      const sourceTime = Date.parse(origin.timestamp)
      if (!origin.event_id || !origin.session_id || !Number.isFinite(sourceTime)
        || String(origin.provider) !== event.backend) continue
      const providerTurnKey = origin.provider === 'codex'
        ? codexProviderTurnKey(origin.session_id, origin.turn_id)
        : null
      const providerTurnMatches = providerTurnKey
        ? [...(this.nativeCrossChatFinishesByProviderTurn.get(providerTurnKey) ?? [])]
            .filter(([, finish]) => {
              if (finish.session_id !== event.session_id || finish.backend !== 'codex') return false
              const finishTime = Date.parse(finish.ts)
              return Number.isFinite(finishTime) && sourceTime <= finishTime
            })
        : []
      if (hasProviderUserProvenance(event)) {
        // Codex currently labels AgentsDock's own cross-chat provider input as
        // `user.text`. Thread + turn ownership narrows the candidate, but does
        // not identify its input: a human can steer within that same turn.
        // Require the exact receipt/body, native start and time bounds below.
        // Pages missing that evidence stay visible for source-proven repair.
        if (providerTurnMatches.length !== 1) continue
      }
      const matches = (byHash.get(importedCrossChatBodyHash(event, delivery.body)) ?? []).filter(native => {
        const receipt = this.crossChatDeliveryReceipts.get(native.start.run_id!)!
        const startTime = Date.parse(native.start.ts)
        const finishTime = Date.parse(native.finish!.ts)
        const kind = delivery.kind === 'final_result' ? 'reply' : delivery.kind
        return native.start.session_id === event.session_id
          && native.start.backend === event.backend
          && crossChatProviderSessionId(native.finish!) === origin.session_id
          && (!hasProviderUserProvenance(event) || native.start.run_id === providerTurnMatches[0][0])
          && (delivery.mode === 'async_route_v1'
            ? isAsyncCrossChatMessage(receipt) && (receipt.kind || receipt.handoff_action) === kind
              && delivery.ordinal === 1 && delivery.maxLegs === 1
              && Boolean(receipt.message_edited_by_user) === Boolean(delivery.editedByUser)
            : !isAsyncCrossChatMessage(receipt) && receipt.exchange_leg_kind === kind
              && receipt.exchange_ordinal === delivery.ordinal && receipt.exchange_max_legs === delivery.maxLegs)
          && Number.isFinite(startTime) && Number.isFinite(finishTime)
          && startTime <= sourceTime && sourceTime <= finishTime
      })
      // Correlate one complete wrapper with one exact owned leg; never infer
      // identity from preview/title similarity or hide a whole imported run.
      if (matches.length !== 1) continue
      const runId = matches[0].start.run_id!
      candidates.set(event.id, runId)
      const origins = originsByRun.get(runId) ?? new Set<string>()
      origins.add(origin.event_id)
      originsByRun.set(runId, origins)
    }
    const aliases = new Set([...candidates].filter(([, runId]) => originsByRun.get(runId)?.size === 1).map(([id]) => id))
    const outputAliases = new Set<string>()
    for (const { event, inputId } of this.importedCrossChatOutputs.values()) {
      if (!aliases.has(inputId) || hasProviderUserProvenance(event)) continue
      const runId = candidates.get(inputId)!
      const native = this.nativeCrossChatDeliveries.get(runId)!
      const origin = event.provider_origin!
      const output = this.nativeCrossChatOutputs.get(`${runId}:${origin.event_id}`)
      // A repeated answer needs its own provider-message identity proof. A
      // matched input never authorizes hiding the rest of an imported run.
      if (output && output.session_id === event.session_id && output.backend === event.backend
        && String(origin.provider) === event.backend && origin.session_id === crossChatProviderSessionId(native.finish!)
        && normalizeAssistantOutput(output.text || '')
        && normalizeAssistantOutput(output.text || '') === normalizeAssistantOutput(event.text || event.result_text || '')) {
        outputAliases.add(event.id)
      }
    }
    // A later distinct provider record can make an earlier correlation
    // ambiguous. Restore that input by rebuilding; hidden aliases are not a
    // monotonic set and ordinary user quotations must never disappear.
    const removed = [...this.importedCrossChatAliases].some(id => !aliases.has(id))
      || [...this.importedCrossChatOutputAliases].some(id => !outputAliases.has(id))
    const added = new Set([
      ...[...aliases].filter(id => !this.importedCrossChatAliases.has(id)),
      ...[...outputAliases].filter(id => !this.importedCrossChatOutputAliases.has(id))
    ])
    const addedVisible = added.size > 0 && this.itemsValue.some(item => item.kind === 'turn'
      && (Boolean(item.user && added.has(item.user.id)) || item.assistant.some(event => added.has(event.id))))
    this.importedCrossChatAliases.clear()
    for (const id of aliases) this.importedCrossChatAliases.add(id)
    this.importedCrossChatOutputAliases.clear()
    for (const id of outputAliases) this.importedCrossChatOutputAliases.add(id)
    return !this.itemsValue.length || !removed && !addedVisible
  }

  private applyCrossChatTerminalStatus(event: Event): Event {
    const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim() || ''
    if (!exchangeId) return event
    const terminalStatus = terminalCrossChatExchangeStatus(event)
    if (terminalStatus) {
      this.crossChatTerminalStatusByExchange.set(exchangeId, terminalStatus)
      for (const [key, item] of this.crossChatByKey) {
        const itemExchangeId = item.event.exchange_id?.trim() || item.event.cross_chat_exchange_id?.trim() || ''
        if (itemExchangeId !== exchangeId || item.event.exchange_status === terminalStatus) continue
        const events = item.events?.map(candidate => ({
          ...candidate,
          exchange_status: terminalStatus
        }))
        const updated: SystemItem = {
          ...item,
          event: { ...item.event, exchange_status: terminalStatus },
          ...(events ? { events } : {})
        }
        this.crossChatByKey.set(key, updated)
        this.replaceItem(updated)
      }
    }
    const effectiveStatus = terminalStatus || this.crossChatTerminalStatusByExchange.get(exchangeId)
    return effectiveStatus && event.exchange_status !== effectiveStatus
      ? { ...event, exchange_status: effectiveStatus }
      : event
  }

  private appendAssistantOutput(turn: TurnItem, event: Event, candidate: string, aggregate: boolean): void {
    const normalized = normalizeAssistantOutput(candidate)
    if (!normalized) return

    let state = this.assistantByTurn.get(turn.key)
    if (!state) {
      const parts = turn.assistant
        .map(previous => normalizeAssistantOutput(messageText(previous)))
        .filter(Boolean)
      state = { parts, seen: new Set(parts) }
      this.assistantByTurn.set(turn.key, state)
    }
    if (state.seen.has(normalized)) return
    if (aggregate && state.parts.length > 0) {
      if (state.parts.join(' ') === normalized) return
      if (containsInOrder(normalized, state.parts)) {
        turn.assistant.splice(0, turn.assistant.length, event)
        state.parts = [normalized]
        state.seen = new Set(state.parts)
        return
      }
    }
    turn.assistant.push(event)
    state.parts.push(normalized)
    state.seen.add(normalized)
  }

  private appendJobEvent(event: Event, jobId: string): void {
    const title = event.job_title || event.job?.title || this.jobTitles.get(jobId) || event.message || 'Scheduled job'
    const runId = String(event.run_id || '').trim()
    const explicitGroupId = String(event.job_timeline_group_id || '').trim()
    const jobRunKey = runId ? `${jobId}\0${runId}` : ''
    const priorOccurrenceKey = jobRunKey ? this.jobOccurrenceByJobRun.get(jobRunKey) : undefined
    const stableOccurrenceId = jobOccurrenceIdentity(event)
    const stableOccurrenceKey = stableOccurrenceId
      ? `${jobId}\0occurrence:${stableOccurrenceId}`
      : ''
    const startsRecycledOccurrence = Boolean(
      runId
      && priorOccurrenceKey
      && (
        stableOccurrenceKey
          ? stableOccurrenceKey !== priorOccurrenceKey
          : event.type === 'turn_started' && this.startedJobOccurrences.has(priorOccurrenceKey)
      )
    )
    const occurrenceKey = stableOccurrenceKey || (runId
      ? startsRecycledOccurrence
        ? `${jobRunKey}\0start:${event.seq}`
        : priorOccurrenceKey || jobRunKey
      : '')
    let state = explicitGroupId ? this.jobByGroupId.get(explicitGroupId) : undefined
    const occurrenceState = stableOccurrenceKey
      ? this.jobStateByOccurrence.get(stableOccurrenceKey)
      : undefined
    const runState = !stableOccurrenceKey && jobRunKey
      ? this.jobStateByJobRun.get(jobRunKey)
      : undefined
    const provisionalState = occurrenceState || (
      !startsRecycledOccurrence ? runState : undefined
    )
    if (
      !state
      && explicitGroupId
      && provisionalState?.jobId === jobId
      && !provisionalState.authoritativeGroupId
    ) {
      state = this.rekeyJobState(provisionalState, explicitGroupId)
    }
    if (!state && !explicitGroupId && occurrenceState?.jobId === jobId) {
      state = occurrenceState
    }
    if (!state && !explicitGroupId && !startsRecycledOccurrence && runState?.jobId === jobId) {
      state = runState
    }
    if (!state && !explicitGroupId && event.type === 'job_summary') {
      state = this.latestJobById.get(jobId)
    }
    if (!state && !explicitGroupId) {
      const latestItem = this.itemsValue.at(-1)
      const latestState = latestItem?.kind === 'job'
        ? this.jobByGroupId.get(latestItem.key)
        : undefined
      if (latestState?.jobId === jobId) state = latestState
    }
    if (!state) {
      const segmentCount = this.jobSegmentCountById.get(jobId) ?? 0
      const groupId = explicitGroupId || (
        segmentCount === 0
          ? `job:${jobId}`
          : `job:${jobId}:segment:${event.seq}`
      )
      const item: JobItem = {
        kind: 'job', id: groupId, key: groupId, seq: event.seq,
        jobId, timelineGroupId: groupId,
        title, events: [], latest: event, eventCount: 0, runCount: 0,
        startSeq: event.seq, endSeq: event.seq
      }
      state = {
        jobId,
        authoritativeGroupId: explicitGroupId || null,
        item,
        runIds: new Set(),
        runFirstSeq: new Map(),
        reportedRunCount: 0,
        reportedAtSeq: 0,
        bestByRun: new Map(),
        standalone: [],
        latestRunId: null,
        latestRunExtras: [],
        latestStatus: jobStatusEvent(event) ? event : undefined
      }
      this.jobByGroupId.set(groupId, state)
      this.jobSegmentCountById.set(jobId, segmentCount + 1)
      this.latestJobById.set(jobId, state)
      this.addItem(item)
    } else if (explicitGroupId) {
      state.authoritativeGroupId = explicitGroupId
    }

    if (stableOccurrenceKey) this.jobStateByOccurrence.set(stableOccurrenceKey, state)
    if (runId) {
      if (
        !stableOccurrenceKey
        || !priorOccurrenceKey
        || priorOccurrenceKey === occurrenceKey
        || event.type === 'turn_started'
      ) {
        this.jobStateByJobRun.set(jobRunKey, state)
        this.jobOccurrenceByJobRun.set(jobRunKey, occurrenceKey)
      }
      if (event.type === 'turn_started') this.startedJobOccurrences.add(occurrenceKey)
      state.runIds.add(occurrenceKey)
      const firstSeq = state.runFirstSeq.get(occurrenceKey)
      if (firstSeq == null || event.seq < firstSeq) state.runFirstSeq.set(occurrenceKey, event.seq)
    }
    const priority = jobDisplayPriority(event)
    if (runId && priority) {
      const current = state.bestByRun.get(occurrenceKey)
      const currentPriority = current ? jobDisplayPriority(current) : 0
      if (!current || priority > currentPriority || priority === currentPriority && event.seq >= current.seq) {
        state.bestByRun.set(occurrenceKey, event)
        if (state.bestByRun.size > MAX_BUNDLED_JOB_RUNS) {
          const oldest = [...state.bestByRun.entries()]
            .sort((left, right) => left[1].seq - right[1].seq)[0]
          if (oldest) state.bestByRun.delete(oldest[0])
        }
      }
    } else if (!runId && (priority || event.type === 'job_summary')) {
      state.standalone.push(event)
      if (state.standalone.length > MAX_STANDALONE_JOB_UPDATES) state.standalone.splice(0, state.standalone.length - MAX_STANDALONE_JOB_UPDATES)
    }

    if (event.seq >= state.item.latest.seq) {
      if (runId && occurrenceKey !== state.latestRunId) {
        state.latestRunId = occurrenceKey
        state.latestRunExtras = []
      }
      state.item = { ...state.item, latest: event }
    }
    if (jobStatusEvent(event) && jobStatusShouldReplace(state.latestStatus, event)) {
      state.latestStatus = event
    }
    if (runId && occurrenceKey === state.latestRunId && (
      eventFile(event)
      || event.type === 'code_diff'
      || event.type === 'reasoning_summary'
      || event.type === 'tool_started'
      || event.type === 'tool_finished'
    )) {
      const index = state.latestRunExtras.findIndex(candidate => candidate.id === event.id)
      if (index >= 0) state.latestRunExtras[index] = event
      else state.latestRunExtras.push(event)
      if (state.latestRunExtras.length > MAX_LATEST_JOB_EXTRAS) {
        state.latestRunExtras.splice(0, state.latestRunExtras.length - MAX_LATEST_JOB_EXTRAS)
      }
    }

    const compactEvents = deduplicateEvents([
      ...state.standalone,
      ...state.bestByRun.values(),
      ...state.latestRunExtras,
      state.item.latest
    ])
    // Older semantic servers report lifetime job totals. Once a visible
    // boundary has split that lifetime into cards, those totals would make
    // the newest segment absorb every earlier run again. New servers bind
    // group-local totals with job_timeline_group_id.
    const acceptsReportedTotals = Boolean(explicitGroupId)
      || (this.jobSegmentCountById.get(jobId) ?? 0) <= 1
    const reportedEventCount = acceptsReportedTotals ? positiveEventCount(event.job_event_count) : 0
    const reportedRunCount = acceptsReportedTotals ? positiveEventCount(event.job_run_count) : 0
    const reportedStartSeq = acceptsReportedTotals ? positiveEventCount(event.job_start_seq) : 0
    const reportedEndSeq = acceptsReportedTotals ? positiveEventCount(event.job_end_seq) : 0
    const reportedSnapshotSeq = reportedEndSeq || event.seq
    if (
      (reportedRunCount > 0 || reportedEventCount > 0)
      && reportedSnapshotSeq >= state.reportedAtSeq
    ) {
      if (reportedRunCount > 0) state.reportedRunCount = reportedRunCount
      state.reportedAtSeq = reportedSnapshotSeq
    }
    const runsAfterSummary = state.reportedAtSeq > 0
      ? [...state.runFirstSeq.values()].filter(seq => seq > state.reportedAtSeq).length
      : 0
    const coveredByReportedSummary = state.reportedAtSeq > 0
      && event.seq <= state.reportedAtSeq
    const nextEventCount = event.type === 'job_summary' || coveredByReportedSummary
      ? state.item.eventCount
      : state.item.eventCount + 1
    const next: JobItem = {
      ...state.item,
      title: title && state.item.title === 'Scheduled job' ? title : state.item.title,
      events: compactEvents,
      displayUpdates: [
        ...state.standalone.filter(candidate => candidate.type !== 'job_summary'),
        ...state.bestByRun.values()
      ]
        .sort((left, right) => left.seq - right.seq),
      latestStatus: state.latestStatus,
      eventCount: Math.max(nextEventCount, reportedEventCount),
      runCount: Math.max(
        state.item.runCount,
        state.runIds.size,
        state.reportedRunCount + runsAfterSummary
      ),
      startSeq: Math.min(state.item.startSeq, event.seq, reportedStartSeq || event.seq),
      endSeq: Math.max(state.item.endSeq, event.seq, reportedEndSeq)
    }
    state.item = next
    this.replaceItem(next)
  }

  private rekeyJobState(state: JobProjectionState, groupId: string): JobProjectionState {
    const oldKey = state.item.key
    if (oldKey === groupId) {
      state.authoritativeGroupId = groupId
      state.item = { ...state.item, timelineGroupId: groupId }
      return state
    }
    const index = this.itemIndex.get(oldKey)
    if (this.jobByGroupId.get(oldKey) === state) this.jobByGroupId.delete(oldKey)
    this.itemIndex.delete(oldKey)
    state.authoritativeGroupId = groupId
    state.item = {
      ...state.item,
      id: groupId,
      key: groupId,
      timelineGroupId: groupId
    }
    this.jobByGroupId.set(groupId, state)
    if (index == null) this.addItem(state.item)
    else {
      this.itemsValue[index] = state.item
      this.itemIndex.set(groupId, index)
    }
    return state
  }

  private appendDigestEvent(event: Event): void {
    const digestId = String(event.digest_job_id || '').trim()
    if (!digestId) return
    const existing = this.digestById.get(digestId)
    if (existing) {
      const nextPriority = digestDisplayPriority(event)
      const currentPriority = digestDisplayPriority(existing.event)
      if (nextPriority > currentPriority || nextPriority === currentPriority && event.seq >= existing.event.seq) {
        const next = { ...existing, event }
        this.digestById.set(digestId, next)
        this.replaceItem(next)
      }
      return
    }
    const item: SystemItem = {
      kind: 'system', id: `digest:${digestId}`, key: `digest:${digestId}`, seq: event.seq, event
    }
    this.digestById.set(digestId, item)
    this.addItem(item)
  }

  private appendCodexLifecycleEvent(event: Event, lifecycleKey: string): void {
    const existing = this.codexLifecycleByKey.get(lifecycleKey)
    const compaction = lifecycleKey.startsWith('codex:compaction:')
    const eventPriority = codexLifecycleEventPriority(event)
    const existingPriority = existing ? codexLifecycleEventPriority(existing.event) : -1
    const displayEvent = existing && (
      eventPriority < existingPriority
      || eventPriority === existingPriority && event.seq < existing.event.seq
    )
      ? existing.event
      : event
    const item: SystemItem = existing
      ? {
          ...existing,
          seq: compaction ? Math.min(existing.seq, event.seq) : event.seq,
          event: displayEvent,
          anchorTs: compaction && event.seq < existing.seq
            ? event.ts
            : existing.anchorTs
        }
      : {
          kind: 'system',
          id: lifecycleKey,
          key: lifecycleKey,
          seq: event.seq,
          event,
          anchorTs: compaction ? event.ts : undefined
        }
    this.codexLifecycleByKey.set(lifecycleKey, item)
    this.replaceItem(item)
    if (existing && item.seq !== existing.seq) this.movedKeys.add(lifecycleKey)
  }

  private retireNativeSteerLogicalTurn(event: Event): void {
    this.retireLogicalTurn(event)
  }

  private retireLogicalTurn(event: Event, genuinelyStopped = false): void {
    const turn = event.run_id
      ? this.turnByRun.get(event.run_id)
      : this.activeTurn
    if (!turn) return
    const retired = this.writableTurn(turn)
    retired.finishedAt = event.ts
    retired.terminalSeq = event.seq
    if (genuinelyStopped) retired.stoppedAt ||= event.ts
    this.assistantByTurn.delete(retired.key)
    if (this.activeTurn?.key === retired.key) this.activeTurn = null
  }

  private retireActiveTurnAtIdle(timestamp: string): void {
    const active = this.activeTurn
    if (!active) return
    const retired = this.writableTurn(active)
    retired.finishedAt = timestamp
    this.assistantByTurn.delete(retired.key)
    this.activeTurn = null
  }

  private activeTurnBackend(): Event['backend'] {
    const active = this.activeTurn
    if (!active) return null
    // turn_started is the strongest ownership signal and normally carries
    // the selected backend. Fall back to the newest explicitly tagged turn
    // event for partial/reconstructed streams that omitted the start event.
    if (active.user?.backend) return active.user.backend
    return [...active.assistant, ...active.trace]
      .filter(candidate => Boolean(candidate.backend))
      .sort((left, right) => right.seq - left.seq)[0]?.backend ?? null
  }

  private retireNativeSteerPredecessor(runId: string, timestamp: string): void {
    // Semantic timeline pages intentionally omit the native transition stop.
    // Reconstruct its terminal boundary from successor metadata when a chat
    // is reloaded. Its commentary and tools remain one completed activity
    // disclosure; they never become a synthetic assistant answer.
    const predecessor = this.turnByRun.get(runId)
    if (!predecessor) return
    const retired = this.writableTurn(predecessor)
    retired.finishedAt ||= timestamp
    // Some provider streams acknowledge an interrupted run first as a
    // generic `turn_finished { stopped: true }`, then identify the actual
    // steering transition only on the successor's `turn_started` event.
    // Successor metadata is authoritative: this was a steer boundary, not an
    // explicit user Stop, so remove the provisional stopped presentation.
    retired.stoppedAt = undefined
    this.assistantByTurn.delete(retired.key)
    if (this.activeTurn?.key === retired.key) this.activeTurn = null
  }

  private ensureTurn(event: Event, forceNew = false): TurnItem {
    const runKey = event.run_id || this.activeTurn?.runId || `seq-${event.seq}`
    const existing = this.turnByRun.get(runKey)
    if (existing && !forceNew) return existing
    const itemKey = forceNew ? `${runKey}:start-${event.seq}` : runKey
    const turn: TurnItem = {
      kind: 'turn', id: `turn:${itemKey}`, key: `turn:${itemKey}`, runId: event.run_id,
      providerThreadId: this.providerThreadForRun(event.run_id),
      seq: event.seq, assistant: [], trace: [], promotedCommentaryIds: [], files: [], startedAt: event.ts, purpose: event.purpose
    }
    this.turnByRun.set(runKey, turn)
    this.addItem(turn)
    return turn
  }

  private rememberRootProviderThread(event: Event): void {
    const runId = event.run_id?.trim() || ''
    const threadId = event.provider_session_id?.trim() || event.thread_id?.trim() || ''
    if (!runId || !threadId) return
    this.rootThreadByRun.set(runId, threadId)
    const turn = this.turnByRun.get(runId)
    if (turn && turn.providerThreadId !== threadId) {
      this.writableTurn(turn).providerThreadId = threadId
    }
  }

  private providerThreadForRun(runId: string | null | undefined): string | null {
    const normalizedRunId = runId?.trim() || ''
    if (!normalizedRunId) return null
    return this.rootThreadByRun.get(normalizedRunId)
      ?? (
        normalizedRunId === this.scope.activeRunId?.trim()
          ? this.scope.rootThreadId?.trim() || null
          : null
      )
  }

  private expectedRootThreadForCompaction(event: Event): string | null {
    const eventRunId = event.run_id?.trim() || ''
    const activeRunId = this.activeTurn?.runId?.trim() || ''
    return this.providerThreadForRun(eventRunId || activeRunId)
  }

  private writableTurn(turn: TurnItem): TurnItem {
    if (this.writableKeys.has(turn.key)) return turn
    const next: TurnItem = {
      ...turn,
      assistant: [...turn.assistant],
      trace: [...turn.trace],
      promotedCommentaryIds: [...turn.promotedCommentaryIds],
      files: [...turn.files]
    }
    this.writableKeys.add(next.key)
    this.replaceItem(next)
    for (const [runId, candidate] of this.turnByRun) if (candidate === turn) this.turnByRun.set(runId, next)
    if (this.activeTurn === turn) this.activeTurn = next
    return next
  }

  private addItem(item: TimelineItem): void {
    this.itemIndex.set(item.key, this.itemsValue.length)
    this.itemsValue.push(item)
  }

  private replaceItem(item: TimelineItem): void {
    const index = this.itemIndex.get(item.key)
    if (index == null) { this.addItem(item); return }
    this.itemsValue[index] = item
  }

  private removeItem(key: string): void {
    const index = this.itemIndex.get(key)
    if (index == null) return
    this.itemsValue.splice(index, 1)
    this.movedKeys.delete(key)
    this.reindex()
  }

  private reindex(): void {
    this.itemIndex.clear()
    this.itemsValue.forEach((item, index) => this.itemIndex.set(item.key, index))
  }

  private repositionMovedItems(): void {
    const moving = this.itemsValue.filter(item => this.movedKeys.has(item.key)).sort((left, right) => left.seq - right.seq)
    const stationary = this.itemsValue.filter(item => !this.movedKeys.has(item.key))
    const merged: TimelineItem[] = []
    let stationaryIndex = 0
    let movingIndex = 0
    while (stationaryIndex < stationary.length || movingIndex < moving.length) {
      const stationaryItem = stationary[stationaryIndex]
      const movingItem = moving[movingIndex]
      if (!movingItem || stationaryItem && stationaryItem.seq <= movingItem.seq) {
        merged.push(stationaryItem)
        stationaryIndex += 1
      } else {
        merged.push(movingItem)
        movingIndex += 1
      }
    }
    this.itemsValue = merged
  }
}

/**
 * Servers predating the child-thread isolation fix could persist a child
 * compaction in its parent chat. Prefer the owning root thread recorded for
 * the active turn; the token snapshot mismatch is only a compatibility
 * fallback for old history without provider-session ownership metadata.
 */
function isLeakedChildCompaction(event: Event, expectedRootThreadId?: string | null): boolean {
  if (
    event.type !== 'codex_compaction_started'
    && event.type !== 'codex_compaction_completed'
  ) return false
  const eventThreadId = event.thread_id?.trim() || ''
  if (!eventThreadId) return false
  const expected = expectedRootThreadId?.trim() || ''
  if (expected) return eventThreadId !== expected
  const usageThreadIds = [event.token_usage_before, event.token_usage_after]
    .map(usage => usage?.thread_id)
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => value.trim())
  return usageThreadIds.some(threadId => threadId !== eventThreadId)
}

function positiveEventCount(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 0
}

function jobOccurrenceIdentity(event: Event): string {
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

export function projectTimeline(
  events: Event[],
  knownFiles: AgentFile[],
  scope: TimelineProjectionScope = {}
): TimelineItem[] {
  const projector = new TimelineProjector(knownFiles, scope)
  if (!projector.append(events)) throw new Error('Initial timeline projection could not be constructed')
  return projector.items
}

function deduplicateEvents(events: Event[]): Event[] {
  return [...new Map(events.map(event => [event.id, event])).values()].sort((left, right) => left.seq - right.seq)
}

const CONTEXT_DIGEST_HEADINGS = ['# AgentsDock Context Digest']

function isNativeMailboxWakeInput(event: Event): boolean {
  return event.type === 'turn_started' && event.imported !== true
    && (event.backend === 'codex' || event.backend === 'claude')
    && typeof event.run_id === 'string' && Boolean(event.run_id.trim()) && !event.run_id.startsWith('import_')
    && event.purpose === 'chat_mailbox_wake' && event.prompt === '' && event.provider_generated === true
    && !hasProviderUserProvenance(event)
    && typeof event.mailbox_wake_id === 'string' && /^mailwake_[a-f0-9]{32}$/.test(event.mailbox_wake_id)
    && Number.isSafeInteger(event.mailbox_wake_through_seq) && (event.mailbox_wake_through_seq ?? 0) > 0
    && typeof event.provider_input_sha256 === 'string' && /^[a-f0-9]{64}$/.test(event.provider_input_sha256)
}

function digestBody(event: Event): string {
  if (event.type !== 'turn_started') return ''
  const prompt = event.prompt?.trim() || ''
  return CONTEXT_DIGEST_HEADINGS.some(heading => prompt.startsWith(heading)) ? prompt : ''
}

function isDigestDeliveryTurn(event: Event): boolean {
  return event.purpose === 'handoff_digest_delivery'
    || event.purpose === 'cross_chat_handoff_delivery'
    || Boolean(digestBody(event))
}

function digestDisplayPriority(event: Event): number {
  if (event.type === 'handoff_digest_error') return 50
  if (event.type === 'handoff_digest_sent' || event.type === 'handoff_digest_received') return 40
  if (event.type === 'handoff_digest_ready' || event.type === 'handoff_digest_submitted') return 30
  if (event.type === 'handoff_digest_started') return 20
  return event.purpose === 'handoff_digest' ? 10 : 0
}

export function reconcileTimelineItems(previous: TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  if (!previous.length) return next
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  return next.map(item => {
    const before = previousByKey.get(item.key)
    return before && timelineItemEqual(before, item) ? before : item
  })
}

const renderedItemCache = new WeakMap<TimelineItem, RenderTimelineItem[]>()

export function renderTimelineItems(items: TimelineItem[]): RenderTimelineItem[] {
  const rows: RenderTimelineItem[] = []
  const activityTurns = new Map<string, TurnItem>()
  for (const item of items) {
    let rendered = renderedItemCache.get(item)
    if (!rendered) {
      rendered = renderTimelineItem(item)
      renderedItemCache.set(item, rendered)
    }
    for (const row of rendered) {
      rows.push(row)
      if (row.kind === 'progress' && item.kind === 'turn') activityTurns.set(row.key, item)
    }
  }
  const chronologicalRows = rows.filter(isCompactionRow)
  if (!chronologicalRows.length) return interleaveChronologicalSystemRows(rows)
  const embeddedKeys = new Set<string>()
  const canonical = rows.map(row => {
    if (row.kind !== 'progress') return row
    const turn = activityTurns.get(row.key)
    if (!turn) return row
    const progress = embedChronologicalRows(row, chronologicalRows, turn)
    for (const lifecycle of progress.lifecycle ?? []) embeddedKeys.add(lifecycle.key)
    return progress
  })
  return interleaveChronologicalSystemRows(
    canonical.filter(row => !embeddedKeys.has(row.key))
  )
}

/**
 * Keep run activity and its context-compaction markers in one chronological surface.
 * Applying this to both live and completed turns makes an in-place settle and
 * a cold history projection structurally identical. Durable user-facing
 * system events (emergency, Team mail, cross-chat) remain standalone rows.
 */
function embedChronologicalRows(
  progress: ProgressItem,
  chronologicalRows: SystemItem[],
  turn: TurnItem
): ProgressItem {
  const turnStartSeq = progress.afterSeq == null ? turn.seq : progress.afterSeq + 1
  const turnEndSeq = progress.throughSeq ?? (turn.finishedAt
    ? Math.max(
        turn.seq,
        ...turn.assistant.map(event => event.seq),
        ...turn.trace.map(event => event.seq)
      )
    : Number.POSITIVE_INFINITY)
  const lifecycle = chronologicalRows
    .filter(row => row.seq >= turnStartSeq)
    .filter(row => row.seq <= turnEndSeq)
    .filter(row => systemRowBelongsToTurn(row, turn))
    .sort((left, right) => left.seq - right.seq)
  if (!lifecycle.length) return progress
  return {
    ...progress,
    lifecycle
  }
}

function systemRowBelongsToTurn(row: SystemItem, turn: TurnItem | undefined): boolean {
  if (!turn) return false
  const eventRunId = row.event.run_id?.trim() || ''
  const turnRunId = turn.runId?.trim() || ''
  if (eventRunId && turnRunId && eventRunId !== turnRunId) return false

  const eventThreadId = row.event.thread_id?.trim() || ''
  const turnThreadId = turn.providerThreadId?.trim() || ''
  if (eventThreadId && turnThreadId && eventThreadId !== turnThreadId) return false

  // Modern events carry at least one comparable provider identity. Legacy
  // lifecycle records carried neither and retain the sequence fallback.
  if (eventRunId && turnRunId) return true
  if (eventThreadId && turnThreadId) return true
  return !eventRunId && !eventThreadId
}

/**
 * A turn is one projection item but renders as separate user/trace/assistant
 * rows. Arrival-sensitive lifecycle markers can land between those rows, so
 * merge them by their immutable first-arrival anchor after flattening. Job
 * cards and ordinary status rows retain their existing presentation semantics.
 */
function interleaveChronologicalSystemRows(rows: RenderTimelineItem[]): RenderTimelineItem[] {
  const chronological = rows.filter(isChronologicalSystemRow)
  if (!chronological.length) return rows
  return groupAdjacentMailboxRows(interleaveAnchoredRows(
    splitProgressAtMessages(rows.filter(row => !isChronologicalSystemRow(row)), chronological),
    chronological
  ))
}

function groupAdjacentMailboxRows(rows: RenderTimelineItem[]): RenderTimelineItem[] {
  const grouped: RenderTimelineItem[] = []
  for (const row of rows) {
    if (row.kind !== 'system' || !isChatMailboxEvent(row.event)
      || row.event.target_session_id !== row.event.session_id || row.event.source_session_id === row.event.session_id) {
      grouped.push(row)
      continue
    }
    const previous = grouped.at(-1)
    const messages = row.mailboxMessages ?? [row]
    if (previous?.kind === 'system' && previous.mailboxMessages
      && previous.event.source_session_id === row.event.source_session_id
      && previous.event.target_session_id === row.event.target_session_id) {
      // This array was allocated below for this rendering pass; inputs and
      // previously cached rows remain immutable even for long sender bursts.
      previous.mailboxMessages.push(...messages)
    } else grouped.push({ ...row, mailboxMessages: [...messages] })
  }
  return grouped
}

function progressToolKey(event: Event): string {
  const id = event.tool_id?.trim() || event.tool?.id?.trim()
  return id ? `${event.run_id?.trim() || 'runless'}:${id}` : ''
}

/** The result updates its tool, not a second tool below a later message. */
export function progressEventSequence(event: Event, progress?: ProgressItem): number {
  if (progress?.toolStartSequences && (event.type === 'tool_started' || event.type === 'tool_finished')) {
    const seq = progress.toolStartSequences[progressToolKey(event)]
    if (seq != null) return seq
  }
  return activityEventSequence(event, progress?.orderingFinalEvents)
}

/** Full trace pages may contain tool starts absent from the compact sample. */
export function progressToolStartSequences(events: Event[], known: Readonly<Record<string, number>> = {}): Record<string, number> {
  const starts = { ...known }
  for (const event of events) {
    const key = progressToolKey(event)
    if (event.type === 'tool_started' && key) starts[key] = Math.min(starts[key] ?? event.seq, event.seq)
  }
  return starts
}

function sameToolStartSequences(left?: Readonly<Record<string, number>>, right?: Readonly<Record<string, number>>): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}

function firstAnchorAtOrAfter(anchors: SystemItem[], seq: number): number {
  let low = 0, high = anchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (anchors[middle].seq < seq) low = middle + 1
    else high = middle
  }
  return low
}

/** Split only the affected activity; ordinary chats keep their exact rows. */
function splitProgressAtMessages(rows: RenderTimelineItem[], chronological: SystemItem[]): RenderTimelineItem[] {
  const messages = chronological.filter(row => crossChatSemanticKey(row.event) !== null)
    .sort((left, right) => left.seq - right.seq)
  if (!messages.length) return rows
  return rows.flatMap((row): RenderTimelineItem[] => {
    if (row.kind !== 'progress') return [row]
    const start = firstAnchorAtOrAfter(messages, row.seq)
    const endSeq = row.throughSeq ?? row.finalEvents?.[0]?.seq ?? row.terminalSeq
      ?? (row.active ? Number.POSITIVE_INFINITY : Math.max(row.seq, ...row.events.map(event => event.seq)))
    const end = firstAnchorAtOrAfter(messages, endSeq)
    const cuts = messages.slice(start, end)
    if (!cuts.length) return [row]

    const toolStartSequences = progressToolStartSequences(row.sourceEvents ?? row.events)
    const context = { ...row, toolStartSequences }
    const buckets = Array.from({ length: cuts.length + 1 }, () => ({ events: [] as Event[], source: [] as Event[], lifecycle: [] as SystemItem[] }))
    for (const event of row.events) buckets[firstAnchorAtOrAfter(cuts, progressEventSequence(event, context))].events.push(event)
    for (const event of row.sourceEvents ?? row.events) buckets[firstAnchorAtOrAfter(cuts, progressEventSequence(event, context))].source.push(event)
    for (const item of row.lifecycle ?? []) buckets[firstAnchorAtOrAfter(cuts, item.seq)].lifecycle.push(item)
    return buckets.flatMap((bucket, index): ProgressItem[] => {
      const last = index === cuts.length
      // Retain a live tail even while the sender has not emitted its next
      // update. Sending an async message must not look like stopping work.
      if (!bucket.events.length && !bucket.lifecycle.length && !(last && (row.active || row.stoppedAt))) return []
      const before = cuts[index - 1]
      const suffix = before ? `:after:message:${before.key}` : ''
      return [{
        ...row, id: `${row.id}${suffix}`, key: `${row.key}${suffix}`,
        seq: before ? before.seq : row.seq,
        events: bucket.events, sourceEvents: bucket.source,
        lifecycle: bucket.lifecycle, toolStartSequences,
        active: last && row.active, continues: !last,
        afterSeq: before?.seq ?? row.afterSeq,
        throughSeq: last ? row.throughSeq : cuts[index].seq,
        finishedAt: last ? row.finishedAt : cuts[index].anchorTs ?? cuts[index].event.ts,
        stoppedAt: last ? row.stoppedAt : undefined
      }]
    })
  })
}

function interleaveAnchoredRows(
  contentRows: RenderTimelineItem[],
  anchoredRows: RenderTimelineItem[]
): RenderTimelineItem[] {
  // The idle-path calls this helper for every settled timeline. Preserve the
  // existing array when there is nothing to place so ordinary chats stay
  // linear and retain their render-item identities.
  if (!anchoredRows.length) return contentRows

  // Most rows are sequence ordered, but live progress is deliberately moved
  // to the presentation edge and can therefore have a lower sequence than a
  // preceding row. For every anchored row, find the last presented content
  // row at or before its sequence, then rebuild from insertion buckets. This
  // preserves all non-compaction presentation order in O(n log n) rather than
  // rescanning/splicing the full timeline for every marker.
  const content = contentRows.map((row, contentIndex) => ({ row, contentIndex }))
  const contentBySequence = [...content]
    .sort((left, right) => left.row.seq - right.row.seq || left.contentIndex - right.contentIndex)
  const anchored = anchoredRows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => left.row.seq - right.row.seq || left.index - right.index)
  const insertions = Array.from(
    { length: content.length + 1 },
    (): RenderTimelineItem[] => []
  )
  let contentCursor = 0
  let lastPresentedContentIndex = -1
  for (const candidate of anchored) {
    while (
      contentCursor < contentBySequence.length
      && (contentBySequence[contentCursor].row.seq < candidate.row.seq
        || contentBySequence[contentCursor].row.seq === candidate.row.seq
          && !(contentBySequence[contentCursor].row.kind === 'progress'
            && (contentBySequence[contentCursor].row as ProgressItem).afterSeq === candidate.row.seq))
    ) {
      lastPresentedContentIndex = Math.max(lastPresentedContentIndex, contentBySequence[contentCursor].contentIndex)
      contentCursor += 1
    }
    insertions[lastPresentedContentIndex + 1].push(candidate.row)
  }

  const ordered: RenderTimelineItem[] = []
  ordered.push(...insertions[0])
  for (let index = 0; index < content.length; index += 1) {
    ordered.push(content[index].row, ...insertions[index + 1])
  }
  return ordered
}

function isCompactionRow(item: RenderTimelineItem): item is SystemItem {
  return item.kind === 'system' && item.key.startsWith('codex:compaction:')
}

function isChronologicalSystemRow(item: RenderTimelineItem): item is SystemItem {
  return item.kind === 'system' && (
    item.key.startsWith('codex:compaction:')
    || item.event.type === 'emergency_alert_raised'
    || item.event.type === 'team_message_sent'
    || crossChatSemanticKey(item.event) !== null
  )
}

/**
 * Semantic history intentionally omits Codex thread-status events. When the
 * authoritative session snapshot says the thread is no longer active, settle
 * a reconstructed live edge without mutating the cached semantic projection.
 */
export function settleInactiveTimelineItems(items: RenderTimelineItem[]): RenderTimelineItem[] {
  return items.map(item => {
    if (item.kind === 'progress' && item.active !== false) {
      return {
        ...item,
        active: false,
        finishedAt: item.finishedAt ?? item.events.at(-1)?.ts
      }
    }
    if (item.kind === 'trace' && item.active) return { ...item, active: false }
    return item
  })
}

function renderTimelineItem(item: TimelineItem): RenderTimelineItem[] {
  if (item.kind === 'system' && (item.events ?? [item.event]).some(isAsyncCrossChatMessage)) {
    return renderCrossChatMessage(item)
  }
  if (item.kind === 'system' && item.event.type.startsWith('cross_chat_exchange_')) {
    const byLeg = new Map<string, Event[]>()
    for (const event of item.events ?? [item.event]) {
      const legId = event.exchange_leg_id?.trim() || event.cross_chat_exchange_leg_id?.trim()
      if (!legId || event.exchange_leg_kind === 'status') continue
      byLeg.set(legId, [...(byLeg.get(legId) ?? []), event])
    }
    if (byLeg.size) return [...byLeg].map(([legId, events]) => ({
      ...item, id: `${item.id}:message:${legId}`, key: `${item.key}:message:${legId}`,
      seq: events[0].seq, anchorTs: events[0].ts, crossChatLegId: legId
    }))
  }
  if (item.kind !== 'turn') return [item]
  const rows: RenderTimelineItem[] = []
  const inputFileIds = new Set(item.user?.file_ids ?? [])
  const inputFiles = item.files.filter(file => inputFileIds.has(file.id))
  const outputFiles = item.files.filter(file => !inputFileIds.has(file.id))
  if (item.user) {
    const importedDelivery = importedCrossChatDelivery(item.user)
    if (importedDelivery) {
      rows.push({
        kind: 'system',
        id: `imported-cross-chat-delivery:${item.user.id}`,
        key: `imported-cross-chat-delivery:${item.user.id}`,
        seq: item.user.seq,
        event: {
          ...item.user,
          type: 'cross_chat_imported_delivery',
          prompt: null,
          text: importedDelivery.body,
          source_title: importedDelivery.sender
        },
        importedDelivery
      })
      if (inputFiles.length) rows.push({
        kind: 'media', id: `${item.id}:delivery-files`, key: `${item.key}:delivery-files`,
        seq: item.user.seq, files: inputFiles
      })
    }
    else rows.push({
      kind: 'message', id: `${item.id}:user`, key: `${item.key}:user:${item.user.id}`,
      seq: item.user.seq, event: item.user, events: [item.user], role: 'user',
      files: inputFiles
    })
  }
  const finalAssistantEvents = item.assistant.filter(event => !isPublicCommentary(event))
  const sourceEvents = deduplicateEvents([
    ...item.trace,
    ...item.assistant.filter(isPublicCommentary)
  ])
  // An earlier answer is not evidence that later work is finished. Native
  // goals and reconstructed provider history can both continue in one run.
  // Sequence is arrival order. Explicitly phased commentary can be delivered
  // late; an earlier timestamp in this same run keeps it before its answer.
  const orderingFinalEvents = sourceEvents.some(event => activityEventSequence(event, finalAssistantEvents) < event.seq)
    ? finalAssistantEvents : undefined
  const continuations = runPresentationSegments(sourceEvents, finalAssistantEvents, orderingFinalEvents)
  for (const [index, segment] of continuations.entries()) {
    const last = index === continuations.length - 1
    const suffix = segment.after ? `:after:${segment.after.id}` : ''
    const active = last && !item.finishedAt && segment.finals.length === 0
    const activityEvents = omitTerminalClaudeFinalCommentary(segment.events, segment.finals)
    if ((last && item.stoppedAt) || traceHasVisibleContent(activityEvents)) {
      rows.push({
        kind: 'progress',
        id: `${item.id}:activity${suffix}`,
        key: `${item.key}:activity${suffix}`,
        seq: activityEvents[0] ? activityEventSequence(activityEvents[0], orderingFinalEvents) : item.user?.seq ?? item.seq,
        events: activityEvents,
        sourceEvents: segment.events,
        active,
        hasFinalResponse: segment.finals.length > 0,
        finalEvents: segment.finals,
        ...(orderingFinalEvents ? { orderingFinalEvents } : {}),
        afterSeq: segment.after?.seq ?? item.afterSeq,
        throughSeq: continuations[index + 1]?.after?.seq ?? item.throughSeq,
        startedAt: segment.after ? activityEvents[0]?.ts ?? segment.after.ts : item.startedAt,
        finishedAt: last ? item.finishedAt : segment.finals.at(-1)?.ts,
        stoppedAt: last ? item.stoppedAt : undefined,
        terminalSeq: last && item.finishedAt ? item.terminalSeq : undefined
      })
    }
    if (segment.finals.length) {
      const event = segment.finals[segment.finals.length - 1]
      rows.push({
        kind: 'message', id: `${item.id}:assistant${suffix}`, key: `${item.key}:assistant${suffix}`,
        seq: segment.finals[0].seq, event, events: segment.finals, role: 'assistant', files: item.files,
      })
    }
  }
  if (outputFiles.length) {
    // Media is displayed after the turn's content, even when its first file
    // was created earlier. An older anchor would pull intervening messages
    // below the final answer and media when chronological rows are inserted.
    const toolStartSequences = progressToolStartSequences(sourceEvents)
    const mediaSeq = rows.reduce((anchor, row) => {
      if (row.kind !== 'progress') return Math.max(anchor, row.seq)
      const progress = { ...row, toolStartSequences }
      return row.events.reduce((seq, event) => Math.max(seq, progressEventSequence(event, progress)), Math.max(anchor, row.seq))
    }, outputFiles[0].seq ?? item.seq)
    rows.push({ kind: 'media', id: `${item.id}:media`, key: `${item.key}:media`, seq: mediaSeq, files: outputFiles })
  }
  return rows
}

function renderCrossChatMessage(item: SystemItem): SystemItem[] {
  const events = (item.events ?? [item.event]).filter(isAsyncCrossChatMessage)
  let latest = events[events.length - 1]
  if (!latest) return []
  const incoming = latest.target_session_id === latest.session_id && latest.source_session_id !== latest.session_id
  const mailbox = events.some(isChatMailboxEvent)
  if (mailbox) {
    const priority = { unread: 1, read: 2, cancelled: 3, deleted: 4 }
    const terminal = events.reduce<Event | undefined>((current, event) => event.inbox_state
      && priority[event.inbox_state] > (current?.inbox_state ? priority[current.inbox_state] : 0) ? event : current, undefined)
    if (terminal?.inbox_state && latest.inbox_state !== terminal.inbox_state) latest = { ...latest, inbox_state: terminal.inbox_state }
  }
  if (mailbox && incoming && latest.inbox_state === 'deleted') return []
  // An incoming envelope owns only its ordinary queue row until provider
  // execution starts. Cancelling a pending message never creates a duplicate.
  const arrived = incoming ? events.find(event => (
    mailbox && (event.type === 'chat_conversation_message_received' || event.type === 'chat_conversation_message_mailbox_migrated')
    || event.type === 'chat_conversation_message_started' || event.type === 'chat_conversation_message_delivered'
  )) : events[0]
  return arrived ? [{
    ...item, seq: arrived.seq, anchorTs: mailbox ? latest.received_at || arrived.ts : arrived.ts,
    event: latest, events, crossChatMessage: true
  }] : []
}

/** Keep arrival order unless public commentary has an earlier, zoned timestamp in the same run. */
export function activityEventSequence(event: Event, finals: Event[] = []): number {
  if (!isPublicCommentary(event) || !event.run_id || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(event.ts)) return event.seq
  const timestamp = Date.parse(event.ts)
  if (!Number.isFinite(timestamp)) return event.seq
  for (const final of finals) {
    if (final.seq >= event.seq) break
    if (final.run_id !== event.run_id || (event.backend && final.backend && event.backend !== final.backend)
      || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(final.ts)) continue
    const finalTimestamp = Date.parse(final.ts)
    if (Number.isFinite(finalTimestamp) && timestamp < finalTimestamp) return final.seq
  }
  return event.seq
}

function runPresentationSegments(events: Event[], finals: Event[], orderingFinalEvents?: Event[]): { events: Event[]; finals: Event[]; after?: Event }[] {
  const orderedEvents = orderingFinalEvents
    ? [...events].sort((left, right) => activityEventSequence(left, orderingFinalEvents) - activityEventSequence(right, orderingFinalEvents) || left.seq - right.seq)
    : events
  const boundaries: Event[] = []
  let finalCursor = 0
  for (const event of orderedEvents) {
    // Post-answer diff/bookkeeping alone is not another working turn.
    if (event.type !== 'tool_started' && event.type !== 'tool_finished'
      && !(event.type === 'reasoning_summary' && messageText(event).trim())
      && !isPublicCommentary(event)) continue
    const seq = activityEventSequence(event, orderingFinalEvents)
    while (finalCursor < finals.length && finals[finalCursor].seq < seq) finalCursor++
    const previousFinal = finals[finalCursor - 1]
    if (previousFinal && boundaries.at(-1) !== previousFinal) boundaries.push(previousFinal)
  }
  if (!boundaries.length) return [{ events: orderedEvents, finals }]
  const segments: { events: Event[]; finals: Event[]; after?: Event }[] = [
    { events: [], finals: [] },
    ...boundaries.map(after => ({ events: [], finals: [], after }))
  ]
  let index = 0
  for (const event of orderedEvents) {
    const seq = activityEventSequence(event, orderingFinalEvents)
    while (index < boundaries.length && seq > boundaries[index].seq) index++
    segments[index].events.push(event)
  }
  index = 0
  for (const event of finals) {
    while (index < boundaries.length && event.seq > boundaries[index].seq) index++
    segments[index].finals.push(event)
  }
  return segments
}

export function traceHasVisibleContent(events: Event[]): boolean {
  return events.some(event => event.type === 'reasoning_summary' && Boolean(messageText(event).trim())) ||
    events.some(isPublicCommentary) ||
    events.some(event => event.type === 'tool_started' || event.type === 'tool_finished') ||
    events.some(event => event.type === 'code_diff' && Boolean(event.run_id)) ||
    Boolean(extractUnifiedDiff(events).trim())
}

export function reconcileRenderTimelineItems(previous: RenderTimelineItem[], next: RenderTimelineItem[]): RenderTimelineItem[] {
  if (!previous.length) return next
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  return next.map(item => {
    const before = previousByKey.get(item.key)
    if (!before || before.kind !== item.kind) return item
    if (before === item) return before
    if (before.kind === 'message' && item.kind === 'message' && before.event === item.event &&
      before.role === item.role && sameReferences(before.events, item.events) &&
      sameReferences(before.files, item.files)) return before
    if (before.kind === 'trace' && item.kind === 'trace' && before.active === item.active &&
      sameReferences(before.events, item.events) &&
      sameReferences(before.promotedCommentaryIds, item.promotedCommentaryIds)) return before
    if (before.kind === 'progress' && item.kind === 'progress' &&
      before.seq === item.seq && before.continues === item.continues &&
      sameToolStartSequences(before.toolStartSequences, item.toolStartSequences) &&
      before.active === item.active && before.startedAt === item.startedAt &&
      before.hasFinalResponse === item.hasFinalResponse &&
      before.afterSeq === item.afterSeq && before.throughSeq === item.throughSeq &&
      sameReferences(before.finalEvents ?? [], item.finalEvents ?? []) &&
      sameReferences(before.orderingFinalEvents ?? [], item.orderingFinalEvents ?? []) &&
      before.finishedAt === item.finishedAt && before.stoppedAt === item.stoppedAt &&
      before.terminalSeq === item.terminalSeq &&
      sameReferences(before.events, item.events) &&
      sameReferences(before.sourceEvents ?? [], item.sourceEvents ?? []) &&
      sameReferences(before.lifecycle ?? [], item.lifecycle ?? [])) return before
    if (before.kind === 'media' && item.kind === 'media' && before.seq === item.seq && sameReferences(before.files, item.files)) return before
    return item
  })
}

function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false
  if (a.kind === 'system' && b.kind === 'system') {
    return a.event === b.event && a.anchorTs === b.anchorTs &&
      sameReferences(a.events ?? [], b.events ?? [])
  }
  if (a.kind === 'job' && b.kind === 'job') {
    return a.title === b.title && a.latest === b.latest && a.eventCount === b.eventCount &&
      a.runCount === b.runCount && a.startSeq === b.startSeq && a.endSeq === b.endSeq &&
      sameReferences(a.events, b.events)
  }
  if (a.kind === 'turn' && b.kind === 'turn') {
    return a.user === b.user && a.startedAt === b.startedAt && a.finishedAt === b.finishedAt &&
      a.stoppedAt === b.stoppedAt && a.terminalSeq === b.terminalSeq &&
      a.afterSeq === b.afterSeq && a.throughSeq === b.throughSeq &&
      a.providerThreadId === b.providerThreadId &&
      a.purpose === b.purpose && sameReferences(a.assistant, b.assistant) &&
      sameReferences(a.trace, b.trace) &&
      sameReferences(a.promotedCommentaryIds, b.promotedCommentaryIds) &&
      sameReferences(a.files, b.files)
  }
  return false
}

function codexLifecycleEventPriority(event: Event): number {
  if (event.type === 'codex_compaction_completed') return 20
  if (event.type === 'codex_compaction_started') return 10
  return 0
}

export function isPublicCommentary(event: Event): boolean {
  return (event.type === 'reasoning_summary' || event.type === 'assistant_text')
    && event.phase === 'commentary'
    && Boolean(event.text?.trim())
}

const claudeTerminalBookkeepingTypes = new Set([
  'raw_event', 'process_started', 'provider_session', 'cwd_fallback',
  'history_imported', 'backend_changed', 'artifact_error', 'session_created',
  'idle_warning', 'code_diff'
])

/**
 * Claude streams every TextBlock before its authoritative ResultMessage. The
 * terminal TextBlock(s) can therefore be present both as commentary and as
 * the final answer. Remove only the shortest contiguous Claude commentary
 * suffix after the last tool whose normalized text exactly equals that final
 * result. Terminal bookkeeping is retained in place and ignored for matching.
 * This deliberately leaves earlier repetitions, nonmatching updates,
 * interrupted output, and Codex commentary untouched.
 */
export function omitTerminalClaudeFinalCommentary(events: Event[], finalEvents: Event[]): Event[] {
  const final = [...finalEvents].reverse().find(event =>
    event.type === 'turn_finished'
    && event.backend === 'claude'
    && Boolean(event.result_text?.trim())
  )
  const finalText = normalizeAssistantOutput(final?.result_text ?? '')
  if (!finalText || events.length === 0) return events

  let lastToolIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'tool_started' || events[index].type === 'tool_finished') {
      lastToolIndex = index
    }
  }

  let suffix = ''
  const matchedIndexes: number[] = []
  for (let index = events.length - 1; index > lastToolIndex; index -= 1) {
    const event = events[index]
    if (event.id === final?.id) continue
    if (claudeTerminalBookkeepingTypes.has(event.type)) continue
    if (
      !isPublicCommentary(event)
      || event.backend !== 'claude'
    ) return events
    const text = normalizeAssistantOutput(event.text ?? '')
    if (!text) return events
    matchedIndexes.push(index)
    suffix = suffix ? `${text} ${suffix}` : text
    if (suffix === finalText) {
      const matched = new Set(matchedIndexes)
      return events.filter((_candidate, candidateIndex) => !matched.has(candidateIndex))
    }
    if (!finalText.endsWith(suffix)) return events
  }
  return events
}

function sameReferences<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function containsInOrder(value: string, parts: string[]): boolean {
  let cursor = 0
  for (const part of parts) {
    const position = value.indexOf(part, cursor)
    if (position < 0) return false
    cursor = position + part.length
  }
  return true
}

function normalizeAssistantOutput(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function messageText(event: Event): string {
  const text = event.result_text || event.text || event.prompt || printableEventValue(event.message) || printableEventValue(event.error) || event.output || ''
  return !hasProviderUserProvenance(event)
    && (event.type === 'turn_started' || event.type === 'turn_queued' || event.type === 'turn_queue_run_now' || isNativeGoalSteerEvent(event))
    ? stripInjectedProviderAuthority(text)
    : text
}

const importedDeliveryCache = new WeakMap<Event, ImportedCrossChatDelivery | null>()
const importedDeliveryHashCache = new WeakMap<Event, string>()

function importedCrossChatBodyHash(event: Event, body: string): string {
  const cached = importedDeliveryHashCache.get(event)
  if (cached) return cached
  const hash = bytesToHex(sha256(utf8ToBytes(body)))
  importedDeliveryHashCache.set(event, hash)
  return hash
}
const deliveryReplyFooters = new Set([
  '',
  'reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.',
  'reply: optional one-time terminal reply route via the respond command in the provider-authority block, only if a result, acknowledgement, or clarification should reach the origin; never add --request-response.',
  'reply: exactly one terminal response remains; use the respond command in the provider-authority block without --request-response.',
  'reply: none (terminal status notice; do not respond to the exchange)',
  'reply: use Chats respond-current through the AgentsDock provider tool only if a reply or follow-up is needed.',
  'reply: exactly one terminal response remains; use Chats respond-current through the AgentsDock provider tool without --request-response.',
  'reply: optional one-time terminal reply via Chats respond-current through the AgentsDock provider tool, only if a result, acknowledgement, or clarification should reach the origin; never add --request-response.'
])

/** Recover presentation only, never routes/permissions, from complete imported envelopes. */
export function importedCrossChatDelivery(event: Event): ImportedCrossChatDelivery | null {
  if (importedDeliveryCache.has(event)) return importedDeliveryCache.get(event) ?? null
  const parsed = parseImportedCrossChatDelivery(event)
  importedDeliveryCache.set(event, parsed)
  return parsed
}

function parseImportedCrossChatDelivery(event: Event): ImportedCrossChatDelivery | null {
  if (hasProviderUserProvenance(event)) return null
  return importedCrossChatDeliveryCandidate(event)
}

function importedCrossChatDeliveryCandidate(event: Event): ImportedCrossChatDelivery | null {
  if (event.type !== 'turn_started' || event.imported !== true
    || !event.run_id?.startsWith('import_')
    || (event.backend !== 'codex' && event.backend !== 'claude')) return null
  return parseCrossChatDeliveryPrompt(event.prompt)
}

function codexProviderTurnKey(threadId: string | null | undefined, turnId: string | null | undefined): string | null {
  const thread = threadId?.trim() || ''
  const turn = turnId?.trim() || ''
  return thread && turn ? `${thread}\0${turn}` : null
}

function crossChatProviderSessionId(event: Event): string {
  return event.backend === 'codex'
    ? event.provider_thread_id?.trim() || event.provider_session_id?.trim() || ''
    : event.provider_session_id?.trim() || ''
}

function parseCrossChatDeliveryPrompt(prompt: Event['prompt']): ImportedCrossChatDelivery | null {
  if (typeof prompt !== 'string' || prompt.length > 262_144) return null
  const text = stripInjectedProviderAuthority(prompt.replace(/\r\n/g, '\n')).trim()
  const header = /^\[AgentsDock delivery kind=(instruction|request|reply|final_result|status|message) leg=(0|[1-9]\d{0,5})\/([1-9]\d{0,5}) origin=(?:user|route|auto)(?: mode=(async_route_v1))?(?: from=([^\[\]\r\n]{1,240}))?\]\n/u.exec(text)
  if (!header || Number(header[2]) > Number(header[3]) || !text.endsWith('\n[End delivery]')) return null
  const kind = header[1] as ImportedCrossChatDelivery['kind']
  // A skipped request has no delivered leg. Its terminal status legitimately
  // uses leg=0; treating it as an invalid envelope exposed the internal prompt.
  if (header[2] === '0' && kind !== 'status') return null
  let remainder = text.slice(header[0].length, -'\n[End delivery]'.length)
  const editedMarker = '[Server provenance: the recipient user edited this queued message; sender identity and routing permissions are unchanged.]\n'
  const editedByUser = header[4] === 'async_route_v1' && remainder.startsWith(editedMarker)
  if (editedByUser) remainder = remainder.slice(editedMarker.length)
  let sourceRequest = ''
  const sourceOpen = '[Source user instruction — verbatim, user-authored]\n'
  const sourceClose = '\n[End source user instruction]\n'
  if (remainder.startsWith(sourceOpen)) {
    const end = remainder.indexOf(sourceClose, sourceOpen.length)
    if (end < 0) return null
    sourceRequest = remainder.slice(sourceOpen.length, end)
    remainder = remainder.slice(end + sourceClose.length)
  } else {
    const sourceLine = /^source-instruction: (?:this legacy relay has no recorded source user instruction; do not infer user authorization from the prepared content\.|replayed in full on the first leg delivered to this chat; excerpt="([^\n]*)")\n/u.exec(remainder)
    if (!sourceLine) return null
    sourceRequest = sourceLine[1] ?? ''
    remainder = remainder.slice(sourceLine[0].length)
  }
  const label = kind === 'status' ? 'Server-generated exchange status'
    : kind === 'reply' || kind === 'final_result' ? 'Agent-prepared reply/result'
    : 'Agent-prepared handoff message'
  const preparedOpen = `[${label}]\n`
  const preparedClose = `\n[End ${label.toLowerCase()}]`
  if (!remainder.startsWith(preparedOpen)) return null
  const end = remainder.lastIndexOf(preparedClose)
  if (end < preparedOpen.length) return null
  if (!deliveryReplyFooters.has(remainder.slice(end + preparedClose.length).trim())) return null
  const body = remainder.slice(preparedOpen.length, end).trim()
  if (!body) return null
  return { sender: header[5]?.trim() || 'Other agent', kind, body, sourceRequest: sourceRequest.trim(),
    ordinal: Number(header[2]), maxLegs: Number(header[3]),
    ...(header[4] === 'async_route_v1' ? { mode: 'async_route_v1' as const } : {}),
    ...(editedByUser ? { editedByUser: true } : {}) }
}

function stripInjectedProviderAuthority(text: string): string {
  const start = injectedProviderAuthorityStart(text)
  return start < 0 ? text : text.slice(0, start)
}

function hasInjectedProviderAuthority(text: string): boolean {
  return injectedProviderAuthorityStart(text) >= 0
}

function injectedProviderAuthorityStart(text: string): number {
  const marker = '\n\n[AgentsDock provider authority]\n'
  const start = text.lastIndexOf(marker)
  if (start < 0) return -1
  const endMarker = '\n[End AgentsDock provider authority]'
  const end = text.indexOf(endMarker, start + marker.length)
  if (end < 0 || text.slice(end + endMarker.length).trim()) return -1
  const block = text.slice(start + marker.length, end)
  const compactGenerated = /(?:^|\n)authority-file=\/[^\n]*\/cross_chat_authority\/run_[0-9a-f-]+\.json(?:\s|$)/u.test(block)
    && /(?:^|\s)chat-id=sess_[0-9a-f]+(?:\s|$)/u.test(block)
    && /(?:^|\n)usage: see AgentsDock instructions(?:\n|$)/u.test(block)
  const verboseGenerated = block.includes('This authority file is bound to this server, chat, and live run.')
    && block.includes('Do not read, print, quote, or expose the authority file.')
  return compactGenerated || verboseGenerated ? start : -1
}

export interface JobResultPresentation {
  detail: string
  preview: string
  structured: boolean
}

const JOB_PREVIEW_CHARACTER_LIMIT = 240

/** Keep machine-readable job output readable without discarding its full detail. */
export function jobResultPresentation(event: Event): JobResultPresentation {
  const status = String(event.job_status || event.job_latest_status || event.job_run_status || '').toLowerCase()
  const deferred = event.type === 'job_deferred'
    || status === 'deferred'
    || event.job_status_type === 'job_deferred'
    || event.job_latest_status_type === 'job_deferred'
  const cancelled = event.type === 'turn_stopped'
    || event.stopped === true
    || ['stopped', 'cancelled', 'canceled'].includes(status)
  // A scheduled input is not a public result, including when only the start
  // or a status-only terminal is available on a bounded timeline page.
  const detail = messageText({ ...event, prompt: null }).trim() || (deferred
    ? 'Scheduled job deferred until this chat is available.'
    : cancelled
      ? 'Scheduled job was cancelled.'
      : 'Scheduled job started. Waiting for agent output.')
  const structured = parseStructuredResult(detail)
  if (structured != null) {
    return {
      detail: JSON.stringify(structured, null, 2),
      preview: structuredJobPreview(structured),
      structured: true
    }
  }
  return {
    detail,
    preview: truncateJobPreview(detail.replace(/\s+/g, ' ').trim()),
    structured: false
  }
}

export function eventErrorText(event: Event): string {
  return printableEventValue(event.error) || printableEventValue(event.message) || event.output || event.text || ''
}

export function messageItemText(item: MessageItem): string {
  return item.events.map(messageText).map(value => value.trim()).filter(Boolean).join('\n\n')
}

export function jobDisplayEvents(events: Event[]): Event[] {
  const standalone: Event[] = []
  const byRun = new Map<string, Event>()
  for (const event of events) {
    const runId = String(event.run_id || '').trim()
    if (!runId) {
      if (jobTypes.has(event.type)) standalone.push(event)
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

export function jobDisplaySelection(item: JobItem): {
  latest: Event
  latestSource: Event
  previous: Event[]
  updates: Event[]
} {
  const updates = item.displayUpdates ?? jobDisplayEvents(item.events)
  const newestUpdate = updates.at(-1)
  const summary = [...item.events].reverse().find(event =>
    event.type === 'job_summary' && Boolean(messageText(event).trim())
  )
  const useSummary = Boolean(summary && (
    !newestUpdate || jobEventSnapshotSeq(summary) >= newestUpdate.seq
  ))
  if (!useSummary || !summary) {
    return {
      latest: newestUpdate ?? item.latest,
      latestSource: newestUpdate ?? item.latest,
      previous: updates.slice(0, -1),
      updates
    }
  }

  // Semantic summaries intentionally retain the last useful run output while
  // a newer run is active. A runless deferral is different: rendering that
  // retained result as the current body produces a misleading "Deferred"
  // card filled with stale output. Prefer the actual deferral when it is
  // bundled, or strip retained output from the summary when it is not.
  const summaryStatus = String(summary.job_status || summary.job_latest_status || '').toLowerCase()
  if (summaryStatus === 'deferred' || summary.job_status_type === 'job_deferred' || summary.job_latest_status_type === 'job_deferred') {
    const deferred = [...updates].reverse().find(event => event.type === 'job_deferred')
    if (deferred) {
      return {
        latest: deferred,
        latestSource: deferred,
        previous: updates.filter(event => event.id !== deferred.id),
        updates
      }
    }
    return {
      latest: { ...summary, result_text: null, text: null, output: null },
      latestSource: summary,
      previous: updates,
      updates
    }
  }

  // The semantic summary can retain the latest completed result even when
  // bounded detail contains only a newer marker/stopped run. Remove the
  // matching representative from history so that result is not shown twice.
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
    updates
  }
}

function jobDisplayPriority(event: Event): number {
  if (isTimelineError(event) || event.type === 'turn_stopped' || event.type === 'job_error') return 5
  if (event.type === 'job_deferred') return 5
  if (event.type === 'turn_finished' && messageText(event).trim()) return 4
  if (event.type === 'assistant_text' && messageText(event).trim()) return 3
  if (event.type === 'job_finished') return 3
  if (event.type === 'job_ran' || event.type === 'job_started') return 2
  if (event.type === 'turn_started') return 1
  return 0
}

function jobStatusEvent(event: Event): boolean {
  if (
    (typeof event.job_status === 'string' && event.job_status.trim())
    || (typeof event.job_latest_status === 'string' && event.job_latest_status.trim())
    || (typeof event.job_run_status === 'string' && event.job_run_status.trim())
  ) return true
  if (isTimelineError(event)) return true
  return jobStatusTypes.has(event.type)
}

function jobStatusShouldReplace(current: Event | undefined, event: Event): boolean {
  if (!current) return true
  if (jobStatusSnapshotSeq(event) < jobStatusSnapshotSeq(current)) return false
  const currentRunId = String(
    current.job_status_run_id
    || current.job_latest_status_run_id
    || current.run_id
    || ''
  ).trim()
  const runId = String(event.run_id || '').trim()
  if (
    event.type === 'job_ran'
    && currentRunId
    && currentRunId === runId
    && terminalJobStatusEvent(current)
  ) return false
  return true
}

function jobEventSnapshotSeq(event: Event): number {
  return Math.max(
    event.seq,
    positiveEventCount(event.job_end_seq),
    jobStatusSnapshotSeq(event)
  )
}

function jobStatusSnapshotSeq(event: Event): number {
  return Math.max(
    event.seq,
    positiveEventCount(event.job_status_seq),
    positiveEventCount(event.job_latest_status_seq),
    positiveEventCount(event.job_run_status_seq)
  )
}

function terminalJobStatusEvent(event: Event): boolean {
  if (isTimelineError(event) || event.type === 'job_error' || event.stopped === true) return true
  if (['turn_finished', 'turn_stopped', 'job_finished'].includes(event.type)) return true
  const status = String(
    event.job_status
    || event.job_latest_status
    || event.job_run_status
    || ''
  ).trim().toLowerCase()
  return ['completed', 'complete', 'succeeded', 'success', 'done', 'failed', 'error', 'stopped', 'cancelled', 'canceled'].includes(status)
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
    ['message', 'Message']
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

export function eventFile(event: Event): AgentFile | null {
  return eventFileForSession(event)
}

export function isAgentVisibleEvent(event: Event): boolean {
  if (isImportedProviderControlMetadata(event)) return false
  return event.type === 'assistant_text' ||
    (event.type === 'turn_finished' && Boolean(event.result_text?.trim())) ||
    event.type === 'artifact_created' || event.type === 'file_uploaded' || event.type === 'emergency_alert_raised' ||
    isTimelineError(event) || event.type.startsWith('handoff_digest_') ||
    event.type === 'job_summary' || jobTypes.has(event.type)
}

export function isTimelineError(event: Event): boolean {
  if (isImportedProviderControlMetadata(event)) return false
  // Tool failures stay inside the folded trace; run/provider/artifact failures
  // need a first-class red row so the user cannot miss a failed turn.
  if (event.type === 'tool_started' || event.type === 'tool_finished' || event.type === 'raw_event') return false
  if (isInternalProviderDiagnostic(event)) return false
  return event.type === 'error' || event.type.endsWith('_error') || event.is_error === true || Boolean(printableEventValue(event.error))
}

function isInternalProviderDiagnostic(event: Event): boolean {
  const message = normalizeAssistantOutput(eventErrorText(event))
  return message === 'Claude stopped before completing the turn.' ||
    /^\[ede_diagnostic\](?:\s|$)[^\r\n]*$/.test(message)
}

const CLAUDE_BACKGROUND_TASK_SUMMARY_MAX_CHARS = 640

/**
 * Claude writes background-task completion notices into its transcript as
 * synthetic `user` records. Older AgentsServer builds imported those records
 * as ordinary `turn_started` events, which made provider control markup look
 * like a message authored by the user. Recognize only the exact imported
 * envelope so a user-authored lookalike in a real turn remains untouched.
 */
function importedClaudeBackgroundTask(event: Event): string {
  if (
    event.type !== 'turn_started'
    || event.backend !== 'claude'
    || event.imported !== true
    || hasProviderUserProvenance(event)
  ) return ''
  const prompt = event.prompt?.trim() || ''
  const outerStart = '<task-notification>'
  const outerEnd = '</task-notification>'
  if (!prompt.startsWith(outerStart) || !prompt.endsWith(outerEnd)) return ''
  const body = prompt.slice(outerStart.length, -outerEnd.length).trim()
  const taskId = exactControlTag(body, 'task-id', 240)
  const toolUseId = exactControlTag(body, 'tool-use-id', 240)
  const status = exactControlTag(body, 'status', 32).toLowerCase()
  if (!taskId || !toolUseId || !['completed', 'failed', 'stopped', 'cancelled', 'canceled'].includes(status)) return ''
  const summary = exactControlTag(body, 'summary', CLAUDE_BACKGROUND_TASK_SUMMARY_MAX_CHARS + 1).replace(/\s+/g, ' ').trim()
  const statusLabel = status === 'canceled' ? 'cancelled' : status
  const prefix = `Background task ${statusLabel}.`
  if (!summary) return prefix
  const available = Math.max(0, CLAUDE_BACKGROUND_TASK_SUMMARY_MAX_CHARS - prefix.length - 1)
  const compact = summary.length > available
    ? `${summary.slice(0, Math.max(0, available - 1)).trimEnd()}…`
    : summary
  return `${prefix} ${compact}`
}

function exactControlTag(value: string, tag: string, limit: number): string {
  const startMarker = `<${tag}>`
  const endMarker = `</${tag}>`
  const start = value.indexOf(startMarker)
  if (start < 0) return ''
  const contentStart = start + startMarker.length
  const end = value.indexOf(endMarker, contentStart)
  if (end < contentStart || value.indexOf(startMarker, contentStart) >= 0) return ''
  return value.slice(contentStart, Math.min(end, contentStart + limit)).trim()
}

function printableEventValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const nested = printableEventValue(JSON.parse(trimmed))
        if (nested) return nested
      } catch { /* plain text that happens to begin with JSON punctuation */ }
    }
    return value
  }
  if (value == null) return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('message' in value && typeof value.message === 'string') return value.message
    if ('error' in value) {
      const nested = printableEventValue(value.error)
      if (nested) return nested
    }
  }
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

export function extractUnifiedDiff(events: Event[]): string {
  const structured = extractStructuredToolDiff(events)
  const candidates = events.flatMap(event => [event.output, event.text, event.message, ...toolInputTexts(event)]).filter((value): value is string => Boolean(value))
  return [...new Set([structured, ...candidates.filter(hasTimelineChangeSignal)].filter(Boolean))].join('\n\n---\n\n')
}

interface StructuredToolChange {
  path: string
  operation: 'Add' | 'Update' | 'Delete'
  diffs: string[]
  additions: number
  deletions: number
}

export interface StructuredToolDiffSummary {
  files: CodeDiffFileSummary[]
  filesChanged: number
  additions: number
  deletions: number
}

/**
 * Recover the provider-authored file hunks carried by Codex app-server's
 * fileChange items. The canonical server snapshot remains preferred, but this
 * strict fallback also works when an agent edits a linked worktree outside the
 * chat cwd and the single-root snapshot cannot be materialized.
 */
export function extractStructuredToolDiff(events: Event[]): string {
  return [...structuredToolChanges(events).values()].map(change => [
    `*** ${change.operation} File: ${change.path}`,
    ...change.diffs
  ].join('\n')).join('\n\n')
}

export function summarizeStructuredToolDiff(events: Event[]): StructuredToolDiffSummary | null {
  const changes = [...structuredToolChanges(events).values()]
  if (!changes.length) return null
  const files = changes.map(change => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    binary: false
  }))
  return {
    files,
    filesChanged: files.length,
    additions: changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: changes.reduce((sum, change) => sum + change.deletions, 0)
  }
}

function structuredToolChanges(events: Event[]): Map<string, StructuredToolChange> {
  const changesByPath = new Map<string, StructuredToolChange>()
  const seenChanges = new Set<string>()
  for (const event of events) {
    const tool = event.tool
    if (!tool || !isApplyPatchTool(tool.name) || !tool.input || Array.isArray(tool.input) || typeof tool.input !== 'object') continue
    const changes = tool.input.changes
    if (!Array.isArray(changes)) continue
    const toolId = String(tool.id || event.tool_id || '')
    for (const candidate of changes) {
      if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') continue
      const rawPath = typeof candidate.path === 'string' ? candidate.path : candidate.filePath
      const path = typeof rawPath === 'string' ? rawPath.trim() : ''
      const diff = typeof candidate.diff === 'string' ? candidate.diff.trim() : ''
      if (!path || !diff || /[\r\n\0]/.test(path)) continue
      const operation = structuredChangeOperation(candidate.kind)
      const identity = `${toolId || event.id}\0${path}\0${operation}\0${diff}`
      if (seenChanges.has(identity)) continue
      seenChanges.add(identity)
      let additions = 0
      let deletions = 0
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++
      }
      const existing = changesByPath.get(path)
      if (existing) {
        existing.diffs.push(diff)
        existing.additions += additions
        existing.deletions += deletions
        if (operation === 'Delete') existing.operation = 'Delete'
        else if (operation === 'Add' && existing.operation === 'Delete') existing.operation = 'Update'
      } else {
        changesByPath.set(path, { path, operation, diffs: [diff], additions, deletions })
      }
    }
  }
  return changesByPath
}

function isApplyPatchTool(name: string): boolean {
  const leaf = name.trim().toLowerCase().replace(/-/g, '_').split(/[/.]/).at(-1)
  return leaf === 'apply_patch' || leaf === 'applypatch' || leaf === 'patch'
}

function structuredChangeOperation(value: unknown): 'Add' | 'Update' | 'Delete' {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string'
      ? String((value as { type: string }).type)
      : ''
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'add' || normalized === 'create') return 'Add'
  if (normalized === 'delete' || normalized === 'remove') return 'Delete'
  return 'Update'
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  conflictCount: number
  isCombinedDiff: boolean
  lines: DiffLine[]
}

export type DiffConflictSide = 'ours' | 'base' | 'theirs'
export type DiffConflictMarker = 'start' | 'base' | 'separator' | 'end'

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
  oldStart?: number
  oldCount?: number
  newStart?: number
  newCount?: number
  conflictBlock?: number
  conflictSide?: DiffConflictSide
  conflictMarker?: DiffConflictMarker
  conflictLabel?: string
}

export interface CodeReviewTarget {
  sessionId: string
  runId?: string | null
  source?: string | null
  files?: CodeDiffFileSummary[] | null
  additions?: number | null
  deletions?: number | null
  repositoryRoot?: string | null
}

export function reviewTargetBelongsToSession(target: CodeReviewTarget | null, sessionId: string | null): boolean {
  return Boolean(target && sessionId && target.sessionId === sessionId)
}

export function sameCodeReviewTarget(left: CodeReviewTarget | null, right: CodeReviewTarget | null): boolean {
  if (!left || !right || left.sessionId !== right.sessionId) return false
  if (left.runId || right.runId) return Boolean(left.runId && right.runId && left.runId === right.runId)
  return Boolean(left.source && right.source && left.source === right.source)
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  if (!source.trim()) return []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of source.split('\n')) {
    const patchFile = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/i)
    if (patchFile) {
      current = { path: cleanDiffPath(patchFile[2]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] }
      files.push(current); oldLine = 1; newLine = 1; inHunk = false; continue
    }
    const combinedFile = line.match(/^diff --(?:cc|combined)\s+(.+)$/)
    if (combinedFile) {
      current = { path: cleanDiffPath(combinedFile[1]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: true, lines: [{ kind: 'header', text: line }] }
      files.push(current); inHunk = false; continue
    }
    if (line.startsWith('diff --git ')) {
      const match = line.match(/\s"?b\/(.+?)"?$/)
      current = { path: cleanDiffPath(match?.[1] ?? 'Changes'), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] }
      files.push(current); inHunk = false; continue
    }
    if (!current) {
      if (line.startsWith('--- ')) { current = { path: cleanDiffPath(line.slice(4)), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [] }; files.push(current) }
      else {
        const status = line.match(/^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+(.+)$/)
        if (status) files.push({ path: cleanDiffPath(status[1]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] })
        continue
      }
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); inHunk = true
      current.lines.push({
        kind: 'hunk', text: line,
        oldStart: oldLine, oldCount: Number(hunk[2] ?? 1),
        newStart: newLine, newCount: Number(hunk[4] ?? 1)
      })
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) {
      current.lines.push({ kind: 'header', text: line })
      if (line.startsWith('+++ ') && current.path === '/dev/null') current.path = cleanDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++; current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ }); continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++; current.lines.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++ }); continue
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue
    }
    current.lines.push({ kind: 'header', text: line })
  }
  files.forEach(annotateDiffConflicts)
  return files
}

interface DiffConflictBoundary {
  marker: DiffConflictMarker
  width: number
  label?: string
}

function diffConflictBoundary(text: string): DiffConflictBoundary | null {
  const normalized = text.endsWith('\r') ? text.slice(0, -1) : text
  const start = normalized.match(/^(<{7,})(?:[\t ]+(.+))?$/)
  if (start) return { marker: 'start', width: start[1].length, label: start[2]?.trim() || undefined }
  const base = normalized.match(/^(\|{7,})(?:[\t ]+(.+))?$/)
  if (base) return { marker: 'base', width: base[1].length, label: base[2]?.trim() || undefined }
  const separator = normalized.match(/^(={7,})[\t ]*$/)
  if (separator) return { marker: 'separator', width: separator[1].length }
  const end = normalized.match(/^(>{7,})(?:[\t ]+(.+))?$/)
  if (end) return { marker: 'end', width: end[1].length, label: end[2]?.trim() || undefined }
  return null
}

function annotateDiffConflicts(file: DiffFile): void {
  if (file.isCombinedDiff) return
  type PendingConflictLine = {
    line: DiffLine
    side: DiffConflictSide
    boundary: DiffConflictBoundary | null
  }
  let candidate: {
    width: number
    side: DiffConflictSide
    phase: 'ours' | 'base' | 'theirs'
    lines: PendingConflictLine[]
  } | null = null
  for (const line of file.lines) {
    // Only rows present in the resulting file participate. Removed old-side
    // markers and metadata cannot create, advance, or receive conflict UI.
    if (line.kind !== 'add' && line.kind !== 'context') continue
    const boundary = diffConflictBoundary(line.text)
    if (!candidate) {
      if (boundary?.marker === 'start') {
        candidate = { width: boundary.width, side: 'ours', phase: 'ours', lines: [{ line, side: 'ours', boundary }] }
      }
      continue
    }

    let validBoundary = true
    if (boundary) {
      validBoundary = boundary.width === candidate.width
      if (validBoundary && boundary.marker === 'base') {
        validBoundary = candidate.phase === 'ours'
        if (validBoundary) candidate.phase = candidate.side = 'base'
      } else if (validBoundary && boundary.marker === 'separator') {
        validBoundary = candidate.phase === 'ours' || candidate.phase === 'base'
        if (validBoundary) candidate.phase = candidate.side = 'theirs'
      } else if (validBoundary && boundary.marker === 'end') {
        validBoundary = candidate.phase === 'theirs'
      } else if (boundary.marker === 'start') {
        validBoundary = false
      }
    }
    if (!validBoundary) {
      candidate = null
      continue
    }

    candidate.lines.push({ line, side: candidate.side, boundary })
    if (boundary?.marker !== 'end') continue

    const block = file.conflictCount + 1
    for (const pending of candidate.lines) {
      pending.line.conflictBlock = block
      pending.line.conflictSide = pending.side
      if (pending.boundary) {
        pending.line.conflictMarker = pending.boundary.marker
        pending.line.conflictLabel = pending.boundary.label
      }
    }
    file.conflictCount = block
    candidate = null
  }
}

export function parseReviewableDiff(source: string): DiffFile[] {
  return parseUnifiedDiff(source).filter(file => file.lines.some(line =>
    line.kind === 'hunk' || line.kind === 'add' || line.kind === 'remove' ||
    (line.kind === 'header' && (/^diff --git /.test(line.text) || /^\*\*\* (?:Update|Add|Delete) File:/.test(line.text) || /^Binary files /.test(line.text) || /^(?:old|new) mode \d+/.test(line.text)))
  ))
}

function toolInputTexts(event: Event): string[] {
  const input = event.tool?.input
  if (!input) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string')
  if (typeof input === 'object') return Object.values(input).filter((item): item is string => typeof item === 'string')
  return []
}

function cleanDiffPath(value: string): string { return value.trim().replace(/^[ab]\//, '').replace(/^["'`]|["'`]$/g, '') }
