import { describe, expect, it } from 'vitest'
import {
  isTerminalToggleShortcut,
  workspaceTabNavigationShortcut,
  workspaceTabNavigationTarget
} from './workspace-shortcuts'

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

  it('maps Command-number to Chat followed by the open file tabs', () => {
    expect(workspaceTabNavigationShortcut(shortcut({ key: '1', code: 'Digit1', ctrlKey: false, metaKey: true }))).toEqual({ kind: 'select', index: 0 })
    expect(workspaceTabNavigationShortcut(shortcut({ key: '9', code: 'Digit9', ctrlKey: false, metaKey: true }))).toEqual({ kind: 'select', index: 8 })
    expect(workspaceTabNavigationShortcut(shortcut({ key: '0', code: 'Digit0', ctrlKey: false, metaKey: true }))).toBeNull()
  })

  it('maps Control-Tab and Option-Command-arrows to wrapped workspace tab cycling', () => {
    expect(workspaceTabNavigationShortcut(shortcut({ key: 'Tab', code: 'Tab' }))).toEqual({ kind: 'cycle', direction: 1 })
    expect(workspaceTabNavigationShortcut(shortcut({ key: 'Tab', code: 'Tab', shiftKey: true }))).toEqual({ kind: 'cycle', direction: -1 })
    expect(workspaceTabNavigationShortcut(shortcut({
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      ctrlKey: false,
      metaKey: true,
      altKey: true
    }))).toEqual({ kind: 'cycle', direction: -1 })
    expect(workspaceTabNavigationShortcut(shortcut({
      key: 'ArrowRight',
      code: 'ArrowRight',
      ctrlKey: false,
      metaKey: true,
      altKey: true
    }))).toEqual({ kind: 'cycle', direction: 1 })
    expect(workspaceTabNavigationShortcut(shortcut({
      key: 'ArrowRight',
      code: 'ArrowRight',
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      shiftKey: true
    }))).toBeNull()
    expect(workspaceTabNavigationShortcut(shortcut({
      key: 'ArrowRight',
      code: 'ArrowRight',
      ctrlKey: true,
      metaKey: true,
      altKey: true
    }))).toBeNull()
    expect(workspaceTabNavigationShortcut(shortcut({ key: 'Tab', code: 'Tab', repeat: true }))).toBeNull()
    expect(workspaceTabNavigationShortcut(shortcut({
      key: 'ArrowRight',
      code: 'ArrowRight',
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      repeat: true
    }))).toBeNull()
  })

  it('selects and wraps across Chat and every open file', () => {
    const files = ['README.md', 'src/App.tsx']
    expect(workspaceTabNavigationTarget('README.md', files, { kind: 'select', index: 0 })).toBeNull()
    expect(workspaceTabNavigationTarget(null, files, { kind: 'select', index: 1 })).toBe('README.md')
    expect(workspaceTabNavigationTarget(null, files, { kind: 'select', index: 3 })).toBeUndefined()
    expect(workspaceTabNavigationTarget(null, files, { kind: 'cycle', direction: -1 })).toBe('src/App.tsx')
    expect(workspaceTabNavigationTarget('src/App.tsx', files, { kind: 'cycle', direction: 1 })).toBeNull()
  })
})
