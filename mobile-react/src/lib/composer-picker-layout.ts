import { COMPOSER_INPUT_MIN_HEIGHT } from './composer-input-size'

export interface ComposerPickerViewport {
  width: number
  height: number
  keyboardVisible: boolean
  keyboardHeight: number
}

export interface ComposerPickerLayout {
  sideBySide: boolean
  maxHeight: number
  inputMaxHeight: number
}

/** Shared picker/editor budget; the normal composer keeps its existing sizing. */
export function composerPickerLayout({ height, keyboardVisible, keyboardHeight }: ComposerPickerViewport): ComposerPickerLayout {
  const measuredKeyboard = Number.isFinite(keyboardHeight) && keyboardHeight > 0
  // Reserve the chat header and top safe area. Before the first native keyboard
  // frame arrives, keep short phones compact without guessing a keyboard size.
  const sideBySide = keyboardVisible && (measuredKeyboard
    ? height - keyboardHeight - 150 < 288
    : height < 700)
  return {
    sideBySide,
    maxHeight: sideBySide ? COMPOSER_INPUT_MIN_HEIGHT
      : keyboardVisible ? 140 : Math.min(280, Math.floor(height * 0.28)),
    inputMaxHeight: COMPOSER_INPUT_MIN_HEIGHT,
  }
}
