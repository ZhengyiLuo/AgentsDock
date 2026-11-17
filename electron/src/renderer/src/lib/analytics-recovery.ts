import type { CoordinatedServerUpdate } from '@shared/types'
import { ANALYTICS_RECOVERY_MARKERS_KEY as KEY, analyticsConsentRevision, getAnalyticsConsentDecision, trackEvent } from './analytics'

const seen = new Set<string>()
let seenRevision = -1
// Current servers expose interruption counts, not recovery proof. Report that
// coverage gap only for an exact forced update this client owned. Neither
// current/health-ready nor disconnect implies that interrupted work recovered.
export async function observeUpdateRecovery(records: CoordinatedServerUpdate[]): Promise<void> {
  if (seenRevision !== analyticsConsentRevision()) { seen.clear(); seenRevision = analyticsConsentRevision() }
  if (getAnalyticsConsentDecision() !== 'granted') return
  const revision = seenRevision
  for (const record of records) {
    if (!record.operationOwned || !record.serverIdentity || !record.forceRequestId
      || !record.forceRequestedScheduleId || record.operationTargetVersion !== record.targetVersion
      || !['current', 'failed'].includes(record.phase)) continue
    const source = JSON.stringify([record.serverIdentity, record.forceRequestedScheduleId, record.forceRequestId, record.targetVersion])
    let key: string
    try {
      key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))), byte => byte.toString(16).padStart(2, '0')).join('')
    } catch { continue }
    if (getAnalyticsConsentDecision() !== 'granted' || revision !== analyticsConsentRevision()) return
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]')
      if (Array.isArray(stored)) for (const item of stored.slice(-128)) if (typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) seen.add(item)
    } catch { /* memory dedup still works when storage is full */ }
    if (seen.has(key)) continue
    seen.add(key)
    while (seen.size > 128) seen.delete(seen.values().next().value!)
    try { window.localStorage.setItem(KEY, JSON.stringify([...seen])) } catch { /* best effort */ }
    // The hash and all source identifiers stay local. No per-task count is
    // guessed from a pre-restart snapshot, and no recovery success is emitted.
    trackEvent('server_update_recovery_observed', { outcome: 'unknown', coverage: 'unsupported', work_kind: 'unknown' })
  }
}
