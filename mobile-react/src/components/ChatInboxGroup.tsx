import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ChevronDown, MessageSquareShare } from 'lucide-react-native'
import { authenticatedChatMessageBody, chatMessageBodyHashMatches } from '../lib/chat-message-body'
import { chatInboxMessageId, chatMailboxAvailable, inboxMessageMatchesEvent, isChatMailboxEvent, parseChatInboxDelete, parseChatInboxPage } from '../lib/chat-mailbox'
import { formatDateTime } from '../lib/format'
import type { SystemRow } from '../lib/timeline'
import type { ChatInboxState, Event } from '../types'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { captureTimelineWorkspaceScope, timelineWorkspaceScopeCurrent, useTimelineWorkspaceRevision } from './CrossChatTimelineCards'
import { MarkdownContent } from './MarkdownContent'

const BATCH = 25
const PREVIEW = 800
const stateOrder: ChatInboxState[] = ['unread', 'read', 'cancelled', 'deleted']
const highestState = (...states: Array<ChatInboxState | null | undefined>): ChatInboxState =>
  stateOrder[Math.max(0, ...states.map(state => state ? stateOrder.indexOf(state) : 0))]
const identityKey = (event: Event) => JSON.stringify([chatInboxMessageId(event), event.source_session_id, event.target_session_id, event.conversation_id])
const bodyKey = (event: Event) => JSON.stringify([identityKey(event), event.message_revision ?? 0, event.message_edited_by_user === true, event.handoff_body_sha256, event.message_body, event.handoff_preview])
const edited = (event: Event) => event.message_edited_by_user === true || (event.message_revision ?? 0) > 0
function eventState(event: Event): ChatInboxState {
  return highestState(event.inbox_state, event.type.endsWith('_deleted') ? 'deleted' : event.type.endsWith('_cancelled') ? 'cancelled' : event.type.endsWith('_read') ? 'read' : 'unread')
}
const childStates = (child: SystemRow) => (child.events ?? [])
  .filter(event => isChatMailboxEvent(event) && identityKey(event) === identityKey(child.event)).map(eventState)
function admissionTime(child: SystemRow): string {
  const lifecycle = [child.event, ...child.events ?? []]
    .filter(event => isChatMailboxEvent(event) && identityKey(event) === identityKey(child.event))
  const candidates = [child.anchorTs, ...lifecycle.flatMap(event => [event.received_at,
    /_(received|mailbox_migrated)$/u.test(event.type) ? event.ts : null])]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
  // A read/cancel/delete timestamp is not a new arrival. Missing admission
  // metadata stays blank instead of presenting a later lifecycle update as mail.
  return candidates.length ? formatDateTime(candidates.reduce((first, value) => Date.parse(value) < Date.parse(first) ? value : first)) : ''
}
function inlineBody(event: Event): string {
  if (typeof event.message_body === 'string') {
    return !event.handoff_body_sha256 || chatMessageBodyHashMatches(event.message_body, event.handoff_body_sha256) ? event.message_body : ''
  }
  // A provider preview is not evidence of the current user-edited recipient body.
  return edited(event) ? '' : event.handoff_preview ?? ''
}
type LoadedBody = { key: string; body: string }
type WorkspaceScope = ReturnType<typeof captureTimelineWorkspaceScope>

