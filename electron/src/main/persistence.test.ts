import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event, Session } from '../shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { LocalCache } from './persistence'

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

describe('local FTS history index', () => {
  afterEach(() => {
    while (openCaches.length) openCaches.pop()?.close()
  })

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

    value.putSession('server', archived)
    expect(value.searchSessions('server', 'needle')).toEqual([])
  })
})
