export interface RendererBackgroundWorkOptions {
  delayMs?: number
  idleTimeoutMs?: number
}

export interface RendererBackgroundPollingOptions {
  intervalMs: number
  idleTimeoutMs?: number
  runImmediately?: boolean
  onError?: (cause: unknown) => void
}

/**
 * Schedules non-visual renderer work without putting it directly on an input
 * or animation frame. This is the shared boundary for optional polling,
 * indexing, and cache maintenance that must yield to chat, editor, and xterm.
 *
 * The callback is deliberately synchronous: start one single-flight async
 * operation from it and schedule its successor only after that operation
 * settles. That keeps this helper from becoming another overlapping interval.
 */
export function scheduleRendererBackgroundWork(
  callback: () => void,
  options: RendererBackgroundWorkOptions = {}
): () => void {
  const delayMs = Math.max(0, options.delayMs ?? 0)
  const idleTimeoutMs = options.idleTimeoutMs === undefined
    ? null
    : Math.max(1, options.idleTimeoutMs)
  let cancelled = false
  let delayTimer: number | null = null
  let idleRequest: number | null = null

  const run = () => {
    if (!cancelled) callback()
  }
  const requestIdle = () => {
    if (cancelled) return
    if (typeof window.requestIdleCallback === 'function') {
      // Interactive surfaces win indefinitely by default. Optional background
      // freshness is not allowed to force itself onto a busy input frame.
      idleRequest = idleTimeoutMs === null
        ? window.requestIdleCallback(run)
        : window.requestIdleCallback(run, { timeout: idleTimeoutMs })
      return
    }
    // Tests and older webviews may not expose requestIdleCallback. A
    // microtask preserves cancellation while still keeping call sites async.
    queueMicrotask(run)
  }

  if (delayMs > 0) {
    delayTimer = window.setTimeout(() => {
      delayTimer = null
      requestIdle()
    }, delayMs)
  } else {
    requestIdle()
  }

  return () => {
    cancelled = true
    if (delayTimer !== null) window.clearTimeout(delayTimer)
    if (idleRequest !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleRequest)
    }
  }
}

/**
 * Runs one renderer poll at a time and schedules the next poll only after the
 * current one settles. Polls wait for an idle frame, but use a bounded timeout
 * so a continuously active window cannot make remote state stale forever.
 */
export function startRendererBackgroundPolling(
  task: () => void | Promise<void>,
  options: RendererBackgroundPollingOptions
): () => void {
  const intervalMs = Math.max(1, options.intervalMs)
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 1_000)
  let active = true
  let inFlight = false
  let cancelScheduled: (() => void) | null = null

  const scheduleNext = () => {
    if (!active) return
    cancelScheduled?.()
    cancelScheduled = scheduleRendererBackgroundWork(() => {
      cancelScheduled = null
      void run()
    }, { delayMs: intervalMs, idleTimeoutMs })
  }

  const run = async () => {
    if (!active || inFlight) return
    inFlight = true
    try {
      await task()
    } catch (cause) {
      options.onError?.(cause)
    } finally {
      inFlight = false
      scheduleNext()
    }
  }

  if (options.runImmediately === false) scheduleNext()
  else void run()

  return () => {
    active = false
    cancelScheduled?.()
    cancelScheduled = null
  }
}
