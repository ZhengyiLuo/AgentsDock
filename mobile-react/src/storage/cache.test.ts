import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { Event, PinnedItem, Session, Snapshot, StoredProfileSettings, WorkspacePreferences } from '../types'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import { profileCredentialKeySuffix } from '../lib/server-profiles'
import {
  cleanupCacheNamespace,
  deleteProfileToken,
  loadCachedSessions,
  loadPins,
  loadProfileSettings,
  loadProfileToken,
  loadSnapshot,
  loadWorkspacePreferences,
  migrateCacheNamespace,
  prepareSnapshotCacheGeneration,
  profileTokenKey,
  purgeCacheNamespace,
  removeSnapshot,
  saveCachedSessions,
  savePins,
  saveProfileSettings,
  saveSnapshot,
  saveWorkspacePreferences,
  stageProfileToken,
} from './cache'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function cachedWorkspace(draft: string): WorkspacePreferences {
  return {
    selectedSessionId: 'chat-a',
    folderOrder: [],
    collapsedFolders: [],
    drafts: { 'chat-a': draft },
  }
}

const resetSecureStore = (SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore
await AsyncStorage.clear()
resetSecureStore()

assert(profileTokenKey('profile-a', 1) !== profileTokenKey('profile-a', 2), 'credential versions must use distinct keys')
const timestamp = '2026-07-18T12:00:00.000Z'
const legacySettingsProfile = {
  id: 'profile-a',
  name: 'Alpha',
  serverURL: 'http://alpha.example:7850',
  serverIdentity: 'server-alpha',
  serverConfigured: true,
  createdAt: timestamp,
  updatedAt: timestamp,
}
await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify({
  schemaVersion: 2,
  activeProfileId: 'profile-a',
  profiles: [legacySettingsProfile],
  fontScale: 1,
}))
const normalizedLegacySettings = await loadProfileSettings()
assertEqual(normalizedLegacySettings.profiles[0].credentialVersion, 1)
const durableNormalizedSettings = JSON.parse(await AsyncStorage.getItem('agentsdock.react.settings.v2') ?? '{}') as StoredProfileSettings
assertEqual(durableNormalizedSettings.profiles[0].credentialVersion, 1)

const legacyProfileTokenKey = `agentsdock.react.access-token.profile.${profileCredentialKeySuffix('profile-a')}`
await SecureStore.setItemAsync(legacyProfileTokenKey, 'old-token')
assertEqual(await loadProfileToken('profile-a', 1), 'old-token')
assertEqual(await SecureStore.getItemAsync(profileTokenKey('profile-a', 1)), 'old-token')
assertEqual(await SecureStore.getItemAsync(legacyProfileTokenKey), 'old-token')
const replacementVersion = await stageProfileToken('profile-a', 1, 'new-token')
assertEqual(replacementVersion, 2)

// A crash before metadata commit leaves version 1 authoritative and intact.
assertEqual(await loadProfileToken('profile-a', 1), 'old-token')
assertEqual(await loadProfileToken('profile-a', replacementVersion), 'new-token')

const settings: StoredProfileSettings = {
  schemaVersion: 2,
  activeProfileId: 'profile-a',
  profiles: [{
    id: 'profile-a',
    name: 'Alpha',
    serverURL: 'http://alpha.example:7850',
    serverIdentity: 'server-alpha',
    serverConfigured: true,
    credentialVersion: replacementVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
  }],
  fontScale: 1,
}
await saveProfileSettings(settings)
await deleteProfileToken('profile-a', 1)
assertEqual(await loadProfileToken('profile-a', 1), '')
assertEqual(await SecureStore.getItemAsync(legacyProfileTokenKey), null)
assertEqual(await loadProfileToken('profile-a', replacementVersion), 'new-token')

// Removing a token stages an empty next version without touching the current token.
const emptyVersion = await stageProfileToken('profile-a', replacementVersion, '')
assertEqual(emptyVersion, 3)
assertEqual(await loadProfileToken('profile-a', replacementVersion), 'new-token')
assertEqual(await loadProfileToken('profile-a', emptyVersion), '')

const cachedSession: Session = {
  id: 'chat-a',
  title: 'Cached A',
  backend: 'codex',
  codex_thread_id: 'thread-a',
}
await saveCachedSessions('legacy-url', [cachedSession])
const stagedMigration = await migrateCacheNamespace('legacy-url', 'server-alpha')
assertEqual(stagedMigration.sourceCleaned, false)
assertEqual(stagedMigration.moved, false)
assertEqual((await loadCachedSessions('legacy-url')).map(session => session.id), ['chat-a'])
assertEqual((await loadCachedSessions('server-alpha')).map(session => session.id), ['chat-a'])

