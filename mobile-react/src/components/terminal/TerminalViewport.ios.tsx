import { forwardRef } from 'react'
import {
  AgentsDockNativeTerminal,
  type AgentsDockNativeTerminalHandle,
} from 'agentsdock-native-terminal'
import type { TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export const TerminalViewport = forwardRef<TerminalViewportHandle, TerminalViewportProps>(function TerminalViewport(props, ref) {
  return <AgentsDockNativeTerminal
    {...props}
    ref={ref as React.ForwardedRef<AgentsDockNativeTerminalHandle>}
  />
})
