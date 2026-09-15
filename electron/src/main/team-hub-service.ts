import { createHash, randomUUID } from 'node:crypto'
import { fstatSync, read as readFileDescriptor } from 'node:fs'
import { basename } from 'node:path'
import type {
  TeamHubBootstrapInput,
  TeamHubConnectInput,
  TeamHubConfigureServerRoleInput,
  TeamHubTransport,
  TeamHubCreateChannelInput,
  TeamHubCreateDirectInput,
  TeamHubCreateInvitationInput,
  TeamHubCreateNodeEnrollmentInput,
  TeamHubDispatchAvailability,
  TeamHubDeviceSessionPage,
  TeamHubInvitationAcceptance,
  TeamHubInvitationPage,
  TeamHubJoinInput,
  TeamHubMessage,
  TeamHubMembershipPage,
  TeamHubOneTimeSecretReceipt,
  TeamHubPostMessageInput,
  TeamHubRecoverDeviceInput,
  TeamHubDiscovery,
  TeamHubForgetBindingInput,
  TeamHubServerScope,
  TeamHubScope,
  TeamHubStatus,
  TeamHubRoute,
  TeamHubTeamDetails,
  TeamHubUpdateMemberInput,
  TeamHubWorkspace
} from '../shared/team-hub'
import type {
  TeamNetworkCapabilities,
  TeamNetworkCreatePassiveRequestInput,
  TeamNetworkDeleteBulletinInput,
  TeamNetworkDeletionQuery,
  TeamNetworkDeliveryReceiptInput,
  TeamNetworkMailboxEntry,
  TeamNetworkMailboxAddress,
  TeamNetworkMailboxQuery,
  TeamNetworkPostBulletinInput,
  TeamNetworkRegisterAgentInput,
  TeamNetworkReplyPassiveRequestInput,
  TeamNetworkSendMailboxInput,
  TeamNetworkBulletinQuery,
  TeamNetworkDeletionJournalResult,
  TeamNetworkDeletionPage,
  TeamNetworkProjection,
  TeamNetworkProjectionPage,
  TeamNetworkProjectionQuery,
  TeamNetworkPublicAddress,
  TeamNetworkServer,
  TeamAttachmentCacheInput,
  TeamAttachmentCacheResult,
  TeamAttachmentDeclareInput,
  TeamAttachmentUploadInput,
  TeamMessageCreateInput,
  TeamMessageDeleteInput,
  TeamMessageDismissInput,
  TeamMessageQuery,
  TeamMessageThreadQuery,
  TeamMessageReceiptInput,
  TeamMailboxStateInput,
  TeamMessageRevisionInput,
  TeamMessagesCapability,
  TeamSkillArchiveInput,
  TeamSkillPinInput,
  TeamSkillQuery,
  TeamSkillVersionsQuery
} from '../shared/team-network'
import {
  TEAM_NETWORK_MAX_PAGE_ITEMS,
  parseTeamNetworkBulletinQuery,
  parseTeamNetworkCreatePassiveRequestInput,
  parseTeamNetworkDeleteBulletinInput,
  parseTeamNetworkDeletionQuery,
  parseTeamNetworkDeliveryReceiptInput,
  parseTeamNetworkMailboxQuery,
  parseTeamNetworkPostBulletinInput,
  parseTeamNetworkProjectionQuery,
  parseTeamNetworkRegisterAgentInput,
  parseTeamNetworkReplyPassiveRequestInput,
  parseTeamNetworkSendMailboxInput,
  requireTeamNetworkBodyWithinCapability,
  requireTeamNetworkIdentifier,
  requireTeamNetworkPageLimit,
  parseTeamAttachmentCacheInput,
  parseTeamAttachmentDeclareInput,
  parseTeamAttachmentUploadInput,
  parseTeamMessageCreateInput,
  parseTeamMessageDeleteInput,
  parseTeamMessageDismissInput,
  parseTeamMessageQuery,
  parseTeamMessageThreadQuery,
  parseTeamMessageReceiptInput,
  parseTeamMailboxStateInput,
  parseTeamMessageRevisionInput,
  parseTeamSkillArchiveInput,
  parseTeamSkillPinInput,
  parseTeamSkillQuery,
  parseTeamSkillVersionsQuery,
  teamAttachmentSupportsTextPreview
} from '../shared/team-network'
import type {
  SecurePeerActivateInput,
  SecurePeerApproveInput,
  SecurePeerConfigureHostInput,
  SecurePeerCompletionWaitInput,
  SecurePeerControlStatus,
  SecurePeerDeactivateInput,
  SecurePeerForgetConnectionInput,
  SecurePeerJoinInput,
  SecurePeerPairing,
  SecurePeerPublishRouteInput,
  SecurePeerProfileScope,
  SecurePeerRejectInput,
  SecurePeerRevokeRouteInput,
  SecurePeerRevokeInput
} from '../shared/secure-peer'
import {
  TeamHubClient,
  TeamHubClientError,
  TeamHubTransportError,
  type TeamHubAuthBundle,
  type TeamHubClientOptions
} from './team-hub-client'
import { TeamHubSettingsStore } from './team-hub-settings'
import type { TeamHubPublicSettings, TeamHubVerifiedBinding } from './team-hub-settings'
import { NativeTeamHubSecretFiles, type TeamHubSecretFiles } from './team-hub-secret-files'
import { inferredFileContentType } from '../shared/file-content-type'
import { buildTeamAttachmentMediaURL, type TeamAttachmentMediaResourceIdentity } from '../shared/media-url'
import { TeamAttachmentCache, type TeamAttachmentCacheIdentity } from './team-attachment-cache'
import type { AdmittedUploadFile } from './file-upload-grants'
import { ServerError } from './server-client'
import {
  deriveMountedTeamHubURL,
  deriveServerTeamHubURL,
  deriveSecurePeerTeamHubURL,
  isLoopbackHostname,
  normalizeDirectIPTeamHubURL,
  normalizeTailscaleServeTeamHubURL
} from '../shared/team-hub-url'

const ACCESS_EXPIRY_SKEW_MS = 30_000
const TEAM_NETWORK_OWNED_SCAN_MAX_PAGES = 256
const TEAM_NETWORK_OWNED_SCAN_MAX_SERVERS = 25_600
const TEAM_NETWORK_OWNED_SCAN_MAX_AGENTS = 262_144
const SECURE_PEER_STARTUP_RECOVERY_DELAYS_MS = [150, 350, 750, 1_500] as const
const BACKGROUND_RECONNECT_BACKOFF_MS = 30_000
export interface TeamHubServiceOptions {
  settings?: TeamHubSettingsStore
  discovery: TeamHubDiscoveryProvider
  clientFactory?: (url: string, options?: TeamHubClientOptions) => TeamHubClient
  secretFiles?: TeamHubSecretFiles
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  securePeerStartupRecoveryDelaysMs?: readonly number[]
  clientOptions?: TeamHubClientOptions
  teamCacheRoot?: string
  teamCacheMaxBytes?: number
  /** Test seam for profile-scoped attachment-cache lifecycle checks. */
  teamAttachmentCache?: TeamAttachmentCache
}

