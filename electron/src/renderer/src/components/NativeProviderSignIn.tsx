import { useState } from 'react'
import { t } from '@shared/i18n'
import type { Backend } from '@shared/types'
import { useLocale } from '../lib/i18n'
import './ProviderConnectionSettings.css'

// Fixed commands only. Never execute a remote diagnostic's action string on
// the desktop: the selected AgentsServer may be on a different computer.
const LOGIN = {
  codex: ['codex login', 'https://developers.openai.com/codex/auth'],
  claude: ['claude auth login', 'https://code.claude.com/docs/en/authentication'],
  cursor: ['agent login', 'https://cursor.com/docs/cli/reference/authentication'],
  opencode: ['opencode auth login', 'https://opencode.ai/docs/cli/#auth'],
} as const

export function NativeProviderSignIn({ backend, disabled = false }: { backend: Backend; disabled?: boolean }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [command, docs] = LOGIN[backend]
  return <div className="native-provider-signin">
    <button type="button" className="quiet-button" disabled={disabled} aria-expanded={open}
      onClick={() => { setOpen(value => !value); setCopied(false); setCopyFailed(false) }}>{t('connections.signIn')}</button>
    {open && !disabled && <div className="native-provider-signin-help">
      <small>{t('connections.signInHelp')}</small>
      <code>{command}</code>
      <div className="codex-auth-settings-actions">
        <button type="button" className="quiet-button" onClick={() => {
          setCopied(false); setCopyFailed(false)
          void window.agentsDock.native.writeClipboard(command).then(() => setCopied(true)).catch(() => setCopyFailed(true))
        }}>{t(copied ? 'connections.copied' : 'connections.copyLogin')}</button>
        <button type="button" className="quiet-button" onClick={() => void window.agentsDock.native.openExternal(docs)}>{t('connections.loginGuide')}</button>
      </div>
      {copyFailed && <small role="alert">{t('connections.copyFailed')}</small>}
      <small>{t(backend === 'claude' ? 'connections.claudeLoginCheck' : 'connections.loginCheck')}</small>
    </div>}
  </div>
}
