import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ts from 'typescript'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = {
  'react-native': `export const ActivityIndicator='Spinner',Modal='Modal',Pressable='Button',ScrollView='Scroll',Switch='Switch',View='View'; export const Alert={alert(...args){globalThis.__serverAlert=args}}; export const Platform={OS:'ios'}; export const StyleSheet={create:x=>x,hairlineWidth:1};`,
  '@expo/ui/community/menu': `export const MenuView='Menu';`,
  'react-native-screens': `export const ScreenStack='ScreenStack',ScreenStackItem='ScreenStackItem';`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeArea';`,
  'react-native-svg': `export default 'Svg'; export const Circle='Circle',Text='SvgText';`,
  'lucide-react-native': `export const ArrowLeft='ArrowLeft',Check='Check',ChevronDown='ChevronDown',MoreHorizontal='MoreHorizontal',Pencil='Pencil',Plus='Plus',ScanLine='ScanLine',Server='Server',Wifi='Wifi',X='X';`,
  './ServerQrScanner': `export const ServerQrScanner='Scanner';`,
  '../lib/app-keyboard': `export const dismissAppKeyboard=()=>{};`,
  '../i18n': `export const t=(value,params)=>params?value.replace(/\\{(\\w+)\\}/g,(_,key)=>String(params[key]??'{'+key+'}')):value;`,
  '../theme': `export const radius={sm:6,md:8,round:999}; export const spacing={xs:4,sm:8,md:12,lg:16,xl:24}; export const typography={caption:{fontSize:12,lineHeight:16}}; export const fontWeight={regular:'400',medium:'500',semibold:'600',bold:'700'}; export const usePalette=()=>({text:'#111',muted:'#666',border:'#ccc',controlBorder:'#ddd',controlSurface:'#fff',onAccent:'#fff',background:'#fff',surface:'#fff',raised:'#eee',blue:'#28f',green:'#080',orange:'#f80'});`,
  './AppText': `export const Text='Text',TextInput='Input';`,
  './ui': `export const IconButton='IconButton',SheetCloseButton='SheetCloseButton';`,
}
const outfile = path.resolve('build/tmp', `server-manual-connection-${process.pid}.mjs`)
await fs.mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/components/ServerProfiles.tsx'], outfile, bundle: true, format: 'esm',
  platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => fs.unlink(outfile))
const { ServerProfilesManager, ServerProfileSelector, ServerProfilesSheet } = await import(pathToFileURL(outfile).href)
const button = (tree, label) => tree.root.findAllByType('Button').find(node => node.props.accessibilityLabel === label)
const input = (tree, id) => tree.root.findByProps({ testID: id })
const profile = { id: 'saved', name: 'Saved server', serverUrl: 'http://127.0.0.1:7850',
  serverIdentity: 'saved-identity', hasAccessToken: true, serverSetupComplete: true,
  connectionState: 'online', cachedUnreadCount: 0 }
const noActions = { onSwitchProfile: async () => true, onTestConnection: async () => ({ ok: true, server_identity: 'test-identity' }),
  onCreateProfile: async () => 'created', onUpdateProfile: async () => {}, onRemoveProfile: async () => {} }

