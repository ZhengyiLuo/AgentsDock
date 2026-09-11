import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock3, Code2, Copy, History, Pin, Siren, Sparkles, Wrench } from 'lucide-react-native'
import type { ChatReference, Event } from '../types'
import type { TimelineRow } from '../lib/timeline'
import {
  activeTraceProgressPreview,
  codexLifecycleSemanticKey,
  isHandoffDigestEvent,
  isTimelineError,
  jobDisplaySelection,
  jobResultPresentation,
  jobRunCount,
  jobRunIdentity,
  jobRunStatus,
  latestJobStatusEvent,
  mergeJobHistoryEvents,
  providerInteractionAuditSummary,
  rowText,
} from '../lib/timeline'
import { formatDateTime, messageText } from '../lib/format'
import { canQueryScheduledJobHistory } from '../lib/job-history'
import { registerCodeReviewFallback, reviewFallbackForEvents, summarizeStructuredToolDiff } from '../lib/code-review'
import { foldMarkdownSource } from '../lib/math'
import {
  inlineRoutePresentation,
  timelineChatReferenceIsRemote,
  timelineChatReferenceKey,
  timelineInlineReferencesForText,
} from '../lib/timeline-inline-references'
import {
  boundLoadedTraceEvents,
  boundedTraceText,
  reasoningTraceHeadline,
  reasoningTracePreview,
  selectTraceDetailRenderEvents,
  toolTraceHeadline,
} from '../lib/trace-detail'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { ChatReferenceChips, CrossChatExchangeCard, CrossChatHandoffCard } from './CrossChatTimelineCards'
import { ImportedCrossChatDeliveryCard } from './ImportedCrossChatDeliveryCard'
import { IconButton } from './ui'
import { MarkdownContent } from './MarkdownContent'
import { MediaGrid } from './MediaGrid'

// Keep the default recycled Markdown/UITextView tree bounded. Full text stays
// available on demand, while ordinary scrolling parses at most this preview.
const MESSAGE_PREVIEW_CHARACTER_LIMIT = 3_200
const TRACE_EVENT_LIMIT = 40

export const TimelineRowView = memo(function TimelineRowView({ row, sessionId, onReview, fontScale, layoutWidth }: { row: TimelineRow; sessionId: string; onReview: (runId: string) => void; fontScale: number; layoutWidth: number }) {
  // layoutWidth deliberately participates in memo equality so recycled cells
  // are remeasured when the device rotates or an iPad split view changes size.
  void layoutWidth
  if (row.kind === 'message') return <MessageRowView row={row} sessionId={sessionId} fontScale={fontScale} />
  if (row.kind === 'trace') return <TraceRowView row={row} sessionId={sessionId} onReview={onReview} fontScale={fontScale} />
  if (row.kind === 'progress') return <ProgressRowView row={row} fontScale={fontScale} />
  if (row.kind === 'media') return <MediaRowView row={row} sessionId={sessionId} />
  if (row.kind === 'job') return <JobRowView row={row} sessionId={sessionId} onReview={onReview} fontScale={fontScale} />
  if (row.importedDelivery) return <ImportedCrossChatDeliveryCard row={row} fontScale={fontScale} />
  if (codexLifecycleSemanticKey(row.event)) return <CodexLifecycleRowView row={row} fontScale={fontScale} />
  if (row.key.startsWith('provider-interaction-audit:')) return <ProviderInteractionAuditView row={row} />
  const exchangeId = row.event.exchange_id?.trim() || row.event.cross_chat_exchange_id?.trim()
  if (row.event.type.startsWith('cross_chat_exchange_') && exchangeId) return <CrossChatExchangeCard event={row.event} events={row.events} rowKey={row.key} sessionId={sessionId} fontScale={fontScale} />
  if (row.event.type.startsWith('cross_chat_')) return <CrossChatHandoffCard event={row.event} rowKey={row.key} sessionId={sessionId} />
  if (row.event.type === 'emergency_alert_raised') return <EmergencyAlertView event={row.event} sessionId={sessionId} />
  return <SystemRowView row={row} fontScale={fontScale} />
})

