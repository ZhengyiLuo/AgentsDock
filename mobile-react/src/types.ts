export type Backend = 'claude' | 'codex' | 'cursor'
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type ServerConnectionState = 'online' | 'degraded' | 'connecting' | 'retrying' | 'offline' | 'cached'

export type CodexApprovalPolicy = 'never' | 'on-request' | 'untrusted'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'
export type CursorPermissionMode = 'default' | 'full_access' | 'plan'
export type ProviderJobsAccess = 'full' | 'read_only' | 'blocked'
export type CodexGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export type CodexThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput'
export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: CodexThreadActiveFlag[] }

export interface ProviderPendingInteraction {
  id: string
  session_id: string
  thread_id?: string | null
  turn_id?: string | null
  item_id?: string | null
  method: string
  params: Record<string, JsonValue>
  created_at: string
  auto_resolution_ms?: number | null
}

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
  /** The server can ask the loaded Claude SDK client for a fresh sample. */
  context_usage_refresh?: boolean
  /** Native Claude Agent SDK MCP connection inspection and controls. */
  mcp_management?: boolean
}

export type ClaudeTokenUsage = Record<string, JsonValue>

export interface ClaudeRuntimeSnapshot {
  available: boolean
  transport: string
  interactive_capability: string | boolean | null
  persisted_session?: boolean
  session_loaded: boolean
  status?: CodexThreadStatus | null
  pending_interactions: ClaudePendingInteraction[]
  policy?: ClaudeRuntimePolicy | null
  features?: ClaudeRuntimeFeatures | null
  permission_modes?: ClaudePermissionMode[]
  context_usage?: ClaudeTokenUsage | null
  context_usage_snapshot?: ClaudeTokenUsage | null
  context_usage_state?: 'available' | 'cleared' | 'unavailable' | null
  /** True when this response includes a newly sampled SDK context value. */
  context_usage_refreshed?: boolean
  usage_generation?: number | null
  provider_session_id?: string | null
  fallback_transport?: string | null
}

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
 * Display-safe MCP state returned by AgentsServer. Configuration secrets,
 * commands, arguments, environment variables, URLs, and tool metadata are
 * deliberately not part of this mobile contract.
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

export interface ClaudeMcpUnavailableReason {
  code: string
  message: string
  retryable: boolean
}

export type ClaudeMcpActionType = 'reconnect' | 'reconnect_all' | 'enable' | 'disable'

export interface ClaudeMcpSnapshot {
  version: 1
  available: boolean
  transport: 'agent-sdk' | 'print'
  /** Opaque equality token for the exact chat-scoped Claude SDK owner. */
  generation: string | null
  session_loaded: boolean
  servers: ClaudeMcpServer[]
  /** True when the server safely capped a larger configured-server list. */
  truncated: boolean
  reason: ClaudeMcpUnavailableReason | null
  action: { type: ClaudeMcpActionType; server_name: string | null } | null
}

export interface ClaudeMcpControlInput {
  version: 1
  action: ClaudeMcpActionType
  server_name: string | null
  expected_generation: string
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
  context_usage?: ClaudeTokenUsage | null
  context_usage_snapshot?: ClaudeTokenUsage | null
}

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
 * Native Codex app-server usage is intentionally open-ended. Codex has used
 * both camelCase nested snapshots and AgentsDock's additive normalized fields.
 */
export type CodexTokenUsage = Record<string, JsonValue>

