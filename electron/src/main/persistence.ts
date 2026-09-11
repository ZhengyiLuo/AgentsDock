import { app } from 'electron'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type { AgentFile, Event, Job, PinnedItem, QueuedTurn, Session, SessionSnapshot, TimelineSearchResult, ViewState } from '../shared/types'
import { compactTimelineEvent, compactTimelineEvents } from '../shared/event-compaction'
import { incompleteLeadingRunId } from '../shared/semantic-timeline'
import { agentFileBelongsToSession, isolateSessionEvent } from '../shared/session-files'
import { isImportedCodexSubagentNotification, isImportedSourceProvenRepair, mergeProviderInterruptionEvent } from '../shared/provider-origin'
import { isSearchableEvent, searchEventRole, searchableEventText, searchFtsQuery, searchSnippet, searchTokens } from './search'
import { reportStartupStorageError, reportStorageError } from './storage-health'

const SERVER_SCOPED_TABLES = [
  'sessions', 'events', 'queued_turns', 'jobs', 'files', 'view_state', 'timeline_state', 'pins', 'preferences'
] as const

export interface CachedServerSummary {
  serverId: string
  sessionCount: number
  activeSessionCount: number
  archivedSessionCount: number
  unreadCount: number
  pinnedCount: number
  updatedAt: number | null
}

export interface CachedSessionSearchResult {
  serverId: string
  session: Session
  source: 'title' | 'content'
  history?: TimelineSearchResult
  updatedAt: number
}

export interface CacheNamespaceMergeResult {
  sourceServerId: string
  targetServerId: string
  moved: boolean
  sourceSessionCount: number
  targetSessionCountBefore: number
  targetSummary: CachedServerSummary
}

export interface CachedRawTimelinePage {
  events: Event[]
  windowStartSeq: number | null
  nextBefore: number | null
  hasMore: boolean
}

const CACHED_TIMELINE_TAIL_EVENT_LIMIT = 720
const CACHED_TIMELINE_MAX_RAW_EVENT_LIMIT = 2_000
// v3 re-audits semantic timelines after essential file/diff events became
// non-optional. Without this bump, a v2 cache can permanently hide media that
// an older server response omitted even after the server is upgraded.
export const TIMELINE_PAGING_SCHEMA_VERSION = 3
const FILE_OWNERSHIP_CACHE_SCHEMA_VERSION = '1'
const REBUILDABLE_PREFERENCES = new Set(['runtimeCatalog:v1', 'serverVersion:v1', 'semanticTimelineCapability:v1'])

export class CacheNamespaceCollisionError extends Error {
  constructor(
    readonly sourceServerId: string,
    readonly targetServerId: string,
    readonly sessionIds: string[]
  ) {
    super(`Cannot merge cache namespaces with conflicting sessions: ${sessionIds.join(', ')}`)
    this.name = 'CacheNamespaceCollisionError'
  }
}

function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function parseCachedEventRows(rows: Array<{ json: string }>, sessionId: string): Event[] {
  return rows.flatMap(row => {
    const event = parseJSON<Event | null>(row.json, null)
    const isolated = event ? isolateSessionEvent(event, sessionId) : null
    return isolated
      && typeof isolated.id === 'string'
      && typeof isolated.type === 'string'
      && Number.isFinite(isolated.seq)
      ? [isolated]
      : []
  })
}

function sessionSort(a: Session, b: Session): number {
  const archived = Number(Boolean(a.archived)) - Number(Boolean(b.archived))
  if (archived) return archived
  if (!a.archived && !b.archived) {
    const pinned = Number(!a.pinned) - Number(!b.pinned)
    if (pinned) return pinned
  }
  const folderA = a.archived || a.pinned ? '' : (a.folder || 'General').toLocaleLowerCase()
  const folderB = b.archived || b.pinned ? '' : (b.folder || 'General').toLocaleLowerCase()
  const folder = folderA.localeCompare(folderB)
  if (folder) return folder
  const order = (a.sort_order ?? 0) - (b.sort_order ?? 0)
  if (order) return order
  return String(a.created_at || a.id).localeCompare(String(b.created_at || b.id))
}

function sessionsConflict(source: Session, target: Session): boolean {
  if (source.backend && target.backend && source.backend !== target.backend) return true
  for (const key of ['session_id', 'claude_session_id', 'codex_thread_id', 'parent_id'] as const) {
    const sourceValue = source[key]
    const targetValue = target[key]
    if (sourceValue && targetValue && sourceValue !== targetValue) return true
  }
  return Boolean(source.created_at && target.created_at && source.created_at !== target.created_at)
}

export class LocalCache {
  private db!: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private readonly eventWriteGaps = new Map<string, { after: number; error: unknown }>()
  private readonlyStorage: DatabaseSync | null = null
  private storageFailure: unknown = null
  private cachePath = ':memory:'
  private readonly temporaryEventSessions = new Set<string>()

  private rollbackTransaction(): void {
    if (this.db.isTransaction) this.db.exec('ROLLBACK')
  }

