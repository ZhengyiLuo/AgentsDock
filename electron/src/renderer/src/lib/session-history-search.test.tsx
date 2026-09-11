import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineSearchResult } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { clearSessionHistorySearchCache, OPEN_HISTORY_RESULT_EVENT, openSessionHistoryResult, useSessionHistorySearch } from './session-history-search'

function result(sessionId: string, snippet: string): TimelineSearchResult {
  return { session_id: sessionId, event_id: `${sessionId}-event`, seq: 1, role: 'assistant', snippet }
}

describe('whole-history session search', () => {
  const originalSelectSession = useAppStore.getState().selectSession

  beforeEach(() => useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 1, selectedSessionId: null, switchingProfileId: null, selectSession: originalSelectSession, error: null }))
  afterEach(() => { cleanup(); clearSessionHistorySearchCache(); useAppStore.setState({ selectSession: originalSelectSession }); vi.useRealTimers(); vi.restoreAllMocks() })

  it('debounces requests and ignores a stale response from an older query', async () => {
    vi.useFakeTimers()
    let resolveOld: (value: TimelineSearchResult[]) => void = () => {}
    const searchHistory = vi.fn()
      .mockImplementationOnce(() => new Promise<TimelineSearchResult[]>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce([result('new', 'new result')])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } }
    })

    const { result: hook, rerender } = renderHook(({ query }) => useSessionHistorySearch(query), {
      initialProps: { query: 'old query' }
    })
    expect(hook.current.loading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })
    expect(searchHistory).toHaveBeenCalledWith('old query', 100)

    rerender({ query: 'new query' })
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })
    expect(hook.current.results).toEqual([result('new', 'new result')])

    await act(async () => { resolveOld([result('old', 'stale result')]); await Promise.resolve() })
    expect(hook.current.results).toEqual([result('new', 'new result')])
    expect(hook.current.loading).toBe(false)
  })

  it('does not query history for fewer than two characters', () => {
    vi.useFakeTimers()
    const searchHistory = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } }
    })
    const { result: hook } = renderHook(() => useSessionHistorySearch('x'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(searchHistory).not.toHaveBeenCalled()
    expect(hook.current).toEqual({ results: [], loading: false })
  })

  it('deduplicates identical in-flight searches across search surfaces', async () => {
    vi.useFakeTimers()
    const searchHistory = vi.fn().mockResolvedValue([result('shared', 'one request')])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } }
    })
    const first = renderHook(() => useSessionHistorySearch('shared query'))
    const second = renderHook(() => useSessionHistorySearch('shared query'))

    await act(async () => { await vi.advanceTimersByTimeAsync(220) })

    expect(searchHistory).toHaveBeenCalledTimes(1)
    expect(first.result.current.results).toEqual([result('shared', 'one request')])
    expect(second.result.current.results).toEqual([result('shared', 'one request')])
  })

  it('does not share same-session search results across profiles', async () => {
    vi.useFakeTimers()
    const searchHistory = vi.fn()
      .mockResolvedValueOnce([result('shared', 'profile A result')])
      .mockResolvedValueOnce([result('shared', 'profile B result')])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } }
    })
    const hook = renderHook(() => useSessionHistorySearch('shared query'))
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })
    expect(hook.result.current.results).toEqual([result('shared', 'profile A result')])

    act(() => useAppStore.setState({ activeProfileId: 'profile-b' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })

    expect(searchHistory).toHaveBeenCalledTimes(2)
    expect(hook.result.current.results).toEqual([result('shared', 'profile B result')])
  })

  it('does not reuse history results after the same profile gets a new generation', async () => {
    vi.useFakeTimers()
    const searchHistory = vi.fn()
      .mockResolvedValueOnce([result('shared', 'old identity result')])
      .mockResolvedValueOnce([result('shared', 'new identity result')])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } }
    })
    const hook = renderHook(() => useSessionHistorySearch('shared query'))
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })
    expect(hook.result.current.results).toEqual([result('shared', 'old identity result')])

    act(() => useAppStore.setState({ profileGeneration: 2 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(220) })

    expect(searchHistory).toHaveBeenCalledTimes(2)
    expect(hook.result.current.results).toEqual([result('shared', 'new identity result')])
  })

  it('does not dispatch a delayed history result after the profile generation changes', async () => {
    let frame: FrameRequestCallback | null = null
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1 })
    const selectSession = vi.fn(async (sessionId: string) => { useAppStore.setState({ selectedSessionId: sessionId }) })
    useAppStore.setState({ selectSession })
    const opened = vi.fn()
    window.addEventListener(OPEN_HISTORY_RESULT_EVENT, opened)
    try {
      await openSessionHistoryResult('shared', result('shared', 'old identity result'))
      expect(frame).not.toBeNull()
      useAppStore.setState({ profileGeneration: 2 })
      const scheduled = frame as FrameRequestCallback | null
      scheduled?.(0)
      expect(opened).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(OPEN_HISTORY_RESULT_EVENT, opened)
    }
  })

  it('leaves Team Network only after the requested chat has been selected', async () => {
    let finish!: () => void
    const selectSession = vi.fn((sessionId: string) => new Promise<void>(resolve => {
      finish = () => { useAppStore.setState({ selectedSessionId: sessionId }); resolve() }
    }))
    useAppStore.setState({ selectSession })
    const close = vi.fn()
    window.addEventListener('agentsdock:close-teamspace', close)
    try {
      const navigation = openSessionHistoryResult('shared')
      expect(close).not.toHaveBeenCalled()
      finish()
      expect(await navigation).toBe(true)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('agentsdock:close-teamspace', close)
    }
  })

  it.each(['not-selected', 'profile-changed'] as const)('does not close Team Network when navigation is %s', async outcome => {
    useAppStore.setState({ selectSession: vi.fn(async () => {
      if (outcome === 'profile-changed') useAppStore.setState({ profileGeneration: 2, selectedSessionId: 'shared' })
    }) })
    const close = vi.fn()
    window.addEventListener('agentsdock:close-teamspace', close)
    try {
      expect(await openSessionHistoryResult('shared')).toBe(false)
      expect(close).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:close-teamspace', close)
    }
  })
})
