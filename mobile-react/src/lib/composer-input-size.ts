export const COMPOSER_INPUT_MIN_HEIGHT = 46
export const COMPOSER_INPUT_MAX_HEIGHT = 178
export const COMPOSER_INPUT_COMPACT_KEYBOARD_MAX_HEIGHT = 126
export const COMPOSER_AUXILIARY_REGULAR_MAX_HEIGHT = 236
export const COMPOSER_AUXILIARY_COMPACT_MAX_HEIGHT = 144
export const COMPOSER_AUXILIARY_COMPACT_KEYBOARD_MAX_HEIGHT = 72

export interface ComposerViewportLimits {
  inputMaxHeight: number
  auxiliaryMaxHeight: number
}

export function composerViewportLimits(width: number, height: number, keyboardVisible: boolean): ComposerViewportLimits {
  const compact = width < 720 || Math.min(width, height) < 600
  if (!compact) {
    return {
      inputMaxHeight: COMPOSER_INPUT_MAX_HEIGHT,
      auxiliaryMaxHeight: COMPOSER_AUXILIARY_REGULAR_MAX_HEIGHT,
    }
  }
  if (!keyboardVisible) {
    return {
      inputMaxHeight: COMPOSER_INPUT_MAX_HEIGHT,
      auxiliaryMaxHeight: COMPOSER_AUXILIARY_COMPACT_MAX_HEIGHT,
    }
  }
  // A landscape phone can have barely enough room for the minimum input and
  // toolbar above the keyboard. Hide the scrollable auxiliary rail until the
  // keyboard is dismissed instead of allowing it to push Send off-screen.
  if (height < 500) {
    return {
      inputMaxHeight: COMPOSER_INPUT_MIN_HEIGHT,
      auxiliaryMaxHeight: 0,
    }
  }
  return {
    inputMaxHeight: COMPOSER_INPUT_COMPACT_KEYBOARD_MAX_HEIGHT,
    auxiliaryMaxHeight: COMPOSER_AUXILIARY_COMPACT_KEYBOARD_MAX_HEIGHT,
  }
}

export function measuredComposerInputHeight(measuredHeight: number): number {
  if (!Number.isFinite(measuredHeight)) return COMPOSER_INPUT_MIN_HEIGHT
  return Math.min(
    COMPOSER_INPUT_MAX_HEIGHT,
    Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.ceil(measuredHeight)),
  )
}

export function composerInputHeight(draft: string, measuredHeight: number): number {
  if (!draft.length) return COMPOSER_INPUT_MIN_HEIGHT
  return measuredComposerInputHeight(measuredHeight)
}
