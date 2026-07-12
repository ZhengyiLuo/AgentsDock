import { create } from 'zustand'
import { AppState as NativeAppState } from 'react-native'
import * as Notifications from 'expo-notifications'
import type {
  AgentFile,
  CreateJobInput,
  CreateSessionInput,
  Event,
  Health,
  Job,
  PinnedItem,
  ProcessSnapshot,
  QueuedTurn,
  RuntimeCatalog,
  Session,
  Snapshot,
  TimelineIndex,
  TimelineSearchResult,
  TmuxPane,
  UploadRef,
} from '../types'
import { AgentServerClient } from '../api/AgentServerClient'
import { errorMessage, mergeEvents, mergeFiles, normalizeServerURL } from '../lib/format'
import {
  loadCachedSessions,
  loadPins,
  loadSettings,
  loadSnapshot,
  loadToken,
  removeSnapshot,
  saveCachedSessions,
  savePins,
  saveSettings,
  saveSnapshot,
  saveToken,
} from '../storage/cache'

const MIN_API_CONTRACT = 6
const TAIL_LIMIT = 240
const OLDER_LIMIT = 180
let streamStop: (() => void) | null = null
let selectionEpoch = 0
let refreshTimer: ReturnType<typeof setInterval> | null = null
const notifiedEvents = new Set<string>()

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
})

interface AppState {
  initialized: boolean
  connected: boolean
  liveConnected: boolean
  connecting: boolean
  error: string | null
  serverURL: string
  token: string
  health: Health | null
  runtime: RuntimeCatalog | null
  sessions: Session[]
  selectedSessionId: string | null
  snapshots: Record<string, Snapshot>
  loadingSessionId: string | null
  loadingOlder: boolean
  activeSessionIds: Set<string>
  jobs: Job[]
  drafts: Record<string, string>
  uploads: Record<string, AgentFile[]>
  uploadPending: Record<string, UploadRef[]>
  pins: PinnedItem[]
  folderOrder: string[]
  searchResults: TimelineSearchResult[]
  searchBusy: boolean
  timelineIndex: Record<string, TimelineIndex>
  processes: Record<string, ProcessSnapshot>
  tmuxPanes: Record<string, TmuxPane[]>

  initialize(): Promise<void>
  applySettings(serverURL: string, token: string): Promise<void>
  reconnect(): Promise<void>
  refreshSessions(): Promise<void>
  selectSession(sessionId: string): Promise<void>
  loadOlder(sessionId?: string): Promise<number>
  refreshFiles(sessionId?: string, append?: boolean): Promise<void>
  refreshTimelineIndex(sessionId?: string): Promise<void>
  setDraft(text: string): void
  sendPrompt(steer?: boolean): Promise<boolean>
  stopTurn(): Promise<void>
  attachFiles(files: UploadRef[]): Promise<void>
  removeUpload(fileId: string): void
  updateSession(sessionId: string, patch: Partial<Pick<Session, 'title' | 'folder' | 'cwd' | 'backend' | 'model' | 'effort' | 'pinned' | 'archived'>>): Promise<void>
  createSession(input: CreateSessionInput): Promise<void>
  forkSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after'): Promise<void>
  markRead(sessionId: string): Promise<void>
  markUnread(sessionId: string): Promise<void>
  setFolderOrder(order: string[]): void
  updateQueued(queuedId: string, prompt: string): Promise<void>
  removeQueued(queuedId: string): Promise<void>
  moveQueued(queuedId: string, direction: 'up' | 'down'): Promise<void>
  runQueuedNow(queuedId: string): Promise<void>
  refreshJobs(): Promise<void>
  createJob(input: CreateJobInput): Promise<void>
  updateJob(jobId: string, patch: Partial<Job>): Promise<void>
  deleteJob(jobId: string): Promise<void>
  runJob(jobId: string): Promise<void>
  search(query: string, sessionId?: string): Promise<void>
  clearSearch(): void
  pinMessage(sessionId: string, event: Event, body: string): Promise<void>
  pinFile(sessionId: string, file: AgentFile): Promise<void>
  removePin(id: string): Promise<void>
  inspectProcesses(sessionId?: string): Promise<void>
  inspectTmux(sessionId?: string, includeAll?: boolean): Promise<void>
  clearError(): void
}

