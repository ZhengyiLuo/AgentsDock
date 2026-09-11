import type { Event, Snapshot } from '../types'

// Version 5 drops caches created before provider-only prompt suffixes were
// removed ahead of mobile truncation. A fresh server page can sanitize the
// complete record; a legacy cache may contain only an unverifiable fragment.
export const SNAPSHOT_CACHE_VERSION = 5

export function snapshotLatestSeq(snapshot?: Snapshot): number {
  let latest = snapshot?.latestSeq ?? 0
  for (const event of snapshot?.events ?? []) latest = Math.max(latest, event.seq)
  return latest
}

/**
 * A full-tail response is the server's authoritative newest visible window.
 * Preserve locally loaded older pages only when they overlap that window.
 */
export function shouldReplaceCachedTimeline(
  current: Snapshot | undefined,
  incoming: Event[],
  latestSeq: number | null | undefined,
  hasMore: boolean,
  fullTail: boolean,
): boolean {
  if (!current?.events.length || !fullTail) return false

  // Snapshots written before session-scoped reconciliation can contain a
  // disconnected history window. One overlapping live event is not enough to
  // prove that legacy history belongs to the authoritative server tail.
  if (current.cacheVersion !== SNAPSHOT_CACHE_VERSION) return true

  const currentLatest = snapshotLatestSeq(current)
  if (latestSeq != null && latestSeq < currentLatest) return true

  if (!incoming.length) return !hasMore

  const currentSeqs = new Set(current.events.map(event => event.seq))
  return !incoming.some(event => currentSeqs.has(event.seq))
}
