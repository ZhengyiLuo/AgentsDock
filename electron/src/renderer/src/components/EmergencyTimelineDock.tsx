import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Siren } from 'lucide-react'
import { t, useLocale } from '../lib/i18n'
import { activeEmergencyAlert } from '../lib/emergency-alert'
import { useAppStore } from '../store/app-store'

interface EmergencyTimelineTarget {
  key: string
  profileId: string
  serverIdentity: string | null
  sessionId: string
  sessionTitle: string
  alertId: string
  message: string
  raisedAt: string
}

/**
 * A persistent emergency affordance outside the virtualized timeline scroller.
 * The transient global toast remains useful for interruption; this dock keeps
 * every active emergency reachable after that toast is dismissed or expires.
 */
export function EmergencyTimelineDock({ sessionId, focused }: { sessionId: string; focused: boolean }) {
  useLocale()
  const sessions = useAppStore(state => state.sessions)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => (
    state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
  ))
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const targets = useMemo<EmergencyTimelineTarget[]>(() => {
    if (!focused || !activeProfileId || switchingProfileId) return []
    return sessions.flatMap(session => {
      const alert = activeEmergencyAlert(session)
      return alert ? [{
        key: JSON.stringify([activeProfileId, profileGeneration, serverIdentity, session.id, alert.id]),
        profileId: activeProfileId,
        serverIdentity,
        sessionId: session.id,
        sessionTitle: session.title,
        alertId: alert.id,
        message: alert.message,
        raisedAt: alert.raised_at
      }] : []
    }).sort((left, right) => (
      (Date.parse(right.raisedAt) || 0) - (Date.parse(left.raisedAt) || 0)
      || right.key.localeCompare(left.key)
    ))
  }, [activeProfileId, focused, profileGeneration, serverIdentity, sessions, switchingProfileId])
  const target = targets.find(candidate => candidate.sessionId === sessionId) ?? targets[0] ?? null
  const [workingKey, setWorkingKey] = useState<string | null>(null)
  const workingKeyRef = useRef<string | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)

  useEffect(() => setFailedKey(null), [target?.key])

  if (!target) return null
  const currentChat = target.sessionId === sessionId
  const working = workingKey !== null
  const remaining = targets.length - 1
  const act = async () => {
    if (workingKeyRef.current) return
    const actionTarget = target
    const actionIsCurrentChat = actionTarget.sessionId === sessionId
    workingKeyRef.current = actionTarget.key
    setWorkingKey(actionTarget.key)
    setFailedKey(null)
    try {
      const succeeded = actionIsCurrentChat
        ? await useAppStore.getState().acknowledgeEmergency(actionTarget.sessionId, actionTarget.alertId)
        : await useAppStore.getState().openNotificationRoute({
          profileId: actionTarget.profileId,
          serverIdentity: actionTarget.serverIdentity,
          sessionId: actionTarget.sessionId
        })
      if (!succeeded) setFailedKey(actionTarget.key)
    } catch (error) {
      setFailedKey(actionTarget.key)
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (workingKeyRef.current === actionTarget.key) workingKeyRef.current = null
      setWorkingKey(current => current === actionTarget.key ? null : current)
    }
  }

  return <section
    className="emergency-timeline-dock"
    aria-label={t('emergency.activeIn', { title: target.sessionTitle })}
    aria-busy={working}
    data-alert-id={target.alertId}
  >
    <span className="emergency-timeline-dock-icon" aria-hidden="true"><Siren size={16} /></span>
    <div className="emergency-timeline-dock-copy">
      <strong>{t('emergency.title', { title: target.sessionTitle })}</strong>
      <span title={target.message}>{target.message}</span>
      {remaining > 0 && <small>{t(remaining === 1 ? 'emergency.remaining.one' : 'emergency.remaining.other', { count: remaining })}</small>}
      {failedKey === target.key && <small className="emergency-timeline-dock-error" role="alert">
        {t(currentChat ? 'emergency.acknowledgeFailed' : 'emergency.openFailed')}
      </small>}
    </div>
    <button
      type="button"
      disabled={working}
      onClick={() => void act()}
      aria-label={currentChat
        ? t('emergency.acknowledgeIn', { title: target.sessionTitle })
        : t('emergency.openChatNamed', { title: target.sessionTitle })}
    >
      {working && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
      {!working && <span className="emergency-timeline-dock-action-icon" aria-hidden="true">{currentChat ? '✓' : '↗'}</span>}
      <span className="emergency-timeline-dock-action-label">{t(currentChat ? 'emergency.acknowledge' : 'emergency.openChat')}</span>
    </button>
  </section>
}
