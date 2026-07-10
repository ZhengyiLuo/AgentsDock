import {
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
  pointerId: number
  startY: number
  startHeight: number
  currentHeight: number
}

export function clampTerminalDockHeight(height: number, viewportHeight = window.innerHeight): number {
  const maximum = Math.max(MIN_TERMINAL_DOCK_HEIGHT, viewportHeight - MIN_CHAT_WORKSPACE_HEIGHT)
  return Math.round(Math.min(maximum, Math.max(MIN_TERMINAL_DOCK_HEIGHT, height)))
}

function savedTerminalDockHeight(): number {
  const saved = Number(window.localStorage.getItem(TERMINAL_DOCK_HEIGHT_KEY))
  return clampTerminalDockHeight(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_TERMINAL_DOCK_HEIGHT)
}

export function TerminalDock({
  session,
  open,
  onRequestClose
}: {
  session: Session
  open: boolean
  onRequestClose: () => void
}) {
  const [mounted, setMounted] = useState(open)
  const [revealed, setRevealed] = useState(false)
  const [height, setHeight] = useState(savedTerminalDockHeight)
  const [resizing, setResizing] = useState(false)
  const resizeDrag = useRef<ResizeDrag | null>(null)
  const hasAnimatedLayout = useRef(false)

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
    if (resizeDrag.current) notifyTimelineViewportLayout('end')
  }, [])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
      currentHeight: height
    }
    setResizing(true)
    document.body.classList.add('terminal-resizing')
    notifyTimelineViewportLayout('begin')
  }
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = clampTerminalDockHeight(drag.startHeight + drag.startY - event.clientY)
    drag.currentHeight = next
    setHeight(next)
  }
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    resizeDrag.current = null
    setResizing(false)
    document.body.classList.remove('terminal-resizing')
    window.localStorage.setItem(TERMINAL_DOCK_HEIGHT_KEY, String(drag.currentHeight))
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }
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
    window.localStorage.setItem(TERMINAL_DOCK_HEIGHT_KEY, String(next))
    window.requestAnimationFrame(() => {
      notifyTimelineViewportLayout('update')
      window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    })
  }
  const resetHeight = () => {
    const next = clampTerminalDockHeight(DEFAULT_TERMINAL_DOCK_HEIGHT)
    notifyTimelineViewportLayout('begin')
    setHeight(next)
    window.localStorage.setItem(TERMINAL_DOCK_HEIGHT_KEY, String(next))
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
        aria-label="Resize terminal panel"
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_DOCK_HEIGHT}
        aria-valuemax={clampTerminalDockHeight(Number.MAX_SAFE_INTEGER)}
        aria-valuenow={height}
        tabIndex={0}
        title="Drag to resize terminal · double-click to reset"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={resetHeight}
        onKeyDown={resizeWithKeyboard}
      />
      <TerminalWorkspace session={session} onClose={onRequestClose} />
    </>}
  </div>
}
