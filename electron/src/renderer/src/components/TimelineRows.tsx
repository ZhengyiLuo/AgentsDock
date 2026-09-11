import { getLocale, t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { timelineCount, timelineEventLabel, timelineStatusLabel } from '../lib/timeline-labels'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronRight, Clock3, Code2, Copy, FileText, History, LoaderCircle, MessageSquareShare, Pin, Siren, Sparkles, TerminalSquare, Wrench } from 'lucide-react'
import { compactToolOutputPreview } from '@shared/event-compaction'
import { agentFileBelongsToSession } from '@shared/session-files'
import { isImportedProviderInterruption } from '@shared/provider-origin'
import { codexLifecycleSemanticKey } from '@shared/semantic-timeline'
import type { ChatReference, CrossChatExchange, Event, PinnedItem, QueuedTurn, WorkspaceProfileScope } from '@shared/types'
import type { CodeReviewTarget, JobItem, MediaItem, MessageItem, ProgressItem, RenderTimelineItem, SystemItem } from '../lib/timeline'
import { activityEventSequence, extractUnifiedDiff, isHandoffDigestEvent, isPublicCommentary, isTimelineError, jobDisplaySelection, jobResultPresentation, messageItemText, messageText, omitTerminalClaudeFinalCommentary, parseReviewableDiff, summarizeStructuredToolDiff } from '../lib/timeline'
import { activeEmergencyAlert } from '../lib/emergency-alert'
import { formatDuration, formatTime, titleCase } from '../lib/format'
import { requirePinnedItemsScope } from '../lib/pinned-items'
import { exactQueuedDeliverySkipAvailable } from '../lib/chat-references'
import { useAppStore } from '../store/app-store'
import { MarkdownContent } from './MarkdownContent'
import { MediaGrid } from './MediaGrid'

export const TimelineRowView = memo(function TimelineRowView({ item, sessionId, profileScope, onFindFile, pinnedItemIds, codexLifecycleActive = false }: { item: RenderTimelineItem; sessionId: string; profileScope: WorkspaceProfileScope | null; onFindFile: (fileId: string) => void; pinnedItemIds: ReadonlySet<string>; codexLifecycleActive?: boolean }) {
  useLocale()
  if (item.kind === 'message') {
    const pinned = pinnedItemIds.has(`message:${item.events[0]?.id ?? item.event.id}`)
    return <div className={`turn-segment ${item.role}`}><Message item={item} sessionId={sessionId} profileScope={profileScope} pinned={pinned} /></div>
  }
  if (item.kind === 'progress') return <div className="turn-segment activity-segment"><RunActivity item={item} sessionId={sessionId} profileScope={profileScope} /></div>
  if (item.kind === 'trace') return <div className="turn-segment trace-segment"><TraceDisclosure events={item.events} sessionId={sessionId} promotedCommentaryIds={item.promotedCommentaryIds} includeCommentary={!item.active} /></div>
  if (item.kind === 'media') return <MediaRow item={item} sessionId={sessionId} profileScope={profileScope} onFindFile={onFindFile} pinnedItemIds={pinnedItemIds} />
  if (item.kind === 'job') return <JobView item={item} sessionId={sessionId} profileScope={profileScope} pinnedItemIds={pinnedItemIds} />
  return <SystemView item={item} sessionId={sessionId} profileScope={profileScope} pinned={pinnedItemIds.has(`message:${item.event.id}`)} codexLifecycleActive={codexLifecycleActive} />
})

function MediaRow({ item, sessionId, profileScope, onFindFile, pinnedItemIds }: { item: MediaItem; sessionId: string; profileScope: WorkspaceProfileScope | null; onFindFile: (fileId: string) => void; pinnedItemIds: ReadonlySet<string> }) {
  useLocale()
  return <div className="turn-segment media-segment"><MediaGrid files={item.files} sessionId={sessionId} profileScope={profileScope} onFind={file => onFindFile(file.id)} pinnedItemIds={pinnedItemIds} /></div>
}

