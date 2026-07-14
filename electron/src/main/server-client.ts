import { openAsBlob } from 'node:fs'
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
  ResumeSessionInput,
  RuntimeCatalog,
  Session,
  TerminalAction,
  TerminalConnectOptions,
  TerminalStateEvent,
  TerminalWindowsSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineSearchResult,
  TmuxPane,
  UpdateJobInput,
  UpdateSessionInput
} from '../shared/types'
import { normalizeServerURL } from '../shared/server-url'

interface SessionResponse {
  session: Session
  events: Event[]
  queued_turns?: QueuedTurn[]
  events_omitted_before?: number
  events_omitted_after?: number
  latest_seq?: number
  event_count?: number
}

export interface TerminalConnection {
  write(data: string): void
  resize(columns: number, rows: number): void
  scroll(delta: number): void
  close(): void
}

export class ServerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

export class AgentServerClient {
  private baseURL: string
  private token: string

  constructor(baseURL: string, token: string) {
    this.baseURL = normalizeServerURL(baseURL)
    this.token = token
  }

  configure(baseURL: string, token: string): void {
    this.baseURL = normalizeServerURL(baseURL)
    this.token = token
  }

  url(path: string): string {
    return `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`
  }

  async health(): Promise<Health> { return this.get('/api/health') }
  async runtimeCatalog(): Promise<RuntimeCatalog> { return this.get('/api/runtime/catalog') }
  async sessions(): Promise<Session[]> { return (await this.get<{ sessions: Session[] }>('/api/sessions')).sessions }
  async jobs(): Promise<Job[]> { return (await this.get<{ jobs: Job[] }>('/api/jobs')).jobs }

  async createSession(input: CreateSessionInput | ResumeSessionInput): Promise<Session> {
    const providerId = 'providerId' in input ? input.providerId : undefined
    const response = await this.post<{ session: Session }>('/api/sessions', {
      title: input.title,
      folder: input.folder,
      cwd: input.cwd,
      backend: input.backend,
      model: input.model || null,
      effort: input.effort || null,
      provider_session_id: providerId,
      import_history: Boolean(providerId)
    })
    return response.session
  }