test('server sheet exposes half/full native detents, dismisses and resets the editor on reopen', async () => {
  let tree, closed = 0
  const props = { profiles: [profile], activeProfileId: profile.id, ...noActions, onClose: () => { closed++ } }
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesSheet, { ...props, visible: false })) })
  try {
    assert.equal(tree.root.findAllByProps({ screenId: 'servers-drawer' }).length, 0)
    assert.equal(tree.root.findByType('ScreenStack').parent.props.pointerEvents, 'none')
    await act(async () => tree.update(React.createElement(ServerProfilesSheet, { ...props, visible: true })))
    const sheet = tree.root.findByProps({ screenId: 'servers-drawer' })
    assert.deepEqual(sheet.props.sheetAllowedDetents, [0.5, 1])
    assert.equal(sheet.props.sheetInitialDetentIndex, 0)
    assert.equal(sheet.props.stackPresentation, 'formSheet')
    assert.equal(sheet.props.sheetGrabberVisible, true)
    assert.equal(tree.root.findByType('ScreenStack').parent.props.pointerEvents, 'box-none')
    await act(async () => button(tree, 'Add server').props.onPress())
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    assert.deepEqual(sheet.props.sheetAllowedDetents, [1], 'camera and guidance must fit without dragging the half sheet')
    await act(async () => input(tree, 'server-editor-back').props.onPress())
    assert.deepEqual(sheet.props.sheetAllowedDetents, [0.5, 1])
    await act(async () => input(tree, 'server-profile-name').props.onChangeText('Unsaved'))
    await act(async () => sheet.props.onDismissed())
    assert.equal(closed, 1)
    await act(async () => tree.update(React.createElement(ServerProfilesSheet, { ...props, visible: false })))
    assert.equal(tree.root.findAllByProps({ screenId: 'servers-drawer' }).length, 0)
    assert.ok(tree.root.findByProps({ screenId: 'servers-anchor' }))
    await act(async () => tree.update(React.createElement(ServerProfilesSheet, { ...props, visible: true })))
    assert.equal(tree.root.findByProps({ screenId: 'servers-drawer' }).props.sheetInitialDetentIndex, 0)
    assert.ok(input(tree, 'server-profile-list'))
    await act(async () => button(tree, 'Add server').props.onPress())
    assert.equal(tree.root.findAllByType('Input').length, 3)
    assert.equal(input(tree, 'server-profile-name').props.value, '')
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => input(tree, 'server-management-close').props.onPress())
    assert.equal(closed, 2)
    await act(async () => tree.update(React.createElement(ServerProfilesSheet, { ...props, visible: false })))
    await act(async () => tree.update(React.createElement(ServerProfilesSheet, { ...props, visible: true })))
    assert.deepEqual(tree.root.findByProps({ screenId: 'servers-drawer' }).props.sheetAllowedDetents, [0.5, 1])
    assert.equal(tree.root.findAllByType('Scanner').length, 0)
  } finally { await act(async () => tree.unmount()) }
})

test('manual controls remain available and only add exposes the camera entry', async () => {
  for (const initialMode of ['manage', 'add', 'edit-active']) {
    let tree
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, initialMode, ...noActions,
    })) })
    try {
      assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Scan connection QR|Choose QR image|Allow camera|Connect and save|CameraView/)
      assert.equal(Boolean(button(tree, 'Add server')), initialMode === 'manage')
      assert.equal(Boolean(button(tree, 'Scan QR code')), initialMode === 'add')
      assert.equal(tree.root.findAllByType('Scanner').length, 0, 'opening the form must not request camera access')
      assert.equal(button(tree, 'Enter manually'), undefined)
      if (initialMode === 'add') {
        assert.equal(tree.root.findAllByType('Input').length, 3, 'all manual steps are available immediately')
        assert.equal(button(tree, 'Add').props.disabled, true)
        assert.ok(tree.root.findAllByType('Text').some(node => node.props.children === 'or add manually'))
        assert.equal(tree.root.findAllByProps({ testID: 'server-manual-entry' }).length, 0)
      }
      if (initialMode !== 'manage') {
        assert.ok(input(tree, 'server-profile-url'))
        assert.equal(input(tree, 'server-profile-token').props.secureTextEntry, true)
        assert.ok(button(tree, 'Test connection'))
        assert.equal(button(tree, 'Cancel'), undefined)
        assert.equal(button(tree, 'Add & switch'), undefined)
        assert.ok(button(tree, initialMode === 'add' ? 'Add' : 'Save'))
      }
    } finally { await act(async () => tree.unmount()) }
  }
})

test('server title opens directly without a native popup menu', async () => {
  let tree, opened = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfileSelector, {
    profiles: [profile], activeProfileId: profile.id, onPress: () => { opened++ }, refreshing: true,
  })) })
  try {
    assert.equal(tree.root.findAllByType('Menu').length, 0)
    const trigger = tree.root.findByType('Button')
    assert.equal(trigger.props.disabled, false)
    assert.equal(trigger.props.accessibilityState.busy, true)
    await act(async () => trigger.props.onPress())
    assert.equal(opened, 1)
  } finally { await act(async () => tree.unmount()) }
})

