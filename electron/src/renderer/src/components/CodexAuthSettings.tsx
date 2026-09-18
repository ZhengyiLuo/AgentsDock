import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { KeyRound, LoaderCircle, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodexAuthStatus, CodexProviderConfiguration, CodexProviderTestResult, CodexServerSettingsScope } from '@shared/types'
import { useLocale } from '../lib/i18n'
import './CodexAuthSettings.css'

type AuthFailure = 'admin' | 'update' | 'busy' | 'invalidKey' | 'connection' | 'failed' | 'readFailed'
type ProviderFailure = 'providerAdmin' | 'providerUpdate' | 'providerBusy' | 'providerInvalid' | 'providerConnection' | 'providerFailed'

function providerFailure(reason: unknown): ProviderFailure {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/CODEX_PROVIDER_ADMIN/.test(message)) return 'providerAdmin'
  if (/CODEX_PROVIDER_UPDATE/.test(message)) return 'providerUpdate'
  if (/CODEX_PROVIDER_BUSY/.test(message)) return 'providerBusy'
  if (/CODEX_PROVIDER_INVALID/.test(message)) return 'providerInvalid'
  if (/CODEX_PROVIDER_CONNECTION/.test(message)) return 'providerConnection'
  return 'providerFailed'
}

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
  const [authReadFailed, setAuthReadFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const [customEndpoint, setCustomEndpoint] = useState(false)
  const [provider, setProvider] = useState<CodexProviderConfiguration | null>(null)
  const [providerScope, setProviderScope] = useState<CodexServerSettingsScope | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerReadFailed, setProviderReadFailed] = useState(false)
  const [providerError, setProviderError] = useState<ProviderFailure | null>(null)
  const [providerNotice, setProviderNotice] = useState<'providerSaved' | 'providerReset' | null>(null)
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; status: CodexProviderTestResult['status']; revision: number } | null>(null)
  const providerRequestRef = useRef(0)
  const testRequestRef = useRef(0)
  const draftRevisionRef = useRef(0)
  const requestRef = useRef(0)
  const scopeRef = useRef({ connected, profileId, profileGeneration })
  scopeRef.current = { connected, profileId, profileGeneration }
  const keyInputRef = useRef<HTMLInputElement | null>(null)
  const endpointInputRef = useRef<HTMLInputElement | null>(null)

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
    return request === requestRef.current && ownsScope(scope)
  }

  function ownsScope(scope: CodexServerSettingsScope) {
    return scopeRef.current.connected
      && scopeRef.current.profileId === scope.profileId
      && scopeRef.current.profileGeneration === scope.profileGeneration
  }

  function invalidateTest() {
    testRequestRef.current += 1
    draftRevisionRef.current += 1
    setTesting(false)
    setTestResult(null)
    setProviderError(null)
    setProviderNotice(null)
  }

  useEffect(() => {
    const request = ++requestRef.current
    clearKey()
    setStatus(null)
    setStatusScope(null)
    setFormOpen(false)
    setError(null)
    setAuthReadFailed(false)
    setSaved(false)
    setSaving(false)
    setCustomEndpoint(false)
    setProvider(null)
    setProviderScope(null)
    setProviderLoading(false)
    setProviderReadFailed(false)
    setProviderNotice(null)
    providerRequestRef.current += 1
    invalidateTest()
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
        if (ownsRequest(request, scope)) {
          const failure = authFailure(reason, 'readFailed')
          setError(failure)
          setAuthReadFailed(failure === 'readFailed')
          setStatusScope(scope)
        }
      }).finally(() => {
        if (ownsRequest(request, scope)) setLoading(false)
      })
    }
    return () => {
      requestRef.current += 1
      providerRequestRef.current += 1
      testRequestRef.current += 1
    }
  }, [connected, profileId, profileGeneration, reload])

  useEffect(() => {
    if (formOpen && !providerLoading) {
      if (customEndpoint) endpointInputRef.current?.focus()
      else keyInputRef.current?.focus()
    }
  }, [formOpen, providerLoading, customEndpoint])

  const scopeMatches = statusScope?.profileId === profileId && statusScope?.profileGeneration === profileGeneration
  const currentStatus = connected && scopeMatches ? status : null
  const unavailable = error === 'admin' || error === 'update'
  const editable = connected && profileId != null && scopeMatches && currentStatus?.available === true
    && !unavailable && !loading && !saving
  const canOpenSettings = connected && profileId != null && scopeMatches && !unavailable && !loading && !saving
    && (currentStatus?.available === true || authReadFailed)
  const showForm = formOpen && connected && scopeMatches && !unavailable
  const providerScopeMatches = providerScope?.profileId === profileId && providerScope?.profileGeneration === profileGeneration
  const currentProvider = connected && providerScopeMatches ? provider : null
  const providerEditable = connected && profileId != null && providerScopeMatches && currentProvider?.available === true
    && !loading && !saving && !providerLoading && !providerReadFailed
    && providerError !== 'providerAdmin' && providerError !== 'providerUpdate'
  const defaultEditable = editable && !providerLoading && !providerReadFailed && (!providerError || providerError === 'providerUpdate')
  const canResetProvider = !testing && (providerEditable && currentProvider?.configured || canOpenSettings && !providerLoading && providerReadFailed)
  const providerDraftComplete = Boolean(baseURL.trim() && model.trim() && hasKey)
  const tested = testResult?.ok === true && testResult.status === 'ready' && testResult.revision === draftRevisionRef.current

  async function loadProviderConfiguration(forceCustom: boolean) {
    if (!canOpenSettings || !profileId) return
    clearKey()
    invalidateTest()
    setError(null)
    setSaved(false)
    setCustomEndpoint(forceCustom)
    setProviderLoading(true)
    setProviderReadFailed(false)
    const scope = { profileId, profileGeneration }
    const request = ++providerRequestRef.current
    try {
      const read = window.agentsDock.codex?.provider
      if (typeof read !== 'function') { setProviderError('providerUpdate'); return }
      const next = await read(scope)
      if (request !== providerRequestRef.current || !ownsScope(scope)) return
      setProvider(next)
      setProviderScope(scope)
      setCustomEndpoint(forceCustom)
      setBaseURL(next.base_url ?? 'https://api.openai.com/v1')
      setModel(next.model ?? '')
    } catch (reason) {
      if (request === providerRequestRef.current && ownsScope(scope)) {
        const failure = providerFailure(reason)
        setProviderError(failure)
        setProviderReadFailed(failure === 'providerFailed')
      }
    } finally {
      if (request === providerRequestRef.current && ownsScope(scope)) setProviderLoading(false)
    }
  }

  function openCustomEndpoint() {
    if (!canOpenSettings) return
    clearKey()
    invalidateTest()
    setError(null)
    setSaved(false)
    if (currentProvider) setCustomEndpoint(true)
    else void loadProviderConfiguration(true)
  }

  async function testConnection() {
    if (!providerEditable || !providerDraftComplete || testing || !profileId || !keyInputRef.current) return
    const scope = { profileId, profileGeneration }
    const request = ++testRequestRef.current
    const revision = draftRevisionRef.current
    let apiKey = keyInputRef.current.value.trim()
    setTesting(true)
    setTestResult(null)
    setProviderError(null)
    try {
      const test = window.agentsDock.codex?.testProvider
      if (typeof test !== 'function') { setProviderError('providerUpdate'); return }
      const pending = test(scope, { base_url: baseURL.trim(), model: model.trim(), api_key: apiKey })
      apiKey = ''
      const next = await pending
      if (request !== testRequestRef.current || !ownsScope(scope) || revision !== draftRevisionRef.current) return
      // Provider messages may echo credentials. Render only our fixed catalog.
      setTestResult({ ok: next.ok, status: next.status, revision })
    } catch (reason) {
      if (request === testRequestRef.current && ownsScope(scope)) setProviderError(providerFailure(reason))
    } finally {
      apiKey = ''
      if (request === testRequestRef.current && ownsScope(scope)) setTesting(false)
    }
  }

  async function saveProvider() {
    if (!providerEditable || !providerDraftComplete || !tested || testing || !profileId || !keyInputRef.current) return
    const scope = { profileId, profileGeneration }
    const request = ++providerRequestRef.current
    let apiKey = keyInputRef.current.value.trim()
    clearKey()
    invalidateTest()
    setSaving(true)
    try {
      const save = window.agentsDock.codex?.setProvider
      if (typeof save !== 'function') { setProviderError('providerUpdate'); return }
      const pending = save(scope, { base_url: baseURL.trim(), model: model.trim(), api_key: apiKey })
      apiKey = ''
      const next = await pending
      if (request !== providerRequestRef.current || !ownsScope(scope)) return
      setProvider(next)
      setProviderScope(scope)
      if (!next.configured) { setProviderError('providerFailed'); return }
      setProviderNotice('providerSaved')
      setFormOpen(false)
      setCustomEndpoint(false)
    } catch (reason) {
      if (request === providerRequestRef.current && ownsScope(scope)) setProviderError(providerFailure(reason))
    } finally {
      apiKey = ''
      if (request === providerRequestRef.current && ownsScope(scope)) setSaving(false)
    }
  }

  async function resetProvider() {
    if (!canResetProvider || !profileId) return
    const scope = { profileId, profileGeneration }
    const request = ++providerRequestRef.current
    clearKey()
    invalidateTest()
    setSaving(true)
    try {
      const reset = window.agentsDock.codex?.resetProvider
      if (typeof reset !== 'function') { setProviderError('providerUpdate'); return }
      const next = await reset(scope)
      if (request !== providerRequestRef.current || !ownsScope(scope)) return
      setProvider(next)
      setProviderScope(scope)
      if (next.configured) { setProviderError('providerFailed'); return }
      setProviderReadFailed(false)
      setProviderNotice('providerReset')
      setCustomEndpoint(false)
      setFormOpen(false)
    } catch (reason) {
      if (request === providerRequestRef.current && ownsScope(scope)) setProviderError(providerFailure(reason))
    } finally {
      if (request === providerRequestRef.current && ownsScope(scope)) setSaving(false)
    }
  }

  function cancelForm() {
    clearKey()
    invalidateTest()
    providerRequestRef.current += 1
    setProviderLoading(false)
    setProviderReadFailed(false)
    setFormOpen(false)
    setCustomEndpoint(false)
    setError(null)
  }

  async function signIn() {
    if (!defaultEditable || !profileId || !keyInputRef.current?.value.trim()) return
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

  return <section className="codex-auth-settings" aria-label={t('codexAuth.title')} aria-busy={loading || saving || providerLoading || testing}>
    <span className="codex-auth-settings-icon"><KeyRound size={17} /></span>
    <div className="codex-auth-settings-copy">
      <div className="codex-auth-settings-heading">
        <div><strong>{t('codexAuth.title')}</strong>{serverTitle && <small>{serverTitle}</small>}</div>
        <div className="codex-auth-settings-actions">
          {!showForm && <button type="button" className="quiet-button" disabled={!canOpenSettings} onClick={() => {
            clearKey(); setError(null); setSaved(false); setProviderNotice(null); setFormOpen(true); void loadProviderConfiguration(authReadFailed)
          }}>{t(authReadFailed ? 'codexAuth.endpointSettings' : 'codexAuth.useKey')}</button>}
          {!showForm && !authReadFailed && <button type="button" className="quiet-button" disabled={!canOpenSettings} onClick={() => {
            setProviderNotice(null); setFormOpen(true); void loadProviderConfiguration(true)
          }}>{t('codexAuth.customEndpoint')}</button>}
          <button type="button" className="quiet-button" disabled={!connected || !profileId || loading || saving}
            onClick={() => setReload(value => value + 1)}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t('codexAuth.recheck')}
          </button>
        </div>
      </div>
      <small>{!connected || !profileId ? t('codexAuth.connect') : loading ? t('codexAuth.loading')
        : currentStatus?.available === false ? t('codexAuth.nativeRequired') : currentStatus ? account : t('codexAuth.unknown')}</small>
      {currentProvider?.configured && <small>{t('codexAuth.customAccount', { model: currentProvider.model ?? '' })}</small>}
      {showForm && <form className="codex-auth-settings-form" onSubmit={event => { event.preventDefault(); void (customEndpoint ? saveProvider() : signIn()) }}>
        <small id={`${fieldId}-scope`} title={customEndpoint ? t('codexAuth.providerScope') : undefined}>{t(customEndpoint ? 'codexAuth.providerSummary' : 'codexAuth.replaces')}</small>
        {!customEndpoint && <>
          <small id={`${fieldId}-billing`}>{t('codexAuth.billing')}</small>
          <small id={`${fieldId}-storage`}>{t('codexAuth.storage')}</small>
        </>}
        {providerLoading && <small>{t('codexAuth.providerLoading')}</small>}
        {!customEndpoint && <button type="button" className="quiet-button codex-auth-custom-toggle" disabled={!canOpenSettings || providerLoading}
          onClick={() => { void openCustomEndpoint() }}>{t('codexAuth.customEndpoint')}</button>}
        {customEndpoint && <div className="codex-auth-endpoint-fields">
          <strong>{t('codexAuth.customEndpoint')}</strong>
          {currentProvider?.available === false && <small>{t('codexAuth.nativeRequired')}</small>}
          <label htmlFor={`${fieldId}-endpoint`}>{t('codexAuth.baseURL')}</label>
          <input ref={endpointInputRef} id={`${fieldId}-endpoint`} type="url" value={baseURL} disabled={!providerEditable} autoComplete="off" spellCheck={false}
            onChange={event => { setBaseURL(event.currentTarget.value); invalidateTest() }} />
          <label htmlFor={`${fieldId}-model`}>{t('codexAuth.model')}</label>
          <input id={`${fieldId}-model`} type="text" value={model} disabled={!providerEditable} autoComplete="off" spellCheck={false}
            onChange={event => { setModel(event.currentTarget.value); invalidateTest() }} />
        </div>}
        <label htmlFor={fieldId}>{t(customEndpoint ? 'codexAuth.providerKey' : 'codexAuth.keyLabel')}</label>
        <input ref={attachKeyInput} id={fieldId} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off"
          spellCheck={false} autoFocus maxLength={4096} disabled={customEndpoint ? !providerEditable : !defaultEditable} data-1p-ignore data-lpignore="true"
          title={customEndpoint ? t('codexAuth.freshKey') : undefined}
          aria-describedby={customEndpoint ? `${fieldId}-scope ${fieldId}-test-help` : `${fieldId}-scope ${fieldId}-billing ${fieldId}-storage`}
          onChange={event => { setHasKey(Boolean(event.currentTarget.value.trim())); setError(null); setSaved(false); invalidateTest() }} />
        {customEndpoint && <small id={`${fieldId}-test-help`} title={t('codexAuth.providerStorage')}>{t('codexAuth.testHelp')}</small>}
        <div className="codex-auth-settings-actions">
          {customEndpoint && <button type="button" className="quiet-button" disabled={!providerEditable || !providerDraftComplete || testing}
            onClick={() => { void testConnection() }}>{testing && <LoaderCircle className="spin" size={14} />}{t(testing ? 'codexAuth.testing' : 'codexAuth.test')}</button>}
          <button type="submit" className="primary-button" disabled={customEndpoint ? !providerEditable || !providerDraftComplete || !tested || testing : !defaultEditable || !hasKey}>
            {saving && <LoaderCircle className="spin" size={14} />}{t(customEndpoint ? saving ? 'codexAuth.providerSaving' : 'codexAuth.providerSave' : saving ? 'codexAuth.saving' : 'codexAuth.signIn')}
          </button>
          <button type="button" className="quiet-button" disabled={saving} onClick={cancelForm}>{t('codexAuth.cancel')}</button>
        </div>
        {(customEndpoint && currentProvider?.configured || providerReadFailed) && <div className="codex-auth-provider-reset">
          <button type="button" className="quiet-button" disabled={!canResetProvider} title={t('codexAuth.providerResetHelp')}
            onClick={() => { void resetProvider() }}>{t('codexAuth.providerResetAction')}</button>
        </div>}
        {customEndpoint && testResult && <small role={tested ? 'status' : 'alert'} className={tested ? undefined : 'codex-auth-settings-error'}>
          {t(`codexAuth.testResult.${testResult.ok && testResult.status === 'ready' ? 'ready' : testResult.status === 'ready' ? 'failed' : testResult.status}`)}
        </small>}
      </form>}
      {error && <small className="codex-auth-settings-error" role="alert">{t(`codexAuth.${error}`)}</small>}
      {providerError && <small className="codex-auth-settings-error" role="alert">{t(`codexAuth.${providerError}`)}</small>}
      {saved && scopeMatches && <small role="status">{t('codexAuth.saved')}</small>}
      {providerNotice && providerScopeMatches && <small role="status">{t(`codexAuth.${providerNotice}`)}</small>}
    </div>
  </section>
}
