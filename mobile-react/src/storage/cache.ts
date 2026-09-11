import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type {
  PinnedItem,
  QueuedTurn,
  Session,
  Snapshot,
  StoredProfileSettings,
  WorkspacePreferences,
} from '../types'
import {
  CACHE_LEGACY_EVENT_LIMIT,
  CACHE_SNAPSHOT_EVENT_LIMIT,
  CACHE_SNAPSHOT_SESSION_LIMIT,
  CacheNamespaceCollisionError,
  mergeNamespaceCachePayload,
  mergeWorkspacePreferences,
  summarizeCachedSessions,
  type NamespaceCachePayload,
} from '../lib/cache-migration'
import { SNAPSHOT_CACHE_VERSION, snapshotLatestSeq } from '../lib/history'
import { boundLiveTimelineEvents, sanitizeTimelineEvent, sanitizeTimelineFile } from '../lib/timeline-memory'
import {
  createDefaultProfileSettings,
  legacyURLCacheNamespace,
  migrateLegacyProfileSettings,
  nextCredentialVersion,
  normalizeCredentialVersion,
  normalizeStoredProfileSettings,
  normalizeWorkspacePreferences,
  profileCredentialKeySuffix,
  profileNamespace,
} from '../lib/server-profiles'

const PROFILE_SETTINGS_KEY = 'agentsdock.react.settings.v2'
const LEGACY_SETTINGS_KEY = 'agentsdock.react.settings.v1'
const LEGACY_TOKEN_KEY = 'agentsdock.react.access-token'
const LEGACY_TOKEN_FALLBACK_KEY = 'agentsdock.react.access-token.simulator-fallback'
// These unversioned profile keys were used by the first multi-server builds.
// They remain a read-through migration source for credential version 1.
const LEGACY_PROFILE_TOKEN_PREFIX = 'agentsdock.react.access-token.profile.'
const LEGACY_PROFILE_TOKEN_FALLBACK_PREFIX = 'agentsdock.react.access-token.profile-fallback.'
const PROFILE_TOKEN_PREFIX = 'agentsdock.react.access-token.profile.'
const PROFILE_TOKEN_FALLBACK_PREFIX = 'agentsdock.react.access-token.profile-fallback.'
const SNAPSHOT_STORAGE_PREFIX = 'agentsdock.react.snapshot.'
const SNAPSHOT_RECENT_PREFIX = 'agentsdock.react.recent.'
const SNAPSHOT_CACHE_GENERATION_KEY = 'agentsdock.react.snapshot-cache-generation'
const CACHED_QUEUED_PROMPT_LIMIT = 48_000
const CACHE_TRUNCATION_SUFFIX = '\n\n[Content truncated on mobile.]'

interface WriteCompletion {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

interface WorkspaceWriteEntry {
  value: WorkspacePreferences
  completion: WriteCompletion
}

interface WorkspaceWriteState {
  running: boolean
  pending: WorkspaceWriteEntry | null
  idleResolvers: Array<() => void>
}

interface SnapshotWriteEntry {
  sessionId: string
  snapshot: Snapshot | null
  completion: WriteCompletion
}

interface SnapshotWriteState {
  running: boolean
  pending: Map<string, SnapshotWriteEntry>
  idleResolvers: Array<() => void>
}

// AsyncStorage operations are serialized by the native module. Keep only the
// newest not-yet-written value so typing and live event bursts cannot build an
// unbounded bridge/JSON backlog that starves interaction handling.
const snapshotWrites = new Map<string, SnapshotWriteState>()
const workspaceWrites = new Map<string, WorkspaceWriteState>()
let profileSettingsWrite: Promise<void> = Promise.resolve()
let cacheNamespaceMigration: Promise<unknown> = Promise.resolve()
let snapshotCachePreparation: Promise<void> | null = null

export interface CachedServerSummary {
  namespace: string
  sessionCount: number
  activeSessionCount: number
  archivedSessionCount: number
  unreadCount: number
  pinnedCount: number
  updatedAt: number | null
}

export interface CacheNamespaceMigrationResult {
  sourceNamespace: string
  targetNamespace: string
  migrated: boolean
  moved: boolean
  sourceSessionCount: number
  targetSessionCountBefore: number
  targetSummary: CachedServerSummary
  /** Source keys whose parsed values are represented in the verified target. */
  verifiedSourceKeys: string[]
  /** True only when the source copy has been removed after target verification. */
  sourceCleaned: boolean
}

export { CacheNamespaceCollisionError }

/**
 * Invalidates snapshot storage by key generation before any snapshot value is
 * read. Snapshot payloads can be very large, so an upgrade must delete legacy
 * values from the key index rather than loading and parsing each value first.
 */
export function prepareSnapshotCacheGeneration(): Promise<void> {
  if (snapshotCachePreparation) return snapshotCachePreparation

  const generation = String(SNAPSHOT_CACHE_VERSION)
  const operation = (async () => {
    if (await AsyncStorage.getItem(SNAPSHOT_CACHE_GENERATION_KEY) === generation) return

    const allKeys = await AsyncStorage.getAllKeys()
    const legacyKeys = allKeys.filter(key => (
      key.startsWith(SNAPSHOT_STORAGE_PREFIX) || key.startsWith(SNAPSHOT_RECENT_PREFIX)
    ))
    if (legacyKeys.length) await AsyncStorage.multiRemove(legacyKeys)
    // Commit the marker last. An interrupted cleanup is therefore retried on
    // the next launch instead of trusting a partially invalidated cache.
    await AsyncStorage.setItem(SNAPSHOT_CACHE_GENERATION_KEY, generation)
  })()
  snapshotCachePreparation = operation.catch(error => {
    snapshotCachePreparation = null
    throw error
  })
  return snapshotCachePreparation
}

export async function loadProfileSettings(): Promise<StoredProfileSettings> {
  const stored = await AsyncStorage.getItem(PROFILE_SETTINGS_KEY)
  if (stored) {
    const parsed = JSON.parse(stored) as unknown
    const normalized = normalizeStoredProfileSettings(parsed)
    // This durably records credentialVersion=1 for settings written before
    // credential versioning, before any caller can advance that version.
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await saveProfileSettings(normalized)
    return normalized
  }

  const legacyRaw = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY)
  let migration = createDefaultProfileSettings()
  if (legacyRaw) {
    try { migration = migrateLegacyProfileSettings(JSON.parse(legacyRaw) as unknown) }
    catch { /* a corrupt legacy preference must not block a safe default migration */ }
  }