  constructor(path?: string) {
    const cachePath = path ?? join(app.getPath('userData'), 'agentsdock.sqlite')
    this.cachePath = cachePath
    try {
    this.db = new DatabaseSync(cachePath)
    // Opening an already-current cache must not require a write. In particular,
    // a full disk must not prevent the user from opening their saved drafts.
    if (this.schemaIsCurrent()) {
      this.db.exec('PRAGMA synchronous = NORMAL')
      return
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_order ON events(server_id, session_id, seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(
        text,
        server_id UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        seq UNINDEXED,
        ts UNINDEXED,
        role UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS event_search_keys (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        search_rowid INTEGER,
        PRIMARY KEY (server_id, session_id, event_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS search_backfill_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor_rowid INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO search_backfill_state(id, cursor_rowid, complete) VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queued_turns (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        queued_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id, queued_id)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        server_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS files (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id, file_id)
      );
      CREATE TABLE IF NOT EXISTS view_state (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS timeline_state (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        has_more INTEGER NOT NULL,
        verified_latest_seq INTEGER,
        known_total INTEGER,
        next_timeline_before INTEGER,
        paging_schema_version INTEGER,
        semantic_paging INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS pins (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS preferences (
        server_id TEXT NOT NULL,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (server_id, key)
      );
    `)
    const timelineColumns = this.statement('PRAGMA table_info(timeline_state)').all() as Array<{ name: string }>
    if (!timelineColumns.some(column => column.name === 'verified_latest_seq')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN verified_latest_seq INTEGER')
    if (!timelineColumns.some(column => column.name === 'known_total')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN known_total INTEGER')
    if (!timelineColumns.some(column => column.name === 'next_timeline_before')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN next_timeline_before INTEGER')
    if (!timelineColumns.some(column => column.name === 'paging_schema_version')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN paging_schema_version INTEGER')
    if (!timelineColumns.some(column => column.name === 'semantic_paging')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN semantic_paging INTEGER')
    this.migrateFileOwnershipCache()
    } catch (error) {
      if (cachePath === ':memory:' || !reportStartupStorageError(error, dirname(cachePath))) throw error
      try { this.db!.close() } catch { /* It may not have opened successfully. */ }
      // The existing file is never removed, renamed, or replaced. Rebuildable
      // server data can stay usable in memory; user-owned saves still reject.
      const temporary = new LocalCache(':memory:')
      temporary.cachePath = cachePath
      temporary.storageFailure = error
      try { temporary.readonlyStorage = new DatabaseSync(cachePath, { readOnly: true }) }
      catch { /* Existing data remains on disk for recovery after space is freed. */ }
      return temporary
    }
  }

  private requireDurableStorage(): void {
    if (this.storageFailure) throw this.storageFailure
  }

  /** Explicit user retry only; never called by the stream or on a keystroke. */
  retryStorageWrites(): void {
    const recovered = this.storageFailure ? new LocalCache(this.cachePath) : this
    if (recovered.storageFailure) {
      recovered.close()
      throw this.storageFailure
    }
    try {
      recovered.db.exec('BEGIN IMMEDIATE')
      recovered.db.prepare('UPDATE cache_meta SET value = value WHERE key = ?').run('file-ownership-schema')
      recovered.db.exec('COMMIT')
    } catch (error) {
      recovered.rollbackTransaction()
      if (recovered !== this) recovered.close()
      reportStorageError(error)
      throw error
    }
    if (recovered === this) return
    this.statements.clear()
    this.readonlyStorage?.close()
    this.readonlyStorage = null
    this.db.close()
    this.db = recovered.db
    this.storageFailure = null
    for (const key of this.temporaryEventSessions) {
      const [serverId, sessionId] = JSON.parse(key) as [string, string]
      this.eventWriteGaps.set(key, { after: this.latestEventSequence(serverId, sessionId),
        error: new Error('Refresh this chat to reconcile events received while its local cache was unavailable.') })
    }
    this.temporaryEventSessions.clear()
  }

  private savedJSON<T>(table: 'preferences' | 'view_state', serverId: string, key: string, fallback: T): T {
    if (!this.readonlyStorage) return fallback
    try {
      const column = table === 'preferences' ? 'key' : 'session_id'
      const row = this.readonlyStorage.prepare(`SELECT json FROM ${table} WHERE server_id = ? AND ${column} = ?`)
        .get(serverId, key) as { json: string } | undefined
      return row ? parseJSON(row.json, fallback) : fallback
    } catch { return fallback }
  }

  private schemaIsCurrent(): boolean {
    try {
      const version = this.db.prepare('SELECT value FROM cache_meta WHERE key = ?').get('file-ownership-schema') as { value?: string } | undefined
      if (version?.value !== FILE_OWNERSHIP_CACHE_SCHEMA_VERSION) return false
      const columns = this.db.prepare('PRAGMA table_info(timeline_state)').all() as Array<{ name: string }>
      return ['verified_latest_seq', 'known_total', 'next_timeline_before', 'paging_schema_version', 'semantic_paging']
        .every(name => columns.some(column => column.name === name))
    } catch { return false }
  }

  close(): void {
    this.statements.clear()
    this.readonlyStorage?.close()
    this.db.close()
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private migrateFileOwnershipCache(): void {
    const key = 'file-ownership-schema'
    const row = this.statement('SELECT value FROM cache_meta WHERE key = ?').get(key) as { value: string } | undefined
    if (row?.value === FILE_OWNERSHIP_CACHE_SCHEMA_VERSION) return
    this.db.exec(`
      BEGIN;
      CREATE TEMP TABLE IF NOT EXISTS agentsdock_foreign_file_events (
        server_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (server_id, session_id, event_id)
      ) WITHOUT ROWID;
      DELETE FROM agentsdock_foreign_file_events;
      INSERT INTO agentsdock_foreign_file_events(server_id, session_id, event_id)
      SELECT server_id, session_id, event_id
      FROM events
      WHERE json_valid(json)
        AND (
          (
            json_extract(json, '$.type') = 'artifact_created'
            AND json_type(json, '$.artifact.session_id') = 'text'
            AND TRIM(json_extract(json, '$.artifact.session_id')) <> ''
            AND TRIM(json_extract(json, '$.artifact.session_id')) <> session_id
          )
          OR (
            json_extract(json, '$.type') = 'file_uploaded'
            AND json_type(json, '$.file.session_id') = 'text'
            AND TRIM(json_extract(json, '$.file.session_id')) <> ''
            AND TRIM(json_extract(json, '$.file.session_id')) <> session_id
          )
        );
      DELETE FROM timeline_state
      WHERE EXISTS (
        SELECT 1
        FROM agentsdock_foreign_file_events foreign_event
        WHERE foreign_event.server_id = timeline_state.server_id
          AND foreign_event.session_id = timeline_state.session_id
      );
      DELETE FROM events
      WHERE EXISTS (
        SELECT 1
        FROM agentsdock_foreign_file_events foreign_event
        WHERE foreign_event.server_id = events.server_id
          AND foreign_event.session_id = events.session_id
          AND foreign_event.event_id = events.event_id
      );
      DELETE FROM files
      WHERE json_valid(json)
        AND json_type(json, '$.session_id') = 'text'
        AND TRIM(json_extract(json, '$.session_id')) <> ''
        AND TRIM(json_extract(json, '$.session_id')) <> session_id;
      DELETE FROM event_search;
      DELETE FROM event_search_keys;
      UPDATE search_backfill_state SET cursor_rowid = 0, complete = 0 WHERE id = 1;
      INSERT INTO cache_meta(key, value)
      VALUES ('file-ownership-schema', '${FILE_OWNERSHIP_CACHE_SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      DROP TABLE agentsdock_foreign_file_events;
      COMMIT;
    `)
  }

  cachedServerIds(): string[] {
    return (this.statement(`
      SELECT server_id FROM (
        SELECT server_id FROM sessions
        UNION SELECT server_id FROM events
        UNION SELECT server_id FROM queued_turns
        UNION SELECT server_id FROM jobs
        UNION SELECT server_id FROM files
        UNION SELECT server_id FROM view_state
        UNION SELECT server_id FROM timeline_state
        UNION SELECT server_id FROM pins
        UNION SELECT server_id FROM preferences
      )
      ORDER BY server_id
    `).all() as Array<{ server_id: string }>).map(row => row.server_id)
  }

  serverSummary(serverId: string): CachedServerSummary {
    const row = this.statement(`
      SELECT
        COUNT(*) AS session_count,
        SUM(CASE WHEN COALESCE(json_extract(json, '$.archived'), 0) = 0 THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN COALESCE(json_extract(json, '$.archived'), 0) <> 0 THEN 1 ELSE 0 END) AS archived_count,
        SUM(CASE
          WHEN COALESCE(json_extract(json, '$.archived'), 0) = 0
           AND (
             COALESCE(json_extract(json, '$.manual_unread'), 0) <> 0
             OR COALESCE(json_extract(json, '$.latest_agent_event_seq'), 0)
                > COALESCE(json_extract(json, '$.last_read_agent_event_seq'), 0)
           )
          THEN 1 ELSE 0
        END) AS unread_count,
        SUM(CASE
          WHEN COALESCE(json_extract(json, '$.archived'), 0) = 0
           AND COALESCE(json_extract(json, '$.pinned'), 0) <> 0
          THEN 1 ELSE 0
        END) AS pinned_count,
        MAX(updated_at) AS updated_at
      FROM sessions
      WHERE server_id = ?
    `).get(serverId) as {
      session_count: number; active_count: number | null; archived_count: number | null
      unread_count: number | null; pinned_count: number | null; updated_at: number | null
    }
    return {
      serverId,
      sessionCount: Number(row.session_count ?? 0),
      activeSessionCount: Number(row.active_count ?? 0),
      archivedSessionCount: Number(row.archived_count ?? 0),
      unreadCount: Number(row.unread_count ?? 0),
      pinnedCount: Number(row.pinned_count ?? 0),
      updatedAt: row.updated_at == null ? null : Number(row.updated_at)
    }
  }

  serverSummaries(serverIds: readonly string[] = this.cachedServerIds()): CachedServerSummary[] {
    return [...new Set(serverIds)].map(serverId => this.serverSummary(serverId))
  }

  searchAllSessions(serverIds: readonly string[], query: string, limit = 40): CachedSessionSearchResult[] {
    const ids = [...new Set(serverIds.map(value => value.trim()).filter(Boolean))]
    const tokens = searchTokens(query)
    if (!ids.length || !tokens.length) return []
    const boundedLimit = Math.max(1, Math.min(200, limit))
    const placeholders = ids.map(() => '?').join(', ')
    const sessionRows = this.statement(`
      SELECT server_id, json, updated_at
      FROM sessions
      WHERE server_id IN (${placeholders})
    `).all(...ids) as Array<{ server_id: string; json: string; updated_at: number }>
    const rank = new Map(ids.map((serverId, index) => [serverId, index]))
    const results = new Map<string, CachedSessionSearchResult>()

    for (const row of sessionRows) {
      const cachedSession = parseJSON(row.json, {} as Session)
      const title = String(cachedSession.title ?? '').toLocaleLowerCase()
      if (!cachedSession.id || !tokens.every(token => title.includes(token))) continue
      results.set(`${row.server_id}\u0000${cachedSession.id}`, {
        serverId: row.server_id,
        session: cachedSession,
        source: 'title',
        updatedAt: Number(row.updated_at)
      })
    }

    const historyRows = this.statement(`
      WITH ranked AS (
        SELECT event_search.server_id, event_search.session_id, event_id, seq, ts, role, text,
               sessions.json AS session_json, sessions.updated_at AS session_updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY event_search.server_id, event_search.session_id
                 ORDER BY COALESCE(ts, '') DESC, CAST(seq AS INTEGER) DESC
               ) AS match_rank,
               COUNT(*) OVER (
                 PARTITION BY event_search.server_id, event_search.session_id
               ) AS match_count
        FROM event_search
        JOIN sessions
          ON sessions.server_id = event_search.server_id
         AND sessions.session_id = event_search.session_id
        WHERE event_search MATCH ?
          AND event_search.server_id IN (${placeholders})
          AND COALESCE(json_extract(sessions.json, '$.archived'), 0) = 0
      )
      SELECT server_id, session_id, event_id, seq, ts, role, text, session_json, session_updated_at, match_count
      FROM ranked
      WHERE match_rank = 1
      ORDER BY COALESCE(ts, '') DESC, CAST(seq AS INTEGER) DESC
      LIMIT ?
    `).all(searchFtsQuery(query), ...ids, Math.min(1_000, Math.max(200, boundedLimit * 4))) as Array<{
      server_id: string; session_id: string; event_id: string; seq: number | string; ts: string | null
      role: TimelineSearchResult['role']; text: string; session_json: string; session_updated_at: number; match_count: number
    }>
    for (const row of historyRows) {
      const key = `${row.server_id}\u0000${row.session_id}`
      if (results.has(key)) continue
      results.set(key, {
        serverId: row.server_id,
        session: parseJSON(row.session_json, {} as Session),
        source: 'content',
        updatedAt: Number(row.session_updated_at),
        history: {
          session_id: row.session_id,
          event_id: row.event_id,
          seq: Number(row.seq),
          ts: row.ts ?? undefined,
          role: row.role,
          snippet: searchSnippet(row.text, tokens),
          match_count: Number(row.match_count)
        }
      })
    }

    return [...results.values()]
      .sort((left, right) => (
        (rank.get(left.serverId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.serverId) ?? Number.MAX_SAFE_INTEGER)
        || Number(left.source === 'content') - Number(right.source === 'content')
        || right.updatedAt - left.updatedAt
        || left.session.title.localeCompare(right.session.title)
      ))
      .slice(0, boundedLimit)
  }

  mergeServerNamespace(sourceServerId: string, targetServerId: string): CacheNamespaceMergeResult {
    this.requireDurableStorage()
    const source = sourceServerId.trim()
    const target = targetServerId.trim()
    if (!source || !target) throw new Error('Cache namespace IDs must not be empty')
    const sourceSessionCount = this.serverSummary(source).sessionCount
    const targetSessionCountBefore = this.serverSummary(target).sessionCount
    if (source === target || !this.namespaceHasRows(source)) {
      return {
        sourceServerId: source,
        targetServerId: target,
        moved: false,
        sourceSessionCount,
        targetSessionCountBefore,
        targetSummary: this.serverSummary(target)
      }
    }
    const targetHadRows = this.namespaceHasRows(target)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const conflicts = this.conflictingSessionIds(source, target)
      if (conflicts.length) throw new CacheNamespaceCollisionError(source, target, conflicts)

      this.removeSearchNamespace(source)
      this.removeSearchNamespace(target)
      this.mergeNamespaceRows(source, target)
      for (const table of SERVER_SCOPED_TABLES) {
        this.statement(`DELETE FROM ${table} WHERE server_id = ?`).run(source)
      }
      this.rebuildSearchNamespace(target)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }

    return {
      sourceServerId: source,
      targetServerId: target,
      moved: !targetHadRows,
      sourceSessionCount,
      targetSessionCountBefore,
      targetSummary: this.serverSummary(target)
    }
  }

  /** Remove every cached row owned by one or more server/profile namespaces. */
  removeServerNamespaces(serverIds: readonly string[]): void {
    this.requireDurableStorage()
    const ids = [...new Set(serverIds.map(value => value.trim()).filter(Boolean))]
    if (!ids.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const serverId of ids) {
        this.removeSearchNamespace(serverId)
        for (const table of SERVER_SCOPED_TABLES) {
          this.statement(`DELETE FROM ${table} WHERE server_id = ?`).run(serverId)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  sessions(serverId: string): Session[] {
    return this.statement('SELECT json FROM sessions WHERE server_id = ?')
      .all(serverId).map(row => parseJSON((row as { json: string }).json, {} as Session))
      .sort(sessionSort)
  }

  putSessions(serverId: string, sessions: Session[]): void {
    const put = this.statement(`
      INSERT INTO sessions(server_id, session_id, json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `)
    const live = new Set(sessions.map(session => session.id))
    const cached = this.sessions(serverId)
    const cachedById = new Map(cached.map(session => [session.id, session]))
    const reactivated = sessions.some(session => cachedById.get(session.id)?.archived && !session.archived)
    this.db.exec('BEGIN')
    try {
      for (const session of sessions) {
        put.run(serverId, session.id, JSON.stringify(session), Date.now())
        if (session.archived) this.removeSearchEntries(serverId, session.id)
      }
      for (const cachedSession of cached) {
        if (!live.has(cachedSession.id)) {
          this.removeSessionRows(serverId, cachedSession.id)
        }
      }
      if (reactivated) this.resetSearchBackfill()
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  putSession(serverId: string, session: Session): void {
    const previous = this.session(serverId, session.id)
    const reactivated = Boolean(previous?.archived && !session.archived)
    this.db.exec('BEGIN')
    try {
      this.statement(`
        INSERT INTO sessions(server_id, session_id, json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
      `).run(serverId, session.id, JSON.stringify(session), Date.now())
      if (session.archived) this.removeSearchEntries(serverId, session.id)
      if (reactivated) this.resetSearchBackfill()
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  removeSession(serverId: string, sessionId: string): void {
    this.requireDurableStorage()
    this.db.exec('BEGIN')
    try {
      this.removeSessionRows(serverId, sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  jobs(serverId: string): Job[] {
    return this.statement('SELECT json FROM jobs WHERE server_id = ? ORDER BY updated_at DESC')
      .all(serverId).map(row => parseJSON((row as { json: string }).json, {} as Job))
  }

  putJobs(serverId: string, jobs: Job[]): void {
    const put = this.statement('INSERT INTO jobs(server_id, job_id, session_id, json, updated_at) VALUES (?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      this.statement('DELETE FROM jobs WHERE server_id = ?').run(serverId)
      for (const job of jobs) put.run(serverId, job.id, job.session_id, JSON.stringify(job), Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  events(serverId: string, sessionId: string, limit = 720): Event[] {
    return this.rawEventsBefore(serverId, sessionId, Number.MAX_SAFE_INTEGER, limit).events
  }

  eventsBefore(serverId: string, sessionId: string, before: number, limit = 120): Event[] {
    return this.rawEventsBefore(serverId, sessionId, before, limit).events
  }

  rawEventsBefore(serverId: string, sessionId: string, before: number, limit = 480): CachedRawTimelinePage {
    const boundedLimit = Math.max(1, Math.min(
      CACHED_TIMELINE_MAX_RAW_EVENT_LIMIT,
      Math.floor(limit) || 480
    ))
    const rows = this.statement(`
      SELECT seq, json FROM (
        SELECT seq, json
        FROM events
        WHERE server_id = ? AND session_id = ? AND seq < ?
        ORDER BY seq DESC
        LIMIT ?
      )
      ORDER BY seq ASC
    `).all(serverId, sessionId, before, boundedLimit) as Array<{ seq: number; json: string }>
    const windowStartSeq = rows[0]?.seq ?? null
    const hasMore = windowStartSeq != null && Boolean(this.statement(`
      SELECT 1
      FROM events
      WHERE server_id = ? AND session_id = ? AND seq < ?
      LIMIT 1
    `).get(serverId, sessionId, windowStartSeq))
    return {
      events: parseCachedEventRows(rows, sessionId)
        .filter(event => event.type !== 'raw_event')
        .map(compactTimelineEvent),
      windowStartSeq,
      nextBefore: hasMore ? windowStartSeq : null,
      hasMore
    }
  }

  private restoreLeadingRunStart(serverId: string, sessionId: string, events: Event[]): Event[] {
    const runId = incompleteLeadingRunId(events)
    const firstSeq = events[0]?.seq
    if (!runId || firstSeq == null) return events
    const row = this.statement(`
      SELECT json
      FROM events
      WHERE server_id = ?
        AND session_id = ?
        AND seq < ?
        AND json_extract(json, '$.type') = 'turn_started'
        AND json_extract(json, '$.run_id') = ?
      ORDER BY seq DESC
      LIMIT 1
    `).get(serverId, sessionId, firstSeq, runId) as { json: string } | undefined
    if (!row) return events
    const start = isolateSessionEvent(parseJSON(row.json, {} as Event), sessionId)
    return start ? [compactTimelineEvent(start), ...events] : events
  }

  latestEventSequence(serverId: string, sessionId: string): number {
    const row = this.statement(`
      SELECT MAX(seq) AS seq
      FROM events
      WHERE server_id = ? AND session_id = ?
    `).get(serverId, sessionId) as { seq: number | null }
    return Number(row.seq ?? 0)
  }

  searchEvents(serverId: string, sessionId: string, query: string, limit = 40): TimelineSearchResult[] {
    const tokens = searchTokens(query)
    if (!tokens.length) return []
    const rows = this.statement(`
      SELECT event_id, seq, ts, role, text
      FROM event_search
      WHERE event_search MATCH ? AND server_id = ? AND session_id = ?
      ORDER BY CAST(seq AS INTEGER) DESC
      LIMIT ?
    `).all(searchFtsQuery(query), serverId, sessionId, Math.max(1, Math.min(100, limit))) as Array<{
      event_id: string; seq: number | string; ts: string | null; role: TimelineSearchResult['role']; text: string
    }>
    return rows.map(row => ({
      session_id: sessionId,
      event_id: row.event_id,
      seq: Number(row.seq),
      ts: row.ts ?? undefined,
      role: row.role,
      snippet: searchSnippet(row.text, tokens)
    }))
  }

  searchSessions(serverId: string, query: string, limit = 40): TimelineSearchResult[] {
    const tokens = searchTokens(query)
    if (!tokens.length) return []
    const rows = this.statement(`
      WITH ranked AS (
        SELECT event_search.session_id, event_id, seq, ts, role, text,
               ROW_NUMBER() OVER (
                 PARTITION BY event_search.session_id
                 ORDER BY COALESCE(ts, '') DESC, CAST(seq AS INTEGER) DESC
               ) AS match_rank,
               COUNT(*) OVER (PARTITION BY event_search.session_id) AS match_count
        FROM event_search
        JOIN sessions
          ON sessions.server_id = event_search.server_id
         AND sessions.session_id = event_search.session_id
        WHERE event_search MATCH ?
          AND event_search.server_id = ?
          AND COALESCE(json_extract(sessions.json, '$.archived'), 0) = 0
      )
      SELECT session_id, event_id, seq, ts, role, text, match_count
      FROM ranked
      WHERE match_rank = 1
      ORDER BY COALESCE(ts, '') DESC, CAST(seq AS INTEGER) DESC
      LIMIT ?
    `).all(searchFtsQuery(query), serverId, Math.max(1, Math.min(100, limit))) as Array<{
      session_id: string; event_id: string; seq: number | string; ts: string | null
      role: TimelineSearchResult['role']; text: string; match_count: number
    }>
    return rows.map(row => ({
      session_id: row.session_id,
      event_id: row.event_id,
      seq: Number(row.seq),
      ts: row.ts ?? undefined,
      role: row.role,
      snippet: searchSnippet(row.text, tokens),
      match_count: Number(row.match_count)
    }))
  }

  hasEventsBefore(serverId: string, sessionId: string, before: number): boolean {
    return Boolean(this.statement(`
      SELECT 1 FROM events
      WHERE server_id = ? AND session_id = ? AND seq < ?
      LIMIT 1
    `).get(serverId, sessionId, before))
  }

  timelineHasMore(serverId: string, sessionId: string): boolean {
    return Boolean(this.timelineState(serverId, sessionId)?.hasMore)
  }

  timelineState(serverId: string, sessionId: string): {
    hasMore: boolean
    verifiedLatestSeq: number | null
    knownTotal: number | null
    nextTimelineBefore: number | null
    pagingSchemaVersion: number | null
    semanticPaging: boolean | null
  } | null {
    const row = this.statement(`
      SELECT has_more, verified_latest_seq, known_total, next_timeline_before,
             paging_schema_version, semantic_paging
      FROM timeline_state WHERE server_id = ? AND session_id = ?
    `)
      .get(serverId, sessionId) as {
        has_more: number
        verified_latest_seq: number | null
        known_total: number | null
        next_timeline_before: number | null
        paging_schema_version: number | null
        semantic_paging: number | null
      } | undefined
    return row ? {
      hasMore: Boolean(row.has_more),
      verifiedLatestSeq: row.verified_latest_seq,
      knownTotal: row.known_total,
      nextTimelineBefore: row.next_timeline_before,
      pagingSchemaVersion: row.paging_schema_version,
      semanticPaging: row.semantic_paging == null ? null : Boolean(row.semantic_paging)
    } : null
  }

  visibleEventCount(serverId: string, sessionId: string): number {
    const row = this.statement(`
      SELECT COUNT(*) AS count FROM events
      WHERE server_id = ? AND session_id = ? AND json_extract(json, '$.type') <> 'raw_event'
    `).get(serverId, sessionId) as { count: number }
    return row.count
  }

  session(serverId: string, sessionId: string): Session | null {
    const row = this.statement('SELECT json FROM sessions WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string } | undefined
    return row ? parseJSON(row.json, null) : null
  }

  putEvents(serverId: string, sessionId: string, events: Event[], reconciledAfter?: number): void {
    if (!events.length) return
    const key = JSON.stringify([serverId, sessionId])
    const gap = this.eventWriteGaps.get(key)
    // Only a server reconciliation from the last durable cursor (or a full
    // replacement below) can repair a dropped batch. Later live events alone
    // must not make the missing interval disappear behind a higher cursor.
    if (gap && (reconciledAfter === undefined || reconciledAfter > gap.after)) throw gap.error
    const put = this.statement(`
      INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, event_id) DO UPDATE SET seq = excluded.seq, json = excluded.json
      WHERE events.seq <> excluded.seq OR events.json <> excluded.json
    `)
    try {
      this.db.exec('BEGIN')
      const changed: Event[] = []
      for (const event of events) {
        const isolated = isolateSessionEvent(event, sessionId)
        if (!isolated) continue
        let compacted = compactTimelineEvent(isolated)
        // A stale page or buffered stream can arrive after a proven in-place
        // repair. Keep that exact repair across cache reloads as well as UI merges.
        if (compacted.type === 'turn_started' && compacted.imported === true
          && (compacted.backend === 'claude' || compacted.backend === 'codex')) {
          const row = this.statement(`
            SELECT json FROM events
            WHERE server_id = ? AND session_id = ? AND event_id = ?
              AND (json_extract(json, '$.provider_history_repair') = 'source_proven_import'
                OR json_extract(json, '$.provider_runtime_context') = 'subagent_notification')
          `).get(serverId, sessionId, compacted.id) as { json: string } | undefined
          const previous = row ? parseJSON<Event | null>(row.json, null) : null
          if (previous && (isImportedSourceProvenRepair(previous) || isImportedCodexSubagentNotification(previous))) {
            // Compare full incoming text before cache compaction; never infer
            // source equality from a shared truncated preview.
            if (mergeProviderInterruptionEvent(previous, isolated) === previous) compacted = previous
          }
        }
        const result = put.run(serverId, sessionId, compacted.seq, compacted.id, JSON.stringify(compacted))
        if (result.changes > 0) changed.push(compacted)
      }
      if (this.sessionIsSearchable(serverId, sessionId)) this.indexSearchEvents(serverId, sessionId, changed)
      this.db.exec('COMMIT')
      this.eventWriteGaps.delete(key)
      if (this.storageFailure) this.temporaryEventSessions.add(key)
    } catch (error) {
      this.rollbackTransaction()
      if (reportStorageError(error)) this.eventWriteGaps.set(key, {
        after: gap?.after ?? this.latestEventSequence(serverId, sessionId), error
      })
      throw error
    }
  }

  replaceEvents(serverId: string, sessionId: string, events: Event[]): void {
    const compactedEvents = compactTimelineEvents(
      events.flatMap(event => {
        const isolated = isolateSessionEvent(event, sessionId)
        return isolated ? [isolated] : []
      })
    )
    const put = this.statement(`
      INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, event_id) DO UPDATE SET seq = excluded.seq, json = excluded.json
    `)
    this.db.exec('BEGIN')
    try {
      this.statement('DELETE FROM events WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
      this.removeSearchEntries(serverId, sessionId)
      for (const event of compactedEvents) put.run(serverId, sessionId, event.seq, event.id, JSON.stringify(event))
      if (this.sessionIsSearchable(serverId, sessionId)) this.indexSearchEvents(serverId, sessionId, compactedEvents)
      this.db.exec('COMMIT')
      this.eventWriteGaps.delete(JSON.stringify([serverId, sessionId]))
      if (this.storageFailure) this.temporaryEventSessions.add(JSON.stringify([serverId, sessionId]))
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  searchBackfillComplete(): boolean {
    const row = this.statement('SELECT complete FROM search_backfill_state WHERE id = 1')
      .get() as { complete: number } | undefined
    return Boolean(row?.complete)
  }

  backfillSearchIndexBatch(limit = 100): number {
    if (this.searchBackfillComplete()) return 0
    const state = this.statement('SELECT cursor_rowid FROM search_backfill_state WHERE id = 1')
      .get() as { cursor_rowid: number } | undefined
    const cursor = Number(state?.cursor_rowid ?? 0)
    const scanRows = this.statement(`
      SELECT rowid AS source_rowid
      FROM events
      WHERE rowid > ?
      ORDER BY rowid
      LIMIT ?
    `).all(cursor, Math.max(1, Math.min(2_000, limit))) as Array<{ source_rowid: number }>
    if (!scanRows.length) {
      this.statement('UPDATE search_backfill_state SET complete = 1 WHERE id = 1').run()
      return 0
    }

    const lastRowId = Number(scanRows.at(-1)?.source_rowid ?? cursor)
    const rows = this.statement(`
      SELECT events.server_id, events.session_id, events.json
      FROM events
      JOIN sessions
        ON sessions.server_id = events.server_id
       AND sessions.session_id = events.session_id
      LEFT JOIN event_search_keys
        ON event_search_keys.server_id = events.server_id
       AND event_search_keys.session_id = events.session_id
       AND event_search_keys.event_id = events.event_id
      WHERE event_search_keys.event_id IS NULL
        AND events.rowid > ?
        AND events.rowid <= ?
        AND COALESCE(json_extract(sessions.json, '$.archived'), 0) = 0
        AND (
          json_extract(events.json, '$.type') IN (
            'turn_started', 'assistant_text', 'turn_finished', 'reasoning_summary', 'error',
            'job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error',
            'artifact_created', 'artifact_error', 'file_uploaded',
            'handoff_digest_started', 'handoff_digest_ready', 'handoff_digest_received', 'handoff_digest_submitted', 'handoff_digest_sent'
          ) OR json_extract(events.json, '$.type') LIKE '%_error'
        )
      ORDER BY events.rowid
    `).all(cursor, lastRowId) as Array<{ server_id: string; session_id: string; json: string }>
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        const event = isolateSessionEvent(parseJSON(row.json, {} as Event), row.session_id)
        if (event) this.indexSearchEvents(row.server_id, row.session_id, [event])
      }
      this.statement('UPDATE search_backfill_state SET cursor_rowid = ?, complete = 0 WHERE id = 1').run(lastRowId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
    return scanRows.length
  }

  private namespaceHasRows(serverId: string): boolean {
    for (const table of [...SERVER_SCOPED_TABLES, 'event_search_keys'] as const) {
      if (this.statement(`SELECT 1 FROM ${table} WHERE server_id = ? LIMIT 1`).get(serverId)) return true
    }
    return Boolean(this.statement('SELECT 1 FROM event_search WHERE server_id = ? LIMIT 1').get(serverId))
  }

  private conflictingSessionIds(sourceServerId: string, targetServerId: string): string[] {
    const rows = this.statement(`
      SELECT source.session_id, source.json AS source_json, target.json AS target_json
      FROM sessions AS source
      JOIN sessions AS target ON target.session_id = source.session_id
      WHERE source.server_id = ? AND target.server_id = ?
      ORDER BY source.session_id
    `).all(sourceServerId, targetServerId) as Array<{
      session_id: string; source_json: string; target_json: string
    }>
    return rows
      .filter(row => sessionsConflict(
        parseJSON(row.source_json, {} as Session),
        parseJSON(row.target_json, {} as Session)
      ))
      .map(row => row.session_id)
  }

  private mergeNamespaceRows(sourceServerId: string, targetServerId: string): void {
    this.statement(`
      INSERT INTO sessions(server_id, session_id, json, updated_at)
      SELECT ?, session_id, json, updated_at FROM sessions WHERE server_id = ?
      ON CONFLICT(server_id, session_id) DO UPDATE SET
        json = excluded.json,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > sessions.updated_at
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO events(server_id, session_id, seq, event_id, json)
      SELECT ?, session_id, seq, event_id, json FROM events WHERE server_id = ?
      ON CONFLICT(server_id, session_id, event_id) DO NOTHING
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO queued_turns(server_id, session_id, queued_id, json)
      SELECT ?, session_id, queued_id, json FROM queued_turns WHERE server_id = ?
      ON CONFLICT(server_id, session_id, queued_id) DO NOTHING
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO jobs(server_id, job_id, session_id, json, updated_at)
      SELECT ?, job_id, session_id, json, updated_at FROM jobs WHERE server_id = ?
      ON CONFLICT(server_id, job_id) DO UPDATE SET
        session_id = excluded.session_id,
        json = excluded.json,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > jobs.updated_at
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO files(server_id, session_id, file_id, json)
      SELECT ?, session_id, file_id, json FROM files WHERE server_id = ?
      ON CONFLICT(server_id, session_id, file_id) DO NOTHING
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO view_state(server_id, session_id, json)
      SELECT ?, session_id, json FROM view_state WHERE server_id = ?
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json
      WHERE COALESCE(json_extract(excluded.json, '$.updatedAt'), 0)
          > COALESCE(json_extract(view_state.json, '$.updatedAt'), 0)
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO timeline_state(
        server_id, session_id, has_more, verified_latest_seq, known_total, next_timeline_before,
        paging_schema_version, semantic_paging, updated_at
      )
      SELECT ?, session_id, has_more, verified_latest_seq, known_total, next_timeline_before,
             paging_schema_version, semantic_paging, updated_at
      FROM timeline_state WHERE server_id = ?
      ON CONFLICT(server_id, session_id) DO UPDATE SET
        has_more = excluded.has_more,
        verified_latest_seq = excluded.verified_latest_seq,
        known_total = excluded.known_total,
        next_timeline_before = excluded.next_timeline_before,
        paging_schema_version = excluded.paging_schema_version,
        semantic_paging = excluded.semantic_paging,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > timeline_state.updated_at
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO pins(server_id, session_id, item_id, json)
      SELECT ?, session_id, item_id, json FROM pins WHERE server_id = ?
      ON CONFLICT(server_id, session_id, item_id) DO NOTHING
    `).run(targetServerId, sourceServerId)
    this.statement(`
      INSERT INTO preferences(server_id, key, json)
      SELECT ?, key, json FROM preferences WHERE server_id = ?
      ON CONFLICT(server_id, key) DO NOTHING
    `).run(targetServerId, sourceServerId)
  }

  private removeSearchNamespace(serverId: string): void {
    const rows = this.statement('SELECT rowid FROM event_search WHERE server_id = ?').all(serverId) as Array<{ rowid: number }>
    const remove = this.statement('DELETE FROM event_search WHERE rowid = ?')
    for (const row of rows) remove.run(row.rowid)
    this.statement('DELETE FROM event_search_keys WHERE server_id = ?').run(serverId)
  }

  private removeSessionRows(serverId: string, sessionId: string): void {
    this.removeSearchEntries(serverId, sessionId)
    for (const table of ['sessions', 'events', 'queued_turns', 'files', 'view_state', 'timeline_state', 'pins']) {
      this.statement(`DELETE FROM ${table} WHERE server_id = ? AND session_id = ?`).run(serverId, sessionId)
    }
    this.statement('DELETE FROM jobs WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
  }

  private rebuildSearchNamespace(serverId: string): void {
    const rows = this.statement(`
      SELECT events.session_id, events.json
      FROM events
      JOIN sessions
        ON sessions.server_id = events.server_id
       AND sessions.session_id = events.session_id
      WHERE events.server_id = ?
        AND COALESCE(json_extract(sessions.json, '$.archived'), 0) = 0
      ORDER BY events.session_id, events.seq
    `).all(serverId) as Array<{ session_id: string; json: string }>
    let sessionId = ''
    let events: Event[] = []
    for (const row of rows) {
      if (sessionId && row.session_id !== sessionId) {
        this.indexSearchEvents(serverId, sessionId, events)
        events = []
      }
      sessionId = row.session_id
      const event = isolateSessionEvent(parseJSON(row.json, {} as Event), row.session_id)
      if (event) events.push(event)
    }
    if (sessionId) this.indexSearchEvents(serverId, sessionId, events)
  }

  private resetSearchBackfill(): void {
    this.statement('UPDATE search_backfill_state SET cursor_rowid = 0, complete = 0 WHERE id = 1').run()
  }

  private removeSearchEntries(serverId: string, sessionId: string): void {
    this.statement(`
      DELETE FROM event_search
      WHERE rowid IN (
        SELECT search_rowid FROM event_search_keys
        WHERE server_id = ? AND session_id = ? AND search_rowid IS NOT NULL
      )
    `).run(serverId, sessionId)
    this.statement('DELETE FROM event_search_keys WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
  }

  private sessionIsSearchable(serverId: string, sessionId: string): boolean {
    const row = this.statement('SELECT json FROM sessions WHERE server_id = ? AND session_id = ?')
      .get(serverId, sessionId) as { json: string } | undefined
    return !row || !parseJSON(row.json, {} as Session).archived
  }

  private indexSearchEvents(serverId: string, sessionId: string, events: Event[]): void {
    const existing = this.statement(`
      SELECT search_rowid FROM event_search_keys
      WHERE server_id = ? AND session_id = ? AND event_id = ?
    `)
    const deleteSearch = this.statement('DELETE FROM event_search WHERE rowid = ?')
    const deleteKey = this.statement('DELETE FROM event_search_keys WHERE server_id = ? AND session_id = ? AND event_id = ?')
    const insertSearch = this.statement(`
      INSERT INTO event_search(text, server_id, session_id, event_id, seq, ts, role)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertKey = this.statement(`
      INSERT INTO event_search_keys(server_id, session_id, event_id, search_rowid)
      VALUES (?, ?, ?, ?)
    `)
    for (const event of events) {
      if (!event.id) continue
      const current = existing.get(serverId, sessionId, event.id) as { search_rowid: number | null } | undefined
      if (current?.search_rowid != null) deleteSearch.run(current.search_rowid)
      if (current) deleteKey.run(serverId, sessionId, event.id)
      if (!isSearchableEvent(event)) continue
      const text = searchableEventText(event)
      const result = text
        ? insertSearch.run(text, serverId, sessionId, event.id, event.seq, event.ts ?? null, searchEventRole(event))
        : null
      insertKey.run(serverId, sessionId, event.id, result ? Number(result.lastInsertRowid) : null)
    }
  }

  putTimelineState(
    serverId: string,
    sessionId: string,
    hasMore: boolean,
    verifiedLatestSeq?: number | null,
    knownTotal?: number | null,
    nextTimelineBefore?: number | null,
    semanticPaging?: boolean
  ): void {
    const gap = this.eventWriteGaps.get(JSON.stringify([serverId, sessionId]))
    if (gap) throw gap.error
    const updateCursor = nextTimelineBefore !== undefined
    const updatePaging = semanticPaging !== undefined
    this.statement(`
      INSERT INTO timeline_state(
        server_id, session_id, has_more, verified_latest_seq, known_total, next_timeline_before,
        paging_schema_version, semantic_paging, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET
        has_more = excluded.has_more,
        verified_latest_seq = COALESCE(excluded.verified_latest_seq, timeline_state.verified_latest_seq),
        known_total = COALESCE(excluded.known_total, timeline_state.known_total),
        next_timeline_before = CASE WHEN ? THEN excluded.next_timeline_before ELSE timeline_state.next_timeline_before END,
        paging_schema_version = CASE
          WHEN ? THEN excluded.paging_schema_version
          ELSE timeline_state.paging_schema_version
        END,
        semantic_paging = CASE WHEN ? THEN excluded.semantic_paging ELSE timeline_state.semantic_paging END,
        updated_at = excluded.updated_at
    `).run(
      serverId,
      sessionId,
      hasMore ? 1 : 0,
      verifiedLatestSeq ?? null,
      knownTotal ?? null,
      nextTimelineBefore ?? null,
      updatePaging ? TIMELINE_PAGING_SCHEMA_VERSION : null,
      updatePaging ? (semanticPaging ? 1 : 0) : null,
      Date.now(),
      updateCursor ? 1 : 0,
      updatePaging ? 1 : 0,
      updatePaging ? 1 : 0
    )
  }

  queuedTurns(serverId: string, sessionId: string): QueuedTurn[] {
    return this.statement('SELECT json FROM queued_turns WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId)
      .map(row => parseJSON((row as { json: string }).json, {} as QueuedTurn))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  }

  putQueuedTurns(serverId: string, sessionId: string, turns: QueuedTurn[]): void {
    this.statement('DELETE FROM queued_turns WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
    const put = this.statement('INSERT INTO queued_turns(server_id, session_id, queued_id, json) VALUES (?, ?, ?, ?)')
    for (const turn of turns) put.run(serverId, sessionId, turn.queued_id, JSON.stringify(turn))
  }

  private purgeForeignFiles(serverId: string, sessionId: string): void {
    this.statement(`
      DELETE FROM files
      WHERE server_id = ?
        AND session_id = ?
        AND json_valid(json)
        AND json_type(json, '$.session_id') = 'text'
        AND TRIM(json_extract(json, '$.session_id')) <> ''
        AND TRIM(json_extract(json, '$.session_id')) <> ?
    `).run(serverId, sessionId, sessionId)
  }

  files(serverId: string, sessionId: string, limit = 120): AgentFile[] {
    this.purgeForeignFiles(serverId, sessionId)
    return this.statement('SELECT json FROM files WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId).map(row => parseJSON((row as { json: string }).json, {} as AgentFile))
      .filter(file => Boolean(file.id) && agentFileBelongsToSession(file, sessionId))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, limit)
  }

  putFiles(serverId: string, sessionId: string, files: AgentFile[]): void {
    this.purgeForeignFiles(serverId, sessionId)
    const put = this.statement(`
      INSERT INTO files(server_id, session_id, file_id, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, file_id) DO UPDATE SET json = excluded.json
    `)
    for (const file of files) {
      if (file.id && agentFileBelongsToSession(file, sessionId)) {
        put.run(serverId, sessionId, file.id, JSON.stringify(file))
      }
    }
  }

  snapshot(serverId: string, sessionId: string): SessionSnapshot | null {
    const row = this.statement('SELECT json, updated_at FROM sessions WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string; updated_at: number } | undefined
    if (!row) return null
    const files = this.files(serverId, sessionId)
    const fileCount = (this.statement('SELECT COUNT(*) AS count FROM files WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { count: number }).count
    const timeline = this.statement(`
      SELECT has_more, verified_latest_seq, known_total, next_timeline_before,
             paging_schema_version, semantic_paging, updated_at
      FROM timeline_state WHERE server_id = ? AND session_id = ?
    `).get(serverId, sessionId) as {
      has_more: number
      verified_latest_seq: number | null
      known_total: number | null
      next_timeline_before: number | null
      paging_schema_version: number | null
      semantic_paging: number | null
      updated_at: number
    } | undefined
    const rawTail = this.rawEventsBefore(
      serverId,
      sessionId,
      Number.MAX_SAFE_INTEGER,
      CACHED_TIMELINE_TAIL_EVENT_LIMIT
    )
    const events = this.restoreLeadingRunStart(serverId, sessionId, rawTail.events)
    const localHasMore = rawTail.hasMore
    const hasMoreEvents = localHasMore
      || (timeline ? Boolean(timeline.has_more) : (rawTail.windowStartSeq ?? 1) > 1)
    const persistedCursor = timeline?.next_timeline_before ?? null
    const tailTrimmedPastPersistedCursor = localHasMore
      && rawTail.windowStartSeq != null
      && (persistedCursor == null || rawTail.windowStartSeq > persistedCursor)
    const nextTimelineBefore = !hasMoreEvents
      ? null
      : tailTrimmedPastPersistedCursor
        ? rawTail.windowStartSeq
        : persistedCursor ?? rawTail.nextBefore ?? rawTail.windowStartSeq
    return {
      session: parseJSON(row.json, {} as Session),
      events,
      queuedTurns: this.queuedTurns(serverId, sessionId),
      files,
      hasMoreEvents,
      historyVerified: Boolean(timeline && (timeline.verified_latest_seq != null || timeline.known_total != null)),
      eventsTotal: timeline?.known_total ?? null,
      nextTimelineBefore,
      semanticPaging: timeline?.paging_schema_version === TIMELINE_PAGING_SCHEMA_VERSION
        ? timeline.semantic_paging == null ? null : Boolean(timeline.semantic_paging)
        : null,
      filesTotal: fileCount,
      cachedAt: timeline?.updated_at ?? row.updated_at,
      viewState: this.viewState(serverId, sessionId)
    }
  }

  viewState(serverId: string, sessionId: string): ViewState | null {
    if (this.storageFailure) return this.savedJSON('view_state', serverId, sessionId, null)
    const row = this.statement('SELECT json FROM view_state WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string } | undefined
    return row ? parseJSON(row.json, null) : null
  }

  putViewState(serverId: string, state: ViewState): void {
    this.requireDurableStorage()
    this.statement(`
      INSERT INTO view_state(server_id, session_id, json) VALUES (?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json
    `).run(serverId, state.sessionId, JSON.stringify(state))
  }

  pins(serverId: string, sessionId: string): PinnedItem[] {
    return this.statement('SELECT json FROM pins WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId).map(row => parseJSON((row as { json: string }).json, {} as PinnedItem))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  putPin(serverId: string, item: PinnedItem): PinnedItem[] {
    this.requireDurableStorage()
    this.statement(`
      INSERT INTO pins(server_id, session_id, item_id, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, item_id) DO UPDATE SET json = excluded.json
    `).run(serverId, item.sessionId, item.id, JSON.stringify(item))
    return this.pins(serverId, item.sessionId)
  }

  removePin(serverId: string, sessionId: string, itemId: string): PinnedItem[] {
    this.requireDurableStorage()
    this.statement('DELETE FROM pins WHERE server_id = ? AND session_id = ? AND item_id = ?').run(serverId, sessionId, itemId)
    return this.pins(serverId, sessionId)
  }

  replacePins(serverId: string, sessionId: string, items: PinnedItem[]): PinnedItem[] {
    this.requireDurableStorage()
    this.db.exec('BEGIN')
    try {
      this.statement('DELETE FROM pins WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
      const insert = this.statement('INSERT INTO pins(server_id, session_id, item_id, json) VALUES (?, ?, ?, ?)')
      for (const item of items) insert.run(serverId, sessionId, item.id, JSON.stringify(item))
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
    return this.pins(serverId, sessionId)
  }

  preference<T>(serverId: string, key: string, fallback: T): T {
    const row = this.statement('SELECT json FROM preferences WHERE server_id = ? AND key = ?').get(serverId, key) as { json: string } | undefined
    return row ? parseJSON(row.json, fallback) : this.savedJSON('preferences', serverId, key, fallback)
  }

  putPreference<T>(serverId: string, key: string, value: T): void {
    if (!REBUILDABLE_PREFERENCES.has(key)) this.requireDurableStorage()
    this.statement(`
      INSERT INTO preferences(server_id, key, json) VALUES (?, ?, ?)
      ON CONFLICT(server_id, key) DO UPDATE SET json = excluded.json
    `).run(serverId, key, JSON.stringify(value))
  }
}
