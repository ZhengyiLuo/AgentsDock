import { useEffect } from 'react'
import { AppState, Keyboard } from 'react-native'
import { KeyboardController } from 'react-native-keyboard-controller'

export function dismissAppKeyboard(): void {
  // React Native owns ordinary TextInputs, while keyboard-controller handles
  // animated keyboard state. Use both because either side can miss lifecycle
  // events while iOS is moving the app between active and inactive scenes.
  Keyboard.dismiss()
  void KeyboardController.dismiss({ animated: false }).catch(() => undefined)
}

export function useAppKeyboardLifecycle(): void {
  useEffect(() => {
    let previousState = AppState.currentState
    let resumeTimer: ReturnType<typeof setTimeout> | null = null

    const subscription = AppState.addEventListener('change', nextState => {
      if (resumeTimer) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }

      const returningToForeground = nextState === 'active' && previousState !== 'active'
      previousState = nextState
      dismissAppKeyboard()

      if (returningToForeground) {
        // UIKit can finish restoring a responder one run-loop after didBecomeActive.
        // Repeating the dismissal closes that race without retaining focus state.
        resumeTimer = setTimeout(() => {
          resumeTimer = null
          dismissAppKeyboard()
        }, 0)
      }
    })

    return () => {
      if (resumeTimer) clearTimeout(resumeTimer)
      subscription.remove()
    }
  }, [])
}
