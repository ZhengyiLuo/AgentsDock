import { t } from '@shared/i18n'
import {
  APP_SHORTCUT_GROUPS,
  shortcutDisplay,
  shortcutIsAvailable,
  shortcutKeycaps,
  shortcutTranslationKey,
  type ShortcutPlatform
} from '@shared/shortcuts'
import { useLocale } from '../lib/i18n'
import { currentShortcutPlatform } from './ShortcutTooltip'

export function KeyboardShortcutsSettings({
  platform = currentShortcutPlatform()
}: {
  platform?: ShortcutPlatform
}) {
  useLocale()

  return <section className="app-settings-section" aria-labelledby="app-settings-shortcuts-title">
    <header><h2 id="app-settings-shortcuts-title">{t('settings.keyboardShortcuts')}</h2></header>
    <div className="app-settings-shortcut-groups">
      {APP_SHORTCUT_GROUPS.map(group => <section
        key={group.id}
        className="app-settings-shortcut-group"
        aria-labelledby={`app-settings-shortcuts-${group.id}`}
      >
        <h3 id={`app-settings-shortcuts-${group.id}`}>{t(`shortcuts.group.${group.id}`)}</h3>
        <ul className="app-settings-list">
          {group.shortcuts.map(shortcut => <li key={shortcut} className="app-settings-row app-settings-shortcut-row">
            <span className="app-settings-row-title">{t(shortcutTranslationKey(shortcut))}</span>
            {shortcutIsAvailable(shortcut, platform)
              ? <span className="app-settings-shortcut-keys">
                  <span className="sr-only">{shortcutDisplay(shortcut, platform)}</span>
                  {shortcutKeycaps(shortcut, platform).map((key, index) => <kbd key={`${key}-${index}`} className="app-settings-shortcut-key" aria-hidden="true">{key}</kbd>)}
                </span>
              : <span className="app-settings-value app-settings-shortcut-unavailable">{t('shortcuts.macOnly')}</span>}
          </li>)}
        </ul>
      </section>)}
    </div>
  </section>
}
