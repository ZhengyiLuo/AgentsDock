export interface IOSKeyboardLifecycleState {
  appActive: boolean
  visible: boolean
  avoidanceEnabled: boolean
  hideCompletionPending: boolean
}

export type IOSKeyboardLifecycleEvent =
  | { type: 'app-state'; status: 'active' | 'inactive' | 'background' }
  | { type: 'keyboard-will-show' }
  | { type: 'keyboard-did-show' }
  | { type: 'keyboard-will-hide' }
  | { type: 'keyboard-did-hide' }
  | { type: 'keyboard-hide-timeout' }

// Native iOS keyboard settle animations normally finish within 250-350 ms.
// This is deliberately longer so it only repairs a missing completion event.
export const IOS_KEYBOARD_HIDE_FALLBACK_MS = 700

export function initialIOSKeyboardLifecycle(appActive: boolean): IOSKeyboardLifecycleState {
  // Never seed this from KeyboardController.isVisible(). Both that value and
  // the avoiding view's animation progress are event-driven and can be stale
  // after iOS suspends before delivering keyboardDidHide.
  return { appActive, visible: false, avoidanceEnabled: false, hideCompletionPending: false }
}

export function reduceIOSKeyboardLifecycle(
  state: IOSKeyboardLifecycleState,
  event: IOSKeyboardLifecycleEvent,
): IOSKeyboardLifecycleState {
  switch (event.type) {
    case 'app-state':
      // Both the persistent JS keyboard lifecycle and the native app delegate
      // end editing as soon as iOS resigns active. Treat that transition as an
      // authoritative geometry reset too: iOS can suppress keyboardDidHide
      // while a picker, system sheet, or background transition owns the scene.
      if (event.status !== 'active') {
        if (!state.appActive && !state.visible && !state.avoidanceEnabled && !state.hideCompletionPending) return state
        return { appActive: false, visible: false, avoidanceEnabled: false, hideCompletionPending: false }
      }
      return state.appActive ? state : { ...state, appActive: true }

    case 'keyboard-will-show':
      if (!state.appActive || (state.visible && state.avoidanceEnabled && !state.hideCompletionPending)) return state
      return { ...state, visible: true, avoidanceEnabled: true, hideCompletionPending: false }

    case 'keyboard-did-show':
      // Some cancelled interactive dismissals emit did-show without another
      // will-show. A pending hide is the capability to restore that cycle even
      // after its fallback fired; background cleanup revokes the capability so
      // a delayed did-show after foregrounding cannot resurrect stale padding.
      if (!state.appActive || state.visible || (!state.avoidanceEnabled && !state.hideCompletionPending)) return state
      return { ...state, visible: true, avoidanceEnabled: true, hideCompletionPending: false }

    case 'keyboard-will-hide':
      // Keep avoidance enabled through the native animation so interactive
      // pull-down continues to track the keyboard instead of snapping.
      return state.appActive && state.visible ? { ...state, visible: false, hideCompletionPending: true } : state

    case 'keyboard-did-hide':
      if (!state.visible && !state.avoidanceEnabled && !state.hideCompletionPending) return state
      return { ...state, visible: false, avoidanceEnabled: false, hideCompletionPending: false }

    case 'keyboard-hide-timeout':
      // A fresh will-show means an interactive dismissal was cancelled. Its
      // cleared pending flag protects it even if the old timeout was queued.
      // Retain the flag when the fallback fires so a later did-show can still
      // recover a long interactive dismissal that the user cancelled.
      if (!state.appActive || state.visible || !state.avoidanceEnabled || !state.hideCompletionPending) return state
      return { ...state, avoidanceEnabled: false }
  }
}
