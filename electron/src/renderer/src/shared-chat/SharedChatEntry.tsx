import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { SharedChatApp } from './SharedChatApp'

interface EntryBridge {
  start(): Promise<void>
  retry(): Promise<void>
  redeem(token: string): Promise<void>
  catalog(): Promise<void>
}

export function SharedChatEntry({ bridge }: { bridge: EntryBridge }) {
  useLocale()
  const ready = useAppStore(state => state.initialized)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const entering = useRef(false)
  const mounted = useRef(true)
  const enter = async (manualToken?: string) => {
    if (entering.current) return
    entering.current = true
    setBusy(true); setError(null)
    try {
      // Only an explicit form submission supplies a token. Never derive one
      // from the URL, browser storage, or a failed cookie-only resume.
      if (manualToken !== undefined) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(manualToken)) throw new Error(t('chatShare.web.invalidToken'))
        await bridge.redeem(manualToken)
        if (mounted.current) setToken('')
      }
      await bridge.start()
      useAppStore.getState().setError(null)
      void bridge.catalog().catch(() => { /* Selected model stays available without catalog discovery. */ })
    } catch (cause) {
      // A fresh browser has no cookie yet; show the token form without an
      // alarming authorization error or any automatic redemption attempt.
      if (mounted.current && manualToken !== undefined) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      entering.current = false
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void enter()
    return () => { mounted.current = false }
  }, [bridge])
  if (ready) return <SharedChatApp onRetry={() => bridge.retry()} />
  return <main className="shared-chat-welcome">
    <h1>AgentsDock</h1><h2>{t('chatShare.web.title')}</h2>
    <p>{t('chatShare.web.tokenHint')}</p>
    <form className="dialog-form shared-chat-entry-form" onSubmit={event => { event.preventDefault(); void enter(token.trim()) }}>
      <label className="shared-chat-token-field"><span>{t('chatShare.accessToken')}</span>
        <input value={token} onChange={event => setToken(event.currentTarget.value)} disabled={busy}
          autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} required /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={busy || !token.trim()}>{busy ? t('chatShare.web.opening') : t('chatShare.web.open')}</button>
    </form>
  </main>
}
