import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const calls = []
const fixture = { theme: 'dark', copied: '', state: {
  activeProfileId: 'profile', profileGeneration: 1, pins: [], sessions: [], snapshots: {},
  selectedSessionId: 'chat', pinMessage: () => calls.push('pin'), removePin: () => calls.push('unpin'),
} }
globalThis.__importedDeliveryFixture = fixture
fixture.client = new Proxy({}, { get: (_, method) => (...args) => {
  calls.push([method, args]); throw new Error(`Unexpected imported-delivery API: ${String(method)}`)
} })
const mocks = {
  'react-native': `import { createElement } from 'react';
    export const View = 'View', ActivityIndicator = 'ActivityIndicator', ScrollView = 'ScrollView';
    export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({ pressed: false }) : props.children);
    export const StyleSheet = { create: value => value, absoluteFill: {}, hairlineWidth: 0.5, flatten: value => Array.isArray(value) ? Object.assign({}, ...value.flat(Infinity)) : value };
    export const useColorScheme = () => globalThis.__importedDeliveryFixture.theme;
    export const AccessibilityInfo = { announceForAccessibility() {} };`,
  '@shopify/flash-list': `import { useEffect, useState } from 'react'; export function useRecyclingState(initial, deps) { const [value, setValue] = useState(initial); useEffect(() => setValue(initial), deps); return [value, setValue]; }`,
  'lucide-react-native': `export const AlertTriangle='AlertTriangle', Check='Check', ChevronDown='ChevronDown', ChevronRight='ChevronRight', Clock3='Clock3', Code2='Code2', Copy='Copy', History='History', Pin='Pin', Siren='Siren', Sparkles='Sparkles', Wrench='Wrench', MessageSquareShare='MessageSquareShare', X='X';`,
  'react-native-svg': `export default 'Svg'; export const Defs='Defs', LinearGradient='LinearGradient', Rect='Rect', Stop='Stop';`,
  'expo-clipboard': `export async function setStringAsync(value) { globalThis.__importedDeliveryFixture.copied = value; }`,
  'expo-haptics': `export const NotificationFeedbackType = { Success: 'success', Error: 'error' }; export async function notificationAsync() {}`,
  '../store/useAppStore': `const fixture = globalThis.__importedDeliveryFixture; export const client = fixture.client; export const useAppStore = selector => selector(fixture.state); useAppStore.getState = () => fixture.state;`,
  './AppText': `export const Text = 'Text';`,
  './MarkdownContent': `import { createElement } from 'react'; export const MarkdownContent = props => createElement('MarkdownContent', props);`,
  './MediaGrid': `import { createElement } from 'react'; export const MediaGrid = props => createElement('MediaGrid', props);`,
}
const outfile = path.resolve('build/tmp', `imported-delivery-tests-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  stdin: { contents: `export { TimelineRowView } from './src/components/TimelineRows'; export { projectTimeline } from './src/lib/timeline'; export { sanitizeTimelineEvent } from './src/lib/timeline-memory'; export { CROSS_CHAT_CONVERSATION_DARK, CROSS_CHAT_CONVERSATION_LIGHT } from './src/components/CrossChatTimelineCards';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent',
  plugins: [{ name: 'imported-delivery-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true }
      : mocks[args.path] ? { path: args.path, namespace: 'delivery-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'delivery-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__importedDeliveryFixture })
const { TimelineRowView, projectTimeline, sanitizeTimelineEvent, CROSS_CHAT_CONVERSATION_DARK, CROSS_CHAT_CONVERSATION_LIGHT } = await import(pathToFileURL(outfile).href)

const body = 'Received; these **native-goal findings** are recorded.\n\n- Fixed rendering\n- Kept `code` and [details](https://example.com)'
const source = 'Please review the mobile renderer.'
function envelope({ kind = 'reply', message = body, request = source } = {}) {
  const label = kind === 'status' ? 'Server-generated exchange status' : 'Agent-prepared reply/result'
  return `[AgentsDock delivery kind=${kind} leg=${kind === 'status' ? 0 : 2}/2 origin=route from=AgentsDock Sept]\n[Source user instruction — verbatim, user-authored]\n${request}\n[End source user instruction]\n[${label}]\n${message}\n[End ${label.toLowerCase()}]\nreply: use the respond command in the provider-authority block only if a reply or follow-up is needed.\n[End delivery]`
}
function event(patch = {}) {
  return { id: 'delivery-1', seq: 1, ts: '2026-09-09T12:00:00Z', session_id: 'chat', type: 'turn_started', imported: true, backend: 'codex', run_id: 'import_history', prompt: envelope(), ...patch }
}
function rows(events, files = []) { return projectTimeline(events.map(sanitizeTimelineEvent), files) }
const props = row => ({ row, sessionId: 'chat', onReview: () => calls.push('review'), fontScale: 1.4, layoutWidth: 320 })
async function render(row) {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(TimelineRowView, props(row))) })
  return renderer
}
const byID = (renderer, id) => renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)
const press = async (renderer, id) => act(async () => byID(renderer, id)[0].props.onPress())
const visible = renderer => renderer.root.findAll(node => node.type === 'Text' || node.type === 'MarkdownContent')
  .map(node => node.type === 'MarkdownContent' ? node.props.value : node.children.filter(child => typeof child === 'string').join('')).join('\n')
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))

