// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  AlertTriangle,
  ArchiveRestore,
  Bot,
  Check,
  ChevronRight,
  CircleGauge,
  ClipboardCheck,
  Goal,
  LoaderCircle,
  MessageSquareCode,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import type {
  CodexGoalSnapshot,
  CodexGoalStatus,
  CodexReviewTarget,
  JsonValue
} from '@shared/types'
import { useAppStore } from '../store/app-store'
import {
  formatCompactTokens,
  formatContextUsage,
  formatContextUsageDetail,
  latestCodexContextUsage,
  type CodexContextUsage
} from '../lib/codex-token-usage'
import {
  codexBridge,
  codexStatusLabel,
  codexStatusTone,
  type CodexBackgroundTerminal,
  useCodexRuntime
} from './CodexRuntimeContext'
import { useTransientClose } from '../lib/transient-close'
import { CodexInteractionCard } from './CodexInteractionShelf'
import './CodexControls.css'

export function CodexStatusButton() {
  useLocale()
  const { supported, loading, error, runtime, session, refresh } = useCodexRuntime()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [focusGoal, setFocusGoal] = useState(false)
  useTransientClose(dialogOpen, () => setDialogOpen(false))
  const lifecycleActive = useAppStore(state => (
    session ? state.activeSessionIds.has(session.id) : false
  ))
  const admitting = useAppStore(state => (
    session ? Boolean(state.turnAdmissionTokens[session.id]) : false
  ))
  const count = runtime?.pending_interactions?.length ?? 0
  const unavailable = runtime?.available === false
  const runtimeTone = codexStatusTone(runtime)
  // The server lifecycle is authoritative for whether AgentsDock still owns
  // an active run. The app-server thread snapshot can briefly lag at idle (or
  // be absent for exec fallback), which must not make one running chat claim
  // that Codex is idle. Preserve actionable waiting and error states.
  const lifecycleRunning = lifecycleActive
    && !error
    && !unavailable
    && runtimeTone === 'idle'
  const lifecycleStarting = admitting && !lifecycleActive && !error && !unavailable
  const tone = error || unavailable ? 'error' : lifecycleRunning || lifecycleStarting ? 'active' : runtimeTone
  const label = count > 0
    ? `${count} waiting`
    : error
        ? 'Error'
        : unavailable
          ? 'Unavailable'
          : lifecycleRunning
            ? 'Running'
            : lifecycleStarting
              ? t('timeline.status.starting')
            : loading
              ? 'Loading'
              : codexStatusLabel(runtime?.status)
  useEffect(() => {
    setDialogOpen(false)
    setFocusGoal(false)
  }, [session?.id])
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; focus?: 'goal' | 'status' }>).detail
      if (!session || detail?.sessionId !== session.id) return
      setFocusGoal(detail.focus === 'goal')
      setDialogOpen(true)
      void refresh()
    }
    window.addEventListener('agentsdock:open-codex-controls', open)
    return () => window.removeEventListener('agentsdock:open-codex-controls', open)
  }, [refresh, session?.id])
  if (!supported) return null
  return <Dialog.Root open={dialogOpen} onOpenChange={open => {
    setDialogOpen(open)
    if (open) setFocusGoal(false)
    // The thread can load after the chat is selected. Always reconcile the
    // control panel with the server when it opens instead of presenting a
    // stale notLoaded snapshot.
    if (open) void refresh()
  }}>
    <Dialog.Trigger asChild>
      <button
        type="button"
        className={`codex-status-button ${tone}`}
        aria-label={t("ui.CodexControls.CodexStatusButton.codex_controls_36c63bd", { "label": String(label) })}
        title={t("ui.CodexControls.CodexStatusButton.codex_thread_controls_51ea35d")}
      >
        {loading || tone === 'active' ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <span aria-hidden="true" />}
        <b>Codex</b>
        <small>{label}</small>
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay codex-controls-overlay" />
      <Dialog.Content className="codex-controls-dialog" aria-describedby="codex-controls-description">
        <CodexControlsPanel focusGoal={focusGoal} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