// Only the explicit post-metadata cleanup removes the fallback namespace.
const cleanedMigration = await cleanupCacheNamespace('legacy-url', 'server-alpha')
assertEqual(cleanedMigration.sourceCleaned, true)
assertEqual((await loadCachedSessions('legacy-url')).map(session => session.id), [])
assertEqual((await loadCachedSessions('server-alpha')).map(session => session.id), ['chat-a'])

// Post-commit source purging must not read or rewrite a target that has already
// resumed live writes.
await saveCachedSessions('legacy-purge', [{ ...cachedSession, title: 'Fallback copy' }])
await saveWorkspacePreferences('legacy-purge', cachedWorkspace('fallback draft'))
const corruptFallbackKey = 'agentsdock.react.snapshot.legacy-purge.corrupt'
await AsyncStorage.setItem(corruptFallbackKey, 'not-json')
const liveMigration = await migrateCacheNamespace('legacy-purge', 'server-live')
await saveCachedSessions('server-live', [{ ...cachedSession, title: 'Live server state' }])
await saveWorkspacePreferences('server-live', cachedWorkspace('live draft'))
assert((await purgeCacheNamespace('legacy-purge', liveMigration.verifiedSourceKeys)) > 0, 'The migrated fallback keys should be removed')
assertEqual(await loadCachedSessions('legacy-purge'), [])
assertEqual((await loadCachedSessions('server-live'))[0]?.title, 'Live server state')
assertEqual((await loadWorkspacePreferences('server-live')).drafts['chat-a'], 'live draft')
assertEqual(await AsyncStorage.getItem(corruptFallbackKey), 'not-json')

// Snapshot generations are invalidated from the key index. In particular, an
// oversized legacy payload must never cross the bridge or reach JSON.parse.
const generationNamespace = 'generation-preserve'
const generationSnapshotKey = `agentsdock.react.snapshot.${generationNamespace}.chat-legacy`
const generationRecentKey = `agentsdock.react.recent.${generationNamespace}`
const oversizedLegacySnapshot = `legacy:${'x'.repeat(2_500_000)}`
const preservedWorkspace: WorkspacePreferences = {
  selectedSessionId: 'chat-preserved',
  folderOrder: [],
  collapsedFolders: [],
  drafts: { 'chat-preserved': 'keep this draft' },
  chatDefaults: { backend: 'codex', model: '', effort: '', folder: 'General', cwd: '' },
}
const preservedPins: PinnedItem[] = [{
  id: 'pin-preserved',
  sessionId: 'chat-preserved',
  kind: 'message',
  eventId: 'event-preserved',
  title: 'Keep this pin',
  createdAt: Date.now(),
}]
await saveCachedSessions(generationNamespace, [{ ...cachedSession, id: 'chat-preserved' }])
await saveWorkspacePreferences(generationNamespace, preservedWorkspace)
await savePins(generationNamespace, preservedPins)
await AsyncStorage.setItem(generationSnapshotKey, oversizedLegacySnapshot)
await AsyncStorage.setItem(generationRecentKey, JSON.stringify(['chat-legacy']))

