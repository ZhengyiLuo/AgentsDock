import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  acknowledgeWindowCloseFlush,
  closeWindowAfterRendererFlush,
  installWindowCloseFlush
} from './window-close'

interface CloseEvent {
  preventDefault(): void
}

function fakeWindow() {
  let closeListener: ((event: CloseEvent) => void) | null = null
  let closedListener: (() => void) | null = null
  const window = {
    on: vi.fn((name: string, listener: ((event: CloseEvent) => void) | (() => void)) => {
      if (name === 'close') closeListener = listener as (event: CloseEvent) => void
      if (name === 'closed') closedListener = listener as () => void
      return window
    }),
    close: vi.fn(() => closeListener?.({ preventDefault: vi.fn() })),
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
  }
  return {
    window: window as unknown as BrowserWindow,
    close: () => {
      const event = { preventDefault: vi.fn() }
      closeListener?.(event)
      return event
    },
    closed: () => closedListener?.(),
    send: window.webContents.send,
    nativeClose: window.close
  }
}

describe('native window close persistence handshake', () => {
  beforeEach(() => vi.useFakeTimers())

  it('prevents native close until the matching renderer flush is acknowledged', () => {
    const target = fakeWindow()
    installWindowCloseFlush(target.window)

    const event = target.close()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(target.send).toHaveBeenCalledWith('native:close-request', {
      requestId: expect.stringMatching(/^close-/)
    })
    expect(target.nativeClose).not.toHaveBeenCalled()

    const requestId = target.send.mock.calls[0][1].requestId as string
    expect(acknowledgeWindowCloseFlush(target.window, 'stale-request')).toBe(false)
    expect(acknowledgeWindowCloseFlush(target.window, requestId)).toBe(true)
    vi.runOnlyPendingTimers()

    expect(target.nativeClose).toHaveBeenCalledOnce()
    expect(target.send).toHaveBeenCalledOnce()
  })

  it('coalesces repeated native close requests and has a bounded crash fallback', () => {
    const target = fakeWindow()
    const onTimeout = vi.fn()
    installWindowCloseFlush(target.window, { timeoutMs: 250, onTimeout })

    target.close()
    target.close()
    expect(target.send).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(250)
    vi.runOnlyPendingTimers()
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(target.nativeClose).toHaveBeenCalledOnce()
  })

  it('lets the renderer-initiated close path reuse its completed flush', () => {
    const target = fakeWindow()
    installWindowCloseFlush(target.window)

    expect(closeWindowAfterRendererFlush(target.window)).toBe(true)
    vi.runOnlyPendingTimers()

    expect(target.nativeClose).toHaveBeenCalledOnce()
    expect(target.send).not.toHaveBeenCalled()
  })
})
