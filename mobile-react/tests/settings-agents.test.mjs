import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { create } from 'zustand'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ts from 'typescript'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const initial = {
  profiles: [{ id: 'first', name: 'Test server' }], activeProfileId: 'first', profileGeneration: 1,
  connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
  health: null, runtime: null, error: null, refreshRuntime: async () => {},
}
const store = globalThis.__myAgentsStore = create(() => initial)
const mocks = {
  'react-native': `export const ActivityIndicator='Spinner',Pressable='Button',View='View'; export const StyleSheet={create:x=>x,hairlineWidth:1}; export const useColorScheme=()=> 'light';`,
  'lucide-react-native': ['Circle', 'CircleCheck', 'Code2', 'RefreshCw', 'Sparkles'].map(name => `export const ${name}='${name}';`).join(''),
  '../store/useAppStore': `export const useAppStore=globalThis.__myAgentsStore;`,
  './store/useAppearanceStore': `export const useAppearanceStore=selector=>selector({preference:'light'});`,
  './AppText': `export const Text='Text';`,
  './BackendMark': `export const BackendMark='BackendMark';`,
}
const outfile = path.resolve('build/tmp', `settings-agents-${process.pid}.mjs`)
await fs.mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export {MyAgentsSettings} from './src/components/MyAgentsSettings'; export * from './src/lib/settings-agents';`, resolveDir: process.cwd() },
  outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'my-agents-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => fs.unlink(outfile))
beforeEach(() => store.setState(initial, true))
const { MyAgentsSettings, SETTINGS_AGENTS, settingsAgentAvailable, tailscaleServerHost } = await import(pathToFileURL(outfile).href)
const diagnostic = (status = 'ready', checked_at = '2026-10-17T10:00:00Z') => ({ available: status === 'ready', status, checked_at })

test('My agents inventory matches every backend supported by this branch desktop', async () => {
  const source = ts.createSourceFile('types.ts', await fs.readFile('../electron/src/shared/types.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const backend = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Backend')
  assert.ok(backend && ts.isUnionTypeNode(backend.type))
  assert.deepEqual(SETTINGS_AGENTS.map(agent => agent.id).sort(), backend.type.types.map(type => type.literal.text).sort())
})

test('availability uses the newest diagnostic, not backend contract support or a stale ready flag', () => {
  const health = { runtimes: { codex: diagnostic() }, opencode_backend: { available: true } }
  const runtime = { backends: { codex: { available: true, diagnostic: diagnostic('missing', '2026-10-17T11:00:00Z') } } }
  assert.equal(settingsAgentAvailable(health, runtime, 'codex'), false)
  health.runtimes.codex = diagnostic('ready', '2026-10-17T12:00:00Z')
  assert.equal(settingsAgentAvailable(health, runtime, 'codex'), true)
  assert.equal(settingsAgentAvailable(health, null, 'opencode'), false)
  assert.equal(settingsAgentAvailable(null, { backends: { opencode: { available: true } } }, 'opencode'), false)
  assert.equal(settingsAgentAvailable({ capabilities: { opencode_backend: { version: 1, available: true } } }, { backends: { opencode: { available: true, native_credentials_present: false } } }, 'opencode'), true)
  for (const status of ['missing', 'unauthenticated', 'error', 'unknown']) {
    assert.equal(settingsAgentAvailable({ runtimes: { opencode: diagnostic(status) } }, null, 'opencode'), false)
  }
  assert.equal(settingsAgentAvailable(null, null, 'cursor'), false)
})

test('Tailscale row recognizes only configured tailnet hostnames, never an IP or a lookalike', () => {
  assert.equal(tailscaleServerHost('https://DESKTOP.example.ts.net.:7850'), 'desktop.example.ts.net')
  assert.equal(tailscaleServerHost('http://desktop.example.beta.tailscale.net'), 'desktop.example.beta.tailscale.net')
  for (const url of ['http://100.64.0.1:7850', 'http://localhost', 'http://desktop.ts.net.example.com', 'http://desktop.ts.net@localhost', 'file://desktop.ts.net', 'invalid', '']) {
    assert.equal(tailscaleServerHost(url), null, url)
  }
})

async function render(run) {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(MyAgentsSettings)) })
  try { await run(tree) } finally { await act(async () => tree.unmount()) }
}
const recheck = tree => tree.root.findByProps({ testID: 'settings-agents-recheck' })
const available = (tree, id) => tree.root.findByProps({ testID: `settings-agent-${id}` }).findAllByType('CircleCheck').length === 1

test('all agents remain visible; only ready agents on a connected server are green', async () => {
  store.setState({ health: { runtimes: { codex: diagnostic(), claude: diagnostic('missing'), cursor: diagnostic('unauthenticated') } } })
  await render(async tree => {
    assert.equal(tree.root.findAllByType('CircleCheck').length, 1)
    assert.equal(tree.root.findAllByType('Circle').length, 3, 'API-only Gemini never advertises a native login mode')
    assert.equal(available(tree, 'codex'), true)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Persistent goals|Sign-in required|Not installed|Latest run failed/)
    for (const state of [{ connecting: true }, { switchingProfileId: 'next' }, { workspaceAdopting: true }, { connected: false }]) {
      await act(async () => store.setState({ connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false, ...state }))
      assert.equal(tree.root.findAllByType('CircleCheck').length, 0)
      assert.equal(recheck(tree).props.disabled, true)
    }
  })
})

test('Recheck deduplicates taps, shows loading and applies returned statuses without per-agent errors', async () => {
  let calls = 0, finish
  store.setState({ refreshRuntime: () => { calls++; return new Promise(resolve => { finish = resolve }) } })
  await render(async tree => {
    await act(async () => { recheck(tree).props.onPress(); recheck(tree).props.onPress() })
    assert.equal(calls, 1)
    assert.equal(recheck(tree).props.disabled, true)
    assert.equal(tree.root.findAllByType('Spinner').length, 1)
    await act(async () => {
      store.setState({ health: { capabilities: { opencode_backend: { version: 1, available: true } } }, runtime: { backends: { opencode: { available: true, native_credentials_present: false, diagnostic: diagnostic() }, codex: { diagnostic: diagnostic('missing') } } } })
      finish()
    })
    assert.equal(recheck(tree).props.disabled, false)
    assert.equal(available(tree, 'opencode'), true)
    assert.equal(available(tree, 'codex'), false)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Could not check agents|Not installed|Sign-in required/)
  })
})

test('API-only and dual-mode agents show independent native and API status without configuration controls', async () => {
  store.setState({ health: { capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true } } }, runtime: { backends: {
    codex: { native_credentials_present: false, available: true, custom_provider: { configured: true, available: true } },
  } } })
  await render(async tree => {
    const status = mode => tree.root.findAll(node => node.type === 'View' && node.props.testID === `settings-agent-codex-${mode}`)[0]
    assert.equal(status('native').findAllByType('CircleCheck').length, 0)
    assert.equal(status('custom').findAllByType('CircleCheck').length, 1)
    await act(async () => store.setState({ runtime: { backends: { codex: { ...store.getState().runtime.backends.codex, native_credentials_present: true } } } }))
    assert.equal(status('native').findAllByType('CircleCheck').length, 1)
    assert.equal(status('custom').findAllByType('CircleCheck').length, 1)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /api_key|Configure API|Access token/)
  })
})

test('transport failure is a short retry hint, while switching servers discards pending UI state', async () => {
  store.setState({ health: { runtimes: { codex: diagnostic() } }, refreshRuntime: async () => { store.setState({ error: 'transport detail' }) } })
  await render(async tree => {
    await act(async () => recheck(tree).props.onPress())
    assert.equal(available(tree, 'codex'), false)
    assert.match(JSON.stringify(tree.toJSON()), /Could not check agents. Try again./)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /transport detail/)
    let finish
    await act(async () => store.setState({ error: null, refreshRuntime: () => new Promise(resolve => { finish = resolve }) }))
    await act(async () => recheck(tree).props.onPress())
    await act(async () => store.setState({ activeProfileId: 'second', profileGeneration: 2, health: null, runtime: null }))
    assert.equal(recheck(tree).props.disabled, false)
    await act(async () => finish())
    assert.equal(tree.root.findAllByType('CircleCheck').length, 0)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Could not check agents/)
  })
})
