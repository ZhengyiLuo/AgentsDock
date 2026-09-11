import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatSwitcherShortcutPlatform,
  installChatSwitcherShortcut,
  isChatSwitcherShortcut
} from './chat-switcher-shortcut'

function keyDown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: init.key?.toLocaleLowerCase() === 'p' ? 'KeyP' : init.code,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

describe('global chat switcher shortcut', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('claims Cmd+P in capture phase before a focused file editor can consume it', () => {
    const open = vi.fn()
    const editorHandler = vi.fn()
    const remove = installChatSwitcherShortcut(window, open, 'mac')
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.setAttribute('role', 'textbox')
    editor.addEventListener('keydown', editorHandler)
    document.body.appendChild(editor)

    const event = keyDown(editor, { key: 'p', metaKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(editorHandler).not.toHaveBeenCalled()
    remove()
  })

  it('claims Cmd+P from an ordinary input and leaves the switcher open on a fresh second press', () => {
    let open = false
    const openChatSwitcher = vi.fn(() => { open = true })
    const remove = installChatSwitcherShortcut(window, openChatSwitcher, 'mac')
    const input = document.createElement('input')
    document.body.appendChild(input)

    keyDown(input, { key: 'P', metaKey: true })
    keyDown(input, { key: 'p', metaKey: true })

    expect(open).toBe(true)
    expect(openChatSwitcher).toHaveBeenCalledTimes(2)
    remove()
  })

  it('ignores auto-repeat and composition without closing, toggling, or swallowing input', () => {
    const open = vi.fn()
    const inputHandler = vi.fn()
    const remove = installChatSwitcherShortcut(window, open, 'mac')
    const input = document.createElement('input')
    input.addEventListener('keydown', inputHandler)
    document.body.appendChild(input)

    const repeat = keyDown(input, { key: 'p', metaKey: true, repeat: true })
    const composing = keyDown(input, { key: 'p', metaKey: true, isComposing: true })

    expect(open).not.toHaveBeenCalled()
    expect(repeat.defaultPrevented).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    expect(inputHandler).toHaveBeenCalledTimes(2)
    remove()
  })

  it('requires exact modifiers and does not affect file open or modified shortcuts', () => {
    const open = vi.fn()
    const inputHandler = vi.fn()
    const remove = installChatSwitcherShortcut(window, open, 'mac')
    const input = document.createElement('input')
    input.addEventListener('keydown', inputHandler)
    document.body.appendChild(input)

    const fileOpen = keyDown(input, { key: 'o', metaKey: true })
    const shifted = keyDown(input, { key: 'p', metaKey: true, shiftKey: true })
    const control = keyDown(input, { key: 'p', ctrlKey: true })
    const mixed = keyDown(input, { key: 'p', metaKey: true, ctrlKey: true })

    expect(open).not.toHaveBeenCalled()
    expect([fileOpen, shifted, control, mixed].every(event => !event.defaultPrevented)).toBe(true)
    expect(inputHandler).toHaveBeenCalledTimes(4)
    remove()
  })

  it('uses Ctrl+P on non-Mac platforms', () => {
    expect(isChatSwitcherShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }), 'other')).toBe(true)
    expect(isChatSwitcherShortcut(new KeyboardEvent('keydown', { key: 'p', metaKey: true }), 'other')).toBe(false)
    expect(chatSwitcherShortcutPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('mac')
    expect(chatSwitcherShortcutPlatform({ platform: 'Linux x86_64', userAgent: '' })).toBe('other')
  })
})
