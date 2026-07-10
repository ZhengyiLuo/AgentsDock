import type {
  AgentFile,
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
  TimelineIndex,
  TimelinePage,
  TimelineSearchResult,
  TmuxPane,
  UpdateSessionInput,
  UpdateJobInput,
  ViewState
} from './types'

export interface AgentsDockAPI {
  bootstrap(): Promise<BootstrapPayload>
  settings: {
    get(): Promise<PublicServerSettings>
    apply(settings: ServerSettings): Promise<Health>
  }
  sessions: {
    list(): Promise<Session[]>
    create(input: CreateSessionInput): Promise<Session>
    resume(input: ResumeSessionInput): Promise<Session>
    update(sessionId: string, patch: UpdateSessionInput): Promise<Session>
    remove(sessionId: string): Promise<boolean>
    fork(sessionId: string): Promise<Session>
    reorder(sessionId: string, relativeTo: string, placement: 'before' | 'after'): Promise<Session[]>
    markRead(sessionId: string, seq?: number | null): Promise<Session>
    markUnread(sessionId: string): Promise<Session>
    importHistory(sessionId: string, force?: boolean): Promise<TimelinePage>
  }
  timeline: {
    cached(sessionId: string): Promise<SessionSnapshot | null>
    open(sessionId: string): Promise<SessionSnapshot>
    older(sessionId: string, before: number, limit?: number): Promise<TimelinePage>
    around(sessionId: string, anchorSeq: number, limit?: number): Promise<TimelinePage>
    index(sessionId: string): Promise<TimelineIndex>
    search(sessionId: string, query: string, limit?: number): Promise<TimelineSearchResult[]>
    subscribe(sessionId: string, after: number): Promise<void>
    unsubscribe(sessionId: string): Promise<void>
    saveViewState(state: ViewState): Promise<void>
    getViewState(sessionId: string): Promise<ViewState | null>
  }
  turns: {
    send(input: SendTurnInput): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }>
    stop(sessionId: string): Promise<boolean>
  }
  queue: {
    list(sessionId: string): Promise<QueuedTurn[]>
    update(sessionId: string, queuedId: string, prompt: string): Promise<boolean>
    remove(sessionId: string, queuedId: string): Promise<boolean>
    move(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<QueuedTurn[]>
    runNow(sessionId: string, queuedId: string): Promise<boolean>
  }
  jobs: {
    list(): Promise<Job[]>
    create(input: CreateJobInput): Promise<Job>
    update(jobId: string, patch: UpdateJobInput): Promise<Job>
    remove(jobId: string): Promise<boolean>
    run(jobId: string): Promise<boolean>
  }
  files: {
    choose(): Promise<NativeFileRef[]>
    pathForFile(file: File): string
    stageClipboardImage(data: ArrayBuffer, name: string, type: string): Promise<NativeFileRef>
    upload(sessionId: string, paths: string[]): Promise<AgentFile[]>
    list(sessionId: string, offset?: number, limit?: number, contentPrefix?: string): Promise<FilesPage>
    findEvent(sessionId: string, fileId: string): Promise<Event | null>
    save(file: AgentFile): Promise<string | null>
    open(file: AgentFile): Promise<void>
    openLinked(sessionId: string, target: string): Promise<void>
    reveal(file: AgentFile): Promise<void>
    beginDrag(file: AgentFile): void
    mediaURL(fileId: string): string
  }
  digest: {
    preview(input: DigestInput): Promise<string>
    send(input: DigestInput): Promise<boolean>
  }
  runtime: {
    catalog(): Promise<RuntimeCatalog>
  }
  processes: {
    list(sessionId: string): Promise<ProcessSnapshot>
    tail(sessionId: string, path: string, lines?: number): Promise<string>
  }
  tmux: {
    list(sessionId: string, includeAll?: boolean): Promise<TmuxPane[]>
    capture(sessionId: string, paneId: string, lines?: number): Promise<string>
  }
  pins: {
    list(sessionId: string): Promise<PinnedItem[]>
    put(item: PinnedItem): Promise<PinnedItem[]>
    remove(sessionId: string, itemId: string): Promise<PinnedItem[]>
  }
  preferences: {
    get<T>(key: string, fallback: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
  }
  native: {
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    setBadge(count: number): Promise<void>
    notify(title: string, body: string, sessionId?: string): Promise<void>
    log(scope: string, message: string, data?: unknown): Promise<void>
  }
  events: {
    on<K extends keyof import('./types').AppEventMap>(name: K, listener: (payload: import('./types').AppEventMap[K]) => void): () => void
  }
}

declare global {
  interface Window {
    agentsDock: AgentsDockAPI
  }
}
