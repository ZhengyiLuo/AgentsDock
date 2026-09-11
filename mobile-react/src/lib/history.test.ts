import type { Event, Snapshot } from '../types'
import { SNAPSHOT_CACHE_VERSION, shouldReplaceCachedTimeline } from './history'

function assertEqual(actual: boolean, expected: boolean): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`)
}

function event(seq: number, sessionId = 'chat-1'): Event {
  return { id: `event-${seq}`, seq, session_id: sessionId, type: 'assistant_text', ts: '2026-07-14T00:00:00Z', text: String(seq) }
}

function snapshot(events: Event[], latestSeq = events.at(-1)?.seq ?? 0): Snapshot {
  return {
    cacheVersion: SNAPSHOT_CACHE_VERSION,
    session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
    events,
    queuedTurns: [],
    files: [],
    filesTotal: 0,
    hasMore: true,
    latestSeq,
    cachedAt: Date.now(),
  }
}

// A stray recent event must not make a stale, disconnected cache window look valid.
assertEqual(
  shouldReplaceCachedTimeline(snapshot([event(10), event(1_000)]), [event(900), event(950)], 1_000, true, true),
  true,
)

// An overlapping full tail can safely retain pages the user already loaded above it.
assertEqual(
  shouldReplaceCachedTimeline(snapshot([event(700), event(900)]), [event(900), event(950)], 950, true, true),
  false,
)

const legacy = snapshot([event(10), event(900)])
delete legacy.cacheVersion
assertEqual(shouldReplaceCachedTimeline(legacy, [event(900), event(950)], 950, true, true), true)

assertEqual(shouldReplaceCachedTimeline(snapshot([event(900)]), [event(20)], 20, false, true), true)
assertEqual(shouldReplaceCachedTimeline(snapshot([event(10)]), [], 0, false, true), true)
assertEqual(shouldReplaceCachedTimeline(snapshot([event(10)]), [event(20)], 20, true, false), false)

console.log('history reconciliation regressions passed')