export interface TeamHubDiscoveryProvider {
  currentMailHintScope?(expected: TeamHubServerScope): import('../shared/team-mail-hints').MailHintScope | null
  currentScope(): TeamHubServerScope
  /** Latest capability from the already-authenticated active AgentsServer health cache. */
  currentDiscovery(expected: TeamHubServerScope): TeamHubDiscovery | null
  discover(expected: TeamHubServerScope): Promise<TeamHubDiscovery>
  configureTeamHubServerRole?(expected: SecurePeerProfileScope, input: TeamHubConfigureServerRoleInput): Promise<TeamHubDiscovery>
  requestBootstrapProof(expected: TeamHubServerScope, input: TeamHubBootstrapProofInput): Promise<TeamHubBootstrapProof>
  securePeerStatus?(expected: SecurePeerProfileScope): Promise<SecurePeerControlStatus>
  securePeerHostPeers?(expected: SecurePeerProfileScope, teamId: string): Promise<SecurePeerPairing[]>
  revokeSecurePeerHostPeer?(expected: SecurePeerProfileScope, teamId: string, input: SecurePeerRevokeInput): Promise<SecurePeerPairing>
  configureSecurePeerHost?(expected: SecurePeerProfileScope, input: SecurePeerConfigureHostInput): Promise<SecurePeerControlStatus>
  requestSecurePeerPairing?(expected: SecurePeerProfileScope, input: SecurePeerJoinInput): Promise<SecurePeerPairing>
  waitForSecurePeerPairingCompletion?(expected: SecurePeerProfileScope, input: SecurePeerCompletionWaitInput, signal: AbortSignal): Promise<SecurePeerControlStatus>
  refreshSecurePeerPairing?(expected: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerPairing>
  cancelSecurePeerPairing?(expected: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerControlStatus>
  approveSecurePeerPairing?(expected: SecurePeerProfileScope, input: SecurePeerApproveInput): Promise<SecurePeerControlStatus>
  rejectSecurePeerPairing?(expected: SecurePeerProfileScope, input: SecurePeerRejectInput): Promise<SecurePeerControlStatus>
  activateSecurePeerPairing?(expected: SecurePeerProfileScope, input: SecurePeerActivateInput): Promise<SecurePeerControlStatus>
  deactivateSecurePeerConnection?(expected: SecurePeerProfileScope, input: SecurePeerDeactivateInput): Promise<SecurePeerControlStatus>
  forgetSecurePeerConnection?(expected: SecurePeerProfileScope, input: SecurePeerForgetConnectionInput): Promise<SecurePeerControlStatus>
  secureTeamHubProxyFetch?(expected: TeamHubServerScope, basePath: string): typeof fetch
  serverTeamHubProxyFetch?(expected: TeamHubServerScope, basePath: string): typeof fetch
  publishSecurePeerRoute?(expected: SecurePeerProfileScope, input: SecurePeerPublishRouteInput): Promise<SecurePeerControlStatus>
  revokeSecurePeerRoute?(expected: SecurePeerProfileScope, input: SecurePeerRevokeRouteInput): Promise<SecurePeerControlStatus>
}

export interface TeamHubBootstrapProofInput {
  hubIdentity: string
  hubUrl: string
  transport?: 'tailscale_serve' | 'direct_ip'
  unsafeDirectIPConfirmed?: true
  recipientEmail: string
  displayName: string
  deviceLabel: string
}

export interface TeamHubBootstrapProof {
  requestId: string
  proof: string
}

interface TeamNetworkDeletionJournalSupportMemo {
  lifecycleKey: string
  state: 'unknown' | 'supported' | 'unsupported'
  probe: Promise<TeamNetworkDeletionJournalResult> | null
  purgedDeletionSequenceByTeam: Map<string, number>
  purgeTail: Promise<void> | null
}

export class TeamHubService {
  private readonly settings: TeamHubSettingsStore
  private readonly clientFactory: (url: string, options?: TeamHubClientOptions) => TeamHubClient
  private readonly secretFiles: TeamHubSecretFiles
  private readonly discovery: TeamHubDiscoveryProvider
  private readonly now: () => number
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly securePeerStartupRecoveryDelaysMs: readonly number[]
  private client: TeamHubClient | null = null
  private serverScope: TeamHubServerScope | null = null
  private binding: TeamHubPublicSettings | null = null
  private transientSecurePeerBinding = false
  private generation = 1
  private connectAttempt = 0
  private hubVerified = false
  private connectionState: TeamHubStatus['connectionState'] = 'disconnected'
  private bootstrapRequired = false
  private error: string | null = null
  private accessToken = ''
  private peerAuthenticated = false
  private serverAuthenticated = false
  private accessExpiresAt = 0
  private principal: TeamHubStatus['principal'] = null
  private session: TeamHubStatus['session'] = null
  private teams: TeamHubWorkspace['teams'] = []
  private designatedHost = false
  private transport: TeamHubTransport | null = null
  private connectionId: string | null = null
  private hostServerIdentity: string | null = null
  private routes: TeamHubRoute[] = []
  private availabilityMessage: string | null = null
  private availabilityAction: string | null = null
  private backgroundReconnectAllowed = true
  private backgroundReconnectNotBefore = 0
  private surfaceReconnectBypassScope: TeamHubServerScope | null = null
  private readonly processReconnectSuppressions = new Set<string>()
  private readonly pairingCompletionWaits = new Map<string, { scope: SecurePeerProfileScope; pairingId: string; controller: AbortController }>()
  private pairingCompletionGeneration = 0
  private teamNetworkCapability: TeamNetworkCapabilities | null = null
  private teamMessagesCapability: TeamMessagesCapability | null = null
  private readonly teamAttachmentCache: TeamAttachmentCache | null
  private refreshInFlight: { generation: number; promise: Promise<void> } | null = null
  private teamNetworkDeletionJournalSupport: TeamNetworkDeletionJournalSupportMemo | null = null
  private explicitRetryAuthentication: { generation: number; accessToken: string } | null = null
  private rejectedRefreshCredential: { profileId: string; hubIdentity: string; fingerprint: string | null } | null = null
  private currentRefreshCredentialFingerprint: string | null = null
  private authCacheEpoch: string | null = null
  private readonly retryableCandidateTransportFailures = new WeakSet<TeamHubClient>()

  constructor(options: TeamHubServiceOptions) {
    this.settings = options.settings ?? new TeamHubSettingsStore()
    this.discovery = options.discovery
    this.clientFactory = options.clientFactory ?? ((url, overrides) => new TeamHubClient(url, {
      ...options.clientOptions,
      ...overrides
    }))
    this.secretFiles = options.secretFiles ?? new NativeTeamHubSecretFiles()
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    this.securePeerStartupRecoveryDelaysMs = options.securePeerStartupRecoveryDelaysMs
      ?? SECURE_PEER_STARTUP_RECOVERY_DELAYS_MS
    this.teamAttachmentCache = options.teamAttachmentCache
      ?? (options.teamCacheRoot
        ? new TeamAttachmentCache(options.teamCacheRoot, options.teamCacheMaxBytes)
        : null)
  }

  status(): TeamHubStatus {
    this.reconcileServerScope()
    const server = this.serverScope
    const savedBinding = server ? this.settings.publicSettings(server.profileId) : null
    const savedLocalBinding = savedBinding && !savedBinding.connectionId ? savedBinding : null
    return clone({
      version: 1,
      profileId: server?.profileId ?? 'team-hub-unbound',
      profileGeneration: server?.profileGeneration ?? 0,
      serverIdentity: server?.serverIdentity ?? null,
      serverName: server?.serverName ?? null,
      serverUrl: server?.serverUrl ?? null,
      generation: this.generation,
      hubUrl: this.binding?.hubUrl ?? null,
      hubIdentity: this.binding?.hubIdentity ?? null,
      savedHubIdentity: savedLocalBinding?.hubIdentity ?? null,
      ...(this.connectionId ? { connectionId: this.connectionId } : {}),
      ...(this.hostServerIdentity ? { hostServerIdentity: this.hostServerIdentity } : {}),
      transport: this.transport,
      routes: clone(this.routes),
      designatedHost: this.designatedHost,
      availabilityMessage: this.availabilityMessage,
      availabilityAction: this.availabilityAction,
      canForgetBinding: Boolean(
        server?.serverIdentity
        && this.transport !== 'secure_peer'
        && !this.transientSecurePeerBinding
        && savedLocalBinding
      ),
      serverManaged: Boolean(server && this.isServerManaged(server, savedBinding)),
      backgroundReconnectAllowed: this.backgroundReconnectAllowed,
      connectionState: this.connectionState,
      authenticated: Boolean(this.hubVerified && (this.peerAuthenticated || this.serverAuthenticated || this.accessToken) && this.principal && this.session),
      ...(this.hubVerified && this.principal && this.session
        ? {
            authenticationMode: this.serverAuthenticated
              ? 'server' as const
              : this.peerAuthenticated
                ? 'paired_node' as const
                : 'human' as const
          }
        : {}),
      bootstrapRequired: this.bootstrapRequired,
      principal: this.principal,
      session: this.session,
      error: this.error
    })
  }

  async connect(input: TeamHubConnectInput = {}): Promise<TeamHubStatus> {
    const preferredTransport = selectableTeamHubTransport(input)
    const backgroundReconnect = parseBackgroundReconnectScope(input)
    const surfaceReconnect = parseSurfaceReconnectScope(input)
    const server = this.reconcileServerScope()
    const scopedReconnect = backgroundReconnect ?? surfaceReconnect
    if (scopedReconnect) {
      const serverManaged = this.isServerManaged(server, this.settings.publicSettings(server.profileId))
      if (!sameBackgroundReconnectScope(scopedReconnect, server, this.generation)) throw staleScopeError()
      if (
        !this.backgroundReconnectAllowed
        || !isBackgroundReconnectableState(this.connectionState, serverManaged)
      ) return this.status()
      if (surfaceReconnect && !serverManaged) return this.status()
      const now = this.now()
      const canBypassPassiveGate = Boolean(
        surfaceReconnect
        && (!this.surfaceReconnectBypassScope || !sameServerScope(this.surfaceReconnectBypassScope, server))
      )
      if (!canBypassPassiveGate && now < this.backgroundReconnectNotBefore) return this.status()
      if (canBypassPassiveGate) this.surfaceReconnectBypassScope = clone(server)
      // Keep transient failures retryable, but fence renderer remounts and
      // multiple windows from turning recovery into a tight network loop. An
      // open Team Network surface may bypass an already-active passive gate
      // once per profile activation, then immediately reinstates it here.
      this.backgroundReconnectNotBefore = now + BACKGROUND_RECONNECT_BACKOFF_MS
    } else {
      // A foreground/user request explicitly rearms passive recovery for this
      // exact persisted profile, including across an app restart.
      this.rearmBackgroundReconnect(server)
    }
    if (!server.serverIdentity) {
      this.connectionState = 'unavailable'
      this.error = 'Connect and verify the active AgentsServer profile before opening Teamspace.'
      return this.status()
    }
    const attempt = ++this.connectAttempt
    let candidate: TeamHubClient | null = null
    let committed = false
    let generation = this.generation
    const previousTransientState = this.transientSecurePeerBinding && this.hubVerified
      ? { connectionState: this.connectionState, error: this.error }
      : null
    let preserveTransientRuntimeOnFailure = false
    let activeTransientPairing: SecurePeerPairing | null = null
    let attemptedDiscovery: TeamHubDiscovery | null = null
    try {
      this.connectionState = 'connecting'
      this.error = null
      const advertised = await this.discovery.discover(clone(server))
      attemptedDiscovery = advertised
      this.requireConnectContext(attempt, server, advertised)
      const securePeerResolution = await this.discoveryWithActiveSecurePeer(
        server,
        advertised,
        preferredTransport,
        attempt
      )
      preserveTransientRuntimeOnFailure = securePeerResolution.preserveTransientRuntimeOnFailure
      activeTransientPairing = securePeerResolution.activeTransientPairing
      if (activeTransientPairing && activeTransientPairing.transportState !== 'online') {
        if (previousTransientState && preserveTransientRuntimeOnFailure) {
          // Heartbeat liveness can recover without changing durable trust. Keep
          // the already verified runtime and dormant local binding while the
          // AgentsServer reconnect loop owns transport recovery.
          this.connectionState = previousTransientState.connectionState
          this.error = previousTransientState.error
          return this.status()
        }
        throw new Error('The active secure peer connection is not online yet.')
      }
      this.requireServerSessionContinuity(server, securePeerResolution.discovery)
      let discovered = securePeerResolution.discovery.serverSessionBasePath
        ? securePeerResolution.discovery
        : selectTeamHubRoute(
          server.serverUrl,
          securePeerResolution.discovery,
          preferredTransport,
          this.settings.publicSettings(server.profileId)?.hubUrl,
        )
      this.requireConnectContext(attempt, server, advertised)
      this.designatedHost = discovered.designatedHost
      this.transport = discovered.transport
      this.connectionId = discovered.connectionId ?? null
      this.hostServerIdentity = discovered.transport === 'secure_peer' ? discovered.hostServerIdentity : null
      this.routes = clone(discovered.routes ?? [])
      this.availabilityMessage = discovered.message
      this.availabilityAction = discovered.action
      if (!discovered.available) {
        return await this.mutateConnectAfterHumanRefreshesSettle(attempt, server, advertised, () => {
          this.invalidateVerifiedClient('unavailable')
          this.designatedHost = discovered.designatedHost
          this.transport = discovered.transport
          this.connectionId = discovered.connectionId ?? null
          this.hostServerIdentity = discovered.transport === 'secure_peer' ? discovered.hostServerIdentity : null
          this.routes = clone(discovered.routes ?? [])
          this.availabilityMessage = discovered.message
          this.availabilityAction = discovered.action
          return this.status()
        }, true)
      }
      requireValidTeamHubDiscovery(server, discovered)
      let candidateURL = discovered.serverSessionBasePath
        ? deriveServerTeamHubURL(server.serverUrl, discovered.serverSessionBasePath)
        : discoveredTeamHubURL(server.serverUrl, discovered)
      candidate = this.createClient(candidateURL, server, discovered)
      let probe: Awaited<ReturnType<TeamHubService['probeTeamHubCandidate']>>
      try {
        probe = await this.probeTeamHubCandidate(candidate, discovered, server, advertised, attempt)
      } catch (error) {
        const failedCandidate = candidate
        if (!activeTransientPairing || !isExactPeerRevokedError(error)) throw error
        failedCandidate.dispose()
        candidate = null
        const retired = await this.retirePeerRevokedTransientConnection(
          server,
          activeTransientPairing,
          attempt
        )
        if (!retired) throw error
        this.requireConnectContext(attempt, server, advertised)
        // The peer was definitively revoked and the exact local connection is
        // now inactive. Restore the dormant local enrollment in this same
        // connect attempt; never carry its bearer credential through the peer
        // proxy while deciding this transition.
        this.requireServerSessionContinuity(server, advertised)
        discovered = advertised.serverSessionBasePath
          ? advertised
          : selectTeamHubRoute(
            server.serverUrl,
            advertised,
            undefined,
            this.settings.publicSettings(server.profileId)?.hubUrl,
          )
        if (discovered.transport === 'secure_peer') {
          throw new Error('AgentsServer kept advertising the retired secure peer connection.')
        }
        this.designatedHost = discovered.designatedHost
        this.transport = discovered.transport
        this.connectionId = discovered.connectionId ?? null
        this.hostServerIdentity = null
        this.routes = clone(discovered.routes ?? [])
        this.availabilityMessage = discovered.message
        this.availabilityAction = discovered.action
        if (!discovered.available) throw new Error(discovered.message ?? 'The saved local Team Hub is unavailable.')
        requireValidTeamHubDiscovery(server, discovered)
        candidateURL = discovered.serverSessionBasePath
          ? deriveServerTeamHubURL(server.serverUrl, discovered.serverSessionBasePath)
          : discoveredTeamHubURL(server.serverUrl, discovered)
        candidate = this.createClient(candidateURL, server, discovered)
        probe = await this.probeTeamHubCandidate(candidate, discovered, server, advertised, attempt)
      }
      const { health, peerSession, serverSession } = probe
      const verified: TeamHubVerifiedBinding = {
        profileId: server.profileId,
        serverUrl: server.serverUrl,
        serverIdentity: server.serverIdentity,
        hubUrl: candidateURL,
        hubIdentity: discovered.hubIdentity!,
        ...(discovered.transport === 'secure_peer' ? {
          connectionId: discovered.connectionId,
          hostServerIdentity: discovered.hostServerIdentity ?? undefined
        } : {})
      }
      const savedBinding = this.settings.publicSettings(server.profileId)
      // A secure-peer session is an explicitly approved route from this
      // AgentsServer, not a replacement enrollment for its local Team Hub.
      // Keep an existing local binding (and its refresh credential) dormant so
      // leaving the peer restores the local network without re-enrollment.
      const transientSecurePeerBinding = Boolean(
        discovered.transport === 'secure_peer'
        && savedBinding
        && !savedBinding.connectionId
      )
      const candidateToActivate = candidate
      const immediateStatus = await this.mutateConnectAfterHumanRefreshesSettle(
        attempt,
        server,
        advertised,
        () => {
          const binding: TeamHubPublicSettings = transientSecurePeerBinding
            ? { ...verified, hasRefreshCredential: false }
            : discovered.serverSessionBasePath
              ? this.settings.activateServerVerifiedHub(verified)
              : this.settings.activateVerifiedHub(verified)
          this.requireConnectContext(attempt, server, advertised)
          generation = this.activateClient(candidateToActivate)
          candidate = null
          committed = true
          this.binding = binding
          this.authCacheEpoch = transientSecurePeerBinding
            ? null
            : this.settings.authCacheEpoch(binding.profileId)
          this.teamNetworkCapability = health.capabilities?.team_network_v1 ?? null
          this.teamMessagesCapability = health.capabilities?.team_messages_v1
            ? { ...health.capabilities.team_messages_v1,
                // Migration 17 adds poster-only skill announcement tombstones.
                // Use this connected Hub's health, including through a peer route.
                ...(typeof health.schema_version === 'number'
                  && Number.isSafeInteger(health.schema_version) && health.schema_version >= 17
                  ? { skill_announcement_deletion: true as const } : {}),
                ...(health.capabilities.team_host_content_deletion_v1?.available === true
                  && health.capabilities.team_host_content_deletion_v1.version === 1
                  ? { host_content_deletion: true as const } : {}),
                ...(health.capabilities.team_all_servers_alias_v1
                  ? { all_servers: health.capabilities.team_all_servers_alias_v1 } : {}),
                ...(health.capabilities.team_mail_subjects_v1
                  ? { mail_subjects: health.capabilities.team_mail_subjects_v1 } : {}),
                ...(health.capabilities.team_mail_threads_v1
                  ? { mail_threads: health.capabilities.team_mail_threads_v1 } : {}),
                ...(health.capabilities.team_mailbox_state_v1
                  ? { mailbox_state: health.capabilities.team_mailbox_state_v1 } : {}) }
            : null
          this.transientSecurePeerBinding = transientSecurePeerBinding
          this.connectionState = 'connecting'
          this.error = null
          this.bootstrapRequired = health.bootstrap_required || !health.bootstrapped
          if (discovered.transport === 'secure_peer') {
            if (!peerSession) throw new Error('The paired server did not authorize a peer-native Teamspace session.')
            this.adoptPeerSession(peerSession, generation)
            this.hubVerified = true
            return this.status()
          }
          this.hubVerified = true
          if (this.bootstrapRequired) {
            this.connectionState = 'needs-bootstrap'
            return this.status()
          }
          if (discovered.serverSessionBasePath) {
            if (!serverSession) throw new Error('AgentsServer did not authorize its server-scoped Teamspace session.')
            this.adoptServerSession(serverSession, generation)
            return this.status()
          }
          if (!this.settings.refreshToken(binding.profileId)) {
            this.connectionState = 'signed-out'
            return this.status()
          }
          return null
        }
      )
      if (immediateStatus) return immediateStatus
      await this.refreshSession(generation)
      return this.status()
    } catch (error) {
      const failedCandidate = candidate
      candidate?.dispose()
      if (isStaleScopeError(error)) throw error
      this.requireConnectContext(attempt, server)
      if (
        !committed
        && previousTransientState
        && preserveTransientRuntimeOnFailure
        && activeTransientPairing
        && this.matchesCurrentTransientPairing(activeTransientPairing, 'active')
        && failedCandidate
        && this.isRetryableCandidateFailure(failedCandidate, error)
      ) {
        // A control-plane warning or transport failure is not revocation
        // evidence. Keep the already verified peer runtime intact.
        this.connectionState = previousTransientState.connectionState
        this.error = previousTransientState.error
        return this.status()
      }
      if (committed) {
        this.requireGeneration(generation)
        this.peerAuthenticated = false
        this.serverAuthenticated = false
        this.clearAccess()
        if (this.connectionState !== 'signed-out') this.connectionState = 'offline'
      } else {
        await this.mutateConnectAfterHumanRefreshesSettle(attempt, server, attemptedDiscovery, () => {
          this.invalidateVerifiedClient('offline')
        }, true)
      }
      this.error = publicError(error)
      return this.status()
    }
  }

  async bootstrap(input: TeamHubBootstrapInput): Promise<TeamHubWorkspace> {
    if (input && 'profileScope' in input) {
      const server = this.requireSecurePeerProfileScope(input.profileScope)
      if (!this.bootstrapRequired || this.connectionState !== 'needs-bootstrap' || !this.designatedHost) {
        throw new Error('This server is not awaiting Team Network creation.')
      }
      const status = await this.configureServerRole(input.profileScope, {
        role: 'host',
        serverName: requireServerName(server.serverName),
        networkName: requireServerName(input.teamName)
      })
      this.requireSameServerScope(server)
      if (!status.authenticated || status.authenticationMode !== 'server') {
        throw new Error(status.error || 'The network was created, but the server connection is not ready. Retry connecting.')
      }
      return this.workspace(this.currentScope())
    }
    const generation = this.generation
    if (!this.bootstrapRequired || this.connectionState !== 'needs-bootstrap') {
      throw new Error('This Team Hub is not awaiting first-owner bootstrap.')
    }
    const binding = this.requireBinding()
    const server = this.reconcileServerScope()
    if (this.transport === 'secure_peer' || this.isServerManaged(server, binding)) {
      throw new Error('First-owner bootstrap must be completed on the Teamspace host over its loopback or Tailscale Serve connection.')
    }
    const body = {
      email: requireEmail(input?.email),
      display_name: requireString(input?.displayName, 'Display name', 160),
      device_label: requireString(input?.deviceLabel, 'Device name', 160)
    }
    let requestId: string | undefined
    let proof: string
    if (this.transport === 'tailscale_serve' || this.transport === 'direct_ip') {
      if (this.transport === 'direct_ip' && input.unsafeDirectIPConfirmed !== true) {
        throw new Error('Confirm that Direct IP sends Teamspace credentials and messages without encryption.')
      }
      const grant = await this.discovery.requestBootstrapProof(clone(server), {
        hubIdentity: binding.hubIdentity,
        hubUrl: binding.hubUrl,
        transport: this.transport,
        ...(this.transport === 'direct_ip' ? {
          unsafeDirectIPConfirmed: input.unsafeDirectIPConfirmed
        } : {}),
        recipientEmail: body.email,
        displayName: body.display_name,
        deviceLabel: body.device_label
      })
      requestId = requireBootstrapRequestId(grant?.requestId)
      proof = requireRemoteBootstrapProof(grant?.proof)
    } else {
      if (!isLoopbackHostname(new URL(binding.hubUrl).hostname)) {
        throw new Error('This Teamspace transport cannot create the first owner.')
      }
      proof = await this.secretFiles.readBootstrapProof(binding.serverIdentity)
    }
    this.requireGeneration(generation)
    this.requireAdvertisedBinding(server, binding)
    const bundle = await this.requireClient().bootstrap(proof, body, requestId)
    this.requireGeneration(generation)
    this.requireAdvertisedBinding(server, binding)
    this.adoptAuth(bundle, generation)
    this.bootstrapRequired = false
    return this.workspace(this.currentScope())
  }

  async join(input: TeamHubJoinInput): Promise<TeamHubWorkspace> {
    const generation = this.generation
    if (!this.binding?.hubIdentity || this.connectionState !== 'signed-out') {
      throw new Error('Connect to and verify Team Hub before joining with an invitation.')
    }
    const joinServer = this.reconcileServerScope()
    if (this.transport === 'secure_peer' || this.isServerManaged(joinServer, this.binding)) {
      throw new Error('Human invitation sign-in must be completed on the Teamspace host over its loopback or Tailscale Serve connection.')
    }
    const token = await this.secretFiles.readSecret('invitation token')
    this.requireGeneration(generation)
    const bundle = await this.requireClient().redeemInvitation(token, {
      email: requireEmail(input?.email),
      display_name: requireString(input?.displayName, 'Display name', 160),
      device_label: requireString(input?.deviceLabel, 'Device name', 160)
    })
    this.requireGeneration(generation)
    this.adoptAuth(bundle, generation)
    return this.workspace(this.currentScope())
  }

  async acceptInvitation(scope: TeamHubScope): Promise<TeamHubInvitationAcceptance> {
    this.requireHumanAdministration(scope)
    const invitationToken = await this.secretFiles.readSecret('invitation token')
    this.requireScope(scope)
    const result = await this.withAuth(scope, accessToken => this.requireClient().acceptInvitation(accessToken, invitationToken), false)
    this.requireScope(scope)
    const principal = this.requirePrincipal()
    if (
      result.membership.principal_id !== principal.id
      || result.membership.status !== 'active'
      || !result.teams.some(team => team.id === result.membership.team_id && team.role === result.membership.role)
    ) throw new Error('Team Hub returned an invalid invitation acceptance.')
    this.teams = result.teams
    return clone({
      membership: result.membership,
      workspace: { status: this.status(), teams: this.teams }
    })
  }

  async recoverDevice(input: TeamHubRecoverDeviceInput): Promise<TeamHubWorkspace> {
    const generation = this.generation
    const binding = this.binding
    if (!binding?.hubIdentity || this.connectionState !== 'signed-out') {
      throw new Error('Connect to and verify Team Hub before device recovery.')
    }
    const server = this.reconcileServerScope()
    if (this.transport === 'secure_peer' || this.isServerManaged(server, binding)) {
      throw new Error('Human device recovery must be completed on the Teamspace host over its loopback or Tailscale Serve connection.')
    }
    this.requireAdvertisedBinding(server, binding)
    const url = new URL(binding.hubUrl)
    if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
      if (this.transport !== 'direct_ip') {
        throw new Error('Device recovery must use a verified Teamspace transport.')
      }
      normalizeDirectIPTeamHubURL(binding.hubUrl, server.serverUrl)
    }
    const proof = await this.secretFiles.readSecret('device recovery proof')
    this.requireGeneration(generation)
    this.requireAdvertisedBinding(server, binding)
    const bundle = await this.requireClient().recoverDevice(proof, {
      device_label: requireString(input?.deviceLabel, 'Device name', 160)
    })
    this.requireGeneration(generation)
    this.requireAdvertisedBinding(server, binding)
    this.adoptAuth(bundle, generation)
    return this.workspace(this.currentScope())
  }

  async refresh(scope: TeamHubScope): Promise<TeamHubWorkspace> {
    this.requireScope(scope)
    await this.ensureAccess(this.generation)
    this.requireScope(scope)
    return this.workspace(scope)
  }

  async logout(scope: TeamHubScope): Promise<TeamHubStatus> {
    this.requireScope(scope)
    if (this.peerAuthenticated || this.serverAuthenticated) {
      const profileId = this.reconcileServerScope().profileId
      const status = this.endServiceSession('signed-out')
      void this.purgeTeamAttachmentCache(profileId).catch(() => undefined)
      return status
    }
    const accessToken = this.accessToken
    const binding = this.requireBinding()
    const refreshToken = this.settings.refreshToken(binding.profileId)
    let revokeError: string | null = null
    let revokePermitted = true
    if (refreshToken) {
      try {
        const fingerprint = credentialFingerprint(refreshToken)
        this.requireRefreshCredentialNotRejected(binding, refreshToken)
        this.settings.markRefreshTokenUse(binding, fingerprint)
        this.rejectedRefreshCredential = { profileId: binding.profileId, hubIdentity: binding.hubIdentity, fingerprint }
      } catch {
        revokePermitted = false
        revokeError = 'Signed out locally without retrying an ambiguously used remote credential.'
      }
    }
    if (accessToken && refreshToken && revokePermitted) {
      try {
        await this.requireClient().revoke(accessToken, refreshToken)
        this.requireScope(scope)
      } catch (error) {
        if (isStaleScopeError(error)) throw error
        revokeError = 'Signed out on this device. The remote session could not be revoked and will expire automatically.'
      }
    } else if (refreshToken) {
      revokeError = 'Signed out on this device. The remote session could not be revoked and will expire automatically.'
    }
    this.requireScope(scope)
    let credentialCleanupError: string | null = null
    try {
      this.settings.clearRefreshToken(binding)
      this.rejectedRefreshCredential = null
    } catch {
      this.rejectedRefreshCredential = {
        profileId: binding.profileId,
        hubIdentity: binding.hubIdentity,
        fingerprint: refreshToken ? credentialFingerprint(refreshToken) : this.currentRefreshCredentialFingerprint
      }
      credentialCleanupError = 'The saved credential could not be deleted; AgentsDock will not reuse it in this process.'
    }
    try { this.replaceClient() }
    catch (error) {
      this.endServiceSession('signed-out')
      revokeError ??= `Signed out locally, but the Teamspace connection could not be prepared for another sign-in: ${messageForError(error)}`
    }
    this.connectionState = 'signed-out'
    this.bootstrapRequired = false
    this.currentRefreshCredentialFingerprint = null
    this.error = [revokeError, credentialCleanupError].filter(Boolean).join(' ') || null
    try { await this.purgeTeamAttachmentCache(binding.profileId) }
    catch (error) { this.error = [this.error, `Private attachment cleanup must be retried: ${messageForError(error)}`].filter(Boolean).join(' ') }
    return this.status()
  }

  async disconnect(scope: TeamHubScope): Promise<TeamHubStatus> {
    this.requireScope(scope)
    const reconnectPreferenceError = this.disableBackgroundReconnect()
    if (this.peerAuthenticated || this.serverAuthenticated) {
      const profileId = this.reconcileServerScope().profileId
      const status = this.endServiceSession('disconnected', reconnectPreferenceError)
      void this.purgeTeamAttachmentCache(profileId).catch(() => undefined)
      return status
    }
    const accessToken = this.accessToken
    const binding = this.requireBinding()
    const refreshToken = this.settings.refreshToken(binding.profileId)
    let revokeError: string | null = null
    let revokePermitted = true
    if (refreshToken) {
      try {
        const fingerprint = credentialFingerprint(refreshToken)
        this.requireRefreshCredentialNotRejected(binding, refreshToken)
        this.settings.markRefreshTokenUse(binding, fingerprint)
        this.rejectedRefreshCredential = { profileId: binding.profileId, hubIdentity: binding.hubIdentity, fingerprint }
      } catch {
        revokePermitted = false
        revokeError = 'Disconnected locally without retrying an ambiguously used remote credential.'
      }
    }
    if (accessToken && refreshToken && revokePermitted) {
      try {
        await this.requireClient().revoke(accessToken, refreshToken)
        this.requireScope(scope)
      } catch (error) {
        if (isStaleScopeError(error)) throw error
        revokeError = 'Disconnected and signed out locally, but the remote session could not be revoked and will expire automatically.'
      }
    } else if (refreshToken) {
      revokeError = 'Disconnected and signed out locally, but the remote session could not be revoked and will expire automatically.'
    }
    this.requireScope(scope)
    let credentialCleanupError: string | null = null
    try {
      this.settings.clearRefreshToken(binding)
      this.rejectedRefreshCredential = null
    } catch {
      this.rejectedRefreshCredential = {
        profileId: binding.profileId,
        hubIdentity: binding.hubIdentity,
        fingerprint: refreshToken ? credentialFingerprint(refreshToken) : this.currentRefreshCredentialFingerprint
      }
      credentialCleanupError = 'The saved credential could not be deleted; AgentsDock will not reuse it in this process.'
    }
    try { this.replaceClient() }
    catch (error) {
      this.endServiceSession('disconnected')
      revokeError ??= `Disconnected locally, but the Teamspace connection could not be retired cleanly: ${messageForError(error)}`
    }
    this.connectionState = 'disconnected'
    this.bootstrapRequired = false
    this.currentRefreshCredentialFingerprint = null
    this.error = [reconnectPreferenceError ?? revokeError, credentialCleanupError].filter(Boolean).join(' ') || null
    try { await this.purgeTeamAttachmentCache(binding.profileId) }
    catch (error) { this.error = [this.error, `Private attachment cleanup must be retried: ${messageForError(error)}`].filter(Boolean).join(' ') }
    return this.status()
  }

  async forgetBinding(input: TeamHubForgetBindingInput): Promise<TeamHubStatus> {
    const server = this.reconcileServerScope()
    const savedBinding = this.settings.publicSettings(server.profileId)
    if (
      !input
      || input.profileId !== server.profileId
      || input.profileGeneration !== server.profileGeneration
      || input.serverIdentity !== server.serverIdentity
      || input.expectedGeneration !== this.generation
      || !savedBinding
      || Boolean(savedBinding.connectionId)
      || input.expectedHubIdentity !== savedBinding.hubIdentity
    ) throw staleScopeError()
    if (this.transport === 'secure_peer' || this.transientSecurePeerBinding) {
      throw new Error('Deactivate or forget the secure server pairing from Network before forgetting the local network identity.')
    }
    await this.purgeTeamAttachmentCache(server.profileId)
    this.requireSameServerScope(server)
    this.backgroundReconnectAllowed = false
    this.backgroundReconnectNotBefore = 0
    this.settings.forgetBinding(server.profileId)
    if (this.rejectedRefreshCredential?.profileId === server.profileId) this.rejectedRefreshCredential = null
    this.invalidateVerifiedClient('offline')
    this.error = null
    this.connectionState = 'disconnected'
    return this.status()
  }

  async removeServerProfile(profileId: string) {
    const removed = this.settings.removeServerProfile(profileId)
    if (this.rejectedRefreshCredential?.profileId === profileId) this.rejectedRefreshCredential = null
    try {
      // Durable binding/credential trust is removed before irreversible cache
      // deletion. A failed purge may leave only server-identity-bound orphan
      // bytes; it must never restore the retired authority.
      await this.purgeTeamAttachmentCache(profileId)
      return removed
    } catch (error) {
      return {
        ...removed,
        cleanupWarning: `Team attachment cache cleanup failed: ${publicError(error)}`
      }
    }
  }

  async workspace(scope: TeamHubScope): Promise<TeamHubWorkspace> {
    const teams = await this.withAuth(scope, token => this.requireClient().teams(token), true)
    this.requireScope(scope)
    this.teams = teams.teams
    return clone({ status: this.status(), teams: this.teams })
  }

  async teamDetails(scope: TeamHubScope, teamId: string): Promise<TeamHubTeamDetails> {
    const id = requireIdentifier(teamId, 'Team')
    const result = await this.withAuth(scope, async token => {
      const client = this.requireClient()
      const team = await client.team(token, id)
      if (team.team.id !== id) throw new Error('Team Hub returned a mismatched team resource.')
      const canViewNodes = team.team.role === 'owner' || team.team.role === 'admin'
      const [members, nodes, channels] = await Promise.all([
        client.members(token, id),
        canViewNodes ? client.nodes(token, id) : Promise.resolve({ nodes: [] }),
        client.channels(token, id)
      ])
      return {
        team: team.team,
        members: members.members,
        membersHasMore: members.has_more ?? false,
        membersNextCursor: members.next_cursor ?? null,
        nodes: nodes.nodes,
        channels: channels.channels
      }
    }, true)
    this.requireScope(scope)
    const principal = this.principal
    if (!principal) throw new Error('Team Hub sign-in is required.')
    const listedMembership = result.members.find(member => member.principal_id === principal.id)
    if (listedMembership && (listedMembership.status !== 'active' || listedMembership.role !== result.team.role)) {
      throw new Error('Team Hub did not return your active team membership.')
    }
    if (!listedMembership && !result.membersHasMore) throw new Error('Team Hub did not return your active team membership.')
    const membership = listedMembership ?? {
      principal_id: principal.id,
      display_name: principal.display_name,
      email: principal.email ?? null,
      role: result.team.role,
      status: result.team.status
    }
    if (membership.status !== 'active') throw new Error('Team Hub did not return your active team membership.')
    if (
      result.team.id !== id
      || result.nodes.some(node => node.team_id !== id)
      || result.channels.some(channel => channel.team_id !== id || !channel.permissions.read)
    ) throw new Error('Team Hub returned mismatched team resources.')
    const memberIds = new Set(result.members.map(member => member.principal_id))
    if (!result.membersHasMore && result.channels.some(channel => channel.participants.some(participant => !memberIds.has(participant)))) {
      throw new Error('Team Hub returned mismatched channel participants.')
    }
    return clone({ scope: this.currentScope(), membership, ...result })
  }

  async deviceSessions(scope: TeamHubScope, cursor?: string): Promise<TeamHubDeviceSessionPage> {
    this.requireHumanAdministration(scope)
    const currentSessionId = this.session?.id
    if (!currentSessionId) throw new Error('Team Hub sign-in is required.')
    const page = await this.withAuth(
      scope,
      token => this.requireClient().deviceSessions(token, cleanOptionalCursor(cursor)),
      true
    )
    const ids = new Set(page.sessions.map(session => session.id))
    const completeFirstPage = cursor === undefined && !page.has_more && page.next_cursor === null
    if (
      ids.size !== page.sessions.length
      || page.sessions.some(session => session.current !== (session.id === currentSessionId))
      || (completeFirstPage && !ids.has(currentSessionId))
    ) {
      throw new Error('Team Hub returned mismatched device-session ownership.')
    }
    return clone(page)
  }

  async revokeDeviceSession(scope: TeamHubScope, sessionId: string): Promise<{ revoked: true }> {
    this.requireHumanAdministration(scope)
    const id = requireIdentifier(sessionId, 'device session')
    if (id === this.session?.id) throw new Error('Sign out from this device instead of revoking its current session here.')
    return clone(await this.withAuth(scope, token => this.requireClient().revokeDeviceSession(token, id), false))
  }

  async members(scope: TeamHubScope, teamId: string, cursor?: string): Promise<TeamHubMembershipPage> {
    const id = requireIdentifier(teamId, 'team')
    return clone(await this.withAuth(
      scope,
      token => this.requireClient().members(token, id, cleanOptionalCursor(cursor)),
      true
    ))
  }

  async invitations(scope: TeamHubScope, teamId: string, cursor?: string): Promise<TeamHubInvitationPage> {
    const id = this.requireOwnerTeam(scope, teamId)
    return clone(await this.withAuth(
      scope,
      token => this.requireClient().invitations(token, id, cleanOptionalCursor(cursor)),
      true
    ))
  }

  async revokeInvitation(scope: TeamHubScope, teamId: string, invitationId: string): Promise<{ revoked: true }> {
    const id = this.requireOwnerTeam(scope, teamId)
    const invite = requireIdentifier(invitationId, 'invitation')
    return clone(await this.withAuth(
      scope,
      token => this.requireClient().revokeInvitation(token, id, invite),
      false
    ))
  }

  async updateMember(scope: TeamHubScope, input: TeamHubUpdateMemberInput) {
    const teamId = this.requireOwnerTeam(scope, input?.teamId)
    const principalId = requireIdentifier(input?.principalId, 'member principal')
    if (principalId === this.principal?.id) throw new Error('The current owner cannot change their own membership here.')
    const patch = cleanMemberPatch(input?.patch)
    const result = await this.withAuth(
      scope,
      token => this.requireClient().updateMember(token, teamId, principalId, patch),
      false
    )
    if (
      result.member.principal_id !== principalId
      || ('role' in patch && (result.member.role !== patch.role || result.member.status !== 'active'))
      || ('status' in patch && result.member.status !== patch.status)
    ) throw new Error('Team Hub returned a mismatched member receipt.')
    return clone(result.member)
  }

  async createInvitation(scope: TeamHubScope, input: TeamHubCreateInvitationInput): Promise<TeamHubOneTimeSecretReceipt> {
    const teamId = this.requireInvitationIssuerTeam(scope, input?.teamId)
    const inviteeEmail = requireEmail(input?.inviteeEmail)
    if (!['admin', 'member', 'guest'].includes(input?.role)) throw new Error('Choose a valid invitation role.')
    const path = await this.secretFiles.chooseSavePath('agentsdock-team-invite.txt')
    this.requireScope(scope)
    if (!path) return {
      saved: false,
      label: 'Invitation cancelled',
      instructions: ['No invitation was created and no secret file was written.']
    }
    const result = await this.withAuth(scope, token => this.requireClient().createInvitation(token, teamId, {
      invitee_email: inviteeEmail,
      role: input.role
    }), false)
    this.requireScope(scope)
    if (
      result.invitation.team_id !== teamId
      || result.invitation.invitee_email !== inviteeEmail
      || result.invitation.role !== input.role
    ) throw new Error('Team Hub returned a mismatched invitation receipt.')
    const fileName = this.secretFiles.writeSecret(path, result.token)
    return {
      saved: true,
      id: result.invitation.id,
      expiresAt: result.invitation.expires_at,
      fileName,
      label: `Invitation for ${result.invitation.invitee_email}`,
      instructions: [
        `The one-time invitation token was saved privately as ${fileName}.`,
        `Send it only to ${result.invitation.invitee_email}. Their email must match exactly.`,
        'A new Hub user connects signed out and chooses Join with invitation. An existing user stays signed in and chooses Accept invite.'
      ]
    }
  }

  async createNodeEnrollment(scope: TeamHubScope, input: TeamHubCreateNodeEnrollmentInput): Promise<TeamHubOneTimeSecretReceipt> {
    const teamId = this.requireAdminTeam(scope, input?.teamId)
    const serverIdentity = requireString(input?.serverIdentity, 'Server identity', 240)
    const displayName = requireString(input?.displayName, 'Node name', 160)
    const publicKey = requireString(input?.publicKey, 'Ed25519 public key', 16_384)
    const publicKeyFingerprint = canonicalEd25519PublicKeyFingerprint(publicKey)
    const path = await this.secretFiles.chooseSavePath('agentsdock-node-enrollment.txt')
    this.requireScope(scope)
    if (!path) return {
      saved: false,
      label: 'Node enrollment cancelled',
      instructions: ['No enrollment grant was created and no secret file was written.']
    }
    const result = await this.withAuth(scope, token => this.requireClient().createNodeEnrollment(token, teamId, {
      server_identity: serverIdentity,
      display_name: displayName,
      public_key: publicKey
    }), false)
    this.requireScope(scope)
    if (
      result.enrollment.team_id !== teamId
      || result.enrollment.server_identity !== serverIdentity
      || result.enrollment.display_name !== displayName
      || result.enrollment.public_key_fingerprint !== publicKeyFingerprint
    ) throw new Error('Team Hub returned a mismatched node enrollment receipt.')
    const fileName = this.secretFiles.writeSecret(path, result.token)
    return {
      saved: true,
      id: result.enrollment.id,
      expiresAt: result.enrollment.expires_at,
      fileName,
      label: `Enrollment for ${result.enrollment.display_name}`,
      instructions: [
        `The key-bound, one-time enrollment grant was saved privately as ${fileName}.`,
        `On ${result.enrollment.display_name}, submit that grant with the same Ed25519 public key to the challenge endpoint.`,
        'Sign the exact returned signing_payload with the node private key, then redeem the challenge.',
        `Verify the approved key fingerprint: ${result.enrollment.public_key_fingerprint}.`,
        'The AgentsServer node connector is not automatic in this V1 slice.'
      ]
    }
  }

  async createChannel(scope: TeamHubScope, input: TeamHubCreateChannelInput) {
    const teamId = requireIdentifier(input?.teamId, 'Team')
    const kind = input?.kind
    if (kind !== 'board' && kind !== 'announcements') throw new Error('Choose a valid channel kind.')
    const visibility = input.visibility === 'private' ? 'private' : 'team'
    const principal = this.requirePrincipal()
    const result = await this.withAuth(scope, token => this.requireClient().createChannel(token, teamId, {
      kind,
      visibility,
      slug: requireSlug(input.slug),
      display_name: requireString(input.displayName, 'Channel name', 160),
      ...(visibility === 'private' ? { participant_principal_ids: [principal.id] } : {}),
      idempotency_key: requireIdempotencyKey(input.idempotencyKey)
    }), true)
    this.requireScope(scope)
    if (result.channel.team_id !== teamId) throw new Error('Team Hub returned a channel for a different team.')
    return clone(result.channel)
  }

  async createDirect(scope: TeamHubScope, input: TeamHubCreateDirectInput) {
    const teamId = requireIdentifier(input?.teamId, 'Team')
    const participant = requireIdentifier(input?.participantPrincipalId, 'Direct-message participant')
    const principal = this.requirePrincipal()
    if (participant === principal.id) throw new Error('Choose another team member for a direct message.')
    const result = await this.withAuth(scope, token => this.requireClient().createChannel(token, teamId, {
      kind: 'direct',
      visibility: 'private',
      participant_principal_ids: [principal.id, participant],
      idempotency_key: requireIdempotencyKey(input.idempotencyKey)
    }), true)
    this.requireScope(scope)
    if (result.channel.team_id !== teamId || !result.channel.participants.includes(principal.id) || !result.channel.participants.includes(participant)) {
      throw new Error('Team Hub returned a mismatched direct channel.')
    }
    return clone(result.channel)
  }

  async messages(scope: TeamHubScope, channelId: string, beforeSequence?: number) {
    const id = requireIdentifier(channelId, 'Channel')
    const before = beforeSequence === undefined ? undefined : requirePositiveInteger(beforeSequence, 'Message sequence')
    const result = await this.withAuth(scope, token => this.requireClient().messages(token, id, before), true)
    this.requireScope(scope)
    if (result.messages.some(message => message.channel_id !== id)) {
      throw new Error('Team Hub returned messages for a different channel.')
    }
    return clone(result)
  }

  async postMessage(scope: TeamHubScope, input: TeamHubPostMessageInput): Promise<TeamHubMessage> {
    const channelId = requireIdentifier(input?.channelId, 'Channel')
    const body = requireString(input?.body, 'Message', 60_000)
    const result = await this.withAuth(scope, token => this.requireClient().postMessage(token, channelId, {
      body,
      body_format: input.bodyFormat === 'markdown' ? 'markdown' : 'plain',
      kind: input.kind === 'announcement' ? 'announcement' : 'post',
      idempotency_key: requireIdempotencyKey(input.idempotencyKey)
    }), true)
    this.requireScope(scope)
    if (result.message.channel_id !== channelId) throw new Error('Team Hub returned a post for a different channel.')
    return clone(result.message)
  }

  networkCapabilities(scope: TeamHubScope): TeamNetworkCapabilities {
    this.requireScope(scope)
    if (!this.hubVerified) throw new Error('Connect to and verify Team Hub before using Team Networks.')
    return clone(this.requireTeamNetworkCapability())
  }

  async network(scope: TeamHubScope, rawQuery: TeamNetworkProjectionQuery): Promise<TeamNetworkProjectionPage> {
    const query = parseTeamNetworkProjectionQuery(rawQuery)
    const teamId = this.requireTeamNetworkTeam(scope, query.teamId)
    const capability = this.requireTeamNetworkCapability()
    const limit = requireTeamNetworkPageLimit(query.limit, capability.max_page_items, 'Team Network page size')
    const result = await this.withAuth(
      scope,
      token => this.requireClient().network(token, teamId, query.afterServerId, limit),
      true
    )
    this.requireScope(scope)
    validateTeamNetworkProjectionPage(
      result,
      teamId,
      scope.hubIdentity,
      scope.serverIdentity,
      query.afterServerId,
      limit,
      capability.max_agents_per_server
    )
    return clone(result)
  }

  async registerNetworkAgent(scope: TeamHubScope, rawInput: TeamNetworkRegisterAgentInput) {
    const input = parseTeamNetworkRegisterAgentInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    await this.ensureAccess(this.generation)
    this.requireScope(scope)
    const team = this.teams.find(candidate => candidate.id === teamId && candidate.status === 'active')
    if (!team) throw new Error('The selected Team Network is unavailable for this connection.')
    if (!this.serviceAuthenticated() && team.role !== 'owner' && team.role !== 'admin') {
      throw new Error('Only a team owner or admin can register an agent on this server.')
    }
    const ownedContext = await this.requireOwnedTeamNetworkContext(scope, teamId)
    const result = await this.withAuth(scope, token => this.requireClient().registerNetworkAgent(token, teamId, {
      external_agent_id: input.externalAgentId,
      backend: input.backend,
      display_name: input.displayName,
      idempotency_key: input.idempotencyKey
    }), false)
    this.requireScope(scope)
    if (
      result.agent.server_id !== ownedContext.server.id
      || result.agent.status !== 'active'
      || result.agent.external_agent_id !== input.externalAgentId
      || result.agent.backend !== input.backend
      || result.agent.display_name !== input.displayName
    ) throw new Error('Team Hub returned a mismatched agent registration.')
    return clone(result.agent)
  }

  async bulletin(scope: TeamHubScope, rawQuery: TeamNetworkBulletinQuery) {
    const query = parseTeamNetworkBulletinQuery(rawQuery)
    const teamId = this.requireTeamNetworkTeam(scope, query.teamId)
    const capability = this.requireTeamNetworkCapability()
    const limit = requireTeamNetworkPageLimit(query.limit, capability.max_page_items, 'Bulletin page size')
    const result = await this.withAuth(
      scope,
      token => this.requireClient().networkBulletin(token, teamId, query.afterSequence, limit),
      true
    )
    this.requireScope(scope)
    validateSequencePage(result.posts, query.afterSequence, result.next_after_sequence, 'Bulletin')
    return clone(result)
  }

  async postBulletin(scope: TeamHubScope, rawInput: TeamNetworkPostBulletinInput) {
    const input = parseTeamNetworkPostBulletinInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    const capability = this.requireTeamNetworkCapability()
    const body = requireTeamNetworkBodyWithinCapability(input.body, capability.max_body_bytes, 'Bulletin')
    const expectedAuthor = await this.expectedTeamNetworkSender(scope, teamId, null)
    const result = await this.withAuth(scope, token => this.requireClient().postNetworkBulletin(token, teamId, {
      body,
      body_format: input.bodyFormat,
      ...(input.replyToPostId ? { reply_to_post_id: input.replyToPostId } : {}),
      idempotency_key: input.idempotencyKey
    }), false)
    this.requireScope(scope)
    if (
      result.post.body !== body
      || result.post.body_format !== input.bodyFormat
      || result.post.reply_to_post_id !== input.replyToPostId
      || (input.replyToPostId === null) !== (result.post.thread_root_post_id === null)
      || !sameExpectedBulletinAuthor(result.post.author, expectedAuthor)
    ) throw new Error('Team Hub returned a mismatched Bulletin post.')
    return clone(result.post)
  }

  async deleteNetworkBulletin(scope: TeamHubScope, rawInput: TeamNetworkDeleteBulletinInput) {
    const input = parseTeamNetworkDeleteBulletinInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    const result = await this.withAuth(
      scope,
      token => this.requireClient().deleteNetworkBulletin(token, teamId, input.postId, {
        idempotency_key: input.idempotencyKey
      }),
      false
    )
    this.requireScope(scope)
    if (result.deleted !== true || result.post_id !== input.postId) {
      throw new Error('Team Hub returned a mismatched Bulletin deletion receipt.')
    }
    await this.purgeTeamAttachmentCache(scope.profileId)
    this.requireScope(scope)
    return clone(result)
  }

  async networkDeletions(
    scope: TeamHubScope,
    rawQuery: TeamNetworkDeletionQuery
  ): Promise<TeamNetworkDeletionJournalResult> {
    const query = parseTeamNetworkDeletionQuery(rawQuery)
    const teamId = this.requireTeamNetworkTeam(scope, query.teamId)
    const capability = this.requireTeamNetworkCapability()
    const limit = requireTeamNetworkPageLimit(
      query.limit,
      capability.max_page_items,
      'Team Network deletion page size'
    )
    const support = this.deletionJournalSupportFor(scope)
    if (support.state === 'unsupported') {
      return { supported: false, reason: 'unsupported' }
    }
    if (support.state === 'supported') {
      const result = await this.requestNetworkDeletionJournalPage(
        scope,
        support,
        teamId,
        query.afterSequence,
        limit
      )
      if (!result.supported && this.teamNetworkDeletionJournalSupport === support) {
        support.state = 'unsupported'
      }
      return result
    }

    let ownsProbe = false
    let probe = support.probe
    if (!probe) {
      ownsProbe = true
      probe = this.requestNetworkDeletionJournalPage(scope, support, teamId, query.afterSequence, limit)
      support.probe = probe
    }
    try {
      const result = await probe
      this.requireScope(scope)
      if (this.teamNetworkDeletionJournalSupport === support) {
        support.state = result.supported ? 'supported' : 'unsupported'
      }
      if (ownsProbe || !result.supported) return result
      const followup = await this.requestNetworkDeletionJournalPage(scope, support, teamId, query.afterSequence, limit)
      if (!followup.supported && this.teamNetworkDeletionJournalSupport === support) {
        support.state = 'unsupported'
      }
      return followup
    } finally {
      if (support.probe === probe) support.probe = null
    }
  }

  private deletionJournalSupportFor(scope: TeamHubScope): TeamNetworkDeletionJournalSupportMemo {
    const lifecycleKey = teamHubLifecycleKey(scope)
    const current = this.teamNetworkDeletionJournalSupport
    if (current?.lifecycleKey === lifecycleKey) return current
    const next: TeamNetworkDeletionJournalSupportMemo = {
      lifecycleKey,
      state: 'unknown',
      probe: null,
      purgedDeletionSequenceByTeam: new Map(),
      purgeTail: null
    }
    this.teamNetworkDeletionJournalSupport = next
    return next
  }

  private async requestNetworkDeletionJournalPage(
    scope: TeamHubScope,
    support: TeamNetworkDeletionJournalSupportMemo,
    teamId: string,
    afterSequence: number,
    limit: number
  ): Promise<TeamNetworkDeletionJournalResult> {
    let result: TeamNetworkDeletionPage
    try {
      result = await this.withAuth(
        scope,
        token => this.requireClient().networkDeletions(token, teamId, afterSequence, limit),
        true
      )
    } catch (error) {
      this.requireScope(scope)
      if (isUnsupportedDeletionJournalError(error)) {
        return { supported: false as const, reason: 'unsupported' as const }
      }
      throw error
    }
    this.requireScope(scope)
    validateSequencePage(result.deletions, afterSequence, result.next_after_sequence, 'Team Network deletion')
    if (result.has_more && result.next_after_sequence === afterSequence) {
      throw new Error('Team Hub returned a stalled Team Network deletion continuation.')
    }
    const deletionHighWater = Math.max(0, ...result.deletions.map(deletion => deletion.sequence))
    if (deletionHighWater > 0) {
      await this.purgeTeamAttachmentCacheForDeletionSequence(scope, support, teamId, deletionHighWater)
    }
    return { supported: true as const, page: clone(result) }
  }

  private async purgeTeamAttachmentCacheForDeletionSequence(
    scope: TeamHubScope,
    support: TeamNetworkDeletionJournalSupportMemo,
    teamId: string,
    deletionSequence: number
  ): Promise<void> {
    this.requireScope(scope)
    if (
      this.teamNetworkDeletionJournalSupport !== support
      || support.lifecycleKey !== teamHubLifecycleKey(scope)
    ) throw staleScopeError()
    if (deletionSequence <= (support.purgedDeletionSequenceByTeam.get(teamId) ?? 0)) return

    const previous = support.purgeTail
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async () => {
      this.requireScope(scope)
      if (this.teamNetworkDeletionJournalSupport !== support) throw staleScopeError()
      if (deletionSequence <= (support.purgedDeletionSequenceByTeam.get(teamId) ?? 0)) return
      await this.purgeTeamAttachmentCache(scope.profileId)
      this.requireScope(scope)
      if (this.teamNetworkDeletionJournalSupport !== support) throw staleScopeError()
      support.purgedDeletionSequenceByTeam.set(teamId, deletionSequence)
    })
    support.purgeTail = operation
    try {
      await operation
    } finally {
      if (support.purgeTail === operation) support.purgeTail = null
    }
  }

