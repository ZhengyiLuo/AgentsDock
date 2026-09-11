import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { AppState as NativeAppState } from 'react-native'
import { AgentServerClientUnvalidatedError, ServerError } from '../api/AgentServerClient'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import { projectTimeline, rowText } from '../lib/timeline'
import type { AgentFile, Event, Health, QueuedTurn, Session, Snapshot, StoredProfileSettings, WorkspacePreferences } from '../types'

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

interface RequestRecord { path: string; token: string }

class MockAgentsServer {
  readonly requests: RequestRecord[] = []
  identity: string
  sessionTitle: string
  healthStatus = 200
  private readonly server: Server
  private nextSessionsGate: Deferred | null = null
  private nextSessionUpdateGate: { gate: Deferred; started: Deferred } | null = null
  private nextHealthGate: { gate: Deferred; started: Deferred } | null = null
  private nextSessionsStatus: number | null = null
  private nextRequestFailure: { path: string; status: number } | null = null
  private nextPendingUpdateFailurePath: string | null = null
  private sessionRequestCount = 0
  private sessionWaiters: Array<{ count: number; resolve(): void }> = []
  private baseURL = ''

  constructor(
    readonly label: string,
    readonly expectedToken: string,
    identity: string,
    sessionTitle: string,
  ) {
    this.identity = identity
    this.sessionTitle = sessionTitle
    this.server = createServer((request, response) => { void this.respond(request, response) })
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    assert(address && typeof address === 'object')
    this.baseURL = `http://127.0.0.1:${address.port}`
    return this.baseURL
  }

  delayNextSessions(): { started: Promise<void>; release(): void } {
    assert.equal(this.nextSessionsGate, null)
    const gate = deferred()
    const started = this.waitForSessionRequests(this.sessionRequestCount + 1)
    this.nextSessionsGate = gate
    return { started, release: gate.resolve }
  }

  delayNextHealth(): { started: Promise<void>; release(): void } {
    assert.equal(this.nextHealthGate, null)
    const gate = deferred()
    const started = deferred()
    this.nextHealthGate = { gate, started }
    return { started: started.promise, release: gate.resolve }
  }

  delayNextSessionUpdate(): { started: Promise<void>; release(): void } {
    assert.equal(this.nextSessionUpdateGate, null)
    const gate = deferred()
    const started = deferred()
    this.nextSessionUpdateGate = { gate, started }
    return { started: started.promise, release: gate.resolve }
  }

  rejectNextSessions(status = 401): void {
    assert.equal(this.nextSessionsStatus, null)
    this.nextSessionsStatus = status
  }

  rejectNextRequest(path: string, status = 401): void {
    assert.equal(this.nextRequestFailure, null)
    this.nextRequestFailure = { path, status }
  }

  rejectNextForPendingUpdate(path: string): void {
    assert.equal(this.nextPendingUpdateFailurePath, null)
    this.nextPendingUpdateFailurePath = path
  }

  sessionRequests(): number { return this.sessionRequestCount }

  async close(): Promise<void> {
    this.nextSessionsGate?.resolve()
    this.nextSessionUpdateGate?.gate.resolve()
    this.nextHealthGate?.gate.resolve()
    this.server.closeAllConnections?.()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private waitForSessionRequests(count: number): Promise<void> {
    if (this.sessionRequestCount >= count) return Promise.resolve()
    return new Promise(resolve => this.sessionWaiters.push({ count, resolve }))
  }

  private noteSessionRequest(): void {
    this.sessionRequestCount += 1
    const ready = this.sessionWaiters.filter(waiter => this.sessionRequestCount >= waiter.count)
    this.sessionWaiters = this.sessionWaiters.filter(waiter => this.sessionRequestCount < waiter.count)
    for (const waiter of ready) waiter.resolve()
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseURL || 'http://127.0.0.1')
    const token = typeof request.headers['x-zenithdock-token'] === 'string' ? request.headers['x-zenithdock-token'] : ''
    this.requests.push({ path: url.pathname, token })
    if (token !== this.expectedToken) {
      writeJSON(response, 401, { detail: `${this.label} rejected a foreign token` })
      return
    }
    if (this.nextRequestFailure?.path === url.pathname) {
      const failure = this.nextRequestFailure
      this.nextRequestFailure = null
      writeJSON(response, failure.status, { detail: `${this.label} authentication expired` })
      return
    }
    if (this.nextPendingUpdateFailurePath === url.pathname) {
      this.nextPendingUpdateFailurePath = null
      writeJSON(response, 409, {
        detail: {
          code: 'server_update_pending',
          message: 'AgentsServer is waiting for current work to finish before a managed update.',
          action: 'Let active work finish or cancel the scheduled update.',
          retryable: true,
        },
      })
      return
    }

    if (url.pathname === '/api/health') {
      const delayed = this.nextHealthGate
      this.nextHealthGate = null
      if (delayed) {
        delayed.started.resolve()
        await delayed.gate.promise
        if (response.destroyed) return
      }
      if (this.healthStatus !== 200) {
        writeJSON(response, this.healthStatus, { detail: `${this.label} is offline` })
        return
      }
      writeJSON(response, 200, {
        ok: true,
        server_identity: this.identity,
        server_version: `test-${this.label}`,
        api_contract_version: 8,
        active_sessions: [],
      })
      return
    }

    if (url.pathname === '/api/sessions') {
      this.noteSessionRequest()
      const gate = this.nextSessionsGate
      this.nextSessionsGate = null
      const responseTitle = this.sessionTitle
      if (gate) await gate.promise
      if (response.destroyed) return
      const status = this.nextSessionsStatus
      this.nextSessionsStatus = null
      if (status !== null && status !== 200) {
        writeJSON(response, status, { detail: `${this.label} authentication expired` })
        return
      }
      writeJSON(response, 200, { sessions: [serverSession(this.label, responseTitle)] })
      return
    }

    if (request.method === 'PATCH' && url.pathname === '/api/sessions/shared-session') {
      const body = await readJSONBody(request)
      if (typeof body.title === 'string') this.sessionTitle = body.title
      const delayed = this.nextSessionUpdateGate
      this.nextSessionUpdateGate = null
      if (delayed) {
        delayed.started.resolve()
        await delayed.gate.promise
      }
      writeJSON(response, 200, {
        session: serverSession(this.label, this.sessionTitle, '2026-07-18T12:00:01Z'),
      })
      return
    }

    if (url.pathname === '/api/runtime/catalog') {
      writeJSON(response, 200, { backends: {} })
      return
    }
    if (url.pathname === '/api/jobs') {
      writeJSON(response, 200, { jobs: [] })
      return
    }
    writeJSON(response, 404, { detail: `Unhandled test endpoint: ${url.pathname}` })
  }
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readJSONBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function serverSession(label: string, title: string, updatedAt = '2026-07-18T12:00:00Z'): Session {
  return {
    id: 'shared-session',
    title,
    backend: 'codex',
    codex_thread_id: `thread-${label}`,
    archived: true,
    created_at: label === 'a' ? '2026-07-18T10:00:00Z' : '2026-07-18T11:00:00Z',
    updated_at: updatedAt,
  }
}

function workspace(draft: string): WorkspacePreferences {
  return {
    selectedSessionId: null,
    folderOrder: [],
    collapsedFolders: [],
    drafts: { 'shared-session': draft },
  }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function after(milliseconds: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), milliseconds))
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const serverA = new MockAgentsServer('a', 'token-a', 'server-a', 'A live')
const serverB = new MockAgentsServer('b', 'token-b', 'server-b', 'B live')
const originalSetInterval = globalThis.setInterval
let refreshTick: () => void = () => {}

