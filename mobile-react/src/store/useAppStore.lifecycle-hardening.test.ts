import assert from 'node:assert/strict'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import {
  subscribeProviderRuntimeChanged,
  type ProfileProviderRuntimeNotification,
} from '../lib/provider-runtime-events'
import type { Event, Session, Snapshot, StoredProfileSettings, WorkspacePreferences } from '../types'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

interface RequestRecord {
  method: string
  pathname: string
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }

  emitMessage(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

const timestamp = '2026-07-31T12:00:00.000Z'
const session: Session = {
  id: 'chat-1',
  title: 'Lifecycle regression',
  backend: 'claude',
  archived: false,
  created_at: timestamp,
  updated_at: timestamp,
  latest_event_seq: 5,
  latest_event_at: timestamp,
  latest_event_type: 'assistant_message',
  latest_agent_event_seq: 5,
  latest_agent_event_at: timestamp,
  latest_agent_event_type: 'assistant_message',
  last_read_agent_event_seq: 5,
  manual_unread: false,
}
const cachedEvent: Event = {
  seq: 5,
  id: 'event-5',
  session_id: session.id,
  type: 'assistant_message',
  ts: timestamp,
  text: 'Cached response',
}
const snapshot: Snapshot = {
  cacheVersion: SNAPSHOT_CACHE_VERSION,
  session,
  events: [cachedEvent],
  queuedTurns: [],
  files: [],
  filesTotal: 0,
  hasMore: false,
  total: 1,
  latestSeq: 5,
  nextBefore: null,
  semanticPaging: null,
  cachedAt: Date.now(),
}
const settings: StoredProfileSettings = {
  schemaVersion: 2,
  activeProfileId: 'profile-lifecycle',
  profiles: [{
    id: 'profile-lifecycle',
    name: 'Lifecycle',
    serverURL: 'https://lifecycle.example',
    serverIdentity: 'server-lifecycle',
    serverConfigured: true,
    credentialVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }],
  fontScale: 1,
}
const workspace: WorkspacePreferences = {
  selectedSessionId: session.id,
  folderOrder: [],
  collapsedFolders: [],
  drafts: {},
}

const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const originalSetInterval = globalThis.setInterval
const requests: RequestRecord[] = []
const firstHealthStarted = deferred<void>()
const firstHealthResponse = deferred<Response>()
let delayFirstHealth = true

try {
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()
  appState.__emitAppState('active')

  const cache = await import('../storage/cache')
  await cache.prepareSnapshotCacheGeneration()
  await cache.saveProfileSettings(settings)
  await cache.saveProfileToken('profile-lifecycle', 1, 'token-lifecycle')
  await cache.saveCachedSessions('server-lifecycle', [session])
  await cache.saveWorkspacePreferences('server-lifecycle', workspace)
  await cache.saveSnapshot('server-lifecycle', snapshot)

  globalThis.setInterval = (() => 1) as unknown as typeof setInterval
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = (async (input, init) => {
    const rawURL = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const url = new URL(rawURL)
    const method = init?.method ?? 'GET'
    requests.push({ method, pathname: url.pathname })

    if (url.pathname === '/api/health') {
      if (delayFirstHealth) {
        delayFirstHealth = false
        firstHealthStarted.resolve(undefined)
        return firstHealthResponse.promise
      }
      return jsonResponse({
        ok: true,
        server_identity: 'server-lifecycle',
        server_version: 'test-lifecycle',
        api_contract_version: 9,
        active_sessions: [],
      })
    }
    if (url.pathname === '/api/sessions') return jsonResponse({ sessions: [session] })
    if (url.pathname === '/api/runtime/catalog') return jsonResponse({ backends: {} })
    if (url.pathname === '/api/jobs') return jsonResponse({ jobs: [] })
    if (url.pathname === `/api/sessions/${session.id}`) {
      return jsonResponse({
        session,
        events: [],
        queued_turns: [],
        events_omitted_before: 0,
        events_omitted_after: 0,
        latest_seq: 5,
        event_count: 1,
      })
    }
    if (url.pathname === `/api/sessions/${session.id}/files`) {
      return jsonResponse({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
    }
    if (url.pathname === `/api/sessions/${session.id}/read`) return jsonResponse({ session })
    return new Response(JSON.stringify({ detail: `Unhandled test endpoint: ${url.pathname}` }), { status: 404 })
  }) as typeof fetch

  const { useAppStore } = await import('./useAppStore')
  const initialization = useAppStore.getState().initialize()
  await firstHealthStarted.promise
  appState.__emitAppState('background')
  firstHealthResponse.resolve(jsonResponse({
    ok: true,
    server_identity: 'server-lifecycle',
    server_version: 'test-lifecycle',
    api_contract_version: 9,
    active_sessions: [],
  }))
  await initialization
  await nextTurn()

  assert.deepEqual(
    requests.map(request => request.pathname),
    ['/api/health'],
    'backgrounding during health must stop launch before sessions, jobs, runtime, timeline, files, or streams start',
  )
  assert.equal(FakeWebSocket.instances.length, 0)
  assert.equal(useAppStore.getState().connecting, false)
  assert.equal(useAppStore.getState().connected, false)
  assert.equal(useAppStore.getState().liveConnected, false)

  appState.__emitAppState('active')
  await waitFor(
    () => FakeWebSocket.instances.length === 1
      && requests.filter(request => request.pathname === `/api/sessions/${session.id}`).length === 1
      && requests.filter(request => request.pathname === `/api/sessions/${session.id}/files`).length === 1,
    'foreground reconciliation did not reach one timeline, files, and stream request',
  )
  await nextTurn()
  await nextTurn()

  assert.equal(requests.filter(request => request.pathname === '/api/health').length, 2)
  assert.equal(requests.filter(request => request.pathname === '/api/sessions').length, 1)
  assert.equal(requests.filter(request => request.pathname === '/api/runtime/catalog').length, 1)
  assert.equal(requests.filter(request => request.pathname === '/api/jobs').length, 1)
  assert.equal(requests.filter(request => request.pathname === `/api/sessions/${session.id}`).length, 1)
  assert.equal(requests.filter(request => request.pathname === `/api/sessions/${session.id}/files`).length, 1)
  assert.equal(FakeWebSocket.instances.length, 1, 'foreground recovery must create one selected-session stream')
  assert.equal(
    requests.filter(request => request.pathname === `/api/sessions/${session.id}/read`).length,
    0,
    'an already-read session must not send a redundant read receipt during reconciliation',
  )

  const socket = FakeWebSocket.instances[0]
  const sessionsBeforeTrace = useAppStore.getState().sessions
  const profilesBeforeTrace = useAppStore.getState().profiles
  socket.emitMessage({
    seq: 6,
    id: 'reasoning-6',
    session_id: session.id,
    type: 'reasoning_summary',
    ts: timestamp,
    text: 'Inspecting lifecycle state',
  })
  socket.emitMessage({
    seq: 7,
    id: 'tool-7',
    session_id: session.id,
    type: 'tool_finished',
    ts: timestamp,
    text: 'Inspection complete',
  })
  assert.strictEqual(useAppStore.getState().sessions, sessionsBeforeTrace, 'passive trace packets must preserve session-list identity')
  assert.strictEqual(useAppStore.getState().profiles, profilesBeforeTrace, 'passive trace packets must preserve profile-list identity')
  assert.deepEqual(
    useAppStore.getState().snapshots[session.id]?.events.slice(-2).map(event => event.id),
    ['reasoning-6', 'tool-7'],
    'passive trace packets must still append to the selected timeline',
  )

  const runtimeNotifications: ProfileProviderRuntimeNotification[] = []
  const unsubscribeRuntime = subscribeProviderRuntimeChanged(notification => {
    runtimeNotifications.push(notification)
  })
  const snapshotBeforeRuntime = useAppStore.getState().snapshots[session.id]
  socket.emitMessage({
    type: 'provider_runtime_changed',
    session_id: session.id,
    backend: 'claude',
    runtime: 'context_usage',
    ephemeral: true,
    usage_generation: 7,
  })
  assert.equal(runtimeNotifications.length, 1, 'the selected stream must forward Claude runtime invalidations')
  assert.equal(runtimeNotifications[0]?.profileId, settings.activeProfileId, 'runtime invalidations must retain their profile fence')
  assert.equal(runtimeNotifications[0]?.profileGeneration, useAppStore.getState().profileGeneration, 'runtime invalidations must retain their profile-generation fence')
  assert.strictEqual(
    useAppStore.getState().snapshots[session.id],
    snapshotBeforeRuntime,
    'ephemeral runtime invalidations must not mutate the timeline snapshot',
  )

  const requestsBeforeExplicitMarkRead = requests.length
  const sessionsBeforeExplicitMarkRead = useAppStore.getState().sessions
  await useAppStore.getState().markRead(session.id)
  assert.equal(requests.length, requestsBeforeExplicitMarkRead)
  assert.strictEqual(useAppStore.getState().sessions, sessionsBeforeExplicitMarkRead)

  appState.__emitAppState('background')
  socket.emitMessage({
    type: 'provider_runtime_changed',
    session_id: session.id,
    backend: 'claude',
    runtime: 'context_usage',
    ephemeral: true,
    usage_generation: 8,
  })
  assert.equal(runtimeNotifications.length, 1, 'a stopped stale stream must not publish runtime invalidations')
  unsubscribeRuntime()

  console.log('store lifecycle, runtime invalidation, passive trace, and read-receipt regressions passed')
} finally {
  appState.__emitAppState('background')
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  globalThis.setInterval = originalSetInterval
}