/** Expanding this passive inbox performs GETs only. Unread changes require server receipts. */
export function ChatInboxGroup({ row, sessionId, fontScale, layoutWidth }: {
  row: SystemRow; sessionId: string; fontScale: number; layoutWidth: number
}) {
  const colors = usePalette()
  const available = useAppStore(state => chatMailboxAvailable(state.health))
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const scopeKey = JSON.stringify([row.key, sessionId, workspaceRevision])
  const seen = new Set<string>()
  const children = (row.mailboxMessages ?? [row]).filter(child => {
    const event = child.event, id = chatInboxMessageId(event)
    if (!id || seen.has(id) || !isChatMailboxEvent(event) || !event.conversation_id
      || !event.source_session_id || event.source_session_id !== row.event.source_session_id || event.source_session_id === sessionId
      || event.target_session_id !== row.event.target_session_id || event.target_session_id !== sessionId || event.session_id !== sessionId) return false
    seen.add(id)
    return true
  })
  const [stateScope, setStateScope] = useState(scopeKey)
  const [isOpen, setOpen] = useState(false)
  const open = stateScope === scopeKey && isOpen
  const [visibleLimit, setVisibleLimit] = useState(BATCH)
  const [bodies, setBodies] = useState<Record<string, LoadedBody>>({})
  const [states, setStates] = useState<Record<string, ChatInboxState>>({})
  const [expandedBodies, setExpandedBodies] = useState<Set<string>>(() => new Set())
  const [page, setPage] = useState({ loaded: false, hasMore: false, cursor: null as string | null })
  const [loading, setLoading] = useState(false)
  const [loadingBody, setLoadingBody] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const paging = useRef(false)
  const bodyRequest = useRef<string | null>(null)
  const deleteRequest = useRef<string | null>(null)
  const showingMore = useRef(false)
  const cursors = useRef(new Set<string>())
  const deletedIdentities = useRef(new Set<string>())
  const current = useRef({ rowKey: row.key, workspaceRevision, children })
  current.current = { rowKey: row.key, workspaceRevision, children }
  useEffect(() => {
    generation.current++
    paging.current = false; bodyRequest.current = null; deleteRequest.current = null; showingMore.current = false; cursors.current.clear(); deletedIdentities.current.clear()
    setStateScope(scopeKey); setOpen(false); setVisibleLimit(BATCH); setBodies({}); setStates({}); setExpandedBodies(new Set())
    setPage({ loaded: false, hasMore: false, cursor: null }); setLoading(false); setLoadingBody(null); setDeleting(null); setError('')
    return () => { generation.current++ }
  }, [row.key, sessionId, workspaceRevision])
  useEffect(() => { showingMore.current = false }, [visibleLimit])
  const childrenRevision = JSON.stringify(children.map(child => [identityKey(child.event), eventState(child.event), childStates(child)]))
  useEffect(() => {
    setStates(previous => {
      const next = { ...previous }
      for (const child of current.current.children) {
        const key = identityKey(child.event)
        next[key] = highestState(previous[key], eventState(child.event), ...childStates(child))
      }
      return Object.keys(next).some(key => next[key] !== previous[key]) ? next : previous
    })
  }, [childrenRevision, workspaceRevision, row.key])

  const networkCurrent = (scope: WorkspaceScope) => {
    const state = useAppStore.getState()
    return scope.connected && scope.connection.isValidated && !state.connecting
      && chatMailboxAvailable(state.health) && timelineWorkspaceScopeCurrent(scope)
  }
  const operationCurrent = (scope: WorkspaceScope, epoch: number) => epoch === generation.current
    && current.current.rowKey === row.key && current.current.workspaceRevision === workspaceRevision && networkCurrent(scope)
  const currentChild = (event: Event) => current.current.children.find(child => bodyKey(child.event) === bodyKey(event))
  const localCurrent = () => current.current.rowKey === row.key && current.current.workspaceRevision === workspaceRevision
  const bodyFor = (child: SystemRow) => {
    if (stateScope !== scopeKey) return null
    const cached = bodies[chatInboxMessageId(child.event)]
    return cached?.key === bodyKey(child.event) ? cached.body : null
  }
  const stateFor = (child: SystemRow) => highestState(stateScope === scopeKey ? states[identityKey(child.event)] : undefined, eventState(child.event), ...childStates(child))
  const visible = children.filter(child => stateFor(child) !== 'deleted')
  const unread = visible.filter(child => stateFor(child) === 'unread').length
  const sender = row.event.source_title?.trim() || 'Unknown agent'
  const countLabel = unread ? `${unread} unread` : `${visible.length} message${visible.length === 1 ? '' : 's'}`

  const loadPage = async (cursor: string | null) => {
    const scope = captureTimelineWorkspaceScope(sessionId), epoch = generation.current
    if (paging.current || !localCurrent() || !networkCurrent(scope)) return
    paging.current = true; setLoading(true); setError('')
    try {
      const next = parseChatInboxPage(await scope.connection.chatInbox(sessionId, cursor, BATCH), sessionId, BATCH)
      if (!operationCurrent(scope, epoch)) return
      if (next.has_more && (cursors.current.has(next.next_cursor!) || BigInt(next.next_cursor!) <= BigInt(cursor ?? '-1'))) {
        throw new Error('The inbox cursor did not advance. Retry after refreshing the chat.')
      }
      const matched = next.messages.flatMap(message => {
        const child = current.current.children.find(value => inboxMessageMatchesEvent(message, value.event))
        if (!child) return []
        if (!chatMessageBodyHashMatches(message.body, message.body_sha256)
          || child.event.handoff_body_sha256 && !chatMessageBodyHashMatches(message.body, child.event.handoff_body_sha256)) {
          throw new Error('The inbox body does not match its recorded revision. Retry after refreshing the chat.')
        }
        return [{ message, event: child.event }]
      })
      setBodies(previous => ({ ...previous, ...Object.fromEntries(matched.map(({ message, event }) => [message.message_id, { key: bodyKey(event), body: message.body }])) }))
      setStates(previous => {
        const nextStates = { ...previous }
        for (const { message, event } of matched) nextStates[identityKey(event)] = highestState(previous[identityKey(event)], eventState(event), message.state)
        return nextStates
      })
      for (const { message, event } of matched) if (message.state === 'deleted') deletedIdentities.current.add(identityKey(event))
      if (next.next_cursor) cursors.current.add(next.next_cursor)
      setPage({ loaded: true, hasMore: next.has_more, cursor: next.next_cursor })
    } catch (cause) {
      if (operationCurrent(scope, epoch)) setError(cause instanceof Error ? cause.message : 'Could not load the inbox. Try again.')
    } finally {
      if (epoch === generation.current) { paging.current = false; if (localCurrent()) setLoading(false) }
    }
  }
  const loadBody = async (child: SystemRow) => {
    const event = child.event, id = chatInboxMessageId(event), key = bodyKey(event)
    const scope = captureTimelineWorkspaceScope(sessionId), epoch = generation.current
    if (bodyRequest.current || !localCurrent() || !currentChild(event) || !networkCurrent(scope)) return
    bodyRequest.current = key; setLoadingBody(id); setError('')
    try {
      const detail = await scope.connection.crossChatHandoff(id)
      if (!operationCurrent(scope, epoch) || !currentChild(event)) return
      const body = authenticatedChatMessageBody(detail, {
        messageId: id, sourceSessionId: event.source_session_id!, targetSessionId: sessionId,
        conversationId: event.conversation_id!, messageRevision: event.message_revision ?? 0,
        editedByUser: event.message_edited_by_user === true, incoming: true, mailbox: true,
        bodyHash: event.handoff_body_sha256 ?? undefined,
      })
      setBodies(previous => ({ ...previous, [id]: { key, body } }))
      setStates(previous => ({ ...previous, [identityKey(event)]: highestState(previous[identityKey(event)], eventState(event), detail.inbox_state) }))
      setExpandedBodies(previous => new Set([...previous, key]))
    } catch (cause) {
      if (operationCurrent(scope, epoch) && currentChild(event)) setError(cause instanceof Error ? cause.message : 'Could not load this message. Try again.')
    } finally {
      if (epoch === generation.current && bodyRequest.current === key) { bodyRequest.current = null; if (localCurrent()) setLoadingBody(null) }
    }
  }
  const remove = async (child: SystemRow) => {
    const event = child.event, id = chatInboxMessageId(event), key = bodyKey(event)
    const scope = captureTimelineWorkspaceScope(sessionId), epoch = generation.current
    const latest = currentChild(event)
    if (deleteRequest.current || deletedIdentities.current.has(identityKey(event)) || !localCurrent()
      || !latest || highestState(eventState(latest.event), ...childStates(latest)) === 'deleted' || !networkCurrent(scope)) return
    deleteRequest.current = key; setDeleting(id); setError('')
    try {
      const receipt = await scope.connection.deleteChatInboxMessage(sessionId, id)
      if (!operationCurrent(scope, epoch) || !currentChild(event)) return
      parseChatInboxDelete(receipt, sessionId, id)
      deletedIdentities.current.add(identityKey(event))
      setStates(previous => ({ ...previous, [identityKey(event)]: 'deleted' }))
    } catch (cause) {
      if (operationCurrent(scope, epoch) && currentChild(event)) setError(cause instanceof Error ? cause.message : 'Could not delete this message. Try again.')
    } finally {
      if (epoch === generation.current && deleteRequest.current === key) { deleteRequest.current = null; if (localCurrent()) setDeleting(null) }
    }
  }

  if (!visible.length) return null
  const latest = visible[visible.length - 1]
  const preview = bodyFor(latest) ?? inlineBody(latest.event)
  const canRequest = available && networkCurrent(captureTimelineWorkspaceScope(sessionId))
  const errorContent = stateScope === scopeKey && error ? <View><Text testID="chat-inbox-error" accessibilityRole="alert" numberOfLines={open ? undefined : 1} style={{ color: colors.red }}>{error}</Text>
    {open && canRequest ? <Pressable testID="chat-inbox-retry" accessibilityRole="button" disabled={loading} onPress={() => void loadPage(page.loaded ? page.cursor : null)} style={styles.control}><Text style={{ color: colors.blue }}>Retry inbox</Text></Pressable> : null}
  </View> : null
  return <View testID="chat-inbox" style={[styles.card, { width: layoutWidth > 720 ? '82%' : '94%', backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Pressable testID="chat-inbox-toggle" accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${sender} inbox. ${countLabel}. ${open ? 'Hide' : 'Show'} messages`} onPress={() => {
      if (!localCurrent()) return
      setOpen(value => !value)
      if (!open && !page.loaded) void loadPage(null)
    }} style={styles.heading}>
      <MessageSquareShare size={16} color={colors.blue} />
      <View style={styles.grow}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, styles.grow, { color: colors.text }]} numberOfLines={1}>{sender}</Text>
          <Text testID="chat-inbox-count" style={[styles.title, { color: colors.text }]}>· {countLabel}</Text>
        </View>
        {!open ? <Text testID="chat-inbox-preview" style={{ color: colors.muted }} numberOfLines={1} ellipsizeMode="tail">{preview.slice(0, 240) || 'Open to load the current message.'}</Text> : null}
      </View>
      <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }} />
    </Pressable>
    {open ? <ScrollView testID="chat-inbox-list" style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled keyboardShouldPersistTaps="always">
      {visible.slice(0, visibleLimit).map(child => {
        const event = child.event, id = chatInboxMessageId(event), key = bodyKey(event)
        const cached = bodyFor(child), body = cached ?? inlineBody(event), expanded = expandedBodies.has(key)
        const needsFetch = cached === null && (!body || event.handoff_body_truncated === true || (event.handoff_body_chars ?? 0) > body.length)
        const received = admissionTime(child)
        return <View key={identityKey(event)} testID={`chat-inbox-message-${id}`} style={[styles.message, { borderColor: colors.border }]}>
          <View style={styles.messageHeading}>
            <View style={styles.grow}>
              {received ? <Text testID={`chat-inbox-time-${id}`} style={{ color: colors.muted }} numberOfLines={1}>{received}</Text> : null}
              <Text testID={`chat-inbox-state-${id}`} style={{ color: colors.muted }}>{stateFor(child)}</Text>
            </View>
            <Pressable testID={`chat-inbox-delete-${id}`} accessibilityRole="button" accessibilityLabel="Delete inbox message" accessibilityState={{ disabled: !canRequest || Boolean(deleting), busy: deleting === id }} disabled={!canRequest || Boolean(deleting)} onPress={() => void remove(child)} style={styles.control}>
              {deleting === id ? <ActivityIndicator size="small" color={colors.red} /> : <Text style={{ color: colors.red }}>Delete</Text>}
            </Pressable>
          </View>
          {event.reply_to_message_id ? <Text style={{ color: colors.muted }} numberOfLines={1}>Reply to {event.reply_to_message_id.slice(-12)}</Text> : null}
          <ScrollView testID={`chat-inbox-body-${id}`} style={expanded ? styles.fullBody : styles.previewBody} nestedScrollEnabled keyboardShouldPersistTaps="always">
            {body ? <MarkdownContent value={expanded ? body : body.slice(0, PREVIEW)} compact fontScale={fontScale} sourceSessionId={sessionId} /> : <Text style={{ color: colors.muted }}>Open to load the current message.</Text>}
          </ScrollView>
          {needsFetch || body.length > PREVIEW ? <Pressable testID={`chat-inbox-expand-${id}`} accessibilityRole="button" accessibilityState={{ expanded, disabled: Boolean(loadingBody) || needsFetch && !canRequest }} disabled={Boolean(loadingBody) || needsFetch && !canRequest} onPress={() => {
            if (!localCurrent() || !currentChild(event)) return
            if (!expanded && needsFetch) { void loadBody(child); return }
            setExpandedBodies(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })
          }} style={styles.control}><Text style={{ color: colors.blue }}>{loadingBody === id ? 'Loading message…' : expanded ? 'Show less' : 'View message'}</Text></Pressable> : null}
        </View>
      })}
      {loading ? <ActivityIndicator testID="chat-inbox-loading" size="small" color={colors.blue} /> : null}
      {visible.length > visibleLimit || page.hasMore ? <Pressable testID="chat-inbox-more" accessibilityRole="button" accessibilityState={{ disabled: loading || !canRequest && visible.length <= visibleLimit }} disabled={loading || !canRequest && visible.length <= visibleLimit} onPress={() => {
        if (!localCurrent() || paging.current || showingMore.current || !canRequest && visible.length <= visibleLimit) return
        showingMore.current = true; setVisibleLimit(limit => limit + BATCH)
        if (page.hasMore && canRequest) void loadPage(page.cursor)
      }} style={styles.control}><Text style={{ color: colors.blue }}>Show more</Text></Pressable> : null}
      {!canRequest ? <Text style={{ color: colors.muted }}>Cached inbox. Connect to a server with mailbox support to load or delete messages.</Text> : null}
      {errorContent}
    </ScrollView> : null}
    {!open ? errorContent : null}
  </View>
}

const styles = StyleSheet.create({
  card: { alignSelf: 'flex-end', maxWidth: 760, minWidth: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  heading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontSize: 12, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  list: { maxHeight: 320 },
  listContent: { gap: 8, paddingBottom: 6 },
  message: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4, gap: 4 },
  messageHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  control: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center' },
  previewBody: { maxHeight: 120 },
  fullBody: { maxHeight: 220 },
})
