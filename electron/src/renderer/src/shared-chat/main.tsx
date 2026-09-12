import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { t } from '@shared/i18n'
import { createSharedChatBridge } from './bridge'
import { SharedChatApp, receiveSharedChatConnection, receiveSharedChatState } from './SharedChatApp'
import { initializeAppearance } from '../lib/appearance'
import { initializeLanguage, useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import '../styles.css'
import 'highlight.js/styles/github-dark.css'
import './shared-chat.css'

const prefix = location.pathname.replace(/\/$/, '')
const bridge = createSharedChatBridge(prefix,
  state => receiveSharedChatState(state, prefix),
  receiveSharedChatConnection)
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
  const entering = useRef(false)
  const enter = async (allowRedemption = true) => {
    if (entering.current) return
    entering.current = true
    setBusy(true); setError(null)
    try {
      try { await bridge.start() }
      catch (cause) {
        if (!allowRedemption || !invitation) throw cause
        await bridge.redeem(invitation)
        invitation = null
        await bridge.start()
      }
      useAppStore.getState().setError(null)
      void bridge.catalog().catch(() => { /* The current model/effort remains usable if discovery is unavailable. */ })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { entering.current = false; setBusy(false) }
  }
  useEffect(() => {
    // Reloading a redeemed URL resumes its existing HttpOnly browser session.
    // This reads state only; a new invitation is still consumed exclusively
    // by the explicit Open action, never by loading or refreshing the page.
    if (!invitation) void enter(false)
  }, [])
  if (ready) return <SharedChatApp />
  return <main className="shared-chat-welcome">
    <h1>AgentsDock</h1><h2>{t('chatShare.web.title')}</h2>
    <p>{t('chatShare.interactiveWarning')}</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={busy} onClick={() => void enter()}>{busy ? t('chatShare.web.opening') : t('chatShare.web.open')}</button>
  </main>
}

window.addEventListener('pagehide', () => bridge.close(), { once: true })
window.addEventListener('pageshow', event => {
  // A bfcache restore must not reuse the bridge closed by pagehide.
  if (event.persisted) location.reload()
})
window.addEventListener('beforeunload', event => {
  if (Object.values(useAppStore.getState().drafts).some(value => value.trim())) { event.preventDefault(); event.returnValue = '' }
})
void initializeLanguage().then(() => createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><TooltipProvider delayDuration={350}><Entry /></TooltipProvider></QueryClientProvider>
))
