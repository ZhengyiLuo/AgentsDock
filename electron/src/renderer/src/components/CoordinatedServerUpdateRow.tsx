import { useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { AppUpdateStatus, CoordinatedServerUpdate } from '@shared/types'
import { t } from '../lib/i18n'
import { useAppStore } from '../store/app-store'

function updateDescription(server: CoordinatedServerUpdate): string {
  const raw = server.message.trim()
  if (/\b429\b|too many requests|temporarily limited update requests/i.test(raw)) {
    if (/temporarily limited update requests/i.test(raw) && /try again in \d+ seconds/i.test(raw)) return raw
    return t('coordinatedUpdate.busyHelp')
  }
  if (/channel.*(?:differs|preserv|conflict)|cannot change.*channel/i.test(raw)) return t('coordinatedUpdate.channelHelp')
  if (/signed server release descriptor is invalid|paired server release signature is invalid/i.test(raw)) return t('coordinatedUpdate.verificationHelp')
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|sign in|access token/i.test(raw)) return t('coordinatedUpdate.authHelp', { name: server.name })
  if (/previous server update could not be safely finalized/i.test(raw)) return t('coordinatedUpdate.previousUpdateHelp', { name: server.name })
  if (/\bENOSPC\b|no space left on device/i.test(raw)) return t('coordinatedUpdate.diskHelp')
  if (/\b(?:EACCES|EPERM)\b|permission denied/i.test(raw)) return t('coordinatedUpdate.permissionHelp')
  if (server.phase === 'offline') return t('coordinatedUpdate.offlineHelp', { name: server.name })
  // Keep concrete server explanations visible. Only protocol wrappers and a
  // multiline stack trace belong in the optional diagnostic disclosure.
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  const explanation = raw.startsWith('Traceback')
    ? [...lines].reverse().find(line => /^(?:\w*Error|\w*Exception):/.test(line)) || lines[0]
    : lines[0]
  return explanation?.replace(/^(?:Error:\s*|HTTP(?: Error)? \d{3}:\s*)/, '')
    || t('coordinatedUpdate.missingStatus', { name: server.name })
}

export function CoordinatedServerUpdateRow({ server, currentVersion, onUpdate }: {
  server: CoordinatedServerUpdate
  currentVersion?: string | null
  onUpdate: (status: AppUpdateStatus) => void
}) {
  const [retrying, setRetrying] = useState(false)
  const retryInFlight = useRef(false)
  const needsRetry = server.paused || ['failed', 'blocked', 'offline'].includes(server.phase)
  const busy = retrying || (!server.paused && ['checking', 'updating'].includes(server.phase))
  const description = updateDescription(server)

  const retry = async () => {
    if (retryInFlight.current) return
    retryInFlight.current = true
    setRetrying(true)
    try {
      onUpdate(await window.agentsDock.updates.retryServers(server.profileId))
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      retryInFlight.current = false
      setRetrying(false)
    }
  }

  return <div className="app-settings-row coordinated-server-update-row">
    <div className="app-settings-row-copy">
      <strong>{server.name}</strong>
      <span role="status" aria-live="polite">{description}</span>
      {needsRetry && server.message && server.message !== description && <details className="coordinated-update-details">
        <summary>{t('coordinatedUpdate.details')}</summary>
        <p>{server.message}</p>
      </details>}
    </div>
    <div className="app-settings-actions">
      {currentVersion && <span className="app-settings-value">AgentsServer {currentVersion}</span>}
      <span className="app-settings-value">{busy && <LoaderCircle className="spin" size={13} />}{t(`coordinatedUpdate.${server.phase}`)}</span>
      {needsRetry && <button type="button" className="quiet-button" disabled={retrying} onClick={() => void retry()}>
        {retrying ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{t('coordinatedUpdate.retry')}
      </button>}
    </div>
  </div>
}