  const profile = migration.settings.profiles[0]
  const legacyToken = await loadLegacyToken()
  if (legacyToken) {
    await saveProfileToken(profile.id, profile.credentialVersion, legacyToken)
    if (await loadProfileToken(profile.id, profile.credentialVersion) !== legacyToken) {
      throw new Error('The saved access token could not be migrated safely.')
    }
  }

  const workspaceNamespace = profileNamespace(profile)
  const urlNamespace = legacyCacheNamespace(profile.serverURL)
  if (urlNamespace !== workspaceNamespace) {
    await migrateCacheNamespace(urlNamespace, workspaceNamespace)
  }
  const existingWorkspace = await loadWorkspacePreferences(workspaceNamespace)
  await saveWorkspacePreferences(
    workspaceNamespace,
    mergeWorkspacePreferences(migration.workspace, existingWorkspace),
  )
  await saveProfileSettings(migration.settings)

  const verifiedRaw = await AsyncStorage.getItem(PROFILE_SETTINGS_KEY)
  if (!verifiedRaw) throw new Error('Profile settings migration could not be verified.')
  const verified = normalizeStoredProfileSettings(JSON.parse(verifiedRaw) as unknown)
  if (verified.activeProfileId !== profile.id || !verified.profiles.some(value => value.id === profile.id)) {
    throw new Error('Profile settings migration produced an invalid active profile.')
  }
  if (urlNamespace !== workspaceNamespace) {
    // The target and profile metadata are now durable. Cleanup is retryable
    // and failure only leaves a harmless fallback copy behind.
    await cleanupCacheNamespace(urlNamespace, workspaceNamespace).catch(() => undefined)
  }
  if (!legacyToken || await loadProfileToken(profile.id, profile.credentialVersion) === legacyToken) {
    await deleteLegacyTokenAfterVerifiedMigration()
  }
  return verified
}

export async function saveProfileSettings(value: StoredProfileSettings): Promise<void> {
  const normalized = normalizeStoredProfileSettings(value)
  const write = profileSettingsWrite.catch(() => undefined).then(() => (
    AsyncStorage.setItem(PROFILE_SETTINGS_KEY, JSON.stringify(normalized))
  ))
  profileSettingsWrite = write
  await write
}

export async function loadProfileToken(profileId: string, credentialVersion: number): Promise<string> {
  const version = requireCredentialVersion(credentialVersion)
  const token = await readStoredToken(
    profileTokenKey(profileId, version),
    profileTokenFallbackKey(profileId, version),
  )
  if (token !== null) return token
  if (version !== 1) return ''

  // Adopt the unversioned per-profile record without deleting it. Metadata
  // that selects version 1 may not have committed yet, so the old record is
  // deliberately retained as a crash-safe fallback.
  const legacyToken = await readStoredToken(
    legacyProfileTokenKey(profileId),
    legacyProfileTokenFallbackKey(profileId),
  )
  if (legacyToken === null) return ''
  try {
    await saveProfileToken(profileId, version, legacyToken)
    const migrated = await readStoredToken(
      profileTokenKey(profileId, version),
      profileTokenFallbackKey(profileId, version),
    )
    if (migrated === legacyToken) return migrated
  } catch { /* the legacy record remains authoritative and readable */ }
  return legacyToken
}

