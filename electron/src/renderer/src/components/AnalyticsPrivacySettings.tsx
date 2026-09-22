import { useEffect, useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import { ExternalLink } from 'lucide-react'
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  ANALYTICS_PRIVACY_POLICY_URL,
  getAnalyticsConsentDecision,
  setAnalyticsConsent
} from '../lib/analytics'
import { t, useLocale } from '../lib/i18n'

function openPrivacyPolicy(): void {
  void window.agentsDock.native.openExternal(ANALYTICS_PRIVACY_POLICY_URL).catch(() => undefined)
}

export function AnalyticsPrivacySettings() {
  useLocale()
  const [enabled, setEnabled] = useState(() => getAnalyticsConsentDecision() === 'granted')

  useEffect(() => {
    const changed = (event: Event) => {
      setEnabled((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled === true)
    }
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, changed)
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, changed)
  }, [])

  return <div className="app-settings-row">
    <div className="app-settings-row-copy">
      <strong>{t('settings.usageAnalytics')}</strong>
      <span>{t('settings.usageAnalyticsDescription')}</span>
      <button type="button" className="privacy-policy-link" onClick={openPrivacyPolicy}>
        {t('settings.privacyPolicy')} <ExternalLink size={11} />
      </button>
    </div>
    <Switch.Root
      className="settings-switch"
      checked={enabled}
      aria-label={t('settings.shareUsageAnalytics')}
      onCheckedChange={setAnalyticsConsent}
    >
      <Switch.Thumb className="settings-switch-thumb" />
    </Switch.Root>
  </div>
}
