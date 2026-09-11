import type { Health } from '../types'

export function healthActiveSessions(health: Health): Set<string> {
  return new Set([...(health.active_sessions ?? []), ...(health.active ?? [])].map(String))
}

/**
 * A health request can start before a live turn event and finish after it. In
 * that case, retaining the newer local state avoids briefly hiding a running
 * chat until the next health poll.
 */
export function reconcileHealthActiveSessions(
  health: Health,
  current: Set<string>,
  requestRevision: number,
  currentRevision: number,
): Set<string> {
  return requestRevision === currentRevision ? healthActiveSessions(health) : current
}