test('connection fields draw each numbered circle in a fixed SVG viewport without native rounded borders', async () => {
  for (const initialMode of ['add', 'edit-active']) {
    let tree
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, initialMode, ...noActions,
    })) })
    try {
      assert.deepEqual([1, 2, 3].map(step => input(tree, `server-profile-step-${step}`).props.accessibilityLabel), [
        '1. Name (optional)', '2. Server URL', '3. Access token',
      ])
      for (const step of [1, 2, 3]) {
        const heading = input(tree, `server-profile-step-${step}`)
        const badge = heading.findByType('Svg')
        const style = badge.props.style
        assert.equal(badge.props.width, 24)
        assert.equal(badge.props.height, 24)
        assert.equal(badge.props.viewBox, '0 0 24 24')
        assert.equal(badge.props.preserveAspectRatio, 'xMidYMid meet')
        assert.equal(style.width, 24)
        assert.equal(style.height, 24)
        assert.equal(style.flexGrow, 0)
        assert.equal(style.flexShrink, 0)
        assert.equal(style.borderWidth, undefined)
        assert.equal(style.borderRadius, undefined)
        const circle = badge.findByType('Circle')
        assert.equal(circle.props.cx, 12)
        assert.equal(circle.props.cy, 12)
        assert.equal(circle.props.r, 11.5)
        assert.equal(circle.props.strokeWidth, 1)
        assert.equal(circle.props.fillOpacity, 0.06)
        const number = badge.findByType('SvgText')
        assert.equal(number.props.children, step)
        assert.equal(number.props.fontSize, 12)
        assert.equal(number.props.textAnchor, 'middle')
      }
      assert.equal(input(tree, 'server-profile-name').props.accessibilityLabel, 'Server name (optional)')
      assert.equal(input(tree, 'server-profile-token').props.secureTextEntry, true)
    } finally { await act(async () => tree.unmount()) }
  }
})

test('server overflow allows removing the active server after confirmation', async () => {
  let tree, removed = []
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [profile, { ...profile, id: 'other' }], activeProfileId: profile.id, ...noActions,
    onRemoveProfile: async id => { removed.push(id) },
  })) })
  try {
    const menus = tree.root.findAllByType('Menu')
    for (const menu of menus) {
      assert.deepEqual(menu.props.actions.map(({ id, title }) => [id, title]), [['edit', 'Edit'], ['remove', 'Remove']])
    }
    assert.equal(menus[0].props.actions[1].attributes.disabled, false)
    assert.equal(menus[0].props.actions[1].attributes.destructive, true)
    assert.equal(menus[1].props.actions[1].attributes.disabled, false)
    assert.equal(menus[1].props.actions[1].attributes.destructive, true)
    await act(async () => menus[0].props.onPressAction({ nativeEvent: { event: 'remove' } }))
    assert.match(globalThis.__serverAlert[1], /will not stop/)
    assert.deepEqual(removed, [], 'opening or canceling confirmation must not remove anything')
    assert.equal(globalThis.__serverAlert[2][0].style, 'cancel')
    await act(async () => globalThis.__serverAlert[2].find(action => action.style === 'destructive').onPress())
    assert.deepEqual(removed, [profile.id])
    await act(async () => tree.update(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, ...noActions,
      onRemoveProfile: async id => { removed.push(id) },
    })))
    await act(async () => tree.root.findByType('Menu').props.onPressAction({ nativeEvent: { event: 'remove' } }))
    await act(async () => globalThis.__serverAlert[2].find(action => action.style === 'destructive').onPress())
    assert.deepEqual(removed, [profile.id, profile.id], 'the last server must also be removable')
  } finally { delete globalThis.__serverAlert; await act(async () => tree.unmount()) }
})

for (const initialMode of ['add', 'edit-active']) {
  test(`${initialMode} uses one header with separate back and drawer-close actions`, async () => {
    let tree, closed = 0
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, initialMode, ...noActions,
      onClose: () => { closed++ },
    })) })
    try {
      assert.equal(input(tree, 'server-management-title').props.children, initialMode === 'add' ? 'Add server' : 'Edit server')
      assert.equal(tree.root.findAllByType('SheetCloseButton').length, 1)
      assert.equal(tree.root.findAllByProps({ label: 'Close server editor' }).length, 0)
      await act(async () => input(tree, 'server-editor-back').props.onPress())
      assert.equal(closed, 0)
      assert.ok(input(tree, 'server-profile-list'))
      assert.equal(input(tree, 'server-management-title').props.children, 'Servers')
      assert.equal(tree.root.findAllByProps({ testID: 'server-editor-back' }).length, 0)
      await act(async () => button(tree, 'Add server').props.onPress())
      await act(async () => input(tree, 'server-management-close').props.onPress())
      assert.equal(closed, 1)
    } finally { await act(async () => tree.unmount()) }
  })
}

