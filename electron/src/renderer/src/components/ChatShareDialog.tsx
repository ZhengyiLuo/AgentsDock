import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Copy, LoaderCircle, X } from 'lucide-react'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import type { ChatShareMode, ChatSharePreview, ChatShareRecord, CreatedChatShare } from '@shared/chat-shares'
import { t, useLocale } from '../lib/i18n'
import { captureWorkspaceScope } from '../lib/workspace-preferences'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import './ChatShareDialog.css'

interface Target { session: Session; scope: WorkspaceProfileScope }

export function ChatShareDialog() {
  const [target, setTarget] = useState<Target | null>(null)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const identity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<Target>).detail
      const state = useAppStore.getState()
      const session = state.sessions.find(row => row.id === requested?.session?.id)
      const scope = captureWorkspaceScope(state)
      if (session && scope?.serverIdentity && !state.switchingProfileId
        && requested.scope?.profileId === scope.profileId && requested.scope.profileGeneration === scope.profileGeneration
        && requested.scope.serverIdentity === scope.serverIdentity) setTarget({ session, scope })
    }
    window.addEventListener('agentsdock:share-chat', open)
    return () => window.removeEventListener('agentsdock:share-chat', open)
  }, [])
  useEffect(() => { setTarget(null) }, [profileId, generation, identity])
  return target ? <ChatSharePanel key={`${target.scope.profileId}:${target.scope.profileGeneration}:${target.session.id}`}
    target={target} onClose={() => setTarget(null)} /> : null
}

