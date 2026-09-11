import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import { requireNativeViewManager } from 'expo-modules-core'

export type AgentsDockNativeVideoStatus = {
  status: 'Loading' | 'Ready' | 'Playing' | 'Paused' | 'Error'
  message?: string
  duration?: number
}

export type AgentsDockNativeVideoHandle = {
  play(): Promise<boolean>
  pause(): Promise<boolean>
}

export type AgentsDockNativeVideoProps = ViewProps & {
  sourceURI: string
  autoplay?: boolean
  onStatus?: (event: NativeSyntheticEvent<AgentsDockNativeVideoStatus>) => void
}

type NativeVideoComponent = ComponentType<
  AgentsDockNativeVideoProps & RefAttributes<AgentsDockNativeVideoHandle>
>

let cachedView: NativeVideoComponent | null = null

/**
 * Resolve the Apple-only view lazily. Android never evaluates a missing view
 * manager merely because the cross-platform artifact viewer was imported.
 */
export function requireAgentsDockNativeVideo(): NativeVideoComponent {
  if (!cachedView) {
    cachedView = requireNativeViewManager<AgentsDockNativeVideoProps>(
      'AgentsDockNativeVideo',
    ) as NativeVideoComponent
  }
  return cachedView
}
