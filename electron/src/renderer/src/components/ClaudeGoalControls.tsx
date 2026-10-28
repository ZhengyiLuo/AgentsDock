import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { LoaderCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { GoalConditionField, GoalDialogContent, GoalProgress, GoalSummaryBar } from './GoalDialog'

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
  const wasOpen = useRef(false)
  const conditionEdited = useRef(false)
  const blocked = disabled || Boolean(switchingProfileId) || !available

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (detail?.sessionId === session?.id) onOpenChange(true)
    }
    window.addEventListener('agentsdock:open-claude-goal', show)
    return () => window.removeEventListener('agentsdock:open-claude-goal', show)
  }, [session?.id, onOpenChange])

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

  const changeGoal = async (next: string | null) => {
    if (blocked || mutating) return
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
  // A saved completion condition is independent of whether Claude is working.
  // Only display duration reported by the native evaluator, never goal age.
  const elapsed = goalElapsed(goal?.duration_ms ?? NaN)
  const runtimeStatus = runtime?.status
  const activity = runtimeStatus?.type === 'active'
    ? runtimeStatus.activeFlags.includes('waitingOnUserInput') ? 'waitingOnUserInput'
      : runtimeStatus.activeFlags.includes('waitingOnApproval') ? 'waitingOnApproval' : 'working'
    : runtimeStatus?.type === 'idle' ? 'idle'
      : runtimeStatus?.type === 'notLoaded' ? 'notLoaded' : 'unknown'
  const goalStatus = active ? t('claudeGoal.setWithActivity', { activity: t(`claudeGoal.activity.${activity}`) })
    : goal ? t(`claudeGoal.status.${goal.status}`) : ''
  const waiting = runtime?.goal_starting === true || clearRequested
  const waitingMessage = t(clearRequested ? 'claudeGoal.clearRequested' : 'claudeGoal.requested')
  const canContinue = active && (runtimeStatus?.type === 'idle' || runtimeStatus?.type === 'notLoaded')
  const goalError = error || runtime?.goal_error || null
  const clearLabel = busy ? t('claudeGoal.clearAndStop') : t('claudeGoal.clear')
  const clearHint = busy ? t('claudeGoal.clearAndStopHint') : t('claudeGoal.clear')

  if (session?.backend !== 'claude' || window.agentsDock.sharedChat) return null
  return <>
    {active && goal && <GoalSummaryBar label={t('claudeGoal.title')} condition={goal.condition}
      openLabel={t('claudeGoal.title')} onOpen={() => onOpenChange(true)}
      metadata={<span className="claude-goal-summary-meta">{[goalStatus, goal.iterations != null ? t('claudeGoal.iterationCount', { count: String(goal.iterations) }) : null,
        elapsed ? t('claudeGoal.reportedDuration', { duration: elapsed }) : null].filter(Boolean).join(' · ')}</span>}
      actions={<>
        {canContinue && <button type="button" className="quiet-button" disabled={blocked || mutating || waiting} onClick={() => void changeGoal(goal.condition)}>{t('claudeGoal.continue')}</button>}
        <button type="button" className="quiet-button" aria-label={clearHint} title={clearHint} disabled={blocked || mutating} onClick={() => void changeGoal(null)}>{clearLabel}</button>
      </>} />}
    {!open && (goalError || waiting) && <p className={`goal-feedback goal-composer-feedback${goalError ? ' error' : ''}`} role={goalError ? 'alert' : 'status'}>{goalError || waitingMessage}</p>}
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <GoalDialogContent title={t('claudeGoal.title')} description={t('claudeGoal.description')} closeLabel={t('claudeGoal.close')} busy={mutating}>
          <form onSubmit={event => { event.preventDefault(); if (trimmedCondition && condition.length <= 4000) void changeGoal(trimmedCondition) }}>
            {!available && <p className="goal-feedback" role="status">{t(runtime ? 'claudeGoal.unavailable' : 'claudeGoal.loading')}</p>}
            {available && runtime?.goal_loading && <p className="goal-feedback" role="status">{t('claudeGoal.loading')}</p>}
            {goal && <GoalProgress label={t('claudeGoal.current')} status={goalStatus} condition={goal.condition}
              metrics={[{ label: t('claudeGoal.elapsed'), value: elapsed ?? '—' }, { label: t('claudeGoal.iterations'), value: goal.iterations ?? '—' }]}
              reason={goal.last_reason ? { label: t('claudeGoal.reason'), text: goal.last_reason } : null} />}
            <GoalConditionField label={t('claudeGoal.condition')} placeholder={t('claudeGoal.placeholder')}
              value={condition} disabled={blocked || mutating} onChange={value => { conditionEdited.current = true; setCondition(value) }} />
            {(goalError || runtimeError) && <p className="goal-feedback error" role="alert">{goalError || runtimeError}</p>}
            {waiting && <p className="goal-feedback" role="status">{waitingMessage}</p>}
            <footer className="claude-goal-footer">
              {active && <button type="button" className="quiet-button" aria-label={clearHint} title={clearHint} disabled={blocked || mutating} onClick={() => void changeGoal(null)}>{clearLabel}</button>}
              {canContinue && goal && <button type="button" className="quiet-button" disabled={blocked || mutating || waiting} onClick={() => void changeGoal(goal.condition)}>{t('claudeGoal.continue')}</button>}
              <button type="submit" className="primary-button" disabled={blocked || mutating || runtime?.goal_starting === true || !trimmedCondition || condition.length > 4000}>
                {mutating && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
                {active ? t('claudeGoal.replace') : t('claudeGoal.start')}
              </button>
            </footer>
          </form>
      </GoalDialogContent>
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
