import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRendererStallMonitor, type RendererStallDetails } from './renderer-stall-monitor'

interface TestObserver {
  callback: PerformanceObserverCallback
  observed?: PerformanceObserverInit
  disconnected: boolean
}

const observers: TestObserver[] = []

class TestPerformanceObserver {
  static supportedEntryTypes = ['event', 'long-animation-frame']
  private readonly state: TestObserver

  constructor(callback: PerformanceObserverCallback) {
    this.state = { callback, disconnected: false }
    observers.push(this.state)
  }

  observe(options?: PerformanceObserverInit): void { this.state.observed = options }
  disconnect(): void { this.state.disconnected = true }
  takeRecords(): PerformanceEntryList { return [] }
}

function emit(type: string, entry: Partial<PerformanceEntry> & Record<string, unknown>): void {
  const observer = observers.find(candidate => candidate.observed?.type === type)
  if (!observer) throw new Error(`No observer registered for ${type}`)
  const complete = {
    name: '',
    entryType: type,
    startTime: 0,
    duration: 0,
    toJSON: () => ({}),
    ...entry
  } as PerformanceEntry
  observer.callback({ getEntries: () => [complete] } as PerformanceObserverEntryList, {} as PerformanceObserver)
}

describe('renderer responsiveness monitor', () => {
  beforeEach(() => {
    observers.length = 0
    vi.useFakeTimers()
    vi.stubGlobal('PerformanceObserver', TestPerformanceObserver)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports interaction stalls below the old event-loop freeze threshold', () => {
    const reports: RendererStallDetails[] = []
    const stop = installRendererStallMonitor(
      () => ({ sessionId: 'chat-1', eventCount: 42, fileCount: 2, syncStatus: 'live' }),
      details => reports.push(details)
    )

    vi.advanceTimersByTime(2_100)
    emit('event', {
      name: 'keydown',
      startTime: 2_000,
      duration: 96,
      processingStart: 2_024,
      processingEnd: 2_084,
      interactionId: 7
    })

    expect(reports).toEqual([expect.objectContaining({
      source: 'interaction',
      eventType: 'keydown',
      blockedMs: 96,
      inputDelayMs: 24,
      handlerMs: 60,
      interactionId: 7,
      sessionId: 'chat-1'
    })])
    stop()
    expect(observers.every(observer => observer.disconnected)).toBe(true)
  })

  it('ignores healthy events and suppresses duplicate reports during cooldown', () => {
    const report = vi.fn()
    installRendererStallMonitor(
      () => ({ sessionId: null, eventCount: 0, fileCount: 0, syncStatus: 'idle' }),
      report
    )

    vi.advanceTimersByTime(2_100)
    emit('event', { name: 'keydown', startTime: 2_000, duration: 32 })
    emit('event', { name: 'wheel', startTime: 2_050, duration: 88 })
    emit('long-animation-frame', { startTime: 2_060, duration: 120, blockingDuration: 72 })

    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      source: 'interaction',
      eventType: 'wheel',
      blockedMs: 88
    }))
  })

  it('does not report background-tab work', () => {
    const report = vi.fn()
    installRendererStallMonitor(
      () => ({ sessionId: null, eventCount: 0, fileCount: 0, syncStatus: 'idle' }),
      report
    )
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    vi.advanceTimersByTime(2_100)
    emit('event', { name: 'keydown', startTime: 2_000, duration: 120 })
    expect(report).not.toHaveBeenCalled()
  })
})
