import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { App } from './App'
import './styles.css'
import 'highlight.js/styles/github-dark.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
