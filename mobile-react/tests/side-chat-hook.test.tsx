import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import React, { StrictMode } from 'react'
import { act, create } from 'react-test-renderer'
import { Text } from 'react-native'
import { useSideChat } from '../src/hooks/useSideChat'
import type { SideQuestionInput, SyncedSideChat } from '../src/lib/side-chat'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { AppState } from './component-mocks/react-native'

type Result = ReturnType<typeof useSideChat>
const health = {
  ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
  capabilities: { side_questions: { available: true, version: 2, native_context: true, sync: true,
    backends: ['codex', 'claude'] as Array<'codex' | 'claude'>, max_question_chars: 4096 } },
}
const document = (revision = 1, session = 'chat-a', side = 'side-a'): SyncedSideChat => ({
  session_id: session, side_chat_id: side, revision, last_request_id: null, exchanges: [],
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let tree: ReturnType<typeof create> | null = null
let current!: Result
let rendered: Array<{ session: string; revision: number | null; side: string | null }> = []

function Probe({ session = 'chat-a', visible = true }: { session?: string; visible?: boolean }) {
  current = useSideChat(session, visible)
  rendered.push({ session, revision: current.snapshot?.revision ?? null, side: current.snapshot?.side_chat_id ?? null })
  return <Text testID="side-state">{JSON.stringify({ supported: current.supported, available: current.available,
    loading: current.loading, mutating: current.mutating, snapshot: current.snapshot, error: current.error })}</Text>
}

function transport() {
  const observers = new Set<(session: string, revision: number) => void>()
  const calls = { reads: [] as string[], submits: [] as Array<[string, SideQuestionInput]>, stops: [] as string[], clears: [] as string[] }
  const methods = {
    isValidated: true, validationRevision: 1,
    async readSyncedSideChat(session: string) { calls.reads.push(session); return document(1, session) },
    async submitSyncedSideChat(session: string, input: SideQuestionInput): Promise<SyncedSideChat> {
      calls.submits.push([session, input])
      return { ...document(2, session), exchanges: [{ request_id: input.request_id, question: input.question, status: 'running', created_at: 'now', updated_at: 'now' }] }
    },
    async stopSyncedSideChat(session: string, request: string) { calls.stops.push(request); return document(3, session) },
    async clearSyncedSideChat(session: string, side: string) { calls.clears.push(side); return document(4, session, 'side-new') },
    subscribeSideChatChanges(callback: (session: string, revision: number) => void) {
      observers.add(callback)
      return () => { observers.delete(callback) }
    },
  }
  const connection = setTestClient(methods)
  return { calls, observers, methods, connection, emit(session: string, revision: number) {
    for (const callback of observers) callback(session, revision)
  } }
}

const render = async (props: { session?: string; visible?: boolean } = {}) => {
  await act(async () => { tree = create(<Probe {...props} />) })
}

beforeEach(() => {
  rendered = []
  AppState.currentState = 'active'
  resetComponentStore({ activeProfileId: 'profile-a', profileGeneration: 1, connected: true, connecting: false,
    switchingProfileId: null, workspaceAdopting: false, health, selectedSessionId: 'chat-a',
    sessions: [{ id: 'chat-a', backend: 'codex' }, { id: 'chat-b', backend: 'claude' }] as never,
    syncSessionId: 'chat-a', syncStatus: 'live' })
})
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
  AppState.__emitAppState('active')
})

test('hidden and unsupported views perform no reads, subscriptions, or mutations', async () => {
  const api = transport()
  await render({ visible: false })
  assert.equal(current.supported, true)
  assert.equal(current.available, false)
  await act(async () => { await current.submit('No invisible send'); await current.clear(); await current.stop('any') })
  await act(async () => {
    useAppStore.setState({ health: { ...health, capabilities: {} } })
    tree!.update(<Probe visible />)
  })
  assert.equal(current.supported, false)
  assert.deepEqual(api.calls, { reads: [], submits: [], stops: [], clears: [] })
  assert.equal(api.observers.size, 0)
})

test('initial live mount reads once; only own newer invalidations refresh', async () => {
  const api = transport()
  await render()
  assert.deepEqual(api.calls.reads, ['chat-a'])
  assert.equal(current.snapshot?.revision, 1)
  assert.equal(api.observers.size, 1)
  await act(async () => { api.emit('chat-b', 8); api.emit('chat-a', 1); api.emit('chat-a', 0) })
  assert.equal(api.calls.reads.length, 1)
  await act(async () => { api.emit('chat-a', 2) })
  assert.equal(api.calls.reads.length, 2)
  await act(async () => { tree!.update(<Probe />) })
  assert.equal(api.calls.reads.length, 2, 'ordinary rerenders must not poll')
})

