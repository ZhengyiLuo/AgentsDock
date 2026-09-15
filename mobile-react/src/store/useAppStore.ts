import { create } from 'zustand'
import { appendTeamMailDraft, type StageTeamMailDraftInput } from '../lib/team-mail-draft'
import { AppState as NativeAppState } from 'react-native'
import * as Notifications from 'expo-notifications'
import type {
  AgentFile,
  AgentCrossChatRoutesSnapshot,
  AddServerProfileInput,
  Backend,
  ChatDefaults,
  ChatReference,
  TeamReference,
  CreateJobInput,
  CreateSessionInput,
  Event,
  FailedUpload,
  Health,
  Job,
  JobRunResponse,
  JobRunHistoryPage,
  PinnedItem,
  ProcessSnapshot,
  ProviderReloadResult,
  QueuedRunNowResponse,
  QueuedRunStatus,
  QueuedTurn,
  RuntimeCatalog,
  ServerUpdateStatus,
  Session,
  Snapshot,
  TimelinePage,
  TimelineIndex,
  TimelineTracePage,
  TimelineSearchResult,
  TmuxPane,
  PublicServerProfile,
  StoredServerProfile,
  UpdateServerProfileInput,
  UpdateJobInput,
  UploadRef,
  WorkspacePreferences,
} from '../types'
import { AgentServerClient, AgentServerClientDisposedError, AgentServerClientUnvalidatedError, ServerError, WebSocketConnectionError } from '../api/AgentServerClient'
import { errorMessage, mergeEvents, mergeFiles, normalizeServerURL } from '../lib/format'
import { healthActiveSessions } from '../lib/active-sessions'
import { ActivityHealthProjection } from '../lib/activity-health'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from '../lib/provider-origin'
import { shouldAutoConnectServer } from '../lib/first-launch'
import { SNAPSHOT_CACHE_VERSION, shouldReplaceCachedTimeline, snapshotLatestSeq } from '../lib/history'
import { historyNeedsServerRevalidation } from '../lib/history-server-version'
import { asyncQueuedMessageControlsAvailable, crossChatQueueRefreshSessionId, isAsyncQueuedChatMessage, isNativeGoalSteerEvent, isUserQueuedTurn, queueSnapshotRequiresRefresh, queuedDeliverySkipIdentity, queuedMoveCrossesDeliveryBarrier, queuedTurnHasEarlierDeliveryBarrier, resolveNewQueuedTurn, updateQueuedTurns } from '../lib/queue'
import { QueueReconciliationState } from '../lib/queue-reconciliation'
import { isAgentActivityEvent } from '../lib/codex-controls'
import {
  agentCrossChatRoutesAvailable,
  chatReferencesEqual,
  interactiveClientCapabilities,
  localChatReferenceContractSupported,
  reconcileChatReferences,
  removeChatReferencesForSession,
  routeHintMentionsAvailable,
  restoreFailedChatComposer,
  supportedCrossChatTargetBackends,
  validChatReferences,
} from '../lib/chat-references'
import { agentRouteCapacityError, isAgentRouteRevisionConflict } from '../lib/agent-route-policy'
import { publishProviderRuntimeChanged } from '../lib/provider-runtime-events'
import { reconcileTeamReferences, requireTeamReferenceSupport, restoreFailedTeamReferences, teamMessagesAvailable, teamReferenceContractSupported, teamReferencesEqual, teamReferenceTokenPresent, validTeamReferences } from '../lib/team-references'
import { awaitAllCodexPermissionUpdates, awaitCodexPermissionUpdates } from '../lib/codex-permission-updates'
import { awaitAllClaudePermissionUpdates, awaitClaudePermissionUpdates } from '../lib/claude-permission-updates'
import { awaitAllCursorPermissionUpdates } from '../lib/cursor-permission-updates'
import { DEFAULT_SERVER_URL } from '../lib/server-setup'
import { serverSearchQuery } from '../lib/server-search'
import { runtimeSelectionError, selectableChatBackends } from '../lib/runtime-catalog'
import { clearCodeReviewFallbacks } from '../lib/code-review'
import { SessionMutationReconciler, type SessionReadToken } from '../lib/session-mutation-reconciler'
import { APP_FONT_SCALE_DEFAULT, clampAppFontScale } from '../lib/typography'
import { isWelcomeSession, withoutWelcomeRecord } from '../lib/welcome-session'
import { isNativeSteerSupersession, projectPresentableHistory } from '../lib/timeline'
import { timelineTargetIsRepresented } from '../lib/timeline-history-navigation'
import {
  boundHistoricalTimelineEvents,
  boundLiveTimelineEvents,
  historicalTimelineEvents,
  liveTimelineEventsWereTrimmed,
  mergeAndSanitizeIncomingEvents,
  sanitizeTimelineEvent,
  sanitizeTimelineFile,
  snapshotMapWith,
} from '../lib/timeline-memory'
import {
  loadCachedSessions,
  cachedServerSummary,
  deleteProfileToken,
  loadPins,
  loadProfileSettings,
  loadProfileToken,
  loadSnapshot,
  loadWorkspacePreferences,
  migrateCacheNamespace,
  prepareSnapshotCacheGeneration,
  purgeCacheNamespace,
  removeSnapshot,
  saveCachedSessions,
  savePins,
  saveProfileSettings,
  saveProfileToken,
  saveSnapshot,
  saveWorkspacePreferences,
  stageProfileToken,
} from '../storage/cache'
import {
  applyStoredServerProfileUpdate,
  assertUniqueServerProfile,
  createStoredServerProfile,
  DEFAULT_CHAT_DEFAULTS,
  findDuplicateProfileByIdentity,
  findDuplicateProfileByURL,
  profileNamespace,
} from '../lib/server-profiles'

const MIN_API_CONTRACT = 8
const SEMANTIC_PAGING_API_CONTRACT = 9
const TAIL_LIMIT = 240
const SEMANTIC_TAIL_LIMIT = 48
const SEMANTIC_OLDER_LIMIT = 96
const LEGACY_OLDER_LIMIT = 240
const OLDER_TARGET_EVENTS = 96
const OLDER_MAX_REQUESTS = 6
const HISTORY_SEEK_SIDE_LIMIT = 80
const FOREGROUND_REFRESH_MS = 60_000
const LIVE_SNAPSHOT_SAVE_DEBOUNCE_MS = 2_000
const READ_RECEIPT_DEBOUNCE_MS = 3_000
const WORKSPACE_SAVE_DEBOUNCE_MS = 350
const SYNC_RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const
let streamStop: (() => void) | null = null
let streamSessionId: string | null = null
let streamLatestSeq = 0
let streamGeneration = 0
let selectionEpoch = 0
let historyPagingEpoch = 0
let timelineSeekIntentEpoch = 0
let refreshTimer: ReturnType<typeof setInterval> | null = null
let periodicRefreshInFlight = false
let appStateSubscription: { remove(): void } | null = null
let healthFailureCount = 0
let syncInFlight: { sessionId: string; epoch: number; promise: Promise<void> } | null = null
let syncRecovery: { key: string; attempt: number; timer: ReturnType<typeof setTimeout> | null } | null = null
let refreshSessionsInFlight: { scope: ConnectionScope; promise: Promise<void> } | null = null
let refreshJobsInFlight: { scope: ConnectionScope; promise: Promise<void>; dirty: boolean } | null = null
let quickCreateSessionInFlight: { scope: ConnectionScope; promise: Promise<boolean> } | null = null
let readReceiptTimer: ReturnType<typeof setTimeout> | null = null
let pinSaveQueue: Promise<void> = Promise.resolve()
const notifiedEvents = new Set<string>()
let foregroundRepairInFlight: Promise<void> | null = null
const activityHealth = new ActivityHealthProjection()
let profileSwitchIntent = 0
let initializePromise: Promise<void> | null = null
let profileMutationQueue: Promise<void> = Promise.resolve()
let activeConnectionMutationDepth = 0
let reconnectInFlight: { scope: ConnectionScope; promise: Promise<void> } | null = null
let searchRequestRevision = 0
let notificationPermissionRequested = false
let lastBadgeCount: number | null = null
let pendingWorkspaceSave: { scope: ConnectionScope; value: WorkspacePreferences; timer: ReturnType<typeof setTimeout> } | null = null
let pendingLiveSnapshotSave: { scope: ConnectionScope; snapshot: Snapshot; timer: ReturnType<typeof setTimeout> } | null = null
const sendPromptInFlight = new Set<string>()
let turnAdmissionCounter = 0
const queuedRunInFlight = new Map<string, { queuedId: string; promise: Promise<boolean> }>()
const scheduledJobRunInFlight = new Map<string, { scope: ConnectionScope; promise: Promise<JobRunResponse | null> }>()
const stopTurnInFlight = new Set<string>()
const providerReloadInFlight = new Set<string>()
const forkSessionInFlight = new Set<string>()
const queueSnapshotRefreshInFlight = new Map<string, { dirty: boolean }>()
const queuedDeliverySkipTokens = new Map<string, symbol>()
const olderPageInFlight = new Map<string, Promise<number>>()
const filePageInFlight = new Map<string, Promise<void>>()
const sessionMutations = new SessionMutationReconciler()

const SEND_IN_FLIGHT_SERVER_MUTATION_MESSAGE = 'A message is still sending. Wait for it to finish before switching or changing the active server.'
const SERVER_MUTATION_IN_FLIGHT_SEND_MESSAGE = 'The active server is being changed. Wait for it to finish before sending.'
const TIMELINE_INTERNAL_EVENT_TYPES = new Set([
  'turn_queued',
  'turn_unqueued',
  'turn_queue_updated',
  'turn_queue_reordered',
  'turn_queue_run_now',
  'turn_queue_paused',
  'turn_queue_delivery_fenced',
  'queue_snapshot',
  'job_updated',
  'job_deleted',
  'claude_subagents_stopped',
])
const SESSION_METADATA_PASSIVE_EVENT_TYPES = new Set([
  ...TIMELINE_INTERNAL_EVENT_TYPES,
  'subagent_state',
  'raw_event',
  'reasoning_summary',
  'tool_started',
  'tool_finished',
  'codex_thread_status',
])

class SendInFlightServerMutationError extends Error {
  constructor() {
    super(SEND_IN_FLIGHT_SERVER_MUTATION_MESSAGE)
    this.name = 'SendInFlightServerMutationError'
  }
}

class StaleActionScopeError extends Error {
  constructor() {
    super('This action belongs to a server workspace that is no longer active.')
    this.name = 'StaleActionScopeError'
  }
}

interface ConnectionScope {
  readonly profileId: string
  readonly generation: number
  namespace: string
  namespaceAdopting: boolean
  jobsMutationRevision: number
  readonly client: AgentServerClient
}

let connectionGeneration = 0
let activeConnection: ConnectionScope = {
  profileId: 'uninitialized',
  generation: connectionGeneration,
  namespace: 'profile:uninitialized',
  namespaceAdopting: false,
  jobsMutationRevision: 0,
  client: new AgentServerClient(DEFAULT_SERVER_URL, '', { requireValidation: true }),
}

export let client = activeConnection.client

const agentRouteRefreshTokens = new Map<string, symbol>()
const agentRouteMutationTokens = new Map<string, symbol>()
const queuedAgentEditTokens = new Map<string, symbol>()

function emptyAgentRouteState() {
  agentRouteRefreshTokens.clear()
  agentRouteMutationTokens.clear()
  queuedDeliverySkipTokens.clear()
  queuedAgentEditTokens.clear()
  queuedRunInFlight.clear()
  return {
    agentRoutesBySession: {},
    agentRouteErrorsBySession: {},
    agentRouteLoadingSessionIds: new Set<string>(),
    revokingAgentRouteIds: new Set<string>(),
    skippingQueuedDeliveryIds: new Set<string>(),
    // Revalidation invalidates the operation, not just its late response. A
    // hung old request must not leave the replacement workspace disabled.
    pendingQueuedRunIds: new Set<string>(),
  }
}

function captureAgentRouteGuard(scope: ConnectionScope, get: () => AppState): () => boolean {
  const validationRevision = scope.client.validationRevision
  const identity = get().health?.server_identity
  const instance = get().health?.server_instance_id
  return () => validatedRevisionIsCurrent(scope, validationRevision)
    && get().profileGeneration === scope.generation
    && get().activeProfileId === scope.profileId
    && get().connected && !get().connecting && !get().switchingProfileId && !get().workspaceAdopting
    && get().health?.server_identity === identity
    && get().health?.server_instance_id === instance
}

function queuedOperationKey(scope: ConnectionScope, sessionId: string, get: () => AppState, queuedId?: string): string {
  return JSON.stringify([scope.generation, scope.client.validationRevision,
    get().health?.server_identity ?? null, get().health?.server_instance_id ?? null,
    sessionId, queuedId ?? null])
}

// Queue reads and stream packets share one observation clock per validated
// server instance. Even a no-op delivery invalidates an older HTTP response.
const queueReconciliationScopes = new WeakMap<ConnectionScope, {
  validationRevision: number
  identity: string | undefined
  instance: string | undefined
  sessions: Map<string, QueueReconciliationState>
}>()
function queueReconciliationState(scope: ConnectionScope, sessionId: string, get: () => AppState): QueueReconciliationState {
  const validationRevision = scope.client.validationRevision
  const identity = get().health?.server_identity
  const instance = get().health?.server_instance_id
  let owner = queueReconciliationScopes.get(scope)
  if (!owner || owner.validationRevision !== validationRevision || owner.identity !== identity || owner.instance !== instance) {
    owner = { validationRevision, identity, instance, sessions: new Map() }
    queueReconciliationScopes.set(scope, owner)
  }
  let state = owner.sessions.get(sessionId)
  if (!state) { state = new QueueReconciliationState(); owner.sessions.set(sessionId, state) }
  return state
}

function captureConnection(): ConnectionScope { return activeConnection }
function activityScope(scope: ConnectionScope): string { return JSON.stringify([scope.generation, scope.client.validationRevision]) }
function connectionIsCurrent(scope: ConnectionScope): boolean { return activeConnection === scope }
function markJobsMutated(scope: ConnectionScope): void {
  scope.jobsMutationRevision += 1
  if (refreshJobsInFlight?.scope === scope) refreshJobsInFlight.dirty = true
}
function isStaleConnectionError(error: unknown, scope: ConnectionScope): boolean {
  return !connectionIsCurrent(scope)
    || error instanceof AgentServerClientDisposedError
    || error instanceof AgentServerClientUnvalidatedError
}

function captureValidatedConnection(get: () => AppState, expectedGeneration?: number): ConnectionScope {
  const scope = captureConnection()
  const state = get()
  if (
    (expectedGeneration !== undefined && expectedGeneration !== scope.generation)
    || state.profileGeneration !== scope.generation
    || state.activeProfileId !== scope.profileId
  ) {
    throw new StaleActionScopeError()
  }
  if (!scope.client.isValidated || !state.connected || state.connecting || state.switchingProfileId) {
    throw new Error('Wait for server identity verification before sending requests.')
  }
  return scope
}

function validatedConnectionOrReport(
  get: () => AppState,
  set: (value: Partial<AppState>) => void,
  expectedGeneration?: number,
): ConnectionScope | null {
  try {
    return captureValidatedConnection(get, expectedGeneration)
  } catch (error) {
    set({ error: errorMessage(error) })
    return null
  }
}

function installConnection(
  profileId: string,
  serverURL: string,
  token: string,
  namespace: string,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
): ConnectionScope {
  const previous = activeConnection
  filePageInFlight.clear()
  let next: ConnectionScope
  next = {
    profileId,
    generation: ++connectionGeneration,
    namespace,
    namespaceAdopting: false,
    jobsMutationRevision: 0,
    client: new AgentServerClient(serverURL, token, {
      requireValidation: true,
      onAuthorizationFailure: error => forceValidationOffline(next, errorMessage(error), set),
      onServerError: error => {
        if (!connectionIsCurrent(next) || !serverUpdatePendingError(error)) return
        set(state => ({
          error: errorMessage(error),
          pendingServerUpdate: serverUpdateNotice(next, state.health),
        }))
      },
    }),
  }
  activeConnection = next
  client = next.client
  previous.client.dispose()
  set(emptyAgentRouteState())
  return next
}

export type ChatSyncStatus = 'idle' | 'cached' | 'syncing' | 'live' | 'reconnecting' | 'offline' | 'error'
type SyncReason = 'selection' | 'manual' | 'foreground' | 'server-ahead' | 'recovery'

export interface HistoryWindow {
  profileGeneration: number
  sessionId: string
  beforeCursor: number
  snapshot: Snapshot
  /** Search results use a bounded, non-contiguous window around one anchor. */
  detached?: boolean
  anchorEventId?: string | null
  anchorSeq?: number | null
  anchorRevision?: number
}

interface FilePagingState {
  loading: boolean
  hasMore: boolean
  nextOffset: number
  error: string | null
  retryAppend: boolean
}

interface PendingServerUpdateNotice {
  profileId: string
  profileGeneration: number
  canCancel: boolean
}

interface SendPromptOptions {
  promptOverride?: string
  consumeComposer?: boolean
  admissionToken?: string
  admittedDraft?: string
  admittedFiles?: AgentFile[]
  chatReferences?: ChatReference[]
  teamReferences?: TeamReference[]
}

function timelinePageNextBefore(page: TimelinePage): number | null {
  if (!page.has_more) return null
  return page.next_before
    ?? page.next_semantic_before
    ?? page.before
    ?? page.events[0]?.seq
    ?? null
}

async function timelineSeekPage(
  scope: ConnectionScope,
  sessionId: string,
  options: { after?: number; before?: number; limit: number; tail: boolean },
  semantic: boolean,
): Promise<TimelinePage> {
  let page = await scope.client.sessionPage(sessionId, {
    ...options,
    visible: true,
    pageMode: semantic ? 'semantic' : undefined,
  })
  if (semantic && page.semantic_paging !== true) {
    // A proxy can report the current contract while dropping the semantic
    // query. Retry the same bounded window without compaction so the exact
    // search hit is not silently discarded.
    page = await scope.client.sessionPage(sessionId, { ...options, visible: true })
  }
  return page
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
})

interface AppState {
  initialized: boolean
  profiles: PublicServerProfile[]
  activeProfileId: string | null
  profileGeneration: number
  switchingProfileId: string | null
  workspaceAdopting: boolean
  connected: boolean
  liveConnected: boolean
  syncSessionId: string | null
  syncStatus: ChatSyncStatus
  syncError: string | null
  syncRetryAttempt: number
  syncRetryAt: number | null
  lastTimelineSyncAt: number | null
  connecting: boolean
  error: string | null
  pendingServerUpdate: PendingServerUpdateNotice | null
  cancelingServerUpdate: boolean
  serverURL: string
  serverConfigured: boolean
  token: string
  health: Health | null
  runtime: RuntimeCatalog | null
  sessions: Session[]
  selectedSessionId: string | null
  snapshots: Record<string, Snapshot>
  historyWindow: HistoryWindow | null
  loadingSessionId: string | null
  loadingOlder: Record<string, boolean>
  filePaging: Record<string, FilePagingState | undefined>
  activeSessionIds: Set<string>
  turnAdmissionTokens: Record<string, string>
  sendingSessionIds: Set<string>
  stoppingSessionIds: Set<string>
  pendingQueuedRunIds: Set<string>
  pendingJobRunIds: Set<string>
  queuedRunStatus: Record<string, QueuedRunStatus | undefined>
  jobs: Job[]
  drafts: Record<string, string>
  chatReferencesBySession: Record<string, ChatReference[]>
  agentRoutesBySession: Record<string, AgentCrossChatRoutesSnapshot>
  agentRouteErrorsBySession: Record<string, string | null>
  agentRouteLoadingSessionIds: Set<string>
  revokingAgentRouteIds: Set<string>
  skippingQueuedDeliveryIds: Set<string>
  teamReferencesBySession: Record<string, TeamReference[]>
  uploads: Record<string, AgentFile[]>
  uploadPending: Record<string, UploadRef[]>
  uploadFailed: Record<string, FailedUpload[]>
  pins: PinnedItem[]
  folderOrder: string[]
  collapsedFolders: string[]
  chatDefaults: ChatDefaults
  fontScale: number
  searchResults: TimelineSearchResult[]
  searchBusy: boolean
  searchError: string | null
  timelineIndex: Record<string, TimelineIndex>
  processes: Record<string, ProcessSnapshot>
  tmuxPanes: Record<string, TmuxPane[]>

  initialize(): Promise<void>
  applySettings(serverURL: string, token: string): Promise<void>
  testServerProfile(input: { profileId?: string; serverURL: string; accessToken?: string | null }): Promise<Health>
  createServerProfile(input: AddServerProfileInput): Promise<string>
  updateServerProfile(profileId: string, patch: UpdateServerProfileInput): Promise<void>
  removeServerProfile(profileId: string): Promise<void>
  reorderServerProfiles(profileIds: string[]): Promise<void>
  switchServerProfile(profileId: string): Promise<boolean>
  reconnect(): Promise<void>
  retryConnection(): Promise<void>
  cancelPendingServerUpdate(expectedGeneration?: number): Promise<boolean>
  refreshRuntime(): Promise<void>
  refreshSessions(expectedGeneration?: number): Promise<void>
  selectSession(sessionId: string, expectedGeneration?: number): Promise<void>
  syncSelectedSession(reason?: SyncReason): Promise<void>
  loadOlder(sessionId?: string): Promise<number>
  seekTimelineResult(result: TimelineSearchResult, expectedGeneration?: number): Promise<boolean>
  cancelTimelineSeek(): void
  exitHistory(): void
  refreshFiles(sessionId?: string, append?: boolean, expectedGeneration?: number): Promise<void>
  refreshTimelineIndex(sessionId?: string): Promise<void>
  loadRunTrace(sessionId: string, runId: string, anchorSeq: number, afterSeq?: number, limit?: number, expectedGeneration?: number): Promise<TimelineTracePage>
  loadJobRuns(sessionId: string, jobId: string, beforeSeq?: number | null, limit?: number, expectedGeneration?: number): Promise<JobRunHistoryPage>
  setDraft(text: string): void
  setSessionDraft(sessionId: string, text: string, expectedGeneration?: number): void
  setChatReferencesForSession(sessionId: string, references: ChatReference[], expectedGeneration?: number): void
  setTeamReferencesForSession(sessionId: string, references: TeamReference[], expectedGeneration?: number): void
  stageTeamMailDraft(input: StageTeamMailDraftInput): Promise<boolean>
  refreshAgentRoutes(sessionId: string, expectedGeneration?: number): Promise<AgentCrossChatRoutesSnapshot | null>
  revokeAgentRoute(sessionId: string, routeId: string, expectedRevision: string, expectedGeneration?: number): Promise<boolean>
  beginTurnAdmission(sessionId: string): string | null
  endTurnAdmission(sessionId: string, token: string): void
  sendPrompt(steer?: boolean, expectedGeneration?: number, expectedSessionId?: string, options?: SendPromptOptions): Promise<boolean>
  stopTurn(expectedGeneration?: number, expectedSessionId?: string): Promise<void>
  attachFiles(files: UploadRef[], expectedGeneration?: number, expectedSessionId?: string): Promise<void>
  removeUpload(fileId: string, expectedGeneration?: number, expectedSessionId?: string): void
  removeFailedUpload(fileUri: string, expectedGeneration?: number, expectedSessionId?: string): void
  updateSession(sessionId: string, patch: Partial<Pick<Session, 'title' | 'folder' | 'cwd' | 'backend' | 'model' | 'effort' | 'system_prompt' | 'codex_approval_policy' | 'codex_sandbox_mode' | 'codex_permission_profile' | 'codex_approvals_reviewer' | 'claude_permission_mode' | 'cursor_permission_mode' | 'provider_jobs_access' | 'pinned' | 'archived'>>, expectedGeneration?: number): Promise<boolean>
  reloadProvider(sessionId: string, expectedGeneration?: number): Promise<ProviderReloadResult | null>
  createSession(input: CreateSessionInput, expectedGeneration?: number): Promise<boolean>
  quickCreateSession(expectedGeneration?: number): Promise<boolean>
  setChatDefaults(patch: Partial<ChatDefaults>): void
  forkSession(sessionId: string, expectedGeneration?: number): Promise<void>
  deleteSession(sessionId: string, expectedGeneration?: number): Promise<void>
  reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after', expectedGeneration?: number): Promise<void>
  markRead(sessionId: string, expectedGeneration?: number): Promise<void>
  markUnread(sessionId: string, expectedGeneration?: number): Promise<void>
  acknowledgeEmergency(sessionId: string, alertId: string, expectedGeneration?: number): Promise<boolean>
  setFolderOrder(order: string[], expectedGeneration?: number): void
  setCollapsedFolders(folders: string[], expectedGeneration?: number): void
  setFontScale(value: number): void
  updateQueued(sessionId: string, queuedId: string, prompt: string, chatReferences?: ChatReference[], expectedGeneration?: number, teamReferencesInput?: TeamReference[]): Promise<boolean>
  updateQueuedAgentMessage(sessionId: string, queuedId: string, prompt: string, expectedMessageRevision: number, expectedGeneration?: number): Promise<boolean>
  removeQueued(sessionId: string, queuedId: string, expectedGeneration?: number): Promise<boolean>
  skipQueuedDelivery(sessionId: string, queuedId: string, expectedGeneration?: number): Promise<boolean>
  moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down', expectedGeneration?: number): Promise<boolean>
  runQueuedNow(sessionId: string, queuedId: string, expectedGeneration?: number): Promise<boolean>
  clearQueuedRunStatus(sessionId: string, expectedGeneration?: number): void
  refreshJobs(expectedGeneration?: number): Promise<void>
  createJob(input: CreateJobInput, expectedGeneration?: number): Promise<boolean>
  updateJob(jobId: string, patch: UpdateJobInput, expectedGeneration?: number): Promise<boolean>
  deleteJob(jobId: string, expectedGeneration?: number): Promise<void>
  runJob(jobId: string, expectedGeneration?: number): Promise<JobRunResponse | null>
  search(query: string, sessionId?: string, expectedGeneration?: number): Promise<void>
  clearSearch(): void
  pinMessage(sessionId: string, event: Event, body: string, expectedGeneration?: number): Promise<boolean>
  pinFile(sessionId: string, file: AgentFile, expectedGeneration?: number): Promise<boolean>
  removePin(id: string, expectedGeneration?: number): Promise<boolean>
  inspectProcesses(sessionId?: string): Promise<void>
  inspectTmux(sessionId?: string, includeAll?: boolean): Promise<void>
  clearError(): void
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  profiles: [],
  activeProfileId: null,
  profileGeneration: 0,
  switchingProfileId: null,
  workspaceAdopting: false,
  connected: false,
  liveConnected: false,
  syncSessionId: null,
  syncStatus: 'idle',
  syncError: null,
  syncRetryAttempt: 0,
  syncRetryAt: null,
  lastTimelineSyncAt: null,
  connecting: false,
  error: null,
  pendingServerUpdate: null,
  cancelingServerUpdate: false,
  serverURL: DEFAULT_SERVER_URL,
  serverConfigured: false,
  token: '',
  health: null,
  runtime: null,
  sessions: [],
  selectedSessionId: null,
  snapshots: {},
  historyWindow: null,
  loadingSessionId: null,
  loadingOlder: {},
  filePaging: {},
  activeSessionIds: new Set(),
  turnAdmissionTokens: {},
  sendingSessionIds: new Set(),
  stoppingSessionIds: new Set(),
  pendingJobRunIds: new Set(),
  queuedRunStatus: {},
  jobs: [],
  drafts: {},
  chatReferencesBySession: {},
  ...emptyAgentRouteState(),
  teamReferencesBySession: {},
  uploads: {},
  uploadPending: {},
  uploadFailed: {},
  pins: [],
  folderOrder: [],
  chatDefaults: DEFAULT_CHAT_DEFAULTS,
  collapsedFolders: [],
  fontScale: APP_FONT_SCALE_DEFAULT,
  searchResults: [],
  searchBusy: false,
  searchError: null,
  timelineIndex: {},
  processes: {},
  tmuxPanes: {},

