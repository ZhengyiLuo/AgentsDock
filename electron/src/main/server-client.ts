import { createReadStream, openAsBlob } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { compactTimelineEvent, compactTimelineEvents } from '../shared/event-compaction'
import { parseSideQuestionAnswer, validateSideQuestionInput, type SideQuestionAnswer, type SideQuestionCancellation, type SideQuestionInput } from '../shared/side-questions'
import { parseChatInboxDelete, parseChatInboxPage } from '../shared/chat-inbox'
import { chatShareCreateBody, chatShareId, chatShareMode, parseChatShareList, parseChatSharePreview, parseCreatedChatShare,
  type ChatShareMode, type CreateChatShareInput } from '../shared/chat-shares'
import { inferredFileContentType } from '../shared/file-content-type'
import {
  LOCAL_SESSION_IMPORT_HARD_BATCH_LIMIT,
  LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT,
  parseBulkImportSessionItems,
  parseBulkImportSessionResultsResponse,
  parseLocalSessionCandidatesResponse
} from '../shared/local-session-import'
import type {
  AgentFile,
  AgentCrossChatRoute,
  AgentCrossChatRoutesSnapshot,
  AgentTeamMailRoutesSnapshot,
  BulkImportSessionItem,
  BulkImportSessionResult,
  ChatReference,
  TeamReference,
  ChatSearchSnapshot,
  CreateAgentCrossChatRouteInput,
  CrossChatExchange,
  CrossChatHandoff,
  CrossChatHandoffSummary,
  DeleteAgentCrossChatRouteResponse,
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
  CodexSubagentsConfiguration,
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
  Event,
  FilesPage,
  Health,
  Job,
  JobRunNowResult,
  JobRunHistoryPage,
  JsonValue,
  LocalSessionCandidate,
  PinnedItem,
  PinnedItemsSnapshot,
  ProcessSnapshot,
  ProviderCommandSelection,
  ProviderCommandsSnapshot,
  ProviderReloadResult,
  ProviderRuntimeChanged,
  QueuedCrossChatDeliveryIdentity,
  QueuedRunNowResponse,
  QueuedTurn,
  ResumeSessionInput,
  RuntimeCatalog,
  ServerRestartRequest,
  ServerRestartStatus,
  ServerUpdateStatus,
  ServerUpdateTrack,
  Session,
  SubagentSnapshot,
  TerminalAction,
  TerminalConnectOptions,
  TerminalStateEvent,
  TerminalWindowsSnapshot,
  TeamHubV1Capability,
  TimelineIndex,
  TimelinePage,
  TimelinePinsChanged,
  TimelineSearchResult,
  TimelineTracePage,
  TmuxPane,
  TurnStopResult,
  UpdateAgentCrossChatRouteInput,
  UpdateJobInput,
  UpdateSessionInput,
  WorkspaceEntriesPage,
  WorkspaceCreateResult,
  WorkspaceFile,
  WorkspaceInfo,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceSearchPage,
  WorkingDirectoryCompletion
} from '../shared/types'
import { normalizeCursorPermissionMode } from '../shared/cursor-permissions'
import { normalizeServerURL } from '../shared/server-url'
import { teamNetworkValidationMessage } from '../shared/server-errors'
import { deriveTeamHubBootstrapControlURL } from '../shared/team-hub-url'
import { parseAgentTeamMessagesCapability, parseTeamBulletinAliasCapability, parseTeamAllServersAliasCapability } from '../shared/team-network'
import { PinRevisionConflictError } from './pin-sync'
import { PORT_TUNNEL_SUBPROTOCOL } from './port-tunnel-manager'
import { SecurePeerRequestAdmission } from './secure-peer-request-admission'
import {
  parseMailHintPacket, TEAM_MAIL_HINTS_MAX_PACKET_CHARS, TEAM_MAIL_HINTS_PATH, TEAM_MAIL_HINTS_PROTOCOL,
  type MailboxCoverage, type MailHintMailbox, type MailHintPacket
} from '../shared/team-mail-hints'
import { parseTeamActivityHintPacket, TEAM_ACTIVITY_HINTS_PROTOCOL, emptyBulletinCursor,
  type BulletinChangeCursor, type TeamActivityHintPacket } from '../shared/team-bulletin-hints'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// Snapshot scans have a server-side 30s deadline. Leave response/transport
// headroom without extending unrelated requests or retrying a creation.
const CHAT_SHARE_SNAPSHOT_TIMEOUT_MS = 40_000
// The server gives its one-shot digest summarizer 180 seconds to finish.
// Keep the client alive through that window plus response/network overhead.
const DIGEST_PREVIEW_REQUEST_TIMEOUT_MS = 210_000
const TIMELINE_REQUEST_TIMEOUT_MS = 120_000
const SUBAGENT_SNAPSHOT_REQUEST_TIMEOUT_MS = 15_000
const LOCAL_SESSION_IMPORT_REQUEST_TIMEOUT_MS = 10 * 60_000
// Above the worst-case valid 500-item payload even when every bounded string
// is represented with six-byte JSON Unicode escapes.
export const LOCAL_SESSION_LIST_RESPONSE_MAX_BYTES = 64 * 1024 * 1024
export const LOCAL_SESSION_IMPORT_RESPONSE_MAX_BYTES = 1024 * 1024
const SERVER_UPDATE_REQUEST_TIMEOUT_MS = 120_000
const SERVER_RESTART_REQUEST_TIMEOUT_MS = 30_000
const CODEX_THREAD_LOAD_REQUEST_TIMEOUT_MS = 300_000
const UPLOAD_REQUEST_TIMEOUT_FLOOR_MS = 5 * 60_000
const UPLOAD_REQUEST_TIMEOUT_OVERHEAD_MS = 2 * 60_000
const UPLOAD_REQUEST_TIMEOUT_CAP_MS = 8 * 60 * 60_000
const UPLOAD_MINIMUM_BYTES_PER_SECOND = 1024 * 1024
const TEAM_HUB_BOOTSTRAP_PROOF_TIMEOUT_MS = 15_000
const TEAM_HUB_BOOTSTRAP_PROOF_MAX_RESPONSE_BYTES = 64 * 1024
const SECURE_PEER_MAX_REQUEST_BYTES = 64 * 1024
const SECURE_PEER_BINARY_ERROR_MAX_BYTES = 64 * 1024
const PROVIDER_COMMAND_ID_PATTERN = /^pcmd_[0-9a-f]{32}$/
const PROVIDER_COMMAND_REVISION_PATTERN = /^pcmdrev_[0-9a-f]{32}$/

function providerCommandSelectionPayload(value: ProviderCommandSelection | undefined): ProviderCommandSelection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid provider command selection.')
  }
  const record = value as unknown as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 2
    || keys[0] !== 'id'
    || keys[1] !== 'revision'
    || typeof record.id !== 'string'
    || !PROVIDER_COMMAND_ID_PATTERN.test(record.id)
    || typeof record.revision !== 'string'
    || !PROVIDER_COMMAND_REVISION_PATTERN.test(record.revision)
  ) throw new Error('Invalid provider command selection.')
  return { id: record.id, revision: record.revision }
}
const SECURE_PEER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const TEAM_ATTACHMENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024
const TEAM_ATTACHMENT_TRANSFER_TIMEOUT_MS = 120_000
const EMERGENCY_STREAM_MAX_PACKET_CHARS = 8 * 1024 * 1024
const EMERGENCY_STREAM_MAX_SESSIONS = 10_000
const EMERGENCY_STREAM_PROTOCOL = 'agentsdock-emergency-v1'
const EVENTS_STREAM_PROTOCOL = 'agentsdock-events-v1'
const TERMINAL_STREAM_PROTOCOL = 'agentsdock-terminal-v1'

function agentTokenWebSocketProtocols(token: string): string[] {
  return token
    ? [`agentsdock-token.${Buffer.from(token, 'utf8').toString('base64url')}`]
    : []
}
const PINNED_ITEMS_MAX_ITEMS = 500
const PINNED_ITEMS_RESPONSE_MAX_BYTES = 128 * 1024 * 1024

export interface TeamHubBootstrapProofGrantRequest {
  request_id: string
  expected_server_identity: string
  expected_server_instance_id: string
  expected_hub_id: string
  expected_hub_url: string
  expected_transport?: 'tailscale_serve' | 'direct_ip'
  confirmed: true
  unsafe_direct_ip_confirmed?: true
  recipient_email: string
  display_name: string
  device_label: string
}

export interface TeamHubBootstrapProofGrantResponse {
  request_id: string
  server_identity: string
  server_instance_id: string
  hub_id: string
  tailnet_login: string
  expires_at: string
  bootstrap_proof: string
}

export interface ServerUpdateTarget {
  expected_server_identity: string
  expected_server_instance_id: string
}

export interface TeamHubHostRoleRequest {
  request_id: string
  expected_server_identity: string
  expected_server_instance_id: string
  confirmed: true
  server_name: string
  network_name?: string
  require_existing_host?: true
}

export type TeamHubHostEnableRequest = TeamHubHostRoleRequest
export type TeamHubHostDisableRequest = TeamHubHostRoleRequest

export interface TeamHubHostRoleResponse {
  phase: 'complete'
  request_id: string
  operation: 'create' | 'reactivate' | 'enable' | 'disable' | 'rename' | 'already_host' | 'already_member'
  server_identity: string
  server_instance_id: string
  server_name: string
  reconnect_required: false
  message: string
  team_hub: TeamHubV1Capability
}

interface SessionResponse {
  session: Session
  events: Event[]
  queued_turns?: QueuedTurn[]
  events_omitted_before?: number
  events_omitted_after?: number
  latest_seq?: number
  event_count?: number
  next_before?: number | null
  semantic_item_count?: number | null
  semantic_total?: number | null
  semantic_omitted_before?: number | null
  semantic_omitted_after?: number | null
  next_semantic_before?: number | null
}

export interface SessionPageOptions {
  after?: number
  before?: number
  limit?: number
  tail?: boolean
  visible?: boolean
  compact?: boolean
  pageMode?: 'semantic'
}

interface ClientConfiguration {
  baseURL: string
  token: string
  websocketSubprotocolAuth: boolean
  abortController: AbortController
  transports: Set<() => void>
  securePeerAdmissions: Map<string, SecurePeerRequestAdmission>
}

export interface AgentServerClientOptions {
  /** Test seam; production derives a bounded deadline from the opened file size. */
  uploadTimeoutMs?: number
  /** Test seam which avoids wall-clock waits when exercising upload expiry. */
  timeoutSignal?: (timeoutMs: number) => AbortSignal
}

export interface OpenedUploadSource {
  fd: number
  byteSize: number
  filename: string
}

export interface TerminalConnection {
  write(data: string): void
  resize(columns: number, rows: number): void
  scroll(delta: number): void
  close(): void
}

export class ServerError extends Error {
  constructor(public readonly status: number, message: string, public readonly detail?: unknown) {
    super(message)
  }
}

/** No HTTP response was received, so an exact idempotent retry is safe. */
export class TeamHubBootstrapTransportError extends Error {
  constructor() {
    super('Teamspace setup could not reach the verified server.')
    this.name = 'TeamHubBootstrapTransportError'
  }
}

export class AgentServerClient {
  private configuration: ClientConfiguration
  private readonly uploadTimeoutMs: number | null
  private readonly timeoutSignal: (timeoutMs: number) => AbortSignal

  constructor(baseURL: string, token: string, options: AgentServerClientOptions = {}) {
    this.configuration = createConfiguration(baseURL, token)
    this.uploadTimeoutMs = options.uploadTimeoutMs === undefined ? null : positiveTimeout(options.uploadTimeoutMs)
    this.timeoutSignal = options.timeoutSignal ?? (timeoutMs => AbortSignal.timeout(timeoutMs))
  }

  configure(baseURL: string, token: string): void {
    const previous = this.configuration
    this.configuration = createConfiguration(baseURL, token)
    cancelConfiguration(previous)
  }

  dispose(): void {
    cancelConfiguration(this.configuration)
  }

  url(path: string): string {
    return configurationURL(this.configuration, path)
  }

