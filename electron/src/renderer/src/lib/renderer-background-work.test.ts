import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleRendererBackgroundWork, startRendererBackgroundPolling } from './renderer-background-work'

describe('scheduleRendererBackgroundWork', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('waits for a renderer idle period instead of competing with interactive work', () => {
    const requestIdleCallback = vi.fn((_callback: IdleRequestCallback) => 17)
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const task = vi.fn()

    scheduleRendererBackgroundWork(task)
    expect(task).not.toHaveBeenCalled()

    const idleCallback = requestIdleCallback.mock.calls[0]?.[0]
    expect(idleCallback).toBeTypeOf('function')
    idleCallback?.({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline)
    expect(task).toHaveBeenCalledOnce()
  })

  it('cancels delayed and idle work when its owning surface goes away', () => {
    vi.useFakeTimers()
    const idleCallback = vi.fn(() => 23)
    const cancelIdleCallback = vi.fn()
    vi.stubGlobal('requestIdleCallback', idleCallback)
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback)
    const task = vi.fn()

    const cancelDelay = scheduleRendererBackgroundWork(task, { delayMs: 15_000 })
    cancelDelay()
    vi.advanceTimersByTime(15_000)
    expect(idleCallback).not.toHaveBeenCalled()

    const cancelIdle = scheduleRendererBackgroundWork(task)
    cancelIdle()
    expect(cancelIdleCallback).toHaveBeenCalledWith(23)
    expect(task).not.toHaveBeenCalled()
  })

  it('serializes recurring polls and cancels without rescheduling an in-flight task', async () => {
    vi.useFakeTimers()
    const idleCallbacks: IdleRequestCallback[] = []
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback)
      return idleCallbacks.length
    })
    vi.stubGlobal('requestIdleCallback', requestIdleCallback)
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    let finishFirst!: () => void
    let finishSecond!: () => void
    const task = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve }))

    const cancel = startRendererBackgroundPolling(task, { intervalMs: 4_000 })
    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(requestIdleCallback).not.toHaveBeenCalled()
    expect(task).toHaveBeenCalledTimes(1)

    finishFirst()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1_000 })
    expect(task).toHaveBeenCalledTimes(1)

    idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline)
    expect(task).toHaveBeenCalledTimes(2)
    cancel()
    finishSecond()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('keeps polling after a failed task and bounds the wait for an idle frame', async () => {
    vi.useFakeTimers()
    const idleCallbacks: IdleRequestCallback[] = []
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback)
      return idleCallbacks.length
    }))
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const onError = vi.fn()
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined)

    const cancel = startRendererBackgroundPolling(task, {
      intervalMs: 4_000,
      idleTimeoutMs: 750,
      onError
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'temporary failure' }))

    await vi.advanceTimersByTimeAsync(4_000)
    expect(window.requestIdleCallback).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 750 })
    idleCallbacks.shift()?.({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline)
    await Promise.resolve()
    expect(task).toHaveBeenCalledTimes(2)
    cancel()
  })
})
