import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNavigatorLandmark } from '../lib/timeline-minimap'
import { TimelineMinimap, type TimelineMinimapHandle } from './TimelineMinimap'

describe('TimelineMinimap', () => {
  const fillRect = vi.fn()
  const addColorStop = vi.fn()

  beforeEach(() => {
    document.documentElement.dataset.theme = 'dark'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 40,
      height: 400,
      top: 0,
      right: 40,
      bottom: 400,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect,
      createLinearGradient: vi.fn(() => ({ addColorStop }))
    } as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fillRect.mockReset()
    addColorStop.mockReset()
    delete document.documentElement.dataset.theme
  })

  it('repaints immediately when the current turn changes inside the visible rail', () => {
    const ref = createRef<TimelineMinimapHandle>()
    const landmarks: TimelineNavigatorLandmark[] = Array.from({ length: 20 }, (_, index) => ({
      key: `turn-${index}`,
      kind: 'assistant',
      start_seq: index + 1,
      end_seq: index + 1,
      title: `Turn ${index}`,
      preview: `Response ${index}`,
      index,
      endIndex: index
    }))
    render(<TimelineMinimap ref={ref} landmarks={landmarks} onSeek={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(10, 10))

    expect(fillRect).toHaveBeenCalled()
  })

  it('pins the current marker to the final rail tick at the hard bottom', () => {
    const ref = createRef<TimelineMinimapHandle>()
    const landmarks: TimelineNavigatorLandmark[] = Array.from({ length: 100 }, (_, index) => ({
      key: `turn-${index}`,
      kind: 'assistant',
      start_seq: index + 1,
      end_seq: index + 1,
      title: `Turn ${index}`,
      preview: `Response ${index}`,
      index,
      endIndex: index
    }))
    render(<TimelineMinimap ref={ref} landmarks={landmarks} onSeek={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(99, 99, true))

    expect(fillRect.mock.calls).toContainEqual([10, 390, 19, 1])
  })

  it('repaints its canvas palette when appearance changes', () => {
    const landmarks: TimelineNavigatorLandmark[] = Array.from({ length: 50 }, (_, index) => ({
      key: `turn-${index}`,
      kind: 'assistant',
      start_seq: index + 1,
      end_seq: index + 1,
      title: `Turn ${index}`,
      preview: `Response ${index}`,
      index,
      endIndex: index
    }))
    render(<TimelineMinimap landmarks={landmarks} onSeek={vi.fn()} />)
    fillRect.mockClear()
    addColorStop.mockClear()

    act(() => {
      document.documentElement.dataset.theme = 'light'
      window.dispatchEvent(new CustomEvent('agentsdock:appearance', { detail: 'light' }))
    })

    expect(fillRect).toHaveBeenCalled()
    expect(addColorStop).toHaveBeenCalledWith(1, '#fbfbfa')
  })
})
