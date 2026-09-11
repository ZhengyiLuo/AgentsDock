// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, CircleAlert, ExternalLink, LoaderCircle, Plus, RadioTower, RefreshCw, Square, X } from 'lucide-react'
import type { ForwardedPort } from '@shared/types'
import type { DetectedTerminalPort } from '../lib/terminal-port-detection'

interface PortsPanelProps {
  profileId: string
  profileGeneration: number
  sessionId: string
  detections: DetectedTerminalPort[]
  refreshToken?: number
  available?: boolean
  unavailableTitle?: string
  unavailableMessage?: string
  unavailableActionLabel?: string
  onUnavailableAction?: () => void
  onDismissDetection: (remotePort: number) => void
  onPortsChange?: (ports: ForwardedPort[]) => void
}

interface ScopedPorts {
  scope: symbol
  values: ForwardedPort[]
  published: boolean
}

const EMPTY_PORTS: ForwardedPort[] = []

export function PortsPanel({
  profileId,
  profileGeneration,
  sessionId,
  detections,
  refreshToken = 0,
  available = true,
  unavailableTitle = 'Port forwarding unavailable',
  unavailableMessage = 'Update AgentsServer to a build with authenticated port forwarding.',
  unavailableActionLabel = 'Open server settings',
  onUnavailableAction,
  onDismissDetection,
  onPortsChange
}: PortsPanelProps) {
  useLocale()
  const scope = useMemo(
    () => Symbol('ports-panel-scope'),
    [available, profileGeneration, profileId, sessionId]
  )
  const activeScopeRef = useRef<symbol | null>(null)
  const listRequestRef = useRef(0)
  const mutationEpochRef = useRef(0)
  const operationRef = useRef(0)
  const operationInFlightScopeRef = useRef<symbol | null>(null)
  const onDismissDetectionRef = useRef(onDismissDetection)
  const portsRef = useRef<ForwardedPort[]>(EMPTY_PORTS)
  const [scopedPorts, setScopedPorts] = useState<ScopedPorts>({ scope, values: EMPTY_PORTS, published: false })
  const [remotePort, setRemotePort] = useState('')
  const [preferredLocalPort, setPreferredLocalPort] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ports = scopedPorts.scope === scope ? scopedPorts.values : EMPTY_PORTS

  useLayoutEffect(() => {
    onDismissDetectionRef.current = onDismissDetection
  }, [onDismissDetection])

  useLayoutEffect(() => {
    activeScopeRef.current = scope
    listRequestRef.current += 1
    mutationEpochRef.current += 1
    operationRef.current += 1
    operationInFlightScopeRef.current = null
    portsRef.current = EMPTY_PORTS
    setScopedPorts({ scope, values: EMPTY_PORTS, published: false })
    setRemotePort('')
    setPreferredLocalPort('')
    setLoading(true)
    setBusy(null)
    setError(null)

    return () => {
      if (activeScopeRef.current === scope) activeScopeRef.current = null
      if (operationInFlightScopeRef.current === scope) operationInFlightScopeRef.current = null
    }
  }, [scope])

  const updatePorts = useCallback((operationScope: symbol, update: (current: ForwardedPort[]) => ForwardedPort[]) => {
    if (activeScopeRef.current !== operationScope) return
    const next = [...update(portsRef.current)].sort((left, right) => left.remotePort - right.remotePort)
    portsRef.current = next
    setScopedPorts(current => {
      if (activeScopeRef.current !== operationScope) return current
      return {
        scope: operationScope,
        values: next,
        published: true
      }
    })
  }, [])

  useEffect(() => {
    if (activeScopeRef.current === scope && scopedPorts.scope === scope && scopedPorts.published) {
      onPortsChange?.(ports)
    }
  }, [onPortsChange, ports, scope, scopedPorts.published, scopedPorts.scope])

  const refresh = useCallback(async (quiet = false) => {
    const operationScope = scope
    if (activeScopeRef.current !== operationScope) return
    if (!available) {
      updatePorts(operationScope, () => EMPTY_PORTS)
      setLoading(false)
      setError(null)
      return
    }
    const request = ++listRequestRef.current
    const mutationEpoch = mutationEpochRef.current
    if (!quiet) setLoading(true)
    try {
      const next = await window.agentsDock.ports.list(profileId, profileGeneration)
      if (
        activeScopeRef.current !== operationScope
        || listRequestRef.current !== request
        || mutationEpochRef.current !== mutationEpoch
      ) return
      updatePorts(operationScope, () => next)
      setError(null)
    } catch (reason) {
      if (activeScopeRef.current === operationScope && listRequestRef.current === request && !quiet) {
        setError(errorText(reason))
      }
    } finally {
      if (activeScopeRef.current === operationScope && listRequestRef.current === request) setLoading(false)
    }
  }, [available, profileGeneration, profileId, scope, sessionId, updatePorts])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshToken])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), 3_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => window.agentsDock.events.on('ports:changed', payload => {
    if (
      !available
      || payload.profileId !== profileId
      || payload.profileGeneration !== profileGeneration
      || activeScopeRef.current !== scope
    ) return
    listRequestRef.current += 1
    mutationEpochRef.current += 1
    updatePorts(scope, () => payload.ports)
    setLoading(false)
    setError(null)
  }), [available, profileGeneration, profileId, scope, updatePorts])

  const start = async (nextRemotePort: number, nextPreferredLocalPort?: number) => {
    const operationScope = scope
    if (
      !available
      || activeScopeRef.current !== operationScope
      || operationInFlightScopeRef.current !== null
    ) return
    operationInFlightScopeRef.current = operationScope
    const operation = `start:${nextRemotePort}`
    const operationSequence = ++operationRef.current
    const mutationEpoch = ++mutationEpochRef.current
    setBusy(operation)
    setError(null)
    try {
      const started = await window.agentsDock.ports.start(
        profileId,
        profileGeneration,
        sessionId,
        nextRemotePort,
        nextPreferredLocalPort
      )
      if (activeScopeRef.current !== operationScope) return
      if (mutationEpochRef.current !== mutationEpoch) {
        if (portsRef.current.some(port => port.remotePort === started.remotePort)) {
          onDismissDetectionRef.current(nextRemotePort)
          if (operationRef.current === operationSequence) {
            setRemotePort('')
            setPreferredLocalPort('')
          }
        }
        return
      }
      mutationEpochRef.current += 1
      updatePorts(operationScope, current => [
        ...current.filter(port => port.remotePort !== started.remotePort),
        started
      ])
      onDismissDetectionRef.current(nextRemotePort)
      if (operationRef.current === operationSequence) {
        setRemotePort('')
        setPreferredLocalPort('')
      }
    } catch (reason) {
      if (
        activeScopeRef.current === operationScope
        && operationRef.current === operationSequence
        && (
          mutationEpochRef.current === mutationEpoch
          || !portsRef.current.some(port => port.remotePort === nextRemotePort)
        )
      ) {
        mutationEpochRef.current += 1
        setError(errorText(reason))
      }
    } finally {
      if (operationInFlightScopeRef.current === operationScope) operationInFlightScopeRef.current = null
      if (activeScopeRef.current === operationScope && operationRef.current === operationSequence) setBusy(null)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsedRemote = parsePort(remotePort)
    const parsedLocal = preferredLocalPort.trim() ? parsePort(preferredLocalPort) : undefined
    if (!parsedRemote) {
      setError(t("ui.PortsPanel.submit.enter_a_remote_port_between_1024_and_65535_1f64339"))
      return
    }
    if (preferredLocalPort.trim() && !parsedLocal) {
      setError(t("ui.PortsPanel.submit.enter_a_preferred_local_port_between_1024__732eb91"))
      return
    }
    void start(parsedRemote, parsedLocal)
  }

  const stop = async (port: ForwardedPort) => {
    const operationScope = scope
    if (activeScopeRef.current !== operationScope || operationInFlightScopeRef.current !== null) return
    operationInFlightScopeRef.current = operationScope
    const operation = `stop:${port.remotePort}`
    const operationSequence = ++operationRef.current
    const mutationEpoch = ++mutationEpochRef.current
    setBusy(operation)
    setError(null)
    try {
      await window.agentsDock.ports.stop(profileId, profileGeneration, port.remotePort)
      if (activeScopeRef.current !== operationScope) return
      if (mutationEpochRef.current !== mutationEpoch) return
      mutationEpochRef.current += 1
      updatePorts(operationScope, current => current.filter(candidate => candidate.remotePort !== port.remotePort))
    } catch (reason) {
      if (
        activeScopeRef.current === operationScope
        && operationRef.current === operationSequence
        && mutationEpochRef.current === mutationEpoch
      ) {
        mutationEpochRef.current += 1
        setError(errorText(reason))
      }
    } finally {
      if (operationInFlightScopeRef.current === operationScope) operationInFlightScopeRef.current = null
      if (activeScopeRef.current === operationScope && operationRef.current === operationSequence) setBusy(null)
    }
  }

  const open = async (port: ForwardedPort) => {
    const operationScope = scope
    if (activeScopeRef.current !== operationScope || operationInFlightScopeRef.current !== null) return
    operationInFlightScopeRef.current = operationScope
    const operation = `open:${port.remotePort}`
    const operationSequence = ++operationRef.current
    setBusy(operation)
    setError(null)
    try {
      await window.agentsDock.ports.open(profileId, profileGeneration, port.remotePort)
    } catch (reason) {
      if (activeScopeRef.current === operationScope && operationRef.current === operationSequence) {
        setError(errorText(reason))
      }
    } finally {
      if (operationInFlightScopeRef.current === operationScope) operationInFlightScopeRef.current = null
      if (activeScopeRef.current === operationScope && operationRef.current === operationSequence) setBusy(null)
    }
  }

  const activeRemotePorts = useMemo(() => new Set(ports.map(port => port.remotePort)), [ports])
  const availableDetections = detections.filter(detection => !activeRemotePorts.has(detection.remotePort))

  return <section className="ports-panel" aria-label={t("ui.PortsPanel.PortsPanel.forwarded_ports_e8c4ae9")}>
    <div className="ports-panel-scroll">
      <header className="ports-panel-header">
        <div className="ports-panel-title">
          <span className="ports-panel-icon"><RadioTower size={18} /></span>
          <div>
            <h2>{t("ui.PortsPanel.PortsPanel.forwarded_ports_e8c4ae9")}</h2>
            <p>{t("ui.PortsPanel.PortsPanel.shared_across_chats_on_this_server_availab_90c6356")}</p>
          </div>
        </div>
        <button type="button" className="ports-refresh" aria-label={t("ui.PortsPanel.PortsPanel.refresh_forwarded_ports_45696cc")} disabled={loading || !available} onClick={() => void refresh()}>
          <RefreshCw className={loading ? 'spin' : ''} size={14} />{" "}{t("ui.PortsPanel.PortsPanel.refresh_0e91610")}</button>
      </header>

      {!available && <section className="ports-unavailable" role="status">
        <span className="ports-unavailable-icon"><CircleAlert size={19} /></span>
        <div><strong>{unavailableTitle}</strong><p>{unavailableMessage}</p><span>{t("ui.PortsPanel.PortsPanel.the_terminal_remains_available_no_listener_9058046")}</span></div>
        {onUnavailableAction && <button type="button" className="primary-button" onClick={onUnavailableAction}>{unavailableActionLabel}</button>}
      </section>}

      {available && <><form className="ports-add-form" onSubmit={submit}>
        <label>
          <span>{t("ui.PortsPanel.PortsPanel.remote_port_57d6b8b")}</span>
          <input
            inputMode="numeric"
            aria-label={t("ui.PortsPanel.PortsPanel.remote_port_57d6b8b")}
            placeholder="7007"
            value={remotePort}
            onChange={event => setRemotePort(event.target.value)}
          />
        </label>
        <ArrowRight className="ports-form-arrow" size={15} />
        <label>
          <span>{t("ui.PortsPanel.PortsPanel.local_port_9bc348a")}{" "}<small>{t("ui.PortsPanel.PortsPanel.optional_ec91fdd")}</small></span>
          <input
            inputMode="numeric"
            aria-label={t("ui.PortsPanel.PortsPanel.preferred_local_port_76ddcdc")}
            placeholder={t("ui.PortsPanel.PortsPanel.automatic_d461a49")}
            value={preferredLocalPort}
            onChange={event => setPreferredLocalPort(event.target.value)}
          />
        </label>
        <button type="submit" className="primary-button ports-forward-button" disabled={busy != null}>
          {busy?.startsWith('start:') ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{" "}{t("ui.PortsPanel.PortsPanel.forward_f1c65e1")}</button>
      </form>

      {error && <div className="ports-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" aria-label={t("ui.PortsPanel.PortsPanel.dismiss_port_error_6ae33e0")} onClick={() => setError(null)}><X size={13} /></button></div>}

      {availableDetections.length > 0 && <section className="ports-detected" aria-labelledby="ports-detected-title">
        <div className="ports-section-heading">
          <div><strong id="ports-detected-title">{t("ui.PortsPanel.PortsPanel.detected_in_terminal_64cabf2")}</strong><span>{t("ui.PortsPanel.PortsPanel.forward_only_the_services_you_recognize_bfd72b9")}</span></div>
        </div>
        <div className="ports-detection-list">
          {availableDetections.map(detection => <article key={detection.remotePort} className="ports-detection-card">
            <span className="ports-detection-signal"><RadioTower size={15} /></span>
            <div className="ports-detection-copy">
              <strong>{detection.label}</strong>
              <code>{detection.url}</code>
            </div>
            <button
              type="button"
              className="quiet-button"
              disabled={busy != null}
              onClick={() => void start(detection.remotePort)}
            >{busy === `start:${detection.remotePort}` ? <LoaderCircle className="spin" size={13} /> : <RadioTower size={13} />}{" "}{t("ui.PortsPanel.forward_f1c65e1")}</button>
            <button type="button" className="ports-dismiss-detection" aria-label={t("ui.PortsPanel.dismiss_port_suggestion_0558b3a", { "port": String(detection.remotePort) })} onClick={() => onDismissDetection(detection.remotePort)}><X size={14} /></button>
          </article>)}
        </div>
      </section>}

      <section className="ports-current" aria-labelledby="ports-current-title">
        <div className="ports-section-heading">
          <div><strong id="ports-current-title">{t("ui.PortsPanel.PortsPanel.active_forwards_873f44f")}</strong><span>{ports.length ? `${ports.length} ${ports.length === 1 ? 'service' : 'services'} available locally` : t("ui.PortsPanel.PortsPanel.no_active_forwards_a0ed8a0")}</span></div>
        </div>
        {loading && !ports.length ? <div className="ports-empty"><LoaderCircle className="spin" size={18} /><span>{t("ui.PortsPanel.PortsPanel.checking_forwarded_ports_cf327bb")}</span></div>
          : ports.length ? <div className="ports-table" role="table" aria-label={t("ui.PortsPanel.PortsPanel.active_forwarded_ports_70a8f3d")}>
            <div className="ports-table-head" role="row">
              <span role="columnheader">{t("ui.PortsPanel.PortsPanel.remote_ffa98e0")}</span><span role="columnheader">{t("ui.PortsPanel.PortsPanel.local_address_8e0cf9d")}</span><span role="columnheader">{t("ui.PortsPanel.PortsPanel.status_920e413")}</span><span role="columnheader" className="sr-only">{t("ui.PortsPanel.PortsPanel.actions_ff8059d")}</span>
            </div>
            {ports.map(port => <div className="ports-row" role="row" key={port.remotePort}>
              <div className="ports-cell ports-remote" role="cell" data-label="Remote"><code>{port.remotePort}</code></div>
              <div className="ports-cell ports-local" role="cell" data-label="Local address">
                {port.localUrl ? <button type="button" title={`Open ${port.localUrl}`} disabled={port.state !== 'open' || busy != null} onClick={() => void open(port)}>{port.localUrl}<ExternalLink size={12} /></button> : <span>{t("ui.PortsPanel.assigning_local_port_c46f68d")}</span>}
              </div>
              <div className="ports-cell" role="cell" data-label="Status"><PortStatus port={port} /></div>
              <div className="ports-row-actions" role="cell">
                <button type="button" className="quiet-button" disabled={port.state !== 'open' || busy != null} onClick={() => void open(port)}><ExternalLink size={13} />{" "}{t("ui.PortsPanel.open_ed077f3")}</button>
                <button type="button" className="ports-stop-button" disabled={busy != null} onClick={() => void stop(port)}>{busy === `stop:${port.remotePort}` ? <LoaderCircle className="spin" size={13} /> : <Square size={11} />}{" "}{t("ui.PortsPanel.stop_cae7d57")}</button>
              </div>
              {port.error && <div className="ports-row-error" role="cell">{port.error}</div>}
            </div>)}
          </div> : <div className="ports-empty">
            <span className="ports-empty-icon"><RadioTower size={19} /></span>
            <div><strong>{t("ui.PortsPanel.PortsPanel.nothing_forwarded_yet_e10b13b")}</strong><span>{t("ui.PortsPanel.PortsPanel.enter_a_remote_port_above_or_start_a_local_e24b80f")}</span></div>
          </div>}
      </section></>}
    </div>
  </section>
}

function PortStatus({ port }: { port: ForwardedPort }) {
  useLocale()
  const label = port.state === 'open' ? 'Forwarding' : port.state === 'starting' ? 'Starting' : 'Needs attention'
  return <span className={`ports-status ${port.state}`}><i />{label}</span>
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535 ? port : undefined
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