test('background invalidations are silent; foreground reconciles once', async () => {
  const api = transport()
  await render()
  await act(async () => { AppState.__emitAppState('background'); api.emit('chat-a', 3); api.emit('chat-a', 4) })
  assert.equal(api.calls.reads.length, 1)
  await act(async () => { AppState.__emitAppState('active') })
  assert.equal(api.calls.reads.length, 2)
  assert.equal(current.error, null)
})

test('a view mounted while backgrounded defers its initial read until foreground', async () => {
  AppState.currentState = 'background'
  const api = transport()
  await render()
  assert.equal(api.calls.reads.length, 0, 'background mounting must not fetch side history')
  await act(async () => { AppState.__emitAppState('active') })
  assert.equal(api.calls.reads.length, 1)
  assert.equal(current.snapshot?.revision, 1)
})

test('live reconnect reconciles but repeated live status does not poll', async () => {
  const api = transport()
  await render()
  await act(async () => { useAppStore.setState({ syncStatus: 'reconnecting' }) })
  assert.equal(api.calls.reads.length, 1)
  await act(async () => { useAppStore.setState({ syncStatus: 'live' }) })
  assert.equal(api.calls.reads.length, 2)
  await act(async () => { useAppStore.setState({ syncStatus: 'live' }) })
  assert.equal(api.calls.reads.length, 2)
})

test('profile generation and client replacement fence pending history and remove old observers', async () => {
  const stale = deferred<SyncedSideChat>()
  const first = transport()
  first.connection.readSyncedSideChat = session => { first.calls.reads.push(session); return stale.promise }
  await render()
  let second!: ReturnType<typeof transport>
  await act(async () => {
    second = transport()
    second.connection.readSyncedSideChat = async session => { second.calls.reads.push(session); return document(7, session, 'side-second') }
    useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2,
      health: { ...health, server_identity: 'server-b', server_instance_id: 'instance-b' } })
  })
  assert.equal(first.observers.size, 0)
  assert.equal(second.observers.size, 1)
  assert.equal(current.snapshot?.side_chat_id, 'side-second')
  await act(async () => { stale.resolve(document(900, 'chat-a', 'side-stale')) })
  assert.equal(current.snapshot?.revision, 7)
  assert(!rendered.some(state => state.side === 'side-stale'))
  await act(async () => { first.emit('chat-a', 1000) })
  assert.equal(second.calls.reads.length, 1)
})

test('validation revocation blocks actions immediately and drops prior history on render', async () => {
  const api = transport()
  await render()
  const staleSubmit = current.submit
  Object.defineProperty(api.connection, 'isValidated', { value: false, configurable: true })
  Object.defineProperty(api.connection, 'validationRevision', { value: 2, configurable: true })
  await act(async () => { assert.equal(await staleSubmit('No stale send'), false); tree!.update(<Probe />) })
  assert.equal(current.available, false)
  assert.equal(current.snapshot, null)
  assert.equal(api.observers.size, 0)
  assert.equal(api.calls.submits.length, 0)
  Object.defineProperty(api.connection, 'isValidated', { value: true, configurable: true })
  await act(async () => { tree!.update(<Probe />) })
  assert.equal(api.calls.reads.length, 2)
  assert.equal(current.available, true)
})

test('session navigation never displays pending history from the previous chat', async () => {
  const stale = deferred<SyncedSideChat>()
  const api = transport()
  api.connection.readSyncedSideChat = async session => {
    api.calls.reads.push(session)
    return session === 'chat-a' ? stale.promise : document(2, session, 'side-b')
  }
  await render()
  await act(async () => {
    useAppStore.setState({ selectedSessionId: 'chat-b', syncSessionId: 'chat-b' })
    tree!.update(<Probe session="chat-b" />)
  })
  assert.equal(current.snapshot?.session_id, 'chat-b')
  await act(async () => { stale.resolve(document(9)) })
  assert.equal(current.snapshot?.side_chat_id, 'side-b')
  assert(!rendered.some(state => state.session === 'chat-b' && state.side === 'side-a'))
  assert.equal(api.observers.size, 1)
})

