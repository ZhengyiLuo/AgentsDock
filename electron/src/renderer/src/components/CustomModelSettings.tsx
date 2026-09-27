import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CustomModelBackend, CustomModels } from '@shared/custom-models'
import { useAppStore } from '../store/app-store'

/** Read-only discovery on opening; choosing a default never runs inference. */
export function CustomModelSettings({ backend, active, onSaved }: { backend: CustomModelBackend; active: boolean; onSaved: () => void }) {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const [catalog, setCatalog] = useState<CustomModels | null>(null)
  const [selected, setSelected] = useState('')
  const [manual, setManual] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const serial = useRef(0)
  const id = useId()
  useEffect(() => {
    const request = ++serial.current
    setCatalog(null); setSelected(''); setManual(false); setFailed(false); setLoading(false); setSaving(false)
    if (!active || !connected || !profileId) return
    const api = window.agentsDock.customModels
    if (!api) { setFailed(true); return }
    setLoading(true)
    void api.read({ profileId, profileGeneration }, backend).then(value => {
      if (serial.current !== request) return
      setCatalog(value); setSelected(value.default_model ?? '')
      setManual(!value.models?.length)
    }).catch(() => { if (serial.current === request) setFailed(true) })
      .finally(() => { if (serial.current === request) setLoading(false) })
    return () => { serial.current++ }
  }, [active, connected, profileId, profileGeneration, backend, reload])
  async function save() {
    if (!catalog || !profileId || !connected || loading || saving || !window.agentsDock.customModels) return
    const request = ++serial.current
    setSaving(true); setFailed(false)
    try {
      const result = await window.agentsDock.customModels.save({ profileId, profileGeneration }, backend,
        { model: selected.trim() || null, expected_revision: catalog.revision })
      if (serial.current !== request) return
      setCatalog({ ...catalog, ...result }); onSaved()
    } catch { if (serial.current === request) setFailed(true) }
    finally { if (serial.current === request) setSaving(false) }
  }
  if (!active) return null
  const options = catalog?.models ?? []
  const missing = selected && !options.some(option => option.value === selected)
  return <div className="custom-model-settings">
    <div className="codex-auth-settings-heading"><label htmlFor={id}>{t('customModels.default')}</label>
      <button type="button" className="quiet-button" disabled={loading || saving || !connected} onClick={() => setReload(value => value + 1)}>
        {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{t('customModels.refresh')}
      </button>
    </div>
    {loading ? <small role="status">{t('customModels.loading')}</small> : catalog && <>
      {manual ? <input id={id} value={selected} maxLength={256} autoComplete="off" spellCheck={false} disabled={saving} onChange={event => setSelected(event.target.value)} />
        : <select id={id} value={selected} disabled={saving} onChange={event => setSelected(event.target.value)}>
          <option value="">{t('customModels.choose')}</option>
          {missing && <option value={selected}>{selected}</option>}
          {options.map(option => <option key={option.value} value={option.value}>{option.label === option.value ? option.label : `${option.label} (${option.value})`}</option>)}
        </select>}
      <small>{t(catalog.discovery_status === 'partial' ? 'customModels.partial' : !options.length ? 'customModels.noList' : 'customModels.help')}</small>
      <div className="codex-auth-settings-actions">
        <button type="button" className="quiet-button" disabled={saving} onClick={() => setManual(value => !value)}>{t(manual ? 'customModels.list' : 'customModels.manual')}</button>
        <button type="button" className="primary-button" disabled={saving || selected.trim() === (catalog.default_model ?? '') || (!!selected && !/^[\x21-\x7e]{1,256}$/.test(selected.trim()))} onClick={() => void save()}>{saving && <LoaderCircle size={14} className="spin" />}{t('customModels.save')}</button>
      </div>
    </>}
    {failed && <small role="alert" className="codex-auth-settings-error">{t('customModels.failed')}</small>}
  </div>
}
