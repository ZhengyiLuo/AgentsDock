import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { execFileSync } from 'node:child_process'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const outfile = resolve('build/tmp', `backend-mark-${process.pid}.mjs`)
const mocks = {
  'react-native': `export const Image='Image',View='View'; export const StyleSheet={create:x=>x};`,
  'lucide-react-native': `export const MousePointer2='MousePointer2',Code2='Code2';`,
  'expo-image': `export const Image='VectorImage';`,
  '../theme': `export const radius={sm:6}; export const usePalette=()=>({text:'#111'});`,
}
await build({
  entryPoints: ['src/components/BackendMark.tsx'], outfile, bundle: true, platform: 'node', format: 'esm',
  jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => unlink(outfile))
const { BackendMark } = await import(pathToFileURL(outfile).href)

test('embedded marks stay byte-identical to the original artwork', () => {
  execFileSync(process.execPath, ['scripts/embed-backend-marks.mjs', '--check'])
})

for (const backend of ['claude', 'codex']) {
  test(`${backend} uses the same self-contained image after remount without any server address`, async () => {
    const original = await readFile(`assets/backend-${backend}.png`)
    for (let attempt = 0; attempt < 2; attempt++) {
      let tree
      await act(async () => { tree = TestRenderer.create(React.createElement(BackendMark, { backend, size: 22 })) })
      try {
        const image = tree.root.findByType('Image')
        assert.match(image.props.source.uri, /^data:image\/png;base64,/)
        assert.deepEqual(Buffer.from(image.props.source.uri.split(',')[1], 'base64'), original)
        assert.equal(image.props.style[1].width, 22)
        assert.equal(image.props.style[1].height, 22)
        assert.equal(image.props.resizeMode, 'contain')
      } finally { await act(async () => tree.unmount()) }
    }
  })
}

test('Cursor continues to render locally without an image request', async () => {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(BackendMark, { backend: 'cursor' })) })
  try {
    assert.equal(tree.root.findAllByType('Image').length, 0)
    assert.equal(tree.root.findAllByType('MousePointer2').length, 1)
  } finally { await act(async () => tree.unmount()) }
})

test('Gemini embeds the desktop multicolor artwork without a remote request or tint', async () => {
  const original = await readFile('assets/backend-gemini.svg')
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(BackendMark, { backend: 'gemini', size: 24 })) })
  try {
    const image = tree.root.findByType('VectorImage')
    assert.match(image.props.source.uri, /^data:image\/svg\+xml;base64,/)
    assert.deepEqual(Buffer.from(image.props.source.uri.split(',')[1], 'base64'), original)
    assert.deepEqual(image.props.style, { width: 24, height: 24 })
    assert.equal(image.props.tintColor, undefined)
  } finally { await act(async () => tree.unmount()) }
})
