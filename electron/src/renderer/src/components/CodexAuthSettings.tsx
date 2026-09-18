import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { KeyRound, LoaderCircle, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodexAuthStatus, CodexServerSettingsScope } from '@shared/types'
import { useLocale } from '../lib/i18n'
import './CodexAuthSettings.css'

type AuthFailure = 'admin' | 'update' | 'busy' | 'invalidKey' | 'connection' | 'failed' | 'readFailed'

function authFailure(reason: unknown, fallback: 'failed' | 'readFailed' = 'failed'): AuthFailure {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/CODEX_AUTH_ADMIN|\b(?:401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return 'admin'
  if (/CODEX_AUTH_UPDATE|\b(?:404|405|501)\b|not found|not implemented|method not allowed/i.test(message)) return 'update'
  if (/CODEX_AUTH_BUSY|\b409\b/i.test(message)) return 'busy'
  if (/CODEX_AUTH_INVALID_KEY/i.test(message)) return 'invalidKey'
  if (/CODEX_AUTH_CONNECTION/i.test(message)) return 'connection'
  return fallback
}

export function CodexAuthSettings({ connected, profileId, profileGeneration, serverTitle }: {
  connected: boolean
  profileId: string | null
  profileGeneration: number
  serverTitle?: string
}) {
  useLocale()
  const fieldId = useId()
  const [status, setStatus] = useState<CodexAuthStatus | null>(null)
  const [statusScope, setStatusScope] = useState<CodexServerSettingsScope | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<AuthFailure | null>(null)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const requestRef = useRef(0)
  const scopeRef = useRef({ connected, profileId, profileGeneration })
  scopeRef.current = { connected, profileId, profileGeneration }
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  // Keep credentials out of React state and clear even a detached input when the
  // form, selected server, or settings dialog closes.
  const attachKeyInput = useCallback((input: HTMLInputElement | null) => {
    if (keyInputRef.current && keyInputRef.current !== input) keyInputRef.current.value = ''
    keyInputRef.current = input
  }, [])

  function clearKey() {
    if (keyInputRef.current) keyInputRef.current.value = ''
    setHasKey(false)
  }

  function ownsRequest(request: number, scope: CodexServerSettingsScope) {
    return request === requestRef.current && scopeRef.current.connected
      && scopeRef.current.profileId === scope.profileId
      && scopeRef.current.profileGeneration === scope.profileGeneration
  }

  useEffect(() => {
    const request = ++requestRef.current
    clearKey()
    setStatus(null)
    setStatusScope(null)
    setFormOpen(false)
    setError(null)
    setSaved(false)
    setSaving(false)
    const read = window.agentsDock.codex?.auth
    setLoading(connected && Boolean(profileId) && typeof read === 'function')
    if (connected && profileId) {
      const scope = { profileId, profileGeneration }
      if (typeof read !== 'function') setError('update')
      else void read(scope).then(next => {
        if (!ownsRequest(request, scope)) return
        setStatus(next)
        setStatusScope(scope)
      }).catch(reason => {
        if (ownsRequest(request, scope)) setError(authFailure(reason, 'readFailed'))
      }).finally(() => {
        if (ownsRequest(request, scope)) setLoading(false)
      })
    }
    return () => { requestRef.current += 1 }
  }, [connected, profileId, profileGeneration, reload])

  const scopeMatches = statusScope?.profileId === profileId && statusScope?.profileGeneration === profileGeneration
  const currentStatus = connected && scopeMatches ? status : null
  const unavailable = error === 'admin' || error === 'update'
  const editable = connected && profileId != null && scopeMatches && currentStatus?.available === true
    && !unavailable && !loading && !saving
  const showForm = formOpen && connected && scopeMatches && !unavailable

  async function signIn() {
    if (!editable || !profileId || !keyInputRef.current?.value.trim()) return
    const scope = { profileId, profileGeneration }
    const request = ++requestRef.current
    let apiKey = keyInputRef.current.value.trim()
    clearKey()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const login = window.agentsDock.codex?.loginWithApiKey
      if (typeof login !== 'function') {
        setError('update')
        return
      }
      const pending = login(scope, apiKey)
      apiKey = ''
      const next = await pending
      if (!ownsRequest(request, scope)) return
      setStatus(next)
      setStatusScope(scope)
      if (next.available && next.auth_mode === 'apiKey') {
        setSaved(true)
        setFormOpen(false)
      } else setError('failed')
    } catch (reason) {
      if (ownsRequest(request, scope)) setError(authFailure(reason))
    } finally {
      apiKey = ''
      if (ownsRequest(request, scope)) setSaving(false)
    }
  }

  const account = currentStatus?.auth_mode === 'apiKey' ? t('codexAuth.apiKey')
    : currentStatus?.auth_mode === 'chatgpt' ? [t('codexAuth.chatgpt'), currentStatus.email, currentStatus.plan_type].filter(Boolean).join(' · ')
      : currentStatus?.auth_mode === 'other' ? t('codexAuth.other')
        : currentStatus?.requires_openai_auth === false ? t('codexAuth.notRequired') : t('codexAuth.signedOut')

  return <section className="codex-auth-settings" aria-label={t('codexAuth.title')} aria-busy={loading || saving}>
    <span className="codex-auth-settings-icon"><KeyRound size={17} /></span>
    <div className="codex-auth-settings-copy">
      <div className="codex-auth-settings-heading">
        <div><strong>{t('codexAuth.title')}</strong>{serverTitle && <small>{serverTitle}</small>}</div>
        <div className="codex-auth-settings-actions">
          {!showForm && <button type="button" className="quiet-button" disabled={!editable} onClick={() => {
            clearKey(); setError(null); setSaved(false); setFormOpen(true)
          }}>{t('codexAuth.useKey')}</button>}
          <button type="button" className="quiet-button" disabled={!connected || !profileId || loading || saving}
            onClick={() => setReload(value => value + 1)}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t('codexAuth.recheck')}
          </button>
        </div>
      </div>
      <small>{!connected || !profileId ? t('codexAuth.connect') : loading ? t('codexAuth.loading')
        : currentStatus?.available === false ? t('codexAuth.nativeRequired') : currentStatus ? account : t('codexAuth.unknown')}</small>
      {showForm && <form className="codex-auth-settings-form" onSubmit={event => { event.preventDefault(); void signIn() }}>
        <small id={`${fieldId}-scope`}>{t('codexAuth.replaces')}</small>
        <small id={`${fieldId}-billing`}>{t('codexAuth.billing')}</small>
        <small id={`${fieldId}-storage`}>{t('codexAuth.storage')}</small>
        <label htmlFor={fieldId}>{t('codexAuth.keyLabel')}</label>
        <input ref={attachKeyInput} id={fieldId} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off"
          spellCheck={false} autoFocus maxLength={4096} disabled={!editable} data-1p-ignore data-lpignore="true"
          aria-describedby={`${fieldId}-scope ${fieldId}-billing ${fieldId}-storage`}
          onChange={event => { setHasKey(Boolean(event.currentTarget.value.trim())); setError(null); setSaved(false) }} />
        <div className="codex-auth-settings-actions">
          <button type="submit" className="primary-button" disabled={!editable || !hasKey}>
            {saving && <LoaderCircle className="spin" size={14} />}{t(saving ? 'codexAuth.saving' : 'codexAuth.signIn')}
          </button>
          <button type="button" className="quiet-button" disabled={saving} onClick={() => {
            clearKey(); setFormOpen(false); setError(null)
          }}>{t('codexAuth.cancel')}</button>
        </div>
      </form>}
      {error && <small className="codex-auth-settings-error" role="alert">{t(`codexAuth.${error}`)}</small>}
      {saved && scopeMatches && <small role="status">{t('codexAuth.saved')}</small>}
    </div>
  </section>
}
