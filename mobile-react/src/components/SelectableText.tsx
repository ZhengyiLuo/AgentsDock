import type { ComponentProps } from 'react'
import { UITextView as NativeUITextView } from '@bsky.app/react-native-uitextview'
import { Platform, Text as NativeText, UIManager } from 'react-native'

type SelectableTextProps = ComponentProps<typeof NativeUITextView>

const nativeUITextViewAvailable = Platform.OS === 'ios'
  && nativeViewManagerIsAvailable('RNUITextView')
  && nativeViewManagerIsAvailable('RNUITextViewChild')

export function SelectableText({ uiTextView, onSelectionChange, ...props }: SelectableTextProps) {
  if (nativeUITextViewAvailable) {
    return <NativeUITextView uiTextView={uiTextView} onSelectionChange={onSelectionChange} {...props} />
  }
  return <NativeText {...props} />
}

export function selectableUITextViewIsAvailable(): boolean {
  return nativeUITextViewAvailable
}

function nativeViewManagerIsAvailable(name: string): boolean {
  try {
    if (typeof UIManager.hasViewManagerConfig === 'function') {
      return UIManager.hasViewManagerConfig(name)
    }
    if (typeof UIManager.getViewManagerConfig === 'function') {
      return UIManager.getViewManagerConfig(name) != null
    }
  } catch {
    return false
  }
  return false
}
