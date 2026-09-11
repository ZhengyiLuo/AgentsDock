import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { SecurePeerControlStatus, SecurePeerPairing } from '@shared/secure-peer'
import type { TeamHubStatus, TeamHubTeamDetails, TeamHubWorkspace } from '@shared/team-hub'
import type {
  TeamMessagePage,
  TeamMessageSummary,
  TeamMessagesCapability,
  TeamNetworkBulletinPost,
  TeamNetworkMailboxEntry,
  TeamNetworkPassiveRequestDetails,
  TeamNetworkProjectionPage
} from '@shared/team-network'
import { TeamNetwork as TeamNetworkView } from './TeamNetwork'
import { resetTeamNetworkSnapshotCacheForTests } from '../lib/team-network-snapshot-cache'
import { useAppStore } from '../store/app-store'

// Most lifecycle tests predate Mail becoming the product default and use the
// legacy Bulletin body as their loaded-state sentinel. Keep those fixtures
// explicit while dedicated navigation tests exercise the real default.
function TeamNetwork(props: ComponentProps<typeof TeamNetworkView>) {
  return <TeamNetworkView initialSection="feed" {...props} />
}

const hostStatus: TeamHubStatus = {
  version: 1,
  profileId: 'profile-host',
  profileGeneration: 3,
  serverIdentity: 'identity-host',
  serverName: 'TargetApp',
  generation: 4,
  hubUrl: 'http://127.0.0.1:7850/api/team-hub',
  hubIdentity: 'hub-team',
  savedHubIdentity: 'hub-team',
  transport: 'loopback',
  designatedHost: true,
  availabilityMessage: 'Ready',
  availabilityAction: null,
  canForgetBinding: true,
  backgroundReconnectAllowed: true,
  connectionState: 'authenticated',
  authenticated: true,
  authenticationMode: 'human',
  bootstrapRequired: false,
  principal: { id: 'owner', display_name: 'Owner', email: 'owner@example.test' },
  session: { id: 'session', device_label: 'Desktop', expires_at: '2027-01-01T00:00:00Z' },
  error: null
}

const peerStatus: TeamHubStatus = {
  ...hostStatus,
  profileId: 'profile-peer',
  serverIdentity: 'identity-peer',
  serverName: 'Studio',
  designatedHost: false,
  transport: 'secure_peer',
  authenticationMode: 'paired_node',
  connectionId: 'connection-peer',
  hostServerIdentity: 'identity-host',
  savedHubIdentity: null,
  canForgetBinding: false,
  principal: { id: 'peer-principal', display_name: 'Studio', kind: 'service' }
}

const managedHostStatus: TeamHubStatus = {
  ...hostStatus,
  serverManaged: true,
  authenticationMode: 'server',
  principal: {
    id: 'service_managed_server',
    display_name: 'AgentsDock managed server',
    kind: 'service'
  },
  session: {
    id: 'managed_server_session_team-1',
    device_label: 'AgentsServer',
    expires_at: '2027-01-01T00:00:00Z'
  }
}

const teamMessagesCapability: TeamMessagesCapability = {
  available: true,
  version: 1,
  kinds: ['message', 'skill'],
  recipient_kinds: ['server', 'human', 'all'],
  max_body_bytes: 131_072,
  max_recipients_per_message: 32,
  max_page_items: 100,
  attachments: {
    max_bytes_per_file: 64 * 1024 * 1024,
    max_files_per_message: 16,
    max_bytes_per_message: 128 * 1024 * 1024,
    chunk_bytes: 8 * 1024 * 1024,
    range_downloads: true,
    team_quota_bytes: 1024 * 1024 * 1024
  },
  skills: {
    slug_pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
    max_per_team: 500,
    max_versions_per_skill: 200,
    max_tags: 8
  }
}

function workspaceFor(status: TeamHubStatus, teams: TeamHubWorkspace['teams'] = [{ id: 'team-1', kind: 'shared', slug: 'team', display_name: 'Core team', role: 'owner', status: 'active' }]): TeamHubWorkspace {
  return { status, teams }
}

function detailsFor(status: TeamHubStatus, teamId = 'team-1', displayName = 'Core team'): TeamHubTeamDetails {
  return {
    scope: {
      profileId: status.profileId,
      profileGeneration: status.profileGeneration,
      serverIdentity: status.serverIdentity!,
      generation: status.generation,
      hubIdentity: status.hubIdentity
    },
    team: { id: teamId, kind: 'shared', slug: teamId, display_name: displayName, role: 'owner', status: 'active' },
    membership: { principal_id: status.principal?.id ?? 'owner', display_name: status.principal?.display_name ?? 'Owner', role: ['paired_node', 'server'].includes(status.authenticationMode ?? '') ? 'automation' : 'owner', status: 'active' },
    members: [],
    nodes: [],
    channels: []
  }
}

function projectionFor(status: TeamHubStatus, teamId = 'team-1', displayName = 'Core team'): TeamNetworkProjectionPage {
  const peerOwnsStudio = status.serverIdentity === 'identity-peer'
  return {
    network: { id: teamId, display_name: displayName, hub_id: 'hub-team' },
    servers: [
      { id: 'server-host', server_identity: 'identity-host', display_name: 'TargetApp', status: 'active', is_host: true, owned_by_caller: !peerOwnsStudio },
      { id: 'server-peer', server_identity: 'identity-peer', display_name: 'Studio', status: 'active', is_host: false, owned_by_caller: peerOwnsStudio }
    ],
    agents: [
      { id: 'agent-host', server_id: 'server-host', external_agent_id: 'agent-georgia', backend: 'codex', display_name: 'Georgia', status: 'active' },
      { id: 'agent-peer', server_id: 'server-peer', external_agent_id: 'agent-build', backend: 'claude', display_name: 'Build agent', status: 'active' }
    ],
    next_after_server_id: 'server-peer',
    has_more: false
  }
}

function bulletinPost(id: string, sequence: number, body: string): TeamNetworkBulletinPost {
  return {
    id,
    sequence,
    author: { kind: 'human', id: 'owner', display_name: 'Owner' },
    body_format: 'plain',
    body,
    thread_root_post_id: null,
    reply_to_post_id: null,
    created_at: '2026-08-24T12:00:00Z'
  }
}

function feedMessage(id: string, sequence: number, preview: string, sender = 'Studio'): TeamMessageSummary {
  return {
    id,
    team_id: 'team-1',
    sequence,
    kind: 'message',
    title: null,
    body_format: 'markdown',
    body_bytes: new TextEncoder().encode(preview).byteLength,
    body_sha256: 'a'.repeat(64),
    sender: { kind: 'server', id: `sender-${id}`, display_name: sender },
    provenance: { via: 'agent' },
    recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
    in_reply_to_message_id: null,
    skill: null,
    attachments: [],
    preview,
    created_at: `2026-09-05T12:00:0${sequence}Z`
  }
}

function mailboxEntry(state: TeamNetworkMailboxEntry['delivery']['state'] = 'available'): TeamNetworkMailboxEntry {
  return {
    item: {
      id: 'mail-1',
      sequence: 1,
      kind: 'request',
      from: { kind: 'agent', id: 'agent-peer', server_id: 'server-peer', backend: 'claude', display_name: 'Build agent' },
      to: { kind: 'server', id: 'server-host', server_identity: 'identity-host', display_name: 'TargetApp' },
      body_format: 'plain',
      body: 'Please review the rollout.',
      request_id: 'mail-1',
      created_at: '2026-08-24T12:00:00Z',
      expires_at: '2026-08-25T12:00:00Z'
    },
    delivery: {
      id: 'delivery-1',
      state,
      available_at: '2026-08-24T12:00:00Z',
      delivered_at: state === 'available' ? null : '2026-08-24T12:01:00Z',
      read_at: state === 'read' ? '2026-08-24T12:02:00Z' : null
    }
  }
}

function secureControl(status: TeamHubStatus): SecurePeerControlStatus {
  return {
    version: 2,
    heartbeatIntervalSeconds: 30,
    leaseSeconds: 90,
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity!,
    serverInstanceId: 'instance-1',
    activeConnectionId: status.connectionId ?? null,
    remoteRouteDeliveryAvailable: false,
    connectionError: null,
    host: {
      available: true,
      enabled: status.designatedHost,
      listenPort: 7851,
      advertisedHost: status.designatedHost ? '100.64.0.1' : null,
      advertisedHosts: status.designatedHost ? ['100.64.0.1'] : [],
      caFingerprint: null,
      pairingLink: null,
      certificateExpiresAt: null,
      error: null,
      errorCode: null,
      action: null
    },
    pairings: [],
    remoteRoutes: [],
    publishedRoutes: []
  }
}

