import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown, ArrowUp, LoaderCircle, Paperclip, Search, X } from 'lucide-react'
import type { NativeFileRef, SessionSnapshot, TimelineIndex, TimelinePage, TimelineSearchResult, ViewState } from '@shared/types'
import { isAgentVisibleEvent, projectTimeline, reconcileRenderTimelineItems, reconcileTimelineItems, renderTimelineItems, type RenderTimelineItem, type TimelineItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'
import { TimelineMinimap, type TimelineMinimapHandle } from './TimelineMinimap'
import { buildTimelineLandmarks, mergeTimelineLandmarks, type TimelineNavigatorLandmark } from '../lib/timeline-minimap'
import { initialTimelineLocation } from '../lib/timeline-position'
import { formatTime } from '../lib/format'
import { OPEN_HISTORY_RESULT_EVENT } from '../lib/session-history-search'
import { TIMELINE_VIEWPORT_LAYOUT_EVENT, type TimelineViewportLayoutDetail } from '../lib/workspace-layout'

const timelineViewStates = new Map<string, ViewState>()
const FIRST_INDEX = 1_000_000
const MAX_SAVED_TIMELINES = 16

interface HistoricalWindow {
  page: TimelinePage
  anchorSeq: number
}

interface WorkspaceLayoutAnchor {
  atBottom: boolean
  itemKey: string | null
  topOffset: number
}

export function Timeline() {
  const sessionId = useAppStore(state => state.selectedSessionId)
  const snapshot = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId] : undefined)
  const loading = useAppStore(state => state.loadingSessionId === state.selectedSessionId)
  const [showColdLoader, setShowColdLoader] = useState(false)

  useEffect(() => {
    if (!loading || snapshot) { setShowColdLoader(false); return }
    const timer = window.setTimeout(() => setShowColdLoader(true), 160)
    return () => window.clearTimeout(timer)
  }, [loading, snapshot, sessionId])

  if (!sessionId) return <div className="timeline-empty"><div className="empty-symbol">⌁</div><h2>No chat selected</h2><p>Create or select a chat to start.</p></div>
  if (!snapshot && loading) return showColdLoader
    ? <div className="timeline-loading"><LoaderCircle className="spin" size={18} /><span>Loading this chat for the first time</span></div>
    : <div className="timeline-pending" />
  if (!snapshot) return <div className="timeline-empty"><h2>Conversation unavailable</h2><button className="primary-button" onClick={() => void useAppStore.getState().selectSession(sessionId)}>Try again</button></div>
  return <TimelineSession key={sessionId} sessionId={sessionId} snapshot={snapshot} />
}

