import { useEffect, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { ChatHeader } from './components/ChatHeader'
import { CodeReview } from './components/CodeReview'
import { Composer } from './components/Composer'
import { Dialogs } from './components/Dialogs'
import { InspectorDock } from './components/InspectorDock'
import { Sidebar } from './components/Sidebar'
import { TerminalDock } from './components/TerminalDock'
import { Timeline } from './components/Timeline'
import { isTerminalToggleShortcut } from './lib/workspace-shortcuts'
import { WorkspaceResizeHandles, savedWorkspaceColumnStyle } from './components/WorkspaceResizeHandles'
import { reviewTargetBelongsToSession, type CodeReviewTarget } from './lib/timeline'
import { closeTopTransient } from './lib/transient-close'
import { useAppStore } from './store/app-store'

export function App() {
  const initialize = useAppStore(state => state.initialize)
  const initialized = useAppStore(state => state.initialized)
  const inspectorVisible = useAppStore(state => state.inspectorVisible)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const selectedSession = useAppStore(state => state.sessions.find(session => session.id === state.selectedSessionId) ?? null)
  const error = useAppStore(state => state.error)
  const [reviewTarget, setReviewTarget] = useState<CodeReviewTarget | null>(null)
  const [columnStyle] = useState(savedWorkspaceColumnStyle)
  const [slowBoot, setSlowBoot] = useState(false)
  const [terminalOpenBySession, setTerminalOpenBySession] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('agentsdock:terminal-open')
      if (saved) return JSON.parse(saved) as Record<string, boolean>
      const legacy = JSON.parse(localStorage.getItem('agentsdock:workspace-modes') || '{}') as Record<string, string>
      return Object.fromEntries(Object.entries(legacy).map(([sessionId, mode]) => [sessionId, mode === 'terminal']))
    } catch { return {} }
  })
  const terminalOpen = selectedSessionId && !selectedSession?.archived ? terminalOpenBySession[selectedSessionId] ?? false : false

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => {
    if (initialized) return
    const timer = window.setTimeout(() => setSlowBoot(true), 5000)
    return () => window.clearTimeout(timer)
  }, [initialized])
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<CodeReviewTarget>).detail
      if (!reviewTargetBelongsToSession(target, useAppStore.getState().selectedSessionId)) return
      setReviewTarget(target)
    }
    window.addEventListener('agentsdock:review-diff', open)
    return () => window.removeEventListener('agentsdock:review-diff', open)
  }, [])
  useEffect(() => {
    setReviewTarget(current => reviewTargetBelongsToSession(current, selectedSessionId) ? current : null)
  }, [selectedSessionId])
  useEffect(() => {
    if (!selectedSession?.archived || !terminalOpenBySession[selectedSession.id]) return
    setTerminalOpenBySession(current => {
      if (!current[selectedSession.id]) return current
      const next = { ...current, [selectedSession.id]: false }
      localStorage.setItem('agentsdock:terminal-open', JSON.stringify(next))
      return next
    })
  }, [selectedSession?.id, selectedSession?.archived, terminalOpenBySession])
  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (isTerminalToggleShortcut(event) && selectedSessionId) {
        event.preventDefault()
        event.stopPropagation()
        setTerminalOpen(selectedSessionId, !terminalOpen)
        return
      }
      if (!event.metaKey) return
      const key = event.key.toLowerCase()
      if (!event.shiftKey && key === 'l') {
        event.preventDefault()
        event.stopPropagation()
        useAppStore.getState().setInspectorVisible(!inspectorVisible)
      }
    }
    window.addEventListener('keydown', handleWorkspaceShortcut, true)
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut, true)
  }, [inspectorVisible, selectedSessionId, terminalOpen])
  const setTerminalOpen = (sessionId: string, open: boolean) => {
    setTerminalOpenBySession(current => {
      const next = { ...current, [sessionId]: open }
      localStorage.setItem('agentsdock:terminal-open', JSON.stringify(next))
      return next
    })
  }
  useEffect(() => {
    const closeSurface = () => {
      if (closeTopTransient()) return
      if (reviewTarget) { setReviewTarget(null); return }
      if (terminalOpen && selectedSessionId) { setTerminalOpen(selectedSessionId, false); return }
      void window.agentsDock.native.closeWindow()
    }
    window.addEventListener('agentsdock:close-surface', closeSurface)
    return () => window.removeEventListener('agentsdock:close-surface', closeSurface)
  }, [reviewTarget, selectedSessionId, terminalOpen])
  const toggleTerminal = () => {
    if (!selectedSessionId || selectedSession?.archived) return
    setTerminalOpen(selectedSessionId, !terminalOpen)
  }

  if (!initialized) {
    return <main className="app-boot"><LoaderCircle className="spin" size={20} /><span>Opening AgentsDock</span>{slowBoot && <><small>Startup is taking longer than expected. Check the startup log if this persists.</small><button className="quiet-button" onClick={() => window.location.reload()}>Retry</button></>}</main>
  }

  return (
    <main className={`app-shell ${inspectorVisible ? 'inspector-open' : ''}`} style={columnStyle}>
      <Sidebar />
      <section className="conversation-pane">
        <ChatHeader terminalOpen={terminalOpen} onTerminalToggle={selectedSession?.archived ? undefined : toggleTerminal} />
        <div className="chat-workspace">
          <Timeline />
          <Composer />
        </div>
      </section>
      <InspectorDock open={inspectorVisible} contentKey={selectedSessionId || 'empty'} />
      <WorkspaceResizeHandles inspectorOpen={inspectorVisible} />
      {selectedSession && <TerminalDock
        key={selectedSession.id}
        open={terminalOpen}
        session={selectedSession}
        onRequestClose={() => setTerminalOpen(selectedSession.id, false)}
      />}
      {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => useAppStore.getState().setError(null)}><X size={14} /></button></div>}
      <Dialogs />
      <CodeReview target={reviewTarget} onClose={() => setReviewTarget(null)} />
    </main>
  )
}
