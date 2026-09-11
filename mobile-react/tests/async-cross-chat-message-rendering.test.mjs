import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const require = createRequire(import.meta.url)
const listeners = new Set()
const calls = []
const client = { validationRevision: 1 }
const fixture = {
  state: null, theme: 'dark', client, links: [],
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
}
globalThis.__asyncChatMessageFixture = fixture
const mocks = {
  'react-native': `import { createElement } from 'react';
    export const View='View', Text='Text', ActivityIndicator='ActivityIndicator', ScrollView='ScrollView', Image='Image', TouchableWithoutFeedback='TouchableWithoutFeedback';
    export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({ pressed: false }) : props.children);
    export const StyleSheet = { create: value => value, absoluteFill: {}, hairlineWidth: 0.5, flatten: value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean)) };
    export const Platform = { OS: 'ios', select: values => values.ios ?? values.default };
    export const Linking = { openURL: async url => { globalThis.__asyncChatMessageFixture.links.push(url); } };
    export const useColorScheme = () => globalThis.__asyncChatMessageFixture.theme;
    export const AccessibilityInfo = { announceForAccessibility() {} };`,
  '@shopify/flash-list': `import { useEffect, useState } from 'react'; export function useRecyclingState(initial, deps) { const [value, setValue] = useState(initial); useEffect(() => setValue(initial), deps); return [value, setValue]; }`,
  'lucide-react-native': `export const AlertTriangle='AlertTriangle', Check='Check', ChevronDown='ChevronDown', ChevronRight='ChevronRight', Clock3='Clock3', Code2='Code2', Copy='Copy', History='History', Pin='Pin', Siren='Siren', Sparkles='Sparkles', Wrench='Wrench', MessageSquareShare='MessageSquareShare', X='X';`,
  'react-native-svg': `export default 'Svg'; export const SvgXml='SvgXml', Defs='Defs', LinearGradient='LinearGradient', Rect='Rect', Stop='Stop';`,
  '@bsky.app/react-native-uitextview': `export const UITextView='SelectableText';`,
  'react-native-fit-image': `export default 'FitImage';`,
  'expo-clipboard': `export async function setStringAsync() {}`,
  'expo-haptics': `export const NotificationFeedbackType = { Success: 'success', Error: 'error' }; export async function notificationAsync() {}`,
  '../store/useAppStore': `import { useSyncExternalStore } from 'react'; const fixture = globalThis.__asyncChatMessageFixture; export const client = fixture.client; export const useAppStore = selector => useSyncExternalStore(fixture.subscribe, () => selector(fixture.state)); useAppStore.getState = () => fixture.state;`,
  '../lib/tex-svg': `export const texToSvg = () => null;`,
  './AppText': `export const Text='Text';`,
  './MediaGrid': `export const MediaGrid='MediaGrid';`,
}
const outfile = path.resolve('build/tmp', `async-cross-chat-rendering-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export { TimelineRowView } from './src/components/TimelineRows'; export { projectTimeline } from './src/lib/timeline'; export { MarkdownContent } from './src/components/MarkdownContent';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', loader: { '.js': 'jsx' }, logLevel: 'silent',
  banner: { js: "import { createRequire as createTestRequire } from 'node:module'; const require = createTestRequire(import.meta.url);" },
  plugins: [{ name: 'async-chat-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => {
      if (args.path === 'react' || args.path.startsWith('react/')) return { path: args.path, external: true }
      if (isBuiltin(args.path)) return { path: args.path, external: true }
      if (mocks[args.path]) return { path: args.path, namespace: 'async-chat-mock' }
      if (args.path === 'react-native-markdown-display') return { path: require.resolve(args.path) }
      if (args.importer.includes('node_modules') && /^[^./]/u.test(args.path) && !args.path.startsWith('node:')) {
        return { path: require.resolve(args.path, { paths: [path.dirname(args.importer)] }) }
      }
      return undefined
    })
    context.onLoad({ filter: /.*/, namespace: 'async-chat-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__asyncChatMessageFixture })
const { TimelineRowView, projectTimeline, MarkdownContent } = await import(pathToFileURL(outfile).href)
const event = (patch = {}) => ({
  id: 'event-a', session_id: 'recipient', seq: 1, ts: '2026-09-10T10:00:00Z',
  type: 'chat_conversation_message_started', conversation_mode: 'async_route_v1',
  conversation_id: 'pair-a', message_id: 'message-a', handoff_id: 'message-a', cross_chat_envelope_id: 'message-a',
  source_session_id: 'sender', target_session_id: 'recipient', source_title: 'Research agent', target_title: 'Mobile agent',
  handoff_preview: 'Review **keyboard** behavior and [details](https://example.com/review).', handoff_status: 'running', handoff_action: 'instruction', ...patch,
})
const handoff = (patch = {}) => ({
  id: 'message-a', kind: 'instruction', action: 'instruction', status: 'running',
  source_session_id: 'sender', source_run_id: 'source-run', target_session_id: 'recipient',
  conversation_mode: 'async_route_v1', conversation_id: 'pair-a', message_id: 'message-a',
  body: 'The **complete** authenticated agent message.', body_chars: 46, body_sha256: 'body-hash',
  created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z', ...patch,
})
function reset() {
  calls.length = 0; fixture.links.length = 0; fixture.theme = 'dark'; client.validationRevision = 1
  fixture.state = {
    activeProfileId: 'profile-a', profileGeneration: 1, selectedSessionId: 'recipient',
    connected: true, connecting: false, health: { ok: true, server_instance_id: 'instance-a' },
    profiles: [{ id: 'profile-a', serverIdentity: 'server-a' }],
    sessions: [{ id: 'sender', title: 'Renamed agent' }, { id: 'recipient', title: 'Renamed mobile' }],
    switchingProfileId: null, workspaceAdopting: false, pins: [], snapshots: {},
  }
  client.crossChatHandoff = async id => { calls.push(['handoff', id]); return handoff() }
  client.crossChatExchange = async () => { throw new Error('Async messages must not load exchanges') }
  client.cancelCrossChatHandoff = async () => { throw new Error('Async messages must not cancel from timeline') }
}
function publish(patch = {}) {
  fixture.state = { ...fixture.state, ...patch }
  for (const listener of listeners) listener()
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const props = (row, width = 390) => ({ row, sessionId: row.event.session_id, layoutWidth: width, fontScale: 1.3, onReview() {} })
const row = value => projectTimeline(Array.isArray(value) ? value : [value], [])[0]
async function render(value = event(), width = 390) {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(TimelineRowView, props(row(value), width))) })
  return renderer
}
const byID = (renderer, id) => renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)
const toggle = (renderer, id = 'message-a') => byID(renderer, `cross-chat-async-message-${id}-toggle`)[0]
const press = async renderer => act(async () => toggle(renderer).props.onPress())
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
const content = renderer => renderer.root.findByType(MarkdownContent).props.value
const visible = renderer => renderer.root.findAll(node => node.type === 'Text' || node.type === 'SelectableText')
  .flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n')
const patchLabel = patch => Object.entries(patch).map(([field, value]) => `${field}=${String(value)}`).join(', ')

for (const session_id of ['recipient', 'sender']) test(`mixed lifecycle keeps the ${session_id} card async after started and delivered, never stale queued`, async () => {
  reset(); publish({ selectedSessionId: session_id })
  const lifecycle = ['received', 'queued', 'started', 'delivered'].map((status, index) => event({
    id: `async-${status}`, seq: index + 1, session_id,
    type: `chat_conversation_message_${status}`, handoff_status: status,
    handoff_preview: `Authenticated ${status} message.`,
  }))
  const legacy = event({ id: 'legacy-queued', seq: 5, session_id, type: 'cross_chat_handoff_queued', conversation_mode: undefined,
    handoff_status: 'queued', handoff_preview: 'Stale legacy queued content', source_title: 'Untrusted compatibility label' })
  const renderer = await render(lifecycle.slice(0, 3))
  try {
    assert.equal(byID(renderer, 'cross-chat-async-message-message-a-surface').length, 1)
    assert.equal(content(renderer), lifecycle[2].handoff_preview)
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row([...lifecycle.slice(0, 3), legacy])))))
    assert.equal(byID(renderer, 'cross-chat-async-message-message-a-surface').length, 1)
    assert.equal(content(renderer), lifecycle[2].handoff_preview)
    assert.doesNotMatch(visible(renderer), /Queued|Stale legacy|Untrusted compatibility/)
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row([...lifecycle, legacy])))))
    assert.equal(byID(renderer, 'cross-chat-async-message-message-a-surface').length, 1)
    assert.equal(content(renderer), lifecycle[3].handoff_preview)
    assert.doesNotMatch(visible(renderer), /Queued|Stale legacy|Untrusted compatibility/)
    assert.equal(byID(renderer, 'cross-chat-handoff-message-a').length, 0, 'no legacy queued card survives row recycling')
    assert.deepEqual(calls, [], 'compatibility metadata cannot trigger a new body lookup')
  } finally { await act(async () => renderer.unmount()) }
})

for (const theme of ['dark', 'light']) for (const width of [320, 834]) test(`${theme} async message uses readable incoming/outgoing surfaces at ${width}px`, async () => {
  reset(); fixture.theme = theme
  const renderer = await render(event(), width)
  try {
    assert.match(visible(renderer), /Research agent/)
    assert.doesNotMatch(visible(renderer), /Renamed agent|Agent conversation|Reply expected|End conversation|Source request|Provider authority/)
    assert.equal(renderer.root.findAllByType('Pressable').length, 0, 'A complete short message has no exchange or routing actions')
    const surface = flatten(byID(renderer, 'cross-chat-async-message-message-a-surface')[0].props.style)
    assert.equal(surface.alignSelf, 'flex-end')
    assert.equal(surface.width, width > 720 ? '82%' : '94%')
    assert.equal(surface.maxWidth, 760)
    assert.equal(surface.minWidth, 0)
    assert.equal(surface.backgroundColor, theme === 'dark' ? '#332444' : '#eee5fb')
    const markdown = renderer.root.findByType(MarkdownContent)
    assert.equal(markdown.props.fontScale, 1.3)
    assert.equal(markdown.props.compact, true)
    assert.ok(renderer.root.findAll(node => node.type === 'SelectableText' && node.props.onPress).length, 'Actual Markdown links must render as selectable native link nodes')
    await act(async () => renderer.root.findAll(node => node.type === 'SelectableText' && node.props.onPress)[0].props.onPress())
    assert.deepEqual(fixture.links, ['https://example.com/review'])
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row(event({ session_id: 'sender', type: 'chat_conversation_message_registered' })), width))))
    assert.match(visible(renderer), /Sent to Mobile agent/)
    assert.equal(flatten(byID(renderer, 'cross-chat-async-message-message-a-surface')[0].props.style).alignSelf, 'flex-start')
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('a message expands exactly once on demand and reuses its authenticated Markdown body', async () => {
  reset()
  const pending = deferred()
  client.crossChatHandoff = async id => { calls.push(['handoff', id]); return pending.promise }
  const renderer = await render(event({ handoff_preview: 'Short preview…', handoff_body_truncated: true, handoff_body_chars: 2000 }))
  try {
    assert.deepEqual(calls, [])
    assert.ok(flatten(toggle(renderer).props.style({ pressed: false })).minHeight >= 44)
    await act(async () => { const onPress = toggle(renderer).props.onPress; onPress(); onPress() })
    assert.deepEqual(calls, [['handoff', 'message-a']])
    assert.equal(toggle(renderer).props.disabled, true)
    await act(async () => pending.resolve(handoff({ body: 'The **complete** message and [full details](https://example.com/full).' })))
    assert.match(content(renderer), /complete/)
    const link = renderer.root.findAll(node => node.type === 'SelectableText' && node.props.onPress)[0]
    await act(async () => link.props.onPress())
    assert.deepEqual(fixture.links, ['https://example.com/full'])
    await press(renderer)
    assert.equal(content(renderer), 'Short preview…')
    await press(renderer)
    assert.match(content(renderer), /complete/)
    assert.equal(calls.length, 1)
  } finally { await act(async () => renderer.unmount()) }
})

for (const patch of [
  { id: 'other' }, { message_id: 'other' }, { message_id: undefined },
  { conversation_id: 'other' }, { conversation_id: undefined }, { conversation_mode: undefined },
  { source_session_id: 'other' }, { target_session_id: 'other' },
]) test(`full message rejects mismatched authenticated identity ${patchLabel(patch)}`, async () => {
  reset(); client.crossChatHandoff = async () => handoff(patch)
  const renderer = await render(event({ handoff_body_truncated: true }))
  try {
    await press(renderer)
    assert.ok(renderer.root.findAll(node => node.props.accessibilityRole === 'alert').length)
    assert.doesNotMatch(content(renderer), /complete/)
    assert.equal(toggle(renderer).props.disabled, false)
  } finally { await act(async () => renderer.unmount()) }
})

for (const patch of [{ conversation_id: undefined }, { source_session_id: undefined }, { target_session_id: 'other' }]) test(`missing local participant metadata cannot trigger detail lookup ${patchLabel(patch)}`, async () => {
  reset()
  const renderer = await render(event({ handoff_body_truncated: true, ...patch }))
  try {
    await press(renderer)
    assert.deepEqual(calls, [])
    assert.match(visible(renderer), /missing its conversation or participant identity/)
  } finally { await act(async () => renderer.unmount()) }
})

for (const change of ['profile', 'chat', 'validation', 'server instance', 'reconnect', 'workspace adoption']) test(`${change} transition fences stale detail and clears its loading state`, async () => {
  reset()
  const pending = deferred()
  client.crossChatHandoff = async () => pending.promise
  const original = event({ handoff_body_truncated: true })
  const renderer = await render(original)
  try {
    await press(renderer)
    await act(async () => {
      if (change === 'profile') publish({ activeProfileId: 'profile-b', profileGeneration: 2 })
      if (change === 'chat') publish({ selectedSessionId: 'different-chat' })
      if (change === 'validation') { client.validationRevision += 1; publish() }
      if (change === 'server instance') publish({ health: { ...fixture.state.health, server_instance_id: 'instance-b' } })
      if (change === 'reconnect') publish({ connecting: true })
      if (change === 'workspace adoption') publish({ workspaceAdopting: true })
    })
    await act(async () => pending.resolve(handoff({ body: 'STALE_BODY' })))
    assert.doesNotMatch(content(renderer), /STALE_BODY/)
    assert.equal(toggle(renderer).props.disabled, false)
  } finally { await act(async () => renderer.unmount()) }
})

test('same-profile reconnect permits a fresh read and old failures cannot overwrite success', async () => {
  reset()
  const old = deferred(), fresh = deferred()
  let count = 0
  client.crossChatHandoff = async () => (++count === 1 ? old.promise : fresh.promise)
  const renderer = await render(event({ handoff_body_truncated: true }))
  try {
    await press(renderer)
    await act(async () => { client.validationRevision += 1; publish() })
    await press(renderer)
    await act(async () => fresh.resolve(handoff({ body: 'Fresh authenticated body' })))
    await act(async () => old.reject(new Error('Stale failure')))
    assert.equal(content(renderer), 'Fresh authenticated body')
    assert.doesNotMatch(visible(renderer), /Stale failure/)
    assert.equal(count, 2)
  } finally { await act(async () => renderer.unmount()) }
})

test('detail error keeps preview visible and the same control retries', async () => {
  reset(); let attempts = 0
  client.crossChatHandoff = async () => { if (++attempts === 1) throw new Error('Network unavailable'); return handoff() }
  const renderer = await render(event({ handoff_body_truncated: true }))
  try {
    await press(renderer)
    assert.match(visible(renderer), /Network unavailable/)
    assert.equal(content(renderer), event().handoff_preview)
    await press(renderer)
    assert.doesNotMatch(visible(renderer), /Network unavailable/)
    assert.match(content(renderer), /complete/)
    assert.equal(attempts, 2)
  } finally { await act(async () => renderer.unmount()) }
})

test('long complete messages fold locally without extra requests and remeasure on width changes', async () => {
  reset()
  const value = '😀'.repeat(641) + '\n\n**Final line**'
  const original = event({ handoff_preview: value, handoff_body_chars: value.length })
  const renderer = await render(original, 320)
  try {
    assert.equal(content(renderer), '😀'.repeat(640) + '…', 'Character folding must preserve Unicode pairs')
    await press(renderer)
    assert.equal(content(renderer), value)
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row(original), 834))))
    assert.equal(content(renderer), value, 'Rotation must preserve full-message expansion')
    assert.equal(flatten(byID(renderer, 'cross-chat-async-message-message-a-surface')[0].props.style).width, '82%')
    await press(renderer)
    assert.equal(content(renderer), '😀'.repeat(640) + '…')
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('delivery status updates retain loaded body and use the original admission time', async () => {
  reset()
  const initial = event({ handoff_body_truncated: true })
  const renderer = await render(initial)
  try {
    await press(renderer)
    const terminal = { ...initial, id: 'event-b', seq: 2, ts: '2026-09-10T11:00:00Z', type: 'chat_conversation_message_failed', handoff_status: 'failed', message: 'Recipient could not complete this message' }
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row([initial, terminal])))))
    assert.match(content(renderer), /complete/)
    assert.match(visible(renderer), /Recipient could not complete/)
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(initial.ts))
    assert.ok(visible(renderer).includes(time))
    const cancelled = { ...terminal, type: 'chat_conversation_message_cancelled', handoff_status: 'cancelled', message: undefined }
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row([initial, cancelled])))))
    assert.match(visible(renderer), /Cancelled/)
    assert.doesNotMatch(visible(renderer), /Recipient could not complete/)
    assert.equal(calls.length, 1)
  } finally { await act(async () => renderer.unmount()) }
})

test('recycled message identity clears expanded content and pending responses cannot populate its replacement', async () => {
  reset()
  const pending = deferred(); client.crossChatHandoff = async () => pending.promise
  const renderer = await render(event({ handoff_body_truncated: true }))
  try {
    await press(renderer)
    const next = event({ message_id: 'message-b', handoff_id: 'message-b', cross_chat_envelope_id: 'message-b', handoff_preview: 'The next independent message.' })
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row(next)))))
    await act(async () => pending.resolve(handoff({ body: 'Previous private body' })))
    assert.equal(content(renderer), 'The next independent message.')
    assert.equal(byID(renderer, 'cross-chat-async-message-message-a').length, 0)
    assert.equal(toggle(renderer, 'message-b'), undefined)
  } finally { await act(async () => renderer.unmount()) }
})

test('message body and sender labels cannot create chat routes or reply controls', async () => {
  reset()
  const marker = '@Research agent'
  const renderer = await render(event({
    source_title: '@Different chat', handoff_preview: `Ask ${marker} to review this.`,
    chat_references: [{ session_id: 'different-chat', display_title_snapshot: 'Research agent', source_text_start: 4, source_text_end: 4 + marker.length, action: 'route', grant_intent: true }],
  }))
  try {
    assert.match(visible(renderer), /@Different chat/)
    assert.match(visible(renderer), /@Research agent/)
    assert.equal(renderer.root.findAll(node => node.type === 'SelectableText' && node.props.onPress).length, 0)
    assert.equal(renderer.root.findAllByType('Pressable').length, 0)
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('body omitted from lifecycle loads on demand and malformed timestamps stay hidden', async () => {
  reset()
  const renderer = await render(event({ handoff_preview: '', handoff_body_chars: 500, ts: 'invalid' }))
  try {
    assert.match(visible(renderer), /Message body available on demand/)
    assert.doesNotMatch(visible(renderer), /Invalid Date/)
    assert.equal(renderer.root.findAllByType(MarkdownContent).length, 0)
    await press(renderer)
    assert.match(content(renderer), /complete/)
    assert.deepEqual(calls, [['handoff', 'message-a']])
  } finally { await act(async () => renderer.unmount()) }
})

test('short multiline messages use the same ten-line folding boundary as Mac', async () => {
  reset()
  const lines = Array.from({ length: 11 }, (_, index) => `Line ${index + 1}`)
  const renderer = await render(event({ handoff_preview: lines.join('\n') }))
  try {
    assert.equal(content(renderer), lines.slice(0, 10).join('\n') + '…')
    await press(renderer)
    assert.equal(content(renderer), lines.join('\n'))
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

for (const body of [undefined, null, '', '   ']) test(`malformed or empty full body keeps the preview and offers retry (${String(body)})`, async () => {
  reset(); client.crossChatHandoff = async () => handoff({ body })
  const renderer = await render(event({ handoff_body_truncated: true }))
  try {
    await press(renderer)
    assert.equal(content(renderer), event().handoff_preview)
    assert.match(visible(renderer), /did not return a message body/)
    assert.equal(toggle(renderer).props.accessibilityLabel, 'View message')
  } finally { await act(async () => renderer.unmount()) }
})

const legacyEvent = patch => event({ type: 'cross_chat_handoff_queued', conversation_mode: undefined, handoff_status: 'queued', ...patch })
const pressID = async (renderer, id) => act(async () => byID(renderer, id)[0].props.onPress())
for (const status of ['running', 'delivered']) test(`legacy cancel shows returned ${status} state without claiming cancellation`, async () => {
  reset(); publish({ selectedSessionId: 'sender' })
  client.cancelCrossChatHandoff = async () => handoff({ status })
  const renderer = await render(legacyEvent({ session_id: 'sender' }))
  try {
    await pressID(renderer, 'cross-chat-handoff-message-a')
    await pressID(renderer, 'cross-chat-cancel-handoff-message-a')
    assert.match(visible(renderer), /cancellation was not confirmed/)
    assert.ok(visible(renderer).toLowerCase().includes(status))
    assert.doesNotMatch(visible(renderer), /· Cancelled ·/)
    assert.equal(byID(renderer, 'cross-chat-cancel-handoff-message-a').length, 0)
  } finally { await act(async () => renderer.unmount()) }
})

test('legacy handoff detail rejects changed participants before rendering their body', async () => {
  reset(); client.crossChatHandoff = async () => handoff({ source_session_id: 'unexpected-peer', body: 'Wrong participant body' })
  const renderer = await render(legacyEvent({ handoff_body_truncated: true }))
  try {
    await pressID(renderer, 'cross-chat-handoff-message-a')
    assert.match(visible(renderer), /different handoff participants/)
    assert.doesNotMatch(visible(renderer), /Wrong participant body/)
  } finally { await act(async () => renderer.unmount()) }
})

test('legacy cancellation rejects changed participant identities', async () => {
  reset(); publish({ selectedSessionId: 'sender' })
  client.cancelCrossChatHandoff = async () => handoff({ target_session_id: 'unexpected-peer', status: 'cancelled' })
  const renderer = await render(legacyEvent({ session_id: 'sender' }))
  try {
    await pressID(renderer, 'cross-chat-handoff-message-a')
    await pressID(renderer, 'cross-chat-cancel-handoff-message-a')
    assert.match(visible(renderer), /different handoff participants/)
    assert.doesNotMatch(visible(renderer), /· Cancelled ·/)
    assert.equal(byID(renderer, 'cross-chat-cancel-handoff-message-a').length, 1)
  } finally { await act(async () => renderer.unmount()) }
})

test('a late legacy cancel receipt cannot overwrite a newer delivered lifecycle event', async () => {
  reset(); publish({ selectedSessionId: 'sender' })
  const pending = deferred(); client.cancelCrossChatHandoff = async () => pending.promise
  const initial = legacyEvent({ session_id: 'sender' })
  const renderer = await render(initial)
  try {
    await pressID(renderer, 'cross-chat-handoff-message-a')
    await pressID(renderer, 'cross-chat-cancel-handoff-message-a')
    const delivered = { ...initial, id: 'event-b', seq: 2, type: 'cross_chat_handoff_delivered', handoff_status: 'delivered' }
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(row([initial, delivered])))))
    await act(async () => pending.resolve(handoff({ status: 'cancelled' })))
    assert.match(visible(renderer), /Delivered/)
    assert.doesNotMatch(visible(renderer), /· Cancelled ·/)
  } finally { await act(async () => renderer.unmount()) }
})

test('a confirmed legacy cancellation updates the card and removes its cancel action', async () => {
  reset(); publish({ selectedSessionId: 'sender' })
  client.cancelCrossChatHandoff = async () => handoff({ status: 'cancelled' })
  const renderer = await render(legacyEvent({ session_id: 'sender' }))
  try {
    await pressID(renderer, 'cross-chat-handoff-message-a')
    await pressID(renderer, 'cross-chat-cancel-handoff-message-a')
    assert.match(visible(renderer), /Cancelled/)
    assert.doesNotMatch(visible(renderer), /not confirmed/)
    assert.equal(byID(renderer, 'cross-chat-cancel-handoff-message-a').length, 0)
  } finally { await act(async () => renderer.unmount()) }
})