export const client = new AgentServerClient('http://127.0.0.1:7850')

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  connected: false,
  liveConnected: false,
  connecting: false,
  error: null,
  serverURL: 'http://127.0.0.1:7850',
  token: '',
  health: null,
  runtime: null,
  sessions: [],
  selectedSessionId: null,
  snapshots: {},
  loadingSessionId: null,
  loadingOlder: false,
  activeSessionIds: new Set(),
  jobs: [],
  drafts: {},
  uploads: {},
  uploadPending: {},
  pins: [],
  folderOrder: [],
  searchResults: [],
  searchBusy: false,
  timelineIndex: {},
  processes: {},
  tmuxPanes: {},

  async initialize() {
    if (get().initialized) return
    const [settings, token] = await Promise.all([loadSettings(), loadToken()])
    const serverURL = normalizeServerURL(settings.serverURL)
    client.configure(serverURL, token)
    const [sessions, pins] = await Promise.all([loadCachedSessions(serverURL), loadPins(serverURL)])
    const selected = settings.selectedSessionId && sessions.some(value => value.id === settings.selectedSessionId)
      ? settings.selectedSessionId
      : sessions.find(value => !value.archived)?.id ?? null
    set({ initialized: true, serverURL, token, sessions, pins, selectedSessionId: selected, folderOrder: settings.folderOrder ?? [] })
    if (selected) {
      const cached = await loadSnapshot(serverURL, selected)
      if (cached) set(state => ({ snapshots: { ...state.snapshots, [selected]: cached } }))
    }
    await get().reconnect()
    if (get().connected) {
      void Notifications.requestPermissionsAsync().catch(() => { /* unavailable in unsigned simulator builds */ })
      void updateBadge(get().sessions)
    }
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(() => { void get().refreshSessions() }, 12_000)
  },

  async applySettings(rawURL, token) {
    const serverURL = normalizeServerURL(rawURL)
    streamStop?.(); streamStop = null
    client.configure(serverURL, token)
    await Promise.all([saveToken(token), saveSettings({ serverURL, selectedSessionId: null, folderOrder: [] })])
    const [sessions, pins] = await Promise.all([loadCachedSessions(serverURL), loadPins(serverURL)])
    set({ serverURL, token, sessions, pins, selectedSessionId: null, snapshots: {}, jobs: [], runtime: null, health: null, connected: false, liveConnected: false, folderOrder: [] })
    await get().reconnect()
  },

  async reconnect() {
    if (get().connecting) return
    set({ connecting: true, error: null })
    try {
      const [health, sessions, runtime, jobs] = await Promise.all([client.health(), client.sessions(), client.runtimeCatalog(), client.jobs()])
      const contract = health.api_contract_version ?? MIN_API_CONTRACT
      if (contract < MIN_API_CONTRACT) throw new Error(`Server upgrade required: app needs API v${MIN_API_CONTRACT}, server reports v${contract}.`)
      const activeSessionIds = healthActiveSessions(health)
      let selected = get().selectedSessionId
      if (!selected || !sessions.some(value => value.id === selected)) selected = sessions.find(value => !value.archived)?.id ?? null
      set({ connected: true, connecting: false, health, sessions, runtime, jobs, activeSessionIds, selectedSessionId: selected })
      await Promise.all([
        saveCachedSessions(get().serverURL, sessions),
        saveSettings({ serverURL: get().serverURL, selectedSessionId: selected, folderOrder: get().folderOrder }),
      ])
      if (selected) await get().selectSession(selected)
    } catch (error) {
      set({ connected: false, connecting: false, error: errorMessage(error) })
    }
  },

  async refreshSessions() {
    if (!get().connected) return
    try {
      const before = new Map(get().sessions.map(value => [value.id, value.latest_agent_event_seq ?? 0]))
      const [sessions, health] = await Promise.all([client.sessions(), client.health()])
      set(state => ({ sessions: mergeSessionState(sessions, state.sessions), health, activeSessionIds: healthActiveSessions(health) }))
      void saveCachedSessions(get().serverURL, sessions)
      void updateBadge(sessions)
      if (NativeAppState.currentState !== 'active') {
        for (const session of sessions) {
          const seq = session.latest_agent_event_seq ?? 0
          if (seq > (before.get(session.id) ?? seq)) void notifyOnce(session, seq)
        }
      }
    } catch { /* background refresh never interrupts typing */ }
  },

  async selectSession(sessionId) {
    const epoch = ++selectionEpoch
    streamStop?.(); streamStop = null
    set({ selectedSessionId: sessionId, error: null })
    void saveSettings({ serverURL: get().serverURL, selectedSessionId: sessionId, folderOrder: get().folderOrder })
    let snapshot: Snapshot | undefined = get().snapshots[sessionId]
    if (!snapshot) {
      snapshot = await loadSnapshot(get().serverURL, sessionId) ?? undefined
      if (snapshot && epoch === selectionEpoch) set(state => ({ snapshots: { ...state.snapshots, [sessionId]: snapshot! } }))
    }
    if (!snapshot && epoch === selectionEpoch) set({ loadingSessionId: sessionId })
    try {
      const page = await client.sessionPage(sessionId, { limit: TAIL_LIMIT, tail: true, visible: true })
      if (epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
      const current = get().snapshots[sessionId]
      const next: Snapshot = {
        session: page.session,
        events: mergeEvents(current?.events ?? [], page.events),
        queuedTurns: page.queued_turns,
        files: mergeFiles(current?.files ?? [], filesFromEvents(page.events)),
        filesTotal: current?.filesTotal ?? 0,
        hasMore: page.has_more,
        total: page.total,
        latestSeq: page.latest_seq,
        cachedAt: Date.now(),
      }
      set(state => ({
        snapshots: { ...state.snapshots, [sessionId]: next },
        sessions: state.sessions.map(value => value.id === sessionId ? page.session : value),
        loadingSessionId: null,
      }))
      void saveSnapshot(get().serverURL, next)
      void get().refreshFiles(sessionId)
      void get().refreshTimelineIndex(sessionId)
      streamStop = client.stream(sessionId, next.events.at(-1)?.seq ?? 0, event => applyLiveEvent(event, set, get), connected => set({ liveConnected: connected }))
      void get().markRead(sessionId)
    } catch (error) {
      if (epoch === selectionEpoch) set({ loadingSessionId: null, error: errorMessage(error) })
    }
  },

  async loadOlder(sessionId = get().selectedSessionId ?? undefined) {
    if (!sessionId || get().loadingOlder) return 0
    const snapshot = get().snapshots[sessionId]
    if (!snapshot?.hasMore || !snapshot.events.length) return 0
    set({ loadingOlder: true })
    try {
      const page = await client.sessionPage(sessionId, { before: snapshot.events[0].seq, limit: OLDER_LIMIT, tail: false, visible: true })
      const latest = get().snapshots[sessionId]
      if (!latest) return 0
      const next: Snapshot = {
        ...latest,
        session: page.session,
        events: mergeEvents(page.events, latest.events),
        queuedTurns: page.queued_turns.length ? page.queued_turns : latest.queuedTurns,
        files: mergeFiles(latest.files, filesFromEvents(page.events)),
        hasMore: page.has_more,
        total: page.total ?? latest.total,
        cachedAt: Date.now(),
      }
      set(state => ({ snapshots: { ...state.snapshots, [sessionId]: next } }))
      void saveSnapshot(get().serverURL, next)
      return page.events.length
    } catch (error) { set({ error: errorMessage(error) }); return 0 }
    finally { set({ loadingOlder: false }) }
  },

  async refreshFiles(sessionId = get().selectedSessionId ?? undefined, append = false) {
    if (!sessionId) return
    const snapshot = get().snapshots[sessionId]
    const offset = append ? snapshot?.files.length ?? 0 : 0
    try {
      const page = await client.files(sessionId, offset, 60)
      set(state => {
        const current = state.snapshots[sessionId]
        if (!current) return state
        return { snapshots: { ...state.snapshots, [sessionId]: { ...current, files: append ? mergeFiles(current.files, page.files) : mergeFiles(filesFromEvents(current.events), page.files), filesTotal: page.total } } }
      })
    } catch { /* media metadata is non-blocking */ }
  },

  async refreshTimelineIndex(sessionId = get().selectedSessionId ?? undefined) {
    if (!sessionId) return
    try {
      const index = await client.timelineIndex(sessionId)
      set(state => ({ timelineIndex: { ...state.timelineIndex, [sessionId]: index } }))
    } catch { /* navigator is optional */ }
  },

  setDraft(text) {
    const id = get().selectedSessionId
    if (id) set(state => ({ drafts: { ...state.drafts, [id]: text } }))
  },

  async sendPrompt(steer = false) {
    const sessionId = get().selectedSessionId
    if (!sessionId) return false
    const prompt = (get().drafts[sessionId] ?? '').trim()
    if (!prompt) return false
    const session = get().sessions.find(value => value.id === sessionId)
    const files = get().uploads[sessionId] ?? []
    set(state => ({ drafts: { ...state.drafts, [sessionId]: '' }, uploads: { ...state.uploads, [sessionId]: [] } }))
    try {
      const response = await client.sendTurn(sessionId, prompt, files.map(file => file.id), session?.model, session?.effort)
      set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? response.session : value) }))
      if (response.event) applyLiveEvent(response.event, set, get)
      if (steer && response.queued_id) await client.runQueuedNow(sessionId, response.queued_id)
      return true
    } catch (error) {
      set(state => ({ drafts: { ...state.drafts, [sessionId]: prompt }, uploads: { ...state.uploads, [sessionId]: files }, error: errorMessage(error) }))
      return false
    }
  },

  async stopTurn() {
    const id = get().selectedSessionId
    if (!id) return
    try {
      await client.stopTurn(id)
      set(state => { const active = new Set(state.activeSessionIds); active.delete(id); return { activeSessionIds: active } })
    } catch (error) { set({ error: errorMessage(error) }) }
  },

  async attachFiles(files) {
    const id = get().selectedSessionId
    if (!id || !files.length) return
    set(state => ({ uploadPending: { ...state.uploadPending, [id]: [...(state.uploadPending[id] ?? []), ...files] } }))
    for (const file of files) {
      try {
        const uploaded = await client.upload(id, file)
        set(state => ({ uploads: { ...state.uploads, [id]: mergeFiles(state.uploads[id] ?? [], [uploaded]) } }))
      } catch (error) { set({ error: errorMessage(error) }) }
      finally { set(state => ({ uploadPending: { ...state.uploadPending, [id]: (state.uploadPending[id] ?? []).filter(value => value.uri !== file.uri) } })) }
    }
  },
  removeUpload(fileId) {
    const id = get().selectedSessionId
    if (id) set(state => ({ uploads: { ...state.uploads, [id]: (state.uploads[id] ?? []).filter(value => value.id !== fileId) } }))
  },

  async updateSession(sessionId, patch) {
    const before = get().sessions.find(value => value.id === sessionId)
    set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? { ...value, ...patch } : value) }))
    try {
      const updated = await client.updateSession(sessionId, patch)
      set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? updated : value) }))
    } catch (error) {
      if (before) set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? before : value), error: errorMessage(error) }))
    }
  },
  async createSession(input) {
    try {
      const session = await client.createSession(input)
      set(state => ({ sessions: [...state.sessions, session] }))
      await get().selectSession(session.id)
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async forkSession(sessionId) {
    try {
      const response = await client.forkSession(sessionId)
      const originalIndex = get().sessions.findIndex(value => value.id === sessionId)
      set(state => {
        const sessions = response.sessions ?? [...state.sessions]
        if (response.sessions) return { sessions }
        sessions.splice(Math.max(0, originalIndex + 1), 0, response.session)
        return { sessions }
      })
      await get().selectSession(response.session.id)
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async deleteSession(sessionId) {
    try {
      await client.deleteSession(sessionId)
      await removeSnapshot(get().serverURL, sessionId)
      const sessions = get().sessions.filter(value => value.id !== sessionId)
      const next = get().selectedSessionId === sessionId ? sessions.find(value => !value.archived)?.id ?? null : get().selectedSessionId
      set(state => { const snapshots = { ...state.snapshots }; delete snapshots[sessionId]; return { sessions, snapshots, selectedSessionId: next } })
      if (next) await get().selectSession(next)
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async reorderSession(sessionId, targetId, placement) {
    try { set({ sessions: await client.reorderSession(sessionId, targetId, placement) }) }
    catch (error) { set({ error: errorMessage(error) }) }
  },
  async markRead(sessionId) {
    const session = get().sessions.find(value => value.id === sessionId)
    if (!session) return
    const seq = session.latest_agent_event_seq ?? get().snapshots[sessionId]?.latestSeq ?? 0
    set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? { ...value, manual_unread: false, last_read_agent_event_seq: seq } : value) }))
    void updateBadge(get().sessions)
    try {
      const updated = await client.markRead(sessionId, seq)
      set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? updated : value) }))
    } catch { /* optimistic read marker remains local until refresh */ }
  },
  async markUnread(sessionId) {
    set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? { ...value, manual_unread: true } : value) }))
    void updateBadge(get().sessions)
    try {
      const updated = await client.markUnread(sessionId)
      set(state => ({ sessions: state.sessions.map(value => value.id === sessionId ? updated : value) }))
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  setFolderOrder(order) {
    set({ folderOrder: order })
    void saveSettings({ serverURL: get().serverURL, selectedSessionId: get().selectedSessionId, folderOrder: order })
  },

  async updateQueued(queuedId, prompt) { await queueAction(async id => client.updateQueued(id, queuedId, prompt), set, get) },
  async removeQueued(queuedId) { await queueAction(async id => client.removeQueued(id, queuedId), set, get) },
  async moveQueued(queuedId, direction) { await queueAction(async id => client.moveQueued(id, queuedId, direction), set, get) },
  async runQueuedNow(queuedId) { await queueAction(async id => client.runQueuedNow(id, queuedId), set, get) },

  async refreshJobs() { try { set({ jobs: await client.jobs() }) } catch (error) { set({ error: errorMessage(error) }) } },
  async createJob(input) { try { const job = await client.createJob(input); set(state => ({ jobs: [...state.jobs, job] })) } catch (error) { set({ error: errorMessage(error) }) } },
  async updateJob(jobId, patch) { try { const job = await client.updateJob(jobId, patch); set(state => ({ jobs: state.jobs.map(value => value.id === jobId ? job : value) })) } catch (error) { set({ error: errorMessage(error) }) } },
  async deleteJob(jobId) { try { await client.deleteJob(jobId); set(state => ({ jobs: state.jobs.filter(value => value.id !== jobId) })) } catch (error) { set({ error: errorMessage(error) }) } },
  async runJob(jobId) { try { await client.runJob(jobId); await get().refreshJobs() } catch (error) { set({ error: errorMessage(error) }) } },

  async search(query, sessionId) {
    const clean = query.trim()
    if (!clean) { set({ searchResults: [], searchBusy: false }); return }
    set({ searchBusy: true })
    try {
      const results = sessionId ? await client.searchTimeline(sessionId, clean) : await client.searchSessions(clean)
      set({ searchResults: results, searchBusy: false })
    } catch (error) { set({ searchBusy: false, error: errorMessage(error) }) }
  },
  clearSearch() { set({ searchResults: [], searchBusy: false }) },

  async pinMessage(sessionId, event, body) {
    const pin: PinnedItem = { id: `message:${event.id}`, sessionId, kind: 'message', eventId: event.id, title: body.split('\n')[0].slice(0, 80) || 'Message', body, createdAt: Date.now() }
    const pins = [pin, ...get().pins.filter(value => value.id !== pin.id)]
    set({ pins }); await savePins(get().serverURL, pins)
  },
  async pinFile(sessionId, file) {
    const pin: PinnedItem = { id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, createdAt: Date.now() }
    const pins = [pin, ...get().pins.filter(value => value.id !== pin.id)]
    set({ pins }); await savePins(get().serverURL, pins)
  },
  async removePin(id) { const pins = get().pins.filter(value => value.id !== id); set({ pins }); await savePins(get().serverURL, pins) },
  async inspectProcesses(sessionId = get().selectedSessionId ?? undefined) { if (sessionId) try { const value = await client.processes(sessionId); set(state => ({ processes: { ...state.processes, [sessionId]: value } })) } catch (error) { set({ error: errorMessage(error) }) } },
  async inspectTmux(sessionId = get().selectedSessionId ?? undefined, includeAll = false) { if (sessionId) try { const value = await client.tmux(sessionId, includeAll); set(state => ({ tmuxPanes: { ...state.tmuxPanes, [sessionId]: value } })) } catch (error) { set({ error: errorMessage(error) }) } },
  clearError() { set({ error: null }) },
}))

