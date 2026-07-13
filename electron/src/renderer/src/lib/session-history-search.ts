import { useEffect, useRef, useState } from 'react'
import type { TimelineSearchResult } from '@shared/types'
import { useAppStore } from '../store/app-store'

export const OPEN_HISTORY_RESULT_EVENT = 'agentsdock:open-history-result'
const SEARCH_CACHE_TTL_MS = 30_000
const SEARCH_CACHE_MAX_ENTRIES = 24
const searchCache = new Map<string, { at: number; results: TimelineSearchResult[] }>()
const searchInFlight = new Map<string, Promise<TimelineSearchResult[]>>()

function searchKey(scope: string, query: string, limit: number): string {
  return `${scope}:${limit}:${query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`
}

async function searchHistory(scope: string, query: string, limit: number): Promise<TimelineSearchResult[]> {
  const key = searchKey(scope, query, limit)
  const cached = searchCache.get(key)
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.results
  const existing = searchInFlight.get(key)
  if (existing) return existing
  const request = window.agentsDock.sessions.searchHistory(query, limit).then(results => {
    searchCache.delete(key)
    searchCache.set(key, { at: Date.now(), results })
    while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value!)
    return results
  }).finally(() => searchInFlight.delete(key))
  searchInFlight.set(key, request)
  return request
}

export function clearSessionHistorySearchCache(): void {
  searchCache.clear()
  searchInFlight.clear()
}

export function useSessionHistorySearch(query: string, limit = 100): { results: TimelineSearchResult[]; loading: boolean } {
  const [results, setResults] = useState<TimelineSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const searchScope = useAppStore(state => state.health?.server_identity || 'unidentified-server')
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
      void searchHistory(searchScope, clean, limit).then(matches => {
        if (request === lease.current) setResults(matches)
      }).catch(error => {
        if (request === lease.current) useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (request === lease.current) setLoading(false)
      })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [limit, query, searchScope])

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
