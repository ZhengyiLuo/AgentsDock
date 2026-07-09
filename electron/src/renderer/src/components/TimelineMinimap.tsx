import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
import type { RenderTimelineItem } from '../lib/timeline'
import { buildTimelineLandmarks, type TimelineLandmark } from '../lib/timeline-minimap'
import { formatTime } from '../lib/format'

export interface TimelineMinimapHandle {
  setVisibleRange(startIndex: number, endIndex: number): void
}

interface TimelineMinimapProps {
  items: RenderTimelineItem[]
  hasMoreEvents: boolean
  olderRemaining: number
  onSeek(index: number): void
  onWheel(deltaY: number): void
}

interface HoveredLandmark {
  landmark: TimelineLandmark
  top: number
}

const TRACK_TOP = 10
const TRACK_BOTTOM = 10

export const TimelineMinimap = memo(forwardRef<TimelineMinimapHandle, TimelineMinimapProps>(function TimelineMinimap({
  items, hasMoreEvents, olderRemaining, onSeek, onWheel
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ width: 32, height: 400 })
  const viewportRef = useRef({ start: Math.max(0, items.length - 6), end: Math.max(0, items.length - 1) })
  const hoveredIndexRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => {})
  const draggingRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const seekFrameRef = useRef<number | null>(null)
  const hoveredKeyRef = useRef<string | null>(null)
  const [hovered, setHovered] = useState<HoveredLandmark | null>(null)
  const landmarks = useMemo(() => buildTimelineLandmarks(items), [items])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height } = sizeRef.current
    const ratio = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.round(width * ratio))
    const pixelHeight = Math.max(1, Math.round(height * ratio))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    if (hasMoreEvents) {
      context.fillStyle = '#5b5b58'
      context.fillRect(16, 2, 7, 1)
      context.fillRect(16, 5, 7, 1)
    }

    const start = clamp(viewportRef.current.start, 0, Math.max(0, items.length - 1))
    const end = clamp(viewportRef.current.end, start, Math.max(start, items.length - 1))
    for (const [position, landmark] of landmarks.entries()) {
      const y = yForIndex(position, landmarks.length, height)
      const visible = landmark.endIndex >= start && landmark.index <= end
      const hovered = hoveredIndexRef.current === position
      const emphasized = visible || hovered
      context.fillStyle = emphasized ? '#e8e8e5' : landmark.kind === 'error' ? '#9b514d' : '#5b5b58'
      context.fillRect(emphasized ? 7 : 16, Math.round(y), emphasized ? hovered ? 25 : 18 : 7, 1)
    }
  }, [hasMoreEvents, landmarks])
  drawRef.current = draw

  useImperativeHandle(forwardedRef, () => ({
    setVisibleRange(startIndex, endIndex) {
      viewportRef.current = { start: startIndex, end: endIndex }
      drawRef.current()
    }
  }), [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const resize = () => {
      const bounds = root.getBoundingClientRect()
      sizeRef.current = { width: bounds.width, height: bounds.height }
      drawRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    viewportRef.current = {
      start: clamp(viewportRef.current.start, 0, Math.max(0, items.length - 1)),
      end: clamp(viewportRef.current.end, 0, Math.max(0, items.length - 1))
    }
    draw()
  }, [draw, items.length])

  useEffect(() => () => {
    if (seekFrameRef.current != null) window.cancelAnimationFrame(seekFrameRef.current)
  }, [])

  const scheduleSeek = useCallback((index: number) => {
    pendingSeekRef.current = index
    if (seekFrameRef.current != null) return
    seekFrameRef.current = window.requestAnimationFrame(() => {
      seekFrameRef.current = null
      if (pendingSeekRef.current != null) onSeek(pendingSeekRef.current)
      pendingSeekRef.current = null
    })
  }, [onSeek])

  const updateFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>, seek: boolean) => {
    if (!landmarks.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const y = clamp(event.clientY - bounds.top, TRACK_TOP, Math.max(TRACK_TOP, bounds.height - TRACK_BOTTOM))
    const index = indexForY(y, landmarks.length, bounds.height)
    const landmark = landmarks[index]
    if (landmark && hoveredKeyRef.current !== landmark.key) {
      hoveredKeyRef.current = landmark.key
      hoveredIndexRef.current = index
      setHovered({ landmark, top: clamp(y, 62, Math.max(62, bounds.height - 62)) })
      drawRef.current()
    } else if (landmark) {
      setHovered(previous => previous ? { ...previous, top: clamp(y, 62, Math.max(62, bounds.height - 62)) } : { landmark, top: y })
    }
    if (seek) scheduleSeek(landmark.index)
  }, [landmarks, scheduleSeek])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!landmarks.length) return
    const current = Math.max(0, landmarks.findIndex(landmark => landmark.endIndex >= viewportRef.current.start))
    if (event.key === 'Home') { event.preventDefault(); onSeek(landmarks[0].index); return }
    if (event.key === 'End') { event.preventDefault(); onSeek(landmarks.at(-1)?.index ?? 0); return }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const direction = event.key === 'ArrowUp' ? -1 : 1
    const index = clamp(current + direction, 0, landmarks.length - 1)
    onSeek(landmarks[index].index)
  }

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    onWheel(event.deltaY)
  }

  return <div
    ref={rootRef}
    className="timeline-minimap"
    role="scrollbar"
    aria-label="Conversation navigator"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, items.length - 1)}
    aria-valuenow={viewportRef.current.start}
    tabIndex={0}
    onKeyDown={keyDown}
    onWheel={wheel}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      draggingRef.current = true
      updateFromPointer(event, true)
      try { event.currentTarget.setPointerCapture(event.pointerId) }
      catch { /* synthetic accessibility input can seek without pointer capture */ }
    }}
    onPointerMove={event => updateFromPointer(event, draggingRef.current)}
    onPointerUp={event => {
      draggingRef.current = false
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => { draggingRef.current = false }}
    onPointerLeave={() => {
      if (draggingRef.current) return
      hoveredKeyRef.current = null
      hoveredIndexRef.current = null
      setHovered(null)
      drawRef.current()
    }}
  >
    <canvas ref={canvasRef} aria-hidden="true" />
    {hasMoreEvents && <span className="timeline-minimap-older" title={`${olderRemaining.toLocaleString()} older events are not loaded`}>•••</span>}
    {hovered && <div className={`timeline-minimap-popover ${hovered.landmark.kind}`} style={{ top: hovered.top }}>
      <header><strong>{hovered.landmark.title}</strong>{hovered.landmark.timestamp && <time>{formatTime(hovered.landmark.timestamp)}</time>}</header>
      <p>{hovered.landmark.preview}</p>
      {hovered.landmark.meta && <footer>{hovered.landmark.meta}</footer>}
    </div>}
  </div>
}))

function yForIndex(index: number, count: number, height: number): number {
  if (count <= 1) return height / 2
  return TRACK_TOP + index / (count - 1) * Math.max(1, height - TRACK_TOP - TRACK_BOTTOM)
}

function indexForY(y: number, count: number, height: number): number {
  if (count <= 1) return 0
  const ratio = (y - TRACK_TOP) / Math.max(1, height - TRACK_TOP - TRACK_BOTTOM)
  return clamp(Math.round(ratio * (count - 1)), 0, count - 1)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