function applyLiveEvent(event: Event, set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void, get: () => AppState): void {
  const sessionId = event.session_id
  set(state => {
    const snapshot = state.snapshots[sessionId]
    const active = new Set(state.activeSessionIds)
    if (event.type === 'turn_started' || event.type === 'process_started') active.add(sessionId)
    if (['turn_finished', 'turn_stopped', 'error'].includes(event.type)) active.delete(sessionId)
    if (!snapshot) return { activeSessionIds: active }
    const queuedTurns = reduceQueue(snapshot.queuedTurns, event)
    const next: Snapshot = {
      ...snapshot,
      events: mergeEvents(snapshot.events, [event]),
      files: mergeFiles(snapshot.files, filesFromEvents([event])),
      queuedTurns,
      latestSeq: Math.max(snapshot.latestSeq ?? 0, event.seq),
      cachedAt: Date.now(),
    }
    void saveSnapshot(get().serverURL, next)
    return { snapshots: { ...state.snapshots, [sessionId]: next }, activeSessionIds: active }
  })
  if (['assistant_text', 'turn_finished', 'artifact_created', 'file_uploaded'].includes(event.type)) void get().refreshSessions()
  if (event.type.startsWith('job_')) void get().refreshJobs()
  if (NativeAppState.currentState !== 'active' && ['assistant_text', 'turn_finished', 'artifact_created', 'file_uploaded', 'job_finished', 'job_error'].includes(event.type)) {
    const session = get().sessions.find(value => value.id === sessionId)
    if (session) void notifyOnce(session, event.seq)
  }
}