function securePairing(overrides: Partial<SecurePeerPairing> = {}): SecurePeerPairing {
  return {
    id: 'pairing-peer',
    direction: 'outgoing',
    status: 'pending_approval',
    trustState: 'pending',
    transportState: 'disconnected',
    peerServerIdentity: 'identity-host',
    peerDisplayName: 'TargetApp',
    remoteEndpoint: '100.64.0.1:7851',
    hostServerIdentity: 'identity-host',
    hostCaFingerprint: `sha256:${'a'.repeat(64)}`,
    peerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`,
    transcriptHash: 'c'.repeat(64),
    sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
    requestedScopes: ['teamspace.read', 'teamspace.write'],
    grantedScopes: [],
    teamId: null,
    teamDisplayName: null,
    hubIdentity: null,
    connectionId: null,
    localProxyBasePath: null,
    certificateExpiresAt: null,
    certificateFingerprint: null,
    lastSeenAt: null,
    expiresAt: '2026-08-29T00:00:00Z',
    error: null,
    ...overrides
  }
}

function approvedIncomingPairing(overrides: Partial<SecurePeerPairing> = {}): SecurePeerPairing {
  return securePairing({
    id: 'pairing-studio',
    direction: 'incoming',
    status: 'approved',
    trustState: 'approved',
    transportState: 'offline',
    peerServerIdentity: 'identity-peer',
    peerDisplayName: 'Studio',
    connectionId: 'connection-studio',
    teamId: 'team-1',
    teamDisplayName: 'Core team',
    hubIdentity: 'hub-team',
    grantedScopes: ['teamspace.read', 'teamspace.write'],
    certificateFingerprint: `sha256:${'d'.repeat(64)}`,
    certificateExpiresAt: '2027-01-01T00:00:00Z',
    ...overrides
  })
}

interface APIOptions {
  statusValue?: TeamHubStatus
  workspaceValue?: TeamHubWorkspace
  detailsValue?: TeamHubTeamDetails
  projectionValue?: TeamNetworkProjectionPage
  overrides?: Record<string, unknown>
}

function installAPI(options: APIOptions = {}) {
  const statusValue = options.statusValue ?? hostStatus
  const workspaceValue = options.workspaceValue ?? workspaceFor(statusValue)
  const detailsValue = options.detailsValue ?? detailsFor(statusValue)
  const projectionValue = options.projectionValue ?? projectionFor(statusValue)
  const initialMail = mailboxEntry()
  const teamHub = {
    status: vi.fn().mockResolvedValue(statusValue),
    connect: vi.fn(),
    disconnect: vi.fn(),
    forgetBinding: vi.fn(),
    bootstrap: vi.fn(),
    join: vi.fn(),
    recoverDevice: vi.fn(),
    workspace: vi.fn().mockResolvedValue(workspaceValue),
    team: vi.fn().mockResolvedValue(detailsValue),
    deviceSessions: vi.fn().mockResolvedValue({
      sessions: [{
        id: 'session', device_label: 'Desktop', created_at: '2026-08-01T00:00:00Z',
        last_seen_at: '2026-08-24T12:00:00Z', expires_at: '2027-01-01T00:00:00Z',
        revoked_at: null, current: true
      }],
      has_more: false, next_cursor: null
    }),
    revokeDeviceSession: vi.fn().mockResolvedValue({ revoked: true }),
    members: vi.fn().mockResolvedValue({ members: [], has_more: false, next_cursor: null }),
    invitations: vi.fn().mockResolvedValue({ invitations: [], has_more: false, next_cursor: null }),
    revokeInvitation: vi.fn().mockResolvedValue({ revoked: true }),
    updateMember: vi.fn().mockImplementation((_scope, input) => Promise.resolve({
      principal_id: input.principalId,
      email: 'member@example.test',
      display_name: 'Member',
      role: 'role' in input.patch ? input.patch.role : 'member',
      status: 'status' in input.patch ? input.patch.status : 'active'
    })),
    networkCapabilities: vi.fn().mockResolvedValue({
      available: true,
      version: 1,
      logical_servers: true,
      agent_registry: true,
      bulletin: true,
      mailbox: true,
      delivery_receipts: ['delivered', 'read'],
      passive_requests: true,
      server_invites: false,
      skill_attachments: false,
      dispatch: false,
      max_agents_per_server: 256,
      max_page_items: 100,
      max_body_bytes: 8_192
    }),
    network: vi.fn().mockResolvedValue(projectionValue),
    registerNetworkAgent: vi.fn().mockResolvedValue({ id: 'agent-new', server_id: projectionValue.servers.find(server => server.owned_by_caller)?.id ?? 'server-host', external_agent_id: 'agent-new', backend: 'codex', display_name: 'New agent', status: 'active' }),
    bulletin: vi.fn().mockResolvedValue({ posts: [bulletinPost('post-1', 1, 'Initial update')], next_after_sequence: 1, has_more: false }),
    postBulletin: vi.fn().mockResolvedValue(bulletinPost('post-2', 2, 'Posted update')),
    mailbox: vi.fn().mockResolvedValue({ items: [initialMail], next_after_sequence: 1, has_more: false }),
    sendMailbox: vi.fn().mockResolvedValue(initialMail),
    networkItem: vi.fn().mockResolvedValue(initialMail),
    recordDeliveryReceipt: vi.fn().mockImplementation((_scope, input) => Promise.resolve({
      ...initialMail.delivery,
      state: input.state,
      delivered_at: '2026-08-24T12:01:00Z',
      read_at: input.state === 'read' ? '2026-08-24T12:02:00Z' : null
    })),
    createPassiveRequest: vi.fn().mockResolvedValue({ ...initialMail, request: { id: 'mail-1', status: 'open', expires_at: '2026-08-25T12:00:00Z', reply_item_id: null } }),
    passiveRequest: vi.fn().mockResolvedValue({ ...initialMail, delivery: { ...initialMail.delivery, state: 'read' }, request: { id: 'mail-1', status: 'open', expires_at: '2026-08-25T12:00:00Z', reply_item_id: null }, reply: null } satisfies TeamNetworkPassiveRequestDetails),
    replyPassiveRequest: vi.fn().mockResolvedValue({
      item: {
        ...initialMail.item,
        id: 'reply-1',
        kind: 'reply',
        body: 'Acknowledged',
        request_id: 'mail-1',
        expires_at: null
      },
      delivery: { ...initialMail.delivery, id: 'delivery-reply-1' },
      request: { id: 'mail-1', status: 'replied', expires_at: '2026-08-25T12:00:00Z', reply_item_id: 'reply-1' }
    }),
    securePeerStatus: vi.fn().mockResolvedValue(secureControl(statusValue)),
    configureSecurePeerHost: vi.fn(),
    securePeers: vi.fn().mockResolvedValue([]),
    requestSecurePeerPairing: vi.fn(),
    refreshSecurePeerPairing: vi.fn(),
    cancelSecurePeerPairing: vi.fn(),
    activateSecurePeerPairing: vi.fn(),
    deactivateSecurePeerConnection: vi.fn(),
    forgetSecurePeerConnection: vi.fn(),
    approveSecurePeerPairing: vi.fn(),
    rejectSecurePeerPairing: vi.fn(),
    revokeSecurePeer: vi.fn(),
    ...options.overrides
  }
  window.agentsDock = {
    teamHub,
    native: { readClipboard: vi.fn().mockResolvedValue(''), writeClipboard: vi.fn().mockResolvedValue(undefined) }
  } as unknown as AgentsDockAPI
  return teamHub
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

const realSendPromptForSession = useAppStore.getState().sendPromptForSession
const realSelectSession = useAppStore.getState().selectSession

beforeEach(() => {
  resetTeamNetworkSnapshotCacheForTests()
  window.localStorage.clear()
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '42e7bb2e-3b47-4be7-89fc-2cecd90f4434') })
  useAppStore.setState({
    sessions: [],
    selectedSessionId: null,
    loadingSessionIds: new Set(),
    loadingSessionId: null,
    selectSession: realSelectSession,
    sendPromptForSession: realSendPromptForSession
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState({
    sessions: [],
    selectedSessionId: null,
    loadingSessionIds: new Set(),
    loadingSessionId: null,
    selectSession: realSelectSession,
    sendPromptForSession: realSendPromptForSession
  })
})

describe('Team Network', () => {
  it('paints non-sensitive chrome synchronously and gates cached content on fresh status', async () => {
    useAppStore.setState({
      activeProfileId: hostStatus.profileId,
      profileGeneration: hostStatus.profileGeneration,
      profiles: [{
        id: hostStatus.profileId,
        name: hostStatus.serverName ?? 'TargetApp',
        serverUrl: 'http://127.0.0.1:7850',
        serverIdentity: hostStatus.serverIdentity,
        hasAccessToken: true,
        serverSetupComplete: true,
        connectionState: 'online',
        cachedUnreadCount: 0
      }]
    })
    const reopenStatus = deferred<TeamHubStatus>()
    const status = vi.fn()
      .mockResolvedValueOnce(hostStatus)
      .mockImplementationOnce(() => reopenStatus.promise)
    const teamHub = installAPI({ overrides: { status } })
    const first = render(<TeamNetworkView initialSection="feed" onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    await waitFor(() => expect(teamHub.network).toHaveBeenCalledTimes(1))
    expect(teamHub.workspace).toHaveBeenCalledTimes(1)
    first.unmount()

    render(<TeamNetworkView initialSection="feed" onClose={vi.fn()} />)

    // Generic chrome can paint immediately, but the prior principal's cached
    // Bulletin stays hidden until the current session is verified.
    expect(screen.getByRole('heading', { name: 'Bulletin' })).toBeVisible()
    expect(screen.getByText('Beta')).toBeVisible()
    expect(screen.queryByText('Opening team network…')).not.toBeInTheDocument()
    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
    expect(teamHub.workspace).toHaveBeenCalledTimes(1)
    expect(teamHub.network).toHaveBeenCalledTimes(1)

    await act(async () => {
      reopenStatus.resolve(hostStatus)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(teamHub.network).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Initial update')).toBeVisible()
  })

  it('creates a fresh team using only its name and the verified server profile', async () => {
    const fresh: TeamHubStatus = {
      ...hostStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      bootstrapRequired: true,
      connectionState: 'needs-bootstrap'
    }
    const bootstrap = vi.fn().mockResolvedValue(workspaceFor(managedHostStatus))
    installAPI({ statusValue: fresh, overrides: { bootstrap } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.change(await screen.findByLabelText('Team name'), { target: { value: 'Research team' } })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create team network' }))
    await waitFor(() => expect(bootstrap).toHaveBeenCalledWith({
      profileScope: { profileId: fresh.profileId, profileGeneration: fresh.profileGeneration, serverIdentity: fresh.serverIdentity },
      teamName: 'Research team'
    }))
    expect(await screen.findByText('Initial update')).toBeVisible()
  })

  it('recovers a signed-out human through the main-owned proof-file picker', async () => {
    const signedOut: TeamHubStatus = {
      ...hostStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionState: 'signed-out'
    }
    const recoverDevice = vi.fn().mockResolvedValue(workspaceFor(hostStatus))
    installAPI({ statusValue: signedOut, workspaceValue: workspaceFor(signedOut), overrides: { recoverDevice } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Connect to your Team Network' })).toBeVisible()
    fireEvent.click(screen.getByText('Legacy account access'))
    expect(screen.getByRole('form', { name: 'Recover signed-out device' })).toBeVisible()
    fireEvent.change(screen.getByLabelText('Recovery device name'), { target: { value: 'Replacement Mac' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose recovery proof' }))

    await waitFor(() => expect(recoverDevice).toHaveBeenCalledWith({ deviceLabel: 'Replacement Mac' }))
    expect(await screen.findByText('Initial update')).toBeVisible()
  })

  it('keeps device recovery actionable when proof selection or redemption fails', async () => {
    const signedOut: TeamHubStatus = {
      ...hostStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionState: 'signed-out'
    }
    const recoverDevice = vi.fn().mockRejectedValue(new Error('Recovery proof expired'))
    installAPI({ statusValue: signedOut, workspaceValue: workspaceFor(signedOut), overrides: { recoverDevice } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('Legacy account access'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose recovery proof' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Recovery proof expired')
    expect(screen.getByRole('button', { name: 'Choose recovery proof' })).toBeEnabled()
  })

  it('fails closed and clears cached team data when status refresh is unavailable', async () => {
    vi.useFakeTimers()
    const status = vi.fn()
      .mockResolvedValueOnce(hostStatus)
      .mockRejectedValue(new Error('AgentsServer is unreachable'))
    installAPI({ overrides: { status } })
    const view = render(<TeamNetwork onClose={vi.fn()} />)

    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })
    expect(screen.getByText('Initial update')).toBeVisible()
    expect(view.container.querySelector('.teamspace-status-dot.authenticated')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh team network' }))
    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })

    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
    expect(screen.getByText('AgentsServer is unreachable')).toBeVisible()
    expect(view.container.querySelector('.teamspace-status-dot.authenticated')).toBeNull()
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('prefetches the current Feed during a profile switch and keeps its staged merge visibly syncing', async () => {
    vi.useFakeTimers()
    let activeStatus = hostStatus
    const peerDetails = deferred<TeamHubTeamDetails>()
    const peerProjection = deferred<TeamNetworkProjectionPage>()
    const peerBulletin = deferred<{ posts: TeamNetworkBulletinPost[]; next_after_sequence: number; has_more: boolean }>()
    const peerFeed = deferred<TeamMessagePage>()
    const status = vi.fn(() => Promise.resolve(activeStatus))
    const workspace = vi.fn((scope: { profileId: string }) => Promise.resolve(workspaceFor(
      scope.profileId === peerStatus.profileId ? peerStatus : hostStatus
    )))
    const team = vi.fn((scope: { profileId: string }) => (
      scope.profileId === peerStatus.profileId
        ? peerDetails.promise
        : Promise.resolve(detailsFor(hostStatus))
    ))
    const network = vi.fn((scope: { profileId: string }) => (
      scope.profileId === peerStatus.profileId
        ? peerProjection.promise
        : Promise.resolve(projectionFor(hostStatus))
    ))
    const bulletin = vi.fn((scope: { profileId: string }) => (
      scope.profileId === peerStatus.profileId
        ? peerBulletin.promise
        : Promise.resolve({ posts: [bulletinPost('host-legacy', 1, 'Host legacy bulletin')], next_after_sequence: 1, has_more: false })
    ))
    const teamMessages = vi.fn((scope: { profileId: string }, _query: { box: string }) => (
      scope.profileId === peerStatus.profileId
        ? peerFeed.promise
        : Promise.resolve({
          box: 'feed' as const,
          address: null,
          messages: [feedMessage('host-current', 2, 'Host current message', 'TargetApp')],
          next_after_sequence: 2,
          has_more: false
        })
    ))
    installAPI({ overrides: {
      status,
      workspace,
      team,
      network,
      bulletin,
      teamMessagesCapabilities: vi.fn().mockResolvedValue(teamMessagesCapability),
      teamMessages
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() })
    expect(screen.getByText('Host current message')).toBeVisible()
    expect(screen.queryByText(/Syncing current Bulletin posts/i)).not.toBeInTheDocument()

    activeStatus = peerStatus
    fireEvent.click(screen.getByRole('button', { name: 'Refresh team network' }))
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve()
    })

    // The V2 request starts as soon as its capability resolves, while all
    // three independent legacy/team-directory reads are still outstanding.
    expect(teamMessages).toHaveBeenCalledWith(expect.objectContaining({ profileId: peerStatus.profileId }), {
      teamId: 'team-1', box: 'feed', limit: 25
    })
    expect(screen.queryByText('Host current message')).not.toBeInTheDocument()

    await act(async () => {
      peerDetails.resolve(detailsFor(peerStatus))
      peerProjection.resolve(projectionFor(peerStatus))
      peerBulletin.resolve({ posts: [bulletinPost('peer-legacy', 1, 'Peer legacy bulletin')], next_after_sequence: 1, has_more: false })
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    // V2-capable peers must not render (or wait on) the legacy bulletin feed.
    expect(screen.queryByText('Peer legacy bulletin')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Syncing current Bulletin posts…')
    expect(screen.queryByText('Peer current message')).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Post to Bulletin' })).not.toBeInTheDocument()

    await act(async () => {
      peerFeed.resolve({
        box: 'feed',
        address: null,
        messages: [feedMessage('peer-current', 3, 'Peer current message')],
        next_after_sequence: 3,
        has_more: false
      })
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(screen.getByText('Peer current message')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Post to Bulletin' })).toBeVisible()
    expect(teamMessages.mock.calls.filter(([callScope]) => callScope.profileId === peerStatus.profileId)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Servers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bulletin' }))
    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })
    expect(teamMessages.mock.calls.filter(([callScope, query]) => (
      callScope.profileId === peerStatus.profileId && query.box === 'feed'
    ))).toHaveLength(2)
  })

  it('shows an explicit authenticated workspace error and retries the workspace load', async () => {
    const workspace = vi.fn()
      .mockRejectedValueOnce(new Error('Authenticated workspace is temporarily unavailable'))
      .mockResolvedValue(workspaceFor(hostStatus))
    installAPI({ overrides: { workspace } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Teamspace could not be loaded' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Authenticated workspace is temporarily unavailable')
    expect(screen.queryByText('Create your Team Network')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry Teamspace' }))
    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(workspace).toHaveBeenCalledTimes(2)
  })

  it('removes the prior Teamspace when a later authenticated workspace refresh fails', async () => {
    const workspace = vi.fn()
      .mockResolvedValueOnce(workspaceFor(hostStatus))
      .mockRejectedValueOnce(new Error('Replacement workspace is unavailable'))
    installAPI({ overrides: { workspace } })
    const view = render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()

    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'agent', id: 'agent-host' } }}
    />)

    expect(await screen.findByRole('heading', { name: 'Teamspace could not be loaded' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Replacement workspace is unavailable')
    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
    expect(workspace).toHaveBeenCalledTimes(2)
  })

  it('presents a server-managed Teamspace as a server-owned connection', async () => {
    const managed: TeamHubStatus = {
      ...hostStatus,
      serverManaged: true,
      authenticationMode: 'server',
      principal: { id: 'service_managed_server', display_name: 'TargetApp', kind: 'service' }
    }
    installAPI({
      statusValue: managed,
      workspaceValue: workspaceFor(managed),
      detailsValue: detailsFor(managed),
      projectionValue: projectionFor(managed)
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    const manage = await screen.findByRole('button', { name: 'Manage connection' })
    expect(screen.queryByRole('button', { name: 'Manage network' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite' })).toBeVisible()
    fireEvent.click(manage)
    expect(screen.getByRole('dialog', { name: 'Manage Teamspace connection' })).toBeVisible()
    expect(screen.getByText(/server-owned Teamspace and its data stay intact/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible()
  })

  it('retries a server-managed Teamspace in the foreground when its surface opens', async () => {
    const offline: TeamHubStatus = {
      ...hostStatus,
      serverManaged: true,
      authenticated: false,
      authenticationMode: undefined,
      connectionState: 'offline',
      principal: null,
      session: null,
      error: 'Teamspace will reconnect automatically.'
    }
    const connected: TeamHubStatus = {
      ...hostStatus,
      serverManaged: true,
      generation: offline.generation + 1,
      authenticationMode: 'server',
      principal: { id: 'service_managed_server', display_name: 'TargetApp', kind: 'service' }
    }
    const connect = vi.fn().mockResolvedValue(connected)
    installAPI({
      statusValue: offline,
      workspaceValue: workspaceFor(connected),
      detailsValue: detailsFor(connected),
      projectionValue: projectionFor(connected),
      overrides: { connect }
    })

    render(<TeamNetwork onClose={vi.fn()} />)

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect).toHaveBeenCalledWith({
      surfaceReconnect: {
        profileId: offline.profileId,
        profileGeneration: offline.profileGeneration,
        serverIdentity: offline.serverIdentity,
        generation: offline.generation
      }
    })
    expect(await screen.findByText('Initial update')).toBeVisible()
  })

  it('keeps an in-flight secure-peer reconnect in the loading view until its workspace is adopted', async () => {
    const disconnected: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      connectionState: 'connecting',
      principal: null,
      session: null,
      connectionId: undefined,
      hostServerIdentity: undefined,
      hubIdentity: null
    }
    const connected: TeamHubStatus = {
      ...peerStatus,
      generation: disconnected.generation + 1
    }
    const connectResult = deferred<TeamHubStatus>()
    const workspaceResult = deferred<TeamHubWorkspace>()
    const activeControl = {
      ...secureControl(disconnected),
      activeConnectionId: 'connection-peer',
      pairings: [securePairing({
        id: 'pairing-host',
        direction: 'outgoing',
        status: 'connected',
        trustState: 'approved',
        transportState: 'online',
        connectionId: 'connection-peer',
        hostServerIdentity: 'identity-host',
        hubIdentity: 'hub-team',
        teamId: 'team-1',
        teamDisplayName: 'Core team',
        grantedScopes: ['teamspace.read', 'teamspace.write']
      })]
    } satisfies SecurePeerControlStatus
    const connect = vi.fn(() => {
      // This assertion runs before React can commit connectNetwork's busy
      // update. It covers the paint between the initial status read and the
      // passive/secure-peer adoption effect that starts the reconnect.
      expect(screen.getByText('Opening team network…')).toBeVisible()
      const incomplete = screen.queryByText('Teamspace connection incomplete')
      if (incomplete) expect(incomplete).not.toBeVisible()
      return connectResult.promise
    })
    installAPI({
      statusValue: disconnected,
      overrides: {
        connect,
        workspace: vi.fn(() => workspaceResult.promise),
        securePeerStatus: vi.fn().mockResolvedValue(activeControl)
      }
    })

    render(<TeamNetwork onClose={vi.fn()} />)

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Opening team network…')).toBeVisible()
    expect(screen.getByText('Teamspace connection incomplete')).not.toBeVisible()

    await act(async () => { connectResult.resolve(connected) })
    await waitFor(() => expect(window.agentsDock.teamHub.workspace).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Opening team network…')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Teamspace could not be loaded' })).not.toBeInTheDocument()

    await act(async () => { workspaceResult.resolve(workspaceFor(connected)) })
    expect(await screen.findByText('Initial update')).toBeVisible()
  })

  it('waits for an explicit retry after a failed server-managed surface connection', async () => {
    vi.useFakeTimers()
    const offline: TeamHubStatus = {
      ...hostStatus,
      serverManaged: true,
      authenticated: false,
      authenticationMode: undefined,
      connectionState: 'offline',
      principal: null,
      session: null,
      error: 'Teamspace will reconnect automatically.'
    }
    const connect = vi.fn().mockResolvedValue(offline)
    installAPI({ statusValue: offline, overrides: { connect } })

    render(<TeamNetwork onClose={vi.fn()} />)

    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenLastCalledWith({
      surfaceReconnect: {
        profileId: offline.profileId,
        profileGeneration: offline.profileGeneration,
        serverIdentity: offline.serverIdentity,
        generation: offline.generation
      }
    })
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeVisible()

    await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
    expect(connect).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(connect).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith()
  })

  it('does not expose unsupported enrollment controls for a signed-out server-managed Teamspace', async () => {
    const managed: TeamHubStatus = {
      ...hostStatus,
      authenticated: false,
      serverManaged: true,
      backgroundReconnectAllowed: false,
      authenticationMode: undefined,
      connectionState: 'signed-out',
      principal: null,
      session: null
    }
    installAPI({ statusValue: managed })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Teamspace connection is paused' })).toBeVisible()
    expect(screen.queryByText('Use your invitation file')).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Recover signed-out device' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create team network' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
  })

  it('can open directly into the requested server Mail Board surface', async () => {
    installAPI()
    render(<TeamNetwork
      onClose={vi.fn()}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)

    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Mail' })).toHaveClass('active')
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
  })

  it('ignores a legacy human mailbox target and keeps the owned server inbox', async () => {
    installAPI()
    render(<TeamNetwork
      onClose={vi.fn()}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'human', id: 'owner' } }}
    />)

    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    const mailbox = screen.getByLabelText('Receiving mailbox')
    await waitFor(() => expect(mailbox).toHaveValue('server:server-host'))
    expect(within(mailbox).queryByRole('option', { name: 'My replies' })).not.toBeInTheDocument()
    expect(within(mailbox).queryByRole('option', { name: 'Georgia' })).not.toBeInTheDocument()
    expect(screen.getByText('/mail server <name> <message>')).toBeVisible()
  })

  it('navigates an already-open TeamNetwork to the exact Inbox requested by a notice', async () => {
    installAPI()
    const view = render(<TeamNetwork onClose={vi.fn()} />)
    expect(await screen.findByText('Initial update')).toBeVisible()

    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)

    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
  })

  it('keeps an already-open server Inbox when legacy agent or human notice targets arrive', async () => {
    const teamHub = installAPI()
    const view = render(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={1}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)
    expect(await screen.findByLabelText('Receiving mailbox')).toHaveValue('server:server-host')

    vi.mocked(teamHub.status).mockClear()
    vi.mocked(teamHub.mailbox).mockClear()
    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={2}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'agent', id: 'agent-host' } }}
    />)
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
    expect(teamHub.status).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: 'Georgia' })).not.toBeInTheDocument()

    vi.mocked(teamHub.mailbox).mockClear()
    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={3}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'human', id: 'owner' } }}
    />)
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
    expect(teamHub.status).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: 'My replies' })).not.toBeInTheDocument()
  })

  it('gives a new cross-team notice target precedence over the previously selected team', async () => {
    const teams = [
      { id: 'team-1', kind: 'shared', slug: 'one', display_name: 'Team one', role: 'owner' as const, status: 'active' },
      { id: 'team-2', kind: 'shared', slug: 'two', display_name: 'Team two', role: 'owner' as const, status: 'active' }
    ]
    const teamHub = installAPI({
      workspaceValue: workspaceFor(hostStatus, teams),
      overrides: {
        team: vi.fn().mockImplementation((_scope, teamId: string) => Promise.resolve(detailsFor(
          hostStatus,
          teamId,
          teamId === 'team-1' ? 'Team one' : 'Team two'
        ))),
        network: vi.fn().mockImplementation((_scope, query: { teamId: string }) => Promise.resolve(projectionFor(
          hostStatus,
          query.teamId,
          query.teamId === 'team-1' ? 'Team one' : 'Team two'
        ))),
        bulletin: vi.fn().mockResolvedValue({ posts: [], next_after_sequence: 0, has_more: false })
      }
    })
    const view = render(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={1}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)
    await waitFor(() => expect(screen.getByLabelText('Team')).toHaveValue('team-1'))

    vi.mocked(teamHub.mailbox).mockClear()
    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={2}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-2', address: { kind: 'server', id: 'server-host' } }}
    />)

    await waitFor(() => expect(screen.getByLabelText('Team')).toHaveValue('team-2'))
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
    expect(teamHub.mailbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      teamId: 'team-2',
      address: { kind: 'server', id: 'server-host' },
      afterSequence: 0
    }))
  })

  it('consumes each server-mail notice navigation once and reapplies it after a manual section change', async () => {
    installAPI()
    const view = render(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={1}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))

    fireEvent.click(screen.getByRole('button', { name: 'Bulletin' }))
    expect(await screen.findByText('Initial update')).toBeVisible()

    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={2}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)
    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))

    fireEvent.click(screen.getByRole('button', { name: 'Bulletin' }))
    expect(await screen.findByText('Initial update')).toBeVisible()

    view.rerender(<TeamNetwork
      onClose={vi.fn()}
      initialMailboxRequestId={3}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'server', id: 'server-host' } }}
    />)
    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-host'))
  })

  it('defaults to Mail and exposes Bulletin and Servers & People without a Skills section', async () => {
    installAPI()
    render(<TeamNetworkView onClose={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    const navigation = screen.getByRole('navigation', { name: 'Team Network sections' })
    expect(within(navigation).getAllByRole('button').map(button => button.getAttribute('aria-label') || button.textContent)).toEqual(['Mail', 'Bulletin', 'Servers & People'])
    expect(within(navigation).queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument()
    expect(within(navigation).getByRole('button', { name: 'Mail' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Invite' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Connect server' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('2 servers')).toBeVisible()
    fireEvent.click(within(navigation).getByRole('button', { name: 'Servers & People' }))
    const directory = screen.getByRole('region', { name: 'Servers and people' })
    expect(within(directory).getByText('Team members and connected servers.')).toBeVisible()
    expect(within(directory).getByText('TargetApp')).toBeVisible()
    expect(within(directory).getByText('Studio')).toBeVisible()
    expect(within(directory).queryByText('Georgia')).not.toBeInTheDocument()
    expect(within(directory).queryByText('Build agent')).not.toBeInTheDocument()
    expect(within(directory).queryByText('Agent directory')).not.toBeInTheDocument()
    const manageAccess = await within(directory).findByText('Manage access')
    const accessDetails = manageAccess.closest('details')!
    expect(accessDetails).not.toHaveAttribute('open')
    expect(within(directory).queryByText('Desktop')).not.toBeInTheDocument()
    fireEvent.click(manageAccess)
    expect(accessDetails).toHaveAttribute('open')
    expect(within(accessDetails).getByText(/Desktop \(this device\)/)).toBeVisible()
    expect(within(accessDetails).queryByText('Pending invitations')).not.toBeInTheDocument()
    expect(within(directory).queryByText(/May receive routed|This desktop can read|Can receive mail/i)).not.toBeInTheDocument()
    expect(within(directory).queryByText('ACCESS')).not.toBeInTheDocument()
  })

  it.each([hostStatus, managedHostStatus])('copies a Team invite link from the directory with $authenticationMode authentication', async (statusValue) => {
    const link = 'agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A' + 'a'.repeat(64)
    const control = secureControl(statusValue)
    control.host.pairingLink = link
    const createInvitation = vi.fn()
    const teamHub = installAPI({
      statusValue,
      workspaceValue: workspaceFor(statusValue),
      detailsValue: detailsFor(statusValue),
      projectionValue: projectionFor(statusValue),
      overrides: { createInvitation, securePeerStatus: vi.fn().mockResolvedValue(control) }
    })
    const user = userEvent.setup()
    render(<TeamNetwork onClose={vi.fn()} />)

    const headerInvite = await screen.findByRole('button', { name: 'Invite' })
    expect(headerInvite).toBeVisible()
    await user.click(screen.getByRole('button', { name: statusValue.serverManaged ? 'Servers' : 'Servers & People' }))
    const directory = screen.getByRole('region', { name: statusValue.serverManaged ? 'Servers' : 'Servers and people' })
    if (statusValue.serverManaged) {
      expect(within(directory).queryByRole('region', { name: 'People' })).not.toBeInTheDocument()
      expect(within(directory).queryByText(/\(you\)/)).not.toBeInTheDocument()
      expect(within(directory).queryByText('Manage access')).not.toBeInTheDocument()
    }
    expect(within(directory).queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
    await user.click(within(directory).getByRole('button', { name: 'Invite' }))

    const dialog = screen.getByRole('dialog', { name: 'Invite and connect servers' })
    await user.click(await within(dialog).findByRole('button', { name: 'Copy invite link' }))
    await waitFor(() => expect(window.agentsDock.native.writeClipboard).toHaveBeenCalledWith(link))
    expect(await within(dialog).findByRole('button', { name: 'Invite link copied' })).toBeVisible()
    expect(within(dialog).queryByRole('textbox', { name: 'Email' })).not.toBeInTheDocument()
    expect(createInvitation).not.toHaveBeenCalled()
    expect(teamHub.configureSecurePeerHost).not.toHaveBeenCalled()
    expect(teamHub.approveSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('keeps the peer directory free of host invitation controls', async () => {
    installAPI({
      statusValue: peerStatus,
      workspaceValue: workspaceFor(peerStatus),
      detailsValue: detailsFor(peerStatus),
      projectionValue: projectionFor(peerStatus)
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers' }))
    const directory = screen.getByRole('region', { name: 'Servers' })
    expect(within(directory).queryByRole('region', { name: 'People' })).not.toBeInTheDocument()
    expect(within(directory).queryByText('Manage access')).not.toBeInTheDocument()
    expect(within(directory).queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
    expect(within(directory).queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
  })

  it.each([
    ['human', 'human', true], ['human', 'server', false],
    ['server', 'server', true], ['paired_node', 'server', true],
    [undefined, 'server', false]
  ] as const)('passes authentication mode %s to skill poster deletion for %s authors', async (authenticationMode, authorKind, allowed) => {
    const statusValue: TeamHubStatus = {
      ...(authenticationMode === 'paired_node' ? peerStatus : hostStatus),
      authenticationMode
    }
    const ownServer = projectionFor(statusValue).servers.find(server => server.owned_by_caller)!
    const skill: TeamMessageSummary = {
      ...feedMessage('auth-kind-skill', 1, 'Preserved skill content'),
      kind: 'skill', title: 'Skill author permission',
      sender: {
        kind: authorKind,
        id: authorKind === 'human' ? statusValue.principal!.id : ownServer.id,
        display_name: 'Publisher'
      },
      skill: { id: 'skill-auth-kind', slug: 'auth-kind', version: 1 }
    }
    installAPI({ statusValue, overrides: {
      teamMessagesCapabilities: vi.fn().mockResolvedValue({ ...teamMessagesCapability, skill_announcement_deletion: true }),
      teamMessages: vi.fn().mockResolvedValue({ box: 'feed', address: null, messages: [skill], next_after_sequence: 1, has_more: false }),
      networkDeletions: vi.fn().mockResolvedValue({ supported: true, deletions: [], next_after_sequence: 0, has_more: false })
    } })
    render(<TeamNetwork onClose={vi.fn()} />)
    const card = (await screen.findByText('Skill author permission')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    if (allowed) expect(screen.getByRole('menuitem', { name: 'Delete Bulletin item…' })).toBeVisible()
    else expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
  })

  it('projects only caller-owned servers as Team Mail inbox addresses', async () => {
    const teamMessages = vi.fn((_scope, query: {
      box: 'inbox' | 'feed' | 'sent'
      addressKind?: 'server' | 'human'
      addressId?: string
    }) => Promise.resolve({
      box: query.box,
      address: query.box === 'inbox'
        ? { kind: query.addressKind!, id: query.addressId! }
        : null,
      messages: [],
      next_after_sequence: 0,
      has_more: false
    }))
    installAPI({ overrides: {
      teamMessagesCapabilities: vi.fn().mockResolvedValue(teamMessagesCapability),
      teamMessages
    } })
    render(<TeamNetworkView
      onClose={vi.fn()}
      initialSection="mail"
      initialMailboxTarget={{ teamId: 'team-1', address: { kind: 'human', id: 'owner' } }}
    />)

    expect(await screen.findByRole('heading', { name: 'Mail' })).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Address' })).not.toBeInTheDocument()
    expect(screen.queryByText('My replies')).not.toBeInTheDocument()
    expect(screen.queryByText('Georgia')).not.toBeInTheDocument()
    await waitFor(() => expect(teamMessages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      teamId: 'team-1',
      box: 'inbox',
      addressKind: 'server',
      addressId: 'server-host'
    })))
    expect(teamMessages.mock.calls.some(([, query]) => query.addressKind === 'human')).toBe(false)
  })

  it('opens the selected local chat and drafts a mail-reading request without sending it', async () => {
    const user = userEvent.setup()
    const directMail: TeamMessageSummary = {
      ...feedMessage('mail-route', 8, 'Please review the rollout.'),
      title: 'Review request',
      recipients: [{
        kind: 'server', id: 'server-host', display_name: 'TargetApp', state: 'available',
        delivered_at: null, read_at: null
      }]
    }
    const teamMessages = vi.fn((_scope, query: {
      box: 'inbox' | 'feed' | 'sent'
      addressKind?: 'server' | 'human'
      addressId?: string
    }) => Promise.resolve({
      box: query.box,
      address: query.box === 'inbox'
        ? { kind: query.addressKind!, id: query.addressId! }
        : null,
      messages: query.box === 'inbox' ? [directMail] : [],
      next_after_sequence: query.box === 'inbox' ? directMail.sequence : 0,
      has_more: false
    }))
    const selectSession = vi.fn(async (sessionId: string) => {
      useAppStore.setState({
        chatPanes: { primary: sessionId, secondary: null },
        selectedSessionId: sessionId
      })
    })
    const sendPromptForSession = vi.fn().mockResolvedValue(true)
    useAppStore.setState({
      sessions: [
        { id: 'chat-current', title: 'Current rollout', backend: 'codex', archived: false },
        { id: 'chat-review', title: 'Review desk', backend: 'claude', archived: false },
        { id: 'chat-archived', title: 'Old incident', backend: 'codex', archived: true }
      ],
      selectedSessionId: 'chat-current',
      loadingSessionIds: new Set(['chat-review']),
      loadingSessionId: null,
      drafts: { 'chat-review': 'Existing note' },
      selectSession,
      sendPromptForSession
    })
    const onClose = vi.fn()
    installAPI({ overrides: {
      teamMessagesCapabilities: vi.fn().mockResolvedValue(teamMessagesCapability),
      teamMessages
    } })

    render(<TeamNetworkView onClose={onClose} />)

    await user.click(await screen.findByRole('button', { name: 'Route Review request to a chat' }))
    const routeMenu = await screen.findByRole('menu')
    expect(within(routeMenu).getByRole('menuitem', { name: /Current rollout.*Current chat/ })).toBeVisible()
    expect(within(routeMenu).getByRole('menuitem', { name: 'Review desk' })).toBeVisible()
    expect(within(routeMenu).queryByRole('menuitem', { name: 'Old incident' })).not.toBeInTheDocument()
    await user.click(within(routeMenu).getByRole('menuitem', { name: 'Review desk' }))

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('chat-review'))
    const routedDraft = useAppStore.getState().drafts['chat-review']
    expect(routedDraft).toMatch(/^Existing note\n\nRead \[Review request\]\(agentsdock:\/\/team-message\?/)
    expect(routedDraft).toContain('teamId=team-1&messageId=mail-route')
    expect(routedDraft).toContain(') from @@Studio')
    expect(useAppStore.getState().teamReferencesBySession['chat-review']).toEqual([{
      kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'sender-mail-route',
      display_name_snapshot: 'Studio', source_text_start: routedDraft.indexOf('@@Studio'), source_text_end: routedDraft.length, grant_intent: true
    }])
    expect(sendPromptForSession).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('focuses, traps, dismisses, and restores focus for the invite dialog from the keyboard', async () => {
    installAPI()
    render(<TeamNetwork onClose={vi.fn()} />)
    const user = userEvent.setup()

    expect(await screen.findByText('Initial update')).toBeVisible()
    const trigger = screen.getByRole('button', { name: 'Invite' })
    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Invite and connect servers' })
    const close = screen.getByRole('button', { name: 'Close invite' })
    expect(close).toHaveFocus()

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(trigger).not.toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Invite and connect servers' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('shows Connect server—not Invite—for an authenticated peer', async () => {
    const securePeerWithDormantLocalBinding = {
      ...peerStatus,
      savedHubIdentity: 'hub-dormant-local',
      canForgetBinding: true
    }
    installAPI({ statusValue: securePeerWithDormantLocalBinding, workspaceValue: workspaceFor(securePeerWithDormantLocalBinding), detailsValue: detailsFor(securePeerWithDormantLocalBinding), projectionValue: projectionFor(securePeerWithDormantLocalBinding) })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connect server' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage network' })).not.toBeInTheDocument()
  })

  it('does not render a dead local binding action without a verified server identity', async () => {
    const unverified: TeamHubStatus = {
      ...hostStatus,
      serverIdentity: null,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      hubUrl: null,
      hubIdentity: null,
      savedHubIdentity: 'hub-team',
      connectionState: 'offline',
      canForgetBinding: true
    }
    installAPI({ statusValue: unverified })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Create your Team Network')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Manage network' })).not.toBeInTheDocument()
  })

  it('dismisses the local binding manager with Escape and returns focus to its trigger', async () => {
    installAPI()
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    const trigger = screen.getByRole('button', { name: 'Manage network' })
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Close local network manager' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Manage local network' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('disconnects and manually reconnects an ordinary saved local binding without an automatic reconnect', async () => {
    const disconnected: TeamHubStatus = {
      ...hostStatus,
      generation: hostStatus.generation + 1,
      connectionState: 'disconnected',
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null
    }
    const reconnected: TeamHubStatus = {
      ...disconnected,
      generation: hostStatus.generation + 2,
      connectionState: 'signed-out'
    }
    const workspace = vi.fn().mockResolvedValue(workspaceFor(hostStatus))
    const teamHub = installAPI({
      overrides: {
        workspace,
        disconnect: vi.fn().mockResolvedValue(disconnected),
        connect: vi.fn().mockResolvedValue(reconnected)
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    expect(screen.getByRole('dialog', { name: 'Manage local network' })).toBeVisible()
    expect(screen.getByText(/Disconnect signs this server out and clears its saved sign-in credential/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect & sign out' }))

    await waitFor(() => expect(teamHub.disconnect).toHaveBeenCalledWith({
      profileId: 'profile-host',
      profileGeneration: 3,
      serverIdentity: 'identity-host',
      generation: 4,
      hubIdentity: 'hub-team'
    }))
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    await act(async () => { await Promise.resolve() })
    expect(teamHub.connect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(1))
    expect(workspace).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Signed out')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Forget local network…' })).toBeVisible()
  })

  it('does not turn a persisted disconnect tombstone into foreground auto-connect work after remount', async () => {
    const disconnected: TeamHubStatus = {
      ...hostStatus,
      generation: hostStatus.generation + 1,
      connectionState: 'disconnected',
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      backgroundReconnectAllowed: false
    }
    const connect = vi.fn().mockResolvedValue(disconnected)
    installAPI({ statusValue: disconnected, overrides: { connect } })

    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Your local Team Network is disconnected')).toBeVisible()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(connect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect).toHaveBeenCalledWith()
  })

  it('disconnects, identity-fences, and forgets a local binding without rediscovering it', async () => {
    const disconnected: TeamHubStatus = {
      ...hostStatus,
      generation: hostStatus.generation + 1,
      connectionState: 'disconnected',
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null
    }
    const forgotten: TeamHubStatus = {
      ...disconnected,
      generation: disconnected.generation + 1,
      hubUrl: null,
      hubIdentity: null,
      savedHubIdentity: null,
      canForgetBinding: false
    }
    const teamHub = installAPI({
      overrides: {
        disconnect: vi.fn().mockResolvedValue(disconnected),
        forgetBinding: vi.fn().mockResolvedValue(forgotten),
        connect: vi.fn().mockResolvedValue(forgotten)
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    const forgetButton = screen.getByRole('button', { name: 'Forget local network…' })
    await waitFor(() => expect(forgetButton).toBeEnabled())
    fireEvent.click(forgetButton)
    expect(screen.getByText(/Disconnect this server, revoke its local session/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }))

    await waitFor(() => expect(teamHub.forgetBinding).toHaveBeenCalledWith({
      profileId: 'profile-host',
      profileGeneration: 3,
      serverIdentity: 'identity-host',
      expectedGeneration: 5,
      expectedHubIdentity: 'hub-team'
    }))
    expect(teamHub.disconnect).toHaveBeenCalledTimes(1)
    expect(teamHub.disconnect.mock.invocationCallOrder[0]).toBeLessThan(teamHub.forgetBinding.mock.invocationCallOrder[0])
    expect(await screen.findByText('No local Team Network binding is saved for this server.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeVisible()
    await act(async () => { await Promise.resolve() })
    expect(teamHub.connect).not.toHaveBeenCalled()
    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close local network manager' }))
    expect(screen.getByRole('button', { name: 'Connect network' })).toHaveTextContent('Connect network')
    fireEvent.click(screen.getByRole('button', { name: 'Connect network' }))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(1))
    expect(teamHub.connect).toHaveBeenCalledWith()
  })

  it('offers one explicit foreground Connect network after Forget and restart without auto-connecting', async () => {
    const forgotten: TeamHubStatus = {
      ...hostStatus,
      generation: hostStatus.generation + 1,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      hubUrl: null,
      hubIdentity: null,
      savedHubIdentity: null,
      transport: null,
      connectionState: 'disconnected',
      canForgetBinding: false,
      backgroundReconnectAllowed: false
    }
    const connect = vi.fn().mockResolvedValue({ ...forgotten, connectionState: 'signed-out' as const })
    installAPI({ statusValue: forgotten, overrides: { connect } })

    render(<TeamNetwork onClose={vi.fn()} />)

    const connectButton = await screen.findByRole('button', { name: 'Connect network' })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(connect).not.toHaveBeenCalled()

    fireEvent.click(connectButton)
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect).toHaveBeenCalledWith()
  })

  it('forgets an already-disconnected local binding without disconnecting it again', async () => {
    const disconnected: TeamHubStatus = {
      ...hostStatus,
      generation: hostStatus.generation + 1,
      connectionState: 'disconnected',
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null
    }
    const forgotten: TeamHubStatus = {
      ...disconnected,
      generation: disconnected.generation + 1,
      hubUrl: null,
      hubIdentity: null,
      savedHubIdentity: null,
      canForgetBinding: false
    }
    const disconnect = vi.fn().mockResolvedValue(disconnected)
    const forgetBinding = vi.fn().mockResolvedValue(forgotten)
    const teamHub = installAPI({ overrides: { disconnect, forgetBinding, connect: vi.fn() } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect & sign out' }))
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    disconnect.mockClear()

    const forgetButton = screen.getByRole('button', { name: 'Forget local network…' })
    await waitFor(() => expect(forgetButton).toBeEnabled())
    fireEvent.click(forgetButton)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm forget' }))
    await waitFor(() => expect(forgetBinding).toHaveBeenCalledWith({
      profileId: 'profile-host',
      profileGeneration: 3,
      serverIdentity: 'identity-host',
      expectedGeneration: 5,
      expectedHubIdentity: 'hub-team'
    }))
    expect(disconnect).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
    expect(teamHub.connect).not.toHaveBeenCalled()
  })

  it('forgets an offline saved local binding using its persisted identity without trying to disconnect or connect', async () => {
    const offline: TeamHubStatus = {
      ...hostStatus,
      connectionState: 'offline',
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      hubUrl: null,
      hubIdentity: null,
      savedHubIdentity: 'hub-team',
      canForgetBinding: true
    }
    const forgotten: TeamHubStatus = {
      ...offline,
      generation: offline.generation + 1,
      savedHubIdentity: null,
      canForgetBinding: false,
      connectionState: 'disconnected'
    }
    const disconnect = vi.fn()
    const forgetBinding = vi.fn().mockResolvedValue(forgotten)
    const connect = vi.fn()
    installAPI({ statusValue: offline, overrides: { disconnect, forgetBinding, connect } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'Manage network' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forget local network…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm forget' }))

    await waitFor(() => expect(forgetBinding).toHaveBeenCalledWith({
      profileId: 'profile-host',
      profileGeneration: 3,
      serverIdentity: 'identity-host',
      expectedGeneration: 4,
      expectedHubIdentity: 'hub-team'
    }))
    expect(disconnect).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('opens the peer connection sheet with a deep-link invite prefilled but does not auto-connect', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`
    const handled = vi.fn()
    const idlePeer = {
      ...peerStatus,
      transport: 'loopback' as const,
      authenticationMode: 'human' as const,
      connectionId: undefined,
      hostServerIdentity: undefined,
      principal: hostStatus.principal
    }
    const teamHub = installAPI({ statusValue: idlePeer, workspaceValue: workspaceFor(idlePeer), detailsValue: detailsFor(idlePeer), projectionValue: projectionFor(idlePeer) })

    render(<TeamNetwork
      onClose={vi.fn()}
      pendingSecurePeerInvite={{ id: 11, invite: link }}
      onSecurePeerInviteHandled={handled}
    />)

    expect(await screen.findByRole('dialog', { name: 'Invite and connect servers' })).toBeVisible()
    expect(await screen.findByLabelText('Server invite')).toHaveValue(link)
    expect(handled).not.toHaveBeenCalled()
    expect(teamHub.requestSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('keeps a peer deep-link invite on the host until explicitly cancelled', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`
    const handled = vi.fn()
    const teamHub = installAPI()

    render(<TeamNetwork
      onClose={vi.fn()}
      pendingSecurePeerInvite={{ id: 12, invite: link }}
      onSecurePeerInviteHandled={handled}
    />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Invite and connect servers' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    expect(teamHub.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(handled).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: 'Pending team invite' })).toHaveTextContent('Choose another server')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invite' }))
    expect(handled).toHaveBeenCalledWith(12)
  })

  it('makes server invite paste the primary path for a signed-out peer', async () => {
    const signedOut = { ...peerStatus, authenticated: false, authenticationMode: undefined, principal: null, session: null, connectionId: undefined, connectionState: 'signed-out' as const }
    installAPI({ statusValue: signedOut })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByLabelText('Server invite')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connect this server' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /copy invite link/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Start a new network on this server, or connect it to one you already have/i)).toBeVisible()
    expect(screen.queryByText('Use your invitation file')).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Recover signed-out device' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Human sign-in is unavailable/)).not.toBeInTheDocument()
  })

  it('offers to make an unconfigured server the main Team Network host', async () => {
    const signedOut: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionId: undefined,
      hostServerIdentity: undefined,
      transport: null,
      backgroundReconnectAllowed: false,
      connectionState: 'unavailable'
    }
    const onClose = vi.fn()
    let setupDetail: unknown
    const captureSetup = (event: Event) => { setupDetail = (event as CustomEvent).detail }
    window.addEventListener('agentsdock:server-setup', captureSetup)
    installAPI({ statusValue: signedOut })
    render(<TeamNetwork onClose={onClose} />)

    expect(await screen.findByRole('heading', { name: 'Set up Team Network' })).toBeVisible()
    expect(screen.getByText('Start a new network on this server, or connect it to one you already have.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Start a new Team Network here/ }))

    expect(onClose).toHaveBeenCalledOnce()
    await waitFor(() => expect(setupDetail).toEqual({
      mode: 'configure-active',
      intent: 'host-team-network',
      origin: {
        profileId: signedOut.profileId,
        profileGeneration: signedOut.profileGeneration,
        serverIdentity: signedOut.serverIdentity,
        serverName: signedOut.serverName
      }
    }))
    window.removeEventListener('agentsdock:server-setup', captureSetup)
  })

  it('finishes an approved secure pairing by connecting Team Hub and entering the network automatically', async () => {
    const signedOut: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionId: undefined,
      hostServerIdentity: undefined,
      transport: null,
      connectionState: 'signed-out'
    }
    const pending = securePairing()
    const approved = securePairing({
      status: 'approved',
      trustState: 'approved',
      connectionId: 'connection-peer',
      hubIdentity: 'hub-team',
      teamId: 'team-1',
      teamDisplayName: 'Core team',
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      certificateFingerprint: `sha256:${'d'.repeat(64)}`,
      certificateExpiresAt: '2027-01-01T00:00:00Z'
    })
    const active = secureControl(signedOut)
    active.activeConnectionId = 'connection-peer'
    active.pairings = [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:00:00Z' }]
    const awaitingApproval = secureControl(signedOut)
    awaitingApproval.pairings = [pending]
    const connected: TeamHubStatus = {
      ...peerStatus,
      generation: signedOut.generation + 1,
      connectionState: 'authenticated',
      authenticated: true
    }
    const teamHub = installAPI({
      statusValue: signedOut,
      workspaceValue: workspaceFor(connected),
      detailsValue: detailsFor(connected),
      projectionValue: projectionFor(connected),
      overrides: {
        connect: vi.fn().mockResolvedValue(connected),
        securePeerStatus: vi.fn()
          .mockResolvedValueOnce(secureControl(signedOut))
          .mockResolvedValue(awaitingApproval),
        requestSecurePeerPairing: vi.fn().mockResolvedValue(pending),
        refreshSecurePeerPairing: vi.fn().mockResolvedValue(approved),
        activateSecurePeerPairing: vi.fn().mockResolvedValue(active)
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))

    await waitFor(() => expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing.mock.invocationCallOrder[0]).toBeLessThan(teamHub.connect.mock.invocationCallOrder[0])
    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.queryByText('Bring this server into your network')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
    expect(window.localStorage).toHaveLength(0)
  })

  it('automatically enters Team Network from an already-active route without a saved binding', async () => {
    const stranded: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionState: 'signed-out',
      backgroundReconnectAllowed: false,
      error: null
    }
    const active = secureControl(stranded)
    active.activeConnectionId = 'connection-peer'
    active.pairings = [securePairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId: 'connection-peer',
      hubIdentity: 'hub-team',
      teamId: 'team-1',
      teamDisplayName: 'Core team',
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      certificateFingerprint: `sha256:${'d'.repeat(64)}`,
      certificateExpiresAt: '2027-01-01T00:00:00Z',
      lastSeenAt: '2026-08-28T12:00:00Z'
    })]
    const connected: TeamHubStatus = {
      ...peerStatus,
      generation: stranded.generation + 1,
      connectionState: 'authenticated',
      authenticated: true
    }
    const teamHub = installAPI({
      statusValue: stranded,
      workspaceValue: workspaceFor(connected),
      detailsValue: detailsFor(connected),
      projectionValue: projectionFor(connected),
      overrides: {
        connect: vi.fn().mockResolvedValue(connected),
        securePeerStatus: vi.fn().mockResolvedValue(active)
      }
    })

    render(<TeamNetwork onClose={vi.fn()} />)

    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.queryByText('Bring this server into your network')).not.toBeInTheDocument()
  })

  it('keeps a degraded peer failure in one recovery card without a duplicate generic banner', async () => {
    const disconnected: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      connectionState: 'disconnected',
      principal: null,
      session: null,
      error: null
    }
    const failed: TeamHubStatus = {
      ...disconnected,
      connectionState: 'error',
      error: 'The active secure peer connection is unavailable.'
    }
    const degraded = secureControl(disconnected)
    degraded.activeConnectionId = 'connection-peer'
    degraded.connectionError = 'Peer cross-chat approval is not current'
    degraded.pairings = [{
      id: 'pairing-peer',
      direction: 'outgoing',
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      peerServerIdentity: 'identity-host',
      peerDisplayName: 'TargetApp',
      remoteEndpoint: '100.64.0.1:7851',
      hostServerIdentity: 'identity-host',
      hostCaFingerprint: `sha256:${'a'.repeat(64)}`,
      peerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`,
      transcriptHash: 'c'.repeat(64),
      sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
      requestedScopes: ['teamspace.read', 'teamspace.write'],
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      teamId: 'team-1',
      teamDisplayName: 'Core team',
      hubIdentity: 'hub-team',
      connectionId: 'connection-peer',
      localProxyBasePath: '/api/secure-peer/connections/connection-peer/team-hub',
      certificateExpiresAt: '2027-01-01T00:00:00Z',
      certificateFingerprint: `sha256:${'d'.repeat(64)}`,
      lastSeenAt: null,
      expiresAt: null,
      error: null
    }]
    const teamHub = installAPI({
      statusValue: disconnected,
      overrides: {
        connect: vi.fn().mockResolvedValue(failed),
        securePeerStatus: vi.fn().mockResolvedValue(degraded)
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Peer cross-chat approval is not current')).toBeVisible()
    // The ordinary disconnected-state probe runs first, then the newly loaded
    // active peer route gets one bounded adoption attempt of its own.
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('The active secure peer connection is unavailable.')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(3))
  })

  it('waits for explicit reconnect after a failed connection advances its lifecycle', async () => {
    const disconnected: TeamHubStatus = {
      ...hostStatus,
      authenticated: false,
      connectionState: 'disconnected',
      principal: null,
      session: null,
      error: null
    }
    const failed: TeamHubStatus = {
      ...disconnected,
      connectionState: 'error',
      error: 'The Team Hub connection failed.'
    }
    const nextLifecycle: TeamHubStatus = {
      ...disconnected,
      generation: disconnected.generation + 1
    }
    const teamHub = installAPI({
      statusValue: disconnected,
      overrides: {
        connect: vi.fn()
          .mockResolvedValueOnce(failed)
          .mockResolvedValueOnce(nextLifecycle)
          .mockResolvedValueOnce(failed)
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(1))
    expect(teamHub.connect).toHaveBeenNthCalledWith(1, {
      surfaceReconnect: {
        profileId: disconnected.profileId,
        profileGeneration: disconnected.profileGeneration,
        serverIdentity: disconnected.serverIdentity,
        generation: disconnected.generation
      }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(2))
    expect(teamHub.connect).toHaveBeenNthCalledWith(2)
    fireEvent.click(screen.getByRole('button', { name: 'Manage network' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(teamHub.connect).toHaveBeenCalledTimes(3))
    expect(teamHub.connect).toHaveBeenNthCalledWith(3)
  })

  it('does not duplicate bootstrap calls and ignores a stale team-switch response', async () => {
    const teams = [
      { id: 'team-1', kind: 'shared', slug: 'one', display_name: 'Team one', role: 'owner' as const, status: 'active' },
      { id: 'team-2', kind: 'shared', slug: 'two', display_name: 'Team two', role: 'owner' as const, status: 'active' }
    ]
    const staleDetails = deferred<TeamHubTeamDetails>()
    const staleProjection = deferred<TeamNetworkProjectionPage>()
    const staleBulletin = deferred<{ posts: TeamNetworkBulletinPost[]; next_after_sequence: number; has_more: boolean }>()
    const team = vi.fn().mockImplementation((_scope, teamId: string) => teamId === 'team-2' ? staleDetails.promise : Promise.resolve(detailsFor(hostStatus, 'team-1', 'Team one')))
    const network = vi.fn().mockImplementation((_scope, query: { teamId: string }) => query.teamId === 'team-2' ? staleProjection.promise : Promise.resolve(projectionFor(hostStatus, 'team-1', 'Team one')))
    const bulletin = vi.fn().mockImplementation((_scope, query) => query.teamId === 'team-2' ? staleBulletin.promise : Promise.resolve({ posts: [bulletinPost('one', 1, 'Team one post')], next_after_sequence: 1, has_more: false }))
    const teamHub = installAPI({ workspaceValue: workspaceFor(hostStatus, teams), overrides: { team, network, bulletin } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Team one post')).toBeVisible()
    const picker = screen.getByLabelText('Team')
    fireEvent.change(picker, { target: { value: 'team-2' } })
    fireEvent.change(picker, { target: { value: 'team-1' } })
    await waitFor(() => expect(screen.getByText('Team one post')).toBeVisible())

    await act(async () => {
      staleDetails.resolve(detailsFor(hostStatus, 'team-2', 'Team two'))
      staleProjection.resolve(projectionFor(hostStatus, 'team-2', 'Team two'))
      staleBulletin.resolve({ posts: [bulletinPost('two', 1, 'Stale team two post')], next_after_sequence: 1, has_more: false })
    })
    expect(screen.queryByText('Stale team two post')).not.toBeInTheDocument()
    expect(teamHub.status).toHaveBeenCalledTimes(1)
    expect(teamHub.workspace).toHaveBeenCalledTimes(1)
  })

  it('paints the first network page while scanning for the caller-owned server', async () => {
    const identity = { id: 'team-1', display_name: 'Core team', hub_id: 'hub-team' }
    const remote = {
      network: identity,
      servers: [{ id: 'server-a', server_identity: 'identity-a', display_name: 'Remote A', status: 'active' as const, is_host: false, owned_by_caller: false }],
      agents: [{ id: 'agent-a', server_id: 'server-a', external_agent_id: 'chat-a', backend: 'codex' as const, display_name: 'Agent A', status: 'active' as const }],
      next_after_server_id: 'server-a',
      has_more: true
    }
    const owned = {
      network: identity,
      servers: [{ id: 'server-m', server_identity: 'identity-host', display_name: 'Local M', status: 'active' as const, is_host: true, owned_by_caller: true }],
      agents: [{ id: 'agent-m', server_id: 'server-m', external_agent_id: 'chat-m', backend: 'codex' as const, display_name: 'Agent M', status: 'active' as const }],
      next_after_server_id: 'server-m',
      has_more: true
    }
    const late = {
      network: identity,
      servers: [{ id: 'server-z', server_identity: 'identity-z', display_name: 'Late Z', status: 'active' as const, is_host: false, owned_by_caller: false }],
      agents: [],
      next_after_server_id: 'server-z',
      has_more: false
    }
    const ownedPage = deferred<TeamNetworkProjectionPage>()
    const network = vi.fn().mockImplementation((_scope, query: { afterServerId?: string }) => (
      query.afterServerId === 'server-m'
        ? Promise.resolve(late)
        : query.afterServerId === 'server-a'
          ? ownedPage.promise
          : Promise.resolve(remote)
    ))
    installAPI({ overrides: { network } })
    render(<TeamNetwork onClose={vi.fn()} />)

    await waitFor(() => expect(network).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    await act(async () => { ownedPage.resolve(owned) })

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    expect(await screen.findByText('Local M')).toBeVisible()
    expect(screen.getByText('Remote A')).toBeVisible()
    expect(screen.queryByText('Late Z')).not.toBeInTheDocument()
    expect(network).toHaveBeenNthCalledWith(1, expect.anything(), { teamId: 'team-1', limit: 100 })
    expect(network).toHaveBeenNthCalledWith(2, expect.anything(), { teamId: 'team-1', afterServerId: 'server-a', limit: 100 })

    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    const localMailbox = screen.getByLabelText('Receiving mailbox')
    expect(localMailbox).toHaveValue('server:server-m')
    expect(within(localMailbox).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose mailbox', 'Local M'])
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more servers' }))

    expect(await screen.findByText('Late Z')).toBeVisible()
    expect(network).toHaveBeenNthCalledWith(3, expect.anything(), { teamId: 'team-1', afterServerId: 'server-m', limit: 100 })
    expect(screen.queryByRole('button', { name: 'Load more servers' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    expect(screen.getByLabelText('Receiving mailbox')).toHaveValue('server:server-m')
  })

  it('rejects duplicate IDs in the initial human directory page', async () => {
    const duplicate = {
      principal_id: 'owner', email: 'owner@example.test', display_name: 'Owner',
      role: 'owner' as const, status: 'active'
    }
    installAPI({ detailsValue: {
      ...detailsFor(hostStatus),
      members: [duplicate, { ...duplicate, display_name: 'Forged duplicate' }],
      membersHasMore: true,
      membersNextCursor: 'members-a'
    } })

    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Team members returned duplicate items')
  })

  it('rejects A-to-B-to-A continuation cycles for invitations and device sessions', async () => {
    const invitation = {
      id: 'invite-1', invitee_email: 'member@example.test', role: 'member' as const,
      issued_by_principal_id: 'owner', created_at: '2026-09-05T00:00:00Z',
      expires_at: '2026-09-06T00:00:00Z'
    }
    const device = {
      id: 'session', device_label: 'Desktop', created_at: '2026-08-01T00:00:00Z',
      last_seen_at: '2026-09-05T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
      revoked_at: null, current: true
    }
    const invitations = vi.fn()
      .mockResolvedValueOnce({ invitations: [invitation], has_more: true, next_cursor: 'invite-a' })
      .mockResolvedValueOnce({ invitations: [], has_more: true, next_cursor: 'invite-b' })
      .mockResolvedValueOnce({ invitations: [], has_more: true, next_cursor: 'invite-a' })
    const deviceSessions = vi.fn()
      .mockResolvedValueOnce({ sessions: [device], has_more: true, next_cursor: 'device-a' })
      .mockResolvedValueOnce({ sessions: [], has_more: true, next_cursor: 'device-b' })
      .mockResolvedValueOnce({ sessions: [], has_more: true, next_cursor: 'device-a' })
    installAPI({ overrides: { invitations, deviceSessions } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    const invitationsButton = await screen.findByRole('button', { name: 'Load more invitations' })
    fireEvent.click(invitationsButton)
    await waitFor(() => expect(invitations).toHaveBeenCalledTimes(2))
    fireEvent.click(invitationsButton)
    expect(await screen.findByRole('alert')).toHaveTextContent('Pending invitations returned a stalled continuation')

    const devicesButton = screen.getByRole('button', { name: 'Load more devices' })
    fireEvent.click(devicesButton)
    await waitFor(() => expect(deviceSessions).toHaveBeenCalledTimes(2))
    fireEvent.click(devicesButton)
    expect(await screen.findByRole('alert')).toHaveTextContent('Device sessions returned a stalled continuation')
  })

  it('requires exactly one matching current device session when the final page arrives', async () => {
    const deviceSessions = vi.fn()
      .mockResolvedValueOnce({
        sessions: [{
          id: 'session', device_label: 'Desktop', created_at: '2026-08-01T00:00:00Z',
          last_seen_at: '2026-09-05T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
          revoked_at: null, current: true
        }],
        has_more: true,
        next_cursor: 'device-a'
      })
      .mockResolvedValueOnce({
        sessions: [{
          id: 'forged-current', device_label: 'Other', created_at: '2026-08-02T00:00:00Z',
          last_seen_at: '2026-09-05T00:00:00Z', expires_at: '2027-01-01T00:00:00Z',
          revoked_at: null, current: true
        }],
        has_more: false,
        next_cursor: null
      })
    installAPI({ overrides: { deviceSessions } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more devices' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Device sessions did not include exactly one matching current session after the final page'
    )
    expect(deviceSessions).toHaveBeenCalledTimes(2)
  })

  it('keeps the proven first member page when a cycle or incomplete final page is returned', async () => {
    const owner = {
      principal_id: 'owner', email: 'owner@example.test', display_name: 'Owner',
      role: 'owner' as const, status: 'active'
    }
    const details = {
      ...detailsFor(hostStatus),
      members: [owner],
      membersHasMore: true,
      membersNextCursor: 'members-a',
      channels: [{ id: 'channel-private', participants: ['owner', 'person-later'] } as never]
    }
    const members = vi.fn()
      .mockResolvedValueOnce({ members: [], has_more: true, next_cursor: 'members-b' })
      .mockResolvedValueOnce({ members: [], has_more: true, next_cursor: 'members-a' })
    installAPI({ detailsValue: details, overrides: { members } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    const button = await screen.findByRole('button', { name: 'Load more people' })
    fireEvent.click(button)
    await waitFor(() => expect(members).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('Team members returned a stalled continuation')
    expect(screen.getByText('Owner (you)')).toBeVisible()

    members.mockResolvedValueOnce({ members: [], has_more: false, next_cursor: null })
    // The rejected cycle did not advance the proven cursor, so an explicit
    // retry requests members-b and must reject an incomplete final directory.
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Team members did not include every channel participant after the final page'
    )
    expect(screen.getByText('Owner (you)')).toBeVisible()
  })

  it('ignores a late roster page after switching teams', async () => {
    const teams = [
      { id: 'team-1', kind: 'shared', slug: 'one', display_name: 'Team one', role: 'owner' as const, status: 'active' },
      { id: 'team-2', kind: 'shared', slug: 'two', display_name: 'Team two', role: 'owner' as const, status: 'active' }
    ]
    const first = { ...projectionFor(hostStatus, 'team-1', 'Team one'), next_after_server_id: 'server-peer', has_more: true }
    const late = deferred<TeamNetworkProjectionPage>()
    const network = vi.fn().mockImplementation((_scope, query: { teamId: string; afterServerId?: string }) => {
      if (query.teamId === 'team-1' && query.afterServerId) return late.promise
      return Promise.resolve(query.teamId === 'team-2'
        ? projectionFor(hostStatus, 'team-2', 'Team two')
        : first)
    })
    installAPI({ workspaceValue: workspaceFor(hostStatus, teams), overrides: {
      network,
      team: vi.fn().mockImplementation((_scope, teamId: string) => Promise.resolve(detailsFor(hostStatus, teamId, teamId === 'team-1' ? 'Team one' : 'Team two'))),
      bulletin: vi.fn().mockResolvedValue({ posts: [], next_after_sequence: 0, has_more: false })
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more servers' }))
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'team-2' } })
    await waitFor(() => expect(document.querySelector('.team-network-nav-heading strong')).toHaveTextContent('Team two'))

    await act(async () => late.resolve({
      network: first.network,
      servers: [{ id: 'server-z', server_identity: 'identity-z', display_name: 'Stale Z', status: 'active', is_host: false, owned_by_caller: false }],
      agents: [],
      next_after_server_id: 'server-z',
      has_more: false
    }))
    expect(screen.queryByText('Stale Z')).not.toBeInTheDocument()
  })

  it('rejects an overlapping roster page without replacing the visible roster', async () => {
    const first = { ...projectionFor(hostStatus), next_after_server_id: 'server-peer', has_more: true }
    const network = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        network: first.network,
        servers: [{ ...first.servers[1], id: 'server-z' }],
        agents: [],
        next_after_server_id: 'server-z',
        has_more: false
      })
    installAPI({ overrides: { network } })
    render(<TeamNetwork onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Servers & People' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more servers' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Team Network returned an overlapping server page')
    expect(screen.getAllByText('TargetApp').length).toBeGreaterThan(0)
    expect(screen.getByText('Studio')).toBeVisible()
  })

  it('refreshes and posts through the singleton Bulletin API', async () => {
    vi.useFakeTimers()
    const bulletin = vi.fn()
      .mockResolvedValueOnce({ posts: [bulletinPost('initial', 1, 'Initial update')], next_after_sequence: 1, has_more: true })
      .mockResolvedValue({ posts: [bulletinPost('polled', 2, 'Polled update')], next_after_sequence: 2, has_more: false })
    const teamHub = installAPI({ overrides: {
      bulletin,
      postBulletin: vi.fn().mockResolvedValue(bulletinPost('mine', 10, 'Posted update'))
    } })
    render(<TeamNetwork onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Initial update')).toBeVisible()

    fireEvent.change(screen.getByLabelText('Bulletin post'), { target: { value: 'Posted update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Posted update')).toBeVisible()
    expect(teamHub.postBulletin).toHaveBeenCalledWith(expect.anything(), {
      teamId: 'team-1', body: 'Posted update', bodyFormat: 'plain', idempotencyKey: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh team network' }))
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() })
    expect(screen.getByText('Polled update')).toBeVisible()
    expect(bulletin).toHaveBeenLastCalledWith(expect.anything(), { teamId: 'team-1', afterSequence: 0 })
  })

  it('records delivery in the background and marks only an opened sender bundle read', async () => {
    const teamHub = installAPI()
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    await waitFor(() => expect(teamHub.recordDeliveryReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliveryId: 'delivery-1', state: 'delivered' })))
    expect(teamHub.recordDeliveryReceipt.mock.calls.some(([, input]) => input.state === 'read')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    expect(await screen.findByRole('heading', { name: 'Mail Board' })).toBeVisible()
    expect(screen.getByText('/mail server <name> <message>')).toBeVisible()
    expect(screen.queryByRole('form', { name: 'Compose direct mail' })).not.toBeInTheDocument()
    expect(teamHub.recordDeliveryReceipt.mock.calls.some(([, input]) => input.state === 'read')).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: /Build agent, 1 item, 1 unread/ }))
    await waitFor(() => expect(teamHub.recordDeliveryReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliveryId: 'delivery-1', state: 'read' })))
    expect(screen.getByRole('region', { name: 'Mail from Build agent' })).toHaveTextContent('Please review the rollout.')
    const backButton = screen.getByRole('button', { name: 'Back to mail board' })
    expect(backButton).toHaveFocus()
    expect(screen.getByRole('article', { name: 'request' })).toHaveTextContent('Request history')
    expect(screen.queryByLabelText('Request reply')).not.toBeInTheDocument()
    expect(teamHub.sendMailbox).not.toHaveBeenCalled()
    expect(teamHub.createPassiveRequest).not.toHaveBeenCalled()
    expect(teamHub.replyPassiveRequest).not.toHaveBeenCalled()

    fireEvent.click(backButton)
    expect(await screen.findByRole('region', { name: 'Received mail bundles' })).toBeVisible()
    const returnedBundle = screen.getByRole('button', { name: /Build agent, 1 item/ })
    await waitFor(() => expect(returnedBundle).toHaveFocus())
    fireEvent.click(returnedBundle)
    expect(screen.getByRole('button', { name: 'Back to mail board' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByRole('region', { name: 'Received mail bundles' })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: /Build agent, 1 item/ })).toHaveFocus())
  })

  it('keeps direct mail out of Bulletin and unread until its bundle is opened', async () => {
    const initial = mailboxEntry()
    const readEvent = vi.fn()
    window.addEventListener('agentsdock:team-network-mail-read', readEvent)
    const readReceipt = deferred<TeamNetworkMailboxEntry['delivery']>()
    const recordDeliveryReceipt = vi.fn().mockImplementation((_scope, input: { state: 'delivered' | 'read' }) => {
      if (input.state === 'read') return readReceipt.promise
      return Promise.resolve({
        ...initial.delivery,
        state: 'delivered' as const,
        delivered_at: '2026-08-24T12:01:00Z'
      })
    })
    installAPI({ overrides: { recordDeliveryReceipt } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    expect(screen.getByText('Broadcast to everyone.')).toBeVisible()
    expect(screen.queryByText('Please review the rollout.')).not.toBeInTheDocument()
    await waitFor(() => expect(recordDeliveryReceipt).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ state: 'delivered' })
    ))

    const mailboxButton = screen.getByRole('button', { name: 'Mail' })
    expect(mailboxButton).toHaveAccessibleDescription('1 unread item')
    expect(within(mailboxButton).getByText('1')).toBeVisible()
    fireEvent.click(mailboxButton)

    expect(screen.queryByText('Initial update')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Mail Board' })).toBeVisible()
    const unreadBundle = await screen.findByRole('button', { name: /Build agent, 1 item, 1 unread/ })
    expect(unreadBundle).toHaveClass('unread')
    expect(screen.getByText(/1 unread · Use/)).toBeVisible()
    expect(recordDeliveryReceipt.mock.calls.some(([, input]) => input.state === 'read')).toBe(false)

    fireEvent.click(unreadBundle)
    const unreadRow = await screen.findByRole('article', { name: 'Unread request' })
    expect(unreadRow).toHaveClass('unread')

    await act(async () => {
      readReceipt.resolve({
        ...initial.delivery,
        state: 'read',
        delivered_at: '2026-08-24T12:01:00Z',
        read_at: '2026-08-24T12:02:00Z'
      })
      await readReceipt.promise
    })
    await waitFor(() => expect(unreadRow).not.toHaveClass('unread'))
    expect((readEvent.mock.calls[0][0] as CustomEvent).detail).toEqual({ deliveryId: initial.delivery.id })
    expect(screen.getByRole('article', { name: 'request' })).toHaveTextContent('Read · Request history')
    expect(mailboxButton).not.toHaveAccessibleDescription()
    window.removeEventListener('agentsdock:team-network-mail-read', readEvent)
  })

  it('marks refreshed arrivals read while their sender bundle remains open', async () => {
    vi.useFakeTimers()
    const initial = mailboxEntry('read')
    const later: TeamNetworkMailboxEntry = {
      item: { ...initial.item, id: 'mail-2', sequence: 2, body: 'New mail while open.' },
      delivery: { ...initial.delivery, id: 'delivery-2', state: 'available', delivered_at: null, read_at: null }
    }
    const mailbox = vi.fn().mockImplementation((_scope, query: { afterSequence: number }) => Promise.resolve(query.afterSequence > 0
      ? { items: [later], next_after_sequence: 2, has_more: false }
      : { items: [initial], next_after_sequence: 1, has_more: false }))
    const recordDeliveryReceipt = vi.fn().mockImplementation((_scope, input: { deliveryId: string; state: 'delivered' | 'read' }) => Promise.resolve({
      id: input.deliveryId,
      state: input.state,
      available_at: initial.delivery.available_at,
      delivered_at: '2026-08-24T12:01:00Z',
      read_at: input.state === 'read' ? '2026-08-24T12:02:00Z' : null
    }))
    installAPI({ overrides: { mailbox, recordDeliveryReceipt } })
    render(<TeamNetwork onClose={vi.fn()} />)

    await act(async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    await act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: /Build agent, 1 item/ }))
    mailbox.mockResolvedValue({ items: [initial, later], next_after_sequence: 2, has_more: false })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh team network' }))
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve()
    })

    expect(screen.getByText('New mail while open.')).toBeVisible()
    expect(recordDeliveryReceipt).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ deliveryId: 'delivery-2', state: 'read' })
    )
  })

  it('renders one concise row per server without cross-server agent directory entries', async () => {
    const projection = projectionFor(hostStatus)
    projection.agents.push({ id: 'agent-host-2', server_id: 'server-host', external_agent_id: 'agent-review', backend: 'other', display_name: 'Review agent', status: 'offline' })
    installAPI({ projectionValue: projection })
    const view = render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    const rows = view.container.querySelectorAll('.network-roster-server')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('TargetApp')).toBeVisible()
    expect(within(rows[1] as HTMLElement).getByText('Studio')).toBeVisible()
    expect(screen.queryByText('Georgia')).not.toBeInTheDocument()
    expect(screen.queryByText('Review agent')).not.toBeInTheDocument()
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Inbox' })).toBeVisible()
    expect(within(rows[0] as HTMLElement).queryByText(/Inbox:|Invite:|Publish:|Revoke:|ACCESS/i)).not.toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).queryByText(/Inbox:|Invite:|Publish:|Revoke:|ACCESS/i)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/certificate|credential|transcript/i)
  })

  it('removes optional agent registration from Servers & People', async () => {
    const projection = projectionFor(hostStatus)
    projection.agents = []
    const teamHub = installAPI({ projectionValue: projection })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))

    expect(screen.queryByText('No optional agent directory entries.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add this server’s agent' })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent directory')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish agent directory entry…' })).not.toBeInTheDocument()
    expect(teamHub.registerNetworkAgent).not.toHaveBeenCalled()
  })

  it('lets a host owner revoke the exact secure peer and immediately removes its server and agents', async () => {
    const matching = approvedIncomingPairing()
    const unrelated = approvedIncomingPairing({
      id: 'pairing-other',
      peerServerIdentity: 'identity-other',
      peerDisplayName: 'Other server',
      connectionId: 'connection-other',
      certificateFingerprint: `sha256:${'e'.repeat(64)}`
    })
    const revokeSecurePeer = vi.fn().mockResolvedValue(undefined)
    const teamHub = installAPI({ overrides: {
      securePeers: vi.fn().mockResolvedValue([unrelated, matching]),
      revokeSecurePeer
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Manage Studio' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from network…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }))

    const scope = {
      profileId: 'profile-host',
      profileGeneration: 3,
      serverIdentity: 'identity-host',
      generation: 4,
      hubIdentity: 'hub-team'
    }
    await waitFor(() => expect(teamHub.securePeers).toHaveBeenCalledWith(scope, 'team-1'))
    await waitFor(() => expect(revokeSecurePeer).toHaveBeenCalledWith(scope, 'team-1', {
      peerId: 'connection-studio',
      expectedCertificateFingerprint: `sha256:${'d'.repeat(64)}`,
      idempotencyKey: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    }))
    await waitFor(() => expect(screen.queryByText('Studio')).not.toBeInTheDocument())
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
    expect(screen.getAllByText('TargetApp').length).toBeGreaterThan(0)
    expect(screen.getByText(/Studio was removed from this Team Network/i)).toBeVisible()
  })

  it.each([
    ['no matching', [] as SecurePeerPairing[], 'This server no longer has active secure access.'],
    ['multiple matching', [
      approvedIncomingPairing(),
      approvedIncomingPairing({
        id: 'pairing-studio-duplicate',
        connectionId: 'connection-studio-duplicate',
        certificateFingerprint: `sha256:${'f'.repeat(64)}`
      })
    ], 'More than one active secure connection matches this server.']
  ])('fails closed with %s secure-peer records', async (_label, pairings, expectedError) => {
    const revokeSecurePeer = vi.fn()
    installAPI({ overrides: {
      securePeers: vi.fn().mockResolvedValue(pairings),
      revokeSecurePeer
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Manage Studio' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from network…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(expectedError)
    expect(revokeSecurePeer).not.toHaveBeenCalled()
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
  })

  it.each(['success', 'failure'] as const)('refreshes Bulletin and Mailbox after removal %s', async outcome => {
    vi.useFakeTimers()
    const initialMailbox = mailboxEntry()
    const laterMailbox: TeamNetworkMailboxEntry = {
      item: {
        ...initialMailbox.item,
        id: 'mail-2',
        sequence: 2,
        body: 'Mailbox stayed live after removal.'
      },
      delivery: {
        ...initialMailbox.delivery,
        id: 'delivery-2',
        state: 'available',
        delivered_at: null,
        read_at: null
      }
    }
    const bulletin = vi.fn().mockImplementation((_scope, query: { afterSequence: number }) => Promise.resolve(query.afterSequence > 0
      ? { posts: [bulletinPost('post-2', 2, 'Bulletin stayed live after removal.')], next_after_sequence: 2, has_more: false }
      : { posts: [bulletinPost('post-1', 1, 'Initial update')], next_after_sequence: 1, has_more: false }))
    const mailbox = vi.fn().mockImplementation((_scope, query: { afterSequence: number }) => Promise.resolve(query.afterSequence > 0
      ? { items: [laterMailbox], next_after_sequence: 2, has_more: false }
      : { items: [initialMailbox], next_after_sequence: 1, has_more: false }))
    const revokeSecurePeer = outcome === 'success'
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('The host could not revoke Studio.'))
    installAPI({ overrides: {
      bulletin,
      mailbox,
      securePeers: vi.fn().mockResolvedValue([approvedIncomingPairing()]),
      revokeSecurePeer
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Manage Studio' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from network…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    expect(revokeSecurePeer).toHaveBeenCalledTimes(1)
    if (outcome === 'success') expect(screen.queryByText('Studio')).not.toBeInTheDocument()
    else expect(screen.getByRole('alert')).toHaveTextContent('The host could not revoke Studio.')

    bulletin.mockResolvedValue({ posts: [bulletinPost('post-2', 2, 'Bulletin stayed live after removal.')], next_after_sequence: 2, has_more: false })
    mailbox.mockResolvedValue({ items: [laterMailbox], next_after_sequence: 2, has_more: false })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh team network' }))
    await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Bulletin' }))
    expect(screen.getByText('Bulletin stayed live after removal.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    expect(screen.getByText('Mailbox stayed live after removal.')).toBeVisible()
  })

  it('never offers removal for the host/current server', async () => {
    installAPI()
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))

    expect(screen.getByRole('button', { name: 'Manage Studio' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Manage TargetApp' })).not.toBeInTheDocument()
  })

  it('does not start server removal while another Team Network operation is busy', async () => {
    const first = { ...projectionFor(hostStatus), has_more: true }
    const later = deferred<TeamNetworkProjectionPage>()
    const securePeers = vi.fn().mockResolvedValue([approvedIncomingPairing()])
    installAPI({
      projectionValue: first,
      overrides: {
        network: vi.fn()
          .mockResolvedValueOnce(first)
          .mockReturnValueOnce(later.promise),
        securePeers
      }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    const manageStudio = screen.getByRole('button', { name: 'Manage Studio' })
    fireEvent.click(screen.getByRole('button', { name: 'Load more servers' }))

    expect(manageStudio).toBeDisabled()
    expect(securePeers).not.toHaveBeenCalled()

    await act(async () => later.resolve({
      network: first.network,
      servers: [{ id: 'server-z', server_identity: 'identity-z', display_name: 'Server Z', status: 'active', is_host: false, owned_by_caller: false }],
      agents: [],
      next_after_server_id: 'server-z',
      has_more: false
    }))
    await waitFor(() => expect(manageStudio).toBeEnabled())
  })

  it('does not let an authenticated peer automation remove any server', async () => {
    const securePeers = vi.fn().mockResolvedValue([approvedIncomingPairing()])
    const revokeSecurePeer = vi.fn()
    installAPI({
      statusValue: peerStatus,
      workspaceValue: workspaceFor(peerStatus),
      detailsValue: detailsFor(peerStatus),
      projectionValue: projectionFor(peerStatus),
      overrides: { securePeers, revokeSecurePeer }
    })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers' }))

    expect(screen.queryByRole('button', { name: /Manage / })).not.toBeInTheDocument()
    expect(securePeers).not.toHaveBeenCalled()
    expect(revokeSecurePeer).not.toHaveBeenCalled()
  })

  it('dismisses server removal with Escape or Keep server without revoking access', async () => {
    const revokeSecurePeer = vi.fn()
    installAPI({ overrides: {
      securePeers: vi.fn().mockResolvedValue([approvedIncomingPairing()]),
      revokeSecurePeer
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    const trigger = screen.getByRole('button', { name: 'Manage Studio' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from network…' }))
    expect(screen.getByRole('group', { name: 'Remove Studio' })).toBeVisible()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Remove Studio' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(revokeSecurePeer).not.toHaveBeenCalled()

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from network…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep server' }))
    expect(screen.queryByRole('group', { name: 'Remove Studio' })).not.toBeInTheDocument()
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
    expect(revokeSecurePeer).not.toHaveBeenCalled()
  })

  it('keeps a server visible when secure-peer revocation fails', async () => {
    const revokeSecurePeer = vi.fn().mockRejectedValue(new Error('The host could not revoke Studio.'))
    installAPI({ overrides: {
      securePeers: vi.fn().mockResolvedValue([approvedIncomingPairing()]),
      revokeSecurePeer
    } })
    render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText('Initial update')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Servers & People' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Manage Studio' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from network…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The host could not revoke Studio.')
    expect(revokeSecurePeer).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.queryByText('Build agent')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Remove Studio' })).toBeVisible()
  })

  it('renders network text as text rather than executable HTML', async () => {
    const attack = '<img src=x onerror="window.__networkXss=true">'
    const mailAttack = '<svg onload="window.__mailXss=true">'
    const unsafeMail = mailboxEntry('read')
    unsafeMail.item.body = mailAttack
    installAPI({ overrides: {
      bulletin: vi.fn().mockResolvedValue({ posts: [bulletinPost('attack', 1, attack)], next_after_sequence: 1, has_more: false }),
      mailbox: vi.fn().mockResolvedValue({ items: [unsafeMail], next_after_sequence: 1, has_more: false })
    } })
    const view = render(<TeamNetwork onClose={vi.fn()} />)

    expect(await screen.findByText(attack)).toBeVisible()
    expect(view.container.querySelector('.network-feed-item img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mail' }))
    expect(await screen.findByText(mailAttack)).toBeVisible()
    expect(view.container.querySelector('.network-mail-bundle-card svg[onload]')).toBeNull()
  })
})
