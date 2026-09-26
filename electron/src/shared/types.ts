import type { LanguagePreference } from './i18n'
import type { SharedChatAttribution } from './chat-shares'
import type { SideQuestionsCapability } from './side-questions'
import type { MailHintProjection, TeamMailHintsCapability } from './team-mail-hints'
import type { TeamActivityHintsCapability } from './team-bulletin-hints'

export interface LanguageSettingsSnapshot {
  preference: LanguagePreference
  systemLocale: string
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type Backend = 'claude' | 'codex' | 'cursor' | 'opencode'
export type CodexProvider = 'default' | 'custom'
export type ChatSyncStatus = 'idle' | 'cached' | 'syncing' | 'live' | 'reconnecting' | 'offline' | 'error'
export type ServerConnectionState = 'online' | 'degraded' | 'connecting' | 'retrying' | 'offline' | 'cached'

export type CodexApprovalPolicy = 'never' | 'on-request' | 'untrusted'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'
export type CursorPermissionMode = 'default' | 'full_access' | 'plan'
export type OpenCodePermissionMode = 'default' | 'full_access' | 'plan'
export type CodexGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export type CodexThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput'
export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: CodexThreadActiveFlag[] }

export interface CodexGoal {
  threadId: string
  objective: string
  status: CodexGoalStatus
  tokenBudget?: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface CodexPermissionProfile {
  id: string
  allowed: boolean
  name?: string | null
  description?: string | null
  permissions?: JsonValue
  [key: string]: JsonValue | undefined
}

export interface CodexRuntimePolicy {
  approval_policy?: CodexApprovalPolicy | null
  sandbox_mode?: CodexSandboxMode | null
  permission_profile?: string | null
  approvals_reviewer?: CodexApprovalsReviewer | null
}

export interface ProviderPendingInteraction {
  id: string
  session_id: string
  thread_id?: string | null
  /** AgentsDock run that owns the request, emitted by newer servers. */
  run_id?: string | null
  turn_id?: string | null
  item_id?: string | null
  method: string
  params: Record<string, JsonValue>
  created_at: string
  auto_resolution_ms?: number | null
}

export interface CodexPendingInteraction extends ProviderPendingInteraction {
  thread_id: string
}

export interface ClaudePendingInteraction extends ProviderPendingInteraction {
  claude_session_id?: string | null
  tool_use_id?: string | null
}

export interface ClaudeRuntimePolicy {
  permission_mode?: ClaudePermissionMode | null
}

export interface ClaudeRuntimeFeatures {
  permission_mode_control?: boolean
  /** The server can ask the currently loaded Claude SDK client for a fresh sample. */
  context_usage_refresh?: boolean
  /** Native Claude Agent SDK MCP status and control endpoints are available. */
  mcp_management?: boolean
  /** Native Claude completion-condition goals, with authoritative provider state. */
  goals?: boolean
}

export interface ClaudeGoal {
  condition: string
  status: 'active' | 'achieved' | 'cleared' | 'failed'
  iterations?: number
  /** Native goal timestamp in milliseconds since the epoch. */
  set_at?: number
  tokens_at_start?: number
  last_reason?: string
  duration_ms?: number
  tokens?: number
}

export interface ClaudeRuntimeSnapshot {
  available: boolean
  transport: string
  interactive_capability: string | boolean | null
  persisted_session?: boolean
  session_loaded: boolean
  status?: CodexThreadStatus | null
  pending_interactions: ClaudePendingInteraction[]
  policy?: ClaudeRuntimePolicy | null
  /** Explicit feature gate; absent on older servers that cannot persist Claude modes. */
  features?: ClaudeRuntimeFeatures | null
  /** Authoritative modes supported by the running Claude Agent SDK. */
  permission_modes?: ClaudePermissionMode[]
  /** Authoritative per-chat Claude SDK context occupancy; absent on older servers and CLI fallback. */
  context_usage?: ClaudeTokenUsage | null
  /** Normalized context snapshot with provider-session and generation fencing. */
  context_usage_snapshot?: ClaudeTokenUsage | null
  context_usage_state?: 'available' | 'cleared' | 'unavailable' | null
  /** Monotonic generation for the authoritative context snapshot. */
  usage_generation?: number | null
  /** True when this response includes a newly sampled SDK context value. */
  context_usage_refreshed?: boolean
  /** Native Claude current/latest goal; absent on older servers. */
  goal?: ClaudeGoal | null
  /** Native command accepted; awaiting an authoritative goal status record. */
  goal_starting?: boolean
  /** The initial provider transcript goal projection is still loading. */
  goal_loading?: boolean
}

export type ClaudeTokenUsage = Record<string, JsonValue>

export type ClaudeMcpServerStatus =
  | 'connected'
  | 'pending'
  | 'failed'
  | 'needs-auth'
  | 'disabled'
  | 'unknown'

export interface ClaudeMcpServerInfo {
  name: string
  version: string
}

/**
 * Deliberately bounded MCP server summary. AgentsServer never includes MCP
 * commands, arguments, environment, headers, URLs, or tool metadata here.
 */
export interface ClaudeMcpServer {
  name: string
  status: ClaudeMcpServerStatus
  enabled: boolean
  error: string | null
  scope: 'user' | 'project' | 'local' | 'claudeai' | 'managed' | null
  server_info: ClaudeMcpServerInfo | null
  tool_count: number | null
}

export interface ClaudeMcpReason {
  code: string
  message: string
  retryable: boolean
}

export interface ClaudeMcpSnapshot {
  version: 1
  available: boolean
  transport: 'agent-sdk' | 'print'
  /** Opaque owner/runtime revision token. Clients compare or echo it only. */
  generation: string | null
  session_loaded: boolean
  servers: ClaudeMcpServer[]
  /** True when AgentsServer safely capped a larger configured-server list. */
  truncated: boolean
  reason: ClaudeMcpReason | null
  action: {
    type: ClaudeMcpControlAction
    server_name: string | null
  } | null
}

export type ClaudeMcpControlAction = 'reconnect' | 'reconnect_all' | 'enable' | 'disable'

interface ClaudeMcpControlBase {
  version: 1
  expected_generation: string
}

export interface ClaudeMcpServerControlInput extends ClaudeMcpControlBase {
  action: Exclude<ClaudeMcpControlAction, 'reconnect_all'>
  server_name: string
}

export interface ClaudeMcpReconnectAllInput extends ClaudeMcpControlBase {
  action: 'reconnect_all'
  server_name?: null
}

export type ClaudeMcpControlInput = ClaudeMcpServerControlInput | ClaudeMcpReconnectAllInput

export interface CodexBackgroundTerminal {
  itemId: string
  processId: string
  command: string
  cwd: string
  osPid?: number | null
  rssKb?: number | null
  cpuPercent?: number | null
  [key: string]: JsonValue | undefined
}

/**
 * Native app-server token usage is intentionally kept open-ended. Codex has
 * shipped both camelCase nested snapshots (`last` / `total`) and AgentsDock's
 * additive normalized snake_case fields; clients must accept either shape.
 */
export type CodexTokenUsage = Record<string, JsonValue>

export interface CodexRuntimeSnapshot {
  available: boolean
  transport: string
  interactive_capability: string | boolean | null
  thread_loaded: boolean
  /** Server-wide persisted-goals feature state; absent on older servers, where goals remain enabled. */
  goals_enabled?: boolean
  /** Additive server hint used when compact session summaries omit provider IDs. */
  persisted_thread?: boolean
  status: CodexThreadStatus | null
  goal: CodexGoal | null
  time_budget_seconds: number | null
  /** Additive server field; absent on pre-budget-exhaustion servers. */
  time_budget_exhausted?: boolean
  /** Live native app-server usage. Absent until Codex reports its first sample. */
  token_usage?: CodexTokenUsage | null
  /** Normalized live usage with run/turn attribution and context occupancy. */
  token_usage_snapshot?: CodexTokenUsage | null
  pending_interactions: CodexPendingInteraction[]
  permission_profiles: CodexPermissionProfile[]
  /** Effective per-chat permission policy reported by AgentsServer. */
  policy?: CodexRuntimePolicy | null
  background_terminals_supported: boolean | null
}

export interface CodexGoalInput {
  objective?: string | null
  status?: CodexGoalStatus | null
  token_budget?: number | null
  /** AgentsDock-owned wall-clock limit; Codex natively reports elapsed time only. */
  time_budget_seconds?: number | null
}

export interface CodexGoalSnapshot {
  goal: CodexGoal | null
  time_budget_seconds: number | null
  /** Additive server field; absent on pre-budget-exhaustion servers. */
  time_budget_exhausted?: boolean
}

/** Authoritative server-wide state for Codex's native persisted-goals feature. */
export interface CodexGoalsConfiguration {
  enabled: boolean
  configurable: boolean
  message: string
}

/** Server selection displayed by the caller, checked before sending an admin request. */
export type CodexServerSettingsScope = Pick<WorkspaceProfileScope, 'profileId' | 'profileGeneration'>

/** Native Codex account metadata only. Credentials never cross back to the renderer. */
export interface CodexAuthStatus {
  available: boolean
  auth_mode: 'apiKey' | 'chatgpt' | 'other' | 'none'
  email: string | null
  plan_type: string | null
  requires_openai_auth: boolean
}

/** Custom Responses provider; never contains stored credentials. */
export interface CodexProviderConfiguration {
  available: boolean
  configured: boolean
  base_url: string | null
  model: string | null
  has_api_key: boolean
  wire_api: 'responses'
  credential_id?: string
}

/** Transient input sent only to the selected server's native admin route. */
export interface CodexProviderInput {
  base_url: string
  model?: string
  api_key: string
}

export interface CodexProviderTestResult {
  ok: boolean
  status: 'ready' | 'unsupported' | 'unsupported_parameter' | 'inconclusive' | 'authentication_failed' | 'connection_failed' | 'model_unavailable' | 'failed'
  message: string
  model?: string
  compatibility?: 'unverified' | 'verified' | 'unsupported'
  scope?: 'isolated_native_tools_and_continuation'
  checks?: { native_tool_call: boolean; tool_roundtrip: boolean; continuation: boolean }
  reasoning_summary_supported?: boolean | null
  summary_check?: 'supported' | 'unsupported' | 'inconclusive' | 'not_checked'
}

export interface CodexProviderModelTestInput {
  model: string
  session_id?: string
  credential_id?: string
}

export interface RuntimeModelCapability {
  kind: 'chat' | 'unknown'
  compatibility: 'unverified' | 'verified' | 'unsupported'
  reasoning_efforts: string[]
  reasoning_supported: boolean | null
  reasoning_summary_supported?: boolean | null
}

export interface CodexProviderModels {
  models: RuntimeModelOption[]
  efforts: RuntimeOption[]
  model_efforts?: Record<string, RuntimeOption[]>
  model_capabilities?: Record<string, RuntimeModelCapability>
  default_model: string | null
  default_effort: string | null
}

/** Server override, not the provider's resolved or currently running limit. */
export interface CodexSubagentsConfiguration {
  configurable: boolean
  reason?: 'unsupported_transport' | null
  max_concurrent_threads_per_session: number | null
  message: string
  scope?: 'server'
  provider_config_key?: string
  applies_to?: 'new_or_reloaded_threads'
}

export type CodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string }