  async askSideQuestion(sessionId: string, input: SideQuestionInput, signal?: AbortSignal): Promise<SideQuestionAnswer> {
    const body = validateSideQuestionInput(input)
    // Independent one-shot provider calls have a 150-second server deadline.
    // Keep transport headroom and never retry or turn this into a chat turn.
    const response = await this.request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/side-questions`, {
      method: 'POST', body: JSON.stringify(body),
      signal: combineAbortSignals(signal, this.timeoutSignal(210_000))
    }, this.configuration, 2 * 1024 * 1024)
    return parseSideQuestionAnswer(response, sessionId, body.request_id)
  }

  async cancelSideQuestion(sessionId: string, requestId: string): Promise<SideQuestionCancellation> {
    const response = await this.delete<SideQuestionCancellation>(
      `/api/sessions/${encodeURIComponent(sessionId)}/side-questions/${encodeURIComponent(requestId)}`
    )
    if (response?.request_id !== requestId || !['cancelled', 'not_found'].includes(response.status)) {
      throw new Error('side_question_invalid_response')
    }
    return response
  }

  async health(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, redirect: 'follow' | 'error' = 'error'): Promise<Health> {
    const configuration = this.configuration
    const health = await this.request<Health>('/api/health', {
      redirect,
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (this.configuration === configuration) {
      configuration.websocketSubprotocolAuth = (
        health.capabilities?.websocket_auth_v1?.available === true
      )
    }
    const agentTeamMessages = health.capabilities?.agent_team_messages_v1
    const teamBulletinAlias = health.capabilities?.team_bulletin_alias_v1
    const teamAllServersAlias = health.capabilities?.team_all_servers_alias_v1
    if (agentTeamMessages === undefined && teamBulletinAlias === undefined && teamAllServersAlias === undefined) return health
    return {
      ...health,
      capabilities: {
        ...health.capabilities,
        ...(agentTeamMessages === undefined
          ? {}
          : { agent_team_messages_v1: parseAgentTeamMessagesCapability(agentTeamMessages) }),
        ...(teamBulletinAlias === undefined
          ? {}
          : { team_bulletin_alias_v1: parseTeamBulletinAliasCapability(teamBulletinAlias) }),
        ...(teamAllServersAlias === undefined
          ? {}
          : { team_all_servers_alias_v1: parseTeamAllServersAliasCapability(teamAllServersAlias) })
      }
    }
  }
  async runtimeCatalog(refresh = false): Promise<RuntimeCatalog> {
    return this.get(`/api/runtime/catalog${refresh ? '?refresh=true' : ''}`)
  }
  async serverUpdateStatus(target?: ServerUpdateTarget): Promise<ServerUpdateStatus> {
    const query = target ? `?${new URLSearchParams([
      ['expected_server_identity', target.expected_server_identity],
      ['expected_server_instance_id', target.expected_server_instance_id]
    ]).toString()}` : ''
    return this.privilegedNativeRequest<ServerUpdateStatus>(`/api/admin/update${query}`).then(normalizeServerUpdateStatus)
  }
  async checkServerUpdate(track?: ServerUpdateTrack, target?: ServerUpdateTarget): Promise<ServerUpdateStatus> {
    return this.privilegedNativeRequest<ServerUpdateStatus>(
      '/api/admin/update/check',
      { method: 'POST', body: JSON.stringify({ track: track || null, ...target }) },
      SERVER_UPDATE_REQUEST_TIMEOUT_MS
    ).then(normalizeServerUpdateStatus)
  }
  async startServerUpdate(
    version?: string,
    track?: ServerUpdateTrack,
    whenIdle = false,
    target?: ServerUpdateTarget
  ): Promise<ServerUpdateStatus> {
    const body: {
      version: string | null
      track: ServerUpdateTrack | null
      when_idle?: true
      expected_server_identity?: string
      expected_server_instance_id?: string
    } = {
      version: version || null,
      track: track || null,
      ...target
    }
    if (whenIdle) body.when_idle = true
    return this.privilegedNativeRequest<ServerUpdateStatus>(
      '/api/admin/update/start',
      { method: 'POST', body: JSON.stringify(body) },
      SERVER_UPDATE_REQUEST_TIMEOUT_MS
    ).then(normalizeServerUpdateStatus)
  }
  async cancelServerUpdate(scheduleId: string, target?: ServerUpdateTarget): Promise<ServerUpdateStatus> {
    return this.privilegedNativeRequest<ServerUpdateStatus>(
      '/api/admin/update/cancel',
      { method: 'POST', body: JSON.stringify({ schedule_id: scheduleId, ...target }) },
      SERVER_UPDATE_REQUEST_TIMEOUT_MS
    ).then(normalizeServerUpdateStatus)
  }
  async enableTeamHubHost(input: TeamHubHostEnableRequest): Promise<TeamHubHostRoleResponse> {
    return this.privilegedNativeRequest<TeamHubHostRoleResponse>(
      '/api/admin/team-hub/host/enable',
      {
        method: 'POST',
        body: JSON.stringify({
          request_id: input.request_id,
          expected_server_identity: input.expected_server_identity,
          expected_server_instance_id: input.expected_server_instance_id,
          confirmed: true,
          server_name: input.server_name,
          ...(input.require_existing_host === true ? { require_existing_host: true } : {}),
          ...(input.network_name === undefined ? {} : { network_name: input.network_name })
        })
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      200
    )
  }
  async disableTeamHubHost(input: TeamHubHostDisableRequest): Promise<TeamHubHostRoleResponse> {
    return this.privilegedNativeRequest<TeamHubHostRoleResponse>(
      '/api/admin/team-hub/host/disable',
      {
        method: 'POST',
        body: JSON.stringify({
          request_id: input.request_id,
          expected_server_identity: input.expected_server_identity,
          expected_server_instance_id: input.expected_server_instance_id,
          confirmed: true,
          server_name: input.server_name
        })
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      200
    )
  }
  async serverRestartStatus(): Promise<ServerRestartStatus> {
    return this.request('/api/admin/restart', {
      redirect: 'error',
      signal: AbortSignal.timeout(SERVER_RESTART_REQUEST_TIMEOUT_MS)
    })
  }
  async restartServer(input: ServerRestartRequest): Promise<ServerRestartStatus> {
    return this.request('/api/admin/restart', {
      method: 'POST',
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(SERVER_RESTART_REQUEST_TIMEOUT_MS)
    })
  }
  async securePeerStatus(signal?: AbortSignal): Promise<unknown> {
    return this.securePeerRequest('/api/admin/secure-peers/v1/status', { signal })
  }
  async securePeerHostPeers(input: {
    expected_server_identity: string
    expected_server_instance_id: string
    team_id: string
  }): Promise<unknown> {
    return this.securePeerRequest('/api/admin/secure-peers/v1/peers', {}, new URLSearchParams(input))
  }
  async configureSecurePeerHost(input: unknown): Promise<unknown> {
    return this.securePeerRequest('/api/admin/secure-peers/v1/host', { method: 'PUT', body: JSON.stringify(input) })
  }
  async requestSecurePeerPairing(input: unknown): Promise<unknown> {
    return this.securePeerRequest('/api/admin/secure-peers/v1/pairings', { method: 'POST', body: JSON.stringify(input) })
  }
  async securePeerPairing(pairingId: string): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}`)
  }
  async securePeerPairingCompletion(pairingId: string, input: {
    expected_server_identity: string
    expected_server_instance_id: string
    expected_transcript_hash: string
  }, signal: AbortSignal): Promise<unknown> {
    return this.securePeerRequest(
      `/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}/completion`,
      { signal }, new URLSearchParams(input), 610_000
    )
  }
  async cancelSecurePeerPairing(pairingId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}/cancel`, { method: 'POST', body: JSON.stringify(input) })
  }
  async approveSecurePeerPairing(pairingId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}/approve`, { method: 'POST', body: JSON.stringify(input) })
  }
  async rejectSecurePeerPairing(pairingId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}/reject`, { method: 'POST', body: JSON.stringify(input) })
  }
  async activateSecurePeerPairing(pairingId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/pairings/${securePeerSegment(pairingId)}/activate`, { method: 'POST', body: JSON.stringify(input) })
  }
  async deactivateSecurePeerConnection(connectionId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/connections/${securePeerSegment(connectionId)}/deactivate`, { method: 'POST', body: JSON.stringify(input) })
  }
  async forgetSecurePeerConnection(connectionId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/connections/${securePeerSegment(connectionId)}/forget`, { method: 'POST', body: JSON.stringify(input) })
  }
  async updateSecurePeerConnectionEndpoint(connectionId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/connections/${securePeerSegment(connectionId)}/endpoint`, { method: 'PUT', body: JSON.stringify(input) })
  }
  async revokeSecurePeerHostPeer(peerId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/peers/${securePeerSegment(peerId)}/revoke`, { method: 'POST', body: JSON.stringify(input) })
  }
  async publishSecurePeerRoute(input: unknown): Promise<unknown> {
    return this.securePeerRequest('/api/admin/secure-peers/v1/routes', { method: 'POST', body: JSON.stringify(input) })
  }
  async revokeSecurePeerRoute(routeId: string, input: unknown): Promise<unknown> {
    return this.securePeerRequest(`/api/admin/secure-peers/v1/routes/${securePeerSegment(routeId)}/revoke`, { method: 'POST', body: JSON.stringify(input) })
  }

  /**
   * A narrowly bound fetch for the local secure-peer Hub proxy. Peer authority
   * comes from the gateway's mTLS connection, so any Hub bearer is stripped;
   * the distinct control credential is added only on the exact active origin
   * and connection path.
   */
  secureTeamHubProxyFetch(basePath: string): typeof fetch {
    if (!/^\/api\/team-hub-secure\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basePath)) {
      throw new Error('AgentsServer advertised an invalid secure Teamspace proxy path.')
    }
    const configuration = this.configuration
    const exactBase = new URL(configurationURL(configuration, basePath))
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (this.configuration !== configuration || configuration.abortController.signal.aborted) {
        throw new Error('The active AgentsServer profile changed.')
      }
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (
        target.origin !== exactBase.origin
        || !target.pathname.startsWith(`${exactBase.pathname}/v1/`)
        || target.username || target.password || target.hash
      ) throw new Error('Secure Teamspace proxy request escaped the active AgentsServer route.')
      const rawBody = init.body ?? (input instanceof Request && input.body ? input.body : null)
      const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
      const binaryLane = isSecurePeerTeamAttachmentContentPath(target, exactBase.pathname)
      const method = securePeerMethod(
        init.method ?? (input instanceof Request ? input.method : 'GET'),
        binaryLane ? ['GET', 'PUT', 'HEAD'] : ['GET', 'POST', 'DELETE']
      )
      const body = binaryLane
        ? boundedTeamAttachmentRequestBody(rawBody, method)
        : boundedJSONRequestBody(rawBody, method)
      const headers = binaryLane
        ? securePeerTeamAttachmentHeaders(
          configuration.token,
          mergedRequestHeaders(input, init),
          method,
          body
        )
        : securePeerTransportHeaders(configuration.token, body)
      // Preserve the existing total deadline, including time waiting for a
      // local slot. All closures for this immutable configuration/peer share
      // admission; ordinary Hub traffic and native control waits are separate.
      const signal = combineAbortSignals(
        configuration.abortController.signal,
        callerSignal,
        AbortSignal.timeout(binaryLane ? TEAM_ATTACHMENT_TRANSFER_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS)
      )
      let admission = configuration.securePeerAdmissions.get(basePath)
      if (!admission) {
        admission = new SecurePeerRequestAdmission()
        configuration.securePeerAdmissions.set(basePath, admission)
      }
      try {
        return await admission.run(binaryLane ? 'binary' : 'json', signal, () => securePeerNodeResponse(target, {
          method,
          headers,
          body,
          ...(binaryLane ? { responseMode: 'binary' as const, maxResponseBytes: TEAM_ATTACHMENT_CHUNK_MAX_BYTES } : {}),
          signal
        }))
      } finally {
        // Native transport settles only after the entire bounded response body
        // has been read (or destroyed), so no live transfer loses its slot.
        if (admission.idle && configuration.securePeerAdmissions.get(basePath) === admission) {
          configuration.securePeerAdmissions.delete(basePath)
        }
      }
    }) as typeof fetch
  }

  /**
   * A narrowly bound fetch for the designated host's server-scoped Team Hub
   * proxy. The caller's Hub bearer is discarded; AgentsServer supplies its
   * own profile credential only on this exact authenticated path.
   */
  serverTeamHubProxyFetch(basePath: string): typeof fetch {
    if (basePath !== '/api/team-hub-server') {
      throw new Error('AgentsServer advertised an invalid server Teamspace proxy path.')
    }
    const configuration = this.configuration
    const exactBase = new URL(configurationURL(configuration, basePath))
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (this.configuration !== configuration || configuration.abortController.signal.aborted) {
        throw new Error('The active AgentsServer profile changed.')
      }
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (
        target.origin !== exactBase.origin
        || !target.pathname.startsWith(`${exactBase.pathname}/v1/`)
        || target.username || target.password || target.hash
      ) throw new Error('Server Teamspace proxy request escaped the active AgentsServer route.')
      const rawBody = init.body ?? (input instanceof Request && input.body ? input.body : null)
      const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
      const binaryLane = isSecurePeerTeamAttachmentContentPath(target, exactBase.pathname)
      const method = securePeerMethod(
        init.method ?? (input instanceof Request ? input.method : 'GET'),
        binaryLane ? ['GET', 'PUT', 'HEAD'] : ['GET', 'POST', 'DELETE']
      )
      const body = binaryLane
        ? boundedTeamAttachmentRequestBody(rawBody, method)
        : boundedJSONRequestBody(rawBody, method)
      const headers = binaryLane
        ? securePeerTeamAttachmentHeaders(
          configuration.token,
          mergedRequestHeaders(input, init),
          method,
          body
        )
        : securePeerTransportHeaders(configuration.token, body)
      return securePeerNodeResponse(target, {
        method,
        headers,
        body,
        ...(binaryLane ? { responseMode: 'binary' as const, maxResponseBytes: TEAM_ATTACHMENT_CHUNK_MAX_BYTES } : {}),
        signal: combineAbortSignals(
          configuration.abortController.signal,
          callerSignal,
          AbortSignal.timeout(binaryLane ? TEAM_ATTACHMENT_TRANSFER_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS)
        )
      })
    }) as typeof fetch
  }
  async teamHubBootstrapProof(
    hubURL: string,
    input: TeamHubBootstrapProofGrantRequest
  ): Promise<TeamHubBootstrapProofGrantResponse> {
    const configuration = this.configuration
    const token = configuration.token.trim()
    if (!token || /[\r\n]/.test(token)) throw new Error('The active AgentsServer administrator credential is unavailable.')
    const url = deriveTeamHubBootstrapControlURL(hubURL)
    if (new URL(url).protocol === 'http:' && new URL(url).origin !== new URL(configuration.baseURL).origin) {
      throw new Error('Direct-IP Teamspace setup must use the exact active AgentsServer origin.')
    }
    const body = JSON.stringify(input)
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('The Teamspace setup request is too large.')
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body))
    })
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: combineAbortSignals(
          configuration.abortController.signal,
          AbortSignal.timeout(TEAM_HUB_BOOTSTRAP_PROOF_TIMEOUT_MS)
        )
      })
    } catch {
      throw new TeamHubBootstrapTransportError()
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ServerError(response.status, 'Teamspace setup refused an unexpected redirect.')
    }
    const declaredLength = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(declaredLength) && declaredLength > TEAM_HUB_BOOTSTRAP_PROOF_MAX_RESPONSE_BYTES) {
      throw new Error('Teamspace setup returned an oversized response.')
    }
    if (!isJSONContentType(response.headers.get('Content-Type'))) {
      throw new Error('Teamspace setup returned an invalid response.')
    }
    const text = await readBoundedText(response, TEAM_HUB_BOOTSTRAP_PROOF_MAX_RESPONSE_BYTES)
    let payload: unknown = {}
    if (text) {
      try { payload = JSON.parse(text) } catch { throw new Error('Teamspace setup returned an invalid response.') }
    }
    if (!response.ok) {
      const item = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as { detail?: unknown; error?: unknown }
        : {}
      const message = safeTeamHubBootstrapError(
        teamHubBootstrapErrorDetail(item, `Teamspace setup request failed (${response.status}).`),
        token
      )
      throw new ServerError(response.status, message)
    }
    return parseTeamHubBootstrapProofGrant(payload)
  }
  codexServerGoals(): Promise<CodexGoalsConfiguration> {
    return this.privilegedNativeRequest('/api/admin/codex/goals')
  }
  codexServerSubagents(): Promise<CodexSubagentsConfiguration> {
    return this.privilegedNativeRequest('/api/admin/codex/subagents')
  }
  setCodexServerSubagents(limit: number | null): Promise<CodexSubagentsConfiguration> {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Subagent limit must be a positive whole number or null for Codex default.')
    }
    return this.privilegedNativeRequest('/api/admin/codex/subagents', {
      method: 'PUT',
      body: JSON.stringify({ max_concurrent_threads_per_session: limit })
    })
  }
  setCodexServerGoals(enabled: boolean): Promise<CodexGoalsConfiguration> {
    return this.privilegedNativeRequest('/api/admin/codex/goals', {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    })
  }
  async sessions(): Promise<Session[]> { return (await this.get<{ sessions: Session[] }>('/api/sessions?summary=true')).sessions }
  async jobs(): Promise<Job[]> { return (await this.get<{ jobs: Job[] }>('/api/jobs')).jobs }

  async pinnedItems(sessionId: string): Promise<PinnedItemsSnapshot> {
    const response = await this.get<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/pins`,
      this.configuration,
      DEFAULT_REQUEST_TIMEOUT_MS,
      PINNED_ITEMS_RESPONSE_MAX_BYTES
    )
    return parsePinnedItemsSnapshot(response, sessionId)
  }

  async putPinnedItem(item: PinnedItem, expectedRevision?: number): Promise<PinnedItemsSnapshot> {
    const normalized = normalizePinnedItemForSync(item, item.sessionId, true)
    const path = `/api/sessions/${encodeURIComponent(normalized.sessionId)}/pins/${encodeURIComponent(normalized.id)}`
    return this.pinnedItemsMutation(path, normalized, normalized.sessionId, expectedRevision)
  }

  async removePinnedItem(sessionId: string, itemId: string, expectedRevision?: number): Promise<PinnedItemsSnapshot> {
    requireBoundedIdentifier(sessionId, 'Pinned item chat', 128)
    requireBoundedIdentifier(itemId, 'Pinned item identifier', 264)
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/pins/${encodeURIComponent(itemId)}`
    return this.pinnedItemsMutation(path, undefined, sessionId, expectedRevision)
  }

  private async pinnedItemsMutation(
    path: string,
    body: PinnedItem | undefined,
    sessionId: string,
    expectedRevision?: number
  ): Promise<PinnedItemsSnapshot> {
    const headers = new Headers()
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Pinned item revision is invalid.')
      headers.set('If-Match', `"${expectedRevision}"`)
    }
    try {
      const response = await this.request<unknown>(path, {
        method: body ? 'PUT' : 'DELETE',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)
      }, this.configuration, PINNED_ITEMS_RESPONSE_MAX_BYTES)
      return parsePinnedItemsSnapshot(response, sessionId)
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) {
        const snapshot = parsePinnedItemsConflict(error.detail, sessionId)
        if (snapshot) throw new PinRevisionConflictError(snapshot)
      }
      throw error
    }
  }

  async createSession(input: CreateSessionInput | ResumeSessionInput): Promise<Session> {
    const providerId = 'providerId' in input ? input.providerId : undefined
    const response = await this.post<{ session: Session }>('/api/sessions', {
      title: input.title,
      folder: input.folder,
      cwd: input.cwd,
      backend: input.backend,
      model: input.model || null,
      effort: input.effort || null,
      system_prompt: input.system_prompt || null,
      codex_approval_policy: input.codex_approval_policy ?? null,
      codex_sandbox_mode: input.codex_sandbox_mode ?? null,
      codex_permission_profile: input.codex_permission_profile ?? null,
      codex_approvals_reviewer: input.codex_approvals_reviewer ?? null,
      claude_permission_mode: input.claude_permission_mode ?? null,
      cursor_permission_mode: input.backend === 'cursor'
        ? normalizeCursorPermissionMode(input.cursor_permission_mode)
        : null,
      provider_session_id: providerId,
      // Cursor can resume provider context by ID, but AgentsServer cannot
      // import Cursor's prior transcript into the local timeline.
      import_history: Boolean(providerId) && input.backend !== 'cursor'
    })
    return response.session
  }

  async listLocalSessions(limit = LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT): Promise<LocalSessionCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT) {
      throw new Error('Import Chat local session limit is invalid.')
    }
    const response = await this.get<unknown>(
      `/api/local-sessions?limit=${limit}`,
      this.configuration,
      DEFAULT_REQUEST_TIMEOUT_MS,
      LOCAL_SESSION_LIST_RESPONSE_MAX_BYTES
    )
    return parseLocalSessionCandidatesResponse(response, limit)
  }

  async bulkImportSessions(items: BulkImportSessionItem[]): Promise<BulkImportSessionResult[]> {
    const normalized = parseBulkImportSessionItems(items, LOCAL_SESSION_IMPORT_HARD_BATCH_LIMIT)
    const response = await this.post<unknown>(
      '/api/sessions/bulk-import',
      { items: normalized },
      this.configuration,
      LOCAL_SESSION_IMPORT_REQUEST_TIMEOUT_MS,
      LOCAL_SESSION_IMPORT_RESPONSE_MAX_BYTES
    )
    return parseBulkImportSessionResultsResponse(response, normalized)
  }

  async updateSession(sessionId: string, patch: UpdateSessionInput): Promise<Session> {
    const normalizedPatch = patch.cursor_permission_mode === undefined
      ? patch
      : {
          ...patch,
          cursor_permission_mode: patch.cursor_permission_mode === null
            ? null
            : normalizeCursorPermissionMode(patch.cursor_permission_mode)
        }
    return (await this.patch<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`, normalizedPatch)).session
  }

  async reloadProvider(sessionId: string): Promise<ProviderReloadResult> {
    try {
      return await this.post<ProviderReloadResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/provider/reload`,
        {}
      )
    } catch (error) {
      const routeIsUnavailable = error instanceof ServerError && (
        [405, 501].includes(error.status)
        || (error.status === 404 && error.message.trim().toLowerCase() === 'not found')
      )
      if (routeIsUnavailable) {
        throw new Error('This AgentsServer version does not support reloading a chat agent. Update the server and try again.')
      }
      throw error
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const response = await this.delete<{ deleted?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    return response.deleted !== false
  }

  async forkSession(sessionId: string): Promise<{ session: Session; sessions?: Session[] }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {})
  }

  async reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after', targetFolder?: string): Promise<Session[]> {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/order`
    try {
      return (await this.post<{ sessions: Session[] }>(path, {
        target_id: targetId,
        placement,
        ...(targetFolder ? { target_folder: targetFolder } : {})
      })).sessions
    } catch (error) {
      const legacyCrossSectionRejection = Boolean(
        targetFolder
        && error instanceof ServerError
        && error.status === 400
        && /same section/i.test(error.message)
      )
      if (!legacyCrossSectionRejection) throw error
      await this.updateSession(sessionId, {
        folder: targetFolder,
        pinned: false,
        archived: false
      })
      return (await this.post<{ sessions: Session[] }>(path, {
        target_id: targetId,
        placement
      })).sessions
    }
  }

  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
      last_read_agent_event_seq: seq ?? null
    })).session
  }

  async markUnread(sessionId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/unread`, {})).session
  }

  async acknowledgeEmergency(sessionId: string, alertId: string): Promise<Session> {
    const response = await this.post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/emergency/acknowledge`, {
      expected_alert_id: alertId
    })
    const session = response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).session
      : null
    if (!isEmergencySessionPacket(session) || session.id !== sessionId) {
      throw new Error('AgentsServer returned an invalid emergency acknowledgement.')
    }
    return session
  }

  async sessionPage(sessionId: string, options: SessionPageOptions = {}): Promise<TimelinePage> {
    return this.sessionPageWithConfiguration(this.configuration, sessionId, options)
  }

  private async sessionPageWithConfiguration(configuration: ClientConfiguration, sessionId: string, options: SessionPageOptions = {}): Promise<TimelinePage> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set('after', String(options.after))
    if (options.before !== undefined) query.set('before', String(options.before))
    if (options.pageMode !== undefined) query.set('page_mode', options.pageMode)
    query.set('limit', String(options.limit ?? 120))
    query.set('tail', String(options.tail ?? true))
    query.set('visible', String(options.visible ?? true))
    if (options.compact !== undefined) query.set('compact', String(options.compact))
    const response = await this.get<SessionResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}?${query}`,
      configuration,
      TIMELINE_REQUEST_TIMEOUT_MS
    )
    return {
      session: response.session,
      events: compactTimelineEvents(response.events),
      queued_turns: response.queued_turns ?? [],
      has_more: options.pageMode === 'semantic' && response.semantic_omitted_before != null
        ? response.semantic_omitted_before > 0
        : (response.events_omitted_before ?? 0) > 0,
      before: response.events[0]?.seq ?? null,
      next_before: response.next_before ?? null,
      total: response.event_count ?? null,
      latest_seq: response.latest_seq ?? response.events.at(-1)?.seq ?? null,
      events_omitted_before: response.events_omitted_before ?? 0,
      events_omitted_after: response.events_omitted_after ?? 0,
      semantic_item_count: response.semantic_item_count ?? null,
      semantic_total: response.semantic_total ?? null,
      semantic_omitted_before: response.semantic_omitted_before ?? null,
      semantic_omitted_after: response.semantic_omitted_after ?? null,
      next_semantic_before: response.next_semantic_before ?? null,
      semantic_paging: options.pageMode === 'semantic'
        ? response.semantic_item_count != null
        : null
    }
  }

  async timelineIndex(sessionId: string): Promise<TimelineIndex> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/timeline-index`)
  }

  async subagents(sessionId: string): Promise<SubagentSnapshot> {
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents`,
      this.configuration,
      SUBAGENT_SNAPSHOT_REQUEST_TIMEOUT_MS
    )
  }

  async jobRuns(
    sessionId: string,
    jobId: string,
    beforeSeq?: number | null,
    limit = 20,
    timelineGroupId?: string | null
  ): Promise<JobRunHistoryPage> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (beforeSeq != null) params.set('before_seq', String(beforeSeq))
    if (timelineGroupId) params.set('timeline_group_id', timelineGroupId)
    const response = await this.get<Omit<JobRunHistoryPage, 'supported'>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/runs?${params}`,
      this.configuration,
      TIMELINE_REQUEST_TIMEOUT_MS
    )
    return {
      runs: compactTimelineEvents(response.runs),
      total: response.total,
      has_more: response.has_more,
      next_before: response.next_before,
      timeline_group_id: response.timeline_group_id,
      supported: true
    }
  }

  async runTrace(
    sessionId: string,
    runId: string,
    anchorSeq: number,
    afterSeq = 0,
    limit = 160
  ): Promise<TimelineTracePage> {
    const params = new URLSearchParams()
    const normalizedAnchor = Math.max(0, Math.floor(anchorSeq))
    if (normalizedAnchor > 0) params.set('anchor_seq', String(normalizedAnchor))
    params.set('after_seq', String(Math.max(0, Math.floor(afterSeq))))
    params.set('limit', String(limit))
    const response = await this.get<TimelineTracePage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace?${params}`,
      this.configuration,
      TIMELINE_REQUEST_TIMEOUT_MS
    )
    return {
      ...response,
      events: compactTimelineEvents(response.events)
    }
  }

  async codeDiff(sessionId: string, runId: string): Promise<string> {
    return this.requestText(`/api/sessions/${encodeURIComponent(sessionId)}/diffs/${encodeURIComponent(runId)}`)
  }

  async searchTimeline(sessionId: string, query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const response = await this.get<{ results?: TimelineSearchResult[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/search?${params}`)
    return response.results ?? []
  }

  async searchSessions(query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const response = await this.get<{ results?: TimelineSearchResult[] }>(`/api/search?${params}`)
    return response.results ?? []
  }

  async importHistory(sessionId: string, force = false): Promise<TimelinePage> {
    const configuration = this.configuration
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/import-history`, { force }, configuration)
    return this.sessionPageWithConfiguration(configuration, sessionId, { pageMode: 'semantic' })
  }

  providerCommands(sessionId: string, refresh = false): Promise<ProviderCommandsSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/provider-commands?refresh=${refresh ? 'true' : 'false'}`)
  }

  async sendTurn(
    sessionId: string,
    prompt: string,
    fileIds: string[],
    model?: string | null,
    effort?: string | null,
    clientCapabilities: string[] = ['codex_interactive_v1'],
    chatReferences: ChatReference[] = [],
    teamReferences: TeamReference[] = [],
    skillSelection?: ProviderCommandSelection
  ): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    const selection = providerCommandSelectionPayload(skillSelection)
    const response = await this.post<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
      prompt,
      file_ids: fileIds,
      model: model ?? '',
      effort: effort ?? '',
      client_capabilities: clientCapabilities,
      ...(chatReferences.length ? { chat_references: chatReferences } : {}),
      ...(teamReferences.length ? { team_references: teamReferences } : {}),
      ...(selection ? { skill_selection: selection } : {})
    })
    return response.event ? { ...response, event: compactTimelineEvent(response.event) } : response
  }

  async stopTurn(sessionId: string): Promise<TurnStopResult> {
    const response = await this.post<Partial<TurnStopResult>>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {})
    return {
      ...response,
      // Older servers returned only { ok: true }. Preserve that compatibility
      // while retaining all additive acknowledgement fields on newer servers.
      stopped: response.stopped ?? response.ok ?? true
    }
  }

  codexRuntime(sessionId: string): Promise<CodexRuntimeSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/runtime`)
  }

  loadCodexThread(sessionId: string): Promise<CodexRuntimeSnapshot> {
    return this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/load`,
      {},
      this.configuration,
      CODEX_THREAD_LOAD_REQUEST_TIMEOUT_MS
    )
  }

  async resolveCodexInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>
  ): Promise<CodexPendingInteraction> {
    return (await this.post<{ interaction: CodexPendingInteraction }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/interactions/${encodeURIComponent(interactionId)}/resolve`,
      { response }
    )).interaction
  }

  claudeRuntime(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/claude/runtime`)
  }

  refreshClaudeContextUsage(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/claude/context-usage/refresh`,
      {}
    )
  }

  claudeMcp(sessionId: string): Promise<ClaudeMcpSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/claude/mcp`)
  }

  controlClaudeMcp(sessionId: string, input: ClaudeMcpControlInput): Promise<ClaudeMcpSnapshot> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/claude/mcp`, input)
  }

  async resolveClaudeInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>
  ): Promise<ClaudePendingInteraction> {
    return (await this.post<{ interaction: ClaudePendingInteraction }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/claude/interactions/${encodeURIComponent(interactionId)}/resolve`,
      { response }
    )).interaction
  }

  async codexPermissionProfiles(sessionId: string): Promise<CodexPermissionProfile[]> {
    return (await this.get<{ profiles: CodexPermissionProfile[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/permission-profiles`
    )).profiles
  }

  codexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`)
  }

  setCodexGoal(sessionId: string, input: CodexGoalInput): Promise<CodexGoalSnapshot> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`, input)
  }

  clearCodexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`)
  }

  compactCodexThread(sessionId: string): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/compact`, {})
  }

  rollbackCodexThread(sessionId: string, input: CodexRollbackInput): Promise<CodexRollbackResult> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/rollback`, input)
  }

  reviewCodexThread(sessionId: string, input: CodexReviewInput): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/review`, {
      target: input.target,
      delivery: input.delivery ?? 'inline'
    })
  }

  shellCodexThread(sessionId: string, input: CodexShellInput): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/shell`, input)
  }

  codexBackgroundTerminals(sessionId: string): Promise<CodexBackgroundTerminalsSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals`)
  }

  async terminateCodexBackgroundTerminal(
    sessionId: string,
    input: CodexBackgroundTerminalTerminateInput
  ): Promise<boolean> {
    return (await this.post<{ terminated: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals/terminate`,
      input
    )).terminated
  }

  async cleanCodexBackgroundTerminals(
    sessionId: string,
    input: CodexBackgroundTerminalsCleanInput
  ): Promise<boolean> {
    return (await this.post<{ cleaned: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals/clean`,
      input
    )).cleaned
  }

  async queue(sessionId: string): Promise<QueuedTurn[]> {
    return this.queueWithConfiguration(this.configuration, sessionId)
  }

  private async queueWithConfiguration(configuration: ClientConfiguration, sessionId: string): Promise<QueuedTurn[]> {
    return (await this.sessionPageWithConfiguration(configuration, sessionId, { limit: 1 })).queued_turns ?? []
  }

  async updateQueued(
    sessionId: string,
    queuedId: string,
    prompt: string,
    chatReferences?: ChatReference[],
    clientCapabilities?: string[],
    teamReferences?: TeamReference[],
    expectedMessageRevision?: number
  ): Promise<boolean> {
    await this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`, {
      prompt,
      ...(chatReferences ? { chat_references: chatReferences } : {}),
      ...(clientCapabilities ? { client_capabilities: clientCapabilities } : {}),
      ...(teamReferences ? { team_references: teamReferences } : {}),
      ...(expectedMessageRevision !== undefined ? { expected_message_revision: expectedMessageRevision } : {})
    })
    return true
  }

  async agentHandoffRoutes(sessionId: string): Promise<AgentCrossChatRoutesSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes?unlimited_routes=true`)
  }

  agentTeamMailRoutes(sessionId: string): Promise<AgentTeamMailRoutesSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/agent-team-mail-routes`)
  }

  deleteAgentTeamMailRoute(sessionId: string, routeId: string, expectedRevision: string): Promise<DeleteAgentCrossChatRouteResponse> {
    const params = new URLSearchParams({ expected_revision: expectedRevision })
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/agent-team-mail-routes/${encodeURIComponent(routeId)}?${params}`)
  }

  async searchAgentHandoffTargets(
    query: string,
    excludeSessionId: string,
    limit = 20
  ): Promise<ChatSearchSnapshot> {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      exclude_session_id: excludeSessionId
    })
    return this.get(`/api/chats/search?${params}`)
  }

  async createAgentHandoffRoute(
    sessionId: string,
    input: CreateAgentCrossChatRouteInput
  ): Promise<AgentCrossChatRoute> {
    return (await this.post<{ route: AgentCrossChatRoute }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes`,
      input
    )).route
  }

  async updateAgentHandoffRoute(
    sessionId: string,
    routeId: string,
    input: UpdateAgentCrossChatRouteInput
  ): Promise<AgentCrossChatRoute> {
    return (await this.patch<{ route: AgentCrossChatRoute }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes/${encodeURIComponent(routeId)}`,
      input
    )).route
  }

  deleteAgentHandoffRoute(
    sessionId: string,
    routeId: string,
    expectedRevision: string
  ): Promise<DeleteAgentCrossChatRouteResponse> {
    const params = new URLSearchParams({ expected_revision: expectedRevision })
    return this.delete(
      `/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes/${encodeURIComponent(routeId)}?${params}`
    )
  }

  async crossChatHandoff(envelopeId: string): Promise<CrossChatHandoff> {
    const response = await this.get<{ handoff: CrossChatHandoff }>(
      `/api/cross-chat/handoffs/${encodeURIComponent(envelopeId)}`
    )
    return response.handoff
  }

  async cancelCrossChatHandoff(envelopeId: string): Promise<CrossChatHandoffSummary> {
    const response = await this.post<{ handoff: CrossChatHandoffSummary }>(
      `/api/cross-chat/handoffs/${encodeURIComponent(envelopeId)}/cancel`,
      {}
    )
    return response.handoff
  }

  async chatInbox(sessionId: string, cursor: string | null = null, limit = 25) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || cursor !== null && !/^\d+$/.test(cursor)) throw new Error('Invalid inbox page request.')
    const query = new URLSearchParams({ limit: String(limit) })
    if (cursor !== null) query.set('cursor', cursor)
    return parseChatInboxPage(await this.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/inbox?${query}`), sessionId, limit)
  }

  async deleteChatInboxMessage(sessionId: string, messageId: string) {
    return parseChatInboxDelete(await this.delete<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(messageId)}`), sessionId, messageId)
  }

  async crossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    const response = await this.get<{ exchange: CrossChatExchange }>(
      `/api/cross-chat/exchanges/${encodeURIComponent(exchangeId)}`
    )
    return response.exchange
  }

  async cancelCrossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    const response = await this.post<{ exchange: CrossChatExchange }>(
      `/api/cross-chat/exchanges/${encodeURIComponent(exchangeId)}/cancel`,
      {}
    )
    return response.exchange
  }

  async removeQueued(sessionId: string, queuedId: string): Promise<boolean> {
    await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`)
    return true
  }

  async skipQueuedCrossChatDelivery(
    sessionId: string,
    queuedId: string,
    identity: QueuedCrossChatDeliveryIdentity
  ): Promise<boolean> {
    await this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/skip-cross-chat-delivery`,
      identity
    )
    return true
  }

  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down', expectedAdjacentQueuedId?: string): Promise<QueuedTurn[]> {
    const configuration = this.configuration
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/move`, {
      direction,
      ...(expectedAdjacentQueuedId === undefined ? {} : { expected_adjacent_queued_id: expectedAdjacentQueuedId })
    }, configuration)
    // This later snapshot may include another durable mutation. Never overwrite
    // its positions with the older move response's ordering.
    return this.queueWithConfiguration(configuration, sessionId)
  }

  runQueuedNow(sessionId: string, queuedId: string): Promise<QueuedRunNowResponse> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/run-now`, {
      accept_deferred_queue_response: true
    })
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    const payload: CreateJobInput = {
      session_id: input.session_id,
      title: input.title,
      prompt: input.prompt,
      chat_references: input.chat_references,
      team_references: input.team_references,
      interval_seconds: input.interval_seconds,
      schedule_kind: input.schedule_kind,
      cron_expression: input.cron_expression,
      rrule: input.rrule,
      timezone: input.timezone,
      first_run_at: input.first_run_at,
      loop: input.loop,
      max_runs: input.max_runs,
      enabled: input.enabled,
      context_mode: input.context_mode,
      backend: input.backend
    }
    return (await this.post<{ job: Job }>('/api/jobs', payload)).job
  }

  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> {
    const payload: UpdateJobInput = {
      title: patch.title,
      prompt: patch.prompt,
      chat_references: patch.chat_references,
      team_references: patch.team_references,
      interval_seconds: patch.interval_seconds,
      schedule_kind: patch.schedule_kind,
      cron_expression: patch.cron_expression,
      rrule: patch.rrule,
      timezone: patch.timezone,
      next_run_at: patch.next_run_at,
      loop: patch.loop,
      max_runs: patch.max_runs,
      enabled: patch.enabled,
      context_mode: patch.context_mode,
      backend: patch.backend
    }
    return (await this.patch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, payload)).job
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return (await this.delete<{ deleted: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}`)).deleted
  }

  async runJob(jobId: string): Promise<JobRunNowResult> {
    return this.post<JobRunNowResult>(`/api/jobs/${encodeURIComponent(jobId)}/run`, {})
  }

  async files(sessionId: string, offset = 0, limit = 60, contentPrefix?: string): Promise<FilesPage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (contentPrefix) query.set('content_prefix', contentPrefix)
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/files?${query}`)
  }

  async upload(sessionId: string, path: string, callerSignal?: AbortSignal): Promise<AgentFile> {
    const configuration = this.configuration
    callerSignal?.throwIfAborted()
    const form = new FormData()
    const filename = basename(path) || 'upload'
    const blob = await openAsBlob(path, { type: inferredFileContentType(filename) })
    form.append('file', blob, filename)
    callerSignal?.throwIfAborted()
    // Session uploads may legitimately approach the server's multi-gigabyte
    // file limit over a remote profile. Give them a dedicated generous bound
    // instead of the generic 30-second JSON deadline, while retaining both
    // profile and renderer lifecycle cancellation.
    const response = await this.request<{ file: AgentFile }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: 'POST',
      body: form,
      signal: combineAbortSignals(
        configuration.abortController.signal,
        callerSignal,
        this.timeoutSignal(uploadRequestTimeoutMs(blob.size, this.uploadTimeoutMs ?? undefined))
      )
    }, configuration)
    return response.file
  }

  async uploadOpened(
    sessionId: string,
    source: OpenedUploadSource,
    callerSignal?: AbortSignal
  ): Promise<AgentFile> {
    const configuration = this.configuration
    callerSignal?.throwIfAborted()
    if (
      !Number.isSafeInteger(source.fd)
      || source.fd < 0
      || !Number.isSafeInteger(source.byteSize)
      || source.byteSize < 0
    ) throw new Error('The admitted upload file is invalid.')
    const filename = boundedUploadFilename(source.filename)
    const contentType = inferredFileContentType(filename)
    const boundary = `----AgentsDock-${randomUUID().replaceAll('-', '')}`
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${asciiUploadFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8'
    )
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const body = multipartFileBody(source.fd, source.byteSize, prefix, suffix)
    const signal = combineAbortSignals(
      configuration.abortController.signal,
      callerSignal,
      this.timeoutSignal(uploadRequestTimeoutMs(source.byteSize, this.uploadTimeoutMs ?? undefined))
    )
    const response = await this.request<{ file: AgentFile }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/files`,
      {
        method: 'POST',
        body: body as unknown as BodyInit,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(prefix.byteLength + source.byteSize + suffix.byteLength)
        },
        signal,
        // Undici requires duplex for a streaming request body. Electron's
        // RequestInit declaration has not standardized this Node extension.
        ...({ duplex: 'half' } as Record<string, unknown>)
      } as RequestInit,
      configuration
    )
    return response.file
  }

  async fileEvent(sessionId: string, fileId: string): Promise<Event | null> {
    try {
      return compactTimelineEvent((await this.get<{ event: Event }>(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/event`)).event)
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return null
      throw error
    }
  }

  workspaceInfo(sessionId: string): Promise<WorkspaceInfo> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`)
  }

  workspaceEntries(sessionId: string, path = '', offset = 0, limit = 500): Promise<WorkspaceEntriesPage> {
    const query = new URLSearchParams({ path, offset: String(offset), limit: String(limit) })
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entries?${query}`)
  }

  workspaceSearch(sessionId: string, query = '', limit = 100): Promise<WorkspaceSearchPage> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/search?${params}`)
  }

  completeWorkingDirectory(path: string, limit = 24): Promise<WorkingDirectoryCompletion> {
    const query = new URLSearchParams({ path, limit: String(limit) })
    return this.get(`/api/working-directories/complete?${query}`)
  }

  workspaceFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path })
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?${query}`)
  }

  absoluteFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path })
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/absolute-file?${query}`)
  }

  writeAbsoluteFile(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/absolute-file`, {
      path,
      content,
      expected_revision: expectedRevision
    })
  }

  workspacePreviewRequest(
    sessionId: string,
    path: string,
    request?: Request,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    const configuration = this.configuration
    const method = request?.method?.toUpperCase() ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') throw new TypeError('Workspace previews only support GET and HEAD')
    const headers = new Headers()
    const range = request?.headers.get('Range')
    if (range) headers.set('Range', range)
    this.applyAuth(headers, configuration)
    const query = new URLSearchParams({ path })
    return fetch(configurationURL(
      configuration,
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace/preview?${query}`
    ), {
      method,
      headers,
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, request?.signal, callerSignal)
    })
  }

  workspaceDownloadRequest(
    sessionId: string,
    path: string,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    const configuration = this.configuration
    const headers = new Headers()
    this.applyAuth(headers, configuration)
    const query = new URLSearchParams({ path })
    return fetch(configurationURL(
      configuration,
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace/download?${query}`
    ), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, callerSignal)
    })
  }

  createWorkspaceEntry(
    sessionId: string,
    path: string,
    kind: 'file' | 'directory'
  ): Promise<WorkspaceCreateResult> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry`, {
      path,
      kind
    })
  }

  writeWorkspaceFile(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/file`, {
      path,
      content,
      expected_revision: expectedRevision
    })
  }

  renameWorkspaceEntry(
    sessionId: string,
    path: string,
    newName: string,
    expectedRevision: string
  ): Promise<WorkspaceRenameResult> {
    return this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry`, {
      path,
      new_name: newName,
      expected_revision: expectedRevision
    })
  }

  removeWorkspaceEntry(
    sessionId: string,
    path: string,
    expectedRevision: string,
    recursive: boolean
  ): Promise<WorkspaceRemoveResult> {
    const query = new URLSearchParams({
      path,
      expected_revision: expectedRevision,
      recursive: String(recursive)
    })
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry?${query}`)
  }

  async processes(sessionId: string): Promise<ProcessSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/processes`)
  }

  async processLog(sessionId: string, path: string, lines = 200): Promise<string> {
    const query = new URLSearchParams({ path, lines: String(lines) })
    const response = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/processes/log?${query}`)
    return response.text ?? response.output ?? ''
  }

  async tmux(sessionId: string, includeAll = false): Promise<TmuxPane[]> {
    const response = await this.get<{ panes?: TmuxPane[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux?include_all=${includeAll}`)
    return response.panes ?? []
  }

  async captureTmux(sessionId: string, paneId: string, lines = 500): Promise<string> {
    const query = new URLSearchParams({ pane_id: paneId, lines: String(lines) })
    const response = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux/capture?${query}`)
    return response.text ?? response.output ?? ''
  }

  terminal(
    sessionId: string,
    options: TerminalConnectOptions,
    onData: (data: string) => void,
    onState: (state: TerminalStateEvent) => void
  ): TerminalConnection {
    const configuration = this.configuration
    const endpoint = new URL(configurationURL(configuration, `/api/sessions/${encodeURIComponent(sessionId)}/terminal/ws`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let retryDelay = 500
    let retry: NodeJS.Timeout | null = null
    let activeConnectWatchdog: NodeJS.Timeout | null = null
    let resizeSync: NodeJS.Timeout | null = null
    let socket: WebSocket | null = null
    let fatalError: string | null = null
    let columns = options.columns
    let rows = options.rows
    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (retry) clearTimeout(retry)
      if (activeConnectWatchdog) clearTimeout(activeConnectWatchdog)
      if (resizeSync) clearTimeout(resizeSync)
      retry = null
      activeConnectWatchdog = null
      resizeSync = null
      configuration.transports.delete(stop)
      socket?.close()
    }
    const syncTerminalSize = (): void => {
      if (stopped) return
      if (resizeSync) clearTimeout(resizeSync)
      resizeSync = setTimeout(() => {
        resizeSync = null
        void this.post(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/resize`, { columns, rows }, configuration).catch(() => undefined)
      }, 120)
    }

    const connect = (): void => {
      if (stopped) return
      retry = null
      onState({ sessionId, state: retryDelay === 500 ? 'connecting' : 'reconnecting' })
      const url = new URL(endpoint)
      url.searchParams.set('columns', String(columns))
      url.searchParams.set('rows', String(rows))
      if (options.cwd) url.searchParams.set('cwd', options.cwd)
      const protocols = authenticatedWebSocketProtocols(
        configuration,
        url,
        TERMINAL_STREAM_PROTOCOL
      )
      const currentDecoder = new TextDecoder()
      const current = new WebSocket(url, protocols)
      socket = current
      current.binaryType = 'arraybuffer'
      let disconnected = false
      let connectWatchdog: NodeJS.Timeout | null = null
      const clearConnectWatchdog = (): void => {
        const timer = connectWatchdog
        if (!timer) return
        clearTimeout(timer)
        connectWatchdog = null
        if (activeConnectWatchdog === timer) activeConnectWatchdog = null
      }
      const reconnect = (error?: string | null): void => {
        if (stopped || disconnected || socket !== current) return
        disconnected = true
        clearConnectWatchdog()
        onState({ sessionId, state: 'reconnecting', error: error || null })
        const jitter = Math.floor(Math.random() * Math.min(250, retryDelay / 3))
        retry = setTimeout(connect, retryDelay + jitter)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      connectWatchdog = setTimeout(() => {
        if (stopped || disconnected || socket !== current || current.readyState !== 0) return
        current.close()
        reconnect('Terminal connection timed out')
      }, 10_000)
      activeConnectWatchdog = connectWatchdog
      current.addEventListener('open', () => {
        if (stopped || disconnected || socket !== current) return
        clearConnectWatchdog()
      })
      current.addEventListener('message', message => {
        if (stopped || disconnected || socket !== current) return
        if (typeof message.data === 'string') {
          try {
            const control = JSON.parse(message.data) as { type?: string; name?: string; message?: string }
            if (control.type === 'ready') {
              retryDelay = 500
              onState({ sessionId, state: 'connected', name: control.name ?? null })
            } else if (control.type === 'error') {
              // Unmarked server control errors can be transient (for example,
              // a tmux attach race during managed restart). Only the explicit
              // 44xx close codes below are durable/fatal. Retry this socket so
              // a recoverable validation or attach error cannot permanently
              // disable the terminal for the lifetime of the renderer.
              reconnect(control.message || 'Terminal connection failed')
              current.close()
            }
          } catch { /* ignore malformed control packets */ }
          return
        }
        let bytes: Uint8Array | null = null
        if (message.data instanceof ArrayBuffer) bytes = new Uint8Array(message.data)
        else if (ArrayBuffer.isView(message.data)) bytes = new Uint8Array(message.data.buffer, message.data.byteOffset, message.data.byteLength)
        else if (message.data && typeof message.data === 'object' && 'byteLength' in message.data) bytes = new Uint8Array(message.data as ArrayBuffer)
        else if (message.data instanceof Blob) {
          void message.data.arrayBuffer().then(buffer => {
            if (stopped || disconnected || socket !== current) return
            const blobBytes = new Uint8Array(buffer)
            if (blobBytes.byteLength) onData(currentDecoder.decode(blobBytes, { stream: true }))
          })
          return
        }
        if (bytes?.byteLength) onData(currentDecoder.decode(bytes, { stream: true }))
      })
      current.addEventListener('close', event => {
        clearConnectWatchdog()
        if (socket !== current || disconnected) return
        const tail = currentDecoder.decode()
        if (stopped) {
          if (!fatalError) onState({ sessionId, state: 'disconnected' })
          return
        }
        if (tail) onData(tail)
        if (event.code === 4401 || event.code === 4404 || event.code === 4406 || event.code === 4409) {
          fatalError = event.code === 4401
            ? 'Terminal authorization failed'
            : event.code === 4404
              ? 'Chat not found'
              : event.code === 4406
                ? 'Terminal protocol was rejected'
                : 'Unarchive this chat before opening its terminal.'
          stop()
          onState({ sessionId, state: 'error', error: fatalError })
          return
        }
        reconnect(event.reason)
      })
      current.addEventListener('error', () => {
        if (stopped || disconnected || socket !== current) return
        current.close()
        reconnect('Terminal connection interrupted')
      })
    }

    configuration.transports.add(stop)
    if (configuration.abortController.signal.aborted) stop()
    else connect()
    return {
      write(data: string): void {
        if (stopped) return
        if (socket?.readyState === 1) socket.send(new TextEncoder().encode(data))
      },
      resize(nextColumns: number, nextRows: number): void {
        if (stopped) return
        columns = nextColumns
        rows = nextRows
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'resize', columns, rows }))
        syncTerminalSize()
      },
      scroll(delta: number): void {
        if (stopped) return
        const bounded = Math.max(-80, Math.min(80, Math.trunc(delta)))
        if (bounded && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'scroll', delta: bounded }))
      },
      close: stop
    }
  }

  /** Opens one authenticated loopback proxy scoped to a chat lifecycle. */
  portTunnelSocket(sessionId: string, remotePort: number): WebSocket {
    if (!Number.isSafeInteger(remotePort) || remotePort < 1_024 || remotePort > 65_535) {
      throw new Error('Remote port must be an integer from 1024 through 65535.')
    }
    const configuration = this.configuration
    const endpoint = new URL(configurationURL(
      configuration,
      `/api/sessions/${encodeURIComponent(sessionId)}/ports/${remotePort}/tunnel/ws`
    ))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(endpoint, [
      PORT_TUNNEL_SUBPROTOCOL,
      ...agentTokenWebSocketProtocols(configuration.token)
    ])
    socket.binaryType = 'arraybuffer'
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      configuration.transports.delete(stop)
      if (socket.readyState < 2) socket.close(1000, 'AgentsServer client disposed')
    }
    configuration.transports.add(stop)
    socket.addEventListener('close', () => {
      stopped = true
      configuration.transports.delete(stop)
    })
    if (configuration.abortController.signal.aborted) stop()
    return socket
  }

  async deleteTerminal(sessionId: string): Promise<boolean> {
    const response = await this.delete<{ killed?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`)
    return response.killed ?? true
  }

  terminalWindows(sessionId: string): Promise<TerminalWindowsSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/windows`)
  }

  terminalAction(sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, { action, target: target ?? null })
  }

  async sendDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<boolean> {
    const response = await this.post<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest/send`, {
      target_session_id: targetSessionId,
      detail,
      user_prompt: userPrompt || null
    })
    return response.ok
  }

  async previewDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<string> {
    const response = await this.post<{ digest: string }>(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest`, {
      target_session_id: targetSessionId || null,
      detail,
      user_prompt: userPrompt || null
    }, this.configuration, DIGEST_PREVIEW_REQUEST_TIMEOUT_MS)
    return response.digest
  }

  fileRequest(sessionId: string, fileId: string, request?: Request, callerSignal?: AbortSignal): Promise<Response> {
    const configuration = this.configuration
    const headers = new Headers(request?.headers)
    this.applyAuth(headers, configuration)
    return fetch(configurationURL(
      configuration,
      `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`
    ), {
      method: request?.method ?? 'GET',
      headers,
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, request?.signal, callerSignal)
    })
  }

  linkedFileRequest(sessionId: string, target: string): Promise<Response> {
    const configuration = this.configuration
    const headers = new Headers()
    this.applyAuth(headers, configuration)
    const query = new URLSearchParams({ target })
    return fetch(configurationURL(configuration, `/api/sessions/${encodeURIComponent(sessionId)}/links/file?${query}`), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, AbortSignal.timeout(30_000))
    })
  }

  stream(
    sessionId: string,
    after: number,
    onEvent: (event: Event) => void,
    onState: (connected: boolean, error?: string) => void,
    onProviderRuntime?: (event: ProviderRuntimeChanged) => void,
    onPinnedItemsChanged?: (event: TimelinePinsChanged) => void
  ): () => void {
    const configuration = this.configuration
    const endpoint = new URL(configurationURL(configuration, `/api/sessions/${encodeURIComponent(sessionId)}/events`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let lastSeq = after
    let retryDelay = 500
    let socket: WebSocket | null = null
    let retry: NodeJS.Timeout | null = null
    let connectWatchdog: NodeJS.Timeout | null = null
    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (retry) clearTimeout(retry)
      if (connectWatchdog) clearTimeout(connectWatchdog)
      retry = null
      connectWatchdog = null
      configuration.transports.delete(stop)
      socket?.close()
    }
    const connect = (): void => {
      if (stopped) return
      const url = new URL(endpoint)
      url.searchParams.set('after', String(lastSeq))
      url.searchParams.set('visible', 'true')
      const protocols = authenticatedWebSocketProtocols(
        configuration,
        url,
        EVENTS_STREAM_PROTOCOL
      )
      const current = new WebSocket(url, protocols)
      socket = current
      let disconnected = false
      const disconnect = (error?: string): void => {
        if (stopped || disconnected) return
        disconnected = true
        if (connectWatchdog) clearTimeout(connectWatchdog)
        connectWatchdog = null
        onState(false, error)
        const jitter = Math.floor(Math.random() * Math.min(250, retryDelay / 3))
        retry = setTimeout(connect, retryDelay + jitter)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      connectWatchdog = setTimeout(() => {
        if (stopped || disconnected || current.readyState !== 0) return
        current.close()
        disconnect('Live updates timed out')
      }, 10_000)
      current.addEventListener('open', () => {
        if (stopped || disconnected) return
        if (connectWatchdog) clearTimeout(connectWatchdog)
        connectWatchdog = null
        retryDelay = 500
        onState(true)
      })
      current.addEventListener('message', message => {
        if (stopped || disconnected) return
        try {
          const packet = JSON.parse(String(message.data)) as unknown
          if (isProviderRuntimeChanged(packet)) {
            if (packet.session_id === sessionId) onProviderRuntime?.(packet)
            return
          }
          if (isTimelinePinsChanged(packet)) {
            if (packet.session_id === sessionId) onPinnedItemsChanged?.(packet)
            return
          }
          const event = packet as Event
          if (!Number.isFinite(event.seq) || event.seq <= lastSeq) return
          lastSeq = event.seq
          onEvent(compactTimelineEvent(event))
        } catch { /* ignore malformed packets */ }
      })
      current.addEventListener('close', () => disconnect())
      current.addEventListener('error', () => {
        current.close()
        disconnect('Live updates disconnected')
      })
    }
    configuration.transports.add(stop)
    if (configuration.abortController.signal.aborted) stop()
    else connect()
    return stop
  }

  emergencyStream(
    expectedServerIdentity: string,
    onSessions: (sessions: Session[], snapshot: boolean, removedSessionId?: string) => void,
    onState: (connected: boolean, error?: string) => void
  ): () => void {
    const expectedIdentity = expectedServerIdentity.trim()
    if (!expectedIdentity || expectedIdentity.length > 240) {
      throw new Error('Emergency alert stream requires a verified server identity')
    }
    const configuration = this.configuration
    const endpoint = new URL(configurationURL(configuration, '/api/emergency-alerts/events'))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let retryDelay = 500
    let socket: WebSocket | null = null
    let retry: NodeJS.Timeout | null = null
    let activeConnectWatchdog: NodeJS.Timeout | null = null
    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (retry) clearTimeout(retry)
      if (activeConnectWatchdog) clearTimeout(activeConnectWatchdog)
      retry = null
      activeConnectWatchdog = null
      configuration.transports.delete(stop)
      socket?.close()
    }
    const connect = (): void => {
      if (stopped) return
      retry = null
      const url = new URL(endpoint)
      const current = new WebSocket(
        url,
        [
          EMERGENCY_STREAM_PROTOCOL,
          ...agentTokenWebSocketProtocols(configuration.token)
        ]
      )
      socket = current
      let disconnected = false
      let connectWatchdog: NodeJS.Timeout | null = null
      const clearConnectWatchdog = (): void => {
        const timer = connectWatchdog
        if (!timer) return
        clearTimeout(timer)
        connectWatchdog = null
        if (activeConnectWatchdog === timer) activeConnectWatchdog = null
      }
      const disconnect = (error?: string): void => {
        if (stopped || disconnected || socket !== current) return
        disconnected = true
        clearConnectWatchdog()
        onState(false, error)
        const jitter = Math.floor(Math.random() * Math.min(250, retryDelay / 3))
        retry = setTimeout(connect, retryDelay + jitter)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      connectWatchdog = setTimeout(() => {
        if (stopped || disconnected || socket !== current || current.readyState !== 0) return
        current.close()
        disconnect('Emergency alert stream timed out')
      }, 10_000)
      activeConnectWatchdog = connectWatchdog
      current.addEventListener('open', () => {
        if (stopped || disconnected || socket !== current) return
        clearConnectWatchdog()
        retryDelay = 500
        onState(true)
      })
      current.addEventListener('message', message => {
        if (stopped || disconnected || socket !== current) return
        const rejectPacket = (reason: string): void => {
          current.close(1008, 'Invalid emergency alert packet')
          disconnect(reason)
        }
        try {
          const raw = String(message.data)
          if (raw.length > EMERGENCY_STREAM_MAX_PACKET_CHARS) {
            rejectPacket('Emergency alert stream sent an oversized packet')
            return
          }
          const packet = JSON.parse(raw) as Record<string, unknown>
          if (packet.server_identity !== expectedIdentity) {
            rejectPacket('Emergency alert stream server identity changed')
            return
          }
          if (packet.type === 'emergency_snapshot' && Array.isArray(packet.sessions)) {
            if (packet.sessions.length > EMERGENCY_STREAM_MAX_SESSIONS) {
              rejectPacket('Emergency alert stream sent too many sessions')
              return
            }
            const sessions = packet.sessions.filter(isEmergencySessionPacket)
            if (sessions.length !== packet.sessions.length) {
              rejectPacket('Emergency alert stream sent an invalid snapshot')
              return
            }
            onSessions(sessions, true)
          } else if (packet.type === 'emergency_changed' && isEmergencySessionPacket(packet.session)) {
            onSessions([packet.session], false)
          } else if (
            packet.type === 'emergency_removed'
            && typeof packet.session_id === 'string'
            && packet.session_id.length > 0
            && packet.session_id.length <= 128
          ) {
            onSessions([], false, packet.session_id)
          } else {
            rejectPacket('Emergency alert stream sent an invalid update')
          }
        } catch {
          rejectPacket('Emergency alert stream sent malformed JSON')
        }
      })
      current.addEventListener('close', event => {
        clearConnectWatchdog()
        if (stopped || disconnected || socket !== current) return
        const fatalError = event.code === 4401
          ? 'Emergency alert authorization failed'
          : event.code === 4406
            ? 'Emergency alert protocol was rejected'
            : null
        if (fatalError) {
          stop()
          onState(false, fatalError)
          return
        }
        disconnect(event.reason || undefined)
      })
      current.addEventListener('error', () => {
        if (stopped || disconnected || socket !== current) return
        current.close()
        disconnect('Emergency alert stream disconnected')
      })
    }
    configuration.transports.add(stop)
    if (configuration.abortController.signal.aborted) stop()
    else connect()
    return stop
  }

  /** One metadata-only stream. Retries only follow transport failure, never idle polling. */
  mailHintStream(
    expectedServerIdentity: string,
    mailbox: MailHintMailbox,
    previousCursor: () => MailboxCoverage | null,
    onPacket: (packet: TeamActivityHintPacket) => void,
    onFatal: () => void,
    onDisconnect: () => void = () => {},
    activity?: { previousBulletin(): BulletinChangeCursor | null }
  ): () => void {
    const configuration = this.configuration
    const protocol = activity ? TEAM_ACTIVITY_HINTS_PROTOCOL : TEAM_MAIL_HINTS_PROTOCOL
    const endpoint = new URL(configurationURL(configuration, TEAM_MAIL_HINTS_PATH))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let socket: WebSocket | null = null
    let retry: NodeJS.Timeout | null = null
    let watchdog: NodeJS.Timeout | null = null
    let delay = 500
    const clearWatchdog = (): void => { if (watchdog) clearTimeout(watchdog); watchdog = null }
    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (retry) clearTimeout(retry)
      retry = null
      clearWatchdog()
      configuration.transports.delete(stop)
      socket?.close()
    }
    const fatal = (): void => { stop(); onFatal() }
    const connect = (): void => {
      if (stopped) return
      retry = null
      const current = new WebSocket(endpoint, [protocol, ...agentTokenWebSocketProtocols(configuration.token)])
      socket = current
      let disconnected = false
      let first: MailHintPacket | null = null
      let offered: MailboxCoverage | null = null
      const active = (): boolean => !stopped && !disconnected && socket === current
      const disconnect = (): void => {
        if (!active()) return
        disconnected = true
        clearWatchdog()
        onDisconnect()
        retry = setTimeout(connect, delay + Math.floor(Math.random() * Math.min(250, delay / 3)))
        delay = Math.min(10_000, delay * 2)
      }
      // Includes the first authenticated snapshot, not merely TCP connection.
      // Member bootstrap may wait 15s for its feed, 10s for exact retained-
      // anchor proof and 5s for its first write; retain 5s scheduling margin.
      // This bounds bootstrap only, never idle.
      watchdog = setTimeout(() => { if (active()) { disconnect(); current.close() } }, 35_000)
      current.addEventListener('open', () => {
        if (!active()) return
        try {
          if (current.protocol !== protocol) throw new Error('Mail protocol was not negotiated')
          offered = previousCursor()
          const previous = activity && offered ? { version: 2,
            mail: { ...offered, reset: false },
            bulletin: { ...(activity.previousBulletin() ?? emptyBulletinCursor(mailbox.team_id)), reset: false }
          } : offered
          current.send(JSON.stringify({ version: activity ? 2 : 1, team_id: mailbox.team_id, previous_cursor: previous }))
        } catch { fatal() }
      })
      current.addEventListener('message', message => {
        if (!active()) return
        try {
          if (typeof message.data !== 'string' || message.data.length > TEAM_MAIL_HINTS_MAX_PACKET_CHARS) throw new Error('Invalid packet')
          const packet = activity ? parseTeamActivityHintPacket(JSON.parse(message.data)) : parseMailHintPacket(JSON.parse(message.data))
          if (packet.server_identity !== expectedServerIdentity || packet.hub_id !== mailbox.hub_id
            || packet.cursor.team_id !== mailbox.team_id
            || (mailbox.recipient_server_id !== null && packet.cursor.recipient_server_id !== mailbox.recipient_server_id)) throw new Error('Scope changed')
          if (!first) {
            if (packet.type !== 'snapshot' || (offered && offered.recipient_server_id !== packet.cursor.recipient_server_id && !packet.cursor.reset)) throw new Error('Invalid snapshot')
            first = packet
            delay = 500
            clearWatchdog()
          } else if (packet.type !== 'hint' || packet.stream_id !== first.stream_id
            || packet.cursor.recipient_server_id !== first.cursor.recipient_server_id) throw new Error('Stream changed')
          onPacket(packet)
        } catch { fatal() }
      })
      current.addEventListener('close', event => {
        if (!active()) return
        if ([1008, 4401, 4403, 4406].includes(event.code)) fatal()
        else disconnect()
      })
      current.addEventListener('error', () => { if (active()) { disconnect(); current.close() } })
    }
    configuration.transports.add(stop)
    if (configuration.abortController.signal.aborted) stop()
    else connect()
    return stop
  }

  private get<T>(path: string, configuration = this.configuration, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, maxResponseBytes?: number): Promise<T> {
    return this.request(path, { signal: AbortSignal.timeout(timeoutMs) }, configuration, maxResponseBytes)
  }
  private post<T>(path: string, body: unknown, configuration = this.configuration, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, maxResponseBytes?: number): Promise<T> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }, configuration, maxResponseBytes)
  }
  private put<T>(path: string, body: unknown, configuration = this.configuration): Promise<T> { return this.request(path, { method: 'PUT', body: JSON.stringify(body) }, configuration) }
  private patch<T>(path: string, body: unknown, configuration = this.configuration): Promise<T> { return this.request(path, { method: 'PATCH', body: JSON.stringify(body) }, configuration) }
  private delete<T>(path: string, configuration = this.configuration): Promise<T> { return this.request(path, { method: 'DELETE' }, configuration) }

  private async securePeerRequest<T>(path: string, init: RequestInit = {}, query?: URLSearchParams, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (!isSecurePeerControlPath(path)) throw new Error('Secure peer control route is invalid.')
    const configuration = this.configuration
    const target = new URL(configurationURL(configuration, path))
    const server = new URL(configuration.baseURL)
    const serverPrefix = server.pathname === '/' ? '' : server.pathname
    if (
      target.origin !== server.origin
      || target.pathname !== `${serverPrefix}${path}`
      || target.search || target.hash || target.username || target.password
    ) {
      throw new Error('Secure peer control route is invalid.')
    }
    if (query) {
      const listQuery = path === '/api/admin/secure-peers/v1/peers' && isExactSecurePeerListQuery(query)
      const completionQuery = path.endsWith('/completion') && isExactSecurePeerCompletionQuery(query)
      if (!listQuery && !completionQuery) {
        throw new Error('Secure peer control route is invalid.')
      }
      target.search = query.toString()
    }
    const method = securePeerMethod(init.method ?? 'GET', ['GET', 'POST', 'PUT'])
    const body = boundedJSONRequestBody(init.body, method)
    const response = await securePeerNodeResponse(target, {
      method,
      headers: securePeerTransportHeaders(configuration.token, body),
      body,
      signal: combineAbortSignals(
        configuration.abortController.signal,
        init.signal,
        AbortSignal.timeout(timeoutMs)
      )
    })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      let rawDetail: unknown
      try {
        const payload = await response.json() as { detail?: unknown; error?: unknown }
        // Secure-peer controls use the Hub-style `{ error: { code, message } }`
        // envelope while the rest of AgentsServer generally uses `detail`.
        // Preserve that authenticated structured error so callers can make a
        // narrowly typed recovery decision without matching public prose.
        rawDetail = payload.detail !== undefined ? payload.detail : payload.error
        detail = formatServerDetail(rawDetail, detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail, rawDetail)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private async privilegedNativeRequest<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    expectedStatus?: number,
    maxResponseBytes?: number
  ): Promise<T> {
    const configuration = this.configuration
    const target = new URL(configurationURL(configuration, path))
    const server = new URL(configuration.baseURL)
    const serverPrefix = server.pathname === '/' ? '' : server.pathname
    const method = securePeerMethod(init.method ?? 'GET', ['GET', 'POST', 'PUT', 'DELETE'])
    if (!isPrivilegedNativeControlTarget(target, server, serverPrefix, method)) {
      throw new Error('Privileged native control route is invalid.')
    }
    const body = boundedJSONRequestBody(init.body, method)
    const response = await securePeerNodeResponse(target, {
      method,
      headers: privilegedNativeTransportHeaders(configuration.token, body),
      body,
      maxResponseBytes,
      signal: combineAbortSignals(
        configuration.abortController.signal,
        init.signal,
        AbortSignal.timeout(timeoutMs)
      )
    })
    if (!response.ok || expectedStatus !== undefined && response.status !== expectedStatus) {
      let detail = `${response.status} ${response.statusText}`
      let rawDetail: unknown
      try {
        const payload = await response.json() as { detail?: unknown }
        rawDetail = payload.detail
        detail = formatServerDetail(payload.detail, detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail, rawDetail)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private async requestText(path: string): Promise<string> {
    const configuration = this.configuration
    const headers = new Headers()
    this.applyAuth(headers, configuration)
    const response = await fetch(configurationURL(configuration, path), {
      headers,
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, AbortSignal.timeout(30_000))
    })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      let rawDetail: unknown
      try {
        const body = await response.json() as { detail?: unknown }
        rawDetail = body.detail
        detail = formatServerDetail(body.detail, detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail, rawDetail)
    }
    return response.text()
  }

  private chatSharePath(sessionId: string, mode: ChatShareMode): string {
    return `/api/admin/${chatShareMode(mode) === 'snapshot' ? 'chat-shares' : 'interactive-chat-shares'}/${chatShareId(sessionId)}`
  }

  async previewChatShare(sessionId: string) {
    return parseChatSharePreview(await this.privilegedNativeRequest(`${this.chatSharePath(sessionId, 'snapshot')}/preview`,
      { method: 'POST', body: '{}' }, CHAT_SHARE_SNAPSHOT_TIMEOUT_MS, 200, 4 * 1024 * 1024))
  }

  async listChatShares(sessionId: string, mode: ChatShareMode) {
    return parseChatShareList(await this.privilegedNativeRequest(this.chatSharePath(sessionId, mode), {}, DEFAULT_REQUEST_TIMEOUT_MS, 200, 256 * 1024), mode)
  }

  async createChatShare(sessionId: string, input: CreateChatShareInput) {
    // The operator may choose another address for the browser link (e.g. LAN
    // instead of VPN). It is body data only: management and native credentials
    // stay on the existing authenticated connection, with no alias probing.
    const requested = chatShareCreateBody(input)
    const body = { ...requested, base_url: requested.base_url ?? new URL(this.configuration.baseURL).origin }
    const created = parseCreatedChatShare(await this.privilegedNativeRequest(this.chatSharePath(sessionId, input.mode),
      { method: 'POST', body: JSON.stringify(body) }, input.mode === 'snapshot' ? CHAT_SHARE_SNAPSHOT_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS, 201, 32 * 1024), input.mode)
    if ((created.url === null && requested.base_url !== undefined)
      || (created.url !== null && new URL(created.url).origin !== body.base_url)) {
      throw new Error('The server did not confirm the selected share address. Check Existing shares before creating another link.')
    }
    return created
  }

  async revokeChatShare(sessionId: string, mode: ChatShareMode, shareId: string): Promise<void> {
    const value = await this.privilegedNativeRequest<{ revoked?: boolean }>(`${this.chatSharePath(sessionId, mode)}/${chatShareId(shareId)}`,
      { method: 'DELETE' }, DEFAULT_REQUEST_TIMEOUT_MS, 200, 8192)
    if (value?.revoked !== true) throw new Error('Share revocation was not confirmed.')
  }

  private async request<T>(path: string, init: RequestInit = {}, configuration = this.configuration, maxResponseBytes?: number): Promise<T> {
    const headers = new Headers(init.headers)
    this.applyAuth(headers, configuration)
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch(configurationURL(configuration, path), {
      ...init,
      headers,
      // Never allow a profile credential to be replayed to a redirect target.
      // Even same-origin redirects are rejected so an intermediary cannot
      // silently rewrite the authenticated method or request body.
      redirect: 'error',
      signal: combineAbortSignals(configuration.abortController.signal, init.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS))
    })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      let rawDetail: unknown
      try {
        const body = (maxResponseBytes == null
          ? await response.json()
          : await boundedJSONResponse(response, maxResponseBytes)) as { detail?: unknown }
        rawDetail = body.detail
        detail = formatServerDetail(body.detail, detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail, rawDetail)
    }
    if (response.status === 204) return undefined as T
    if (maxResponseBytes != null) return await boundedJSONResponse(response, maxResponseBytes) as T
    return response.json() as Promise<T>
  }

  private applyAuth(headers: Headers, configuration: ClientConfiguration): void {
    if (configuration.token) headers.set('X-AgentsDock-Token', configuration.token)
  }
}

function normalizeServerUpdateStatus(status: ServerUpdateStatus): ServerUpdateStatus {
  const installedCurrent = status.installed_version !== undefined
    && status.current_version === status.installed_version
  const targetCurrent = status.target_version !== undefined
    && status.current_version === status.target_version
  if (
    status.phase !== 'current'
    && !(status.phase === 'complete' && (installedCurrent || targetCurrent))
  ) return status
  return status.update_available === false ? status : { ...status, update_available: false }
}

function securePeerSegment(value: string): string {
  const clean = value.trim()
  if (clean !== value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw new Error('Secure peer identifier is invalid.')
  }
  return clean
}

function isSecurePeerControlPath(path: string): boolean {
  const identifier = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  return new RegExp(`^/api/admin/secure-peers/v1/(?:status|host|peers|pairings|routes|pairings/${identifier}(?:/(?:cancel|approve|reject|activate|completion))?|connections/${identifier}/(?:deactivate|forget|endpoint)|peers/${identifier}/revoke|routes/${identifier}/revoke)$`).test(path)
}

function isExactSecurePeerCompletionQuery(query: URLSearchParams): boolean {
  const keys = [...query.keys()]
  return keys.length === 3 && new Set(keys).size === 3
    && keys.every(key => ['expected_server_identity', 'expected_server_instance_id', 'expected_transcript_hash'].includes(key))
    && [...query.values()].every(value => Boolean(value) && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value))
    && /^[0-9a-f]{64}$/.test(query.get('expected_transcript_hash') ?? '')
}

