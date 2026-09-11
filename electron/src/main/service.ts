import { app, BrowserWindow, dialog, nativeImage, Notification, shell } from 'electron'
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join } from 'node:path'
import { isImportedProviderControlMetadata } from '../shared/provider-origin'
import {
  localSessionImportBatchLimit,
  localSessionImportListLimit,
  parseBulkImportSessionItems,
  requireLocalSessionImportCapability
} from '../shared/local-session-import'
import type {
  AddServerProfileInput,
  AgentFile,
  AgentCrossChatRoute,
  AgentCrossChatRouteUpdateResult,
  AgentCrossChatRoutesSnapshot,
  AgentTextFile,
  AppEventMap,
  BulkImportSessionItem,
  BulkImportSessionResult,
  ChatReference,
  TeamReference,
  ChatSearchSnapshot,
  CreateAgentCrossChatRouteInput,
  CrossChatExchange,
  CrossChatHandoff,
  CrossChatHandoffSummary,
  DeleteAgentCrossChatRouteResult,
  ClaudeMcpControlInput,
  ClaudeMcpSnapshot,
  ClaudePendingInteraction,
  ClaudeRuntimeSnapshot,
  CodexBackgroundTerminalTerminateInput,
  CodexBackgroundTerminalsCleanInput,
  CodexBackgroundTerminalsSnapshot,
  CodexGoalInput,
  CodexGoalSnapshot,
  CodexGoalsConfiguration,
  CodexOperationAccepted,
  CodexPendingInteraction,
  CodexPermissionProfile,
  CodexReviewInput,
  CodexRollbackInput,
  CodexRollbackResult,
  CodexRuntimeSnapshot,
  CodexShellInput,
  CreateJobInput,
  CreateSessionInput,
  DigestInput,
  Event,
  FilesPage,
  ForwardedPort,
  Health,
  TeamHubHostControlCapability,
  Job,
  JobRunNowResult,
  JobRunHistoryPage,
  JsonValue,
  LocalSessionCandidate,
  NativeFileRef,
  PinnedItem,
  ProcessSnapshot,
  ProviderReloadResult,
  ProviderRuntimeChanged,
  ProfileBootstrapPayload,
  ProfileNotificationPayload,
  ProfileNotificationRoute,
  ProfileSessionSearchResult,
  ProviderCommandsSnapshot,
  PublicServerProfile,
  PublicServerSettings,
  QueuedCrossChatDeliveryIdentity,
  QueuedRunNowResponse,
  QueuedTurn,
  ResumeSessionInput,
  RuntimeCatalog,
  SendTurnInput,
  ServerConnectionState,
  ServerForceRestartConfirmation,
  ServerRestartRequest,
  ServerRestartStatus,
  ServerSettings,
  ServerUpdateStatus,
  ServerUpdateTrack,
  Session,
  SessionSnapshot,
  SubagentSnapshot,
  TerminalAction,
  TerminalConnectOptions,
  TerminalWindowsSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineTracePage,
  TimelineSearchResult,
  TestServerConnectionInput,
  TmuxPane,
  TurnStopResult,
  UpdateAgentCrossChatRouteInput,
  UpdateSessionInput,
  UpdateServerProfilePatch,
  UpdateJobInput,
  ViewState,
  WorkspaceEntriesPage,
  WorkspaceCreateResult,
  WorkspaceFile,
  WorkspaceInfo,
  WorkspaceProfileScope,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceSearchPage,
  WorkingDirectoryCompletion
} from '../shared/types'
import { updateQueuedTurns } from '../shared/queue'
import { runtimeCatalogHasSelectableModels } from '../shared/runtime-catalog'
import { incompleteLeadingRunId } from '../shared/semantic-timeline'
import { normalizeServerURL } from '../shared/server-url'
import { isLoopbackHostname, normalizeDirectIPTeamHubURL, normalizeTailscaleServeTeamHubURL } from '../shared/team-hub-url'
import { agentFileBelongsToSession, isolateSessionEvent } from '../shared/session-files'
import { buildWorkspaceMediaURL, isValidMediaIdentifier } from '../shared/media-url'
import {
  CacheNamespaceCollisionError,
  LocalCache,
  TIMELINE_PAGING_SCHEMA_VERSION
} from './persistence'
import {
  AgentServerClient,
  normalizePinnedItemForSync,
  ServerError,
  TeamHubBootstrapTransportError,
  type TeamHubHostRoleResponse,
  type ServerUpdateTarget,
  type SessionPageOptions,
  type TerminalConnection
} from './server-client'
import { PinSyncCoordinator, type PinSyncContext } from './pin-sync'
import { PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL, PortTunnelManager } from './port-tunnel-manager'
import { FileUploadGrantRegistry } from './file-upload-grants'
import { SettingsStore, type ServerProfileRuntimeState } from './settings'
import { appLog } from './logger'
import { SubagentEventProjector } from './subagent-projection'
import { mergeTimelineSearchResults } from './search'
import type { TeamHubConfigureServerRoleInput, TeamHubDiscovery, TeamHubScope, TeamHubServerScope } from '../shared/team-hub'
import type { TeamHubBootstrapProof, TeamHubBootstrapProofInput } from './team-hub-service'
import type {
  SecurePeerActivateInput,
  SecurePeerApproveInput,
  SecurePeerConfigureHostInput,
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
  normalizeSecurePeerJoinTarget,
  normalizeSecurePeerIPv4,
  normalizeSecurePeerPort,
  normalizeSecurePeerScopes,
  securePeerProfileScope
} from '../shared/secure-peer'
import {
  automaticPairingCompletionAvailable,
  parseSecurePeerControlStatus,
  parseSecurePeerHostPeerRevocation,
  parseSecurePeerHostPeers,
  parseSecurePeerPairing
} from './secure-peer-contract'

const INITIAL_SEMANTIC_ITEM_LIMIT = 48
const DELTA_EVENT_LIMIT = 480
const HISTORY_PAGE_SEMANTIC_ITEM_LIMIT = 120
const LEGACY_TIMELINE_EVENT_LIMIT = 480
const LEGACY_BOUNDARY_BACKFILL_EVENT_LIMIT = 1_000
const LEGACY_BOUNDARY_BACKFILL_MAX_PAGES = 4
const HISTORY_AROUND_EVENT_LIMIT = 1_200

function isAgentRouteRevisionConflict(error: unknown): boolean {
  if (!(error instanceof ServerError) || error.status !== 409) return false
  if (error.detail === 'route revision conflict') return true
  if (!error.detail || typeof error.detail !== 'object' || Array.isArray(error.detail)) return false
  return (error.detail as { code?: unknown }).code === 'route_revision_conflict'
}
const TRACE_DETAIL_EVENT_LIMIT = 240
const FILE_PAGE_LIMIT = 60
const MAX_AGENT_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
const AGENT_TEXT_FILE_TIMEOUT_MS = 30_000
const WORKSPACE_PREVIEW_PROBE_TIMEOUT_MS = 30_000
const RUNTIME_CATALOG_CACHE_KEY = 'runtimeCatalog:v1'
const SERVER_VERSION_CACHE_KEY = 'serverVersion:v1'
const SEMANTIC_TIMELINE_CAPABILITY_CACHE_KEY = 'semanticTimelineCapability:v1'
const RUNTIME_CATALOG_RETRY_MS = 30_000
const RUNTIME_CATALOG_REFRESH_MS = 15 * 60_000
const EVENT_CACHE_FLUSH_MS = 50
// Live events carry foreground chat changes. This is only a reconciliation
// sweep, so do not parse and publish every session in a large workspace every
// five seconds or treat a normal typing pause as idle time.
const BACKGROUND_REFRESH_INTERVAL_MS = 30_000
const FOREGROUND_INTERACTION_QUIET_MS = 3_000
const INACTIVE_PROFILE_HEALTH_INTERVAL_MS = 30_000
const INACTIVE_PROFILE_HEALTH_TIMEOUT_MS = 5_000
const INACTIVE_PROFILE_HEALTH_MAX_CONCURRENCY = 2
const INACTIVE_PROFILE_HEALTH_FRESH_MS = 75_000
const MAX_REMEMBERED_EMERGENCY_ALERT_IDS = 4_096
const MAX_PENDING_NOTIFICATION_ROUTES = 32
const REMOTE_AGENT_ROUTE_UNAVAILABLE = 'Remote agent routes cannot be used from @Chat. Use @@ Team Network Inbox for cross-server messages.'
const SERVER_RESTART_RECONNECT_TIMEOUT_MS = 45_000
const SERVER_RESTART_POLL_DELAY_MS = 500
const SERVER_RESTART_HEALTH_TIMEOUT_MS = 3_000
const MAX_TIMELINE_SUBSCRIPTIONS = 2
const TRACE_DETAIL_EVENT_TYPES = new Set([
  'reasoning_summary',
  'tool_started',
  'tool_finished',
  'code_diff'
])

function assertLocalAgentChatReferences(references: readonly ChatReference[] | undefined): void {
  if (references?.some(reference => reference.target_kind === 'secure_peer')) {
    throw new Error(REMOTE_AGENT_ROUTE_UNAVAILABLE)
  }
}

const SEARCH_BACKFILL_BATCH_SIZE = 25
const SEARCH_BACKFILL_BATCH_DELAY_MS = 350
const JOB_REFRESH_EVENT_TYPES = new Set(['job_created', 'job_updated', 'job_deleted', 'turn_finished'])
const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CLIPBOARD_IMAGE_NAME_BYTES = 255
const STALE_CLIPBOARD_DIRECTORY_AGE_MS = 24 * 60 * 60_000
const CLIPBOARD_IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff']
])
const QUEUE_CACHE_EVENT_TYPES = new Set([
  'turn_queued', 'turn_unqueued', 'turn_started', 'turn_queue_run_now', 'turn_queue_updated',
  'turn_queue_paused', 'turn_queue_delivery_fenced'
])

function persistableSubagentSnapshotEvents(snapshot: SubagentSnapshot, sessionId: string): {
  events: Event[]
  dropped: number
} {
  const candidates: unknown[] = Array.isArray(snapshot.subagents) ? snapshot.subagents : []
  if (snapshot.session_id !== sessionId) return { events: [], dropped: candidates.length }
  const events = candidates.filter((candidate): candidate is Event => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const event = candidate as Partial<Event>
    return typeof event.id === 'string'
      && event.id.trim().length > 0
      && typeof event.seq === 'number'
      && Number.isSafeInteger(event.seq)
      && event.seq > 0
      && event.session_id === sessionId
      && event.type === 'subagent_state'
  })
  return { events, dropped: candidates.length - events.length }
}

interface ConnectionScope {
  readonly profileId: string
  readonly generation: number
  readonly serverUrl: string
  namespace: string
  readonly client: AgentServerClient
}

interface InactiveEmergencyStream {
  readonly client: AgentServerClient
  readonly stop: () => void
  readonly revision: number
  readonly serverIdentity: string
  readonly namespace: string
  readonly seenAlertIds: Set<string>
}

interface PendingEventBatch {
  readonly scope: ConnectionScope
  readonly sessionId: string
  readonly events: Event[]
}

interface TimelineSubscription {
  readonly lease: number
  stop: (() => void) | null
  connected: boolean
  initializing: boolean
}

interface StagedClipboardFile {
  readonly path: string
  activeUses: number
  cleanupRequested: boolean
}

interface SemanticTimelineCapability {
  serverVersion: string | null
  supported: boolean
}

export interface AppServiceOptions {
  settings?: SettingsStore
  cache?: LocalCache
  clientFactory?: (serverUrl: string, accessToken: string) => AgentServerClient
  /** Test seam; production waits 45 seconds for a new server boot. */
  serverRestartReconnectTimeoutMs?: number
  /** Test seam; production probes twice per second while reconnecting. */
  serverRestartPollDelayMs?: number
  /** Test seam; each reconnect health probe remains independently bounded. */
  serverRestartHealthTimeoutMs?: number
  /** Test seam for loopback-only remote port forwarding. */
  portTunnelManager?: PortTunnelManager
  /** Remove profile-scoped Teamspace state before its parent server profile is deleted. */
  removeTeamHubProfile?: (profileId: string) => Promise<void | { rollback(): void; cleanupWarning?: string }>
  /** Test seam for main-owned native file capabilities. */
  fileUploadGrants?: FileUploadGrantRegistry
  /** Test seam for private clipboard staging/scavenging. */
  clipboardTempRoot?: string
}

export class AppService {
  readonly settings: SettingsStore
  readonly cache: LocalCache
  client: AgentServerClient

  private serverId: string
  private activeProfileId: string
  private profileGeneration = 1
  private profileSelectionIntent = 0
  private shutdownEpoch = 0
  private validatedGeneration: number | null = null
  private scope: ConnectionScope
  private readonly clientFactory: (serverUrl: string, accessToken: string) => AgentServerClient
  private readonly serverRestartReconnectTimeoutMs: number
  private readonly serverRestartPollDelayMs: number
  private readonly serverRestartHealthTimeoutMs: number
  private profileRuntime = new Map<string, ServerProfileRuntimeState>()
  private profileHealthProbeInFlight = new Map<string, Promise<void>>()
  private profileHealthProbeClients = new Map<string, AgentServerClient>()
  private profileHealthAccessTokens = new Map<string, { revision: number; token: string }>()
  private profileHealthProbeRevision = new Map<string, number>()
  private inactiveEmergencyStreams = new Map<string, InactiveEmergencyStream>()
  private profileHealthSweepInFlight: Promise<void> | null = null
  private profileHealthSweepRescanRequested = false
  private profileHealthSweepEpoch = 0
  private profileHealthPollTimer: NodeJS.Timeout | null = null
  private profileRemovals = new Map<string, Promise<boolean>>()
  private profileAuthorityOperations = new Map<string, Promise<void>>()
  private pendingProfileAuthorityNamespaces = new Map<string, string[]>()
  private windows = new Set<BrowserWindow>()
  private focusedSessionId: string | null = null
  private seenEmergencyAlertIds = new Set<string>()
  private notifiedEmergencyAlertIds = new Set<string>()
  private timelineSubscriptions = new Map<string, TimelineSubscription>()
  private emergencyStreamStop: (() => void) | null = null
  private emergencyStreamGeneration: number | null = null
  private emergencyStreamServerIdentity: string | null = null
  private rendererReadyWindows = new WeakSet<BrowserWindow>()
  private rendererGrantEpochs = new Map<number, number>()
  private rendererFileOperations = new Map<number, Set<AbortController>>()
  private stagedClipboardFiles = new Map<string, StagedClipboardFile>()
  private clipboardStagingDirectory: string | null = null
  private clipboardStagingScavenged = false
  private pendingNotificationRoutes: ProfileNotificationRoute[] = []
  private timelineLeaseSequence = 0
  private timelineReconcileInFlight = new Set<string>()
  private subagentSnapshotInFlight = new Map<string, Promise<SubagentSnapshot | null>>()
  private healthFailureCount = 0
  private pendingEventCache = new Map<string, PendingEventBatch>()
  private eventCacheTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private deferredBackgroundRefreshTimer: NodeJS.Timeout | null = null
  private deferredBackgroundRefresh: ConnectionScope | null = null
  private lastForegroundInteractionAt = Number.NEGATIVE_INFINITY
  private backgroundApplyQuietWaiters = new Map<number, Set<(apply: boolean) => void>>()
  private foregroundSensitiveRefreshes = new Set<number>()
  private foregroundApplyBypassGenerations = new Set<number>()
  private jobsPollTimer: NodeJS.Timeout | null = null
  private searchBackfillTimer: NodeJS.Timeout | null = null
  private health: Health | null = null
  private sessions: Session[] = []
  private jobs: Job[] = []
  private runtimeCatalog: RuntimeCatalog | null = null
  private runtimeRefreshInFlight = new Map<number, { task: Promise<void>; forceProbe: boolean }>()
  private runtimeRefreshNextAt = 0
  /** Last server process we fetched a runtime catalog from. A different
   * instance means the server was restarted or upgraded, so its CLI versions
   * and model list can have changed and the cached catalog is stale. */
  private runtimeCatalogInstanceId: string | null = null
  /** Set when the server instance changed, so the next refresh re-probes the
   * CLIs instead of trusting the server's own cached diagnostics. */
  private runtimeInstanceProbePending = false
  private refreshInFlight = new Map<number, Promise<void>>()
  private readStateMutations = new Map<string, Promise<void>>()
  private lastSyncState = ''
  private lastProfilesPayload = ''
  private lastConnectionPayload = ''
  private filesRefreshInFlight = new Set<string>()
  private filesRefreshedAt = new Map<string, number>()
  private fileDownloads = new Map<string, Promise<string>>()
  private codexThreadLoads = new Map<string, Promise<CodexRuntimeSnapshot>>()
  private timelineIndexes = new Map<string, TimelineIndex>()
  private terminalConnections = new Map<string, TerminalConnection>()
  private terminalLeases = new Map<string, number>()
  private readonly portTunnels: PortTunnelManager
  private readonly removeTeamHubProfile: (profileId: string) => Promise<void | { rollback(): void; cleanupWarning?: string }>
  private readonly fileUploadGrants: FileUploadGrantRegistry
  private readonly clipboardTempRoot: string
  private subagentProjector = new SubagentEventProjector()
  private readonly pinSync: PinSyncCoordinator
  private running = false
  private clientAvailable = true
  private profileTransitionWarning: string | null = null
  private profileResetPending: {
    profileId: string
    generation: number
    retiredNamespaces: string[]
  } | null = null

  constructor(options: AppServiceOptions = {}) {
    appLog('startup', 'loading settings')
    this.settings = options.settings ?? new SettingsStore()
    appLog('startup', 'settings loaded')
    appLog('startup', 'opening local cache')
    this.cache = options.cache ?? new LocalCache()
    this.pinSync = new PinSyncCoordinator(this.cache)
    this.portTunnels = options.portTunnelManager ?? new PortTunnelManager()
    this.removeTeamHubProfile = options.removeTeamHubProfile ?? (async () => undefined)
    this.fileUploadGrants = options.fileUploadGrants ?? new FileUploadGrantRegistry()
    this.clipboardTempRoot = options.clipboardTempRoot ?? app.getPath('temp')
    this.portTunnels.setChangeListener?.(ports => this.emitForwardedPorts(ports))
    appLog('startup', 'local cache ready')
    this.clientFactory = options.clientFactory ?? ((serverUrl, accessToken) => new AgentServerClient(serverUrl, accessToken))
    this.serverRestartReconnectTimeoutMs = options.serverRestartReconnectTimeoutMs ?? SERVER_RESTART_RECONNECT_TIMEOUT_MS
    this.serverRestartPollDelayMs = options.serverRestartPollDelayMs ?? SERVER_RESTART_POLL_DELAY_MS
    this.serverRestartHealthTimeoutMs = options.serverRestartHealthTimeoutMs ?? SERVER_RESTART_HEALTH_TIMEOUT_MS
    for (const profile of this.settings.listProfiles()) {
      const retiredNamespaces = this.settings.retiredServerNamespaces(profile.id)
      if (retiredNamespaces.length) this.pendingProfileAuthorityNamespaces.set(profile.id, retiredNamespaces)
      if (!this.pendingProfileAuthorityNamespaces.has(profile.id)) this.reconcileStoredProfileCache(profile)
    }
    const active = this.settings.getActiveProfile()
    this.activeProfileId = active.id
    this.serverId = profileNamespace(active)
    const activeServerUrl = this.settings.serverUrl(active.id)
    this.client = this.clientFactory(activeServerUrl, this.settings.accessToken(active.id))
    this.scope = {
      profileId: active.id,
      generation: this.profileGeneration,
      serverUrl: activeServerUrl,
      namespace: this.serverId,
      client: this.client
    }
    const activeRetiredNamespaces = this.pendingProfileAuthorityNamespaces.get(active.id)
    if (activeRetiredNamespaces?.length) {
      this.profileResetPending = {
        profileId: active.id,
        generation: this.profileGeneration,
        retiredNamespaces: activeRetiredNamespaces
      }
      this.sessions = []
      this.jobs = []
      this.runtimeCatalog = null
      this.health = null
      this.focusedSessionId = null
    } else {
      this.loadScopeCache(this.scope)
    }
    this.setProfileRuntime(active.id, { connectionState: 'cached', lastConnectionCheckedAt: null })
    appLog('startup', 'server client ready', { profileId: active.id, generation: this.profileGeneration, serverId: this.serverId })
  }

  addWindow(window: BrowserWindow): void {
    this.windows.add(window)
    const rendererId = window.webContents.id
    if (Number.isSafeInteger(rendererId) && rendererId > 0) {
      this.rendererGrantEpochs.set(rendererId, (this.rendererGrantEpochs.get(rendererId) ?? 0) + 1)
    }
    if (typeof window.webContents?.on === 'function') {
      window.webContents.on('before-input-event', (_event, input) => {
        if (input.type === 'rawKeyDown' || input.type === 'keyDown' || input.type === 'char') {
          this.noteForegroundInteraction()
        }
      })
      window.webContents.on('before-mouse-event', (_event, input) => {
        if (input.type === 'mouseDown' || input.type === 'mouseWheel') {
          this.noteForegroundInteraction()
        }
      })
      window.webContents.on('did-start-loading', () => {
        this.rendererReadyWindows.delete(window)
        this.invalidateRendererFileGrants(rendererId, false)
      })
      window.webContents.on('destroyed', () => this.invalidateRendererFileGrants(rendererId, true))
    }
    window.on('closed', () => {
      this.windows.delete(window)
      this.rendererReadyWindows.delete(window)
      this.invalidateRendererFileGrants(rendererId, true)
    })
  }

  rendererReadyForNotificationRoutes(window: BrowserWindow | null): boolean {
    if (
      !window
      || window.isDestroyed()
      || window.webContents.isDestroyed()
      || window.webContents.isLoadingMainFrame()
    ) return false
    this.rendererReadyWindows.add(window)
    const pending = this.pendingNotificationRoutes
    this.pendingNotificationRoutes = []
    for (const route of pending) {
      if (this.notificationRouteIsCurrent(route)) {
        window.webContents.send('native:notification', route)
      }
    }
    return true
  }

  focusMainWindow(): BrowserWindow | null {
    const window = [...this.windows].find(candidate => !candidate.isDestroyed()) ?? null
    if (!window) return null
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return window
  }

  start(): void {
    if (this.running) return
    if (!this.clientAvailable) this.activateProfile(this.activeProfileId, false, true)
    this.running = true
    void this.runBackgroundRefresh(true, this.captureScope())
    void this.refreshInactiveProfileHealth()
    this.pollTimer = setInterval(
      () => this.scheduleBackgroundRefresh(this.captureScope()),
      BACKGROUND_REFRESH_INTERVAL_MS
    )
    this.profileHealthPollTimer = setInterval(() => void this.refreshInactiveProfileHealth(), INACTIVE_PROFILE_HEALTH_INTERVAL_MS)
    this.jobsPollTimer = setInterval(() => void this.refreshJobs(this.captureScope()), 30_000)
    this.scheduleSearchBackfill(1_000)
  }