export interface CodexReviewInput {
  target: CodexReviewTarget
  delivery?: 'inline' | 'detached'
}

export interface CodexShellInput {
  command: string
  /** Required acknowledgement that thread/shellCommand is unsandboxed. */
  confirmed: boolean
}

export interface CodexOperationAccepted {
  accepted: boolean
  operation_id?: string | null
}

/**
 * A Stop request can be accepted before the provider reaches terminal state.
 * Keep this response structured so clients can distinguish a completed stop
 * from a retryable, still-pending interrupt.
 */
export interface TurnStopResult {
  ok?: boolean
  stopped: boolean
  pending?: boolean
  deferred?: boolean
  native_interrupt?: boolean
  goal_paused?: boolean
  message?: string | null
}

export interface CodexRollbackInput {
  num_turns: number
  /** Required acknowledgement that rollback only removes provider context. */
  confirmed: boolean
}

export interface CodexRollbackResult {
  accepted: boolean
  thread: Record<string, JsonValue>
}

export interface CodexBackgroundTerminalsSnapshot {
  supported: boolean
  terminals: CodexBackgroundTerminal[]
}

export interface CodexBackgroundTerminalTerminateInput {
  process_id: string
  /** Required acknowledgement that this background process will be stopped. */
  confirmed: boolean
}

export interface CodexBackgroundTerminalsCleanInput {
  /** Required acknowledgement that every running terminal in the thread will stop. */
  confirmed: boolean
}

export interface SessionSubagentLimitControl {
  supported: boolean
  /** Default fields may be omitted from compact session-list responses. */
  scope?: 'chat'
  mode?: 'native_concurrent'
  applies_to?: 'new_or_reloaded_threads' | 'next_idle_provider_start' | 'next_provider_process_start'
  reason?: string | null
  message?: string
}

export interface Session {
  id: string
  title: string
  folder?: string | null
  cwd?: string | null
  backend: Backend
  /** Missing on older sessions means native Codex's default provider. */
  codex_provider?: CodexProvider
  /** Safe catalog for this chat's retained endpoint credentials. */
  codex_provider_catalog?: RuntimeBackendCatalog['custom_provider']
  model?: string | null
  effort?: string | null
  system_prompt?: string | null
  subagent_limit?: number | null
  subagent_limit_control?: SessionSubagentLimitControl
  /** Durable server-side fence set when the first ordinary chat turn is admitted. */
  backend_locked?: boolean | null
  session_id?: string | null
  claude_session_id?: string | null
  codex_thread_id?: string | null
  codex_approval_policy?: CodexApprovalPolicy | null
  codex_sandbox_mode?: CodexSandboxMode | null
  codex_permission_profile?: string | null
  codex_approvals_reviewer?: CodexApprovalsReviewer | null
  codex_thread_status?: CodexThreadStatus | null
  codex_goal?: CodexGoal | null
  codex_goal_time_budget_seconds?: number | null
  codex_pending_interaction_count?: number | null
  codex_needs_user_action?: boolean | null
  claude_transport?: string | null
  claude_permission_mode?: ClaudePermissionMode | null
  cursor_session_id?: string | null
  cursor_permission_mode?: CursorPermissionMode | null
  opencode_session_id?: string | null
  opencode_permission_mode?: OpenCodePermissionMode | null
  /** Server-enforced scheduled-job access granted to this chat's agent. */
  provider_jobs_access?: ProviderJobsAccess | null
  claude_pending_interaction_count?: number | null
  claude_needs_user_action?: boolean | null
  parent_id?: string | null
  pinned?: boolean | null
  pinned_at?: string | null
  archived?: boolean | null
  archived_at?: string | null
  sort_order?: number | null
  created_at?: string | null
  updated_at?: string | null
  latest_event_seq?: number | null
  latest_event_at?: string | null
  latest_event_type?: string | null
  latest_agent_event_seq?: number | null
  latest_agent_event_at?: string | null
  latest_agent_event_type?: string | null
  last_read_agent_event_seq?: number | null
  last_read_agent_event_at?: string | null
  manual_unread?: boolean | null
  /** Durable, explicit agent emergency. Reading the chat never acknowledges it. */
  emergency_alert?: EmergencyAlert | null
  unacknowledged_emergency_count?: number | null
}

export interface EmergencyAlert {
  id: string
  status: 'active' | 'acknowledged'
  severity: 'critical'
  message: string
  raised_at: string
  source_run_id?: string | null
  acknowledged_at?: string | null
}

/** Result of replacing only this chat's provider process while preserving its transcript. */
export interface ProviderReloadResult {
  session: Session
  runtime?: CodexRuntimeSnapshot | ClaudeRuntimeSnapshot | null
  reloaded?: boolean
  message?: string | null
}

export interface RuntimeOption {
  value: string
  label: string
  /** True when the server can see this option but the account can't use it yet (e.g. a free-plan Cursor account and a named model). */
  locked?: boolean
  /** Human-readable reason to show alongside a locked option, e.g. "Requires a paid Cursor plan". */
  locked_reason?: string | null
}
export interface RuntimeModelOption extends RuntimeOption {
  efforts?: RuntimeOption[]
  service_tier?: string | null
}
export type RuntimeDiagnosticStatus = 'unknown' | 'ready' | 'missing' | 'unauthenticated' | 'error'
export interface RuntimeDiagnostic {
  backend: Backend
  status: RuntimeDiagnosticStatus
  available: boolean
  installed?: boolean | null
  authenticated?: boolean | null
  version?: string | null
  message: string
  action?: string | null
  checked_at?: string | null
  last_error?: string | null
  last_error_at?: string | null
}
export interface RuntimeBackendCatalog {
  /** Safe metadata only; credentials stay on the server. */
  custom_provider?: {
    configured: boolean
    available: boolean
    model: string | null
    base_url: string | null
    models?: RuntimeModelOption[]
    efforts?: RuntimeOption[]
    model_efforts?: Record<string, RuntimeOption[]>
    model_capabilities?: Record<string, RuntimeModelCapability>
    default_model?: string | null
    default_effort?: string | null
  }
  /** Explicit backend availability; required before optional backends are selectable. */
  available?: boolean
  models: RuntimeModelOption[]
  efforts: RuntimeOption[]
  model_efforts?: Record<string, RuntimeOption[]>
  model_capabilities?: Record<string, RuntimeModelCapability>
  model_source?: string | null
  effort_source?: string | null
  default_model?: string | null
  default_effort?: string | null
  diagnostic?: RuntimeDiagnostic | null
  permission_modes?: OpenCodePermissionMode[]
  default_permission_mode?: OpenCodePermissionMode
}
export interface RuntimeCatalog {
  backends: Record<string, RuntimeBackendCatalog>
  generated_at?: string | null
}

export interface AgentFile {
  id: string
  session_id?: string | null
  filename: string
  path?: string | null
  source_path?: string | null
  content_type?: string | null
  size?: number | null
  created_at?: string | null
  title?: string | null
  text?: string | null
  source?: string | null
  event_id?: string | null
  seq?: number | null
}

export interface AgentTextFile {
  id: string
  filename: string
  content: string
  content_type?: string | null
  size: number
  preview_size?: number
  truncated?: boolean
  revision: string
}

export interface ToolCall {
  id?: string
  name: string
  input?: JsonValue
}

export interface QueuePosition { queued_id: string; position: number }

export interface ProviderCommandSelection {
  /** Opaque AgentsServer-owned identifier. The client must never send a filesystem path. */
  id: string
  /** Inventory revision used by AgentsServer to reject stale selections. */
  revision: string
}

export interface ProviderCommand {
  /** Opaque AgentsServer-owned identifier. */
  id: string
  name: string
  label: string
  description: string
  scope?: string | null
  source?: string | null
  kind: string
  /** Provider-approved visible slash token, for example `/pdf` or `/plugin:skill`. */
  invocation: string
}

export interface ProviderCommandSupport {
  available: boolean
  mode: string
  reason?: string | null
}

export interface ProviderCommandsSnapshot {
  backend: Backend
  revision: string
  support: ProviderCommandSupport
  commands: ProviderCommand[]
}

