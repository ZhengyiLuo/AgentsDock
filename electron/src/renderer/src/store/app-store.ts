import { create } from 'zustand'
import type {
  AgentCrossChatRoutesSnapshot, AgentFile, Backend, BootstrapPayload, ChatReference, ChatSyncStatus, CreateSessionInput, Event, ForwardedPort, Health, Job, NativeFileRef, QueuedTurn, TeamReference,
  ProfileBootstrapPayload, ProfileConnectionEvent, ProfileNotificationRoute, ProviderCommandSelection, PublicServerProfile, RuntimeCatalog, Session, SessionSnapshot,
  ServerForceRestartConfirmation, TimelinePage, UpdateServerProfilePatch, WorkspaceProfileScope
} from '@shared/types'
import { updateQueuedTurns as reduceQueuedTurns } from '@shared/queue'
import type { TeamHubScope } from '@shared/team-hub'
import { mailHintPending, type MailArrivalCursor, type MailboxCoverage, type MailHintProjection, type MailHintScope } from '@shared/team-mail-hints'
import { bulletinHintPending, type BulletinHintRefresh } from '@shared/team-bulletin-hints'
import { runtimeSelectionError, selectableChatBackends } from '@shared/runtime-catalog'
import { isAsyncCrossChatMessage, isNativeGoalSteerEvent, isNativeSteerTransitionStop, timelineSemanticUnits } from '@shared/semantic-timeline'
import { turnSendErrorMessage } from '@shared/server-errors'
import { completedPrefixForkAvailable, RUNNING_FORK_UNAVAILABLE } from '@shared/session-fork'
import { agentFileBelongsToSession, isolateSessionEvent, isolateSessionSnapshot } from '@shared/session-files'
import { isImportedClaudeControlCompanion, isImportedCodexRuntimeContext, isImportedHistoryRecord, isImportedProviderControlMetadata, isImportedProviderInterruption, mergeProviderInterruptionEvent } from '@shared/provider-origin'
import { trackEvent } from '../lib/analytics'
import { nudgeChatFontSize, setChatFontFamily, setChatFontSize } from '../lib/chat-font'
import { activeEmergencyAlert } from '../lib/emergency-alert'
import { isUntouchedNewChat, navigableSessions } from '../lib/sessions'
import { isAgentVisibleEvent } from '../lib/timeline'
import {
  AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY,
  ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY,
  agentCrossChatRoutesAvailable,
  asyncChatRouteAvailable,
  crossChatHandoffsAvailable,
  MAX_CHAT_REFERENCES,
  routeHintMentionsAvailable,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences
} from '../lib/chat-references'
import {
  cancelPendingSteering,
  isSteeringCancellation,
  steerQueuedTurn,
  type SteeringScope
} from '../lib/queue-actions'
import { parseStoredTeamReferences, teamMessagesAvailable, validComposerReferences } from '../lib/team-references'
import { adjacentServerProfileId } from '../lib/server-navigation'
import { captureWorkspaceScope, getWorkspacePreference, setWorkspacePreference } from '../lib/workspace-preferences'
import {
  closeChatPane as closeChatPaneLayout,
  focusedChatSessionId,
  reconcileChatPaneLayout,
  selectChatInPane,
  swapChatPanes as swapChatPaneLayout,
  visibleChatSessionIds,
  type ChatPane,
  type ChatPaneLayout,
  type ChatPanes
} from '../lib/chat-panes'

export type { ChatPane, ChatPanes } from '../lib/chat-panes'

const SEMANTIC_HISTORY_ITEM_LIMIT = 120
const LEGACY_HISTORY_EVENT_LIMIT = 480
const TIMELINE_CACHE_TIMEOUT_MS = 2_000
const PROFILE_REFRESH_TIMEOUT_MS = 45_000
const PROFILE_RECOVERY_TIMEOUT_MS = 3_000
const MAX_BUFFERED_MAIL_HINT_SCOPES = 8
const bufferedMailHints = new Map<string, MailHintProjection>()

interface ModalState {
  settings: boolean
  appSettings?: boolean
  newChat: boolean
  resume: boolean
  folder: boolean
  digest: boolean
  job: boolean
  search: boolean
  review: boolean
  importChats: boolean
}

interface SendPromptOptions {
  consumeComposer?: boolean
  admissionToken?: string
  chatReferences?: ChatReference[]
  teamReferences?: TeamReference[]
  skillSelection?: ProviderCommandSelection
  confirmSteer?: () => boolean
}

interface SessionSyncState {
  status: ChatSyncStatus
  error: string | null
}

interface StoredChatPaneLayout {
  primary?: string | null
  secondary?: string | null
  focusedPane?: ChatPane
}

interface RendererProfileScope {
  profileId: string | null
  profileGeneration: number
  switchEpoch: number
}

interface PendingNamespaceAdoption extends RendererProfileScope {
  canonicalProfiles: PublicServerProfile[]
}

interface StartupChatCleanup {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  sessionIds: ReadonlySet<string>
}

interface DirectChatPlaceholderMarker {
  version: 1
  fingerprint: string
}

interface WorkspaceTransition {
  readonly id: number
  readonly promise: Promise<void>
  readonly finish: () => void
  readonly cancel: () => void
  follow(promise: Promise<unknown>): void
}

interface DraftFlushDetail {
  pending: Promise<unknown>[]
  promises: Promise<unknown>[]
  waitUntil(promise: PromiseLike<unknown> | unknown): void
  add(promise: PromiseLike<unknown> | unknown): void
}

interface DeferredTimelineEventBatch {
  scope: RendererProfileScope
  events: Event[]
  overflowed?: boolean
}

interface LiveEventBatch extends DeferredTimelineEventBatch {
  sessionId: string
}

interface PendingLiveEventBatch extends LiveEventBatch {
  eventIndexById: Map<string, number>
}

interface AppState {
  initialized: boolean
  profiles: PublicServerProfile[]
  activeProfileId: string | null
  profileGeneration: number
  switchingProfileId: string | null
  mailHints: MailHintProjection | null
  connected: boolean
  connectionGeneration: number
  connectionError: string | null
  syncSessionId: string | null
  syncStatus: ChatSyncStatus
  syncError: string | null
  health: Health | null
  sessions: Session[]
  jobs: Job[]
  runtimeCatalog: RuntimeCatalog | null
  forwardedPorts: ForwardedPort[]
  forwardedPortsRevision: number
  chatPanes: ChatPanes
  focusedChatPane: ChatPane
  selectedSessionId: string | null
  snapshots: Record<string, SessionSnapshot>
  loadingSessionIds: Set<string>
  loadingSessionId: string | null
  syncBySession: Record<string, SessionSyncState>
  uploadsBySession: Record<string, AgentFile[]>
  uploadPathsBySession: Record<string, NativeFileRef[]>
  drafts: Record<string, string>
  chatReferencesBySession: Record<string, ChatReference[]>
  teamReferencesBySession: Record<string, TeamReference[]>
  agentRoutesBySession: Record<string, AgentCrossChatRoutesSnapshot>
  agentRouteLoadingSessionIds: Set<string>
  agentRouteErrorsBySession: Record<string, string | null>
  revokingAgentRouteIds: Set<string>
  folderOrder: string[]
  collapsedFolders: Set<string>
  archivedCollapsed: boolean
  inspectorVisible: boolean
  activeSessionIds: Set<string>
  turnAdmissionTokens: Record<string, string>
  stoppingSessionIds: Set<string>
  storageFull: boolean
  error: string | null
  creatingChat: boolean
  modals: ModalState

  initialize(): Promise<void>
  switchServer(profileId: string, force?: boolean, updatePatch?: UpdateServerProfilePatch): Promise<boolean>
  restartServer(
    expectedServerInstanceId: string,
    forceConfirmation?: ServerForceRestartConfirmation
  ): Promise<boolean>
  selectAdjacentServer(direction: 1 | -1): Promise<void>
  openNotificationRoute(route: ProfileNotificationRoute): Promise<boolean>
  selectSession(sessionId: string, force?: boolean): Promise<void>
  selectSessionInPane(sessionId: string, pane: ChatPane, force?: boolean, focus?: boolean): Promise<void>
  reloadSession(sessionId: string): Promise<void>
  openSessionInSplit(sessionId: string, force?: boolean): Promise<void>
  focusChatPane(pane: ChatPane): void
  closeChatPane(pane: ChatPane): void
  swapChatPanes(): void
  prefetchSession(sessionId: string): Promise<void>
  selectAdjacent(direction: 1 | -1): Promise<void>
  setDraft(text: string): void
  setDraftForSession(sessionId: string, text: string): void
  setChatReferencesForSession(sessionId: string, references: ChatReference[]): void
  setTeamReferencesForSession(sessionId: string, references: TeamReference[]): void
  refreshAgentRoutes(sessionId: string): Promise<AgentCrossChatRoutesSnapshot | null>
  revokeAgentRoute(sessionId: string, routeId: string, expectedRevision: string): Promise<boolean>
  beginTurnAdmission(sessionId: string): string | null
  endTurnAdmission(sessionId: string, token: string): void
  sendPrompt(promptOverride?: string, steer?: boolean, options?: SendPromptOptions): Promise<boolean>
  sendPromptForSession(sessionId: string, promptOverride?: string, steer?: boolean, options?: SendPromptOptions): Promise<boolean>
  stopTurn(): Promise<void>
  stopTurnForSession(sessionId: string): Promise<void>
  attachPaths(files: NativeFileRef[]): Promise<void>
  attachPathsForSession(sessionId: string, files: NativeFileRef[]): Promise<void>
  removeUpload(fileId: string): void
  removeUploadForSession(sessionId: string, fileId: string): void
  refreshSessions(): Promise<void>
  requestNewChat(): Promise<void>
  updateSession(
    sessionId: string,
    patch: Partial<Session>,
    options?: { allowDuringWorkspaceFlush?: boolean }
  ): Promise<void>
  deleteFolder(folder: string): Promise<void>
  forkSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<boolean>
  markRead(sessionId: string, force?: boolean): Promise<void>
  markUnread(sessionId: string): Promise<void>
  acknowledgeEmergency(sessionId: string, alertId: string): Promise<boolean>
  importHistory(sessionId: string): Promise<void>
  loadOlder(limit?: number): Promise<number>
  loadOlderForSession(sessionId: string, limit?: number): Promise<number>
  beginQueuedTurnsRequest(sessionId: string): number
  applyQueuedTurnsResponse(sessionId: string, request: number, turns: QueuedTurn[]): boolean
  setQueued(sessionId: string, turns: QueuedTurn[]): void
  toggleFolder(folder: string): void
  setFolderOrder(order: string[]): void
  setArchivedCollapsed(value: boolean): void
  setInspectorVisible(value: boolean): void
  setModal<K extends keyof ModalState>(key: K, value: boolean): void
  setError(error: string | null): void
}

const defaultModals: ModalState = { settings: false, appSettings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
export const NEW_CHAT_DEFAULTS_PREFERENCE_KEY = 'newChatDefaults:v1'
const DIRECT_CHAT_PLACEHOLDER_PREFERENCE_PREFIX = 'directChatPlaceholder:v1:'

export interface NewChatDefaults {
  version: 1
  folder: string
  cwd: string
  backend: Backend
  codex_provider?: CreateSessionInput['codex_provider']
  model: string | null
  effort: string | null
}

function normalizedNewChatDefaults(input: Pick<CreateSessionInput, 'folder' | 'cwd' | 'backend' | 'codex_provider' | 'model' | 'effort'>): NewChatDefaults {
  return {
    version: 1,
    folder: input.folder.trim() || 'General',
    cwd: input.cwd.trim(),
    backend: input.backend,
    ...(input.backend === 'codex' && input.codex_provider === 'custom' ? { codex_provider: 'custom' as const } : {}),
    model: input.model?.trim() || null,
    effort: input.effort?.trim() || null
  }
}

function parseNewChatDefaults(value: unknown): NewChatDefaults | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<NewChatDefaults>
  if (
    candidate.version !== 1
    || !['claude', 'codex', 'cursor'].includes(String(candidate.backend))
    || candidate.codex_provider !== undefined && !['default', 'custom'].includes(candidate.codex_provider)
    || typeof candidate.folder !== 'string'
    || typeof candidate.cwd !== 'string'
    || candidate.model !== null && typeof candidate.model !== 'string'
    || candidate.effort !== null && typeof candidate.effort !== 'string'
  ) return null
  return normalizedNewChatDefaults(candidate as NewChatDefaults)
}

function newestAvailableSession(sessions: Session[]): Session | null {
  const available = sessions.filter(session => !session.archived)
  return available.reduce<Session | null>((newest, session) => {
    if (!newest) return session
    const sessionCreated = Date.parse(session.created_at ?? '')
    const newestCreated = Date.parse(newest.created_at ?? '')
    if (Number.isFinite(sessionCreated) && (!Number.isFinite(newestCreated) || sessionCreated > newestCreated)) return session
    return newest
  }, null)
}

function sessionNewChatDefaults(session: Session, defaultCwd: string): NewChatDefaults {
  return normalizedNewChatDefaults({
    folder: session.folder || 'General',
    cwd: session.cwd || defaultCwd,
    backend: session.backend,
    codex_provider: session.codex_provider,
    model: session.model,
    effort: session.effort
  })
}

export function saveNewChatDefaults(scope: WorkspaceProfileScope | null, input: Pick<CreateSessionInput, 'folder' | 'cwd' | 'backend' | 'codex_provider' | 'model' | 'effort'>): Promise<void> {
  try {
    return setWorkspacePreference(scope, NEW_CHAT_DEFAULTS_PREFERENCE_KEY, normalizedNewChatDefaults(input))
  } catch (error) {
    return Promise.reject(error)
  }
}

function directChatPlaceholderKey(sessionId: string): string {
  return `${DIRECT_CHAT_PLACEHOLDER_PREFERENCE_PREFIX}${sessionId}`
}

function directChatPlaceholderFingerprint(session: Session): string {
  return JSON.stringify({
    createdAt: session.created_at ?? null,
    title: session.title,
    folder: session.folder?.trim() || 'General',
    cwd: session.cwd?.trim() || '',
    backend: session.backend,
    ...(session.backend === 'codex' && session.codex_provider === 'custom' ? { codexProvider: 'custom' } : {}),
    model: session.model?.trim() || null,
    effort: session.effort?.trim() || null,
    systemPrompt: session.system_prompt ?? null,
    codexApprovalPolicy: session.codex_approval_policy ?? null,
    codexSandboxMode: session.codex_sandbox_mode ?? null,
    codexPermissionProfile: session.codex_permission_profile ?? null,
    codexApprovalsReviewer: session.codex_approvals_reviewer ?? null,
    claudePermissionMode: session.claude_permission_mode ?? null,
    cursorPermissionMode: session.cursor_permission_mode ?? null,
    providerJobsAccess: session.provider_jobs_access ?? null
  })
}

function directChatPlaceholderMarker(session: Session): DirectChatPlaceholderMarker {
  return { version: 1, fingerprint: directChatPlaceholderFingerprint(session) }
}

function isDirectChatPlaceholderMarker(value: unknown): value is DirectChatPlaceholderMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Partial<DirectChatPlaceholderMarker>
  return marker.version === 1 && typeof marker.fingerprint === 'string'
}

function directChatPlaceholderMarkerMatches(value: unknown, session: Session): boolean {
  return isDirectChatPlaceholderMarker(value)
    && value.fingerprint === directChatPlaceholderFingerprint(session)
}

