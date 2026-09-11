import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const markdown = await readFile(resolve('src/components/MarkdownContent.tsx'), 'utf8')
const markdownStyle = await readFile(resolve('src/lib/markdown.ts'), 'utf8')
const timelineRows = await readFile(resolve('src/components/TimelineRows.tsx'), 'utf8')
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
const lockfile = await readFile(resolve('pnpm-lock.yaml'), 'utf8')

test('timeline Markdown uses a pinned native UITextView range-selection surface', () => {
  assert.equal(packageJson.dependencies['@bsky.app/react-native-uitextview'], '2.7.0')
  assert.match(lockfile, /'@bsky\.app\/react-native-uitextview@2\.7\.0':/)
  assert.match(markdown, /UITextView as SelectableText/)
  assert.match(markdown, /textgroup:[\s\S]*?<SelectableText key=\{node\.key\} selectable uiTextView style=\{styles\.textgroup\}>/)
  assert.match(markdown, /code_block:[\s\S]*?<SelectableText key=\{node\.key\} selectable uiTextView style=\{\[inheritedStyles, styles\.code_block\]\}>/)
  assert.match(markdown, /fence:[\s\S]*?<SelectableText key=\{node\.key\} selectable uiTextView style=\{\[inheritedStyles, styles\.fence\]\}>/)
  assert.match(markdown, /strong:[\s\S]*?<SelectableText/)
  assert.match(markdown, /link:[\s\S]*?<SelectableText[\s\S]*?onPress=\{\(\) => openLink\(node\.attributes\.href\)\}/)
  assert.match(markdown, /code_inline:[\s\S]*?<SelectableText/)
})

test('indented Markdown keeps selectable text inside the measured list slot', () => {
  assert.match(markdownStyle, /list_item: \{[^}]*minWidth: 0[^}]*width: '100%'/)
  assert.match(markdownStyle, /ordered_list_content: \{[^}]*flex: 1[^}]*flexShrink: 1[^}]*minWidth: 0/)
  assert.match(markdownStyle, /bullet_list_content: \{[^}]*flex: 1[^}]*flexShrink: 1[^}]*minWidth: 0/)
  assert.match(markdownStyle, /textgroup: \{[^}]*flexShrink: 1[^}]*minWidth: 0[^}]*maxWidth: '100%'[^}]*width: '100%'/)
})

test('inline native attachments retain the existing Markdown renderer', () => {
  assert.match(markdown, /containsInlineAttachment\(node\)/)
  assert.match(markdown, /node\.type === 'math_inline' \|\| node\.type === 'image'/)
  assert.match(markdown, /return <NativeText key=\{node\.key\} selectable style=\{styles\.textgroup\}>/)
  assert.match(markdown, /if \(!rendered\) return <NativeText selectable/)
  assert.match(markdown, /rules=\{markdownRules\}/)
})

test('timeline messages retain an explicit full-message copy action', () => {
  const messageRow = timelineRows.slice(
    timelineRows.indexOf('function MessageRowView'),
    timelineRows.indexOf('function mergeTraceEvents'),
  )
  assert.match(timelineRows, /await Clipboard\.setStringAsync\(full\)/)
  assert.match(timelineRows, /label="Copy full text"/)
  assert.match(timelineRows, /announceForAccessibility\('Copied full message'\)/)
  assert.doesNotMatch(messageRow, /onLongPress/, 'card gestures must not compete with native selection')
})
