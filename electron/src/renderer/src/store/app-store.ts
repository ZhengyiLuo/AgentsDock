import { create } from 'zustand'
import type {
  AgentFile, BootstrapPayload, Event, Health, Job, NativeFileRef, QueuedTurn,
  RuntimeCatalog, Session, SessionSnapshot
} from '@shared/types'
import { updateQueuedTurns as reduceQueuedTurns } from '@shared/queue'
import { isAgentVisibleEvent, projectTimeline, renderTimelineItems } from '../lib/timeline'
import { navigableSessions } from '../lib/sessions'
import { steerQueuedTurn } from '../lib/queue-actions'

const OLDER_HISTORY_EVENT_LIMIT = 240

interface ModalState {
  settings: boolean
  newChat: boolean
  resume: boolean
  folder: boolean
  digest: boolean
  job: boolean
  search: boolean
  review: boolean
}

interface AppState {
  initialized: boolean
  connected: boolean
  connectionError: string | null
  health: Health | null
  sessions: Session[]
  jobs: Job[]
  runtimeCatalog: RuntimeCatalog | null
  selectedSessionId: string | null
  snapshots: Record<string, SessionSnapshot>
  loadingSessionId: string | null
  uploadsBySession: Record<string, AgentFile[]>
  uploadPathsBySession: Record<string, NativeFileRef[]>
  drafts: Record<string, string>
  folderOrder: string[]
  collapsedFolders: Set<string>
  archivedCollapsed: boolean
  inspectorVisible: boolean
  activeSessionIds: Set<string>
  error: string | null
  modals: ModalState

  initialize(): Promise<void>
  selectSession(sessionId: string, force?: boolean): Promise<void>
  prefetchSession(sessionId: string): Promise<void>
  selectAdjacent(direction: 1 | -1): Promise<void>
  setDraft(text: string): void
  setDraftForSession(sessionId: string, text: string): void
  sendPrompt(promptOverride?: string, steer?: boolean): Promise<boolean>
  stopTurn(): Promise<void>
  attachPaths(files: NativeFileRef[]): Promise<void>
  removeUpload(fileId: string): void
  refreshSessions(): Promise<void>
  updateSession(sessionId: string, patch: Partial<Session>): Promise<void>
  forkSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  markRead(sessionId: string, force?: boolean): Promise<void>
  markUnread(sessionId: string): Promise<void>
  importHistory(sessionId: string): Promise<void>
  loadOlder(): Promise<number>
  setQueued(sessionId: string, turns: QueuedTurn[]): void
  toggleFolder(folder: string): void
  setFolderOrder(order: string[]): void
  setArchivedCollapsed(value: boolean): void
  setInspectorVisible(value: boolean): void
  setModal<K extends keyof ModalState>(key: K, value: boolean): void
  setError(error: string | null): void
}

