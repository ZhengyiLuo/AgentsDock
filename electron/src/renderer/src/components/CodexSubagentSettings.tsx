import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle, Users } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodexSubagentsConfiguration } from '@shared/types'
import { useLocale } from '../lib/i18n'

export function CodexSubagentSettings({ connected, profileId, profileGeneration }: {
  connected: boolean
  profileId: string | null
  profileGeneration: number
}) {
  useLocale()
  const fieldId = useId()
  const [configuration, setConfiguration] = useState<CodexSubagentsConfiguration | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [unavailable, setUnavailable] = useState<'update' | 'admin' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [reload, setReload] = useState(0)
  const requestRef = useRef(0)

  function showFailure(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) setUnavailable('admin')
    else if (/\b(?:404|405|501)\b|not found|not implemented|method not allowed/i.test(message)) setUnavailable('update')
    else setError(message)
  }

  useEffect(() => {
    const request = ++requestRef.current
    setConfiguration(null)
    setDraft('')
    setError(null)
    setUnavailable(null)
    setSaved(false)
    setSaving(false)
    const read = window.agentsDock.codex?.serverSubagents
    setLoading(connected && typeof read === 'function')
    if (connected) {
      if (typeof read !== 'function') setUnavailable('update')
      else void read().then(next => {
        if (request !== requestRef.current) return
        setConfiguration(next)
        setDraft(next.max_concurrent_threads_per_session?.toString() ?? '')
      }).catch(reason => {
        if (request === requestRef.current) showFailure(reason)
      }).finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
    }
    return () => { requestRef.current += 1 }
  }, [connected, profileId, profileGeneration, reload])

  const limit = draft.trim() === '' ? null : Number(draft)
  const valid = limit === null || (/^\d+$/.test(draft.trim()) && Number.isSafeInteger(limit) && limit >= 1)
  const editable = connected && configuration?.configurable === true && !unavailable && !loading && !saving
  const changed = configuration != null && limit !== configuration.max_concurrent_threads_per_session

  async function save() {
    if (!editable || !valid || !changed) return
    const request = ++requestRef.current
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await window.agentsDock.codex.setServerSubagents(limit)
      if (request !== requestRef.current) return
      setConfiguration(next)
      setDraft(next.max_concurrent_threads_per_session?.toString() ?? '')
      if (next.configurable) setSaved(true)
    } catch (reason) {
      if (request === requestRef.current) showFailure(reason)
    } finally {
      if (request === requestRef.current) setSaving(false)
    }
  }

  return <section className="codex-server-settings codex-subagent-settings" aria-label={t('codexSubagents.title')}>
    <span className="codex-server-settings-icon"><Users size={17} /></span>
    <div className="codex-server-settings-copy">
      <strong><label htmlFor={fieldId}>{t('codexSubagents.title')}</label></strong>
      <small id={`${fieldId}-help`}>{!connected ? t('codexSubagents.connect')
        : unavailable ? t(unavailable === 'update' ? 'codexSubagents.update' : 'codexSubagents.admin')
          : configuration?.configurable === false
            ? configuration.reason === 'unsupported_transport' ? t('codexSubagents.transport') : configuration.message
            : t('codexSubagents.help')}</small>
      {connected && !unavailable && configuration?.configurable !== false && <small>{t('codexSubagents.applies')}</small>}
      <form className="codex-subagent-settings-controls" onSubmit={event => { event.preventDefault(); void save() }}>
        <input id={fieldId} type="text" inputMode="numeric" value={draft}
          placeholder={t('codexSubagents.default')} disabled={!editable}
          aria-describedby={`${fieldId}-help`} aria-invalid={!valid}
          onChange={event => { setDraft(event.target.value); setSaved(false); setError(null) }} />
        <button className="quiet-button" type="submit" disabled={!editable || !valid || !changed}>
          {saving ? <LoaderCircle className="spin" size={14} /> : null}{t('codexSubagents.save')}
        </button>
        {loading && <LoaderCircle className="spin" size={14} aria-label={t('codexSubagents.loading')} />}
        {error && !configuration && <button className="quiet-button" type="button" onClick={() => setReload(value => value + 1)}>{t('codexSubagents.retry')}</button>}
      </form>
      {!valid && <small role="alert">{t('codexSubagents.invalid')}</small>}
      {error && <small role="alert">{error}</small>}
      {saved && <small role="status">{t('codexSubagents.saved')}</small>}
    </div>
  </section>
}