  stop(): void {
    this.profileSelectionIntent += 1
    this.shutdownEpoch += 1
    this.running = false
    this.cancelBackgroundApplyQuietWaiters()
    const stoppedScope = this.clientAvailable ? this.captureScope() : null
    if (stoppedScope) {
      this.profileGeneration += 1
      this.validatedGeneration = null
      this.scope = {
        profileId: stoppedScope.profileId,
        generation: this.profileGeneration,
        serverUrl: stoppedScope.serverUrl,
        namespace: stoppedScope.namespace,
        client: stoppedScope.client
      }
      this.clientAvailable = false
    }
    let cleanupError: unknown
    const cleanup = (operation: () => void): void => {
      cleanupError = attemptCleanup(cleanupError, operation)
    }
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.deferredBackgroundRefreshTimer) clearTimeout(this.deferredBackgroundRefreshTimer)
    if (this.profileHealthPollTimer) clearInterval(this.profileHealthPollTimer)
    if (this.jobsPollTimer) clearInterval(this.jobsPollTimer)
    if (this.searchBackfillTimer) clearTimeout(this.searchBackfillTimer)
    this.pollTimer = null
    this.deferredBackgroundRefreshTimer = null
    this.deferredBackgroundRefresh = null
    this.lastForegroundInteractionAt = Number.NEGATIVE_INFINITY
    this.profileHealthPollTimer = null
    this.jobsPollTimer = null
    this.searchBackfillTimer = null
    cleanup(() => this.closeAllTimelineSubscriptions())
    cleanup(() => this.stopEmergencyStream())
    this.pendingNotificationRoutes = []
    this.rendererReadyWindows = new WeakSet<BrowserWindow>()
    cleanup(() => this.abortAllRendererFileOperations())
    this.rendererGrantEpochs.clear()
    cleanup(() => this.disconnectAllTerminals())
    this.terminalLeases.clear()
    cleanup(() => this.portTunnels.disposeAll())
    cleanup(() => this.fileUploadGrants.clear())
    cleanup(() => this.removeClipboardStagingDirectory())
    cleanup(() => this.flushEventCache())
    this.refreshInFlight.clear()
    this.runtimeRefreshInFlight.clear()
    this.subagentSnapshotInFlight.clear()
    cleanup(() => this.invalidateAllProfileHealthProbes())
    cleanup(() => this.stopAllInactiveEmergencyStreams())
    this.profileHealthAccessTokens.clear()
    if (stoppedScope) cleanup(() => stoppedScope.client.dispose())
    if (cleanupError) {
      appLog('shutdown', 'application service stopped with a cleanup error', {
        profileId: stoppedScope?.profileId ?? this.activeProfileId,
        error: errorText(cleanupError)
      })
    }
  }

  async bootstrap(): Promise<ProfileBootstrapPayload> {
    let scope = this.captureScope()
    const pending = this.pendingProfileAuthorityNamespaces.get(scope.profileId)
    if (pending?.length) {
      await this.withProfileAuthorityOperation(scope.profileId, async () => {
        const cleanupError = await this.cleanupRetiredProfileAuthority(scope.profileId, pending)
        this.assertCurrentScope(scope)
        if (cleanupError) {
          this.recordProfileTransitionWarning(
            `Some retired local server data still needs cleanup: ${cleanupError}`
          )
        } else if (this.profileResetIsPending(scope)) {
          this.profileResetPending = null
        }
      })
      scope = this.captureScope()
    }
    appLog('bootstrap', 'cache bootstrap started', { profileId: scope.profileId, generation: scope.generation, serverId: scope.namespace })
    const payload = this.loadCachedBootstrap(scope)
    appLog('bootstrap', 'cache bootstrap finished', { sessions: payload.sessions.length, jobs: payload.jobs.length })
    return payload
  }

  publicSettings(): PublicServerSettings { return this.settings.publicSettings() }

  async applySettings(value: ServerSettings): Promise<Health> {
    const intent = ++this.profileSelectionIntent
    const profileId = this.settings.getActiveProfileId()
    const revision = this.settings.connectionRevision(profileId)
    const token = value.accessToken === '__KEEP__'
      ? await this.settings.accessTokenForConnectionAsync(profileId)
      : value.accessToken
    this.assertProfileSelection(profileId, intent, revision)
    const nextClient = this.clientFactory(normalizeServerURL(value.serverUrl), token)
    // Commit and retire the old scope together; an auth await between them
    // would let old-server health bind its identity to the newly saved URL.
    try { this.settings.update(value) }
    catch (error) { nextClient.dispose(); throw error }
    const scope = this.activateProfile(profileId, false, true, nextClient)
    const health = await scope.client.health()
    if (!this.isCurrentScope(scope)) throw staleProfileError()
    if (health.ok !== true) {
      const error = new Error('Server health check reported unavailable.')
      this.setProfileRuntime(scope.profileId, {
        connectionState: 'offline',
        lastConnectionError: error.message,
        lastConnectionCheckedAt: Date.now()
      })
      this.emitConnection(scope, false, undefined, error.message)
      throw error
    }
    const adopted = this.adoptHealth(scope, health)
    this.setProfileRuntime(adopted.profileId, {
      connectionState: connectionStateForHealth(health),
      lastConnectionError: connectionWarningForHealth(health),
      lastConnectionCheckedAt: Date.now()
    })
    this.emitConnection(adopted, true, health)
    await this.refreshAll(true, true, adopted)
    void this.refreshRuntime(true, false, this.captureScope())
    return health
  }

  listServers(): PublicServerProfile[] {
    void this.refreshInactiveProfileHealth()
    return this.publicProfiles()
  }

  getActiveServer(): PublicServerProfile {
    return this.settings.getActiveProfile(this.runtimeForProfile(this.activeProfileId))
  }

  /** Main-process-only scope used to fence Team Hub discovery and requests. */
  teamHubServerScope(): TeamHubServerScope {
    const scope = this.captureScope()
    const profile = this.settings.getProfileMetadata(scope.profileId)
    if (!profile) throw new Error(`Unknown server profile: ${scope.profileId}`)
    return {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      serverIdentity: profile.serverIdentity?.trim() || null,
      serverUrl: this.settings.serverUrl(scope.profileId),
      serverName: this.health && this.health.server_identity === profile.serverIdentity && typeof this.health.server_name === 'string'
        ? teamHubServerName(this.health.server_name)
        : profile.name
    }
  }

  /**
   * Synchronously project the latest capability from the authenticated health
   * cache. Team Hub uses this before every credential-bearing request so a
   * same-profile Hub replacement cannot receive a token minted by the old Hub.
   */
  currentTeamHubDiscovery(expected: TeamHubServerScope): TeamHubDiscovery | null {
    let scope: ConnectionScope
    try {
      scope = this.requireWorkspaceScope(expected)
    } catch {
      return null
    }
    if (!this.isValidatedScope(scope) || this.settings.serverUrl(scope.profileId) !== expected.serverUrl) return null
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, expected) || !current.serverIdentity) return null
    const health = this.health
    if (!health || health.server_identity !== current.serverIdentity) return null
    try {
      return parseTeamHubDiscovery(health.capabilities?.team_hub_v1, current.serverIdentity)
    } catch {
      return null
    }
  }

  /**
   * Read the authenticated capability already returned by this exact active
   * AgentsServer. The server access token remains encapsulated by its client.
   */
  async discoverTeamHub(expected: TeamHubServerScope): Promise<TeamHubDiscovery> {
    const scope = this.requireWorkspaceScope(expected)
    if (this.settings.serverUrl(scope.profileId) !== expected.serverUrl) throw staleProfileError()
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, expected) || !current.serverIdentity) throw staleProfileError()
    const health = this.health
    if (!health || health.server_identity !== current.serverIdentity) throw staleProfileError()
    return parseTeamHubDiscovery(health.capabilities?.team_hub_v1, current.serverIdentity)
  }

  /** Configure the Team Network role on the exact AgentsServer that opened the confirmation UI. */
  async configureTeamHubServerRole(
    expected: SecurePeerProfileScope,
    input: TeamHubConfigureServerRoleInput
  ): Promise<TeamHubDiscovery> {
    const context = await this.securePeerControlContext(expected)
    if (input?.role !== 'host' && input?.role !== 'member') throw new Error('Select a Team Network server role.')
    const serverName = teamHubServerName(input.serverName)
    const initialCapability = requireTeamHubHostControlCapability(
      this.health?.capabilities?.team_hub_host_control_v1
    )
    const networkName = input.networkName === undefined ? undefined : teamHubServerName(input.networkName)
    if (networkName !== undefined && (input.role !== 'host' || initialCapability.server_bootstrap !== true)) {
      throw new Error('Update this AgentsServer to create a Team Network with its server identity.')
    }
    const roleAvailable = input.role === 'host'
      ? initialCapability.enabled || initialCapability.can_enable
      : !initialCapability.enabled || initialCapability.can_disable
    if (!initialCapability.available || !roleAvailable) {
      throw new Error(initialCapability.message || 'This AgentsServer cannot change its Team Network role.')
    }

    const requestId = randomUUID()
    const request = {
      request_id: requestId,
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      confirmed: true as const,
      server_name: serverName,
      ...(networkName === undefined ? {} : { network_name: networkName })
    }
    const receipt = input.role === 'host'
      ? await context.scope.client.enableTeamHubHost(request)
      : await context.scope.client.disableTeamHubHost(request)
    this.requireSecurePeerControlContext(context)
    requireExactTeamHubServerRoleReceipt(receipt, {
      requestId,
      serverIdentity: context.expected.serverIdentity,
      serverInstanceId: context.serverInstanceId,
      serverName,
      role: input.role
    })

    const health = await context.scope.client.health()
    this.assertCurrentScope(context.scope)
    const current = this.teamHubServerScope()
    if (
      current.profileId !== context.expected.profileId
      || current.profileGeneration !== context.expected.profileGeneration
      || current.serverIdentity !== context.expected.serverIdentity
      || health.ok !== true
      || health.server_identity !== context.expected.serverIdentity
      || health.server_instance_id !== context.serverInstanceId
    ) throw staleProfileError()
    const enabledCapability = requireTeamHubHostControlCapability(
      health.capabilities?.team_hub_host_control_v1
    )
    if (!enabledCapability.available || enabledCapability.enabled !== (input.role === 'host')) {
      throw new Error(enabledCapability.message || 'AgentsServer did not apply the Team Network role.')
    }
    const discovery = parseTeamHubDiscovery(
      health.capabilities?.team_hub_v1,
      context.expected.serverIdentity
    )
    if (discovery.designatedHost !== (input.role === 'host')) {
      throw new Error('AgentsServer did not apply the requested Team Network role.')
    }
    this.adoptHealth(context.scope, health)
    return discovery
  }

  /**
   * Request a recipient/body-bound bootstrap proof through the authenticated
   * parent control plane. The core credential and returned proof stay in main.
   */
  async requestTeamHubBootstrapProof(
    expected: TeamHubServerScope,
    input: TeamHubBootstrapProofInput
  ): Promise<TeamHubBootstrapProof> {
    const scope = this.requireWorkspaceScope(expected)
    if (this.settings.serverUrl(scope.profileId) !== expected.serverUrl) throw staleProfileError()
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, expected) || !current.serverIdentity) throw staleProfileError()
    const context = requireTeamHubBootstrapContext(this.health, current, input)
    const requestId = randomUUID()
    const request = {
      request_id: requestId,
      expected_server_identity: current.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_hub_id: context.discovery.hubIdentity!,
      expected_hub_url: context.discovery.hubUrl!,
      confirmed: true as const,
      ...(context.discovery.transport === 'direct_ip' ? {
        expected_transport: 'direct_ip' as const,
        unsafe_direct_ip_confirmed: true as const
      } : {}),
      recipient_email: context.recipientEmail,
      display_name: context.displayName,
      device_label: context.deviceLabel
    }
    const requestProof = () => scope.client.teamHubBootstrapProof(context.discovery.hubUrl!, request)
    let result: Awaited<ReturnType<AgentServerClient['teamHubBootstrapProof']>>
    try {
      result = await requestProof()
    } catch (error) {
      if (!(error instanceof TeamHubBootstrapTransportError)) throw error
      // The server may have committed a one-time grant before the connection
      // failed. Retry exactly once with the same UUID/body, and only after the
      // active profile and advertised target are fenced again.
      this.assertCurrentScope(scope)
      const retryScope = this.teamHubServerScope()
      if (!sameTeamHubServerScope(retryScope, expected) || !retryScope.serverIdentity) throw staleProfileError()
      const retryContext = requireTeamHubBootstrapContext(this.health, retryScope, input)
      if (
        retryContext.serverInstanceId !== context.serverInstanceId
        || !sameTeamHubDiscovery(retryContext.discovery, context.discovery)
      ) throw staleProfileError()
      result = await requestProof()
    }
    this.assertCurrentScope(scope)
    const after = this.teamHubServerScope()
    if (!sameTeamHubServerScope(after, expected) || !after.serverIdentity) throw staleProfileError()
    const currentContext = requireTeamHubBootstrapContext(this.health, after, input)
    if (
      currentContext.serverInstanceId !== context.serverInstanceId
      || !sameTeamHubDiscovery(currentContext.discovery, context.discovery)
    ) throw staleProfileError()
    requireExactTeamHubBootstrapGrant(result, {
      requestId,
      serverIdentity: current.serverIdentity,
      serverInstanceId: context.serverInstanceId,
      hubIdentity: context.discovery.hubIdentity!
    })
    return { requestId, proof: result.bootstrap_proof }
  }

  async securePeerStatus(expected: SecurePeerProfileScope): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const raw = await context.scope.client.securePeerStatus()
    this.requireSecurePeerControlContext(context)
    return {
      ...parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId),
      automaticPairingCompletionAvailable: automaticPairingCompletionAvailable(this.health?.capabilities?.automatic_pairing_completion_v1)
    }
  }

  async securePeerHostPeers(
    expected: SecurePeerProfileScope,
    teamId: string
  ): Promise<SecurePeerPairing[]> {
    const context = await this.securePeerControlContext(expected)
    const team = boundedTeamHubControlField(teamId, 'team', 128)
    const raw = await context.scope.client.securePeerHostPeers({
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      team_id: team
    })
    this.requireSecurePeerControlContext(context)
    const peers = parseSecurePeerHostPeers(raw)
    if (peers.some(peer => peer.direction !== 'incoming' || peer.teamId !== team)) {
      throw new Error('AgentsServer returned secure peers outside the requested team.')
    }
    return peers
  }

  async revokeSecurePeerHostPeer(
    expected: SecurePeerProfileScope,
    teamId: string,
    input: SecurePeerRevokeInput
  ): Promise<SecurePeerPairing> {
    const context = await this.securePeerControlContext(expected)
    const team = boundedTeamHubControlField(teamId, 'team', 128)
    const peerId = securePeerV4ID(input?.peerId, 'peer')
    const idempotencyKey = securePeerV4ID(input?.idempotencyKey, 'idempotency key')
    const certificateFingerprint = securePeerCertificateFingerprint(input?.expectedCertificateFingerprint)
    const raw = await context.scope.client.revokeSecurePeerHostPeer(peerId, {
      request_id: idempotencyKey,
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      team_id: team,
      expected_certificate_fingerprint: certificateFingerprint,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    const peer = parseSecurePeerHostPeerRevocation(raw)
    if (
      peer.connectionId !== peerId
      || peer.direction !== 'incoming'
      || peer.teamId !== team
      || peer.status !== 'revoked'
      || peer.trustState !== 'revoked'
      || peer.transportState !== 'revoked'
      || peer.certificateFingerprint !== certificateFingerprint
    ) {
      throw new Error('AgentsServer returned a mismatched secure peer revocation receipt.')
    }
    return peer
  }

  async configureSecurePeerHost(
    expected: SecurePeerProfileScope,
    input: SecurePeerConfigureHostInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    if (!input || typeof input !== 'object') throw new Error('Secure host settings are required.')
    const enabled = input.enabled === true
    if (input.enabled !== true && input.enabled !== false) throw new Error('Secure host setting is invalid.')
    const advertisedHost = enabled ? normalizeSecurePeerIPv4(input.advertisedHost) : null
    const listenPort = normalizeSecurePeerPort(input.listenPort ?? 7851)
    const raw = await context.scope.client.configureSecurePeerHost({
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      enabled,
      advertised_host: advertisedHost,
      listen_port: listenPort,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async requestSecurePeerPairing(
    expected: SecurePeerProfileScope,
    input: SecurePeerJoinInput
  ): Promise<SecurePeerPairing> {
    const context = await this.securePeerControlContext(expected)
    const endpoint = normalizeSecurePeerJoinTarget(input?.host)
    const displayName = boundedTeamHubControlField(input?.displayName, 'peer display name', 160)
    const requestedScopes = normalizeSecurePeerScopes(input?.requestedScopes)
    if (input.completeOnApproval !== undefined && input.completeOnApproval !== true) {
      throw new Error('Automatic pairing completion consent is invalid.')
    }
    if (input.completeOnApproval === true && !automaticPairingCompletionAvailable(this.health?.capabilities?.automatic_pairing_completion_v1)) {
      throw new Error('Update this AgentsServer to complete pairing automatically after approval.')
    }
    const request = {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      host: endpoint.host,
      port: endpoint.port,
      display_name: displayName,
      requested_scopes: requestedScopes,
      expected_ca_fingerprint: endpoint.expectedCaFingerprint,
      ...(input.completeOnApproval === true ? { complete_on_approval: true } : {})
    }
    let raw: unknown
    try {
      raw = await context.scope.client.requestSecurePeerPairing(request)
    } catch (error) {
      if (error instanceof ServerError) throw error
      // The server persists the signed request/key before reaching the remote
      // host. One exact same-UUID retry resolves an ambiguous lost response
      // without creating another pairing or another private key.
      this.requireSecurePeerControlContext(context)
      raw = await context.scope.client.requestSecurePeerPairing(request)
    }
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerPairing(raw)
  }

  async refreshSecurePeerPairing(expected: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerPairing> {
    const context = await this.securePeerControlContext(expected)
    const raw = await context.scope.client.securePeerPairing(pairingId)
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerPairing(raw)
  }

  async waitForSecurePeerPairingCompletion(
    expected: SecurePeerProfileScope,
    input: { pairingId: string; expectedTranscriptHash: string },
    signal: AbortSignal
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    signal.throwIfAborted()
    if (!automaticPairingCompletionAvailable(this.health?.capabilities?.automatic_pairing_completion_v1)) {
      throw new Error('Update this AgentsServer to complete pairing automatically after approval.')
    }
    const pairingId = securePeerV4ID(input?.pairingId, 'pairing')
    if (!/^[0-9a-f]{64}$/.test(input?.expectedTranscriptHash ?? '')) throw new Error('Secure pairing transcript is invalid.')
    const raw = await context.scope.client.securePeerPairingCompletion(pairingId, {
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_transcript_hash: input.expectedTranscriptHash
    }, signal)
    signal.throwIfAborted()
    this.requireSecurePeerControlContext(context)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid secure pairing completion response.')
    const receipt = raw as Record<string, unknown>
    if (receipt.version !== 1) throw new Error('Invalid secure pairing completion response.')
    const completed = receipt.completion_state === 'completed'
    const terminalState = receipt.completion_state === 'expired' || receipt.completion_state === 'cancelled'
      ? receipt.completion_state : null
    if (!completed && !terminalState) {
      throw new Error('Automatic pairing completion stopped. Check the current pairing status before trying again.')
    }
    const pairing = parseSecurePeerPairing(receipt.pairing, true)
    if (pairing.id !== pairingId || pairing.transcriptHash !== input.expectedTranscriptHash
      || pairing.direction !== 'outgoing'
      || (completed ? pairing.trustState !== 'approved' || pairing.transportState !== 'online' || !pairing.completeOnApproval
        || !pairing.connectionId || !pairing.hubIdentity : false)) {
      throw new Error('AgentsServer returned a mismatched secure pairing completion receipt.')
    }
    const statusRaw = await context.scope.client.securePeerStatus(signal)
    signal.throwIfAborted()
    this.requireSecurePeerControlContext(context)
    const status = parseSecurePeerControlStatus(statusRaw, context.expected, context.serverInstanceId)
    const selected = status.pairings.find(item => item.id === pairing.id)
    if (!selected
      || selected.connectionId !== pairing.connectionId || selected.hubIdentity !== pairing.hubIdentity
      || selected.hostServerIdentity !== pairing.hostServerIdentity || selected.hostCaFingerprint !== pairing.hostCaFingerprint
      || selected.transcriptHash !== pairing.transcriptHash || selected.certificateFingerprint !== pairing.certificateFingerprint
      || selected.direction !== 'outgoing'
      || (completed ? status.activeConnectionId !== pairing.connectionId || selected.trustState !== 'approved'
        || selected.transportState !== 'online' || !selected.completeOnApproval
        : false)) {
      throw new Error('The approved secure connection changed before it could be adopted.')
    }
    return { ...status, automaticPairingCompletionAvailable: true,
      ...(terminalState ? { pairingCompletion: { pairingId, transcriptHash: pairing.transcriptHash, state: terminalState } } : {}) }
  }

  async cancelSecurePeerPairing(expected: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const raw = await context.scope.client.cancelSecurePeerPairing(pairingId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async approveSecurePeerPairing(
    expected: SecurePeerProfileScope,
    input: SecurePeerApproveInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    if (input?.sasConfirmed !== true) throw new Error('Confirm the six-word code before approving this server.')
    const pairingId = securePeerV4ID(input?.pairingId, 'pairing')
    const raw = await context.scope.client.approveSecurePeerPairing(pairingId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      team_id: boundedTeamHubControlField(input?.teamId, 'team', 128),
      expected_peer_server_identity: boundedTeamHubControlField(input?.expectedPeerServerIdentity, 'peer server identity', 240),
      expected_transcript_hash: securePeerTranscriptHash(input?.expectedTranscriptHash),
      scopes: normalizeSecurePeerScopes(input?.scopes),
      sas_confirmed: true,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async rejectSecurePeerPairing(
    expected: SecurePeerProfileScope,
    input: SecurePeerRejectInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const pairingId = securePeerV4ID(input?.pairingId, 'pairing')
    const reason = input?.reason?.trim()
    if (reason && (reason.length > 160 || /[\u0000-\u001f\u007f]/.test(reason))) {
      throw new Error('Secure peer rejection reason is invalid.')
    }
    const raw = await context.scope.client.rejectSecurePeerPairing(pairingId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_peer_server_identity: boundedTeamHubControlField(input?.expectedPeerServerIdentity, 'peer server identity', 240),
      expected_transcript_hash: securePeerTranscriptHash(input?.expectedTranscriptHash),
      ...(reason ? { reason } : {}),
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async activateSecurePeerPairing(
    expected: SecurePeerProfileScope,
    input: SecurePeerActivateInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const connectionId = securePeerV4ID(input?.expectedConnectionId, 'connection')
    const hostIdentity = boundedTeamHubControlField(input?.expectedHostServerIdentity, 'host server identity', 240)
    const hubIdentity = boundedTeamHubControlField(input?.expectedHubIdentity, 'Hub identity', 240)
    const raw = await context.scope.client.activateSecurePeerPairing(input?.pairingId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_connection_id: connectionId,
      expected_host_server_identity: hostIdentity,
      expected_hub_id: hubIdentity,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async deactivateSecurePeerConnection(
    expected: SecurePeerProfileScope,
    input: SecurePeerDeactivateInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const connectionId = securePeerV4ID(input?.connectionId, 'connection')
    const hostIdentity = boundedTeamHubControlField(input?.expectedHostServerIdentity, 'host server identity', 240)
    const hubIdentity = boundedTeamHubControlField(input?.expectedHubIdentity, 'Hub identity', 240)
    const raw = await context.scope.client.deactivateSecurePeerConnection(connectionId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_host_server_identity: hostIdentity,
      expected_hub_id: hubIdentity,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async forgetSecurePeerConnection(
    expected: SecurePeerProfileScope,
    input: SecurePeerForgetConnectionInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const connectionId = securePeerV4ID(input?.connectionId, 'connection')
    const hostIdentity = boundedTeamHubControlField(input?.expectedHostServerIdentity, 'host server identity', 240)
    const hubIdentity = boundedTeamHubControlField(input?.expectedHubIdentity, 'Hub identity', 240)
    const certificateFingerprint = securePeerCertificateFingerprint(input?.expectedCertificateFingerprint)
    const raw = await context.scope.client.forgetSecurePeerConnection(connectionId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_host_server_identity: hostIdentity,
      expected_hub_id: hubIdentity,
      expected_certificate_fingerprint: certificateFingerprint,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async publishSecurePeerRoute(
    expected: SecurePeerProfileScope,
    input: SecurePeerPublishRouteInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const connectionId = securePeerV4ID(input?.connectionId, 'connection')
    const chatId = boundedTeamHubControlField(input?.chatId, 'chat', 128)
    const alias = boundedTeamHubControlField(input?.alias, 'route alias', 32)
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) throw new Error('Secure peer route alias is invalid.')
    const displayTitle = boundedTeamHubControlField(input?.displayTitle, 'route title', 240)
    const actions = securePeerRouteActions(input?.actions)
    const raw = await context.scope.client.publishSecurePeerRoute({
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      connection_id: connectionId,
      chat_id: chatId,
      alias,
      display_title: displayTitle,
      actions,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  async revokeSecurePeerRoute(
    expected: SecurePeerProfileScope,
    input: SecurePeerRevokeRouteInput
  ): Promise<SecurePeerControlStatus> {
    const context = await this.securePeerControlContext(expected)
    const routeId = securePeerV4ID(input?.routeId, 'route')
    const connectionId = securePeerV4ID(input?.expectedConnectionId, 'connection')
    if (typeof input?.expectedRevision !== 'string' || !/^rev_[0-9a-f]{32}$/.test(input.expectedRevision)) {
      throw new Error('Secure peer route revision is invalid.')
    }
    const raw = await context.scope.client.revokeSecurePeerRoute(routeId, {
      request_id: randomUUID(),
      expected_server_identity: context.expected.serverIdentity,
      expected_server_instance_id: context.serverInstanceId,
      expected_connection_id: connectionId,
      expected_revision: input.expectedRevision,
      confirmed: true
    })
    this.requireSecurePeerControlContext(context)
    return parseSecurePeerControlStatus(raw, context.expected, context.serverInstanceId)
  }

  secureTeamHubProxyFetch(expected: TeamHubServerScope, basePath: string): typeof fetch {
    const scope = this.requireWorkspaceScope(expected)
    if (!this.isValidatedScope(scope) || this.settings.serverUrl(scope.profileId) !== expected.serverUrl) throw staleProfileError()
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, expected) || !current.serverIdentity) throw staleProfileError()
    const health = this.health
    if (!health || health.ok !== true || health.server_identity !== current.serverIdentity) throw staleProfileError()
    const proxyFetch = scope.client.secureTeamHubProxyFetch(basePath)
    return (async (input: string | URL | Request, init?: RequestInit) => {
      this.assertCurrentScope(scope)
      const response = await proxyFetch(input, init)
      this.assertCurrentScope(scope)
      return response
    }) as typeof fetch
  }

  serverTeamHubProxyFetch(expected: TeamHubServerScope, basePath: string): typeof fetch {
    const scope = this.requireWorkspaceScope(expected)
    if (!this.isValidatedScope(scope) || this.settings.serverUrl(scope.profileId) !== expected.serverUrl) throw staleProfileError()
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, expected) || !current.serverIdentity) throw staleProfileError()
    const health = this.health
    if (!health || health.ok !== true || health.server_identity !== current.serverIdentity) throw staleProfileError()
    const discovery = parseTeamHubDiscovery(health.capabilities?.team_hub_v1, current.serverIdentity)
    if (!discovery.designatedHost || discovery.serverSessionBasePath !== basePath) throw staleProfileError()
    const proxyFetch = scope.client.serverTeamHubProxyFetch(basePath)
    return (async (input: string | URL | Request, init?: RequestInit) => {
      this.assertCurrentScope(scope)
      const response = await proxyFetch(input, init)
      this.assertCurrentScope(scope)
      return response
    }) as typeof fetch
  }

  private async securePeerControlContext(expectedValue: SecurePeerProfileScope): Promise<{
    expected: SecurePeerProfileScope
    scope: ConnectionScope
    serverInstanceId: string
  }> {
    const expected = securePeerProfileScope(expectedValue)
    const teamScope = this.teamHubServerScope()
    if (
      teamScope.profileId !== expected.profileId
      || teamScope.profileGeneration !== expected.profileGeneration
      || teamScope.serverIdentity !== expected.serverIdentity
    ) throw staleProfileError()
    const scope = this.requireWorkspaceScope(teamScope)
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    const current = this.teamHubServerScope()
    if (!sameTeamHubServerScope(current, teamScope)) throw staleProfileError()
    const health = this.health
    if (!health || health.ok !== true || health.server_identity !== expected.serverIdentity) throw staleProfileError()
    const serverInstanceId = boundedTeamHubControlField(health.server_instance_id, 'server instance', 240)
    return { expected, scope, serverInstanceId }
  }

  private requireSecurePeerControlContext(context: {
    expected: SecurePeerProfileScope
    scope: ConnectionScope
    serverInstanceId: string
  }): void {
    this.assertCurrentScope(context.scope)
    const current = this.teamHubServerScope()
    if (
      current.profileId !== context.expected.profileId
      || current.profileGeneration !== context.expected.profileGeneration
      || current.serverIdentity !== context.expected.serverIdentity
    ) throw staleProfileError()
    const health = this.health
    if (
      !health || health.ok !== true
      || health.server_identity !== context.expected.serverIdentity
      || health.server_instance_id !== context.serverInstanceId
    ) throw staleProfileError()
  }

  addServer(input: AddServerProfileInput): PublicServerProfile {
    const profile = this.settings.addProfile(input)
    this.setProfileRuntime(profile.id, { connectionState: 'cached', lastConnectionCheckedAt: null })
    this.emitProfiles()
    return this.settings.getProfile(profile.id, this.runtimeForProfile(profile.id)) ?? profile
  }

  async updateServer(profileId: string, patch: UpdateServerProfilePatch): Promise<PublicServerProfile> {
    return patch.resetServerIdentity || this.profileAuthorityOperations.has(profileId)
      ? this.withProfileAuthorityOperation(profileId, () => this.updateServerOnce(profileId, patch))
      : this.updateServerOnce(profileId, patch)
  }

  private async updateServerOnce(profileId: string, patch: UpdateServerProfilePatch): Promise<PublicServerProfile> {
    this.requireProfileNotRemoving(profileId)
    const before = this.settings.getProfile(profileId)
    if (patch.resetServerIdentity && profileId === this.activeProfileId) {
      throw new Error('Reopen the active server while resetting its identity so the old connection can be retired safely.')
    }
    // Commit the durable trust reset before deleting any authority-owned data.
    // Once this succeeds, cleanup is deliberately irreversible: restoring the
    // old identity after a partial purge would recreate trust with missing data.
    const profile = this.persistServerUpdate(profileId, patch)
    if (before && profileConnectionChanged(before, patch)) {
      this.invalidateProfileHealthProbe(profileId)
      this.setProfileRuntime(profileId, {
        connectionState: 'cached',
        lastConnectionError: null,
        lastConnectionCheckedAt: null
      })
    }
    if (patch.resetServerIdentity) {
      const cleanupError = await this.cleanupRetiredProfileAuthority(profileId, [
        ...(this.pendingProfileAuthorityNamespaces.get(profileId) ?? []),
        fallbackNamespace(profileId),
        before?.serverIdentity?.trim() || ''
      ])
      if (cleanupError) {
        this.setProfileRuntime(profileId, {
          connectionState: 'cached',
          lastConnectionError: `The server identity was reset, but some retired local data could not be removed: ${cleanupError}`,
          lastConnectionCheckedAt: null
        })
      }
    }
    this.emitProfiles()
    return this.settings.getProfile(profileId, this.runtimeForProfile(profileId)) ?? profile
  }

  async updateServerAndSwitch(profileId: string, patch: UpdateServerProfilePatch): Promise<ProfileBootstrapPayload> {
    const intent = ++this.profileSelectionIntent
    return patch.resetServerIdentity
      || this.profileAuthorityOperations.has(profileId)
      || this.pendingProfileAuthorityNamespaces.has(profileId)
      ? this.withProfileAuthorityOperation(profileId, () => this.updateServerAndSwitchOnce(profileId, patch, intent))
      : this.updateServerAndSwitchOnce(profileId, patch, intent)
  }

  private async updateServerAndSwitchOnce(profileId: string, patch: UpdateServerProfilePatch, intent: number): Promise<ProfileBootstrapPayload> {
    this.requireProfileNotRemoving(profileId)
    let revision = this.settings.connectionRevision(profileId)
    this.assertProfileSelection(profileId, intent, revision)
    const before = this.settings.getProfile(profileId)
    if (!before) throw new Error(`Unknown server profile: ${profileId}`)
    const nextServerUrl = patch.serverUrl === undefined ? this.settings.serverUrl(profileId) : normalizeServerURL(patch.serverUrl)
    const nextAccessToken = patch.accessToken === undefined || patch.accessToken === '__KEEP__'
      ? await this.settings.accessTokenForConnectionAsync(profileId)
      : patch.accessToken ?? ''
    this.assertProfileSelection(profileId, intent, revision)
    const nextClient = this.clientFactory(nextServerUrl, nextAccessToken)
    const resettingIdentity = patch.resetServerIdentity === true
    const retryingRetiredCleanup = this.pendingProfileAuthorityNamespaces.has(profileId)
    const resettingActiveProfile = resettingIdentity && profileId === this.activeProfileId
    const retainedPendingNamespaces = this.profileResetPending?.profileId === profileId
      ? this.profileResetPending.retiredNamespaces
      : []
    const retiredNamespaces = [...new Set([
      ...(this.pendingProfileAuthorityNamespaces.get(profileId) ?? []),
      ...retainedPendingNamespaces,
      fallbackNamespace(profileId),
      before.serverIdentity?.trim() || ''
    ].filter(Boolean))]
    let preActivationCleanupError: string | null = null
    try {
      if (resettingActiveProfile) {
        const { resetServerIdentity: _resetServerIdentity, ...connectionPatch } = patch
        this.persistServerUpdate(profileId, connectionPatch)
        revision = this.settings.connectionRevision(profileId)
      } else {
        this.persistServerUpdate(profileId, patch)
        revision = this.settings.connectionRevision(profileId)
        if (resettingIdentity || retryingRetiredCleanup) {
          preActivationCleanupError = await this.cleanupRetiredProfileAuthority(profileId, retiredNamespaces)
        }
      }
      this.assertProfileSelection(profileId, intent, revision)
    } catch (error) {
      nextClient.dispose()
      throw error
    }
    const scope = this.activateProfile(
      profileId,
      true,
      true,
      nextClient,
      undefined,
      resettingIdentity || retryingRetiredCleanup ? fallbackNamespace(profileId) : undefined,
      resettingActiveProfile || preActivationCleanupError ? retiredNamespaces : undefined
    )
    if (resettingIdentity) {
      let authorityReset = !resettingActiveProfile
      try {
        if (resettingActiveProfile) {
          // The old generation is already fenced and its buffered events have
          // been flushed. Persist the trust reset before any irreversible
          // Teamspace or local-cache deletion.
          this.persistServerUpdate(profileId, { resetServerIdentity: true })
          authorityReset = true
        }
      } catch (error) {
        this.recordProfileTransitionWarning(
          `The server profile reopened, but its prior identity could not be reset safely: ${errorText(error)}`
        )
        this.sessions = []
        this.jobs = []
        this.runtimeCatalog = null
        this.health = null
        this.focusedSessionId = null
      }
      if (authorityReset) {
        const cleanupError = resettingActiveProfile
          ? await this.cleanupRetiredProfileAuthority(profileId, retiredNamespaces)
          : preActivationCleanupError
        this.assertCurrentScope(scope)
        if (cleanupError) {
          this.recordProfileTransitionWarning(
            `The server identity was reset, but some retired local data could not be removed: ${cleanupError}`
          )
          // Keep this exact replacement generation empty and validation-fenced.
          // An explicit retry can finish cleanup using the retained namespaces;
          // after restart, server-identity-bound cache keys keep any orphaned
          // bytes unreachable by a replacement authority.
          this.profileResetPending = {
            profileId: scope.profileId,
            generation: scope.generation,
            retiredNamespaces
          }
          this.sessions = []
          this.jobs = []
          this.runtimeCatalog = null
          this.health = null
          this.focusedSessionId = null
          return this.loadCachedBootstrap(scope)
        }
        try {
          this.replaceScopeNamespace(scope, fallbackNamespace(profileId))
        } catch (error) {
          // The durable identity and Teamspace authority are already reset.
          // Keep the fenced replacement scope on its fallback namespace and
          // return a coherent empty-cache payload instead of rolling trust back.
          this.serverId = fallbackNamespace(profileId)
          scope.namespace = this.serverId
          this.sessions = []
          this.jobs = []
          this.runtimeCatalog = null
          this.health = null
          this.focusedSessionId = null
          this.recordProfileTransitionWarning(
            `The server identity was reset, but its replacement local cache could not be loaded: ${errorText(error)}`
          )
        }
        this.validatedGeneration = null
        if (this.profileResetPending?.profileId === scope.profileId && this.profileResetPending.generation === scope.generation) {
          this.profileResetPending = null
        }
      }
    }
    return this.loadCachedBootstrap(scope)
  }

  async removeServer(profileId: string): Promise<boolean> {
    const current = this.profileRemovals.get(profileId)
    if (current) return current
    const removal = this.withProfileAuthorityOperation(profileId, () => this.removeServerOnce(profileId))
    this.profileRemovals.set(profileId, removal)
    try {
      return await removal
    } finally {
      if (this.profileRemovals.get(profileId) === removal) this.profileRemovals.delete(profileId)
    }
  }

  private async removeServerOnce(profileId: string): Promise<boolean> {
    if (profileId === this.activeProfileId) {
      throw new Error('Switch to another server before removing the active profile.')
    }
    if (!this.settings.getProfile(profileId)) throw new Error(`Unknown server profile: ${profileId}`)
    const teamHubCleanup = await this.removeTeamHubProfile(profileId)
    if (teamHubCleanup?.cleanupWarning) {
      throw new Error(`Teamspace authority was removed, but its private attachment cache could not be deleted. Retry removing this server profile. ${teamHubCleanup.cleanupWarning}`)
    }
    try {
      if (profileId === this.activeProfileId) {
        throw new Error('Switch to another server before removing the active profile.')
      }
      const profile = this.settings.getProfile(profileId)
      if (!profile) throw new Error(`Unknown server profile: ${profileId}`)
      const cacheNamespaces = [
        ...(this.pendingProfileAuthorityNamespaces.get(profileId) ?? []),
        fallbackNamespace(profileId),
        profile.serverIdentity?.trim() || ''
      ]
      // Cache authority is removed before the durable profile. If settings
      // persistence subsequently fails, safe cache loss is preferable to
      // retaining confidential rows for a profile the user chose to remove.
      this.cache.removeServerNamespaces(cacheNamespaces)
      this.settings.removeProfile(profileId)
    } catch (error) { throw error }
    this.invalidateProfileHealthProbe(profileId)
    this.profileHealthAccessTokens.delete(profileId)
    this.profileRuntime.delete(profileId)
    this.pendingProfileAuthorityNamespaces.delete(profileId)
    this.emitProfiles()
    return true
  }

  reorderServers(profileIds: string[]): PublicServerProfile[] {
    this.settings.reorderProfiles(profileIds)
    this.emitProfiles()
    return this.publicProfiles()
  }

  async switchServer(profileId: string, force = false): Promise<ProfileBootstrapPayload> {
    const intent = ++this.profileSelectionIntent
    this.requireProfileNotRemoving(profileId)
    return this.profileAuthorityOperations.has(profileId) || this.pendingProfileAuthorityNamespaces.has(profileId)
      ? this.withProfileAuthorityOperation(profileId, () => this.switchServerOnce(profileId, force, intent))
      : this.switchServerOnce(profileId, force, intent)
  }

  private async switchServerOnce(profileId: string, force: boolean, intent: number): Promise<ProfileBootstrapPayload> {
    this.requireProfileNotRemoving(profileId)
    const revision = this.settings.connectionRevision(profileId)
    this.assertProfileSelection(profileId, intent, revision)
    const token = await this.settings.accessTokenForConnectionAsync(profileId)
    this.assertProfileSelection(profileId, intent, revision)
    const pendingNamespaces = this.pendingProfileAuthorityNamespaces.get(profileId)
    const cleanupError = pendingNamespaces
      ? await this.cleanupRetiredProfileAuthority(profileId, pendingNamespaces)
      : null
    this.assertProfileSelection(profileId, intent, revision)
    const nextClient = force || pendingNamespaces || profileId !== this.activeProfileId
      ? this.clientFactory(this.settings.serverUrl(profileId), token)
      : undefined
    const scope = this.activateProfile(
      profileId,
      true,
      force || Boolean(pendingNamespaces),
      nextClient,
      undefined,
      cleanupError ? fallbackNamespace(profileId) : undefined,
      cleanupError ? pendingNamespaces : undefined
    )
    if (cleanupError) {
      this.recordProfileTransitionWarning(
        `The server identity was reset, but some retired local data could not be removed: ${cleanupError}`
      )
    }
    return this.loadCachedBootstrap(scope)
  }

  async refreshServer(profileId: string, profileGeneration: number): Promise<ProfileBootstrapPayload> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    if (this.profileResetIsPending(scope)) {
      throw new Error('This server profile is waiting for its prior identity reset to finish. Retry the identity reset before reconnecting.')
    }
    await this.refreshAll(false, true, scope)
    return this.loadCachedBootstrap(this.requireProfileScope(profileId, profileGeneration))
  }

  async testServerConnection(input: TestServerConnectionInput): Promise<Health> {
    const shutdownEpoch = this.shutdownEpoch
    const profile = input.profileId ? this.settings.getProfile(input.profileId) : null
    if (input.profileId && !profile) throw new Error(`Unknown server profile: ${input.profileId}`)
    const revision = input.profileId ? this.settings.connectionRevision(input.profileId) : null
    const assertProfile = (): void => {
      if (this.shutdownEpoch !== shutdownEpoch) throw staleProfileError()
      if (input.profileId) {
        this.requireProfileNotRemoving(input.profileId)
        if (this.settings.connectionRevision(input.profileId) !== revision) throw staleProfileError()
      }
    }
    const token = (input.accessToken === undefined || input.accessToken === '__KEEP__') && input.profileId
      ? await this.settings.accessTokenForConnectionAsync(input.profileId)
      : input.accessToken ?? ''
    assertProfile()
    const client = this.clientFactory(input.serverUrl, token)
    try {
      const health = await client.health()
      assertProfile()
      if (health.ok !== true) throw new Error('Server health check reported unavailable.')
      return health
    }
    finally { client.dispose() }
  }

  async serverRestartStatus(expected: WorkspaceProfileScope): Promise<ServerRestartStatus> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    const status = await scope.client.serverRestartStatus()
    this.assertCurrentScope(scope)
    return status
  }

  async restartServer(
    expected: WorkspaceProfileScope,
    expectedServerInstanceId: string,
    forceConfirmation?: ServerForceRestartConfirmation
  ): Promise<ProfileBootstrapPayload> {
    const selectionIntent = ++this.profileSelectionIntent
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)

    const expectedIdentity = this.settings.serverIdentity(scope.profileId)
    const currentIdentity = this.health?.server_identity?.trim() || null
    const currentInstanceId = this.health?.server_instance_id?.trim() || null
    const requestedInstanceId = expectedServerInstanceId.trim()
    const expectedServerUrl = this.settings.serverUrl(scope.profileId)
    // Resolve the durable credential before the one-shot restart POST. An
    // unreadable Keychain item must stop here: posting with the already-active
    // client and then probing with an empty token would restart the server but
    // strand this profile offline afterward.
    const expectedCredentialRevision = this.settings.connectionRevision(scope.profileId)
    const expectedAccessToken = await this.settings.accessTokenForConnectionAsync(scope.profileId)
    this.assertCurrentScope(scope)
    const capability = this.health?.capabilities?.server_restart
    const capabilityVersion = capability && typeof capability === 'object' && !Array.isArray(capability)
      && typeof capability.version === 'number' && Number.isFinite(capability.version)
      ? capability.version
      : 0

    if (!expectedIdentity || expectedIdentity !== currentIdentity || (expected.serverIdentity ?? null) !== expectedIdentity) {
      throw staleProfileError()
    }
    if (!requestedInstanceId || requestedInstanceId !== currentInstanceId) {
      throw new Error('The active AgentsServer instance changed before the restart was confirmed. Refresh Settings and try again.')
    }
    if (!capability || capabilityVersion < 1 || capability.available !== true) {
      throw new Error(capability?.message || 'This AgentsServer version does not support managed restart.')
    }
    const forced = forceConfirmation !== undefined
    const expectedBlockerRevision = forceConfirmation?.expectedBlockerRevision?.trim() || ''
    const expectedUpdateScheduleId = forceConfirmation?.expectedUpdateScheduleId?.trim() || ''
    if (forced && (
      capabilityVersion < 2
      || capability.force_restart !== true
      || capability.force_confirmation_required !== true
    )) {
      throw new Error('This AgentsServer version does not support explicitly confirmed force restart.')
    }
    if (forced && (
      forceConfirmation?.force !== true
      || forceConfirmation.forceConfirmed !== true
    )) {
      throw new Error('Force restart requires an explicit confirmation.')
    }
    // The blocker revision is an audit hint, not a precondition: a wedged
    // server may not be able to serve a fresh snapshot, and that is exactly
    // when the operator needs force restart. An omitted revision is allowed
    // (the server audits the omission, 0.1.26-beta.30+); a malformed one is
    // still refused because it means the renderer did not review a snapshot.
    if (forced && expectedBlockerRevision && !/^[0-9a-f]{64}$/.test(expectedBlockerRevision)) {
      throw new Error('Force restart requires a fresh, explicitly confirmed blocker snapshot revision, or none when the server cannot provide one.')
    }
    if (forced && expectedUpdateScheduleId && !/^[0-9a-f]{32}$/.test(expectedUpdateScheduleId)) {
      throw new Error('Update-now restart requires the exact 32-character lowercase update schedule ID.')
    }
    if (forced && expectedUpdateScheduleId && serverCapabilityVersion(this.health?.capabilities?.server_updates) < 11) {
      throw new Error('Update or reconnect AgentsServer before forcing a queued update to install now.')
    }
    const blockerRevisionForRequest = expectedBlockerRevision || null
    const updateScheduleIdForRequest = expectedUpdateScheduleId || null
    const assertRestartScope = (): void => {
      this.assertCurrentScope(scope)
      if (
        this.profileSelectionIntent !== selectionIntent
        || this.settings.serverIdentity(scope.profileId) !== expectedIdentity
        || this.settings.serverUrl(scope.profileId) !== expectedServerUrl
        || this.settings.connectionRevision(scope.profileId) !== expectedCredentialRevision
      ) throw staleProfileError()
    }
    assertRestartScope()

    const requestId = randomUUID()
    const reconnectClient = this.clientFactory(
      expectedServerUrl,
      expectedAccessToken
    )
    let reconnectClientWasAdopted = false
    let ambiguousRequestError: unknown = null
    try {
      let accepted: ServerRestartStatus | null = null
      try {
        const restartRequest: ServerRestartRequest = {
          request_id: requestId,
          expected_server_identity: expectedIdentity,
          expected_server_instance_id: requestedInstanceId,
          confirmed: true,
          ...(forced ? {
            force: true as const,
            force_confirmed: true as const,
            ...(blockerRevisionForRequest ? { expected_blocker_revision: blockerRevisionForRequest } : {}),
            ...(updateScheduleIdForRequest ? { expected_update_schedule_id: updateScheduleIdForRequest } : {})
          } : {})
        }
        accepted = await scope.client.restartServer(restartRequest)
        assertRestartScope()
      } catch (error) {
        assertRestartScope()
        if (error instanceof ServerError) throw error
        // The server may close its listener before the accepted response reaches
        // Electron. The POST is deliberately never retried; only fresh health
        // reads are safe after an ambiguous transport failure. A schedule-bound
        // update is stricter: observing a new boot cannot prove that the server
        // atomically armed the exact reservation, so it must have the v11
        // acceptance receipt before this client can report success.
        ambiguousRequestError = error
      }

      if (updateScheduleIdForRequest && ambiguousRequestError) {
        throw new Error('AgentsServer did not return the required confirmation for the exact queued update reservation. The update may still be starting; refresh update status before trying again.')
      }

      if (accepted) {
        if (
          (updateScheduleIdForRequest && accepted.request_id !== requestId)
          || (accepted.request_id && accepted.request_id !== requestId)
        ) {
          throw new Error('AgentsServer returned a restart status for a different request.')
        }
        if (
          updateScheduleIdForRequest
          && (
            accepted.phase !== 'accepted'
            || accepted.forced !== true
            || accepted.update_schedule_id !== updateScheduleIdForRequest
          )
        ) {
          throw new Error('AgentsServer did not confirm the exact queued update reservation for this restart.')
        }
        if (accepted.phase === 'idle' || accepted.phase === 'failed') {
          throw new Error(accepted.message || 'AgentsServer did not accept the restart request.')
        }
      }

      const deadline = Date.now() + this.serverRestartReconnectTimeoutMs
      let oldServerWasReachable = false
      while (Date.now() <= deadline) {
        assertRestartScope()
        const probeBudgetMs = deadline - Date.now()
        if (probeBudgetMs <= 0) break
        let nextHealth: Health | null = null
        try {
          nextHealth = await reconnectClient.health(
            Math.max(1, Math.min(this.serverRestartHealthTimeoutMs, probeBudgetMs)),
            'error'
          )
        } catch { /* A disconnect is expected while the managed service restarts. */ }
        assertRestartScope()

        if (nextHealth?.ok === true) {
          const nextIdentity = nextHealth.server_identity?.trim() || null
          const nextInstanceId = nextHealth.server_instance_id?.trim() || null
          if (nextIdentity !== expectedIdentity) {
            throw new Error(`The endpoint came back as a different server (${nextIdentity || 'unverified identity'}). AgentsDock did not reconnect this profile.`)
          }
          if (nextInstanceId && nextInstanceId !== requestedInstanceId) {
            assertRestartScope()
            const restartedScope = this.activateProfile(scope.profileId, false, true, reconnectClient)
            reconnectClientWasAdopted = true
            const adoptedScope = this.adoptHealth(restartedScope, nextHealth)
            this.setProfileRuntime(adoptedScope.profileId, {
              connectionState: connectionStateForHealth(nextHealth),
              lastConnectionError: connectionWarningForHealth(nextHealth),
              lastConnectionCheckedAt: Date.now()
            })
            this.emitConnection(adoptedScope, true, nextHealth)
            this.assertCurrentScope(adoptedScope)
            const bootstrap = this.loadCachedBootstrap(adoptedScope)
            void this.refreshAll(false, true, adoptedScope)
            // A restart is the usual way a provider CLI upgrade takes effect,
            // so refresh the model list instead of leaving the pre-restart
            // cache in place for another 15 minutes.
            void this.refreshRuntime(true, true, adoptedScope)
            return bootstrap
          }
          oldServerWasReachable = true
        }

        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        await restartDelay(Math.min(this.serverRestartPollDelayMs, remainingMs))
      }

      assertRestartScope()
      if (ambiguousRequestError) {
        throw new Error('The restart request was not confirmed, and AgentsDock could not verify a new server instance within 45 seconds. The server may still be restarting; check its service before retrying.')
      }
      if (oldServerWasReachable) {
        throw new Error('AgentsServer did not restart within 45 seconds. The same server instance is still reachable, and no second restart request was sent.')
      }
      throw new Error('Restart was requested, but AgentsDock could not reconnect to a new server instance within 45 seconds. Check the server service before retrying.')
    } finally {
      if (!reconnectClientWasAdopted) reconnectClient.dispose()
    }
  }

  async serverUpdateStatus(): Promise<ServerUpdateStatus> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const target = this.serverUpdateTarget(scope)
    const status = await scope.client.serverUpdateStatus(target)
    this.assertServerUpdateTarget(scope, target, status)
    return status
  }

  async checkServerUpdate(track?: ServerUpdateTrack): Promise<ServerUpdateStatus> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const target = this.serverUpdateTarget(scope)
    const status = await scope.client.checkServerUpdate(track, target)
    this.assertServerUpdateTarget(scope, target, status)
    return status
  }

  async startServerUpdate(version?: string, track?: ServerUpdateTrack, whenIdle = false): Promise<ServerUpdateStatus> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const target = this.serverUpdateTarget(scope, true)
    let status: ServerUpdateStatus
    try {
      status = await scope.client.startServerUpdate(version, track, whenIdle, target)
    } catch (error) {
      // Electron IPC preserves the message but not ServerError.status. Retain
      // authoritative HTTP evidence without relabeling transport failures.
      if (error instanceof ServerError) throw new Error(`HTTP ${error.status}: ${error.message}`)
      throw error
    }
    this.assertServerUpdateTarget(scope, target, status)
    return status
  }

  async cancelServerUpdate(scheduleId: string): Promise<ServerUpdateStatus> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const target = this.serverUpdateTarget(scope, true)
    const status = await scope.client.cancelServerUpdate(scheduleId, target)
    this.assertServerUpdateTarget(scope, target, status)
    return status
  }

  private serverUpdateTarget(scope: ConnectionScope, required = false): ServerUpdateTarget | undefined {
    this.assertCurrentScope(scope)
    const capabilityVersion = serverCapabilityVersion(this.health?.capabilities?.server_updates)
    if (capabilityVersion < 9) {
      if (required && !this.legacyLoopbackServerUpdateAllowed(scope, capabilityVersion)) {
        throw new Error('Update or reconnect AgentsServer before starting or canceling a managed update.')
      }
      return undefined
    }
    const profileIdentity = this.settings.getProfile(scope.profileId)?.serverIdentity?.trim() || null
    const healthIdentity = this.health?.server_identity?.trim() || null
    const serverInstanceId = this.health?.server_instance_id?.trim() || null
    if (!profileIdentity || profileIdentity !== healthIdentity || !serverInstanceId) throw staleProfileError()
    return {
      expected_server_identity: profileIdentity,
      expected_server_instance_id: serverInstanceId
    }
  }

  private legacyLoopbackServerUpdateAllowed(scope: ConnectionScope, capabilityVersion: number): boolean {
    // v2-v8 can install signed channel releases but cannot bind the mutation
    // to a server identity/boot. Keep that compatibility exception on the
    // exact HTTP loopback connection captured when this scope was activated.
    if (capabilityVersion < 2 || capabilityVersion >= 9) return false
    const capability = this.health?.capabilities?.server_updates
    if (
      !capability
      || typeof capability !== 'object'
      || Array.isArray(capability)
      || (capability as { available?: unknown }).available !== true
    ) return false
    try {
      if (this.settings.serverUrl(scope.profileId) !== scope.serverUrl) return false
      const serverURL = new URL(scope.serverUrl)
      return serverURL.protocol === 'http:' && isLoopbackHostname(serverURL.hostname)
    } catch {
      return false
    }
  }

  private assertServerUpdateTarget(
    scope: ConnectionScope,
    target: ServerUpdateTarget | undefined,
    status: ServerUpdateStatus
  ): void {
    this.assertCurrentScope(scope)
    if (!target) return
    const profileIdentity = this.settings.getProfile(scope.profileId)?.serverIdentity?.trim() || null
    if (
      profileIdentity !== target.expected_server_identity
      || this.health?.server_identity?.trim() !== target.expected_server_identity
      || this.health?.server_instance_id?.trim() !== target.expected_server_instance_id
    ) throw staleProfileError()
    if (
      status.server_identity !== target.expected_server_identity
      || status.server_instance_id !== target.expected_server_instance_id
    ) {
      throw new Error('AgentsServer returned update state for a different server instance. Refresh Settings before retrying.')
    }
  }

  async codexServerGoals(): Promise<CodexGoalsConfiguration> {
    return this.codexRequest(async scope => {
      try {
        return await scope.client.codexServerGoals()
      } catch (error) {
        if (error instanceof ServerError && [404, 405, 501].includes(error.status)) {
          return unsupportedCodexGoalsConfiguration()
        }
        throw error
      }
    })
  }

  async setCodexServerGoals(enabled: boolean): Promise<CodexGoalsConfiguration> {
    return this.codexRequest(async scope => {
      try {
        return await scope.client.setCodexServerGoals(enabled)
      } catch (error) {
        if (error instanceof ServerError && [404, 405, 501].includes(error.status)) {
          return unsupportedCodexGoalsConfiguration()
        }
        throw error
      }
    })
  }

  async listSessions(): Promise<Session[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const sessions = mergePolledSessionSummaries(this.sessions, await scope.client.sessions())
    this.assertCurrentScope(scope)
    this.disposeUnavailablePortTunnels(this.sessions, sessions)
    this.sessions = sessions
    this.cache.putSessions(scope.namespace, sessions)
    this.scheduleSearchBackfill()
    this.emitSessions(scope, sessions)
    this.refreshProfileUnread(scope)
    return sessions
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const session = await scope.client.createSession(input)
    this.assertCurrentScope(scope)
    this.upsertSession(scope, session)
    return session
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const session = await scope.client.createSession(input)
    this.assertCurrentScope(scope)
    this.upsertSession(scope, session)
    return session
  }

  async listLocalSessions(): Promise<LocalSessionCandidate[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const capability = requireLocalSessionImportCapability(this.health)
    const candidates = await scope.client.listLocalSessions(localSessionImportListLimit(capability))
    this.assertCurrentScope(scope)
    return candidates
  }

  async bulkImportSessions(items: BulkImportSessionItem[]): Promise<BulkImportSessionResult[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const capability = requireLocalSessionImportCapability(this.health)
    const normalized = parseBulkImportSessionItems(items, localSessionImportListLimit(capability))
    const batchLimit = localSessionImportBatchLimit(capability)
    const results: BulkImportSessionResult[] = []
    for (let offset = 0; offset < normalized.length; offset += batchLimit) {
      const batch = normalized.slice(offset, offset + batchLimit)
      try {
        results.push(...await scope.client.bulkImportSessions(batch))
        this.assertCurrentScope(scope)
      } catch (error) {
        this.assertCurrentScope(scope)
        const detail = errorText(error)
        results.push(...batch.map(item => ({
          provider_session_id: item.provider_session_id,
          backend: item.backend,
          session_id: null,
          ok: false,
          imported: 0,
          code: 'client_status_unknown',
          error: `Import status could not be confirmed: ${detail}. Re-scan local chats before retrying.`
        })))
        results.push(...normalized.slice(offset + batch.length).map(item => ({
          provider_session_id: item.provider_session_id,
          backend: item.backend,
          session_id: null,
          ok: false,
          imported: 0,
          code: 'client_not_attempted',
          error: 'Not attempted because the previous batch status could not be confirmed. Re-scan local chats, then retry this item.'
        })))
        break
      }
    }
    if (results.some(result => result.ok)) {
      try {
        await this.listSessions()
      } catch (error) {
        // The import acknowledgement is authoritative. A secondary cache
        // refresh failure must not turn durable per-item successes into a
        // failed import or invite an unsafe duplicate retry.
        this.assertCurrentScope(scope)
        appLog('local-session-import', 'session refresh failed after an import was acknowledged', {
          error: errorText(error)
        })
      }
    }
    return results
  }

  async updateSession(sessionId: string, patch: UpdateSessionInput): Promise<Session> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const session = await scope.client.updateSession(sessionId, patch)
    this.assertCurrentScope(scope)
    if (session.archived) {
      this.disconnectTerminal(sessionId)
      this.portTunnels.disposeSession(sessionId)
    }
    this.upsertSession(scope, session)
    return session
  }

  async reloadProvider(sessionId: string): Promise<ProviderReloadResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.reloadProvider(sessionId)
    this.assertCurrentScope(scope)
    this.upsertSession(scope, result.session)
    return result
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const removed = await scope.client.deleteSession(sessionId)
    this.assertCurrentScope(scope)
    if (removed) {
      this.portTunnels.disposeSession(sessionId)
      this.sessions = this.sessions.filter(session => session.id !== sessionId)
      this.cache.removeSession(scope.namespace, sessionId)
      this.emitSessions(scope, this.sessions)
      this.refreshProfileUnread(scope)
    }
    return removed
  }

  async forkSession(sessionId: string): Promise<Session> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const response = await scope.client.forkSession(sessionId)
    this.assertCurrentScope(scope)
    if (response.sessions) this.sessions = response.sessions
    else this.sessions = insertAfter(this.sessions, response.session, sessionId)
    this.cache.putSessions(scope.namespace, this.sessions)
    this.emitSessions(scope, this.sessions)
    return response.session
  }

  async reorderSession(sessionId: string, relativeTo: string, placement: 'before' | 'after', targetFolder?: string): Promise<Session[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const sessions = await scope.client.reorderSession(sessionId, relativeTo, placement, targetFolder)
    this.assertCurrentScope(scope)
    this.sessions = sessions
    this.cache.putSessions(scope.namespace, sessions)
    this.emitSessions(scope, this.sessions)
    return this.sessions
  }

  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    const scope = this.captureScope()
    return this.withSessionReadMutation(scope, sessionId, async () => {
      await this.ensureValidatedScope(scope)
      const receipt = await scope.client.markRead(sessionId, seq)
      this.assertCurrentScope(scope)
      return this.applyReadStateReceipt(scope, sessionId, receipt)
    })
  }

  async markUnread(sessionId: string): Promise<Session> {
    const scope = this.captureScope()
    return this.withSessionReadMutation(scope, sessionId, async () => {
      await this.ensureValidatedScope(scope)
      const receipt = await scope.client.markUnread(sessionId)
      this.assertCurrentScope(scope)
      return this.applyReadStateReceipt(scope, sessionId, receipt)
    })
  }

  async acknowledgeEmergency(sessionId: string, alertId: string): Promise<Session> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const session = await scope.client.acknowledgeEmergency(sessionId, alertId)
    this.assertCurrentScope(scope)
    this.upsertSession(scope, session)
    return session
  }

  async importHistory(sessionId: string, force = false): Promise<TimelinePage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const page = await scope.client.importHistory(sessionId, force)
    this.assertCurrentScope(scope)
    this.cache.putSession(scope.namespace, page.session)
    this.cache.putEvents(scope.namespace, sessionId, page.events)
    this.cache.putTimelineState(
      scope.namespace,
      sessionId,
      Boolean(page.has_more),
      page.latest_seq,
      page.total,
      timelinePageNextBefore(page),
      semanticAttemptSucceeded(page)
    )
    return page
  }

  async openTimeline(sessionId: string, forceRemote = false): Promise<SessionSnapshot> {
    const scope = this.captureScope()
    const lease = this.beginTimelineSubscription(scope, sessionId)
    this.emitSync(scope, sessionId, 'syncing')
    const cached = this.cache.snapshot(scope.namespace, sessionId)
    const cachedLast = this.cache.latestEventSequence(scope.namespace, sessionId)
    if (cached && !forceRemote) {
      queueMicrotask(() => void this.reconcileTimelineAndStream(scope, sessionId, cachedLast, lease))
      return cached
    }
    try {
      return await this.fetchTimeline(scope, sessionId, lease)
    } catch (error) {
      this.finishTimelineInitialization(sessionId, lease)
      throw error
    }
  }

  cachedTimeline(sessionId: string): SessionSnapshot | null {
    const scope = this.captureScope()
    return this.cache.snapshot(scope.namespace, sessionId)
  }

  private async semanticTimelinePage(
    scope: ConnectionScope,
    sessionId: string,
    options: Omit<SessionPageOptions, 'pageMode'>
  ): Promise<TimelinePage> {
    const semantic = await scope.client.sessionPage(sessionId, {
      ...options,
      pageMode: 'semantic'
    })
    if (semanticAttemptSucceeded(semantic)) {
      this.recordSemanticTimelineCapability(scope, true)
      return semantic
    }
    const legacy = await scope.client.sessionPage(sessionId, {
      ...options,
      limit: Math.max(LEGACY_TIMELINE_EVENT_LIMIT, options.limit ?? 0)
    })
    this.recordSemanticTimelineCapability(scope, false)
    return {
      ...await this.restoreLegacyTurnBoundary(scope, sessionId, legacy, options),
      semantic_paging: false
    }
  }

  private serverVersionForScope(scope: ConnectionScope): string | null {
    return this.cache.preference(scope.namespace, SERVER_VERSION_CACHE_KEY, null as string | null)
  }

  private absoluteFileWritesAvailable(): boolean {
    return Number(this.health?.capabilities?.workspace_files?.version ?? 0) >= 6
  }

  private recordSemanticTimelineCapability(scope: ConnectionScope, supported: boolean): void {
    this.cache.putPreference<SemanticTimelineCapability>(
      scope.namespace,
      SEMANTIC_TIMELINE_CAPABILITY_CACHE_KEY,
      { serverVersion: this.serverVersionForScope(scope), supported }
    )
  }

  private semanticTimelineCapabilityChanged(scope: ConnectionScope): boolean {
    const capability = this.cache.preference<SemanticTimelineCapability | null>(
      scope.namespace,
      SEMANTIC_TIMELINE_CAPABILITY_CACHE_KEY,
      null
    )
    return !capability || capability.serverVersion !== this.serverVersionForScope(scope)
  }

  private async restoreLegacyTurnBoundary(
    scope: ConnectionScope,
    sessionId: string,
    page: TimelinePage,
    options: Omit<SessionPageOptions, 'pageMode'>
  ): Promise<TimelinePage> {
    if (options.tail === false || (options.after ?? 0) > 0 || !page.has_more) return page
    const runId = incompleteLeadingRunId(page.events)
    let before = page.before ?? page.events[0]?.seq ?? null
    if (!runId || before == null) return page

    for (let attempt = 0; attempt < LEGACY_BOUNDARY_BACKFILL_MAX_PAGES; attempt += 1) {
      const older = await scope.client.sessionPage(sessionId, {
        before,
        limit: LEGACY_BOUNDARY_BACKFILL_EVENT_LIMIT,
        tail: true,
        visible: true,
        compact: true
      })
      const start = older.events.find(event => (
        event.type === 'turn_started'
        && event.run_id?.trim() === runId
      ))
      if (start) {
        appLog('timeline', 'restored legacy page turn boundary', {
          sessionId,
          runId,
          startSeq: start.seq,
          pageStartSeq: before
        })
        return { ...page, events: mergeEventsBySequence([start], page.events) }
      }

      const containsRun = older.events.some(event => event.run_id?.trim() === runId)
      const nextBefore = older.before ?? older.events[0]?.seq ?? null
      if (!containsRun || nextBefore == null || nextBefore >= before || !older.has_more) break
      before = nextBefore
    }
    return page
  }

  async historicalOlderTimeline(
    sessionId: string,
    before: number,
    limit = HISTORY_PAGE_SEMANTIC_ITEM_LIMIT
  ): Promise<TimelinePage> {
    return this.olderTimeline(sessionId, before, limit, false)
  }

  async olderTimeline(
    sessionId: string,
    before: number,
    limit = HISTORY_PAGE_SEMANTIC_ITEM_LIMIT,
    persistLiveCache = true
  ): Promise<TimelinePage> {
    const scope = this.captureScope()
    const timeline = this.cache.timelineState(scope.namespace, sessionId)
    try {
      await this.ensureValidatedScope(scope)
      const page = await this.semanticTimelinePage(scope, sessionId, {
        before,
        limit,
        tail: true,
        visible: true
      })
      this.assertCurrentScope(scope)
      const nextBefore = timelinePageNextBefore(page)
      if (persistLiveCache) {
        this.cache.putSession(scope.namespace, page.session)
        this.cache.putEvents(scope.namespace, sessionId, page.events)
        this.cache.putTimelineState(
          scope.namespace,
          sessionId,
          Boolean(page.has_more),
          page.latest_seq,
          undefined,
          nextBefore,
          page.semantic_paging === false ? false : semanticAttemptSucceeded(page)
        )
      }
      return {
        ...page,
        next_before: nextBefore,
        next_semantic_before: page.semantic_paging === false ? null : nextBefore,
        total: page.total ?? timeline?.knownTotal ?? null
      }
    } catch (error) {
      if (!this.isCurrentScope(scope)) throw error
      const localSession = this.sessions.find(session => session.id === sessionId)
        ?? this.cache.session(scope.namespace, sessionId)
      if (!localSession) throw error
      const raw = this.cache.rawEventsBefore(
        scope.namespace,
        sessionId,
        before,
        Math.max(LEGACY_TIMELINE_EVENT_LIMIT, limit)
      )
      if (raw.windowStartSeq == null) throw error
      const fallbackCursor = raw.nextBefore
        ?? (timeline?.hasMore ? raw.windowStartSeq : null)
      const fallbackHasMore = fallbackCursor != null
        && Boolean(raw.hasMore || timeline?.hasMore)
      return {
        session: localSession,
        events: raw.events,
        queued_turns: this.cache.queuedTurns(scope.namespace, sessionId),
        has_more: fallbackHasMore,
        before: raw.windowStartSeq,
        next_before: fallbackCursor,
        total: timeline?.knownTotal ?? null,
        latest_seq: timeline?.verifiedLatestSeq ?? null,
        semantic_paging: false
      }
    }
  }

  async timelineAround(sessionId: string, anchorSeq: number, limit = HISTORY_PAGE_SEMANTIC_ITEM_LIMIT): Promise<TimelinePage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const boundedLimit = Math.max(40, Math.min(HISTORY_AROUND_EVENT_LIMIT, limit))
    const olderLimit = Math.floor(boundedLimit / 2)
    const newerLimit = boundedLimit - olderLimit
    const [older, newer] = await Promise.all([
      this.semanticTimelinePage(scope, sessionId, {
        before: anchorSeq, limit: olderLimit, tail: true, visible: true
      }),
      this.semanticTimelinePage(scope, sessionId, {
        after: Math.max(0, anchorSeq - 1), limit: newerLimit, tail: false, visible: true
      })
    ])
    this.assertCurrentScope(scope)
    const events = mergeEventsBySequence(older.events, newer.events)
    const timeline = this.cache.timelineState(scope.namespace, sessionId)
    return {
      session: newer.session ?? older.session,
      events,
      queued_turns: newer.queued_turns ?? older.queued_turns ?? [],
      has_more: Boolean(older.has_more),
      before: events[0]?.seq ?? null,
      next_before: timelinePageNextBefore(older),
      total: timeline?.knownTotal ?? null,
      latest_seq: timeline?.verifiedLatestSeq ?? newer.latest_seq ?? older.latest_seq ?? null,
      events_omitted_before: older.events_omitted_before ?? 0,
      events_omitted_after: newer.events_omitted_after ?? 0,
      semantic_item_count: (older.semantic_item_count ?? older.events.length)
        + (newer.semantic_item_count ?? newer.events.length),
      semantic_total: Math.max(older.semantic_total ?? 0, newer.semantic_total ?? 0) || null,
      semantic_omitted_before: older.semantic_omitted_before ?? null,
      semantic_omitted_after: newer.semantic_omitted_after ?? null,
      next_semantic_before: timelinePageNextBefore(older),
      semantic_paging: older.semantic_paging !== false
        && newer.semantic_paging !== false
        && semanticAttemptSucceeded(older)
        && semanticAttemptSucceeded(newer)
    }
  }

  async timelineTrace(
    sessionId: string,
    runId: string,
    anchorSeq: number,
    after = 0,
    limit = TRACE_DETAIL_EVENT_LIMIT
  ): Promise<TimelineTracePage> {
    const normalizedRunId = String(runId ?? '').trim()
    if (!normalizedRunId) return { events: [], has_more: false, next_after: null }
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const normalizedAfter = Number.isFinite(after) ? Math.floor(after) : 0
    try {
      const direct = await scope.client.runTrace(
        sessionId,
        normalizedRunId,
        anchorSeq,
        normalizedAfter,
        limit
      )
      this.assertCurrentScope(scope)
      return direct
    } catch (error) {
      if (!this.isCurrentScope(scope)) throw staleProfileError()
      // The additive direct trace endpoint is required for scheduled runs,
      // whose turn landmarks are intentionally folded into one job landmark.
      // Older servers return 404; ordinary turns retain the established
      // landmark-based fallback below.
      if (!(error instanceof ServerError) || error.status !== 404) throw error
    }
    const refreshedInitially = normalizedAfter <= 0
    let index = refreshedInitially
      ? await scope.client.timelineIndex(sessionId)
      : await this.timelineIndex(sessionId)
    this.assertCurrentScope(scope)
    if (refreshedInitially) {
      this.timelineIndexes.set(`${scope.namespace}:${sessionId}`, index)
    }
    const baseKey = `turn:${normalizedRunId}`
    const normalizedAnchor = Number.isFinite(anchorSeq)
      ? Math.max(0, Math.floor(anchorSeq))
      : 0
    const matchingLandmarks = () => index.landmarks.filter(candidate => (
      candidate.key === baseKey || candidate.key.startsWith(`${baseKey}:start-`)
    ))
    const anchoredLandmark = (candidates: TimelineIndex['landmarks']) => (
      normalizedAnchor > 0
        ? candidates
            .filter(candidate => (
              candidate.start_seq <= normalizedAnchor
              && candidate.end_seq >= normalizedAnchor
            ))
            .sort((left, right) => (
              right.start_seq - left.start_seq
              || left.end_seq - right.end_seq
            ))[0]
        : undefined
    )
    let candidates = matchingLandmarks()
    let landmark = anchoredLandmark(candidates)
    if (
      !refreshedInitially
      && (!candidates.length || (normalizedAnchor > 0 && !landmark))
    ) {
      index = await scope.client.timelineIndex(sessionId)
      this.assertCurrentScope(scope)
      this.timelineIndexes.set(`${scope.namespace}:${sessionId}`, index)
      candidates = matchingLandmarks()
      landmark = anchoredLandmark(candidates)
    }
    landmark ??= candidates.find(candidate => candidate.key === baseKey) ?? candidates.at(-1)
    if (!landmark) throw new Error('The complete trace is not available in this chat history.')

    const start = Math.max(1, landmark.start_seq)
    const end = Math.max(start, landmark.end_seq)
    const cursor = Math.max(start - 1, Math.min(normalizedAfter, end))
    if (cursor >= end) return { events: [], has_more: false, next_after: cursor }
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : TRACE_DETAIL_EVENT_LIMIT
    const boundedLimit = Math.max(20, Math.min(1_000, normalizedLimit))
    const page = await scope.client.sessionPage(sessionId, {
      after: cursor,
      before: end + 1,
      limit: boundedLimit,
      tail: false,
      visible: true,
      compact: false
    })
    this.assertCurrentScope(scope)
    const scannedThrough = page.events.at(-1)?.seq ?? cursor
    const events = page.events.filter(event => (
      event.session_id === sessionId
      && event.run_id?.trim() === normalizedRunId
      && TRACE_DETAIL_EVENT_TYPES.has(event.type)
    ))
    const hasMore = scannedThrough > cursor
      && scannedThrough < end
      && (page.events_omitted_after ?? 0) > 0
    return {
      events,
      has_more: hasMore,
      next_after: scannedThrough
    }
  }

  async timelineIndex(sessionId: string): Promise<TimelineIndex> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const key = `${scope.namespace}:${sessionId}`
    const cached = this.timelineIndexes.get(key)
    const session = this.sessions.find(candidate => candidate.id === sessionId)
    const expectedLatest = session?.latest_event_seq ?? 0
    if (cached && cached.latest_seq >= expectedLatest) return cached
    const index = await scope.client.timelineIndex(sessionId)
    this.assertCurrentScope(scope)
    this.timelineIndexes.set(key, index)
    return index
  }

  async codeDiff(sessionId: string, runId: string): Promise<string> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const diff = await scope.client.codeDiff(sessionId, runId)
    this.assertCurrentScope(scope)
    return diff
  }

  async searchTimeline(sessionId: string, query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const clean = query.trim()
    if (clean.length < 2) return []
    const scope = this.captureScope()
    const local = this.cache.searchEvents(scope.namespace, sessionId, clean, limit)
    try {
      await this.ensureValidatedScope(scope)
      const remote = await scope.client.searchTimeline(sessionId, clean, limit)
      this.assertCurrentScope(scope)
      return mergeTimelineSearchResults(remote, local, limit, false)
    } catch (error) {
      if (!this.isCurrentScope(scope)) throw staleProfileError()
      appLog('search', 'server history search unavailable; using local cache', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return local
    }
  }

  async searchSessions(query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const clean = query.trim()
    if (clean.length < 2) return []
    const scope = this.captureScope()
    const activeSessionIds = new Set(this.sessions.filter(session => !session.archived).map(session => session.id))
    const local = this.cache.searchSessions(scope.namespace, clean, limit)
      .filter(result => activeSessionIds.has(result.session_id))
    try {
      await this.ensureValidatedScope(scope)
      const remote = (await scope.client.searchSessions(clean, limit))
        .filter(result => activeSessionIds.has(result.session_id))
      this.assertCurrentScope(scope)
      return mergeTimelineSearchResults(remote, local, limit, true)
    } catch (error) {
      if (!this.isCurrentScope(scope)) throw staleProfileError()
      appLog('search', 'server-wide history search unavailable; using local cache', {
        error: error instanceof Error ? error.message : String(error)
      })
      return local
    }
  }

  searchAllProfileSessions(query: string, limit = 100): ProfileSessionSearchResult[] {
    const clean = query.trim()
    if (clean.length < 2) return []
    const profiles = this.settings.listProfiles()
    const ordered = [
      ...profiles.filter(profile => profile.id === this.activeProfileId),
      ...profiles.filter(profile => profile.id !== this.activeProfileId)
    ]
    const profileByNamespace = new Map(ordered.map(profile => [profileNamespace(profile), profile]))
    return this.cache.searchAllSessions([...profileByNamespace.keys()], clean, limit).flatMap(result => {
      const profile = profileByNamespace.get(result.serverId)
      if (!profile) return []
      return [{
        profileId: profile.id,
        profileName: profile.name,
        serverIdentity: profile.serverIdentity,
        session: result.session,
        source: result.source,
        history: result.history
      }]
    })
  }

  private backfillSearchIndex(): void {
    this.searchBackfillTimer = null
    const started = Date.now()
    try {
      const processed = this.cache.backfillSearchIndexBatch(SEARCH_BACKFILL_BATCH_SIZE)
      const durationMs = Date.now() - started
      if (durationMs >= 50) appLog('performance', 'search backfill batch was slow', { durationMs, processed })
      if (processed > 0) this.scheduleSearchBackfill(SEARCH_BACKFILL_BATCH_DELAY_MS)
    } catch (error) {
      appLog('search', 'local history index backfill paused', {
        error: error instanceof Error ? error.message : String(error)
      })
      this.scheduleSearchBackfill(5_000)
    }
  }

  private scheduleSearchBackfill(delay = 25): void {
    if (this.searchBackfillTimer || this.cache.searchBackfillComplete()) return
    this.searchBackfillTimer = setTimeout(() => this.backfillSearchIndex(), delay)
  }

  private ensureEmergencyStream(scope: ConnectionScope, health: Health): void {
    const capability = health.capabilities?.agent_emergency_alerts_v1
    const serverIdentity = health.server_identity?.trim() || null
    const supported = Boolean(
      capability
      && typeof capability === 'object'
      && !Array.isArray(capability)
      && capability.available === true
      && typeof capability.version === 'number'
      && capability.version >= 1
      && serverIdentity
    )
    if (!supported) {
      this.stopEmergencyStream()
      return
    }
    if (
      this.emergencyStreamStop
      && this.emergencyStreamGeneration === scope.generation
      && this.emergencyStreamServerIdentity === serverIdentity
    ) return
    this.stopEmergencyStream()
    const stop = scope.client.emergencyStream(serverIdentity!, (incoming, snapshot, removedSessionId) => {
      if (!this.isCurrentScope(scope) || !this.isValidatedScope(scope)) return
      let sessions: Session[]
      if (removedSessionId) {
        sessions = this.sessions.filter(session => session.id !== removedSessionId)
      } else if (snapshot) {
        sessions = reconcileEmergencySnapshot(this.sessions, incoming)
      } else {
        const update = incoming[0]
        if (!update) return
        const existing = this.sessions.find(session => session.id === update.id)
        const merged = mergeSessionSummaries(existing ? [existing] : [], [update])[0]
        sessions = existing
          ? this.sessions.map(session => session.id === merged.id ? merged : session)
          : [...this.sessions, merged]
      }
      this.disposeUnavailablePortTunnels(this.sessions, sessions)
      if (jsonEqual(this.sessions, sessions)) return
      this.sessions = sessions
      this.cache.putSessions(scope.namespace, sessions)
      this.emitSessions(scope, sessions)
      this.refreshProfileUnread(scope)
    }, (connected, error) => {
      if (!this.isCurrentScope(scope)) return
      if (!connected && error) appLog('emergency-alerts', 'live alert stream reconnecting', {
        profileId: scope.profileId,
        error
      })
    })
    if (!this.isCurrentScope(scope)) {
      stop()
      return
    }
    this.emergencyStreamStop = stop
    this.emergencyStreamGeneration = scope.generation
    this.emergencyStreamServerIdentity = serverIdentity
  }

  private stopEmergencyStream(): void {
    const stop = this.emergencyStreamStop
    this.emergencyStreamStop = null
    this.emergencyStreamGeneration = null
    this.emergencyStreamServerIdentity = null
    stop?.()
  }

  private ensureInactiveEmergencyStream(
    profileId: string,
    revision: number,
    health: Health,
    serverIdentity: string,
    accessToken: string
  ): void {
    const capability = health.capabilities?.agent_emergency_alerts_v1
    const supported = Boolean(capability?.available === true && capability.version >= 1)
    const profile = this.settings.getProfile(profileId)
    if (
      !supported
      || !profile
      || profileId === this.activeProfileId
      || (this.profileHealthProbeRevision.get(profileId) ?? 0) !== revision
      || (profile.serverIdentity?.trim() || null) !== serverIdentity
    ) {
      this.stopInactiveEmergencyStream(profileId)
      return
    }
    const namespace = profileNamespace(profile)
    const existing = this.inactiveEmergencyStreams.get(profileId)
    if (
      existing
      && existing.revision === revision
      && existing.serverIdentity === serverIdentity
      && existing.namespace === namespace
    ) return
    this.stopInactiveEmergencyStream(profileId)

    const client = this.clientFactory(
      this.settings.serverUrl(profileId),
      accessToken,
    )
    const seenAlertIds = new Set<string>()
    for (const session of this.cache.sessions(namespace)) {
      const alertId = session.emergency_alert?.status === 'active'
        ? session.emergency_alert.id
        : ''
      if (alertId) rememberEmergencyAlertId(seenAlertIds, alertId)
    }
    let stopTransport = (): void => undefined
    const record: InactiveEmergencyStream = {
      client,
      revision,
      serverIdentity,
      namespace,
      seenAlertIds,
      stop: () => {
        stopTransport()
        client.dispose()
      }
    }
    this.inactiveEmergencyStreams.set(profileId, record)
    try {
      stopTransport = client.emergencyStream(serverIdentity, (incoming, snapshot, removedSessionId) => {
        if (this.inactiveEmergencyStreams.get(profileId) !== record) return
        const currentProfile = this.settings.getProfile(profileId)
        if (
          !currentProfile
          || profileId === this.activeProfileId
          || (this.profileHealthProbeRevision.get(profileId) ?? 0) !== revision
          || (currentProfile.serverIdentity?.trim() || null) !== serverIdentity
          || profileNamespace(currentProfile) !== namespace
        ) {
          this.stopInactiveEmergencyStream(profileId)
          return
        }
        const previous = this.cache.sessions(namespace)
        let sessions: Session[]
        if (removedSessionId) {
          sessions = previous.filter(session => session.id !== removedSessionId)
        } else if (snapshot) {
          sessions = reconcileEmergencySnapshot(previous, incoming)
        } else {
          const update = incoming[0]
          if (!update) return
          const current = previous.find(session => session.id === update.id)
          const merged = mergeSessionSummaries(current ? [current] : [], [update])[0]
          sessions = current
            ? previous.map(session => session.id === merged.id ? merged : session)
            : [...previous, merged]
        }
        if (!jsonEqual(previous, sessions)) this.cache.putSessions(namespace, sessions)
        for (const session of sessions) {
          const alert = session.emergency_alert
          if (
            !alert
            || alert.status !== 'active'
            || alert.severity !== 'critical'
            || !/^emergency_[0-9a-f]{32}$/.test(alert.id)
            || !alert.message.trim()
            || seenAlertIds.has(alert.id)
          ) continue
          rememberEmergencyAlertId(seenAlertIds, alert.id)
          this.showProfileNotification({
            title: `EMERGENCY · ${session.title}`,
            body: alert.message,
            profileId,
            serverIdentity,
            sessionId: session.id,
            emergencyAlertId: alert.id
          })
        }
        const unreadCount = this.cache.serverSummary(namespace).unreadCount
        this.setProfileRuntime(profileId, { cachedUnreadCount: unreadCount })
        this.emitProfiles()
      }, (connected, error) => {
        if (this.inactiveEmergencyStreams.get(profileId) !== record) return
        if (!connected && error === 'Emergency alert stream server identity changed') {
          this.stopInactiveEmergencyStream(profileId)
          this.setProfileRuntime(profileId, {
            connectionState: 'offline',
            lastConnectionError: error,
            lastConnectionCheckedAt: Date.now()
          })
          this.emitProfiles()
          return
        }
        if (!connected && error) appLog('emergency-alerts', 'inactive server alert stream reconnecting', {
          profileId,
          error
        })
      })
    } catch (error) {
      if (this.inactiveEmergencyStreams.get(profileId) === record) {
        this.inactiveEmergencyStreams.delete(profileId)
      }
      client.dispose()
      appLog('emergency-alerts', 'could not start inactive server alert stream', {
        profileId,
        error: errorText(error)
      })
    }
  }

  private stopInactiveEmergencyStream(profileId: string): void {
    const record = this.inactiveEmergencyStreams.get(profileId)
    if (!record) return
    this.inactiveEmergencyStreams.delete(profileId)
    record.stop()
  }

  private stopAllInactiveEmergencyStreams(): void {
    const records = [...this.inactiveEmergencyStreams.values()]
    this.inactiveEmergencyStreams.clear()
    let firstError: unknown
    for (const record of records) firstError = attemptCleanup(firstError, record.stop)
    if (firstError) throw firstError
  }

  async subscribeTimeline(sessionId: string, after: number): Promise<void> {
    const scope = this.captureScope()
    const lease = this.beginTimelineSubscription(scope, sessionId)
    this.emitSync(scope, sessionId, 'syncing')
    queueMicrotask(() => void this.reconcileTimelineAndStream(scope, sessionId, after, lease))
  }

  private beginTimelineSubscription(scope: ConnectionScope, sessionId: string): number {
    this.assertCurrentScope(scope)
    this.stopTimelineSubscription(sessionId)
    if (this.timelineSubscriptions.size >= MAX_TIMELINE_SUBSCRIPTIONS) {
      const oldestSessionId = this.timelineSubscriptions.keys().next().value as string | undefined
      if (oldestSessionId) {
        this.stopTimelineSubscription(oldestSessionId)
        this.emitSync(scope, oldestSessionId, 'idle')
      }
    }
    const lease = ++this.timelineLeaseSequence
    this.timelineSubscriptions.set(sessionId, { lease, stop: null, connected: false, initializing: true })
    return lease
  }

  private activateTimelineStream(scope: ConnectionScope, sessionId: string, after: number, lease: number): void {
    if (!this.isCurrentTimeline(scope, sessionId, lease)) return
    const subscription = this.timelineSubscriptions.get(sessionId)
    if (!subscription) return
    const previousStop = subscription.stop
    subscription.stop = null
    subscription.connected = false
    subscription.initializing = false
    previousStop?.()
    const stop = scope.client.stream(sessionId, after, event => {
      if (!this.isCurrentTimeline(scope, sessionId, lease)) return
      const subagentState = this.subagentProjector.project(event)
      if (event.type === 'raw_event') {
        if (subagentState) this.emitAgentEvent(scope, subagentState)
        return
      }
      this.emitAgentEvent(scope, event)
      this.enqueueEventCache(scope, event)
      if (JOB_REFRESH_EVENT_TYPES.has(event.type) && !isImportedProviderControlMetadata(event)) void this.refreshJobs(scope)
    }, (connected, error) => {
      if (!this.isCurrentTimeline(scope, sessionId, lease)) return
      const current = this.timelineSubscriptions.get(sessionId)
      if (!current) return
      current.connected = connected
      this.emitSync(scope, sessionId, connected ? 'live' : 'reconnecting', error)
      if (connected) void this.refreshPinsFromNotice(scope, sessionId)
    }, event => {
      if (!this.isCurrentTimeline(scope, sessionId, lease)) return
      this.emitProviderRuntimeChanged(scope, event)
    }, event => {
      if (!this.isCurrentTimeline(scope, sessionId, lease)) return
      void this.refreshPinsFromNotice(scope, sessionId, event.revision)
    })
    const current = this.timelineSubscriptions.get(sessionId)
    if (current?.lease === lease) current.stop = stop
    else stop()
  }

  unsubscribeTimeline(sessionId: string): void {
    this.stopTimelineSubscription(sessionId)
    this.emitSync(this.captureScope(), sessionId, 'idle')
  }

  private stopTimelineSubscription(sessionId: string): boolean {
    const subscription = this.timelineSubscriptions.get(sessionId)
    if (!subscription) return false
    this.timelineSubscriptions.delete(sessionId)
    subscription.stop?.()
    return true
  }

  private closeAllTimelineSubscriptions(): void {
    const subscriptions = [...this.timelineSubscriptions.values()]
    this.timelineSubscriptions.clear()
    let firstError: unknown
    for (const subscription of subscriptions) {
      try { subscription.stop?.() }
      catch (error) { firstError ??= error }
    }
    if (firstError) throw firstError
  }

  private suspendTimelineSubscriptions(): void {
    const subscriptions = [...this.timelineSubscriptions]
    for (const [sessionId, subscription] of subscriptions) {
      this.timelineSubscriptions.set(sessionId, {
        lease: ++this.timelineLeaseSequence,
        stop: null,
        connected: false,
        initializing: false
      })
      subscription.stop?.()
    }
  }

  private renewTimelineSubscription(sessionId: string): number | null {
    const subscription = this.timelineSubscriptions.get(sessionId)
    if (!subscription) return null
    const lease = ++this.timelineLeaseSequence
    this.timelineSubscriptions.set(sessionId, { lease, stop: null, connected: false, initializing: true })
    subscription.stop?.()
    return lease
  }

  private finishTimelineInitialization(sessionId: string, lease: number): void {
    const subscription = this.timelineSubscriptions.get(sessionId)
    if (subscription?.lease === lease) subscription.initializing = false
  }

  private hasConnectedTimelineSubscription(): boolean {
    return [...this.timelineSubscriptions.values()].some(subscription => subscription.connected)
  }

  viewState(expected: WorkspaceProfileScope, sessionId: string): ViewState | null { return this.cache.viewState(this.requireWorkspaceScope(expected).namespace, sessionId) }
  saveViewState(expected: WorkspaceProfileScope, state: ViewState): void { this.cache.putViewState(this.requireWorkspaceScope(expected).namespace, state) }

  async sendTurn(input: SendTurnInput): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    assertLocalAgentChatReferences(input.chatReferences)
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const response = await scope.client.sendTurn(
      input.sessionId,
      input.prompt,
      input.fileIds,
      input.model,
      input.effort,
      input.clientCapabilities ?? ['codex_interactive_v1'],
      input.chatReferences ?? [],
      input.teamReferences ?? [],
      input.skillSelection
    )
    this.assertCurrentScope(scope)
    this.upsertSession(scope, response.session)
    if (response.event) {
      this.cache.putEvents(scope.namespace, input.sessionId, [response.event])
      this.applyEventToCaches(scope, response.event)
    }
    return response
  }

  async providerCommands(sessionId: string, refresh = false): Promise<ProviderCommandsSnapshot> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    try {
      const snapshot = await scope.client.providerCommands(sessionId, refresh)
      this.assertCurrentScope(scope)
      return snapshot
    } catch (error) {
      this.assertCurrentScope(scope)
      if (error instanceof ServerError && [404, 405, 501].includes(error.status)) {
        const backend = this.sessions.find(session => session.id === sessionId)?.backend ?? 'codex'
        return {
          backend,
          revision: 'unsupported',
          support: { available: false, mode: 'unsupported' },
          commands: []
        }
      }
      throw error
    }
  }

  async stopTurn(sessionId: string): Promise<TurnStopResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.stopTurn(sessionId)
    this.assertCurrentScope(scope)
    return result
  }

  async codexRuntime(sessionId: string): Promise<CodexRuntimeSnapshot> {
    return this.codexRequest(scope => scope.client.codexRuntime(sessionId))
  }

  async loadCodexThread(sessionId: string): Promise<CodexRuntimeSnapshot> {
    const scope = this.captureScope()
    const key = `${scope.namespace}:${scope.generation}:${sessionId}`
    const existing = this.codexThreadLoads.get(key)
    if (existing) return existing
    const request = this.codexRequest(async requestScope => {
      try {
        return await requestScope.client.loadCodexThread(sessionId)
      } catch (error) {
        // Loading is an additive API. Older API-v9 servers can still provide
        // the observational snapshot and will lazily resume on the next turn.
        if (error instanceof ServerError && [404, 405, 501].includes(error.status)) {
          return requestScope.client.codexRuntime(sessionId)
        }
        throw error
      }
    })
    this.codexThreadLoads.set(key, request)
    void request.finally(() => {
      if (this.codexThreadLoads.get(key) === request) this.codexThreadLoads.delete(key)
    }).catch(() => undefined)
    return request
  }

  async resolveCodexInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>
  ): Promise<CodexPendingInteraction> {
    return this.codexRequest(scope => scope.client.resolveCodexInteraction(
      sessionId,
      interactionId,
      response
    ))
  }

  async claudeRuntime(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.providerRequest(scope => scope.client.claudeRuntime(sessionId))
  }

  async refreshClaudeContextUsage(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.providerRequest(scope => scope.client.refreshClaudeContextUsage(sessionId))
  }

  async claudeMcp(sessionId: string): Promise<ClaudeMcpSnapshot> {
    return this.providerRequest(scope => scope.client.claudeMcp(sessionId))
  }

  async controlClaudeMcp(sessionId: string, input: ClaudeMcpControlInput): Promise<ClaudeMcpSnapshot> {
    return this.providerRequest(scope => scope.client.controlClaudeMcp(sessionId, input))
  }

  async resolveClaudeInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>
  ): Promise<ClaudePendingInteraction> {
    return this.providerRequest(scope => scope.client.resolveClaudeInteraction(
      sessionId,
      interactionId,
      response
    ))
  }

  async codexPermissionProfiles(sessionId: string): Promise<CodexPermissionProfile[]> {
    return this.codexRequest(scope => scope.client.codexPermissionProfiles(sessionId))
  }

  async codexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.codexRequest(scope => scope.client.codexGoal(sessionId))
  }

  async setCodexGoal(sessionId: string, input: CodexGoalInput): Promise<CodexGoalSnapshot> {
    return this.codexRequest(scope => scope.client.setCodexGoal(sessionId, input))
  }

  async clearCodexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.codexRequest(scope => scope.client.clearCodexGoal(sessionId))
  }

  async compactCodexThread(sessionId: string): Promise<CodexOperationAccepted> {
    return this.codexRequest(scope => scope.client.compactCodexThread(sessionId))
  }

  async rollbackCodexThread(sessionId: string, input: CodexRollbackInput): Promise<CodexRollbackResult> {
    return this.codexRequest(scope => scope.client.rollbackCodexThread(sessionId, input))
  }

  async reviewCodexThread(sessionId: string, input: CodexReviewInput): Promise<CodexOperationAccepted> {
    return this.codexRequest(scope => scope.client.reviewCodexThread(sessionId, input))
  }

  async shellCodexThread(sessionId: string, input: CodexShellInput): Promise<CodexOperationAccepted> {
    return this.codexRequest(scope => scope.client.shellCodexThread(sessionId, input))
  }

  async codexBackgroundTerminals(sessionId: string): Promise<CodexBackgroundTerminalsSnapshot> {
    return this.codexRequest(scope => scope.client.codexBackgroundTerminals(sessionId))
  }

  async terminateCodexBackgroundTerminal(
    sessionId: string,
    input: CodexBackgroundTerminalTerminateInput
  ): Promise<boolean> {
    return this.codexRequest(scope => scope.client.terminateCodexBackgroundTerminal(sessionId, input))
  }

  async cleanCodexBackgroundTerminals(
    sessionId: string,
    input: CodexBackgroundTerminalsCleanInput
  ): Promise<boolean> {
    return this.codexRequest(scope => scope.client.cleanCodexBackgroundTerminals(sessionId, input))
  }

  async queue(sessionId: string): Promise<QueuedTurn[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const turns = await scope.client.queue(sessionId)
    this.assertCurrentScope(scope)
    this.cache.putQueuedTurns(scope.namespace, sessionId, turns)
    return turns
  }

  async updateQueued(
    sessionId: string,
    queuedId: string,
    prompt: string,
    chatReferences?: ChatReference[],
    clientCapabilities?: string[],
    teamReferences?: TeamReference[]
  ): Promise<boolean> {
    assertLocalAgentChatReferences(chatReferences)
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.updateQueued(
      sessionId,
      queuedId,
      prompt,
      chatReferences,
      clientCapabilities,
      teamReferences
    )
    this.assertCurrentScope(scope)
    // PATCH is the durable commit point. Do not turn a successful edit into a
    // visible failure by requiring a second network round trip before IPC can
    // resolve. The server event stream will also reconcile this cache; this
    // local projection makes the committed edit immediately available offline.
    try {
      const turns = this.cache.queuedTurns(scope.namespace, sessionId)
      if (turns.some(turn => turn.queued_id === queuedId)) {
        this.cache.putQueuedTurns(scope.namespace, sessionId, turns.map(turn => turn.queued_id === queuedId ? {
          ...turn,
          // Reference offsets use JavaScript UTF-16 indices into this exact
          // string. Do not normalize whitespace independently of the refs.
          prompt,
          display_prompt: prompt,
          ...(chatReferences !== undefined ? { chat_references: chatReferences } : {}),
          ...(teamReferences !== undefined ? { team_references: teamReferences } : {})
        } : turn))
      }
    } catch (error) {
      appLog('queue', 'could not project committed queue edit into local cache', {
        sessionId,
        queuedId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return result
  }

  async agentHandoffRoutes(expected: WorkspaceProfileScope, sessionId: string): Promise<AgentCrossChatRoutesSnapshot> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    const snapshot = await scope.client.agentHandoffRoutes(sessionId)
    this.assertCurrentScope(scope)
    return snapshot
  }

  async searchAgentHandoffTargets(
    expected: WorkspaceProfileScope,
    query: string,
    excludeSessionId: string,
    limit = 20
  ): Promise<ChatSearchSnapshot> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    const snapshot = await scope.client.searchAgentHandoffTargets(query, excludeSessionId, limit)
    this.assertCurrentScope(scope)
    return snapshot
  }

  async createAgentHandoffRoute(
    expected: WorkspaceProfileScope,
    sessionId: string,
    input: CreateAgentCrossChatRouteInput
  ): Promise<AgentCrossChatRoute> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    const route = await scope.client.createAgentHandoffRoute(sessionId, input)
    this.assertCurrentScope(scope)
    return route
  }

  async updateAgentHandoffRoute(
    expected: WorkspaceProfileScope,
    sessionId: string,
    routeId: string,
    input: UpdateAgentCrossChatRouteInput
  ): Promise<AgentCrossChatRouteUpdateResult> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    try {
      const route = await scope.client.updateAgentHandoffRoute(sessionId, routeId, input)
      this.assertCurrentScope(scope)
      return { status: 'updated', route }
    } catch (error) {
      this.assertCurrentScope(scope)
      if (isAgentRouteRevisionConflict(error)) return { status: 'revision_conflict' }
      throw error
    }
  }

  async deleteAgentHandoffRoute(
    expected: WorkspaceProfileScope,
    sessionId: string,
    routeId: string,
    expectedRevision: string
  ): Promise<DeleteAgentCrossChatRouteResult> {
    const scope = this.requireWorkspaceScope(expected)
    await this.ensureValidatedScope(scope)
    try {
      const result = await scope.client.deleteAgentHandoffRoute(sessionId, routeId, expectedRevision)
      this.assertCurrentScope(scope)
      return { status: 'deleted', deleted: result.deleted, route_id: result.route_id }
    } catch (error) {
      this.assertCurrentScope(scope)
      if (isAgentRouteRevisionConflict(error)) return { status: 'revision_conflict' }
      throw error
    }
  }

  async crossChatHandoff(envelopeId: string): Promise<CrossChatHandoff> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const handoff = await scope.client.crossChatHandoff(envelopeId)
    this.assertCurrentScope(scope)
    return handoff
  }

  async cancelCrossChatHandoff(envelopeId: string): Promise<CrossChatHandoffSummary> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const handoff = await scope.client.cancelCrossChatHandoff(envelopeId)
    this.assertCurrentScope(scope)
    return handoff
  }

  async crossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const exchange = await scope.client.crossChatExchange(exchangeId)
    this.assertCurrentScope(scope)
    return exchange
  }

  async cancelCrossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const exchange = await scope.client.cancelCrossChatExchange(exchangeId)
    this.assertCurrentScope(scope)
    return exchange
  }

  async removeQueued(sessionId: string, queuedId: string): Promise<boolean> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.removeQueued(sessionId, queuedId)
    this.assertCurrentScope(scope)
    const turns = await scope.client.queue(sessionId)
    this.assertCurrentScope(scope)
    this.cache.putQueuedTurns(scope.namespace, sessionId, turns)
    return result
  }

  async skipQueuedCrossChatDelivery(
    sessionId: string,
    queuedId: string,
    identity: QueuedCrossChatDeliveryIdentity
  ): Promise<boolean> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.skipQueuedCrossChatDelivery(sessionId, queuedId, identity)
    this.assertCurrentScope(scope)
    let turns: QueuedTurn[]
    try {
      turns = await scope.client.queue(sessionId)
    } catch {
      // The skip is already committed. A best-effort cache refresh must not
      // turn that successful, non-idempotent mutation into a false failure.
      this.assertCurrentScope(scope)
      return result
    }
    this.assertCurrentScope(scope)
    this.cache.putQueuedTurns(scope.namespace, sessionId, turns)
    return result
  }

  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down', expectedAdjacentQueuedId?: string): Promise<QueuedTurn[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const turns = await scope.client.moveQueued(sessionId, queuedId, direction, expectedAdjacentQueuedId)
    this.assertCurrentScope(scope)
    this.cache.putQueuedTurns(scope.namespace, sessionId, turns)
    return turns
  }

  async runQueuedNow(sessionId: string, queuedId: string): Promise<QueuedRunNowResponse> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.runQueuedNow(sessionId, queuedId)
    this.assertCurrentScope(scope)
    const refreshed = await scope.client.queue(sessionId)
    this.assertCurrentScope(scope)
    const turns = result.deferred === true
      ? refreshed
      : refreshed.filter(turn => turn.queued_id !== queuedId || turn.promoted === true)
    this.cache.putQueuedTurns(scope.namespace, sessionId, turns)
    return result
  }

  async listJobs(): Promise<Job[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const jobs = await scope.client.jobs()
    this.assertCurrentScope(scope)
    this.jobs = jobs
    this.cache.putJobs(scope.namespace, jobs)
    this.emitJobs(scope, jobs)
    return jobs
  }
  async jobRuns(
    sessionId: string,
    jobId: string,
    beforeSeq?: number | null,
    limit = 20,
    timelineGroupId?: string | null
  ): Promise<JobRunHistoryPage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    try {
      const page = await scope.client.jobRuns(
        sessionId,
        jobId,
        beforeSeq,
        limit,
        timelineGroupId
      )
      this.assertCurrentScope(scope)
      return page
    } catch (error) {
      if (!this.isCurrentScope(scope)) throw staleProfileError()
      if (error instanceof ServerError && error.status === 404) {
        return {
          runs: [],
          total: 0,
          has_more: false,
          next_before: null,
          supported: false
        }
      }
      throw error
    }
  }
  async createJob(input: CreateJobInput): Promise<Job> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const job = await scope.client.createJob(input)
    this.assertCurrentScope(scope)
    await this.refreshJobs(scope, true)
    return job
  }
  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const job = await scope.client.updateJob(jobId, patch)
    this.assertCurrentScope(scope)
    await this.refreshJobs(scope, true)
    return job
  }
  async removeJob(jobId: string): Promise<boolean> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const removed = await scope.client.deleteJob(jobId)
    this.assertCurrentScope(scope)
    await this.refreshJobs(scope, true)
    return removed
  }
  async runJob(jobId: string): Promise<JobRunNowResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const started = await scope.client.runJob(jobId)
    this.assertCurrentScope(scope)
    return started
  }

  async chooseFiles(rendererId: number): Promise<NativeFileRef[]> {
    const scope = this.captureScope()
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    const files = await Promise.all(result.filePaths.map(async path => {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Only regular files can be attached.')
      return { path, name: basename(path), size: info.size }
    }))
    this.assertCurrentScope(scope)
    this.assertRendererGrantEpoch(rendererId, rendererEpoch)
    this.fileUploadGrants.register(files.map(file => file.path), uploadGrantScope(scope, rendererId))
    return files
  }

  async stageNativeFile(rendererId: number, path: string): Promise<NativeFileRef> {
    const scope = this.captureScope()
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Only regular files can be attached.')
    this.assertCurrentScope(scope)
    this.assertRendererGrantEpoch(rendererId, rendererEpoch)
    // A renderer can retain a native File object, so staging the same object
    // again must not reset an already chat-bound grant. The explicit native
    // chooser remains the user-confirmed way to grant it to another chat.
    this.fileUploadGrants.register([path], uploadGrantScope(scope, rendererId), false)
    return { path, name: basename(path), size: info.size }
  }

  stageClipboardImage(rendererId: number, data: ArrayBuffer, name: string, type: string): NativeFileRef {
    const scope = this.captureScope()
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    const contentType = exactClipboardImageType(type)
    const extension = CLIPBOARD_IMAGE_EXTENSIONS.get(contentType)!
    const safeName = safeClipboardImageName(name, extension)
    if (!(data instanceof ArrayBuffer) || data.byteLength <= 0 || data.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error(`Clipboard images must be between 1 byte and ${MAX_CLIPBOARD_IMAGE_BYTES} bytes.`)
    }
    const directory = this.ensureClipboardStagingDirectory()
    const path = join(directory, `${randomUUID()}-${safeName}`)
    writeFileSync(path, Buffer.from(data), { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    try {
      this.assertCurrentScope(scope)
      this.assertRendererGrantEpoch(rendererId, rendererEpoch)
      this.stagedClipboardFiles.set(path, { path, activeUses: 0, cleanupRequested: false })
      this.fileUploadGrants.registerManaged(
        path,
        uploadGrantScope(scope, rendererId),
        () => this.requestStagedClipboardCleanup(path)
      )
      return { path, name: safeName, size: data.byteLength, type: contentType }
    } catch (error) {
      this.stagedClipboardFiles.delete(path)
      rmSync(path, { force: true })
      throw error
    }
  }

  async uploadFiles(rendererId: number, sessionId: string, paths: string[]): Promise<AgentFile[]> {
    const scope = this.captureScope()
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    const grantScope = uploadGrantScope(scope, rendererId)
    const operation = this.beginRendererFileOperation(rendererId, rendererEpoch)
    const stagedReleases: Array<() => void> = []
    let admittedFiles: ReturnType<FileUploadGrantRegistry['admit']> = []
    try {
      // Do not consume a chooser grant merely because the profile is offline
      // or its pinned identity cannot be validated. Admission is the boundary
      // for a real upload attempt, after authority validation succeeds.
      await this.ensureValidatedScope(scope)
      this.assertRendererGrantEpoch(rendererId, rendererEpoch)
      admittedFiles = this.fileUploadGrants.admit(paths, grantScope, sessionId)
      stagedReleases.push(...paths.map(path => this.retainStagedClipboardFile(path)))
      const files: AgentFile[] = []
      for (const [index, admitted] of admittedFiles.entries()) {
        this.assertCurrentScope(scope)
        this.assertRendererGrantEpoch(rendererId, rendererEpoch)
        let file: AgentFile
        try {
          file = await scope.client.uploadOpened(sessionId, {
            fd: admitted.fd,
            byteSize: admitted.byteSize,
            filename: basename(admitted.requestedPath)
          }, operation.signal)
          this.assertCurrentScope(scope)
          this.assertRendererGrantEpoch(rendererId, rendererEpoch)
          if (!agentFileBelongsToSession(file, sessionId)) {
            throw new Error('The server returned an upload owned by another chat.')
          }
        } catch (error) {
          this.fileUploadGrants.releaseManagedIfExhausted(paths[index], grantScope)
          throw error
        }
        files.push(file)
      }
      this.assertCurrentScope(scope)
      this.assertRendererGrantEpoch(rendererId, rendererEpoch)
      for (const path of paths) this.fileUploadGrants.releaseManaged(path, grantScope)
      this.cache.putFiles(scope.namespace, sessionId, files)
      return files
    } finally {
      for (const admitted of admittedFiles) admitted.close()
      for (const release of stagedReleases) release()
      operation.release()
    }
  }

  admitTeamAttachmentFile(
    rendererId: number,
    expected: TeamHubScope,
    teamId: string,
    path: string,
    attachmentId?: string
  ): ReturnType<FileUploadGrantRegistry['admit']>[number] {
    const scope = this.requireProfileScope(expected.profileId, expected.profileGeneration)
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    this.assertRendererGrantEpoch(rendererId, rendererEpoch)
    const grantScope = uploadGrantScope(scope, rendererId)
    if (attachmentId === undefined) {
      return this.fileUploadGrants.reserveDeclaration(path, grantScope, `team:${teamId}`)
    }
    return this.fileUploadGrants.admit([path], grantScope, `team:${teamId}`, attachmentId)[0]
  }

  beginTeamAttachmentOperation(rendererId: number): {
    signal: AbortSignal
    assertCurrent: () => void
    release: () => void
  } {
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    const operation = this.beginRendererFileOperation(rendererId, rendererEpoch)
    return {
      signal: operation.signal,
      assertCurrent: () => this.assertRendererGrantEpoch(rendererId, rendererEpoch),
      release: operation.release
    }
  }

  bindTeamAttachmentDeclaration(
    rendererId: number,
    expected: TeamHubScope,
    teamId: string,
    path: string,
    attachmentId: string
  ): void {
    const scope = this.requireProfileScope(expected.profileId, expected.profileGeneration)
    const rendererEpoch = this.captureRendererGrantEpoch(rendererId)
    this.assertRendererGrantEpoch(rendererId, rendererEpoch)
    this.fileUploadGrants.bindDeclaration(
      path,
      uploadGrantScope(scope, rendererId),
      `team:${teamId}`,
      attachmentId
    )
  }

  abandonTeamAttachmentDeclaration(
    rendererId: number,
    expected: TeamHubScope,
    teamId: string,
    path: string
  ): void {
    this.fileUploadGrants.abandonDeclaration(
      path,
      {
        profileId: expected.profileId,
        profileGeneration: expected.profileGeneration,
        rendererId
      },
      `team:${teamId}`
    )
  }

  async listFiles(sessionId: string, offset = 0, limit = FILE_PAGE_LIMIT, contentPrefix?: string): Promise<FilesPage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const page = sessionOwnedFilesPage(
      await scope.client.files(sessionId, offset, limit, contentPrefix),
      sessionId
    )
    this.assertCurrentScope(scope)
    this.cache.putFiles(scope.namespace, sessionId, page.files)
    return page
  }

  async fileEvent(sessionId: string, fileId: string): Promise<Event | null> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const event = await scope.client.fileEvent(sessionId, fileId)
    this.assertCurrentScope(scope)
    if (!event) return null
    const safe = isolateSessionEvent(event, sessionId)
    return safe && (event.file || event.artifact) && !safe.file && !safe.artifact ? null : safe
  }

  async workspaceInfo(sessionId: string): Promise<WorkspaceInfo> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const info = await scope.client.workspaceInfo(sessionId)
    this.assertCurrentScope(scope)
    return info
  }

  async workspaceEntries(sessionId: string, path = '', offset = 0, limit = 500): Promise<WorkspaceEntriesPage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const page = await scope.client.workspaceEntries(sessionId, path, offset, limit)
    this.assertCurrentScope(scope)
    return page
  }

  async workspaceSearch(sessionId: string, query = '', limit = 100): Promise<WorkspaceSearchPage> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const page = await scope.client.workspaceSearch(sessionId, query, limit)
    this.assertCurrentScope(scope)
    return page
  }

  async completeWorkingDirectory(path: string, limit = 24): Promise<WorkingDirectoryCompletion> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const completion = await scope.client.completeWorkingDirectory(path, limit)
    this.assertCurrentScope(scope)
    return completion
  }

  async workspaceFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const file = await scope.client.workspaceFile(sessionId, path)
    this.assertCurrentScope(scope)
    return file
  }

  async absoluteFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const file = await scope.client.absoluteFile(sessionId, path)
    this.assertCurrentScope(scope)
    return {
      ...file,
      writable: this.absoluteFileWritesAvailable() && file.writable === true,
      scope: 'absolute'
    }
  }

  async writeAbsoluteFile(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    if (!this.absoluteFileWritesAvailable()) {
      throw new Error('Update AgentsServer to edit explicit absolute file paths.')
    }
    const file = await scope.client.writeAbsoluteFile(sessionId, path, content, expectedRevision)
    this.assertCurrentScope(scope)
    return { ...file, writable: file.writable === true, scope: 'absolute' }
  }

  async overwriteAbsoluteFile(sessionId: string, path: string, content: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    if (!this.absoluteFileWritesAvailable()) {
      throw new Error('Update AgentsServer to edit explicit absolute file paths.')
    }
    const disk = await scope.client.absoluteFile(sessionId, path)
    this.assertCurrentScope(scope)
    const file = await scope.client.writeAbsoluteFile(sessionId, path, content, disk.revision)
    this.assertCurrentScope(scope)
    return { ...file, writable: file.writable === true, scope: 'absolute' }
  }

  async createWorkspaceEntry(
    sessionId: string,
    path: string,
    kind: 'file' | 'directory'
  ): Promise<WorkspaceCreateResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.createWorkspaceEntry(sessionId, path, kind)
    this.assertCurrentScope(scope)
    return result
  }

  async writeWorkspaceFile(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const file = await scope.client.writeWorkspaceFile(sessionId, path, content, expectedRevision)
    this.assertCurrentScope(scope)
    return file
  }

  async overwriteWorkspaceFile(sessionId: string, path: string, content: string): Promise<WorkspaceFile> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const disk = await scope.client.workspaceFile(sessionId, path)
    this.assertCurrentScope(scope)
    const file = await scope.client.writeWorkspaceFile(sessionId, path, content, disk.revision)
    this.assertCurrentScope(scope)
    return file
  }

  async downloadWorkspaceFile(sessionId: string, path: string): Promise<string | null> {
    const scope = this.captureScope()
    const filename = basename(path) || 'download'
    const result = await dialog.showSaveDialog({ defaultPath: filename })
    if (result.canceled || !result.filePath) return null
    this.assertCurrentScope(scope)
    appLog('workspace-file', 'download requested', {
      sessionId,
      path,
      destination: result.filePath
    })
    try {
      await this.ensureValidatedScope(scope)
      let response = await scope.client.workspaceDownloadRequest(sessionId, path)
      try {
        this.assertCurrentScope(scope)
      } catch (error) {
        await response.body?.cancel().catch(() => undefined)
        throw error
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
        response = await scope.client.workspacePreviewRequest(sessionId, path)
        try {
          this.assertCurrentScope(scope)
        } catch (error) {
          await response.body?.cancel().catch(() => undefined)
          throw error
        }
      }
      if (response.status === 404 || response.status === 415) {
        await response.body?.cancel().catch(() => undefined)
        const file = await scope.client.workspaceFile(sessionId, path)
        this.assertCurrentScope(scope)
        response = new Response(file.content, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
        const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
        throw new Error(`Workspace download failed (${status})${detail ? `: ${detail}` : ''}`)
      }
      if (!response.body) throw new Error('Workspace download failed: server returned an empty response')
      await this.downloadResponse(response, result.filePath)
      this.assertCurrentScope(scope)
      appLog('workspace-file', 'download completed', {
        sessionId,
        path,
        destination: result.filePath
      })
      return result.filePath
    } catch (error) {
      appLog('workspace-file', 'download failed', {
        sessionId,
        path,
        destination: result.filePath,
        error: errorText(error)
      })
      throw error
    }
  }

  async renameWorkspaceEntry(
    sessionId: string,
    path: string,
    newName: string,
    expectedRevision: string
  ): Promise<WorkspaceRenameResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.renameWorkspaceEntry(sessionId, path, newName, expectedRevision)
    this.assertCurrentScope(scope)
    return result
  }

  async removeWorkspaceEntry(
    sessionId: string,
    path: string,
    expectedRevision: string,
    recursive: boolean
  ): Promise<WorkspaceRemoveResult> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await scope.client.removeWorkspaceEntry(sessionId, path, expectedRevision, recursive)
    this.assertCurrentScope(scope)
    return result
  }

  async saveFile(sessionId: string, file: AgentFile): Promise<string | null> {
    requireSessionFile(sessionId, file)
    const scope = this.captureScope()
    const result = await dialog.showSaveDialog({ defaultPath: file.filename })
    if (result.canceled || !result.filePath) return null
    this.assertCurrentScope(scope)
    appLog('files', 'save requested', { fileId: file.id, filename: file.filename, destination: result.filePath })
    try {
      await this.downloadFile(scope, sessionId, file, result.filePath)
      this.assertCurrentScope(scope)
      appLog('files', 'save completed', { fileId: file.id, filename: file.filename, destination: result.filePath })
      return result.filePath
    } catch (error) {
      appLog('files', 'save failed', { fileId: file.id, filename: file.filename, destination: result.filePath, error: errorText(error) })
      throw error
    }
  }

  async readTextFile(sessionId: string, file: AgentFile, callerSignal?: AbortSignal): Promise<AgentTextFile> {
    requireSessionFile(sessionId, file)
    const scope = this.captureScope()
    const path = this.localFilePath(scope, sessionId, file)
    const timeoutController = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, AGENT_TEXT_FILE_TIMEOUT_MS)
    timeout.unref?.()
    const signal = AbortSignal.any([timeoutController.signal, ...(callerSignal ? [callerSignal] : [])])
    try {
      throwIfArtifactReadAborted(signal)
      let downloaded = false
      let preview: ArtifactTextPreview
      if (existsSync(path)) {
        preview = await readArtifactTextPreviewFromFile(path, MAX_AGENT_TEXT_PREVIEW_BYTES, signal)
        this.assertCurrentScope(scope)
      } else {
        await abortable(this.ensureValidatedScope(scope), signal)
        const response = await scope.client.fileRequest(sessionId, file.id, undefined, signal)
        this.assertCurrentScope(scope)
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
          throw new Error(`Artifact download failed (${status}).`)
        }
        preview = await readArtifactTextPreviewFromResponse(
          response,
          MAX_AGENT_TEXT_PREVIEW_BYTES,
          file.size ?? undefined,
          signal
        )
        this.assertCurrentScope(scope)
        downloaded = true
      }
      throwIfArtifactReadAborted(signal)
      const { bytes } = preview
      if (bytes.includes(0)) throw new Error('Artifact appears to be binary and cannot be viewed as text.')

      let content: string
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        content = decoder.decode(bytes, preview.truncated ? { stream: true } : undefined)
      } catch {
        throw new Error('Artifact is not valid UTF-8 text.')
      }
      if (hasBinaryControlCharacters(content)) {
        throw new Error('Artifact appears to be binary and cannot be viewed as text.')
      }
      throwIfArtifactReadAborted(signal)
      if (downloaded && !preview.truncated) {
        await cacheArtifactBytes(path, bytes).catch(error => {
          appLog('files', 'artifact text cache write failed', {
            fileId: file.id,
            filename: file.filename,
            error: errorText(error)
          })
        })
        this.assertCurrentScope(scope)
      }
      throwIfArtifactReadAborted(signal)

      return {
        id: file.id,
        filename: file.filename,
        content,
        content_type: file.content_type,
        size: preview.totalSize,
        ...(preview.truncated ? { preview_size: bytes.byteLength, truncated: true } : {}),
        revision: createHash('sha256').update(bytes).digest('hex')
      }
    } catch (error) {
      if (timedOut) throw new Error('Artifact loading timed out after 30 seconds.')
      if (callerSignal?.aborted) throw new Error('Artifact loading was canceled.')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async openFile(sessionId: string, file: AgentFile): Promise<void> {
    await shell.openPath(await this.ensureLocalFile(sessionId, file))
  }
  async openLinkedFile(sessionId: string, target: string): Promise<void> {
    const scope = this.captureScope()
    const cleanTarget = target.trim()
    if (!cleanTarget) return
    await this.ensureValidatedScope(scope)
    const response = await scope.client.linkedFileRequest(sessionId, cleanTarget)
    this.assertCurrentScope(scope)
    if (!response.ok || !response.body) throw new Error(`Linked file failed: ${response.status}`)
    const filename = linkedFilename(response, cleanTarget)
    const digest = createHash('sha256').update(`${scope.profileId}\0${scope.namespace}\0${sessionId}\0${cleanTarget}`).digest('hex').slice(0, 20)
    const path = join(app.getPath('temp'), 'AgentsDockLinkedFiles', digest, filename)
    if (!existsSync(path)) await this.downloadResponse(response, path)
    this.assertCurrentScope(scope)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  }
  async revealFile(sessionId: string, file: AgentFile): Promise<void> {
    shell.showItemInFolder(await this.ensureLocalFile(sessionId, file))
  }

  async beginDrag(sessionId: string, file: AgentFile, window: BrowserWindow): Promise<boolean> {
    appLog('files', 'preparing native file drag', { fileId: file.id, filename: file.filename })
    const path = await this.ensureLocalFile(sessionId, file)
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false
    const icon = await app.getFileIcon(path, { size: 'normal' }).catch(() =>
      nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==')
    )
    window.webContents.startDrag({ file: path, icon })
    appLog('files', 'native file drag started', { fileId: file.id, filename: file.filename, path })
    return true
  }

  async previewDigest(input: DigestInput): Promise<string> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const preview = await scope.client.previewDigest(input.sourceSessionId, input.targetSessionId, input.detail, input.userPrompt)
    this.assertCurrentScope(scope)
    return preview
  }

  async sendDigest(input: DigestInput): Promise<boolean> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const sent = await scope.client.sendDigest(input.sourceSessionId, input.targetSessionId, input.detail, input.userPrompt)
    this.assertCurrentScope(scope)
    return sent
  }
  async runtime(refresh = false): Promise<RuntimeCatalog> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    await this.refreshRuntime(true, refresh, scope, refresh)
    this.assertCurrentScope(scope)
    if (!this.runtimeCatalog) throw new Error('The server runtime catalog is unavailable. Check the server version and connection, then retry.')
    return this.runtimeCatalog
  }
  async processes(sessionId: string): Promise<ProcessSnapshot> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const processes = await scope.client.processes(sessionId)
    this.assertCurrentScope(scope)
    return processes
  }

  async processLog(sessionId: string, path: string, lines?: number): Promise<string> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const log = await scope.client.processLog(sessionId, path, lines)
    this.assertCurrentScope(scope)
    return log
  }

  async tmux(sessionId: string, includeAll?: boolean): Promise<TmuxPane[]> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const panes = await scope.client.tmux(sessionId, includeAll)
    this.assertCurrentScope(scope)
    return panes
  }

  async captureTmux(sessionId: string, paneId: string, lines?: number): Promise<string> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const capture = await scope.client.captureTmux(sessionId, paneId, lines)
    this.assertCurrentScope(scope)
    return capture
  }
  async connectTerminal(profileId: string, profileGeneration: number, sessionId: string, options: TerminalConnectOptions): Promise<void> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.ensureValidatedScope(scope)
    const tmux = this.health?.capabilities?.tmux
    if (tmux?.available === false) throw new Error(tmux.action || tmux.message || 'tmux is required for terminal sessions.')
    this.disconnectTerminal(sessionId)
    const lease = (this.terminalLeases.get(sessionId) ?? 0) + 1
    this.terminalLeases.set(sessionId, lease)
    const connection = scope.client.terminal(
      sessionId,
      options,
      data => {
        if (this.isCurrentScope(scope) && this.terminalLeases.get(sessionId) === lease) {
          this.emit('terminal:data', { sessionId, data, profileId: scope.profileId, profileGeneration: scope.generation })
        }
      },
      state => {
        if (this.isCurrentScope(scope) && this.terminalLeases.get(sessionId) === lease) {
          this.emit('terminal:state', { ...state, profileId: scope.profileId, profileGeneration: scope.generation })
        }
      }
    )
    this.assertCurrentScope(scope)
    this.terminalConnections.set(sessionId, connection)
  }
  writeTerminal(profileId: string, profileGeneration: number, sessionId: string, data: string): void {
    if (this.profileScopeMatches(profileId, profileGeneration)) this.terminalConnections.get(sessionId)?.write(data)
  }
  resizeTerminal(profileId: string, profileGeneration: number, sessionId: string, columns: number, rows: number): void {
    if (this.profileScopeMatches(profileId, profileGeneration)) this.terminalConnections.get(sessionId)?.resize(columns, rows)
  }
  scrollTerminal(profileId: string, profileGeneration: number, sessionId: string, delta: number): void {
    if (this.profileScopeMatches(profileId, profileGeneration)) this.terminalConnections.get(sessionId)?.scroll(delta)
  }
  disconnectTerminalForProfile(profileId: string, profileGeneration: number, sessionId: string): void {
    this.requireProfileScope(profileId, profileGeneration)
    this.disconnectTerminal(sessionId)
  }
  disconnectTerminal(sessionId: string): void {
    this.terminalLeases.set(sessionId, (this.terminalLeases.get(sessionId) ?? 0) + 1)
    this.terminalConnections.get(sessionId)?.close()
    this.terminalConnections.delete(sessionId)
  }
  async killTerminal(profileId: string, profileGeneration: number, sessionId: string): Promise<boolean> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.ensureValidatedScope(scope)
    this.disconnectTerminal(sessionId)
    const deleted = await scope.client.deleteTerminal(sessionId)
    this.assertCurrentScope(scope)
    return deleted
  }
  async terminalWindows(profileId: string, profileGeneration: number, sessionId: string): Promise<TerminalWindowsSnapshot> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.ensureValidatedScope(scope)
    const windows = await scope.client.terminalWindows(sessionId)
    this.assertCurrentScope(scope)
    return windows
  }
  async terminalAction(profileId: string, profileGeneration: number, sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.ensureValidatedScope(scope)
    const windows = await scope.client.terminalAction(sessionId, action, target)
    this.assertCurrentScope(scope)
    return windows
  }
  listForwardedPorts(profileId: string, profileGeneration: number): ForwardedPort[] {
    this.requireProfileScope(profileId, profileGeneration)
    return this.portTunnels.list()
  }
  async startForwardedPort(
    profileId: string,
    profileGeneration: number,
    sessionId: string,
    remotePort: number,
    preferredLocalPort?: number
  ): Promise<ForwardedPort> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    this.requirePortForwardingCapability()
    this.requireActivePortTunnelSession(sessionId)
    const createRemoteSocket = (): WebSocket => {
      if (!this.isValidatedScope(scope)) {
        throw new Error('The server profile has not passed its identity check.')
      }
      this.requirePortForwardingCapability()
      this.requireActivePortTunnelSession(sessionId)
      return scope.client.portTunnelSocket(sessionId, remotePort)
    }
    const forwarded = await this.portTunnels.start(
      sessionId,
      remotePort,
      preferredLocalPort,
      createRemoteSocket,
      portForwardingSessionBridgeLimit(this.health)
    )
    try {
      this.assertCurrentScope(scope)
      if (!this.isValidatedScope(scope)) throw new Error('The server profile has not passed its identity check.')
      this.requirePortForwardingCapability()
      this.requireActivePortTunnelSession(sessionId)
      return forwarded
    } catch (error) {
      this.portTunnels.disposeIfOwned(sessionId, remotePort, createRemoteSocket)
      throw error
    }
  }
  async stopForwardedPort(
    profileId: string,
    profileGeneration: number,
    remotePort: number
  ): Promise<void> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    await this.portTunnels.stop(remotePort)
    this.assertCurrentScope(scope)
  }
  async openForwardedPort(
    profileId: string,
    profileGeneration: number,
    remotePort: number
  ): Promise<void> {
    const scope = this.requireProfileScope(profileId, profileGeneration)
    const url = this.portTunnels.url(remotePort)
    this.assertCurrentScope(scope)
    await shell.openExternal(url)
    this.assertCurrentScope(scope)
  }
  async pins(expected: WorkspaceProfileScope, sessionId: string): Promise<PinnedItem[]> {
    const scope = this.requireWorkspaceScope(expected)
    return this.pinSync.list(this.pinSyncContext(scope, sessionId))
  }

  async putPin(expected: WorkspaceProfileScope, item: PinnedItem): Promise<PinnedItem[]> {
    const scope = this.requireWorkspaceScope(expected)
    const sessionId = item && typeof item.sessionId === 'string' ? item.sessionId : ''
    const normalized = normalizePinnedItemForSync(item, sessionId)
    return this.pinSync.put(this.pinSyncContext(scope, normalized.sessionId), normalized)
  }

  async removePin(expected: WorkspaceProfileScope, sessionId: string, itemId: string): Promise<PinnedItem[]> {
    const scope = this.requireWorkspaceScope(expected)
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw new Error('Pinned item chat is invalid.')
    if (typeof itemId !== 'string' || !itemId || itemId.length > 264) throw new Error('Pinned item identifier is invalid.')
    return this.pinSync.remove(this.pinSyncContext(scope, sessionId), itemId)
  }
  preference<T>(key: string, fallback: T): T { return this.cache.preference(this.captureScope().namespace, key, fallback) }
  putPreference<T>(key: string, value: T): void {
    this.cache.putPreference(this.captureScope().namespace, key, value)
    if (key === 'selectedSessionId') this.focusedSessionId = typeof value === 'string' ? value : null
  }
  scopedPreference<T>(expected: WorkspaceProfileScope, key: string, fallback: T): T {
    return this.cache.preference(this.requireWorkspaceScope(expected).namespace, key, fallback)
  }
  putScopedPreference<T>(expected: WorkspaceProfileScope, key: string, value: T): void {
    this.cache.putPreference(this.requireWorkspaceScope(expected).namespace, key, value)
    if (key === 'selectedSessionId') this.focusedSessionId = typeof value === 'string' ? value : null
  }
  async workspacePreviewAvailable(
    expected: WorkspaceProfileScope,
    sessionId: string,
    path: string
  ): Promise<boolean> {
    const scope = this.requireWorkspaceScope(expected)
    // Reuse the canonical custom-protocol identity builder as the IPC trust
    // boundary. Invalid session IDs and workspace paths must be rejected before
    // validation or any authenticated server request begins.
    const previewURL = buildWorkspaceMediaURL(
      scope.profileId,
      scope.generation,
      sessionId,
      path
    )
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    this.requireWorkspaceScope(expected)
    let response: Response | undefined
    try {
      // The renderer chooses only the resource identity. Main owns the method,
      // headers, authenticated client, response, and lifecycle fences.
      response = await scope.client.workspacePreviewRequest(
        sessionId,
        path,
        new Request(previewURL, { method: 'HEAD' }),
        AbortSignal.timeout(WORKSPACE_PREVIEW_PROBE_TIMEOUT_MS)
      )
      this.assertCurrentScope(scope)
      this.requireWorkspaceScope(expected)
      return response.ok
    } finally {
      await response?.body?.cancel().catch(() => undefined)
      this.assertCurrentScope(scope)
      this.requireWorkspaceScope(expected)
    }
  }
  async mediaResponse(
    profileId: string,
    profileGeneration: number,
    sessionId: string,
    fileId: string,
    request: Request
  ): Promise<Response> {
    requireSessionFile(sessionId, { id: fileId, filename: fileId })
    const scope = this.captureScope()
    if (scope.profileId !== profileId || scope.generation !== profileGeneration) throw staleProfileError()
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    const response = await scope.client.fileRequest(sessionId, fileId, request)
    this.assertCurrentScope(scope)
    return response
  }

  async workspaceMediaResponse(
    profileId: string,
    profileGeneration: number,
    sessionId: string,
    path: string,
    request: Request
  ): Promise<Response> {
    const scope = this.captureScope()
    if (scope.profileId !== profileId || scope.generation !== profileGeneration) throw staleProfileError()
    await this.ensureValidatedScope(scope)
    this.assertCurrentScope(scope)
    const response = await scope.client.workspacePreviewRequest(sessionId, path, request)
    this.assertCurrentScope(scope)
    return response
  }

  async notify(payload: ProfileNotificationPayload): Promise<void> {
    const scope = this.captureScope()
    if (payload.profileId !== scope.profileId) return
    this.showProfileNotification(payload)
  }

  private showProfileNotification(payload: ProfileNotificationPayload): void {
    if (!Notification.isSupported()) return
    const profile = this.settings.getProfile(payload.profileId)
    if (!profile || (profile.serverIdentity ?? null) !== payload.serverIdentity) return
    const session = payload.profileId === this.activeProfileId
      ? this.sessions.find(candidate => candidate.id === payload.sessionId)
      : this.cache.session(profileNamespace(profile), payload.sessionId)
    if (!session) return
    const emergencyAlertId = payload.emergencyAlertId?.trim() || null
    if (emergencyAlertId) {
      if (!/^emergency_[0-9a-f]{32}$/.test(emergencyAlertId) || session.emergency_alert?.id !== emergencyAlertId) return
      if (this.notifiedEmergencyAlertIds.has(emergencyAlertId)) return
      rememberEmergencyAlertId(this.notifiedEmergencyAlertIds, emergencyAlertId)
    }
    const route: ProfileNotificationRoute = {
      profileId: payload.profileId,
      serverIdentity: profile.serverIdentity ?? null,
      sessionId: payload.sessionId
    }
    const notification = new Notification({ title: payload.title, body: payload.body, silent: false })
    notification.on('click', () => {
      const window = this.focusMainWindow()
      if (window && !window.isDestroyed()) this.deliverOrQueueNotificationRoute(window, route)
    })
    notification.show()
  }

  private notificationRouteIsCurrent(route: ProfileNotificationRoute): boolean {
    const profile = this.settings.getProfile(route.profileId)
    if (!profile || (profile.serverIdentity ?? null) !== route.serverIdentity) return false
    return route.profileId === this.activeProfileId
      ? this.sessions.some(session => session.id === route.sessionId)
      : this.cache.session(profileNamespace(profile), route.sessionId) != null
  }

  private deliverOrQueueNotificationRoute(window: BrowserWindow, route: ProfileNotificationRoute): void {
    if (
      this.rendererReadyWindows.has(window)
      && !window.webContents.isDestroyed()
      && !window.webContents.isLoadingMainFrame()
    ) {
      if (this.notificationRouteIsCurrent(route)) {
        window.webContents.send('native:notification', route)
      }
      return
    }
    const key = `${route.profileId}\0${route.serverIdentity ?? ''}\0${route.sessionId}`
    this.pendingNotificationRoutes = [
      ...this.pendingNotificationRoutes.filter(candidate => (
        `${candidate.profileId}\0${candidate.serverIdentity ?? ''}\0${candidate.sessionId}` !== key
      )),
      route
    ].slice(-MAX_PENDING_NOTIFICATION_ROUTES)
  }

  setBadge(count: number): void { app.dock?.setBadge(count > 0 ? String(count) : '') }

  /**
   * Keep the expensive all-session poll away from active typing and scrolling.
   * WebContents reports interaction directly to the main process, so this does
   * not add renderer state updates or per-keystroke IPC. A pending poll owns one
   * timer and checks the latest timestamp when it fires instead of rearming on
   * every input event.
   */
  private noteForegroundInteraction(): void {
    if (!this.running) return
    this.lastForegroundInteractionAt = Date.now()
  }

  private scheduleBackgroundRefresh(scope: ConnectionScope): void {
    if (!this.running || !this.isCurrentScope(scope)) return
    const now = Date.now()
    if (now - this.lastForegroundInteractionAt >= FOREGROUND_INTERACTION_QUIET_MS) {
      void this.runBackgroundRefresh(false, scope)
      return
    }

    // Repeated intervals replace the scope but retain one pending refresh and
    // one timer. Continuous interaction may postpone background work; it must
    // never trade foreground latency for an arbitrary background deadline.
    this.deferredBackgroundRefresh = scope
    this.armDeferredBackgroundRefresh()
  }

  private armDeferredBackgroundRefresh(): void {
    const pending = this.deferredBackgroundRefresh
    if (!this.running || !pending || this.deferredBackgroundRefreshTimer) return
    const now = Date.now()
    const quietAt = this.lastForegroundInteractionAt + FOREGROUND_INTERACTION_QUIET_MS
    const delay = Math.max(0, quietAt - now)
    this.deferredBackgroundRefreshTimer = setTimeout(() => {
      this.deferredBackgroundRefreshTimer = null
      this.flushDeferredBackgroundRefresh()
    }, delay)
  }

  private flushDeferredBackgroundRefresh(): void {
    const pending = this.deferredBackgroundRefresh
    if (!this.running || !pending) {
      this.deferredBackgroundRefresh = null
      return
    }
    const now = Date.now()
    const quietAt = this.lastForegroundInteractionAt + FOREGROUND_INTERACTION_QUIET_MS
    if (now < quietAt) {
      this.armDeferredBackgroundRefresh()
      return
    }

    this.deferredBackgroundRefresh = null
    if (this.isCurrentScope(pending)) {
      void this.runBackgroundRefresh(false, pending)
    }
  }

  /**
   * A poll can begin while the renderer is idle and finish after the user has
   * started typing or scrolling. Hold its stateful apply phase until the same
   * quiet window used by the start fence has elapsed. The waiter checks the
   * latest interaction timestamp when it wakes, so sustained input postpones
   * work without creating or resetting a timer for every input event.
   */
  private waitForForegroundQuiet(scope: ConnectionScope): Promise<boolean> {
    if (!this.isCurrentScope(scope)) return Promise.resolve(false)
    if (this.foregroundApplyBypassGenerations.has(scope.generation)) return Promise.resolve(true)
    const initialDelay = FOREGROUND_INTERACTION_QUIET_MS - (Date.now() - this.lastForegroundInteractionAt)
    if (initialDelay <= 0) return Promise.resolve(true)
    if (!this.running) return Promise.resolve(false)

    return new Promise(resolve => {
      let timer: NodeJS.Timeout | null = null
      let settled = false
      const finish = (apply: boolean): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        timer = null
        const waiters = this.backgroundApplyQuietWaiters.get(scope.generation)
        waiters?.delete(finish)
        if (waiters?.size === 0) this.backgroundApplyQuietWaiters.delete(scope.generation)
        resolve(apply)
      }
      const check = (): void => {
        timer = null
        if (this.foregroundApplyBypassGenerations.has(scope.generation)) {
          finish(true)
          return
        }
        if (!this.running || !this.isCurrentScope(scope)) {
          finish(false)
          return
        }
        const delay = FOREGROUND_INTERACTION_QUIET_MS - (Date.now() - this.lastForegroundInteractionAt)
        if (delay <= 0) {
          finish(true)
          return
        }
        timer = setTimeout(check, delay)
      }
      const waiters = this.backgroundApplyQuietWaiters.get(scope.generation) ?? new Set<(apply: boolean) => void>()
      waiters.add(finish)
      this.backgroundApplyQuietWaiters.set(scope.generation, waiters)
      check()
    })
  }

  private cancelBackgroundApplyQuietWaiters(): void {
    for (const waiters of [...this.backgroundApplyQuietWaiters.values()]) {
      for (const finish of [...waiters]) finish(false)
    }
    this.backgroundApplyQuietWaiters.clear()
    this.foregroundSensitiveRefreshes.clear()
    this.foregroundApplyBypassGenerations.clear()
  }

  private bypassBackgroundApplyQuietWait(scope: ConnectionScope): void {
    if (!this.foregroundSensitiveRefreshes.has(scope.generation)) return
    this.foregroundApplyBypassGenerations.add(scope.generation)
    const waiters = this.backgroundApplyQuietWaiters.get(scope.generation)
    if (!waiters) return
    for (const finish of [...waiters]) finish(true)
  }

  private runBackgroundRefresh(includeJobs: boolean, scope = this.captureScope()): Promise<void> {
    return this.refreshAll(false, includeJobs, scope, true).catch(error => {
      appLog('sync', 'background refresh failed', {
        profileId: scope.profileId,
        generation: scope.generation,
        serverId: scope.namespace,
        error: errorText(error)
      })
    })
  }

  private refreshAll(
    announce: boolean,
    includeJobs = true,
    scope = this.captureScope(),
    deferApplyDuringInteraction = false
  ): Promise<void> {
    if (!this.isCurrentScope(scope)) return Promise.resolve()
    if (this.profileResetIsPending(scope)) {
      return announce
        ? Promise.reject(new Error('This server profile is waiting for its prior identity reset to finish. Retry the identity reset before reconnecting.'))
        : Promise.resolve()
    }
    const existing = this.refreshInFlight.get(scope.generation)
    if (existing) {
      if (!deferApplyDuringInteraction) this.bypassBackgroundApplyQuietWait(scope)
      return existing
    }
    if (deferApplyDuringInteraction) this.foregroundSensitiveRefreshes.add(scope.generation)
    const task = this.performRefreshAll(scope, announce, includeJobs, deferApplyDuringInteraction)
    this.refreshInFlight.set(scope.generation, task)
    return task.finally(() => {
      if (this.refreshInFlight.get(scope.generation) === task) this.refreshInFlight.delete(scope.generation)
      this.foregroundSensitiveRefreshes.delete(scope.generation)
      this.foregroundApplyBypassGenerations.delete(scope.generation)
    })
  }

  private async performRefreshAll(
    scope: ConnectionScope,
    announce: boolean,
    includeJobs: boolean,
    deferApplyDuringInteraction: boolean
  ): Promise<void> {
    const started = Date.now()
    const [health, sessions, jobs] = await Promise.allSettled([
      scope.client.health(),
      scope.client.sessions(),
      includeJobs ? scope.client.jobs() : Promise.resolve(this.jobs)
    ])
    if (!this.isCurrentScope(scope)) return

    let activeScope = scope
    let announcedError: unknown = null
    if (health.status === 'fulfilled') {
      try {
        if (health.value.ok !== true) throw new Error('Server health check reported unavailable.')
        this.healthFailureCount = 0
        activeScope = this.adoptHealth(scope, health.value)
        this.ensureEmergencyStream(activeScope, health.value)
        this.setProfileRuntime(activeScope.profileId, {
          connectionState: connectionStateForHealth(health.value),
          lastConnectionError: connectionWarningForHealth(health.value),
          lastConnectionCheckedAt: Date.now()
        })
        this.emitConnection(activeScope, true, health.value)
        for (const [sessionId, subscription] of this.timelineSubscriptions) {
          if (subscription.connected) this.emitSync(activeScope, sessionId, 'live')
        }
        void this.refreshRuntime(false, false, activeScope)
      } catch (error) {
        if (!this.isCurrentScope(scope)) return
        this.portTunnels.disposeAll()
        this.health = null
        this.validatedGeneration = null
        this.suspendTimelineSubscriptions()
        this.stopEmergencyStream()
        announcedError = error
        const message = errorText(error)
        this.setProfileRuntime(scope.profileId, {
          connectionState: 'offline',
          lastConnectionError: message,
          lastConnectionCheckedAt: Date.now()
        })
        for (const sessionId of this.timelineSubscriptions.keys()) this.emitSync(scope, sessionId, 'reconnecting', message)
        this.emitConnection(scope, false, undefined, message)
      }
    } else {
      // A rejected health request cannot authenticate the process currently
      // listening at this profile. Drop the cached capability fence on the
      // first failure so Team Hub never reuses credentials against an
      // unverified or replaced server while the ordinary reconnect UI is
      // still in its transient `retrying` state.
      this.portTunnels.disposeAll()
      this.health = null
      this.validatedGeneration = null
      this.suspendTimelineSubscriptions()
      this.stopEmergencyStream()
      this.healthFailureCount += 1
      const message = errorText(health.reason)
      announcedError = health.reason
      this.setProfileRuntime(scope.profileId, {
        connectionState: this.healthFailureCount < 2 ? 'retrying' : 'offline',
        lastConnectionError: message,
        lastConnectionCheckedAt: Date.now()
      })
      this.emitProfiles()
      for (const [sessionId, subscription] of this.timelineSubscriptions) {
        if (!subscription.connected) this.emitSync(scope, sessionId, 'reconnecting', message)
      }
      if (this.healthFailureCount >= 2 && !this.hasConnectedTimelineSubscription()) this.emitConnection(scope, false, undefined, message)
    }

    if (announcedError) {
      if (announce) throw announcedError
      return
    }
    const namespaceWasAdopted = activeScope !== scope
    if (!this.isCurrentScope(activeScope)) return
    if (
      deferApplyDuringInteraction
      && Date.now() - this.lastForegroundInteractionAt < FOREGROUND_INTERACTION_QUIET_MS
      && !await this.waitForForegroundQuiet(activeScope)
    ) return
    if (!this.isCurrentScope(activeScope)) return
    if (!namespaceWasAdopted) {
      for (const [sessionId, subscription] of [...this.timelineSubscriptions]) {
        if (subscription.connected || subscription.initializing) continue
        const lease = this.renewTimelineSubscription(sessionId)
        if (lease == null) continue
        const cachedLast = this.cache.latestEventSequence(activeScope.namespace, sessionId)
        queueMicrotask(() => void this.reconcileTimelineAndStream(activeScope, sessionId, cachedLast, lease))
      }
    }

    if (sessions.status === 'fulfilled') {
      const mergedSessions = mergePolledSessionSummaries(this.sessions, sessions.value)
      const changed = !jsonEqual(this.sessions, mergedSessions)
      this.disposeUnavailablePortTunnels(this.sessions, mergedSessions)
      this.sessions = mergedSessions
      if (changed) {
        this.cache.putSessions(activeScope.namespace, mergedSessions)
        this.scheduleSearchBackfill()
        this.emitSessions(activeScope, mergedSessions)
      }
      this.refreshProfileUnread(activeScope)
    }
    if (jobs.status === 'fulfilled') {
      const changed = !jsonEqual(this.jobs, jobs.value)
      this.jobs = jobs.value
      if (changed) {
        this.cache.putJobs(activeScope.namespace, jobs.value)
        this.emitJobs(activeScope, jobs.value)
      }
    }
    const durationMs = Date.now() - started
    const syncState = `${activeScope.profileId}:${health.status}:${sessions.status}:${jobs.status}`
    if (includeJobs || durationMs >= 250 || syncState !== this.lastSyncState) {
      appLog('sync', 'background refresh finished', {
        durationMs,
        profileId: activeScope.profileId,
        generation: activeScope.generation,
        serverId: activeScope.namespace,
        health: health.status,
        sessions: sessions.status,
        jobs: jobs.status,
        jobsPolled: includeJobs,
        sessionCount: sessions.status === 'fulfilled' ? sessions.value.length : undefined
      })
    }
    this.lastSyncState = syncState
  }

  private async refreshJobs(scope = this.captureScope(), announce = false): Promise<void> {
    // Scheduled/event-driven job reconciliation is passive. Explicit job
    // mutations set announce=true and remain immediate, but background probes
    // must not start or publish while the user is typing or scrolling.
    if (!announce && Date.now() - this.lastForegroundInteractionAt < FOREGROUND_INTERACTION_QUIET_MS) return
    if (!this.isValidatedScope(scope)) {
      if (!announce) return
      await this.refreshAll(true, false, scope)
      this.assertCurrentScope(scope)
      if (!this.isValidatedScope(scope)) throw new Error('The server profile has not passed its identity check.')
    }
    try {
      const jobs = await scope.client.jobs()
      if (!announce && !await this.waitForForegroundQuiet(scope)) return
      if (!this.isCurrentScope(scope)) {
        if (announce) throw staleProfileError()
        return
      }
      if (!jsonEqual(this.jobs, jobs)) {
        this.jobs = jobs
        this.cache.putJobs(scope.namespace, jobs)
        this.emitJobs(scope, jobs)
      }
    } catch (error) {
      if (announce) throw error
      if (this.isCurrentScope(scope)) appLog('jobs', 'background refresh failed', { profileId: scope.profileId, error: errorText(error) })
    }
  }

  private refreshRuntime(force = false, forceProbe = false, scope = this.captureScope(), announce = false): Promise<void> {
    if (!this.isValidatedScope(scope)) return Promise.resolve()
    const existing = this.runtimeRefreshInFlight.get(scope.generation)
    if (existing) {
      if (!forceProbe || existing.forceProbe) return existing.task
      return existing.task.then(() => this.refreshRuntime(true, true, scope, announce))
    }
    // Checked before the refresh window so it cannot be suppressed by a
    // later cache load pushing runtimeRefreshNextAt back out: the server
    // process changed, so re-probe the CLIs rather than trusting diagnostics
    // the previous process had cached.
    if (this.runtimeInstanceProbePending) {
      this.runtimeInstanceProbePending = false
      force = true
      forceProbe = true
    }
    if (!force && Date.now() < this.runtimeRefreshNextAt) return Promise.resolve()
    const task = this.loadRuntimeCatalog(scope, forceProbe, announce)
    this.runtimeRefreshInFlight.set(scope.generation, { task, forceProbe })
    return task.finally(() => {
      if (this.runtimeRefreshInFlight.get(scope.generation)?.task === task) this.runtimeRefreshInFlight.delete(scope.generation)
    })
  }

  private async loadRuntimeCatalog(scope: ConnectionScope, forceProbe = false, announce = false): Promise<void> {
    const started = Date.now()
    try {
      const catalog = await scope.client.runtimeCatalog(forceProbe)
      if (!this.isCurrentScope(scope)) return
      if (!runtimeCatalogHasSelectableModels(catalog)) {
        throw new Error('Server returned no selectable Claude/Codex models')
      }
      this.runtimeCatalog = catalog
      this.cache.putPreference(scope.namespace, RUNTIME_CATALOG_CACHE_KEY, catalog)
      this.runtimeRefreshNextAt = Date.now() + RUNTIME_CATALOG_REFRESH_MS
      this.emitRuntime(scope, catalog)
      appLog('runtime', 'catalog refreshed', {
        durationMs: Date.now() - started,
        profileId: scope.profileId,
        generation: scope.generation,
        serverId: scope.namespace,
        claudeModels: catalog.backends.claude.models.filter(option => option.value).length,
        codexModels: catalog.backends.codex.models.filter(option => option.value).length,
        claudeSource: catalog.backends.claude.model_source,
        codexSource: catalog.backends.codex.model_source
      })
    } catch (error) {
      if (!this.isCurrentScope(scope)) return
      this.runtimeRefreshNextAt = Date.now() + RUNTIME_CATALOG_RETRY_MS
      appLog('runtime', 'catalog refresh failed; retaining cached choices', {
        durationMs: Date.now() - started,
        profileId: scope.profileId,
        serverId: scope.namespace,
        cached: Boolean(this.runtimeCatalog),
        error: errorText(error)
      })
      if (announce) throw error
    }
  }

  /** Invalidate the cached model list when the server process changes.
   *
   * Upgrading a provider CLI (say `codex update`) only takes effect for a
   * fresh server process, and the catalog is cached for 15 minutes on disk -
   * so after restarting the server the app kept showing the old model list
   * and a newly released model looked missing. A new instance id is the
   * server telling us it is a different process, which is exactly when that
   * cache cannot be trusted.
   */
  private noteServerInstanceForRuntime(health: Health): void {
    const instanceId = health.server_instance_id?.trim() || null
    if (!instanceId) return
    if (this.runtimeCatalogInstanceId && instanceId !== this.runtimeCatalogInstanceId) {
      this.runtimeRefreshNextAt = 0
      this.runtimeInstanceProbePending = true
    }
    this.runtimeCatalogInstanceId = instanceId
  }

  private adoptHealth(scope: ConnectionScope, health: Health): ConnectionScope {
    this.assertCurrentScope(scope)
    this.noteServerInstanceForRuntime(health)
    if (this.profileResetIsPending(scope)) {
      throw new Error('This server profile is waiting for its prior identity reset to finish.')
    }
    const profile = this.settings.getProfile(scope.profileId)
    if (!profile) throw new Error(`Unknown server profile: ${scope.profileId}`)
    const previousIdentity = profile.serverIdentity?.trim() || null
    const identity = health.server_identity?.trim() || null
    if (previousIdentity && identity !== previousIdentity) {
      throw new Error(`Server identity changed from ${previousIdentity} to ${identity ?? 'an unverified server'}. Confirm the change before reconnecting this profile.`)
    }
    if (identity) {
      const duplicate = this.settings.listProfiles().find(candidate => candidate.id !== scope.profileId && candidate.serverIdentity === identity)
      if (duplicate) throw new Error(`Server identity ${identity} already belongs to “${duplicate.name}”.`)
    }
    if (identity && identity !== scope.namespace) {
      this.flushEventCache()
      this.settings.setProfileServerIdentity(scope.profileId, identity)
      try {
        this.cache.mergeServerNamespace(scope.namespace, identity)
      } catch (error) {
        this.settings.setProfileServerIdentity(scope.profileId, previousIdentity)
        if (error instanceof CacheNamespaceCollisionError) {
          throw new Error(`The canonical server cache conflicts with ${error.sessionIds.length} cached chat${error.sessionIds.length === 1 ? '' : 's'}. The profile was not rebound.`)
        }
        throw error
      }
      scope = this.replaceScopeNamespace(scope, identity)
    }
    this.settings.markProfileServerSetupComplete(scope.profileId, identity)
    const serverVersion = health.server_version?.trim() || null
    if (serverVersion) {
      this.cache.putPreference(scope.namespace, SERVER_VERSION_CACHE_KEY, serverVersion)
      this.setProfileRuntime(scope.profileId, { serverVersion })
    }
    this.health = health
    this.validatedGeneration = scope.generation
    if (!portForwardingCapabilityAvailable(health)) this.portTunnels.disposeAll()
    return scope
  }

  private async reconcileTimelineAndStream(scope: ConnectionScope, sessionId: string, cachedLast: number, lease: number): Promise<void> {
    if (!this.isValidatedScope(scope)) {
      this.finishTimelineInitialization(sessionId, lease)
      return
    }
    const reconcileKey = `${scope.generation}:${sessionId}:${lease}`
    if (this.timelineReconcileInFlight.has(reconcileKey)) return
    this.timelineReconcileInFlight.add(reconcileKey)
    try {
      const before = this.cache.snapshot(scope.namespace, sessionId)
      const timelineState = this.cache.timelineState(scope.namespace, sessionId)
      const initialRequestIsSemantic = cachedLast <= 0
      const needsCompletenessAudit = Boolean(
        before
        && cachedLast > 0
        && (
          timelineState?.pagingSchemaVersion !== TIMELINE_PAGING_SCHEMA_VERSION
          || (
            timelineState.semanticPaging === false
            && this.semanticTimelineCapabilityChanged(scope)
          )
        )
      )
      const pageRequest = cachedLast > 0
        ? scope.client.sessionPage(sessionId, { after: cachedLast, limit: DELTA_EVENT_LIMIT, tail: false, visible: true })
        : this.semanticTimelinePage(scope, sessionId, {
          limit: INITIAL_SEMANTIC_ITEM_LIMIT, tail: true, visible: true
        })
      const [deltaPage, auditPage] = await Promise.all([
        pageRequest,
        needsCompletenessAudit
          ? this.semanticTimelinePage(scope, sessionId, {
            limit: INITIAL_SEMANTIC_ITEM_LIMIT, tail: true, visible: true
          })
          : Promise.resolve(null)
      ])
      let page = deltaPage
      let pageWasSemanticAttempt = initialRequestIsSemantic
      if (!this.isCurrentTimeline(scope, sessionId, lease)) return

      let mode: 'merge' | 'replace' = initialRequestIsSemantic ? 'replace' : 'merge'
      if (auditPage) {
        pageWasSemanticAttempt = true
        const auditSucceeded = semanticAttemptSucceeded(auditPage)
        page = auditSucceeded ? auditPage : {
          ...auditPage,
          session: deltaPage.session,
          events: mergeEventsBySequence(auditPage.events, deltaPage.events),
          queued_turns: deltaPage.queued_turns ?? auditPage.queued_turns,
          latest_seq: Math.max(auditPage.latest_seq ?? 0, deltaPage.latest_seq ?? 0) || null
        }
        mode = auditSucceeded ? 'replace' : 'merge'
        appLog('timeline', auditSucceeded
          ? 'replacing unverified legacy cache from semantic audit'
          : 'merging repaired legacy tail after semantic audit fallback', {
          sessionId,
          semanticItems: auditPage.semantic_item_count,
          tailEvents: auditPage.events.length
        })
      } else if ((page.events_omitted_after ?? 0) > 0 || (page.latest_seq ?? cachedLast) < cachedLast) {
        page = await this.semanticTimelinePage(scope, sessionId, {
          limit: INITIAL_SEMANTIC_ITEM_LIMIT, tail: true, visible: true
        })
        pageWasSemanticAttempt = true
        if (!this.isCurrentTimeline(scope, sessionId, lease)) return
        mode = 'replace'
      }
      this.cache.putSession(scope.namespace, page.session)
      this.rememberSessionDetail(scope, page.session)
      if (mode === 'replace') this.cache.replaceEvents(scope.namespace, sessionId, page.events)
      else this.cache.putEvents(scope.namespace, sessionId, page.events)
      this.cache.putQueuedTurns(scope.namespace, sessionId, page.queued_turns ?? [])
      const hasMoreEvents = mode === 'replace'
        ? Boolean(page.has_more)
        : cachedLast === 0 ? Boolean(page.has_more || auditPage?.has_more) : Boolean(before?.hasMoreEvents || page.has_more || auditPage?.has_more)
      const verifiedLatestSeq = mode === 'replace' ? page.latest_seq : auditPage?.latest_seq
      const knownTotal = mode === 'replace' ? page.total : auditPage?.total
      const nextTimelineBefore = mode === 'replace'
        ? timelinePageNextBefore(page)
        : auditPage && semanticAttemptSucceeded(auditPage)
          ? timelinePageNextBefore(auditPage)
          : undefined
      this.cache.putTimelineState(
        scope.namespace,
        sessionId,
        hasMoreEvents,
        verifiedLatestSeq,
        knownTotal,
        nextTimelineBefore,
        pageWasSemanticAttempt ? semanticAttemptSucceeded(page) : undefined
      )
      const semanticPaging = pageWasSemanticAttempt
        ? semanticAttemptSucceeded(page)
        : before?.semanticPaging ?? null
      const snapshot: SessionSnapshot = mode === 'replace' ? { ...(this.cache.snapshot(scope.namespace, sessionId) ?? {
        session: page.session,
        events: page.events,
        queuedTurns: page.queued_turns ?? [],
        files: before?.files ?? [],
        hasMoreEvents,
        eventsTotal: knownTotal ?? before?.eventsTotal ?? null,
        nextTimelineBefore: nextTimelineBefore !== undefined
          ? nextTimelineBefore
          : before?.nextTimelineBefore ?? null,
        semanticPaging,
        filesTotal: before?.filesTotal ?? 0,
        cachedAt: Date.now()
      }), historyVerified: true } : {
        session: page.session,
        events: page.events,
        queuedTurns: page.queued_turns ?? [],
        files: [],
        hasMoreEvents,
        historyVerified: true,
        eventsTotal: before?.eventsTotal ?? auditPage?.total ?? null,
        nextTimelineBefore: nextTimelineBefore !== undefined
          ? nextTimelineBefore
          : before?.nextTimelineBefore ?? null,
        semanticPaging,
        filesTotal: before?.filesTotal ?? 0,
        cachedAt: Date.now(),
        viewState: before?.viewState
      }
      const changed = page.events.length > 0
        || before?.hasMoreEvents !== snapshot.hasMoreEvents
        || before?.eventsTotal !== snapshot.eventsTotal
        || before?.nextTimelineBefore !== snapshot.nextTimelineBefore
        || before?.semanticPaging !== snapshot.semanticPaging
        || !jsonEqual(before?.queuedTurns ?? [], snapshot.queuedTurns)
        || !jsonEqual(before?.session, snapshot.session)
      if (changed) this.emit('server:timeline', {
        sessionId, snapshot, source: 'server', mode, profileId: scope.profileId, profileGeneration: scope.generation
      })
      const streamAfter = page.latest_seq ?? page.events.at(-1)?.seq ?? cachedLast
      this.activateTimelineStream(scope, sessionId, streamAfter, lease)
      this.scheduleSubagentSnapshotRefresh(scope, sessionId, lease)
      queueMicrotask(() => void this.refreshTimelineFiles(scope, sessionId))
    } catch (error) {
      appLog('timeline', 'tail refresh failed; keeping cached transcript', { sessionId, error: errorText(error) })
      if (this.isCurrentTimeline(scope, sessionId, lease)) this.activateTimelineStream(scope, sessionId, cachedLast, lease)
    } finally {
      this.finishTimelineInitialization(sessionId, lease)
      this.timelineReconcileInFlight.delete(reconcileKey)
    }
  }

  private async fetchTimeline(scope: ConnectionScope, sessionId: string, lease: number): Promise<SessionSnapshot> {
    await this.ensureValidatedScope(scope)
    const page = await this.semanticTimelinePage(scope, sessionId, {
      limit: INITIAL_SEMANTIC_ITEM_LIMIT, tail: true, visible: true
    })
    if (!this.isCurrentTimeline(scope, sessionId, lease)) throw new Error('Timeline selection superseded')
    this.cache.putSession(scope.namespace, page.session)
    this.rememberSessionDetail(scope, page.session)
    this.cache.replaceEvents(scope.namespace, sessionId, page.events)
    this.cache.putQueuedTurns(scope.namespace, sessionId, page.queued_turns ?? [])
    const nextTimelineBefore = timelinePageNextBefore(page)
    const semanticPaging = semanticAttemptSucceeded(page)
    this.cache.putTimelineState(
      scope.namespace,
      sessionId,
      Boolean(page.has_more),
      page.latest_seq,
      page.total,
      nextTimelineBefore,
      semanticPaging
    )
    const cached = this.cache.snapshot(scope.namespace, sessionId)
    if (!this.isCurrentTimeline(scope, sessionId, lease)) throw new Error('Timeline selection superseded')
    this.activateTimelineStream(scope, sessionId, page.latest_seq ?? page.events.at(-1)?.seq ?? 0, lease)
    this.scheduleSubagentSnapshotRefresh(scope, sessionId, lease)
    queueMicrotask(() => void this.refreshTimelineFiles(scope, sessionId, true))
    return cached ? {
      ...cached,
      session: page.session,
      queuedTurns: page.queued_turns ?? [],
      hasMoreEvents: Boolean(page.has_more),
      historyVerified: true,
      eventsTotal: page.total ?? cached.eventsTotal ?? null,
      nextTimelineBefore,
      semanticPaging,
      cachedAt: Date.now()
    } : {
      session: page.session,
      events: page.events,
      queuedTurns: page.queued_turns ?? [],
      files: [],
      hasMoreEvents: Boolean(page.has_more),
      historyVerified: true,
      eventsTotal: page.total ?? null,
      nextTimelineBefore,
      semanticPaging,
      filesTotal: 0,
      cachedAt: Date.now()
    }
  }

  private async fetchSubagentSnapshot(
    scope: ConnectionScope,
    sessionId: string
  ): Promise<SubagentSnapshot | null> {
    const key = `${scope.generation}:${sessionId}`
    const existing = this.subagentSnapshotInFlight.get(key)
    if (existing) return existing
    const task = (async (): Promise<SubagentSnapshot | null> => {
      try {
        const snapshot = await scope.client.subagents(sessionId)
        this.assertCurrentScope(scope)
        return snapshot
      } catch (error) {
        if (error instanceof ServerError && [404, 405, 501].includes(error.status)) return null
        appLog('timeline', 'subagent snapshot refresh failed', {
          sessionId,
          error: errorText(error)
        })
        return null
      }
    })()
    this.subagentSnapshotInFlight.set(key, task)
    void task.finally(() => {
      if (this.subagentSnapshotInFlight.get(key) === task) this.subagentSnapshotInFlight.delete(key)
    })
    return task
  }

  private scheduleSubagentSnapshotRefresh(
    scope: ConnectionScope,
    sessionId: string,
    lease: number
  ): void {
    queueMicrotask(() => {
      void this.refreshSubagentSnapshot(scope, sessionId, lease).catch(error => {
        appLog('timeline', 'background subagent snapshot persistence failed', {
          profileId: scope.profileId,
          generation: scope.generation,
          sessionId,
          error: errorText(error)
        })
      })
    })
  }

  private async refreshSubagentSnapshot(
    scope: ConnectionScope,
    sessionId: string,
    lease: number
  ): Promise<void> {
    const session = this.cache.snapshot(scope.namespace, sessionId)?.session
    if (session?.backend !== 'codex') return
    const subagents = await this.fetchSubagentSnapshot(scope, sessionId)
    if (!subagents || !this.isCurrentTimeline(scope, sessionId, lease)) return
    const persistable = persistableSubagentSnapshotEvents(subagents, sessionId)
    if (persistable.dropped > 0) appLog('timeline', 'discarded malformed subagent snapshot events', {
      profileId: scope.profileId,
      generation: scope.generation,
      sessionId,
      dropped: persistable.dropped
    })
    if (!persistable.events.length) return
    this.cache.putEvents(scope.namespace, sessionId, persistable.events)
    const snapshot = this.cache.snapshot(scope.namespace, sessionId)
    if (!snapshot || !this.isCurrentTimeline(scope, sessionId, lease)) return
    this.emit('server:timeline', {
      sessionId,
      snapshot,
      source: 'server',
      mode: 'merge',
      profileId: scope.profileId,
      profileGeneration: scope.generation
    })
  }

  private async refreshTimelineFiles(scope: ConnectionScope, sessionId: string, force = false): Promise<void> {
    if (!this.isValidatedScope(scope)) return
    const key = `${scope.generation}:${sessionId}`
    if (this.filesRefreshInFlight.has(key)) return
    if (!force && Date.now() - (this.filesRefreshedAt.get(key) ?? 0) < 30_000) return
    this.filesRefreshInFlight.add(key)
    try {
      const before = this.cache.files(scope.namespace, sessionId, FILE_PAGE_LIMIT)
      const page = sessionOwnedFilesPage(
        await scope.client.files(sessionId, 0, FILE_PAGE_LIMIT),
        sessionId
      )
      if (!this.isCurrentScope(scope)) return
      this.cache.putFiles(scope.namespace, sessionId, page.files)
      this.filesRefreshedAt.set(key, Date.now())
      if (!jsonEqual(before, page.files)) this.emit('server:files', {
        sessionId, files: page.files, total: page.total, profileId: scope.profileId, profileGeneration: scope.generation
      })
    } catch (error) {
      if (this.isCurrentScope(scope)) appLog('files', 'background timeline file refresh failed', { sessionId, error: errorText(error) })
    } finally {
      this.filesRefreshInFlight.delete(key)
    }
  }

  private applyEventToCaches(scope: ConnectionScope, event: Event): void {
    this.applyEventsToCaches(scope, event.session_id, [event])
  }

  private applyEventsToCaches(scope: ConnectionScope, sessionId: string, events: readonly Event[]): void {
    if (!events.length) return
    let queued: QueuedTurn[] | null = null
    let nextQueued: QueuedTurn[] | null = null
    let shouldRefreshQueue = false
    let files: Map<string, AgentFile> | null = null

    for (const event of events) {
      if (QUEUE_CACHE_EVENT_TYPES.has(event.type) || event.positions) {
        if (!queued) {
          queued = this.cache.queuedTurns(scope.namespace, sessionId)
          nextQueued = queued
        }
        if (event.type === 'queue_snapshot' && event.positions && !nextQueued?.length) {
          shouldRefreshQueue = true
        }
        nextQueued = updateQueuedTurns(nextQueued ?? [], event)
      }
      const safe = isolateSessionEvent(event, sessionId)
      if (!safe) continue
      if (safe.file || safe.artifact) files ??= new Map()
      if (safe.file) files?.set(safe.file.id, safe.file)
      if (safe.artifact) files?.set(safe.artifact.id, safe.artifact)
    }

    if (queued && nextQueued && nextQueued !== queued) {
      this.cache.putQueuedTurns(scope.namespace, sessionId, nextQueued)
    }
    if (files?.size) this.cache.putFiles(scope.namespace, sessionId, [...files.values()])
    if (shouldRefreshQueue && this.isCurrentScope(scope)) void this.queue(sessionId)
  }

  private isCurrentTimeline(scope: ConnectionScope, sessionId: string, lease: number): boolean {
    return this.isCurrentScope(scope) && this.timelineSubscriptions.get(sessionId)?.lease === lease
  }

  private enqueueEventCache(scope: ConnectionScope, event: Event): void {
    const key = `${scope.generation}:${event.session_id}`
    const pending = this.pendingEventCache.get(key) ?? { scope, sessionId: event.session_id, events: [] }
    pending.events.push(event)
    this.pendingEventCache.set(key, pending)
    if (!this.eventCacheTimer) {
      this.eventCacheTimer = setTimeout(() => this.flushEventCache(), EVENT_CACHE_FLUSH_MS)
    }
  }

  private flushEventCache(): void {
    if (this.eventCacheTimer) clearTimeout(this.eventCacheTimer)
    this.eventCacheTimer = null
    const pending = this.pendingEventCache
    this.pendingEventCache = new Map()
    for (const { scope, sessionId, events } of pending.values()) {
      try {
        this.cache.putEvents(scope.namespace, sessionId, events)
        this.applyEventsToCaches(scope, sessionId, events)
      } catch (error) {
        appLog('cache', 'failed to persist streamed events', {
          profileId: scope.profileId, generation: scope.generation, sessionId, count: events.length, error: errorText(error)
        })
      }
    }
  }

  private async codexRequest<T>(request: (scope: ConnectionScope) => Promise<T>): Promise<T> {
    return this.providerRequest(request)
  }

  private async providerRequest<T>(request: (scope: ConnectionScope) => Promise<T>): Promise<T> {
    const scope = this.captureScope()
    await this.ensureValidatedScope(scope)
    const result = await request(scope)
    this.assertCurrentScope(scope)
    return result
  }

  private pinSyncContext(scope: ConnectionScope, sessionId: string): PinSyncContext {
    return {
      queueKey: `${scope.profileId}:${scope.generation}:${sessionId}`,
      sessionId,
      namespace: () => scope.namespace,
      connect: async () => {
        await this.ensureValidatedScope(scope)
        this.assertCurrentScope(scope)
        const capability = this.health?.capabilities?.pinned_items
        if (!(capability?.available === true && Number(capability.version) >= 1)) return null
        const checked = async <T>(operation: Promise<T>): Promise<T> => {
          const result = await operation
          this.assertCurrentScope(scope)
          return result
        }
        return {
          list: requestedSessionId => checked(scope.client.pinnedItems(requestedSessionId)),
          put: (item, expectedRevision) => checked(scope.client.putPinnedItem(item, expectedRevision)),
          remove: (requestedSessionId, itemId, expectedRevision) => (
            checked(scope.client.removePinnedItem(requestedSessionId, itemId, expectedRevision))
          )
        }
      },
      assertCurrent: () => this.assertCurrentScope(scope),
      isCurrent: () => this.isCurrentScope(scope),
      shouldDefer: pinSyncCanDefer,
      prepareLegacy: item => normalizePinnedItemForSync(item, sessionId),
      deferred: error => appLog('pins', 'server sync deferred; retaining local pin state', {
        profileId: scope.profileId,
        sessionId,
        error: errorText(error)
      })
    }
  }

  private async refreshPinsFromNotice(scope: ConnectionScope, sessionId: string, minimumRevision?: number): Promise<void> {
    try {
      const context = this.pinSyncContext(scope, sessionId)
      const pins = await this.pinSync.list(context, minimumRevision)
      this.assertCurrentScope(scope)
      this.emit('server:pins', {
        profileId: scope.profileId,
        profileGeneration: scope.generation,
        serverIdentity: this.settings.getProfile(scope.profileId)?.serverIdentity ?? null,
        sessionId,
        pins,
        revision: this.pinSync.revision(context)
      })
    } catch (error) {
      if (this.isCurrentScope(scope)) appLog('pins', 'live pin refresh was superseded or failed', {
        profileId: scope.profileId,
        sessionId,
        error: errorText(error)
      })
    }
  }

  private captureScope(): ConnectionScope { return this.scope }

  private profileScopeMatches(profileId: string, profileGeneration: number): boolean {
    const scope = this.captureScope()
    return scope.profileId === profileId && scope.generation === profileGeneration
  }

  private requireProfileScope(profileId: string, profileGeneration: number): ConnectionScope {
    const scope = this.captureScope()
    if (scope.profileId !== profileId || scope.generation !== profileGeneration) throw staleProfileError()
    return scope
  }

  private requireWorkspaceScope(expected: WorkspaceProfileScope): ConnectionScope {
    const scope = this.requireProfileScope(expected.profileId, expected.profileGeneration)
    const identity = this.settings.getProfile(scope.profileId)?.serverIdentity ?? null
    if (identity !== (expected.serverIdentity ?? null)) throw staleProfileError()
    return scope
  }

  private isCurrentScope(scope: ConnectionScope): boolean {
    return this.scope === scope && this.profileGeneration === scope.generation && this.activeProfileId === scope.profileId
  }

  private isValidatedScope(scope: ConnectionScope): boolean {
    return this.isCurrentScope(scope) && this.validatedGeneration === scope.generation
  }

  private assertCurrentScope(scope: ConnectionScope): void {
    if (!this.isCurrentScope(scope)) throw staleProfileError()
  }

  private captureRendererGrantEpoch(rendererId: number): number {
    if (!Number.isSafeInteger(rendererId) || rendererId <= 0) throw new Error('The upload renderer is invalid.')
    const epoch = this.rendererGrantEpochs.get(rendererId)
    if (epoch === undefined) throw new Error('The upload renderer is no longer available.')
    return epoch
  }

  private assertRendererGrantEpoch(rendererId: number, epoch: number): void {
    if (this.rendererGrantEpochs.get(rendererId) !== epoch) {
      throw new Error('The upload renderer changed before the file operation completed.')
    }
  }

  private invalidateRendererFileGrants(rendererId: number, destroyed: boolean): void {
    if (!Number.isSafeInteger(rendererId) || rendererId <= 0) return
    this.abortRendererFileOperations(rendererId)
    this.fileUploadGrants.revokeRenderer(rendererId)
    if (destroyed) this.rendererGrantEpochs.delete(rendererId)
    else this.rendererGrantEpochs.set(rendererId, (this.rendererGrantEpochs.get(rendererId) ?? 0) + 1)
  }

  private beginRendererFileOperation(rendererId: number, epoch: number): {
    signal: AbortSignal
    release: () => void
  } {
    this.assertRendererGrantEpoch(rendererId, epoch)
    const controller = new AbortController()
    const controllers = this.rendererFileOperations.get(rendererId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.rendererFileOperations.set(rendererId, controllers)
    let released = false
    return {
      signal: controller.signal,
      release: () => {
        if (released) return
        released = true
        controllers.delete(controller)
        if (!controllers.size && this.rendererFileOperations.get(rendererId) === controllers) {
          this.rendererFileOperations.delete(rendererId)
        }
      }
    }
  }

  private abortRendererFileOperations(rendererId: number): void {
    const controllers = this.rendererFileOperations.get(rendererId)
    if (!controllers) return
    this.rendererFileOperations.delete(rendererId)
    for (const controller of controllers) controller.abort(new Error('The upload renderer is no longer available.'))
    controllers.clear()
  }

  private abortAllRendererFileOperations(): void {
    let firstError: unknown
    for (const rendererId of [...this.rendererFileOperations.keys()]) {
      try { this.abortRendererFileOperations(rendererId) }
      catch (error) { firstError ??= error }
    }
    if (firstError) throw firstError
  }

  private ensureClipboardStagingDirectory(): string {
    const existing = this.clipboardStagingDirectory
    if (existing && existsSync(existing)) return existing
    this.scavengeStaleClipboardDirectories()
    const directory = mkdtempSync(join(this.clipboardTempRoot, 'AgentsDockClipboard-'))
    chmodSync(directory, 0o700)
    this.clipboardStagingDirectory = directory
    return directory
  }

  private scavengeStaleClipboardDirectories(): void {
    if (this.clipboardStagingScavenged) return
    this.clipboardStagingScavenged = true
    const currentUid = process.getuid?.()
    const windows = process.platform === 'win32'
    // Windows does not expose POSIX ownership or mode bits through Node. Its
    // per-user temp directory supplies the ownership boundary instead.
    if (!windows && currentUid === undefined) return
    let names: string[]
    try { names = readdirSync(this.clipboardTempRoot) } catch { return }
    const cutoff = Date.now() - STALE_CLIPBOARD_DIRECTORY_AGE_MS
    for (const name of names) {
      if (!/^AgentsDockClipboard-[A-Za-z0-9]{6}$/.test(name)) continue
      const directory = join(this.clipboardTempRoot, name)
      try {
        const info = lstatSync(directory)
        if (
          !info.isDirectory()
          || info.isSymbolicLink()
          || (!windows && (
            info.uid !== currentUid
            || (info.mode & 0o077) !== 0
            || (info.mode & 0o700) !== 0o700
          ))
          || info.mtimeMs > cutoff
        ) continue
        rmSync(directory, { recursive: true, force: true })
      } catch { /* stale staging cleanup is best effort */ }
    }
  }

  private retainStagedClipboardFile(path: string): () => void {
    const staged = this.stagedClipboardFiles.get(path)
    if (!staged) return () => undefined
    staged.activeUses += 1
    let released = false
    return () => {
      if (released) return
      released = true
      staged.activeUses = Math.max(0, staged.activeUses - 1)
      if (staged.cleanupRequested && staged.activeUses === 0) this.removeStagedClipboardFile(staged)
    }
  }

  private requestStagedClipboardCleanup(path: string): void {
    const staged = this.stagedClipboardFiles.get(path)
    if (!staged) {
      rmSync(path, { force: true })
      return
    }
    staged.cleanupRequested = true
    if (staged.activeUses === 0) this.removeStagedClipboardFile(staged)
  }

  private removeStagedClipboardFile(staged: StagedClipboardFile): void {
    if (this.stagedClipboardFiles.get(staged.path) !== staged) return
    this.stagedClipboardFiles.delete(staged.path)
    rmSync(staged.path, { force: true })
  }

  private removeClipboardStagingDirectory(): void {
    const directory = this.clipboardStagingDirectory
    this.clipboardStagingDirectory = null
    this.stagedClipboardFiles.clear()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }

  private async ensureValidatedScope(scope: ConnectionScope): Promise<void> {
    if (this.profileResetIsPending(scope)) {
      throw new Error('This server profile is waiting for its prior identity reset to finish. Retry the identity reset before reconnecting.')
    }
    if (this.isValidatedScope(scope)) return
    await this.refreshAll(true, false, scope)
    this.assertCurrentScope(scope)
    if (!this.isValidatedScope(scope)) throw new Error('The server profile has not passed its identity check.')
  }

  private activateProfile(
    profileId: string,
    persist: boolean,
    force: boolean,
    preparedClient?: AgentServerClient,
    afterPreviousScopeRetired?: () => void,
    namespaceOverride?: string,
    resetPendingNamespaces?: readonly string[]
  ): ConnectionScope {
    this.requireProfileNotRemoving(profileId)
    let profile = this.settings.getProfile(profileId)
    if (!profile) {
      preparedClient?.dispose()
      throw new Error(`Unknown server profile: ${profileId}`)
    }
    if (!force && profileId === this.activeProfileId) {
      preparedClient?.dispose()
      return this.captureScope()
    }
    this.profileSelectionIntent += 1

    this.invalidateProfileHealthProbe(profileId)
    const nextServerUrl = this.settings.serverUrl(profileId)
    const nextClient = preparedClient ?? this.clientFactory(nextServerUrl, this.settings.accessToken(profileId))
    if (persist) {
      try { this.settings.setActiveProfile(profileId) }
      catch (error) {
        try { nextClient.dispose() } catch { /* prospective cleanup is best effort */ }
        throw error
      }
    }

    const previous = this.captureScope()
    this.profileTransitionWarning = null
    this.profileGeneration += 1
    this.cancelBackgroundApplyQuietWaiters()
    this.profileResetPending = resetPendingNamespaces
      ? { profileId, generation: this.profileGeneration, retiredNamespaces: [...resetPendingNamespaces] }
      : null
    let retirementError: unknown
    const retire = (operation: () => void): void => {
      retirementError = attemptCleanup(retirementError, operation)
    }
    // The generation fence is already active. From here onward every old
    // resource is retired independently so one hostile/buggy close callback
    // cannot prevent a coherent replacement scope from being installed.
    retire(() => this.flushEventCache())
    retire(() => this.closeAllTimelineSubscriptions())
    retire(() => this.stopEmergencyStream())
    this.focusedSessionId = null
    retire(() => this.disconnectAllTerminals())
    this.terminalLeases.clear()
    retire(() => this.portTunnels.disposeAll())
    retire(() => this.subagentProjector.reset())
    retire(() => this.abortAllRendererFileOperations())
    const previousClientAvailable = this.clientAvailable
    this.clientAvailable = false
    if (previousClientAvailable && previous.client !== nextClient) retire(() => previous.client.dispose())
    if (this.eventCacheTimer) clearTimeout(this.eventCacheTimer)
    this.eventCacheTimer = null
    this.pendingEventCache.clear()
    this.refreshInFlight.clear()
    this.runtimeRefreshInFlight.clear()
    this.subagentSnapshotInFlight.clear()
    this.filesRefreshInFlight.clear()
    this.filesRefreshedAt.clear()
    this.fileDownloads.clear()
    retire(() => this.fileUploadGrants.clear())
    retire(() => this.removeClipboardStagingDirectory())
    this.timelineIndexes.clear()
    if (this.searchBackfillTimer) clearTimeout(this.searchBackfillTimer)
    this.searchBackfillTimer = null
    this.healthFailureCount = 0
    this.validatedGeneration = null
    this.lastSyncState = ''
    this.runtimeRefreshNextAt = 0

    let transitionError: unknown
    if (afterPreviousScopeRetired) {
      try { afterPreviousScopeRetired() }
      catch (error) { transitionError = error }
    }
    try {
      const persistedProfile = this.settings.getProfile(profileId)
      if (!persistedProfile) throw new Error(`Unknown server profile: ${profileId}`)
      profile = persistedProfile
    } catch (error) {
      transitionError ??= error
    }

    this.activeProfileId = profileId
    this.serverId = namespaceOverride ?? profileNamespace(profile)
    this.client = nextClient
    this.clientAvailable = true
    this.scope = {
      profileId,
      generation: this.profileGeneration,
      serverUrl: nextServerUrl,
      namespace: this.serverId,
      client: nextClient
    }
    let installationError: unknown
    try {
      if (resetPendingNamespaces) {
        this.sessions = []
        this.jobs = []
        this.runtimeCatalog = null
        this.health = null
        this.focusedSessionId = null
      } else {
        this.loadScopeCache(this.scope)
      }
    }
    catch (error) {
      installationError = error
      this.sessions = []
      this.jobs = []
      this.runtimeCatalog = null
      this.health = null
      this.focusedSessionId = null
    }
    try {
      this.setProfileRuntime(profileId, {
        connectionState: 'connecting',
        lastConnectionError: null,
        lastConnectionCheckedAt: null
      })
      this.emitProfiles()
      this.scheduleSearchBackfill()
      if (this.running) queueMicrotask(() => this.requestInactiveProfileHealthSweep())
    } catch (error) {
      installationError ??= error
    }
    const activationError = transitionError ?? retirementError ?? installationError
    if (activationError) {
      this.recordProfileTransitionWarning(transitionError
        ? `The server profile reopened, but its prior identity could not be reset safely: ${errorText(activationError)}`
        : installationError
          ? `The server profile changed, but its local cache could not be loaded: ${errorText(activationError)}`
          : `The server profile changed, but an old connection resource could not be closed cleanly: ${errorText(activationError)}`)
      appLog('profiles', 'profile activated with a retirement error', {
        profileId,
        generation: this.profileGeneration,
        error: errorText(activationError)
      })
    }
    return this.scope
  }

  private recordProfileTransitionWarning(message: string): void {
    this.profileTransitionWarning = this.profileTransitionWarning
      ? `${this.profileTransitionWarning} ${message}`
      : message
  }

  private async cleanupRetiredProfileAuthority(
    profileId: string,
    retiredNamespaces: readonly string[]
  ): Promise<string | null> {
    const namespaces = [...new Set([
      ...(this.pendingProfileAuthorityNamespaces.get(profileId) ?? []),
      ...retiredNamespaces
    ].map(value => value.trim()).filter(Boolean))]
    const cleanup = (async (): Promise<string | null> => {
      const failures: string[] = []
      try {
        // A reset is already durably committed before this helper is entered.
        // Never invoke the returned rollback handle: restoring the retired Hub
        // binding after cache deletion would re-establish stale authority.
        const result = await this.removeTeamHubProfile(profileId)
        if (result?.cleanupWarning) failures.push(result.cleanupWarning)
      } catch (error) {
        failures.push(`Teamspace cleanup failed: ${errorText(error)}`)
      }
      try {
        this.cache.removeServerNamespaces(namespaces)
      } catch (error) {
        failures.push(`workspace cache cleanup failed: ${errorText(error)}`)
      }
      if (failures.length) {
        this.pendingProfileAuthorityNamespaces.set(profileId, namespaces)
        return failures.join(' ')
      }
      try {
        this.settings.setRetiredServerNamespaces(profileId, [])
        this.pendingProfileAuthorityNamespaces.delete(profileId)
      } catch (error) {
        this.pendingProfileAuthorityNamespaces.set(profileId, namespaces)
        return `retired cache cleanup state could not be cleared: ${errorText(error)}`
      }
      return null
    })()
    return cleanup
  }

  private withProfileAuthorityOperation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.profileAuthorityOperations.get(profileId) ?? null
    let release!: () => void
    const own = new Promise<void>(resolve => { release = resolve })
    this.profileAuthorityOperations.set(profileId, own)
    const run = async (): Promise<T> => {
      // The reservation is installed synchronously before any await. If this
      // is the first caller, invoke the operation immediately so rapid UI
      // switches retain their existing last-call-wins lifecycle semantics.
      if (previous) await previous
      try {
        return await operation()
      } finally {
        release()
        if (this.profileAuthorityOperations.get(profileId) === own) {
          this.profileAuthorityOperations.delete(profileId)
        }
      }
    }
    return run()
  }

  private profileResetIsPending(scope: ConnectionScope): boolean {
    return this.profileResetPending?.profileId === scope.profileId
      && this.profileResetPending.generation === scope.generation
  }

  private requireProfileNotRemoving(profileId: string): void {
    if (this.profileRemovals.has(profileId)) {
      throw new Error('This server profile is already being removed.')
    }
  }

  private replaceScopeNamespace(scope: ConnectionScope, namespace: string): ConnectionScope {
    this.assertCurrentScope(scope)
    this.flushEventCache()
    this.runtimeRefreshNextAt = 0
    this.serverId = namespace
    scope.namespace = namespace
    this.loadScopeCache(scope)
    this.emitProfiles()
    this.emitSessions(scope, this.sessions)
    this.emitJobs(scope, this.jobs)
    if (this.runtimeCatalog) this.emitRuntime(scope, this.runtimeCatalog)
    return scope
  }

  private loadScopeCache(scope: ConnectionScope): void {
    this.sessions = this.cache.sessions(scope.namespace)
    this.seenEmergencyAlertIds = new Set<string>()
    for (const session of this.sessions) {
      const alertId = session.emergency_alert?.status === 'active'
        ? session.emergency_alert.id
        : ''
      if (alertId) rememberEmergencyAlertId(this.seenEmergencyAlertIds, alertId)
    }
    this.jobs = this.cache.jobs(scope.namespace)
    const cachedRuntime = this.cache.preference(scope.namespace, RUNTIME_CATALOG_CACHE_KEY, null as RuntimeCatalog | null)
    this.runtimeCatalog = runtimeCatalogHasSelectableModels(cachedRuntime) ? cachedRuntime : null
    this.runtimeRefreshNextAt = this.runtimeCatalog ? Date.now() + RUNTIME_CATALOG_REFRESH_MS : 0
    this.health = null
    this.focusedSessionId = this.cache.preference(scope.namespace, 'selectedSessionId', null as string | null)
  }

  private loadCachedBootstrap(scope: ConnectionScope): ProfileBootstrapPayload {
    this.assertCurrentScope(scope)
    let warning = this.profileTransitionWarning
    const resetPending = this.profileResetIsPending(scope)
    const cacheValue = <T>(read: () => T, fallback: T): T => {
      try { return read() }
      catch (error) {
        warning ??= `The server profile changed, but its local cache could not be loaded: ${errorText(error)}`
        return fallback
      }
    }
    if (!resetPending && !this.sessions.length && cacheValue(() => this.cache.serverSummary(scope.namespace).sessionCount, 0)) {
      this.sessions = cacheValue(() => this.cache.sessions(scope.namespace), [])
    }
    if (!resetPending && !this.jobs.length) this.jobs = cacheValue(() => this.cache.jobs(scope.namespace), [])
    this.profileTransitionWarning = null
    return {
      settings: this.settings.publicSettings(),
      health: this.health,
      sessions: this.sessions,
      jobs: this.jobs,
      runtimeCatalog: this.runtimeCatalog,
      selectedSessionId: this.focusedSessionId,
      folderOrder: resetPending ? [] : cacheValue(() => this.cache.preference(scope.namespace, 'folderOrder', [] as string[]), []),
      collapsedFolders: resetPending ? [] : cacheValue(() => this.cache.preference(scope.namespace, 'collapsedFolders', [] as string[]), []),
      archivedCollapsed: resetPending ? false : cacheValue(() => this.cache.preference(scope.namespace, 'archivedCollapsed', false), false),
      inspectorVisible: resetPending ? false : cacheValue(() => this.cache.preference(scope.namespace, 'inspectorVisible', false), false),
      activeProfileId: scope.profileId,
      profiles: this.publicProfiles(),
      profileGeneration: scope.generation,
      ...(warning ? { profileTransitionWarning: warning } : {})
    }
  }

  private reconcileStoredProfileCache(profile: PublicServerProfile): void {
    const fallback = fallbackNamespace(profile.id)
    const legacyURL = profile.serverUrl
    try {
      if (legacyURL !== fallback) this.cache.mergeServerNamespace(legacyURL, fallback)
      if (profile.serverIdentity && profile.serverIdentity !== fallback) {
        this.cache.mergeServerNamespace(fallback, profile.serverIdentity)
      }
    } catch (error) {
      const message = `Cached workspace reconciliation failed: ${errorText(error)}`
      this.setProfileRuntime(profile.id, { connectionState: 'cached', lastConnectionError: message })
      appLog('cache', 'profile cache reconciliation retained both namespaces', {
        profileId: profile.id,
        legacyURL,
        fallback,
        serverIdentity: profile.serverIdentity,
        error: errorText(error)
      })
    }
  }

  private refreshInactiveProfileHealth(): Promise<void> {
    const existing = this.profileHealthSweepInFlight
    if (existing) return existing
    // Re-publish first so a machine waking from sleep cannot retain a stale green dot
    // while the bounded probes are in flight.
    this.emitProfiles()
    const epoch = this.profileHealthSweepEpoch
    const profileIds = this.settings.listProfiles()
      .map(profile => profile.id)
      .filter(profileId => profileId !== this.activeProfileId && !this.pendingProfileAuthorityNamespaces.has(profileId))
    const task = this.performInactiveProfileHealthSweep(profileIds, epoch)
    this.profileHealthSweepInFlight = task
    return task.finally(() => {
      if (this.profileHealthSweepInFlight === task) this.profileHealthSweepInFlight = null
    })
  }

  private requestInactiveProfileHealthSweep(): void {
    const existing = this.profileHealthSweepInFlight
    if (!existing) {
      void this.refreshInactiveProfileHealth()
      return
    }
    if (this.profileHealthSweepRescanRequested) return
    this.profileHealthSweepRescanRequested = true
    const rescan = (): void => {
      if (!this.profileHealthSweepRescanRequested) return
      this.profileHealthSweepRescanRequested = false
      if (this.running) void this.refreshInactiveProfileHealth()
    }
    void existing.then(rescan, rescan)
  }

  private async performInactiveProfileHealthSweep(profileIds: string[], epoch: number): Promise<void> {
    let index = 0
    const worker = async (): Promise<void> => {
      while (epoch === this.profileHealthSweepEpoch) {
        const profileId = profileIds[index++]
        if (!profileId) return
        await this.probeInactiveProfileHealth(profileId, epoch)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(INACTIVE_PROFILE_HEALTH_MAX_CONCURRENCY, profileIds.length) },
      () => worker()
    ))
  }

  private probeInactiveProfileHealth(profileId: string, epoch: number): Promise<void> {
    if (
      profileId === this.activeProfileId
      || !this.settings.getProfile(profileId)
      || this.pendingProfileAuthorityNamespaces.has(profileId)
    ) return Promise.resolve()
    const existing = this.profileHealthProbeInFlight.get(profileId)
    if (existing) return existing
    const revision = this.profileHealthProbeRevision.get(profileId) ?? 0
    const task = this.performInactiveProfileHealthProbe(profileId, revision, epoch)
    this.profileHealthProbeInFlight.set(profileId, task)
    return task.finally(() => {
      if (this.profileHealthProbeInFlight.get(profileId) === task) this.profileHealthProbeInFlight.delete(profileId)
    })
  }

  private async performInactiveProfileHealthProbe(profileId: string, revision: number, epoch: number): Promise<void> {
    let client: AgentServerClient | null = null
    try {
      if (this.pendingProfileAuthorityNamespaces.has(profileId)) return
      const credentialRevision = this.settings.connectionRevision(profileId)
      const token = await this.profileHealthAccessToken(profileId)
      if (!this.profileHealthProbeIsCurrent(profileId, revision, epoch)
        || this.settings.connectionRevision(profileId) !== credentialRevision) return
      client = this.clientFactory(this.settings.serverUrl(profileId), token)
      this.profileHealthProbeClients.set(profileId, client)
      const health = await this.profileHealthWithTimeout(profileId, client)
      if (!this.profileHealthProbeIsCurrent(profileId, revision, epoch)
        || this.settings.connectionRevision(profileId) !== credentialRevision) return
      if (health.ok !== true) throw new Error('Server health check reported unavailable.')
      const profile = this.settings.getProfile(profileId)
      if (!profile) return
      const expectedIdentity = profile.serverIdentity?.trim() || null
      const actualIdentity = health.server_identity?.trim() || null
      if (expectedIdentity && actualIdentity !== expectedIdentity) {
        throw new Error(`Server identity changed from ${expectedIdentity} to ${actualIdentity ?? 'an unverified server'}. Confirm the change before reconnecting this profile.`)
      }
      const serverVersion = health.server_version?.trim() || null
      const connectionState = connectionStateForHealth(health)
      this.setProfileRuntime(profileId, {
        connectionState: expectedIdentity ? connectionState : 'cached',
        lastConnectionError: expectedIdentity ? connectionWarningForHealth(health) : null,
        lastConnectionCheckedAt: Date.now(),
        ...(serverVersion ? { serverVersion } : {})
      })
      if (expectedIdentity && actualIdentity === expectedIdentity) {
        this.ensureInactiveEmergencyStream(
          profileId,
          revision,
          health,
          expectedIdentity,
          token,
        )
      } else {
        this.stopInactiveEmergencyStream(profileId)
      }
    } catch (error) {
      if (!this.profileHealthProbeIsCurrent(profileId, revision, epoch)) return
      this.stopInactiveEmergencyStream(profileId)
      this.setProfileRuntime(profileId, {
        connectionState: 'offline',
        lastConnectionError: errorText(error),
        lastConnectionCheckedAt: Date.now()
      })
    } finally {
      if (client) this.disposeProfileHealthProbeClient(profileId, client)
    }
    if (this.profileHealthProbeIsCurrent(profileId, revision, epoch)) this.emitProfiles()
  }

  private async profileHealthWithTimeout(profileId: string, client: AgentServerClient): Promise<Health> {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.disposeProfileHealthProbeClient(profileId, client)
        reject(new Error(`Server health check timed out after ${INACTIVE_PROFILE_HEALTH_TIMEOUT_MS / 1000} seconds.`))
      }, INACTIVE_PROFILE_HEALTH_TIMEOUT_MS)
    })
    try {
      return await Promise.race([client.health(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private profileHealthProbeIsCurrent(profileId: string, revision: number, epoch: number): boolean {
    return epoch === this.profileHealthSweepEpoch
      && revision === (this.profileHealthProbeRevision.get(profileId) ?? 0)
      && profileId !== this.activeProfileId
      && Boolean(this.settings.getProfile(profileId))
  }

  private async profileHealthAccessToken(profileId: string): Promise<string> {
    const revision = this.settings.connectionRevision(profileId)
    const probeRevision = this.profileHealthProbeRevision.get(profileId) ?? 0
    const epoch = this.profileHealthSweepEpoch
    const cached = this.profileHealthAccessTokens.get(profileId)
    if (cached?.revision === revision) return cached.token
    const token = await this.settings.accessTokenForConnectionAsync(profileId)
    if (this.settings.connectionRevision(profileId) !== revision
      || (this.profileHealthProbeRevision.get(profileId) ?? 0) !== probeRevision
      || this.profileHealthSweepEpoch !== epoch) throw staleProfileError()
    this.profileHealthAccessTokens.set(profileId, { revision, token })
    return token
  }

  private invalidateProfileHealthProbe(profileId: string): void {
    this.profileHealthProbeRevision.set(profileId, (this.profileHealthProbeRevision.get(profileId) ?? 0) + 1)
    const client = this.profileHealthProbeClients.get(profileId)
    if (client) this.disposeProfileHealthProbeClient(profileId, client)
    this.profileHealthProbeInFlight.delete(profileId)
    this.stopInactiveEmergencyStream(profileId)
  }

  private invalidateAllProfileHealthProbes(): void {
    this.profileHealthSweepEpoch += 1
    this.profileHealthSweepInFlight = null
    this.profileHealthSweepRescanRequested = false
    const profileIds = new Set([
      ...this.settings.listProfiles().map(profile => profile.id),
      ...this.profileHealthProbeClients.keys(),
      ...this.profileHealthProbeInFlight.keys(),
      ...this.inactiveEmergencyStreams.keys()
    ])
    for (const profileId of profileIds) this.invalidateProfileHealthProbe(profileId)
  }

  private disposeProfileHealthProbeClient(profileId: string, client: AgentServerClient): void {
    if (this.profileHealthProbeClients.get(profileId) !== client) return
    this.profileHealthProbeClients.delete(profileId)
    client.dispose()
  }

  private runtimeForProfile(profileId: string, metadata?: Pick<PublicServerProfile, 'id' | 'serverIdentity'>): ServerProfileRuntimeState {
    const profile = metadata ?? this.settings.getProfileMetadata(profileId)
    const namespace = profile ? profileNamespace(profile) : fallbackNamespace(profileId)
    const summary = this.cache.serverSummary(namespace)
    const runtime = this.profileRuntime.get(profileId)
    const checkedAt = runtime?.lastConnectionCheckedAt ?? null
    const inactiveConnectionState = profileId !== this.activeProfileId
      && checkedAt !== null
      && Date.now() - checkedAt <= INACTIVE_PROFILE_HEALTH_FRESH_MS
      && (runtime?.connectionState === 'online' || runtime?.connectionState === 'degraded' || runtime?.connectionState === 'offline')
      ? runtime.connectionState
      : 'cached'
    return {
      connectionState: profileId === this.activeProfileId
        ? runtime?.connectionState ?? 'cached'
        : inactiveConnectionState,
      cachedUnreadCount: summary.unreadCount,
      lastConnectionError: runtime?.lastConnectionError ?? null,
      serverVersion: runtime?.serverVersion ?? this.cache.preference(namespace, SERVER_VERSION_CACHE_KEY, null),
      lastConnectionCheckedAt: checkedAt
    }
  }

  private persistServerUpdate(profileId: string, patch: UpdateServerProfilePatch): PublicServerProfile {
    const previous = this.settings.getProfile(profileId)
    if (!previous) throw new Error(`Unknown server profile: ${profileId}`)
    const { resetServerIdentity, ...storedPatch } = patch
    const retiredNamespaces = resetServerIdentity
      ? [...new Set([
          ...this.settings.retiredServerNamespaces(profileId),
          ...(this.pendingProfileAuthorityNamespaces.get(profileId) ?? []),
          fallbackNamespace(profileId),
          previous.serverIdentity?.trim() || ''
        ].filter(Boolean))]
      : undefined
    const profile = this.settings.updateProfile(profileId, {
      ...storedPatch,
      ...(resetServerIdentity ? { serverIdentity: null, retiredServerNamespaces: retiredNamespaces } : {})
    })
    if (retiredNamespaces?.length) this.pendingProfileAuthorityNamespaces.set(profileId, retiredNamespaces)
    if (patch.accessToken !== undefined) this.profileHealthAccessTokens.delete(profileId)
    return profile
  }

  private publicProfiles(): PublicServerProfile[] {
    return this.settings.listProfiles(profile => this.runtimeForProfile(profile.id, profile))
  }

  private assertProfileSelection(profileId: string, intent: number, revision: number): void {
    this.requireProfileNotRemoving(profileId)
    if (this.profileSelectionIntent !== intent || this.settings.connectionRevision(profileId) !== revision) throw staleProfileError()
  }

  private setProfileRuntime(profileId: string, patch: ServerProfileRuntimeState): void {
    this.profileRuntime.set(profileId, { ...this.profileRuntime.get(profileId), ...patch })
  }

  private refreshProfileUnread(scope: ConnectionScope): void {
    if (!this.isCurrentScope(scope)) return
    const unreadCount = this.cache.serverSummary(scope.namespace).unreadCount
    if (this.profileRuntime.get(scope.profileId)?.cachedUnreadCount === unreadCount) return
    this.setProfileRuntime(scope.profileId, { cachedUnreadCount: unreadCount })
    this.emitProfiles()
  }

  private emitProfiles(): void {
    const payload = {
      activeProfileId: this.activeProfileId,
      profiles: this.publicProfiles(),
      profileGeneration: this.profileGeneration
    }
    const signature = JSON.stringify(payload)
    if (signature === this.lastProfilesPayload) return
    this.lastProfilesPayload = signature
    this.emit('server:profiles', payload)
  }

  private emitConnection(scope: ConnectionScope, connected: boolean, health?: Health, error?: string): void {
    if (!this.isCurrentScope(scope)) return
    const connectionState: ServerConnectionState = connected
      ? health ? connectionStateForHealth(health) : this.profileRuntime.get(scope.profileId)?.connectionState ?? 'online'
      : this.profileRuntime.get(scope.profileId)?.connectionState ?? 'offline'
    const payload = {
      connected, health, error, profileId: scope.profileId, profileGeneration: scope.generation, connectionState
    }
    const signature = connectionPayloadSignature(payload)
    if (signature !== this.lastConnectionPayload) {
      this.lastConnectionPayload = signature
      this.emit('server:connection', payload)
    }
    this.emitProfiles()
  }

  private emitSync(scope: ConnectionScope, sessionId: string, state: import('../shared/types').ChatSyncStatus, error?: string): void {
    if (!this.isCurrentScope(scope)) return
    this.emit('server:sync', { sessionId, state, error, profileId: scope.profileId, profileGeneration: scope.generation })
  }

  private emitForwardedPorts(ports: ForwardedPort[]): void {
    const scope = this.captureScope()
    if (!this.isCurrentScope(scope)) return
    this.emit('ports:changed', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      ports
    })
  }

  private withSessionReadMutation<T>(
    scope: ConnectionScope,
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify([scope.profileId, scope.generation, sessionId])
    const previous = this.readStateMutations.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      this.assertCurrentScope(scope)
      return operation()
    })
    const barrier = task.then(() => undefined, () => undefined)
    this.readStateMutations.set(key, barrier)
    void barrier.finally(() => {
      if (this.readStateMutations.get(key) === barrier) this.readStateMutations.delete(key)
    })
    return task
  }

  private applyReadStateReceipt(scope: ConnectionScope, sessionId: string, receipt: Session): Session {
    this.assertCurrentScope(scope)
    if (receipt.id !== sessionId) throw new Error('AgentsServer returned read state for another chat.')
    const current = this.sessions.find(candidate => candidate.id === sessionId)
    const currentSequence = current?.last_read_agent_event_seq ?? 0
    const receiptSequence = receipt.last_read_agent_event_seq ?? 0
    const useReceiptSequence = receiptSequence >= currentSequence
    const merged: Session = current
      ? {
          ...current,
          last_read_agent_event_seq: Math.max(currentSequence, receiptSequence),
          last_read_agent_event_at: useReceiptSequence
            ? receipt.last_read_agent_event_at ?? current.last_read_agent_event_at
            : current.last_read_agent_event_at,
          manual_unread: receipt.manual_unread
        }
      : receipt
    this.upsertSession(scope, merged)
    return merged
  }

  private upsertSession(scope: ConnectionScope, session: Session): void {
    this.assertCurrentScope(scope)
    const index = this.sessions.findIndex(candidate => candidate.id === session.id)
    if (index >= 0) this.sessions = this.sessions.map(candidate => candidate.id === session.id ? session : candidate)
    else this.sessions = [...this.sessions, session]
    this.cache.putSession(scope.namespace, session)
    this.scheduleSearchBackfill()
    this.emitSessions(scope, this.sessions)
    this.refreshProfileUnread(scope)
  }

  private rememberSessionDetail(scope: ConnectionScope, session: Session): void {
    const existing = this.sessions.find(candidate => candidate.id === session.id)
    if (existing && jsonEqual(existing, session)) return
    this.upsertSession(scope, session)
  }

  private disposeUnavailablePortTunnels(previous: Session[], next: Session[]): void {
    const nextById = new Map(next.map(session => [session.id, session]))
    for (const session of previous) {
      if (session.archived) continue
      const current = nextById.get(session.id)
      if (!current || current.archived) this.portTunnels.disposeSession(session.id)
    }
  }

  private requirePortForwardingCapability(): void {
    const capability = this.health?.capabilities?.port_forwarding_v1
    if (!portForwardingCapabilityAvailable(this.health)) {
      throw new Error(capability?.action || capability?.message || 'This AgentsServer version does not support port forwarding.')
    }
  }

  private requireActivePortTunnelSession(sessionId: string): Session {
    const session = this.sessions.find(candidate => candidate.id === sessionId)
    if (!session) throw new Error('This chat is no longer available for port forwarding.')
    if (session.archived) throw new Error('Archived chats cannot open port forwards.')
    return session
  }

  private emitSessions(scope: ConnectionScope, sessions: Session[]): void {
    if (!this.isCurrentScope(scope)) return
    this.notifyNewEmergencyAlerts(scope, sessions)
    this.emit('server:sessions', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      sessions
    })
  }

  private notifyNewEmergencyAlerts(scope: ConnectionScope, sessions: Session[]): void {
    const seen = this.seenEmergencyAlertIds ??= new Set<string>()
    const focusedWindow = [...(this.windows ?? new Set<BrowserWindow>())]
      .some(window => !window.isDestroyed() && typeof window.isFocused === 'function' && window.isFocused())
    const profile = this.settings.getProfile(scope.profileId)
    if (!profile) return
    for (const session of sessions) {
      const alert = session.emergency_alert
      if (
        !alert
        || alert.status !== 'active'
        || alert.severity !== 'critical'
        || !/^emergency_[0-9a-f]{32}$/.test(alert.id)
        || !alert.message.trim()
        || seen.has(alert.id)
      ) continue
      rememberEmergencyAlertId(seen, alert.id)
      if (focusedWindow && this.focusedSessionId === session.id) continue
      void this.notify({
        title: `EMERGENCY · ${session.title}`,
        body: alert.message,
        profileId: scope.profileId,
        serverIdentity: profile.serverIdentity ?? null,
        sessionId: session.id,
        emergencyAlertId: alert.id
      })
    }
  }

  private emitAgentEvent(scope: ConnectionScope, event: Event): void {
    if (!this.isCurrentScope(scope)) return
    this.emit('server:event', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      event
    })
  }

  private emitProviderRuntimeChanged(scope: ConnectionScope, event: ProviderRuntimeChanged): void {
    if (!this.isCurrentScope(scope)) return
    this.emit('server:provider-runtime', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      event
    })
  }

  private emitJobs(scope: ConnectionScope, jobs: Job[]): void {
    if (!this.isCurrentScope(scope)) return
    this.emit('server:jobs', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      jobs
    })
  }

  private emitRuntime(scope: ConnectionScope, runtimeCatalog: RuntimeCatalog): void {
    if (!this.isCurrentScope(scope)) return
    this.emit('server:runtime', {
      profileId: scope.profileId,
      profileGeneration: scope.generation,
      runtimeCatalog
    })
  }

  private emit<K extends keyof AppEventMap>(name: K, payload: AppEventMap[K]): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) window.webContents.send(name, payload)
    }
  }

  private disconnectAllTerminals(): void {
    const connections = [...this.terminalConnections]
    this.terminalConnections.clear()
    let firstError: unknown
    for (const [sessionId, connection] of connections) {
      this.terminalLeases.set(sessionId, (this.terminalLeases.get(sessionId) ?? 0) + 1)
      try { connection.close() }
      catch (error) { firstError ??= error }
    }
    if (firstError) throw firstError
  }

  private async ensureLocalFile(sessionId: string, file: AgentFile): Promise<string> {
    requireSessionFile(sessionId, file)
    const scope = this.captureScope()
    const path = this.localFilePath(scope, sessionId, file)
    if (existsSync(path)) {
      this.assertCurrentScope(scope)
      return path
    }
    const key = `${scope.generation}:${sessionId}:${file.id}:${path}`
    const existing = this.fileDownloads.get(key)
    if (existing) {
      const existingPath = await existing
      this.assertCurrentScope(scope)
      return existingPath
    }
    await this.ensureValidatedScope(scope)
    const download = this.downloadFile(scope, sessionId, file, path)
      .then(() => {
        this.assertCurrentScope(scope)
        return path
      })
      .finally(() => {
        if (this.fileDownloads.get(key) === download) this.fileDownloads.delete(key)
      })
    this.fileDownloads.set(key, download)
    return download
  }

  private localFilePath(scope: ConnectionScope, sessionId: string, file: AgentFile): string {
    const profileKey = createHash('sha256').update(`${scope.profileId}\0${scope.namespace}`).digest('hex').slice(0, 20)
    const sessionKey = createHash('sha256').update(sessionId).digest('hex').slice(0, 20)
    const fileKey = createHash('sha256').update(file.id).digest('hex').slice(0, 20)
    return join(app.getPath('temp'), 'AgentsDockFiles', profileKey, sessionKey, fileKey, basename(file.filename))
  }

  private async downloadFile(scope: ConnectionScope, sessionId: string, file: AgentFile, path: string): Promise<void> {
    requireSessionFile(sessionId, file)
    await this.ensureValidatedScope(scope)
    const response = await scope.client.fileRequest(sessionId, file.id)
    this.assertCurrentScope(scope)
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      throw new Error(`Download failed (${status})${detail ? `: ${detail}` : ''}`)
    }
    if (!response.body) throw new Error('Download failed: server returned an empty response')
    await this.downloadResponse(response, path)
  }

  private async downloadResponse(response: Response, path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true })
    const partial = `${path}.part-${process.pid}-${Date.now()}`
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial))
      await rename(partial, path)
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

