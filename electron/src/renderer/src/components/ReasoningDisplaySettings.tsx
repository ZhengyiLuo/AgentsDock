import { t } from '@shared/i18n'
import * as Switch from '@radix-ui/react-switch'
import { useLocale } from '../lib/i18n'
import { setReasoningDisplay, useReasoningDisplay } from '../lib/reasoning-display'

export function ReasoningDisplaySettings() {
  useLocale()
  const display = useReasoningDisplay()
  return <label className="app-settings-row">
    <div className="app-settings-row-copy"><strong>{t('settings.reasoningDisplay')}</strong><span id="reasoning-display-help">{t('settings.reasoningDisplayHelp')}</span></div>
    <Switch.Root className="settings-switch" aria-label={t('settings.reasoningDisplay')} aria-describedby="reasoning-display-help" checked={display === 'expanded'} onCheckedChange={checked => setReasoningDisplay(checked ? 'expanded' : 'compact')}><Switch.Thumb className="settings-switch-thumb" /></Switch.Root>
  </label>
}