const originalGenerationGetItem = AsyncStorage.getItem
const originalGenerationMultiGet = AsyncStorage.multiGet
const originalJSONParse = JSON.parse
let oversizedSnapshotRead = false
let oversizedSnapshotParsed = false
AsyncStorage.getItem = async (key: string) => {
  const value = await originalGenerationGetItem(key)
  if (key === generationSnapshotKey && value === oversizedLegacySnapshot) {
    oversizedSnapshotRead = true
    throw new Error('legacy snapshot payload must not be read')
  }
  return value
}
AsyncStorage.multiGet = async (keys: readonly string[]) => {
  const values = await originalGenerationMultiGet(keys)
  if (values.some(([key, value]) => key === generationSnapshotKey && value === oversizedLegacySnapshot)) {
    oversizedSnapshotRead = true
    throw new Error('legacy snapshot payload must not be batch-read')
  }
  return values
}
JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
  if (text === oversizedLegacySnapshot) oversizedSnapshotParsed = true
  return originalJSONParse(text, reviver)
}) as typeof JSON.parse
try {
  // loadSnapshot itself must start generation cleanup; callers cannot be
  // trusted to remember a separate initialization step.
  const legacyLoad = loadSnapshot(generationNamespace, 'chat-legacy')
  const firstPreparation = prepareSnapshotCacheGeneration()
  const concurrentPreparation = prepareSnapshotCacheGeneration()
  assert(firstPreparation === concurrentPreparation, 'snapshot generation preparation must be shared')
  const [legacySnapshot] = await Promise.all([legacyLoad, firstPreparation, concurrentPreparation])
  assertEqual(legacySnapshot, null)
} finally {
  AsyncStorage.getItem = originalGenerationGetItem
  AsyncStorage.multiGet = originalGenerationMultiGet
  JSON.parse = originalJSONParse
}
assertEqual(oversizedSnapshotRead, false)
assertEqual(oversizedSnapshotParsed, false)
assertEqual(await AsyncStorage.getItem(generationSnapshotKey), null)
assertEqual(await AsyncStorage.getItem(generationRecentKey), null)
assertEqual(await AsyncStorage.getItem('agentsdock.react.snapshot-cache-generation'), String(SNAPSHOT_CACHE_VERSION))
assertEqual((await loadCachedSessions(generationNamespace)).map(session => session.id), ['chat-preserved'])
assertEqual(await loadWorkspacePreferences(generationNamespace), preservedWorkspace)
assertEqual(await loadPins(generationNamespace), preservedPins)

function timelineEvent(sessionId: string, seq: number, type = 'assistant_text'): Event {
  return {
    id: `${sessionId}-event-${seq}`,
    session_id: sessionId,
    seq,
    type,
    ts: new Date(Date.UTC(2026, 6, 18, 12, 0, seq % 60)).toISOString(),
    text: type === 'raw_event' ? undefined : `Message ${seq}`,
    raw: type === 'raw_event' ? `provider packet ${seq}` : undefined,
  }
}

function timelineSnapshot(sessionId: string, events: Event[], latestSeq = events.at(-1)?.seq ?? 0): Snapshot {
  return {
    cacheVersion: SNAPSHOT_CACHE_VERSION,
    session: { id: sessionId, title: sessionId, backend: 'codex', codex_thread_id: `thread-${sessionId}` },
    events,
    queuedTurns: [],
    files: [],
    filesTotal: 0,
    hasMore: false,
    latestSeq,
    cachedAt: Date.now(),
  }
}

// Invisible provider packets must never inflate the durable transcript, while
// their transport cursor remains authoritative for reconnects.
await saveSnapshot('snapshot-sanitize', timelineSnapshot('chat-raw', [
  timelineEvent('chat-raw', 1),
  timelineEvent('chat-raw', 2, 'raw_event'),
], 2))
const sanitized = await loadSnapshot('snapshot-sanitize', 'chat-raw')
assert(sanitized, 'sanitized snapshot must load')
assertEqual(sanitized.events.map(event => event.type), ['assistant_text'])
assertEqual(sanitized.latestSeq, 2)

// Oversized event fields are bounded before persistence and remain bounded
// when a trusted cache row is hydrated back into application state.
const oversizedEvent = timelineEvent('chat-oversized', 1)
oversizedEvent.text = 't'.repeat(100_000)
oversizedEvent.output = 'o'.repeat(100_000)
oversizedEvent.raw = 'r'.repeat(100_000)
const oversizedSnapshot = timelineSnapshot('chat-oversized', [oversizedEvent])
oversizedSnapshot.files = [{
  id: 'oversized-file',
  session_id: 'chat-oversized',
  filename: 'oversized.txt',
  text: 'f'.repeat(100_000),
}]
oversizedSnapshot.queuedTurns = [{
  queued_id: 'oversized-turn',
  session_id: 'chat-oversized',
  prompt: 'q'.repeat(100_000),
  display_prompt: 'd'.repeat(100_000),
  file_ids: [],
}]
await saveSnapshot('snapshot-oversized', oversizedSnapshot)
const oversizedStorageKey = 'agentsdock.react.snapshot.snapshot-oversized.chat-oversized'
const persistedOversized = JSON.parse(await AsyncStorage.getItem(oversizedStorageKey) ?? '{}') as Snapshot
assert((persistedOversized.events[0]?.text?.length ?? 0) <= 48_000, 'snapshot writes must bound message text')
assert((persistedOversized.events[0]?.output?.length ?? 0) <= 8_000, 'snapshot writes must bound trace output')
assertEqual(persistedOversized.events[0]?.raw, undefined)
assert((persistedOversized.files[0]?.text?.length ?? 0) <= 12_000, 'snapshot writes must bound attached file text')
assert((persistedOversized.queuedTurns[0]?.prompt.length ?? 0) <= 48_000, 'snapshot writes must bound queued prompts')
assert((persistedOversized.queuedTurns[0]?.display_prompt?.length ?? 0) <= 48_000, 'snapshot writes must bound queued display prompts')

