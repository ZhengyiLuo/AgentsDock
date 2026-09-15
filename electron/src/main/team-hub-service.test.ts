import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamHubDiscovery, TeamHubScope, TeamHubServerScope, TeamHubStatus } from '../shared/team-hub'
import type { SecurePeerControlStatus } from '../shared/secure-peer'
import type { TeamHubAuthBundle, TeamHubSessionResponse } from './team-hub-client'
import { TeamHubClient, TeamHubClientError, TeamHubTransportError } from './team-hub-client'
import { TeamAttachmentCache } from './team-attachment-cache'
import { TeamHubService } from './team-hub-service'
import { ServerError } from './server-client'
import {
  TeamHubSettingsStore,
  type TeamHubKeychain,
  type TeamHubSafeStorage,
  type TeamHubVerifiedBinding
} from './team-hub-settings'

const settingsDirectories: string[] = []
const ED25519_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH'
const ED25519_PUBLIC_KEY_FINGERPRINT = '80d488456fb62328aebec769fdb823cb7f1bbd61f0eb0426dedba85eb9775a34'

class MemoryTeamHubKeychain implements TeamHubKeychain {
  private readonly values = new Map<string, string>()

  read(account: string) { return this.values.get(account) ?? '' }
  write(account: string, value: string) { this.values.set(account, value); return true }
  delete(account: string) { this.values.delete(account) }
}

const memoryTeamHubSafeStorage: TeamHubSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => value.toString().replace(/^encrypted:/, '')
}

function settingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-team-hub-service-'))
  settingsDirectories.push(directory)
  return join(directory, 'settings.json')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
}

function authBundle(refreshToken = 'refresh-new'): TeamHubAuthBundle {
  return {
    access_token: 'access-new', token_type: 'Bearer', access_expires_at: '2026-08-20T13:00:00.000Z',
    refresh_token: refreshToken, refresh_expires_at: '2026-09-20T12:00:00.000Z',
    session: { id: 'session-1', device_label: 'Desktop', expires_at: '2026-09-20T12:00:00.000Z' },
    principal: { id: 'principal-1', email: 'owner@example.test', display_name: 'Owner' },
    teams: [{ id: 'team-1', kind: 'personal', slug: 'owner', display_name: 'Owner', role: 'owner', status: 'active' }]
  }
}

function serverSessionSnapshot(): TeamHubSessionResponse {
  return {
    session: { id: 'managed_server_session_team-1', device_label: 'AgentsServer', expires_at: '2027-01-01T00:00:00.000Z' },
    principal: { id: 'service_managed_server', kind: 'service', email: null, display_name: 'Local server' },
    teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
  }
}

function teamNetworkCapability() {
  return {
    available: true as const,
    version: 1 as const,
    logical_servers: true as const,
    agent_registry: true as const,
    bulletin: true as const,
    mailbox: true as const,
    delivery_receipts: ['delivered', 'read'] as ['delivered', 'read'],
    passive_requests: true as const,
    server_invites: false as const,
    skill_attachments: false as const,
    dispatch: false as const,
    max_agents_per_server: 256 as const,
    max_page_items: 100,
    max_body_bytes: 8_192
  }
}

function teamMessagesCapability() {
  return {
    available: true as const,
    version: 1 as const,
    kinds: ['message', 'skill'] as ['message', 'skill'],
    recipient_kinds: ['server', 'human', 'all'] as ['server', 'human', 'all'],
    max_body_bytes: 49_152,
    max_recipients_per_message: 16,
    max_page_items: 100,
    attachments: {
      max_bytes_per_file: 512 * 1024 * 1024,
      max_files_per_message: 16,
      max_bytes_per_message: 2 * 1024 * 1024 * 1024,
      chunk_bytes: 8 * 1024 * 1024,
      range_downloads: true as const,
      team_quota_bytes: 50 * 1024 * 1024 * 1024
    },
    skills: {
      slug_pattern: '^[a-z0-9][a-z0-9-]{0,63}$' as const,
      max_per_team: 500,
      max_versions_per_skill: 200,
      max_tags: 8
    }
  }
}

function securePeerControl(activeConnectionId: string | null): SecurePeerControlStatus {
  return {
    version: 2,
    heartbeatIntervalSeconds: 30,
    leaseSeconds: 90,
    profileId: 'server-profile-1',
    profileGeneration: 1,
    serverIdentity: 'server-stable-1',
    serverInstanceId: 'server-instance-1',
    activeConnectionId,
    remoteRouteDeliveryAvailable: false,
    connectionError: null,
    host: {
      available: true,
      enabled: false,
      listenPort: 7851,
      advertisedHost: null,
      advertisedHosts: [],
      caFingerprint: null,
      pairingLink: null,
      certificateExpiresAt: null,
      error: null,
      errorCode: null,
      action: null
    },
    pairings: activeConnectionId ? [{
      id: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      direction: 'outgoing',
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      peerServerIdentity: 'server-host',
      peerDisplayName: 'Remote server',
      remoteEndpoint: '100.64.0.1:7851',
      hostServerIdentity: 'server-host',
      hostCaFingerprint: `sha256:${'a'.repeat(64)}`,
      peerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`,
      transcriptHash: 'c'.repeat(64),
      sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
      requestedScopes: ['teamspace.read', 'teamspace.write'],
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      teamId: 'team-1',
      teamDisplayName: 'Studio',
      hubIdentity: 'hub-remote',
      connectionId: activeConnectionId,
      localProxyBasePath: `/api/team-hub-secure/${activeConnectionId}`,
      certificateExpiresAt: '2027-01-01T00:00:00Z',
      certificateFingerprint: `sha256:${'d'.repeat(64)}`,
      lastSeenAt: '2026-08-20T12:00:00Z',
      expiresAt: null,
      error: null
    }] : [],
    remoteRoutes: [],
    publishedRoutes: []
  }
}

function scopeFrom(status: TeamHubStatus): TeamHubScope {
  if (!status.serverIdentity) throw new Error('missing server identity')
  return {
    profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity,
    generation: status.generation, hubIdentity: status.hubIdentity,
    ...(status.connectionId ? { connectionId: status.connectionId } : {}),
    ...(status.hostServerIdentity ? { hostServerIdentity: status.hostServerIdentity } : {})
  }
}

function backgroundReconnectFrom(status: TeamHubStatus) {
  if (!status.serverIdentity) throw new Error('missing server identity')
  return {
    backgroundReconnect: {
      profileId: status.profileId,
      profileGeneration: status.profileGeneration,
      serverIdentity: status.serverIdentity,
      generation: status.generation
    }
  }
}

function surfaceReconnectFrom(status: TeamHubStatus) {
  if (!status.serverIdentity) throw new Error('missing server identity')
  return {
    surfaceReconnect: {
      profileId: status.profileId,
      profileGeneration: status.profileGeneration,
      serverIdentity: status.serverIdentity,
      generation: status.generation
    }
  }
}

function bindingMatches(left: TeamHubVerifiedBinding | undefined, right: TeamHubVerifiedBinding): boolean {
  return Boolean(left)
    && left!.profileId === right.profileId
    && left!.serverUrl === right.serverUrl
    && left!.serverIdentity === right.serverIdentity
    && left!.hubUrl === right.hubUrl
    && left!.hubIdentity === right.hubIdentity
}

function harness(
  overrides: Partial<TeamHubSettingsStore> = {},
  teamAttachmentCache?: TeamAttachmentCache
) {
  let serverScope: TeamHubServerScope = {
    profileId: 'server-profile-1', profileGeneration: 1, serverIdentity: 'server-stable-1',
    serverUrl: 'http://127.0.0.1:7850', serverName: 'Local server'
  }
  let discoveryResult: TeamHubDiscovery = {
    available: true, designatedHost: true, version: 1, basePath: '/api/team-hub', hubIdentity: 'hub-stable-1',
    transport: 'loopback', hubUrl: null,
    hostServerIdentity: 'server-stable-1', message: 'Team Hub is hosted by this server.', action: null
  }
  let currentDiscoveryOverride: TeamHubDiscovery | null | undefined
  const bindings = new Map<string, TeamHubVerifiedBinding>()
  const refreshTokens = new Map<string, string>()
  const rejectedRefreshFingerprints = new Map<string, string>()
  const authCacheEpochs = new Map<string, string>()
  const backgroundReconnectDisabled = new Set<string>()
  const settings = {
    publicSettings: vi.fn((profileId: string) => {
      const value = bindings.get(profileId)
      return value ? { ...value, hasRefreshCredential: Boolean(refreshTokens.get(profileId)) } : null
    }),
    activateVerifiedHub: vi.fn((next: TeamHubVerifiedBinding) => {
      const current = bindings.get(next.profileId)
      if (current && (
        current.profileId !== next.profileId
        || current.serverUrl !== next.serverUrl
        || current.serverIdentity !== next.serverIdentity
        || current.hubIdentity !== next.hubIdentity
      )) throw new Error('different Team Hub identity')
      bindings.set(next.profileId, { ...next })
      return settings.publicSettings(next.profileId)!
    }),
    activateServerVerifiedHub: vi.fn((next: TeamHubVerifiedBinding) => {
      bindings.set(next.profileId, { ...next })
      refreshTokens.delete(next.profileId)
      rejectedRefreshFingerprints.delete(next.profileId)
      authCacheEpochs.delete(next.profileId)
      return settings.publicSettings(next.profileId)!
    }),
    refreshToken: vi.fn((profileId: string) => refreshTokens.get(profileId) ?? ''),
    rejectedRefreshTokenFingerprint: vi.fn((profileId: string) => rejectedRefreshFingerprints.get(profileId) ?? null),
    authCacheEpoch: vi.fn((profileId: string) => authCacheEpochs.get(profileId) ?? null),
    markRefreshTokenUse: vi.fn((expected: TeamHubVerifiedBinding, fingerprint: string) => {
      if (!bindingMatches(bindings.get(expected.profileId), expected)) throw new Error('connection changed')
      rejectedRefreshFingerprints.set(expected.profileId, fingerprint)
    }),
    backgroundReconnectAllowed: vi.fn((profileId: string) => !backgroundReconnectDisabled.has(profileId)),
    setProfileBackgroundReconnectAllowed: vi.fn((profileId: string, allowed: boolean) => {
      if (allowed) backgroundReconnectDisabled.delete(profileId)
      else backgroundReconnectDisabled.add(profileId)
    }),
    setBackgroundReconnectAllowed: vi.fn((expected: TeamHubVerifiedBinding, allowed: boolean) => {
      if (!bindingMatches(bindings.get(expected.profileId), expected)) throw new Error('connection changed')
      if (allowed) backgroundReconnectDisabled.delete(expected.profileId)
      else backgroundReconnectDisabled.add(expected.profileId)
    }),
    storeRefreshToken: vi.fn((token: string, expected: TeamHubVerifiedBinding, authCacheEpoch?: string) => {
      if (!bindingMatches(bindings.get(expected.profileId), expected)) throw new Error('connection changed')
      refreshTokens.set(expected.profileId, token)
      rejectedRefreshFingerprints.delete(expected.profileId)
      if (authCacheEpoch !== undefined) authCacheEpochs.set(expected.profileId, authCacheEpoch)
    }),
    clearRefreshToken: vi.fn((expected: TeamHubVerifiedBinding) => {
      if (!bindingMatches(bindings.get(expected.profileId), expected)) throw new Error('connection changed')
      refreshTokens.delete(expected.profileId)
      rejectedRefreshFingerprints.delete(expected.profileId)
      authCacheEpochs.delete(expected.profileId)
    }),
    forgetBinding: vi.fn((profileId: string) => {
      refreshTokens.delete(profileId)
      rejectedRefreshFingerprints.delete(profileId)
      authCacheEpochs.delete(profileId)
      backgroundReconnectDisabled.delete(profileId)
      return bindings.delete(profileId)
    }),
    removeServerProfile: vi.fn((profileId: string) => {
      const removed = bindings.delete(profileId)
      refreshTokens.delete(profileId)
      rejectedRefreshFingerprints.delete(profileId)
      authCacheEpochs.delete(profileId)
      backgroundReconnectDisabled.delete(profileId)
      return { removed, rollback: vi.fn() }
    }),
    ...overrides
  } as unknown as TeamHubSettingsStore
  const discovery = {
    currentScope: vi.fn(() => ({ ...serverScope })),
    currentMailHintScope: vi.fn<() => import('../shared/team-mail-hints').MailHintScope | null>(() => null),
    currentDiscovery: vi.fn(() => {
      const value = currentDiscoveryOverride === undefined ? discoveryResult : currentDiscoveryOverride
      return value ? { ...value } : null
    }),
    discover: vi.fn(async () => ({ ...discoveryResult })),
    configureTeamHubServerRole: vi.fn(async () => ({ ...discoveryResult })),
    requestBootstrapProof: vi.fn(),
    securePeerStatus: vi.fn(async (expected: { profileId: string; profileGeneration: number; serverIdentity: string }) => ({
      ...securePeerControl(null),
      profileId: expected.profileId,
      profileGeneration: expected.profileGeneration,
      serverIdentity: expected.serverIdentity
    })),
    activateSecurePeerPairing: vi.fn(),
    requestSecurePeerPairing: vi.fn(),
    waitForSecurePeerPairingCompletion: vi.fn(),
    cancelSecurePeerPairing: vi.fn(),
    deactivateSecurePeerConnection: vi.fn(),
    forgetSecurePeerConnection: vi.fn(),
    secureTeamHubProxyFetch: vi.fn(() => fetch),
    serverTeamHubProxyFetch: vi.fn(() => fetch)
  }
  const client = {
    dispose: vi.fn(),
    health: vi.fn().mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false,
      capabilities: { team_network_v1: teamNetworkCapability() }
    }),
    refresh: vi.fn(), teams: vi.fn().mockResolvedValue({ teams: authBundle().teams }),
    team: vi.fn().mockResolvedValue({ team: authBundle().teams[0] }),
    members: vi.fn().mockResolvedValue({ members: [{
      principal_id: 'principal-1', email: 'owner@example.test', display_name: 'Owner', role: 'owner', status: 'active'
    }], has_more: false, next_cursor: null }),
    nodes: vi.fn().mockResolvedValue({ nodes: [] }), channels: vi.fn().mockResolvedValue({ channels: [] }),
    session: vi.fn(), serverSession: vi.fn(), deviceSessions: vi.fn(), revokeDeviceSession: vi.fn(),
    revoke: vi.fn().mockResolvedValue({ revoked: true }), bootstrap: vi.fn(),
    redeemInvitation: vi.fn(), acceptInvitation: vi.fn(), recoverDevice: vi.fn(), createInvitation: vi.fn(),
    invitations: vi.fn(), revokeInvitation: vi.fn(), updateMember: vi.fn(),
    createNodeEnrollment: vi.fn(), createChannel: vi.fn(), messages: vi.fn(), postMessage: vi.fn(),
    securePeers: vi.fn(), revokeSecurePeer: vi.fn(), network: vi.fn(), registerNetworkAgent: vi.fn(), renameNetworkServer: vi.fn(),
    networkBulletin: vi.fn(), postNetworkBulletin: vi.fn(), deleteNetworkBulletin: vi.fn(), networkDeletions: vi.fn(), networkMailbox: vi.fn(),
    sendNetworkMailbox: vi.fn(), networkItem: vi.fn(), recordNetworkDeliveryReceipt: vi.fn(),
    createNetworkPassiveRequest: vi.fn(), networkPassiveRequest: vi.fn(), replyNetworkPassiveRequest: vi.fn(),
    teamMessages: vi.fn(), teamMessage: vi.fn(), teamMessageThread: vi.fn(), createTeamMessage: vi.fn(), recordTeamMessageReceipt: vi.fn(), setTeamMessageMailboxState: vi.fn(), deleteTeamMessage: vi.fn(),
    declareTeamAttachment: vi.fn(), teamAttachment: vi.fn(), uploadTeamAttachmentChunk: vi.fn(),
    downloadTeamAttachmentChunk: vi.fn(), teamSkills: vi.fn(), teamSkill: vi.fn(), teamSkillVersions: vi.fn(),
    teamSkillVersion: vi.fn(), pinTeamSkill: vi.fn(), archiveTeamSkill: vi.fn()
  }
  const clientFactory = vi.fn((_url: string) => ({ ...client }) as unknown as TeamHubClient)
  const secretFiles = {
    nextSecret: 'proof-secret', nextPath: '/private/secret.txt' as string | null,
    readBootstrapProof: vi.fn(async () => secretFiles.nextSecret),
    readSecret: vi.fn(async () => secretFiles.nextSecret), chooseSavePath: vi.fn(async () => secretFiles.nextPath),
    writeSecret: vi.fn((_path: string, _secret: string) => 'secret.txt')
  }
  const wait = vi.fn(async (_milliseconds: number) => undefined)
  let currentTime = Date.parse('2026-08-20T12:00:00.000Z')
  const service = new TeamHubService({
    settings, discovery, clientFactory, secretFiles,
    now: () => currentTime,
    wait,
    securePeerStartupRecoveryDelaysMs: [100, 250],
    teamAttachmentCache
  })
  return {
    service, settings, discovery, client, clientFactory, secretFiles, wait, bindings, refreshTokens,
    rejectedRefreshFingerprints, authCacheEpochs,
    backgroundReconnectDisabled,
    advanceTime: (milliseconds: number) => { currentTime += milliseconds },
    setRefreshToken: (token: string, profileId = serverScope.profileId) => refreshTokens.set(profileId, token),
    setServerScope: (value: TeamHubServerScope) => { serverScope = { ...value } },
    setDiscovery: (value: Partial<TeamHubDiscovery>) => { discoveryResult = { ...discoveryResult, ...value } },
    setCurrentDiscovery: (value: TeamHubDiscovery | null | undefined) => { currentDiscoveryOverride = value }
  }
}

async function connectWithTeamMessages(test: ReturnType<typeof harness>): Promise<TeamHubScope> {
  test.setRefreshToken('refresh-old')
  test.client.health.mockResolvedValue({
    ok: true,
    service: 'agentsdock-team-hub',
    api_version: 1,
    hub_id: 'hub-stable-1',
    instance_id: 'instance-1',
    bootstrapped: true,
    bootstrap_required: false,
    capabilities: {
      team_network_v1: teamNetworkCapability(),
      team_messages_v1: teamMessagesCapability()
    }
  })
  test.client.refresh.mockResolvedValue(authBundle())
  return scopeFrom(await test.service.connect())
}

const TRANSIENT_CONNECTION_ID = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'

describe('Team Mail thread service capability', () => {
  it('rejects old hosts before any thread request and fences exact connected-team responses', async () => {
    const test = harness()
    const input = { teamId: 'team-1', messageId: 'mail-1' }
    const oldScope = await connectWithTeamMessages(test)
    await expect(test.service.teamMessageThread(oldScope, input)).rejects.toThrow('does not support mail threads')
    expect(test.client.teamMessageThread).not.toHaveBeenCalled()
    test.service.stop()
    const capability = { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 }
    test.client.health.mockResolvedValue({ ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1', bootstrapped: true, bootstrap_required: false,
      capabilities: { team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability(),
        team_mail_threads_v1: capability } })
    const scope = scopeFrom(await test.service.connect())
    expect(test.service.teamMessagesCapabilities(scope).mail_threads).toEqual(capability)
    const page = { team_id: 'team-1', anchor_message_id: 'mail-1', root_message_id: 'mail-1', messages: [],
      next_after_sequence: 0, has_more: false, truncated: false }
    test.client.teamMessageThread.mockResolvedValue(page)
    await expect(test.service.teamMessageThread(scope, input)).resolves.toEqual(page)
    expect(test.client.teamMessageThread).toHaveBeenLastCalledWith(expect.any(String), { ...input, afterSequence: 0, limit: 25 })
    for (const invalid of [{ team_id: 'foreign-team' }, { anchor_message_id: 'foreign-mail' },
      { messages: [{ team_id: 'foreign-team' }] }]) {
      test.client.teamMessageThread.mockResolvedValue({ ...page, ...invalid })
      await expect(test.service.teamMessageThread(scope, input)).rejects.toThrow('mismatched mail thread')
    }
    test.client.teamMessageThread.mockClear()
    await expect(test.service.teamMessageThread(scope, { ...input, teamId: 'foreign-team' })).rejects.toThrow()
    expect(test.client.teamMessageThread).not.toHaveBeenCalled()
    test.service.stop()
  })
})

describe('Team Mail fresh coverage authority', () => {
  const anchor = `tmsg_${'a'.repeat(32)}`
  const coverage = { version: 1 as const, team_id: 'team-1', recipient_server_id: 'node-1', through_sequence: 8, arrival_id: anchor }
  const hintScope = { profileId: 'server-profile-1', profileGeneration: 1, serverIdentity: 'server-stable-1',
    hubId: 'hub-stable-1', teamId: 'team-1', recipientServerId: 'node-1', streamId: 'a'.repeat(32) }
  const query = { teamId: 'team-1', box: 'inbox' as const, addressKind: 'server' as const,
    addressId: 'node-1', includeMailboxCoverage: true, afterSequence: 3, afterArrivalId: `tmsg_${'b'.repeat(32)}` }
  it('adds coverage only for current exact mailbox while keeping ordinary manual Inbox loads available', async () => {
    const test = harness()
    const scope = await connectWithTeamMessages(test)
    test.client.teamMessages.mockResolvedValue({ box: 'inbox', address: { kind: 'server', id: 'node-1' },
      messages: [], next_after_sequence: 3, has_more: false, mailbox_coverage: coverage })
    expect((await test.service.teamMessages(scope, query)).mailbox_coverage).toBeUndefined()
    expect(test.client.teamMessages.mock.calls.at(-1)?.[2]).not.toHaveProperty('includeMailboxCoverage')
    expect(test.client.teamMessages.mock.calls.at(-1)?.[2]).not.toHaveProperty('afterArrivalId')
    test.discovery.currentMailHintScope.mockReturnValue(hintScope)
    expect((await test.service.teamMessages(scope, query)).mailbox_coverage).toEqual(coverage)
    expect(test.client.teamMessages).toHaveBeenCalledWith('access-new', 'team-1', expect.objectContaining({
      includeMailboxCoverage: true, afterSequence: 3, afterArrivalId: query.afterArrivalId
    }))
    for (const changed of [{ hubId: 'foreign' }, { recipientServerId: 'foreign' }, { teamId: 'foreign' },
      { serverIdentity: 'foreign' }, { profileGeneration: 2 }]) {
      test.discovery.currentMailHintScope.mockReturnValue({ ...hintScope, ...changed })
      expect((await test.service.teamMessages(scope, query)).mailbox_coverage).toBeUndefined()
      expect(test.client.teamMessages.mock.calls.at(-1)?.[2]).not.toHaveProperty('includeMailboxCoverage')
    }
    expect(test.client.teamMessages).toHaveBeenCalledTimes(7)
  })
  it('strips stale or unproven coverage without a fallback query or receipt write', async () => {
    const test = harness()
    const scope = await connectWithTeamMessages(test)
    test.discovery.currentMailHintScope.mockReturnValue(hintScope)
    const pending = deferred<unknown>()
    test.client.teamMessages.mockReturnValue(pending.promise)
    const request = test.service.teamMessages(scope, query)
    await vi.waitFor(() => expect(test.client.teamMessages).toHaveBeenCalledOnce())
    test.discovery.currentMailHintScope.mockReturnValue(null)
    pending.resolve({ box: 'inbox', address: { kind: 'server', id: 'node-1' }, messages: [], next_after_sequence: 3, has_more: false, mailbox_coverage: coverage })
    expect((await request).mailbox_coverage).toBeUndefined()
    test.discovery.currentMailHintScope.mockReturnValue(hintScope)
    test.client.teamMessages.mockResolvedValue({ box: 'inbox', address: { kind: 'server', id: 'node-1' }, messages: [], next_after_sequence: 3, has_more: false })
    expect((await test.service.teamMessages(scope, query)).mailbox_coverage).toBeUndefined()
    expect(test.client.teamMessages).toHaveBeenCalledTimes(2)
    expect(test.client.recordTeamMessageReceipt).not.toHaveBeenCalled()
    expect(test.client.setTeamMessageMailboxState).not.toHaveBeenCalled()
  })
})

describe('pending-only secure pairing completion observer', () => {
  const scope = { profileId: 'server-profile-1', profileGeneration: 1, serverIdentity: 'server-stable-1' }
  const input = { pairingId: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434', expectedTranscriptHash: 'c'.repeat(64), requestId: 'observer-1' }

  it('returns one observation without activation, token writes or reconnect work', async () => {
    const test = harness()
    test.discovery.waitForSecurePeerPairingCompletion.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    await expect(test.service.waitForSecurePeerPairingCompletion(scope, input)).resolves.toMatchObject({ activeConnectionId: TRANSIENT_CONNECTION_ID })
    expect(test.discovery.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(test.discovery.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.discovery.discover).not.toHaveBeenCalled()
    expect(test.settings.storeRefreshToken).not.toHaveBeenCalled()
  })

  it('cancels only its observer; stale cleanup cannot cancel the replacement', async () => {
    const test = harness()
    const first = deferred<SecurePeerControlStatus>()
    const second = deferred<SecurePeerControlStatus>()
    test.discovery.waitForSecurePeerPairingCompletion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const one = test.service.waitForSecurePeerPairingCompletion(scope, input)
    const firstRejected = expect(one).rejects.toThrow()
    const firstSignal = test.discovery.waitForSecurePeerPairingCompletion.mock.calls[0][2] as AbortSignal
    const two = test.service.waitForSecurePeerPairingCompletion(scope, { ...input, requestId: 'observer-2' })
    const secondSignal = test.discovery.waitForSecurePeerPairingCompletion.mock.calls[1][2] as AbortSignal
    expect(firstSignal.aborted).toBe(true)
    await test.service.stopSecurePeerPairingCompletionWait(scope, input.requestId)
    expect(secondSignal.aborted).toBe(false)
    first.resolve(securePeerControl(TRANSIENT_CONNECTION_ID))
    second.resolve(securePeerControl(TRANSIENT_CONNECTION_ID))
    await firstRejected
    await two
    expect(test.discovery.cancelSecurePeerPairing).not.toHaveBeenCalled()
  })

  it.each(['close', 'profile', 'stop', 'cancel'] as const)('ignores late completion after %s', async action => {
    const test = harness()
    const pending = deferred<SecurePeerControlStatus>()
    test.discovery.waitForSecurePeerPairingCompletion.mockReturnValue(pending.promise)
    test.discovery.cancelSecurePeerPairing.mockResolvedValue(securePeerControl(null))
    const result = test.service.waitForSecurePeerPairingCompletion(scope, input)
    const rejected = expect(result).rejects.toThrow()
    const signal = test.discovery.waitForSecurePeerPairingCompletion.mock.calls[0][2] as AbortSignal
    if (action === 'close') await test.service.stopSecurePeerPairingCompletionWait(scope, input.requestId)
    if (action === 'profile') {
      test.setServerScope({ profileId: 'other', profileGeneration: 2, serverIdentity: 'other', serverUrl: 'http://127.0.0.1:9999', serverName: 'Other' })
      test.service.status()
    }
    if (action === 'stop') test.service.stop()
    if (action === 'cancel') await test.service.cancelSecurePeerPairing(scope, input.pairingId)
    expect(signal.aborted).toBe(true)
    pending.resolve(securePeerControl(TRANSIENT_CONNECTION_ID))
    await rejected
    expect(test.discovery.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('requires explicit local replacement consent and strips it while keeping saved credentials', async () => {
    const test = harness()
    await connectWithTeamMessages(test)
    test.setRefreshToken('saved-local-token')
    const saved = test.bindings.get(scope.profileId)
    const pairing = { ...securePeerControl(TRANSIENT_CONNECTION_ID).pairings[0], completeOnApproval: true }
    test.discovery.requestSecurePeerPairing.mockResolvedValue(pairing)
    const join = { host: '100.64.0.1', displayName: 'Guest', requestedScopes: ['teamspace.read'] as ['teamspace.read'], completeOnApproval: true as const }
    await expect(test.service.requestSecurePeerPairing(scope, join)).rejects.toThrow(/Confirm switching/)
    await test.service.requestSecurePeerPairing(scope, { ...join, confirmLocalBindingReplacement: true })
    expect(test.discovery.requestSecurePeerPairing).toHaveBeenCalledWith(scope, join)
    expect(test.bindings.get(scope.profileId)).toEqual(saved)
    expect(test.refreshTokens.get(scope.profileId)).toBe('saved-local-token')
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('adopts an already-active approved peer from an authenticated local runtime without another activation', async () => {
    const test = harness()
    await connectTransientPeer(test)
    expect(test.discovery.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.refreshTokens.get(scope.profileId)).toBe('local-refresh-rotated')
    expect(test.bindings.get(scope.profileId)?.hubIdentity).toBe('hub-stable-1')
  })
})

async function connectTransientPeer(test: ReturnType<typeof harness>, principalKind: 'node' | 'service' = 'node') {
  const profileScope = {
    profileId: 'server-profile-1',
    profileGeneration: 1,
    serverIdentity: 'server-stable-1'
  }
  const peerBehavior: {
    healthError: 'transport' | 'peer_revoked' | 'peer_authentication_required' | 'retryable_unavailable' | null
    peerSessionError: 'transport' | 'peer_revoked' | 'peer_authentication_required' | 'retryable_unavailable' | null
    healthHubIdentity: string
    peerSessionPrincipalKind: 'node' | 'service' | 'human'
    dataError: 'retryable_unavailable' | 'authentication_required' | null
  } = {
    healthError: null,
    peerSessionError: null,
    healthHubIdentity: 'hub-remote',
    peerSessionPrincipalKind: principalKind,
    dataError: null
  }
  const peerHeaders: Headers[] = []

  test.setRefreshToken('local-refresh')
  test.client.refresh.mockResolvedValue(authBundle('local-refresh-rotated'))
  await expect(test.service.connect()).resolves.toMatchObject({
    authenticated: true,
    authenticationMode: 'human',
    transport: 'loopback',
    hubIdentity: 'hub-stable-1'
  })
  const savedLocalBinding = { ...test.bindings.get('server-profile-1')! }
  test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
  const secureFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    const headers = input instanceof Request ? input.headers : new Headers(init.headers)
    peerHeaders.push(new Headers(headers))
    expect(headers.get('Authorization')).toBeNull()
    const peerError = path.endsWith('/v1/health')
      ? peerBehavior.healthError
      : path.endsWith('/v1/peer-session')
        ? peerBehavior.peerSessionError
        : peerBehavior.dataError
    if (peerError === 'transport') {
      throw new TypeError('connection reset')
    }
    if (peerError) {
      return new Response(JSON.stringify({
        error: {
          code: peerError,
          message: peerError === 'peer_revoked'
            ? 'Peer authentication is unavailable'
            : 'Peer authentication is required'
        }
      }), {
        status: peerError === 'retryable_unavailable' ? 503 : 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const payload = path.endsWith('/v1/health') ? {
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: peerBehavior.healthHubIdentity,
      instance_id: 'hub-instance',
      bootstrapped: true,
      bootstrap_required: false,
      peer_session_available: true,
      capabilities: { team_network_v1: teamNetworkCapability() }
    } : {
      session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
      principal: {
        id: peerBehavior.peerSessionPrincipalKind === 'service' ? 'service_secure_peer_fixture' : 'peer-node',
        kind: peerBehavior.peerSessionPrincipalKind,
        display_name: 'Client node',
        email: null
      },
      teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)
  const paired = await test.service.connect()
  expect(paired).toMatchObject({
    authenticated: true,
    authenticationMode: 'paired_node',
    transport: 'secure_peer',
    connectionId: TRANSIENT_CONNECTION_ID,
    hubIdentity: 'hub-remote'
  })
  return { profileScope, peerBehavior, peerHeaders, secureFetch, savedLocalBinding }
}

async function connectDurablePeer(test: ReturnType<typeof harness>) {
  const connectionId = TRANSIENT_CONNECTION_ID
  const basePath = `/api/team-hub-secure/${connectionId}`
  const profileScope = {
    profileId: 'server-profile-1',
    profileGeneration: 1,
    serverIdentity: 'server-stable-1'
  }
  test.bindings.set(profileScope.profileId, {
    profileId: profileScope.profileId,
    serverUrl: 'http://127.0.0.1:7850',
    serverIdentity: profileScope.serverIdentity,
    hubUrl: `http://127.0.0.1:7850${basePath}`,
    hubIdentity: 'hub-remote',
    connectionId,
    hostServerIdentity: 'server-host'
  })
  test.setDiscovery({
    designatedHost: false,
    transport: 'secure_peer',
    basePath,
    hubUrl: null,
    hubIdentity: 'hub-remote',
    hostServerIdentity: 'server-host',
    connectionId,
    routes: [{
      transport: 'secure_peer', hubUrl: null, basePath, connectionId,
      hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
    }]
  })
  test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(connectionId))
  const secureFetch = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    const payload = path.endsWith('/v1/health') ? {
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-remote',
      instance_id: 'hub-instance', bootstrapped: true, bootstrap_required: false,
      peer_session_available: true
    } : {
      session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
      principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
      teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', secureFetch)
  test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)
  const connected = await test.service.connect()
  expect(connected).toMatchObject({
    authenticated: true,
    transport: 'secure_peer',
    connectionId,
    hubIdentity: 'hub-remote',
    error: null
  })
  return { profileScope, connectionId }
}

