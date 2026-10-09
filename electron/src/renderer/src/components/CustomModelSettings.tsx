import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CustomModelBackend, CustomModels } from '@shared/custom-models'
import { useAppStore } from '../store/app-store'
import { trackOperation } from '../lib/analytics'
import { endpointModelReference } from '../lib/endpoint-model-reference'

/** Discovery/default changes do not run inference; pending setup adds an explicit check. */
export function CustomModelSettings({ backend, active, onSaved, verifyOnSelect = false, baseURL }: {
  backend: CustomModelBackend; active: boolean; onSaved: () => void; verifyOnSelect?: boolean; baseURL?: string | null
}) {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const [catalog, setCatalog] = useState<CustomModels | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [manual, setManual] = useState(false)
  const [manualModel, setManualModel] = useState('')
  const serial = useRef(0)
  const id = useId()
  useEffect(() => {
    const request = ++serial.current
    setCatalog(null); setSelected(''); setFailed(false); setLoading(false); setSaving(false); setManual(false); setManualModel('')
    if (!active || !connected || !profileId) return
    const api = window.agentsDock.customModels
    if (!api) { setFailed(true); return }
    setLoading(true)
    void api.read({ profileId, profileGeneration }, backend).then(value => {
      if (serial.current !== request) return
      setCatalog(value); setSelected(value.default_model ?? '')
    }).catch(() => { if (serial.current === request) setFailed(true) })
      .finally(() => { if (serial.current === request) setLoading(false) })
    return () => { serial.current++ }
  }, [active, connected, profileId, profileGeneration, backend, reload])
  async function save(model: string) {
    if (!catalog || !profileId || !connected || loading || saving || !window.agentsDock.customModels || (verifyOnSelect && !model)) return
    const verifier = window.agentsDock.providerConnections
    if (verifyOnSelect && !verifier) { setFailed(true); return }
    const request = ++serial.current
    setSelected(model); setSaving(true); setFailed(false)
    try {
      const result = await trackOperation('provider_default_model_saved', () => window.agentsDock.customModels!.save({ profileId, profileGeneration }, backend,
        { model: model || null, expected_revision: catalog.revision }))
      if (serial.current !== request) return
      setCatalog({ ...catalog, ...result })
      if (verifyOnSelect && verifier && (backend === 'claude' || backend === 'opencode')) {
        await verifier.request({ profileId, profileGeneration }, backend, 'check', { expected_revision: Number(result.revision) })
        if (serial.current !== request) return
      }
      onSaved()
    } catch { if (serial.current === request) { setSelected(catalog.default_model ?? ''); setFailed(true) } }
    finally { if (serial.current === request) setSaving(false) }
  }
  if (!active) return null
  const options = catalog?.models ?? []
  const missing = selected && !options.some(option => option.value === selected)
  const reference = endpointModelReference(baseURL ?? '')
  const manualValid = /^[\x21-\x7e]{1,256}$/.test(manualModel.trim())
  return <div className="custom-model-settings">
    <div className="codex-auth-settings-heading"><label htmlFor={id}>{t('customModels.default')}</label>{saving && <LoaderCircle size={14} className="spin" />}</div>
    {verifyOnSelect && <small>{t('customModels.verifyOnSelect')}</small>}
    {loading ? <small role="status">{t('customModels.loading')}</small> : catalog && <>
      <select id={id} value={selected} disabled={saving || !options.length} onChange={event => void save(event.target.value)}>
          <option value="" disabled={verifyOnSelect}>{t('customModels.choose')}</option>
          {missing && <option value={selected}>{selected}</option>}
          {options.map(option => <option key={option.value} value={option.value}>{option.label === option.value ? option.label : `${option.label} (${option.value})`}</option>)}
        </select>
      {!options.length && <small>{t('customModels.empty')}</small>}
      {verifyOnSelect && selected && <button type="button" className="quiet-button" disabled={saving} onClick={() => void save(selected)}>{t('customModels.verify')}</button>}
      {baseURL && <>
        {!manual ? <button type="button" className="quiet-button" disabled={saving} onClick={() => setManual(true)}>{t('customModels.manual')}</button>
          : <form className="codex-auth-settings-form" onSubmit={event => { event.preventDefault(); if (manualValid) void save(manualModel.trim()) }}>
            <label htmlFor={`${id}-manual`}>{t('connections.model')}</label>
            <input id={`${id}-manual`} value={manualModel} maxLength={256} disabled={saving} autoComplete="off" spellCheck={false} onChange={event => setManualModel(event.target.value)} />
            <small>{reference ? <a href={reference.url} onClick={event => { event.preventDefault(); void window.agentsDock.native.openExternal(reference.url) }}>{t('connections.modelList', { provider: reference.provider })}</a> : t('connections.modelListUnknown')}</small>
            <button type="submit" className="quiet-button" disabled={saving || !manualValid}>{t('customModels.save')}</button>
          </form>}
      </>}
    </>}
    {failed && <small role="alert" className="codex-auth-settings-error">{t('customModels.failed')}</small>}
    <button type="button" className="quiet-button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>{t('customModels.refresh')}</button>
  </div>
}