// Defense in depth: even a malformed current-generation row cannot re-enter
// state with an unbounded event payload.
persistedOversized.events[0] = oversizedEvent
persistedOversized.files = oversizedSnapshot.files
persistedOversized.queuedTurns = oversizedSnapshot.queuedTurns
await AsyncStorage.setItem(oversizedStorageKey, JSON.stringify(persistedOversized))
const hydratedOversized = await loadSnapshot('snapshot-oversized', 'chat-oversized')
assert(hydratedOversized, 'trusted oversized snapshot must hydrate safely')
assert((hydratedOversized.events[0]?.text?.length ?? 0) <= 48_000, 'snapshot reads must bound message text')
assert((hydratedOversized.events[0]?.output?.length ?? 0) <= 8_000, 'snapshot reads must bound trace output')
assertEqual(hydratedOversized.events[0]?.raw, undefined)
assert((hydratedOversized.files[0]?.text?.length ?? 0) <= 12_000, 'snapshot reads must bound attached file text')
assert((hydratedOversized.queuedTurns[0]?.prompt.length ?? 0) <= 48_000, 'snapshot reads must bound queued prompts')
assert((hydratedOversized.queuedTurns[0]?.display_prompt?.length ?? 0) <= 48_000, 'snapshot reads must bound queued display prompts')

await saveSnapshot('snapshot-raw-only', timelineSnapshot('chat-raw-only', [timelineEvent('chat-raw-only', 7, 'raw_event')], 7))
assertEqual(await loadSnapshot('snapshot-raw-only', 'chat-raw-only'), null)

await saveSnapshot('snapshot-owned-cursor', timelineSnapshot('chat-owned', [
  timelineEvent('chat-owned', 1),
  timelineEvent('foreign-chat', 999),
], 1))
assertEqual((await loadSnapshot('snapshot-owned-cursor', 'chat-owned'))?.latestSeq, 1)

// Compaction must advertise the omitted older page so Load Older remains
// reachable after relaunching a previously complete long transcript.
const longEvents = Array.from({ length: 725 }, (_, index) => timelineEvent('chat-long', index + 1))
await saveSnapshot('snapshot-truncate', timelineSnapshot('chat-long', longEvents))
const truncated = await loadSnapshot('snapshot-truncate', 'chat-long')
assert(truncated, 'truncated snapshot must load')
assertEqual(truncated.events.length, 720)
assertEqual(truncated.events[0]?.seq, 6)
assertEqual(truncated.hasMore, true)

// A burst can have one active native write and one newest pending write. All
// callers still resolve only after the newest value is durable.
const originalSetItem = AsyncStorage.setItem
let releaseSnapshotWrite: () => void = () => {}
let snapshotWriteStarted: () => void = () => {}
const snapshotGate = new Promise<void>(resolve => { releaseSnapshotWrite = resolve })
const snapshotStarted = new Promise<void>(resolve => { snapshotWriteStarted = resolve })
let snapshotWriteCount = 0
AsyncStorage.setItem = async (key: string, value: string) => {
  if (key.startsWith('agentsdock.react.snapshot.snapshot-coalesce.')) {
    snapshotWriteCount += 1
    if (snapshotWriteCount === 1) {
      snapshotWriteStarted()
      await snapshotGate
    }
  }
  await originalSetItem(key, value)
}
try {
  const first = saveSnapshot(' snapshot-coalesce ', timelineSnapshot('chat-burst', [timelineEvent('chat-burst', 1)]))
  await snapshotStarted
  const burst = Array.from({ length: 20 }, (_, index) => {
    const seq = index + 2
    return saveSnapshot('snapshot-coalesce', timelineSnapshot('chat-burst', [timelineEvent('chat-burst', seq)], seq))
  })
  assert(burst.every(promise => promise === burst[0]), 'coalesced snapshot saves must share one completion')
  releaseSnapshotWrite()
  await Promise.all([first, ...burst])
} finally {
  AsyncStorage.setItem = originalSetItem
}
assertEqual(snapshotWriteCount, 2)
assertEqual((await loadSnapshot('snapshot-coalesce', 'chat-burst'))?.latestSeq, 21)