const MINIMUM_AGENT_API_CONTRACT = 8
let unsubscribers: Array<() => void> = []
const olderLoads = new Map<string, Promise<number>>()
const prefetchLoads = new Map<string, Promise<void>>()
const snapshotAccess = new Map<string, number>()
const pendingLiveEvents = new Map<string, PendingLiveEventBatch>()
interface LiveActivityHint { active: boolean; runId?: string | null }
const liveEventActivityHints = new WeakMap<Event, LiveActivityHint>()
const liveEventActivityEpochs = new WeakMap<Event, number>()
let liveActivityAuthorityEpoch = 0
const timelineDeferredEvents = new Map<string, DeferredTimelineEventBatch>()
const queuedTurnsRequestLeases = new Map<string, number>()
const readStateMutationLeases = new Map<string, number>()
const readStateMutationQueues = new Map<string, Promise<void>>()
const MAX_MEMORY_SNAPSHOTS = 14
const MAX_BACKGROUND_SNAPSHOT_EVENTS = 1_440
const MAX_DEFERRED_TIMELINE_EVENTS = 2_400
const TIMELINE_REPAIR_INITIAL_BACKOFF_MS = 250
const TIMELINE_REPAIR_MAX_BACKOFF_MS = 30_000
const LIVE_EVENT_BATCH_MS = 40
// A live provider can publish several timeline events between consecutive
// keystrokes. Committing every batch through an external store makes React do
// non-interruptible timeline work just before the next key arrives. Give
// typing, xterm input, and wheel gestures a real quiet window. Ordinary
// lifecycle and queue updates stay buffered too: forcing them through a few
// hundred milliseconds into continuous input was the source of periodic
// keystroke and scroll stalls. Only an emergency alert may interrupt input.
// The pending buffer retains a hard bound so correctness never depends on the
// browser becoming idle forever.
const LIVE_EVENT_INTERACTION_QUIET_MS = 1_000
const LIVE_EVENT_MAX_DEFERRED_COUNT = 512
const CROSS_CHAT_QUEUE_REFRESH_RETRY_DELAYS_MS = [150, 600] as const
const CROSS_CHAT_QUEUE_REFRESH_RECOVERY_COOLDOWN_MS = 5_000
const CROSS_CHAT_QUEUE_REFRESH_ERROR = 'Incoming delivery queue could not be refreshed. Queue actions may be stale; AgentsDock will retry after the next live update or reconnect.'
const WEBSOCKET_RUNTIME_ERROR = 'AgentsServer is missing WebSocket support. Update or reinstall the server to restore live chat.'
let snapshotAccessCounter = 0
let liveEventTimer: number | null = null
let pendingLiveEventCount = 0
let lastLatencySensitiveInteractionAt = Number.NEGATIVE_INFINITY
let initializationInFlight = false
let selectionEpoch = 0
let profileSwitchEpoch = 0
let profileSwitchIntent = 0
let notificationRouteIntent = 0
let pendingSessionPatchVersion = 0
let pendingNamespaceAdoption: PendingNamespaceAdoption | null = null
let workspaceTransitionCounter = 0
let turnAdmissionCounter = 0
let agentRouteRefreshCounter = 0
let agentRouteMutationCounter = 0
let queuedTurnsRequestCounter = 0
let readStateMutationCounter = 0
let timelineRepairTimerSequence = 0
let timelineRepairLeaseSequence = 0
let activeWorkspaceTransition: WorkspaceTransition | null = null
const profileRefreshes = new Map<string, Promise<void>>()
const pendingSessionPatches = new Map<string, { version: number; patch: Partial<Session> }>()
const selectionLeases = new Map<string, number>()
const timelineSubscriptions = new Set<string>()
interface TimelineRepairLease {
  token: number
  scope: RendererProfileScope
  attempts: number
  timer: number | null
  loading: boolean
}
const timelineRepairs = new Map<string, TimelineRepairLease>()
const agentRouteRefreshTokens = new Map<string, number>()
const agentRouteMutationTokens = new Map<string, number>()
const pendingCrossChatQueueRefreshes = new Map<string, { scope: RendererProfileScope; retryAfter: number }>()

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  profiles: [],
  activeProfileId: null,
  profileGeneration: 0,
  switchingProfileId: null,
  storageFull: false,
  mailHints: null,
  connected: false,
  connectionGeneration: 0,
  connectionError: null,
  syncSessionId: null,
  syncStatus: 'idle',
  syncError: null,
  health: null,
  sessions: [],
  jobs: [],
  runtimeCatalog: null,
  forwardedPorts: [],
  forwardedPortsRevision: 0,
  chatPanes: { primary: null, secondary: null },
  focusedChatPane: 'primary',
  selectedSessionId: null,
  snapshots: {},
  loadingSessionIds: new Set(),
  loadingSessionId: null,
  syncBySession: {},
  uploadsBySession: {},
  uploadPathsBySession: {},
  drafts: {},
  chatReferencesBySession: {},
  teamReferencesBySession: {},
  agentRoutesBySession: {},
  agentRouteLoadingSessionIds: new Set(),
  agentRouteErrorsBySession: {},
  revokingAgentRouteIds: new Set(),
  folderOrder: [],
  collapsedFolders: new Set(),
  archivedCollapsed: false,
  inspectorVisible: false,
  activeSessionIds: new Set(),
  turnAdmissionTokens: {},
  stoppingSessionIds: new Set(),
  error: null,
  creatingChat: false,
  modals: defaultModals,

  async initialize() {
    if (get().initialized || initializationInFlight) return
    pendingNamespaceAdoption = null
    if (!window.agentsDock) {
      set({ initialized: true, connected: false, syncStatus: 'offline', error: 'The secure Electron bridge did not load. See the AgentsDock startup log.' })
      return
    }
    const workspaceTransition = beginWorkspaceTransition()
    const scope = captureProfileScope(get())
    void window.agentsDock.native.log('bootstrap', 'initialize started')
    if (liveEventTimer != null) window.clearTimeout(liveEventTimer)
    liveEventTimer = null
    pendingLiveEventCount = 0
    lastLatencySensitiveInteractionAt = Number.NEGATIVE_INFINITY
    pendingLiveEvents.clear()
    queuedTurnsRequestLeases.clear()
    for (const unsubscribe of unsubscribers) unsubscribe()
    bufferedMailHints.clear()
    // The main process starts its health refresh concurrently with this
    // cached bootstrap. A connection event can therefore arrive before the
    // bootstrap establishes the renderer's active profile, or after the
    // cache payload was captured but before it is applied. Retain only the
    // newest event for each exact profile generation and replay the matching
    // one once; never carry connection state across a profile boundary.
    const bootstrapConnections = new Map<string, ProfileConnectionEvent>()
    let bufferingBootstrapConnections = true
    const bootstrapConnectionKey = (payload: Pick<ProfileConnectionEvent, 'profileId' | 'profileGeneration'>): string => (
      `${payload.profileId}:${payload.profileGeneration}`
    )
    const handleServerConnection = (payload: ProfileConnectionEvent): void => {
      if (bufferingBootstrapConnections) {
        const key = bootstrapConnectionKey(payload)
        const previous = bootstrapConnections.get(key)
        bootstrapConnections.set(key, !payload.health && previous?.health
          ? { ...payload, health: previous.health }
          : payload)
      }
      if (!profileEventMatches(payload, get())) return
      // Explicit main-process Health already reconciles events that arrived
      // during its request. Pending transcript batches must not apply their
      // older activity hints afterward. Do not flush heavy rendering here.
      if (payload.health) liveActivityAuthorityEpoch += 1
      const version = payload.health?.api_contract_version ?? MINIMUM_AGENT_API_CONTRACT
      const incompatible = version < MINIMUM_AGENT_API_CONTRACT
      const error = incompatible ? `Server upgrade required: this app needs agent API v${MINIMUM_AGENT_API_CONTRACT}, but the server reports v${version}.` : payload.error ?? null
      const current = get()
      const connected = payload.connected && !incompatible
      const incomingHealth = payload.health ?? current.health
      // Preserve the prior reference when a reconnect heartbeat carries the
      // same contract. Several heavyweight surfaces intentionally subscribe
      // to Health; replacing it with an equivalent object still makes every
      // selector and hidden control rerender.
      const health = jsonEquivalent(current.health, incomingHealth)
        ? current.health
        : incomingHealth
      const previousServerInstanceId = current.health?.server_instance_id ?? null
      const nextServerInstanceId = health?.server_instance_id ?? null
      const serverInstanceChanged = previousServerInstanceId !== nextServerInstanceId
      const connectionBoundary = connected !== current.connected || serverInstanceChanged
      if (connectionBoundary) {
        agentRouteRefreshTokens.clear()
        agentRouteMutationTokens.clear()
        queuedTurnsRequestLeases.clear()
      }
      const websocketUnavailable = health?.websocket_runtime === false
      const websocketError = websocketUnavailable ? WEBSOCKET_RUNTIME_ERROR : null
      // A connection-only notice carries no new activity evidence. Reusing
      // cached Health here used to erase a newer streamed turn_started.
      const incomingActiveSessionIds = payload.health
        ? healthActiveSessionIDs(health)
        : current.activeSessionIds
      const syncStatus = websocketUnavailable && current.selectedSessionId
        ? 'error'
        : !connected && current.selectedSessionId
        ? 'offline'
        : connected && current.syncStatus === 'offline'
          ? 'syncing'
          : current.syncStatus
      const syncError = websocketError ?? (connected ? null : error)
      set(state => {
        const visible = visibleChatSessionIds(state.chatPanes)
        let syncBySession = state.syncBySession
        for (const sessionId of visible) {
          const previous = state.syncBySession[sessionId]
          const queueRefreshPending = pendingCrossChatQueueRefreshes.has(sessionId)
          const status: ChatSyncStatus = websocketUnavailable
            ? 'error'
            : !connected
              ? 'offline'
              : previous?.status === 'offline'
                ? 'syncing'
                : previous?.status ?? (state.snapshots[sessionId] ? 'cached' : 'syncing')
          const authoritativeError = websocketError ?? (connected ? null : error)
          const nextSync = {
            status,
            error: authoritativeError ?? (queueRefreshPending ? CROSS_CHAT_QUEUE_REFRESH_ERROR : null)
          }
          if (previous?.status === nextSync.status && previous.error === nextSync.error) continue
          if (syncBySession === state.syncBySession) syncBySession = { ...state.syncBySession }
          syncBySession[sessionId] = nextSync
        }
        const focusedSync = state.selectedSessionId ? syncBySession[state.selectedSessionId] : undefined
        const activeSessionIds = stringSetsEqual(state.activeSessionIds, incomingActiveSessionIds)
          ? state.activeSessionIds
          : incomingActiveSessionIds
        const nextSyncStatus = focusedSync?.status ?? syncStatus
        const nextSyncError = focusedSync?.error ?? syncError
        if (
          !connectionBoundary
          && state.connected === connected
          && state.health === health
          && state.connectionError === error
          && state.activeSessionIds === activeSessionIds
          && state.syncStatus === nextSyncStatus
          && state.syncError === nextSyncError
          && state.syncBySession === syncBySession
        ) return state
        return {
          connected,
          connectionGeneration: connectionBoundary ? state.connectionGeneration + 1 : state.connectionGeneration,
          health,
          connectionError: error,
          activeSessionIds,
          syncStatus: nextSyncStatus,
          syncError: nextSyncError,
          syncBySession,
          ...(connectionBoundary ? {
            agentRoutesBySession: {},
            agentRouteLoadingSessionIds: new Set<string>(),
            agentRouteErrorsBySession: {},
            revokingAgentRouteIds: new Set<string>()
          } : {})
        }
      })
      if (incompatible && get().error !== error) set({ error })
      if (connected && (!current.connected || serverInstanceChanged)) {
        const repairScope = captureProfileScope(get())
        for (const [sessionId, snapshot] of Object.entries(get().snapshots)) {
          if (!snapshot.historyDiscontinuity) continue
          cancelTimelineRepair(sessionId)
          scheduleTimelineRepair(sessionId, repairScope)
        }
        for (const sessionId of visibleChatSessionIds(get().chatPanes)) {
          void get().refreshAgentRoutes(sessionId)
        }
        retryPendingCrossChatQueueRefreshes('connection')
      }
    }
    unsubscribers = [
      installLatencySensitiveInteractionTracking(),
      window.agentsDock.events.on('app:storage', payload => { if (payload.full) set({ storageFull: true }) }),
      window.agentsDock.events.on('team:mail-hints', payload => {
        const current = get()
        if (bufferingBootstrapConnections || current.switchingProfileId
          || !current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity) {
          bufferMailHintProjection(payload)
        }
        if (current.switchingProfileId) return
        const mailHints = mergeMailHintProjections(current, current.mailHints, payload)
        if (mailHints !== current.mailHints) set({ mailHints })
      }),
      window.agentsDock.events.on('server:connection', handleServerConnection),
      window.agentsDock.events.on('server:sync', payload => {
        const current = get()
        if (!profileEventMatches(payload, current)) return
        if (!visibleChatSessionIds(current.chatPanes).includes(payload.sessionId)) return
        const compatible = healthIsCompatible(current.health)
        const websocketUnavailable = current.health?.websocket_runtime === false
        const websocketError = websocketUnavailable ? WEBSOCKET_RUNTIME_ERROR : null
        const streamProvesConnected = payload.state === 'live' && compatible && !websocketUnavailable
        const connectionRestored = streamProvesConnected && !current.connected
        if (connectionRestored) {
          agentRouteRefreshTokens.clear()
          agentRouteMutationTokens.clear()
          queuedTurnsRequestLeases.clear()
        }
        const state = websocketUnavailable
          ? 'error'
          : !compatible
          ? 'offline'
          : !current.connected && payload.state !== 'idle' && payload.state !== 'live'
            ? 'offline'
            : payload.state
        set(currentState => {
          const previous = currentState.syncBySession[payload.sessionId]
          const queueRefreshPending = pendingCrossChatQueueRefreshes.has(payload.sessionId)
          const previousError = previous?.error === CROSS_CHAT_QUEUE_REFRESH_ERROR ? null : previous?.error ?? null
          const authoritativeError = websocketError
            ?? payload.error
            ?? (state === 'live' ? null : previousError)
          const error = authoritativeError ?? (queueRefreshPending ? CROSS_CHAT_QUEUE_REFRESH_ERROR : null)
          const focused = currentState.selectedSessionId === payload.sessionId
          const syncUnchanged = previous?.status === state && previous.error === error
          const connectionUnchanged = !streamProvesConnected || (
            currentState.connected
            && currentState.connectionError === null
          )
          const focusedAliasesUnchanged = !focused || (
            currentState.syncSessionId === payload.sessionId
            && currentState.syncStatus === state
            && currentState.syncError === error
          )
          if (!connectionRestored && syncUnchanged && connectionUnchanged && focusedAliasesUnchanged) {
            return currentState
          }
          return {
            connected: streamProvesConnected ? true : currentState.connected,
            connectionGeneration: connectionRestored
              ? currentState.connectionGeneration + 1
              : currentState.connectionGeneration,
            connectionError: streamProvesConnected ? null : currentState.connectionError,
            syncBySession: { ...currentState.syncBySession, [payload.sessionId]: { status: state, error } },
            ...(connectionRestored ? {
              agentRoutesBySession: {},
              agentRouteLoadingSessionIds: new Set<string>(),
              agentRouteErrorsBySession: {},
              revokingAgentRouteIds: new Set<string>()
            } : {}),
            ...(focused ? { syncSessionId: payload.sessionId, syncStatus: state, syncError: error } : {})
          }
        })
        if (connectionRestored) {
          for (const sessionId of visibleChatSessionIds(get().chatPanes)) void get().refreshAgentRoutes(sessionId)
          retryPendingCrossChatQueueRefreshes('connection')
        } else if (payload.state === 'live') {
          retryPendingCrossChatQueueRefreshes('live', [payload.sessionId])
        }
        if (streamProvesConnected && get().snapshots[payload.sessionId]?.historyDiscontinuity) {
          scheduleTimelineRepair(payload.sessionId, captureProfileScope(get()))
        }
      }),
      window.agentsDock.events.on('server:sessions', payload => {
        if (!profileEventMatches(payload, get())) return
        const incoming = payload.sessions
        const previousSessions = get().sessions
        const sessions = reconcileSessions(previousSessions, applyPendingSessionPatches(incoming))
        const previous = new Map(previousSessions.map(session => [session.id, session]))
        const beforeLayout = currentChatPaneLayout(get())
        set(state => {
          const layout = reconcileChatPaneLayout(
            currentChatPaneLayout(state),
            new Set(sessions.map(session => session.id)),
            state.selectedSessionId
          )
          const visible = visibleChatSessionIds(layout.panes)
          const snapshots = syncSnapshotSessions(pruneArchivedSnapshots(state.snapshots, sessions, visible), sessions)
          const emergencyFolders = new Set(
            sessions
              .filter(session => activeEmergencyAlert(session) && !session.archived && !session.pinned)
              .map(session => session.folder || 'General')
          )
          return {
            sessions,
            snapshots,
            collapsedFolders: new Set([...state.collapsedFolders].filter(folder => !emergencyFolders.has(folder))),
            archivedCollapsed: sessions.some(session => session.archived && activeEmergencyAlert(session)) ? false : state.archivedCollapsed,
            ...focusedPaneAliases(state, layout)
          }
        })
        const afterLayout = currentChatPaneLayout(get())
        if (!chatPaneLayoutsEqual(beforeLayout, afterLayout)) {
          persistChatPaneState(get())
          unsubscribeHiddenChatSessions(beforeLayout.panes, afterLayout.panes, captureProfileScope(get()))
        }
        updateBadge(sessions)
        for (const session of sessions) {
          const previousEmergency = activeEmergencyAlert(previous.get(session.id))
          const emergency = activeEmergencyAlert(session)
          const newEmergency = Boolean(emergency && emergency.id !== previousEmergency?.id)
          const before = previous.get(session.id)?.latest_agent_event_seq ?? 0
          const after = session.latest_agent_event_seq ?? 0
          const visible = visibleChatSessionIds(get().chatPanes).includes(session.id)
          if (newEmergency && (!document.hasFocus() || !visible)) {
            const current = get()
            const profile = current.profiles.find(candidate => candidate.id === current.activeProfileId)
            if (current.activeProfileId && emergency) void window.agentsDock.native.notify({
              title: `EMERGENCY · ${session.title}`,
              body: emergency.message,
              profileId: current.activeProfileId,
              serverIdentity: profile?.serverIdentity ?? null,
              sessionId: session.id,
              emergencyAlertId: emergency.id
            })
          } else if (
            after > before
            && session.latest_agent_event_type !== 'emergency_alert_raised'
            && !document.hasFocus()
          ) {
            const current = get()
            const profile = current.profiles.find(candidate => candidate.id === current.activeProfileId)
            if (current.activeProfileId) void window.agentsDock.native.notify({
              title: session.title,
              body: 'New agent message',
              profileId: current.activeProfileId,
              serverIdentity: profile?.serverIdentity ?? null,
              sessionId: session.id
            })
          }
        }
        if (!get().selectedSessionId) {
          const first = sessions.find(session => !session.archived)
          if (first) queueMicrotask(() => void get().selectSession(first.id))
        }
      }),
      window.agentsDock.events.on('server:jobs', payload => {
        if (profileEventMatches(payload, get())) set({ jobs: payload.jobs })
      }),
      window.agentsDock.events.on('server:runtime', payload => {
        if (profileEventMatches(payload, get())) set({ runtimeCatalog: payload.runtimeCatalog })
      }),
      window.agentsDock.events.on('ports:changed', payload => {
        const current = get()
        const changingToAnotherProfile = Boolean(
          current.switchingProfileId
          && current.switchingProfileId !== current.activeProfileId
        )
        if (
          !changingToAnotherProfile
          && payload.profileId === current.activeProfileId
          && payload.profileGeneration === current.profileGeneration
        ) {
          set(state => ({
            forwardedPorts: payload.ports,
            forwardedPortsRevision: state.forwardedPortsRevision + 1
          }))
        }
      }),
      window.agentsDock.events.on('server:profiles', payload => {
        const current = get()
        if (current.switchingProfileId || payload.activeProfileId !== current.activeProfileId || payload.profileGeneration < current.profileGeneration) return
        if (payload.profileGeneration !== current.profileGeneration) {
          clearProfileVolatileState()
          set({ profiles: payload.profiles, profileGeneration: payload.profileGeneration, mailHints: consumeBufferedMailHints({ ...current, profiles: payload.profiles, profileGeneration: payload.profileGeneration }, current.mailHints), forwardedPorts: [], forwardedPortsRevision: 0, loadingSessionIds: new Set(), loadingSessionId: null, syncBySession: {}, turnAdmissionTokens: {}, stoppingSessionIds: new Set() })
          queueMicrotask(() => void hydrateVisibleChatPanes(get))
        } else {
          const before = current.profiles.find(profile => profile.id === current.activeProfileId)
          const after = payload.profiles.find(profile => profile.id === current.activeProfileId)
          if (!(before?.serverIdentity ?? null) && after?.serverIdentity) {
            pendingNamespaceAdoption = { ...captureProfileScope(current), canonicalProfiles: payload.profiles }
            set({
              switchingProfileId: current.activeProfileId,
              profiles: payload.profiles.map(profile => profile.id === current.activeProfileId
                ? { ...profile, serverIdentity: before?.serverIdentity ?? null }
                : profile)
            })
            followWorkspaceRecovery(refreshProfileAfterBootstrap(current.activeProfileId!, current.profileGeneration, get, set, true))
          } else {
            set({ profiles: payload.profiles, mailHints: consumeBufferedMailHints({ ...current, profiles: payload.profiles }, current.mailHints) })
          }
        }
      }),
      window.agentsDock.events.on('server:files', payload => {
        if (!profileEventMatches(payload, get())) return
        const { sessionId, files, total } = payload
        set(state => {
        const snapshot = state.snapshots[sessionId]
        if (!snapshot) return state
        return { snapshots: cacheSnapshot(state.snapshots, sessionId, {
          ...snapshot,
          files: mergeFiles(snapshot.files, files),
          filesTotal: total
        }, visibleChatSessionIds(currentChatPaneLayout(state).panes)) }
        })
      }),
      window.agentsDock.events.on('server:timeline', payload => {
        if (!profileEventMatches(payload, get())) return
        const { sessionId, snapshot, source, mode } = payload
        const currentSnapshot = get().snapshots[sessionId]
        const discontinuity = mode === 'replace'
          && timelineReplacementIsDiscontinuous(currentSnapshot, snapshot)
        if (
          source === 'server'
          && (!currentSnapshot || !jsonEquivalent(currentSnapshot.queuedTurns, snapshot.queuedTurns))
        ) {
          invalidateQueuedTurnsRequests(sessionId)
        }
        set(state => {
          const incoming = mode === 'replace'
            ? replaceSnapshot(state.snapshots[sessionId], snapshot)
            : mergeSnapshots(state.snapshots[sessionId], snapshot)
          const loadingSessionIds = withoutSessionId(state.loadingSessionIds, sessionId)
          return {
            snapshots: cacheSnapshot(state.snapshots, sessionId, incoming, visibleChatSessionIds(currentChatPaneLayout(state).panes)),
            loadingSessionIds,
            loadingSessionId: focusedLoadingSessionId(state.selectedSessionId, loadingSessionIds)
          }
        })
        if (discontinuity) scheduleTimelineRepair(sessionId, captureProfileScope(get()))
      }),
      window.agentsDock.events.on('server:event', payload => {
        if (profileEventMatches(payload, get())) enqueueLiveEvent(payload.event,
          typeof payload.activeSession === 'boolean'
            ? { active: payload.activeSession, runId: payload.activeRunId }
            : undefined)
      }),
      window.agentsDock.events.on('native:notification', route => {
        void openProfileNotificationRoute(route, get).catch(error => get().setError(errorMessage(error)))
      }),
      window.agentsDock.events.on('native:menu', ({ command }) => handleMenuCommand(command, get, set))
    ]
    initializationInFlight = true
    try {
      let payload = await window.agentsDock.bootstrap()
      if (!profileScopeMatches(scope, get())) return
      void window.agentsDock.native.log('bootstrap', 'cache bootstrap returned', { sessions: payload.sessions.length, hasHealth: Boolean(payload.health) })
      const startupChatCleanup = startupChatCleanupFromBootstrap(payload)
      if (startupChatCleanup) {
        payload = await removeUntouchedStartupChats(
          payload,
          startupChatCleanup,
          () => profileScopeMatches(scope, get())
        )
      }
      if (!profileScopeMatches(scope, get())) return
      const selected = selectedSessionFromBootstrap(payload)
      const layout = await restoredChatPaneLayout(payload, selected)
      if (!profileScopeMatches(scope, get())) return
      set({
        ...workspaceStateFromBootstrap(payload, selected, true, layout),
        forwardedPorts: [],
        forwardedPortsRevision: 0
      })
      bufferingBootstrapConnections = false
      const bootstrapConnection = bootstrapConnections.get(bootstrapConnectionKey({
        profileId: payload.activeProfileId ?? '',
        profileGeneration: payload.profileGeneration ?? 0
      }))
      if (bootstrapConnection && profileEventMatches(bootstrapConnection, get())) {
        handleServerConnection(bootstrapConnection)
      }
      updateBadge(payload.sessions)
      if (payload.activeProfileId) workspaceTransition.follow(refreshProfileAfterBootstrap(payload.activeProfileId, payload.profileGeneration ?? 0, get, set))
      await hydrateVisibleChatPanes(get)
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return
      void window.agentsDock.native.log('bootstrap', 'initialize failed', { error: errorMessage(error) })
      set({ initialized: true, connected: false, syncStatus: 'offline', syncError: errorMessage(error), error: errorMessage(error) })
    } finally {
      bufferingBootstrapConnections = false
      bootstrapConnections.clear()
      workspaceTransition.finish()
      initializationInFlight = false
    }
  },

  async switchServer(profileId, force = false, updatePatch) {
    const current = get()
    if (!profileId) return false
    if (pendingNamespaceAdoption) {
      set({ error: 'AgentsDock is finishing server identity verification. Retry the switch in a moment.' })
      return false
    }
    if (!force && current.activeProfileId === profileId && !current.switchingProfileId) return true
    const workspaceTransition = beginWorkspaceTransition()
    const intent = ++profileSwitchIntent
    bufferedMailHints.clear()
    void window.agentsDock.native?.log?.('server-switch', 'switch requested', {
      fromProfileId: current.activeProfileId,
      toProfileId: profileId,
      force
    })
    pendingNamespaceAdoption = null
    set(state => ({
      switchingProfileId: profileId,
      creatingChat: false,
      turnAdmissionTokens: {},
      stoppingSessionIds: new Set(),
      error: null,
      modals: {
        ...state.modals,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false,
        importChats: false
      }
    }))
    try {
      await flushActiveWorkspace()
    } catch (error) {
      if (intent !== profileSwitchIntent) return false
      set({ switchingProfileId: null, mailHints: consumeBufferedMailHints({ ...get(), switchingProfileId: null }, get().mailHints), error: errorMessage(error) })
      throw error
    }
    if (intent !== profileSwitchIntent) return false

    const requestEpoch = ++profileSwitchEpoch
    try {
      const payload = updatePatch
        ? await window.agentsDock.servers.updateAndSwitch(profileId, updatePatch)
        : force
          ? await window.agentsDock.servers.switch(profileId, true)
          : await window.agentsDock.servers.switch(profileId)
      if (intent !== profileSwitchIntent || requestEpoch !== profileSwitchEpoch) return false
      const selected = selectedSessionFromBootstrap(payload)
      const layout = await restoredChatPaneLayout(payload, selected)
      if (intent !== profileSwitchIntent || requestEpoch !== profileSwitchEpoch) return false
      clearProfileVolatileState()
      set({
        ...workspaceStateFromBootstrap(payload, selected, true, layout),
        forwardedPorts: [],
        forwardedPortsRevision: 0
      })
      updateBadge(payload.sessions)
      workspaceTransition.follow(refreshProfileAfterBootstrap(payload.activeProfileId, payload.profileGeneration, get, set))
      await hydrateVisibleChatPanes(get)
      void window.agentsDock.native?.log?.('server-switch', 'switch completed', {
        profileId: payload.activeProfileId,
        profileGeneration: payload.profileGeneration
      })
      return true
    } catch (error) {
      if (intent === profileSwitchIntent && requestEpoch === profileSwitchEpoch) {
        void window.agentsDock.native?.log?.('server-switch', 'switch failed', {
          profileId,
          error: errorMessage(error)
        })
        set({ switchingProfileId: null, mailHints: consumeBufferedMailHints({ ...get(), switchingProfileId: null }, get().mailHints), error: errorMessage(error) })
        throw error
      }
      return false
    } finally {
      workspaceTransition.finish()
    }
  },

  async restartServer(expectedServerInstanceId, forceConfirmation) {
    const current = get()
    const scope = captureWorkspaceScope(current)
    if (!scope || !current.activeProfileId) {
      set({ error: 'The active server profile is still loading. Retry in a moment.' })
      return false
    }
    if (current.switchingProfileId) {
      set({ error: 'AgentsDock is already changing the active server connection.' })
      return false
    }
    if (!expectedServerInstanceId.trim()) {
      set({ error: 'AgentsDock could not verify the active server instance. Refresh Settings and try again.' })
      return false
    }

    const profileId = current.activeProfileId
    const workspaceTransition = beginWorkspaceTransition()
    const intent = ++profileSwitchIntent
    bufferedMailHints.clear()
    pendingNamespaceAdoption = null
    set(state => ({
      switchingProfileId: profileId,
      creatingChat: false,
      turnAdmissionTokens: {},
      stoppingSessionIds: new Set(),
      error: null,
      modals: {
        ...state.modals,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false,
        importChats: false
      }
    }))
    try {
      await flushActiveWorkspace()
    } catch (error) {
      workspaceTransition.finish()
      if (intent !== profileSwitchIntent) return false
      set({ switchingProfileId: null, mailHints: consumeBufferedMailHints({ ...get(), switchingProfileId: null }, get().mailHints), error: errorMessage(error) })
      throw error
    }
    if (intent !== profileSwitchIntent) {
      workspaceTransition.finish()
      return false
    }

    const requestEpoch = ++profileSwitchEpoch
    try {
      const payload = forceConfirmation
        ? await window.agentsDock.servers.restart(scope, expectedServerInstanceId, forceConfirmation)
        : await window.agentsDock.servers.restart(scope, expectedServerInstanceId)
      if (intent !== profileSwitchIntent || requestEpoch !== profileSwitchEpoch) return false
      clearProfileVolatileState()
      const selected = selectedSessionFromBootstrap(payload)
      const layout = await restoredChatPaneLayout(payload, selected)
      if (intent !== profileSwitchIntent || requestEpoch !== profileSwitchEpoch) return false
      set({
        ...workspaceStateFromBootstrap(payload, selected, true, layout),
        forwardedPorts: [],
        forwardedPortsRevision: 0
      })
      updateBadge(payload.sessions)
      workspaceTransition.follow(refreshProfileAfterBootstrap(payload.activeProfileId, payload.profileGeneration, get, set))
      await hydrateVisibleChatPanes(get)
      return true
    } catch (error) {
      if (intent === profileSwitchIntent && requestEpoch === profileSwitchEpoch) {
        set({ switchingProfileId: null, mailHints: consumeBufferedMailHints({ ...get(), switchingProfileId: null }, get().mailHints), error: errorMessage(error) })
        throw error
      }
      return false
    } finally {
      workspaceTransition.finish()
    }
  },

  async selectAdjacentServer(direction) {
    const state = get()
    if (state.switchingProfileId || Object.values(state.modals).some(Boolean)) return
    const target = adjacentServerProfileId(state.profiles, state.activeProfileId, direction)
    if (!target) return
    try { await state.switchServer(target) }
    catch (error) { get().setError(errorMessage(error)) }
  },

  openNotificationRoute(route) {
    return openProfileNotificationRoute(route, get)
  },

  async selectSession(sessionId, force = false) {
    const state = get()
    const pane = state.chatPanes.primary === sessionId
      ? 'primary'
      : state.chatPanes.secondary === sessionId
        ? 'secondary'
        : state.focusedChatPane
    await state.selectSessionInPane(sessionId, pane, force)
  },

  async selectSessionInPane(sessionId, pane, force = false, focus = true) {
    if (get().switchingProfileId || !get().sessions.some(session => session.id === sessionId)) return
    const scope = captureProfileScope(get())
    const beforeLayout = currentChatPaneLayout(get())
    const selectedLayout = selectChatInPane(beforeLayout, sessionId, pane)
    const layout = focus
      ? selectedLayout
      : { panes: selectedLayout.panes, focusedPane: beforeLayout.focusedPane }
    const previousSessionId = beforeLayout.panes[pane]
    const initialSnapshot = get().snapshots[sessionId]
    const panesChanged = layout.panes.primary !== beforeLayout.panes.primary
      || layout.panes.secondary !== beforeLayout.panes.secondary
    const focusChanged = layout.focusedPane !== beforeLayout.focusedPane
    const layoutChanged = panesChanged || focusChanged
    const newlyVisible = !visibleChatSessionIds(beforeLayout.panes).includes(sessionId)
    if (newlyVisible) trackEvent('chat_opened')

    if (panesChanged && previousSessionId && previousSessionId !== sessionId) {
      window.dispatchEvent(new CustomEvent('agentsdock:capture-timeline', { detail: { sessionId: previousSessionId } }))
    }
    if (layoutChanged) {
      set(state => {
        const visible = visibleChatSessionIds(layout.panes)
        let snapshots = pruneArchivedSnapshots(state.snapshots, state.sessions, visible)
        if (previousSessionId && !visible.includes(previousSessionId)) {
          const previousSnapshot = snapshots[previousSessionId]
          const compacted = previousSnapshot ? compactSnapshotEvents(previousSnapshot) : undefined
          if (compacted && compacted !== previousSnapshot) snapshots = { ...snapshots, [previousSessionId]: compacted }
        }
        return {
          ...focusedPaneAliases(state, layout),
          snapshots,
          error: null
        }
      })
      persistChatPaneState(get())
      if (panesChanged) unsubscribeHiddenChatSessions(beforeLayout.panes, layout.panes, scope)
    }

    if (!force && initialSnapshot && !snapshotNeedsAuthoritativeTail(initialSnapshot)) {
      touchSnapshot(sessionId)
      set(state => clearSessionLoading(state, sessionId))
      if (newlyVisible || !timelineSubscriptions.has(sessionId)) {
        const request = nextSelectionLease(sessionId)
        subscribeToTimeline(sessionId, initialSnapshot.events.at(-1)?.seq ?? 0, request, scope)
      }
      return
    }

    const request = nextSelectionLease(sessionId)
    logTimelineSelection('selection requested', { sessionId, pane, force, request, memoryCached: Boolean(initialSnapshot) })
    touchSnapshot(sessionId)
    const existing = get().snapshots[sessionId]
    if (existing && !force && !snapshotNeedsAuthoritativeTail(existing)) {
      set(state => clearSessionLoading(state, sessionId))
      subscribeToTimeline(sessionId, existing.events.at(-1)?.seq ?? 0, request, scope)
      logTimelineSelection('selection painted from memory', { sessionId, pane, request, events: existing.events.length })
      return
    }

    set(state => sessionLoadingAndSyncState(state, sessionId, state.connected ? 'syncing' : 'offline', null))
    let forceRemote = Boolean(existing)

    try {
      const cached = await withDeadline(
        window.agentsDock.timeline.cached(sessionId),
        TIMELINE_CACHE_TIMEOUT_MS,
        'Local timeline cache did not respond'
      )
      if (!selectionRequestMatches(request, sessionId, scope)) return
      if (cached && !forceRemote && !snapshotNeedsAuthoritativeTail(cached)) {
        set(state => ({
          ...clearSessionLoading(state, sessionId),
          snapshots: cacheSnapshot(
            state.snapshots,
            sessionId,
            mergeSnapshots(state.snapshots[sessionId], cached),
            visibleChatSessionIds(currentChatPaneLayout(state).panes)
          )
        }))
        subscribeToTimeline(sessionId, cached.events.at(-1)?.seq ?? 0, request, scope)
        logTimelineSelection('selection painted from disk cache', { sessionId, pane, request, events: cached.events.length })
        return
      }
      if (cached) {
        forceRemote = true
        logTimelineSelection('empty cache requires authoritative tail', {
          sessionId, pane, request, events: cached.events.length, eventsTotal: cached.eventsTotal,
          latestAgentSequence: cached.session.latest_agent_event_seq ?? 0
        })
      }
    } catch (error) {
      if (!selectionRequestMatches(request, sessionId, scope)) return
      logTimelineSelection('disk cache unavailable; opening from server', { sessionId, pane, request, error: errorMessage(error) })
    }

    if (!selectionRequestMatches(request, sessionId, scope)) return
    logTimelineSelection('cold timeline open started', { sessionId, pane, request })
    try {
      let snapshot = await window.agentsDock.timeline.open(sessionId, forceRemote)
      if (!selectionRequestMatches(request, sessionId, scope)) return
      const deferred = timelineDeferredEvents.get(sessionId)
      let deferredOverflowed = false
      if (deferred && profileScopesEqual(deferred.scope, scope)) {
        deferredOverflowed = deferred.overflowed === true
        let queuedTurns = snapshot.queuedTurns
        const files: AgentFile[] = []
        const events = deferred.events
          .map(event => isolateSessionEvent(event, sessionId))
          .filter((event): event is Event => Boolean(event))
        for (const event of events) {
          queuedTurns = reduceQueuedTurns(queuedTurns, event)
          if (event.file && agentFileBelongsToSession(event.file, sessionId)) files.push(event.file)
          if (event.artifact && agentFileBelongsToSession(event.artifact, sessionId)) files.push(event.artifact)
        }
        const mergedFiles = mergeFiles(snapshot.files, files)
        snapshot = {
          ...snapshot,
          events: mergeEvents(snapshot.events, events),
          queuedTurns,
          files: mergedFiles,
          filesTotal: Math.max(snapshot.filesTotal, mergedFiles.length)
        }
        timelineDeferredEvents.delete(sessionId)
      }
      timelineSubscriptions.add(sessionId)
      set(state => {
        const incoming = forceRemote
          ? replaceSnapshot(state.snapshots[sessionId], snapshot, true)
          : mergeSnapshots(state.snapshots[sessionId], snapshot)
        const accepted = deferredOverflowed ? { ...incoming, historyDiscontinuity: true } : incoming
        return {
          ...clearSessionLoading(state, sessionId),
          snapshots: cacheSnapshot(
            state.snapshots,
            sessionId,
            accepted,
            visibleChatSessionIds(currentChatPaneLayout(state).panes)
          )
        }
      })
      logTimelineSelection('cold timeline open completed', { sessionId, pane, request, events: snapshot.events.length })
    } catch (error) {
      if (!selectionRequestMatches(request, sessionId, scope)) return
      if (isSupersededTimelineSelection(error)) {
        // The main process abandoned this fetch because a newer selection for
        // the same chat took over (a second click, a reconnect re-selection).
        // The newer lease paints the chat; this is not a failure to report.
        logTimelineSelection('cold timeline open superseded', { sessionId, pane, request })
        set(state => clearSessionLoading(state, sessionId))
        return
      }
      logTimelineSelection('cold timeline open failed', { sessionId, pane, request, error: errorMessage(error) })
      set(state => {
        const snapshots = { ...state.snapshots }
        if (snapshotNeedsAuthoritativeTail(snapshots[sessionId]) && !snapshots[sessionId]?.historyDiscontinuity) {
          delete snapshots[sessionId]
        }
        const message = `Could not load this chat. ${errorMessage(error)}`
        const cleared = clearSessionLoading(state, sessionId)
        return {
          ...cleared,
          ...sessionSyncState(state, sessionId, state.connected ? 'error' : 'offline', message),
          snapshots,
          error: message
        }
      })
    }
  },

  async openSessionInSplit(sessionId, force = false) {
    const pane: ChatPane = get().chatPanes.primary ? 'secondary' : 'primary'
    await get().selectSessionInPane(sessionId, pane, force)
  },

  async reloadSession(sessionId) {
    const state = get()
    const pane: ChatPane | null = state.chatPanes.primary === sessionId
      ? 'primary'
      : state.chatPanes.secondary === sessionId
        ? 'secondary'
        : null
    if (!pane) return
    // Background continuity repair must not steal keyboard focus from the
    // other visible pane.
    await state.selectSessionInPane(sessionId, pane, true, false)
  },

  focusChatPane(pane) {
    const state = get()
    if (!state.chatPanes[pane] || state.focusedChatPane === pane) return
    const layout: ChatPaneLayout = { panes: state.chatPanes, focusedPane: pane }
    set(current => focusedPaneAliases(current, layout))
    persistChatPaneState(get())
  },

  closeChatPane(pane) {
    const state = get()
    const closingSessionId = state.chatPanes[pane]
    if (!closingSessionId) return
    const before = currentChatPaneLayout(state)
    const layout = closeChatPaneLayout(before, pane)
    set(current => focusedPaneAliases(current, layout))
    persistChatPaneState(get())
    unsubscribeHiddenChatSessions(before.panes, layout.panes, captureProfileScope(get()))
    if (!visibleChatSessionIds(layout.panes).includes(closingSessionId)) cancelTimelineRepair(closingSessionId)
  },

  swapChatPanes() {
    const state = get()
    const before = currentChatPaneLayout(state)
    const layout = swapChatPaneLayout(before)
    if (layout === before) return
    set(current => focusedPaneAliases(current, layout))
    persistChatPaneState(get())
  },

  async prefetchSession(sessionId) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    if (get().snapshots[sessionId]) { touchSnapshot(sessionId); return }
    if (get().sessions.find(session => session.id === sessionId)?.archived) return
    const existing = prefetchLoads.get(sessionId)
    if (existing) return existing
    let task!: Promise<void>
    task = (async () => {
      try {
        const snapshot = await window.agentsDock.timeline.cached(sessionId)
        if (!profileScopeMatches(scope, get()) || !snapshot || get().snapshots[sessionId]) return
        set(state => ({ snapshots: cacheSnapshot(
          state.snapshots,
          sessionId,
          snapshot,
          visibleChatSessionIds(currentChatPaneLayout(state).panes)
        ) }))
      } catch { /* prefetch is best effort */ }
      finally { if (prefetchLoads.get(sessionId) === task) prefetchLoads.delete(sessionId) }
    })()
    prefetchLoads.set(sessionId, task)
    return task
  },

  async selectAdjacent(direction) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    const visible = navigableSessions(get().sessions, get().folderOrder, get().collapsedFolders)
    if (!visible.length) return
    const current = visible.findIndex(session => session.id === get().selectedSessionId)
    const next = visible[(current + direction + visible.length) % visible.length]
    if (next && profileScopeMatches(scope, get())) await get().selectSession(next.id)
  },

  setDraft(text) {
    const id = get().selectedSessionId
    if (!id) return
    set(state => state.drafts[id] === text ? state : ({ drafts: { ...state.drafts, [id]: text } }))
  },
  setDraftForSession(sessionId, text) {
    set(state => state.drafts[sessionId] === text ? state : ({ drafts: { ...state.drafts, [sessionId]: text } }))
  },
  setChatReferencesForSession(sessionId, references) {
    set(state => state.chatReferencesBySession[sessionId] === references
      ? state
      : ({ chatReferencesBySession: { ...state.chatReferencesBySession, [sessionId]: references } }))
  },
  setTeamReferencesForSession(sessionId, references) {
    set(state => state.teamReferencesBySession[sessionId] === references
      ? state
      : ({ teamReferencesBySession: { ...state.teamReferencesBySession, [sessionId]: references } }))
  },

  async refreshAgentRoutes(sessionId) {
    const current = get()
    if (!agentCrossChatRoutesAvailable(current.health)) {
      set(state => {
        const agentRoutesBySession = { ...state.agentRoutesBySession }
        const agentRouteErrorsBySession = { ...state.agentRouteErrorsBySession }
        delete agentRoutesBySession[sessionId]
        delete agentRouteErrorsBySession[sessionId]
        return { agentRoutesBySession, agentRouteErrorsBySession }
      })
      return null
    }
    const scope = captureWorkspaceScope(current)
    if (!scope || current.switchingProfileId || !current.sessions.some(session => session.id === sessionId && !session.archived)) return null
    const requestKey = `${scope.profileId}:${scope.profileGeneration}:${scope.serverIdentity ?? ''}:${sessionId}`
    const refreshToken = ++agentRouteRefreshCounter
    agentRouteRefreshTokens.set(requestKey, refreshToken)
    set(state => {
      const agentRouteLoadingSessionIds = new Set(state.agentRouteLoadingSessionIds)
      agentRouteLoadingSessionIds.add(sessionId)
      return {
        agentRouteLoadingSessionIds,
        agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: null }
      }
    })
    try {
      const snapshot = await window.agentsDock.agentRoutes.list(scope, sessionId)
      if (!workspaceScopeMatches(scope, get()) || agentRouteRefreshTokens.get(requestKey) !== refreshToken) return null
      set(state => ({
        agentRoutesBySession: { ...state.agentRoutesBySession, [sessionId]: snapshot },
        agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: null }
      }))
      return snapshot
    } catch (error) {
      if (!workspaceScopeMatches(scope, get()) || agentRouteRefreshTokens.get(requestKey) !== refreshToken) return null
      set(state => ({
        agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: errorMessage(error) }
      }))
      return null
    } finally {
      if (agentRouteRefreshTokens.get(requestKey) === refreshToken) {
        agentRouteRefreshTokens.delete(requestKey)
        if (workspaceScopeMatches(scope, get())) set(state => {
          const agentRouteLoadingSessionIds = new Set(state.agentRouteLoadingSessionIds)
          agentRouteLoadingSessionIds.delete(sessionId)
          return { agentRouteLoadingSessionIds }
        })
      }
    }
  },

  async revokeAgentRoute(sessionId, routeId, expectedRevision) {
    const current = get()
    const scope = captureWorkspaceScope(current)
    if (!scope || current.switchingProfileId || !agentCrossChatRoutesAvailable(current.health)) return false
    const mutationKey = `${sessionId}:${routeId}`
    if (current.revokingAgentRouteIds.has(mutationKey)) return false
    const tokenKey = JSON.stringify([scope.profileId, scope.profileGeneration, scope.serverIdentity, sessionId, routeId])
    const mutationToken = ++agentRouteMutationCounter
    const connectionGeneration = current.connectionGeneration
    const connected = current.connected
    const serverInstanceId = current.health?.server_instance_id ?? null
    agentRouteMutationTokens.set(tokenKey, mutationToken)
    const mutationCurrent = (): boolean => {
      const state = get()
      return agentRouteMutationTokens.get(tokenKey) === mutationToken
        && workspaceScopeMatches(scope, state)
        && state.connectionGeneration === connectionGeneration
        && state.connected === connected
        && (state.health?.server_instance_id ?? null) === serverInstanceId
    }
    set(state => {
      const revokingAgentRouteIds = new Set(state.revokingAgentRouteIds)
      revokingAgentRouteIds.add(mutationKey)
      return {
        revokingAgentRouteIds,
        agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: null }
      }
    })
    try {
      const result = await window.agentsDock.agentRoutes.remove(scope, sessionId, routeId, expectedRevision)
      if (!mutationCurrent()) return false
      if (result.status === 'revision_conflict') {
        await get().refreshAgentRoutes(sessionId)
        if (mutationCurrent()) set(state => ({
          agentRouteErrorsBySession: {
            ...state.agentRouteErrorsBySession,
            [sessionId]: 'This grant changed on the server. The current grant was refreshed; review it before revoking again.'
          }
        }))
        return false
      }
      await get().refreshAgentRoutes(sessionId)
      return mutationCurrent()
    } catch (error) {
      if (!mutationCurrent()) return false
      const message = errorMessage(error)
      set(state => ({
        error: message,
        agentRouteErrorsBySession: { ...state.agentRouteErrorsBySession, [sessionId]: message }
      }))
      return false
    } finally {
      if (mutationCurrent()) set(state => {
        const revokingAgentRouteIds = new Set(state.revokingAgentRouteIds)
        revokingAgentRouteIds.delete(mutationKey)
        return { revokingAgentRouteIds }
      })
      if (agentRouteMutationTokens.get(tokenKey) === mutationToken) agentRouteMutationTokens.delete(tokenKey)
    }
  },

  beginTurnAdmission(sessionId) {
    const current = get()
    if (current.switchingProfileId || current.turnAdmissionTokens[sessionId]) return null
    const token = `${current.activeProfileId ?? 'local'}:${current.profileGeneration}:${++turnAdmissionCounter}`
    let admitted = false
    set(state => {
      if (state.switchingProfileId || state.turnAdmissionTokens[sessionId]) return state
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

  async sendPrompt(promptOverride, steer = false, options) {
    const sessionId = get().selectedSessionId
    if (!sessionId) return false
    return get().sendPromptForSession(sessionId, promptOverride, steer, options)
  },

  async sendPromptForSession(sessionId, promptOverride, steer = false, options) {
    if (get().switchingProfileId) return false
    const target = get().sessions.find(session => session.id === sessionId)
    if (!target || target.archived || !visibleChatSessionIds(currentChatPaneLayout(get()).panes).includes(sessionId)) return false
    const scope = captureProfileScope(get())
    const steeringScope = captureSteeringScope(sessionId, get())
    const rawPrompt = promptOverride ?? get().drafts[sessionId] ?? ''
    const leadingWhitespace = rawPrompt.length - rawPrompt.trimStart().length
    const prompt = rawPrompt.trim()
    const consumeComposer = options?.consumeComposer ?? true
    const requestedReferences = (consumeComposer
      ? options?.chatReferences ?? get().chatReferencesBySession[sessionId] ?? []
      : []).map(reference => ({
        ...reference,
        source_text_start: reference.source_text_start - leadingWhitespace,
        source_text_end: reference.source_text_end - leadingWhitespace
      }))
    const requestedTeamReferences = (consumeComposer
      ? options?.teamReferences ?? get().teamReferencesBySession[sessionId] ?? []
      : []).map(reference => ({
        ...reference,
        source_text_start: reference.source_text_start - leadingWhitespace,
        source_text_end: reference.source_text_end - leadingWhitespace
      }))
    if (requestedReferences.length > MAX_CHAT_REFERENCES) {
      set({ error: `A message can reference at most ${MAX_CHAT_REFERENCES} chats. Remove a chat reference and try again.` })
      return false
    }
    const validatedReferences = validComposerReferences(
      prompt,
      requestedReferences,
      requestedTeamReferences,
      (text, references) => validChatReferences(text, references, sessionId)
    )
    const chatReferences = validatedReferences.chatReferences
    const teamReferences = validatedReferences.teamReferences
    if (requestedReferences.length !== chatReferences.length) {
      set({ error: 'A chat reference was edited or is no longer valid. Remove it and select the chat again.' })
      return false
    }
    if (requestedTeamReferences.length !== teamReferences.length) {
      set({ error: 'A Team Network reference was edited or is no longer valid. Remove it and select the recipient again.' })
      return false
    }
    if (chatReferences.some(reference => reference.target_kind === 'secure_peer')) {
      set({ error: 'Remote agent routes cannot be used from @Chat. Remove this reference and use @@ Team Network Inbox for cross-server messages.' })
      return false
    }
    const routeSnapshot = get().agentRoutesBySession[sessionId]
    if (routeSnapshot) {
      const grantedTargetIds = new Set(routeSnapshot.routes.map(route => route.target_session_id))
      const pendingTargetIds = new Set(chatReferences.flatMap(reference => (
        reference.target_kind !== 'secure_peer'
        && reference.action === 'route'
        && reference.grant_intent === true
        && !grantedTargetIds.has(reference.session_id)
          ? [reference.session_id]
          : []
      )))
      if (routeSnapshot.max_routes !== null && routeSnapshot.routes.length + pendingTargetIds.size > routeSnapshot.max_routes) {
        set({ error: `This chat has reached its route access limit (${routeSnapshot.max_routes} ${routeSnapshot.max_routes === 1 ? 'route' : 'routes'} maximum). Revoke a granted route before adding another chat.` })
        return false
      }
    }
    if (chatReferences.length && !crossChatHandoffsAvailable(get().health)) {
      set({ error: 'Cross-chat handoffs require a newer AgentsServer. Update the active server and try again.' })
      return false
    }
    if (chatReferences.some(reference => reference.grant_intent === true) && !routeHintMentionsAvailable(get().health)) {
      set({ error: 'Durable @Chat grants require AgentsServer v7 in default-deny mode. Update the active server and try again.' })
      return false
    }
    if (teamReferences.length && !teamMessagesAvailable(get().health)) {
      set({ error: 'Team Network recipient hints require a newer AgentsServer. Update the active server and try again.' })
      return false
    }
    if (chatReferences.length) {
      const state = get()
      const source = state.sessions.find(candidate => candidate.id === sessionId)
      const actions = supportedCrossChatActions(state.health)
      const targetBackends = supportedCrossChatTargetBackends(state.health)
      const unsupported = chatReferences.some(reference => {
        if (reference.target_kind === 'secure_peer') {
          return reference.action === 'final_result'
            || !actions.includes(reference.action)
            || (reference.action === 'request_reply' && (!source || !targetBackends.includes(source.backend)))
        }
        const target = state.sessions.find(candidate => candidate.id === reference.session_id)
        return !actions.includes(reference.action)
          || !target
          || target.archived
          || !targetBackends.includes(target.backend)
          || (reference.action === 'request_reply' && (!source || !targetBackends.includes(source.backend)))
      })
      if (unsupported) {
        set({ error: 'This cross-chat action is not supported by the active server or one of the selected chats. Change or remove it and try again.' })
        return false
      }
    }
    const uploads = consumeComposer ? get().uploadsBySession[sessionId] ?? [] : []
    const uploadPaths = consumeComposer ? get().uploadPathsBySession[sessionId] ?? [] : []
    if ((!prompt && uploads.length === 0) || uploadPaths.length > 0) return false
    const currentTarget = get().sessions.find(session => session.id === sessionId)
    if (!currentTarget) {
      set({ error: 'The selected chat is no longer available.' })
      return false
    }
    const runtimeError = runtimeSelectionError(get().health, get().runtimeCatalog, currentTarget.backend, currentTarget.model, currentTarget.codex_provider, currentTarget.codex_provider_catalog)
    if (runtimeError) {
      set({ error: runtimeError })
      return false
    }
    const admissionToken = options?.admissionToken ?? get().beginTurnAdmission(sessionId)
    if (!admissionToken || get().turnAdmissionTokens[sessionId] !== admissionToken) return false
    const session = currentTarget
    const queuedBeforeSend = new Set((get().snapshots[sessionId]?.queuedTurns ?? []).map(turn => turn.queued_id))
    if (consumeComposer) {
      set(state => ({
        drafts: { ...state.drafts, [sessionId]: '' },
        chatReferencesBySession: { ...state.chatReferencesBySession, [sessionId]: [] },
        teamReferencesBySession: { ...state.teamReferencesBySession, [sessionId]: [] },
        uploadsBySession: { ...state.uploadsBySession, [sessionId]: [] },
        uploadPathsBySession: { ...state.uploadPathsBySession, [sessionId]: [] }
      }))
    }
    try {
      const response = await window.agentsDock.turns.send({
        sessionId,
        prompt,
        fileIds: uploads.map(file => file.id),
        model: session?.model,
        effort: session?.effort,
        clientCapabilities: interactiveClientCapabilities(session, get().health),
        chatReferences,
        teamReferences,
        ...(options?.skillSelection ? { skillSelection: options.skillSelection } : {})
      })
      if (!profileScopeMatches(scope, get())) return false
      if (response.event && eventAffectsQueuedTurns(response.event)) {
        invalidateQueuedTurnsRequests(sessionId)
      }
      set(state => {
        const snapshot = state.snapshots[sessionId]
        const nextEvents = response.event && snapshot ? upsertEvent(snapshot.events, response.event) : null
        const nextSnapshot = response.event && snapshot && nextEvents
          ? {
              ...snapshot,
              events: nextEvents,
              generation: nextTimelineGeneration(
                snapshot,
                nextEvents,
                nextEvents.length === snapshot.events.length + 1 && nextEvents.at(-1) === response.event
              ),
              queuedTurns: reduceQueuedTurns(snapshot.queuedTurns, response.event)
            }
          : null
        const [reconciledSession] = applyPendingSessionPatches([response.session])
        return {
          sessions: state.sessions.map(candidate => candidate.id === reconciledSession.id ? reconciledSession : candidate),
          activeSessionIds: response.event ? updateActiveSessions(state.activeSessionIds, response.event) : state.activeSessionIds,
          snapshots: nextSnapshot
            ? cacheSnapshot(state.snapshots, sessionId, nextSnapshot, visibleChatSessionIds(currentChatPaneLayout(state).panes))
            : state.snapshots
        }
      })
      const responseQueued = Boolean(response.queued || response.queued_id || response.event?.type === 'turn_queued')
      if (steer && responseQueued) {
        try {
          const queuedId = response.queued_id
            || response.event?.queued_id
            || await findNewQueuedTurn(sessionId, prompt, queuedBeforeSend, scope)
          if (!profileScopeMatches(scope, get())) return false
          if (!queuedId) throw new Error('The message was queued, but its queue ID could not be resolved for steering.')
          const request = get().beginQueuedTurnsRequest(sessionId)
          const turns = await steerQueuedTurn(steeringScope, queuedId, options?.confirmSteer)
          if (!profileScopeMatches(scope, get())) return false
          get().applyQueuedTurnsResponse(sessionId, request, turns)
        } catch (error) {
          if (!isSteeringCancellation(error) && profileScopeMatches(scope, get())) set({ error: errorMessage(error) })
        }
      }
      if (!profileScopeMatches(scope, get())) return false
      if (chatReferences.some(reference => reference.target_kind !== 'secure_peer' && reference.grant_intent === true)) {
        void get().refreshAgentRoutes(sessionId)
      }
      window.dispatchEvent(new CustomEvent('agentsdock:local-send', { detail: { sessionId } }))
      return true
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return false
      if (consumeComposer) {
        set(state => {
          const newerDraftExists = Boolean(state.drafts[sessionId]?.trim())
          return {
            drafts: { ...state.drafts, [sessionId]: newerDraftExists ? state.drafts[sessionId] : prompt },
            chatReferencesBySession: {
              ...state.chatReferencesBySession,
              [sessionId]: newerDraftExists ? state.chatReferencesBySession[sessionId] ?? [] : chatReferences
            },
            teamReferencesBySession: {
              ...state.teamReferencesBySession,
              [sessionId]: newerDraftExists ? state.teamReferencesBySession[sessionId] ?? [] : teamReferences
            },
            uploadsBySession: { ...state.uploadsBySession, [sessionId]: mergeFiles(state.uploadsBySession[sessionId] ?? [], uploads) },
            uploadPathsBySession: { ...state.uploadPathsBySession, [sessionId]: mergeUploadPaths(state.uploadPathsBySession[sessionId] ?? [], uploadPaths) },
            error: turnSendErrorMessage(error)
          }
        })
      } else {
        set({ error: turnSendErrorMessage(error) })
      }
      return false
    } finally {
      get().endTurnAdmission(sessionId, admissionToken)
    }
  },

  async stopTurn() {
    const id = get().selectedSessionId
    if (!id) return
    return get().stopTurnForSession(id)
  },

  async stopTurnForSession(id) {
    const current = get()
    if (current.switchingProfileId || current.stoppingSessionIds.has(id)) return
    const scope = captureProfileScope(current)
    set(state => {
      const stoppingSessionIds = new Set(state.stoppingSessionIds)
      stoppingSessionIds.add(id)
      return { stoppingSessionIds, error: null }
    })
    try {
      const result = await window.agentsDock.turns.stop(id)
      if (!profileScopeMatches(scope, get())) return
      set(state => {
        const stoppingSessionIds = new Set(state.stoppingSessionIds)
        stoppingSessionIds.delete(id)
        if (result.stopped) {
          const activeSessionIds = new Set(state.activeSessionIds)
          activeSessionIds.delete(id)
          return { activeSessionIds, stoppingSessionIds }
        }
        return {
          stoppingSessionIds,
          error: result.message?.trim() || (result.pending || result.deferred
            ? 'Stop is still pending. You can retry.'
            : 'The agent did not stop. You can retry.')
        }
      })
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return
      set(state => {
        const stoppingSessionIds = new Set(state.stoppingSessionIds)
        stoppingSessionIds.delete(id)
        return { stoppingSessionIds, error: errorMessage(error) }
      })
    }
  },

  async attachPaths(files) {
    const id = get().selectedSessionId
    if (!id) return
    return get().attachPathsForSession(id, files)
  },

  async attachPathsForSession(id, files) {
    const target = get().sessions.find(session => session.id === id)
    if (get().switchingProfileId || !files.length || !target || target.archived || !visibleChatSessionIds(currentChatPaneLayout(get()).panes).includes(id)) return
    const scope = captureProfileScope(get())
    set(state => ({ uploadPathsBySession: {
      ...state.uploadPathsBySession,
      [id]: [...(state.uploadPathsBySession[id] ?? []), ...files]
    } }))
    try {
      const uploaded = await window.agentsDock.files.upload(id, files.map(file => file.path))
      if (!profileScopeMatches(scope, get())) return
      set(state => {
        const snapshot = state.snapshots[id]
        const snapshotFiles = snapshot ? mergeFiles(snapshot.files, uploaded) : []
        return {
          uploadPathsBySession: {
            ...state.uploadPathsBySession,
            [id]: (state.uploadPathsBySession[id] ?? []).filter(file => !files.some(candidate => candidate.path === file.path))
          },
          uploadsBySession: {
            ...state.uploadsBySession,
            [id]: mergeFiles(state.uploadsBySession[id] ?? [], uploaded)
          },
          snapshots: snapshot ? cacheSnapshot(state.snapshots, id, {
            ...snapshot,
            files: snapshotFiles,
            filesTotal: Math.max(snapshot.filesTotal, snapshotFiles.length)
          }, visibleChatSessionIds(currentChatPaneLayout(state).panes)) : state.snapshots
        }
      })
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return
      set(state => ({
        uploadPathsBySession: {
          ...state.uploadPathsBySession,
          [id]: (state.uploadPathsBySession[id] ?? []).filter(file => !files.some(candidate => candidate.path === file.path))
        },
        error: errorMessage(error)
      }))
    }
  },

  removeUpload(fileId) {
    const id = get().selectedSessionId
    if (!id) return
    get().removeUploadForSession(id, fileId)
  },
  removeUploadForSession(id, fileId) {
    set(state => ({ uploadsBySession: {
      ...state.uploadsBySession,
      [id]: (state.uploadsBySession[id] ?? []).filter(file => file.id !== fileId)
    } }))
  },
  async refreshSessions() {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    try {
      const incoming = applyPendingSessionPatches(await window.agentsDock.sessions.list())
      if (!profileScopeMatches(scope, get())) return
      set(state => {
        const sessions = reconcileSessions(state.sessions, incoming)
        return sessions === state.sessions ? state : { sessions }
      })
      // The sidebar refresh is the single full refresh: after the list is
      // reconciled, re-pull the history of every open chat pane too (this is
      // what the removed per-chat header refresh used to do).
      const { chatPanes } = get()
      const openPanes = [chatPanes.primary, chatPanes.secondary].filter((id): id is string => Boolean(id))
      await Promise.all(openPanes.map(id => get().reloadSession(id)))
    } catch (error) { if (profileScopeMatches(scope, get())) set({ error: errorMessage(error) }) }
  },

  async requestNewChat() {
    const initial = get()
    if (initial.switchingProfileId || initial.creatingChat) return
    const preferenceScope = captureWorkspaceScope(initial)
    if (!preferenceScope) {
      initial.setModal('newChat', true)
      return
    }
    const profileScope = captureProfileScope(initial)
    const lastOpenedSessionId = initial.selectedSessionId
    set({ creatingChat: true })
    try {
      let stored: unknown = null
      try {
        stored = await getWorkspacePreference<unknown>(preferenceScope, NEW_CHAT_DEFAULTS_PREFERENCE_KEY, null)
      } catch {
        stored = null
      }
      if (!workspaceScopeMatches(preferenceScope, get()) || !profileScopeMatches(profileScope, get())) return
      const current = get()
      const lastOpened = current.sessions.find(session => session.id === lastOpenedSessionId && !session.archived) ?? null
      const seed = lastOpened ?? newestAvailableSession(current.sessions)
      let defaults = parseNewChatDefaults(stored)
        ?? (seed ? sessionNewChatDefaults(seed, current.health?.default_cwd?.trim() || '') : null)
      if (!defaults) {
        set({ creatingChat: false })
        current.setModal('newChat', true)
        return
      }
      const defaultCwd = current.health?.default_cwd?.trim() || ''
      const lastOpenedFolder = lastOpened ? lastOpened.folder?.trim() || 'General' : null
      const lastOpenedCwd = lastOpened ? lastOpened.cwd?.trim() || defaultCwd : null
      defaults = {
        ...defaults,
        folder: lastOpenedFolder ?? defaults.folder,
        cwd: lastOpenedCwd ?? (defaults.cwd || defaultCwd)
      }
      if (
        !selectableChatBackends(current.health, current.runtimeCatalog).includes(defaults.backend)
        || runtimeSelectionError(current.health, current.runtimeCatalog, defaults.backend, defaults.model, defaults.codex_provider)
      ) {
        set({ creatingChat: false })
        current.setModal('newChat', true)
        return
      }
      const input: CreateSessionInput = {
        title: 'New chat',
        folder: defaults.folder,
        cwd: defaults.cwd,
        backend: defaults.backend,
        ...(defaults.codex_provider === 'custom' ? { codex_provider: 'custom' as const } : {}),
        model: defaults.model,
        effort: defaults.effort,
        system_prompt: null,
        cursor_permission_mode: defaults.backend === 'cursor' ? 'default' : null
      }
      const session = await window.agentsDock.sessions.create(input)
      if (!workspaceScopeMatches(preferenceScope, get()) || !profileScopeMatches(profileScope, get())) return
      trackEvent('chat_created')
      await Promise.all([
        saveNewChatDefaults(preferenceScope, input),
        setWorkspacePreference(preferenceScope, directChatPlaceholderKey(session.id), directChatPlaceholderMarker(session))
      ]).catch(() => undefined)
      if (!workspaceScopeMatches(preferenceScope, get()) || !profileScopeMatches(profileScope, get())) return
      await get().refreshSessions()
      if (!workspaceScopeMatches(preferenceScope, get()) || !profileScopeMatches(profileScope, get())) return
      await get().selectSession(session.id)
    } catch (error) {
      if (workspaceScopeMatches(preferenceScope, get()) && profileScopeMatches(profileScope, get())) set({ error: errorMessage(error) })
    } finally {
      if (workspaceScopeMatches(preferenceScope, get()) && profileScopeMatches(profileScope, get())) set({ creatingChat: false })
    }
  },

  async updateSession(sessionId, patch, options) {
    if (get().switchingProfileId && !options?.allowDuringWorkspaceFlush) return
    const scope = captureProfileScope(get())
    const previousSession = get().sessions.find(session => session.id === sessionId)
    const version = ++pendingSessionPatchVersion
    const existing = pendingSessionPatches.get(sessionId)?.patch ?? {}
    pendingSessionPatches.set(sessionId, { version, patch: { ...existing, ...patch } })
    set(state => ({ sessions: state.sessions.map(session => session.id === sessionId ? { ...session, ...patch } as Session : session) }))
    try {
      const updated = await window.agentsDock.sessions.update(sessionId, normalizeSessionPatch(patch))
      if (!profileScopeMatches(scope, get())) return
      const pending = pendingSessionPatches.get(sessionId)
      if (pending?.version === version) pendingSessionPatches.delete(sessionId)
      set(state => ({ sessions: state.sessions.map(session => session.id === sessionId
        ? pending && pending.version !== version ? { ...updated, ...pending.patch } : updated
        : session) }))
      if (previousSession && patch.folder !== undefined) {
        const previousFolder = previousSession.folder?.trim() || 'General'
        const updatedFolder = updated.folder?.trim() || 'General'
        if (previousFolder !== updatedFolder) trackEvent('chat_moved_to_folder')
      }
      if (previousSession && patch.cwd !== undefined) {
        const previousCwd = previousSession.cwd?.trim() || ''
        const updatedCwd = updated.cwd?.trim() || ''
        if (previousCwd !== updatedCwd) trackEvent('working_directory_changed')
      }
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return
      const pending = pendingSessionPatches.get(sessionId)
      if (pending?.version === version) {
        pendingSessionPatches.delete(sessionId)
        if (previousSession) set(state => ({ sessions: state.sessions.map(session => session.id === sessionId ? previousSession : session) }))
      }
      set({ error: errorMessage(error) })
    }
  },

  async deleteFolder(folder) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    const preferenceScope = captureWorkspaceScope(get())
    const source = folder.trim()
    if (!source || source.toLocaleLowerCase() === 'general') return
    const sessionsToMove = get().sessions.filter(session => (session.folder?.trim() || 'General') === source)
    try {
      const movedSessions = await Promise.all(sessionsToMove.map(async session => ({
        ...(await window.agentsDock.sessions.update(session.id, { folder: 'General' })),
        folder: 'General'
      })))
      if (!profileScopeMatches(scope, get())) return
      const movedById = new Map(movedSessions.map(session => [session.id, session]))
      const folderOrder = get().folderOrder.filter(candidate => candidate !== source)
      const collapsedFolders = new Set([...get().collapsedFolders].filter(candidate => candidate !== source))
      await Promise.all([
        setWorkspacePreference(preferenceScope, 'folderOrder', folderOrder),
        setWorkspacePreference(preferenceScope, 'collapsedFolders', [...collapsedFolders])
      ])
      if (!profileScopeMatches(scope, get())) return
      set(state => {
        const snapshots = { ...state.snapshots }
        for (const [sessionId, session] of movedById) {
          if (snapshots[sessionId]) snapshots[sessionId] = { ...snapshots[sessionId], session }
        }
        return {
          sessions: state.sessions.map(session => movedById.get(session.id) ?? session),
          snapshots,
          folderOrder,
          collapsedFolders
        }
      })
      trackEvent('folder_deleted')
    } catch (error) {
      if (!profileScopeMatches(scope, get())) return
      await get().refreshSessions()
      if (!profileScopeMatches(scope, get())) return
      set({ error: errorMessage(error) })
    }
  },

  async forkSession(sessionId) {
    const current = get()
    if (current.switchingProfileId) return
    const source = current.sessions.find(session => session.id === sessionId)
    if ((current.activeSessionIds.has(sessionId) || current.turnAdmissionTokens[sessionId])
      && !completedPrefixForkAvailable(current.health, source?.backend)) {
      set({ error: RUNNING_FORK_UNAVAILABLE })
      return
    }
    const scope = captureProfileScope(get())
    try {
      const session = await window.agentsDock.sessions.fork(sessionId)
      if (!profileScopeMatches(scope, get())) return
      await get().refreshSessions()
      if (!profileScopeMatches(scope, get())) return
      await get().selectSession(session.id)
    } catch (error) { if (profileScopeMatches(scope, get())) set({ error: forkErrorMessage(error) }) }
  },
  async deleteSession(sessionId) {
    if (get().switchingProfileId) return false
    const scope = captureProfileScope(get())
    try {
      await window.agentsDock.sessions.remove(sessionId)
      if (!profileScopeMatches(scope, get())) return false
      const sessions = get().sessions.filter(session => session.id !== sessionId)
      snapshotAccess.delete(sessionId)
      const beforeLayout = currentChatPaneLayout(get())
      set(state => {
        const snapshots = { ...state.snapshots }
        delete snapshots[sessionId]
        const layout = reconcileChatPaneLayout(
          currentChatPaneLayout(state),
          new Set(sessions.map(session => session.id)),
          sessions.find(session => !session.archived)?.id ?? null
        )
        return { sessions, snapshots, ...focusedPaneAliases(state, layout) }
      })
      persistChatPaneState(get())
      unsubscribeHiddenChatSessions(beforeLayout.panes, get().chatPanes, scope)
      const selectedAfterDelete = get().selectedSessionId
      if (selectedAfterDelete) {
        await get().selectSessionInPane(selectedAfterDelete, get().focusedChatPane)
      } else if (!selectedAfterDelete) {
        const next = sessions.find(session => !session.archived)
        if (next) await get().selectSession(next.id)
      }
      return true
    } catch (error) {
      if (profileScopeMatches(scope, get())) set({ error: errorMessage(error) })
      return false
    }
  },
  async markRead(sessionId, force = false) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    const current = get()
    const session = current.sessions.find(candidate => candidate.id === sessionId)
    if (!session) return
    const snapshot = current.snapshots[sessionId]
    const loadedAgentSeq = snapshot?.events.reduce((latest, event) => (
      isAgentVisibleEvent(event) ? Math.max(latest, event.seq) : latest
    ), 0) ?? 0
    const authoritativeAgentSeq = Math.max(
      session.latest_agent_event_seq ?? 0,
      snapshot?.session.latest_agent_event_seq ?? 0,
      loadedAgentSeq
    )
    const lastReadSeq = Math.max(
      session.last_read_agent_event_seq ?? 0,
      snapshot?.session.last_read_agent_event_seq ?? 0
    )
    if (!force && !session.manual_unread && authoritativeAgentSeq <= lastReadSeq) return
    const seq = authoritativeAgentSeq > 0
      ? authoritativeAgentSeq
      : session.latest_event_seq ?? snapshot?.session.latest_event_seq ?? null
    const mutationLease = ++readStateMutationCounter
    readStateMutationLeases.set(sessionId, mutationLease)
    await enqueueReadStateMutation(scope, sessionId, async () => {
      if (!profileScopeMatches(scope, get())) return
      try {
        const updated = await window.agentsDock.sessions.markRead(sessionId, seq)
        if (!profileScopeMatches(scope, get()) || readStateMutationLeases.get(sessionId) !== mutationLease) return
        if (updated.id !== sessionId) return
        set(state => {
          const currentSession = state.sessions.find(candidate => candidate.id === sessionId)
          if (!currentSession) return state
          const [reconciled] = applyPendingSessionPatches([mergeReadStateReceipt(currentSession, updated, 'read')])
          const currentSnapshot = state.snapshots[sessionId]
          const snapshotSession = currentSnapshot
            ? applyPendingSessionPatches([mergeReadStateReceipt(currentSnapshot.session, updated, 'read')])[0]
            : null
          return {
            sessions: state.sessions.map(candidate => candidate.id === sessionId ? reconciled : candidate),
            snapshots: currentSnapshot && snapshotSession
              ? { ...state.snapshots, [sessionId]: { ...currentSnapshot, session: snapshotSession } }
              : state.snapshots
          }
        })
      } catch { /* reading remains local-first */ }
      finally {
        if (readStateMutationLeases.get(sessionId) === mutationLease) readStateMutationLeases.delete(sessionId)
      }
    })
  },
  async markUnread(sessionId) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    const mutationLease = ++readStateMutationCounter
    readStateMutationLeases.set(sessionId, mutationLease)
    await enqueueReadStateMutation(scope, sessionId, async () => {
      if (!profileScopeMatches(scope, get())) return
      try {
        const updated = await window.agentsDock.sessions.markUnread(sessionId)
        if (!profileScopeMatches(scope, get()) || readStateMutationLeases.get(sessionId) !== mutationLease) return
        if (updated.id !== sessionId) return
        set(state => {
          const currentSession = state.sessions.find(candidate => candidate.id === sessionId)
          if (!currentSession) return state
          const [reconciled] = applyPendingSessionPatches([mergeReadStateReceipt(currentSession, updated, 'unread')])
          const currentSnapshot = state.snapshots[sessionId]
          const snapshotSession = currentSnapshot
            ? applyPendingSessionPatches([mergeReadStateReceipt(currentSnapshot.session, updated, 'unread')])[0]
            : null
          return {
            sessions: state.sessions.map(candidate => candidate.id === sessionId ? reconciled : candidate),
            snapshots: currentSnapshot && snapshotSession
              ? { ...state.snapshots, [sessionId]: { ...currentSnapshot, session: snapshotSession } }
              : state.snapshots
          }
        })
      } catch (error) {
        if (profileScopeMatches(scope, get()) && readStateMutationLeases.get(sessionId) === mutationLease) {
          set({ error: errorMessage(error) })
        }
      } finally {
        if (readStateMutationLeases.get(sessionId) === mutationLease) readStateMutationLeases.delete(sessionId)
      }
    })
  },
  async acknowledgeEmergency(sessionId, alertId) {
    if (get().switchingProfileId) return false
    const scope = captureProfileScope(get())
    try {
      const updated = await window.agentsDock.sessions.acknowledgeEmergency(sessionId, alertId)
      if (!profileScopeMatches(scope, get())) return false
      const [reconciled] = applyPendingSessionPatches([updated])
      set(state => ({
        sessions: state.sessions.map(candidate => candidate.id === sessionId ? reconciled : candidate),
        snapshots: state.snapshots[sessionId]
          ? { ...state.snapshots, [sessionId]: { ...state.snapshots[sessionId], session: reconciled } }
          : state.snapshots
      }))
      return true
    } catch (error) {
      if (profileScopeMatches(scope, get())) set({ error: errorMessage(error) })
      return false
    }
  },
  async importHistory(sessionId) {
    if (get().switchingProfileId) return
    const scope = captureProfileScope(get())
    try {
      // Refresh is incremental by default. A forced import can replay an
      // entire provider transcript on older servers and create duplicates.
      const page = await window.agentsDock.sessions.importHistory(sessionId, false)
      if (!profileScopeMatches(scope, get())) return
      const [reconciledSession] = applyPendingSessionPatches([page.session])
      set(state => {
        const current = state.snapshots[sessionId]
        if (!current) return { sessions: state.sessions.map(session => session.id === reconciledSession.id ? reconciledSession : session) }
        const events = mergeEvents(page.events, current.events)
        const snapshot: SessionSnapshot = {
          ...current,
          session: reconciledSession,
          events,
          generation: nextTimelineGeneration(current, events, false),
          queuedTurns: page.queued_turns ?? current.queuedTurns,
          hasMoreEvents: Boolean(page.has_more),
          nextTimelineBefore: timelinePageNextBefore(page),
          semanticPaging: timelinePageSemanticPaging(page) ?? current.semanticPaging
        }
        return {
          sessions: state.sessions.map(session => session.id === reconciledSession.id ? reconciledSession : session),
          snapshots: cacheSnapshot(
            state.snapshots,
            sessionId,
            snapshot,
            visibleChatSessionIds(currentChatPaneLayout(state).panes)
          )
        }
      })
    } catch (error) { if (profileScopeMatches(scope, get())) set({ error: errorMessage(error) }) }
  },
  async loadOlder(requestedLimit) {
    const id = get().selectedSessionId
    if (!id) return 0
    return get().loadOlderForSession(id, requestedLimit)
  },
  async loadOlderForSession(id, requestedLimit) {
    if (get().switchingProfileId) return 0
    const scope = captureProfileScope(get())
    const snapshot = get().snapshots[id]
    const before = snapshot?.nextTimelineBefore ?? snapshot?.events[0]?.seq
    if (!id || !snapshot || !before || !snapshot.hasMoreEvents) return 0
    const defaultLimit = snapshot.semanticPaging === true
      ? SEMANTIC_HISTORY_ITEM_LIMIT
      : LEGACY_HISTORY_EVENT_LIMIT
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(LEGACY_HISTORY_EVENT_LIMIT, Math.floor(requestedLimit as number)))
      : defaultLimit
    const existing = olderLoads.get(id)
    if (existing) return existing
    let task!: Promise<number>
    task = (async () => {
    try {
      const page = await window.agentsDock.timeline.older(id, before, limit)
      if (!profileScopeMatches(scope, get())) return 0
      let added = 0
      set(state => {
        const current = state.snapshots[id]
        if (!current) return state
        const events = mergeEvents(page.events, current.events)
        added = events.length - current.events.length
        return { snapshots: cacheSnapshot(state.snapshots, id, {
          ...current,
          events,
          generation: nextTimelineGeneration(current, events, false),
          hasMoreEvents: Boolean(page.has_more),
          nextTimelineBefore: timelinePageNextBefore(page),
          semanticPaging: timelinePageSemanticPaging(page) ?? current.semanticPaging,
          session: page.session
        }, visibleChatSessionIds(currentChatPaneLayout(state).panes)) }
      })
      return added
    } catch (error) {
      if (profileScopeMatches(scope, get())) set({ error: errorMessage(error) })
      return 0
    }
    finally { if (olderLoads.get(id) === task) olderLoads.delete(id) }
    })()
    olderLoads.set(id, task)
    return task
  },
  beginQueuedTurnsRequest(sessionId) {
    const request = ++queuedTurnsRequestCounter
    queuedTurnsRequestLeases.set(sessionId, request)
    return request
  },
  applyQueuedTurnsResponse(sessionId, request, turns) {
    if (!queuedTurnsRequestIsCurrent(sessionId, request)) return false
    if (!get().snapshots[sessionId]) {
      invalidateQueuedTurnsRequests(sessionId)
      return false
    }
    get().setQueued(sessionId, turns)
    return true
  },
  setQueued(sessionId, turns) {
    invalidateQueuedTurnsRequests(sessionId)
    if (!get().snapshots[sessionId]) return
    set(state => ({ snapshots: cacheSnapshot(
      state.snapshots,
      sessionId,
      { ...state.snapshots[sessionId], queuedTurns: turns },
      visibleChatSessionIds(currentChatPaneLayout(state).panes)
    ) }))
  },
  toggleFolder(folder) {
    const next = new Set(get().collapsedFolders)
    if (next.has(folder)) next.delete(folder); else next.add(folder)
    const scope = captureWorkspaceScope(get())
    set({ collapsedFolders: next }); void setWorkspacePreference(scope, 'collapsedFolders', [...next]).catch(() => undefined)
  },
  setFolderOrder(order) { const scope = captureWorkspaceScope(get()); set({ folderOrder: order }); void setWorkspacePreference(scope, 'folderOrder', order).catch(() => undefined) },
  setArchivedCollapsed(value) { const scope = captureWorkspaceScope(get()); set({ archivedCollapsed: value }); void setWorkspacePreference(scope, 'archivedCollapsed', value).catch(() => undefined) },
  setInspectorVisible(value) { const scope = captureWorkspaceScope(get()); set({ inspectorVisible: value }); void setWorkspacePreference(scope, 'inspectorVisible', value).catch(() => undefined) },
  setModal(key, value) {
    set(state => ({
      modals: {
        ...state.modals,
        ...(value && key === 'settings' ? { appSettings: false } : {}),
        ...(value && key === 'appSettings' ? { settings: false } : {}),
        [key]: value
      }
    }))
  },
  setError(error) { set({ error }) }
}))