for (const backend of ['codex', 'claude']) for (const theme of ['dark', 'light']) test(`${backend} screenshot-shaped delivery uses ${theme} purple card with no user bubble or wire text`, async () => {
  fixture.theme = theme; calls.length = 0
  const renderer = await render(rows([event({ backend })])[0])
  try {
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1').length, 1)
    assert.doesNotMatch(visible(renderer), /Agent conversation/)
    assert.match(visible(renderer), /AgentsDock Sept/)
    assert.doesNotMatch(visible(renderer), /^You$|\[AgentsDock delivery|\[Source user instruction|provider-authority|\[End delivery\]/m)
    assert.ok(!visible(renderer).includes(source), 'Source is not mounted until explicitly disclosed')
    const markdown = renderer.root.findByType('MarkdownContent')
    assert.equal(markdown.props.value, body)
    assert.equal(markdown.props.compact, true)
    assert.equal(markdown.props.fontScale, 1.4)
    assert.equal(markdown.props.color, theme === 'dark' ? '#f4f4f5' : '#18191b')
    assert.equal(renderer.root.findAllByType('LinearGradient').length, 0)
    const surface = flatten(byID(renderer, 'imported-cross-chat-delivery-1-surface')[0].props.style)
    assert.equal(surface.alignSelf, 'flex-end')
    assert.equal(surface.backgroundColor, theme === 'dark' ? '#332444' : '#eee5fb')
    assert.equal(surface.borderColor, theme === 'dark' ? '#685080' : '#bca5dc')
    const buttons = renderer.root.findAllByType('Pressable')
    assert.equal(buttons.length, 1, 'Historical sender is not a navigation/reply/cancel action')
    assert.equal(buttons[0].props.accessibilityLabel, 'Show source request')
    assert.ok(flatten(buttons[0].props.style({ pressed: false })).minHeight >= 44)
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('Source request opens and closes and resets when FlashList recycles another delivery', async () => {
  const renderer = await render(rows([event()])[0])
  try {
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1-source').length, 1)
    assert.ok(visible(renderer).includes(source))
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1-source-toggle')[0].props.accessibilityState.expanded, true)
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1-source').length, 0)
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    const next = rows([event({ id: 'delivery-2', prompt: envelope({ request: 'Different private source.' }) })])[0]
    await act(async () => renderer.update(React.createElement(TimelineRowView, props(next))))
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-2-source').length, 0)
    assert.ok(!visible(renderer).includes('Different private source.'))
  } finally { await act(async () => renderer.unmount()) }
})

test('long body and source have working Show more/less and bounded first render', async () => {
  const message = ('**Long body** and `code`.\n\n').repeat(250)
  const request = 'Long source paragraph.\n\n'.repeat(250)
  const renderer = await render(rows([event({ prompt: envelope({ message, request }) })])[0])
  try {
    assert.ok(renderer.root.findByType('MarkdownContent').props.value.length <= 641)
    await press(renderer, 'imported-cross-chat-delivery-1-body-toggle')
    assert.equal(renderer.root.findByType('MarkdownContent').props.value, message.trim())
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1-body-toggle')[0].props.accessibilityLabel, 'Show less of message')
    await press(renderer, 'imported-cross-chat-delivery-1-body-toggle')
    assert.ok(renderer.root.findByType('MarkdownContent').props.value.length <= 641)
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    await press(renderer, 'imported-cross-chat-delivery-1-source-body-toggle')
    assert.equal(renderer.root.findAllByType('MarkdownContent')[1].props.value, request.trim())
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    assert.ok(renderer.root.findAllByType('MarkdownContent')[1].props.value.length < 3500)
  } finally { await act(async () => renderer.unmount()) }
})

test('zero-leg status is a neutral status row with no source disclosure or message actions', async () => {
  calls.length = 0
  const renderer = await render(rows([event({ prompt: envelope({ kind: 'status', message: '**Completed.**' }), ts: 'invalid' })])[0])
  try {
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1-status').length, 1)
    assert.match(visible(renderer), /Status update/)
    assert.doesNotMatch(visible(renderer), /Agent conversation|Source request|Invalid Date|^You$/m)
    assert.equal(renderer.root.findAllByType('LinearGradient').length, 0)
    assert.equal(renderer.root.findAllByType('Pressable').length, 0)
    assert.equal(renderer.root.findByType('MarkdownContent').props.value, '**Completed.**')
    assert.deepEqual(calls, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('attachment appears once, and the assistant answer remains a separate rendered message', async () => {
  const file = { id: 'image-1', filename: 'chart.png', content_type: 'image/png', seq: 1 }
  const projected = rows([event({ file_ids: [file.id] }), event({ id: 'answer', seq: 2, type: 'assistant_text', prompt: undefined, text: 'My following answer.' })], [file])
  assert.deepEqual(projected.map(row => row.kind), ['system', 'media', 'message'])
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(React.Fragment, null, projected.map(row => React.createElement(TimelineRowView, { key: row.key, ...props(row) })))) })
  try {
    assert.deepEqual(renderer.root.findByType('MediaGrid').props.files, [file])
    assert.equal(renderer.root.findAllByType('MediaGrid').length, 1)
    assert.match(visible(renderer), /My following answer\./)
    assert.match(visible(renderer), /Assistant/)
    assert.doesNotMatch(visible(renderer), /^You$/m)
  } finally { await act(async () => renderer.unmount()) }
})

test('ordinary user-authored envelope stays a user message and copy retains literal content', async () => {
  const prompt = envelope()
  const renderer = await render(rows([event({ imported: false, run_id: 'user_turn', prompt })])[0])
  try {
    assert.equal(byID(renderer, 'imported-cross-chat-delivery-1').length, 0)
    assert.match(visible(renderer), /^You$/m)
    assert.ok(visible(renderer).includes(prompt))
    const copy = renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel?.startsWith('Copy'))
    assert.ok(copy)
    await act(async () => copy.props.onPress())
    assert.equal(fixture.copied, prompt)
  } finally { await act(async () => renderer.unmount()) }
})

test('large imported source survives sanitization/cache hydration without swallowing the prepared reply', async () => {
  const sanitized = sanitizeTimelineEvent(event({ prompt: envelope({ request: 'Long user source. '.repeat(5000) }) }))
  assert.ok(sanitized.prompt.length <= 48000)
  const projected = projectTimeline([JSON.parse(JSON.stringify(sanitized))], [])
  const renderer = await render(projected[0])
  try {
    assert.equal(renderer.root.findByType('MarkdownContent').props.value, body)
    assert.doesNotMatch(visible(renderer), /Long user source|AgentsDock delivery/)
    await press(renderer, 'imported-cross-chat-delivery-1-source-toggle')
    await press(renderer, 'imported-cross-chat-delivery-1-source-body-toggle')
    assert.match(renderer.root.findAllByType('MarkdownContent')[1].props.value, /Content truncated on mobile/)
  } finally { await act(async () => renderer.unmount()) }
})
