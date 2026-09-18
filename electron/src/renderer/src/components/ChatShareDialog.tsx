import { useEffect, useId, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Copy, LoaderCircle, X } from 'lucide-react'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import { normalizeChatShareOrigin, type ChatShareMode, type ChatShareRecord, type CreatedChatShare } from '@shared/chat-shares'
import { trackEvent } from '../lib/analytics'
import { t, useLocale } from '../lib/i18n'
import { captureWorkspaceScope } from '../lib/workspace-preferences'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import './ChatShareDialog.css'

interface Target { session: Session; scope: WorkspaceProfileScope; initialOrigin: string }
type ListedShare = ChatShareRecord & { mode: ChatShareMode }
type CreatedShare = CreatedChatShare & { mode: ChatShareMode }

function listedShare(value: ChatShareRecord, mode: ChatShareMode): ListedShare {
  // Creation tokens belong only to the open dialog, never its management list.
  return { mode, id: value.id, title: value.title, created_at: value.created_at,
    expires_at: value.expires_at, revoked_at: value.revoked_at,
    redeemed_at: value.redeemed_at, message_count: value.message_count }
}

function invitation(value: CreatedChatShare): string {
  return `${value.url ?? value.path}\nToken: ${value.access_token}`
}

function profileShareOrigin(serverUrl: string | undefined): string {
  try { return normalizeChatShareOrigin(new URL(serverUrl ?? '').origin) }
  catch { return '' }
}

export function ChatShareDialog() {
  const [target, setTarget] = useState<Target | null>(null)
  const targetRef = useRef<Target | null>(null)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const identity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<Pick<Target, 'session' | 'scope'>>).detail
      const state = useAppStore.getState()
      const session = state.sessions.find(row => row.id === requested?.session?.id)
      const scope = captureWorkspaceScope(state)
      if (session && scope?.serverIdentity && !state.switchingProfileId
        && requested.scope?.profileId === scope.profileId && requested.scope.profileGeneration === scope.profileGeneration
        && requested.scope.serverIdentity === scope.serverIdentity) {
        const next = { session, scope,
          initialOrigin: profileShareOrigin(state.profiles.find(profile => profile.id === scope.profileId)?.serverUrl) }
        if (!targetRef.current) trackEvent('chat_share_opened')
        targetRef.current = next
        setTarget(next)
      }
    }
    window.addEventListener('agentsdock:share-chat', open)
    return () => window.removeEventListener('agentsdock:share-chat', open)
  }, [])
  useEffect(() => {
    targetRef.current = null
    setTarget(null)
  }, [profileId, generation, identity])
  const close = () => {
    targetRef.current = null
    setTarget(null)
  }
  return target ? <ChatSharePanel key={`${target.scope.profileId}:${target.scope.profileGeneration}:${target.session.id}`}
    target={target} onClose={close} /> : null
}