export async function saveProfileToken(profileId: string, credentialVersion: number, token: string): Promise<void> {
  const version = requireCredentialVersion(credentialVersion)
  if (typeof token !== 'string') throw new Error('The server access token must be a string.')
  const secureKey = profileTokenKey(profileId, version)
  const fallbackKey = profileTokenFallbackKey(profileId, version)
  try {
    if (token) await SecureStore.setItemAsync(secureKey, token)
    else await SecureStore.deleteItemAsync(secureKey)
    await AsyncStorage.removeItem(fallbackKey)
  } catch {
    if (token) await AsyncStorage.setItem(fallbackKey, token)
    else await AsyncStorage.removeItem(fallbackKey)
  }
}

/**
 * Writes a replacement to a non-authoritative version and verifies it. The
 * caller must next commit that returned version to profile metadata, then
 * delete the previously authoritative version.
 */
export async function stageProfileToken(
  profileId: string,
  currentCredentialVersion: number,
  token: string,
): Promise<number> {
  const nextVersion = nextCredentialVersion(requireCredentialVersion(currentCredentialVersion))
  await saveProfileToken(profileId, nextVersion, token)
  if (await loadProfileToken(profileId, nextVersion) !== token) {
    throw new Error('The replacement access token could not be verified safely.')
  }
  return nextVersion
}

export async function deleteProfileToken(profileId: string, credentialVersion: number): Promise<void> {
  const version = requireCredentialVersion(credentialVersion)
  await saveProfileToken(profileId, version, '')
  if (version === 1) await deleteLegacyProfileToken(profileId)
}

/** Expo SecureStore accepts only alphanumeric characters, `.`, `-`, and `_`. */
export function profileTokenKey(profileId: string, credentialVersion: number): string {
  return `${PROFILE_TOKEN_PREFIX}${profileCredentialKeySuffix(profileId)}.v${requireCredentialVersion(credentialVersion)}`
}

export function legacyCacheNamespace(serverURL: string): string {
  return legacyURLCacheNamespace(serverURL)
}

export async function loadWorkspacePreferences(cacheNamespace: string): Promise<WorkspacePreferences> {
  try {
    const raw = await AsyncStorage.getItem(workspaceKey(cacheNamespace))
    return raw ? normalizeWorkspacePreferences(JSON.parse(raw) as unknown) : normalizeWorkspacePreferences(null)
  } catch { return normalizeWorkspacePreferences(null) }
}

export function saveWorkspacePreferences(cacheNamespace: string, value: WorkspacePreferences): Promise<void> {
  const namespace = requireCacheNamespace(cacheNamespace)
  const key = workspaceKey(namespace)
  const normalized = normalizeWorkspacePreferences(value)
  let state = workspaceWrites.get(key)
  if (!state) {
    state = { running: false, pending: null, idleResolvers: [] }
    workspaceWrites.set(key, state)
  }
  if (state.pending) {
    state.pending.value = normalized
    return state.pending.completion.promise
  }
  const completion = createWriteCompletion()
  state.pending = { value: normalized, completion }
  if (!state.running) {
    state.running = true
    void drainWorkspaceWrites(key, state)
  }
  return completion.promise
}

async function drainWorkspaceWrites(key: string, state: WorkspaceWriteState): Promise<void> {
  while (state.pending) {
    const entry = state.pending
    state.pending = null
    try {
      await AsyncStorage.setItem(key, JSON.stringify(entry.value))
      entry.completion.resolve()
    } catch (error) {
      entry.completion.reject(error)
    }
  }
  state.running = false
  for (const resolve of state.idleResolvers.splice(0)) resolve()
  if (workspaceWrites.get(key) === state) workspaceWrites.delete(key)
}

export async function loadCachedSessions(cacheNamespace: string): Promise<Session[]> {
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(sessionsKey(cacheNamespace)) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed as Session[] : []
  } catch { return [] }
}

export async function saveCachedSessions(cacheNamespace: string, sessions: Session[]): Promise<void> {
  await AsyncStorage.setItem(sessionsKey(cacheNamespace), JSON.stringify(sessions))
}

