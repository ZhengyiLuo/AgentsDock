// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  ClipboardPaste,
  Columns2,
  Copy,
  LoaderCircle,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RadioTower,
  RefreshCw,
  Rows2,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { ForwardedPort, Session, TerminalAction, TerminalConnectionState, TerminalWindow } from '../../../shared/types'
import { ShortcutTooltip } from './ShortcutTooltip'
import { PortsPanel } from './PortsPanel'
import { accumulateTerminalWheel, containTerminalWheel, terminalClipboardShortcut } from '../lib/terminal-shortcuts'
import { detectTerminalPorts, type DetectedTerminalPort } from '../lib/terminal-port-detection'
import { useAppStore } from '../store/app-store'

const MAX_DETECTED_TERMINAL_PORTS = 16
const MAX_DISMISSED_TERMINAL_PORTS = 256
const MAX_OBSERVED_TERMINAL_PORTS = 256
const TERMINAL_PORT_SCAN_CHARACTERS = 2_048

export const TerminalWorkspace = memo(function TerminalWorkspace({ session, layoutHeight, onClose }: { session: Session; layoutHeight: number; onClose?: () => void }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const forwardedPorts = useAppStore(state => state.forwardedPorts)
  // Health snapshots include volatile runtime and job telemetry. Subscribing
  // xterm's owner to the whole object made unrelated background refreshes run
  // this large component again. Keep the terminal subscribed only to the
  // primitive port-forwarding facts it actually renders.
  const serverHealthAvailable = useAppStore(state => state.health !== null)
  const portForwardingAdvertised = useAppStore(state => Boolean(state.health?.capabilities?.port_forwarding_v1))
  const portForwardingAvailable = useAppStore(state => {
    const capability = state.health?.capabilities?.port_forwarding_v1
    return capability?.available === true && (capability.version ?? 0) >= 1
  })
  const portForwardingVersion = useAppStore(state => state.health?.capabilities?.port_forwarding_v1?.version ?? 0)
  const portForwardingAction = useAppStore(state => state.health?.capabilities?.port_forwarding_v1?.action ?? null)
  const portForwardingMessage = useAppStore(state => state.health?.capabilities?.port_forwarding_v1?.message ?? null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const portsTabRef = useRef<HTMLButtonElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const actionBusyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const mouseEnabledRef = useRef(false)
  const wheelRemainderRef = useRef(0)
  const requestFitRef = useRef<(reason: string) => void>(() => undefined)
  const activeSurfaceRef = useRef<'terminal' | 'ports'>('terminal')
  const terminalOutputTailRef = useRef('')
  const dismissedPortSuggestionsRef = useRef(new Set<number>())
  const observedPortSuggestionsRef = useRef(new Set<string>())
  const forwardedRemotePortsRef = useRef(new Set<number>())
  const portActionScope = useMemo(
    () => Symbol('terminal-port-action-scope'),
    [portForwardingAvailable, profileGeneration, profileId, session.id]
  )
  const activePortActionScopeRef = useRef<symbol | null>(null)
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('connecting')
  const [connectionName, setConnectionName] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [mouseEnabled, setMouseEnabled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmKill, setConfirmKill] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [activeSurface, setActiveSurface] = useState<'terminal' | 'ports'>('terminal')
  const [detectedPorts, setDetectedPorts] = useState<DetectedTerminalPort[]>([])
  const [portRefreshToken, setPortRefreshToken] = useState(0)
  const [suggestionBusy, setSuggestionBusy] = useState<number | null>(null)
  const terminalPanelId = useId()
  const portsPanelId = useId()
  const portsTabId = useId()
  const portForwardingRequiresUpdate = Boolean(
    serverHealthAvailable
    && (!portForwardingAdvertised || portForwardingVersion < 1)
  )
  const portForwardingUnavailableTitle = !serverHealthAvailable
    ? 'Server connection required'
    : portForwardingRequiresUpdate
      ? 'Server update required'
      : 'Port forwarding unavailable'
  const portForwardingUnavailableMessage = !serverHealthAvailable
    ? 'Reconnect this server profile before opening a forwarded port.'
    : portForwardingRequiresUpdate
      ? 'Update AgentsServer to a build with authenticated port forwarding.'
      : portForwardingAction
        || portForwardingMessage
        || 'This server has not enabled authenticated port forwarding.'
  const portForwardingUnavailableActionLabel = portForwardingRequiresUpdate
    ? 'Open server updates'
    : 'Open server settings'
  const forwardedPortCount = portForwardingAvailable ? forwardedPorts.length : 0

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { mouseEnabledRef.current = mouseEnabled }, [mouseEnabled])
  useLayoutEffect(() => { activeSurfaceRef.current = activeSurface }, [activeSurface])

  useLayoutEffect(() => {
    activePortActionScopeRef.current = portActionScope
    return () => {
      if (activePortActionScopeRef.current === portActionScope) activePortActionScopeRef.current = null
    }
  }, [portActionScope])

  useEffect(() => {
    terminalOutputTailRef.current = ''
    dismissedPortSuggestionsRef.current = new Set()
    observedPortSuggestionsRef.current = new Set()
    setDetectedPorts([])
    setSuggestionBusy(null)
    setActiveSurface('terminal')
  }, [profileGeneration, profileId, session.id])

  useEffect(() => {
    const visiblePorts = portForwardingAvailable ? forwardedPorts : []
    forwardedRemotePortsRef.current = new Set(visiblePorts.map(port => port.remotePort))
    setDetectedPorts(current => current.filter(port => !forwardedRemotePortsRef.current.has(port.remotePort)))
  }, [forwardedPorts, portForwardingAvailable])

  useEffect(() => {
    if (!profileId || !portForwardingAvailable) {
      if (useAppStore.getState().forwardedPorts.length) {
        useAppStore.setState(state => ({
          forwardedPorts: [],
          forwardedPortsRevision: state.forwardedPortsRevision + 1
        }))
      }
      return
    }
    const operationScope = portActionScope
    const revision = useAppStore.getState().forwardedPortsRevision
    void window.agentsDock.ports.list(profileId, profileGeneration).then(ports => {
      if (
        activePortActionScopeRef.current !== operationScope
        || !terminalProfileIsActive(profileId, profileGeneration)
        || useAppStore.getState().forwardedPortsRevision !== revision
      ) return
      useAppStore.setState({ forwardedPorts: ports, forwardedPortsRevision: revision + 1 })
    }).catch(() => {
      // The Ports surface reports actionable errors. Its background badge
      // refresh remains quiet while the server reconnects.
    })
  }, [portActionScope, portForwardingAvailable, profileGeneration, profileId])

  const recordTerminalOutput = useCallback((data: string) => {
    // Port discovery is best-effort metadata, not terminal rendering. Bound
    // its input before concatenation so one large compiler/log packet cannot
    // make the renderer scan and copy an unbounded string on the input frame.
    const output = `${terminalOutputTailRef.current}${data.slice(-TERMINAL_PORT_SCAN_CHARACTERS)}`
      .slice(-TERMINAL_PORT_SCAN_CHARACTERS)
    terminalOutputTailRef.current = output
    const found = detectTerminalPorts(output).filter(port => (
      !dismissedPortSuggestionsRef.current.has(port.remotePort)
      && !forwardedRemotePortsRef.current.has(port.remotePort)
    )).filter(port => {
      const observation = `${port.remotePort}\u0000${port.url}\u0000${port.label}`
      if (observedPortSuggestionsRef.current.has(observation)) return false
      observedPortSuggestionsRef.current.add(observation)
      while (observedPortSuggestionsRef.current.size > MAX_OBSERVED_TERMINAL_PORTS) {
        const oldest = observedPortSuggestionsRef.current.values().next().value
        if (typeof oldest !== 'string') break
        observedPortSuggestionsRef.current.delete(oldest)
      }
      return true
    })
    if (!found.length) return
    setDetectedPorts(current => {
      const merged = new Map(current.map(port => [port.remotePort, port]))
      let changed = false
      for (const port of found) {
        const previous = merged.get(port.remotePort)
        if (previous?.url === port.url && previous.label === port.label) continue
        merged.delete(port.remotePort)
        merged.set(port.remotePort, port)
        changed = true
      }
      while (merged.size > MAX_DETECTED_TERMINAL_PORTS) {
        const oldest = merged.keys().next().value
        if (typeof oldest !== 'number') break
        merged.delete(oldest)
        changed = true
      }
      if (!changed) return current
      return [...merged.values()]
    })
  }, [])

  const dismissPortDetection = useCallback((remotePort: number) => {
    dismissedPortSuggestionsRef.current.add(remotePort)
    while (dismissedPortSuggestionsRef.current.size > MAX_DISMISSED_TERMINAL_PORTS) {
      const oldest = dismissedPortSuggestionsRef.current.values().next().value
      if (typeof oldest !== 'number') break
      dismissedPortSuggestionsRef.current.delete(oldest)
    }
    setDetectedPorts(current => current.filter(port => port.remotePort !== remotePort))
  }, [])

  const handlePortsChange = useCallback((ports: ForwardedPort[]) => {
    if (!profileId || !terminalProfileIsActive(profileId, profileGeneration)) return
    useAppStore.setState(state => ({
      forwardedPorts: ports,
      forwardedPortsRevision: state.forwardedPortsRevision + 1
    }))
  }, [profileGeneration, profileId])

  const refreshWindows = useCallback(async () => {
    if (!profileId || !terminalProfileIsActive(profileId, profileGeneration)) return
    try {
      const snapshot = await window.agentsDock.terminal.windows(profileId, profileGeneration, session.id)
      if (!terminalProfileIsActive(profileId, profileGeneration)) return
      setWindows(current => terminalWindowsEqual(current, snapshot.windows) ? current : snapshot.windows)
      setMouseEnabled(Boolean(snapshot.mouse_enabled))
      if (snapshot.name) setConnectionName(snapshot.name)
    } catch (error) {
      if (terminalProfileIsActive(profileId, profileGeneration)) setConnectionError(errorText(error))
    }
  }, [profileGeneration, profileId, session.id])

  const runAction = useCallback(async (action: TerminalAction, target?: string) => {
    if (!profileId || actionBusyRef.current || !terminalProfileIsActive(profileId, profileGeneration)) return
    actionBusyRef.current = true
    setActionBusy(true)
    try {
      const snapshot = await window.agentsDock.terminal.action(profileId, profileGeneration, session.id, action, target)
      if (!terminalProfileIsActive(profileId, profileGeneration)) return
      setWindows(current => terminalWindowsEqual(current, snapshot.windows) ? current : snapshot.windows)
      setMouseEnabled(Boolean(snapshot.mouse_enabled))
      setConnectionError(null)
      terminalRef.current?.focus()
    } catch (error) {
      if (!terminalProfileIsActive(profileId, profileGeneration)) return
      const message = errorText(error)
      setConnectionError(message)
      useAppStore.getState().setError(message)
    } finally {
      actionBusyRef.current = false
      if (terminalProfileIsActive(profileId, profileGeneration)) setActionBusy(false)
    }
  }, [profileGeneration, profileId, session.id])

  const connect = useCallback(async () => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!profileId || !terminal || !fit || !terminalProfileIsActive(profileId, profileGeneration)) return
    try {
      fit.fit()
      await window.agentsDock.terminal.connect(profileId, profileGeneration, session.id, {
        cwd: session.cwd,
        columns: terminal.cols,
        rows: terminal.rows
      })
    } catch (error) {
      if (terminalProfileIsActive(profileId, profileGeneration)) {
        setConnectionState('error')
        setConnectionError(errorText(error))
      }
    }
  }, [profileGeneration, profileId, session.cwd, session.id])

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
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
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
    terminal.attachCustomWheelEventHandler(event => {
      if (mouseEnabledRef.current) return containTerminalWheel(event)
      event.stopPropagation()
      event.preventDefault()
      const scroll = accumulateTerminalWheel(wheelRemainderRef.current, event, terminal.rows)
      wheelRemainderRef.current = scroll.remainder
      if (profileId && scroll.lines) window.agentsDock.terminal.scroll(profileId, profileGeneration, session.id, scroll.lines)
      return false
    })

    const data = terminal.onData(value => {
      if (profileId && terminalProfileIsActive(profileId, profileGeneration)) window.agentsDock.terminal.write(profileId, profileGeneration, session.id, value)
    })
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.metaKey) return true
      const key = event.key.toLowerCase()
      const clipboardShortcut = terminalClipboardShortcut(event)
      if (clipboardShortcut === 'copy') {
        if (terminal.hasSelection()) void window.agentsDock.native.writeClipboard(terminal.getSelection())
        return false
      }
      if (clipboardShortcut === 'select-all') {
        terminal.selectAll()
        return false
      }
      // Electron's Edit menu dispatches the native paste event to xterm. Letting
      // that path run avoids injecting the clipboard a second time here.
      if (clipboardShortcut === 'native-paste') return true
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

    let resizeFrame = 0
    let settleTimer = 0
    let lastSize = ''
    const fitTerminal = (reason: string) => {
      resizeFrame = 0
      try {
        const bounds = host.getBoundingClientRect()
        if (bounds.width < 32 || bounds.height < 32) return
        const proposed = fit.proposeDimensions()
        if (!proposed) return
        const columns = Math.max(2, Math.floor(proposed.cols))
        const rows = Math.max(1, Math.floor(proposed.rows))
        if (terminal.cols !== columns || terminal.rows !== rows) terminal.resize(columns, rows)
        const size = `${terminal.cols}x${terminal.rows}`
        if (size !== lastSize) {
          lastSize = size
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
          if (profileId && terminalProfileIsActive(profileId, profileGeneration)) {
            window.agentsDock.terminal.resize(profileId, profileGeneration, session.id, terminal.cols, terminal.rows)
          }
        }
        if (reason === 'initial' || reason === 'connected' || reason.endsWith(':settled')) {
          void window.agentsDock.native.log('terminal-layout', 'terminal fitted', {
            sessionId: session.id,
            reason,
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
            columns: terminal.cols,
            rows: terminal.rows
          }).catch(() => undefined)
        }
      } catch (error) {
        void window.agentsDock.native.log('terminal-layout', 'terminal fit failed', {
          sessionId: session.id, reason, error: errorText(error)
        }).catch(() => undefined)
      }
    }
    const scheduleFit = (reason: string) => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => fitTerminal(reason))
      if (settleTimer) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => fitTerminal(`${reason}:settled`), 90)
    }
    requestFitRef.current = scheduleFit

    let terminalDataFrame: number | null = null
    let terminalDataChunks: string[] = []
    const flushTerminalData = () => {
      terminalDataFrame = null
      if (!terminalDataChunks.length) return
      const batch = terminalDataChunks.join('')
      terminalDataChunks = []
      terminal.write(batch)
      recordTerminalOutput(batch)
    }
    const removeDataListener = window.agentsDock.events.on('terminal:data', payload => {
      if (payload.profileId === profileId && payload.profileGeneration === profileGeneration && payload.sessionId === session.id) {
        terminalDataChunks.push(payload.data)
        terminalDataFrame ??= window.requestAnimationFrame(flushTerminalData)
      }
    })
    const removeStateListener = window.agentsDock.events.on('terminal:state', payload => {
      if (payload.profileId !== profileId || payload.profileGeneration !== profileGeneration || payload.sessionId !== session.id) return
      setConnectionState(payload.state)
      setConnectionError(payload.error ?? null)
      if (payload.name) setConnectionName(payload.name)
      if (payload.state === 'connected') {
        terminal.focus()
        scheduleFit('connected')
        void refreshWindows()
      }
    })
    const find = (event: Event) => {
      if (activeSurfaceRef.current !== 'terminal') return
      const activeElement = document.activeElement
      const workspace = host.closest('.terminal-workspace')
      if (!(activeElement instanceof Node) || !workspace?.contains(activeElement)) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('agentsdock:find-active-surface', find)

    const observer = new ResizeObserver(() => scheduleFit('resize-observer'))
    observer.observe(host)
    if (host.parentElement) observer.observe(host.parentElement)
    const onWindowResize = () => scheduleFit('window-resize')
    window.addEventListener('resize', onWindowResize)
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    resizeFrame = window.requestAnimationFrame(() => {
      fitTerminal('initial')
      void connect()
    })

    return () => {
      if (terminalDataFrame !== null) {
        window.cancelAnimationFrame(terminalDataFrame)
        terminalDataFrame = null
      }
      // Preserve bytes already received if the panel closes between ingress
      // and its animation frame. Port suggestions can wait for the next open.
      if (terminalDataChunks.length) terminal.write(terminalDataChunks.join(''))
      terminalDataChunks = []
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
      if (settleTimer) window.clearTimeout(settleTimer)
      requestFitRef.current = () => undefined
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      themeObserver.disconnect()
      data.dispose()
      removeDataListener()
      removeStateListener()
      window.removeEventListener('agentsdock:find-active-surface', find)
      if (profileId) void window.agentsDock.terminal.disconnect(profileId, profileGeneration, session.id).catch(() => undefined)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [connect, profileGeneration, profileId, recordTerminalOutput, refreshWindows, runAction, session.id])

  useLayoutEffect(() => {
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      requestFitRef.current('dock-height')
      secondFrame = window.requestAnimationFrame(() => requestFitRef.current('dock-height-second-frame'))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [layoutHeight])

  useLayoutEffect(() => {
    if (activeSurface !== 'terminal') return
    const frame = window.requestAnimationFrame(() => requestFitRef.current('terminal-surface'))
    return () => window.cancelAnimationFrame(frame)
  }, [activeSurface])

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
    if (value && profileId && terminalProfileIsActive(profileId, profileGeneration)) {
      window.agentsDock.terminal.write(profileId, profileGeneration, session.id, value)
    }
  })
  const killSession = async () => {
    if (!profileId || !terminalProfileIsActive(profileId, profileGeneration)) return
    setConfirmKill(false)
    try {
      await window.agentsDock.terminal.kill(profileId, profileGeneration, session.id)
      if (!terminalProfileIsActive(profileId, profileGeneration)) return
      terminalRef.current?.clear()
      terminalRef.current?.write('\r\n\x1b[2mTerminal session ended. Reconnect to create a fresh one.\x1b[0m\r\n')
      setWindows([])
      setConnectionState('disconnected')
      setConnectionName(null)
    } catch (error) {
      if (!terminalProfileIsActive(profileId, profileGeneration)) return
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
  const forwardDetectedPort = async (detection: DetectedTerminalPort) => {
    if (
      !profileId
      || !portForwardingAvailable
      || suggestionBusy != null
      || !terminalProfileIsActive(profileId, profileGeneration)
    ) return
    const operationScope = portActionScope
    if (activePortActionScopeRef.current !== operationScope) return
    const revision = useAppStore.getState().forwardedPortsRevision
    setSuggestionBusy(detection.remotePort)
    try {
      const started = await window.agentsDock.ports.start(profileId, profileGeneration, session.id, detection.remotePort)
      if (activePortActionScopeRef.current !== operationScope || !terminalProfileIsActive(profileId, profileGeneration)) return
      if (useAppStore.getState().forwardedPortsRevision === revision) {
        useAppStore.setState(state => ({
          forwardedPorts: [...state.forwardedPorts.filter(port => port.remotePort !== started.remotePort), started]
            .sort((left, right) => left.remotePort - right.remotePort),
          forwardedPortsRevision: state.forwardedPortsRevision + 1
        }))
      }
      if (useAppStore.getState().forwardedPorts.some(port => port.remotePort === started.remotePort)) {
        dismissPortDetection(detection.remotePort)
        setPortRefreshToken(current => current + 1)
        setActiveSurface('ports')
        window.requestAnimationFrame(() => portsTabRef.current?.focus())
      }
    } catch (error) {
      if (activePortActionScopeRef.current !== operationScope || !terminalProfileIsActive(profileId, profileGeneration)) return
      const message = `Could not forward port ${detection.remotePort}: ${errorText(error)}`
      setConnectionError(message)
      useAppStore.getState().setError(message)
    } finally {
      if (activePortActionScopeRef.current === operationScope) setSuggestionBusy(null)
    }
  }
  const latestPortDetection = detectedPorts.at(-1)
  const activeTerminalWindow = windows.find(window => window.active)
  const activeTerminalTabId = activeTerminalWindow
    ? `${terminalPanelId}-tab-${activeTerminalWindow.index}`
    : undefined
  const moveSurfaceTabFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
      .filter(tab => !tab.hasAttribute('disabled'))
    const current = tabs.indexOf(event.target)
    if (current < 0 || !tabs.length) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next].focus()
    tabs[next].click()
  }

  return <section className="terminal-workspace" style={{ height: `${layoutHeight}px` }} data-layout-height={layoutHeight}>
    <header className="terminal-toolbar">
      <div className="terminal-window-tabs" role="tablist" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.terminal_surfaces_53919d9")} onKeyDown={moveSurfaceTabFocus}>
        {windows.length ? windows.map(tmuxWindow => <div
          key={tmuxWindow.id}
          className={`terminal-window-tab${tmuxWindow.active && activeSurface === 'terminal' ? ' active' : ''}`}
        >
          <button
            type="button"
            className="terminal-window-select"
            role="tab"
            aria-selected={tmuxWindow.active && activeSurface === 'terminal'}
            aria-controls={terminalPanelId}
            id={`${terminalPanelId}-tab-${tmuxWindow.index}`}
            tabIndex={tmuxWindow.active && activeSurface === 'terminal' ? 0 : -1}
            title={`${tmuxWindow.name} · ${tmuxWindow.panes} ${tmuxWindow.panes === 1 ? 'pane' : 'panes'}`}
            disabled={actionBusy}
            onClick={() => { setActiveSurface('terminal'); void runAction('select-window', String(tmuxWindow.index)) }}
          >
            <span className="terminal-window-index">{tmuxWindow.index}</span>
            <span className="terminal-window-name">{tmuxWindow.name}</span>
            {tmuxWindow.panes > 1 && <small>{tmuxWindow.panes}</small>}
          </button>
          <button
            type="button"
            className="terminal-window-close"
            aria-label={t("ui.TerminalWorkspace.close_tmux_window_250e858", { "name": String(tmuxWindow.name) })}
            title={windows.length === 1
              ? t("ui.TerminalWorkspace.close_final_window_and_end_tmux_session_9ac8ac7")
              : `Close tmux window${tmuxWindow.panes > 1 ? ` and its ${tmuxWindow.panes} panes` : ''}`}
            disabled={actionBusy}
            onClick={event => {
              event.stopPropagation()
              closeWindow(tmuxWindow.index)
            }}
          ><X size={12} /></button>
        </div>) : <div className="terminal-window-placeholder"><span className={`terminal-state-dot ${connectionState}`} />{connectionName || 'Terminal'}</div>}
        <ShortcutTooltip shortcut="terminalNewWindow"><button type="button" className="terminal-add-window" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.new_tmux_window_7ddf5a8")} disabled={actionBusy} onClick={() => { setActiveSurface('terminal'); void runAction('new-window') }}><Plus size={14} /></button></ShortcutTooltip>
        <button
          type="button"
          ref={portsTabRef}
          className={`terminal-ports-tab${activeSurface === 'ports' ? ' active' : ''}`}
          role="tab"
          aria-selected={activeSurface === 'ports'}
          aria-controls={portsPanelId}
          id={portsTabId}
          tabIndex={activeSurface === 'ports' || !windows.length ? 0 : -1}
          onClick={() => setActiveSurface('ports')}
        >
          <RadioTower size={13} /><span>{t("ui.TerminalWorkspace.TerminalWorkspace.ports_de5648d")}</span>
          {(forwardedPortCount > 0 || detectedPorts.length > 0) && <small>{forwardedPortCount || detectedPorts.length}</small>}
          {detectedPorts.length > 0 && <i aria-label={`${detectedPorts.length} detected ${detectedPorts.length === 1 ? 'port' : 'ports'}`} />}
        </button>
      </div>
      <div className="terminal-tools">
        {activeSurface === 'terminal' && <>{actionBusy && <LoaderCircle className="spin" size={13} />}
        <button type="button" className="icon-button" title={t("ui.TerminalWorkspace.TerminalWorkspace.previous_tmux_window_0cbe89e")} disabled={actionBusy} onClick={() => void runAction('previous-window')}><ChevronLeft size={15} /></button>
        <button type="button" className="icon-button" title={t("ui.TerminalWorkspace.TerminalWorkspace.next_tmux_window_5c5d5e4")} disabled={actionBusy} onClick={() => void runAction('next-window')}><ChevronRight size={15} /></button>
        <ShortcutTooltip shortcut="terminalSplitRight"><button type="button" className="icon-button" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.split_pane_right_fee3f9f")} disabled={actionBusy} onClick={() => void runAction('split-right')}><Columns2 size={15} /></button></ShortcutTooltip>
        <ShortcutTooltip shortcut="terminalSplitDown"><button type="button" className="icon-button" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.split_pane_down_cbaec7a")} disabled={actionBusy} onClick={() => void runAction('split-down')}><Rows2 size={15} /></button></ShortcutTooltip>
        <ShortcutTooltip shortcut="terminalFind"><button type="button" className="icon-button" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.find_in_terminal_382564a")} onClick={() => setSearchOpen(value => !value)}><Search size={15} /></button></ShortcutTooltip>
        <button type="button" className="icon-button" title={t("ui.TerminalWorkspace.TerminalWorkspace.reconnect_terminal_fb9d408")} disabled={actionBusy || connectionState === 'connecting'} onClick={() => void connect()}><RefreshCw size={15} /></button>
        <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="icon-button" title={t("ui.TerminalWorkspace.TerminalWorkspace.terminal_actions_1a60801")}><MoreHorizontal size={16} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item className="menu-item" onSelect={copy}><Copy size={14} />{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.copy_selection_63a5c4d")}</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={paste}><ClipboardPaste size={14} />{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.paste_f3380f7")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" disabled={actionBusy} onSelect={() => void runAction('toggle-mouse')}><MousePointer2 size={14} /> {mouseEnabled ? t("ui.TerminalWorkspace.TerminalWorkspace.use_local_text_selection_38ab808") : t("ui.TerminalWorkspace.TerminalWorkspace.enable_tmux_mouse_capture_cf0b68b")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" disabled={actionBusy} onSelect={() => void runAction('kill-pane')}><X size={14} />{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.close_active_pane_d817133")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item danger" disabled={actionBusy} onSelect={() => setConfirmKill(true)}><Trash2 size={14} />{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.kill_tmux_session_89e94d2")}</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></>}
        {onClose && <><span className="terminal-tool-separator" /><ShortcutTooltip shortcut="closeSurface" label={t("ui.TerminalWorkspace.TerminalWorkspace.close_terminal_panel_48e963f")}><button type="button" className="icon-button terminal-panel-close" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.close_terminal_panel_48e963f")} onClick={onClose}><X size={15} /></button></ShortcutTooltip></>}
      </div>
    </header>
    {activeSurface === 'terminal' && searchOpen && <div className="terminal-search">
      <Search size={14} /><input autoFocus value={searchQuery} placeholder={t("ui.TerminalWorkspace.TerminalWorkspace.find_822b2ae")} onChange={event => { setSearchQuery(event.target.value); if (event.target.value) searchRef.current?.findNext(event.target.value, { incremental: true, caseSensitive: false }) }} onKeyDown={event => { if (event.key === 'Enter') searchNext(event.shiftKey); if (event.key === 'Escape') { setSearchOpen(false); searchRef.current?.clearDecorations(); terminalRef.current?.focus() } }} />
      <button type="button" title={t("ui.TerminalWorkspace.TerminalWorkspace.previous_match_daa2f8c")} onClick={() => searchNext(true)}><ChevronLeft size={14} /></button><button type="button" title={t("ui.TerminalWorkspace.TerminalWorkspace.next_match_825e5ab")} onClick={() => searchNext()}><ChevronRight size={14} /></button><button type="button" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.close_terminal_search_788cd53")} title={t("ui.TerminalWorkspace.TerminalWorkspace.close_search_55656b5")} onClick={() => { setSearchOpen(false); searchRef.current?.clearDecorations(); terminalRef.current?.focus() }}><X size={14} /></button>
    </div>}
    {activeSurface === 'terminal' && confirmKill && <div className="terminal-confirm"><span>{t("ui.TerminalWorkspace.TerminalWorkspace.kill_this_chat_s_persistent_tmux_session_a_aede01e")}</span><button type="button" onClick={() => setConfirmKill(false)}>{t("ui.TerminalWorkspace.TerminalWorkspace.cancel_19766ed")}</button><button type="button" className="danger-button" disabled={actionBusy} onClick={() => void killSession()}>{t("ui.TerminalWorkspace.TerminalWorkspace.kill_session_52dca9b")}</button></div>}
    {connectionError && <button type="button" className="terminal-error" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.dismiss_terminal_error_33f7a1b")} onClick={() => setConnectionError(null)}>{connectionError}<X size={13} /></button>}
    <div className="terminal-surface-stack">
      {activeSurface === 'ports' && profileId && <div
        className="terminal-ports-surface"
        id={portsPanelId}
        role="tabpanel"
        aria-labelledby={portsTabId}
      ><PortsPanel
          profileId={profileId}
          profileGeneration={profileGeneration}
          sessionId={session.id}
          detections={detectedPorts}
          refreshToken={portRefreshToken}
          available={portForwardingAvailable}
          unavailableTitle={portForwardingUnavailableTitle}
          unavailableMessage={portForwardingUnavailableMessage}
          unavailableActionLabel={portForwardingUnavailableActionLabel}
          onUnavailableAction={() => {
            window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'server' }))
            useAppStore.getState().setModal('appSettings', true)
          }}
          onDismissDetection={dismissPortDetection}
          onPortsChange={handlePortsChange}
        /></div>}
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild><div
          className={`terminal-host${activeSurface === 'terminal' ? '' : ' surface-hidden'}`}
          id={terminalPanelId}
          role="tabpanel"
          aria-labelledby={activeTerminalTabId}
          aria-hidden={activeSurface !== 'terminal'}
          ref={hostRef}
        /></ContextMenu.Trigger>
        <ContextMenu.Portal><ContextMenu.Content className="menu-content terminal-context-menu">
          <ContextMenu.Item className="menu-item" onSelect={copy}><Copy size={14} />{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.copy_e21f935")}</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={paste}>{t("ui.TerminalWorkspace.TerminalWorkspace.paste_f3380f7")}</ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item" onSelect={() => terminalRef.current?.selectAll()}>{t("ui.TerminalWorkspace.TerminalWorkspace.select_all_1fc9a38")}</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => terminalRef.current?.clear()}>{t("ui.TerminalWorkspace.TerminalWorkspace.clear_scrollback_ffdfaae")}</ContextMenu.Item>
        </ContextMenu.Content></ContextMenu.Portal>
      </ContextMenu.Root>
      {activeSurface === 'terminal' && portForwardingAvailable && latestPortDetection && <aside className="terminal-port-suggestion" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.port_detected_4666453", { "port": String(latestPortDetection.remotePort) })}>
        <span className="terminal-port-suggestion-icon"><RadioTower size={14} /></span>
        <div><strong>{latestPortDetection.label} is available on port {latestPortDetection.remotePort}</strong><span>{t("ui.TerminalWorkspace.TerminalWorkspace.forward_it_securely_to_this_computer_458dd03")}</span></div>
        <button type="button" className="terminal-port-forward" disabled={suggestionBusy != null} onClick={() => void forwardDetectedPort(latestPortDetection)}>{suggestionBusy === latestPortDetection.remotePort ? <LoaderCircle className="spin" size={13} /> : <RadioTower size={13} />}{" "}{t("ui.TerminalWorkspace.TerminalWorkspace.forward_f1c65e1")}</button>
        <button type="button" className="terminal-port-dismiss" aria-label={t("ui.TerminalWorkspace.TerminalWorkspace.dismiss_port_suggestion_0558b3a", { "port": String(latestPortDetection.remotePort) })} onClick={() => dismissPortDetection(latestPortDetection.remotePort)}><X size={13} /></button>
      </aside>}
    </div>
  </section>
})

function terminalWindowsEqual(left: TerminalWindow[], right: TerminalWindow[]): boolean {
  return left.length === right.length && left.every((window, index) => {
    const candidate = right[index]
    return candidate != null
      && window.id === candidate.id
      && window.index === candidate.index
      && window.name === candidate.name
      && window.active === candidate.active
      && window.panes === candidate.panes
  })
}

function terminalTheme(): ITheme {
  if (document.documentElement.dataset.theme === 'light') {
    return {
      background: '#ffffff', foreground: '#1a1a1e', cursor: '#1675d1', cursorAccent: '#ffffff',
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

function terminalProfileIsActive(profileId: string, profileGeneration: number): boolean {
  const state = useAppStore.getState()
  return !state.switchingProfileId && state.activeProfileId === profileId && state.profileGeneration === profileGeneration
}
