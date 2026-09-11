import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNavigatorLandmark } from '../lib/timeline-minimap'
import { positionForY, TimelineMinimap, type TimelineMinimapHandle, yForPosition } from './TimelineMinimap'

function landmarks(count: number): TimelineNavigatorLandmark[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `turn-${index}`,
    kind: 'assistant',
    start_seq: index + 1,
    end_seq: index + 1,
    title: `Turn ${index}`,
    preview: `Response ${index}`,
    index,
    endIndex: index
  }))
}

describe('TimelineMinimap', () => {
  const fillRect = vi.fn()

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
      fillRect
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
    delete document.documentElement.dataset.theme
  })

  it('repaints immediately when the current turn changes', () => {
    const ref = createRef<TimelineMinimapHandle>()
    render(<TimelineMinimap ref={ref} landmarks={landmarks(20)} onSeek={vi.fn()} onScroll={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(10, 10))

    expect(fillRect).toHaveBeenCalled()
  })

  it('pins the current marker to the final whole-chat coordinate at the hard bottom', () => {
    const ref = createRef<TimelineMinimapHandle>()
    render(<TimelineMinimap ref={ref} landmarks={landmarks(100)} onSeek={vi.fn()} onScroll={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(99, 99, true))

    expect(fillRect.mock.calls).toContainEqual([10, 390, 19, 1])
  })

  it('pins to the final whole-chat tick when the loaded tail maps before remote landmarks', () => {
    const ref = createRef<TimelineMinimapHandle>()
    const wholeChat = landmarks(100).map((landmark, position) => ({
      ...landmark,
      index: position >= 80 && position < 90 ? position - 80 : undefined,
      endIndex: position >= 80 && position < 90 ? position - 80 : undefined
    }))
    render(<TimelineMinimap ref={ref} landmarks={wholeChat} onSeek={vi.fn()} onScroll={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(9, 9, true))

    expect(fillRect.mock.calls).toContainEqual([10, 390, 19, 1])
  })

  it('does not move or redraw background landmarks while visible ranges change rapidly', () => {
    const ref = createRef<TimelineMinimapHandle>()
    render(<TimelineMinimap ref={ref} landmarks={landmarks(100)} onSeek={vi.fn()} onScroll={vi.fn()} />)

    fillRect.mockClear()
    act(() => ref.current?.setVisibleRange(80, 80))
    act(() => {
      ref.current?.setVisibleRange(10, 10)
      ref.current?.setVisibleRange(55, 55)
    })

    expect(fillRect.mock.calls.length).toBeGreaterThan(0)
    expect(fillRect.mock.calls.every(call => call[0] !== 16)).toBe(true)
  })

  it('keeps dense whole-chat ticks legible while retaining the full landmark map', () => {
    const onSeek = vi.fn()
    const { getByRole } = render(<TimelineMinimap landmarks={landmarks(1_000)} onSeek={onSeek} onScroll={vi.fn()} />)
    const rail = getByRole('scrollbar')
    const backgroundTicks = fillRect.mock.calls.filter(call => call[0] === 16)
    const tickRows = [...new Set(backgroundTicks.map(call => Number(call[1])))].sort((left, right) => left - right)

    expect(tickRows.length).toBeLessThan(100)
    expect(tickRows.every((row, index) => index === 0 || row - tickRows[index - 1] >= 6)).toBe(true)
    expect(rail).toHaveAttribute('aria-valuemax', '999')
  })

  it('keeps the current tick without drawing a vertical viewport bar', () => {
    const ref = createRef<TimelineMinimapHandle>()
    render(<TimelineMinimap ref={ref} landmarks={landmarks(100)} onSeek={vi.fn()} onScroll={vi.fn()} />)
    fillRect.mockClear()

    act(() => ref.current?.setVisibleRange(20, 30))

    expect(fillRect.mock.calls.some(call => call[0] === 31)).toBe(false)
    expect(fillRect.mock.calls.some(call => call[0] === 10 && call[2] === 19 && call[3] === 1)).toBe(true)
  })

  it('maps one pointer coordinate to the same landmark regardless of viewport position', () => {
    const ref = createRef<TimelineMinimapHandle>()
    const onSeek = vi.fn()
    const { getByRole } = render(<TimelineMinimap ref={ref} landmarks={landmarks(100)} onSeek={onSeek} onScroll={vi.fn()} />)
    const rail = getByRole('scrollbar')
    Object.defineProperties(rail, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => false) }
    })

    act(() => ref.current?.setVisibleRange(80, 80))
    fireEvent.pointerDown(rail, { button: 0, clientY: 120, pointerId: 1 })
    fireEvent.pointerUp(rail, { button: 0, clientY: 120, pointerId: 1 })

    act(() => ref.current?.setVisibleRange(10, 10))
    fireEvent.pointerDown(rail, { button: 0, clientY: 120, pointerId: 2 })
    fireEvent.pointerUp(rail, { button: 0, clientY: 120, pointerId: 2 })

    expect(onSeek).toHaveBeenCalledTimes(2)
    expect(onSeek.mock.calls[0][0]).toMatchObject({ key: 'turn-29' })
    expect(onSeek.mock.calls[1][0]).toMatchObject({ key: 'turn-29' })
  })

  it('routes wheel input to the conversation instead of moving the map', () => {
    const onScroll = vi.fn()
    const { getByRole } = render(<TimelineMinimap landmarks={landmarks(100)} onSeek={vi.fn()} onScroll={onScroll} />)

    fireEvent.wheel(getByRole('scrollbar'), { deltaY: 12, deltaMode: 1 })

    expect(onScroll).toHaveBeenCalledWith(216)
  })

  it('uses inverse stable whole-chat coordinates', () => {
    for (const position of [0, 1, 29, 50, 98, 99]) {
      expect(positionForY(yForPosition(position, 100, 400), 100, 400)).toBe(position)
    }
  })

  it('repaints its canvas palette when appearance changes', () => {
    render(<TimelineMinimap landmarks={landmarks(50)} onSeek={vi.fn()} onScroll={vi.fn()} />)
    fillRect.mockClear()

    act(() => {
      document.documentElement.dataset.theme = 'light'
      window.dispatchEvent(new CustomEvent('agentsdock:appearance', { detail: 'light' }))
    })

    expect(fillRect).toHaveBeenCalled()
  })
})
