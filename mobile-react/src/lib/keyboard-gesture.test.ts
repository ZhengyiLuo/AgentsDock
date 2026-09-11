import { shouldFinishTimelineKeyboardDismissal, TIMELINE_KEYBOARD_DISMISS_VELOCITY } from './keyboard-gesture'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(
  shouldFinishTimelineKeyboardDismissal(true, -TIMELINE_KEYBOARD_DISMISS_VELOCITY),
  'a downward flick at the sensitivity threshold must dismiss a visible keyboard',
)
assert(
  shouldFinishTimelineKeyboardDismissal(true, -1),
  'a fast downward flick must dismiss a visible keyboard',
)
assert(
  !shouldFinishTimelineKeyboardDismissal(true, -(TIMELINE_KEYBOARD_DISMISS_VELOCITY - 0.01)),
  'a slow downward drag must remain interactive instead of being forced closed',
)
assert(!shouldFinishTimelineKeyboardDismissal(true, 0.8), 'an upward flick must preserve the keyboard')
assert(!shouldFinishTimelineKeyboardDismissal(false, -1), 'a drag that began without the keyboard must not dismiss it')
assert(!shouldFinishTimelineKeyboardDismissal(true, undefined), 'a drag without native velocity must not force dismissal')
assert(!shouldFinishTimelineKeyboardDismissal(true, Number.NaN), 'an invalid native velocity must not force dismissal')

console.log('timeline keyboard gesture regressions passed')
