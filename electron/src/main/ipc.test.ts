import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppService } from './service'
import type { AppUpdateManager } from './updater'
import type { LazyTeamHubService } from './team-hub-lazy-service'
import type { SendTurnInput } from '../shared/types'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class BrowserWindow {
    static fromWebContents() { return { isDestroyed: () => false } }
  },
  clipboard: { readText: vi.fn(), writeText: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => harness.handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => harness.handlers.set(channel, handler)),
    removeAllListeners: vi.fn(),
    on: vi.fn()
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }
}))

vi.mock('./server-setup', () => ({
  ServerSetupManager: class ServerSetupManager {
    capabilities() { return {} }
    cancel() { return false }
    diagnostics() { return { logPath: '/tmp/setup.log' } }
  }
}))

import { registerIpc } from './ipc'

const trustedEvent = {
  sender: { id: 1, getURL: () => 'file:///app/out/renderer/index.html' },
  senderFrame: { url: 'file:///app/out/renderer/index.html', parent: null }
}

describe('Team Hub IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('routes member rename through exact scoped IPC and blocks untrusted frames', async () => {
    const result = { id: 'node-1', server_identity: 'server-1', display_name: 'New name' }
    const renameNetworkServer = vi.fn().mockResolvedValue(result)
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy({ renameNetworkServer }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'member', profileGeneration: 3, generation: 4, serverIdentity: 'server-1',
      hubIdentity: 'hub-1', connectionId: 'connection-1', hostServerIdentity: 'host-1' }
    const input = { teamId: 'team-1', serverId: 'node-1', displayName: 'New name' }
    const handler = harness.handlers.get('team-hub:network:server:rename')!
    await expect(handler(trustedEvent, scope, input)).resolves.toEqual(result)
    expect(renameNetworkServer).toHaveBeenCalledExactlyOnceWith(scope, input)
    expect(() => handler({ sender: { id: 2, getURL: () => 'https://untrusted.invalid/' },
      senderFrame: { url: 'https://untrusted.invalid/', parent: null } }, scope, input)).toThrow('untrusted renderer')
    expect(renameNetworkServer).toHaveBeenCalledTimes(1)
  })

  it('routes Team Network role configuration with the immutable originating server scope', async () => {
    const configureServerRole = vi.fn().mockResolvedValue({ designatedHost: true })
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy({ configureServerRole }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'studio', profileGeneration: 9, serverIdentity: 'server-studio' }
    const input = { role: 'host', serverName: 'Mac Studio' }

    await expect(harness.handlers.get('team-hub:server-role:configure')?.(trustedEvent, scope, input)).resolves.toEqual({ designatedHost: true })
    expect(configureServerRole).toHaveBeenCalledOnce()
    expect(configureServerRole).toHaveBeenCalledWith(scope, input)
  })

  it('routes app language independently of server settings and rejects untrusted callers', async () => {
    const snapshot = { preference: 'zh-CN' as const, systemLocale: 'en-US' }
    const language = { get: vi.fn(() => snapshot), set: vi.fn(() => snapshot) }
    const applySettings = vi.fn()
    registerIpc({ applySettings } as unknown as AppService, {} as AppUpdateManager, undefined, { language })
    expect(await harness.handlers.get('language:get')?.(trustedEvent)).toEqual(snapshot)
    expect(await harness.handlers.get('language:set')?.(trustedEvent, 'zh-CN')).toEqual(snapshot)
    expect(language.set).toHaveBeenCalledExactlyOnceWith('zh-CN')
    expect(applySettings).not.toHaveBeenCalled()
    expect(() => harness.handlers.get('language:set')?.({
      sender: { id: 2, getURL: () => 'https://untrusted.invalid/' },
      senderFrame: { url: 'https://untrusted.invalid/', parent: null }
    }, 'en')).toThrow('untrusted renderer')
    expect(language.set).toHaveBeenCalledTimes(1)
  })

  it('routes only sanitized bootstrap fields and exact scope through trusted IPC', async () => {
    const teamHub = {
      bootstrap: vi.fn().mockResolvedValue({ status: { authenticated: true }, teams: [] }),
      acceptInvitation: vi.fn().mockResolvedValue({ membership: {}, workspace: {} }),
      createInvitation: vi.fn().mockResolvedValue({ saved: true, id: 'invite-1', fileName: 'invite.txt' })
    }
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy(teamHub, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'hub-profile-a', generation: 2, hubIdentity: 'hub-a' }

    await harness.handlers.get('team-hub:bootstrap')?.(trustedEvent, {
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })
    await harness.handlers.get('team-hub:invitation:create')?.(trustedEvent, scope, {
      teamId: 'team-a', inviteeEmail: 'member@example.test', role: 'member'
    })
    await harness.handlers.get('team-hub:invitation:accept')?.(trustedEvent, scope)

    expect(teamHub.bootstrap).toHaveBeenCalledWith({
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })
    expect(teamHub.createInvitation).toHaveBeenCalledWith(scope, {
      teamId: 'team-a', inviteeEmail: 'member@example.test', role: 'member'
    })
    expect(teamHub.acceptInvitation).toHaveBeenCalledWith(scope)
  })

  it('routes only the scoped workspace preview identity through trusted IPC', async () => {
    const workspacePreviewAvailable = vi.fn().mockResolvedValue(true)
    registerIpc({ workspacePreviewAvailable } as unknown as AppService, {} as AppUpdateManager)
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await expect(harness.handlers.get('workspace:preview-available')?.(
      trustedEvent,
      scope,
      'chat-a',
      'assets/diagram.png'
    )).resolves.toBe(true)
    expect(workspacePreviewAvailable).toHaveBeenCalledWith(
      scope,
      'chat-a',
      'assets/diagram.png'
    )
  })

  it('blocks an untrusted Team Hub caller before selecting or writing secret files', () => {
    const bootstrap = vi.fn()
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy({ bootstrap }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const untrusted = {
      sender: { id: 2, getURL: () => 'https://attacker.invalid/' },
      senderFrame: { url: 'https://attacker.invalid/', parent: null }
    }

    expect(() => harness.handlers.get('team-hub:bootstrap')?.(untrusted, {
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })).toThrow('untrusted renderer')
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('admits Team attachment paths through the chooser grant and binds upload to the exact declaration', async () => {
    const closeDeclaration = vi.fn()
    const closeUpload = vi.fn()
    const admittedDeclaration = { requestedPath: '/chosen.txt', canonicalPath: '/chosen.txt', fd: 10, byteSize: 3, close: closeDeclaration }
    const admittedUpload = { requestedPath: '/chosen.txt', canonicalPath: '/chosen.txt', fd: 11, byteSize: 3, close: closeUpload }
    const admitTeamAttachmentFile = vi.fn()
      .mockReturnValueOnce(admittedDeclaration)
      .mockReturnValueOnce(admittedUpload)
    const bindTeamAttachmentDeclaration = vi.fn()
    const abandonTeamAttachmentDeclaration = vi.fn()
    const operationSignal = new AbortController().signal
    const releaseOperation = vi.fn()
    const assertCurrent = vi.fn()
    const beginTeamAttachmentOperation = vi.fn(() => ({
      signal: operationSignal,
      assertCurrent,
      release: releaseOperation
    }))
    const appService = new Proxy({
      admitTeamAttachmentFile,
      bindTeamAttachmentDeclaration,
      abandonTeamAttachmentDeclaration,
      beginTeamAttachmentOperation
    }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    const teamHub = {
      declareTeamAttachment: vi.fn().mockResolvedValue({ attachment: { id: 'attachment-a' }, chunk_bytes: 1024 }),
      uploadTeamAttachment: vi.fn().mockResolvedValue({ id: 'attachment-a', state: 'ready' })
    }
    registerIpc(appService, {} as AppUpdateManager, new Proxy(teamHub, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'profile-a', profileGeneration: 7, generation: 3, hubIdentity: 'hub-a' }
    const declarationInput = { teamId: 'team-a', path: '/chosen.txt', idempotencyKey: 'declare-a' }
    const uploadInput = { teamId: 'team-a', attachmentId: 'attachment-a', path: '/chosen.txt' }

    await harness.handlers.get('team-hub:network:attachment:declare')?.(trustedEvent, scope, declarationInput)
    await harness.handlers.get('team-hub:network:attachment:upload')?.(trustedEvent, scope, uploadInput)

    expect(admitTeamAttachmentFile).toHaveBeenNthCalledWith(1, 1, scope, 'team-a', '/chosen.txt')
    expect(bindTeamAttachmentDeclaration).toHaveBeenCalledWith(1, scope, 'team-a', '/chosen.txt', 'attachment-a')
    expect(admitTeamAttachmentFile).toHaveBeenNthCalledWith(2, 1, scope, 'team-a', '/chosen.txt', 'attachment-a')
    expect(teamHub.declareTeamAttachment).toHaveBeenCalledWith(scope, declarationInput, admittedDeclaration, operationSignal)
    expect(teamHub.uploadTeamAttachment).toHaveBeenCalledWith(scope, uploadInput, admittedUpload, operationSignal)
    expect(beginTeamAttachmentOperation).toHaveBeenCalledTimes(2)
    expect(assertCurrent).toHaveBeenCalledTimes(2)
    expect(releaseOperation).toHaveBeenCalledTimes(2)
    expect(abandonTeamAttachmentDeclaration).not.toHaveBeenCalled()
    expect(closeDeclaration).toHaveBeenCalledOnce()
    expect(closeUpload).toHaveBeenCalledOnce()
  })

  it('abandons a Team attachment declaration reservation when inspection fails', async () => {
    const close = vi.fn()
    const admitted = { requestedPath: '/chosen.txt', canonicalPath: '/chosen.txt', fd: 10, byteSize: 3, close }
    const operation = { signal: new AbortController().signal, assertCurrent: vi.fn(), release: vi.fn() }
    const appService = new Proxy({
      beginTeamAttachmentOperation: vi.fn(() => operation),
      admitTeamAttachmentFile: vi.fn(() => admitted),
      bindTeamAttachmentDeclaration: vi.fn(),
      abandonTeamAttachmentDeclaration: vi.fn()
    }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    const teamHub = { declareTeamAttachment: vi.fn().mockRejectedValue(new Error('hash cancelled')) }
    registerIpc(appService, {} as AppUpdateManager, new Proxy(teamHub, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'profile-a', profileGeneration: 7, generation: 3, hubIdentity: 'hub-a' }

    await expect(harness.handlers.get('team-hub:network:attachment:declare')?.(
      trustedEvent, scope, { teamId: 'team-a', path: '/chosen.txt', idempotencyKey: 'declare-a' }
    )).rejects.toThrow('hash cancelled')

    expect(appService.abandonTeamAttachmentDeclaration).toHaveBeenCalledWith(
      1, scope, 'team-a', '/chosen.txt'
    )
    expect(close).toHaveBeenCalledOnce()
    expect(operation.release).toHaveBeenCalledOnce()
  })

  it('always releases the renderer operation when a malformed attachment declaration is rejected', async () => {
    const release = vi.fn()
    const abandon = vi.fn(() => { throw new Error('must not mask admission error') })
    const appService = new Proxy({
      beginTeamAttachmentOperation: vi.fn(() => ({
        signal: new AbortController().signal, assertCurrent: vi.fn(), release
      })),
      admitTeamAttachmentFile: vi.fn(() => { throw new Error('invalid attachment input') }),
      abandonTeamAttachmentDeclaration: abandon
    }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(appService, {} as AppUpdateManager, new Proxy({}, {
      get: () => vi.fn()
    }) as unknown as LazyTeamHubService)
    const invoke = harness.handlers.get('team-hub:network:attachment:declare')!

    await expect(invoke(trustedEvent, {}, null)).rejects.toThrow('invalid attachment input')
    await expect(invoke(trustedEvent, {}, null)).rejects.toThrow('invalid attachment input')
    expect(release).toHaveBeenCalledTimes(2)
    expect(abandon).not.toHaveBeenCalled()
  })

  it('routes bounded human-administration pages and mutations through the trusted bridge', async () => {
    const teamHub = {
      deviceSessions: vi.fn().mockResolvedValue({ sessions: [], has_more: false, next_cursor: null }),
      revokeDeviceSession: vi.fn().mockResolvedValue({ revoked: true }),
      members: vi.fn().mockResolvedValue({ members: [], has_more: false, next_cursor: null }),
      invitations: vi.fn().mockResolvedValue({ invitations: [], has_more: false, next_cursor: null }),
      revokeInvitation: vi.fn().mockResolvedValue({ revoked: true }),
      updateMember: vi.fn().mockResolvedValue({ principal_id: 'person-2' })
    }
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy(teamHub, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = { profileId: 'profile-a', profileGeneration: 2, serverIdentity: 'server-a', generation: 3, hubIdentity: 'hub-a' }

    await harness.handlers.get('team-hub:device-sessions')?.(trustedEvent, scope, 'device-cursor')
    await harness.handlers.get('team-hub:device-session:revoke')?.(trustedEvent, scope, 'session-2')
    await harness.handlers.get('team-hub:members')?.(trustedEvent, scope, 'team-a', 'member-cursor')
    await harness.handlers.get('team-hub:invitations')?.(trustedEvent, scope, 'team-a', 'invite-cursor')
    await harness.handlers.get('team-hub:invitation:revoke')?.(trustedEvent, scope, 'team-a', 'invite-2')
    await harness.handlers.get('team-hub:member:update')?.(trustedEvent, scope, {
      teamId: 'team-a', principalId: 'person-2', patch: { status: 'suspended' }
    })

    expect(teamHub.deviceSessions).toHaveBeenCalledWith(scope, 'device-cursor')
    expect(teamHub.revokeDeviceSession).toHaveBeenCalledWith(scope, 'session-2')
    expect(teamHub.members).toHaveBeenCalledWith(scope, 'team-a', 'member-cursor')
    expect(teamHub.invitations).toHaveBeenCalledWith(scope, 'team-a', 'invite-cursor')
    expect(teamHub.revokeInvitation).toHaveBeenCalledWith(scope, 'team-a', 'invite-2')
    expect(teamHub.updateMember).toHaveBeenCalledWith(scope, {
      teamId: 'team-a', principalId: 'person-2', patch: { status: 'suspended' }
    })
  })

  it('keeps ordinary app IPC usable when optional Team Hub initialization is unavailable', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ sessions: [{ id: 'chat-1' }] })
    const appService = new Proxy({ bootstrap }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    const unavailableHub = {
      status: vi.fn(() => ({
        version: 1, profileId: 'team-hub-unavailable', profileGeneration: 0,
        serverIdentity: null, serverName: null, generation: 0,
        hubUrl: null, hubIdentity: null, savedHubIdentity: null, designatedHost: false,
        availabilityMessage: null, availabilityAction: null, canForgetBinding: false,
        connectionState: 'error', authenticated: false, bootstrapRequired: false,
        principal: null, session: null, error: 'settings volume is read-only'
      }))
    } as unknown as LazyTeamHubService
    registerIpc(appService, {} as AppUpdateManager, unavailableHub)

    await expect(harness.handlers.get('app:bootstrap')?.(trustedEvent)).resolves.toEqual({ sessions: [{ id: 'chat-1' }] })
    expect(harness.handlers.get('team-hub:status')?.(trustedEvent)).toMatchObject({ connectionState: 'error' })
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it('routes generation-fenced port actions through the main-process owner', async () => {
    const service = {
      listForwardedPorts: vi.fn().mockReturnValue([]),
      startForwardedPort: vi.fn().mockResolvedValue({
        sessionId: 'chat /?', remotePort: 7007, localPort: 17007,
        localUrl: 'http://127.0.0.1:17007', state: 'open', error: null
      }),
      stopForwardedPort: vi.fn().mockResolvedValue(undefined),
      openForwardedPort: vi.fn().mockResolvedValue(undefined)
    }
    registerIpc(new Proxy(service, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService, {} as AppUpdateManager)

    await harness.handlers.get('ports:list')?.(trustedEvent, 'profile-a', 7)
    await harness.handlers.get('ports:start')?.(trustedEvent, 'profile-a', 7, 'chat /?', 7007, 17007)
    await harness.handlers.get('ports:stop')?.(trustedEvent, 'profile-a', 7, 7007)
    await harness.handlers.get('ports:open')?.(trustedEvent, 'profile-a', 7, 7007)

    expect(service.listForwardedPorts).toHaveBeenCalledWith('profile-a', 7)
    expect(service.startForwardedPort).toHaveBeenCalledWith('profile-a', 7, 'chat /?', 7007, 17007)
    expect(service.stopForwardedPort).toHaveBeenCalledWith('profile-a', 7, 7007)
    expect(service.openForwardedPort).toHaveBeenCalledWith('profile-a', 7, 7007)
  })

  it('acknowledges secure-peer invite readiness only through trusted renderer IPC', async () => {
    const ready = vi.fn(() => true)
    registerIpc({} as AppService, {} as AppUpdateManager, undefined, { securePeerInviteReady: ready })

    expect(harness.handlers.get('native:secure-peer-invite:ready')?.(trustedEvent)).toBe(true)
    expect(ready).toHaveBeenCalledOnce()

    const untrusted = {
      sender: { id: 2, getURL: () => 'https://attacker.invalid/' },
      senderFrame: { url: 'https://attacker.invalid/', parent: null }
    }
    expect(() => harness.handlers.get('native:secure-peer-invite:ready')?.(untrusted)).toThrow('untrusted renderer')
    expect(ready).toHaveBeenCalledOnce()
  })

  it('acknowledges notification routing readiness only through trusted renderer IPC', () => {
    const ready = vi.fn(() => true)
    registerIpc({} as AppService, {} as AppUpdateManager, undefined, { notificationReady: ready })

    expect(harness.handlers.get('native:notification:ready')?.(trustedEvent)).toBe(true)
    expect(ready).toHaveBeenCalledOnce()

    const untrusted = {
      sender: { id: 2, getURL: () => 'https://attacker.invalid/' },
      senderFrame: { url: 'https://attacker.invalid/', parent: null }
    }
    expect(() => harness.handlers.get('native:notification:ready')?.(untrusted)).toThrow('untrusted renderer')
    expect(ready).toHaveBeenCalledOnce()
  })

  it('keeps secure-peer approval CAS fields and the chosen scope subset intact across trusted IPC', async () => {
    const approveSecurePeerPairing = vi.fn().mockResolvedValue({ status: 'approved' })
    const teamHub = new Proxy({ approveSecurePeerPairing }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService
    registerIpc({} as AppService, {} as AppUpdateManager, teamHub)
    const scope = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-local',
      generation: 2, hubIdentity: 'hub-local'
    }
    const input = {
      pairingId: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      teamId: 'team-local',
      expectedPeerServerIdentity: 'server-remote',
      expectedTranscriptHash: 'a'.repeat(64),
      scopes: ['teamspace.read', 'cross_chat.instruction'],
      sasConfirmed: true
    }

    await harness.handlers.get('team-hub:secure-peer:approve')?.(trustedEvent, scope, input)

    expect(approveSecurePeerPairing).toHaveBeenCalledWith(scope, input)
  })

  it('routes the passive Team Network surface through dedicated trusted IPC only', async () => {
    const methods = {
      networkCapabilities: vi.fn(), network: vi.fn(), registerNetworkAgent: vi.fn(),
      bulletin: vi.fn(), postBulletin: vi.fn(), deleteNetworkBulletin: vi.fn(), networkDeletions: vi.fn(), mailbox: vi.fn(),
      sendMailbox: vi.fn(), networkItem: vi.fn(), recordDeliveryReceipt: vi.fn(),
      createPassiveRequest: vi.fn(), passiveRequest: vi.fn(), replyPassiveRequest: vi.fn(),
      deleteTeamMessage: vi.fn()
    }
    methods.networkDeletions.mockResolvedValue({ supported: false, reason: 'unsupported' })
    registerIpc({} as AppService, {} as AppUpdateManager, new Proxy(methods, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as LazyTeamHubService)
    const scope = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      generation: 3, hubIdentity: 'hub-a'
    }
    const agent = { teamId: 'team-a', externalAgentId: 'chat-a', backend: 'codex', displayName: 'Georgia', idempotencyKey: 'agent-key' }
    const projection = { teamId: 'team-a', afterServerId: 'node-before', limit: 25 }
    const bulletin = { teamId: 'team-a', body: 'Update', idempotencyKey: 'post-key' }
    const bulletinDelete = { teamId: 'team-a', postId: 'post-a', idempotencyKey: 'delete-post-key' }
    const deletionQuery = { teamId: 'team-a', afterSequence: 3, limit: 25 }
    const messageDelete = { teamId: 'team-a', messageId: 'message-a', idempotencyKey: 'delete-message-key' }
    const mailboxQuery = { teamId: 'team-a', address: { kind: 'server', id: 'node-a' }, afterSequence: 4, limit: 20 }
    const mailbox = { teamId: 'team-a', to: { kind: 'agent', id: 'agent-a' }, body: 'Hello', idempotencyKey: 'mail-key' }
    const receipt = { teamId: 'team-a', deliveryId: 'delivery-a', state: 'read', idempotencyKey: 'receipt-key' }
    const request = { ...mailbox, expiresInSeconds: 3600, idempotencyKey: 'request-key' }
    const reply = { teamId: 'team-a', requestId: 'request-a', body: 'Done', idempotencyKey: 'reply-key' }

    await harness.handlers.get('team-hub:network:capabilities')?.(trustedEvent, scope)
    await harness.handlers.get('team-hub:network:get')?.(trustedEvent, scope, projection)
    await harness.handlers.get('team-hub:network:agent:register')?.(trustedEvent, scope, agent)
    await harness.handlers.get('team-hub:network:bulletin:list')?.(trustedEvent, scope, { teamId: 'team-a' })
    await harness.handlers.get('team-hub:network:bulletin:post')?.(trustedEvent, scope, bulletin)
    await harness.handlers.get('team-hub:network:bulletin:delete')?.(trustedEvent, scope, bulletinDelete)
    await expect(harness.handlers.get('team-hub:network:deletions:list')?.(
      trustedEvent, scope, deletionQuery
    )).resolves.toEqual({ supported: false, reason: 'unsupported' })
    await harness.handlers.get('team-hub:network:message:delete')?.(trustedEvent, scope, messageDelete)
    await harness.handlers.get('team-hub:network:mailbox:list')?.(trustedEvent, scope, mailboxQuery)
    await harness.handlers.get('team-hub:network:mailbox:send')?.(trustedEvent, scope, mailbox)
    await harness.handlers.get('team-hub:network:item:get')?.(trustedEvent, scope, 'team-a', 'item-a')
    await harness.handlers.get('team-hub:network:delivery:receipt')?.(trustedEvent, scope, receipt)
    await harness.handlers.get('team-hub:network:request:create')?.(trustedEvent, scope, request)
    await harness.handlers.get('team-hub:network:request:get')?.(trustedEvent, scope, 'team-a', 'request-a')
    await harness.handlers.get('team-hub:network:request:reply')?.(trustedEvent, scope, reply)

    expect(methods.network).toHaveBeenCalledWith(scope, projection)
    expect(methods.registerNetworkAgent).toHaveBeenCalledWith(scope, agent)
    expect(methods.deleteNetworkBulletin).toHaveBeenCalledWith(scope, bulletinDelete)
    expect(methods.networkDeletions).toHaveBeenCalledWith(scope, deletionQuery)
    expect(methods.deleteTeamMessage).toHaveBeenCalledWith(scope, messageDelete)
    expect(methods.mailbox).toHaveBeenCalledWith(scope, mailboxQuery)
    expect(methods.recordDeliveryReceipt).toHaveBeenCalledWith(scope, receipt)
    expect(methods.replyPassiveRequest).toHaveBeenCalledWith(scope, reply)
    expect(harness.handlers.has('team-hub:network:dispatch')).toBe(false)
    expect(harness.handlers.has('team-hub:network:attachments')).toBe(false)
  })
})

describe('Import Chat IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('rejects malformed bulk-import input before it reaches AppService', () => {
    const bulkImportSessions = vi.fn()
    const service = new Proxy({ bulkImportSessions }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)

    expect(() => harness.handlers.get('sessions:bulk-import')?.(trustedEvent, [{
      provider_session_id: 'provider-1',
      backend: 'attacker',
      cwd: '/tmp'
    }])).toThrow(/backend is invalid/i)
    expect(bulkImportSessions).not.toHaveBeenCalled()
  })

  it('passes only validated bulk-import fields to AppService', async () => {
    const bulkImportSessions = vi.fn().mockResolvedValue([])
    const service = new Proxy({ bulkImportSessions }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)

    await harness.handlers.get('sessions:bulk-import')?.(trustedEvent, [{
      provider_session_id: 'provider-1',
      backend: 'claude',
      cwd: '/work',
      title: 'Imported chat',
      injected: { admin: true }
    }])

    expect(bulkImportSessions).toHaveBeenCalledWith([{
      provider_session_id: 'provider-1',
      backend: 'claude',
      cwd: '/work',
      title: 'Imported chat'
    }])
  })
})

describe('managed server restart IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('routes status and restart through the exact workspace profile scope', async () => {
    const serverRestartStatus = vi.fn().mockResolvedValue({ phase: 'idle', message: 'Idle.' })
    const restartServer = vi.fn().mockResolvedValue({ activeProfileId: 'profile-a', profileGeneration: 8 })
    const service = new Proxy({ serverRestartStatus, restartServer }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await harness.handlers.get('servers:restart-status')?.(trustedEvent, scope)
    await harness.handlers.get('servers:restart')?.(trustedEvent, scope, 'boot-old')

    expect(serverRestartStatus).toHaveBeenCalledWith(scope)
    expect(restartServer).toHaveBeenCalledWith(scope, 'boot-old')
  })

  it('forwards the exact explicit force confirmation without weakening its booleans or revision', async () => {
    const restartServer = vi.fn().mockResolvedValue({ activeProfileId: 'profile-a', profileGeneration: 8 })
    const service = new Proxy({ restartServer }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }
    const confirmation = {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'a'.repeat(64),
      expectedUpdateScheduleId: '1'.repeat(32)
    }

    await harness.handlers.get('servers:restart')?.(trustedEvent, scope, 'boot-old', confirmation)

    expect(restartServer).toHaveBeenCalledWith(scope, 'boot-old', confirmation)
  })

  it('rejects an untrusted restart before the service can receive it', () => {
    const restartServer = vi.fn()
    const service = new Proxy({ restartServer }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const untrusted = {
      sender: { id: 2, getURL: () => 'https://attacker.invalid/' },
      senderFrame: { url: 'https://attacker.invalid/', parent: null }
    }

    expect(() => harness.handlers.get('servers:restart')?.(
      untrusted,
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      'boot-old'
    )).toThrow('untrusted renderer')
    expect(restartServer).not.toHaveBeenCalled()
  })
})

describe('emergency contact IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('forwards only the exact session and alert identifiers through trusted IPC', async () => {
    const acknowledged = { id: 'chat /?', title: 'Emergency chat', backend: 'codex' }
    const acknowledgeEmergency = vi.fn().mockResolvedValue(acknowledged)
    const service = new Proxy({ acknowledgeEmergency }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const alertId = `emergency_${'a'.repeat(32)}`

    await expect(harness.handlers.get('sessions:emergency:acknowledge')?.(
      trustedEvent,
      'chat /?',
      alertId
    )).resolves.toBe(acknowledged)

    expect(acknowledgeEmergency).toHaveBeenCalledOnce()
    expect(acknowledgeEmergency).toHaveBeenCalledWith('chat /?', alertId)
  })
})

describe('bounded exchange IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('routes authenticated renderer detail and cancel calls to the scoped service', async () => {
    const crossChatExchange = vi.fn().mockResolvedValue({ id: 'exchange-1', status: 'active' })
    const cancelCrossChatExchange = vi.fn().mockResolvedValue({ id: 'exchange-1', status: 'cancelled' })
    const service = new Proxy({ crossChatExchange, cancelCrossChatExchange }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService

    registerIpc(service, {} as AppUpdateManager)

    await expect(harness.handlers.get('exchanges:get')?.(trustedEvent, 'exchange-1')).resolves.toEqual({
      id: 'exchange-1', status: 'active'
    })
    await expect(harness.handlers.get('exchanges:cancel')?.(trustedEvent, 'exchange-1')).resolves.toEqual({
      id: 'exchange-1', status: 'cancelled'
    })
    expect(crossChatExchange).toHaveBeenCalledWith('exchange-1')
    expect(cancelCrossChatExchange).toHaveBeenCalledWith('exchange-1')
  })

  it('rejects an untrusted renderer before invoking exchange service methods', () => {
    const crossChatExchange = vi.fn()
    const service = new Proxy({ crossChatExchange }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)

    const untrusted = {
      sender: { id: 2, getURL: () => 'https://attacker.invalid/' },
      senderFrame: { url: 'https://attacker.invalid/', parent: null }
    }
    expect(() => harness.handlers.get('exchanges:get')?.(untrusted, 'exchange-1')).toThrow('untrusted renderer')
    expect(crossChatExchange).not.toHaveBeenCalled()
  })
})

