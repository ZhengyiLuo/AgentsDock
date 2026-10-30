import assert from 'node:assert/strict'
import type { ChatDefaults, CreateSessionInput, Health, PublicServerProfile, QueuedRunNowResponse, RuntimeCatalog, Session, Snapshot, TimelinePage } from '../types'
import { WELCOME_SESSION_ID } from '../lib/welcome-session'
import { saveCachedSessions, saveWorkspacePreferences } from '../storage/cache'
import { client, useAppStore } from './useAppStore'
import { ServerError } from '../api/AgentServerClient'

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
  codex_approval_policy: 'on-request', codex_sandbox_mode: 'read-only',
  codex_permission_profile: null, codex_approvals_reviewer: 'user',
}
const profile = (id: string): PublicServerProfile => ({
  id, name: id, serverURL: `https://${id}.example`, serverIdentity: `identity-${id}`,
  serverConfigured: true, credentialVersion: 1, createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z', hasAccessToken: false,
  connectionState: 'online', cachedUnreadCount: 0,
})
const originalFetch = globalThis.fetch
const originalState = useAppStore.getState()
const originalSessionPage = client.sessionPage
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
  client.sessionPage = async () => { throw new Error('Unexpected session detail read') }
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
    backend: 'codex', model: 'gpt-current', effort: 'low',
    codex_approval_policy: 'on-request', codex_sandbox_mode: 'read-only',
    codex_permission_profile: null, codex_approvals_reviewer: 'user',
  }, 'the last open chat supplies agent, model, permissions, and location')
  assert.deepEqual(useAppStore.getState().chatDefaults, {
    backend: 'codex', model: 'gpt-current', effort: 'low', folder: 'Research', cwd: '/work/research',
  }, 'successful quick creation remembers the effective defaults')
  assert.equal(useAppStore.getState().selectedSessionId, 'created-1')

  for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const) {
    resetCreation({
      chatDefaults: { ...defaults, backend: 'codex' },
      sessions: [{ ...selected, backend: 'claude', model: 'claude-sonnet', claude_permission_mode: permissionMode }],
    })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0].backend, 'claude', 'opening Claude overrides the initial Codex preference')
    assert.equal(requests[0].claude_permission_mode, permissionMode)
    assert.equal(requests[0].codex_sandbox_mode, undefined, 'permissions belonging to another agent are not copied')
  }

  resetCreation({ sessions: [{
    ...selected, codex_permission_profile: 'restricted-project', codex_approvals_reviewer: 'auto_review',
    provider_jobs_access: 'blocked', system_prompt: 'Only applies to this chat', codex_thread_id: 'existing-thread',
  }] })
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests[0].codex_permission_profile, 'restricted-project')
  assert.equal(requests[0].codex_approvals_reviewer, 'auto_review')
  assert.equal(requests[0].provider_jobs_access, 'blocked')
  assert.equal(requests[0].system_prompt, undefined)
  assert.equal(requests[0].providerId, undefined, 'a new chat must not resume the source provider thread')

  resetCreation({ runtime: { backends: {
    codex: { models: [], efforts: [], available: false, native_credentials_present: false },
    claude: { models: [], efforts: [], available: true, native_credentials_present: true },
  } } })
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests[0].backend, 'claude')
  assert.equal(requests[0].model, '')
  assert.equal(requests[0].codex_sandbox_mode, undefined, 'unavailable agents cannot pass their policy to the fallback')

  const allAgents = ['codex', 'claude', 'cursor', 'opencode', 'gemini'] as const
  const allAgentHealth: Health = { ok: true, default_cwd: '/server/default', capabilities: {
    codex_provider_v1: { per_chat: true, per_chat_models: true },
    provider_connections_v1: { per_chat: true, backends: [...allAgents] },
    cursor_backend: { version: 2, available: true }, opencode_backend: { version: 1, available: true },
    gemini_backend: { version: 1, available: true, client_capability: 'gemini_acp_v1' },
  } }
  const agentCatalog = (available: readonly string[]): RuntimeCatalog => ({ backends: Object.fromEntries(allAgents.map(backend => [backend, {
    models: [], efforts: [], available: false, native_credentials_present: false,
    custom_provider: { configured: true, available: available.includes(backend), model: 'api-model' },
  }])) })
  for (const previous of allAgents) {
    for (const available of allAgents.filter(backend => backend !== previous)) {
      resetCreation({ sessions: [{ ...selected, backend: previous, codex_provider: 'custom', provider_connection: 'custom' }],
        health: allAgentHealth, runtime: agentCatalog([available]) })
      assert.equal(await useAppStore.getState().quickCreateSession(0), true, `${previous} -> ${available}`)
      assert.equal(requests[0].backend, available)
      assert.equal(requests[0].model, '')
      assert.equal(requests[0].cwd, '/server/default')
      assert.equal(requests[0].codex_sandbox_mode, undefined)
    }
    resetCreation({ sessions: [{ ...selected, backend: previous, codex_provider: 'custom', provider_connection: 'custom' }],
      health: allAgentHealth, runtime: agentCatalog([]) })
    assert.equal(await useAppStore.getState().quickCreateSession(0), false)
    assert.equal(requests.length, 0)
    assert.match(useAppStore.getState().error ?? '', /No available agent/)
  }

  for (const succeedOn of [3, Infinity]) {
    resetCreation({ sessions: [{ ...selected, backend: 'gemini', provider_connection: 'custom', gemini_permission_mode: 'default' }],
      health: allAgentHealth, runtime: agentCatalog(allAgents) })
    client.createSession = async input => {
      requests.push({ ...input })
      if (requests.length === succeedOn) return createdSession(input)
      throw new ServerError(409, 'Connect this custom API in My Agents before creating a chat.')
    }
    assert.equal(await useAppStore.getState().quickCreateSession(0), Number.isFinite(succeedOn))
    assert.equal(requests[0].backend, 'gemini')
    assert.equal(requests.length, Math.min(succeedOn, allAgents.length))
    assert.equal(new Set(requests.map(input => input.backend)).size, requests.length, 'try each rejected candidate only once')
  }

  for (const previous of ['codex', 'claude', 'cursor', 'opencode'] as const) {
    resetCreation({ sessions: [{ ...selected, backend: previous }],
      health: allAgentHealth, runtime: agentCatalog([previous]) })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0].backend, previous, 'the same agent API mode can be the only available fallback')
    assert.equal(previous === 'codex' ? requests[0].codex_provider : requests[0].provider_connection, 'custom')
    assert.equal(requests[0].model, '')
    assert.equal(requests[0].codex_sandbox_mode, undefined)
  }

  resetCreation({
    sessions: [{ ...selected, backend: 'cursor', model: '', cursor_permission_mode: 'ask' }],
    health: { ok: true, capabilities: { cursor_backend: { version: 2, available: true } } },
    runtime: { backends: { cursor: { models: [], efforts: [], available: true } } },
  })
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests[0].backend, 'cursor')
  assert.equal(requests[0].cursor_permission_mode, 'ask')
  assert.equal(requests[0].codex_approval_policy, undefined)

  for (const backend of ['opencode', 'gemini'] as const) {
    const permissionField = backend === 'opencode' ? 'opencode_permission_mode' : 'gemini_permission_mode'
    resetCreation({
      sessions: [{ ...selected, backend, provider_connection: 'custom', model: 'api-model', [permissionField]: 'plan' }],
      health: { ok: true, capabilities: {
        opencode_backend: { version: 1, available: true },
        gemini_backend: { version: 1, available: true, client_capability: 'gemini_acp_v1' },
        provider_connections_v1: { per_chat: true, backends: ['opencode', 'gemini'] },
      } },
      runtime: { backends: { [backend]: { models: [], efforts: [], available: true, native_credentials_present: false,
        custom_provider: { configured: true, available: true, model: 'api-model' } } } },
    })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0].backend, backend)
    assert.equal(requests[0].provider_connection, 'custom')
    assert.equal(requests[0].model, 'api-model')
    assert.equal(requests[0][permissionField], 'plan')
    assert.equal(requests[0].codex_approval_policy, undefined)
  }

  const summary = { id: selected.id, title: 'Summary only', backend: 'claude' as const }
  resetCreation({ sessions: [summary] })
  const detailGate = deferred<TimelinePage>()
  let detailReads = 0
  client.sessionPage = (id, options) => {
    assert.equal(id, selected.id)
    assert.equal(options?.limit, 1, 'inheritance never downloads a full transcript')
    detailReads += 1
    return detailGate.promise
  }
  const resolvingDefaults = useAppStore.getState().quickCreateSession(0)
  assert.equal(resolvingDefaults, useAppStore.getState().quickCreateSession(0))
  assert.equal(detailReads, 1)
  assert.equal(requests.length, 0, 'summary rows must resolve permissions before creating')
  useAppStore.setState({ selectedSessionId: 'different-chat' })
  detailGate.resolve({ session: { ...summary, claude_permission_mode: 'plan' } } as TimelinePage)
  assert.equal(await resolvingDefaults, true)
  assert.equal(requests[0].backend, 'claude')
  assert.equal(requests[0].claude_permission_mode, 'plan', 'inherit the chat captured at the tap')

  resetCreation({ sessions: [summary] })
  client.sessionPage = async () => { throw new Error('Permission lookup failed') }
  assert.equal(await useAppStore.getState().quickCreateSession(0), false)
  assert.equal(requests.length, 0, 'failed permission reads must not create with a different policy')
  assert.match(useAppStore.getState().error ?? '', /Permission lookup failed/)
  client.sessionPage = async () => ({ session: { ...summary, claude_permission_mode: 'default' } } as TimelinePage)
  assert.equal(await useAppStore.getState().quickCreateSession(0), true, 'detail-read failure releases the create gate')

  const apiHealth = { ok: true, capabilities: {
    codex_provider_v1: { per_chat: true, per_chat_models: true },
    provider_connections_v1: { per_chat: true },
  } }
  const apiCatalog = { backends: Object.fromEntries(['codex', 'claude'].map(backend => [backend, {
    native_credentials_present: false, available: false, models: [], efforts: [],
    custom_provider: { configured: true, available: true, model: 'api-model' },
  }])) }
  for (const backend of ['codex', 'claude'] as const) {
    const modeField = backend === 'codex' ? 'codex_provider' : 'provider_connection'
    resetCreation({ selectedSessionId: null, health: apiHealth, runtime: apiCatalog, chatDefaults: { ...defaults, backend, [modeField]: 'custom', model: 'api-model' } })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0][modeField], 'custom', 'API mode must reach the client even with no native login')
    assert.equal(useAppStore.getState().chatDefaults[modeField], 'custom')
    assert.equal(useAppStore.getState().sessions.at(-1)?.[modeField], 'custom')
    requests.length = 0
    useAppStore.setState({ runtime: { backends: { [backend]: { models: [], efforts: [], native_credentials_present: true } } } })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests.length, 1, 'an unavailable custom default must not block a new blank chat')
    assert.equal(requests[0].codex_provider, undefined)
    assert.equal(requests[0].provider_connection, undefined)
    assert.equal(requests[0].model, '')
    assert.equal(requests[0].cwd, '', 'without an advertised directory, let the server use its default')

    resetCreation({
      health: apiHealth, runtime: apiCatalog,
      sessions: [{ ...selected, backend, [modeField]: 'custom', model: 'api-model', claude_permission_mode: 'plan' }],
    })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0].backend, backend)
    assert.equal(requests[0][modeField], 'custom', 'the last open API chat overrides native saved defaults')
    assert.equal(requests[0].model, 'api-model')
  }
  resetCreation({ health: apiHealth, runtime: apiCatalog })
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests[0].backend === 'codex' ? requests[0].codex_provider : requests[0].provider_connection,
    'custom', 'API-only servers create in an available API mode')
  assert.equal(requests[0].model, '', 'switching to API must not carry a native model default')

  resetCreation({ health: apiHealth, runtime: apiCatalog })
  client.createSession = async input => ({ ...createdSession(input), codex_provider: 'default', provider_connection: 'default' })
  assert.equal(await useAppStore.getState().quickCreateSession(0), false, 'a server ignoring API routing must not open a native chat as though it were custom')
  assert.equal(useAppStore.getState().selectedSessionId, selected.id)

  const geminiHealth = { ok: true, default_cwd: '/server/default', capabilities: {
    gemini_backend: { available: true, version: 1, client_capability: 'gemini_acp_v1' },
    provider_connections_v1: { per_chat: true, backends: ['gemini'] },
  } }
  const geminiCatalog = { backends: { gemini: { models: [], efforts: [],
    custom_provider: { configured: true, available: true, model: 'api-model' } } } }
  const geminiChat: Session = { ...selected, backend: 'gemini', provider_connection: 'custom',
    cwd: '/deleted/workspace', model: 'api-model', gemini_permission_mode: 'plan' }
  resetCreation({ sessions: [geminiChat], health: geminiHealth, runtime: geminiCatalog })
  client.createSession = async input => {
    requests.push({ ...input })
    if (input.cwd === '/deleted/workspace') throw new ServerError(400, 'Gemini requires an existing workspace directory.')
    return createdSession(input)
  }
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[1].backend, 'gemini')
  assert.equal(requests[1].cwd, '/server/default')
  assert.equal(requests[1].gemini_permission_mode, undefined)
  assert.equal(useAppStore.getState().sessions[0].cwd, '/deleted/workspace', 'never rewrite the old chat workspace')
  assert.equal(useAppStore.getState().error, null)

  for (const failure of [new ServerError(500, 'Gemini requires an existing workspace directory.'),
    new ServerError(401, 'Unauthorized'), new Error('Network request timed out')]) {
    resetCreation({ sessions: [geminiChat], health: geminiHealth, runtime: geminiCatalog })
    client.createSession = async input => { requests.push({ ...input }); throw failure }
    assert.equal(await useAppStore.getState().quickCreateSession(0), false)
    assert.equal(requests.length, 1, 'unknown write outcomes and auth errors cannot create a second chat')
  }

  resetCreation({ sessions: [geminiChat], health: geminiHealth, runtime: geminiCatalog })
  client.createSession = async input => { requests.push({ ...input }); throw new ServerError(400, 'Gemini requires an existing workspace directory.') }
  assert.equal(await useAppStore.getState().quickCreateSession(0), false)
  assert.equal(requests.length, 2, 'a bad server default does not cause an infinite retry')
  requests.length = 0
  assert.equal(await useAppStore.getState().createSession({ title: 'Explicit', folder: 'General', cwd: '/deleted/workspace', backend: 'gemini', provider_connection: 'custom' }, 0), false)
  assert.equal(requests.length, 1, 'explicit workspace choices are never silently replaced')

  for (const [events, running] of [
    [[{ type: 'turn_started' }, { type: 'error' }, { type: 'turn_finished' }], false],
    [[{ type: 'error' }, { type: 'turn_started' }, { type: 'assistant_text' }, { type: 'turn_finished' }], false],
    [[{ type: 'turn_started' }, { type: 'error' }], true],
  ] as const) {
    resetCreation({ sessions: [geminiChat], health: geminiHealth, runtime: geminiCatalog,
      activeSessionIds: new Set(running ? [geminiChat.id] : []),
      snapshots: { [geminiChat.id]: { events } as unknown as Snapshot } })
    assert.equal(await useAppStore.getState().quickCreateSession(0), true)
    assert.equal(requests[0].backend, 'gemini', 'a message failure is not a create failure')
    assert.equal(requests[0].provider_connection, 'custom')
    assert.equal(requests[0].model, 'api-model')
    assert.equal(requests[0].gemini_permission_mode, 'plan')
    assert.equal(requests.length, 1, 'inherit the selected agent regardless of previous turn outcomes')
  }

  resetCreation({ sessions: [geminiChat], health: geminiHealth, runtime: geminiCatalog })
  client.createSession = async input => {
    requests.push({ ...input })
    if (input.backend === 'gemini') throw new ServerError(409, 'Connect this custom API in My Agents before creating a chat.')
    return createdSession(input)
  }
  assert.equal(await useAppStore.getState().quickCreateSession(0), true)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[1].backend, 'gemini')
  assert.equal(requests[1].gemini_permission_mode, undefined)
  assert.equal(requests[1].model, '')
  assert.equal(requests[1].cwd, '/server/default')

  const originalUpdate = client.updateSession
  try {
    const updates: Partial<Session>[] = []
    client.updateSession = async (id, patch) => { updates.push(patch); return { ...selected, ...patch, id } }
    resetCreation({ health: apiHealth, runtime: apiCatalog })
    assert.equal(await useAppStore.getState().updateSession(selected.id, { codex_provider: 'custom', model: null, effort: null }, 0), true)
    assert.equal(updates[0].codex_provider, 'custom')
    resetCreation({ health: apiHealth, runtime: apiCatalog })
    client.updateSession = async () => selected
    assert.equal(await useAppStore.getState().updateSession(selected.id, { codex_provider: 'custom', model: null }, 0), false)
    assert.equal(useAppStore.getState().sessions[0].codex_provider, undefined, 'ignored API selection rolls back instead of appearing successful')
    useAppStore.setState({ sessions: [{ ...selected, codex_provider: 'custom', codex_thread_id: 'started-thread' }] })
    assert.equal(await useAppStore.getState().updateSession(selected.id, { codex_provider: 'default' }, 0), false)
    assert.equal(updates.length, 1, 'a started chat cannot switch credentials even if the backend stays the same')
  } finally { client.updateSession = originalUpdate }

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
    assert.equal(requests[0]?.backend, defaults.backend, `${label} uses the saved agent`)
    assert.equal(requests[0]?.codex_sandbox_mode, undefined)
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
    assert.equal(requests[1]?.model, nextSession.model)
    assert.equal(requests[1]?.codex_sandbox_mode, nextSession.codex_sandbox_mode)
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

  resetCreation({ sessions: [summary] })
  const staleDetail = deferred<TimelinePage>()
  client.sessionPage = () => staleDetail.promise
  const oldDetailRequest = useAppStore.getState().quickCreateSession(useAppStore.getState().profileGeneration)
  await useAppStore.getState().switchServerProfile('profile-b')
  staleDetail.resolve({ session: { ...summary, claude_permission_mode: 'plan' } } as TimelinePage)
  assert.equal(await oldDetailRequest, false)
  assert.equal(requests.length, 0, 'switching servers during the permission lookup cannot create on either server')
  assert.equal(useAppStore.getState().error, null)
  await useAppStore.getState().switchServerProfile('uninitialized')

  resetCreation()
  let forkCalls = 0
  client.forkSession = async () => { forkCalls += 1; return { session: { ...selected, id: 'forked' } } }
  const generation = useAppStore.getState().profileGeneration
  resetCreation({ sessions: [{ ...selected, backend: 'gemini' }] })
  await useAppStore.getState().forkSession(selected.id, generation)
  assert.equal(forkCalls, 0, 'unsupported Gemini forks must not reach the server')
  assert.match(useAppStore.getState().error ?? '', /does not support forking Gemini/)
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
  client.sessionPage = originalSessionPage
  globalThis.fetch = originalFetch
  useAppStore.setState(originalState)
}

console.log('session creation and fork regressions passed')