  async initialize() {
    if (get().initialized) return
    if (initializePromise) return initializePromise
    const operation = (async () => {
      try {
        // Build 87 reused the old cache version after reducing timeline limits,
        // leaving multi-megabyte snapshots trusted. Remove them by key before
        // any JSON value can be read or parsed on a memory-constrained device.
        await prepareSnapshotCacheGeneration()
        const settings = await loadProfileSettings()
        const activeProfile = settings.profiles.find(profile => profile.id === settings.activeProfileId) ?? settings.profiles[0]
        const namespace = profileNamespace(activeProfile)
        const [token, sessions, pins, workspace, profiles] = await Promise.all([
          loadProfileToken(activeProfile.id, activeProfile.credentialVersion),
          loadCachedSessions(namespace),
          loadPins(namespace),
          loadWorkspacePreferences(namespace),
          hydratePublicProfiles(settings.profiles, activeProfile.id),
        ])
        const scope = installConnection(activeProfile.id, activeProfile.serverURL, token, namespace, set)
        const selected = workspace.selectedSessionId && sessions.some(value => value.id === workspace.selectedSessionId)
          ? workspace.selectedSessionId
          : sessions.find(value => !value.archived)?.id ?? null
        set({
          initialized: true,
          profiles,
          activeProfileId: activeProfile.id,
          profileGeneration: scope.generation,
          serverURL: activeProfile.serverURL,
          serverConfigured: activeProfile.serverConfigured,
          token,
          sessions,
          pins,
          drafts: workspace.drafts,
          chatReferencesBySession: workspace.chatReferencesBySession ?? {},
          teamReferencesBySession: workspace.teamReferencesBySession ?? {},
          selectedSessionId: selected,
          syncSessionId: selected,
          syncStatus: selected ? 'cached' : 'idle',
          folderOrder: workspace.folderOrder,
          collapsedFolders: workspace.collapsedFolders,
          chatDefaults: workspace.chatDefaults ?? DEFAULT_CHAT_DEFAULTS,
          fontScale: settings.fontScale,
        })
        // Subscribe before any cache or network await below. Otherwise the app
        // can background during launch while initialization still assumes it
        // is active, then continue into the expensive reconciliation fan-out.
        installAppLifecycle(get, set)
        if (selected) {
          const cached = await loadSnapshot(namespace, selected)
          if (connectionIsCurrent(scope) && cached) set(state => ({ snapshots: snapshotMapWith(state.snapshots, selected, cached) }))
        }
        if (NativeAppState.currentState === 'active' && shouldAutoConnectServer(get())) {
          await get().reconnect()
          if (get().connected) {
            void updateBadge(get())
          }
        }
      } catch (error) {
        set({ initialized: true, connecting: false, connected: false, error: `Could not load saved server profiles: ${errorMessage(error)}` })
      } finally {
        installAppLifecycle(get, set)
      }
    })()
    initializePromise = operation
    try {
      await operation
    } finally {
      if (initializePromise === operation) initializePromise = null
    }
  },

  async applySettings(rawURL, token) {
    const profileId = get().activeProfileId
    if (!profileId) throw new Error('No active server profile.')
    await get().updateServerProfile(profileId, { serverURL: normalizeServerURL(rawURL), accessToken: token })
  },

  async testServerProfile(input) {
    const existing = input.profileId ? get().profiles.find(profile => profile.id === input.profileId) : null
    const token = input.accessToken === undefined && existing
      ? await loadProfileToken(existing.id, existing.credentialVersion)
      : input.accessToken ?? ''
    return probeServerHealth(input.serverURL, token)
  },

  async createServerProfile(input) {
    let activation: { intent: number; scope: ConnectionScope } | null = null
    const createProfile = async () => {
      const stored = storedProfiles(get().profiles)
      const normalizedURL = normalizeServerURL(input.serverURL)
      const duplicateURL = findDuplicateProfileByURL(stored, normalizedURL)
      if (duplicateURL) {
        const placeholder = stored.length === 1 && duplicateURL.id === stored[0].id && !stored[0].serverConfigured && !stored[0].serverIdentity
        if (!placeholder) assertUniqueServerProfile(stored, { serverURL: normalizedURL, serverIdentity: null })
        const patch: UpdateServerProfileInput = {
          name: input.name,
          serverURL: normalizedURL,
          accessToken: input.accessToken,
          serverIdentity: input.serverIdentity,
          serverConfigured: true,
        }
        const updateDuplicate = async () => {
          const changed = await updateServerProfileLocked(duplicateURL.id, patch, set, get)
          if (changed && duplicateURL.id === get().activeProfileId) {
            activation = await prepareServerProfileActivation(duplicateURL.id, true, set, get)
          }
          return duplicateURL.id
        }
        return duplicateURL.id === get().activeProfileId && serverProfileConnectionChanges(duplicateURL, patch)
          ? withActiveConnectionMutation(set, get, updateDuplicate)
          : updateDuplicate()
      }
      assertUniqueServerProfile(stored, { serverURL: normalizedURL, serverIdentity: null })
      const token = input.accessToken ?? ''
      const health = await probeServerHealth(normalizedURL, token)
      const identity = requiredServerIdentity(health)
      const testedIdentity = input.serverIdentity?.trim()
      if (testedIdentity && testedIdentity !== identity) {
        throw new Error(`The server identity changed after the connection test (expected ${testedIdentity}, received ${identity}). Test the connection again.`)
      }
      assertUniqueServerProfile(stored, { serverURL: normalizedURL, serverIdentity: identity })
      const profile = createStoredServerProfile({
        ...input,
        serverURL: normalizedURL,
        serverIdentity: identity,
        serverConfigured: true,
      }, createProfileId())
      await saveProfileToken(profile.id, profile.credentialVersion, token)
      try {
        await saveProfileSettings({
          schemaVersion: 2,
          activeProfileId: get().activeProfileId ?? profile.id,
          profiles: [...stored, profile],
          fontScale: get().fontScale,
        })
      } catch (error) {
        await deleteProfileToken(profile.id, profile.credentialVersion).catch(() => undefined)
        throw error
      }
      set(state => ({
        profiles: [...state.profiles, publicProfile(profile, Boolean(token), {
          connectionState: 'online',
          serverVersion: healthVersion(health),
          lastConnectionCheckedAt: Date.now(),
        })],
      }))
      if (input.setActive !== false) activation = await prepareServerProfileActivation(profile.id, true, set, get)
      return profile.id
    }
    const profileId = await withProfileMutation(() => input.setActive !== false
      ? withActiveConnectionMutation(set, get, createProfile)
      : createProfile())
    if (activation) await completeServerProfileActivation(activation, set, get)
    return profileId
  },

  async updateServerProfile(profileId, patch) {
    let activation: { intent: number; scope: ConnectionScope } | null = null
    const requestedProfile = get().profiles.find(value => value.id === profileId)
    if (requestedProfile && profileId === get().activeProfileId && serverProfileConnectionChanges(requestedProfile, patch)) {
      assertNoSendInFlightForServerMutation(set, get)
    }
    await withProfileMutation(async () => {
      const profile = get().profiles.find(value => value.id === profileId)
      const update = async () => {
        const changed = await updateServerProfileLocked(profileId, patch, set, get)
        if (changed && profileId === get().activeProfileId) {
          activation = await prepareServerProfileActivation(profileId, true, set, get)
        }
      }
      if (profile && profileId === get().activeProfileId && serverProfileConnectionChanges(profile, patch)) {
        await withActiveConnectionMutation(set, get, update)
      } else await update()
    })
    if (activation) await completeServerProfileActivation(activation, set, get)
  },

  async removeServerProfile(profileId) {
    await withProfileMutation(async () => {
      if (profileId === get().activeProfileId) throw new Error('Switch to another server before removing this profile.')
      const removed = get().profiles.find(profile => profile.id === profileId)
      if (!removed) throw new Error('Server profile not found.')
      const profiles = storedProfiles(get().profiles).filter(profile => profile.id !== profileId)
      if (!profiles.length) throw new Error('At least one server profile is required.')
      await saveProfileSettings({ schemaVersion: 2, activeProfileId: get().activeProfileId ?? profiles[0].id, profiles, fontScale: get().fontScale })
      if (profileId === get().activeProfileId) throw new Error('The active server changed while removal was being saved.')
      set(state => ({ profiles: state.profiles.filter(profile => profile.id !== profileId) }))
      await deleteProfileToken(profileId, removed.credentialVersion).catch(() => undefined)
    })
  },

  async reorderServerProfiles(profileIds) {
    await withProfileMutation(async () => {
      const current = get().profiles
      if (profileIds.length !== current.length || new Set(profileIds).size !== current.length || profileIds.some(id => !current.some(profile => profile.id === id))) {
        throw new Error('Server profile order is invalid.')
      }
      const byId = new Map(current.map(profile => [profile.id, profile]))
      const profiles = profileIds.map(id => byId.get(id)!)
      await saveProfileSettings({ schemaVersion: 2, activeProfileId: get().activeProfileId ?? profiles[0].id, profiles: storedProfiles(profiles), fontScale: get().fontScale })
      set({ profiles })
    })
  },

  async switchServerProfile(profileId) {
    if (profileId !== get().activeProfileId || get().switchingProfileId) {
      assertNoSendInFlightForServerMutation(set, get)
    }
    return activateServerProfile(profileId, false, set, get)
  },