const defaultModals: ModalState = { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false }
const MINIMUM_AGENT_API_CONTRACT = 6
let unsubscribers: Array<() => void> = []
const olderLoads = new Map<string, Promise<number>>()
const prefetchLoads = new Map<string, Promise<void>>()
const snapshotAccess = new Map<string, number>()
const pendingLiveEvents = new Map<string, Event[]>()
const MAX_MEMORY_SNAPSHOTS = 14
let snapshotAccessCounter = 0
let liveEventFrame: number | null = null
let initializationInFlight = false
let selectionEpoch = 0
let pendingSessionPatchVersion = 0
const pendingSessionPatches = new Map<string, { version: number; patch: Partial<Session> }>()

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  connected: false,
  connectionError: null,
  health: null,
  sessions: [],
  jobs: [],
  runtimeCatalog: null,
  selectedSessionId: null,
  snapshots: {},
  loadingSessionId: null,
  uploadsBySession: {},
  uploadPathsBySession: {},
  drafts: {},
  folderOrder: [],
  collapsedFolders: new Set(),
  archivedCollapsed: false,
  inspectorVisible: true,
  activeSessionIds: new Set(),
  error: null,
  modals: defaultModals,

  async initialize() {
    if (get().initialized || initializationInFlight) return
    if (!window.agentsDock) {
      set({ initialized: true, connected: false, error: 'The secure Electron bridge did not load. See the AgentsDock startup log.' })
      return
    }
    void window.agentsDock.native.log('bootstrap', 'initialize started')
    if (liveEventFrame != null) window.cancelAnimationFrame(liveEventFrame)
    liveEventFrame = null
    pendingLiveEvents.clear()
    for (const unsubscribe of unsubscribers) unsubscribe()
    unsubscribers = [
      window.agentsDock.events.on('server:connection', payload => {
        const version = payload.health?.api_contract_version ?? MINIMUM_AGENT_API_CONTRACT
        const incompatible = version < MINIMUM_AGENT_API_CONTRACT
        const error = incompatible ? `Server upgrade required: this app needs agent API v${MINIMUM_AGENT_API_CONTRACT}, but the server reports v${version}.` : payload.error ?? null
        const current = get()
        const connected = payload.connected && !incompatible
        const health = payload.health ?? current.health
        const activeSessionIds = healthActiveSessionIDs(health)
        if (current.connected !== connected || current.connectionError !== error || !setsEqual(current.activeSessionIds, activeSessionIds) || !jsonEquivalent(current.health, health)) {
          set({ connected, health, connectionError: error, activeSessionIds })
        }
        if (incompatible && get().error !== error) set({ error })
      }),
      window.agentsDock.events.on('server:sessions', incoming => {
        const sessions = applyPendingSessionPatches(incoming)
        const previous = new Map(get().sessions.map(session => [session.id, session]))
        set(state => ({ sessions, snapshots: syncSnapshotSessions(pruneArchivedSnapshots(state.snapshots, sessions, state.selectedSessionId), sessions) }))
        updateBadge(sessions)
        for (const session of sessions) {
          const before = previous.get(session.id)?.latest_agent_event_seq ?? 0
          const after = session.latest_agent_event_seq ?? 0
          if (after > before && !document.hasFocus()) {
            void window.agentsDock.native.notify(session.title, 'New agent message', session.id)
          }
        }
        if (!get().selectedSessionId) {
          const first = sessions.find(session => !session.archived)
          if (first) queueMicrotask(() => void get().selectSession(first.id))
        }
      }),
      window.agentsDock.events.on('server:jobs', jobs => set({ jobs })),
      window.agentsDock.events.on('server:runtime', runtimeCatalog => set({ runtimeCatalog })),
      window.agentsDock.events.on('server:files', ({ sessionId, files, total }) => set(state => {
        const snapshot = state.snapshots[sessionId]
        if (!snapshot) return state
        return { snapshots: cacheSnapshot(state.snapshots, sessionId, {
          ...snapshot,
          files: mergeFiles(snapshot.files, files),
          filesTotal: total
        }, state.selectedSessionId) }
      })),
      window.agentsDock.events.on('server:timeline', ({ sessionId, snapshot, mode }) => set(state => ({
        snapshots: cacheSnapshot(state.snapshots, sessionId, mode === 'replace' ? replaceSnapshot(state.snapshots[sessionId], snapshot) : mergeSnapshots(state.snapshots[sessionId], snapshot), state.selectedSessionId),
        loadingSessionId: state.loadingSessionId === sessionId ? null : state.loadingSessionId
      }))),
      window.agentsDock.events.on('server:event', enqueueLiveEvent),
      window.agentsDock.events.on('native:menu', ({ command }) => handleMenuCommand(command, get, set))
    ]
    initializationInFlight = true
    try {
      const payload = await window.agentsDock.bootstrap()
      void window.agentsDock.native.log('bootstrap', 'cache bootstrap returned', { sessions: payload.sessions.length, hasHealth: Boolean(payload.health) })
      applyBootstrap(payload, set)
      const selected = payload.selectedSessionId && payload.sessions.some(session => session.id === payload.selectedSessionId)
        ? payload.selectedSessionId
        : payload.sessions.find(session => !session.archived)?.id ?? null
      set({ initialized: true, selectedSessionId: selected })
      if (selected) await get().selectSession(selected)
    } catch (error) {
      void window.agentsDock.native.log('bootstrap', 'initialize failed', { error: errorMessage(error) })
      set({ initialized: true, connected: false, error: errorMessage(error) })
    } finally {
      initializationInFlight = false
    }
  },

  async selectSession(sessionId, force = false) {
    if (!force && get().selectedSessionId === sessionId && get().snapshots[sessionId]) { touchSnapshot(sessionId); return }
    if (get().selectedSessionId && get().selectedSessionId !== sessionId) window.dispatchEvent(new Event('agentsdock:capture-timeline'))
    const request = ++selectionEpoch
    if (get().selectedSessionId !== sessionId) set(state => ({
      selectedSessionId: sessionId,
      snapshots: pruneArchivedSnapshots(state.snapshots, state.sessions, sessionId)
    }))
    touchSnapshot(sessionId)
    const existing = get().snapshots[sessionId]
    if (existing) {
      try { await window.agentsDock.timeline.subscribe(sessionId, existing.events.at(-1)?.seq ?? 0) }
      catch (error) { if (request === selectionEpoch && get().selectedSessionId === sessionId) set({ error: errorMessage(error) }) }
      return
    }
    set({ loadingSessionId: sessionId })
    try {
      const snapshot = await window.agentsDock.timeline.open(sessionId)
      if (request !== selectionEpoch || get().selectedSessionId !== sessionId) return
      set(state => ({
        snapshots: cacheSnapshot(state.snapshots, sessionId, mergeSnapshots(state.snapshots[sessionId], snapshot), sessionId),
        loadingSessionId: null
      }))
    } catch (error) {
      if (request === selectionEpoch && get().selectedSessionId === sessionId) set({ loadingSessionId: null, error: errorMessage(error) })
    }
  },

  async prefetchSession(sessionId) {
    if (get().snapshots[sessionId]) { touchSnapshot(sessionId); return }
    if (get().sessions.find(session => session.id === sessionId)?.archived) return
    const existing = prefetchLoads.get(sessionId)
    if (existing) return existing
    const task = (async () => {
      try {
        const snapshot = await window.agentsDock.timeline.cached(sessionId)
        if (!snapshot || get().snapshots[sessionId]) return
        set(state => ({ snapshots: cacheSnapshot(state.snapshots, sessionId, snapshot, state.selectedSessionId) }))
      } catch { /* prefetch is best effort */ }
      finally { prefetchLoads.delete(sessionId) }
    })()
    prefetchLoads.set(sessionId, task)
    return task
  },

  async selectAdjacent(direction) {
    const visible = navigableSessions(get().sessions, get().folderOrder, get().collapsedFolders)
    if (!visible.length) return
    const current = visible.findIndex(session => session.id === get().selectedSessionId)
    const next = visible[(current + direction + visible.length) % visible.length]
    if (next) await get().selectSession(next.id)
  },

  setDraft(text) {
    const id = get().selectedSessionId
    if (!id) return
    set(state => ({ drafts: { ...state.drafts, [id]: text } }))
  },
  setDraftForSession(sessionId, text) {
    set(state => ({ drafts: { ...state.drafts, [sessionId]: text } }))
  },

  async sendPrompt(promptOverride, steer = false) {
    const sessionId = get().selectedSessionId
    if (!sessionId) return false
    const prompt = (promptOverride ?? get().drafts[sessionId] ?? '').trim()
    if (!prompt) return false
    const session = get().sessions.find(candidate => candidate.id === sessionId)
    const uploads = get().uploadsBySession[sessionId] ?? []
    const uploadPaths = get().uploadPathsBySession[sessionId] ?? []
    set(state => ({
      drafts: { ...state.drafts, [sessionId]: '' },
      uploadsBySession: { ...state.uploadsBySession, [sessionId]: [] },
      uploadPathsBySession: { ...state.uploadPathsBySession, [sessionId]: [] }
    }))
    try {
      const response = await window.agentsDock.turns.send({
        sessionId, prompt, fileIds: uploads.map(file => file.id), model: session?.model, effort: session?.effort
      })
      set(state => {
        const snapshot = state.snapshots[sessionId]
        return {
          sessions: state.sessions.map(candidate => candidate.id === response.session.id ? response.session : candidate),
          activeSessionIds: response.event ? updateActiveSessions(state.activeSessionIds, response.event) : state.activeSessionIds,
          snapshots: response.event && snapshot
            ? cacheSnapshot(state.snapshots, sessionId, { ...snapshot, events: upsertEvent(snapshot.events, response.event), queuedTurns: reduceQueuedTurns(snapshot.queuedTurns, response.event) }, state.selectedSessionId)
            : state.snapshots
        }
      })
      if (steer && response.queued_id) {
        try { get().setQueued(sessionId, await steerQueuedTurn(sessionId, response.queued_id)) }
        catch (error) { set({ error: errorMessage(error) }) }
      }
      window.dispatchEvent(new CustomEvent('agentsdock:local-send', { detail: { sessionId } }))
      return true
    } catch (error) {
      set(state => ({
        drafts: { ...state.drafts, [sessionId]: state.drafts[sessionId]?.trim() ? state.drafts[sessionId] : prompt },
        uploadsBySession: { ...state.uploadsBySession, [sessionId]: mergeFiles(state.uploadsBySession[sessionId] ?? [], uploads) },
        uploadPathsBySession: { ...state.uploadPathsBySession, [sessionId]: mergeUploadPaths(state.uploadPathsBySession[sessionId] ?? [], uploadPaths) },
        error: errorMessage(error)
      }))
      return false
    }
  },

  async stopTurn() {
    const id = get().selectedSessionId
    if (!id) return
    try {
      await window.agentsDock.turns.stop(id)
      set(state => { const next = new Set(state.activeSessionIds); next.delete(id); return { activeSessionIds: next } })
    } catch (error) { set({ error: errorMessage(error) }) }
  },

  async attachPaths(files) {
    const id = get().selectedSessionId
    if (!id || !files.length) return
    set(state => ({ uploadPathsBySession: {
      ...state.uploadPathsBySession,
      [id]: [...(state.uploadPathsBySession[id] ?? []), ...files]
    } }))
    try {
      const uploaded = await window.agentsDock.files.upload(id, files.map(file => file.path))
      set(state => ({
        uploadPathsBySession: {
          ...state.uploadPathsBySession,
          [id]: (state.uploadPathsBySession[id] ?? []).filter(file => !files.some(candidate => candidate.path === file.path))
        },
        uploadsBySession: {
          ...state.uploadsBySession,
          [id]: mergeFiles(state.uploadsBySession[id] ?? [], uploaded)
        }
      }))
    } catch (error) {
      set(state => ({
        uploadPathsBySession: {
          ...state.uploadPathsBySession,
          [id]: (state.uploadPathsBySession[id] ?? []).filter(file => !files.some(candidate => candidate.path === file.path))
        },
        error: errorMessage(error)
      }))
    }
  },

  removeUpload(fileId) {
    const id = get().selectedSessionId
    if (!id) return
    set(state => ({ uploadsBySession: {
      ...state.uploadsBySession,
      [id]: (state.uploadsBySession[id] ?? []).filter(file => file.id !== fileId)
    } }))
  },
  async refreshSessions() { try { set({ sessions: applyPendingSessionPatches(await window.agentsDock.sessions.list()) }) } catch (error) { set({ error: errorMessage(error) }) } },

  async updateSession(sessionId, patch) {
    const previousSession = get().sessions.find(session => session.id === sessionId)
    const version = ++pendingSessionPatchVersion
    const existing = pendingSessionPatches.get(sessionId)?.patch ?? {}
    pendingSessionPatches.set(sessionId, { version, patch: { ...existing, ...patch } })
    set(state => ({ sessions: state.sessions.map(session => session.id === sessionId ? { ...session, ...patch } as Session : session) }))
    try {
      const updated = await window.agentsDock.sessions.update(sessionId, normalizeSessionPatch(patch))
      const pending = pendingSessionPatches.get(sessionId)
      if (pending?.version === version) pendingSessionPatches.delete(sessionId)
      set(state => ({ sessions: state.sessions.map(session => session.id === sessionId
        ? pending && pending.version !== version ? { ...updated, ...pending.patch } : updated
        : session) }))
    } catch (error) {
      const pending = pendingSessionPatches.get(sessionId)
      if (pending?.version === version) {
        pendingSessionPatches.delete(sessionId)
        if (previousSession) set(state => ({ sessions: state.sessions.map(session => session.id === sessionId ? previousSession : session) }))
      }
      set({ error: errorMessage(error) })
    }
  },

  async forkSession(sessionId) {
    try { const session = await window.agentsDock.sessions.fork(sessionId); await get().refreshSessions(); await get().selectSession(session.id) }
    catch (error) { set({ error: errorMessage(error) }) }
  },
  async deleteSession(sessionId) {
    try {
      await window.agentsDock.sessions.remove(sessionId)
      const sessions = get().sessions.filter(session => session.id !== sessionId)
      snapshotAccess.delete(sessionId)
      set(state => {
        const snapshots = { ...state.snapshots }
        delete snapshots[sessionId]
        return { sessions, snapshots, selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId }
      })
      if (!get().selectedSessionId) {
        const next = sessions.find(session => !session.archived)
        if (next) await get().selectSession(next.id)
      }
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async markRead(sessionId, _force = false) {
    const session = get().sessions.find(candidate => candidate.id === sessionId)
    if (!session || !isUnread(session)) return
    const seq = session.latest_agent_event_seq ?? session.latest_event_seq ?? null
    try {
      const updated = await window.agentsDock.sessions.markRead(sessionId, seq)
      set(state => ({
        sessions: state.sessions.map(candidate => candidate.id === sessionId ? updated : candidate),
        snapshots: state.snapshots[sessionId]
          ? { ...state.snapshots, [sessionId]: { ...state.snapshots[sessionId], session: updated } }
          : state.snapshots
      }))
    } catch { /* reading remains local-first */ }
  },
  async markUnread(sessionId) {
    try {
      const updated = await window.agentsDock.sessions.markUnread(sessionId)
      set(state => ({
        sessions: state.sessions.map(candidate => candidate.id === sessionId ? updated : candidate),
        snapshots: state.snapshots[sessionId]
          ? { ...state.snapshots, [sessionId]: { ...state.snapshots[sessionId], session: updated } }
          : state.snapshots
      }))
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async importHistory(sessionId) {
    try {
      const page = await window.agentsDock.sessions.importHistory(sessionId, true)
      set(state => {
        const current = state.snapshots[sessionId]
        if (!current) return { sessions: state.sessions.map(session => session.id === page.session.id ? page.session : session) }
        const snapshot: SessionSnapshot = {
          ...current,
          session: page.session,
          events: mergeEvents(page.events, current.events),
          queuedTurns: page.queued_turns ?? current.queuedTurns,
          hasMoreEvents: Boolean(page.has_more)
        }
        return {
          sessions: state.sessions.map(session => session.id === page.session.id ? page.session : session),
          snapshots: cacheSnapshot(state.snapshots, sessionId, snapshot, state.selectedSessionId)
        }
      })
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  async loadOlder() {
    const id = get().selectedSessionId; const snapshot = id ? get().snapshots[id] : null
    const before = snapshot?.events[0]?.seq
    if (!id || !snapshot || !before || !snapshot.hasMoreEvents) return 0
    const existing = olderLoads.get(id)
    if (existing) return existing
    const task = (async () => {
    try {
      const initialRows = primaryTimelineRows(snapshot.events, snapshot.files)
      let cursor = before
      let page = await window.agentsDock.timeline.older(id, cursor, OLDER_HISTORY_EVENT_LIMIT)
      let collected = page.events
      let hasMore = Boolean(page.has_more)
      for (let attempt = 1; attempt < 4 && hasMore; attempt += 1) {
        const projectedRows = primaryTimelineRows(mergeEvents(collected, snapshot.events), snapshot.files) - initialRows
        if (projectedRows >= 8) break
        const nextCursor = collected[0]?.seq
        if (!nextCursor || nextCursor >= cursor) break
        cursor = nextCursor
        const older = await window.agentsDock.timeline.older(id, cursor, OLDER_HISTORY_EVENT_LIMIT)
        if (!older.events.length) { hasMore = false; break }
        collected = mergeEvents(older.events, collected)
        page = older
        hasMore = Boolean(older.has_more)
      }
      let added = 0
      set(state => {
        const current = state.snapshots[id]
        if (!current) return state
        const events = mergeEvents(collected, current.events)
        added = events.length - current.events.length
        return { snapshots: cacheSnapshot(state.snapshots, id, { ...current, events, hasMoreEvents: hasMore, session: page.session }, state.selectedSessionId) }
      })
      return added
    } catch (error) { set({ error: errorMessage(error) }); return 0 }
    finally { olderLoads.delete(id) }
    })()
    olderLoads.set(id, task)
    return task
  },
  setQueued(sessionId, turns) {
    if (!get().snapshots[sessionId]) return
    set(state => ({ snapshots: cacheSnapshot(state.snapshots, sessionId, { ...state.snapshots[sessionId], queuedTurns: turns }, state.selectedSessionId) }))
  },
  toggleFolder(folder) {
    const next = new Set(get().collapsedFolders)
    if (next.has(folder)) next.delete(folder); else next.add(folder)
    set({ collapsedFolders: next }); void window.agentsDock.preferences.set('collapsedFolders', [...next])
  },
  setFolderOrder(order) { set({ folderOrder: order }); void window.agentsDock.preferences.set('folderOrder', order) },
  setArchivedCollapsed(value) { set({ archivedCollapsed: value }); void window.agentsDock.preferences.set('archivedCollapsed', value) },
  setInspectorVisible(value) { set({ inspectorVisible: value }); void window.agentsDock.preferences.set('inspectorVisible', value) },
  setModal(key, value) { set(state => ({ modals: { ...state.modals, [key]: value } })) },
  setError(error) { set({ error }) }
}))

function applyBootstrap(payload: BootstrapPayload, set: (value: Partial<AppState>) => void): void {
  set({
    connected: Boolean(payload.health?.ok), health: payload.health ?? null, sessions: payload.sessions,
    jobs: payload.jobs, runtimeCatalog: payload.runtimeCatalog ?? null, folderOrder: payload.folderOrder,
    collapsedFolders: new Set(payload.collapsedFolders), archivedCollapsed: payload.archivedCollapsed,
    inspectorVisible: payload.inspectorVisible, activeSessionIds: healthActiveSessionIDs(payload.health)
  })
  updateBadge(payload.sessions)
}

function mergeSnapshots(previous: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  if (!previous) return next
  const events = mergeEvents(previous.events, next.events)
  const files = mergeFiles(previous.files, next.files)
  const queuedTurns = stableArray(previous.queuedTurns, next.queuedTurns)
  const session = jsonEquivalent(previous.session, next.session) ? previous.session : next.session
  const eventsTotal = next.eventsTotal ?? previous.eventsTotal
  if (events === previous.events && files === previous.files && session === previous.session && queuedTurns === previous.queuedTurns && previous.hasMoreEvents === next.hasMoreEvents && previous.eventsTotal === eventsTotal) return previous
  return { ...next, session, queuedTurns, viewState: next.viewState ?? previous.viewState, events, files, eventsTotal, generation: previous.generation }
}

function replaceSnapshot(previous: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  return { ...next, eventsTotal: next.eventsTotal ?? previous?.eventsTotal, viewState: next.viewState ?? previous?.viewState, generation: (previous?.generation ?? 0) + 1 }
}

function touchSnapshot(sessionId: string): void {
  snapshotAccess.set(sessionId, ++snapshotAccessCounter)
}

export function cacheSnapshot(
  current: Record<string, SessionSnapshot>,
  sessionId: string,
  snapshot: SessionSnapshot,
  selectedSessionId: string | null
): Record<string, SessionSnapshot> {
  touchSnapshot(sessionId)
  const next = { ...current, [sessionId]: snapshot }
  const removable = Object.keys(next)
    .filter(id => id !== selectedSessionId && id !== sessionId)
    .sort((a, b) => (snapshotAccess.get(a) ?? 0) - (snapshotAccess.get(b) ?? 0))
  while (Object.keys(next).length > MAX_MEMORY_SNAPSHOTS && removable.length) {
    const id = removable.shift()
    if (!id) break
    delete next[id]
    snapshotAccess.delete(id)
  }
  return next
}

function pruneArchivedSnapshots(current: Record<string, SessionSnapshot>, sessions: Session[], selectedSessionId: string | null): Record<string, SessionSnapshot> {
  const archived = new Set(sessions.filter(session => session.archived && session.id !== selectedSessionId).map(session => session.id))
  if (![...archived].some(id => current[id])) return current
  const next = { ...current }
  for (const id of archived) {
    delete next[id]
    snapshotAccess.delete(id)
  }
  return next
}
function syncSnapshotSessions(current: Record<string, SessionSnapshot>, sessions: Session[]): Record<string, SessionSnapshot> {
  const byId = new Map(sessions.map(session => [session.id, session]))
  let next = current
  for (const [id, snapshot] of Object.entries(current)) {
    const session = byId.get(id)
    if (!session || session === snapshot.session) continue
    if (next === current) next = { ...current }
    next[id] = { ...snapshot, session }
  }
  return next
}
export function mergeEvents(a: Event[], b: Event[]): Event[] {
  if (!b.length) return a
  if (!a.length) return b
  const firstA = a[0].seq; const lastA = a[a.length - 1].seq
  const firstB = b[0].seq; const lastB = b[b.length - 1].seq
  if (lastA < firstB) return [...a, ...b]
  if (lastB < firstA) return [...b, ...a]
  let changed = false
  const byId = new Map(a.map(event => [event.id, event]))
  for (const event of b) {
    const previous = byId.get(event.id)
    if (!previous) { byId.set(event.id, event); changed = true }
    else if (previous !== event && !jsonEquivalent(previous, event)) { byId.set(event.id, event); changed = true }
  }
  if (!changed) return a
  return [...byId.values()].sort((x, y) => x.seq - y.seq)
}
function upsertEvent(events: Event[], event: Event): Event[] {
  const existing = events.findIndex(candidate => candidate.id === event.id)
  if (existing >= 0) {
    if (events[existing] === event) return events
    const next = [...events]
    next[existing] = event
    if (existing > 0 && next[existing - 1].seq > event.seq || existing < next.length - 1 && next[existing + 1].seq < event.seq) {
      next.sort((a, b) => a.seq - b.seq)
    }
    return next
  }
  const last = events.at(-1)
  if (!last || last.seq <= event.seq) return [...events, event]
  return mergeEvents(events, [event])
}
function mergeFiles(a: AgentFile[], b: AgentFile[]): AgentFile[] {
  if (!b.length) return a
  if (!a.length) return b
  let changed = false
  const byId = new Map(a.map(file => [file.id, file]))
  for (const file of b) {
    const previous = byId.get(file.id)
    if (!previous) { byId.set(file.id, file); changed = true }
    else if (!jsonEquivalent(previous, file)) { byId.set(file.id, file); changed = true }
  }
  return changed ? [...byId.values()].sort((x, y) => (y.seq ?? 0) - (x.seq ?? 0)) : a
}
function mergeUploadPaths(a: NativeFileRef[], b: NativeFileRef[]): NativeFileRef[] {
  return [...new Map([...a, ...b].map(file => [file.path, file])).values()]
}
function stableArray<T>(previous: T[], next: T[]): T[] { return jsonEquivalent(previous, next) ? previous : next }
function healthActiveSessionIDs(health?: Health | null): Set<string> { return new Set(health?.active ?? health?.active_sessions ?? []) }
export function updateActiveSessions(current: Set<string>, event: Event): Set<string> {
  const next = new Set(current)
  if (event.type === 'turn_started') next.add(event.session_id)
  if (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error') next.delete(event.session_id)
  return setsEqual(current, next) ? current : next
}

function enqueueLiveEvent(event: Event): void {
  pendingLiveEvents.set(event.session_id, [...(pendingLiveEvents.get(event.session_id) ?? []), event])
  if (liveEventFrame != null) return
  liveEventFrame = window.requestAnimationFrame(() => {
    liveEventFrame = null
    const batches = new Map(pendingLiveEvents)
    pendingLiveEvents.clear()
    useAppStore.setState(state => {
      let activeSessionIds = state.activeSessionIds
      let snapshots = state.snapshots
      for (const [sessionId, events] of batches) {
        for (const event of events) activeSessionIds = updateActiveSessions(activeSessionIds, event)
        const snapshot = snapshots[sessionId]
        if (!snapshot) continue
        let queuedTurns = snapshot.queuedTurns
        const files: AgentFile[] = []
        for (const event of events) {
          queuedTurns = reduceQueuedTurns(queuedTurns, event)
          if (event.file) files.push(event.file)
          if (event.artifact) files.push(event.artifact)
        }
        const mergedFiles = mergeFiles(snapshot.files, files)
        snapshots = cacheSnapshot(snapshots, sessionId, {
          ...snapshot,
          events: mergeEvents(snapshot.events, events),
          queuedTurns,
          files: mergedFiles,
          filesTotal: Math.max(snapshot.filesTotal, mergedFiles.length)
        }, state.selectedSessionId)
      }
      return { activeSessionIds, snapshots }
    })
  })
}
export { updateQueuedTurns } from '@shared/queue'
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean { return a.size === b.size && [...a].every(value => b.has(value)) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function jsonEquivalent(a: unknown, b: unknown): boolean { return a === b || JSON.stringify(a) === JSON.stringify(b) }
function primaryTimelineRows(events: Event[], files: AgentFile[]): number {
  return renderTimelineItems(projectTimeline(events, files)).filter(item => item.kind !== 'trace').length
}
function normalizeSessionPatch(patch: Partial<Session>) { return { title: patch.title, folder: patch.folder ?? undefined, cwd: patch.cwd ?? undefined, backend: patch.backend, model: patch.model, effort: patch.effort, pinned: patch.pinned ?? undefined, archived: patch.archived ?? undefined } }
function applyPendingSessionPatches(sessions: Session[]): Session[] {
  return sessions.map(session => {
    const pending = pendingSessionPatches.get(session.id)
    return pending ? { ...session, ...pending.patch } : session
  })
}
function isUnread(session: Session): boolean { return Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0) }
function updateBadge(sessions: Session[]): void { void window.agentsDock.native.setBadge(sessions.filter(session => !session.archived && isUnread(session)).length) }

function handleMenuCommand(command: string, get: () => AppState, set: (value: Partial<AppState>) => void): void {
  if (command.startsWith('open-session:')) { void get().selectSession(command.slice('open-session:'.length)); return }
  if (command === 'check-update') {
    get().setModal('settings', true)
    void window.agentsDock.updates.check()
  }
  else if (command === 'settings') get().setModal('settings', true)
  else if (command === 'new-chat') get().setModal('newChat', true)
  else if (command === 'attach-files') void window.agentsDock.files.choose().then(get().attachPaths)
  else if (command === 'find-chat') get().setModal('search', true)
  else if (command === 'find-in-current-chat') window.dispatchEvent(new CustomEvent('agentsdock:find-in-chat'))
  else if (command === 'next-chat') void get().selectAdjacent(1)
  else if (command === 'previous-chat') void get().selectAdjacent(-1)
  else if (command === 'toggle-inspector') get().setInspectorVisible(!get().inspectorVisible)
  else if (command === 'jump-latest') window.dispatchEvent(new CustomEvent('agentsdock:jump-latest'))
  else if (command === 'close-surface') window.dispatchEvent(new CustomEvent('agentsdock:close-surface'))
  else set({ error: `Unknown command: ${command}` })
}

export function sessionUnread(session: Session): boolean { return isUnread(session) }
export function sessionRunning(sessionId: string): boolean { return useAppStore.getState().activeSessionIds.has(sessionId) }
