import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsDelivery } from './analytics-delivery'

describe('bounded analytics delivery', () => {
  let enabled: boolean
  let delivery: AnalyticsDelivery
  let remove: () => void
  const payload = { event: 'app_launched', properties: { time: 42, distinct_id: 'anonymous', $insert_id: 'same-event' } }
  beforeEach(() => {
    vi.useFakeTimers()
    enabled = true
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    delivery = new AnalyticsDelivery(window, () => enabled)
    remove = delivery.listen()
  })
  afterEach(() => { delivery.clear(); remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it.each([429, 502, 503, 504])('retries HTTP %s with identical event/time/insert id, then stops after acceptance', async status => {
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValue(new Response('{"status":1}'))
    vi.stubGlobal('fetch', request)
    delivery.enqueue(payload)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body)
    expect(request.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([new Response('', { status: 400 }), new Response('{"status":0,"error":"invalid"}')])('does not retry permanent rejection', async response => {
    const request = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', request)
    delivery.enqueue(payload)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('bounds network retries and never lets an error affect callers', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', request)
    expect(() => delivery.enqueue(payload)).not.toThrow()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('keeps retry timing and the original event timestamp when the wall clock moves backwards', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('1'))
    vi.stubGlobal('fetch', request)
    delivery.enqueue(payload)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() - 60 * 60_000)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body)
  })

  it('keeps at most 100 offline events in memory and flushes after online', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const request = vi.fn(async () => new Response('1'))
    vi.stubGlobal('fetch', request)
    for (let i = 0; i < 110; i++) delivery.enqueue(payload)
    expect(request).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledTimes(100)
  })

  it('drops expired offline events instead of replaying stale history', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const request = vi.fn(async () => new Response('1'))
    vi.stubGlobal('fetch', request)
    delivery.enqueue(payload)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    expect(request).not.toHaveBeenCalled()
  })

  it('clears queued and in-flight data on opt-out without resurrection', async () => {
    const request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', request)
    delivery.enqueue(payload)
    enabled = false
    delivery.clear()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
