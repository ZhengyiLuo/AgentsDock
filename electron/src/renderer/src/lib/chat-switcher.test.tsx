import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_CHAT_HOLD_MS, commandChatShortcutIndex, useCommandChatSwitcher } from './chat-switcher'

describe('Command chat switcher', () => {
  afterEach(() => vi.useRealTimers())

  it('reveals chat shortcuts only after Command is held', () => {
    vi.useFakeTimers()
    const select = vi.fn()
    const { result } = renderHook(() => useCommandChatSwitcher(['chat-a', 'chat-b'], select))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })))
    act(() => vi.advanceTimersByTime(COMMAND_CHAT_HOLD_MS - 1))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })))
    expect(result.current).toBe(false)
  })

  it('switches with Command-number and dismisses the hints', () => {
    vi.useFakeTimers()
    const select = vi.fn()
    const { result } = renderHook(() => useCommandChatSwitcher(['chat-a', 'chat-b'], select))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })))
    act(() => vi.advanceTimersByTime(COMMAND_CHAT_HOLD_MS))
    const event = new KeyboardEvent('keydown', { key: '2', metaKey: true, cancelable: true })
    act(() => window.dispatchEvent(event))

    expect(select).toHaveBeenCalledWith('chat-b')
    expect(event.defaultPrevented).toBe(true)
    expect(result.current).toBe(false)
  })

  it('maps only the visible numeric shortcut range', () => {
    expect(commandChatShortcutIndex('1')).toBe(0)
    expect(commandChatShortcutIndex('9')).toBe(8)
    expect(commandChatShortcutIndex('0')).toBeNull()
    expect(commandChatShortcutIndex('p')).toBeNull()
  })
})
