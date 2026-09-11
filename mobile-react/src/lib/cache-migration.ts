import type { PinnedItem, Session, Snapshot, WorkspacePreferences } from '../types'
import { SNAPSHOT_CACHE_VERSION } from './history'
import { normalizeWorkspacePreferences } from './server-profiles'

export const CACHE_SNAPSHOT_SESSION_LIMIT = 80
// Mobile timelines render the latest window and page older history on demand.
// Keeping thousands of tool/reasoning packets in every JSON snapshot makes a
// visually short chat take megabytes to parse and persist on the JS thread.
export const CACHE_SNAPSHOT_EVENT_LIMIT = 720
export const CACHE_LEGACY_EVENT_LIMIT = 420

export interface NamespaceCachePayload {
  sessions: Session[]
  recentSessionIds: string[]
  snapshots: Record<string, Snapshot>
  pins: PinnedItem[]
  workspace: WorkspacePreferences
}

export interface CachedServerSummaryValue {
  namespace: string
  sessionCount: number
  activeSessionCount: number
  archivedSessionCount: number
  unreadCount: number
  pinnedCount: number
  updatedAt: number | null
}

export class CacheNamespaceCollisionError extends Error {
  constructor(
    readonly sourceNamespace: string,
    readonly targetNamespace: string,
    readonly sessionIds: string[],
  ) {
    super(`Cannot merge cache namespaces with conflicting sessions: ${sessionIds.join(', ')}`)
    this.name = 'CacheNamespaceCollisionError'
  }
}

export function sessionsConflict(source: Session, target: Session): boolean {
  if (source.id !== target.id) return false
  if (source.backend && target.backend && source.backend !== target.backend) return true
  for (const key of ['session_id', 'claude_session_id', 'codex_thread_id', 'parent_id'] as const) {
    const sourceValue = source[key]
    const targetValue = target[key]
    if (sourceValue && targetValue && sourceValue !== targetValue) return true
  }
  return Boolean(source.created_at && target.created_at && source.created_at !== target.created_at)
}

export function findNamespaceSessionCollisions(
  source: Pick<NamespaceCachePayload, 'sessions' | 'snapshots'>,
  target: Pick<NamespaceCachePayload, 'sessions' | 'snapshots'>,
): string[] {
  const sourceSessions = ownedSessions(source)
  const targetSessions = ownedSessions(target)
  return [...sourceSessions.entries()]
    .filter(([sessionId, session]) => {
      const targetSession = targetSessions.get(sessionId)
      return targetSession ? sessionsConflict(session, targetSession) : false
    })
    .map(([sessionId]) => sessionId)
    .sort()
}

export function mergeNamespaceCachePayload(
  source: NamespaceCachePayload,
  target: NamespaceCachePayload,
  sourceNamespace: string,
  targetNamespace: string,
): NamespaceCachePayload {
  const collisions = findNamespaceSessionCollisions(source, target)
  if (collisions.length) throw new CacheNamespaceCollisionError(sourceNamespace, targetNamespace, collisions)

  const sessionOrder = uniqueStrings([
    ...target.sessions.map(session => session.id),
    ...source.sessions.map(session => session.id),
  ])
  const sessionMap = new Map(target.sessions.map(session => [session.id, session]))
  for (const session of source.sessions) {
    const existing = sessionMap.get(session.id)
    sessionMap.set(session.id, existing ? mergeCompatibleSessions(session, existing) : session)
  }

  const recentSessionIds = uniqueStrings([
    ...target.recentSessionIds,
    ...source.recentSessionIds,
    ...Object.keys(target.snapshots),
    ...Object.keys(source.snapshots),
  ]).slice(0, CACHE_SNAPSHOT_SESSION_LIMIT)
  const snapshotIds = recentSessionIds.filter(sessionId => target.snapshots[sessionId] || source.snapshots[sessionId])
  const snapshots: Record<string, Snapshot> = {}
  for (const sessionId of snapshotIds) {
    const sourceSnapshot = source.snapshots[sessionId]
    const targetSnapshot = target.snapshots[sessionId]
    const merged = sourceSnapshot && targetSnapshot
      ? mergeCompatibleSnapshots(sourceSnapshot, targetSnapshot)
      : normalizeSnapshotForCache(sourceSnapshot ?? targetSnapshot)
    if (merged) snapshots[sessionId] = merged
  }

  return {
    sessions: sessionOrder.flatMap(sessionId => {
      const session = sessionMap.get(sessionId)
      return session ? [session] : []
    }),
    recentSessionIds,
    snapshots,
    pins: mergePins(source.pins, target.pins),
    workspace: mergeWorkspacePreferences(source.workspace, target.workspace),
  }
}