function ChatSharePanel({ target: { session, scope }, onClose }: { target: Target; onClose: () => void }) {
  useLocale()
  const [mode, setMode] = useState<ChatShareMode>('snapshot')
  const [shares, setShares] = useState<ChatShareRecord[]>([])
  const [preview, setPreview] = useState<ChatSharePreview | null>(null)
  const [created, setCreated] = useState<CreatedChatShare | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [reload, setReload] = useState(0)
  const operation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setError(null); setShares([])
    void window.agentsDock.chatShares.list(scope, session.id, mode).then(value => { if (active) setShares(value) })
      .catch(cause => { if (active) setError(shareError(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scope, session.id, mode, reload])
  const close = () => { if (!operation.current) onClose() }
  useTransientClose(true, close)
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(null)
    try { await action() } catch (cause) { if (mounted.current) setError(shareError(cause)) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const previewChat = () => run(async () => {
    const value = await window.agentsDock.chatShares.preview(scope, session.id)
    if (mounted.current) { setPreview(value); setConfirmed(false) }
  })
  const create = () => run(async () => {
    if (!confirmed || (mode === 'snapshot' && !preview)) return
    setConfirmed(false)
    // Creation is deliberately one-shot. A failed/ambiguous response is never
    // replayed; the user can inspect the management list before a new action.
    const value = await window.agentsDock.chatShares.create(scope, session.id, mode === 'snapshot'
      ? { mode, confirmed_public: true, through_bytes: preview!.through_bytes, digest: preview!.digest, title: [...session.title].slice(0, 256).join('') }
      : { mode, confirmed_interactive: true, title: [...session.title].slice(0, 256).join('') })
    if (mounted.current) { setCreated(value); setShares(previous => [value, ...previous.filter(item => item.id !== value.id)]); setConfirmed(false) }
  })
  const revoke = (id: string) => run(async () => {
    await window.agentsDock.chatShares.revoke(scope, session.id, mode, id)
    if (mounted.current) {
      setShares(previous => previous.map(item => item.id === id ? { ...item, revoked_at: Date.now() / 1000 } : item))
      if (created?.id === id) { setCreated(null); setCopied(false) }
    }
  })
  const changeMode = (next: ChatShareMode) => {
    if (operation.current) return
    setMode(next); setPreview(null); setCreated(null); setConfirmed(false); setCopied(false)
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="form-dialog chat-share-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
      onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
      <header><div><Dialog.Title>{t('chatShare.title')}</Dialog.Title><Dialog.Description>{session.title}</Dialog.Description></div>
        <button type="button" className="icon-button" aria-label={t('chatShare.close')} disabled={busy} onClick={close}><X size={16} /></button></header>
      <div className="form-dialog-body dialog-form">
        <label><span>{t('chatShare.mode')}</span><select value={mode} disabled={busy} onChange={event => changeMode(event.target.value as ChatShareMode)}>
          <option value="snapshot">{t('chatShare.snapshot')}</option><option value="interactive">{t('chatShare.interactive')}</option>
        </select></label>
        <p className="chat-share-warning">{t(mode === 'snapshot' ? 'chatShare.snapshotWarning' : 'chatShare.interactiveWarning')}</p>
        {mode === 'snapshot' && <button type="button" className="quiet-button" disabled={busy || loading} onClick={() => void previewChat()}>{t('chatShare.preview')}</button>}
        {preview && <section className="chat-share-preview" aria-label={t('chatShare.preview')}>
          {preview.messages.map((message, index) => <article key={index}><strong>{t(message.role === 'user' ? 'chatShare.user' : 'chatShare.assistant')}</strong><p>{message.text}</p></article>)}
          {preview.messages.length === 0 && <p>{t('chatShare.emptyPreview')}</p>}
        </section>}
        {!created && <>
          <label className="chat-share-confirm"><input type="checkbox" checked={confirmed} disabled={busy || loading || (mode === 'snapshot' && !preview)} onChange={event => setConfirmed(event.target.checked)} />
            <span>{t(mode === 'snapshot' ? 'chatShare.confirmSnapshot' : 'chatShare.confirmInteractive')}</span></label>
          <button type="button" className="primary-button" disabled={busy || loading || !confirmed || (mode === 'snapshot' && !preview)} onClick={() => void create()}>
            {busy && <LoaderCircle className="spin" size={14} />}{t(mode === 'snapshot' ? 'chatShare.createSnapshot' : 'chatShare.createInvite')}
          </button>
        </>}
        {created && <section className="chat-share-created" aria-label={t('chatShare.created')}>
          <p>{t(mode === 'interactive' ? 'chatShare.inviteOnce' : 'chatShare.saveLink')}</p>
          {!created.url && <p role="status">{t('chatShare.hostingRequired')}</p>}
          <input aria-label={t(created.url ? 'chatShare.link' : 'chatShare.relativePath')} readOnly value={created.url ?? created.path} onFocus={event => event.currentTarget.select()} />
          <button type="button" className="quiet-button" onClick={() => void run(async () => {
            await window.agentsDock.native.writeClipboard(created.url ?? created.path)
            if (mounted.current) setCopied(true)
          })} disabled={busy}><Copy size={14} />{t(copied ? 'chatShare.copied' : created.url ? 'chatShare.copyLink' : 'chatShare.copyPath')}</button>
        </section>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <section className="chat-share-existing" aria-label={t('chatShare.existing')}>
          <header><strong>{t('chatShare.existing')}</strong><button type="button" className="quiet-button" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>{t('chatShare.refresh')}</button></header>
          {loading ? <p role="status">{t('chatShare.loading')}</p> : shares.length === 0 ? <p>{t('chatShare.none')}</p> : shares.map(item => <div className="chat-share-record" key={item.id}>
            <span>{item.title || session.title}<small>{t(item.revoked_at !== null ? 'chatShare.revoked' : item.expires_at !== null && item.expires_at * 1000 <= Date.now() ? 'chatShare.expired' : item.redeemed_at ? 'chatShare.redeemed' : 'chatShare.active')}</small></span>
            <button type="button" className="quiet-button danger" disabled={busy || item.revoked_at !== null} onClick={() => void revoke(item.id)}>{t('chatShare.revoke')}</button>
          </div>)}
        </section>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function shareError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/\b404\b|not found|not implemented/i.test(message)) return t('chatShare.unavailable')
  return message
}