interface ArtifactTextPreview {
  bytes: Buffer
  totalSize: number
  truncated: boolean
}

async function readArtifactTextPreviewFromFile(
  path: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<ArtifactTextPreview> {
  const file = await open(path, 'r')
  try {
    if (signal) throwIfArtifactReadAborted(signal)
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('Artifact is not a regular file.')
    const targetBytes = Math.min(metadata.size, maximumBytes)
    const chunks: Buffer[] = []
    let total = 0
    while (total < targetBytes) {
      if (signal) throwIfArtifactReadAborted(signal)
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, targetBytes - total))
      const read = file.read(buffer, 0, buffer.byteLength, null)
      const { bytesRead } = signal ? await abortable(read, signal) : await read
      if (!bytesRead) break
      total += bytesRead
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    return {
      bytes: Buffer.concat(chunks, total),
      totalSize: metadata.size,
      truncated: metadata.size > total
    }
  } finally {
    await file.close()
  }
}

async function readArtifactTextPreviewFromResponse(
  response: Response,
  maximumBytes: number,
  sizeHint?: number,
  signal?: AbortSignal
): Promise<ArtifactTextPreview> {
  const contentLengthHeader = response.headers.get('content-length')
  const recordedLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader)
  if (!response.body) throw new Error('Artifact download returned an empty response.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let observed = 0
  let truncated = false
  const declaredSize = Number.isFinite(recordedLength) && recordedLength >= 0
    ? recordedLength
    : typeof sizeHint === 'number' && Number.isFinite(sizeHint) && sizeHint >= 0
      ? sizeHint
      : null
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal) throwIfArtifactReadAborted(signal)
      const { done, value } = await reader.read()
      if (signal) throwIfArtifactReadAborted(signal)
      if (done) break
      observed += value.byteLength
      const remaining = maximumBytes - total
      if (remaining > 0) {
        const accepted = value.subarray(0, remaining)
        total += accepted.byteLength
        chunks.push(Buffer.from(accepted))
      }
      if (observed > maximumBytes) {
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      if (total >= maximumBytes && declaredSize !== null && declaredSize > total) {
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const knownSize = declaredSize ?? observed
  truncated ||= knownSize > total
  return {
    bytes: Buffer.concat(chunks, total),
    totalSize: Math.max(knownSize, observed),
    truncated
  }
}

async function cacheArtifactBytes(path: string, bytes: Buffer): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.part-text-${process.pid}-${Date.now()}`
  try {
    await writeFile(partial, bytes, { mode: 0o600 })
    await rename(partial, path)
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}

function hasBinaryControlCharacters(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d && code !== 0x1b) return true
    if (code === 0x7f) return true
  }
  return false
}

function throwIfArtifactReadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      }
    )
  })
}

function connectionStateForHealth(health: Health): ServerConnectionState {
  return health.capabilities?.tmux?.available === false ? 'degraded' : 'online'
}

function connectionWarningForHealth(health: Health): string | null {
  const tmux = health.capabilities?.tmux
  if (tmux?.available !== false) return null
  return tmux.message?.trim() || 'tmux is not available; terminal sessions and detached server updates are disabled.'
}

function fallbackNamespace(profileId: string): string { return `profile:${profileId}` }

function profileNamespace(profile: Pick<PublicServerProfile, 'id' | 'serverIdentity'>): string {
  return profile.serverIdentity?.trim() || fallbackNamespace(profile.id)
}

function uploadGrantScope(scope: ConnectionScope, rendererId: number): {
  profileId: string
  profileGeneration: number
  rendererId: number
} {
  if (!Number.isSafeInteger(rendererId) || rendererId <= 0) throw new Error('The upload renderer is invalid.')
  return {
    profileId: scope.profileId,
    profileGeneration: scope.generation,
    rendererId
  }
}

function exactClipboardImageType(value: string): string {
  if (typeof value !== 'string' || value.length > 80 || value.trim() !== value) {
    throw new Error('The clipboard image type is invalid.')
  }
  const normalized = value.toLowerCase()
  if (!CLIPBOARD_IMAGE_EXTENSIONS.has(normalized)) throw new Error('That clipboard image type is not supported.')
  return normalized
}

function safeClipboardImageName(value: string, extension: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_IMAGE_NAME_BYTES) {
    throw new Error('The clipboard image name is too long.')
  }
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) throw new Error('The clipboard image name is invalid.')
  const trimmed = value.trim()
  if (!trimmed) return `clipboard-${Date.now()}.${extension}`
  if (trimmed === '.' || trimmed === '..') throw new Error('The clipboard image name is invalid.')
  const sanitized = trimmed.replace(/[^\p{L}\p{N} ._()-]/gu, '_')
  const filename = sanitized.toLowerCase().endsWith(`.${extension}`) ? sanitized : `${sanitized}.${extension}`
  if (Buffer.byteLength(filename, 'utf8') > MAX_CLIPBOARD_IMAGE_NAME_BYTES) {
    throw new Error('The clipboard image name is too long.')
  }
  return filename
}

function profileConnectionChanged(profile: PublicServerProfile, patch: UpdateServerProfilePatch): boolean {
  return Boolean(
    patch.accessToken !== undefined
    || patch.resetServerIdentity
    || patch.serverUrl !== undefined && normalizeServerURL(patch.serverUrl) !== normalizeServerURL(profile.serverUrl)
  )
}

function sameTeamHubServerScope(left: TeamHubServerScope, right: TeamHubServerScope): boolean {
  return left.profileId === right.profileId
    && left.profileGeneration === right.profileGeneration
    && left.serverIdentity === right.serverIdentity
    && left.serverUrl === right.serverUrl
}

function parseTeamHubDiscovery(value: unknown, serverIdentity: string): TeamHubDiscovery {
  const unavailable = (message: string, action: string | null): TeamHubDiscovery => ({
    available: false,
    designatedHost: false,
    version: 1,
    basePath: null,
    transport: null,
    hubUrl: null,
    hubIdentity: null,
    hostServerIdentity: null,
    message,
    action
  })
  if (value == null) return unavailable(
    'This AgentsServer does not advertise Team Hub V1.',
    'Update the server or configure exactly one designated Team Hub host.'
  )
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTeamHubCapability()
  const item = value as Record<string, unknown>
  if (
    item.version !== 1
    || typeof item.available !== 'boolean'
    || typeof item.designated_host !== 'boolean'
    || typeof item.message !== 'string'
    || item.message.length < 1
    || item.message.length > 400
    || /[\u0000-\u001f\u007f]/.test(item.message)
    || !(item.action === null || typeof item.action === 'string' && item.action.length >= 1 && item.action.length <= 400 && !/[\u0000-\u001f\u007f]/.test(item.action))
  ) throw invalidTeamHubCapability()

  const common = {
    version: 1 as const,
    message: item.message,
    action: item.action as string | null
  }
  const serverSessionBasePath = item.server_session_base_path === undefined || item.server_session_base_path === null
    ? undefined
    : item.server_session_base_path === '/api/team-hub-server'
      ? item.server_session_base_path
      : (() => { throw invalidTeamHubCapability() })()
  if (item.transport === 'secure_peer') {
    if (serverSessionBasePath) throw invalidTeamHubCapability()
    if (item.designated_host || item.available !== true) throw invalidTeamHubCapability()
    const connectionId = securePeerCapabilityUUID(item.connection_id)
    const basePath = `/api/team-hub-secure/${connectionId}`
    if (item.base_path !== basePath) throw invalidTeamHubCapability()
    // The server advertises only a path capability. Accepting an absolute URL
    // here would let an untrusted Host header select the control-token origin.
    if (item.hub_url != null) throw invalidTeamHubCapability()
    const hubIdentity = boundedTeamHubControlField(item.hub_id, 'Hub identity', 240)
    const hostServerIdentity = boundedTeamHubControlField(item.host_server_identity, 'host server identity', 240)
    const rawRoutes = item.routes === undefined ? [{
      transport: 'secure_peer', hub_url: null, base_path: basePath,
      connection_id: connectionId, host_server_identity: hostServerIdentity, hub_id: hubIdentity
    }] : item.routes
    if (!Array.isArray(rawRoutes) || rawRoutes.length !== 1) throw invalidTeamHubCapability()
    const routeItem = rawRoutes[0]
    if (!routeItem || typeof routeItem !== 'object' || Array.isArray(routeItem)) throw invalidTeamHubCapability()
    const route = routeItem as Record<string, unknown>
    if (
      Object.keys(route).some(key => ![
        'transport', 'hub_url', 'base_path', 'connection_id', 'host_server_identity', 'hub_id'
      ].includes(key))
      || route.transport !== 'secure_peer'
      || route.base_path !== basePath
      || securePeerCapabilityUUID(route.connection_id) !== connectionId
      || boundedTeamHubControlField(route.host_server_identity, 'host server identity', 240) !== hostServerIdentity
      || boundedTeamHubControlField(route.hub_id, 'Hub identity', 240) !== hubIdentity
      || route.hub_url != null
    ) throw invalidTeamHubCapability()
    return {
      ...common,
      available: true,
      designatedHost: false,
      basePath,
      transport: 'secure_peer',
      hubUrl: null,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId, hostServerIdentity, hubIdentity
      }],
      hubIdentity,
      hostServerIdentity,
      connectionId
    }
  }
  if (!item.designated_host) {
    if (
      item.available
      || serverSessionBasePath
      || item.base_path !== null
      || item.hub_id !== null
      || item.host_server_identity !== null
      || !(item.transport === undefined || item.transport === null)
      || !(item.hub_url === undefined || item.hub_url === null)
      || !(item.routes === undefined || Array.isArray(item.routes) && item.routes.length === 0)
    ) {
      throw invalidTeamHubCapability()
    }
    return {
      ...common, available: false, designatedHost: false, basePath: null,
      transport: null, hubUrl: null, hubIdentity: null, hostServerIdentity: null
    }
  }
  if (item.base_path !== '/api/team-hub' || item.host_server_identity !== serverIdentity) throw invalidTeamHubCapability()
  const legacyLoopback = item.transport === undefined && item.hub_url === undefined && item.available === true
  const transport = legacyLoopback
    ? 'loopback'
    : item.transport === 'loopback' || item.transport === 'tailscale_serve' || item.transport === 'direct_ip'
      ? item.transport
      : null
  if (!transport) throw invalidTeamHubCapability()
  let hubUrl: string | null
  if (item.hub_url === undefined || item.hub_url === null) hubUrl = null
  else if (typeof item.hub_url === 'string') hubUrl = item.hub_url
  else throw invalidTeamHubCapability()
  if (transport === 'loopback' && hubUrl !== null) throw invalidTeamHubCapability()
  if (transport === 'tailscale_serve') {
    if (typeof hubUrl !== 'string') throw invalidTeamHubCapability()
    try { normalizeTailscaleServeTeamHubURL(hubUrl) } catch { throw invalidTeamHubCapability() }
  }
  if (transport === 'direct_ip') {
    if (typeof hubUrl !== 'string') throw invalidTeamHubCapability()
    try { normalizeDirectIPTeamHubURL(hubUrl) } catch { throw invalidTeamHubCapability() }
  }
  const routesAdvertised = item.routes !== undefined
  const rawRoutes = item.routes === undefined
    ? [{ transport, hub_url: hubUrl }]
    : item.routes
  if (!Array.isArray(rawRoutes) || rawRoutes.length < 1 || rawRoutes.length > 3) throw invalidTeamHubCapability()
  const routes = rawRoutes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTeamHubCapability()
    const route = value as Record<string, unknown>
    if (
      Object.keys(route).some(key => !['transport', 'hub_url'].includes(key))
      || !['loopback', 'tailscale_serve', 'direct_ip'].includes(String(route.transport))
    ) throw invalidTeamHubCapability()
    const routeTransport = route.transport as 'loopback' | 'tailscale_serve' | 'direct_ip'
    const routeHubUrl = route.hub_url === null ? null : typeof route.hub_url === 'string' ? route.hub_url : undefined
    if (routeHubUrl === undefined) throw invalidTeamHubCapability()
    if (routeTransport === 'loopback' && routeHubUrl !== null) throw invalidTeamHubCapability()
    if (routeTransport === 'tailscale_serve') {
      if (routeHubUrl === null) throw invalidTeamHubCapability()
      try { normalizeTailscaleServeTeamHubURL(routeHubUrl) } catch { throw invalidTeamHubCapability() }
    }
    if (routeTransport === 'direct_ip') {
      if (routeHubUrl === null) throw invalidTeamHubCapability()
      try { normalizeDirectIPTeamHubURL(routeHubUrl) } catch { throw invalidTeamHubCapability() }
    }
    return { transport: routeTransport, hubUrl: routeHubUrl }
  })
  if (
    new Set(routes.map(route => route.transport)).size !== routes.length
    || routes[0]?.transport !== transport
    || routes[0]?.hubUrl !== hubUrl
  ) throw invalidTeamHubCapability()
  if (!item.available) {
    if (item.hub_id !== null) throw invalidTeamHubCapability()
    return {
      ...common,
      available: false,
      designatedHost: true,
      basePath: '/api/team-hub',
      transport,
      hubUrl,
      ...(serverSessionBasePath ? { serverSessionBasePath } : {}),
      ...(routesAdvertised ? { routes } : {}),
      hubIdentity: null,
      hostServerIdentity: serverIdentity
    }
  }
  if (typeof item.hub_id !== 'string' || !item.hub_id.trim() || item.hub_id.length > 240 || /[\u0000-\u001f\u007f]/.test(item.hub_id)) {
    throw invalidTeamHubCapability()
  }
  return {
    ...common,
    available: true,
    designatedHost: true,
    basePath: '/api/team-hub',
    transport,
    hubUrl,
    ...(serverSessionBasePath ? { serverSessionBasePath } : {}),
    ...(routesAdvertised ? { routes } : {}),
    hubIdentity: item.hub_id,
    hostServerIdentity: serverIdentity
  }
}

function securePeerCapabilityUUID(value: unknown): string {
  const clean = boundedTeamHubControlField(value, 'secure connection', 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw invalidTeamHubCapability()
  }
  return clean
}

function securePeerV4ID(value: unknown, label: string): string {
  const clean = boundedTeamHubControlField(value, label, 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw new Error(`Secure peer ${label} identifier is invalid.`)
  }
  return clean
}

function securePeerRouteActions(value: unknown): Array<'instruction' | 'request_reply'> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error('Select at least one remote chat action.')
  if (!value.every(action => action === 'instruction' || action === 'request_reply') || new Set(value).size !== value.length) {
    throw new Error('Secure peer route actions are invalid.')
  }
  return value as Array<'instruction' | 'request_reply'>
}

function securePeerCertificateFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('Secure peer certificate fingerprint is invalid.')
  }
  return value
}

function securePeerTranscriptHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Secure peer transcript hash is invalid.')
  }
  return value
}

function sameTeamHubDiscovery(left: TeamHubDiscovery, right: TeamHubDiscovery): boolean {
  return left.available === right.available
    && left.designatedHost === right.designatedHost
    && left.version === right.version
    && left.basePath === right.basePath
    && left.serverSessionBasePath === right.serverSessionBasePath
    && left.transport === right.transport
    && left.hubUrl === right.hubUrl
    && JSON.stringify(left.routes ?? []) === JSON.stringify(right.routes ?? [])
    && left.hubIdentity === right.hubIdentity
    && left.hostServerIdentity === right.hostServerIdentity
    && left.connectionId === right.connectionId
}

function requireTeamHubBootstrapContext(
  health: Health | null,
  server: TeamHubServerScope,
  input: TeamHubBootstrapProofInput
): {
  discovery: TeamHubDiscovery
  serverInstanceId: string
  recipientEmail: string
  displayName: string
  deviceLabel: string
} {
  if (!health || health.ok !== true || health.server_identity !== server.serverIdentity) throw staleProfileError()
  const serverInstanceId = boundedTeamHubControlField(health.server_instance_id, 'server instance', 240)
  const advertised = parseTeamHubDiscovery(health.capabilities?.team_hub_v1, server.serverIdentity!)
  const requestedTransport = input.transport ?? advertised.transport
  const selectedRoute = advertised.routes?.find(route => (
    route.transport === requestedTransport && route.hubUrl === input.hubUrl
  ))
  const discovery = selectedRoute
    ? { ...advertised, transport: selectedRoute.transport, hubUrl: selectedRoute.hubUrl }
    : advertised
  if (
    !discovery.available
    || !discovery.designatedHost
    || !['tailscale_serve', 'direct_ip'].includes(String(discovery.transport))
    || !discovery.hubIdentity
    || !discovery.hubUrl
    || input.hubIdentity !== discovery.hubIdentity
    || input.hubUrl !== discovery.hubUrl
    || requestedTransport !== discovery.transport
  ) throw staleProfileError()
  if (
    discovery.transport === 'direct_ip'
    && input.unsafeDirectIPConfirmed !== true
  ) throw new Error('Direct-IP Teamspace setup requires explicit unencrypted-transport confirmation.')
  const recipientEmail = boundedTeamHubControlField(input.recipientEmail, 'recipient email', 320).toLowerCase()
  if (recipientEmail !== input.recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    throw new Error('Teamspace setup recipient email is invalid.')
  }
  return {
    discovery,
    serverInstanceId,
    recipientEmail,
    displayName: boundedTeamHubControlField(input.displayName, 'display name', 160),
    deviceLabel: boundedTeamHubControlField(input.deviceLabel, 'device name', 160)
  }
}

function boundedTeamHubControlField(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Teamspace setup ${label} is invalid.`)
  }
  return value
}

