import type { NativeSyntheticEvent, ViewProps } from 'react-native'

export type TerminalConnectionStatus = {
  status: 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Disconnected'
  name?: string
  message?: string
}

export type TerminalViewportHandle = {
  focus(): Promise<boolean>
  blur(): Promise<boolean>
  copy(): Promise<boolean>
  paste(): Promise<boolean>
}

export type TerminalViewportProps = ViewProps & {
  socketURL: string
  backgroundHex?: string
  foregroundHex?: string
  fontSize?: number
  onStatus?: (event: NativeSyntheticEvent<TerminalConnectionStatus>) => void
}
