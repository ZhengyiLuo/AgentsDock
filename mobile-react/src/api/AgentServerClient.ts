import type {
  AgentFile,
  CreateJobInput,
  CreateSessionInput,
  Event,
  FilesPage,
  Health,
  Job,
  ProcessSnapshot,
  QueuedTurn,
  RuntimeCatalog,
  Session,
  TerminalAction,
  TerminalWindowsSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineSearchResult,
  TmuxPane,
  UpdateJobInput,
  UploadRef,
} from '../types'
import { normalizeServerURL } from '../lib/format'

interface SessionResponse {
  session: Session
  events: Event[]
  queued_turns?: QueuedTurn[]
  events_omitted_before?: number
  events_omitted_after?: number
  latest_seq?: number
  event_count?: number
}

export class ServerError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export interface TerminalConnection {
  write(data: string): void
  resize(columns: number, rows: number): void
  scroll(delta: number): void
  close(): void
}

export class AgentServerClient {
  private baseURL: string
  private token: string

  constructor(baseURL: string, token = '') {
    this.baseURL = normalizeServerURL(baseURL)
    this.token = token
  }

  configure(baseURL: string, token: string): void {
    this.baseURL = normalizeServerURL(baseURL)
    this.token = token
  }

  url(path: string): string { return `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}` }
  fileURL(fileId: string): string { return this.url(`/api/files/${encodeURIComponent(fileId)}`) }
  authHeaders(): Record<string, string> { return this.token ? { 'X-ZenithDock-Token': this.token } : {} }