function Message({ item, sessionId, profileScope, pinned }: { item: MessageItem; sessionId: string; profileScope: WorkspaceProfileScope | null; pinned: boolean }) {
  useLocale()
  const role = item.role
  const events = item.events
  const event = item.event
  const files = item.files
  // Current @Chat routes render inline in their exact authored positions.
  // Only historical action-specific records keep the separate read-only card.
  const chatReferences = role === 'user'
    ? [...new Map(item.events.flatMap(part => part.chat_references ?? []).map(reference => [
        `${reference.session_id}:${reference.source_text_start}:${reference.action}`,
        reference
      ])).values()].filter(reference => (
        reference.action !== 'route'
        && !(reference.target_kind === 'secure_peer' && reference.action === 'instruction')
      ))
    : []
  const primary = events[0] ?? event
  const text = messageItemText(item)
  const [copied, setCopied] = useState(false)
  const pinId = `message:${primary.id}`
  const togglePin = async () => {
    if (pinned) {
      await window.agentsDock.pins.remove(requirePinnedItemsScope(profileScope), sessionId, pinId)
      window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
      return
    }
    const pinItem: PinnedItem = {
      id: pinId, sessionId, kind: 'message', eventId: primary.id,
      title: role === 'user' ? 'You' : 'Assistant', body: text, subtitle: formatTime(event.ts), createdAt: Date.now()
    }
    await window.agentsDock.pins.put(requirePinnedItemsScope(profileScope), pinItem)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  const copy = async () => { await window.agentsDock.native.writeClipboard(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
  return (
    <div
      className={`message-row ${role}`}
      data-event-id={primary.id}
      data-event-count={item.events.length}
    >
      <div className="message-surface">
        <header>
          <span>{role === 'user' ? t('timeline.ui.you') : primary.purpose === 'handoff_digest' ? t('timeline.ui.digest') : t('timeline.ui.assistant')}</span>
          <time>{formatTime(event.ts)}</time>
          <button type="button" className={`pin-button ${pinned ? 'active' : ''}`} aria-pressed={pinned} title={pinned ? t('timeline.ui.unpinMessage') : t('timeline.ui.pinMessage')} onClick={() => runTimelineAction(togglePin())}><Pin size={12} fill={pinned ? 'currentColor' : 'none'} /></button>
          <button type="button" title={t('timeline.ui.copyFullMessage')} onClick={() => runTimelineAction(copy())}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
        </header>
        <div className="message-parts">
          {events.map(part => <MarkdownContent
            key={part.id}
            text={messageText(part)}
            files={files}
            sessionId={sessionId}
            inlineChatReferences={role === 'user' ? inlineTimelineChatReferences(part) : []}
            inlineTeamReferences={role === 'user' ? part.team_references ?? [] : []}
            onChatReferenceClick={selectTimelineChatReference}
          />)}
        </div>
        {chatReferences.length > 0 && <div className="sent-chat-references" aria-label={t('timeline.ui.referencedChats')}>
          {chatReferences.map(reference => {
            const remote = reference.target_kind === 'secure_peer'
            const referenceLabel = (key: string, english: string) => remote ? english : t(key)
            return <button
              type="button"
              key={`${reference.session_id}:${reference.source_text_start}:${reference.action}`}
              disabled={remote}
              title={remote ? 'Remote route on a secure paired server' : undefined}
              onClick={remote ? undefined : () => runTimelineAction(useAppStore.getState().selectSession(reference.session_id))}
            ><MessageSquareShare size={12} /><span>{reference.action === 'direct_message'
              ? referenceLabel('timeline.ui.legacyChatReferenceTo', 'Legacy chat reference to')
              : reference.action === 'request_reply'
                  ? referenceLabel('timeline.ui.replyExpectedFrom', 'Reply expected from')
                  : reference.action === 'final_result'
                    ? referenceLabel('timeline.ui.finalResultTo', 'Final result to')
                    : referenceLabel('timeline.ui.agentMaySendTo', 'Agent may send to')} <strong>{reference.display_title_snapshot}</strong>{remote ? ' · secure paired server' : ''}</span></button>
          })}
        </div>}
        {role === 'user' && files.length > 0 && <div className="message-attachments"><MediaGrid files={files} sessionId={sessionId} profileScope={profileScope} compact /></div>}
      </div>
    </div>
  )
}

function inlineTimelineChatReferences(event: Event): ChatReference[] {
  return (event.chat_references ?? []).filter(reference => (
    reference.action === 'route'
    || (reference.target_kind === 'secure_peer' && reference.action === 'instruction')
  ))
}

function selectTimelineChatReference(reference: ChatReference): void {
  if (reference.target_kind === 'secure_peer') return
  runTimelineAction(useAppStore.getState().selectSession(reference.session_id))
}


function LiveCodexLifecycleMarker({ item }: { item: SystemItem }) {
  useLocale()
  const event = item.event
  const failed = codexLifecycleFailed(event)
  const compacting = event.type === 'codex_compaction_started'
  const icon = failed
    ? <AlertTriangle size={12} />
    : compacting
      ? <LoaderCircle className="spin" size={12} />
      : <Sparkles size={12} />
  return <div className={`message-live-lifecycle${failed ? ' error' : ''}`} data-event-id={event.id}>
    <span className="system-icon">{icon}</span>
    <strong>{codexLifecycleTitle(event, compacting)}</strong>
    <time>{formatTime(item.anchorTs || event.ts)}</time>
  </div>
}

function LiveLifecycleMarker({ item, sessionId, profileScope }: { item: SystemItem; sessionId: string; profileScope: WorkspaceProfileScope | null }) {
  useLocale()
  if (codexLifecycleSemanticKey(item.event)) return <LiveCodexLifecycleMarker item={item} />
  return <div className="message-live-system">
    <SystemView item={item} sessionId={sessionId} profileScope={profileScope} pinned={false} codexLifecycleActive={false} />
  </div>
}

function runTimelineAction(operation: Promise<unknown>): void {
  void operation.catch(error => {
    useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
  })
}

function timelineActionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function mergeTraceEvents(first: Event[], second: Event[]): Event[] {
  return [...new Map([...first, ...second].map(event => [event.id, event])).values()]
    .sort((left, right) => left.seq - right.seq)
}

interface TraceReasoningEntry {
  kind: 'reasoning'
  key: string
  seq: number
  events: Event[]
}

interface TraceToolEntry {
  kind: 'tool'
  key: string
  seq: number
  started?: Event
  finished?: Event
}

interface TraceCommentaryEntry {
  kind: 'commentary'
  key: string
  seq: number
  event: Event
}

type TraceActivityEntry = TraceReasoningEntry | TraceToolEntry | TraceCommentaryEntry

interface TraceActivityPart {
  kind: 'activity'
  seq: number
  entry: TraceActivityEntry
}

interface TraceLifecyclePart {
  kind: 'lifecycle'
  seq: number
  system: SystemItem
}

type TracePart = TraceActivityPart | TraceLifecyclePart

interface RunCommentarySegment {
  kind: 'commentary'
  key: string
  seq: number
  entry: TraceCommentaryEntry
}

interface RunSupportSegment {
  kind: 'support'
  key: string
  seq: number
  parts: TracePart[]
}

type RunActivitySegment = RunCommentarySegment | RunSupportSegment

const TRACE_REASONING_PREVIEW_CHARS = 600
const TRACE_REASONING_ACCESSIBLE_CHARS = 220
const TRACE_HEADER_PREVIEW_CHARS = 320

function traceReasoningText(event: Event): string {
  return messageText(event).trim()
}

function traceToolIdentity(event: Event): string {
  const toolId = event.tool_id?.trim() || event.tool?.id?.trim() || ''
  return toolId ? `${event.run_id?.trim() || 'runless'}:${toolId}` : ''
}

function adjacentLegacyToolsMatch(started: Event, finished: Event): boolean {
  const startedName = started.tool?.name?.trim() || ''
  const finishedName = finished.tool?.name?.trim() || ''
  return Boolean(startedName)
    && startedName === finishedName
    && (started.run_id?.trim() || '') === (finished.run_id?.trim() || '')
}

function buildTraceActivity(events: Event[]): TraceActivityEntry[] {
  const entries: TraceActivityEntry[] = []
  const toolsByIdentity = new Map<string, number>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'reasoning_summary' || isPublicCommentary(event)) {
      if (!traceReasoningText(event)) continue
      if (isPublicCommentary(event)) {
        entries.push({ kind: 'commentary', key: event.id, seq: event.seq, event })
        continue
      }
      const previous = entries.at(-1)
      if (previous?.kind === 'reasoning') {
        previous.events.push(event)
      } else {
        entries.push({ kind: 'reasoning', key: event.id, seq: event.seq, events: [event] })
      }
      continue
    }
    if (event.type !== 'tool_started' && event.type !== 'tool_finished') continue
    const identity = traceToolIdentity(event)
    const existingIndex = identity ? toolsByIdentity.get(identity) : undefined
    if (existingIndex != null) {
      const existing = entries[existingIndex]
      if (existing.kind === 'tool') {
        if (event.type === 'tool_started' && !existing.started) existing.started = event
        if (event.type === 'tool_finished') existing.finished = event
      }
      continue
    }
    if (!identity && event.type === 'tool_finished') {
      const previous = entries.at(-1)
      if (
        previous?.kind === 'tool'
        && previous.started
        && !previous.finished
        && !traceToolIdentity(previous.started)
        && adjacentLegacyToolsMatch(previous.started, event)
      ) {
        previous.finished = event
        continue
      }
    }
    const entry: TraceToolEntry = {
      kind: 'tool',
      key: identity ? `tool:${identity}` : `tool-event:${event.id}`,
      seq: event.seq,
      ...(event.type === 'tool_started' ? { started: event } : { finished: event })
    }
    entries.push(entry)
    if (identity) toolsByIdentity.set(identity, entries.length - 1)
  }
  return entries
}

function groupRunActivity(parts: TracePart[]): RunActivitySegment[] {
  const segments: RunActivitySegment[] = []
  let support: RunSupportSegment | null = null
  for (const part of parts) {
    if (part.kind === 'activity' && part.entry.kind === 'commentary') {
      support = null
      segments.push({
        kind: 'commentary',
        key: `commentary:${part.entry.key}`,
        seq: part.seq,
        entry: part.entry
      })
      continue
    }
    if (!support) {
      const partKey = part.kind === 'activity' ? part.entry.key : part.system.key
      support = {
        kind: 'support',
        key: `support:${partKey}`,
        seq: part.seq,
        parts: []
      }
      segments.push(support)
    }
    support.parts.push(part)
  }
  return segments
}

function RunActivity({ item, sessionId, profileScope }: { item: ProgressItem; sessionId: string; profileScope: WorkspaceProfileScope | null }) {
  return <TraceDisclosure
    events={item.events}
    sessionId={sessionId}
    includeCommentary
    runActivity={item}
    profileScope={profileScope}
  />
}

function TraceDisclosure({
  events,
  sessionId,
  anchorSeq,
  resetKey,
  promotedCommentaryIds = [],
  includeCommentary = false,
  runActivity,
  profileScope = null
}: {
  events: Event[]
  sessionId: string
  anchorSeq?: number
  resetKey?: string
  promotedCommentaryIds?: string[]
  includeCommentary?: boolean
  runActivity?: ProgressItem
  profileScope?: WorkspaceProfileScope | null
}) {
  useLocale()
  const runActivityMode = Boolean(runActivity)
  const activityLive = Boolean(runActivity) && runActivity?.active !== false && !runActivity?.stoppedAt
  const activityStopped = Boolean(runActivity?.stoppedAt)
  const activityHasFinalResponse = runActivity?.hasFinalResponse === true
  // Historical stops are history, not a live interruption. Only keep the
  // activity open automatically when this mounted run actually stops live.
  const [open, setOpen] = useState(() => activityLive)
  const previousActivity = useRef({
    key: runActivity?.key,
    live: activityLive,
    stopped: activityStopped,
    hasFinalResponse: activityHasFinalResponse
  })
  const [loadedEvents, setLoadedEvents] = useState<Event[] | null>(null)
  const [nextAfter, setNextAfter] = useState(runActivity?.afterSeq ?? 0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const detailsId = useId()
  const runId = useMemo(
    () => events.find(event => event.run_id?.trim())?.run_id?.trim() || null,
    [events]
  )
  const traceAnchor = useMemo(
    // Anchor with the newest sampled event so a timeline index cached earlier
    // in the same turn cannot silently truncate the on-demand detail range.
    // Callers that synthesize a run_id onto a runless status summary must pass
    // the newest real run-scoped sequence instead; the synthetic summary does
    // not belong to the server's indexed run bounds.
    () => anchorSeq ?? (events.length ? Math.max(...events.map(event => event.seq)) : 0),
    [anchorSeq, events]
  )
  useEffect(() => {
    loadGeneration.current++
    setLoadedEvents(null)
    setNextAfter(runActivity?.afterSeq ?? 0)
    setHasMore(true)
    setLoadingMore(false)
    setLoadError(null)
    return () => {
      loadGeneration.current++
    }
  }, [resetKey, runActivity?.afterSeq, runId, sessionId])
  useEffect(() => {
    const previous = previousActivity.current
    previousActivity.current = {
      key: runActivity?.key,
      live: activityLive,
      stopped: activityStopped,
      hasFinalResponse: activityHasFinalResponse
    }
    if (!runActivityMode) return
    if (previous.key !== runActivity?.key) setOpen(activityLive)
    else if (
      !activityLive
      && activityHasFinalResponse
      && (previous.live || !previous.hasFinalResponse)
    ) setOpen(false)
    else if (activityLive || (previous.live && activityStopped)) setOpen(true)
    else if (previous.live || (previous.stopped && !activityStopped)) setOpen(false)
  }, [activityHasFinalResponse, activityLive, activityStopped, runActivityMode, runActivity?.key])
  const displayEvents = useMemo(() => {
    const promotedIds = new Set(promotedCommentaryIds)
    const merged = loadedEvents ? mergeTraceEvents(runActivity?.sourceEvents ?? events, loadedEvents) : events
    const normalized = loadedEvents
      ? omitTerminalClaudeFinalCommentary(merged, runActivity?.finalEvents ?? merged)
      : merged
    return normalized.filter(event => (
      !promotedIds.has(event.id)
      && (runActivity?.afterSeq == null || activityEventSequence(event, runActivity.orderingFinalEvents) > runActivity.afterSeq)
      && (runActivity?.throughSeq == null || activityEventSequence(event, runActivity.orderingFinalEvents) <= runActivity.throughSeq)
      && (includeCommentary || !isPublicCommentary(event))
    ))
  }, [events, includeCommentary, loadedEvents, promotedCommentaryIds, runActivity?.afterSeq, runActivity?.throughSeq, runActivity?.finalEvents, runActivity?.orderingFinalEvents, runActivity?.sourceEvents])
  const activity = useMemo(() => buildTraceActivity(displayEvents), [displayEvents])
  const activityParts = useMemo<TracePart[]>(() => [
    ...activity.map(entry => ({ kind: 'activity' as const, seq: entry.seq, entry })),
    ...(runActivity?.lifecycle ?? []).map(system => ({ kind: 'lifecycle' as const, seq: system.seq, system }))
  ].sort((left, right) => left.seq - right.seq), [activity, runActivity?.lifecycle])
  const runActivitySegments = useMemo(
    () => runActivityMode ? groupRunActivity(activityParts) : [],
    [activityParts, runActivityMode]
  )
  const keepTerminalCommentaryVisible = Boolean(
    runActivity
    && !activityLive
    && runActivity.hasFinalResponse === false
  )
  const hasVisibleTerminalCommentary = keepTerminalCommentaryVisible
    && activity.some(entry => entry.kind === 'commentary')
  const summary = useMemo(
    () => summarizeTrace(displayEvents, sessionId, activity.filter(entry => entry.kind === 'tool').length),
    [activity, displayEvents, sessionId]
  )
  const structuredDiffSummary = useMemo(
    () => summary.canonicalDiff ? null : summarizeStructuredToolDiff(displayEvents),
    [displayEvents, summary.canonicalDiff]
  )
  const expanded = useMemo(() => {
    if (!open) return null
    const diff = summary.canonicalDiff ? '' : extractUnifiedDiff(displayEvents)
    return {
      diff,
      legacyFiles: summary.canonicalDiff ? [] : parseReviewableDiff(diff)
    }
  }, [displayEvents, open, summary.canonicalDiff])
  const diffFileCount = summary.canonicalDiff?.files_changed ?? expanded?.legacyFiles.length ?? structuredDiffSummary?.filesChanged ?? 0
  const additions = summary.canonicalDiff?.additions ?? expanded?.legacyFiles.reduce((sum, file) => sum + file.additions, 0) ?? structuredDiffSummary?.additions ?? 0
  const deletions = summary.canonicalDiff?.deletions ?? expanded?.legacyFiles.reduce((sum, file) => sum + file.deletions, 0) ?? structuredDiffSummary?.deletions ?? 0
  const openReview = () => {
    const target: CodeReviewTarget = {
      sessionId,
      runId: summary.canonicalDiff?.run_id,
      source: summary.canonicalDiff ? null : expanded?.diff ?? extractUnifiedDiff(displayEvents),
      files: summary.canonicalDiff?.diff_files ?? structuredDiffSummary?.files,
      additions,
      deletions,
      repositoryRoot: summary.canonicalDiff?.repository_root
    }
    window.dispatchEvent(new CustomEvent<CodeReviewTarget>('agentsdock:review-diff', { detail: target }))
  }
  const showMore = async () => {
    if (!runId || loadingMore) return
    const generation = loadGeneration.current
    const cursor = nextAfter
    setLoadingMore(true)
    setLoadError(null)
    try {
      const page = await window.agentsDock.timeline.trace(sessionId, runId, traceAnchor, cursor)
      if (generation !== loadGeneration.current) return
      const nextCursor = page.next_after ?? cursor
      const boundedEvents = page.events.filter(event => (
        (runActivity?.afterSeq == null || activityEventSequence(event, runActivity.orderingFinalEvents) > runActivity.afterSeq)
        && (runActivity?.throughSeq == null || activityEventSequence(event, runActivity.orderingFinalEvents) <= runActivity.throughSeq)
      ))
      setLoadedEvents(current => mergeTraceEvents(current ?? [], boundedEvents))
      setNextAfter(nextCursor)
      setHasMore(page.has_more && nextCursor > cursor
        && (runActivity?.orderingFinalEvents != null || runActivity?.throughSeq == null || nextCursor < runActivity.throughSeq))
    } catch (error) {
      if (generation !== loadGeneration.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === loadGeneration.current) setLoadingMore(false)
    }
  }
  const showLess = () => {
    loadGeneration.current++
    setLoadedEvents(null)
    setNextAfter(runActivity?.afterSeq ?? 0)
    setHasMore(true)
    setLoadingMore(false)
    setLoadError(null)
  }
  const toolLabel = summary.toolCount
    ? timelineCount('tools', summary.toolCount)
    : ''
  const summaryLabel = summary.summaryCount
    ? timelineCount('summaries', summary.summaryCount)
    : ''
  const metadata = [toolLabel, summaryLabel].filter(Boolean).join(' · ')
  const traceTitle = t('timeline.ui.reasoningTrace')
  const toggleLabel = open ? t('timeline.ui.hideDetails') : t('timeline.ui.showDetails')
  const loadLabel = loadedEvents && runActivity?.throughSeq != null && !hasMore ? null : loadedEvents
    ? hasMore ? t('timeline.ui.loadMoreActivity') : t('timeline.ui.checkForNewerActivity')
    : t('timeline.ui.loadAvailableActivity')
  const activityHeader = runActivity
    ? <RunActivityHeader item={runActivity} events={events} open={open} detailsId={detailsId} onToggle={() => setOpen(value => !value)} />
    : null
  return (
    <div className={`trace${runActivity ? ' run-activity' : ''} ${open ? 'open' : ''}`}>
      {activityHeader ?? <button
        type="button"
        className="trace-summary"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${traceTitle}. ${metadata || t('timeline.ui.activityDetails')}. ${toggleLabel}.`}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronRight size={14} />
        <Code2 size={14} />
        <span className="trace-summary-title"><strong>{traceTitle}</strong>{metadata && <small>{metadata}</small>}</span>
        <span className="trace-summary-action">{toggleLabel}</span>
        {!open && summary.preview && <span className="trace-summary-preview" aria-hidden="true">{summary.preview}</span>}
      </button>}
      {(expanded || hasVisibleTerminalCommentary) && <div id={detailsId} className="trace-details" role="region" aria-label={t('timeline.ui.reasoningAndToolDetails')} aria-busy={loadingMore} tabIndex={0}>
        <ol className="trace-activity" aria-label={t('timeline.ui.chronologicalTraceActivity')}>
          {runActivity
            ? runActivitySegments.map(segment => segment.kind === 'commentary'
                ? <TraceCommentaryEvent key={segment.key} entry={segment.entry} sessionId={sessionId} />
                : open
                  ? <RunActivitySupportGroup key={segment.key} parts={segment.parts} sessionId={sessionId} profileScope={profileScope} />
                  : null)
            : activityParts.map(part => <TracePartView key={tracePartKey(part)} part={part} sessionId={sessionId} profileScope={profileScope} />)}
        </ol>
        {expanded && runId && <div className="trace-detail-actions">
          {loadLabel && <button type="button" disabled={loadingMore} onClick={() => void showMore()}>{loadingMore && <LoaderCircle className="spin" size={12} />}{loadLabel}</button>}
          {loadedEvents && <button type="button" disabled={loadingMore} onClick={showLess}>{t('timeline.ui.useCompactTrace')}</button>}
          {loadError && <span role="alert">{loadError}</span>}
        </div>}
      </div>}
      {diffFileCount > 0 && (!runActivity || open) && <CodeChangesCard fileCount={diffFileCount} additions={additions} deletions={deletions} onOpen={openReview} />}
    </div>
  )
}

function RunActivityHeader({ item, events, open, detailsId, onToggle }: { item: ProgressItem; events: Event[]; open: boolean; detailsId: string; onToggle: () => void }) {
  useLocale()
  const live = item.active !== false && !item.stoppedAt
  const stopped = Boolean(item.stoppedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const duration = activityDuration(item, events, now)
  const title = stopped
    ? t('timeline.activity.stoppedAfter', { duration })
    : live
      ? t('timeline.activity.workingFor', { duration })
      : t('timeline.activity.workedFor', { duration })
  if (live) {
    return <div className="run-activity-summary">
      {live && <span className="activity-ring" aria-hidden="true" />}
      <strong>{title}</strong>
    </div>
  }
  return <button
    type="button"
    className="run-activity-summary"
    aria-expanded={open}
    aria-controls={detailsId}
    onClick={onToggle}
  ><ChevronRight size={14} aria-hidden="true" /><strong>{title}</strong></button>
}

function activityDuration(item: ProgressItem | undefined, events: Event[], now: number): string {
  if (!item) return formatDuration(0)
  const start = Date.parse(item.startedAt || events[0]?.ts || '')
  const terminal = Date.parse(item.stoppedAt || item.finishedAt || events.at(-1)?.ts || '')
  if (!Number.isFinite(start)) return formatDuration(0)
  const end = item.active !== false && !item.stoppedAt ? now : terminal
  return formatDuration(Math.max(0, (Number.isFinite(end) ? end : start) - start) / 1000)
}

function tracePartKey(part: TracePart): string {
  return part.kind === 'activity' ? part.entry.key : part.system.key
}

function TracePartView({ part, sessionId, profileScope }: { part: TracePart; sessionId: string; profileScope: WorkspaceProfileScope | null }) {
  if (part.kind === 'lifecycle') {
    return <li className="run-activity-lifecycle"><LiveLifecycleMarker item={part.system} sessionId={sessionId} profileScope={profileScope} /></li>
  }
  if (part.entry.kind === 'commentary') return <TraceCommentaryEvent entry={part.entry} sessionId={sessionId} />
  if (part.entry.kind === 'reasoning') return <TraceReasoningEvent entry={part.entry} sessionId={sessionId} />
  return <ToolEvent entry={part.entry} />
}

function runActivitySupportSummary(parts: TracePart[]): string {
  let toolCount = 0
  let thinkingCount = 0
  let statusCount = 0
  for (const part of parts) {
    if (part.kind === 'lifecycle') {
      statusCount++
    } else if (part.entry.kind === 'tool') {
      toolCount++
    } else if (part.entry.kind === 'reasoning') {
      thinkingCount += part.entry.events.length
    }
  }
  return [
    toolCount ? timelineCount('toolCalls', toolCount) : '',
    thinkingCount ? timelineCount('thinkingUpdates', thinkingCount) : '',
    statusCount ? timelineCount('statusUpdates', statusCount) : ''
  ].filter(Boolean).join(' · ') || t('timeline.activity.supportingActivity')
}

function RunActivitySupportGroup({ parts, sessionId, profileScope }: { parts: TracePart[]; sessionId: string; profileScope: WorkspaceProfileScope | null }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const summary = runActivitySupportSummary(parts)
  return <li className={`run-activity-support${open ? ' open' : ''}`}>
    <button
      type="button"
      className="run-activity-support-toggle"
      aria-expanded={open}
      aria-controls={detailsId}
      onClick={() => setOpen(value => !value)}
    ><ChevronRight size={12} aria-hidden="true" /><span>{summary}</span></button>
    {open && <ol id={detailsId} className="run-activity-support-details" aria-label={summary}>
      {parts.map(part => <TracePartView key={tracePartKey(part)} part={part} sessionId={sessionId} profileScope={profileScope} />)}
    </ol>}
  </li>
}

function TraceCommentaryEvent({ entry, sessionId }: { entry: TraceCommentaryEntry; sessionId: string }) {
  return <li className="trace-activity-item commentary" data-event-seq={entry.seq}>
    <span className="trace-activity-marker" aria-hidden="true"><Sparkles size={12} /></span>
    <div className="trace-commentary"><MarkdownContent text={traceReasoningText(entry.event)} sessionId={sessionId} fold={false} /></div>
  </li>
}

function summarizeTrace(events: Event[], sessionId: string, toolCount: number): {
  toolCount: number
  summaryCount: number
  preview: string
  canonicalDiff?: Event
} {
  let summaryCount = 0
  let lastTool: Event | undefined
  let lastThought: Event | undefined
  let canonicalDiff: Event | undefined
  for (const event of events) {
    if (event.type === 'tool_started' || event.type === 'tool_finished') {
      lastTool = event
    } else if ((event.type === 'reasoning_summary' || isPublicCommentary(event)) && traceReasoningText(event)) {
      summaryCount++
      lastThought = event
    }
    if (event.session_id === sessionId && event.type === 'code_diff' && event.run_id) canonicalDiff = event
  }
  return {
    toolCount,
    summaryCount,
    preview: boundedTracePreview(
      traceSummaryPreview(lastThought ? traceReasoningText(lastThought) : '') || toolHeadline(lastTool),
      TRACE_HEADER_PREVIEW_CHARS
    ),
    canonicalDiff
  }
}

function traceSummaryPreview(value?: string | null): string {
  return (value || '')
    .trim()
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
}

function boundedTracePreview(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function TraceReasoningEvent({ entry, sessionId }: { entry: TraceReasoningEntry; sessionId: string }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const preview = boundedTracePreview(
    entry.events.map(event => traceSummaryPreview(traceReasoningText(event))).filter(Boolean).join('\n'),
    TRACE_REASONING_PREVIEW_CHARS
  )
  const updateLabel = entry.events.length === 1 ? t('timeline.ui.thinkingSummary') : timelineCount('thinkingUpdates', entry.events.length)
  const accessiblePreview = boundedTracePreview(preview.replace(/\s+/g, ' '), TRACE_REASONING_ACCESSIBLE_CHARS)
  return <li className="trace-activity-item reasoning" data-event-seq={entry.seq}>
    <span className="trace-activity-marker" aria-hidden="true"><Sparkles size={12} /></span>
    <div className="trace-reasoning">
      <button type="button" className="trace-reasoning-toggle" aria-label={open ? updateLabel : `${updateLabel}. ${accessiblePreview}`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>
        <span className="trace-reasoning-preview" aria-hidden="true">{open ? updateLabel : preview}</span>
        {!open && entry.events.length > 1 && <small>{timelineCount('updates', entry.events.length)}</small>}
        <ChevronRight size={12} aria-hidden="true" />
      </button>
      {open && <div id={detailsId} className="trace-reasoning-body">
        {entry.events.map(event => <div className="trace-reasoning-update" key={event.id}><MarkdownContent text={traceReasoningText(event)} sessionId={sessionId} fold={false} /></div>)}
      </div>}
    </div>
  </li>
}

function traceToolHasInput(entry: TraceToolEntry): boolean {
  const input = entry.started?.tool?.input ?? entry.finished?.tool?.input
  if (input == null) return false
  return typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0
}

function traceToolInput(entry: TraceToolEntry): string {
  const input = entry.started?.tool?.input ?? entry.finished?.tool?.input
  if (!traceToolHasInput(entry) || input == null) return ''
  return JSON.stringify(input, null, 2) ?? String(input)
}

function traceToolStatus(entry: TraceToolEntry): { label: string; tone: string } {
  if (!entry.finished) return { label: t('timeline.ui.running'), tone: 'running' }
  if (entry.finished.stopped) return { label: t('timeline.ui.stopped'), tone: 'stopped' }
  if (entry.finished.is_error || (entry.finished.exit_code != null && entry.finished.exit_code !== 0)) {
    return {
      label: entry.finished.exit_code != null ? t('timeline.trace.exitCode', { code: entry.finished.exit_code }) : t('timeline.ui.failed'),
      tone: 'error'
    }
  }
  return { label: t('timeline.ui.success'), tone: 'success' }
}

function ToolEvent({ entry }: { entry: TraceToolEntry }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const event = entry.started ?? entry.finished!
  const name = entry.started?.tool?.name || entry.finished?.tool?.name || t('timeline.ui.tool')
  const status = traceToolStatus(entry)
  const input = open ? traceToolInput(entry) : ''
  const rawOutput = entry.finished?.output || entry.finished?.message || ''
  const output = open && rawOutput ? compactToolOutputPreview(rawOutput) : ''
  const hasDetails = traceToolHasInput(entry) || Boolean(rawOutput)
  const headline = <>
    <strong>{name}</strong>
    <small className={`tool-event-status ${status.tone}`}>{status.label}</small>
    {hasDetails && <ChevronRight size={12} aria-hidden="true" />}
  </>
  return <li className="trace-activity-item tool" data-event-seq={entry.seq}>
    <span className="trace-activity-marker" aria-hidden="true"><Wrench size={12} /></span>
    <div className="tool-event">
      {hasDetails
        ? <button type="button" className="tool-event-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}>{headline}</button>
        : <div className="tool-event-toggle">{headline}</div>}
      {open && hasDetails && <div id={detailsId} className="tool-event-body">
        {input && <section><small>{t('timeline.ui.input')}</small><pre>{input}</pre></section>}
        {output && <section><small>{t('timeline.ui.result')}</small><pre>{output}</pre></section>}
      </div>}
    </div>
  </li>
}

function SystemView({ item, sessionId, profileScope, pinned, codexLifecycleActive }: { item: SystemItem; sessionId: string; profileScope: WorkspaceProfileScope | null; pinned: boolean; codexLifecycleActive: boolean }) {
  useLocale()
  const event = item.event
  const routeAudit = event.type === 'agent_handoff_route_created' ? 'created'
    : event.type === 'agent_handoff_route_updated' ? 'updated'
      : event.type === 'agent_handoff_route_deleted' ? 'deleted' : null
  const routeTargetTitle = useAppStore(state => routeAudit && profileScope
    && state.activeProfileId === profileScope.profileId
    && state.profileGeneration === profileScope.profileGeneration
    ? state.sessions.find(session => session.id === event.target_session_id)?.title : undefined)
  if (isImportedProviderInterruption(event)) return <article className="system-row" data-event-id={event.id}>
    <span className="system-icon"><History size={15} /></span>
    <div><header><strong>{t('timeline.providerInterruption.title')}</strong><time>{formatTime(event.provider_origin.timestamp)}</time></header>
      <p>{t(`timeline.providerInterruption.${event.provider_origin.cause}`)}</p>
    </div>
  </article>
  if (item.importedDelivery) return <ImportedCrossChatDeliveryView item={item} sessionId={sessionId} />
  if (item.crossChatMessage) return <CrossChatMessageView item={item} sessionId={sessionId} profileScope={profileScope} />
  if (codexLifecycleSemanticKey(event)) return <CodexLifecycleView item={item} sessionId={sessionId} active={codexLifecycleActive} />
  if (item.key.startsWith('provider-interaction-audit:')) return <ProviderInteractionAuditView item={item} />
  if (event.type.startsWith('cross_chat_exchange_') && event.exchange_id?.trim()) return <CrossChatExchangeView item={item} sessionId={sessionId} />
  if (event.type.startsWith('cross_chat_')) return <CrossChatView item={item} sessionId={sessionId} />
  if (event.type === 'team_message_sent') return <TeamMessageSentView event={event} profileScope={profileScope} />
  if (event.type === 'emergency_alert_raised') return <EmergencyAlertView event={event} sessionId={sessionId} />
  const error = isTimelineError(event)
  const digest = isHandoffDigestEvent(event)
  const providerBackgroundTask = event.type === 'provider_background_task_update'
  const generating = digest && !['handoff_digest_received', 'handoff_digest_sent', 'handoff_digest_error'].includes(event.type)
  const icon = error ? <AlertTriangle size={15} /> : generating ? <LoaderCircle className="spin" size={15} /> : digest ? <Sparkles size={15} /> : <TerminalSquare size={15} />
  const title = routeAudit ? t(`timeline.route.${routeAudit}.title`)
    : providerBackgroundTask ? t('mergeTimeline.claudeBackgroundTask') : digest ? digestStatusTitle(event) : timelineEventLabel(event.type)
  // Route aliases are protocol handles, not chat names. Keep the receipt's
  // original data intact and resolve its exact target only for presentation.
  const text = routeAudit ? t(`timeline.route.${routeAudit}.message`, {
    title: routeTargetTitle?.trim() ? routeTargetTitle : event.target_title?.trim() ? event.target_title : t('timeline.ui.anotherChat')
  }) : digest ? digestStatusText(event) : messageText(event) || timelineEventLabel(event.type)
  const digestBody = event.type === 'handoff_digest_received' ? event.digest?.trim() : ''
  return <article className={`system-row ${error ? 'error' : digest ? 'digest' : ''}`} data-event-id={event.id}><span className="system-icon">{icon}</span><div><header><strong>{title}</strong><time>{formatTime(event.ts)}</time><button type="button" className={`pin-button ${pinned ? 'active' : ''}`} aria-pressed={pinned} title={pinned ? t('timeline.ui.unpinItem') : t('timeline.ui.pinItem')} onClick={() => runTimelineAction(toggleSystemPin(event, sessionId, profileScope, pinned, title, digestBody || text))}><Pin size={12} fill={pinned ? 'currentColor' : 'none'} /></button></header>{routeAudit ? <p>{text}</p> : <MarkdownContent text={text} sessionId={sessionId} compact />}{digestBody && <details className="digest-body"><summary>{t('timeline.ui.viewDigest')}</summary><MarkdownContent text={digestBody} sessionId={sessionId} /></details>}</div></article>
}

function ImportedCrossChatDeliveryView({ item, sessionId }: { item: SystemItem; sessionId: string }) {
  useLocale()
  const delivery = item.importedDelivery!
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [item.key, sessionId])
  const message = { body: delivery.body, preview: '', bodyChars: delivery.body.length, bodyTruncated: false }
  const longBody = crossChatLegBodyIsLong(message)
  if (delivery.kind === 'status') return <article className="system-row" data-event-id={item.event.id}>
    <span className="system-icon"><MessageSquareShare size={14} /></span>
    <div>
      <header><strong>{t('timeline.exchange.statusUpdate')}</strong><time>{formatTime(item.event.ts)}</time></header>
      <MarkdownContent text={delivery.body} sessionId={sessionId} compact />
    </div>
  </article>
  return <article className="cross-chat-message incoming" data-event-id={item.event.id}>
    <div className="cross-chat-message-surface">
      <header>
        <MessageSquareShare size={13} aria-hidden="true" />
        <strong>{delivery.sender}</strong>
        <time>{formatTime(item.event.ts)}</time>
      </header>
      {delivery.editedByUser && <small>{t('timeline.handoff.editedByYou')}</small>}
      <MarkdownContent text={expanded || !longBody ? delivery.body : crossChatLegCollapsedText(message)} sessionId={sessionId} fold={false} />
      {longBody && <button type="button" className="cross-chat-message-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('timeline.ui.showLess') : t('timeline.ui.viewMessage')}</button>}
    </div>
  </article>
}

function TeamMessageSentView({ event, profileScope }: { event: Event; profileScope: WorkspaceProfileScope | null }) {
  useLocale()
  const recipients = event.recipients ?? []
  const messageTitle = event.title?.trim()
  const names = recipients.map(recipient => (
    recipient.kind === 'all' ? t('teamNetwork.bulletin') : recipient.display_name
  )).filter(Boolean)
  const destination = names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} +${names.length - 3}`
  const isSkill = event.kind === 'skill'
  const allServers = event.destination === 'all_servers'
  const bulletin = !allServers && recipients.some(recipient => recipient.kind === 'all')
  const subject = messageTitle
    ? `“${messageTitle}”`
    : isSkill
      ? t('teamNetwork.timeline.skillSubject')
      : t('teamNetwork.timeline.messageSubject')
  const destinationText = bulletin ? t('teamNetwork.timeline.toBulletin')
    : allServers ? t('teamNetwork.timeline.toAllInboxes')
      : destination ? t('teamNetwork.timeline.toRecipient', { name: destination }) : t('teamNetwork.timeline.throughNetwork')
  const label = t(isSkill ? 'teamNetwork.timeline.published' : bulletin ? 'teamNetwork.timeline.broadcast' : 'teamNetwork.timeline.sent', { subject, destination: destinationText })
  const open = () => window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', {
    detail: { section: bulletin ? 'feed' : 'mail',
      ...(event.team_id && event.message_id ? { teamId: event.team_id, messageId: event.message_id,
        ...(bulletin ? {} : { mailboxBox: 'sent' }),
        ...(profileScope ? { profileId: profileScope.profileId,
          ...(profileScope.serverIdentity ? { serverIdentity: profileScope.serverIdentity } : {}) } : {}) } : {}) }
  }))
  return <button type="button" className="system-row team-message-sent" aria-label={t('teamNetwork.timeline.openMessage', { label })} onClick={open} data-event-id={event.id} data-message-id={event.message_id || undefined}>
    <span className="system-icon"><MessageSquareShare size={15} /></span>
    <span className="team-message-sent-label">{label}</span>
    <time>{formatTime(event.ts)}</time>
    <ChevronRight size={14} />
  </button>
}

interface ProviderInteractionAuditEntry {
  id: string
  latest: Event
  requested?: Event
  resolved?: Event
}

function ProviderInteractionAuditView({ item }: { item: SystemItem }) {
  useLocale()
  const events = item.events?.length ? item.events : [item.event]
  const provider = item.key.split(':')[1] || 'provider'
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1)
  const entries = providerInteractionAuditEntries(events)
  const requestCount = events.filter(event => event.type.endsWith('_interaction_requested')).length
  const resolvedCount = events.filter(event => event.type.endsWith('_interaction_resolved')).length
  const countLabel = [
    requestCount ? timelineCount('requests', requestCount) : '',
    resolvedCount ? timelineCount('resolved', resolvedCount) : ''
  ].filter(Boolean).join(' · ') || timelineCount('updates', events.length)

  return <details className="system-row provider-interaction-audit" data-event-id={item.event.id}>
    <summary>
      <span className="system-icon" aria-hidden="true"><History size={14} /></span>
      <strong>{t('timeline.requests.history', { provider: providerName })}</strong>
      <span className="provider-interaction-audit-count">{countLabel}</span>
      <time>{formatTime(item.event.ts)}</time>
    </summary>
    <div className="provider-interaction-audit-detail">
      <p>{t('mergeTimeline.requestHistoryReadOnly')}</p>
      <ol>
        {entries.map(entry => <li key={entry.id}>
          <span>
            <strong>{providerInteractionAuditLabel(entry)}</strong>
            <small>{providerInteractionAuditStatus(entry)}</small>
          </span>
          <time>{formatTime(entry.latest.ts)}</time>
        </li>)}
      </ol>
    </div>
  </details>
}

