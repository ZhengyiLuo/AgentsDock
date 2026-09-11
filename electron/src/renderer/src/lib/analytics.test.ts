import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = '66b4fef625e5750d5527870f0ca96d5e'
const TRACK_URL = 'https://api.mixpanel.com/track?ip=0'
const PREFERENCE_KEY = 'agentsdock:analytics-consent:v1'
const ID_KEY = 'agentsdock:analytics-distinct-id:v1'

async function loadAnalytics() {
  vi.resetModules()
  return import('./analytics')
}

describe('analytics privacy configuration', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'agentsDock')
  })

  it('defaults enabled, purges legacy SDK state, and keeps the anonymous per-install id', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', request)
    window.localStorage.setItem(ID_KEY, 'existing-install-id')
    window.localStorage.setItem(`mp_${TOKEN}_mixpanel`, '{"distinct_id":"legacy"}')

    const analytics = await loadAnalytics()

    expect(analytics.getAnalyticsConsentDecision()).toBe('granted')
    // The former mixpanel-browser SDK state is still purged...
    expect(window.localStorage.getItem(`mp_${TOKEN}_mixpanel`)).toBeNull()
    // ...but the anonymous per-install identifier now persists across sessions.
    expect(window.localStorage.getItem(ID_KEY)).toBe('existing-install-id')
    analytics.trackEvent('app_launched')
    expect(request).toHaveBeenCalledOnce()
    const [, init] = request.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as Array<{ properties: Record<string, unknown> }>
    expect(payload[0].properties.distinct_id).toBe('existing-install-id')
  })

  it('treats a CI smoke-test launch (analyticsDisabled) as opted out, without touching storage', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', request)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { native: { analyticsDisabled: true } }
    })

    const analytics = await loadAnalytics()

    expect(analytics.getAnalyticsConsentDecision()).toBe('denied')
    analytics.trackEvent('app_launched')
    expect(request).not.toHaveBeenCalled()
    // A disposable CI profile never persists a would-be install id either.
    expect(window.localStorage.getItem(ID_KEY)).toBeNull()
  })

  it('preserves an explicit prior opt-out without sending an event', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', request)
    window.localStorage.setItem(PREFERENCE_KEY, 'denied')
    window.localStorage.setItem(ID_KEY, 'former-app-install-id')

    const analytics = await loadAnalytics()

    expect(analytics.getAnalyticsConsentDecision()).toBe('denied')
    expect(window.localStorage.getItem(ID_KEY)).toBeNull()
    analytics.trackEvent('app_launched')
    expect(request).not.toHaveBeenCalled()
  })

  it('posts an app-owned allow-listed payload with the anonymous per-install id', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', request)
    const analytics = await loadAnalytics()

    analytics.trackEvent('connection_tested', {
      success: false,
      path: '/private/workspace',
      url: 'file:///private/workspace',
      token: 'secret',
      current_url: 'file:///private/workspace',
      referrer: 'https://secret.example',
      screen: '3024x1964',
      browser: 'Chrome'
    } as unknown as { success?: boolean })

    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(TRACK_URL)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    const payload = JSON.parse(String(init.body)) as Array<{ event: string; properties: Record<string, unknown> }>
    expect(payload).toHaveLength(1)
    expect(payload[0].event).toBe('connection_tested')
    expect(payload[0].properties).toEqual({
      token: TOKEN,
      distinct_id: expect.any(String),
      time: expect.any(Number),
      platform: 'desktop',
      success: false
    })
    // The id is a real, non-empty, anonymous per-install value that is persisted.
    const distinctId = payload[0].properties.distinct_id as string
    expect(distinctId.length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(ID_KEY)).toBe(distinctId)
    // No content/PII leaked in beyond the allow-listed keys.
    expect(Object.keys(payload[0].properties).sort()).toEqual(['distinct_id', 'platform', 'success', 'time', 'token'])
  })

  it('aborts a hung request on opt-out, clears the id, and mints a fresh one on re-consent', async () => {
    let aborts = 0
    const request = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborts += 1
        reject(new Error('aborted'))
      }, { once: true })
    }))
    vi.stubGlobal('fetch', request)
    const analytics = await loadAnalytics()
    analytics.trackEvent('chat_opened')
    expect(request).toHaveBeenCalledOnce()

    analytics.setAnalyticsConsent(false)
    expect(aborts).toBe(1)
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe('denied')
    // Opt-out removes the per-install identifier from disk.
    expect(window.localStorage.getItem(ID_KEY)).toBeNull()
    analytics.trackEvent('message_sent')
    expect(request).toHaveBeenCalledOnce()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    analytics.setAnalyticsConsent(true)
    analytics.trackEvent('message_sent')
    expect(fetch).toHaveBeenCalledOnce()
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(init.body)) as Array<{ properties: Record<string, unknown> }>
    // Re-consent mints a fresh, non-empty, persisted identifier.
    const distinctId = payload[0].properties.distinct_id as string
    expect(distinctId.length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(ID_KEY)).toBe(distinctId)
  })

  it('bounds hung requests and never lets a synchronous network failure escape', async () => {
    vi.useFakeTimers()
    try {
      let aborts = 0
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborts += 1
          reject(new Error('timed out'))
        }, { once: true })
      })))
      const analytics = await loadAnalytics()
      analytics.trackEvent('app_launched')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(aborts).toBe(1)

      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('blocked') }))
      expect(() => analytics.trackEvent('server_added', { success: true })).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up a settled request after its renderer window is torn down', async () => {
    let settleRequest!: (response: Response) => void
    let aborts = 0
    const request = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      settleRequest = resolve
      init?.signal?.addEventListener('abort', () => { aborts += 1 }, { once: true })
    }))
    vi.stubGlobal('fetch', request)
    const analytics = await loadAnalytics()
    const rendererWindow = window
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const clearTimeout = vi.spyOn(rendererWindow, 'clearTimeout')
    const unhandledRejections: unknown[] = []
    const captureUnhandled = (reason: unknown) => { unhandledRejections.push(reason) }
    process.on('unhandledRejection', captureUnhandled)

    try {
      analytics.trackEvent('app_launched')
      expect(request).toHaveBeenCalledOnce()
      expect(Reflect.deleteProperty(globalThis, 'window')).toBe(true)

      settleRequest({ ok: true } as Response)
      await Promise.resolve()
      await Promise.resolve()

      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(clearTimeout).toHaveBeenCalledOnce()
      analytics.setAnalyticsConsent(false)
      expect(aborts).toBe(0)
      expect(unhandledRejections).toEqual([])
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
      process.off('unhandledRejection', captureUnhandled)
    }
  })
})