function beginWorkspaceTransition(): WorkspaceTransition {
  activeWorkspaceTransition?.cancel()
  const id = ++workspaceTransitionCounter
  let ownerFinished = false
  let cancelled = false
  let settled = false
  let followers = 0
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  const settleIfReady = (force = false) => {
    if (settled || !force && (!ownerFinished || followers > 0)) return
    settled = true
    resolvePromise()
    if (activeWorkspaceTransition === transition) activeWorkspaceTransition = null
  }
  const transition: WorkspaceTransition = {
    id,
    promise,
    finish: () => { ownerFinished = true; settleIfReady() },
    cancel: () => { cancelled = true; ownerFinished = true; settleIfReady(true) },
    follow: task => {
      if (settled || cancelled) return
      followers += 1
      void Promise.resolve(task).then(
        () => { followers -= 1; settleIfReady() },
        () => { followers -= 1; settleIfReady() }
      )
    }
  }
  activeWorkspaceTransition = transition
  return transition
}

/** Waits for the current cached switch and canonical-identity refresh to settle. */
export async function waitForWorkspaceReady(): Promise<void> {
  while (activeWorkspaceTransition) {
    const transition = activeWorkspaceTransition
    await transition.promise
    if (activeWorkspaceTransition === transition) return
  }
}

