import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rows2,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { Session, TerminalAction, TerminalConnectionState, TerminalWindow } from '../../../shared/types'
import { useAppStore } from '../store/app-store'

export function TerminalWorkspace({ session, onClose }: { session: Session; onClose?: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const actionBusyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('connecting')
  const [connectionName, setConnectionName] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmKill, setConfirmKill] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const refreshWindows = useCallback(async () => {
    try {
      const snapshot = await window.agentsDock.terminal.windows(session.id)
      setWindows(snapshot.windows)
      if (snapshot.name) setConnectionName(snapshot.name)
    } catch (error) {
      setConnectionError(errorText(error))
    }
  }, [session.id])

  const runAction = useCallback(async (action: TerminalAction, target?: string) => {
    if (actionBusyRef.current) return
    actionBusyRef.current = true
    setActionBusy(true)
    try {
      const snapshot = await window.agentsDock.terminal.action(session.id, action, target)
      setWindows(snapshot.windows)
      setConnectionError(null)
      terminalRef.current?.focus()
    } catch (error) {
      const message = errorText(error)
      setConnectionError(message)
      useAppStore.getState().setError(message)
    } finally {
      actionBusyRef.current = false
      setActionBusy(false)
    }
  }, [session.id])

  const connect = useCallback(async () => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit) return
    try {
      fit.fit()
      await window.agentsDock.terminal.connect(session.id, {
        cwd: session.cwd,
        columns: terminal.cols,
        rows: terminal.rows
      })
    } catch (error) {
      setConnectionState('error')
      setConnectionError(errorText(error))
    }
  }, [session.cwd, session.id])

  useEffect(() => {
    if (connectionState !== 'connected') return
    const timer = window.setInterval(() => void refreshWindows(), 2_000)
    return () => window.clearInterval(timer)
  }, [connectionState, refreshWindows])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1.18,
      letterSpacing: 0,
      macOptionIsMeta: true,
      scrollback: 20_000,
      smoothScrollDuration: 0,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(new WebLinksAddon((_event, uri) => void window.agentsDock.native.openExternal(uri)))
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit
    searchRef.current = search

    const data = terminal.onData(value => window.agentsDock.terminal.write(session.id, value))
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.metaKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c' && terminal.hasSelection()) {
        void window.agentsDock.native.writeClipboard(terminal.getSelection())
        return false
      }
      if (key === 'v') {
        void window.agentsDock.native.readClipboard().then(value => {
          if (value) window.agentsDock.terminal.write(session.id, value)
        })
        return false
      }
      if (key === 'f') {
        setSearchOpen(true)
        return false
      }
      if (key === 'w' && onCloseRef.current) {
        onCloseRef.current?.()
        return false
      }
      if (key === 't') {
        if (event.shiftKey) {
          onCloseRef.current?.()
          return false
        }
        void runAction('new-window')
        return false
      }
      if (key === 'd') {
        void runAction(event.shiftKey ? 'split-down' : 'split-right')
        return false
      }
      if (key === 'k') {
        terminal.clear()
        return false
      }
      return true
    })

    const removeDataListener = window.agentsDock.events.on('terminal:data', payload => {
      if (payload.sessionId === session.id) terminal.write(payload.data)
    })
    const removeStateListener = window.agentsDock.events.on('terminal:state', payload => {
      if (payload.sessionId !== session.id) return
      setConnectionState(payload.state)
      setConnectionError(payload.error ?? null)
      if (payload.name) setConnectionName(payload.name)
      if (payload.state === 'connected') {
        terminal.focus()
        void refreshWindows()
      }
    })
    const find = () => setSearchOpen(true)
    window.addEventListener('agentsdock:find-in-chat', find)

    let resizeFrame = 0
    let lastSize = ''
    const fitTerminal = () => {
      resizeFrame = 0
      try {
        fit.fit()
        const size = `${terminal.cols}x${terminal.rows}`
        if (size !== lastSize) {
          lastSize = size
          window.agentsDock.terminal.resize(session.id, terminal.cols, terminal.rows)
        }
      } catch { /* the host may be between layouts */ }
    }
    const observer = new ResizeObserver(() => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fitTerminal)
    })
    observer.observe(host)
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    resizeFrame = requestAnimationFrame(() => {
      fitTerminal()
      void connect()
    })

    return () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      themeObserver.disconnect()
      data.dispose()
      removeDataListener()
      removeStateListener()
      window.removeEventListener('agentsdock:find-in-chat', find)
      void window.agentsDock.terminal.disconnect(session.id)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [connect, refreshWindows, runAction, session.id])

  const searchNext = (previous = false) => {
    if (!searchQuery) return
    const options = { incremental: !previous, caseSensitive: false }
    if (previous) searchRef.current?.findPrevious(searchQuery, options)
    else searchRef.current?.findNext(searchQuery, options)
  }
  const copy = () => {
    const selection = terminalRef.current?.getSelection()
    if (selection) void window.agentsDock.native.writeClipboard(selection)
  }
  const paste = () => void window.agentsDock.native.readClipboard().then(value => {
    if (value) window.agentsDock.terminal.write(session.id, value)
  })
  const killSession = async () => {
    setConfirmKill(false)
    try {
      await window.agentsDock.terminal.kill(session.id)
      terminalRef.current?.clear()
      terminalRef.current?.write('\r\n\x1b[2mTerminal session ended. Reconnect to create a fresh one.\x1b[0m\r\n')
      setWindows([])
      setConnectionState('disconnected')
      setConnectionName(null)
    } catch (error) {
      const message = errorText(error)
      setConnectionError(message)
      useAppStore.getState().setError(message)
    }
  }
  const closeWindow = (index: number) => {
    if (windows.length <= 1) {
      setConfirmKill(true)
      return
    }
    void runAction('kill-window', String(index))
  }

  return <section className="terminal-workspace">
    <header className="terminal-toolbar">
      <div className="terminal-window-tabs" role="tablist" aria-label="Tmux windows">
        {windows.length ? windows.map(tmuxWindow => <div
          key={tmuxWindow.id}
          className={`terminal-window-tab${tmuxWindow.active ? ' active' : ''}`}
        >
          <button
            className="terminal-window-select"
            role="tab"
            aria-selected={tmuxWindow.active}
            title={`${tmuxWindow.name} · ${tmuxWindow.panes} ${tmuxWindow.panes === 1 ? 'pane' : 'panes'}`}
            onClick={() => void runAction('select-window', String(tmuxWindow.index))}
          >
            <span className="terminal-window-index">{tmuxWindow.index}</span>
            <span className="terminal-window-name">{tmuxWindow.name}</span>
            {tmuxWindow.panes > 1 && <small>{tmuxWindow.panes}</small>}
          </button>
          <button
            className="terminal-window-close"
            aria-label={`Close ${tmuxWindow.name} tmux window`}
            title={windows.length === 1
              ? 'Close final window and end tmux session'
              : `Close tmux window${tmuxWindow.panes > 1 ? ` and its ${tmuxWindow.panes} panes` : ''}`}
            disabled={actionBusy}
            onClick={event => {
              event.stopPropagation()
              closeWindow(tmuxWindow.index)
            }}
          ><X size={12} /></button>
        </div>) : <div className="terminal-window-placeholder"><span className={`terminal-state-dot ${connectionState}`} />{connectionName || 'Terminal'}</div>}
        <button className="terminal-add-window" title="New tmux window (⌘T)" onClick={() => void runAction('new-window')}><Plus size={14} /></button>
      </div>
      <div className="terminal-tools">
        {actionBusy && <LoaderCircle className="spin" size={13} />}
        <button className="icon-button" title="Previous tmux window" onClick={() => void runAction('previous-window')}><ChevronLeft size={15} /></button>
        <button className="icon-button" title="Next tmux window" onClick={() => void runAction('next-window')}><ChevronRight size={15} /></button>
        <button className="icon-button" title="Split pane right (⌘D)" onClick={() => void runAction('split-right')}><Columns2 size={15} /></button>
        <button className="icon-button" title="Split pane down (⇧⌘D)" onClick={() => void runAction('split-down')}><Rows2 size={15} /></button>
        <button className="icon-button" title="Find in terminal (⌘F)" onClick={() => setSearchOpen(value => !value)}><Search size={15} /></button>
        <button className="icon-button" title="Reconnect terminal" onClick={() => void connect()}><RefreshCw size={15} /></button>
        <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button" title="Terminal actions"><MoreHorizontal size={16} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item className="menu-item" onSelect={() => void runAction('kill-pane')}><X size={14} /> Close active pane</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item danger" onSelect={() => setConfirmKill(true)}><Trash2 size={14} /> Kill tmux session</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        {onClose && <><span className="terminal-tool-separator" /><button className="icon-button terminal-panel-close" aria-label="Close terminal panel" title="Close terminal panel (⌘W; tmux keeps running)" onClick={onClose}><X size={15} /></button></>}
      </div>
    </header>
    {searchOpen && <div className="terminal-search">
      <Search size={14} /><input autoFocus value={searchQuery} placeholder="Find" onChange={event => { setSearchQuery(event.target.value); if (event.target.value) searchRef.current?.findNext(event.target.value, { incremental: true, caseSensitive: false }) }} onKeyDown={event => { if (event.key === 'Enter') searchNext(event.shiftKey); if (event.key === 'Escape') { setSearchOpen(false); searchRef.current?.clearDecorations(); terminalRef.current?.focus() } }} />
      <button title="Previous match" onClick={() => searchNext(true)}><ChevronLeft size={14} /></button><button title="Next match" onClick={() => searchNext()}><ChevronRight size={14} /></button><button title="Close search" onClick={() => { setSearchOpen(false); searchRef.current?.clearDecorations(); terminalRef.current?.focus() }}><X size={14} /></button>
    </div>}
    {confirmKill && <div className="terminal-confirm"><span>Kill this chat’s persistent tmux session and every process inside it?</span><button onClick={() => setConfirmKill(false)}>Cancel</button><button className="danger-button" onClick={() => void killSession()}>Kill session</button></div>}
    {connectionError && <button className="terminal-error" onClick={() => setConnectionError(null)}>{connectionError}<X size={13} /></button>}
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild><div className="terminal-host" ref={hostRef} /></ContextMenu.Trigger>
      <ContextMenu.Portal><ContextMenu.Content className="menu-content terminal-context-menu">
        <ContextMenu.Item className="menu-item" onSelect={copy}><Copy size={14} /> Copy</ContextMenu.Item>
        <ContextMenu.Item className="menu-item" onSelect={paste}>Paste</ContextMenu.Item>
        <ContextMenu.Separator className="menu-separator" />
        <ContextMenu.Item className="menu-item" onSelect={() => terminalRef.current?.selectAll()}>Select all</ContextMenu.Item>
        <ContextMenu.Item className="menu-item" onSelect={() => terminalRef.current?.clear()}>Clear scrollback</ContextMenu.Item>
      </ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>
  </section>
}

