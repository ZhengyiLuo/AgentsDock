// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { WorkspaceProfileScope } from '@shared/types'
import { getWorkspacePreference, setWorkspacePreference } from '../lib/workspace-preferences'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'

const MIN_PANE_PERCENT = 28
const MAX_PANE_PERCENT = 72
export const CHAT_SPLIT_STACK_WIDTH_PX = 840
export const CHAT_SPLIT_STACK_MIN_HEIGHT_PX = 600
export const CHAT_SPLIT_DIVIDER_PX = 9
export const CHAT_SPLIT_COMPACT_CONTROL_RAIL_PX = 155

export function shouldStackChatSplit(width: number, height: number): boolean {
  return width < CHAT_SPLIT_STACK_WIDTH_PX && height >= CHAT_SPLIT_STACK_MIN_HEIGHT_PX
}

export function chatSplitTrackPixels(width: number, height: number, ratio: number): {
  orientation: 'horizontal' | 'stacked'
  primary: number
  secondary: number
} {
  const stacked = shouldStackChatSplit(width, height)
  const total = stacked ? height : width
  const primary = total * clampRatio(ratio) / 100
  return {
    orientation: stacked ? 'stacked' : 'horizontal',
    primary,
    secondary: Math.max(0, total - primary - CHAT_SPLIT_DIVIDER_PX)
  }
}

export function ChatSplitView({
  preferenceScope,
  primary,
  secondary,
  inactive = false
}: {
  preferenceScope: WorkspaceProfileScope | null
  primary: ReactNode
  secondary: ReactNode
  inactive?: boolean
}) {
  useLocale()
  const root = useRef<HTMLDivElement | null>(null)
  const ratioRef = useRef(50)
  const [ratio, setRatio] = useState(50)
  const [stacked, setStacked] = useState(false)
  const [short, setShort] = useState(false)
  const [resizing, setResizing] = useState(false)
  const cancelResize = useRef<(() => void) | null>(null)
  const stackedRef = useRef(false)
  const shortRef = useRef(false)

  const finishLayoutChange = useCallback(() => {
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }, [])

  const applyLayoutChange = useCallback((change: () => void) => {
    notifyTimelineViewportLayout('begin')
    change()
    finishLayoutChange()
  }, [finishLayoutChange])

  useEffect(() => {
    let current = true
    if (ratioRef.current !== 50) {
      applyLayoutChange(() => {
        ratioRef.current = 50
        setRatio(50)
      })
    } else {
      setRatio(50)
    }
    void getWorkspacePreference(preferenceScope, 'chatSplitRatio:v1', 50).then(saved => {
      if (!current) return
      const next = clampRatio(saved)
      if (next !== ratioRef.current) {
        applyLayoutChange(() => {
          ratioRef.current = next
          setRatio(next)
        })
      }
    }).catch(() => undefined)
    return () => { current = false }
  }, [applyLayoutChange, preferenceScope?.profileGeneration, preferenceScope?.profileId, preferenceScope?.serverIdentity])

  useEffect(() => {
    const node = root.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observe = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth
      const height = entries[0]?.contentRect.height ?? node.clientHeight
      const nextStacked = shouldStackChatSplit(width, height)
      const nextShort = height < CHAT_SPLIT_STACK_MIN_HEIGHT_PX
      if (nextStacked === stackedRef.current && nextShort === shortRef.current) return
      stackedRef.current = nextStacked
      shortRef.current = nextShort
      applyLayoutChange(() => {
        setStacked(nextStacked)
        setShort(nextShort)
      })
    })
    observe.observe(node)
    return () => observe.disconnect()
  }, [applyLayoutChange])

  useEffect(() => () => {
    cancelResize.current?.()
    cancelResize.current = null
    document.body.classList.remove('chat-split-resizing')
  }, [])

  const commit = useCallback((value: number) => {
    const next = clampRatio(value)
    ratioRef.current = next
    setRatio(next)
    void setWorkspacePreference(preferenceScope, 'chatSplitRatio:v1', next).catch(() => undefined)
  }, [preferenceScope])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !root.current) return
    event.preventDefault()
    setResizing(true)
    notifyTimelineViewportLayout('begin')
    let frame: number | null = null
    let pendingPointer: PointerEvent | null = null
    let finished = false
    const paint = () => {
      frame = null
      const pointer = pendingPointer
      const rect = root.current?.getBoundingClientRect()
      if (!pointer || !rect) return
      const value = stacked
        ? ((pointer.clientY - rect.top) / rect.height) * 100
        : ((pointer.clientX - rect.left) / rect.width) * 100
      ratioRef.current = clampRatio(value)
      setRatio(ratioRef.current)
      notifyTimelineViewportLayout('update')
    }
    const update = (pointer: PointerEvent) => {
      pendingPointer = pointer
      if (frame === null) frame = window.requestAnimationFrame(paint)
    }
    const finish = () => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', update)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        paint()
      }
      document.body.classList.remove('chat-split-resizing')
      setResizing(false)
      commit(ratioRef.current)
      window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
      if (cancelResize.current === finish) cancelResize.current = null
    }
    cancelResize.current?.()
    cancelResize.current = finish
    document.body.classList.add('chat-split-resizing')
    window.addEventListener('pointermove', update)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    window.addEventListener('blur', finish, { once: true })
  }

  return <div
    ref={root}
    className={`chat-split-view${stacked ? ' stacked' : ''}${short ? ' short' : ''}${resizing ? ' resizing' : ''}`}
    style={{ '--chat-split-ratio': `${ratio}%` } as CSSProperties}
    aria-hidden={inactive || undefined}
    inert={inactive || undefined}
  >
    {primary}
    <div
      className="chat-split-divider"
      role="separator"
      aria-label={t("ui.ChatSplitView.ChatSplitView.resize_chat_panes_99ea577")}
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-valuemin={MIN_PANE_PERCENT}
      aria-valuemax={MAX_PANE_PERCENT}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onDoubleClick={() => applyLayoutChange(() => commit(50))}
      onPointerDown={beginResize}
      onKeyDown={event => {
        const decrement = stacked ? event.key === 'ArrowUp' : event.key === 'ArrowLeft'
        const increment = stacked ? event.key === 'ArrowDown' : event.key === 'ArrowRight'
        if (!decrement && !increment && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        applyLayoutChange(() => commit(
          event.key === 'Home'
            ? MIN_PANE_PERCENT
            : event.key === 'End'
              ? MAX_PANE_PERCENT
              : ratioRef.current + (increment ? 4 : -4)
        ))
      }}
    ><span /></div>
    {secondary}
  </div>
}

function clampRatio(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 50
  return Math.max(MIN_PANE_PERCENT, Math.min(MAX_PANE_PERCENT, numeric))
}
