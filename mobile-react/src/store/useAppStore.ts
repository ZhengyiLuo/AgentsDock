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
  UpdateJobInput,
  UploadRef,
} from '../types'
import { AgentServerClient } from '../api/AgentServerClient'
import { errorMessage, mergeEvents, mergeFiles, normalizeServerURL } from '../lib/format'
import { CHAT_FONT_SCALE_DEFAULT, clampChatFontScale } from '../lib/typography'
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
const STREAM_RECOVERY_DELAY_MS = 2_500
const BACKGROUND_REFRESH_MS = 12_000
let streamStop: (() => void) | null = null
let streamSessionId: string | null = null
let streamGeneration = 0
let selectionEpoch = 0
let refreshTimer: ReturnType<typeof setInterval> | null = null
let recoveryTimer: ReturnType<typeof setTimeout> | null = null
let appStateSubscription: { remove(): void } | null = null
let refreshFailureCount = 0
let syncInFlight: { sessionId: string; epoch: number; promise: Promise<void> } | null = null
let readReceiptTimer: ReturnType<typeof setTimeout> | null = null
let pinSaveQueue: Promise<void> = Promise.resolve()
const notifiedEvents = new Set<string>()

export type ChatSyncStatus = 'idle' | 'cached' | 'syncing' | 'live' | 'reconnecting' | 'offline' | 'error'
type SyncReason = 'selection' | 'manual' | 'foreground' | 'server-ahead' | 'recovery'

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
})

interface AppState {
  initialized: boolean
  connected: boolean
  liveConnected: boolean
  syncSessionId: string | null
  syncStatus: ChatSyncStatus
  syncError: string | null
  lastTimelineSyncAt: number | null
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
  fontScale: number
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
  syncSelectedSession(reason?: SyncReason): Promise<void>
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
  setFontScale(value: number): void
  updateQueued(sessionId: string, queuedId: string, prompt: string): Promise<boolean>
  removeQueued(sessionId: string, queuedId: string): Promise<boolean>
  moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<boolean>
  runQueuedNow(sessionId: string, queuedId: string): Promise<boolean>
  refreshJobs(): Promise<void>
  createJob(input: CreateJobInput): Promise<boolean>
  updateJob(jobId: string, patch: UpdateJobInput): Promise<boolean>
  deleteJob(jobId: string): Promise<void>
  runJob(jobId: string): Promise<void>
  search(query: string, sessionId?: string): Promise<void>
  clearSearch(): void
  pinMessage(sessionId: string, event: Event, body: string): Promise<boolean>
  pinFile(sessionId: string, file: AgentFile): Promise<boolean>
  removePin(id: string): Promise<boolean>
  inspectProcesses(sessionId?: string): Promise<void>
  inspectTmux(sessionId?: string, includeAll?: boolean): Promise<void>
  clearError(): void
}