export interface CodexRuntimeSnapshot {
  available: boolean
  transport: string
  interactive_capability: string | boolean | null
  persisted_thread?: boolean
  thread_loaded: boolean
  status: CodexThreadStatus | null
  goal: CodexGoal | null
  /** Server-wide goal configuration; absent on older servers. */
  goals_enabled?: boolean
  time_budget_seconds: number | null
  /** Additive server field; absent on pre-budget-exhaustion servers. */
  time_budget_exhausted?: boolean
  /** Live native app-server usage. Absent until Codex reports a sample. */
  token_usage?: CodexTokenUsage | null
  /** Normalized live usage with run/turn attribution and context occupancy. */
  token_usage_snapshot?: CodexTokenUsage | null
  /** Explicitly invalidates durable usage after provider reset/reload. */
  context_usage_state?: 'available' | 'cleared' | 'unavailable' | null
  pending_interactions: CodexPendingInteraction[]
  permission_profiles: CodexPermissionProfile[]
  background_terminals_supported: boolean | null
  /** Effective per-chat policy returned by current AgentsServer releases. */
  policy?: CodexRuntimePolicy | null
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

export interface CodexGoalsConfiguration {
  enabled: boolean
  configurable: boolean
  message: string
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
 * Keep the acknowledgement structured so callers do not hide a still-running
 * turn merely because the server accepted the interrupt request.
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

/** Durable, ordered profile metadata. Credentials are stored separately. */
export interface StoredServerProfile {
  id: string
  name: string
  serverURL: string
  serverIdentity: string | null
  serverConfigured: boolean
  /** Selects the only credential record that is authoritative for this profile. */
  credentialVersion: number
  createdAt: string
  updatedAt: string
}

/** Profile data that is safe to expose to the runtime and UI. */
export interface PublicServerProfile extends StoredServerProfile {
  hasAccessToken: boolean
  connectionState: ServerConnectionState
  cachedUnreadCount: number
  lastConnectionError?: string | null
  lastConnectionCheckedAt?: number | null
  serverVersion?: string | null
}

export interface StoredProfileSettings {
  schemaVersion: 2
  activeProfileId: string
  profiles: StoredServerProfile[]
  fontScale: number
}

export interface ChatDefaults {
  backend: Backend
  model: string
  effort: string
  folder: string
  cwd: string
}

export interface WorkspacePreferences {
  selectedSessionId: string | null
  folderOrder: string[]
  collapsedFolders: string[]
  drafts: Record<string, string>
  chatReferencesBySession?: Record<string, ChatReference[]>
  teamReferencesBySession?: Record<string, TeamReference[]>
  chatDefaults?: ChatDefaults
}

export interface AddServerProfileInput {
  name?: string
  serverURL: string
  accessToken?: string | null
  serverIdentity?: string | null
  serverConfigured?: boolean
  setActive?: boolean
}

export interface UpdateServerProfileInput {
  name?: string
  serverURL?: string
  /** Undefined preserves the stored credential; null or an empty string removes it. */
  accessToken?: string | null
  serverIdentity?: string | null
  resetServerIdentity?: boolean
  serverConfigured?: boolean
}

export interface Session {
  id: string
  title: string
  folder?: string | null
  cwd?: string | null
  backend: Backend
  model?: string | null
  effort?: string | null
  system_prompt?: string | null
  /** True after provider state exists and changing backend would orphan it. */
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
  claude_pending_interaction_count?: number | null
  claude_needs_user_action?: boolean | null
  cursor_session_id?: string | null
  cursor_permission_mode?: CursorPermissionMode | null
  provider_jobs_access?: ProviderJobsAccess | null
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
  locked?: boolean
  locked_reason?: string | null
  efforts?: RuntimeOption[] | null
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
  models: RuntimeOption[]
  efforts: RuntimeOption[]
  available?: boolean
  model_efforts?: Record<string, RuntimeOption[]>
  model_source?: string | null
  effort_source?: string | null
  default_model?: string | null
  default_effort?: string | null
  diagnostic?: RuntimeDiagnostic | null
}
export interface RuntimeCatalog { backends: Record<string, RuntimeBackendCatalog>; generated_at?: string | null }

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
  event_seq?: number | null
  seq?: number | null
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

export interface WorkspaceInfo {
  root: string
  name: string
  read_only: boolean
  capability_version: number
  max_text_file_bytes: number
  max_preview_file_bytes?: number
  preview_media_types?: string[]
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
  scope?: 'workspace' | 'absolute'
}

export interface WorkspaceCreateResult {
  root: string
  entry: WorkspaceEntry
}

export interface WorkspaceRenameResult {
  root: string
  previous_path: string
  entry: WorkspaceEntry
}

export interface WorkspaceRemoveResult {
  root: string
  path: string
  kind: WorkspaceEntryKind
  removed: boolean
}

export interface ToolCall { id?: string; name: string; input?: JsonValue }
export interface QueuePosition { queued_id: string; position: number }

export type ChatReferenceAction = 'direct_message' | 'route' | 'request_reply' | 'instruction' | 'final_result'
export type AgentCrossChatRouteAction = 'instruction' | 'request_reply'

/**
 * A user-selected, authority-bearing reference to another chat. Offsets are
 * JavaScript string offsets (UTF-16 code units), matching native text-input
 * selection indices and the AgentsServer contract.
 */
export interface ChatReference {
  session_id: string
  display_title_snapshot: string
  source_text_start: number
  source_text_end: number
  action: ChatReferenceAction
  grant_intent?: true
  /** Optional durable action ceiling for a saved scheduled route hint. */
  route_action?: AgentCrossChatRouteAction
  /** Absent for references to chats on the current AgentsServer. */
  target_kind?: 'secure_peer'
  target_server_identity?: string
  target_connection_id?: string
  target_route_id?: string
  target_route_revision?: string
}

/** Exact, user-selected Team Network server inbox authority. Offsets are UTF-16. */
export interface TeamReference {
  kind: 'recipient'
  recipient_kind: 'server'
  team_id: string
  target_id: string
  display_name_snapshot: string
  source_text_start: number
  source_text_end: number
  grant_intent: true
}

export interface CrossChatHandoffSummary {
  id: string
  kind: ChatReferenceAction
  source_session_id: string
  source_run_id: string
  target_session_id: string
  action: ChatReferenceAction
  status: string
  queued_id?: string | null
  queue_position?: number | null
  target_run_id?: string | null
  error?: string | null
  created_at: string
  updated_at: string
}

export interface CrossChatHandoff extends CrossChatHandoffSummary {
  body: string
  body_chars: number
  body_sha256: string
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
  queue_position?: number | null
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

export interface QueuedTurn {
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
  source_session_id?: string | null
  target_session_id?: string | null
  chat_references?: ChatReference[] | null
  team_references?: TeamReference[] | null
  position?: number | null
  created_at?: string | null
  /** The server is deliberately holding this turn until an explicit Send now. */
  paused?: boolean | null
  pause_reason?: 'stopped' | 'delivery_uncertain' | null
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

export interface QueuedRunStatus {
  queued_id: string
  tone: 'info' | 'error'
  message: string
  delivery_uncertain?: boolean
}

export interface CodeDiffFileSummary {
  path: string
  additions?: number | null
  deletions?: number | null
  binary?: boolean | null
}

export interface Event {
  seq: number
  id: string
  session_id: string
  type: string
  ts: string
  run_id?: string | null
  /** True when AgentsServer replayed this event from a provider transcript. */
  imported?: boolean | null
  /** The provider-import source already removed generated-only prompt wrappers. */
  provider_history_sanitized?: boolean | null
  queued_id?: string | null
  queued_ids?: string[] | null
  superseded_queued_ids?: string[] | null
  superseded_by_queued_id?: string | null
  position?: number | null
  paused?: boolean | null
  pause_reason?: 'stopped' | 'delivery_uncertain' | null
  purpose?: string | null
  phase?: string | null
  digest_job_id?: string | null
  source_session_id?: string | null
  target_session_id?: string | null
  chat_references?: ChatReference[] | null
  handoff_id?: string | null
  cross_chat_envelope_id?: string | null
  watch_id?: string | null
  correlation_id?: string | null
  handoff_status?: string | null
  handoff_action?: ChatReferenceAction | null
  source_title?: string | null
  target_title?: string | null
  handoff_preview?: string | null
  handoff_body_chars?: number | null
  handoff_body_sha256?: string | null
  handoff_body_truncated?: boolean | null
  handoff_authorization_kind?: 'explicit_prompt' | 'configured_route' | null
  handoff_authorization_route_id?: string | null
  exchange_id?: string | null
  exchange_leg_id?: string | null
  cross_chat_exchange_id?: string | null
  cross_chat_exchange_leg_id?: string | null
  cross_chat_exchange_status?: boolean | null
  exchange_status?: CrossChatExchangeStatus | null
  exchange_leg_status?: CrossChatLegStatus | null
  exchange_leg_kind?: CrossChatLegKind | null
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
  model?: string | null
  effort?: string | null
  prompt?: string | null
  request_prompt?: string | null
  display_prompt?: string | null
  file_ids?: string[] | null
  display_file_ids?: string[] | null
  text?: string | null
  result_text?: string | null
  message?: string | null
  error?: JsonValue
  emergency_alert?: EmergencyAlert | null
  emergency_alert_id?: string | null
  unacknowledged_emergency_count?: number | null
  output?: string | null
  output_chars?: number | null
  output_truncated?: boolean | null
  idle_seconds?: number | null
  raw?: string | null
  argv?: string[] | null
  exit_code?: number | null
  is_error?: boolean | null
  provider_session_id?: string | null
  tool_id?: string | null
  tool?: ToolCall | null
  subagent_id?: string | null
  subagent_tool_id?: string | null
  subagent_name?: string | null
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
  job_occurrence_id?: string | null
  job_scheduled_run_at?: number | null
  job_scheduled_run_at_iso?: string | null
  job_timeline_group_id?: string | null
  job_run_count?: number | null
  job_event_count?: number | null
  job_start_seq?: number | null
  job_end_seq?: number | null
  job_history_truncated?: boolean | null
  status?: JsonValue
  job_status?: string | null
  job_status_seq?: number | null
  job_status_type?: string | null
  job_status_run_id?: string | null
  job_run_status?: string | null
  job_run_status_seq?: number | null
  job_run_status_type?: string | null
  job_latest_run_id?: string | null
  job_latest_status?: string | null
  job_latest_status_seq?: number | null
  job_latest_status_type?: string | null
  job_latest_status_run_id?: string | null
  direction?: string | null
  positions?: QueuePosition[] | null
  diff_files?: CodeDiffFileSummary[] | null
  repository_root?: string | null
  files_changed?: number | null
  additions?: number | null
  deletions?: number | null
  byte_count?: number | null
  interaction?: CodexPendingInteraction | null
  interaction_id?: string | null
  request_method?: string | null
  resolution?: string | null
  operation_id?: string | null
  turn_id?: string | null
  item_id?: string | null
  native_steer?: boolean | null
  superseded_by_run_id?: string | null
  steer_interrupted_run_id?: string | null
  stopped?: boolean | null
  codex_thread_status?: CodexThreadStatus | null
  codex_goal?: CodexGoal | null
  /** Durable normalized/native Codex usage; every field is additive. */
  token_usage?: CodexTokenUsage | null
  token_usage_before?: CodexTokenUsage | null
  token_usage_after?: CodexTokenUsage | null
  thread_id?: string | null
  snapshot_at?: string | null
  checkpoint?: string | null
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
  chat_references?: ChatReference[]
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
  context_mode?: JobContextMode | null
  backend?: Backend | null
  model?: string | null
  effort?: string | null
  run_count?: number | null
  max_runs?: number | null
  created_at?: string | null
  updated_at?: string | null
  manual_run_pending?: boolean | null
}

export interface JobRunResponse {
  /** Legacy servers returned only run_id/session/event on immediate success. */
  ok?: boolean
  queued?: boolean | null
  deferred?: boolean | null
  run_id?: string | null
  job_id?: string | null
  job?: Job | null
  message?: string | null
  error?: string | null
}

export interface AgentProcess {
  pid: number
  ppid?: number | null
  command: string
  cwd?: string | null
  elapsed_seconds?: number | null
  cpu_percent?: number | null
  mem_percent?: number | null
  rss_kb?: number | null
  args?: string | null
}
export interface ProcessSnapshot {
  processes: AgentProcess[]
  active?: boolean
  run_id?: string | null
  backend?: Backend | null
  stdout_tail?: { text?: string | null; total_lines?: number | null; truncated?: boolean | null }
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

export type TerminalAction = 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'select-window' | 'kill-window' | 'kill-pane' | 'toggle-mouse'
export interface TerminalWindow { id: string; index: number; name: string; active: boolean; panes: number }
export interface TerminalWindowsSnapshot { session_id: string; name: string; exists: boolean; mouse_enabled?: boolean; windows: TerminalWindow[] }

export interface ServerCapability {
  available: boolean
  required?: boolean
  message?: string
  action?: string | null
  [key: string]: unknown
}

export interface WorkingDirectoryCompletionCapability extends ServerCapability {
  version?: number
  max_results?: number
}

export interface InteractiveProviderCapability extends ServerCapability {
  version?: number
  interactive_capability?: string | null
  interactive_client_capability?: string | null
  features?: Record<string, JsonValue>
  permission_modes?: ClaudePermissionMode[]
  fallback_transport?: string | null
}

export interface ScheduledJobsCapability extends ServerCapability {
  version?: number
  context_modes?: JobContextMode[]
  features?: {
    next_run_reset?: boolean
    interval_next_run_reanchors?: boolean
    [key: string]: JsonValue | undefined
  }
}

export interface AgentEmergencyAlertsCapability extends ServerCapability {
  version?: number
  max_message_chars?: number
  max_requests_per_run?: number
  max_active_alerts?: number
  stream_path?: string
}

export interface ProviderJobsAccessControlCapability extends ServerCapability {
  version?: number
  modes?: ProviderJobsAccess[]
  default?: ProviderJobsAccess
}

/** Capability discriminator for the hardened Cursor backend contract. */
export interface CursorBackendCapability extends ServerCapability {
  version?: number
  permission_modes?: CursorPermissionMode[]
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
  artifact_grants?: boolean
  features?: {
    direct_message_mentions?: boolean
    route_mentions?: boolean
    route_hint_mentions?: boolean
    durable_route_grants?: boolean
    agent_cross_chat_routes?: boolean
    agent_ambient_local_handoffs?: boolean
    exact_queued_delivery_skip?: boolean
    [key: string]: JsonValue | undefined
  }
  agent_routes?: {
    client_capability?: string
    policy?: 'default_deny'
    actions?: Array<'instruction' | 'request_reply'>
    [key: string]: JsonValue | Array<'instruction' | 'request_reply'> | undefined
  }
}

export interface TeamHubV1CapabilityRoute {
  transport: 'loopback' | 'tailscale_serve' | 'direct_ip' | 'secure_peer'
  hub_url: string | null
  base_path?: string
  connection_id?: string
  host_server_identity?: string
  hub_id?: string
}

export interface TeamHubV1Capability extends ServerCapability {
  designated_host: boolean
  version: 1
  base_path: string | null
  server_session_base_path?: string | null
  transport?: TeamHubV1CapabilityRoute['transport'] | null
  hub_url?: string | null
  routes?: TeamHubV1CapabilityRoute[]
  hub_id: string | null
  host_server_identity: string | null
}

export interface ServerUpdatesCapability extends ServerCapability {
  version?: number
  tracks?: string[]
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

export interface HealthCapabilities {
  scheduled_jobs?: ScheduledJobsCapability
  agent_emergency_alerts_v1?: AgentEmergencyAlertsCapability
  provider_jobs_access_control_v1?: ProviderJobsAccessControlCapability
  codex_controls?: InteractiveProviderCapability
  claude_controls?: InteractiveProviderCapability
  cursor_backend?: CursorBackendCapability
  agent_team_mail_v1?: AgentTeamMailCapability
  agent_team_messages_v1?: ServerCapability & {
    version: number
    mention_sigil?: string
    send_requires_mention?: boolean
    recipient_kinds?: string[]
  }
  cross_chat_handoffs_v1?: CrossChatHandoffsCapability
  team_hub_v1?: TeamHubV1Capability
  server_updates?: ServerUpdatesCapability
  working_directory_completion?: WorkingDirectoryCompletionCapability
  [key: string]: JsonValue | InteractiveProviderCapability | CursorBackendCapability | ScheduledJobsCapability | AgentEmergencyAlertsCapability | ProviderJobsAccessControlCapability | AgentTeamMailCapability | CrossChatHandoffsCapability | TeamHubV1Capability | ServerUpdatesCapability | WorkingDirectoryCompletionCapability | undefined
}

export interface Health {
  ok: boolean
  state_dir?: string
  server_identity?: string
  server_instance_id?: string
  api_contract_version?: number
  active?: string[]
  active_sessions?: string[]
  max_active_agent_runs?: number
  default_cwd?: string | null
  queued?: Record<string, number>
  runtimes?: Record<string, RuntimeDiagnostic>
  capabilities?: HealthCapabilities
  [key: string]: JsonValue | Record<string, RuntimeDiagnostic> | HealthCapabilities | undefined
}

export interface ServerUpdateStatus {
  phase: string
  schedule_id?: string | null
  update_id?: string | null
  target_version?: string | null
  current_version?: string | null
  api_contract_version?: number | null
  when_idle?: boolean | null
  cancelable?: boolean | null
  blocker_counts?: Record<string, number> | null
  message?: string | null
  error_code?: string | null
  error_action?: string | null
  retryable?: boolean | null
  [key: string]: JsonValue | undefined
}

export interface TimelinePage {
  session: Session
  events: Event[]
  queued_turns: QueuedTurn[]
  has_more: boolean
  before?: number | null
  next_before?: number | null
  total?: number | null
  latest_seq?: number | null
  events_omitted_before?: number
  events_omitted_after?: number
  semantic_item_count?: number | null
  semantic_total?: number | null
  semantic_omitted_before?: number | null
  semantic_omitted_after?: number | null
  next_semantic_before?: number | null
  semantic_paging?: boolean | null
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
  /** False when connected to a server predating lazy scheduled-run history. */
  supported: boolean
}

export interface TimelineSearchResult {
  session_id: string
  event_id: string
  seq: number
  ts?: string | null
  role: 'user' | 'assistant' | 'trace' | 'error' | 'job' | 'file' | 'system'
  snippet: string
  match_count?: number | null
}

export interface TimelineIndexLandmark {
  key: string
  kind: 'user' | 'assistant' | 'trace' | 'media' | 'error' | 'job' | 'digest' | 'system'
  start_seq: number
  end_seq: number
  title: string
  preview: string
  meta?: string | null
  timestamp?: string | null
}
export interface TimelineIndex { session_id: string; landmarks: TimelineIndexLandmark[]; latest_seq: number; event_count: number }
export interface FilesPage { files: AgentFile[]; total: number; offset: number; limit: number; has_more: boolean }

export interface Snapshot {
  cacheVersion?: number
  session: Session
  events: Event[]
  queuedTurns: QueuedTurn[]
  files: AgentFile[]
  filesTotal: number
  hasMore: boolean
  total?: number | null
  latestSeq?: number | null
  nextBefore?: number | null
  semanticPaging?: boolean | null
  cachedAt: number
}

export interface UploadRef { uri: string; name: string; type?: string; size?: number }
export interface FailedUpload extends UploadRef { error: string }
export interface PinnedItem {
  id: string
  sessionId: string
  kind: 'message' | 'file'
  eventId?: string
  fileId?: string
  title: string
  body?: string
  createdAt: number
}

export interface CreateSessionInput {
  title: string
  folder: string
  cwd: string
  backend: Backend
  model?: string | null
  effort?: string | null
  system_prompt?: string | null
  codex_approval_policy?: CodexApprovalPolicy | null
  codex_sandbox_mode?: CodexSandboxMode | null
  codex_permission_profile?: string | null
  codex_approvals_reviewer?: CodexApprovalsReviewer | null
  claude_permission_mode?: ClaudePermissionMode | null
  cursor_permission_mode?: CursorPermissionMode | null
  provider_jobs_access?: ProviderJobsAccess
  providerId?: string
}
export interface CreateJobInput {
  session_id: string
  title: string
  prompt: string
  chat_references?: ChatReference[]
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
  model?: string | null
  effort?: string | null
}
export interface UpdateJobInput {
  title?: string | null
  prompt?: string | null
  chat_references?: ChatReference[]
  interval_seconds?: number | null
  schedule_kind?: JobScheduleKind
  cron_expression?: string | null
  rrule?: string | null
  timezone?: string | null
  /** Omitted preserves the current occurrence; null recomputes from the schedule. */
  next_run_at?: string | null
  loop?: boolean | null
  max_runs?: number | null
  enabled?: boolean | null
  context_mode?: JobContextMode
  backend?: Backend | null
}
