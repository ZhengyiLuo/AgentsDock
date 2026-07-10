import { useLayoutEffect, useRef } from 'react'

type CloseEntry = { token: symbol; close: () => void }

const closeStack: CloseEntry[] = []

export function registerTransientClose(close: () => void): () => void {
  const entry = { token: Symbol('transient-close'), close }
  closeStack.push(entry)
  return () => {
    const index = closeStack.findIndex(candidate => candidate.token === entry.token)
    if (index >= 0) closeStack.splice(index, 1)
  }
}

export function closeTopTransient(): boolean {
  const entry = closeStack.at(-1)
  if (!entry) return false
  entry.close()
  return true
}

export function useTransientClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useLayoutEffect(() => {
    if (!open) return
    return registerTransientClose(() => closeRef.current())
  }, [open])
}

export function resetTransientCloseStackForTests(): void { closeStack.length = 0 }
