import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { t } from '@shared/i18n'
import { createSharedChatBridge } from './bridge'
import { SharedChatApp, receiveSharedChatState } from './SharedChatApp'
import { initializeAppearance } from '../lib/appearance'
import { initializeLanguage, useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import '../styles.css'
import 'highlight.js/styles/github-dark.css'
import './shared-chat.css'

const prefix = location.pathname.replace(/\/$/, '')
const bridge = createSharedChatBridge(prefix,
  state => receiveSharedChatState(state, prefix),
  (connected, error) => useAppStore.setState({ connected, ...(error ? { error } : {}) }))
window.agentsDock = bridge.api
// The invitation is consumed only by the explicit button, never by a page GET.
let invitation = new URLSearchParams(location.hash.slice(1)).get('invite')
if (invitation) history.replaceState(null, '', prefix)
initializeAppearance()
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } })

function Entry() {
  useLocale()
  const ready = useAppStore(state => state.initialized)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enter = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      try { await bridge.start() }
      catch (cause) {
        if (!invitation) throw cause
        await bridge.redeem(invitation)
        invitation = null
        await bridge.start()
      }
      useAppStore.getState().setError(null)
      void bridge.catalog().catch(() => { /* The current model/effort remains usable if discovery is unavailable. */ })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  if (ready) return <SharedChatApp />
  return <main className="shared-chat-welcome">
    <h1>AgentsDock</h1><h2>{t('chatShare.web.title')}</h2>
    <p>{t('chatShare.interactiveWarning')}</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={busy} onClick={() => void enter()}>{busy ? t('chatShare.web.opening') : t('chatShare.web.open')}</button>
  </main>
}

window.addEventListener('pagehide', () => bridge.close(), { once: true })
window.addEventListener('beforeunload', event => {
  if (Object.values(useAppStore.getState().drafts).some(value => value.trim())) { event.preventDefault(); event.returnValue = '' }
})
void initializeLanguage().then(() => createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><TooltipProvider delayDuration={350}><Entry /></TooltipProvider></QueryClientProvider>
))
