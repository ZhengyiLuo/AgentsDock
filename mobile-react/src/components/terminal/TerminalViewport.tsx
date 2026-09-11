import { forwardRef, useImperativeHandle } from 'react'
import { View } from 'react-native'
import type { TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

/** Web fallback. Metro selects TerminalViewport.ios/android for device builds. */
export const TerminalViewport = forwardRef<TerminalViewportHandle, TerminalViewportProps>(function TerminalViewport(props, ref) {
  useImperativeHandle(ref, () => ({
    focus: async () => false,
    blur: async () => true,
    copy: async () => false,
    paste: async () => false,
  }), [])
  return <View {...props} />
})