function selectedSessionFromBootstrap(payload: BootstrapPayload): string | null {
  return payload.selectedSessionId && payload.sessions.some(session => session.id === payload.selectedSessionId && !session.archived)
    ? payload.selectedSessionId
    : payload.sessions.find(session => !session.archived)?.id ?? null
}

function currentChatPaneLayout(state: Pick<AppState, 'chatPanes' | 'focusedChatPane' | 'selectedSessionId'>): ChatPaneLayout {
  const panes = state.chatPanes ?? { primary: state.selectedSessionId, secondary: null }
  let focusedPane = state.focusedChatPane ?? 'primary'
  // Tests and older persisted Zustand snapshots may still set only the
  // compatibility alias. Honor that until every caller uses pane state.
  if (state.selectedSessionId && panes[focusedPane] !== state.selectedSessionId) {
    if (panes.primary === state.selectedSessionId) focusedPane = 'primary'
    else if (panes.secondary === state.selectedSessionId) focusedPane = 'secondary'
    else return { panes: { ...panes, [focusedPane]: state.selectedSessionId }, focusedPane }
  }
  return { panes, focusedPane }
}

function focusedPaneAliases(state: AppState, layout: ChatPaneLayout): Partial<AppState> {
  const selectedSessionId = focusedChatSessionId(layout)
  const visible = new Set(visibleChatSessionIds(layout.panes))
  const loadingSessionIds = new Set([...state.loadingSessionIds].filter(sessionId => visible.has(sessionId)))
  const syncBySession = Object.fromEntries(Object.entries(state.syncBySession).filter(([sessionId]) => visible.has(sessionId)))
  const sync = selectedSessionId ? syncBySession[selectedSessionId] : undefined
  const syncStatus: ChatSyncStatus = selectedSessionId
    ? sync?.status ?? (state.connected ? (state.snapshots[selectedSessionId] ? 'cached' : 'syncing') : 'offline')
    : 'idle'
  return {
    chatPanes: layout.panes,
    focusedChatPane: layout.focusedPane,
    selectedSessionId,
    loadingSessionIds,
    loadingSessionId: focusedLoadingSessionId(selectedSessionId, loadingSessionIds),
    syncBySession,
    syncSessionId: selectedSessionId,
    syncStatus,
    syncError: sync?.error ?? null
  }
}

