import { getLocale, t } from '@shared/i18n'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from '@shared/provider-origin'
import { useLocale } from '../lib/i18n'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown, ArrowUp, LoaderCircle, Search, X } from 'lucide-react'
import type { CodexThreadStatus, Event as ServerEvent, PinnedItem, SessionSnapshot, TimelineIndex, TimelineIndexLandmark, TimelinePage, TimelineSearchResult, ViewState, WorkspaceProfileScope } from '@shared/types'
import { isAgentVisibleEvent, reconcileRenderTimelineItems, settleInactiveTimelineItems, type MessageItem, type RenderTimelineItem, type TimelineItem } from '../lib/timeline'
import { pendingTurnSubmissionAccepted, snapshotNeedsAuthoritativeTail, useAppStore, type PendingTurnSubmission } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'
import { TimelineMinimap, type TimelineMinimapHandle } from './TimelineMinimap'
import { cachedTimelineLandmarks, countOlderTimelineLandmarks, hasOlderTimelineContent, mergeTimelineLandmarks, retainTimelineLandmarkSpine, type TimelineNavigatorLandmark } from '../lib/timeline-minimap'
import { initialTimelineLocation, isLatestTimelineLocation, remountTimelineLocation, shiftedTimelineFirstItemIndex, type TimelineInitialLocation } from '../lib/timeline-position'
import {
  bridgeHistoricalPageToLive,
  HISTORICAL_NEWER_WINDOW_LIMIT,
  HISTORICAL_OLDER_EVENT_LIMIT,
  HISTORICAL_SEEK_EVENT_LIMIT,
  historicalEdgeAction,
  mergeHistoricalPages
} from '../lib/timeline-history'
import { formatTime } from '../lib/format'
import { pinnedItemsForSession } from '../lib/pinned-items'
import { OPEN_HISTORY_RESULT_EVENT } from '../lib/session-history-search'
import { TIMELINE_VIEWPORT_LAYOUT_EVENT, type TimelineViewportLayoutDetail } from '../lib/workspace-layout'
import { cachedTimelineProjection } from '../lib/timeline-projection-cache'
import { overlayReasoningStream } from '../lib/timeline-reasoning-stream'
import { omitQueuedPendingTimelineItems } from '../lib/timeline-pending-queue'
import { profileSessionKey } from '../lib/profile-scope'
import { localSessionImportSupported } from '@shared/local-session-import'
import { ShortcutTooltip } from './ShortcutTooltip'
import { useTransientClose } from '../lib/transient-close'
import {
  advanceTimelineHistoryBootstrap,
  initialTimelineHistoryBootstrapState
} from '../lib/timeline-bootstrap'

const timelineViewStates = new Map<string, ViewState>()
const FIRST_INDEX = 1_000_000
const MAX_SAVED_TIMELINES = 16
// After a chat opens at latest, the first pages (history bootstrap prepends,
// row re-measurement of tall markdown) keep changing the list. Hold the bottom
// through that and do not persist a view position until the list has been
// quiet for this long, or the user scrolls.
const OPEN_SETTLE_QUIET_MS = 600
// A chat that is streaming while it opens never goes quiet; stop holding the
// bottom after this long regardless so a scrollbar drag is not fought.
const OPEN_SETTLE_MAX_MS = 4000

interface HistoricalWindow {
  page: TimelinePage
  anchorSeq: number
  restoredView?: ViewState
}

interface WorkspaceLayoutAnchor {
  atBottom: boolean
  itemKey: string | null
  topOffset: number
}

export function pendingTurnMessageItem(sessionId: string, pending: PendingTurnSubmission): MessageItem {
  const id = `pending-turn:${pending.token}`
  const event: ServerEvent = {
    id,
    session_id: sessionId,
    seq: pending.afterSeq + 1,
    type: 'turn_started',
    ts: new Date(pending.createdAt).toISOString(),
    prompt: pending.prompt,
    file_ids: pending.files.map(file => file.id),
    chat_references: pending.chatReferences,
    team_references: pending.teamReferences,
    provider_user_authored: true
  }
  return {
    kind: 'message',
    id,
    key: id,
    seq: event.seq,
    event,
    events: [event],
    role: 'user',
    files: pending.files,
    pending: true,
    pendingPhase: pending.phase
  }
}

export const Timeline = memo(function Timeline({ sessionId, focused = true }: { sessionId?: string | null; focused?: boolean } = {}) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const resolvedSessionId = sessionId === undefined ? selectedSessionId : sessionId
  const snapshot = useAppStore(state => resolvedSessionId ? state.snapshots[resolvedSessionId] : undefined)
  const healthKnown = useAppStore(state => state.health !== null)
  const localSessionImportAvailable = useAppStore(state => localSessionImportSupported(state.health))
  const healthActive = useAppStore(state => resolvedSessionId ? state.activeSessionIds.has(resolvedSessionId) : false)
  const pendingSubmission = useAppStore(state => resolvedSessionId ? state.pendingTurnSubmissions[resolvedSessionId] : undefined)
  const activeCodexRunId = useAppStore(state => {
    if (!resolvedSessionId) return null
    const run = state.health?.active_runs?.find(candidate => candidate.session_id === resolvedSessionId)
    return typeof run?.run_id === 'string' && run.run_id.trim() ? run.run_id.trim() : null
  })
  const loading = useAppStore(state => resolvedSessionId
    ? state.loadingSessionIds?.has(resolvedSessionId) ?? state.loadingSessionId === resolvedSessionId
    : false)
  const [showColdLoader, setShowColdLoader] = useState(false)
  const recoveringEmptyCache = Boolean(snapshot && snapshotNeedsAuthoritativeTail(snapshot))

  useEffect(() => {
    if (!loading || (snapshot && !recoveringEmptyCache)) { setShowColdLoader(false); return }
    const timer = window.setTimeout(() => setShowColdLoader(true), 160)
    return () => window.clearTimeout(timer)
  }, [loading, recoveringEmptyCache, snapshot, resolvedSessionId])

  if (!resolvedSessionId) return <div className="timeline-empty">
    <div className="empty-symbol">⌁</div>
    <h2>{t('timeline.ui.noChatSelected')}</h2>
    <p>{t('timeline.ui.createOrSelectAChatToStart')}</p>
    {localSessionImportAvailable && <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('importChats', true)}>{t('timeline.ui.importLocalChats')}</button>}
  </div>
  if (loading && (!snapshot || recoveringEmptyCache)) return showColdLoader
    ? <div className="timeline-loading"><LoaderCircle className="spin" size={18} /><span>{t('timeline.ui.loadingLatestMessages')}</span></div>
    : <div className="timeline-pending" />
  if (!snapshot) return <div className="timeline-empty"><h2>{t('timeline.ui.conversationUnavailable')}</h2><button className="primary-button" onClick={() => void useAppStore.getState().reloadSession(resolvedSessionId)}>{t('timeline.ui.tryAgain')}</button></div>
  const workspaceKey = `${profileSessionKey(activeProfileId, resolvedSessionId, serverIdentity)}:generation:${profileGeneration}`
  const liveTurnState = resolveTimelineLiveState(
    snapshot.session.backend === 'codex' ? snapshot.session.codex_thread_status : null,
    healthKnown,
    healthActive
  )
  return <TimelineSession key={workspaceKey} profileId={activeProfileId} profileGeneration={profileGeneration} serverIdentity={serverIdentity} sessionId={resolvedSessionId} snapshot={snapshot} pendingSubmission={pendingSubmission} liveTurnState={liveTurnState} activeCodexRunId={activeCodexRunId} focused={focused} />
})

