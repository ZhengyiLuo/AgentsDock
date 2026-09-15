import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Inbox, LoaderCircle, Trash2 } from 'lucide-react'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { t } from '@shared/i18n'
import { chatInboxMessageId, chatMailboxAvailable, inboxMessageMatchesEvent } from '@shared/chat-inbox'
import type { ChatInboxMessage, CrossChatHandoff, WorkspaceProfileScope } from '@shared/types'
import type { SystemItem } from '../lib/timeline'
import { useLocale } from '../lib/i18n'
import { formatTime } from '../lib/format'
import { useAppStore } from '../store/app-store'
import { MarkdownContent } from './MarkdownContent'
import { CrossChatPeerLink } from './CrossChatPeerLink'

/** Human expansion is read-only. Only the provider's batch-read receipt changes unread state. */
export function ChatInboxGroup({ item, sessionId, profileScope }: {
  item: SystemItem; sessionId: string; profileScope: WorkspaceProfileScope | null
}) {
  useLocale()
  const available = useAppStore(state => chatMailboxAvailable(state.health))
  const [open, setOpen] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(25)
  const [loaded, setLoaded] = useState<Record<string, ChatInboxMessage>>({})
  const [details, setDetails] = useState<Record<string, CrossChatHandoff>>({})
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set())
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set())
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const children = item.mailboxMessages ?? [item]
  useEffect(() => {
    generation.current++
    setOpen(false); setVisibleLimit(25); setLoaded({}); setDetails({}); setExpandedMessages(new Set()); setDeleted(new Set()); setLoadedOnce(false); setLoadingMessage(null); setLoading(false); setDeleting(null); setError('')
    return () => { generation.current++ }
  }, [item.key, sessionId, profileScope?.profileId, profileScope?.profileGeneration, profileScope?.serverIdentity])
  const scopeCurrent = () => {
    const state = useAppStore.getState()
    return profileScope && state.activeProfileId === profileScope.profileId
      && state.profileGeneration === profileScope.profileGeneration
      && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === profileScope.serverIdentity
  }
  const effective = (child: SystemItem) => {
    const message = loaded[chatInboxMessageId(child.event)]
    return message && inboxMessageMatchesEvent(message, child.event) ? message : null
  }
  const detail = (child: SystemItem) => {
    const value = details[chatInboxMessageId(child.event)]
    return value?.message_revision === (child.event.message_revision ?? 0) ? value : null
  }
  const stateFor = (child: SystemItem) => {
    const states = [child.event.inbox_state, effective(child)?.state, detail(child)?.inbox_state]
    return (['deleted', 'cancelled', 'read', 'unread'] as const).find(state => states.includes(state)) ?? 'unread'
  }
  const visible = children.filter(child => !deleted.has(chatInboxMessageId(child.event))
    && stateFor(child) !== 'deleted')
  const unread = visible.filter(child => stateFor(child) === 'unread').length
  const countLabel = unread ? t('timeline.inbox.unreadCount', { count: unread })
    : t(visible.length === 1 ? 'timeline.inbox.oneMessage' : 'timeline.inbox.messageCount', { count: visible.length })
  const sender = item.event.source_title || t('timeline.ui.unknownAgent')
  const load = async () => {
    if (!available || !profileScope || loading || !scopeCurrent()) return
    const request = generation.current
    setLoading(true); setError('')
    try {
      const page = await window.agentsDock.chatInbox.list(profileScope, sessionId, null, 25)
      if (request !== generation.current || !scopeCurrent()) return
      setLoaded(current => ({ ...current, ...Object.fromEntries(page.messages.filter(message => children.some(child => inboxMessageMatchesEvent(message, child.event))).map(message => [message.message_id, message])) }))
      setLoadedOnce(true)
    } catch {
      if (request === generation.current && scopeCurrent()) setError(t('timeline.inbox.loadError'))
    } finally { if (request === generation.current && scopeCurrent()) setLoading(false) }
  }
  const loadMessage = async (child: SystemItem) => {
    if (loadingMessage || !scopeCurrent()) return
    const event = child.event, id = chatInboxMessageId(event), request = generation.current
    setLoadingMessage(id); setError('')
    try {
      const message = await window.agentsDock.handoffs.get(id)
      if (request !== generation.current || !scopeCurrent()) return
      if (message.id !== id || message.message_id !== id || message.delivery_mode !== 'mailbox'
        || message.conversation_mode !== 'async_route_v1' || message.conversation_id !== event.conversation_id
        || message.source_session_id !== event.source_session_id || message.target_session_id !== sessionId
        || message.message_revision !== (event.message_revision ?? 0)) throw Error('Wrong message')
      const body = message.message_revision! > 0 ? message.target_body : message.body
      if (typeof body !== 'string' || message.message_revision! > 0 && message.message_edited_by_user !== true
        || event.handoff_body_sha256 && bytesToHex(sha256(utf8ToBytes(body))) !== event.handoff_body_sha256.toLowerCase()) throw Error('Wrong message body')
      setDetails(current => ({ ...current, [id]: { ...message, body } }))
      setExpandedMessages(current => new Set([...current, id]))
    } catch {
      if (request === generation.current && scopeCurrent()) setError(t('timeline.inbox.loadError'))
    } finally { if (request === generation.current && scopeCurrent()) setLoadingMessage(null) }
  }
  const remove = async (messageId: string) => {
    if (!available || !profileScope || deleting || !scopeCurrent()) return
    const request = generation.current
    setDeleting(messageId); setError('')
    try {
      const receipt = await window.agentsDock.chatInbox.remove(profileScope, sessionId, messageId)
      if (request !== generation.current || !scopeCurrent()) return
      if (receipt.ok !== true || receipt.session_id !== sessionId || receipt.message_id !== messageId || receipt.state !== 'deleted') throw Error('Receipt mismatch')
      setDeleted(current => new Set([...current, messageId]))
    } catch {
      if (request === generation.current && scopeCurrent()) setError(t('timeline.inbox.deleteError'))
    } finally { if (request === generation.current && scopeCurrent()) setDeleting(null) }
  }
  if (!visible.length) return null
  const latest = visible.at(-1)!
  return <article className="cross-chat-message incoming chat-inbox-group" data-message-ids={visible.map(child => chatInboxMessageId(child.event)).join(' ')}>
    <div className="cross-chat-message-surface">
      <div className="chat-inbox-heading">
        <Inbox size={14} aria-hidden="true" />
        <CrossChatPeerLink peerId={item.event.source_session_id} sessionId={sessionId} profileScope={profileScope}>{sender}</CrossChatPeerLink>
        <button type="button" className="chat-inbox-toggle" aria-expanded={open} aria-label={`${sender} · ${countLabel}`} onClick={() => {
        setOpen(!open)
        if (!open && !loadedOnce) void load()
      }}>
          <span>· {countLabel}</span><ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      {!open && <p className="chat-inbox-preview">{(latest.event.handoff_preview || latest.event.message_body || '').slice(0, 240)}</p>}
      {open && <div className="chat-inbox-messages">
        {visible.slice(0, visibleLimit).map(child => {
          const event = child.event, id = chatInboxMessageId(event), message = effective(child)
          const state = stateFor(child)
          const full = detail(child)
          const body = full?.body ?? message?.body ?? event.message_body ?? event.handoff_preview ?? ''
          const expanded = expandedMessages.has(id)
          const needsFetch = !full && !message && !event.message_body && event.handoff_body_truncated
          const hasMore = needsFetch || body.length > 800
          const reply = event.reply_to_message_id ?? message?.reply_to_message_id
          return <section className="chat-inbox-message" key={id} data-message-id={id}>
            <header><time>{formatTime(event.received_at || message?.received_at || child.anchorTs || event.ts)}</time>
              <small>{t(`timeline.inbox.${state}`)}</small>
              <button className="icon-button danger" type="button" disabled={!available || Boolean(deleting)}
                aria-label={t('timeline.inbox.deleteMessage')} onClick={() => void remove(id)}><Trash2 size={13} /></button>
            </header>
            {reply && <small className="chat-inbox-reply" title={reply}>{t('timeline.inbox.replyTo', { id: reply.slice(-12) })}</small>}
            <div className={expanded ? 'chat-inbox-body expanded' : 'chat-inbox-body'}>
              <MarkdownContent text={expanded ? body : body.slice(0, 800)} sessionId={sessionId} fold={false} />
            </div>
            {hasMore
              && <button className="cross-chat-message-expand" disabled={Boolean(loadingMessage)} onClick={() => {
                if (!expanded && needsFetch) { void loadMessage(child); return }
                setExpandedMessages(current => {
                  const next = new Set(current)
                  if (expanded) next.delete(id); else next.add(id)
                  return next
                })
              }}>
                {loadingMessage === id ? t('timeline.ui.loadingFullMessage') : expanded ? t('timeline.ui.showLess') : t('timeline.ui.viewMessage')}</button>}
          </section>
        })}
        {loading && <small className="chat-inbox-loading"><LoaderCircle size={12} className="spin" />{t('timeline.inbox.loading')}</small>}
        {visible.length > visibleLimit && <button className="quiet-button" onClick={() => setVisibleLimit(limit => limit + 25)}>{t('timeline.inbox.showMore')}</button>}
        {!available && <small>{t('timeline.inbox.updateServer')}</small>}
      </div>}
      {error && <small role="alert" className="cross-chat-message-error">{error}</small>}
    </div>
  </article>
}