function focusedLoadingSessionId(selectedSessionId: string | null, loadingSessionIds: ReadonlySet<string>): string | null {
  return selectedSessionId && loadingSessionIds.has(selectedSessionId) ? selectedSessionId : null
}

function withoutSessionId(ids: ReadonlySet<string>, sessionId: string): Set<string> {
  if (!ids.has(sessionId)) return ids instanceof Set ? ids : new Set(ids)
  const next = new Set(ids)
  next.delete(sessionId)
  return next
}

function markSessionLoading(state: AppState, sessionId: string): Partial<AppState> {
  const loadingSessionIds = new Set(state.loadingSessionIds)
  loadingSessionIds.add(sessionId)
  return {
    loadingSessionIds,
    loadingSessionId: focusedLoadingSessionId(state.selectedSessionId, loadingSessionIds)
  }
}

function clearSessionLoading(state: AppState, sessionId: string): Partial<AppState> {
  const loadingSessionIds = withoutSessionId(state.loadingSessionIds, sessionId)
  return {
    loadingSessionIds,
    loadingSessionId: focusedLoadingSessionId(state.selectedSessionId, loadingSessionIds)
  }
}

function sessionSyncState(
  state: AppState,
  sessionId: string,
  status: ChatSyncStatus,
  error: string | null
): Partial<AppState> {
  return {
    syncBySession: { ...state.syncBySession, [sessionId]: { status, error } },
    ...(state.selectedSessionId === sessionId
      ? { syncSessionId: sessionId, syncStatus: status, syncError: error }
      : {})
  }
}

function sessionLoadingAndSyncState(
  state: AppState,
  sessionId: string,
  status: ChatSyncStatus,
  error: string | null
): Partial<AppState> {
  return { ...markSessionLoading(state, sessionId), ...sessionSyncState(state, sessionId, status, error) }
}

async function restoredChatPaneLayout(
  payload: BootstrapPayload | ProfileBootstrapPayload,
  fallbackSessionId: string | null
): Promise<ChatPaneLayout> {
  const profileId = payload.activeProfileId ?? null
  const profileGeneration = payload.profileGeneration ?? 0
  const serverIdentity = payload.profiles?.find(profile => profile.id === profileId)?.serverIdentity ?? null
  const scope = profileId ? { profileId, profileGeneration, serverIdentity } : null
  const fallback: ChatPaneLayout = {
    panes: { primary: fallbackSessionId, secondary: null },
    focusedPane: 'primary'
  }
  try {
    if (!window.agentsDock.preferences) return fallback
    const stored = parseStoredChatPaneLayout(
      await getWorkspacePreference<unknown>(scope, 'chatPaneLayout', null)
    )
    if (!stored) return fallback
    return reconcileChatPaneLayout(stored, new Set(payload.sessions.map(session => session.id)), fallbackSessionId)
  } catch {
    return fallback
  }
}

function parseStoredChatPaneLayout(value: unknown): ChatPaneLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stored = value as StoredChatPaneLayout
  const primary = typeof stored.primary === 'string' ? stored.primary : null
  const secondary = typeof stored.secondary === 'string' ? stored.secondary : null
  if (!primary && !secondary) return null
  return {
    panes: { primary, secondary },
    focusedPane: stored.focusedPane === 'secondary' ? 'secondary' : 'primary'
  }
}

function storedChatPaneLayout(layout: ChatPaneLayout): StoredChatPaneLayout {
  return {
    primary: layout.panes.primary,
    secondary: layout.panes.secondary,
    focusedPane: layout.focusedPane
  }
}

function persistChatPaneState(state: AppState): void {
  if (!window.agentsDock.preferences) return
  const scope = captureWorkspaceScope(state)
  const layout = {
    primary: state.chatPanes.primary,
    secondary: state.chatPanes.secondary,
    focusedPane: state.focusedChatPane
  }
  void Promise.all([
    setWorkspacePreference(scope, 'chatPaneLayout', layout),
    setWorkspacePreference(scope, 'selectedSessionId', state.selectedSessionId)
  ]).catch(() => undefined)
}

async function hydrateVisibleChatPanes(get: () => AppState): Promise<void> {
  const panes = get().chatPanes
  const tasks: Promise<void>[] = []
  if (panes.primary) tasks.push(get().selectSessionInPane(panes.primary, 'primary', false, false))
  if (panes.secondary) tasks.push(get().selectSessionInPane(panes.secondary, 'secondary', false, false))
  await Promise.all(tasks)
}

function chatPaneLayoutsEqual(left: ChatPaneLayout, right: ChatPaneLayout): boolean {
  return left.focusedPane === right.focusedPane
    && left.panes.primary === right.panes.primary
    && left.panes.secondary === right.panes.secondary
}

function unsubscribeHiddenChatSessions(before: ChatPanes, after: ChatPanes, scope: RendererProfileScope): void {
  const visibleAfter = new Set(visibleChatSessionIds(after))
  for (const sessionId of visibleChatSessionIds(before)) {
    if (visibleAfter.has(sessionId)) continue
    selectionLeases.delete(sessionId)
    timelineSubscriptions.delete(sessionId)
    const unsubscribe = window.agentsDock.timeline?.unsubscribe
    if (typeof unsubscribe !== 'function') continue
    void unsubscribe(sessionId).catch(error => {
      if (profileScopeMatches(scope)) logTimelineSelection('timeline unsubscribe failed', { sessionId, error: errorMessage(error) })
    })
  }
}

async function openProfileNotificationRoute(route: ProfileNotificationRoute, get: () => AppState): Promise<boolean> {
  const intent = ++notificationRouteIntent
  if (get().switchingProfileId) await waitForWorkspaceReady()
  if (intent !== notificationRouteIntent) return false
  const before = get()
  const target = before.profiles.find(profile => profile.id === route.profileId)
  if (!target) {
    if (intent === notificationRouteIntent) before.setError('That notification belongs to a server profile that is no longer saved.')
    return false
  }
  if ((target.serverIdentity ?? null) !== route.serverIdentity) {
    if (intent === notificationRouteIntent) before.setError(`The identity for “${target.name}” changed, so the notification was not opened.`)
    return false
  }

  const needsSwitch = before.activeProfileId !== route.profileId || Boolean(before.switchingProfileId)
  const expectedSwitchIntent = profileSwitchIntent + (needsSwitch ? 1 : 0)
  if (needsSwitch) {
    try {
      if (!await before.switchServer(route.profileId)) return false
    } catch {
      return false
    }
  }
  if (get().switchingProfileId || needsSwitch && (target.serverIdentity ?? null) == null) await waitForWorkspaceReady()
  const current = get()
  if (intent !== notificationRouteIntent || profileSwitchIntent !== expectedSwitchIntent || current.activeProfileId !== route.profileId || current.switchingProfileId) return false
  const currentTarget = current.profiles.find(profile => profile.id === route.profileId)
  if (!currentTarget || (currentTarget.serverIdentity ?? null) !== route.serverIdentity) {
    current.setError(`The identity for “${target.name}” changed, so the notification was not opened.`)
    return false
  }
  if (!current.sessions.some(session => session.id === route.sessionId)) {
    current.setError(`The notified chat is not available in “${target.name}”.`)
    return false
  }
  try {
    await current.selectSession(route.sessionId)
  } catch (error) {
    if (intent === notificationRouteIntent) get().setError(errorMessage(error))
    return false
  }
  const after = get()
  const routedProfile = after.profiles.find(profile => profile.id === route.profileId)
  return intent === notificationRouteIntent
    && profileSwitchIntent === expectedSwitchIntent
    && after.activeProfileId === route.profileId
    && !after.switchingProfileId
    && (routedProfile?.serverIdentity ?? null) === route.serverIdentity
    && after.sessions.some(session => session.id === route.sessionId)
    && after.selectedSessionId === route.sessionId
}

type MailHintBinding = Pick<AppState, 'activeProfileId' | 'profileGeneration' | 'profiles' | 'switchingProfileId'>

function mailHintProjectionMatches(projection: MailHintProjection | null | undefined, binding: MailHintBinding): projection is MailHintProjection {
  if (!projection || !Number.isSafeInteger(projection.revision) || projection.revision < 0
    || !profileEventMatches(projection, binding)) return false
  const scope = projection.state?.scope
  return projection.state === null || Boolean(scope
    && scope.profileId === projection.profileId && scope.profileGeneration === projection.profileGeneration
    && scope.serverIdentity === binding.profiles.find(profile => profile.id === binding.activeProfileId)?.serverIdentity)
}

function mergeMailHintProjections(binding: MailHintBinding, ...projections: (MailHintProjection | null | undefined)[]): MailHintProjection | null {
  let latest: MailHintProjection | null = null
  for (const projection of projections) {
    if (mailHintProjectionMatches(projection, binding) && (!latest || projection.revision > latest.revision)) latest = projection
  }
  return latest
}

function bufferMailHintProjection(projection: MailHintProjection): void {
  if (!projection || typeof projection.profileId !== 'string' || projection.profileId.length > 240
    || !Number.isSafeInteger(projection.profileGeneration) || projection.profileGeneration < 1
    || !Number.isSafeInteger(projection.revision) || projection.revision < 0) return
  const key = JSON.stringify([projection.profileId, projection.profileGeneration])
  const previous = bufferedMailHints.get(key)
  if (previous && previous.revision >= projection.revision) return
  bufferedMailHints.delete(key)
  bufferedMailHints.set(key, projection)
  while (bufferedMailHints.size > MAX_BUFFERED_MAIL_HINT_SCOPES) bufferedMailHints.delete(bufferedMailHints.keys().next().value!)
}

function consumeBufferedMailHints(binding: MailHintBinding, ...projections: (MailHintProjection | null | undefined)[]): MailHintProjection | null {
  const latest = mergeMailHintProjections(binding, ...projections, ...bufferedMailHints.values())
  bufferedMailHints.clear()
  return latest
}

function mailHintsFromBootstrap(payload: BootstrapPayload): MailHintProjection | null {
  const binding: MailHintBinding = {
    activeProfileId: payload.activeProfileId ?? null,
    profileGeneration: payload.profileGeneration ?? 0,
    profiles: payload.profiles ?? [],
    switchingProfileId: null
  }
  return consumeBufferedMailHints(binding, useAppStore.getState().mailHints, payload.mailHints)
}

/** A scalar selector only: a hint never schedules a page, receipt, or refresh. */
export function selectMailHintPending(state: MailHintBinding & Pick<AppState, 'mailHints'>): boolean {
  return mailHintProjectionMatches(state.mailHints, state) && Boolean(state.mailHints.state && mailHintPending(state.mailHints.state))
}

export function selectBulletinHintPending(state: MailHintBinding & Pick<AppState, 'mailHints'>): boolean {
  return mailHintProjectionMatches(state.mailHints, state) && Boolean(state.mailHints.bulletin && bulletinHintPending(state.mailHints.bulletin))
}

export function captureBulletinHintRefresh(hubScope: TeamHubScope, teamId: string): BulletinHintRefresh | null {
  const current = useAppStore.getState()
  const projection = current.mailHints
  if (!mailHintProjectionMatches(projection, current) || !projection.bulletin || !projection.state
    || !projection.state.initialized || projection.state.invalid) return null
  const { scope, latest } = projection.bulletin
  if (teamId !== scope.teamId || hubScope.hubIdentity !== scope.hubId
    || hubScope.profileId !== scope.profileId || hubScope.profileGeneration !== scope.profileGeneration
    || hubScope.serverIdentity !== scope.serverIdentity) return null
  return { scope: { ...scope }, cursor: { ...latest } }
}

export async function acknowledgeBulletinHintRefresh(input: BulletinHintRefresh): Promise<void> {
  const matches = (): boolean => {
    const state = useAppStore.getState()
    return mailHintProjectionMatches(state.mailHints, state) && Boolean(state.mailHints.bulletin
      && sameMailHintScope(state.mailHints.bulletin.scope, input.scope))
  }
  if (!matches() || !window.agentsDock.mailHints?.acknowledgeBulletinRefresh) return
  try {
    const projection = await window.agentsDock.mailHints.acknowledgeBulletinRefresh(input)
    if (!matches()) return
    const current = useAppStore.getState()
    const mailHints = mergeMailHintProjections(current, current.mailHints, projection)
    if (mailHints !== current.mailHints) useAppStore.setState({ mailHints })
  } catch { /* Optional local notification state must not fail a content refresh. */ }
}

export function sameMailHintScope(left: MailHintScope, right: MailHintScope): boolean {
  return left.profileId === right.profileId && left.profileGeneration === right.profileGeneration
    && left.serverIdentity === right.serverIdentity && left.streamId === right.streamId
    && left.hubId === right.hubId && left.teamId === right.teamId && left.recipientServerId === right.recipientServerId
}

/** Capture at an existing user-request boundary, never subscribe a loader to hints. */
export function captureMailHintScope(
  hubScope: TeamHubScope,
  query: { teamId: string; box: string; addressKind?: string; addressId?: string; unread?: boolean; fromKind?: string; fromId?: string; since?: string }
): Readonly<MailHintScope> | null {
  const current = useAppStore.getState()
  const projection = current.mailHints
  if (!mailHintProjectionMatches(projection, current) || !projection.state || projection.state.invalid) return null
  const scope = projection.state.scope
  if (query.unread || query.fromKind !== undefined || query.fromId !== undefined || query.since !== undefined
    || query.box !== 'inbox' || query.addressKind !== 'server' || query.addressId !== scope.recipientServerId
    || query.teamId !== scope.teamId || hubScope.hubIdentity !== scope.hubId
    || hubScope.profileId !== scope.profileId || hubScope.profileGeneration !== scope.profileGeneration
    || hubScope.serverIdentity !== scope.serverIdentity) return null
  return Object.freeze({ ...scope })
}

/** Best-effort local seen metadata; failure must not fail an applied Mail page. */
export async function acknowledgeMailHintPage(scope: MailHintScope, requestedAfter: MailArrivalCursor, coverage: MailboxCoverage): Promise<void> {
  const matches = (): boolean => {
    const current = useAppStore.getState()
    return mailHintProjectionMatches(current.mailHints, current) && Boolean(current.mailHints.state
      && !current.mailHints.state.invalid && sameMailHintScope(current.mailHints.state.scope, scope))
  }
  if (!matches() || !window.agentsDock.mailHints?.acknowledgePage) return
  try {
    const projection = await window.agentsDock.mailHints.acknowledgePage({ scope, requestedAfter, coverage })
    if (!matches()) return
    const current = useAppStore.getState()
    const mailHints = mergeMailHintProjections(current, current.mailHints, projection)
    if (mailHints !== current.mailHints) useAppStore.setState({ mailHints })
  } catch { /* Reconnect/fresh page coverage can recover this passive hint. */ }
}

function workspaceStateFromBootstrap(
  payload: BootstrapPayload | ProfileBootstrapPayload,
  selectedSessionId: string | null,
  initialized: boolean,
  restoredLayout?: ChatPaneLayout
): Partial<AppState> {
  const validSessionIds = new Set(payload.sessions.map(session => session.id))
  const layout = reconcileChatPaneLayout(
    restoredLayout ?? { panes: { primary: selectedSessionId, secondary: null }, focusedPane: 'primary' },
    validSessionIds,
    selectedSessionId
  )
  const focusedSessionId = focusedChatSessionId(layout)
  const syncStatus: ChatSyncStatus = focusedSessionId ? (payload.health?.ok ? 'syncing' : 'offline') : 'idle'
  const emergencyFolders = new Set(
    payload.sessions
      .filter(session => activeEmergencyAlert(session) && !session.archived && !session.pinned)
      .map(session => session.folder || 'General')
  )
  return {
    initialized,
    storageFull: Boolean(payload.storageFull || useAppStore.getState().storageFull),
    profiles: payload.profiles ?? [],
    activeProfileId: payload.activeProfileId ?? null,
    profileGeneration: payload.profileGeneration ?? 0,
    switchingProfileId: null,
    mailHints: mailHintsFromBootstrap(payload),
    connected: Boolean(payload.health?.ok),
    connectionError: null,
    syncSessionId: focusedSessionId,
    syncStatus,
    syncError: null,
    health: payload.health ?? null,
    sessions: payload.sessions,
    jobs: payload.jobs,
    runtimeCatalog: payload.runtimeCatalog ?? null,
    chatPanes: layout.panes,
    focusedChatPane: layout.focusedPane,
    selectedSessionId: focusedSessionId,
    snapshots: {},
    loadingSessionIds: new Set(),
    loadingSessionId: null,
    syncBySession: Object.fromEntries(visibleChatSessionIds(layout.panes).map(sessionId => [sessionId, { status: syncStatus, error: null }])),
    uploadsBySession: {},
    uploadPathsBySession: {},
    drafts: {},
    chatReferencesBySession: {},
    teamReferencesBySession: {},
    agentRoutesBySession: {},
    agentRouteLoadingSessionIds: new Set(),
    agentRouteErrorsBySession: {},
    revokingAgentRouteIds: new Set(),
    folderOrder: payload.folderOrder,
    collapsedFolders: new Set(payload.collapsedFolders.filter(folder => !emergencyFolders.has(folder))),
    archivedCollapsed: payload.sessions.some(session => session.archived && activeEmergencyAlert(session))
      ? false
      : payload.archivedCollapsed,
    inspectorVisible: payload.inspectorVisible,
    activeSessionIds: healthActiveSessionIDs(payload.health),
    turnAdmissionTokens: {},
    stoppingSessionIds: new Set(),
    creatingChat: false,
    error: 'profileTransitionWarning' in payload ? payload.profileTransitionWarning ?? null : null
  }
}

function refreshProfileAfterBootstrap(
  profileId: string,
  profileGeneration: number,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  force = false
): Promise<void> {
  const requestedScope = captureProfileScope(get())
  const refreshKey = `${profileId}:${profileGeneration}:${requestedScope.switchEpoch}`
  const existing = profileRefreshes.get(refreshKey)
  if (existing && !force) return existing
  const startingIdentity = get().profiles.find(profile => profile.id === profileId)?.serverIdentity ?? null
  let task!: Promise<void>
  task = runProfileRefresh(profileId, profileGeneration, requestedScope, startingIdentity, get, set, () => profileRefreshes.get(refreshKey) === task)
    .finally(() => {
      if (profileRefreshes.get(refreshKey) === task) profileRefreshes.delete(refreshKey)
    })
  profileRefreshes.set(refreshKey, task)
  return task
}

