import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale } from '@shared/i18n'
import type { LanguagePreference } from '@shared/i18n'
import { disposeLanguage, initializeLanguage, LANGUAGE_STORAGE_KEY, setLanguagePreference, t, useLanguagePreference, useLocale } from './i18n'

type Snapshot = { preference: LanguagePreference; systemLocale: string }

function nativeBridge(initial: Snapshot = { preference: 'en', systemLocale: 'en-US' }) {
  let listener: ((value: Snapshot) => void) | undefined
  const unsubscribe = vi.fn()
  const language = {
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn(async (preference: LanguagePreference) => ({ ...initial, preference }))
  }
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: { language, events: { on: vi.fn((event: string, callback: (value: Snapshot) => void) => {
      if (event === 'app:language') listener = callback
      return unsubscribe
    }) } }
  })
  return { language, emit: (value: Snapshot) => listener?.(value), unsubscribe }
}

beforeEach(async () => {
  cleanup()
  disposeLanguage()
  Reflect.deleteProperty(window, 'agentsDock')
  await setLanguagePreference('en')
  window.localStorage.clear()
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
})

afterEach(() => {
  cleanup()
  disposeLanguage()
  Reflect.deleteProperty(window, 'agentsDock')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('renderer language preferences', () => {
  it('preserves English by default even on a Chinese system', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
    await initializeLanguage()
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    await setLanguagePreference('system')
    expect(getLocale()).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('reads native preferences before startup and saves explicit changes', async () => {
    const native = nativeBridge({ preference: 'zh-CN', systemLocale: 'en-US' })
    await initializeLanguage()
    expect(getLocale()).toBe('zh-CN')
    await setLanguagePreference('en')
    expect(native.language.set).toHaveBeenCalledWith('en')
    expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)!)).toEqual({ preference: 'en', pending: false })
  })

  it('restores the cached choice when the bridge fails and retries an unsaved preference on startup', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ preference: 'zh-CN', pending: false }))
    const native = nativeBridge()
    native.language.get.mockRejectedValue(new Error('IPC unavailable'))
    await initializeLanguage()
    expect(getLocale()).toBe('zh-CN')
    native.language.set.mockRejectedValueOnce(new Error('read only storage'))
    await setLanguagePreference('system')
    expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)!)).toEqual({ preference: 'system', pending: true })
    disposeLanguage()
    await initializeLanguage()
    expect(native.language.set).toHaveBeenLastCalledWith('system')
    expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)!)).toEqual({ preference: 'system', pending: false })
  })

  it('survives denied local storage and an older preload with no language bridge', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await initializeLanguage()
    await setLanguagePreference('zh-CN')
    expect(getLocale()).toBe('zh-CN')
  })

  it('does not let a stale startup response overwrite a newer user choice', async () => {
    const native = nativeBridge()
    let resolveGet!: (value: Snapshot) => void
    native.language.get.mockImplementation(() => new Promise<Snapshot>(resolve => { resolveGet = resolve }))
    const initialized = initializeLanguage()
    await Promise.resolve()
    await setLanguagePreference('zh-CN')
    resolveGet({ preference: 'en', systemLocale: 'en-US' })
    await initialized
    expect(getLocale()).toBe('zh-CN')
  })

  it('bounds startup waiting but still applies a late native response', async () => {
    vi.useFakeTimers()
    const native = nativeBridge()
    let resolveGet!: (value: Snapshot) => void
    native.language.get.mockImplementation(() => new Promise<Snapshot>(resolve => { resolveGet = resolve }))
    const initialized = initializeLanguage()
    await vi.advanceTimersByTimeAsync(750)
    await initialized
    expect(getLocale()).toBe('en')
    resolveGet({ preference: 'zh-CN', systemLocale: 'en-US' })
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocale()).toBe('zh-CN')
  })

  it('serializes rapid native saves and keeps the last choice', async () => {
    const native = nativeBridge()
    await initializeLanguage()
    let resolveFirst!: (value: Snapshot) => void
    native.language.set.mockImplementationOnce(() => new Promise<Snapshot>(resolve => { resolveFirst = resolve }))
    const first = setLanguagePreference('zh-CN')
    await Promise.resolve()
    const second = setLanguagePreference('en')
    resolveFirst({ preference: 'zh-CN', systemLocale: 'en-US' })
    await Promise.all([first, second])
    expect(native.language.set.mock.calls.map(call => call[0])).toEqual(['zh-CN', 'en'])
    expect(getLocale()).toBe('en')
    expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)!)).toEqual({ preference: 'en', pending: false })
  })

  it('reacts to native system language and cross-window storage events', async () => {
    const native = nativeBridge({ preference: 'system', systemLocale: 'en-US' })
    await initializeLanguage()
    native.emit({ preference: 'system', systemLocale: 'zh-CN' })
    expect(getLocale()).toBe('zh-CN')
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ preference: 'en', pending: false }))
    window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY }))
    expect(getLocale()).toBe('en')
    disposeLanguage()
    expect(native.unsubscribe).toHaveBeenCalledOnce()
  })

  it('updates translated UI without remounting, losing drafts, or moving scroll position', async () => {
    await initializeLanguage()
    const mounted = vi.fn()
    function Draft() {
      useLocale()
      const [value, setValue] = useState('')
      useEffect(() => { mounted() }, [])
      return <div data-testid="scroll"><label>{t('settings.general')}<input aria-label="draft" value={value} onChange={event => setValue(event.currentTarget.value)} /></label></div>
    }
    render(<Draft />)
    const input = screen.getByRole('textbox')
    const scroller = screen.getByTestId('scroll')
    fireEvent.change(input, { target: { value: 'Keep this draft 会话' } })
    scroller.scrollTop = 240
    await act(() => setLanguagePreference('zh-CN'))
    expect(screen.getByText('通用')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toHaveValue('Keep this draft 会话')
    expect(scroller.scrollTop).toBe(240)
    expect(mounted).toHaveBeenCalledOnce()
    await act(() => setLanguagePreference('en'))
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(input).toHaveValue('Keep this draft 会话')
  })

  it('exposes save failure and lets the user retry the same preference', async () => {
    const native = nativeBridge()
    await initializeLanguage()
    function Preference() {
      const language = useLanguagePreference()
      return <output>{language.preference}:{String(language.saveFailed)}</output>
    }
    render(<Preference />)
    native.language.set.mockRejectedValueOnce(new Error('failed'))
    await act(() => setLanguagePreference('zh-CN'))
    expect(screen.getByText('zh-CN:true')).toBeInTheDocument()
    await act(() => setLanguagePreference('zh-CN'))
    expect(screen.getByText('zh-CN:false')).toBeInTheDocument()
  })
})
