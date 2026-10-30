import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import { AlertTriangle, MessageSquareShare } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { exactQueuedDeliverySkipAvailable } from '../lib/chat-references'
import { chatMailboxAvailable } from '../lib/chat-inbox'
import { messageText } from '../lib/format'
import { timelineChatReferenceIsRemote, timelineChatReferenceKey } from '../lib/timeline-inline-references'
import type {
  ChatReference,
  CrossChatExchange,
  CrossChatExchangeLeg,
  CrossChatExchangeStatus,
  Event,
} from '../types'
import { client, useAppStore } from '../store/useAppStore'
import { fontWeight, radius, typography, usePalette } from '../theme'
import { Text } from './AppText'
import { MarkdownContent } from './MarkdownContent'

const CROSS_CHAT_BODY_CHUNK = 4_000
const CROSS_CHAT_INLINE_TEXT_LIMIT = 2_000
const CROSS_CHAT_LONG_MESSAGE_CHARS = 640
const CROSS_CHAT_LONG_MESSAGE_LINES = 10
const EMPTY_READ_ONLY_REFERENCE_KEYS: ReadonlySet<string> = new Set()

const crossChatTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

interface TimelineWorkspaceScope {
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  connected: boolean
  sessionId: string
  connection: AgentServerClient
  validationRevision: number
  serverInstanceId: string | null
}

export function captureTimelineWorkspaceScope(sessionId: string): TimelineWorkspaceScope {
  const state = useAppStore.getState()
  return {
    profileId: state.activeProfileId,
    profileGeneration: state.profileGeneration,
    serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
    connected: state.connected,
    sessionId,
    connection: client,
    validationRevision: client.validationRevision,
    serverInstanceId: state.health?.server_instance_id?.trim() || null,
  }
}

export function timelineWorkspaceScopeCurrent(scope: TimelineWorkspaceScope): boolean {
  const state = useAppStore.getState()
  return client === scope.connection
    && scope.connection.validationRevision === scope.validationRevision
    && state.connected === scope.connected
    && state.activeProfileId === scope.profileId
    && state.profileGeneration === scope.profileGeneration
    && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === scope.serverIdentity
    && (state.health?.server_instance_id?.trim() || null) === scope.serverInstanceId
    && state.selectedSessionId === scope.sessionId
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function timelineWorkspaceProfileCurrent(scope: TimelineWorkspaceScope): boolean {
  const state = useAppStore.getState()
  return client === scope.connection
    && scope.connection.validationRevision === scope.validationRevision
    && state.connected === scope.connected
    && state.activeProfileId === scope.profileId
    && state.profileGeneration === scope.profileGeneration
    && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === scope.serverIdentity
    && (state.health?.server_instance_id?.trim() || null) === scope.serverInstanceId
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

export function useTimelineWorkspaceRevision(sessionId: string): string {
  return useAppStore(state => JSON.stringify([
    state.activeProfileId,
    state.profileGeneration,
    state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
    state.connected,
    state.connecting,
    state.switchingProfileId,
    client.validationRevision,
    state.health?.server_instance_id?.trim() || null,
    state.selectedSessionId === sessionId,
    state.workspaceAdopting,
  ]))
}

export function timelineActionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/iu, '')
    .replace(/^Error:\s*/iu, '')
    .trim()
}

function openTargetSession(
  targetSessionId: string,
  sourceSessionId: string,
  expectedGeneration: number,
  onError?: (message: string) => void,
): void {
  const scope = captureTimelineWorkspaceScope(sourceSessionId)
  const state = useAppStore.getState()
  if (
    scope.profileGeneration !== expectedGeneration
    || !timelineWorkspaceScopeCurrent(scope)
  ) {
    onError?.('This chat changed before the action could run. Try again from the current chat.')
    return
  }
  const target = state.sessions.find(session => session.id === targetSessionId)
  if (!target || target.archived) {
    onError?.('The referenced chat is not available in this server workspace.')
    return
  }
  void state.selectSession(targetSessionId, expectedGeneration).catch(error => {
    // selectedSessionId changes on successful navigation. Keep a failed
    // button action reportable while the authenticated profile remains bound.
    if (timelineWorkspaceProfileCurrent(scope)) onError?.(timelineActionError(error))
  })
}

/** All authenticated cross-chat paths share the same compact message treatment. */
export function CrossChatMessageSurface({ testID, incoming, layoutWidth = 640, children }: {
  testID: string; incoming: boolean; layoutWidth?: number; children: ReactNode
}) {
  const colors = usePalette()
  return <View testID={testID} style={styles.asyncMessage}>
    <View testID={`${testID}-surface`} style={[styles.asyncMessageSurface, {
      width: layoutWidth > 720 ? '82%' : '94%', alignSelf: incoming ? 'flex-end' : 'flex-start',
      backgroundColor: colors.crossChatSurface, borderColor: colors.crossChatBorder,
    }]}>{children}</View>
  </View>
}

/** A peer ID is authenticated event metadata; display names never create routes. */
export function CrossChatPeerHeader({ peerId, title, sessionId, time }: {
  peerId?: string | null; title: string; sessionId: string; time?: string
}) {
  const colors = usePalette()
  const generation = useAppStore(state => state.profileGeneration)
  const [error, setError] = useState('')
  const revision = useTimelineWorkspaceRevision(sessionId)
  useEffect(() => setError(''), [peerId, sessionId, revision])
  const target = peerId?.trim()
  return <>
    <View style={styles.asyncMessageHeader}>
      <MessageSquareShare size={13} color={colors.muted} />
      {target && target !== sessionId ? <Pressable
        testID={`cross-chat-peer-${target}`} accessibilityRole="button" accessibilityLabel={`Open ${title}`}
        onPress={() => { setError(''); openTargetSession(target, sessionId, generation, setError) }}
        style={({ pressed }) => [styles.peerLink, { opacity: pressed ? 0.7 : 1 }]}
      ><Text style={[styles.asyncMessageTitle, { color: colors.text }]} numberOfLines={2}>{title}</Text></Pressable>
        : <Text accessibilityRole="header" style={[styles.asyncMessageTitle, { color: colors.text }]} numberOfLines={2}>{title}</Text>}
      {time ? <Text style={[styles.conversationTime, { color: colors.muted }]}>{time}</Text> : null}
    </View>
    {error ? <InlineError prefix="Could not open referenced chat" message={error} /> : null}
  </>
}

/** Full supplied text stays available without parsing an unbounded Markdown tree. */
export function crossChatTextPrefix(text: string, limit: number): string {
  const end = limit < text.length && /[\uD800-\uDBFF]/u.test(text[limit - 1] ?? '') ? limit - 1 : limit
  return text.slice(0, end)
}

export function CrossChatMessageText({ identity, text, fontScale = 1 }: { identity: string; text: string; fontScale?: number }) {
  const colors = usePalette()
  const [limit, setLimit] = useRecyclingState(CROSS_CHAT_BODY_CHUNK, [identity, text])
  const visible = crossChatTextPrefix(text, limit)
  const hidden = text.length > visible.length
  return <>
    <MarkdownContent value={`${visible}${hidden ? '…' : ''}`} compact fontScale={fontScale} color={colors.text} />
    {hidden ? <CrossChatAction testID={`${identity}-more`} label="Show more" onPress={() => setLimit(value => Math.min(text.length, value + CROSS_CHAT_BODY_CHUNK))} /> : null}
  </>
}

