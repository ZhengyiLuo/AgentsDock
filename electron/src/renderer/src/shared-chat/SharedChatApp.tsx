import { useState } from 'react'
import { Settings, X } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { t } from '@shared/i18n'
import type { SharedChatState } from './bridge'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { Timeline } from '../components/Timeline'
import { Composer } from '../components/Composer'
import { CodexRuntimeProvider } from '../components/CodexRuntimeContext'
import { ClaudeRuntimeProvider } from '../components/ClaudeRuntimeContext'
import { CodexGoalBar, CodexStatusButton } from '../components/CodexControls'
import { CodexInteractionShelf } from '../components/CodexInteractionShelf'
import { ClaudeInteractionShelf } from '../components/ClaudeInteractionShelf'
import { ScheduledJobsPopover } from '../components/ScheduledJobsPopover'
import { JobDialog } from '../components/Dialogs'
import { SessionPromptField } from '../components/Inspector'

let historyIdentity: string | null = null
/** No desktop initialization: no server inventory, background services, or native workspace. */
export function receiveSharedChatState(value: SharedChatState, prefix: string) {
  const session = value.session
  const identity = value.revision.split(':')[0]
  const reset = historyIdentity !== identity
  historyIdentity = identity
  useAppStore.setState(previous => {
    const old = previous.snapshots[session.id]
    // Native pages are authoritative. Preserve only previously loaded OLDER
    // history, never stale rows omitted from a repaired current tail.
    const firstSeq = value.events[0]?.seq
    const prefixEvents = !reset && firstSeq != null ? (old?.events ?? []).filter(event => event.seq < firstSeq) : []
    const events = [...prefixEvents, ...value.events]
    return {
      initialized: true, connected: true, activeProfileId: 'shared-chat', profileGeneration: 1,
      profiles: [{ id: 'shared-chat', name: 'Shared chat', serverUrl: location.origin, serverIdentity: prefix,
        hasAccessToken: false, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
      health: value.health, runtimeCatalog: value.runtime_catalog, sessions: [session], jobs: value.jobs,
      selectedSessionId: session.id, chatPanes: { primary: session.id, secondary: null }, focusedChatPane: 'primary',
      activeSessionIds: new Set(value.active ? [session.id] : []),
      snapshots: { [session.id]: { session, events, queuedTurns: value.queue, files: [], filesTotal: 0,
        hasMoreEvents: prefixEvents.length ? old?.hasMoreEvents === true : value.hasMoreEvents === true,
        nextTimelineBefore: prefixEvents.length ? old?.nextTimelineBefore : value.nextTimelineBefore,
        eventsTotal: value.eventsTotal, semanticPaging: true, historyVerified: true, cachedAt: Date.now(),
        generation: (old?.generation ?? 0) + 1,
        timelineListGeneration: (old?.timelineListGeneration ?? 0) + (reset && old ? 1 : 0),
        viewState: reset ? null : old?.viewState } },
      // Navigation never resolves a peer, including a peer ID inside a transcript.
      selectSession: async id => { if (id !== session.id) throw new Error('Only this shared chat is available.') },
      selectSessionInPane: async id => { if (id !== session.id) throw new Error('Only this shared chat is available.') }
    }
  })
}

export function SharedChatApp() {
  useLocale()
  const session = useAppStore(state => state.sessions[0] ?? null)
  const health = useAppStore(state => state.health)
  const error = useAppStore(state => state.error)
  const connected = useAppStore(state => state.connected)
  const [settingsOpen, setSettingsOpen] = useState(false)
  if (!session) return null
  return <ClaudeRuntimeProvider session={session} capability={health?.capabilities?.claude_controls}>
    <CodexRuntimeProvider session={session} capability={health?.capabilities?.codex_controls}>
      <main className="shared-chat-shell">
        <header className="chat-header">
          <strong className="shared-chat-title">{session.title}</strong>
          <span className="shared-chat-scope">{t('chatShare.web.scope')}</span>
          <fieldset disabled={!connected} className="header-actions shared-chat-controls">
            <ScheduledJobsPopover session={session} />
            {session.backend === 'codex' && <CodexStatusButton />}
            <button className="icon-button" aria-label={t('chatShare.web.settings')} onClick={() => setSettingsOpen(true)}><Settings size={16} /></button>
          </fieldset>
        </header>
        {!connected && <div className="shared-chat-notice" role="status">{t('chatShare.web.disconnected')}</div>}
        {error && <div className="shared-chat-notice" role="alert"><span>{error}</span><button className="icon-button" aria-label={t('chatShare.web.dismiss')} onClick={() => useAppStore.getState().setError(null)}><X size={14} /></button></div>}
        <fieldset disabled={!connected} className="shared-chat-controls"><CodexGoalBar /></fieldset>
        <div className="chat-workspace">
          <div className="chat-workspace-history"><Timeline /></div>
          <div className="chat-workspace-shelves"><CodexInteractionShelf /><ClaudeInteractionShelf /></div>
          <fieldset disabled={!connected} className="shared-chat-controls"><Composer /></fieldset>
        </div>
      </main>
      <JobDialog />
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content shared-chat-settings">
        <Dialog.Title>{t('chatShare.web.settings')}</Dialog.Title>
        <Dialog.Description>{t('chatShare.web.settingsHelp')}</Dialog.Description>
        <SessionPromptField value={session.system_prompt ?? ''} onSave={system_prompt => useAppStore.getState().updateSession(session.id, { system_prompt: system_prompt || null })} />
        <Dialog.Close asChild><button className="quiet-button">{t('chatShare.web.close')}</button></Dialog.Close>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
    </CodexRuntimeProvider>
  </ClaudeRuntimeProvider>
}
