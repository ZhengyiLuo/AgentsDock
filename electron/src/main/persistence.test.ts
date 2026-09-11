import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { Event, Job, PinnedItem, Session } from '../shared/types'
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../shared/event-compaction'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import {
  CacheNamespaceCollisionError,
  LocalCache,
  TIMELINE_PAGING_SCHEMA_VERSION
} from './persistence'

const openCaches: LocalCache[] = []

function cache(): LocalCache {
  const value = new LocalCache(':memory:')
  openCaches.push(value)
  return value
}

function session(id: string, archived = false): Session {
  return { id, title: `Chat ${id}`, backend: 'codex', archived }
}

function event(sessionId: string, index: number, text: string): Event {
  return {
    id: `${sessionId}-event-${index}`,
    session_id: sessionId,
    seq: index + 1,
    type: 'assistant_text',
    ts: `2026-07-13T12:${String(index % 60).padStart(2, '0')}:00Z`,
    text
  }
}

function cacheDatabase(value: LocalCache): DatabaseSync {
  return (value as unknown as { db: DatabaseSync }).db
}

afterEach(() => {
  while (openCaches.length) openCaches.pop()?.close()
})

describe('prepared statement reuse', () => {
  it('caches each SQL statement and releases the cache before closing', () => {
    const value = new LocalCache(':memory:')
    const internals = value as unknown as { statements: Map<string, unknown> }
    const initialStatements = internals.statements.size

    value.sessions('server')
    const afterFirstQuery = internals.statements.size
    value.sessions('server')

    expect(afterFirstQuery).toBe(initialStatements + 1)
    expect(internals.statements.size).toBe(afterFirstQuery)

    value.close()
    expect(internals.statements.size).toBe(0)
  })
})

describe('transaction error preservation', () => {
  it('keeps the primary write error when SQLite has already rolled back the transaction', () => {
    const value = cache()
    const database = cacheDatabase(value)
    database.exec(`
      CREATE TRIGGER fail_session_write BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(ROLLBACK, 'forced primary write failure');
      END;
    `)

    expect(() => value.putSession('server', session('chat'))).toThrow('forced primary write failure')
    expect(database.isTransaction).toBe(false)
  })
})

describe('pinned item mirror', () => {
  it('replaces one chat exactly without touching another chat', () => {
    const value = cache()
    const oldPin: PinnedItem = { id: 'message:old', sessionId: 'chat-1', kind: 'message', eventId: 'old', title: 'Old', createdAt: 1 }
    const nextPin: PinnedItem = { id: 'message:new', sessionId: 'chat-1', kind: 'message', eventId: 'new', title: 'New', createdAt: 2 }
    const otherPin: PinnedItem = { id: 'message:other', sessionId: 'chat-2', kind: 'message', eventId: 'other', title: 'Other', createdAt: 3 }
    value.putPin('server', oldPin)
    value.putPin('server', otherPin)

    expect(value.replacePins('server', 'chat-1', [nextPin])).toEqual([nextPin])
    expect(value.pins('server', 'chat-1')).toEqual([nextPin])
    expect(value.pins('server', 'chat-2')).toEqual([otherPin])
  })
})

