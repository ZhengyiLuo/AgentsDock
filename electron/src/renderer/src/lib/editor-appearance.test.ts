import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EDITOR_APPEARANCE,
  EDITOR_APPEARANCE_EVENT,
  EDITOR_APPEARANCE_STORAGE_KEY,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_THEMES,
  clampEditorFontSize,
  normalizeEditorAppearance,
  readEditorAppearance,
  resolveEditorTheme,
  writeEditorAppearance
} from './editor-appearance'

describe('editor appearance', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults invalid values and clamps font sizes to the supported range', () => {
    expect(normalizeEditorAppearance(null)).toEqual(DEFAULT_EDITOR_APPEARANCE)
    expect(normalizeEditorAppearance({ theme: 'hot-dog-stand', fontSize: 100 })).toEqual({
      theme: DEFAULT_EDITOR_APPEARANCE.theme,
      fontSize: EDITOR_FONT_SIZE_MAX
    })
    expect(clampEditorFontSize(5)).toBe(EDITOR_FONT_SIZE_MIN)
    expect(clampEditorFontSize('16.4')).toBe(16)
  })

  it('persists normalized settings and announces live changes', () => {
    const listener = vi.fn()
    window.addEventListener(EDITOR_APPEARANCE_EVENT, listener)

    expect(writeEditorAppearance({ theme: 'github-light', fontSize: 17 })).toEqual({
      theme: 'github-light',
      fontSize: 17
    })
    expect(readEditorAppearance()).toEqual({ theme: 'github-light', fontSize: 17 })
    expect(JSON.parse(window.localStorage.getItem(EDITOR_APPEARANCE_STORAGE_KEY) ?? '')).toEqual({
      theme: 'github-light',
      fontSize: 17
    })
    expect(listener).toHaveBeenCalledTimes(1)

    window.removeEventListener(EDITOR_APPEARANCE_EVENT, listener)
  })

  it('matches the app palette by default while preserving explicit overrides', () => {
    expect(DEFAULT_EDITOR_APPEARANCE.theme).toBe('app')
    expect(resolveEditorTheme('app', 'light')).toBe('github-light')
    expect(resolveEditorTheme('app', 'dark')).toBe('vscode-dark')
    expect(resolveEditorTheme('dracula', 'light')).toBe('dracula')
  })

  it('recovers from malformed persisted settings', () => {
    window.localStorage.setItem(EDITOR_APPEARANCE_STORAGE_KEY, '{')
    expect(readEditorAppearance()).toEqual(DEFAULT_EDITOR_APPEARANCE)
  })

  it('keeps active-line backgrounds translucent so text selections remain visible', () => {
    for (const theme of EDITOR_THEMES) {
      expect(theme.palette.activeLine).toMatch(/^#[0-9a-f]{8}$/i)
      expect(theme.palette.activeLine.slice(-2).toLocaleLowerCase()).not.toBe('ff')
    }
  })
})
