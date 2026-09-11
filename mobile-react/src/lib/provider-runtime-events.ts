import type { AgentServerClient } from '../api/AgentServerClient'
import type { ProviderRuntimeChanged } from '../types'

export interface ProfileProviderRuntimeNotification {
  connection: AgentServerClient
  profileId: string
  profileGeneration: number
  event: ProviderRuntimeChanged
}

type ProviderRuntimeListener = (notification: ProfileProviderRuntimeNotification) => void

const listeners = new Set<ProviderRuntimeListener>()

/**
 * Ephemeral provider-runtime packets intentionally bypass the durable timeline.
 * This small in-process channel lets the selected chat invalidate its runtime
 * view without pretending the packet owns a sequence number or cache entry.
 */
export function publishProviderRuntimeChanged(notification: ProfileProviderRuntimeNotification): void {
  for (const listener of [...listeners]) listener(notification)
}

export function subscribeProviderRuntimeChanged(listener: ProviderRuntimeListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