describe('cached timeline event compaction', () => {
  it('migrates stale foreign fork artifacts without consuming pages or search results', () => {
    const value = cache()
    value.putSession('server', session('child'))
    value.putEvents('server', 'child', [{
      id: 'current-message',
      session_id: 'child',
      seq: 1,
      type: 'assistant_text',
      ts: 'now',
      text: 'Current child response'
    }])
    const database = cacheDatabase(value)
    const foreign: Event = {
      id: 'foreign-artifact',
      session_id: 'child',
      seq: 2,
      type: 'artifact_created',
      ts: 'now',
      artifact: {
        id: 'parent-file',
        session_id: 'parent',
        filename: 'parent-secret.txt',
        content_type: 'text/plain'
      }
    }
    database.prepare(
      'INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)'
    ).run('server', 'child', foreign.seq, foreign.id, JSON.stringify(foreign))
    const searchResult = database.prepare(
      'INSERT INTO event_search(text, server_id, session_id, event_id, seq, ts, role) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('parent-secret.txt', 'server', 'child', foreign.id, foreign.seq, foreign.ts, 'file') as { lastInsertRowid: number | bigint }
    database.prepare(
      'INSERT INTO event_search_keys(server_id, session_id, event_id, search_rowid) VALUES (?, ?, ?, ?)'
    ).run('server', 'child', foreign.id, Number(searchResult.lastInsertRowid))
    database.prepare(
      'INSERT INTO files(server_id, session_id, file_id, json) VALUES (?, ?, ?, ?)'
    ).run('server', 'child', 'parent-file', JSON.stringify(foreign.artifact))
    database.prepare(
      'UPDATE cache_meta SET value = ? WHERE key = ?'
    ).run('0', 'file-ownership-schema')

    ;(value as unknown as { migrateFileOwnershipCache(): void }).migrateFileOwnershipCache()

    expect(value.rawEventsBefore('server', 'child', 3, 1).events.map(item => item.id)).toEqual(['current-message'])
    expect(value.visibleEventCount('server', 'child')).toBe(1)
    expect(value.searchEvents('server', 'child', 'parent-secret')).toEqual([])
    expect(value.files('server', 'child')).toEqual([])
  })

  it('keeps current and legacy files while rejecting explicitly foreign cache writes', () => {
    const value = cache()
    value.putFiles('server', 'child', [
      { id: 'current', session_id: 'child', filename: 'current.txt' },
      { id: 'legacy', filename: 'legacy.txt' },
      { id: 'foreign', session_id: 'parent', filename: 'foreign.txt' }
    ])

    expect(value.files('server', 'child').map(file => file.id).sort()).toEqual(['current', 'legacy'])
  })

  it('compacts oversized tool results before writing them without touching assistant text', () => {
    const value = cache()
    const toolOutput = 't'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 23)
    const assistantText = 'a'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 23)
    value.putEvents('server', 'chat', [
      {
        id: 'tool-result', session_id: 'chat', seq: 1, type: 'tool_finished',
        ts: '2026-07-24T12:00:00Z', output: toolOutput
      },
      {
        id: 'assistant', session_id: 'chat', seq: 2, type: 'assistant_text',
        ts: '2026-07-24T12:00:01Z', text: assistantText
      }
    ])

    const cached = value.events('server', 'chat')
    expect(cached[0].output).toBe(
      `${'t'.repeat(TOOL_OUTPUT_PREVIEW_CHARS)}\n\n[AgentsDock omitted 23 characters from this tool output]`
    )
    expect(cached[1].text).toBe(assistantText)

    const stored = cacheDatabase(value).prepare(
      'SELECT json FROM events WHERE server_id = ? AND session_id = ? AND event_id = ?'
    ).get('server', 'chat', 'tool-result') as { json: string }
    expect((JSON.parse(stored.json) as Event).output).toBe(cached[0].output)
  })

  it('compacts an oversized legacy row when reading it without rewriting the database', () => {
    const value = cache()
    const legacyOutput = 'l'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 41)
    const legacy: Event = {
      id: 'legacy-tool', session_id: 'chat', seq: 1, type: 'tool_finished',
      ts: '2026-07-24T12:00:00Z', output: legacyOutput
    }
    const database = cacheDatabase(value)
    database.prepare(
      'INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)'
    ).run('server', 'chat', legacy.seq, legacy.id, JSON.stringify(legacy))

    expect(value.events('server', 'chat')[0].output).toBe(
      `${'l'.repeat(TOOL_OUTPUT_PREVIEW_CHARS)}\n\n[AgentsDock omitted 41 characters from this tool output]`
    )
    expect(value.eventsBefore('server', 'chat', 2)[0].output).toContain('AgentsDock omitted 41 characters')

    const stored = database.prepare(
      'SELECT json FROM events WHERE server_id = ? AND session_id = ? AND event_id = ?'
    ).get('server', 'chat', legacy.id) as { json: string }
    expect((JSON.parse(stored.json) as Event).output).toBe(legacyOutput)
  })
})

