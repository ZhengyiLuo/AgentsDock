import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { App } from './App'
import { initializeAppearance } from './lib/appearance'
import { initializeLanguage, useLocale } from './lib/i18n'
import { chatSwitcherShortcutPlatform, installChatSwitcherShortcut } from './lib/chat-switcher-shortcut'
import { handleMenuCommand, useAppStore } from './store/app-store'
import './styles.css'
import '@xterm/xterm/css/xterm.css'
import 'highlight.js/styles/github-dark.css'

initializeAppearance()

installChatSwitcherShortcut(window, () => {
  handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))
}, chatSwitcherShortcutPlatform(navigator))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
})

function LocalizedApp() {
  useLocale()
  return <App />
}

void initializeLanguage().then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350}>
        <LocalizedApp />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>
))
