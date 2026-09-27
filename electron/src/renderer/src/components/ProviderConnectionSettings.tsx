import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, KeyRound } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodexServerSettingsScope } from '@shared/types'
import type { ConnectionAction, ConnectionBackend, ConnectionProtocol, ConnectionResult, ProviderConnectionConfiguration } from '@shared/provider-connections'
import { useLocale } from '../lib/i18n'
import './CodexAuthSettings.css'
import './ProviderConnectionSettings.css'
import { useAppStore } from '../store/app-store'

type Props = { connected: boolean; profileId: string | null; profileGeneration: number; onStatus?: (value: boolean) => void }
type Failure = ConnectionResult | 'update' | 'admin' | 'stale' | 'invalid' | 'failed'
function failure(reason: unknown): Failure {
  const code = reason instanceof Error ? reason.message : ''
  for (const suffix of ['UPDATE', 'ADMIN', 'STALE', 'INVALID'] as const) {
    if (code.includes(`PROVIDER_CONNECTION_${suffix}`)) return suffix.toLowerCase() as Failure
  }
  return 'failed'
}

export function ProviderConnectionSettings({ backend, ...props }: Props & { backend: ConnectionBackend }) {
  useLocale()
  const id = useId()
  const [saved, setSaved] = useState<ProviderConnectionConfiguration | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<Failure | null>(null)
  const [reload, setReload] = useState(0)
  const [confirmForget, setConfirmForget] = useState(false)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState<ConnectionProtocol>('anthropic')
  const [authHeader, setAuthHeader] = useState<'bearer' | 'x-api-key'>('bearer')
  const [hasKey, setHasKey] = useState(false)
  const key = useRef<HTMLInputElement | null>(null)
  const serial = useRef(0)
  const scopeRef = useRef(props)
  scopeRef.current = props
  const attachKey = useCallback((input: HTMLInputElement | null) => {
    if (key.current && key.current !== input) key.current.value = ''
    key.current = input
  }, [])
  function clearKey() { if (key.current) key.current.value = ''; setHasKey(false) }
  function owns(n: number, scope: CodexServerSettingsScope) {
    return serial.current === n && scopeRef.current.connected && scopeRef.current.profileId === scope.profileId
      && scopeRef.current.profileGeneration === scope.profileGeneration
  }
  useEffect(() => {
    const n = ++serial.current
    clearKey(); setSaved(null); setOpen(false); setError(null); setConfirmForget(false)
    setBaseURL(''); setModel(''); setBusy(false)
    if (!props.connected || !props.profileId) return
    const scope = { profileId: props.profileId, profileGeneration: props.profileGeneration }
    const request = window.agentsDock.providerConnections?.request
    if (!request) { setError('update'); return }
    setBusy(true)
    void request(scope, backend, 'get').then(reply => {
      if (owns(n, scope)) setSaved(reply.configuration ?? null)
    }).catch(reason => { if (owns(n, scope)) setError(failure(reason)) })
      .finally(() => { if (owns(n, scope)) setBusy(false) })
    return () => { serial.current++; if (key.current) key.current.value = '' }
  }, [backend, props.connected, props.profileId, props.profileGeneration, reload])

  function configure() {
    clearKey(); setError(null); setConfirmForget(false)
    setBaseURL(saved?.base_url ?? (backend === 'claude' ? 'https://openrouter.ai/api' : 'https://openrouter.ai/api/v1'))
    setModel(saved?.model ?? '')
    setProtocol(saved?.protocol ?? (backend === 'claude' ? 'anthropic' : 'chat_completions'))
    setAuthHeader(saved?.auth_header ?? 'bearer'); setOpen(true)
  }
  async function operate(action: Exclude<ConnectionAction, 'get'>) {
    if (busy || !saved || !props.connected || !props.profileId) return
    const request = window.agentsDock.providerConnections?.request
    if (!request) { setError('update'); return }
    const n = ++serial.current
    const scope = { profileId: props.profileId, profileGeneration: props.profileGeneration }
    setBusy(true); setError(null); setConfirmForget(false)
    const input = action === 'save' ? { base_url: baseURL, model: model.trim() || null, protocol, auth_header: authHeader,
      api_key: key.current?.value ?? '', expected_revision: saved.revision } : { expected_revision: saved.revision }
    try {
      const reply = await request(scope, backend, action, input)
      if (!owns(n, scope)) return
      if (reply.configuration) setSaved(reply.configuration)
      if (reply.ok === false) setError(reply.status ?? 'failed')
      else setOpen(false)
      if (reply.configuration && window.agentsDock.runtime?.catalog) {
        void window.agentsDock.runtime.catalog(false).then(runtimeCatalog => {
          if (owns(n, scope)) useAppStore.setState({ runtimeCatalog })
        }).catch(() => undefined)
      }
    } catch (reason) { if (owns(n, scope)) setError(failure(reason)) }
    finally {
      if ('api_key' in input) input.api_key = ''
      if (owns(n, scope)) { clearKey(); setBusy(false) }
    }
  }
  const name = backend === 'claude' ? 'Claude Code' : 'OpenCode'
  const editable = props.connected && Boolean(props.profileId) && Boolean(saved) && !busy
  const verified = props.connected && !busy && !open && !error && saved?.configured === true && saved?.last_result === 'verified'
  useEffect(() => { props.onStatus?.(verified) }, [verified, props.onStatus])
  const unavailable = !props.connected || !saved || Boolean(error)
  return <section className={`codex-auth-settings provider-connection ${verified ? 'connection-connected' : 'connection-unconfirmed'}`} aria-label={`${name} custom endpoint`}>
    <div className="codex-auth-settings-icon">{verified ? <CheckCircle2 size={18} /> : <KeyRound size={16} />}</div>
    <div className="codex-auth-settings-copy">
      <div className="codex-auth-settings-heading">
        <div><strong>{t('connections.customAPI')}</strong>{saved?.scope === 'settings_only' && <small>{t('connections.settingsOnly')}</small>}</div>
        {!open && <button type="button" className={verified ? 'quiet-button' : 'primary-button'} disabled={!editable} onClick={configure}>{t('connections.configure')}</button>}
      </div>
      <small className={verified ? 'provider-connection-verified' : ''} role="status">
        {verified && <CheckCircle2 size={14} aria-hidden="true" />}
        {busy ? t('connections.working') : verified ? t('connections.verified')
          : open ? t('connections.draft') : unavailable ? t('connections.unavailable') : saved?.configured ? t('connections.saved') : t('connections.empty')}
      </small>
      {saved?.checked_at && !open && <small>{t('connections.checkedAt', { time: new Date(saved.checked_at).toLocaleString() })}</small>}
      {error && <small role="alert" className={error === 'update' ? '' : 'codex-auth-settings-error'}>{t(`connections.error.${error}`)}</small>}
      {!error && !open && saved?.last_result && saved.last_result !== 'verified' && <small role="alert" className="codex-auth-settings-error">{t(`connections.error.${saved.last_result}`)}</small>}
      {!open && saved?.configured && <>
        <small>{saved.base_url}{saved.model ? ` · ${saved.model}` : ''}</small>
        <div className="codex-auth-settings-actions">
          <button type="button" className="quiet-button" disabled={!editable} onClick={() => void operate('check')}>{t('connections.check')}</button>
          <button type="button" className="quiet-button" disabled={!editable} onClick={() => confirmForget ? void operate('forget') : setConfirmForget(true)}>{t(confirmForget ? 'connections.confirmForget' : 'connections.forget')}</button>
          {confirmForget && <button type="button" className="quiet-button" onClick={() => setConfirmForget(false)}>{t('connections.cancel')}</button>}
        </div>
        {confirmForget && <small>{t('connections.forgetHelp')}</small>}
      </>}
      {!open && error && <button type="button" className="quiet-button provider-connection-refresh" disabled={busy || !props.connected} onClick={() => setReload(n => n + 1)}>{t('connections.refresh')}</button>}
      {open && <form className="codex-auth-settings-form" onSubmit={event => { event.preventDefault(); void operate('save') }}>
        <label htmlFor={`${id}-url`}>{t('connections.baseURL')}</label>
        <input id={`${id}-url`} value={baseURL} maxLength={2048} disabled={busy} onChange={e => {
          setBaseURL(e.target.value)
          if (backend === 'claude') {
            try { setAuthHeader(new URL(e.target.value).hostname === 'api.anthropic.com' ? 'x-api-key' : 'bearer') } catch { /* incomplete URL */ }
          }
        }} autoComplete="off" spellCheck={false} />
        <label htmlFor={`${id}-key`}>{t('connections.key')}</label>
        <input id={`${id}-key`} type="password" ref={attachKey} maxLength={4096} disabled={busy} onChange={e => setHasKey(Boolean(e.target.value.trim()))} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        <details className="provider-connection-advanced"><summary>{t('connections.advanced')}</summary>
        {backend === 'opencode' && <><label htmlFor={`${id}-protocol`}>{t('connections.protocol')}</label>
          <select id={`${id}-protocol`} value={protocol} disabled={busy} onChange={e => { setProtocol(e.target.value as ConnectionProtocol); setAuthHeader('bearer') }}>
            <option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option>
          </select></>}
        {protocol === 'anthropic' && <><label htmlFor={`${id}-auth`}>{t('connections.authHeader')}</label>
          <select id={`${id}-auth`} value={authHeader} disabled={busy} onChange={e => setAuthHeader(e.target.value as 'bearer' | 'x-api-key')}>
            <option value="bearer">Bearer (OpenRouter)</option><option value="x-api-key">x-api-key (Anthropic)</option>
          </select></>}
        <label htmlFor={`${id}-model`}>{t('connections.model')}</label>
        <input id={`${id}-model`} value={model} maxLength={256} disabled={busy} onChange={e => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
        <small>{t('connections.modelHelp')}</small>
        {model.trim() && <small>{t('connections.cost')}</small>}
        </details>
        <div className="codex-auth-settings-actions">
          <button type="submit" className="primary-button" disabled={!editable || !hasKey || !baseURL.trim()}>{t('connections.save')}</button>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => { clearKey(); setOpen(false); setError(null) }}>{t('connections.cancel')}</button>
        </div>
      </form>}
    </div>
  </section>
}

export function EndpointSetupHelp() {
  useLocale()
  return <details className="app-settings-provider-context">
    <summary>{t('connections.startTitle')}</summary><p>{t('connections.startHelp')}</p>
    <button type="button" className="quiet-button" onClick={() => void window.agentsDock.native.openExternal('https://openrouter.ai/settings/keys')}>{t('connections.openRouter')}</button>
  </details>
}

export function CursorEndpointNotice() {
  useLocale()
  return <section className="codex-auth-settings connection-unconfirmed" aria-label="Cursor custom endpoint">
    <div className="codex-auth-settings-icon"><KeyRound size={16} /></div>
    <div className="codex-auth-settings-copy"><strong>{t('connections.title', { provider: 'Cursor' })}</strong>
      <small role="status">{t('connections.unsupported')}</small><small>{t('connections.cursorHelp')}</small>
      <a href="https://cursor.com/docs" onClick={event => { event.preventDefault(); void window.agentsDock.native.openExternal('https://cursor.com/docs') }}>{t('connections.readMore')}</a>
    </div>
  </section>
}
