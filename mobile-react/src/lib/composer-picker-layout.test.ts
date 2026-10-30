import assert from 'node:assert/strict'
import { composerPickerLayout } from './composer-picker-layout'

assert.deepEqual(composerPickerLayout({ width: 390, height: 844, keyboardVisible: true, keyboardHeight: 336 }), {
  sideBySide: false, maxHeight: 140, inputMaxHeight: 46,
}, 'portrait picker and minimum editor share a bounded vertical budget')
assert.deepEqual(composerPickerLayout({ width: 844, height: 390, keyboardVisible: true, keyboardHeight: 208 }), {
  sideBySide: true, maxHeight: 46, inputMaxHeight: 46,
}, 'landscape palette must not add another row above the editor and toolbar')
assert.deepEqual(composerPickerLayout({ width: 320, height: 568, keyboardVisible: true, keyboardHeight: 291 }), {
  sideBySide: true, maxHeight: 46, inputMaxHeight: 46,
}, 'short phones retain a reachable editor, picker row, and toolbar')
for (const viewport of [
  { width: 1024, height: 1366, keyboardHeight: 440 },
  { width: 1366, height: 1024, keyboardHeight: 420 },
]) {
  assert.deepEqual(composerPickerLayout({ ...viewport, keyboardVisible: true }), {
    sideBySide: false, maxHeight: 140, inputMaxHeight: 46,
  }, 'tablets retain the normal inline palette when the keyboard-reduced budget fits')
}
for (const keyboardHeight of [0, -1, Number.NaN]) {
  assert.equal(composerPickerLayout({ width: 320, height: 568, keyboardVisible: true, keyboardHeight }).sideBySide, true)
  assert.equal(composerPickerLayout({ width: 390, height: 844, keyboardVisible: true, keyboardHeight }).sideBySide, false)
}
assert.equal(composerPickerLayout({ width: 390, height: 700, keyboardVisible: true, keyboardHeight: 0 }).sideBySide, false,
  'unknown native frames use the explicit short-window fallback, not a fabricated keyboard height')
assert.equal(composerPickerLayout({ width: 390, height: 774, keyboardVisible: true, keyboardHeight: 336 }).sideBySide, false)
assert.equal(composerPickerLayout({ width: 390, height: 773, keyboardVisible: true, keyboardHeight: 336 }).sideBySide, true)
for (const viewport of [
  { width: 390, height: 844, maxHeight: 236 },
  { width: 844, height: 390, maxHeight: 109 },
  { width: 1024, height: 1366, maxHeight: 280 },
]) {
  assert.deepEqual(composerPickerLayout({ ...viewport, keyboardVisible: false, keyboardHeight: 336 }), {
    sideBySide: false, maxHeight: viewport.maxHeight, inputMaxHeight: 46,
  }, 'hidden keyboard ignores a stale native height and bounds the palette to the window')
}
console.log('composer picker shared layout budget regressions passed')
