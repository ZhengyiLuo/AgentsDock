import { app, BrowserWindow, dialog, nativeImage, Notification, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join } from 'node:path'
import type {
  AgentFile,
  AppEventMap,
  BootstrapPayload,
  CreateJobInput,
  CreateSessionInput,
  DigestInput,
  Event,
  FilesPage,
  Health,
  Job,
  NativeFileRef,
  PinnedItem,
  ProcessSnapshot,
  PublicServerSettings,
  QueuedTurn,
  ResumeSessionInput,
  RuntimeCatalog,
  SendTurnInput,
  ServerSettings,
  Session,
  SessionSnapshot,
  TerminalAction,
  TerminalConnectOptions,
  TerminalWindowsSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineSearchResult,
  TmuxPane,
  UpdateSessionInput,
  UpdateJobInput,
  ViewState
} from '../shared/types'
import { updateQueuedTurns } from '../shared/queue'
import { timelineCacheHasGap } from '../shared/history'
import { LocalCache } from './persistence'
import { AgentServerClient, type TerminalConnection } from './server-client'
import { SettingsStore } from './settings'
import { appLog } from './logger'

const INITIAL_TAIL_EVENT_LIMIT = 480
const HISTORY_PAGE_EVENT_LIMIT = 480
const HISTORY_AROUND_EVENT_LIMIT = 1_200
const FILE_PAGE_LIMIT = 60

export class AppService {
  readonly settings: SettingsStore
  readonly cache: LocalCache
  readonly client: AgentServerClient

  private serverId: string
  private windows = new Set<BrowserWindow>()
  private selectedSessionId: string | null = null
  private stopTimelineStream: (() => void) | null = null
  private timelineLease = 0
  private pendingEventCache = new Map<string, Event[]>()
  private eventCacheTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private jobsPollTimer: NodeJS.Timeout | null = null
  private health: Health | null = null
  private sessions: Session[] = []
  private jobs: Job[] = []
  private runtimeCatalog: RuntimeCatalog | null = null
  private refreshInFlight = false
  private lastSyncState = ''
  private filesRefreshInFlight = new Set<string>()
  private filesRefreshedAt = new Map<string, number>()
  private fileDownloads = new Map<string, Promise<string>>()
  private timelineIndexes = new Map<string, TimelineIndex>()
  private terminalConnections = new Map<string, TerminalConnection>()
  private terminalLeases = new Map<string, number>()

  constructor() {
    appLog('startup', 'loading settings')
    this.settings = new SettingsStore()
    appLog('startup', 'settings loaded')
    appLog('startup', 'opening local cache')
    this.cache = new LocalCache()
    appLog('startup', 'local cache ready')
    this.client = new AgentServerClient(this.settings.serverUrl(), this.settings.accessToken())
    this.serverId = this.settings.publicSettings().serverIdentity || this.settings.serverUrl()
    appLog('startup', 'server client ready', { serverId: this.serverId })
  }

  addWindow(window: BrowserWindow): void {
    this.windows.add(window)
    window.on('closed', () => this.windows.delete(window))
  }

