import {
  FULLSCREEN_HEADER_GUTTER,
  fullscreenModalPadding,
  fullscreenModalTopPadding,
} from './fullscreen-modal-layout'

function assertEqual(actual: number, expected: number, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`)
}

const portrait = fullscreenModalPadding({ top: 59, right: 0, bottom: 34, left: 0 }, 'ios')
assertEqual(portrait.paddingTop, 59, 'iPhone portrait should preserve the captured top inset exactly once')
assertEqual(portrait.paddingBottom, 34, 'iPhone portrait should preserve the home-indicator inset')
assertEqual(fullscreenModalTopPadding({ top: 59, right: 0, bottom: 34, left: 0 }, 'ios'), 59 + FULLSCREEN_HEADER_GUTTER, 'the close target should begin below the safe area')

const landscape = fullscreenModalPadding({ top: 0, right: 59, bottom: 21, left: 59 }, 'ios')
assertEqual(landscape.paddingTop, 20, 'iOS should retain a conservative status-area fallback when top is zero')
assertEqual(landscape.paddingRight, 59, 'landscape should preserve the right notch inset')
assertEqual(landscape.paddingLeft, 59, 'landscape should preserve the left notch inset')

const ipad = fullscreenModalPadding({ top: 24, right: 0, bottom: 20, left: 0 }, 'ios')
assertEqual(ipad.paddingTop, 24, 'iPad should preserve its captured top inset')
assertEqual(ipad.paddingBottom, 20, 'iPad should preserve its captured bottom inset')

const invalid = fullscreenModalPadding({ top: Number.NaN, right: -4, bottom: Number.POSITIVE_INFINITY, left: 0 }, 'ios')
assertEqual(invalid.paddingTop, 20, 'invalid top insets should use the iOS fallback')
assertEqual(invalid.paddingRight, 0, 'invalid horizontal insets should be discarded')
assertEqual(invalid.paddingBottom, 0, 'invalid bottom insets should be discarded')

console.log('fullscreen modal safe-area regressions passed')
