import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ALargeSmall, Check, LoaderCircle, MoreHorizontal, PanelRight, PanelRightClose, Pin, RefreshCw, Search, SquareTerminal } from 'lucide-react'
import { runtimeLabel, shortId } from '../lib/format'
import { useAppStore } from '../store/app-store'

export function ChatHeader({ terminalOpen = false, onTerminalToggle }: { terminalOpen?: boolean; onTerminalToggle?: () => void }) {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const connected = useAppStore(state => state.connected)
  const inspector = useAppStore(state => state.inspectorVisible)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const [title, setTitle] = useState(session?.title ?? '')
  useEffect(() => setTitle(session?.title ?? ''), [session?.id, session?.title])
  if (!session) return <header className="chat-header empty"><strong>AgentsDock</strong><ConnectionStatus /></header>
  const save = () => { const clean = title.trim(); if (clean && clean !== session.title) void useAppStore.getState().updateSession(session.id, { title: clean }) }
  return (
    <header className="chat-header">
      <div className="title-block">
        <div className="editable-title"><input value={title} onChange={event => setTitle(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); save() } }} /><Check size={14} /></div>
        <small>{session.backend === 'codex' ? 'Codex' : 'Claude'} · {runtimeLabel(session, catalog)} · session {shortId(session.session_id || session.codex_thread_id || session.claude_session_id)}</small>
      </div>
      <div className="header-actions">
        <button className="icon-button" title="Refresh latest" onClick={() => void useAppStore.getState().selectSession(session.id, true)}><RefreshCw size={15} /></button>
        <button className="icon-button" title="Find in chat" onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:find-in-chat'))}><Search size={15} /></button>
        <button className="icon-button" title={session.pinned ? 'Unpin chat' : 'Pin chat'} onClick={() => void useAppStore.getState().updateSession(session.id, { pinned: !session.pinned })}><Pin size={15} fill={session.pinned ? 'currentColor' : 'none'} /></button>
        <FontMenu />
        {onTerminalToggle && <button
          className={`icon-button terminal-toggle${terminalOpen ? ' active' : ''}`}
          aria-label={terminalOpen ? 'Close terminal panel' : 'Open terminal panel'}
          aria-pressed={terminalOpen}
          title={`${terminalOpen ? 'Close' : 'Open'} terminal panel (⌃\`)`}
          onClick={onTerminalToggle}
        ><SquareTerminal size={16} /></button>}
        <ConnectionStatus />
        <button className="icon-button inspector-toggle" title={`${inspector ? 'Hide' : 'Show'} right panel (⌘L)`} onClick={() => useAppStore.getState().setInspectorVisible(!inspector)}>{inspector ? <PanelRightClose size={16} /> : <PanelRight size={16} />}</button>
      </div>
    </header>
  )
}

function FontMenu() {
  const [size, setSize] = useState(14)
  const [family, setFamily] = useState('system')
  useEffect(() => {
    void Promise.all([
      window.agentsDock.preferences.get('chatFontSize', 14),
      window.agentsDock.preferences.get('chatFontFamily', 'system')
    ]).then(([savedSize, savedFamily]) => { setSize(savedSize); setFamily(savedFamily); applyFont(savedSize, savedFamily) })
  }, [])
  const update = (nextSize = size, nextFamily = family) => {
    setSize(nextSize); setFamily(nextFamily); applyFont(nextSize, nextFamily)
    void window.agentsDock.preferences.set('chatFontSize', nextSize)
    void window.agentsDock.preferences.set('chatFontFamily', nextFamily)
  }
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button" title="Chat font"><ALargeSmall size={16} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content font-menu" align="end"><DropdownMenu.Label className="menu-label">Text size</DropdownMenu.Label>{[13, 14, 15, 16, 18].map(value => <DropdownMenu.CheckboxItem className="menu-item" checked={size === value} key={value} onSelect={() => update(value, family)}>{value}px</DropdownMenu.CheckboxItem>)}<DropdownMenu.Separator className="menu-separator" /><DropdownMenu.Label className="menu-label">Typeface</DropdownMenu.Label>{[['system', 'System'], ['rounded', 'Rounded'], ['mono', 'Monospaced']].map(([value, label]) => <DropdownMenu.CheckboxItem className="menu-item" checked={family === value} key={value} onSelect={() => update(size, value)}>{label}</DropdownMenu.CheckboxItem>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}

function applyFont(size: number, family: string) {
  document.documentElement.style.setProperty('--chat-font-size', `${size}px`)
  document.documentElement.style.setProperty('--chat-font-family', family === 'mono' ? '"SFMono-Regular", Menlo, monospace' : family === 'rounded' ? 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif' : '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif')
}

export function ConnectionStatus() {
  const connected = useAppStore(state => state.connected)
  const error = useAppStore(state => state.connectionError)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const syncSessionId = useAppStore(state => state.syncSessionId)
  const selectedStatus = useAppStore(state => state.syncStatus)
  const syncError = useAppStore(state => state.syncError)
  const status = !connected
    ? 'offline'
    : selectedSessionId && syncSessionId === selectedSessionId
      ? selectedStatus
      : 'live'
  const label = status === 'live' ? 'Live'
    : status === 'syncing' ? 'Syncing'
      : status === 'reconnecting' ? 'Retrying'
        : status === 'error' ? 'Sync paused'
          : status === 'offline' ? 'Offline'
            : 'Cached'
  const tone = status === 'live' ? 'online'
    : status === 'offline' || status === 'error' ? 'offline'
      : status === 'syncing' || status === 'reconnecting' ? 'pending'
        : 'cached'
  const spinning = status === 'syncing' || status === 'reconnecting'
  const retryable = Boolean(selectedSessionId && ['cached', 'error', 'reconnecting'].includes(status))
  const activate = () => {
    if (retryable && selectedSessionId) void useAppStore.getState().selectSession(selectedSessionId, true)
    else useAppStore.getState().setModal('settings', true)
  }
  return <button type="button" className={`connection-status ${tone}`} aria-label={`Chat connection: ${label}`} title={syncError || error || (status === 'live' ? 'Live trace connected' : retryable ? 'Retry chat sync' : 'Open connection settings')} onClick={activate}>{spinning ? <LoaderCircle className="spin connection-spinner" size={11} /> : <span />}{label}<MoreHorizontal size={13} /></button>
}
