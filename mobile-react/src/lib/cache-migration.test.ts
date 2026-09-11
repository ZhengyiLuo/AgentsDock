import type { Event, Session, Snapshot, WorkspacePreferences } from '../types'
import {
  CACHE_SNAPSHOT_EVENT_LIMIT,
  CACHE_SNAPSHOT_SESSION_LIMIT,
  CacheNamespaceCollisionError,
  findNamespaceSessionCollisions,
  mergeNamespaceCachePayload,
  mergeWorkspacePreferences,
  summarizeCachedSessions,
  type NamespaceCachePayload,
} from './cache-migration'
import { SNAPSHOT_CACHE_VERSION } from './history'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function session(id: string, threadId: string, extra: Partial<Session> = {}): Session {
  return { id, title: `Chat ${id}`, backend: 'codex', codex_thread_id: threadId, ...extra }
}

function event(sessionId: string, seq: number, text: string): Event {
  return {
    id: `${sessionId}-event-${seq}`,
    session_id: sessionId,
    seq,
    type: 'assistant_text',
    ts: `2026-07-18T12:00:${String(seq).padStart(2, '0')}Z`,
    text,
  }
}

function snapshot(chat: Session, events: Event[], cachedAt: number, trusted = true): Snapshot {
  return {
    cacheVersion: trusted ? SNAPSHOT_CACHE_VERSION : undefined,
    session: chat,
    events,
    queuedTurns: [],
    files: [],
    filesTotal: 0,
    hasMore: false,
    latestSeq: events.at(-1)?.seq ?? null,
    cachedAt,
  }
}

const emptyWorkspace: WorkspacePreferences = {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: {},
}

function payload(overrides: Partial<NamespaceCachePayload> = {}): NamespaceCachePayload {
  return { sessions: [], recentSessionIds: [], snapshots: {}, pins: [], workspace: emptyWorkspace, ...overrides }
}

const sourceChat = session('shared', 'thread-a', {
  title: 'Source title',
  updated_at: '2026-07-18T13:00:00Z',
  latest_event_seq: 2,
})
const targetChat = session('shared', 'thread-a', {
  title: 'Target title',
  updated_at: '2026-07-18T12:00:00Z',
  latest_event_seq: 1,
})
const source = payload({
  sessions: [sourceChat, session('source-only', 'thread-source')],
  recentSessionIds: ['source-only', 'shared'],
  snapshots: {
    shared: snapshot(sourceChat, [event('shared', 1, 'source one'), event('shared', 2, 'source two')], 20),
    'source-only': snapshot(session('source-only', 'thread-source'), [event('source-only', 1, 'only')], 10),
  },
  pins: [{ id: 'pin-source', sessionId: 'shared', kind: 'message', title: 'Source pin', createdAt: 1 }],
  workspace: {
    selectedSessionId: 'source-only',
    folderOrder: ['Source', 'Shared'],
    collapsedFolders: ['Source'],
    drafts: { shared: 'source draft', 'source-only': 'only draft' },
  },
})
const target = payload({
  sessions: [targetChat, session('target-only', 'thread-target')],
  recentSessionIds: ['target-only', 'shared'],
  snapshots: {
    shared: snapshot(targetChat, [event('shared', 1, 'target one')], 15),
  },
  pins: [{ id: 'pin-target', sessionId: 'shared', kind: 'message', title: 'Target pin', createdAt: 2 }],
  workspace: {
    selectedSessionId: null,
    folderOrder: ['Target', 'Shared'],
    collapsedFolders: ['Target'],
    drafts: { shared: 'target draft' },
  },
})