function requireExactTeamHubBootstrapGrant(
  result: {
    request_id: string
    server_identity: string
    server_instance_id: string
    hub_id: string
    tailnet_login: string
    expires_at: string
    bootstrap_proof: string
  },
  expected: { requestId: string; serverIdentity: string; serverInstanceId: string; hubIdentity: string }
): void {
  if (
    result.request_id !== expected.requestId
    || result.server_identity !== expected.serverIdentity
    || result.server_instance_id !== expected.serverInstanceId
    || result.hub_id !== expected.hubIdentity
    || !result.tailnet_login
    || !/^bootstrap_remote\.[A-Za-z0-9_-]{43}$/.test(result.bootstrap_proof)
  ) throw new Error('Teamspace setup returned a mismatched one-time grant.')
  const expiresAt = Date.parse(result.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() - 30_000 || expiresAt > Date.now() + 6 * 60_000) {
    throw new Error('Teamspace setup returned an invalid grant expiry.')
  }
}

function requireTeamHubHostControlCapability(value: unknown): TeamHubHostControlCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The connected AgentsServer build does not include Team Network host control. Install a build that includes host control, then reconnect.')
  }
  const capability = value as Record<string, unknown>
  if (
    capability.version !== 1
    || typeof capability.available !== 'boolean'
    || typeof capability.enabled !== 'boolean'
    || typeof capability.can_enable !== 'boolean'
    || typeof capability.can_disable !== 'boolean'
    || capability.status_path !== '/api/admin/team-hub/host'
    || capability.enable_path !== '/api/admin/team-hub/host/enable'
    || capability.disable_path !== '/api/admin/team-hub/host/disable'
    || typeof capability.message !== 'string'
    || capability.message.length < 1
    || capability.message.length > 400
    || /[\u0000-\u001f\u007f]/.test(capability.message)
    || !(capability.action === null || typeof capability.action === 'string'
      && capability.action.length >= 1
      && capability.action.length <= 400
      && !/[\u0000-\u001f\u007f]/.test(capability.action))
  ) throw new Error('AgentsServer returned an invalid Team Network host-control capability.')
  return capability as unknown as TeamHubHostControlCapability
}