describe('bounded raw cached timeline paging', () => {
  it('pages cached rows without making local semantic grouping claims', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putEvents('server', 'chat', [
      { id: 'old-start', session_id: 'chat', seq: 1, type: 'turn_started', ts: 'now', run_id: 'old', prompt: 'Old question' },
      { id: 'old-finish', session_id: 'chat', seq: 2, type: 'turn_finished', ts: 'now', run_id: 'old', result_text: 'Old answer' },
      { id: 'job-link-1', session_id: 'chat', seq: 3, type: 'job_ran', ts: 'now', run_id: 'job-run-1', job_id: 'job-1' },
      { id: 'job-start-1', session_id: 'chat', seq: 4, type: 'turn_started', ts: 'now', run_id: 'job-run-1' },
      { id: 'job-finish-1', session_id: 'chat', seq: 5, type: 'turn_finished', ts: 'now', run_id: 'job-run-1', result_text: 'Healthy' },
      { id: 'job-link-2', session_id: 'chat', seq: 6, type: 'job_ran', ts: 'now', run_id: 'job-run-2', job_id: 'job-1' },
      { id: 'job-start-2', session_id: 'chat', seq: 7, type: 'turn_started', ts: 'now', run_id: 'job-run-2' },
      { id: 'job-finish-2', session_id: 'chat', seq: 8, type: 'turn_finished', ts: 'now', run_id: 'job-run-2', result_text: 'Still healthy' },
      { id: 'new-start', session_id: 'chat', seq: 9, type: 'turn_started', ts: 'now', run_id: 'new', prompt: 'New question' },
      { id: 'new-finish', session_id: 'chat', seq: 10, type: 'turn_finished', ts: 'now', run_id: 'new', result_text: 'New answer' }
    ])

    const latest = value.rawEventsBefore('server', 'chat', 11, 4)
    expect(latest).not.toHaveProperty('semanticItemCount')
    expect(latest.nextBefore).toBe(7)
    expect(latest.hasMore).toBe(true)
    expect(latest.events.map(candidate => candidate.id)).toEqual([
      'job-start-2', 'job-finish-2', 'new-start', 'new-finish'
    ])

    const older = value.rawEventsBefore('server', 'chat', latest.nextBefore!, 4)
    expect(older).not.toHaveProperty('semanticItemCount')
    expect(older.nextBefore).toBe(3)
    expect(older.hasMore).toBe(true)
    expect(older.events.map(candidate => candidate.id)).toEqual([
      'job-link-1', 'job-start-1', 'job-finish-1', 'job-link-2'
    ])
  })

  it('advances its raw cursor even when a turn crosses the page boundary', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putEvents('server', 'chat', [
      {
        id: 'long-start', session_id: 'chat', seq: 1, type: 'turn_started',
        ts: 'now', run_id: 'long', prompt: 'Long question'
      },
      {
        id: 'standalone-error', session_id: 'chat', seq: 2, type: 'error',
        ts: 'now', error: 'Independent failure'
      },
      {
        id: 'long-finish', session_id: 'chat', seq: 4, type: 'turn_finished',
        ts: 'now', run_id: 'long', result_text: 'Long answer'
      },
      {
        id: 'latest-start', session_id: 'chat', seq: 5, type: 'turn_started',
        ts: 'now', run_id: 'latest', prompt: 'Latest question'
      },
      {
        id: 'latest-finish', session_id: 'chat', seq: 6, type: 'turn_finished',
        ts: 'now', run_id: 'latest', result_text: 'Latest answer'
      }
    ])

    const latest = value.rawEventsBefore('server', 'chat', 7, 2)
    expect(latest.nextBefore).toBe(5)
    expect(latest.hasMore).toBe(true)
    expect(latest.events.map(candidate => candidate.id)).toEqual(['latest-start', 'latest-finish'])

    const error = value.rawEventsBefore('server', 'chat', latest.nextBefore!, 2)
    expect(error.nextBefore).toBe(2)
    expect(error.hasMore).toBe(true)
    expect(error.events.map(candidate => candidate.id)).toEqual(['standalone-error', 'long-finish'])

    const oldest = value.rawEventsBefore('server', 'chat', error.nextBefore!, 2)
    expect(oldest.nextBefore).toBeNull()
    expect(oldest.hasMore).toBe(false)
    expect(oldest.events.map(candidate => candidate.id)).toEqual(['long-start'])
  })

  it('retains explicit legacy job metadata without synthesizing a local semantic page', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putEvents('server', 'chat', [
      {
        id: 'legacy-start', session_id: 'chat', seq: 1, type: 'turn_started',
        ts: 'now', run_id: 'legacy-run', purpose: 'scheduled_job', prompt: 'Check training'
      },
      {
        id: 'legacy-finish', session_id: 'chat', seq: 2, type: 'turn_finished',
        ts: 'now', run_id: 'legacy-run', purpose: 'scheduled_job',
        result_text: 'Training is healthy'
      },
      {
        id: 'legacy-link', session_id: 'chat', seq: 3, type: 'job_ran',
        ts: 'now', run_id: 'legacy-run', job_id: 'job-1'
      }
    ])

    const page = value.rawEventsBefore('server', 'chat', 4, 10)
    expect(page).not.toHaveProperty('semanticItemCount')
    expect(page.nextBefore).toBeNull()
    expect(page.hasMore).toBe(false)
    expect(page.events.map(candidate => candidate.id)).toEqual([
      'legacy-start',
      'legacy-finish',
      'legacy-link'
    ])
  })

  it('hydrates a bounded raw tail and advances from its safe local boundary', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    const events: Event[] = []
    for (let index = 0; index < 480; index += 1) {
      const sequence = index * 2 + 1
      events.push(
        {
          id: `start-${index}`, session_id: 'chat', seq: sequence, type: 'turn_started',
          ts: 'now', run_id: `run-${index}`, prompt: `Question ${index}`
        },
        {
          id: `finish-${index}`, session_id: 'chat', seq: sequence + 1, type: 'turn_finished',
          ts: 'now', run_id: `run-${index}`, result_text: `Answer ${index}`
        }
      )
    }
    value.putEvents('server', 'chat', events)
    value.putTimelineState('server', 'chat', true, 960, 960, 1)

    const snapshot = value.snapshot('server', 'chat')

    expect(snapshot?.events).toHaveLength(720)
    expect(snapshot?.events.filter(candidate => candidate.type === 'turn_started')).toHaveLength(360)
    expect(snapshot?.events[0]?.id).toBe('start-120')
    expect(snapshot?.nextTimelineBefore).toBe(241)
    expect(snapshot?.hasMoreEvents).toBe(true)
  })

  it('caps each raw fallback read by its requested indexed row limit', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putEvents('server', 'chat', [
      {
        id: 'start', session_id: 'chat', seq: 1, type: 'turn_started',
        ts: 'now', run_id: 'large-run', prompt: 'Large question'
      },
      ...Array.from({ length: 20 }, (_, index): Event => ({
        id: `tool-${index}`, session_id: 'chat', seq: index + 2, type: 'tool_finished',
        ts: 'now', run_id: 'large-run', output: `Tool ${index}`
      })),
      {
        id: 'finish', session_id: 'chat', seq: 22, type: 'turn_finished',
        ts: 'now', run_id: 'large-run', result_text: 'Large answer'
      }
    ])

    const page = value.rawEventsBefore('server', 'chat', 23, 8)

    expect(page.events).toHaveLength(8)
    expect(page.events[0]?.id).toBe('tool-13')
    expect(page.events.at(-1)?.id).toBe('finish')
    expect(page.nextBefore).toBe(15)
  })

  it('bounds JSON processing to an indexed sequence window', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    cacheDatabase(value).prepare(
      'INSERT INTO events(server_id, session_id, seq, event_id, json) VALUES (?, ?, ?, ?, ?)'
    ).run('server', 'chat', 1, 'malformed-old-row', '{')
    value.putEvents('server', 'chat', [
      ...Array.from({ length: 2_500 }, (_, index): Event => ({
        id: `raw-${index}`, session_id: 'chat', seq: index + 2, type: 'raw_event',
        ts: 'now', raw: `Packet ${index}`
      })),
      {
        id: 'recent-start', session_id: 'chat', seq: 2_502, type: 'turn_started',
        ts: 'now', run_id: 'recent-run', prompt: 'Recent question'
      },
      {
        id: 'recent-finish', session_id: 'chat', seq: 2_503, type: 'turn_finished',
        ts: 'now', run_id: 'recent-run', result_text: 'Recent answer'
      }
    ])

    const page = value.rawEventsBefore('server', 'chat', Number.MAX_SAFE_INTEGER, 2_000)

    expect(page.events.map(candidate => candidate.id)).toEqual(['recent-start', 'recent-finish'])
    expect(page.hasMore).toBe(true)
    expect(page.nextBefore).toBe(504)
  })

  it('keeps the opening user message when the cached tail starts mid-turn', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putEvents('server', 'chat', [
      {
        id: 'long-start', session_id: 'chat', seq: 1, type: 'turn_started',
        ts: 'now', run_id: 'long-run', prompt: 'Do not hide this message'
      },
      ...Array.from({ length: 760 }, (_, index): Event => ({
        id: `long-trace-${index}`, session_id: 'chat', seq: index + 2,
        type: 'tool_finished', ts: 'now', run_id: 'long-run', output: `Trace ${index}`
      })),
      {
        id: 'long-answer', session_id: 'chat', seq: 762, type: 'assistant_text',
        ts: 'now', run_id: 'long-run', text: 'Finished'
      }
    ])
    value.putTimelineState('server', 'chat', true, 762, 762, 42, false)

    const snapshot = value.snapshot('server', 'chat')

    expect(snapshot?.events[0]).toMatchObject({
      id: 'long-start',
      type: 'turn_started',
      prompt: 'Do not hide this message'
    })
    expect(snapshot?.events.at(-1)?.id).toBe('long-answer')
    // The restored turn start is display-only. Pagination must continue from
    // the actual bounded tail edge so cached events in between are not skipped.
    expect(snapshot?.nextTimelineBefore).toBe(43)
  })

  it('persists and clears the semantic cursor independently of raw event metadata', () => {
    const value = cache()
    value.putSession('server', session('chat'))
    value.putTimelineState('server', 'chat', true, 50, 100, 42)
    expect(value.timelineState('server', 'chat')?.nextTimelineBefore).toBe(42)

    value.putTimelineState('server', 'chat', false, undefined, undefined, null)
    expect(value.timelineState('server', 'chat')?.nextTimelineBefore).toBeNull()
  })

  it('records semantic paging capability separately from legacy verified state', () => {
    const value = cache()
    value.putSession('server', session('semantic'))
    value.putTimelineState('server', 'semantic', true, 50, 100, 42, true)

    expect(value.timelineState('server', 'semantic')).toMatchObject({
      pagingSchemaVersion: TIMELINE_PAGING_SCHEMA_VERSION,
      semanticPaging: true
    })
    expect(value.snapshot('server', 'semantic')?.semanticPaging).toBe(true)

    value.putSession('server', session('legacy'))
    value.putTimelineState('server', 'legacy', true, 50, 100, 42, false)
    expect(value.timelineState('server', 'legacy')).toMatchObject({
      pagingSchemaVersion: TIMELINE_PAGING_SCHEMA_VERSION,
      semanticPaging: false
    })
    expect(value.snapshot('server', 'legacy')?.semanticPaging).toBe(false)

    value.putSession('server', session('pre-migration'))
    value.putTimelineState('server', 'pre-migration', true, 50, 100, 42)
    expect(value.timelineState('server', 'pre-migration')).toMatchObject({
      pagingSchemaVersion: null,
      semanticPaging: null
    })
    expect(value.snapshot('server', 'pre-migration')?.semanticPaging).toBeNull()
  })

  it('invalidates v2 semantic paging state so media-omission caches are audited again', () => {
    const value = cache()
    value.putSession('server', session('v2-cache'))
    value.putTimelineState('server', 'v2-cache', true, 50, 100, 42, true)
    const unsafe = value as unknown as {
      statement(sql: string): { run(...values: unknown[]): unknown }
    }
    unsafe.statement(`
      UPDATE timeline_state
      SET paging_schema_version = 2
      WHERE server_id = ? AND session_id = ?
    `).run('server', 'v2-cache')

    expect(TIMELINE_PAGING_SCHEMA_VERSION).toBe(3)
    expect(value.timelineState('server', 'v2-cache')?.pagingSchemaVersion).toBe(2)
    expect(value.snapshot('server', 'v2-cache')?.semanticPaging).toBeNull()
  })
})

