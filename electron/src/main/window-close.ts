import type { BrowserWindow } from 'electron'

const CLOSE_FLUSH_TIMEOUT_MS = 15_000

interface PendingClose {
  requestId: string
  timeout: ReturnType<typeof setTimeout>
}

const pendingByWindow = new WeakMap<BrowserWindow, PendingClose>()
const allowedWindows = new WeakSet<BrowserWindow>()
let nextRequestId = 0

export interface WindowCloseFlushOptions {
  timeoutMs?: number
  onTimeout?: (requestId: string) => void
}

/**
 * Makes native window close and Cmd+Q wait for renderer-owned persistence.
 *
 * The renderer acknowledges the request through acknowledgeWindowCloseFlush.
 * A bounded fallback still lets an unresponsive/crashed renderer close.
 */
export function installWindowCloseFlush(
  window: BrowserWindow,
  options: WindowCloseFlushOptions = {}
): void {
  const timeoutMs = options.timeoutMs ?? CLOSE_FLUSH_TIMEOUT_MS

  window.on('close', event => {
    if (allowedWindows.delete(window)) {
      clearPending(window)
      return
    }
    if (window.webContents.isDestroyed()) {
      clearPending(window)
      return
    }

    event.preventDefault()
    if (pendingByWindow.has(window)) return

    const requestId = `close-${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`
    const timeout = setTimeout(() => {
      const pending = pendingByWindow.get(window)
      if (pending?.requestId !== requestId) return
      pendingByWindow.delete(window)
      options.onTimeout?.(requestId)
      closeAfterFlush(window)
    }, timeoutMs)
    pendingByWindow.set(window, { requestId, timeout })
    window.webContents.send('native:close-request', { requestId })
  })

  window.on('closed', () => clearPending(window))
}

export function acknowledgeWindowCloseFlush(window: BrowserWindow | null, requestId: unknown, saved = true): boolean {
  if (!window || window.isDestroyed() || typeof requestId !== 'string') return false
  const pending = pendingByWindow.get(window)
  if (!pending || pending.requestId !== requestId) return false
  clearPending(window)
  // A known failed save is not an unresponsive renderer: cancel the timeout
  // too, so it cannot close the window and discard the unsaved draft later.
  if (!saved) return false
  closeAfterFlush(window)
  return true
}

/**
 * Used by the existing renderer-initiated Close action, which has already
 * completed the same persistence flush before invoking native.closeWindow().
 */
export function closeWindowAfterRendererFlush(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) return false
  clearPending(window)
  closeAfterFlush(window)
  return true
}

function closeAfterFlush(window: BrowserWindow): void {
  allowedWindows.add(window)
  setTimeout(() => {
    if (window.isDestroyed()) return
    window.close()
  }, 0)
}

function clearPending(window: BrowserWindow): void {
  const pending = pendingByWindow.get(window)
  if (pending) clearTimeout(pending.timeout)
  pendingByWindow.delete(window)
}