  async mailbox(scope: TeamHubScope, rawQuery: TeamNetworkMailboxQuery) {
    const query = parseTeamNetworkMailboxQuery(rawQuery)
    const teamId = this.requireTeamNetworkTeam(scope, query.teamId)
    if (query.address.kind === 'human' && (
      this.serviceAuthenticated() || !this.principal || query.address.id !== this.principal.id
    )) throw new Error('Only the signed-in person can open this reply mailbox.')
    const capability = this.requireTeamNetworkCapability()
    const limit = requireTeamNetworkPageLimit(query.limit, capability.max_page_items, 'Mailbox page size')
    const result = await this.withAuth(
      scope,
      token => this.requireClient().networkMailbox(token, teamId, query.address, query.afterSequence, limit),
      true
    )
    this.requireScope(scope)
    validateSequencePage(result.items.map(entry => entry.item), query.afterSequence, result.next_after_sequence, 'Mailbox')
    validateUniqueMailboxEntries(result.items)
    if (result.items.some(entry => !sameAddress(entry.item.to, query.address))) {
      throw new Error('Team Hub returned mailbox items for a different address.')
    }
    return clone(result)
  }

  async sendMailbox(scope: TeamHubScope, rawInput: TeamNetworkSendMailboxInput) {
    const input = parseTeamNetworkSendMailboxInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    if (input.fromAgentId && !this.serviceAuthenticated()) throw new Error('Only an agent owned by this server connection can author this mailbox item.')
    const capability = this.requireTeamNetworkCapability()
    const body = requireTeamNetworkBodyWithinCapability(input.body, capability.max_body_bytes, 'Mailbox')
    const expectedSender = await this.expectedTeamNetworkSender(scope, teamId, input.fromAgentId)
    const result = await this.withAuth(scope, token => this.requireClient().sendNetworkMailbox(token, teamId, {
      to: input.to,
      ...(input.fromAgentId ? { from_agent_id: input.fromAgentId } : {}),
      body,
      body_format: input.bodyFormat,
      idempotency_key: input.idempotencyKey
    }), false)
    this.requireScope(scope)
    validateCreatedMailboxEntry(result, 'message', input.to, expectedSender, body, input.bodyFormat)
    return clone(result)
  }

  async networkItem(scope: TeamHubScope, teamId: string, itemId: string) {
    const id = this.requireTeamNetworkTeam(scope, teamId)
    const item = requireTeamNetworkIdentifier(itemId, 'Mailbox item')
    const result = await this.withAuth(scope, token => this.requireClient().networkItem(token, id, item), true)
    this.requireScope(scope)
    if (result.item.id !== item) throw new Error('Team Hub returned a mismatched mailbox item.')
    return clone(result)
  }

  async recordDeliveryReceipt(scope: TeamHubScope, rawInput: TeamNetworkDeliveryReceiptInput) {
    const input = parseTeamNetworkDeliveryReceiptInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    const result = await this.withAuth(scope, token => this.requireClient().recordNetworkDeliveryReceipt(
      token,
      teamId,
      input.deliveryId,
      { state: input.state, idempotency_key: input.idempotencyKey }
    ), false)
    this.requireScope(scope)
    if (
      result.delivery.id !== input.deliveryId
      || (input.state === 'read' && result.delivery.state !== 'read')
      || (input.state === 'delivered' && !['delivered', 'read'].includes(result.delivery.state))
    ) throw new Error('Team Hub returned a mismatched delivery receipt.')
    return clone(result.delivery)
  }

  async createPassiveRequest(scope: TeamHubScope, rawInput: TeamNetworkCreatePassiveRequestInput) {
    const input = parseTeamNetworkCreatePassiveRequestInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    if (input.fromAgentId && !this.serviceAuthenticated()) throw new Error('Only an agent owned by this server connection can author this passive request.')
    const capability = this.requireTeamNetworkCapability()
    const body = requireTeamNetworkBodyWithinCapability(input.body, capability.max_body_bytes, 'Passive request')
    const expectedSender = await this.expectedTeamNetworkSender(scope, teamId, input.fromAgentId)
    const result = await this.withAuth(scope, token => this.requireClient().createNetworkPassiveRequest(token, teamId, {
      to: input.to,
      ...(input.fromAgentId ? { from_agent_id: input.fromAgentId } : {}),
      body,
      body_format: input.bodyFormat,
      idempotency_key: input.idempotencyKey,
      expires_in_seconds: input.expiresInSeconds
    }), false)
    this.requireScope(scope)
    validateCreatedMailboxEntry(result, 'request', input.to, expectedSender, body, input.bodyFormat)
    if (
      result.request.id !== result.item.id
      || result.request.status !== 'open'
      || result.request.reply_item_id !== null
      || result.request.expires_at !== result.item.expires_at
    ) throw new Error('Team Hub returned a mismatched passive request.')
    return clone(result)
  }

  async passiveRequest(scope: TeamHubScope, teamId: string, requestId: string) {
    const id = this.requireTeamNetworkTeam(scope, teamId)
    const request = requireTeamNetworkIdentifier(requestId, 'Passive request')
    const result = await this.withAuth(scope, token => this.requireClient().networkPassiveRequest(token, id, request), true)
    this.requireScope(scope)
    validatePassiveRequestDetails(result, request)
    return clone(result)
  }

  async replyPassiveRequest(scope: TeamHubScope, rawInput: TeamNetworkReplyPassiveRequestInput) {
    const input = parseTeamNetworkReplyPassiveRequestInput(rawInput)
    const teamId = this.requireTeamNetworkTeam(scope, input.teamId)
    if (input.fromAgentId && !this.serviceAuthenticated()) throw new Error('Only an agent owned by this server connection can author this passive reply.')
    const capability = this.requireTeamNetworkCapability()
    const body = requireTeamNetworkBodyWithinCapability(input.body, capability.max_body_bytes, 'Passive request reply')
    const expectedSender = await this.expectedTeamNetworkSender(scope, teamId, input.fromAgentId)
    const result = await this.withAuth(scope, token => this.requireClient().replyNetworkPassiveRequest(
      token,
      teamId,
      input.requestId,
      {
        ...(input.fromAgentId ? { from_agent_id: input.fromAgentId } : {}),
        body,
        body_format: input.bodyFormat,
        idempotency_key: input.idempotencyKey
      }
    ), false)
    this.requireScope(scope)
    if (
      result.item.kind !== 'reply'
      || result.item.request_id !== input.requestId
      || result.item.body !== body
      || result.item.body_format !== input.bodyFormat
      || result.item.expires_at !== null
      || result.request.id !== input.requestId
      || result.request.status !== 'replied'
      || result.request.reply_item_id !== result.item.id
      || !sameExpectedSender(result.item.from, expectedSender)
    ) throw new Error('Team Hub returned a mismatched passive request reply.')
    return clone(result)
  }

  teamMessagesCapabilities(scope: TeamHubScope): TeamMessagesCapability {
    this.requireScope(scope)
    if (!this.hubVerified) throw new Error('Connect to and verify Team Hub before using Team Messages.')
    return clone(this.requireTeamMessagesCapability())
  }

  async teamMessages(scope: TeamHubScope, rawQuery: TeamMessageQuery): Promise<import('../shared/team-network').TeamMessagePage> {
    const query = parseTeamMessageQuery(rawQuery)
    const teamId = this.requireTeamMessagesTeam(scope, query.teamId)
    const coverageScope = () => {
      if (!query.includeMailboxCoverage) return null
      const hint = this.serverScope && this.discovery.currentMailHintScope?.(this.serverScope)
      if (!hint || hint.profileId !== scope.profileId || hint.profileGeneration !== scope.profileGeneration
        || hint.serverIdentity !== scope.serverIdentity || hint.hubId !== scope.hubIdentity
        || hint.teamId !== teamId || hint.recipientServerId !== query.addressId) return null
      return hint
    }
    const requestedCoverageScope = coverageScope()
    const limit = requireTeamNetworkPageLimit(
      query.limit,
      this.requireTeamMessagesCapability().max_page_items,
      'Team Messages page size'
    )
    const result = await this.withAuth(scope, token => this.requireClient().teamMessages(token, teamId, {
      box: query.box,
      ...(query.addressKind ? { addressKind: query.addressKind } : {}),
      ...(query.addressId ? { addressId: query.addressId } : {}),
      unread: query.unread,
      ...(query.fromKind ? { fromKind: query.fromKind } : {}),
      ...(query.fromId ? { fromId: query.fromId } : {}),
      ...(query.since ? { since: query.since } : {}),
      afterSequence: query.afterSequence,
      ...(requestedCoverageScope ? { includeMailboxCoverage: true, afterArrivalId: query.afterArrivalId } : {}),
      limit
    }), true)
    this.requireScope(scope)
    if (result.messages.some(message => message.team_id !== teamId)) {
      throw new Error('Team Hub returned messages for a different team.')
    }
    if (
      result.box !== query.box
      || (query.box === 'inbox' && (
        result.address?.kind !== query.addressKind || result.address?.id !== query.addressId
      ))
      || (query.box !== 'inbox' && result.address !== null)
    ) throw new Error('Team Hub returned a mismatched Team Messages page.')
    validateTeamMessagePage(result.messages, query.afterSequence, result.next_after_sequence, result.has_more)
    if (query.box === 'feed' && result.messages.some(message => (
      message.recipients.length !== 1 || message.recipients[0]?.kind !== 'all'
    ))) throw new Error('Team Hub returned non-feed messages in the Team feed.')
    if (query.box === 'inbox' && result.messages.some(message => !message.recipients.some(recipient => (
      recipient.kind === query.addressKind && recipient.id === query.addressId
    )))) throw new Error('Team Hub returned messages for a different inbox.')
    const appliedCoverageScope = coverageScope()
    if (requestedCoverageScope && appliedCoverageScope?.streamId === requestedCoverageScope.streamId && result.mailbox_coverage) {
      const coverage = result.mailbox_coverage
      if (coverage.team_id !== teamId || coverage.recipient_server_id !== query.addressId
        || coverage.through_sequence < query.afterSequence) throw new Error('Team Hub returned invalid Mail coverage.')
      const anchor = result.messages.find(message => message.sequence === coverage.through_sequence)
      if (anchor && anchor.id !== coverage.arrival_id) throw new Error('Team Hub returned a conflicting Mail arrival anchor.')
    } else if (result.mailbox_coverage) {
      // Passive notifications must never block a user-requested Inbox load.
      // An offline/replaced stream simply cannot acknowledge this normal page.
      const { mailbox_coverage: _unproven, ...ordinaryPage } = result
      return clone(ordinaryPage)
    }
    return clone(result)
  }