  async reconnect() {
    if (NativeAppState.currentState !== 'active' || !shouldAutoConnectServer(get())) return
    const requestedScope = captureConnection()
    if (reconnectInFlight?.scope === requestedScope) return reconnectInFlight.promise
    const operation = (async () => {
      if (NativeAppState.currentState !== 'active' || get().connecting) return
      const scope = requestedScope
      scope.client.revokeValidation()
      set(emptyAgentRouteState())
      if (!get().connected) stopSelectedStream()
      set(state => ({
      connecting: true,
      error: null,
      profiles: updateProfileRuntime(state.profiles, scope.profileId, {
        connectionState: state.connected ? 'retrying' : 'connecting',
        lastConnectionError: null,
      }),
      syncStatus: state.selectedSessionId
        ? (state.syncStatus === 'offline' || state.syncStatus === 'reconnecting' ? 'reconnecting' : 'syncing')
        : state.syncStatus,
      syncError: null,
    }))
    const activityRequest = activityHealth.capture(activityScope(scope))
    const healthValidationRevision = scope.client.validationRevision
    let health: Health
    try {
      health = await scope.client.health()
      if (pauseReconnectForInactiveApp(scope, set)) return
      if (health.ok !== true) throw new Error('Server health check did not report ready.')
      const contract = health.api_contract_version ?? 0
      if (contract < MIN_API_CONTRACT) throw new Error(`Server upgrade required: app needs API v${MIN_API_CONTRACT}, server reports v${contract}.`)
      await acceptHealthIdentity(scope, health, healthValidationRevision, set, get)
      if (pauseReconnectForInactiveApp(scope, set)) return
      if (!scope.client.isValidated) throw new AgentServerClientUnvalidatedError()
    } catch (error) {
      if (pauseReconnectForInactiveApp(scope, set)) return
      if (isStaleConnectionError(error, scope)) return
      const message = errorMessage(error)
      forceValidationOffline(scope, message, set)
      return
    }

    const acceptedValidationRevision = scope.client.validationRevision
    if (pauseReconnectForInactiveApp(scope, set)) return
    if (!validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
    healthFailureCount = 0
    health = activityHealth.accept(activityScope(scope), health, activityRequest)
    set(state => ({
      connected: true,
      // Identity and credentials are authoritative once health validation
      // succeeds. Do not keep the composer disabled while the independent
      // session-list refresh finishes (it may be slow on a busy server).
      connecting: false,
      serverConfigured: true,
      health,
      activeSessionIds: healthActiveSessions(health),
      profiles: updateProfileRuntime(state.profiles, scope.profileId, {
        connectionState: 'online',
        lastConnectionError: null,
        lastConnectionCheckedAt: Date.now(),
        serverVersion: healthVersion(health),
      }),
    }))
    requestNotificationPermissionOnce()
    const sessionRead = sessionMutations.captureRead()
    const sessionsRequest = Promise.allSettled([scope.client.sessions()] as const)
    const optionalRequests = Promise.allSettled([scope.client.runtimeCatalog(true), scope.client.jobs()] as const)
    void optionalRequests.then(([runtimeResult, jobsResult]) => {
      if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope)) return
      if (!validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
      set(state => ({
        runtime: runtimeResult.status === 'fulfilled' ? runtimeResult.value : state.runtime,
        jobs: jobsResult.status === 'fulfilled' ? jobsResult.value : state.jobs,
      }))
    })

    const [sessionsResult] = await sessionsRequest
    if (pauseReconnectForInactiveApp(scope, set)) return
    if (!validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
    if (
      sessionsResult.status === 'rejected'
      && isDefinitiveValidationFailure(sessionsResult.reason, errorMessage(sessionsResult.reason))
    ) {
      forceValidationOffline(scope, errorMessage(sessionsResult.reason), set)
      return
    }
    const incomingSessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : get().sessions
    let selected = get().selectedSessionId
    if (sessionsResult.status === 'fulfilled' && (!selected || !incomingSessions.some(value => value.id === selected))) {
      selected = incomingSessions.find(value => !value.archived)?.id ?? null
    }
    let sessions = incomingSessions
    set(state => {
      health = activityHealth.accept(activityScope(scope), health, activityRequest)
      sessions = sessionsResult.status === 'fulfilled'
        ? mergeSessionState(incomingSessions, state.sessions, sessionRead)
        : state.sessions
      return {
        connected: true,
        connecting: false,
        health,
        sessions,
        profiles: updateProfileRuntime(state.profiles, scope.profileId, {
          connectionState: sessionsResult.status === 'fulfilled' ? 'online' : 'degraded',
          cachedUnreadCount: unreadCount(sessions),
          lastConnectionError: sessionsResult.status === 'rejected' ? errorMessage(sessionsResult.reason) : null,
          lastConnectionCheckedAt: Date.now(),
          serverVersion: healthVersion(health),
        }),
        activeSessionIds: healthActiveSessions(health),
        selectedSessionId: selected,
        error: sessionsResult.status === 'rejected' ? errorMessage(sessionsResult.reason) : null,
      }
    })
    void updateBadge(get())
    const saves: Promise<void>[] = [saveCurrentWorkspace(get)]
    if (sessionsResult.status === 'fulfilled') saves.push(saveCachedSessions(scope.namespace, sessions))
    void Promise.all(saves).catch(error => { if (connectionIsCurrent(scope)) set({ error: errorMessage(error) }) })
      if (selected) {
        try {
          await get().selectSession(selected)
        } catch (error) {
          if (isStaleConnectionError(error, scope)) return
          const message = errorMessage(error)
          set({ error: message, loadingSessionId: null, liveConnected: false, syncSessionId: selected, syncStatus: 'error', syncError: message })
        }
      } else {
        stopSelectedStream()
        set({ syncSessionId: null, syncStatus: 'idle', syncError: null, lastTimelineSyncAt: null })
      }
    })()
    reconnectInFlight = { scope: requestedScope, promise: operation }
    try {
      await operation
    } finally {
      if (reconnectInFlight?.promise === operation) reconnectInFlight = null
    }
  },

  async retryConnection() {
    cancelSyncRecovery(set)
    const { connected, connecting, liveConnected, selectedSessionId } = get()
    if (connecting) return
    if (!connected) {
      stopSelectedStream()
      await get().reconnect()
      return
    }
    if (!selectedSessionId) {
      await get().refreshSessions()
      return
    }
    if (hasSelectedStream(selectedSessionId) && !liveConnected) stopSelectedStream()
    await get().syncSelectedSession('manual')
  },

  async cancelPendingServerUpdate(expectedGeneration) {
    const state = get()
    const currentScope = captureConnection()
    const notice = state.pendingServerUpdate
    if (
      state.cancelingServerUpdate
      || !notice
      || notice.profileId !== currentScope.profileId
      || notice.profileGeneration !== currentScope.generation
      || (expectedGeneration !== undefined && expectedGeneration !== currentScope.generation)
    ) return false
    if (!notice.canCancel || !serverUpdateCancellationAvailable(state.health)) {
      set({
        pendingServerUpdate: null,
        error: 'This AgentsServer cannot cancel a pending managed update from mobile. Wait for the update to finish, then send again.',
      })
      return false
    }
    const scope = validatedConnectionOrReport(get, set, currentScope.generation)
    if (!scope) return false
    set({ cancelingServerUpdate: true })
    try {
      const status = await scope.client.serverUpdateStatus()
      if (!connectionIsCurrent(scope)) return false
      const scheduleId = cancelableServerUpdateScheduleId(status)
      if (!scheduleId) {
        set({
          pendingServerUpdate: null,
          error: serverUpdateUncancelableMessage(status),
        })
        return false
      }
      await scope.client.cancelServerUpdate(scheduleId)
      if (!connectionIsCurrent(scope)) return false
      set({ pendingServerUpdate: null, error: null })
      return true
    } catch (error) {
      if (isStaleConnectionError(error, scope)) return false
      const code = serverErrorCode(error)
      if (code === 'server_update_changed') {
        let refreshed: ServerUpdateStatus | null = null
        try {
          refreshed = await scope.client.serverUpdateStatus()
        } catch {
          // Preserve the compare-and-swap failure. A later explicit tap will
          // fetch authoritative status again; cancellation is never replayed.
        }
        if (!connectionIsCurrent(scope)) return false
        const canRetry = refreshed === null || Boolean(cancelableServerUpdateScheduleId(refreshed))
        set({
          pendingServerUpdate: canRetry ? serverUpdateNotice(scope, get().health) : null,
          error: refreshed === null
            ? 'The scheduled server update changed, but its current status could not be refreshed. Tap Cancel update to try again.'
            : canRetry
              ? 'The scheduled server update changed. Tap Cancel update again to confirm the current reservation.'
              : serverUpdateUncancelableMessage(refreshed),
        })
        return false
      }
      set({
        pendingServerUpdate: code === 'server_update_not_cancelable' ? null : notice,
        error: errorMessage(error),
      })
      return false
    } finally {
      if (connectionIsCurrent(scope)) set({ cancelingServerUpdate: false })
    }
  },

  async refreshRuntime() {
    if (NativeAppState.currentState !== 'active' || !get().connected) return
    const scope = captureConnection()
    const activityRequest = activityHealth.capture(activityScope(scope))
    const healthValidationRevision = scope.client.validationRevision
    try {
      let health = await scope.client.health()
      if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope)) return
      await acceptHealthIdentity(scope, health, healthValidationRevision, set, get)
      if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope)) return
      const acceptedValidationRevision = scope.client.validationRevision
      const runtime = await scope.client.runtimeCatalog(true)
      if (NativeAppState.currentState !== 'active' || !validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
      health = activityHealth.accept(activityScope(scope), health, activityRequest)
      set(state => ({
        runtime,
        health,
        activeSessionIds: healthActiveSessions(health),
        error: null,
      }))
    } catch (error) {
      if (NativeAppState.currentState !== 'active') return
      if (isStaleConnectionError(error, scope)) return
      const message = errorMessage(error)
      if (!isDefinitiveValidationFailure(error, message)) {
        set({ error: message })
        return
      }
      forceValidationOffline(scope, message, set)
    }
  },

  async refreshSessions(expectedGeneration) {
    if (NativeAppState.currentState !== 'active' || !get().connected) return
    const scope = captureConnection()
    if (expectedGeneration !== undefined && expectedGeneration !== scope.generation) return
    if (refreshSessionsInFlight?.scope === scope) return refreshSessionsInFlight.promise
    const operation = (async () => {
      const activityRequest = activityHealth.capture(activityScope(scope))
      const healthValidationRevision = scope.client.validationRevision
      let health: Health
      try {
        health = await scope.client.health()
        if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope)) return
        await acceptHealthIdentity(scope, health, healthValidationRevision, set, get)
        if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope)) return
      } catch (error) {
        if (NativeAppState.currentState !== 'active') return
        if (isStaleConnectionError(error, scope)) return
        const message = errorMessage(error)
        const validationFailure = isDefinitiveValidationFailure(error, message)
        healthFailureCount = validationFailure ? 2 : healthFailureCount + 1
        const offline = healthFailureCount >= 2
        if (offline) {
          scope.client.revokeValidation()
          stopSelectedStream()
          set(emptyAgentRouteState())
        }
        set(state => ({
          connected: offline ? false : state.connected,
          liveConnected: offline ? false : state.liveConnected,
          health: offline ? null : state.health,
          error: validationFailure ? message : state.error,
          syncStatus: state.selectedSessionId
            ? (!offline && state.liveConnected ? 'live' : !offline ? 'reconnecting' : 'offline')
            : state.syncStatus,
          syncError: state.selectedSessionId && !(!offline && state.liveConnected) ? message : state.syncError,
          profiles: updateProfileRuntime(state.profiles, scope.profileId, {
            connectionState: offline ? 'offline' : 'degraded',
            lastConnectionError: message,
            lastConnectionCheckedAt: Date.now(),
          }),
        }))
        return
      }

      const acceptedValidationRevision = scope.client.validationRevision
      if (!validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
      healthFailureCount = 0
      let sessions: Session[]
      const sessionRead = sessionMutations.captureRead()
      try {
        sessions = await scope.client.sessions()
      } catch (error) {
        if (NativeAppState.currentState !== 'active') return
        if (isStaleConnectionError(error, scope)) return
        const message = errorMessage(error)
        if (isDefinitiveValidationFailure(error, message)) {
          forceValidationOffline(scope, message, set)
          return
        }
        if (!validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
        health = activityHealth.accept(activityScope(scope), health, activityRequest)
        set(state => ({
          connected: true,
          health,
          error: message,
          profiles: updateProfileRuntime(state.profiles, scope.profileId, {
            connectionState: 'degraded',
            lastConnectionError: message,
            lastConnectionCheckedAt: Date.now(),
            serverVersion: healthVersion(health),
          }),
          activeSessionIds: healthActiveSessions(health),
        }))
        return
      }
      if (NativeAppState.currentState !== 'active' || !validatedRevisionIsCurrent(scope, acceptedValidationRevision)) return
      health = activityHealth.accept(activityScope(scope), health, activityRequest)
      let mergedSessions = sessions
      let sessionsChanged = false
      set(state => {
        const merged = mergeSessionState(sessions, state.sessions, sessionRead)
        mergedSessions = merged
        sessionsChanged = merged !== state.sessions
        return {
          connected: true,
          sessions: merged,
          health,
          profiles: updateProfileRuntime(state.profiles, scope.profileId, { connectionState: 'online', cachedUnreadCount: unreadCount(merged), lastConnectionError: null, lastConnectionCheckedAt: Date.now(), serverVersion: healthVersion(health) }),
          activeSessionIds: healthActiveSessions(health),
        }
      })
      if (sessionsChanged) {
        void saveCachedSessions(scope.namespace, mergedSessions)
        void updateBadge(get())
      }
      const selectedId = get().selectedSessionId
      if (selectedId && NativeAppState.currentState === 'active') {
        const remote = sessions.find(value => value.id === selectedId)
        const localSeq = Math.max(
          get().snapshots[selectedId]?.latestSeq ?? 0,
          streamSessionId === selectedId ? streamLatestSeq : 0,
        )
        const remoteSeq = remote?.latest_event_seq ?? 0
        const streamExists = hasSelectedStream(selectedId)
        if (remoteSeq > localSeq) void get().syncSelectedSession('server-ahead')
        else if (!streamExists && (!get().liveConnected || ['reconnecting', 'error', 'offline', 'cached'].includes(get().syncStatus))) void get().syncSelectedSession('recovery')
      }
    })()
    refreshSessionsInFlight = { scope, promise: operation }
    try {
      await operation
    } finally {
      if (refreshSessionsInFlight?.promise === operation) refreshSessionsInFlight = null
    }
  },

  async selectSession(sessionId, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    const scope = captureConnection()
    if (scope.namespaceAdopting) return
    const epoch = ++selectionEpoch
    cancelSyncRecovery(set)
    historyPagingEpoch += 1
    stopSelectedStream()
    const existing = get().snapshots[sessionId]
    set({
      selectedSessionId: sessionId,
      historyWindow: null,
      error: null,
      liveConnected: false,
      syncSessionId: sessionId,
      syncStatus: existing ? 'cached' : 'syncing',
      syncError: null,
      loadingSessionId: existing ? null : sessionId,
    })
    void saveCurrentWorkspace(get)
    let snapshot: Snapshot | undefined = existing
    if (!snapshot) {
      snapshot = await loadSnapshot(scope.namespace, sessionId) ?? undefined
      if (snapshot && connectionIsCurrent(scope) && epoch === selectionEpoch) set(state => ({
        snapshots: snapshotMapWith(state.snapshots, sessionId, snapshot!),
        syncStatus: 'cached',
        loadingSessionId: null,
      }))
    }
    if (!snapshot && connectionIsCurrent(scope) && epoch === selectionEpoch) set({ loadingSessionId: sessionId })
    if (!connectionIsCurrent(scope) || epoch !== selectionEpoch) return
    await get().syncSelectedSession('selection')
  },

  async syncSelectedSession(reason = 'manual') {
    const sessionId = get().selectedSessionId
    if (!sessionId || NativeAppState.currentState !== 'active') return
    if (reason === 'manual') cancelSyncRecovery(set)
    const scope = captureConnection()
    const epoch = selectionEpoch
    if (!get().connected) {
      cancelSyncRecovery(set)
      set({ syncSessionId: sessionId, syncStatus: 'offline', syncError: 'Server is offline.', syncRetryAttempt: 0, syncRetryAt: null })
      return
    }
    if (syncInFlight?.sessionId === sessionId && syncInFlight.epoch === epoch) return syncInFlight.promise

    const promise = (async () => {
      if (NativeAppState.currentState !== 'active') return
      const currentScope = captureAgentRouteGuard(scope, get)
      const queueState = queueReconciliationState(scope, sessionId, get)
      const queueRevision = queueState.revision
      const sessionRead = sessionMutations.captureRead()
      const existingAtStart = get().snapshots[sessionId]
      const verifiedServerVersion = get().health ? healthVersion(get().health!) : null
      const revalidateServerVersion = historyNeedsServerRevalidation(existingAtStart, verifiedServerVersion)
      const eventIdsAtStart = new Set(existingAtStart?.events.map(event => event.id) ?? [])
      // Trusted cached snapshots can reconcile through the server's fast
      // append-only delta path. Full tails are reserved for cold/manual loads.
      const fullTail = reason === 'manual' || !existingAtStart || revalidateServerVersion
      const supportsSemanticPaging = (get().health?.api_contract_version ?? 0) >= SEMANTIC_PAGING_API_CONTRACT
      const streamIsLive = get().liveConnected && hasSelectedStream(sessionId)
      const exposeProgress = !streamIsLive && (fullTail || get().syncStatus !== 'live')
      if (exposeProgress) set({ syncSessionId: sessionId, syncStatus: 'syncing', syncError: null })
      try {
        let fullTailSemanticPaging: boolean | null = existingAtStart?.semanticPaging ?? null
        const fetchFullTail = async (): Promise<TimelinePage> => {
          if (supportsSemanticPaging) {
            const semanticPage = await scope.client.sessionPage(sessionId, {
              limit: SEMANTIC_TAIL_LIMIT,
              tail: true,
              visible: true,
              pageMode: 'semantic',
            })
            if (NativeAppState.currentState !== 'active') return semanticPage
            if (semanticPage.semantic_paging === true) {
              fullTailSemanticPaging = true
              return semanticPage
            }
            // A health contract alone is not proof that semantic paging was
            // honored. Retry through the legacy endpoint shape so a proxy or
            // partially upgraded server cannot leave the tail mid-turn.
            fullTailSemanticPaging = false
          } else {
            fullTailSemanticPaging = false
          }
          return scope.client.sessionPage(sessionId, {
            limit: TAIL_LIMIT,
            tail: true,
            visible: true,
          })
        }

        const after = snapshotLatestSeq(existingAtStart)
        let page = fullTail
          ? await fetchFullTail()
          : await scope.client.sessionPage(sessionId, { after, limit: TAIL_LIMIT, tail: false, visible: true })
        if (NativeAppState.currentState !== 'active') return
        let fetchedFullTail = fullTail
        if (!fullTail && ((page.events_omitted_after ?? 0) > 0 || (page.latest_seq ?? after) < after)) {
          page = await fetchFullTail()
          fetchedFullTail = true
        }
        if (NativeAppState.currentState !== 'active' || !currentScope() || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
        if (verifiedServerVersion !== (get().health ? healthVersion(get().health!) : null)) return

        const current = get().snapshots[sessionId]
        const queueChanged = queueState.revision !== queueRevision
          || current?.queuedTurns !== existingAtStart?.queuedTurns
        const queuedTurns = queueChanged ? current?.queuedTurns ?? [] : page.queued_turns
        if (!queueChanged) queueState.commitSnapshot(page.latest_seq)
        const incomingEvents = mergeAndSanitizeIncomingEvents(current?.events ?? [], page.events
          .filter(event => event.session_id === sessionId && Number.isFinite(event.seq)))
        const replaceEvents = (fetchedFullTail && (fullTailSemanticPaging === true || revalidateServerVersion))
          || shouldReplaceCachedTimeline(current, incomingEvents, page.latest_seq, page.has_more, fetchedFullTail)
        const now = Date.now()
        // If the live stream appended while a full-tail request was pending,
        // keep only those genuinely concurrent additions when replacing the
        // cached window. Old disconnected cache entries must not leak back in.
        const incomingIds = new Set(incomingEvents.map(event => event.id))
        const concurrentEvents = replaceEvents
          ? (current?.events ?? []).filter(event => !eventIdsAtStart.has(event.id) && !incomingIds.has(event.id))
          : []
        const reconciledEvents = replaceEvents
          ? mergeEvents(incomingEvents, concurrentEvents)
          : mergeEvents(current?.events ?? [], incomingEvents)
        const mergedEvents = boundLiveTimelineEvents(reconciledEvents)
        const eventsWereTrimmed = liveTimelineEventsWereTrimmed(reconciledEvents, mergedEvents)
        const latestSeq = replaceEvents
          ? Math.max(mergedEvents.at(-1)?.seq ?? 0, page.latest_seq ?? 0)
          : Math.max(mergedEvents.at(-1)?.seq ?? 0, page.latest_seq ?? 0, current?.latestSeq ?? 0)
        const currentSession = get().sessions.find(value => value.id === sessionId)
          ?? current?.session
          ?? page.session
        const reconciledSession = sessionMutations.reconcileIncoming(currentSession, page.session, sessionRead)
        const next: Snapshot = {
          cacheVersion: SNAPSHOT_CACHE_VERSION,
          verifiedServerVersion: fetchedFullTail ? verifiedServerVersion : current?.verifiedServerVersion,
          session: reconciledSession,
          events: mergedEvents,
          queuedTurns,
          files: mergeFiles(current?.files ?? [], filesFromEvents(incomingEvents)),
          filesTotal: current?.filesTotal ?? 0,
          hasMore: (fetchedFullTail ? page.has_more : current?.hasMore ?? page.has_more) || eventsWereTrimmed,
          total: fetchedFullTail ? page.total : current?.total ?? null,
          latestSeq,
          nextBefore: fetchedFullTail
            ? (page.has_more
                ? timelinePageNextBefore(page)
                : eventsWereTrimmed ? mergedEvents[0]?.seq ?? null : null)
            : current?.nextBefore ?? null,
          semanticPaging: fetchedFullTail
            ? fullTailSemanticPaging
            : current?.semanticPaging ?? null,
          cachedAt: now,
        }
        set(state => ({
          snapshots: snapshotMapWith(state.snapshots, sessionId, next),
          queuedRunStatus: reconcileQueuedRunStatus(state.queuedRunStatus, sessionId, queuedTurns),
          sessions: state.sessions.map(value => value.id === sessionId ? reconciledSession : value),
          loadingSessionId: null,
          syncSessionId: sessionId,
          syncStatus: hasSelectedStream(sessionId) ? (state.liveConnected ? 'live' : 'reconnecting') : 'syncing',
          syncError: null,
          lastTimelineSyncAt: now,
        }))
        cancelSyncRecovery(set)
        scheduleLiveSnapshotSave(scope, next, true)
        if (queueChanged) void refreshQueueAfterSparseSnapshot(scope, sessionId, set, get)
        if (reason === 'selection' || reason === 'manual' || reason === 'foreground') {
          void get().refreshFiles(sessionId)
        }

        if (!hasSelectedStream(sessionId)) startSelectedStream(sessionId, next.latestSeq ?? snapshotLatestSeq(next), epoch, set, get)
        else if (get().liveConnected) set({ syncStatus: 'live' })
        void get().markRead(sessionId)
      } catch (error) {
        if (NativeAppState.currentState !== 'active') return
        if (!currentScope() || isStaleConnectionError(error, scope) || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
        const message = errorMessage(error)
        const transient = syncFailureIsTransient(error)
        if (!transient) cancelSyncRecovery(set)
        if (hasSelectedStream(sessionId)) {
          set({
            loadingSessionId: null,
            syncSessionId: sessionId,
            syncStatus: transient ? (get().liveConnected ? 'live' : 'reconnecting') : 'error',
            syncError: transient && get().liveConnected ? null : message,
            ...(reason === 'manual' ? { error: message } : {}),
          })
          if (transient) scheduleSyncRecovery(scope, sessionId, epoch, get, set)
          return
        }
        set({
          loadingSessionId: null,
          liveConnected: false,
          syncSessionId: sessionId,
          syncStatus: get().connected ? (transient ? 'reconnecting' : 'error') : 'offline',
          syncError: message,
          syncRetryAttempt: 0,
          syncRetryAt: null,
          ...(reason === 'manual' ? { error: message } : {}),
        })
        if (transient) scheduleSyncRecovery(scope, sessionId, epoch, get, set)
      }
    })()
    const inFlight = { sessionId, epoch, promise }
    syncInFlight = inFlight
    try { await promise }
    finally { if (syncInFlight === inFlight) syncInFlight = null }
  },

  loadOlder(sessionId = get().selectedSessionId ?? undefined) {
    if (!sessionId) return Promise.resolve(0)
    const scope = captureConnection()
    const requestKey = `${scope.generation}:${sessionId}`
    const existingRequest = olderPageInFlight.get(requestKey)
    if (existingRequest) return existingRequest

    const liveSnapshot = get().snapshots[sessionId]
    if (!liveSnapshot?.hasMore || !liveSnapshot.events.length || get().selectedSessionId !== sessionId) return Promise.resolve(0)
    const epoch = selectionEpoch
    const pagingEpoch = historyPagingEpoch
    const existingWindow = get().historyWindow
    const matchingWindow = existingWindow
      && existingWindow.profileGeneration === scope.generation
      && existingWindow.sessionId === sessionId
      ? existingWindow
      : null
    if (matchingWindow && !matchingWindow.snapshot.hasMore) return Promise.resolve(0)
    const initialBefore = matchingWindow?.beforeCursor
      ?? liveSnapshot.nextBefore
      ?? liveSnapshot.events[0]!.seq
    let semanticPaging = (matchingWindow?.snapshot.semanticPaging ?? liveSnapshot.semanticPaging) === true
    const initialSnapshot: Snapshot = matchingWindow?.snapshot ?? {
      ...liveSnapshot,
      // Preserve the currently rendered tail so entering history mode does not
      // invalidate the user's visible-row anchor. Newly fetched pages are
      // conversation-first and compacted below.
      events: boundHistoricalTimelineEvents(liveSnapshot.events.map(sanitizeTimelineEvent)),
      cachedAt: Date.now(),
    }

    // Keep rendering the authoritative live snapshot while the first older
    // page is in flight. Publishing a speculative history window here can
    // strand the UI behind an empty compact page if the server updates or the
    // request fails before any displayable history arrives.
    set(state => ({
      loadingOlder: { ...state.loadingOlder, [sessionId]: true },
    }))

    const operation = (async () => {
      const sessionRead = sessionMutations.captureRead()
      let cursor = initialBefore
      let hasMore = initialSnapshot.hasMore
      let latestSession = initialSnapshot.session
      let latestQueuedTurns = initialSnapshot.queuedTurns
      let latestTotal = initialSnapshot.total ?? null
      let latestSeq = initialSnapshot.latestSeq ?? snapshotLatestSeq(initialSnapshot)
      const fetchedEvents: Event[] = []
      const loadedIds = new Set(initialSnapshot.events.map(event => event.id))

      try {
        for (
          let request = 0;
          request < OLDER_MAX_REQUESTS
            && hasMore
            && historicalTimelineEvents(fetchedEvents, initialSnapshot.events).length < OLDER_TARGET_EVENTS;
          request += 1
        ) {
          // Contract v9 semantic pages retain logical turn boundaries needed
          // to link public commentary across page edges. Older servers fall
          // back to compact conversation pages.
          let page = await scope.client.sessionPage(sessionId, {
            before: cursor,
            limit: semanticPaging ? SEMANTIC_OLDER_LIMIT : LEGACY_OLDER_LIMIT,
            tail: true,
            visible: true,
            compact: semanticPaging ? undefined : true,
            pageMode: semanticPaging ? 'semantic' : undefined,
          })
          if (
            !connectionIsCurrent(scope)
            || epoch !== selectionEpoch
            || pagingEpoch !== historyPagingEpoch
            || get().selectedSessionId !== sessionId
          ) return 0
          if (semanticPaging && page.semantic_paging !== true) {
            // Do not trust a server/proxy that advertises v9 but ignores the
            // semantic request. Retry this exact cursor through the legacy
            // compact path and remember the downgrade for later pages.
            semanticPaging = false
            page = await scope.client.sessionPage(sessionId, {
              before: cursor,
              limit: LEGACY_OLDER_LIMIT,
              tail: true,
              visible: true,
              compact: true,
            })
            if (
              !connectionIsCurrent(scope)
              || epoch !== selectionEpoch
              || pagingEpoch !== historyPagingEpoch
              || get().selectedSessionId !== sessionId
            ) return 0
          }
          latestSession = page.session
          if (page.queued_turns.length) latestQueuedTurns = page.queued_turns
          latestTotal = Math.max(latestTotal ?? 0, page.total ?? 0) || null
          latestSeq = Math.max(latestSeq, page.latest_seq ?? 0)
          hasMore = page.has_more

          for (const rawEvent of page.events) {
            if (
              rawEvent.session_id !== sessionId
              || !Number.isFinite(rawEvent.seq)
              // A semantic cursor is the logical item's start anchor. Other
              // representative events from that same older item may have raw
              // sequence numbers at or beyond the anchor, so only legacy raw
              // pages may be constrained by the numeric cursor.
              || (!semanticPaging && rawEvent.seq >= cursor)
            ) continue
            const resident = fetchedEvents.findLast(event => event.id === rawEvent.id)
              ?? get().snapshots[sessionId]?.events.find(event => event.id === rawEvent.id)
              ?? initialSnapshot.events.find(event => event.id === rawEvent.id)
            const event = mergeAndSanitizeIncomingEvents(resident ? [resident] : [], [rawEvent])[0]!
            if (loadedIds.has(event.id) && event === resident) continue
            loadedIds.add(event.id)
            fetchedEvents.push(event)
          }

          if (!hasMore) break
          const nextBefore = timelinePageNextBefore(page)
          if (nextBefore == null || nextBefore >= cursor) {
            hasMore = false
            break
          }
          cursor = nextBefore
        }

        const currentWindow = get().historyWindow
        if (pagingEpoch !== historyPagingEpoch) return 0
        if (matchingWindow && (
          !currentWindow
          || currentWindow.profileGeneration !== scope.generation
          || currentWindow.sessionId !== sessionId
          || currentWindow.beforeCursor !== initialBefore
        )) return 0
        if (!matchingWindow && currentWindow) return 0

        const baseSnapshot = currentWindow?.snapshot ?? initialSnapshot
        const detachedHistory = Boolean(currentWindow?.detached ?? matchingWindow?.detached)
        const currentLiveSnapshot = get().snapshots[sessionId]
        const collected = historicalTimelineEvents(fetchedEvents, baseSnapshot.events)
          .sort((left, right) => left.seq - right.seq)
        const baseEvents = detachedHistory
          ? baseSnapshot.events
          : mergeEvents(baseSnapshot.events, currentLiveSnapshot?.events ?? [])
        const merged = boundHistoricalTimelineEvents(mergeEvents(baseEvents, collected))
        const retainedIds = new Set(merged.map(event => event.id))
        const retainedCollected = collected.filter(event => retainedIds.has(event.id))
        // The history window deliberately retains its newest edge. Once its
        // memory budget rejects any newly fetched older event, stop paging so
        // advancing the cursor cannot create an invisible gap.
        const retainedWholePage = retainedCollected.length === collected.length
        hasMore = hasMore && retainedWholePage
        const currentSession = get().sessions.find(value => value.id === sessionId)
          ?? get().snapshots[sessionId]?.session
          ?? latestSession
        const reconciledSession = sessionMutations.reconcileIncoming(currentSession, latestSession, sessionRead)
        const nextSnapshot: Snapshot = {
          ...baseSnapshot,
          session: reconciledSession,
          events: merged,
          queuedTurns: latestQueuedTurns,
          files: mergeFiles(
            mergeFiles(baseSnapshot.files, detachedHistory ? [] : currentLiveSnapshot?.files ?? []),
            filesFromEvents(retainedCollected),
          ),
          hasMore,
          total: latestTotal,
          latestSeq: Math.max(
            latestSeq,
            detachedHistory ? 0 : currentLiveSnapshot?.latestSeq ?? 0,
            merged.at(-1)?.seq ?? 0,
          ),
          nextBefore: hasMore ? cursor : null,
          semanticPaging,
          cachedAt: Date.now(),
        }
        if (!currentWindow && !projectPresentableHistory(collected, filesFromEvents(collected))) {
          return 0
        }
        set({
          historyWindow: {
            ...(currentWindow ?? matchingWindow ?? {}),
            profileGeneration: scope.generation,
            sessionId,
            beforeCursor: cursor,
            snapshot: nextSnapshot,
          },
        })
        return retainedCollected.length
      } catch (error) {
        if (
          pagingEpoch === historyPagingEpoch
          && epoch === selectionEpoch
          && get().selectedSessionId === sessionId
          && !isStaleConnectionError(error, scope)
        ) set({ error: errorMessage(error) })
        return 0
      } finally {
        olderPageInFlight.delete(requestKey)
        if (connectionIsCurrent(scope)) {
          set(state => {
            const loadingOlder = { ...state.loadingOlder }
            delete loadingOlder[sessionId]
            return { loadingOlder }
          })
        }
      }
    })()
    olderPageInFlight.set(requestKey, operation)
    return operation
  },

  async seekTimelineResult(result, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return false
    if (!Number.isFinite(result.seq) || !result.session_id || !result.event_id) return false
    // This starts before cross-chat selection, while historyPagingEpoch must be
    // allowed to change as selectSession establishes the target chat.
    const seekIntent = ++timelineSeekIntentEpoch

    try {
      if (get().selectedSessionId !== result.session_id) {
        await get().selectSession(result.session_id, expectedGeneration)
        if (seekIntent !== timelineSeekIntentEpoch || get().selectedSessionId !== result.session_id) return false
      }
    } catch (error) {
      if (
        seekIntent === timelineSeekIntentEpoch
        && (expectedGeneration === undefined || expectedGeneration === get().profileGeneration)
      ) {
        set({ error: errorMessage(error) })
      }
      return false
    }

    if (seekIntent !== timelineSeekIntentEpoch) return false
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    const epoch = selectionEpoch
    const seekRevision = ++historyPagingEpoch
    const semantic = (get().health?.api_contract_version ?? 0) >= SEMANTIC_PAGING_API_CONTRACT
    const sessionRead = sessionMutations.captureRead()

    try {
      const [older, newer] = await Promise.all([
        timelineSeekPage(scope, result.session_id, {
          before: result.seq,
          limit: HISTORY_SEEK_SIDE_LIMIT,
          tail: true,
        }, semantic),
        timelineSeekPage(scope, result.session_id, {
          after: Math.max(0, result.seq - 1),
          limit: HISTORY_SEEK_SIDE_LIMIT,
          tail: false,
        }, semantic),
      ])
      if (
        !connectionIsCurrent(scope)
        || seekIntent !== timelineSeekIntentEpoch
        || epoch !== selectionEpoch
        || seekRevision !== historyPagingEpoch
        || get().selectedSessionId !== result.session_id
      ) return false

      const events = boundHistoricalTimelineEvents(
        mergeAndSanitizeIncomingEvents(get().snapshots[result.session_id]?.events ?? [],
          mergeEvents(older.events, newer.events)
            .filter(event => event.session_id === result.session_id && Number.isFinite(event.seq))),
      )
      const files = mergeFiles([], filesFromEvents(events))
      const projected = projectPresentableHistory(events, files)
      if (!projected || !timelineTargetIsRepresented(projected, { eventId: result.event_id, seq: result.seq })) {
        set({ error: 'The matching message is no longer available in this chat.' })
        return false
      }

      const nextBefore = timelinePageNextBefore(older)
        ?? older.events[0]?.seq
        ?? events[0]?.seq
        ?? result.seq
      const incomingSession = newer.session ?? older.session
      const currentSession = get().sessions.find(value => value.id === result.session_id)
        ?? get().snapshots[result.session_id]?.session
        ?? incomingSession
      const reconciledSession = sessionMutations.reconcileIncoming(currentSession, incomingSession, sessionRead)
      const snapshot: Snapshot = {
        cacheVersion: SNAPSHOT_CACHE_VERSION,
        session: reconciledSession,
        events,
        queuedTurns: newer.queued_turns.length ? newer.queued_turns : older.queued_turns,
        files,
        filesTotal: files.length,
        hasMore: older.has_more,
        total: Math.max(older.total ?? 0, newer.total ?? 0) || null,
        latestSeq: Math.max(
          older.latest_seq ?? 0,
          newer.latest_seq ?? 0,
          events.at(-1)?.seq ?? 0,
        ),
        nextBefore: older.has_more ? nextBefore : null,
        semanticPaging: older.semantic_paging === true && newer.semantic_paging === true,
        cachedAt: Date.now(),
      }
      set({
        historyWindow: {
          profileGeneration: scope.generation,
          sessionId: result.session_id,
          beforeCursor: nextBefore,
          snapshot,
          detached: true,
          anchorEventId: result.event_id,
          anchorSeq: result.seq,
          anchorRevision: seekRevision,
        },
      })
      return true
    } catch (error) {
      if (
        connectionIsCurrent(scope)
        && seekIntent === timelineSeekIntentEpoch
        && epoch === selectionEpoch
        && seekRevision === historyPagingEpoch
        && get().selectedSessionId === result.session_id
      ) set({ error: errorMessage(error) })
      return false
    }
  },

  cancelTimelineSeek() {
    // Invalidate an in-flight result without discarding the history window
    // already on screen. Search dismissal must not publish a late response.
    timelineSeekIntentEpoch += 1
    historyPagingEpoch += 1
  },

  exitHistory() {
    timelineSeekIntentEpoch += 1
    historyPagingEpoch += 1
    set({ historyWindow: null })
  },

  refreshFiles(sessionId = get().selectedSessionId ?? undefined, append = false, expectedGeneration) {
    if (!sessionId || NativeAppState.currentState !== 'active') return Promise.resolve()
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return Promise.resolve()
    const namespace = scope.namespace
    const requestKey = `${scope.generation}:${namespace}:${sessionId}`
    const existingRequest = filePageInFlight.get(requestKey)
    if (existingRequest) return existingRequest

    const snapshot = get().snapshots[sessionId]
    if (!snapshot) return Promise.resolve()
    const paging = get().filePaging[sessionId]
    if (append && paging?.hasMore === false) return Promise.resolve()
    const offset = append ? paging?.nextOffset ?? snapshot.files.length : 0

    set(state => ({
      filePaging: {
        ...state.filePaging,
        [sessionId]: {
          loading: true,
          hasMore: state.filePaging[sessionId]?.hasMore ?? true,
          nextOffset: offset,
          error: null,
          retryAppend: append,
        },
      },
    }))

    const operation = Promise.resolve().then(async () => {
      try {
        const page = await scope.client.files(sessionId, offset, 60)
        if (
          NativeAppState.currentState !== 'active'
          || !connectionIsCurrent(scope)
          || scope.namespace !== namespace
        ) return
        if (page.offset !== offset) throw new Error('The server returned an unexpected file page. Retry loading the files.')
        if (page.has_more && page.files.length === 0) throw new Error('The server returned an empty file page before the end. Retry loading the files.')
        const safeFiles = page.files.map(file => sanitizeTimelineFile(file) ?? file)
        const nextOffset = offset + page.files.length
        set(state => {
          const current = state.snapshots[sessionId]
          if (!current) return {
            filePaging: {
              ...state.filePaging,
              [sessionId]: {
                loading: false,
                hasMore: false,
                nextOffset,
                error: 'This chat is no longer available.',
                retryAppend: false,
              },
            },
          }
          const files = mergeFiles(append ? current.files : mergeFiles(filesFromEvents(current.events), current.files), safeFiles)
          const next = {
            ...current,
            // Keep files selected locally while a concurrent metadata refresh is
            // resolving; otherwise its older response can erase a just-uploaded
            // preview before the turn is sent.
            files,
            filesTotal: Math.max(page.total, files.length),
          }
          return {
            snapshots: snapshotMapWith(state.snapshots, sessionId, next),
            filePaging: {
              ...state.filePaging,
              [sessionId]: {
                loading: false,
                hasMore: page.has_more,
                nextOffset,
                error: null,
                retryAppend: page.has_more,
              },
            },
          }
        })
      } catch (error) {
        if (!connectionIsCurrent(scope) || scope.namespace !== namespace) return
        set(state => {
          const current = state.filePaging[sessionId]
          return {
            filePaging: {
              ...state.filePaging,
              [sessionId]: {
                loading: false,
                hasMore: current?.hasMore ?? true,
                nextOffset: offset,
                error: errorMessage(error),
                retryAppend: append,
              },
            },
          }
        })
      }
    }).finally(() => {
      if (filePageInFlight.get(requestKey) === operation) filePageInFlight.delete(requestKey)
      if (!connectionIsCurrent(scope) || scope.namespace !== namespace) return
      set(state => {
        const current = state.filePaging[sessionId]
        if (!current?.loading) return state
        return { filePaging: { ...state.filePaging, [sessionId]: { ...current, loading: false } } }
      })
    })
    filePageInFlight.set(requestKey, operation)
    return operation
  },

  async refreshTimelineIndex(sessionId = get().selectedSessionId ?? undefined) {
    if (!sessionId) return
    const scope = captureConnection()
    try {
      const index = await scope.client.timelineIndex(sessionId)
      if (!connectionIsCurrent(scope)) return
      set(state => ({ timelineIndex: { ...state.timelineIndex, [sessionId]: index } }))
    } catch { /* navigator is optional */ }
  },

  async loadRunTrace(sessionId, runId, anchorSeq, afterSeq = 0, limit = 160, expectedGeneration) {
    const scope = captureValidatedConnection(get, expectedGeneration)
    const epoch = selectionEpoch
    if (get().selectedSessionId !== sessionId) {
      throw new Error('This trace belongs to a chat that is no longer selected.')
    }
    try {
      const page = await scope.client.runTrace(sessionId, runId, anchorSeq, afterSeq, limit)
      if (
        !connectionIsCurrent(scope)
        || epoch !== selectionEpoch
        || get().selectedSessionId !== sessionId
      ) {
        throw new AgentServerClientUnvalidatedError()
      }
      return {
        ...page,
        events: mergeAndSanitizeIncomingEvents(get().snapshots[sessionId]?.events ?? [], page.events),
      }
    } catch (error) {
      if (
        !connectionIsCurrent(scope)
        || epoch !== selectionEpoch
        || get().selectedSessionId !== sessionId
      ) {
        throw error
      }
      if (error instanceof ServerError && error.status === 404) {
        return {
          events: [],
          has_more: false,
          next_after: null,
        }
      }
      throw error
    }
  },

  async loadJobRuns(sessionId, jobId, beforeSeq = null, limit = 20, expectedGeneration) {
    const scope = captureValidatedConnection(get, expectedGeneration)
    try {
      const page = await scope.client.jobRuns(sessionId, jobId, beforeSeq, limit)
      if (!connectionIsCurrent(scope)) throw new AgentServerClientUnvalidatedError()
      return {
        ...page,
        runs: mergeAndSanitizeIncomingEvents(get().snapshots[sessionId]?.events ?? [], page.runs),
      }
    } catch (error) {
      if (!connectionIsCurrent(scope)) throw error
      if (error instanceof ServerError && error.status === 404) {
        return {
          runs: [],
          total: 0,
          has_more: false,
          next_before: null,
          supported: false,
        }
      }
      throw error
    }
  },

  setDraft(text) {
    if (captureConnection().namespaceAdopting) return
    const id = get().selectedSessionId
    if (id) {
      set(state => ({ drafts: { ...state.drafts, [id]: text } }))
      scheduleCurrentWorkspaceSave(get)
    }
  },
  setSessionDraft(sessionId, text, expectedGeneration) {
    if (captureConnection().namespaceAdopting) return
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set(state => ({ drafts: { ...state.drafts, [sessionId]: text } }))
    scheduleCurrentWorkspaceSave(get)
  },
  setChatReferencesForSession(sessionId, references, expectedGeneration) {
    if (captureConnection().namespaceAdopting) return
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set(state => ({
      chatReferencesBySession: {
        ...state.chatReferencesBySession,
        [sessionId]: references.map(reference => ({ ...reference })),
      },
    }))
    scheduleCurrentWorkspaceSave(get)
  },

  setTeamReferencesForSession(sessionId, references, expectedGeneration) {
    if (captureConnection().namespaceAdopting) return
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set(state => ({ teamReferencesBySession: { ...state.teamReferencesBySession, [sessionId]: references.map(reference => ({ ...reference })) } }))
    scheduleCurrentWorkspaceSave(get)
  },

  async stageTeamMailDraft(input) {
    try {
      const scope = captureValidatedConnection(get, input.expectedProfileGeneration)
      const initial = get()
      const identity = initial.profiles.find(profile => profile.id === initial.activeProfileId)?.serverIdentity ?? null
      if (scope.namespaceAdopting || initial.workspaceAdopting || initial.activeProfileId !== input.expectedProfileId
        || identity !== input.expectedServerIdentity || (initial.health?.server_instance_id ?? null) !== input.expectedServerInstanceId
        || scope.client.validationRevision !== input.expectedValidationRevision || initial.selectedSessionId !== input.expectedSelectedSessionId
        || !initial.sessions.some(session => session.id === input.sessionId && !session.archived)) return false
      const current = captureAgentRouteGuard(scope, get)
      const draft = initial.drafts[input.sessionId] ?? ''
      const references = initial.teamReferencesBySession[input.sessionId] ?? []
      const chats = initial.chatReferencesBySession[input.sessionId] ?? []
      const draftFingerprint = JSON.stringify([draft, references, chats])
      const next = appendTeamMailDraft(draft, references, input)
      if (next.references.some(reference => !teamReferenceContractSupported(initial.health, reference))) return false
      const beforeSelection = selectionEpoch
      await get().selectSession(input.sessionId, input.expectedProfileGeneration)
      const selected = get()
      if (!current() || scope.namespaceAdopting || selectionEpoch !== beforeSelection + 1 || selected.selectedSessionId !== input.sessionId
        || (selected.profiles.find(profile => profile.id === selected.activeProfileId)?.serverIdentity ?? null) !== input.expectedServerIdentity
        || next.references.some(reference => !teamReferenceContractSupported(selected.health, reference))
        || !selected.sessions.some(session => session.id === input.sessionId && !session.archived)
        || JSON.stringify([selected.drafts[input.sessionId] ?? '', selected.teamReferencesBySession[input.sessionId] ?? [], selected.chatReferencesBySession[input.sessionId] ?? []]) !== draftFingerprint) return false
      set(state => ({ drafts: { ...state.drafts, [input.sessionId]: next.text },
        teamReferencesBySession: { ...state.teamReferencesBySession, [input.sessionId]: next.references } }))
      scheduleCurrentWorkspaceSave(get)
      return true
    } catch { return false }
  },

  async refreshAgentRoutes(sessionId, expectedGeneration) {
    if (get().workspaceAdopting) return null
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return null
    const available = () => agentCrossChatRoutesAvailable(get().health)
      && get().sessions.some(session => session.id === sessionId && !session.archived)
    if (!available()) {
      agentRouteRefreshTokens.delete(sessionId)
      set(state => {
        const agentRoutesBySession = { ...state.agentRoutesBySession }
        const agentRouteErrorsBySession = { ...state.agentRouteErrorsBySession }
        const agentRouteLoadingSessionIds = new Set(state.agentRouteLoadingSessionIds)
        delete agentRoutesBySession[sessionId]
        delete agentRouteErrorsBySession[sessionId]
        agentRouteLoadingSessionIds.delete(sessionId)
        return { agentRoutesBySession, agentRouteErrorsBySession, agentRouteLoadingSessionIds }
      })
      return null
    }
    let scope: ConnectionScope
    try { scope = captureValidatedConnection(get, expectedGeneration) } catch { return null }
    const guard = captureAgentRouteGuard(scope, get)
    const token = Symbol()
    agentRouteRefreshTokens.set(sessionId, token)
    const current = () => guard() && available() && agentRouteRefreshTokens.get(sessionId) === token
    set(state => ({
      agentRouteLoadingSessionIds: new Set(state.agentRouteLoadingSessionIds).add(sessionId),
      agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: null },
    }))
    try {
      const snapshot = await scope.client.agentHandoffRoutes(sessionId)
      if (!current()) return null
      set(state => ({ agentRoutesBySession: { ...state.agentRoutesBySession, [sessionId]: snapshot } }))
      return snapshot
    } catch (error) {
      if (current()) set(state => ({ agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: errorMessage(error) } }))
      return null
    } finally {
      if (agentRouteRefreshTokens.get(sessionId) === token) {
        agentRouteRefreshTokens.delete(sessionId)
        if (connectionIsCurrent(scope)) set(state => {
          const agentRouteLoadingSessionIds = new Set(state.agentRouteLoadingSessionIds)
          agentRouteLoadingSessionIds.delete(sessionId)
          return { agentRouteLoadingSessionIds }
        })
      }
    }
  },

  async revokeAgentRoute(sessionId, routeId, expectedRevision, expectedGeneration) {
    if (get().workspaceAdopting) return false
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope || !agentCrossChatRoutesAvailable(get().health)) return false
    const key = `${sessionId}:${routeId}`
    if (get().revokingAgentRouteIds.has(key)) return false
    const route = get().agentRoutesBySession[sessionId]?.routes.find(value => value.route_id === routeId)
    if (!route || !expectedRevision.trim() || route.revision !== expectedRevision) {
      await get().refreshAgentRoutes(sessionId, expectedGeneration)
      return false
    }
    const guard = captureAgentRouteGuard(scope, get)
    const token = Symbol()
    agentRouteMutationTokens.set(key, token)
    const current = () => guard() && agentCrossChatRoutesAvailable(get().health) && agentRouteMutationTokens.get(key) === token
    set(state => ({
      revokingAgentRouteIds: new Set(state.revokingAgentRouteIds).add(key),
      agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: null },
    }))
    try {
      const result = await scope.client.deleteAgentHandoffRoute(sessionId, routeId, expectedRevision)
      if (!current()) return false
      if (result.ok !== true || result.route_id !== routeId) throw new Error('The server did not confirm this grant removal. Refresh and try again.')
      const snapshot = await get().refreshAgentRoutes(sessionId, expectedGeneration)
      if (current() && snapshot?.routes.some(value => value.route_id === routeId)) {
        throw new Error('The current server grant is still present. Review the refreshed grant before revoking again.')
      }
      return current() && snapshot !== null && !snapshot.routes.some(value => value.route_id === routeId)
    } catch (error) {
      if (!current()) return false
      if (error instanceof ServerError && isAgentRouteRevisionConflict(error)) {
        await get().refreshAgentRoutes(sessionId, expectedGeneration)
        if (current()) set(state => ({ agentRouteErrorsBySession: {
          ...state.agentRouteErrorsBySession,
          [sessionId]: 'This grant changed on the server. The current grant was refreshed; review it before revoking again.',
        } }))
      } else set(state => ({ agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: errorMessage(error) } }))
      return false
    } finally {
      if (agentRouteMutationTokens.get(key) === token) {
        agentRouteMutationTokens.delete(key)
        if (connectionIsCurrent(scope)) set(state => {
          const revokingAgentRouteIds = new Set(state.revokingAgentRouteIds)
          revokingAgentRouteIds.delete(key)
          return { revokingAgentRouteIds }
        })
      }
    }
  },

  beginTurnAdmission(sessionId) {
    const current = get()
    if (
      current.switchingProfileId
      || current.workspaceAdopting
      || current.turnAdmissionTokens[sessionId]
      || current.sendingSessionIds.has(sessionId)
    ) return null
    const token = `${current.activeProfileId ?? 'local'}:${current.profileGeneration}:${++turnAdmissionCounter}`
    let admitted = false
    set(state => {
      if (
        state.switchingProfileId
        || state.workspaceAdopting
        || state.turnAdmissionTokens[sessionId]
        || state.sendingSessionIds.has(sessionId)
      ) return state
      admitted = true
      return { turnAdmissionTokens: { ...state.turnAdmissionTokens, [sessionId]: token } }
    })
    return admitted ? token : null
  },

  endTurnAdmission(sessionId, token) {
    set(state => {
      if (state.turnAdmissionTokens[sessionId] !== token) return state
      const turnAdmissionTokens = { ...state.turnAdmissionTokens }
      delete turnAdmissionTokens[sessionId]
      return { turnAdmissionTokens }
    })
  },

  async sendPrompt(steer = false, expectedGeneration, expectedSessionId, options) {
    if (activeConnectionMutationDepth > 0) {
      set({ error: SERVER_MUTATION_IN_FLIGHT_SEND_MESSAGE })
      return false
    }
    const sessionId = expectedSessionId ?? get().selectedSessionId
    if (!sessionId) return false
    if (get().selectedSessionId !== sessionId) return false
    const consumeComposer = options?.consumeComposer !== false
    const hasAdmissionSnapshot = options?.admittedDraft !== undefined && options?.admittedFiles !== undefined
    if (consumeComposer && !hasAdmissionSnapshot && (get().uploadPending[sessionId]?.length ?? 0) > 0) return false
    if (consumeComposer && !hasAdmissionSnapshot && (get().uploadFailed[sessionId]?.length ?? 0) > 0) return false
    const originalDraft = options?.admittedDraft ?? get().drafts[sessionId] ?? ''
    const prompt = (options?.promptOverride ?? originalDraft).trim()
    const files = consumeComposer ? options?.admittedFiles ?? get().uploads[sessionId] ?? [] : []
    if (!prompt && !files.length) return false
    const session = get().sessions.find(value => value.id === sessionId)
    if (!session) return false
    const selectionError = runtimeSelectionError(get().health, get().runtime, session.backend, session.model)
    if (selectionError) {
      set({ error: selectionError })
      return false
    }
    const rawPrompt = options?.promptOverride ?? originalDraft
    const leadingWhitespace = rawPrompt.length - rawPrompt.trimStart().length
    const rawReferences = consumeComposer
      ? options?.chatReferences ?? get().chatReferencesBySession[sessionId] ?? []
      : []
    const requestedReferences = rawReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    const chatReferences = validChatReferences(prompt, requestedReferences, sessionId)
    const rawTeamReferences = consumeComposer ? options?.teamReferences ?? get().teamReferencesBySession[sessionId] ?? [] : []
    const requestedTeamReferences = rawTeamReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    const teamReferences = validTeamReferences(prompt, requestedTeamReferences, chatReferences)
    if (teamReferences.length !== requestedTeamReferences.length) {
      set({ error: 'A Team Network reference was edited or is no longer valid. Remove it and select the recipient again.' })
      return false
    }
    if (teamReferences.length && !teamMessagesAvailable(get().health)) {
      set({ error: 'Connect the active server to a Team Network that supports @@ messages, or remove the recipient reference.' })
      return false
    }
    if (chatReferences.length !== requestedReferences.length) {
      set({ error: 'A chat reference was edited or is no longer valid. Remove it and select the chat again.' })
      return false
    }
    const capacityError = agentRouteCapacityError(get().agentRoutesBySession[sessionId], chatReferences)
    if (capacityError) { set({ error: capacityError }); return false }
    if ([...get().revokingAgentRouteIds].some(key => key.startsWith(`${sessionId}:`))) {
      set({ error: 'Wait for the current route removal before sending.' })
      return false
    }
    if (chatReferences.length && !routeHintMentionsAvailable(get().health)) {
      set({ error: 'Inline @Chat routes require the complete v7 default-deny contract. Update AgentsServer and select the chat again.' })
      return false
    }
    if (chatReferences.length) {
      const state = get()
      const targetBackends = supportedCrossChatTargetBackends(state.health)
      const unsupported = chatReferences.some(reference => {
        const target = state.sessions.find(candidate => candidate.id === reference.session_id)
        return !localChatReferenceContractSupported(state.health, reference)
          || !target
          || target.archived
          || !targetBackends.includes(target.backend)
          || (reference.action === 'request_reply' && (!session || !targetBackends.includes(session.backend)))
      })
      if (unsupported) {
        set({ error: 'This cross-chat action is not supported by the active server or one of the selected chats. Change or remove it and try again.' })
        return false
      }
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    if (teamReferences.some(reference => reference.recipient_kind !== 'server')) {
      const guard = captureAgentRouteGuard(scope, get)
      try {
        await requireTeamReferenceSupport(scope.client, get().health!, teamReferences,
          () => guard() && teamReferences.every(reference => teamReferenceContractSupported(get().health, reference)))
        if (!guard()) return false
      } catch (error) {
        if (guard()) set({ error: errorMessage(error) })
        return false
      }
    }
    if ([...get().revokingAgentRouteIds].some(key => key.startsWith(`${sessionId}:`))) return false
    const inFlightKey = `${scope.generation}:${sessionId}`
    if (sendPromptInFlight.has(inFlightKey)) return false
    const admissionToken = options?.admissionToken ?? get().beginTurnAdmission(sessionId)
    if (!admissionToken || get().turnAdmissionTokens[sessionId] !== admissionToken) return false
    sendPromptInFlight.add(inFlightKey)
    // Sending returns the selected chat to its live edge. Invalidate even a
    // first older-page request that has not published a history window yet.
    historyPagingEpoch += 1
    let consumedDraft = false
    set(state => {
      const sendingSessionIds = new Set(state.sendingSessionIds)
      sendingSessionIds.add(sessionId)
      let drafts = state.drafts
      if (
        consumeComposer
        && state.drafts[sessionId] === originalDraft
        && chatReferencesEqual(state.chatReferencesBySession[sessionId] ?? [], rawReferences)
        && teamReferencesEqual(state.teamReferencesBySession[sessionId] ?? [], rawTeamReferences)
      ) {
        consumedDraft = true
        drafts = { ...state.drafts, [sessionId]: '' }
      }
      return {
        sendingSessionIds,
        drafts,
        chatReferencesBySession: consumedDraft
          ? { ...state.chatReferencesBySession, [sessionId]: [] }
          : state.chatReferencesBySession,
        teamReferencesBySession: consumedDraft
          ? { ...state.teamReferencesBySession, [sessionId]: [] }
          : state.teamReferencesBySession,
        historyWindow: state.historyWindow?.sessionId === sessionId ? null : state.historyWindow,
      }
    })
    if (consumedDraft) void saveCurrentWorkspace(get)
    const queuedBeforeSend = new Set((get().snapshots[sessionId]?.queuedTurns ?? []).map(turn => turn.queued_id))
    const sessionRead = sessionMutations.captureRead()
    const admittedServerIdentity = get().health?.server_identity
    const queueScopeCurrent = captureAgentRouteGuard(scope, get)
    try {
      const clientCapabilities = interactiveClientCapabilities(session, get().health)
      const response = await scope.client.sendTurn(
        sessionId,
        prompt,
        files.map(file => file.id),
        session?.model,
        session?.effort,
        clientCapabilities,
        chatReferences,
        teamReferences,
      )
      if (!queueScopeCurrent()) {
        // A successful POST is not safe to replay after a server restart or
        // revalidation. Discard its stale projection, but reconcile the same
        // selected server/chat through a fresh, current-scope read.
        const current = get()
        if (connectionIsCurrent(scope) && scope.client.isValidated
          && current.activeProfileId === scope.profileId && current.profileGeneration === scope.generation
          && current.connected && !current.connecting && !current.switchingProfileId && !current.workspaceAdopting
          && current.selectedSessionId === sessionId && admittedServerIdentity
          && current.health?.server_identity === admittedServerIdentity) {
          const admittedFiles = new Set(files)
          set(state => ({
            // Remove only the exact admitted selections. A newly picked file
            // (even with a reused ID) belongs to the next draft and survives.
            uploads: consumeComposer ? { ...state.uploads,
              [sessionId]: (state.uploads[sessionId] ?? []).filter(file => !admittedFiles.has(file)),
            } : state.uploads,
            error: 'The server accepted this message before the connection changed. Refresh the chat before sending it again.',
          }))
          void get().syncSelectedSession('recovery')
        }
        return false
      }
      const stateAfterSend = get()
      if (chatReferences.some(reference => reference.action === 'route' && reference.grant_intent === true)) {
        void get().refreshAgentRoutes(sessionId, expectedGeneration)
      }
      const currentSessionAfterSend = stateAfterSend.sessions.find(value => value.id === sessionId)
      const locallyObservedSeq = Math.max(
        stateAfterSend.snapshots[sessionId]?.latestSeq ?? 0,
        currentSessionAfterSend?.latest_event_seq ?? 0,
      )
      const sentFileIds = new Set(files.map(file => file.id))
      set(state => ({
        uploads: consumeComposer
          ? {
              ...state.uploads,
              [sessionId]: (state.uploads[sessionId] ?? []).filter(file => !sentFileIds.has(file.id)),
            }
          : state.uploads,
        sessions: state.sessions.map(value => value.id === sessionId
          ? sessionMutations.reconcileIncoming(
              value,
              mergeTurnResponseSession(response.session, value),
              sessionRead,
            )
          : value),
        pendingServerUpdate: pendingServerUpdateMatchesScope(state.pendingServerUpdate, scope)
          ? null
          : state.pendingServerUpdate,
        error: pendingServerUpdateMatchesScope(state.pendingServerUpdate, scope)
          ? null
          : state.error,
      }))
      if (consumeComposer) void saveCurrentWorkspace(get)
      if (response.event && response.event.seq > locallyObservedSeq) applyLiveEvent(scope, response.event, set, get)
      const responseQueued = Boolean(response.queued || response.queued_id || response.event?.type === 'turn_queued')
      if (steer && responseQueued) {
        try {
          let queuedId = response.queued_id || response.event?.queued_id || null
          if (!queuedId) {
            const turns = await refreshSnapshotQueue(scope, sessionId, set, get, queueScopeCurrent)
            if (!turns) return false
            queuedId = resolveNewQueuedTurn(prompt, queuedBeforeSend, turns)
          }
          if (!queuedId) throw new Error('The message was queued, but its queue ID could not be resolved for steering.')
          const ran = await get().runQueuedNow(sessionId, queuedId, scope.generation)
          if (!ran && connectionIsCurrent(scope) && get().selectedSessionId === sessionId) void get().syncSelectedSession('recovery')
        } catch (error) {
          if (!connectionIsCurrent(scope)) return false
          set({ error: errorMessage(error) })
        }
      }
      void get().syncSelectedSession('recovery')
      return true
    } catch (error) {
      if (consumeComposer && consumedDraft && connectionIsCurrent(scope)) {
        set(state => {
          const currentDraft = state.drafts[sessionId] ?? ''
          const currentReferences = state.chatReferencesBySession[sessionId] ?? []
          const restored = restoreFailedChatComposer(
            originalDraft,
            rawReferences,
            currentDraft,
            currentReferences,
            sessionId,
          )
          return {
            drafts: { ...state.drafts, [sessionId]: restored.text },
            chatReferencesBySession: {
              ...state.chatReferencesBySession,
              [sessionId]: restored.references,
            },
            teamReferencesBySession: {
              ...state.teamReferencesBySession,
              [sessionId]: restoreFailedTeamReferences(originalDraft, rawTeamReferences, currentDraft, state.teamReferencesBySession[sessionId] ?? [], restored.text),
            },
          }
        })
        void saveCurrentWorkspace(get)
      }
      if (isStaleConnectionError(error, scope)) return false
      const updatePending = serverUpdatePendingError(error)
      set(state => ({
        error: errorMessage(error),
        pendingServerUpdate: updatePending
          ? serverUpdateNotice(scope, state.health)
          : pendingServerUpdateMatchesScope(state.pendingServerUpdate, scope)
            ? null
            : state.pendingServerUpdate,
      }))
      return false
    } finally {
      sendPromptInFlight.delete(inFlightKey)
      get().endTurnAdmission(sessionId, admissionToken)
      if (connectionIsCurrent(scope)) {
        set(state => {
          const sendingSessionIds = new Set(state.sendingSessionIds)
          sendingSessionIds.delete(sessionId)
          return { sendingSessionIds }
        })
      }
    }
  },

  async stopTurn(expectedGeneration, expectedSessionId) {
    const id = expectedSessionId ?? get().selectedSessionId
    if (!id) return
    if (get().selectedSessionId !== id) return
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    const inFlightKey = `${scope.generation}:${id}`
    if (stopTurnInFlight.has(inFlightKey)) return
    const currentScope = captureAgentRouteGuard(scope, get)
    activityHealth.initialize(activityScope(scope), get().health)
    const activityRequest = activityHealth.capture(activityScope(scope))
    const stoppedOwner = activityHealth.runId(id)
    stopTurnInFlight.add(inFlightKey)
    set(state => {
      const stoppingSessionIds = new Set(state.stoppingSessionIds)
      stoppingSessionIds.add(id)
      return { stoppingSessionIds, error: null }
    })
    try {
      const result = await scope.client.stopTurn(id)
      if (!currentScope()) return
      if (!result.stopped) {
        const message = result.message?.trim()
          || (result.pending || result.deferred
            ? 'Stop is still pending. You can retry.'
            : 'The agent did not stop. You can retry.')
        set({ error: message })
        return
      }
      if (activityHealth.confirmStopped(activityScope(scope), id, activityRequest, stoppedOwner)) {
        set(state => {
          const active = new Set(state.activeSessionIds)
          active.delete(id)
          return { activeSessionIds: active, health: state.health ? {
            ...state.health, active: [...active], active_sessions: [...active],
            ...(state.health.active_runs ? { active_runs: state.health.active_runs.filter(row => row.session_id !== id) } : {}),
          } : null }
        })
      }
    } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) }
    finally {
      stopTurnInFlight.delete(inFlightKey)
      if (connectionIsCurrent(scope)) {
        set(state => {
          const stoppingSessionIds = new Set(state.stoppingSessionIds)
          stoppingSessionIds.delete(id)
          return { stoppingSessionIds }
        })
      }
    }
  },

  async attachFiles(files, expectedGeneration, expectedSessionId) {
    const id = expectedSessionId ?? get().selectedSessionId
    if (!id || !files.length) return
    if (get().selectedSessionId !== id) return
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    const pendingUris = new Set((get().uploadPending[id] ?? []).map(file => file.uri))
    const queuedFiles = files.filter((file, index) => !pendingUris.has(file.uri) && files.findIndex(candidate => candidate.uri === file.uri) === index)
    if (!queuedFiles.length) return
    const queuedUris = new Set(queuedFiles.map(file => file.uri))
    set(state => ({
      uploadPending: { ...state.uploadPending, [id]: [...(state.uploadPending[id] ?? []), ...queuedFiles] },
      uploadFailed: { ...state.uploadFailed, [id]: (state.uploadFailed[id] ?? []).filter(file => !queuedUris.has(file.uri)) },
    }))
    // A queued file must always leave uploadPending, even when the connection or
    // profile goes stale mid-flight. Gating this on connectionIsCurrent stranded
    // the chip on "Uploading…" forever after a reconnect, background/foreground,
    // profile change, revoked validation, or canceled fetch. Clearing is scoped
    // to this session's pending row and is a no-op once a different profile has
    // reset it, so it never resurrects state on the now-active scope.
    const clearPending = (uri: string) => {
      if (!get().uploadPending[id]?.some(value => value.uri === uri)) return
      set(state => ({ uploadPending: { ...state.uploadPending, [id]: (state.uploadPending[id] ?? []).filter(value => value.uri !== uri) } }))
    }
    for (let index = 0; index < queuedFiles.length; index++) {
      const file = queuedFiles[index]
      let abortBatch = false
      try {
        const uploaded = await scope.client.upload(id, file)
        if (!connectionIsCurrent(scope) || !get().sessions.some(session => session.id === id)) {
          // The upload may have reached the server, but this client scope is no
          // longer authoritative, so don't mutate the now-active scope's
          // timeline. The file surfaces on the next server-driven sync.
          abortBatch = true
        } else {
          const safeUpload = sanitizeTimelineFile(uploaded) ?? uploaded
          set(state => {
            const snapshot = state.snapshots[id]
            const alreadyInSnapshot = snapshot?.files.some(value => value.id === safeUpload.id) ?? false
            return {
              uploads: { ...state.uploads, [id]: mergeFiles(state.uploads[id] ?? [], [safeUpload]) },
              uploadFailed: { ...state.uploadFailed, [id]: (state.uploadFailed[id] ?? []).filter(value => value.uri !== file.uri) },
              snapshots: snapshot ? snapshotMapWith(state.snapshots, id, {
                ...snapshot,
                files: mergeFiles(snapshot.files, [safeUpload]),
                filesTotal: alreadyInSnapshot ? snapshot.filesTotal : Math.max(snapshot.filesTotal, snapshot.files.length) + 1,
                cachedAt: Date.now(),
              }) : state.snapshots,
            }
          })
        }
      } catch (error) {
        if (isStaleConnectionError(error, scope)) {
          abortBatch = true
        } else {
          const message = errorMessage(error)
          set(state => ({
            error: message,
            uploadFailed: {
              ...state.uploadFailed,
              [id]: [...(state.uploadFailed[id] ?? []).filter(value => value.uri !== file.uri), { ...file, error: message }],
            },
          }))
        }
      } finally {
        clearPending(file.uri)
      }
      if (abortBatch) {
        // Stop the batch on a stale scope, but never leave the files we won't
        // attempt stuck on "Uploading…".
        for (let rest = index + 1; rest < queuedFiles.length; rest++) clearPending(queuedFiles[rest].uri)
        return
      }
    }
  },
  removeUpload(fileId, expectedGeneration, expectedSessionId) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    const id = expectedSessionId ?? get().selectedSessionId
    if (expectedSessionId && get().selectedSessionId !== expectedSessionId) return
    if (id) set(state => ({ uploads: { ...state.uploads, [id]: (state.uploads[id] ?? []).filter(value => value.id !== fileId) } }))
  },
  removeFailedUpload(fileUri, expectedGeneration, expectedSessionId) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    const id = expectedSessionId ?? get().selectedSessionId
    if (expectedSessionId && get().selectedSessionId !== expectedSessionId) return
    if (id) set(state => ({ uploadFailed: { ...state.uploadFailed, [id]: (state.uploadFailed[id] ?? []).filter(value => value.uri !== fileUri) } }))
  },

  async updateSession(sessionId, patch, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    const before = get().sessions.find(value => value.id === sessionId)
    const nextBackend = patch.backend ?? before?.backend
    const nextModel = patch.model !== undefined ? patch.model : before?.model
    if (nextBackend && (patch.backend !== undefined || patch.model !== undefined)) {
      const selectionError = runtimeSelectionError(get().health, get().runtime, nextBackend, nextModel)
      if (selectionError) {
        set({ error: selectionError })
        return false
      }
    }
    if (
      before
      && patch.backend != null
      && patch.backend !== before.backend
      && (
        before.backend_locked === true
        || get().activeSessionIds.has(sessionId)
        || Boolean(get().turnAdmissionTokens[sessionId])
        || get().sendingSessionIds.has(sessionId)
      )
    ) {
      set({ error: before.backend_locked === true
        ? 'This chat backend is fixed because its provider session has already started.'
        : 'Wait for the current message or active turn to finish before changing its backend.' })
      return false
    }
    const mutation = before ? sessionMutations.begin(before, patch) : null
    set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? { ...value, ...patch } : value) }))
    try {
      const updated = await scope.client.updateSession(sessionId, patch)
      if (!connectionIsCurrent(scope)) {
        if (mutation) sessionMutations.abandon(mutation)
        return false
      }
      set(state => ({ sessions: state.sessions.map(value => {
        if (value.id !== sessionId) return value
        return mutation ? sessionMutations.succeed(value, updated, mutation) : updated
      }) }))
      return true
    } catch (error) {
      if (isStaleConnectionError(error, scope)) {
        if (mutation) sessionMutations.abandon(mutation)
        return false
      }
      if (before) set(state => ({
        sessions: state.sessions.map(value => value.id === sessionId
          ? mutation ? sessionMutations.fail(value, mutation) : before
          : value),
        error: errorMessage(error),
      }))
      return false
    }
  },
  async reloadProvider(sessionId, expectedGeneration) {
    if (get().selectedSessionId !== sessionId) return null
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return null
    const state = get()
    if (
      state.activeSessionIds.has(sessionId)
      || Boolean(state.turnAdmissionTokens[sessionId])
      || state.sendingSessionIds.has(sessionId)
      || state.stoppingSessionIds.has(sessionId)
    ) {
      set({ error: 'Wait for the active turn to finish before reloading this chat agent.' })
      return null
    }
    const inFlightKey = `${scope.generation}:${sessionId}`
    if (providerReloadInFlight.has(inFlightKey)) return null
    providerReloadInFlight.add(inFlightKey)
    set({ error: null })
    const sessionRead = sessionMutations.captureRead()
    try {
      const result = await scope.client.reloadProvider(sessionId)
      if (!connectionIsCurrent(scope) || get().selectedSessionId !== sessionId) return null
      let reconciledSession = result.session
      set(current => {
        const snapshot = current.snapshots[sessionId]
        const existingSession = current.sessions.find(value => value.id === sessionId)
          ?? snapshot?.session
          ?? result.session
        reconciledSession = sessionMutations.reconcileIncoming(existingSession, result.session, sessionRead)
        return {
          sessions: current.sessions.map(value => value.id === sessionId ? reconciledSession : value),
          snapshots: snapshot ? snapshotMapWith(current.snapshots, sessionId, {
            ...snapshot,
            session: reconciledSession,
            cachedAt: Date.now(),
          }) : current.snapshots,
          error: null,
        }
      })
      void get().syncSelectedSession('recovery')
      return { ...result, session: reconciledSession }
    } catch (error) {
      if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      return null
    } finally {
      providerReloadInFlight.delete(inFlightKey)
    }
  },
  async createSession(input, expectedGeneration) {
    const selectionError = runtimeSelectionError(get().health, get().runtime, input.backend, input.model)
    if (selectionError) {
      set({ error: selectionError })
      return false
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    try {
      const session = await scope.client.createSession(input)
      if (!connectionIsCurrent(scope)) return false
      set(state => ({
        sessions: [...state.sessions, session],
        chatDefaults: {
          backend: input.backend,
          model: input.model ?? '',
          effort: input.effort ?? '',
          folder: input.folder.trim() || 'General',
          cwd: input.cwd.trim(),
        },
      }))
      scheduleCurrentWorkspaceSave(get)
      // Selection publishes synchronously before its first cache/network await,
      // so the phone can open the newly-created chat immediately. Keep the
      // slower initial timeline sync in the background instead of making the
      // Create button appear inert.
      void get().selectSession(session.id, scope.generation).catch(error => {
        if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      })
      return true
    } catch (error) {
      if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      return false
    }
  },
  quickCreateSession(expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return Promise.resolve(false)
    if (quickCreateSessionInFlight?.scope === scope) return quickCreateSessionInFlight.promise
    const state = get()
    // Capture the open chat's location at the tap, while keeping the user's
    // configured runtime defaults independent of that chat's agent settings.
    const selected = state.sessions.find(session => session.id === state.selectedSessionId
      && !session.archived && !isWelcomeSession(session.id))
    const defaultCwd = state.health?.default_cwd?.trim() || ''
    const backends = selectableChatBackends(state.health)
    const backend: Backend = backends.includes(state.chatDefaults.backend) ? state.chatDefaults.backend : (backends[0] ?? 'codex')
    let model = state.chatDefaults.model
    let effort = state.chatDefaults.effort
    if (runtimeSelectionError(state.health, state.runtime, backend, model || null)) {
      model = ''
      effort = ''
    }
    const operation = get().createSession({
      title: 'New chat',
      folder: selected ? selected.folder?.trim() || 'General' : state.chatDefaults.folder.trim() || 'General',
      cwd: selected ? selected.cwd?.trim() || defaultCwd : state.chatDefaults.cwd.trim() || defaultCwd,
      backend,
      model,
      effort,
    }, scope.generation).finally(() => {
      if (quickCreateSessionInFlight?.promise === operation) quickCreateSessionInFlight = null
    })
    quickCreateSessionInFlight = { scope, promise: operation }
    return operation
  },
  setChatDefaults(patch) {
    set(state => ({ chatDefaults: { ...state.chatDefaults, ...patch } }))
    scheduleCurrentWorkspaceSave(get)
  },
  async forkSession(sessionId, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    const state = get()
    const inFlightKey = `${scope.generation}:${sessionId}`
    if (state.activeSessionIds.has(sessionId) || state.stoppingSessionIds.has(sessionId)) {
      set({ error: 'Wait for the active turn to finish before forking this chat.' })
      return
    }
    if (state.turnAdmissionTokens[sessionId] || state.sendingSessionIds.has(sessionId)
      || queuedRunInFlight.has(queuedOperationKey(scope, sessionId, get))) {
      set({ error: 'Wait for the message to be accepted before forking this chat.' })
      return
    }
    if (forkSessionInFlight.has(inFlightKey)) return
    forkSessionInFlight.add(inFlightKey)
    try {
      const response = await scope.client.forkSession(sessionId)
      if (!connectionIsCurrent(scope)) return
      const originalIndex = get().sessions.findIndex(value => value.id === sessionId)
      set(state => {
        const sessions = response.sessions ?? [...state.sessions]
        if (response.sessions) return { sessions }
        sessions.splice(Math.max(0, originalIndex + 1), 0, response.session)
        return { sessions }
      })
      await get().selectSession(response.session.id, scope.generation)
    } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) }
    finally { forkSessionInFlight.delete(inFlightKey) }
  },
  async deleteSession(sessionId, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    try {
      await scope.client.deleteSession(sessionId)
      if (!connectionIsCurrent(scope)) return
      const deletedSelectedSession = get().selectedSessionId === sessionId
      if (deletedSelectedSession) {
        selectionEpoch += 1
        stopSelectedStream()
      }
      await removeSnapshot(scope.namespace, sessionId)
      if (!connectionIsCurrent(scope)) return
      const sessions = get().sessions.filter(value => value.id !== sessionId)
      const next = deletedSelectedSession ? sessions.find(value => !value.archived)?.id ?? null : get().selectedSessionId
      set(state => {
        const snapshots = { ...state.snapshots }
        const drafts = { ...state.drafts }
        const chatReferencesBySession = removeChatReferencesForSession(state.chatReferencesBySession, sessionId)
        const teamReferencesBySession = { ...state.teamReferencesBySession }
        delete teamReferencesBySession[sessionId]
        const uploads = { ...state.uploads }
        const uploadPending = { ...state.uploadPending }
        const uploadFailed = { ...state.uploadFailed }
        delete snapshots[sessionId]
        delete drafts[sessionId]
        delete uploads[sessionId]
        delete uploadPending[sessionId]
        delete uploadFailed[sessionId]
        return {
          sessions,
          snapshots,
          drafts,
          chatReferencesBySession,
          teamReferencesBySession,
          uploads,
          uploadPending,
          uploadFailed,
          selectedSessionId: next,
          historyWindow: state.historyWindow?.sessionId === sessionId ? null : state.historyWindow,
        }
      })
      scheduleCurrentWorkspaceSave(get)
      if (next) await get().selectSession(next)
      else if (deletedSelectedSession) {
        set({ liveConnected: false, syncSessionId: null, syncStatus: 'idle', syncError: null, lastTimelineSyncAt: null })
      }
    } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) }
  },
  async reorderSession(sessionId, targetId, placement, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    try { const sessions = await scope.client.reorderSession(sessionId, targetId, placement); if (connectionIsCurrent(scope)) set({ sessions }) }
    catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) }
  },
  async markRead(sessionId, expectedGeneration) {
    const session = get().sessions.find(value => value.id === sessionId)
    if (!session) return
    const seq = session.latest_agent_event_seq ?? get().snapshots[sessionId]?.latestSeq ?? 0
    if (!session.manual_unread && (session.last_read_agent_event_seq ?? 0) >= seq) return
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    set(state => {
      const sessions = state.sessions.map(value => value.id === sessionId ? { ...value, manual_unread: false, last_read_agent_event_seq: seq } : value)
      return { sessions, profiles: updateProfileRuntime(state.profiles, scope.profileId, { cachedUnreadCount: unreadCount(sessions) }) }
    })
    void updateBadge(get())
    try {
      const updated = await scope.client.markRead(sessionId, seq)
      if (!connectionIsCurrent(scope)) return
      set(state => {
        const sessions = state.sessions.map(value => value.id === sessionId ? updated : value)
        return { sessions, profiles: updateProfileRuntime(state.profiles, scope.profileId, { cachedUnreadCount: unreadCount(sessions) }) }
      })
    } catch { /* optimistic read marker remains local until refresh */ }
  },
  async markUnread(sessionId, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    set(state => {
      const sessions = state.sessions.map(value => value.id === sessionId ? { ...value, manual_unread: true } : value)
      return { sessions, profiles: updateProfileRuntime(state.profiles, scope.profileId, { cachedUnreadCount: unreadCount(sessions) }) }
    })
    void updateBadge(get())
    try {
      const updated = await scope.client.markUnread(sessionId)
      if (!connectionIsCurrent(scope)) return
      set(state => {
        const sessions = state.sessions.map(value => value.id === sessionId ? updated : value)
        return { sessions, profiles: updateProfileRuntime(state.profiles, scope.profileId, { cachedUnreadCount: unreadCount(sessions) }) }
      })
    } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) }
  },
  async acknowledgeEmergency(sessionId, alertId, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    try {
      const updated = await scope.client.acknowledgeEmergency(sessionId, alertId)
      if (!connectionIsCurrent(scope)) return false
      set(state => ({
        sessions: state.sessions.map(candidate => candidate.id === sessionId ? updated : candidate),
        snapshots: state.snapshots[sessionId]
          ? snapshotMapWith(state.snapshots, sessionId, { ...state.snapshots[sessionId], session: updated, cachedAt: Date.now() })
          : state.snapshots,
      }))
      return true
    } catch (error) {
      if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      return false
    }
  },
  setFolderOrder(order, expectedGeneration) {
    if (captureConnection().namespaceAdopting) return
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set({ folderOrder: order })
    void saveCurrentWorkspace(get)
  },
  setCollapsedFolders(folders, expectedGeneration) {
    if (captureConnection().namespaceAdopting) return
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set({ collapsedFolders: [...new Set(folders.filter(Boolean))] })
    void saveCurrentWorkspace(get)
  },
  setFontScale(value) {
    const fontScale = clampAppFontScale(value)
    set({ fontScale })
    void saveProfileSettingsFromState(get)
  },

  async updateQueued(sessionId, queuedId, prompt, chatReferences, expectedGeneration, teamReferencesInput) {
    const queued = get().snapshots[sessionId]?.queuedTurns.find(turn => turn.queued_id === queuedId)
    if (queued && !isUserQueuedTurn(queued)) {
      set({ error: 'Incoming agent deliveries are immutable and cannot be edited.' })
      return false
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    const normalizedPrompt = prompt.trim()
    const previousPrompt = queued?.display_prompt ?? queued?.prompt ?? ''
    const attachmentOnly = !normalizedPrompt && !previousPrompt.trim() && !queued?.prompt.trim() && Boolean(queued?.file_ids.length)
      && !(queued?.chat_references?.length || queued?.team_references?.length || chatReferences?.length || teamReferencesInput?.length)
    if (!normalizedPrompt && !attachmentOnly) {
      set({ error: 'Queued message cannot be empty.' })
      return false
    }
    const leadingWhitespace = prompt.length - prompt.trimStart().length
    const rawReferences = chatReferences ?? reconcileChatReferences(
      previousPrompt,
      prompt,
      queued?.chat_references ?? [],
    )
    const requestedReferences = rawReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    const validReferences = validChatReferences(normalizedPrompt, requestedReferences, sessionId)
    const queuedTeamReferences = queued?.team_references ?? []
    if (validTeamReferences(previousPrompt, queuedTeamReferences).length !== queuedTeamReferences.length) {
      set({ error: 'This queued item has a Team Network reference that Mobile cannot edit. Edit it from Mac.' })
      return false
    }
    const reconciledTeamReferences = teamReferencesInput ?? reconcileTeamReferences(previousPrompt, prompt, queuedTeamReferences)
    if (!teamReferencesInput && queuedTeamReferences.some(reference => (
      !reconciledTeamReferences.some(candidate => candidate.team_id === reference.team_id && candidate.target_id === reference.target_id)
      && teamReferenceTokenPresent(prompt, reference.display_name_snapshot)
    ))) {
      set({ error: 'The queued recipient could not be preserved across these edits. Reopen the queue editor and try again.' })
      return false
    }
    const requestedTeamReferences = reconciledTeamReferences.map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    const teamReferences = validTeamReferences(normalizedPrompt, requestedTeamReferences, validReferences)
    if (teamReferences.length !== requestedTeamReferences.length || (teamReferences.length && !teamMessagesAvailable(get().health))) {
      set({ error: 'This queued Team Network reference is unavailable. Restore the exact @@ recipient text or remove it.' })
      return false
    }
    if (validReferences.length !== requestedReferences.length) {
      set({ error: 'A queued chat reference was edited or is no longer valid. Remove it or restore the exact @chat text.' })
      return false
    }
    const state = get()
    const source = state.sessions.find(session => session.id === sessionId)
    const targetBackends = supportedCrossChatTargetBackends(state.health)
    if (validReferences.length && !routeHintMentionsAvailable(state.health)) {
      set({ error: 'Queued @Chat routes require the complete v7 default-deny contract. Update AgentsServer before editing this queue item.' })
      return false
    }
    if (validReferences.some(reference => {
      const target = state.sessions.find(session => session.id === reference.session_id)
      return !localChatReferenceContractSupported(state.health, reference)
        || !target
        || target.archived
        || !targetBackends.includes(target.backend)
        || (reference.action === 'request_reply' && (!source || !targetBackends.includes(source.backend)))
    })) {
      set({ error: 'This server cannot deliver one or more queued cross-chat actions or targets. Change the action or update the server.' })
      return false
    }
    if (teamReferences.some(reference => reference.recipient_kind !== 'server')) {
      const guard = captureAgentRouteGuard(scope, get)
      try {
        await requireTeamReferenceSupport(scope.client, state.health!, teamReferences,
          () => guard() && teamReferences.every(reference => teamReferenceContractSupported(get().health, reference)))
        if (!guard()) return false
      } catch (error) {
        if (guard()) set({ error: errorMessage(error) })
        return false
      }
    }
    const queuedEditIdentity = queuedUserEditIdentity(queued, sessionId)
    if (queued && (!queuedEditIdentity || queuedEditIdentity !== queuedUserEditIdentity(
      get().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === queuedId), sessionId,
    ))) {
      set({ error: 'This queued message changed while its edit was being checked. Your edit was not sent; reopen the current message.' })
      return false
    }
    const previousRunStatus = get().queuedRunStatus[sessionId]
    // An unchanged Save is a client upgrade, not a rewrite of this message's
    // saved grant ceiling. Omit content and reference fields entirely.
    const capabilityOnly = attachmentOnly || Boolean(queued && normalizedPrompt === queued.prompt && normalizedPrompt === previousPrompt
      && chatReferencesEqual(validReferences, queued.chat_references ?? [])
      && teamReferencesEqual(teamReferences, queued.team_references ?? []))
    const current = captureAgentRouteGuard(scope, get)
    const updated = await queueAction(
      scope,
      sessionId,
      () => {
        const dispatch = get()
        const capabilities = interactiveClientCapabilities(dispatch.sessions.find(value => value.id === sessionId), dispatch.health)
        return capabilityOnly ? scope.client.updateQueuedCapabilities(sessionId, queuedId, capabilities)
          : scope.client.updateQueued(sessionId, queuedId, normalizedPrompt, validReferences, capabilities, teamReferences)
      },
      set,
      get,
    )
    if (updated && current() && previousRunStatus?.queued_id === queuedId && previousRunStatus.goal_steer_rejected
      && get().queuedRunStatus[sessionId] === previousRunStatus) {
      set(state => ({ queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId) }))
    }
    return updated
  },
  async updateQueuedAgentMessage(sessionId, queuedId, prompt, expectedMessageRevision, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    const guard = captureAgentRouteGuard(scope, get)
    const capable = () => guard() && asyncQueuedMessageControlsAvailable(get().health)
    const normalized = prompt.trim()
    if (!capable() || !normalized || !Number.isSafeInteger(expectedMessageRevision) || expectedMessageRevision < 0) {
      set({ error: 'This server cannot safely edit this queued agent message. Refresh the queue before retrying.' })
      return false
    }
    const initial = get().snapshots[sessionId]?.queuedTurns.find(turn => turn.queued_id === queuedId)
    const owner = editableQueuedAgentOwner(initial, sessionId)
    if (!owner || initial?.message_revision !== expectedMessageRevision) {
      set({ error: 'This message changed or has already started. Reopen its editor from the current queue.' })
      return false
    }
    const key = queuedOperationKey(scope, sessionId, get, queuedId)
    if (queuedAgentEditTokens.has(key)) return false
    const token = Symbol()
    queuedAgentEditTokens.set(key, token)
    const current = () => capable() && queuedAgentEditTokens.get(key) === token
    try {
      const turns = await refreshSnapshotQueue(scope, sessionId, set, get, current)
      if (!current() || !turns) return false
      const fresh = turns.find(turn => turn.queued_id === queuedId)
      const visible = get().snapshots[sessionId]?.queuedTurns.find(turn => turn.queued_id === queuedId)
      if (editableQueuedAgentOwner(fresh, sessionId) !== owner || fresh?.message_revision !== expectedMessageRevision
        || editableQueuedAgentOwner(visible, sessionId) !== owner || visible?.message_revision !== expectedMessageRevision) {
        throw new Error('This message changed or has already started. Your draft was kept; reopen the current message before saving.')
      }
      // Recipient edits alter only this body at this revision. They cannot
      // create route grants or smuggle user-composer reference metadata.
      await scope.client.updateQueued(sessionId, queuedId, normalized, undefined, undefined, undefined, expectedMessageRevision)
      if (!current()) return false
      const refreshed = await refreshSnapshotQueue(scope, sessionId, set, get, current)
      if (!current() || !refreshed) return false
      const remaining = refreshed.find(turn => turn.queued_id === queuedId)
      if (remaining && (editableQueuedAgentOwner(remaining, sessionId) !== owner
        || (remaining.message_revision ?? -1) <= expectedMessageRevision)) {
        throw new Error('The server has not confirmed this edit. Your draft was kept; refresh the queue before retrying.')
      }
      return true
    } catch (error) {
      if (!current()) return false
      await refreshSnapshotQueue(scope, sessionId, set, get, current).catch(() => null)
      if (current()) set({ error: errorMessage(error) })
      return false
    } finally {
      if (queuedAgentEditTokens.get(key) === token) queuedAgentEditTokens.delete(key)
    }
  },
  async removeQueued(sessionId, queuedId, expectedGeneration) {
    const queued = get().snapshots[sessionId]?.queuedTurns.find(turn => turn.queued_id === queuedId)
    if (queued && !isUserQueuedTurn(queued)) {
      set({ error: 'Incoming agent deliveries are immutable and cannot be removed.' })
      return false
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    return scope ? queueAction(scope, sessionId, () => scope.client.removeQueued(sessionId, queuedId), set, get) : false
  },
  async skipQueuedDelivery(sessionId, queuedId, expectedGeneration) {
    if (get().workspaceAdopting) return false
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    const key = `${sessionId}:${queuedId}`
    if (get().skippingQueuedDeliveryIds.has(key)) return false
    const initial = get().snapshots[sessionId]?.queuedTurns.find(turn => turn.queued_id === queuedId)
    const identity = initial && queuedDeliverySkipIdentity(initial, get().health)
    if (!identity) return false
    const guard = captureAgentRouteGuard(scope, get)
    const token = Symbol()
    queuedDeliverySkipTokens.set(key, token)
    const current = () => guard() && queuedDeliverySkipTokens.get(key) === token
    const refresh = () => refreshSnapshotQueue(scope, sessionId, set, get, current)
    set(state => ({ skippingQueuedDeliveryIds: new Set(state.skippingQueuedDeliveryIds).add(key) }))
    try {
      const turns = await refresh()
      if (!current() || !turns) return false
      const exact = turns.find(turn => turn.queued_id === queuedId)
      const latestIdentity = exact && queuedDeliverySkipIdentity(exact, get().health)
      if (!latestIdentity || JSON.stringify(latestIdentity) !== JSON.stringify(identity)) {
        throw new Error('This incoming delivery changed or has already started. The queue was refreshed.')
      }
      await scope.client.skipQueuedCrossChatDelivery(sessionId, queuedId, identity)
      if (!current()) return false
      const refreshed = await refresh()
      if (!current() || !refreshed) return false
      if (refreshed.some(turn => turn.queued_id === queuedId)) {
        throw new Error('The server has not confirmed this delivery was skipped. Refresh the queue before retrying.')
      }
      return true
    } catch (error) {
      if (!current()) return false
      await refresh().catch(() => null)
      if (current()) set({ error: errorMessage(error) })
      return false
    } finally {
      if (queuedDeliverySkipTokens.get(key) === token) {
        queuedDeliverySkipTokens.delete(key)
        if (connectionIsCurrent(scope)) set(state => {
          const skippingQueuedDeliveryIds = new Set(state.skippingQueuedDeliveryIds)
          skippingQueuedDeliveryIds.delete(key)
          return { skippingQueuedDeliveryIds }
        })
      }
    }
  },
  async moveQueued(sessionId, queuedId, direction, expectedGeneration) {
    const turns = get().snapshots[sessionId]?.queuedTurns ?? []
    const index = turns.findIndex(turn => turn.queued_id === queuedId)
    if (index >= 0 && !isUserQueuedTurn(turns[index])) {
      set({ error: 'Incoming agent deliveries are immutable and cannot be moved.' })
      return false
    }
    if (index >= 0 && queuedMoveCrossesDeliveryBarrier(turns, queuedId, direction)) {
      set({ error: 'Incoming cross-chat deliveries keep their arrival position.' })
      return false
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    return scope ? queueAction(scope, sessionId, () => scope.client.moveQueued(sessionId, queuedId, direction), set, get) : false
  },
  async runQueuedNow(sessionId, queuedId, expectedGeneration) {
    const queuedTurns = get().snapshots[sessionId]?.queuedTurns ?? []
    const queued = queuedTurns.find(turn => turn.queued_id === queuedId)
    const agentOwner = editableQueuedAgentOwner(queued, sessionId)
    const agentMessage = Boolean(agentOwner && asyncQueuedMessageControlsAvailable(get().health))
    if (queued && !isUserQueuedTurn(queued) && !agentMessage) {
      set(state => ({
        queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId, {
          queued_id: queuedId,
          tone: 'error',
          message: 'Incoming agent deliveries start automatically and cannot be sent manually.',
        }),
      }))
      return false
    }
    if (queuedTurnHasEarlierDeliveryBarrier(queuedTurns, queuedId, asyncQueuedMessageControlsAvailable(get().health))) {
      set(state => ({
        queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId, {
          queued_id: queuedId,
          tone: 'error',
          message: 'This message must wait for the earlier incoming agent delivery.',
        }),
      }))
      return false
    }
    let scope: ConnectionScope
    try {
      scope = captureValidatedConnection(get, expectedGeneration)
    } catch (error) {
      if (error instanceof StaleActionScopeError) return false
      set(state => ({
        queuedRunStatus: queuedRunStatusMap(
          state.queuedRunStatus,
          sessionId,
          queuedRunFailureStatus(queuedId, error, true),
        ),
      }))
      return false
    }
    const guard = captureAgentRouteGuard(scope, get)
    if (!guard()) return false
    const inFlightKey = queuedOperationKey(scope, sessionId, get)
    const pending = queuedRunInFlight.get(inFlightKey)
    if (pending) return pending.queuedId === queuedId ? pending.promise : false
    const current = () => guard() && queuedRunInFlight.get(inFlightKey)?.promise === operation
    // Install admission before beginning asynchronous work or notifying store
    // subscribers, including subscribers that synchronously issue another tap.
    const operation = Promise.resolve().then(async (): Promise<boolean> => {
      if (!current()) return false
      const session = get().sessions.find(candidate => candidate.id === sessionId)
      if (session?.backend === 'codex') {
        try {
          await awaitCodexPermissionUpdates({
            profileId: scope.profileId,
            profileGeneration: scope.generation,
            sessionId,
          })
        } catch (error) {
          if (current()) set(state => ({
            queuedRunStatus: queuedRunStatusMap(
              state.queuedRunStatus,
              sessionId,
              queuedRunFailureStatus(queuedId, error, true),
            ),
          }))
          return false
        }
        if (!current()) return false
      }
      if (session?.backend === 'claude') {
        try {
          await awaitClaudePermissionUpdates({
            profileId: scope.profileId,
            profileGeneration: scope.generation,
            sessionId,
          })
        } catch (error) {
          if (current()) set(state => ({
            queuedRunStatus: queuedRunStatusMap(
              state.queuedRunStatus,
              sessionId,
              queuedRunFailureStatus(queuedId, error, true),
            ),
          }))
          return false
        }
        if (!current()) return false
      }

      if (!current()) return false
      if (agentMessage) {
        // Permission changes may wait arbitrarily long. Read only after those
        // waits, then recheck the current projection without another await
        // before POST: the GET publication itself can notify live subscribers.
        const turns = await refreshSnapshotQueue(scope, sessionId, set, get, current).catch(() => null)
        const currentTurns = get().snapshots[sessionId]?.queuedTurns
        const validOwner = (values: QueuedTurn[] | null | undefined) => {
          const latest = values?.find(turn => turn.queued_id === queuedId)
          return Boolean(values && editableQueuedAgentOwner(latest, sessionId) === agentOwner
            && latest?.message_revision === queued?.message_revision
            && !queuedTurnHasEarlierDeliveryBarrier(values, queuedId, asyncQueuedMessageControlsAvailable(get().health)))
        }
        if (!current() || !asyncQueuedMessageControlsAvailable(get().health)
          || !validOwner(turns) || !validOwner(currentTurns)) {
          if (current()) set(state => ({ queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId, {
            queued_id: queuedId, tone: 'error', message: 'This agent message changed or has an earlier delivery. Refresh the queue before sending it now.',
          }) }))
          return false
        }
      }
      let response: QueuedRunNowResponse
      try {
        response = await scope.client.runQueuedNow(sessionId, queuedId)
      } catch (error) {
        if (isStaleConnectionError(error, scope)) return false
        const deliveryUncertain = queuedRunDeliveryUncertain(error)
        const reconciledTurns = await refreshSnapshotQueue(scope, sessionId, set, get, current).catch(() => null)
        if (!current()) return false
        if (deliveryUncertain) {
          const admitted = reconciledTurns && !reconciledTurns.some(turn => turn.queued_id === queuedId)
            && get().snapshots[sessionId]?.events.some(event => event.queued_id === queuedId
              && (event.type === 'turn_started' || isNativeGoalSteerEvent(event)))
          if (admitted) {
            // An exact admission may overtake the HTTP error. Do not recreate
            // uncertainty, or mark a possibly completed run active again.
            set(state => ({ queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId) }))
            if (get().selectedSessionId === sessionId) void get().syncSelectedSession('recovery')
            return true
          }
          set(state => ({
            queuedRunStatus: queuedRunStatusMap(
              state.queuedRunStatus,
              sessionId,
              queuedRunUncertainStatus(queuedId, error),
            ),
          }))
          return false
        }
        if (reconciledTurns && !reconciledTurns.some(value => value.queued_id === queuedId)) {
          markQueuedRunAccepted(scope, sessionId, set, get)
          return true
        }
        set(state => ({
          queuedRunStatus: queuedRunStatusMap(
            state.queuedRunStatus,
            sessionId,
            queuedRunFailureStatus(
              queuedId,
              error,
              Boolean(reconciledTurns?.some(value => value.queued_id === queuedId)),
              Boolean(session?.backend === 'codex'
                && interactiveClientCapabilities(session, get().health).includes('codex_goal_steer_v1')
                && reconciledTurns?.some(value => value.queued_id === queuedId && isUserQueuedTurn(value) && !value.promoted
                  && (!value.session_id || value.session_id === sessionId))
                && isGoalSteerRejection(error, queuedId)),
            ),
          ),
        }))
        return false
      }
      if (!current()) return false

      let reconciledTurns: QueuedTurn[] | null
      try {
        reconciledTurns = await refreshSnapshotQueue(scope, sessionId, set, get, current)
      } catch (error) {
        if (!current() || isStaleConnectionError(error, scope)) return false
        const message = response.deferred
          ? 'Run now was deferred, but the latest queue could not be confirmed. Refresh the chat before retrying.'
          : `Run now was accepted, but AgentsDock could not refresh the queue. Refresh the chat before retrying. ${errorMessage(error)}`
        set(state => ({
          queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId, {
            queued_id: queuedId,
            tone: response.deferred ? 'info' : 'error',
            message,
          }),
        }))
        return false
      }
      if (!current() || !reconciledTurns) return false

      const remainsQueued = reconciledTurns.some(value => value.queued_id === queuedId)
      if (!remainsQueued && (response.deferred || response.ok === false)) {
        // The message may have started or been removed while the response was
        // in flight. Absence is not proof this action started it, but it cannot
        // truthfully be labelled "still queued" either.
        set(state => ({ queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId) }))
        if (get().selectedSessionId === sessionId) void get().syncSelectedSession('recovery')
        return false
      }
      if (response.deferred || response.ok === false || remainsQueued) {
        const deferred = response.deferred === true
        set(state => ({
          queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId, {
            queued_id: queuedId,
            tone: deferred ? 'info' : 'error',
            message: response.message?.trim() || (deferred
              ? 'The current turn is not ready to be interrupted. This message is still queued; try again shortly.'
              : 'The server did not start this queued message. It is still queued; try again.'),
          }),
        }))
        return false
      }

      markQueuedRunAccepted(scope, sessionId, set, get)
      return true
    })
    queuedRunInFlight.set(inFlightKey, { queuedId, promise: operation })
    set(state => {
      const pendingQueuedRunIds = new Set(state.pendingQueuedRunIds)
      pendingQueuedRunIds.add(queuedId)
      return {
        pendingQueuedRunIds,
        queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId),
      }
    })
    try {
      return await operation
    } finally {
      const ownsPresentation = current()
      if (queuedRunInFlight.get(inFlightKey)?.promise === operation) queuedRunInFlight.delete(inFlightKey)
      if (ownsPresentation) {
        set(state => {
          const pendingQueuedRunIds = new Set(state.pendingQueuedRunIds)
          pendingQueuedRunIds.delete(queuedId)
          return { pendingQueuedRunIds }
        })
      }
    }
  },
  clearQueuedRunStatus(sessionId, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    set(state => ({ queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId) }))
  },

  async refreshJobs(expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return
    if (refreshJobsInFlight?.scope === scope) {
      refreshJobsInFlight.dirty = true
      return refreshJobsInFlight.promise
    }
    const request = {
      scope,
      dirty: false,
      promise: Promise.resolve(),
    }
    const operation = (async () => {
      do {
        request.dirty = false
        try {
          const mutationRevision = scope.jobsMutationRevision
          const jobs = await scope.client.jobs()
          if (!connectionIsCurrent(scope)) return
          if (mutationRevision !== scope.jobsMutationRevision) {
            request.dirty = true
            continue
          }
          set({ jobs })
        } catch (error) {
          if (isStaleConnectionError(error, scope)) return
          const message = errorMessage(error)
          if (isDefinitiveValidationFailure(error, message)) {
            forceValidationOffline(scope, message, set)
            return
          }
          set({ error: message })
        }
      } while (request.dirty && connectionIsCurrent(scope))
    })()
    request.promise = operation
    refreshJobsInFlight = request
    try {
      await operation
    } finally {
      if (refreshJobsInFlight?.promise === operation) refreshJobsInFlight = null
    }
  },
  async createJob(input, expectedGeneration) {
    const source = get().sessions.find(session => session.id === input.session_id)
    const selectedBackend = input.context_mode === 'chat' || !input.context_mode ? source?.backend ?? input.backend : input.backend ?? source?.backend
    const selectedModel = selectedBackend === source?.backend ? input.model ?? source?.model : input.model
    if (input.enabled && selectedBackend) {
      const runtimeError = runtimeSelectionError(get().health, get().runtime, selectedBackend, selectedModel)
      if (runtimeError) { set({ error: runtimeError }); return false }
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    try {
      const job = await scope.client.createJob(input)
      if (!connectionIsCurrent(scope)) return false
      markJobsMutated(scope)
      set(state => ({ jobs: [...state.jobs.filter(value => value.id !== job.id), job] }))
      return true
    } catch (error) {
      if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      return false
    }
  },
  async updateJob(jobId, patch, expectedGeneration) {
    const existing = get().jobs.find(job => job.id === jobId)
    const source = existing ? get().sessions.find(session => session.id === existing.session_id) : undefined
    const contextMode = patch.context_mode ?? existing?.context_mode ?? 'chat'
    const selectedBackend = contextMode === 'chat' ? source?.backend : patch.backend ?? existing?.backend ?? source?.backend
    const selectedModel = selectedBackend === source?.backend ? source?.model : existing?.model
    if ((patch.enabled ?? existing?.enabled ?? true) && selectedBackend) {
      const runtimeError = runtimeSelectionError(get().health, get().runtime, selectedBackend, selectedModel)
      if (runtimeError) { set({ error: runtimeError }); return false }
    }
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return false
    try {
      const job = await scope.client.updateJob(jobId, patch)
      if (!connectionIsCurrent(scope)) return false
      markJobsMutated(scope)
      set(state => ({
        jobs: state.jobs.some(value => value.id === jobId)
          ? state.jobs.map(value => value.id === jobId ? job : value)
          : [...state.jobs.filter(value => value.id !== job.id), job],
      }))
      return true
    } catch (error) {
      if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) })
      return false
    }
  },
  async deleteJob(jobId, expectedGeneration) { const scope = validatedConnectionOrReport(get, set, expectedGeneration); if (!scope) return; try { await scope.client.deleteJob(jobId); if (connectionIsCurrent(scope)) { markJobsMutated(scope); set(state => ({ jobs: state.jobs.filter(value => value.id !== jobId) })) } } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) } },
  async runJob(jobId, expectedGeneration) {
    const scope = validatedConnectionOrReport(get, set, expectedGeneration)
    if (!scope) return null
    const requestKey = `${scope.generation}:${jobId}`
    const existing = scheduledJobRunInFlight.get(requestKey)
    if (existing?.scope === scope) return existing.promise
    const operation = (async (): Promise<JobRunResponse | null> => {
      set(state => {
        const pendingJobRunIds = new Set(state.pendingJobRunIds)
        pendingJobRunIds.add(jobId)
        return { pendingJobRunIds }
      })
      try {
        const result = await scope.client.runJob(jobId)
        if (!connectionIsCurrent(scope)) return null
        markJobsMutated(scope)
        if (result.job) {
          set(state => ({
            jobs: state.jobs.some(value => value.id === jobId)
              ? state.jobs.map(value => value.id === jobId ? result.job! : value)
              : [...state.jobs.filter(value => value.id !== result.job!.id), result.job!],
          }))
        }
        void get().refreshJobs(scope.generation)
        return result
      } catch (error) {
        if (isStaleConnectionError(error, scope)) return null
        const message = errorMessage(error)
        return { ok: false, job_id: jobId, error: message, message }
      } finally {
        if (connectionIsCurrent(scope)) {
          set(state => {
            const pendingJobRunIds = new Set(state.pendingJobRunIds)
            pendingJobRunIds.delete(jobId)
            return { pendingJobRunIds }
          })
        }
      }
    })()
    scheduledJobRunInFlight.set(requestKey, { scope, promise: operation })
    try {
      return await operation
    } finally {
      if (scheduledJobRunInFlight.get(requestKey)?.promise === operation) {
        scheduledJobRunInFlight.delete(requestKey)
      }
    }
  },

  async search(query, sessionId, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return
    const request = ++searchRequestRevision
    const clean = serverSearchQuery(query)
    if (!clean) { set({ searchResults: [], searchBusy: false, searchError: null }); return }
    set({ searchResults: [], searchBusy: true, searchError: null })
    const scope = captureConnection()
    try {
      const results = sessionId ? await scope.client.searchTimeline(sessionId, clean) : await scope.client.searchSessions(clean)
      if (!connectionIsCurrent(scope) || request !== searchRequestRevision) return
      set({ searchResults: results, searchBusy: false, searchError: null })
    } catch (error) {
      if (connectionIsCurrent(scope) && request === searchRequestRevision) {
        set({ searchResults: [], searchBusy: false, searchError: errorMessage(error) })
      }
    }
  },
  clearSearch() {
    searchRequestRevision += 1
    set({ searchResults: [], searchBusy: false, searchError: null })
  },

  async pinMessage(sessionId, event, body, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return false
    const pin: PinnedItem = { id: `message:${event.id}`, sessionId, kind: 'message', eventId: event.id, title: body.split('\n')[0].slice(0, 80) || 'Message', body, createdAt: Date.now() }
    return persistPins([pin, ...get().pins.filter(value => value.id !== pin.id)], set, get)
  },
  async pinFile(sessionId, file, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return false
    const pin: PinnedItem = { id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, createdAt: Date.now() }
    return persistPins([pin, ...get().pins.filter(value => value.id !== pin.id)], set, get)
  },
  async removePin(id, expectedGeneration) {
    if (expectedGeneration !== undefined && expectedGeneration !== get().profileGeneration) return false
    return persistPins(get().pins.filter(value => value.id !== id), set, get)
  },
  async inspectProcesses(sessionId = get().selectedSessionId ?? undefined) { const scope = captureConnection(); if (sessionId) try { const value = await scope.client.processes(sessionId); if (connectionIsCurrent(scope)) set(state => ({ processes: { ...state.processes, [sessionId]: value } })) } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) } },
  async inspectTmux(sessionId = get().selectedSessionId ?? undefined, includeAll = false) { const scope = captureConnection(); if (sessionId) try { const value = await scope.client.tmux(sessionId, includeAll); if (connectionIsCurrent(scope)) set(state => ({ tmuxPanes: { ...state.tmuxPanes, [sessionId]: value } })) } catch (error) { if (!isStaleConnectionError(error, scope)) set({ error: errorMessage(error) }) } },
  clearError() { set({ error: null, pendingServerUpdate: null }) },
}))

