import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Event, SessionSnapshot } from '@shared/types'
import { mergeEvents, mergeSnapshots, sessionUnread, updateActiveSessions } from '../store/app-store'
import { isAgentVisibleEvent, messageItemText, projectTimeline, renderTimelineItems } from './timeline'
import { buildTimelineLandmarks } from './timeline-minimap'
import { activeInboundDelivery } from './queue-actions'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { PAGED_MAILBOX_WAKE_PROMPT, peerMailboxWakePagingFixture } from './test-fixtures/peer-mailbox-wake-paging'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
import { LocalCache } from '../../../main/persistence'

const fixture = peerMailboxWakePagingFixture()
const snapshot = (events: Event[]): SessionSnapshot => ({
  session: { id: fixture.sessionId, title: fixture.title, backend: 'codex',
    latest_agent_event_seq: 107, last_read_agent_event_seq: 107 },
  events, files: [], queuedTurns: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0, generation: 0
})
const project = (events: Event[]) => renderTimelineItems(projectTimeline(events, []))
function assertVisibleHistory(events: Event[]) {
  const rows = project(events)
  expect(rows.flatMap(row => row.kind === 'message' && row.role === 'user' ? [row.event.id] : []))
    .toEqual(['mixed-106'])
  expect(rows.flatMap(row => row.kind === 'message' && row.role === 'assistant' ? [messageItemText(row)] : []))
    .toEqual([fixture.wakeAnswer, fixture.humanAnswer])
  expect(rows.filter(row => row.kind === 'system' && row.mailboxMessages)).toMatchObject([{
    seq: 4, anchorTs: '2026-09-13T12:00:04Z',
    mailboxMessages: [{ event: { message_id: 'synthetic-peer-message', inbox_state: 'read' } }]
  }])
  const landmarks = buildTimelineLandmarks(rows)
  expect(landmarks.some(item => item.start_seq === 102 || item.title === PAGED_MAILBOX_WAKE_PROMPT && item.start_seq !== 106)).toBe(false)
  expect(events.reduce(updateActiveSessions, new Set<string>())).toEqual(new Set())
  expect(activeInboundDelivery(events)).toBeNull()
  return rows
}

describe('source-proven paged peer mailbox wake history', () => {
  it('requires proof for the exact full helper and preserves a genuine identical human input', () => {
    expect(PAGED_MAILBOX_WAKE_PROMPT).toContain('Continue a paged read with the same key and cursor.')
    expect(project(fixture.beforeEvents).flatMap(row => row.kind === 'message' && row.role === 'user' ? [row.event.id] : []))
      .toEqual(['mixed-102', 'mixed-106'])
    assertVisibleHistory(fixture.afterEvents)
    const helperOnly = fixture.corrected.slice(0, 1)
    expect(project(helperOnly)).toEqual([])
    expect(buildTimelineLandmarks(project(helperOnly))).toEqual([])
    expect(helperOnly.some(isAgentVisibleEvent)).toBe(false)
    clearTimelineProjectionCache()
    for (let length = 1; length <= fixture.afterEvents.length; length++) {
      const prefix = fixture.afterEvents.slice(0, length)
      expect(cachedTimelineProjection('paged-peer-prefix', prefix, []).rendered).toEqual(project(prefix))
    }
  })

  it('retains an unmatched answer behind a proven silent boundary in fork-like partial history', () => {
    const forkId = 'synthetic-fork'
    const received = fixture.nativeEvents.find(event => event.type === 'chat_conversation_message_received')!
    const read = fixture.nativeEvents.find(event => event.type === 'chat_conversation_message_read')!
    const proof = fixture.corrected[0]
    const answer: Event = { ...fixture.genuine[1], id: 'unmatched-fork-answer', seq: 103,
      result_text: 'Unique answer from the imported fork remains visible.' }
    const partial = [received, read, proof, answer].map(event => ({ ...event, session_id: forkId,
      ...(event.target_session_id ? { target_session_id: forkId } : {}) }))
    const rows = project(partial)
    expect(rows.flatMap(row => row.kind === 'message' ? [messageItemText(row)] : []))
      .toEqual([answer.result_text])
    expect(rows.filter(row => row.kind === 'system' && row.mailboxMessages)).toHaveLength(1)
    expect(buildTimelineLandmarks(rows).some(item => item.kind === 'user')).toBe(false)
    expect(partial.reduce(updateActiveSessions, new Set<string>())).toEqual(new Set())
    expect(activeInboundDelivery(partial)).toBeNull()
    const unproven = partial.map(event => event.id === proof.id ? {
      ...event, prompt: PAGED_MAILBOX_WAKE_PROMPT, metadata_only: undefined,
      provider_history_repair: undefined, provider_origin: undefined
    } : event)
    expect(project(unproven).some(row => row.kind === 'message' && row.role === 'user')).toBe(true)
  })

  it('preserves corrections and read state through older-page overlap, stale replay and SQLite reopen', () => {
    clearTimelineProjectionCache()
    const before = snapshot(fixture.beforeEvents)
    cachedTimelineProjection('paged-peer:0', before.events, [])
    const corrected = mergeSnapshots(before, snapshot(fixture.corrected))
    expect(corrected.generation).toBe(1)
    expect(cachedTimelineProjection('paged-peer:1', corrected.events, []).rendered)
      .toEqual(assertVisibleHistory(corrected.events))
    const tail = fixture.afterEvents.filter(event => event.seq >= 102)
    const olderPage = fixture.afterEvents.filter(event => event.seq <= 103)
    expect(assertVisibleHistory(mergeEvents(tail, olderPage))).toEqual(project(corrected.events))
    expect(mergeEvents(corrected.events, fixture.staleEvents)).toBe(corrected.events)
    expect(sessionUnread(corrected.session)).toBe(false)
    const folder = mkdtempSync(join(tmpdir(), 'agentsdock-peer-paging-'))
    const path = join(folder, 'cache.sqlite')
    let cache: LocalCache | null = new LocalCache(path)
    try {
      cache.putSession('synthetic-server', before.session)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.beforeEvents)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.corrected)
      cache.putEvents('synthetic-server', fixture.sessionId, fixture.staleEvents)
      cache.close(); cache = new LocalCache(path)
      const restored = cache.snapshot('synthetic-server', fixture.sessionId)!
      assertVisibleHistory(restored.events)
      expect(sessionUnread(restored.session)).toBe(false)
      expect(cache.serverSummary('synthetic-server').unreadCount).toBe(0)
    } finally {
      cache?.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
