import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { WorkspaceProfileScope } from '@shared/types'
import { TIMELINE_VIEWPORT_LAYOUT_EVENT, type TimelineViewportLayoutDetail } from '../lib/workspace-layout'
import {
  CHAT_SPLIT_COMPACT_CONTROL_RAIL_PX,
  ChatSplitView,
  chatSplitTrackPixels,
  shouldStackChatSplit
} from './ChatSplitView'

const scope: WorkspaceProfileScope = {
  profileId: 'profile-a',
  profileGeneration: 7,
  serverIdentity: 'server-a'
}

let getScoped: ReturnType<typeof vi.fn>
let setScoped: ReturnType<typeof vi.fn>
let animationFrames: Map<number, FrameRequestCallback>
let nextAnimationFrame: number
let resizeCallback: ResizeObserverCallback

describe('ChatSplitView', () => {
  beforeEach(() => {
    getScoped = vi.fn().mockResolvedValue(50)
    setScoped = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn(),
          set: vi.fn(),
          getScoped,
          setScoped
        }
      } as unknown as AgentsDockAPI
    })
    animationFrames = new Map()
    nextAnimationFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = ++nextAnimationFrame
      animationFrames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      animationFrames.delete(id)
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    cleanup()
    document.body.classList.remove('chat-split-resizing')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts at an even split and restores a workspace-scoped ratio', async () => {
    const first = renderSplit()
    const firstSeparator = screen.getByRole('separator', { name: 'Resize chat panes' })
    expect(firstSeparator).toHaveAttribute('aria-valuenow', '50')
    expect(first.container.querySelector('.chat-split-view')).toHaveStyle({ '--chat-split-ratio': '50%' })
    expect(getScoped).toHaveBeenCalledWith(scope, 'chatSplitRatio:v1', 50)
    first.unmount()

    getScoped.mockResolvedValueOnce(64)
    const restored = renderSplit()
    await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize chat panes' })).toHaveAttribute('aria-valuenow', '64'))
    expect(restored.container.querySelector('.chat-split-view')).toHaveStyle({ '--chat-split-ratio': '64%' })
  })

  it('keeps covered chat panes mounted but inert to focus and assistive technology', () => {
    const view = render(<ChatSplitView
      preferenceScope={scope}
      primary={<div data-testid="primary-chat">Primary chat</div>}
      secondary={<div data-testid="secondary-chat">Secondary chat</div>}
      inactive
    />)

    const split = view.container.querySelector('.chat-split-view')
    expect(split).toHaveAttribute('inert')
    expect(split).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('primary-chat')).toBeInTheDocument()
    expect(screen.getByTestId('secondary-chat')).toBeInTheDocument()
  })

  it('supports arrow, Home, and End keyboard resizing with layout lifecycle events', async () => {
    const phases = observeLayoutPhases()
    renderSplit()
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })
    await waitFor(() => expect(getScoped).toHaveBeenCalled())

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '46')
    flushAnimationFrames()
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '50')
    flushAnimationFrames()
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '28')
    flushAnimationFrames()
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '72')
    flushAnimationFrames()

    expect(setScoped.mock.calls.map(call => call[2])).toEqual([46, 50, 28, 72])
    expect(phases.values).toEqual([
      'begin', 'end',
      'begin', 'end',
      'begin', 'end',
      'begin', 'end'
    ])
    phases.stop()
  })

  it('resets the divider to an even split on double click', async () => {
    const phases = observeLayoutPhases()
    getScoped.mockResolvedValueOnce(63)
    renderSplit()
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })
    await waitFor(() => expect(separator).toHaveAttribute('aria-valuenow', '63'))
    flushAnimationFrames()

    fireEvent.doubleClick(separator)
    flushAnimationFrames()

    expect(separator).toHaveAttribute('aria-valuenow', '50')
    expect(setScoped).toHaveBeenLastCalledWith(scope, 'chatSplitRatio:v1', 50)
    expect(phases.values).toEqual(['begin', 'end', 'begin', 'end'])
    phases.stop()
  })

  it('publishes layout changes when the responsive orientation changes', () => {
    const phases = observeLayoutPhases()
    const { container } = renderSplit()
    const root = container.querySelector('.chat-split-view') as HTMLDivElement
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })

    act(() => resizeCallback([{ contentRect: { width: 700, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(root).toHaveClass('stacked')
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    flushAnimationFrames()
    expect(phases.values).toEqual(['begin', 'end'])

    act(() => resizeCallback([{ contentRect: { width: 1_000, height: 700 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(root).not.toHaveClass('stacked')
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    flushAnimationFrames()
    expect(phases.values).toEqual(['begin', 'end', 'begin', 'end'])
    phases.stop()
  })

  it('keeps the exact ratio in a 600px stacked split and falls back side-by-side for a 280px terminal workspace', () => {
    const { container } = renderSplit()
    const root = container.querySelector('.chat-split-view') as HTMLDivElement
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })

    act(() => resizeCallback([{ contentRect: { width: 840, height: 600 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(root).not.toHaveClass('stacked')
    expect(root).not.toHaveClass('short')
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')

    act(() => resizeCallback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(root).toHaveClass('stacked')
    expect(root).not.toHaveClass('short')
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '28')
    expect(root).toHaveStyle({ '--chat-split-ratio': '28%' })
    const home = chatSplitTrackPixels(800, 600, 28)
    expect(home).toEqual({ orientation: 'stacked', primary: 168, secondary: 423 })
    expect(Math.min(home.primary, home.secondary)).toBeGreaterThanOrEqual(CHAT_SPLIT_COMPACT_CONTROL_RAIL_PX)

    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '72')
    expect(root).toHaveStyle({ '--chat-split-ratio': '72%' })
    const end = chatSplitTrackPixels(800, 600, 72)
    expect(end).toEqual({ orientation: 'stacked', primary: 432, secondary: 159 })
    expect(Math.min(end.primary, end.secondary)).toBeGreaterThanOrEqual(CHAT_SPLIT_COMPACT_CONTROL_RAIL_PX)

    act(() => resizeCallback([{ contentRect: { width: 520, height: 280 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(root).not.toHaveClass('stacked')
    expect(root).toHaveClass('short')
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuenow', '72')
    const terminalOpen = chatSplitTrackPixels(520, 280, 72)
    expect(terminalOpen.orientation).toBe('horizontal')
    expect(terminalOpen.primary).toBeCloseTo(374.4, 5)
    expect(terminalOpen.secondary).toBeCloseTo(136.6, 5)
  })

  it('uses the 840px and 600px boundaries without a ratio-clamping dead zone', () => {
    expect(shouldStackChatSplit(839, 600)).toBe(true)
    expect(shouldStackChatSplit(840, 600)).toBe(false)
    expect(shouldStackChatSplit(800, 599)).toBe(false)
    expect(shouldStackChatSplit(800, 600)).toBe(true)
  })

  it('drags the divider, publishes begin/update/end, and persists the final ratio', async () => {
    const phases = observeLayoutPhases()
    const { container } = renderSplit()
    const root = container.querySelector('.chat-split-view') as HTMLDivElement
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1_000, bottom: 500,
      width: 1_000, height: 500, toJSON: () => ({})
    } as DOMRect)
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })
    await waitFor(() => expect(getScoped).toHaveBeenCalled())

    fireEvent.pointerDown(separator, { button: 0, clientX: 500, clientY: 250 })
    expect(root).toHaveClass('resizing')
    expect(document.body).toHaveClass('chat-split-resizing')
    expect(phases.values).toEqual(['begin'])

    fireEvent.pointerMove(window, { clientX: 680, clientY: 250 })
    flushAnimationFrames()
    expect(separator).toHaveAttribute('aria-valuenow', '68')
    expect(phases.values).toEqual(['begin', 'update'])

    fireEvent.pointerUp(window)
    expect(root).not.toHaveClass('resizing')
    expect(document.body).not.toHaveClass('chat-split-resizing')
    expect(setScoped).toHaveBeenLastCalledWith(scope, 'chatSplitRatio:v1', 68)
    flushAnimationFrames()
    expect(phases.values).toEqual(['begin', 'update', 'end'])
    phases.stop()
  })

  it('removes global drag listeners and body state when unmounted mid-resize', async () => {
    const phases = observeLayoutPhases()
    const { unmount } = renderSplit()
    const separator = screen.getByRole('separator', { name: 'Resize chat panes' })
    await waitFor(() => expect(getScoped).toHaveBeenCalled())
    fireEvent.pointerDown(separator, { button: 0 })
    expect(document.body).toHaveClass('chat-split-resizing')

    unmount()
    expect(document.body).not.toHaveClass('chat-split-resizing')
    flushAnimationFrames()
    expect(phases.values).toEqual(['begin', 'end'])
    const callsAfterCleanup = setScoped.mock.calls.length

    fireEvent.pointerMove(window, { clientX: 700 })
    fireEvent.pointerUp(window)
    flushAnimationFrames()
    expect(setScoped).toHaveBeenCalledTimes(callsAfterCleanup)
    expect(phases.values).toEqual(['begin', 'end'])
    phases.stop()
  })
})

function renderSplit() {
  return render(<ChatSplitView
    preferenceScope={scope}
    primary={<div>Primary chat</div>}
    secondary={<div>Secondary chat</div>}
  />)
}

function flushAnimationFrames(): void {
  const callbacks = [...animationFrames.values()]
  animationFrames.clear()
  act(() => callbacks.forEach(callback => callback(performance.now())))
}

function observeLayoutPhases(): { values: string[]; stop(): void } {
  const values: string[] = []
  const listener = (event: Event) => {
    values.push((event as CustomEvent<TimelineViewportLayoutDetail>).detail.phase)
  }
  window.addEventListener(TIMELINE_VIEWPORT_LAYOUT_EVENT, listener)
  return {
    values,
    stop: () => window.removeEventListener(TIMELINE_VIEWPORT_LAYOUT_EVENT, listener)
  }
}