function TimelineSession({ profileId, profileGeneration, serverIdentity, sessionId, snapshot, pendingSubmission, liveTurnState, activeCodexRunId, focused }: { profileId: string | null; profileGeneration: number; serverIdentity: string | null; sessionId: string; snapshot: SessionSnapshot; pendingSubmission?: PendingTurnSubmission; liveTurnState: boolean | null; activeCodexRunId: string | null; focused: boolean }) {
  useLocale()
  const ref = useRef<VirtuosoHandle>(null)
  const minimapRef = useRef<TimelineMinimapHandle>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const semanticProjected = useRef<TimelineItem[]>([])
  const projected = useRef<RenderTimelineItem[]>([])
  const projectionSource = useRef('live')
  const firstItemIndex = useRef(FIRST_INDEX)
  const workspaceKey = `${profileSessionKey(profileId, sessionId, serverIdentity)}:generation:${profileGeneration}`
  const initialViewState = useRef(timelineViewStates.get(workspaceKey) ?? snapshot.viewState).current
  const previousLastKey = useRef<string | null>(null)
  const atBottomRef = useRef(initialViewState?.atBottom ?? true)
  const topItemIdRef = useRef<string | null>(initialViewState?.topItemId ?? null)
  const topItemSeqRef = useRef<number | null>(initialViewState?.topItemSeq ?? null)
  const topOffsetRef = useRef(initialViewState?.topOffset ?? 0)
  const distanceFromBottomRef = useRef(initialViewState?.distanceFromBottom ?? 0)
  const viewSaveTimer = useRef<number | null>(null)
  const visibleRangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null)
  const workspaceLayoutFrame = useRef<number | null>(null)
  const workspaceLayoutAnchor = useRef<WorkspaceLayoutAnchor | null>(null)
  const workspaceLayoutFinishTimer = useRef<number | null>(null)
  const workspaceLayoutFinishing = useRef(false)
  const workspaceResizeObserver = useRef<ResizeObserver | null>(null)
  const workspaceResizeObserverFrame = useRef<number | null>(null)
  const captureVisiblePositionRef = useRef<() => void>(() => {})
  const scheduleViewSaveRef = useRef<() => void>(() => {})
  const scheduleWorkspaceRestoreRef = useRef<() => void>(() => {})
  const scheduleWorkspaceFinishRef = useRef<() => void>(() => {})
  const loadingOlderRef = useRef(false)
  const historyBootstrapRef = useRef(initialTimelineHistoryBootstrapState())
  const historicalPagingRef = useRef<'older' | 'newer' | null>(null)
  const historicalWindowRef = useRef(false)
  const olderPagingArmedRef = useRef(false)
  const latestScrollFrame = useRef<number | null>(null)
  const historySeekLease = useRef(0)
  const navigatorIndexSource = useRef<TimelineIndexLandmark[] | null>(null)
  const navigatorSpine = useRef<TimelineIndexLandmark[]>([])
  const searchLease = useRef(0)
  const searchNavigated = useRef(false)
  const itemsLength = useRef(0)
  const [atBottom, setAtBottom] = useState(initialViewState?.atBottom ?? true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [searchResults, setSearchResults] = useState<TimelineSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [timelineIndex, setTimelineIndex] = useState<TimelineIndex | null>(null)
  const [historicalWindow, setHistoricalWindow] = useState<HistoricalWindow | null>(null)
  const [historicalPaging, setHistoricalPaging] = useState<'older' | 'newer' | null>(null)
  const [seekingHistory, setSeekingHistory] = useState(false)
  const [pinnedItemIds, setPinnedItemIds] = useState<ReadonlySet<string>>(() => new Set())
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  useTransientClose(searchOpen, closeSearch)
  const pinProfileScope = useMemo<WorkspaceProfileScope | null>(() => profileId ? ({
    profileId,
    profileGeneration,
    serverIdentity
  }) : null, [profileGeneration, profileId, serverIdentity])
  historicalWindowRef.current = Boolean(historicalWindow)

  useEffect(() => {
    let disposed = false
    const applyPins = (items: PinnedItem[]) => {
      if (disposed) return
      const next = new Set(pinnedItemsForSession(items, sessionId).map(item => item.id))
      setPinnedItemIds(current => sameStringSet(current, next) ? current : next)
    }
    const refreshPins = () => {
      if (!pinProfileScope) return
      void window.agentsDock.pins.list(pinProfileScope, sessionId).then(items => {
        if (disposed) return
        applyPins(items)
      }).catch(() => undefined)
    }
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) refreshPins()
    }
    const unsubscribe = window.agentsDock.events.on('server:pins', payload => {
      if (
        payload.profileId === profileId
        && payload.profileGeneration === profileGeneration
        && payload.sessionId === sessionId
      ) applyPins(payload.pins)
    })
    refreshPins()
    window.addEventListener('agentsdock:pins-changed', changed)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('agentsdock:pins-changed', changed)
    }
  }, [pinProfileScope, profileGeneration, profileId, sessionId])

  const syncMinimapToVisibleRange = useCallback(() => {
    const minimap = minimapRef.current
    if (!minimap) return
    if (!historicalWindowRef.current && atBottomRef.current && itemsLength.current > 0) {
      const lastIndex = itemsLength.current - 1
      minimap.setVisibleRange(lastIndex, lastIndex, true)
      return
    }
    const range = visibleRangeRef.current
    if (range) minimap.setVisibleRange(range.startIndex, range.endIndex)
  }, [])
  const setScroller = useCallback((node: HTMLElement | Window | null) => {
    const next = node instanceof HTMLElement ? node : null
    if (scroller.current === next) return
    workspaceResizeObserver.current?.disconnect()
    workspaceResizeObserver.current = null
    if (workspaceResizeObserverFrame.current != null) window.cancelAnimationFrame(workspaceResizeObserverFrame.current)
    scroller.current = next
    if (next) {
      syncMinimapToVisibleRange()
      const observer = new ResizeObserver(() => {
        if (!workspaceLayoutAnchor.current) return
        scheduleWorkspaceRestoreRef.current()
        if (workspaceLayoutFinishing.current) scheduleWorkspaceFinishRef.current()
      })
      observer.observe(next)
      workspaceResizeObserver.current = observer
      workspaceResizeObserverFrame.current = window.requestAnimationFrame(() => {
        workspaceResizeObserverFrame.current = null
        if (workspaceResizeObserver.current !== observer || scroller.current !== next) return
        const content = next.firstElementChild
        if (content instanceof HTMLElement) observer.observe(content)
      })
    }
  }, [syncMinimapToVisibleRange])

  useEffect(() => () => {
    historySeekLease.current += 1
    searchLease.current += 1
    if (latestScrollFrame.current != null) window.cancelAnimationFrame(latestScrollFrame.current)
    if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    if (workspaceLayoutFinishTimer.current != null) window.clearTimeout(workspaceLayoutFinishTimer.current)
    if (workspaceResizeObserverFrame.current != null) window.cancelAnimationFrame(workspaceResizeObserverFrame.current)
    workspaceResizeObserver.current?.disconnect()
  }, [])

  // A timeline revision invalidates the projection cache, but it is not a new
  // visual list. Remounting Virtuoso for an interior event correction drops
  // native scroll momentum and reparses every mounted Markdown row. Older
  // servers can issue those corrections repeatedly while reconciling a live
  // timeline, which made scrolling and unrelated composer input hitch.
  const projectionSourceKey = historicalWindow ? `history:${historicalWindow.anchorSeq}` : `live:${snapshot.generation ?? 0}`
  const listSourceKey = historicalWindow
    ? `history:${historicalWindow.anchorSeq}`
    : `live:${snapshot.timelineListGeneration ?? 0}`
  const sourceEvents = historicalWindow?.page.events ?? snapshot.events
  const presentedActiveRunId = useMemo(
    () => activeCodexRunId ?? timelineActiveRunId(sourceEvents),
    [activeCodexRunId, sourceEvents]
  )

  const items = useMemo(() => {
    if (projectionSource.current !== listSourceKey) {
      projectionSource.current = listSourceKey
      semanticProjected.current = []
      projected.current = []
      firstItemIndex.current = FIRST_INDEX
    }
    const previous = projected.current
    const projectionStarted = performance.now()
    const projection = cachedTimelineProjection(
      `${workspaceKey}:${projectionSourceKey}`,
      sourceEvents,
      snapshot.files,
      {
        rootThreadId: snapshot.session.codex_thread_id,
        activeRunId: presentedActiveRunId
      }
    )
    const projectionMs = performance.now() - projectionStarted
    if (projectionMs >= 50) {
      queueMicrotask(() => { void window.agentsDock.native.log('performance', 'timeline projection was slow', {
        sessionId,
        sourceKey: projectionSourceKey,
        strategy: projection.strategy,
        renderedSemanticCount: projection.renderedSemanticCount,
        projectionMs: Math.round(projectionMs),
        eventCount: sourceEvents.length,
        rowCount: projection.rendered.length
      }) })
    }
    semanticProjected.current = projection.semantic
    const presented = historicalWindow || liveTurnState === false
      ? settleInactiveTimelineItems(projection.rendered)
      : overlayReasoningStream(projection.rendered, projection.semantic, snapshot.reasoningStream?.items, sessionId)
    const canonical = omitQueuedPendingTimelineItems(presented, snapshot.queuedTurns, sessionId)
    const showPending = !historicalWindow
      && pendingSubmission
      && pendingSubmission.mode !== 'queue'
      && !pendingTurnSubmissionAccepted(pendingSubmission, sourceEvents)
    const displayed = showPending
      ? [...canonical, pendingTurnMessageItem(sessionId, pendingSubmission)]
      : canonical
    const next = reconcileRenderTimelineItems(previous, displayed)
    firstItemIndex.current = shiftedTimelineFirstItemIndex(
      firstItemIndex.current,
      previous.map(item => item.key),
      next.map(item => item.key)
    )
    projected.current = next
    return next
  }, [
    historicalWindow,
    liveTurnState,
    presentedActiveRunId,
    snapshot.files,
    snapshot.queuedTurns,
    snapshot.reasoningStream,
    sessionId,
    snapshot.session.codex_thread_id,
    sourceEvents,
    listSourceKey,
    projectionSourceKey,
    pendingSubmission,
    workspaceKey
  ])
  itemsLength.current = items.length
  const olderPaging = useMemo(() => {
    const pagingBoundary = snapshot.nextTimelineBefore ?? snapshot.events[0]?.seq
    return timelineIndex && pagingBoundary != null
      ? {
          remaining: countOlderTimelineLandmarks(timelineIndex.landmarks, pagingBoundary),
          hasContent: hasOlderTimelineContent(timelineIndex.landmarks, pagingBoundary)
        }
      : null
  }, [snapshot.events, snapshot.nextTimelineBefore, timelineIndex])
  const olderRemaining = olderPaging?.remaining ?? null
  const hasOlderMessages = snapshot.hasMoreEvents && (olderPaging?.hasContent ?? true)
  const unreadAtOpen = useRef(Boolean(snapshot.session.manual_unread) ||
    (snapshot.session.latest_agent_event_seq ?? 0) > (snapshot.session.last_read_agent_event_seq ?? 0)).current
  const newestLoadedAgentSeq = useMemo(() => sourceEvents.reduce((latest, event) => (
    isAgentVisibleEvent(event) ? Math.max(latest, event.seq) : latest
  ), 0), [sourceEvents])
  const [initialLocation] = useState(() => initialTimelineLocation(initialViewState, items.map(item => item.key), unreadAtOpen))
  const [restoringSavedView, setRestoringSavedView] = useState(() => Boolean(
    initialViewState?.atBottom === false
    && Number.isSafeInteger(initialViewState.topItemSeq)
    && Number(initialViewState.topItemSeq) > 0
    && !items.some(item => item.key === initialViewState.topItemId)
  ))
  const restoringSavedViewRef = useRef(restoringSavedView)
  restoringSavedViewRef.current = restoringSavedView
  // True while a chat that opened at latest is still settling (see
  // OPEN_SETTLE_QUIET_MS). Cleared by quiet time or by the user scrolling up.
  const openSettlingRef = useRef(!restoringSavedView && isLatestTimelineLocation(initialLocation))
  const openSettleTimer = useRef<number | null>(null)
  const openSettleStartedAt = useRef(Date.now())
  // Any explicit navigation (search result, landmark seek, New button) bumps
  // the history seek lease; that ends settling so it is never fought.
  const openSettleLease = useRef(historySeekLease.current)
  const restoredAnchorIndex = historicalWindow?.restoredView?.topItemId
    ? items.findIndex(item => item.key === historicalWindow.restoredView?.topItemId)
    : -1
  const historicalAnchorIndex = historicalWindow
    ? Math.max(0, restoredAnchorIndex >= 0 ? restoredAnchorIndex : items.findIndex(item => timelineItemSequenceRange(item)[1] >= historicalWindow.anchorSeq))
    : -1
  const historicalLocation: TimelineInitialLocation = historicalWindow
    ? historicalWindow.restoredView
      ? { index: historicalAnchorIndex, align: 'start', offset: -(historicalWindow.restoredView.topOffset ?? 0) }
      : { index: historicalAnchorIndex, align: 'center' }
    : undefined
  const sourceLocationRef = useRef<{ sourceKey: string; location: TimelineInitialLocation }>({
    sourceKey: listSourceKey,
    location: initialLocation
  })
  if (sourceLocationRef.current.sourceKey !== listSourceKey) {
    const returningFromHistory = sourceLocationRef.current.sourceKey.startsWith('history:')
      && listSourceKey.startsWith('live:')
    const location = remountTimelineLocation(
      {
        atBottom: atBottomRef.current,
        topItemId: topItemIdRef.current,
        topOffset: topOffsetRef.current
      },
      items.map(item => item.key),
      historicalLocation ?? (returningFromHistory ? { index: 'LAST', align: 'end' } : undefined)
    )
    sourceLocationRef.current = { sourceKey: listSourceKey, location }
    if (!historicalWindow && isLatestTimelineLocation(location)) {
      // A replacement that drops the old anchor is a new latest landing. Give
      // its rows the same bounded settle treatment as the original chat open.
      openSettlingRef.current = true
      openSettleStartedAt.current = Date.now()
      openSettleLease.current = historySeekLease.current
    }
  }
  const activeInitialLocation = historicalLocation ?? sourceLocationRef.current.location

  const cancelSavedViewRestore = useCallback(() => {
    if (!restoringSavedViewRef.current) return
    restoringSavedViewRef.current = false
    historySeekLease.current += 1
    setRestoringSavedView(false)
  }, [])

  useEffect(() => {
    if (!restoringSavedViewRef.current || !initialViewState?.topItemSeq) return
    const lease = ++historySeekLease.current
    void window.agentsDock.timeline.around(sessionId, initialViewState.topItemSeq, HISTORICAL_SEEK_EVENT_LIMIT).then(page => {
      if (lease !== historySeekLease.current || page.events.length === 0) return
      setHistoricalWindow({ page, anchorSeq: initialViewState.topItemSeq!, restoredView: initialViewState })
    }).catch(error => {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (lease !== historySeekLease.current) return
      restoringSavedViewRef.current = false
      setRestoringSavedView(false)
    })
  }, [initialViewState, sessionId])

  const scrollToLoadedIndex = useCallback((index: number, behavior: 'auto' | 'smooth' = 'auto') => {
    const lease = ++historySeekLease.current
    const navigate = () => {
      if (lease === historySeekLease.current) ref.current?.scrollToIndex({ index, align: 'center', behavior })
    }
    // Cancelling a saved-history restore mounts the live list on the next render.
    if (ref.current) navigate()
    else window.requestAnimationFrame(navigate)
  }, [])

  const scrollToLatest = useCallback(() => {
    ref.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
  }, [])
  const startLatestNavigation = useCallback((deferFrames = 0) => {
    cancelSavedViewRestore()
    const lease = ++historySeekLease.current
    historicalPagingRef.current = null
    if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    if (workspaceLayoutFinishTimer.current != null) window.clearTimeout(workspaceLayoutFinishTimer.current)
    workspaceLayoutFrame.current = null
    workspaceLayoutFinishTimer.current = null
    workspaceLayoutAnchor.current = null
    workspaceLayoutFinishing.current = false
    setHistoricalPaging(null)
    setSeekingHistory(false)
    setHistoricalWindow(null)
    setNewBelow(false)
    if (latestScrollFrame.current != null) window.cancelAnimationFrame(latestScrollFrame.current)

    const navigate = (remaining: number) => {
      if (lease !== historySeekLease.current) return
      if (remaining > 0) {
        latestScrollFrame.current = window.requestAnimationFrame(() => {
          latestScrollFrame.current = null
          navigate(remaining - 1)
        })
        return
      }
      scrollToLatest()
      // Virtuoso can refine the final row height after the first jump. Reassert
      // LAST once on the following frame without starting an open-ended loop.
      latestScrollFrame.current = window.requestAnimationFrame(() => {
        latestScrollFrame.current = null
        if (lease === historySeekLease.current) scrollToLatest()
      })
    }

    navigate(deferFrames)
  }, [cancelSavedViewRestore, scrollToLatest])
  const jumpToLatest = useCallback(() => startLatestNavigation(), [startLatestNavigation])

  const captureVisiblePosition = useCallback(() => {
    if (restoringSavedViewRef.current) return
    const node = scroller.current
    if (!node) return
    const viewport = node.getBoundingClientRect()
    const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-index]'))
    const row = rows.find(candidate => candidate.getBoundingClientRect().bottom > viewport.top + 1)
    if (!row) return
    const semanticKey = row.querySelector<HTMLElement>('[data-timeline-key]')?.dataset.timelineKey
    const raw = Number(row.dataset.index)
    const index = raw >= firstItemIndex.current ? raw - firstItemIndex.current : raw
    topItemIdRef.current = semanticKey ?? items[index]?.key ?? topItemIdRef.current
    const item = semanticKey ? items.find(candidate => candidate.key === semanticKey) : items[index]
    if (item) topItemSeqRef.current = timelineItemSequenceRange(item)[0]
    topOffsetRef.current = row.getBoundingClientRect().top - viewport.top
    const distanceFromBottom = Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight)
    distanceFromBottomRef.current = distanceFromBottom
    atBottomRef.current = distanceFromBottom <= 80
  }, [items])
  captureVisiblePositionRef.current = captureVisiblePosition

  const restoreWorkspaceLayoutAnchor = useCallback(() => {
    const node = scroller.current
    const anchor = workspaceLayoutAnchor.current
    if (!node || !anchor) return true
    if (anchor.atBottom) {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
      return true
    }
    if (!anchor.itemKey) return true
    const marker = Array.from(node.querySelectorAll<HTMLElement>('[data-timeline-key]'))
      .find(candidate => candidate.dataset.timelineKey === anchor.itemKey)
    const row = marker?.closest<HTMLElement>('[data-index]') ?? marker
    if (!row) return false
    const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.topOffset
    if (Math.abs(delta) > 0.5) node.scrollTop += delta
    return true
  }, [])

  const persistView = useCallback((): Promise<void> | null => {
    // A transient position captured while the opened chat is still settling
    // would be restored on the next open as a "strange landing point".
    if (restoringSavedViewRef.current || openSettlingRef.current) return null
    const state: ViewState = {
      sessionId,
      topItemId: topItemIdRef.current,
      topItemSeq: topItemSeqRef.current,
      topOffset: topOffsetRef.current,
      distanceFromBottom: distanceFromBottomRef.current,
      atBottom: historicalWindow ? false : atBottomRef.current,
      updatedAt: Date.now()
    }
    rememberViewState(workspaceKey, state)
    const current = useAppStore.getState()
    const currentIdentity = current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity ?? null
    return profileId && current.activeProfileId === profileId && current.profileGeneration === profileGeneration && currentIdentity === serverIdentity
      ? window.agentsDock.timeline.saveViewState({ profileId, profileGeneration, serverIdentity }, state)
      : null
  }, [historicalWindow, profileGeneration, profileId, serverIdentity, sessionId, workspaceKey])
  const scheduleViewSave = useCallback(() => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
    viewSaveTimer.current = window.setTimeout(() => {
      viewSaveTimer.current = null
      captureVisiblePosition()
      void persistView()
    }, 500)
  }, [captureVisiblePosition, persistView])
  scheduleViewSaveRef.current = scheduleViewSave

  const scheduleWorkspaceRestore = useCallback(() => {
    if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    workspaceLayoutFrame.current = window.requestAnimationFrame(() => {
      workspaceLayoutFrame.current = null
      restoreWorkspaceLayoutAnchor()
    })
  }, [restoreWorkspaceLayoutAnchor])
  const finalizeWorkspaceLayout = useCallback(() => {
    workspaceLayoutFinishTimer.current = null
    if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    workspaceLayoutFrame.current = window.requestAnimationFrame(() => {
      workspaceLayoutFrame.current = null
      const restored = restoreWorkspaceLayoutAnchor()
      if (!restored) {
        const itemKey = workspaceLayoutAnchor.current?.itemKey
        const index = itemKey ? projected.current.findIndex(item => item.key === itemKey) : -1
        if (index >= 0) ref.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' })
      }
      workspaceLayoutFrame.current = window.requestAnimationFrame(() => {
        workspaceLayoutFrame.current = null
        restoreWorkspaceLayoutAnchor()
        workspaceLayoutAnchor.current = null
        workspaceLayoutFinishing.current = false
        captureVisiblePositionRef.current()
        scheduleViewSaveRef.current()
      })
    })
  }, [restoreWorkspaceLayoutAnchor])
  const scheduleWorkspaceFinish = useCallback(() => {
    if (workspaceLayoutFinishTimer.current != null) window.clearTimeout(workspaceLayoutFinishTimer.current)
    workspaceLayoutFinishTimer.current = window.setTimeout(finalizeWorkspaceLayout, 140)
  }, [finalizeWorkspaceLayout])
  scheduleWorkspaceRestoreRef.current = scheduleWorkspaceRestore
  scheduleWorkspaceFinishRef.current = scheduleWorkspaceFinish

  const unreadItemKey = useMemo(() => {
    const session = snapshot.session
    const lastRead = session.last_read_agent_event_seq ?? 0
    const hasUnread = Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > lastRead
    if (!hasUnread) return null
    return items.find(item => timelineEvents(item).some(event => event.seq > lastRead && isAgentVisibleEvent(event)) || item.kind === 'media' && item.seq > lastRead)?.key ?? null
  }, [items, snapshot.session.last_read_agent_event_seq, snapshot.session.latest_agent_event_seq, snapshot.session.manual_unread])

  useEffect(() => {
    let cancelled = false
    setTimelineIndex(null)
    void window.agentsDock.timeline.index(sessionId).then(index => {
      if (!cancelled) setTimelineIndex(index)
    }).catch(error => {
      void window.agentsDock.native.log('timeline-index', 'whole-chat index unavailable; using loaded turns', {
        sessionId, error: error instanceof Error ? error.message : String(error)
      })
    })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    const clean = searchQuery.trim()
    const lease = ++searchLease.current
    searchNavigated.current = false
    setSearchCursor(0)
    if (!searchOpen || clean.length < 2) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    setSearchResults([])
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void window.agentsDock.timeline.search(sessionId, clean, 50).then(results => {
        if (lease !== searchLease.current) return
        setSearchResults(results)
      }).catch(error => {
        if (lease === searchLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (lease === searchLease.current) setSearchLoading(false)
      })
    }, 220)
    return () => {
      window.clearTimeout(timer)
      if (lease === searchLease.current) searchLease.current += 1
    }
  }, [searchOpen, searchQuery, sessionId])

  useEffect(() => {
    if (!focused || !unreadAtOpen || !document.hasFocus()) return
    const frame = window.requestAnimationFrame(() => void useAppStore.getState().markRead(sessionId))
    return () => window.cancelAnimationFrame(frame)
  }, [focused, sessionId, unreadAtOpen])

  useEffect(() => {
    if (
      historicalWindow
      || !focused
      || !atBottomRef.current
      || !document.hasFocus()
      || newestLoadedAgentSeq <= (snapshot.session.last_read_agent_event_seq ?? 0)
    ) return
    const frame = window.requestAnimationFrame(() => void useAppStore.getState().markRead(sessionId))
    return () => window.cancelAnimationFrame(frame)
  }, [focused, historicalWindow, newestLoadedAgentSeq, sessionId, snapshot.session.last_read_agent_event_seq])

  useEffect(() => {
    const last = items.at(-1)?.key ?? null
    // While the opened chat is still settling the viewport is being held at
    // the bottom programmatically; a momentary atBottom=false during a page
    // prepend must not raise the "New" badge.
    if (previousLastKey.current && previousLastKey.current !== last && !atBottomRef.current && !openSettlingRef.current) setNewBelow(true)
    previousLastKey.current = last
  }, [items])

  useEffect(() => {
    if (!openSettlingRef.current) return
    const finishSettling = () => {
      if (openSettleTimer.current != null) window.clearTimeout(openSettleTimer.current)
      openSettleTimer.current = null
      openSettlingRef.current = false
      captureVisiblePositionRef.current()
      scheduleViewSaveRef.current()
    }
    if (
      historicalWindow
      || historySeekLease.current !== openSettleLease.current
      || Date.now() - openSettleStartedAt.current > OPEN_SETTLE_MAX_MS
    ) {
      finishSettling()
      return
    }
    // Each items change during the open (bootstrap prepend, live catch-up,
    // re-measured rows) can leave Virtuoso short of the bottom. Reassert the
    // latest position a frame later (and once more after Virtuoso refines row
    // heights), then consider the open settled after a quiet period.
    if (latestScrollFrame.current != null) window.cancelAnimationFrame(latestScrollFrame.current)
    latestScrollFrame.current = window.requestAnimationFrame(() => {
      latestScrollFrame.current = null
      if (!openSettlingRef.current) return
      scrollToLatest()
      latestScrollFrame.current = window.requestAnimationFrame(() => {
        latestScrollFrame.current = null
        if (openSettlingRef.current) scrollToLatest()
      })
    })
    if (openSettleTimer.current != null) window.clearTimeout(openSettleTimer.current)
    openSettleTimer.current = window.setTimeout(finishSettling, OPEN_SETTLE_QUIET_MS)
  }, [historicalWindow, items, scrollToLatest])

  useEffect(() => () => {
    if (openSettleTimer.current != null) window.clearTimeout(openSettleTimer.current)
  }, [])

  useEffect(() => () => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
    void persistView()
  }, [persistView])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      captureVisiblePosition()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [items, captureVisiblePosition])

  useEffect(() => {
    const handleLayout = (event: Event) => {
      const { phase } = (event as CustomEvent<TimelineViewportLayoutDetail>).detail
      if (phase === 'begin') {
        if (workspaceLayoutFinishTimer.current != null) window.clearTimeout(workspaceLayoutFinishTimer.current)
        workspaceLayoutFinishing.current = false
        captureVisiblePositionRef.current()
        workspaceLayoutAnchor.current = {
          atBottom: atBottomRef.current,
          itemKey: topItemIdRef.current,
          topOffset: topOffsetRef.current
        }
        return
      }
      if (!workspaceLayoutAnchor.current) return
      scheduleWorkspaceRestoreRef.current()
      if (phase === 'end') {
        workspaceLayoutFinishing.current = true
        scheduleWorkspaceFinishRef.current()
      }
    }
    window.addEventListener(TIMELINE_VIEWPORT_LAYOUT_EVENT, handleLayout)
    return () => {
      window.removeEventListener(TIMELINE_VIEWPORT_LAYOUT_EVENT, handleLayout)
      if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    }
  }, [])

  useEffect(() => {
    const capture = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string
        promises?: Promise<unknown>[]
        waitUntil?: (promise: PromiseLike<unknown>) => void
      }>).detail
      if (detail?.sessionId && detail.sessionId !== sessionId) return
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
      viewSaveTimer.current = null
      captureVisiblePosition()
      const persistence = persistView()
      if (!persistence) return
      if (Array.isArray(detail?.promises)) detail.promises.push(persistence)
      else if (detail?.waitUntil) detail.waitUntil(persistence)
      else void persistence
    }
    window.addEventListener('agentsdock:capture-timeline', capture)
    return () => window.removeEventListener('agentsdock:capture-timeline', capture)
  }, [captureVisiblePosition, persistView])

  useEffect(() => {
    const windowFocused = () => {
      if (focused && atBottomRef.current) void useAppStore.getState().markRead(sessionId)
    }
    window.addEventListener('focus', windowFocused)
    return () => window.removeEventListener('focus', windowFocused)
  }, [focused, sessionId])

  useEffect(() => {
    const localSend = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId !== sessionId) return
      startLatestNavigation(2)
    }
    const jump = (event: Event) => {
      if (!timelineEventTargetsSession(event, sessionId, focused)) return
      startLatestNavigation(1)
    }
    window.addEventListener('agentsdock:local-send', localSend)
    window.addEventListener('agentsdock:jump-latest', jump)
    return () => { window.removeEventListener('agentsdock:local-send', localSend); window.removeEventListener('agentsdock:jump-latest', jump) }
  }, [focused, sessionId, startLatestNavigation])

  const openSearchResult = useCallback(async (result: TimelineSearchResult) => {
    cancelSavedViewRestore()
    const directIndex = projected.current.findIndex(item => {
      if (timelineItemHasEvent(item, result.event_id)) return true
      const [start, end] = timelineItemSequenceRange(item)
      return start <= result.seq && result.seq <= end
    })
    if (directIndex >= 0) {
      scrollToLoadedIndex(directIndex)
      return
    }
    const lease = ++historySeekLease.current
    historicalPagingRef.current = null
    setHistoricalPaging(null)
    setSeekingHistory(true)
    try {
      const page = await window.agentsDock.timeline.around(sessionId, result.seq, HISTORICAL_SEEK_EVENT_LIMIT)
      if (lease === historySeekLease.current) setHistoricalWindow({ page, anchorSeq: result.seq })
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (lease === historySeekLease.current) setSeekingHistory(false)
    }
  }, [cancelSavedViewRestore, scrollToLoadedIndex, sessionId])

  const openPinnedEvent = useCallback(async (eventId: string, query?: string) => {
    cancelSavedViewRestore()
    const lease = ++historySeekLease.current
    const index = projected.current.findIndex(item => timelineItemHasEvent(item, eventId))
    if (index >= 0) {
      scrollToLoadedIndex(index, 'smooth')
      return
    }
    const clean = query?.trim()
    if (!clean) return
    try {
      const result = (await window.agentsDock.timeline.search(sessionId, clean, 100))
        .find(candidate => candidate.event_id === eventId)
      if (result && lease === historySeekLease.current) await openSearchResult(result)
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }, [cancelSavedViewRestore, openSearchResult, scrollToLoadedIndex, sessionId])

  useEffect(() => {
    const openSearch = (event: Event) => { if (timelineEventTargetsSession(event, sessionId, focused)) setSearchOpen(true) }
    const findEvent = (event: Event) => {
      if (!timelineEventTargetsSession(event, sessionId, focused)) return
      const detail = (event as CustomEvent<string | { eventId: string; query?: string }>).detail
      const eventId = typeof detail === 'string' ? detail : detail?.eventId
      if (eventId) void openPinnedEvent(eventId, typeof detail === 'string' ? undefined : detail.query)
    }
    window.addEventListener('agentsdock:find-in-chat', openSearch)
    window.addEventListener('agentsdock:find-event', findEvent)
    return () => { window.removeEventListener('agentsdock:find-in-chat', openSearch); window.removeEventListener('agentsdock:find-event', findEvent) }
  }, [focused, openPinnedEvent, sessionId])

  useEffect(() => {
    const openHistoryResult = (event: Event) => {
      const result = (event as CustomEvent<TimelineSearchResult>).detail
      if (result?.session_id === sessionId) void openSearchResult(result)
    }
    window.addEventListener(OPEN_HISTORY_RESULT_EVENT, openHistoryResult)
    return () => window.removeEventListener(OPEN_HISTORY_RESULT_EVENT, openHistoryResult)
  }, [openSearchResult, sessionId])

  const openSearchAt = (cursor: number) => {
    const result = searchResults[cursor]
    if (!result) return
    searchNavigated.current = true
    setSearchCursor(cursor)
    void openSearchResult(result)
  }
  const selectSearchAt = (cursor: number) => {
    if (!searchResults[cursor]) return
    closeSearch()
    openSearchAt(cursor)
  }
  const moveSearch = (direction: 1 | -1) => {
    if (!searchResults.length) return
    openSearchAt((searchCursor + direction + searchResults.length) % searchResults.length)
  }
  const submitSearch = (direction: 1 | -1) => {
    if (!searchResults.length) return
    if (!searchNavigated.current) openSearchAt(direction > 0 ? searchCursor : searchResults.length - 1)
    else moveSearch(direction)
  }
  const searchWindowStart = Math.max(0, Math.min(searchCursor - 5, Math.max(0, searchResults.length - 12)))
  const visibleSearchResults = searchResults.slice(searchWindowStart, searchWindowStart + 12)

  const loadOlder = useCallback(async (limit?: number) => {
    if (!snapshot.hasMoreEvents || loadingOlderRef.current) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try { await useAppStore.getState().loadOlderForSession(sessionId, limit) }
    finally { loadingOlderRef.current = false; setLoadingOlder(false) }
  }, [sessionId, snapshot.hasMoreEvents])

  const bootstrapCursor = snapshot.nextTimelineBefore ?? snapshot.events[0]?.seq ?? null
  useEffect(() => {
    if (historicalWindow || restoringSavedView) return
    const step = advanceTimelineHistoryBootstrap(historyBootstrapRef.current, {
      cursor: bootstrapCursor,
      hasMore: snapshot.hasMoreEvents,
      loading: loadingOlder,
      rowCount: items.length,
      sourceKey: projectionSourceKey,
      semanticPaging: snapshot.semanticPaging
    })
    historyBootstrapRef.current = step.state
    if (step.loadLimit != null) void loadOlder(step.loadLimit)
  }, [bootstrapCursor, historicalWindow, items.length, loadOlder, loadingOlder, projectionSourceKey, restoringSavedView, snapshot.hasMoreEvents, snapshot.semanticPaging])

  const requestOlderFromUserScroll = useCallback((event: WheelEvent<HTMLDivElement>) => {
    cancelSavedViewRestore()
    if (event.deltaY >= 0) return
    // The user is scrolling up on purpose: stop holding the bottom.
    if (openSettlingRef.current) {
      openSettlingRef.current = false
      if (openSettleTimer.current != null) window.clearTimeout(openSettleTimer.current)
      openSettleTimer.current = null
    }
    if (historicalWindow || !hasOlderMessages) return
    olderPagingArmedRef.current = true
    const node = scroller.current
    if (node && node.scrollTop <= 120) {
      olderPagingArmedRef.current = false
      void loadOlder()
    }
  }, [cancelSavedViewRestore, hasOlderMessages, historicalWindow, loadOlder])

  const findFile = useCallback(async (fileId: string) => {
    const event = await window.agentsDock.files.findEvent(sessionId, fileId)
    if (!event) return
    const index = projected.current.findIndex(item => item.kind === 'media' && item.files.some(file => file.id === fileId) || item.kind === 'system' && item.event.id === event.id)
    if (index >= 0) ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
  }, [sessionId])

  useEffect(() => {
    const listener = (event: Event) => {
      if (!timelineEventTargetsSession(event, sessionId, focused)) return
      const detail = (event as CustomEvent<string | { fileId: string }>).detail
      const fileId = typeof detail === 'string' ? detail : detail?.fileId
      if (fileId) void findFile(fileId)
    }
    window.addEventListener('agentsdock:find-file', listener)
    return () => window.removeEventListener('agentsdock:find-file', listener)
  }, [findFile, focused, sessionId])

  const loadedLandmarks = useMemo(() => cachedTimelineLandmarks(items), [getLocale(), items])
  const navigatorLandmarks = useMemo(() => {
    if (timelineIndex && navigatorIndexSource.current !== timelineIndex.landmarks) {
      navigatorIndexSource.current = timelineIndex.landmarks
      navigatorSpine.current = timelineIndex.landmarks
    }
    const merged = mergeTimelineLandmarks(
      timelineIndex ? navigatorSpine.current : undefined,
      loadedLandmarks
    )
    if (timelineIndex) navigatorSpine.current = retainTimelineLandmarkSpine(merged)
    return merged
  }, [loadedLandmarks, timelineIndex])
  useEffect(() => {
    syncMinimapToVisibleRange()
  }, [items, navigatorLandmarks, syncMinimapToVisibleRange])
  const seekTimeline = useCallback(async (landmark: TimelineNavigatorLandmark) => {
    cancelSavedViewRestore()
    const directIndex = landmark.index ?? items.findIndex(item => {
      const [start, end] = timelineItemSequenceRange(item)
      return start <= landmark.end_seq && landmark.start_seq <= end
    })
    if (directIndex >= 0) {
      scrollToLoadedIndex(directIndex)
      return
    }
    const lease = ++historySeekLease.current
    historicalPagingRef.current = null
    setHistoricalPaging(null)
    setSeekingHistory(true)
    try {
      const page = await window.agentsDock.timeline.around(sessionId, landmark.start_seq, HISTORICAL_SEEK_EVENT_LIMIT)
      if (lease !== historySeekLease.current) return
      setHistoricalWindow({ page, anchorSeq: landmark.start_seq })
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (lease === historySeekLease.current) setSeekingHistory(false)
    }
  }, [cancelSavedViewRestore, items, scrollToLoadedIndex, sessionId])
  const returnToLatest = useCallback(() => {
    startLatestNavigation(2)
  }, [startLatestNavigation])
  const scrollTimelineBy = useCallback((deltaY: number) => {
    const node = scroller.current
    if (node) node.scrollTop += deltaY
  }, [])
  const loadHistoricalEdge = useCallback(async (direction: 'older' | 'newer') => {
    const current = historicalWindow
    if (!current || historicalPagingRef.current) return
    const action = historicalEdgeAction(current.page, direction)
    if (action === 'none') return
    if (action === 'return-live') {
      returnToLatest()
      return
    }
    const edgeSequence = direction === 'older'
      ? current.page.events[0]?.seq
      : current.page.events.at(-1)?.seq
    if (edgeSequence == null) return
    const lease = ++historySeekLease.current
    historicalPagingRef.current = direction
    setHistoricalPaging(direction)
    try {
      const page = direction === 'older'
        ? await window.agentsDock.timeline.historicalOlder(sessionId, edgeSequence, HISTORICAL_OLDER_EVENT_LIMIT)
        : await window.agentsDock.timeline.around(sessionId, edgeSequence + 1, HISTORICAL_NEWER_WINDOW_LIMIT)
      if (lease !== historySeekLease.current) return
      setHistoricalWindow(active => {
        if (!active || active.anchorSeq !== current.anchorSeq) return active
        const merged = mergeHistoricalPages(active.page, page, direction)
        const nextPage = direction === 'newer' ? bridgeHistoricalPageToLive(merged, snapshot.events) : merged
        return nextPage === active.page ? active : { ...active, page: nextPage }
      })
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (lease === historySeekLease.current) {
        historicalPagingRef.current = null
        setHistoricalPaging(null)
      }
    }
  }, [historicalWindow, returnToLatest, sessionId, snapshot.events])
  const header = useCallback(() => historicalWindow
    ? <div className="history-window"><span>{historicalPaging === 'older' ? t('timeline.ui.loadingEarlierMessages') : t('timeline.ui.viewingAnOlderPartOfThisChatScrollEitherDirectionToContinue')}</span><button onClick={returnToLatest}>{t('timeline.ui.returnToLatest')}</button></div>
    : hasOlderMessages || loadingOlder
      ? <div className="history-loader"><button disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? <><LoaderCircle className="spin" size={13} /> {t('timeline.ui.loadingOlderMessages')}</> : olderRemaining ? t('timeline.history.showOlderRemaining', { count: olderRemaining.toLocaleString(getLocale()) }) : t('timeline.history.showOlder')}</button></div>
      : <div className="history-start">{t('timeline.ui.beginningOfConversation')}</div>, [getLocale(), hasOlderMessages, historicalPaging, historicalWindow, loadOlder, loadingOlder, olderRemaining, returnToLatest])
  const showLiveStatus = timelineNeedsLiveStatus(items, liveTurnState, Boolean(historicalWindow))
  const footer = useCallback(() => historicalWindow && historicalPaging === 'newer'
    ? <div className="history-loader"><span><LoaderCircle className="spin" size={13} />  {t('timeline.ui.loadingNewerMessages')}</span></div>
    : <TimelineFooter live={showLiveStatus} />,
  [getLocale(), historicalPaging, historicalWindow, showLiveStatus])
  const components = useMemo(() => ({ Header: header, Footer: footer }), [footer, header])
  const itemContent = useCallback((index: number, item: RenderTimelineItem) => (
    <div
      className="virtual-row"
      data-timeline-key={item.key}
      data-timeline-index={localVirtuosoIndex(index, firstItemIndex.current, itemsLength.current)}
    >
      {item.key === unreadItemKey && <div className="unread-divider"><span>{t('timeline.ui.newMessages')}</span></div>}
      <TimelineRowView
        item={item}
        sessionId={sessionId}
        profileScope={pinProfileScope}
        onFindFile={findFile}
        pinnedItemIds={pinnedItemIds}
        codexLifecycleActive={Boolean(
          !historicalWindow
          && liveTurnState === true
          && item.kind === 'system'
          && item.event.run_id?.trim() === presentedActiveRunId
        )}
      />
    </div>
  ), [getLocale(), findFile, historicalWindow, liveTurnState, pinProfileScope, pinnedItemIds, presentedActiveRunId, sessionId, unreadItemKey])

  return (
    <div className="timeline" onWheelCapture={requestOlderFromUserScroll}>
      {restoringSavedView ? <div className="timeline-pending" /> : <Virtuoso
        key={listSourceKey}
        ref={ref}
        data={items}
        firstItemIndex={firstItemIndex.current}
        computeItemKey={(_, item) => item.key}
        defaultItemHeight={170}
        increaseViewportBy={{ top: 260, bottom: 260 }}
        initialTopMostItemIndex={activeInitialLocation}
        scrollerRef={setScroller}
        skipAnimationFrameInResizeObserver
        followOutput={false}
        atBottomThreshold={80}
        atBottomStateChange={value => {
          atBottomRef.current = value
          if (value) distanceFromBottomRef.current = 0
          setAtBottom(value)
          syncMinimapToVisibleRange()
          scheduleViewSave()
          if (value && !historicalWindow) {
            setNewBelow(false)
            if (focused && document.hasFocus()) void useAppStore.getState().markRead(sessionId)
          }
        }}
        rangeChanged={range => {
          scheduleViewSave()
          const localStart = localVirtuosoIndex(range.startIndex, firstItemIndex.current, itemsLength.current)
          const localEnd = localVirtuosoIndex(range.endIndex, firstItemIndex.current, itemsLength.current)
          visibleRangeRef.current = { startIndex: localStart, endIndex: localEnd }
          syncMinimapToVisibleRange()
          if (historicalWindow) {
            if (localStart <= 1) void loadHistoricalEdge('older')
            if (localEnd >= itemsLength.current - 2) void loadHistoricalEdge('newer')
          } else if (olderPagingArmedRef.current && localStart <= 1 && hasOlderMessages) {
            olderPagingArmedRef.current = false
            void loadOlder()
          }
        }}
        isScrolling={value => {
          if (!value) {
            // rangeChanged already keeps this timer pushed past active scroll
            // input. Let its quiet-period capture do the DOM measurement once;
            // doing it synchronously here forces layout for every rich mounted
            // row on the scroll-stop frame, then repeats the same work 500 ms
            // later in scheduleViewSave.
            scheduleViewSave()
          }
        }}
        startReached={() => {
          if (historicalWindow) void loadHistoricalEdge('older')
          else if (olderPagingArmedRef.current && hasOlderMessages) {
            olderPagingArmedRef.current = false
            void loadOlder()
          }
        }}
        endReached={() => { if (historicalWindow) void loadHistoricalEdge('newer') }}
        components={components}
        itemContent={itemContent}
      />}
      {navigatorLandmarks.length > 2 && <TimelineMinimap
        ref={minimapRef}
        landmarks={navigatorLandmarks}
        onSeek={seekTimeline}
        onScroll={scrollTimelineBy}
      />}
      {searchOpen && <div className="timeline-search-panel" onKeyDownCapture={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
      }}>
        <div className="timeline-search">
          {searchLoading ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}
          <input autoFocus value={searchQuery} placeholder={t('timeline.ui.searchFullChatHistory')} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); submitSearch(event.shiftKey ? -1 : 1) }
            if (event.key === 'ArrowDown') { event.preventDefault(); moveSearch(1) }
            if (event.key === 'ArrowUp') { event.preventDefault(); moveSearch(-1) }
          }} />
          <span>{searchResults.length ? `${searchCursor + 1}/${searchResults.length}` : searchQuery.trim().length >= 2 && !searchLoading ? '0/0' : ''}</span>
          <button type="button" title={t('timeline.ui.previous')} onClick={() => moveSearch(-1)}><ArrowUp size={13} /></button>
          <button type="button" title={t('timeline.ui.next')} onClick={() => moveSearch(1)}><ArrowDown size={13} /></button>
          <button type="button" aria-label={t('timeline.ui.closeTimelineSearch')} title={t('timeline.ui.close')} onClick={closeSearch}><X size={13} /></button>
        </div>
        {searchQuery.trim().length >= 2 && <div className="timeline-search-results">
          {visibleSearchResults.map((result, offset) => {
            const index = searchWindowStart + offset
            return <button type="button" className={index === searchCursor ? 'active' : ''} key={`${result.event_id}:${result.seq}`} onClick={() => selectSearchAt(index)}>
            <span><strong>{searchRoleLabel(result.role)}</strong><time>{formatSearchTime(result.ts)}</time></span>
            <small>{result.snippet}</small>
          </button>})}
          {!searchLoading && !searchResults.length && <p>{t('timeline.ui.noMatchesInThisChat')}</p>}
          {searchResults.length > 12 && <p>{t('timeline.search.range', { start: searchWindowStart + 1, end: Math.min(searchResults.length, searchWindowStart + 12), count: searchResults.length })}</p>}
        </div>}
      </div>}
      {!historicalWindow && !atBottom && <ShortcutTooltip shortcut="jumpLatest" side="left"><button className={`latest-button ${newBelow ? 'has-new' : ''}`} aria-label={t('timeline.ui.jumpToLatest')} onClick={jumpToLatest}><ArrowDown size={14} />{newBelow ? t('timeline.ui.new') : ''}</button></ShortcutTooltip>}
      {seekingHistory && <div className="timeline-seeking"><LoaderCircle className="spin" size={13} />  {t('timeline.ui.openingThatPoint')}</div>}
    </div>
  )
}

