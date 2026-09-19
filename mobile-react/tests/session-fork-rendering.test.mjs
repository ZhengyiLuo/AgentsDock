import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { create } from 'zustand'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const require = createRequire(import.meta.url)
const store = create(() => ({}))
const fixture = { store, client: { isValidated: true, validationRevision: 1 }, platform: { OS: 'ios' }, forks: [], sheets: [] }
globalThis.__sessionForkFixture = fixture
const icons = ['Archive', 'Bot', 'Check', 'ChevronDown', 'ChevronRight', 'Copy', 'FileText', 'FolderOpen', 'FolderPlus', 'GitFork', 'MoreHorizontal', 'Network', 'Pause', 'Pencil', 'Pin', 'Play', 'Plus', 'RefreshCw', 'Search', 'Server', 'Settings', 'Square', 'SquareTerminal', 'Trash2', 'X']
const mocks = {
  'react-native': `import { createElement } from 'react';
    export const View='View',Text='Text',TextInput='TextInput',ScrollView='ScrollView',ActivityIndicator='ActivityIndicator',Image='Image';
    export const Pressable=props=>createElement('Pressable',props,typeof props.children==='function'?props.children({pressed:false}):props.children);
    export const Modal=({visible=true,...props})=>visible?createElement('Modal',props):null;
    export const FlatList=({data,renderItem})=>createElement('FlatList',null,data.map((item,index)=>createElement('Row',{key:item.key},renderItem({item,index}))));
    export const StyleSheet={create:x=>x,hairlineWidth:1,absoluteFill:{}};
    export const Platform=globalThis.__sessionForkFixture.platform;
    export const AccessibilityInfo={announceForAccessibility(){}};
    export const Alert={alert(){}};
    export const ActionSheetIOS={showActionSheetWithOptions:(options,callback)=>globalThis.__sessionForkFixture.sheets.push({options,callback})};`,
  'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:0,bottom:0});`,
  '@expo/ui/community/menu': `export const MenuView='MenuView';`,
  'lucide-react-native': icons.map(name => `export const ${name}='${name}';`).join(''),
  'expo-clipboard': `export async function setStringAsync(){}`,
  '../theme': `export const usePalette=()=>({});`,
  '../store/useAppStore': `export const useAppStore=globalThis.__sessionForkFixture.store;export const client=globalThis.__sessionForkFixture.client;`,
  '../lib/app-keyboard': `export function dismissAppKeyboard(){}`,
  './AppText': `export const Text='Text',TextInput='TextInput';`,
  './MediaGrid': `export const MediaGrid=()=>null;`,
  './BackendMark': `export const BackendMark=()=>null;`,
  './ServerProfiles': `export const ServerProfileSelector=()=>null;`,
  './TextPromptDialog': `export const useTextPrompt=()=>({promptText:async()=>null,textPromptDialog:null});`,
  './file-viewer/FileViewerContext': `export const useFileViewer=()=>({openArtifacts(){}});`,
  './WorkingDirectoryPicker': `export const WorkingDirectoryPicker=()=>null;export const workingDirectoryConnected=()=>true;export const workingDirectoryScopeKey=()=> 'scope';`,
  './ui': `import {createElement} from 'react';export const SectionHeader=({title,trailing})=>createElement('View',null,createElement('Text',null,title),trailing);export const IconButton=props=>createElement('Pressable',{...props,accessibilityLabel:props.label});`,
}
const outfile = path.join(tmpdir(), `agentsdock-session-fork-rendering-${process.pid}.mjs`)
await build({
  stdin: { contents: `export {Inspector} from './src/components/Inspector';export {Sidebar} from './src/components/Sidebar';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'fork-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fork-mock' }
      : !args.path.startsWith('.') && !path.isAbsolute(args.path) ? { path: require.resolve(args.path), external: true } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fork-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__sessionForkFixture })
const { Inspector, Sidebar } = await import(pathToFileURL(outfile).href)
const source = { id: 'source', title: 'Running source', folder: 'General', backend: 'codex' }
const health = () => ({ ok: true, capabilities: { session_fork_completed_prefix_v1: { available: true, version: 1, supported_backends: ['codex', 'claude'] } } })
function reset(patch = {}) {
  fixture.forks = []; fixture.sheets = []; fixture.platform.OS = 'ios'
  store.setState({
    activeProfileId: 'profile', profileGeneration: 1, selectedSessionId: source.id,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    serverConfigured: true, serverURL: 'https://example.invalid', health: health(), sessions: [source],
    snapshots: { [source.id]: { events: [], files: [], queuedTurns: [] } },
    activeSessionIds: new Set([source.id]), stoppingSessionIds: new Set(), sendingSessionIds: new Set(),
    pendingQueuedRunIds: new Set(), pendingJobRunIds: new Set(), turnAdmissionTokens: {},
    filePaging: {}, runtime: null, pins: [], jobs: [], folderOrder: [], collapsedFolders: [], searchResults: [],
    searchBusy: false, searchError: null, search() {}, clearSearch() {}, refreshJobs: async () => {}, refreshFiles: async () => {},
    forkSession: async (...args) => { fixture.forks.push(args) },
    ...patch,
  }, true)
}
async function render(component) {
  let tree
  const props = component === Inspector
    ? { sessionId: source.id, onDigest() {}, onJob() {}, onTerminal() {}, onProcesses() {}, onTmux() {} }
    : { profiles: [], activeProfileId: 'profile', onSwitchServer() {}, onAddServer() {}, onManageServers() {}, onSettings() {}, onTeamNetwork() {}, onNewChat() {} }
  await act(async () => { tree = TestRenderer.create(React.createElement(component, props)) })
  return tree
}
const unmount = tree => act(async () => tree.unmount())
const byID = (tree, id) => tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const forkButton = tree => byID(tree, 'inspector-fork-chat')
const forkAction = tree => tree.root.findAllByType('MenuView').flatMap(node => node.props.actions).flatMap(action => action.subactions ?? [action]).find(action => action.id === 'fork')

test('Inspector allows supported live/admitting/stopping forks and explains completed-turn semantics', async () => {
  for (const backend of ['codex', 'claude']) {
    for (const busy of [
      { activeSessionIds: new Set([source.id]) },
      { stoppingSessionIds: new Set([source.id]) },
      { sendingSessionIds: new Set([source.id]) },
      { turnAdmissionTokens: { [source.id]: 'admission' } },
      { snapshots: { [source.id]: { events: [], files: [], queuedTurns: [{ queued_id: 'queued' }] } }, pendingQueuedRunIds: new Set(['queued']) },
    ]) {
      reset({ sessions: [{ ...source, backend }], activeSessionIds: new Set(), ...busy })
      const tree = await render(Inspector)
      try {
        assert.equal(forkButton(tree).props.disabled, false)
        assert.match(forkButton(tree).props.accessibilityHint, /last completed turn; the source chat keeps running/)
        await act(async () => forkButton(tree).props.onPress())
        assert.deepEqual(fixture.forks, [[source.id, 1]])
      } finally { await unmount(tree) }
    }
  }
})

test('Inspector blocks unsupported live forks, preserves idle fallback and tracks displayed backend', async () => {
  for (const patch of [
    { health: { ok: true } }, { health: { ...health(), ok: false } }, { connected: false },
    { sessions: [{ ...source, backend: 'cursor' }] },
  ]) {
    reset(patch)
    const tree = await render(Inspector)
    try {
      assert.equal(forkButton(tree).props.disabled, true)
      await act(async () => forkButton(tree).props.onPress())
      assert.deepEqual(fixture.forks, [])
    } finally { await unmount(tree) }
  }
  reset({ health: { ok: true }, activeSessionIds: new Set() })
  const tree = await render(Inspector)
  try {
    assert.equal(forkButton(tree).props.disabled, false)
    await act(async () => store.setState({ activeSessionIds: new Set([source.id]) }))
    assert.equal(forkButton(tree).props.disabled, true)
    await act(async () => store.setState({ health: health() }))
    assert.equal(forkButton(tree).props.disabled, false)
    const stale = forkButton(tree).props.onPress
    await act(async () => store.setState({ profileGeneration: 2 }))
    await act(async () => stale())
    assert.deepEqual(fixture.forks, [], 'old-profile callbacks cannot fork on a new profile')
  } finally { await unmount(tree) }
})

test('iOS sidebar exposes supported live forks and disables older-server live forks', async () => {
  for (const supported of [true, false]) {
    reset({ health: supported ? health() : { ok: true } })
    const tree = await render(Sidebar)
    try {
      await act(async () => byID(tree, `chat-row-${source.id}`).props.onLongPress())
      const sheet = fixture.sheets.at(-1)
      const forkIndex = sheet.options.options.indexOf('Fork Chat')
      assert.equal(sheet.options.disabledButtonIndices.includes(forkIndex), !supported)
      assert.match(sheet.options.message, supported ? /source chat keeps running/ : /Update AgentsServer/)
      if (supported) {
        await act(async () => sheet.callback(forkIndex))
        assert.deepEqual(fixture.forks, [[source.id, 1]])
      }
    } finally { await unmount(tree) }
  }
})

test('Android sidebar updates Fork availability for capability and source-backend changes', async () => {
  reset(); fixture.platform.OS = 'android'
  const tree = await render(Sidebar)
  try {
    assert.equal(forkAction(tree).attributes.disabled, false)
    const menu = tree.root.findAllByType('MenuView').find(node => node.props.actions.some(action => action.id === 'primary-actions'))
    await act(async () => menu.props.onPressAction({ nativeEvent: { event: 'fork' } }))
    assert.deepEqual(fixture.forks, [[source.id, 1]])
    await act(async () => store.setState({ health: { ok: true } }))
    assert.equal(forkAction(tree).attributes.disabled, true)
    await act(async () => store.setState({ activeSessionIds: new Set() }))
    assert.equal(forkAction(tree).attributes.disabled, false, 'idle forks remain available on older servers')
    await act(async () => store.setState({ health: health(), activeSessionIds: new Set([source.id]), sessions: [{ ...source, backend: 'cursor' }] }))
    assert.equal(forkAction(tree).attributes.disabled, true)
  } finally { await unmount(tree) }
})