export async function loadSnapshot(cacheNamespace: string, sessionId: string): Promise<Snapshot | null> {
  try {
    // Never bridge or parse a snapshot until the cache generation is known to
    // be current. Legacy snapshots can be large enough to exhaust mobile JS
    // memory before their version field can be inspected.
    await prepareSnapshotCacheGeneration()
    const key = snapshotKey(cacheNamespace, sessionId)
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Snapshot
    if (parsed?.session?.id !== sessionId || !Array.isArray(parsed.events)) return null
    const trusted = parsed.cacheVersion === SNAPSHOT_CACHE_VERSION
    if (!trusted) {
      // Older builds could persist a disconnected history slice under the
      // correct session key. Do not flash that unverified content while the
      // authoritative server tail is loading after an upgrade.
      await AsyncStorage.removeItem(key)
      return null
    }
    const matchingEvents = parsed.events
      .filter(event => event?.session_id === sessionId && Number.isFinite(event.seq))
      .sort((left, right) => left.seq - right.seq)
    const latestSeq = matchingEvents.reduce(
      (latest, event) => Math.max(latest, event.seq),
      typeof parsed.latestSeq === 'number' && Number.isFinite(parsed.latestSeq) ? parsed.latestSeq : 0,
    )
    const visibleEvents = matchingEvents
      .filter(event => event.type !== 'raw_event')
      .map(sanitizeTimelineEvent)
    const events = boundLiveTimelineEvents(visibleEvents).slice(-CACHE_SNAPSHOT_EVENT_LIMIT)
    const eventsTruncated = visibleEvents.length > events.length
    const visibleTotal = typeof parsed.total === 'number' && Number.isFinite(parsed.total) ? parsed.total : null
    if (!events.length && latestSeq > 0) {
      // A raw-only legacy cache has a valid transport cursor but no renderable
      // anchor. Force one authoritative tail instead of reconciling after that
      // cursor forever and presenting a blank chat.
      await removeSnapshot(cacheNamespace, sessionId)
      return null
    }
    const snapshot: Snapshot = {
      ...parsed,
      cacheVersion: SNAPSHOT_CACHE_VERSION,
      events,
      queuedTurns: Array.isArray(parsed.queuedTurns)
        ? parsed.queuedTurns
          .filter(turn => !turn.session_id || turn.session_id === sessionId)
          .map(sanitizeQueuedTurn)
        : [],
      files: Array.isArray(parsed.files)
        ? parsed.files
          .filter(file => !file.session_id || file.session_id === sessionId)
          .map(file => sanitizeTimelineFile(file) ?? file)
        : [],
      hasMore: Boolean(parsed.hasMore) || eventsTruncated || (visibleTotal !== null && visibleTotal > events.length),
      // Keep the authoritative transport cursor even when invisible raw
      // provider packets are removed from the rendered/persisted transcript.
      latestSeq,
    }
    snapshot.latestSeq = Math.max(latestSeq, snapshotLatestSeq(snapshot))
    if (events.length !== parsed.events.length) {
      void saveSnapshot(cacheNamespace, snapshot).catch(() => undefined)
    }
    return snapshot
  } catch { return null }
}

export function saveSnapshot(cacheNamespace: string, snapshot: Snapshot): Promise<void> {
  if (snapshot.session.archived) return Promise.resolve()
  const namespace = requireCacheNamespace(cacheNamespace)
  let state = snapshotWrites.get(namespace)
  if (!state) {
    state = { running: false, pending: new Map(), idleResolvers: [] }
    snapshotWrites.set(namespace, state)
  }
  const pending = state.pending.get(snapshot.session.id)
  if (pending) {
    // A queued deletion supersedes late stream/cache saves for that session.
    if (pending.snapshot) pending.snapshot = snapshot
    return pending.completion.promise
  }
  const completion = createWriteCompletion()
  state.pending.set(snapshot.session.id, { sessionId: snapshot.session.id, snapshot, completion })
  if (!state.running) {
    state.running = true
    void drainSnapshotWrites(namespace, state)
  }
  return completion.promise
}

async function drainSnapshotWrites(cacheNamespace: string, state: SnapshotWriteState): Promise<void> {
  while (state.pending.size) {
    const first = state.pending.entries().next().value as [string, SnapshotWriteEntry] | undefined
    if (!first) break
    const [sessionId, entry] = first
    state.pending.delete(sessionId)
    try {
      if (entry.snapshot) await writeSnapshot(cacheNamespace, entry.snapshot)
      else await deleteSnapshot(cacheNamespace, entry.sessionId)
      entry.completion.resolve()
    } catch (error) {
      entry.completion.reject(error)
    }
  }
  state.running = false
  for (const resolve of state.idleResolvers.splice(0)) resolve()
  if (snapshotWrites.get(cacheNamespace) === state) snapshotWrites.delete(cacheNamespace)
}

