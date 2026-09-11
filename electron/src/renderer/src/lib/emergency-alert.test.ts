import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { activeEmergencyAlert } from './emergency-alert'

const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }

describe('activeEmergencyAlert', () => {
  it('accepts only complete active critical alerts', () => {
    const alert = {
      id: 'alert_1',
      status: 'active' as const,
      severity: 'critical' as const,
      message: 'Production data is at risk.',
      raised_at: '2026-08-25T12:00:00Z'
    }
    expect(activeEmergencyAlert({ ...session, emergency_alert: alert })).toEqual(alert)
    expect(activeEmergencyAlert({ ...session, emergency_alert: { ...alert, status: 'acknowledged' } })).toBeNull()
    expect(activeEmergencyAlert({ ...session, emergency_alert: { ...alert, message: '' } })).toBeNull()
  })
})
