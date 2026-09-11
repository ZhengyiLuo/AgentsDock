import assert from 'node:assert/strict'
import type { ChatDefaults, CreateSessionInput, PublicServerProfile, QueuedRunNowResponse, Session } from '../types'
import { WELCOME_SESSION_ID } from '../lib/welcome-session'
import { saveCachedSessions, saveWorkspacePreferences } from '../storage/cache'
import { client, useAppStore } from './useAppStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const defaults: ChatDefaults = {
  folder: 'Saved project', cwd: '/work/saved', backend: 'claude', model: 'claude-sonnet', effort: 'high',
}
const selected: Session = {
  id: 'selected', title: 'Open project', folder: 'Research', cwd: '/work/research',
  backend: 'codex', model: 'gpt-current', effort: 'low',
}
const profile = (id: string): PublicServerProfile => ({
  id, name: id, serverURL: `https://${id}.example`, serverIdentity: `identity-${id}`,
  serverConfigured: true, credentialVersion: 1, createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z', hasAccessToken: false,
  connectionState: 'online', cachedUnreadCount: 0,
})
const originalFetch = globalThis.fetch
const originalState = useAppStore.getState()
const requests: CreateSessionInput[] = []
let nextCreatedId = 0
const createdSession = (input: CreateSessionInput): Session => ({ ...input, id: `created-${++nextCreatedId}` })
const selectImmediately = async (sessionId: string, expectedGeneration?: number) => {
  assert.equal(expectedGeneration, useAppStore.getState().profileGeneration)
  useAppStore.setState({ selectedSessionId: sessionId, error: null })
}
const captureCreate = async (input: CreateSessionInput): Promise<Session> => {
  requests.push({ ...input })
  return createdSession(input)
}
function resetCreation(overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  requests.length = 0
  client.createSession = captureCreate
  useAppStore.setState({
    sessions: [selected], selectedSessionId: selected.id, chatDefaults: { ...defaults },
    health: { ok: true, default_cwd: ' /server/default ' }, runtime: null,
    activeSessionIds: new Set(), stoppingSessionIds: new Set(), sendingSessionIds: new Set(),
    turnAdmissionTokens: {}, snapshots: {}, error: null, selectSession: selectImmediately,
    ...overrides,
  })
}

