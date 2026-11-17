import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoordinatedServerUpdate } from '@shared/types'
const tracker = vi.hoisted(() => ({ trackEvent: vi.fn(), getAnalyticsConsentDecision: vi.fn(() => 'granted'), analyticsConsentRevision: vi.fn(() => 0), ANALYTICS_RECOVERY_MARKERS_KEY: 'agentsdock:analytics-update-observations:v1' }))
vi.mock('./analytics', () => tracker)
const record: CoordinatedServerUpdate = { profileId: 'local-profile', name: 'private server', serverIdentity: 'private-identity', targetVersion: '1.0.0', operationTargetVersion: '1.0.0', phase: 'current', message: 'ready', operationOwned: true, forceRequestId: 'private-request', forceRequestedScheduleId: 'private-schedule' }
describe('honest update recovery coverage', () => {
  beforeEach(() => { vi.resetModules(); tracker.trackEvent.mockClear(); tracker.getAnalyticsConsentDecision.mockReturnValue('granted'); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
  it('deduplicates exact owned receipts across reopens and never claims recovery success', async () => {
    const first = await import('./analytics-recovery')
    await first.observeUpdateRecovery([record]); await first.observeUpdateRecovery([record])
    vi.resetModules()
    await (await import('./analytics-recovery')).observeUpdateRecovery([record])
    expect(tracker.trackEvent).toHaveBeenCalledExactlyOnceWith('server_update_recovery_observed', { outcome: 'unknown', work_kind: 'unknown', coverage: 'unsupported' })
    expect(JSON.stringify(tracker.trackEvent.mock.calls)).not.toContain('private')
    expect(window.localStorage.getItem('agentsdock:analytics-update-observations:v1')).not.toContain('private')
  })
  it('ignores unrelated, unsupported receipt shapes and transient offline states', async () => {
    const { observeUpdateRecovery } = await import('./analytics-recovery')
    for (const changes of [{ operationOwned: false }, { serverIdentity: null }, { forceRequestId: undefined }, { forceRequestedScheduleId: undefined }, { operationTargetVersion: '0.9.0' }, { phase: 'offline' as const }]) await observeUpdateRecovery([{ ...record, ...changes }])
    expect(tracker.trackEvent).not.toHaveBeenCalled()
  })
  it('does not record or persist receipt markers after opt-out', async () => {
    tracker.getAnalyticsConsentDecision.mockReturnValue('denied')
    await (await import('./analytics-recovery')).observeUpdateRecovery([record])
    expect(tracker.trackEvent).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
  })
})