  async updateSession(sessionId: string, patch: UpdateSessionInput): Promise<Session> {
    return (await this.patch<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`, patch)).session
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const response = await this.delete<{ deleted?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    return response.deleted !== false
  }

  async forkSession(sessionId: string): Promise<{ session: Session; sessions?: Session[] }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {})
  }

  async reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after'): Promise<Session[]> {
    return (await this.post<{ sessions: Session[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/order`, {
      target_id: targetId,
      placement
    })).sessions
  }

  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
      last_read_agent_event_seq: seq ?? null
    })).session
  }

  async markUnread(sessionId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/unread`, {})).session
  }

  async sessionPage(sessionId: string, options: { after?: number; before?: number; limit?: number; tail?: boolean; visible?: boolean } = {}): Promise<TimelinePage> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set('after', String(options.after))
    if (options.before !== undefined) query.set('before', String(options.before))
    query.set('limit', String(options.limit ?? 120))
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
      events_omitted_after: response.events_omitted_after ?? 0
    }
  }

  async timelineIndex(sessionId: string): Promise<TimelineIndex> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/timeline-index`)
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
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/import-history`, { force })
    return this.sessionPage(sessionId)
  }

  async sendTurn(sessionId: string, prompt: string, fileIds: string[], model?: string | null, effort?: string | null): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
      prompt,
      file_ids: fileIds,
      model: model ?? '',
      effort: effort ?? ''
    })
  }

  async stopTurn(sessionId: string): Promise<boolean> {
    const response = await this.post<{ stopped?: boolean; ok?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {})
    return response.stopped ?? response.ok ?? true
  }

  async queue(sessionId: string): Promise<QueuedTurn[]> {
    return (await this.sessionPage(sessionId, { limit: 1 })).queued_turns ?? []
  }

  async updateQueued(sessionId: string, queuedId: string, prompt: string): Promise<boolean> {
    await this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`, { prompt })
    return true
  }

  async removeQueued(sessionId: string, queuedId: string): Promise<boolean> {
    await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`)
    return true
  }

  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<QueuedTurn[]> {
    const response = await this.post<{ positions?: Array<{ queued_id: string; position: number }> }>(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/move`, { direction })
    const turns = await this.queue(sessionId)
    const positions = new Map((response.positions ?? []).map(item => [item.queued_id, item.position]))
    return turns.map(turn => ({ ...turn, position: positions.get(turn.queued_id) ?? turn.position }))
  }

  async runQueuedNow(sessionId: string, queuedId: string): Promise<boolean> {
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/run-now`, {})
    return true
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    return (await this.post<{ job: Job }>('/api/jobs', input)).job
  }

  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> {
    return (await this.patch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, patch)).job
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return (await this.delete<{ deleted: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}`)).deleted
  }

  async runJob(jobId: string): Promise<boolean> {
    await this.post(`/api/jobs/${encodeURIComponent(jobId)}/run`, {})
    return true
  }

  async files(sessionId: string, offset = 0, limit = 60, contentPrefix?: string): Promise<FilesPage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (contentPrefix) query.set('content_prefix', contentPrefix)
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/files?${query}`)
  }

  async upload(sessionId: string, path: string): Promise<AgentFile> {
    const form = new FormData()
    form.append('file', await openAsBlob(path), path.split('/').pop() ?? 'upload')
    const response = await this.request<{ file: AgentFile }>(`/api/sessions/${encodeURIComponent(sessionId)}/files`, { method: 'POST', body: form })
    return response.file
  }

  async fileEvent(sessionId: string, fileId: string): Promise<Event | null> {
    try {
      return (await this.get<{ event: Event }>(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/event`)).event
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) return null
      throw error
    }
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
    const endpoint = new URL(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/ws`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let retryDelay = 500
    let retry: NodeJS.Timeout | null = null
    let resizeSync: NodeJS.Timeout | null = null
    let socket: WebSocket | null = null
    let columns = options.columns
    let rows = options.rows
    let decoder = new TextDecoder()
    const syncTerminalSize = (): void => {
      if (resizeSync) clearTimeout(resizeSync)
      resizeSync = setTimeout(() => {
        resizeSync = null
        void this.post(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/resize`, { columns, rows }).catch(() => undefined)
      }, 120)
    }

    const connect = (): void => {
      if (stopped) return
      onState({ sessionId, state: retryDelay === 500 ? 'connecting' : 'reconnecting' })
      const url = new URL(endpoint)
      url.searchParams.set('columns', String(columns))
      url.searchParams.set('rows', String(rows))
      if (options.cwd) url.searchParams.set('cwd', options.cwd)
      if (this.token) url.searchParams.set('token', this.token)
      decoder = new TextDecoder()
      socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.addEventListener('message', message => {
        if (typeof message.data === 'string') {
          try {
            const control = JSON.parse(message.data) as { type?: string; name?: string; message?: string }
            if (control.type === 'ready') {
              retryDelay = 500
              onState({ sessionId, state: 'connected', name: control.name ?? null })
            } else if (control.type === 'error') {
              onState({ sessionId, state: 'error', error: control.message || 'Terminal connection failed' })
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
            const blobBytes = new Uint8Array(buffer)
            if (blobBytes.byteLength) onData(decoder.decode(blobBytes, { stream: true }))
          })
          return
        }
        if (bytes?.byteLength) onData(decoder.decode(bytes, { stream: true }))
      })
      socket.addEventListener('close', event => {
        const tail = decoder.decode()
        if (tail) onData(tail)
        if (stopped) {
          onState({ sessionId, state: 'disconnected' })
          return
        }
        if (event.code === 4401 || event.code === 4404) {
          stopped = true
          onState({ sessionId, state: 'error', error: event.code === 4401 ? 'Terminal authorization failed' : 'Chat not found' })
          return
        }
        onState({ sessionId, state: 'reconnecting', error: event.reason || null })
        const jitter = Math.floor(Math.random() * Math.min(250, retryDelay / 3))
        retry = setTimeout(connect, retryDelay + jitter)
        retryDelay = Math.min(10_000, retryDelay * 2)
      })
      socket.addEventListener('error', () => {
        if (!stopped) onState({ sessionId, state: 'error', error: 'Terminal connection interrupted' })
      })
    }

    connect()
    return {
      write(data: string): void {
        if (socket?.readyState === 1) socket.send(new TextEncoder().encode(data))
      },
      resize(nextColumns: number, nextRows: number): void {
        columns = nextColumns
        rows = nextRows
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'resize', columns, rows }))
        syncTerminalSize()
      },
      scroll(delta: number): void {
        const bounded = Math.max(-80, Math.min(80, Math.trunc(delta)))
        if (bounded && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'scroll', delta: bounded }))
      },
      close(): void {
        stopped = true
        if (retry) clearTimeout(retry)
        if (resizeSync) clearTimeout(resizeSync)
        retry = null
        resizeSync = null
        socket?.close()
      }
    }
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
    })
    return response.digest
  }

  fileRequest(fileId: string, request?: Request): Promise<Response> {
    const headers = new Headers(request?.headers)
    this.applyAuth(headers)
    return fetch(this.url(`/api/files/${encodeURIComponent(fileId)}`), {
      method: request?.method ?? 'GET',
      headers,
      signal: request?.signal
    })
  }

  linkedFileRequest(sessionId: string, target: string): Promise<Response> {
    const headers = new Headers()
    this.applyAuth(headers)
    const query = new URLSearchParams({ target })
    return fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/links/file?${query}`), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000)
    })
  }

  stream(sessionId: string, after: number, onEvent: (event: Event) => void, onState: (connected: boolean, error?: string) => void): () => void {
    const endpoint = new URL(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/events`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    let stopped = false
    let lastSeq = after
    let retryDelay = 500
    let socket: WebSocket | null = null
    let retry: NodeJS.Timeout | null = null
    let connectWatchdog: NodeJS.Timeout | null = null
    const connect = (): void => {
      if (stopped) return
      const url = new URL(endpoint)
      url.searchParams.set('after', String(lastSeq))
      if (this.token) url.searchParams.set('token', this.token)
      const current = new WebSocket(url)
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
        if (connectWatchdog) clearTimeout(connectWatchdog)
        connectWatchdog = null
        retryDelay = 500
        onState(true)
      })
      current.addEventListener('message', message => {
        try {
          const event = JSON.parse(String(message.data)) as Event
          if (!Number.isFinite(event.seq) || event.seq <= lastSeq) return
          lastSeq = event.seq
          onEvent(event)
        } catch { /* ignore malformed packets */ }
      })
      current.addEventListener('close', () => disconnect())
      current.addEventListener('error', () => {
        current.close()
        disconnect('Live updates disconnected')
      })
    }
    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      if (connectWatchdog) clearTimeout(connectWatchdog)
      socket?.close()
    }
  }

  private get<T>(path: string): Promise<T> { return this.request(path) }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'POST', body: JSON.stringify(body) }) }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'PATCH', body: JSON.stringify(body) }) }
  private delete<T>(path: string): Promise<T> { return this.request(path, { method: 'DELETE' }) }

  private async requestText(path: string): Promise<string> {
    const headers = new Headers()
    this.applyAuth(headers)
    const response = await fetch(this.url(path), { headers, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json() as { detail?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
        else if (body.detail) detail = JSON.stringify(body.detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail)
    }
    return response.text()
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    this.applyAuth(headers)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await fetch(this.url(path), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json() as { detail?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
        else if (body.detail) detail = JSON.stringify(body.detail)
      } catch { /* keep HTTP status */ }
      throw new ServerError(response.status, detail)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private applyAuth(headers: Headers): void {
    if (this.token) headers.set('X-ZenithDock-Token', this.token)
  }
}