export const client = new AgentServerClient('http://127.0.0.1:7850')

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  connected: false,
  liveConnected: false,
  syncSessionId: null,
  syncStatus: 'idle',
  syncError: null,
  lastTimelineSyncAt: null,
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
  fontScale: CHAT_FONT_SCALE_DEFAULT,
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
    set({
      initialized: true,
      serverURL,
      token,
      sessions,
      pins,
      selectedSessionId: selected,
      syncSessionId: selected,
      syncStatus: selected ? 'cached' : 'idle',
      folderOrder: settings.folderOrder ?? [],
      fontScale: settings.fontScale,
    })
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
    refreshTimer = setInterval(() => {
      if (get().connected) void get().refreshSessions()
      else void get().reconnect()
    }, BACKGROUND_REFRESH_MS)
    if (!appStateSubscription) {
      appStateSubscription = NativeAppState.addEventListener('change', nextState => {
        if (nextState !== 'active') return
        if (get().connected) {
          void get().refreshSessions()
          void get().syncSelectedSession('foreground')
        } else {
          void get().reconnect()
        }
      })
    }
  },

  async applySettings(rawURL, token) {
    const serverURL = normalizeServerURL(rawURL)
    stopSelectedStream()
    selectionEpoch += 1
    client.configure(serverURL, token)
    await Promise.all([saveToken(token), saveSettings({ serverURL, selectedSessionId: null, folderOrder: [], fontScale: get().fontScale })])
    const [sessions, pins] = await Promise.all([loadCachedSessions(serverURL), loadPins(serverURL)])
    set({
      serverURL,
      token,
      sessions,
      pins,
      selectedSessionId: null,
      snapshots: {},
      jobs: [],
      runtime: null,
      health: null,
      connected: false,
      liveConnected: false,
      syncSessionId: null,
      syncStatus: 'idle',
      syncError: null,
      lastTimelineSyncAt: null,
      folderOrder: [],
    })
    await get().reconnect()
  },

  async reconnect() {
    if (get().connecting) return
    set(state => ({
      connecting: true,
      error: null,
      syncStatus: state.selectedSessionId ? 'syncing' : state.syncStatus,
      syncError: null,
    }))
    try {
      const [health, sessions, runtime, jobs] = await Promise.all([client.health(), client.sessions(), client.runtimeCatalog(), client.jobs()])
      const contract = health.api_contract_version ?? MIN_API_CONTRACT
      if (contract < MIN_API_CONTRACT) throw new Error(`Server upgrade required: app needs API v${MIN_API_CONTRACT}, server reports v${contract}.`)
      const activeSessionIds = healthActiveSessions(health)
      let selected = get().selectedSessionId
      if (!selected || !sessions.some(value => value.id === selected)) selected = sessions.find(value => !value.archived)?.id ?? null
      refreshFailureCount = 0
      set({ connected: true, connecting: false, health, sessions, runtime, jobs, activeSessionIds, selectedSessionId: selected })
      await Promise.all([
        saveCachedSessions(get().serverURL, sessions),
        saveSettings({ serverURL: get().serverURL, selectedSessionId: selected, folderOrder: get().folderOrder, fontScale: get().fontScale }),
      ])
      if (selected) await get().selectSession(selected)
      else {
        stopSelectedStream()
        set({ syncSessionId: null, syncStatus: 'idle', syncError: null, lastTimelineSyncAt: null })
      }
    } catch (error) {
      const message = errorMessage(error)
      set(state => ({
        connected: false,
        connecting: false,
        error: message,
        liveConnected: false,
        syncSessionId: state.selectedSessionId,
        syncStatus: state.selectedSessionId ? 'offline' : 'idle',
        syncError: message,
      }))
    }
  },

  async refreshSessions() {
    if (!get().connected) return
    try {
      const before = new Map(get().sessions.map(value => [value.id, value.latest_agent_event_seq ?? 0]))
      const [sessions, health] = await Promise.all([client.sessions(), client.health()])
      refreshFailureCount = 0
      set(state => ({ connected: true, sessions: mergeSessionState(sessions, state.sessions), health, activeSessionIds: healthActiveSessions(health) }))
      void saveCachedSessions(get().serverURL, sessions)
      void updateBadge(sessions)
      if (NativeAppState.currentState !== 'active') {
        for (const session of sessions) {
          const seq = session.latest_agent_event_seq ?? 0
          if (seq > (before.get(session.id) ?? seq)) void notifyOnce(session, seq)
        }
      }
      const selectedId = get().selectedSessionId
      if (selectedId && NativeAppState.currentState === 'active') {
        const remote = sessions.find(value => value.id === selectedId)
        const localSeq = get().snapshots[selectedId]?.latestSeq ?? 0
        const remoteSeq = remote?.latest_event_seq ?? 0
        if (remoteSeq > localSeq) void get().syncSelectedSession('server-ahead')
        else if (!get().liveConnected || ['reconnecting', 'error', 'offline'].includes(get().syncStatus)) void get().syncSelectedSession('recovery')
      }
    } catch (error) {
      refreshFailureCount += 1
      const message = errorMessage(error)
      set(state => ({
        connected: refreshFailureCount < 2 ? state.connected : false,
        liveConnected: refreshFailureCount < 2 ? state.liveConnected : false,
        syncStatus: state.selectedSessionId
          ? (refreshFailureCount < 2 && state.liveConnected ? 'live' : refreshFailureCount < 2 ? 'reconnecting' : 'offline')
          : state.syncStatus,
        syncError: state.selectedSessionId && !(refreshFailureCount < 2 && state.liveConnected) ? message : state.syncError,
      }))
    }
  },

  async selectSession(sessionId) {
    const epoch = ++selectionEpoch
    stopSelectedStream()
    set({
      selectedSessionId: sessionId,
      error: null,
      liveConnected: false,
      syncSessionId: sessionId,
      syncStatus: get().snapshots[sessionId] ? 'cached' : 'syncing',
      syncError: null,
      loadingSessionId: null,
    })
    void saveSettings({ serverURL: get().serverURL, selectedSessionId: sessionId, folderOrder: get().folderOrder, fontScale: get().fontScale })
    let snapshot: Snapshot | undefined = get().snapshots[sessionId]
    if (!snapshot) {
      snapshot = await loadSnapshot(get().serverURL, sessionId) ?? undefined
      if (snapshot && epoch === selectionEpoch) set(state => ({
        snapshots: { ...state.snapshots, [sessionId]: snapshot! },
        syncStatus: 'cached',
      }))
    }
    if (!snapshot && epoch === selectionEpoch) set({ loadingSessionId: sessionId })
    if (epoch !== selectionEpoch) return
    await get().syncSelectedSession('selection')
  },

  async syncSelectedSession(reason = 'manual') {
    const sessionId = get().selectedSessionId
    if (!sessionId) return
    const epoch = selectionEpoch
    if (!get().connected) {
      set({ syncSessionId: sessionId, syncStatus: 'offline', syncError: 'Server is offline.' })
      return
    }
    if (syncInFlight?.sessionId === sessionId && syncInFlight.epoch === epoch) return syncInFlight.promise

    const promise = (async () => {
      const existingAtStart = get().snapshots[sessionId]
      const fullTail = reason === 'selection' || reason === 'manual' || reason === 'foreground' || !existingAtStart
      const exposeProgress = fullTail || get().syncStatus !== 'live'
      if (exposeProgress) set({ syncSessionId: sessionId, syncStatus: 'syncing', syncError: null })
      try {
        const after = snapshotLatestSeq(existingAtStart)
        let page = await client.sessionPage(sessionId, fullTail
          ? { limit: TAIL_LIMIT, tail: true, visible: true }
          : { after, limit: TAIL_LIMIT, tail: false, visible: true })
        let fetchedFullTail = fullTail
        if (!fullTail && (page.events_omitted_after ?? 0) > 0) {
          page = await client.sessionPage(sessionId, { limit: TAIL_LIMIT, tail: true, visible: true })
          fetchedFullTail = true
        }
        if (epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return

        const current = get().snapshots[sessionId]
        const replaceEvents = shouldReplaceCachedTimeline(current, page.events, page.latest_seq, page.has_more, fetchedFullTail)
        const now = Date.now()
        const mergedEvents = replaceEvents ? page.events : mergeEvents(current?.events ?? [], page.events)
        const next: Snapshot = {
          session: page.session,
          events: mergedEvents,
          queuedTurns: page.queued_turns,
          files: mergeFiles(current?.files ?? [], filesFromEvents(page.events)),
          filesTotal: current?.filesTotal ?? 0,
          hasMore: fetchedFullTail ? page.has_more : current?.hasMore ?? page.has_more,
          total: fetchedFullTail ? page.total : current?.total ?? null,
          latestSeq: mergedEvents.at(-1)?.seq ?? page.latest_seq ?? current?.latestSeq ?? null,
          cachedAt: now,
        }
        set(state => ({
          snapshots: { ...state.snapshots, [sessionId]: next },
          sessions: state.sessions.map(value => value.id === sessionId ? page.session : value),
          loadingSessionId: null,
          syncSessionId: sessionId,
          syncStatus: state.liveConnected && streamSessionId === sessionId ? 'live' : 'syncing',
          syncError: null,
          lastTimelineSyncAt: now,
        }))
        void saveSnapshot(get().serverURL, next)
        if (reason === 'selection' || reason === 'manual' || reason === 'foreground') {
          void get().refreshFiles(sessionId)
          void get().refreshTimelineIndex(sessionId)
        }

        const shouldRestartStream = streamSessionId !== sessionId
          || !streamStop
          || reason === 'selection'
          || reason === 'manual'
          || reason === 'foreground'
          || reason === 'recovery'
        if (shouldRestartStream) startSelectedStream(sessionId, next.latestSeq ?? snapshotLatestSeq(next), epoch, set, get)
        else if (get().liveConnected) set({ syncStatus: 'live' })
        void get().markRead(sessionId)
      } catch (error) {
        if (epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
        const message = errorMessage(error)
        set({
          loadingSessionId: null,
          liveConnected: false,
          syncSessionId: sessionId,
          syncStatus: get().connected ? 'error' : 'offline',
          syncError: message,
        })
        scheduleSelectedRecovery(sessionId, epoch, get, 4_000)
      }
    })()
    const inFlight = { sessionId, epoch, promise }
    syncInFlight = inFlight
    try { await promise }
    finally { if (syncInFlight === inFlight) syncInFlight = null }
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
      if (steer && response.queued_id) return await get().runQueuedNow(sessionId, response.queued_id)
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
      const deletedSelectedSession = get().selectedSessionId === sessionId
      const sessions = get().sessions.filter(value => value.id !== sessionId)
      const next = deletedSelectedSession ? sessions.find(value => !value.archived)?.id ?? null : get().selectedSessionId
      set(state => { const snapshots = { ...state.snapshots }; delete snapshots[sessionId]; return { sessions, snapshots, selectedSessionId: next } })
      if (next) await get().selectSession(next)
      else if (deletedSelectedSession) {
        selectionEpoch += 1
        stopSelectedStream()
        set({ liveConnected: false, syncSessionId: null, syncStatus: 'idle', syncError: null, lastTimelineSyncAt: null })
      }
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
    void saveSettings({ serverURL: get().serverURL, selectedSessionId: get().selectedSessionId, folderOrder: order, fontScale: get().fontScale })
  },
  setFontScale(value) {
    const fontScale = clampChatFontScale(value)
    set({ fontScale })
    void saveSettings({ serverURL: get().serverURL, selectedSessionId: get().selectedSessionId, folderOrder: get().folderOrder, fontScale })
  },

  async updateQueued(sessionId, queuedId, prompt) { return queueAction(sessionId, () => client.updateQueued(sessionId, queuedId, prompt), set, get) },
  async removeQueued(sessionId, queuedId) { return queueAction(sessionId, () => client.removeQueued(sessionId, queuedId), set, get) },
  async moveQueued(sessionId, queuedId, direction) { return queueAction(sessionId, () => client.moveQueued(sessionId, queuedId, direction), set, get) },
  async runQueuedNow(sessionId, queuedId) {
    const before = get().snapshots[sessionId]?.queuedTurns ?? []
    setSnapshotQueue(sessionId, before.filter(value => value.queued_id !== queuedId), set, get)
    try {
      await client.runQueuedNow(sessionId, queuedId)
    } catch (error) {
      const turns = await client.queue(sessionId).catch(() => null)
      if (!turns) {
        setSnapshotQueue(sessionId, before, set, get)
        set({ error: errorMessage(error) })
        return false
      }
      setSnapshotQueue(sessionId, turns, set, get)
      if (turns.some(value => value.queued_id === queuedId)) {
        set({ error: errorMessage(error) })
        return false
      }
    }
    const refreshed = await client.queue(sessionId).catch(() => null)
    if (refreshed) setSnapshotQueue(sessionId, refreshed, set, get)
    set(state => {
      const active = new Set(state.activeSessionIds)
      active.add(sessionId)
      return { activeSessionIds: active }
    })
    return true
  },

  async refreshJobs() { try { set({ jobs: await client.jobs() }) } catch (error) { set({ error: errorMessage(error) }) } },
  async createJob(input) {
    try {
      const job = await client.createJob(input)
      set(state => ({ jobs: [...state.jobs.filter(value => value.id !== job.id), job] }))
      return true
    } catch (error) {
      set({ error: errorMessage(error) })
      return false
    }
  },
  async updateJob(jobId, patch) {
    try {
      const job = await client.updateJob(jobId, patch)
      set(state => ({ jobs: state.jobs.map(value => value.id === jobId ? job : value) }))
      return true
    } catch (error) {
      set({ error: errorMessage(error) })
      return false
    }
  },
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
    return persistPins([pin, ...get().pins.filter(value => value.id !== pin.id)], set, get)
  },
  async pinFile(sessionId, file) {
    const pin: PinnedItem = { id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, createdAt: Date.now() }
    return persistPins([pin, ...get().pins.filter(value => value.id !== pin.id)], set, get)
  },
  async removePin(id) { return persistPins(get().pins.filter(value => value.id !== id), set, get) },
  async inspectProcesses(sessionId = get().selectedSessionId ?? undefined) { if (sessionId) try { const value = await client.processes(sessionId); set(state => ({ processes: { ...state.processes, [sessionId]: value } })) } catch (error) { set({ error: errorMessage(error) }) } },
  async inspectTmux(sessionId = get().selectedSessionId ?? undefined, includeAll = false) { if (sessionId) try { const value = await client.tmux(sessionId, includeAll); set(state => ({ tmuxPanes: { ...state.tmuxPanes, [sessionId]: value } })) } catch (error) { set({ error: errorMessage(error) }) } },
  clearError() { set({ error: null }) },
}))