describe('TeamHubService member self rename', () => {
  async function member(principalKind: 'node' | 'service' = 'service') {
    const test = harness()
    const peer = await connectTransientPeer(test, principalKind)
    const scope = scopeFrom(test.service.status())
    const server = { id: 'peer-node', server_identity: scope.serverIdentity, display_name: 'Member',
      status: 'active', is_host: false, owned_by_caller: true }
    const state = {
      server,
      receipt: { id: server.id, server_identity: server.server_identity, display_name: 'New name' },
      errorStatus: 0,
      errorCode: 'forbidden',
      beforeRead: null as null | (() => void | Promise<void>),
      beforeReceipt: null as null | (() => void | Promise<void>),
      reads: 0,
      writes: [] as Array<{ url: string; body: unknown; headers: Headers }>
    }
    const existingFetch = peer.secureFetch.getMockImplementation()!
    peer.secureFetch.mockImplementation(async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input)
      const path = new URL(url).pathname
      const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
      })
      if (path.endsWith('/network')) {
        state.reads += 1
        await state.beforeRead?.()
        return jsonResponse({ network: { id: 'team-1', display_name: 'Team', hub_id: 'hub-remote' },
          servers: [state.server], agents: [], next_after_server_id: state.server.id, has_more: false })
      }
      if (path.endsWith('/network/server-profile')) {
        state.writes.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) })
        await state.beforeReceipt?.()
        return state.errorStatus
          ? jsonResponse({ error: { code: state.errorCode, message: 'Member connection is read-only.' } }, state.errorStatus)
          : jsonResponse({ server: state.receipt })
      }
      return existingFetch(input, init)
    })
    const input = { teamId: 'team-1', serverId: server.id, displayName: 'New name' }
    return { test, peer, scope, state, input }
  }

  it('writes once over the exact member proxy and changes no local server identity or host role', async () => {
    const { test, scope, state, input } = await member()
    const before = test.service.status()
    expect(before.principal).toMatchObject({ id: 'service_secure_peer_fixture', kind: 'service' })
    expect(before.principal?.id).not.toBe(input.serverId)
    await expect(test.service.renameNetworkServer(scope, { ...input, displayName: '  New name  ' }))
      .resolves.toEqual(state.receipt)
    expect(state.reads).toBe(1)
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0].url).toContain(`/api/team-hub-secure/${TRANSIENT_CONNECTION_ID}/v1/teams/team-1/network/server-profile`)
    expect(state.writes[0].body).toEqual({ display_name: 'New name' })
    expect(state.writes[0].headers.get('Authorization')).toBeNull()
    expect(test.service.status()).toEqual(before)
    expect(test.discovery.configureTeamHubServerRole).not.toHaveBeenCalled()
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
  })

  it('retains compatibility with older node-shaped peer sessions', async () => {
    const { test, scope, state, input } = await member('node')
    expect(test.service.status().principal?.kind).toBe('node')
    await expect(test.service.renameNetworkServer(scope, input)).resolves.toEqual(state.receipt)
    expect(state.writes).toHaveLength(1)
  })

  it('rejects a different target, wrong ownership, host rows, and unavailable members before writing', async () => {
    for (const change of [{ id: 'another-node' }, { owned_by_caller: false }, { is_host: true },
      { status: 'offline' }, { server_identity: 'another-server' }]) {
      const { test, scope, state, input } = await member()
      Object.assign(state.server, change)
      await expect(test.service.renameNetworkServer(scope, input)).rejects.toThrow()
      expect(state.writes).toHaveLength(0)
    }
    const { test, scope, state, input } = await member()
    await expect(test.service.renameNetworkServer(scope, { ...input, serverId: 'foreign-node' })).rejects.toThrow()
    expect(state.writes).toHaveLength(0)
  })

  it('rejects malformed names, inactive teams, and stale caller scopes before roster or write I/O', async () => {
    const { test, scope, state, input } = await member()
    for (const displayName of ['', 'a\nb', '😀'.repeat(41)]) {
      await expect(test.service.renameNetworkServer(scope, { ...input, displayName })).rejects.toThrow()
    }
    await expect(test.service.renameNetworkServer(scope, { ...input, teamId: 'foreign-team' })).rejects.toThrow()
    for (const change of [{ profileGeneration: scope.profileGeneration + 1 }, { generation: scope.generation + 1 },
      { connectionId: 'foreign-connection' }, { hostServerIdentity: 'foreign-host' },
      { hubIdentity: 'foreign-hub' }, { serverIdentity: 'foreign-server' }]) {
      await expect(test.service.renameNetworkServer({ ...scope, ...change }, input)).rejects.toThrow()
    }
    expect(state.reads).toBe(0)
    expect(state.writes).toHaveLength(0)
  })

  it('keeps human and designated host sessions out of the member-only lane', async () => {
    const test = harness()
    const scope = await connectWithTeamMessages(test)
    await expect(test.service.renameNetworkServer(scope, {
      teamId: 'team-1', serverId: 'node-1', displayName: 'New name'
    })).rejects.toThrow('paired member')
    expect(test.client.network).not.toHaveBeenCalled()
    expect(test.client.renameNetworkServer).not.toHaveBeenCalled()
    expect(test.discovery.configureTeamHubServerRole).not.toHaveBeenCalled()
  })

  it('fences profile changes during ownership reads and late write receipts', async () => {
    for (const boundary of ['beforeRead', 'beforeReceipt'] as const) {
      const { test, scope, state, input } = await member()
      state[boundary] = () => test.setServerScope({ profileId: 'replacement-profile', profileGeneration: 2,
        serverIdentity: 'replacement-server', serverName: 'Replacement', serverUrl: 'http://127.0.0.1:7851' })
      await expect(test.service.renameNetworkServer(scope, input)).rejects.toThrow(/changed/)
      expect(state.writes).toHaveLength(boundary === 'beforeRead' ? 0 : 1)
      expect(test.discovery.configureTeamHubServerRole).not.toHaveBeenCalled()
    }
  })

  it('fences replacement connection identity observed during the roster lookup', async () => {
    const { test, scope, state, input } = await member()
    state.beforeRead = () => test.setDiscovery({ transport: 'secure_peer', designatedHost: false,
      connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      basePath: '/api/team-hub-secure/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      hostServerIdentity: 'different-host', hubIdentity: 'different-hub' })
    await expect(test.service.renameNetworkServer(scope, input)).rejects.toThrow(/changed/)
    expect(state.writes).toHaveLength(0)
  })

  it('rejects mismatched returned IDs, identities and names after one write', async () => {
    for (const change of [{ id: 'foreign-node' }, { server_identity: 'foreign-server' }, { display_name: 'Wrong name' }]) {
      const { test, scope, state, input } = await member()
      Object.assign(state.receipt, change)
      await expect(test.service.renameNetworkServer(scope, input)).rejects.toThrow('mismatched server rename')
      expect(state.writes).toHaveLength(1)
    }
  })

  it('surfaces read-only and legacy host errors without changing role or retrying the write', async () => {
    for (const [status, code, message] of [[403, 'forbidden', 'read-only'], [404, 'not_found', 'does not support'],
      [405, 'method_not_allowed', 'does not support'], [501, 'unsupported', 'does not support'],
      [403, 'route_forbidden', 'does not support'], [401, 'authentication_required', 'Retry the action once']] as const) {
      const { test, scope, state, input } = await member()
      state.errorStatus = status
      state.errorCode = code
      await expect(test.service.renameNetworkServer(scope, input)).rejects.toThrow(message)
      expect(state.writes).toHaveLength(1)
      expect(test.discovery.configureTeamHubServerRole).not.toHaveBeenCalled()
      expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  while (settingsDirectories.length) rmSync(settingsDirectories.pop()!, { recursive: true, force: true })
})

describe('TeamHubService embedded discovery', () => {
  it('enables host mode only for the exact selected server and reconnects to the resulting host', async () => {
    const test = harness()
    const profileScope = {
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }
    const enabledDiscovery: TeamHubDiscovery = {
      available: true,
      designatedHost: true,
      version: 1,
      basePath: '/api/team-hub',
      serverSessionBasePath: '/api/team-hub-server',
      transport: 'loopback',
      hubUrl: null,
      hubIdentity: 'hub-stable-1',
      hostServerIdentity: 'server-stable-1',
      message: 'Team Hub is hosted by this server.',
      action: null
    }
    test.setDiscovery({
      available: false,
      designatedHost: false,
      basePath: null,
      transport: null,
      hubUrl: null,
      hubIdentity: null,
      hostServerIdentity: null,
      message: 'This server is not a Team Network host.',
      action: 'Make this server the host.'
    })
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: false,
      bootstrap_required: true,
      server_session_available: false
    })
    test.discovery.configureTeamHubServerRole.mockImplementation(async () => {
      test.setDiscovery(enabledDiscovery)
      return { ...enabledDiscovery }
    })

    await expect(test.service.configureServerRole(profileScope, { role: 'host', serverName: 'Studio' })).resolves.toMatchObject({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1',
      designatedHost: true,
      serverManaged: true,
      connectionState: 'needs-bootstrap'
    })
    expect(test.discovery.configureTeamHubServerRole).toHaveBeenCalledWith(profileScope, {
      role: 'host', serverName: 'Studio'
    })
    expect(test.discovery.discover).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }))
  })

  it('creates a fresh network with exact server authority and no human enrollment', async () => {
    const test = harness()
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true
    })
    const initial = await test.service.connect()
    expect(initial.connectionState).toBe('needs-bootstrap')
    test.discovery.configureTeamHubServerRole.mockImplementation(async () => {
      test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
      test.client.health.mockResolvedValue({
        ok: true, service: 'agentsdock-team-hub', api_version: 1,
        hub_id: 'hub-stable-1', instance_id: 'instance-1',
        bootstrapped: true, bootstrap_required: false, server_session_available: true
      })
      test.client.serverSession.mockResolvedValue(serverSessionSnapshot())
      return test.discovery.currentDiscovery()!
    })
    const profileScope = {
      profileId: initial.profileId!, profileGeneration: initial.profileGeneration!, serverIdentity: initial.serverIdentity!
    }
    const workspace = await test.service.bootstrap({ profileScope, teamName: 'Research' })
    expect(workspace.status.authenticationMode).toBe('server')
    expect(test.discovery.configureTeamHubServerRole).toHaveBeenCalledWith(profileScope, {
      role: 'host', serverName: initial.serverName, networkName: 'Research'
    })
    expect(test.discovery.requestBootstrapProof).not.toHaveBeenCalled()
    expect(test.client.bootstrap).not.toHaveBeenCalled()
  })

  it('rejects a stale role-change scope before invoking AgentsServer', async () => {
    const test = harness()

    await expect(test.service.configureServerRole({
      profileId: 'server-profile-1',
      profileGeneration: 2,
      serverIdentity: 'server-stable-1'
    }, { role: 'host', serverName: 'Studio' })).rejects.toMatchObject({ name: 'TeamHubScopeChangedError' })
    expect(test.discovery.configureTeamHubServerRole).not.toHaveBeenCalled()
    expect(test.discovery.discover).not.toHaveBeenCalled()
  })

  it('switches the exact selected server to the member role without requiring a restart', async () => {
    const test = harness()
    const profileScope = {
      profileId: 'server-profile-1', profileGeneration: 1, serverIdentity: 'server-stable-1'
    }
    const memberDiscovery: TeamHubDiscovery = {
      available: false, designatedHost: false, version: 1, basePath: null,
      transport: null, hubUrl: null, hubIdentity: null, hostServerIdentity: null,
      message: 'This server is a Team Network member.', action: 'Connect it to a host.'
    }
    test.discovery.configureTeamHubServerRole.mockImplementation(async () => {
      test.setDiscovery(memberDiscovery)
      return { ...memberDiscovery }
    })

    await expect(test.service.configureServerRole(profileScope, {
      role: 'member', serverName: 'Atlas'
    })).resolves.toMatchObject({
      profileId: 'server-profile-1', profileGeneration: 1,
      serverIdentity: 'server-stable-1', designatedHost: false
    })
    expect(test.discovery.configureTeamHubServerRole).toHaveBeenCalledWith(profileScope, {
      role: 'member', serverName: 'Atlas'
    })
  })

  it('fails closed if the selected server changes while a role change is in flight', async () => {
    const test = harness()
    test.discovery.configureTeamHubServerRole.mockImplementation(async () => {
      test.setServerScope({
        profileId: 'server-profile-2',
        profileGeneration: 1,
        serverIdentity: 'server-stable-2',
        serverUrl: 'http://127.0.0.1:8850',
        serverName: 'Other server'
      })
      return {
        available: true,
        designatedHost: true,
        version: 1,
        basePath: '/api/team-hub',
        transport: 'loopback',
        hubUrl: null,
        hubIdentity: 'hub-stable-1',
        hostServerIdentity: 'server-stable-1',
        message: 'Team Hub is hosted by this server.',
        action: null
      }
    })

    await expect(test.service.configureServerRole({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }, { role: 'host', serverName: 'Studio' })).rejects.toMatchObject({ name: 'TeamHubScopeChangedError' })
    expect(test.discovery.discover).not.toHaveBeenCalled()
  })

  it('does not reconnect when AgentsServer does not return this server as the designated host', async () => {
    const test = harness()
    test.discovery.configureTeamHubServerRole.mockResolvedValue({
      available: false,
      designatedHost: false,
      version: 1,
      basePath: null,
      transport: null,
      hubUrl: null,
      hubIdentity: null,
      hostServerIdentity: null,
      message: 'Host enablement did not complete.',
      action: 'Try again.'
    })

    await expect(test.service.configureServerRole({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }, { role: 'host', serverName: 'Studio' })).rejects.toThrow('did not enable this server as the Team Network host')
    expect(test.discovery.discover).not.toHaveBeenCalled()
  })

  it('adopts the AgentsServer-scoped session without device credentials and keeps Team Messages V2 enabled', async () => {
    const test = harness()
    test.setRefreshToken('obsolete-device-refresh')
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.serverSession.mockResolvedValue(serverSessionSnapshot())

    const connected = await test.service.connect()

    expect(connected).toMatchObject({
      authenticated: true,
      authenticationMode: 'server',
      serverManaged: true,
      hubUrl: 'http://127.0.0.1:7850/api/team-hub-server',
      principal: { id: 'service_managed_server', kind: 'service' }
    })
    expect(test.service.teamMessagesCapabilities(scopeFrom(connected))).toEqual(teamMessagesCapability())
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
  })

  it('persists and restores a first remote secure-peer binding with the real settings store', async () => {
    const test = harness()
    const path = settingsPath()
    const keychain = new MemoryTeamHubKeychain()
    const createSettings = () => new TeamHubSettingsStore({
      path,
      keychain,
      secureStorage: memoryTeamHubSafeStorage,
      isMacAppStoreBuild: () => false
    })
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    const serverUrl = 'http://100.64.0.3:7850/agents'
    test.setServerScope({
      profileId: 'studio-client', profileGeneration: 5, serverIdentity: 'server-client',
      serverUrl, serverName: 'Studio client'
    })
    test.setDiscovery({
      available: true,
      designatedHost: false,
      transport: 'secure_peer',
      basePath,
      hubUrl: null,
      hubIdentity: 'hub-remote',
      hostServerIdentity: 'server-host',
      connectionId,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId,
        hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
      }]
    })
    test.discovery.securePeerStatus.mockImplementation(async expected => ({
      ...securePeerControl(connectionId),
      profileId: expected.profileId,
      profileGeneration: expected.profileGeneration,
      serverIdentity: expected.serverIdentity
    }))
    const secureFetch = vi.fn(async (input: string | URL | Request) => {
      const requestPath = new URL(input instanceof Request ? input.url : input.toString()).pathname
      const payload = requestPath.endsWith('/v1/health') ? {
        ok: true,
        service: 'agentsdock-team-hub',
        api_version: 1,
        hub_id: 'hub-remote',
        instance_id: 'hub-instance',
        bootstrapped: true,
        bootstrap_required: false,
        peer_session_available: true
      } : {
        session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
        principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
        teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)
    const createService = (settings: TeamHubSettingsStore) => new TeamHubService({
      settings,
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })

    const firstSettings = createSettings()
    const firstService = createService(firstSettings)
    const firstStatus = await firstService.connect({ transport: 'secure_peer' })
    expect(firstStatus.error).toBeNull()
    expect(firstStatus).toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      hubUrl: `${serverUrl}${basePath}`,
      connectionId,
      hubIdentity: 'hub-remote'
    })
    expect(firstSettings.publicSettings('studio-client')).toEqual({
      profileId: 'studio-client',
      serverUrl,
      serverIdentity: 'server-client',
      hubUrl: `${serverUrl}${basePath}`,
      hubIdentity: 'hub-remote',
      connectionId,
      hostServerIdentity: 'server-host',
      hasRefreshCredential: false
    })
    firstService.stop()

    const reloadedSettings = createSettings()
    expect(reloadedSettings.publicSettings('studio-client')).toEqual(firstSettings.publicSettings('studio-client'))
    const reloadedService = createService(reloadedSettings)
    const coldStatus = reloadedService.status()
    expect(coldStatus).toMatchObject({
      connectionState: 'disconnected',
      canForgetBinding: false,
      backgroundReconnectAllowed: true
    })
    await expect(reloadedService.connect(backgroundReconnectFrom(coldStatus))).resolves.toMatchObject({
      authenticated: true,
      transport: 'secure_peer',
      hubUrl: `${serverUrl}${basePath}`,
      connectionId,
      backgroundReconnectAllowed: true,
      error: null
    })
    reloadedService.stop()
  })

  it('allows bounded cold-start reconnect for a saved local host binding', async () => {
    const test = harness()
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())

    const coldStatus = test.service.status()
    expect(coldStatus).toMatchObject({
      connectionState: 'disconnected',
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: true,
      backgroundReconnectAllowed: true
    })

    await expect(test.service.connect(backgroundReconnectFrom(coldStatus))).resolves.toMatchObject({
      authenticated: true,
      transport: 'loopback',
      backgroundReconnectAllowed: true
    })
  })

  it('fails closed without dispatching refresh when its write-ahead marker cannot be persisted', async () => {
    const markRefreshTokenUse = vi.fn(() => { throw new Error('settings disk unavailable') })
    const test = harness({ markRefreshTokenUse })
    test.setRefreshToken('refresh-r0')
    test.client.refresh.mockResolvedValue(authBundle('refresh-r1'))

    const attempts = await Promise.allSettled([test.service.connect(), test.service.connect()])

    expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true)
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.service.status()).toMatchObject({
      authenticated: false,
      connectionState: 'signed-out',
      principal: null,
      session: null,
      error: expect.stringMatching(/could not safely begin credential refresh/i)
    })
    await test.service.connect()
    expect(test.client.refresh).not.toHaveBeenCalled()
  })

  it('never replays a refresh token durably fenced before an ambiguous crash cut point', async () => {
    const test = harness()
    const storagePath = settingsPath()
    const keychain = new MemoryTeamHubKeychain()
    const verified: TeamHubVerifiedBinding = {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    }
    const seed = new TeamHubSettingsStore({
      path: storagePath, keychain, secureStorage: memoryTeamHubSafeStorage,
      isMacAppStoreBuild: () => false
    })
    seed.activateVerifiedHub(verified)
    seed.storeRefreshToken('refresh-r0', verified, '11111111-1111-4111-8111-111111111111')
    seed.markRefreshTokenUse(verified, 'c9d5861b8c24094c3ee2cf5b1226f0d884d8a3c37d6caeb4a4b085f2a2b65c9b')
    const service = new TeamHubService({
      settings: new TeamHubSettingsStore({
        path: storagePath, keychain, secureStorage: memoryTeamHubSafeStorage,
        isMacAppStoreBuild: () => false
      }),
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })

    await expect(service.connect()).resolves.toMatchObject({ authenticated: false })
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(service.status().error).toMatch(/already have been consumed|recovery state is inconsistent/i)
  })

  it('does not alias cached private bytes after logout commits and the process dies before purge', async () => {
    const test = harness()
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    const storagePath = settingsPath()
    const keychain = new MemoryTeamHubKeychain()
    const createSettings = () => new TeamHubSettingsStore({
      path: storagePath, keychain, secureStorage: memoryTeamHubSafeStorage,
      isMacAppStoreBuild: () => false
    })
    const cachedResponse = vi.fn(async () => new Response('private-a'))
    const cache = { response: cachedResponse, purgeProfile: vi.fn(async () => undefined) } as unknown as TeamAttachmentCache
    const createService = () => new TeamHubService({
      settings: createSettings(),
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      teamAttachmentCache: cache,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })
    const seed = createSettings()
    const verified: TeamHubVerifiedBinding = {
      profileId: 'server-profile-1', serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1', hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    }
    seed.activateVerifiedHub(verified)
    seed.storeRefreshToken('refresh-a', verified)
    test.client.refresh.mockResolvedValueOnce(authBundle('refresh-a1'))
    const first = createService()
    const firstStatus = await first.connect()
    const oldResource = {
      profileId: firstStatus.profileId,
      profileGeneration: firstStatus.profileGeneration,
      hubGeneration: firstStatus.generation,
      authCacheEpoch: (first as unknown as { authCacheEpoch: string }).authCacheEpoch,
      teamId: 'team-1',
      attachmentId: 'attachment-private-a'
    }

    // Exact crash cut point: durable logout credential/epoch deletion has
    // committed, but the old process has not yet purged its cache.
    createSettings().clearRefreshToken(verified)
    const second = createService()
    const signedOut = await second.connect()
    expect(signedOut.generation).toBe(oldResource.hubGeneration)
    test.client.redeemInvitation.mockResolvedValue({
      ...authBundle('refresh-b'),
      principal: { id: 'principal-b', email: 'b@example.test', display_name: 'B' },
      session: { id: 'session-b', device_label: 'Desktop B', expires_at: '2026-09-20T12:00:00.000Z' }
    })
    await second.join({ email: 'b@example.test', displayName: 'B', deviceLabel: 'Desktop B' })

    await expect(second.teamAttachmentMediaResponse(
      oldResource,
      new Request('agentsdock-media://team/profile/generation/auth/team/attachment')
    )).rejects.toThrow('connection changed')
    expect(cachedResponse).not.toHaveBeenCalled()
  })

  it('returns a strictly bounded cached text preview without enabling renderer protocol fetches', async () => {
    const contents = new TextEncoder().encode('hello secure preview')
    const digest = createHash('sha256').update(contents).digest('hex')
    const cacheFile = vi.fn().mockResolvedValue('/private/team-cache/content.bin')
    const response = vi.fn(async (_identity, request: Request) => {
      expect(request.headers.get('Range')).toBe('bytes=0-4')
      return new Response(contents.slice(0, 5), {
        status: 206,
        headers: {
          'Content-Length': '5',
          'Content-Range': `bytes 0-4/${contents.byteLength}`
        }
      })
    })
    const cache = {
      cache: cacheFile,
      response,
      purgeProfile: vi.fn().mockResolvedValue(undefined)
    } as unknown as TeamAttachmentCache
    const test = harness({}, cache)
    const scope = await connectWithTeamMessages(test)
    const attachmentMetadata = {
      id: 'attachment-1',
      team_id: 'team-1',
      message_id: 'message-1',
      file_name: 'notes.txt',
      media_type: 'text/plain',
      byte_size: contents.byteLength,
      sha256: digest,
      state: 'ready',
      received_bytes: contents.byteLength,
      created_at: '2026-09-05T00:00:00Z',
      ready_at: '2026-09-05T00:00:01Z'
    }
    test.client.teamAttachment.mockImplementation(async () => ({ ...attachmentMetadata }))

    const result = await test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })
    expect(result).toMatchObject({
      text_preview: { text: 'hello', byte_size: 5, truncated: true }
    })
    expect(result.media_url).toMatch(/^agentsdock-media:\/\/team\//)
    expect(cacheFile).toHaveBeenCalledOnce()
    expect(response).toHaveBeenCalledOnce()
    expect(response.mock.calls[0]![0]).toEqual(cacheFile.mock.calls[0]![0])

    const cancelled = vi.fn()
    response.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(contents.slice(0, 5)) },
      cancel: cancelled
    }), {
      status: 200,
      headers: { 'Content-Length': '5' }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('invalid byte range')
    expect(cancelled).toHaveBeenCalledOnce()

    response.mockResolvedValueOnce(new Response('hello', {
      status: 206,
      headers: {
        'Content-Length': '0x5',
        'Content-Range': `bytes 0-4/${contents.byteLength}`
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('invalid byte range')

    response.mockResolvedValueOnce(new Response('hello!', {
      status: 206,
      headers: {
        'Content-Length': '5',
        'Content-Range': `bytes 0-4/${contents.byteLength}`
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('exceeded its declared byte range')

    response.mockResolvedValueOnce(new Response(null, {
      status: 206,
      headers: {
        'Content-Length': '5',
        'Content-Range': `bytes 0-4/${contents.byteLength}`
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('had no response body')

    response.mockResolvedValueOnce(new Response('hell', {
      status: 206,
      headers: {
        'Content-Length': '5',
        'Content-Range': `bytes 0-4/${contents.byteLength}`
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('truncated in transit')

    const splitUnicode = new TextEncoder().encode('A💜B')
    test.client.teamAttachment.mockResolvedValueOnce({
      ...attachmentMetadata,
      byte_size: splitUnicode.byteLength,
      received_bytes: splitUnicode.byteLength,
      sha256: createHash('sha256').update(splitUnicode).digest('hex')
    })
    response.mockResolvedValueOnce(new Response(splitUnicode.slice(0, 3), {
      status: 206,
      headers: {
        'Content-Length': '3',
        'Content-Range': `bytes 0-2/${splitUnicode.byteLength}`
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 3
    })).resolves.toMatchObject({
      text_preview: { text: 'A', byte_size: 3, truncated: true }
    })

    const invalidUtf8 = Uint8Array.from([0xff, 0x61])
    test.client.teamAttachment.mockResolvedValueOnce({
      ...attachmentMetadata,
      byte_size: invalidUtf8.byteLength,
      received_bytes: invalidUtf8.byteLength,
      sha256: createHash('sha256').update(invalidUtf8).digest('hex')
    })
    response.mockResolvedValueOnce(new Response(invalidUtf8, {
      status: 206,
      headers: {
        'Content-Length': '2',
        'Content-Range': 'bytes 0-1/2'
      }
    }))
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 2
    })).rejects.toThrow('not valid UTF-8')

    test.client.teamAttachment.mockResolvedValueOnce({
      ...attachmentMetadata,
      file_name: 'private.bin',
      media_type: 'application/octet-stream'
    })
    cacheFile.mockClear()
    await expect(test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 5
    })).rejects.toThrow('Only text Team attachments')
    expect(cacheFile).not.toHaveBeenCalled()

    response.mockClear()
    const mediaOnly = await test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1'
    })
    expect(mediaOnly).not.toHaveProperty('text_preview')
    expect(response).not.toHaveBeenCalled()
  })

  it('rejects a cached text preview if its authenticated Teamspace retires during the bounded read', async () => {
    const contents = new TextEncoder().encode('hello')
    const bodyRequested = deferred<void>()
    const releaseBody = deferred<void>()
    let started = false
    const response = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (started) return
        started = true
        bodyRequested.resolve()
        await releaseBody.promise
        controller.enqueue(contents)
        controller.close()
      }
    }), {
      status: 206,
      headers: {
        'Content-Length': String(contents.byteLength),
        'Content-Range': `bytes 0-${contents.byteLength - 1}/${contents.byteLength}`
      }
    }))
    const cache = {
      cache: vi.fn().mockResolvedValue('/private/team-cache/content.bin'),
      response,
      purgeProfile: vi.fn().mockResolvedValue(undefined)
    } as unknown as TeamAttachmentCache
    const test = harness({}, cache)
    const scope = await connectWithTeamMessages(test)
    test.client.teamAttachment.mockResolvedValue({
      id: 'attachment-1', team_id: 'team-1', message_id: 'message-1', file_name: 'notes.txt',
      media_type: 'text/plain', byte_size: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'), state: 'ready',
      received_bytes: contents.byteLength,
      created_at: '2026-09-05T00:00:00Z', ready_at: '2026-09-05T00:00:01Z'
    })

    const pending = test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: contents.byteLength
    })
    await bodyRequested.promise
    test.service.stop()
    releaseBody.resolve()

    await expect(pending).rejects.toThrow('connection changed')
  })

  it('fences the exact auth-cache epoch while caching and reading a text preview', async () => {
    const contents = new TextEncoder().encode('hello')
    const cachePending = deferred<string>()
    const bodyRequested = deferred<void>()
    const releaseBody = deferred<void>()
    let bodyStarted = false
    const cacheFile = vi.fn()
      .mockReturnValueOnce(cachePending.promise)
      .mockResolvedValue('/private/team-cache/content.bin')
    const response = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (bodyStarted) return
        bodyStarted = true
        bodyRequested.resolve()
        await releaseBody.promise
        controller.enqueue(contents)
        controller.close()
      }
    }), {
      status: 206,
      headers: {
        'Content-Length': String(contents.byteLength),
        'Content-Range': `bytes 0-${contents.byteLength - 1}/${contents.byteLength}`
      }
    }))
    const cache = {
      cache: cacheFile,
      response,
      purgeProfile: vi.fn().mockResolvedValue(undefined)
    } as unknown as TeamAttachmentCache
    const test = harness({}, cache)
    const scope = await connectWithTeamMessages(test)
    test.client.teamAttachment.mockResolvedValue({
      id: 'attachment-1', team_id: 'team-1', message_id: 'message-1', file_name: 'notes.txt',
      media_type: 'text/plain', byte_size: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'), state: 'ready',
      received_bytes: contents.byteLength,
      created_at: '2026-09-05T00:00:00Z', ready_at: '2026-09-05T00:00:01Z'
    })
    const rotateAuth = (sessionId: string) => {
      const bundle = authBundle(`refresh-${sessionId}`)
      ;(test.service as unknown as {
        adoptAuth(next: TeamHubAuthBundle, generation: number, replacedRefreshToken?: string): void
      }).adoptAuth({
        ...bundle,
        session: { ...bundle.session, id: sessionId }
      }, scope.generation)
    }

    const staleCache = test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: contents.byteLength
    })
    await vi.waitFor(() => expect(cacheFile).toHaveBeenCalledOnce())
    rotateAuth('session-2')
    cachePending.resolve('/private/team-cache/content.bin')
    await expect(staleCache).rejects.toThrow('connection changed')
    expect(response).not.toHaveBeenCalled()

    const staleRead = test.service.cacheTeamAttachment(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: contents.byteLength
    })
    await bodyRequested.promise
    rotateAuth('session-3')
    releaseBody.resolve()
    await expect(staleRead).rejects.toThrow('connection changed')
  })

  it('cancels attachment hashing and chunk upload when its renderer operation is retired', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-team-attachment-abort-'))
    settingsDirectories.push(directory)
    const largePath = join(directory, 'large.bin')
    writeFileSync(largePath, Buffer.alloc(4 * 1024 * 1024, 7))
    const largeFd = openSync(largePath, 'r')
    const hashAbort = new AbortController()
    try {
      const hashing = test.service.declareTeamAttachment(scope, {
        teamId: 'team-1', path: largePath, fileName: 'large.bin',
        idempotencyKey: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434'
      }, {
        requestedPath: largePath, canonicalPath: largePath, fd: largeFd,
        byteSize: 4 * 1024 * 1024, close: vi.fn()
      }, hashAbort.signal)
      queueMicrotask(() => hashAbort.abort(new Error('renderer destroyed during hash')))
      await expect(hashing).rejects.toThrow('renderer destroyed during hash')
      expect(test.client.declareTeamAttachment).not.toHaveBeenCalled()
    } finally {
      closeSync(largeFd)
    }

    const smallPath = join(directory, 'small.bin')
    const contents = Buffer.from('private bytes')
    writeFileSync(smallPath, contents)
    const smallFd = openSync(smallPath, 'r')
    const chunkAbort = new AbortController()
    const sha256 = createHash('sha256').update(contents).digest('hex')
    test.client.teamAttachment.mockResolvedValue({
      id: 'attachment-1', team_id: 'team-1', message_id: null, file_name: 'small.bin',
      media_type: 'application/octet-stream', byte_size: contents.byteLength, sha256,
      state: 'uploading', received_bytes: 0, created_at: '2026-09-05T00:00:00Z', ready_at: null
    })
    test.client.uploadTeamAttachmentChunk.mockImplementation(
      (_token, _teamId, _attachmentId, _bytes, _start, _total, signal?: AbortSignal) => (
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      )
    )
    try {
      const uploading = test.service.uploadTeamAttachment(scope, {
        teamId: 'team-1', attachmentId: 'attachment-1', path: smallPath
      }, {
        requestedPath: smallPath, canonicalPath: smallPath, fd: smallFd,
        byteSize: contents.byteLength, close: vi.fn()
      }, chunkAbort.signal)
      await vi.waitFor(() => expect(test.client.uploadTeamAttachmentChunk).toHaveBeenCalledOnce())
      chunkAbort.abort(new Error('renderer destroyed during upload'))
      await expect(uploading).rejects.toThrow('renderer destroyed during upload')
      expect(test.client.teamAttachment).toHaveBeenCalledOnce()
    } finally {
      closeSync(smallFd)
    }
  })

  it('keeps a durable binding through transient null discovery and reconnects to the same advertised identity', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle('refresh-rotated'))
    const connected = await test.service.connect()
    expect(connected).toMatchObject({ authenticated: true, hubIdentity: 'hub-stable-1' })

    test.setCurrentDiscovery(null)
    const offline = test.service.status()
    expect(offline).toMatchObject({
      connectionState: 'offline',
      authenticated: false,
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: true,
      backgroundReconnectAllowed: true,
      error: 'AgentsServer is unreachable or restarting. Teamspace will reconnect automatically.'
    })
    expect(test.bindings.get('server-profile-1')).toMatchObject({ hubIdentity: 'hub-stable-1' })
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-rotated')

    test.setCurrentDiscovery(undefined)
    await expect(test.service.connect(backgroundReconnectFrom(offline))).resolves.toMatchObject({
      connectionState: 'authenticated',
      authenticated: true,
      hubIdentity: 'hub-stable-1',
      error: null
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)
  })

  it('keeps the fail-closed warning for a present mismatched Hub advertisement', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle('refresh-rotated'))
    await test.service.connect()

    test.setDiscovery({ hubIdentity: 'hub-replacement' })
    const mismatched = test.service.status()
    expect(mismatched).toMatchObject({
      connectionState: 'offline',
      authenticated: false,
      savedHubIdentity: 'hub-stable-1',
      error: 'The active AgentsServer Team Hub identity changed or is no longer verified. Forget the saved identity only after confirming the host change.'
    })
    expect(test.bindings.get('server-profile-1')).toMatchObject({ hubIdentity: 'hub-stable-1' })
  })

  it('throttles a transient background failure and retries without foreground rearming', async () => {
    const test = harness()
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    test.discovery.discover.mockRejectedValueOnce(new TypeError('network unavailable'))

    const failed = await test.service.connect(backgroundReconnectFrom(test.service.status()))
    expect(failed).toMatchObject({ connectionState: 'offline', backgroundReconnectAllowed: true })
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    await expect(test.service.connect(backgroundReconnectFrom(failed))).resolves.toMatchObject({
      connectionState: 'offline',
      backgroundReconnectAllowed: true
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    test.advanceTime(30_000)
    await expect(test.service.connect(backgroundReconnectFrom(test.service.status()))).resolves.toMatchObject({
      authenticated: true,
      connectionState: 'authenticated',
      backgroundReconnectAllowed: true
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)
  })

  it('lets one exact server-managed surface bypass a passive gate and immediately reinstates it', async () => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      server_session_available: true
    })
    test.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    test.discovery.discover
      .mockRejectedValueOnce(new TypeError('passive failure'))
      .mockRejectedValueOnce(new TypeError('surface failure'))

    const cold = test.service.status()
    expect(cold).toMatchObject({
      serverManaged: true,
      connectionState: 'disconnected',
      backgroundReconnectAllowed: true
    })
    const passiveFailure = await test.service.connect(backgroundReconnectFrom(cold))
    expect(passiveFailure).toMatchObject({ connectionState: 'offline', serverManaged: true })
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    test.advanceTime(5_000)
    const surfaceFailure = await test.service.connect(surfaceReconnectFrom(passiveFailure))
    expect(surfaceFailure).toMatchObject({ connectionState: 'offline', serverManaged: true })
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)
    expect(test.settings.setProfileBackgroundReconnectAllowed).not.toHaveBeenCalled()
    expect(test.settings.setBackgroundReconnectAllowed).not.toHaveBeenCalled()

    await expect(test.service.connect(surfaceReconnectFrom(surfaceFailure))).resolves.toMatchObject({
      connectionState: 'offline',
      serverManaged: true
    })
    await expect(test.service.connect(backgroundReconnectFrom(surfaceFailure))).resolves.toMatchObject({
      connectionState: 'offline',
      serverManaged: true
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)

    test.advanceTime(29_999)
    await expect(test.service.connect(backgroundReconnectFrom(surfaceFailure))).resolves.toMatchObject({
      connectionState: 'offline',
      serverManaged: true
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)

    test.advanceTime(1)
    await expect(test.service.connect(backgroundReconnectFrom(surfaceFailure))).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'server',
      connectionState: 'authenticated',
      serverManaged: true
    })
    expect(test.discovery.discover).toHaveBeenCalledTimes(3)
  })

  it('retains the surface bypass fence for one profile activation and resets it for the next', async () => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.discovery.discover.mockRejectedValue(new TypeError('network unavailable'))

    const firstFailure = await test.service.connect(surfaceReconnectFrom(test.service.status()))
    expect(firstFailure).toMatchObject({ connectionState: 'offline', serverManaged: true })
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    await test.service.connect(surfaceReconnectFrom(firstFailure))
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    test.setServerScope({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverName: 'Renamed local server'
    })
    const renamed = test.service.status()
    await test.service.connect(surfaceReconnectFrom(renamed))
    expect(test.discovery.discover).toHaveBeenCalledTimes(1)

    test.setServerScope({
      profileId: 'server-profile-2',
      profileGeneration: 2,
      serverIdentity: 'server-stable-2',
      serverUrl: 'http://127.0.0.1:7852',
      serverName: 'Server two'
    })
    test.setDiscovery({ hostServerIdentity: 'server-stable-2' })
    const secondProfile = test.service.status()
    const secondPassiveFailure = await test.service.connect(backgroundReconnectFrom(secondProfile))
    expect(test.discovery.discover).toHaveBeenCalledTimes(2)

    await test.service.connect(surfaceReconnectFrom(secondPassiveFailure))
    expect(test.discovery.discover).toHaveBeenCalledTimes(3)
  })

  it('keeps explicit Disconnect denied after service recreation', async () => {
    const test = harness()
    const storagePath = settingsPath()
    const keychain = new MemoryTeamHubKeychain()
    const createSettings = () => new TeamHubSettingsStore({
      path: storagePath,
      keychain,
      secureStorage: memoryTeamHubSafeStorage,
      isMacAppStoreBuild: () => false
    })
    const verified: TeamHubVerifiedBinding = {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    }
    const seed = createSettings()
    seed.activateVerifiedHub(verified)
    seed.storeRefreshToken('refresh-old', verified)
    test.client.refresh.mockResolvedValue(authBundle())
    const createService = () => new TeamHubService({
      settings: createSettings(),
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })

    const first = createService()
    const connected = await first.connect()
    await expect(first.disconnect(scopeFrom(connected))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    first.stop()

    const reloaded = createService()
    const cold = reloaded.status()
    expect(cold).toMatchObject({ connectionState: 'disconnected', backgroundReconnectAllowed: false })
    test.discovery.discover.mockClear()
    await expect(reloaded.connect(backgroundReconnectFrom(cold))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    expect(test.discovery.discover).not.toHaveBeenCalled()
    reloaded.stop()
  })

  it('keeps a forgotten binding absent and passive reconnect denied after service recreation', async () => {
    const test = harness()
    const storagePath = settingsPath()
    const keychain = new MemoryTeamHubKeychain()
    const createSettings = () => new TeamHubSettingsStore({
      path: storagePath,
      keychain,
      secureStorage: memoryTeamHubSafeStorage,
      isMacAppStoreBuild: () => false
    })
    const verified: TeamHubVerifiedBinding = {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    }
    const seed = createSettings()
    seed.activateVerifiedHub(verified)
    seed.storeRefreshToken('refresh-old', verified)
    test.client.refresh.mockResolvedValue(authBundle())
    const createService = () => new TeamHubService({
      settings: createSettings(),
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })

    const first = createService()
    const connected = await first.connect()
    expect(await first.forgetBinding({
      profileId: connected.profileId,
      profileGeneration: connected.profileGeneration,
      serverIdentity: connected.serverIdentity!,
      expectedGeneration: connected.generation,
      expectedHubIdentity: connected.savedHubIdentity!
    })).toMatchObject({
      connectionState: 'disconnected',
      savedHubIdentity: null,
      canForgetBinding: false,
      backgroundReconnectAllowed: false
    })
    first.stop()

    const reloadedSettings = createSettings()
    expect(reloadedSettings.publicSettings('server-profile-1')).toBeNull()
    const reloaded = new TeamHubService({
      settings: reloadedSettings,
      discovery: test.discovery,
      clientFactory: test.clientFactory,
      secretFiles: test.secretFiles,
      now: () => Date.parse('2026-08-20T12:00:00.000Z')
    })
    const cold = reloaded.status()
    expect(cold).toMatchObject({
      connectionState: 'disconnected',
      savedHubIdentity: null,
      canForgetBinding: false,
      backgroundReconnectAllowed: false
    })
    test.discovery.discover.mockClear()
    await expect(reloaded.connect(backgroundReconnectFrom(cold))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    expect(test.discovery.discover).not.toHaveBeenCalled()
    expect(reloadedSettings.publicSettings('server-profile-1')).toBeNull()
    reloaded.stop()
  })

  it('waits for a saved secure peer to finish startup recovery before adopting host-only discovery', async () => {
    const test = harness()
    const connectionId = TRANSIENT_CONNECTION_ID
    const basePath = `/api/team-hub-secure/${connectionId}`
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: `http://127.0.0.1:7850${basePath}`,
      hubIdentity: 'hub-remote',
      connectionId,
      hostServerIdentity: 'server-host'
    })
    test.setDiscovery({
      available: false,
      designatedHost: false,
      basePath: null,
      transport: null,
      hubUrl: null,
      hubIdentity: null,
      hostServerIdentity: null,
      connectionId: undefined,
      routes: [],
      message: 'This AgentsServer is not the designated Team Hub host.',
      action: 'Configure AGENTSDOCK_TEAM_HUB_MODE=host on exactly one AgentsServer.'
    })
    const reconnecting = securePeerControl(connectionId)
    reconnecting.pairings = reconnecting.pairings.map(pairing => ({
      ...pairing,
      status: 'approved',
      transportState: 'reconnecting'
    }))
    test.discovery.securePeerStatus
      .mockResolvedValueOnce(securePeerControl(null))
      .mockResolvedValueOnce(reconnecting)
      .mockResolvedValue(securePeerControl(connectionId))
    const secureFetch = vi.fn(async (input: string | URL | Request) => {
      const requestPath = new URL(input instanceof Request ? input.url : input.toString()).pathname
      const payload = requestPath.endsWith('/v1/health') ? {
        ok: true,
        service: 'agentsdock-team-hub',
        api_version: 1,
        hub_id: 'hub-remote',
        instance_id: 'hub-instance',
        bootstrapped: true,
        bootstrap_required: false,
        peer_session_available: true
      } : {
        session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
        principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
        teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)

    const recovered = await test.service.connect()
    expect(test.wait.mock.calls).toEqual([[100], [250]])
    expect(test.discovery.securePeerStatus).toHaveBeenCalledTimes(3)
    expect(recovered).toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      connectionState: 'authenticated',
      transport: 'secure_peer',
      connectionId,
      hubIdentity: 'hub-remote',
      error: null
    })
    expect(test.discovery.secureTeamHubProxyFetch).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'server-profile-1', serverIdentity: 'server-stable-1'
    }), basePath)
  })

  it('adopts a peer-native secure session without reading or storing a human Hub credential', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    test.setServerScope({
      profileId: 'studio-client', profileGeneration: 5, serverIdentity: 'server-client',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Studio client'
    })
    test.setDiscovery({
      available: true,
      designatedHost: false,
      transport: 'secure_peer',
      basePath,
      hubUrl: null,
      hubIdentity: 'hub-remote',
      hostServerIdentity: 'server-host',
      connectionId,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId,
        hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
      }]
    })
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
      const payload = path.endsWith('/v1/health') ? {
        ok: true,
        service: 'agentsdock-team-hub',
        api_version: 1,
        hub_id: 'hub-remote',
        instance_id: 'hub-instance',
        bootstrapped: true,
        bootstrap_required: false,
        peer_session_available: true
      } : path.endsWith('/v1/peer-session') ? {
        session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
        principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
        teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
      } : { teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }] }
      expect(new Headers(init.headers).get('Authorization')).toBeNull()
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(fetchMock as typeof fetch)
    test.discovery.securePeerStatus.mockImplementation(async expected => ({
      ...securePeerControl(connectionId),
      profileId: expected.profileId,
      profileGeneration: expected.profileGeneration,
      serverIdentity: expected.serverIdentity
    }))

    const connected = await test.service.connect({ transport: 'secure_peer' })
    expect(connected).toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      hubUrl: `http://100.64.0.1:7850${basePath}`,
      connectionId,
      hostServerIdentity: 'server-host',
      principal: { kind: 'node', email: null }
    })
    expect(test.discovery.secureTeamHubProxyFetch).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'studio-client', profileGeneration: 5, serverIdentity: 'server-client'
    }), basePath)
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
    expect(test.settings.storeRefreshToken).not.toHaveBeenCalled()
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.client.revoke).not.toHaveBeenCalled()

    const scope = scopeFrom(connected)
    await expect(test.service.workspace(scope)).resolves.toMatchObject({ teams: [{ role: 'automation' }] })
    await test.service.logout(scope)
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.client.revoke).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') == null)).toBe(true)
  })

  it('fences paired-server and paired-agent authors to the active owned server projection', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    test.setServerScope({
      profileId: 'studio-client', profileGeneration: 5, serverIdentity: 'server-client',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Studio client'
    })
    test.setDiscovery({
      available: true, designatedHost: false, transport: 'secure_peer', basePath,
      hubUrl: null, hubIdentity: 'hub-remote', hostServerIdentity: 'server-host', connectionId,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId,
        hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
      }]
    })
    test.discovery.securePeerStatus.mockImplementation(async expected => ({
      ...securePeerControl(connectionId),
      profileId: expected.profileId,
      profileGeneration: expected.profileGeneration,
      serverIdentity: expected.serverIdentity
    }))
    const now = '2026-08-24T12:00:00Z'
    const projection = {
      network: { id: 'team-1', display_name: 'Studio', hub_id: 'hub-remote' },
      servers: [{
        id: 'node-client', server_identity: 'server-client', display_name: 'Studio client',
        status: 'active', is_host: false, owned_by_caller: true
      }, {
        id: 'node-host', server_identity: 'server-host', display_name: 'Host',
        status: 'active', is_host: true, owned_by_caller: false
      }],
      agents: [{
        id: 'agent-client', server_id: 'node-client', external_agent_id: 'chat-1',
        backend: 'codex', display_name: 'Georgia', status: 'active'
      }],
      next_after_server_id: 'node-host',
      has_more: false
    }
    let forgeServerAuthor = false
    let forgeAgentServer = false
    const secureFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
      let payload: unknown
      if (path.endsWith('/v1/health')) {
        payload = {
          ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-remote',
          instance_id: 'hub-instance', bootstrapped: true, bootstrap_required: false,
          peer_session_available: true, capabilities: { team_network_v1: teamNetworkCapability() }
        }
      } else if (path.endsWith('/v1/peer-session')) {
        payload = {
          session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
          principal: { id: 'peer-service', kind: 'service', display_name: 'Studio client', email: null },
          teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
        }
      } else if (path.endsWith('/v1/teams/team-1/network') && (init.method ?? 'GET') === 'GET') {
        payload = projection
      } else if (path.endsWith('/v1/teams/team-1/network/bulletin') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { body: string; body_format: 'plain' | 'markdown' }
        payload = { post: {
          id: 'post-1', sequence: 1,
          author: { kind: 'server', id: forgeServerAuthor ? 'node-host' : 'node-client', display_name: 'Studio client' },
          body_format: body.body_format, body: body.body, thread_root_post_id: null,
          reply_to_post_id: null, created_at: now
        } }
      } else if (path.endsWith('/v1/teams/team-1/network/mailbox') && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          to: { kind: 'server'; id: string }; from_agent_id: string; body: string; body_format: 'plain' | 'markdown'
        }
        payload = {
          item: {
            id: 'item-1', sequence: 1, kind: 'message',
            from: {
              kind: 'agent', id: body.from_agent_id,
              server_id: forgeAgentServer ? 'node-host' : 'node-client', backend: 'codex', display_name: 'Georgia'
            },
            to: { kind: 'server', id: body.to.id, server_identity: 'server-host', display_name: 'Host' },
            body_format: body.body_format, body: body.body, request_id: null, created_at: now, expires_at: null
          },
          delivery: { id: 'delivery-1', state: 'available', available_at: now, delivered_at: null, read_at: null }
        }
      } else {
        throw new Error(`unexpected secure Team Network route: ${init.method ?? 'GET'} ${path}`)
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)

    const connected = await test.service.connect({ transport: 'secure_peer' })
    const scope = scopeFrom(connected)
    await expect(test.service.postBulletin(scope, {
      teamId: 'team-1', body: 'Update', idempotencyKey: 'post-key'
    })).resolves.toMatchObject({ author: { kind: 'server', id: 'node-client' } })
    await expect(test.service.sendMailbox(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-host' }, fromAgentId: 'agent-client',
      body: 'Hello', idempotencyKey: 'mail-key'
    })).resolves.toMatchObject({ item: { from: { kind: 'agent', id: 'agent-client', server_id: 'node-client' } } })

    forgeServerAuthor = true
    await expect(test.service.postBulletin(scope, {
      teamId: 'team-1', body: 'Update', idempotencyKey: 'post-key-2'
    })).rejects.toThrow('mismatched Bulletin post')
    forgeAgentServer = true
    await expect(test.service.sendMailbox(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-host' }, fromAgentId: 'agent-client',
      body: 'Hello', idempotencyKey: 'mail-key-2'
    })).rejects.toThrow('mismatched mailbox item')
  })

  it('restores the exact Teamspace-only peer after restart despite the legacy cross-chat warning', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('local-refresh')
    test.discovery.securePeerStatus.mockResolvedValue({
      ...securePeerControl(connectionId),
      connectionError: 'Peer cross-chat approval is not current'
    })
    const secureFetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
      const payload = path.endsWith('/v1/health') ? {
        ok: true,
        service: 'agentsdock-team-hub',
        api_version: 1,
        hub_id: 'hub-remote',
        instance_id: 'hub-instance',
        bootstrapped: true,
        bootstrap_required: false,
        peer_session_available: true
      } : {
        session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
        principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
        teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId,
      hostServerIdentity: 'server-host',
      hubIdentity: 'hub-remote',
      hubUrl: `http://127.0.0.1:7850${basePath}`
    })
    expect(test.service.status()).toMatchObject({
      authenticated: true,
      transport: 'secure_peer',
      connectionId
    })
    await expect(test.discovery.discover.mock.results[0]!.value).resolves.toMatchObject({
      designatedHost: true,
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.settings.activateVerifiedHub).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh')
    expect(test.bindings.get('server-profile-1')).toMatchObject({ hubIdentity: 'hub-stable-1' })
  })

  it('suppresses only the irrelevant legacy warning on the Teamspace-only control surface', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const profileScope = {
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }
    const warning = {
      ...securePeerControl(connectionId),
      connectionError: 'Peer cross-chat approval is not current'
    }
    const crossChatWarning = {
      ...warning,
      pairings: warning.pairings.map(pairing => ({
        ...pairing,
        grantedScopes: [...pairing.grantedScopes, 'cross_chat.instruction' as const]
      }))
    }
    test.discovery.securePeerStatus
      .mockResolvedValueOnce(warning)
      .mockResolvedValueOnce(crossChatWarning)

    await expect(test.service.securePeerStatus(profileScope)).resolves.toMatchObject({
      activeConnectionId: connectionId,
      connectionError: null
    })
    await expect(test.service.securePeerStatus(profileScope)).resolves.toMatchObject({
      activeConnectionId: connectionId,
      connectionError: 'Peer cross-chat approval is not current'
    })
  })

  it('keeps the designated-host local Hub when secure control has no active outgoing connection', async () => {
    const test = harness()
    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle('local-refresh-rotated'))

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      designatedHost: true,
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.discovery.securePeerStatus).toHaveBeenCalledWith({
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    })
    expect(test.discovery.secureTeamHubProxyFetch).not.toHaveBeenCalled()
  })

  it('keeps a healthy local Hub when optional secure control is temporarily unavailable', async () => {
    const test = harness()
    test.discovery.securePeerStatus.mockRejectedValue(new Error('secure peer control unavailable'))
    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle())

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.clientFactory).toHaveBeenCalledWith('http://127.0.0.1:7850/api/team-hub')
    expect(test.discovery.secureTeamHubProxyFetch).not.toHaveBeenCalled()
  })

  it('fails closed before probing any Hub when active secure control is inconsistent', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    test.discovery.securePeerStatus.mockResolvedValue({
      ...securePeerControl(connectionId),
      pairings: []
    })

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: false,
      connectionState: 'offline',
      error: 'AgentsServer reported an inconsistent active secure peer connection.'
    })
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.discovery.secureTeamHubProxyFetch).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
  })

  it('honors an explicit Tailscale route even while a secure peer is active', async () => {
    const test = harness()
    const serve = 'https://studio.my-tailnet.ts.net:8444/api/team-hub'
    test.setDiscovery({
      transport: 'loopback',
      hubUrl: null,
      routes: [
        { transport: 'loopback', hubUrl: null },
        { transport: 'tailscale_serve', hubUrl: serve }
      ]
    })
    test.discovery.securePeerStatus.mockResolvedValue(
      securePeerControl('09d7bb2e-3b47-4be7-89fc-2cecd90f4434')
    )
    test.setRefreshToken('serve-refresh')
    test.client.refresh.mockResolvedValue(authBundle())

    await expect(test.service.connect({ transport: 'tailscale_serve' })).resolves.toMatchObject({
      authenticated: true,
      transport: 'tailscale_serve',
      hubUrl: serve
    })
    expect(test.discovery.securePeerStatus).not.toHaveBeenCalled()
    expect(test.clientFactory).toHaveBeenCalledWith(serve)
    expect(test.discovery.secureTeamHubProxyFetch).not.toHaveBeenCalled()
  })

  it('temporarily switches a locally enrolled server to an approved peer without discarding its local credential', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const otherConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    const profileScope = {
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }
    const activation = {
      pairingId: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      expectedConnectionId: connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    }

    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle('local-refresh-rotated'))
    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      hubIdentity: 'hub-stable-1'
    })
    const savedLocalBinding = { ...test.bindings.get('server-profile-1')! }
    const localRefreshReads = vi.mocked(test.settings.refreshToken).mock.calls.length

    test.discovery.activateSecurePeerPairing.mockImplementation(async () => {
      test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(connectionId))
      return securePeerControl(connectionId)
    })

    await expect(test.service.activateSecurePeerPairing(profileScope, activation))
      .rejects.toThrow('Confirm switching away from the current local network')
    expect(test.discovery.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')

    await expect(test.service.activateSecurePeerPairing(profileScope, {
      ...activation,
      confirmLocalBindingReplacement: true
    })).resolves.toMatchObject({
      activeConnectionId: connectionId
    })
    expect(test.discovery.activateSecurePeerPairing).toHaveBeenCalledWith(profileScope, activation)
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.service.status()).toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: true
    })

    const secureFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
      const payload = path.endsWith('/v1/health') ? {
        ok: true,
        service: 'agentsdock-team-hub',
        api_version: 1,
        hub_id: 'hub-remote',
        instance_id: 'hub-instance',
        bootstrapped: true,
        bootstrap_required: false,
        peer_session_available: true
      } : {
        session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
        principal: { id: 'peer-node', kind: 'node', display_name: 'Client node', email: null },
        teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
      }
      const headers = input instanceof Request ? input.headers : new Headers(init.headers)
      expect(headers.get('Authorization')).toBeNull()
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', secureFetch)
    test.discovery.secureTeamHubProxyFetch.mockReturnValue(secureFetch as typeof fetch)

    const paired = await test.service.connect()
    expect(paired).toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId,
      hubIdentity: 'hub-remote'
    })
    expect(paired.canForgetBinding).toBe(false)
    expect(test.settings.activateVerifiedHub).toHaveBeenCalledTimes(1)
    expect(test.settings.refreshToken).toHaveBeenCalledTimes(localRefreshReads)
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.discovery.securePeerStatus).toHaveBeenCalled()

    await expect(test.service.activateSecurePeerPairing(profileScope, {
      ...activation,
      pairingId: '39d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      expectedConnectionId: otherConnectionId
    })).rejects.toThrow('forget the current secure connection')
    expect(test.discovery.activateSecurePeerPairing).toHaveBeenCalledTimes(1)

    test.discovery.forgetSecurePeerConnection.mockImplementation(async () => {
      test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(null))
      return securePeerControl(null)
    })
    await test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.service.status().backgroundReconnectAllowed).toBe(false)

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
  })

  it('suppresses passive reconnect after explicitly deactivating the exact secure binding', async () => {
    const test = harness()
    const { profileScope, connectionId } = await connectDurablePeer(test)
    test.discovery.deactivateSecurePeerConnection.mockResolvedValue(securePeerControl(null))

    await test.service.deactivateSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    })

    const disconnected = test.service.status()
    expect(disconnected).toMatchObject({
      connectionState: 'disconnected',
      authenticated: false,
      backgroundReconnectAllowed: false
    })
    test.discovery.discover.mockClear()
    await expect(test.service.connect(backgroundReconnectFrom(disconnected))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    expect(test.discovery.discover).not.toHaveBeenCalled()
  })

  it('drops authenticated secure-peer state when the server stops advertising the proxy and reconnects to the same pin', async () => {
    const test = harness()
    const { connectionId } = await connectDurablePeer(test)
    const saved = { ...test.bindings.get('server-profile-1')! }

    test.setCurrentDiscovery(null)
    const offline = test.service.status()

    expect(offline).toMatchObject({
      connectionState: 'offline',
      authenticated: false,
      backgroundReconnectAllowed: true,
      error: 'AgentsServer is unreachable or restarting. Teamspace will reconnect automatically.'
    })
    expect(test.bindings.get('server-profile-1')).toEqual(saved)

    const basePath = `/api/team-hub-secure/${connectionId}`
    test.setCurrentDiscovery(undefined)
    test.setDiscovery({
      available: true,
      designatedHost: false,
      transport: 'secure_peer',
      basePath,
      hubUrl: null,
      hubIdentity: 'hub-remote',
      hostServerIdentity: 'server-host',
      connectionId,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId,
        hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
      }],
      message: 'The secure peer connection is online.',
      action: null
    })
    await expect(test.service.connect(backgroundReconnectFrom(offline))).resolves.toMatchObject({
      authenticated: true,
      transport: 'secure_peer',
      connectionId,
      hubIdentity: 'hub-remote'
    })
  })

  it('drops authenticated secure-peer state immediately when a live data request reports an unavailable proxy', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    const connected = test.service.status()
    peerBehavior.dataError = 'retryable_unavailable'

    await expect(test.service.workspace(scopeFrom(connected))).rejects.toMatchObject({ status: 503 })
    expect(test.service.status()).toMatchObject({
      connectionState: 'offline',
      authenticated: false,
      backgroundReconnectAllowed: true,
      error: 'Teamspace connection was interrupted. AgentsDock will reconnect automatically.'
    })
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
  })

  it('drops authenticated state when a response body stream is interrupted after headers', async () => {
    const test = harness()
    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle('local-refresh-rotated'))
    const connected = await test.service.connect()
    test.client.teams.mockRejectedValueOnce(new TeamHubTransportError('Team Hub response stream was interrupted.'))

    await expect(test.service.workspace(scopeFrom(connected))).rejects.toBeInstanceOf(TeamHubTransportError)
    expect(test.service.status()).toMatchObject({
      connectionState: 'offline',
      authenticated: false,
      backgroundReconnectAllowed: true,
      error: 'Teamspace connection was interrupted. AgentsDock will reconnect automatically.'
    })
  })

  it('does not let an in-flight secure deactivate drop a newer local runtime on the same profile', async () => {
    const test = harness()
    const { profileScope } = await connectTransientPeer(test)
    const response = deferred<SecurePeerControlStatus>()
    test.discovery.deactivateSecurePeerConnection.mockReturnValue(response.promise)
    const deactivating = test.service.deactivateSecurePeerConnection(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    })
    await vi.waitFor(() => expect(test.discovery.deactivateSecurePeerConnection).toHaveBeenCalledOnce())

    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(null))
    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    response.resolve(securePeerControl(null))
    await deactivating

    expect(test.service.status()).toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
  })

  it('does not let an in-flight secure Forget drop a newer local runtime on the same profile', async () => {
    const test = harness()
    const { profileScope, savedLocalBinding } = await connectTransientPeer(test)
    const response = deferred<SecurePeerControlStatus>()
    test.discovery.forgetSecurePeerConnection.mockReturnValue(response.promise)
    const forgetting = test.service.forgetSecurePeerConnection(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })
    await vi.waitFor(() => expect(test.discovery.forgetSecurePeerConnection).toHaveBeenCalledOnce())

    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(null))
    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    response.resolve(securePeerControl(null))
    await forgetting

    expect(test.service.status()).toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
  })

  it('does not let secure Forget delete a newer persisted secure binding on the same profile', async () => {
    const test = harness()
    const { profileScope, connectionId } = await connectDurablePeer(test)

    const response = deferred<SecurePeerControlStatus>()
    test.discovery.forgetSecurePeerConnection.mockReturnValue(response.promise)
    const forgetting = test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })
    await vi.waitFor(() => expect(test.discovery.forgetSecurePeerConnection).toHaveBeenCalledOnce())
    const replacementConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const replacement = {
      ...test.bindings.get(profileScope.profileId)!,
      hubUrl: `http://127.0.0.1:7850/api/team-hub-secure/${replacementConnectionId}`,
      hubIdentity: 'hub-newer',
      connectionId: replacementConnectionId,
      hostServerIdentity: 'server-newer'
    }
    test.bindings.set(profileScope.profileId, replacement)
    vi.mocked(test.settings.forgetBinding).mockClear()
    response.resolve(securePeerControl(null))
    await forgetting

    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get(profileScope.profileId)).toEqual(replacement)
  })

  it('forgets an exact persisted secure binding even when no secure runtime is hydrated', async () => {
    const purgeProfile = vi.fn().mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const profileScope = {
      profileId: 'server-profile-1',
      profileGeneration: 1,
      serverIdentity: 'server-stable-1'
    }
    test.bindings.set(profileScope.profileId, {
      profileId: profileScope.profileId,
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: profileScope.serverIdentity,
      hubUrl: `http://127.0.0.1:7850/api/team-hub-secure/${TRANSIENT_CONNECTION_ID}`,
      hubIdentity: 'hub-remote',
      connectionId: TRANSIENT_CONNECTION_ID,
      hostServerIdentity: 'server-host'
    })
    test.discovery.forgetSecurePeerConnection.mockResolvedValue(securePeerControl(null))

    await test.service.forgetSecurePeerConnection(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })

    expect(test.settings.forgetBinding).toHaveBeenCalledWith(profileScope.profileId)
    expect(purgeProfile).toHaveBeenCalledOnce()
    expect(purgeProfile).toHaveBeenCalledWith(profileScope.profileId)
    expect(test.bindings.has(profileScope.profileId)).toBe(false)
    expect(test.service.status().backgroundReconnectAllowed).toBe(false)
  })

  it('forgets the exact persisted secure binding when its runtime invalidates during the remote request', async () => {
    const test = harness()
    const { profileScope, connectionId } = await connectDurablePeer(test)
    const response = deferred<SecurePeerControlStatus>()
    test.discovery.forgetSecurePeerConnection.mockReturnValue(response.promise)
    const forgetting = test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })
    await vi.waitFor(() => expect(test.discovery.forgetSecurePeerConnection).toHaveBeenCalledOnce())

    test.setDiscovery({
      available: false,
      hubIdentity: null,
      message: 'Secure peer is offline.',
      action: 'Reconnect the peer.'
    })
    expect(test.service.status()).toMatchObject({ authenticated: false, hubIdentity: null })
    expect(test.bindings.has(profileScope.profileId)).toBe(true)
    vi.mocked(test.settings.forgetBinding).mockClear()
    response.resolve(securePeerControl(null))
    await forgetting

    expect(test.settings.forgetBinding).toHaveBeenCalledWith(profileScope.profileId)
    expect(test.bindings.has(profileScope.profileId)).toBe(false)
  })

  it('recovers a durable binding only when authenticated status proves the exact connection was already forgotten', async () => {
    const purgeProfile = vi.fn().mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const { profileScope, connectionId } = await connectDurablePeer(test)
    test.discovery.forgetSecurePeerConnection.mockRejectedValue(new ServerError(
      409,
      'Secure peer connection identity changed',
      { code: 'connection_changed', message: 'Secure peer connection identity changed' }
    ))
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(null))

    await expect(test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })).resolves.toMatchObject({ activeConnectionId: null, pairings: [] })

    expect(test.discovery.securePeerStatus).toHaveBeenCalledWith(profileScope)
    expect(purgeProfile).toHaveBeenCalledWith(profileScope.profileId)
    expect(test.settings.forgetBinding).toHaveBeenCalledWith(profileScope.profileId)
    expect(test.bindings.has(profileScope.profileId)).toBe(false)
    expect(test.service.status()).toMatchObject({
      authenticated: false,
      backgroundReconnectAllowed: false
    })
  })

  it('retains a durable binding when connection_changed status still exposes that connection id', async () => {
    const test = harness()
    const { profileScope, connectionId } = await connectDurablePeer(test)
    const changed = new ServerError(
      409,
      'Secure peer connection identity changed',
      { code: 'connection_changed', message: 'Secure peer connection identity changed' }
    )
    test.discovery.forgetSecurePeerConnection.mockRejectedValue(changed)
    const identityMismatch = securePeerControl(connectionId)
    identityMismatch.pairings[0] = {
      ...identityMismatch.pairings[0]!,
      hostServerIdentity: 'different-host',
      hubIdentity: 'different-hub',
      certificateFingerprint: `sha256:${'e'.repeat(64)}`
    }
    test.discovery.securePeerStatus.mockResolvedValue(identityMismatch)

    await expect(test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })).rejects.toBe(changed)

    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get(profileScope.profileId)).toMatchObject({
      connectionId,
      hostServerIdentity: 'server-host',
      hubIdentity: 'hub-remote'
    })
  })

  it('retains a durable binding when secure Forget fails without an authenticated connection_changed response', async () => {
    const test = harness()
    const { profileScope, connectionId } = await connectDurablePeer(test)
    const transportFailure = new TypeError('fetch failed')
    test.discovery.forgetSecurePeerConnection.mockRejectedValue(transportFailure)
    vi.mocked(test.discovery.securePeerStatus).mockClear()

    await expect(test.service.forgetSecurePeerConnection(profileScope, {
      connectionId,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote',
      expectedCertificateFingerprint: `sha256:${'a'.repeat(64)}`
    })).rejects.toBe(transportFailure)

    expect(test.discovery.securePeerStatus).not.toHaveBeenCalled()
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get(profileScope.profileId)).toMatchObject({ connectionId })
  })

  it('fences an exact remotely revoked transient peer and restores the saved local binding and token', async () => {
    const test = harness()
    const { profileScope, peerHeaders, savedLocalBinding } = await connectTransientPeer(test)
    const revokedPairing = {
      ...securePeerControl(TRANSIENT_CONNECTION_ID).pairings[0]!,
      status: 'revoked' as const,
      trustState: 'revoked' as const,
      transportState: 'revoked' as const,
      localProxyBasePath: null,
      error: 'Peer access was revoked.'
    }
    const revokedControl = {
      ...securePeerControl(null),
      pairings: [revokedPairing]
    }
    test.discovery.securePeerStatus.mockResolvedValue(revokedControl)

    await expect(test.service.securePeerStatus(profileScope)).resolves.toMatchObject({
      activeConnectionId: null,
      pairings: [{
        direction: 'outgoing',
        status: 'revoked',
        connectionId: TRANSIENT_CONNECTION_ID,
        hostServerIdentity: 'server-host',
        hubIdentity: 'hub-remote'
      }]
    })

    expect(test.service.status()).toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.service.status()).not.toHaveProperty('connectionId')
    expect(test.service.status()).not.toHaveProperty('hostServerIdentity')
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(peerHeaders.length).toBeGreaterThan(0)
    expect(peerHeaders.every(headers => headers.get('Authorization') === null)).toBe(true)
  })

  it('does not retire the transient runtime for a control warning or an inexact revoked pairing', async () => {
    const test = harness()
    const { profileScope, savedLocalBinding } = await connectTransientPeer(test)
    const pairedStatus = test.service.status()
    const warning = {
      ...securePeerControl(TRANSIENT_CONNECTION_ID),
      connectionError: 'Peer authentication is unavailable'
    }
    test.discovery.securePeerStatus.mockResolvedValue(warning)

    await expect(test.service.securePeerStatus(profileScope)).resolves.toMatchObject({
      activeConnectionId: TRANSIENT_CONNECTION_ID,
      connectionError: 'Peer authentication is unavailable'
    })
    expect(test.service.status()).toMatchObject({
      generation: pairedStatus.generation,
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId: TRANSIENT_CONNECTION_ID
    })

    const inexactRevoked = {
      ...securePeerControl(null),
      pairings: [{
        ...securePeerControl(TRANSIENT_CONNECTION_ID).pairings[0]!,
        status: 'revoked' as const,
        trustState: 'revoked' as const,
        transportState: 'revoked' as const,
        hubIdentity: 'different-hub',
        localProxyBasePath: null
      }]
    }
    test.discovery.securePeerStatus.mockResolvedValue(inexactRevoked)
    await test.service.securePeerStatus(profileScope)
    expect(test.service.status()).toMatchObject({
      generation: pairedStatus.generation,
      authenticated: true,
      transport: 'secure_peer',
      connectionId: TRANSIENT_CONNECTION_ID,
      hubIdentity: 'hub-remote'
    })
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('retires beta8 active state only after an exact typed peer_revoked health response', async () => {
    const test = harness()
    const { profileScope, peerBehavior, peerHeaders, savedLocalBinding } = await connectTransientPeer(test)
    const warning = {
      ...securePeerControl(TRANSIENT_CONNECTION_ID),
      connectionError: 'Peer authentication is unavailable'
    }
    test.discovery.securePeerStatus.mockResolvedValue(warning)
    test.discovery.deactivateSecurePeerConnection.mockResolvedValue(securePeerControl(null))
    peerBehavior.healthError = 'peer_revoked'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.discovery.deactivateSecurePeerConnection).toHaveBeenCalledWith(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    })
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(peerHeaders.every(headers => headers.get('Authorization') === null)).toBe(true)
  })

  it('handles an exact typed peer_revoked race from peer-session before committing the candidate', async () => {
    const test = harness()
    const { profileScope, peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    test.discovery.deactivateSecurePeerConnection.mockResolvedValue(securePeerControl(null))
    peerBehavior.peerSessionError = 'peer_revoked'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.discovery.deactivateSecurePeerConnection).toHaveBeenCalledWith(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    })
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
  })

  it('preserves the verified transient runtime when peer-session has a transport failure', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    const pairedStatus = test.service.status()
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    peerBehavior.peerSessionError = 'transport'

    await expect(test.service.connect()).resolves.toMatchObject({
      generation: pairedStatus.generation,
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId: TRANSIENT_CONNECTION_ID,
      hubIdentity: 'hub-remote'
    })
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('preserves durable trust and the saved binding through reconnecting, offline, and online heartbeat states', async () => {
    const test = harness()
    const { savedLocalBinding } = await connectTransientPeer(test)
    const paired = test.service.status()
    const withTransport = (transportState: 'reconnecting' | 'offline' | 'online') => {
      const current = securePeerControl(TRANSIENT_CONNECTION_ID)
      return {
        ...current,
        pairings: [{ ...current.pairings[0]!, transportState }]
      }
    }

    for (const transportState of ['reconnecting', 'offline'] as const) {
      test.discovery.securePeerStatus.mockResolvedValue(withTransport(transportState))
      await expect(test.service.connect()).resolves.toMatchObject({
        generation: paired.generation,
        authenticated: true,
        authenticationMode: 'paired_node',
        transport: 'secure_peer',
        connectionId: TRANSIENT_CONNECTION_ID
      })
      expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
      expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    }

    test.discovery.securePeerStatus.mockResolvedValue(withTransport('online'))
    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId: TRANSIENT_CONNECTION_ID
    })
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
  })

  it('deactivates the immutable exact connection after certificate renewal races typed revocation', async () => {
    const test = harness()
    const { profileScope, peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    const observed = securePeerControl(TRANSIENT_CONNECTION_ID)
    const renewed = {
      ...securePeerControl(TRANSIENT_CONNECTION_ID),
      pairings: [{
        ...securePeerControl(TRANSIENT_CONNECTION_ID).pairings[0]!,
        certificateFingerprint: `sha256:${'e'.repeat(64)}`,
        certificateExpiresAt: '2027-02-01T00:00:00Z'
      }]
    }
    test.discovery.securePeerStatus
      .mockResolvedValueOnce(observed)
      .mockResolvedValue(renewed)
    test.discovery.deactivateSecurePeerConnection.mockResolvedValue(securePeerControl(null))
    peerBehavior.peerSessionError = 'peer_revoked'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: true,
      authenticationMode: 'human',
      transport: 'loopback',
      hubIdentity: 'hub-stable-1'
    })
    expect(test.discovery.deactivateSecurePeerConnection).toHaveBeenCalledWith(profileScope, {
      connectionId: TRANSIENT_CONNECTION_ID,
      expectedHostServerIdentity: 'server-host',
      expectedHubIdentity: 'hub-remote'
    })
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
  })

  it('keeps local credentials dormant when exact beta8 compatibility deactivation fails', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    test.discovery.securePeerStatus.mockResolvedValue({
      ...securePeerControl(TRANSIENT_CONNECTION_ID),
      connectionError: 'Peer authentication is unavailable'
    })
    test.discovery.deactivateSecurePeerConnection.mockRejectedValue(new Error('control unavailable'))
    peerBehavior.healthError = 'peer_revoked'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: false,
      connectionState: 'offline',
      transport: null,
      hubIdentity: null,
      error: 'Peer authentication is unavailable'
    })
    expect(test.discovery.deactivateSecurePeerConnection).toHaveBeenCalledOnce()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it.each([
    ['transport failure without a control warning', 'transport' as const, null],
    ['a retryable HTTP failure with a control warning', 'retryable_unavailable' as const, 'Peer route is temporarily unavailable']
  ])('keeps the verified transient peer on %s', async (_label, healthError, connectionError) => {
    const test = harness()
    const { peerBehavior, peerHeaders, savedLocalBinding } = await connectTransientPeer(test)
    const pairedStatus = test.service.status()
    test.discovery.securePeerStatus.mockResolvedValue({
      ...securePeerControl(TRANSIENT_CONNECTION_ID),
      connectionError
    })
    peerBehavior.healthError = healthError

    await expect(test.service.connect()).resolves.toMatchObject({
      generation: pairedStatus.generation,
      authenticated: true,
      authenticationMode: 'paired_node',
      transport: 'secure_peer',
      connectionId: TRANSIENT_CONNECTION_ID,
      hubIdentity: 'hub-remote'
    })
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(peerHeaders.every(headers => headers.get('Authorization') === null)).toBe(true)
  })

  it('fences offline on an exact secure candidate with the wrong Hub identity', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    peerBehavior.healthHubIdentity = 'wrong-hub'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: false,
      connectionState: 'offline',
      hubIdentity: null,
      error: 'Mounted Team Hub identity does not match the active AgentsServer capability.'
    })
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('fences offline on an invalid peer-session principal without retiring credentials', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    peerBehavior.peerSessionPrincipalKind = 'human'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: false,
      connectionState: 'offline',
      hubIdentity: null,
      error: 'The secure peer session did not identify a server principal.'
    })
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('fences offline on a non-retryable typed peer authentication failure', async () => {
    const test = harness()
    const { peerBehavior, savedLocalBinding } = await connectTransientPeer(test)
    test.discovery.securePeerStatus.mockResolvedValue(securePeerControl(TRANSIENT_CONNECTION_ID))
    peerBehavior.healthError = 'peer_authentication_required'

    await expect(test.service.connect()).resolves.toMatchObject({
      authenticated: false,
      connectionState: 'offline',
      hubIdentity: null,
      error: 'Peer authentication is required'
    })
    expect(test.discovery.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.discovery.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')).toEqual(savedLocalBinding)
    expect(test.refreshTokens.get('server-profile-1')).toBe('local-refresh-rotated')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('rejects secure-peer listings that are not incoming members of the requested team', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const outgoing = securePeerControl(connectionId).pairings[0]!
    const incoming = { ...outgoing, direction: 'incoming' as const, teamId: 'team-1' }
    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)

    test.client.securePeers.mockResolvedValueOnce({ peers: [incoming] })
    await expect(test.service.securePeers(scope, 'team-1')).resolves.toEqual([incoming])

    test.client.securePeers.mockResolvedValueOnce({ peers: [outgoing] })
    await expect(test.service.securePeers(scope, 'team-1'))
      .rejects.toThrow('outside the requested team')

    test.client.securePeers.mockResolvedValueOnce({ peers: [{ ...incoming, teamId: 'team-2' }] })
    await expect(test.service.securePeers(scope, 'team-1'))
      .rejects.toThrow('outside the requested team')
  })

  it('accepts only an exact incoming-team certificate-CAS peer revocation receipt', async () => {
    const test = harness()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const listed = securePeerControl(connectionId).pairings[0]!
    const revoked = {
      ...listed,
      direction: 'incoming' as const,
      status: 'revoked' as const,
      trustState: 'revoked' as const,
      transportState: 'revoked' as const,
      teamId: 'team-1'
    }
    const input = {
      peerId: revoked.connectionId!,
      idempotencyKey: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      expectedCertificateFingerprint: revoked.certificateFingerprint!
    }
    test.setRefreshToken('local-refresh')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)

    test.client.revokeSecurePeer.mockResolvedValueOnce({ peer: revoked })
    await expect(test.service.revokeSecurePeer(scope, 'team-1', input)).resolves.toEqual(revoked)

    const mismatchedReceipts = [
      { ...revoked, connectionId: '49d7bb2e-3b47-4be7-89fc-2cecd90f4434' },
      { ...revoked, direction: 'outgoing' as const },
      { ...revoked, teamId: 'team-2' },
      { ...revoked, status: 'connected' as const },
      { ...revoked, certificateFingerprint: `sha256:${'e'.repeat(64)}` }
    ]
    for (const peer of mismatchedReceipts) {
      test.client.revokeSecurePeer.mockResolvedValueOnce({ peer })
      await expect(test.service.revokeSecurePeer(scope, 'team-1', input))
        .rejects.toThrow('mismatched secure peer revocation receipt')
    }
  })

  it('rejects invitation redemption before authenticated discovery pins a Hub identity', async () => {
    const test = harness()
    await expect(test.service.join({ email: 'member@example.test', displayName: 'Member', deviceLabel: 'Desktop' }))
      .rejects.toThrow('Connect to and verify')
    expect(test.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(test.client.redeemInvitation).not.toHaveBeenCalled()
  })

  it('rejects secure-peer human enrollment before reading local invitation or recovery secrets', async () => {
    const test = harness()
    await connectTransientPeer(test)
    await test.service.logout(scopeFrom(test.service.status()))

    await expect(test.service.join({
      email: 'member@example.test', displayName: 'Member', deviceLabel: 'Desktop'
    })).rejects.toThrow(/Teamspace host/i)
    await expect(test.service.recoverDevice({ deviceLabel: 'Desktop' }))
      .rejects.toThrow(/Teamspace host/i)

    expect(test.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(test.client.redeemInvitation).not.toHaveBeenCalled()
    expect(test.client.recoverDevice).not.toHaveBeenCalled()
  })

  it('rejects secure-peer and server-managed bootstrap before requesting or reading a proof', async () => {
    const peer = harness()
    await connectTransientPeer(peer)
    Object.assign(peer.service as unknown as {
      bootstrapRequired: boolean
      connectionState: TeamHubStatus['connectionState']
    }, { bootstrapRequired: true, connectionState: 'needs-bootstrap' })

    await expect(peer.service.bootstrap({
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })).rejects.toThrow(/Teamspace host/i)
    expect(peer.discovery.requestBootstrapProof).not.toHaveBeenCalled()
    expect(peer.secretFiles.readBootstrapProof).not.toHaveBeenCalled()
    expect(peer.client.bootstrap).not.toHaveBeenCalled()

    const managed = harness()
    managed.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    managed.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true, server_session_available: false
    })
    await expect(managed.service.connect()).resolves.toMatchObject({
      connectionState: 'needs-bootstrap', serverManaged: true
    })
    await expect(managed.service.bootstrap({
      email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    })).rejects.toThrow(/Teamspace host/i)
    expect(managed.discovery.requestBootstrapProof).not.toHaveBeenCalled()
    expect(managed.secretFiles.readBootstrapProof).not.toHaveBeenCalled()
    expect(managed.client.bootstrap).not.toHaveBeenCalled()
  })

  it('reads invitation files only for a signed-in human principal', async () => {
    const peer = harness()
    await connectTransientPeer(peer)
    await expect(peer.service.acceptInvitation(scopeFrom(peer.service.status())))
      .rejects.toThrow(/signed-in person/i)
    expect(peer.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(peer.client.acceptInvitation).not.toHaveBeenCalled()

    const managed = harness()
    managed.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    managed.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true
    })
    managed.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    const managedStatus = await managed.service.connect()
    await expect(managed.service.acceptInvitation(scopeFrom(managedStatus)))
      .rejects.toThrow(/signed-in person/i)
    expect(managed.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(managed.client.acceptInvitation).not.toHaveBeenCalled()

    const human = harness()
    human.setRefreshToken('refresh-old')
    human.client.refresh.mockResolvedValue(authBundle())
    const humanStatus = await human.service.connect()
    human.client.acceptInvitation.mockResolvedValue({
      membership: {
        id: 'membership-2', team_id: 'team-2', principal_id: 'principal-1',
        role: 'member', status: 'active'
      },
      teams: [
        ...authBundle().teams,
        { id: 'team-2', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'member', status: 'active' }
      ]
    })
    await expect(human.service.acceptInvitation(scopeFrom(humanStatus)))
      .resolves.toMatchObject({ membership: { team_id: 'team-2', principal_id: 'principal-1' } })
    expect(human.secretFiles.readSecret).toHaveBeenCalledWith('invitation token')
    expect(human.client.acceptInvitation).toHaveBeenCalledWith('access-new', 'proof-secret')
  })

  it('does not probe any Hub endpoint when the active server capability is absent', async () => {
    const test = harness()
    test.setDiscovery({
      available: false, designatedHost: false, basePath: null, hubIdentity: null, hostServerIdentity: null,
      message: 'Team Hub is disabled.', action: 'Configure one designated host.'
    })

    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'unavailable', designatedHost: false, authenticated: false,
      availabilityAction: 'Configure one designated host.'
    })
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
  })

  it('shows a configured designated-host failure without probing its fixed path', async () => {
    const test = harness()
    test.setDiscovery({
      available: false, designatedHost: true, basePath: '/api/team-hub', hubIdentity: null,
      message: 'Team Hub could not start.', action: 'Restart the designated host after checking its local Team Hub logs.'
    })

    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'unavailable', designatedHost: true })
    expect(test.clientFactory).not.toHaveBeenCalled()
  })

  it('mounts the Hub under the exact host-local server prefix and rotates only its independent refresh credential', async () => {
    const test = harness()
    test.setServerScope({
      profileId: 'server-profile-1', profileGeneration: 3, serverIdentity: 'server-stable-1',
      serverUrl: 'http://localhost:7850/prefix', serverName: 'Host server'
    })
    test.setRefreshToken('hub-refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())

    const status = await test.service.connect()

    expect(test.clientFactory).toHaveBeenCalledWith('http://localhost:7850/prefix/api/team-hub')
    expect(test.client.refresh).toHaveBeenCalledWith('hub-refresh-old')
    expect(test.settings.storeRefreshToken).toHaveBeenCalledWith(
      'refresh-new',
      expect.objectContaining({
        profileId: 'server-profile-1', serverIdentity: 'server-stable-1', hubIdentity: 'hub-stable-1'
      }),
      expect.any(String)
    )
    expect(status).toMatchObject({
      authenticated: true, profileId: 'server-profile-1', profileGeneration: 3,
      serverIdentity: 'server-stable-1', hubIdentity: 'hub-stable-1', designatedHost: true
    })
    expect(JSON.stringify(status)).not.toMatch(/access-new|refresh-new|hub-refresh-old/)
  })

  it('bootstraps the first owner with the managed proof read only in main', async () => {
    const test = harness()
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true
    })
    test.client.bootstrap.mockResolvedValue(authBundle())
    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'needs-bootstrap' })

    const workspace = await test.service.bootstrap({ email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop' })
    expect(test.secretFiles.readBootstrapProof).toHaveBeenCalledWith('server-stable-1')
    expect(test.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(test.client.bootstrap).toHaveBeenCalledWith(
      'proof-secret', expect.objectContaining({ email: 'owner@example.test' }), undefined
    )
    expect(workspace.status.authenticated).toBe(true)
    expect(JSON.stringify(workspace)).not.toContain('proof-secret')
  })

  it('starts Atlas through the private Serve grant without putting either credential in renderer state', async () => {
    const test = harness()
    const hubUrl = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const requestId = '0dc9411c-d409-4d3e-ac83-9f03e3a55d98'
    const proof = `bootstrap_remote.${'a'.repeat(43)}`
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({ transport: 'tailscale_serve', hubUrl })
    test.discovery.requestBootstrapProof.mockResolvedValue({ requestId, proof })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true
    })
    test.client.bootstrap.mockResolvedValue(authBundle())

    await expect(test.service.connect()).resolves.toMatchObject({
      profileId: 'atlas', transport: 'tailscale_serve', connectionState: 'needs-bootstrap'
    })
    expect(test.clientFactory).toHaveBeenCalledWith(hubUrl)
    expect(test.service.status()).toMatchObject({
      hubUrl, transport: 'tailscale_serve', connectionState: 'needs-bootstrap'
    })

    const workspace = await test.service.bootstrap({
      email: 'OWNER@example.test', displayName: 'Owner', deviceLabel: 'AgentsDock Desktop'
    })

    expect(test.discovery.requestBootstrapProof).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1' }),
      {
        hubIdentity: 'hub-stable-1', hubUrl, recipientEmail: 'owner@example.test',
        transport: 'tailscale_serve', displayName: 'Owner', deviceLabel: 'AgentsDock Desktop'
      }
    )
    expect(test.secretFiles.readBootstrapProof).not.toHaveBeenCalled()
    expect(test.client.bootstrap).toHaveBeenCalledWith(proof, {
      email: 'owner@example.test', display_name: 'Owner', device_label: 'AgentsDock Desktop'
    }, requestId)
    expect(workspace.status.authenticated).toBe(true)
    expect(JSON.stringify(workspace)).not.toMatch(/bootstrap_remote|access-new|refresh-new/)
  })

  it('keeps Serve as the automatic route and never offers the advertised legacy Direct route', async () => {
    const test = harness()
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    const events: string[] = []
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'tailscale_serve', hubUrl: serve,
      routes: [
        { transport: 'tailscale_serve', hubUrl: serve },
        { transport: 'direct_ip', hubUrl: direct }
      ]
    })
    test.bindings.set('atlas', {
      profileId: 'atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-stable-1',
      hubUrl: direct, hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('refresh-old', 'atlas')
    test.client.health.mockImplementation(async () => {
      events.push('health')
      return {
        ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
        bootstrapped: true, bootstrap_required: false
      }
    })
    vi.mocked(test.settings.refreshToken).mockImplementation((profileId: string) => {
      events.push('refresh-token-read')
      return test.refreshTokens.get(profileId) ?? ''
    })
    test.client.refresh.mockResolvedValue(authBundle('refresh-rotated'))

    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'authenticated', transport: 'tailscale_serve', hubUrl: serve
    })
    expect(test.clientFactory).toHaveBeenLastCalledWith(serve)
    expect(events.indexOf('health')).toBeLessThan(events.indexOf('refresh-token-read'))
    expect(test.bindings.get('atlas')?.hubUrl).toBe(serve)

    const clientCalls = test.clientFactory.mock.calls.length
    events.length = 0
    await expect(test.service.connect({ transport: 'direct_ip' } as never)).rejects.toThrow(/have been removed/i)
    expect(test.clientFactory).toHaveBeenCalledTimes(clientCalls)
    expect(events).toEqual([])

    events.length = 0
    await expect(test.service.connect({ transport: 'tailscale_serve' })).resolves.toMatchObject({
      connectionState: 'authenticated', transport: 'tailscale_serve', hubUrl: serve
    })
    expect(test.clientFactory).toHaveBeenLastCalledWith(serve)
    expect(events[0]).toBe('health')
    expect(events.slice(1)).toEqual(['refresh-token-read', 'refresh-token-read'])
    expect(test.refreshTokens.get('atlas')).toBe('refresh-rotated')
  })

  it('never downgrades a saved Serve credential when Automatic discovers only legacy Direct IP', async () => {
    const test = harness()
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    const events: string[] = []
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'direct_ip', hubUrl: direct,
      routes: [{ transport: 'direct_ip', hubUrl: direct }]
    })
    test.bindings.set('atlas', {
      profileId: 'atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-stable-1',
      hubUrl: serve, hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('must-not-egress', 'atlas')
    test.client.health.mockImplementation(async () => {
      events.push('health')
      return {
        ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
        bootstrapped: true, bootstrap_required: false
      }
    })
    vi.mocked(test.settings.refreshToken).mockImplementation((profileId: string) => {
      events.push('refresh-token-read')
      return test.refreshTokens.get(profileId) ?? ''
    })
    test.client.refresh.mockImplementation(async token => {
      events.push(`refresh:${token}`)
      return authBundle('refresh-rotated')
    })

    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'offline', authenticated: false,
      error: expect.stringMatching(/have been removed/i)
    })
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.client.health).not.toHaveBeenCalled()
    expect(test.settings.activateVerifiedHub).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.bindings.get('atlas')?.hubUrl).toBe(serve)
    expect(test.refreshTokens.get('atlas')).toBe('must-not-egress')

    await expect(test.service.connect({ transport: 'direct_ip' } as never)).rejects.toThrow(/have been removed/i)
    expect(events).toEqual([])
    expect(test.bindings.get('atlas')?.hubUrl).toBe(serve)
  })

  it('refuses a fresh Direct-IP-only Teamspace without probing it', async () => {
    const test = harness()
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'direct_ip', hubUrl: direct,
      routes: [{ transport: 'direct_ip', hubUrl: direct }]
    })

    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'offline', authenticated: false,
      error: expect.stringMatching(/have been removed/i)
    })
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.client.health).not.toHaveBeenCalled()
    expect(test.settings.activateVerifiedHub).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()

    await expect(test.service.connect({ transport: 'direct_ip' } as never)).rejects.toThrow(/have been removed/i)
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.client.health).not.toHaveBeenCalled()
  })

  it('rejects a forged Direct route choice before discovery or reading a saved credential', async () => {
    const test = harness()
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'tailscale_serve', hubUrl: serve,
      routes: [
        { transport: 'tailscale_serve', hubUrl: serve },
        { transport: 'direct_ip', hubUrl: direct }
      ]
    })
    test.bindings.set('atlas', {
      profileId: 'atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-stable-1',
      hubUrl: serve, hubIdentity: 'hub-stable-1'
    })
    test.setRefreshToken('must-not-egress', 'atlas')
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'foreign-hub', instance_id: 'foreign-instance',
      bootstrapped: true, bootstrap_required: false
    })

    test.discovery.discover.mockClear()
    await expect(test.service.connect({ transport: 'direct_ip' } as never)).rejects.toThrow(/have been removed/i)
    expect(test.discovery.discover).not.toHaveBeenCalled()
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.settings.refreshToken).not.toHaveBeenCalled()
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.bindings.get('atlas')?.hubUrl).toBe(serve)
    expect(test.refreshTokens.get('atlas')).toBe('must-not-egress')
  })

  it('uses a safe Serve secondary when a legacy Direct route is advertised as primary', async () => {
    const test = harness()
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'direct_ip', hubUrl: direct,
      routes: [
        { transport: 'direct_ip', hubUrl: direct },
        { transport: 'tailscale_serve', hubUrl: serve },
      ]
    })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false
    })
    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'signed-out', transport: 'tailscale_serve', hubUrl: serve
    })
    expect(test.clientFactory).toHaveBeenCalledWith(serve)
    expect(test.clientFactory).not.toHaveBeenCalledWith(direct)
  })

  it('discards a remote proof if the advertised Hub changes while the parent grant is in flight', async () => {
    const test = harness()
    const hubUrl = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const grant = deferred<{ requestId: string; proof: string }>()
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({ transport: 'tailscale_serve', hubUrl })
    test.discovery.requestBootstrapProof.mockReturnValue(grant.promise)
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true
    })
    await test.service.connect()
    const starting = test.service.bootstrap({ email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop' })
    await vi.waitFor(() => expect(test.discovery.requestBootstrapProof).toHaveBeenCalled())

    test.setDiscovery({ hubIdentity: 'hub-replacement', hubUrl: 'https://other.my-tailnet.ts.net:8444/api/team-hub' })
    grant.resolve({
      requestId: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      proof: `bootstrap_remote.${'b'.repeat(43)}`
    })

    await expect(starting).rejects.toThrow('connection changed')
    expect(test.client.bootstrap).not.toHaveBeenCalled()
    expect(test.settings.storeRefreshToken).not.toHaveBeenCalled()
  })

  it('discards an old-Hub auth bundle if the exact Serve capability changes during redemption', async () => {
    const test = harness()
    const hubUrl = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const redemption = deferred<TeamHubAuthBundle>()
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({ transport: 'tailscale_serve', hubUrl })
    test.discovery.requestBootstrapProof.mockResolvedValue({
      requestId: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98', proof: `bootstrap_remote.${'c'.repeat(43)}`
    })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: false, bootstrap_required: true
    })
    test.client.bootstrap.mockReturnValue(redemption.promise)
    await test.service.connect()
    const starting = test.service.bootstrap({ email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop' })
    await vi.waitFor(() => expect(test.client.bootstrap).toHaveBeenCalled())

    test.setDiscovery({ transport: 'loopback', hubUrl: null })
    redemption.resolve(authBundle())

    await expect(starting).rejects.toThrow('connection changed')
    expect(test.settings.storeRefreshToken).not.toHaveBeenCalled()
    expect(test.service.status()).toMatchObject({ authenticated: false })
  })

  it('blocks remote Teamspace before constructing a Hub client or reading a proof', async () => {
    const test = harness()
    test.setServerScope({
      profileId: 'server-profile-1', profileGeneration: 2, serverIdentity: 'server-stable-1',
      serverUrl: 'https://dock.example.test', serverName: 'Remote server'
    })
    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'offline', authenticated: false })

    await expect(test.service.bootstrap({ email: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop' }))
      .rejects.toThrow()
    expect(test.clientFactory).not.toHaveBeenCalled()
    expect(test.secretFiles.readBootstrapProof).not.toHaveBeenCalled()
    expect(test.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(test.client.bootstrap).not.toHaveBeenCalled()
  })

  it('recovers a signed-out device through the mounted Hub without exposing its proof', async () => {
    const test = harness()
    test.client.recoverDevice.mockResolvedValue(authBundle())
    await test.service.connect()
    const recovered = await test.service.recoverDevice({ deviceLabel: 'This Mac' })
    expect(test.client.recoverDevice).toHaveBeenCalledWith('proof-secret', { device_label: 'This Mac' })
    expect(recovered.status.authenticated).toBe(true)
    expect(JSON.stringify(recovered)).not.toContain('proof-secret')
  })

  it('never reads a device recovery proof for a legacy Direct-only route', async () => {
    const test = harness()
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    test.setServerScope({
      profileId: 'atlas', profileGeneration: 5, serverIdentity: 'server-stable-1',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    })
    test.setDiscovery({
      transport: 'direct_ip', hubUrl: direct,
      routes: [{ transport: 'direct_ip', hubUrl: direct }]
    })
    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'offline', authenticated: false })
    await expect(test.service.recoverDevice({ deviceLabel: 'This Mac' })).rejects.toThrow()
    expect(test.secretFiles.readSecret).not.toHaveBeenCalled()
    expect(test.client.recoverDevice).not.toHaveBeenCalled()
  })

  it('invalidates access on active profile switch and restores each profile’s independently stored refresh', async () => {
    const test = harness()
    test.setRefreshToken('refresh-one')
    test.client.refresh.mockResolvedValue(authBundle('refresh-one-rotated'))
    const first = await test.service.connect()
    const oldScope = scopeFrom(first)
    test.setServerScope({
      profileId: 'server-profile-2', profileGeneration: 2, serverIdentity: 'server-stable-2',
      serverUrl: 'http://127.0.0.1:7852', serverName: 'Server two'
    })
    test.setDiscovery({ hubIdentity: 'hub-stable-2', hostServerIdentity: 'server-stable-2' })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-2', instance_id: 'instance-2',
      bootstrapped: true, bootstrap_required: false
    })

    expect(test.service.status()).toMatchObject({ profileId: 'server-profile-2', authenticated: false, connectionState: 'disconnected' })
    await expect(test.service.workspace(oldScope)).rejects.toThrow('connection changed')
    await expect(test.service.connect()).resolves.toMatchObject({ profileId: 'server-profile-2', connectionState: 'signed-out' })
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-one-rotated')
  })

  it('settles an overlapping connect refresh before replacing its client or rotating the new token', async () => {
    const test = harness()
    const firstRefresh = deferred<TeamHubAuthBundle>()
    test.setRefreshToken('refresh-one')
    test.client.refresh
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(authBundle('refresh-three'))

    const firstConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.refresh).toHaveBeenCalledWith('refresh-one'))
    const secondConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.health).toHaveBeenCalledTimes(2))

    expect(test.client.refresh).toHaveBeenCalledTimes(1)
    expect(test.client.dispose).not.toHaveBeenCalled()

    firstRefresh.resolve(authBundle('refresh-two'))
    await firstConnect
    await expect(secondConnect).resolves.toMatchObject({ authenticated: true })

    expect(test.client.refresh.mock.calls.map(([token]) => token)).toEqual([
      'refresh-one',
      'refresh-two'
    ])
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-three')
    expect(test.client.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not replay a captured refresh token when an overlapping connect sees an ambiguous failure', async () => {
    const test = harness()
    const firstRefresh = deferred<TeamHubAuthBundle>()
    test.setRefreshToken('refresh-one')
    test.client.refresh.mockReturnValueOnce(firstRefresh.promise)

    const firstConnect = test.service.connect().catch(error => error)
    await vi.waitFor(() => expect(test.client.refresh).toHaveBeenCalledWith('refresh-one'))
    const secondConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.health).toHaveBeenCalledTimes(2))
    firstRefresh.reject(new Error('refresh response was lost'))

    await expect(firstConnect).resolves.toBeInstanceOf(Error)
    await expect(secondConnect).resolves.toMatchObject({ authenticated: false, connectionState: 'offline' })
    expect(test.client.refresh.mock.calls.map(([token]) => token)).toEqual(['refresh-one'])
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-one')
  })

  it('lets an overlapping connect observe a captured terminal refresh as signed-out without replay', async () => {
    const test = harness()
    const firstRefresh = deferred<TeamHubAuthBundle>()
    test.setRefreshToken('refresh-one')
    test.client.refresh.mockReturnValueOnce(firstRefresh.promise)

    const firstConnect = test.service.connect().catch(error => error)
    await vi.waitFor(() => expect(test.client.refresh).toHaveBeenCalledWith('refresh-one'))
    const secondConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.health).toHaveBeenCalledTimes(2))
    firstRefresh.reject(new TeamHubClientError(401, 'authentication_required', 'session expired'))

    await expect(firstConnect).resolves.toBeInstanceOf(Error)
    await expect(secondConnect).resolves.toMatchObject({ authenticated: false, connectionState: 'signed-out' })
    expect(test.client.refresh.mock.calls.map(([token]) => token)).toEqual(['refresh-one'])
    expect(test.settings.clearRefreshToken).toHaveBeenCalledTimes(1)
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
  })

  it('waits again when a new human-token rotation starts while an overlapping connect is settling', async () => {
    const test = harness()
    const firstRefresh = deferred<TeamHubAuthBundle>()
    const secondRefresh = deferred<TeamHubAuthBundle>()
    const laterBundle = (refreshToken: string): TeamHubAuthBundle => ({
      ...authBundle(refreshToken),
      access_expires_at: '2026-08-21T13:00:00.000Z'
    })
    test.setRefreshToken('refresh-one')
    test.client.refresh
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise)
      .mockResolvedValueOnce(laterBundle('refresh-four'))

    const firstConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.refresh).toHaveBeenCalledWith('refresh-one'))
    const internal = test.service as unknown as {
      refreshInFlight: { generation: number; promise: Promise<void> } | null
    }
    const captured = internal.refreshInFlight
    expect(captured).not.toBeNull()
    const operationScope = scopeFrom(test.service.status())
    let secondRotationOperation: Promise<unknown> | null = null
    const startSecondRotation = captured!.promise.then(() => {
      test.advanceTime(2 * 60 * 60 * 1_000)
      secondRotationOperation = test.service.workspace(operationScope)
    })
    const secondConnect = test.service.connect()
    await vi.waitFor(() => expect(test.client.health).toHaveBeenCalledTimes(2))

    firstRefresh.resolve(authBundle('refresh-two'))
    await startSecondRotation
    await vi.waitFor(() => expect(test.client.refresh).toHaveBeenCalledTimes(2))
    expect(test.client.refresh.mock.calls.map(([token]) => token)).toEqual([
      'refresh-one',
      'refresh-two'
    ])
    expect(test.client.dispose).not.toHaveBeenCalled()

    secondRefresh.resolve(laterBundle('refresh-three'))
    await expect(secondRotationOperation).rejects.toThrow('connection changed')
    await firstConnect
    await expect(secondConnect).resolves.toMatchObject({ authenticated: true })

    expect(test.client.refresh.mock.calls.map(([token]) => token)).toEqual([
      'refresh-one',
      'refresh-two',
      'refresh-three'
    ])
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-four')
  })

  it.each([
    {
      label: 'a replacement Hub identity',
      discovery: { hubIdentity: 'hub-replacement' },
      state: 'offline'
    },
    {
      label: 'the mounted capability becoming unavailable',
      discovery: {
        available: false,
        designatedHost: true,
        basePath: '/api/team-hub',
        hubIdentity: null,
        message: 'Team Hub failed to start.',
        action: 'Restart the designated host.'
      },
      state: 'unavailable'
    }
  ])('blocks every Hub request when current AgentsServer health advertises $label', async ({ discovery, state }) => {
    const test = harness()
    test.setRefreshToken('preserve-this-refresh')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.team.mockClear()
    test.client.members.mockClear()
    test.client.nodes.mockClear()
    test.client.channels.mockClear()
    test.client.refresh.mockClear()

    test.setDiscovery(discovery)

    await expect(test.service.teamDetails(scopeFrom(connected), 'team-1')).rejects.toThrow('connection changed')
    expect(test.client.team).not.toHaveBeenCalled()
    expect(test.client.members).not.toHaveBeenCalled()
    expect(test.client.nodes).not.toHaveBeenCalled()
    expect(test.client.channels).not.toHaveBeenCalled()
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.service.status()).toMatchObject({ connectionState: state, authenticated: false })
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.refreshTokens.get('server-profile-1')).toBe('refresh-new')
  })

  it('drops stale discovery before constructing a Hub client after a profile switch', async () => {
    const test = harness()
    let resolveDiscovery!: (value: TeamHubDiscovery) => void
    test.discovery.discover.mockImplementationOnce(() => new Promise(resolve => { resolveDiscovery = resolve }))
    const connecting = test.service.connect()
    await Promise.resolve()
    test.setServerScope({
      profileId: 'server-profile-2', profileGeneration: 2, serverIdentity: 'server-stable-2',
      serverUrl: 'http://127.0.0.1:7852', serverName: 'Server two'
    })
    test.service.status()
    resolveDiscovery({
      available: true, designatedHost: true, version: 1, basePath: '/api/team-hub', hubIdentity: 'hub-stable-1',
      transport: 'loopback', hubUrl: null,
      hostServerIdentity: 'server-stable-1', message: 'ready', action: null
    })

    await expect(connecting).rejects.toThrow('connection changed')
    expect(test.clientFactory).not.toHaveBeenCalled()
  })

  it('rejects advertised/health Hub identity mismatch before reading or sending a refresh credential', async () => {
    const test = harness()
    test.setRefreshToken('must-not-egress')
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'foreign-hub', instance_id: 'foreign-instance',
      bootstrapped: true, bootstrap_required: false
    })

    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'offline', authenticated: false })
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.settings.storeRefreshToken).not.toHaveBeenCalled()
    expect(test.refreshTokens.get('server-profile-1')).toBe('must-not-egress')
  })

  it('preserves a pinned same-profile Hub credential when discovery and health agree on a replacement identity', async () => {
    const test = harness()
    const pinned: TeamHubVerifiedBinding = {
      profileId: 'server-profile-1', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub', hubIdentity: 'hub-original'
    }
    test.bindings.set(pinned.profileId, pinned)
    test.refreshTokens.set(pinned.profileId, 'preserved-refresh')
    test.setDiscovery({ hubIdentity: 'hub-replacement' })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-replacement', instance_id: 'replacement',
      bootstrapped: true, bootstrap_required: false
    })

    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'offline', authenticated: false })
    expect(test.client.refresh).not.toHaveBeenCalled()
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
    expect(test.refreshTokens.get(pinned.profileId)).toBe('preserved-refresh')
  })

  it('signs out without adopting access when rotated-token persistence fails', async () => {
    const test = harness({ storeRefreshToken: vi.fn(() => { throw new Error('keychain full') }) })
    test.setRefreshToken('consumed-old-refresh')
    test.client.refresh.mockResolvedValue(authBundle('replacement-refresh'))

    await expect(test.service.connect()).resolves.toMatchObject({ connectionState: 'signed-out', authenticated: false })
    expect(test.client.refresh).toHaveBeenCalledTimes(1)
    expect(test.settings.clearRefreshToken).toHaveBeenCalled()
  })

  it('keeps invitation tokens in the main-process file handoff and skips creation when save is cancelled', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.createInvitation.mockResolvedValue({
      invitation: { id: 'invite-1', team_id: 'team-1', invitee_email: 'member@example.test', role: 'member', expires_at: '2026-08-20T12:15:00Z' },
      token: 'invite-super-secret'
    })
    const receipt = await test.service.createInvitation(scopeFrom(connected), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })
    expect(test.secretFiles.writeSecret).toHaveBeenCalledWith('/private/secret.txt', 'invite-super-secret')
    expect(JSON.stringify(receipt)).not.toContain('invite-super-secret')

    test.secretFiles.nextPath = null
    await expect(test.service.createInvitation(scopeFrom(test.service.status()), {
      teamId: 'team-1', inviteeEmail: 'second@example.test', role: 'guest'
    })).resolves.toMatchObject({ saved: false })
    expect(test.client.createInvitation).toHaveBeenCalledTimes(1)
  })

  it('does not open a secret save dialog for principals that cannot issue grants', async () => {
    for (const role of ['member', 'guest'] as const) {
      const limited = harness()
      limited.setRefreshToken(`${role}-refresh`)
      limited.client.refresh.mockResolvedValue({
        ...authBundle(),
        teams: [{ ...authBundle().teams[0], role }]
      })
      const limitedStatus = await limited.service.connect()
      await expect(limited.service.createInvitation(scopeFrom(limitedStatus), {
        teamId: 'team-1', inviteeEmail: 'invitee@example.test', role: 'guest'
      })).rejects.toThrow(/owner or admin/i)
      await expect(limited.service.createNodeEnrollment(scopeFrom(limitedStatus), {
        teamId: 'team-1', serverIdentity: 'server-2', displayName: 'Studio', publicKey: ED25519_PUBLIC_KEY
      })).rejects.toThrow(/owner or admin/i)
      expect(limited.secretFiles.chooseSavePath).not.toHaveBeenCalled()
    }

    const peer = harness()
    await connectTransientPeer(peer)
    await expect(peer.service.createInvitation(scopeFrom(peer.service.status()), {
      teamId: 'team-1', inviteeEmail: 'invitee@example.test', role: 'member'
    })).rejects.toThrow(/signed-in person/i)
    await expect(peer.service.createNodeEnrollment(scopeFrom(peer.service.status()), {
      teamId: 'team-1', serverIdentity: 'server-2', displayName: 'Studio', publicKey: ED25519_PUBLIC_KEY
    })).rejects.toThrow(/signed-in person/i)
    expect(peer.secretFiles.chooseSavePath).not.toHaveBeenCalled()

  })

  it('allows only the exact managed host session to create a person invitation', async () => {
    const managed = harness()
    managed.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    managed.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true
    })
    managed.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    managed.client.createInvitation.mockResolvedValue({
      invitation: {
        id: 'invite-managed', team_id: 'team-1', invitee_email: 'invitee@example.test',
        role: 'member', expires_at: '2026-08-20T12:15:00Z'
      },
      token: 'managed-invite-secret'
    })
    const managedStatus = await managed.service.connect()

    await expect(managed.service.createInvitation(scopeFrom(managedStatus), {
      teamId: 'team-1', inviteeEmail: 'invitee@example.test', role: 'member'
    })).resolves.toMatchObject({ saved: true, id: 'invite-managed' })
    expect(managed.client.createInvitation).toHaveBeenCalledWith('', 'team-1', {
      invitee_email: 'invitee@example.test', role: 'member'
    })
    expect(managed.secretFiles.writeSecret).toHaveBeenCalledWith(
      '/private/secret.txt',
      'managed-invite-secret'
    )

    await expect(managed.service.createNodeEnrollment(scopeFrom(managed.service.status()), {
      teamId: 'team-1', serverIdentity: 'server-2', displayName: 'Studio', publicKey: ED25519_PUBLIC_KEY
    })).rejects.toThrow(/signed-in person/i)
  })

  it('writes one-time secrets only after exact invitation and enrollment receipts', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const invitation = {
      id: 'invite-1', team_id: 'team-1', invitee_email: 'member@example.test',
      role: 'member', expires_at: '2026-08-20T12:15:00Z'
    }
    for (const mismatched of [
      { ...invitation, team_id: 'team-2' },
      { ...invitation, invitee_email: 'other@example.test' },
      { ...invitation, role: 'guest' }
    ]) {
      test.client.createInvitation.mockResolvedValueOnce({ invitation: mismatched, token: 'invite-secret' })
      await expect(test.service.createInvitation(scope, {
        teamId: 'team-1', inviteeEmail: 'Member@Example.Test', role: 'member'
      })).rejects.toThrow(/mismatched invitation receipt/i)
    }
    expect(test.secretFiles.writeSecret).not.toHaveBeenCalled()

    const enrollment = {
      id: 'grant-1', team_id: 'team-1', server_identity: 'server-2', display_name: 'Studio',
      public_key_fingerprint: ED25519_PUBLIC_KEY_FINGERPRINT,
      expires_at: '2026-08-20T12:15:00Z'
    }
    for (const mismatched of [
      { ...enrollment, team_id: 'team-2' },
      { ...enrollment, server_identity: 'server-3' },
      { ...enrollment, display_name: 'Other studio' },
      { ...enrollment, public_key_fingerprint: '0'.repeat(64) }
    ]) {
      test.client.createNodeEnrollment.mockResolvedValueOnce({ enrollment: mismatched, token: 'grant-secret' })
      await expect(test.service.createNodeEnrollment(scope, {
        teamId: 'team-1', serverIdentity: 'server-2', displayName: 'Studio', publicKey: ED25519_PUBLIC_KEY
      })).rejects.toThrow(/mismatched node enrollment receipt/i)
    }
    expect(test.secretFiles.writeSecret).not.toHaveBeenCalled()

    test.client.createNodeEnrollment.mockResolvedValueOnce({ enrollment, token: 'grant-secret' })
    await expect(test.service.createNodeEnrollment(scope, {
      teamId: 'team-1', serverIdentity: 'server-2', displayName: 'Studio', publicKey: `${ED25519_PUBLIC_KEY} studio`
    })).resolves.toMatchObject({ saved: true, id: 'grant-1' })
    expect(test.secretFiles.writeSecret).toHaveBeenCalledWith('/private/secret.txt', 'grant-secret')
  })

  it('refreshes but never replays a non-idempotent invitation mutation after a 401', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValueOnce(authBundle('refresh-connected'))
    const connected = await test.service.connect()
    test.client.createInvitation.mockRejectedValueOnce(new TeamHubClientError(401, 'authentication_required', 'expired'))
    test.client.refresh.mockResolvedValueOnce({
      ...authBundle('refresh-rotated'),
      access_token: 'access-refreshed'
    })

    await expect(test.service.createInvitation(scopeFrom(connected), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })).rejects.toThrow(/session was refreshed.*retry/i)
    expect(test.client.createInvitation).toHaveBeenCalledTimes(1)
    expect(test.client.refresh).toHaveBeenCalledTimes(2)

    test.client.createInvitation.mockResolvedValueOnce({
      invitation: { id: 'invite-2', team_id: 'team-1', invitee_email: 'member@example.test', role: 'member', expires_at: '2026-08-20T12:15:00Z' },
      token: 'invite-super-secret'
    })
    await expect(test.service.createInvitation(scopeFrom(test.service.status()), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })).resolves.toMatchObject({ saved: true, id: 'invite-2' })
    expect(test.client.createInvitation.mock.calls[1][0]).toBe('access-refreshed')
  })

  it('treats a 401 on the explicit retry token as terminal instead of rotating forever', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValueOnce(authBundle('refresh-connected'))
    const connected = await test.service.connect()
    test.client.createInvitation.mockRejectedValue(new TeamHubClientError(401, 'authentication_required', 'expired'))
    test.client.refresh.mockResolvedValueOnce({
      ...authBundle('refresh-explicit-retry'),
      access_token: 'access-explicit-retry'
    })

    await expect(test.service.createInvitation(scopeFrom(connected), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })).rejects.toThrow(/session was refreshed.*retry/i)
    await expect(test.service.createInvitation(scopeFrom(test.service.status()), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })).rejects.toThrow(/session expired.*recover this device/i)

    expect(test.client.createInvitation).toHaveBeenCalledTimes(2)
    expect(test.client.createInvitation.mock.calls[1][0]).toBe('access-explicit-retry')
    expect(test.client.refresh).toHaveBeenCalledTimes(2)
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
    expect(test.service.status()).toMatchObject({ connectionState: 'signed-out', authenticated: false })
  })

  it('signs out when the one refresh after a non-idempotent 401 is itself unauthorized', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValueOnce(authBundle('refresh-connected'))
    const connected = await test.service.connect()
    test.client.createInvitation.mockRejectedValueOnce(new TeamHubClientError(401, 'authentication_required', 'expired'))
    test.client.refresh.mockRejectedValueOnce(new TeamHubClientError(401, 'authentication_required', 'expired'))

    await expect(test.service.createInvitation(scopeFrom(connected), {
      teamId: 'team-1', inviteeEmail: 'member@example.test', role: 'member'
    })).rejects.toThrow(/session expired.*recover this device/i)
    expect(test.client.createInvitation).toHaveBeenCalledOnce()
    expect(test.service.status()).toMatchObject({ connectionState: 'signed-out', authenticated: false })
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
  })

  it('durably signs out a human session when a refreshed read is still unauthorized', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh
      .mockResolvedValueOnce(authBundle('refresh-connected'))
      .mockResolvedValueOnce({
        ...authBundle('refresh-rotated'),
        access_token: 'access-refreshed'
      })
    const connected = await test.service.connect()
    test.client.teams.mockRejectedValue(new TeamHubClientError(401, 'authentication_required', 'expired'))

    await expect(test.service.workspace(scopeFrom(connected)))
      .rejects.toThrow(/session expired.*recover this device/i)

    expect(test.client.teams).toHaveBeenCalledTimes(2)
    expect(test.client.teams.mock.calls[1][0]).toBe('access-refreshed')
    expect(test.settings.clearRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'server-profile-1', hubIdentity: 'hub-stable-1'
    }))
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
    expect(test.service.status()).toMatchObject({
      connectionState: 'signed-out', authenticated: false, principal: null, session: null
    })
  })

  it('keeps a rejected refresh credential tombstoned when secure-storage deletion fails', async () => {
    const clearRefreshToken = vi.fn(() => { throw new Error('Keychain locked') })
    const test = harness({ clearRefreshToken })
    test.setRefreshToken('refresh-old')
    test.client.refresh
      .mockResolvedValueOnce(authBundle('refresh-connected'))
      .mockResolvedValueOnce({ ...authBundle('refresh-rotated'), access_token: 'access-rotated' })
    const connected = await test.service.connect()
    test.client.teams.mockRejectedValue(new TeamHubClientError(401, 'authentication_required', 'expired'))

    await expect(test.service.workspace(scopeFrom(connected)))
      .rejects.toThrow(/session expired.*secure storage/i)
    expect(test.service.status()).toMatchObject({
      connectionState: 'signed-out', authenticated: false,
      error: expect.stringMatching(/will not reuse it in this process/i)
    })

    const refreshCalls = test.client.refresh.mock.calls.length
    const teamCalls = test.client.teams.mock.calls.length
    await expect(test.service.workspace(scopeFrom(test.service.status())))
      .rejects.toThrow(/already have been consumed.*cannot be reused/i)
    expect(test.client.refresh).toHaveBeenCalledTimes(refreshCalls)
    expect(test.client.teams).toHaveBeenCalledTimes(teamCalls)
    expect(clearRefreshToken).toHaveBeenCalledOnce()
  })

  it('retires a peer-authenticated runtime when refresh or replay authentication fails', async () => {
    const test = harness()
    const { peerBehavior } = await connectTransientPeer(test)
    const connected = test.service.status()
    peerBehavior.dataError = 'authentication_required'

    await expect(test.service.workspace(scopeFrom(connected)))
      .rejects.toThrow(/authentication expired.*reconnect/i)
    expect(test.service.status()).toMatchObject({
      connectionState: 'offline', authenticated: false, principal: null, session: null
    })

    peerBehavior.dataError = null
    await expect(test.service.connect()).resolves.toMatchObject({
      connectionState: 'authenticated', authenticationMode: 'paired_node'
    })
    const reconnected = test.service.status()
    peerBehavior.dataError = 'authentication_required'
    peerBehavior.peerSessionPrincipalKind = 'human'

    await expect(test.service.workspace(scopeFrom(reconnected)))
      .rejects.toThrow(/server principal/i)
    expect(test.service.status()).toMatchObject({ connectionState: 'offline', authenticated: false })
  })

  it('retires a server-authenticated runtime when the refreshed read remains unauthorized', async () => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true,
      capabilities: { team_network_v1: teamNetworkCapability() }
    })
    test.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    const connected = await test.service.connect()
    test.client.teams.mockRejectedValue(new TeamHubClientError(401, 'authentication_required', 'expired'))

    await expect(test.service.workspace(scopeFrom(connected)))
      .rejects.toThrow(/authentication expired.*reconnect/i)
    expect(test.client.serverSession).toHaveBeenCalledTimes(2)
    expect(test.service.status()).toMatchObject({
      connectionState: 'offline', authenticated: false, principal: null, session: null
    })
  })

  it('keeps paginated team details valid when the caller and channel participants are on later member pages', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.members.mockResolvedValue({
      members: [{
        principal_id: 'person-page-1', email: 'first@example.test', display_name: 'First',
        role: 'member', status: 'active'
      }],
      has_more: true,
      next_cursor: 'members-next'
    })
    test.client.channels.mockResolvedValue({ channels: [{
      id: 'direct-1', team_id: 'team-1', kind: 'direct', visibility: 'private',
      slug: null, display_name: null, created_by_principal_id: 'principal-1',
      created_at: '2026-08-20T12:00:00Z', updated_at: '2026-08-20T12:00:00Z',
      archived_at: null, participants: ['principal-1', 'person-page-2'],
      permissions: { read: true, post: true, manage: false, dispatch: false }
    }] })

    await expect(test.service.teamDetails(scopeFrom(connected), 'team-1')).resolves.toMatchObject({
      membership: { principal_id: 'principal-1', role: 'owner', status: 'active' },
      membersHasMore: true,
      membersNextCursor: 'members-next'
    })
  })

  it('exposes bounded human device, invitation, and member administration with exact receipts', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    test.client.deviceSessions.mockResolvedValue({
      sessions: [{
        id: 'session-2', device_label: 'Laptop', created_at: '2026-08-01T00:00:00Z',
        last_seen_at: '2026-08-20T00:00:00Z', expires_at: '2026-09-20T00:00:00Z',
        revoked_at: null, current: false
      }],
      has_more: true, next_cursor: 'device-next'
    })
    test.client.revokeDeviceSession.mockResolvedValue({ revoked: true })
    test.client.invitations.mockResolvedValue({
      invitations: [{
        id: 'invite-2', invitee_email: 'invitee@example.test', role: 'member',
        issued_by_principal_id: 'principal-1', created_at: '2026-08-20T00:00:00Z',
        expires_at: '2026-08-21T00:00:00Z'
      }],
      has_more: false, next_cursor: null
    })
    test.client.revokeInvitation.mockResolvedValue({ revoked: true })
    test.client.members.mockResolvedValue({ members: [], has_more: false, next_cursor: null })
    test.client.updateMember.mockResolvedValue({ member: {
      principal_id: 'person-2', email: 'member@example.test', display_name: 'Member',
      role: 'admin', status: 'active'
    } })

    await expect(test.service.deviceSessions(scope)).resolves.toMatchObject({ has_more: true, next_cursor: 'device-next' })
    await expect(test.service.revokeDeviceSession(scope, 'session-2')).resolves.toEqual({ revoked: true })
    await expect(test.service.members(scope, 'team-1', 'members-next')).resolves.toMatchObject({ members: [] })
    await expect(test.service.invitations(scope, 'team-1')).resolves.toMatchObject({ invitations: [{ id: 'invite-2' }] })
    await expect(test.service.revokeInvitation(scope, 'team-1', 'invite-2')).resolves.toEqual({ revoked: true })
    await expect(test.service.updateMember(scope, {
      teamId: 'team-1', principalId: 'person-2', patch: { role: 'admin' }
    })).resolves.toMatchObject({ principal_id: 'person-2', role: 'admin', status: 'active' })

    expect(test.client.members).toHaveBeenCalledWith(expect.any(String), 'team-1', 'members-next')
    expect(test.client.updateMember).toHaveBeenCalledWith(expect.any(String), 'team-1', 'person-2', { role: 'admin' })
    await expect(test.service.revokeDeviceSession(scope, 'session-1')).rejects.toThrow(/sign out from this device/i)
    await expect(test.service.updateMember(scope, {
      teamId: 'team-1', principalId: 'principal-1', patch: { status: 'suspended' }
    })).rejects.toThrow(/current owner/i)
  })

  it('requires device-session current markers to match the authenticated session exactly', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const session = {
      id: 'session-1', device_label: 'Desktop', created_at: '2026-08-01T00:00:00Z',
      last_seen_at: '2026-08-20T00:00:00Z', expires_at: '2026-09-20T00:00:00Z',
      revoked_at: null, current: false
    }

    test.client.deviceSessions.mockResolvedValueOnce({
      sessions: [session], has_more: false, next_cursor: null
    })
    await expect(test.service.deviceSessions(scope)).rejects.toThrow(/mismatched device-session ownership/i)

    test.client.deviceSessions.mockResolvedValueOnce({
      sessions: [{ ...session, id: 'foreign-session', current: true }],
      has_more: false, next_cursor: null
    })
    await expect(test.service.deviceSessions(scope)).rejects.toThrow(/mismatched device-session ownership/i)

    test.client.deviceSessions.mockResolvedValueOnce({
      sessions: [{ ...session, current: true }, { ...session, current: true }],
      has_more: false, next_cursor: null
    })
    await expect(test.service.deviceSessions(scope)).rejects.toThrow(/mismatched device-session ownership/i)

    test.client.deviceSessions.mockResolvedValueOnce({
      sessions: [{ ...session, id: 'foreign-session' }],
      has_more: false, next_cursor: null
    })
    await expect(test.service.deviceSessions(scope)).rejects.toThrow(/mismatched device-session ownership/i)

    test.client.deviceSessions.mockResolvedValueOnce({
      sessions: [{ ...session, current: true }, { ...session, id: 'foreign-session' }],
      has_more: false, next_cursor: null
    })
    await expect(test.service.deviceSessions(scope)).resolves.toMatchObject({
      sessions: [{ id: 'session-1', current: true }, { id: 'foreign-session', current: false }]
    })
  })

  it('rejects mismatched member mutation postconditions and hides human administration from service sessions', async () => {
    const human = harness()
    human.setRefreshToken('refresh-old')
    human.client.refresh.mockResolvedValue(authBundle())
    const connected = await human.service.connect()
    const scope = scopeFrom(connected)
    human.client.updateMember.mockResolvedValueOnce({ member: {
      principal_id: 'person-2', email: null, display_name: 'Member', role: 'member', status: 'active'
    } }).mockResolvedValueOnce({ member: {
      principal_id: 'person-2', email: null, display_name: 'Member', role: 'member', status: 'active'
    } })

    await expect(human.service.updateMember(scope, {
      teamId: 'team-1', principalId: 'person-2', patch: { role: 'admin' }
    })).rejects.toThrow(/mismatched member receipt/i)
    await expect(human.service.updateMember(scope, {
      teamId: 'team-1', principalId: 'person-2', patch: { status: 'suspended' }
    })).rejects.toThrow(/mismatched member receipt/i)

    const server = harness()
    server.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    server.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true
    })
    server.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    const serverConnected = await server.service.connect()
    await expect(server.service.deviceSessions(scopeFrom(serverConnected))).rejects.toThrow(/signed-in person/i)
    expect(server.client.deviceSessions).not.toHaveBeenCalled()
  })

  it('does not request owner-only nodes for a member team', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.team.mockResolvedValue({ team: { ...authBundle().teams[0], role: 'member' } })
    test.client.members.mockResolvedValue({ members: [{
      principal_id: 'principal-1', email: null, display_name: 'Owner', role: 'member', status: 'active'
    }] })
    await expect(test.service.teamDetails(scopeFrom(connected), 'team-1')).resolves.toMatchObject({ nodes: [] })
    expect(test.client.nodes).not.toHaveBeenCalled()
  })

  it('never clears a new profile binding when an old logout finishes after a switch', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    let finishRevoke!: () => void
    test.client.revoke.mockImplementation(() => new Promise(resolve => { finishRevoke = () => resolve({ revoked: true }) }))
    const logout = test.service.logout(scopeFrom(connected))
    await Promise.resolve()
    test.setServerScope({
      profileId: 'server-profile-2', profileGeneration: 2, serverIdentity: 'server-stable-2',
      serverUrl: 'http://127.0.0.1:7852', serverName: 'Server two'
    })
    test.service.status()
    vi.mocked(test.settings.clearRefreshToken).mockClear()
    finishRevoke()
    await expect(logout).rejects.toThrow('connection changed')
    expect(test.settings.clearRefreshToken).not.toHaveBeenCalled()
  })

  it('forgets only the explicitly fenced current profile binding', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const forgotten = await test.service.forgetBinding({
      profileId: connected.profileId,
      profileGeneration: connected.profileGeneration,
      serverIdentity: connected.serverIdentity!,
      expectedGeneration: connected.generation,
      expectedHubIdentity: connected.savedHubIdentity!
    })
    expect(forgotten).toMatchObject({
      connectionState: 'disconnected',
      savedHubIdentity: null,
      canForgetBinding: false
    })
    expect(test.settings.forgetBinding).toHaveBeenCalledWith('server-profile-1')
  })

  it('keeps the exact binding authoritative when its attachment cache cannot be purged', async () => {
    const purgeProfile = vi.fn().mockRejectedValue(new Error('cache directory is locked'))
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    vi.mocked(test.settings.forgetBinding).mockClear()

    await expect(test.service.forgetBinding({
      profileId: connected.profileId,
      profileGeneration: connected.profileGeneration,
      serverIdentity: connected.serverIdentity!,
      expectedGeneration: connected.generation,
      expectedHubIdentity: connected.savedHubIdentity!
    })).rejects.toThrow('cache directory is locked')

    expect(purgeProfile).toHaveBeenCalledWith('server-profile-1')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.service.status()).toMatchObject({
      authenticated: true,
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: true
    })
  })

  it('removes Teamspace trust before purging the exact attachment-cache profile', async () => {
    const purgeProfile = vi.fn().mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)

    await test.service.removeServerProfile('server-profile-unused')

    expect(purgeProfile).toHaveBeenCalledWith('server-profile-unused')
    expect(test.settings.removeServerProfile).toHaveBeenCalledWith('server-profile-unused')
    expect(vi.mocked(test.settings.removeServerProfile).mock.invocationCallOrder[0]).toBeLessThan(
      purgeProfile.mock.invocationCallOrder[0]
    )
  })

  it('does not restore removed Teamspace trust when post-commit cache purge fails', async () => {
    const purgeProfile = vi.fn().mockRejectedValue(new Error('cache directory is locked'))
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    await test.service.connect()

    const result = await test.service.removeServerProfile('server-profile-1')

    expect(result).toMatchObject({
      removed: true,
      cleanupWarning: expect.stringMatching(/cache directory is locked/i)
    })
    expect(test.bindings.has('server-profile-1')).toBe(false)
    expect(test.refreshTokens.has('server-profile-1')).toBe(false)
    expect(result.rollback).not.toHaveBeenCalled()
  })

  it('reports a failed remote revoke as a local disconnect while preserving the saved binding', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.revoke.mockRejectedValue(new TeamHubClientError(503, 'unavailable', 'offline'))

    const disconnected = await test.service.disconnect(scopeFrom(connected))
    expect(disconnected).toMatchObject({
      authenticated: false,
      connectionState: 'disconnected',
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: true,
      error: 'Disconnected and signed out locally, but the remote session could not be revoked and will expire automatically.'
    })
    expect(test.bindings.get('server-profile-1')?.hubIdentity).toBe('hub-stable-1')
  })

  it('keeps passive reconnect disabled after Disconnect until a user reconnects and does not arm a fresh unbound profile', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    expect(connected.backgroundReconnectAllowed).toBe(true)

    const disconnected = await test.service.disconnect(scopeFrom(connected))
    expect(disconnected).toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    test.discovery.discover.mockClear()

    await expect(test.service.connect(backgroundReconnectFrom(disconnected))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    expect(test.discovery.discover).not.toHaveBeenCalled()

    const userReconnect = await test.service.connect()
    expect(userReconnect).toMatchObject({
      connectionState: 'signed-out',
      backgroundReconnectAllowed: true
    })
    expect(await test.service.forgetBinding({
      profileId: userReconnect.profileId,
      profileGeneration: userReconnect.profileGeneration,
      serverIdentity: userReconnect.serverIdentity!,
      expectedGeneration: userReconnect.generation,
      expectedHubIdentity: userReconnect.savedHubIdentity!
    })).toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })

    test.setServerScope({
      profileId: 'server-profile-2', profileGeneration: 2, serverIdentity: 'server-stable-2',
      serverUrl: 'http://127.0.0.1:7852', serverName: 'Server two'
    })
    expect(test.service.status()).toMatchObject({
      profileId: 'server-profile-2',
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
  })

  it('keeps an explicit Disconnect suppressed in-process when its reconnect preference cannot persist', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    vi.mocked(test.settings.setBackgroundReconnectAllowed).mockImplementation(() => {
      throw new Error('settings volume is read-only')
    })

    const disconnected = await test.service.disconnect(scopeFrom(connected))
    expect(disconnected).toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false,
      error: expect.stringContaining('reconnect preference could not be saved')
    })
    expect(test.service.status().backgroundReconnectAllowed).toBe(false)
    test.discovery.discover.mockClear()

    await expect(test.service.connect(backgroundReconnectFrom(disconnected))).resolves.toMatchObject({
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    })
    expect(test.discovery.discover).not.toHaveBeenCalled()
  })

  it.each(['backgroundReconnect', 'surfaceReconnect'] as const)(
    'rejects a stale %s scope before discovery or permission consumption',
    async (mode) => {
      const test = harness()
      test.bindings.set('server-profile-1', {
        profileId: 'server-profile-1',
        serverUrl: 'http://127.0.0.1:7850',
        serverIdentity: 'server-stable-1',
        hubUrl: 'http://127.0.0.1:7850/api/team-hub',
        hubIdentity: 'hub-stable-1'
      })
      const coldStatus = test.service.status()
      expect(coldStatus.backgroundReconnectAllowed).toBe(true)
      test.discovery.discover.mockClear()

      const staleScope = {
        ...backgroundReconnectFrom(coldStatus).backgroundReconnect,
        generation: coldStatus.generation + 1
      }
      const input = mode === 'backgroundReconnect'
        ? { backgroundReconnect: staleScope }
        : { surfaceReconnect: staleScope }
      await expect(test.service.connect(input)).rejects.toThrow('connection changed')
      expect(test.discovery.discover).not.toHaveBeenCalled()
      expect(test.settings.setProfileBackgroundReconnectAllowed).not.toHaveBeenCalled()
      expect(test.settings.setBackgroundReconnectAllowed).not.toHaveBeenCalled()
      expect(test.service.status().backgroundReconnectAllowed).toBe(true)
    }
  )

  it('rejects ambiguous or undefined scoped reconnect modes before discovery or rearming', async () => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    const cold = test.service.status()
    const scope = backgroundReconnectFrom(cold).backgroundReconnect
    test.discovery.discover.mockClear()

    await expect(test.service.connect({
      backgroundReconnect: scope,
      surfaceReconnect: scope
    })).rejects.toThrow('reconnect mode is invalid')
    await expect(test.service.connect({ surfaceReconnect: undefined })).rejects.toThrow(
      'Surface Teamspace reconnect scope is invalid'
    )
    expect(test.discovery.discover).not.toHaveBeenCalled()
    expect(test.settings.setProfileBackgroundReconnectAllowed).not.toHaveBeenCalled()
    expect(test.settings.setBackgroundReconnectAllowed).not.toHaveBeenCalled()
  })

  it('keeps an offline saved local binding forgettable through its persisted Hub identity', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    await test.service.connect()
    test.setDiscovery({
      available: false,
      designatedHost: true,
      hubIdentity: null,
      message: 'Team Hub is offline.',
      action: 'Restart Team Hub.'
    })

    const offline = test.service.status()
    expect(offline).toMatchObject({
      connectionState: 'unavailable',
      authenticated: false,
      hubIdentity: null,
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: true
    })
    const forgotten = await test.service.forgetBinding({
      profileId: offline.profileId,
      profileGeneration: offline.profileGeneration,
      serverIdentity: offline.serverIdentity!,
      expectedGeneration: offline.generation,
      expectedHubIdentity: offline.savedHubIdentity!
    })
    expect(forgotten).toMatchObject({
      savedHubIdentity: null,
      canForgetBinding: false,
      backgroundReconnectAllowed: false
    })
    expect(test.settings.forgetBinding).toHaveBeenCalledWith('server-profile-1')
  })

  it('rejects ordinary Forget after the saved Hub identity is replaced', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const disconnected = await test.service.disconnect(scopeFrom(connected))
    test.bindings.set('server-profile-1', {
      ...test.bindings.get('server-profile-1')!,
      hubIdentity: 'hub-replacement'
    })
    vi.mocked(test.settings.forgetBinding).mockClear()

    await expect(test.service.forgetBinding({
      profileId: disconnected.profileId,
      profileGeneration: disconnected.profileGeneration,
      serverIdentity: disconnected.serverIdentity!,
      expectedGeneration: disconnected.generation,
      expectedHubIdentity: disconnected.savedHubIdentity!
    })).rejects.toThrow('connection changed')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')?.hubIdentity).toBe('hub-replacement')
  })

  it('rejects ordinary Forget after a reconnect advances the runtime generation', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const disconnected = await test.service.disconnect(scopeFrom(connected))
    await test.service.connect()
    vi.mocked(test.settings.forgetBinding).mockClear()

    await expect(test.service.forgetBinding({
      profileId: disconnected.profileId,
      profileGeneration: disconnected.profileGeneration,
      serverIdentity: disconnected.serverIdentity!,
      expectedGeneration: disconnected.generation,
      expectedHubIdentity: disconnected.savedHubIdentity!
    })).rejects.toThrow('connection changed')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
  })

  it('never exposes an offline persisted secure-peer binding to ordinary local Forget', async () => {
    const test = harness()
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: `http://127.0.0.1:7850/api/team-hub-secure/${TRANSIENT_CONNECTION_ID}`,
      hubIdentity: 'hub-remote',
      connectionId: TRANSIENT_CONNECTION_ID,
      hostServerIdentity: 'server-host'
    })
    const offline = test.service.status()
    expect(offline).toMatchObject({
      transport: null,
      hubIdentity: null,
      savedHubIdentity: null,
      canForgetBinding: false
    })
    vi.mocked(test.settings.forgetBinding).mockClear()

    await expect(test.service.forgetBinding({
      profileId: offline.profileId,
      profileGeneration: offline.profileGeneration,
      serverIdentity: offline.serverIdentity!,
      expectedGeneration: offline.generation,
      expectedHubIdentity: 'hub-remote'
    })).rejects.toThrow('connection changed')
    expect(test.settings.forgetBinding).not.toHaveBeenCalled()
    expect(test.bindings.get('server-profile-1')?.connectionId).toBe(TRANSIENT_CONNECTION_ID)
  })

  it('does not expose ordinary Forget without a verified current server identity', () => {
    const test = harness()
    test.bindings.set('server-profile-1', {
      profileId: 'server-profile-1',
      serverUrl: 'http://127.0.0.1:7850',
      serverIdentity: 'server-stable-1',
      hubUrl: 'http://127.0.0.1:7850/api/team-hub',
      hubIdentity: 'hub-stable-1'
    })
    test.setServerScope({
      profileId: 'server-profile-1',
      profileGeneration: 2,
      serverIdentity: null,
      serverUrl: 'http://127.0.0.1:7850',
      serverName: 'Unverified server'
    })

    expect(test.service.status()).toMatchObject({
      serverIdentity: null,
      savedHubIdentity: 'hub-stable-1',
      canForgetBinding: false
    })
  })

  it('reports remote revocation failure while clearing only the captured binding', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    test.client.revoke.mockRejectedValue(new TeamHubClientError(503, 'unavailable', 'offline'))
    const result = await test.service.logout(scopeFrom(connected))
    expect(result).toMatchObject({ authenticated: false, connectionState: 'signed-out' })
    expect(result.error).toContain('could not be revoked')
    expect(test.settings.clearRefreshToken).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'server-profile-1' }))
  })

  it('gates and identity-fences the Team Network projection', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const projection = {
      network: { id: 'team-1', display_name: 'Owner', hub_id: 'hub-stable-1' },
      servers: [{
        id: 'node-1', server_identity: 'server-stable-1', display_name: 'Local server',
        status: 'active' as const, is_host: true, owned_by_caller: true
      }],
      agents: [{
        id: 'agent-1', server_id: 'node-1', external_agent_id: 'chat-1',
        backend: 'codex' as const, display_name: 'Georgia', status: 'active' as const
      }],
      next_after_server_id: 'node-1',
      has_more: false
    }
    test.client.network.mockResolvedValue(projection)

    expect(test.service.networkCapabilities(scope)).toMatchObject({
      available: true, dispatch: false, skill_attachments: false
    })
    await expect(test.service.network(scope, { teamId: 'team-1' })).resolves.toEqual(projection)

    test.client.network.mockResolvedValue({
      ...projection,
      network: { ...projection.network, hub_id: 'hub-attacker' }
    })
    await expect(test.service.network(scope, { teamId: 'team-1' })).rejects.toThrow('mismatched Team Network identity')
    await expect(test.service.network(scope, { teamId: 'team-other' })).rejects.toThrow('selected Team Network is unavailable')
  })

  it('scope-fences message deletion, legacy Bulletin deletion, and deletion journal pages', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    const deletedAt = '2026-09-05T12:00:00Z'
    test.client.deleteTeamMessage.mockResolvedValue({ deleted: true, message_id: 'message-1' })
    test.client.deleteNetworkBulletin.mockResolvedValue({ deleted: true, post_id: 'post-1' })
    test.client.networkDeletions.mockResolvedValue({
      deletions: [
        { sequence: 5, kind: 'message', id: 'message-1', deleted_at: deletedAt },
        { sequence: 6, kind: 'bulletin', id: 'post-1', deleted_at: deletedAt }
      ],
      next_after_sequence: 6,
      has_more: false
    })

    await expect(test.service.deleteTeamMessage(scope, {
      teamId: 'team-1', messageId: 'message-1', idempotencyKey: 'delete-message-1'
    })).resolves.toEqual({ deleted: true, message_id: 'message-1' })
    await expect(test.service.deleteNetworkBulletin(scope, {
      teamId: 'team-1', postId: 'post-1', idempotencyKey: 'delete-post-1'
    })).resolves.toEqual({ deleted: true, post_id: 'post-1' })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 4, limit: 25
    })).resolves.toMatchObject({
      supported: true,
      page: { next_after_sequence: 6, deletions: [{ sequence: 5 }, { sequence: 6 }] }
    })

    expect(test.client.deleteTeamMessage).toHaveBeenCalledWith('access-new', 'team-1', 'message-1', {
      idempotency_key: 'delete-message-1'
    })
    expect(test.client.deleteNetworkBulletin).toHaveBeenCalledWith('access-new', 'team-1', 'post-1', {
      idempotency_key: 'delete-post-1'
    })
    expect(test.client.networkDeletions).toHaveBeenCalledWith('access-new', 'team-1', 4, 25)

    test.client.deleteTeamMessage.mockResolvedValueOnce({ deleted: true, message_id: 'message-other' })
    await expect(test.service.deleteTeamMessage(scope, {
      teamId: 'team-1', messageId: 'message-1', idempotencyKey: 'delete-message-2'
    })).rejects.toThrow('mismatched Team Message deletion receipt')
    test.client.networkDeletions.mockResolvedValueOnce({
      deletions: [{ sequence: 4, kind: 'message', id: 'message-old', deleted_at: deletedAt }],
      next_after_sequence: 4,
      has_more: false
    })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 4, limit: 25
    })).rejects.toThrow('invalid Team Network deletion page')
    test.client.networkDeletions.mockResolvedValueOnce({
      deletions: [], next_after_sequence: 4, has_more: true
    })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 4, limit: 25
    })).rejects.toThrow('stalled Team Network deletion continuation')
  })

  it('singleflights and memoizes the exact legacy route-forbidden journal failure', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    const probe = deferred<never>()
    test.client.networkDeletions.mockReturnValue(probe.promise)

    const requests = [0, 1, 2].map(afterSequence => test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence, limit: 25
    }))
    await vi.waitFor(() => expect(test.client.networkDeletions).toHaveBeenCalledOnce())
    probe.reject(new TeamHubClientError(403, 'route_forbidden', 'Hub route is not permitted'))

    await expect(Promise.all(requests)).resolves.toEqual([
      { supported: false, reason: 'unsupported' },
      { supported: false, reason: 'unsupported' },
      { supported: false, reason: 'unsupported' }
    ])
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: false, reason: 'unsupported' })
    expect(test.client.networkDeletions).toHaveBeenCalledOnce()
  })

  it('memoizes the exact legacy not-found journal failure but no other 403 or 404', async () => {
    const missingRoute = harness()
    missingRoute.setRefreshToken('refresh-old')
    missingRoute.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    missingRoute.client.refresh.mockResolvedValue(authBundle())
    const missingScope = scopeFrom(await missingRoute.service.connect())
    missingRoute.client.networkDeletions.mockRejectedValueOnce(
      new TeamHubClientError(404, 'not_found', 'Not found')
    )
    await expect(missingRoute.service.networkDeletions(missingScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: false, reason: 'unsupported' })
    await expect(missingRoute.service.networkDeletions(missingScope, {
      teamId: 'team-1', afterSequence: 1, limit: 25
    })).resolves.toEqual({ supported: false, reason: 'unsupported' })
    expect(missingRoute.client.networkDeletions).toHaveBeenCalledOnce()

    const unrelated = harness()
    unrelated.setRefreshToken('refresh-old')
    unrelated.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    unrelated.client.refresh.mockResolvedValue(authBundle())
    const unrelatedScope = scopeFrom(await unrelated.service.connect())
    const unrelatedForbidden = new TeamHubClientError(403, 'permission_denied', 'No access')
    unrelated.client.networkDeletions.mockRejectedValueOnce(unrelatedForbidden)
    await expect(unrelated.service.networkDeletions(unrelatedScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).rejects.toBe(unrelatedForbidden)

    const unrelatedMissing = new TeamHubClientError(404, 'team_not_found', 'Team missing')
    unrelated.client.networkDeletions.mockRejectedValueOnce(unrelatedMissing)
    await expect(unrelated.service.networkDeletions(unrelatedScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).rejects.toBe(unrelatedMissing)
    expect(unrelated.client.networkDeletions).toHaveBeenCalledTimes(2)
  })

  it('does not poison journal support on a transient failure and keeps polling after support is proven', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    const transient = new TeamHubClientError(429, 'rate_limited', 'Try again')
    test.client.networkDeletions
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ deletions: [], next_after_sequence: 0, has_more: false })

    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).rejects.toBe(transient)
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })

    expect(test.client.networkDeletions).toHaveBeenCalledTimes(3)
  })

  it('re-probes journal support after reconnecting into a new Team Hub lifecycle', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const oldScope = scopeFrom(await test.service.connect())
    test.client.networkDeletions
      .mockRejectedValueOnce(new TeamHubClientError(404, 'not_found', 'Not found'))
      .mockResolvedValue({ deletions: [], next_after_sequence: 0, has_more: false })

    await expect(test.service.networkDeletions(oldScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: false, reason: 'unsupported' })
    await expect(test.service.networkDeletions(oldScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: false, reason: 'unsupported' })
    expect(test.client.networkDeletions).toHaveBeenCalledOnce()

    test.service.stop()
    const newScope = scopeFrom(await test.service.connect())
    expect(newScope.generation).not.toBe(oldScope.generation)
    await expect(test.service.networkDeletions(newScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    await expect(test.service.networkDeletions(newScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    expect(test.client.networkDeletions).toHaveBeenCalledTimes(3)
  })

  it('does not let an obsolete journal probe poison the replacement lifecycle', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const oldScope = scopeFrom(await test.service.connect())
    const staleProbe = deferred<never>()
    test.client.networkDeletions
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValue({ deletions: [], next_after_sequence: 0, has_more: false })

    const obsolete = test.service.networkDeletions(oldScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })
    await vi.waitFor(() => expect(test.client.networkDeletions).toHaveBeenCalledOnce())
    test.service.stop()
    const newScope = scopeFrom(await test.service.connect())
    await expect(test.service.networkDeletions(newScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })

    staleProbe.reject(new TeamHubClientError(403, 'route_forbidden', 'Obsolete route'))
    await expect(obsolete).rejects.toThrow('connection changed')
    await expect(test.service.networkDeletions(newScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    expect(test.client.networkDeletions).toHaveBeenCalledTimes(3)
  })

  it('returns replayed tombstones across views without purging an unrelated cached attachment again', async () => {
    let unrelatedCached = false
    const purgeProfile = vi.fn(async () => { unrelatedCached = false })
    const response = vi.fn(async () => new Response(
      unrelatedCached ? 'unrelated cached bytes' : null,
      { status: unrelatedCached ? 200 : 404 }
    ))
    const test = harness({}, { purgeProfile, response } as unknown as TeamAttachmentCache)
    const scope = await connectWithTeamMessages(test)
    const page = {
      deletions: [{
        sequence: 7,
        kind: 'message' as const,
        id: 'message-deleted',
        deleted_at: '2026-09-05T20:00:00Z'
      }],
      next_after_sequence: 7,
      has_more: false
    }
    test.client.networkDeletions.mockResolvedValue(page)

    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page })
    unrelatedCached = true
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page })

    const media = await test.service.teamAttachmentMediaResponse({
      profileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      hubGeneration: scope.generation,
      authCacheEpoch: (test.service as unknown as { authCacheEpoch: string }).authCacheEpoch,
      teamId: 'team-1',
      attachmentId: 'attachment-unrelated'
    }, new Request('agentsdock-media://team/profile/team/attachment-unrelated'))
    expect(await media.text()).toBe('unrelated cached bytes')
    expect(purgeProfile).toHaveBeenCalledOnce()
    expect(test.client.networkDeletions).toHaveBeenCalledTimes(2)
  })

  it('purges once for each newly observed deletion high-water across multiple pages', async () => {
    const purgeProfile = vi.fn().mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const scope = await connectWithTeamMessages(test)
    const firstPage = {
      deletions: [
        { sequence: 1, kind: 'message' as const, id: 'message-1', deleted_at: '2026-09-05T20:00:00Z' },
        { sequence: 2, kind: 'bulletin' as const, id: 'bulletin-2', deleted_at: '2026-09-05T20:01:00Z' }
      ],
      next_after_sequence: 2,
      has_more: true
    }
    const secondPage = {
      deletions: [
        { sequence: 3, kind: 'message' as const, id: 'message-3', deleted_at: '2026-09-05T20:02:00Z' }
      ],
      next_after_sequence: 3,
      has_more: false
    }
    test.client.networkDeletions.mockImplementation(async (_token, _teamId, afterSequence) => (
      afterSequence >= 2 ? secondPage : firstPage
    ))

    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page: firstPage })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 2, limit: 25
    })).resolves.toEqual({ supported: true, page: secondPage })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page: firstPage })

    expect(purgeProfile).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent cache purges and coalesces callers at an observed high-water', async () => {
    const firstPurge = deferred<void>()
    const purgeProfile = vi.fn()
      .mockReturnValueOnce(firstPurge.promise)
      .mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const scope = await connectWithTeamMessages(test)
    test.client.networkDeletions.mockResolvedValueOnce({
      deletions: [], next_after_sequence: 0, has_more: false
    })
    await test.service.networkDeletions(scope, { teamId: 'team-1', afterSequence: 0, limit: 25 })
    test.client.networkDeletions
      .mockResolvedValueOnce({
        deletions: [{ sequence: 1, kind: 'message', id: 'message-1', deleted_at: '2026-09-05T20:00:00Z' }],
        next_after_sequence: 1,
        has_more: false
      })
      .mockResolvedValueOnce({
        deletions: [{ sequence: 2, kind: 'message', id: 'message-2', deleted_at: '2026-09-05T20:01:00Z' }],
        next_after_sequence: 2,
        has_more: false
      })
      .mockResolvedValue({
        deletions: [{ sequence: 2, kind: 'message', id: 'message-2', deleted_at: '2026-09-05T20:01:00Z' }],
        next_after_sequence: 2,
        has_more: false
      })

    const first = test.service.networkDeletions(scope, { teamId: 'team-1', afterSequence: 0, limit: 25 })
    await vi.waitFor(() => expect(purgeProfile).toHaveBeenCalledOnce())
    const second = test.service.networkDeletions(scope, { teamId: 'team-1', afterSequence: 1, limit: 25 })
    await vi.waitFor(() => expect(test.client.networkDeletions).toHaveBeenCalledTimes(3))
    expect(purgeProfile).toHaveBeenCalledOnce()

    firstPurge.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(purgeProfile).toHaveBeenCalledTimes(2)
    await test.service.networkDeletions(scope, { teamId: 'team-1', afterSequence: 1, limit: 25 })
    expect(purgeProfile).toHaveBeenCalledTimes(2)
  })

  it('retries cache invalidation after failure without advancing the deletion high-water', async () => {
    const purgeFailure = new Error('cache directory is locked')
    const purgeProfile = vi.fn()
      .mockRejectedValueOnce(purgeFailure)
      .mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const scope = await connectWithTeamMessages(test)
    const page = {
      deletions: [{
        sequence: 5,
        kind: 'message' as const,
        id: 'message-5',
        deleted_at: '2026-09-05T20:00:00Z'
      }],
      next_after_sequence: 5,
      has_more: false
    }
    test.client.networkDeletions.mockResolvedValue(page)

    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).rejects.toBe(purgeFailure)
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page })
    await expect(test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toEqual({ supported: true, page })

    expect(purgeProfile).toHaveBeenCalledTimes(2)
  })

  it('purges the exact profile attachment cache after local message and Bulletin deletion', async () => {
    const purgeProfile = vi.fn().mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    test.client.deleteTeamMessage.mockResolvedValue({ deleted: true, message_id: 'message-1' })
    test.client.deleteNetworkBulletin.mockResolvedValue({ deleted: true, post_id: 'post-1' })

    await expect(test.service.deleteTeamMessage(scope, {
      teamId: 'team-1', messageId: 'message-1', idempotencyKey: 'delete-message-1'
    })).resolves.toEqual({ deleted: true, message_id: 'message-1' })
    await expect(test.service.deleteNetworkBulletin(scope, {
      teamId: 'team-1', postId: 'post-1', idempotencyKey: 'delete-post-1'
    })).resolves.toEqual({ deleted: true, post_id: 'post-1' })

    expect(purgeProfile).toHaveBeenNthCalledWith(1, scope.profileId)
    expect(purgeProfile).toHaveBeenNthCalledWith(2, scope.profileId)
  })

  it('does not advance a replacement lifecycle high-water from a stale cache purge', async () => {
    const purge = deferred<void>()
    const purgeProfile = vi.fn()
      .mockReturnValueOnce(purge.promise)
      .mockResolvedValue(undefined)
    const test = harness({}, { purgeProfile } as unknown as TeamAttachmentCache)
    const scope = await connectWithTeamMessages(test)
    test.client.networkDeletions.mockResolvedValue({
      deletions: [{
        sequence: 1,
        kind: 'message',
        id: 'message-deleted-remotely',
        deleted_at: '2026-09-05T20:00:00Z'
      }],
      next_after_sequence: 1,
      has_more: false
    })

    const pending = test.service.networkDeletions(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })
    await vi.waitFor(() => expect(purgeProfile).toHaveBeenCalledWith(scope.profileId))
    test.service.stop()
    const replacementScope = scopeFrom(await test.service.connect())
    await expect(test.service.networkDeletions(replacementScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    expect(purgeProfile).toHaveBeenCalledTimes(2)
    purge.resolve(undefined)

    await expect(pending).rejects.toThrow('connection changed')
    await expect(test.service.networkDeletions(replacementScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    })).resolves.toMatchObject({ supported: true })
    expect(purgeProfile).toHaveBeenCalledTimes(2)
  })

  it.each([
    [undefined, false], [16, false], [17, true], [18, true],
    ['17', false], [null, false], [17.5, false], [Number.MAX_SAFE_INTEGER + 1, false]
  ])('derives skill announcement deletion from connected Hub schema %s', async (schemaVersion, supported) => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    const health = {
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true,
      schema_version: schemaVersion,
      capabilities: {
        team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability()
      }
    }
    test.client.health.mockResolvedValue(health)
    const connected = await test.service.connect()
    expect(test.service.teamMessagesCapabilities(scopeFrom(connected)).skill_announcement_deletion === true).toBe(supported)
    const healthCalls = test.client.health.mock.calls.length
    test.service.teamMessagesCapabilities(scopeFrom(connected))
    expect(test.client.health).toHaveBeenCalledTimes(healthCalls)

    // Reconnection must not retain a capability from a previous Hub process.
    test.service.stop()
    test.client.health.mockResolvedValue({ ...health, schema_version: 16 })
    const replacement = await test.service.connect()
    expect(test.service.teamMessagesCapabilities(scopeFrom(replacement)).skill_announcement_deletion).toBeUndefined()
    test.service.stop()
  })

  it('overlays host deletion only from the connected Hub capability and clears it on reconnect', async () => {
    const test = harness()
    test.setDiscovery({ serverSessionBasePath: '/api/team-hub-server' })
    test.client.serverSession.mockResolvedValue(serverSessionSnapshot())
    const health = { ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, server_session_available: true,
      capabilities: { team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability(),
        team_host_content_deletion_v1: { available: true, version: 1 } } }
    test.client.health.mockResolvedValue(health)
    const connected = await test.service.connect()
    expect(test.service.teamMessagesCapabilities(scopeFrom(connected)).host_content_deletion).toBe(true)
    const healthCalls = test.client.health.mock.calls.length
    test.service.teamMessagesCapabilities(scopeFrom(connected))
    expect(test.client.health).toHaveBeenCalledTimes(healthCalls)
    test.service.stop()
    test.client.health.mockResolvedValue({ ...health, capabilities: { ...health.capabilities, team_host_content_deletion_v1: undefined } })
    const replacement = await test.service.connect()
    expect(test.service.teamMessagesCapabilities(scopeFrom(replacement)).host_content_deletion).toBeUndefined()
    test.service.stop()
  })

  it('gates all-server fanout on the verified Hub contract and validates expanded recipients', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    const alias = { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 1024 }
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false, capabilities: {
        team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability(), team_all_servers_alias_v1: alias
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    expect(test.service.teamMessagesCapabilities(scope).all_servers).toEqual(alias)
    const message = { id: 'fanout-1', team_id: 'team-1', kind: 'message', title: null, in_reply_to_message_id: null, destination: 'all_servers', body: 'Hello',
      body_format: 'markdown', attachments: [], recipients: Array.from({ length: 17 }, (_, index) => ({ kind: 'server', id: `node-${index}` })) }
    const input = { teamId: 'team-1', kind: 'message' as const, body: 'Hello', recipients: [{ kind: 'all_servers' as const }], idempotencyKey: 'fanout-key' }
    test.client.createTeamMessage.mockResolvedValue(message)
    await expect(test.service.createTeamMessage(scope, input)).resolves.toEqual(message)
    expect(test.client.createTeamMessage).toHaveBeenCalledWith(expect.any(String), 'team-1', expect.objectContaining({ recipients: [{ kind: 'all_servers' }] }))
    test.client.createTeamMessage.mockResolvedValue({ ...message, destination: undefined })
    await expect(test.service.createTeamMessage(scope, input)).rejects.toThrow('mismatched Team Message')
    Object.assign(test.service, { teamMessagesCapability: teamMessagesCapability() })
    test.client.createTeamMessage.mockClear()
    await expect(test.service.createTeamMessage(scope, input)).rejects.toThrow('does not support @@all')
    expect(test.client.createTeamMessage).not.toHaveBeenCalled()
  })

  it('gates mailbox attention on the connected Hub and validates exact versioned mutation responses', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    const attention = { available: true, version: 1, address_kinds: ['server'] }
    test.client.health.mockResolvedValue({ ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1', bootstrapped: true, bootstrap_required: false,
      capabilities: { team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability(),
        team_mailbox_state_v1: attention } })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    expect(test.service.teamMessagesCapabilities(scope).mailbox_state).toEqual(attention)
    const input = { teamId: 'team-1', messageId: 'message-1', addressKind: 'server' as const,
      addressId: 'server-1', unread: true, expectedVersion: 2, idempotencyKey: 'attention-key-1' }
    const state = { address_kind: 'server', address_id: 'server-1', unread: true, version: 3 }
    const result = { message_id: 'message-1', mailbox_state: state, recipients: [] }
    test.client.setTeamMessageMailboxState.mockResolvedValue(result)
    await expect(test.service.setTeamMessageMailboxState(scope, input)).resolves.toEqual(result)
    expect(test.client.setTeamMessageMailboxState).toHaveBeenLastCalledWith(expect.any(String), 'team-1', 'message-1', {
      address_kind: 'server', address_id: 'server-1', unread: true, expected_version: 2, idempotency_key: 'attention-key-1'
    })
    for (const mismatch of [{ message_id: 'other-message' }, { mailbox_state: { ...state, address_id: 'other-server' } },
      { mailbox_state: { ...state, unread: false } }, { mailbox_state: { ...state, version: 4 } }]) {
      test.client.setTeamMessageMailboxState.mockResolvedValue({ ...result, ...mismatch })
      await expect(test.service.setTeamMessageMailboxState(scope, input)).rejects.toThrow('mismatched mailbox state')
    }
    Object.assign(test.service, { teamMessagesCapability: teamMessagesCapability() })
    test.client.setTeamMessageMailboxState.mockClear()
    await expect(test.service.setTeamMessageMailboxState(scope, input)).rejects.toThrow('does not support Mark unread')
    expect(test.client.setTeamMessageMailboxState).not.toHaveBeenCalled()
    test.service.stop()
  })

  it('gates ordinary subjects on the connected Hub and verifies title plus reply identity exactly', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    const subjects = { available: true, version: 1, max_subject_chars: 160 }
    const health = { ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-1', instance_id: 'instance-1', bootstrapped: true, bootstrap_required: false,
      capabilities: { team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability(),
        team_mail_subjects_v1: subjects } }
    test.client.health.mockResolvedValue(health)
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    expect(test.service.teamMessagesCapabilities(scope).mail_subjects).toEqual(subjects)
    const input = { teamId: 'team-1', kind: 'message' as const, title: 'Daily summary', body: 'Hello',
      inReplyToMessageId: 'original-1', recipients: [{ kind: 'server' as const, id: 'node-1' }],
      idempotencyKey: 'subject-key-1' }
    const message = { id: 'message-1', team_id: 'team-1', kind: 'message', title: input.title,
      in_reply_to_message_id: input.inReplyToMessageId, body: input.body, body_format: 'markdown',
      attachments: [], recipients: input.recipients }
    test.client.createTeamMessage.mockResolvedValue(message)
    await expect(test.service.createTeamMessage(scope, input)).resolves.toEqual(message)
    expect(test.client.createTeamMessage).toHaveBeenLastCalledWith(expect.any(String), 'team-1', expect.objectContaining({
      title: input.title, in_reply_to_message_id: input.inReplyToMessageId, body: input.body, idempotency_key: input.idempotencyKey
    }))
    for (const mismatch of [{ title: null }, { title: 'Different subject' },
      { in_reply_to_message_id: null }, { in_reply_to_message_id: 'different-original' }]) {
      test.client.createTeamMessage.mockResolvedValue({ ...message, ...mismatch })
      await expect(test.service.createTeamMessage(scope, input)).rejects.toThrow('mismatched Team Message')
    }
    test.service.stop()
    test.client.health.mockResolvedValue({ ...health, capabilities: {
      team_network_v1: teamNetworkCapability(), team_messages_v1: teamMessagesCapability()
    } })
    const oldScope = scopeFrom(await test.service.connect())
    expect(test.service.teamMessagesCapabilities(oldScope).mail_subjects).toBeUndefined()
    test.client.createTeamMessage.mockClear()
    await expect(test.service.createTeamMessage(oldScope, input)).rejects.toThrow('does not support mail subjects')
    expect(test.client.createTeamMessage).not.toHaveBeenCalled()
    test.client.createTeamMessage.mockResolvedValue({ ...message, title: null })
    await expect(test.service.createTeamMessage(oldScope, { ...input, title: undefined })).resolves.toMatchObject({ title: null })
    test.service.stop()
  })

  it('rejects mismatched message attachments and rechecks membership plus exact scope after media lookup', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.health.mockResolvedValue({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-1',
      instance_id: 'instance-1',
      bootstrapped: true,
      bootstrap_required: false,
      capabilities: {
        team_network_v1: teamNetworkCapability(),
        team_messages_v1: teamMessagesCapability()
      }
    })
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())

    test.client.createTeamMessage.mockResolvedValue({
      id: 'message-1',
      team_id: 'team-1',
      sequence: 1,
      kind: 'message',
      title: null,
      body_format: 'markdown',
      body: 'Hello',
      body_bytes: 5,
      body_sha256: 'a'.repeat(64),
      sender: { kind: 'human', id: 'principal-1', display_name: 'Owner' },
      provenance: {},
      recipients: [{
        kind: 'server', id: 'node-1', display_name: 'Server', state: 'available',
        delivered_at: null, read_at: null
      }],
      in_reply_to_message_id: null,
      skill: null,
      attachments: [{
        id: 'attachment-other', team_id: 'team-1', message_id: 'message-1', file_name: 'other.bin',
        media_type: 'application/octet-stream', byte_size: 1, sha256: 'b'.repeat(64), state: 'ready',
        received_bytes: 1,
        created_at: '2026-09-03T12:00:00Z', ready_at: '2026-09-03T12:00:01Z'
      }],
      created_at: '2026-09-03T12:00:01Z'
    })
    await expect(test.service.createTeamMessage(scope, {
      teamId: 'team-1', kind: 'message', body: 'Hello', recipients: [{ kind: 'server', id: 'node-1' }],
      attachmentIds: ['attachment-expected'], idempotencyKey: 'message-key-1'
    })).rejects.toThrow('mismatched Team Message')

    const pendingMembershipMedia = deferred<Response>()
    const membershipResponse = vi.fn(() => pendingMembershipMedia.promise)
    ;(test.service as unknown as {
      teamAttachmentCache: { response: typeof membershipResponse }
      teams: Array<{ id: string; status: string }>
    }).teamAttachmentCache = { response: membershipResponse }
    const membershipPending = test.service.teamAttachmentMediaResponse({
      profileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      hubGeneration: scope.generation,
      authCacheEpoch: (test.service as unknown as { authCacheEpoch: string }).authCacheEpoch,
      teamId: 'team-1',
      attachmentId: 'attachment-1'
    }, new Request('agentsdock-media://team/profile/1/team/attachment'))
    await vi.waitFor(() => expect(membershipResponse).toHaveBeenCalledOnce())
    ;(test.service as unknown as { teams: unknown[] }).teams = []
    const cancel = vi.fn()
    pendingMembershipMedia.resolve(new Response(new ReadableStream({ cancel })))
    await expect(membershipPending).rejects.toThrow('selected Team is unavailable')
    expect(cancel).toHaveBeenCalledOnce()
    ;(test.service as unknown as { teams: ReturnType<typeof authBundle>['teams'] }).teams = authBundle().teams

    const pendingMedia = deferred<Response>()
    const response = vi.fn(() => pendingMedia.promise)
    ;(test.service as unknown as { teamAttachmentCache: { response: typeof response } }).teamAttachmentCache = { response }

    const pending = test.service.teamAttachmentMediaResponse({
      profileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      hubGeneration: scope.generation,
      authCacheEpoch: (test.service as unknown as { authCacheEpoch: string }).authCacheEpoch,
      teamId: 'team-1',
      attachmentId: 'attachment-1'
    }, new Request('agentsdock-media://team/profile/1/team/attachment'))
    await vi.waitFor(() => expect(response).toHaveBeenCalledOnce())
    await test.service.disconnect(scope)
    pendingMedia.resolve(new Response('cached bytes'))

    await expect(pending).rejects.toThrow('connection changed')
  })

  it('pages until the exact owned server before registration and rejects a stalled cursor', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    const identity = { id: 'team-1', display_name: 'Owner', hub_id: 'hub-stable-1' }
    const remotePage = {
      network: identity,
      servers: [{
        id: 'node-a', server_identity: 'server-a', display_name: 'Remote',
        status: 'active' as const, is_host: false, owned_by_caller: false
      }],
      agents: [],
      next_after_server_id: 'node-a',
      has_more: true
    }
    const ownedPage = {
      network: identity,
      servers: [{
        id: 'node-z', server_identity: 'server-stable-1', display_name: 'Local',
        status: 'active' as const, is_host: true, owned_by_caller: true
      }],
      agents: [],
      next_after_server_id: 'node-z',
      has_more: false
    }
    test.client.network.mockImplementation(async (_token, _teamId, afterServerId) => (
      afterServerId === null ? remotePage : ownedPage
    ))
    test.client.registerNetworkAgent.mockResolvedValue({
      agent: {
        id: 'agent-z', server_id: 'node-z', external_agent_id: 'chat-z', backend: 'codex',
        display_name: 'Georgia', status: 'active'
      }
    })

    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-z', backend: 'codex',
      displayName: 'Georgia', idempotencyKey: 'agent-page-key'
    })).resolves.toMatchObject({ server_id: 'node-z' })
    expect(test.client.network).toHaveBeenNthCalledWith(1, 'access-new', 'team-1', null, 100)
    expect(test.client.network).toHaveBeenNthCalledWith(2, 'access-new', 'team-1', 'node-a', 100)

    test.client.network.mockReset()
      .mockResolvedValueOnce(remotePage)
      .mockResolvedValueOnce({
        ...ownedPage,
        servers: [{ ...ownedPage.servers[0], id: 'node-b', owned_by_caller: false }],
        next_after_server_id: 'node-a',
        has_more: true
      })
    const registrations = test.client.registerNetworkAgent.mock.calls.length
    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-stalled', backend: 'codex',
      displayName: 'Ada', idempotencyKey: 'agent-stall-key'
    })).rejects.toThrow('invalid Team Network continuation')
    expect(test.client.registerNetworkAgent).toHaveBeenCalledTimes(registrations)
  })

  it('bounds an owned-server scan even when every page advances', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const scope = scopeFrom(await test.service.connect())
    let page = 0
    test.client.network.mockImplementation(async () => {
      const id = `node-${String(page).padStart(4, '0')}`
      page += 1
      return {
        network: { id: 'team-1', display_name: 'Owner', hub_id: 'hub-stable-1' },
        servers: [{
          id, server_identity: `server-${id}`, display_name: id,
          status: 'active' as const, is_host: false, owned_by_caller: false
        }],
        agents: [],
        next_after_server_id: id,
        has_more: true
      }
    })

    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-never', backend: 'codex',
      displayName: 'Never', idempotencyKey: 'agent-bound-key'
    })).rejects.toThrow('safe page limit')
    expect(test.client.network).toHaveBeenCalledTimes(256)
    expect(test.client.registerNetworkAgent).not.toHaveBeenCalled()
  })

  it('registers agents only against the one active server owned by this connection', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const projection = {
      network: { id: 'team-1', display_name: 'Owner', hub_id: 'hub-stable-1' },
      servers: [{
        id: 'node-1', server_identity: 'server-stable-1', display_name: 'Local server',
        status: 'active' as const, is_host: true, owned_by_caller: true
      }],
      agents: [],
      next_after_server_id: 'node-1',
      has_more: false
    }
    test.client.network.mockResolvedValue(projection)
    test.client.registerNetworkAgent.mockResolvedValue({
      agent: {
        id: 'agent-1', server_id: 'node-1', external_agent_id: 'chat-1', backend: 'codex',
        display_name: 'Georgia', status: 'active'
      }
    })

    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-1', backend: 'codex',
      displayName: 'Georgia', idempotencyKey: 'agent-key'
    })).resolves.toMatchObject({ id: 'agent-1', server_id: 'node-1', status: 'active' })
    expect(test.client.network.mock.invocationCallOrder[0]).toBeLessThan(
      test.client.registerNetworkAgent.mock.invocationCallOrder[0]
    )

    test.client.registerNetworkAgent.mockResolvedValueOnce({
      agent: {
        id: 'agent-2', server_id: 'node-other', external_agent_id: 'chat-2', backend: 'codex',
        display_name: 'Ada', status: 'active'
      }
    })
    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-2', backend: 'codex',
      displayName: 'Ada', idempotencyKey: 'agent-key-2'
    })).rejects.toThrow('mismatched agent registration')

    test.client.network.mockResolvedValueOnce({
      ...projection,
      servers: [{ ...projection.servers[0], owned_by_caller: false }]
    })
    const registrationCalls = test.client.registerNetworkAgent.mock.calls.length
    await expect(test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-3', backend: 'codex',
      displayName: 'Grace', idempotencyKey: 'agent-key-3'
    })).rejects.toThrow('exactly one active server')
    expect(test.client.registerNetworkAgent).toHaveBeenCalledTimes(registrationCalls)
  })

  it('opens only the exact signed-in human reply mailbox and rejects it at the peer boundary', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const now = '2026-08-24T12:00:00Z'
    const reply = {
      item: {
        id: 'reply-1', sequence: 1, kind: 'reply' as const,
        from: { kind: 'server' as const, id: 'node-remote', server_identity: 'server-remote', display_name: 'Remote' },
        to: { kind: 'human' as const, id: 'principal-1', display_name: 'Owner' },
        body_format: 'plain' as const, body: 'Done', request_id: 'request-1',
        created_at: now, expires_at: null
      },
      delivery: { id: 'delivery-1', state: 'available' as const, available_at: now, delivered_at: null, read_at: null }
    }
    test.client.networkMailbox.mockResolvedValue({ items: [reply], next_after_sequence: 1, has_more: false })

    await expect(test.service.mailbox(scope, {
      teamId: 'team-1', address: { kind: 'human', id: 'principal-1' }
    })).resolves.toMatchObject({ items: [{ item: { to: { kind: 'human', id: 'principal-1' } } }] })
    expect(test.client.networkMailbox).toHaveBeenCalledWith(
      'access-new', 'team-1', { kind: 'human', id: 'principal-1' }, 0, 50
    )

    const calls = test.client.networkMailbox.mock.calls.length
    await expect(test.service.mailbox(scope, {
      teamId: 'team-1', address: { kind: 'human', id: 'principal-other' }
    })).rejects.toThrow('signed-in person')
    expect(test.client.networkMailbox).toHaveBeenCalledTimes(calls)

    const peer = harness()
    await connectTransientPeer(peer)
    await expect(peer.service.mailbox(scopeFrom(peer.service.status()), {
      teamId: 'team-1', address: { kind: 'human', id: 'peer-node' }
    })).rejects.toThrow('signed-in person')
  })

  it('rejects created Team Network records that forge the active human principal', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const now = '2026-08-24T12:00:00Z'
    const later = '2026-08-24T13:00:00Z'
    const forged = { kind: 'human' as const, id: 'principal-other', display_name: 'Attacker' }
    const local = {
      kind: 'server' as const, id: 'node-1', server_identity: 'server-stable-1', display_name: 'Local server'
    }
    const available = {
      id: 'delivery-1', state: 'available' as const, available_at: now, delivered_at: null, read_at: null
    }
    const message = {
      id: 'item-1', sequence: 1, kind: 'message' as const, from: forged, to: local,
      body_format: 'markdown' as const, body: 'Hello', request_id: null, created_at: now, expires_at: null
    }
    const request = {
      id: 'request-1', sequence: 2, kind: 'request' as const, from: forged, to: local,
      body_format: 'markdown' as const, body: 'Question', request_id: 'request-1', created_at: now, expires_at: later
    }
    const requestState = { id: 'request-1', status: 'open' as const, expires_at: later, reply_item_id: null }
    const reply = {
      id: 'reply-1', sequence: 3, kind: 'reply' as const, from: forged, to: local,
      body_format: 'markdown' as const, body: 'Answer', request_id: 'request-1', created_at: now, expires_at: null
    }
    test.client.postNetworkBulletin.mockResolvedValue({
      post: {
        id: 'post-1', sequence: 1, author: forged, body_format: 'markdown', body: 'Update',
        thread_root_post_id: null, reply_to_post_id: null, created_at: now
      }
    })
    test.client.sendNetworkMailbox.mockResolvedValue({ item: message, delivery: available })
    test.client.createNetworkPassiveRequest.mockResolvedValue({
      item: request, delivery: available, request: requestState
    })
    test.client.networkPassiveRequest.mockResolvedValue({
      item: request, delivery: available, request: requestState, reply: null
    })
    test.client.replyNetworkPassiveRequest.mockResolvedValue({
      item: reply, delivery: available,
      request: { ...requestState, status: 'replied', reply_item_id: 'reply-1' }
    })

    await expect(test.service.postBulletin(scope, {
      teamId: 'team-1', body: 'Update', idempotencyKey: 'post-key'
    })).rejects.toThrow('mismatched Bulletin post')
    await expect(test.service.sendMailbox(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-1' }, body: 'Hello', idempotencyKey: 'mail-key'
    })).rejects.toThrow('mismatched mailbox item')
    await expect(test.service.createPassiveRequest(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-1' }, body: 'Question',
      idempotencyKey: 'request-key', expiresInSeconds: 3600
    })).rejects.toThrow('mismatched passive request')
    await expect(test.service.replyPassiveRequest(scope, {
      teamId: 'team-1', requestId: 'request-1', body: 'Answer', idempotencyKey: 'reply-key'
    })).rejects.toThrow('mismatched passive request reply')
  })

  it('projects every passive Team Network operation through exact normalized inputs', async () => {
    const test = harness()
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    const now = '2026-08-24T12:00:00Z'
    const later = '2026-08-24T13:00:00Z'
    const human = { kind: 'human' as const, id: 'principal-1', display_name: 'Owner' }
    const local = {
      kind: 'server' as const, id: 'node-1', server_identity: 'server-stable-1', display_name: 'Local server'
    }
    const remote = {
      kind: 'server' as const, id: 'node-2', server_identity: 'server-remote-2', display_name: 'Remote server'
    }
    const projection = {
      network: { id: 'team-1', display_name: 'Owner', hub_id: 'hub-stable-1' },
      servers: [{
        id: 'node-1', server_identity: 'server-stable-1', display_name: 'Local server',
        status: 'active' as const, is_host: true, owned_by_caller: true
      }, {
        id: 'node-2', server_identity: 'server-remote-2', display_name: 'Remote server',
        status: 'active' as const, is_host: false, owned_by_caller: false
      }],
      agents: [],
      next_after_server_id: 'node-2',
      has_more: false
    }
    const available = {
      id: 'delivery-1', state: 'available' as const, available_at: now, delivered_at: null, read_at: null
    }
    const message = {
      id: 'item-1', sequence: 1, kind: 'message' as const, from: human, to: local,
      body_format: 'markdown' as const, body: 'Hello', request_id: null, created_at: now, expires_at: null
    }
    const requestItem = {
      id: 'request-1', sequence: 2, kind: 'request' as const, from: human, to: remote,
      body_format: 'markdown' as const, body: 'Please reply', request_id: 'request-1', created_at: now, expires_at: later
    }
    const passive = { id: 'request-1', status: 'open' as const, expires_at: later, reply_item_id: null }
    const inboundRequestItem = {
      id: 'request-inbound', sequence: 3, kind: 'request' as const, from: remote, to: local,
      body_format: 'plain' as const, body: 'Can you reply?', request_id: 'request-inbound', created_at: now, expires_at: later
    }
    const inboundPassive = { ...passive, id: 'request-inbound' }
    const replyItem = {
      id: 'reply-1', sequence: 4, kind: 'reply' as const, from: human, to: remote,
      body_format: 'plain' as const, body: 'Done', request_id: 'request-inbound', created_at: now, expires_at: null
    }
    const bulletin = {
      id: 'post-1', sequence: 1,
      author: { kind: 'human' as const, id: 'principal-1', display_name: 'Owner' },
      body_format: 'markdown' as const, body: 'Update', thread_root_post_id: null,
      reply_to_post_id: null, created_at: now
    }
    test.client.registerNetworkAgent.mockResolvedValue({
      agent: { id: 'agent-1', server_id: 'node-1', external_agent_id: 'chat-1', backend: 'codex', display_name: 'Georgia', status: 'active' }
    })
    test.client.network.mockResolvedValue(projection)
    test.client.networkBulletin.mockResolvedValue({ posts: [bulletin], next_after_sequence: 1, has_more: false })
    test.client.postNetworkBulletin.mockResolvedValue({ post: bulletin })
    test.client.networkMailbox.mockResolvedValue({
      items: [{ item: message, delivery: available }], next_after_sequence: 1, has_more: false
    })
    test.client.sendNetworkMailbox.mockResolvedValue({ item: message, delivery: available })
    test.client.networkItem.mockResolvedValue({ item: message, delivery: available })
    test.client.recordNetworkDeliveryReceipt.mockResolvedValue({
      delivery: { ...available, state: 'delivered', delivered_at: now }
    })
    test.client.createNetworkPassiveRequest.mockResolvedValue({ item: requestItem, delivery: available, request: passive })
    test.client.networkPassiveRequest.mockImplementation(async (_token, _teamId, requestId) => requestId === 'request-inbound'
      ? { item: inboundRequestItem, delivery: available, request: inboundPassive, reply: null }
      : { item: requestItem, delivery: available, request: passive, reply: null })
    test.client.replyNetworkPassiveRequest.mockResolvedValue({
      item: replyItem,
      delivery: available,
      request: { ...inboundPassive, status: 'replied', reply_item_id: 'reply-1' }
    })

    await test.service.registerNetworkAgent(scope, {
      teamId: 'team-1', externalAgentId: 'chat-1', backend: 'codex', displayName: 'Georgia', idempotencyKey: 'agent-key'
    })
    await test.service.bulletin(scope, { teamId: 'team-1' })
    await test.service.postBulletin(scope, { teamId: 'team-1', body: 'Update', idempotencyKey: 'post-key' })
    await test.service.mailbox(scope, { teamId: 'team-1', address: { kind: 'server', id: 'node-1' } })
    await test.service.sendMailbox(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-1' }, body: 'Hello', idempotencyKey: 'mail-key'
    })
    await test.service.networkItem(scope, 'team-1', 'item-1')
    test.client.networkItem.mockResolvedValueOnce({ item: { ...message, id: 'item-other' }, delivery: available })
    await expect(test.service.networkItem(scope, 'team-1', 'item-1')).rejects.toThrow('mismatched mailbox item')
    await test.service.recordDeliveryReceipt(scope, {
      teamId: 'team-1', deliveryId: 'delivery-1', state: 'delivered', idempotencyKey: 'receipt-key'
    })
    await test.service.createPassiveRequest(scope, {
      teamId: 'team-1', to: { kind: 'server', id: 'node-2' }, body: 'Please reply', idempotencyKey: 'request-key', expiresInSeconds: 3600
    })
    await test.service.passiveRequest(scope, 'team-1', 'request-1')
    await test.service.replyPassiveRequest(scope, {
      teamId: 'team-1', requestId: 'request-inbound', body: 'Done', bodyFormat: 'plain', idempotencyKey: 'reply-key'
    })

    expect(test.client.networkBulletin).toHaveBeenCalledWith('access-new', 'team-1', 0, 50)
    expect(test.client.postNetworkBulletin).toHaveBeenCalledWith('access-new', 'team-1', {
      body: 'Update', body_format: 'markdown', idempotency_key: 'post-key'
    })
    expect(test.client.sendNetworkMailbox).toHaveBeenCalledWith('access-new', 'team-1', {
      to: { kind: 'server', id: 'node-1' }, body: 'Hello', body_format: 'markdown', idempotency_key: 'mail-key'
    })
    expect(test.client.createNetworkPassiveRequest).toHaveBeenCalledWith('access-new', 'team-1', {
      to: { kind: 'server', id: 'node-2' }, body: 'Please reply', body_format: 'markdown',
      idempotency_key: 'request-key', expires_in_seconds: 3600
    })
    expect(test.client.replyNetworkPassiveRequest).toHaveBeenCalledWith('access-new', 'team-1', 'request-inbound', {
      body: 'Done', body_format: 'plain', idempotency_key: 'reply-key'
    })
  })

  it('fails closed when the capability is absent and strips no unknown Team Network fields', async () => {
    const test = harness()
    test.client.health.mockResolvedValue({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-stable-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false
    })
    test.setRefreshToken('refresh-old')
    test.client.refresh.mockResolvedValue(authBundle())
    const connected = await test.service.connect()
    const scope = scopeFrom(connected)
    expect(() => test.service.networkCapabilities(scope)).toThrow('does not support Team Networks')
    await expect(test.service.network(scope, { teamId: 'team-1' })).rejects.toThrow('does not support Team Networks')
    expect(test.client.network).not.toHaveBeenCalled()

    const supported = harness()
    supported.setRefreshToken('refresh-old')
    supported.client.refresh.mockResolvedValue(authBundle())
    const ready = await supported.service.connect()
    await expect(supported.service.sendMailbox(scopeFrom(ready), {
      teamId: 'team-1', to: { kind: 'server', id: 'node-1' }, body: 'x'.repeat(8_193),
      idempotencyKey: 'oversize-mail-key'
    })).rejects.toThrow('too large for this server')
    expect(supported.client.sendNetworkMailbox).not.toHaveBeenCalled()
    await expect(supported.service.sendMailbox(scopeFrom(ready), {
      teamId: 'team-1', to: { kind: 'server', id: 'node-1' }, body: 'Hello', idempotencyKey: 'mail-key',
      attachments: [{ id: 'artifact-1' }]
    } as never)).rejects.toThrow('Mailbox message')
    expect(supported.client.sendNetworkMailbox).not.toHaveBeenCalled()
  })
})