function reduceQueue(current: QueuedTurn[], event: Event): QueuedTurn[] {
  if (event.type === 'turn_queued' && event.queued_id) {
    const turn: QueuedTurn = { queued_id: event.queued_id, session_id: event.session_id, prompt: event.prompt ?? '', file_ids: event.file_ids ?? [], backend: event.backend, position: event.position }
    return [...current.filter(value => value.queued_id !== turn.queued_id), turn].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  }
  if (event.type === 'turn_unqueued' && event.queued_id) return current.filter(value => value.queued_id !== event.queued_id)
  if (event.type === 'queue_snapshot' && event.positions) {
    const positions = new Map(event.positions.map(value => [value.queued_id, value.position]))
    return current.map(value => ({ ...value, position: positions.get(value.queued_id) ?? value.position })).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  }
  return current
}

async function queueAction(action: (sessionId: string) => Promise<void>, set: (value: Partial<AppState>) => void, get: () => AppState): Promise<void> {
  const id = get().selectedSessionId
  if (!id) return
  try {
    await action(id)
    const page = await client.sessionPage(id, { limit: 1, tail: true })
    const snapshot = get().snapshots[id]
    if (snapshot) set({ snapshots: { ...get().snapshots, [id]: { ...snapshot, queuedTurns: page.queued_turns } } })
  } catch (error) { set({ error: errorMessage(error) }) }
}

