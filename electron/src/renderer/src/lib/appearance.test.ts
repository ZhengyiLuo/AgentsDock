import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeAppearance, readAppearance, resolveAppearance, setAppearanceMode } from './appearance'

describe('resolveAppearance', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.appearance
    delete document.documentElement.dataset.theme
  })

  afterEach(() => vi.unstubAllGlobals())

  it('follows the system preference in system mode', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
  })

  it('keeps explicit appearance choices stable', () => {
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })

  it('persists explicit choices and applies them immediately', () => {
    setAppearanceMode('light')
    expect(readAppearance()).toBe('light')
    expect(window.localStorage.getItem('agentsdock.appearance')).toBe('light')
    expect(document.documentElement.dataset).toMatchObject({ appearance: 'light', theme: 'light' })
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('defaults invalid stored values back to system mode', () => {
    window.localStorage.setItem('agentsdock.appearance', 'sepia')
    expect(readAppearance()).toBe('system')
  })

  it('tracks a live macOS appearance change while in system mode', () => {
    let prefersDark = true
    let change: (() => void) | undefined
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return prefersDark },
      addEventListener: (_type: string, listener: () => void) => { change = listener },
      removeEventListener: vi.fn()
    }) as unknown as MediaQueryList))

    initializeAppearance()
    expect(document.documentElement.dataset.theme).toBe('dark')
    prefersDark = false
    change?.()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
