import { useEffect, useRef, useState } from 'react'
import type { ProfileSessionSearchResult } from '@shared/types'
import { useAppStore } from '../store/app-store'

export function useProfileSearch(query: string, limit = 100): { results: ProfileSessionSearchResult[]; loading: boolean } {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [results, setResults] = useState<ProfileSessionSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const lease = useRef(0)

  useEffect(() => {
    const clean = query.trim()
    const request = ++lease.current
    if (clean.length < 2 || typeof window.agentsDock.sessions.searchAllProfiles !== 'function') {
      setResults([])
      setLoading(false)
      return
    }
    setResults([])
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.agentsDock.sessions.searchAllProfiles(clean, limit).then(matches => {
        const current = useAppStore.getState()
        if (request === lease.current && current.activeProfileId === activeProfileId && current.profileGeneration === profileGeneration) setResults(matches)
      }).catch(error => {
        const current = useAppStore.getState()
        if (request === lease.current && current.activeProfileId === activeProfileId && current.profileGeneration === profileGeneration) {
          useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
        }
      }).finally(() => {
        const current = useAppStore.getState()
        if (request === lease.current && current.activeProfileId === activeProfileId && current.profileGeneration === profileGeneration) setLoading(false)
      })
    }, 160)
    return () => {
      window.clearTimeout(timer)
      if (request === lease.current) lease.current += 1
    }
  }, [activeProfileId, limit, profileGeneration, query])

  return { results, loading }
}