async function runProfileRefresh(
  profileId: string,
  profileGeneration: number,
  requestedScope: RendererProfileScope,
  startingIdentity: string | null,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  isLatestRefresh: () => boolean
): Promise<void> {
  await Promise.resolve()
  const refresh = window.agentsDock.servers?.refresh
  if (typeof refresh !== 'function' && !pendingNamespaceAdoptionMatches(profileId, profileGeneration, requestedScope)) return
  try {
    if (typeof refresh !== 'function') throw new Error('Server profile refresh is unavailable')
    const payload = await withDeadline(
      Promise.resolve().then(() => refresh(profileId, profileGeneration)),
      PROFILE_REFRESH_TIMEOUT_MS,
      'Server profile refresh timed out'
    )
    if (!isLatestRefresh()) return
    let current = get()
    const adoptionPending = pendingNamespaceAdoptionMatches(profileId, profileGeneration, requestedScope)
    if (requestedScope.switchEpoch !== profileSwitchEpoch || current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) return
    if (current.switchingProfileId && !adoptionPending) return
    const targetIdentity = payload.profiles.find(profile => profile.id === profileId)?.serverIdentity ?? null
    if (adoptionPending) {
      const expectedIdentity = pendingNamespaceAdoption?.canonicalProfiles.find(profile => profile.id === profileId)?.serverIdentity ?? null
      if (!expectedIdentity || targetIdentity !== expectedIdentity) throw new Error('Canonical server identity was not present in the refreshed workspace')
    }
    if (startingIdentity !== targetIdentity) {
      const fallbackSessionId = selectedSessionFromBootstrap(payload)
      const canonicalScope = { profileId, profileGeneration, serverIdentity: targetIdentity }
      const validSessionIds = new Set(payload.sessions.map(session => session.id))
      const fallbackLayout = reconcileChatPaneLayout(
        currentChatPaneLayout(current),
        validSessionIds,
        fallbackSessionId
      )
      const canonicalStoredLayout = parseStoredChatPaneLayout(
        await getWorkspacePreference<unknown>(canonicalScope, 'chatPaneLayout', null).catch(() => null)
      )
      let layout = reconcileChatPaneLayout(
        canonicalStoredLayout ?? fallbackLayout,
        validSessionIds,
        fallbackSessionId
      )
      const visibleSessionIds = visibleChatSessionIds(layout.panes)
      const canonicalComposerState = await Promise.all(visibleSessionIds.map(async sessionId => {
        const [draft, references, teamReferences] = await Promise.all([
          getWorkspacePreference<unknown>(canonicalScope, `draft:${sessionId}`, null).catch(() => null),
          getWorkspacePreference<unknown>(canonicalScope, chatReferencesPreferenceKey(sessionId), null).catch(() => null),
          getWorkspacePreference<unknown>(canonicalScope, teamReferencesPreferenceKey(sessionId), null).catch(() => null)
        ])
        return { sessionId, draft, references, teamReferences }
      }))
      if (!isLatestRefresh()) return
      current = get()
      if (requestedScope.switchEpoch !== profileSwitchEpoch || current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) return
      if (!canonicalStoredLayout) {
        layout = reconcileChatPaneLayout(currentChatPaneLayout(current), validSessionIds, fallbackSessionId)
      }
      const drafts: Record<string, string> = {}
      const chatReferencesBySession: Record<string, ChatReference[]> = {}
      const teamReferencesBySession: Record<string, TeamReference[]> = {}
      const migrationWrites: Promise<void>[] = []
      if (!canonicalStoredLayout) {
        migrationWrites.push(
          setWorkspacePreference(canonicalScope, 'chatPaneLayout', storedChatPaneLayout(layout)),
          setWorkspacePreference(canonicalScope, 'selectedSessionId', focusedChatSessionId(layout))
        )
      }
      for (const composerState of canonicalComposerState) {
        const { sessionId } = composerState
        const localDraft = current.drafts[sessionId] ?? ''
        const canonicalDraft = typeof composerState.draft === 'string' ? composerState.draft : null
        const draft = canonicalDraft ?? localDraft
        if (draft) drafts[sessionId] = draft
        if (canonicalDraft == null && localDraft) {
          migrationWrites.push(setWorkspacePreference(canonicalScope, `draft:${sessionId}`, localDraft))
        }

        const localReferences = current.chatReferencesBySession[sessionId] ?? []
        const canonicalReferences = Array.isArray(composerState.references)
          ? composerState.references as ChatReference[]
          : null
        const references = canonicalReferences ?? localReferences
        if (references.length) chatReferencesBySession[sessionId] = references
        if (canonicalReferences == null && localReferences.length) {
          migrationWrites.push(setWorkspacePreference(canonicalScope, chatReferencesPreferenceKey(sessionId), localReferences))
        }

        const localTeamReferences = current.teamReferencesBySession[sessionId] ?? []
        const canonicalTeamReferences = Array.isArray(composerState.teamReferences)
          ? parseStoredTeamReferences(composerState.teamReferences, draft)
          : null
        const teamReferences = canonicalTeamReferences ?? localTeamReferences
        if (teamReferences.length) teamReferencesBySession[sessionId] = teamReferences
        if (canonicalTeamReferences == null && localTeamReferences.length) {
          migrationWrites.push(setWorkspacePreference(canonicalScope, teamReferencesPreferenceKey(sessionId), localTeamReferences))
        }
      }
      await Promise.all(migrationWrites)
      if (!isLatestRefresh()) return
      current = get()
      if (requestedScope.switchEpoch !== profileSwitchEpoch || current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) return
      clearProfileVolatileState()
      pendingNamespaceAdoption = null
      set({
        ...workspaceStateFromBootstrap(payload, fallbackSessionId, true, layout),
        drafts,
        chatReferencesBySession,
        teamReferencesBySession
      })
      updateBadge(payload.sessions)
      void hydrateVisibleChatPanes(get)
      return
    }
    const selectedSessionId = current.selectedSessionId && payload.sessions.some(session => session.id === current.selectedSessionId)
      ? current.selectedSessionId
      : selectedSessionFromBootstrap(payload)
    const layout = reconcileChatPaneLayout(
      currentChatPaneLayout(current),
      new Set(payload.sessions.map(session => session.id)),
      selectedSessionId
    )
    pendingNamespaceAdoption = null
    set({
      profiles: payload.profiles,
      mailHints: mergeMailHintProjections(current, current.mailHints, payload.mailHints),
      sessions: payload.sessions,
      jobs: payload.jobs,
      runtimeCatalog: payload.runtimeCatalog ?? null,
      ...focusedPaneAliases(current, layout),
      snapshots: syncSnapshotSessions(current.snapshots, payload.sessions),
      folderOrder: payload.folderOrder,
      collapsedFolders: new Set(payload.collapsedFolders),
      archivedCollapsed: payload.archivedCollapsed,
      inspectorVisible: payload.inspectorVisible
    })
    updateBadge(payload.sessions)
    if (!chatPaneLayoutsEqual(currentChatPaneLayout(current), layout)) void hydrateVisibleChatPanes(get)
  } catch (error) {
    if (!isLatestRefresh()) return
    const current = get()
    if (pendingNamespaceAdoptionMatches(profileId, profileGeneration, requestedScope)
      && current.activeProfileId === profileId && current.profileGeneration === profileGeneration) {
      try {
        const recovered = await withDeadline(
          Promise.resolve().then(() => window.agentsDock.bootstrap()),
          PROFILE_RECOVERY_TIMEOUT_MS,
          'Canonical workspace recovery timed out'
        )
        if (!isLatestRefresh()) return
        const latest = get()
        if (recovered.activeProfileId !== profileId || (recovered.profileGeneration ?? profileGeneration) !== profileGeneration
          || latest.activeProfileId !== profileId || latest.profileGeneration !== profileGeneration) return
        const expectedIdentity = pendingNamespaceAdoption?.canonicalProfiles.find(profile => profile.id === profileId)?.serverIdentity ?? null
        const recoveredIdentity = recovered.profiles?.find(profile => profile.id === profileId)?.serverIdentity ?? null
        if (!expectedIdentity || recoveredIdentity !== expectedIdentity) throw new Error('Recovered workspace did not contain the verified server identity')
        const selectedSessionId = selectedSessionFromBootstrap(recovered)
        const layout = await restoredChatPaneLayout(recovered, selectedSessionId)
        if (!isLatestRefresh()) return
        clearProfileVolatileState()
        pendingNamespaceAdoption = null
        set(workspaceStateFromBootstrap(recovered, selectedSessionId, true, layout))
        updateBadge(recovered.sessions)
        void hydrateVisibleChatPanes(get)
      } catch (recoveryError) {
        releaseFailedNamespaceAdoption(profileId, profileGeneration, requestedScope, recoveryError, get, set)
      }
    }
  }
}

function startupChatCleanupFromBootstrap(payload: BootstrapPayload): StartupChatCleanup | null {
  if (!payload.activeProfileId || !payload.profiles) return null
  const serverIdentity = payload.profiles?.find(profile => profile.id === payload.activeProfileId)?.serverIdentity?.trim()
  if (!serverIdentity) return null
  const jobSessionIds = new Set(payload.jobs.map(job => job.session_id))
  const sessionIds = new Set(payload.sessions
    .filter(session => !jobSessionIds.has(session.id) && isUntouchedNewChat(session))
    .map(session => session.id))
  return sessionIds.size ? {
    profileId: payload.activeProfileId,
    profileGeneration: payload.profileGeneration ?? 0,
    serverIdentity,
    sessionIds
  } : null
}

async function removeUntouchedStartupChats(
  payload: BootstrapPayload,
  cleanup: StartupChatCleanup,
  profileScopeIsCurrent: () => boolean
): Promise<BootstrapPayload> {
  if (!profileScopeIsCurrent()) return payload
  if (payload.activeProfileId !== cleanup.profileId || (payload.profileGeneration ?? 0) !== cleanup.profileGeneration) return payload
  const serverIdentity = payload.profiles?.find(profile => profile.id === payload.activeProfileId)?.serverIdentity?.trim()
  if (!serverIdentity || serverIdentity !== cleanup.serverIdentity) return payload
  const preferenceScope: WorkspaceProfileScope = {
    profileId: cleanup.profileId,
    profileGeneration: cleanup.profileGeneration,
    serverIdentity
  }
  try {
    const markers = new Map<string, DirectChatPlaceholderMarker>()
    await Promise.all([...cleanup.sessionIds].map(async sessionId => {
      const marker = await getWorkspacePreference<unknown>(preferenceScope, directChatPlaceholderKey(sessionId), null)
      if (isDirectChatPlaceholderMarker(marker)) markers.set(sessionId, marker)
    }))
    if (!profileScopeIsCurrent() || !markers.size) return payload

    let [liveSessions, liveJobs, livePorts] = await Promise.all([
      window.agentsDock.sessions.list(),
      window.agentsDock.jobs.list(),
      window.agentsDock.ports.list(cleanup.profileId, cleanup.profileGeneration)
    ])
    if (!profileScopeIsCurrent()) return payload
    const removed = new Set<string>()

    for (const [sessionId, marker] of markers) {
      if (!profileScopeIsCurrent()) return payload
      const session = liveSessions.find(candidate => candidate.id === sessionId)
      if (!session || !isUntouchedNewChat(session)) continue
      if (liveJobs.some(job => job.session_id === sessionId) || livePorts.some(port => port.sessionId === sessionId)) continue

      try {
        const [draft, chatReferences, teamReferences, timeline, queuedTurns, files, terminal] = await Promise.all([
          getWorkspacePreference<unknown>(preferenceScope, `draft:${sessionId}`, ''),
          getWorkspacePreference<unknown>(preferenceScope, chatReferencesPreferenceKey(sessionId), []),
          getWorkspacePreference<unknown>(preferenceScope, teamReferencesPreferenceKey(sessionId), []),
          window.agentsDock.timeline.index(sessionId),
          window.agentsDock.queue.list(sessionId),
          window.agentsDock.files.list(sessionId, 0, 1),
          window.agentsDock.terminal.windows(cleanup.profileId, cleanup.profileGeneration, sessionId)
        ])
        if (!profileScopeIsCurrent()) return payload
        if (
          !directChatPlaceholderMarkerMatches(marker, session)
          || typeof draft !== 'string'
          || draft.length > 0
          || !Array.isArray(chatReferences)
          || chatReferences.length > 0
          || !Array.isArray(teamReferences)
          || teamReferences.length > 0
          || timeline.latest_seq !== 1
          || timeline.event_count !== 1
          || queuedTurns.length > 0
          || files.total > 0
          || terminal.exists
        ) continue

        // Re-read the remotely authoritative records immediately before the
        // unconditional legacy DELETE. Any uncertainty preserves the chat.
        ;[liveSessions, liveJobs, livePorts] = await Promise.all([
          window.agentsDock.sessions.list(),
          window.agentsDock.jobs.list(),
          window.agentsDock.ports.list(cleanup.profileId, cleanup.profileGeneration)
        ])
        if (!profileScopeIsCurrent()) return payload
        const confirmed = liveSessions.find(candidate => candidate.id === sessionId)
        if (
          !confirmed
          || !isUntouchedNewChat(confirmed)
          || !directChatPlaceholderMarkerMatches(marker, confirmed)
          || liveJobs.some(job => job.session_id === sessionId)
          || livePorts.some(port => port.sessionId === sessionId)
        ) continue
        // `sessions.remove` targets the main process' active profile. Keep this
        // guard adjacent to the destructive IPC so a profile transition during
        // any of the awaited proof reads cannot delete from the new workspace.
        if (!profileScopeIsCurrent()) return payload
        if (await window.agentsDock.sessions.remove(sessionId)) {
          removed.add(sessionId)
          await setWorkspacePreference(preferenceScope, directChatPlaceholderKey(sessionId), false).catch(() => undefined)
        }
      } catch (error) {
        void window.agentsDock.native.log('bootstrap', 'untouched new chat cleanup skipped', {
          sessionId,
          error: errorMessage(error)
        }).catch(() => undefined)
      }
    }

    return {
      ...payload,
      sessions: liveSessions.filter(session => !removed.has(session.id)),
      jobs: liveJobs
    }
  } catch (error) {
    void window.agentsDock.native.log('bootstrap', 'untouched new chat cleanup unavailable', {
      error: errorMessage(error)
    }).catch(() => undefined)
    return payload
  }
}

function pendingNamespaceAdoptionMatches(profileId: string, profileGeneration: number, scope: RendererProfileScope): boolean {
  return pendingNamespaceAdoption?.profileId === profileId
    && pendingNamespaceAdoption.profileGeneration === profileGeneration
    && pendingNamespaceAdoption.switchEpoch === scope.switchEpoch
}

function followWorkspaceRecovery(task: Promise<unknown>): void {
  if (activeWorkspaceTransition) {
    activeWorkspaceTransition.follow(task)
    return
  }
  const transition = beginWorkspaceTransition()
  transition.follow(task)
  transition.finish()
}

function releaseFailedNamespaceAdoption(
  profileId: string,
  profileGeneration: number,
  requestedScope: RendererProfileScope,
  recoveryError: unknown,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void
): void {
  const pending = pendingNamespaceAdoption
  const current = get()
  if (!pending || !pendingNamespaceAdoptionMatches(profileId, profileGeneration, requestedScope)
    || current.activeProfileId !== profileId || current.profileGeneration !== profileGeneration) return
  const selectedSessionId = current.selectedSessionId && current.sessions.some(session => session.id === current.selectedSessionId && !session.archived)
    ? current.selectedSessionId
    : null
  const detail = `The verified server identity was saved, but its workspace could not be reloaded. ${errorMessage(recoveryError)}`
  clearProfileVolatileState()
  pendingNamespaceAdoption = null
  set({
    profiles: pending.canonicalProfiles,
    switchingProfileId: null,
    selectedSessionId,
    chatPanes: { primary: selectedSessionId, secondary: null },
    focusedChatPane: 'primary',
    snapshots: {},
    loadingSessionIds: new Set(),
    loadingSessionId: null,
    syncBySession: selectedSessionId ? {
      [selectedSessionId]: { status: current.connected ? 'cached' : 'offline', error: detail }
    } : {},
    uploadsBySession: {},
    uploadPathsBySession: {},
    drafts: {},
    chatReferencesBySession: {},
    teamReferencesBySession: {},
    agentRoutesBySession: {},
    agentRouteLoadingSessionIds: new Set(),
    agentRouteErrorsBySession: {},
    revokingAgentRouteIds: new Set(),
    turnAdmissionTokens: {},
    stoppingSessionIds: new Set(),
    syncSessionId: selectedSessionId,
    syncStatus: selectedSessionId ? (current.connected ? 'cached' : 'offline') : 'idle',
    syncError: detail,
    error: detail
  })
}

function captureProfileScope(state: Pick<AppState, 'activeProfileId' | 'profileGeneration'> = useAppStore.getState()): RendererProfileScope {
  return { profileId: state.activeProfileId, profileGeneration: state.profileGeneration, switchEpoch: profileSwitchEpoch }
}

function enqueueReadStateMutation(
  scope: RendererProfileScope,
  sessionId: string,
  operation: () => Promise<void>
): Promise<void> {
  const key = JSON.stringify([scope.profileId, scope.profileGeneration, scope.switchEpoch, sessionId])
  const previous = readStateMutationQueues.get(key) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(operation)
  const barrier = task.then(() => undefined, () => undefined)
  readStateMutationQueues.set(key, barrier)
  void barrier.finally(() => {
    if (readStateMutationQueues.get(key) === barrier) readStateMutationQueues.delete(key)
  })
  return task
}

function captureSteeringScope(
  sessionId: string,
  state: Pick<AppState, 'activeProfileId' | 'profileGeneration' | 'profiles'> = useAppStore.getState()
): SteeringScope {
  return {
    profileId: state.activeProfileId,
    profileGeneration: state.profileGeneration,
    serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
    sessionId
  }
}

function profileScopeMatches(scope: RendererProfileScope, state: Pick<AppState, 'activeProfileId' | 'profileGeneration'> = useAppStore.getState()): boolean {
  return scope.switchEpoch === profileSwitchEpoch
    && scope.profileId === state.activeProfileId
    && scope.profileGeneration === state.profileGeneration
}

function workspaceScopeMatches(
  scope: WorkspaceProfileScope,
  state: Pick<AppState, 'activeProfileId' | 'profileGeneration' | 'profiles' | 'switchingProfileId'> = useAppStore.getState()
): boolean {
  if (state.switchingProfileId) return false
  const current = captureWorkspaceScope(state)
  return current?.profileId === scope.profileId
    && current.profileGeneration === scope.profileGeneration
    && current.serverIdentity === scope.serverIdentity
}

function profileEventMatches(
  payload: { profileId: string; profileGeneration: number },
  state: Pick<AppState, 'activeProfileId' | 'profileGeneration' | 'switchingProfileId'> = useAppStore.getState()
): boolean {
  if (state.switchingProfileId) return false
  return payload.profileId === state.activeProfileId && payload.profileGeneration === state.profileGeneration
}

export async function flushActiveWorkspace(): Promise<void> {
  const pending: Promise<unknown>[] = []
  const collect = (promise: PromiseLike<unknown> | unknown): void => { pending.push(Promise.resolve(promise)) }
  const detail: DraftFlushDetail = { pending, promises: pending, waitUntil: collect, add: collect }
  window.dispatchEvent(new CustomEvent<DraftFlushDetail>('agentsdock:flush-draft', { detail }))
  window.dispatchEvent(new CustomEvent<DraftFlushDetail>('agentsdock:capture-timeline', { detail }))
  const results = await Promise.allSettled(pending)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
}

function clearProfileVolatileState(): void {
  cancelPendingSteering()
  selectionEpoch += 1
  selectionLeases.clear()
  timelineSubscriptions.clear()
  for (const repair of timelineRepairs.values()) {
    if (repair.timer !== null && repair.timer >= 0) window.clearTimeout(repair.timer)
  }
  timelineRepairs.clear()
  olderLoads.clear()
  prefetchLoads.clear()
  snapshotAccess.clear()
  snapshotAccessCounter = 0
  pendingLiveEvents.clear()
  pendingLiveEventCount = 0
  timelineDeferredEvents.clear()
  queuedTurnsRequestLeases.clear()
  readStateMutationLeases.clear()
  readStateMutationQueues.clear()
  pendingSessionPatches.clear()
  agentRouteRefreshTokens.clear()
  agentRouteMutationTokens.clear()
  pendingCrossChatQueueRefreshes.clear()
  pendingSessionPatchVersion = 0
  if (liveEventTimer != null) window.clearTimeout(liveEventTimer)
  liveEventTimer = null
  lastLatencySensitiveInteractionAt = Number.NEGATIVE_INFINITY
}

function scheduleTimelineRepair(sessionId: string, scope: RendererProfileScope): void {
  if (!timelineRepairIsRelevant(sessionId, scope)) return
  const existing = timelineRepairs.get(sessionId)
  if (existing && sameRendererProfileScope(existing.scope, scope)) return
  if (existing?.timer !== null && existing?.timer !== undefined && existing.timer >= 0) {
    window.clearTimeout(existing.timer)
  }
  const repair: TimelineRepairLease = {
    token: ++timelineRepairLeaseSequence,
    scope: { ...scope },
    attempts: 0,
    timer: null,
    loading: false
  }
  timelineRepairs.set(sessionId, repair)
  armTimelineRepair(sessionId, repair)
}

function armTimelineRepair(sessionId: string, repair: TimelineRepairLease): void {
  if (timelineRepairs.get(sessionId) !== repair || repair.loading || repair.timer !== null) return
  const delay = repair.attempts === 0
    ? 0
    : Math.min(
        TIMELINE_REPAIR_INITIAL_BACKOFF_MS * (2 ** Math.min(repair.attempts - 1, 16)),
        TIMELINE_REPAIR_MAX_BACKOFF_MS
      )
  let timerToken: number
  const run = () => {
    if (timelineRepairs.get(sessionId) !== repair || repair.timer !== timerToken) return
    repair.timer = null
    if (!timelineRepairIsRelevant(sessionId, repair.scope)) {
      if (timelineRepairs.get(sessionId) === repair) timelineRepairs.delete(sessionId)
      return
    }
    repair.loading = true
    void useAppStore.getState().reloadSession(sessionId)
      .catch(() => undefined)
      .finally(() => {
        if (timelineRepairs.get(sessionId) !== repair) return
        repair.loading = false
        if (!timelineRepairIsRelevant(sessionId, repair.scope)) {
          timelineRepairs.delete(sessionId)
          return
        }
        repair.attempts += 1
        armTimelineRepair(sessionId, repair)
      })
  }
  if (delay === 0) {
    timerToken = -(++timelineRepairTimerSequence)
    repair.timer = timerToken
    queueMicrotask(run)
  } else {
    timerToken = window.setTimeout(run, delay)
    repair.timer = timerToken
  }
}

function timelineRepairIsRelevant(sessionId: string, scope: RendererProfileScope): boolean {
  const state = useAppStore.getState()
  return profileScopeMatches(scope, state)
    && state.connected
    && visibleChatSessionIds(state.chatPanes).includes(sessionId)
    && state.snapshots[sessionId]?.historyDiscontinuity === true
}

function cancelTimelineRepair(sessionId: string): void {
  const repair = timelineRepairs.get(sessionId)
  if (!repair) return
  if (repair.timer !== null && repair.timer >= 0) window.clearTimeout(repair.timer)
  if (timelineRepairs.get(sessionId) === repair) timelineRepairs.delete(sessionId)
}

function sameRendererProfileScope(left: RendererProfileScope, right: RendererProfileScope): boolean {
  return left.profileId === right.profileId
    && left.profileGeneration === right.profileGeneration
    && left.switchEpoch === right.switchEpoch
}

function queuedTurnsRequestIsCurrent(sessionId: string, request: number): boolean {
  return queuedTurnsRequestLeases.get(sessionId) === request
}

function invalidateQueuedTurnsRequests(sessionId: string): void {
  queuedTurnsRequestLeases.delete(sessionId)
}

function isStrictTimelineTailAppend(previous: Event[], incoming: Event[]): boolean {
  const previousLastSeq = previous.at(-1)?.seq
  return previous.length === 0
    ? incoming.length > 0
    : incoming.length > 0 && incoming.every((event, index) => (
        previousLastSeq! < event.seq
        && (index === 0 || incoming[index - 1].seq <= event.seq)
      ))
}

/**
 * The projection cache validates ordinary appends in O(1) from its immutable
 * first/last boundary. Advance the source generation only for the rare prefix
 * correction that can preserve those same boundaries; prepends and trims are
 * already self-invalidating and must not remount Virtuoso's scroll anchor.
 */
function nextTimelineGeneration(
  previous: SessionSnapshot,
  events: Event[],
  strictTailAppend: boolean
): number | undefined {
  if (events === previous.events || strictTailAppend || events.length < previous.events.length || !previous.events.length) {
    return previous.generation
  }
  if (events[0] !== previous.events[0] || events[previous.events.length - 1] !== previous.events.at(-1)) {
    return previous.generation
  }
  for (let index = 1; index < previous.events.length - 1; index += 1) {
    if (events[index] !== previous.events[index]) return (previous.generation ?? 0) + 1
  }
  return previous.generation
}

export function mergeSnapshots(previous: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  if (!previous) return next
  if (previous.historyDiscontinuity) {
    // Until a full replacement is accepted atomically, a merge page cannot
    // prove adjacency to the retained renderer window. Keep its timeline and
    // cursor intact; non-history metadata can still move forward safely.
    const session = jsonEquivalent(previous.session, next.session) ? previous.session : next.session
    const queuedTurns = stableArray(previous.queuedTurns, next.queuedTurns)
    const files = mergeFiles(previous.files, next.files)
    const filesTotal = Math.max(previous.filesTotal, next.filesTotal)
    const eventsTotal = Math.max(previous.eventsTotal ?? 0, next.eventsTotal ?? 0, previous.events.length) || null
    if (
      session === previous.session
      && queuedTurns === previous.queuedTurns
      && files === previous.files
      && filesTotal === previous.filesTotal
      && eventsTotal === previous.eventsTotal
    ) return previous
    return {
      ...previous,
      session,
      queuedTurns,
      files,
      filesTotal,
      eventsTotal,
      historyDiscontinuity: true
    }
  }
  const events = mergeEvents(previous.events, next.events)
  const eventPrefixStable = events === previous.events || isStrictTimelineTailAppend(previous.events, next.events)
  const files = mergeFiles(previous.files, next.files)
  const queuedTurns = stableArray(previous.queuedTurns, next.queuedTurns)
  const session = jsonEquivalent(previous.session, next.session) ? previous.session : next.session
  const eventsTotal = next.eventsTotal ?? previous.eventsTotal
  const historyVerified = next.historyVerified ?? previous.historyVerified
  const nextTimelineBefore = mergedTimelineBefore(previous, next)
  const semanticPaging = next.semanticPaging ?? previous.semanticPaging
  if (events === previous.events
    && files === previous.files
    && session === previous.session
    && queuedTurns === previous.queuedTurns
    && previous.hasMoreEvents === next.hasMoreEvents
    && previous.historyVerified === historyVerified
    && previous.eventsTotal === eventsTotal
    && previous.nextTimelineBefore === nextTimelineBefore
    && previous.semanticPaging === semanticPaging) return previous
  return {
    ...next,
    session,
    queuedTurns,
    viewState: next.viewState ?? previous.viewState,
    events,
    files,
    historyVerified,
    eventsTotal,
    nextTimelineBefore,
    semanticPaging,
    generation: nextTimelineGeneration(previous, events, eventPrefixStable),
    timelineListGeneration: previous.timelineListGeneration ?? 0
  }
}

/**
 * A replace page is authoritative for its covered tail, not for older history
 * the renderer may have paged beyond the main-process cache. Retain that older
 * prefix only when an identical event identity/sequence proves the two windows
 * overlap; sequence ranges alone are not proof because compact timelines omit
 * internal event types.
 */
