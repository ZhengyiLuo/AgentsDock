import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineSearchResult } from '@shared/types'
import { useSessionHistorySearch } from './session-history-search'

function result(sessionId: string, snippet: string): TimelineSearchResult {
  return { session_id: sessionId, event_id: `${sessionId}-event`, seq: 1, role: 'assistant', snippet }
}

describe('whole-history session search', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

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
})
