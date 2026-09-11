import {
  APP_FONT_SCALE_DEFAULT,
  APP_FONT_SCALE_MAX,
  APP_FONT_SCALE_MIN,
  clampAppFontScale,
  scaleAppFont,
} from './typography'

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}

assertEqual(clampAppFontScale(undefined), APP_FONT_SCALE_DEFAULT, 'missing scale uses the default')
assertEqual(clampAppFontScale('not-a-number'), APP_FONT_SCALE_DEFAULT, 'invalid scale uses the default')
assertEqual(clampAppFontScale(0.2), APP_FONT_SCALE_MIN, 'small scale clamps to the minimum')
assertEqual(clampAppFontScale(2), APP_FONT_SCALE_MAX, 'large scale clamps to the maximum')
assertEqual(clampAppFontScale(1.26), 1.3, 'scale snaps to a tenth')

assertEqual(scaleAppFont(13, 0.8), 10.5, 'minimum scale rounds to a half point')
assertEqual(scaleAppFont(13, 1), 13, 'default scale preserves font metrics')
assertEqual(scaleAppFont(13, 1.4), 18, 'maximum scale rounds to a half point')
assertEqual(scaleAppFont(15.5, 1.3), 20, 'fractional metrics remain deterministic')

console.log('app-wide typography regressions passed')