  async teamMessage(scope: TeamHubScope, teamIdValue: string, messageIdValue: string) {
    const teamId = this.requireTeamMessagesTeam(scope, teamIdValue)
    const messageId = requireTeamNetworkIdentifier(messageIdValue, 'Team Message')
    const message = await this.withAuth(
      scope,
      token => this.requireClient().teamMessage(token, teamId, messageId),
      true
    )
    this.requireScope(scope)
    if (message.id !== messageId || message.team_id !== teamId) {
      throw new Error('Team Hub returned a mismatched Team Message.')
    }
    return clone(message)
  }

  async teamMessageThread(scope: TeamHubScope, rawQuery: TeamMessageThreadQuery) {
    const input = parseTeamMessageThreadQuery(rawQuery)
    this.requireTeamMessagesTeam(scope, input.teamId)
    if (this.requireTeamMessagesCapability().mail_threads?.available !== true) {
      throw new Error('This Team Network host does not support mail threads yet. Update the host and reconnect.')
    }
    const result = await this.withAuth(scope, token => this.requireClient().teamMessageThread(token, input), true)
    this.requireScope(scope)
    if (result.team_id !== input.teamId || result.anchor_message_id !== input.messageId
      || result.messages.some(message => message.team_id !== input.teamId)) {
      throw new Error('Team Hub returned a mismatched mail thread.')
    }
    return clone(result)
  }

  async createTeamMessage(scope: TeamHubScope, rawInput: TeamMessageCreateInput) {
    const input = parseTeamMessageCreateInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const capability = this.requireTeamMessagesCapability()
    const allServers = input.recipients.some(recipient => recipient.kind === 'all_servers')
    if (input.kind === 'message' && input.title !== undefined && capability.mail_subjects?.available !== true) {
      throw new Error('This Team Network host does not support mail subjects yet. Update the host and reconnect.')
    }
    if (allServers && capability.all_servers?.available !== true) {
      throw new Error('This Team Network host does not support @@all server-inbox mail yet. Update the host and reconnect.')
    }
    const cleanBody = requireTeamNetworkBodyWithinCapability(input.body, capability.max_body_bytes, 'Team Message')
    if (input.recipients.length > capability.max_recipients_per_message) {
      throw new Error('This Team Message has too many recipients for the connected Hub.')
    }
    if (input.attachmentIds.length > capability.attachments.max_files_per_message) {
      throw new Error('This Team Message has too many attachments for the connected Hub.')
    }
    const message = await this.withAuth(scope, token => this.requireClient().createTeamMessage(token, teamId, {
      kind: input.kind,
      ...(input.title ? { title: input.title } : {}),
      body: cleanBody,
      body_format: input.bodyFormat,
      recipients: input.recipients,
      attachment_ids: input.attachmentIds,
      ...(input.inReplyToMessageId ? { in_reply_to_message_id: input.inReplyToMessageId } : {}),
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      idempotency_key: input.idempotencyKey
    }), false)
    this.requireScope(scope)
    if (
      message.team_id !== teamId
      || message.kind !== input.kind
      || message.title !== (input.title ?? null)
      || message.in_reply_to_message_id !== (input.inReplyToMessageId ?? null)
      || message.body !== cleanBody
      || message.body_format !== input.bodyFormat
      || message.attachments.length !== input.attachmentIds.length
      || message.attachments.some(attachment => !input.attachmentIds.includes(attachment.id))
      || input.attachmentIds.some(attachmentId => !message.attachments.some(attachment => attachment.id === attachmentId))
      || (allServers
        ? message.destination !== 'all_servers' || message.recipients.length < 1
          || message.recipients.length > capability.all_servers!.max_recipients_per_message
          || message.recipients.some(recipient => recipient.kind !== 'server')
        : message.destination !== undefined || message.recipients.length !== input.recipients.length
          || input.recipients.some(expected => !message.recipients.some(actual => (
            actual.kind === expected.kind && actual.id === (expected.kind === 'all' ? 'all' : expected.id)
          ))))
    ) throw new Error('Team Hub returned a mismatched Team Message.')
    return clone(message)
  }

  async recordTeamMessageReceipt(scope: TeamHubScope, rawInput: TeamMessageReceiptInput) {
    const input = parseTeamMessageReceiptInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const receipt = await this.withAuth(scope, token => this.requireClient().recordTeamMessageReceipt(
      token,
      teamId,
      input.messageId,
      { state: input.state, idempotency_key: input.idempotencyKey,
        ...(input.addressKind ? { address_kind: input.addressKind, address_id: input.addressId } : {}) }
    ), false)
    this.requireScope(scope)
    if (
      receipt.message_id !== input.messageId
      || !receipt.recipients.length
      || receipt.recipients.some(recipient => (
        recipient.kind === 'all'
        || (input.state === 'read' && recipient.state !== 'read')
        || (input.state === 'delivered' && recipient.state !== 'delivered' && recipient.state !== 'read')
      ))
    ) throw new Error('Team Hub returned a mismatched Team Message receipt.')
    return clone(receipt)
  }

  async setTeamMessageMailboxState(scope: TeamHubScope, rawInput: TeamMailboxStateInput) {
    const input = parseTeamMailboxStateInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    if (this.requireTeamMessagesCapability().mailbox_state?.available !== true) {
      throw new Error('This Team Network host does not support Mark unread yet. Update the host and reconnect.')
    }
    const result = await this.withAuth(scope, token => this.requireClient().setTeamMessageMailboxState(token, teamId, input.messageId,
      { address_kind: input.addressKind, address_id: input.addressId, unread: input.unread,
        expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey }), false)
    this.requireScope(scope)
    if (result.message_id !== input.messageId || result.mailbox_state.address_id !== input.addressId
      || result.mailbox_state.unread !== input.unread || result.mailbox_state.version !== input.expectedVersion + 1) {
      throw new Error('Team Hub returned a mismatched mailbox state.')
    }
    return clone(result)
  }

  async dismissTeamMessage(scope: TeamHubScope, rawInput: TeamMessageDismissInput) {
    const input = parseTeamMessageDismissInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const result = await this.withAuth(scope, token => this.requireClient().dismissTeamMessage(token, teamId, input.messageId,
      { address_kind: input.addressKind, address_id: input.addressId, idempotency_key: input.idempotencyKey }), false)
    this.requireScope(scope)
    if (result.message_id !== input.messageId || result.address.kind !== input.addressKind || result.address.id !== input.addressId) {
      throw new Error('Team Hub returned a mismatched inbox removal receipt.')
    }
    return clone(result)
  }