function requireExactTeamHubServerRoleReceipt(
  result: TeamHubHostRoleResponse,
  expected: {
    requestId: string
    serverIdentity: string
    serverInstanceId: string
    serverName: string
    role: 'host' | 'member'
  }
): void {
  if (
    !result || typeof result !== 'object'
    || result.phase !== 'complete'
    || result.request_id !== expected.requestId
    || !['create', 'reactivate', 'enable', 'disable', 'rename', 'already_host', 'already_member'].includes(result.operation)
    || result.server_identity !== expected.serverIdentity
    || result.server_instance_id !== expected.serverInstanceId
    || result.server_name !== expected.serverName
    || result.reconnect_required !== false
    || typeof result.message !== 'string'
    || !result.message.trim()
    || !result.team_hub || typeof result.team_hub !== 'object'
  ) throw new Error('AgentsServer returned a mismatched Team Network role activation receipt.')
  const discovery = parseTeamHubDiscovery(result.team_hub, expected.serverIdentity)
  if (discovery.designatedHost !== (expected.role === 'host')) {
    throw new Error('AgentsServer returned an incomplete Team Network role activation receipt.')
  }
}

function teamHubServerName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Server name is required.')
  const clean = value.trim()
  if (!clean) throw new Error('Server name is required.')
  if (Buffer.byteLength(clean, 'utf8') > 160 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error('Server name is invalid.')
  }
  return clean
}