function isExactSecurePeerListQuery(query: URLSearchParams): boolean {
  const keys = [...query.keys()]
  return keys.length === 3
    && new Set(keys).size === 3
    && keys.every(key => ['expected_server_identity', 'expected_server_instance_id', 'team_id'].includes(key))
    && [...query.values()].every(value => Boolean(value) && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value))
}

function isEmergencySessionPacket(value: unknown): value is Session {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  if (
    typeof session.id !== 'string'
    || !session.id
    || session.id.length > 128
    || typeof session.title !== 'string'
    || !session.title
    || session.title.length > 240
    || (session.backend !== 'codex' && session.backend !== 'claude' && session.backend !== 'cursor')
    || typeof session.unacknowledged_emergency_count !== 'number'
    || !Number.isSafeInteger(session.unacknowledged_emergency_count)
    || session.unacknowledged_emergency_count < 0
  ) return false
  if (session.emergency_alert == null) return session.unacknowledged_emergency_count === 0
  if (typeof session.emergency_alert !== 'object' || Array.isArray(session.emergency_alert)) return false
  const alert = session.emergency_alert as Record<string, unknown>
  return session.unacknowledged_emergency_count > 0
    && typeof alert.id === 'string'
    && /^emergency_[0-9a-f]{32}$/.test(alert.id)
    && alert.status === 'active'
    && alert.severity === 'critical'
    && typeof alert.message === 'string'
    && alert.message.length > 0
    && alert.message.length <= 500
    && typeof alert.raised_at === 'string'
    && alert.raised_at.length > 0
    && alert.raised_at.length <= 80
    && (
      alert.source_run_id == null
      || (typeof alert.source_run_id === 'string' && alert.source_run_id.length <= 160)
    )
}