  async teamMessageHistory(scope: TeamHubScope, teamIdValue: string, messageIdValue: string, version?: number) {
    const teamId = this.requireTeamMessagesTeam(scope, teamIdValue)
    const messageId = requireTeamNetworkIdentifier(messageIdValue, 'Team Message')
    if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 200)) throw new Error('Invalid Team Message version.')
    const result = await this.withAuth(scope, token => this.requireClient().teamMessageHistory(token, teamId, messageId, version), true)
    this.requireScope(scope)
    if (result.message_id !== messageId || (version !== undefined && (result.versions.length !== 1 || result.versions[0]?.version !== version))) {
      throw new Error('Team Hub returned mismatched message history.')
    }
    return clone(result)
  }

  async deleteTeamMessage(scope: TeamHubScope, rawInput: TeamMessageDeleteInput) {
    const input = parseTeamMessageDeleteInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const result = await this.withAuth(
      scope,
      token => this.requireClient().deleteTeamMessage(token, teamId, input.messageId, {
        idempotency_key: input.idempotencyKey
      }),
      false
    )
    this.requireScope(scope)
    if (result.deleted !== true || result.message_id !== input.messageId) {
      throw new Error('Team Hub returned a mismatched Team Message deletion receipt.')
    }
    await this.purgeTeamAttachmentCache(scope.profileId)
    this.requireScope(scope)
    return clone(result)
  }

  async reviseTeamMessage(scope: TeamHubScope, rawInput: TeamMessageRevisionInput) {
    const input = parseTeamMessageRevisionInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const cleanBody = requireTeamNetworkBodyWithinCapability(
      input.body,
      this.requireTeamMessagesCapability().max_body_bytes,
      'Team Message revision'
    )
    const message = await this.withAuth(
      scope,
      token => this.requireClient().reviseTeamMessage(token, teamId, input.messageId, {
        body: cleanBody,
        body_format: input.bodyFormat,
        expected_version: input.expectedVersion,
        idempotency_key: input.idempotencyKey
      }),
      false
    )
    this.requireScope(scope)
    if (
      message.id !== input.messageId
      || message.team_id !== teamId
      || message.body !== cleanBody
      || message.body_format !== input.bodyFormat
      || message.revision?.version !== input.expectedVersion + 1
    ) throw new Error('Team Hub returned a mismatched Team Message revision.')
    return clone(message)
  }

  async declareTeamAttachment(
    scope: TeamHubScope,
    rawInput: TeamAttachmentDeclareInput,
    admittedFile: AdmittedUploadFile,
    signal?: AbortSignal
  ) {
    const input = parseTeamAttachmentDeclareInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const capability = this.requireTeamMessagesCapability()
    const inspected = await inspectAttachmentFile(
      admittedFile,
      Math.min(capability.attachments.max_bytes_per_file, capability.attachments.max_bytes_per_message),
      signal
    )
    this.requireScope(scope)
    const fileName = input.fileName ?? basename(input.path)
    if (
      !fileName
      || fileName.trim() !== fileName
      || fileName === '.'
      || fileName === '..'
      || fileName.includes('/')
      || fileName.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(fileName)
      || Buffer.byteLength(fileName, 'utf8') > 255
    ) {
      throw new Error('Team attachment file name is invalid.')
    }
    const declaration = await this.withAuth(scope, token => this.requireClient().declareTeamAttachment(token, teamId, {
      file_name: fileName,
      media_type: input.mediaType ?? inferredFileContentType(fileName),
      byte_size: inspected.byteSize,
      sha256: inspected.sha256,
      idempotency_key: input.idempotencyKey
    }, signal), false)
    this.requireScope(scope)
    if (
      declaration.attachment.team_id !== teamId
      || declaration.attachment.file_name !== fileName
      || declaration.attachment.byte_size !== inspected.byteSize
      || declaration.attachment.sha256 !== inspected.sha256
      || declaration.chunk_bytes !== capability.attachments.chunk_bytes
    ) throw new Error('Team Hub returned a mismatched attachment declaration.')
    return clone(declaration)
  }

  async uploadTeamAttachment(
    scope: TeamHubScope,
    rawInput: TeamAttachmentUploadInput,
    admittedFile: AdmittedUploadFile,
    signal?: AbortSignal
  ) {
    const input = parseTeamAttachmentUploadInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const capability = this.requireTeamMessagesCapability()
    const attachment = await this.withAuth(
      scope,
      token => this.requireClient().teamAttachment(token, teamId, input.attachmentId, signal),
      true
    )
    this.requireScope(scope)
    if (attachment.team_id !== teamId || attachment.id !== input.attachmentId || attachment.message_id !== null) {
      throw new Error('Team Hub returned a mismatched attachment.')
    }
    if (attachment.state === 'ready') return clone(attachment)
    if (attachment.state !== 'uploading') throw new Error('This Team attachment cannot be uploaded.')
    await uploadVerifiedAttachment(
      admittedFile,
      attachment,
      capability.attachments.chunk_bytes,
      capability.attachments.max_bytes_per_file,
      async (bytes, start) => {
        await this.withAuth(scope, token => this.requireClient().uploadTeamAttachmentChunk(
          token,
          teamId,
          attachment.id,
          bytes,
          start,
          attachment.byte_size,
          signal
        ), false)
      },
      signal
    )
    this.requireScope(scope)
    const ready = await this.withAuth(
      scope,
      token => this.requireClient().teamAttachment(token, teamId, attachment.id, signal),
      true
    )
    this.requireScope(scope)
    if (
      ready.state !== 'ready'
      || ready.id !== attachment.id
      || ready.team_id !== attachment.team_id
      || ready.sha256 !== attachment.sha256
      || ready.byte_size !== attachment.byte_size
    ) throw new Error('Team Hub did not finalize the attachment upload.')
    return clone(ready)
  }

  async teamAttachment(scope: TeamHubScope, teamIdValue: string, attachmentIdValue: string) {
    const teamId = this.requireTeamMessagesTeam(scope, teamIdValue)
    const attachmentId = requireTeamNetworkIdentifier(attachmentIdValue, 'Team attachment')
    const attachment = await this.withAuth(
      scope,
      token => this.requireClient().teamAttachment(token, teamId, attachmentId),
      true
    )
    this.requireScope(scope)
    if (attachment.team_id !== teamId || attachment.id !== attachmentId) {
      throw new Error('Team Hub returned a mismatched attachment.')
    }
    return clone(attachment)
  }

  async cacheTeamAttachment(
    scope: TeamHubScope,
    rawInput: TeamAttachmentCacheInput
  ): Promise<TeamAttachmentCacheResult> {
    const input = parseTeamAttachmentCacheInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const cache = this.requireTeamAttachmentCache()
    const capability = this.requireTeamMessagesCapability()
    const attachment = await this.teamAttachment(scope, teamId, input.attachmentId)
    this.requireTeamMessagesTeam(scope, teamId)
    if (input.previewBytes !== undefined && !teamAttachmentSupportsTextPreview(attachment)) {
      throw new Error('Only text Team attachments can be previewed.')
    }
    const identity = this.teamAttachmentCacheIdentity(scope, teamId, attachment.id)
    const requireCacheScope = () => {
      this.requireTeamMessagesTeam(scope, teamId)
      if (!this.authCacheEpoch || this.authCacheEpoch !== identity.authCacheEpoch) throw staleScopeError()
    }
    try {
      await cache.cache(identity, attachment, capability.attachments.chunk_bytes, (start, end, signal) => (
        this.withAuth(scope, token => this.requireClient().downloadTeamAttachmentChunk(
          token,
          teamId,
          attachment.id,
          start,
          end,
          signal
        ), true)
      ))
      requireCacheScope()
    } catch (error) {
      // Binary response bodies are consumed by the cache after the authenticated
      // request has returned. Preserve the same immediate stale-connection fence
      // used for JSON body-stream transport failures.
      requireCacheScope()
      this.invalidateAfterAuthenticatedTransportFailure(scope, error)
      throw error
    }
    requireCacheScope()
    const mediaURL = buildTeamAttachmentMediaURL(
      scope.profileId,
      scope.profileGeneration,
      scope.generation,
      identity.authCacheEpoch,
      teamId,
      attachment.id
    )
    let textPreview: TeamAttachmentCacheResult['text_preview']
    if (input.previewBytes !== undefined) {
      const previewBytes = Math.min(input.previewBytes, attachment.byte_size)
      let response: Response | undefined
      try {
        response = await cache.response(identity, new Request(mediaURL, {
          headers: { Range: `bytes=0-${previewBytes - 1}` }
        }))
        requireCacheScope()
        const expectedRange = `bytes 0-${previewBytes - 1}/${attachment.byte_size}`
        const declaredLengthHeader = response.headers.get('Content-Length')
        const declaredLength = declaredLengthHeader && /^[1-9]\d*$/.test(declaredLengthHeader)
          ? Number(declaredLengthHeader)
          : Number.NaN
        if (
          response.status !== 206
          || response.headers.get('Content-Range') !== expectedRange
          || !Number.isSafeInteger(declaredLength)
          || declaredLength !== previewBytes
        ) throw new Error('The local Team attachment preview returned an invalid byte range.')
        const bytes = await readExactTeamAttachmentPreview(response, previewBytes)
        requireCacheScope()
        const truncated = attachment.byte_size > previewBytes
        // When the bounded prefix ends inside a UTF-8 sequence, streaming mode
        // omits that incomplete final code point instead of rendering U+FFFD.
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
        } catch {
          throw new Error('This text attachment is not valid UTF-8.')
        }
        textPreview = {
          text,
          byte_size: previewBytes,
          truncated
        }
      } catch (error) {
        await response?.body?.cancel().catch(() => undefined)
        // Prefer the authoritative lifecycle error if the local cache stream
        // failed because its profile or authenticated scope was retired.
        requireCacheScope()
        throw error
      }
    }
    requireCacheScope()
    return {
      attachment: clone(attachment),
      media_url: mediaURL,
      ...(textPreview === undefined ? {} : { text_preview: textPreview })
    }
  }

  async teamAttachmentMediaResponse(
    resource: TeamAttachmentMediaResourceIdentity,
    request: Request
  ): Promise<Response> {
    const scope = this.currentScope()
    if (
      resource.profileId !== scope.profileId
      || resource.profileGeneration !== scope.profileGeneration
      || resource.hubGeneration !== scope.generation
    ) throw staleScopeError()
    const teamId = this.requireTeamMessagesTeam(scope, resource.teamId)
    const attachmentId = requireTeamNetworkIdentifier(resource.attachmentId, 'Team attachment')
    if (!this.authCacheEpoch || resource.authCacheEpoch !== this.authCacheEpoch) throw staleScopeError()
    const response = await this.requireTeamAttachmentCache().response(
      this.teamAttachmentCacheIdentity(scope, teamId, attachmentId),
      request
    )
    try {
      this.requireTeamMessagesTeam(scope, teamId)
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      throw error
    }
    return response
  }

  async teamSkills(scope: TeamHubScope, rawQuery: TeamSkillQuery) {
    const query = parseTeamSkillQuery(rawQuery)
    const teamId = this.requireTeamMessagesTeam(scope, query.teamId)
    const result = await this.withAuth(
      scope,
      token => this.requireClient().teamSkills(token, teamId, query.includeArchived, query.slug),
      true
    )
    this.requireScope(scope)
    if (
      result.skills.some(skill => skill.team_id !== teamId)
      || (query.slug && result.skills.some(skill => skill.slug !== query.slug))
      || (!query.includeArchived && result.skills.some(skill => skill.archived))
    ) throw new Error('Team Hub returned mismatched Team Skills.')
    return clone(result)
  }

  async teamSkill(scope: TeamHubScope, teamIdValue: string, skillIdValue: string) {
    const teamId = this.requireTeamMessagesTeam(scope, teamIdValue)
    const skillId = requireTeamNetworkIdentifier(skillIdValue, 'Team Skill')
    const result = await this.withAuth(
      scope,
      token => this.requireClient().teamSkill(token, teamId, skillId),
      true
    )
    this.requireScope(scope)
    if (result.id !== skillId || result.team_id !== teamId) {
      throw new Error('Team Hub returned a mismatched Team Skill.')
    }
    return clone(result)
  }

  async teamSkillVersions(scope: TeamHubScope, rawQuery: TeamSkillVersionsQuery) {
    const query = parseTeamSkillVersionsQuery(rawQuery)
    const teamId = this.requireTeamMessagesTeam(scope, query.teamId)
    const result = await this.withAuth(
      scope,
      token => this.requireClient().teamSkillVersions(token, teamId, query.skillId),
      true
    )
    this.requireScope(scope)
    if (
      result.skill_id !== query.skillId
      || result.versions.some(version => version.team_id !== teamId || version.skill_id !== query.skillId)
    ) {
      throw new Error('Team Hub returned versions for a different Team Skill.')
    }
    return clone(result)
  }

  async teamSkillVersion(scope: TeamHubScope, teamIdValue: string, skillIdValue: string, versionValue: number) {
    const teamId = this.requireTeamMessagesTeam(scope, teamIdValue)
    const skillId = requireTeamNetworkIdentifier(skillIdValue, 'Team Skill')
    const version = requirePositiveInteger(versionValue, 'Team Skill version')
    const result = await this.withAuth(
      scope,
      token => this.requireClient().teamSkillVersion(token, teamId, skillId, version),
      true
    )
    this.requireScope(scope)
    if (result.team_id !== teamId || result.skill_id !== skillId || result.version !== version) {
      throw new Error('Team Hub returned a mismatched Team Skill version.')
    }
    return clone(result)
  }

  async pinTeamSkill(scope: TeamHubScope, rawInput: TeamSkillPinInput) {
    const input = parseTeamSkillPinInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const skill = await this.withAuth(scope, token => this.requireClient().pinTeamSkill(
      token,
      teamId,
      input.skillId,
      { pinned: input.pinned, idempotency_key: input.idempotencyKey }
    ), false)
    this.requireScope(scope)
    if (
      skill.id !== input.skillId
      || skill.team_id !== teamId
      || input.pinned !== skill.pinned
    ) throw new Error('Team Hub returned a mismatched Team Skill pin state.')
    return clone(skill)
  }

  async archiveTeamSkill(scope: TeamHubScope, rawInput: TeamSkillArchiveInput) {
    const input = parseTeamSkillArchiveInput(rawInput)
    const teamId = this.requireTeamMessagesTeam(scope, input.teamId)
    const skill = await this.withAuth(scope, token => this.requireClient().archiveTeamSkill(
      token,
      teamId,
      input.skillId,
      { archived: input.archived, idempotency_key: input.idempotencyKey }
    ), false)
    this.requireScope(scope)
    if (
      skill.id !== input.skillId
      || skill.team_id !== teamId
      || input.archived !== skill.archived
    ) throw new Error('Team Hub returned a mismatched Team Skill archive state.')
    return clone(skill)
  }

  dispatchAvailability(): TeamHubDispatchAvailability {
    return {
      available: false,
      reason: 'Dispatch requires a scoped capability and an enrolled node connector. Passive posts never wake an agent.'
    }
  }

  async configureServerRole(
    scope: SecurePeerProfileScope,
    input: TeamHubConfigureServerRoleInput
  ): Promise<TeamHubStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.configureTeamHubServerRole) throw teamHubHostControlUnavailable()
    if (input?.role !== 'host' && input?.role !== 'member') throw new Error('Select a Team Network server role.')
    const serverName = requireServerName(input.serverName)
    if (input.renameOnly !== undefined && (input.renameOnly !== true || input.role !== 'host' || input.networkName !== undefined)) {
      throw new Error('Rename must preserve the existing Host role and Team Network name.')
    }
    const expected: SecurePeerProfileScope = {
      profileId: server.profileId,
      profileGeneration: server.profileGeneration,
      serverIdentity: server.serverIdentity!
    }
    const discovered = await this.discovery.configureTeamHubServerRole(expected, {
      role: input.role,
      serverName,
      ...(input.networkName === undefined ? {} : { networkName: requireServerName(input.networkName) }),
      ...(input.renameOnly === true ? { renameOnly: true as const } : {})
    })
    this.requireSameServerScope(server)
    if (input.role === 'host') {
      if (!discovered?.designatedHost || discovered.hostServerIdentity !== server.serverIdentity) {
        throw new Error('AgentsServer did not enable this server as the Team Network host.')
      }
    } else if (discovered?.designatedHost) {
      throw new Error('AgentsServer did not change this server to the Team Network member role.')
    }
    const status = await this.connect()
    this.requireSameServerScope(server)
    return status
  }

  async securePeerStatus(scope: SecurePeerProfileScope): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.securePeerStatus) throw securePeerUnavailable()
    const result = ignoreLegacyTeamspaceCrossChatWarning(
      await this.discovery.securePeerStatus(scope)
    )
    this.requireSameServerScope(server)
    const revokedPairing = this.revokedCurrentTransientPairing(result)
    if (revokedPairing) {
      const savedLocalBinding = this.savedLocalBinding(server)
      this.dropSecurePeerRuntime(true)
      if (result.activeConnectionId === null && savedLocalBinding) {
        // Reconnect once through ordinary discovery after fencing the revoked
        // peer. The dormant local binding and refresh token were never
        // mutated, so this can restore the local Team Hub directly.
        await this.connect()
      }
    }
    return clone(result)
  }

  async configureSecurePeerHost(
    scope: SecurePeerProfileScope,
    input: SecurePeerConfigureHostInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.configureSecurePeerHost) throw securePeerUnavailable()
    const result = await this.discovery.configureSecurePeerHost(scope, input)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async requestSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerJoinInput): Promise<SecurePeerPairing> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.requestSecurePeerPairing) throw securePeerUnavailable()
    const { confirmLocalBindingReplacement, ...serverInput } = input
    if (confirmLocalBindingReplacement !== undefined && confirmLocalBindingReplacement !== true) {
      throw new Error('Secure connection switch confirmation is invalid.')
    }
    if (input.completeOnApproval === true) {
      const saved = this.settings.publicSettings(server.profileId)
      if (this.binding?.connectionId || saved?.connectionId) {
        throw new Error('Deactivate and explicitly forget the current secure connection before joining a different server.')
      }
      if ((this.binding || saved) && confirmLocalBindingReplacement !== true) {
        throw new Error('Confirm switching away from the current local network before joining this paired server.')
      }
    }
    const generation = this.pairingCompletionGeneration
    const result = await this.discovery.requestSecurePeerPairing(scope, serverInput)
    this.requireSameServerScope(server)
    if (input.completeOnApproval === true && result.completeOnApproval === true && generation === this.pairingCompletionGeneration) {
      this.setBackgroundReconnectAllowed(server, true)
    }
    return clone(result)
  }

  async waitForSecurePeerPairingCompletion(scope: SecurePeerProfileScope, input: SecurePeerCompletionWaitInput): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.waitForSecurePeerPairingCompletion) throw securePeerUnavailable()
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)
      || !/^[0-9a-f-]{36}$/.test(input.pairingId ?? '') || !/^[0-9a-f]{64}$/.test(input.expectedTranscriptHash ?? '')) {
      throw new Error('Secure pairing completion observer is invalid.')
    }
    // A StrictMode remount may replace its observer, but never its durable Join.
    for (const [id, wait] of this.pairingCompletionWaits) {
      if (id === input.requestId || (wait.pairingId === input.pairingId && wait.scope.profileId === scope.profileId)) {
        wait.controller.abort()
        this.pairingCompletionWaits.delete(id)
      }
    }
    const controller = new AbortController()
    const wait = { scope: clone(scope), pairingId: input.pairingId, controller }
    this.pairingCompletionWaits.set(input.requestId, wait)
    try {
      const result = await this.discovery.waitForSecurePeerPairingCompletion(scope, input, controller.signal)
      controller.signal.throwIfAborted()
      this.requireSameServerScope(server)
      return clone(result)
    } finally {
      if (this.pairingCompletionWaits.get(input.requestId) === wait) this.pairingCompletionWaits.delete(input.requestId)
    }
  }

  async stopSecurePeerPairingCompletionWait(scope: SecurePeerProfileScope, requestId: string): Promise<void> {
    const wait = this.pairingCompletionWaits.get(requestId)
    if (!wait || wait.scope.profileId !== scope?.profileId || wait.scope.profileGeneration !== scope?.profileGeneration
      || wait.scope.serverIdentity !== scope?.serverIdentity) return
    wait.controller.abort()
    this.pairingCompletionWaits.delete(requestId)
  }

  private abortPairingCompletionWaits(): void {
    this.pairingCompletionGeneration += 1
    for (const wait of this.pairingCompletionWaits.values()) wait.controller.abort()
    this.pairingCompletionWaits.clear()
  }

  async refreshSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerPairing> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.refreshSecurePeerPairing) throw securePeerUnavailable()
    const result = await this.discovery.refreshSecurePeerPairing(scope, pairingId)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async cancelSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.cancelSecurePeerPairing) throw securePeerUnavailable()
    for (const [id, wait] of this.pairingCompletionWaits) {
      if (wait.pairingId === pairingId && wait.scope.profileId === scope.profileId) {
        wait.controller.abort()
        this.pairingCompletionWaits.delete(id)
      }
    }
    const result = await this.discovery.cancelSecurePeerPairing(scope, pairingId)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async approveSecurePeerPairing(
    scope: SecurePeerProfileScope,
    input: SecurePeerApproveInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.approveSecurePeerPairing) throw securePeerUnavailable()
    const result = await this.discovery.approveSecurePeerPairing(scope, input)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async rejectSecurePeerPairing(
    scope: SecurePeerProfileScope,
    input: SecurePeerRejectInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.rejectSecurePeerPairing) throw securePeerUnavailable()
    const result = await this.discovery.rejectSecurePeerPairing(scope, input)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async activateSecurePeerPairing(
    scope: SecurePeerProfileScope,
    input: SecurePeerActivateInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.activateSecurePeerPairing) throw securePeerUnavailable()
    const { confirmLocalBindingReplacement, ...serverInput } = input
    if (confirmLocalBindingReplacement !== undefined && confirmLocalBindingReplacement !== true) {
      throw new Error('Secure connection switch confirmation is invalid.')
    }
    if (this.binding?.connectionId && !(
      this.binding.connectionId === input.expectedConnectionId
      && this.binding.hostServerIdentity === input.expectedHostServerIdentity
      && this.binding.hubIdentity === input.expectedHubIdentity
    )) {
      throw new Error('Deactivate and explicitly forget the current secure connection before activating a different paired server.')
    }
    const savedBinding = this.settings.publicSettings(server.profileId)
    const replacingLocalBinding = this.binding
      ? !this.binding.connectionId
      : Boolean(savedBinding && !savedBinding.connectionId)
    if (replacingLocalBinding && confirmLocalBindingReplacement !== true) {
      throw new Error('Confirm switching away from the current local network before activating this paired server.')
    }
    this.setBackgroundReconnectAllowed(server, true)
    const result = await this.discovery.activateSecurePeerPairing(scope, serverInput)
    this.requireSameServerScope(server)
    if (result.activeConnectionId !== input.expectedConnectionId) {
      throw new Error('AgentsServer did not activate the expected secure connection.')
    }
    // Fence every in-flight request against the old Hub immediately. This is
    // deliberately runtime-only: a local verified binding and refresh token
    // remain persisted and are never sent through the peer proxy.
    this.dropSecurePeerRuntime(true)
    return clone(result)
  }

  async deactivateSecurePeerConnection(
    scope: SecurePeerProfileScope,
    input: SecurePeerDeactivateInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.deactivateSecurePeerConnection) throw securePeerUnavailable()
    const affectsCurrent = Boolean(
      this.binding?.connectionId === input.connectionId
      && this.binding.hostServerIdentity === input.expectedHostServerIdentity
      && this.binding.hubIdentity === input.expectedHubIdentity
    )
    const affectsSaved = secureBindingMatches(this.settings.publicSettings(server.profileId), input)
    if (affectsCurrent || affectsSaved) this.setBackgroundReconnectAllowed(server, false)
    const result = await this.discovery.deactivateSecurePeerConnection(scope, input)
    this.requireSameServerScope(server)
    const stillAffectsCurrent = affectsCurrent && secureBindingMatches(this.binding, input)
    if (stillAffectsCurrent) this.dropSecurePeerRuntime(false)
    return clone(result)
  }

  async forgetSecurePeerConnection(
    scope: SecurePeerProfileScope,
    input: SecurePeerForgetConnectionInput
  ): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.forgetSecurePeerConnection) throw securePeerUnavailable()
    const affectsCurrent = Boolean(
      this.binding?.connectionId === input.connectionId
      && this.binding.hostServerIdentity === input.expectedHostServerIdentity
      && this.binding.hubIdentity === input.expectedHubIdentity
    )
    const affectsSaved = secureBindingMatches(this.settings.publicSettings(server.profileId), input)
    if (affectsCurrent || affectsSaved) {
      await this.purgeTeamAttachmentCache(server.profileId)
      this.requireSameServerScope(server)
      this.setBackgroundReconnectAllowed(server, false)
    }
    let result: SecurePeerControlStatus
    try {
      result = await this.discovery.forgetSecurePeerConnection(scope, input)
    } catch (error) {
      // Forget is idempotent at the product level, but AgentsServer fences the
      // underlying connection by identity and reports `connection_changed`
      // when that exact row is already absent. Only convert that authenticated
      // response into success after a second authenticated status snapshot
      // proves the connection id is absent everywhere. A live connection with
      // changed identity, a transport failure, or a stale profile remains an
      // error and retains durable trust.
      if (
        affectsSaved
        && isExactSecurePeerConnectionChangedError(error)
        && this.discovery.securePeerStatus
      ) {
        let status: SecurePeerControlStatus | null = null
        try {
          status = await this.discovery.securePeerStatus(scope)
          this.requireSameServerScope(server)
        } catch {
          // The original authenticated CAS error remains authoritative when
          // absence cannot itself be authenticated and validated.
        }
        if (status && !securePeerStatusReferencesConnection(status, input.connectionId)) {
          const savedBinding = this.settings.publicSettings(server.profileId)
          if (secureBindingMatches(savedBinding, input)) {
            const stillAffectsCurrent = affectsCurrent && secureBindingMatches(this.binding, input)
            try {
              this.settings.forgetBinding(server.profileId)
            } finally {
              if (stillAffectsCurrent) this.dropSecurePeerRuntime(true)
            }
            return clone(status)
          }
        }
      }
      throw error
    }
    this.requireSameServerScope(server)
    const stillAffectsCurrent = affectsCurrent && secureBindingMatches(this.binding, input)
    try {
      const savedBinding = this.settings.publicSettings(server.profileId)
      if (secureBindingMatches(savedBinding, input)) this.settings.forgetBinding(server.profileId)
    }
    finally {
      if (stillAffectsCurrent) this.dropSecurePeerRuntime(true)
    }
    return clone(result)
  }

  async publishSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerPublishRouteInput): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.publishSecurePeerRoute) throw securePeerUnavailable()
    const result = await this.discovery.publishSecurePeerRoute(scope, input)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async revokeSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerRevokeRouteInput): Promise<SecurePeerControlStatus> {
    const server = this.requireSecurePeerProfileScope(scope)
    if (!this.discovery.revokeSecurePeerRoute) throw securePeerUnavailable()
    const result = await this.discovery.revokeSecurePeerRoute(scope, input)
    this.requireSameServerScope(server)
    return clone(result)
  }

  async securePeers(scope: TeamHubScope, teamId: string): Promise<SecurePeerPairing[]> {
    const id = requireIdentifier(teamId, 'Team')
    if (this.serverAuthenticated) {
      this.requireServerManagedHostTeam(scope, id)
      if (!this.discovery.securePeerHostPeers) throw securePeerUnavailable()
      const peers = await this.discovery.securePeerHostPeers(profileScopeFromTeamHubScope(scope), id)
      this.requireScope(scope)
      if (peers.some(peer => peer.direction !== 'incoming' || peer.teamId !== id)) {
        throw new Error('AgentsServer returned secure peers outside the requested team.')
      }
      return clone(peers)
    }
    const result = await this.withAuth(scope, token => this.requireClient().securePeers(token, id), true)
    this.requireScope(scope)
    if (result.peers.some(peer => peer.direction !== 'incoming' || peer.teamId !== id)) {
      throw new Error('Team Hub returned secure peers outside the requested team.')
    }
    return clone(result.peers)
  }

  async revokeSecurePeer(scope: TeamHubScope, teamId: string, input: SecurePeerRevokeInput): Promise<SecurePeerPairing> {
    const id = requireIdentifier(teamId, 'Team')
    let peer: SecurePeerPairing
    if (this.serverAuthenticated) {
      this.requireServerManagedHostTeam(scope, id)
      if (!this.discovery.revokeSecurePeerHostPeer) throw securePeerUnavailable()
      peer = await this.discovery.revokeSecurePeerHostPeer(profileScopeFromTeamHubScope(scope), id, input)
      this.requireScope(scope)
    } else {
      const result = await this.withAuth(scope, token => this.requireClient().revokeSecurePeer(token, id, input), true)
      peer = result.peer
    }
    this.requireScope(scope)
    if (
      peer.connectionId !== input.peerId
      || peer.direction !== 'incoming'
      || peer.teamId !== id
      || peer.status !== 'revoked'
      || peer.trustState !== 'revoked'
      || peer.transportState !== 'revoked'
      || peer.certificateFingerprint !== input.expectedCertificateFingerprint
    ) {
      throw new Error(`${this.serverAuthenticated ? 'AgentsServer' : 'Team Hub'} returned a mismatched secure peer revocation receipt.`)
    }
    return clone(peer)
  }

  stop(): void {
    this.abortPairingCompletionWaits()
    this.connectAttempt += 1
    this.generation += 1
    this.client?.dispose()
    this.client = null
    this.refreshInFlight = null
    this.hubVerified = false
    this.teamNetworkCapability = null
    this.teamMessagesCapability = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.clearAccess()
  }

  private async withAuth<T>(scope: TeamHubScope, operation: (token: string) => Promise<T>, retryAfterRefresh: boolean): Promise<T> {
    this.requireScope(scope)
    if (!this.hubVerified) throw new Error('Connect to and verify Team Hub before making authenticated requests.')
    await this.ensureAccess(this.generation)
    this.requireScope(scope)
    const authenticationMode = this.serverAuthenticated
      ? 'server'
      : this.peerAuthenticated
        ? 'peer'
        : 'human'
    const operationToken = this.accessToken
    try {
      const result = await operation(operationToken)
      this.requireScope(scope)
      if (
        this.explicitRetryAuthentication?.generation === this.generation
        && this.explicitRetryAuthentication.accessToken === operationToken
      ) this.explicitRetryAuthentication = null
      return result
    } catch (error) {
      if (!(error instanceof TeamHubClientError) || error.status !== 401) {
        this.invalidateAfterAuthenticatedTransportFailure(scope, error)
        throw error
      }
      if (
        this.explicitRetryAuthentication?.generation === this.generation
        && this.explicitRetryAuthentication.accessToken === operationToken
      ) {
        this.requireScope(scope)
        this.explicitRetryAuthentication = null
        if (authenticationMode !== 'human') {
          this.invalidateVerifiedClient('offline')
          this.error = 'Teamspace authentication expired. AgentsDock will reconnect automatically.'
          throw new Error(this.error)
        }
        const binding = this.requireBinding()
        throw this.expireHumanSession(binding)
      }
      this.clearAccess(false)
      try {
        await this.refreshSession(this.generation)
      } catch (refreshError) {
        if (authenticationMode !== 'human') {
          // A peer/server session refresh is the authentication probe for that
          // transport. Any failed probe must retire the verified runtime instead
          // of leaving its prior principal and session looking connected.
          this.requireScope(scope)
          this.invalidateVerifiedClient('offline')
          this.error = 'Teamspace authentication was interrupted. AgentsDock will reconnect automatically.'
        }
        throw refreshError
      }
      this.requireScope(scope)
      if (!retryAfterRefresh) {
        // Mutations are rejected by the Hub before state changes on an expired
        // session, but replaying them automatically is still unsafe. Retain the
        // freshly rotated token and require one explicit user retry.
        this.explicitRetryAuthentication = {
          generation: this.generation,
          accessToken: this.accessToken
        }
        throw new Error('Your Team Hub session was refreshed. Retry the action once.')
      }
      try {
        const result = await operation(this.accessToken)
        this.requireScope(scope)
        return result
      } catch (retryError) {
        if (retryError instanceof TeamHubClientError && retryError.status === 401) {
          this.requireScope(scope)
          if (authenticationMode !== 'human') {
            this.invalidateVerifiedClient('offline')
            this.error = 'Teamspace authentication expired. AgentsDock will reconnect automatically.'
            throw new Error('Teamspace authentication expired. AgentsDock will reconnect automatically.')
          }
          // A second 401 is authoritative authentication rejection. The refresh
          // token has rotated by this point, so remove that exact binding's new
          // token and fail closed until the user recovers the device.
          const binding = this.requireBinding()
          throw this.expireHumanSession(binding)
        }
        this.invalidateAfterAuthenticatedTransportFailure(scope, retryError)
        throw retryError
      }
    }
  }

  private invalidateAfterAuthenticatedTransportFailure(scope: TeamHubScope, error: unknown): void {
    const retryableFailure = error instanceof TeamHubTransportError
      || error instanceof TeamHubClientError
      && [408, 500, 502, 503, 504].includes(error.status)
    if (!retryableFailure) return
    // Do not let a response from an obsolete profile tear down its successor.
    this.requireScope(scope)
    this.invalidateVerifiedClient('offline')
    this.error = 'Teamspace connection was interrupted. AgentsDock will reconnect automatically.'
  }

  private serviceAuthenticated(): boolean {
    return this.peerAuthenticated || this.serverAuthenticated
  }

  private requireHumanAdministration(scope: TeamHubScope): void {
    this.requireScope(scope)
    if (this.serviceAuthenticated() || !this.principal || ['service', 'node'].includes(this.principal.kind ?? '')) {
      throw new Error('Device and people administration requires a signed-in person.')
    }
  }

  private expireHumanSession(binding: TeamHubVerifiedBinding, rejectedToken?: string): Error {
    // In-memory auth state is authoritative for this process. Persisted
    // credential deletion is attempted afterward so a Keychain failure cannot
    // leave a rejected principal looking authenticated or hide recovery UX.
    const rejectedFingerprint = rejectedToken
      ? credentialFingerprint(rejectedToken)
      : this.currentRefreshCredentialFingerprint
    if (rejectedFingerprint) {
      try { this.settings.markRefreshTokenUse(binding, rejectedFingerprint) }
      catch { /* clearRefreshToken below remains the authoritative deletion attempt */ }
    }
    this.generation += 1
    this.clearAccess()
    this.currentRefreshCredentialFingerprint = null
    this.connectionState = 'signed-out'
    this.error = 'Your Team Hub session expired. Recover this device with a host-issued proof, or use an invitation for a different person.'
    try {
      this.settings.clearRefreshToken(binding)
      this.rejectedRefreshCredential = null
    } catch {
      this.rejectedRefreshCredential = {
        profileId: binding.profileId,
        hubIdentity: binding.hubIdentity,
        fingerprint: rejectedFingerprint
      }
      this.error += ' The rejected saved credential could not be deleted from secure storage; AgentsDock will not reuse it in this process.'
    }
    void this.purgeTeamAttachmentCache(binding.profileId).catch(() => undefined)
    return new Error(this.error)
  }

  private requireRefreshCredentialNotRejected(binding: TeamHubVerifiedBinding, token: string): void {
    const durableFingerprint = this.settings.rejectedRefreshTokenFingerprint(binding.profileId)
    if (durableFingerprint) {
      if (!token || credentialFingerprint(token) === durableFingerprint) {
        throw new Error('This Team Hub refresh credential may already have been consumed and cannot be reused. Recover this device with a new proof.')
      }
      // A replacement token and marker removal are one settings commit. A
      // durable mismatch is therefore not an authorized replacement.
      throw new Error('Team Hub credential recovery state is inconsistent. Recover this device with a new proof.')
    }
    const rejected = this.rejectedRefreshCredential
    if (!rejected || binding.profileId !== rejected.profileId || binding.hubIdentity !== rejected.hubIdentity) return
    if (!token) {
      this.rejectedRefreshCredential = null
      return
    }
    if (!rejected.fingerprint || credentialFingerprint(token) === rejected.fingerprint) {
      throw new Error(this.error ?? 'The rejected Team Hub credential cannot be reused. Recover this device with a new proof.')
    }
    this.rejectedRefreshCredential = null
  }

  private requireOwnerTeam(scope: TeamHubScope, teamId: unknown): string {
    this.requireHumanAdministration(scope)
    const id = requireIdentifier(teamId, 'team')
    const team = this.teams.find(candidate => candidate.id === id)
    if (!team || team.status !== 'active' || team.role !== 'owner') {
      throw new Error('Only an active team owner can manage invitations and people.')
    }
    return id
  }

  private requireAdminTeam(scope: TeamHubScope, teamId: unknown): string {
    this.requireHumanAdministration(scope)
    const id = requireIdentifier(teamId, 'team')
    const team = this.teams.find(candidate => candidate.id === id)
    if (!team || team.status !== 'active' || (team.role !== 'owner' && team.role !== 'admin')) {
      throw new Error('Only an active team owner or admin can issue invitations and node enrollments.')
    }
    return id
  }

  private requireInvitationIssuerTeam(scope: TeamHubScope, teamId: unknown): string {
    this.requireScope(scope)
    const id = requireIdentifier(teamId, 'team')
    const team = this.teams.find(candidate => candidate.id === id)
    if (
      this.serverAuthenticated
      && this.designatedHost
      && this.principal?.id === 'service_managed_server'
      && this.principal.kind === 'service'
      && team?.status === 'active'
      && team.role === 'automation'
    ) return id
    this.requireHumanAdministration(scope)
    if (!team || team.status !== 'active' || (team.role !== 'owner' && team.role !== 'admin')) {
      throw new Error('Only an active team owner or admin, or this Team Network host, can issue person invitations.')
    }
    return id
  }

  private async ensureAccess(generation: number): Promise<void> {
    if (!this.hubVerified) throw new Error('Connect to and verify Team Hub before using saved credentials.')
    if (this.serviceAuthenticated()) return
    if (
      this.rejectedRefreshCredential
      && this.binding?.profileId === this.rejectedRefreshCredential.profileId
      && this.binding.hubIdentity === this.rejectedRefreshCredential.hubIdentity
    ) {
      this.requireRefreshCredentialNotRejected(
        this.binding,
        this.settings.refreshToken(this.rejectedRefreshCredential.profileId)
      )
    }
    if (this.accessToken && this.accessExpiresAt > this.now() + ACCESS_EXPIRY_SKEW_MS) return
    await this.refreshSession(generation)
  }

  /**
   * A human refresh rotates a one-time token. A concurrent connect must not
   * dispose that request's client or replace its persisted binding until every
   * refresh observed at the commit boundary has settled. The mutation callback
   * runs synchronously with the final empty check, so another rotation cannot
   * enter between the check and the client/binding replacement.
   */
  private async mutateConnectAfterHumanRefreshesSettle<T>(
    attempt: number,
    server: TeamHubServerScope,
    advertised: TeamHubDiscovery | null,
    mutation: () => T,
    ignoreRefreshFailure = false
  ): Promise<T> {
    let latestFailure: { error: unknown } | null = null
    while (true) {
      this.requireConnectContext(attempt, server, advertised ?? undefined)
      const captured = this.refreshInFlight
      if (!captured) {
        if (latestFailure && !ignoreRefreshFailure && this.connectionState !== 'signed-out') {
          throw latestFailure.error
        }
        return mutation()
      }
      try {
        await captured.promise
        latestFailure = null
      } catch (error) {
        latestFailure = { error }
      }
      this.requireConnectContext(attempt, server, advertised ?? undefined)
    }
  }

  private async refreshSession(generation: number): Promise<void> {
    this.requireGeneration(generation)
    if (this.serverAuthenticated) {
      const serverSession = await this.requireClient().serverSession()
      this.requireGeneration(generation)
      this.adoptServerSession(serverSession, generation)
      return
    }
    if (this.peerAuthenticated) {
      const peerSession = await this.requireClient().peerSession()
      this.requireGeneration(generation)
      this.adoptPeerSession(peerSession, generation)
      return
    }
    if (this.refreshInFlight?.generation === generation) return this.refreshInFlight.promise
    const binding = this.requireBinding()
    const refreshToken = this.settings.refreshToken(binding.profileId)
    if (!refreshToken) throw new Error('Team Hub sign-in is required.')
    this.requireRefreshCredentialNotRejected(binding, refreshToken)
    const refreshFingerprint = credentialFingerprint(refreshToken)
    // Rotating refresh tokens are single-use. Persist the exact credential
    // fingerprint before dispatch so a crash at any later cut point cannot
    // replay an ambiguously consumed token after restart.
    try {
      this.settings.markRefreshTokenUse(binding, refreshFingerprint)
    } catch {
      // If the write-ahead fence cannot be made durable, the credential has
      // not been sent and must not be used. Retire the already-expired access
      // state immediately so status/UI cannot remain deceptively authenticated.
      this.rejectedRefreshCredential = {
        profileId: binding.profileId,
        hubIdentity: binding.hubIdentity,
        fingerprint: refreshFingerprint
      }
      this.clearAccess()
      this.currentRefreshCredentialFingerprint = null
      this.connectionState = 'signed-out'
      this.error = 'Team Hub could not safely begin credential refresh. Sign in or recover this device after secure storage is available.'
      void this.purgeTeamAttachmentCache(binding.profileId).catch(() => undefined)
      throw new Error(this.error)
    }
    this.rejectedRefreshCredential = {
      profileId: binding.profileId,
      hubIdentity: binding.hubIdentity,
      fingerprint: refreshFingerprint
    }
    const promise = this.requireClient().refresh(refreshToken).then(bundle => {
      this.requireGeneration(generation)
      this.adoptAuth(bundle, generation, refreshToken)
    }).catch(error => {
      this.requireGeneration(generation)
      if (error instanceof TeamHubClientError && error.status === 401) {
        throw this.expireHumanSession(binding, refreshToken)
      }
      this.clearAccess()
      if (this.connectionState !== 'signed-out') this.connectionState = 'offline'
      throw error
    }).finally(() => {
      if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null
    })
    this.refreshInFlight = { generation, promise }
    return promise
  }

  private adoptAuth(bundle: TeamHubAuthBundle, generation: number, replacedRefreshToken?: string): void {
    this.requireGeneration(generation)
    const binding = this.requireBinding()
    const accessToken = requireSecret(bundle.access_token, 'Access credential')
    const refreshToken = requireSecret(bundle.refresh_token, 'Refresh credential')
    requireIdentifier(bundle.principal?.id, 'Principal')
    requireIdentifier(bundle.session?.id, 'Session')
    const expiresAt = Date.parse(bundle.access_expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('Team Hub returned an expired access credential.')
    const authCacheEpoch = this.session?.id === bundle.session.id && this.authCacheEpoch
      ? this.authCacheEpoch
      : randomUUID()
    try {
      this.settings.storeRefreshToken(refreshToken, binding, authCacheEpoch)
    } catch {
      // The server may already have consumed the old rotating token. Never keep
      // or use the new access credential if its replacement cannot be stored.
      this.clearAccess()
      this.connectionState = 'signed-out'
      try {
        this.settings.clearRefreshToken(binding)
        this.rejectedRefreshCredential = null
      } catch {
        this.rejectedRefreshCredential = {
          profileId: binding.profileId,
          hubIdentity: binding.hubIdentity,
          fingerprint: replacedRefreshToken
            ? credentialFingerprint(replacedRefreshToken)
            : this.currentRefreshCredentialFingerprint
        }
      }
      void this.purgeTeamAttachmentCache(binding.profileId).catch(() => undefined)
      throw new Error('The refreshed Team Hub credential could not be saved. Sign in again.')
    }
    this.requireGeneration(generation)
    this.accessToken = accessToken
    this.explicitRetryAuthentication = null
    this.rejectedRefreshCredential = null
    this.currentRefreshCredentialFingerprint = credentialFingerprint(refreshToken)
    this.authCacheEpoch = authCacheEpoch
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.accessExpiresAt = expiresAt
    this.principal = clone(bundle.principal)
    this.session = clone(bundle.session)
    this.teams = clone(bundle.teams)
    this.connectionState = 'authenticated'
    this.error = null
  }

  private adoptPeerSession(snapshot: Awaited<ReturnType<TeamHubClient['peerSession']>>, generation: number): void {
    this.requireGeneration(generation)
    requireValidPeerSession(snapshot)
    this.accessToken = ''
    this.explicitRetryAuthentication = null
    this.accessExpiresAt = 0
    this.peerAuthenticated = true
    this.serverAuthenticated = false
    this.authCacheEpoch = randomUUID()
    this.principal = clone(snapshot.principal)
    this.session = clone(snapshot.session)
    this.teams = clone(snapshot.teams)
    this.bootstrapRequired = false
    this.connectionState = 'authenticated'
    this.error = null
  }

  private adoptServerSession(snapshot: Awaited<ReturnType<TeamHubClient['serverSession']>>, generation: number): void {
    this.requireGeneration(generation)
    requireValidServerSession(snapshot, this.now())
    this.accessToken = ''
    this.explicitRetryAuthentication = null
    this.accessExpiresAt = 0
    this.peerAuthenticated = false
    this.serverAuthenticated = true
    this.authCacheEpoch = randomUUID()
    this.principal = clone(snapshot.principal)
    this.session = clone(snapshot.session)
    this.teams = clone(snapshot.teams)
    this.bootstrapRequired = false
    this.connectionState = 'authenticated'
    this.error = null
  }

  private endServiceSession(state: 'signed-out' | 'disconnected', error: string | null = null): TeamHubStatus {
    this.generation += 1
    this.client?.dispose()
    this.client = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.hubVerified = false
    this.teamNetworkCapability = null
    this.teamMessagesCapability = null
    this.clearAccess()
    this.connectionState = state
    this.bootstrapRequired = false
    this.error = error
    return this.status()
  }

  private dropSecurePeerRuntime(forgetBinding: boolean, preserveConnectAttempt = false): void {
    if (!preserveConnectAttempt) this.connectAttempt += 1
    this.generation += 1
    this.client?.dispose()
    this.client = null
    this.refreshInFlight = null
    this.hubVerified = false
    this.teamNetworkCapability = null
    this.teamMessagesCapability = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.clearAccess()
    if (forgetBinding) {
      this.binding = null
      this.transientSecurePeerBinding = false
    }
    this.transport = null
    this.connectionId = null
    this.hostServerIdentity = null
    this.routes = []
    this.bootstrapRequired = false
    this.connectionState = 'disconnected'
    this.error = null
  }

  private replaceClient(): number {
    const binding = this.requireBinding()
    this.connectAttempt += 1
    this.generation += 1
    this.client?.dispose()
    const server = this.reconcileServerScope()
    const discovery = this.safeCurrentDiscovery(server)
    if (!discovery) throw staleScopeError()
    this.client = this.createClient(binding.hubUrl, server, discovery)
    this.refreshInFlight = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.clearAccess()
    return this.generation
  }

  private activateClient(client: TeamHubClient): number {
    this.generation += 1
    this.client?.dispose()
    this.client = client
    this.refreshInFlight = null
    this.hubVerified = false
    this.teamNetworkCapability = null
    this.teamMessagesCapability = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.clearAccess()
    return this.generation
  }

  private invalidateVerifiedClient(state: 'offline' | 'unavailable'): void {
    this.generation += 1
    this.client?.dispose()
    this.client = null
    this.refreshInFlight = null
    this.clearAccess()
    this.hubVerified = false
    this.teamNetworkCapability = null
    this.teamMessagesCapability = null
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.binding = null
    this.transientSecurePeerBinding = false
    this.bootstrapRequired = false
    this.connectionState = state
  }

  private clearAccess(clearIdentity = true): void {
    this.accessToken = ''
    this.accessExpiresAt = 0
    this.explicitRetryAuthentication = null
    if (clearIdentity) {
      this.authCacheEpoch = null
      this.principal = null
      this.session = null
      this.teams = []
    }
  }

  private requireTeamNetworkCapability(): TeamNetworkCapabilities {
    if (!this.teamNetworkCapability) {
      throw new Error('This Team Hub does not support Team Networks yet.')
    }
    return this.teamNetworkCapability
  }

  private requireTeamMessagesCapability(): TeamMessagesCapability {
    if (!this.teamMessagesCapability) {
      throw new Error('This Team Hub does not support Team Messages yet.')
    }
    return this.teamMessagesCapability
  }

  private requireTeamMessagesTeam(scope: TeamHubScope, teamId: unknown): string {
    this.requireScope(scope)
    this.requireTeamMessagesCapability()
    const id = requireTeamNetworkIdentifier(teamId, 'Team')
    const team = this.teams.find(candidate => candidate.id === id)
    if (!team || team.status !== 'active') throw new Error('The selected Team is unavailable for this connection.')
    return id
  }

  private requireTeamAttachmentCache(): TeamAttachmentCache {
    if (!this.teamAttachmentCache) throw new Error('Team attachment caching is unavailable in this app build.')
    return this.teamAttachmentCache
  }

  private purgeTeamAttachmentCache(profileId: string): Promise<void> {
    return this.teamAttachmentCache?.purgeProfile(profileId) ?? Promise.resolve()
  }

  private teamAttachmentCacheIdentity(
    scope: TeamHubScope,
    teamId: string,
    attachmentId: string
  ): TeamAttachmentCacheIdentity {
    this.requireScope(scope)
    if (!scope.hubIdentity) throw staleScopeError()
    if (!this.authCacheEpoch) throw staleScopeError()
    return {
      profileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      authGeneration: scope.generation,
      authCacheEpoch: this.authCacheEpoch,
      serverIdentity: scope.serverIdentity,
      hubId: scope.hubIdentity,
      teamId,
      attachmentId
    }
  }

  private requireTeamNetworkTeam(scope: TeamHubScope, teamId: unknown): string {
    this.requireScope(scope)
    this.requireTeamNetworkCapability()
    const id = requireTeamNetworkIdentifier(teamId, 'Team')
    const team = this.teams.find(candidate => candidate.id === id)
    if (!team || team.status !== 'active') throw new Error('The selected Team Network is unavailable for this connection.')
    return id
  }

  private requireServerManagedHostTeam(scope: TeamHubScope, teamId: string): void {
    this.requireScope(scope)
    const team = this.teams.find(candidate => candidate.id === teamId && candidate.status === 'active')
    if (
      !this.serverAuthenticated
      || !this.designatedHost
      || this.principal?.kind !== 'service'
      || !team
      || team.role !== 'automation'
    ) {
      throw new Error('Only this designated AgentsServer can manage its server connections.')
    }
  }

  private async requireOwnedTeamNetworkContext(
    scope: TeamHubScope,
    teamId: string
  ): Promise<{ server: TeamNetworkServer; agents: TeamNetworkProjection['agents'] }> {
    const capability = this.requireTeamNetworkCapability()
    const serverIdentities = new Set<string>()
    const agentIds = new Set<string>()
    let afterServerId: string | null = null
    let pageCount = 0
    let serverCount = 0
    let agentCount = 0
    while (true) {
      pageCount += 1
      if (pageCount > TEAM_NETWORK_OWNED_SCAN_MAX_PAGES) {
        throw new Error('Team Network ownership scan exceeded the safe page limit.')
      }
      const page = await this.network(scope, {
        teamId,
        ...(afterServerId ? { afterServerId } : {}),
        limit: capability.max_page_items
      })
      this.requireScope(scope)
      serverCount += page.servers.length
      agentCount += page.agents.length
      if (serverCount > TEAM_NETWORK_OWNED_SCAN_MAX_SERVERS || agentCount > TEAM_NETWORK_OWNED_SCAN_MAX_AGENTS) {
        throw new Error('Team Network ownership scan exceeded the safe roster limit.')
      }
      for (const server of page.servers) {
        if (serverIdentities.has(server.server_identity)) {
          throw new Error('Team Hub returned duplicate logical server identities across Team Network pages.')
        }
        serverIdentities.add(server.server_identity)
      }
      for (const agent of page.agents) {
        if (agentIds.has(agent.id)) {
          throw new Error('Team Hub returned duplicate agent identities across Team Network pages.')
        }
        agentIds.add(agent.id)
      }
      const owned = page.servers.filter(server => server.owned_by_caller)
      if (owned.length === 1) return {
        server: owned[0],
        agents: page.agents.filter(agent => agent.server_id === owned[0].id)
      }
      if (!page.has_more) break
      const next = page.next_after_server_id
      if (!next || next === afterServerId) throw new Error('Team Hub returned a stalled Team Network continuation.')
      afterServerId = next
    }
    throw new Error('Team Hub did not identify exactly one active server owned by this connection.')
  }

  private async expectedTeamNetworkSender(
    scope: TeamHubScope,
    teamId: string,
    fromAgentId: string | null
  ): Promise<ExpectedTeamNetworkSender> {
    await this.ensureAccess(this.generation)
    this.requireScope(scope)
    if (!this.serviceAuthenticated()) {
      if (fromAgentId !== null) throw new Error('A human Team Hub session cannot claim agent authorship.')
      if (!this.principal) throw new Error('Team Hub authentication is unavailable.')
      return { kind: 'human', id: this.principal.id }
    }
    const owned = await this.requireOwnedTeamNetworkContext(scope, teamId)
    this.requireScope(scope)
    const server = owned.server
    if (fromAgentId === null) {
      return { kind: 'server', id: server.id, serverIdentity: server.server_identity }
    }
    const agents = owned.agents.filter(agent => (
      agent.id === fromAgentId
      && agent.server_id === server.id
      && agent.status === 'active'
    ))
    if (agents.length !== 1) throw new Error('The selected agent is unavailable on this server.')
    return { kind: 'agent', id: fromAgentId, serverId: server.id }
  }

  private currentScope(): TeamHubScope {
    const server = this.reconcileServerScope()
    const binding = this.requireBinding()
    if (!server.serverIdentity) throw staleScopeError()
    return {
      profileId: server.profileId,
      profileGeneration: server.profileGeneration,
      serverIdentity: server.serverIdentity,
      generation: this.generation,
      hubIdentity: binding.hubIdentity,
      ...(this.connectionId ? { connectionId: this.connectionId } : {}),
      ...(this.hostServerIdentity ? { hostServerIdentity: this.hostServerIdentity } : {})
    }
  }

  private requireScope(scope: TeamHubScope): void {
    const current = this.currentScope()
    if (
      !scope
      || scope.profileId !== current.profileId
      || scope.profileGeneration !== current.profileGeneration
      || scope.serverIdentity !== current.serverIdentity
      || scope.generation !== current.generation
      || scope.hubIdentity !== current.hubIdentity
      || scope.connectionId !== current.connectionId
      || scope.hostServerIdentity !== current.hostServerIdentity
    ) throw staleScopeError()
  }

  private requireGeneration(generation: number): void {
    this.reconcileServerScope()
    if (generation !== this.generation) throw staleScopeError()
  }

  private requireConnectContext(
    attempt: number,
    server: TeamHubServerScope,
    discovered?: TeamHubDiscovery
  ): void {
    const current = this.reconcileServerScope()
    if (attempt !== this.connectAttempt || !sameServerScope(current, server)) throw staleScopeError()
    if (discovered && !sameAdvertisedDiscovery(this.safeCurrentDiscovery(current), discovered)) {
      throw staleScopeError()
    }
  }

  private reconcileServerScope(): TeamHubServerScope {
    const next = cleanServerScope(this.discovery.currentScope())
    if (this.serverScope && sameServerScope(this.serverScope, next)) {
      this.serverScope.serverName = next.serverName
      this.reconcileAdvertisedHub(this.serverScope)
      this.reconcileBackgroundReconnectEligibility(this.serverScope)
      return this.serverScope
    }
    this.abortPairingCompletionWaits()
    this.connectAttempt += 1
    this.generation += 1
    this.client?.dispose()
    this.client = null
    this.serverScope = next
    this.binding = null
    this.transientSecurePeerBinding = false
    this.refreshInFlight = null
    this.hubVerified = false
    this.peerAuthenticated = false
    this.serverAuthenticated = false
    this.bootstrapRequired = false
    this.designatedHost = false
    this.transport = null
    this.connectionId = null
    this.hostServerIdentity = null
    this.routes = []
    this.availabilityMessage = null
    this.availabilityAction = null
    this.reconcileBackgroundReconnectEligibility(next)
    this.backgroundReconnectNotBefore = 0
    this.surfaceReconnectBypassScope = null
    this.connectionState = 'disconnected'
    this.error = null
    this.clearAccess()
    return next
  }

  private rearmBackgroundReconnect(server: TeamHubServerScope): void {
    // Some embedders provide the pre-server-session settings surface. The
    // native store always implements the profile tombstone method; keep those
    // legacy test/integration adapters source-compatible.
    this.settings.setProfileBackgroundReconnectAllowed?.(server.profileId, true)
    this.setBackgroundReconnectAllowed(server, true)
  }

  private reconcileBackgroundReconnectEligibility(server: TeamHubServerScope): void {
    const savedBinding = this.settings.publicSettings(server.profileId)
    const advertised = this.safeCurrentDiscovery(server)
    const advertisedServerSession = this.isAdvertisedServerSession(server, advertised)
    this.backgroundReconnectAllowed = Boolean(
      ((savedBinding && bindingBelongsToServer(savedBinding, server)) || advertisedServerSession)
      && !this.processReconnectSuppressions.has(server.profileId)
      && this.settings.backgroundReconnectAllowed(server.profileId)
    )
  }

  private isServerManaged(server: TeamHubServerScope, savedBinding: TeamHubPublicSettings | null): boolean {
    if (this.isAdvertisedServerSession(server, this.safeCurrentDiscovery(server))) return true
    return this.isSavedServerSessionBinding(server, savedBinding)
  }

  private isSavedServerSessionBinding(
    server: TeamHubServerScope,
    savedBinding: TeamHubPublicSettings | null
  ): boolean {
    if (!savedBinding || !bindingBelongsToServer(savedBinding, server)) return false
    try {
      return savedBinding.hubUrl === deriveServerTeamHubURL(server.serverUrl, '/api/team-hub-server')
    } catch {
      return false
    }
  }

  private requireServerSessionContinuity(server: TeamHubServerScope, advertised: TeamHubDiscovery): void {
    if (
      advertised.transport !== 'secure_peer'
      && !isServerSessionBasePath(advertised.serverSessionBasePath)
      && this.isSavedServerSessionBinding(server, this.settings.publicSettings(server.profileId))
    ) {
      throw new Error('The selected AgentsServer no longer advertises its authenticated server Teamspace session. Update or restart AgentsServer before reconnecting.')
    }
  }

  private isAdvertisedServerSession(
    server: TeamHubServerScope,
    advertised: TeamHubDiscovery | null
  ): boolean {
    return Boolean(
      server.serverIdentity
      && advertised?.available
      && advertised.designatedHost
      && advertised.basePath === '/api/team-hub'
      && advertised.hostServerIdentity === server.serverIdentity
      && advertised.hubIdentity
      && advertised.transport !== 'secure_peer'
      && isServerSessionBasePath(advertised.serverSessionBasePath)
    )
  }

  private disableBackgroundReconnect(): string | null {
    const server = this.reconcileServerScope()
    try {
      this.setBackgroundReconnectAllowed(server, false)
      return null
    } catch {
      // The explicit local action still wins for this process. Surface the
      // durability failure without leaving the verified session connected.
      this.backgroundReconnectAllowed = false
      this.backgroundReconnectNotBefore = 0
      return 'Disconnected, but the reconnect preference could not be saved. Reconnect may be offered again after restarting the app.'
    }
  }

  private setBackgroundReconnectAllowed(server: TeamHubServerScope, allowed: boolean): void {
    if (!allowed) this.abortPairingCompletionWaits()
    if (allowed) this.processReconnectSuppressions.delete(server.profileId)
    else this.processReconnectSuppressions.add(server.profileId)
    this.backgroundReconnectAllowed = allowed
    this.backgroundReconnectNotBefore = 0
    if (!server.serverIdentity) return
    const savedBinding = this.settings.publicSettings(server.profileId)
    if (!savedBinding || !bindingBelongsToServer(savedBinding, server)) return
    this.settings.setBackgroundReconnectAllowed(savedBinding, allowed)
  }

  private reconcileAdvertisedHub(server: TeamHubServerScope): void {
    if (!this.hubVerified || !this.binding) return
    const advertised = this.safeCurrentDiscovery(server)
    // Secure-peer control is the authority for an active outgoing route. A
    // non-secure snapshot can coexist with an explicitly selected transient
    // peer (and the capability can briefly lag saved-peer startup recovery),
    // so it is not replacement evidence. A missing authenticated health
    // snapshot is different and must fail closed. Once connected, typed proxy
    // transport failures also invalidate immediately in withAuth().
    if (this.transport === 'secure_peer' && advertised?.transport !== 'secure_peer' && advertised !== null) return
    if ((!this.serverAuthenticated || isServerSessionBasePath(advertised?.serverSessionBasePath)) && discoveryMatchesAdvertisedBinding(
      advertised,
      server.serverUrl,
      this.binding.hubIdentity,
      server.serverIdentity,
      this.binding.hubUrl,
      this.binding.connectionId,
      this.binding.hostServerIdentity
    )) return

    const unavailable = Boolean(advertised && !advertised.available)
    this.invalidateVerifiedClient(unavailable ? 'unavailable' : 'offline')
    this.designatedHost = false
    this.transport = null
    this.connectionId = null
    this.hostServerIdentity = null
    this.routes = []
    this.availabilityMessage = null
    this.availabilityAction = null
    if (advertised) {
      this.designatedHost = advertised.designatedHost
      this.transport = advertised.transport
      this.connectionId = advertised.connectionId ?? null
      this.hostServerIdentity = advertised.transport === 'secure_peer' ? advertised.hostServerIdentity : null
      this.routes = clone(advertised.routes ?? [])
      this.availabilityMessage = advertised.message
      this.availabilityAction = advertised.action
    }
    this.error = !advertised
      ? 'AgentsServer is unreachable or restarting. Teamspace will reconnect automatically.'
      : unavailable
        ? advertised.message ?? 'Team Hub is no longer available from the active AgentsServer.'
        : 'The active AgentsServer Team Hub identity changed or is no longer verified. Forget the saved identity only after confirming the host change.'
  }

  private safeCurrentDiscovery(server: TeamHubServerScope): TeamHubDiscovery | null {
    try {
      return this.discovery.currentDiscovery(clone(server))
    } catch {
      return null
    }
  }

  private async probeTeamHubCandidate(
    candidate: TeamHubClient,
    discovered: TeamHubDiscovery,
    server: TeamHubServerScope,
    advertised: TeamHubDiscovery,
    connectAttempt: number
  ): Promise<{
    health: Awaited<ReturnType<TeamHubClient['health']>>
    peerSession: Awaited<ReturnType<TeamHubClient['peerSession']>> | null
    serverSession: Awaited<ReturnType<TeamHubClient['serverSession']>> | null
  }> {
    const health = await candidate.health()
    this.requireConnectContext(connectAttempt, server, advertised)
    if (!health.ok || health.service !== 'agentsdock-team-hub' || health.api_version !== 1) {
      throw new Error('This URL is not an AgentsDock Team Hub V1 service.')
    }
    if (health.hub_id !== discovered.hubIdentity) {
      throw new Error('Mounted Team Hub identity does not match the active AgentsServer capability.')
    }
    if (discovered.serverSessionBasePath) {
      if (health.bootstrap_required || !health.bootstrapped) {
        return { health, peerSession: null, serverSession: null }
      }
      if (health.server_session_available !== true) {
        throw new Error('AgentsServer did not authorize its server-scoped Teamspace session.')
      }
      const serverSession = await candidate.serverSession()
      this.requireConnectContext(connectAttempt, server, advertised)
      requireValidServerSession(serverSession, this.now())
      return { health, peerSession: null, serverSession }
    }
    if (discovered.transport !== 'secure_peer') return { health, peerSession: null, serverSession: null }
    if (health.peer_session_available !== true) {
      throw new Error('The paired server did not authorize a peer-native Teamspace session.')
    }
    if (health.bootstrap_required || !health.bootstrapped) {
      throw new Error('The paired Teamspace host is not initialized.')
    }
    const peerSession = await candidate.peerSession()
    this.requireConnectContext(connectAttempt, server, advertised)
    requireValidPeerSession(peerSession)
    return { health, peerSession, serverSession: null }
  }

  private async discoveryWithActiveSecurePeer(
    server: TeamHubServerScope,
    advertised: TeamHubDiscovery,
    preferredTransport: 'tailscale_serve' | 'secure_peer' | undefined,
    connectAttempt: number
  ): Promise<{
    discovery: TeamHubDiscovery
    activeTransientPairing: SecurePeerPairing | null
    preserveTransientRuntimeOnFailure: boolean
  }> {
    if (preferredTransport === 'tailscale_serve' || !this.discovery.securePeerStatus) {
      return {
        discovery: advertised,
        activeTransientPairing: null,
        preserveTransientRuntimeOnFailure: false
      }
    }
    if (!server.serverIdentity) throw staleScopeError()
    const savedSecureBinding = this.savedSecurePeerBinding(server)
    let control: SecurePeerControlStatus
    try {
      control = await this.securePeerControlForConnect(
        server,
        advertised,
        connectAttempt,
        savedSecureBinding
      )
    } catch (error) {
      // Secure-peer control is an optional capability beside a healthy local
      // or Tailscale Hub. Automatic selection may use that authenticated
      // advertised route when control is temporarily unavailable, but an
      // explicit/already-advertised secure route must still fail closed.
      if (preferredTransport === 'secure_peer' || advertised.transport === 'secure_peer') throw error
      return {
        discovery: advertised,
        activeTransientPairing: null,
        preserveTransientRuntimeOnFailure: false
      }
    }
    this.requireSecurePeerControlScope(control, server)
    if (this.revokedCurrentTransientPairing(control)) {
      // This connect attempt owns the fence, so do not invalidate its attempt
      // number while disposing the previously verified peer runtime.
      this.dropSecurePeerRuntime(true, true)
      this.requireConnectContext(connectAttempt, server, advertised)
      return {
        discovery: advertised,
        activeTransientPairing: null,
        preserveTransientRuntimeOnFailure: false
      }
    }
    const activeTransientPairing = this.activeCurrentTransientPairing(control)
    const preserveTransientRuntimeOnFailure = Boolean(activeTransientPairing)
    const effectiveControl = activeTransientPairing && control.connectionError
      ? { ...control, connectionError: null }
      : control
    return {
      discovery: activeTransientPairing && activeTransientPairing.transportState !== 'online'
        ? advertised
        : discoveryWithActiveSecurePeer(advertised, effectiveControl),
      activeTransientPairing,
      preserveTransientRuntimeOnFailure
    }
  }

  private savedSecurePeerBinding(server: TeamHubServerScope): TeamHubPublicSettings | null {
    const saved = this.settings.publicSettings(server.profileId)
    return saved
      && saved.connectionId
      && saved.hostServerIdentity
      && saved.serverUrl === server.serverUrl
      && saved.serverIdentity === server.serverIdentity
      ? saved
      : null
  }

  private async securePeerControlForConnect(
    server: TeamHubServerScope,
    advertised: TeamHubDiscovery,
    connectAttempt: number,
    savedBinding: TeamHubPublicSettings | null
  ): Promise<SecurePeerControlStatus> {
    if (!this.discovery.securePeerStatus) throw securePeerUnavailable()
    const scope: SecurePeerProfileScope = {
      profileId: server.profileId,
      profileGeneration: server.profileGeneration,
      serverIdentity: server.serverIdentity!
    }
    const delays = savedBinding ? this.securePeerStartupRecoveryDelaysMs : []
    let lastError: unknown
    for (let index = 0; index <= delays.length; index += 1) {
      try {
        const control = ignoreLegacyTeamspaceCrossChatWarning(
          await this.discovery.securePeerStatus(scope)
        )
        this.requireConnectContext(connectAttempt, server, advertised)
        this.requireSecurePeerControlScope(control, server)
        if (
          !savedBinding
          || securePeerControlSettledForSavedBinding(control, savedBinding)
          || index === delays.length
        ) return control
      } catch (error) {
        lastError = error
        this.requireConnectContext(connectAttempt, server, advertised)
        if (!savedBinding || index === delays.length) throw error
      }
      await this.wait(Math.max(0, Number(delays[index]) || 0))
      this.requireConnectContext(connectAttempt, server, advertised)
    }
    throw lastError ?? securePeerUnavailable()
  }

  private savedLocalBinding(server: TeamHubServerScope): TeamHubPublicSettings | null {
    const saved = this.settings.publicSettings(server.profileId)
    return saved
      && saved.profileId === server.profileId
      && !saved.connectionId
      && saved.serverUrl === server.serverUrl
      && saved.serverIdentity === server.serverIdentity
      ? saved
      : null
  }

  private matchesCurrentTransientPairing(
    pairing: SecurePeerPairing,
    expectedLifecycle: 'active' | 'revoked'
  ): boolean {
    const binding = this.binding
    const connectionId = binding?.connectionId
    const hostServerIdentity = binding?.hostServerIdentity
    return Boolean(
      this.transientSecurePeerBinding
      && this.transport === 'secure_peer'
      && connectionId
      && hostServerIdentity
      && this.connectionId === connectionId
      && this.hostServerIdentity === hostServerIdentity
      && pairing.direction === 'outgoing'
      && (expectedLifecycle === 'revoked'
        ? pairing.trustState === 'revoked' && pairing.transportState === 'revoked'
        : pairing.trustState === 'approved' && pairing.transportState !== 'revoked')
      && pairing.connectionId === connectionId
      && pairing.hostServerIdentity === hostServerIdentity
      && pairing.peerServerIdentity === hostServerIdentity
      && pairing.hubIdentity === binding.hubIdentity
      && (expectedLifecycle !== 'active'
        || pairing.localProxyBasePath === `/api/team-hub-secure/${connectionId}`)
    )
  }

  private exactCurrentTransientPairing(
    control: SecurePeerControlStatus,
    expectedLifecycle: 'active' | 'revoked'
  ): SecurePeerPairing | null {
    const connectionId = this.binding?.connectionId
    if (!connectionId) return null
    const matches = control.pairings.filter(pairing => (
      pairing.direction === 'outgoing'
      && pairing.connectionId === connectionId
    ))
    return matches.length === 1 && this.matchesCurrentTransientPairing(matches[0], expectedLifecycle)
      ? matches[0]
      : null
  }

  private activeCurrentTransientPairing(control: SecurePeerControlStatus): SecurePeerPairing | null {
    const pairing = this.exactCurrentTransientPairing(control, 'active')
    return pairing && control.activeConnectionId === pairing.connectionId ? pairing : null
  }

  private revokedCurrentTransientPairing(control: SecurePeerControlStatus): SecurePeerPairing | null {
    const pairing = this.exactCurrentTransientPairing(control, 'revoked')
    return pairing && control.activeConnectionId !== pairing.connectionId ? pairing : null
  }

  private requireSecurePeerControlScope(control: SecurePeerControlStatus, server: TeamHubServerScope): void {
    if (
      control.profileId !== server.profileId
      || control.profileGeneration !== server.profileGeneration
      || control.serverIdentity !== server.serverIdentity
    ) throw new Error('Secure peer status came from a different AgentsServer profile.')
  }

  private async retirePeerRevokedTransientConnection(
    server: TeamHubServerScope,
    observedPairing: SecurePeerPairing,
    connectAttempt: number
  ): Promise<boolean> {
    if (!this.matchesCurrentTransientPairing(observedPairing, 'active')) return false
    const connectionId = observedPairing.connectionId
    const hubIdentity = observedPairing.hubIdentity
    if (!connectionId || !hubIdentity) return false

    // A typed peer_revoked response came from the exact pinned proxy route.
    // Fence it before any best-effort local control-plane cleanup.
    this.dropSecurePeerRuntime(true, true)
    this.requireConnectContext(connectAttempt, server)
    if (!this.discovery.securePeerStatus) return false
    const scope: SecurePeerProfileScope = {
      profileId: server.profileId,
      profileGeneration: server.profileGeneration,
      serverIdentity: server.serverIdentity!
    }
    let control: SecurePeerControlStatus
    try {
      control = await this.discovery.securePeerStatus(scope)
    } catch {
      this.requireConnectContext(connectAttempt, server)
      return false
    }
    this.requireConnectContext(connectAttempt, server)
    this.requireSecurePeerControlScope(control, server)
    if (control.activeConnectionId === null) return true
    if (control.activeConnectionId !== connectionId) return false
    const matches = control.pairings.filter(pairing => (
      pairing.direction === 'outgoing'
      && pairing.trustState === 'approved'
      && pairing.transportState !== 'revoked'
      && pairing.connectionId === connectionId
      && pairing.hostServerIdentity === observedPairing.hostServerIdentity
      && pairing.peerServerIdentity === observedPairing.hostServerIdentity
      && pairing.hubIdentity === hubIdentity
    ))
    if (matches.length !== 1) return false

    const deactivateInput: SecurePeerDeactivateInput = {
      connectionId,
      expectedHostServerIdentity: observedPairing.hostServerIdentity,
      expectedHubIdentity: hubIdentity
    }
    // Remote revocation is not authority to delete the user's local pairing
    // record or key material. Compatibility cleanup may only deactivate the
    // exact still-active connection; explicit Forget remains user-owned.
    if (!this.discovery.deactivateSecurePeerConnection) return false
    try {
      const deactivated = await this.discovery.deactivateSecurePeerConnection(scope, deactivateInput)
      this.requireConnectContext(connectAttempt, server)
      this.requireSecurePeerControlScope(deactivated, server)
      return deactivated.activeConnectionId === null
    } catch {
      this.requireConnectContext(connectAttempt, server)
      return false
    }
  }

  private requireAdvertisedBinding(server: TeamHubServerScope, binding: TeamHubPublicSettings): void {
    const current = this.reconcileServerScope()
    if (
      !sameServerScope(current, server)
      || !discoveryMatchesAdvertisedBinding(
        this.safeCurrentDiscovery(current),
        current.serverUrl,
        binding.hubIdentity,
        current.serverIdentity,
        binding.hubUrl,
        binding.connectionId,
        binding.hostServerIdentity
      )
    ) throw staleScopeError()
  }

  private requireBinding(): TeamHubPublicSettings {
    if (!this.binding) throw staleScopeError()
    return this.binding
  }

  private requireClient(): TeamHubClient {
    if (!this.client) throw new Error('Connect to and verify Team Hub before making requests.')
    return this.client
  }

  private createClient(url: string, server: TeamHubServerScope, discovery: TeamHubDiscovery): TeamHubClient {
    if (discovery.serverSessionBasePath) {
      if (!discovery.designatedHost || !isServerSessionBasePath(discovery.serverSessionBasePath)) throw staleScopeError()
      if (!this.discovery.serverTeamHubProxyFetch) throw serverTeamspaceUnavailable()
      const proxyFetch = this.discovery.serverTeamHubProxyFetch(clone(server), discovery.serverSessionBasePath)
      const proxyURL = deriveServerTeamHubURL(server.serverUrl, discovery.serverSessionBasePath)
      return this.clientFactory(proxyURL, { fetch: proxyFetch })
    }
    if (discovery.transport !== 'secure_peer') return this.clientFactory(url)
    if (!isSecurePeerBasePath(discovery.basePath)) throw staleScopeError()
    if (!this.discovery.secureTeamHubProxyFetch) throw securePeerUnavailable()
    const proxyFetch = this.discovery.secureTeamHubProxyFetch(clone(server), discovery.basePath)
    let client!: TeamHubClient
    const trackedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      try {
        return await proxyFetch(input, init)
      } catch (error) {
        // TeamHubClient intentionally redacts transport details into a generic
        // public error. Retain only narrowly typed network/timeout evidence so
        // a reconnect can distinguish retryable transport loss from a parsed
        // identity/protocol rejection without inspecting error text.
        if (isStructuredRetryableTransportFailure(error)) {
          this.retryableCandidateTransportFailures.add(client)
        }
        throw error
      }
    }) as typeof fetch
    client = new TeamHubClient(url, { fetch: trackedFetch })
    return client
  }

  private isRetryableCandidateFailure(candidate: TeamHubClient, error: unknown): boolean {
    if (this.retryableCandidateTransportFailures.has(candidate)) return true
    return error instanceof TeamHubClientError
      && [408, 425, 429, 500, 502, 503, 504].includes(error.status)
  }

  private requireSecurePeerProfileScope(scope: SecurePeerProfileScope): TeamHubServerScope {
    const server = this.reconcileServerScope()
    if (
      !scope || !server.serverIdentity
      || scope.profileId !== server.profileId
      || scope.profileGeneration !== server.profileGeneration
      || scope.serverIdentity !== server.serverIdentity
    ) throw staleScopeError()
    return clone(server)
  }

  private requireSameServerScope(expected: TeamHubServerScope): void {
    if (!sameServerScope(this.reconcileServerScope(), expected)) throw staleScopeError()
  }

  private requirePrincipal() {
    if (!this.principal) throw new Error('Team Hub sign-in is required.')
    return this.principal
  }

}

