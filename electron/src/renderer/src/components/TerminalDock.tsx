// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import {
  memo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from 'react'
import type { Session } from '@shared/types'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'
import { TerminalWorkspace } from './TerminalWorkspace'

export const TERMINAL_DOCK_ANIMATION_MS = 220
export const DEFAULT_TERMINAL_DOCK_HEIGHT = 240
export const MIN_TERMINAL_DOCK_HEIGHT = 160
const TERMINAL_DOCK_HEIGHT_KEY = 'agentsdock:terminal-dock-height'
const MIN_CHAT_WORKSPACE_HEIGHT = 280

interface ResizeDrag {
  workspaceKey: string
  pointerId: number
  startY: number
  startHeight: number
  currentHeight: number
}

export function clampTerminalDockHeight(height: number, viewportHeight = window.innerHeight): number {
  const maximum = Math.max(MIN_TERMINAL_DOCK_HEIGHT, viewportHeight - MIN_CHAT_WORKSPACE_HEIGHT)
  return Math.round(Math.min(maximum, Math.max(MIN_TERMINAL_DOCK_HEIGHT, height)))
}

export function terminalDockStorageKey(workspaceKey: string): string {
  return `${TERMINAL_DOCK_HEIGHT_KEY}:${encodeURIComponent(workspaceKey)}`
}

function savedTerminalDockHeight(workspaceKey: string): number {
  const scopedValue = window.localStorage.getItem(terminalDockStorageKey(workspaceKey))
  const saved = Number(scopedValue ?? window.localStorage.getItem(TERMINAL_DOCK_HEIGHT_KEY))
  return clampTerminalDockHeight(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_TERMINAL_DOCK_HEIGHT)
}

function persistTerminalDockHeight(workspaceKey: string, height: number): void {
  window.localStorage.setItem(terminalDockStorageKey(workspaceKey), String(height))
}

export const TerminalDock = memo(function TerminalDock({
  workspaceKey,
  session,
  open,
  onRequestClose
}: {
  workspaceKey: string
  session: Session
  open: boolean
  onRequestClose: () => void
}) {
  useLocale()
  const [mounted, setMounted] = useState(open)
  const [revealed, setRevealed] = useState(false)
  const [height, setHeight] = useState(() => savedTerminalDockHeight(workspaceKey))
  const [resizing, setResizing] = useState(false)
  const resizeDrag = useRef<ResizeDrag | null>(null)
  const hasAnimatedLayout = useRef(false)

  useEffect(() => {
    const activeDrag = resizeDrag.current
    if (activeDrag) {
      persistTerminalDockHeight(activeDrag.workspaceKey, activeDrag.currentHeight)
      resizeDrag.current = null
      setResizing(false)
      document.body.classList.remove('terminal-resizing')
      notifyTimelineViewportLayout('end')
    }
    setHeight(savedTerminalDockHeight(workspaceKey))
  }, [workspaceKey])

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    setRevealed(false)
    const timer = window.setTimeout(() => setMounted(false), TERMINAL_DOCK_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!mounted || !open) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setRevealed(true))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [mounted, open])

  useEffect(() => {
    const clampToViewport = () => setHeight(current => clampTerminalDockHeight(current))
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [])

  useEffect(() => {
    if (!hasAnimatedLayout.current) {
      hasAnimatedLayout.current = true
      if (!open) return
    }
    notifyTimelineViewportLayout('begin')
    let frame = 0
    const startedAt = performance.now()
    const followLayout = (now: number) => {
      notifyTimelineViewportLayout('update')
      if (now - startedAt < TERMINAL_DOCK_ANIMATION_MS + 24) frame = window.requestAnimationFrame(followLayout)
      else notifyTimelineViewportLayout('end')
    }
    frame = window.requestAnimationFrame(followLayout)
    return () => {
      window.cancelAnimationFrame(frame)
      notifyTimelineViewportLayout('end')
    }
  }, [open])

  useEffect(() => {
    if (!resizing) return
    const frame = window.requestAnimationFrame(() => notifyTimelineViewportLayout('update'))
    return () => window.cancelAnimationFrame(frame)
  }, [height, resizing])

  useEffect(() => () => {
    document.body.classList.remove('terminal-resizing')
    if (resizeDrag.current) {
      persistTerminalDockHeight(resizeDrag.current.workspaceKey, resizeDrag.current.currentHeight)
      notifyTimelineViewportLayout('end')
    }
  }, [])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* window tracking remains active */ }
    resizeDrag.current = {
      workspaceKey,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
      currentHeight: height
    }
    setResizing(true)
    document.body.classList.add('terminal-resizing')
    notifyTimelineViewportLayout('begin')
  }
  const updateResize = (pointerId: number, clientY: number) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== pointerId) return
    const next = clampTerminalDockHeight(drag.startHeight + drag.startY - clientY)
    drag.currentHeight = next
    setHeight(next)
  }
  const completeResize = (pointerId: number, captureTarget?: Element | null) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== pointerId) return
    try {
      if (captureTarget?.hasPointerCapture(pointerId)) captureTarget.releasePointerCapture(pointerId)
    } catch { /* pointer capture is best effort */ }
    resizeDrag.current = null
    setResizing(false)
    document.body.classList.remove('terminal-resizing')
    persistTerminalDockHeight(drag.workspaceKey, drag.currentHeight)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => updateResize(event.pointerId, event.clientY)
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => completeResize(event.pointerId, event.currentTarget)

  useEffect(() => {
    if (!resizing) return
    const move = (event: PointerEvent) => {
      if (resizeDrag.current?.pointerId !== event.pointerId) return
      event.preventDefault()
      updateResize(event.pointerId, event.clientY)
    }
    const finish = (event: PointerEvent) => completeResize(event.pointerId)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
    }
  }, [resizing])
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.shiftKey ? 50 : 20
    let next: number | null = null
    if (event.key === 'ArrowUp') next = clampTerminalDockHeight(height + delta)
    if (event.key === 'ArrowDown') next = clampTerminalDockHeight(height - delta)
    if (event.key === 'Home') next = clampTerminalDockHeight(DEFAULT_TERMINAL_DOCK_HEIGHT)
    if (next == null) return
    event.preventDefault()
    notifyTimelineViewportLayout('begin')
    setHeight(next)
    persistTerminalDockHeight(workspaceKey, next)
    window.requestAnimationFrame(() => {
      notifyTimelineViewportLayout('update')
      window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    })
  }
  const resetHeight = () => {
    const next = clampTerminalDockHeight(DEFAULT_TERMINAL_DOCK_HEIGHT)
    notifyTimelineViewportLayout('begin')
    setHeight(next)
    persistTerminalDockHeight(workspaceKey, next)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }

  return <div
    className={`terminal-dock-shell${revealed ? ' open' : ''}${resizing ? ' resizing' : ''}`}
    aria-hidden={!open}
    style={{ '--terminal-dock-height': `${height}px` } as CSSProperties}
  >
    {mounted && <>
      <div
        className="terminal-dock-resize-handle"
        role="separator"
        aria-label={t("ui.TerminalDock.TerminalDock.resize_terminal_panel_d557f03")}
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_DOCK_HEIGHT}
        aria-valuemax={clampTerminalDockHeight(Number.MAX_SAFE_INTEGER)}
        aria-valuenow={height}
        tabIndex={0}
        title={t("ui.TerminalDock.TerminalDock.drag_to_resize_terminal_double_click_to_re_74b0c7c")}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={resetHeight}
        onKeyDown={resizeWithKeyboard}
      />
      <TerminalWorkspace session={session} layoutHeight={height} onClose={onRequestClose} />
    </>}
  </div>
})
