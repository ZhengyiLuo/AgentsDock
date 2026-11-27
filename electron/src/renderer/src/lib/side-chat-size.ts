import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'

const KEY = 'agentsdock:side-chat-size:v1'
type Size = { width: number; height: number }
const initialSize = (): Size | null => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return value && Number.isFinite(value.width) && Number.isFinite(value.height)
      ? value : null
  } catch { return null }
}
const clamp = (size: Size): Size => ({
  width: Math.min(Math.max(280, size.width), Math.max(0, window.innerWidth - 24)),
  height: Math.min(Math.max(220, size.height), Math.max(0, window.innerHeight - 24))
})
const persist = (size: Size) => {
  try { localStorage.setItem(KEY, JSON.stringify(size)) } catch { /* resizing still works without storage */ }
}

/** The popup is anchored at its bottom-right; drag its top-left corner outward. */
export function useSideChatSize(open: boolean) {
  const [size, setSize] = useState<Size | null>(() => {
    const stored = initialSize()
    return stored ? clamp(stored) : null
  })
  const drag = useRef<{ id: number; x: number; y: number; start: Size; current: Size } | null>(null)
  useEffect(() => {
    if (!open) { drag.current = null; return }
    const resize = () => setSize(value => value ? clamp(value) : value)
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); drag.current = null }
  }, [open])
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return
    persist(drag.current.current)
    drag.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {
    size,
    resizeHandle: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0) return
        event.preventDefault()
        const rect = event.currentTarget.closest('.side-chat-popover')!.getBoundingClientRect()
        const start = { width: rect.width, height: rect.height }
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start, current: start }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = drag.current
        if (!current || current.id !== event.pointerId) return
        current.current = clamp({ width: current.start.width + current.x - event.clientX, height: current.start.height + current.y - event.clientY })
        setSize(current.current)
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.closest('.side-chat-popover')!.getBoundingClientRect()
        const step = event.shiftKey ? 40 : 16
        const next = clamp({ width: rect.width + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
          height: rect.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) })
        setSize(next)
        persist(next)
      }
    }
  }
}