function TimelineFooter({ live = false }: { live?: boolean }) {
  return <>
    {live && <div className="virtual-row timeline-live-status" role="status">
      <div className="run-activity-summary"><span className="activity-ring" aria-hidden="true" /><strong>{t('timeline.ui.working')}</strong></div>
    </div>}
    <div className="timeline-end" />
  </>
}

/** An owned live run can precede its first visible event or the loaded page. */
export function timelineNeedsLiveStatus(items: readonly RenderTimelineItem[], live: boolean | null, historical: boolean): boolean {
  return live === true && !historical && !items.some(item => (
    item.kind === 'progress' && item.active === true && !item.stoppedAt
    || item.kind === 'trace' && item.active === true
  ))
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value))
}

function rememberViewState(workspaceKey: string, state: ViewState): void {
  timelineViewStates.delete(workspaceKey)
  timelineViewStates.set(workspaceKey, state)
  while (timelineViewStates.size > MAX_SAVED_TIMELINES) {
    const oldest = timelineViewStates.keys().next().value as string | undefined
    if (!oldest) break
    timelineViewStates.delete(oldest)
  }
}

export function rememberTimelineViewState(profileId: string | null, state: ViewState): void {
  rememberViewState(profileSessionKey(profileId, state.sessionId), state)
}