  health(): Promise<Health> { return this.get('/api/health') }
  runtimeCatalog(): Promise<RuntimeCatalog> { return this.get('/api/runtime/catalog') }
  async sessions(): Promise<Session[]> { return (await this.get<{ sessions: Session[] }>('/api/sessions')).sessions }
  async jobs(): Promise<Job[]> { return (await this.get<{ jobs: Job[] }>('/api/jobs')).jobs }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return (await this.post<{ session: Session }>('/api/sessions', {
      title: input.title,
      folder: input.folder,
      cwd: input.cwd,
      backend: input.backend,
      model: input.model || null,
      effort: input.effort || null,
      provider_session_id: input.providerId || null,
      import_history: Boolean(input.providerId),
    })).session
  }

  async updateSession(sessionId: string, patch: Partial<Session>): Promise<Session> {
    return (await this.patch<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`, patch)).session
  }
  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.delete<{ deleted?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    return result.deleted !== false
  }
  forkSession(sessionId: string): Promise<{ session: Session; sessions?: Session[] }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {})
  }
  async reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after'): Promise<Session[]> {
    return (await this.post<{ sessions: Session[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/order`, { target_id: targetId, placement })).sessions
  }
  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/read`, { last_read_agent_event_seq: seq ?? null })).session
  }
  async markUnread(sessionId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/unread`, {})).session
  }

  async sessionPage(sessionId: string, options: { after?: number; before?: number; limit?: number; tail?: boolean; visible?: boolean } = {}): Promise<TimelinePage> {
    const query = new URLSearchParams()
    if (options.after != null) query.set('after', String(options.after))
    if (options.before != null) query.set('before', String(options.before))
    query.set('limit', String(options.limit ?? 240))
    query.set('tail', String(options.tail ?? true))
    query.set('visible', String(options.visible ?? true))
    const response = await this.get<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}?${query}`)
    return {
      session: response.session,
      events: response.events,
      queued_turns: response.queued_turns ?? [],
      has_more: (response.events_omitted_before ?? 0) > 0,
      before: response.events[0]?.seq ?? null,
      total: response.event_count ?? null,
      latest_seq: response.latest_seq ?? response.events.at(-1)?.seq ?? null,
      events_omitted_before: response.events_omitted_before ?? 0,
      events_omitted_after: response.events_omitted_after ?? 0,
    }
  }

  timelineIndex(sessionId: string): Promise<TimelineIndex> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/timeline-index`)
  }
  codeDiff(sessionId: string, runId: string): Promise<string> {
    return this.requestText(`/api/sessions/${encodeURIComponent(sessionId)}/diffs/${encodeURIComponent(runId)}`)
  }
  async searchTimeline(sessionId: string, query: string, limit = 50): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return (await this.get<{ results?: TimelineSearchResult[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/search?${params}`)).results ?? []
  }
  async searchSessions(query: string, limit = 80): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return (await this.get<{ results?: TimelineSearchResult[] }>(`/api/search?${params}`)).results ?? []
  }

  sendTurn(sessionId: string, prompt: string, fileIds: string[], model?: string | null, effort?: string | null): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
      prompt,
      file_ids: fileIds,
      model: model ?? '',
      effort: effort ?? '',
    })
  }
  async stopTurn(sessionId: string): Promise<boolean> {
    const value = await this.post<{ stopped?: boolean; ok?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {})
    return value.stopped ?? value.ok ?? true
  }
  async queue(sessionId: string): Promise<QueuedTurn[]> {
    return (await this.sessionPage(sessionId, { limit: 1, tail: true, visible: false })).queued_turns
  }
  async updateQueued(sessionId: string, queuedId: string, prompt: string): Promise<void> {
    await this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`, { prompt })
  }
  async removeQueued(sessionId: string, queuedId: string): Promise<void> {
    await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`)
  }
  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<void> {
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/move`, { direction })
  }
  async runQueuedNow(sessionId: string, queuedId: string): Promise<void> {
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/run-now`, {})
  }

  async createJob(input: CreateJobInput): Promise<Job> { return (await this.post<{ job: Job }>('/api/jobs', input)).job }
  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> { return (await this.patch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, patch)).job }
  async deleteJob(jobId: string): Promise<void> { await this.delete(`/api/jobs/${encodeURIComponent(jobId)}`) }
  async runJob(jobId: string): Promise<void> { await this.post(`/api/jobs/${encodeURIComponent(jobId)}/run`, {}) }

  files(sessionId: string, offset = 0, limit = 60, contentPrefix?: string): Promise<FilesPage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (contentPrefix) query.set('content_prefix', contentPrefix)
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/files?${query}`)
  }
  async upload(sessionId: string, file: UploadRef): Promise<AgentFile> {
    const form = new FormData()
    form.append('file', { uri: file.uri, name: file.name, type: file.type ?? 'application/octet-stream' } as never)
    return (await this.request<{ file: AgentFile }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`, { method: 'POST', body: form })).file
  }

  processes(sessionId: string): Promise<ProcessSnapshot> { return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/processes`) }
  async processLog(sessionId: string, path: string, lines = 300): Promise<string> {
    const query = new URLSearchParams({ path, lines: String(lines) })
    const value = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/processes/log?${query}`)
    return value.text ?? value.output ?? ''
  }
  async tmux(sessionId: string, includeAll = false): Promise<TmuxPane[]> {
    return (await this.get<{ panes?: TmuxPane[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux?include_all=${includeAll}`)).panes ?? []
  }
  async captureTmux(sessionId: string, paneId: string, lines = 500): Promise<string> {
    const query = new URLSearchParams({ pane_id: paneId, lines: String(lines) })
    const value = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux/capture?${query}`)
    return value.text ?? value.output ?? ''
  }
  terminalWindows(sessionId: string): Promise<TerminalWindowsSnapshot> { return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/windows`) }
  terminalAction(sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, { action, target: target ?? null })
  }
  async deleteTerminal(sessionId: string): Promise<void> { await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`) }

  async previewDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<string> {
    return (await this.post<{ digest: string }>(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest`, {
      target_session_id: targetSessionId || null,
      detail,
      user_prompt: userPrompt || null,
    })).digest
  }
  async sendDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<void> {
    await this.post(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest/send`, {
      target_session_id: targetSessionId,
      detail,
      user_prompt: userPrompt || null,
    })
  }

  stream(sessionId: string, after: number, onEvent: (event: Event) => void, onState: (connected: boolean) => void): () => void {
    const endpoint = new URL(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/events`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket | null = null
    let stopped = false
    let lastSeq = after
    let retryDelay = 500
    let retry: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      if (stopped) return
      const url = new URL(endpoint)
      url.searchParams.set('after', String(lastSeq))
      if (this.token) url.searchParams.set('token', this.token)
      socket = new WebSocket(url.toString())
      socket.onopen = () => { retryDelay = 500; onState(true) }
      socket.onmessage = message => {
        try {
          const event = JSON.parse(String(message.data)) as Event
          if (Number.isFinite(event.seq) && event.seq > lastSeq) { lastSeq = event.seq; onEvent(event) }
        } catch { /* malformed packets are ignored */ }
      }
      socket.onclose = () => {
        onState(false)
        if (stopped) return
        retry = setTimeout(connect, retryDelay)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      socket.onerror = () => onState(false)
    }
    connect()
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close() }
  }

  terminal(sessionId: string, columns: number, rows: number, cwd: string | null, onData: (data: string) => void, onState: (connected: boolean, name?: string) => void): TerminalConnection {
    const endpoint = new URL(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/ws`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.searchParams.set('columns', String(columns))
    endpoint.searchParams.set('rows', String(rows))
    if (cwd) endpoint.searchParams.set('cwd', cwd)
    if (this.token) endpoint.searchParams.set('token', this.token)
    const socket = new WebSocket(endpoint.toString())
    socket.binaryType = 'arraybuffer'
    socket.onmessage = message => {
      if (typeof message.data === 'string') {
        try {
          const control = JSON.parse(message.data) as { type?: string; name?: string }
          if (control.type === 'ready') onState(true, control.name)
          return
        } catch { onData(message.data); return }
      }
      if (message.data instanceof ArrayBuffer) onData(new TextDecoder().decode(new Uint8Array(message.data)))
    }
    socket.onclose = () => onState(false)
    return {
      write: data => { if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data)) },
      resize: (nextColumns, nextRows) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', columns: nextColumns, rows: nextRows })) },
      scroll: delta => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'scroll', delta })) },
      close: () => socket.close(),
    }
  }

  private get<T>(path: string): Promise<T> { return this.request(path) }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'POST', body: JSON.stringify(body) }) }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'PATCH', body: JSON.stringify(body) }) }
  private delete<T>(path: string): Promise<T> { return this.request(path, { method: 'DELETE' }) }

  private async requestText(path: string): Promise<string> {
    const response = await this.fetchWithTimeout(this.url(path), { headers: this.authHeaders() })
    if (!response.ok) throw await this.serverError(response)
    return response.text()
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    for (const [key, value] of Object.entries(this.authHeaders())) headers.set(key, value)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await this.fetchWithTimeout(this.url(path), { ...init, headers })
    if (!response.ok) throw await this.serverError(response)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try { return await fetch(url, { ...init, signal: init.signal ?? controller.signal }) }
    finally { clearTimeout(timer) }
  }
  private async serverError(response: Response): Promise<ServerError> {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { detail?: unknown }
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body)
    } catch { /* retain status */ }
    return new ServerError(response.status, detail)
  }
}