function providerInteractionAuditEntries(events: Event[]): ProviderInteractionAuditEntry[] {
  const entries = new Map<string, ProviderInteractionAuditEntry>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const id = event.interaction_id?.trim() || event.interaction?.id?.trim() || event.id
    const existing = entries.get(id)
    const entry: ProviderInteractionAuditEntry = existing
      ? { ...existing, latest: event.seq >= existing.latest.seq ? event : existing.latest }
      : { id, latest: event }
    if (event.type.endsWith('_interaction_requested')) entry.requested = event
    if (event.type.endsWith('_interaction_resolved')) entry.resolved = event
    entries.set(id, entry)
  }
  return [...entries.values()].sort((left, right) => right.latest.seq - left.latest.seq)
}

function providerInteractionAuditLabel(entry: ProviderInteractionAuditEntry): string {
  const event = entry.requested ?? entry.resolved ?? entry.latest
  const method = event.interaction?.method || event.request_method || ''
  if (method.includes('commandExecution')) return t('timeline.ui.commandApproval')
  if (method.includes('fileChange') || method === 'applyPatchApproval') return t('timeline.ui.fileChangeApproval')
  if (method.includes('requestUserInput')) return t('timeline.ui.userInputRequest')
  if (method.includes('elicitation')) return t('timeline.ui.mCPInputRequest')
  if (method.includes('permissions')) return t('timeline.ui.permissionApproval')
  if (method.includes('tool')) return t('timeline.ui.toolApproval')
  if (method.includes('Approval') || method.includes('requestApproval')) return t('timeline.ui.approvalRequest')
  return t('timeline.ui.interactionRequest')
}