function isProviderRuntimeChanged(value: unknown): value is ProviderRuntimeChanged {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return packet.type === 'provider_runtime_changed'
    && packet.ephemeral === true
    && packet.runtime === 'context_usage'
    && (packet.backend === 'claude' || packet.backend === 'codex')
    && typeof packet.session_id === 'string'
    && packet.session_id.length > 0
}

function isTimelinePinsChanged(value: unknown): value is TimelinePinsChanged {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return packet.type === 'timeline_pins_changed'
    && typeof packet.session_id === 'string'
    && packet.session_id.length > 0
    && packet.session_id.length <= 128
    && Number.isSafeInteger(packet.revision)
    && Number(packet.revision) >= 0
    && typeof packet.updated_at === 'string'
    && packet.updated_at.length > 0
    && packet.updated_at.length <= 80
    && Number.isFinite(Date.parse(packet.updated_at))
}

function parsePinnedItemsConflict(value: unknown, sessionId: string): PinnedItemsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const detail = value as Record<string, unknown>
  if (detail.code !== 'pin_revision_conflict') return null
  try { return parsePinnedItemsSnapshot(detail, sessionId) } catch { return null }
}

function parsePinnedItemsSnapshot(value: unknown, sessionId: string): PinnedItemsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AgentsServer returned an invalid pinned-items response.')
  }
  const response = value as Record<string, unknown>
  if (!Array.isArray(response.pins) || response.pins.length > PINNED_ITEMS_MAX_ITEMS) {
    throw new Error('AgentsServer returned an invalid pinned-items response.')
  }
  const pins = response.pins.map(item => normalizePinnedItemForSync(item, sessionId, false))
  if (new Set(pins.map(item => item.id)).size !== pins.length) {
    throw new Error('AgentsServer returned duplicate pinned items.')
  }
  if (!Number.isSafeInteger(response.revision) || Number(response.revision) < 0) {
    throw new Error('AgentsServer returned an invalid pinned-items revision.')
  }
  const revision = Number(response.revision)
  const updatedAt = response.updatedAt === null && revision === 0
    ? null
    : typeof response.updatedAt === 'string'
      && response.updatedAt.length > 0
      && response.updatedAt.length <= 80
      && Number.isFinite(Date.parse(response.updatedAt))
      ? response.updatedAt
      : undefined
  if (updatedAt === undefined || response.capabilityVersion !== 1) {
    throw new Error('AgentsServer returned invalid pinned-items metadata.')
  }
  return {
    pins: pins.sort((left, right) => right.createdAt - left.createdAt),
    revision,
    updatedAt,
    capabilityVersion: 1
  }
}