  start(): void {
    void this.refreshAll(false)
    this.pollTimer = setInterval(() => void this.refreshAll(false, false), 5000)
    this.jobsPollTimer = setInterval(() => void this.refreshJobs(), 30_000)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.jobsPollTimer) clearInterval(this.jobsPollTimer)
    this.pollTimer = null
    this.jobsPollTimer = null
    this.stopTimelineStream?.()
    this.stopTimelineStream = null
    this.timelineLease += 1
    this.disconnectAllTerminals()
    this.flushEventCache()
  }

  async bootstrap(): Promise<BootstrapPayload> {
    appLog('bootstrap', 'cache bootstrap started', { serverId: this.serverId })
    const cachedSessions = this.cache.sessions(this.serverId)
    if (!this.sessions.length) this.sessions = cachedSessions
    if (!this.jobs.length) this.jobs = this.cache.jobs(this.serverId)
    queueMicrotask(() => void this.refreshRuntime())
    const payload = {
      settings: this.settings.publicSettings(),
      health: this.health,
      sessions: this.sessions,
      jobs: this.jobs,
      runtimeCatalog: this.runtimeCatalog,
      selectedSessionId: this.preference('selectedSessionId', null as string | null),
      folderOrder: this.preference('folderOrder', [] as string[]),
      collapsedFolders: this.preference('collapsedFolders', [] as string[]),
      archivedCollapsed: this.preference('archivedCollapsed', false),
      inspectorVisible: this.preference('inspectorVisible', true)
    }
    appLog('bootstrap', 'cache bootstrap finished', { sessions: this.sessions.length, jobs: this.jobs.length })
    return payload
  }

  publicSettings(): PublicServerSettings { return this.settings.publicSettings() }

  async applySettings(value: ServerSettings): Promise<Health> {
    this.disconnectAllTerminals()
    this.stopTimelineStream?.()
    this.stopTimelineStream = null
    this.timelineLease += 1
    this.selectedSessionId = null
    this.settings.update(value)
    this.client.configure(this.settings.serverUrl(), this.settings.accessToken())
    const health = await this.client.health()
    this.adoptHealth(health)
    await this.refreshAll(true)
    return health
  }

  async listSessions(): Promise<Session[]> {
    this.sessions = await this.client.sessions()
    this.cache.putSessions(this.serverId, this.sessions)
    this.emit('server:sessions', this.sessions)
    return this.sessions
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const session = await this.client.createSession(input)
    this.upsertSession(session)
    return session
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const session = await this.client.createSession(input)
    this.upsertSession(session)
    return session
  }

  async updateSession(sessionId: string, patch: UpdateSessionInput): Promise<Session> {
    const session = await this.client.updateSession(sessionId, patch)
    this.upsertSession(session)
    return session
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const removed = await this.client.deleteSession(sessionId)
    if (removed) {
      this.sessions = this.sessions.filter(session => session.id !== sessionId)
      this.cache.removeSession(this.serverId, sessionId)
      this.emit('server:sessions', this.sessions)
    }
    return removed
  }

  async forkSession(sessionId: string): Promise<Session> {
    const response = await this.client.forkSession(sessionId)
    if (response.sessions) this.sessions = response.sessions
    else this.sessions = insertAfter(this.sessions, response.session, sessionId)
    this.cache.putSessions(this.serverId, this.sessions)
    this.emit('server:sessions', this.sessions)
    return response.session
  }

  async reorderSession(sessionId: string, relativeTo: string, placement: 'before' | 'after'): Promise<Session[]> {
    this.sessions = await this.client.reorderSession(sessionId, relativeTo, placement)
    this.cache.putSessions(this.serverId, this.sessions)
    this.emit('server:sessions', this.sessions)
    return this.sessions
  }

  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    const session = await this.client.markRead(sessionId, seq)
    this.upsertSession(session)
    return session
  }

  async markUnread(sessionId: string): Promise<Session> {
    const session = await this.client.markUnread(sessionId)
    this.upsertSession(session)
    return session
  }

  async importHistory(sessionId: string, force = false): Promise<TimelinePage> {
    const page = await this.client.importHistory(sessionId, force)
    this.cache.putSession(this.serverId, page.session)
    this.cache.putEvents(this.serverId, sessionId, page.events)
    this.cache.putTimelineState(this.serverId, sessionId, Boolean(page.has_more), page.latest_seq, page.total)
    return page
  }

  async openTimeline(sessionId: string): Promise<SessionSnapshot> {
    const lease = this.beginTimelineSelection(sessionId)
    const cached = this.cache.snapshot(this.serverId, sessionId)
    const cachedLast = cached?.events.at(-1)?.seq ?? 0
    if (cached) {
      queueMicrotask(() => void this.reconcileTimelineAndStream(sessionId, cachedLast, lease))
      return cached
    }
    return this.fetchTimeline(sessionId, lease)
  }

  cachedTimeline(sessionId: string): SessionSnapshot | null { return this.cache.snapshot(this.serverId, sessionId) }

  async olderTimeline(sessionId: string, before: number, limit = HISTORY_PAGE_EVENT_LIMIT): Promise<TimelinePage> {
    const localEvents = this.cache.eventsBefore(this.serverId, sessionId, before, limit)
    const localSession = this.sessions.find(session => session.id === sessionId) ?? this.cache.session(this.serverId, sessionId)
    const timeline = this.cache.timelineState(this.serverId, sessionId)
    const localPage = localEvents.length && localSession
      ? {
        session: localSession,
        events: localEvents,
        queued_turns: this.cache.queuedTurns(this.serverId, sessionId),
        has_more: this.cache.hasEventsBefore(this.serverId, sessionId, localEvents[0].seq) || this.cache.timelineHasMore(this.serverId, sessionId),
        before: localEvents[0].seq,
        total: timeline?.knownTotal ?? null
      } satisfies TimelinePage
      : null
    if (localPage && (localEvents.length >= limit || !localPage.has_more)) return localPage

    const remoteBefore = localEvents[0]?.seq ?? before
    const remaining = Math.max(1, limit - localEvents.length)
    let page: TimelinePage
    try {
      page = await this.client.sessionPage(sessionId, { before: remoteBefore, limit: remaining, tail: true, visible: true })
    } catch (error) {
      if (localPage) return localPage
      throw error
    }
    this.cache.putSession(this.serverId, page.session)
    this.cache.putEvents(this.serverId, sessionId, page.events)
    this.cache.putTimelineState(this.serverId, sessionId, Boolean(page.has_more), page.latest_seq)
    const events = mergeEventsBySequence(page.events, localEvents)
    return {
      ...page,
      events,
      before: events[0]?.seq ?? null,
      total: page.total ?? timeline?.knownTotal ?? null
    }
  }

  async timelineAround(sessionId: string, anchorSeq: number, limit = INITIAL_TAIL_EVENT_LIMIT): Promise<TimelinePage> {
    const boundedLimit = Math.max(40, Math.min(HISTORY_AROUND_EVENT_LIMIT, limit))
    const olderLimit = Math.floor(boundedLimit / 2)
    const newerLimit = boundedLimit - olderLimit
    const [older, newer] = await Promise.all([
      this.client.sessionPage(sessionId, { before: anchorSeq, limit: olderLimit, tail: true, visible: true }),
      this.client.sessionPage(sessionId, { after: Math.max(0, anchorSeq - 1), limit: newerLimit, tail: false, visible: true })
    ])
    const events = mergeEventsBySequence(older.events, newer.events)
    const timeline = this.cache.timelineState(this.serverId, sessionId)
    return {
      session: newer.session ?? older.session,
      events,
      queued_turns: newer.queued_turns ?? older.queued_turns ?? [],
      has_more: Boolean(older.has_more),
      before: events[0]?.seq ?? null,
      total: timeline?.knownTotal ?? null,
      latest_seq: timeline?.verifiedLatestSeq ?? newer.latest_seq ?? older.latest_seq ?? null,
      events_omitted_before: older.events_omitted_before ?? 0,
      events_omitted_after: newer.events_omitted_after ?? 0
    }
  }

  async timelineIndex(sessionId: string): Promise<TimelineIndex> {
    const cached = this.timelineIndexes.get(`${this.serverId}:${sessionId}`)
    const session = this.sessions.find(candidate => candidate.id === sessionId)
    const expectedLatest = session?.latest_event_seq ?? 0
    if (cached && cached.latest_seq >= expectedLatest) return cached
    const index = await this.client.timelineIndex(sessionId)
    this.timelineIndexes.set(`${this.serverId}:${sessionId}`, index)
    return index
  }

  codeDiff(sessionId: string, runId: string): Promise<string> {
    return this.client.codeDiff(sessionId, runId)
  }

  async searchTimeline(sessionId: string, query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const clean = query.trim()
    if (clean.length < 2) return []
    try {
      return await this.client.searchTimeline(sessionId, clean, limit)
    } catch (error) {
      appLog('search', 'server history search unavailable; using local cache', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return this.cache.searchEvents(this.serverId, sessionId, clean, limit)
    }
  }

  async searchSessions(query: string, limit = 40): Promise<TimelineSearchResult[]> {
    const clean = query.trim()
    if (clean.length < 2) return []
    try {
      return await this.client.searchSessions(clean, limit)
    } catch (error) {
      appLog('search', 'server-wide history search unavailable; using local cache', {
        error: error instanceof Error ? error.message : String(error)
      })
      return this.cache.searchSessions(this.serverId, clean, limit)
    }
  }

  async subscribeTimeline(sessionId: string, after: number): Promise<void> {
    const lease = this.beginTimelineSelection(sessionId)
    queueMicrotask(() => void this.reconcileTimelineAndStream(sessionId, after, lease))
  }

  private beginTimelineSelection(sessionId: string): number {
    this.stopTimelineStream?.()
    this.stopTimelineStream = null
    const lease = ++this.timelineLease
    this.selectedSessionId = sessionId
    this.putPreference('selectedSessionId', sessionId)
    return lease
  }

  private activateTimelineStream(sessionId: string, after: number, lease: number): void {
    if (!this.isCurrentTimeline(sessionId, lease)) return
    this.stopTimelineStream?.()
    this.stopTimelineStream = this.client.stream(sessionId, after, event => {
      if (!this.isCurrentTimeline(sessionId, lease)) return
      if (event.type === 'raw_event') return
      this.emit('server:event', event)
      this.enqueueEventCache(event)
    }, (connected, error) => {
      if (!this.isCurrentTimeline(sessionId, lease)) return
      this.emit('server:connection', { connected, health: this.health ?? undefined, error })
    })
  }

  unsubscribeTimeline(sessionId: string): void {
    if (this.selectedSessionId === sessionId) this.selectedSessionId = null
    this.timelineLease += 1
    this.stopTimelineStream?.()
    this.stopTimelineStream = null
  }

  viewState(sessionId: string): ViewState | null { return this.cache.viewState(this.serverId, sessionId) }
  saveViewState(state: ViewState): void { this.cache.putViewState(this.serverId, state) }

  async sendTurn(input: SendTurnInput): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    const response = await this.client.sendTurn(input.sessionId, input.prompt, input.fileIds, input.model, input.effort)
    this.upsertSession(response.session)
    if (response.event) {
      this.cache.putEvents(this.serverId, input.sessionId, [response.event])
      this.applyEventToCaches(response.event)
    }
    return response
  }

  stopTurn(sessionId: string): Promise<boolean> { return this.client.stopTurn(sessionId) }

  async queue(sessionId: string): Promise<QueuedTurn[]> {
    const turns = await this.client.queue(sessionId)
    this.cache.putQueuedTurns(this.serverId, sessionId, turns)
    return turns
  }

  async updateQueued(sessionId: string, queuedId: string, prompt: string): Promise<boolean> {
    const result = await this.client.updateQueued(sessionId, queuedId, prompt)
    await this.queue(sessionId)
    return result
  }

  async removeQueued(sessionId: string, queuedId: string): Promise<boolean> {
    const result = await this.client.removeQueued(sessionId, queuedId)
    await this.queue(sessionId)
    return result
  }

  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<QueuedTurn[]> {
    const turns = await this.client.moveQueued(sessionId, queuedId, direction)
    this.cache.putQueuedTurns(this.serverId, sessionId, turns)
    return turns
  }

  async runQueuedNow(sessionId: string, queuedId: string): Promise<boolean> {
    const result = await this.client.runQueuedNow(sessionId, queuedId)
    await this.queue(sessionId)
    return result
  }

  async listJobs(): Promise<Job[]> {
    this.jobs = await this.client.jobs()
    this.cache.putJobs(this.serverId, this.jobs)
    this.emit('server:jobs', this.jobs)
    return this.jobs
  }
  async createJob(input: CreateJobInput): Promise<Job> { const job = await this.client.createJob(input); await this.listJobs(); return job }
  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> { const job = await this.client.updateJob(jobId, patch); await this.listJobs(); return job }
  async removeJob(jobId: string): Promise<boolean> { const ok = await this.client.deleteJob(jobId); await this.listJobs(); return ok }
  async runJob(jobId: string): Promise<boolean> { return this.client.runJob(jobId) }

  async chooseFiles(): Promise<NativeFileRef[]> {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    return result.filePaths.map(path => ({ path, name: basename(path) }))
  }

  stageClipboardImage(data: ArrayBuffer, name: string, type: string): NativeFileRef {
    const extension = type.includes('jpeg') ? 'jpg' : type.includes('gif') ? 'gif' : 'png'
    const safeName = (name || `clipboard-${Date.now()}.${extension}`).replace(/[^A-Za-z0-9._-]/g, '_')
    const path = join(app.getPath('temp'), 'AgentsDockClipboard', `${Date.now()}-${safeName}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(data))
    return { path, name: safeName, size: data.byteLength, type }
  }

  async uploadFiles(sessionId: string, paths: string[]): Promise<AgentFile[]> {
    const files: AgentFile[] = []
    for (const path of paths) files.push(await this.client.upload(sessionId, path))
    this.cache.putFiles(this.serverId, sessionId, files)
    return files
  }

  async listFiles(sessionId: string, offset = 0, limit = FILE_PAGE_LIMIT, contentPrefix?: string): Promise<FilesPage> {
    const page = await this.client.files(sessionId, offset, limit, contentPrefix)
    this.cache.putFiles(this.serverId, sessionId, page.files)
    return page
  }

  fileEvent(sessionId: string, fileId: string): Promise<Event | null> { return this.client.fileEvent(sessionId, fileId) }

  async saveFile(file: AgentFile): Promise<string | null> {
    const result = await dialog.showSaveDialog({ defaultPath: file.filename })
    if (result.canceled || !result.filePath) return null
    await this.downloadFile(file, result.filePath)
    return result.filePath
  }

  async openFile(file: AgentFile): Promise<void> { await shell.openPath(await this.ensureLocalFile(file)) }
  async openLinkedFile(sessionId: string, target: string): Promise<void> {
    const cleanTarget = target.trim()
    if (!cleanTarget) return
    const response = await this.client.linkedFileRequest(sessionId, cleanTarget)
    if (!response.ok || !response.body) throw new Error(`Linked file failed: ${response.status}`)
    const filename = linkedFilename(response, cleanTarget)
    const digest = createHash('sha256').update(`${sessionId}\0${cleanTarget}`).digest('hex').slice(0, 20)
    const path = join(app.getPath('temp'), 'AgentsDockLinkedFiles', digest, filename)
    if (!existsSync(path)) await this.downloadResponse(response, path)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  }
  async revealFile(file: AgentFile): Promise<void> { shell.showItemInFolder(await this.ensureLocalFile(file)) }

  async prepareFileForDrag(file: AgentFile): Promise<void> { await this.ensureLocalFile(file) }

  beginDrag(file: AgentFile, window: BrowserWindow): boolean {
    const path = this.localFilePath(file)
    if (!existsSync(path)) {
      appLog('files', 'native drag requested before local file was ready', { fileId: file.id, filename: file.filename })
      return false
    }
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==')
    window.webContents.startDrag({ file: path, icon })
    return true
  }

  previewDigest(input: DigestInput): Promise<string> { return this.client.previewDigest(input.sourceSessionId, input.targetSessionId, input.detail, input.userPrompt) }
  sendDigest(input: DigestInput): Promise<boolean> { return this.client.sendDigest(input.sourceSessionId, input.targetSessionId, input.detail, input.userPrompt) }
  runtime(): Promise<RuntimeCatalog> { return this.client.runtimeCatalog() }
  processes(sessionId: string): Promise<ProcessSnapshot> { return this.client.processes(sessionId) }
  processLog(sessionId: string, path: string, lines?: number): Promise<string> { return this.client.processLog(sessionId, path, lines) }
  tmux(sessionId: string, includeAll?: boolean): Promise<TmuxPane[]> { return this.client.tmux(sessionId, includeAll) }
  captureTmux(sessionId: string, paneId: string, lines?: number): Promise<string> { return this.client.captureTmux(sessionId, paneId, lines) }
  connectTerminal(sessionId: string, options: TerminalConnectOptions): void {
    this.disconnectTerminal(sessionId)
    const lease = (this.terminalLeases.get(sessionId) ?? 0) + 1
    this.terminalLeases.set(sessionId, lease)
    const connection = this.client.terminal(
      sessionId,
      options,
      data => {
        if (this.terminalLeases.get(sessionId) === lease) this.emit('terminal:data', { sessionId, data })
      },
      state => {
        if (this.terminalLeases.get(sessionId) === lease) this.emit('terminal:state', state)
      }
    )
    this.terminalConnections.set(sessionId, connection)
  }
  writeTerminal(sessionId: string, data: string): void { this.terminalConnections.get(sessionId)?.write(data) }
  resizeTerminal(sessionId: string, columns: number, rows: number): void { this.terminalConnections.get(sessionId)?.resize(columns, rows) }
  scrollTerminal(sessionId: string, delta: number): void { this.terminalConnections.get(sessionId)?.scroll(delta) }
  disconnectTerminal(sessionId: string): void {
    this.terminalLeases.set(sessionId, (this.terminalLeases.get(sessionId) ?? 0) + 1)
    this.terminalConnections.get(sessionId)?.close()
    this.terminalConnections.delete(sessionId)
  }
  async killTerminal(sessionId: string): Promise<boolean> {
    this.disconnectTerminal(sessionId)
    return this.client.deleteTerminal(sessionId)
  }
  terminalWindows(sessionId: string): Promise<TerminalWindowsSnapshot> { return this.client.terminalWindows(sessionId) }
  terminalAction(sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot> {
    return this.client.terminalAction(sessionId, action, target)
  }
  pins(sessionId: string): PinnedItem[] { return this.cache.pins(this.serverId, sessionId) }
  putPin(item: PinnedItem): PinnedItem[] { return this.cache.putPin(this.serverId, item) }
  removePin(sessionId: string, itemId: string): PinnedItem[] { return this.cache.removePin(this.serverId, sessionId, itemId) }
  preference<T>(key: string, fallback: T): T { return this.cache.preference(this.serverId, key, fallback) }
  putPreference<T>(key: string, value: T): void { this.cache.putPreference(this.serverId, key, value) }
  mediaResponse(fileId: string, request: Request): Promise<Response> { return this.client.fileRequest(fileId, request) }

  async notify(title: string, body: string, sessionId?: string): Promise<void> {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      const window = [...this.windows][0]
      window?.show(); window?.focus()
      if (sessionId) this.emit('native:menu', { command: `open-session:${sessionId}` })
    })
    notification.show()
  }

  setBadge(count: number): void { app.dock?.setBadge(count > 0 ? String(count) : '') }

  private async refreshAll(announce: boolean, includeJobs = true): Promise<void> {
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    const started = Date.now()
    try {
      const [health, sessions, jobs] = await Promise.allSettled([this.client.health(), this.client.sessions(), includeJobs ? this.client.jobs() : Promise.resolve(this.jobs)])
      if (health.status === 'fulfilled') {
        this.adoptHealth(health.value)
        this.emit('server:connection', { connected: true, health: health.value })
      } else {
        this.emit('server:connection', { connected: false, error: errorText(health.reason) })
        if (announce) throw health.reason
      }
      if (sessions.status === 'fulfilled') {
        const changed = !jsonEqual(this.sessions, sessions.value)
        this.sessions = sessions.value
        if (changed) {
          this.cache.putSessions(this.serverId, sessions.value)
          this.emit('server:sessions', sessions.value)
        }
      }
      if (jobs.status === 'fulfilled') {
        const changed = !jsonEqual(this.jobs, jobs.value)
        this.jobs = jobs.value
        if (changed) {
          this.cache.putJobs(this.serverId, jobs.value)
          this.emit('server:jobs', jobs.value)
        }
      }
      const durationMs = Date.now() - started
      const syncState = `${health.status}:${sessions.status}:${jobs.status}`
      if (includeJobs || durationMs >= 250 || syncState !== this.lastSyncState) {
        appLog('sync', 'background refresh finished', {
          durationMs,
          health: health.status,
          sessions: sessions.status,
          jobs: jobs.status,
          jobsPolled: includeJobs,
          sessionCount: sessions.status === 'fulfilled' ? sessions.value.length : undefined
        })
      }
      this.lastSyncState = syncState
    } finally {
      this.refreshInFlight = false
    }
  }

  private async refreshJobs(): Promise<void> {
    try {
      const jobs = await this.client.jobs()
      if (!jsonEqual(this.jobs, jobs)) {
        this.jobs = jobs
        this.cache.putJobs(this.serverId, jobs)
        this.emit('server:jobs', jobs)
      }
    } catch (error) {
      appLog('jobs', 'background refresh failed', { error: errorText(error) })
    }
  }

  private async refreshRuntime(): Promise<void> {
    try {
      this.runtimeCatalog = await this.client.runtimeCatalog()
      this.emit('server:runtime', this.runtimeCatalog)
    } catch { /* runtime controls remain usable with the session's saved values */ }
  }

  private adoptHealth(health: Health): void {
    this.health = health
    const identity = health.server_identity?.trim()
    if (identity && identity !== this.serverId) {
      this.serverId = identity
      this.settings.setServerIdentity(identity)
      const cached = this.cache.sessions(identity)
      if (cached.length) this.sessions = cached
    }
  }

  private async reconcileTimelineAndStream(sessionId: string, cachedLast: number, lease: number): Promise<void> {
    try {
      const before = this.cache.snapshot(this.serverId, sessionId)
      const timelineState = this.cache.timelineState(this.serverId, sessionId)
      const needsCompletenessAudit = Boolean(before && timelineState?.verifiedLatestSeq == null)
      const pageRequest = cachedLast > 0
        ? this.client.sessionPage(sessionId, { after: cachedLast, limit: INITIAL_TAIL_EVENT_LIMIT, tail: false, visible: true })
        : this.client.sessionPage(sessionId, { limit: INITIAL_TAIL_EVENT_LIMIT, tail: true, visible: true })
      const [deltaPage, auditPage] = await Promise.all([
        pageRequest,
        needsCompletenessAudit
          ? this.client.sessionPage(sessionId, { limit: INITIAL_TAIL_EVENT_LIMIT, tail: true, visible: true })
          : Promise.resolve(null)
      ])
      let page = deltaPage
      if (!this.isCurrentTimeline(sessionId, lease)) return

      let mode: 'merge' | 'replace' = 'merge'
      const cachedVisible = this.cache.visibleEventCount(this.serverId, sessionId)
      if (auditPage && timelineCacheHasGap(cachedVisible, deltaPage.events.length, auditPage.total, before?.events[0]?.seq)) {
        page = auditPage
        mode = 'replace'
        appLog('timeline', 'repairing incomplete legacy cache', {
          sessionId, cachedVisible, serverVisible: auditPage.total, tailEvents: auditPage.events.length
        })
      } else if ((page.events_omitted_after ?? 0) > 0 || (page.latest_seq ?? cachedLast) < cachedLast) {
        page = await this.client.sessionPage(sessionId, { limit: INITIAL_TAIL_EVENT_LIMIT, tail: true, visible: true })
        if (!this.isCurrentTimeline(sessionId, lease)) return
        mode = 'replace'
      }

      this.cache.putSession(this.serverId, page.session)
      if (mode === 'replace') this.cache.replaceEvents(this.serverId, sessionId, page.events)
      else this.cache.putEvents(this.serverId, sessionId, page.events)
      this.cache.putQueuedTurns(this.serverId, sessionId, page.queued_turns ?? [])
      const hasMoreEvents = mode === 'replace'
        ? Boolean(page.has_more)
        : cachedLast === 0 ? Boolean(page.has_more || auditPage?.has_more) : Boolean(before?.hasMoreEvents || page.has_more || auditPage?.has_more)
      const verifiedLatestSeq = mode === 'replace' ? page.latest_seq : auditPage?.latest_seq
      const knownTotal = mode === 'replace' ? page.total : auditPage?.total
      this.cache.putTimelineState(this.serverId, sessionId, hasMoreEvents, verifiedLatestSeq, knownTotal)
      const snapshot: SessionSnapshot = mode === 'replace' ? (this.cache.snapshot(this.serverId, sessionId) ?? {
        session: page.session,
        events: page.events,
        queuedTurns: page.queued_turns ?? [],
        files: before?.files ?? [],
        hasMoreEvents,
        eventsTotal: knownTotal ?? before?.eventsTotal ?? null,
        filesTotal: before?.filesTotal ?? 0,
        cachedAt: Date.now()
      }) : {
        session: page.session,
        events: page.events,
        queuedTurns: page.queued_turns ?? [],
        files: [],
        hasMoreEvents,
        eventsTotal: before?.eventsTotal ?? auditPage?.total ?? null,
        filesTotal: before?.filesTotal ?? 0,
        cachedAt: Date.now(),
        viewState: before?.viewState
      }
      const changed = page.events.length > 0 || before?.hasMoreEvents !== snapshot.hasMoreEvents || before?.eventsTotal !== snapshot.eventsTotal || !jsonEqual(before?.queuedTurns ?? [], snapshot.queuedTurns) || !jsonEqual(before?.session, snapshot.session)
      if (changed) this.emit('server:timeline', { sessionId, snapshot, source: 'server', mode })
      const streamAfter = page.latest_seq ?? page.events.at(-1)?.seq ?? cachedLast
      this.activateTimelineStream(sessionId, streamAfter, lease)
      queueMicrotask(() => void this.refreshTimelineFiles(sessionId))
    } catch (error) {
      appLog('timeline', 'tail refresh failed; keeping cached transcript', { sessionId, error: errorText(error) })
      if (this.isCurrentTimeline(sessionId, lease)) this.activateTimelineStream(sessionId, cachedLast, lease)
    }
  }

  private async fetchTimeline(sessionId: string, lease: number): Promise<SessionSnapshot> {
    const page = await this.client.sessionPage(sessionId, { limit: INITIAL_TAIL_EVENT_LIMIT, tail: true, visible: true })
    if (!this.isCurrentTimeline(sessionId, lease)) throw new Error('Timeline selection superseded')
    this.cache.putSession(this.serverId, page.session)
    this.cache.replaceEvents(this.serverId, sessionId, page.events)
    this.cache.putQueuedTurns(this.serverId, sessionId, page.queued_turns ?? [])
    this.cache.putTimelineState(this.serverId, sessionId, Boolean(page.has_more), page.latest_seq, page.total)
    const cached = this.cache.snapshot(this.serverId, sessionId)
    if (!this.isCurrentTimeline(sessionId, lease)) throw new Error('Timeline selection superseded')
    this.activateTimelineStream(sessionId, page.latest_seq ?? page.events.at(-1)?.seq ?? 0, lease)
    queueMicrotask(() => void this.refreshTimelineFiles(sessionId, true))
    return cached ? {
      ...cached,
      session: page.session,
      queuedTurns: page.queued_turns ?? [],
      hasMoreEvents: Boolean(page.has_more),
      eventsTotal: page.total ?? cached.eventsTotal ?? null,
      cachedAt: Date.now()
    } : {
      session: page.session,
      events: page.events,
      queuedTurns: page.queued_turns ?? [],
      files: [],
      hasMoreEvents: Boolean(page.has_more),
      eventsTotal: page.total ?? null,
      filesTotal: 0,
      cachedAt: Date.now()
    }
  }

  private async refreshTimelineFiles(sessionId: string, force = false): Promise<void> {
    if (this.filesRefreshInFlight.has(sessionId)) return
    if (!force && Date.now() - (this.filesRefreshedAt.get(sessionId) ?? 0) < 30_000) return
    this.filesRefreshInFlight.add(sessionId)
    try {
      const before = this.cache.files(this.serverId, sessionId, FILE_PAGE_LIMIT)
      const page = await this.client.files(sessionId, 0, FILE_PAGE_LIMIT)
      this.cache.putFiles(this.serverId, sessionId, page.files)
      this.filesRefreshedAt.set(sessionId, Date.now())
      if (!jsonEqual(before, page.files)) this.emit('server:files', { sessionId, files: page.files, total: page.total })
    } catch (error) {
      appLog('files', 'background timeline file refresh failed', { sessionId, error: errorText(error) })
    } finally {
      this.filesRefreshInFlight.delete(sessionId)
    }
  }

  private applyEventToCaches(event: Event): void {
    const queued = this.cache.queuedTurns(this.serverId, event.session_id)
    const nextQueued = updateQueuedTurns(queued, event)
    if (nextQueued !== queued) this.cache.putQueuedTurns(this.serverId, event.session_id, nextQueued)
    if (event.type === 'queue_snapshot' && event.positions && !queued.length) void this.queue(event.session_id)
    if (event.file) this.cache.putFiles(this.serverId, event.session_id, [event.file])
    if (event.artifact) this.cache.putFiles(this.serverId, event.session_id, [event.artifact])
  }

  private isCurrentTimeline(sessionId: string, lease: number): boolean {
    return this.selectedSessionId === sessionId && this.timelineLease === lease
  }

  private enqueueEventCache(event: Event): void {
    const pending = this.pendingEventCache.get(event.session_id) ?? []
    pending.push(event)
    this.pendingEventCache.set(event.session_id, pending)
    if (!this.eventCacheTimer) this.eventCacheTimer = setTimeout(() => this.flushEventCache(), 50)
  }

  private flushEventCache(): void {
    if (this.eventCacheTimer) clearTimeout(this.eventCacheTimer)
    this.eventCacheTimer = null
    const pending = this.pendingEventCache
    this.pendingEventCache = new Map()
    for (const [sessionId, events] of pending) {
      try {
        this.cache.putEvents(this.serverId, sessionId, events)
        for (const event of events) this.applyEventToCaches(event)
      } catch (error) {
        appLog('cache', 'failed to persist streamed events', { sessionId, count: events.length, error: errorText(error) })
      }
    }
  }

  private upsertSession(session: Session): void {
    const index = this.sessions.findIndex(candidate => candidate.id === session.id)
    if (index >= 0) this.sessions = this.sessions.map(candidate => candidate.id === session.id ? session : candidate)
    else this.sessions = [...this.sessions, session]
    this.cache.putSession(this.serverId, session)
    this.emit('server:sessions', this.sessions)
  }

  private emit<K extends keyof AppEventMap>(name: K, payload: AppEventMap[K]): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) window.webContents.send(name, payload)
    }
  }

  private disconnectAllTerminals(): void {
    for (const sessionId of [...this.terminalConnections.keys()]) this.disconnectTerminal(sessionId)
  }

  private async ensureLocalFile(file: AgentFile): Promise<string> {
    const path = this.localFilePath(file)
    if (existsSync(path)) return path
    const key = `${file.id}:${path}`
    const existing = this.fileDownloads.get(key)
    if (existing) return existing
    const download = this.downloadFile(file, path).then(() => path).finally(() => this.fileDownloads.delete(key))
    this.fileDownloads.set(key, download)
    return download
  }

  private localFilePath(file: AgentFile): string {
    return join(app.getPath('temp'), 'AgentsDockFiles', file.id, basename(file.filename))
  }

  private async downloadFile(file: AgentFile, path: string): Promise<void> {
    const response = await this.client.fileRequest(file.id)
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
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

function insertAfter(sessions: Session[], session: Session, parentId: string): Session[] {
  const filtered = sessions.filter(candidate => candidate.id !== session.id)
  const index = filtered.findIndex(candidate => candidate.id === parentId)
  if (index < 0) return [...filtered, session]
  return [...filtered.slice(0, index + 1), session, ...filtered.slice(index + 1)]
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function jsonEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }

function mergeEventsBySequence(...pages: Event[][]): Event[] {
  const byId = new Map<string, Event>()
  for (const event of pages.flat()) byId.set(event.id || `seq:${event.seq}`, event)
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
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
