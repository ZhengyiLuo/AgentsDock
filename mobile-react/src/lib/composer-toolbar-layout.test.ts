import { COMPOSER_INPUT_MAX_HEIGHT, COMPOSER_INPUT_MIN_HEIGHT } from './composer-input-size'
import {
  COMPOSER_COMPACT_TOOLBAR_HEIGHT,
  COMPOSER_COMPACT_TOOLBAR_GAP,
  COMPOSER_EMPTY_CARD_MIN_HEIGHT,
  COMPOSER_CARD_MAX_HEIGHT,
  COMPOSER_PERMISSION_FACE_SIZE,
  COMPOSER_SEND_FACE_SIZE,
  COMPOSER_SHELL_PADDING,
  COMPOSER_STOP_FACE_SIZE,
  COMPOSER_TOOLBAR_TOUCH_SIZE,
  compactComposerToolbarFits,
  compactComposerToolbarRequiredWidth,
  isCompactComposerToolbar,
  isDenseComposerToolbar,
} from './composer-toolbar-layout'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const worstPhoneState = { backend: 'codex' as const, active: true, hasReadyContent: true }
for (const width of [320, 375, 393, 430, 440, 599]) {
  const composerWidth = width - COMPOSER_SHELL_PADDING * 2
  assert(isCompactComposerToolbar(composerWidth), `${width}pt must use the compact toolbar`)
  assert(compactComposerToolbarFits(composerWidth, worstPhoneState), `${width}pt must retain every active Codex action`)
}
assert(!isCompactComposerToolbar(600), '600pt must retain the labeled tablet toolbar')
assert(isDenseComposerToolbar(300), 'a 320pt viewport must use the dense fallback')
assert(!isDenseComposerToolbar(355), 'standard phones must keep equal-width backend spacing')
assert(compactComposerToolbarRequiredWidth(worstPhoneState, true) === 296, 'the dense worst case must stay deterministic')
assert(compactComposerToolbarRequiredWidth({ backend: 'codex', active: false, hasReadyContent: false }, true) === 224, 'the idle dense provider action must reserve a 44pt target')
assert(compactComposerToolbarRequiredWidth(worstPhoneState, false) === 330, 'the regular phone worst case must count every gap')
assert(COMPOSER_COMPACT_TOOLBAR_GAP > 0, 'standard phones must retain visible control rhythm')
for (const composerWidth of [445, 492, 512]) {
  assert(isCompactComposerToolbar(composerWidth), `${composerWidth}pt split chat panes must stay compact`)
  assert(compactComposerToolbarFits(composerWidth, worstPhoneState), `${composerWidth}pt split chat panes must retain every action`)
}
for (const backend of [null, 'claude', 'codex'] as const) {
  for (const active of [false, true]) {
    for (const hasReadyContent of [false, true]) {
      const state = { backend, active, hasReadyContent }
      assert(compactComposerToolbarFits(300, state), `${backend ?? 'no-backend'} state must fit the dense fallback`)
      assert(compactComposerToolbarFits(355, state), `${backend ?? 'no-backend'} state must fit a standard phone`)
    }
  }
}
assert(COMPOSER_TOOLBAR_TOUCH_SIZE === 44, 'compact controls must preserve 44pt hit targets')
assert(COMPOSER_PERMISSION_FACE_SIZE < COMPOSER_TOOLBAR_TOUCH_SIZE, 'permission chrome must not fill its hit target')
assert(COMPOSER_STOP_FACE_SIZE < COMPOSER_TOOLBAR_TOUCH_SIZE, 'Stop chrome must not fill its hit target')
assert(COMPOSER_SEND_FACE_SIZE < COMPOSER_TOOLBAR_TOUCH_SIZE, 'Send chrome must not fill its hit target')
assert(
  COMPOSER_EMPTY_CARD_MIN_HEIGHT === COMPOSER_INPUT_MIN_HEIGHT + COMPOSER_COMPACT_TOOLBAR_HEIGHT,
  'the empty composer must not reserve dead vertical space',
)
assert(COMPOSER_CARD_MAX_HEIGHT >= COMPOSER_INPUT_MAX_HEIGHT + 48 + 2, 'the card maximum must fit a wide growing input')

console.log('composer toolbar layout regressions passed')
