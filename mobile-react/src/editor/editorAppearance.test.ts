import assert from 'node:assert/strict'
import {
  DEFAULT_EDITOR_APPEARANCE,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  clampEditorFontSize,
  nextEditorTheme,
  normalizeEditorAppearance,
} from './editorAppearance'

assert.deepEqual(normalizeEditorAppearance(null), DEFAULT_EDITOR_APPEARANCE)
assert.deepEqual(normalizeEditorAppearance({ theme: 'github-light', fontSize: 16.4 }), {
  theme: 'github-light',
  fontSize: 16,
})
assert.deepEqual(normalizeEditorAppearance({ theme: 'unknown', fontSize: Number.NaN }), DEFAULT_EDITOR_APPEARANCE)
assert.equal(clampEditorFontSize(-100), EDITOR_FONT_SIZE_MIN)
assert.equal(clampEditorFontSize(100), EDITOR_FONT_SIZE_MAX)
assert.equal(nextEditorTheme('vscode-dark'), 'github-dark')
assert.equal(nextEditorTheme('github-light'), 'vscode-dark')

console.log('editor appearance tests passed')
