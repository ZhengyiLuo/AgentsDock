export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type Backend = 'claude' | 'codex'

export interface Session {
  id: string
  title: string
  folder?: string | null
  cwd?: string | null
  backend: Backend
  model?: string | null
  effort?: string | null
  session_id?: string | null
  claude_session_id?: string | null
  codex_thread_id?: string | null
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
}

export interface RuntimeOption { value: string; label: string }
export interface RuntimeBackendCatalog {
  models: RuntimeOption[]
  efforts: RuntimeOption[]
  model_source?: string | null
  effort_source?: string | null
  default_model?: string | null
  default_effort?: string | null
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
  content_type?: string | null
  size?: number | null
  created_at?: string | null
  title?: string | null
  text?: string | null
  source?: string | null
  event_id?: string | null
  seq?: number | null
}

export interface ToolCall {
  name: string
  input?: JsonValue
}

export interface QueuePosition { queued_id: string; position: number }
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
  position?: number | null
  created_at?: string | null
}

export interface Event {
  seq: number
  id: string
  session_id: string
  type: string
  ts: string
  run_id?: string | null
  queued_id?: string | null
  position?: number | null
  purpose?: string | null
  digest_job_id?: string | null
  target_session_id?: string | null
  backend?: Backend | null
  prompt?: string | null
  file_ids?: string[] | null
  text?: string | null
  result_text?: string | null
  message?: string | null
  error?: JsonValue
  output?: string | null
  raw?: string | null
  argv?: string[] | null
  exit_code?: number | null
  is_error?: boolean | null
  provider_session_id?: string | null
  tool_id?: string | null
  tool?: ToolCall | null
  file?: AgentFile | null
  artifact?: AgentFile | null
  job?: Job | null
  job_id?: string | null
  direction?: string | null
  positions?: QueuePosition[] | null
}

export interface Job {
  id: string
  session_id: string
  title: string
  prompt: string
  interval_seconds: number
  next_run_at?: number | null
  next_run_at_iso?: string | null
  first_run_at?: string | null
  last_run_at?: string | null
  last_run_started_at?: string | null
  loop?: boolean | null
  enabled?: boolean | null
  backend?: Backend | null
  model?: string | null
  effort?: string | null
  run_count?: number | null
  max_runs?: number | null
  created_at?: string | null
  updated_at?: string | null
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

export interface Health {
  ok: boolean
  state_dir?: string
  server_identity?: string
  api_contract_version?: number
  active?: string[]
  active_sessions?: string[]
  active_runs?: Array<Record<string, JsonValue>>
  host?: Record<string, JsonValue>
  max_active_agent_runs?: number
  default_cwd?: string | null
  queued?: Record<string, number>
  [key: string]: JsonValue | undefined
}

export interface ServerSettings {
  serverUrl: string
  accessToken: string
}

export interface PublicServerSettings {
  serverUrl: string
  hasAccessToken: boolean
  serverIdentity?: string | null
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

export interface FilesPage {
  files: AgentFile[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export interface SessionSnapshot {
  session: Session
  events: Event[]
  queuedTurns: QueuedTurn[]
  files: AgentFile[]
  hasMoreEvents: boolean
  eventsTotal?: number | null
  filesTotal: number
  cachedAt: number
  viewState?: ViewState | null
  generation?: number
}

export interface ViewState {
  sessionId: string
  topItemId?: string | null
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
  title: string
  subtitle?: string | null
  body?: string | null
  createdAt: number
}

export interface BootstrapPayload {
  settings: PublicServerSettings
  health?: Health | null
  sessions: Session[]
  jobs: Job[]
  runtimeCatalog?: RuntimeCatalog | null
  selectedSessionId?: string | null
  folderOrder: string[]
  collapsedFolders: string[]
  archivedCollapsed: boolean
  inspectorVisible: boolean
}

export interface CreateSessionInput {
  title: string
  folder: string
  cwd: string
  backend: Backend
  model?: string | null
  effort?: string | null
}
export interface ResumeSessionInput extends CreateSessionInput { providerId: string }
export interface UpdateSessionInput {
  title?: string
  folder?: string
  cwd?: string
  backend?: Backend
  model?: string | null
  effort?: string | null
  pinned?: boolean
  archived?: boolean
}
export interface SendTurnInput {
  sessionId: string
  prompt: string
  fileIds: string[]
  model?: string | null
  effort?: string | null
}
export interface CreateJobInput {
  session_id: string
  title: string
  prompt: string
  interval_seconds: number
  first_run_at?: string | null
  loop: boolean
  max_runs?: number | null
  enabled: boolean
  backend?: Backend | null
  model?: string | null
  effort?: string | null
}
export interface UpdateJobInput {
  title?: string
  prompt?: string
  interval_seconds?: number
  next_run_at?: string | null
  loop?: boolean
  max_runs?: number | null
  enabled?: boolean
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
  'server:connection': { connected: boolean; health?: Health; error?: string }
  'server:sessions': Session[]
  'server:event': Event
  'server:jobs': Job[]
  'server:runtime': RuntimeCatalog
  'server:files': { sessionId: string; files: AgentFile[]; total: number }
  'server:timeline': { sessionId: string; snapshot: SessionSnapshot; source: 'cache' | 'server'; mode?: 'merge' | 'replace' }
  'native:menu': { command: string }
}