function terminalTheme(): ITheme {
  if (document.documentElement.dataset.theme === 'light') {
    return {
      background: '#fbfbfa', foreground: '#242422', cursor: '#1675d1', cursorAccent: '#fbfbfa',
      selectionBackground: '#a9d2f4aa', black: '#252523', red: '#c43732', green: '#287f42', yellow: '#9a6b0b',
      blue: '#1769aa', magenta: '#8755a8', cyan: '#167a83', white: '#e9e9e6', brightBlack: '#74746f',
      brightRed: '#e0443e', brightGreen: '#369b54', brightYellow: '#b98210', brightBlue: '#2184d7',
      brightMagenta: '#a268c4', brightCyan: '#2098a2', brightWhite: '#ffffff'
    }
  }
  return {
    background: '#111212', foreground: '#e7e7e4', cursor: '#58a6ff', cursorAccent: '#111212',
    selectionBackground: '#2f628dcc', black: '#111212', red: '#ff625d', green: '#39d98a', yellow: '#f5b83d',
    blue: '#58a6ff', magenta: '#b7a0ff', cyan: '#4fcbd3', white: '#d8d8d5', brightBlack: '#73736f',
    brightRed: '#ff817d', brightGreen: '#62e6a6', brightYellow: '#ffd06b', brightBlue: '#82bdff',
    brightMagenta: '#d0c0ff', brightCyan: '#78e4e9', brightWhite: '#ffffff'
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
