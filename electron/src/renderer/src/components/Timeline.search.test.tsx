import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, Session, SessionSnapshot, TimelinePage, TimelineSearchResult } from '@shared/types'
import { closeTopTransient, resetTransientCloseStackForTests } from '../lib/transient-close'
import { clearTimelineProjectionCache } from '../lib/timeline-projection-cache'
import { useAppStore } from '../store/app-store'
import { clearTimelineViewStates, Timeline } from './Timeline'

const virtuosoHarness = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  atBottomStateChange: null as ((value: boolean) => void) | null,
  isScrolling: null as ((value: boolean) => void) | null,
  startReached: null as (() => void) | null,
  renderCount: 0
}))

vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(props: {
      data: unknown[]
      computeItemKey: (index: number, item: unknown) => string
      itemContent: (index: number, item: unknown) => React.ReactNode
      atBottomStateChange?: (value: boolean) => void
      isScrolling?: (value: boolean) => void
      scrollerRef?: (node: HTMLElement | Window | null) => void
      startReached?: () => void
    }, ref: React.ForwardedRef<unknown>) {
      virtuosoHarness.renderCount += 1
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: virtuosoHarness.scrollToIndex
      }))
      virtuosoHarness.atBottomStateChange = props.atBottomStateChange ?? null
      virtuosoHarness.isScrolling = props.isScrolling ?? null
      virtuosoHarness.startReached = props.startReached ?? null
      const setScroller = React.useCallback((node: HTMLDivElement | null) => {
        props.scrollerRef?.(node)
      }, [props.scrollerRef])
      return <div ref={setScroller} data-testid="timeline-virtuoso">
        {props.data.map((item, index) => (
          <div key={props.computeItemKey(index, item)}>{props.itemContent(index, item)}</div>
        ))}
      </div>
    })
  }
})

vi.mock('./TimelineRows', () => ({
  TimelineRowView: ({ item }: { item: { key: string } }) => <div>{item.key}</div>
}))

const SESSION_ID = 'timeline-search-chat'
const session: Session = { id: SESSION_ID, title: 'Searchable chat', backend: 'codex' }

function timelineEvent(seq: number, patch: Partial<Event> = {}): Event {
  return {
    id: `event-${seq}`,
    session_id: SESSION_ID,
    seq,
    type: 'assistant_text',
    ts: `2026-08-26T10:00:${String(seq).padStart(2, '0')}Z`,
    text: `Timeline message ${seq}`,
    ...patch
  }
}

function snapshot(events: Event[]): SessionSnapshot {
  return {
    session,
    events,
    queuedTurns: [],
    files: [],
    hasMoreEvents: false,
    historyVerified: true,
    filesTotal: 0,
    cachedAt: 0
  }
}

function result(eventId: string, seq: number, snippet = 'Matching timeline answer'): TimelineSearchResult {
  return {
    session_id: SESSION_ID,
    event_id: eventId,
    seq,
    ts: '2026-08-26T10:00:00Z',
    role: 'assistant',
    snippet
  }
}

