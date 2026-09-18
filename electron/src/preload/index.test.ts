import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '../shared/ipc'

const electronHarness = vi.hoisted(() => ({
  exposed: null as AgentsDockAPI | null,
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: AgentsDockAPI) => { electronHarness.exposed = api }
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => electronHarness.invoke(...args),
    send: (...args: unknown[]) => electronHarness.send(...args),
    on: (...args: unknown[]) => electronHarness.on(...args),
    removeListener: (...args: unknown[]) => electronHarness.removeListener(...args)
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

import './index'

describe('preload session IPC bridge', () => {
  beforeEach(() => electronHarness.invoke.mockReset())

  it('exposes Codex account status without shared-login mutation', () => {
    expect(electronHarness.exposed?.codex.auth).toBeTypeOf('function')
    expect(electronHarness.exposed?.codex).not.toHaveProperty('loginWithApiKey')
  })

  it('keeps side-question IPC separate from turn submission and binds cancellation to its original scope', async () => {
    const scope = { profileId: 'server-a', profileGeneration: 7 }
    const input = { request_id: 'question-a', question: 'Why?' }
    await electronHarness.exposed?.sideQuestions?.ask(scope, 'chat-a', input)
    await electronHarness.exposed?.sideQuestions?.cancel(scope, 'chat-a', input.request_id)
    expect(electronHarness.invoke.mock.calls).toEqual([
      ['side-questions:ask', scope, 'chat-a', input],
      ['side-questions:cancel', scope, 'chat-a', input.request_id]
    ])
  })

  it('exposes app language selection and change events independently of server settings', async () => {
    const snapshot = { preference: 'zh-CN', systemLocale: 'en-US' }
    electronHarness.invoke.mockResolvedValue(snapshot)
    expect(await electronHarness.exposed?.language.get()).toEqual(snapshot)
    expect(await electronHarness.exposed?.language.set('zh-CN')).toEqual(snapshot)
    expect(electronHarness.invoke.mock.calls).toEqual([['language:get'], ['language:set', 'zh-CN']])

    const listener = vi.fn()
    const remove = electronHarness.exposed?.events.on('app:language', listener)
    const registration = electronHarness.on.mock.calls.find(([channel]) => channel === 'app:language')
    expect(registration).toBeDefined()
    ;(registration?.[1] as (event: unknown, payload: unknown) => void)({}, snapshot)
    expect(listener).toHaveBeenCalledWith(snapshot)
    remove?.()
    expect(electronHarness.removeListener).toHaveBeenCalledWith('app:language', registration?.[1])
  })

  it('exposes narrow Team Hub IPC without any secret-bearing parameter', async () => {
    electronHarness.invoke.mockResolvedValue({ connectionState: 'signed-out' })
    const scope = {
      profileId: 'server-profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      generation: 3, hubIdentity: 'hub-a'
    }

    await electronHarness.exposed?.teamHub.connect()
    await electronHarness.exposed?.teamHub.bootstrap({
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })
    await electronHarness.exposed?.teamHub.join({
      email: 'member@example.test', displayName: 'Member', deviceLabel: 'Desktop'
    })
    await electronHarness.exposed?.teamHub.recoverDevice({ deviceLabel: 'This Mac' })
    await electronHarness.exposed?.teamHub.acceptInvitation(scope)
    await electronHarness.exposed?.teamHub.createInvitation(scope, {
      teamId: 'team-a', inviteeEmail: 'member@example.test', role: 'member'
    })

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'team-hub:connect')
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'team-hub:bootstrap', {
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(3, 'team-hub:join', {
      email: 'member@example.test', displayName: 'Member', deviceLabel: 'Desktop'
    })
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(4, 'team-hub:device-recover', { deviceLabel: 'This Mac' })
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(5, 'team-hub:invitation:accept', scope)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(6, 'team-hub:invitation:create', scope, {
      teamId: 'team-a', inviteeEmail: 'member@example.test', role: 'member'
    })
    expect(JSON.stringify(electronHarness.invoke.mock.calls)).not.toMatch(/proof|refresh_token|access_token|invitation token/i)
  })

  it('forwards the typed Team Network host choice through setup IPC unchanged', async () => {
    electronHarness.invoke.mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850' })
    const input = { target: 'ssh' as const, sshHost: 'user@server', port: 7850, track: 'stable' as const, teamHubHost: true }

    await electronHarness.exposed?.setup.run(input)

    expect(electronHarness.invoke).toHaveBeenCalledWith('server-setup:run', input)
  })

  it('forwards live Team Network role configuration with only the originating scope and named role', async () => {
    electronHarness.invoke.mockResolvedValue({ designatedHost: true })
    const scope = { profileId: 'studio', profileGeneration: 7, serverIdentity: 'server-studio' }

    await electronHarness.exposed?.teamHub.configureServerRole(scope, { role: 'host', serverName: 'Mac Studio' })

    expect(electronHarness.invoke).toHaveBeenCalledWith(
      'team-hub:server-role:configure', scope, { role: 'host', serverName: 'Mac Studio' }
    )
  })

  it('exposes the exact passive Team Network bridge without dispatch or attachment APIs', async () => {
    const scope = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      generation: 3, hubIdentity: 'hub-a'
    }
    const agent = { teamId: 'team-a', externalAgentId: 'chat-a', backend: 'codex' as const, displayName: 'Georgia', idempotencyKey: 'agent-key' }
    const projection = { teamId: 'team-a', afterServerId: 'node-before', limit: 25 }
    const bulletin = { teamId: 'team-a', body: 'Update', idempotencyKey: 'post-key' }
    const mailboxQuery = { teamId: 'team-a', address: { kind: 'server' as const, id: 'node-a' }, afterSequence: 4, limit: 20 }
    const mailbox = { teamId: 'team-a', to: { kind: 'agent' as const, id: 'agent-a' }, body: 'Hello', idempotencyKey: 'mail-key' }
    const receipt = { teamId: 'team-a', deliveryId: 'delivery-a', state: 'read' as const, idempotencyKey: 'receipt-key' }
    const request = { ...mailbox, expiresInSeconds: 3600, idempotencyKey: 'request-key' }
    const reply = { teamId: 'team-a', requestId: 'request-a', body: 'Done', idempotencyKey: 'reply-key' }

    await electronHarness.exposed?.teamHub.networkCapabilities(scope)
    await electronHarness.exposed?.teamHub.network(scope, projection)
    await electronHarness.exposed?.teamHub.registerNetworkAgent(scope, agent)
    await electronHarness.exposed?.teamHub.bulletin(scope, { teamId: 'team-a' })
    await electronHarness.exposed?.teamHub.postBulletin(scope, bulletin)
    await electronHarness.exposed?.teamHub.mailbox(scope, mailboxQuery)
    await electronHarness.exposed?.teamHub.sendMailbox(scope, mailbox)
    await electronHarness.exposed?.teamHub.networkItem(scope, 'team-a', 'item-a')
    await electronHarness.exposed?.teamHub.recordDeliveryReceipt(scope, receipt)
    await electronHarness.exposed?.teamHub.createPassiveRequest(scope, request)
    await electronHarness.exposed?.teamHub.passiveRequest(scope, 'team-a', 'request-a')
    await electronHarness.exposed?.teamHub.replyPassiveRequest(scope, reply)

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'team-hub:network:capabilities', scope)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'team-hub:network:get', scope, projection)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(3, 'team-hub:network:agent:register', scope, agent)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(6, 'team-hub:network:mailbox:list', scope, mailboxQuery)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(9, 'team-hub:network:delivery:receipt', scope, receipt)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(12, 'team-hub:network:request:reply', scope, reply)
    expect('networkDispatch' in (electronHarness.exposed?.teamHub ?? {})).toBe(false)
    expect('networkAttachments' in (electronHarness.exposed?.teamHub ?? {})).toBe(false)
  })

  it('exposes readiness handshakes while secure-peer invites remain receive-only events', async () => {
    electronHarness.invoke.mockResolvedValue(true)

    await electronHarness.exposed?.native.readyForNotifications()
    await electronHarness.exposed?.native.readyForSecurePeerInvite()
    const listener = vi.fn()
    const remove = electronHarness.exposed?.events.on('native:secure-peer-invite', listener)

    expect(electronHarness.invoke).toHaveBeenCalledWith('native:notification:ready')
    expect(electronHarness.invoke).toHaveBeenCalledWith('native:secure-peer-invite:ready')
    expect(electronHarness.on).toHaveBeenCalledWith('native:secure-peer-invite', expect.any(Function))
    expect('openSecurePeerInvite' in (electronHarness.exposed?.native ?? {})).toBe(false)

    remove?.()
    expect(electronHarness.removeListener).toHaveBeenCalledWith('native:secure-peer-invite', expect.any(Function))
  })

  it('forwards per-chat provider jobs access without translating the wire value', async () => {
    electronHarness.invoke.mockResolvedValue({
      id: 'chat-1', title: 'Chat', backend: 'codex', provider_jobs_access: 'blocked'
    })

    await electronHarness.exposed?.sessions.update('chat-1', {
      provider_jobs_access: 'blocked'
    })

    expect(electronHarness.invoke).toHaveBeenCalledWith(
      'sessions:update',
      'chat-1',
      { provider_jobs_access: 'blocked' }
    )
  })

  it('exposes generation-fenced port forwarding without renderer network authority', async () => {
    electronHarness.invoke.mockResolvedValue(undefined)

    await electronHarness.exposed?.ports.list('profile-a', 7)
    await electronHarness.exposed?.ports.start('profile-a', 7, 'chat /?', 7007, 17007)
    await electronHarness.exposed?.ports.stop('profile-a', 7, 7007)
    await electronHarness.exposed?.ports.open('profile-a', 7, 7007)

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'ports:list', 'profile-a', 7)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'ports:start', 'profile-a', 7, 'chat /?', 7007, 17007)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(3, 'ports:stop', 'profile-a', 7, 7007)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(4, 'ports:open', 'profile-a', 7, 7007)
  })

  it('forwards the exact emergency acknowledgement identifiers on the dedicated channel', async () => {
    const alertId = `emergency_${'a'.repeat(32)}`
    electronHarness.invoke.mockResolvedValue({
      id: 'chat /?', title: 'Emergency chat', backend: 'codex',
      emergency_alert: null, unacknowledged_emergency_count: 0
    })

    await electronHarness.exposed?.sessions.acknowledgeEmergency('chat /?', alertId)

    expect(electronHarness.invoke).toHaveBeenCalledWith(
      'sessions:emergency:acknowledge',
      'chat /?',
      alertId
    )
  })

  it('forwards managed restart status and action with the exact workspace scope', async () => {
    electronHarness.invoke.mockResolvedValue({ phase: 'idle', message: 'No restart is active.' })
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await electronHarness.exposed?.servers.restartStatus(scope)
    await electronHarness.exposed?.servers.restart(scope, 'boot-old')

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'servers:restart-status', scope)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'servers:restart', scope, 'boot-old')
  })

  it('forwards exact force-restart confirmation fields over the dedicated IPC action', async () => {
    electronHarness.invoke.mockResolvedValue({ activeProfileId: 'profile-a', profileGeneration: 8 })
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }
    const confirmation = {
      force: true as const,
      forceConfirmed: true as const,
      expectedBlockerRevision: 'a'.repeat(64),
      expectedUpdateScheduleId: '1'.repeat(32)
    }

    await electronHarness.exposed?.servers.restart(scope, 'boot-old', confirmation)

    expect(electronHarness.invoke).toHaveBeenCalledWith(
      'servers:restart',
      scope,
      'boot-old',
      confirmation
    )
  })

  it('forwards bounded exchange detail and cancellation through dedicated IPC channels', async () => {
    electronHarness.invoke.mockResolvedValue({ id: 'exchange-1', status: 'active' })

    await electronHarness.exposed?.exchanges.get('exchange-1')
    await electronHarness.exposed?.exchanges.cancel('exchange-1')

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'exchanges:get', 'exchange-1')
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'exchanges:cancel', 'exchange-1')
  })

  it('forwards the exact additive cross-chat client capability list on turn send', async () => {
    electronHarness.invoke.mockResolvedValue({ session: { id: 'chat-1', title: 'Chat', backend: 'codex' } })
    const input = {
      sessionId: 'chat-1', prompt: 'Ask @Target', fileIds: [],
      clientCapabilities: ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'],
      chatReferences: [{
        session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
        action: 'request_reply' as const
      }]
    }

    await electronHarness.exposed?.turns.send(input)

    expect(electronHarness.invoke).toHaveBeenCalledWith('turns:send', input)
  })

  it('forwards refreshed cross-chat capabilities on a queued-turn edit', async () => {
    electronHarness.invoke.mockResolvedValue(true)
    const reference = {
      session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'request_reply' as const
    }
    const capabilities = ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2']

    await electronHarness.exposed?.queue.update('chat-1', 'queued-1', 'Ask @Target', [reference], capabilities)

    expect(electronHarness.invoke).toHaveBeenCalledWith(
      'queue:update', 'chat-1', 'queued-1', 'Ask @Target', [reference], capabilities, undefined
    )
  })

  it('forwards persistent agent route administration without translating identifiers or revisions', async () => {
    electronHarness.invoke.mockResolvedValue({ routes: [], max_routes: 16 })
    const revision = `rev_${'a'.repeat(32)}`
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await electronHarness.exposed?.agentRoutes.list(scope, 'source /?')
    await electronHarness.exposed?.agentRoutes.search(scope, 'Mobile', 'source /?', 12)
    await electronHarness.exposed?.agentRoutes.create(scope, 'source /?', {
      alias: 'agentsdock-mobile', target_session_id: 'target /?', actions: ['instruction', 'request_reply']
    })
    await electronHarness.exposed?.agentRoutes.update(scope, 'source /?', 'route /?', {
      expected_revision: revision, alias: 'mobile', actions: ['request_reply']
    })
    await electronHarness.exposed?.agentRoutes.remove(scope, 'source /?', 'route /?', revision)

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'agent-routes:list', scope, 'source /?')
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'agent-routes:search', scope, 'Mobile', 'source /?', 12)
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(3, 'agent-routes:create', scope, 'source /?', {
      alias: 'agentsdock-mobile', target_session_id: 'target /?', actions: ['instruction', 'request_reply']
    })
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(4, 'agent-routes:update', scope, 'source /?', 'route /?', {
      expected_revision: revision, alias: 'mobile', actions: ['request_reply']
    })
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(5, 'agent-routes:remove', scope, 'source /?', 'route /?', revision)
  })

  it('forwards Claude MCP status and generation-fenced controls', async () => {
    electronHarness.invoke.mockResolvedValue({ version: 1, available: true, servers: [] })

    await electronHarness.exposed?.claude.mcp('claude-chat')
    await electronHarness.exposed?.claude.controlMcp('claude-chat', {
      version: 1,
      action: 'disable',
      server_name: 'dayone-cli',
      expected_generation: 'owner-a:sdk-7'
    })

    expect(electronHarness.invoke).toHaveBeenNthCalledWith(1, 'claude:mcp', 'claude-chat')
    expect(electronHarness.invoke).toHaveBeenNthCalledWith(2, 'claude:mcp:control', 'claude-chat', {
      version: 1,
      action: 'disable',
      server_name: 'dayone-cli',
      expected_generation: 'owner-a:sdk-7'
    })
  })
})
