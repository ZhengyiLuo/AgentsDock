import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { create } from 'zustand'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const initial = {
  activeProfileId: 'first', profileGeneration: 1, selectedSessionId: 'chat',
  connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
  health: { capabilities: { gemini_backend: { available: true, version: 1, client_capability: 'gemini_acp_v1' } } },
  sessions: [{ id: 'chat', backend: 'gemini' }], snapshots: {},
}
const store = globalThis.__geminiStore = create(() => initial)
const client = globalThis.__geminiClient = { isValidated: true, isDisposed: false }
const mocks = {
  'react-native': `export const Pressable='Button'; export const AppState={addEventListener:(_,fn)=>{globalThis.__geminiForeground=fn;return {remove:()=>{globalThis.__geminiForeground=null}}}};`,
  '../store/useAppStore': `export const useAppStore=globalThis.__geminiStore,client=globalThis.__geminiClient;`,
  './CodexInteractionShelf': `export const ProviderInteractionShelf='Shelf';`,
  './AppText': `export const Text='Text';`,
}
const outfile = path.resolve('build/tmp', `gemini-interactions-${process.pid}.mjs`)
await fs.mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/components/GeminiInteractionShelf.tsx'], outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => fs.unlink(outfile))
beforeEach(() => { store.setState(initial, true); client.isValidated = true; client.isDisposed = false })
const { GeminiInteractionShelf } = await import(pathToFileURL(outfile).href)
const request = { id: 'run-owned-request', session_id: 'chat', method: 'item/tool/requestApproval', params: { availableDecisions: ['accept', 'decline'] } }
const snapshot = pending_interactions => ({ available: true, pending_interactions })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function render(run) {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(GeminiInteractionShelf, { sessionId: 'chat' })) })
  try { await run(tree) } finally { await act(async () => tree.unmount()) }
}
const shelf = tree => tree.root.findByType('Shelf')

test('Gemini approval sends the exact run-owned decision once and refreshes the authoritative list', async () => {
  let pending = [request], reads = 0
  const calls = [], gate = deferred()
  client.geminiRuntime = async id => { assert.equal(id, 'chat'); reads++; return snapshot(pending) }
  client.resolveGeminiInteraction = async (...args) => { calls.push(args); await gate.promise; pending = [] }
  await render(async tree => {
    assert.equal(reads, 1)
    let operation
    await act(async () => {
      operation = shelf(tree).props.onRespond(request.id, { decision: 'decline' })
      void shelf(tree).props.onRespond(request.id, { decision: 'accept' })
    })
    assert.deepEqual(calls, [['chat', request.id, { decision: 'decline' }]])
    assert.equal(shelf(tree).props.busy, true)
    await act(async () => { gate.resolve(); await operation })
    assert.equal(shelf(tree).props.busy, false)
    assert.deepEqual(shelf(tree).props.interactions, [])
    assert.equal(reads, 2)
  })
})

test('late runtime responses and old approval handlers cannot act after changing server generation', async () => {
  const oldRead = deferred()
  let reads = 0, writes = 0
  client.geminiRuntime = () => ++reads === 1 ? oldRead.promise : Promise.resolve(snapshot([]))
  client.resolveGeminiInteraction = async () => { writes++ }
  await render(async tree => {
    const oldRespond = shelf(tree).props.onRespond
    await act(async () => store.setState({ activeProfileId: 'second', profileGeneration: 2 }))
    await act(async () => oldRead.resolve(snapshot([request])))
    assert.deepEqual(shelf(tree).props.interactions, [])
    await act(async () => oldRespond(request.id, { decision: 'accept' }))
    assert.equal(writes, 0)
  })
})

test('runtime failure is retryable; durable request events and foregrounding invalidate without polling', async () => {
  let reads = 0
  client.geminiRuntime = async () => { if (++reads === 1) throw new Error('offline'); return snapshot([request]) }
  await render(async tree => {
    assert.equal(shelf(tree).props.error, 'offline')
    await act(async () => shelf(tree).props.onRetry())
    assert.equal(shelf(tree).props.error, null)
    assert.deepEqual(shelf(tree).props.interactions, [request])
    await act(async () => store.setState({ snapshots: { chat: { events: [{ seq: 3, type: 'gemini_interaction_requested' }] } } }))
    assert.equal(reads, 3)
    await act(async () => globalThis.__geminiForeground('active'))
    assert.equal(reads, 4)
    await act(async () => store.setState({ connected: false }))
    assert.equal(tree.root.findAllByType('Shelf').length, 0)
    assert.equal(globalThis.__geminiForeground, null)
  })
})