async function writeSnapshot(cacheNamespace: string, snapshot: Snapshot): Promise<void> {
  // Coordinate writes with generation cleanup so a new snapshot cannot be
  // deleted by a concurrently starting legacy-cache purge.
  await prepareSnapshotCacheGeneration()
  const trusted = snapshot.cacheVersion === SNAPSHOT_CACHE_VERSION
  const allMatchingEvents = snapshot.events
    .filter(event => event?.session_id === snapshot.session.id && Number.isFinite(event.seq))
    .sort((left, right) => left.seq - right.seq)
  const matchingEvents = allMatchingEvents
    .filter(event => event.type !== 'raw_event')
    .map(sanitizeTimelineEvent)
  const boundedEvents = boundLiveTimelineEvents(matchingEvents)
  const events = boundedEvents.slice(-(trusted ? CACHE_SNAPSHOT_EVENT_LIMIT : CACHE_LEGACY_EVENT_LIMIT))
  const eventsTruncated = matchingEvents.length > events.length
  const queuedTurns = snapshot.queuedTurns
    .filter(turn => !turn.session_id || turn.session_id === snapshot.session.id)
    .map(sanitizeQueuedTurn)
  const files = snapshot.files
    .filter(file => !file.session_id || file.session_id === snapshot.session.id)
    .map(file => sanitizeTimelineFile(file) ?? file)
  const storedCursor = typeof snapshot.latestSeq === 'number' && Number.isFinite(snapshot.latestSeq) ? snapshot.latestSeq : 0
  const latestSeq = allMatchingEvents.reduce((latest, event) => Math.max(latest, event.seq), storedCursor)
  const visibleTotal = typeof snapshot.total === 'number' && Number.isFinite(snapshot.total) ? snapshot.total : null
  const compact: Snapshot = {
    ...snapshot,
    cacheVersion: trusted ? SNAPSHOT_CACHE_VERSION : undefined,
    events,
    queuedTurns,
    files,
    hasMore: snapshot.hasMore || eventsTruncated || (visibleTotal !== null && visibleTotal > events.length),
    latestSeq,
    cachedAt: Date.now(),
  }
  await AsyncStorage.setItem(snapshotKey(cacheNamespace, snapshot.session.id), JSON.stringify(compact))
  let recent: string[] = []
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(recentKey(cacheNamespace)) ?? '[]') as unknown
    if (Array.isArray(parsed)) recent = parsed.filter((value): value is string => typeof value === 'string')
  } catch { /* reset */ }
  recent = [snapshot.session.id, ...recent.filter(id => id !== snapshot.session.id)]
  const evicted = recent.slice(CACHE_SNAPSHOT_SESSION_LIMIT)
  await AsyncStorage.setItem(recentKey(cacheNamespace), JSON.stringify(recent.slice(0, CACHE_SNAPSHOT_SESSION_LIMIT)))
  await Promise.all(evicted.map(id => AsyncStorage.removeItem(snapshotKey(cacheNamespace, id))))
}

export function removeSnapshot(cacheNamespace: string, sessionId: string): Promise<void> {
  const namespace = requireCacheNamespace(cacheNamespace)
  let state = snapshotWrites.get(namespace)
  if (!state) {
    state = { running: false, pending: new Map(), idleResolvers: [] }
    snapshotWrites.set(namespace, state)
  }
  const pending = state.pending.get(sessionId)
  if (pending) {
    pending.snapshot = null
    return pending.completion.promise
  }
  const completion = createWriteCompletion()
  state.pending.set(sessionId, { sessionId, snapshot: null, completion })
  if (!state.running) {
    state.running = true
    void drainSnapshotWrites(namespace, state)
  }
  return completion.promise
}

async function deleteSnapshot(cacheNamespace: string, sessionId: string): Promise<void> {
  await AsyncStorage.removeItem(snapshotKey(cacheNamespace, sessionId))
  let recent: string[] = []
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(recentKey(cacheNamespace)) ?? '[]') as unknown
    if (Array.isArray(parsed)) recent = parsed.filter((value): value is string => typeof value === 'string')
  } catch { /* reset */ }
  await AsyncStorage.setItem(recentKey(cacheNamespace), JSON.stringify(recent.filter(id => id !== sessionId)))
}

export async function loadPins(cacheNamespace: string): Promise<PinnedItem[]> {
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(pinsKey(cacheNamespace)) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed as PinnedItem[] : []
  } catch { return [] }
}

export async function savePins(cacheNamespace: string, pins: PinnedItem[]): Promise<void> {
  await AsyncStorage.setItem(pinsKey(cacheNamespace), JSON.stringify(pins))
}

export async function cachedServerSummary(cacheNamespace: string): Promise<CachedServerSummary> {
  const sessions = await loadCachedSessions(cacheNamespace)
  return summarizeCachedSessions(cacheNamespace, sessions)
}