export function mergeWorkspacePreferences(
  sourceValue: WorkspacePreferences,
  targetValue: WorkspacePreferences,
): WorkspacePreferences {
  const source = normalizeWorkspacePreferences(sourceValue)
  const target = normalizeWorkspacePreferences(targetValue)
  const chatReferencesBySession: NonNullable<WorkspacePreferences['chatReferencesBySession']> = {}
  const sourceReferences = source.chatReferencesBySession ?? {}
  const targetReferences = target.chatReferencesBySession ?? {}
  for (const sessionId of uniqueStrings([
    ...Object.keys(sourceReferences),
    ...Object.keys(targetReferences),
  ])) {
    // Owning the destination draft also owns the absence of authority. Do not
    // resurrect a legacy grant merely because the exact mention text happens
    // to still be present in the newer destination draft.
    const references = Object.prototype.hasOwnProperty.call(target.drafts, sessionId)
      ? targetReferences[sessionId]
      : sourceReferences[sessionId]
    if (references?.length) chatReferencesBySession[sessionId] = references
  }
  const teamReferencesBySession: NonNullable<WorkspacePreferences['teamReferencesBySession']> = {}
  for (const sessionId of uniqueStrings([
    ...Object.keys(source.teamReferencesBySession ?? {}),
    ...Object.keys(target.teamReferencesBySession ?? {}),
  ])) {
    const references = Object.prototype.hasOwnProperty.call(target.drafts, sessionId)
      ? target.teamReferencesBySession?.[sessionId]
      : source.teamReferencesBySession?.[sessionId]
    if (references?.length) teamReferencesBySession[sessionId] = references
  }
  return normalizeWorkspacePreferences({
    selectedSessionId: target.selectedSessionId ?? source.selectedSessionId,
    folderOrder: uniqueStrings([...target.folderOrder, ...source.folderOrder]),
    collapsedFolders: uniqueStrings([...target.collapsedFolders, ...source.collapsedFolders]),
    drafts: { ...source.drafts, ...target.drafts },
    ...(Object.keys(chatReferencesBySession).length ? { chatReferencesBySession } : {}),
    ...(Object.keys(teamReferencesBySession).length ? { teamReferencesBySession } : {}),
    chatDefaults: target.chatDefaults ?? source.chatDefaults,
  })
}

export function summarizeCachedSessions(namespace: string, sessions: readonly Session[]): CachedServerSummaryValue {
  let activeSessionCount = 0
  let archivedSessionCount = 0
  let unreadCount = 0
  let pinnedCount = 0
  let updatedAt: number | null = null
  for (const session of sessions) {
    const timestamp = newestSessionTimestamp(session)
    if (timestamp !== null) updatedAt = Math.max(updatedAt ?? timestamp, timestamp)
    if (session.archived) {
      archivedSessionCount += 1
      continue
    }
    activeSessionCount += 1
    if (session.manual_unread || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0)) unreadCount += 1
    if (session.pinned) pinnedCount += 1
  }
  return {
    namespace,
    sessionCount: sessions.length,
    activeSessionCount,
    archivedSessionCount,
    unreadCount,
    pinnedCount,
    updatedAt,
  }
}

function ownedSessions(value: Pick<NamespaceCachePayload, 'sessions' | 'snapshots'>): Map<string, Session> {
  const result = new Map<string, Session>()
  for (const session of value.sessions) addOwnedSession(result, session)
  for (const snapshot of Object.values(value.snapshots)) addOwnedSession(result, snapshot.session)
  return result
}

function addOwnedSession(sessions: Map<string, Session>, candidate: Session): void {
  if (!candidate?.id) return
  const existing = sessions.get(candidate.id)
  if (existing && sessionsConflict(existing, candidate)) {
    throw new Error(`Cache namespace contains conflicting ownership for session ${candidate.id}.`)
  }
  sessions.set(candidate.id, existing ? mergeCompatibleSessions(candidate, existing) : candidate)
}

function mergeCompatibleSessions(source: Session, target: Session): Session {
  const sourceIsNewer = compareSessionFreshness(source, target) > 0
  return sourceIsNewer ? { ...target, ...source } : { ...source, ...target }
}

function compareSessionFreshness(left: Session, right: Session): number {
  const timestamp = sessionTimestamp(left) - sessionTimestamp(right)
  if (timestamp) return timestamp
  const latest = (left.latest_event_seq ?? 0) - (right.latest_event_seq ?? 0)
  if (latest) return latest
  return (left.latest_agent_event_seq ?? 0) - (right.latest_agent_event_seq ?? 0)
}

