// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import { LoaderCircle, Target } from 'lucide-react'
import type { CodexGoalsConfiguration } from '@shared/types'
import { announceCodexGoalsConfigurationChanged } from '../lib/codex-goals'

const unsupportedConfiguration = (): CodexGoalsConfiguration => ({
  enabled: true,
  configurable: false,
  message: 'Persistent goals remain available, but this connection cannot change the server-wide setting.'
})

interface CodexServerSettingsProps {
  connected: boolean
  profileId: string | null
  profileGeneration: number
}

export function CodexServerSettings({ connected, profileId, profileGeneration }: CodexServerSettingsProps) {
  useLocale()
  const [configuration, setConfiguration] = useState<CodexGoalsConfiguration | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const request = ++requestRef.current
    setSaving(false)
    setError(null)
    if (!connected) {
      setConfiguration(null)
      setLoading(false)
      return
    }
    const read = window.agentsDock.codex?.serverGoals
    if (typeof read !== 'function') {
      setConfiguration(unsupportedConfiguration())
      setLoading(false)
      return
    }
    setConfiguration(null)
    setLoading(true)
    void read().then(next => {
      if (request === requestRef.current) setConfiguration(next)
    }).catch(reason => {
      if (request !== requestRef.current) return
      if (unsupportedServerError(reason)) setConfiguration(unsupportedConfiguration())
      else setError(errorMessage(reason))
    }).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
    return () => { requestRef.current += 1 }
  }, [connected, profileGeneration, profileId])

  const setEnabled = async (enabled: boolean) => {
    if (!configuration?.configurable || saving) return
    const request = ++requestRef.current
    setSaving(true)
    setError(null)
    try {
      const update = window.agentsDock.codex?.setServerGoals
      if (typeof update !== 'function') {
        setConfiguration(unsupportedConfiguration())
        return
      }
      const next = await update(enabled)
      if (request === requestRef.current) {
        setConfiguration(next)
        announceCodexGoalsConfigurationChanged(profileId, profileGeneration, next.enabled)
      }
    } catch (reason) {
      if (request !== requestRef.current) return
      if (unsupportedServerError(reason)) setConfiguration(unsupportedConfiguration())
      else setError(errorMessage(reason))
    } finally {
      if (request === requestRef.current) setSaving(false)
    }
  }

  const enabled = configuration?.enabled ?? true
  const unavailable = !connected || configuration?.configurable === false
  const detail = !connected
    ? 'Connect to the server to view this setting.'
    : error
      ? error
      : configuration?.configurable === false
        ? configuration.message
        : enabled
          ? `${configuration?.message || 'Enabled server-wide.'} Turning this off pauses existing goals and disables goal tools.`
          : `${configuration?.message || 'Disabled server-wide.'} Normal chats and scheduled jobs continue without goal continuations.`

  return <section className={`codex-server-settings${error ? ' error' : ''}`} aria-label={t("ui.CodexServerSettings.CodexServerSettings.codex_server_behavior_d35bbf6")}>
    <span className="codex-server-settings-icon"><Target size={17} /></span>
    <div className="codex-server-settings-copy">
      <strong>{t("ui.CodexServerSettings.CodexServerSettings.persistent_codex_goals_4690eb6")}</strong>
      <small>{detail}</small>
    </div>
    {loading
      ? <LoaderCircle className="spin codex-server-settings-spinner" size={16} aria-label={t("ui.CodexServerSettings.CodexServerSettings.loading_persistent_codex_goals_setting_69a07f4")} />
      : <Switch.Root
          className="settings-switch"
          checked={enabled}
          disabled={unavailable || saving || configuration == null}
          aria-label={t("ui.CodexServerSettings.CodexServerSettings.allow_persistent_codex_goals_on_this_serve_6cc1510")}
          onCheckedChange={value => void setEnabled(value)}
        >
          <Switch.Thumb className="settings-switch-thumb" />
        </Switch.Root>}
  </section>
}

function unsupportedServerError(error: unknown): boolean {
  return /(?:\b401\b|\b403\b|\b404\b|\b405\b|\b501\b|unauthori[sz]ed|forbidden|not found|method not allowed|not implemented)/i.test(errorMessage(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