try {
  const [serverURLA, serverURLB] = await Promise.all([serverA.listen(), serverB.listen()])
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()

  const cache = await import('../storage/cache')
  const timestamp = '2026-07-18T12:00:00.000Z'
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'profile-a',
    profiles: [
      {
        id: 'profile-a', name: 'Alpha', serverURL: serverURLA, serverIdentity: 'server-a', serverConfigured: true,
        credentialVersion: 1,
        createdAt: timestamp, updatedAt: timestamp,
      },
      {
        id: 'profile-b', name: 'Beta', serverURL: serverURLB, serverIdentity: 'server-b', serverConfigured: true,
        credentialVersion: 1,
        createdAt: timestamp, updatedAt: timestamp,
      },
    ],
    fontScale: 1,
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))
  await SecureStore.setItemAsync(cache.profileTokenKey('profile-a', 1), 'token-a')
  await SecureStore.setItemAsync(cache.profileTokenKey('profile-b', 1), 'token-b')
  await cache.saveCachedSessions('server-a', [serverSession('a', 'A cached')])
  await cache.saveCachedSessions('server-b', [serverSession('b', 'B cached')])
  await cache.saveWorkspacePreferences('server-a', workspace('draft-a'))
  await cache.saveWorkspacePreferences('server-b', workspace('draft-b'))

  // The production lifecycle owns a recurring refresh. The integration test
  // drives refreshes explicitly and must not leave a timer holding Node open.
  globalThis.setInterval = ((handler: TimerHandler) => {
    refreshTick = typeof handler === 'function' ? () => { handler() } : () => {}
    return 1
  }) as unknown as typeof setInterval
  const storeModule = await import('./useAppStore')
  const { useAppStore } = storeModule
  await useAppStore.getState().initialize()
  await nextTurn()

  let state = useAppStore.getState()
  assert.equal(state.activeProfileId, 'profile-a')
  assert.equal(state.connected, true)
  assert.equal(state.selectedSessionId, null)
  assert.equal(state.sessions[0]?.id, 'shared-session')
  assert.equal(state.sessions[0]?.title, 'A live')
  assert.equal(state.sessions[0]?.codex_thread_id, 'thread-a')
  assert.equal(state.drafts['shared-session'], 'draft-a')
  assert.equal(state.token, 'token-a')
  assert(serverA.requests.length > 0)
  assert(serverA.requests.every(request => request.token === 'token-a'))
  assert.equal((Notifications as typeof Notifications & { __notificationPermissionRequests(): number }).__notificationPermissionRequests(), 1)
  const generationA = state.profileGeneration

  state.setSessionDraft('shared-session', 'draft-a-live')
  await nextTurn()
  serverA.sessionTitle = 'A delayed response'
  const delayedGate = serverA.delayNextSessions()
  const delayedARefresh = useAppStore.getState().refreshSessions()
  await delayedGate.started
  const sessionRequestsWhileBlocked = serverA.sessionRequests()
  const coalescedARefresh = useAppStore.getState().refreshSessions()
  await nextTurn()
  assert.equal(serverA.sessionRequests(), sessionRequestsWhileBlocked, 'overlapping refresh triggers must share one health/session operation')

  const switchedToB = await useAppStore.getState().switchServerProfile('profile-b')
  assert.equal(switchedToB, true)
  delayedGate.release()
  await Promise.all([delayedARefresh, coalescedARefresh])
  await waitFor(() => {
    const current = useAppStore.getState()
    return current.activeProfileId === 'profile-b'
      && current.connected
      && current.sessions[0]?.title === 'B live'
  }, 'Beta should validate and replace its cached session list in the background')

  state = useAppStore.getState()
  assert.equal(state.activeProfileId, 'profile-b')
  assert.equal(state.connected, true)
  assert.equal(state.sessions[0]?.id, 'shared-session')
  assert.equal(state.sessions[0]?.title, 'B live')
  assert.equal(state.sessions[0]?.codex_thread_id, 'thread-b')
  assert.notEqual(state.sessions[0]?.title, 'A delayed response')
  assert.equal(state.drafts['shared-session'], 'draft-b')
  assert.equal(state.token, 'token-b')
  assert(serverB.requests.length > 0)
  assert(serverB.requests.every(request => request.token === 'token-b'))

  const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
  appState.__emitAppState('background')
  const backgroundRequestCount = serverB.requests.length
  for (let minute = 0; minute < 5; minute += 1) refreshTick()
  await nextTurn()
  assert.equal(serverB.requests.length, backgroundRequestCount, 'background refresh ticks must perform no network work')
  appState.__emitAppState('active')
  await waitFor(() => serverB.requests.length > backgroundRequestCount, 'foregrounding should perform one reconciliation refresh')
  await useAppStore.getState().refreshSessions()

  // A session-list request snapshots its response before a local PATCH. Its
  // late payload must not roll back the accepted title after PATCH completion.
  const staleAfterCompletionGate = serverB.delayNextSessions()
  const staleAfterCompletionRefresh = useAppStore.getState().refreshSessions()
  await staleAfterCompletionGate.started
  assert.equal(
    await useAppStore.getState().updateSession(
      'shared-session',
      { title: 'B saved after read' },
      useAppStore.getState().profileGeneration,
    ),
    true,
  )
  staleAfterCompletionGate.release()
  await staleAfterCompletionRefresh
  assert.equal(
    useAppStore.getState().sessions[0]?.title,
    'B saved after read',
    'a late session refresh must not overwrite a completed session mutation',
  )

  // The same stale read is also fenced while the PATCH response is pending.
  const staleWhilePendingGate = serverB.delayNextSessions()
  const staleWhilePendingRefresh = useAppStore.getState().refreshSessions()
  await staleWhilePendingGate.started
  const delayedUpdateGate = serverB.delayNextSessionUpdate()
  const delayedUpdate = useAppStore.getState().updateSession(
    'shared-session',
    { title: 'B pending edit' },
    useAppStore.getState().profileGeneration,
  )
  await delayedUpdateGate.started
  staleWhilePendingGate.release()
  await staleWhilePendingRefresh
  assert.equal(
    useAppStore.getState().sessions[0]?.title,
    'B pending edit',
    'a late session refresh must not overwrite a pending optimistic mutation',
  )
  delayedUpdateGate.release()
  assert.equal(await delayedUpdate, true)
  assert.equal(useAppStore.getState().sessions[0]?.title, 'B pending edit')

  // Restore the fixture baseline and let an echoing read retire its guard.
  assert.equal(
    await useAppStore.getState().updateSession(
      'shared-session',
      { title: 'B live' },
      useAppStore.getState().profileGeneration,
    ),
    true,
  )
  await useAppStore.getState().refreshSessions()
  assert.equal(useAppStore.getState().sessions[0]?.title, 'B live')

  const requestsBeforeStaleMutation = serverB.requests.length
  assert.equal(
    await useAppStore.getState().updateSession('shared-session', { title: 'Stale Alpha edit' }, generationA),
    false,
    'a stale session edit must report that it was not saved',
  )
  useAppStore.getState().setFolderOrder(['Stale Alpha folder'], generationA)
  assert.equal(serverB.requests.length, requestsBeforeStaleMutation)
  assert.equal(useAppStore.getState().sessions[0]?.title, 'B live')
  assert.equal(JSON.stringify(useAppStore.getState().folderOrder), '[]')
  useAppStore.getState().clearError()

  // Hold identity acceptance behind a profile mutation after Beta's health
  // response has succeeded. A newer authenticated rejection must win when the
  // queued health result is eventually allowed to continue.
  const profileProbeGate = serverA.delayNextHealth()
  const blockingProfileUpdate = useAppStore.getState().updateServerProfile('profile-a', { serverIdentity: 'server-a' })
  await profileProbeGate.started
  const bHealthRequestsBeforeStaleResult = serverB.requests.filter(request => request.path === '/api/health').length
  const staleHealthRefresh = useAppStore.getState().refreshRuntime()
  await waitFor(
    () => serverB.requests.filter(request => request.path === '/api/health').length > bHealthRequestsBeforeStaleResult,
    'Beta stale health request should reach the server',
  )
  assert.equal(await Promise.race([staleHealthRefresh.then(() => 'completed' as const), after(50)]), 'timeout')
  const revisionBeforeAuthenticationRejection = storeModule.client.validationRevision
  serverB.rejectNextSessions(401)
  let authenticationRejection: unknown = null
  try {
    await storeModule.client.sessions()
  } catch (error) {
    authenticationRejection = error
  }
  assert(authenticationRejection instanceof Error)
  assert.match(authenticationRejection.message, /authentication expired/i)
  const rejectedAuthenticationRevision = storeModule.client.validationRevision
  assert(rejectedAuthenticationRevision > revisionBeforeAuthenticationRejection)
  assert.equal(storeModule.client.isValidated, false, 'Direct authenticated rejection should revoke the active client')
  state = useAppStore.getState()
  assert.equal(state.connected, false, 'The client authorization hook should immediately force the active profile offline')
  assert.equal(state.profiles.find(profile => profile.id === 'profile-b')?.connectionState, 'offline')

  profileProbeGate.release()
  await blockingProfileUpdate
  await staleHealthRefresh
  assert.equal(storeModule.client.isValidated, false, 'Queued stale health acceptance must not restore validation')
  assert.equal(storeModule.client.validationRevision, rejectedAuthenticationRevision, 'Stale health acceptance must not advance the auth revision')

  await useAppStore.getState().reconnect()
  assert.equal(useAppStore.getState().connected, true)
  assert.equal(storeModule.client.isValidated, true)

  const overlappingHealthGate = serverB.delayNextHealth()
  const overlappingReconnect = useAppStore.getState().reconnect()
  await overlappingHealthGate.started
  await useAppStore.getState().refreshSessions()
  assert.equal(storeModule.client.isValidated, true, 'A sibling health validation should validate the shared revocation epoch')
  overlappingHealthGate.release()
  await overlappingReconnect
  assert.equal(useAppStore.getState().connected, true, 'A later sibling health result must not undo an already successful validation')
  assert.equal(storeModule.client.isValidated, true)

  const mismatchedReconnectGate = serverB.delayNextHealth()
  const mismatchedReconnect = useAppStore.getState().reconnect()
  await mismatchedReconnectGate.started
  await useAppStore.getState().refreshSessions()
  assert.equal(storeModule.client.isValidated, true)
  serverB.identity = 'overlap-mismatch'
  mismatchedReconnectGate.release()
  await mismatchedReconnect
  state = useAppStore.getState()
  assert.equal(state.connected, false, 'A later reconnect identity failure should override sibling validation')
  assert.equal(storeModule.client.isValidated, false, 'Reconnect identity failure must revoke sibling validation')
  assert.match(state.error ?? '', /identity mismatch/i)
  serverB.identity = 'server-b'
  await useAppStore.getState().reconnect()
  assert.equal(useAppStore.getState().connected, true)
  assert.equal(storeModule.client.isValidated, true)

  const titleBeforeMutationRejection = useAppStore.getState().sessions[0]?.title
  serverB.rejectNextRequest('/api/sessions/shared-session', 401)
  assert.equal(
    await useAppStore.getState().updateSession('shared-session', { title: 'Rejected edit' }, useAppStore.getState().profileGeneration),
    false,
    'a rejected session edit must report failure after rolling back',
  )
  state = useAppStore.getState()
  assert.equal(state.connected, false, 'An authenticated mutation rejection should immediately disconnect the store')
  assert.equal(state.profiles.find(profile => profile.id === 'profile-b')?.connectionState, 'offline')
  assert.equal(storeModule.client.isValidated, false)
  assert.equal(state.sessions[0]?.title, titleBeforeMutationRejection, 'A rejected optimistic edit should roll back')

  await useAppStore.getState().reconnect()
  assert.equal(useAppStore.getState().connected, true)
  assert.equal(storeModule.client.isValidated, true)

  serverB.rejectNextSessions(401)
  await useAppStore.getState().refreshSessions()
  state = useAppStore.getState()
  assert.equal(state.connected, false, 'Authenticated sessions rejection should immediately disconnect the store')
  assert.equal(storeModule.client.isValidated, false, 'Authenticated sessions rejection should leave the store client unvalidated')
  assert.match(state.error ?? '', /authentication|token|validat/i)

  await useAppStore.getState().reconnect()
  assert.equal(useAppStore.getState().connected, true)
  assert.equal(storeModule.client.isValidated, true)

  const bRuntimeBeforeMismatch = serverB.requests.filter(request => request.path === '/api/runtime/catalog').length
  serverB.identity = 'foreign-server'
  await useAppStore.getState().refreshRuntime()
  state = useAppStore.getState()
  assert.equal(serverB.requests.filter(request => request.path === '/api/runtime/catalog').length, bRuntimeBeforeMismatch)
  assert.equal(state.connected, false)
  assert.equal(storeModule.client.isValidated, false)
  assert.match(state.error ?? '', /identity mismatch/i)
  assert.equal(state.sessions[0]?.title, 'B live')

  serverB.identity = 'server-b'
  await useAppStore.getState().reconnect()
  state = useAppStore.getState()
  assert.equal(state.connected, true)
  assert.equal(storeModule.client.isValidated, true)

  serverB.healthStatus = 401
  await useAppStore.getState().refreshSessions()
  state = useAppStore.getState()
  assert.equal(state.connected, false)
  assert.equal(storeModule.client.isValidated, false)
  assert.match(state.error ?? '', /offline/i)
  serverB.healthStatus = 200
  await useAppStore.getState().reconnect()
  assert.equal(useAppStore.getState().connected, true)
  assert.equal(storeModule.client.isValidated, true)

  const delayedReconnectSessions = serverB.delayNextSessions()
  const reconnectWithSlowSessionList = useAppStore.getState().reconnect()
  await delayedReconnectSessions.started
  state = useAppStore.getState()
  assert.equal(storeModule.client.isValidated, true, 'health identity must be validated before the session list starts')
  assert.equal(state.connected, true)
  assert.equal(state.connecting, false, 'a slow session list must not keep the composer disabled after health validation')
  delayedReconnectSessions.release()
  await reconnectWithSlowSessionList

  // Store-level send gates survive component unmounts, prevent double posts,
  // reconcile Run now against the authoritative queue, and never omit an
  // upload that is still in flight.
  const activeClient = storeModule.client
  const originalSendTurn = activeClient.sendTurn
  const originalUpload = activeClient.upload
  const originalStopTurn = activeClient.stopTurn
  const originalReloadProvider = activeClient.reloadProvider
  const originalRunQueuedNow = activeClient.runQueuedNow
  const originalRemoveQueued = activeClient.removeQueued
  const originalQueue = activeClient.queue
  const originalSessionPage = activeClient.sessionPage
  const originalSearchSessions = activeClient.searchSessions
  const originalRunTrace = activeClient.runTrace
  const originalJobRuns = activeClient.jobRuns
  const originalFiles = activeClient.files
  const originalCreateSession = activeClient.createSession
  const originalServerUpdateStatus = activeClient.serverUpdateStatus
  const originalCancelServerUpdate = activeClient.cancelServerUpdate
  const originalSelectSession = useAppStore.getState().selectSession
  const originalSyncSelectedSession = useAppStore.getState().syncSelectedSession
  const sendGate = deferred()
  const sendStarted = deferred()
  let sendCalls = 0
  let runNowCalls = 0
  const liveSession = { ...serverSession('b', 'B live'), archived: false }
  const sendSnapshot: Snapshot = {
    cacheVersion: SNAPSHOT_CACHE_VERSION,
    session: liveSession,
    events: [],
    queuedTurns: [],
    files: [],
    filesTotal: 0,
    hasMore: false,
    latestSeq: 0,
    cachedAt: Date.now(),
  }
  try {
    const fileGeneration = useAppStore.getState().profileGeneration
    const firstFilePageGate = deferred()
    const filePageCalls: Array<{ sessionId: string; offset: number; limit: number }> = []
    let failFirstAppend = true
    activeClient.files = async (sessionId, offset = 0, limit = 60) => {
      filePageCalls.push({ sessionId, offset, limit })
      if (offset === 0) {
        await firstFilePageGate.promise
        return {
          files: [
            { id: 'file-page-1', session_id: sessionId, filename: 'one.png', content_type: 'image/png', size: 1 },
            { id: 'file-page-2', session_id: sessionId, filename: 'two.png', content_type: 'image/png', size: 2 },
          ],
          total: 3,
          offset,
          limit,
          has_more: true,
        }
      }
      if (offset === 2 && failFirstAppend) {
        failFirstAppend = false
        throw new Error('file metadata temporarily unavailable')
      }
      assert.equal(offset, 2)
      return {
        files: [{ id: 'file-page-3', session_id: sessionId, filename: 'three.pdf', content_type: 'application/pdf', size: 3 }],
        total: 3,
        offset,
        limit,
        has_more: false,
      }
    }
    useAppStore.setState({
      sessions: [liveSession],
      selectedSessionId: 'shared-session',
      snapshots: { 'shared-session': sendSnapshot },
      filePaging: {},
      error: null,
    })
    const firstFilePage = useAppStore.getState().refreshFiles('shared-session', false, fileGeneration)
    const coalescedFirstFilePage = useAppStore.getState().refreshFiles('shared-session', true, fileGeneration)
    assert.equal(firstFilePage, coalescedFirstFilePage, 'initial refresh and early Load more must share one request')
    assert.equal(useAppStore.getState().filePaging['shared-session']?.loading, true)
    await waitFor(() => filePageCalls.length === 1, 'the initial file page should reach the client')
    assert.deepEqual(filePageCalls[0], { sessionId: 'shared-session', offset: 0, limit: 60 })
    firstFilePageGate.resolve()
    await Promise.all([firstFilePage, coalescedFirstFilePage])
    assert.equal(useAppStore.getState().snapshots['shared-session']?.files.length, 2)
    assert.equal(useAppStore.getState().snapshots['shared-session']?.filesTotal, 3)
    assert.deepEqual(useAppStore.getState().filePaging['shared-session'], {
      loading: false,
      hasMore: true,
      nextOffset: 2,
      error: null,
      retryAppend: true,
    })

    const failingAppend = useAppStore.getState().refreshFiles('shared-session', true, fileGeneration)
    const coalescedFailingAppend = useAppStore.getState().refreshFiles('shared-session', true, fileGeneration)
    assert.equal(failingAppend, coalescedFailingAppend, 'double tapping Load more must not duplicate an offset')
    await Promise.all([failingAppend, coalescedFailingAppend])
    assert.deepEqual(filePageCalls.map(call => call.offset), [0, 2])
    assert.match(useAppStore.getState().filePaging['shared-session']?.error ?? '', /temporarily unavailable/)
    assert.equal(useAppStore.getState().filePaging['shared-session']?.nextOffset, 2, 'a failed page must keep its retry cursor')
    assert.equal(useAppStore.getState().filePaging['shared-session']?.loading, false)

    await useAppStore.getState().refreshFiles('shared-session', true, fileGeneration)
    assert.deepEqual(filePageCalls.map(call => call.offset), [0, 2, 2], 'retry must resume the failed offset without skipping files')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.files.length, 3)
    assert.equal(useAppStore.getState().filePaging['shared-session']?.hasMore, false)
    assert.equal(useAppStore.getState().filePaging['shared-session']?.nextOffset, 3)
    assert.equal(useAppStore.getState().filePaging['shared-session']?.error, null)
    await useAppStore.getState().refreshFiles('shared-session', true, fileGeneration)
    assert.equal(filePageCalls.length, 3, 'an exhausted file list must not request another offset')
    activeClient.files = originalFiles

    let createCalls = 0
    let selectedCreatedSession: string | null = null
    activeClient.createSession = async input => {
      createCalls += 1
      return { ...liveSession, id: 'created-session', title: input.title }
    }
    useAppStore.setState({
      sessions: [liveSession],
      selectedSessionId: null,
      selectSession: async (sessionId, expectedGeneration) => {
        assert.equal(expectedGeneration, useAppStore.getState().profileGeneration)
        selectedCreatedSession = sessionId
        useAppStore.setState({ selectedSessionId: sessionId })
      },
      error: null,
    })
    assert.equal(await useAppStore.getState().createSession({
      title: 'Created from mobile',
      folder: 'General',
      cwd: '/tmp',
      backend: 'codex',
      model: '',
      effort: '',
      system_prompt: null,
    }, useAppStore.getState().profileGeneration), true)
    assert.equal(createCalls, 1)
    assert.equal(selectedCreatedSession, 'created-session')
    assert.equal(useAppStore.getState().selectedSessionId, 'created-session')
    assert.equal(useAppStore.getState().sessions.some(session => session.id === 'created-session'), true)

    activeClient.createSession = async () => { throw new Error('create rejected') }
    assert.equal(await useAppStore.getState().createSession({
      title: 'Rejected mobile chat',
      folder: 'General',
      cwd: '/tmp',
      backend: 'codex',
      model: '',
      effort: '',
      system_prompt: null,
    }, useAppStore.getState().profileGeneration), false)
    assert.match(useAppStore.getState().error ?? '', /create rejected/)
    activeClient.createSession = originalCreateSession
    useAppStore.setState({
      sessions: [liveSession],
      selectedSessionId: 'shared-session',
      selectSession: originalSelectSession,
      error: null,
    })

    let recoverySyncs = 0
    activeClient.reloadProvider = async sessionId => ({
      session: { ...liveSession, id: sessionId, backend_locked: true },
      reloaded: true,
      message: 'Codex reloaded.',
    })
    useAppStore.setState({
      snapshots: { 'shared-session': sendSnapshot },
      activeSessionIds: new Set(),
      sendingSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      turnAdmissionTokens: {},
      syncSelectedSession: async reason => { if (reason === 'recovery') recoverySyncs += 1 },
    })
    const reloadResult = await useAppStore.getState().reloadProvider('shared-session', useAppStore.getState().profileGeneration)
    assert.equal(reloadResult?.reloaded, true, 'provider reload should return the structured server acknowledgement')
    assert.equal(useAppStore.getState().sessions[0]?.backend_locked, true, 'provider reload should publish the returned session contract')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.session.backend_locked, true, 'provider reload should update the loaded snapshot session')
    await Promise.resolve()
    assert.equal(recoverySyncs, 1, 'provider reload should reconcile the selected timeline once')
    activeClient.reloadProvider = originalReloadProvider
    useAppStore.setState({ syncSelectedSession: originalSyncSelectedSession })

    const staleSearchGate = deferred()
    const staleSearchStarted = deferred()
    let searchCalls = 0
    activeClient.searchSessions = async query => {
      searchCalls += 1
      staleSearchStarted.resolve()
      await staleSearchGate.promise
      return [{
        session_id: 'shared-session',
        event_id: 'stale-search-hit',
        seq: 1,
        role: 'user',
        snippet: `Stale ${query}`,
      }]
    }
    useAppStore.setState({
      searchResults: [{
        session_id: 'shared-session',
        event_id: 'existing-search-hit',
        seq: 1,
        role: 'user',
        snippet: 'Existing',
      }],
      searchBusy: true,
      searchError: null,
      error: null,
    })
    await useAppStore.getState().search(' x ')
    assert.equal(searchCalls, 0, 'one-character search must remain local and never reach the server')
    assert.equal(useAppStore.getState().searchBusy, false)
    assert.equal(useAppStore.getState().searchResults.length, 0)
    assert.equal(useAppStore.getState().searchError, null)
    assert.equal(useAppStore.getState().error, null)

    useAppStore.setState({
      searchResults: [{
        session_id: 'shared-session',
        event_id: 'previous-valid-search-hit',
        seq: 1,
        role: 'assistant',
        snippet: 'Previous valid query',
      }],
    })
    const staleSearch = useAppStore.getState().search('first')
    assert.equal(useAppStore.getState().searchResults.length, 0, 'starting a replacement search must hide previous-query results immediately')
    await staleSearchStarted.promise
    assert.equal(useAppStore.getState().searchBusy, true)
    useAppStore.getState().clearSearch()
    staleSearchGate.resolve()
    await staleSearch
    assert.equal(useAppStore.getState().searchBusy, false)
    assert.equal(useAppStore.getState().searchError, null)
    assert.equal(useAppStore.getState().searchResults.length, 0, 'clearing search must reject a slow obsolete response')

    activeClient.searchSessions = async query => {
      searchCalls += 1
      return [{
        session_id: 'shared-session',
        event_id: 'current-search-hit',
        seq: 2,
        role: 'assistant',
        snippet: `Current ${query}`,
      }]
    }
    await useAppStore.getState().search(' ok ')
    assert.equal(searchCalls, 2)
    assert.equal(useAppStore.getState().searchResults[0]?.snippet, 'Current ok')
    assert.equal(useAppStore.getState().searchBusy, false)

    activeClient.searchSessions = async () => {
      throw new Error('[{"type":"string_too_short","loc":["query","q"]}]')
    }
    useAppStore.setState({ error: null })
    await useAppStore.getState().search('valid query')
    assert.equal(useAppStore.getState().searchBusy, false)
    assert.equal(useAppStore.getState().searchResults.length, 0)
    assert.match(useAppStore.getState().searchError ?? '', /string_too_short/)
    assert.equal(useAppStore.getState().error, null, 'background search failures must not occupy the global error banner')

    activeClient.searchSessions = async () => {
      throw new AgentServerClientUnvalidatedError()
    }
    await useAppStore.getState().search('still valid')
    assert.equal(useAppStore.getState().searchBusy, false, 'a current-scope validation failure must not strand the search spinner')
    assert.equal(useAppStore.getState().searchResults.length, 0)
    assert.match(useAppStore.getState().searchError ?? '', /validat|connection/i)
    assert.equal(useAppStore.getState().error, null)

    activeClient.jobRuns = async (sessionId, jobId, beforeSeq, limit) => ({
      runs: [{
        id: 'job-run-history',
        session_id: sessionId,
        seq: beforeSeq ?? 20,
        type: 'turn_finished',
        ts: timestamp,
        run_id: 'job-run-1',
        job_id: jobId,
        result_text: 'Historical result',
        raw: 'private transport payload',
      }],
      total: limit ?? 20,
      has_more: true,
      next_before: 7,
      supported: true,
    })
    const jobRunPage = await useAppStore.getState().loadJobRuns('shared-session', 'job-1', 18, 9, useAppStore.getState().profileGeneration)
    assert.equal(jobRunPage.supported, true)
    assert.equal(jobRunPage.total, 9)
    assert.equal(jobRunPage.runs[0]?.result_text, 'Historical result')
    assert.equal(jobRunPage.runs[0]?.raw, undefined, 'lazy run history must receive the same memory sanitization as timeline events')

    activeClient.jobRuns = async () => {
      throw new ServerError(404, 'Endpoint unavailable')
    }
    const unsupportedJobRuns = await useAppStore.getState().loadJobRuns('shared-session', 'job-1', null, 20, useAppStore.getState().profileGeneration)
    assert.equal(unsupportedJobRuns.supported, false, 'older servers should fall back to bundled run history')
    assert.equal(unsupportedJobRuns.runs.length, 0)

    const selectedBeforeTrace = useAppStore.getState().selectedSessionId
    useAppStore.setState({ selectedSessionId: 'shared-session' })
    let traceCalls = 0
    let traceArguments: [string, string, number, number, number] | null = null
    activeClient.runTrace = async (sessionId, runId, anchorSeq, afterSeq, limit) => {
      traceCalls += 1
      traceArguments = [sessionId, runId, anchorSeq, afterSeq ?? 0, limit ?? 160]
      return {
        events: [{
          id: 'trace-detail',
          session_id: sessionId,
          seq: 19,
          type: 'reasoning_summary',
          ts: timestamp,
          run_id: runId,
          text: 'Loaded the full reasoning trace',
          raw: 'private transport payload',
        }],
        has_more: true,
        next_after: 19,
      }
    }
    const tracePage = await useAppStore.getState().loadRunTrace(
      'shared-session',
      'run-1',
      25,
      12,
      40,
      useAppStore.getState().profileGeneration,
    )
    assert.equal(JSON.stringify(traceArguments), JSON.stringify(['shared-session', 'run-1', 25, 12, 40]))
    assert.equal(tracePage.events[0]?.text, 'Loaded the full reasoning trace')
    assert.equal(tracePage.events[0]?.raw, undefined, 'lazy trace detail must receive timeline memory sanitization')
    assert.equal(tracePage.has_more, true)
    assert.equal(tracePage.next_after, 19)

    let obsoleteTraceError: unknown = null
    try {
      await useAppStore.getState().loadRunTrace(
        'another-session',
        'run-1',
        25,
        0,
        40,
        useAppStore.getState().profileGeneration,
      )
    } catch (error) {
      obsoleteTraceError = error
    }
    assert(obsoleteTraceError instanceof Error)
    assert.match(obsoleteTraceError.message, /no longer selected/)
    assert.equal(traceCalls, 1, 'trace detail for an obsolete chat must not reach the server')

    const staleTraceGate = deferred()
    const staleTraceStarted = deferred()
    activeClient.runTrace = async sessionId => {
      staleTraceStarted.resolve()
      await staleTraceGate.promise
      return {
        events: [{
          id: 'stale-trace-detail',
          session_id: sessionId,
          seq: 20,
          type: 'reasoning_summary',
          ts: timestamp,
          text: 'Obsolete trace',
        }],
        has_more: false,
        next_after: null,
      }
    }
    const staleTrace = useAppStore.getState().loadRunTrace(
      'shared-session',
      'run-1',
      25,
      0,
      40,
      useAppStore.getState().profileGeneration,
    )
    await staleTraceStarted.promise
    useAppStore.setState({ selectedSessionId: 'another-session' })
    staleTraceGate.resolve()
    let staleTraceError: unknown = null
    try {
      await staleTrace
    } catch (error) {
      staleTraceError = error
    }
    assert(
      staleTraceError instanceof AgentServerClientUnvalidatedError,
      'a trace response for a chat that is no longer selected must be rejected',
    )
    useAppStore.setState({ selectedSessionId: 'shared-session' })

    activeClient.runTrace = async () => {
      throw new ServerError(404, 'Endpoint unavailable')
    }
    assert.equal(
      JSON.stringify(await useAppStore.getState().loadRunTrace(
        'shared-session',
        'run-1',
        25,
        0,
        40,
        useAppStore.getState().profileGeneration,
      )),
      JSON.stringify({ events: [], has_more: false, next_after: null }),
      'older servers should return an empty terminal trace page',
    )
    useAppStore.setState({ selectedSessionId: selectedBeforeTrace })

    activeClient.sendTurn = async (sessionId, prompt) => {
      sendCalls += 1
      sendStarted.resolve()
      await sendGate.promise
      return {
        session: liveSession,
        queued: true,
        event: {
          id: 'queued-event', session_id: sessionId, seq: 1, type: 'turn_queued', ts: timestamp,
          queued_id: 'queued-now', prompt,
        },
      }
    }
    activeClient.runQueuedNow = async (_sessionId, queuedId) => {
      runNowCalls += 1
      return { ok: true, queued_id: queuedId }
    }
    activeClient.queue = async () => []
    useAppStore.setState({
      sessions: [liveSession],
      selectedSessionId: 'shared-session',
      snapshots: { 'shared-session': sendSnapshot },
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      drafts: { ...useAppStore.getState().drafts, 'shared-session': 'Send exactly once' },
      uploadPending: {},
      error: null,
      syncSelectedSession: async () => {},
    })
    const generation = useAppStore.getState().profileGeneration
    const admissionToken = useAppStore.getState().beginTurnAdmission('shared-session')
    assert(admissionToken, 'the first send admission should synchronously reserve the chat')
    assert.equal(useAppStore.getState().beginTurnAdmission('shared-session'), null, 'a second first-turn admission must be rejected')
    useAppStore.getState().endTurnAdmission('shared-session', `${admissionToken}-stale`)
    assert.equal(
      useAppStore.getState().turnAdmissionTokens['shared-session'],
      admissionToken,
      'a stale cleanup must not release a newer admission owner',
    )
    assert.equal(
      await useAppStore.getState().updateSession('shared-session', { backend: 'claude' }, generation),
      false,
      'backend changes must be rejected while the first turn is in admission preflight',
    )
    assert.equal(useAppStore.getState().sessions[0]?.backend, 'codex', 'a rejected backend change must not update optimistic state')
    useAppStore.getState().endTurnAdmission('shared-session', admissionToken)
    assert.equal(useAppStore.getState().turnAdmissionTokens['shared-session'], undefined, 'the exact owner should release admission')
    useAppStore.setState({ activeSessionIds: new Set(['shared-session']), error: null })
    useAppStore.getState().setSessionDraft('shared-session', 'Send exactly once', generation)
    const firstSend = useAppStore.getState().sendPrompt(true, generation, 'shared-session')
    await sendStarted.promise
    assert.equal(useAppStore.getState().sendingSessionIds.has('shared-session'), true)
    assert(useAppStore.getState().turnAdmissionTokens['shared-session'], 'admission must remain held until send completion')
    assert.equal(useAppStore.getState().drafts['shared-session'], '', 'tapping Send must clear the submitted draft before the request finishes')
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.equal(
      (await cache.loadWorkspacePreferences('server-b')).drafts['shared-session'] ?? '',
      '',
      'the optimistic clear must cancel the stale typing debounce and persist before a slow request finishes',
    )
    assert.equal(await useAppStore.getState().sendPrompt(true, generation, 'shared-session'), false)
    assert.equal(sendCalls, 1, 'a rapid second tap must not post a duplicate turn')
    sendGate.resolve()
    assert.equal(await firstSend, true)
    assert.equal(useAppStore.getState().drafts['shared-session'], '', 'an accepted unchanged draft must clear after send')
    assert.equal(runNowCalls, 1)
    assert.equal(useAppStore.getState().sendingSessionIds.has('shared-session'), false)
    assert.equal(useAppStore.getState().turnAdmissionTokens['shared-session'], undefined, 'send completion must release admission')
    assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queued-now'), false)
    assert.equal(useAppStore.getState().snapshots['shared-session']?.queuedTurns.length, 0)

    const admittedFile: AgentFile = {
      id: 'admitted-file',
      session_id: 'shared-session',
      filename: 'admitted.txt',
      content_type: 'text/plain',
      size: 12,
    }
    const followUpFile: AgentFile = {
      id: 'follow-up-file',
      session_id: 'shared-session',
      filename: 'follow-up.txt',
      content_type: 'text/plain',
      size: 14,
    }
    useAppStore.setState(state => ({
      activeSessionIds: new Set(),
      drafts: { ...state.drafts, 'shared-session': 'Captured before permission save' },
      uploads: { ...state.uploads, 'shared-session': [admittedFile] },
    }))
    const snapshotAdmissionToken = useAppStore.getState().beginTurnAdmission('shared-session')
    assert(snapshotAdmissionToken)
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Typed while permission save finished' },
      uploads: { ...state.uploads, 'shared-session': [followUpFile] },
    }))
    let admittedPrompt = ''
    let admittedFileIds: string[] = []
    activeClient.sendTurn = async (_sessionId, prompt, fileIds) => {
      admittedPrompt = prompt
      admittedFileIds = fileIds
      return { session: liveSession, queued: false }
    }
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session', {
      admissionToken: snapshotAdmissionToken,
      admittedDraft: 'Captured before permission save',
      admittedFiles: [admittedFile],
    }), true)
    assert.equal(admittedPrompt, 'Captured before permission save', 'permission preflight must not change the accepted prompt')
    assert.deepEqual(admittedFileIds, ['admitted-file'], 'permission preflight must not change the accepted attachment set')
    assert.equal(
      useAppStore.getState().drafts['shared-session'],
      'Typed while permission save finished',
      'typing after admission must survive completion of the captured send',
    )
    assert.deepEqual(
      useAppStore.getState().uploads['shared-session']?.map(file => file.id),
      ['follow-up-file'],
      'attachments added after admission must remain for the next message',
    )
    assert.equal(useAppStore.getState().turnAdmissionTokens['shared-session'], undefined)
    useAppStore.setState({ activeSessionIds: new Set(['shared-session']), uploads: { 'shared-session': [] } })

    const deferredTurn: QueuedTurn = {
      queued_id: 'queued-deferred',
      session_id: 'shared-session',
      prompt: 'Wait until the provider is ready',
      file_ids: [],
    }
    let queueRefreshCalls = 0
    activeClient.runQueuedNow = async () => ({
      ok: false,
      queued_id: deferredTurn.queued_id,
      deferred: true,
      message: 'The provider is still starting. This message remains queued.',
    })
    activeClient.queue = async () => {
      queueRefreshCalls += 1
      return [deferredTurn]
    }
    useAppStore.setState(state => ({
      snapshots: {
        ...state.snapshots,
        'shared-session': { ...sendSnapshot, queuedTurns: [deferredTurn] },
      },
      queuedRunStatus: {},
      error: null,
    }))
    assert.equal(await useAppStore.getState().runQueuedNow('shared-session', deferredTurn.queued_id, generation), false)
    assert.equal(queueRefreshCalls, 1, 'a deferred Run now must refresh the authoritative queue')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.queuedTurns[0]?.queued_id, deferredTurn.queued_id, 'a deferred Run now must keep the message queued')
    assert.match(useAppStore.getState().queuedRunStatus['shared-session']?.message ?? '', /remains queued/i)
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session']?.tone, 'info')
    assert.equal(useAppStore.getState().error, null, 'a deferred Run now must not use the global error banner')

    activeClient.removeQueued = async () => undefined
    activeClient.queue = async () => []
    assert.equal(await useAppStore.getState().removeQueued('shared-session', deferredTurn.queued_id, generation), true)
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], undefined, 'authoritative removal must retire a non-uncertain queue status')

    const rejectedTurn: QueuedTurn = {
      queued_id: 'queued-rejected',
      session_id: 'shared-session',
      prompt: 'Retry this message',
      file_ids: [],
    }
    activeClient.runQueuedNow = async () => { throw new ServerError(502, 'Codex app-server rejected the steering boundary') }
    activeClient.queue = async () => [rejectedTurn]
    useAppStore.setState(state => ({
      snapshots: {
        ...state.snapshots,
        'shared-session': { ...sendSnapshot, queuedTurns: [rejectedTurn] },
      },
      queuedRunStatus: {},
      error: null,
    }))
    assert.equal(await useAppStore.getState().runQueuedNow('shared-session', rejectedTurn.queued_id, generation), false)
    assert.equal(useAppStore.getState().snapshots['shared-session']?.queuedTurns[0]?.queued_id, rejectedTurn.queued_id)
    assert.match(useAppStore.getState().queuedRunStatus['shared-session']?.message ?? '', /still queued.*Codex app-server rejected/i)
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session']?.tone, 'error')
    assert.equal(useAppStore.getState().error, null, 'a rejected Run now must stay local to the queue shelf')

    const uncertainTurn: QueuedTurn = {
      queued_id: 'queued-uncertain',
      session_id: 'shared-session',
      prompt: 'Do not replay this message',
      file_ids: [],
    }
    let uncertainRunCalls = 0
    activeClient.runQueuedNow = async () => {
      uncertainRunCalls += 1
      throw new ServerError(
        409,
        'Force Send delivery could not be confirmed. Do not retry automatically. Refresh the chat and verify whether the message appeared.',
        {
          code: 'force_send_delivery_uncertain',
          retryable: false,
          delivery_uncertain: true,
          queued_id: uncertainTurn.queued_id,
        },
      )
    }
    activeClient.queue = async () => []
    useAppStore.setState(state => ({
      snapshots: {
        ...state.snapshots,
        'shared-session': { ...sendSnapshot, queuedTurns: [uncertainTurn] },
      },
      queuedRunStatus: {},
      error: null,
    }))
    assert.equal(await useAppStore.getState().runQueuedNow('shared-session', uncertainTurn.queued_id, generation), false)
    assert.equal(useAppStore.getState().snapshots['shared-session']?.queuedTurns.length, 0, 'delivery uncertainty should still publish the authoritative queue')
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session']?.delivery_uncertain, true, 'delivery uncertainty must remain visible even when the queue item disappeared')
    assert.match(useAppStore.getState().queuedRunStatus['shared-session']?.message ?? '', /Do not retry automatically/i)
    assert.equal(useAppStore.getState().error, null, 'delivery uncertainty must not become a global banner')

    const uncertainStatus = useAppStore.getState().queuedRunStatus['shared-session']
    useAppStore.getState().clearQueuedRunStatus('shared-session', generation - 1)
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], uncertainStatus, 'a stale composer must not clear the active profile queue status')
    useAppStore.getState().clearQueuedRunStatus('shared-session', generation)
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], undefined)
    assert.equal(await useAppStore.getState().runQueuedNow('shared-session', uncertainTurn.queued_id, generation - 1), false)
    assert.equal(uncertainRunCalls, 1, 'a stale profile action must not reach the active server')
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], undefined, 'a stale profile action must not write status into the active profile')

    const competingTurn: QueuedTurn = {
      queued_id: 'queued-competing',
      session_id: 'shared-session',
      prompt: 'Do not race the retry',
      file_ids: [],
    }
    const runNowGate = deferred()
    let gatedRunNowCalls = 0
    activeClient.runQueuedNow = async (_sessionId, queuedId) => {
      gatedRunNowCalls += 1
      await runNowGate.promise
      return { ok: true, queued_id: queuedId }
    }
    activeClient.queue = async () => [competingTurn]
    useAppStore.setState(state => ({
      snapshots: {
        ...state.snapshots,
        'shared-session': { ...sendSnapshot, queuedTurns: [rejectedTurn, competingTurn] },
      },
    }))
    const acceptedRetry = useAppStore.getState().runQueuedNow('shared-session', rejectedTurn.queued_id, generation)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], undefined, 'retrying Run now must clear its previous inline status immediately')
    assert.equal(await useAppStore.getState().runQueuedNow('shared-session', competingTurn.queued_id, generation), false, 'a second queued item must not race a Run now already in flight for the session')
    assert.equal(gatedRunNowCalls, 1, 'Run now requests must coalesce per session')
    runNowGate.resolve()
    assert.equal(await acceptedRetry, true)
    assert.deepEqual(useAppStore.getState().snapshots['shared-session']?.queuedTurns.map(turn => turn.queued_id), [competingTurn.queued_id], 'a successful Run now must publish the authoritative refreshed queue')
    assert.equal(useAppStore.getState().queuedRunStatus['shared-session'], undefined, 'a successful Run now must leave inline status cleared')

    for (const steer of [false, true]) {
      const mode = steer ? 'steer' : 'send'
      const acceptedGate = deferred()
      activeClient.sendTurn = async () => {
        await acceptedGate.promise
        return { session: liveSession, queued: false }
      }
      useAppStore.setState(state => ({
        drafts: { ...state.drafts, 'shared-session': `Submit this ${mode}` },
        error: null,
      }))
      const acceptedSend = useAppStore.getState().sendPrompt(steer, generation, 'shared-session')
      assert.equal(
        useAppStore.getState().drafts['shared-session'],
        '',
        `an accepted ${mode} must synchronously consume its submitted draft`,
      )
      const followUp = `This is my next message after ${mode}`
      useAppStore.getState().setSessionDraft('shared-session', followUp, generation)
      acceptedGate.resolve()
      assert.equal(await acceptedSend, true)
      assert.equal(
        useAppStore.getState().drafts['shared-session'],
        followUp,
        `typing after an accepted ${mode} starts must survive its completion`,
      )
    }

    const failedGate = deferred()
    const failedStarted = deferred()
    activeClient.sendTurn = async () => {
      failedStarted.resolve()
      await failedGate.promise
      throw new Error('send failed')
    }
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Restore this request' },
      error: null,
    }))
    const failedSend = useAppStore.getState().sendPrompt(false, generation, 'shared-session')
    await failedStarted.promise
    assert.equal(useAppStore.getState().drafts['shared-session'], '')
    useAppStore.getState().setSessionDraft('shared-session', 'Do not lose this follow-up', generation)
    failedGate.resolve()
    assert.equal(await failedSend, false)
    assert.equal(
      useAppStore.getState().drafts['shared-session'],
      'Restore this request\n\nDo not lose this follow-up',
      'a failed send must restore the submitted text ahead of anything typed while waiting',
    )
    assert.match(useAppStore.getState().error ?? '', /send failed/)

    const pendingUpdateMessage = 'AgentsServer is waiting for current work to finish before a managed update.'
    activeClient.sendTurn = async () => {
      throw new ServerError(409, `${pendingUpdateMessage} Let active work finish or cancel the scheduled update.`, {
        code: 'server_update_pending',
        message: pendingUpdateMessage,
        action: 'Let active work finish or cancel the scheduled update.',
        retryable: true,
      })
    }
    useAppStore.setState(state => ({
      health: {
        ...(state.health ?? { ok: true }),
        capabilities: {
          ...(state.health?.capabilities ?? {}),
          server_updates: { available: false, version: 6 },
        },
      },
      drafts: { ...state.drafts, 'shared-session': 'Keep this pending message' },
      pendingServerUpdate: null,
      cancelingServerUpdate: false,
      error: null,
    }))
    serverB.rejectNextForPendingUpdate('/api/sessions')
    assert.equal(await useAppStore.getState().createSession({
      title: 'Blocked while updating',
      folder: 'General',
      cwd: '/tmp',
      backend: 'codex',
      model: '',
      effort: '',
      system_prompt: null,
    }, generation), false)
    assert.equal(useAppStore.getState().pendingServerUpdate?.profileGeneration, generation, 'any fenced mutation should expose the update cancellation action')
    useAppStore.getState().clearError()
    assert.equal(useAppStore.getState().pendingServerUpdate, null)

    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false)
    assert.equal(useAppStore.getState().drafts['shared-session'], 'Keep this pending message', 'update admission must restore the unsent draft')
    assert.equal(useAppStore.getState().pendingServerUpdate?.profileId, useAppStore.getState().activeProfileId)
    assert.equal(useAppStore.getState().pendingServerUpdate?.profileGeneration, generation)
    assert.equal(useAppStore.getState().pendingServerUpdate?.canCancel, true, 'API v6 should expose cancellation even if new update launches are unavailable')

    const updateStatusStarted = deferred()
    const updateStatusGate = deferred()
    let updateStatusCalls = 0
    const canceledScheduleIds: string[] = []
    activeClient.serverUpdateStatus = async () => {
      updateStatusCalls += 1
      updateStatusStarted.resolve()
      await updateStatusGate.promise
      return {
        phase: 'pending',
        schedule_id: '0123456789abcdef0123456789abcdef',
        cancelable: true,
        blocker_counts: { active_runs: 1 },
      }
    }
    activeClient.cancelServerUpdate = async scheduleId => {
      canceledScheduleIds.push(scheduleId)
      return { phase: 'available', schedule_id: null, cancelable: null }
    }
    assert.equal(await useAppStore.getState().cancelPendingServerUpdate(generation - 1), false, 'a stale profile generation must not reach update endpoints')
    assert.equal(updateStatusCalls, 0)
    const cancelPendingUpdate = useAppStore.getState().cancelPendingServerUpdate(generation)
    await updateStatusStarted.promise
    assert.equal(useAppStore.getState().cancelingServerUpdate, true)
    useAppStore.getState().clearError()
    assert.equal(useAppStore.getState().cancelingServerUpdate, true, 'dismissing a banner must not release an in-flight cancellation gate')
    assert.equal(useAppStore.getState().pendingServerUpdate, null)
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false)
    assert.equal(useAppStore.getState().pendingServerUpdate?.profileGeneration, generation, 'a new fence response may restore the notice while cancellation remains single-flight')
    assert.equal(await useAppStore.getState().cancelPendingServerUpdate(generation), false, 'rapid cancellation taps must coalesce')
    assert.equal(updateStatusCalls, 1)
    updateStatusGate.resolve()
    assert.equal(await cancelPendingUpdate, true)
    assert.deepEqual(canceledScheduleIds, ['0123456789abcdef0123456789abcdef'], 'cancellation must use the authoritative schedule ID')
    assert.equal(useAppStore.getState().pendingServerUpdate, null)
    assert.equal(useAppStore.getState().cancelingServerUpdate, false)
    assert.equal(useAppStore.getState().error, null)
    assert.equal(useAppStore.getState().drafts['shared-session'], 'Keep this pending message', 'canceling an update must not consume or resend the draft')

    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false)
    let raceStatusCalls = 0
    let raceCancelCalls = 0
    activeClient.serverUpdateStatus = async () => {
      raceStatusCalls += 1
      return {
        phase: 'pending',
        schedule_id: raceStatusCalls === 1
          ? '11111111111111111111111111111111'
          : '22222222222222222222222222222222',
        cancelable: true,
      }
    }
    activeClient.cancelServerUpdate = async () => {
      raceCancelCalls += 1
      throw new ServerError(409, 'The scheduled server update changed before cancellation.', {
        code: 'server_update_changed',
        retryable: true,
      })
    }
    assert.equal(await useAppStore.getState().cancelPendingServerUpdate(generation), false)
    assert.equal(raceStatusCalls, 2, 'a changed schedule should refresh status exactly once')
    assert.equal(raceCancelCalls, 1, 'a changed schedule must never be canceled again automatically')
    assert.equal(useAppStore.getState().pendingServerUpdate?.profileGeneration, generation)
    assert.match(useAppStore.getState().error ?? '', /Tap Cancel update again/i)

    activeClient.serverUpdateStatus = async () => ({ phase: 'installing', cancelable: false, message: 'Installing AgentsServer.' })
    assert.equal(await useAppStore.getState().cancelPendingServerUpdate(generation), false)
    assert.equal(raceCancelCalls, 1, 'an already-started update must not call the cancellation endpoint')
    assert.equal(useAppStore.getState().pendingServerUpdate, null)
    assert.match(useAppStore.getState().error ?? '', /Installing AgentsServer/i)
    useAppStore.getState().clearError()

    activeClient.sendTurn = async () => {
      throw new AgentServerClientUnvalidatedError()
    }
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Restore after validation cancellation' },
      error: null,
    }))
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false)
    assert.equal(useAppStore.getState().drafts['shared-session'], 'Restore after validation cancellation')
    assert.equal(useAppStore.getState().error, null, 'same-scope validation cancellation should restore silently')

    const attachmentFailureGate = deferred()
    const attachmentFailureStarted = deferred()
    const attachmentOnlyFile = {
      id: 'attachment-only-photo',
      session_id: 'shared-session',
      filename: 'attachment-only.heic',
      content_type: 'image/heic',
      size: 100,
    }
    activeClient.sendTurn = async () => {
      attachmentFailureStarted.resolve()
      await attachmentFailureGate.promise
      throw new Error('attachment send failed')
    }
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': '' },
      uploads: { ...state.uploads, 'shared-session': [attachmentOnlyFile] },
      uploadPending: {},
      uploadFailed: {},
      error: null,
    }))
    const attachmentOnlySend = useAppStore.getState().sendPrompt(false, generation, 'shared-session')
    await attachmentFailureStarted.promise
    useAppStore.getState().setSessionDraft('shared-session', 'Typed while the attachment was sending', generation)
    attachmentFailureGate.resolve()
    assert.equal(await attachmentOnlySend, false)
    assert.equal(
      useAppStore.getState().drafts['shared-session'],
      'Typed while the attachment was sending',
      'a failed attachment-only send must not prepend blank lines to concurrent typing',
    )
    assert.equal(useAppStore.getState().uploads['shared-session']?.[0]?.id, attachmentOnlyFile.id)

    activeClient.sendTurn = async () => {
      sendCalls += 1
      return { session: liveSession, queued: true }
    }
    activeClient.queue = async () => { throw new Error('queue reconciliation unavailable') }
    useAppStore.setState(state => ({ drafts: { ...state.drafts, 'shared-session': 'Accepted before reconciliation' }, error: null }))
    assert.equal(await useAppStore.getState().sendPrompt(true, generation, 'shared-session'), true)
    assert.match(useAppStore.getState().error ?? '', /queue reconciliation unavailable/)
    assert.equal(sendCalls, 2, 'an accepted turn must not be presented as safe to retry')

    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Wait for my upload' },
      uploadPending: { 'shared-session': [{ uri: 'file:///pending.png', name: 'pending.png' }] },
    }))
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false)
    assert.equal(sendCalls, 2, 'send must remain blocked until every selected upload completes')

    let quickPrompt: string | undefined
    let quickFileIds: string[] | undefined
    let quickSendCalls = 0
    const preservedQuickAttachment = {
      id: 'quick-draft-photo',
      session_id: 'shared-session',
      filename: 'draft-photo.heic',
      content_type: 'image/heic',
      size: 222,
    }
    activeClient.sendTurn = async (sessionId, prompt, fileIds) => {
      quickSendCalls += 1
      quickPrompt = prompt
      quickFileIds = fileIds
      return { session: { ...liveSession, id: sessionId }, queued: true }
    }
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Keep this unfinished draft' },
      uploads: { ...state.uploads, 'shared-session': [preservedQuickAttachment] },
      uploadPending: { 'shared-session': [{ uri: 'file:///pending-quick.png', name: 'pending-quick.png' }] },
      uploadFailed: { 'shared-session': [{ uri: 'file:///failed-quick.png', name: 'failed-quick.png', error: 'Still retryable' }] },
      error: null,
    }))
    const runNowBeforeQuickPrompt = runNowCalls
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session', {
      promptOverride: 'Status report',
      consumeComposer: false,
    }), true, 'a frequent phrase must send independently of unfinished composer uploads')
    assert.equal(quickSendCalls, 1)
    assert.equal(quickPrompt, 'Status report')
    assert.equal(JSON.stringify(quickFileIds), '[]', 'a frequent phrase must never attach the unfinished composer files')
    assert.equal(useAppStore.getState().drafts['shared-session'], 'Keep this unfinished draft')
    assert.equal(JSON.stringify(useAppStore.getState().uploads['shared-session']), JSON.stringify([preservedQuickAttachment]))
    assert.equal(useAppStore.getState().uploadPending['shared-session']?.length, 1)
    assert.equal(useAppStore.getState().uploadFailed['shared-session']?.length, 1)
    assert.equal(runNowCalls, runNowBeforeQuickPrompt, 'an active frequent phrase must queue normally instead of native steering')

    let attachmentPrompt: string | undefined
    let attachmentFileIds: string[] | undefined
    activeClient.sendTurn = async (sessionId, prompt, fileIds) => {
      sendCalls += 1
      attachmentPrompt = prompt
      attachmentFileIds = fileIds
      return { session: { ...liveSession, id: sessionId }, queued: false }
    }
    const readyPhoto = { id: 'photo-ready', session_id: 'shared-session', filename: 'preview.heic', content_type: 'image/heic', size: 321 }
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': '' },
      uploads: { ...state.uploads, 'shared-session': [readyPhoto] },
      uploadPending: {},
      uploadFailed: {},
      error: null,
    }))
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true, 'a ready attachment must send without placeholder text')
    assert.equal(attachmentPrompt, '')
    assert.equal(attachmentFileIds?.length, 1)
    assert.equal(attachmentFileIds?.[0], 'photo-ready')
    assert.equal(useAppStore.getState().uploads['shared-session']?.length, 0, 'sent attachments must leave the composer')
    assert.equal(sendCalls, 3)
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false, 'an empty composer without attachments must remain disabled')
    assert.equal(sendCalls, 3)

    const pickedPhoto = { uri: 'file:///picker/retry.heic', name: 'retry.heic', type: 'image/heic', size: 654 }
    let uploadAttempts = 0
    activeClient.upload = async (sessionId, file) => {
      uploadAttempts += 1
      if (uploadAttempts === 1) throw new Error('temporary upload failure')
      return { id: 'retry-ready', session_id: sessionId, filename: file.name, content_type: file.type, size: file.size }
    }
    useAppStore.setState(state => ({
      selectedSessionId: 'shared-session',
      sessions: [liveSession],
      snapshots: { 'shared-session': sendSnapshot },
      drafts: { ...state.drafts, 'shared-session': 'Do not send around a failed photo' },
      uploads: {},
      uploadPending: {},
      uploadFailed: {},
      error: null,
    }))
    await useAppStore.getState().attachFiles([pickedPhoto], generation, 'shared-session')
    assert.equal(useAppStore.getState().uploadPending['shared-session']?.length, 0)
    assert.equal(useAppStore.getState().uploadFailed['shared-session']?.[0]?.uri, pickedPhoto.uri, 'a failed picker item must remain visible and retryable')
    assert.match(useAppStore.getState().uploadFailed['shared-session']?.[0]?.error ?? '', /temporary upload failure/)
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), false, 'failed attachments must block an incomplete send')
    assert.equal(sendCalls, 3)
    await useAppStore.getState().attachFiles([pickedPhoto], generation, 'shared-session')
    assert.equal(useAppStore.getState().uploadFailed['shared-session']?.length, 0)
    assert.equal(useAppStore.getState().uploads['shared-session']?.[0]?.id, 'retry-ready')
    assert.equal(sendCalls, 3, 'finishing an attachment upload must never submit or queue the composer')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.files.some(file => file.id === 'retry-ready'), true, 'an uploaded preview must enter the snapshot without waiting for websocket sync')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.filesTotal, 1)
    useAppStore.getState().removeUpload('retry-ready', generation, 'shared-session')

    const healthBeforeCapabilityChecks = useAppStore.getState().health
    const sendTurnBeforeCapabilityChecks = activeClient.sendTurn
    assert(healthBeforeCapabilityChecks)
    const healthWithoutCodexControls: Health = {
      ok: true,
      server_identity: healthBeforeCapabilityChecks.server_identity,
      api_contract_version: healthBeforeCapabilityChecks.api_contract_version,
    }
    const healthWithCodexControls: Health = {
      ...healthWithoutCodexControls,
      capabilities: {
        codex_controls: {
          available: true,
          version: 1,
          interactive_client_capability: 'codex_interactive_v1',
        },
      },
    }
    const healthWithClaudeControls: Health = {
      ...healthWithoutCodexControls,
      capabilities: {
        claude_controls: {
          available: true,
          version: 1,
          interactive_client_capability: 'claude_sdk_interactive_v1',
        },
      },
    }
    const capturedClientCapabilities: Array<readonly string[]> = []
    try {
      activeClient.sendTurn = async (_sessionId, _prompt, _fileIds, _model, _effort, clientCapabilities = []) => {
        capturedClientCapabilities.push([...clientCapabilities])
        return {
          session: useAppStore.getState().sessions.find(value => value.id === 'shared-session') ?? liveSession,
          queued: false,
        }
      }

      useAppStore.setState(state => ({
        sessions: [liveSession],
        selectedSessionId: 'shared-session',
        health: healthWithCodexControls,
        drafts: { ...state.drafts, 'shared-session': 'Codex interactive capability' },
        uploads: {},
        uploadPending: {},
        uploadFailed: {},
        error: null,
      }))
      assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
      assert.equal(
        JSON.stringify(capturedClientCapabilities[0]),
        JSON.stringify(['codex_interactive_v1']),
        'a Codex session must opt into interactive controls only when the server advertises the v1 capability',
      )

      useAppStore.setState(state => ({
        sessions: [liveSession],
        health: healthWithoutCodexControls,
        drafts: { ...state.drafts, 'shared-session': 'Old server fallback' },
      }))
      assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
      assert.equal(
        JSON.stringify(capturedClientCapabilities[1]),
        JSON.stringify([]),
        'a server without Codex controls must keep turns on the non-interactive path',
      )

      const claudeSession: Session = {
        ...liveSession,
        backend: 'claude',
        codex_thread_id: undefined,
      }
      useAppStore.setState(state => ({
        sessions: [claudeSession],
        health: healthWithCodexControls,
        drafts: { ...state.drafts, 'shared-session': 'Non-Codex turn' },
      }))
      assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
      assert.equal(
        JSON.stringify(capturedClientCapabilities[2]),
        JSON.stringify([]),
        'a non-Codex session must not advertise the Codex interactive client capability',
      )

      useAppStore.setState(state => ({
        sessions: [claudeSession],
        health: healthWithClaudeControls,
        drafts: { ...state.drafts, 'shared-session': 'Claude Agent SDK turn' },
      }))
      assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
      assert.equal(
        JSON.stringify(capturedClientCapabilities[3]),
        JSON.stringify(['claude_sdk_interactive_v1']),
        'a Claude session must opt into Agent SDK controls only when the server advertises the exact capability',
      )

      useAppStore.setState(state => ({
        sessions: [claudeSession],
        health: healthWithoutCodexControls,
        drafts: { ...state.drafts, 'shared-session': 'Claude compatibility turn' },
      }))
      assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
      assert.equal(
        JSON.stringify(capturedClientCapabilities[4]),
        JSON.stringify([]),
        'a server without Claude controls must keep Claude turns on the compatibility transport',
      )
      assert.equal(capturedClientCapabilities.length, 5)
    } finally {
      activeClient.sendTurn = sendTurnBeforeCapabilityChecks
      useAppStore.setState({
        sessions: [liveSession],
        selectedSessionId: 'shared-session',
        health: healthBeforeCapabilityChecks,
        uploads: {},
        uploadPending: {},
        uploadFailed: {},
      })
    }

    const uploadGate = deferred()
    const uploadStarted = deferred()
    let switchedUploadCalls = 0
    activeClient.upload = async (sessionId, file) => {
      switchedUploadCalls += 1
      if (switchedUploadCalls === 1) uploadStarted.resolve()
      await uploadGate.promise
      return { id: `switched-${switchedUploadCalls}`, session_id: sessionId, filename: file.name, content_type: file.type, size: file.size }
    }
    const otherSession = { ...liveSession, id: 'other-session', title: 'Other chat' }
    useAppStore.setState({
      sessions: [liveSession, otherSession],
      selectedSessionId: 'shared-session',
      uploads: {},
      uploadPending: {},
      uploadFailed: {},
    })
    const switchedUpload = useAppStore.getState().attachFiles([
      { uri: 'file:///picker/one.png', name: 'one.png', type: 'image/png' },
      { uri: 'file:///picker/two.pdf', name: 'two.pdf', type: 'application/pdf' },
    ], generation, 'shared-session')
    await uploadStarted.promise
    useAppStore.setState({ selectedSessionId: 'other-session' })
    uploadGate.resolve()
    await switchedUpload
    assert.equal(switchedUploadCalls, 2, 'switching chats must not abandon the rest of an upload batch')
    assert.equal(useAppStore.getState().uploads['shared-session']?.length, 2, 'completed uploads must stay with their original chat')
    assert.equal(useAppStore.getState().uploadPending['shared-session']?.length, 0)
    useAppStore.setState({ selectedSessionId: 'shared-session', sessions: [liveSession], uploads: {}, uploadPending: {}, uploadFailed: {} })

    const stoppedEvent = {
      id: 'newer-stop', session_id: 'shared-session', seq: 3, type: 'turn_stopped', ts: timestamp,
    }
    const locallyStoppedSession = {
      ...liveSession,
      latest_event_seq: stoppedEvent.seq,
      latest_event_at: stoppedEvent.ts,
      latest_event_type: stoppedEvent.type,
    }
    activeClient.sendTurn = async () => {
      sendCalls += 1
      return {
        session: liveSession,
        queued: false,
        event: {
          id: 'stale-start', session_id: 'shared-session', seq: 2, type: 'turn_started', ts: timestamp,
        },
      }
    }
    useAppStore.setState(state => ({
      sessions: [locallyStoppedSession],
      snapshots: {},
      activeSessionIds: new Set(),
      drafts: { ...state.drafts, 'shared-session': 'Do not resurrect an old start' },
      uploadPending: {},
      error: null,
    }))
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
    assert.equal(useAppStore.getState().activeSessionIds.has('shared-session'), false, 'a stale POST event must not resurrect a stopped turn when no snapshot is loaded')
    const sessionAfterStaleResponse = useAppStore.getState().sessions.find(value => value.id === 'shared-session')
    assert.equal(sessionAfterStaleResponse?.latest_event_seq, stoppedEvent.seq, 'a stale POST session must not regress newer local event metadata')
    assert.equal(sessionAfterStaleResponse?.latest_event_type, stoppedEvent.type)
    assert.equal(sessionAfterStaleResponse?.latest_event_at, stoppedEvent.ts)

    const stopGate = deferred()
    const stopStarted = deferred()
    let stopCalls = 0
    activeClient.stopTurn = async () => {
      stopCalls += 1
      stopStarted.resolve()
      await stopGate.promise
      return { ok: true, stopped: true }
    }
    useAppStore.setState({
      activeSessionIds: new Set(['shared-session']),
      stoppingSessionIds: new Set(),
      error: null,
    })
    const firstStop = useAppStore.getState().stopTurn(generation, 'shared-session')
    await stopStarted.promise
    assert.equal(useAppStore.getState().stoppingSessionIds.has('shared-session'), true)
    await useAppStore.getState().stopTurn(generation, 'shared-session')
    assert.equal(stopCalls, 1, 'a rapid second stop tap must not send another stop request')
    stopGate.resolve()
    await firstStop
    assert.equal(useAppStore.getState().activeSessionIds.has('shared-session'), false)
    assert.equal(useAppStore.getState().stoppingSessionIds.has('shared-session'), false)

    activeClient.stopTurn = async () => ({
      ok: true,
      stopped: false,
      pending: true,
      deferred: true,
      message: 'The native interrupt is still pending.',
    })
    useAppStore.setState({ activeSessionIds: new Set(['shared-session']), error: null })
    await useAppStore.getState().stopTurn(generation, 'shared-session')
    assert.equal(useAppStore.getState().activeSessionIds.has('shared-session'), true, 'a pending Stop acknowledgement must keep the turn active')
    assert.equal(useAppStore.getState().error, 'The native interrupt is still pending.', 'a pending Stop acknowledgement must surface server retry guidance')
    useAppStore.setState({ activeSessionIds: new Set(), error: null })

    const historyGate = deferred()
    const historyStarted = deferred()
    let historyCalls = 0
    let compactRequested = false
    activeClient.sessionPage = async (_sessionId, options) => {
      historyCalls += 1
      compactRequested = options?.compact === true
      historyStarted.resolve()
      await historyGate.promise
      return {
        session: liveSession,
        events: Array.from({ length: 100 }, (_, index) => ({
          id: `older-${index + 801}`,
          session_id: 'shared-session',
          seq: index + 801,
          type: index % 2 ? 'assistant_text' : 'turn_started',
          ts: timestamp,
          ...(index % 2 ? { text: `Older response ${index}` } : { prompt: `Older prompt ${index}` }),
        })),
        queued_turns: [],
        has_more: true,
        before: 801,
        total: 920,
        latest_seq: 920,
        events_omitted_before: 800,
        events_omitted_after: 20,
      }
    }
    const liveEvents = Array.from({ length: 20 }, (_, index) => ({
      id: `live-${index + 901}`,
      session_id: 'shared-session',
      seq: index + 901,
      type: 'assistant_text',
      ts: timestamp,
      text: `Live response ${index}`,
    }))
    const liveHistorySnapshot: Snapshot = {
      cacheVersion: SNAPSHOT_CACHE_VERSION,
      session: liveSession,
      events: liveEvents,
      queuedTurns: [],
      files: [],
      filesTotal: 0,
      hasMore: true,
      total: 920,
      latestSeq: 920,
      cachedAt: Date.now(),
    }
    useAppStore.setState({
      selectedSessionId: 'shared-session',
      snapshots: { 'shared-session': liveHistorySnapshot },
      historyWindow: null,
      loadingOlder: {},
      error: null,
    })
    const firstHistoryRequest = useAppStore.getState().loadOlder('shared-session')
    await historyStarted.promise
    assert.equal(
      useAppStore.getState().historyWindow,
      null,
      'an in-flight older-page request must keep the authoritative live transcript visible',
    )
    const duplicateHistoryRequest = useAppStore.getState().loadOlder('shared-session')
    assert.equal(duplicateHistoryRequest, firstHistoryRequest, 'rapid older-message requests must share one network operation')
    historyGate.resolve()
    assert.equal(await firstHistoryRequest, 100)
    assert.equal(historyCalls, 1)
    assert.equal(compactRequested, true, 'older-message paging must request conversation-first server pages')
    assert.equal(useAppStore.getState().snapshots['shared-session']?.events[0]?.seq, 901, 'browsing history must not mutate the live tail')
    assert.equal(useAppStore.getState().historyWindow?.snapshot.events[0]?.seq, 801)
    assert.equal(useAppStore.getState().historyWindow?.snapshot.events.at(-1)?.seq, 920)
    assert.equal(useAppStore.getState().loadingOlder['shared-session'], undefined)
    useAppStore.getState().exitHistory()
    assert.equal(useAppStore.getState().historyWindow, null)

    const healthBeforeTimelineSeek = useAppStore.getState().health
    assert(healthBeforeTimelineSeek)
    const seekRequests: Array<{ after?: number; before?: number; pageMode?: 'semantic' }> = []
    activeClient.sessionPage = async (_sessionId, options) => {
      seekRequests.push({ after: options?.after, before: options?.before, pageMode: options?.pageMode })
      const newer = options?.after != null
      return {
        session: liveSession,
        events: newer
          ? [{
              id: 'searched-event',
              session_id: 'shared-session',
              seq: 500,
              type: 'turn_started',
              ts: timestamp,
              run_id: 'searched-run',
              prompt: 'A result outside the live tail',
            }, {
              id: 'searched-answer',
              session_id: 'shared-session',
              seq: 510,
              type: 'turn_finished',
              ts: timestamp,
              run_id: 'searched-run',
              result_text: 'Historical answer',
            }]
          : [{
              id: 'seek-context',
              session_id: 'shared-session',
              seq: 450,
              type: 'turn_started',
              ts: timestamp,
              run_id: 'seek-context-run',
              prompt: 'Earlier context',
            }],
        queued_turns: [],
        has_more: !newer,
        before: newer ? 500 : 450,
        next_before: newer ? null : 440,
        semantic_paging: true,
        total: 920,
        latest_seq: 920,
      }
    }
    useAppStore.setState({ health: { ...healthBeforeTimelineSeek, api_contract_version: 9 } })
    assert.equal(await useAppStore.getState().seekTimelineResult({
      session_id: 'shared-session',
      event_id: 'searched-event',
      seq: 500,
      role: 'user',
      snippet: 'outside the live tail',
    }, generation), true)
    assert.equal(JSON.stringify(seekRequests), JSON.stringify([
      { before: 500, pageMode: 'semantic' },
      { after: 499, pageMode: 'semantic' },
    ]))
    assert.equal(useAppStore.getState().historyWindow?.detached, true)
    assert.equal(useAppStore.getState().historyWindow?.anchorEventId, 'searched-event')
    assert.equal(useAppStore.getState().historyWindow?.anchorSeq, 500)
    assert.equal(useAppStore.getState().historyWindow?.beforeCursor, 440)
    assert.equal(
      useAppStore.getState().historyWindow?.snapshot.events.some(event => event.id === 'live-901'),
      false,
      'an around-search window must not splice a distant live tail onto its local bottom',
    )

    activeClient.sessionPage = async () => ({
      session: liveSession,
      events: [{
        id: 'seek-earlier',
        session_id: 'shared-session',
        seq: 400,
        type: 'turn_started',
        ts: timestamp,
        run_id: 'seek-earlier-run',
        prompt: 'Earlier search context',
      }],
      queued_turns: [],
      has_more: false,
      before: 400,
      next_before: null,
      semantic_paging: true,
      total: 920,
      latest_seq: 920,
    })
    assert.equal(await useAppStore.getState().loadOlder('shared-session'), 1)
    assert.equal(useAppStore.getState().historyWindow?.detached, true, 'paging earlier must retain detached-search semantics')
    assert.equal(useAppStore.getState().historyWindow?.anchorEventId, 'searched-event', 'paging earlier must retain the search anchor')
    assert.equal(
      useAppStore.getState().historyWindow?.snapshot.events.some(event => event.id === 'live-901'),
      false,
      'detached history paging must not manufacture a gap by merging the live tail',
    )
    const staleSeekGate = deferred()
    const staleSeekStarted = deferred()
    let staleSeekCalls = 0
    activeClient.sessionPage = async (_sessionId, options) => {
      staleSeekCalls += 1
      if (staleSeekCalls === 2) staleSeekStarted.resolve()
      await staleSeekGate.promise
      return {
        session: liveSession,
        events: options?.after != null
          ? [{
              id: 'stale-search-hit',
              session_id: 'shared-session',
              seq: 600,
              type: 'turn_started',
              ts: timestamp,
              prompt: 'Canceled search hit',
            }]
          : [],
        queued_turns: [],
        has_more: false,
        before: options?.after != null ? 600 : null,
        next_before: null,
        semantic_paging: true,
        total: 920,
        latest_seq: 920,
      }
    }
    const staleSeek = useAppStore.getState().seekTimelineResult({
      session_id: 'shared-session',
      event_id: 'stale-search-hit',
      seq: 600,
      role: 'user',
      snippet: 'canceled',
    }, generation)
    await staleSeekStarted.promise
    const historyBeforeCanceledSeek = useAppStore.getState().historyWindow
    useAppStore.getState().cancelTimelineSeek()
    staleSeekGate.resolve()
    assert.equal(await staleSeek, false)
    assert.equal(
      useAppStore.getState().historyWindow,
      historyBeforeCanceledSeek,
      'canceling a pending seek must preserve the detached history already on screen',
    )
    useAppStore.getState().exitHistory()
    useAppStore.setState({ health: healthBeforeTimelineSeek })

    const canceledHistoryGate = deferred()
    const canceledHistoryStarted = deferred()
    activeClient.sessionPage = async () => {
      canceledHistoryStarted.resolve()
      await canceledHistoryGate.promise
      return {
        session: liveSession,
        events: [{
          id: 'canceled-older',
          session_id: 'shared-session',
          seq: 800,
          type: 'turn_started',
          ts: timestamp,
          prompt: 'Must never resurrect history',
        }],
        queued_turns: [],
        has_more: false,
        before: 800,
        total: 920,
        latest_seq: 920,
        events_omitted_before: 799,
        events_omitted_after: 119,
      }
    }
    const canceledHistoryRequest = useAppStore.getState().loadOlder('shared-session')
    await canceledHistoryStarted.promise
    useAppStore.getState().exitHistory()
    canceledHistoryGate.resolve()
    assert.equal(await canceledHistoryRequest, 0)
    assert.equal(
      useAppStore.getState().historyWindow,
      null,
      'leaving history while the first older page is in flight must prevent that response from resurrecting the overlay',
    )

    const sentHistoryGate = deferred()
    const sentHistoryStarted = deferred()
    activeClient.sessionPage = async () => {
      sentHistoryStarted.resolve()
      await sentHistoryGate.promise
      return {
        session: liveSession,
        events: [{
          id: 'sent-older',
          session_id: 'shared-session',
          seq: 799,
          type: 'turn_started',
          ts: timestamp,
          prompt: 'Must not replace live after send',
        }],
        queued_turns: [],
        has_more: false,
        before: 799,
        total: 920,
        latest_seq: 920,
        events_omitted_before: 798,
        events_omitted_after: 120,
      }
    }
    activeClient.sendTurn = async () => ({ session: liveSession, queued: false })
    useAppStore.setState(state => ({
      drafts: { ...state.drafts, 'shared-session': 'Send while history loads' },
      historyWindow: null,
      error: null,
    }))
    const sentHistoryRequest = useAppStore.getState().loadOlder('shared-session')
    await sentHistoryStarted.promise
    assert.equal(await useAppStore.getState().sendPrompt(false, generation, 'shared-session'), true)
    sentHistoryGate.resolve()
    assert.equal(await sentHistoryRequest, 0)
    assert.equal(
      useAppStore.getState().historyWindow,
      null,
      'sending while an older page is in flight must keep the chat at its live edge',
    )

    const pagingHealth = useAppStore.getState().health
    assert(pagingHealth)
    const semanticRequests: Array<{ before?: number; compact?: boolean; pageMode?: 'semantic' }> = []
    let semanticPageCall = 0
    const runBSuccessor: Event = {
      id: 'semantic-run-b',
      session_id: 'shared-session',
      seq: 880,
      type: 'turn_started',
      ts: timestamp,
      run_id: 'run-b',
      prompt: 'Steer B',
      steer_interrupted_run_id: 'run-a',
    }
    const runCBaseSuccessor: Event = {
      id: 'semantic-run-c',
      session_id: 'shared-session',
      seq: 901,
      type: 'turn_started',
      ts: timestamp,
      run_id: 'run-c',
      prompt: 'Steer C',
      steer_interrupted_run_id: 'run-b',
    }
    activeClient.sessionPage = async (_sessionId, options) => {
      semanticRequests.push({ before: options?.before, compact: options?.compact, pageMode: options?.pageMode })
      semanticPageCall += 1
      if (semanticPageCall === 1) {
        return {
          session: liveSession,
          events: [
            runBSuccessor,
            {
              id: 'semantic-commentary-b',
              session_id: 'shared-session',
              seq: 881,
              type: 'reasoning_summary',
              ts: timestamp,
              run_id: 'run-b',
              phase: 'commentary',
              text: 'Public progress B',
            },
            {
              id: 'semantic-analysis-b',
              session_id: 'shared-session',
              seq: 882,
              type: 'reasoning_summary',
              ts: timestamp,
              run_id: 'run-b',
              phase: 'analysis',
              text: 'Private trace B',
            },
          ],
          queued_turns: [],
          has_more: true,
          before: 880,
          next_before: 870,
          semantic_item_count: 1,
          semantic_paging: true,
          total: 901,
          latest_seq: 901,
          events_omitted_before: 879,
          events_omitted_after: 18,
        }
      }
      return {
        session: liveSession,
        events: [
          {
            id: 'semantic-run-a',
            session_id: 'shared-session',
            seq: 850,
            type: 'turn_started',
            ts: timestamp,
            run_id: 'run-a',
            prompt: 'Original A',
          },
          {
            id: 'semantic-run-a-same-seq',
            session_id: 'shared-session',
            seq: 850,
            type: 'turn_started',
            ts: timestamp,
            run_id: 'run-a-same-seq',
            prompt: 'A distinct event sharing seq 850',
          },
          {
            id: 'semantic-commentary-a',
            session_id: 'shared-session',
            seq: 851,
            type: 'reasoning_summary',
            ts: timestamp,
            run_id: 'run-a',
            phase: 'commentary',
            text: 'Public progress A',
          },
          {
            id: 'semantic-tool-a',
            session_id: 'shared-session',
            seq: 852,
            type: 'tool_finished',
            ts: timestamp,
            run_id: 'run-a',
            output: 'Private tool output',
          },
          {
            id: 'semantic-unlinked-commentary',
            session_id: 'shared-session',
            seq: 853,
            type: 'reasoning_summary',
            ts: timestamp,
            run_id: 'run-unlinked',
            phase: 'commentary',
            text: 'Unlinked progress',
          },
          {
            // Semantic cursor 870 is the logical start anchor, not a raw
            // sequence cutoff. A representative event later in that same
            // logical item must survive even when its seq crosses the cursor.
            id: 'semantic-run-a-boundary-tail',
            session_id: 'shared-session',
            seq: 875,
            type: 'assistant_text',
            ts: timestamp,
            run_id: 'run-a',
            text: 'Boundary tail A',
          },
        ],
        queued_turns: [],
        has_more: false,
        before: 850,
        next_before: null,
        semantic_item_count: 1,
        semantic_paging: true,
        total: 901,
        latest_seq: 901,
        events_omitted_before: 849,
        events_omitted_after: 47,
      }
    }
    useAppStore.setState({
      health: { ...pagingHealth, api_contract_version: 9 },
      snapshots: {
        'shared-session': {
          ...liveHistorySnapshot,
          events: [runCBaseSuccessor],
          total: 901,
          latestSeq: 901,
          nextBefore: 890,
          semanticPaging: true,
        },
      },
      historyWindow: null,
      loadingOlder: {},
    })
    assert.equal(await useAppStore.getState().loadOlder('shared-session'), 6)
    assert.equal(
      JSON.stringify(semanticRequests),
      JSON.stringify([
        { before: 890, compact: undefined, pageMode: 'semantic' },
        { before: 870, compact: undefined, pageMode: 'semantic' },
      ]),
      'contract-v9 history should follow semantic cursors without compact filtering',
    )
    const semanticIds = useAppStore.getState().historyWindow?.snapshot.events.map(event => event.id) ?? []
    assert(semanticIds.includes('semantic-commentary-a'), 'a successor in the next page should retain linked commentary')
    assert(semanticIds.includes('semantic-commentary-b'), 'a successor in the live base should retain linked commentary')
    assert(semanticIds.includes('semantic-run-a'), 'the first event at seq 850 should be retained')
    assert(semanticIds.includes('semantic-run-a-same-seq'), 'a distinct event sharing seq 850 must be retained by ID')
    assert(semanticIds.includes('semantic-run-a-boundary-tail'), 'a semantic item event beyond its start cursor must be retained')
    assert(!semanticIds.includes('semantic-analysis-b'), 'private analysis must remain filtered')
    assert(!semanticIds.includes('semantic-tool-a'), 'private tool trace must remain filtered')
    assert(!semanticIds.includes('semantic-unlinked-commentary'), 'unlinked commentary must remain filtered')
    const semanticRows = projectTimeline(useAppStore.getState().historyWindow?.snapshot.events ?? [], [])
    assert.equal(
      JSON.stringify(semanticRows
        .filter(row => row.kind === 'message' && row.role === 'assistant')
        .map(rowText)),
      JSON.stringify(['Public progress A\n\nBoundary tail A', 'Public progress B']),
      'paged history should project every retired steer segment as one durable assistant message',
    )
    assert(
      !semanticRows.some(row => row.kind === 'trace'),
      'paged history should not expose promoted commentary or private internals in folded traces',
    )
    useAppStore.getState().exitHistory()
    useAppStore.setState({ health: pagingHealth })

    activeClient.sessionPage = async () => ({
      session: liveSession,
      events: [{
        id: 'older-transport-only',
        session_id: 'shared-session',
        seq: 800,
        type: 'raw_event',
        ts: timestamp,
        raw: '{"transport":"only"}',
      }],
      queued_turns: [],
      has_more: false,
      before: 800,
      total: 920,
      latest_seq: 920,
      events_omitted_before: 800,
      events_omitted_after: 119,
    })
    useAppStore.setState({
      snapshots: {
        'shared-session': {
          ...liveHistorySnapshot,
          events: [{
            id: 'cached-transport-only',
            session_id: 'shared-session',
            seq: 901,
            type: 'raw_event',
            ts: timestamp,
            raw: '{"cached":"transport-only"}',
          }],
        },
      },
      historyWindow: null,
      loadingOlder: {},
    })
    assert.equal(await useAppStore.getState().loadOlder('shared-session'), 0)
    assert.equal(
      useAppStore.getState().historyWindow,
      null,
      'a compact page with no displayable rows must never publish an empty history overlay',
    )
  } finally {
    activeClient.sendTurn = originalSendTurn
    activeClient.upload = originalUpload
    activeClient.stopTurn = originalStopTurn
    activeClient.reloadProvider = originalReloadProvider
    activeClient.runQueuedNow = originalRunQueuedNow
    activeClient.removeQueued = originalRemoveQueued
    activeClient.queue = originalQueue
    activeClient.sessionPage = originalSessionPage
    activeClient.searchSessions = originalSearchSessions
    activeClient.runTrace = originalRunTrace
    activeClient.jobRuns = originalJobRuns
    activeClient.files = originalFiles
    activeClient.createSession = originalCreateSession
    activeClient.serverUpdateStatus = originalServerUpdateStatus
    activeClient.cancelServerUpdate = originalCancelServerUpdate
    useAppStore.setState({
      selectedSessionId: null,
      snapshots: {},
      historyWindow: null,
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      sendingSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      pendingQueuedRunIds: new Set(),
      queuedRunStatus: {},
      uploadPending: {},
      uploadFailed: {},
      filePaging: {},
      pendingServerUpdate: null,
      cancelingServerUpdate: false,
      selectSession: originalSelectSession,
      syncSelectedSession: originalSyncSelectedSession,
      error: null,
    })
  }

  state.setSessionDraft('shared-session', 'draft-b-live')
  await nextTurn()
  const bSessionsBeforeMismatch = serverB.sessionRequests()
  serverB.identity = 'foreign-server'
  serverB.sessionTitle = 'Foreign session'
  await useAppStore.getState().refreshSessions()

  state = useAppStore.getState()
  assert.equal(serverB.sessionRequests(), bSessionsBeforeMismatch)
  assert.equal(state.activeProfileId, 'profile-b')
  assert.equal(state.connected, false)
  assert.match(state.error ?? '', /identity mismatch/i)
  assert.equal(state.sessions[0]?.title, 'B live')
  assert.equal(state.sessions[0]?.codex_thread_id, 'thread-b')
  assert.notEqual(state.sessions[0]?.title, 'Foreign session')

  serverA.healthStatus = 503
  const delayedOfflineHealth = serverA.delayNextHealth()
  const switchToA = useAppStore.getState().switchServerProfile('profile-a')
  const switchedOfflineToA = await Promise.race([switchToA, after(750)])
  assert.equal(switchedOfflineToA, true)
  await delayedOfflineHealth.started
  state = useAppStore.getState()
  assert.equal(state.activeProfileId, 'profile-a')
  assert.equal(state.switchingProfileId, null)
  assert.equal(state.sessions[0]?.title, 'A live')
  delayedOfflineHealth.release()
  await nextTurn()

  state = useAppStore.getState()
  assert.equal(state.activeProfileId, 'profile-a')
  assert.equal(state.connected, false)
  assert.equal(state.selectedSessionId, null)
  assert.equal(state.sessions[0]?.id, 'shared-session')
  assert.equal(state.sessions[0]?.title, 'A live')
  assert.equal(state.sessions[0]?.codex_thread_id, 'thread-a')
  assert.equal(state.drafts['shared-session'], 'draft-a-live')
  assert.equal(state.token, 'token-a')

  assert.equal((await cache.loadCachedSessions('server-a'))[0]?.title, 'A live')
  assert.equal((await cache.loadCachedSessions('server-b'))[0]?.title, 'B live')
  assert.equal(await cache.loadProfileToken('profile-a', 1), 'token-a')
  assert.equal(await cache.loadProfileToken('profile-b', 1), 'token-b')
  assert.equal((await cache.loadWorkspacePreferences('server-a')).drafts['shared-session'], 'draft-a-live')
  assert.equal((await cache.loadWorkspacePreferences('server-b')).drafts['shared-session'], 'draft-b-live')
  assert.equal((Notifications as typeof Notifications & { __notificationPermissionRequests(): number }).__notificationPermissionRequests(), 1)

  console.log('multi-server store integration regressions passed')
} finally {
  globalThis.setInterval = originalSetInterval
  await Promise.all([serverA.close(), serverB.close()])
}
