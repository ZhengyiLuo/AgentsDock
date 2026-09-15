import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { createSharedChatBridge } from './bridge'
import { receiveSharedChatConnection, receiveSharedChatState } from './SharedChatApp'
import { SharedChatEntry } from './SharedChatEntry'
import { initializeAppearance } from '../lib/appearance'
import { initializeLanguage } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import '../styles.css'
import 'highlight.js/styles/github-dark.css'
import './shared-chat.css'

const prefix = location.pathname.replace(/\/$/, '')
const bridge = createSharedChatBridge(prefix,
  state => receiveSharedChatState(state, prefix),
  receiveSharedChatConnection)
window.agentsDock = bridge.api
// Sharing URLs are token-free. Discard old parameters without consuming or
// prefilling them; access tokens are entered manually in the browser form.
if (location.search || location.hash) history.replaceState(null, '', prefix)
initializeAppearance()
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } })

window.addEventListener('pagehide', () => bridge.close(), { once: true })
window.addEventListener('pageshow', event => {
  // A bfcache restore must not reuse the bridge closed by pagehide.
  if (event.persisted) location.reload()
})
window.addEventListener('beforeunload', event => {
  if (Object.values(useAppStore.getState().drafts).some(value => value.trim())) { event.preventDefault(); event.returnValue = '' }
})
void initializeLanguage().then(() => createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><TooltipProvider delayDuration={350}><SharedChatEntry bridge={bridge} /></TooltipProvider></QueryClientProvider>
))
