import {
  COMPOSER_AUXILIARY_COMPACT_KEYBOARD_MAX_HEIGHT,
  COMPOSER_AUXILIARY_COMPACT_MAX_HEIGHT,
  COMPOSER_AUXILIARY_REGULAR_MAX_HEIGHT,
  COMPOSER_INPUT_COMPACT_KEYBOARD_MAX_HEIGHT,
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_MIN_HEIGHT,
  COMPOSER_INPUT_LANDSCAPE_HEIGHT,
  composerViewportLimits,
} from './composer-input-size'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const portraitPhoneWithKeyboard = composerViewportLimits(393, 852, true)
assert(
  portraitPhoneWithKeyboard.inputMaxHeight === COMPOSER_INPUT_COMPACT_KEYBOARD_MAX_HEIGHT,
  'a portrait phone keyboard must cap the growing input',
)
assert(
  portraitPhoneWithKeyboard.auxiliaryMaxHeight === COMPOSER_AUXILIARY_COMPACT_KEYBOARD_MAX_HEIGHT,
  'a portrait phone keyboard must keep queued turns and attachments inside a short scroll rail',
)

const landscapePhoneWithKeyboard = composerViewportLimits(852, 393, true)
assert(
  landscapePhoneWithKeyboard.inputMaxHeight === COMPOSER_INPUT_LANDSCAPE_HEIGHT,
  'a landscape phone keyboard must reserve room for the toolbar before growing the input',
)
assert(
  landscapePhoneWithKeyboard.auxiliaryMaxHeight === 0,
  'a landscape phone keyboard must not let auxiliary content cover the toolbar',
)

const portraitPhoneWithoutKeyboard = composerViewportLimits(393, 852, false)
assert(portraitPhoneWithoutKeyboard.inputMaxHeight === COMPOSER_INPUT_MAX_HEIGHT, 'a hidden keyboard must restore full draft growth')
assert(
  portraitPhoneWithoutKeyboard.auxiliaryMaxHeight === COMPOSER_AUXILIARY_COMPACT_MAX_HEIGHT,
  'a hidden phone keyboard must restore the compact auxiliary rail',
)

const tabletWithKeyboard = composerViewportLimits(1024, 1366, true)
assert(tabletWithKeyboard.inputMaxHeight === COMPOSER_INPUT_MAX_HEIGHT, 'an iPad has room for the full input above its keyboard')
assert(
  tabletWithKeyboard.auxiliaryMaxHeight === COMPOSER_AUXILIARY_REGULAR_MAX_HEIGHT,
  'an iPad must retain the regular auxiliary rail',
)

console.log('composer viewport regressions passed')
