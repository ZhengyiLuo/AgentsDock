import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { AgentFile, Event, Job, PinnedItem, QueuedTurn, Session, SessionSnapshot, ViewState } from '../shared/types'

function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
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

export class LocalCache {
  private readonly db: DatabaseSync

  constructor() {
    this.db = new DatabaseSync(join(app.getPath('userData'), 'agentsdock.sqlite'))
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
    const timelineColumns = this.db.prepare('PRAGMA table_info(timeline_state)').all() as Array<{ name: string }>
    if (!timelineColumns.some(column => column.name === 'verified_latest_seq')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN verified_latest_seq INTEGER')
    if (!timelineColumns.some(column => column.name === 'known_total')) this.db.exec('ALTER TABLE timeline_state ADD COLUMN known_total INTEGER')
  }

  sessions(serverId: string): Session[] {
    return this.db.prepare('SELECT json FROM sessions WHERE server_id = ?')
      .all(serverId).map(row => parseJSON((row as { json: string }).json, {} as Session))
      .sort(sessionSort)
  }

  putSessions(serverId: string, sessions: Session[]): void {
    const put = this.db.prepare(`
      INSERT INTO sessions(server_id, session_id, json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `)
    const live = new Set(sessions.map(session => session.id))
    this.db.exec('BEGIN')
    try {
      for (const session of sessions) put.run(serverId, session.id, JSON.stringify(session), Date.now())
      for (const cached of this.sessions(serverId)) {
        if (!live.has(cached.id)) this.db.prepare('DELETE FROM sessions WHERE server_id = ? AND session_id = ?').run(serverId, cached.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  putSession(serverId: string, session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions(server_id, session_id, json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(serverId, session.id, JSON.stringify(session), Date.now())
  }

  removeSession(serverId: string, sessionId: string): void {
    this.db.exec('BEGIN')
    try {
      for (const table of ['sessions', 'events', 'queued_turns', 'files', 'view_state', 'timeline_state', 'pins']) {
        this.db.prepare(`DELETE FROM ${table} WHERE server_id = ? AND session_id = ?`).run(serverId, sessionId)
      }
      this.db.prepare('DELETE FROM jobs WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  jobs(serverId: string): Job[] {
    return this.db.prepare('SELECT json FROM jobs WHERE server_id = ? ORDER BY updated_at DESC')
      .all(serverId).map(row => parseJSON((row as { json: string }).json, {} as Job))
  }

  putJobs(serverId: string, jobs: Job[]): void {
    const put = this.db.prepare('INSERT INTO jobs(server_id, job_id, session_id, json, updated_at) VALUES (?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM jobs WHERE server_id = ?').run(serverId)
      for (const job of jobs) put.run(serverId, job.id, job.session_id, JSON.stringify(job), Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  events(serverId: string, sessionId: string, limit = 720): Event[] {
    const rows = this.db.prepare(`
      SELECT json FROM (
        SELECT seq, json FROM events
        WHERE server_id = ? AND session_id = ? AND json_extract(json, '$.type') <> 'raw_event'
        ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `).all(serverId, sessionId, limit)
    return rows.map(row => parseJSON((row as { json: string }).json, {} as Event))
  }

  eventsBefore(serverId: string, sessionId: string, before: number, limit = 120): Event[] {
    const rows = this.db.prepare(`
      SELECT json FROM (
        SELECT seq, json FROM events
        WHERE server_id = ? AND session_id = ? AND seq < ? AND json_extract(json, '$.type') <> 'raw_event'
        ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `).all(serverId, sessionId, before, limit)
    return rows.map(row => parseJSON((row as { json: string }).json, {} as Event))
  }

  hasEventsBefore(serverId: string, sessionId: string, before: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM events
      WHERE server_id = ? AND session_id = ? AND seq < ? AND json_extract(json, '$.type') <> 'raw_event'
      LIMIT 1
    `).get(serverId, sessionId, before))
  }

  timelineHasMore(serverId: string, sessionId: string): boolean {
    return Boolean(this.timelineState(serverId, sessionId)?.hasMore)
  }

  timelineState(serverId: string, sessionId: string): { hasMore: boolean; verifiedLatestSeq: number | null; knownTotal: number | null } | null {
    const row = this.db.prepare('SELECT has_more, verified_latest_seq, known_total FROM timeline_state WHERE server_id = ? AND session_id = ?')
      .get(serverId, sessionId) as { has_more: number; verified_latest_seq: number | null; known_total: number | null } | undefined
    return row ? { hasMore: Boolean(row.has_more), verifiedLatestSeq: row.verified_latest_seq, knownTotal: row.known_total } : null
  }

  visibleEventCount(serverId: string, sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE server_id = ? AND session_id = ? AND json_extract(json, '$.type') <> 'raw_event'
    `).get(serverId, sessionId) as { count: number }
    return row.count
  }

  session(serverId: string, sessionId: string): Session | null {
    const row = this.db.prepare('SELECT json FROM sessions WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string } | undefined
    return row ? parseJSON(row.json, null) : null
  }

  putEvents(serverId: string, sessionId: string, events: Event[]): void {
    if (!events.length) return
    const put = this.db.prepare(`
      INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, event_id) DO UPDATE SET seq = excluded.seq, json = excluded.json
    `)
    this.db.exec('BEGIN')
    try {
      for (const event of events) put.run(serverId, sessionId, event.seq, event.id, JSON.stringify(event))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  replaceEvents(serverId: string, sessionId: string, events: Event[]): void {
    const put = this.db.prepare(`
      INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, event_id) DO UPDATE SET seq = excluded.seq, json = excluded.json
    `)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM events WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
      for (const event of events) put.run(serverId, sessionId, event.seq, event.id, JSON.stringify(event))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  putTimelineState(serverId: string, sessionId: string, hasMore: boolean, verifiedLatestSeq?: number | null, knownTotal?: number | null): void {
    this.db.prepare(`
      INSERT INTO timeline_state(server_id, session_id, has_more, verified_latest_seq, known_total, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET
        has_more = excluded.has_more,
        verified_latest_seq = COALESCE(excluded.verified_latest_seq, timeline_state.verified_latest_seq),
        known_total = COALESCE(excluded.known_total, timeline_state.known_total),
        updated_at = excluded.updated_at
    `).run(serverId, sessionId, hasMore ? 1 : 0, verifiedLatestSeq ?? null, knownTotal ?? null, Date.now())
  }

  queuedTurns(serverId: string, sessionId: string): QueuedTurn[] {
    return this.db.prepare('SELECT json FROM queued_turns WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId)
      .map(row => parseJSON((row as { json: string }).json, {} as QueuedTurn))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  }

  putQueuedTurns(serverId: string, sessionId: string, turns: QueuedTurn[]): void {
    this.db.prepare('DELETE FROM queued_turns WHERE server_id = ? AND session_id = ?').run(serverId, sessionId)
    const put = this.db.prepare('INSERT INTO queued_turns(server_id, session_id, queued_id, json) VALUES (?, ?, ?, ?)')
    for (const turn of turns) put.run(serverId, sessionId, turn.queued_id, JSON.stringify(turn))
  }

  files(serverId: string, sessionId: string, limit = 120): AgentFile[] {
    return this.db.prepare('SELECT json FROM files WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId).map(row => parseJSON((row as { json: string }).json, {} as AgentFile))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, limit)
  }

  putFiles(serverId: string, sessionId: string, files: AgentFile[]): void {
    const put = this.db.prepare(`
      INSERT INTO files(server_id, session_id, file_id, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, file_id) DO UPDATE SET json = excluded.json
    `)
    for (const file of files) put.run(serverId, sessionId, file.id, JSON.stringify(file))
  }

  snapshot(serverId: string, sessionId: string): SessionSnapshot | null {
    const row = this.db.prepare('SELECT json, updated_at FROM sessions WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string; updated_at: number } | undefined
    if (!row) return null
    const events = this.events(serverId, sessionId)
    const files = this.files(serverId, sessionId)
    const fileCount = (this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { count: number }).count
    const timeline = this.db.prepare('SELECT has_more, verified_latest_seq, known_total, updated_at FROM timeline_state WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { has_more: number; verified_latest_seq: number | null; known_total: number | null; updated_at: number } | undefined
    const localHasMore = events.length > 0 && this.hasEventsBefore(serverId, sessionId, events[0].seq)
    return {
      session: parseJSON(row.json, {} as Session),
      events,
      queuedTurns: this.queuedTurns(serverId, sessionId),
      files,
      hasMoreEvents: localHasMore || (timeline ? Boolean(timeline.has_more) : (events[0]?.seq ?? 1) > 1),
      eventsTotal: timeline?.known_total ?? null,
      filesTotal: fileCount,
      cachedAt: timeline?.updated_at ?? row.updated_at,
      viewState: this.viewState(serverId, sessionId)
    }
  }

  viewState(serverId: string, sessionId: string): ViewState | null {
    const row = this.db.prepare('SELECT json FROM view_state WHERE server_id = ? AND session_id = ?').get(serverId, sessionId) as { json: string } | undefined
    return row ? parseJSON(row.json, null) : null
  }

  putViewState(serverId: string, state: ViewState): void {
    this.db.prepare(`
      INSERT INTO view_state(server_id, session_id, json) VALUES (?, ?, ?)
      ON CONFLICT(server_id, session_id) DO UPDATE SET json = excluded.json
    `).run(serverId, state.sessionId, JSON.stringify(state))
  }

  pins(serverId: string, sessionId: string): PinnedItem[] {
    return this.db.prepare('SELECT json FROM pins WHERE server_id = ? AND session_id = ?')
      .all(serverId, sessionId).map(row => parseJSON((row as { json: string }).json, {} as PinnedItem))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  putPin(serverId: string, item: PinnedItem): PinnedItem[] {
    this.db.prepare(`
      INSERT INTO pins(server_id, session_id, item_id, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, session_id, item_id) DO UPDATE SET json = excluded.json
    `).run(serverId, item.sessionId, item.id, JSON.stringify(item))
    return this.pins(serverId, item.sessionId)
  }

  removePin(serverId: string, sessionId: string, itemId: string): PinnedItem[] {
    this.db.prepare('DELETE FROM pins WHERE server_id = ? AND session_id = ? AND item_id = ?').run(serverId, sessionId, itemId)
    return this.pins(serverId, sessionId)
  }

  preference<T>(serverId: string, key: string, fallback: T): T {
    const row = this.db.prepare('SELECT json FROM preferences WHERE server_id = ? AND key = ?').get(serverId, key) as { json: string } | undefined
    return row ? parseJSON(row.json, fallback) : fallback
  }

  putPreference<T>(serverId: string, key: string, value: T): void {
    this.db.prepare(`
      INSERT INTO preferences(server_id, key, json) VALUES (?, ?, ?)
      ON CONFLICT(server_id, key) DO UPDATE SET json = excluded.json
    `).run(serverId, key, JSON.stringify(value))
  }
}
