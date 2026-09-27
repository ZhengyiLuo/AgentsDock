import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { CodexAuthSettings } from './CodexAuthSettings'
import { RuntimeHealthPanel } from './RuntimeHealth'
import { CursorEndpointNotice, EndpointSetupHelp, ProviderConnectionSettings } from './ProviderConnectionSettings'

// Native runtime status and API checks are separate. New connection profiles
// are settings-only: they never change a session's provider or credentials.
export function AIProviderSettings() {
  useLocale()
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const profile = useAppStore(state => state.profiles.find(item => item.id === state.activeProfileId))

  return <div className="app-settings-provider-page">
    <div className="app-settings-provider-context">
      <strong>{profile ? t('settings.providersServer', { server: profile.name }) : t('settings.providersNoServer')}</strong>
      <p>{t('settings.providersScope')}</p>
    </div>
    <CodexAuthSettings connected={connected} profileId={profileId} profileGeneration={profileGeneration} serverTitle={profile?.name} />
    <ProviderConnectionSettings backend="claude" connected={connected} profileId={profileId} profileGeneration={profileGeneration} />
    <ProviderConnectionSettings backend="opencode" connected={connected} profileId={profileId} profileGeneration={profileGeneration} />
    <CursorEndpointNotice />
    <RuntimeHealthPanel />
    <EndpointSetupHelp />
  </div>
}
