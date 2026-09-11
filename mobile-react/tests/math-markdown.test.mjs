import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const outfile = join(tmpdir(), `agentsdock-math-markdown-${process.pid}-${Date.now()}.mjs`)
await build({
  entryPoints: [resolve('src/lib/math-markdown.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})

const { installMathMarkdown, MATH_MARKDOWN_FORMULA_LIMIT } = await import(pathToFileURL(outfile).href)
await unlink(outfile).catch(() => undefined)
const markdownPackage = realpathSync(resolve('node_modules/react-native-markdown-display/package.json'))
const markdownRequire = createRequire(markdownPackage)
const MarkdownIt = markdownRequire('markdown-it')

function parseInline(source) {
  const markdown = installMathMarkdown(new MarkdownIt({ typographer: true }))
  return markdown.parse(source, {}).flatMap(token => token.children ?? [token])
}

test('math plugin emits inline and display tokens with original source metadata', () => {
  const tokens = parseInline('Inline $x+1$.\n\n$$\\frac{1}{2}$$')
  const inline = tokens.find(token => token.type === 'math_inline')
  const display = tokens.find(token => token.type === 'math_display')
  assert.equal(inline?.content, 'x+1')
  assert.deepEqual(inline?.meta, { raw: '$x+1$', display: false })
  assert.equal(inline?.block, false)
  assert.equal(display?.content, '\\frac{1}{2}')
  assert.deepEqual(display?.meta, { raw: '$$\\frac{1}{2}$$', display: true })
  assert.equal(display?.block, true)
})

test('embedded display delimiters stay inline-safe inside emphasis', () => {
  const tokens = parseInline('*before $$x^2$$ after*')
  const math = tokens.find(token => token.type === 'math_inline')
  assert.equal(math?.content, 'x^2')
  assert.equal(math?.block, false)
  assert.deepEqual(math?.meta, { raw: '$$x^2$$', display: true })
  assert.equal(tokens.some(token => token.type === 'math_display'), false)
  assert.equal(tokens.filter(token => token.type === 'em_open').length, 1)
  assert.equal(tokens.filter(token => token.type === 'em_close').length, 1)
})

test('standalone display math terminates paragraphs and supports multiline legacy delimiters', () => {
  const markdown = installMathMarkdown(new MarkdownIt({ typographer: true }))
  const tokens = markdown.parse('Before\n\\[\n\\sum_{i=1}^n i\n\\]\nAfter', {})
  assert.deepEqual(tokens.map(token => token.type), [
    'paragraph_open', 'inline', 'paragraph_close',
    'math_display',
    'paragraph_open', 'inline', 'paragraph_close',
  ])
  const display = tokens.find(token => token.type === 'math_display')
  assert.equal(display?.content, '\n\\sum_{i=1}^n i\n')
  assert.equal(display?.block, true)
})

test('math plugin leaves code and currency literal and supports spaced legacy math', () => {
  const tokens = parseInline('Cost $5; code `$x$`; actual \\( x + y \\), arithmetic $2+2=4$.')
  const math = tokens.filter(token => token.type === 'math_inline')
  assert.equal(math.length, 2)
  assert.deepEqual(math.map(token => token.content), [' x + y ', '2+2=4'])
  assert.equal(tokens.find(token => token.type === 'code_inline')?.content, '$x$')
  assert.match(tokens.filter(token => token.type === 'text').map(token => token.content).join(''), /Cost \$5/)
})

test('math plugin preserves unmatched legacy delimiters verbatim', () => {
  const tokens = parseInline('Broken \\( formula and stray \\].')
  assert.equal(tokens.filter(token => token.type.startsWith('math_')).length, 0)
  assert.match(tokens.filter(token => token.type === 'text').map(token => token.content).join(''), /\\\( formula and stray \\\]/)
})

test('math plugin bounds formula work while retaining overflow source', () => {
  const source = Array.from({ length: MATH_MARKDOWN_FORMULA_LIMIT + 2 }, (_, index) => `$x_${index}$`).join(' ')
  const tokens = parseInline(source)
  assert.equal(tokens.filter(token => token.type === 'math_inline').length, MATH_MARKDOWN_FORMULA_LIMIT)
  const text = tokens.filter(token => token.type === 'text').map(token => token.content).join('')
  assert.match(text, new RegExp(`\\$x_${MATH_MARKDOWN_FORMULA_LIMIT}\\$`))
})