assertEqual(findNamespaceSessionCollisions(source, target), [])
const merged = mergeNamespaceCachePayload(source, target, 'http://legacy.example:7850', 'profile:default-profile')
assertEqual(merged.sessions.map(value => value.id), ['shared', 'target-only', 'source-only'])
assertEqual(merged.sessions[0].title, 'Source title')
assertEqual(merged.snapshots.shared.events.map(value => [value.seq, value.text]), [[1, 'target one'], [2, 'source two']])
assertEqual(merged.snapshots.shared.cacheVersion, SNAPSHOT_CACHE_VERSION)
assertEqual(merged.recentSessionIds, ['target-only', 'shared', 'source-only'])
assertEqual(merged.pins.map(value => value.id), ['pin-target', 'pin-source'])
assertEqual(merged.workspace, {
  selectedSessionId: 'source-only',
  folderOrder: ['Target', 'Shared', 'Source'],
  collapsedFolders: ['Target', 'Source'],
  drafts: { shared: 'target draft', 'source-only': 'only draft' },
})
assertEqual(
  mergeNamespaceCachePayload(source, merged, 'http://legacy.example:7850', 'profile:default-profile'),
  merged,
)

// A verified snapshot owns history over a newer legacy snapshot.
const verified = snapshot(targetChat, [event('shared', 8, 'verified')], 1, true)
const legacy = snapshot(sourceChat, [event('shared', 99, 'legacy disconnected')], 100, false)
const ownershipMerge = mergeNamespaceCachePayload(
  payload({ snapshots: { shared: legacy } }),
  payload({ snapshots: { shared: verified } }),
  'legacy',
  'target',
)
assertEqual(ownershipMerge.snapshots.shared.events.map(value => value.seq), [8])
assertEqual(ownershipMerge.snapshots.shared.cacheVersion, SNAPSHOT_CACHE_VERSION)

const rawCursorEvent: Event = {
  id: 'shared-raw-50', session_id: 'shared', seq: 50, type: 'raw_event', ts: '2026-07-18T12:01:00Z', raw: 'provider packet',
}
const cursorSource = { ...snapshot(sourceChat, [event('shared', 2, 'visible'), rawCursorEvent], 20), latestSeq: 55 }
const cursorTarget = { ...snapshot(targetChat, [event('shared', 3, 'newer visible')], 21), latestSeq: 60 }
const cursorMerge = mergeNamespaceCachePayload(
  payload({ snapshots: { shared: cursorSource } }),
  payload({ snapshots: { shared: cursorTarget } }),
  'legacy',
  'target',
)
assertEqual(cursorMerge.snapshots.shared.events.map(value => value.type), ['assistant_text', 'assistant_text'])
assertEqual(cursorMerge.snapshots.shared.latestSeq, 60)

const longSnapshotEvents = Array.from({ length: CACHE_SNAPSHOT_EVENT_LIMIT + 5 }, (_, index) => event('long', index + 1, String(index + 1)))
const normalizedLong = mergeNamespaceCachePayload(
  payload({ snapshots: { long: { ...snapshot(session('long', 'thread-long'), longSnapshotEvents, 1), latestSeq: 900 } } }),
  payload(),
  'legacy',
  'target',
).snapshots.long
assertEqual(normalizedLong.events.length, CACHE_SNAPSHOT_EVENT_LIMIT)
assertEqual(normalizedLong.events[0]?.seq, 6)
assertEqual(normalizedLong.hasMore, true)
assertEqual(normalizedLong.latestSeq, 900)

const collisionSource = payload({ sessions: [session('same-id', 'thread-source')] })
const collisionTarget = payload({ sessions: [session('same-id', 'thread-target')] })
assertEqual(findNamespaceSessionCollisions(collisionSource, collisionTarget), ['same-id'])
try {
  mergeNamespaceCachePayload(collisionSource, collisionTarget, 'source', 'target')
  throw new Error('Expected a cache collision')
} catch (error) {
  assert(error instanceof CacheNamespaceCollisionError, `Unexpected collision error: ${String(error)}`)
  assertEqual(error.sessionIds, ['same-id'])
}

const manyRecent = Array.from({ length: CACHE_SNAPSHOT_SESSION_LIMIT + 20 }, (_, index) => `chat-${index}`)
const manySnapshots = Object.fromEntries(manyRecent.map((sessionId, index) => {
  const chat = session(sessionId, `thread-${index}`)
  return [sessionId, snapshot(chat, [event(sessionId, 1, String(index))], index)]
}))
const boundedMerge = mergeNamespaceCachePayload(
  payload({ recentSessionIds: manyRecent, snapshots: manySnapshots }),
  payload(),
  'source',
  'target',
)
assertEqual(boundedMerge.recentSessionIds.length, CACHE_SNAPSHOT_SESSION_LIMIT)
assertEqual(Object.keys(boundedMerge.snapshots).length, CACHE_SNAPSHOT_SESSION_LIMIT)

