import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'

export function NativeFileDragSurface({ file, className, children }: {
  file: AgentFile
  className?: string
  children: ReactNode
}) {
  const [preparing, setPreparing] = useState(false)
  const [ready, setReady] = useState(false)
  const prepared = useRef(false)
  const preparation = useRef<Promise<void> | null>(null)

  useEffect(() => {
    prepared.current = false
    preparation.current = null
    setPreparing(false)
    setReady(false)
  }, [file.id])

  const prepare = (): Promise<void> => {
    if (prepared.current) return Promise.resolve()
    if (preparation.current) return preparation.current
    setPreparing(true)
    preparation.current = window.agentsDock.files.prepareDrag(file)
      .then(() => {
        prepared.current = true
        setReady(true)
      })
      .catch(error => {
        prepared.current = false
        setReady(false)
        throw error
      })
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
      data-native-file-drag
      data-native-drag-preparing={preparing || undefined}
      data-native-drag-ready={ready || undefined}
      title={preparing ? `Preparing ${file.filename} for drag...` : undefined}
      onPointerEnter={() => {
        void prepare().catch(() => undefined)
      }}
      onPointerDownCapture={event => {
        if (event.button !== 0 || ignoresNativeDrag(event.target)) return
        void prepare().catch(reportError)
      }}
      onDragStart={event => {
        event.preventDefault()
        if (ignoresNativeDrag(event.target)) return
        if (!prepared.current) {
          void prepare().catch(reportError)
          return
        }
        window.agentsDock.files.beginDrag(file)
      }}
    >
      {children}
    </article>
  )
}

function ignoresNativeDrag(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-native-drag-ignore]'))
}
