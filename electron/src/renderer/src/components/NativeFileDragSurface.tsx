import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'

export function NativeFileDragSurface({ file, className, children }: {
  file: AgentFile
  className?: string
  children: ReactNode
}) {
  const [preparing, setPreparing] = useState(false)
  const prepared = useRef(false)
  const preparation = useRef<Promise<void> | null>(null)
  const holdTimer = useRef<number | null>(null)

  const clearHoldTimer = (): void => {
    if (holdTimer.current == null) return
    window.clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  useEffect(() => {
    clearHoldTimer()
    prepared.current = false
    preparation.current = null
    setPreparing(false)
    return clearHoldTimer
  }, [file.id])

  const prepare = (): Promise<void> => {
    if (prepared.current) return Promise.resolve()
    if (preparation.current) return preparation.current
    setPreparing(true)
    preparation.current = window.agentsDock.files.prepareDrag(file)
      .then(() => { prepared.current = true })
      .finally(() => {
        preparation.current = null
        setPreparing(false)
      })
    return preparation.current
  }

  const reportError = (error: unknown): void => {
    useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
  }

  return (
    <article
      className={className}
      draggable
      aria-busy={preparing}
      data-native-drag-preparing={preparing || undefined}
      onPointerDownCapture={event => {
        if (event.button !== 0 || ignoresNativeDrag(event.target)) return
        clearHoldTimer()
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null
          void prepare().catch(reportError)
        }, 150)
      }}
      onPointerUpCapture={clearHoldTimer}
      onPointerCancel={clearHoldTimer}
      onDragStart={event => {
        clearHoldTimer()
        event.preventDefault()
        if (ignoresNativeDrag(event.target)) return
        void prepare()
          .then(() => window.agentsDock.files.beginDrag(file))
          .catch(reportError)
      }}
    >
      {children}
    </article>
  )
}

function ignoresNativeDrag(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-native-drag-ignore]'))
}