export interface QueuedTurn extends SharedChatAttribution {
  queued_id: string
  session_id?: string | null
  prompt: string
  file_ids: string[]
  backend?: Backend | null
  model?: string | null
  effort?: string | null
  display_prompt?: string | null
  purpose?: string | null
  digest_job_id?: string | null
  /** Exact scheduled occurrence owned by this queue row, not the whole schedule. */
  job_id?: string | null
  job_title?: string | null
  job_scheduled_run_at?: number | null
  source_session_id?: string | null
  target_session_id?: string | null
  chat_references?: ChatReference[] | null
  team_references?: TeamReference[] | null
  /** Opaque, revision-bound local provider command selected for this turn. */
  skill_selection?: ProviderCommandSelection | null
  /** Durable identity for a queued same-server delivery. */
  cross_chat_envelope_id?: string | null
  cross_chat_exchange_id?: string | null
  cross_chat_exchange_leg_id?: string | null
  cross_chat_exchange_status?: boolean | null
  /** Explicit asynchronous message/reply protocol; absent for legacy deliveries. */
  conversation_mode?: 'async_route_v1' | null
  source_title?: string | null
  /** Public recipient-side body; never the provider delivery wrapper. */
  message_body?: string | null
  message_edited_by_user?: boolean | null
  /** Compare-and-swap version for editing an async queued message. */
  message_revision?: number | null
  /** Durable identity for a queued encrypted peer delivery. */
  secure_peer_envelope_id?: string | null
  position?: number | null
  created_at?: string | null
  /** The server is deliberately holding this turn until an explicit Send now. */
  paused?: boolean | null
  pause_reason?: 'stopped' | 'delivery_uncertain' | null
  /** The server has reserved this row for provider handoff; it is no longer mutable queue work. */
  promoted?: boolean | null
}

/** Exact durable owner expected when skipping a queued cross-chat delivery. */
export interface QueuedCrossChatDeliveryIdentity {
  cross_chat_envelope_id?: string | null
  cross_chat_exchange_id?: string | null
  cross_chat_exchange_leg_id?: string | null
  secure_peer_envelope_id?: string | null
}

export type ChatReferenceAction =
  | 'direct_message'
  | 'route'
  | 'request_reply'
  | 'instruction'
  | 'final_result'

/**
 * An authority-bearing chat reference selected in the composer. JavaScript
 * string offsets are UTF-16 code-unit offsets, matching textarea selection
 * indices and the server contract.
 */
export interface ChatReference {
  session_id: string
  display_title_snapshot: string
  source_text_start: number
  source_text_end: number
  action: ChatReferenceAction
  /** Present only on a newly authored local v7 @Chat pending grant. */
  grant_intent?: true
  /** Optional durable action ceiling for a saved scheduled route hint. */
  route_action?: AgentCrossChatRouteAction
  /** Absent for existing same-server chat references. */
  target_kind?: 'secure_peer'
  target_server_identity?: string
  target_connection_id?: string
  target_route_id?: string
  target_route_revision?: string
}

interface TeamReferenceBase {
  team_id: string
  target_id: string
  display_name_snapshot: string
  source_text_start: number
  source_text_end: number
  grant_intent: true
}

export interface TeamRecipientReference extends TeamReferenceBase {
  kind: 'recipient'
  recipient_kind: 'server' | 'human' | 'all' | 'all_servers'
}

export interface TeamSkillReference extends TeamReferenceBase {
  kind: 'skill'
  recipient_kind?: never
}

/** Authority-bearing @@ reference selected in the composer. Offsets are UTF-16. */
export type TeamReference = TeamRecipientReference | TeamSkillReference

export type AgentCrossChatRouteAction = 'instruction' | 'request_reply'

export type AgentCrossChatRouteUnavailableReason =
  | 'source_archived'
  | 'target_missing'
  | 'target_deleting'
  | 'target_archived'
  | 'unsupported_backend'
  | 'unsupported_transport'

export interface AgentCrossChatRouteTarget {
  title: string | null
  folder: string | null
  backend: Backend | null
  available: boolean
  unavailable_reason: AgentCrossChatRouteUnavailableReason | null
}

/** Administrator projection for one durable source-chat to target-chat grant. */
export interface AgentCrossChatRoute {
  route_id: string
  /** Opaque mutation revision. Clients display neither this nor the route ID. */
  revision: string
  alias: string
  target_session_id: string
  actions: AgentCrossChatRouteAction[]
  created_at: string
  updated_at: string
  target: AgentCrossChatRouteTarget
}

export interface AgentCrossChatRoutesSnapshot {
  routes: AgentCrossChatRoute[]
  /** Null means no stored-route limit; older servers retain their numeric hint. */
  max_routes: number | null
}

export interface AgentTeamMailRoute {
  route_id: string
  revision: string
  display_name: string
  recipient_kind: 'server'
  team_id: string
  target_id: string
  available: boolean
  unavailable_reason: 'target_unavailable' | 'source_archived' | 'team_unavailable' | null
  created_at: string
  updated_at: string
}

export interface AgentTeamMailRoutesSnapshot {
  routes: AgentTeamMailRoute[]
  max_routes: number
}

export interface CreateAgentCrossChatRouteInput {
  alias: string
  target_session_id: string
  actions?: AgentCrossChatRouteAction[]
}

export interface UpdateAgentCrossChatRouteInput {
  expected_revision: string
  alias?: string
  actions?: AgentCrossChatRouteAction[]
}

export type AgentCrossChatRouteUpdateResult =
  | { status: 'updated'; route: AgentCrossChatRoute }
  | { status: 'revision_conflict' }

export interface DeleteAgentCrossChatRouteResponse {
  ok: true
  deleted: boolean
  route_id: string
}

export type DeleteAgentCrossChatRouteResult =
  | ({ status: 'deleted' } & Omit<DeleteAgentCrossChatRouteResponse, 'ok'>)
  | { status: 'revision_conflict' }

export interface ChatSearchTarget {
  id: string
  title: string
  folder: string | null
  backend: Backend
  cross_chat_handoff_supported: boolean
  updated_at?: string | null
}

export interface ChatSearchSnapshot {
  chats: ChatSearchTarget[]
  query: string
  limit: number
  truncated: boolean
  server_identity: string
}

export type ChatInboxState = 'unread' | 'read' | 'cancelled' | 'deleted'

export interface ChatInboxMessage {
  message_id: string
  conversation_id: string
  conversation_mode: 'async_route_v1'
  delivery_mode: 'mailbox'
  source_session_id: string
  source_title: string
  target_session_id: string
  state: ChatInboxState
  created_at: string
  received_at: string | null
  read_at: string | null
  reply_to_message_id: string | null
  body: string
  body_chars: number
  body_sha256: string
  message_revision: number
}

export interface ChatInboxPage {
  session_id: string
  messages: ChatInboxMessage[]
  next_cursor: string | null
  has_more: boolean
  senders: Array<{ source_session_id: string; source_title: string; unread_count: number }>
}

export interface ChatInboxDeleteReceipt {
  ok: true
  session_id: string
  message_id: string
  state: 'deleted'
}

export interface CrossChatHandoffSummary {
  id: string
  kind: ChatReferenceAction
  source_session_id: string
  source_run_id: string
  target_session_id: string
  action: ChatReferenceAction
  conversation_mode?: 'async_route_v1' | null
  delivery_mode?: 'mailbox' | null
  inbox_state?: ChatInboxState | null
  conversation_id?: string | null
  message_id?: string | null
  status: string
  queued_id?: string | null
  target_run_id?: string | null
  error?: string | null
  created_at: string
  updated_at: string
}

export interface CrossChatHandoff extends CrossChatHandoffSummary {
  body: string
  body_chars: number
  body_sha256: string
  /** Recipient-effective text; body above always remains the sender's original. */
  target_body?: string | null
  message_edited_by_user?: boolean | null
  message_revision?: number | null
}

export type CrossChatExchangeStatus = 'waiting_request' | 'active' | 'completed' | 'failed' | 'cancelled' | 'expired'
export type CrossChatLegKind = 'request' | 'reply' | 'status'
export type CrossChatLegStatus = 'registered' | 'submitting' | 'queued' | 'running' | 'delivered' | 'failed' | 'cancelled' | 'expired'
export type CrossChatResponseState = 'open' | 'explicit_committed' | 'automatic_committed' | 'closed'

