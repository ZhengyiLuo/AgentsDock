import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { CodexAuthSettings } from './CodexAuthSettings'
import { RuntimeHealthPanel } from './RuntimeHealth'

// This page only organizes existing controls. Authentication, endpoint storage,
// explicit checks and request ownership stay in their original components.
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
    <RuntimeHealthPanel />
    <p className="app-settings-provider-help">{t('settings.providersCustomHelp')}</p>
    <CodexAuthSettings connected={connected} profileId={profileId} profileGeneration={profileGeneration} serverTitle={profile?.name} />
  </div>
}