describe('turn capability IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('passes the exact additive v2 capability list to the scoped service', async () => {
    const sendTurn = vi.fn().mockResolvedValue({ session: { id: 'chat-1', title: 'Chat', backend: 'codex' } })
    const service = new Proxy({ sendTurn }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    const input: SendTurnInput = {
      sessionId: 'chat-1', prompt: 'Ask @Target', fileIds: [],
      clientCapabilities: ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'],
      chatReferences: [{
        session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
        action: 'request_reply'
      }]
    }
    registerIpc(service, {} as AppUpdateManager)

    await harness.handlers.get('turns:send')?.(trustedEvent, input)

    expect(sendTurn).toHaveBeenCalledWith(input)
  })

  it('passes the exact async message revision through queued edit IPC', async () => {
    const updateQueued = vi.fn().mockResolvedValue(true)
    const service = new Proxy({ updateQueued }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    await harness.handlers.get('queue:update')?.(
      trustedEvent, 'chat-1', 'queued-agent', 'Revised body', undefined, undefined, undefined, 0
    )
    expect(updateQueued).toHaveBeenCalledWith('chat-1', 'queued-agent', 'Revised body', undefined, undefined, undefined, 0)
  })

  it('passes refreshed capabilities through a queued-turn edit unchanged', async () => {
    const updateQueued = vi.fn().mockResolvedValue(true)
    const service = new Proxy({ updateQueued }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    const reference = {
      session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'request_reply' as const
    }
    const capabilities = ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2']
    registerIpc(service, {} as AppUpdateManager)

    await harness.handlers.get('queue:update')?.(
      trustedEvent, 'chat-1', 'queued-1', 'Ask @Target', [reference], capabilities
    )

    expect(updateQueued).toHaveBeenCalledWith('chat-1', 'queued-1', 'Ask @Target', [reference], capabilities, undefined)
  })
})

