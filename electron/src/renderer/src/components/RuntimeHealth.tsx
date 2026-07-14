import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from 'lucide-react'
import type { Backend, Event } from '@shared/types'
import {
  runtimeDiagnosticFor,
  runtimeDiagnosticLabel,
  runtimeDiagnosticNeedsAttention,
  runtimeDiagnosticTone,
} from '@shared/runtime-catalog'
import { useState } from 'react'
import { useAppStore } from '../store/app-store'
import { eventErrorText, isTimelineError } from '../lib/timeline'

export function RuntimeHealthNotice({ backend }: { backend: Backend }) {
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const diagnostic = runtimeDiagnosticFor(health, catalog, backend)
  if (!runtimeDiagnosticNeedsAttention(diagnostic)) return null
  return <RuntimeStatus backend={backend} compact />
}

export function RuntimeHealthPanel() {
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try {
      await window.agentsDock.runtime.catalog(true)
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }
  return <section className="runtime-health-panel">
    <header>
      <div><strong>Agent runtimes</strong><small>Server connectivity and provider readiness are checked separately.</small></div>
      <button type="button" className="quiet-button" disabled={refreshing} onClick={() => void refresh()}>
        <RefreshCw className={refreshing ? 'spin' : ''} size={13} /> Refresh
      </button>
    </header>
    <div className="runtime-health-list">
      <RuntimeStatus backend="claude" />
      <RuntimeStatus backend="codex" />
    </div>
  </section>
}

function RuntimeStatus({ backend, compact = false }: { backend: Backend; compact?: boolean }) {
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const selectedSnapshot = useAppStore(state => selectedSessionId ? state.snapshots[selectedSessionId] : null)
  const diagnostic = runtimeDiagnosticFor(health, catalog, backend)
  const tone = runtimeDiagnosticTone(diagnostic)
  const Icon = tone === 'ready' ? CheckCircle2 : tone === 'error' ? XCircle : tone === 'warning' ? AlertTriangle : CircleHelp
  const provider = backend === 'claude' ? 'Claude Code' : 'Codex'
  const chatError = latestChatError(selectedSnapshot?.events, backend)
  const detail = compact && chatError ? chatError : diagnostic?.last_error || diagnostic?.message || `${provider} has not been checked yet.`
  const label = compact && chatError ? 'Latest chat error' : runtimeDiagnosticLabel(diagnostic)
  return <div className={`runtime-health-row ${tone} ${compact ? 'compact' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={compact ? 15 : 17} />
    <div>
      <strong>{provider} <span>{label}</span></strong>
      <small>{detail}</small>
      {!compact && diagnostic?.action ? <small className="runtime-action">{diagnostic.action}</small> : null}
    </div>
    {!compact && diagnostic?.version ? <code>{diagnostic.version}</code> : null}
  </div>
}

function latestChatError(events: Event[] | undefined, backend: Backend): string {
  if (!events?.length) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.backend && event.backend !== backend) continue
    if (!isTimelineError(event)) continue
    const text = eventErrorText(event).trim()
    if (text) return text.length > 520 ? `${text.slice(0, 520).trim()}…` : text
  }
  return ''
}
