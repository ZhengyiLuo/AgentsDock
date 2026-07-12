import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import { requireNativeViewManager } from 'expo-modules-core'

export type TerminalConnectionStatus = {
  status: 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Disconnected'
  name?: string
  message?: string
}

export type AgentsDockNativeTerminalHandle = {
  focus(): Promise<boolean>
  copy(): Promise<boolean>
  paste(): Promise<boolean>
}

export type AgentsDockNativeTerminalProps = ViewProps & {
  socketURL: string
  backgroundHex?: string
  foregroundHex?: string
  onStatus?: (event: NativeSyntheticEvent<TerminalConnectionStatus>) => void
}

type NativeTerminalComponent = ComponentType<
  AgentsDockNativeTerminalProps & RefAttributes<AgentsDockNativeTerminalHandle>
>

export const AgentsDockNativeTerminal = requireNativeViewManager<AgentsDockNativeTerminalProps>(
  'AgentsDockNativeTerminal',
) as NativeTerminalComponent
