import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const calls = [], listeners = new Set()
const fixture = { state: null, client: { validationRevision: 1, isValidated: true, isDisposed: false }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
globalThis.__teamMailFixture = fixture
const mocks = {
  'react-native': `import { createElement } from 'react'; export const View='View', ScrollView='ScrollView', KeyboardAvoidingView='KeyboardAvoidingView', ActivityIndicator='ActivityIndicator'; export const Modal=props=>props.visible?createElement('Modal',props):null; export const Pressable=props=>createElement('Pressable',props,typeof props.children==='function'?props.children({pressed:false}):props.children); export const StyleSheet={create:x=>x,hairlineWidth:.5}; export const Platform={OS:'ios'}; export const useColorScheme=()=> 'dark';`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeAreaView'; export const useSafeAreaInsets=()=>({top:0,bottom:0});`,
  'lucide-react-native': `export const ArrowLeft='ArrowLeft', Bot='Bot', BookOpen='BookOpen', Inbox='Inbox', RadioTower='RadioTower', RefreshCw='RefreshCw', Send='Send', Server='Server', Users='Users', X='X';`,
  '../store/useAppStore': `import {useSyncExternalStore} from 'react'; const fixture=globalThis.__teamMailFixture; export const client=fixture.client; export const useAppStore=selector=>useSyncExternalStore(fixture.subscribe,()=>selector(fixture.state)); useAppStore.getState=()=>fixture.state;`,
  './AppText': `export const Text='Text',TextInput='TextInput';`,
  './MarkdownContent': `export const MarkdownContent='MarkdownContent';`,
  './ui': `import {createElement} from 'react'; export const EmptyState=props=>createElement('EmptyState',props); export const IconButton=props=>createElement('Pressable',{...props,accessibilityLabel:props.label});`,
}
const outfile = path.resolve('build/tmp', `team-mail-rendering-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({ stdin: { contents: `export { TeamNetwork } from './src/components/TeamNetwork';`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'native', setup(context) { context.onResolve({ filter: /.*/ }, args => args.path === 'react' || args.path.startsWith('react/') ? { path: args.path, external: true } : mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined); context.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' })) } }] })
after(async () => { await unlink(outfile); delete globalThis.__teamMailFixture })
const { TeamNetwork } = await import(pathToFileURL(outfile).href)
const own = { kind: 'server', id: 'own', display_name: 'This server', state: 'available' }
const body = 'Private **verified** Mail'
const message = (patch = {}) => ({ id: 'm1', sequence: 1, kind: 'message', title: 'Private subject', preview: body, body, body_bytes: Buffer.byteLength(body), body_sha256: createHash('sha256').update(body).digest('hex'), body_format: 'markdown', sender: { kind: 'server', id: 'peer', display_name: 'Peer' }, recipients: [own], delivery: own, attachments: [], skill: null, in_reply_to_message_id: null, created_at: '2026-09-14T12:00:00Z', mailbox_state: { address_kind: 'server', address_id: 'own', unread: true, version: 0 }, ...patch })
const page = (messages = [message()], patch = {}) => ({ box: 'inbox', address: { kind: 'server', id: 'own' }, messages, next_after_sequence: messages.at(-1)?.sequence ?? 0, has_more: false, ...patch })
let detail, inbox, post, mailboxCapability
function reset() {
  calls.length = 0; detail = message(); inbox = page(); mailboxCapability = true
  fixture.client.validationRevision = 1
  fixture.state = { activeProfileId: 'profile', profileGeneration: 1, selectedSessionId: 'chat', connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    profiles: [{ id: 'profile', name: 'Profile', serverIdentity: 'server' }], sessions: [{ id: 'chat', title: 'Local chat' }], health: { ok: true, server_instance_id: 'instance', capabilities: { team_hub_v1: { available: true, version: 1, server_session_base_path: '/api/team-hub-server', hub_id: 'hub' } } },
    stageTeamMailDraft: async input => { calls.push(['draft', input]); return true }, refreshSessions: async () => {}, reconnect: async () => {} }
  fixture.client.teamNetworkGet = async (base, route) => {
    calls.push(['GET', route]); const url = new URL(route, 'https://test.invalid')
    if (url.pathname === '/v1/health') return { hub_id: 'hub', capabilities: { team_messages_v1: { available: true, version: 1 }, ...(mailboxCapability ? { team_mailbox_state_v1: { available: true, version: 1, address_kinds: ['server'] } } : {}) } }
    if (url.pathname === '/v1/server-session') return { principal: { id: 'principal', kind: 'service' }, teams: [{ id: 'team', display_name: 'Team', status: 'active', role: 'member' }] }
    if (url.pathname.endsWith('/network')) return { network: { id: 'team', hub_id: 'hub' }, servers: [{ id: 'own', status: 'active', owned_by_caller: true, display_name: 'Own' }], agents: [] }
    if (url.pathname.endsWith('/members')) return { members: [] }
    if (url.pathname.endsWith('/messages')) return url.searchParams.get('box') === 'feed' ? page([], { box: 'feed', address: null }) : typeof inbox === 'function' ? inbox(url) : inbox
    if (url.pathname.endsWith('/messages/m1')) return { message: typeof detail === 'function' ? await detail() : detail }
    throw new Error(`Unexpected test GET ${route}`)
  }
  post = async (route, value) => route.endsWith('/dismissals') ? { dismissed: true, message_id: 'm1', address: { kind: 'server', id: 'own' } }
    : { message_id: 'm1', recipients: [{ ...own, state: 'read' }], ...(route.endsWith('/mailbox-state') ? { mailbox_state: { address_kind: 'server', address_id: 'own', unread: value.unread, version: value.expected_version + 1 } } : {}) }
  fixture.client.teamNetworkPost = async (base, route, value) => { calls.push(['POST', route, value]); return post(route, value) }
}
const byLabel = (renderer, label) => renderer.root.findAll(node => node.type === 'Pressable' && node.props.accessibilityLabel === label)[0]
const click = async (renderer, label) => act(async () => byLabel(renderer, label).props.onPress())
const text = renderer => renderer.root.findAllByType('Text').flatMap(node => node.children.filter(value => typeof value === 'string')).join('\n')
const publish = patch => { fixture.state = { ...fixture.state, ...patch }; for (const fn of listeners) fn() }
async function render() { let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(TeamNetwork, { visible: true, onClose: () => calls.push(['close']) })) }); return renderer }
const cleanup = renderer => act(async () => renderer.unmount())
test('list refresh is GET-only; explicit detail open marks exactly its owned revision read', async () => {
  reset(); const renderer = await render()
  try {
    assert.equal(calls.filter(call => call[0] === 'POST').length, 0)
    await click(renderer, 'Open Private subject')
    const writes = calls.filter(call => call[0] === 'POST')
    assert.equal(writes.length, 1); assert.equal(writes[0][1], '/v1/teams/team/network/messages/m1/mailbox-state')
    assert.deepEqual({ ...writes[0][2], idempotency_key: 'KEY' }, { address_kind: 'server', address_id: 'own', unread: false, expected_version: 0, idempotency_key: 'KEY' })
    assert.ok(byLabel(renderer, 'Mark unread'))
    await click(renderer, 'Mark unread')
    assert.equal(calls.filter(call => call[0] === 'POST').at(-1)[2].expected_version, 1)
    assert.ok(byLabel(renderer, 'Mark read'))
  } finally { await cleanup(renderer) }
})
test('old Hub retains legacy read receipt without unsupported unread endpoint', async () => {
  reset(); mailboxCapability = false; detail = message({ mailbox_state: undefined }); inbox = page([detail]); const renderer = await render()
  try { await click(renderer, 'Open Private subject'); assert.ok(calls.some(call => call[0] === 'POST' && call[1].endsWith('/receipts'))); assert.equal(byLabel(renderer, 'Mark unread'), undefined) }
  finally { await cleanup(renderer) }
})
test('bad detail hash never triggers read or reveals body', async () => {
  reset(); detail = message({ body: 'Tampered content' }); const renderer = await render()
  try { await click(renderer, 'Open Private subject'); assert.equal(calls.filter(call => call[0] === 'POST').length, 0); assert.match(text(renderer), /invalid message/); assert.equal(renderer.root.findAllByType('MarkdownContent').length, 0) }
  finally { await cleanup(renderer) }
})
test('bad read and dismissal receipts preserve content and permit retry', async () => {
  reset(); post = async () => ({ message_id: 'wrong' }); const renderer = await render()
  try { await click(renderer, 'Open Private subject'); assert.ok(byLabel(renderer, 'Mark read')); await click(renderer, 'Remove from my inbox'); assert.equal(renderer.root.findAllByType('MarkdownContent').length, 1); assert.match(text(renderer), /invalid message/) }
  finally { await cleanup(renderer) }
})
test('Reply chooses a local chat and stages a draft, never sends or starts an agent', async () => {
  reset(); const renderer = await render()
  try { await click(renderer, 'Open Private subject'); await click(renderer, 'Reply through agent'); assert.equal(calls.filter(call => call[0] === 'draft').length, 0); await click(renderer, 'Local chat · chat'); const staged = calls.find(call => call[0] === 'draft')[1]; assert.equal(staged.intent, 'reply'); assert.equal(staged.message.messageId, 'm1'); assert.equal(staged.message.senderId, 'peer'); assert.equal(calls.filter(call => call[0] === 'close').length, 1) }
  finally { await cleanup(renderer) }
})
test('Mail pagination advances explicitly with bounded pages and does not mark read', async () => {
  reset(); inbox = url => Number(url.searchParams.get('after_sequence')) === 0 ? page([message()], { has_more: true }) : page([message({ id: 'm2', sequence: 2, title: 'Second' })]); const renderer = await render()
  try { await click(renderer, 'Load more Mail'); assert.ok(byLabel(renderer, 'Open Second')); assert.equal(calls.filter(call => call[0] === 'POST').length, 0); assert.equal(byLabel(renderer, 'Load more Mail'), undefined) }
  finally { await cleanup(renderer) }
})
test('late detail response after profile change cannot mark read or display old content', async () => {
  reset(); let resolve; detail = () => new Promise(done => { resolve = done }); const renderer = await render()
  try { await act(async () => { byLabel(renderer, 'Open Private subject').props.onPress() }); await act(async () => publish({ profileGeneration: 2, health: { ...fixture.state.health, capabilities: {} } })); await act(async () => resolve(message())); assert.equal(calls.filter(call => call[0] === 'POST').length, 0); assert.equal(renderer.root.findAllByType('MarkdownContent').length, 0) }
  finally { await cleanup(renderer) }
})
for (const operation of ['open', 'Mark unread', 'Remove from my inbox', 'route']) for (const boundary of ['profile', 'identity', 'validation', 'offline']) test(`retained ${operation} callback cannot act in the same tick as ${boundary} changes`, async () => {
  reset(); const renderer = await render()
  try {
    if (operation !== 'open') await click(renderer, 'Open Private subject')
    if (operation === 'route') await click(renderer, 'Reply through agent')
    const callback = byLabel(renderer, operation === 'open' ? 'Open Private subject' : operation === 'route' ? 'Local chat · chat' : operation).props.onPress
    calls.length = 0
    await act(async () => {
      if (boundary === 'profile') publish({ profileGeneration: 2 })
      if (boundary === 'identity') publish({ profiles: [{ id: 'profile', name: 'Profile', serverIdentity: 'other' }] })
      if (boundary === 'validation') { fixture.client.validationRevision++; publish({}) }
      if (boundary === 'offline') publish({ connected: false })
      callback()
    })
    assert.equal(calls.filter(call => call[0] === 'POST' || call[0] === 'draft' || call[0] === 'GET' && call[1].includes('/messages/m1')).length, 0)
  } finally { await cleanup(renderer) }
})
test('Remove is exact-receipt, same-tick duplicate safe, and never optimistic', async () => {
  reset(); const renderer = await render()
  try {
    await click(renderer, 'Open Private subject')
    let resolve; post = () => new Promise(done => { resolve = done })
    calls.length = 0
    const callback = byLabel(renderer, 'Remove from my inbox').props.onPress
    await act(async () => { callback(); callback() })
    assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
    assert.equal(renderer.root.findAllByType('MarkdownContent').length, 1)
    await act(async () => resolve({ dismissed: true, message_id: 'm1', address: { kind: 'server', id: 'own' } }))
    assert.equal(renderer.root.findAllByType('MarkdownContent').length, 0)
    await act(async () => callback())
    assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
  } finally { await cleanup(renderer) }
})