function EmergencyAlertView({ event, sessionId }: { event: Event; sessionId: string }) {
  const colors = usePalette()
  const renderedEventId = useRef(event.id)
  renderedEventId.current = event.id
  const session = useAppStore(state => state.snapshots[sessionId]?.session ?? state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const eventAlertId = event.emergency_alert_id?.trim() || event.emergency_alert?.id?.trim() || ''
  const activeAlert = session?.emergency_alert?.status === 'active' ? session.emergency_alert : null
  const acknowledgeable = Boolean(eventAlertId && activeAlert?.id === eventAlertId)
  const [busy, setBusy] = useRecyclingState(false, [event.id])
  const [failed, setFailed] = useRecyclingState(false, [event.id])
  const acknowledge = async () => {
    if (!acknowledgeable || busy) return
    setBusy(true); setFailed(false)
    const ok = await useAppStore.getState().acknowledgeEmergency(sessionId, eventAlertId)
    if (renderedEventId.current !== event.id) return
    setFailed(!ok); setBusy(false)
  }
  return <View style={[styles.system, { backgroundColor: `${colors.red}18`, borderColor: colors.red }]}>
    <Siren size={16} color={colors.red} />
    <View style={{ flex: 1, gap: 5 }}><Text style={[styles.systemTitle, { color: colors.red }]}>Emergency alert raised</Text><Text selectable style={[styles.systemText, { color: colors.text }]}>{event.message || event.emergency_alert?.message || 'The agent requested immediate attention.'}</Text>{failed ? <Text accessibilityRole="alert" style={{ color: colors.red, fontSize: 11 }}>Couldn’t acknowledge. Try again.</Text> : null}{acknowledgeable ? <Pressable accessibilityRole="button" accessibilityLabel={`Acknowledge emergency${session?.title ? ` in ${session.title}` : ''}`} disabled={busy} onPress={() => void acknowledge()} style={[styles.emergencyAcknowledge, { backgroundColor: colors.red, opacity: busy ? 0.5 : 1 }]}>{busy ? <ActivityIndicator size="small" color="white" /> : <Text style={{ color: 'white', fontWeight: '800', fontSize: 11 }}>Acknowledge</Text>}</Pressable> : null}</View>
  </View>
}

function MessageRowView({ row, sessionId, fontScale }: { row: Extract<TimelineRow, { kind: 'message' }>; sessionId: string; fontScale: number }) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const pin = useAppStore(state => state.pinMessage)
  const removePin = useAppStore(state => state.removePin)
  const pinned = useAppStore(state => state.pins.some(value => value.id === `message:${row.events.at(-1)?.id}`))
  const full = useMemo(() => rowText(row), [row])
  const chatReferences = useMemo(
    () => row.role === 'user'
      ? [...new Map(row.events.flatMap(part => part.chat_references ?? []).map(reference => [
        timelineChatReferenceKey(reference),
        reference,
      ])).values()].filter(reference => (
        reference.action !== 'route'
        && !(timelineChatReferenceIsRemote(reference) && reference.action === 'instruction')
      ))
      : [],
    [row.events, row.role],
  )
  const inlineRoutes = useMemo(
    () => row.role === 'user' ? inlineRoutePresentation(row.events) : null,
    [row.events, row.role],
  )
  const fold = useMemo(() => foldMarkdownSource(full, MESSAGE_PREVIEW_CHARACTER_LIMIT), [full])
  const [expanded, setExpanded] = useRecyclingState(false, [row.key])
  const [feedback, setFeedback] = useRecyclingState<'Copied' | 'Pinned' | 'Unpinned' | 'Copy failed' | 'Pin failed' | null>(null, [row.key])
  const folded = fold.folded && !expanded
  const visible = folded ? `${fold.visible.trimEnd()}\n\n…` : full
  const visibleInlineRoutes = useMemo(
    () => inlineRoutes
      ? timelineInlineReferencesForText(visible, inlineRoutes.references, sessionId)
      : [],
    [inlineRoutes, sessionId, visible],
  )
  const fallbackRoutes = useMemo(() => {
    if (!inlineRoutes) return []
    const visibleKeys = new Set(visibleInlineRoutes.map(timelineChatReferenceKey))
    return [...new Map([
      ...inlineRoutes.fallbackReferences,
      ...inlineRoutes.references.filter(reference => !visibleKeys.has(timelineChatReferenceKey(reference))),
    ].map(reference => [timelineChatReferenceKey(reference), reference])).values()]
  }, [inlineRoutes, visibleInlineRoutes])
  const displayedChatReferences = useMemo(
    () => [...new Map([...chatReferences, ...fallbackRoutes].map(reference => [
      timelineChatReferenceKey(reference),
      reference,
    ])).values()],
    [chatReferences, fallbackRoutes],
  )
  const readOnlyReferenceKeys = useMemo(
    () => new Set(fallbackRoutes.map(timelineChatReferenceKey)),
    [fallbackRoutes],
  )
  const openRoute = useCallback(
    (reference: ChatReference) => openInlineRoute(reference, sessionId, activeProfileId, profileGeneration),
    [activeProfileId, profileGeneration, sessionId],
  )
  const event = row.events.at(-1)!
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), 1_500)
    return () => clearTimeout(timer)
  }, [feedback])
  const copyFullText = async () => {
    try {
      await Clipboard.setStringAsync(full)
      setFeedback('Copied')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      void AccessibilityInfo.announceForAccessibility('Copied full message')
    } catch {
      setFeedback('Copy failed')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
    }
  }
  const togglePin = async () => {
    const before = useAppStore.getState()
    if (before.activeProfileId !== activeProfileId || before.profileGeneration !== profileGeneration || before.selectedSessionId !== sessionId || before.workspaceAdopting) return
    const next = pinned ? 'Unpinned' : 'Pinned'
    const saved = pinned
      ? await removePin(`message:${event.id}`, profileGeneration)
      : await pin(sessionId, event, full, profileGeneration)
    const after = useAppStore.getState()
    if (after.activeProfileId !== activeProfileId || after.profileGeneration !== profileGeneration || after.selectedSessionId !== sessionId) return
    setFeedback(saved ? next : 'Pin failed')
    void Haptics.notificationAsync(saved ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => undefined)
    if (saved) void AccessibilityInfo.announceForAccessibility(`${next} message`)
  }
  return (
    <View style={[styles.messageWrap, row.role === 'user' && styles.userAlign]}>
      <View style={[styles.message, row.role === 'user' ? { backgroundColor: colors.user, borderColor: colors.green } : { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.metaRow}>
          <Text style={[styles.author, { color: colors.muted }]} numberOfLines={1}>{row.role === 'user' ? 'You' : 'Assistant'}</Text>
          <Text style={[styles.time, { color: colors.muted }]} numberOfLines={1}>{formatDateTime(event.ts)}</Text>
          <View style={styles.metaSpacer} />
          {feedback ? <Text testID={`message-action-feedback-${event.id}`} style={[styles.feedback, { color: feedback.includes('failed') ? colors.red : colors.green }]} numberOfLines={1}>{feedback}</Text> : null}
          <IconButton testID={`message-pin-${event.id}`} icon={Pin} size={15} selected={pinned} label={pinned ? 'Unpin message' : 'Pin message'} onPress={() => void togglePin()} />
          <IconButton testID={`message-copy-${event.id}`} icon={feedback === 'Copied' ? Check : Copy} size={15} selected={feedback === 'Copied'} label="Copy full text" onPress={() => void copyFullText()} />
        </View>
        <MarkdownContent
          value={visible}
          fontScale={fontScale}
          inlineChatReferences={visibleInlineRoutes}
          sourceSessionId={sessionId}
          onChatReferencePress={openRoute}
        />
        {folded ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Show full message" onPress={() => setExpanded(true)} style={[styles.fold, { borderColor: colors.blue, backgroundColor: colors.raised }]}>
            <Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700' }}>{full.length - fold.cutIndex} characters hidden · Show full text</Text>
          </Pressable>
        ) : fold.folded ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Collapse message" onPress={() => setExpanded(false)} style={styles.collapse}><Text style={{ color: colors.muted, fontSize: 12 }}>Collapse</Text></Pressable>
        ) : null}
        {displayedChatReferences.length ? <ChatReferenceChips references={displayedChatReferences} sessionId={sessionId} readOnlyReferenceKeys={readOnlyReferenceKeys} /> : null}
        {row.files.length ? <MediaGrid files={row.files} sessionId={sessionId} ownerKey={row.key} /> : null}
      </View>
    </View>
  )
}

function openInlineRoute(reference: ChatReference, sessionId: string, profileId: string | null, profileGeneration: number): void {
  if (timelineChatReferenceIsRemote(reference)) return
  const state = useAppStore.getState()
  if (
    state.activeProfileId !== profileId
    || state.profileGeneration !== profileGeneration
    || state.selectedSessionId !== sessionId
    || state.workspaceAdopting
  ) return
  const target = state.sessions.find(candidate => candidate.id === reference.session_id)
  if (!target || target.archived) {
    useAppStore.setState({ error: 'The referenced chat is not available in this server workspace.' })
    return
  }
  void state.selectSession(reference.session_id, profileGeneration).catch(error => {
    const current = useAppStore.getState()
    if (current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) return
    useAppStore.setState({ error: error instanceof Error ? error.message : String(error) })
  })
}

