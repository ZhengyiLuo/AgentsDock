import assert from 'node:assert/strict'
import { AppState as NativeAppState } from 'react-native'
import { ServerError } from '../api/AgentServerClient'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import type { FilesPage, Health, Session, Snapshot, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

const timestamp = '2026-07-31T12:00:00.000Z'
const session = (id: string): Session => ({
  id,
  title: id,
  backend: 'codex',
  archived: false,
  created_at: timestamp,
  updated_at: timestamp,
  latest_event_seq: 5,
  latest_agent_event_seq: 5,
  last_read_agent_event_seq: 5,
  manual_unread: false,
})
const snapshot = (value: Session): Snapshot => ({
  cacheVersion: SNAPSHOT_CACHE_VERSION,
  session: value,
  events: [],
  queuedTurns: [],
  files: [],
  filesTotal: 0,
  hasMore: false,
  total: 0,
  latestSeq: 5,
  nextBefore: null,
  semanticPaging: null,
  cachedAt: Date.now(),
})
const page = (value: Session): TimelinePage => ({
  session: value,
  events: [],
  queued_turns: [],
  has_more: false,
  before: null,
  next_before: null,
  total: 0,
  latest_seq: 5,
  events_omitted_before: 0,
  events_omitted_after: 0,
  semantic_item_count: null,
  semantic_total: null,
  semantic_omitted_before: null,
  semantic_omitted_after: null,
  next_semantic_before: null,
  semantic_paging: null,
})

const sessionA = session('chat-a')
const sessionB = session('chat-b')
const health: Health = {
  ok: true,
  server_identity: 'uninitialized',
  api_contract_version: 8,
}
const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalRandom = Math.random
const originalSessionPage = client.sessionPage.bind(client)
const originalFiles = client.files.bind(client)
const originalStream = client.stream.bind(client)
const failingSessions = new Set<string>()
const missingSessions = new Set<string>()
const pageCalls: string[] = []
const streamStarts: string[] = []
let streamStops = 0
let nextFakeTimer = 900_000
const fakeRecoveryTimers = new Map<number, { delay: number; callback: () => void; canceled: boolean }>()

function activeRecoveryTimers() {
  return [...fakeRecoveryTimers.values()].filter(timer => !timer.canceled)
}

async function flushRecoveryWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

client.markValidated()
client.sessionPage = async sessionId => {
  pageCalls.push(sessionId)
  if (missingSessions.has(sessionId)) throw new ServerError(404, `chat not found: ${sessionId}`)
  if (failingSessions.has(sessionId)) throw new Error(`network unavailable for ${sessionId}`)
  return page(sessionId === sessionB.id ? sessionB : sessionA)
}
client.files = async (): Promise<FilesPage> => ({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
client.stream = (sessionId, _after, _onEvent, onState) => {
  streamStarts.push(sessionId)
  onState(true)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    streamStops += 1
  }
}
Math.random = () => 0.5
globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  if ([1_000, 2_000, 4_000, 8_000, 15_000, 30_000].includes(delay ?? -1)) {
    const id = nextFakeTimer++
    fakeRecoveryTimers.set(id, {
      delay: delay!,
      canceled: false,
      callback: () => {
        const timer = fakeRecoveryTimers.get(id)
        if (!timer || timer.canceled) return
        timer.canceled = true
        if (typeof handler === 'function') handler(...args)
      },
    })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  return originalSetTimeout(handler, delay, ...args)
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout> | undefined) => {
  const id = Number(timer)
  const fake = fakeRecoveryTimers.get(id)
  if (fake) {
    fake.canceled = true
    return
  }
  originalClearTimeout(timer)
}) as typeof clearTimeout

try {
  appState.__emitAppState('active')
  useAppStore.setState({
    initialized: true,
    activeProfileId: 'uninitialized',
    profileGeneration: 0,
    serverConfigured: true,
    connected: true,
    connecting: false,
    workspaceAdopting: false,
    health,
    sessions: [sessionA, sessionB],
    selectedSessionId: sessionA.id,
    snapshots: {
      [sessionA.id]: snapshot(sessionA),
      [sessionB.id]: snapshot(sessionB),
    },
    syncSessionId: sessionA.id,
    syncStatus: 'cached',
    syncError: null,
    liveConnected: false,
    error: null,
  })

  failingSessions.add(sessionA.id)
  await useAppStore.getState().syncSelectedSession('manual')
  assert.deepEqual(pageCalls, [sessionA.id])
  assert.equal(useAppStore.getState().syncStatus, 'reconnecting')
  assert.equal(useAppStore.getState().syncRetryAttempt, 1)
  assert.match(useAppStore.getState().syncError ?? '', /network unavailable/)
  assert.match(useAppStore.getState().error ?? '', /network unavailable/, 'manual failure remains visible globally')
  assert.deepEqual(activeRecoveryTimers().map(timer => timer.delay), [1_000])

  activeRecoveryTimers()[0]!.callback()
  await flushRecoveryWork()
  assert.deepEqual(pageCalls, [sessionA.id, sessionA.id])
  assert.equal(useAppStore.getState().syncStatus, 'reconnecting')
  assert.equal(useAppStore.getState().syncRetryAttempt, 2)
  assert.deepEqual(activeRecoveryTimers().map(timer => timer.delay), [2_000])

  failingSessions.delete(sessionA.id)
  const canceledByManualRetry = activeRecoveryTimers()[0]!
  await useAppStore.getState().retryConnection()
  assert.equal(canceledByManualRetry.canceled, true, 'manual Retry must cancel the pending automatic timer before syncing immediately')
  assert.deepEqual(pageCalls, [sessionA.id, sessionA.id, sessionA.id])
  assert.deepEqual(streamStarts, [sessionA.id])
  assert.equal(useAppStore.getState().syncStatus, 'live')
  assert.equal(activeRecoveryTimers().length, 0, 'successful recovery must leave no delayed recovery work')

  failingSessions.add(sessionB.id)
  await useAppStore.getState().selectSession(sessionB.id)
  assert.equal(streamStops, 1, 'changing sessions must stop the recovered stream')
  assert.equal(useAppStore.getState().syncStatus, 'reconnecting')
  const canceledBySelection = activeRecoveryTimers()[0]!

  failingSessions.delete(sessionB.id)
  await useAppStore.getState().selectSession(sessionA.id)
  assert.equal(canceledBySelection.canceled, true, 'changing sessions must cancel old-chat recovery')
  const sessionBCallsAfterSwitch = pageCalls.filter(sessionId => sessionId === sessionB.id).length
  canceledBySelection.callback()
  await flushRecoveryWork()
  assert.equal(
    pageCalls.filter(sessionId => sessionId === sessionB.id).length,
    sessionBCallsAfterSwitch,
    'changing sessions must leave no old-session recovery callback',
  )

  failingSessions.add(sessionB.id)
  await useAppStore.getState().selectSession(sessionB.id)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const timers = activeRecoveryTimers()
    assert.equal(timers.length, 1, `retry ${attempt + 1} must own exactly one timer`)
    assert.equal(timers[0]!.delay, [1_000, 2_000, 4_000, 8_000, 15_000, 30_000][attempt])
    timers[0]!.callback()
    await flushRecoveryWork()
  }
  assert.equal(useAppStore.getState().syncStatus, 'error', 'the sixth failed retry must transition to a terminal sync state')
  assert.equal(useAppStore.getState().syncRetryAttempt, 6)
  assert.equal(useAppStore.getState().syncRetryAt, null)
  assert.equal(activeRecoveryTimers().length, 0, 'retry exhaustion must not leave a permanent timer or spinner')

  await useAppStore.getState().syncSelectedSession('foreground')
  assert.equal(useAppStore.getState().syncStatus, 'reconnecting')
  assert.deepEqual(activeRecoveryTimers().map(timer => timer.delay), [1_000], 'foreground recovery may begin a fresh bounded cycle after exhaustion')
  const canceledByBackground = activeRecoveryTimers()[0]!
  const callsBeforeBackground = pageCalls.length
  appState.__emitAppState('background')
  await useAppStore.getState().syncSelectedSession('recovery')
  canceledByBackground.callback()
  await flushRecoveryWork()
  assert.equal(canceledByBackground.canceled, true)
  assert.equal(pageCalls.length, callsBeforeBackground, 'an inactive app must not continue selected-timeline recovery')

  appState.__emitAppState('active')
  failingSessions.delete(sessionB.id)
  await useAppStore.getState().syncSelectedSession('foreground')
  assert.equal(pageCalls.at(-1), sessionB.id)
  assert.equal(useAppStore.getState().syncStatus, 'live')

  failingSessions.add(sessionB.id)
  await useAppStore.getState().syncSelectedSession('server-ahead')
  const canceledByTerminalFailure = activeRecoveryTimers()[0]!
  assert.ok(canceledByTerminalFailure, 'a transient live-stream page failure must schedule bounded recovery')
  failingSessions.delete(sessionB.id)
  missingSessions.add(sessionB.id)
  await useAppStore.getState().syncSelectedSession('server-ahead')
  assert.equal(canceledByTerminalFailure.canceled, true, 'a terminal 404 must cancel an already scheduled automatic retry')
  assert.equal(useAppStore.getState().syncStatus, 'error')
  assert.match(useAppStore.getState().syncError ?? '', /chat not found/)
  assert.equal(activeRecoveryTimers().length, 0)
  missingSessions.delete(sessionB.id)
  await useAppStore.getState().syncSelectedSession('foreground')
  assert.equal(useAppStore.getState().syncStatus, 'live', 'an explicit foreground refresh may recover after terminal state changes')

  console.log('selected timeline bounded recovery regressions passed')
} finally {
  appState.__emitAppState('background')
  await useAppStore.getState().selectSession(sessionA.id)
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  Math.random = originalRandom
  client.sessionPage = originalSessionPage
  client.files = originalFiles
  client.stream = originalStream
  appState.__emitAppState('active')
}
