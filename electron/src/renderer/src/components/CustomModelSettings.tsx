import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const serial = useRef(0)
  const id = useId()
  useEffect(() => {
    const request = ++serial.current
    setCatalog(null); setSelected(''); setFailed(false); setLoading(false); setSaving(false)
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
    if (!catalog || !profileId || !connected || loading || saving || !window.agentsDock.customModels) return
    const request = ++serial.current
    setSelected(model); setSaving(true); setFailed(false)
    try {
      const result = await window.agentsDock.customModels.save({ profileId, profileGeneration }, backend,
        { model: model || null, expected_revision: catalog.revision })
      if (serial.current !== request) return
      setCatalog({ ...catalog, ...result }); onSaved()
    } catch { if (serial.current === request) { setSelected(catalog.default_model ?? ''); setFailed(true) } }
    finally { if (serial.current === request) setSaving(false) }
  }
  if (!active) return null
  const options = catalog?.models ?? []
  const missing = selected && !options.some(option => option.value === selected)
  return <div className="custom-model-settings">
    <div className="codex-auth-settings-heading"><label htmlFor={id}>{t('customModels.default')}</label>{saving && <LoaderCircle size={14} className="spin" />}</div>
    {loading ? <small role="status">{t('customModels.loading')}</small> : catalog && <>
      <select id={id} value={selected} disabled={saving || !options.length} onChange={event => void save(event.target.value)}>
          <option value="">{t('customModels.choose')}</option>
          {missing && <option value={selected}>{selected}</option>}
          {options.map(option => <option key={option.value} value={option.value}>{option.label === option.value ? option.label : `${option.label} (${option.value})`}</option>)}
        </select>
      {!options.length && <small>{t('customModels.empty')}</small>}
    </>}
    {failed && <><small role="alert" className="codex-auth-settings-error">{t('customModels.failed')}</small>
      <button type="button" className="quiet-button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>{t('connections.refresh')}</button></>}
  </div>
}
