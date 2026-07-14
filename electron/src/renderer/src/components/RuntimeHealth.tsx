import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from 'lucide-react'
import type { Backend } from '@shared/types'
import {
  runtimeDiagnosticFor,
  runtimeDiagnosticLabel,
  runtimeDiagnosticNeedsAttention,
  runtimeDiagnosticTone,
} from '@shared/runtime-catalog'
import { useState } from 'react'
import { useAppStore } from '../store/app-store'

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
  const diagnostic = runtimeDiagnosticFor(health, catalog, backend)
  const tone = runtimeDiagnosticTone(diagnostic)
  const Icon = tone === 'ready' ? CheckCircle2 : tone === 'error' ? XCircle : tone === 'warning' ? AlertTriangle : CircleHelp
  const provider = backend === 'claude' ? 'Claude Code' : 'Codex'
  const detail = diagnostic?.last_error || diagnostic?.message || `${provider} has not been checked yet.`
  return <div className={`runtime-health-row ${tone} ${compact ? 'compact' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={compact ? 15 : 17} />
    <div>
      <strong>{provider} <span>{runtimeDiagnosticLabel(diagnostic)}</span></strong>
      <small>{detail}</small>
      {!compact && diagnostic?.action ? <small className="runtime-action">{diagnostic.action}</small> : null}
    </div>
    {!compact && diagnostic?.version ? <code>{diagnostic.version}</code> : null}
  </div>
}