describe('persistent agent handoff route IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('routes list, search, create, update, and remove through the scoped service', async () => {
    const methods = {
      agentHandoffRoutes: vi.fn().mockResolvedValue({ routes: [], max_routes: 16 }),
      searchAgentHandoffTargets: vi.fn().mockResolvedValue({ chats: [] }),
      createAgentHandoffRoute: vi.fn().mockResolvedValue({ route_id: 'route-1' }),
      updateAgentHandoffRoute: vi.fn().mockResolvedValue({ route_id: 'route-1' }),
      deleteAgentHandoffRoute: vi.fn().mockResolvedValue({ ok: true, deleted: true, route_id: 'route-1' })
    }
    const service = new Proxy(methods, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await harness.handlers.get('agent-routes:list')?.(trustedEvent, scope, 'source')
    await harness.handlers.get('agent-routes:search')?.(trustedEvent, scope, 'mobile', 'source', 12)
    await harness.handlers.get('agent-routes:create')?.(trustedEvent, scope, 'source', { alias: 'mobile', target_session_id: 'target' })
    const update = { expected_revision: `rev_${'a'.repeat(32)}`, actions: ['request_reply'] as const }
    await harness.handlers.get('agent-routes:update')?.(trustedEvent, scope, 'source', 'route-1', update)
    const deleteRevision = `rev_${'b'.repeat(32)}`
    await harness.handlers.get('agent-routes:remove')?.(trustedEvent, scope, 'source', 'route-1', deleteRevision)

    expect(methods.agentHandoffRoutes).toHaveBeenCalledWith(scope, 'source')
    expect(methods.searchAgentHandoffTargets).toHaveBeenCalledWith(scope, 'mobile', 'source', 12)
    expect(methods.createAgentHandoffRoute).toHaveBeenCalledWith(scope, 'source', { alias: 'mobile', target_session_id: 'target' })
    expect(methods.updateAgentHandoffRoute).toHaveBeenCalledWith(scope, 'source', 'route-1', update)
    expect(methods.deleteAgentHandoffRoute).toHaveBeenCalledWith(scope, 'source', 'route-1', deleteRevision)
  })
})