export async function migrateCacheNamespace(
  sourceNamespace: string,
  targetNamespace: string,
): Promise<CacheNamespaceMigrationResult> {
  const operation = cacheNamespaceMigration.catch(() => undefined).then(() => (
    performCacheNamespaceMigration(sourceNamespace, targetNamespace, false)
  ))
  cacheNamespaceMigration = operation
  return operation
}

/**
 * Re-verifies the target and only then removes the source namespace. Call this
 * after profile metadata selecting the target namespace has committed.
 */
export async function cleanupCacheNamespace(
  sourceNamespace: string,
  targetNamespace: string,
): Promise<CacheNamespaceMigrationResult> {
  const operation = cacheNamespaceMigration.catch(() => undefined).then(() => (
    performCacheNamespaceMigration(sourceNamespace, targetNamespace, true)
  ))
  cacheNamespaceMigration = operation
  return operation
}

/**
 * Deletes only successfully migrated fallback keys after the target copy and
 * selecting profile metadata have already been verified. Unlike
 * cleanupCacheNamespace, this never reads or rewrites the now-live target and
 * preserves malformed source rows for forensic recovery.
 */
export async function purgeCacheNamespace(sourceValue: string, verifiedSourceKeys: readonly string[]): Promise<number> {
  const operation = cacheNamespaceMigration.catch(() => undefined).then(async () => {
    const sourceNamespace = requireCacheNamespace(sourceValue)
    await Promise.all([
      waitForSnapshotWrites(sourceNamespace),
      waitForWorkspaceWrites(workspaceKey(sourceNamespace)),
    ])
    const snapshotPrefix = snapshotKeyPrefix(sourceNamespace)
    const fixedKeys = new Set([
      sessionsKey(sourceNamespace),
      recentKey(sourceNamespace),
      pinsKey(sourceNamespace),
      workspaceKey(sourceNamespace),
    ])
    const sourceKeys = uniqueStrings(verifiedSourceKeys)
    if (sourceKeys.some(key => !fixedKeys.has(key) && !key.startsWith(snapshotPrefix))) {
      throw new Error('Fallback cleanup received a key outside its cache namespace.')
    }
    if (sourceKeys.length) await AsyncStorage.multiRemove(sourceKeys)
    return sourceKeys.length
  })
  cacheNamespaceMigration = operation
  return operation
}

async function performCacheNamespaceMigration(
  sourceValue: string,
  targetValue: string,
  cleanupSource: boolean,
): Promise<CacheNamespaceMigrationResult> {
  const sourceNamespace = requireCacheNamespace(sourceValue)
  const targetNamespace = requireCacheNamespace(targetValue)
  if (sourceNamespace === targetNamespace) {
    const summary = await cachedServerSummary(targetNamespace)
    return {
      sourceNamespace,
      targetNamespace,
      migrated: false,
      moved: false,
      sourceSessionCount: summary.sessionCount,
      targetSessionCountBefore: summary.sessionCount,
      targetSummary: summary,
      verifiedSourceKeys: [],
      sourceCleaned: true,
    }
  }

  await Promise.all([
    waitForSnapshotWrites(sourceNamespace),
    waitForSnapshotWrites(targetNamespace),
    waitForWorkspaceWrites(workspaceKey(sourceNamespace)),
    waitForWorkspaceWrites(workspaceKey(targetNamespace)),
  ])

  const allKeys = await AsyncStorage.getAllKeys()
  const [source, target] = await Promise.all([
    readNamespacePayload(sourceNamespace, allKeys),
    readNamespacePayload(targetNamespace, allKeys),
  ])
  const sourceSessionCount = source.payload.sessions.length
  const targetSessionCountBefore = target.payload.sessions.length
  if (!source.presentKeys.length) {
    return {
      sourceNamespace,
      targetNamespace,
      migrated: false,
      moved: false,
      sourceSessionCount,
      targetSessionCountBefore,
      targetSummary: await cachedServerSummary(targetNamespace),
      verifiedSourceKeys: [],
      sourceCleaned: true,
    }
  }

  const merged = mergeNamespaceCachePayload(source.payload, target.payload, sourceNamespace, targetNamespace)
  const targetPairs = namespacePayloadPairs(targetNamespace, merged)
  await AsyncStorage.multiSet(targetPairs)
  const verification = await AsyncStorage.multiGet(targetPairs.map(([key]) => key))
  const verifiedByKey = new Map(verification)
  for (const [key, expected] of targetPairs) {
    if (verifiedByKey.get(key) !== expected) {
      throw new Error(`Cache namespace migration could not verify ${key}.`)
    }
  }

  if (cleanupSource) {
    const desiredTargetKeys = new Set(targetPairs.map(([key]) => key))
    const staleTargetSnapshots = target.presentKeys.filter(key => (
      key.startsWith(snapshotKeyPrefix(targetNamespace)) && !desiredTargetKeys.has(key)
    ))
    if (staleTargetSnapshots.length) await AsyncStorage.multiRemove(staleTargetSnapshots)

    // AsyncStorage has no transaction. Metadata already selects the target,
    // which was verified above, so interruption here can only leave an extra
    // source copy for a later cleanup retry.
    await AsyncStorage.multiRemove(source.presentKeys)
  }
  return {
    sourceNamespace,
    targetNamespace,
    migrated: true,
    moved: cleanupSource && !target.presentKeys.length,
    sourceSessionCount,
    targetSessionCountBefore,
    targetSummary: await cachedServerSummary(targetNamespace),
    verifiedSourceKeys: [...source.presentKeys],
    sourceCleaned: cleanupSource,
  }
}

