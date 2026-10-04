import { useEffect, useId, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import './SessionSubagentSettings.css'

export function SessionSubagentSettings({ session, profileScope }: {
  session: Session
  profileScope: WorkspaceProfileScope
}) {
  useLocale()
  const id = useId()
  const connected = useAppStore(state => state.connected && !state.switchingProfileId)
  const capability = useAppStore(state => state.health?.capabilities?.subagent_limit_v1)
  const baseline = session.subagent_limit?.toString() ?? ''
  const previous = useRef(baseline)
  const [draft, setDraft] = useState(baseline)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const old = previous.current
    previous.current = baseline
    setDraft(value => value === old ? baseline : value)
  }, [baseline])

  const limit = draft.trim() === '' ? null : Number(draft)
  const valid = limit === null || (/^\d+$/.test(draft.trim()) && Number.isSafeInteger(limit) && limit > 0)
  const supportedServer = capability?.version === 1
  const supportedProvider = session.subagent_limit_control?.supported === true
  // Clearing an obsolete override is allowed even after a provider downgrade.
  const editable = connected && supportedServer && (supportedProvider || (session.subagent_limit != null && limit === null)) && !saving
  const changed = limit !== (session.subagent_limit ?? null)
  const current = () => {
    const state = useAppStore.getState()
    return mounted.current && !state.switchingProfileId
      && state.activeProfileId === profileScope.profileId
      && state.profileGeneration === profileScope.profileGeneration
      && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === profileScope.serverIdentity
      && state.selectedSessionId === session.id
  }
  async function save() {
    if (!editable || !valid || !changed || !current()) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const updated = await window.agentsDock.sessions.update(session.id, { subagent_limit: limit }, profileScope)
      if (!current()) return
      if (updated.id !== session.id || (updated.subagent_limit ?? null) !== limit || !updated.subagent_limit_control) {
        throw new Error(t('ui.sessionSubagents.notAcknowledged'))
      }
      setDraft(updated.subagent_limit?.toString() ?? '')
      setSaved(true)
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (current()) setSaving(false)
    }
  }
  return <section className="inspector-section session-subagent-settings">
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor={id}>{t('ui.sessionSubagents.label')}</label>
      <div className="session-subagent-input-row">
        <input id={id} type="text" inputMode="numeric" value={draft}
          placeholder={t('ui.sessionSubagents.inherit')} aria-describedby={`${id}-help`}
          aria-invalid={!valid} disabled={!connected || !supportedServer || saving || (!supportedProvider && session.subagent_limit == null)}
          onChange={event => { setDraft(event.target.value); setError(null); setSaved(false) }} />
        <button type="submit" disabled={!editable || !valid || !changed}>
          {t(saving ? 'ui.sessionSubagents.saving' : 'ui.sessionSubagents.save')}
        </button>
      </div>
      <p id={`${id}-help`}>{t(session.backend === 'claude' ? 'ui.sessionSubagents.claude' : 'ui.sessionSubagents.codex')}</p>
      <p>{t('ui.sessionSubagents.empty')}</p>
      {!supportedServer ? <p>{t('ui.sessionSubagents.updateServer')}</p>
        : !supportedProvider ? <p>{session.subagent_limit_control?.message || t('ui.sessionSubagents.unsupported')}</p>
        : <p>{t(session.subagent_limit_control?.applies_to === 'next_provider_process_start' ? 'ui.sessionSubagents.codexResetApplies'
          : session.subagent_limit_control?.applies_to === 'next_idle_provider_start' ? 'ui.sessionSubagents.claudeApplies' : 'ui.sessionSubagents.codexApplies')}</p>}
      {!valid && <p role="alert">{t('ui.sessionSubagents.invalid')}</p>}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{t('ui.sessionSubagents.saved')}</p>}
    </form>
  </section>
}