function providerInteractionAuditStatus(entry: ProviderInteractionAuditEntry): string {
  const resolution = entry.resolved?.resolution?.trim()
  if (!entry.resolved) return t('timeline.ui.requested')
  if (!resolution || resolution === 'answered') return t('timeline.ui.resolved')
  return timelineStatusLabel(resolution)
}

function EmergencyAlertView({ event, sessionId }: { event: Event; sessionId: string }) {
  useLocale()
  const session = useAppStore(state => (
    state.snapshots[sessionId]?.session
    ?? state.sessions.find(candidate => candidate.id === sessionId)
    ?? null
  ))
  const activeAlert = activeEmergencyAlert(session)
  const eventAlertId = event.emergency_alert_id?.trim() || event.emergency_alert?.id?.trim() || ''
  const acknowledgeable = Boolean(eventAlertId && activeAlert?.id === eventAlertId)
  const [acknowledging, setAcknowledging] = useState(false)
  const [acknowledgementFailed, setAcknowledgementFailed] = useState(false)
  useEffect(() => {
    setAcknowledging(false)
    setAcknowledgementFailed(false)
  }, [activeAlert?.id])
  const acknowledge = async () => {
    if (!acknowledgeable || acknowledging) return
    setAcknowledging(true)
    setAcknowledgementFailed(false)
    try {
      const acknowledged = await useAppStore.getState().acknowledgeEmergency(sessionId, eventAlertId)
      setAcknowledgementFailed(!acknowledged)
    } catch (error) {
      setAcknowledgementFailed(true)
      throw error
    } finally {
      setAcknowledging(false)
    }
  }
  const label = session?.title
    ? t('timeline.emergency.acknowledgeIn', { title: session.title })
    : t('timeline.ui.acknowledgeEmergency')
  return <article className="system-row emergency" data-event-id={event.id} data-alert-id={eventAlertId || undefined}>
    <span className="system-icon"><Siren size={15} aria-hidden="true" /></span>
    <div>
      <header><strong>{t('timeline.ui.emergencyAlertRaised')}</strong><time>{formatTime(event.ts)}</time></header>
      <p className="emergency-event-message">{event.message || t('timeline.ui.theAgentRequestedImmediateAttention')}</p>
      {acknowledgeable && <div className="emergency-event-actions">
        {acknowledgementFailed && <span role="alert">{t('timeline.ui.couldnTAcknowledgeTryAgain')}</span>}
        <button
          type="button"
          disabled={acknowledging}
          aria-busy={acknowledging}
          aria-label={label}
          onClick={() => runTimelineAction(acknowledge())}
        >{acknowledging && <LoaderCircle className="spin" size={13} aria-hidden="true" />}{t('timeline.ui.acknowledge')}</button>
      </div>}
    </div>
  </article>
}

interface TimelineWorkspaceScope {
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  connected: boolean
  connectionGeneration: number
  serverInstanceId: string | null
  sessionId: string
}

function captureTimelineWorkspaceScope(sessionId: string): TimelineWorkspaceScope {
  const state = useAppStore.getState()
  return {
    profileId: state.activeProfileId,
    profileGeneration: state.profileGeneration,
    serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
    connected: state.connected,
    connectionGeneration: state.connectionGeneration,
    serverInstanceId: state.health?.server_instance_id ?? null,
    sessionId
  }
}

function timelineWorkspaceScopeCurrent(scope: TimelineWorkspaceScope): boolean {
  const state = useAppStore.getState()
  return state.connected === scope.connected
    && state.connectionGeneration === scope.connectionGeneration
    && (state.health?.server_instance_id ?? null) === scope.serverInstanceId
    && state.activeProfileId === scope.profileId
    && state.profileGeneration === scope.profileGeneration
    && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === scope.serverIdentity
    && (
      state.selectedSessionId === scope.sessionId
      || state.chatPanes.primary === scope.sessionId
      || state.chatPanes.secondary === scope.sessionId
    )
}

async function refreshTimelineQueue(scope: TimelineWorkspaceScope): Promise<QueuedTurn[]> {
  const state = useAppStore.getState()
  const request = state.beginQueuedTurnsRequest(scope.sessionId)
  const turns = await window.agentsDock.queue.list(scope.sessionId)
  if (timelineWorkspaceScopeCurrent(scope)) {
    useAppStore.getState().applyQueuedTurnsResponse(scope.sessionId, request, turns)
  }
  return turns
}

function exchangeParticipant(exchange: CrossChatExchange, sessionId: string): boolean {
  return exchange.requester_session_id === sessionId || exchange.responder_session_id === sessionId
}

function terminalExchangeStatus(status: CrossChatExchange['status'] | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
}

interface CrossChatConversationLeg {
  id: string
  ordinal: number
  kind: 'request' | 'reply'
  expectsReply: boolean | null
  status: string
  sourceId: string
  targetId: string
  sourceTitle: string
  targetTitle: string
  preview: string
  body: string
  bodyChars: number | null
  bodyTruncated: boolean
  errorCode: string
  error: string
  queuedId: string
  ts: string
}

const CROSS_CHAT_LONG_MESSAGE_CHARS = 640
const CROSS_CHAT_LONG_MESSAGE_LINES = 10

type CrossChatMessageBody = Pick<CrossChatConversationLeg, 'body' | 'preview' | 'bodyChars' | 'bodyTruncated'>

function crossChatLegMayHaveMoreBody(leg: CrossChatMessageBody): boolean {
  if (leg.body) return false
  if (leg.bodyTruncated) return true
  const preview = leg.preview.trim()
  if ((leg.bodyChars ?? 0) > preview.length) return true
  return preview.endsWith('…') || preview.endsWith('...')
}

function crossChatLegBodyIsLong(leg: CrossChatMessageBody): boolean {
  const body = leg.body || leg.preview
  return (leg.bodyChars ?? body.length) > CROSS_CHAT_LONG_MESSAGE_CHARS
    || body.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
}

function crossChatLegCollapsedText(leg: CrossChatMessageBody): string {
  const source = leg.preview || leg.body
  const lines = source.split('\n')
  const lineClipped = lines.slice(0, CROSS_CHAT_LONG_MESSAGE_LINES).join('\n')
  const characters = Array.from(lineClipped)
  const clipped = characters.length > CROSS_CHAT_LONG_MESSAGE_CHARS
    ? characters.slice(0, CROSS_CHAT_LONG_MESSAGE_CHARS).join('')
    : lineClipped
  return `${clipped.trimEnd()}${clipped !== source ? '…' : ''}`
}

function latestExchangeString(events: Event[], read: (event: Event) => string | null | undefined): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index])?.trim() || ''
    if (value) return value
  }
  return ''
}

function latestExchangeNumber(events: Event[], read: (event: Event) => number | null | undefined): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index])
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function latestExchangeBoolean(events: Event[], read: (event: Event) => boolean | null | undefined): boolean | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index])
    if (typeof value === 'boolean') return value
  }
  return null
}

function lifecycleConversationLegs(events: Event[]): CrossChatConversationLeg[] {
  const byLeg = new Map<string, Event[]>()
  for (const event of events) {
    const legId = event.exchange_leg_id?.trim() || event.cross_chat_exchange_leg_id?.trim() || ''
    if (!legId || event.exchange_leg_kind === 'status') continue
    byLeg.set(legId, [...(byLeg.get(legId) ?? []), event])
  }
  return [...byLeg.entries()].flatMap(([id, updates]) => {
    const ordered = [...updates].sort((left, right) => left.seq - right.seq)
    const rawKind = latestExchangeString(ordered, event => event.exchange_leg_kind)
    if (rawKind === 'status') return []
    const status = latestExchangeString(ordered, event => event.exchange_leg_status) || 'registered'
    const kind: CrossChatConversationLeg['kind'] = rawKind === 'reply' ? 'reply' : 'request'
    const failedUpdate = [...ordered].reverse().find(event => (
      event.exchange_leg_status === 'failed'
      || event.type === 'cross_chat_exchange_leg_failed'
    ))
    return [{
      id,
      ordinal: latestExchangeNumber(ordered, event => event.exchange_ordinal) ?? 0,
      kind,
      expectsReply: latestExchangeBoolean(ordered, event => event.exchange_expects_reply),
      status,
      sourceId: latestExchangeString(ordered, event => event.source_session_id),
      targetId: latestExchangeString(ordered, event => event.target_session_id),
      sourceTitle: latestExchangeString(ordered, event => event.source_title),
      targetTitle: latestExchangeString(ordered, event => event.target_title),
      preview: latestExchangeString(ordered, event => event.handoff_preview),
      body: '',
      bodyChars: latestExchangeNumber(ordered, event => event.handoff_body_chars),
      bodyTruncated: latestExchangeBoolean(ordered, event => event.handoff_body_truncated) === true,
      errorCode: failedUpdate?.exchange_error_code?.trim() || '',
      error: failedUpdate?.message?.trim() || '',
      queuedId: latestExchangeString(ordered, event => event.queued_id),
      ts: ordered[0]?.ts || ''
    }]
  }).sort((left, right) => left.ordinal - right.ordinal || left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id))
}

