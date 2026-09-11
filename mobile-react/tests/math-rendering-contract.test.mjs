import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const markdown = await readFile(resolve('src/components/MarkdownContent.tsx'), 'utf8')
const timelineRows = await readFile(resolve('src/components/TimelineRows.tsx'), 'utf8')
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

test('chat Markdown connects bounded math tokens to native SVG rendering', () => {
  assert.match(markdown, /installMathMarkdown\(new MarkdownIt/)
  assert.match(markdown, /math_inline:/)
  assert.match(markdown, /math_display:/)
  assert.match(markdown, /texToSvg\(source, mathDisplay\)/)
  assert.match(markdown, /<SvgXml/)
  assert.match(markdown, /fallback=\{fallback\}/)
  assert.doesNotMatch(markdown, /translateY: rendered\.depthEm/)
  assert.equal(packageJson.dependencies['mathjax-full'], '3.2.2')
})

test('wide Markdown tables scroll horizontally without squeezing every column into the phone width', () => {
  assert.match(markdown, /table: \(node, children, _parents, markdownStyles\) =>/)
  assert.match(markdown, /markdownTableColumnCount\(node\)/)
  assert.match(markdown, /<ScrollView[\s\S]*?horizontal[\s\S]*?nestedScrollEnabled[\s\S]*?directionalLockEnabled/)
  assert.match(markdown, /markdownStyles\._VIEW_SAFE_table/)
  assert.match(markdown, /width: markdownTableMinimumWidth\(columnCount, fontScale\)/)
  assert.match(markdown, /keyboardShouldPersistTaps="always"/)
  assert.match(markdown, /tableScrollContent: \{ flexGrow: 1 \}/)
})

test('long messages fold around formulas instead of cutting TeX source', () => {
  assert.match(timelineRows, /foldMarkdownSource\(full, MESSAGE_PREVIEW_CHARACTER_LIMIT\)/)
  assert.doesNotMatch(timelineRows, /full\.slice\(0, MESSAGE_PREVIEW_CHARACTER_LIMIT\)/)
  assert.match(timelineRows, /full\.length - fold\.cutIndex/)
})