describe('local FTS history index', () => {
  it('searches thousands of cached events once per active chat and excludes archived content', () => {
    const value = cache()
    const active = Array.from({ length: 80 }, (_, index) => session(`active-${index}`))
    const archived = Array.from({ length: 40 }, (_, index) => session(`archived-${index}`, true))
    value.putSessions('server', [...active, ...archived])
    for (const chat of [...active, ...archived]) {
      value.putEvents('server', chat.id, Array.from({ length: 100 }, (_, index) => (
        event(chat.id, index, index === 99 ? `needle result for ${chat.id}` : `ordinary update ${index}`)
      )))
    }

    const started = performance.now()
    const results = value.searchSessions('server', 'needle', 100)
    const elapsed = performance.now() - started

    expect(results).toHaveLength(active.length)
    expect(new Set(results.map(result => result.session_id))).toEqual(new Set(active.map(chat => chat.id)))
    expect(elapsed).toBeLessThan(500)

    const commonStarted = performance.now()
    expect(value.searchSessions('server', 'ordinary', 100)).toHaveLength(active.length)
    expect(performance.now() - commonStarted).toBeLessThan(500)
  })

  it('keeps archived history out of FTS and backfills it after unarchiving', () => {
    const value = cache()
    const archived = session('archive', true)
    value.putSession('server', archived)
    value.putEvents('server', archived.id, [event(archived.id, 0, 'needle from archive')])
    expect(value.searchSessions('server', 'needle')).toEqual([])

    value.putSession('server', { ...archived, archived: false })
    expect(value.backfillSearchIndexBatch()).toBe(1)
    expect(value.searchSessions('server', 'needle')).toEqual([
      expect.objectContaining({ session_id: archived.id })
    ])
    expect(value.searchBackfillComplete()).toBe(false)
    expect(value.backfillSearchIndexBatch()).toBe(0)
    expect(value.searchBackfillComplete()).toBe(true)

    value.putSession('server', archived)
    expect(value.searchSessions('server', 'needle')).toEqual([])
    expect(value.searchBackfillComplete()).toBe(true)

    value.putSession('server', { ...archived, archived: false })
    expect(value.searchBackfillComplete()).toBe(false)
  })

  it('advances legacy indexing in bounded batches without restarting completed work', () => {
    const value = cache()
    const archived = session('legacy', true)
    value.putSession('server', archived)
    value.putEvents('server', archived.id, [
      event(archived.id, 0, 'first legacy result'),
      event(archived.id, 1, 'second legacy result'),
      event(archived.id, 2, 'third legacy result')
    ])
    value.putSession('server', { ...archived, archived: false })

    expect(value.backfillSearchIndexBatch(1)).toBe(1)
    expect(value.searchEvents('server', archived.id, 'legacy')).toHaveLength(1)
    expect(value.backfillSearchIndexBatch(1)).toBe(1)
    expect(value.searchEvents('server', archived.id, 'legacy')).toHaveLength(2)
    expect(value.backfillSearchIndexBatch(1)).toBe(1)
    expect(value.searchEvents('server', archived.id, 'legacy')).toHaveLength(3)
    expect(value.backfillSearchIndexBatch(1)).toBe(0)
    expect(value.searchBackfillComplete()).toBe(true)

    value.putSession('server', { ...archived, archived: false, title: 'Updated title' })
    expect(value.searchBackfillComplete()).toBe(true)
  })

  it('reopens a completed backfill when a session refresh unarchives history', () => {
    const value = cache()
    const archived = session('bulk-unarchive', true)
    value.putSessions('server', [archived])
    value.putEvents('server', archived.id, [event(archived.id, 0, 'bulk refresh result')])
    expect(value.backfillSearchIndexBatch()).toBe(1)
    expect(value.backfillSearchIndexBatch()).toBe(0)
    expect(value.searchBackfillComplete()).toBe(true)

    value.putSessions('server', [{ ...archived, archived: false }])
    expect(value.searchBackfillComplete()).toBe(false)
    expect(value.backfillSearchIndexBatch()).toBe(1)
    expect(value.searchSessions('server', 'bulk refresh')).toEqual([
      expect.objectContaining({ session_id: archived.id })
    ])
  })
})