for (const outcome of ['success', 'failed', 'dismissed']) {
  test(`server row ${outcome} only closes the current drawer after successful switching`, async () => {
    let tree, finish, closed = 0
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: 'other', ...noActions,
      onSwitchProfile: () => new Promise(resolve => { finish = resolve }),
      onSelected: () => { closed++ },
    })) })
    await act(async () => button(tree, 'Use Saved server').props.onPress())
    assert.equal(closed, 0)
    assert.equal(button(tree, 'Use Saved server').props.disabled, true)
    if (outcome === 'dismissed') await act(async () => tree.unmount())
    await act(async () => finish(outcome !== 'failed'))
    assert.equal(closed, outcome === 'success' ? 1 : 0)
    if (outcome === 'failed') {
      assert.match(JSON.stringify(tree.toJSON()), /was not activated/)
      assert.equal(button(tree, 'Use Saved server').props.disabled, false)
    }
    if (outcome !== 'dismissed') await act(async () => tree.unmount())
  })
}

test('current server closes the drawer without reconnecting; add and edit replace the list', async () => {
  let tree, closed = 0, switched = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [profile], activeProfileId: profile.id, ...noActions,
    onSwitchProfile: () => { switched++; return true }, onSelected: () => { closed++ },
  })) })
  try {
    await act(async () => button(tree, 'Use Saved server').props.onPress())
    assert.equal(closed, 1)
    assert.equal(switched, 0)
    await act(async () => button(tree, 'Add server').props.onPress())
    assert.equal(tree.root.findAllByProps({ testID: 'server-profile-list' }).length, 0)
    assert.ok(input(tree, 'server-profile-url'))
    await act(async () => input(tree, 'server-editor-back').props.onPress())
    const menu = tree.root.findByType('Menu')
    await act(async () => menu.props.onPressAction({ nativeEvent: { event: 'edit' } }))
    assert.equal(input(tree, 'server-profile-url').props.value, profile.serverUrl)
    assert.equal(tree.root.findAllByProps({ testID: 'server-profile-list' }).length, 0)
  } finally { await act(async () => tree.unmount()) }
})

test('manual add still authenticates the typed connection before saving and switching', async () => {
  let tree
  const calls = []
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async value => { calls.push(['test', value]); return { ok: true, server_identity: 'test-identity' } },
    onCreateProfile: async value => { calls.push(['create', value]); return 'created' },
    onSwitchProfile: async id => { calls.push(['switch', id]); return true },
  })) })
  try {
    assert.equal(button(tree, 'Add').props.disabled, true)
    await act(async () => input(tree, 'server-profile-url').props.onChangeText('http://127.0.0.1:7866'))
    await act(async () => input(tree, 'server-profile-token').props.onChangeText('synthetic-test-token'))
    assert.deepEqual(calls, [], 'typing must not probe or save a server')
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.equal(button(tree, 'Add').props.disabled, false)
    await act(async () => button(tree, 'Add').props.onPress())
    assert.deepEqual(calls.map(([action]) => action), ['test', 'create', 'switch'])
    assert.equal(calls[0][1].serverUrl, 'http://127.0.0.1:7866')
    assert.equal(calls[0][1].accessToken, 'synthetic-test-token')
    assert.equal(calls[1][1].serverIdentity, 'test-identity')
    assert.equal(Object.hasOwn(calls[1][1], 'name'), false, 'a blank optional name is omitted when creating the server')
    assert.equal(calls[2][1], 'created')
  } finally { await act(async () => tree.unmount()) }
})

test('changing the connection invalidates its test; a rejected test cannot save', async () => {
  let tree, reject = false, saved = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async () => { if (reject) throw new Error('Connection rejected'); return { ok: true, server_identity: 'test-identity' } },
    onCreateProfile: async () => { saved++; return 'created' },
  })) })
  try {
    await act(async () => input(tree, 'server-profile-url').props.onChangeText('http://127.0.0.1:7866'))
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.equal(button(tree, 'Add').props.disabled, false)
    await act(async () => input(tree, 'server-profile-token').props.onChangeText('changed-token'))
    assert.equal(button(tree, 'Add').props.disabled, true)
    reject = true
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.match(JSON.stringify(tree.toJSON()), /Connection rejected/)
    assert.equal(button(tree, 'Add').props.disabled, true)
    assert.equal(saved, 0)
  } finally { await act(async () => tree.unmount()) }
})