function mergeTraceEvents(first: Event[], second: Event[]): Event[] {
  return [...new Map([...first, ...second].map(event => [event.id, event])).values()]
    .sort((left, right) => left.seq - right.seq)
}

function TraceRowView({ row, sessionId, onReview, fontScale, anchorSeq, includeCommentary = false }: { row: Extract<TimelineRow, { kind: 'trace' }>; sessionId: string; onReview: (runId: string) => void; fontScale: number; anchorSeq?: number; includeCommentary?: boolean }) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const loadRunTrace = useAppStore(state => state.loadRunTrace)
  const [open, setOpen] = useRecyclingState(false, [row.key])
  const [loadedEvents, setLoadedEvents] = useState<Event[] | null>(null)
  const [nextAfter, setNextAfter] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailLimited, setDetailLimited] = useState(false)
  const loadGeneration = useRef(0)
  const loadingMoreRef = useRef(false)
  const runId = useMemo(
    () => row.runId?.trim() || row.events.find(event => event.run_id?.trim())?.run_id?.trim() || null,
    [row.events, row.runId],
  )
  const traceAnchor = useMemo(
    // Anchor with the newest sampled event. A caller with no real occurrence
    // passes an empty sample and lets the API omit anchor_seq entirely.
    () => anchorSeq ?? (row.events.length ? Math.max(...row.events.map(event => event.seq)) : 0),
    [anchorSeq, row.events],
  )
  useEffect(() => {
    loadGeneration.current += 1
    setLoadedEvents(null)
    setNextAfter(0)
    setHasMore(true)
    setLoadingMore(false)
    loadingMoreRef.current = false
    setLoadError(null)
    setDetailLimited(false)
    return () => { loadGeneration.current += 1 }
  }, [profileGeneration, row.key, runId, sessionId])
  const displayEvents = useMemo(() => {
    const promotedIds = new Set(row.promotedCommentaryIds)
    const merged = loadedEvents ? mergeTraceEvents(row.events, loadedEvents) : row.events
    return merged.filter(event => (
      !promotedIds.has(event.id)
      // Commentary already owns the live assistant surface. Keep it out of
      // both sampled and remotely loaded active trace detail.
      && (includeCommentary || !row.active || event.phase !== 'commentary')
    ))
  }, [includeCommentary, loadedEvents, row.active, row.events, row.promotedCommentaryIds])
  const traceSummary = useMemo(() => {
    let toolEventCount = 0
    let thoughtCount = 0
    let latestTool: Event | undefined
    let latestThought: Event | undefined
    let canonicalDiff: Event | null = null
    for (const event of displayEvents) {
      if (event.type === 'tool_started' || event.type === 'tool_finished') {
        toolEventCount += 1
        latestTool = event
      } else if (event.type === 'reasoning_summary') {
        thoughtCount += 1
        latestThought = event
      } else if (event.type === 'code_diff') {
        canonicalDiff = event
      }
    }
    return {
      canonicalDiff,
      preview: reasoningTracePreview(latestThought?.text) || toolTraceHeadline(latestTool),
      thoughtCount,
      toolCount: Math.ceil(toolEventCount / 2),
    }
  }, [displayEvents])
  // Closed traces only need the one-pass summary above. Deferring the bounded
  // detail window avoids repeatedly filtering large lazy-loaded traces while
  // their recycled disclosure is collapsed.
  const detailWindow = useMemo(() => {
    if (!open) return null
    const traceEvents = displayEvents.filter(event => event.type !== 'raw_event')
    const renderWindow = loadedEvents
      ? selectTraceDetailRenderEvents(traceEvents)
      : { events: traceEvents.slice(-TRACE_EVENT_LIMIT), limited: traceEvents.length > TRACE_EVENT_LIMIT }
    return { ...renderWindow, hiddenCount: traceEvents.length - renderWindow.events.length }
  }, [displayEvents, loadedEvents, open])
  const visibleTraceEvents = detailWindow?.events ?? []
  const hiddenTraceEvents = detailWindow?.hiddenCount ?? 0
  const structuredDiff = useMemo(
    () => traceSummary.canonicalDiff ? null : summarizeStructuredToolDiff(displayEvents),
    [displayEvents, traceSummary.canonicalDiff],
  )
  const hasDiff = Boolean(traceSummary.canonicalDiff || structuredDiff?.filesChanged)
  const { preview, thoughtCount, toolCount } = traceSummary
  const metadata = [
    toolCount ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : '',
    thoughtCount ? `${thoughtCount} thinking ${thoughtCount === 1 ? 'summary' : 'summaries'}` : '',
  ].filter(Boolean).join(' · ')
  const toggleLabel = open ? 'Hide details' : 'Show details'
  const showMore = async () => {
    if (!runId || loadingMoreRef.current) return
    const generation = loadGeneration.current
    const cursor = nextAfter
    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadError(null)
    try {
      const page = await loadRunTrace(sessionId, runId, traceAnchor, cursor, 160, profileGeneration)
      const current = useAppStore.getState()
      if (
        generation !== loadGeneration.current
        || current.profileGeneration !== profileGeneration
        || current.selectedSessionId !== sessionId
      ) return
      const nextCursor = page.next_after ?? cursor
      const bounded = boundLoadedTraceEvents(mergeTraceEvents(loadedEvents ?? [], page.events))
      setLoadedEvents(bounded.events)
      setNextAfter(nextCursor)
      setDetailLimited(bounded.limited)
      setHasMore(page.has_more && nextCursor > cursor && !bounded.limited)
    } catch (error) {
      const current = useAppStore.getState()
      if (
        generation !== loadGeneration.current
        || current.profileGeneration !== profileGeneration
        || current.selectedSessionId !== sessionId
      ) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === loadGeneration.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }
  const showLess = () => {
    loadGeneration.current += 1
    setLoadedEvents(null)
    setNextAfter(0)
    setHasMore(true)
    setLoadingMore(false)
    loadingMoreRef.current = false
    setLoadError(null)
    setDetailLimited(false)
  }
  return (
    <View style={styles.traceWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Reasoning trace. ${metadata || 'Activity details'}. ${toggleLabel}.`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(value => !value)}
        style={[styles.traceHeader, { backgroundColor: colors.raised, borderColor: colors.border }]}
      >
        {open ? <ChevronDown size={15} color={colors.muted} /> : <ChevronRight size={15} color={colors.muted} />}
        <Code2 size={14} color={colors.muted} />
        <View style={styles.traceHeading}>
          <View style={styles.traceHeadingMeta}>
            <Text style={[styles.traceTitle, { color: colors.text }]}>Reasoning trace</Text>
            {metadata ? <Text style={[styles.traceMeta, { color: colors.muted }]} numberOfLines={1}>{metadata}</Text> : null}
          </View>
          {!open && preview ? <Text style={[styles.traceHeadline, { color: colors.muted }]} numberOfLines={4}>{preview}</Text> : null}
        </View>
        <Text style={[styles.traceAction, { color: colors.blue }]}>{toggleLabel}</Text>
        {hasDiff && runId ? <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review code changes"
          onPress={event => {
            event.stopPropagation()
            const fallback = reviewFallbackForEvents(profileGeneration, sessionId, runId, displayEvents)
            if (fallback) registerCodeReviewFallback(fallback)
            onReview(runId)
          }}
          style={[styles.review, { backgroundColor: colors.surface }]}
        ><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Review</Text></Pressable> : null}
      </Pressable>
      {open ? <View style={[styles.traceBody, { borderColor: colors.border }]}>
        {hiddenTraceEvents ? <Text style={[styles.traceHidden, { color: colors.muted }]}>{hiddenTraceEvents} older trace updates hidden</Text> : null}
        {visibleTraceEvents.map(event => {
          const text = boundedTraceText(event)
          return <View key={event.id} style={styles.traceEvent}>
            {event.type.includes('tool')
              ? <Wrench size={13} color={colors.orange} />
              : event.type === 'reasoning_summary'
                ? <Sparkles size={13} color={colors.blue} />
                : <Code2 size={13} color={colors.blue} />}
            <View style={styles.traceEventBody}>
              <Text style={[styles.traceEventType, { color: colors.muted }]}>{event.type === 'reasoning_summary'
                ? event.phase === 'commentary' ? 'Agent update' : 'Thinking summary'
                : event.tool?.name || event.type.replaceAll('_', ' ')}</Text>
              {text.trim()
                ? event.type === 'reasoning_summary'
                  ? <MarkdownContent value={text} fontScale={fontScale} />
                  : <Text selectable style={[styles.traceText, { color: colors.text }]}>{text}</Text>
                : null}
            </View>
          </View>
        })}
        {runId ? <View style={styles.traceDetailActions}>
          {loadedEvents != null ? <>
            {!detailLimited ? <Pressable
              testID={`trace-show-more-${row.key}`}
              accessibilityRole="button"
              accessibilityLabel={hasMore ? 'Load more reasoning trace' : 'Check for newer reasoning trace'}
              accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
              disabled={loadingMore}
              onPress={() => void showMore()}
              style={[styles.traceDetailAction, { borderColor: colors.border, backgroundColor: colors.raised }]}
            >
              {loadingMore ? <ActivityIndicator size="small" color={colors.blue} /> : null}
              <Text style={[styles.traceDetailActionText, { color: colors.blue }]}>{hasMore ? 'Load more activity' : 'Check for newer activity'}</Text>
            </Pressable> : null}
            {loadedEvents.length || detailLimited ? <Pressable
                testID={`trace-show-less-${row.key}`}
                accessibilityRole="button"
                accessibilityLabel="Use compact reasoning trace"
                onPress={showLess}
                style={[styles.traceDetailAction, { borderColor: colors.border, backgroundColor: colors.raised }]}
              >
                <Text style={[styles.traceDetailActionText, { color: colors.blue }]}>Use compact trace</Text>
              </Pressable> : null}
          </> : <Pressable
                testID={`trace-show-more-${row.key}`}
                accessibilityRole="button"
                accessibilityLabel="Load available reasoning trace"
                accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
                disabled={loadingMore}
                onPress={() => void showMore()}
                style={[styles.traceDetailAction, { borderColor: colors.border, backgroundColor: colors.raised }]}
              >
                {loadingMore ? <ActivityIndicator size="small" color={colors.blue} /> : null}
                <Text style={[styles.traceDetailActionText, { color: colors.blue }]}>Load available activity</Text>
              </Pressable>}
          {loadError ? <View accessibilityRole="alert" style={styles.traceDetailError}><AlertTriangle size={13} color={colors.red} /><Text style={[styles.traceDetailErrorText, { color: colors.red }]}>{loadError}</Text></View> : null}
          {detailLimited || (detailWindow?.limited && loadedEvents != null)
            ? <Text style={[styles.traceDetailLimitText, { color: colors.muted }]}>Trace detail is bounded to keep this chat responsive.</Text>
            : null}
        </View> : null}
      </View> : null}
    </View>
  )
}

function ProgressRowView({ row, fontScale }: { row: Extract<TimelineRow, { kind: 'progress' }>; fontScale: number }) {
  const colors = usePalette()
  const commentary = row.events.filter(event => event.phase === 'commentary')
  const latest = commentary.at(-1)
  const latestAnnouncement = latest
    ? reasoningTraceHeadline(activeTraceProgressPreview(latest))
    : 'Working'
  return <View
    testID="trace-live-updates"
    accessible
    accessibilityRole="text"
    accessibilityLabel={`Live agent progress. ${latestAnnouncement}`}
    accessibilityLiveRegion="polite"
    style={[styles.progressWrap, { borderColor: colors.border, backgroundColor: colors.raised }]}
  >
    {row.hiddenCount > 0 ? <Text style={[styles.progressMeta, { color: colors.muted }]}>
      {row.hiddenCount} earlier live {row.hiddenCount === 1 ? 'update' : 'updates'} hidden while this turn is active
    </Text> : null}
    {commentary.map((event, index) => <ProgressLineView
      key={event.id}
      event={event}
      first={index === 0}
      fontScale={fontScale}
    />)}
  </View>
}

const ProgressLineView = memo(function ProgressLineView({ event, first, fontScale }: { event: Event; first: boolean; fontScale: number }) {
  const colors = usePalette()
  return <View
    testID={`trace-live-update-${event.id}`}
    style={[styles.progressItem, !first && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
  >
    <MarkdownContent value={activeTraceProgressPreview(event)} fontScale={fontScale} />
  </View>
})

function MediaRowView({ row, sessionId }: { row: Extract<TimelineRow, { kind: 'media' }>; sessionId: string }) {
  const colors = usePalette()
  return <View style={[styles.mediaRow, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.mediaTitle, { color: colors.text }]}>Files & media <Text style={{ color: colors.muted }}>{row.files.length}</Text></Text><MediaGrid files={row.files} sessionId={sessionId} ownerKey={row.key} /></View>
}

function JobRowView({ row, sessionId, onReview, fontScale }: { row: Extract<TimelineRow, { kind: 'job' }>; sessionId: string; onReview: (runId: string) => void; fontScale: number }) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const loadJobRuns = useAppStore(state => state.loadJobRuns)
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, row.key, sessionId])
  const [showHistory, setShowHistory] = useRecyclingState(false, [profileGeneration, row.key, sessionId])
  const [loadedHistory, setLoadedHistory] = useState<Extract<TimelineRow, { kind: 'job' }>['events']>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historySupported, setHistorySupported] = useState<boolean | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyNextBefore, setHistoryNextBefore] = useState<number | null>(null)
  const [historyTotal, setHistoryTotal] = useState<number | null>(null)
  const historyGeneration = useRef(0)
  const selection = useMemo(() => jobDisplaySelection(row.events), [row.events])
  const latest = selection.latest ?? row.events.at(-1)!
  const latestSource = selection.latestSource ?? latest
  const presentation = useMemo(() => jobResultPresentation(latest), [latest])
  const latestStatusSource = useMemo(() => latestJobStatusEvent(row.events) ?? latest, [latest, row.events])
  const latestStatus = useMemo(() => jobRunStatus(latestStatusSource), [latestStatusSource])
  const statusSpecificRunId = String(
    latestStatusSource.job_status_run_id
    || latestStatusSource.job_latest_status_run_id
    || latestStatusSource.run_id
    || ''
  ).trim()
  const traceRunId = latestStatus.label === 'Deferred'
    ? statusSpecificRunId
    : statusSpecificRunId || String(latestStatusSource.job_latest_run_id || '').trim()
  const latestRunTrace = useMemo(
    () => traceRunId
      ? row.events.filter(event => (
          event.run_id === traceRunId
          && ['reasoning_summary', 'tool_started', 'tool_finished', 'code_diff'].includes(event.type)
        ))
      : [],
    [row.events, traceRunId],
  )
  const latestRunTraceAnchor = useMemo(() => {
    if (!traceRunId) return 0
    const runScoped = row.events.filter(event => event.run_id === traceRunId)
    return runScoped.length ? Math.max(...runScoped.map(event => event.seq)) : 0
  }, [row.events, traceRunId])
  const latestRunTraceRow = useMemo<Extract<TimelineRow, { kind: 'trace' }> | null>(
    () => traceRunId ? {
      kind: 'trace',
      key: `${row.key}:${jobRunIdentity(latestStatusSource) ?? `run:${traceRunId}:anchor:${latestRunTraceAnchor}`}:trace`,
      seq: latestRunTrace[0]?.seq ?? latestRunTraceAnchor,
      events: latestRunTrace,
      promotedCommentaryIds: [],
      runId: traceRunId,
      active: latestStatus.tone === 'running',
    } : null,
    [latestRunTrace, latestRunTraceAnchor, latestStatus.tone, latestStatusSource, row.key, traceRunId],
  )
  const runCount = useMemo(() => jobRunCount(row.events), [row.events])
  const excludedRunIdentities = useMemo(
    () => new Set(
      [jobRunIdentity(latestStatusSource), jobRunIdentity(latestSource)]
        .filter((value): value is string => Boolean(value)),
    ),
    [latestSource, latestStatusSource],
  )
  const jobId = useMemo(
    () => {
      for (const event of row.events) {
        const candidate = String(event.job_id || event.job?.id || '').trim()
        if (candidate) return candidate
      }
      return null
    },
    [row.events],
  )
  const bundledHistory = useMemo(
    () => mergeJobHistoryEvents([...selection.previous].reverse()).filter(event => {
      const identity = jobRunIdentity(event)
      return event.id !== latestSource.id && (!identity || !excludedRunIdentities.has(identity))
    }).slice(0, 20),
    [excludedRunIdentities, latestSource.id, selection.previous],
  )
  const history = useMemo(
    () => mergeJobHistoryEvents(loadedHistory, bundledHistory).filter(event => {
      const identity = jobRunIdentity(event)
      return event.id !== latestSource.id && (!identity || !excludedRunIdentities.has(identity))
    }),
    [bundledHistory, excludedRunIdentities, latestSource.id, loadedHistory],
  )
  const excludedCount = Math.max(1, excludedRunIdentities.size)
  const totalRunCount = Math.max(runCount, historyTotal ?? 0)
  const displayRunCount = totalRunCount || 1
  const previousRunCount = Math.max(
    history.length,
    bundledHistory.length,
    Math.max(0, totalRunCount - excludedCount),
  )
  const loadableJobId = canQueryScheduledJobHistory(jobId) ? jobId : null
  const canLoadHistory = loadableJobId !== null

  useEffect(() => {
    historyGeneration.current += 1
    setLoadedHistory([])
    setHistoryLoaded(false)
    setHistorySupported(null)
    setHistoryLoading(false)
    setHistoryError(null)
    setHistoryHasMore(false)
    setHistoryNextBefore(null)
    setHistoryTotal(null)
    return () => { historyGeneration.current += 1 }
  }, [jobId, profileGeneration, row.key, sessionId])

  const loadHistory = async (beforeSeq: number | null, replace: boolean) => {
    if (!loadableJobId || historyLoading) return
    const generation = ++historyGeneration.current
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const page = await loadJobRuns(sessionId, loadableJobId, beforeSeq, 20, profileGeneration)
      if (
        generation !== historyGeneration.current
        || useAppStore.getState().profileGeneration !== profileGeneration
        || useAppStore.getState().selectedSessionId !== sessionId
      ) return
      setLoadedHistory(current => replace ? page.runs : mergeJobHistoryEvents(current, page.runs))
      setHistoryLoaded(true)
      setHistorySupported(page.supported)
      setHistoryHasMore(page.supported && page.has_more)
      setHistoryNextBefore(page.next_before)
      if (page.supported) setHistoryTotal(page.total)
    } catch (error) {
      if (generation !== historyGeneration.current) return
      setHistoryLoaded(true)
      setHistoryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === historyGeneration.current) setHistoryLoading(false)
    }
  }
  const toggleHistory = () => {
    const next = !showHistory
    setShowHistory(next)
    if (next && !historyLoaded) void loadHistory(null, true)
  }

  return <View style={[styles.job, { borderColor: colors.orange, backgroundColor: `${colors.orange}18` }]}>
    <Pressable
      testID={`job-latest-status-${jobId ?? latestSource.id}`}
      accessibilityRole="button"
      accessibilityLabel="Latest scheduled job status"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(value => !value)}
      style={styles.jobDisclosure}
    >
      <View style={styles.jobHeader}>
        <Clock3 size={16} color={colors.orange} />
        <View style={styles.jobHeading}><Text style={[styles.jobTitle, { color: colors.text }]}>Latest Job Status</Text><Text style={[styles.jobMeta, { color: colors.muted }]} numberOfLines={1}>{row.title} · {displayRunCount} {displayRunCount === 1 ? 'run' : 'runs'} · {formatDateTime(latestStatusSource.ts || latest.ts)}</Text></View>
        <JobStatusPill status={latestStatus} />
        {open ? <ChevronDown size={15} color={colors.muted} /> : <ChevronRight size={15} color={colors.muted} />}
      </View>
      {!open ? <Text style={[styles.jobText, { color: colors.text }]} numberOfLines={2}>{presentation.preview}</Text> : null}
    </Pressable>
    {open
      ? presentation.structured
        ? <Text selectable style={[styles.jobStructuredText, { color: colors.text }]}>{presentation.detail}</Text>
        : <MarkdownContent value={presentation.detail} fontScale={fontScale} />
      : null}
    {latestRunTraceRow ? <TraceRowView row={latestRunTraceRow} sessionId={sessionId} onReview={onReview} fontScale={fontScale} anchorSeq={latestRunTraceAnchor} includeCommentary /> : null}
    {canLoadHistory ? <View style={[styles.jobHistory, { borderTopColor: colors.border }]}>
      <Pressable
        testID={`job-previous-runs-${loadableJobId}`}
        accessibilityRole="button"
        accessibilityLabel={previousRunCount > 0 ? `Previous runs ${previousRunCount}` : 'Previous runs'}
        accessibilityState={{ expanded: showHistory }}
        onPress={toggleHistory}
        style={styles.jobHistoryToggle}
      >
        {showHistory ? <ChevronDown size={14} color={colors.muted} /> : <ChevronRight size={14} color={colors.muted} />}
        <Text style={[styles.jobHistoryTitle, { color: colors.text }]}>Previous runs</Text>
        {previousRunCount > 0 ? <Text style={[styles.jobHistoryCount, { color: colors.muted }]}>{previousRunCount.toLocaleString()}</Text> : null}
      </Pressable>
      {showHistory ? <View style={styles.jobHistoryBody}>
        {history.map(event => <JobHistoryRun key={jobRunIdentity(event) ?? event.id} event={event} sessionId={sessionId} onReview={onReview} fontScale={fontScale} />)}
        {historyLoading ? <View style={styles.jobHistoryStatus}><ActivityIndicator size="small" color={colors.orange} /><Text style={[styles.jobHistoryStatusText, { color: colors.muted }]}>Loading run history…</Text></View> : null}
        {!historyLoading && historyError ? <View style={styles.jobHistoryStatus}><AlertTriangle size={13} color={colors.red} /><Text style={[styles.jobHistoryStatusText, { color: colors.red }]}>{historyError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry loading previous runs" onPress={() => void loadHistory(historyNextBefore, loadedHistory.length === 0)} style={styles.jobHistoryRetry}><Text style={[styles.jobHistoryAction, { color: colors.blue }]}>Retry</Text></Pressable></View> : null}
        {!historyLoading && historySupported === false && previousRunCount > history.length ? <Text style={[styles.jobHistoryStatusText, { color: colors.muted }]}>Showing {history.length} recent {history.length === 1 ? 'run' : 'runs'} saved with this chat. Update the server to load all {previousRunCount.toLocaleString()} previous runs.</Text> : null}
        {!historyLoading && historySupported !== false && historyHasMore && historyNextBefore != null ? <Pressable testID={`job-load-older-runs-${loadableJobId}`} accessibilityRole="button" accessibilityLabel="Load older scheduled runs" onPress={() => void loadHistory(historyNextBefore, false)} style={[styles.jobHistoryMore, { borderColor: colors.border, backgroundColor: colors.raised }]}><Text style={[styles.jobHistoryAction, { color: colors.blue }]}>Load older runs</Text></Pressable> : null}
        {!historyLoading && !historyError && history.length === 0 ? <Text style={[styles.jobHistoryStatusText, { color: colors.muted }]}>No prior run output was returned.</Text> : null}
      </View> : null}
    </View> : null}
  </View>
}

function JobHistoryRun({ event, sessionId, onReview, fontScale }: { event: Extract<TimelineRow, { kind: 'job' }>['events'][number]; sessionId: string; onReview: (runId: string) => void; fontScale: number }) {
  const colors = usePalette()
  const [open, setOpen] = useRecyclingState(false, [jobRunIdentity(event) ?? event.id])
  const presentation = useMemo(() => jobResultPresentation(event), [event])
  const status = useMemo(() => jobRunStatus(event, presentation), [event, presentation])
  const traceRow = useMemo<Extract<TimelineRow, { kind: 'trace' }> | null>(() => {
    const runId = event.run_id?.trim()
    return runId ? {
      kind: 'trace',
      key: `job-history:${jobRunIdentity(event) ?? event.id}:trace`,
      seq: event.seq,
      events: [],
      promotedCommentaryIds: [],
      runId,
      active: false,
    } : null
  }, [event])
  return <View style={[styles.jobHistoryRun, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Scheduled run ${formatDateTime(event.ts)}`}
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(value => !value)}
      style={styles.jobHistoryRunHeader}
    >
      <View style={styles.jobHistoryRunText}>
        <Text style={[styles.jobPreviousMeta, { color: colors.muted }]}>{formatDateTime(event.ts)}</Text>
        <Text style={[styles.jobPreviousText, { color: colors.text }]} numberOfLines={2}>{presentation.preview}</Text>
      </View>
      <JobStatusPill status={status} compact />
      {open ? <ChevronDown size={13} color={colors.muted} /> : <ChevronRight size={13} color={colors.muted} />}
    </Pressable>
    {open ? <View style={[styles.jobHistoryRunBody, { borderTopColor: colors.border }]}>
      {presentation.structured
        ? <Text selectable style={[styles.jobStructuredText, { color: colors.text }]}>{presentation.detail}</Text>
        : <MarkdownContent value={presentation.detail} fontScale={fontScale} />}
      {traceRow ? <TraceRowView row={traceRow} sessionId={sessionId} onReview={onReview} fontScale={fontScale} anchorSeq={event.seq} includeCommentary /> : null}
    </View> : null}
  </View>
}