describe('multi-server cache foundations', () => {
  it('purges every table and search row for removed profile namespaces without touching another profile', () => {
    const value = cache()
    const removedNamespaces = ['profile:removed', 'server-removed']
    for (const namespace of removedNamespaces) {
      const chat = session(`chat-${namespace}`)
      value.putSession(namespace, chat)
      value.putEvents(namespace, chat.id, [event(chat.id, 0, 'confidential removal marker')])
      value.putQueuedTurns(namespace, chat.id, [{ queued_id: 'queued', prompt: 'private', file_ids: [] }])
      value.putJobs(namespace, [{ id: 'job', session_id: chat.id, title: 'Private', prompt: 'private', interval_seconds: 60 }])
      value.putFiles(namespace, chat.id, [{ id: 'file', filename: 'private.txt' }])
      value.putViewState(namespace, { sessionId: chat.id, topItemId: 'event', updatedAt: 1 })
      value.putTimelineState(namespace, chat.id, true, 1, 1, 1, true)
      value.putPin(namespace, { id: 'pin', sessionId: chat.id, kind: 'message', title: 'Private', createdAt: 1 })
      value.putPreference(namespace, 'private', 'value')
    }
    value.putSession('server-keep', session('keep'))

    value.removeServerNamespaces(removedNamespaces)

    expect(value.cachedServerIds()).toEqual(['server-keep'])
    for (const namespace of removedNamespaces) {
      expect(value.sessions(namespace)).toEqual([])
      expect(value.searchSessions(namespace, 'confidential')).toEqual([])
      expect(value.jobs(namespace)).toEqual([])
      expect(value.preference(namespace, 'private', null)).toBeNull()
    }
    expect(value.sessions('server-keep')).toEqual([session('keep')])
  })

  it('removes all child rows when an authoritative session list drops a chat', () => {
    const value = cache()
    const removed = session('removed')
    const retained = session('retained')
    value.putSessions('server', [removed, retained])
    value.putEvents('server', removed.id, [event(removed.id, 0, 'vanished history')])
    value.putQueuedTurns('server', removed.id, [{ queued_id: 'queued', prompt: 'later', file_ids: [] }])
    value.putJobs('server', [{ id: 'job', session_id: removed.id, title: 'Job', prompt: 'Run', interval_seconds: 60 }])
    value.putFiles('server', removed.id, [{ id: 'file', filename: 'private.txt' }])
    value.putViewState('server', { sessionId: removed.id, topItemId: 'event', updatedAt: 1 })
    value.putTimelineState('server', removed.id, true, 1, 1, 1, true)
    value.putPin('server', { id: 'pin', sessionId: removed.id, kind: 'message', title: 'Private', createdAt: 1 })

    value.putSessions('server', [retained])

    expect(value.session('server', removed.id)).toBeNull()
    expect(value.events('server', removed.id)).toEqual([])
    expect(value.queuedTurns('server', removed.id)).toEqual([])
    expect(value.jobs('server')).toEqual([])
    expect(value.files('server', removed.id)).toEqual([])
    expect(value.viewState('server', removed.id)).toBeNull()
    expect(value.timelineState('server', removed.id)).toBeNull()
    expect(value.pins('server', removed.id)).toEqual([])
    expect(value.searchSessions('server', 'vanished')).toEqual([])
    expect(value.sessions('server')).toEqual([retained])
  })

  it('moves a fallback namespace transactionally and rebuilds its FTS index', () => {
    const value = cache()
    const source = 'profile:profile-1'
    const target = 'server-canonical'
    const chat: Session = {
      ...session('chat-1'),
      codex_thread_id: 'thread-1',
      latest_agent_event_seq: 3,
      last_read_agent_event_seq: 1,
      pinned: true,
      created_at: '2026-07-13T10:00:00Z'
    }
    const job: Job = {
      id: 'job-1', session_id: chat.id, title: 'Job', prompt: 'Run', interval_seconds: 60
    }
    value.putSession(source, chat)
    value.putEvents(source, chat.id, [event(chat.id, 0, 'canonical migration needle')])
    value.putJobs(source, [job])
    value.putQueuedTurns(source, chat.id, [{ queued_id: 'queued-1', prompt: 'Later', file_ids: [] }])
    value.putFiles(source, chat.id, [{ id: 'file-1', filename: 'result.txt' }])
    value.putViewState(source, { sessionId: chat.id, topItemId: 'event-1', updatedAt: 42 })
    value.putTimelineState(source, chat.id, true, 3, 10)
    value.putPin(source, { id: 'pin-1', sessionId: chat.id, kind: 'message', title: 'Pinned', createdAt: 10 })
    value.putPreference(source, 'selectedSessionId', chat.id)

    const result = value.mergeServerNamespace(source, target)

    expect(result).toMatchObject({
      sourceServerId: source,
      targetServerId: target,
      moved: true,
      sourceSessionCount: 1,
      targetSessionCountBefore: 0
    })
    expect(result.targetSummary).toMatchObject({
      sessionCount: 1,
      unreadCount: 1,
      pinnedCount: 1
    })
    expect(value.cachedServerIds()).toEqual([target])
    expect(value.sessions(source)).toEqual([])
    expect(value.sessions(target)).toEqual([chat])
    expect(value.searchSessions(source, 'needle')).toEqual([])
    expect(value.searchSessions(target, 'needle')).toEqual([
      expect.objectContaining({ session_id: chat.id })
    ])
    expect(value.jobs(target)).toEqual([job])
    expect(value.queuedTurns(target, chat.id)).toEqual([
      expect.objectContaining({ queued_id: 'queued-1' })
    ])
    expect(value.files(target, chat.id)).toEqual([
      expect.objectContaining({ id: 'file-1' })
    ])
    expect(value.viewState(target, chat.id)).toEqual(expect.objectContaining({ updatedAt: 42 }))
    expect(value.timelineState(target, chat.id)).toEqual({
      hasMore: true,
      verifiedLatestSeq: 3,
      knownTotal: 10,
      nextTimelineBefore: null,
      pagingSchemaVersion: null,
      semanticPaging: null
    })
    expect(value.pins(target, chat.id)).toEqual([expect.objectContaining({ id: 'pin-1' })])
    expect(value.preference(target, 'selectedSessionId', null)).toBe(chat.id)
  })

  it('merges non-conflicting namespaces without duplicating FTS rows or session IDs', () => {
    const value = cache()
    const source = 'profile:profile-2'
    const target = 'server-existing'
    const shared = {
      ...session('shared'),
      codex_thread_id: 'shared-thread',
      created_at: '2026-07-13T10:00:00Z'
    }
    value.putSessions(target, [shared, session('target-only')])
    value.putEvents(target, shared.id, [event(shared.id, 0, 'needle target copy')])
    value.putSessions(source, [shared, session('source-only')])
    value.putEvents(source, shared.id, [
      event(shared.id, 0, 'needle source duplicate'),
      event(shared.id, 1, 'needle source addition')
    ])
    value.putEvents(source, 'source-only', [event('source-only', 0, 'needle source-only')])

    const result = value.mergeServerNamespace(source, target)

    expect(result.moved).toBe(false)
    expect(new Set(value.sessions(target).map(item => item.id))).toEqual(new Set(['shared', 'target-only', 'source-only']))
    expect(value.events(target, shared.id)).toHaveLength(2)
    expect(value.searchEvents(target, shared.id, 'needle')).toHaveLength(2)
    expect(value.searchSessions(target, 'needle')).toHaveLength(2)
    expect(value.searchSessions(source, 'needle')).toEqual([])

    value.replaceEvents(target, shared.id, [event(shared.id, 2, 'replacement needle')])
    expect(value.searchEvents(target, shared.id, 'needle')).toEqual([
      expect.objectContaining({ event_id: 'shared-event-2' })
    ])
  })

  it('rejects an ambiguous same-session collision without changing either namespace', () => {
    const value = cache()
    const source = 'profile:profile-3'
    const target = 'server-other'
    value.putSession(source, { ...session('collision'), codex_thread_id: 'thread-source' })
    value.putEvents(source, 'collision', [event('collision', 0, 'source marker')])
    value.putSession(target, { ...session('collision'), codex_thread_id: 'thread-target' })
    value.putEvents(target, 'collision', [event('collision', 0, 'target marker')])

    expect(() => value.mergeServerNamespace(source, target)).toThrow(CacheNamespaceCollisionError)
    expect(value.sessions(source)).toHaveLength(1)
    expect(value.sessions(target)).toHaveLength(1)
    expect(value.searchSessions(source, 'source marker')).toHaveLength(1)
    expect(value.searchSessions(target, 'target marker')).toHaveLength(1)
  })

  it('reports isolated unread summaries even when servers reuse session IDs', () => {
    const value = cache()
    value.putSessions('server-a', [
      { ...session('same-id'), latest_agent_event_seq: 5, last_read_agent_event_seq: 2, pinned: true },
      { ...session('archived', true), manual_unread: true }
    ])
    value.putSessions('server-b', [
      { ...session('same-id'), latest_agent_event_seq: 2, last_read_agent_event_seq: 2 },
      { ...session('manual'), manual_unread: true }
    ])

    expect(value.serverSummaries(['server-a', 'server-b', 'empty'])).toEqual([
      expect.objectContaining({ serverId: 'server-a', sessionCount: 2, activeSessionCount: 1, archivedSessionCount: 1, unreadCount: 1, pinnedCount: 1 }),
      expect.objectContaining({ serverId: 'server-b', sessionCount: 2, activeSessionCount: 2, archivedSessionCount: 0, unreadCount: 1, pinnedCount: 0 }),
      expect.objectContaining({ serverId: 'empty', sessionCount: 0, unreadCount: 0 })
    ])
  })

  it('searches titles and cached content across explicit server namespaces with compound identity', () => {
    const value = cache()
    value.putSession('server-a', { ...session('same-id'), title: 'Needle Alpha' })
    value.putSession('server-b', { ...session('same-id'), title: 'Different title' })
    value.putEvents('server-b', 'same-id', [event('same-id', 0, 'needle from server b')])

    const results = value.searchAllSessions(['server-a', 'server-b'], 'needle')

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ serverId: 'server-a', source: 'title', session: { id: 'same-id' } })
    expect(results[1]).toMatchObject({
      serverId: 'server-b',
      source: 'content',
      session: { id: 'same-id' },
      history: { session_id: 'same-id', snippet: 'needle from server b' }
    })
    expect(value.searchAllSessions(['server-a'], 'server b')).toEqual([])
  })
})
