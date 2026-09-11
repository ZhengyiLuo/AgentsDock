import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = {
  'react-native': `export const View = 'View', Text = 'Text', ScrollView = 'ScrollView'; export const Linking = { openURL: async () => {} }; export const StyleSheet = { create: value => value, flatten: value => Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean)) : value };`,
  '@bsky.app/react-native-uitextview': `export const UITextView = 'SelectableText';`,
  'react-native-svg': `export const SvgXml = 'SvgXml';`,
  'react-native-markdown-display': `export default 'Markdown'; export class MarkdownIt {}`,
  '../lib/math-markdown': `export const installMathMarkdown = value => value;`,
  '../lib/tex-svg': `export const texToSvg = () => null;`,
  '../lib/timeline-inline-references': `export const prepareInlineRouteMarkdown = text => ({ text, markers: [] }); export const restoreInlineRouteMarkerText = text => text; export const splitInlineRouteMarkerText = text => [{ text }]; export const timelineChatReferenceIsRemote = () => false; export const inlineRouteReferenceIsInteractive = () => false;`,
  '../theme': `const colors = { text: '#eeeeee', blue: '#2f8cff', muted: '#999999', raised: '#202225', border: '#2b2d31', surface: '#18191b' }; export const usePalette = () => colors;`,
}
const outfile = path.resolve('build/tmp', `markdown-content-compact-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/components/MarkdownContent.tsx'], outfile,
  bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent',
  plugins: [{ name: 'markdown-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'markdown-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'markdown-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile) })
const { MarkdownContent } = await import(pathToFileURL(outfile).href)
const mathNode = { key: 'formula', content: 'x^2', markup: '$' }

test('compact Markdown and math preserve the user font scale and conversation tint', async () => {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(MarkdownContent, { value: '**Result** $x^2$', compact: true, color: '#ded6f1', fontScale: 1.2 })) })
  try {
    const { style, rules } = renderer.root.findByType('Markdown').props
    assert.equal(style.body.fontSize, 14.5)
    assert.equal(style.body.lineHeight, 23)
    assert.equal(style.body.color, '#ded6f1')
    for (const rule of ['math_inline', 'math_display']) {
      const formula = rules[rule](mathNode, [], [], {}, {})
      assert.equal(formula.props.fontSize, 14.5)
      assert.equal(formula.props.color, '#ded6f1')
      assert.equal(formula.props.block, rule === 'math_display')
      assert.equal(rules[rule](mathNode, [], [], {}, { fontSize: 21.5 }).props.fontSize, 21.5, 'Math inside a heading must honor inherited typography')
    }
    await act(async () => renderer.update(React.createElement(MarkdownContent, { value: '**Result** $x^2$' })))
    const normal = renderer.root.findByType('Markdown').props
    assert.equal(normal.style.body.fontSize, 15.5)
    assert.equal(normal.style.body.lineHeight, 23)
    assert.equal(normal.style.body.color, '#eeeeee')
    assert.equal(normal.rules.math_inline(mathNode, [], [], {}, {}).props.fontSize, 15.5)
    assert.equal(normal.rules.math_inline(mathNode, [], [], {}, {}).props.color, '#eeeeee')
  } finally { await act(async () => renderer.unmount()) }
})
