import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodexProviderTestResult, CodexServerSettingsScope } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { CodexModelDiscovery } from './CodexModelDiscovery'

/** Explicit, optional check of the saved credentials; never tests a settings draft. */
export function CodexModelCompatibilityCheck({ scope, credentialId }: {
  scope: CodexServerSettingsScope
  credentialId?: string
}) {
  const fieldId = useId()
  const models = useAppStore(state => state.runtimeCatalog?.backends.codex?.custom_provider?.models)
  const supported = useAppStore(state => state.health?.capabilities?.codex_provider_v1?.model_compatibility === true)
  const [model, setModel] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CodexProviderTestResult | null>(null)
  const [error, setError] = useState<'checkUpdate' | 'checkUnverified' | null>(null)
  const requestRef = useRef(0)
  const revisionRef = useRef(0)
  useEffect(() => () => { requestRef.current += 1 }, [])

  async function check() {
    if (checking || !model.trim() || !supported) return
    const request = ++requestRef.current
    const revision = revisionRef.current
    setChecking(true)
    setResult(null)
    setError(null)
    try {
      const test = window.agentsDock.codex?.testProviderModel
      if (typeof test !== 'function') { setError('checkUpdate'); return }
      const next = await test(scope, { model: model.trim(), ...(credentialId ? { credential_id: credentialId } : {}) })
      if (request !== requestRef.current || revision !== revisionRef.current) return
      setResult(next)
    } catch (reason) {
      if (request !== requestRef.current || revision !== revisionRef.current) return
      setError(/CODEX_PROVIDER_UPDATE/.test(String(reason)) ? 'checkUpdate' : 'checkUnverified')
    } finally {
      if (request === requestRef.current) setChecking(false)
    }
  }

  const compatibility = result?.compatibility ?? 'unverified'
  return <div className="codex-auth-model-check">
    <label htmlFor={fieldId}>{t('codexProvider.checkModel')}</label>
    <input id={fieldId} value={model} list={`${fieldId}-models`} maxLength={256} autoComplete="off" spellCheck={false}
      aria-describedby={`${fieldId}-help`} onChange={event => {
        setModel(event.target.value); revisionRef.current += 1; setResult(null); setError(null)
      }} />
    <datalist id={`${fieldId}-models`}>{models?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
    <small id={`${fieldId}-help`}>{t('codexProvider.checkHelp')}</small>
    <div className="codex-auth-settings-actions">
      <button type="button" className="quiet-button" disabled={!supported || checking || !model.trim()} onClick={() => { void check() }}>
        {checking && <LoaderCircle className="spin" size={14} />}{t(checking ? 'codexProvider.checking' : 'codexProvider.check')}
      </button>
      <CodexModelDiscovery />
    </div>
    {!supported && <small>{t('codexProvider.checkUpdate')}</small>}
    {result && <small role="status">{t(`codexProvider.compatibility.${compatibility}`)} · {t(`codexProvider.checkResult.${result.status}`)}</small>}
    {result?.ok && result.summary_check && result.summary_check !== 'not_checked'
      && <small>{t(`codexProvider.summaryCheck.${result.summary_check}`)}</small>}
    {error && <small role="alert" className="codex-auth-settings-error">{t(`codexProvider.${error}`)}</small>}
  </div>
}
