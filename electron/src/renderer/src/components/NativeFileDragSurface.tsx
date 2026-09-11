// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useRef, useState, type ReactNode } from 'react'
import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'

export function NativeFileDragSurface({ sessionId, file, className, children }: {
  sessionId: string
  file: AgentFile
  className?: string
  children: ReactNode
}) {
  useLocale()
  const [preparing, setPreparing] = useState(false)
  const dragRequest = useRef<Promise<boolean> | null>(null)

  const beginNativeDrag = (): Promise<boolean> => {
    if (dragRequest.current) return dragRequest.current
    setPreparing(true)
    dragRequest.current = window.agentsDock.files.beginDrag(sessionId, file)
      .finally(() => {
        dragRequest.current = null
        setPreparing(false)
      })
    return dragRequest.current
  }

  const reportError = (error: unknown): void => {
    useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
  }

  return (
    <article
      className={className}
      draggable
      aria-busy={preparing}
      data-native-file-drag
      data-native-drag-preparing={preparing || undefined}
      title={preparing ? t("ui.NativeFileDragSurface.NativeFileDragSurface.preparing_for_drag_5e2642b", { "file": String(file.filename) }) : undefined}
      onDragStart={event => {
        event.preventDefault()
        if (ignoresNativeDrag(event.target)) return
        void beginNativeDrag().catch(reportError)
      }}
    >
      {children}
    </article>
  )
}

function ignoresNativeDrag(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-native-drag-ignore]'))
}