export function normalizePinnedItemForSync(value: unknown, sessionId: string, truncateText = true): PinnedItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pinned item is invalid.')
  }
  const item = value as Record<string, unknown>
  const id = requireBoundedIdentifier(item.id, 'Pinned item identifier', 264)
  const itemSessionId = requireBoundedIdentifier(item.sessionId, 'Pinned item chat', 128)
  if (itemSessionId !== sessionId) throw new Error('Pinned item belongs to a different chat.')
  if (item.kind !== 'message' && item.kind !== 'file') throw new Error('Pinned item kind is invalid.')
  const eventId = optionalBoundedString(item.eventId, 256, false)
  const fileId = optionalBoundedString(item.fileId, 256, false)
  if (item.kind === 'message' && !eventId) throw new Error('Pinned message event is invalid.')
  if (item.kind === 'file' && !fileId) throw new Error('Pinned file identifier is invalid.')
  if (!Number.isSafeInteger(item.createdAt) || Number(item.createdAt) < 0) {
    throw new Error('Pinned item timestamp is invalid.')
  }
  const title = boundedString(item.title, 'Pinned item title', 1_000, truncateText)
  if (!title.trim()) throw new Error('Pinned item title is empty.')
  const normalized: PinnedItem = {
    id,
    sessionId: itemSessionId,
    kind: item.kind,
    title,
    createdAt: Number(item.createdAt)
  }
  assignOptional(normalized, 'eventId', eventId)
  assignOptional(normalized, 'fileId', fileId)
  assignOptional(normalized, 'fileSessionId', optionalBoundedString(item.fileSessionId, 128, false))
  assignOptional(normalized, 'filename', optionalBoundedString(item.filename, 4_096, truncateText))
  assignOptional(normalized, 'content_type', optionalBoundedString(item.content_type, 512, truncateText))
  assignOptional(normalized, 'path', optionalBoundedString(item.path, 4_096, truncateText))
  assignOptional(normalized, 'source_path', optionalBoundedString(item.source_path, 4_096, truncateText))
  assignOptional(normalized, 'subtitle', item.kind === 'file' && truncateText
    ? null
    : optionalBoundedString(item.subtitle, 2_000, truncateText))
  assignOptional(normalized, 'body', item.kind === 'file' && truncateText
    ? null
    : optionalBoundedString(item.body, 24_000, truncateText))
  return normalized
}

