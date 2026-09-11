import type { EmergencyAlert, Session } from '@shared/types'

/** Treat only a complete, explicitly active server alert as an emergency. */
export function activeEmergencyAlert(session: Session | null | undefined): EmergencyAlert | null {
  const alert = session?.emergency_alert
  if (
    !alert
    || alert.status !== 'active'
    || alert.severity !== 'critical'
    || !alert.id?.trim()
    || !alert.message?.trim()
    || !alert.raised_at?.trim()
  ) return null
  return alert
}