function exchangeStateLabel(
  status: CrossChatExchange['status'] | null,
  activeLegStatus = '',
  expectsReply = true
): string {
  if (status === 'completed') return t('timeline.ui.completed')
  if (status === 'failed') return t('timeline.ui.couldnTComplete')
  if (status === 'cancelled') return t('timeline.ui.cancelledBeforeCompletion')
  if (status === 'expired') return t('timeline.ui.expiredBeforeCompletion')
  if (status === 'waiting_request') return t('timeline.ui.waitingToStart')
  if (expectsReply) {
    if (['registered', 'submitting'].includes(activeLegStatus)) return t('timeline.exchange.replyPendingSending')
    if (activeLegStatus === 'queued') return t('timeline.exchange.replyPendingQueued')
    if (activeLegStatus === 'running') return t('timeline.exchange.replyPendingProcessing')
    return t('timeline.exchange.replyPending')
  }
  return activeLegStatus === 'queued' ? t('timeline.exchange.deliveryQueued') : t('timeline.exchange.deliveryInProgress')
}

function exchangeRecoveryNote(value: string): string {
  if (!/^Recovered terminal (?:cross-chat )?exchange(?: leg)? state(?: after restart|:)/iu.test(value.trim())) return value
  return t('timeline.ui.conversationStatusWasSynchronizedFromTheServer')
}

function exchangeFailureMessageIsPlainLanguage(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed)
    && exchangeRecoveryNote(trimmed) === trimmed
    && /\s/u.test(trimmed)
}

