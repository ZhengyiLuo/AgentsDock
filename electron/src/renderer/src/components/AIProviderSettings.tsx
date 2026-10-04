import { useEffect, useRef, useState } from 'react'
import { trackEvent } from '../lib/analytics'
import { CheckCircle2, Circle, ChevronRight, RefreshCw, KeyRound } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Backend } from '@shared/types'
import type { CLIAccountBackend, CLIAccountMetadata } from '@shared/provider-connections'
import { nativeProviderConnected } from '@shared/runtime-catalog'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { CodexAuthSettings } from './CodexAuthSettings'
import { useRuntimeRecheck } from './RuntimeHealth'
import { NativeProviderSignIn } from './NativeProviderSignIn'
import { ProviderConnectionSettings } from './ProviderConnectionSettings'

function CLIAccountCard({ backend, signedIn, open }: { backend: CLIAccountBackend; signedIn: boolean; open: boolean }) {
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [account, setAccount] = useState<CLIAccountMetadata | null>(null)
  useEffect(() => {
    let cancelled = false
    setAccount(null)
    if (!open || !signedIn || !connected || !profileId) return
    const read = window.agentsDock.providerAccounts?.read
    if (read) void read({ profileId, profileGeneration }, backend).then(value => {
      if (!cancelled) setAccount(value)
    }).catch(() => { /* Optional display metadata must not invalidate working credentials. */ })
    return () => { cancelled = true }
  }, [open, signedIn, connected, profileId, profileGeneration, backend])
  return <section className={`codex-auth-settings cli-account-card ${signedIn ? 'connection-connected' : 'connection-unconfirmed'}`} aria-label={t('connections.nativeAccountLabel', { provider: { claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode' }[backend] })}>
    <span className="codex-auth-settings-icon">{signedIn ? <CheckCircle2 size={18} /> : <KeyRound size={17} />}</span>
    <div className="codex-auth-settings-copy">
      <div className="codex-auth-settings-heading"><strong>{t('connections.nativeLogin')}</strong></div>
      <small role="status">{t(signedIn ? 'connections.nativeDetected' : 'connections.notSignedIn')}</small>
      {signedIn && account?.email && <small>{t('connections.email')}: {account.email}</small>}
      {signedIn && account?.plan_type && <small>{t('connections.plan')}: {account.plan_type}</small>}
      {signedIn && account?.source === 'local_profile' && <small>{t('connections.cachedProfile')}</small>}
      {!signedIn && <NativeProviderSignIn backend={backend} disabled={!connected} />}
    </div>
  </section>
}

function ProviderGroup({ backend, requested }: { backend: Backend; requested?: { backend?: Backend } }) {
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const native = useAppStore(state => state.connected && nativeProviderConnected(state.health, state.runtimeCatalog, backend))
  const [api, setAPI] = useState(false)
  const [codexNative, setCodexNative] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (requested?.backend === backend) setOpen(true) }, [requested, backend])
  const signedIn = backend === 'codex' ? codexNative || native : native
  const ready = connected && (signedIn || api)
  const name = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode' }[backend]
  return <details open={open} className={`provider-group ${ready ? 'is-connected' : ''}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={16} className="provider-group-chevron" /><strong>{name}</strong>
      <span className="provider-group-status">{ready ? <CheckCircle2 size={17} /> : <Circle size={17} />}{t(ready ? 'connections.connected' : 'connections.empty')}</span>
    </summary>
    <div className="provider-group-body">
      {backend === 'codex' ? <CodexAuthSettings expanded={open} connected={connected} profileId={profileId} profileGeneration={profileGeneration} onAPIStatus={setAPI} onNativeStatus={setCodexNative} /> : <>
        <CLIAccountCard backend={backend} signedIn={signedIn} open={open} />
        <ProviderConnectionSettings expanded={open} backend={backend} connected={connected} profileId={profileId} profileGeneration={profileGeneration} onStatus={setAPI} />
      </>}
    </div>
  </details>
}

export function AIProviderSettings({ requested }: { requested?: { backend?: Backend } } = {}) {
  useLocale()
  const tracked = useRef(false)
  useEffect(() => {
    if (!tracked.current) { tracked.current = true; trackEvent('provider_settings_opened') }
  }, [])
  const profile = useAppStore(state => state.profiles.find(item => item.id === state.activeProfileId))
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const { refreshing, recheck } = useRuntimeRecheck()
  const [revision, setRevision] = useState(0)
  return <div className="app-settings-provider-page">
    <div className="app-settings-provider-context">
      <strong>{profile ? t('settings.providersServer', { server: profile.name }) : t('settings.providersNoServer')}</strong>
      <button type="button" className="quiet-button" disabled={!connected || refreshing} onClick={() => void recheck().then(() => setRevision(value => value + 1))}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />{t('connections.refresh')}</button>
    </div>
    {(['codex', 'claude', 'cursor', 'opencode'] as Backend[]).map(backend => <ProviderGroup key={`${profile?.id}:${generation}:${revision}:${backend}`} backend={backend} requested={requested} />)}
  </div>
}