test('closing or unmounting during a submitted answer preserves remote work', async () => {
  const pending = deferred<SyncedSideChat>()
  const api = transport()
  api.connection.submitSyncedSideChat = (session, input) => { api.calls.submits.push([session, input]); return pending.promise }
  await render()
  let submitted!: Promise<boolean>
  await act(async () => { submitted = current.submit('Keep running') })
  assert.equal(current.mutating, true)
  await act(async () => { tree!.update(<Probe visible={false} />) })
  assert.equal(current.snapshot, null)
  assert.equal(api.observers.size, 0)
  await act(async () => {
    const request = api.calls.submits[0][1]
    pending.resolve({ ...document(2), exchanges: [{ request_id: request.request_id, question: request.question,
      status: 'running', created_at: 'now', updated_at: 'now' }] })
    assert.equal(await submitted, false)
    tree!.unmount(); tree = null
    AppState.__emitAppState('background'); AppState.__emitAppState('active')
  })
  assert.deepEqual(api.calls.stops, [])
  assert.deepEqual(api.calls.clears, [])
  assert.equal(api.calls.reads.length, 1)
})

for (const restoredInstance of ['instance-a', 'instance-after-restart']) test(`same-owner reconnect (${restoredInstance}) retains an uncertain receipt without a duplicate POST`, async () => {
  const api = transport()
  api.connection.submitSyncedSideChat = async (session, input) => {
    api.calls.submits.push([session, input])
    throw new Error('The acknowledgment connection was lost')
  }
  api.connection.readSyncedSideChat = async session => {
    api.calls.reads.push(session)
    if (api.calls.reads.length === 1) return document()
    if (api.calls.reads.length === 2) throw new Error('History reconciliation is temporarily unavailable')
    const submitted = api.calls.submits[0][1]
    return { ...document(3), last_request_id: submitted.request_id, exchanges: [{
      request_id: submitted.request_id, question: submitted.question, answer: 'The accepted answer',
      status: 'completed', created_at: 'now', updated_at: 'later',
    }] }
  }
  await render()
  await act(async () => { assert.equal(await current.submit('Question with uncertain acknowledgment'), false) })
  assert.equal(api.calls.submits.length, 1)
  assert.equal(api.calls.reads.length, 2, 'a lost acknowledgment gets one reconciliation, never automatic POST replay')
  const requestId = api.calls.submits[0][1].request_id
  await act(async () => {
    useAppStore.setState({ health: null, connected: false, connecting: true, syncStatus: 'reconnecting' })
  })
  assert.equal(current.available, false)
  assert.equal(current.snapshot, null, 'previous history must not remain visible without an authenticated scope')
  assert.equal(api.observers.size, 0)
  await act(async () => {
    useAppStore.setState({ health: { ...health, server_instance_id: restoredInstance }, connected: true, connecting: false, syncStatus: 'live' })
  })
  assert.equal(useAppStore.getState().profileGeneration, 1)
  assert.equal(current.snapshot?.last_request_id, requestId)
  assert.equal(current.snapshot?.exchanges[0].status, 'completed')
  assert.equal(api.calls.reads.length, 3)
  let accepted = false
  await act(async () => { accepted = await current.submit('Question with uncertain acknowledgment') })
  assert.equal(api.calls.submits.length, 1, 'explicit same-question retry must acknowledge the accepted receipt, not issue a new POST')
  assert.equal(accepted, true)
})

test('StrictMode effect replay cleans old listeners and ignores superseded read completion', async () => {
  const api = transport()
  const reads: Array<ReturnType<typeof deferred<SyncedSideChat>>> = []
  api.connection.readSyncedSideChat = session => {
    api.calls.reads.push(session)
    const pending = deferred<SyncedSideChat>()
    reads.push(pending)
    return pending.promise
  }
  await act(async () => { tree = create(<StrictMode><Probe /></StrictMode>) })
  assert.equal(api.observers.size, 1)
  assert.equal(reads.length, 2, 'React strict effects should exercise cleanup and reactivation')
  await act(async () => { reads[1].resolve(document(2, 'chat-a', 'side-current')) })
  assert.equal(current.snapshot?.side_chat_id, 'side-current')
  await act(async () => { reads[0].resolve(document(900, 'chat-a', 'side-retired')) })
  assert.equal(current.snapshot?.side_chat_id, 'side-current')
  assert(!rendered.some(state => state.side === 'side-retired'))
  await act(async () => { tree!.unmount(); tree = null })
  assert.equal(api.observers.size, 0)
  await act(async () => { AppState.__emitAppState('background'); AppState.__emitAppState('active'); api.emit('chat-a', 901) })
  assert.equal(api.calls.reads.length, 2)
  assert.deepEqual(api.calls.stops, [])
  assert.deepEqual(api.calls.clears, [])
})