async function persistPins(
  pins: PinnedItem[],
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<boolean> {
  const previous = get().pins
  const scope = captureConnection()
  if (scope.namespaceAdopting) return false
  set({ pins })
  const write = pinSaveQueue.catch(() => undefined).then(() => savePins(scope.namespace, pins))
  pinSaveQueue = write.catch(() => undefined)
  try {
    await write
    return true
  } catch (error) {
    if (!connectionIsCurrent(scope)) return false
    set(state => ({
      ...(state.pins === pins ? { pins: previous } : {}),
      error: `Could not save pinned items: ${errorMessage(error)}`,
    }))
    return false
  }
}

async function updateServerProfileLocked(
  profileId: string,
  patch: UpdateServerProfileInput,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<boolean> {
  const currentPublic = get().profiles.find(profile => profile.id === profileId)
  if (!currentPublic) throw new Error('Server profile not found.')
  const stored = storedProfiles(get().profiles)
  let updated = applyStoredServerProfileUpdate(currentPublic, patch)
  assertUniqueServerProfile(stored, updated, profileId)
  const connectionChanged = normalizeServerURL(updated.serverURL) !== normalizeServerURL(currentPublic.serverURL)
    || patch.accessToken !== undefined
    || patch.serverIdentity !== undefined
    || Boolean(patch.resetServerIdentity)
  const previousToken = await loadProfileToken(profileId, currentPublic.credentialVersion)
  const nextToken = patch.accessToken === undefined ? previousToken : patch.accessToken ?? ''
  let health: Health | null = null
  const tokenRemovalOnly = patch.accessToken !== undefined
    && !nextToken
    && normalizeServerURL(updated.serverURL) === normalizeServerURL(currentPublic.serverURL)
    && patch.serverIdentity === undefined
    && !patch.resetServerIdentity
  if (connectionChanged && !tokenRemovalOnly) {
    health = await probeServerHealth(updated.serverURL, nextToken)
    const identity = requiredServerIdentity(health)
    const testedIdentity = patch.serverIdentity?.trim()
    if (testedIdentity && testedIdentity !== identity) {
      throw new Error(`The server identity changed after the connection test (expected ${testedIdentity}, received ${identity}). Test the connection again.`)
    }
    if (currentPublic.serverIdentity && currentPublic.serverIdentity !== identity && !patch.resetServerIdentity) {
      throw new Error(`This address reports server identity ${identity}, but the profile is pinned to ${currentPublic.serverIdentity}. Reset the saved identity to accept a replacement server.`)
    }
    updated = { ...updated, serverIdentity: identity, serverConfigured: true, updatedAt: new Date().toISOString() }
    assertUniqueServerProfile(stored, updated, profileId)
  }

  let stagedCredentialVersion: number | null = null
  if (patch.accessToken !== undefined) {
    stagedCredentialVersion = await stageProfileToken(profileId, currentPublic.credentialVersion, nextToken)
    updated = { ...updated, credentialVersion: stagedCredentialVersion }
  }
  const profiles = stored.map(profile => profile.id === profileId ? updated : profile)
  try {
    await saveProfileSettings({
      schemaVersion: 2,
      activeProfileId: get().activeProfileId ?? profileId,
      profiles,
      fontScale: get().fontScale,
    })
  } catch (error) {
    if (stagedCredentialVersion !== null) {
      await deleteProfileToken(profileId, stagedCredentialVersion).catch(() => undefined)
    }
    throw error
  }
  set(state => ({
    profiles: state.profiles.map(profile => profile.id === profileId ? publicProfile(updated, Boolean(nextToken), {
      connectionState: connectionChanged
        ? profileId === state.activeProfileId ? 'connecting' : health ? 'online' : 'cached'
        : profile.connectionState,
      cachedUnreadCount: profile.cachedUnreadCount,
      lastConnectionError: connectionChanged ? null : profile.lastConnectionError,
      lastConnectionCheckedAt: connectionChanged ? Date.now() : profile.lastConnectionCheckedAt,
      serverVersion: health ? healthVersion(health) : profile.serverVersion,
    }) : profile),
  }))
  if (stagedCredentialVersion !== null) {
    await deleteProfileToken(profileId, currentPublic.credentialVersion).catch(() => undefined)
  }
  return connectionChanged
}

async function activateServerProfile(
  profileId: string,
  force: boolean,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<boolean> {
  if (!force && profileId === get().activeProfileId && !get().switchingProfileId) return true
  let activation: { intent: number; scope: ConnectionScope } | null = null
  try {
    activation = await withProfileMutation(() => withActiveConnectionMutation(
      set,
      get,
      () => prepareServerProfileActivation(profileId, force, set, get),
    ))
    if (!activation) return true
    return completeServerProfileActivation(activation, set, get)
  } catch (error) {
    if (!activation || activation.intent === profileSwitchIntent) {
      const message = errorMessage(error)
      set(state => ({
        switchingProfileId: null,
        error: message,
        profiles: error instanceof SendInFlightServerMutationError
          ? state.profiles
          : updateProfileRuntime(state.profiles, profileId, { connectionState: 'offline', lastConnectionError: message }),
      }))
    }
    throw error
  }
}

async function completeServerProfileActivation(
  activation: { intent: number; scope: ConnectionScope },
  set: (value: Partial<AppState>) => void,
  get: () => AppState,
): Promise<boolean> {
  const success = activation.intent === profileSwitchIntent
    && connectionIsCurrent(activation.scope)
    && get().activeProfileId === activation.scope.profileId
  if (!success) return false
  // Cached state is already installed atomically. Release the selector now and
  // validate in the background so a saved offline server cannot trap the UI in
  // a 30-second health timeout. The health-only client still blocks all remote
  // work until reconnect completes identity validation.
  set({ switchingProfileId: null })
  void get().reconnect().catch(error => {
    if (activation.intent !== profileSwitchIntent || !connectionIsCurrent(activation.scope)) return
    activation.scope.client.revokeValidation()
    stopSelectedStream()
    const message = errorMessage(error)
    set({ connected: false, connecting: false, liveConnected: false, health: null, error: message })
  })
  return success
}

async function prepareServerProfileActivation(
  profileId: string,
  force: boolean,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<{ intent: number; scope: ConnectionScope } | null> {
  if (!force && profileId === get().activeProfileId && !get().switchingProfileId) return null
  assertNoSendInFlightForServerMutation(set, get)
  await Promise.all([
    awaitAllCodexPermissionUpdates(),
    awaitAllClaudePermissionUpdates(),
    awaitAllCursorPermissionUpdates(),
  ])
  assertNoSendInFlightForServerMutation(set, get)
  const profile = get().profiles.find(value => value.id === profileId)
  if (!profile) throw new Error('Server profile not found.')
  const intent = ++profileSwitchIntent
  cancelSyncRecovery(set)
  set(state => ({
    switchingProfileId: profileId,
    workspaceAdopting: false,
    error: null,
    pendingServerUpdate: null,
    cancelingServerUpdate: false,
    profiles: updateProfileRuntime(state.profiles, profileId, { connectionState: 'connecting', lastConnectionError: null }),
  }))
  try {
    const previousScope = captureConnection()
    if (get().initialized && get().activeProfileId === previousScope.profileId) await saveCurrentWorkspace(get)
    const namespace = profileNamespace(profile)
    const [token, sessions, pins, workspace] = await Promise.all([
      loadProfileToken(profileId, profile.credentialVersion),
      loadCachedSessions(namespace),
      loadPins(namespace),
      loadWorkspacePreferences(namespace),
    ])
    const selected = workspace.selectedSessionId && sessions.some(value => value.id === workspace.selectedSessionId)
      ? workspace.selectedSessionId
      : sessions.find(value => !value.archived)?.id ?? null
    const snapshot = selected ? await loadSnapshot(namespace, selected) : null
    await saveProfileSettings({
      schemaVersion: 2,
      activeProfileId: profileId,
      profiles: storedProfiles(get().profiles),
      fontScale: get().fontScale,
    })

    stopSelectedStream()
    selectionEpoch += 1
    syncInFlight = null
    olderPageInFlight.clear()
    clearCodeReviewFallbacks()
    sessionMutations.clear()
    foregroundRepairInFlight = null
    if (readReceiptTimer) clearTimeout(readReceiptTimer)
    readReceiptTimer = null
    healthFailureCount = 0
    const scope = installConnection(profileId, profile.serverURL, token, namespace, set)
    const previousUnread = unreadCount(get().sessions)
    set(state => ({
      profiles: state.profiles.map(value => value.id === profileId
        ? { ...value, connectionState: sessions.length ? 'cached' : 'connecting', cachedUnreadCount: unreadCount(sessions), lastConnectionError: null }
        : value.id === state.activeProfileId
          ? { ...value, connectionState: 'cached', cachedUnreadCount: previousUnread }
          : value),
      activeProfileId: profileId,
      profileGeneration: scope.generation,
      switchingProfileId: profileId,
      workspaceAdopting: false,
      serverURL: profile.serverURL,
      serverConfigured: profile.serverConfigured,
      token,
      connected: false,
      connecting: false,
      liveConnected: false,
      health: null,
      runtime: null,
      sessions,
      selectedSessionId: selected,
      snapshots: selected && snapshot ? { [selected]: snapshot } : {},
      historyWindow: null,
      loadingSessionId: null,
      loadingOlder: {},
      filePaging: {},
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      sendingSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      pendingQueuedRunIds: new Set(),
      pendingJobRunIds: new Set(),
      queuedRunStatus: {},
      jobs: [],
      drafts: workspace.drafts,
      chatReferencesBySession: workspace.chatReferencesBySession ?? {},
      teamReferencesBySession: workspace.teamReferencesBySession ?? {},
      uploads: {},
      uploadPending: {},
      uploadFailed: {},
      pins,
      folderOrder: workspace.folderOrder,
      collapsedFolders: workspace.collapsedFolders,
      chatDefaults: workspace.chatDefaults ?? DEFAULT_CHAT_DEFAULTS,
      searchResults: [],
      searchBusy: false,
      searchError: null,
      timelineIndex: {},
      processes: {},
      tmuxPanes: {},
      syncSessionId: selected,
      syncStatus: selected ? 'cached' : 'idle',
      syncError: null,
      lastTimelineSyncAt: null,
      error: null,
      pendingServerUpdate: null,
      cancelingServerUpdate: false,
    }))
    void updateBadge(get())
    return { intent, scope }
  } catch (error) {
    if (intent === profileSwitchIntent) {
      const message = errorMessage(error)
      const activeTarget = get().activeProfileId === profileId
      if (activeTarget) {
        const scope = captureConnection()
        scope.client.revokeValidation()
        stopSelectedStream()
      }
      set(state => ({
        switchingProfileId: null,
        workspaceAdopting: false,
        ...(activeTarget ? {
          connected: false,
          connecting: false,
          liveConnected: false,
          health: null,
          syncStatus: state.selectedSessionId ? 'offline' as const : state.syncStatus,
          syncError: state.selectedSessionId ? message : state.syncError,
        } : {}),
        error: message,
        profiles: updateProfileRuntime(state.profiles, profileId, { connectionState: 'offline', lastConnectionError: message }),
      }))
    }
    throw error
  }
}

async function probeServerHealth(serverURL: string, token: string): Promise<Health> {
  const probe = new AgentServerClient(normalizeServerURL(serverURL), token)
  try {
    const health = await probe.health()
    if (health.ok !== true) throw new Error('Server health check did not report ready.')
    const contract = health.api_contract_version ?? 0
    if (contract < MIN_API_CONTRACT) throw new Error(`Server upgrade required: app needs API v${MIN_API_CONTRACT}, server reports v${contract}.`)
    requiredServerIdentity(health)
    return health
  } finally {
    probe.dispose()
  }
}

async function acceptHealthIdentity(
  scope: ConnectionScope,
  health: Health,
  healthValidationRevision: number,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<void> {
  assertHealthValidationCurrent(scope, healthValidationRevision)
  if (health.ok !== true) throw new Error('Server health check did not report ready.')
  const contract = health.api_contract_version ?? 0
  if (contract < MIN_API_CONTRACT) throw new Error(`Server upgrade required: app needs API v${MIN_API_CONTRACT}, server reports v${contract}.`)
  const identity = requiredServerIdentity(health)
  const previousHealth = get().health
  if (previousHealth && (
    previousHealth.server_identity !== health.server_identity
    || previousHealth.server_instance_id !== health.server_instance_id
    || (agentCrossChatRoutesAvailable(previousHealth) && !agentCrossChatRoutesAvailable(health))
  )) set(emptyAgentRouteState())
  await withProfileMutation(async () => {
    if (!connectionIsCurrent(scope)) return
    assertHealthValidationCurrent(scope, healthValidationRevision)
    const profile = get().profiles.find(value => value.id === scope.profileId)
    if (!profile || get().activeProfileId !== scope.profileId) throw new Error('Active server profile is missing.')
    if (profile.serverIdentity && profile.serverIdentity !== identity) {
      throw new Error(`Server identity mismatch: expected ${profile.serverIdentity}, received ${identity}.`)
    }
    const duplicate = findDuplicateProfileByIdentity(get().profiles, identity, profile.id)
    if (duplicate) throw new Error(`Server identity ${identity} already belongs to ${duplicate.name}.`)
    if (profile.serverIdentity === identity && profile.serverConfigured) {
      assertHealthValidationCurrent(scope, healthValidationRevision)
      scope.client.markValidated()
      return
    }

    const sourceNamespace = scope.namespace
    // Finish any typing debounce while the source namespace is still active.
    // Otherwise its timer can fire after adoption and overwrite the canonical
    // workspace with the stale pre-migration draft snapshot it captured.
    await saveCurrentWorkspace(get)
    assertHealthValidationCurrent(scope, healthValidationRevision)
    if (!connectionIsCurrent(scope)) return
    scope.namespaceAdopting = true
    if (connectionIsCurrent(scope)) set({ workspaceAdopting: true })
    let fallbackToPurge: { namespace: string; verifiedSourceKeys: string[] } | null = null
    try {
      const workspaceState = get()
      await pinSaveQueue.catch(() => undefined).then(() => savePins(sourceNamespace, workspaceState.pins))
      assertHealthValidationCurrent(scope, healthValidationRevision)
      const updated: StoredServerProfile = { ...profile, serverIdentity: identity, serverConfigured: true, updatedAt: new Date().toISOString() }
      const targetNamespace = profileNamespace(updated)
      const migration = sourceNamespace !== targetNamespace
        ? await migrateCacheNamespace(sourceNamespace, targetNamespace)
        : null
      assertHealthValidationCurrent(scope, healthValidationRevision)
      if (!connectionIsCurrent(scope)) return
      const profiles = storedProfiles(get().profiles).map(value => value.id === profile.id ? updated : value)
      await saveProfileSettings({
        schemaVersion: 2,
        activeProfileId: profile.id,
        profiles,
        fontScale: get().fontScale,
      })
      assertHealthValidationCurrent(scope, healthValidationRevision)
      if (!connectionIsCurrent(scope)) return
      scope.namespace = targetNamespace
      const [sessions, pins, workspace] = await Promise.all([
        loadCachedSessions(targetNamespace),
        loadPins(targetNamespace),
        loadWorkspacePreferences(targetNamespace),
      ])
      if (!connectionIsCurrent(scope)) return
      const selected = workspace.selectedSessionId && sessions.some(value => value.id === workspace.selectedSessionId)
        ? workspace.selectedSessionId
        : sessions.find(value => !value.archived)?.id ?? null
      const snapshot = selected ? await loadSnapshot(targetNamespace, selected) : null
      if (!connectionIsCurrent(scope)) return
      set(state => ({
        profiles: state.profiles.map(value => value.id === profile.id
          ? publicProfile(updated, value.hasAccessToken, {
              connectionState: value.connectionState,
              cachedUnreadCount: unreadCount(sessions),
              lastConnectionError: value.lastConnectionError,
              lastConnectionCheckedAt: value.lastConnectionCheckedAt,
              serverVersion: value.serverVersion,
            })
          : value),
        serverConfigured: true,
        sessions,
        pins,
        drafts: workspace.drafts,
        chatReferencesBySession: workspace.chatReferencesBySession ?? {},
        teamReferencesBySession: workspace.teamReferencesBySession ?? {},
        folderOrder: workspace.folderOrder,
        collapsedFolders: workspace.collapsedFolders,
        chatDefaults: workspace.chatDefaults ?? DEFAULT_CHAT_DEFAULTS,
        selectedSessionId: selected,
        snapshots: selected && snapshot ? { [selected]: snapshot } : {},
        historyWindow: null,
        loadingOlder: {},
        filePaging: {},
        syncSessionId: selected,
        syncStatus: selected ? 'cached' : 'idle',
      }))
      if (connectionIsCurrent(scope)) {
        assertHealthValidationCurrent(scope, healthValidationRevision)
        scope.client.markValidated()
      }
      if (migration) fallbackToPurge = { namespace: sourceNamespace, verifiedSourceKeys: migration.verifiedSourceKeys }
    } finally {
      scope.namespaceAdopting = false
      if (connectionIsCurrent(scope)) set({ workspaceAdopting: false })
    }
    // The canonical copy and selecting profile metadata are already durable.
    // Source deletion is best-effort maintenance and must never keep every
    // chat row disabled or race by rewriting the now-live target namespace.
    if (fallbackToPurge) void purgeCacheNamespace(fallbackToPurge.namespace, fallbackToPurge.verifiedSourceKeys).catch(() => undefined)
  })
}

function assertHealthValidationCurrent(scope: ConnectionScope, healthValidationRevision: number): void {
  if (scope.client.validationRevision !== healthValidationRevision) {
    throw new AgentServerClientUnvalidatedError()
  }
}

function validatedRevisionIsCurrent(scope: ConnectionScope, validationRevision: number): boolean {
  return connectionIsCurrent(scope)
    && scope.client.isValidated
    && scope.client.validationRevision === validationRevision
}

function pauseReconnectForInactiveApp(
  scope: ConnectionScope,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
): boolean {
  if (!connectionIsCurrent(scope)) return true
  if (NativeAppState.currentState === 'active') return false
  // A reconnect paused after identity validation may already have launched
  // authenticated fan-out requests. Invalidate that scope so those requests
  // abort, then force one complete reconnect when the app becomes active.
  scope.client.revokeValidation()
  stopSelectedStream()
  set(state => ({
    ...emptyAgentRouteState(),
    connected: false,
    connecting: false,
    liveConnected: false,
    health: null,
    syncStatus: state.selectedSessionId ? 'cached' : state.syncStatus,
    syncError: null,
    profiles: updateProfileRuntime(state.profiles, scope.profileId, {
      connectionState: 'cached',
    }),
  }))
  return true
}

function forceValidationOffline(
  scope: ConnectionScope,
  message: string,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
): void {
  if (!connectionIsCurrent(scope)) return
  healthFailureCount = 2
  scope.client.revokeValidation()
  stopSelectedStream()
  set(state => ({
    ...emptyAgentRouteState(),
    connected: false,
    connecting: false,
    liveConnected: false,
    health: null,
    error: message,
    pendingServerUpdate: null,
    cancelingServerUpdate: false,
    syncSessionId: state.selectedSessionId,
    syncStatus: state.selectedSessionId ? 'offline' : 'idle',
    syncError: state.selectedSessionId ? message : null,
    profiles: updateProfileRuntime(state.profiles, scope.profileId, {
      connectionState: 'offline',
      lastConnectionError: message,
      lastConnectionCheckedAt: Date.now(),
    }),
  }))
}

function requiredServerIdentity(health: Health): string {
  const identity = typeof health.server_identity === 'string' ? health.server_identity.trim() : ''
  if (!identity) throw new Error('Server health response is missing a stable server identity.')
  return identity
}

function healthVersion(health: Health): string | null {
  const value = health.server_version ?? health.version
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isIdentityValidationFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('server identity')
    || normalized.includes('server upgrade required')
    || normalized.includes('health contract')
    || normalized.includes('health check did not report ready')
}

function isDefinitiveValidationFailure(error: unknown, message: string): boolean {
  return (error instanceof ServerError && (error.status === 401 || error.status === 403))
    || isIdentityValidationFailure(message)
}

const SERVER_UPDATE_SCHEDULE_ID = /^[0-9a-f]{32}$/
const SERVER_UPDATE_ACTIVE_PHASES = new Set(['starting', 'checking', 'downloading', 'verifying', 'installing', 'restarting'])

function serverErrorCode(error: unknown): string | null {
  if (!(error instanceof ServerError) || !error.detail || typeof error.detail !== 'object') return null
  const code = (error.detail as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function serverUpdatePendingError(error: unknown): boolean {
  return serverErrorCode(error) === 'server_update_pending'
}

function serverUpdateCancellationAvailable(health: Health | null): boolean {
  const capability = health?.capabilities?.server_updates
  // v6 owns the cancellation contract. `available` describes whether a new
  // signed update can be launched, not whether an existing reservation may be
  // canceled after launch prerequisites change.
  return typeof capability?.version === 'number' && capability.version >= 6
}

function serverUpdateNotice(scope: ConnectionScope, health: Health | null): PendingServerUpdateNotice {
  return {
    profileId: scope.profileId,
    profileGeneration: scope.generation,
    canCancel: serverUpdateCancellationAvailable(health),
  }
}

function pendingServerUpdateMatchesScope(notice: PendingServerUpdateNotice | null, scope: ConnectionScope): boolean {
  return notice?.profileId === scope.profileId && notice.profileGeneration === scope.generation
}

function cancelableServerUpdateScheduleId(status: ServerUpdateStatus): string | null {
  const scheduleId = typeof status.schedule_id === 'string' ? status.schedule_id.trim() : ''
  return status.phase === 'pending' && status.cancelable === true && SERVER_UPDATE_SCHEDULE_ID.test(scheduleId)
    ? scheduleId
    : null
}

function serverUpdateIsActive(status: ServerUpdateStatus): boolean {
  return SERVER_UPDATE_ACTIVE_PHASES.has(status.phase)
}

function serverUpdateUncancelableMessage(status: ServerUpdateStatus): string | null {
  if (serverUpdateIsActive(status)) {
    return status.message || 'The server update has already started. Wait for AgentsServer to reconnect, then send again.'
  }
  if (status.phase === 'pending') {
    return 'AgentsServer reported a pending update without a valid cancellation reservation. Wait for the update to finish, then send again.'
  }
  return null
}

function createProfileId(): string {
  return `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function storedProfiles(profiles: readonly PublicServerProfile[]): StoredServerProfile[] {
  return profiles.map(profile => ({
    id: profile.id,
    name: profile.name,
    serverURL: profile.serverURL,
    serverIdentity: profile.serverIdentity,
    serverConfigured: profile.serverConfigured,
    credentialVersion: profile.credentialVersion,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }))
}

function publicProfile(
  profile: StoredServerProfile,
  hasAccessToken: boolean,
  runtime: Partial<Pick<PublicServerProfile, 'connectionState' | 'cachedUnreadCount' | 'lastConnectionError' | 'lastConnectionCheckedAt' | 'serverVersion'>> = {},
): PublicServerProfile {
  return {
    ...profile,
    hasAccessToken,
    connectionState: runtime.connectionState ?? 'cached',
    cachedUnreadCount: runtime.cachedUnreadCount ?? 0,
    lastConnectionError: runtime.lastConnectionError ?? null,
    lastConnectionCheckedAt: runtime.lastConnectionCheckedAt ?? null,
    serverVersion: runtime.serverVersion ?? null,
  }
}

async function hydratePublicProfiles(profiles: readonly StoredServerProfile[], activeProfileId: string): Promise<PublicServerProfile[]> {
  return Promise.all(profiles.map(async profile => {
    const [token, summary] = await Promise.all([
      loadProfileToken(profile.id, profile.credentialVersion),
      cachedServerSummary(profileNamespace(profile)),
    ])
    return publicProfile(profile, Boolean(token), {
      connectionState: profile.id === activeProfileId ? (summary.sessionCount ? 'cached' : 'connecting') : 'cached',
      cachedUnreadCount: summary.unreadCount,
    })
  }))
}

function updateProfileRuntime(
  profiles: readonly PublicServerProfile[],
  profileId: string,
  patch: Partial<Pick<PublicServerProfile, 'connectionState' | 'cachedUnreadCount' | 'lastConnectionError' | 'lastConnectionCheckedAt' | 'serverVersion'>>,
): PublicServerProfile[] {
  const index = profiles.findIndex(profile => profile.id === profileId)
  if (index < 0) return profiles as PublicServerProfile[]
  const current = profiles[index]
  if (Object.entries(patch).every(([key, value]) => current[key as keyof PublicServerProfile] === value)) {
    return profiles as PublicServerProfile[]
  }
  const next = [...profiles]
  next[index] = { ...current, ...patch }
  return next
}

function unreadCount(sessions: readonly Session[]): number {
  return sessions.filter(session => !session.archived && (session.manual_unread || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0))).length
}

function saveCurrentWorkspace(get: () => AppState): Promise<void> {
  const scope = captureConnection()
  if (scope.namespaceAdopting) return Promise.resolve()
  if (pendingWorkspaceSave?.scope === scope) {
    clearTimeout(pendingWorkspaceSave.timer)
    pendingWorkspaceSave = null
  }
  const state = get()
  return saveWorkspacePreferences(scope.namespace, currentWorkspacePreferences(state))
}

function scheduleCurrentWorkspaceSave(get: () => AppState): void {
  const scope = captureConnection()
  if (scope.namespaceAdopting) return
  if (pendingWorkspaceSave) clearTimeout(pendingWorkspaceSave.timer)
  const value = currentWorkspacePreferences(get())
  const timer = setTimeout(() => {
    const pending = pendingWorkspaceSave
    if (!pending || pending.timer !== timer) return
    pendingWorkspaceSave = null
    void saveWorkspacePreferences(pending.scope.namespace, pending.value).catch(() => undefined)
  }, WORKSPACE_SAVE_DEBOUNCE_MS)
  pendingWorkspaceSave = { scope, value, timer }
}

function currentWorkspacePreferences(state: AppState): WorkspacePreferences {
  return {
    selectedSessionId: isWelcomeSession(state.selectedSessionId) ? null : state.selectedSessionId,
    folderOrder: state.folderOrder,
    collapsedFolders: state.collapsedFolders,
    drafts: withoutWelcomeRecord(state.drafts),
    chatReferencesBySession: withoutWelcomeRecord(state.chatReferencesBySession),
    teamReferencesBySession: withoutWelcomeRecord(state.teamReferencesBySession),
    chatDefaults: state.chatDefaults,
  }
}

function saveProfileSettingsFromState(get: () => AppState): Promise<void> {
  return withProfileMutation(async () => {
    const state = get()
    if (!state.activeProfileId || !state.profiles.length) return
    await saveProfileSettings({
      schemaVersion: 2,
      activeProfileId: state.activeProfileId,
      profiles: storedProfiles(state.profiles),
      fontScale: state.fontScale,
    })
  })
}

function withProfileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = profileMutationQueue.catch(() => undefined).then(operation)
  profileMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function serverProfileConnectionChanges(
  profile: Pick<StoredServerProfile, 'serverURL'>,
  patch: UpdateServerProfileInput,
): boolean {
  return (
    (patch.serverURL !== undefined && normalizeServerURL(patch.serverURL) !== normalizeServerURL(profile.serverURL))
    || patch.accessToken !== undefined
    || patch.serverIdentity !== undefined
    || patch.resetServerIdentity === true
  )
}

function assertNoSendInFlightForServerMutation(
  set: (value: Partial<AppState>) => void,
  get: () => AppState,
): void {
  if (
    sendPromptInFlight.size === 0
    && get().sendingSessionIds.size === 0
    && Object.keys(get().turnAdmissionTokens).length === 0
  ) return
  const error = new SendInFlightServerMutationError()
  set({ error: error.message })
  throw error
}

async function withActiveConnectionMutation<T>(
  set: (value: Partial<AppState>) => void,
  get: () => AppState,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeConnectionMutationDepth > 0) return operation()
  assertNoSendInFlightForServerMutation(set, get)
  activeConnectionMutationDepth += 1
  try {
    return await operation()
  } finally {
    activeConnectionMutationDepth -= 1
  }
}

function stopForegroundRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}

function startForegroundRefreshTimer(get: () => AppState): void {
  if (refreshTimer || NativeAppState.currentState !== 'active') return
  refreshTimer = setInterval(() => {
    if (
      NativeAppState.currentState !== 'active'
      || !shouldAutoConnectServer(get())
      || periodicRefreshInFlight
    ) return
    periodicRefreshInFlight = true
    const operation = get().connected ? get().refreshSessions() : get().reconnect()
    void operation.finally(() => { periodicRefreshInFlight = false })
  }, FOREGROUND_REFRESH_MS)
}

function flushPendingLiveSnapshotSave(): Promise<void> {
  const pending = pendingLiveSnapshotSave
  if (!pending) return Promise.resolve()
  clearTimeout(pending.timer)
  pendingLiveSnapshotSave = null
  return saveSnapshot(pending.scope.namespace, pending.snapshot).catch(() => undefined)
}

function scheduleLiveSnapshotSave(scope: ConnectionScope, snapshot: Snapshot, immediate: boolean): void {
  const pending = pendingLiveSnapshotSave
  if (pending && (pending.scope.namespace !== scope.namespace || pending.snapshot.session.id !== snapshot.session.id)) {
    void flushPendingLiveSnapshotSave()
  }
  if (immediate) {
    if (pendingLiveSnapshotSave) {
      clearTimeout(pendingLiveSnapshotSave.timer)
      pendingLiveSnapshotSave = null
    }
    void saveSnapshot(scope.namespace, snapshot).catch(() => undefined)
    return
  }
  if (pendingLiveSnapshotSave) clearTimeout(pendingLiveSnapshotSave.timer)
  const timer = setTimeout(() => {
    if (pendingLiveSnapshotSave?.timer !== timer) return
    void flushPendingLiveSnapshotSave()
  }, LIVE_SNAPSHOT_SAVE_DEBOUNCE_MS)
  pendingLiveSnapshotSave = { scope, snapshot, timer }
}

function cancelSyncRecovery(set?: (value: Partial<AppState>) => void): void {
  if (syncRecovery?.timer) clearTimeout(syncRecovery.timer)
  syncRecovery = null
  set?.({ syncRetryAttempt: 0, syncRetryAt: null })
}

function scheduleSyncRecovery(
  scope: ConnectionScope,
  sessionId: string,
  epoch: number,
  get: () => AppState,
  set: (value: Partial<AppState>) => void,
): void {
  if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope) || get().selectedSessionId !== sessionId || epoch !== selectionEpoch) return
  const key = `${scope.generation}:${sessionId}:${epoch}`
  const attempt = syncRecovery?.key === key ? syncRecovery.attempt : 0
  if (attempt >= SYNC_RECOVERY_DELAYS_MS.length) {
    syncRecovery = null
    set({ syncStatus: 'error', syncRetryAttempt: SYNC_RECOVERY_DELAYS_MS.length, syncRetryAt: null })
    return
  }
  if (syncRecovery?.timer) return
  const baseDelay = SYNC_RECOVERY_DELAYS_MS[attempt]
  const delay = Math.min(30_000, Math.max(500, Math.round(baseDelay * (0.9 + Math.random() * 0.2))))
  const retryAt = Date.now() + delay
  const timer = setTimeout(() => {
    if (syncRecovery?.key !== key || syncRecovery.timer !== timer) return
    syncRecovery = { key, attempt: attempt + 1, timer: null }
    if (NativeAppState.currentState !== 'active' || !connectionIsCurrent(scope) || get().selectedSessionId !== sessionId || epoch !== selectionEpoch) {
      cancelSyncRecovery(set)
      return
    }
    void get().syncSelectedSession('recovery')
  }, delay)
  syncRecovery = { key, attempt, timer }
  set({ syncRetryAttempt: attempt + 1, syncRetryAt: retryAt })
}

function syncFailureIsTransient(error: unknown): boolean {
  if (error instanceof ServerError) return [408, 425, 429].includes(error.status) || error.status >= 500
  if (error instanceof WebSocketConnectionError) {
    if ([4401, 4404, 4409].includes(error.code) || error.fatal) return false
    return true
  }
  if (error instanceof AgentServerClientDisposedError || error instanceof AgentServerClientUnvalidatedError) return false
  const message = errorMessage(error).toLowerCase()
  return /network|timeout|timed out|connection|fetch failed|socket|temporar|offline|unreachable/.test(message)
}

function installAppLifecycle(
  get: () => AppState,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
): void {
  stopForegroundRefreshTimer()
  if (NativeAppState.currentState === 'active') startForegroundRefreshTimer(get)
  else {
    stopSelectedStream()
    set(state => ({
      connecting: false,
      liveConnected: false,
      syncStatus: state.selectedSessionId ? (state.connected ? 'cached' : 'offline') : state.syncStatus,
    }))
  }
  if (appStateSubscription) return
  appStateSubscription = NativeAppState.addEventListener('change', nextState => {
    if (nextState !== 'active') {
      cancelSyncRecovery(set)
      stopForegroundRefreshTimer()
      stopSelectedStream()
      if (readReceiptTimer) clearTimeout(readReceiptTimer)
      readReceiptTimer = null
      set(state => ({
        connecting: false,
        liveConnected: false,
        syncStatus: state.selectedSessionId ? (state.connected ? 'cached' : 'offline') : state.syncStatus,
      }))
      if (get().activeProfileId) void saveCurrentWorkspace(get).catch(() => undefined)
      return
    }
    startForegroundRefreshTimer(get)
    if (!shouldAutoConnectServer(get())) return
    void (async () => {
      await repairSelectedSnapshotFromCache(get, set)
      if (NativeAppState.currentState !== 'active') return
      if (get().connected) await get().refreshSessions()
      else await get().reconnect()
      const selectedSessionId = get().selectedSessionId
      const selectedSyncInFlight = Boolean(
        selectedSessionId
        && syncInFlight?.sessionId === selectedSessionId
        && syncInFlight.epoch === selectionEpoch,
      )
      if (
        NativeAppState.currentState === 'active'
        && get().connected
        && selectedSessionId
        && !hasSelectedStream(selectedSessionId)
        && !selectedSyncInFlight
      ) {
        await get().syncSelectedSession('foreground')
      }
    })()
  })
}

function applyLiveEvent(scope: ConnectionScope, event: Event, set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void, get: () => AppState): void {
  if (!connectionIsCurrent(scope)) return
  event = mergeAndSanitizeIncomingEvents(get().snapshots[event.session_id]?.events ?? [], [event])[0]!
  const sessionId = event.session_id
  const silentImport = isImportedHistoryRecord(event) || isImportedProviderControlMetadata(event)
  const acceptQueueEvent = !silentImport && queueReconciliationState(scope, sessionId, get).observe(event)
  const timelineInternal = TIMELINE_INTERNAL_EVENT_TYPES.has(event.type)
  const nativeSteerSupersession = isNativeSteerSupersession(event)
  const terminalEvent = !silentImport && ['turn_finished', 'turn_stopped'].includes(event.type) && !nativeSteerSupersession
  activityHealth.initialize(activityScope(scope), get().health)
  const health = activityHealth.observe(activityScope(scope), event)
  set(state => {
    const snapshot = state.snapshots[sessionId]
    const agentActivity = !silentImport && isAgentActivityEvent(event)
    const projectedActive = health ? healthActiveSessions(health) : state.activeSessionIds
    const active = projectedActive.size === state.activeSessionIds.size
      && [...projectedActive].every(id => state.activeSessionIds.has(id)) ? state.activeSessionIds : projectedActive
    const healthState = health ? { health } : {}
    const updateSessionMetadata = !silentImport && !SESSION_METADATA_PASSIVE_EVENT_TYPES.has(event.type)
    const sessions = updateSessionMetadata
      ? state.sessions.map(session => session.id === sessionId ? {
          ...session,
          latest_event_seq: Math.max(session.latest_event_seq ?? 0, event.seq),
          ...(event.seq >= (session.latest_event_seq ?? 0) ? { latest_event_at: event.ts, latest_event_type: event.type } : {}),
          ...(agentActivity && event.seq >= (session.latest_agent_event_seq ?? 0) ? {
            latest_agent_event_seq: Math.max(session.latest_agent_event_seq ?? 0, event.seq),
            latest_agent_event_at: event.ts,
            latest_agent_event_type: event.type,
          } : {}),
        } : session)
      : state.sessions
    const profiles = updateSessionMetadata
      ? updateProfileRuntime(state.profiles, scope.profileId, { cachedUnreadCount: unreadCount(sessions) })
      : state.profiles
    const selectedSync = state.selectedSessionId === sessionId ? {
      syncSessionId: sessionId,
      syncStatus: 'live' as const,
      syncError: null,
      liveConnected: true,
      lastTimelineSyncAt: Date.now(),
    } : {}
    if (!snapshot) return { ...healthState, activeSessionIds: active, sessions, profiles, ...selectedSync }
    const queuedTurns = acceptQueueEvent ? updateQueuedTurns(snapshot.queuedTurns, event) : snapshot.queuedTurns
    const queuedRunStatus = !silentImport && (acceptQueueEvent || event.type === 'turn_started' || isNativeGoalSteerEvent(event))
      ? queuedRunStatusForEvent(state.queuedRunStatus, sessionId, queuedTurns, event)
      : state.queuedRunStatus
    // Queue, job and subagent bookkeeping must still update their dedicated
    // projections, but storing those packets as transcript events invalidates
    // every long-chat row and makes live scrolling stutter. If an internal
    // event did not alter the queue, keep the snapshot reference stable.
    if (timelineInternal && queuedTurns === snapshot.queuedTurns) {
      return { ...healthState, queuedRunStatus, activeSessionIds: active, sessions, profiles, ...selectedSync }
    }
    const mergedEvents = timelineInternal ? snapshot.events : mergeEvents(snapshot.events, [event])
    const boundedEvents = boundLiveTimelineEvents(mergedEvents)
    const next: Snapshot = {
      ...snapshot,
      events: boundedEvents,
      files: timelineInternal ? snapshot.files : mergeFiles(snapshot.files, filesFromEvents([event])),
      queuedTurns,
      hasMore: snapshot.hasMore || (!timelineInternal && liveTimelineEventsWereTrimmed(mergedEvents, boundedEvents)),
      latestSeq: Math.max(snapshot.latestSeq ?? 0, event.seq),
      cachedAt: Date.now(),
    }
    scheduleLiveSnapshotSave(
      scope,
      next,
      terminalEvent,
    )
    return {
      ...healthState,
      snapshots: snapshotMapWith(state.snapshots, sessionId, next),
      queuedRunStatus,
      activeSessionIds: active,
      sessions,
      profiles,
      ...selectedSync,
    }
  })
  if (silentImport) return
  if ([
    'turn_finished',
    'artifact_created',
    'file_uploaded',
    'codex_interaction_requested',
    'codex_interaction_resolved',
    'claude_interaction_requested',
    'claude_interaction_resolved',
  ].includes(event.type)) void get().refreshSessions()
  if (event.type.startsWith('job_')) void get().refreshJobs()
  // A timeline high-water is not an atomic queue version. For a covered
  // packet, suppress replay into the shelf but confirm its signal by HTTP.
  if (!acceptQueueEvent || (
    queueSnapshotRequiresRefresh(event, get().snapshots[sessionId]?.queuedTurns ?? [])
    || crossChatQueueRefreshSessionId(event) === sessionId
  )) void refreshQueueAfterSparseSnapshot(scope, sessionId, set, get)
  if (
    NativeAppState.currentState === 'active'
    && get().selectedSessionId === sessionId
    && isAgentActivityEvent(event)
  ) scheduleReadReceipt(scope, sessionId, get)
  if (NativeAppState.currentState !== 'active' && isAgentActivityEvent(event)) {
    const session = get().sessions.find(value => value.id === sessionId)
    if (session) void notifyOnce(scope, session, event.seq)
  }
}

function scheduleReadReceipt(scope: ConnectionScope, sessionId: string, get: () => AppState): void {
  if (readReceiptTimer) clearTimeout(readReceiptTimer)
  readReceiptTimer = setTimeout(() => {
    readReceiptTimer = null
    if (connectionIsCurrent(scope) && NativeAppState.currentState === 'active' && get().selectedSessionId === sessionId) void get().markRead(sessionId)
  }, READ_RECEIPT_DEBOUNCE_MS)
}

function stopSelectedStream(): void {
  streamGeneration += 1
  void flushPendingLiveSnapshotSave()
  const stop = streamStop
  streamStop = null
  streamSessionId = null
  streamLatestSeq = 0
  stop?.()
}

function startSelectedStream(
  sessionId: string,
  after: number,
  epoch: number,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  stopSelectedStream()
  if (NativeAppState.currentState !== 'active') {
    set({ liveConnected: false, syncSessionId: sessionId, syncStatus: get().connected ? 'cached' : 'offline', syncError: null })
    return
  }
  const scope = captureConnection()
  const generation = ++streamGeneration
  streamSessionId = sessionId
  streamLatestSeq = after
  set({ liveConnected: false, syncSessionId: sessionId, syncStatus: 'syncing', syncError: null })
  streamStop = scope.client.stream(
    sessionId,
    after,
    event => {
      if (!connectionIsCurrent(scope) || event.session_id !== sessionId || generation !== streamGeneration || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
      streamLatestSeq = Math.max(streamLatestSeq, event.seq)
      if (event.type === 'raw_event') return
      applyLiveEvent(scope, event, set, get)
    },
    (connected, detail) => {
      if (!connectionIsCurrent(scope) || generation !== streamGeneration || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
      if (connected) {
        cancelSyncRecovery(set)
        set({
          liveConnected: true,
          syncSessionId: sessionId,
          syncStatus: 'live',
          syncError: null,
          lastTimelineSyncAt: Date.now(),
        })
      } else if (detail?.fatal) {
        const message = detail.error.message || `Live updates closed (${detail.code}).`
        if (detail.code === 4401) {
          scope.client.revokeValidation()
          set(emptyAgentRouteState())
        }
        cancelSyncRecovery(set)
        stopSelectedStream()
        set(state => ({
          liveConnected: false,
          syncSessionId: sessionId,
          syncStatus: 'error',
          syncError: message,
          error: message,
          ...(detail.code === 4401 ? {
            connected: false,
            profiles: updateProfileRuntime(state.profiles, scope.profileId, { connectionState: 'offline', lastConnectionError: message, lastConnectionCheckedAt: Date.now() }),
          } : {}),
        }))
        if (detail.code === 4404) void get().refreshSessions()
      } else {
        set({ liveConnected: false, syncSessionId: sessionId, syncStatus: 'reconnecting' })
      }
    },
    event => {
      if (
        !connectionIsCurrent(scope)
        || generation !== streamGeneration
        || epoch !== selectionEpoch
        || get().selectedSessionId !== sessionId
        || event.session_id !== sessionId
        || event.backend !== 'claude'
        || event.runtime !== 'context_usage'
      ) return
      publishProviderRuntimeChanged({
        connection: scope.client,
        profileId: scope.profileId,
        profileGeneration: scope.generation,
        event,
      })
    },
  )
}

function hasSelectedStream(sessionId: string | null): boolean {
  return Boolean(sessionId && streamSessionId === sessionId && streamStop)
}

function queuedRunStatusMap(
  current: Record<string, QueuedRunStatus | undefined>,
  sessionId: string,
  status?: QueuedRunStatus,
): Record<string, QueuedRunStatus | undefined> {
  const next = { ...current }
  if (status) next[sessionId] = status
  else delete next[sessionId]
  return next
}

function isGoalSteerRejection(error: unknown, queuedId: string): boolean {
  if (!(error instanceof ServerError) || error.status !== 409) return false
  if (error.detail && typeof error.detail === 'object') {
    const detail = error.detail as { code?: unknown; guard?: unknown; queued_id?: unknown }
    return detail.code === 'force_send_blocked' && detail.guard === 'active_goal_requires_native_steer'
      && (detail.queued_id === undefined || detail.queued_id === queuedId)
  }
  // Match only the exact known refusal when detail is serialized as text.
  return error.detail === 'This follow-up cannot safely steer the active Codex goal. It remains queued; the goal was not paused.'
}

function queuedRunFailureStatus(queuedId: string, error: unknown, queueConfirmed: boolean, goalSteerRejected = false): QueuedRunStatus {
  const detail = errorMessage(error).trim()
  const genericInternalError = /^500(?:\s+internal server error)?$/i.test(detail)
  const summary = queueConfirmed
    ? 'Could not run this queued message now. It is still queued.'
    : 'Could not confirm whether this queued message started. Refresh the chat before retrying.'
  const message = genericInternalError ? `${summary} The server reported an internal error.` : `${summary} ${detail}`
  return {
    queued_id: queuedId,
    tone: 'error',
    message: goalSteerRejected
      ? `${message} If this message was queued before the app update, choose Edit, then Save to update this same queued message; then tap Steer. Do not resend it as a new message.`
      : message,
    ...(goalSteerRejected ? { goal_steer_rejected: true } : {}),
  }
}

function queuedRunDeliveryUncertain(error: unknown): boolean {
  if (!(error instanceof ServerError) || !error.detail || typeof error.detail !== 'object') return false
  const detail = error.detail as { code?: unknown; delivery_uncertain?: unknown }
  return detail.delivery_uncertain === true || detail.code === 'force_send_delivery_uncertain'
}

function queuedRunUncertainStatus(queuedId: string, error: unknown): QueuedRunStatus {
  const detail = errorMessage(error).trim()
  return {
    queued_id: queuedId,
    tone: 'error',
    delivery_uncertain: true,
    message: detail || 'Force Send delivery could not be confirmed. Refresh the chat before retrying.',
  }
}

function markQueuedRunAccepted(
  scope: ConnectionScope,
  sessionId: string,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  if (!connectionIsCurrent(scope)) return
  activityHealth.initialize(activityScope(scope), get().health)
  const health = activityHealth.admit(activityScope(scope), sessionId)
  set(state => {
    const active = new Set(state.activeSessionIds)
    active.add(sessionId)
    return {
      ...(health ? { health } : {}),
      activeSessionIds: active,
      queuedRunStatus: queuedRunStatusMap(state.queuedRunStatus, sessionId),
    }
  })
  if (get().selectedSessionId === sessionId) void get().syncSelectedSession('recovery')
}

function editableQueuedAgentOwner(turn: QueuedTurn | undefined, sessionId: string): string | null {
  if (!turn || !isAsyncQueuedChatMessage(turn) || turn.promoted
    || turn.session_id && turn.session_id !== sessionId
    || turn.target_session_id && turn.target_session_id !== sessionId
    || !turn.source_session_id || turn.source_session_id === sessionId
    || !turn.cross_chat_envelope_id
    || !Number.isSafeInteger(turn.message_revision) || (turn.message_revision ?? -1) < 0) return null
  return JSON.stringify([turn.queued_id, turn.cross_chat_envelope_id, turn.source_session_id, turn.target_session_id ?? sessionId])
}

function queuedUserEditIdentity(turn: QueuedTurn | undefined, sessionId: string): string | null {
  if (!turn || !isUserQueuedTurn(turn) || turn.promoted || turn.session_id && turn.session_id !== sessionId) return null
  return JSON.stringify([turn.queued_id, turn.session_id ?? sessionId, turn.backend ?? null, turn.model ?? null, turn.effort ?? null,
    turn.prompt, turn.display_prompt ?? null, turn.file_ids, turn.chat_references ?? [], turn.team_references ?? []])
}

async function queueAction(scope: ConnectionScope, sessionId: string, action: () => Promise<void>, set: (value: Partial<AppState>) => void, get: () => AppState): Promise<boolean> {
  const current = captureAgentRouteGuard(scope, get)
  try {
    if (!current()) return false
    await action()
    if (!current()) return false
    if (!await refreshSnapshotQueue(scope, sessionId, set, get, current)) return false
    if (get().selectedSessionId === sessionId) {
      void get().syncSelectedSession('recovery')
    }
    return true
  } catch (error) {
    if (!current() || isStaleConnectionError(error, scope)) return false
    await refreshSnapshotQueue(scope, sessionId, set, get, current).catch(() => null)
    if (!current()) return false
    set({ error: errorMessage(error) })
    return false
  }
}

async function refreshSnapshotQueue(
  scope: ConnectionScope,
  sessionId: string,
  set: (value: Partial<AppState>) => void,
  get: () => AppState,
  current = captureAgentRouteGuard(scope, get),
): Promise<QueuedTurn[] | null> {
  const queueState = queueReconciliationState(scope, sessionId, get)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current()) return null
    const revision = queueState.revision
    const before = get().snapshots[sessionId]?.queuedTurns
    const turns = await scope.client.queue(sessionId)
    if (!current()) return null
    // Never resurrect a delivered row or erase a new message with a read
    // overtaken by a stream packet or another successfully published read.
    if (queueState.revision !== revision || get().snapshots[sessionId]?.queuedTurns !== before) continue
    setSnapshotQueue(scope, sessionId, turns, set, get)
    return turns
  }
  throw new Error('The message queue changed while refreshing. Refresh the chat before retrying.')
}

function setSnapshotQueue(scope: ConnectionScope, sessionId: string, queuedTurns: QueuedTurn[], set: (value: Partial<AppState>) => void, get: () => AppState): void {
  if (!connectionIsCurrent(scope)) return
  const snapshot = get().snapshots[sessionId]
  if (!snapshot) return
  queueReconciliationState(scope, sessionId, get).commitSnapshot()
  const next = { ...snapshot, queuedTurns, cachedAt: Date.now() }
  set({
    snapshots: snapshotMapWith(get().snapshots, sessionId, next),
    queuedRunStatus: reconcileQueuedRunStatus(get().queuedRunStatus, sessionId, queuedTurns),
  })
  scheduleLiveSnapshotSave(scope, next, true)
}

function reconcileQueuedRunStatus(
  current: Record<string, QueuedRunStatus | undefined>,
  sessionId: string,
  queuedTurns: QueuedTurn[],
): Record<string, QueuedRunStatus | undefined> {
  const status = current[sessionId]
  if (
    !status
    || status.delivery_uncertain
    || queuedTurns.some(turn => turn.queued_id === status.queued_id)
  ) return current
  return queuedRunStatusMap(current, sessionId)
}

function queuedRunStatusForEvent(
  current: Record<string, QueuedRunStatus | undefined>,
  sessionId: string,
  queuedTurns: QueuedTurn[],
  event: Event,
): Record<string, QueuedRunStatus | undefined> {
  if (current[sessionId]?.delivery_uncertain
    && event.queued_id === current[sessionId]?.queued_id
    && (event.type === 'turn_started' || isNativeGoalSteerEvent(event))) {
    return queuedRunStatusMap(current, sessionId)
  }
  const reconciled = reconcileQueuedRunStatus(current, sessionId, queuedTurns)
  if (event.type !== 'turn_queue_paused' && event.type !== 'turn_queue_delivery_fenced') return reconciled
  const queuedId = event.queued_id
    || event.queued_ids?.find(id => queuedTurns.some(turn => turn.queued_id === id))
    || queuedTurns[0]?.queued_id
  if (!queuedId) return reconciled
  return queuedRunStatusMap(reconciled, sessionId, {
    queued_id: queuedId,
    tone: 'info',
    message: event.message?.trim() || (event.type === 'turn_queue_delivery_fenced'
      ? 'Force Send delivery is paused. Use Run now when you are ready to retry it.'
      : 'Queued messages were kept after the parent turn stopped. Use Run now to continue.'),
  })
}

async function refreshQueueAfterSparseSnapshot(
  scope: ConnectionScope,
  sessionId: string,
  set: (value: Partial<AppState>) => void,
  get: () => AppState,
): Promise<void> {
  const validationRevision = scope.client.validationRevision
  const key = JSON.stringify([scope.generation, validationRevision, get().health?.server_instance_id, sessionId])
  const previous = queueSnapshotRefreshInFlight.get(key)
  if (previous) { previous.dirty = true; return }
  const request = { dirty: false }
  const current = captureAgentRouteGuard(scope, get)
  queueSnapshotRefreshInFlight.set(key, request)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      request.dirty = false
      const queueState = queueReconciliationState(scope, sessionId, get)
      const revision = queueState.revision
      const before = get().snapshots[sessionId]?.queuedTurns
      const turns = await scope.client.queue(sessionId)
      if (!current() || get().selectedSessionId !== sessionId) return
      if (request.dirty || queueState.revision !== revision || get().snapshots[sessionId]?.queuedTurns !== before) request.dirty = true
      else {
        setSnapshotQueue(scope, sessionId, turns, set, get)
        return
      }
    }
    if (current()) throw new Error('The message queue is still changing. Refresh the chat to check its latest state.')
  } catch (error) {
    if (current() && !isStaleConnectionError(error, scope)) {
      set({ syncError: `Could not refresh the message queue: ${errorMessage(error)}` })
    }
  } finally {
    if (queueSnapshotRefreshInFlight.get(key) === request) queueSnapshotRefreshInFlight.delete(key)
  }
}

async function repairSelectedSnapshotFromCache(
  get: () => AppState,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
): Promise<void> {
  if (foregroundRepairInFlight) return foregroundRepairInFlight
  const scope = captureConnection()
  const repair = (async () => {
    const sessionId = get().selectedSessionId
    if (!sessionId || get().snapshots[sessionId]) return
    const cached = await loadSnapshot(scope.namespace, sessionId)
    if (!connectionIsCurrent(scope) || !cached || get().selectedSessionId !== sessionId || get().snapshots[sessionId]) return
    set(state => ({
      snapshots: snapshotMapWith(state.snapshots, sessionId, cached),
      syncSessionId: sessionId,
      syncStatus: state.connected ? 'cached' : 'offline',
      loadingSessionId: null,
    }))
  })()
  foregroundRepairInFlight = repair
  try { await repair }
  finally { if (foregroundRepairInFlight === repair) foregroundRepairInFlight = null }
}

function filesFromEvents(events: Event[]): AgentFile[] {
  return events.flatMap(event => [event.file, event.artifact].filter((value): value is AgentFile => Boolean(value)))
}

function mergeSessionState(
  incoming: Session[],
  current: Session[],
  read: SessionReadToken,
): Session[] {
  const currentById = new Map(current.map(value => [value.id, value]))
  const merged = incoming.map(value => {
    const previous = currentById.get(value.id)
    if (!previous) return value
    return sessionMutations.reconcileIncoming(previous, value, read)
  })
  return merged.length === current.length && merged.every((session, index) => session === current[index])
    ? current
    : merged
}

function mergeTurnResponseSession(incoming: Session, current: Session): Session {
  const preserveLatestEvent = (current.latest_event_seq ?? 0) > (incoming.latest_event_seq ?? 0)
  const preserveLatestAgentEvent = (current.latest_agent_event_seq ?? 0) > (incoming.latest_agent_event_seq ?? 0)
  return {
    ...current,
    ...incoming,
    ...(preserveLatestEvent ? {
      latest_event_seq: current.latest_event_seq,
      latest_event_at: current.latest_event_at,
      latest_event_type: current.latest_event_type,
    } : {}),
    ...(preserveLatestAgentEvent ? {
      latest_agent_event_seq: current.latest_agent_event_seq,
      latest_agent_event_at: current.latest_agent_event_at,
      latest_agent_event_type: current.latest_agent_event_type,
    } : {}),
  }
}

async function updateBadge(state: Pick<AppState, 'sessions' | 'profiles' | 'activeProfileId'>): Promise<void> {
  const count = unreadCount(state.sessions) + state.profiles
    .filter(profile => profile.id !== state.activeProfileId)
    .reduce((total, profile) => total + profile.cachedUnreadCount, 0)
  if (count === lastBadgeCount) return
  try {
    if (await Notifications.setBadgeCountAsync(count)) lastBadgeCount = count
  } catch { /* badges are best effort */ }
}

function requestNotificationPermissionOnce(): void {
  if (notificationPermissionRequested) return
  notificationPermissionRequested = true
  void Notifications.requestPermissionsAsync().catch(() => { /* unavailable in unsigned simulator builds */ })
}

async function notifyOnce(scope: ConnectionScope, session: Session, seq: number): Promise<void> {
  if (!connectionIsCurrent(scope)) return
  const key = `${scope.profileId}:${scope.namespace}:${session.id}:${seq}`
  if (notifiedEvents.has(key)) return
  notifiedEvents.add(key)
  if (notifiedEvents.size > 200) notifiedEvents.delete(notifiedEvents.values().next().value ?? '')
  try {
    await Notifications.scheduleNotificationAsync({ content: { title: session.title, body: 'New agent message', data: { profileId: scope.profileId, serverIdentity: scope.namespace, sessionId: session.id } }, trigger: null })
  } catch { /* permissions can be denied */ }
}
