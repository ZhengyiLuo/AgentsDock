import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const shelf = source('src/components/CodexInteractionShelf.tsx')
const form = source('src/lib/codex-mcp-form.ts')

test('mobile MCP interactions use the validated schema form helpers', () => {
  for (const helper of [
    'initialMcpContent',
    'mcpContentIsValid',
    'mcpFieldValueIsValid',
    'mcpMultiSelectOptions',
    'mcpSingleSelectOptions',
    'multiSelectionIndices',
    'parseMcpNumericDraft',
    'toggleMultiSelectValue',
  ]) {
    assert.match(shelf, new RegExp(`\\b${helper}\\b`))
  }
  assert.match(shelf, /maxLength=\{maxLength\}/)
  assert.match(shelf, /keyboardType=\{mcpKeyboardType\(type, format\)\}/)
  assert.match(shelf, /key=\{`\$\{name\}:\$\{index\}:\$\{jsonIdentity\(option\.value\)\}`\}/)
  assert.match(shelf, /const \[numericDraft, setNumericDraft\]/)
  assert.match(shelf, /numericFocused\.current = true/)
  assert.match(shelf, /onChange\(parseMcpNumericDraft\(nextValue, numericType\)\)/)
})

test('mobile MCP form validation covers Mac schema constraints', () => {
  assert.match(form, /required\.has\(name\).*type\) === 'boolean'[\s\S]*content\[name\] = false/)
  assert.match(form, /items\.anyOf/)
  assert.match(form, /items\.enum/)
  assert.match(form, /definition\.minItems/)
  assert.match(form, /definition\.maxItems/)
  assert.match(form, /definition\.minLength/)
  assert.match(form, /definition\.maxLength/)
  assert.match(form, /definition\.minimum/)
  assert.match(form, /definition\.maximum/)
  assert.match(form, /format === 'email'/)
  assert.match(form, /format === 'uri'/)
  assert.match(form, /format === 'date'/)
  assert.match(form, /format === 'date-time'/)
})