let releaseWorkspaceWrite: () => void = () => {}
let workspaceWriteStarted: () => void = () => {}
const workspaceGate = new Promise<void>(resolve => { releaseWorkspaceWrite = resolve })
const workspaceStarted = new Promise<void>(resolve => { workspaceWriteStarted = resolve })
let workspaceWriteCount = 0
AsyncStorage.setItem = async (key: string, value: string) => {
  if (key === 'agentsdock.react.workspace.workspace-coalesce') {
    workspaceWriteCount += 1
    if (workspaceWriteCount === 1) {
      workspaceWriteStarted()
      await workspaceGate
    }
  }
  await originalSetItem(key, value)
}
try {
  const preference = (draft: string): WorkspacePreferences => ({ selectedSessionId: 'chat-burst', folderOrder: [], collapsedFolders: [], drafts: { 'chat-burst': draft } })
  const first = saveWorkspacePreferences('workspace-coalesce', preference('draft-1'))
  await workspaceStarted
  const burst = Array.from({ length: 20 }, (_, index) => saveWorkspacePreferences('workspace-coalesce', preference(`draft-${index + 2}`)))
  assert(burst.every(promise => promise === burst[0]), 'coalesced workspace saves must share one completion')
  releaseWorkspaceWrite()
  await Promise.all([first, ...burst])
} finally {
  AsyncStorage.setItem = originalSetItem
}
assertEqual(workspaceWriteCount, 2)
assertEqual((await loadWorkspacePreferences('workspace-coalesce')).drafts['chat-burst'], 'draft-21')

let releaseDeleteRace: () => void = () => {}
let deleteRaceStarted: () => void = () => {}
const deleteRaceGate = new Promise<void>(resolve => { releaseDeleteRace = resolve })
const deleteRaceStart = new Promise<void>(resolve => { deleteRaceStarted = resolve })
let deleteRaceWriteCount = 0
AsyncStorage.setItem = async (key: string, value: string) => {
  if (key.startsWith('agentsdock.react.snapshot.snapshot-delete-race.')) {
    deleteRaceWriteCount += 1
    if (deleteRaceWriteCount === 1) {
      deleteRaceStarted()
      await deleteRaceGate
    }
  }
  await originalSetItem(key, value)
}
try {
  const activeSave = saveSnapshot('snapshot-delete-race', timelineSnapshot('chat-delete', [timelineEvent('chat-delete', 1)]))
  await deleteRaceStart
  const deletion = removeSnapshot('snapshot-delete-race', 'chat-delete')
  const staleSave = saveSnapshot('snapshot-delete-race', timelineSnapshot('chat-delete', [timelineEvent('chat-delete', 2)], 2))
  releaseDeleteRace()
  await Promise.all([activeSave, deletion, staleSave])
} finally {
  AsyncStorage.setItem = originalSetItem
}
assertEqual(deleteRaceWriteCount, 1)
assertEqual(await loadSnapshot('snapshot-delete-race', 'chat-delete'), null)

let releaseFailedWrite: () => void = () => {}
let failedWriteStarted: () => void = () => {}
const failedWriteGate = new Promise<void>(resolve => { releaseFailedWrite = resolve })
const failedWriteStart = new Promise<void>(resolve => { failedWriteStarted = resolve })
let attemptedSnapshotWrites = 0
AsyncStorage.setItem = async (key: string, value: string) => {
  if (key.startsWith('agentsdock.react.snapshot.snapshot-failure.')) {
    attemptedSnapshotWrites += 1
    if (attemptedSnapshotWrites === 1) {
      failedWriteStarted()
      await failedWriteGate
      throw new Error('simulated snapshot write failure')
    }
  }
  await originalSetItem(key, value)
}
try {
  const failed = saveSnapshot('snapshot-failure', timelineSnapshot('chat-retry', [timelineEvent('chat-retry', 1)]))
  await failedWriteStart
  const recovered = saveSnapshot('snapshot-failure', timelineSnapshot('chat-retry', [timelineEvent('chat-retry', 2)], 2))
  releaseFailedWrite()
  const results = await Promise.allSettled([failed, recovered])
  assertEqual(results.map(result => result.status), ['rejected', 'fulfilled'])
} finally {
  AsyncStorage.setItem = originalSetItem
}
assertEqual((await loadSnapshot('snapshot-failure', 'chat-retry'))?.latestSeq, 2)

console.log('crash-safe profile storage regressions passed')
