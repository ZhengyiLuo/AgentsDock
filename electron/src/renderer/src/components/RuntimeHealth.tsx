// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from 'lucide-react'
import type { Backend, CodexProvider, Event, RuntimeCatalog, RuntimeDiagnostic } from '@shared/types'
import {
  opencodeBackendAvailable,
  opencodeBackendUnavailableReason,
  cursorBackendAvailable,
  cursorBackendUnavailableReason,
  runtimeDiagnosticCurrentError,
  runtimeDiagnosticFor,
  runtimeDiagnosticLabel,
  runtimeDiagnosticNeedsAttention,
  runtimeDiagnosticTone,
} from '@shared/runtime-catalog'
import { memo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { eventErrorText, isTimelineError } from '../lib/timeline'
import { NativeProviderSignIn } from './NativeProviderSignIn'
import { openAIProviderSettings } from '../lib/provider-settings'

export const RuntimeHealthNotice = memo(function RuntimeHealthNotice({ backend, sessionId, codexProvider, admissionError }: { backend: Backend; sessionId: string; codexProvider?: CodexProvider; admissionError?: string }) {
  useLocale()
  const { refreshing, recheck } = useRuntimeRecheck()
  return <RuntimeStatus backend={backend} codexProvider={codexProvider} admissionError={admissionError} compact sessionId={sessionId} refreshing={refreshing} onRecheck={recheck} />
})

export function RuntimeHealthPanel() {
  useLocale()
  const { refreshing, recheck } = useRuntimeRecheck()
  const cursorAdvertised = useAppStore(state => Boolean(
    state.health?.capabilities?.cursor_backend
  ))
  return <section className="runtime-health-panel">
    <header>
      <div><strong>{t('connections.nativeTitle')}</strong><small>{t('connections.nativeHelp')}</small></div>
      <button type="button" className="quiet-button" disabled={refreshing} onClick={() => void recheck()}>
        <RefreshCw className={refreshing ? 'spin' : ''} size={13} />{" "}{t("ui.RuntimeHealth.RuntimeHealthPanel.recheck_clis_a388594")}</button>
    </header>
    <div className="runtime-health-list">
      <TmuxStatus />
      <RuntimeStatus backend="claude" />
      <RuntimeStatus backend="codex" />
      {cursorAdvertised && <RuntimeStatus backend="cursor" />}
      <RuntimeStatus backend="opencode" />
    </div>
  </section>
}

export function useRuntimeRecheck() {
  const [refreshing, setRefreshing] = useState(false)
  const recheck = async () => {
    setRefreshing(true)
    try {
      const runtimeCatalog = runtimeCatalogAfterExplicitRecheck(
        await window.agentsDock.runtime.catalog(true)
      )
      const refreshedDiagnostics = Object.fromEntries(
        Object.entries(runtimeCatalog.backends).flatMap(([backend, value]) => (
          value.diagnostic ? [[backend, value.diagnostic] as const] : []
        ))
      ) as Record<string, RuntimeDiagnostic>
      useAppStore.setState(state => ({
        runtimeCatalog,
        health: state.health && Object.keys(refreshedDiagnostics).length > 0
          ? { ...state.health, runtimes: { ...state.health.runtimes, ...refreshedDiagnostics } }
          : state.health,
        error: null,
      }))
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }
  return { refreshing, recheck }
}

function runtimeCatalogAfterExplicitRecheck(catalog: RuntimeCatalog): RuntimeCatalog {
  let changed = false
  const backends = { ...catalog.backends }
  for (const [backend, value] of Object.entries(catalog.backends)) {
    const diagnostic = value.diagnostic
    if (diagnostic?.status !== 'ready' || !diagnostic.last_error) continue
    changed = true
    backends[backend] = {
      ...value,
      // The explicit refresh just proved the CLI is ready. Treat a preserved
      // provider failure as older than this causal observation even when the
      // server's second-resolution timestamps happen to be equal.
      diagnostic: { ...diagnostic, last_error: null, last_error_at: null },
    }
  }
  return changed ? { ...catalog, backends } : catalog
}

function TmuxStatus() {
  useLocale()
  const capability = useAppStore(state => state.health?.capabilities?.tmux)
  const tone = capability ? capability.available ? 'ready' : 'warning' : 'unknown'
  const Icon = tone === 'ready' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : CircleHelp
  const label = capability ? capability.available ? 'Ready' : 'Missing' : 'Not reported'
  const detail = capability?.message || 'This AgentsServer version has not reported tmux readiness.'
  return <div className={`runtime-health-row ${tone}`} role="status">
    <Icon size={17} />
    <div>
      <strong>tmux <span>{label}</span></strong>
      <small>{detail}</small>
      {capability?.action ? <small className="runtime-action">{capability.action}</small> : null}
    </div>
  </div>
}

function RuntimeStatus({
  backend,
  codexProvider,
  admissionError,
  compact = false,
  sessionId,
  refreshing = false,
  onRecheck,
}: {
  backend: Backend
  codexProvider?: CodexProvider
  admissionError?: string
  compact?: boolean
  sessionId?: string
  refreshing?: boolean
  onRecheck?: () => Promise<void>
}) {
  useLocale()
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const cursorCapability = backend === 'opencode' ? health?.capabilities?.opencode_backend : health?.capabilities?.cursor_backend
  // Keep compact notices independent from ordinary live timeline growth. The
  // selector still observes a newly relevant run error, but its stable string
  // prevents every event append from rerendering this subtree.
  const chatError = useAppStore(state => (
    compact && sessionId ? latestChatRunError(state.snapshots[sessionId]?.events, backend) : ''
  ))
  const customCatalog = useAppStore(state => { const session = state.sessions.find(item => item.id === sessionId); return session?.provider_connection_catalog ?? session?.codex_provider_catalog })
  const diagnostic = runtimeDiagnosticFor(health, catalog, backend, codexProvider, customCatalog)
  const cursorUnavailable = codexProvider !== 'custom' && (backend === 'cursor' && !cursorBackendAvailable(health, catalog) || backend === 'opencode' && !opencodeBackendAvailable(health, catalog))
  // Provider last_error is backend-wide, not session-scoped. Keep it in the
  // full Settings panel so a failure from one chat cannot leak into another
  // chat's compact composer notice.
  // Claude checks authentication during a real send. Unknown readiness, or
  // another chat's cached login failure, is not a reason to warn up front.
  // Keep installation failures visible; only show passive auth diagnostics
  // alongside an actual error from this chat's latest run.
  const passiveClaudeAuth = backend === 'claude'
    && (diagnostic?.status === 'unknown' || diagnostic?.status === 'unauthenticated')
  const providerNeedsAttention = compact
    ? cursorUnavailable || Boolean(diagnostic && diagnostic.status !== 'ready' && (!passiveClaudeAuth || chatError))
    : cursorUnavailable || runtimeDiagnosticNeedsAttention(diagnostic)
  const customAdmissionError = codexProvider === 'custom' ? admissionError : undefined
  if (compact && !chatError && !providerNeedsAttention && !customAdmissionError) return null
  const tone = chatError ? 'warning' : !compact && diagnostic?.installed !== false
    ? connected && diagnostic?.authenticated === true && diagnostic.status === 'ready' ? 'ready' : 'unknown'
    : cursorUnavailable ? 'error' : runtimeDiagnosticTone(diagnostic)
  const Icon = tone === 'ready' ? CheckCircle2 : tone === 'error' ? XCircle : tone === 'warning' ? AlertTriangle : CircleHelp
  const provider = backend === 'claude' ? 'Claude Code' : backend === 'cursor' ? 'Cursor' : backend === 'opencode' ? 'OpenCode' : codexProvider === 'custom' ? t('codexProvider.label') : 'Codex'
  const cursorUnavailableDetail = cursorUnavailable
    ? (backend === 'opencode' ? opencodeBackendUnavailableReason(health, catalog) : cursorBackendUnavailableReason(health, catalog)) || ''
    : ''
  const detail = chatError
    || customAdmissionError
    || cursorUnavailableDetail
    || (!compact ? runtimeDiagnosticCurrentError(diagnostic) : '')
    || diagnostic?.message
    || `${provider} has not been checked yet.`
  const label = !compact && !connected ? t('connections.unavailable')
    : !compact && diagnostic?.installed !== false
      ? tone === 'ready' ? t('connections.signedIn') : diagnostic?.authenticated === false ? t('codexAuth.signedOut') : t('connections.loginUnknown')
      : compact && chatError ? 'Latest chat error' : cursorUnavailable ? 'Unavailable' : runtimeDiagnosticLabel(diagnostic)
  const cursorAction = diagnostic?.action?.trim() || cursorCapability?.action?.trim()
  const action = cursorUnavailable
    ? cursorAction && !cursorUnavailableDetail.includes(cursorAction) ? cursorAction : undefined
    : diagnostic?.action
  return <div className={`runtime-health-row ${tone} ${compact ? 'compact' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={compact ? 15 : 17} />
    <div>
      <strong>{provider} <span>{label}</span></strong>
      <small>{detail}</small>
      {action ? <small className="runtime-action">{action}</small> : null}
      {!compact && tone !== 'ready' && <NativeProviderSignIn key={`${backend}:${profileId}:${profileGeneration}`} backend={backend} disabled={!connected} />}
    </div>
    {compact && codexProvider === 'custom' && <button type="button" className="quiet-button runtime-recheck-button" onClick={() => openAIProviderSettings(backend)}>{t('connections.configure')}</button>}
    {compact && codexProvider !== 'custom' && providerNeedsAttention && onRecheck
      ? <button
          type="button"
          className="quiet-button runtime-recheck-button"
          aria-label={t("ui.RuntimeHealth.RuntimeStatus.recheck_cli_status_a9bc7f2", { "provider": String(provider) })}
          disabled={refreshing}
          onClick={() => void onRecheck()}
        >
          <RefreshCw className={refreshing ? 'spin' : ''} size={12} />{" "}{t("ui.RuntimeHealth.RuntimeStatus.recheck_1f47d83")}</button>
      : null}
    {!compact && diagnostic?.version ? <code>{diagnostic.version}</code> : null}
  </div>
}

function latestChatRunError(events: Event[] | undefined, backend: Backend): string {
  if (!events?.length) return ''
  let latestRunId = ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.backend && event.backend !== backend) continue
    if (event.run_id) {
      latestRunId = event.run_id
      break
    }
    if (isTimelineError(event)) return compactError(event)
  }
  if (!latestRunId) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.run_id !== latestRunId || (event.backend && event.backend !== backend) || !isTimelineError(event)) continue
    return compactError(event)
  }
  return ''
}

function compactError(event: Event): string {
  const text = eventErrorText(event).trim()
  return text.length > 520 ? `${text.slice(0, 520).trim()}…` : text
}
