import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const listeners = new Set()
const client = { validationRevision: 1 }
const fixture = {
  state: null,
  client,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
}
globalThis.__crossChatCardFixture = fixture

const mocks = {
  'react-native': `import { createElement } from 'react'; export const ActivityIndicator = 'ActivityIndicator', View = 'View'; export const Pressable = props => createElement('Pressable', props, typeof props.children === 'function' ? props.children({ pressed: false }) : props.children); export const StyleSheet = { create: value => value, absoluteFill: {} }; export const useColorScheme = () => 'dark';`,
  '@shopify/flash-list': `import { useEffect, useState } from 'react'; export function useRecyclingState(initial, deps) { const [value, setValue] = useState(initial); useEffect(() => setValue(initial), deps); return [value, setValue]; }`,
  'lucide-react-native': `export const AlertTriangle = 'AlertTriangle', ChevronDown = 'ChevronDown', ChevronRight = 'ChevronRight', MessageSquareShare = 'MessageSquareShare';`,
  'react-native-svg': `export default 'Svg'; export const Defs = 'Defs', LinearGradient = 'LinearGradient', Rect = 'Rect', Stop = 'Stop';`,
  '../store/useAppStore': `import { useSyncExternalStore } from 'react'; const fixture = globalThis.__crossChatCardFixture; export const client = fixture.client; export const useAppStore = selector => useSyncExternalStore(fixture.subscribe, () => selector(fixture.state)); useAppStore.getState = () => fixture.state;`,
  '../lib/chat-references': `export const exactQueuedDeliverySkipAvailable = health => health.skipAvailable;`,
  '../lib/format': `export const formatDateTime = value => value; export const messageText = event => event.message || '';`,
  '../lib/timeline-inline-references': `export const timelineChatReferenceIsRemote = reference => reference.target_kind === 'secure_peer'; export const timelineChatReferenceKey = reference => reference.session_id;`,
  './AppText': `export const Text = 'Text';`,
  './MarkdownContent': `import { createElement } from 'react'; export const MarkdownContent = ({ value, ...props }) => createElement('MarkdownContent', props, value);`,
}
const outfile = path.resolve('build/tmp', `cross-chat-card-tests-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/components/CrossChatTimelineCards.tsx'], outfile,
  bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent',
  plugins: [{ name: 'cross-chat-native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => args.path === 'react'
      ? { path: args.path, external: true }
      : mocks[args.path] ? { path: args.path, namespace: 'card-mock' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'card-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(async () => { await unlink(outfile); delete globalThis.__crossChatCardFixture })
const { CrossChatExchangeCard, CrossChatMessageSurface } = await import(pathToFileURL(outfile).href)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function event(exchangeId = 'exchange-1') {
  return {
    id: `event-${exchangeId}`, seq: 1, ts: '2026-09-09T12:00:00Z', session_id: 'target',
    type: 'cross_chat_exchange_leg_queued', exchange_id: exchangeId, exchange_status: 'active',
    requester_session_id: 'source', responder_session_id: 'target',
    source_session_id: 'source', target_session_id: 'target',
    exchange_leg_id: 'leg-1', exchange_leg_kind: 'request', exchange_leg_status: 'queued',
    exchange_ordinal: 1, queued_id: 'queued-1', handoff_preview: 'Question', handoff_body_truncated: true,
  }
}

function exchange(status = 'active') {
  return {
    id: 'exchange-1', status, requester_session_id: 'source', responder_session_id: 'target',
    legs: [{ id: 'leg-1', exchange_id: 'exchange-1', kind: 'request', ordinal: 1,
      source_session_id: 'source', target_session_id: 'target', status: status === 'active' ? 'queued' : 'cancelled',
      queued_id: 'queued-1', body: 'Complete question', created_at: '2026-09-09T12:00:00Z' }],
  }
}

function resetFixture({ skipAvailable = true } = {}) {
  fixture.state = {
    activeProfileId: 'profile-1', profileGeneration: 1, connected: true, connecting: false,
    profiles: [{ id: 'profile-1', serverIdentity: 'server-1' }],
    health: { server_instance_id: 'instance-1', skipAvailable }, selectedSessionId: 'target',
    sessions: [{ id: 'source', title: 'Source' }, { id: 'target', title: 'Target' }],
    switchingProfileId: null, workspaceAdopting: false, syncSelectedSession: async () => {},
  }
  client.validationRevision = 1
  client.crossChatExchange = async () => exchange()
  client.cancelCrossChatExchange = async () => exchange('cancelled')
  client.skipQueuedCrossChatDelivery = async () => {}
  client.queue = async () => []
}

function publish(patch = {}) {
  fixture.state = { ...fixture.state, ...patch }
  for (const listener of listeners) listener()
}

async function render(props = {}) {
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(CrossChatExchangeCard, { event: event(), rowKey: 'row', sessionId: 'target', ...props })) })
  return renderer
}

function button(renderer, id) {
  return renderer.root.findAll(node => node.type === 'Pressable' && node.props.testID === id)[0]
}

test('legacy exchange uses the Mac per-message bubble, direction, and Markdown before expansion', async () => {
  resetFixture()
  const renderer = await render()
  try {
    assert.equal(renderer.root.findAllByType('LinearGradient').length, 0)
    const surface = renderer.root.findAll(node => node.type === 'View' && node.props.testID === 'cross-chat-message-leg-1-surface')[0]
    assert.ok(surface, 'Each exchange leg has its own message surface')
    const style = Object.assign({}, ...surface.props.style.flat(Infinity).filter(Boolean))
    assert.equal(style.backgroundColor, '#332444')
    assert.equal(style.alignSelf, 'flex-end', 'Incoming is relative to the displayed chat, not the requester')
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, 'Question')
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Agent conversation|Conversation with/)
  } finally { await act(async () => renderer.unmount()) }
})

test('exchange leg without preview metadata retains on-demand body loading', async () => {
  resetFixture()
  let reads = 0
  client.crossChatExchange = async () => { reads += 1; return exchange() }
  const renderer = await render({ event: { ...event(), handoff_preview: '', handoff_body_truncated: undefined } })
  try {
    assert.match(JSON.stringify(renderer.toJSON()), /Message body available on demand/)
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(reads, 1)
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, 'Complete question')
    assert.equal(button(renderer, 'cross-chat-message-toggle-leg-1'), undefined)
  } finally { await act(async () => renderer.unmount()) }
})

test('individually anchored exchange rows retain one directional bubble each after detail loading', async () => {
  resetFixture()
  const first = event()
  const second = { ...first, id: 'reply-event', seq: 3, exchange_leg_id: 'leg-2', exchange_ordinal: 2,
    exchange_leg_kind: 'reply', source_session_id: 'target', target_session_id: 'source',
    handoff_preview: 'Reply preview', handoff_body_truncated: false }
  let reads = 0
  client.crossChatExchange = async () => {
    reads += 1
    return { ...exchange(), legs: [exchange().legs[0], { ...exchange().legs[0], id: 'leg-2', kind: 'reply', ordinal: 2,
      source_session_id: 'target', target_session_id: 'source', body: 'Full reply', status: 'delivered' }] }
  }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(React.Fragment, null,
      React.createElement(CrossChatExchangeCard, { event: second, events: [first, second], rowKey: 'request-row', legId: 'leg-1', sessionId: 'target' }),
      React.createElement('Text', null, 'Activity between the messages'),
      React.createElement(CrossChatExchangeCard, { event: second, events: [first, second], rowKey: 'reply-row', legId: 'leg-2', sessionId: 'target' })))
  })
  try {
    for (const id of ['leg-1', 'leg-2']) assert.equal(renderer.root.findAll(node => node.type === 'View' && node.props.testID === `cross-chat-message-${id}-surface`).length, 1)
    assert.deepEqual(renderer.root.findAllByType('MarkdownContent').map(node => node.props.children), ['Question', 'Reply preview'])
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(reads, 1)
    assert.deepEqual(renderer.root.findAllByType('MarkdownContent').map(node => node.props.children), ['Complete question', 'Reply preview'])
    for (const [id, direction] of [['leg-1', 'flex-end'], ['leg-2', 'flex-start']]) {
      const surface = renderer.root.findAll(node => node.type === 'View' && node.props.testID === `cross-chat-message-${id}-surface`)
      assert.equal(surface.length, 1, 'Loading one row cannot add its sibling messages')
      assert.equal(Object.assign({}, ...surface[0].props.style.flat(Infinity)).alignSelf, direction)
    }
  } finally { await act(async () => renderer.unmount()) }
})

test('conversation surface renders shared presentation without store state or action controls', async () => {
  fixture.state = null
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(CrossChatMessageSurface, { identity: 'shared-conversation', sessionId: 'chat', title: 'Sender', incoming: true }, React.createElement('Text', null, 'Imported content')))
  })
  try {
    assert.equal(renderer.root.findAllByType('Pressable').length, 0)
    assert.equal(renderer.root.findAllByType('MessageSquareShare').length, 1)
    assert.equal(renderer.root.findAllByType('LinearGradient').length, 0)
    assert.equal(renderer.root.findAll(node => node.type === 'View' && node.props.testID === 'shared-conversation').length, 1)
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Imported content'))
  } finally { await act(async () => renderer.unmount()) }
})

test('expanding a live exchange renders authenticated Markdown with conversation tint and original font scale', async () => {
  resetFixture()
  const body = '# Result\n\n**Ready** with `code`, [details](https://example.com), and $x^2$. ' + 'Long result. '.repeat(60)
  let reads = 0
  client.crossChatExchange = async () => {
    reads += 1
    const loaded = exchange()
    loaded.legs[0].body = body
    return loaded
  }
  const renderer = await render({ fontScale: 1.3 })
  try {
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, 'Question', 'Preview is Markdown before detail loading')
    await act(async () => {
      const expand = button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress
      expand(); expand()
    })
    assert.equal(reads, 1, 'Expansion retains the existing single-flight detail request')
    const markdown = renderer.root.findByType('MarkdownContent')
    assert.equal(markdown.props.children, body)
    assert.equal(markdown.props.compact, true)
    assert.equal(markdown.props.color, '#f4f4f5')
    assert.equal(markdown.props.fontScale, 1.3)
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.ok(renderer.root.findByType('MarkdownContent').props.children.length <= 641)
  } finally { await act(async () => renderer.unmount()) }
})

test('individual Markdown expansion preserves bounded chunks, Show more, and Show less', async () => {
  resetFixture()
  const body = ('# Long result\n\n' + '**sample** '.repeat(800)).trim()
  const longEvent = { ...event(), handoff_preview: body, handoff_body_chars: body.length, handoff_body_truncated: false }
  let reads = 0
  client.crossChatExchange = async () => { reads += 1; return exchange() }
  const renderer = await render({ event: longEvent })
  try {
    assert.ok(renderer.root.findByType('MarkdownContent').props.children.length <= 641)
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, body.slice(0, 4_000) + '…')
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, body.slice(0, 8_000) + '…')
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(renderer.root.findByType('MarkdownContent').props.children, body)
    assert.equal(button(renderer, 'cross-chat-message-toggle-leg-1').props.accessibilityLabel, 'Show less for message 1')
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.ok(renderer.root.findByType('MarkdownContent').props.children.length <= 641)
    assert.equal(reads, 0, 'Complete local bodies should not request detail while paging')
  } finally { await act(async () => renderer.unmount()) }
})

for (const transition of ['validation', 'server instance']) test(`same-profile ${transition} change releases old detail loading and fences its late response`, async () => {
  resetFixture()
  const oldRead = deferred(), freshRead = deferred()
  let reads = 0
  client.crossChatExchange = () => (++reads === 1 ? oldRead.promise : freshRead.promise)
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.equal(reads, 1)
    await act(async () => {
      if (transition === 'validation') { client.validationRevision += 1; publish() }
      else publish({ health: { ...fixture.state.health, server_instance_id: 'instance-2' } })
    })
    assert.equal(reads, 2, 'The open card should reload after client validation changes')
    await act(async () => oldRead.reject(new Error('Old connection aborted')))
    assert.equal(button(renderer, 'cross-chat-message-toggle-leg-1').props.disabled, true, 'The old finally must not release the new request')
    await act(async () => freshRead.resolve(exchange()))
    assert.equal(renderer.root.findAllByType('ActivityIndicator').length, 0)
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Complete question'))
  } finally { await act(async () => renderer.unmount()) }
})

test('reconnect releases End conversation and repeated taps stay single-flight', async () => {
  resetFixture({ skipAvailable: false })
  const oldCancel = deferred(), freshCancel = deferred()
  let cancels = 0
  client.cancelCrossChatExchange = () => (++cancels === 1 ? oldCancel.promise : freshCancel.promise)
  const renderer = await render()
  try {
    await act(async () => {
      const action = button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.onPress
      action(); action()
    })
    assert.equal(cancels, 1)
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.disabled, true)
    await act(async () => { client.validationRevision += 1; publish() })
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.disabled, false)
    await act(async () => button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.onPress())
    await act(async () => oldCancel.reject(new Error('Old connection aborted')))
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.disabled, true)
    await act(async () => freshCancel.resolve(exchange('cancelled')))
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1'), undefined)
  } finally { await act(async () => renderer.unmount()) }
})

test('a failed profile switch releases a cancel that settled while the original scope was suspended', async () => {
  resetFixture({ skipAvailable: false })
  const oldCancel = deferred()
  let cancels = 0
  client.cancelCrossChatExchange = () => (++cancels === 1 ? oldCancel.promise : Promise.resolve(exchange('cancelled')))
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.onPress())
    await act(async () => publish({ switchingProfileId: 'unreachable-profile' }))
    await act(async () => oldCancel.reject(new Error('Request ended while switching')))
    await act(async () => publish({ switchingProfileId: null }))
    assert.equal(fixture.state.profileGeneration, 1)
    assert.equal(client.validationRevision, 1)
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.disabled, false)
    await act(async () => button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.onPress())
    assert.equal(cancels, 2)
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1'), undefined)
  } finally { await act(async () => renderer.unmount()) }
})

test('ending reconnect reloads an open card when connected stayed true and revalidation did not advance its revision again', async () => {
  resetFixture()
  const oldRead = deferred()
  let validatedReads = 0
  client.crossChatExchange = () => {
    if (fixture.state.connecting) return Promise.reject(new Error('Client not yet validated'))
    return ++validatedReads === 1 ? oldRead.promise : Promise.resolve(exchange())
  }
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    await act(async () => { client.validationRevision += 1; publish({ connecting: true }) })
    await act(async () => oldRead.reject(new Error('Old connection aborted')))
    assert.equal(validatedReads, 1)
    await act(async () => publish({ connecting: false }))
    assert.equal(fixture.state.connected, true)
    assert.equal(client.validationRevision, 2)
    assert.equal(validatedReads, 2)
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Complete question'))
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Client not yet validated'))
  } finally { await act(async () => renderer.unmount()) }
})

test('a promoted queued message preserves cancel intent for that exact exchange without claiming removal', async () => {
  resetFixture()
  const cancellation = deferred()
  const cancelledIds = [], skipped = []
  client.skipQueuedCrossChatDelivery = async (...args) => { skipped.push(args); throw new Error('Delivery has started') }
  client.cancelCrossChatExchange = id => { cancelledIds.push(id); return cancellation.promise }
  const renderer = await render()
  try {
    await act(async () => {
      const action = button(renderer, 'cross-chat-skip-delivery-queued-1').props.onPress
      action(); action()
    })
    assert.equal(skipped.length, 1)
    assert.deepEqual(skipped[0], ['target', 'queued-1', { cross_chat_exchange_id: 'exchange-1', cross_chat_exchange_leg_id: 'leg-1' }])
    assert.deepEqual(cancelledIds, ['exchange-1'])
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Queued message removed.'))
    await act(async () => cancellation.resolve(exchange('cancelled')))
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1'), undefined)
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Queued message removed.'))
  } finally { await act(async () => renderer.unmount()) }
})

for (const change of ['profile', 'exchange', 'connection']) test(`promotion reconciliation cannot cancel after the ${change} changes`, async () => {
  resetFixture()
  const queue = deferred()
  const cancelledIds = []
  client.skipQueuedCrossChatDelivery = async () => { throw new Error('Delivery has started') }
  client.queue = () => queue.promise
  client.cancelCrossChatExchange = async id => { cancelledIds.push(id); return exchange('cancelled') }
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-skip-delivery-queued-1').props.onPress())
    await act(async () => {
      if (change === 'profile') publish({ activeProfileId: 'profile-2', profileGeneration: 2 })
      else if (change === 'connection') publish({ connected: false })
      else renderer.update(React.createElement(CrossChatExchangeCard, { event: event('exchange-2'), rowKey: 'row', sessionId: 'target' }))
    })
    await act(async () => queue.resolve([]))
    assert.deepEqual(cancelledIds, [])
  } finally { await act(async () => renderer.unmount()) }
})

test('an old detail read cannot restore active state after confirmed cancellation', async () => {
  resetFixture({ skipAvailable: false })
  const oldRead = deferred()
  client.crossChatExchange = () => oldRead.promise
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    await act(async () => button(renderer, 'cross-chat-cancel-exchange-exchange-1').props.onPress())
    await act(async () => oldRead.resolve(exchange('active')))
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1'), undefined)
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Conversation status: Cancelled'))
  } finally { await act(async () => renderer.unmount()) }
})

test('reconnect releases Remove queued message and old completion cannot mark a new request removed', async () => {
  resetFixture()
  const oldSkip = deferred(), freshSkip = deferred()
  let skips = 0
  client.skipQueuedCrossChatDelivery = () => (++skips === 1 ? oldSkip.promise : freshSkip.promise)
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-skip-delivery-queued-1').props.onPress())
    await act(async () => { client.validationRevision += 1; publish() })
    assert.equal(button(renderer, 'cross-chat-skip-delivery-queued-1').props.disabled, false)
    await act(async () => button(renderer, 'cross-chat-skip-delivery-queued-1').props.onPress())
    await act(async () => oldSkip.resolve())
    assert.equal(button(renderer, 'cross-chat-skip-delivery-queued-1').props.disabled, true)
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Queued message removed.'))
    await act(async () => freshSkip.resolve())
    assert.equal(button(renderer, 'cross-chat-skip-delivery-queued-1'), undefined)
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Queued message removed.'))
  } finally { await act(async () => renderer.unmount()) }
})

test('failed promotion cancellation reloads terminal truth even when the earlier detail snapshot looked current', async () => {
  resetFixture()
  const readIds = [], cancelIds = []
  client.crossChatExchange = async id => { readIds.push(id); return exchange(readIds.length === 1 ? 'active' : 'completed') }
  client.skipQueuedCrossChatDelivery = async () => { throw new Error('Delivery has started') }
  client.cancelCrossChatExchange = async id => { cancelIds.push(id); throw new Error('Conversation completed before cancellation') }
  const renderer = await render()
  try {
    await act(async () => button(renderer, 'cross-chat-message-toggle-leg-1').props.onPress())
    assert.deepEqual(readIds, ['exchange-1'])
    await act(async () => button(renderer, 'cross-chat-skip-delivery-queued-1').props.onPress())
    assert.deepEqual(cancelIds, ['exchange-1'])
    assert.deepEqual(readIds, ['exchange-1', 'exchange-1'])
    assert.equal(button(renderer, 'cross-chat-cancel-exchange-exchange-1'), undefined)
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Queued message removed.'))
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Conversation status: Completed'))
  } finally { await act(async () => renderer.unmount()) }
})