function requireBoundedIdentifier(value: unknown, label: string, maxLength: number): string {
  const result = boundedString(value, label, maxLength, false)
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} is invalid.`)
  return result
}

function boundedString(value: unknown, label: string, maxLength: number, truncate: boolean): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`)
  if (value.length <= maxLength) return value
  if (!truncate) throw new Error(`${label} is too long.`)
  return value.slice(0, maxLength)
}

function optionalBoundedString(value: unknown, maxLength: number, truncate: boolean): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return boundedString(value, 'Pinned item field', maxLength, truncate)
}

function assignOptional<K extends keyof PinnedItem>(
  item: PinnedItem,
  key: K,
  value: PinnedItem[K] | undefined
): void {
  if (value !== undefined) item[key] = value
}

function createConfiguration(baseURL: string, token: string): ClientConfiguration {
  return {
    baseURL: normalizeServerURL(baseURL),
    token,
    websocketSubprotocolAuth: false,
    abortController: new AbortController(),
    transports: new Set(),
    securePeerAdmissions: new Map()
  }
}

function authenticatedWebSocketProtocols(
  configuration: ClientConfiguration,
  url: URL,
  endpointProtocol: string
): string[] | undefined {
  if (configuration.websocketSubprotocolAuth) {
    return [endpointProtocol, ...agentTokenWebSocketProtocols(configuration.token)]
  }
  // Preserve compatibility with servers that predate negotiated URL-free
  // authentication. beta.32+ advertises the capability in /api/health and
  // redacts this legacy query form before either Uvicorn logger sees it.
  if (configuration.token) url.searchParams.set('token', configuration.token)
  return undefined
}