function staleScopeError(): Error {
  const error = new Error('Team Hub connection changed. Refresh Teamspace and try again.')
  error.name = 'TeamHubScopeChangedError'
  return error
}

function requireServerName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Server name is required.')
  const clean = value.trim()
  if (!clean) throw new Error('Server name is required.')
  if (Buffer.byteLength(clean, 'utf8') > 160 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error('Server name is invalid.')
  }
  return clean
}

function securePeerUnavailable(): Error {
  return new Error('Update AgentsServer to use secure server pairing.')
}

function teamHubHostControlUnavailable(): Error {
  return new Error('Update AgentsServer to make this server the Team Network host.')
}

function serverTeamspaceUnavailable(): Error {
  return new Error('Update AgentsDock to use this server-bound Teamspace.')
}

function isSecurePeerBasePath(value: string | null): value is string {
  return typeof value === 'string'
    && /^\/api\/team-hub-secure\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function isServerSessionBasePath(value: string | null | undefined): value is '/api/team-hub-server' {
  return value === '/api/team-hub-server'
}

function isStaleScopeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TeamHubScopeChangedError'
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : 'Team Hub request failed.'
}

function cleanServerScope(value: TeamHubServerScope): TeamHubServerScope {
  if (!value || typeof value !== 'object') throw new Error('The active AgentsServer profile is unavailable.')
  const profileId = requireIdentifier(value.profileId, 'AgentsServer profile')
  if (!Number.isSafeInteger(value.profileGeneration) || value.profileGeneration < 1) {
    throw new Error('The active AgentsServer profile generation is invalid.')
  }
  const serverIdentity = value.serverIdentity == null
    ? null
    : requireIdentifier(value.serverIdentity, 'AgentsServer')
  const serverUrl = requireString(value.serverUrl, 'AgentsServer URL', 2_048)
  let parsed: URL
  try { parsed = new URL(serverUrl) } catch { throw new Error('The active AgentsServer URL is invalid.') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The active AgentsServer URL is invalid.')
  }
  return {
    profileId,
    profileGeneration: value.profileGeneration,
    serverIdentity,
    serverUrl: parsed.toString().replace(/\/$/, ''),
    serverName: requireString(value.serverName, 'AgentsServer name', 160)
  }
}

