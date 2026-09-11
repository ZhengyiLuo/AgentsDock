import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
import { formatTime } from '../lib/format'
import { visibleLoadedPositions, type LoadedTimelinePosition, type TimelineNavigatorLandmark } from '../lib/timeline-minimap'

export interface TimelineMinimapHandle {
  setVisibleRange(startIndex: number, endIndex: number, atBottom?: boolean): void
}

interface TimelineMinimapProps {
  landmarks: TimelineNavigatorLandmark[]
  onSeek(landmark: TimelineNavigatorLandmark): void
  onScroll(deltaY: number): void
}

interface HoveredLandmark {
  landmark: TimelineNavigatorLandmark
  top: number
  position: number
}

const TRACK_TOP = 10
const TRACK_BOTTOM = 10
const MIN_BACKGROUND_TICK_GAP = 6

/**
 * The minimap is a map, not a second scroll view. Every landmark owns one
 * stable proportional coordinate for as long as the landmark list and rail
 * size are unchanged. This is what keeps a pointer location mapped to the
 * same conversation turn while Virtuoso reports rapidly changing ranges.
 */
export const TimelineMinimap = memo(forwardRef<TimelineMinimapHandle, TimelineMinimapProps>(function TimelineMinimap({
  landmarks, onSeek, onScroll
}, forwardedRef) {
  useLocale()
  const rootRef = useRef<HTMLDivElement>(null)
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ width: 40, height: 400 })
  const viewportRef = useRef({ start: 0, end: 0 })
  const pinnedToBottomRef = useRef(false)
  const hoveredPositionRef = useRef<number | null>(null)
  const drawBackgroundRef = useRef<() => void>(() => {})
  const drawOverlayRef = useRef<() => void>(() => {})
  const draggingRef = useRef(false)
  const [hovered, setHovered] = useState<HoveredLandmark | null>(null)
  const loadedPositions = useMemo<LoadedTimelinePosition[]>(() => landmarks.flatMap((landmark, position) =>
    landmark.index == null || landmark.endIndex == null ? [] : [{ position, index: landmark.index, endIndex: landmark.endIndex }]
  ), [landmarks])

  const visiblePositions = useCallback((): [number, number] | null => {
    return visibleLoadedPositions(loadedPositions, viewportRef.current.start, viewportRef.current.end)
  }, [loadedPositions])

  const currentPosition = useCallback((): number => {
    if (pinnedToBottomRef.current && landmarks.length) return landmarks.length - 1
    const visible = visiblePositions()
    return visible ? Math.round((visible[0] + visible[1]) / 2) : -1
  }, [landmarks.length, visiblePositions])

  const updateAriaValue = useCallback(() => {
    rootRef.current?.setAttribute('aria-valuenow', String(Math.max(0, currentPosition())))
  }, [currentPosition])

  const drawBackground = useCallback(() => {
    const canvas = backgroundCanvasRef.current
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

    const palette = minimapPalette()
    // Preserve the full-chat coordinate system without turning long chats into
    // a solid comb of one-pixel ticks. Dense landmarks share evenly spaced
    // visual slots; errors win their slot as the higher-signal mark. Pointer
    // hit testing still addresses every landmark on the unabridged map.
    const trackHeight = Math.max(1, height - TRACK_TOP - TRACK_BOTTOM)
    const visualSlotCount = Math.max(1, Math.floor(trackHeight / MIN_BACKGROUND_TICK_GAP))
    const dense = landmarks.length > visualSlotCount + 1
    const rows = new Map<number, TimelineNavigatorLandmark['kind']>()
    for (let position = 0; position < landmarks.length; position += 1) {
      const row = dense
        ? Math.round(TRACK_TOP + Math.round(position / Math.max(1, landmarks.length - 1) * visualSlotCount) / visualSlotCount * trackHeight)
        : Math.round(yForPosition(position, landmarks.length, height))
      const kind = landmarks[position].kind
      if (!rows.has(row) || kind === 'error') rows.set(row, kind)
    }
    for (const [row, kind] of rows) {
      context.fillStyle = kind === 'error' ? palette.error : palette.tick
      context.fillRect(16, row, 7, 1)
    }
  }, [landmarks])
  drawBackgroundRef.current = drawBackground

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current
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

    const palette = minimapPalette()
    // A single horizontal current-position tick is enough. The old vertical
    // viewport bar looked like a second scrollbar and exaggerated range jumps
    // as virtualized rows were measured; it is deliberately not drawn.
    const active = currentPosition()
    if (active >= 0) {
      context.fillStyle = palette.current
      context.fillRect(10, Math.round(yForPosition(active, landmarks.length, height)), 19, 1)
    }
    const hoveredPosition = hoveredPositionRef.current
    if (hoveredPosition != null && hoveredPosition >= 0 && hoveredPosition < landmarks.length) {
      context.fillStyle = palette.hovered
      context.fillRect(7, Math.round(yForPosition(hoveredPosition, landmarks.length, height)), 27, 1)
    }
  }, [currentPosition, landmarks])
  drawOverlayRef.current = drawOverlay

  useImperativeHandle(forwardedRef, () => ({
    setVisibleRange(startIndex, endIndex, atBottom = false) {
      viewportRef.current = { start: startIndex, end: endIndex }
      pinnedToBottomRef.current = atBottom
      updateAriaValue()
      drawOverlayRef.current()
    }
  }), [updateAriaValue])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const resize = () => {
      const bounds = root.getBoundingClientRect()
      sizeRef.current = { width: bounds.width, height: bounds.height }
      drawBackgroundRef.current()
      drawOverlayRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    updateAriaValue()
    drawBackground()
    drawOverlay()
  }, [drawBackground, drawOverlay, landmarks, updateAriaValue])

  useEffect(() => {
    const redraw = () => {
      drawBackgroundRef.current()
      drawOverlayRef.current()
    }
    window.addEventListener('agentsdock:appearance', redraw)
    return () => window.removeEventListener('agentsdock:appearance', redraw)
  }, [])

  const landmarkFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>): HoveredLandmark | null => {
    if (!landmarks.length) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const localY = clamp(event.clientY - bounds.top, 0, bounds.height)
    const position = positionForY(localY, landmarks.length, bounds.height)
    return { landmark: landmarks[position], position, top: clamp(localY, 62, Math.max(62, bounds.height - 62)) }
  }, [landmarks])

  const updateHover = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const next = landmarkFromPointer(event)
    if (!next) return
    hoveredPositionRef.current = next.position
    setHovered(current => current?.position === next.position && current.top === next.top ? current : next)
    drawOverlayRef.current()
  }, [landmarkFromPointer])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!landmarks.length) return
    const visible = visiblePositions()
    const current = visible?.[0] ?? 0
    if (event.key === 'Home') { event.preventDefault(); onSeek(landmarks[0]); return }
    if (event.key === 'End') { event.preventDefault(); onSeek(landmarks.at(-1)!); return }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const position = clamp(current + (event.key === 'ArrowUp' ? -1 : 1), 0, landmarks.length - 1)
    onSeek(landmarks[position])
  }

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? sizeRef.current.height : 1
    onScroll(event.deltaY * scale)
  }

  const hoveredLandmark = hovered ? landmarks.find(landmark => landmark.key === hovered.landmark.key) ?? hovered.landmark : null
  return <div
    ref={rootRef}
    className="timeline-minimap"
    role="scrollbar"
    aria-label={t('timeline.ui.conversationNavigator')}
    aria-valuemin={0}
    aria-valuemax={Math.max(0, landmarks.length - 1)}
    aria-valuenow={Math.max(0, currentPosition())}
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
      drawOverlayRef.current()
    }}
  >
    <canvas ref={backgroundCanvasRef} aria-hidden="true" />
    <canvas ref={overlayCanvasRef} className="timeline-minimap-overlay" aria-hidden="true" />
    {hovered && hoveredLandmark && <div className={`timeline-minimap-popover ${hoveredLandmark.kind}`} style={{ top: hovered.top }}>
      <header><strong>{hoveredLandmark.title}</strong>{hoveredLandmark.timestamp && <time>{formatTime(hoveredLandmark.timestamp)}</time>}</header>
      <p>{hoveredLandmark.preview}</p>
      {hoveredLandmark.meta && <footer>{hoveredLandmark.meta}</footer>}
    </div>}
  </div>
}))

export function yForPosition(position: number, count: number, height: number): number {
  if (count <= 1) return height / 2
  const trackHeight = Math.max(1, height - TRACK_TOP - TRACK_BOTTOM)
  return TRACK_TOP + clamp(position, 0, count - 1) / (count - 1) * trackHeight
}

export function positionForY(y: number, count: number, height: number): number {
  if (count <= 1) return 0
  const trackHeight = Math.max(1, height - TRACK_TOP - TRACK_BOTTOM)
  const ratio = (clamp(y, TRACK_TOP, Math.max(TRACK_TOP, height - TRACK_BOTTOM)) - TRACK_TOP) / trackHeight
  return clamp(Math.round(ratio * (count - 1)), 0, count - 1)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function minimapPalette(): { hovered: string; current: string; error: string; tick: string } {
  if (document.documentElement.dataset.theme === 'light') {
    return { hovered: '#252522', current: '#62625d', error: '#c73531', tick: '#a3a39e' }
  }
  return { hovered: '#e8e8e5', current: '#b8b8b5', error: '#94514d', tick: '#595957' }
}
