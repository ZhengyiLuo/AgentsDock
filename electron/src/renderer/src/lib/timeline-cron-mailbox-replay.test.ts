import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Event, SessionSnapshot } from '@shared/types'
import { mergeEvents, mergeSnapshots } from '../store/app-store'
import { messageItemText, projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { cronMailboxReplayFixture } from './test-fixtures/cron-mailbox-replay'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { LocalCache } from '../../../main/persistence'

const fixture = cronMailboxReplayFixture()
const snapshot = (events: Event[]): SessionSnapshot => ({
  session: { id: fixture.sessionId, title: fixture.title, backend: 'codex' },
  events, files: [], queuedTurns: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0, generation: 0
})
function assertMixedHistory(events: Event[]) {
  const rows = renderTimelineItems(projectTimeline(events, []))
  const jobs = rows.filter(row => row.kind === 'job')
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ jobId: 'synthetic-monitor', runCount: 1, seq: 1,
    latest: { id: 'mixed-3', result_text: fixture.scheduledReport } })
  const mailbox = rows.filter(row => row.kind === 'system' && row.mailboxMessages)
  expect(mailbox).toHaveLength(1)
  expect(mailbox[0]).toMatchObject({ seq: 4, anchorTs: '2026-09-13T12:00:04Z',
    mailboxMessages: [{ event: { message_id: 'synthetic-peer-message', inbox_state: 'read' } }] })
  expect(rows.flatMap(row => row.kind === 'message' && row.role === 'user' ? [row.event.id] : []))
    .toEqual(['mixed-106'])
  expect(rows.flatMap(row => row.kind === 'message' && row.role === 'assistant' ? [messageItemText(row)] : []))
    .toEqual([fixture.wakeAnswer, fixture.humanAnswer])
  const progress = rows.find(row => row.kind === 'progress')
  expect(progress).toMatchObject({ active: false, events: [expect.objectContaining({ id: 'mixed-6', text: fixture.wakeProgress })] })
  expect(rows.indexOf(mailbox[0])).toBeLessThan(rows.indexOf(progress!))
  return rows
}

describe('combined scheduled and mailbox source-proven history repair', () => {
  it('keeps one native cron group, purple delivery chronology and wake answer, not imported copies', () => {
    expect(fixture.wakeText).toHaveLength(551)
    const legacy = renderTimelineItems(projectTimeline(fixture.beforeEvents, []))
    // Fail visibly without proof, rather than guessing from the prompt or a matching human quotation.
    expect(legacy.flatMap(row => row.kind === 'message' && row.role === 'user' ? [row.event.id] : []))
      .toEqual(['mixed-100', 'mixed-102', 'mixed-106'])
    assertMixedHistory(fixture.afterEvents)
    clearTimelineProjectionCache()
    for (let length = 1; length <= fixture.afterEvents.length; length++) {
      const prefix = fixture.afterEvents.slice(0, length)
      expect(cachedTimelineProjection('mixed-incremental', prefix, []).rendered)
        .toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    }
  })

  it('invalidates an interior same-ID repair and retains it through overlapping older pages and stale live replay', () => {
    clearTimelineProjectionCache()
    const old = snapshot(fixture.beforeEvents)
    cachedTimelineProjection(`mixed:${old.generation}`, old.events, [])
    const corrected = mergeSnapshots(old, snapshot(fixture.corrected))
    expect(corrected.generation).toBe(1)
    const projection = cachedTimelineProjection(`mixed:${corrected.generation}`, corrected.events, [])
    expect(projection.strategy).toBe('rebuild')
    expect(projection.rendered).toEqual(assertMixedHistory(corrected.events))
    const stalePage = mergeSnapshots(corrected, snapshot(fixture.beforeEvents))
    expect(stalePage.events).toBe(corrected.events)
    expect(stalePage.generation).toBe(corrected.generation)
    const tail = fixture.afterEvents.filter(event => event.seq >= 100)
    // Older-page overlap and original scheduler ownership can arrive after repaired imported history.
    const paged = mergeEvents(tail, fixture.afterEvents.filter(event => event.seq <= 102))
    expect(assertMixedHistory(paged)).toEqual(projection.rendered)
  })

  it('keeps the exact repairs after SQLite close/reopen while retaining the same-text human record', () => {
    const folder = mkdtempSync(join(tmpdir(), 'agentsdock-mixed-replay-'))
    const path = join(folder, 'cache.sqlite')
    let cache: LocalCache | null = new LocalCache(path)
    try {
      cache.putSession('synthetic-server', snapshot([]).session)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.beforeEvents)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.corrected)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.staleEvents)
      cache.close(); cache = new LocalCache(path)
      const restored = cache.snapshot('synthetic-server', fixture.sessionId)!.events
      assertMixedHistory(restored)
      expect(restored.find(event => event.id === 'mixed-102')).toMatchObject({
        prompt: '', metadata_only: true, provider_history_repair: 'source_proven_native_replay'
      })
      expect(restored.find(event => event.id === 'mixed-106')?.prompt).toBe(fixture.wakeText)
    } finally {
      cache?.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
