import { describe, expect, it } from 'vitest'
import { APP_SHORTCUTS, shortcutAccelerator, shortcutDisplay } from './shortcuts'

describe('app shortcut catalog', () => {
  it('keeps native accelerators and visible Mac labels together', () => {
    expect(shortcutAccelerator('newChat')).toBe('CmdOrCtrl+N')
    expect(shortcutDisplay('newChat', 'mac')).toBe('⌘N')
    expect(shortcutAccelerator('openWorkspaceFile')).toBe('CmdOrCtrl+O')
    expect(shortcutDisplay('openWorkspaceFile', 'mac')).toBe('⌘O')
    expect(APP_SHORTCUTS.findChat.label).toBe('Switch chat')
    expect(shortcutAccelerator('findChat')).toBe('CmdOrCtrl+P')
    expect(shortcutAccelerator('attachFiles')).toBe('CmdOrCtrl+Shift+O')
    expect(shortcutDisplay('attachFiles', 'mac')).toBe('⇧⌘O')
    expect(shortcutAccelerator('nextWorkspaceTab')).toBe('Control+Tab')
    expect(shortcutDisplay('previousWorkspaceTab', 'mac')).toBe('⌃⇧⇥')
    expect(shortcutDisplay('focusLeftChatPane', 'mac')).toBe('⌥⌘←')
    expect(shortcutDisplay('focusRightChatPane', 'other')).toBe('Ctrl+Alt+→')
    expect(shortcutAccelerator('nextServer')).toBe('CmdOrCtrl+Shift+]')
    expect(shortcutDisplay('previousServer', 'mac')).toBe('⇧⌘[')
  })

  it('has unique native accelerators', () => {
    const accelerators = Object.values(APP_SHORTCUTS).flatMap(shortcut => 'accelerator' in shortcut ? [shortcut.accelerator] : [])
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('rejects display-only shortcuts as native accelerators', () => {
    expect(() => shortcutAccelerator('toggleTerminal')).toThrow('not registered')
    expect(() => shortcutAccelerator('focusLeftChatPane')).toThrow('not registered')
  })
})
