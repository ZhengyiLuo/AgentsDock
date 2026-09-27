import { useState } from 'react'
import { CheckCircle2, Circle, ChevronRight, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Backend } from '@shared/types'
import { nativeProviderConnected } from '@shared/runtime-catalog'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { CodexAuthSettings } from './CodexAuthSettings'
import { useRuntimeRecheck } from './RuntimeHealth'
import { NativeProviderSignIn } from './NativeProviderSignIn'
import { CursorEndpointNotice, ProviderConnectionSettings } from './ProviderConnectionSettings'

function ProviderGroup({ backend }: { backend: Backend }) {
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const native = useAppStore(state => state.connected && nativeProviderConnected(state.health, state.runtimeCatalog, backend))
  const [api, setAPI] = useState(false)
  const [codexNative, setCodexNative] = useState(false)
  const signedIn = backend === 'codex' ? codexNative || native : native
  const ready = connected && (signedIn || api)
  const name = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode' }[backend]
  return <details className={`provider-group ${ready ? 'is-connected' : ''}`}>
    <summary><ChevronRight size={16} className="provider-group-chevron" /><strong>{name}</strong>
      <span className="provider-group-status">{ready ? <CheckCircle2 size={17} /> : <Circle size={17} />}{t(ready ? 'connections.connected' : 'connections.empty')}</span>
    </summary>
    <div className="provider-group-body">
      {backend === 'codex' ? <CodexAuthSettings connected={connected} profileId={profileId} profileGeneration={profileGeneration} onAPIStatus={setAPI} onNativeStatus={setCodexNative} /> : <>
        <div className={`provider-native-status ${signedIn ? 'is-connected' : ''}`}>
          <strong>{t('connections.nativeLogin')}</strong><span>{signedIn ? <CheckCircle2 size={15} /> : <Circle size={15} />}{t(signedIn ? 'connections.nativeDetected' : 'connections.notSignedIn')}</span>
          {!signedIn && <NativeProviderSignIn backend={backend} disabled={!connected} />}
        </div>
        {backend === 'cursor' ? <CursorEndpointNotice /> : <ProviderConnectionSettings backend={backend} connected={connected} profileId={profileId} profileGeneration={profileGeneration} onStatus={setAPI} />}
      </>}
    </div>
  </details>
}

export function AIProviderSettings() {
  useLocale()
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
    {(['codex', 'claude', 'cursor', 'opencode'] as Backend[]).map(backend => <ProviderGroup key={`${profile?.id}:${generation}:${revision}:${backend}`} backend={backend} />)}
  </div>
}