function TimelineSession({ sessionId, snapshot }: { sessionId: string; snapshot: SessionSnapshot }) {
  const ref = useRef<VirtuosoHandle>(null)
  const minimapRef = useRef<TimelineMinimapHandle>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const semanticProjected = useRef<TimelineItem[]>([])
  const projected = useRef<RenderTimelineItem[]>([])
  const projectionSource = useRef('live')
  const firstItemIndex = useRef(FIRST_INDEX)
  const initialViewState = useRef(timelineViewStates.get(sessionId) ?? snapshot.viewState).current
  const previousLastKey = useRef<string | null>(null)
  const atBottomRef = useRef(initialViewState?.atBottom ?? true)
  const topItemIdRef = useRef<string | null>(initialViewState?.topItemId ?? null)
  const topOffsetRef = useRef(initialViewState?.topOffset ?? 0)
  const distanceFromBottomRef = useRef(initialViewState?.distanceFromBottom ?? 0)
  const viewSaveTimer = useRef<number | null>(null)
  const minimapSyncFrame = useRef<number | null>(null)
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
  const pendingLocalScroll = useRef(false)
  const historySeekLease = useRef(0)
  const searchLease = useRef(0)
  const searchNavigated = useRef(false)
  const itemsLength = useRef(0)
  const [atBottom, setAtBottom] = useState(initialViewState?.atBottom ?? true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [searchResults, setSearchResults] = useState<TimelineSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [timelineIndex, setTimelineIndex] = useState<TimelineIndex | null>(null)
  const [historicalWindow, setHistoricalWindow] = useState<HistoricalWindow | null>(null)
  const [seekingHistory, setSeekingHistory] = useState(false)

  const syncMinimapToViewport = useCallback(() => {
    const node = scroller.current
    const minimap = minimapRef.current
    if (!node || !minimap) return
    const index = timelineIndexAtViewportCenter(node, firstItemIndex.current, itemsLength.current)
    if (index != null) minimap.setVisibleRange(index, index)
  }, [])
  const scheduleMinimapSync = useCallback(() => {
    if (minimapSyncFrame.current != null) return
    minimapSyncFrame.current = window.requestAnimationFrame(() => {
      minimapSyncFrame.current = null
      syncMinimapToViewport()
    })
  }, [syncMinimapToViewport])
  const setScroller = useCallback((node: HTMLElement | Window | null) => {
    const next = node instanceof HTMLElement ? node : null
    if (scroller.current === next) return
    scroller.current?.removeEventListener('scroll', scheduleMinimapSync)
    workspaceResizeObserver.current?.disconnect()
    workspaceResizeObserver.current = null
    if (workspaceResizeObserverFrame.current != null) window.cancelAnimationFrame(workspaceResizeObserverFrame.current)
    scroller.current = next
    next?.addEventListener('scroll', scheduleMinimapSync, { passive: true })
    if (next) {
      scheduleMinimapSync()
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
  }, [scheduleMinimapSync])

  useEffect(() => () => {
    scroller.current?.removeEventListener('scroll', scheduleMinimapSync)
    if (minimapSyncFrame.current != null) window.cancelAnimationFrame(minimapSyncFrame.current)
    if (workspaceLayoutFrame.current != null) window.cancelAnimationFrame(workspaceLayoutFrame.current)
    if (workspaceLayoutFinishTimer.current != null) window.clearTimeout(workspaceLayoutFinishTimer.current)
    if (workspaceResizeObserverFrame.current != null) window.cancelAnimationFrame(workspaceResizeObserverFrame.current)
    workspaceResizeObserver.current?.disconnect()
  }, [scheduleMinimapSync])

  const sourceKey = historicalWindow ? `history:${historicalWindow.anchorSeq}` : `live:${snapshot.generation ?? 0}`
  const sourceEvents = historicalWindow?.page.events ?? snapshot.events

  const items = useMemo(() => {
    if (projectionSource.current !== sourceKey) {
      projectionSource.current = sourceKey
      semanticProjected.current = []
      projected.current = []
      firstItemIndex.current = FIRST_INDEX
    }
    const previous = projected.current
    const semantic = reconcileTimelineItems(semanticProjected.current, projectTimeline(sourceEvents, snapshot.files))
    semanticProjected.current = semantic
    const next = reconcileRenderTimelineItems(previous, renderTimelineItems(semantic))
    if (previous.length && next.length) {
      const oldFirst = previous[0].key
      const prepended = next.findIndex(item => item.key === oldFirst)
      if (prepended > 0) firstItemIndex.current -= prepended
    }
    projected.current = next
    return next
  }, [snapshot.files, sourceEvents, sourceKey])
  itemsLength.current = items.length
  const unreadAtOpen = useRef(Boolean(snapshot.session.manual_unread) ||
    (snapshot.session.latest_agent_event_seq ?? 0) > (snapshot.session.last_read_agent_event_seq ?? 0)).current
  const [initialLocation] = useState(() => initialTimelineLocation(initialViewState, items.map(item => item.key), unreadAtOpen))
  const historicalAnchorIndex = historicalWindow
    ? Math.max(0, items.findIndex(item => timelineItemSequenceRange(item)[1] >= historicalWindow.anchorSeq))
    : -1
  const activeInitialLocation = historicalWindow
    ? { index: historicalAnchorIndex, align: 'center' as const }
    : initialLocation

  const captureVisiblePosition = useCallback(() => {
    if (historicalWindow) return
    const node = scroller.current
    if (!node) return
    const viewport = node.getBoundingClientRect()
    const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-index]'))
    const row = rows.find(candidate => candidate.getBoundingClientRect().bottom > viewport.top + 1)
    if (row) {
      const semanticKey = row.querySelector<HTMLElement>('[data-timeline-key]')?.dataset.timelineKey
      const raw = Number(row.dataset.index)
      const index = raw >= firstItemIndex.current ? raw - firstItemIndex.current : raw
      topItemIdRef.current = semanticKey ?? items[index]?.key ?? topItemIdRef.current
      topOffsetRef.current = row.getBoundingClientRect().top - viewport.top
    }
    const distanceFromBottom = Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight)
    distanceFromBottomRef.current = distanceFromBottom
    atBottomRef.current = distanceFromBottom <= 80
  }, [historicalWindow, items])
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

  const persistView = useCallback(() => {
    if (historicalWindow) return
    const state: ViewState = {
      sessionId,
      topItemId: topItemIdRef.current,
      topOffset: topOffsetRef.current,
      distanceFromBottom: distanceFromBottomRef.current,
      atBottom: atBottomRef.current,
      updatedAt: Date.now()
    }
    rememberViewState(state)
    void window.agentsDock.timeline.saveViewState(state)
  }, [historicalWindow, sessionId])
  const scheduleViewSave = useCallback(() => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
    viewSaveTimer.current = window.setTimeout(() => {
      viewSaveTimer.current = null
      captureVisiblePosition()
      persistView()
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
    return () => window.clearTimeout(timer)
  }, [searchOpen, searchQuery, sessionId])

  useEffect(() => {
    if (!unreadAtOpen || !document.hasFocus()) return
    const frame = window.requestAnimationFrame(() => void useAppStore.getState().markRead(sessionId))
    return () => window.cancelAnimationFrame(frame)
  }, [sessionId, unreadAtOpen])

  useEffect(() => {
    const last = items.at(-1)?.key ?? null
    if (previousLastKey.current && previousLastKey.current !== last && !atBottomRef.current) setNewBelow(true)
    previousLastKey.current = last
  }, [items])

  useEffect(() => () => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
    persistView()
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
    const capture = () => {
      captureVisiblePosition()
      persistView()
    }
    window.addEventListener('agentsdock:capture-timeline', capture)
    return () => window.removeEventListener('agentsdock:capture-timeline', capture)
  }, [captureVisiblePosition, persistView])

  useEffect(() => {
    const focused = () => {
      if (atBottomRef.current) void useAppStore.getState().markRead(sessionId)
    }
    window.addEventListener('focus', focused)
    return () => window.removeEventListener('focus', focused)
  }, [sessionId])

  useEffect(() => {
    const localSend = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId !== sessionId) return
      historySeekLease.current += 1
      setHistoricalWindow(null)
      pendingLocalScroll.current = true
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!pendingLocalScroll.current) return
        pendingLocalScroll.current = false
        ref.current?.scrollToIndex({ index: Math.max(0, itemsLength.current - 1), align: 'end', behavior: 'auto' })
      }))
    }
    const jump = () => {
      historySeekLease.current += 1
      setHistoricalWindow(null)
      window.requestAnimationFrame(() => ref.current?.scrollToIndex({ index: Math.max(0, itemsLength.current - 1), align: 'end', behavior: 'smooth' }))
    }
    window.addEventListener('agentsdock:local-send', localSend)
    window.addEventListener('agentsdock:jump-latest', jump)
    return () => { window.removeEventListener('agentsdock:local-send', localSend); window.removeEventListener('agentsdock:jump-latest', jump) }
  }, [sessionId])

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    const findEvent = (event: Event) => {
      const eventId = (event as CustomEvent<string>).detail
      const index = projected.current.findIndex(item => timelineItemHasEvent(item, eventId))
      if (index >= 0) ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    }
    window.addEventListener('agentsdock:find-in-chat', openSearch)
    window.addEventListener('agentsdock:find-event', findEvent)
    return () => { window.removeEventListener('agentsdock:find-in-chat', openSearch); window.removeEventListener('agentsdock:find-event', findEvent) }
  }, [])

  const openSearchResult = useCallback(async (result: TimelineSearchResult) => {
    const directIndex = projected.current.findIndex(item => {
      if (timelineItemHasEvent(item, result.event_id)) return true
      const [start, end] = timelineItemSequenceRange(item)
      return start <= result.seq && result.seq <= end
    })
    if (directIndex >= 0) {
      ref.current?.scrollToIndex({ index: directIndex, align: 'center', behavior: 'auto' })
      return
    }
    const lease = ++historySeekLease.current
    setSeekingHistory(true)
    try {
      const page = await window.agentsDock.timeline.around(sessionId, result.seq, 260)
      if (lease === historySeekLease.current) setHistoricalWindow({ page, anchorSeq: result.seq })
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (lease === historySeekLease.current) setSeekingHistory(false)
    }
  }, [sessionId])

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

  const loadOlder = useCallback(async () => {
    if (!snapshot.hasMoreEvents || loadingOlderRef.current) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try { await useAppStore.getState().loadOlder() }
    finally { loadingOlderRef.current = false; setLoadingOlder(false) }
  }, [snapshot.hasMoreEvents])

  const filesFromDrop = (files: FileList): NativeFileRef[] => Array.from(files)
    .map(file => ({ path: window.agentsDock.files.pathForFile(file), name: file.name, size: file.size, type: file.type }))
    .filter(file => file.path)

  const findFile = useCallback(async (fileId: string) => {
    const event = await window.agentsDock.files.findEvent(sessionId, fileId)
    if (!event) return
    const index = projected.current.findIndex(item => item.kind === 'media' && item.files.some(file => file.id === fileId) || item.kind === 'system' && item.event.id === event.id)
    if (index >= 0) ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
  }, [sessionId])

  useEffect(() => {
    const listener = (event: Event) => void findFile((event as CustomEvent<string>).detail)
    window.addEventListener('agentsdock:find-file', listener)
    return () => window.removeEventListener('agentsdock:find-file', listener)
  }, [findFile])

  const olderRemaining = Math.max(0, (snapshot.eventsTotal ?? snapshot.events.length) - snapshot.events.length)
  const loadedLandmarks = useMemo(() => buildTimelineLandmarks(items), [items])
  const navigatorLandmarks = useMemo(
    () => mergeTimelineLandmarks(timelineIndex?.landmarks, loadedLandmarks),
    [loadedLandmarks, timelineIndex?.landmarks]
  )
  useEffect(() => {
    scheduleMinimapSync()
  }, [items, navigatorLandmarks, scheduleMinimapSync])
  const seekTimeline = useCallback(async (landmark: TimelineNavigatorLandmark) => {
    const directIndex = landmark.index ?? items.findIndex(item => {
      const [start, end] = timelineItemSequenceRange(item)
      return start <= landmark.end_seq && landmark.start_seq <= end
    })
    if (directIndex >= 0) {
      ref.current?.scrollToIndex({ index: directIndex, align: 'center', behavior: 'auto' })
      return
    }
    const lease = ++historySeekLease.current
    setSeekingHistory(true)
    try {
      const page = await window.agentsDock.timeline.around(sessionId, landmark.start_seq, 260)
      if (lease !== historySeekLease.current) return
      setHistoricalWindow({ page, anchorSeq: landmark.start_seq })
    } catch (error) {
      if (lease === historySeekLease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (lease === historySeekLease.current) setSeekingHistory(false)
    }
  }, [items, sessionId])
  const returnToLatest = useCallback(() => {
    historySeekLease.current += 1
    setSeekingHistory(false)
    setHistoricalWindow(null)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      ref.current?.scrollToIndex({ index: Math.max(0, itemsLength.current - 1), align: 'end', behavior: 'auto' })
    }))
  }, [])
  const header = useCallback(() => historicalWindow
    ? <div className="history-window"><span>Viewing an older part of this chat</span><button onClick={returnToLatest}>Return to latest</button></div>
    : snapshot.hasMoreEvents || loadingOlder
      ? <div className="history-loader"><button disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? <><LoaderCircle className="spin" size={13} /> Loading older messages</> : `Show older messages${olderRemaining ? ` · ${olderRemaining.toLocaleString()} remaining` : ''}`}</button></div>
      : <div className="history-start">Beginning of conversation</div>, [historicalWindow, loadOlder, loadingOlder, olderRemaining, returnToLatest, snapshot.hasMoreEvents])
  const components = useMemo(() => ({ Header: header, Footer: TimelineFooter }), [header])
  const itemContent = useCallback((index: number, item: RenderTimelineItem) => (
    <div
      className="virtual-row"
      data-timeline-key={item.key}
      data-timeline-index={localVirtuosoIndex(index, firstItemIndex.current, itemsLength.current)}
    >
      {item.key === unreadItemKey && <div className="unread-divider"><span>New messages</span></div>}
      <TimelineRowView item={item} sessionId={sessionId} onFindFile={findFile} />
    </div>
  ), [findFile, sessionId, unreadItemKey])

  return (
    <div
      className={`timeline ${dropActive ? 'drop-active' : ''}`}
      onDragEnter={event => { event.preventDefault(); setDropActive(true) }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false) }}
      onDrop={event => { event.preventDefault(); setDropActive(false); void useAppStore.getState().attachPaths(filesFromDrop(event.dataTransfer.files)) }}
    >
      <Virtuoso
        key={sourceKey}
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
          scheduleViewSave()
          if (value && !historicalWindow) {
            setNewBelow(false)
            if (document.hasFocus()) void useAppStore.getState().markRead(sessionId)
          }
        }}
        rangeChanged={range => {
          scheduleMinimapSync()
          scheduleViewSave()
        }}
        isScrolling={value => {
          if (!value) {
            captureVisiblePosition()
            scheduleViewSave()
          }
        }}
        startReached={() => {
          if (snapshot.hasMoreEvents && !historicalWindow) void loadOlder()
        }}
        components={components}
        itemContent={itemContent}
      />
      {navigatorLandmarks.length > 2 && <TimelineMinimap
        ref={minimapRef}
        landmarks={navigatorLandmarks}
        onSeek={seekTimeline}
      />}
      {searchOpen && <div className="timeline-search-panel">
        <div className="timeline-search">
          {searchLoading ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}
          <input autoFocus value={searchQuery} placeholder="Search full chat history" onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); submitSearch(event.shiftKey ? -1 : 1) }
            if (event.key === 'ArrowDown') { event.preventDefault(); moveSearch(1) }
            if (event.key === 'ArrowUp') { event.preventDefault(); moveSearch(-1) }
            if (event.key === 'Escape') setSearchOpen(false)
          }} />
          <span>{searchResults.length ? `${searchCursor + 1}/${searchResults.length}` : searchQuery.trim().length >= 2 && !searchLoading ? '0/0' : ''}</span>
          <button title="Previous" onClick={() => moveSearch(-1)}><ArrowUp size={13} /></button>
          <button title="Next" onClick={() => moveSearch(1)}><ArrowDown size={13} /></button>
          <button title="Close" onClick={() => setSearchOpen(false)}><X size={13} /></button>
        </div>
        {searchQuery.trim().length >= 2 && <div className="timeline-search-results">
          {visibleSearchResults.map((result, offset) => {
            const index = searchWindowStart + offset
            return <button className={index === searchCursor ? 'active' : ''} key={`${result.event_id}:${result.seq}`} onClick={() => openSearchAt(index)}>
            <span><strong>{searchRoleLabel(result.role)}</strong><time>{formatSearchTime(result.ts)}</time></span>
            <small>{result.snippet}</small>
          </button>})}
          {!searchLoading && !searchResults.length && <p>No matches in this chat.</p>}
          {searchResults.length > 12 && <p>Showing {searchWindowStart + 1}–{Math.min(searchResults.length, searchWindowStart + 12)} of {searchResults.length} · use Enter or arrows</p>}
        </div>}
      </div>}
      {!historicalWindow && !atBottom && <button className={`latest-button ${newBelow ? 'has-new' : ''}`} onClick={() => ref.current?.scrollToIndex({ index: Math.max(0, items.length - 1), align: 'end', behavior: 'smooth' })}><ArrowDown size={14} />{newBelow ? 'New' : ''}</button>}
      {seekingHistory && <div className="timeline-seeking"><LoaderCircle className="spin" size={13} /> Opening that point</div>}
      {dropActive && <div className="timeline-drop"><Paperclip size={24} /> Drop files anywhere to attach</div>}
    </div>
  )
}

