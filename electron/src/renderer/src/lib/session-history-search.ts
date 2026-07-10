import { useEffect, useRef, useState } from 'react'
import type { TimelineSearchResult } from '@shared/types'
import { useAppStore } from '../store/app-store'

export const OPEN_HISTORY_RESULT_EVENT = 'agentsdock:open-history-result'

export function useSessionHistorySearch(query: string, limit = 100): { results: TimelineSearchResult[]; loading: boolean } {
  const [results, setResults] = useState<TimelineSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const lease = useRef(0)

  useEffect(() => {
    const clean = query.trim()
    const request = ++lease.current
    if (clean.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setResults([])
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.agentsDock.sessions.searchHistory(clean, limit).then(matches => {
        if (request === lease.current) setResults(matches)
      }).catch(error => {
        if (request === lease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (request === lease.current) setLoading(false)
      })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [limit, query])

  return { results, loading }
}

export function historyResultsBySession(results: TimelineSearchResult[]): Map<string, TimelineSearchResult> {
  return new Map(results.map(result => [result.session_id, result]))
}

export async function openSessionHistoryResult(sessionId: string, result?: TimelineSearchResult): Promise<void> {
  await useAppStore.getState().selectSession(sessionId)
  if (!result) return
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent<TimelineSearchResult>(OPEN_HISTORY_RESULT_EVENT, { detail: result }))
  })
}
