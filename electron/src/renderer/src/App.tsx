import { useEffect, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { ChatHeader } from './components/ChatHeader'
import { CodeReview } from './components/CodeReview'
import { Composer } from './components/Composer'
import { Dialogs } from './components/Dialogs'
import { Inspector } from './components/Inspector'
import { Sidebar } from './components/Sidebar'
import { Timeline } from './components/Timeline'
import { useAppStore } from './store/app-store'

export function App() {
  const initialize = useAppStore(state => state.initialize)
  const initialized = useAppStore(state => state.initialized)
  const inspectorVisible = useAppStore(state => state.inspectorVisible)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const error = useAppStore(state => state.error)
  const [reviewDiff, setReviewDiff] = useState<string | null>(null)
  const [slowBoot, setSlowBoot] = useState(false)

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => {
    if (initialized) return
    const timer = window.setTimeout(() => setSlowBoot(true), 5000)
    return () => window.clearTimeout(timer)
  }, [initialized])
  useEffect(() => {
    const open = (event: Event) => setReviewDiff((event as CustomEvent<string>).detail)
    window.addEventListener('agentsdock:review-diff', open)
    return () => window.removeEventListener('agentsdock:review-diff', open)
  }, [])

  if (!initialized) {
    return <main className="app-boot"><LoaderCircle className="spin" size={20} /><span>Opening AgentsDock</span>{slowBoot && <><small>Startup is taking longer than expected. Check the startup log if this persists.</small><button className="quiet-button" onClick={() => window.location.reload()}>Retry</button></>}</main>
  }

  return (
    <main className={`app-shell ${inspectorVisible ? 'inspector-open' : ''}`}>
      <Sidebar />
      <section className="conversation-pane">
        <ChatHeader />
        <Timeline />
        <Composer />
      </section>
      {inspectorVisible && <Inspector key={selectedSessionId || 'empty'} />}
      {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => useAppStore.getState().setError(null)}><X size={14} /></button></div>}
      <Dialogs />
      <CodeReview source={reviewDiff} onClose={() => setReviewDiff(null)} />
    </main>
  )
}