function TimelineFooter() { return <div className="timeline-end" /> }

function rememberViewState(state: ViewState): void {
  timelineViewStates.delete(state.sessionId)
  timelineViewStates.set(state.sessionId, state)
  while (timelineViewStates.size > MAX_SAVED_TIMELINES) {
    const oldest = timelineViewStates.keys().next().value as string | undefined
    if (!oldest) break
    timelineViewStates.delete(oldest)
  }
}

export function sameTimelineKeys(keys: string[], items: RenderTimelineItem[]): boolean {
  return keys.length === items.length && keys.every((key, index) => key === items[index]?.key)
}

function searchRoleLabel(role: TimelineSearchResult['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Assistant'
  if (role === 'trace') return 'Reasoning'
  if (role === 'job') return 'Job'
  if (role === 'file') return 'File'
  if (role === 'error') return 'Error'
  return 'System'
}

function formatSearchTime(value?: string | null): string {
  return value ? formatTime(value) : ''
}

function timelineItemHasEvent(item: RenderTimelineItem, eventId: string): boolean {
  if (item.kind === 'system') return item.event.id === eventId
  if (item.kind === 'job') return item.events.some(event => event.id === eventId)
  if (item.kind === 'message') return item.events.some(event => event.id === eventId)
  if (item.kind === 'trace') return item.events.some(event => event.id === eventId)
  return item.files.some(file => file.event_id === eventId)
}

function timelineEvents(item: RenderTimelineItem): import('@shared/types').Event[] {
  if (item.kind === 'system') return [item.event]
  if (item.kind === 'job') return item.events
  if (item.kind === 'message') return item.events
  if (item.kind === 'trace') return item.events
  return []
}

function timelineItemSequenceRange(item: RenderTimelineItem): [number, number] {
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

function timelineIndexAtViewportCenter(scroller: HTMLElement, firstItemIndex: number, itemCount: number): number | null {
  if (!itemCount) return null
  const bounds = scroller.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const x = Math.min(bounds.right - 8, Math.max(bounds.left + 48, bounds.left + bounds.width / 2))
  const center = bounds.top + bounds.height / 2
  const probes = [center, center - 32, center + 32, center - 96, center + 96]
  for (const y of probes) {
    const sampleY = Math.min(bounds.bottom - 2, Math.max(bounds.top + 2, y))
    for (const element of document.elementsFromPoint(x, sampleY)) {
      const row = element.closest<HTMLElement>('[data-timeline-index]')
      if (!row || !scroller.contains(row)) continue
      const index = Number(row.dataset.timelineIndex)
      if (Number.isFinite(index)) return localVirtuosoIndex(index, firstItemIndex, itemCount)
    }
  }
  return null
}