function cancelConfiguration(configuration: ClientConfiguration): void {
  if (!configuration.abortController.signal.aborted) configuration.abortController.abort()
  for (const stop of [...configuration.transports]) stop()
  configuration.transports.clear()
}

function configurationURL(configuration: ClientConfiguration, path: string): string {
  return `${configuration.baseURL}${path.startsWith('/') ? path : `/${path}`}`
}

async function boundedJSONResponse(response: Response, maxBytes: number): Promise<unknown> {
  const advertisedLength = response.headers.get('Content-Length')
  if (advertisedLength != null) {
    const normalized = advertisedLength.trim()
    const length = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('AgentsServer returned an invalid Content-Length header.')
    }
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`AgentsServer JSON response exceeds the ${maxBytes}-byte safety limit.`)
    }
  }

  if (!response.body) throw new Error('AgentsServer returned an empty JSON response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`AgentsServer JSON response exceeds the ${maxBytes}-byte safety limit.`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('AgentsServer returned invalid UTF-8 JSON.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('AgentsServer returned invalid JSON.')
  }
}

function combineAbortSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('The upload timeout is invalid.')
  return value
}

/**
 * Allow the server's 25 GiB maximum at a conservative 1 MiB/s plus setup
 * overhead, while retaining a hard eight-hour ceiling for a permanently hung
 * multipart request. Renderer/profile abort signals remain immediate.
 */