function JobStatusPill({ status, compact = false }: { status: ReturnType<typeof jobRunStatus>; compact?: boolean }) {
  const colors = usePalette()
  const color = status.tone === 'error'
    ? colors.red
    : status.tone === 'completed'
      ? colors.green
      : status.tone === 'running'
        ? colors.blue
        : status.tone === 'stopped'
          ? colors.muted
          : colors.orange
  return <View style={[styles.jobStatusPill, compact && styles.jobStatusPillCompact, { borderColor: color, backgroundColor: `${color}18` }]}>
    <Text style={[styles.jobStatusPillText, compact && styles.jobStatusPillTextCompact, { color }]}>{status.label}</Text>
  </View>
}

function SystemRowView({ row, fontScale }: { row: Extract<TimelineRow, { kind: 'system' }>; fontScale: number }) {
  const colors = usePalette()
  const error = isTimelineError(row.event)
  const digest = isHandoffDigestEvent(row.event)
  const generating = digest && !['handoff_digest_received', 'handoff_digest_sent', 'handoff_digest_error'].includes(row.event.type)
  const title = digest ? digestStatusTitle(row.event) : row.event.type.replaceAll('_', ' ')
  const text = digest ? digestStatusText(row.event) : messageText(row.event) || title
  const digestBody = row.event.type === 'handoff_digest_received' ? row.event.digest?.trim() : ''
  const [showDigest, setShowDigest] = useRecyclingState(false, [row.key])
  const accent = error ? colors.red : digest ? colors.orange : colors.blue
  return <View style={[styles.system, { backgroundColor: error ? `${colors.red}18` : digest ? `${colors.orange}18` : colors.surface, borderColor: accent }]}>
    {error ? <AlertTriangle size={16} color={accent} /> : generating ? <ActivityIndicator size="small" color={accent} style={styles.digestSpinner} /> : digest ? <Sparkles size={16} color={accent} /> : <Check size={16} color={accent} />}
    <View style={{ flex: 1 }}><Text style={[styles.systemTitle, { color: error ? colors.red : colors.muted }]}>{title}</Text><Text selectable style={[styles.systemText, { color: error ? colors.red : colors.text }]}>{text}</Text>{digestBody ? <><Pressable accessibilityRole="button" accessibilityLabel={showDigest ? 'Hide digest' : 'View digest'} accessibilityState={{ expanded: showDigest }} onPress={() => setShowDigest(value => !value)} style={styles.digestToggle}><Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700' }}>{showDigest ? 'Hide digest' : 'View digest'}</Text></Pressable>{showDigest ? <MarkdownContent value={digestBody} fontScale={fontScale} /> : null}</> : null}</View>
  </View>
}

function ProviderInteractionAuditView({ row }: { row: Extract<TimelineRow, { kind: 'system' }> }) {
  const colors = usePalette()
  const [open, setOpen] = useRecyclingState(false, [row.key])
  const audit = useMemo(
    () => providerInteractionAuditSummary(row.events?.length ? row.events : [row.event]),
    [row.event, row.events],
  )
  const provider = row.key.split(':')[1] || 'provider'
  const providerName = `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
  const countLabel = [
    audit.requestCount ? `${audit.requestCount} ${audit.requestCount === 1 ? 'request' : 'requests'}` : '',
    audit.resolvedCount ? `${audit.resolvedCount} resolved` : '',
  ].filter(Boolean).join(' · ') || `${audit.entries.length} updates`
  return <View style={[styles.interactionAudit, { backgroundColor: colors.surface, borderColor: colors.blue }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${providerName} request history, ${countLabel}`}
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(value => !value)}
      style={styles.interactionAuditHeader}
    >
      <History size={15} color={colors.blue} />
      <View style={styles.interactionAuditHeading}>
        <Text style={[styles.interactionAuditTitle, { color: colors.text }]}>{providerName} request history</Text>
        <Text style={[styles.interactionAuditCount, { color: colors.muted }]}>{countLabel}</Text>
      </View>
      <Text style={[styles.interactionAuditTime, { color: colors.muted }]}>{formatDateTime(row.event.ts)}</Text>
      {open ? <ChevronDown size={14} color={colors.muted} /> : <ChevronRight size={14} color={colors.muted} />}
    </Pressable>
    {open ? <View style={[styles.interactionAuditBody, { borderTopColor: colors.border }]}>
      <Text style={[styles.interactionAuditHelp, { color: colors.muted }]}>Current requests stay actionable in the approval panel. This is the compact audit history.</Text>
      {audit.entries.map(entry => <View key={entry.id} style={[styles.interactionAuditEntry, { borderTopColor: colors.border }]}>
        <View style={styles.interactionAuditEntryText}>
          <Text selectable style={[styles.interactionAuditEntryLabel, { color: colors.text }]}>{entry.label}</Text>
          <Text selectable style={[styles.interactionAuditEntryStatus, { color: entry.resolved ? colors.green : colors.orange }]}>{entry.status}</Text>
        </View>
        <Text style={[styles.interactionAuditEntryTime, { color: colors.muted }]}>{formatDateTime(entry.latest.ts)}</Text>
      </View>)}
    </View> : null}
  </View>
}

