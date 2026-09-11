import assert from 'node:assert/strict'
import test from 'node:test'
import { codeEditorLanguage } from './codeEditorLanguage'
import {
  CODE_EDITOR_ENGINE_SOURCE,
  CODE_EDITOR_NATIVE_SOURCE,
  CODE_EDITOR_PROTOCOL_VERSION,
  applyCodeEditorChanges,
  codeEditorSequenceIsNewer,
  codeEditorUtf8ByteLength,
  codeEditorUtf8BytesAfterChanges,
  parseCodeEditorEngineMessage,
  parseCodeEditorHostMessage,
  serializeCodeEditorHostMessage,
  type CodeEditorHostMessage,
} from './codeEditorProtocol'
import {
  CODE_EDITOR_DEFAULT_FONT_SIZE,
  CODE_EDITOR_DEFAULT_THEME,
  CODE_EDITOR_FONT_SIZE_MAX,
  CODE_EDITOR_FONT_SIZE_MIN,
  clampCodeEditorFontSize,
  codeEditorTheme,
} from './codeEditorTheme'

test('mobile editor language selection matches the Mac editor set', () => {
  for (const [path, expected] of [
    ['src/App.tsx', 'typescript-react'],
    ['worker.mjs', 'javascript'],
    ['.eslintrc', 'json'],
    ['README.mdx', 'markdown'],
    ['SConstruct', 'python'],
    ['component.vue', 'html'],
    ['theme.scss', 'css'],
    ['config.yml', 'yaml'],
    ['Makefile', 'shell'],
    ['Cargo.toml', 'toml'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['query.sqlite', 'sql'],
    ['Dockerfile.release', 'dockerfile'],
    ['header.h', 'c'],
    ['bridge.mm.hpp', 'cpp'],
    ['Main.java', 'java'],
    ['notes.txt', 'plain-text'],
  ] as const) assert.equal(codeEditorLanguage(path).id, expected, path)
})

test('editor themes and font sizes normalize without platform state', () => {
  assert.equal(codeEditorTheme('github-light').mode, 'light')
  assert.equal(codeEditorTheme('unknown').id, CODE_EDITOR_DEFAULT_THEME)
  assert.equal(clampCodeEditorFontSize(Number.NaN), CODE_EDITOR_DEFAULT_FONT_SIZE)
  assert.equal(clampCodeEditorFontSize(1), CODE_EDITOR_FONT_SIZE_MIN)
  assert.equal(clampCodeEditorFontSize(99), CODE_EDITOR_FONT_SIZE_MAX)
  assert.equal(clampCodeEditorFontSize(14.6), 15)
})

test('protocol accepts versioned initialize messages and rejects malformed input', () => {
  const message: CodeEditorHostMessage = {
    source: CODE_EDITOR_NATIVE_SOURCE,
    version: CODE_EDITOR_PROTOCOL_VERSION,
    sequence: 1,
    requestId: 'open-1',
    command: {
      type: 'initialize',
      path: 'src/App.tsx',
      content: 'export default App',
      readOnly: false,
      maxBytes: 2 * 1024 * 1024,
      theme: 'vscode-dark',
      fontSize: 13,
      viewState: { anchor: 2, head: 2, scrollTop: 12, scrollLeft: 0 },
    },
  }
  assert.deepEqual(parseCodeEditorHostMessage(serializeCodeEditorHostMessage(message)), message)
  assert.equal(parseCodeEditorHostMessage('{bad json'), null)
  assert.equal(parseCodeEditorHostMessage({ ...message, version: 2 }), null)
  assert.equal(parseCodeEditorHostMessage({ ...message, sequence: 0 }), null)
  assert.equal(parseCodeEditorHostMessage({ ...message, command: { ...message.command, maxBytes: -1 } }), null)
})

test('protocol accepts engine acknowledgements and enforces monotonic sequences', () => {
  const ready = parseCodeEditorEngineMessage(JSON.stringify({
    source: CODE_EDITOR_ENGINE_SOURCE,
    version: CODE_EDITOR_PROTOCOL_VERSION,
    sequence: 1,
    event: { type: 'ready' },
  }))
  assert.equal(ready?.event.type, 'ready')
  assert.equal(codeEditorSequenceIsNewer(0, 1), true)
  assert.equal(codeEditorSequenceIsNewer(1, 1), false)
  assert.equal(codeEditorSequenceIsNewer(2, 1), false)
  assert.equal(codeEditorSequenceIsNewer(2, 3), true)
})

test('incremental UTF-8 accounting uses CodeMirror UTF-16 offsets safely', () => {
  const document = 'a🙂b\nc'
  const changes = [
    { from: 1, to: 3, insert: 'é' },
    { from: 3, to: 4, insert: 'β' },
  ]
  const updated = applyCodeEditorChanges(document, changes)
  const updatedBytes = codeEditorUtf8BytesAfterChanges(document, codeEditorUtf8ByteLength(document), changes)
  assert.equal(updated, 'aéβ\nc')
  assert.equal(updatedBytes, 7)
  assert.equal(updatedBytes, codeEditorUtf8ByteLength(updated))
})

test('delta helpers reject overlapping and out-of-bounds changes', () => {
  assert.throws(() => applyCodeEditorChanges('abcd', [
    { from: 1, to: 3, insert: 'x' },
    { from: 2, to: 4, insert: 'y' },
  ]), /ordered and non-overlapping/)
  assert.throws(() => applyCodeEditorChanges('abcd', [
    { from: 4, to: 5, insert: 'x' },
  ]), /document bounds/)
})
