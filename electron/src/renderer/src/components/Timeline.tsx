import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown, ArrowUp, LoaderCircle, Paperclip, Search, X } from 'lucide-react'
import type { NativeFileRef, SessionSnapshot, ViewState } from '@shared/types'
import { isAgentVisibleEvent, messageText, projectTimeline, reconcileRenderTimelineItems, reconcileTimelineItems, renderTimelineItems, type RenderTimelineItem, type TimelineItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'

const timelineViewStates = new Map<string, ViewState>()
const FIRST_INDEX = 1_000_000
const MAX_SAVED_TIMELINES = 16

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
  return <TimelineSession key={`${sessionId}:${snapshot.generation ?? 0}`} sessionId={sessionId} snapshot={snapshot} />
}

function TimelineSession({ sessionId, snapshot }: { sessionId: string; snapshot: SessionSnapshot }) {
  const ref = useRef<VirtuosoHandle>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const semanticProjected = useRef<TimelineItem[]>([])
  const projected = useRef<RenderTimelineItem[]>([])
  const firstItemIndex = useRef(FIRST_INDEX)
  const initialViewState = useRef(timelineViewStates.get(sessionId) ?? snapshot.viewState).current
  const previousLastKey = useRef<string | null>(null)
  const atBottomRef = useRef(initialViewState?.atBottom ?? true)
  const topItemIdRef = useRef<string | null>(initialViewState?.topItemId ?? null)
  const topOffsetRef = useRef(initialViewState?.topOffset ?? 0)
  const distanceFromBottomRef = useRef(initialViewState?.distanceFromBottom ?? 0)
  const viewSaveTimer = useRef<number | null>(null)
  const loadingOlderRef = useRef(false)
  const wasAtTop = useRef(false)
  const pendingLocalScroll = useRef(false)
  const itemsLength = useRef(0)
  const [atBottom, setAtBottom] = useState(initialViewState?.atBottom ?? true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)

  const items = useMemo(() => {
    const previous = projected.current
    const semantic = reconcileTimelineItems(semanticProjected.current, projectTimeline(snapshot.events, snapshot.files))
    semanticProjected.current = semantic
    const next = reconcileRenderTimelineItems(previous, renderTimelineItems(semantic))
    if (previous.length && next.length) {
      const oldFirst = previous[0].key
      const prepended = next.findIndex(item => item.key === oldFirst)
      if (prepended > 0) firstItemIndex.current -= prepended
    }
    projected.current = next
    return next
  }, [snapshot.events, snapshot.files])
  itemsLength.current = items.length
  const [initialLocation] = useState<number | { index: number | 'LAST'; align: 'start' | 'end'; offset?: number } | undefined>(() => {
    const saved = initialViewState
    if (saved?.atBottom === false && saved.topItemId) {
      const index = items.findIndex(item => item.key === saved.topItemId)
      if (index >= 0) return { index, align: 'start', offset: -(saved.topOffset ?? 0) }
      return { index: 0, align: 'start' }
    }
    return { index: 'LAST', align: 'end' }
  })

  const captureVisiblePosition = useCallback(() => {
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
  }, [items])

  const persistView = useCallback(() => {
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
  }, [sessionId])
  const scheduleViewSave = useCallback(() => {
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current)
    viewSaveTimer.current = window.setTimeout(() => {
      viewSaveTimer.current = null
      captureVisiblePosition()
      persistView()
    }, 500)
  }, [captureVisiblePosition, persistView])

  const searchMatches = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase()
    if (!needle) return []
    return items.flatMap((item, index) => timelineSearchText(item).toLocaleLowerCase().includes(needle) ? [index] : [])
  }, [items, searchQuery])
  const unreadItemKey = useMemo(() => {
    const session = snapshot.session
    const lastRead = session.last_read_agent_event_seq ?? 0
    const hasUnread = Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > lastRead
    if (!hasUnread) return null
    return items.find(item => timelineEvents(item).some(event => event.seq > lastRead && isAgentVisibleEvent(event)) || item.kind === 'media' && item.seq > lastRead)?.key ?? null
  }, [items, snapshot.session.last_read_agent_event_seq, snapshot.session.latest_agent_event_seq, snapshot.session.manual_unread])

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
      pendingLocalScroll.current = true
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!pendingLocalScroll.current) return
        pendingLocalScroll.current = false
        ref.current?.scrollToIndex({ index: Math.max(0, itemsLength.current - 1), align: 'end', behavior: 'auto' })
      }))
    }
    const jump = () => ref.current?.scrollToIndex({ index: Math.max(0, itemsLength.current - 1), align: 'end', behavior: 'smooth' })
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

  useEffect(() => {
    setSearchCursor(0)
    if (searchMatches[0] != null) ref.current?.scrollToIndex({ index: searchMatches[0], align: 'center', behavior: 'smooth' })
  }, [searchQuery, searchMatches])

  const moveSearch = (direction: 1 | -1) => {
    if (!searchMatches.length) return
    const cursor = (searchCursor + direction + searchMatches.length) % searchMatches.length
    setSearchCursor(cursor)
    ref.current?.scrollToIndex({ index: searchMatches[cursor], align: 'center', behavior: 'smooth' })
  }

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
  const header = useCallback(() => snapshot.hasMoreEvents || loadingOlder
    ? <div className="history-loader"><button disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? <><LoaderCircle className="spin" size={13} /> Loading older messages</> : `Show older messages${olderRemaining ? ` · ${olderRemaining.toLocaleString()} remaining` : ''}`}</button></div>
    : <div className="history-start">Beginning of conversation</div>, [loadOlder, loadingOlder, olderRemaining, snapshot.hasMoreEvents])
  const components = useMemo(() => ({ Header: header, Footer: TimelineFooter }), [header])
  const itemContent = useCallback((_: number, item: RenderTimelineItem) => (
    <div className="virtual-row" data-timeline-key={item.key}>
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
        ref={ref}
        data={items}
        firstItemIndex={firstItemIndex.current}
        computeItemKey={(_, item) => item.key}
        defaultItemHeight={170}
        increaseViewportBy={{ top: 260, bottom: 260 }}
        initialTopMostItemIndex={initialLocation}
        scrollerRef={node => { scroller.current = node instanceof HTMLElement ? node : null }}
        skipAnimationFrameInResizeObserver
        followOutput={false}
        atBottomThreshold={80}
        atBottomStateChange={value => {
          atBottomRef.current = value
          if (value) distanceFromBottomRef.current = 0
          setAtBottom(value)
          scheduleViewSave()
          if (value) {
            setNewBelow(false)
            if (document.hasFocus()) void useAppStore.getState().markRead(sessionId)
          }
        }}
        rangeChanged={range => {
          scheduleViewSave()
        }}
        isScrolling={value => {
          if (!value) {
            captureVisiblePosition()
            scheduleViewSave()
          }
        }}
        atTopStateChange={value => {
          if (value && !wasAtTop.current && snapshot.hasMoreEvents) void loadOlder()
          wasAtTop.current = value
        }}
        components={components}
        itemContent={itemContent}
      />
      {searchOpen && <div className="timeline-search"><Search size={14} /><input autoFocus value={searchQuery} placeholder="Find in loaded messages" onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') moveSearch(event.shiftKey ? -1 : 1); if (event.key === 'Escape') setSearchOpen(false) }} /><span>{searchMatches.length ? `${searchCursor + 1}/${searchMatches.length}` : searchQuery ? '0/0' : ''}</span><button title="Previous" onClick={() => moveSearch(-1)}><ArrowUp size={13} /></button><button title="Next" onClick={() => moveSearch(1)}><ArrowDown size={13} /></button><button title="Close" onClick={() => setSearchOpen(false)}><X size={13} /></button></div>}
      {!atBottom && <button className={`latest-button ${newBelow ? 'has-new' : ''}`} onClick={() => ref.current?.scrollToIndex({ index: Math.max(0, items.length - 1), align: 'end', behavior: 'smooth' })}><ArrowDown size={14} />{newBelow ? 'New' : ''}</button>}
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

function timelineSearchText(item: RenderTimelineItem): string {
  if (item.kind === 'system') return messageText(item.event)
  if (item.kind === 'job') return item.events.map(event => [event.text, event.message, event.result_text].filter(Boolean).join('\n')).join('\n')
  if (item.kind === 'message') return [item.event.prompt, item.event.text, item.event.result_text, item.event.message, item.event.output].filter(Boolean).join('\n')
  if (item.kind === 'trace') return item.events.map(event => [event.text, event.message, event.output].filter(Boolean).join('\n')).join('\n')
  return item.files.map(file => [file.title, file.filename, file.text].filter(Boolean).join(' ')).join('\n')
}

function timelineItemHasEvent(item: RenderTimelineItem, eventId: string): boolean {
  if (item.kind === 'system') return item.event.id === eventId
  if (item.kind === 'job') return item.events.some(event => event.id === eventId)
  if (item.kind === 'message') return item.event.id === eventId
  if (item.kind === 'trace') return item.events.some(event => event.id === eventId)
  return item.files.some(file => file.event_id === eventId)
}

function timelineEvents(item: RenderTimelineItem): import('@shared/types').Event[] {
  if (item.kind === 'system') return [item.event]
  if (item.kind === 'job') return item.events
  if (item.kind === 'message') return [item.event]
  if (item.kind === 'trace') return item.events
  return []
}