describe('Timeline search navigation', () => {
  const search = vi.fn<AgentsDockAPI['timeline']['search']>()
  const around = vi.fn<AgentsDockAPI['timeline']['around']>()
  const historicalOlder = vi.fn<AgentsDockAPI['timeline']['historicalOlder']>()

  beforeEach(() => {
    virtuosoHarness.scrollToIndex.mockReset()
    virtuosoHarness.atBottomStateChange = null
    virtuosoHarness.isScrolling = null
    virtuosoHarness.startReached = null
    virtuosoHarness.renderCount = 0
    search.mockReset()
    around.mockReset()
    historicalOlder.mockReset()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        timeline: {
          index: vi.fn().mockResolvedValue({
            session_id: SESSION_ID,
            landmarks: [],
            latest_seq: 100,
            event_count: 1
          }),
          search,
          around,
          historicalOlder,
          saveViewState: vi.fn().mockResolvedValue(undefined)
        },
        pins: { list: vi.fn().mockResolvedValue([]) },
        files: { findEvent: vi.fn().mockResolvedValue(null) },
        events: { on: vi.fn().mockReturnValue(() => undefined) },
        native: { log: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: null,
      profileGeneration: 0,
      profiles: [],
      selectedSessionId: SESSION_ID,
      sessions: [session],
      snapshots: { [SESSION_ID]: snapshot([timelineEvent(100)]) },
      health: null,
      activeSessionIds: new Set(),
      loadingSessionId: null,
      loadingSessionIds: new Set(),
      error: null
    })
  })

  afterEach(() => {
    cleanup()
    resetTransientCloseStackForTests()
    clearTimelineProjectionCache()
    clearTimelineViewStates()
    vi.restoreAllMocks()
  })

  async function showResult(searchResult: TimelineSearchResult): Promise<HTMLButtonElement> {
    search.mockResolvedValue([searchResult])
    render(<Timeline />)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:find-in-chat', {
        detail: { sessionId: SESSION_ID }
      }))
    })
    fireEvent.change(screen.getByPlaceholderText('Search full chat history'), {
      target: { value: 'timeline' }
    })
    const snippet = await screen.findByText(searchResult.snippet)
    const button = snippet.closest('button')
    if (!(button instanceof HTMLButtonElement)) throw new Error('Search result button was not rendered')
    return button
  }

  it('scrolls to a loaded result and closes the search overlay when clicked', async () => {
    const searchResult = result('event-100', 100)
    const button = await showResult(searchResult)

    fireEvent.click(button)

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
      index: expect.any(Number),
      align: 'center'
    }))
    expect(around).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Search full chat history')).not.toBeInTheDocument()
  })

  it('dismisses search with Escape after focus moves from the input to a result', async () => {
    const button = await showResult(result('event-100', 100))
    button.focus()
    expect(document.activeElement).toBe(button)

    fireEvent.keyDown(button, { key: 'Escape' })

    expect(screen.queryByPlaceholderText('Search full chat history')).not.toBeInTheDocument()
    // Opening the chat may reassert the latest row while it settles; Escape
    // itself must not navigate to the result.
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalledWith(expect.objectContaining({ align: 'center' }))
  })

  it('registers search as the top transient surface', async () => {
    await showResult(result('event-100', 100))
    let consumed = false

    act(() => { consumed = closeTopTransient() })

    expect(consumed).toBe(true)
    expect(screen.queryByPlaceholderText('Search full chat history')).not.toBeInTheDocument()
    expect(closeTopTransient()).toBe(false)
  })

  it('loads historical context for an unloaded result and closes the search overlay', async () => {
    const historicalEvent = timelineEvent(2, { id: 'historical-event' })
    const page: TimelinePage = {
      session,
      events: [historicalEvent],
      has_more: false,
      next_before: null,
      latest_seq: 100
    }
    around.mockResolvedValue(page)
    const button = await showResult(result(historicalEvent.id, historicalEvent.seq, 'Older matching answer'))

    fireEvent.click(button)

    await waitFor(() => expect(around).toHaveBeenCalledWith(SESSION_ID, historicalEvent.seq, expect.any(Number)))
    // The historical window positions itself through Virtuoso's initial
    // location; the live list must not be scrolled to the result.
    expect(virtuosoHarness.scrollToIndex).not.toHaveBeenCalledWith(expect.objectContaining({ align: 'center' }))
    expect(screen.queryByPlaceholderText('Search full chat history')).not.toBeInTheDocument()
  })

  it('uses the non-persistent history lane when paging an older search window', async () => {
    const historicalEvent = timelineEvent(40, { id: 'historical-edge' })
    around.mockResolvedValue({
      session,
      events: [historicalEvent, timelineEvent(50)],
      has_more: true,
      next_before: 20,
      latest_seq: 100,
      events_omitted_before: 39,
      events_omitted_after: 50
    })
    historicalOlder.mockResolvedValue({
      session,
      events: [timelineEvent(20)],
      has_more: true,
      next_before: 10,
      latest_seq: 100,
      events_omitted_before: 19,
      events_omitted_after: 80
    })
    const button = await showResult(result(historicalEvent.id, historicalEvent.seq, 'Historical edge'))
    fireEvent.click(button)
    await screen.findByText('turn:seq-40:assistant')

    act(() => virtuosoHarness.startReached?.())

    await waitFor(() => expect(historicalOlder).toHaveBeenCalledWith(
      SESSION_ID,
      historicalEvent.seq,
      expect.any(Number)
    ))
  })

  it('jumps directly to the semantic last row from the New button', () => {
    useAppStore.setState({
      snapshots: {
        [SESSION_ID]: {
          ...snapshot([timelineEvent(100)]),
          viewState: {
            sessionId: SESSION_ID,
            topItemId: 'event-100',
            topOffset: 0,
            atBottom: false,
            updatedAt: 1
          }
        }
      }
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    render(<Timeline />)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto'
    })
  })

  it('bounds the New-button settle pass when the live tail changes', () => {
    useAppStore.setState({
      snapshots: {
        [SESSION_ID]: {
          ...snapshot([timelineEvent(100)]),
          viewState: {
            sessionId: SESSION_ID,
            topItemId: 'event-100',
            topOffset: 0,
            atBottom: false,
            updatedAt: 1
          }
        }
      }
    })
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback)
      return frames.length
    })
    render(<Timeline />)
    frames.splice(0)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(1)

    act(() => frames.shift()?.(0))
    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(2)
    expect(frames).toHaveLength(0)

    act(() => virtuosoHarness.atBottomStateChange?.(false))
    act(() => useAppStore.setState({
      snapshots: { [SESSION_ID]: snapshot([timelineEvent(100), timelineEvent(101)]) }
    }))
    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledTimes(2)
  })

  it('jumps directly to the semantic last row from the global shortcut', () => {
    render(<Timeline />)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:jump-latest', {
        detail: { sessionId: SESSION_ID }
      }))
    })

    expect(virtuosoHarness.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto'
    })
  })

  it('does not rerender the virtual timeline when an unchanged parent rerenders', () => {
    const view = render(<Timeline />)
    const renders = virtuosoHarness.renderCount

    view.rerender(<Timeline />)

    expect(virtuosoHarness.renderCount).toBe(renders)
  })

  it('preserves the virtual scroller across live projection revisions', () => {
    const events = [timelineEvent(100)]
    useAppStore.setState({
      snapshots: { [SESSION_ID]: { ...snapshot(events), generation: 1 } }
    })
    render(<Timeline />)
    const scroller = screen.getByTestId('timeline-virtuoso')

    act(() => useAppStore.setState({
      snapshots: { [SESSION_ID]: { ...snapshot(events), generation: 2 } }
    }))

    expect(screen.getByTestId('timeline-virtuoso')).toBe(scroller)
  })

  it('keeps scroll-stop geometry measurement off the input frame', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      snapshots: {
        [SESSION_ID]: {
          ...snapshot([timelineEvent(100)]),
          viewState: {
            sessionId: SESSION_ID,
            topItemId: 'turn:seq-100:assistant',
            topOffset: 0,
            atBottom: false,
            updatedAt: 1
          }
        }
      }
    })
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    render(<Timeline />)
    await act(async () => vi.advanceTimersByTimeAsync(20))
    geometry.mockClear()

    act(() => virtuosoHarness.isScrolling?.(false))

    expect(geometry).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(499))
    expect(geometry).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(geometry).toHaveBeenCalled()
  })

  it('resets the virtual scroller for an accepted disjoint timeline replacement', () => {
    const initial = [timelineEvent(100)]
    useAppStore.setState({
      snapshots: {
        [SESSION_ID]: {
          ...snapshot(initial),
          generation: 1,
          timelineListGeneration: 0
        }
      }
    })
    render(<Timeline />)
    const scroller = screen.getByTestId('timeline-virtuoso')

    act(() => useAppStore.setState({
      snapshots: {
        [SESSION_ID]: {
          ...snapshot([timelineEvent(500)]),
          generation: 2,
          timelineListGeneration: 1
        }
      }
    }))

    expect(screen.getByTestId('timeline-virtuoso')).not.toBe(scroller)
  })
})