function CodexLifecycleRowView({ row, fontScale }: { row: Extract<TimelineRow, { kind: 'system' }>; fontScale: number }) {
  const colors = usePalette()
  const [open, setOpen] = useRecyclingState(false, [row.key])
  const event = row.event
  const failed = codexLifecycleFailed(event)
  const detail = messageText(event).trim()
  const accent = failed ? colors.red : colors.blue
  return <View style={[styles.lifecycle, { borderColor: accent, backgroundColor: failed ? `${colors.red}18` : colors.surface }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={codexLifecycleTitle(event)}
      accessibilityState={{ expanded: open }}
      disabled={!detail}
      onPress={() => setOpen(value => !value)}
      style={styles.lifecycleSummary}
    >
      {failed ? <AlertTriangle size={14} color={accent} /> : <Sparkles size={14} color={accent} />}
      <Text style={[styles.lifecycleTitle, { color: failed ? colors.red : colors.text }]}>{codexLifecycleTitle(event)}</Text>
      <Text style={[styles.lifecycleTime, { color: colors.muted }]}>{formatDateTime(event.ts)}</Text>
      {detail ? open ? <ChevronDown size={14} color={colors.muted} /> : <ChevronRight size={14} color={colors.muted} /> : null}
    </Pressable>
    {open && detail ? <View style={[styles.lifecycleDetail, { borderTopColor: colors.border }]}><MarkdownContent value={detail} fontScale={fontScale} /></View> : null}
  </View>
}

function codexLifecycleTitle(event: Extract<TimelineRow, { kind: 'system' }>['event']): string {
  if (event.type === 'codex_goal_budget_limited') return 'Goal budget reached'
  if (event.type === 'codex_compaction_completed') return codexLifecycleFailed(event) ? 'Context compaction failed' : 'Context compacted'
  return event.type.replaceAll('_', ' ')
}

function codexLifecycleFailed(event: Extract<TimelineRow, { kind: 'system' }>['event']): boolean {
  if (isTimelineError(event)) return true
  return event.type === 'codex_compaction_completed'
    && typeof event.status === 'string'
    && event.status !== 'completed'
}

function digestStatusTitle(event: Extract<TimelineRow, { kind: 'system' }>['event']): string {
  if (event.type === 'handoff_digest_received') return 'Context Digest'
  if (event.type.endsWith('_sent')) return 'Digest Sent'
  if (event.type.endsWith('_error')) return 'Digest Failed'
  return 'Creating Digest'
}

function digestStatusText(event: Extract<TimelineRow, { kind: 'system' }>['event']): string {
  if (event.type === 'handoff_digest_received' || event.type.endsWith('_sent') || event.type.endsWith('_error')) {
    return messageText(event) || (event.type.endsWith('_sent') ? 'Context digest created and sent.' : 'Context digest generation failed.')
  }
  return 'Creating a context digest from this chat and sending it to the target chat.'
}

const styles = StyleSheet.create({
  messageWrap: { width: '100%', paddingHorizontal: 14 }, userAlign: { alignItems: 'flex-end' },
  message: { width: '100%', maxWidth: 940, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 12 },
  metaRow: { minWidth: 0, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4 }, metaSpacer: { flex: 1, minWidth: 0 }, author: { flexShrink: 0, fontSize: 10, fontWeight: '700' }, time: { minWidth: 0, flexShrink: 1, fontSize: 10 }, feedback: { minWidth: 0, flexShrink: 1, fontSize: 10, fontWeight: '800' },
  fold: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' }, collapse: { alignSelf: 'flex-start', minHeight: 44, paddingVertical: 5, justifyContent: 'center' },
  traceWrap: { paddingHorizontal: 14 }, traceHeader: { minHeight: 52, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  traceHeading: { flex: 1, minWidth: 0, gap: 3 }, traceHeadingMeta: { flexDirection: 'row', alignItems: 'baseline', gap: 7 }, traceTitle: { flexShrink: 0, fontSize: 12, fontWeight: '700' }, traceMeta: { flex: 1, minWidth: 0, fontSize: 10.5 }, traceHeadline: { fontSize: 10.5, lineHeight: 15 }, traceAction: { flexShrink: 0, fontSize: 10.5, fontWeight: '800' }, review: { minHeight: 44, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 5, justifyContent: 'center' },
  traceBody: { marginHorizontal: 8, borderLeftWidth: StyleSheet.hairlineWidth, paddingVertical: 8, paddingLeft: 11, gap: 9 }, traceHidden: { fontSize: 10, fontWeight: '700' }, traceEvent: { flexDirection: 'row', gap: 8 }, traceEventBody: { flex: 1, minWidth: 0 }, traceEventType: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' }, traceText: { fontSize: 12, fontFamily: 'Menlo', lineHeight: 17, marginTop: 3 },
  traceDetailActions: { gap: 7, paddingTop: 3 },
  traceDetailAction: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  traceDetailActionText: { fontSize: 11, fontWeight: '800' },
  traceDetailError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  traceDetailErrorText: { flex: 1, fontSize: 11, lineHeight: 15 },
  traceDetailLimitText: { fontSize: 10.5, lineHeight: 15 },
  progressWrap: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 5, paddingBottom: 3, overflow: 'hidden' },
  progressMeta: { paddingTop: 5, paddingBottom: 3, fontSize: 10, fontWeight: '700' },
  progressItem: { paddingTop: 4, paddingBottom: 5 }, progressActivity: { fontSize: 11, lineHeight: 16, fontWeight: '600' },
  mediaRow: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 10 }, mediaTitle: { fontSize: 12, fontWeight: '800' },
  job: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 9 },
  emergencyAcknowledge: { minHeight: 38, alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  jobDisclosure: { gap: 9 },
  jobHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  jobHeading: { flex: 1, minWidth: 0 },
  jobTitle: { fontSize: 12, fontWeight: '800' },
  jobMeta: { fontSize: 10, marginTop: 2 },
  jobText: { fontSize: 14, lineHeight: 20 },
  jobStructuredText: { fontSize: 12, lineHeight: 17, fontFamily: 'Menlo' },
  jobStatusPill: { flexShrink: 0, minHeight: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  jobStatusPillCompact: { minHeight: 21, borderRadius: 11, paddingHorizontal: 6 },
  jobStatusPillText: { fontSize: 10, fontWeight: '800' },
  jobStatusPillTextCompact: { fontSize: 9 },
  jobHistory: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 7 },
  jobHistoryToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  jobHistoryTitle: { flex: 1, fontSize: 12, fontWeight: '800' },
  jobHistoryCount: { fontSize: 11, fontWeight: '700' },
  jobHistoryBody: { gap: 7, paddingBottom: 2 },
  jobHistoryRun: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  jobHistoryRunHeader: { minHeight: 54, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  jobHistoryRunText: { minWidth: 0, flex: 1, gap: 2 },
  jobHistoryRunBody: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 9 },
  jobPreviousMeta: { fontSize: 9.5, fontWeight: '700' },
  jobPreviousText: { fontSize: 12.5, lineHeight: 17 },
  jobHistoryStatus: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  jobHistoryStatusText: { flex: 1, fontSize: 11, lineHeight: 15 },
  jobHistoryAction: { fontSize: 11, fontWeight: '800' },
  jobHistoryRetry: { minWidth: 52, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  jobHistoryMore: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  system: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 12, flexDirection: 'row', gap: 10 }, systemTitle: { fontSize: 10, fontWeight: '800', textTransform: 'capitalize' }, systemText: { fontSize: 13.5, lineHeight: 19, marginTop: 4 },
  interactionAudit: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  interactionAuditHeader: { minHeight: 52, paddingHorizontal: 11, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  interactionAuditHeading: { flex: 1, minWidth: 0, gap: 2 },
  interactionAuditTitle: { fontSize: 11.5, fontWeight: '800' },
  interactionAuditCount: { fontSize: 10.5 },
  interactionAuditTime: { flexShrink: 0, fontSize: 9.5 },
  interactionAuditBody: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 9 },
  interactionAuditHelp: { fontSize: 10.5, lineHeight: 15, paddingBottom: 7 },
  interactionAuditEntry: { minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  interactionAuditEntryText: { flex: 1, minWidth: 0, gap: 2 },
  interactionAuditEntryLabel: { fontSize: 11.5, fontWeight: '700' },
  interactionAuditEntryStatus: { fontSize: 10.5, fontWeight: '700' },
  interactionAuditEntryTime: { flexShrink: 0, fontSize: 9.5 },
  lifecycle: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  lifecycleSummary: { minHeight: 44, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 7 },
  lifecycleTitle: { flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: '800' }, lifecycleTime: { fontSize: 9.5 },
  lifecycleDetail: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 9 },
  digestSpinner: { width: 16, height: 16 },
  digestToggle: { alignSelf: 'flex-start', minHeight: 44, paddingTop: 8, paddingBottom: 4, justifyContent: 'center' },
})