test('QR scanning registers camera only, without microphone, image import or connection deep links', async () => {
  const app = JSON.parse(await fs.readFile('app.json', 'utf8')).expo
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  assert.ok(pkg.dependencies['expo-camera'])
  const camera = app.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-camera')[1]
  assert.match(camera.cameraPermission, /scan.*QR/)
  assert.equal(camera.microphonePermission, false)
  assert.equal(camera.recordAudioAndroid, false)
  assert.equal(app.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1].cameraPermission, camera.cameraPermission)
  assert.equal(app.scheme, 'com.zhengyiluo.ZenithDock')
  const shell = await fs.readFile('src/components/AppShell.tsx', 'utf8')
  assert.doesNotMatch(shell, /pairing|agentsdock:\\?\//i)
  assert.ok(shell.includes("openInspectorAction('terminal')"), 'existing terminal links remain handled')
  assert.doesNotMatch(await fs.readFile('src/components/Dialogs.tsx', 'utf8'), /Scan a QR|agentsdock pair/)
  for (const file of ['src/components/ServerPairing.tsx', 'src/lib/server-pairing.ts']) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' })
  }
})

test('discarded connection links cannot open a terminal through their embedded payload', async () => {
  const source = ts.createSourceFile('AppShell.tsx', await fs.readFile('src/components/AppShell.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'openDeepLink') handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler)
  const js = ts.transpileModule(`const onURL = ${handler.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const calls = []
  const onURL = new Function('openInspectorAction', `${js}; return onURL`)(kind => calls.push(kind))
  for (const url of ['agentsdock://connect#url=http://terminal', 'com.zhengyiluo.ZenithDock://connect#url=http://terminal', 'https://example.com/?next=com.zhengyiluo.ZenithDock://terminal']) onURL({ url })
  assert.deepEqual(calls, [])
  onURL({ url: 'com.zhengyiluo.ZenithDock://terminal?session=fixture' })
  assert.deepEqual(calls, ['terminal'])
})

for (const outcome of ['match', 'mismatch', 'unreachable', 'dismissed']) {
  test(`scanned server ${outcome} verifies before saving and never overwrites another profile`, async () => {
    let tree, finish
    const calls = []
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, initialMode: 'add', ...noActions,
      onTestConnection: value => { calls.push(['test', value]); return new Promise(resolve => { finish = resolve }) },
      onCreateProfile: async value => { calls.push(['create', value]); return 'scanned' },
      onUpdateProfile: async () => { throw new Error('Must not overwrite an existing profile') },
      onSwitchProfile: async id => { calls.push(['switch', id]); return true },
    })) })
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    assert.equal(tree.root.findAllByProps({ testID: 'server-profile-editor' }).length, 0)
    await act(async () => tree.root.findByType('Scanner').props.onScanned({
      name: 'Scanned server', serverUrl: 'http://192.168.1.2:7852', accessToken: 'qr-fixture-token', serverIdentity: 'qr-identity',
    }))
    assert.equal(tree.root.findAllByType('Input').length, 0)
    assert.deepEqual(input(tree, 'server-scanned-summary').findAllByType('Text').map(node => node.props.children), ['Scanned server', 'http://192.168.1.2:7852'])
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /qr-fixture-token/)
    assert.equal(button(tree, 'Edit details').props.disabled, true)
    assert.equal(button(tree, 'Add').props.disabled, true)
    assert.deepEqual(calls.map(([action]) => action), ['test'])
    if (outcome === 'dismissed') await act(async () => tree.unmount())
    await act(async () => finish({ ok: outcome !== 'unreachable', server_identity: outcome === 'mismatch' ? 'other-server' : 'qr-identity' }))
    if (outcome === 'match') {
      assert.equal(button(tree, 'Add').props.disabled, false)
      await act(async () => button(tree, 'Add').props.onPress())
      assert.deepEqual(calls.map(([action]) => action), ['test', 'create', 'switch'])
      assert.equal(calls[1][1].serverIdentity, 'qr-identity')
    } else {
      assert.deepEqual(calls.map(([action]) => action), ['test'])
      if (outcome !== 'dismissed') assert.equal(button(tree, 'Add').props.disabled, true)
      if (outcome === 'mismatch') assert.match(JSON.stringify(tree.toJSON()), /does not match the scanned QR/)
    }
    if (outcome !== 'dismissed') await act(async () => tree.unmount())
  })
}

test('multi-address QR selects a reachable identity match and saves all addresses', async () => {
  let tree, created
  const urls = ['http://100.64.0.2:7852', 'http://192.168.1.2:7852']
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async input => {
      if (input.serverUrl === urls[0]) throw new Error('unreachable')
      return { ok: true, server_identity: 'qr-identity' }
    },
    onCreateProfile: async input => { created = input; return 'created' },
  })) })
  try {
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => tree.root.findByType('Scanner').props.onScanned({ name: 'QR', serverUrl: urls[0], serverUrls: urls, accessToken: 'fixture', serverIdentity: 'qr-identity' }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)) })
    assert.equal(button(tree, 'Add').props.disabled, false)
    assert.equal(input(tree, 'server-scanned-summary').findAllByType('Text')[1].props.children, urls[1])
    await act(async () => button(tree, 'Add').props.onPress())
    assert.equal(created.serverUrl, urls[1])
    assert.deepEqual(created.serverUrls, urls)
  } finally { await act(async () => tree.unmount()) }
})

test('rescanning a saved identity adopts QR addresses only after explicit Use and preserves its token', async () => {
  let tree
  const updates = []
  const urls = ['http://192.168.1.2:7852', 'http://100.64.0.2:7852']
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [profile], activeProfileId: profile.id, initialMode: 'add', ...noActions,
    onTestConnection: async () => ({ ok: true, server_identity: profile.serverIdentity }),
    onUpdateProfile: async (...args) => { updates.push(args) },
  })) })
  try {
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => tree.root.findByType('Scanner').props.onScanned({ name: 'QR', serverUrl: urls[0], serverUrls: urls, accessToken: 'different-token', serverIdentity: profile.serverIdentity }))
    assert.deepEqual(updates, [])
    await act(async () => button(tree, `Use ${profile.name}`).props.onPress())
    assert.deepEqual(updates, [[profile.id, { serverUrl: urls[0], serverUrls: urls, serverIdentity: profile.serverIdentity }]])
  } finally { await act(async () => tree.unmount()) }
})

test('canceling the scanner preserves the manual draft without testing or saving', async () => {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: () => { throw new Error('Must not probe on cancel') },
  })) })
  try {
    await act(async () => input(tree, 'server-profile-name').props.onChangeText('Unfinished'))
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => input(tree, 'server-editor-back').props.onPress())
    assert.equal(input(tree, 'server-profile-name').props.value, 'Unfinished')
    assert.equal(button(tree, 'Add').props.disabled, true)
  } finally { await act(async () => tree.unmount()) }
})

test('scanning a saved identity switches to that profile without changing its credentials', async () => {
  let tree
  const switched = []
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [profile], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async () => ({ ok: true, server_identity: profile.serverIdentity }),
    onCreateProfile: async () => { throw new Error('Do not duplicate a saved identity') },
    onUpdateProfile: async () => { throw new Error('Do not change saved credentials') },
    onSwitchProfile: async id => { switched.push(id); return true },
  })) })
  try {
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => tree.root.findByType('Scanner').props.onScanned({
      name: 'Different label', serverUrl: 'http://192.168.1.2:7852', accessToken: 'different-fixture-token', serverIdentity: profile.serverIdentity,
    }))
    assert.deepEqual(switched, [])
    await act(async () => button(tree, `Use ${profile.name}`).props.onPress())
    assert.deepEqual(switched, [profile.id])
  } finally { await act(async () => tree.unmount()) }
})

test('editing a scanned address invalidates success and retains the expected QR identity', async () => {
  let tree, identity = 'qr-id'
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async () => ({ ok: true, server_identity: identity }),
  })) })
  try {
    await act(async () => button(tree, 'Scan QR code').props.onPress())
    await act(async () => tree.root.findByType('Scanner').props.onScanned({
      name: 'QR', serverUrl: 'http://192.168.1.2:7852', accessToken: 'fixture-token', serverIdentity: identity,
    }))
    assert.equal(button(tree, 'Add').props.disabled, false)
    await act(async () => button(tree, 'Edit details').props.onPress())
    assert.equal(input(tree, 'server-profile-token').props.value, 'fixture-token')
    assert.equal(input(tree, 'server-profile-token').props.secureTextEntry, true)
    identity = 'unexpected-server'
    await act(async () => input(tree, 'server-profile-url').props.onChangeText('http://192.168.1.3:7852'))
    assert.equal(button(tree, 'Add').props.disabled, true)
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.equal(button(tree, 'Add').props.disabled, true)
    assert.match(JSON.stringify(tree.toJSON()), /does not match the scanned QR/)
  } finally { await act(async () => tree.unmount()) }
})
