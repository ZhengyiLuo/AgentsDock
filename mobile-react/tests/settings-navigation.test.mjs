import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { create } from 'zustand'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
const fixture = globalThis.__settingsFixture = { platform: 'ios', changes: [], links: [], rejectedLinks: new Set() }
fixture.app = create(set => ({
  fontScale: 1, health: null, runtime: null,
  profiles: [{ id: 'test', name: 'Test server' }], activeProfileId: 'test', serverURL: 'http://localhost:7850', connected: true,
  chatDefaults: { backend: 'claude', model: '', effort: '', folder: 'General', cwd: '' },
  setFontScale: fontScale => set({ fontScale }),
  setChatDefaults: patch => { fixture.changes.push(patch); set(state => ({ chatDefaults: { ...state.chatDefaults, ...patch } })) },
}))
fixture.appearance = create(set => ({ preference: 'system', error: null, setPreference: preference => set({ preference }) }))
fixture.language = create(set => ({ preference: 'system', locale: 'en', error: null, setPreference: preference => set({ preference, locale: preference === 'zh-CN' ? 'zh-CN' : 'en' }) }))
const icons = ['ArrowLeft', 'Calendar', 'Check', 'ChevronDown', 'ChevronRight', 'Clock', 'Copy', 'Download', 'ExternalLink', 'KeyRound', 'Languages', 'MessageSquare', 'Minus', 'Monitor', 'Moon', 'Network', 'Plus', 'RefreshCw', 'Search', 'Server', 'ShieldCheck', 'SquareTerminal', 'Sun', 'SunMoon']
const mocks = {
  'react-native': `export const ActivityIndicator='Spinner',Modal='Modal',Pressable='Button',ScrollView='Scroll',Switch='Switch',View='View'; export const Linking={openURL:async url=>{const f=globalThis.__settingsFixture;f.links.push(url);if(f.rejectedLinks.has(url))throw new Error('Unavailable')}}; export const Platform={get OS(){return globalThis.__settingsFixture.platform}}; export const StyleSheet={create:x=>x,hairlineWidth:1}; export const useWindowDimensions=()=>({width:402,height:874}); export const useColorScheme=()=> 'light';`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeArea';`,
  '@expo/ui/community/datetime-picker': `export const DateTimePicker='DateTimePicker';`,
  'expo-clipboard': `export const setStringAsync=async()=>{};`,
  'lucide-react-native': icons.map(name => `export const ${name}='${name}';`).join(''),
  '../store/useAppStore': `export const useAppStore=globalThis.__settingsFixture.app; export const client={};`,
  '../store/useAppearanceStore': `export const useAppearanceStore=globalThis.__settingsFixture.appearance;`,
  '../store/useLanguageStore': `export const useLanguageStore=globalThis.__settingsFixture.language;`,
  '../i18n': `export const t=(value,params)=>params?value.replace(/\\{(\\w+)\\}/g,(_,key)=>String(params[key]??'{'+key+'}')):value;`,
  './store/useAppearanceStore': `export const useAppearanceStore=globalThis.__settingsFixture.appearance;`,
  '../lib/analytics': `export const trackEvent=()=>{};`,
  '../lib/app-keyboard': `export const dismissAppKeyboard=()=>{};`,
  './AppText': `export const Text='Text',TextInput='Input';`,
  './BackendMark': `export const BackendMark='BackendMark';`,
  './ui': `export const IconButton='IconButton',SheetCloseButton='SheetCloseButton';`,
  './MyAgentsSettings': `export const MyAgentsSettings='MyAgentsSettings';`,
  './AndroidUpdater': `export const AndroidUpdateSettings='AndroidUpdateSettings';`,
  './AnalyticsSettings': `export const AnalyticsSettings='AnalyticsSettings';`,
}
const outfile = path.resolve('build/tmp', `settings-navigation-${process.pid}.mjs`)
await fs.mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export {SettingsDialog} from './src/components/Dialogs'; export {AgentPicker} from './src/components/AgentPicker'`, resolveDir: process.cwd() },
  outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'settings-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => fs.unlink(outfile))
const { SettingsDialog, AgentPicker } = await import(pathToFileURL(outfile).href)
const byId = (tree, id) => tree.root.findByProps({ testID: id })
const press = (tree, id) => act(async () => tree.root.findAll(node => node.props.testID === id && typeof node.props.onPress === 'function')[0].props.onPress())

for (const platform of ['ios', 'android']) test(`${platform} agent picker keeps logos, concise labels and selection through repeated opens`, async () => {
  fixture.platform = platform
  const choices = ['claude', 'claude-custom', 'codex', 'codex-custom', 'cursor', 'cursor-custom', 'opencode', 'opencode-custom', 'gemini-custom']
  const changes = []
  let tree, reloads = 0
  const props = { value: 'claude', choices, label: 'Choose agent', testID: 'agent-picker', onChange: value => changes.push(value), onReload: () => { reloads++ }, children: 'Agent' }
  await act(async () => { tree = TestRenderer.create(React.createElement(AgentPicker, props)) })
  try {
    for (let round = 0; round < 10; round++) {
      for (const choice of choices) {
        await press(tree, 'agent-picker')
        assert.equal(tree.root.findByType('Modal').props.visible, true)
        const row = tree.root.findAll(node => node.type === 'Button' && node.props.testID === `agent-choice-${choice}`)[0]
        assert.equal(row.findByType('BackendMark').props.backend, choice.replace('-custom', ''))
        assert.doesNotMatch(row.props.accessibilityLabel, /Native/)
        assert.equal(row.props.accessibilityLabel.includes('Custom API'), choice.endsWith('-custom'))
        await act(async () => row.props.onPress())
        assert.equal(tree.root.findByType('Modal').props.visible, false)
        if (platform === 'ios') await act(async () => tree.root.findByType('Modal').props.onDismiss())
        assert.equal(changes.at(-1), choice)
        await act(async () => tree.update(React.createElement(AgentPicker, { ...props, value: choice })))
        assert.equal(tree.root.findAll(node => node.type === 'Button' && node.props.testID === `agent-choice-${choice}`)[0].props.accessibilityState.selected, true)
      }
    }
    assert.equal(changes.length, choices.length * 10)
    await press(tree, 'agent-picker')
    await act(async () => tree.root.findByType('Modal').props.onRequestClose())
    await act(async () => tree.root.findByType('Modal').props.onDismiss())
    assert.equal(changes.length, choices.length * 10, 'dismissal must not choose an agent')
    await press(tree, 'agent-picker')
    await press(tree, 'agent-reload')
    if (platform === 'ios') {
      assert.equal(reloads, 0, 'reload waits until the modal can no longer obstruct alerts')
      await act(async () => tree.root.findByType('Modal').props.onDismiss())
    }
    assert.equal(reloads, 1)
    await act(async () => tree.root.findByType('Modal').props.onDismiss())
    assert.equal(reloads, 1, 'a repeated dismissal cannot dispatch twice')
  } finally { await act(async () => tree.unmount()); fixture.platform = 'ios' }
})

test('settings starts with categories, preserves every section and omits duplicate connection fields', async () => {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(SettingsDialog, { visible: true, onClose() {} })) })
  try {
    assert.ok(byId(tree, 'settings-categories'))
    assert.ok(byId(tree, 'settings-build'))
    assert.equal(tree.root.findAllByType('Input').length, 0)
    assert.equal(tree.root.findAllByType('RuntimeHealthPanel').length, 0)
    await press(tree, 'settings-open-updates')
    assert.ok(byId(tree, 'ios-update-settings'))
    await press(tree, 'ios-update-app-store')
    assert.equal(fixture.links.at(-1), 'https://apps.apple.com/app/id6769275751')
    await press(tree, 'ios-update-testflight')
    assert.equal(fixture.links.at(-1), 'itms-beta://')
    await press(tree, 'settings-back')
    await press(tree, 'settings-open-appearance')
    await press(tree, 'settings-theme-dark')
    assert.equal(fixture.appearance.getState().preference, 'dark')
    assert.equal(byId(tree, 'settings-theme-dark').props.accessibilityState.selected, true)
    await act(async () => tree.root.findByProps({ label: 'Increase app text size' }).props.onPress())
    assert.equal(fixture.app.getState().fontScale, 1.1)
    await press(tree, 'settings-back')
    await press(tree, 'settings-open-language')
    await press(tree, 'settings-language-zh-CN')
    assert.equal(fixture.language.getState().preference, 'zh-CN')
    assert.equal(byId(tree, 'settings-language-zh-CN').props.accessibilityState.checked, true)
    await press(tree, 'settings-language-en')
    assert.equal(fixture.language.getState().preference, 'en')
    await press(tree, 'settings-back')
    await press(tree, 'settings-open-chats')
    assert.ok(byId(tree, 'settings-default-model'))
    await act(async () => byId(tree, 'settings-default-folder').props.onChangeText(' Drafts '))
    await press(tree, 'settings-back')
    assert.equal(fixture.app.getState().chatDefaults.folder, 'Drafts')
    await press(tree, 'settings-open-agents')
    assert.ok(tree.root.findByType('MyAgentsSettings'))
    assert.equal(tree.root.findAllByType('CodexServerSettings').length, 0)
    await press(tree, 'settings-back')
    const privacy = tree.root.findAll(node => node.type === 'Button' && node.props.testID === 'settings-open-privacy')[0]
    assert.equal(privacy.props.accessibilityRole, 'link')
    assert.equal(privacy.findAllByType('ExternalLink').length, 1)
    assert.equal(privacy.findAllByType('ChevronRight').length, 0)
    await press(tree, 'settings-open-privacy')
    assert.equal(fixture.links.at(-1), 'https://agentsdock.net/privacy.html')
    assert.ok(byId(tree, 'settings-categories'))
    assert.equal(tree.root.findAllByType('AnalyticsSettings').length, 0)
    assert.equal(tree.root.findAllByProps({ testID: 'settings-open-analytics' }).length, 0)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /settings-server-url|settings-access-token|settings-apply/)
  } finally { await act(async () => tree.unmount()) }
})

test('iOS update links fall back when TestFlight is absent and remain retryable on failure', async () => {
  let tree
  fixture.platform = 'ios'
  fixture.rejectedLinks.add('itms-beta://')
  await act(async () => { tree = TestRenderer.create(React.createElement(SettingsDialog, { visible: true, onClose() {} })) })
  try {
    await press(tree, 'settings-open-updates')
    await press(tree, 'ios-update-testflight')
    assert.equal(fixture.links.at(-1), 'https://apps.apple.com/app/id899247664')
    fixture.rejectedLinks.add('https://apps.apple.com/app/id6769275751')
    await press(tree, 'ios-update-app-store')
    assert.match(JSON.stringify(tree.toJSON()), /Could not open the store. Try again./)
    fixture.rejectedLinks.clear()
    await press(tree, 'ios-update-app-store')
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Could not open the store. Try again./)
  } finally { fixture.rejectedLinks.clear(); await act(async () => tree.unmount()) }
})

test('back stays in the sheet, close dismisses it, and reopening returns to categories', async () => {
  let tree, closed = 0
  const props = { visible: true, onClose: () => { closed++ } }
  await act(async () => { tree = TestRenderer.create(React.createElement(SettingsDialog, props)) })
  try {
    await press(tree, 'settings-open-appearance')
    await press(tree, 'settings-back')
    assert.equal(closed, 0)
    await press(tree, 'settings-open-appearance')
    await press(tree, 'sheet-close-appearance')
    assert.equal(closed, 1)
    await act(async () => tree.update(React.createElement(SettingsDialog, { ...props, visible: false })))
    await act(async () => tree.update(React.createElement(SettingsDialog, props)))
    assert.ok(byId(tree, 'settings-categories'))
  } finally { await act(async () => tree.unmount()) }
})

test('Android retains updates and hardware back returns to the category list', async () => {
  fixture.platform = 'android'
  let tree, closed = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(SettingsDialog, { visible: true, onClose: () => { closed++ } })) })
  try {
    await press(tree, 'settings-open-updates')
    assert.ok(tree.root.findByType('AndroidUpdateSettings'))
    await act(async () => tree.root.findByType('Modal').props.onRequestClose())
    assert.ok(byId(tree, 'settings-categories'))
    assert.equal(closed, 0)
    await press(tree, 'settings-open-analytics')
    assert.equal(tree.root.findByType('AnalyticsSettings').props.visible, true)
    await press(tree, 'settings-back')
    await press(tree, 'settings-open-privacy')
    assert.ok(byId(tree, 'settings-categories'))
    await act(async () => tree.root.findByType('Modal').props.onRequestClose())
    assert.equal(closed, 1)
  } finally { await act(async () => tree.unmount()); fixture.platform = 'ios' }
})

test('Server requests the drawer handoff, and Tailscale is only a connected server hostname', async () => {
  let tree, opened = 0, dismissed = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(SettingsDialog, {
    visible: true, onClose() {}, onOpenServers: () => { opened++ }, onDidDismiss: () => { dismissed++ },
  })) })
  try {
    await press(tree, 'settings-open-servers')
    assert.equal(opened, 1)
    assert.ok(byId(tree, 'settings-categories'))
    assert.equal(dismissed, 0)
    await act(async () => tree.root.findByType('Modal').props.onDismiss())
    assert.equal(dismissed, 1)
    assert.equal(tree.root.findAllByProps({ testID: 'settings-tailscale-server' }).length, 0)
    await act(async () => fixture.app.setState({ serverURL: 'http://test.example.ts.net:7850' }))
    assert.ok(byId(tree, 'settings-tailscale-server'))
    await act(async () => fixture.app.setState({ connected: false }))
    assert.equal(tree.root.findAllByProps({ testID: 'settings-tailscale-server' }).length, 0)
  } finally {
    await act(async () => tree.unmount())
    fixture.app.setState({ serverURL: 'http://localhost:7850', connected: true })
  }
})