function invalidTeamHubCapability(): Error {
  return new Error('AgentsServer returned an invalid Team Hub V1 capability.')
}

function staleProfileError(): Error { return new Error('Server profile switch superseded this operation.') }

function serverCapabilityVersion(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const version = (value as { version?: unknown }).version
  return typeof version === 'number' && Number.isFinite(version) ? version : 0
}

function unsupportedCodexGoalsConfiguration(): CodexGoalsConfiguration {
  return {
    // Persisted goals were enabled by default before the server exposed this
    // switch. Report that legacy default without pretending it is mutable.
    enabled: true,
    configurable: false,
    message: 'Update AgentsServer to manage persistent Codex goals.'
  }
}

function requireSessionFile(sessionId: string, file: AgentFile): void {
  if (!isValidMediaIdentifier(sessionId) || !file || !isValidMediaIdentifier(file.id)) {
    throw new Error('Invalid chat-scoped file request.')
  }
  if (!agentFileBelongsToSession(file, sessionId)) {
    throw new Error('The requested file belongs to another chat.')
  }
}

function insertAfter(sessions: Session[], session: Session, parentId: string): Session[] {
  const filtered = sessions.filter(candidate => candidate.id !== session.id)
  const index = filtered.findIndex(candidate => candidate.id === parentId)
  if (index < 0) return [...filtered, session]
  return [...filtered.slice(0, index + 1), session, ...filtered.slice(index + 1)]
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function attemptCleanup(currentError: unknown, operation: () => void): unknown {
  try {
    operation()
    return currentError
  } catch (error) {
    return currentError ?? error
  }
}

function portForwardingCapabilityAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.port_forwarding_v1
  return capability?.available === true && (capability.version ?? 0) >= 1
}

