import { describe, expect, it } from 'vitest'
import { isTerminalToggleShortcut } from './workspace-shortcuts'

const shortcut = (patch: Partial<KeyboardEvent> = {}) => ({
  key: '`', code: 'Backquote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...patch
}) as KeyboardEvent

describe('workspace shortcuts', () => {
  it('uses the VS Code Control-backtick terminal toggle', () => {
    expect(isTerminalToggleShortcut(shortcut())).toBe(true)
    expect(isTerminalToggleShortcut(shortcut({ key: 'Dead' }))).toBe(true)
  })

  it('does not retain the old Command-Shift-T shortcut or steal modified backticks', () => {
    expect(isTerminalToggleShortcut(shortcut({ ctrlKey: false, metaKey: true, shiftKey: true, key: 't', code: 'KeyT' }))).toBe(false)
    expect(isTerminalToggleShortcut(shortcut({ altKey: true }))).toBe(false)
    expect(isTerminalToggleShortcut(shortcut({ shiftKey: true }))).toBe(false)
    expect(isTerminalToggleShortcut(shortcut({ repeat: true }))).toBe(false)
  })
})
