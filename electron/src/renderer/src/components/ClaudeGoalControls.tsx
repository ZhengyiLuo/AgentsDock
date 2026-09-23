import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Goal, LoaderCircle, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import './ClaudeGoalControls.css'

export function useClaudeGoalsAvailable(): boolean {
  const { supported, runtime } = useClaudeRuntime()
  return supported && !window.agentsDock.sharedChat && runtime?.features?.goals === true
    && typeof window.agentsDock.claude?.setGoal === 'function'
    && typeof window.agentsDock.claude?.clearGoal === 'function'
}

export function ClaudeGoalControls({ open, onOpenChange, disabled = false }: {
  open: boolean
  onOpenChange(open: boolean): void
  disabled?: boolean
}) {
  useLocale()
  const { runtime, session, mutating, runtimeError, setGoal, clearGoal } = useClaudeRuntime()
  const available = useClaudeGoalsAvailable()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const scope = `${activeProfileId}:${profileGeneration}:${session?.id}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const goal = runtime?.goal ?? null
  const active = goal?.status === 'active'
  const busy = runtime?.status?.type === 'active'
  const [condition, setCondition] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorAction = useRef<'set' | 'clear' | null>(null)
  const [clearRequested, setClearRequested] = useState(false)
  const [now, setNow] = useState(Date.now)
  const wasOpen = useRef(false)
  const conditionEdited = useRef(false)
  const blocked = disabled || Boolean(switchingProfileId) || !available

  useEffect(() => {
    scopeRef.current = scope
    setError(null)
    errorAction.current = null
    setClearRequested(false)
    wasOpen.current = false
    conditionEdited.current = false
    return () => { scopeRef.current = '' }
  }, [scope])

  useEffect(() => {
    if (open && (!wasOpen.current || !conditionEdited.current)) {
      setCondition(goal?.condition ?? '')
      setError(null)
    }
    if (!open) conditionEdited.current = false
    wasOpen.current = open
  }, [goal?.condition, open, scope])

  useEffect(() => {
    if (!active) setClearRequested(false)
  }, [active])

  useEffect(() => {
    if (goal?.status === 'cleared' && errorAction.current === 'clear') {
      setError(null)
      errorAction.current = null
    }
  }, [goal?.status])

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    // Presentation-only clock: no runtime polling or composer/store updates.
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, goal?.set_at])

  const changeGoal = async (next: string | null) => {
    if (blocked || mutating || next !== null && busy) return
    const requestScope = scope
    setError(null)
    errorAction.current = null
    try {
      const snapshot = await (next === null ? clearGoal() : setGoal(next))
      if (scopeRef.current !== requestScope || !snapshot) return
      setClearRequested(next === null && snapshot.goal?.status === 'active')
    } catch (cause) {
      if (scopeRef.current !== requestScope) return
      errorAction.current = next === null ? 'clear' : 'set'
      setError((cause instanceof Error ? cause.message : String(cause))
        .replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim())
    }
  }
  const trimmedCondition = condition.trim()
  const elapsed = goal ? goalElapsed(goal.duration_ms ?? (active && goal.set_at != null ? now - goal.set_at : NaN)) : null
  const waiting = runtime?.goal_starting === true || clearRequested
  const clearLabel = busy ? t('claudeGoal.clearAndStop') : t('claudeGoal.clear')
  const clearHint = busy ? t('claudeGoal.clearAndStopHint') : t('claudeGoal.clear')

  if (session?.backend !== 'claude' || window.agentsDock.sharedChat) return null
  return <>
    {active && goal && <div className="claude-goal-bar" aria-label={t('claudeGoal.title')}>
      <button type="button" className="claude-goal-summary" onClick={() => onOpenChange(true)} title={goal.condition}>
        <Goal size={15} aria-hidden="true" />
        <span className="claude-goal-condition">{goal.condition}</span>
        <span className="claude-goal-meta">{[goal.iterations != null ? t('claudeGoal.iterationCount', { count: String(goal.iterations) }) : null, elapsed].filter(Boolean).join(' · ')}</span>
      </button>
      <button type="button" className="quiet-button" aria-label={clearHint} title={clearHint} disabled={blocked || mutating} onClick={() => void changeGoal(null)}>{clearLabel}</button>
    </div>}
    {!open && (error || waiting) && <p className={`claude-goal-feedback${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{error || t('claudeGoal.requested')}</p>}
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="form-dialog claude-goal-dialog" aria-busy={mutating}>
          <header>
            <Goal size={20} aria-hidden="true" />
            <div>
              <Dialog.Title>{t('claudeGoal.title')}</Dialog.Title>
              <Dialog.Description>{t('claudeGoal.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t('claudeGoal.close')}><X size={16} /></button></Dialog.Close>
          </header>
          <form onSubmit={event => { event.preventDefault(); if (trimmedCondition && condition.length <= 4000) void changeGoal(trimmedCondition) }}>
            {!available && <p className="claude-goal-feedback" role="status">{t(runtime ? 'claudeGoal.unavailable' : 'claudeGoal.loading')}</p>}
            {available && runtime?.goal_loading && <p className="claude-goal-feedback" role="status">{t('claudeGoal.loading')}</p>}
            {goal && <section className="claude-goal-progress" aria-label={t('claudeGoal.current')}>
              <strong>{t(`claudeGoal.status.${goal.status}`)}</strong>
              <p>{goal.condition}</p>
              <dl>
                <div><dt>{t('claudeGoal.elapsed')}</dt><dd>{elapsed ?? '—'}</dd></div>
                <div><dt>{t('claudeGoal.iterations')}</dt><dd>{goal.iterations ?? '—'}</dd></div>
              </dl>
              {goal.last_reason && <div className="claude-goal-reason"><strong>{t('claudeGoal.reason')}</strong><p>{goal.last_reason}</p></div>}
            </section>}
            <label className="claude-goal-field">
              <span>{t('claudeGoal.condition')}</span>
              <textarea autoFocus rows={4} maxLength={4000} value={condition} disabled={blocked || mutating} aria-label={t('claudeGoal.condition')}
                placeholder={t('claudeGoal.placeholder')} onChange={event => { conditionEdited.current = true; setCondition(event.target.value) }} />
              <small>{condition.length.toLocaleString()} / 4,000</small>
            </label>
            {(error || runtimeError) && <p className="claude-goal-feedback error" role="alert">{error || runtimeError}</p>}
            {waiting && <p className="claude-goal-feedback" role="status">{t('claudeGoal.requested')}</p>}
            {busy && <p className="claude-goal-feedback">{t(active ? 'claudeGoal.busyReplace' : 'claudeGoal.busyStart')}</p>}
            <footer>
              {active && <button type="button" className="quiet-button" aria-label={clearHint} title={clearHint} disabled={blocked || mutating} onClick={() => void changeGoal(null)}>{clearLabel}</button>}
              <button type="submit" className="primary-button" disabled={blocked || busy || mutating || runtime?.goal_starting === true || !trimmedCondition || condition.length > 4000}>
                {mutating && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
                {active ? t('claudeGoal.replace') : t('claudeGoal.start')}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

function goalElapsed(durationMs: number): string | null {
  if (!Number.isFinite(durationMs)) return null
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