function portForwardingSessionBridgeLimit(health: Health | null | undefined): number {
  const advertised = health?.capabilities?.port_forwarding_v1?.max_active_connections_per_session
  if (typeof advertised !== 'number' || !Number.isFinite(advertised) || advertised < 1) {
    return PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL
  }
  return Math.min(PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL, Math.floor(advertised))
}

function pinSyncCanDefer(error: unknown): boolean {
  if (error instanceof ServerError) {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500
  }
  // Fetch/timeout failures, response-contract problems, local cache failures,
  // and revision-churn exhaustion all retain the durable outbox. Direct local
  // input is normalized before it is staged, so permanent user mutations reach
  // this point as explicit 4xx ServerErrors and are rolled back above.
  return true
}
function restartDelay(delayMs: number): Promise<void> {
  return delayMs > 0 ? new Promise(resolve => setTimeout(resolve, delayMs)) : Promise.resolve()
}
function jsonEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function connectionPayloadSignature(payload: {
  connected: boolean
  health?: Health
  error?: string
  profileId: string
  profileGeneration: number
  connectionState: ServerConnectionState
}): string {
  const rawJobGuard = payload.health?.job_guard
  if (!rawJobGuard || typeof rawJobGuard !== 'object' || Array.isArray(rawJobGuard)) {
    return JSON.stringify(payload)
  }
  const stableJobGuard = { ...rawJobGuard } as Record<string, unknown>
  // AgentsServer samples these values on every /api/health request. They are
  // diagnostic telemetry, not renderer state; including them in the event
  // signature caused an otherwise unchanged connection payload to fan out
  // through Zustand every five seconds. Keep the complete latest Health on the
  // service itself and suppress only telemetry-only renderer publications.
  delete stableJobGuard.load_1m
  delete stableJobGuard.load_per_cpu
  delete stableJobGuard.available_mem_mb
  return JSON.stringify({
    ...payload,
    health: { ...payload.health, job_guard: stableJobGuard }
  })
}
function rememberEmergencyAlertId(seen: Set<string>, alertId: string): void {
  seen.add(alertId)
  while (seen.size > MAX_REMEMBERED_EMERGENCY_ALERT_IDS) {
    const oldest = seen.values().next().value
    if (typeof oldest !== 'string') break
    seen.delete(oldest)
  }
}