export function replaceSnapshot(
  previous: SessionSnapshot | undefined,
  next: SessionSnapshot,
  acceptAuthoritativeDiscontinuity = false
): SessionSnapshot {
  const discontinuous = timelineReplacementIsDiscontinuous(previous, next)
  if (
    !acceptAuthoritativeDiscontinuity
    && discontinuous
    && previous
  ) {
    // Keep the currently proven window intact while the caller performs a
    // direct authoritative refetch. Concatenating disjoint windows fabricates
    // adjacency; applying the tail here silently discards paged history.
    return {
      ...previous,
      session: next.session,
      queuedTurns: stableArray(previous.queuedTurns, next.queuedTurns),
      files: mergeFiles(previous.files, next.files),
      filesTotal: Math.max(previous.filesTotal, next.filesTotal),
      eventsTotal: Math.max(previous.eventsTotal ?? 0, next.eventsTotal ?? 0, previous.events.length) || null,
      historyDiscontinuity: true
    }
  }
  const nextFirstSeq = next.events[0]?.seq
  const nextIdentity = new Set(next.events.map(event => `${event.seq}:${event.id}`))
  const hasProvenOverlap = Boolean(previous?.events.some(event => nextIdentity.has(`${event.seq}:${event.id}`)))
  const retainedPrefix = previous && nextFirstSeq != null && hasProvenOverlap
    ? previous.events.filter(event => event.seq < nextFirstSeq)
    : []
  const events = retainedPrefix.length ? mergeEvents(retainedPrefix, next.events) : next.events
  return {
    ...next,
    events,
    historyDiscontinuity: false,
    hasMoreEvents: retainedPrefix.length
      ? previous!.hasMoreEvents
      : next.hasMoreEvents,
    eventsTotal: retainedPrefix.length
      ? Math.max(next.eventsTotal ?? 0, previous?.eventsTotal ?? 0, events.length) || null
      : next.eventsTotal ?? previous?.eventsTotal,
    nextTimelineBefore: retainedPrefix.length
      ? previous!.nextTimelineBefore
      : next.nextTimelineBefore !== undefined
        ? next.nextTimelineBefore
        : previous?.nextTimelineBefore,
    semanticPaging: next.semanticPaging ?? previous?.semanticPaging,
    viewState: next.viewState ?? previous?.viewState,
    generation: (previous?.generation ?? 0) + 1,
    // Ordinary authoritative refreshes and overlapping tail replacements stay
    // in the same virtual list. Only accepting a replacement with no proven
    // event overlap invalidates the old scroll/measurement coordinate space.
    timelineListGeneration: discontinuous
      ? (previous?.timelineListGeneration ?? 0) + 1
      : previous?.timelineListGeneration ?? 0
  }
}

export function timelineReplacementIsDiscontinuous(
  previous: SessionSnapshot | undefined,
  next: SessionSnapshot
): boolean {
  if (!previous?.events.length) return false
  if (!next.events.length) {
    return !(next.historyVerified === true && next.eventsTotal === 0)
  }
  const previousIdentity = new Set(previous.events.map(event => `${event.seq}:${event.id}`))
  return !next.events.some(event => previousIdentity.has(`${event.seq}:${event.id}`))
}

function mergedTimelineBefore(
  previous: SessionSnapshot,
  next: SessionSnapshot
): number | null | undefined {
  const incoming = next.nextTimelineBefore
  const retained = previous.nextTimelineBefore
  if (incoming === undefined) return retained
  if (retained === undefined) return incoming

  const previousFirst = previous.events[0]?.seq
  const incomingAddsOlderHistory = previousFirst != null
    && next.events.some(event => event.seq < previousFirst)
  if (incomingAddsOlderHistory) return incoming

  // A verified complete response can prove there is no older history. A
  // delta/stream merge cannot: its main-process cursor may simply predate the
  // renderer's compacted boundary.
  if (incoming === null) {
    return next.historyVerified === true && next.hasMoreEvents === false
      ? null
      : retained
  }
  if (retained === null) return retained
  return retained
}

function touchSnapshot(sessionId: string): void {
  snapshotAccess.set(sessionId, ++snapshotAccessCounter)
}

export function cacheSnapshot(
  current: Record<string, SessionSnapshot>,
  sessionId: string,
  snapshot: SessionSnapshot,
  protectedSessionIds: string | null | readonly string[]
): Record<string, SessionSnapshot> {
  const isolated = isolateSessionSnapshot(snapshot, sessionId)
  if (!isolated) return current
  touchSnapshot(sessionId)
  const protectedIds = new Set(Array.isArray(protectedSessionIds)
    ? protectedSessionIds
    : protectedSessionIds ? [protectedSessionIds] : [])
  const resident = protectedIds.has(sessionId) ? isolated : compactSnapshotEvents(isolated)
  const next = { ...current, [sessionId]: resident }
  const removable = Object.keys(next)
    .filter(id => !protectedIds.has(id) && id !== sessionId)
    .sort((a, b) => (snapshotAccess.get(a) ?? 0) - (snapshotAccess.get(b) ?? 0))
  while (Object.keys(next).length > MAX_MEMORY_SNAPSHOTS && removable.length) {
    const id = removable.shift()
    if (!id) break
    delete next[id]
    snapshotAccess.delete(id)
  }
  return next
}

export function compactSnapshotEvents(snapshot: SessionSnapshot, limit = MAX_BACKGROUND_SNAPSHOT_EVENTS): SessionSnapshot {
  if (snapshot.events.length <= limit) return snapshot
  const units = timelineSemanticUnits(snapshot.events)
  if (!units.length) {
    return {
      ...snapshot,
      events: snapshot.events.slice(-limit),
      nextTimelineBefore: snapshot.events.at(-limit)?.seq ?? snapshot.nextTimelineBefore,
      hasMoreEvents: true
    }
  }
  const newestUnit = units.at(-1)
  if (newestUnit && newestUnit.events.length > limit) {
    // The newest semantic unit cannot be split without creating a paging hole,
    // and retaining it would defeat the background-memory bound. Store an
    // explicit empty sentinel instead; selecting this session will recognize
    // eventsTotal and fetch an authoritative tail before rendering history.
    return {
      ...snapshot,
      events: [],
      historyVerified: false,
      eventsTotal: Math.max(1, snapshot.eventsTotal ?? 0, snapshot.events.length),
      nextTimelineBefore: null,
      hasMoreEvents: true
    }
  }
  const selected: typeof units = []
  let rawEventCount = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    // A semantic unit is the smallest page-safe history boundary. Sampling
    // its interior would leave omitted events newer than nextTimelineBefore,
    // so a later reselect could never retrieve them through older paging.
    if (selected.length && rawEventCount + unit.events.length > limit) break
    selected.unshift(unit)
    rawEventCount += unit.events.length
    if (rawEventCount >= limit) break
  }
  const selectedEvents = selected.flatMap(unit => unit.events).sort((left, right) => left.seq - right.seq)
  return {
    ...snapshot,
    events: selectedEvents,
    nextTimelineBefore: units.length > selected.length
      ? selected[0]?.anchorSeq ?? snapshot.nextTimelineBefore
      : snapshot.nextTimelineBefore,
    hasMoreEvents: true
  }
}

function pruneArchivedSnapshots(current: Record<string, SessionSnapshot>, sessions: Session[], protectedSessionIds: readonly string[]): Record<string, SessionSnapshot> {
  const protectedIds = new Set(protectedSessionIds)
  const archived = new Set(sessions.filter(session => session.archived && !protectedIds.has(session.id)).map(session => session.id))
  if (![...archived].some(id => current[id])) return current
  const next = { ...current }
  for (const id of archived) {
    delete next[id]
    snapshotAccess.delete(id)
  }
  return next
}
export function syncSnapshotSessions(current: Record<string, SessionSnapshot>, sessions: Session[]): Record<string, SessionSnapshot> {
  const byId = new Map(sessions.map(session => [session.id, session]))
  let next = current
  for (const [id, snapshot] of Object.entries(current)) {
    const session = byId.get(id)
    // Background session refreshes deserialize every session into a fresh
    // object. Keep the snapshot (and therefore the virtual timeline) stable
    // when its actual session metadata did not change. This refresh runs often
    // on large remote workspaces and used to interrupt wheel/input frames even
    // though no visible timeline data changed.
    if (!session || session === snapshot.session || jsonEquivalent(session, snapshot.session)) continue
    if (next === current) next = { ...current }
    next[id] = { ...snapshot, session }
  }
  return next
}
// Most live timeline updates append one event to the array returned by the
// previous merge. Keep that array's stable-id index beside it so the duplicate
// check stays proportional to the incoming batch instead of rescanning the
// complete chat history on every server event.
const eventIndexByArray = new WeakMap<Event[], Map<string, Event>>()

function indexedEvents(events: Event[]): Map<string, Event> {
  const cached = eventIndexByArray.get(events)
  if (cached) return cached
  const index = new Map(events.map(event => [event.id, event]))
  eventIndexByArray.set(events, index)
  return index
}

function rememberEventIndex(events: Event[], index: Map<string, Event>): Event[] {
  eventIndexByArray.set(events, index)
  return events
}

export function mergeEvents(a: Event[], b: Event[]): Event[] {
  if (!b.length) return a
  if (!a.length) {
    indexedEvents(b)
    return b
  }
  const firstA = a[0].seq; const lastA = a[a.length - 1].seq
  const firstB = b[0].seq; const lastB = b[b.length - 1].seq
  const existing = indexedEvents(a)
  const hasStableIDOverlap = b.some(event => existing.has(event.id))
  if (!hasStableIDOverlap && lastA < firstB) {
    const byId = new Map(existing)
    for (const event of b) byId.set(event.id, event)
    return rememberEventIndex([...a, ...b], byId)
  }
  if (!hasStableIDOverlap && lastB < firstA) {
    const byId = new Map(existing)
    for (const event of b) byId.set(event.id, event)
    return rememberEventIndex([...b, ...a], byId)
  }
  let byId: Map<string, Event> | null = null
  for (const event of b) {
    const previous = (byId ?? existing).get(event.id)
    const incoming = previous ? mergeProviderInterruptionEvent(previous, event) : event
    if (!previous || previous !== incoming && !jsonEquivalent(previous, incoming)) {
      byId ??= new Map(existing)
      byId.set(incoming.id, incoming)
    }
  }
  if (!byId) return a
  return rememberEventIndex(
    [...byId.values()].sort((x, y) => x.seq - y.seq),
    byId
  )
}

export function boundedDeferredTimelineEvents(
  previous: Event[],
  incoming: Event[],
  previouslyOverflowed = false
): { events: Event[]; overflowed: boolean } {
  const merged = mergeEvents(previous, incoming)
  return {
    events: merged.slice(-MAX_DEFERRED_TIMELINE_EVENTS),
    overflowed: previouslyOverflowed || merged.length > MAX_DEFERRED_TIMELINE_EVENTS
  }
}
function upsertEvent(events: Event[], event: Event): Event[] {
  const existing = events.findIndex(candidate => candidate.id === event.id)
  if (existing >= 0) {
    event = mergeProviderInterruptionEvent(events[existing], event)
    if (events[existing] === event) return events
    const next = [...events]
    next[existing] = event
    if (existing > 0 && next[existing - 1].seq > event.seq || existing < next.length - 1 && next[existing + 1].seq < event.seq) {
      next.sort((a, b) => a.seq - b.seq)
    }
    return next
  }
  const last = events.at(-1)
  if (!last || last.seq <= event.seq) return [...events, event]
  return mergeEvents(events, [event])
}
function mergeFiles(a: AgentFile[], b: AgentFile[]): AgentFile[] {
  if (!b.length) return a
  if (!a.length) return b
  let changed = false
  const byId = new Map(a.map(file => [file.id, file]))
  for (const file of b) {
    const previous = byId.get(file.id)
    if (!previous) { byId.set(file.id, file); changed = true }
    else if (!jsonEquivalent(previous, file)) { byId.set(file.id, file); changed = true }
  }
  return changed ? [...byId.values()].sort((x, y) => (y.seq ?? 0) - (x.seq ?? 0)) : a
}
function mergeUploadPaths(a: NativeFileRef[], b: NativeFileRef[]): NativeFileRef[] {
  return [...new Map([...a, ...b].map(file => [file.path, file])).values()]
}
function mergeReadStateReceipt(
  current: Session,
  receipt: Session,
  action: 'read' | 'unread'
): Session {
  const currentSequence = current.last_read_agent_event_seq ?? 0
  const receiptSequence = receipt.last_read_agent_event_seq ?? 0
  const useReceiptTimestamp = receiptSequence >= currentSequence
  return {
    ...current,
    last_read_agent_event_seq: Math.max(currentSequence, receiptSequence),
    last_read_agent_event_at: useReceiptTimestamp
      ? receipt.last_read_agent_event_at ?? current.last_read_agent_event_at
      : current.last_read_agent_event_at,
    manual_unread: action === 'unread'
  }
}
function stableArray<T>(previous: T[], next: T[]): T[] { return jsonEquivalent(previous, next) ? previous : next }
function healthActiveSessionIDs(health?: Health | null): Set<string> { return new Set(health?.active ?? health?.active_sessions ?? []) }
function healthWithLiveActivity(health: Health | null, sessionId: string, hint: LiveActivityHint): Health | null {
  if (!health) return health
  const ids = healthActiveSessionIDs(health)
  if (hint.active) ids.add(sessionId)
  else ids.delete(sessionId)
  let runs = health.active_runs
  if (runs || typeof hint.runId === 'string') {
    runs = (runs ?? []).filter(row => row.session_id !== sessionId
      || hint.active && (hint.runId === undefined || row.run_id === hint.runId))
    if (hint.active && typeof hint.runId === 'string' && !runs.some(row => row.session_id === sessionId)) {
      runs.push({ session_id: sessionId, run_id: hint.runId })
    }
  }
  const next: Health = { ...health, active: [...ids],
    ...(health.active_sessions ? { active_sessions: [...ids] } : {}),
    ...(runs ? { active_runs: runs } : {}) }
  return jsonEquivalent(health, next) ? health : next
}
function healthIsCompatible(health?: Health | null): boolean {
  return (health?.api_contract_version ?? MINIMUM_AGENT_API_CONTRACT) >= MINIMUM_AGENT_API_CONTRACT
}

async function findNewQueuedTurn(sessionId: string, prompt: string, previousIDs: ReadonlySet<string>, scope: RendererProfileScope): Promise<string | null> {
  const request = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
  const turns = await window.agentsDock.queue.list(sessionId)
  if (!profileScopeMatches(scope)) return null
  const state = useAppStore.getState()
  const applied = state.applyQueuedTurnsResponse(sessionId, request, turns)
  const currentTurns = applied ? turns : state.snapshots[sessionId]?.queuedTurns ?? []
  const newTurns = currentTurns.filter(turn => !previousIDs.has(turn.queued_id))
  const cleanPrompt = prompt.trim()
  return newTurns.find(turn => (turn.display_prompt || turn.prompt).trim() === cleanPrompt)?.queued_id
    ?? (newTurns.length === 1 ? newTurns[0].queued_id : null)
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => { window.clearTimeout(timer); resolve(value) },
      error => { window.clearTimeout(timer); reject(error) }
    )
  })
}

function logTimelineSelection(message: string, details: Record<string, unknown>): void {
  try {
    const pending = window.agentsDock?.native?.log?.('timeline-selection', message, details)
    void pending?.catch(() => undefined)
  } catch { /* diagnostics must never affect chat selection */ }
}

function nextSelectionLease(sessionId: string): number {
  const request = ++selectionEpoch
  selectionLeases.set(sessionId, request)
  return request
}

function selectionRequestMatches(request: number, sessionId: string, scope: RendererProfileScope): boolean {
  const state = useAppStore.getState()
  return selectionLeases.get(sessionId) === request
    && visibleChatSessionIds(state.chatPanes).includes(sessionId)
    && profileScopeMatches(scope, state)
}

function subscribeToTimeline(sessionId: string, after: number, request: number, scope: RendererProfileScope): void {
  void Promise.resolve()
    .then(() => {
      if (!selectionRequestMatches(request, sessionId, scope)) return
      timelineSubscriptions.add(sessionId)
      return window.agentsDock.timeline.subscribe(sessionId, after)
    })
    .catch(error => {
      if (selectionLeases.get(sessionId) === request) timelineSubscriptions.delete(sessionId)
      if (!profileScopeMatches(scope)) return
      logTimelineSelection('timeline subscription failed', { sessionId, request, after, error: errorMessage(error) })
    })
}

export function updateActiveSessions(current: Set<string>, event: Event): Set<string> {
  return updateActiveSessionsWithHint(current, event)
}

function updateActiveSessionsWithHint(current: Set<string>, event: Event, activeHint?: boolean): Set<string> {
  if (isImportedProviderControlMetadata(event)) return current
  // Import batches describe historical turns, not live provider ownership.
  // Their synthetic terminal must not clear a different run that is working
  // now; conversely, importing genuine old user text cannot start a new run.
  if (isImportedHistoryRecord(event)) return current
  // Native steer closes only AgentsDock's previous logical run. Codex keeps
  // the provider turn alive, so treating this as a real stop makes the header
  // flash idle before the steered logical run is projected.
  if (isNativeSteerTransitionStop(event)) return current
  const terminal = event.type === 'turn_finished' || event.type === 'turn_stopped'
  if (event.type !== 'turn_started' && !terminal) return current
  const desired = activeHint ?? event.type === 'turn_started'
  const active = current.has(event.session_id)
  if (desired === active) return current
  const next = new Set(current)
  if (desired) next.add(event.session_id)
  else next.delete(event.session_id)
  return next
}

function eventAffectsQueuedTurns(event: Event): boolean {
  if (isImportedProviderControlMetadata(event)) return false
  if (event.positions?.length) return true
  if (event.type === 'turn_queue_paused') {
    return Boolean(event.queued_id || event.queued_ids?.length)
  }
  if (!event.queued_id) return false
  return event.type === 'turn_queued'
    || event.type === 'turn_queue_delivery_fenced'
    || event.type === 'turn_unqueued'
    || event.type === 'turn_started'
    || isNativeGoalSteerEvent(event)
    || event.type === 'turn_queue_run_now'
    || event.type === 'turn_queue_updated'
}

/**
 * Internal turn queue events stay hidden so old clients cannot render a
 * provider wrapper as user-authored text. The safe cross-chat lifecycle is the
 * signal for modern clients to refetch the target chat's public queue instead.
 */
export function crossChatQueueRefreshSessionId(event: Event): string | null {
  if (!event.queued_id || event.session_id !== event.target_session_id) return null
  if (
    !event.type.startsWith('cross_chat_handoff_')
    && !event.type.startsWith('cross_chat_exchange_leg_')
    && !isAsyncCrossChatMessage(event)
  ) return null
  return event.session_id
}

function markCrossChatQueueRefreshFailed(sessionId: string, scope: RendererProfileScope): void {
  if (!profileScopeMatches(scope)) return
  pendingCrossChatQueueRefreshes.set(sessionId, {
    scope: { ...scope },
    retryAfter: Date.now() + CROSS_CHAT_QUEUE_REFRESH_RECOVERY_COOLDOWN_MS
  })
  useAppStore.setState(state => {
    const current = state.syncBySession[sessionId]
    const focused = state.selectedSessionId === sessionId
    const websocketUnavailable = state.health?.websocket_runtime === false
    const currentError = current?.error ?? (focused ? state.syncError : null)
    const nextSync: SessionSyncState = websocketUnavailable
      ? { status: 'error', error: WEBSOCKET_RUNTIME_ERROR }
      : {
          status: current?.status ?? (focused ? state.syncStatus : state.connected ? 'syncing' : 'offline'),
          error: currentError && currentError !== CROSS_CHAT_QUEUE_REFRESH_ERROR
            ? currentError
            : CROSS_CHAT_QUEUE_REFRESH_ERROR
        }
    return {
      syncBySession: { ...state.syncBySession, [sessionId]: nextSync },
      ...(focused
        ? { syncSessionId: sessionId, syncStatus: nextSync.status, syncError: nextSync.error }
        : {})
    }
  })
}

function clearCrossChatQueueRefreshFailure(sessionId: string): void {
  pendingCrossChatQueueRefreshes.delete(sessionId)
  useAppStore.setState(state => {
    const current = state.syncBySession[sessionId]
    const focused = state.selectedSessionId === sessionId
    if (state.health?.websocket_runtime === false) {
      const nextSync: SessionSyncState = { status: 'error', error: WEBSOCKET_RUNTIME_ERROR }
      return {
        syncBySession: { ...state.syncBySession, [sessionId]: nextSync },
        ...(focused ? { syncSessionId: sessionId, syncStatus: nextSync.status, syncError: nextSync.error } : {})
      }
    }
    if (current?.error !== CROSS_CHAT_QUEUE_REFRESH_ERROR) return state
    const nextSync: SessionSyncState = { ...current, error: null }
    return {
      syncBySession: { ...state.syncBySession, [sessionId]: nextSync },
      ...(focused && state.syncError === CROSS_CHAT_QUEUE_REFRESH_ERROR
        ? { syncSessionId: sessionId, syncStatus: nextSync.status, syncError: null }
        : {})
    }
  })
}

function retryPendingCrossChatQueueRefreshes(
  trigger: 'connection' | 'live',
  sessionIds?: readonly string[]
): void {
  const state = useAppStore.getState()
  if (!state.connected) return
  const selected = sessionIds ? new Set(sessionIds) : null
  const now = Date.now()
  for (const [sessionId, pending] of pendingCrossChatQueueRefreshes) {
    if (selected && !selected.has(sessionId)) continue
    if (!profileScopeMatches(pending.scope, state)) {
      pendingCrossChatQueueRefreshes.delete(sessionId)
      continue
    }
    if (trigger === 'live' && now < pending.retryAfter) continue
    pendingCrossChatQueueRefreshes.set(sessionId, {
      ...pending,
      retryAfter: now + CROSS_CHAT_QUEUE_REFRESH_RECOVERY_COOLDOWN_MS
    })
    refreshCrossChatQueue(sessionId, pending.scope)
  }
}

function refreshCrossChatQueue(sessionId: string, scope: RendererProfileScope): void {
  const pending = pendingCrossChatQueueRefreshes.get(sessionId)
  if (pending && profileScopesEqual(pending.scope, scope)) {
    pendingCrossChatQueueRefreshes.set(sessionId, {
      ...pending,
      retryAfter: Date.now() + CROSS_CHAT_QUEUE_REFRESH_RECOVERY_COOLDOWN_MS
    })
  }
  const request = useAppStore.getState().beginQueuedTurnsRequest(sessionId)
  void (async () => {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= CROSS_CHAT_QUEUE_REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
      if (!queuedTurnsRequestIsCurrent(sessionId, request) || !profileScopeMatches(scope)) return
      try {
        const turns = await window.agentsDock.queue.list(sessionId)
        if (!profileScopeMatches(scope)) return
        if (useAppStore.getState().applyQueuedTurnsResponse(sessionId, request, turns)) {
          clearCrossChatQueueRefreshFailure(sessionId)
        }
        return
      } catch (error) {
        lastError = error
        if (!queuedTurnsRequestIsCurrent(sessionId, request) || !profileScopeMatches(scope)) return
        const delay = CROSS_CHAT_QUEUE_REFRESH_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !useAppStore.getState().connected) break
        await new Promise<void>(resolve => window.setTimeout(resolve, delay))
      }
    }
    if (!queuedTurnsRequestIsCurrent(sessionId, request) || !profileScopeMatches(scope)) return
    invalidateQueuedTurnsRequests(sessionId)
    markCrossChatQueueRefreshFailed(sessionId, scope)
    logTimelineSelection('cross-chat queue refresh failed', { sessionId, error: errorMessage(lastError) })
  })()
}

function enqueueLiveEvent(event: Event, activeHint?: LiveActivityHint): void {
  const scope = captureProfileScope()
  let pending = pendingLiveEvents.get(event.session_id)
  if (pending && !profileScopesEqual(pending.scope, scope)) {
    pendingLiveEventCount -= pending.events.length
    pendingLiveEvents.delete(event.session_id)
    pending = undefined
  }
  // Reconcile proven repairs before stale legacy fields can invalidate a
  // queue request, including a corrected event still waiting in this batch.
  const snapshot = useAppStore.getState().snapshots[event.session_id]
  const resident = snapshot ? indexedEvents(snapshot.events).get(event.id) : undefined
  if (resident) event = mergeProviderInterruptionEvent(resident, event)
  const pendingIndex = pending?.eventIndexById.get(event.id)
  if (pending && pendingIndex !== undefined) event = mergeProviderInterruptionEvent(pending.events[pendingIndex], event)
  if (activeHint) liveEventActivityHints.set(event, activeHint)
  liveEventActivityEpochs.set(event, liveActivityAuthorityEpoch)
  const queueRefreshSessionId = crossChatQueueRefreshSessionId(event)
  if (eventAffectsQueuedTurns(event)) invalidateQueuedTurnsRequests(event.session_id)
  if (queueRefreshSessionId) invalidateQueuedTurnsRequests(queueRefreshSessionId)
  if (!pending) {
    pending = {
      scope,
      sessionId: event.session_id,
      events: [],
      eventIndexById: new Map<string, number>()
    }
    pendingLiveEvents.set(event.session_id, pending)
  }
  if (upsertPendingLiveEvent(pending, event)) {
    pendingLiveEventCount += 1
  }

  // This is an ingress bound, not merely an idle-timer hint. A synchronous
  // IPC burst can otherwise append thousands of events before the browser can
  // run a timer, leaving one enormous merge on the renderer thread. Drain at
  // the exact boundary so every store commit handles at most this many events.
  if (pendingLiveEventCount >= LIVE_EVENT_MAX_DEFERRED_COUNT) {
    if (liveEventTimer != null) window.clearTimeout(liveEventTimer)
    liveEventTimer = null
    flushLiveEvents(true)
    return
  }

  if (liveEventRequiresPromptFlush(event)) {
    // The first urgent event must be observable on the next task; do not make
    // it wait for the ordinary 40 ms live-event batch.
    if (liveEventTimer != null) window.clearTimeout(liveEventTimer)
    liveEventTimer = null
    scheduleLiveEventFlush(0)
    return
  }
  scheduleLiveEventFlush()
}