export function uploadRequestTimeoutMs(byteSize: number, override?: number): number {
  if (override !== undefined) return positiveTimeout(override)
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error('The upload file size is invalid.')
  const transferMs = Math.ceil(byteSize / UPLOAD_MINIMUM_BYTES_PER_SECOND) * 1_000
  return Math.min(
    UPLOAD_REQUEST_TIMEOUT_CAP_MS,
    Math.max(UPLOAD_REQUEST_TIMEOUT_FLOOR_MS, UPLOAD_REQUEST_TIMEOUT_OVERHEAD_MS + transferMs)
  )
}

function boundedUploadFilename(value: string): string {
  const name = basename(value).trim()
  if (
    !name
    || name === '.'
    || name === '..'
    || Buffer.byteLength(name, 'utf8') > 255
    || /[\u0000-\u001f\u007f]/.test(name)
  ) throw new Error('The upload filename is invalid.')
  return name
}

function asciiUploadFilename(value: string): string {
  const fallback = value.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return fallback || 'upload'
}

function multipartFileBody(
  fd: number,
  byteSize: number,
  prefix: Buffer,
  suffix: Buffer
): Readable {
  return Readable.from((async function * () {
    yield prefix
    if (byteSize > 0) {
      const file = createReadStream('', { fd, autoClose: false, start: 0, end: byteSize - 1 })
      try {
        for await (const chunk of file) yield chunk
      } finally {
        file.destroy()
      }
    }
    yield suffix
  })())
}

type SecurePeerMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'

interface SecurePeerNodeRequest {
  method: SecurePeerMethod
  headers: Headers
  body: Buffer | null
  signal: AbortSignal
  responseMode?: 'json' | 'binary'
  maxResponseBytes?: number
}

function securePeerMethod(value: string, allowed: readonly SecurePeerMethod[]): SecurePeerMethod {
  const method = value.toUpperCase() as SecurePeerMethod
  if (!allowed.includes(method)) throw new TypeError('Secure peer transport rejected an unsupported request method.')
  return method
}

function boundedJSONRequestBody(body: BodyInit | null | undefined, method: SecurePeerMethod): Buffer | null {
  if (body === null || body === undefined) return null
  if (method === 'GET' || method === 'HEAD') throw new TypeError(`Secure peer ${method} requests cannot carry a body.`)
  if (typeof body !== 'string') throw new TypeError('Secure peer requests require a buffered JSON body.')
  const bytes = Buffer.from(body, 'utf8')
  if (bytes.byteLength > SECURE_PEER_MAX_REQUEST_BYTES) throw new Error('Secure peer request body is too large.')
  try { JSON.parse(body) } catch { throw new TypeError('Secure peer requests require a JSON body.') }
  return bytes
}

function boundedTeamAttachmentRequestBody(
  body: BodyInit | null | undefined,
  method: SecurePeerMethod
): Buffer | null {
  if (method === 'GET' || method === 'HEAD') {
    if (body !== null && body !== undefined) throw new TypeError(`Secure peer ${method} requests cannot carry a body.`)
    return null
  }
  if (method !== 'PUT' || !isUint8ArrayBody(body) || body.byteLength < 1) {
    throw new TypeError('Secure peer attachment uploads require one buffered binary chunk.')
  }
  if (body.byteLength > TEAM_ATTACHMENT_CHUNK_MAX_BYTES) {
    throw new Error('Secure peer attachment chunk is too large.')
  }
  return Buffer.from(body)
}

function isUint8ArrayBody(value: BodyInit | null | undefined): value is Uint8Array<ArrayBuffer> {
  return Boolean(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]'
    && typeof (value as Uint8Array).byteLength === 'number'
}

function securePeerTransportHeaders(token: string, body: Buffer | null): Headers {
  const headers = new Headers({ Accept: 'application/json' })
  if (body) {
    headers.set('Content-Type', 'application/json')
    headers.set('Content-Length', String(body.byteLength))
  }
  if (token) headers.set('X-AgentsDock-Token', token)
  return headers
}

function privilegedNativeTransportHeaders(token: string, body: Buffer | null): Headers {
  const headers = new Headers({ Accept: 'application/json' })
  if (body) {
    headers.set('Content-Type', 'application/json')
    headers.set('Content-Length', String(body.byteLength))
  }
  if (token) headers.set('X-AgentsDock-Token', token)
  return headers
}

function isPrivilegedNativeControlTarget(
  target: URL,
  server: URL,
  serverPrefix: string,
  method: SecurePeerMethod
): boolean {
  if (
    target.origin !== server.origin
    || target.hash
    || target.username
    || target.password
    || !target.pathname.startsWith(`${serverPrefix}/api/admin/`)
  ) return false
  const path = target.pathname.slice(serverPrefix.length)
  const share = /^\/api\/admin\/(chat-shares|interactive-chat-shares)\/[A-Za-z0-9_-]{1,128}(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(path)
  if (share) return !target.search && (!share[2] ? method === 'GET' || method === 'POST'
    : share[1] === 'chat-shares' && share[2] === 'preview' ? method === 'POST' : method === 'DELETE')
  if (path === '/api/admin/codex/goals' || path === '/api/admin/codex/subagents') {
    return !target.search && (method === 'GET' || method === 'PUT')
  }
  if (path === '/api/admin/update') {
    if (method !== 'GET') return false
    const keys = [...target.searchParams.keys()]
    return keys.length === 0 || (
      keys.length === 2
      && keys.includes('expected_server_identity')
      && keys.includes('expected_server_instance_id')
    )
  }
  return !target.search && method === 'POST' && (
    path === '/api/admin/update/check'
    || path === '/api/admin/update/start'
    || path === '/api/admin/update/cancel'
    || path === '/api/admin/team-hub/host/enable'
    || path === '/api/admin/team-hub/host/disable'
  )
}

function mergedRequestHeaders(input: string | URL | Request, init: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  return headers
}

function isSecurePeerTeamAttachmentContentPath(target: URL, basePath: string): boolean {
  if (target.search) return false
  const relative = target.pathname.slice(basePath.length)
  return /^\/v1\/teams\/[^/]+\/network\/attachments\/[^/]+\/content$/.test(relative)
}

function securePeerTeamAttachmentHeaders(
  token: string,
  source: Headers,
  method: SecurePeerMethod,
  body: Buffer | null
): Headers {
  const headers = new Headers({ Accept: 'application/octet-stream, application/json' })
  const range = source.get('Range')
  if (range !== null) {
    if (method === 'PUT') throw new TypeError('Secure peer attachment uploads cannot carry a Range header.')
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!match) throw new TypeError('Secure peer attachment Range is invalid.')
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > TEAM_ATTACHMENT_CHUNK_MAX_BYTES) {
      throw new TypeError('Secure peer attachment Range is invalid.')
    }
    headers.set('Range', range)
  }
  if (method === 'PUT') {
    const contentRange = source.get('Content-Range')
    const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange) : null
    if (!match || !body) throw new TypeError('Secure peer attachment Content-Range is invalid.')
    const start = Number(match[1])
    const end = Number(match[2])
    const total = Number(match[3])
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || !Number.isSafeInteger(total)
      || start < 0
      || end < start
      || end >= total
      || end - start + 1 !== body.byteLength
    ) throw new TypeError('Secure peer attachment Content-Range is invalid.')
    const declaredLength = source.get('Content-Length')
    if (declaredLength !== null && declaredLength !== String(body.byteLength)) {
      throw new TypeError('Secure peer attachment Content-Length is invalid.')
    }
    headers.set('Content-Type', 'application/octet-stream')
    headers.set('Content-Length', String(body.byteLength))
    headers.set('Content-Range', contentRange!)
  } else if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError('Secure peer attachment method is invalid.')
  }
  if (token) headers.set('X-AgentsDock-Token', token)
  return headers
}

function securePeerAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function securePeerNodeResponse(url: URL, init: SecurePeerNodeRequest): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new TypeError('Secure peer transport requires HTTP or HTTPS.'))
  }
  if (init.signal.aborted) return Promise.reject(securePeerAbortReason(init.signal))
  const outgoingHeaders: Record<string, string> = {}
  init.headers.forEach((value, name) => { outgoingHeaders[name] = value })
  const responseMode = init.responseMode ?? 'json'
  const maxResponseBytes = init.maxResponseBytes ?? SECURE_PEER_MAX_RESPONSE_BYTES
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    let response: IncomingMessage | null = null
    const cleanup = (): void => init.signal.removeEventListener('abort', onAbort)
    const fail = (cause: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      response?.destroy()
      request.destroy()
      reject(cause)
    }
    const succeed = (value: Response): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const request = transport(url, {
      method: init.method,
      headers: outgoingHeaders,
      agent: false
    }, incoming => {
      response = incoming
      const status = incoming.statusCode ?? 0
      if (status >= 300 && status < 400) {
        fail(new ServerError(status, `Secure peer transport refused an unexpected redirect (${status}).`))
        return
      }
      const contentType = Array.isArray(incoming.headers['content-type'])
        ? incoming.headers['content-type'][0]
        : incoming.headers['content-type']
      if (responseMode === 'json' && status !== 204 && status !== 205 && !isJSONContentType(contentType ?? null)) {
        fail(new Error('Secure peer transport returned an invalid response.'))
        return
      }
      const responseByteLimit = responseMode === 'binary' && (status < 200 || status >= 300)
        ? SECURE_PEER_BINARY_ERROR_MAX_BYTES
        : maxResponseBytes
      const declaredLength = incoming.headers['content-length']
      if (
        Array.isArray(declaredLength)
        || (typeof declaredLength === 'string' && (
          !/^\d+$/.test(declaredLength)
          || (init.method !== 'HEAD' && Number(declaredLength) > responseByteLimit)
        ))
      ) {
        fail(new Error('Secure peer response is too large.'))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      incoming.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > responseByteLimit) {
          fail(new Error('Secure peer response is too large.'))
          return
        }
        chunks.push(chunk)
      })
      incoming.once('aborted', () => fail(new Error('Secure peer response was interrupted.')))
      incoming.once('error', fail)
      incoming.once('end', () => {
        if (settled) return
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
        }
        const body = init.method === 'HEAD' || status === 204 || status === 205 || status === 304
          ? null
          : responseMode === 'json'
            ? Buffer.concat(chunks, total).toString('utf8')
            : Buffer.concat(chunks, total)
        succeed(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers
        }))
      })
    })
    const onAbort = (): void => fail(securePeerAbortReason(init.signal))
    init.signal.addEventListener('abort', onAbort, { once: true })
    request.once('error', error => fail(init.signal.aborted ? securePeerAbortReason(init.signal) : error))
    if (init.signal.aborted) onAbort()
    else request.end(init.body ?? undefined)
  })
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Teamspace setup returned an oversized response.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function parseTeamHubBootstrapProofGrant(value: unknown): TeamHubBootstrapProofGrantResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Teamspace setup returned an invalid response.')
  const item = value as Record<string, unknown>
  const keys = Object.keys(item).sort()
  const expected = [
    'bootstrap_proof', 'expires_at', 'hub_id', 'request_id', 'server_identity',
    'server_instance_id', 'tailnet_login'
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Teamspace setup returned an invalid response.')
  }
  const bounded = (field: string, maxLength = 320): string => {
    const raw = item[field]
    if (typeof raw !== 'string' || !raw || raw.length > maxLength || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw new Error('Teamspace setup returned an invalid response.')
    }
    return raw
  }
  const result = {
    request_id: bounded('request_id', 64),
    server_identity: bounded('server_identity', 240),
    server_instance_id: bounded('server_instance_id', 240),
    hub_id: bounded('hub_id', 240),
    tailnet_login: bounded('tailnet_login', 320),
    expires_at: bounded('expires_at', 80),
    bootstrap_proof: bounded('bootstrap_proof', 128)
  }
  if (!isUUID(result.request_id) || !/^bootstrap_remote\.[A-Za-z0-9_-]{43}$/.test(result.bootstrap_proof)) {
    throw new Error('Teamspace setup returned an invalid response.')
  }
  if (!Number.isFinite(Date.parse(result.expires_at))) throw new Error('Teamspace setup returned an invalid response.')
  return result
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function safeTeamHubBootstrapError(value: string, credential: string): string {
  const withoutExactCredential = credential ? value.split(credential).join('[redacted]') : value
  return withoutExactCredential
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;"'}]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, 'Bearer [redacted]')
    .replace(/bootstrap_remote\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 400) || 'Teamspace setup request failed.'
}

function teamHubBootstrapErrorDetail(
  item: { detail?: unknown; error?: unknown },
  fallback: string
): string {
  if (item.detail !== undefined) return formatServerDetail(item.detail, fallback)
  if (item.error && typeof item.error === 'object' && !Array.isArray(item.error)) {
    const message = (item.error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

function isJSONContentType(value: string | null): boolean {
  if (!value) return false
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

function formatServerDetail(detail: unknown, fallback: string): string {
  const teamNetworkValidation = teamNetworkValidationMessage(detail)
  if (teamNetworkValidation) return teamNetworkValidation
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object') {
    const value = detail as { message?: unknown; action?: unknown }
    const message = typeof value.message === 'string' ? value.message.trim() : ''
    const action = typeof value.action === 'string' ? value.action.trim() : ''
    if (message || action) return [message, action].filter(Boolean).join(' ')
    try { return JSON.stringify(detail) } catch { return fallback }
  }
  return fallback
}
