export interface RendererStallContext {
  sessionId: string | null
  eventCount: number
  fileCount: number
  syncStatus: string
}

export interface RendererStallDetails extends RendererStallContext {
  blockedMs: number
  heapMB?: number
  source?: 'event-loop' | 'interaction' | 'animation-frame'
  eventType?: string
  inputDelayMs?: number
  handlerMs?: number
  interactionId?: number
}

const SAMPLE_INTERVAL_MS = 250
const STALL_THRESHOLD_MS = 220
// A 220ms timer drift catches freezes, but misses the shorter stalls that make
// typing and scrolling feel broken. Chromium's native Event Timing and Long
// Animation Frame observers account for those without adding work to every
// input handler or animation frame.
const RESPONSIVENESS_THRESHOLD_MS = 80
const REPORT_COOLDOWN_MS = 2_000

interface InteractionPerformanceEntry extends PerformanceEntry {
  interactionId?: number
  processingStart?: number
  processingEnd?: number
}

interface LongAnimationFramePerformanceEntry extends PerformanceEntry {
  blockingDuration?: number
}

function heapMB(): number | undefined {
  const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } }
  const usedBytes = memory.memory?.usedJSHeapSize
  return usedBytes == null ? undefined : Math.round(usedBytes / 1_048_576)
}

export function installRendererStallMonitor(
  context: () => RendererStallContext,
  report: (details: RendererStallDetails) => void
): () => void {
  let expected = performance.now() + SAMPLE_INTERVAL_MS
  let lastReport = 0
  const observers: PerformanceObserver[] = []
  const reportIfRelevant = (details: Omit<RendererStallDetails, keyof RendererStallContext>): void => {
    const now = performance.now()
    if (
      document.visibilityState !== 'visible'
      || details.blockedMs < RESPONSIVENESS_THRESHOLD_MS
      || now - lastReport < REPORT_COOLDOWN_MS
    ) return
    lastReport = now
    report({ ...context(), ...details, heapMB: heapMB() })
  }

  const observe = (
    type: 'event' | 'long-animation-frame',
    handle: (entry: PerformanceEntry) => void
  ): void => {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) handle(entry)
      })
      observer.observe({
        type,
        buffered: false,
        ...(type === 'event' ? { durationThreshold: RESPONSIVENESS_THRESHOLD_MS } : {})
      } as PerformanceObserverInit)
      observers.push(observer)
    } catch {
      // Older Electron/Chromium builds may not expose one of these entry
      // types. Timer drift remains as the universal fallback.
    }
  }

  observe('event', entry => {
    const interaction = entry as InteractionPerformanceEntry
    const processingStart = interaction.processingStart ?? interaction.startTime
    const processingEnd = interaction.processingEnd ?? processingStart
    reportIfRelevant({
      blockedMs: Math.round(interaction.duration),
      source: 'interaction',
      eventType: interaction.name,
      inputDelayMs: Math.max(0, Math.round(processingStart - interaction.startTime)),
      handlerMs: Math.max(0, Math.round(processingEnd - processingStart)),
      interactionId: interaction.interactionId
    })
  })
  observe('long-animation-frame', entry => {
    const frame = entry as LongAnimationFramePerformanceEntry
    reportIfRelevant({
      blockedMs: Math.round(frame.duration),
      source: 'animation-frame',
      handlerMs: frame.blockingDuration == null ? undefined : Math.max(0, Math.round(frame.blockingDuration))
    })
  })

  const timer = window.setInterval(() => {
    const now = performance.now()
    const blockedMs = Math.max(0, now - expected)
    expected = now + SAMPLE_INTERVAL_MS
    if (document.visibilityState !== 'visible' || blockedMs < STALL_THRESHOLD_MS || now - lastReport < REPORT_COOLDOWN_MS) return
    lastReport = now
    report({
      ...context(),
      blockedMs: Math.round(blockedMs),
      heapMB: heapMB(),
      source: 'event-loop'
    })
  }, SAMPLE_INTERVAL_MS)
  return () => {
    window.clearInterval(timer)
    for (const observer of observers) observer.disconnect()
  }
}