export function savedTimelineViewState(profileId: string | null, sessionId: string): ViewState | undefined {
  return timelineViewStates.get(profileSessionKey(profileId, sessionId))
}

export function clearTimelineViewStates(): void {
  timelineViewStates.clear()
}

export function sameTimelineKeys(keys: string[], items: RenderTimelineItem[]): boolean {
  return keys.length === items.length && keys.every((key, index) => key === items[index]?.key)
}

export function resolveTimelineLiveState(
  codexStatus: CodexThreadStatus | null | undefined,
  healthKnown: boolean,
  healthActive: boolean
): boolean | null {
  // ACTIVE is AgentsServer's authoritative per-chat run state. Provider
  // status can briefly remain idle/notLoaded while a new app-server turn is
  // starting, and exec fallback legitimately runs with no loaded app-server
  // thread at all.
  if (healthKnown) return healthActive
  if (codexStatus?.type === 'active') return true
  if (codexStatus && ['idle', 'systemError'].includes(codexStatus.type)) return false
  return null
}

export function timelineActiveRunId(events: readonly ServerEvent[]): string | null {
  let activeRunId: string | null = null
  for (const event of events) {
    if (isImportedProviderControlMetadata(event) || isImportedHistoryRecord(event)) continue
    const runId = event.run_id?.trim() || null
    if ((event.type === 'turn_started' || event.type === 'codex_compaction_started') && runId) {
      activeRunId = runId
    } else if (
      runId
      && runId === activeRunId
      && (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error')
    ) {
      activeRunId = null
    }
  }
  return activeRunId
}

function searchRoleLabel(role: TimelineSearchResult['role']): string {
  if (role === 'user') return t('timeline.ui.you')
  if (role === 'assistant') return t('timeline.ui.assistant')
  if (role === 'trace') return 'Reasoning'
  if (role === 'job') return t('timeline.ui.job')
  if (role === 'file') return t('timeline.ui.file')
  if (role === 'error') return t('timeline.ui.error')
  return t('timeline.ui.system')
}

function formatSearchTime(value?: string | null): string {
  return value ? formatTime(value) : ''
}

function timelineEventTargetsSession(event: Event, sessionId: string, focused: boolean): boolean {
  const detail = (event as CustomEvent<unknown>).detail
  if (detail && typeof detail === 'object' && 'sessionId' in detail) {
    return (detail as { sessionId?: unknown }).sessionId === sessionId
  }
  return focused
}

function timelineItemHasEvent(item: RenderTimelineItem, eventId: string): boolean {
  if (item.kind === 'system') return item.event.id === eventId
  if (item.kind === 'progress') return item.events.some(event => event.id === eventId)
  if (item.kind === 'job') return item.events.some(event => event.id === eventId)
  if (item.kind === 'message') return item.events.some(event => event.id === eventId)
  if (item.kind === 'trace') return item.events.some(event => event.id === eventId)
  return item.files.some(file => file.event_id === eventId)
}

function timelineEvents(item: RenderTimelineItem): import('@shared/types').Event[] {
  if (item.kind === 'system') return [item.event]
  if (item.kind === 'progress') return item.events
  if (item.kind === 'job') return item.events
  if (item.kind === 'message') return item.events
  if (item.kind === 'trace') return item.events
  return []
}

function timelineItemSequenceRange(item: RenderTimelineItem): [number, number] {
  if (item.kind === 'job') return [item.startSeq, item.endSeq]
  const events = timelineEvents(item)
  if (events.length) {
    return [
      Math.min(...events.map(event => event.seq)),
      Math.max(...events.map(event => event.seq))
    ]
  }
  const sequences = item.kind === 'media' ? item.files.map(file => file.seq ?? item.seq) : [item.seq]
  return [Math.min(...sequences), Math.max(...sequences)]
}

function localVirtuosoIndex(index: number, firstItemIndex: number, itemCount: number): number {
  const local = index >= firstItemIndex ? index - firstItemIndex : index
  return Math.max(0, Math.min(local, Math.max(0, itemCount - 1)))
}