function sameServerScope(left: TeamHubServerScope, right: TeamHubServerScope): boolean {
  return left.profileId === right.profileId
    && left.profileGeneration === right.profileGeneration
    && left.serverIdentity === right.serverIdentity
    && left.serverUrl === right.serverUrl
}

function bindingBelongsToServer(binding: TeamHubVerifiedBinding, server: TeamHubServerScope): boolean {
  return server.serverIdentity !== null
    && binding.profileId === server.profileId
    && binding.serverUrl === server.serverUrl
    && binding.serverIdentity === server.serverIdentity
}

function isBackgroundReconnectableState(
  state: TeamHubStatus['connectionState'],
  serverManaged: boolean
): boolean {
  return state === 'disconnected'
    || state === 'offline'
    || state === 'unavailable'
    || state === 'error'
    || (serverManaged && state === 'signed-out')
}

function discoveredTeamHubURL(serverURL: string, discovery: TeamHubDiscovery): string {
  if (discovery.transport === 'secure_peer') {
    if (!discovery.connectionId || !isSecurePeerBasePath(discovery.basePath)) {
      throw new Error('AgentsServer did not advertise a complete secure Teamspace proxy binding.')
    }
    return deriveSecurePeerTeamHubURL(serverURL, discovery.basePath, discovery.hubUrl)
  }
  if (discovery.transport === 'tailscale_serve') {
    if (!discovery.hubUrl) throw new Error('AgentsServer did not advertise its private Tailscale Serve Team Hub URL.')
    return normalizeTailscaleServeTeamHubURL(discovery.hubUrl)
  }
  if (discovery.transport === 'direct_ip') {
    if (!discovery.hubUrl) throw new Error('AgentsServer did not advertise its direct-IP Team Hub URL.')
    return normalizeDirectIPTeamHubURL(discovery.hubUrl, serverURL)
  }
  if (discovery.transport !== 'loopback' || !discovery.basePath) {
    throw new Error('AgentsServer returned an invalid Team Hub V1 transport.')
  }
  const derived = deriveMountedTeamHubURL(serverURL, discovery.basePath)
  if (discovery.hubUrl && discovery.hubUrl !== derived) {
    throw new Error('AgentsServer advertised a mismatched loopback Team Hub URL.')
  }
  return derived
}

function selectTeamHubRoute(
  serverURL: string,
  discovery: TeamHubDiscovery,
  preferred?: 'tailscale_serve' | 'secure_peer',
  savedHubUrl?: string,
): TeamHubDiscovery {
  const advertisedRoutes = discovery.routes?.length
    ? discovery.routes
    : discovery.transport
      ? [{ transport: discovery.transport, hubUrl: discovery.hubUrl }]
      : []
  // Keep accepting the API14 capability shape during rolling upgrades, but
  // never offer, restore, or select its legacy plaintext Direct-IP route.
  const activeServerIsLoopback = isLoopbackHostname(new URL(serverURL).hostname)
  const routes = advertisedRoutes.filter(route => (
    route.transport !== 'direct_ip'
    && (route.transport !== 'loopback' || activeServerIsLoopback)
  ))
  let selected = preferred
    ? routes.find(route => route.transport === preferred)
    : undefined
  if (preferred && !selected) {
    throw new Error(`This Teamspace host does not advertise ${transportLabel(preferred)}.`)
  }
  if (!selected) {
    const saved = savedHubUrl
      ? routes.find(route => route.hubUrl === savedHubUrl)
      : undefined
    const primary = routes.find(route => (
      route.transport === discovery.transport && route.hubUrl === discovery.hubUrl
    ))
    selected = saved
      ?? primary
      ?? routes.find(route => route.transport === 'secure_peer')
      ?? routes.find(route => route.transport === 'tailscale_serve')
      ?? routes.find(route => route.transport === 'loopback')
  }
  if (!selected) {
    if (discovery.available && advertisedRoutes.some(route => route.transport === 'direct_ip')) {
      throw new Error('Legacy plaintext Direct IP connections have been removed. Start Secure server pairing below, or enable Private Tailscale Serve.')
    }
    return { ...discovery, routes: clone(advertisedRoutes) }
  }
  return {
    ...discovery,
    transport: selected.transport,
    hubUrl: selected.hubUrl,
    ...(selected.transport === 'secure_peer' ? {
      basePath: selected.basePath ?? null,
      connectionId: selected.connectionId,
      hostServerIdentity: selected.hostServerIdentity ?? null,
      hubIdentity: selected.hubIdentity ?? null
    } : {}),
    routes: clone(advertisedRoutes),
  }
}

/**
 * AgentsServer releases through 0.1.26-beta.3 could report a cross-chat route
 * refresh failure after successfully authenticating a Teamspace-only peer.
 * That warning is irrelevant when the exact active pairing never received a
 * cross-chat scope; the mounted Hub health and peer-session checks below still
 * validate the actual Teamspace transport before it is committed.
 */
function ignoreLegacyTeamspaceCrossChatWarning(
  control: SecurePeerControlStatus
): SecurePeerControlStatus {
  if (
    control.connectionError?.trim() !== 'Peer cross-chat approval is not current'
    || !control.activeConnectionId
  ) return control
  const matches = control.pairings.filter(pairing => (
    pairing.direction === 'outgoing'
    && pairing.trustState === 'approved'
    && pairing.transportState === 'online'
    && pairing.connectionId === control.activeConnectionId
  ))
  if (matches.length !== 1 || matches[0].error) return control
  const granted = new Set(matches[0].grantedScopes)
  if (
    !granted.has('teamspace.read')
    || !granted.has('teamspace.write')
    || [...granted].some(scope => scope.startsWith('cross_chat.'))
  ) return control
  return { ...control, connectionError: null }
}

function securePeerControlSettledForSavedBinding(
  control: SecurePeerControlStatus,
  binding: TeamHubPublicSettings
): boolean {
  const connectionId = binding.connectionId
  const hostServerIdentity = binding.hostServerIdentity
  if (!connectionId || !hostServerIdentity) return true
  if (control.activeConnectionId && control.activeConnectionId !== connectionId) return true
  const matches = control.pairings.filter(pairing => (
    pairing.direction === 'outgoing'
    && pairing.connectionId === connectionId
  ))
  if (matches.some(pairing => pairing.trustState === 'revoked' || pairing.transportState === 'revoked')) {
    return true
  }
  if (control.activeConnectionId !== connectionId || matches.length !== 1) return false
  const pairing = matches[0]!
  if (
    pairing.hostServerIdentity !== hostServerIdentity
    || pairing.peerServerIdentity !== hostServerIdentity
    || pairing.hubIdentity !== binding.hubIdentity
  ) return true
  return pairing.trustState === 'approved'
    && pairing.transportState === 'online'
    && !pairing.error
    && !control.connectionError
}

function discoveryWithActiveSecurePeer(
  advertised: TeamHubDiscovery,
  control: SecurePeerControlStatus
): TeamHubDiscovery {
  const activeConnectionId = control.activeConnectionId
  if (!activeConnectionId) {
    if (advertised.transport === 'secure_peer') {
      throw new Error('AgentsServer advertised a secure peer route without an exact active connection.')
    }
    return advertised
  }
  if (control.connectionError) {
    throw new Error('The active secure peer connection is unavailable.')
  }
  const matches = control.pairings.filter(pairing => (
    pairing.direction === 'outgoing'
    && pairing.connectionId === activeConnectionId
  ))
  if (matches.length !== 1) {
    throw new Error('AgentsServer reported an inconsistent active secure peer connection.')
  }
  const pairing = matches[0]
  const basePath = `/api/team-hub-secure/${activeConnectionId}`
  if (
    pairing.trustState !== 'approved'
    || pairing.transportState !== 'online'
    || pairing.localProxyBasePath !== basePath
    || !pairing.hubIdentity
    || pairing.peerServerIdentity !== pairing.hostServerIdentity
  ) {
    throw new Error('AgentsServer reported an incomplete active secure peer connection.')
  }
  if (
    advertised.transport === 'secure_peer'
    && (
      advertised.connectionId !== activeConnectionId
      || advertised.basePath !== basePath
      || advertised.hostServerIdentity !== pairing.hostServerIdentity
      || advertised.hubIdentity !== pairing.hubIdentity
    )
  ) {
    throw new Error('AgentsServer secure peer discovery does not match its active connection.')
  }
  const route: TeamHubRoute = {
    transport: 'secure_peer',
    hubUrl: null,
    basePath,
    connectionId: activeConnectionId,
    hostServerIdentity: pairing.hostServerIdentity,
    hubIdentity: pairing.hubIdentity
  }
  return {
    available: true,
    designatedHost: false,
    version: 1,
    basePath,
    transport: 'secure_peer',
    hubUrl: null,
    hubIdentity: pairing.hubIdentity,
    hostServerIdentity: pairing.hostServerIdentity,
    connectionId: activeConnectionId,
    routes: [route],
    message: `Securely connected to ${pairing.peerDisplayName}.`,
    action: null
  }
}

function requireValidTeamHubDiscovery(server: TeamHubServerScope, discovered: TeamHubDiscovery): void {
  if (
    discovered.version !== 1
    || (discovered.transport === 'secure_peer'
      ? discovered.designatedHost || !isSecurePeerBasePath(discovered.basePath)
      : !discovered.designatedHost || discovered.basePath !== '/api/team-hub')
    || !discovered.transport
    || !discovered.hubIdentity
    || (discovered.serverSessionBasePath !== undefined && (
      discovered.transport === 'secure_peer'
      || !isServerSessionBasePath(discovered.serverSessionBasePath)
    ))
    || (discovered.transport === 'secure_peer'
      ? !discovered.connectionId || !discovered.hostServerIdentity
      : discovered.hostServerIdentity !== server.serverIdentity)
  ) throw new Error('AgentsServer returned an invalid Team Hub V1 capability.')
}

function isExactPeerRevokedError(error: unknown): error is TeamHubClientError {
  return error instanceof TeamHubClientError
    && error.status === 401
    && error.code === 'peer_revoked'
}

function isUnsupportedDeletionJournalError(error: unknown): error is TeamHubClientError {
  return error instanceof TeamHubClientError
    && (
      error.status === 403 && error.code === 'route_forbidden'
      || error.status === 404 && error.code === 'not_found'
    )
}

function teamHubLifecycleKey(scope: TeamHubScope): string {
  return JSON.stringify([
    scope.profileId,
    scope.profileGeneration,
    scope.serverIdentity,
    scope.generation,
    scope.hubIdentity,
    scope.connectionId ?? null,
    scope.hostServerIdentity ?? null
  ])
}

function isStructuredRetryableTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError'
  }
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return typeof code === 'string' && new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT'
  ]).has(code)
}

function requireValidPeerSession(
  snapshot: Awaited<ReturnType<TeamHubClient['peerSession']>>
): void {
  if (snapshot.principal.kind !== 'service' && snapshot.principal.kind !== 'node') {
    throw new Error('The secure peer session did not identify a server principal.')
  }
}