export function CrossChatAction({ testID, label, onPress, disabled = false, expanded, destructive = false }: {
  testID: string; label: string; onPress: () => void; disabled?: boolean; expanded?: boolean; destructive?: boolean
}) {
  const colors = usePalette()
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, busy: disabled, ...(expanded === undefined ? {} : { expanded }) }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.conversationBodyToggle, { opacity: disabled ? 0.6 : pressed ? 0.72 : 1 }]}
  ><Text style={[styles.conversationBodyToggleText, { color: destructive ? colors.red : colors.crossChatControl }]} localize>{label}</Text></Pressable>
}

export function ChatReferenceChips({
  references,
  sessionId,
  readOnlyReferenceKeys = EMPTY_READ_ONLY_REFERENCE_KEYS,
}: {
  references: ChatReference[]
  sessionId: string
  readOnlyReferenceKeys?: ReadonlySet<string>
}) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const unique = useMemo(
    () => [...new Map(references.map(reference => [
      timelineChatReferenceKey(reference),
      reference,
    ])).values()],
    [references],
  )
  const identity = unique.map(reference => (
    `${timelineChatReferenceKey(reference)}:${readOnlyReferenceKeys.has(timelineChatReferenceKey(reference))}`
  )).join('|')
  const [openError, setOpenError] = useRecyclingState('', [profileGeneration, sessionId, identity])
  if (!unique.length) return null
  return <View accessibilityLabel="Referenced chats" style={styles.referenceList}>
    {unique.map(reference => {
      const key = timelineChatReferenceKey(reference)
      const remote = timelineChatReferenceIsRemote(reference)
      const readOnly = remote || readOnlyReferenceKeys.has(key)
      const label = `${timelineReferenceLabel(reference)}${remote ? ' · secure paired server' : ''}`
      const content = <>
        <MessageSquareShare size={13} color={readOnly ? colors.muted : colors.chatReferenceText} />
        <Text style={[styles.referenceText, { color: readOnly ? colors.muted : colors.chatReferenceText }]} numberOfLines={2} localize>
          {timelineReferencePrefix(reference)}
          <Text style={styles.referenceStrong}>{reference.display_title_snapshot}</Text>
          {remote ? ' · secure paired server' : ''}
        </Text>
      </>
      if (readOnly) return <View
        key={key}
        testID={`sent-chat-reference-${reference.session_id}-${reference.source_text_start}`}
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.referenceChip, { borderColor: colors.border, backgroundColor: colors.raised }]}
      >{content}</View>
      return <Pressable
        key={key}
        testID={`sent-chat-reference-${reference.session_id}-${reference.source_text_start}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => {
          setOpenError('')
          openTargetSession(reference.session_id, sessionId, profileGeneration, setOpenError)
        }}
        style={[styles.referenceChip, { borderColor: colors.chatReferenceBorder, backgroundColor: colors.chatReferenceSurface }]}
      >{content}</Pressable>
    })}
    {openError ? <InlineError prefix="Could not open referenced chat" message={openError} /> : null}
  </View>
}

function timelineReferencePrefix(reference: ChatReference): string {
  if (reference.action === 'direct_message') return 'Legacy chat reference to '
  if (reference.action === 'route') return 'Route hint for '
  if (reference.action === 'request_reply') return 'Reply expected from '
  if (reference.action === 'final_result') return 'Final result to '
  return 'Agent may send to '
}

function timelineReferenceLabel(reference: ChatReference): string {
  return `${timelineReferencePrefix(reference)}${reference.display_title_snapshot}`
}

interface CrossChatCardProps { event: Event; events?: Event[]; rowKey: string; sessionId: string; fontScale?: number; layoutWidth?: number; legId?: string; anchorTs?: string }

interface CrossChatMessageCardProps extends CrossChatCardProps { anchorTs?: string; layoutWidth?: number }

/** One explicit async message, with no legacy exchange or automatic-reply controls. */
export function CrossChatMessageCard(props: CrossChatMessageCardProps) {
  const profileGeneration = useAppStore(state => state.profileGeneration)
  return <CrossChatMessageCardScoped key={`${profileGeneration}:${props.sessionId}:${props.rowKey}`} {...props} profileGeneration={profileGeneration} />
}

function CrossChatMessageCardScoped({
  event, events, rowKey, sessionId, anchorTs, layoutWidth = 640, fontScale = 1, profileGeneration,
}: CrossChatMessageCardProps & { profileGeneration: number }) {
  const colors = usePalette()
  const mailboxAvailable = useAppStore(state => chatMailboxAvailable(state.health))
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const lifecycle = events?.length ? events : [event]
  const envelopeId = event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || event.message_id?.trim() || ''
  const conversationId = latestExchangeString(lifecycle, value => value.conversation_id)
  const sourceId = latestExchangeString(lifecycle, value => value.source_session_id)
  const targetId = latestExchangeString(lifecycle, value => value.target_session_id)
  const incoming = targetId === sessionId && sourceId !== sessionId
  const editedByUser = incoming && latestExchangeBoolean(lifecycle, value => value.message_edited_by_user) === true
  const messageRevision = editedByUser ? latestExchangeNumber(lifecycle, value => value.message_revision) : null
  const bodyEvents = editedByUser ? lifecycle.filter(value => value.message_edited_by_user === true && value.message_revision === messageRevision) : lifecycle
  const counterpartId = incoming ? sourceId : targetId
  const currentTitle = useAppStore(state => state.sessions.find(value => value.id === counterpartId)?.title)
  const savedTitle = latestExchangeString(lifecycle, value => incoming ? value.source_title : value.target_title)
  const counterpartTitle = savedTitle || currentTitle || 'Unknown agent'
  const preview = latestExchangeString(bodyEvents, value => value.handoff_preview)
  const bodyChars = latestExchangeNumber(bodyEvents, value => value.handoff_body_chars)
  const truncated = latestExchangeBoolean(bodyEvents, value => value.handoff_body_truncated) === true
  const bodyHash = latestExchangeString(bodyEvents, value => value.handoff_body_sha256)
  const moreBodyAvailable = truncated || (bodyChars ?? 0) > preview.length || /(?:…|\.\.\.)$/u.test(preview)
  const longBody = (bodyChars ?? preview.length) > CROSS_CHAT_LONG_MESSAGE_CHARS || preview.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
  const [body, setBody] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelledLocally, setCancelledLocally] = useState(false)
  const cancellingRef = useRef(false)
  const requestGeneration = useRef(0)
  const loadingRef = useRef(false)
  useEffect(() => {
    requestGeneration.current += 1
    loadingRef.current = false
    setBody(null)
    setExpanded(false)
    setLoading(false)
    setLoadError('')
    setCancelling(false)
    setCancelledLocally(false)
    cancellingRef.current = false
    return () => { requestGeneration.current += 1; loadingRef.current = false; cancellingRef.current = false }
  }, [rowKey, sessionId, profileGeneration, workspaceRevision, envelopeId, conversationId, sourceId, targetId, preview, bodyHash, editedByUser, messageRevision])

  const showFullMessage = async () => {
    if (loadingRef.current) return
    const scope = captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setLoadError('This chat changed before the detail request could run.')
      return
    }
    if (body !== null || !moreBodyAvailable) { setExpanded(true); return }
    // Identity comes from authenticated lifecycle data. Display labels are
    // never used to infer a participant, route, or body lookup target.
    if (!envelopeId || !conversationId || !sourceId || !targetId || (sourceId !== sessionId && targetId !== sessionId)) {
      setLoadError('This message is missing its conversation or participant identity.')
      return
    }
    const request = ++requestGeneration.current
    loadingRef.current = true
    setLoading(true)
    setLoadError('')
    try {
      const loaded = await scope.connection.crossChatHandoff(envelopeId)
      if (request !== requestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (loaded.id !== envelopeId || loaded.message_id !== envelopeId
        || loaded.conversation_id !== conversationId || loaded.conversation_mode !== 'async_route_v1') {
        throw new Error('AgentsServer returned the wrong handoff')
      }
      if (loaded.source_session_id !== sourceId || loaded.target_session_id !== targetId) {
        throw new Error('AgentsServer returned different message participants')
      }
      const effectiveBody = editedByUser ? loaded.target_body : loaded.body
      if (editedByUser && (messageRevision === null || !Number.isSafeInteger(messageRevision) || messageRevision < 1
        || loaded.message_edited_by_user !== true || loaded.message_revision !== messageRevision)) {
        throw new Error('The edited message body is no longer available for this revision.')
      }
      if (typeof effectiveBody !== 'string' || !effectiveBody.trim()) {
        throw new Error('AgentsServer did not return a message body')
      }
      setBody(effectiveBody)
      setExpanded(true)
    } catch (error) {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setLoadError(timelineActionError(error))
    } finally {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }
  const status = latestExchangeString(lifecycle, value => value.handoff_status)
  const failed = status === 'failed' || event.type === 'chat_conversation_message_failed'
  const cancelled = cancelledLocally || status === 'cancelled' || event.inbox_state === 'cancelled' || event.type === 'chat_conversation_message_cancelled'
  const text = expanded ? body ?? preview : longBody ? crossChatCollapsedText(preview) : preview
  const title = incoming ? counterpartTitle : `Sent to ${counterpartTitle}`
  const toggleLabel = loading ? 'Loading full message…' : expanded ? 'Show less' : 'View message'
  const identity = `cross-chat-async-message-${envelopeId || event.id}`
  const time = formatCrossChatTime(anchorTs || event.ts)
  const cancelMailbox = async () => {
    if (cancellingRef.current || !envelopeId || !conversationId || sourceId !== sessionId || !targetId) return
    const scope = captureTimelineWorkspaceScope(sessionId), request = requestGeneration.current
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) return
    cancellingRef.current = true
    setCancelling(true)
    setLoadError('')
    try {
      const receipt = await scope.connection.cancelCrossChatHandoff(envelopeId)
      if (request !== requestGeneration.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (receipt.id !== envelopeId || receipt.message_id !== envelopeId || receipt.source_session_id !== sourceId
        || receipt.target_session_id !== targetId || receipt.conversation_id !== conversationId
        || receipt.conversation_mode !== 'async_route_v1' || receipt.status !== 'cancelled') throw new Error('AgentsServer did not confirm cancellation of this message.')
      setCancelledLocally(true)
    } catch (error) {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) setLoadError(timelineActionError(error))
    } finally {
      if (request === requestGeneration.current && timelineWorkspaceScopeCurrent(scope)) { cancellingRef.current = false; setCancelling(false) }
    }
  }
  return <CrossChatMessageSurface testID={identity} incoming={incoming} layoutWidth={layoutWidth}>
      <CrossChatPeerHeader peerId={sourceId === sessionId || targetId === sessionId ? counterpartId : undefined} title={title} sessionId={sessionId} time={time} />
      {editedByUser ? <Text style={[styles.note, { color: colors.muted }]} localize>Edited by you</Text> : null}
      {text ? <CrossChatMessageText identity={`${identity}:${messageRevision ?? 0}`} text={text} fontScale={fontScale} />
        : <Text style={[styles.note, { color: colors.muted }]} localize>Message body available on demand.</Text>}
      {moreBodyAvailable || longBody ? <Pressable
        testID={`${identity}-toggle`}
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        accessibilityState={{ expanded, disabled: loading, busy: loading }}
        disabled={loading}
        onPress={() => expanded ? setExpanded(false) : void showFullMessage()}
        style={({ pressed }) => [styles.conversationBodyToggle, { opacity: loading ? 0.6 : pressed ? 0.72 : 1 }]}
      ><Text style={[styles.conversationBodyToggleText, { color: colors.crossChatControl }]} localize>{toggleLabel}</Text></Pressable> : null}
      {failed ? <InlineError message={latestExchangeString(lifecycle, value => value.message) || "Couldn't complete"} /> : null}
      {incoming && cancelled ? <Text style={[styles.note, { color: colors.muted }]} localize>Cancelled</Text> : null}
      {!incoming ? <Text accessibilityRole="text" style={[styles.note, { color: colors.muted }]} localize>{cancelledLocally ? 'Cancelled' : outgoingDeliveryStatus(event, lifecycle)}</Text> : null}
      {!incoming && event.delivery_mode === 'mailbox' && event.inbox_state === 'unread' && !cancelled && mailboxAvailable
        ? <CrossChatAction testID={`${identity}-cancel`} label={cancelling ? 'Cancelling…' : 'Cancel message'} disabled={cancelling} onPress={() => void cancelMailbox()} /> : null}
      {loadError ? <InlineError prefix="Could not load full message" message={loadError} /> : null}
  </CrossChatMessageSurface>
}

interface CrossChatConversationLeg extends CrossChatExchangeLeg {
  /** Timeline previews retain this until authenticated detail supplies the full body. */
  bodyTruncated: boolean
}

export function CrossChatHandoffCard(props: CrossChatCardProps) {
  const profileGeneration = useAppStore(state => state.profileGeneration)
  return <CrossChatHandoffCardScoped
    key={`${profileGeneration}:${props.sessionId}:${props.rowKey}`}
    {...props}
    profileGeneration={profileGeneration}
  />
}

function CrossChatHandoffCardScoped({ event, rowKey, sessionId, profileGeneration, fontScale = 1, layoutWidth }: CrossChatCardProps & { profileGeneration: number }) {
  const colors = usePalette()
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const envelopeId = event.handoff_id?.trim() || event.correlation_id?.trim() || ''
  const sourceId = event.source_session_id?.trim() || ''
  const targetId = event.target_session_id?.trim() || ''
  const counterpartId = sourceId === sessionId ? targetId : sourceId || targetId
  const counterpart = useAppStore(state => state.sessions.find(session => session.id === counterpartId))
  const counterpartTitle = counterpart?.title
    || (sourceId === sessionId ? event.target_title : event.source_title)
    || 'another chat'
  const preview = event.handoff_preview?.trim() || ''
  const truncated = event.handoff_body_truncated === true
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
  const [body, setBody] = useState(truncated ? '' : preview)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const [handoffStatusSnapshot, setHandoffStatusSnapshot] = useState<{ status: string; eventSeq: number } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const bodyRequest = useRef(0)
  const cancelRequest = useRef(0)
  const bodyLoadingRef = useRef(false)
  const cancellingRef = useRef(false)

  useEffect(() => {
    bodyRequest.current += 1
    cancelRequest.current += 1
    bodyLoadingRef.current = false
    cancellingRef.current = false
    setBody(truncated ? '' : preview)
    setBodyLoading(false)
    setBodyError('')
    setHandoffStatusSnapshot(null)
    setCancelling(false)
    setCancelError('')
  }, [envelopeId, sourceId, targetId, event.handoff_body_sha256, preview, profileGeneration, rowKey, sessionId, truncated, workspaceRevision])

  const loadBody = async () => {
    if (!envelopeId || body || bodyLoadingRef.current || (!truncated && preview)) return
    const request = ++bodyRequest.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setBodyError('This chat changed before the detail request could run.')
      return
    }
    bodyLoadingRef.current = true
    setBodyLoading(true)
    setBodyError('')
    try {
      const loaded = await scope.connection.crossChatHandoff(envelopeId)
      if (request !== bodyRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (loaded.id !== envelopeId) throw new Error('AgentsServer returned the wrong handoff')
      if (loaded.source_session_id !== sessionId && loaded.target_session_id !== sessionId) {
        throw new Error('This chat is not a participant in the handoff')
      }
      if ((sourceId && loaded.source_session_id !== sourceId) || (targetId && loaded.target_session_id !== targetId)) {
        throw new Error('AgentsServer returned different handoff participants')
      }
      if (typeof loaded.body !== 'string' || !loaded.body.trim()) throw new Error('AgentsServer did not return a message body')
      setBody(loaded.body)
    } catch (error) {
      if (request === bodyRequest.current && timelineWorkspaceScopeCurrent(scope)) setBodyError(timelineActionError(error))
    } finally {
      if (request === bodyRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        bodyLoadingRef.current = false
        setBodyLoading(false)
      }
    }
  }

  const cancelHandoff = async () => {
    if (!envelopeId || cancellingRef.current) return
    const request = ++cancelRequest.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setCancelError('This chat changed before the cancel request could run.')
      return
    }
    cancellingRef.current = true
    setCancelling(true)
    setCancelError('')
    try {
      const result = await scope.connection.cancelCrossChatHandoff(envelopeId)
      if (request !== cancelRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (result.id !== envelopeId) throw new Error('AgentsServer returned the wrong handoff')
      if (result.source_session_id !== sessionId && result.target_session_id !== sessionId) {
        throw new Error('This chat is not a participant in the handoff')
      }
      if ((sourceId && result.source_session_id !== sourceId) || (targetId && result.target_session_id !== targetId)) {
        throw new Error('AgentsServer returned different handoff participants')
      }
      if (typeof result.status !== 'string' || !result.status.trim()) throw new Error('AgentsServer did not confirm handoff cancellation')
      setHandoffStatusSnapshot({ status: result.status, eventSeq: event.seq })
      if (result.status !== 'cancelled') throw new Error(`The handoff is ${statusLabel(result.status).toLowerCase()}; cancellation was not confirmed.`)
    } catch (error) {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) setCancelError(timelineActionError(error))
    } finally {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        cancellingRef.current = false
        setCancelling(false)
      }
    }
  }

  const displayEvent = handoffStatusSnapshot?.eventSeq === event.seq
    ? { ...event, handoff_status: handoffStatusSnapshot.status }
    : event
  const status = handoffStatus(displayEvent)
  const failed = /failed|error/u.test(status)
  const title = crossChatTitle(displayEvent, counterpartTitle, sessionId)
  const detail = messageText(event).trim()
  const canCancel = sourceId === sessionId && /queued|deferred/u.test(status) && Boolean(envelopeId)
  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next) void loadBody()
  }

  const incoming = targetId === sessionId && sourceId !== sessionId
  const identity = `cross-chat-handoff-${envelopeId || event.id}`
  const availableText = body || preview
  const collapsed = crossChatCollapsedText(availableText)
  const hasMore = truncated && !body || collapsed !== availableText
  return <CrossChatMessageSurface testID={identity} incoming={incoming} layoutWidth={layoutWidth}>
    <CrossChatPeerHeader peerId={sourceId === sessionId || targetId === sessionId ? counterpartId : undefined}
      title={incoming ? counterpartTitle : `Sent to ${counterpartTitle}`} sessionId={sessionId} time={formatCrossChatTime(event.ts)} />
    {availableText ? <CrossChatMessageText identity={identity} text={open ? availableText : collapsed} fontScale={fontScale} />
      : <Text style={[styles.note, { color: colors.muted }]}>{detail || title}</Text>}
    {hasMore ? <CrossChatAction testID={`${identity}-toggle`} label={bodyLoading ? 'Loading full message…' : open && (!truncated || body) ? 'Show less' : 'View message'}
      expanded={open} disabled={bodyLoading} onPress={toggleOpen} /> : null}
    {failed ? <InlineError message={detail || title} /> : null}
    {bodyError ? <InlineError prefix="Could not load full message" message={bodyError} /> : null}
    {cancelError ? <InlineError prefix="Could not cancel handoff" message={cancelError} /> : null}
    {!incoming ? <Text style={[styles.note, { color: colors.muted }]} localize>{legacyOutgoingDeliveryStatus(status, displayEvent.type)}</Text>
      : status === 'cancelled' ? <Text style={[styles.note, { color: colors.muted }]} localize>Cancelled</Text> : null}
    {canCancel ? <CrossChatAction testID={`cross-chat-cancel-handoff-${envelopeId}`} label={cancelling ? 'Cancelling…' : 'Cancel handoff'} destructive disabled={cancelling} onPress={() => void cancelHandoff()} /> : null}
  </CrossChatMessageSurface>
}

export function CrossChatExchangeCard(props: CrossChatCardProps) {
  const profileGeneration = useAppStore(state => state.profileGeneration)
  return <CrossChatExchangeCardScoped
    key={`${profileGeneration}:${props.sessionId}:${props.rowKey}`}
    {...props}
    profileGeneration={profileGeneration}
  />
}

function CrossChatExchangeCardScoped({ event, events, rowKey, sessionId, profileGeneration, fontScale = 1, layoutWidth, legId, anchorTs }: CrossChatCardProps & { profileGeneration: number }) {
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const colors = usePalette()
  const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim() || ''
  const lifecycleEvents = useMemo(() => (events?.length ? events : [event])
    .filter(candidate => (candidate.exchange_id?.trim() || candidate.cross_chat_exchange_id?.trim() || '') === exchangeId)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)), [event, events, exchangeId])
  const observedLegs = useMemo(() => lifecycleExchangeLegs(lifecycleEvents), [lifecycleEvents])
  const sessions = useAppStore(state => state.sessions)
  const canSkipExactDelivery = useAppStore(state => exactQueuedDeliverySkipAvailable(state.health))
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
  const [exchangeSnapshot, setExchangeSnapshot] = useState<{ exchange: CrossChatExchange; eventSeq: number } | null>(null)
  const exchange = exchangeSnapshot?.exchange ?? null
  const snapshotCurrent = exchangeSnapshot?.eventSeq === event.seq
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [skipping, setSkipping] = useState(false)
  const [skipError, setSkipError] = useState('')
  const [skippedQueuedId, setSkippedQueuedId] = useState('')
  const [deliveryPromoted, setDeliveryPromoted] = useState(false)
  const detailRequest = useRef(0)
  const cancelRequest = useRef(0)
  const skipRequest = useRef(0)
  const lastDetailRequestSeq = useRef<number | null>(null)
  const loadingRef = useRef(false)
  const cancellingRef = useRef(false)
  const skippingRef = useRef(false)

  useEffect(() => {
    detailRequest.current += 1
    cancelRequest.current += 1
    skipRequest.current += 1
    lastDetailRequestSeq.current = null
    loadingRef.current = false
    cancellingRef.current = false
    skippingRef.current = false
    setExchangeSnapshot(null)
    setLoading(false)
    setLoadError('')
    setCancelling(false)
    setCancelError('')
    setSkipping(false)
    setSkipError('')
    setSkippedQueuedId('')
    setDeliveryPromoted(false)
  }, [exchangeId, profileGeneration, rowKey, sessionId, workspaceRevision])

  const observedById = new Map(observedLegs.map(leg => [leg.id, leg]))
  const conversationLegs: CrossChatConversationLeg[] = (exchange
    ? [
        ...exchange.legs.filter(leg => leg.kind !== 'status').map(leg => {
          const observed = observedById.get(leg.id)
          return {
            ...leg,
            // Authenticated exchange detail contains the complete body. A later
            // timeline preview may update status, but cannot truncate it again.
            bodyTruncated: false,
            status: snapshotCurrent ? leg.status : observed?.status || leg.status,
            queued_id: leg.queued_id || observed?.queued_id || null,
            error_code: snapshotCurrent ? leg.error_code : observed?.error_code || leg.error_code,
            error: snapshotCurrent ? leg.error : observed?.error || leg.error,
          }
        }),
        ...observedLegs.filter(leg => !exchange.legs.some(candidate => candidate.id === leg.id)),
      ]
    : observedLegs
  ).sort((left, right) => left.ordinal - right.ordinal || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
  const firstLeg = conversationLegs[0] ?? null
  const requesterId = exchange?.requester_session_id
    || latestExchangeString(lifecycleEvents, candidate => candidate.requester_session_id)
    || firstLeg?.source_session_id
    || ''
  const responderId = exchange?.responder_session_id
    || latestExchangeString(lifecycleEvents, candidate => candidate.responder_session_id)
    || firstLeg?.target_session_id
    || ''
  const sourceId = latestExchangeString(lifecycleEvents, candidate => candidate.source_session_id) || firstLeg?.source_session_id || ''
  const targetId = latestExchangeString(lifecycleEvents, candidate => candidate.target_session_id) || firstLeg?.target_session_id || ''
  const titleFor = (id: string, fallback: string) => sessions.find(candidate => candidate.id === id)?.title
    || latestParticipantTitle(lifecycleEvents, id, requesterId, responderId)
    || fallback
  const counterpartId = counterpartSessionId(sessionId, sourceId, targetId, requesterId, responderId)
  const counterpartTitle = titleFor(counterpartId, 'another chat')

  const loadExchange = async (expectedScope?: TimelineWorkspaceScope, force = false) => {
    if (!exchangeId || (!force && exchange && snapshotCurrent) || loadingRef.current || cancellingRef.current) return
    lastDetailRequestSeq.current = event.seq
    const request = ++detailRequest.current
    const scope = expectedScope ?? captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setLoadError('This chat changed before the detail request could run.')
      return
    }
    loadingRef.current = true
    setLoading(true)
    setLoadError('')
    try {
      const loaded = await scope.connection.crossChatExchange(exchangeId)
      if (request !== detailRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      validateExchange(loaded, exchangeId, '', sessionId)
      if (observedLegs.some(observed => !loaded.legs.some(leg => leg.id === observed.id && leg.exchange_id === exchangeId))) {
        throw new Error('AgentsServer did not return this conversation message.')
      }
      setExchangeSnapshot({ exchange: loaded, eventSeq: event.seq })
    } catch (error) {
      if (request === detailRequest.current && timelineWorkspaceScopeCurrent(scope)) setLoadError(timelineActionError(error))
    } finally {
      if (request === detailRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }

  const cancelExchange = async (expectedScope?: TimelineWorkspaceScope): Promise<CrossChatExchange | null> => {
    if (!exchangeId || cancellingRef.current) return null
    const request = ++cancelRequest.current
    const scope = expectedScope ?? captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setCancelError('This chat changed before the cancel request could run.')
      return null
    }
    cancellingRef.current = true
    // An older observational read must not restore active state after a cancel.
    detailRequest.current += 1
    lastDetailRequestSeq.current = null
    loadingRef.current = false
    setLoading(false)
    setCancelling(true)
    setCancelError('')
    try {
      const cancelled = await scope.connection.cancelCrossChatExchange(exchangeId)
      if (request !== cancelRequest.current || !timelineWorkspaceScopeCurrent(scope)) return null
      validateExchange(cancelled, exchangeId, '', sessionId)
      setExchangeSnapshot({ exchange: cancelled, eventSeq: event.seq })
      return cancelled
    } catch (error) {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) setCancelError(timelineActionError(error))
      return null
    } finally {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        cancellingRef.current = false
        setCancelling(false)
      }
    }
  }

  const terminalEventStatus = [...lifecycleEvents].reverse().map(candidate => candidate.exchange_status).find(terminalExchangeStatus) || null
  const latestEventStatus = (latestExchangeString(lifecycleEvents, candidate => candidate.exchange_status) || null) as CrossChatExchangeStatus | null
  const exchangeStatus = terminalEventStatus || (snapshotCurrent ? exchange?.status : null) || latestEventStatus || exchange?.status || 'active'
  const terminalStatus = terminalExchangeStatus(exchangeStatus) ? exchangeStatus : null
  const queuedDelivery = terminalStatus || deliveryPromoted
    ? null
    : conversationLegs.find(leg => leg.target_session_id === sessionId && leg.status === 'queued' && Boolean(leg.queued_id) && leg.queued_id !== skippedQueuedId) ?? null

  const skipQueuedDelivery = async () => {
    if (!queuedDelivery?.queued_id || !exchangeId || skippingRef.current) return
    const queuedId = queuedDelivery.queued_id
    const request = ++skipRequest.current
    const scope = captureTimelineWorkspaceScope(sessionId)
    if (scope.profileGeneration !== profileGeneration || !timelineWorkspaceScopeCurrent(scope)) {
      setSkipError('This chat changed before the queued delivery could be skipped.')
      return
    }
    skippingRef.current = true
    setSkipping(true)
    setSkipError('')
    try {
      await scope.connection.skipQueuedCrossChatDelivery(sessionId, queuedId, {
        cross_chat_exchange_id: exchangeId,
        cross_chat_exchange_leg_id: queuedDelivery.id,
      })
      if (request !== skipRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      setSkippedQueuedId(queuedId)
      await useAppStore.getState().syncSelectedSession('manual').catch(() => undefined)
    } catch (error) {
      if (request !== skipRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      const queue = await scope.connection.queue(sessionId).catch(() => null)
      if (request !== skipRequest.current || !timelineWorkspaceScopeCurrent(scope)) return
      if (queue && !queue.some(turn => turn.queued_id === queuedId)) {
        // The target may have started before the exact queue removal arrived.
        // Preserve this tap's cancel intent within its original exchange and
        // authenticated workspace, then reconcile the server's terminal state.
        setDeliveryPromoted(true)
        const reconciled = await cancelExchange(scope)
        if (!reconciled && request === skipRequest.current && timelineWorkspaceScopeCurrent(scope)) await loadExchange(scope, true)
      } else setSkipError(timelineActionError(error))
    } finally {
      if (request === skipRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        skippingRef.current = false
        setSkipping(false)
      }
    }
  }

  const actionLeg = conversationLegs.find(leg => snapshotCurrent && leg.id === exchange?.active_leg_id)
    || [...conversationLegs].reverse().find(leg => !['delivered', 'failed', 'cancelled', 'expired'].includes(leg.status))
    || conversationLegs[conversationLegs.length - 1]
    || null
  const activeOwnerId = terminalStatus ? '' : actionLeg?.target_session_id || (exchangeStatus === 'waiting_request' ? requesterId : '')
  const activeOwnerTitle = activeOwnerId ? titleFor(activeOwnerId, activeOwnerId === sessionId ? 'This chat' : 'Other agent') : ''
  const stateLabel = exchangeStateLabel(exchangeStatus, activeOwnerTitle, activeOwnerId === sessionId, actionLeg?.status || '')
  const participant = exchange ? exchangeParticipant(exchange, sessionId) : [requesterId, responderId, sourceId, targetId].includes(sessionId)
  const canCancel = participant && Boolean(exchangeId) && (!queuedDelivery || !canSkipExactDelivery) && ['waiting_request', 'active'].includes(exchangeStatus)
  const errorEvent = [...lifecycleEvents].reverse().find(candidate => (
    candidate.exchange_status === 'failed'
    || candidate.exchange_leg_status === 'failed'
    || candidate.type === 'cross_chat_exchange_failed'
    || candidate.type === 'cross_chat_exchange_leg_failed'
  ))
  const errorText = exchange?.error || conversationLegs.find(leg => leg.error)?.error || errorEvent?.message || exchange?.error_code || errorEvent?.exchange_error_code || ''
  const failed = exchangeStatus === 'failed' || conversationLegs.some(leg => leg.status === 'failed') || Boolean(errorText)
  const failureSummary = failed
    ? errorText && exchangeFailureMessageIsPlainLanguage(String(errorText))
      ? String(errorText)
      : `Conversation with ${counterpartTitle} could not be completed.`
    : ''
  const preview = latestExchangeString(lifecycleEvents, candidate => candidate.handoff_preview)
  useEffect(() => {
    if (
      !open
      || !exchangeId
      || loadingRef.current
      || cancellingRef.current
      || lastDetailRequestSeq.current === event.seq
      || (exchange && snapshotCurrent)
    ) return
    void loadExchange()
  }, [event.seq, exchangeId, loading, cancelling, open, snapshotCurrent, workspaceRevision])

  const displayedLegs = legId ? conversationLegs.filter(leg => leg.id === legId) : conversationLegs
  return <View testID={`cross-chat-exchange-${exchangeId || event.id}`}>
    {displayedLegs.map((leg, index) => {
      const actionMessage = actionLeg?.id === leg.id
      const sourceTitle = titleFor(leg.source_session_id, 'Other agent')
      const targetTitle = titleFor(leg.target_session_id, 'Other agent')
      return <ConversationLeg key={leg.id} leg={leg} index={index} sessionId={sessionId}
        sourceTitle={sourceTitle} targetTitle={targetTitle} bodyComplete={snapshotCurrent} loading={loading}
        fontScale={fontScale} layoutWidth={layoutWidth} anchorTs={anchorTs}
        onRequestFull={() => { setOpen(true); void loadExchange() }}>
        {actionMessage ? <Text accessibilityRole="text" accessibilityLabel={`Conversation status: ${stateLabel}`}
          style={[styles.note, { color: colors.muted }]}>{skippedQueuedId && leg.queued_id === skippedQueuedId ? 'Queued message removed.' : stateLabel}</Text> : null}
        {actionMessage && loading ? <InlineStatus label="Loading messages…" /> : null}
        {leg.status === 'failed' || actionMessage && failed ? <InlineError message={failureSummary || leg.error || "Couldn't complete"} /> : null}
        {loadError ? <InlineError prefix="Could not load full message" message={loadError} /> : null}
        {loadError && !loading ? <CrossChatAction testID={`cross-chat-retry-exchange-${exchangeId}`} label="Retry loading" onPress={() => void loadExchange()} /> : null}
        {actionMessage && cancelError ? <InlineError prefix="Could not end the conversation" message={cancelError} /> : null}
        {actionMessage && skipError ? <InlineError prefix="Could not remove the queued message" message={skipError} /> : null}
        {queuedDelivery?.id === leg.id && canSkipExactDelivery ? <CrossChatAction
          testID={`cross-chat-skip-delivery-${queuedDelivery.queued_id}`} label={skipping ? 'Removing…' : 'Cancel queued message'}
          destructive disabled={skipping} onPress={() => void skipQueuedDelivery()} /> : null}
        {actionMessage && canCancel ? <CrossChatAction testID={`cross-chat-cancel-exchange-${exchangeId}`}
          label={cancelling ? 'Ending…' : 'End conversation'} destructive disabled={cancelling} onPress={() => void cancelExchange()} /> : null}
      </ConversationLeg>
    })}
    {!displayedLegs.length ? <CrossChatMessageSurface testID={`cross-chat-exchange-${exchangeId}-empty`} incoming={false} layoutWidth={layoutWidth}>
      <CrossChatPeerHeader peerId={participant ? counterpartId : undefined} title={counterpartTitle} sessionId={sessionId} time={formatCrossChatTime(anchorTs || event.ts)} />
      {preview ? <CrossChatMessageText identity={exchangeId} text={crossChatCollapsedText(preview)} fontScale={fontScale} /> : null}
      <Text accessibilityRole="text" accessibilityLabel={`Conversation status: ${stateLabel}`} style={[styles.note, { color: colors.muted }]}>{stateLabel}</Text>
      <CrossChatAction testID={`cross-chat-toggle-conversation-${exchangeId}`} label={loading ? 'Loading messages…' : 'View message'} disabled={loading} onPress={() => { setOpen(true); void loadExchange() }} />
      {canCancel ? <CrossChatAction testID={`cross-chat-cancel-exchange-${exchangeId}`} label={cancelling ? 'Ending…' : 'End conversation'} destructive disabled={cancelling} onPress={() => void cancelExchange()} /> : null}
      {loadError ? <InlineError prefix="Could not load full message" message={loadError} /> : null}
      {cancelError ? <InlineError prefix="Could not end the conversation" message={cancelError} /> : null}
    </CrossChatMessageSurface> : null}
  </View>
}

function validateExchange(exchange: CrossChatExchange, exchangeId: string, legId: string, sessionId: string): void {
  if (exchange.id !== exchangeId) throw new Error('AgentsServer returned the wrong exchange')
  if (!exchangeParticipant(exchange, sessionId)) throw new Error('This chat is not a participant in the exchange')
  if (legId && !exchange.legs.some(leg => leg.id === legId && leg.exchange_id === exchangeId)) {
    throw new Error('AgentsServer did not return this exchange leg')
  }
}

function latestExchangeString(events: readonly Event[], read: (event: Event) => string | null | undefined): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index]!)?.trim() || ''
    if (value) return value
  }
  return ''
}

function latestExchangeNumber(events: readonly Event[], read: (event: Event) => number | null | undefined): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index]!)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function latestExchangeBoolean(events: readonly Event[], read: (event: Event) => boolean | null | undefined): boolean | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index]!)
    if (typeof value === 'boolean') return value
  }
  return null
}

function latestParticipantTitle(
  events: readonly Event[],
  sessionId: string,
  requesterId: string,
  responderId: string,
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.source_session_id?.trim() === sessionId && event.source_title?.trim()) return event.source_title.trim()
    if (event.target_session_id?.trim() === sessionId && event.target_title?.trim()) return event.target_title.trim()
    if (requesterId === sessionId && event.requester_title?.trim()) return event.requester_title.trim()
    if (responderId === sessionId && event.responder_title?.trim()) return event.responder_title.trim()
  }
  return ''
}

function exchangeStateLabel(
  status: CrossChatExchangeStatus | null,
  activeOwnerTitle = '',
  activeOwnerIsCurrent = false,
  activeLegStatus: CrossChatExchangeLeg['status'] | '' = '',
): string {
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return "Couldn't complete"
  if (status === 'cancelled') return 'Cancelled before completion'
  if (status === 'expired') return 'Expired before completion'
  if (status === 'waiting_request') return 'Waiting to start'
  if (activeOwnerTitle) {
    const owner = activeOwnerIsCurrent ? 'This chat' : activeOwnerTitle
    if (['registered', 'submitting'].includes(activeLegStatus)) return `Sending to ${owner}`
    if (activeLegStatus === 'queued') return `Waiting for ${owner}`
    return `${owner} is working`
  }
  return 'In progress'
}

function exchangeRecoveryNote(value: string): string {
  if (!/^Recovered terminal (?:cross-chat )?exchange(?: leg)? state(?: after restart|:)/iu.test(value.trim())) return value
  return 'Conversation status was synchronized from the server.'
}

function exchangeFailureMessageIsPlainLanguage(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed)
    && exchangeRecoveryNote(trimmed) === trimmed
    && /\s/u.test(trimmed)
}

function crossChatLegMayHaveMoreBody(leg: CrossChatConversationLeg, bodyComplete = false): boolean {
  if (bodyComplete) return false
  if (leg.bodyTruncated) return true
  const body = leg.body.trim()
  if ((leg.body_chars ?? 0) > body.length) return true
  return body.endsWith('…') || body.endsWith('...')
}

function crossChatLegBodyIsLong(leg: CrossChatConversationLeg): boolean {
  return (leg.body_chars ?? leg.body.length) > CROSS_CHAT_LONG_MESSAGE_CHARS
    || leg.body.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
}

export function crossChatCollapsedText(value: string): string {
  const lineClipped = value.split('\n').slice(0, CROSS_CHAT_LONG_MESSAGE_LINES).join('\n')
  const characters = Array.from(lineClipped)
  const clipped = characters.length > CROSS_CHAT_LONG_MESSAGE_CHARS
    ? characters.slice(0, CROSS_CHAT_LONG_MESSAGE_CHARS).join('')
    : lineClipped
  return `${clipped.trimEnd()}${clipped !== value ? '…' : ''}`
}

export function formatCrossChatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? crossChatTimeFormatter.format(date) : ''
}

function legacyOutgoingDeliveryStatus(status: string, type = ''): string {
  if (status === 'cancelled' || type.endsWith('_cancelled')) return 'Cancelled'
  if (status === 'failed' || type.endsWith('_failed')) return 'Delivery failed'
  if (status === 'delivered' || type.endsWith('_delivered')) return 'Delivered'
  if (status === 'running' || status === 'started' || type.endsWith('_started')) return 'Processing'
  if (status === 'queued' || status === 'deferred' || type.endsWith('_queued')) return 'Queued'
  return 'Delivery unconfirmed'
}

/** Delivery claims strengthen only from receipts for this exact envelope. */
function outgoingDeliveryStatus(event: Event, events: readonly Event[]): string {
  const id = (value: Event) => value.cross_chat_envelope_id || value.handoff_id || value.message_id
  const envelope = id(event)
  if (!envelope) return 'Delivery unconfirmed'
  const receipts = events.filter(value => id(value) === envelope
    && (!value.source_session_id || value.source_session_id === event.source_session_id)
    && (!value.target_session_id || value.target_session_id === event.target_session_id)
    && (!value.conversation_id || value.conversation_id === event.conversation_id))
  if (receipts.some(value => value.inbox_state === 'deleted' || value.type === 'chat_conversation_message_deleted')) return 'Deleted'
  if (receipts.some(value => value.handoff_status === 'cancelled' || value.type === 'chat_conversation_message_cancelled')) return 'Cancelled'
  if (receipts.some(value => value.handoff_status === 'failed' || value.type === 'chat_conversation_message_failed')) return 'Delivery failed'
  if (receipts.some(value => value.delivery_mode === 'mailbox' && value.inbox_state === 'read'
    && (value.handoff_status === 'stored' || value.handoff_status === 'read' || value.type === 'chat_conversation_message_read'))) return 'Read'
  if (receipts.some(value => value.delivery_mode === 'mailbox')) return receipts.some(value => value.handoff_status === 'stored' && value.inbox_state === 'unread') ? 'In inbox · Unread' : 'Delivery unconfirmed'
  for (const value of [...receipts].reverse()) {
    const label = legacyOutgoingDeliveryStatus(value.handoff_status || '', value.type)
    if (label !== 'Delivery unconfirmed') return label
  }
  return 'Delivery unconfirmed'
}

function lifecycleExchangeLegs(events: readonly Event[]): CrossChatConversationLeg[] {
  const byLeg = new Map<string, Event[]>()
  for (const event of events) {
    const legId = event.exchange_leg_id?.trim() || event.cross_chat_exchange_leg_id?.trim() || ''
    if (!legId || event.exchange_leg_kind === 'status') continue
    byLeg.set(legId, [...byLeg.get(legId) ?? [], event])
  }
  return [...byLeg.entries()].flatMap(([id, updates]) => {
    const ordered = updates.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
    const latest = ordered[ordered.length - 1]!
    const kind = [...ordered].reverse().find(candidate => candidate.exchange_leg_kind)?.exchange_leg_kind ?? 'request'
    if (kind === 'status') return []
    const status = [...ordered].reverse().find(candidate => candidate.exchange_leg_status)?.exchange_leg_status ?? 'registered'
    const preview = latestExchangeString(ordered, candidate => candidate.handoff_preview)
    const bodyChars = latestExchangeNumber(ordered, candidate => candidate.handoff_body_chars) ?? preview.length
    const expectsReply = [...ordered].reverse().find(candidate => typeof candidate.exchange_expects_reply === 'boolean')?.exchange_expects_reply ?? false
    return [{
      id,
      exchange_id: latestExchangeString(ordered, candidate => candidate.exchange_id || candidate.cross_chat_exchange_id),
      parent_leg_id: null,
      ordinal: latestExchangeNumber(ordered, candidate => candidate.exchange_ordinal) ?? 0,
      kind,
      expects_reply: expectsReply,
      response_state: (['delivered', 'failed', 'cancelled', 'expired'].includes(status) ? 'closed' : 'open') as CrossChatExchangeLeg['response_state'],
      status,
      source_session_id: latestExchangeString(ordered, candidate => candidate.source_session_id),
      source_run_id: latestExchangeString(ordered, candidate => candidate.run_id),
      target_session_id: latestExchangeString(ordered, candidate => candidate.target_session_id),
      target_run_id: null,
      queued_id: latestExchangeString(ordered, candidate => candidate.queued_id) || null,
      body: preview,
      body_chars: bodyChars,
      body_sha256: latestExchangeString(ordered, candidate => candidate.handoff_body_sha256),
      bodyTruncated: latestExchangeBoolean(ordered, candidate => candidate.handoff_body_truncated) === true,
      error_code: latestExchangeString(ordered, candidate => candidate.exchange_error_code) || null,
      error: status === 'failed' ? latest.message?.trim() || null : null,
      created_at: ordered[0]!.ts,
      updated_at: latest.ts,
    }]
  }).sort((left, right) => left.ordinal - right.ordinal || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
}

function exchangeParticipant(exchange: CrossChatExchange, sessionId: string): boolean {
  return exchange.requester_session_id === sessionId || exchange.responder_session_id === sessionId
}

function terminalExchangeStatus(status: CrossChatExchangeStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
}

function counterpartSessionId(
  current: string,
  source: string,
  target: string,
  requester: string,
  responder: string,
): string {
  if (source === current) return target
  if (target === current) return source
  if (requester === current) return responder
  if (responder === current) return requester
  return source || target || requester || responder
}

function handoffStatus(event: Event): string {
  const generic = typeof event.status === 'string' ? event.status : ''
  return String(event.handoff_status || generic || event.type).toLocaleLowerCase()
}

function statusLabel(value: string): string {
  const words = value.replace(/^cross_chat_(?:exchange_)?/u, '').replaceAll('_', ' ').trim()
  if (!words) return 'Updated'
  return `${words[0]!.toLocaleUpperCase()}${words.slice(1)}`
}

function boundedInlineText(value: string): string {
  return value.length <= CROSS_CHAT_INLINE_TEXT_LIMIT
    ? value
    : `${value.slice(0, CROSS_CHAT_INLINE_TEXT_LIMIT).trimEnd()}…`
}

function crossChatTitle(event: Event, counterpartTitle: string, currentSessionId: string): string {
  const status = handoffStatus(event)
  const source = event.source_session_id?.trim() || ''
  const incoming = Boolean(source && source !== currentSessionId)
  const payload = event.handoff_action === 'final_result' ? 'Result' : 'Instruction'
  if (/failed|error/u.test(status)) return incoming ? `${payload} from ${counterpartTitle} failed` : `Delivery to ${counterpartTitle} failed`
  if (/cancel/u.test(status)) return incoming ? `${payload} from ${counterpartTitle} cancelled` : `Handoff to ${counterpartTitle} cancelled`
  if (/repl/u.test(status)) return `Reply received from ${counterpartTitle}`
  if (/running|started/u.test(status)) return incoming ? `Working on ${payload.toLocaleLowerCase()} from ${counterpartTitle}` : `Work started in ${counterpartTitle}`
  if (/queued|deferred/u.test(status)) return incoming ? `${payload} queued from ${counterpartTitle}` : `Queued in ${counterpartTitle}`
  if (/completed|finished|sent|delivered/u.test(status)) return incoming ? `${payload} from ${counterpartTitle} completed` : `Sent to ${counterpartTitle}`
  if (event.handoff_action === 'final_result') return `Sending result to ${counterpartTitle} when this turn completes`
  if (event.type.startsWith('cross_chat_watch_')) return `Watching ${counterpartTitle}`
  return incoming ? `${payload} from ${counterpartTitle}` : `Sending ${payload.toLocaleLowerCase()} to ${counterpartTitle}`
}

function ConversationLeg({ leg, index, sessionId, sourceTitle, targetTitle, bodyComplete, loading, fontScale, layoutWidth, anchorTs, onRequestFull, children }: {
  leg: CrossChatConversationLeg; index: number; sessionId: string; sourceTitle: string; targetTitle: string
  bodyComplete: boolean; loading: boolean; fontScale: number; layoutWidth?: number; anchorTs?: string
  onRequestFull: () => void; children?: ReactNode
}) {
  const colors = usePalette()
  const [expanded, setExpanded] = useRecyclingState(false, [leg.exchange_id, leg.id])
  const incoming = leg.target_session_id === sessionId && leg.source_session_id !== sessionId
  const participant = leg.source_session_id === sessionId || leg.target_session_id === sessionId
  const mayHaveMoreBody = crossChatLegMayHaveMoreBody(leg, bodyComplete)
  const longBody = crossChatLegBodyIsLong(leg)
  const visibleBody = expanded || !longBody ? leg.body : crossChatCollapsedText(leg.body)
  const identity = `cross-chat-leg-${leg.id}`
  return <CrossChatMessageSurface testID={identity} incoming={incoming} layoutWidth={layoutWidth}>
    <CrossChatPeerHeader peerId={participant ? incoming ? leg.source_session_id : leg.target_session_id : undefined}
      title={incoming ? sourceTitle : `Sent to ${targetTitle}`} sessionId={sessionId} time={formatCrossChatTime(anchorTs || leg.created_at)} />
    {visibleBody ? <CrossChatMessageText identity={`${identity}-body`} text={visibleBody} fontScale={fontScale} />
      : <Text style={[styles.note, { color: colors.muted }]} localize>Message body available on demand.</Text>}
    {mayHaveMoreBody || longBody ? <CrossChatAction testID={`cross-chat-message-toggle-${leg.id}`}
      label={mayHaveMoreBody && loading ? 'Loading full message…' : mayHaveMoreBody || !expanded ? 'View message' : 'Show less'}
      expanded={!mayHaveMoreBody && expanded} disabled={mayHaveMoreBody && loading}
      onPress={() => {
        if (mayHaveMoreBody) { setExpanded(true); onRequestFull() }
        else setExpanded(value => !value)
      }} /> : null}
    {children}
  </CrossChatMessageSurface>
}
function InlineStatus({ label }: { label: string }) {
  const colors = usePalette()
  return <View accessibilityRole="progressbar" style={styles.inlineStatus}><ActivityIndicator size="small" color={colors.blue} /><Text style={[styles.note, { color: colors.muted }]}>{label}</Text></View>
}

export function InlineError({ prefix, message }: { prefix?: string; message: string }) {
  const colors = usePalette()
  const detail = boundedInlineText(message)
  return <View accessibilityRole="alert" style={styles.inlineError}><AlertTriangle size={13} color={colors.red} /><Text selectable style={[styles.errorText, { color: colors.red }]}>{prefix ? `${prefix}: ${detail}` : detail}</Text></View>
}

const styles = StyleSheet.create({
  asyncMessage: { minWidth: 0, marginHorizontal: 14, marginVertical: 8 },
  asyncMessageSurface: { minWidth: 0, maxWidth: 760, paddingVertical: 10, paddingHorizontal: 13, borderWidth: 1, borderRadius: radius.md },
  asyncMessageHeader: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 },
  asyncMessageTitle: { flex: 1, minWidth: 0, ...typography.label, fontWeight: fontWeight.medium },
  peerLink: { flex: 1, minWidth: 44, minHeight: 44, justifyContent: 'center' },
  referenceList: { gap: 6, marginTop: 8 },
  referenceChip: { minHeight: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  referenceText: { flex: 1, minWidth: 0, ...typography.caption },
  referenceStrong: { fontWeight: fontWeight.semibold },
  note: { ...typography.caption },
  inlineStatus: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  inlineError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorText: { flex: 1, ...typography.caption },
  conversationTime: { flexShrink: 0, ...typography.caption, fontVariant: ['tabular-nums'] },
  conversationBodyToggle: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  conversationBodyToggleText: { ...typography.caption, fontWeight: fontWeight.medium },
})