export interface CrossChatExchangeLeg {
  id: string
  exchange_id: string
  parent_leg_id: string | null
  ordinal: number
  kind: CrossChatLegKind
  expects_reply: boolean
  response_state: CrossChatResponseState
  status: CrossChatLegStatus
  source_session_id: string
  source_run_id: string
  target_session_id: string
  target_run_id: string | null
  queued_id: string | null
  body: string
  body_chars: number
  body_sha256: string
  error_code: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface CrossChatExchange {
  id: string
  status: CrossChatExchangeStatus
  /**
   * The user-visible meaning of the first leg. Instruction exchanges reuse
   * the request/reply leg machinery while keeping Send distinct from Ask.
   */
  initial_action?: AgentCrossChatRouteAction | null
  requester_session_id: string
  responder_session_id: string
  authorization_source_run_id: string
  max_legs: number
  used_legs: number
  remaining_legs: number
  active_leg_id: string | null
  error_code: string | null
  error: string | null
  expires_at: string
  created_at: string
  updated_at: string
  legs: CrossChatExchangeLeg[]
}

export interface QueuedRunNowResponse {
  ok: boolean
  queued_id?: string | null
  interrupted?: boolean
  deferred?: boolean
  retryable?: boolean
  delivery_uncertain?: boolean
  native_steer?: boolean
  replays_interrupted_message?: boolean
  message?: string | null
  remaining?: number | null
  superseded_queued_ids?: string[]
}

export interface CodeDiffFileSummary {
  path: string
  additions?: number | null
  deletions?: number | null
  binary?: boolean | null
}

/** Source identity for a server-verified synthetic provider interruption record. */
export interface ProviderInterruptionOrigin {
  provider: 'claude'
  kind: 'interruption'
  event_id: string
  session_id: string
  timestamp: string
  cause: 'steer' | 'stop' | 'unknown'
  parent_event_id?: string | null
  prompt_id?: string | null
}

export interface ProviderHistoryOrigin {
  provider: 'claude' | 'codex'
  kind?: 'assistant' | 'user' | 'subagent_notification' | 'turn_aborted' | 'provider_notice'
  event_id?: string
  session_id?: string
  timestamp?: string
  parent_event_id?: string | null
  prompt_id?: string | null
  turn_id?: string
  native_event_id?: string
  source_text_sha256?: string
  cause?: never
}

export interface Event extends SharedChatAttribution {
  seq: number
  id: string
  session_id: string
  type: string
  ts: string
  run_id?: string | null
  queued_id?: string | null
  queued_ids?: string[] | null
  promoted?: boolean | null
  superseded_queued_ids?: string[] | null
  superseded_by_queued_id?: string | null
  position?: number | null
  purpose?: string | null
  /** Exact server-authored quiet mailbox wake; its provider input is not user text. */
  mailbox_wake_id?: string | null
  mailbox_wake_through_seq?: number | null
  provider_generated?: boolean | null
  provider_input_sha256?: string | null
  phase?: string | null
  /** Durable summary placement at its first streamed section, without changing its ledger sequence. */
  reasoning_after_seq?: number
  /** Provider-supplied reasoning retained when its native item ended without authoritative completion. */
  partial?: boolean
  /** Provider message identity when supplied by native output or history. */
  provider_message_id?: string | null
  /** True only for transcript records recovered by AgentsServer history import. */
  imported?: boolean | null
  /** Provider control metadata; meaningful only with the exact provider import contract. */
  metadata_only?: boolean | null
  /** Server-verified Codex runtime context recovered from imported history. */
  provider_runtime_context?: 'goal' | 'subagent_notification' | 'turn_aborted' | 'provider_notice' | null
  /** Server-proven, in-place repair of an imported provider record. */
  provider_history_repair?: 'source_proven_import' | 'source_proven_assistant_replay' | 'source_proven_native_replay' | null
  /** Positive provider evidence that an imported input was authored by the user. */
  provider_user_authored?: boolean | null
  /** Additive provenance; only the exact imported lifecycle contract is control metadata. */
  provider_origin?: ProviderInterruptionOrigin | ProviderHistoryOrigin | null
  digest_job_id?: string | null
  source_session_id?: string | null
  target_session_id?: string | null
  chat_references?: ChatReference[] | null
  team_references?: TeamReference[] | null
  handoff_id?: string | null
  cross_chat_envelope_id?: string | null
  /** Durable identity for a queued encrypted peer delivery. */
  secure_peer_envelope_id?: string | null
  watch_id?: string | null
  correlation_id?: string | null
  handoff_status?: string | null
  delivery_mode?: 'mailbox' | null
  inbox_state?: ChatInboxState | null
  received_at?: string | null
  read_at?: string | null
  reply_to_message_id?: string | null
  handoff_action?: ChatReferenceAction | null
  source_title?: string | null
  target_title?: string | null
  handoff_preview?: string | null
  handoff_body_chars?: number | null
  handoff_body_sha256?: string | null
  /** Recipient-side queued edit; the sender's original envelope remains unchanged. */
  message_body?: string | null
  message_edited_by_user?: boolean | null
  message_revision?: number | null
  /** Native delivery run recorded by a legacy exchange-leg receipt. */
  target_run_id?: string | null
  handoff_body_truncated?: boolean | null
  handoff_authorization_kind?: 'explicit_prompt' | 'configured_route' | null
  handoff_authorization_route_id?: string | null
  exchange_id?: string | null
  exchange_leg_id?: string | null
  /** Internal provider-turn aliases emitted by AgentsServer delivery runs. */
  cross_chat_exchange_id?: string | null
  cross_chat_exchange_leg_id?: string | null
  cross_chat_exchange_status?: boolean | null
  exchange_status?: CrossChatExchangeStatus | null
  exchange_leg_status?: CrossChatLegStatus | null
  exchange_leg_kind?: CrossChatLegKind | null
  conversation_mode?: 'async_route_v1' | null
  conversation_id?: string | null
  /** User-visible meaning of the exchange's first leg. */
  exchange_initial_action?: AgentCrossChatRouteAction | null
  exchange_direction?: 'incoming' | 'outgoing' | null
  exchange_expects_reply?: boolean | null
  exchange_ordinal?: number | null
  exchange_max_legs?: number | null
  exchange_used_legs?: number | null
  exchange_remaining_legs?: number | null
  exchange_expires_at?: string | null
  exchange_error_code?: string | null
  exchange_authorization_kind?: 'explicit_prompt' | 'configured_route' | null
  exchange_authorization_route_id?: string | null
  requester_session_id?: string | null
  responder_session_id?: string | null
  requester_title?: string | null
  responder_title?: string | null
  digest?: string | null
  backend?: Backend | null
  prompt?: string | null
  file_ids?: string[] | null
  text?: string | null
  result_text?: string | null
  message?: string | null
  /** `team_message_sent` payload fields. */
  team_id?: string
  destination?: 'all_servers'
  message_id?: string | null
  kind?: string | null
  title?: string | null
  recipients?: Array<{ kind: 'server' | 'human' | 'all'; display_name: string }> | null
  attachments?: number | null
  skill_slug?: string | null
  skill_version?: number | null
  emergency_alert?: EmergencyAlert | null
  emergency_alert_id?: string | null
  unacknowledged_emergency_count?: number | null
  error?: JsonValue
  output?: string | null
  output_chars?: number | null
  output_truncated?: boolean | null
  raw?: string | null
  argv?: string[] | null
  exit_code?: number | null
  stopped?: boolean | null
  is_error?: boolean | null
  provider_session_id?: string | null
  previous_provider_session_id?: string | null
  /** Codex thread identity on native turn lifecycle events. */
  provider_thread_id?: string | null
  tool_id?: string | null
  tool?: ToolCall | null
  subagent_id?: string | null
  subagent_tool_id?: string | null
  subagent_name?: string | null
  subagent_title?: string | null
  subagent_nickname?: string | null
  subagent_path?: string | null
  subagent_task?: string | null
  subagent_kind?: string | null
  subagent_status?: string | null
  subagent_activity?: string | null
  subagent_summary?: string | null
  subagent_started_at?: string | null
  subagent_provider_ref?: string | null
  subagent_log?: Array<{ ts: string; text: string }> | null
  file?: AgentFile | null
  artifact?: AgentFile | null
  job?: Job | null
  job_id?: string | null
  job_title?: string | null
  /** Stable scheduler attempt identity; preferred over provider run IDs, which may be recycled. */
  job_occurrence_id?: string | null
  /** Canonical scheduled instant for this firing, in Unix seconds. */
  job_scheduled_run_at?: number | null
  /** ISO fallback for servers/providers that cannot expose Unix seconds. */
  job_scheduled_run_at_iso?: string | null
  job_run_count?: number | null
  job_event_count?: number | null
  job_start_seq?: number | null
  job_end_seq?: number | null
  /** Stable contiguous timeline segment for this scheduled-job event. */
  job_timeline_group_id?: string | null
  job_history_truncated?: boolean | null
  /** Authoritative latest scheduler/provider state, independent of displayed output. */
  job_status?: string | null
  /** Run whose lifecycle produced `job_status`; absent for runless deferrals/errors. */
  job_status_run_id?: string | null
  job_status_seq?: number | null
  job_status_type?: string | null
  /** Additive server detail fields retained for compatibility with beta servers. */
  job_latest_run_id?: string | null
  job_latest_status?: string | null
  job_latest_status_run_id?: string | null
  job_latest_status_seq?: number | null
  job_latest_status_type?: string | null
  /** Status fields returned for one entry in scheduled-job run history. */
  job_run_status?: string | null
  job_run_status_seq?: number | null
  job_run_status_type?: string | null
  direction?: string | null
  positions?: QueuePosition[] | null
  diff_files?: CodeDiffFileSummary[] | null
  files_changed?: number | null
  additions?: number | null
  deletions?: number | null
  byte_count?: number | null
  repository_root?: string | null
  interaction?: CodexPendingInteraction | null
  interaction_id?: string | null
  request_method?: string | null
  resolution?: string | null
  /** Server-assigned bounded request-history chunk returned by semantic paging. */
  provider_interaction_audit_key?: string | null
  /** Stable identity shared by Codex context-compaction start/completion events. */
  compaction_id?: string | null
  operation_id?: string | null
  turn_id?: string | null
  /** Exact native provider turn that accepted an in-flight user message. */
  provider_turn_id?: string | null
  item_id?: string | null
  status?: JsonValue
  native_steer?: boolean | null
  /** Accepted user input on the existing native goal owner; not a new turn or Stop. */
  native_goal_steer?: boolean | null
  superseded_by_run_id?: string | null
  steer_interrupted_run_id?: string | null
  codex_thread_status?: CodexThreadStatus | null
  goal?: CodexGoal | null
  codex_goal?: CodexGoal | null
  /** Durable normalized/native Codex context usage; additive for old servers. */
  token_usage?: CodexTokenUsage | null
  token_usage_before?: CodexTokenUsage | null
  token_usage_after?: CodexTokenUsage | null
  thread_id?: string | null
  snapshot_at?: string | null
  input_tokens?: number | null
  cached_input_tokens?: number | null
  cache_write_input_tokens?: number | null
  output_tokens?: number | null
  reasoning_output_tokens?: number | null
  total_tokens?: number | null
  cumulative_total_tokens?: number | null
  context_window?: number | null
  context_tokens?: number | null
  context_percent?: number | null
}

export type JobScheduleKind = 'interval' | 'cron' | 'rrule'
export type JobContextMode = 'chat' | 'standalone'

export interface Job {
  id: string
  session_id: string
  title: string
  prompt: string
  /** Durable, explicit same-server chat targets selected for each scheduled run. */
  chat_references?: ChatReference[]
  /** Durable, explicit Team Network recipients or skills selected for each scheduled run. */
  team_references?: TeamReference[]
  interval_seconds: number | null
  schedule_kind?: JobScheduleKind | null
  cron_expression?: string | null
  rrule?: string | null
  timezone?: string | null
  next_run_at?: number | null
  next_run_at_iso?: string | null
  scheduled_run_at?: number | null
  scheduled_run_at_iso?: string | null
  first_run_at?: string | null
  last_run_at?: string | null
  last_run_started_at?: string | null
  loop?: boolean | null
  enabled?: boolean | null
  /** True while a user-requested Run once is waiting for admission. */
  manual_run_pending?: boolean | null
  /** Missing on older servers/jobs; clients must treat an absent value as `chat`. */
  context_mode?: JobContextMode | null
  backend?: Backend | null
  model?: string | null
  effort?: string | null
  run_count?: number | null
  max_runs?: number | null
  created_at?: string | null
  updated_at?: string | null
}

export interface JobRunNowResult {
  ok: boolean
  job_id: string
  job?: Job
  run_id?: string | null
  queued: boolean
  deferred: boolean
  manual_run_pending: boolean
  message?: string | null
}

export interface ProcessLogHint {
  id?: string
  label?: string | null
  path: string
  kind?: string | null
}
export interface AgentProcess {
  pid: number
  ppid?: number | null
  command: string
  cwd?: string | null
  started_at?: string | null
  elapsed_seconds?: number | null
  cpu_percent?: number | null
  mem_percent?: number | null
  rss_kb?: number | null
  stat?: string | null
  args?: string | null
  depth?: number | null
  log_hints?: ProcessLogHint[] | null
}
export interface ProcessSnapshot {
  processes: AgentProcess[]
  active?: boolean
  run_id?: string | null
  backend?: Backend | null
  stdout_tail?: { text?: string | null; total_lines?: number | null; truncated?: boolean | null; updated_at?: string | null }
  generated_at?: string | null
  loaded_at?: string | null
}

export interface TmuxPane {
  pane_id: string
  session_name?: string | null
  window_name?: string | null
  pane_index?: number | null
  pid?: number | null
  pane_pid?: number | null
  command?: string | null
  current_path?: string | null
  cwd?: string | null
  active?: boolean | null
  dead?: boolean | null
  linked?: boolean | null
  tags?: string[] | null
}

export type TerminalConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

export interface TerminalConnectOptions {
  cwd?: string | null
  columns: number
  rows: number
}

export interface TerminalStateEvent {
  sessionId: string
  state: TerminalConnectionState
  name?: string | null
  error?: string | null
  profileId?: string
  profileGeneration?: number
}

export type TerminalAction = 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'select-window' | 'kill-window' | 'kill-pane' | 'toggle-mouse'

export interface TerminalWindow {
  id: string
  index: number
  name: string
  active: boolean
  panes: number
}

export interface TerminalWindowsSnapshot {
  session_id: string
  name: string
  exists: boolean
  mouse_enabled?: boolean
  windows: TerminalWindow[]
}

export type ForwardedPortState = 'starting' | 'open' | 'error'

/** A loopback-only desktop listener visible across its active profile and owned by one origin chat lifecycle. */
export interface ForwardedPort {
  sessionId: string
  remotePort: number
  localPort: number
  localUrl: string
  state: ForwardedPortState
  error: string | null
}

export interface ServerCapability {
  available: boolean
  required: boolean
  message: string
  action: string | null
}

export interface WorkspaceFilesCapability extends ServerCapability {
  version?: number
  max_text_file_bytes?: number
}

export interface PortForwardingCapability extends ServerCapability {
  version?: number
  websocket_path_template?: string
  websocket_protocol?: string
  transport?: string
  destination_host?: string
  minimum_port?: number
  maximum_port?: number
  max_active_connections?: number
  max_active_connections_per_session?: number
  max_client_frame_bytes?: number
}

export interface WorkingDirectoryCompletionCapability extends ServerCapability {
  version?: number
  max_results?: number
}

export interface ScheduledJobsCapability extends ServerCapability {
  version?: number
  context_modes?: JobContextMode[]
  features?: {
    chat_references?: boolean
    direct_message_mentions?: boolean
    route_mentions?: boolean
    route_hint_mentions?: boolean
    [key: string]: JsonValue | undefined
  }
}

export interface InteractiveProviderCapability extends ServerCapability {
  version?: number
  interactive_capability?: string | null
  interactive_client_capability?: string | null
  features?: Record<string, JsonValue>
  permission_modes?: ClaudePermissionMode[]
  fallback_transport?: string | null
}

export interface CursorBackendCapability extends ServerCapability {
  version: 2
  permission_modes?: CursorPermissionMode[]
}

export interface OpenCodeBackendCapability extends ServerCapability {
  version: 1
  permission_modes?: OpenCodePermissionMode[]
}

export interface AgentTeamMailCapability extends ServerCapability {
  version: 1
  explicit_command?: '/mail'
  command_syntax?: '/mail server <name> <message>'
  max_sends_per_run?: number
  max_body_bytes?: number
  features?: {
    deterministic_server_message_command?: boolean
    [key: string]: JsonValue | undefined
  }
}

export interface AgentTeamMessagesCapability {
  available: boolean
  /** Optional generic status metadata used by older AgentsServer capability rows. */
  required?: boolean
  message?: string
  action?: string | null
  version: 1
  helper: 'team'
  mention_sigil: '@@'
  read_always: true
  send_requires_mention: true
  recipient_kinds: ['server', 'human', 'all']
  reference_kinds: ['recipient', 'skill']
  max_sends_per_run: number
  max_attachments_per_send: number
  max_body_bytes: number
}

/** AgentsServer advertises the canonical team-wide mention independently of Team Hub. */
export interface TeamBulletinAliasCapability {
  available: boolean
  required?: boolean
  version: 1
  mention: '@@bulletin'
  legacy_mention: '@@all'
}

/** Explicit server-inbox fanout; never reinterpret historical Bulletin aliases. */
export interface TeamAllServersAliasCapability {
  available: boolean
  version: 1
  mention: '@@all'
  recipient_kind: 'all_servers'
  max_recipients_per_message: number
}

export interface CrossChatHandoffsCapability extends ServerCapability {
  version?: number
  actions?: ChatReferenceAction[]
  default_action?: ChatReferenceAction
  supported_target_backends?: Backend[]
  required_target_transports?: Partial<Record<Backend, string>>
  default_exchange_legs?: number
  max_exchange_legs?: number
  default_exchange_ttl_seconds?: number
  features?: {
    direct_message_mentions?: boolean
    route_mentions?: boolean
    route_hint_mentions?: boolean
    durable_route_grants?: boolean
    agent_cross_chat_routes?: boolean
    agent_ambient_local_handoffs?: boolean
    exact_queued_delivery_skip?: boolean
    exact_queued_delivery_reorder?: boolean
    async_queued_message_controls?: boolean
    chat_mailbox_v1?: boolean
    exact_queued_peer_delivery_skip?: boolean
    secure_peer_fifo_barriers?: boolean
    async_route_v1?: boolean
    [key: string]: JsonValue | undefined
  }
  agent_routes?: {
    chat_mailbox_v1?: { available?: boolean }
    async_route_v1?: {
      available?: boolean
      client_capability?: string
      mode?: 'async_route_v1'
      max_handoffs_per_run?: number | null
      rate_limit_per_source?: number | null
      rate_limit_per_target?: number | null
    }
    client_capability?: string
    policy?: 'default_deny'
    max_routes_per_chat?: number | null
    max_handoffs_per_run?: number
    actions?: AgentCrossChatRouteAction[]
    default_actions?: AgentCrossChatRouteAction[]
    max_body_chars?: number
    max_body_bytes?: number
    request_reply_max_legs?: number
    instruction_reply_once?: boolean
    instruction_reply_policy?: 'exchange_scoped_terminal_once'
    request_reply_ttl_seconds?: number
    transcript_access?: boolean
  }
  ambient_local_handoffs?: {
    enabled?: boolean
    policy?: 'automatic'
    scope?: 'all_same_server_chats'
    setup_required?: boolean
    max_handoffs_per_run?: number
    actions?: AgentCrossChatRouteAction[]
    max_body_chars?: number
    max_body_bytes?: number
    request_reply_max_legs?: number
    request_reply_ttl_seconds?: number
    rate_window_seconds?: number | null
    rate_limit_per_source?: number | null
    rate_limit_per_target?: number | null
    transcript_access?: boolean
  }
}

export type ProviderJobsAccess = 'full' | 'read_only' | 'blocked'

export interface ProviderJobsAccessControlCapability extends ServerCapability {
  version?: number
  modes?: ProviderJobsAccess[]
  default?: ProviderJobsAccess
}

export interface ServerRestartCapability extends ServerCapability {
  version?: number
  force_restart?: boolean
  force_confirmation_required?: boolean
  blocker_snapshot?: ServerRestartBlockerSnapshot
}

export interface LocalSessionImportCapability extends ServerCapability {
  version: 1
  max_batch_items: number
  max_list_items: number
}

export interface ServerRestartWorkCounts {
  active_count: number
  restart_blocking_queued_count: number
  provider_background_count: number
  tmux_server_in_service_cgroup: boolean
  tmux_server_cgroup_unknown: boolean
  server_maintenance_count: number
  mutation_count: number
  deleting_session_count: number
  codex_goals_reconfiguring: boolean
}

export interface ServerRestartBlockerSnapshot extends ServerRestartWorkCounts {
  version: 2
  revision: string
  has_forceable_blockers: boolean
  has_safety_blockers: boolean
  has_blockers: boolean
  /**
   * AgentsServer 0.1.26-beta.30+: a forced restart overrides every blocker in
   * this snapshot, including safety blockers. Older servers omit the field.
   */
  force_restart_available?: boolean
  /** Set when the server could not take an admission lock in time; counts are best-effort. */
  snapshot_degraded?: boolean
}

/** Renderer-to-main confirmation. Main still derives the canonical identity and UUID. */
export interface ServerForceRestartConfirmation {
  force: true
  forceConfirmed: true
  /**
   * Revision of the blocker snapshot the user reviewed. Optional: a wedged
   * server may be unable to serve a fresh snapshot, and beta.30+ accepts a
   * forced restart without one (it audits the omission instead).
   */
  expectedBlockerRevision?: string | null
  /**
   * Exact pending managed-update reservation to atomically preserve and arm.
   * AgentsServer update capability v11+ validates this inside restart admission.
   */
  expectedUpdateScheduleId?: string | null
}

export interface TeamHubV1CapabilityRoute {
  transport: 'loopback' | 'tailscale_serve' | 'direct_ip' | 'secure_peer'
  hub_url: string | null
  base_path?: string
  connection_id?: string
  host_server_identity?: string
  hub_id?: string
}

export interface TeamHubV1Capability {
  available: boolean
  designated_host: boolean
  version: 1
  base_path: string | null
  /** Optional authenticated AgentsServer proxy for a server-scoped Teamspace session. */
  server_session_base_path?: string | null
  /** Missing only on the loopback-only beta.2 capability. */
  transport?: 'loopback' | 'tailscale_serve' | 'direct_ip' | 'secure_peer' | null
  /** Exact Serve or Direct IP URL for remote transports; absent on beta.2. */
  hub_url?: string | null
  /** Exact primary-first route set; absent on releases before multi-route discovery. */
  routes?: TeamHubV1CapabilityRoute[]
  hub_id: string | null
  host_server_identity: string | null
  message: string
  action: string | null
}

/** Authenticated live control for making the selected AgentsServer the Team Network host. */
export interface TeamHubHostControlCapability {
  available: boolean
  version: 1
  enabled: boolean
  can_enable: boolean
  can_disable: boolean
  server_bootstrap?: boolean
  rename_existing_host?: boolean
  status_path: '/api/admin/team-hub/host'
  enable_path: '/api/admin/team-hub/host/enable'
  disable_path: '/api/admin/team-hub/host/disable'
  message: string
  action: string | null
}

export interface AgentEmergencyAlertsCapability extends ServerCapability {
  version: 1
  max_message_chars: number
  max_requests_per_run: number
  max_active_alerts: number
  stream_path: string
  stream_protocol?: string
}

export interface PinnedItemsCapability extends ServerCapability {
  version: 1
  max_items_per_session: number
}

export type ServerRestartPhase = 'idle' | 'accepted' | 'signaling' | 'complete' | 'failed'

export interface ServerRestartRequest {
  request_id: string
  expected_server_identity: string
  expected_server_instance_id: string
  confirmed: true
  force?: true
  force_confirmed?: true
  expected_blocker_revision?: string
  expected_update_schedule_id?: string
}

export interface ServerRestartStatus {
  phase: ServerRestartPhase
  request_id?: string | null
  current_version?: string | null
  server_identity?: string | null
  server_instance_id?: string | null
  message: string
  requested_at?: string | null
  updated_at?: string | null
  completed_at?: string | null
  failed_at?: string | null
  forced?: boolean
  /** Present when restart atomically preserved and armed this update reservation. */
  update_schedule_id?: string | null
  blocker_snapshot?: ServerRestartBlockerSnapshot
  interrupted_work?: ServerRestartWorkCounts
  /** beta.30+: which refusals a forced restart overrode (boolean flags plus optional detail strings). */
  forced_audit?: Record<string, JsonValue | undefined>
}

export interface SessionForkCompletedPrefixCapability {
  available: boolean
  version: number
  supported_backends: Backend[]
}

export interface HealthCapabilities {
  provider_usage?: { available: boolean; version: number; backends?: Backend[] }
  subagent_limit_v1?: { version: number; backends?: Backend[] }
  codex_provider_v1?: { available?: boolean; version?: number; per_chat?: boolean; per_chat_models?: boolean; model_discovery?: boolean; model_compatibility?: boolean }
  side_questions?: SideQuestionsCapability
  tmux?: ServerCapability
  workspace_files?: WorkspaceFilesCapability
  working_directory_completion?: WorkingDirectoryCompletionCapability
  scheduled_jobs?: ScheduledJobsCapability
  codex_controls?: InteractiveProviderCapability
  claude_controls?: InteractiveProviderCapability
  cursor_backend?: CursorBackendCapability
  opencode_backend?: OpenCodeBackendCapability
  local_provider_commands_v1?: ServerCapability & { version?: number; supported_backends?: Backend[] }
  agent_team_mail_v1?: AgentTeamMailCapability
  agent_team_messages_v1?: AgentTeamMessagesCapability
  agent_team_mail_routes_v1?: { available: boolean; version: 1; max_routes: number }
  team_bulletin_alias_v1?: TeamBulletinAliasCapability
  team_all_servers_alias_v1?: TeamAllServersAliasCapability
  cross_chat_handoffs_v1?: CrossChatHandoffsCapability
  provider_jobs_access_control_v1?: ProviderJobsAccessControlCapability
  server_restart?: ServerRestartCapability
  team_hub_v1?: TeamHubV1Capability
  team_hub_host_control_v1?: TeamHubHostControlCapability
  local_session_import_v1?: LocalSessionImportCapability
  session_fork_completed_prefix_v1?: SessionForkCompletedPrefixCapability
  agent_emergency_alerts_v1?: AgentEmergencyAlertsCapability
  team_mail_hints_v1?: TeamMailHintsCapability
  team_mail_hints_v2?: TeamActivityHintsCapability
  pinned_items?: PinnedItemsCapability
  port_forwarding_v1?: PortForwardingCapability
  websocket_auth_v1?: ServerCapability
  [key: string]: SideQuestionsCapability | ServerCapability | ServerRestartCapability | TeamHubV1Capability | TeamHubHostControlCapability | LocalSessionImportCapability | SessionForkCompletedPrefixCapability | AgentEmergencyAlertsCapability | TeamMailHintsCapability | TeamActivityHintsCapability | AgentTeamMailCapability | AgentTeamMessagesCapability | TeamBulletinAliasCapability | TeamAllServersAliasCapability | PinnedItemsCapability | JsonValue | undefined
}

export type ServerComponentHealth = {
  protocol: number
  instance_id: string
  pid: number
  version: string
}

export type ExecutionServiceHealth = ServerComponentHealth & {
  worker_upgrade_policy: 'when_idle'
  rolling_worker_upgrade: boolean
  /** A healthy candidate can still be held until its installer commits. */
  maintenance_held?: boolean
}

export type GatewayHealth = ServerComponentHealth & {
  restart_preserves_execution: boolean
}

export interface Health {
  ok: boolean
  state_dir?: string
  server_identity?: string
  server_name?: string
  /** Opaque boot identifier. A successful managed restart must change it. */
  server_instance_id?: string
  server_version?: string
  /** Separate component versions; server_version still describes execution. */
  gateway?: GatewayHealth
  execution_service?: ExecutionServiceHealth
  api_contract_version?: number
  active?: string[]
  active_sessions?: string[]
  active_runs?: Array<Record<string, JsonValue>>
  host?: Record<string, JsonValue>
  max_active_agent_runs?: number
  managed_updates?: boolean
  default_cwd?: string | null
  queued?: Record<string, number>
  /** Queue entries that are not yet durable enough to survive a managed restart. */
  update_blocking_queued_count?: number
  runtimes?: Record<string, RuntimeDiagnostic>
  capabilities?: HealthCapabilities
  [key: string]: JsonValue | Record<string, RuntimeDiagnostic> | HealthCapabilities | undefined
}

export interface PublicServerProfile {
  id: string
  name: string
  serverUrl: string
  serverIdentity?: string | null
  hasAccessToken: boolean
  serverSetupComplete: boolean
  connectionState: ServerConnectionState
  cachedUnreadCount: number
  lastConnectionError?: string | null
  serverVersion?: string | null
}

export interface AddServerProfileInput {
  name?: string
  serverUrl: string
  accessToken?: string | null
  /** Canonical identity returned by a successful connection test. */
  serverIdentity?: string | null
  serverSetupComplete?: boolean
}

export interface UpdateServerProfilePatch {
  name?: string
  serverUrl?: string
  /** Undefined preserves the stored credential; null or an empty string removes it. */
  accessToken?: string | null
  /** Explicit user confirmation that this endpoint may establish a new canonical identity. */
  resetServerIdentity?: boolean
  serverSetupComplete?: boolean
}

export interface WorkspaceProfileScope {
  profileId: string
  profileGeneration: number
  serverIdentity?: string | null
}

export interface TestServerConnectionInput {
  /** Uses this profile's saved credential when accessToken is omitted. */
  profileId?: string
  serverUrl: string
  accessToken?: string | null
}

export interface ServerProfilesSnapshot {
  activeProfileId: string
  profiles: PublicServerProfile[]
  profileGeneration: number
}

export interface ProfileEventContext {
  profileId: string
  profileGeneration: number
  serverIdentity?: string | null
}

/** Profile-scoped wrappers for events whose legacy payload is a bare value. */
export interface ProfileConnectionEvent extends ProfileEventContext {
  connected: boolean
  connectionState: ServerConnectionState
  health?: Health
  error?: string
}
export interface ProfileSyncEvent extends ProfileEventContext { sessionId: string; state: ChatSyncStatus; error?: string }
export interface ProfileSessionsEvent extends ProfileEventContext { sessions: Session[] }
export interface ProfileAgentEvent extends ProfileEventContext {
  event: Event
  /** Main-process lifecycle projection; never persisted in the transcript. */
  activeSession?: boolean
  activeRunId?: string | null
}
export interface ProviderRuntimeChanged {
  type: 'provider_runtime_changed'
  session_id: string
  backend: Backend
  runtime: 'context_usage'
  ephemeral: true
  context_usage_state?: 'available' | 'cleared' | 'unavailable' | null
  usage_generation?: number | null
  provider_session_id?: string | null
  context_usage_snapshot?: CodexTokenUsage | ClaudeTokenUsage | null
  context_usage?: CodexTokenUsage | ClaudeTokenUsage | null
}
export interface ProfileProviderRuntimeEvent extends ProfileEventContext { event: ProviderRuntimeChanged }
export interface ProfileReasoningStreamEvent extends ProfileEventContext {
  sessionId: string
  snapshot: ReasoningSummaryStreamSnapshot | null
}
export interface ProfileJobsEvent extends ProfileEventContext { jobs: Job[] }
export interface ProfileRuntimeEvent extends ProfileEventContext { runtimeCatalog: RuntimeCatalog }
export interface ProfileFilesEvent extends ProfileEventContext { sessionId: string; files: AgentFile[]; total: number }
export interface ProfilePinsEvent extends ProfileEventContext { sessionId: string; pins: PinnedItem[]; revision: number }
export interface ProfileTimelineEvent extends ProfileEventContext {
  sessionId: string
  snapshot: SessionSnapshot
  source: 'cache' | 'server'
  mode?: 'merge' | 'replace'
}
export interface ProfileTerminalDataEvent extends ProfileEventContext { sessionId: string; data: string }
export interface ProfileTerminalStateEvent extends ProfileEventContext {
  sessionId: string
  state: TerminalConnectionState
  name?: string | null
  error?: string | null
}
export interface ProfileForwardedPortsEvent extends ProfileEventContext { ports: ForwardedPort[] }

export interface ServerSettings {
  serverUrl: string
  accessToken: string
}

export interface PublicServerSettings {
  serverUrl: string
  hasAccessToken: boolean
  serverIdentity?: string | null
  serverSetupComplete: boolean
}

export interface ServerSetupInput {
  target: 'local' | 'ssh'
  sshHost?: string
  port?: number
  track?: ServerUpdateTrack
  /** Explicitly designate a fresh install as the Team Network host. Omit during updates to preserve the existing role. */
  teamHubHost?: boolean
}

export interface ServerSetupCapabilities {
  available: boolean
  local: boolean
  ssh: boolean
  reason?: string
}

export interface ServerSetupProgress {
  phase: 'connect' | 'download' | 'runtime' | 'install' | 'service' | 'health' | 'diagnostics' | 'complete'
  message: string
}

export interface ServerSetupDiagnostics {
  logPath: string
  state: 'idle' | 'running' | 'failed' | 'completed' | 'cancelled'
  tail: string[]
  startedAt?: string
  updatedAt?: string
  target?: 'local' | 'ssh'
}

export interface ServerSetupResult {
  serverUrl: string
  accessToken: string
  service: string
  tailscaleIP: string
  serverVersion?: string
}

export type ServerUpdateTrack = 'stable' | 'beta'
export type ServerUpdatePhase = 'idle' | 'current' | 'available' | 'unavailable' | 'pending' | 'starting' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'complete' | 'failed'
export interface ServerUpdateBlockerCounts {
  active_runs: number
  queued_turns: number
  provider_background_tasks: number
  in_flight_server_changes: number
}
export interface ServerUpdateStatus {
  phase: ServerUpdatePhase
  current_version: string
  /** Canonical identity of the AgentsServer that produced this live status. */
  server_identity?: string
  /** Opaque boot identifier of the AgentsServer that produced this live status. */
  server_instance_id?: string
  track?: ServerUpdateTrack
  latest_version?: string
  target_version?: string
  installed_version?: string
  update_available?: boolean
  api_contract_version?: number
  update_id?: string
  /** Durable reservation identifier; distinct from the detached launch id. */
  schedule_id?: string
  /** True when the server owns a durable install-when-idle reservation. */
  when_idle?: boolean
  /** Pending reservations can be cancelled until the detached updater starts. */
  cancelable?: boolean
  pending_at?: string
  /** Preparation keeps phase pending and allows existing and manual work. */
  preparation_phase?: 'checking' | 'downloading' | 'staging' | 'ready'
  blocker_counts?: ServerUpdateBlockerCounts
  message?: string
  /** Stable public failure code for actionable managed-update recovery. */
  error_code?: string | null
  /** Bounded user-facing recovery action; never contains host-private details. */
  error_action?: string | null
  retryable?: boolean | null
  checked_at?: string
  started_at?: string
  updated_at?: string
  finished_at?: string | null
}

export type AppUpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'not-available' | 'error'
export type AppUpdateChannel = 'development' | 'direct' | 'app-store'
export type AppUpdateTrack = 'stable' | 'beta'
export interface CoordinatedServerUpdate {
  profileId: string
  name: string
  serverIdentity: string | null
  targetVersion: string
  phase: 'checking' | 'pending' | 'updating' | 'current' | 'offline' | 'blocked' | 'failed'
  message: string
  apiContractVersion?: number
  serverInstanceId?: string
  gatewayVersion?: string
  executionVersion?: string
  operationId?: string
  scheduleId?: string
  operationTargetVersion?: string
  operationOwned?: boolean
  paused?: boolean
}
export interface AppUpdateStatus {
  state: AppUpdateState
  channel: AppUpdateChannel
  track: AppUpdateTrack
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
  checkedAt?: string
  downloadedAt?: string
  /** Whether the pending app update can still be canceled before native installation. */
  cancelable?: boolean
  serverUpdates?: CoordinatedServerUpdate[]
  serverUpdateMessage?: string
}

export interface TimelinePage {
  session: Session
  events: Event[]
  queued_turns?: QueuedTurn[]
  active?: boolean
  has_more?: boolean
  before?: number | null
  next_before?: number | null
  total?: number | null
  latest_seq?: number | null
  events_omitted_before?: number | null
  events_omitted_after?: number | null
  /** Semantic paging metadata is additive and absent on legacy servers. */
  semantic_item_count?: number | null
  semantic_total?: number | null
  semantic_omitted_before?: number | null
  semantic_omitted_after?: number | null
  next_semantic_before?: number | null
  /** Whether a semantic-mode request was actually honored by the server. */
  semantic_paging?: boolean | null
}

export interface SubagentSnapshot {
  session_id: string
  subagents: Event[]
  count: number
  active_count: number
  latest_seq: number
}

export interface TimelineTracePage {
  events: Event[]
  has_more: boolean
  next_after: number | null
}

export interface JobRunHistoryPage {
  runs: Event[]
  total: number
  has_more: boolean
  next_before: number | null
  /** Echoed when the server honored contiguous timeline-segment filtering. */
  timeline_group_id?: string | null
  /** False when connected to a server predating lazy job-run history. */
  supported: boolean
}

export type TimelineLandmarkKind = 'user' | 'assistant' | 'trace' | 'media' | 'error' | 'job' | 'digest' | 'system'

export interface TimelineIndexLandmark {
  key: string
  kind: TimelineLandmarkKind
  start_seq: number
  end_seq: number
  title: string
  preview: string
  meta?: string | null
  timestamp?: string | null
}

export interface TimelineIndex {
  session_id: string
  landmarks: TimelineIndexLandmark[]
  latest_seq: number
  event_count: number
  generated_at?: string | null
}

export interface TimelineSearchResult {
  session_id: string
  event_id: string
  seq: number
  ts?: string | null
  role: 'user' | 'assistant' | 'trace' | 'error' | 'job' | 'file' | 'system'
  snippet: string
  match_count?: number | null
  profileId?: string
  profileName?: string
  serverIdentity?: string | null
}

export interface ProfileTimelineSearchResult extends TimelineSearchResult {
  profileId: string
  profileName: string
}

export interface ProfileSessionSearchResult {
  profileId: string
  profileName: string
  serverIdentity?: string | null
  session: Session
  source: 'title' | 'content'
  history?: TimelineSearchResult
}

export interface FilesPage {
  files: AgentFile[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink'

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
  revision?: string
  size?: number | null
  mtime_ns?: number | null
  hidden?: boolean
  writable?: boolean
}

export interface WorkspaceRenameResult {
  root: string
  previous_path: string
  entry: WorkspaceEntry
}

export interface WorkspaceCreateResult {
  root: string
  entry: WorkspaceEntry
  file?: WorkspaceFile
}

export interface WorkspaceRemoveResult {
  root: string
  path: string
  kind: WorkspaceEntryKind
  removed: true
}

export interface WorkspaceInfo {
  root: string
  name: string
  read_only: boolean
  capability_version: number
  max_text_file_bytes: number
}

export interface WorkspaceEntriesPage {
  root: string
  path: string
  entries: WorkspaceEntry[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export interface WorkspaceSearchPage {
  root: string
  query: string
  entries: WorkspaceEntry[]
  scanned: number
  truncated: boolean
  limit: number
}

export interface WorkingDirectorySuggestion {
  name: string
  path: string
  symlink?: boolean
}

export interface WorkingDirectoryCompletion {
  input: string
  resolved_path: string
  exists: boolean
  base_path: string
  suggestions: WorkingDirectorySuggestion[]
  truncated: boolean
  message?: string | null
}

export interface WorkspaceFile {
  root: string
  path: string
  name: string
  content: string
  revision: string
  size: number
  mtime_ns: number
  writable: boolean
  /** Additive discriminator for explicitly opened files outside the workspace. */
  scope?: 'workspace' | 'absolute'
}

export interface SessionSnapshot {
  session: Session
  events: Event[]
  queuedTurns: QueuedTurn[]
  files: AgentFile[]
  hasMoreEvents: boolean
  /** True after the server has confirmed the current tail, including a genuinely empty chat. */
  historyVerified?: boolean
  /** Renderer-only fence while a replacement tail is being refetched after continuity could not be proven. */
  historyDiscontinuity?: boolean
  eventsTotal?: number | null
  /** Cursor for the next semantic older-page request; it need not equal the oldest raw event. */
  nextTimelineBefore?: number | null
  /** True for semantic pages, false for the bounded legacy raw fallback, null while unknown. */
  semanticPaging?: boolean | null
  filesTotal: number
  cachedAt: number
  viewState?: ViewState | null
  generation?: number
  /** Renderer-only epoch for a genuinely disjoint authoritative timeline replacement. */
  timelineListGeneration?: number
  /** Renderer-only provider reasoning channels; never part of the durable event/cache cursor. */
  reasoningStream?: ReasoningSummaryStreamSnapshot
}

export interface ReasoningSummaryStreamItem extends Omit<Partial<Event>, 'seq' | 'id' | 'session_id' | 'type' | 'run_id' | 'item_id' | 'backend' | 'phase' | 'text' | 'ts'> {
  run_id: string
  item_id: string
  backend: 'codex'
  phase: 'summary' | 'reasoning'
  text: string
  ts: string
  after_seq: number
}

export interface ReasoningSummaryStreamSnapshot {
  type: 'reasoning_summary_stream'
  session_id: string
  instance_id: string
  revision: number
  items: ReasoningSummaryStreamItem[]
}

export interface ViewState {
  sessionId: string
  topItemId?: string | null
  topItemSeq?: number | null
  topOffset?: number
  distanceFromBottom?: number
  atBottom?: boolean
  updatedAt: number
}

export interface PinnedItem {
  id: string
  sessionId: string
  kind: 'message' | 'file'
  eventId?: string | null
  fileId?: string | null
  fileSessionId?: string | null
  filename?: string | null
  content_type?: string | null
  path?: string | null
  source_path?: string | null
  title: string
  subtitle?: string | null
  body?: string | null
  createdAt: number
}

export interface PinnedItemsSnapshot {
  pins: PinnedItem[]
  revision: number
  updatedAt: string | null
  capabilityVersion: 1
}

/** Ephemeral websocket invalidation; it is never a durable timeline event. */
export interface TimelinePinsChanged {
  type: 'timeline_pins_changed'
  session_id: string
  revision: number
  updated_at: string
}

export interface BootstrapPayload {
  /** A local write failed due to storage exhaustion during this app session. */
  storageFull?: boolean
  settings: PublicServerSettings
  mailHints?: MailHintProjection | null
  health?: Health | null
  sessions: Session[]
  jobs: Job[]
  runtimeCatalog?: RuntimeCatalog | null
  selectedSessionId?: string | null
  folderOrder: string[]
  collapsedFolders: string[]
  archivedCollapsed: boolean
  inspectorVisible: boolean
  /** Present for profile-aware bootstraps; omitted by the legacy single-server path. */
  activeProfileId?: string
  profiles?: PublicServerProfile[]
  profileGeneration?: number
}

export interface ProfileBootstrapPayload extends BootstrapPayload {
  activeProfileId: string
  profiles: PublicServerProfile[]
  profileGeneration: number
  /** A nonfatal cleanup/reset failure after the replacement profile was coherently activated. */
  profileTransitionWarning?: string
}

export interface ProfileNotificationPayload {
  title: string
  body: string
  profileId: string
  serverIdentity: string | null
  sessionId: string
  /** Optional stable key used by main to deduplicate emergency notifications. */
  emergencyAlertId?: string | null
}

export interface ProfileNotificationRoute {
  profileId: string
  serverIdentity: string | null
  sessionId: string
}

export interface CreateSessionInput {
  title: string
  folder: string
  cwd: string
  backend: Backend
  codex_provider?: CodexProvider
  model?: string | null
  effort?: string | null
  system_prompt?: string | null
  subagent_limit?: number | null
  codex_approval_policy?: CodexApprovalPolicy | null
  codex_sandbox_mode?: CodexSandboxMode | null
  codex_permission_profile?: string | null
  codex_approvals_reviewer?: CodexApprovalsReviewer | null
  claude_permission_mode?: ClaudePermissionMode | null
  cursor_permission_mode?: CursorPermissionMode | null
  opencode_permission_mode?: OpenCodePermissionMode | null
}
export interface ResumeSessionInput extends CreateSessionInput { providerId: string }
export interface LocalSessionCandidate {
  provider_session_id: string
  backend: Backend
  label: string
  updated_at: string
  cwd: string | null
}
export interface BulkImportSessionItem {
  provider_session_id: string
  backend: Backend
  cwd?: string | null
  title?: string | null
}
export interface BulkImportSessionResult {
  provider_session_id: string
  backend: Backend
  session_id: string | null
  ok: boolean
  imported: number
  code?: string
  error?: string
}
export interface UpdateSessionInput {
  title?: string
  folder?: string
  cwd?: string
  backend?: Backend
  codex_provider?: CodexProvider
  model?: string | null
  effort?: string | null
  system_prompt?: string | null
  subagent_limit?: number | null
  codex_approval_policy?: CodexApprovalPolicy | null
  codex_sandbox_mode?: CodexSandboxMode | null
  codex_permission_profile?: string | null
  codex_approvals_reviewer?: CodexApprovalsReviewer | null
  claude_permission_mode?: ClaudePermissionMode | null
  cursor_permission_mode?: CursorPermissionMode | null
  opencode_permission_mode?: OpenCodePermissionMode | null
  provider_jobs_access?: ProviderJobsAccess
  pinned?: boolean
  archived?: boolean
}
export interface SendTurnInput {
  sessionId: string
  prompt: string
  fileIds: string[]
  /** Browser-local correlation with the shared chat's existing acceptance receipt. */
  sharedChatRequestId?: string
  model?: string | null
  effort?: string | null
  clientCapabilities?: string[]
  chatReferences?: ChatReference[]
  teamReferences?: TeamReference[]
  /** Opaque selection returned by the session-scoped provider command inventory. */
  skillSelection?: ProviderCommandSelection
}
export interface CreateJobInput {
  session_id: string
  title: string
  prompt: string
  chat_references?: ChatReference[]
  team_references?: TeamReference[]
  interval_seconds?: number | null
  schedule_kind?: JobScheduleKind
  cron_expression?: string | null
  rrule?: string | null
  timezone?: string | null
  first_run_at?: string | null
  loop: boolean
  max_runs?: number | null
  enabled: boolean
  context_mode?: JobContextMode
  backend?: Backend | null
}
export interface UpdateJobInput {
  title?: string
  prompt?: string
  /** Omitted preserves existing targets; an empty list revokes all targets. */
  chat_references?: ChatReference[]
  /** Omitted preserves existing Team Network grants; an empty list revokes them. */
  team_references?: TeamReference[]
  interval_seconds?: number | null
  schedule_kind?: JobScheduleKind
  cron_expression?: string | null
  rrule?: string | null
  timezone?: string | null
  next_run_at?: string | null
  loop?: boolean
  max_runs?: number | null
  enabled?: boolean
  context_mode?: JobContextMode
  backend?: Backend | null
}
export interface DigestInput {
  sourceSessionId: string
  targetSessionId: string
  detail: string
  userPrompt: string
}

export interface NativeFileRef {
  path: string
  name: string
  size?: number
  type?: string
}

export interface AppEventMap {
  'provider-usage:changed': { profileId: string; profileGeneration: number; serverIdentity?: string | null; sessionId: string; backend: 'codex' | 'claude' }
  'side-chat:changed': { profileId: string; profileGeneration: number; sessionId: string; revision: number }
  'app:storage': { full: boolean }
  'team:mail-hints': MailHintProjection
  'app:language': LanguageSettingsSnapshot
  'app:update': AppUpdateStatus
  'native:secure-peer-invite': { invite: string }
  'server:connection': ProfileConnectionEvent
  'server:sync': ProfileSyncEvent
  'server:profiles': ServerProfilesSnapshot
  'server:sessions': ProfileSessionsEvent
  'server:event': ProfileAgentEvent
  'server:provider-runtime': ProfileProviderRuntimeEvent
  'server:reasoning-stream': ProfileReasoningStreamEvent
  'server:jobs': ProfileJobsEvent
  'server:runtime': ProfileRuntimeEvent
  'server:pins': ProfilePinsEvent
  'server:setup-progress': ServerSetupProgress
  'server:files': ProfileFilesEvent
  'server:timeline': ProfileTimelineEvent
  'terminal:data': ProfileTerminalDataEvent
  'terminal:state': ProfileTerminalStateEvent
  'ports:changed': ProfileForwardedPortsEvent
  'native:notification': ProfileNotificationRoute
  'native:menu': { command: string }
  'native:close-request': { requestId: string }
}
