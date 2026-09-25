import * as Popover from '@radix-ui/react-popover'
import { Gauge, RefreshCw, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { getLocale, t } from '@shared/i18n'
import { providerUsageRemaining, type ProviderUsageSnapshot, type ProviderUsageWindow } from '@shared/provider-usage'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import './ProviderUsageIndicator.css'

interface UsageState {
  key: string
  value: ProviderUsageSnapshot | null
  refreshing: boolean
  failed: boolean
}

export function ProviderUsageIndicator({ session }: { session: Session }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const serverIdentity = useAppStore(state => state.health?.server_identity)
  const serverInstance = useAppStore(state => state.health?.server_instance_id)
  const available = useAppStore(state => state.health?.capabilities?.provider_usage?.available === true)
  const backend = session.backend === 'codex' || session.backend === 'claude' ? session.backend : null
  const key = JSON.stringify([profileId, profileGeneration, serverIdentity, serverInstance, session.id, backend, session.codex_provider])
  const [state, setState] = useState<UsageState>({ key: '', value: null, refreshing: false, failed: false })
  const [open, setOpen] = useState(false)
  const refresh = useRef<(force?: boolean) => void>(() => undefined)
  const titleId = useId()

  useEffect(() => {
    setOpen(false)
  }, [key])

  useEffect(() => {
    const api = window.agentsDock.runtime?.usage
    if (!backend || !profileId || !available || !connected || window.agentsDock.sharedChat || !api) return
    const scope = { profileId, profileGeneration, serverIdentity }
    let disposed = false
    let pending = false
    let requested = false
    let forceNext = false
    const read = async (force = false): Promise<void> => {
      if (pending) { requested = true; forceNext ||= force; return }
      pending = true
      setState(previous => ({ key, value: previous.key === key ? previous.value : null, refreshing: true, failed: false }))
      try {
        const value = await api(scope, backend, session.id, force)
        if (!disposed) setState({ key, value, refreshing: false, failed: false })
      } catch {
        if (!disposed) setState(previous => previous.key === key ? { ...previous, refreshing: false, failed: true } : previous)
      } finally {
        pending = false
        if (!disposed && requested) {
          requested = false
          const next = forceNext
          forceNext = false
          void read(next)
        }
      }
    }
    const refreshNow = (force = true) => { void read(force) }
    refresh.current = refreshNow
    const unsubscribe = window.agentsDock.events.on('provider-usage:changed', event => {
      if (event.profileId !== profileId || event.profileGeneration !== profileGeneration
        || event.sessionId !== session.id || event.backend !== backend) return
      void read()
    })
    void read()
    return () => {
      disposed = true
      unsubscribe()
      if (refresh.current === refreshNow) refresh.current = () => undefined
    }
  }, [key, profileId, profileGeneration, serverIdentity, session.id, backend, available, connected])

  const usage = state.key === key ? state.value : null
  if (window.agentsDock.sharedChat || !available || !backend || !usage || usage.status !== 'available'
    || (!usage.windows.length && !usage.credits)) return null
  const remaining = providerUsageRemaining(usage)
  const label = usage.windows.some(window => window.status === 'rejected') ? t('providerUsage.limitReached')
    : remaining === null ? t('providerUsage.title') : t('providerUsage.remaining', { percent: formatPercent(remaining) })
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next && connected) refresh.current() }}>
    <Popover.Trigger asChild>
      <button type="button" className="provider-usage-indicator" aria-label={`${t('providerUsage.title')}: ${label}`}
        title={`${t('providerUsage.title')}: ${label}`}>
        <Gauge size={14} /><span>{label}</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="provider-usage-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-labelledby={titleId}>
        <header>
          <h3 id={titleId}>{t('providerUsage.accountTitle', { provider: backend === 'codex' ? 'Codex' : 'Claude' })}</h3>
          <button type="button" className="icon-button" aria-label={t('providerUsage.refresh')} disabled={!connected || state.refreshing}
            onClick={() => refresh.current()}><RefreshCw size={14} className={state.refreshing ? 'spin' : undefined} /></button>
          <Popover.Close asChild><button type="button" className="icon-button" aria-label={t('providerUsage.close')}><X size={15} /></button></Popover.Close>
        </header>
        {usage.windows.map(window => <div className="provider-usage-window" key={window.id}>
          <div className="provider-usage-row"><span>{windowLabel(window)}</span><strong>{window.used_percent === null
            ? window.status === 'rejected' ? t('providerUsage.limitReached') : t('providerUsage.notReported')
            : t('providerUsage.remaining', { percent: formatPercent(Math.max(0, Math.min(100, 100 - window.used_percent))) })}</strong></div>
          {window.used_percent !== null && <progress max={100} value={Math.max(0, Math.min(100, 100 - window.used_percent))}
            aria-label={t('providerUsage.windowRemaining', { window: windowLabel(window) })} />}
          {window.resets_at !== null && <p>{t('providerUsage.resets', { time: formatTime(window.resets_at * 1000) })}</p>}
        </div>)}
        {usage.credits && <div className="provider-usage-row provider-usage-credits"><span>{t('providerUsage.credits')}</span><strong>{
          usage.credits.unlimited ? t('providerUsage.unlimited') : usage.credits.balance !== null ? usage.credits.balance
            : usage.credits.has_credits ? t('providerUsage.available') : t('providerUsage.none')
        }</strong></div>}
        <footer>
          {!connected && <p role="status">{t('providerUsage.offline')}</p>}
          {state.failed && <p role="status">{t('providerUsage.refreshFailed')}</p>}
          {usage.observed_at && <p>{t('providerUsage.reported', { time: formatTime(Date.parse(usage.observed_at)) })}</p>}
          {usage.source === 'claude-events' && <p>{t('providerUsage.claudeObserved')}</p>}
        </footer>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function formatPercent(value: number): string { return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(value) }
function formatTime(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
}
function windowLabel(window: ProviderUsageWindow): string {
  const period = window.window_minutes === 300 || window.id === 'five_hour' ? t('providerUsage.fiveHour')
    : window.window_minutes === 10080 || window.id === 'seven_day' ? t('providerUsage.weekly')
    : window.window_minutes ? t('providerUsage.minutes', { count: window.window_minutes }) : null
  return window.label ? period && window.label !== period ? `${window.label} · ${period}` : window.label
    : period ?? t('providerUsage.allowance')
}