assertEqual(mergeWorkspacePreferences({
  selectedSessionId: 'source',
  folderOrder: ['A'],
  collapsedFolders: ['A'],
  drafts: { one: 'source', two: 'source' },
}, {
  selectedSessionId: 'target',
  folderOrder: ['B'],
  collapsedFolders: ['B'],
  drafts: { two: 'target' },
}), {
  selectedSessionId: 'target',
  folderOrder: ['B', 'A'],
  collapsedFolders: ['B', 'A'],
  drafts: { one: 'source', two: 'target' },
})

// Target drafts win independently from structured reference metadata. A
// source grant must not survive if that winning draft no longer contains its
// exact UTF-16 mention span.
assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Ask @Target' },
  chatReferencesBySession: {
    shared: [{
      session_id: 'target-chat',
      display_title_snapshot: 'Target',
      source_text_start: 4,
      source_text_end: 11,
      action: 'request_reply',
    }],
  },
}, {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Different target draft' },
}), {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Different target draft' },
})

assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Ask @Target' },
  chatReferencesBySession: {
    shared: [{
      session_id: 'target-chat',
      display_title_snapshot: 'Target',
      source_text_start: 4,
      source_text_end: 11,
      action: 'instruction',
    }],
  },
}, {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Ask @Target' },
}), {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { shared: 'Ask @Target' },
})

assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { sourceOnly: 'Ask @Target' },
  chatReferencesBySession: {
    sourceOnly: [{
      session_id: 'target-chat',
      display_title_snapshot: 'Target',
      source_text_start: 4,
      source_text_end: 11,
      action: 'instruction',
    }],
  },
}, {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { targetOnly: 'Keep me' },
}), {
  selectedSessionId: null,
  folderOrder: [],
  collapsedFolders: [],
  drafts: { sourceOnly: 'Ask @Target', targetOnly: 'Keep me' },
  chatReferencesBySession: {
    sourceOnly: [{
      session_id: 'target-chat',
      display_title_snapshot: 'Target',
      source_text_start: 4,
      source_text_end: 11,
      action: 'instruction',
    }],
  },
})

// chatDefaults: the target namespace's saved defaults win over the source's.
assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
  chatDefaults: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high', folder: 'Src', cwd: '/src' },
}, {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
  chatDefaults: { backend: 'claude', model: 'opus', effort: '', folder: 'Dst', cwd: '/dst' },
}), {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
  chatDefaults: { backend: 'claude', model: 'opus', effort: '', folder: 'Dst', cwd: '/dst' },
})

// Regression: a target namespace that never saved chatDefaults must not
// manufacture a default that discards the source namespace's custom defaults.
assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
  chatDefaults: { backend: 'claude', model: 'opus', effort: 'medium', folder: 'Mine', cwd: '/mine' },
}, {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
}), {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
  chatDefaults: { backend: 'claude', model: 'opus', effort: 'medium', folder: 'Mine', cwd: '/mine' },
})

// With no stored defaults on either side, none are manufactured.
assertEqual(mergeWorkspacePreferences({
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
}, {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
}), {
  selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: {},
})

assertEqual(summarizeCachedSessions('server-a', [
  session('unread', 'thread-1', { latest_agent_event_seq: 4, last_read_agent_event_seq: 2, pinned: true }),
  session('read', 'thread-2', { latest_agent_event_seq: 2, last_read_agent_event_seq: 2 }),
  session('archived', 'thread-3', { archived: true, manual_unread: true, pinned: true }),
]), {
  namespace: 'server-a',
  sessionCount: 3,
  activeSessionCount: 2,
  archivedSessionCount: 1,
  unreadCount: 1,
  pinnedCount: 1,
  updatedAt: null,
})

console.log('cache namespace migration regressions passed')
