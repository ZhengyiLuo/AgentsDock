import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ProfileSessionSearchResult } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { useProfileSearch } from './profile-search'

describe('useProfileSearch', () => {
  it('clears old results immediately and ignores a superseded query response', async () => {
    const resolvers = new Map<string, (results: ProfileSessionSearchResult[]) => void>()
    const searchAllProfiles = vi.fn((query: string) => new Promise<ProfileSessionSearchResult[]>(resolve => { resolvers.set(query, resolve) }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchAllProfiles } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 1 })
    const { result, rerender } = renderHook(({ query }) => useProfileSearch(query), { initialProps: { query: 'alpha' } })

    await waitFor(() => expect(searchAllProfiles).toHaveBeenCalledWith('alpha', 100))
    rerender({ query: 'beta' })
    expect(result.current.results).toEqual([])

    await act(async () => { resolvers.get('alpha')?.([match('alpha')]); await Promise.resolve() })
    expect(result.current.results).toEqual([])
    await waitFor(() => expect(searchAllProfiles).toHaveBeenCalledWith('beta', 100))
    await act(async () => { resolvers.get('beta')?.([match('beta')]); await Promise.resolve() })
    await waitFor(() => expect(result.current.results.map(item => item.session.id)).toEqual(['beta']))
  })
})

function match(id: string): ProfileSessionSearchResult {
  return {
    profileId: 'profile-a',
    profileName: 'Profile A',
    session: { id, title: id, backend: 'codex' },
    source: 'title'
  }
}