function sessionTimestamp(session: Session): number {
  for (const value of [session.updated_at, session.latest_event_at, session.created_at]) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function mergeCompatibleSnapshots(source: Snapshot, target: Snapshot): Snapshot | null {
  if (sessionsConflict(source.session, target.session)) return null
  const sourceTrusted = source.cacheVersion === SNAPSHOT_CACHE_VERSION
  const targetTrusted = target.cacheVersion === SNAPSHOT_CACHE_VERSION
  if (sourceTrusted !== targetTrusted) {
    const trusted = sourceTrusted ? source : target
    const other = sourceTrusted ? target : source
    const normalized = normalizeSnapshotForCache(trusted)
    return normalized ? { ...normalized, session: mergeCompatibleSessions(other.session, normalized.session) } : null
  }
  if (!sourceTrusted) {
    const newer = Number(source.cachedAt || 0) > Number(target.cachedAt || 0) ? source : target
    return normalizeSnapshotForCache(newer)
  }

  const sessionId = source.session.id
  const sourceEvents = source.events.filter(event => event?.session_id === sessionId && Number.isFinite(event.seq))
  const targetEvents = target.events.filter(event => event?.session_id === sessionId && Number.isFinite(event.seq))
  const eventMap = new Map(
    sourceEvents
      .filter(event => event.type !== 'raw_event')
      .map(event => [event.id, event]),
  )
  for (const event of targetEvents) {
    if (event.type !== 'raw_event') eventMap.set(event.id, event)
  }
  const queuedMap = new Map(source.queuedTurns
    .filter(turn => !turn.session_id || turn.session_id === sessionId)
    .map(turn => [turn.queued_id, turn]))
  for (const turn of target.queuedTurns) {
    if (!turn.session_id || turn.session_id === sessionId) queuedMap.set(turn.queued_id, turn)
  }
  const fileMap = new Map(source.files
    .filter(file => !file.session_id || file.session_id === sessionId)
    .map(file => [file.id, file]))
  for (const file of target.files) {
    if (!file.session_id || file.session_id === sessionId) fileMap.set(file.id, file)
  }
  const matchingEvents = [...eventMap.values()].sort((left, right) => left.seq - right.seq)
  const events = matchingEvents.slice(-CACHE_SNAPSHOT_EVENT_LIMIT)
  const eventsTruncated = matchingEvents.length > events.length
  const latestSeq = [...sourceEvents, ...targetEvents].reduce(
    (latest, event) => Math.max(latest, event.seq),
    Math.max(finiteCursor(source.latestSeq), finiteCursor(target.latestSeq)),
  )
  const total = maxNullable(source.total, target.total)
  const merged: Snapshot = {
    ...source,
    ...target,
    cacheVersion: SNAPSHOT_CACHE_VERSION,
    session: mergeCompatibleSessions(source.session, target.session),
    events,
    queuedTurns: [...queuedMap.values()],
    files: [...fileMap.values()],
    filesTotal: Math.max(source.filesTotal ?? 0, target.filesTotal ?? 0, fileMap.size),
    hasMore: Boolean(source.hasMore || target.hasMore || eventsTruncated || (total !== null && total > events.length)),
    total,
    cachedAt: Math.max(Number(source.cachedAt || 0), Number(target.cachedAt || 0)),
    latestSeq,
  }
  return merged
}

function normalizeSnapshotForCache(value: Snapshot | undefined): Snapshot | null {
  if (!value?.session?.id || !Array.isArray(value.events)) return null
  const sessionId = value.session.id
  const trusted = value.cacheVersion === SNAPSHOT_CACHE_VERSION
  const allMatchingEvents = value.events
    .filter(event => event?.session_id === sessionId && Number.isFinite(event.seq))
    .sort((left, right) => left.seq - right.seq)
  const matchingEvents = allMatchingEvents.filter(event => event.type !== 'raw_event')
  const events = matchingEvents.slice(-(trusted ? CACHE_SNAPSHOT_EVENT_LIMIT : CACHE_LEGACY_EVENT_LIMIT))
  const eventsTruncated = matchingEvents.length > events.length
  const latestSeq = allMatchingEvents.reduce((latest, event) => Math.max(latest, event.seq), finiteCursor(value.latestSeq))
  const total = typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : null
  const normalized: Snapshot = {
    ...value,
    cacheVersion: trusted ? SNAPSHOT_CACHE_VERSION : undefined,
    events,
    queuedTurns: Array.isArray(value.queuedTurns)
      ? value.queuedTurns.filter(turn => !turn.session_id || turn.session_id === sessionId)
      : [],
    files: Array.isArray(value.files)
      ? value.files.filter(file => !file.session_id || file.session_id === sessionId)
      : [],
    filesTotal: typeof value.filesTotal === 'number' && Number.isFinite(value.filesTotal) ? value.filesTotal : 0,
    hasMore: Boolean(value.hasMore || eventsTruncated || (total !== null && total > events.length)),
    total,
    cachedAt: typeof value.cachedAt === 'number' && Number.isFinite(value.cachedAt) ? value.cachedAt : 0,
    latestSeq,
  }
  return normalized
}

function finiteCursor(value?: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function mergePins(source: PinnedItem[], target: PinnedItem[]): PinnedItem[] {
  const result = new Map(source.map(pin => [pin.id, pin]))
  for (const pin of target) result.set(pin.id, pin)
  const order = uniqueStrings([...target.map(pin => pin.id), ...source.map(pin => pin.id)])
  return order.flatMap(id => {
    const pin = result.get(id)
    return pin ? [pin] : []
  })
}

function maxNullable(left?: number | null, right?: number | null): number | null {
  const values = [left, right].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length ? Math.max(...values) : null
}

function newestSessionTimestamp(session: Session): number | null {
  for (const value of [session.updated_at, session.latest_event_at, session.created_at]) {
    if (!value) continue
    const timestamp = Date.parse(value)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return null
}

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