globalThis.fetch = async () => { throw new Error('Unexpected network request in session creation regression') }
try {
  client.markValidated()
  useAppStore.setState({
    initialized: true, profiles: [profile('uninitialized'), profile('profile-b')],
    activeProfileId: 'uninitialized', profileGeneration: 0, connected: true,
    serverConfigured: true, connecting: false, switchingProfileId: null,
    reconnect: async () => {
      client.markValidated()
      useAppStore.setState({ connected: true, connecting: false, health: { ok: true, default_cwd: '/server/new' } })
    },
  })

  resetCreation()
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.deepEqual(requests[0], {
    title: 'New chat', folder: 'Research', cwd: '/work/research',
    backend: 'claude', model: 'claude-sonnet', effort: 'high',
  }, 'the open chat supplies location while saved preferences supply backend/model/effort')
  assert.deepEqual(useAppStore.getState().chatDefaults, {
    ...defaults, folder: 'Research', cwd: '/work/research',
  }, 'successful quick creation remembers the effective location')
  assert.equal(useAppStore.getState().selectedSessionId, 'created-1')

  for (const [label, openSession, selectedSessionId] of [
    ['no selection', selected, null],
    ['missing selection', selected, 'missing'],
    ['archived selection', { ...selected, archived: true }, selected.id],
    ['local welcome', { ...selected, id: WELCOME_SESSION_ID }, WELCOME_SESSION_ID],
  ] as const) {
    resetCreation({ sessions: [openSession], selectedSessionId })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true, label)
    assert.equal(requests[0]?.folder, defaults.folder, `${label} uses the saved folder`)
    assert.equal(requests[0]?.cwd, defaults.cwd, `${label} uses the saved working directory`)
  }
  for (const location of [
    { folder: undefined, cwd: undefined },
    { folder: null, cwd: null },
    { folder: '  ', cwd: '  ' },
  ]) {
    resetCreation({ sessions: [{ ...selected, ...location }] })
    await useAppStore.getState().quickCreateSession(0)
    assert.equal(requests[0]?.folder, 'General')
    assert.equal(requests[0]?.cwd, '/server/default', 'an open chat without a cwd inherits the server default, never the saved project')
  }
  resetCreation({ sessions: [{ ...selected, folder: ' Project B ', cwd: ' /work/b ' }] })
  await useAppStore.getState().quickCreateSession(0)
  assert.equal(requests[0]?.folder, 'Project B')
  assert.equal(requests[0]?.cwd, '/work/b')
  resetCreation({ selectedSessionId: null, chatDefaults: { ...defaults, folder: ' ', cwd: ' ' } })
  await useAppStore.getState().quickCreateSession(0)
  assert.equal(requests[0]?.folder, 'General')
  assert.equal(requests[0]?.cwd, '/server/default')
  resetCreation({ sessions: [{ ...selected, cwd: '' }], health: { ok: true } })
  await useAppStore.getState().quickCreateSession(0)
  assert.equal(requests[0]?.cwd, '')

  resetCreation()
  const createGate = deferred<Session>()
  const selectionGate = deferred<void>()
  client.createSession = input => { requests.push({ ...input }); return createGate.promise }
  useAppStore.setState({ selectSession: async (id, generation) => {
    await selectImmediately(id, generation)
    await selectionGate.promise
  } })
  const first = useAppStore.getState().quickCreateSession(0)
  const duplicate = useAppStore.getState().quickCreateSession(0)
  assert.equal(first, duplicate, 'same-frame quick-create taps share one admitted operation')
  assert.equal(requests.length, 1)
  useAppStore.setState({
    sessions: [{ ...selected, folder: 'Changed', cwd: '/work/changed' }],
    selectedSessionId: 'another-chat', chatDefaults: { ...defaults, cwd: '/work/changed' },
  })
  assert.equal(requests[0]?.cwd, '/work/research', 'selection/default changes after the tap do not change the request')
  createGate.resolve(createdSession(requests[0]!))
  let creationFinished = false
  void first.then(() => { creationFinished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(creationFinished, true, 'initial timeline loading must not delay opening a new chat')
  assert.equal(await first, true)
  selectionGate.resolve(undefined)

  resetCreation()
  const failedCreate = deferred<Session>()
  client.createSession = input => { requests.push({ ...input }); return failedCreate.promise }
  const failed = useAppStore.getState().quickCreateSession(0)
  assert.equal(failed, useAppStore.getState().quickCreateSession(0))
  failedCreate.reject(new Error('Server rejected chat creation'))
  assert.equal(await failed, false)
  assert.match(useAppStore.getState().error ?? '', /Server rejected chat creation/)
  assert.deepEqual(useAppStore.getState().sessions, [selected])
  assert.deepEqual(useAppStore.getState().chatDefaults, defaults)
  assert.equal(useAppStore.getState().selectedSessionId, selected.id)
  client.createSession = captureCreate
  assert.equal(await useAppStore.getState().quickCreateSession(0), true, 'a failed quick create releases the gate for retry')
  assert.equal(requests.length, 2)
  assert.equal(useAppStore.getState().error, null)

  resetCreation()
  assert.equal(await useAppStore.getState().quickCreateSession(-1), false)
  assert.equal(requests.length, 0, 'a stale generation cannot create a chat')
  useAppStore.setState({ connected: false })
  assert.equal(await useAppStore.getState().quickCreateSession(0), false)
  assert.equal(requests.length, 0, 'an unverified/offline connection cannot create a chat')
  useAppStore.setState({ connected: true })

  // A request admitted on an old profile may settle after a new profile has
  // already admitted its own request. Neither its result nor gate cleanup may
  // disturb the newly active workspace.
  for (const [targetId, oldFails] of [['profile-b', false], ['uninitialized', true]] as const) {
    resetCreation()
    const oldGeneration = useAppStore.getState().profileGeneration
    const oldGate = deferred<Session>()
    client.createSession = input => { requests.push({ ...input }); return oldGate.promise }
    const oldRequest = useAppStore.getState().quickCreateSession(oldGeneration)
    const nextSession = { ...selected, folder: `Folder ${targetId}`, cwd: `/work/${targetId}` }
    await saveCachedSessions(`identity-${targetId}`, [nextSession])
    await saveWorkspacePreferences(`identity-${targetId}`, {
      selectedSessionId: selected.id, folderOrder: [], collapsedFolders: [], drafts: {},
      chatDefaults: { ...defaults, model: 'next-model' },
    })
    await useAppStore.getState().switchServerProfile(targetId)
    const nextGeneration = useAppStore.getState().profileGeneration
    const newGate = deferred<Session>()
    client.createSession = input => { requests.push({ ...input }); return newGate.promise }
    const newRequest = useAppStore.getState().quickCreateSession(nextGeneration)
    assert.equal(requests.length, 2, 'a pending old-profile request does not block the new profile')
    assert.equal(requests[1]?.folder, nextSession.folder)
    assert.equal(requests[1]?.cwd, nextSession.cwd)
    assert.equal(requests[1]?.model, 'next-model')
    if (oldFails) oldGate.reject(new Error('Old profile failure'))
    else oldGate.resolve({ ...selected, id: 'stale-created-chat' })
    assert.equal(await oldRequest, false)
    assert.deepEqual(useAppStore.getState().sessions, [nextSession])
    assert.equal(useAppStore.getState().error, null, 'old-profile errors must not surface in the new workspace')
    assert.equal(newRequest, useAppStore.getState().quickCreateSession(nextGeneration), 'old cleanup must not release the new profile gate')
    const newSession = createdSession(requests[1]!)
    newGate.resolve(newSession)
    assert.equal(await newRequest, true)
    assert.equal(useAppStore.getState().selectedSessionId, newSession.id)
  }

  resetCreation()
  let forkCalls = 0
  client.forkSession = async () => { forkCalls += 1; return { session: { ...selected, id: 'forked' } } }
  const generation = useAppStore.getState().profileGeneration
  for (const blocked of [
    { activeSessionIds: new Set([selected.id]) },
    { stoppingSessionIds: new Set([selected.id]) },
    { sendingSessionIds: new Set([selected.id]) },
    { turnAdmissionTokens: { [selected.id]: 'admitted' } },
  ]) {
    resetCreation(blocked)
    await useAppStore.getState().forkSession(selected.id, generation)
    assert.equal(forkCalls, 0, 'a fork cannot race an active or admitting turn')
    assert.match(useAppStore.getState().error ?? '', /Wait for .* before forking/)
  }
  resetCreation()
  const queuedGate = deferred<QueuedRunNowResponse>()
  client.runQueuedNow = () => queuedGate.promise
  client.queue = async () => []
  const queuedRun = useAppStore.getState().runQueuedNow(selected.id, 'queued-1', generation)
  await useAppStore.getState().forkSession(selected.id, generation)
  assert.equal(forkCalls, 0, 'a pending queued Run now also owns turn admission')
  queuedGate.resolve({ ok: false, deferred: true })
  assert.equal(await queuedRun, false)

  resetCreation()
  const forkGate = deferred<{ session: Session }>()
  client.forkSession = async () => { forkCalls += 1; return forkGate.promise }
  const forkRequest = useAppStore.getState().forkSession(selected.id, generation)
  await useAppStore.getState().forkSession(selected.id, generation)
  assert.equal(forkCalls, 1, 'same-frame Fork taps submit once')
  forkGate.reject(new Error('Fork rejected'))
  await forkRequest
  assert.match(useAppStore.getState().error ?? '', /Fork rejected/)
  client.forkSession = async () => { forkCalls += 1; return { session: { ...selected, id: 'forked' } } }
  await useAppStore.getState().forkSession(selected.id, generation)
  assert.equal(forkCalls, 2, 'a failed fork releases its gate for retry')
  assert.equal(useAppStore.getState().selectedSessionId, 'forked')
  assert.equal(useAppStore.getState().sessions.filter(session => session.id === 'forked').length, 1)
  await useAppStore.getState().forkSession(selected.id, generation - 1)
  assert.equal(forkCalls, 2, 'a stale-generation fork never reaches the server')

  resetCreation()
  const oldForkGate = deferred<{ session: Session }>()
  client.forkSession = async () => { forkCalls += 1; return oldForkGate.promise }
  const oldFork = useAppStore.getState().forkSession(selected.id, generation)
  await useAppStore.getState().switchServerProfile('profile-b')
  const nextForkGeneration = useAppStore.getState().profileGeneration
  const nextForkGate = deferred<{ session: Session }>()
  client.forkSession = async () => { forkCalls += 1; return nextForkGate.promise }
  const nextFork = useAppStore.getState().forkSession(selected.id, nextForkGeneration)
  assert.equal(forkCalls, 4, 'an old-profile fork cannot block a fork of the same ID on the new profile')
  oldForkGate.resolve({ session: { ...selected, id: 'stale-fork' } })
  await oldFork
  assert.equal(useAppStore.getState().sessions.some(session => session.id === 'stale-fork'), false)
  await useAppStore.getState().forkSession(selected.id, nextForkGeneration)
  assert.equal(forkCalls, 4, 'settling the old-profile fork must not release the new-profile gate')
  nextForkGate.resolve({ session: { ...selected, id: 'next-profile-fork' } })
  await nextFork
  assert.equal(useAppStore.getState().selectedSessionId, 'next-profile-fork')
} finally {
  globalThis.fetch = originalFetch
  useAppStore.setState(originalState)
}

console.log('session creation and fork regressions passed')
