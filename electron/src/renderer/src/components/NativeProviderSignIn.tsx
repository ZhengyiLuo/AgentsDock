import { t } from '@shared/i18n'
import type { Backend } from '@shared/types'
import { useLocale } from '../lib/i18n'
import './ProviderConnectionSettings.css'

// Fixed commands only. Never execute a remote diagnostic's action string on
// the desktop: the selected AgentsServer may be on a different computer.
const LOGIN = {
  codex: ['codex login', 'https://developers.openai.com/codex'],
  claude: ['claude auth login', 'https://code.claude.com/docs'],
  cursor: ['agent login', 'https://cursor.com/docs'],
  opencode: ['opencode auth login', 'https://opencode.ai/docs'],
} as const

export function NativeProviderSignIn({ backend, disabled = false }: { backend: Backend; disabled?: boolean }) {
  useLocale()
  const [command, docs] = LOGIN[backend]
  if (disabled) return null
  return <small className="native-provider-signin">{t('connections.cliSignIn')} <code>{command}</code>.{' '}
    <a href={docs} onClick={event => { event.preventDefault(); void window.agentsDock.native.openExternal(docs) }}>{t('connections.readMore')}</a>
  </small>
}
