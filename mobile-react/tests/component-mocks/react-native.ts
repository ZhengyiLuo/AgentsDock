// Only the native rendering boundary is replaced. Components, React effects,
// and the subscribing application-store interface still run in these tests.
import { createElement } from 'react'

export const View = 'View'
export const Text = 'Text'
export const TextInput = 'TextInput'
export const Pressable = 'Pressable'
export const ScrollView = 'ScrollView'
export const Switch = 'Switch'
export const ActivityIndicator = 'ActivityIndicator'
export const Image = 'Image'
export const TouchableOpacity = 'TouchableOpacity'

export function Modal({ visible = true, ...props }: Record<string, unknown>) {
  return visible ? createElement('Modal', props) : null
}

export const Platform = {
  OS: 'ios',
  select<T>(choices: { ios?: T; default?: T }): T | undefined { return choices.ios ?? choices.default },
}
export const StyleSheet = {
  create<T>(styles: T): T { return styles },
  flatten(style: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(value => StyleSheet.flatten(value)))
    return style && typeof style === 'object' ? style as Record<string, unknown> : undefined
  },
  hairlineWidth: 1,
  absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
}
export const useColorScheme = () => 'dark'
export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: 1 })
export const Keyboard = { dismiss() {} }
export const Linking = { async openURL(_url: string) {} }

type AlertButton = { text?: string; style?: string; onPress?: () => void }
type AlertOptions = { cancelable?: boolean; onDismiss?: () => void }
type AlertCall = { title: string; message?: string; buttons?: AlertButton[]; options?: AlertOptions }
const alerts: AlertCall[] = []
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) {
    alerts.push({ title, message, buttons, options })
  },
  __calls: alerts,
  __reset() { alerts.length = 0 },
}

const appStateListeners = new Set<(state: string) => void>()
export const AppState = {
  currentState: 'active',
  addEventListener(_event: string, callback: (state: string) => void) {
    appStateListeners.add(callback)
    return { remove() { appStateListeners.delete(callback) } }
  },
  __emitAppState(state: string) {
    AppState.currentState = state
    for (const callback of appStateListeners) callback(state)
  },
}