function CrossChatMessageView({ item, sessionId, profileScope }: { item: SystemItem; sessionId: string; profileScope: WorkspaceProfileScope | null }) {
  useLocale()
  const events = item.events ?? [item.event]
  const envelopeId = item.event.cross_chat_envelope_id?.trim() || item.event.handoff_id?.trim() || item.event.message_id?.trim() || ''
  const conversationId = latestExchangeString(events, event => event.conversation_id)
  const sourceId = latestExchangeString(events, event => event.source_session_id)
  const targetId = latestExchangeString(events, event => event.target_session_id)
  const incoming = targetId === sessionId && sourceId !== sessionId
  const editedByUser = incoming && latestExchangeBoolean(events, event => event.message_edited_by_user) === true
  const messageRevision = editedByUser ? latestExchangeNumber(events, event => event.message_revision) : null
  const bodyRevisionKey = `${editedByUser ? 'edited' : 'original'}:${messageRevision ?? ''}`
  const bodyEvents = editedByUser ? events.filter(event => event.message_edited_by_user === true
    && event.message_revision === messageRevision) : events
  const counterpartId = incoming ? sourceId : targetId
  const savedTitle = latestExchangeString(events, event => incoming ? event.source_title : event.target_title)
  const currentTitle = !savedTitle && counterpartId
    ? useAppStore.getState().sessions.find(session => session.id === counterpartId)?.title : undefined
  const counterpartTitle = savedTitle || currentTitle || t('timeline.ui.unknownAgent')
  const [loadedBody, setLoadedBody] = useState<{ revisionKey: string; text: string } | null>(null)
  const body = loadedBody?.revisionKey === bodyRevisionKey ? loadedBody.text : null
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const requestGeneration = useRef(0)
  useEffect(() => {
    requestGeneration.current++
    setLoadedBody(null)
    setExpanded(false)
    setLoading(false)
    setLoadError('')
    return () => { requestGeneration.current++ }
  }, [item.key, sessionId, bodyRevisionKey, profileScope?.profileId, profileScope?.profileGeneration, profileScope?.serverIdentity])
  const message: CrossChatMessageBody = {
    preview: latestExchangeString(bodyEvents, event => event.handoff_preview), body: '',
    bodyChars: latestExchangeNumber(bodyEvents, event => event.handoff_body_chars),
    bodyTruncated: latestExchangeBoolean(bodyEvents, event => event.handoff_body_truncated) === true
  }
  const moreBodyAvailable = crossChatLegMayHaveMoreBody(message)
  const longBody = crossChatLegBodyIsLong(message)
  const preview = longBody ? crossChatLegCollapsedText(message) : message.preview
  const text = expanded ? body ?? message.preview : preview
  const showFullMessage = async () => {
    if (loading) return
    if (body !== null || !moreBodyAvailable) { setExpanded(true); return }
    const scope = captureTimelineWorkspaceScope(sessionId)
    const request = ++requestGeneration.current
    setLoading(true)
    setLoadError('')
    try {
      const handoff = await window.agentsDock.handoffs.get(envelopeId)
      if (request !== requestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (handoff.id !== envelopeId || handoff.message_id !== envelopeId
        || !conversationId || handoff.conversation_id !== conversationId
        || handoff.conversation_mode !== 'async_route_v1') {
        throw new Error(t('timeline.ui.agentsServerReturnedTheWrongHandoff'))
      }
      if (handoff.source_session_id !== sourceId || handoff.target_session_id !== targetId
        || (sourceId !== sessionId && targetId !== sessionId)) {
        throw new Error(t('timeline.ui.thisChatIsNotAParticipantInTheHandoff'))
      }
      let effectiveBody = handoff.body
      if (editedByUser) {
        if (messageRevision === null || !Number.isSafeInteger(messageRevision) || messageRevision < 1
          || handoff.message_edited_by_user !== true || handoff.message_revision !== messageRevision
          || typeof handoff.target_body !== 'string' || !handoff.target_body.trim()) {
          throw new Error(t('timeline.handoff.editedBodyUnavailable'))
        }
        effectiveBody = handoff.target_body
      }
      setLoadedBody({ revisionKey: bodyRevisionKey, text: effectiveBody })
      setExpanded(true)
    } catch (error) {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setLoadError(timelineActionError(error))
    } finally {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setLoading(false)
    }
  }
  const status = latestExchangeString(events, event => event.handoff_status)
  const failed = status === 'failed' || item.event.type === 'chat_conversation_message_failed'
  const cancelled = status === 'cancelled' || item.event.type === 'chat_conversation_message_cancelled'
  return <article
    className={`cross-chat-message ${incoming ? 'incoming' : 'outgoing'}${failed ? ' failed' : ''}`}
    data-event-id={item.event.id}
    data-message-id={envelopeId}
  >
    <div className="cross-chat-message-surface">
      <header>
        <MessageSquareShare size={13} aria-hidden="true" />
        <strong>{incoming ? counterpartTitle : t('timeline.handoff.sent', { title: counterpartTitle })}</strong>
        <time>{formatTime(item.anchorTs || item.event.ts)}</time>
      </header>
      {editedByUser && <small>{t('timeline.handoff.editedByYou')}</small>}
      {text && <MarkdownContent text={text} sessionId={sessionId} fold={false} />}
      {!text && <small>{t('timeline.ui.messageBodyAvailableOnDemand')}</small>}
      {(moreBodyAvailable || longBody) && <button
        type="button"
        className="cross-chat-message-expand"
        disabled={loading}
        onClick={() => expanded ? setExpanded(false) : void showFullMessage()}
      >{loading ? t('timeline.ui.loadingFullMessage') : expanded ? t('timeline.ui.showLess') : t('timeline.ui.viewMessage')}</button>}
      {failed && <small className="cross-chat-message-error">{latestExchangeString(events, event => event.message) || t('timeline.ui.couldnTComplete')}</small>}
      {cancelled && <small>{t('timeline.status.cancelled')}</small>}
      {loadError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotLoadFullMessage')} {loadError}</small>}
    </div>
  </article>
}

function CrossChatExchangeView({ item, sessionId }: { item: SystemItem; sessionId: string }) {
  useLocale()
  const event = item.event
  const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim() || ''
  const lifecycleEvents = (item.events?.length ? item.events : [event])
    .filter(candidate => (
      candidate.exchange_id?.trim() || candidate.cross_chat_exchange_id?.trim() || ''
    ) === exchangeId)
    .sort((left, right) => left.seq - right.seq)
  const lifecycleLegs = lifecycleConversationLegs(lifecycleEvents)
  const [exchangeSnapshot, setExchangeSnapshot] = useState<{
    exchange: CrossChatExchange
    eventSeq: number
  } | null>(null)
  const exchange = exchangeSnapshot?.exchange ?? null
  const snapshotCurrent = exchangeSnapshot?.eventSeq === event.seq
  const lifecycleLegById = new Map(lifecycleLegs.map(leg => [leg.id, leg]))
  const conversationLegs = exchange
    ? [
        ...exchange.legs.filter(leg => leg.kind !== 'status').map(leg => {
          const observed = lifecycleLegById.get(leg.id)
          return {
            id: leg.id,
            ordinal: leg.ordinal,
            kind: leg.kind === 'reply' ? 'reply' as const : 'request' as const,
            expectsReply: leg.expects_reply,
            status: snapshotCurrent ? leg.status : observed?.status || leg.status,
            sourceId: leg.source_session_id,
            targetId: leg.target_session_id,
            sourceTitle: observed?.sourceTitle || '',
            targetTitle: observed?.targetTitle || '',
            preview: observed?.preview || '',
            body: leg.body,
            bodyChars: leg.body_chars,
            bodyTruncated: observed?.bodyTruncated ?? false,
            errorCode: (snapshotCurrent ? leg.error_code : observed?.errorCode || leg.error_code) || '',
            error: (snapshotCurrent ? leg.error : observed?.error || leg.error) || '',
            queuedId: leg.queued_id || observed?.queuedId || '',
            ts: observed?.ts || leg.created_at || leg.updated_at
          }
        }),
        ...lifecycleLegs.filter(leg => !exchange.legs.some(candidate => candidate.id === leg.id))
      ].sort((left, right) => left.ordinal - right.ordinal || left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id))
    : lifecycleLegs
  const firstLeg = conversationLegs[0] ?? null
  const requesterId = exchange?.requester_session_id
    || latestExchangeString(lifecycleEvents, candidate => candidate.requester_session_id)
    || firstLeg?.sourceId
    || ''
  const responderId = exchange?.responder_session_id
    || latestExchangeString(lifecycleEvents, candidate => candidate.responder_session_id)
    || firstLeg?.targetId
    || ''
  const sessions = useAppStore(state => state.sessions)
  const canSkipQueuedDelivery = useAppStore(state => exactQueuedDeliverySkipAvailable(state.health))
  const workspaceRevision = useAppStore(state => {
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
    const visible = state.selectedSessionId === sessionId
      || state.chatPanes.primary === sessionId
      || state.chatPanes.secondary === sessionId
    return JSON.stringify([
      state.activeProfileId, state.profileGeneration, profile?.serverIdentity ?? null,
      state.connected, state.connectionGeneration, state.health?.server_instance_id ?? null, visible
    ])
  })
  const requesterTitleSnapshot = latestExchangeString(lifecycleEvents, candidate => candidate.requester_title)
    || firstLeg?.sourceTitle
  const responderTitleSnapshot = latestExchangeString(lifecycleEvents, candidate => candidate.responder_title)
    || firstLeg?.targetTitle
  const participantTitle = (id: string, fallback = '') => (
    sessions.find(session => session.id === id)?.title
    || (id === requesterId ? requesterTitleSnapshot : '')
    || (id === responderId ? responderTitleSnapshot : '')
    || fallback
    || t('timeline.ui.unknownAgent')
  )
  const counterpartId = requesterId === sessionId
    ? responderId
    : responderId === sessionId
      ? requesterId
      : firstLeg?.sourceId === sessionId ? firstLeg.targetId : firstLeg?.sourceId || responderId || requesterId
  const counterpartTitle = participantTitle(counterpartId, t('timeline.ui.anotherChat'))
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [skippingDelivery, setSkippingDelivery] = useState(false)
  const [skipError, setSkipError] = useState('')
  const [skippedQueuedId, setSkippedQueuedId] = useState('')
  const [deliveryPromoted, setDeliveryPromoted] = useState(false)
  const [messageExpansion, setMessageExpansion] = useState<Record<string, boolean>>({})
  const detailRequestGeneration = useRef(0)
  const cancelRequestGeneration = useRef(0)
  const skipRequestGeneration = useRef(0)
  useEffect(() => {
    detailRequestGeneration.current += 1
    cancelRequestGeneration.current += 1
    skipRequestGeneration.current += 1
    setExchangeSnapshot(null)
    setLoading(false)
    setLoadError('')
    setCancelling(false)
    setCancelError('')
    setSkippingDelivery(false)
    setSkipError('')
    setSkippedQueuedId('')
    setDeliveryPromoted(false)
    setMessageExpansion({})
  }, [exchangeId, sessionId, workspaceRevision])

  const loadExchange = async () => {
    if (!exchangeId || (exchange && snapshotCurrent) || loading) return
    const request = ++detailRequestGeneration.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    setLoading(true)
    setLoadError('')
    try {
      const loaded = await window.agentsDock.exchanges.get(exchangeId)
      if (request !== detailRequestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (loaded.id !== exchangeId) throw new Error(t('timeline.ui.agentsServerReturnedTheWrongExchange'))
      if (!exchangeParticipant(loaded, sessionId)) throw new Error(t('timeline.ui.thisChatIsNotAParticipantInTheExchange'))
      if (lifecycleLegs.some(timelineLeg => !loaded.legs.some(leg => leg.id === timelineLeg.id && leg.exchange_id === exchangeId))) {
        throw new Error(t('timeline.ui.agentsServerDidNotReturnThisExchangeLeg'))
      }
      setExchangeSnapshot({ exchange: loaded, eventSeq: event.seq })
    } catch (error) {
      if (request === detailRequestGeneration.current && timelineWorkspaceScopeCurrent(scope)) {
        setLoadError(timelineActionError(error))
      }
    } finally {
      if (request === detailRequestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setLoading(false)
    }
  }

  const cancelExchange = async (): Promise<CrossChatExchange | null> => {
    if (!exchangeId || cancelling) return null
    const request = ++cancelRequestGeneration.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    setCancelling(true)
    setCancelError('')
    try {
      const cancelled = await window.agentsDock.exchanges.cancel(exchangeId)
      if (request !== cancelRequestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return null
      if (cancelled.id !== exchangeId) throw new Error(t('timeline.ui.agentsServerReturnedTheWrongExchange'))
      if (!exchangeParticipant(cancelled, sessionId)) throw new Error(t('timeline.ui.thisChatIsNotAParticipantInTheExchange'))
      setExchangeSnapshot({ exchange: cancelled, eventSeq: event.seq })
      return cancelled
    } catch (error) {
      if (request === cancelRequestGeneration.current && timelineWorkspaceScopeCurrent(scope)) {
        setCancelError(timelineActionError(error))
      }
      return null
    } finally {
      if (request === cancelRequestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setCancelling(false)
    }
  }

  const initialAction = (latestExchangeString(lifecycleEvents, candidate => candidate.exchange_initial_action)
    || exchange?.initial_action
    || null) as CrossChatExchange['initial_action']
  const terminalEventStatus = [...lifecycleEvents].reverse()
    .map(candidate => candidate.exchange_status)
    .find(status => terminalExchangeStatus(status)) || null
  const latestEventStatus = (latestExchangeString(lifecycleEvents, candidate => candidate.exchange_status)
    || null) as CrossChatExchange['status'] | null
  const exchangeStatus = terminalEventStatus
    || (snapshotCurrent ? exchange?.status : null)
    || latestEventStatus
    || exchange?.status
    || 'active'
  const terminalStatus = terminalExchangeStatus(exchangeStatus) ? exchangeStatus : null
  const queuedDelivery = terminalStatus || deliveryPromoted
    ? null
    : conversationLegs.find(leg => (
      leg.targetId === sessionId
      && leg.status === 'queued'
      && Boolean(leg.queuedId)
      && leg.queuedId !== skippedQueuedId
    )) ?? null
  const actionLeg = conversationLegs.find(leg => snapshotCurrent && leg.id === exchange?.active_leg_id)
    || [...conversationLegs].reverse().find(leg => !['delivered', 'failed', 'cancelled', 'expired'].includes(leg.status))
    || conversationLegs[conversationLegs.length - 1]
    || null
  const participant = exchange
    ? exchangeParticipant(exchange, sessionId)
    : requesterId === sessionId
      || responderId === sessionId
      || conversationLegs.some(leg => leg.sourceId === sessionId || leg.targetId === sessionId)
  const canCancel = participant
    && Boolean(exchangeId)
    && (!queuedDelivery || !canSkipQueuedDelivery)
    && ['waiting_request', 'active'].includes(String(exchangeStatus || ''))
  const errorEvent = [...lifecycleEvents].reverse().find(candidate => (
    candidate.exchange_status === 'failed'
    || candidate.exchange_leg_status === 'failed'
    || candidate.type === 'cross_chat_exchange_failed'
    || candidate.type === 'cross_chat_exchange_leg_failed'
  ))
  const failureMessage = exchange?.error
    || conversationLegs.find(leg => leg.error)?.error
    || errorEvent?.message?.trim()
    || exchange?.error_code
    || conversationLegs.find(leg => leg.errorCode)?.errorCode
    || errorEvent?.exchange_error_code
    || ''
  const failed = exchangeStatus === 'failed'
    || conversationLegs.some(leg => leg.status === 'failed')
  const failureSummary = failed
    ? failureMessage && exchangeFailureMessageIsPlainLanguage(failureMessage)
      ? failureMessage
      : t('timeline.exchange.failed', { title: counterpartTitle })
    : ''
  const stateLabel = exchangeStateLabel(
    exchangeStatus,
    actionLeg?.status || '',
    actionLeg?.expectsReply ?? initialAction !== 'instruction'
  )

  const setLegBodyExpanded = (leg: CrossChatConversationLeg, expanded: boolean) => {
    setMessageExpansion(current => ({ ...current, [leg.id]: expanded }))
    if (expanded && (crossChatLegMayHaveMoreBody(leg) || !leg.body && !leg.preview)) void loadExchange()
  }


  const skipQueuedDelivery = async () => {
    if (!queuedDelivery || !exchangeId || skippingDelivery) return
    const queuedId = queuedDelivery.queuedId
    const legId = queuedDelivery.id
    const request = ++skipRequestGeneration.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    setSkippingDelivery(true)
    setSkipError('')
    try {
      await window.agentsDock.queue.skipCrossChatDelivery(sessionId, queuedId, {
        cross_chat_exchange_id: exchangeId,
        cross_chat_exchange_leg_id: legId
      })
      if (request !== skipRequestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      setSkippedQueuedId(queuedId)
      // The exact skip is already durable; refreshing is only projection repair.
      await refreshTimelineQueue(scope).catch(() => undefined)
    } catch (error) {
      if (request !== skipRequestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      const refreshed = await refreshTimelineQueue(scope).catch(() => null)
      if (request !== skipRequestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (refreshed && !refreshed.some(turn => turn.queued_id === queuedId)) {
        // Promotion can win the skip race. Do not leave a stale action attached
        // to the older queued event while the durable timeline catches up.
        setDeliveryPromoted(true)
        // The target claimed the delivery before the exact queue skip landed.
        // Preserve the user's cancel intent by escalating to exchange cancel;
        // capable servers interrupt that exact running target. If cancellation
        // itself loses to completion or cannot reconcile, load terminal truth.
        const reconciled = await cancelExchange()
        if (!reconciled) await loadExchange()
        return
      }
      setSkipError(timelineActionError(error))
    } finally {
      if (request === skipRequestGeneration.current && timelineWorkspaceScopeCurrent(scope)) {
        setSkippingDelivery(false)
      }
    }
  }

  // Queueing is a leg state, not a replacement for the conversation history.
  const queuedActionLeg = !terminalStatus && actionLeg?.status === 'queued' ? actionLeg : null

  const displayedLegs = item.crossChatLegId
    ? conversationLegs.filter(leg => leg.id === item.crossChatLegId)
    : conversationLegs

  return <div className="cross-chat-legacy-messages" data-event-id={event.id} data-exchange-id={exchangeId}>
    {displayedLegs.map((leg, index) => {
      const incoming = leg.targetId === sessionId && leg.sourceId !== sessionId
      const sourceTitle = participantTitle(leg.sourceId, leg.sourceTitle || t('timeline.ui.otherAgent'))
      const targetTitle = participantTitle(leg.targetId, leg.targetTitle || t('timeline.ui.otherAgent'))
      const actionMessage = actionLeg?.id === leg.id
      const currentLeg = !terminalStatus && actionMessage
      const queuedMessage = queuedActionLeg?.id === leg.id
      const queuedMessageRemoved = queuedMessage && Boolean(skippedQueuedId) && skippedQueuedId === leg.queuedId
      const queuedMessageStarting = queuedMessage && deliveryPromoted && !queuedMessageRemoved
      const mayHaveMoreBody = crossChatLegMayHaveMoreBody(leg) || !leg.body && !leg.preview
      const longBody = crossChatLegBodyIsLong(leg)
      const expanded = messageExpansion[leg.id] ?? !longBody
      const text = expanded ? leg.body || leg.preview : crossChatLegCollapsedText(leg)
      const cancelQueuedMessage = queuedMessage && !queuedMessageRemoved
        ? queuedDelivery?.id === leg.id && canSkipQueuedDelivery ? skipQueuedDelivery : canCancel ? cancelExchange : null
        : null
      return <article key={leg.id}
        className={`cross-chat-message ${incoming ? 'incoming' : 'outgoing'}${leg.status === 'failed' ? ' failed' : ''}`}
        data-exchange-leg-id={leg.id} data-message-number={leg.ordinal || index + 1}
      >
        <div className="cross-chat-message-surface">
          <header>
            <MessageSquareShare size={13} aria-hidden="true" />
            <strong>{incoming ? sourceTitle : t('timeline.handoff.sent', { title: targetTitle })}</strong>
            {leg.ts && <time>{formatTime(item.anchorTs || leg.ts)}</time>}
          </header>
          {text ? <MarkdownContent text={text} sessionId={sessionId} fold={false} />
            : <small>{t('timeline.ui.messageBodyAvailableOnDemand')}</small>}
          {(mayHaveMoreBody || longBody) && <button type="button" className="cross-chat-message-expand"
            aria-expanded={!mayHaveMoreBody && expanded} disabled={mayHaveMoreBody && loading}
            onClick={() => setLegBodyExpanded(leg, mayHaveMoreBody || !expanded)}
          >{mayHaveMoreBody && loading ? t('timeline.ui.loadingFullMessage') : mayHaveMoreBody || !expanded ? t('timeline.ui.viewMessage') : t('timeline.ui.showLess')}</button>}
          {(leg.status === 'failed' || actionMessage && failed) && <small className="cross-chat-message-error" role="alert">{failureSummary}</small>}
          {actionMessage && <small className="cross-chat-exchange-state" role="status"
            title={!terminalStatus ? t('timeline.exchange.statusScope') : undefined} aria-description={!terminalStatus ? t('timeline.exchange.statusScope') : undefined}>
            {queuedMessageRemoved ? t('timeline.exchange.queuedMessageRemoved') : queuedMessageStarting ? t('timeline.status.starting') : stateLabel}
          </small>}
          {cancelQueuedMessage && <button type="button" className="cross-chat-message-expand"
            aria-label={t('mergeTimeline.cancelQueuedMessage')} disabled={skippingDelivery || cancelling}
            onClick={() => void cancelQueuedMessage()}
          >{skippingDelivery || cancelling ? t('timeline.ui.cancelling') : t('mergeTimeline.cancel')}</button>}
          {currentLeg && !queuedActionLeg && canCancel && <button type="button" className="cross-chat-message-expand"
            title={t('mergeTimeline.cancelQueuedAndRunning')} disabled={cancelling} onClick={() => void cancelExchange()}
          >{cancelling ? t('timeline.ui.ending') : t('timeline.ui.endConversation')}</button>}
          {loadError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotLoadFullMessage')} {loadError}</small>}
          {currentLeg && cancelError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotEndTheConversation')} {cancelError}</small>}
          {currentLeg && skipError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotRemoveTheQueuedMessage')} {skipError}</small>}
        </div>
      </article>
    })}
    {!displayedLegs.length && <div className="cross-chat-message outgoing">
      <div className="cross-chat-message-surface">
        <header><MessageSquareShare size={13} aria-hidden="true" /><strong>{counterpartTitle}</strong><time>{formatTime(event.ts)}</time></header>
        <small>{stateLabel}</small>
        <button type="button" className="cross-chat-message-expand" disabled={loading} onClick={() => void loadExchange()}>{loading ? t('timeline.ui.loadingMessages') : t('timeline.ui.viewMessage')}</button>
        {canCancel && <button type="button" className="cross-chat-message-expand" disabled={cancelling} onClick={() => void cancelExchange()}>{t('timeline.ui.endConversation')}</button>}
        {loadError && <small className="cross-chat-message-error" role="alert">{loadError}</small>}
      </div>
    </div>}
  </div>
}

function CrossChatView({ item, sessionId }: { item: SystemItem; sessionId: string }) {
  useLocale()
  const event = item.event
  const envelopeId = event.handoff_id?.trim() || event.correlation_id?.trim() || ''
  const sourceId = event.source_session_id?.trim() || ''
  const targetId = event.target_session_id?.trim() || ''
  const counterpartId = sourceId === sessionId ? targetId : sourceId || targetId
  const knownTitle = useAppStore(state => state.sessions.find(session => session.id === counterpartId)?.title)
  const counterpartTitle = knownTitle
    || (sourceId === sessionId ? event.target_title : event.source_title)
    || t('timeline.ui.anotherChat')
  const workspaceRevision = useAppStore(state => {
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
    const visible = state.selectedSessionId === sessionId
      || state.chatPanes.primary === sessionId
      || state.chatPanes.secondary === sessionId
    return JSON.stringify([
      state.activeProfileId, state.profileGeneration, profile?.serverIdentity ?? null,
      state.connected, state.connectionGeneration, state.health?.server_instance_id ?? null, visible
    ])
  })
  const [cancelled, setCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const displayEvent = cancelled ? { ...event, handoff_status: 'cancelled' } : event
  const status = String(displayEvent.handoff_status || displayEvent.status || displayEvent.type).toLocaleLowerCase()
  const failed = isTimelineError(event) || /failed|error/u.test(status)
  const title = crossChatTitle(displayEvent, counterpartTitle, sessionId)
  const detail = messageText(event).trim()
  const preview = event.handoff_preview?.trim() || ''
  const truncated = event.handoff_body_truncated === true
  const [body, setBody] = useState(truncated ? '' : preview)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const bodyRequest = useRef(0)
  const cancelRequest = useRef(0)
  useEffect(() => {
    bodyRequest.current += 1
    cancelRequest.current += 1
    setCancelled(false)
    setCancelling(false)
    setCancelError('')
    setBody(truncated ? '' : preview)
    setBodyLoading(false)
    setBodyError('')
  }, [envelopeId, event.seq, preview, sessionId, truncated, workspaceRevision])
  const loadBody = async () => {
    if (!truncated || body || bodyLoading || !envelopeId) return
    const request = ++bodyRequest.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    setBodyLoading(true)
    setBodyError('')
    try {
      const handoff = await window.agentsDock.handoffs.get(envelopeId)
      if (request !== bodyRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (handoff.id !== envelopeId) throw new Error(t('timeline.ui.agentsServerReturnedTheWrongHandoff'))
      if (handoff.source_session_id !== sessionId && handoff.target_session_id !== sessionId) {
        throw new Error(t('timeline.ui.thisChatIsNotAParticipantInTheHandoff'))
      }
      setBody(handoff.body)
    } catch (error) {
      if (request === bodyRequest.current && timelineWorkspaceScopeCurrent(scope)) setBodyError(timelineActionError(error))
    } finally {
      if (request === bodyRequest.current && timelineWorkspaceScopeCurrent(scope)) setBodyLoading(false)
    }
  }
  const cancelHandoff = async () => {
    if (!envelopeId || cancelling) return
    const request = ++cancelRequest.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    setCancelling(true)
    setCancelError('')
    try {
      const response = await window.agentsDock.handoffs.cancel(envelopeId)
      if (request !== cancelRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (response.id !== envelopeId) throw new Error(t('timeline.ui.agentsServerReturnedTheWrongHandoff'))
      if (response.source_session_id !== sessionId && response.target_session_id !== sessionId) {
        throw new Error(t('timeline.ui.thisChatIsNotAParticipantInTheHandoff'))
      }
      setCancelled(true)
    } catch (error) {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) setCancelError(timelineActionError(error))
    } finally {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) setCancelling(false)
    }
  }
  const canCancel = sourceId === sessionId && /queued|deferred/u.test(status) && Boolean(envelopeId)
  const incoming = targetId === sessionId && sourceId !== sessionId
  return <article className={`cross-chat-message ${incoming ? 'incoming' : 'outgoing'}${failed ? ' failed' : ''}`} data-event-id={event.id}>
    <div className="cross-chat-message-surface">
      <header><MessageSquareShare size={13} aria-hidden="true" /><strong>{incoming ? counterpartTitle : t('timeline.handoff.sent', { title: counterpartTitle })}</strong><time>{formatTime(item.anchorTs || event.ts)}</time></header>
      {body || preview ? <MarkdownContent text={body || preview} sessionId={sessionId} fold={false} /> : <small>{detail || title}</small>}
      {truncated && !body && <button type="button" className="cross-chat-message-expand" disabled={bodyLoading} onClick={() => void loadBody()}>{bodyLoading ? t('timeline.ui.loadingFullMessage') : t('timeline.ui.viewMessage')}</button>}
      {failed && preview && <small className="cross-chat-message-error">{detail || title}</small>}
      {cancelled && <small>{t('timeline.status.cancelled')}</small>}
      {bodyError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotLoadFullMessage')} {bodyError}</small>}
      {cancelError && <small className="cross-chat-message-error" role="alert">{t('timeline.ui.couldNotCancelHandoff')} {cancelError}</small>}
      {canCancel && <button type="button" className="cross-chat-message-expand" disabled={cancelling} onClick={() => void cancelHandoff()}>{cancelling ? t('timeline.ui.cancelling') : t('timeline.ui.cancelHandoff')}</button>}
    </div>
  </article>
}

function crossChatAuthorizationLabel(kind: Event['handoff_authorization_kind'] | Event['exchange_authorization_kind']): string | null {
  if (kind === 'configured_route') return t('timeline.ui.agentAuthoredSameServerAccess')
  if (kind === 'explicit_prompt') return t('timeline.ui.userAddressed')
  return null
}

function crossChatTitle(event: Event, counterpartTitle: string, currentSessionId: string): string {
  const status = String(event.handoff_status || event.status || event.type).toLocaleLowerCase()
  const source = event.source_session_id?.trim() || ''
  const incoming = Boolean(source && source !== currentSessionId)
  const payload = event.handoff_action === 'final_result' ? t('timeline.ui.result') : t('timeline.ui.instruction')
  const params = { payload, title: counterpartTitle }
  if (/failed|error/u.test(status)) return t(incoming ? 'timeline.handoff.incomingFailed' : 'timeline.handoff.deliveryFailed', params)
  if (/cancel/u.test(status)) return t(incoming ? 'timeline.handoff.incomingCancelled' : 'timeline.handoff.cancelled', params)
  if (/repl/u.test(status)) return t('timeline.handoff.reply', params)
  if (/running|started/u.test(status)) return t(incoming ? 'timeline.handoff.workingIncoming' : 'timeline.handoff.working', { ...params, payload: payload.toLocaleLowerCase() })
  if (/queued|deferred/u.test(status)) return t(incoming ? 'timeline.handoff.incomingQueued' : 'timeline.handoff.queued', params)
  if (/completed|finished|sent|delivered/u.test(status)) return t(incoming ? 'timeline.handoff.incomingCompleted' : 'timeline.handoff.sent', params)
  if (event.handoff_action === 'final_result') return t('timeline.handoff.resultOnCompletion', params)
  if (event.type.startsWith('cross_chat_watch_')) return t('timeline.handoff.watching', params)
  return t(incoming ? 'timeline.handoff.incoming' : 'timeline.handoff.sending', { ...params, payload: incoming ? payload : payload.toLocaleLowerCase() })
}

function CodexLifecycleView({ item, sessionId, active }: { item: SystemItem; sessionId: string; active: boolean }) {
  useLocale()
  const event = item.event
  const error = isTimelineError(event) || codexLifecycleFailed(event)
  const liveCompaction = active && event.type === 'codex_compaction_started'
  const title = codexLifecycleTitle(event, liveCompaction)
  const detail = codexLifecycleDetail(event)
  const icon = error
    ? <AlertTriangle size={13} />
    : liveCompaction
      ? <LoaderCircle className="spin" size={13} />
      : <Sparkles size={13} />
  const summary = <><span className="system-icon">{icon}</span><strong>{title}</strong><time>{formatTime(item.anchorTs || event.ts)}</time></>
  if (!detail) {
    return <article className={`system-row codex-lifecycle ${error ? 'error' : ''}`} data-event-id={event.id}>
      <div className="codex-lifecycle-summary">{summary}</div>
    </article>
  }
  return <details className={`system-row codex-lifecycle ${error ? 'error' : ''}`} data-event-id={event.id}>
    <summary>{summary}</summary>
    <div className="codex-lifecycle-detail"><MarkdownContent text={detail} sessionId={sessionId} compact fold={false} /></div>
  </details>
}

function codexLifecycleTitle(event: Event, liveCompaction = false): string {
  if (event.type === 'codex_goal_budget_limited') return t('timeline.ui.goalBudgetReached')
  if (event.type === 'codex_compaction_started') return liveCompaction ? t('timeline.ui.compactingContext') : t('timeline.ui.contextCompactionStarted')
  if (event.type === 'codex_compaction_completed') return codexLifecycleFailed(event) ? t('timeline.ui.contextCompactionFailed') : t('timeline.ui.contextCompacted')
  return titleCase(event.type)
}

function codexLifecycleFailed(event: Event): boolean {
  if (isTimelineError(event)) return true
  return event.type === 'codex_compaction_completed'
    && typeof event.status === 'string'
    && event.status !== 'completed'
}

function codexLifecycleDetail(event: Event): string {
  const message = messageText(event).trim()
  if (message) return message
  return ''
}

function digestStatusTitle(event: Event): string {
  if (event.type === 'handoff_digest_received') return t('timeline.ui.contextDigest')
  if (event.type.endsWith('_sent')) return t('timeline.ui.digestSent')
  if (event.type.endsWith('_error')) return t('timeline.ui.digestFailed')
  return t('timeline.ui.creatingDigest')
}

function digestStatusText(event: Event): string {
  if (event.type === 'handoff_digest_received' || event.type.endsWith('_sent') || event.type.endsWith('_error')) {
    return messageText(event) || (event.type.endsWith('_sent') ? t('timeline.ui.contextDigestCreatedAndSent') : t('timeline.ui.contextDigestGenerationFailed'))
  }
  return t('timeline.ui.creatingAContextDigestFromThisChatAndSendingItToTheTarget')
}

function JobView({ item, sessionId, profileScope, pinnedItemIds }: { item: JobItem; sessionId: string; profileScope: WorkspaceProfileScope | null; pinnedItemIds: ReadonlySet<string> }) {
  useLocale()
  const selection = useMemo(() => jobDisplaySelection(item), [item])
  const { latest, latestSource, previous, updates } = selection
  const presentation = useMemo(() => jobResultPresentation(latest), [latest])
  const latestStatusSource = item.latestStatus ?? latest
  const latestStatus = useMemo(
    () => jobRunStatus(
      latestStatusSource,
      latestStatusSource.id === latest.id ? presentation : undefined
    ),
    [getLocale(), latestStatusSource, presentation]
  )
  const [showStructuredDetail, setShowStructuredDetail] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [loadedHistory, setLoadedHistory] = useState<Event[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historySupported, setHistorySupported] = useState<boolean | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyNextBefore, setHistoryNextBefore] = useState<number | null>(null)
  const historyGeneration = useRef(0)
  const structuredDetailId = `job-result-detail-${latest.id}`
  // Status-only scheduler notices are not executions. The projector derives
  // this count from distinct run IDs or the server's durable run_count, so a
  // bundle of runless busy/deferred notices must not become dozens of runs.
  const runCount = item.runCount
  const statusSpecificRunId = String(
    latestStatusSource.job_status_run_id
    || latestStatusSource.job_latest_status_run_id
    || latestStatusSource.run_id
    || ''
  ).trim()
  const displayedRunId = String(latestSource.run_id || '').trim()
  // job_latest_run_id is the newest actual execution, not necessarily the run
  // that produced the current scheduler status. A runless deferral commonly
  // carries that previous ID in its semantic summary.
  const statusRunId = latestStatus.label === t('timeline.ui.deferred')
    ? statusSpecificRunId
    : statusSpecificRunId || String(latestStatusSource.job_latest_run_id || '').trim()
  const excludedRunIds = useMemo(
    () => new Set([statusRunId, displayedRunId].filter(Boolean)),
    [displayedRunId, statusRunId]
  )
  const excludedRunAttempts = useMemo(() => {
    const attempts = new Map<string, Set<number>>()
    const add = (runId: string, seq: number) => {
      if (!runId || seq <= 0) return
      const sequences = attempts.get(runId) ?? new Set<number>()
      sequences.add(seq)
      attempts.set(runId, sequences)
    }
    add(statusRunId, jobHistoryAttemptSeq(latestStatusSource))
    add(displayedRunId, jobHistoryAttemptSeq(latestSource))
    return attempts
  }, [displayedRunId, latestSource, latestStatusSource, statusRunId])
  const runlessDeferred = latestStatus.label === t('timeline.ui.deferred')
    && !statusSpecificRunId
    && !displayedRunId
  const currentRunlessStatusSeq = runlessDeferred
    ? Number(
        latestStatusSource.job_status_seq
        || latestStatusSource.job_latest_status_seq
        || latestSource.seq
        || 0
      )
    : 0
  const previousRunCount = Math.max(
    0,
    runCount - (runlessDeferred ? 0 : Math.max(1, excludedRunIds.size))
  )
  const jobId = useMemo(() => (
    item.jobId?.trim()
    || item.events.find(event => event.job_id)?.job_id?.trim()
    || item.id.replace(/^job:/, '').replace(/:segment:\d+$/, '').trim()
  ), [item.events, item.id, item.jobId])
  const timelineGroupId = item.timelineGroupId?.trim() || item.key
  const scheduleExists = useAppStore(state => state.jobs.some(job => (
    job.id === jobId && job.session_id === sessionId
  )))
  const bundledHistory = useMemo(() => [...previous].reverse().slice(0, 20), [previous])
  const history = useMemo(
    () => (
      historyLoaded && historySupported === true
        ? loadedHistory
        : mergeJobHistoryEvents(loadedHistory, bundledHistory)
    )
      .filter(event => {
        const runId = String(event.run_id || '').trim()
        if (runId && excludedRunAttempts.get(runId)?.has(jobHistoryAttemptSeq(event))) return false
        if (!runId && currentRunlessStatusSeq > 0 && event.seq === currentRunlessStatusSeq) return false
        return event.id !== latestSource.id
      }),
    [
      bundledHistory,
      currentRunlessStatusSeq,
      excludedRunAttempts,
      historyLoaded,
      historySupported,
      latestSource.id,
      loadedHistory
    ]
  )
  const traceRunId = statusRunId || (
    latestStatusSource.id === latestSource.id ? displayedRunId : ''
  )
  const latestRunTrace = useMemo(() => {
    if (!traceRunId) return []
    const traceSource = String(latestStatusSource.run_id || '').trim() === traceRunId
      ? latestStatusSource
      : { ...latestStatusSource, run_id: traceRunId }
    return mergeTraceEvents([traceSource], item.events.filter(event => (
      event.run_id === traceRunId
      && ['reasoning_summary', 'tool_started', 'tool_finished', 'code_diff'].includes(event.type)
    )))
  }, [item.events, latestStatusSource, traceRunId])
  const latestRunTraceAnchor = useMemo(() => {
    if (!traceRunId) return 0
    const runScoped = item.events.filter(event => event.run_id === traceRunId)
    return runScoped.length ? Math.max(...runScoped.map(event => event.seq)) : 0
  }, [item.events, traceRunId])
  const latestRunTraceResetKey = useMemo(() => {
    const occurrenceId = latestStatusSource.job_occurrence_id?.trim()
      || latestSource.job_occurrence_id?.trim()
      || ''
    const scheduledAt = latestStatusSource.job_scheduled_run_at
      ?? latestSource.job_scheduled_run_at
      ?? null
    const scheduledAtIso = latestStatusSource.job_scheduled_run_at_iso?.trim()
      || latestSource.job_scheduled_run_at_iso?.trim()
      || ''
    const occurrence = occurrenceId
      ? `occurrence:${occurrenceId}`
      : scheduledAt != null
        ? `scheduled:${scheduledAt}`
        : scheduledAtIso
          ? `scheduled-iso:${scheduledAtIso}`
          : `start:${latestStatusSource.job_start_seq || latestSource.job_start_seq || ''}`
    return `${timelineGroupId}:${occurrence}`
  }, [latestSource, latestStatusSource, timelineGroupId])
  const codeDiff = latestSource.run_id
    ? [...item.events].reverse().find(event => (
      event.session_id === sessionId
      && event.type === 'code_diff'
      && event.run_id === latestSource.run_id
    ))
    : undefined
  const files = deduplicateFiles(item.events
    .filter(event => latestSource.run_id
      ? event.run_id === latestSource.run_id
      : runlessDeferred ? event.id === latestSource.id : true)
    .flatMap(event => [event.artifact, event.file].filter((file): file is NonNullable<typeof file> => (
      Boolean(file) && agentFileBelongsToSession(file, sessionId)
    ))))
  const openReview = () => {
    if (!codeDiff?.run_id) return
    const target: CodeReviewTarget = {
      sessionId,
      runId: codeDiff.run_id,
      files: codeDiff.diff_files,
      additions: codeDiff.additions,
      deletions: codeDiff.deletions,
      repositoryRoot: codeDiff.repository_root
    }
    window.dispatchEvent(new CustomEvent<CodeReviewTarget>('agentsdock:review-diff', { detail: target }))
  }
  useEffect(() => {
    historyGeneration.current += 1
    setShowHistory(false)
    setLoadedHistory([])
    setHistoryLoaded(false)
    setHistorySupported(null)
    setHistoryLoading(false)
    setHistoryError(null)
    setHistoryHasMore(false)
    setHistoryNextBefore(null)
    return () => {
      historyGeneration.current += 1
    }
  }, [item.id, jobId, sessionId, timelineGroupId])
  const loadHistory = async (beforeSeq: number | null, replace: boolean) => {
    if (!jobId || historyLoading) return
    const generation = ++historyGeneration.current
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const page = await window.agentsDock.jobs.runs(
        sessionId,
        jobId,
        beforeSeq,
        20,
        timelineGroupId
      )
      if (generation !== historyGeneration.current) return
      // Legacy servers ignore unknown query parameters and return the job's
      // lifetime history. Do not let that silently leak runs across timeline
      // cards: only accept pages that echo the requested contiguous group.
      const groupSupported = page.supported && page.timeline_group_id === timelineGroupId
      setLoadedHistory(current => groupSupported
        ? (replace ? page.runs : mergeJobHistoryEvents(current, page.runs))
        : (replace ? [] : current))
      setHistoryLoaded(true)
      setHistorySupported(groupSupported)
      setHistoryHasMore(groupSupported && page.has_more)
      setHistoryNextBefore(groupSupported ? page.next_before : null)
    } catch (cause) {
      if (generation !== historyGeneration.current) return
      setHistoryLoaded(true)
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === historyGeneration.current) setHistoryLoading(false)
    }
  }
  const toggleHistory = () => {
    const next = !showHistory
    setShowHistory(next)
    if (next && !historyLoaded) void loadHistory(item.endSeq + 1, true)
  }
  return <article className={`job-row${scheduleExists ? '' : ' historical'}`} data-job-state={scheduleExists ? 'scheduled' : 'historical'}>
    <header className="job-summary">{scheduleExists ? <Clock3 size={15} /> : <History size={15} />}<span><strong>{t('timeline.ui.scheduledJob')}</strong><small>{item.title} · {scheduleExists ? '' : t('timeline.job.historical')}{timelineCount('runs', runCount)} · {formatTime(latestStatusSource.ts || latest.ts)}</small></span><b className={`job-status-pill ${latestStatus.tone}`}>{latestStatus.label}</b></header>
    <div className="job-latest">
      {presentation.structured ? <>
        <div className="job-result-preview">{presentation.preview}</div>
        <button className="job-detail-toggle" aria-expanded={showStructuredDetail} aria-controls={structuredDetailId} onClick={() => setShowStructuredDetail(value => !value)}><ChevronRight size={13} />{showStructuredDetail ? t('timeline.ui.hideDetails') : t('timeline.ui.showDetails')}</button>
        {showStructuredDetail && <pre id={structuredDetailId} className="job-structured-detail">{presentation.detail}</pre>}
      </> : <MarkdownContent text={presentation.detail} files={files} sessionId={sessionId} fold={false} />}
      {files.length > 0 && <MediaGrid files={files} sessionId={sessionId} profileScope={profileScope} compact pinnedItemIds={pinnedItemIds} />}
      {(codeDiff?.files_changed ?? codeDiff?.diff_files?.length ?? 0) > 0 ? <CodeChangesCard fileCount={codeDiff?.files_changed ?? codeDiff?.diff_files?.length ?? 0} additions={codeDiff?.additions ?? 0} deletions={codeDiff?.deletions ?? 0} onOpen={openReview} /> : null}
      {traceRunId && <div className="job-run-trace"><TraceDisclosure events={latestRunTrace} sessionId={sessionId} anchorSeq={latestRunTraceAnchor} resetKey={latestRunTraceResetKey} includeCommentary /></div>}
    </div>
    {previousRunCount > 0 && <div className="job-history">
      <button type="button" className="job-history-toggle" aria-label={t('timeline.job.previousRuns', { count: previousRunCount })} aria-expanded={showHistory} onClick={toggleHistory}>
        <ChevronRight size={13} />
        <span>{t('timeline.ui.previousRuns')}</span>
        <small>{previousRunCount.toLocaleString()}</small>
      </button>
      {showHistory && <div className="job-history-body">
        {history.map(event => <JobHistoryRun key={event.run_id || event.id} event={event} sessionId={sessionId} />)}
        {historyLoading && <div className="job-history-status"><LoaderCircle className="spin" size={12} />  {t('timeline.ui.loadingRunHistory')}</div>}
        {!historyLoading && historyError && <div className="job-history-status error"><AlertTriangle size={12} /> <span>{historyError}</span><button type="button" onClick={() => void loadHistory(historyNextBefore, loadedHistory.length === 0)}>{t('timeline.ui.retry')}</button></div>}
        {!historyLoading && historySupported === false && previousRunCount > history.length && <div className="job-history-status">{t(history.length === 1 ? 'timeline.job.bundledHistory.one' : 'timeline.job.bundledHistory.other', { count: history.length, total: previousRunCount.toLocaleString(getLocale()) })}</div>}
        {!historyLoading && historySupported !== false && historyHasMore && historyNextBefore != null && <button type="button" className="job-history-more" onClick={() => void loadHistory(historyNextBefore, false)}>{t('timeline.ui.loadOlderRuns')}</button>}
        {!historyLoading && !historyError && history.length === 0 && <div className="job-history-status">{t('timeline.ui.noPriorRunOutputWasReturned')}</div>}
      </div>}
    </div>}
  </article>
}

function JobHistoryRun({ event, sessionId }: { event: Event; sessionId: string }) {
  useLocale()
  const presentation = useMemo(() => jobResultPresentation(event), [event])
  const status = useMemo(() => jobRunStatus(event, presentation), [getLocale(), event, presentation])
  const [open, setOpen] = useState(false)
  return <details className="job-history-run" onToggle={toggle => setOpen(toggle.currentTarget.open)}>
    <summary>
      <time>{formatTime(event.ts)}</time>
      <span>{presentation.preview}</span>
      <b className={`job-status-pill ${status.tone}`}>{status.label}</b>
      <ChevronRight size={12} />
    </summary>
    {open && <div className="job-history-run-body">
      {presentation.structured
        ? <pre>{presentation.detail}</pre>
        : <div className="job-history-markdown"><MarkdownContent text={presentation.detail} sessionId={sessionId} fold={false} /></div>}
      {event.run_id && <div className="job-run-trace"><TraceDisclosure events={[event]} sessionId={sessionId} resetKey={event.job_occurrence_id?.trim() || event.id} includeCommentary /></div>}
    </div>}
  </details>
}

function mergeJobHistoryEvents(...groups: Event[][]): Event[] {
  const byRun = new Map<string, Event>()
  for (const event of groups.flat()) {
    // Current servers expose one stable `job_run:*` ID per occurrence. Keep
    // that identity because providers are allowed to recycle raw run IDs.
    const key = event.id.startsWith('job_run:')
      ? event.id
      : event.run_id?.trim() || event.id
    const current = byRun.get(key)
    if (!current || event.seq > current.seq) byRun.set(key, event)
  }
  return [...byRun.values()].sort((left, right) => right.seq - left.seq)
}

function jobHistoryAttemptSeq(event: Event): number {
  return Math.max(
    event.seq,
    Number(event.job_run_status_seq || 0),
    Number(event.job_status_seq || 0),
    Number(event.job_latest_status_seq || 0)
  )
}

function jobRunStatus(event: Event, presentation?: ReturnType<typeof jobResultPresentation>): { label: string; tone: string } {
  const eventStatus = typeof event.status === 'string' ? event.status.trim() : ''
  const status = (
    event.job_status
    || event.job_latest_status
    || event.job_run_status
    || eventStatus
  ).toLowerCase()
  if (isTimelineError(event) || event.type === 'job_error' || ['failed', 'error'].includes(status)) {
    return { label: t('timeline.ui.failed'), tone: 'error' }
  }
  if (event.type === 'turn_stopped' || event.stopped === true || ['stopped', 'cancelled', 'canceled'].includes(status)) {
    return { label: t('timeline.ui.cancelled'), tone: 'stopped' }
  }
  if (['deferred'].includes(status) || event.type === 'job_deferred') return { label: t('timeline.ui.deferred'), tone: 'queued' }
  if (['running', 'active', 'started'].includes(status) || event.type === 'turn_started' || event.type === 'job_started' || event.type === 'job_ran') {
    return { label: t('timeline.ui.running'), tone: 'running' }
  }
  if (['queued', 'pending'].includes(status)) return { label: t('timeline.ui.queued'), tone: 'queued' }
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status) || event.type === 'turn_finished' || event.type === 'job_finished') {
    return { label: t('timeline.ui.completed'), tone: 'completed' }
  }
  if (presentation?.structured) {
    try {
      const parsed = JSON.parse(presentation.detail) as Record<string, unknown>
      const structuredStatus = String(parsed.status || parsed.queue_status || '').trim().toLowerCase()
      if (['failed', 'error'].includes(structuredStatus)) return { label: t('timeline.ui.failed'), tone: 'error' }
      if (['stopped', 'cancelled', 'canceled'].includes(structuredStatus)) return { label: t('timeline.ui.cancelled'), tone: 'stopped' }
      if (structuredStatus === 'deferred') return { label: t('timeline.ui.deferred'), tone: 'queued' }
      if (['running', 'active', 'started'].includes(structuredStatus)) return { label: t('timeline.ui.running'), tone: 'running' }
      if (['queued', 'pending'].includes(structuredStatus)) return { label: t('timeline.ui.queued'), tone: 'queued' }
      if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(structuredStatus)) return { label: t('timeline.ui.completed'), tone: 'completed' }
    } catch { /* presentation detail is best-effort UI data */ }
  }
  return { label: t('timeline.ui.updated'), tone: 'updated' }
}

function CodeChangesCard({ fileCount, additions, deletions, onOpen }: { fileCount: number; additions: number; deletions: number; onOpen: () => void }) {
  useLocale()
  return <button className="changes-card" onClick={onOpen}><FileText size={17} /><span><strong>{timelineCount('editedFiles', fileCount)}</strong><small><b>+{additions}</b> <i>-{deletions}</i></small></span><span className="review-label">{t('timeline.ui.review')}</span></button>
}

function deduplicateFiles<T extends { id: string }>(files: T[]): T[] {
  return [...new Map(files.map(file => [file.id, file])).values()]
}

async function toggleSystemPin(event: Event, sessionId: string, profileScope: WorkspaceProfileScope | null, pinned: boolean, title = titleCase(event.type), body = messageText(event)) {
  if (pinned) {
    await window.agentsDock.pins.remove(requirePinnedItemsScope(profileScope), sessionId, `message:${event.id}`)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
    return
  }
  await window.agentsDock.pins.put(requirePinnedItemsScope(profileScope), { id: `message:${event.id}`, sessionId, kind: 'message', eventId: event.id, title, body, subtitle: formatTime(event.ts), createdAt: Date.now() })
  window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
}

function toolHeadline(event?: Event): string {
  if (!event) return ''
  const command = event.tool?.input && typeof event.tool.input === 'object' && !Array.isArray(event.tool.input) && 'command' in event.tool.input ? String(event.tool.input.command) : ''
  return command || event.tool?.name || ''
}