async function persistPins(
  pins: PinnedItem[],
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<boolean> {
  const previous = get().pins
  const serverURL = get().serverURL
  set({ pins })
  const write = pinSaveQueue.catch(() => undefined).then(() => savePins(serverURL, pins))
  pinSaveQueue = write.catch(() => undefined)
  try {
    await write
    return true
  } catch (error) {
    set(state => ({
      ...(state.pins === pins ? { pins: previous } : {}),
      error: `Could not save pinned items: ${errorMessage(error)}`,
    }))
    return false
  }
}

function applyLiveEvent(event: Event, set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void, get: () => AppState): void {
  const sessionId = event.session_id
  set(state => {
    const snapshot = state.snapshots[sessionId]
    const active = new Set(state.activeSessionIds)
    const agentActivity = isAgentActivityEvent(event)
    if (event.type === 'turn_started' || event.type === 'process_started') active.add(sessionId)
    if (['turn_finished', 'turn_stopped', 'error'].includes(event.type)) active.delete(sessionId)
    const sessions = state.sessions.map(session => session.id === sessionId ? {
      ...session,
      latest_event_seq: Math.max(session.latest_event_seq ?? 0, event.seq),
      latest_event_at: event.ts,
      latest_event_type: event.type,
      ...(agentActivity ? {
        latest_agent_event_seq: Math.max(session.latest_agent_event_seq ?? 0, event.seq),
        latest_agent_event_at: event.ts,
        latest_agent_event_type: event.type,
      } : {}),
    } : session)
    const selectedSync = state.selectedSessionId === sessionId ? {
      syncSessionId: sessionId,
      syncStatus: 'live' as const,
      syncError: null,
      liveConnected: true,
      lastTimelineSyncAt: Date.now(),
    } : {}
    if (!snapshot) return { activeSessionIds: active, sessions, ...selectedSync }
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
    return { snapshots: { ...state.snapshots, [sessionId]: next }, activeSessionIds: active, sessions, ...selectedSync }
  })
  if (['turn_finished', 'artifact_created', 'file_uploaded'].includes(event.type)) void get().refreshSessions()
  if (event.type.startsWith('job_')) void get().refreshJobs()
  if (
    NativeAppState.currentState === 'active'
    && get().selectedSessionId === sessionId
    && isAgentActivityEvent(event)
  ) scheduleReadReceipt(sessionId, get)
  if (NativeAppState.currentState !== 'active' && isAgentActivityEvent(event)) {
    const session = get().sessions.find(value => value.id === sessionId)
    if (session) void notifyOnce(session, event.seq)
  }
}

function isAgentActivityEvent(event: Event): boolean {
  return ['assistant_text', 'turn_finished', 'artifact_created', 'file_uploaded', 'job_finished', 'job_error'].includes(event.type)
}

function scheduleReadReceipt(sessionId: string, get: () => AppState): void {
  if (readReceiptTimer) clearTimeout(readReceiptTimer)
  readReceiptTimer = setTimeout(() => {
    readReceiptTimer = null
    if (NativeAppState.currentState === 'active' && get().selectedSessionId === sessionId) void get().markRead(sessionId)
  }, 600)
}

function stopSelectedStream(): void {
  streamGeneration += 1
  if (recoveryTimer) clearTimeout(recoveryTimer)
  recoveryTimer = null
  const stop = streamStop
  streamStop = null
  streamSessionId = null
  stop?.()
}

function startSelectedStream(
  sessionId: string,
  after: number,
  epoch: number,
  set: (value: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  stopSelectedStream()
  const generation = ++streamGeneration
  streamSessionId = sessionId
  set({ liveConnected: false, syncSessionId: sessionId, syncStatus: 'syncing', syncError: null })
  streamStop = client.stream(
    sessionId,
    after,
    event => {
      if (generation !== streamGeneration || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
      applyLiveEvent(event, set, get)
    },
    connected => {
      if (generation !== streamGeneration || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
      if (connected) {
        if (recoveryTimer) clearTimeout(recoveryTimer)
        recoveryTimer = null
        set({
          liveConnected: true,
          syncSessionId: sessionId,
          syncStatus: 'live',
          syncError: null,
          lastTimelineSyncAt: Date.now(),
        })
      } else {
        set({ liveConnected: false, syncSessionId: sessionId, syncStatus: 'reconnecting' })
        scheduleSelectedRecovery(sessionId, epoch, get)
      }
    },
  )
}

function scheduleSelectedRecovery(sessionId: string, epoch: number, get: () => AppState, delay = STREAM_RECOVERY_DELAY_MS): void {
  if (recoveryTimer) clearTimeout(recoveryTimer)
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null
    if (NativeAppState.currentState !== 'active' || epoch !== selectionEpoch || get().selectedSessionId !== sessionId) return
    void get().syncSelectedSession('recovery')
  }, delay)
}

function snapshotLatestSeq(snapshot?: Snapshot): number {
  let latest = snapshot?.latestSeq ?? 0
  for (const event of snapshot?.events ?? []) latest = Math.max(latest, event.seq)
  return latest
}

function shouldReplaceCachedTimeline(
  current: Snapshot | undefined,
  incoming: Event[],
  latestSeq: number | null | undefined,
  hasMore: boolean,
  fullTail: boolean,
): boolean {
  if (!current?.events.length || !fullTail) return false
  const currentLatest = snapshotLatestSeq(current)
  if (latestSeq != null && latestSeq < currentLatest) return true
  if (!hasMore || !incoming.length) return false
  const currentSeqs = new Set(current.events.map(event => event.seq))
  const overlaps = incoming.some(event => currentSeqs.has(event.seq))
  return !overlaps && currentLatest < incoming[0].seq
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

async function queueAction(sessionId: string, action: () => Promise<void>, set: (value: Partial<AppState>) => void, get: () => AppState): Promise<boolean> {
  try {
    await action()
    setSnapshotQueue(sessionId, await client.queue(sessionId), set, get)
    return true
  } catch (error) {
    const refreshed = await client.queue(sessionId).catch(() => null)
    if (refreshed) setSnapshotQueue(sessionId, refreshed, set, get)
    set({ error: errorMessage(error) })
    return false
  }
}

function setSnapshotQueue(sessionId: string, queuedTurns: QueuedTurn[], set: (value: Partial<AppState>) => void, get: () => AppState): void {
  const snapshot = get().snapshots[sessionId]
  if (!snapshot) return
  const next = { ...snapshot, queuedTurns, cachedAt: Date.now() }
  set({ snapshots: { ...get().snapshots, [sessionId]: next } })
  void saveSnapshot(get().serverURL, next)
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