function requireValidServerSession(
  snapshot: Awaited<ReturnType<TeamHubClient['serverSession']>>,
  now: number
): void {
  const team = snapshot.teams[0]
  const expiresAt = Date.parse(snapshot.session.expires_at)
  if (
    snapshot.principal.kind !== 'service'
    || snapshot.principal.id !== 'service_managed_server'
    || snapshot.teams.length !== 1
    || team?.role !== 'automation'
    || team.status !== 'active'
    || snapshot.session.id !== `managed_server_session_${team.id}`
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
  ) {
    throw new Error('AgentsServer returned an invalid server-scoped Teamspace session.')
  }
}

function transportLabel(transport: TeamHubTransport): string {
  if (transport === 'tailscale_serve') return 'Private Tailscale Serve'
  if (transport === 'direct_ip') return 'Direct IP (unencrypted)'
  if (transport === 'secure_peer') return 'Secure paired server'
  return 'host-local access'
}

function selectableTeamHubTransport(input: TeamHubConnectInput): 'tailscale_serve' | 'secure_peer' | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Teamspace connection choice is invalid.')
  }
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'transport' && key !== 'backgroundReconnect' && key !== 'surfaceReconnect')) {
    throw new Error('Teamspace connection choice is invalid.')
  }
  const transport: unknown = (input as { transport?: unknown }).transport
  if (input.backgroundReconnect !== undefined && input.surfaceReconnect !== undefined) {
    throw new Error('Teamspace reconnect mode is invalid.')
  }
  if (transport !== undefined && (input.backgroundReconnect !== undefined || input.surfaceReconnect !== undefined)) {
    throw new Error('A scoped Teamspace reconnect cannot select a different transport.')
  }
  if (transport === undefined) return undefined
  if (transport === 'tailscale_serve' || transport === 'secure_peer') return transport
  if (transport === 'direct_ip') {
    throw new Error('Legacy plaintext Direct IP connections have been removed. Use Secure server pairing or Private Tailscale Serve.')
  }
  throw new Error('Teamspace connection choice is invalid.')
}

function parseBackgroundReconnectScope(input: TeamHubConnectInput): NonNullable<TeamHubConnectInput['backgroundReconnect']> | null {
  return parseReconnectScope(
    input.backgroundReconnect,
    'Background',
    Object.prototype.hasOwnProperty.call(input, 'backgroundReconnect')
  )
}

function parseSurfaceReconnectScope(input: TeamHubConnectInput): NonNullable<TeamHubConnectInput['surfaceReconnect']> | null {
  return parseReconnectScope(
    input.surfaceReconnect,
    'Surface',
    Object.prototype.hasOwnProperty.call(input, 'surfaceReconnect')
  )
}

function parseReconnectScope(
  value: unknown,
  label: 'Background' | 'Surface',
  present: boolean
): NonNullable<TeamHubConnectInput['backgroundReconnect']> | null {
  if (!present) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} Teamspace reconnect scope is invalid.`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || keys.some(key => !['profileId', 'profileGeneration', 'serverIdentity', 'generation'].includes(key))) {
    throw new Error(`${label} Teamspace reconnect scope is invalid.`)
  }
  const profileId = requireIdentifier(record.profileId, 'AgentsServer profile')
  const serverIdentity = requireIdentifier(record.serverIdentity, 'AgentsServer')
  if (!Number.isSafeInteger(record.profileGeneration) || Number(record.profileGeneration) < 1) {
    throw new Error(`${label} Teamspace reconnect profile generation is invalid.`)
  }
  if (!Number.isSafeInteger(record.generation) || Number(record.generation) < 1) {
    throw new Error(`${label} Teamspace reconnect generation is invalid.`)
  }
  return {
    profileId,
    profileGeneration: Number(record.profileGeneration),
    serverIdentity,
    generation: Number(record.generation)
  }
}

function sameBackgroundReconnectScope(
  expected: NonNullable<TeamHubConnectInput['backgroundReconnect']>,
  server: TeamHubServerScope,
  generation: number
): boolean {
  return expected.profileId === server.profileId
    && expected.profileGeneration === server.profileGeneration
    && expected.serverIdentity === server.serverIdentity
    && expected.generation === generation
}

function discoveryMatchesAdvertisedBinding(
  discovery: TeamHubDiscovery | null,
  serverURL: string,
  hubIdentity: string | null,
  serverIdentity: string | null,
  hubUrl: string | null,
  connectionId?: string,
  hostServerIdentity?: string
): boolean {
  let boundLoopback = false
  let boundDirectIP = false
  let boundSecurePeer = false
  let boundServerSession = false
  try {
    const url = hubUrl ? new URL(hubUrl) : null
    boundLoopback = Boolean(url && url.protocol === 'http:' && isLoopbackHostname(url.hostname))
    boundDirectIP = Boolean(url && url.protocol === 'http:' && !isLoopbackHostname(url.hostname))
    // Reconstruct the connection-bound proxy from the authenticated
    // AgentsServer URL. This preserves an exact reverse-proxy prefix and
    // prevents a lookalike secure suffix on another mounted path from
    // satisfying runtime reconciliation.
    boundSecurePeer = Boolean(
      hubUrl
      && connectionId
      && discovery?.basePath
      && isSecurePeerBasePath(discovery.basePath)
      && hubUrl === deriveSecurePeerTeamHubURL(serverURL, discovery.basePath, null)
    )
    boundServerSession = Boolean(
      hubUrl
      && isServerSessionBasePath(discovery?.serverSessionBasePath)
      && hubUrl === deriveServerTeamHubURL(serverURL, discovery.serverSessionBasePath)
    )
  } catch { return false }
  const routes = discovery?.routes?.length
    ? discovery.routes
    : discovery?.transport
      ? [{ transport: discovery.transport, hubUrl: discovery.hubUrl }]
      : []
  return Boolean(
    discovery
    && discovery.available === true
    && (discovery.transport === 'secure_peer' ? discovery.designatedHost === false : discovery.designatedHost === true)
    && discovery.version === 1
    && (discovery.transport === 'secure_peer' ? isSecurePeerBasePath(discovery.basePath) : discovery.basePath === '/api/team-hub')
    && (
      boundServerSession
      || routes.some(route => route.transport === 'loopback') && boundLoopback
      || routes.some(route => route.transport === 'tailscale_serve' && route.hubUrl === hubUrl) && !boundLoopback && !boundDirectIP
      || routes.some(route => (
        route.transport === 'secure_peer'
        && route.hubUrl == null
        && route.basePath === discovery.basePath
        && route.connectionId === connectionId
        && route.hostServerIdentity === hostServerIdentity
        && route.hubIdentity === hubIdentity
      )) && boundSecurePeer
    )
    && typeof hubIdentity === 'string'
    && hubIdentity.length > 0
    && discovery.hubIdentity === hubIdentity
    && (discovery.transport !== 'secure_peer' || (
      discovery.connectionId === connectionId
      && discovery.hostServerIdentity === hostServerIdentity
    ))
    && typeof serverIdentity === 'string'
    && serverIdentity.length > 0
    && (discovery.transport === 'secure_peer'
      ? typeof discovery.hostServerIdentity === 'string' && discovery.hostServerIdentity.length > 0
      : discovery.hostServerIdentity === serverIdentity)
  )
}

function sameAdvertisedDiscovery(left: TeamHubDiscovery | null, right: TeamHubDiscovery): boolean {
  const leftRoutes = left?.routes?.length ? left.routes : left?.transport ? [{ transport: left.transport, hubUrl: left.hubUrl }] : []
  const rightRoutes = right.routes?.length ? right.routes : right.transport ? [{ transport: right.transport, hubUrl: right.hubUrl }] : []
  return Boolean(
    left
    && left.available === right.available
    && left.designatedHost === right.designatedHost
    && left.version === right.version
    && left.basePath === right.basePath
    && left.serverSessionBasePath === right.serverSessionBasePath
    && JSON.stringify(leftRoutes) === JSON.stringify(rightRoutes)
    && left.hubIdentity === right.hubIdentity
    && left.hostServerIdentity === right.hostServerIdentity
    && left.connectionId === right.connectionId
  )
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`)
  const clean = value.trim()
  if (!clean) throw new Error(`${label} is required.`)
  if (clean.length > maxLength || /[\u0000\u007f]/.test(clean)) throw new Error(`${label} is invalid.`)
  return clean
}

function secureBindingMatches(
  binding: TeamHubPublicSettings | null,
  expected: {
    connectionId: string
    expectedHostServerIdentity: string
    expectedHubIdentity: string
  }
): boolean {
  return Boolean(
    binding
    && binding.connectionId === expected.connectionId
    && binding.hostServerIdentity === expected.expectedHostServerIdentity
    && binding.hubIdentity === expected.expectedHubIdentity
  )
}

function isExactSecurePeerConnectionChangedError(error: unknown): error is ServerError {
  if (!(error instanceof ServerError) || error.status !== 409) return false
  if (!error.detail || typeof error.detail !== 'object' || Array.isArray(error.detail)) return false
  const detail = error.detail as { code?: unknown; message?: unknown }
  return detail.code === 'connection_changed'
    && detail.message === 'Secure peer connection identity changed'
}

function securePeerStatusReferencesConnection(status: SecurePeerControlStatus, connectionId: string): boolean {
  return status.activeConnectionId === connectionId
    || status.pairings.some(pairing => pairing.connectionId === connectionId)
    || status.remoteRoutes.some(route => route.connectionId === connectionId)
    || status.publishedRoutes.some(route => route.connectionId === connectionId)
}

function profileScopeFromTeamHubScope(scope: TeamHubScope): SecurePeerProfileScope {
  return {
    profileId: scope.profileId,
    profileGeneration: scope.profileGeneration,
    serverIdentity: scope.serverIdentity
  }
}

function requireIdentifier(value: unknown, label: string): string {
  const clean = requireString(value, `${label} identifier`, 240)
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error(`${label} identifier is invalid.`)
  return clean
}

function cleanOptionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const cursor = requireString(value, 'Continuation cursor', 2_048)
  if (/\s|[\u0000-\u001f\u007f]/.test(cursor)) throw new Error('Continuation cursor is invalid.')
  return cursor
}

function cleanMemberPatch(value: unknown): TeamHubUpdateMemberInput['patch'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose one member change.')
  const item = value as Record<string, unknown>
  const keys = Object.keys(item)
  if (keys.length !== 1) throw new Error('Choose exactly one member change.')
  if (keys[0] === 'role' && ['admin', 'member', 'guest'].includes(String(item.role))) {
    return { role: item.role as 'admin' | 'member' | 'guest' }
  }
  if (keys[0] === 'status' && ['active', 'suspended', 'revoked'].includes(String(item.status))) {
    return { status: item.status as 'active' | 'suspended' | 'revoked' }
  }
  throw new Error('Choose a valid member role or status.')
}

function requireSecret(value: unknown, label: string): string {
  const clean = requireString(value, label, 16_384)
  if (/[\r\n]/.test(clean)) throw new Error(`${label} is invalid.`)
  return clean
}

function requireBootstrapRequestId(value: unknown): string {
  const requestId = requireString(value, 'Bootstrap request identifier', 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Bootstrap request identifier is invalid.')
  }
  return requestId
}

function requireRemoteBootstrapProof(value: unknown): string {
  const proof = requireSecret(value, 'Bootstrap proof')
  if (!/^bootstrap_remote\.[A-Za-z0-9_-]{43}$/.test(proof)) {
    throw new Error('The remote Teamspace setup proof is invalid.')
  }
  return proof
}

function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requireEmail(value: unknown): string {
  const email = requireString(value, 'Email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.')
  return email
}

function canonicalEd25519PublicKeyFingerprint(value: string): string {
  const parts = value.trim().split(/\s+/)
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
    throw new Error('Ed25519 public key must use the OpenSSH public-key format.')
  }
  let wire: Buffer
  try {
    wire = Buffer.from(parts[1], 'base64')
  } catch {
    throw new Error('Ed25519 public key encoding is invalid.')
  }
  if (!wire.length || wire.toString('base64') !== parts[1]) {
    throw new Error('Ed25519 public key encoding is invalid.')
  }
  const readField = (offset: number): { field: Buffer; offset: number } => {
    if (wire.length - offset < 4) throw new Error('Ed25519 public key encoding is invalid.')
    const length = wire.readUInt32BE(offset)
    const start = offset + 4
    const end = start + length
    if (end > wire.length) throw new Error('Ed25519 public key encoding is invalid.')
    return { field: wire.subarray(start, end), offset: end }
  }
  const algorithm = readField(0)
  const publicKey = readField(algorithm.offset)
  if (
    algorithm.field.toString('ascii') !== 'ssh-ed25519'
    || publicKey.field.length !== 32
    || publicKey.offset !== wire.length
  ) throw new Error('Ed25519 public key encoding is invalid.')
  return createHash('sha256').update(wire).digest('hex')
}

function requireSlug(value: unknown): string {
  const slug = requireString(value, 'Channel slug', 80).toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Channel slug may contain lowercase letters, numbers, and single hyphens.')
  return slug
}

function requireIdempotencyKey(value: unknown): string {
  const key = requireString(value, 'Idempotency key', 240)
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error('Idempotency key is invalid.')
  return key
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid.`)
  return value
}

function validateTeamNetworkProjectionPage(
  result: TeamNetworkProjectionPage,
  teamId: string,
  hubIdentity: string | null,
  serverIdentity: string,
  afterServerId: string | null,
  limit: number,
  maxAgentsPerServer: number
): void {
  if (result.network.id !== teamId || !hubIdentity || result.network.hub_id !== hubIdentity) {
    throw new Error('Team Hub returned a mismatched Team Network identity.')
  }
  if (result.servers.length > limit) throw new Error('Team Hub returned too many logical servers in one Team Network page.')
  const serverIds = new Set<string>()
  const serverIdentities = new Set<string>()
  const ownedServers: typeof result.servers = []
  let previousServerId = afterServerId
  for (const server of result.servers) {
    if (
      server.recipient_display_name !== undefined
      && (typeof server.recipient_display_name !== 'string'
        || !server.recipient_display_name.trim()
        || server.recipient_display_name.length > 200)
    ) throw new Error('Team Hub returned an invalid logical server recipient name.')
    if (
      (previousServerId !== null && server.id <= previousServerId)
      || serverIds.has(server.id)
      || serverIdentities.has(server.server_identity)
    ) {
      throw new Error('Team Hub returned duplicate logical server identities.')
    }
    previousServerId = server.id
    serverIds.add(server.id)
    serverIdentities.add(server.server_identity)
    if (server.owned_by_caller) {
      if (server.status !== 'active') throw new Error('Team Hub returned unavailable logical server ownership.')
      ownedServers.push(server)
    }
  }
  if (ownedServers.length > 1 || ownedServers.some(server => server.server_identity !== serverIdentity)) {
    throw new Error('Team Hub returned mismatched logical server ownership.')
  }
  const lastServerId = result.servers.at(-1)?.id ?? null
  if (
    (lastServerId === null && (result.next_after_server_id !== null || result.has_more))
    || (lastServerId !== null && result.next_after_server_id !== lastServerId)
    || (result.has_more && lastServerId === afterServerId)
  ) throw new Error('Team Hub returned an invalid Team Network continuation.')
  const agentIds = new Set<string>()
  const externalIds = new Set<string>()
  const agentsPerServer = new Map<string, number>()
  for (const agent of result.agents) {
    const externalKey = `${agent.server_id}\u0000${agent.external_agent_id}`
    if (!serverIds.has(agent.server_id) || agentIds.has(agent.id) || externalIds.has(externalKey)) {
      throw new Error('Team Hub returned mismatched agent identities.')
    }
    agentIds.add(agent.id)
    externalIds.add(externalKey)
    const count = (agentsPerServer.get(agent.server_id) ?? 0) + 1
    if (count > maxAgentsPerServer) throw new Error('Team Hub returned too many agents for one logical server.')
    agentsPerServer.set(agent.server_id, count)
  }
}

function validateSequencePage(
  items: Array<{ id: string; sequence: number }>,
  afterSequence: number,
  nextAfterSequence: number,
  label: string
): void {
  let previous = afterSequence
  const identities = new Set<string>()
  for (const item of items) {
    if (item.sequence <= previous || identities.has(item.id)) {
      throw new Error(`Team Hub returned an invalid ${label} page.`)
    }
    identities.add(item.id)
    previous = item.sequence
  }
  if (nextAfterSequence !== previous) throw new Error(`Team Hub returned an invalid ${label} continuation.`)
}

function validateTeamMessagePage(
  items: Array<{ id: string; sequence: number }>,
  afterSequence: number,
  nextAfterSequence: number | null,
  hasMore: boolean
): void {
  let previous = afterSequence
  const identities = new Set<string>()
  for (const item of items) {
    if (item.sequence <= previous || identities.has(item.id)) {
      throw new Error('Team Hub returned an invalid Team Messages page.')
    }
    identities.add(item.id)
    previous = item.sequence
  }
  if (
    (hasMore && nextAfterSequence === null)
    || (nextAfterSequence !== null && nextAfterSequence !== previous)
  ) throw new Error('Team Hub returned an invalid Team Messages continuation.')
}

function validateUniqueMailboxEntries(entries: TeamNetworkMailboxEntry[]): void {
  const deliveryIds = new Set<string>()
  for (const entry of entries) {
    if (deliveryIds.has(entry.delivery.id)) throw new Error('Team Hub returned duplicate mailbox deliveries.')
    deliveryIds.add(entry.delivery.id)
  }
}

function sameAddress(address: TeamNetworkPublicAddress, expected: TeamNetworkMailboxAddress): boolean {
  return address.kind === expected.kind && address.id === expected.id
}

type ExpectedTeamNetworkSender =
  | { kind: 'human'; id: string }
  | { kind: 'server'; id: string; serverIdentity: string }
  | { kind: 'agent'; id: string; serverId: string }

function sameExpectedSender(address: TeamNetworkPublicAddress, expected: ExpectedTeamNetworkSender): boolean {
  if (address.kind !== expected.kind || address.id !== expected.id) return false
  if (address.kind === 'server' && expected.kind === 'server') {
    return 'server_identity' in address && address.server_identity === expected.serverIdentity
  }
  if (address.kind === 'agent' && expected.kind === 'agent') {
    return address.server_id === expected.serverId
  }
  return address.kind === 'human' && expected.kind === 'human'
}

function sameExpectedBulletinAuthor(
  author: { kind: 'human' | 'server'; id: string },
  expected: ExpectedTeamNetworkSender
): boolean {
  return expected.kind !== 'agent' && author.kind === expected.kind && author.id === expected.id
}

function validateCreatedMailboxEntry(
  result: TeamNetworkMailboxEntry,
  kind: 'message' | 'request',
  recipient: { kind: 'server' | 'agent'; id: string },
  expectedSender: ExpectedTeamNetworkSender,
  body: string,
  bodyFormat: 'plain' | 'markdown'
): void {
  if (
    result.item.kind !== kind
    || !sameAddress(result.item.to, recipient)
    || result.item.body !== body
    || result.item.body_format !== bodyFormat
    || !sameExpectedSender(result.item.from, expectedSender)
    || (kind === 'message' && (result.item.request_id !== null || result.item.expires_at !== null))
    || (kind === 'request' && (result.item.request_id !== result.item.id || result.item.expires_at === null))
  ) throw new Error(`Team Hub returned a mismatched ${kind === 'message' ? 'mailbox item' : 'passive request'}.`)
}

function validatePassiveRequestDetails(
  result: {
    item: TeamNetworkMailboxEntry['item']
    delivery: TeamNetworkMailboxEntry['delivery']
    request: { id: string; status: 'open' | 'replied' | 'expired'; expires_at: string; reply_item_id: string | null }
    reply: TeamNetworkMailboxEntry | null
  },
  requestId: string
): void {
  if (
    result.item.id !== requestId
    || result.item.kind !== 'request'
    || result.item.request_id !== requestId
    || result.request.id !== requestId
    || result.request.expires_at !== result.item.expires_at
    || (result.request.status === 'replied') !== (result.reply !== null)
    || (result.reply === null) !== (result.request.reply_item_id === null)
    || (result.reply !== null && (
      result.reply.item.id !== result.request.reply_item_id
      || result.reply.item.kind !== 'reply'
      || result.reply.item.request_id !== requestId
      || result.reply.item.expires_at !== null
      || !samePublicAddressIdentity(result.reply.item.from, result.item.to)
      || !samePublicAddressIdentity(result.reply.item.to, result.item.from)
    ))
  ) throw new Error('Team Hub returned mismatched passive request details.')
}

function samePublicAddressIdentity(left: TeamNetworkPublicAddress, right: TeamNetworkPublicAddress): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false
  if (left.kind === 'server' && right.kind === 'server') return left.server_identity === right.server_identity
  if (left.kind === 'agent' && right.kind === 'agent') {
    return left.server_id === right.server_id && left.backend === right.backend
  }
  return left.kind === 'human' && right.kind === 'human'
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function inspectAttachmentFile(
  source: Pick<AdmittedUploadFile, 'fd' | 'byteSize'>,
  maximumBytes?: number,
  signal?: AbortSignal
): Promise<{ byteSize: number; sha256: string }> {
  throwIfAttachmentOperationAborted(signal)
  const before = fstatSync(source.fd)
  if (!before.isFile() || before.size < 1 || before.size !== source.byteSize) {
    throw new Error('Team attachment must be a non-empty regular file.')
  }
  if (maximumBytes !== undefined) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error('Team attachment size limit is invalid.')
    }
    if (before.size > maximumBytes) throw new Error('This attachment is too large for the connected Hub.')
  }
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (offset < before.size) {
    const length = Math.min(buffer.length, before.size - offset)
    const bytesRead = await readDescriptor(source.fd, buffer, length, offset, signal)
    if (bytesRead !== length) throw new Error('Team attachment changed while it was being inspected.')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  const after = fstatSync(source.fd)
  throwIfAttachmentOperationAborted(signal)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error('Team attachment changed while it was being inspected.')
  }
  return { byteSize: before.size, sha256: hash.digest('hex') }
}

async function uploadVerifiedAttachment(
  source: Pick<AdmittedUploadFile, 'fd' | 'byteSize'>,
  attachment: { byte_size: number; sha256: string },
  chunkBytes: number,
  maximumBytes: number,
  upload: (bytes: Uint8Array, start: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024) {
    throw new Error('Team attachment chunk size is invalid.')
  }
  const inspected = await inspectAttachmentFile(source, Math.min(maximumBytes, attachment.byte_size), signal)
  if (inspected.byteSize !== attachment.byte_size || inspected.sha256 !== attachment.sha256) {
    throw new Error('The selected file no longer matches the declared Team attachment.')
  }
  const opened = fstatSync(source.fd)
  if (!opened.isFile() || opened.size !== source.byteSize || opened.size !== attachment.byte_size) {
    throw new Error('Team attachment changed before upload.')
  }
  const hash = createHash('sha256')
  let offset = 0
  while (offset < opened.size) {
    const length = Math.min(chunkBytes, opened.size - offset)
    const bytes = new Uint8Array(length)
    const bytesRead = await readDescriptor(source.fd, bytes, length, offset, signal)
    if (bytesRead !== length) throw new Error('Team attachment changed during upload.')
    hash.update(bytes)
    await upload(bytes, offset)
    throwIfAttachmentOperationAborted(signal)
    offset += bytesRead
  }
  const after = fstatSync(source.fd)
  if (
    after.size !== opened.size
    || after.mtimeMs !== opened.mtimeMs
    || after.ctimeMs !== opened.ctimeMs
    || hash.digest('hex') !== attachment.sha256
  ) throw new Error('Team attachment changed during upload.')
}

function readDescriptor(
  fd: number,
  buffer: Uint8Array,
  length: number,
  position: number,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The attachment operation was cancelled.'))
      return
    }
    const onAbort = () => reject(signal?.reason ?? new Error('The attachment operation was cancelled.'))
    signal?.addEventListener('abort', onAbort, { once: true })
    readFileDescriptor(fd, buffer, 0, length, position, (error, bytesRead) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(signal.reason ?? new Error('The attachment operation was cancelled.'))
      else if (error) reject(error)
      else resolve(bytesRead)
    })
  })
}

async function readExactTeamAttachmentPreview(response: Response, expectedLength: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The local Team attachment preview had no response body.')
  const bytes = new Uint8Array(expectedLength)
  let offset = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.byteLength > expectedLength - offset) {
        throw new Error('The local Team attachment preview exceeded its declared byte range.')
      }
      bytes.set(chunk.value, offset)
      offset += chunk.value.byteLength
    }
    if (offset !== expectedLength) {
      throw new Error('The local Team attachment preview was truncated in transit.')
    }
    return bytes
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function throwIfAttachmentOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('The attachment operation was cancelled.')
}