/** Always-visible, neutral context accounting for the selected Codex chat. */
export function CodexContextIndicator() {
  useLocale()
  const { supported, runtime, session, refresh } = useCodexRuntime()
  const meterId = useId()
  const events = useAppStore(state => session ? state.snapshots[session.id]?.events ?? EMPTY_EVENTS : EMPTY_EVENTS)
  const runtimeUsage = runtime
    ? runtime.token_usage_snapshot !== undefined
      ? runtime.token_usage_snapshot
      : runtime.token_usage
    : undefined
  const usage = useMemo(
    () => latestCodexContextUsage(events, runtimeUsage, session?.codex_thread_id ?? session?.session_id),
    [events, runtimeUsage, session?.codex_thread_id, session?.session_id]
  )
  if (!supported || !session) return null
  const percent = contextUsagePercent(usage)
  const formattedPercent = formatContextIndicatorPercent(percent)
  const detail = formatContextUsageDetail(usage)
  const tooltip = formattedPercent === '—'
    ? detail
    : `${formattedPercent} context used · ${detail}`
  return <Dialog.Root onOpenChange={open => {
    if (open) void refresh()
  }}>
    <Tooltip.Provider delayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className={`codex-context-indicator${percent == null ? ' unknown' : ''}`}
              aria-label={t("ui.CodexControls.CodexContextIndicator.open_codex_controls_for_context_usage_48f8812")}
              aria-describedby={meterId}
              data-context-percent={percent ?? undefined}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <circle className="codex-context-track" cx="9" cy="9" r="7" />
                <circle
                  className="codex-context-value"
                  cx="9"
                  cy="9"
                  r="7"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - (percent ?? 0)}
                />
              </svg>
            </button>
          </Dialog.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="shortcut-tooltip codex-context-tooltip"
            side="top"
            sideOffset={7}
            collisionPadding={8}
          >
            <strong>{percent == null ? t("ui.CodexControls.CodexContextIndicator.unavailable_ca18449") : formattedPercent}</strong>
            <Tooltip.Arrow className="shortcut-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
    <span
      id={meterId}
      className="sr-only"
      role="progressbar"
      aria-label={t("ui.CodexControls.CodexContextIndicator.codex_context_usage_4e369de")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={tooltip}
    >{tooltip}</span>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay codex-controls-overlay" />
      <Dialog.Content className="codex-controls-dialog" aria-describedby="codex-controls-description">
        <CodexControlsPanel />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function CodexGoalBar() {
  useLocale()
  const { supported, runtime, session, mutating, error, refresh, run, applyGoalSnapshot } = useCodexRuntime()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [focusGoal, setFocusGoal] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [observedAt, setObservedAt] = useState(() => Date.now())
  const [clock, setClock] = useState(() => Date.now())
  const [statusAction, setStatusAction] = useState<{
    status: 'active' | 'paused'
    pending: boolean
    error: string | null
  } | null>(null)
  const statusActionEpoch = useRef(0)
  const statusActionInFlight = useRef(false)
  const goal = runtime ? runtime.goal : session?.codex_goal ?? null
  const goalsEnabled = runtime?.goals_enabled !== false
  const threadActive = runtime?.status?.type === 'active'
  const lifecycleActive = useAppStore(state => session ? state.activeSessionIds.has(session.id) : false)

  useEffect(() => {
    setObservedAt(Date.now())
    setClock(Date.now())
  }, [goal?.status, goal?.timeUsedSeconds, goal?.updatedAt, session?.id])
  useEffect(() => {
    if (!goalsEnabled || !goal || goal.status !== 'active' || !threadActive) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [goal, goalsEnabled, threadActive])
  useEffect(() => {
    statusActionEpoch.current += 1
    statusActionInFlight.current = false
    setStatusAction(null)
    setDialogOpen(false)
    setDetailsOpen(false)
    return () => { statusActionEpoch.current += 1 }
  }, [session?.id])
  useEffect(() => {
    // A background status read must not erase a failed explicit action. Only
    // a retry or an authoritative transition to its requested status clears it.
    setStatusAction(current => current?.error && goal?.status === current.status ? null : current)
  }, [goal?.status])

  if (!supported || !session || !goal) return null

  const elapsed = Math.max(0, goal.timeUsedSeconds) + (
    goal.status === 'active' && threadActive
      ? Math.max(0, Math.floor((clock - observedAt) / 1_000))
      : 0
  )
  const toggleStatus = goalsEnabled && (goal.status === 'active' || goal.status === 'paused')
    ? () => {
      if (mutating || statusActionInFlight.current) return
      const status = goal.status === 'active' ? 'paused' : 'active'
      const epoch = statusActionEpoch.current
      statusActionInFlight.current = true
      setStatusAction({ status, pending: true, error: null })
      void run(async () => {
        const snapshot = await requiredBridge().setGoal(session.id, { status })
        if (epoch === statusActionEpoch.current) applyGoalSnapshot(snapshot)
      }).then(() => {
        if (epoch === statusActionEpoch.current) setStatusAction(null)
      }).catch(cause => {
        if (epoch !== statusActionEpoch.current) return
        setStatusAction({
          status,
          pending: false,
          error: controlErrorMessage(cause)
        })
      }).finally(() => {
        if (epoch === statusActionEpoch.current) statusActionInFlight.current = false
      })
    }
    : null
  const clear = () => {
    setStatusAction(null)
    runSilently(run(async () => {
      const snapshot = await requiredBridge().clearGoal(session.id)
      applyGoalSnapshot(snapshot)
    }))
  }
  const openControls = (goalOnly: boolean) => {
    setFocusGoal(goalOnly)
    setDialogOpen(true)
    void refresh()
  }
  const pendingLabel = statusAction?.pending
    ? statusAction.status === 'active' ? t('codexGoal.resuming') : t('codexGoal.pausing')
    : null
  // Derive retry direction from the same current status as the click handler.
  // An authoritative goal transition can arrive before a late RPC rejection.
  const unresolvedStatusError = statusAction?.error && statusAction.status !== goal.status
    ? t(statusAction.status === 'active' ? 'codexGoal.resumeFailed' : 'codexGoal.pauseFailed', { detail: statusAction.error })
    : null
  const statusActionLabel = pendingLabel || (unresolvedStatusError
    ? statusAction?.status === 'active' ? t('codexGoal.retryResume') : t('codexGoal.retryPause')
    : goal.status === 'active' ? t("ui.CodexControls.CodexGoalBar.pause_goal_27aa9fe") : t("ui.CodexControls.CodexGoalBar.resume_goal_55a31a1"))
  const resolvedStatusError = statusAction?.error && statusAction.status === goal.status
    && statusAction.error === error
  const displayedError = unresolvedStatusError || (resolvedStatusError ? null : error)
  const displayedStatus = goal.status !== 'active' && lifecycleActive
    ? t('codexGoal.inactiveMessageRunning', { status: goalStatusLabel(goal.status) })
    : goalStatusLabel(goal.status)

  return <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
    <section className={`composer-context-control codex-goal-bar${detailsOpen ? ' expanded' : ''}${displayedError ? ' error' : ''}`} aria-label={t("ui.CodexControls.CodexGoalBar.persistent_codex_goal_bb0d41b")}>
      <div className="codex-goal-bar-main">
        <Goal size={13} aria-hidden="true" />
        <strong title={goalsEnabled ? pendingLabel || displayedStatus : undefined}>{goalsEnabled ? pendingLabel || displayedStatus : t("ui.CodexControls.CodexGoalBar.goals_disabled_05cc75d")}</strong>
        <span className="codex-goal-objective" title={goal.objective}>{goal.objective}</span>
        <time aria-label={t("ui.CodexControls.CodexGoalBar.goal_elapsed_time_24a1c77", { "duration": String(formatGoalDuration(elapsed)) })}>{formatGoalDuration(elapsed)}</time>
        {goalsEnabled && <button type="button" aria-label={t("ui.CodexControls.CodexGoalBar.edit_goal_8828def")} title={t("ui.CodexControls.CodexGoalBar.edit_goal_8828def")} disabled={mutating} onClick={() => openControls(true)}><Pencil size={12} /></button>}
        {toggleStatus && <button
          type="button"
          aria-label={statusActionLabel}
          title={statusActionLabel}
          aria-busy={statusAction?.pending === true}
          disabled={mutating}
          onClick={toggleStatus}
        >{statusAction?.pending ? <LoaderCircle className="spin" size={12} /> : goal.status === 'active' ? <Pause size={12} /> : <Play size={12} />}</button>}
        {goalsEnabled && <button type="button" aria-label={t("ui.CodexControls.CodexGoalBar.clear_goal_0d7c342")} title={t("ui.CodexControls.CodexGoalBar.clear_goal_0d7c342")} disabled={mutating} onClick={clear}><Trash2 size={12} /></button>}
        <button
          type="button"
          aria-label={detailsOpen ? t("ui.CodexControls.CodexGoalBar.hide_goal_details_35d10a4") : t("ui.CodexControls.CodexGoalBar.show_goal_details_4a79f2c")}
          title={detailsOpen ? t("ui.CodexControls.CodexGoalBar.hide_goal_details_35d10a4") : t("ui.CodexControls.CodexGoalBar.show_goal_details_4a79f2c")}
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(value => !value)}
        ><ChevronRight size={13} /></button>
      </div>
      {detailsOpen && <div className="codex-goal-bar-detail">
        <span><small>{t("ui.CodexControls.CodexGoalBar.status_920e413")}</small><b>{displayedStatus}</b></span>
        <span><small>{t("ui.CodexControls.CodexGoalBar.tokens_a039dfb")}</small><b>{formatGoalBudget(goal.tokensUsed, goal.tokenBudget)}</b></span>
        <span><small>{t("ui.CodexControls.CodexGoalBar.time_33b9347")}</small><b>{formatGoalBudget(elapsed, runtime?.time_budget_seconds, true)}</b></span>
        <button type="button" className="quiet-button" onClick={() => openControls(false)}>{t("ui.CodexControls.CodexGoalBar.all_thread_controls_2aab8d9")}{" "}<ChevronRight size={12} /></button>
      </div>}
      {displayedError && <div className="codex-goal-bar-error" role="alert">{displayedError}</div>}
    </section>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay codex-controls-overlay" />
      <Dialog.Content className="codex-controls-dialog" aria-describedby="codex-controls-description">
        <CodexControlsPanel focusGoal={focusGoal} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function CodexControlsPanel({ focusGoal = false }: { focusGoal?: boolean }) {
  useLocale()
  const { runtime, session, loading, refreshing, mutating, error, refresh } = useCodexRuntime()
  const sharedDisconnected = useAppStore(state => window.agentsDock.sharedChat === true && !state.connected)
  const [notice, setNotice] = useState<string | null>(null)
  if (!session) return null
  return <div className="codex-controls">
    <header className="codex-controls-header">
      <span className={`codex-control-mark ${error || runtime?.available === false ? 'error' : codexStatusTone(runtime)}`}><Bot size={18} /></span>
      <div>
        <Dialog.Title>{t("ui.CodexControls.CodexControlsPanel.codex_thread_controls_51ea35d")}</Dialog.Title>
        <Dialog.Description id="codex-controls-description">
          {runtime?.transport ? `${runtime.transport} · ` : ''}
          {runtime?.available === false ? t("ui.CodexControls.CodexControlsPanel.controls_unavailable_d922552") : error ? t("ui.CodexControls.CodexControlsPanel.runtime_status_unavailable_bf25122") : codexStatusLabel(runtime?.status)}
          {runtime?.thread_loaded === false ? t("ui.CodexControls.CodexControlsPanel.thread_not_loaded_08b0501") : ''}
        </Dialog.Description>
      </div>
      <button type="button" className="icon-button" aria-label={t("ui.CodexControls.CodexControlsPanel.refresh_codex_status_da5990a")} disabled={refreshing || mutating || sharedDisconnected} onClick={() => void refresh()}>
        <RefreshCw className={refreshing ? 'spin' : ''} size={15} />
      </button>
      <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t("ui.CodexControls.CodexControlsPanel.close_codex_controls_9fa3e16")}><X size={16} /></button></Dialog.Close>
    </header>
    <div className="codex-controls-scroll-region">
      {sharedDisconnected && <div className="codex-control-alert" role="status">{t('chatShare.web.disconnected')}</div>}
      {error && <div className="codex-control-alert" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
      {notice && <div className="codex-control-notice" role="status"><Check size={14} /><span>{notice}</span><button type="button" aria-label={t("ui.CodexControls.CodexControlsPanel.dismiss_notice_a179917")} onClick={() => setNotice(null)}><X size={12} /></button></div>}
      {loading
        ? <div className="codex-controls-loading"><LoaderCircle className="spin" size={18} />{" "}{t("ui.CodexControls.CodexControlsPanel.loading_thread_controls_8d8c070")}</div>
        : <fieldset className="codex-controls-body" disabled={sharedDisconnected}>
          <PendingControlsSection />
          <ThreadStatusSection />
          <GoalSettings onNotice={setNotice} autoFocusObjective={focusGoal} />
          {!window.agentsDock.sharedChat && <ThreadActions onNotice={setNotice} />}
          {!window.agentsDock.sharedChat && <BackgroundTerminals onNotice={setNotice} />}
        </fieldset>}
    </div>
  </div>
}

function PendingControlsSection() {
  useLocale()
  const { runtime, session, mutating, run } = useCodexRuntime()
  const interactions = runtime?.pending_interactions ?? []
  if (!session || interactions.length === 0) return null
  return <section className="codex-control-section codex-control-pending">
    <div className="codex-section-heading"><MessageSquareCode size={15} /><div><strong>{t("ui.CodexControls.PendingControlsSection.waiting_for_you_9f760ab")}</strong><small>{t("ui.CodexControls.PendingControlsSection.respond_here_even_when_the_file_editor_is__d4749b2")}</small></div></div>
    <div className="codex-control-pending-list">
      {interactions.map(interaction => <CodexInteractionCard
        key={interaction.id}
        interaction={interaction}
        busy={mutating}
        onRespond={response => run(async () => {
          await requiredBridge().resolveInteraction(session.id, interaction.id, response)
        })}
      />)}
    </div>
  </section>
}

function ThreadStatusSection() {
  useLocale()
  const { runtime, session } = useCodexRuntime()
  const events = useAppStore(state => session ? state.snapshots[session.id]?.events ?? EMPTY_EVENTS : EMPTY_EVENTS)
  const runtimeUsage = runtime
    ? runtime.token_usage_snapshot !== undefined
      ? runtime.token_usage_snapshot
      : runtime.token_usage
    : undefined
  const usage = useMemo(
    () => latestCodexContextUsage(events, runtimeUsage, session?.codex_thread_id ?? session?.session_id),
    [events, runtimeUsage, session?.codex_thread_id, session?.session_id]
  )
  const goal = runtime?.goal
  const flags = runtime?.status?.type === 'active' ? runtime.status.activeFlags : []
  const used = numberValue(goal?.tokensUsed)
  const budget = numberValue(goal?.tokenBudget)
  const elapsed = numberValue(goal?.timeUsedSeconds)
  const timeLimit = runtime?.time_budget_seconds ?? null
  const timeBudgetExhausted = runtime?.time_budget_exhausted === true

  return <section className="codex-control-section status">
    <div className="codex-section-heading"><CircleGauge size={15} /><div><strong>{t("ui.CodexControls.ThreadStatusSection.thread_status_b5c2efa")}</strong><small>{t("ui.CodexControls.ThreadStatusSection.live_state_from_codex_app_server_01ac470")}</small></div></div>
    <div className="codex-status-grid">
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.state_a3b50c4")} value={runtime?.available === false ? 'Unavailable' : codexStatusLabel(runtime?.status)} />
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.thread_5373c7f")} value={runtime?.thread_loaded === false ? 'Not loaded' : 'Loaded'} />
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.context_a6e600a")} value={formatContextUsage(usage)} title={formatContextUsageDetail(usage)} />
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.transport_aaead4a")} value={runtime?.transport || 'app-server'} />
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.waiting_6e293a8")} value={flags.length ? flags.map(sentenceCase).join(', ') : 'No'} />
      <StatusDatum label={t("ui.CodexControls.ThreadStatusSection.budget_1c6225e")} value={timeBudgetExhausted ? 'Time exhausted' : timeLimit ? 'Available' : 'No time limit'} />
    </div>
    {usage && <ContextUsageDetail usage={usage} />}
    {timeBudgetExhausted && <div className="codex-budget-exhausted" role="alert">
      <AlertTriangle size={14} />
      <div>
        <strong>{t("ui.CodexControls.ThreadStatusSection.time_budget_exhausted_06d3283")}</strong>
        <small>{t("ui.CodexControls.ThreadStatusSection.new_goal_turns_are_blocked_increase_the_ti_80db27e")}</small>
      </div>
    </div>}
    {(goal || timeLimit) && <div className="codex-budget-summary">
      <ProgressDatum label={t("ui.CodexControls.ThreadStatusSection.tokens_a039dfb")} value={used} maximum={budget} suffix="" />
      <ProgressDatum label={t("ui.CodexControls.ThreadStatusSection.elapsed_a194a68")} value={elapsed} maximum={timeLimit ?? 0} suffix="s" />
    </div>}
  </section>
}

function GoalSettings({ onNotice, autoFocusObjective = false }: { onNotice(value: string): void; autoFocusObjective?: boolean }) {
  useLocale()
  const { runtime, session, run, applyGoalSnapshot } = useCodexRuntime()
  const goal = runtime?.goal
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [status, setStatus] = useState<CodexGoalStatus>((goal?.status as CodexGoalStatus) ?? 'active')
  const [tokenBudget, setTokenBudget] = useState(toInputNumber(goal?.tokenBudget))
  const [timeBudget, setTimeBudget] = useState(toInputNumber(runtime?.time_budget_seconds))
  const [goalAction, setGoalAction] = useState<'idle' | 'saving' | 'saved' | 'save-failed' | 'clearing' | 'clear-failed'>('idle')
  const [goalActionError, setGoalActionError] = useState<string | null>(null)
  const draftDirty = useRef(false)
  const draftRevision = useRef(0)
  const actionEpoch = useRef(0)
  const actionInFlight = useRef(false)
  const timeBudgetExhausted = runtime?.time_budget_exhausted === true

  useEffect(() => {
    actionEpoch.current += 1
    actionInFlight.current = false
    draftDirty.current = false
    draftRevision.current = 0
    setGoalAction('idle')
    setGoalActionError(null)
    setObjective(goal?.objective ?? '')
    setStatus((goal?.status as CodexGoalStatus) ?? 'active')
    setTokenBudget(toInputNumber(goal?.tokenBudget))
    setTimeBudget(toInputNumber(runtime?.time_budget_seconds))
    return () => {
      actionEpoch.current += 1
      actionInFlight.current = false
    }
  }, [session?.id])
  useEffect(() => {
    if (draftDirty.current) return
    setObjective(goal?.objective ?? '')
    setStatus((goal?.status as CodexGoalStatus) ?? 'active')
    setTokenBudget(toInputNumber(goal?.tokenBudget))
    setTimeBudget(toInputNumber(runtime?.time_budget_seconds))
  }, [
    goal?.objective,
    goal?.status,
    goal?.tokenBudget,
    runtime?.time_budget_seconds
  ])

  if (!session) return null
  if (runtime?.goals_enabled === false) {
    return <section className="codex-control-section" aria-label={t("ui.CodexControls.GoalSettings.persistent_goals_disabled_bb137e5")}>
      <div className="codex-section-heading"><Goal size={15} /><div><strong>{t("ui.CodexControls.GoalSettings.persistent_goals_953c4a2")}</strong><small>{t("ui.CodexControls.GoalSettings.disabled_server_wide_9a00be5")}</small></div></div>
      <div className="codex-goals-disabled" role="status">
        <strong>{t("ui.CodexControls.GoalSettings.persistent_goals_are_disabled_on_this_serv_d45e99e")}</strong>
        <small>{t("ui.CodexControls.GoalSettings.normal_chat_turns_and_scheduled_jobs_still_6371d49")}</small>
      </div>
    </section>
  }
  const markDraftDirty = () => {
    draftDirty.current = true
    draftRevision.current += 1
    setGoalAction(current => current === 'saving' || current === 'clearing' ? current : 'idle')
    setGoalActionError(null)
  }
  const applyGoalFormSnapshot = (snapshot: CodexGoalSnapshot, submittedRevision?: number) => {
    applyGoalSnapshot(snapshot)
    if (submittedRevision !== undefined && draftRevision.current !== submittedRevision) return false
    const nextGoal = snapshot.goal
    setObjective(nextGoal?.objective ?? '')
    setStatus((nextGoal?.status as CodexGoalStatus) ?? 'active')
    setTokenBudget(toInputNumber(nextGoal?.tokenBudget))
    setTimeBudget(toInputNumber(snapshot.time_budget_seconds))
    draftDirty.current = false
    return true
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (actionInFlight.current) return
    const trimmedObjective = objective.trim()
    if (!trimmedObjective) return
    const tokenBudgetResult = optionalPositiveInteger(tokenBudget, 'Token budget')
    const timeBudgetResult = optionalPositiveInteger(timeBudget, 'Time limit')
    const validationError = tokenBudgetResult.error || timeBudgetResult.error
    if (validationError) {
      setGoalAction('save-failed')
      setGoalActionError(validationError)
      return
    }
    const epoch = actionEpoch.current
    const submittedRevision = draftRevision.current
    actionInFlight.current = true
    setGoalAction('saving')
    setGoalActionError(null)
    void run(async () => {
      const snapshot = await requiredBridge().setGoal(session.id, {
        objective: trimmedObjective,
        status,
        token_budget: tokenBudgetResult.value,
        time_budget_seconds: timeBudgetResult.value
      })
      if (epoch !== actionEpoch.current) return
      const appliedToForm = applyGoalFormSnapshot(snapshot, submittedRevision)
      setGoalAction(appliedToForm ? 'saved' : 'idle')
      onNotice(appliedToForm
        ? 'Persistent goal updated.'
        : 'Persistent goal updated. Save again to apply your newer edits.')
    }).catch(cause => {
      if (epoch !== actionEpoch.current) return
      setGoalAction('save-failed')
      setGoalActionError(controlErrorMessage(cause))
    }).finally(() => {
      if (epoch !== actionEpoch.current) return
      actionInFlight.current = false
    })
  }
  const clear = () => {
    if (actionInFlight.current) return
    const epoch = actionEpoch.current
    const submittedRevision = draftRevision.current
    actionInFlight.current = true
    setGoalAction('clearing')
    setGoalActionError(null)
    void run(async () => {
      const snapshot = await requiredBridge().clearGoal(session.id)
      if (epoch !== actionEpoch.current) return
      const appliedToForm = applyGoalFormSnapshot(snapshot, submittedRevision)
      setGoalAction('idle')
      onNotice(appliedToForm
        ? 'Persistent goal cleared.'
        : 'Persistent goal cleared. Your newer draft is still unsaved.')
    }).catch(cause => {
      if (epoch !== actionEpoch.current) return
      setGoalAction('clear-failed')
      setGoalActionError(controlErrorMessage(cause))
    }).finally(() => {
      if (epoch !== actionEpoch.current) return
      actionInFlight.current = false
    })
  }
  const goalActionPending = goalAction === 'saving' || goalAction === 'clearing'

  return <section className="codex-control-section">
    <div className="codex-section-heading"><Goal size={15} /><div><strong>{t("ui.CodexControls.GoalSettings.persistent_goal_389445f")}</strong><small>{t("ui.CodexControls.GoalSettings.survives_turns_in_this_codex_thread_09f87c8")}</small></div></div>
    <form className="codex-goal-form" noValidate onSubmit={save}>
      <label className="wide">
        <span>{t("ui.CodexControls.GoalSettings.objective_3b20adc")}</span>
        <textarea autoFocus={autoFocusObjective} rows={3} maxLength={4000} value={objective} placeholder={t("ui.CodexControls.GoalSettings.what_should_codex_keep_working_toward_da42c7b")} onChange={event => {
          markDraftDirty()
          setObjective(event.target.value)
        }} />
      </label>
      <div className="codex-control-fields three-column">
        <label><span>{t("ui.CodexControls.GoalSettings.status_920e413")}</span><select value={status} onChange={event => {
          markDraftDirty()
          setStatus(event.target.value as CodexGoalStatus)
        }}>
          <option value="active">{t("ui.CodexControls.GoalSettings.active_9234069")}</option>
          <option value="paused">{t("ui.CodexControls.GoalSettings.paused_e159b06")}</option>
          <option value="blocked">{t("ui.CodexControls.GoalSettings.blocked_18f2a09")}</option>
          <option value="usageLimited">{t("ui.CodexControls.GoalSettings.usage_limited_d7eabde")}</option>
          <option value="budgetLimited">{t("ui.CodexControls.GoalSettings.budget_limited_1ab998e")}</option>
          <option value="complete">{t("ui.CodexControls.GoalSettings.complete_143b270")}</option>
        </select></label>
        <label><span>{t("ui.CodexControls.GoalSettings.token_budget_9ab958b")}</span><input type="number" min="1" step="1" value={tokenBudget} placeholder={t("ui.CodexControls.GoalSettings.no_limit_f7fcff0")} onChange={event => {
          markDraftDirty()
          setTokenBudget(event.target.value)
        }} /></label>
        <label>
          <span>{t("ui.CodexControls.GoalSettings.time_limit_seconds_cf9965b")}</span>
          <input type="number" min="1" step="1" value={timeBudget} placeholder={t("ui.CodexControls.GoalSettings.no_limit_f7fcff0")} onChange={event => {
            markDraftDirty()
            setTimeBudget(event.target.value)
          }} />
          <small>{t("ui.CodexControls.GoalSettings.agentsdock_enforced_limit_codex_reports_el_904b2bf")}</small>
          {timeBudgetExhausted && <small className="codex-field-error" role="status">{t("ui.CodexControls.GoalSettings.exhausted_raise_this_limit_or_change_the_o_1acb6cb")}</small>}
        </label>
      </div>
      <div className="codex-section-actions">
        {goalActionError && <span className="codex-inline-action-error" role="alert">{goalActionError}</span>}
        {goal && <button type="button" className="quiet-button codex-decline" disabled={goalActionPending} onClick={clear}>
          {goalAction === 'clearing' ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {goalAction === 'clearing' ? t("ui.CodexControls.GoalSettings.clearing_9a81378") : goalAction === 'clear-failed' ? t("ui.CodexControls.GoalSettings.retry_clear_19e9863") : t("ui.CodexControls.GoalSettings.clear_goal_0d7c342")}
        </button>}
        <button
          type="submit"
          className="primary-button"
          aria-busy={goalAction === 'saving'}
          disabled={goalActionPending || !objective.trim()}
        >
          {goalAction === 'saving' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          {goalAction === 'saving'
            ? t("ui.CodexControls.GoalSettings.saving_23e3929")
            : goalAction === 'saved'
              ? t("ui.CodexControls.GoalSettings.saved_b5c120b")
              : goalAction === 'save-failed'
                ? t("ui.CodexControls.GoalSettings.retry_save_71fdfa7")
                : t("ui.CodexControls.GoalSettings.save_goal_88b7665")}
        </button>
      </div>
    </form>
  </section>
}

function ThreadActions({ onNotice }: { onNotice(value: string): void }) {
  useLocale()
  const { runtime, session, error, run } = useCodexRuntime()
  const [reviewType, setReviewType] = useState<'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom'>('uncommittedChanges')
  const [reviewValue, setReviewValue] = useState('')
  const [rollbackTurns, setRollbackTurns] = useState('1')
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false)
  const [shellCommand, setShellCommand] = useState('')
  const [shellConfirmed, setShellConfirmed] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  if (!session) return null
  const threadStatus = runtime?.status?.type
  const hasProviderThread = runtime
    ? runtime.thread_loaded === true
    : Boolean(session.codex_thread_id || session.session_id)
  const actionsEnabled = Boolean(
    runtime
    && runtime.available
    && !error
    && hasProviderThread
    && threadStatus !== 'active'
    && threadStatus !== 'systemError'
  )
  const unavailableReason = actionsEnabled
    ? null
    : error
      ? 'Thread actions are unavailable until the Codex connection recovers.'
      : runtime?.available === false
        ? 'Thread actions are unavailable with the current Codex runtime.'
        : threadStatus === 'active'
          ? 'Thread actions will be available when the current turn finishes.'
          : !hasProviderThread || runtime?.thread_loaded === false
            ? 'Start a Codex turn in this chat before using thread actions.'
            : threadStatus === 'systemError'
              ? 'Thread actions are unavailable while Codex reports a runtime error.'
              : 'Loading Codex thread actions…'

  const compact = () => runSilently(run(async () => {
    await requiredBridge().compact(session.id)
    onNotice('Native context compaction started.')
  }))
  const review = () => runSilently(run(async () => {
    const target = reviewTarget(reviewType, reviewValue)
    await requiredBridge().review(session.id, { target, delivery: 'inline' })
    onNotice('Inline Codex review started.')
  }))
  const rollback = () => runSilently(run(async () => {
    await requiredBridge().rollback(session.id, {
      num_turns: Math.max(1, Number.parseInt(rollbackTurns, 10) || 1),
      confirmed: true
    })
    setRollbackConfirmed(false)
    onNotice('Provider thread rolled back. The AgentsDock timeline and files were not changed.')
  }))
  const shell = () => runSilently(run(async () => {
    const bridge = requiredBridge()
    await bridge.shell(session.id, { command: shellCommand.trim(), confirmed: true })
    setShellCommand('')
    setShellConfirmed(false)
    onNotice('Unsandboxed background command started.')
  }))

  return <section className="codex-control-section">
    <div className="codex-section-heading"><Sparkles size={15} /><div><strong>{t("ui.CodexControls.ThreadActions.thread_actions_3f52614")}</strong><small>{t("ui.CodexControls.ThreadActions.native_codex_app_server_operations_5218e7d")}</small></div></div>
    {unavailableReason && <div className={`codex-action-unavailable${threadStatus === 'active' ? ' running' : ''}`}><AlertTriangle size={13} /> {unavailableReason}</div>}
    <div className="codex-action-row">
      <div><strong>{t("ui.CodexControls.ThreadActions.compact_context_afbbb87")}</strong><small>{t("ui.CodexControls.ThreadActions.ask_codex_to_condense_the_thread_context_w_1e4c2a9")}</small></div>
      <button type="button" className="quiet-button" disabled={!actionsEnabled} onClick={compact}><ArchiveRestore size={14} />{" "}{t("ui.CodexControls.ThreadActions.compact_9945264")}</button>
    </div>
    <div className="codex-action-block">
      <div><strong>{t("ui.CodexControls.ThreadActions.inline_code_review_769da0c")}</strong><small>{t("ui.CodexControls.ThreadActions.review_results_appear_in_this_chat_d0f03e6")}</small></div>
      <div className="codex-review-target">
        <select aria-label={t("ui.CodexControls.ThreadActions.review_target_63f1cc1")} value={reviewType} onChange={event => setReviewType(event.target.value as typeof reviewType)}>
          <option value="uncommittedChanges">{t("ui.CodexControls.ThreadActions.uncommitted_changes_a388bd2")}</option>
          <option value="baseBranch">{t("ui.CodexControls.ThreadActions.changes_against_branch_588abe9")}</option>
          <option value="commit">{t("ui.CodexControls.ThreadActions.specific_commit_cc6c59e")}</option>
          <option value="custom">{t("ui.CodexControls.ThreadActions.custom_review_instructions_8ea8fc0")}</option>
        </select>
        {reviewType !== 'uncommittedChanges' && <input
          aria-label={reviewType === 'baseBranch' ? t("ui.CodexControls.ThreadActions.base_branch_9acbb9e") : reviewType === 'commit' ? t("ui.CodexControls.ThreadActions.commit_sha_d0bc602") : t("ui.CodexControls.ThreadActions.review_instructions_e61fbd9")}
          value={reviewValue}
          placeholder={reviewType === 'baseBranch' ? 'main' : reviewType === 'commit' ? t("ui.CodexControls.ThreadActions.commit_sha_d0bc602") : t("ui.CodexControls.ThreadActions.what_should_codex_review_5ce8d42")}
          onChange={event => setReviewValue(event.target.value)}
        />}
        <button type="button" className="quiet-button" disabled={!actionsEnabled || (reviewType !== 'uncommittedChanges' && !reviewValue.trim())} onClick={review}><ClipboardCheck size={14} />{" "}{t("ui.CodexControls.ThreadActions.review_aff0766")}</button>
      </div>
    </div>
    <button type="button" className="codex-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>
      <AlertTriangle size={14} />{" "}{t("ui.CodexControls.ThreadActions.advanced_and_unsandboxed_actions_87313c3")}{" "}<ChevronRight className={advancedOpen ? 'open' : ''} size={13} />
    </button>
    {advancedOpen && <div className="codex-advanced">
      <div className="codex-danger-zone">
        <div><strong>{t("ui.CodexControls.ThreadActions.roll_back_provider_thread_b42ab72")}</strong><small>{t("ui.CodexControls.ThreadActions.this_removes_codex_provider_turns_only_it__6f4f432")}</small></div>
        <label className="codex-number-field"><span>{t("ui.CodexControls.ThreadActions.turns_53cf0c9")}</span><input type="number" min="1" max="100" value={rollbackTurns} onChange={event => setRollbackTurns(event.target.value)} /></label>
        <label className="codex-confirm-check"><input type="checkbox" checked={rollbackConfirmed} onChange={event => setRollbackConfirmed(event.target.checked)} /><span>{t("ui.CodexControls.ThreadActions.i_understand_this_does_not_revert_files_e6553d8")}</span></label>
        <button type="button" className="danger-button" disabled={!actionsEnabled || !rollbackConfirmed} onClick={rollback}><ArchiveRestore size={14} />{" "}{t("ui.CodexControls.ThreadActions.roll_back_931f703")}</button>
      </div>
      <div className="codex-shell-zone">
        <div><strong>{t("ui.CodexControls.ThreadActions.background_shell_command_dc4b523")}</strong><small>{t("ui.CodexControls.ThreadActions.this_native_codex_action_is_unsandboxed_an_20e56fa")}</small></div>
        <textarea
          rows={2}
          aria-label={t("ui.CodexControls.ThreadActions.unsandboxed_shell_command_052a4a9")}
          value={shellCommand}
          placeholder={t("ui.CodexControls.ThreadActions.enter_an_exact_shell_command_406010b")}
          onChange={event => setShellCommand(event.target.value)}
        />
        <label className="codex-confirm-check"><input type="checkbox" checked={shellConfirmed} onChange={event => setShellConfirmed(event.target.checked)} /><span>{t("ui.CodexControls.ThreadActions.i_explicitly_approve_running_this_command__3fbfc84")}</span></label>
        <button type="button" className="danger-button" disabled={!actionsEnabled || !shellConfirmed || !shellCommand.trim()} onClick={shell}><Play size={14} />{" "}{t("ui.CodexControls.ThreadActions.run_command_87e30f3")}</button>
      </div>
    </div>}
  </section>
}

function BackgroundTerminals({ onNotice }: { onNotice(value: string): void }) {
  useLocale()
  const { runtime, session, run } = useCodexRuntime()
  const [open, setOpen] = useState(false)
  const [terminals, setTerminals] = useState<CodexBackgroundTerminal[]>([])
  const [loading, setLoading] = useState(false)
  const [supported, setSupported] = useState<boolean | null>(runtime?.background_terminals_supported ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingProcessId, setConfirmingProcessId] = useState<string | null>(null)
  const [stopAllConfirmed, setStopAllConfirmed] = useState(false)
  useEffect(() => {
    setSupported(runtime?.background_terminals_supported ?? null)
    setTerminals([])
    setLoadError(null)
    setConfirmingProcessId(null)
    setStopAllConfirmed(false)
    setOpen(false)
  }, [runtime?.background_terminals_supported, session?.id])
  if (!session) return null
  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const snapshot = await requiredBridge().backgroundTerminals(session.id)
      setSupported(snapshot.supported)
      setTerminals(snapshot.terminals)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }
  const toggle = () => {
    setOpen(value => {
      const next = !value
      if (next) void load()
      return next
    })
  }
  const terminate = (processId: string) => runSilently(run(async () => {
    await requiredBridge().terminateBackgroundTerminal(session.id, {
      process_id: processId,
      confirmed: true
    })
    setConfirmingProcessId(null)
    await load()
    onNotice('Background terminal terminated.')
  }))
  const stopAll = () => runSilently(run(async () => {
    await requiredBridge().cleanBackgroundTerminals(session.id, { confirmed: true })
    setStopAllConfirmed(false)
    await load()
    onNotice('All running background terminals stopped.')
  }))

  return <section className="codex-control-section background-terminals">
    <button type="button" className="codex-section-toggle" aria-expanded={open} onClick={toggle}>
      <SquareTerminal size={15} /><span><strong>{t("ui.CodexControls.BackgroundTerminals.background_terminals_ae46f4c")}</strong><small>{t("ui.CodexControls.BackgroundTerminals.loaded_only_when_this_section_is_open_dd2f0e9")}</small></span><ChevronRight className={open ? 'open' : ''} size={14} />
    </button>
    {open && <div className="codex-terminal-list">
      <div className="codex-terminal-toolbar"><span>{supported === false ? t("ui.CodexControls.BackgroundTerminals.unsupported_by_this_codex_version_3ef524f") : `${terminals.length} running process${terminals.length === 1 ? '' : 'es'}`}</span></div>
      {loading && <div className="codex-inline-loading"><LoaderCircle className="spin" size={14} />{" "}{t("ui.CodexControls.BackgroundTerminals.loading_ba3bbbe")}</div>}
      {!loading && loadError && <p role="alert">{loadError}</p>}
      {!loading && !loadError && supported !== false && terminals.length === 0 && <p>{t("ui.CodexControls.BackgroundTerminals.no_background_terminals_9e192b0")}</p>}
      {!loading && terminals.map(terminal => {
        const processId = terminal.processId
        return <article key={processId || JSON.stringify(terminal)}>
          <SquareTerminal size={14} />
          <div><strong>{terminal.command || processId || 'Background terminal'}</strong><small>{[terminal.osPid ? `PID ${terminal.osPid}` : '', terminal.cwd].filter(Boolean).join(' · ')}</small></div>
          {processId && (confirmingProcessId === processId
            ? <div className="codex-terminal-confirm">
              <span>{t("ui.CodexControls.stop_this_process_c7d3d80")}</span>
              <button type="button" className="quiet-button" onClick={() => setConfirmingProcessId(null)}>{t("ui.CodexControls.cancel_19766ed")}</button>
              <button type="button" className="danger-button" onClick={() => terminate(processId)}><X size={13} />{" "}{t("ui.CodexControls.confirm_terminate_d57e087")}</button>
            </div>
            : <button
              type="button"
              className="quiet-button codex-decline"
              onClick={() => setConfirmingProcessId(processId)}
            ><X size={13} />{" "}{t("ui.CodexControls.terminate_f913f09")}</button>)}
        </article>
      })}
      {supported !== false && terminals.length > 0 && <div className="codex-stop-all-terminals">
        <label className="codex-confirm-check">
          <input
            type="checkbox"
            checked={stopAllConfirmed}
            onChange={event => setStopAllConfirmed(event.target.checked)}
          />
          <span>{t("ui.CodexControls.BackgroundTerminals.i_understand_this_stops_every_running_back_f164da3")}</span>
        </label>
        <button
          type="button"
          className="danger-button"
          disabled={!stopAllConfirmed || loading}
          onClick={stopAll}
        ><Trash2 size={13} />{" "}{t("ui.CodexControls.BackgroundTerminals.stop_all_terminals_635b776")}</button>
      </div>}
    </div>}
  </section>
}

function StatusDatum({ label, value, title }: { label: string; value: string; title?: string }) {
  useLocale()
  return <div title={title}><small>{label}</small><strong>{value}</strong></div>
}

function ContextUsageDetail({ usage }: { usage: CodexContextUsage }) {
  useLocale()
  const effectiveTokens = usage.contextTokens == null
    ? null
    : Math.max(0, usage.contextTokens - (usage.baselineTokens ?? 0))
  const hasProgress = effectiveTokens != null && usage.effectiveContextWindow != null && usage.effectiveContextWindow > 0
  const turnLabel = usage.runId || usage.turnId
  const metrics = [
    ['Input', usage.inputTokens],
    ['Cached', usage.cachedInputTokens],
    ['Cache write', usage.cacheWriteInputTokens],
    ['Output', usage.outputTokens],
    ['Reasoning', usage.reasoningOutputTokens],
    ['Session total', usage.totalTokens]
  ] as const
  return <div className="codex-context-detail">
    <div className="codex-context-detail-heading">
      <span><strong>{t("ui.CodexControls.ContextUsageDetail.context_usage_36416fa")}</strong><small>{formatContextUsageDetail(usage)}</small></span>
      {turnLabel && <span title={turnLabel}><small>{t("ui.CodexControls.ContextUsageDetail.latest_turn_f3ae7c9")}</small><code>{shortUsageId(turnLabel)}</code></span>}
    </div>
    {hasProgress && <progress
      max={usage.effectiveContextWindow!}
      value={Math.min(effectiveTokens!, usage.effectiveContextWindow!)}
      aria-label={t("ui.CodexControls.ContextUsageDetail.of_usable_context_tokens_used_ba0a593", { "used": String(formatCompactTokens(effectiveTokens!)), "total": String(formatCompactTokens(usage.effectiveContextWindow!)) })}
    />}
    <div className="codex-context-metrics">
      {metrics.map(([label, value]) => value == null ? null : (
        <span key={label}><small>{label}</small><strong>{formatCompactTokens(value)}</strong></span>
      ))}
    </div>
  </div>
}

function ProgressDatum({ label, value, maximum, suffix }: { label: string; value: number; maximum: number; suffix: string }) {
  useLocale()
  const bounded = maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0
  return <div className="codex-progress-datum">
    <span><strong>{label}</strong><small>{value.toLocaleString()}{suffix}{maximum > 0 ? ` / ${maximum.toLocaleString()}${suffix}` : ''}</small></span>
    {maximum > 0 && <progress max={100} value={bounded} aria-label={t("ui.CodexControls.ProgressDatum.budget_used_7fb36df", { "label": String(label) })} />}
  </div>
}

function reviewTarget(type: 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom', value: string): CodexReviewTarget {
  if (type === 'baseBranch') return { type, branch: value.trim() }
  if (type === 'commit') return { type, sha: value.trim() }
  if (type === 'custom') return { type, instructions: value.trim() }
  return { type }
}

function requiredBridge() {
  const bridge = codexBridge()
  if (!bridge) throw new Error('This AgentsDock build does not expose Codex controls.')
  return bridge
}

function runSilently(operation: Promise<unknown>): void {
  void operation.catch(() => undefined)
}

function controlErrorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toInputNumber(value: JsonValue | undefined): string {
  return typeof value === 'number' && value > 0 ? String(value) : ''
}

function optionalPositiveInteger(value: string, label: string): { value: number | null; error: string | null } {
  if (!value.trim()) return { value: null, error: null }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { value: null, error: t("ui.CodexControls.optionalPositiveInteger.must_be_a_positive_whole_number_or_left_em_2d871dd", { "label": String(label) }) }
  }
  return { value: parsed, error: null }
}

function goalStatusLabel(status: CodexGoalStatus): string {
  if (status === 'active') return t("ui.CodexControls.goalStatusLabel.pursuing_goal_fc97a3f")
  if (status === 'paused') return t("ui.CodexControls.goalStatusLabel.goal_paused_2f66cdd")
  if (status === 'blocked') return t("ui.CodexControls.goalStatusLabel.goal_blocked_12fd7aa")
  if (status === 'usageLimited') return t("ui.CodexControls.goalStatusLabel.usage_limited_d7eabde")
  if (status === 'budgetLimited') return t("ui.CodexControls.goalStatusLabel.budget_limited_1ab998e")
  return t("ui.CodexControls.goalStatusLabel.goal_complete_0ac24f8")
}

function formatGoalDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return t("ui.CodexControls.formatGoalDuration.s_5307d20", { "seconds": String(whole) })
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return t("ui.CodexControls.formatGoalDuration.m_f704717", { "minutes": String(minutes) })
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? t("ui.CodexControls.formatGoalDuration.h_m_425dc6c", { "hours": String(hours), "minutes": String(remainder) }) : t("ui.CodexControls.formatGoalDuration.h_d11dfab", { "hours": String(hours) })
}

function formatGoalBudget(value: number, maximum?: number | null, duration = false): string {
  const current = duration ? formatGoalDuration(value) : value.toLocaleString()
  if (!maximum || maximum <= 0) return current
  const limit = duration ? formatGoalDuration(maximum) : maximum.toLocaleString()
  return `${current} / ${limit}`
}

function sentenceCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, match => match.toUpperCase())
}

function shortUsageId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value
}

function contextUsagePercent(usage: CodexContextUsage | null): number | null {
  const value = usage?.contextPercent
    ?? (usage?.contextTokens != null && usage.contextWindow != null && usage.contextWindow > 0
      ? usage.contextTokens / usage.contextWindow * 100
      : null)
  return value == null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value))
}

function formatContextIndicatorPercent(percent: number | null): string {
  if (percent == null) return '—'
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`
}

const EMPTY_EVENTS = [] as const
