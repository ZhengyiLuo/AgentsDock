import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
import { formatTime } from '../lib/format'
import { TIMELINE_TICK_PITCH, timelineTickY, type TimelineNavigatorLandmark } from '../lib/timeline-minimap'

export interface TimelineMinimapHandle {
  setVisibleRange(startIndex: number, endIndex: number): void
}

interface TimelineMinimapProps {
  landmarks: TimelineNavigatorLandmark[]
  onSeek(landmark: TimelineNavigatorLandmark): void
}

interface HoveredLandmark {
  landmark: TimelineNavigatorLandmark
  top: number
  position: number
}

const TRACK_TOP = 10
const TRACK_BOTTOM = 10

export const TimelineMinimap = memo(forwardRef<TimelineMinimapHandle, TimelineMinimapProps>(function TimelineMinimap({
  landmarks, onSeek
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ width: 40, height: 400 })
  const viewportRef = useRef({ start: 0, end: 0 })
  const scrollOffsetRef = useRef(0)
  const hoveredPositionRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => {})
  const draggingRef = useRef(false)
  const [hovered, setHovered] = useState<HoveredLandmark | null>(null)
  const loadedPositions = useMemo(() => landmarks.flatMap((landmark, position) =>
    landmark.index == null || landmark.endIndex == null ? [] : [{ position, index: landmark.index, endIndex: landmark.endIndex }]
  ), [landmarks])

  const maxScrollOffset = useCallback(() => {
    const contentHeight = TRACK_TOP + Math.max(0, landmarks.length - 1) * TIMELINE_TICK_PITCH + TRACK_BOTTOM
    return Math.max(0, contentHeight - sizeRef.current.height)
  }, [landmarks.length])

  const setScrollOffset = useCallback((value: number) => {
    scrollOffsetRef.current = clamp(value, 0, maxScrollOffset())
    drawRef.current()
  }, [maxScrollOffset])

  const visiblePositions = useCallback((): [number, number] | null => {
    const start = viewportRef.current.start
    const end = viewportRef.current.end
    let first = -1
    let last = -1
    for (const { position, index, endIndex } of loadedPositions) {
      if (endIndex < start || index > end) continue
      if (first < 0) first = position
      last = position
    }
    return first < 0 ? null : [first, last]
  }, [loadedPositions])

  const keepPositionsVisible = useCallback((first: number, last: number) => {
    const height = sizeRef.current.height
    const top = timelineTickY(first)
    const bottom = timelineTickY(last)
    const offset = scrollOffsetRef.current
    const inset = Math.min(54, Math.max(18, height / 5))
    if (top < offset + inset) setScrollOffset(top - inset)
    else if (bottom > offset + height - inset) setScrollOffset(bottom - height + inset)
    else drawRef.current()
  }, [setScrollOffset])

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

    const offset = scrollOffsetRef.current
    const firstDrawn = clamp(Math.floor((offset - TRACK_TOP) / TIMELINE_TICK_PITCH) - 1, 0, Math.max(0, landmarks.length - 1))
    const lastDrawn = clamp(Math.ceil((offset + height - TRACK_TOP) / TIMELINE_TICK_PITCH) + 1, 0, Math.max(0, landmarks.length - 1))
    const visible = visiblePositions()
    const currentPosition = visible ? Math.round((visible[0] + visible[1]) / 2) : -1
    const palette = minimapPalette()

    for (let position = firstDrawn; position <= lastDrawn; position += 1) {
      const landmark = landmarks[position]
      if (!landmark) continue
      const y = timelineTickY(position, offset)
      const isHovered = hoveredPositionRef.current === position
      const isCurrent = position === currentPosition
      context.fillStyle = isHovered ? palette.hovered : isCurrent ? palette.current : landmark.kind === 'error' ? palette.error : palette.tick
      context.fillRect(isHovered ? 7 : isCurrent ? 10 : 16, Math.round(y), isHovered ? 27 : isCurrent ? 19 : 7, 1)
    }

    if (offset > 0) {
      const gradient = context.createLinearGradient(0, 0, 0, 18)
      gradient.addColorStop(0, palette.background)
      gradient.addColorStop(1, palette.transparent)
      context.fillStyle = gradient
      context.fillRect(0, 0, width, 18)
    }
    if (offset < maxScrollOffset()) {
      const gradient = context.createLinearGradient(0, height - 18, 0, height)
      gradient.addColorStop(0, palette.transparent)
      gradient.addColorStop(1, palette.background)
      context.fillStyle = gradient
      context.fillRect(0, height - 18, width, 18)
    }
  }, [landmarks, maxScrollOffset, visiblePositions])
  drawRef.current = draw

  useImperativeHandle(forwardedRef, () => ({
    setVisibleRange(startIndex, endIndex) {
      viewportRef.current = { start: startIndex, end: endIndex }
      const positions = visiblePositions()
      if (positions) keepPositionsVisible(...positions)
      else drawRef.current()
    }
  }), [keepPositionsVisible, visiblePositions])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const resize = () => {
      const bounds = root.getBoundingClientRect()
      sizeRef.current = { width: bounds.width, height: bounds.height }
      scrollOffsetRef.current = clamp(scrollOffsetRef.current, 0, maxScrollOffset())
      const positions = visiblePositions()
      if (positions) keepPositionsVisible(...positions)
      else drawRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [keepPositionsVisible, maxScrollOffset, visiblePositions])

  useEffect(() => {
    scrollOffsetRef.current = clamp(scrollOffsetRef.current, 0, maxScrollOffset())
    const positions = visiblePositions()
    if (positions) keepPositionsVisible(...positions)
    else draw()
  }, [draw, keepPositionsVisible, landmarks, maxScrollOffset, visiblePositions])

  useEffect(() => {
    const redraw = () => drawRef.current()
    window.addEventListener('agentsdock:appearance', redraw)
    return () => window.removeEventListener('agentsdock:appearance', redraw)
  }, [])

  const landmarkFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>): HoveredLandmark | null => {
    if (!landmarks.length) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const localY = clamp(event.clientY - bounds.top, 0, bounds.height)
    const contentY = localY + scrollOffsetRef.current
    const position = clamp(Math.round((contentY - TRACK_TOP) / TIMELINE_TICK_PITCH), 0, landmarks.length - 1)
    return { landmark: landmarks[position], position, top: clamp(localY, 62, Math.max(62, bounds.height - 62)) }
  }, [landmarks])

  const updateHover = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const next = landmarkFromPointer(event)
    if (!next) return
    hoveredPositionRef.current = next.position
    setHovered(next)
    drawRef.current()
  }, [landmarkFromPointer])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!landmarks.length) return
    const visible = visiblePositions()
    const current = visible?.[0] ?? 0
    if (event.key === 'Home') { event.preventDefault(); setScrollOffset(0); onSeek(landmarks[0]); return }
    if (event.key === 'End') { event.preventDefault(); setScrollOffset(maxScrollOffset()); onSeek(landmarks.at(-1)!); return }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const position = clamp(current + (event.key === 'ArrowUp' ? -1 : 1), 0, landmarks.length - 1)
    keepPositionsVisible(position, position)
    onSeek(landmarks[position])
  }

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? sizeRef.current.height : 1
    setScrollOffset(scrollOffsetRef.current + event.deltaY * scale)
  }

  return <div
    ref={rootRef}
    className="timeline-minimap"
    role="scrollbar"
    aria-label="Conversation navigator"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, landmarks.length - 1)}
    aria-valuenow={visiblePositions()?.[0] ?? 0}
    tabIndex={0}
    onKeyDown={keyDown}
    onWheel={wheel}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      draggingRef.current = true
      updateHover(event)
      try { event.currentTarget.setPointerCapture(event.pointerId) }
      catch { /* keyboard and synthetic input do not need pointer capture */ }
    }}
    onPointerMove={event => updateHover(event)}
    onPointerUp={event => {
      const selected = landmarkFromPointer(event)
      draggingRef.current = false
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (selected) onSeek(selected.landmark)
    }}
    onPointerCancel={() => { draggingRef.current = false }}
    onPointerLeave={() => {
      if (draggingRef.current) return
      hoveredPositionRef.current = null
      setHovered(null)
      drawRef.current()
    }}
  >
    <canvas ref={canvasRef} aria-hidden="true" />
    {hovered && <div className={`timeline-minimap-popover ${hovered.landmark.kind}`} style={{ top: hovered.top }}>
      <header><strong>{hovered.landmark.title}</strong>{hovered.landmark.timestamp && <time>{formatTime(hovered.landmark.timestamp)}</time>}</header>
      <p>{hovered.landmark.preview}</p>
      {hovered.landmark.meta && <footer>{hovered.landmark.meta}</footer>}
    </div>}
  </div>
}))

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function minimapPalette(): { hovered: string; current: string; error: string; tick: string; background: string; transparent: string } {
  if (document.documentElement.dataset.theme === 'light') {
    return { hovered: '#252522', current: '#62625d', error: '#c73531', tick: '#a3a39e', background: '#fbfbfa', transparent: '#fbfbfa00' }
  }
  return { hovered: '#e8e8e5', current: '#b8b8b5', error: '#94514d', tick: '#595957', background: '#181818', transparent: '#18181800' }
}