function waitForSnapshotWrites(cacheNamespace: string): Promise<void> {
  const state = snapshotWrites.get(requireCacheNamespace(cacheNamespace))
  if (!state?.running) return Promise.resolve()
  return new Promise(resolve => state.idleResolvers.push(resolve))
}

function waitForWorkspaceWrites(key: string): Promise<void> {
  const state = workspaceWrites.get(key)
  if (!state?.running) return Promise.resolve()
  return new Promise(resolve => state.idleResolvers.push(resolve))
}

interface ReadNamespacePayload {
  payload: NamespaceCachePayload
  presentKeys: string[]
}

async function readNamespacePayload(cacheNamespace: string, allKeys: readonly string[]): Promise<ReadNamespacePayload> {
  const snapshotPrefix = snapshotKeyPrefix(cacheNamespace)
  const snapshotKeys = allKeys.filter(key => key.startsWith(snapshotPrefix))
  const keys = uniqueStrings([
    sessionsKey(cacheNamespace),
    recentKey(cacheNamespace),
    pinsKey(cacheNamespace),
    workspaceKey(cacheNamespace),
    ...snapshotKeys,
  ])
  const pairs = await AsyncStorage.multiGet(keys)
  const values = new Map(pairs)
  const presentKeys: string[] = []
  const sessionsStorageKey = sessionsKey(cacheNamespace)
  const sessionsRaw = values.get(sessionsStorageKey)
  const parsedSessions = parseJSONArray<Session>(sessionsRaw)
  const sessions = parsedSessions ?? []
  if (sessionsRaw != null && parsedSessions) presentKeys.push(sessionsStorageKey)
  const recentStorageKey = recentKey(cacheNamespace)
  const recentRaw = values.get(recentStorageKey)
  const parsedRecent = parseJSONArray<unknown>(recentRaw)
  const recentSessionIds = (parsedRecent ?? []).filter((value): value is string => typeof value === 'string')
  if (recentRaw != null && parsedRecent) presentKeys.push(recentStorageKey)
  const pinsStorageKey = pinsKey(cacheNamespace)
  const pinsRaw = values.get(pinsStorageKey)
  const parsedPins = parseJSONArray<PinnedItem>(pinsRaw)
  const pins = parsedPins ?? []
  if (pinsRaw != null && parsedPins) presentKeys.push(pinsStorageKey)
  const workspaceStorageKey = workspaceKey(cacheNamespace)
  const workspaceRaw = values.get(workspaceStorageKey)
  const parsedWorkspace = parseJSON(workspaceRaw)
  const workspace = normalizeWorkspacePreferences(parsedWorkspace)
  if (workspaceRaw != null && parsedWorkspace !== undefined) presentKeys.push(workspaceStorageKey)
  const snapshots: Record<string, Snapshot> = {}
  for (const key of snapshotKeys) {
    const raw = values.get(key)
    if (raw === null || raw === undefined) continue
    const sessionId = key.slice(snapshotPrefix.length)
    const snapshot = parseJSON(raw) as Snapshot | undefined
    // Invalid legacy cache rows stay at the source key for forensic recovery,
    // but cannot block migration of every other valid workspace row.
    if (!sessionId || snapshot?.session?.id !== sessionId || !Array.isArray(snapshot.events)) continue
    snapshots[sessionId] = snapshot
    presentKeys.push(key)
  }
  return { payload: { sessions, recentSessionIds, snapshots, pins, workspace }, presentKeys }
}

function namespacePayloadPairs(cacheNamespace: string, payload: NamespaceCachePayload): Array<[string, string]> {
  return [
    [sessionsKey(cacheNamespace), JSON.stringify(payload.sessions)],
    [recentKey(cacheNamespace), JSON.stringify(payload.recentSessionIds)],
    [pinsKey(cacheNamespace), JSON.stringify(payload.pins)],
    [workspaceKey(cacheNamespace), JSON.stringify(payload.workspace)],
    ...Object.entries(payload.snapshots).map(([sessionId, snapshot]): [string, string] => (
      [snapshotKey(cacheNamespace, sessionId), JSON.stringify(snapshot)]
    )),
  ]
}