export function sessionOwnedFilesPage(page: FilesPage, sessionId: string): FilesPage {
  const files = page.files.filter(file => agentFileBelongsToSession(file, sessionId))
  if (files.length === page.files.length) return page
  const rejected = page.files.length - files.length
  return {
    ...page,
    files,
    total: Math.max(files.length, page.total - rejected)
  }
}

export function mergeSessionSummaries(previous: Session[], incoming: Session[]): Session[] {
  if (!previous.length) return incoming
  const previousById = new Map(previous.map(session => [session.id, session]))
  return incoming.map(summary => {
    const existing = previousById.get(summary.id)
    if (!existing) return summary
    const merged = { ...existing, ...summary }
    return jsonEqual(existing, merged) ? existing : merged
  })
}

export function mergePolledSessionSummaries(previous: Session[], incoming: Session[]): Session[] {
  return mergeSessionSummaries(previous, incoming.map(summary => ({
    ...summary,
    emergency_alert: summary.emergency_alert ?? null,
    unacknowledged_emergency_count: summary.unacknowledged_emergency_count
      ?? (summary.emergency_alert ? 1 : 0)
  })))
}

export function reconcileEmergencySnapshot(previous: Session[], incoming: Session[]): Session[] {
  const incomingById = new Map(incoming.map(session => [session.id, session]))
  const previousIds = new Set(previous.map(session => session.id))
  const reconciled = previous.map(existing => {
    const summary = incomingById.get(existing.id)
    if (summary) return mergeSessionSummaries([existing], [summary])[0]
    if (existing.emergency_alert == null && !(existing.unacknowledged_emergency_count ?? 0)) return existing
    return {
      ...existing,
      emergency_alert: null,
      unacknowledged_emergency_count: 0
    }
  })
  for (const summary of incoming) {
    if (!previousIds.has(summary.id)) reconciled.push(summary)
  }
  return reconciled
}

function mergeEventsBySequence(...pages: Event[][]): Event[] {
  const byId = new Map<string, Event>()
  for (const event of pages.flat()) byId.set(event.id || `seq:${event.seq}`, event)
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}

function timelinePageNextBefore(page: TimelinePage): number | null {
  if (!page.has_more) return null
  return page.next_semantic_before
    ?? page.next_before
    ?? page.before
    ?? page.events[0]?.seq
    ?? null
}

function semanticAttemptSucceeded(page: TimelinePage): boolean {
  return page.semantic_paging ?? (page.semantic_item_count != null)
}

function linkedFilename(response: Response, target: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1]
  const plain = disposition.match(/filename=([^;]+)/i)?.[1]?.trim()
  let candidate = encoded ? safeDecode(encoded) : quoted || plain
  if (!candidate) candidate = basename(target.split(/[?#]/, 1)[0])
  return sanitizeFilename(candidate || 'linked-file')
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function sanitizeFilename(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f/:]/g, '_').trim()
  return cleaned || 'linked-file'
}
