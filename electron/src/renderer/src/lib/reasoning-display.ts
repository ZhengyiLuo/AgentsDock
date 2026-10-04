import { useSyncExternalStore } from 'react'

export type ReasoningDisplay = 'compact' | 'expanded'
const STORAGE_KEY = 'agentsdock.reasoningDisplay'
const listeners = new Set<() => void>()
let memoryFallback: ReasoningDisplay | null = null

export function readReasoningDisplay(): ReasoningDisplay {
  if (memoryFallback) return memoryFallback
  try { return window.localStorage.getItem(STORAGE_KEY) === 'expanded' ? 'expanded' : 'compact' }
  catch { return 'compact' }
}

export function setReasoningDisplay(value: ReasoningDisplay): void {
  try { window.localStorage.setItem(STORAGE_KEY, value); memoryFallback = null }
  catch { memoryFallback = value }
  for (const listener of listeners) listener()
}

function storageChanged(event: StorageEvent): void {
  if (event.key === STORAGE_KEY || event.key === null) for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', storageChanged)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', storageChanged)
  }
}

export function useReasoningDisplay(): ReasoningDisplay {
  return useSyncExternalStore(subscribe, readReasoningDisplay, () => 'compact')
}
