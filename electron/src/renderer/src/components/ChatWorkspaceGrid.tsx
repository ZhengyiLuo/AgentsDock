import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { Columns2, Columns3, Grid2X2, PanelLeft, Square } from 'lucide-react'
import type { Session } from '@shared/types'
import { t, useLocale } from '../lib/i18n'
import { CHAT_PANE_IDS, type ChatPane as ChatPaneId } from '../lib/chat-panes'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'
import { useAppStore } from '../store/app-store'
import { ChatPane } from './ChatPane'
import { ChatWorkspaceTabs } from './ChatWorkspaceTabs'
import './ChatWorkspaceGrid.css'

type ResizeAxis = 'column' | 'row' | 'first' | 'second'

const boundRatio = (value: number) => Math.max(25, Math.min(75, value))

export function ChatWorkspaceGrid({ sidebarVisible, terminalOpen, onSidebarToggle, onTerminalToggle, sideChat }: {
  sidebarVisible: boolean
  terminalOpen: boolean
  onSidebarToggle: () => void
  onTerminalToggle: () => void
  sideChat: (session: Session) => ReactNode
}) {
  useLocale()
  const workspaces = useAppStore(state => state.chatWorkspaces)
  const activeId = useAppStore(state => state.activeChatWorkspaceId)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const panes = useAppStore(state => state.chatPanes)
  const count = useAppStore(state => state.chatPaneCount)
  const focused = useAppStore(state => state.focusedChatPane)
  const sessions = useAppStore(state => state.sessions)
  const active = workspaces.find(workspace => workspace.id === activeId)
  const threeColumns = count === 3 && active?.threePaneLayout === 'columns'
  const [ratios, setRatios] = useState({
    column: (active?.columnRatio ?? 0.5) * 100, row: (active?.rowRatio ?? 0.5) * 100,
    first: (active?.threeColumnRatios?.[0] ?? 1 / 3) * 100, second: (active?.threeColumnRatios?.[1] ?? 2 / 3) * 100
  })
  const ratioRef = useRef(ratios)
  const gridRef = useRef<HTMLDivElement>(null)
  const finishResizeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const next = {
      column: (active?.columnRatio ?? 0.5) * 100, row: (active?.rowRatio ?? 0.5) * 100,
      first: (active?.threeColumnRatios?.[0] ?? 1 / 3) * 100, second: (active?.threeColumnRatios?.[1] ?? 2 / 3) * 100
    }
    ratioRef.current = next
    setRatios(next)
  }, [activeId, profileId, profileGeneration, serverIdentity, count, threeColumns, active?.columnRatio, active?.rowRatio, active?.threeColumnRatios])
  useEffect(() => () => finishResizeRef.current?.(), [activeId, profileId, profileGeneration, serverIdentity, count, threeColumns])
  useEffect(() => {
    notifyTimelineViewportLayout('begin')
    const frame = requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    return () => cancelAnimationFrame(frame)
  }, [count, threeColumns, activeId])

  const bounds = (axis: ResizeAxis) => axis === 'first' ? [20, ratioRef.current.second - 20]
    : axis === 'second' ? [ratioRef.current.first + 20, 80] : [25, 75]
  const clampRatio = (axis: ResizeAxis, value: number) => {
    if (axis === 'column' || axis === 'row') return boundRatio(value)
    const [min, max] = bounds(axis)
    return Math.max(min, Math.min(max, value))
  }
  const ownsResize = useCallback(() => {
    const state = useAppStore.getState()
    return state.activeChatWorkspaceId === activeId && state.activeProfileId === profileId
      && state.profileGeneration === profileGeneration && state.chatPaneCount === count
      && (state.chatWorkspaces.find(workspace => workspace.id === activeId)?.threePaneLayout === 'columns' && count === 3) === threeColumns
      && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === serverIdentity
  }, [activeId, profileId, profileGeneration, serverIdentity, count, threeColumns])
  const commitRatio = (axis: ResizeAxis, value: number) => {
    // A departing drag must not resize or persist into another workspace or profile.
    if (!ownsResize()) return
    const next = { ...ratioRef.current, [axis]: clampRatio(axis, value) }
    ratioRef.current = next
    setRatios(next)
    const state = useAppStore.getState()
    state.setChatWorkspaceRatios(axis === 'first' || axis === 'second'
      ? { threeColumnRatios: [next.first / 100, next.second / 100] }
      : axis === 'column' ? { columnRatio: next.column / 100 } : { rowRatio: next.row / 100 })
  }

  const beginResize = (event: PointerEvent, axis: ResizeAxis) => {
    if (event.button !== 0 || !gridRef.current) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
    finishResizeRef.current?.()
    notifyTimelineViewportLayout('begin')
    let frame: number | null = null
    let latest: globalThis.PointerEvent | null = null
    let finished = false
    const paint = () => {
      frame = null
      const rect = gridRef.current?.getBoundingClientRect()
      if (!latest || !rect || !ownsResize()) return
      const value = axis === 'row' ? (latest.clientY - rect.top) / rect.height : (latest.clientX - rect.left) / rect.width
      const next = { ...ratioRef.current, [axis]: clampRatio(axis, value * 100) }
      ratioRef.current = next
      setRatios(next)
      notifyTimelineViewportLayout('update')
    }
    const move = (pointer: globalThis.PointerEvent) => {
      latest = pointer
      if (frame === null) frame = requestAnimationFrame(paint)
    }
    const finish = () => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame !== null) { cancelAnimationFrame(frame); paint() }
      commitRatio(axis, ratioRef.current[axis])
      document.body.classList.remove('chat-split-resizing')
      notifyTimelineViewportLayout('end')
      finishResizeRef.current = null
    }
    finishResizeRef.current = finish
    document.body.classList.add('chat-split-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  const separator = (axis: ResizeAxis) => <div
    className={`workspace-grid-divider ${axis === 'row' ? 'row' : 'column'}${axis === 'first' || axis === 'second' ? ` ${axis}` : ''}`}
    role="separator"
    aria-label={t(axis === 'first' ? 'chatWorkspace.resizeFirstColumn' : axis === 'second' ? 'chatWorkspace.resizeLastColumn' : axis === 'column' ? 'chatWorkspace.resizeColumns' : 'chatWorkspace.resizeRows')}
    aria-orientation={axis === 'row' ? 'horizontal' : 'vertical'}
    aria-valuemin={Math.round(bounds(axis)[0])} aria-valuemax={Math.round(bounds(axis)[1])} aria-valuenow={Math.round(ratios[axis])}
    tabIndex={0}
    onPointerDown={event => beginResize(event, axis)}
    onDoubleClick={() => commitRatio(axis, axis === 'first' ? 100 / 3 : axis === 'second' ? 200 / 3 : 50)}
    onKeyDown={event => {
      const minus = axis === 'row' ? 'ArrowUp' : 'ArrowLeft'
      const plus = axis === 'row' ? 'ArrowDown' : 'ArrowRight'
      if (![minus, plus, 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      notifyTimelineViewportLayout('begin')
      commitRatio(axis, event.key === 'Home' ? bounds(axis)[0] : event.key === 'End' ? bounds(axis)[1] : ratios[axis] + (event.key === plus ? 5 : -5))
      requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    }}
  />

  return <div className="chat-grid-workspace">
    <header className="workspace-tabs-bar">
      {!sidebarVisible && <button type="button" className="icon-button" onClick={onSidebarToggle} aria-label={t('chatWorkspace.showSidebar')}><PanelLeft size={16} /></button>}
      <ChatWorkspaceTabs key={JSON.stringify([profileId, profileGeneration, serverIdentity])} />
      <div className="workspace-layout-picker" role="group" aria-label={t('chatWorkspace.layout')}>
        {([1, 2, 3, 'columns', 4] as const).map(value => <button key={value} type="button" className="icon-button"
          aria-label={value === 'columns' ? t('chatWorkspace.threeColumns') : t('chatWorkspace.paneCount', { count: value })} title={value === 'columns' ? t('chatWorkspace.threeColumns') : t('chatWorkspace.paneCount', { count: value })}
          aria-pressed={value === 'columns' ? threeColumns : count === value && !threeColumns}
          onClick={() => value === 'columns' || value === 3
            ? useAppStore.getState().setChatThreePaneLayout(value === 'columns' ? 'columns' : 'split')
            : useAppStore.getState().setChatPaneCount(value)}>
          {value === 1 ? <Square size={15} /> : value === 2 ? <Columns2 size={15} /> : value === 'columns' ? <Columns3 size={15} /> : value === 4 ? <Grid2X2 size={15} /> : <span className="three-pane-icon" aria-hidden="true"><span /><span /><span /></span>}
        </button>)}
      </div>
    </header>
    <div ref={gridRef} className={`workspace-chat-grid chat-split-view${count >= 3 && !threeColumns ? ' short' : ''}`} data-pane-count={count} data-three-pane-layout={threeColumns ? 'columns' : 'split'}
      style={{ '--workspace-column': `${ratios.column}%`, '--workspace-row': `${ratios.row}%`,
        '--workspace-first-column': `${ratios.first}%`, '--workspace-second-column': `${ratios.second}%` } as CSSProperties}>
      {CHAT_PANE_IDS.slice(0, count).map(pane => {
        const session = sessions.find(candidate => candidate.id === panes[pane])
        return <div key={session?.id ?? `empty:${pane}`} className="workspace-pane-slot" data-pane={pane}>
          {session ? <ChatPane pane={pane} session={session} focused={focused === pane} split={count > 1}
            sidebarVisible={sidebarVisible} terminalOpen={focused === pane && terminalOpen}
            onSidebarToggle={onSidebarToggle} onTerminalToggle={onTerminalToggle} sideChat={sideChat(session)} />
            : <EmptyChatPane pane={pane} focused={focused === pane} />}
        </div>
      })}
      {threeColumns ? <>{separator('first')}{separator('second')}</> : <>
        {count >= 2 && separator('column')}
        {count >= 3 && separator('row')}
      </>}
    </div>
  </div>
}

function EmptyChatPane({ pane, focused }: { pane: ChatPaneId; focused: boolean }) {
  const sessions = useAppStore(state => state.sessions)
  const panes = useAppStore(state => state.chatPanes)
  const [query, setQuery] = useState('')
  const candidates = sessions.filter(session => !session.archived && !Object.values(panes).includes(session.id)
    && `${session.title} ${session.cwd}`.toLowerCase().includes(query.toLowerCase()))
  return <section className={`empty-chat-pane${focused ? ' focused' : ''}`} data-chat-pane={pane} tabIndex={-1}
    onPointerDownCapture={() => useAppStore.getState().focusChatPane(pane)} onFocusCapture={() => useAppStore.getState().focusChatPane(pane)}>
    <strong>{t('chatWorkspace.chooseChat')}</strong>
    <input type="search" aria-label={t('chatWorkspace.search')} placeholder={t('chatWorkspace.search')}
      value={query} onChange={event => setQuery(event.target.value)} />
    <div className="empty-pane-chat-list">
      {candidates.map(session => <button type="button" key={session.id} onClick={() => void useAppStore.getState().selectSessionInPane(session.id, pane)}>
        <span>{session.title}</span><small>{session.backend}</small>
      </button>)}
      {!candidates.length && <span>{t('chatWorkspace.noChats')}</span>}
    </div>
  </section>
}