function healthActiveSessions(health: Health): Set<string> {
  return new Set([...(health.active_sessions ?? []), ...(health.active ?? [])].map(String))
}

function filesFromEvents(events: Event[]): AgentFile[] {
  return events.flatMap(event => [event.file, event.artifact].filter((value): value is AgentFile => Boolean(value)))
}

function mergeSessionState(incoming: Session[], current: Session[]): Session[] {
  const currentById = new Map(current.map(value => [value.id, value]))
  return incoming.map(value => ({ ...currentById.get(value.id), ...value }))
}

async function updateBadge(sessions: Session[]): Promise<void> {
  const count = sessions.filter(value => value.manual_unread || (value.latest_agent_event_seq ?? 0) > (value.last_read_agent_event_seq ?? 0)).length
  try { await Notifications.setBadgeCountAsync(count) } catch { /* badges are best effort */ }
}

async function notifyOnce(session: Session, seq: number): Promise<void> {
  const key = `${session.id}:${seq}`
  if (notifiedEvents.has(key)) return
  notifiedEvents.add(key)
  if (notifiedEvents.size > 200) notifiedEvents.delete(notifiedEvents.values().next().value ?? '')
  try {
    await Notifications.scheduleNotificationAsync({ content: { title: session.title, body: 'New agent message', data: { sessionId: session.id } }, trigger: null })
  } catch { /* permissions can be denied */ }
}