function ChatSharePanel({ target: { session, scope, initialOrigin }, onClose }: { target: Target; onClose: () => void }) {
  useLocale()
  const [shareAddress, setShareAddress] = useState(initialOrigin)
  const addressHintId = useId()
  const [shares, setShares] = useState<ListedShare[]>([])
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyMode, setBusyMode] = useState<ChatShareMode | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'invitation' | 'token-link' | null>(null)
  const [opened, setOpened] = useState(false)
  const [revokedOpen, setRevokedOpen] = useState(false)
  const operation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const close = () => { if (!operation.current) onClose() }
  useTransientClose(true, close)
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(null)
    try { await action() } catch (cause) { if (mounted.current) setError(shareError(cause)) }
    finally { operation.current = false; if (mounted.current) { setBusy(false); setBusyMode(null) } }
  }
  const create = (mode: ChatShareMode) => run(async () => {
    let baseUrl: string
    try { baseUrl = normalizeChatShareOrigin(shareAddress) }
    catch { throw new Error(t('chatShare.invalidAddress')) }
    setBusyMode(mode); setCopied(null); setOpened(false)
    // Creation is deliberately one-shot. A failed/ambiguous response is never
    // replayed; the user can inspect the management list before a new action.
    const value = await window.agentsDock.chatShares.create(scope, session.id, mode === 'snapshot'
      ? { mode, confirmed_public: true, title: [...session.title].slice(0, 256).join(''), base_url: baseUrl }
      : { mode, confirmed_interactive: true, title: [...session.title].slice(0, 256).join(''), base_url: baseUrl })
    trackEvent(mode === 'snapshot' ? 'chat_share_snapshot_created' : 'chat_share_interactive_created')
    if (!mounted.current) return
    setCreated({ ...value, mode })
    setShares(previous => [listedShare(value, mode), ...previous.filter(item => item.id !== value.id || item.mode !== mode)])
    if (!value.url) throw new Error(t('chatShare.hostingRequired'))
    // Opening an invitation does not redeem it: the browser still requires Join.
    const actions = await Promise.allSettled([
      window.agentsDock.native.writeClipboard(invitation(value)).then(() => { if (mounted.current) setCopied('invitation') }),
      window.agentsDock.native.openExternal(value.url).then(() => { if (mounted.current) setOpened(true) })
    ])
    const failed = actions.find(action => action.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })
  const revoke = (item: ListedShare) => run(async () => {
    await window.agentsDock.chatShares.revoke(scope, session.id, item.mode, item.id)
    trackEvent('chat_share_revoked')
    if (mounted.current) {
      setShares(previous => previous.map(row => row.id === item.id && row.mode === item.mode ? { ...row, revoked_at: Date.now() / 1000 } : row))
      setRevokedOpen(false)
      if (created?.id === item.id && created.mode === item.mode) { setCreated(null); setCopied(null); setOpened(false) }
    }
  })
  const loadShares = async () => {
    if (loading || loaded) return
    setLoading(true)
    try {
      const lists = await Promise.all((['snapshot', 'interactive'] as const).map(async mode =>
        (await window.agentsDock.chatShares.list(scope, session.id, mode)).map(item => listedShare(item, mode))))
      if (mounted.current) { setShares(lists.flat()); setLoaded(true) }
    } catch (cause) { if (mounted.current) setError(shareError(cause)) }
    finally { if (mounted.current) setLoading(false) }
  }
  const revokedShares = shares.filter(item => item.revoked_at !== null)
  const shareRecord = (item: ListedShare) => <div className="chat-share-record" key={`${item.mode}:${item.id}`}>
    <span>{item.title || session.title}<small>{t(item.mode === 'snapshot' ? 'chatShare.viewOnly' : 'chatShare.interactiveAction')} · {t(item.revoked_at !== null ? 'chatShare.revoked' : item.expires_at !== null && item.expires_at * 1000 <= Date.now() ? 'chatShare.expired' : 'chatShare.active')}</small></span>
    <button type="button" className="quiet-button danger" disabled={busy || item.revoked_at !== null} onClick={() => void revoke(item)}>{t('chatShare.revoke')}</button>
  </div>
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="form-dialog chat-share-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
      onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
      <header><div><Dialog.Title>{t('chatShare.title')}</Dialog.Title><Dialog.Description>{session.title}</Dialog.Description></div>
        <button type="button" className="icon-button" aria-label={t('chatShare.close')} disabled={busy} onClick={close}><X size={16} /></button></header>
      <div className="form-dialog-body dialog-form">
        <div className="chat-share-address">
          <label className="chat-share-field"><span>{t('chatShare.address')}</span>
            <input type="text" inputMode="url" autoComplete="off" spellCheck={false} disabled={busy || loading}
              value={shareAddress} onChange={event => setShareAddress(event.currentTarget.value)} aria-describedby={addressHintId} /></label>
          <p className="chat-share-warning" id={addressHintId}>{t('chatShare.addressHint')}</p>
        </div>
        <div className="chat-share-actions">{(['snapshot', 'interactive'] as const).map(mode =>
          <button key={mode} type="button" className="primary-button" disabled={busy || loading} onClick={() => void create(mode)}>
            {busyMode === mode && <LoaderCircle className="spin" size={14} />}{t(mode === 'snapshot' ? 'chatShare.viewOnly' : 'chatShare.interactiveAction')}
          </button>)}</div>
        <p className="chat-share-warning">{t('chatShare.trustHint')}</p>
        {created && <section className="chat-share-created" aria-label={t('chatShare.created')}>
          {copied === 'invitation' && <p role="status">{t(opened ? 'chatShare.copiedOpened' : 'chatShare.invitationCopied')}</p>}
          {copied === 'token-link' && <p role="status">{t('chatShare.tokenLinkCopied')}</p>}
          <label className="chat-share-field"><span>{t(created.url ? 'chatShare.link' : 'chatShare.relativePath')}</span>
            <input readOnly value={created.url ?? created.path} onFocus={event => event.currentTarget.select()} /></label>
          <label className="chat-share-field"><span>{t('chatShare.accessToken')}</span>
            <input readOnly autoComplete="off" spellCheck={false} value={created.access_token} onFocus={event => event.currentTarget.select()} /></label>
          {created.mode === 'interactive' && <p className="chat-share-warning">{t('chatShare.reusableTokenHint')}</p>}
          <div className="chat-share-created-actions">
            <button type="button" className="quiet-button" onClick={() => void run(async () => {
              await window.agentsDock.native.writeClipboard(invitation(created))
              if (mounted.current) setCopied('invitation')
            })} disabled={busy}><Copy size={14} />{t('chatShare.copyInvitation')}</button>
            {created.mode === 'snapshot' && created.token_url && <button type="button" className="quiet-button" onClick={() => void run(async () => {
              await window.agentsDock.native.writeClipboard(created.token_url!)
              if (mounted.current) setCopied('token-link')
            })} disabled={busy}>{t('chatShare.copyTokenLink')}</button>}
          </div>
        </section>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <details className="chat-share-existing" onToggle={event => { if (event.currentTarget.open) void loadShares() }}>
          <summary>{t('chatShare.existing')}</summary>
          {loading ? <p role="status">{t('chatShare.loading')}</p> : shares.length === 0 ? <p>{t('chatShare.none')}</p> : <>
            {shares.filter(item => item.revoked_at === null).map(shareRecord)}
            {revokedShares.length > 0 && <details className="chat-share-revoked" open={revokedOpen}
              onToggle={event => setRevokedOpen(event.currentTarget.open)}>
              <summary>{t('chatShare.revokedCount', { count: revokedShares.length })}</summary>
              {revokedShares.map(shareRecord)}
            </details>}
          </>}
        </details>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function shareError(cause: unknown): string {
  const message = (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/i, '')
  if (/\b404\b|not found|not implemented/i.test(message)) return t('chatShare.unavailable')
  return message
}
