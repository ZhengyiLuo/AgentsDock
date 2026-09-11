// Complete short, deliberate downward flicks that UIKit's displacement-based
// interactive dismissal can otherwise snap back.
export const TIMELINE_KEYBOARD_DISMISS_VELOCITY = 0.2

export function shouldFinishTimelineKeyboardDismissal(keyboardWasVisible: boolean, velocityY: number | undefined): boolean {
  return keyboardWasVisible
    && typeof velocityY === 'number'
    && Number.isFinite(velocityY)
    && velocityY <= -TIMELINE_KEYBOARD_DISMISS_VELOCITY
}
