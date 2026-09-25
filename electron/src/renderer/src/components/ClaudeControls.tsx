import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Bot, CircleGauge, Goal, LoaderCircle, MessageSquareCode, RefreshCw, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { formatClaudeContextUsageDetail, formatContextPercent, parseClaudeContextUsage } from '../lib/claude-context-usage'
import { useAppStore } from '../store/app-store'
import { useTransientClose } from '../lib/transient-close'
import { ProviderStatusTrigger } from './ProviderStatusTrigger'
import { ProviderInteractionCard } from './CodexInteractionShelf'
import { codexStatusLabel } from './CodexRuntimeContext'
import { claudeBridge, useClaudeRuntime } from './ClaudeRuntimeContext'
import { useClaudeGoalsAvailable } from './ClaudeGoalControls'
import './CodexControls.css'

export function ClaudeStatusButton() {
  useLocale()
  const { supported, session, runtime, loading, refreshing, mutating, runtimeError, interactionError, refresh, run } = useClaudeRuntime()
  const goalsAvailable = useClaudeGoalsAvailable()
  const [open, setOpen] = useState(false)
  useTransientClose(open, () => setOpen(false))
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const running = useAppStore(state => session ? state.activeSessionIds.has(session.id) : false)
  const starting = useAppStore(state => session ? Boolean(state.turnAdmissionTokens[session.id]) : false)
  useEffect(() => setOpen(false), [session?.id, profileId, generation])
  const interactions = runtime?.pending_interactions ?? []
  const flags = runtime?.status?.type === 'active' ? runtime.status.activeFlags : []
  const unavailable = runtime?.available === false
  const waiting = interactions.length > 0 || flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
  const tone = runtimeError || unavailable || runtime?.status?.type === 'systemError' ? 'error'
    : waiting ? 'waiting' : running || starting || runtime?.status?.type === 'active' ? 'active' : 'idle'
  const status = runtimeError ? t('claudeControls.error') : unavailable ? t('claudeControls.unavailable')
    : interactions.length ? t('claudeControls.waitingCount', { count: interactions.length })
      : waiting ? codexStatusLabel(runtime?.status) : running ? t('timeline.status.running')
        : starting ? t('timeline.status.starting') : loading ? t('claudeControls.loading') : codexStatusLabel(runtime?.status)
  const usage = parseClaudeContextUsage(runtime?.context_usage_snapshot !== undefined ? runtime.context_usage_snapshot : runtime?.context_usage)
  const openGoal = () => {
    setOpen(false)
    // The composer already owns the goal dialog and its draft. Open that same
    // surface instead of constructing a second goal controller in the header.
    window.dispatchEvent(new CustomEvent('agentsdock:open-claude-goal', { detail: { sessionId: session?.id } }))
  }
  if (!supported || !session) return null
  return <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (value) void refresh() }}>
    <Dialog.Trigger asChild><ProviderStatusTrigger provider="Claude" status={status} tone={tone} loading={loading}
      aria-label={t('claudeControls.trigger', { status })} title={t('claudeControls.title')} /></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay codex-controls-overlay" />
      <Dialog.Content className="codex-controls-dialog">
        <div className="codex-controls">
          <header className="codex-controls-header">
            <span className={`codex-control-mark ${tone}`}><Bot size={18} /></span>
            <div><Dialog.Title>{t('claudeControls.title')}</Dialog.Title><Dialog.Description>{status}</Dialog.Description></div>
            <button type="button" className="icon-button" aria-label={t('claudeControls.refresh')} disabled={refreshing || mutating || !connected}
              onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /></button>
            <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t('claudeControls.close')}><X size={16} /></button></Dialog.Close>
          </header>
          <div className="codex-controls-scroll-region">
            {!connected && <div className="codex-control-alert" role="status">{t('claudeControls.disconnected')}</div>}
            {(runtimeError || interactionError) && <div className="codex-control-alert" role="alert"><AlertTriangle size={14} /><span>{runtimeError || interactionError}</span></div>}
            {loading ? <div className="codex-controls-loading"><LoaderCircle size={18} className="spin" />{t('claudeControls.loading')}</div>
              : <fieldset className="codex-controls-body" disabled={!connected}>
                {interactions.length > 0 && <section className="codex-control-section codex-control-pending">
                  <div className="codex-section-heading"><MessageSquareCode size={15} /><div><strong>{t('ui.CodexControls.PendingControlsSection.waiting_for_you_9f760ab')}</strong></div></div>
                  <div className="codex-control-pending-list">{interactions.map(interaction => <ProviderInteractionCard key={interaction.id}
                    providerName="Claude" interaction={interaction} busy={mutating} onRespond={response => run(async () => {
                      const bridge = claudeBridge()
                      if (!bridge) throw new Error(t('claudeControls.unavailable'))
                      await bridge.resolveInteraction(session.id, interaction.id, response)
                    })} />)}</div>
                </section>}
                <section className="codex-control-section status">
                  <div className="codex-section-heading"><CircleGauge size={15} /><div><strong>{t('ui.CodexControls.ThreadStatusSection.thread_status_b5c2efa')}</strong><small>{t('claudeControls.nativeStatus')}</small></div></div>
                  <div className="codex-status-grid">
                    <Datum label={t('ui.CodexControls.ThreadStatusSection.state_a3b50c4')} value={status} />
                    <Datum label={t('ui.CodexControls.ThreadStatusSection.thread_5373c7f')} value={t(runtime?.session_loaded ? 'claudeControls.loaded' : 'claudeControls.notLoaded')} />
                    <Datum label={t('ui.CodexControls.ThreadStatusSection.context_a6e600a')} value={formatContextPercent(usage?.contextPercent ?? null)} />
                    <Datum label={t('ui.CodexControls.ThreadStatusSection.transport_aaead4a')} value={runtime?.transport ?? '—'} />
                  </div>
                  {usage && <p className="goal-feedback">{formatClaudeContextUsageDetail(usage)}</p>}
                </section>
                {goalsAvailable && <section className="codex-control-section"><div className="codex-action-row">
                  <div><strong>{t('claudeGoal.title')}</strong><small>{runtime?.goal?.condition || t('claudeGoal.description')}</small></div>
                  <button type="button" className="quiet-button" onClick={openGoal}><Goal size={14} />{t('codexGoal.open')}</button>
                </div></section>}
              </fieldset>}
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function Datum({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><strong>{value}</strong></div>
}
