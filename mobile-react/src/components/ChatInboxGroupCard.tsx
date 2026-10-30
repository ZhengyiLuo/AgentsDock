import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react-native'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { ChatInboxMessage, CrossChatHandoff } from '../types'
import type { SystemRow } from '../lib/timeline'
import { chatInboxMessageId, chatMailboxAvailable, inboxMessageMatchesEvent } from '../lib/chat-inbox'
import { useAppStore } from '../store/useAppStore'
import { spacing, typography, usePalette } from '../theme'
import { Text } from './AppText'
import {
  captureTimelineWorkspaceScope, CrossChatAction, CrossChatMessageSurface, CrossChatMessageText,
  CrossChatPeerHeader, crossChatTextPrefix, formatCrossChatTime, InlineError, timelineWorkspaceScopeCurrent, useTimelineWorkspaceRevision,
} from './CrossChatTimelineCards'

/** Human disclosure is read-only; only provider batch-read receipts mark mail read. */
export function ChatInboxGroupCard({ row, sessionId, fontScale, layoutWidth }: {
  row: SystemRow; sessionId: string; fontScale: number; layoutWidth: number
}) {
  const colors = usePalette()
  const available = useAppStore(state => state.connected && chatMailboxAvailable(state.health))
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const children = row.mailboxMessages ?? [row]
  const latestChildren = useRef(children)
  latestChildren.current = children
  const [open, setOpen] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(25)
  const [loaded, setLoaded] = useState<Record<string, ChatInboxMessage>>({})
  const [details, setDetails] = useState<Record<string, CrossChatHandoff>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set())
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const loadingRef = useRef(false), loadingMessageRef = useRef<string | null>(null), deletingRef = useRef<string | null>(null)
  useEffect(() => {
    generation.current++
    loadingRef.current = false; loadingMessageRef.current = null; deletingRef.current = null
    setOpen(false); setVisibleLimit(25); setLoaded({}); setDetails({}); setExpanded(new Set()); setDeleted(new Set())
    setLoadedOnce(false); setLoading(false); setLoadingMessage(null); setDeleting(null); setError('')
    return () => { generation.current++ }
  }, [row.key, sessionId, workspaceRevision])
  const effective = (child: SystemRow) => {
    const value = loaded[chatInboxMessageId(child.event)]
    return value && inboxMessageMatchesEvent(value, child.event) ? value : null
  }
  const detail = (child: SystemRow) => {
    const value = details[chatInboxMessageId(child.event)]
    return value?.message_revision === (child.event.message_revision ?? 0) ? value : null
  }
  const stateFor = (child: SystemRow) => {
    const states = [child.event.inbox_state, effective(child)?.state, detail(child)?.inbox_state]
    return (['deleted', 'cancelled', 'read', 'unread'] as const).find(value => states.includes(value)) ?? 'unread'
  }
  const visible = children.filter(child => !deleted.has(chatInboxMessageId(child.event)) && stateFor(child) !== 'deleted')
  const unread = visible.filter(child => stateFor(child) === 'unread').length
  const sender = row.event.source_title || 'Unknown agent'
  const countLabel = unread ? `${unread} unread` : `${visible.length} ${visible.length === 1 ? 'message' : 'messages'}`
  const identity = `cross-chat-inbox-${chatInboxMessageId(children[0]!.event)}`
  const load = async () => {
    if (!available || loadingRef.current) return
    const scope = captureTimelineWorkspaceScope(sessionId), request = generation.current
    if (!scope.connected || !timelineWorkspaceScopeCurrent(scope)) return
    loadingRef.current = true; setLoading(true); setError('')
    try {
      const page = await scope.connection.chatInbox(sessionId, null, 25)
      if (request !== generation.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (page.session_id !== sessionId || page.messages.length > 25) throw new Error('Wrong inbox')
      const matching = page.messages.filter(message => latestChildren.current.some(child => inboxMessageMatchesEvent(message, child.event)))
      for (const message of matching) {
        const expected = latestChildren.current.find(child => inboxMessageMatchesEvent(message, child.event))?.event.handoff_body_sha256
        const actual = bytesToHex(sha256(utf8ToBytes(message.body)))
        if (actual !== message.body_sha256.toLowerCase() || expected && actual !== expected.toLowerCase()) throw new Error('Wrong inbox message body')
      }
      setLoaded(current => ({ ...current, ...Object.fromEntries(matching.map(message => [message.message_id, message])) }))
      setLoadedOnce(true)
    } catch {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) setError('Could not load messages. Try again.')
    } finally {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) { loadingRef.current = false; setLoading(false) }
    }
  }
  const loadMessage = async (child: SystemRow) => {
    if (!available || loadingMessageRef.current) return
    const event = child.event, id = chatInboxMessageId(event), scope = captureTimelineWorkspaceScope(sessionId), request = generation.current
    if (!id || !scope.connected || !timelineWorkspaceScopeCurrent(scope)) return
    loadingMessageRef.current = id; setLoadingMessage(id); setError('')
    try {
      const message = await scope.connection.crossChatHandoff(id)
      if (request !== generation.current || !timelineWorkspaceScopeCurrent(scope)) return
      const latest = latestChildren.current.find(value => chatInboxMessageId(value.event) === id)?.event
      if (!latest || (latest.message_revision ?? 0) !== (event.message_revision ?? 0)
        || message.id !== id || message.message_id !== id || message.delivery_mode !== 'mailbox'
        || message.conversation_mode !== 'async_route_v1' || message.conversation_id !== event.conversation_id
        || message.source_session_id !== event.source_session_id || message.target_session_id !== sessionId
        || message.message_revision !== (event.message_revision ?? 0)) throw new Error('Wrong message')
      const body = message.message_revision! > 0 ? message.target_body : message.body
      if (typeof body !== 'string' || message.message_revision! > 0 && message.message_edited_by_user !== true
        || event.handoff_body_sha256 && bytesToHex(sha256(utf8ToBytes(body))) !== event.handoff_body_sha256.toLowerCase()) throw new Error('Wrong message body')
      setDetails(current => ({ ...current, [id]: { ...message, body } }))
      setExpanded(current => new Set([...current, id]))
    } catch {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) setError('Could not load this message. Try again.')
    } finally {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) { loadingMessageRef.current = null; setLoadingMessage(null) }
    }
  }
  const remove = async (id: string) => {
    if (!available || deletingRef.current || !latestChildren.current.some(child => chatInboxMessageId(child.event) === id && child.event.target_session_id === sessionId)) return
    const scope = captureTimelineWorkspaceScope(sessionId), request = generation.current
    if (!scope.connected || !timelineWorkspaceScopeCurrent(scope)) return
    deletingRef.current = id; setDeleting(id); setError('')
    try {
      const receipt = await scope.connection.deleteChatInboxMessage(sessionId, id)
      if (request !== generation.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (receipt.ok !== true || receipt.session_id !== sessionId || receipt.message_id !== id || receipt.state !== 'deleted') throw new Error('Wrong deletion receipt')
      setDeleted(current => new Set([...current, id]))
    } catch {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) setError('Could not delete this message. Try again.')
    } finally {
      if (request === generation.current && timelineWorkspaceScopeCurrent(scope)) { deletingRef.current = null; setDeleting(null) }
    }
  }
  if (!visible.length) return null
  const latest = visible[visible.length - 1]!
  return <CrossChatMessageSurface testID={identity} incoming layoutWidth={layoutWidth}>
    <CrossChatPeerHeader peerId={row.event.source_session_id} title={sender} sessionId={sessionId} />
    <Pressable testID={`${identity}-toggle`} accessibilityRole="button" accessibilityLabel={`${sender} · ${countLabel}`}
      accessibilityState={{ expanded: open }} onPress={() => { setOpen(value => !value); if (!open && !loadedOnce) void load() }}
      style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.meta, { color: colors.crossChatControl }]} localize>{countLabel}</Text>
      {open ? <ChevronDown size={16} color={colors.crossChatControl} /> : <ChevronRight size={16} color={colors.crossChatControl} />}
    </Pressable>
    {!open ? <Text selectable testID={`${identity}-preview`} style={[styles.meta, { color: colors.muted }]}>{crossChatTextPrefix(latest.event.handoff_preview || latest.event.message_body || '', 240)}</Text> : null}
    {open ? <View style={styles.messages}>
      {visible.slice(0, visibleLimit).map(child => {
        const event = child.event, id = chatInboxMessageId(event), message = effective(child), full = detail(child)
        const body = full?.body ?? message?.body ?? event.message_body ?? event.handoff_preview ?? ''
        const isExpanded = expanded.has(id), state = stateFor(child)
        const needsFetch = !full && !message && (event.handoff_body_truncated === true || (event.handoff_body_chars ?? 0) > body.length)
        const hasMore = needsFetch || body.length > 800
        const reply = event.reply_to_message_id ?? message?.reply_to_message_id
        const messageIdentity = `cross-chat-async-message-${id}`
        return <View key={id} testID={messageIdentity} style={[styles.message, { borderTopColor: colors.crossChatBorder }]}>
          <View style={styles.messageHeader}>
            <Text style={[styles.meta, { color: colors.muted }]}>{formatCrossChatTime(event.received_at || message?.received_at || child.anchorTs || event.ts)}</Text>
            <Text style={[styles.meta, { color: colors.muted }]} localize>{state === 'unread' ? 'Unread' : state === 'read' ? 'Read' : 'Cancelled'}</Text>
            <Pressable testID={`${messageIdentity}-delete`} accessibilityRole="button" accessibilityLabel="Delete message"
              accessibilityState={{ disabled: !available || Boolean(deleting), busy: deleting === id }} disabled={!available || Boolean(deleting)}
              onPress={() => void remove(id)} style={({ pressed }) => [styles.delete, { opacity: !available || deleting || pressed ? 0.55 : 1 }]}>
              {deleting === id ? <ActivityIndicator size="small" color={colors.red} /> : <Trash2 size={16} color={colors.red} />}
            </Pressable>
          </View>
          {reply ? <Text style={[styles.meta, { color: colors.muted }]} localize>Reply to {reply.slice(-12)}</Text> : null}
          {event.message_edited_by_user ? <Text style={[styles.meta, { color: colors.muted }]} localize>Edited by you</Text> : null}
          <CrossChatMessageText identity={`${messageIdentity}:${event.message_revision ?? 0}`} text={isExpanded ? body : crossChatTextPrefix(body, 800)} fontScale={fontScale} />
          {hasMore ? <CrossChatAction testID={`${messageIdentity}-toggle`} label={loadingMessage === id ? 'Loading full message…' : isExpanded ? 'Show less' : 'View message'}
            disabled={Boolean(loadingMessage) || needsFetch && !available} expanded={isExpanded} onPress={() => {
              if (!isExpanded && needsFetch) { void loadMessage(child); return }
              setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
            }} /> : null}
        </View>
      })}
      {loading ? <ActivityIndicator accessibilityLabel="Loading messages" size="small" color={colors.crossChatControl} /> : null}
      {visible.length > visibleLimit ? <CrossChatAction testID={`${identity}-more`} label="Show more messages" onPress={() => setVisibleLimit(value => value + 25)} /> : null}
      {!available ? <Text style={[styles.meta, { color: colors.muted }]} localize>Reconnect to a server with chat inbox support to manage these messages.</Text> : null}
      {error && !loading && !loadedOnce ? <CrossChatAction testID={`${identity}-retry`} label="Retry loading" onPress={() => void load()} disabled={!available} /> : null}
    </View> : null}
    {error ? <InlineError message={error} /> : null}
  </CrossChatMessageSurface>
}

const styles = StyleSheet.create({
  toggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meta: { ...typography.caption },
  messages: { minWidth: 0, gap: spacing.sm },
  message: { minWidth: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.xs },
  messageHeader: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  delete: { minWidth: 44, minHeight: 44, marginLeft: 'auto', alignItems: 'center', justifyContent: 'center' },
})