function upsertPendingLiveEvent(batch: PendingLiveEventBatch, event: Event): boolean {
  const existingIndex = batch.eventIndexById.get(event.id)
  if (existingIndex !== undefined) {
    const previous = batch.events[existingIndex]
    const activeHint = liveEventActivityHints.get(event)
    const activityEpoch = liveEventActivityEpochs.get(event)
    event = mergeProviderInterruptionEvent(previous, event)
    if (previous === event || jsonEquivalent(previous, event)) {
      if (activeHint) liveEventActivityHints.set(previous, activeHint)
      if (activityEpoch !== undefined) liveEventActivityEpochs.set(previous, activityEpoch)
      return false
    }
    if (activeHint) liveEventActivityHints.set(event, activeHint)
    if (activityEpoch !== undefined) liveEventActivityEpochs.set(event, activityEpoch)
    batch.events[existingIndex] = event
    if (
      (existingIndex > 0 && batch.events[existingIndex - 1].seq > event.seq)
      || (existingIndex < batch.events.length - 1 && batch.events[existingIndex + 1].seq < event.seq)
    ) {
      batch.events.sort((left, right) => left.seq - right.seq)
      rebuildPendingLiveEventIndex(batch)
    }
    return false
  }
  batch.eventIndexById.set(event.id, batch.events.length)
  batch.events.push(event)
  if (batch.events.length > 1 && batch.events[batch.events.length - 2].seq > event.seq) {
    batch.events.sort((left, right) => left.seq - right.seq)
    rebuildPendingLiveEventIndex(batch)
  }
  return true
}

function rebuildPendingLiveEventIndex(batch: PendingLiveEventBatch): void {
  batch.eventIndexById = new Map(batch.events.map((event, index) => [event.id, index]))
}

function pendingLiveEventsRequirePromptFlush(): boolean {
  for (const batch of pendingLiveEvents.values()) {
    if (batch.events.some(liveEventRequiresPromptFlush)) return true
  }
  return false
}

function takePendingLiveEventBatches(urgentOnly: boolean): LiveEventBatch[] {
  if (!urgentOnly) {
    const batches = [...pendingLiveEvents.values()].map(({ scope, sessionId, events, overflowed }) => ({
      scope, sessionId, events, overflowed
    }))
    pendingLiveEvents.clear()
    pendingLiveEventCount = 0
    return batches
  }

  const batches: LiveEventBatch[] = []
  for (const [sessionId, batch] of pendingLiveEvents) {
    let lastUrgentIndex = -1
    for (let index = 0; index < batch.events.length; index += 1) {
      if (liveEventRequiresPromptFlush(batch.events[index])) lastUrgentIndex = index
    }
    if (lastUrgentIndex < 0) continue
    const taken = batch.events.slice(0, lastUrgentIndex + 1)
    const remainder = batch.events.slice(lastUrgentIndex + 1)
    batches.push({
      scope: batch.scope,
      sessionId,
      events: taken,
      overflowed: batch.overflowed
    })
    pendingLiveEventCount -= taken.length
    if (remainder.length) {
      batch.events = remainder
      rebuildPendingLiveEventIndex(batch)
    } else {
      pendingLiveEvents.delete(sessionId)
    }
  }
  return batches
}

function scheduleLiveEventFlush(delayMs = LIVE_EVENT_BATCH_MS): void {
  if (liveEventTimer != null) return
  liveEventTimer = window.setTimeout(flushLiveEvents, delayMs)
}

function flushLiveEvents(forceAll = false): void {
  liveEventTimer = null
  const urgentOnly = !forceAll && pendingLiveEventsRequirePromptFlush()
  const mayInterruptInput = !forceAll && pendingLiveEventsInterruptInput()
  if (!forceAll && !mayInterruptInput) {
    const deferral = liveEventInteractionDeferralMs()
    if (deferral > 0) {
      scheduleLiveEventFlush(deferral)
      return
    }
  }
  const batches = takePendingLiveEventBatches(urgentOnly)
  if (!batches.length) return
  const stateBeforeBatch = useAppStore.getState()
  const connectionRestored = !stateBeforeBatch.connected
    && healthIsCompatible(stateBeforeBatch.health)
    && stateBeforeBatch.health?.websocket_runtime !== false
    && batches.some(batch => (
      batch.sessionId === stateBeforeBatch.selectedSessionId
      && profileScopeMatches(batch.scope, stateBeforeBatch)
    ))
  if (connectionRestored) {
    agentRouteRefreshTokens.clear()
    agentRouteMutationTokens.clear()
    queuedTurnsRequestLeases.clear()
  }
  useAppStore.setState(state => {
    let activeSessionIds = state.activeSessionIds
    let health = state.health
    let snapshots = state.snapshots
    let connected = state.connected
    let connectionError = state.connectionError
    let syncStatus = state.syncStatus
    let syncError = state.syncError
    for (const batch of batches) {
      const { sessionId } = batch
      if (!profileScopeMatches(batch.scope, state)) continue
      const snapshot = snapshots[sessionId]
      const existingEvents = snapshot ? indexedEvents(snapshot.events) : undefined
      const events = batch.events.map(event => {
        const previous = existingEvents?.get(event.id)
        const merged = previous ? mergeProviderInterruptionEvent(previous, event) : event
        const hint = liveEventActivityHints.get(event)
        if (hint) liveEventActivityHints.set(merged, hint)
        const epoch = liveEventActivityEpochs.get(event)
        if (epoch !== undefined) liveEventActivityEpochs.set(merged, epoch)
        return merged
      })
      if (
        sessionId === state.selectedSessionId
        && healthIsCompatible(state.health)
        && state.health?.websocket_runtime !== false
      ) {
        connected = true
        connectionError = null
        syncStatus = 'live'
        syncError = null
      }
      for (const event of events) {
        if ((liveEventActivityEpochs.get(event) ?? liveActivityAuthorityEpoch) < liveActivityAuthorityEpoch) continue
        const hint = liveEventActivityHints.get(event)
        activeSessionIds = updateActiveSessionsWithHint(activeSessionIds, event, hint?.active)
        if (hint && !isImportedHistoryRecord(event) && !isImportedProviderControlMetadata(event)) {
          health = healthWithLiveActivity(health, event.session_id, hint)
        }
      }
      if (!snapshot) continue
      if (snapshot.historyDiscontinuity) {
        const deferred = timelineDeferredEvents.get(sessionId)
        const bounded = boundedDeferredTimelineEvents(
          deferred && profileScopesEqual(deferred.scope, batch.scope) ? deferred.events : [],
          events,
          deferred?.overflowed === true || batch.overflowed === true
        )
        timelineDeferredEvents.set(sessionId, deferred && profileScopesEqual(deferred.scope, batch.scope)
          ? { scope: deferred.scope, ...bounded }
          : { scope: batch.scope, ...bounded })
        continue
      }
      let queuedTurns = snapshot.queuedTurns
      const files: AgentFile[] = []
      const isolatedEvents = events
        .map(event => isolateSessionEvent(event, sessionId))
        .filter((event): event is Event => Boolean(event))
      for (const event of isolatedEvents) {
        queuedTurns = reduceQueuedTurns(queuedTurns, event)
        if (event.file && agentFileBelongsToSession(event.file, sessionId)) files.push(event.file)
        if (event.artifact && agentFileBelongsToSession(event.artifact, sessionId)) files.push(event.artifact)
      }
      queuedTurns = stableArray(snapshot.queuedTurns, queuedTurns)
      const mergedFiles = mergeFiles(snapshot.files, files)
      const mergedEvents = mergeEvents(snapshot.events, isolatedEvents)
      const filesTotal = Math.max(snapshot.filesTotal, mergedFiles.length)
      if (
        mergedEvents === snapshot.events
        && queuedTurns === snapshot.queuedTurns
        && mergedFiles === snapshot.files
        && filesTotal === snapshot.filesTotal
      ) continue
      const nextSnapshot = {
        ...snapshot,
        events: mergedEvents,
        generation: nextTimelineGeneration(
          snapshot,
          mergedEvents,
          isStrictTimelineTailAppend(snapshot.events, isolatedEvents)
        ),
        queuedTurns,
        files: mergedFiles,
        filesTotal
      }
      snapshots = cacheSnapshot(
        snapshots,
        sessionId,
        nextSnapshot,
        visibleChatSessionIds(currentChatPaneLayout(state).panes)
      )
    }
    const connectionGeneration = connectionRestored
      ? state.connectionGeneration + 1
      : state.connectionGeneration
    if (
      activeSessionIds === state.activeSessionIds
      && health === state.health
      && snapshots === state.snapshots
      && connected === state.connected
      && connectionGeneration === state.connectionGeneration
      && connectionError === state.connectionError
      && syncStatus === state.syncStatus
      && syncError === state.syncError
    ) return state
    return {
      activeSessionIds,
      health,
      snapshots,
      connected,
      connectionGeneration,
      connectionError,
      syncStatus,
      syncError,
      ...(connectionRestored ? {
        agentRoutesBySession: {},
        agentRouteLoadingSessionIds: new Set<string>(),
        agentRouteErrorsBySession: {},
        revokingAgentRouteIds: new Set<string>()
      } : {})
    }
  })
  if (connectionRestored) {
    for (const sessionId of visibleChatSessionIds(useAppStore.getState().chatPanes)) {
      void useAppStore.getState().refreshAgentRoutes(sessionId)
    }
    retryPendingCrossChatQueueRefreshes('connection')
  }
  for (const batch of batches) {
    if (!profileScopeMatches(batch.scope)) continue
    for (const sessionId of new Set(batch.events.map(event => event.session_id))) {
      if (useAppStore.getState().snapshots[sessionId]?.historyDiscontinuity) {
        scheduleTimelineRepair(sessionId, batch.scope)
      }
    }
    const sessionIds = new Set(batch.events.map(crossChatQueueRefreshSessionId).filter((value): value is string => Boolean(value)))
    for (const sessionId of sessionIds) refreshCrossChatQueue(sessionId, batch.scope)
    retryPendingCrossChatQueueRefreshes('live', batch.events.map(event => event.session_id))
  }
  if (pendingLiveEventCount > 0) {
    scheduleLiveEventFlush(pendingLiveEventsRequirePromptFlush() ? 0 : LIVE_EVENT_BATCH_MS)
  }
}

function installLatencySensitiveInteractionTracking(): () => void {
  const markKeyboardInput = (event: globalThis.Event) => {
    if (isLatencySensitiveInputTarget(event.target)) lastLatencySensitiveInteractionAt = Date.now()
  }
  const markWheelInput = () => { lastLatencySensitiveInteractionAt = Date.now() }
  const wheelListenerOptions = { capture: true, passive: true } as const
  window.addEventListener('keydown', markKeyboardInput, true)
  window.addEventListener('beforeinput', markKeyboardInput, true)
  window.addEventListener('wheel', markWheelInput, wheelListenerOptions)
  return () => {
    window.removeEventListener('keydown', markKeyboardInput, true)
    window.removeEventListener('beforeinput', markKeyboardInput, true)
    window.removeEventListener('wheel', markWheelInput, wheelListenerOptions)
  }
}

interface LatencySensitiveInteractionQuietOptions {
  signal?: AbortSignal
  shouldContinue?: () => boolean
  quietMs?: number
}

/**
 * Wait until the renderer has both an idle slice and a short input-quiet
 * window. This reuses the timestamp maintained by the one app-wide input
 * tracker above; callers do not install listeners or publish state per key.
 * Passive work may wait indefinitely while the user remains active, and an
 * owning effect can abort the wait without leaving a timer or idle callback.
 */
export function waitForLatencySensitiveInteractionQuiet(
  options: LatencySensitiveInteractionQuietOptions = {}
): Promise<boolean> {
  const shouldContinue = options.shouldContinue ?? (() => true)
  const quietMs = Math.max(0, options.quietMs ?? LIVE_EVENT_INTERACTION_QUIET_MS)
  const signal = options.signal
  if (signal?.aborted || !shouldContinue()) return Promise.resolve(false)

  return new Promise(resolve => {
    let settled = false
    let timer: number | null = null
    let idleRequest: number | null = null

    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      if (timer !== null) window.clearTimeout(timer)
      if (idleRequest !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleRequest)
      }
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const requestIdle = () => {
      if (signal?.aborted || !shouldContinue()) {
        finish(false)
        return
      }
      const remainingQuietMs = quietMs - (Date.now() - lastLatencySensitiveInteractionAt)
      if (remainingQuietMs > 0) {
        timer = window.setTimeout(() => {
          timer = null
          requestIdle()
        }, remainingQuietMs)
        return
      }
      const onIdle = () => {
        idleRequest = null
        if (signal?.aborted || !shouldContinue()) {
          finish(false)
          return
        }
        // Input may have arrived while the idle request was pending. Recheck
        // the shared timestamp before releasing optional background work.
        if (Date.now() - lastLatencySensitiveInteractionAt < quietMs) {
          requestIdle()
          return
        }
        finish(true)
      }
      if (typeof window.requestIdleCallback === 'function') {
        idleRequest = window.requestIdleCallback(onIdle)
      } else {
        queueMicrotask(onIdle)
      }
    }
    const onAbort = () => finish(false)

    signal?.addEventListener('abort', onAbort, { once: true })
    requestIdle()
  })
}

function isLatencySensitiveInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.matches('textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]')
    || Boolean(target.closest('.xterm'))
}

function liveEventInteractionDeferralMs(now = Date.now()): number {
  if (!pendingLiveEventCount) return 0
  return Math.max(0, LIVE_EVENT_INTERACTION_QUIET_MS - (now - lastLatencySensitiveInteractionAt))
}

function pendingLiveEventsInterruptInput(): boolean {
  for (const batch of pendingLiveEvents.values()) {
    if (batch.events.some(event => event.type.startsWith('emergency_alert_'))) return true
  }
  return false
}

function liveEventRequiresPromptFlush(event: Event): boolean {
  if (isImportedProviderControlMetadata(event)) return false
  return eventAffectsQueuedTurns(event)
    || Boolean(crossChatQueueRefreshSessionId(event))
    || event.type === 'turn_started'
    || event.type === 'turn_finished'
    || event.type === 'turn_stopped'
    || event.type === 'error'
    || event.type.startsWith('emergency_alert_')
}

export { updateQueuedTurns } from '@shared/queue'
function profileScopesEqual(a: RendererProfileScope, b: RendererProfileScope): boolean {
  return a.profileId === b.profileId && a.profileGeneration === b.profileGeneration && a.switchEpoch === b.switchEpoch
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** The main process abandons a timeline fetch when a newer selection lease wins; that is not a load failure. */
export function isSupersededTimelineSelection(error: unknown): boolean {
  return /Timeline selection superseded/.test(errorMessage(error))
}
function forkErrorMessage(error: unknown): string {
  const message = errorMessage(error)
  return message.toLocaleLowerCase().includes('active turn before forking')
    ? RUNNING_FORK_UNAVAILABLE
    : message
}
function jsonEquivalent(a: unknown, b: unknown): boolean { return a === b || JSON.stringify(a) === JSON.stringify(b) }
function stringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left === right || left.size === right.size && [...left].every(value => right.has(value))
}
function chatReferencesPreferenceKey(sessionId: string): string { return `draft-chat-references:${sessionId}` }
function teamReferencesPreferenceKey(sessionId: string): string { return `draft-team-references:${sessionId}` }

function timelinePageNextBefore(page: TimelinePage): number | null {
  if (!page.has_more) return null
  return page.next_semantic_before
    ?? page.next_before
    ?? page.before
    ?? page.events[0]?.seq
    ?? null
}

function timelinePageSemanticPaging(page: TimelinePage): boolean | null {
  return page.semantic_paging ?? (page.semantic_item_count != null ? true : null)
}

export function snapshotNeedsAuthoritativeTail(snapshot: SessionSnapshot | undefined): boolean {
  if (!snapshot) return false
  if (snapshot.historyDiscontinuity) return true
  if (snapshot.events.some(eventMayRenderInTimeline)) return false
  if (snapshot.historyVerified && snapshot.events.length > 0 && snapshot.events.every(event =>
    isImportedClaudeControlCompanion(event) || isImportedCodexRuntimeContext(event)
  )) return false
  if ((snapshot.eventsTotal ?? 0) > 0) return true
  if (snapshot.historyVerified) return false
  return (snapshot.session.latest_agent_event_seq ?? 0) > 0 || snapshot.events.length > 0
}

function eventMayRenderInTimeline(event: Event): boolean {
  if (isImportedClaudeControlCompanion(event) || isImportedCodexRuntimeContext(event)) return false
  if (isImportedProviderInterruption(event)) return true
  if (event.type === 'turn_started' || isNativeGoalSteerEvent(event)) return Boolean(event.prompt?.trim() || event.file_ids?.length)
  if (event.type === 'assistant_text') return Boolean(event.text?.trim())
  if (event.type === 'turn_finished') return Boolean(event.result_text?.trim())
  if (event.type === 'reasoning_summary') return Boolean((event.text || String(event.message || '')).trim())
  if (event.type === 'tool_started' || event.type === 'tool_finished') return true
  if (event.type === 'artifact_created' || event.type === 'file_uploaded' || event.type === 'code_diff') return true
  if (event.type.startsWith('handoff_digest_') || event.type.startsWith('job_')) return true
  if (event.type.startsWith('cross_chat_')) return true
  if (isAsyncCrossChatMessage(event)) return true
  return event.type === 'error' || event.type.endsWith('_error') || event.is_error === true || Boolean(event.error)
}

function normalizeSessionPatch(patch: Partial<Session>) { return {
  title: patch.title,
  folder: patch.folder ?? undefined,
  cwd: patch.cwd ?? undefined,
  backend: patch.backend,
  codex_provider: patch.codex_provider,
  model: patch.model,
  effort: patch.effort,
  system_prompt: patch.system_prompt,
  codex_approval_policy: patch.codex_approval_policy,
  codex_sandbox_mode: patch.codex_sandbox_mode,
  codex_permission_profile: patch.codex_permission_profile,
  codex_approvals_reviewer: patch.codex_approvals_reviewer,
  claude_permission_mode: patch.claude_permission_mode,
  cursor_permission_mode: patch.cursor_permission_mode,
  provider_jobs_access: patch.provider_jobs_access ?? undefined,
  pinned: patch.pinned ?? undefined,
  archived: patch.archived ?? undefined
} }

export function interactiveClientCapabilities(
  session: Session | undefined,
  health: Health | null
): string[] {
  const capabilities = ['codex_interactive_v1', 'codex_goal_steer_v1']
  if (crossChatHandoffsAvailable(health)) capabilities.push('cross_chat_handoffs_v1')
  if (
    crossChatHandoffsAvailable(health)
    && Number(health?.capabilities?.cross_chat_handoffs_v1?.version ?? 1) >= 2
  ) capabilities.push('cross_chat_handoffs_v2')
  // Only exact v7 default-deny servers receive the v2 durable-grant token.
  if (agentCrossChatRoutesAvailable(health)) {
    capabilities.push(AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY)
  }
  if (asyncChatRouteAvailable(health)) capabilities.push(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY)
  const claude = health?.capabilities?.claude_controls
  const advertised = claude?.interactive_client_capability ?? claude?.interactive_capability
  if (
    session?.backend === 'claude'
    && claude?.available === true
    && advertised === 'claude_sdk_interactive_v1'
  ) capabilities.push('claude_sdk_interactive_v1')
  return capabilities
}

export function reconcileSessions(previous: Session[], incoming: Session[]): Session[] {
  if (!previous.length) return incoming
  const byId = new Map(previous.map(session => [session.id, session]))
  const next = incoming.map(session => {
    const existing = byId.get(session.id)
    return existing && jsonEquivalent(existing, session) ? existing : session
  })
  return next.length === previous.length && next.every((session, index) => session === previous[index]) ? previous : next
}
function applyPendingSessionPatches(sessions: Session[]): Session[] {
  return sessions.map(session => {
    const pending = pendingSessionPatches.get(session.id)
    return pending ? { ...session, ...pending.patch } : session
  })
}
function isUnread(session: Session): boolean { return Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0) }
function updateBadge(sessions: Session[]): void { void window.agentsDock.native.setBadge(sessions.filter(session => !session.archived && isUnread(session)).length) }

export function handleMenuCommand(command: string, get: () => AppState, set: (value: Partial<AppState>) => void): void {
  if (command.startsWith('open-session:')) { void get().selectSession(command.slice('open-session:'.length)); return }
  if (command === 'check-update') {
    window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'updates' }))
    get().setModal('appSettings', true)
    void window.agentsDock.updates.check()
  }
  else if (command === 'settings') get().setModal('appSettings', true)
  else if (command === 'chat-font-increase') nudgeChatFontSize(1)
  else if (command === 'chat-font-decrease') nudgeChatFontSize(-1)
  else if (command.startsWith('chat-font-size:')) setChatFontSize(Number(command.slice('chat-font-size:'.length)))
  else if (command.startsWith('chat-font-family:')) setChatFontFamily(command.slice('chat-font-family:'.length))
  else if (command === 'new-chat') {
    const activeSurfaceNew = new CustomEvent('agentsdock:new-active-surface', { cancelable: true })
    if (window.dispatchEvent(activeSurfaceNew)) void get().requestNewChat()
  }
  else if (command === 'open-workspace-file') {
    const sessionId = get().selectedSessionId
    const activeSurfaceQuickOpen = new CustomEvent('agentsdock:quick-open-active-surface', {
      cancelable: true,
      detail: { source: 'workspace-file', sessionId }
    })
    if (
      window.dispatchEvent(activeSurfaceQuickOpen)
      && !document.querySelector('[aria-modal="true"]')
    ) {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file', {
        detail: { sessionId }
      }))
    }
  }
  else if (command === 'undo' || command === 'redo') {
    const editHistory = new CustomEvent('agentsdock:edit-history', {
      cancelable: true,
      detail: { direction: command }
    })
    if (window.dispatchEvent(editHistory)) document.execCommand(command)
  }
  else if (command === 'attach-files') {
    const state = get()
    const scope = captureProfileScope(state)
    const sessionId = state.selectedSessionId
    if (!sessionId) return
    const targetIsCurrent = (): boolean => {
      const current = get()
      const visible = visibleChatSessionIds(current.chatPanes).includes(sessionId)
      const session = current.sessions.find(candidate => candidate.id === sessionId)
      return profileScopeMatches(scope, current) && visible && Boolean(session && !session.archived)
    }
    void (async () => {
      try {
        const files = await window.agentsDock.files.choose()
        if (!targetIsCurrent()) return
        await get().attachPathsForSession(sessionId, files)
      } catch (error) {
        if (targetIsCurrent()) get().setError(errorMessage(error))
      }
    })()
  }
  else if (command === 'find-chat') {
    if (get().modals.search) {
      window.dispatchEvent(new Event('agentsdock:focus-chat-switcher'))
      return
    }
    const blockingModal = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
      .some(modal => !modal.classList.contains('workspace-editor-palette'))
    if (blockingModal) return
    // Cmd/Ctrl+P always means chat switching. If Cmd/Ctrl+O left the file
    // picker open, dismiss that transient in the same render before opening
    // the chat switcher instead of stacking two modal surfaces.
    window.dispatchEvent(new Event('agentsdock:dismiss-workspace-file-picker'))
    get().setModal('search', true)
  }
  else if (command === 'find-in-current-chat') {
    const activeSurfaceFind = new CustomEvent('agentsdock:find-active-surface', { cancelable: true })
    if (window.dispatchEvent(activeSurfaceFind)) window.dispatchEvent(new CustomEvent('agentsdock:find-in-chat'))
  }
  else if (command === 'next-workspace-tab' || command === 'previous-workspace-tab') {
    window.dispatchEvent(new CustomEvent('agentsdock:navigate-workspace-tab', {
      detail: { direction: command === 'next-workspace-tab' ? 1 : -1 }
    }))
  }
  else if (command === 'next-server') void get().selectAdjacentServer(1)
  else if (command === 'previous-server') void get().selectAdjacentServer(-1)
  else if (command === 'toggle-inspector') get().setInspectorVisible(!get().inspectorVisible)
  else if (command === 'jump-latest') window.dispatchEvent(new CustomEvent('agentsdock:jump-latest'))
  else if (command === 'close-surface') window.dispatchEvent(new CustomEvent('agentsdock:close-surface'))
  else set({ error: `Unknown command: ${command}` })
}

export function sessionUnread(session: Session): boolean { return isUnread(session) }
export function sessionRunning(sessionId: string): boolean { return useAppStore.getState().activeSessionIds.has(sessionId) }