describe('Claude MCP IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('routes status and generation-fenced controls through the scoped service', async () => {
    const claudeMcp = vi.fn().mockResolvedValue({ version: 1, available: true, servers: [] })
    const controlClaudeMcp = vi.fn().mockResolvedValue({ version: 1, available: true, servers: [] })
    const service = new Proxy({ claudeMcp, controlClaudeMcp }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const input = {
      version: 1 as const,
      action: 'reconnect' as const,
      server_name: 'dayone-cli',
      expected_generation: 'owner-a:sdk-7'
    }

    await harness.handlers.get('claude:mcp')?.(trustedEvent, 'claude-chat')
    await harness.handlers.get('claude:mcp:control')?.(trustedEvent, 'claude-chat', input)

    expect(claudeMcp).toHaveBeenCalledWith('claude-chat')
    expect(controlClaudeMcp).toHaveBeenCalledWith('claude-chat', input)
  })
})

describe('native file IPC registration', () => {
  beforeEach(() => harness.handlers.clear())

  it('binds chooser, staging, and upload calls to the trusted renderer identity', async () => {
    const methods = {
      chooseFiles: vi.fn().mockResolvedValue([]),
      stageNativeFile: vi.fn().mockResolvedValue({ path: '/tmp/native.txt', name: 'native.txt', size: 1 }),
      stageClipboardImage: vi.fn().mockReturnValue({ path: '/tmp/image.png', name: 'image.png', size: 1 }),
      uploadFiles: vi.fn().mockResolvedValue([])
    }
    const service = new Proxy(methods, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn()
    }) as unknown as AppService
    registerIpc(service, {} as AppUpdateManager)
    const bytes = new ArrayBuffer(1)

    await harness.handlers.get('files:choose')?.(trustedEvent)
    await harness.handlers.get('files:stage-native')?.(trustedEvent, '/tmp/native.txt')
    await harness.handlers.get('files:stage-clipboard')?.(trustedEvent, bytes, 'image.png', 'image/png')
    await harness.handlers.get('files:upload')?.(trustedEvent, 'chat-a', ['/tmp/image.png'])

    expect(methods.chooseFiles).toHaveBeenCalledWith(1)
    expect(methods.stageNativeFile).toHaveBeenCalledWith(1, '/tmp/native.txt')
    expect(methods.stageClipboardImage).toHaveBeenCalledWith(1, bytes, 'image.png', 'image/png')
    expect(methods.uploadFiles).toHaveBeenCalledWith(1, 'chat-a', ['/tmp/image.png'])
  })
})