async function loadLegacyToken(): Promise<string> {
  try {
    const token = await SecureStore.getItemAsync(LEGACY_TOKEN_KEY)
    if (token !== null) return token
  } catch { /* fall through to the simulator fallback */ }
  try { return await AsyncStorage.getItem(LEGACY_TOKEN_FALLBACK_KEY) ?? '' }
  catch { return '' }
}

async function readStoredToken(secureKey: string, fallbackKey: string): Promise<string | null> {
  try {
    const token = await SecureStore.getItemAsync(secureKey)
    if (token !== null) return token
  } catch { /* unsigned simulator builds do not have Keychain entitlements */ }
  try { return await AsyncStorage.getItem(fallbackKey) }
  catch { return null }
}

async function deleteLegacyTokenAfterVerifiedMigration(): Promise<void> {
  try { await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY) }
  catch { /* a profile-specific fallback has already been verified */ }
  try { await AsyncStorage.removeItem(LEGACY_TOKEN_FALLBACK_KEY) }
  catch { /* retrying cleanup is optional; the profile credential is authoritative */ }
}

async function deleteLegacyProfileToken(profileId: string): Promise<void> {
  try { await SecureStore.deleteItemAsync(legacyProfileTokenKey(profileId)) }
  catch { /* the versioned credential is already authoritative */ }
  try { await AsyncStorage.removeItem(legacyProfileTokenFallbackKey(profileId)) }
  catch { /* cleanup is retryable and not required for correctness */ }
}

function legacyProfileTokenKey(profileId: string): string {
  return `${LEGACY_PROFILE_TOKEN_PREFIX}${profileCredentialKeySuffix(profileId)}`
}

function legacyProfileTokenFallbackKey(profileId: string): string {
  return `${LEGACY_PROFILE_TOKEN_FALLBACK_PREFIX}${profileCredentialKeySuffix(profileId)}`
}

function profileTokenFallbackKey(profileId: string, credentialVersion: number): string {
  return `${PROFILE_TOKEN_FALLBACK_PREFIX}${profileCredentialKeySuffix(profileId)}.v${requireCredentialVersion(credentialVersion)}`
}

function namespaceSegment(cacheNamespace: string): string {
  return encodeURIComponent(requireCacheNamespace(cacheNamespace))
}

function sessionsKey(cacheNamespace: string): string { return `agentsdock.react.sessions.${namespaceSegment(cacheNamespace)}` }
function snapshotKeyPrefix(cacheNamespace: string): string { return `${SNAPSHOT_STORAGE_PREFIX}${namespaceSegment(cacheNamespace)}.` }
function snapshotKey(cacheNamespace: string, sessionId: string): string { return `${snapshotKeyPrefix(cacheNamespace)}${sessionId}` }
function recentKey(cacheNamespace: string): string { return `${SNAPSHOT_RECENT_PREFIX}${namespaceSegment(cacheNamespace)}` }
function pinsKey(cacheNamespace: string): string { return `agentsdock.react.pins.${namespaceSegment(cacheNamespace)}` }
function workspaceKey(cacheNamespace: string): string { return `agentsdock.react.workspace.${namespaceSegment(cacheNamespace)}` }

function requireCacheNamespace(value: string): string {
  const namespace = value.trim()
  if (!namespace) throw new Error('Cache namespace cannot be empty.')
  return namespace
}

function requireCredentialVersion(value: number): number {
  const version = normalizeCredentialVersion(value)
  if (version !== value) throw new Error('The server credential version must be a positive safe integer.')
  return version
}

function sanitizeQueuedTurn(turn: QueuedTurn): QueuedTurn {
  return {
    ...turn,
    prompt: truncateCachedPrompt(turn.prompt),
    display_prompt: typeof turn.display_prompt === 'string'
      ? truncateCachedPrompt(turn.display_prompt)
      : turn.display_prompt,
  }
}

function truncateCachedPrompt(value: string): string {
  if (value.length <= CACHED_QUEUED_PROMPT_LIMIT) return value
  return `${value.slice(0, CACHED_QUEUED_PROMPT_LIMIT - CACHE_TRUNCATION_SUFFIX.length).trimEnd()}${CACHE_TRUNCATION_SUFFIX}`
}

function parseJSONArray<T>(raw: string | null | undefined): T[] | null {
  const value = parseJSON(raw)
  return Array.isArray(value) ? value as T[] : null
}

function parseJSON(raw: string | null | undefined): unknown | undefined {
  if (raw === null || raw === undefined) return undefined
  try { return JSON.parse(raw) as unknown }
  catch { return undefined }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function createWriteCompletion(): WriteCompletion {
  let resolve: () => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
