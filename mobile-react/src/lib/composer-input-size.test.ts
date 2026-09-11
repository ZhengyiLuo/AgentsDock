import {
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_MIN_HEIGHT,
  composerInputHeight,
  measuredComposerInputHeight,
} from './composer-input-size'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(
  composerInputHeight('', COMPOSER_INPUT_MAX_HEIGHT) === COMPOSER_INPUT_MIN_HEIGHT,
  'clearing a large draft must collapse stale native content height',
)
assert(
  measuredComposerInputHeight(COMPOSER_INPUT_MAX_HEIGHT) === COMPOSER_INPUT_MAX_HEIGHT,
  'native measurements must not depend on a stale draft captured by the event handler',
)
assert(
  composerInputHeight('short', 24) === COMPOSER_INPUT_MIN_HEIGHT,
  'short drafts must retain the compact minimum height',
)
assert(
  composerInputHeight('multiple\nlines', 101.2) === 102,
  'growing drafts must follow rounded-up native content height',
)
assert(
  composerInputHeight('very long', 400) === COMPOSER_INPUT_MAX_HEIGHT,
  'large drafts must stop growing at the scrollable maximum',
)
assert(
  composerInputHeight('invalid measurement', Number.NaN) === COMPOSER_INPUT_MIN_HEIGHT,
  'invalid native measurements must fail closed at the minimum',
)

console.log('composer input sizing regressions passed')
