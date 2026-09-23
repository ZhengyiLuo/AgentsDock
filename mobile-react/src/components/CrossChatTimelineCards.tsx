import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import { AlertTriangle, MessageSquareShare } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { exactQueuedDeliverySkipAvailable } from '../lib/chat-references'
import { authenticatedChatMessageBody } from '../lib/chat-message-body'
import { chatMailboxAvailable } from '../lib/chat-mailbox'
import { legacyOutgoingDeliveryStatus, outgoingDeliveryStatus, outgoingMailboxCanCancel, requireMailboxCancellationReceipt } from '../lib/cross-chat-delivery-status'
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
import { usePalette } from '../theme'
import { Text } from './AppText'
import { MarkdownContent } from './MarkdownContent'

const CROSS_CHAT_BODY_CHUNK = 4_000
const CROSS_CHAT_INLINE_TEXT_LIMIT = 2_000
const CROSS_CHAT_LONG_MESSAGE_CHARS = 640
const CROSS_CHAT_LONG_MESSAGE_LINES = 10
const EMPTY_READ_ONLY_REFERENCE_KEYS: ReadonlySet<string> = new Set()

// Secondary conversation metadata colors; message surfaces follow the current Mac bubbles.
export const CROSS_CHAT_CONVERSATION_DARK = {
  state: '#cfc3ef',
  stateCompleted: '#aee2c4',
  stateFailed: '#ffb4af',
  stateTerminal: '#b7a9d6',
  toggle: '#c9b1eb',
  control: '#c3b2ee',
  controlPressed: '#f0ebff',
  placeholder: '#a99bc9',
  failure: '#ffbbb6',
  detailText: '#a99bc9',
  detailStrong: '#c9bde6',
  detailNote: '#baabc9',
  link: '#7eb8e6',
  destructive: '#93adc3',
  destructivePressed: '#ffaaa5',
} as const

export const CROSS_CHAT_CONVERSATION_LIGHT: CrossChatConversationPalette = {
  state: '#5c467f',
  stateCompleted: '#276847',
  stateFailed: '#922824',
  stateTerminal: '#705c89',
  toggle: '#664185',
  control: '#5b3d80',
  controlPressed: '#3f265f',
  placeholder: '#75618f',
  failure: '#842722',
  detailText: '#705c89',
  detailStrong: '#52366f',
  detailNote: '#765f86',
  link: '#276997',
  destructive: '#58778f',
  destructivePressed: '#922824',
}

export type CrossChatConversationPalette = {
  [Key in keyof typeof CROSS_CHAT_CONVERSATION_DARK]: string
}

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

function timelineActionError(error: unknown): string {
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

/** Navigation only. Authenticated IDs, never display names, identify local peers. */
export function CrossChatPeerHeading({ peerId, sessionId, children, testID, intrinsic = false }: {
  peerId?: string | null; sessionId: string; children: ReactNode; testID?: string; intrinsic?: boolean
}) {
  const target = peerId?.trim()
  return !target || target === sessionId ? <>{children}</> : <ScopedCrossChatPeerHeading target={target} sessionId={sessionId} testID={testID} intrinsic={intrinsic}>{children}</ScopedCrossChatPeerHeading>
}

function ScopedCrossChatPeerHeading({ target, sessionId, children, testID, intrinsic }: {
  target: string; sessionId: string; children: ReactNode; testID?: string; intrinsic: boolean
}) {
  const colors = usePalette()
  const revision = useTimelineWorkspaceRevision(sessionId)
  const scope = useMemo(() => captureTimelineWorkspaceScope(sessionId), [sessionId, revision])
  const [error, setError] = useRecyclingState('', [revision, target, sessionId])
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const open = async () => {
    if (busy.current || !mounted.current || !timelineWorkspaceScopeCurrent(scope)) return
    const state = useAppStore.getState()
    if (!state.sessions.some(session => session.id === target && !session.archived)) {
      setError('This chat is not available in the current server workspace.')
      return
    }
    busy.current = true
    setError('')
    try { await state.selectSession(target, scope.profileGeneration) }
    catch (cause) { if (mounted.current && timelineWorkspaceProfileCurrent(scope)) setError(timelineActionError(cause)) }
    finally { busy.current = false }
  }
  return <View style={intrinsic ? { flexShrink: 1, minWidth: 0 } : { flex: 1, minWidth: 0 }}>
    <Pressable testID={testID ?? `cross-chat-peer-${target}`} accessibilityRole="button" accessibilityLabel={`Open chat ${target}`} onPress={() => void open()} style={{ minHeight: 44, justifyContent: 'center', minWidth: 44 }}>{children}</Pressable>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.red }}>{error}</Text> : null}
  </View>
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
  const [openError, setOpenError] = useRecyclingState<string | null>(null, [profileGeneration, sessionId, identity])
  if (!unique.length) return null
  return <View accessibilityLabel="Referenced chats" style={styles.referenceList}>
    {unique.map(reference => {
      const key = timelineChatReferenceKey(reference)
      const remote = timelineChatReferenceIsRemote(reference)
      const readOnly = remote || readOnlyReferenceKeys.has(key)
      const label = `${timelineReferenceLabel(reference)}${remote ? ' · secure paired server' : ''}`
      const content = <>
        <MessageSquareShare size={13} color={readOnly ? colors.muted : colors.blue} />
        <Text style={[styles.referenceText, { color: readOnly ? colors.muted : colors.blue }]} numberOfLines={2}>
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
          setOpenError(null)
          openTargetSession(reference.session_id, sessionId, profileGeneration, setOpenError)
        }}
        style={[styles.referenceChip, { borderColor: colors.blue, backgroundColor: `${colors.blue}12` }]}
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

interface CrossChatCardProps { event: Event; events?: Event[]; rowKey: string; sessionId: string; fontScale?: number; anchorTs?: string; layoutWidth?: number; legId?: string }

interface CrossChatMessageCardProps extends CrossChatCardProps { anchorTs?: string; layoutWidth?: number }

/** Mac message presentation shared by current and historical cross-chat records. */
export function CrossChatMessageSurface({ identity, incoming, layoutWidth = 640, sessionId, peerId, title, time, children }: {
  identity: string; incoming: boolean; layoutWidth?: number; sessionId: string; peerId?: string | null
  title: string; time?: string; children: ReactNode
}) {
  const colors = usePalette()
  const light = useColorScheme() === 'light'
  return <View testID={identity} style={styles.asyncMessage}>
    <View testID={`${identity}-surface`} style={[
      styles.asyncMessageSurface,
      {
        maxWidth: Math.min(760, Math.max(0, layoutWidth - 28) * (layoutWidth <= 480 ? 0.94 : 0.82)),
        alignSelf: incoming ? 'flex-end' : 'flex-start',
        paddingHorizontal: layoutWidth <= 480 ? 10 : 13,
        paddingVertical: layoutWidth <= 480 ? 9 : 10,
        backgroundColor: light ? '#eee5fb' : '#332444',
        borderColor: light ? '#bca5dc' : '#685080',
      },
    ]}>
      <View style={styles.asyncMessageHeader}>
        <MessageSquareShare size={13} color={colors.muted} />
        <CrossChatPeerHeading peerId={peerId} sessionId={sessionId} intrinsic><Text accessibilityRole="header" style={[styles.asyncMessageTitle, { color: colors.text }]} numberOfLines={2}>{title}</Text></CrossChatPeerHeading>
        {time ? <Text style={[styles.conversationTime, { color: colors.muted }]}>{time}</Text> : null}
      </View>
      {children}
    </View>
  </View>
}

/** One explicit async message, with no legacy exchange or automatic-reply controls. */
export function CrossChatMessageCard(props: CrossChatMessageCardProps) {
  const profileGeneration = useAppStore(state => state.profileGeneration)
  return <CrossChatMessageCardScoped key={`${profileGeneration}:${props.sessionId}:${props.rowKey}`} {...props} profileGeneration={profileGeneration} />
}

function CrossChatMessageCardScoped({
  event, events, rowKey, sessionId, anchorTs, layoutWidth = 640, fontScale = 1, profileGeneration,
}: CrossChatMessageCardProps & { profileGeneration: number }) {
  const colors = usePalette()
  const light = useColorScheme() === 'light'
  const workspaceRevision = useTimelineWorkspaceRevision(sessionId)
  const lifecycle = events?.length ? events : [event]
  const mailboxAvailable = useAppStore(state => chatMailboxAvailable(state.health))
  const envelopeId = event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || event.message_id?.trim() || ''
  const conversationId = latestExchangeString(lifecycle, value => value.conversation_id)
  const sourceId = latestExchangeString(lifecycle, value => value.source_session_id)
  const targetId = latestExchangeString(lifecycle, value => value.target_session_id)
  const incoming = targetId === sessionId && sourceId !== sessionId
  const latestRevision = latestExchangeNumber(lifecycle, value => value.message_revision)
  const editedByUser = incoming && (latestExchangeBoolean(lifecycle, value => value.message_edited_by_user) === true || (latestRevision ?? 0) > 0)
  const messageRevision = editedByUser ? latestRevision : null
  const bodyEvents = editedByUser ? lifecycle.filter(value => value.message_edited_by_user === true && value.message_revision === messageRevision) : lifecycle
  const bodyRevisionKey = JSON.stringify([workspaceRevision, envelopeId, conversationId, sourceId, targetId, editedByUser, messageRevision])
  const cancelKey = JSON.stringify([workspaceRevision, rowKey, envelopeId, conversationId, sourceId, targetId])
  const cancelScope = useMemo(() => captureTimelineWorkspaceScope(sessionId), [cancelKey, sessionId])
  const [cancelState, setCancelState] = useState<{ key: string; cancelled?: boolean; busy?: boolean; error?: string } | null>(null)
  const cancelInFlight = useRef<string | null>(null)
  const cancelledKey = useRef<string | null>(null)
  const cancelCurrent = useRef({ key: cancelKey, event, lifecycle })
  cancelCurrent.current = { key: cancelKey, event, lifecycle }
  const cancelMounted = useRef(true)
  useEffect(() => { cancelMounted.current = true; return () => { cancelMounted.current = false } }, [])
  const cancellation = cancelState?.key === cancelKey ? cancelState : null
  const cancelMailbox = async () => {
    const current = cancelCurrent.current
    if (cancelInFlight.current || current.key !== cancelKey || !cancelMounted.current
      || cancelledKey.current === cancelKey || !timelineWorkspaceScopeCurrent(cancelScope)
      || !cancelScope.connection.isValidated || cancelScope.connection.isDisposed || !cancelScope.connected
      || !chatMailboxAvailable(useAppStore.getState().health) || !outgoingMailboxCanCancel(current.event, current.lifecycle, sessionId)) return
    cancelInFlight.current = cancelKey
    setCancelState({ key: cancelKey, busy: true })
    const active = () => cancelMounted.current && cancelCurrent.current.key === cancelKey && timelineWorkspaceScopeCurrent(cancelScope)
    try {
      const receipt = await cancelScope.connection.cancelCrossChatHandoff(envelopeId)
      if (!active()) return
      requireMailboxCancellationReceipt(receipt, current.event)
      cancelledKey.current = cancelKey
      setCancelState({ key: cancelKey, cancelled: true })
    } catch (cause) {
      if (active()) setCancelState({ key: cancelKey, error: timelineActionError(cause) })
    } finally { if (cancelInFlight.current === cancelKey) cancelInFlight.current = null }
  }
  const counterpartId = incoming ? sourceId : targetId
  const currentTitle = useAppStore(state => state.sessions.find(value => value.id === counterpartId)?.title)
  const savedTitle = latestExchangeString(lifecycle, value => incoming ? value.source_title : value.target_title)
  const counterpartTitle = savedTitle || currentTitle || 'Unknown agent'
  const preview = latestExchangeString(bodyEvents, value => value.message_body) || latestExchangeString(bodyEvents, value => value.handoff_preview)
  const bodyChars = latestExchangeNumber(bodyEvents, value => value.handoff_body_chars)
  const truncated = latestExchangeBoolean(bodyEvents, value => value.handoff_body_truncated) === true
  const bodyHash = latestExchangeString(bodyEvents, value => value.handoff_body_sha256)
  const moreBodyAvailable = !preview || truncated || (bodyChars ?? 0) > preview.length || /(?:…|\.\.\.)$/u.test(preview)
  const longBody = (bodyChars ?? preview.length) > CROSS_CHAT_LONG_MESSAGE_CHARS || preview.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
  const [loadedBody, setLoadedBody] = useState<{ key: string; preview: string; hash: string; text: string } | null>(null)
  const body = loadedBody?.key === bodyRevisionKey && loadedBody.preview === preview && loadedBody.hash === bodyHash ? loadedBody.text : null
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const requestGeneration = useRef(0)
  const loadingRef = useRef(false)
  useEffect(() => {
    requestGeneration.current += 1
    loadingRef.current = false
    setLoadedBody(null)
    setExpanded(false)
    setLoading(false)
    setLoadError('')
    return () => { requestGeneration.current += 1; loadingRef.current = false }
  }, [rowKey, sessionId, profileGeneration, workspaceRevision, envelopeId, conversationId, sourceId, targetId, preview, bodyHash, bodyRevisionKey])

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
      const text = authenticatedChatMessageBody(loaded, {
        messageId: envelopeId, conversationId, sourceSessionId: sourceId, targetSessionId: targetId,
        incoming, editedByUser, messageRevision: editedByUser ? messageRevision ?? -1 : undefined,
        bodyHash: bodyHash || undefined,
      })
      if (!text.trim()) throw new Error('AgentsServer did not return a message body')
      setLoadedBody({ key: bodyRevisionKey, preview, hash: bodyHash, text })
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
  const cancelled = cancellation?.cancelled || status === 'cancelled' || event.type === 'chat_conversation_message_cancelled'
  const text = expanded ? body ?? preview : longBody ? crossChatCollapsedText(preview) : preview
  const title = incoming ? counterpartTitle : `To ${counterpartTitle}`
  const toggleLabel = loading ? 'Loading full message…' : expanded ? 'Show less' : 'View message'
  const identity = `cross-chat-async-message-${envelopeId || event.id}`
  const time = formatCrossChatTime(anchorTs || event.ts)
  return <CrossChatMessageSurface identity={identity} incoming={incoming} layoutWidth={layoutWidth} sessionId={sessionId}
    peerId={sourceId === sessionId || targetId === sessionId ? counterpartId : null} title={title} time={time}>
      {editedByUser ? <Text style={[styles.note, { color: colors.muted }]}>Edited by you</Text> : null}
      {text ? <MarkdownContent value={text} compact fontScale={fontScale} color={colors.text} />
        : <Text style={[styles.note, { color: colors.muted }]}>Message body available on demand.</Text>}
      {moreBodyAvailable || longBody ? <Pressable
        testID={`${identity}-toggle`}
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        accessibilityState={{ expanded, disabled: loading, busy: loading }}
        disabled={loading}
        onPress={() => expanded ? setExpanded(false) : void showFullMessage()}
        style={({ pressed }) => [styles.conversationBodyToggle, { opacity: loading ? 0.6 : pressed ? 0.72 : 1 }]}
      ><Text style={[styles.conversationBodyToggleText, { color: light ? '#664185' : '#c9b1eb' }]}>{toggleLabel}</Text></Pressable> : null}
      {failed ? <InlineError message={latestExchangeString(lifecycle, value => value.message) || "Couldn't complete"} /> : null}
      {incoming && cancelled ? <Text style={[styles.note, { color: colors.muted }]}>Cancelled</Text> : null}
      {!incoming ? <Text testID={`${identity}-delivery-status`} accessibilityRole="text" accessibilityLiveRegion="polite" style={[styles.note, { color: colors.muted }]}>{cancelled ? 'Cancelled' : outgoingDeliveryStatus(event, lifecycle)}</Text> : null}
      {mailboxAvailable && !cancellation?.cancelled && outgoingMailboxCanCancel(event, lifecycle, sessionId) ? <CardAction testID={`${identity}-cancel`} label={cancellation?.busy ? 'Cancelling…' : 'Cancel unread message'} disabled={Boolean(cancellation?.busy) || !cancelScope.connected || !cancelScope.connection.isValidated || cancelScope.connection.isDisposed} destructive onPress={() => void cancelMailbox()} /> : null}
      {cancellation?.error ? <InlineError prefix="Could not cancel mailbox message" message={cancellation.error} /> : null}
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

function CrossChatHandoffCardScoped({ event, rowKey, sessionId, profileGeneration, fontScale = 1, layoutWidth, anchorTs }: CrossChatCardProps & { profileGeneration: number }) {
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
  const [body, setBody] = useState(truncated ? '' : preview)
  const [expanded, setExpanded] = useState(false)
  const [bodyLimit, setBodyLimit] = useState(CROSS_CHAT_BODY_CHUNK)
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
    setExpanded(false)
    setBodyLimit(CROSS_CHAT_BODY_CHUNK)
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
      setExpanded(true)
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
  const incoming = targetId === sessionId && sourceId !== sessionId
  const title = incoming ? counterpartTitle : `To ${counterpartTitle}`
  const detail = messageText(event).trim()
  const canCancel = sourceId === sessionId && /queued|deferred/u.test(status) && Boolean(envelopeId)
  const fullText = body || preview
  const moreBodyAvailable = Boolean(envelopeId) && (!fullText || (truncated && !body))
  const longBody = fullText.length > CROSS_CHAT_LONG_MESSAGE_CHARS || fullText.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
  const visibleBody = expanded ? fullText.slice(0, bodyLimit) : longBody ? crossChatCollapsedText(fullText) : fullText
  const locallyHidden = expanded && fullText.length > bodyLimit
  const bodyToggleLabel = bodyLoading ? 'Loading full message…' : expanded ? locallyHidden ? 'Show more' : 'Show less' : 'View message'
  const toggleBody = () => {
    if (moreBodyAvailable) { void loadBody(); return }
    if (locallyHidden) { setBodyLimit(value => value + CROSS_CHAT_BODY_CHUNK); return }
    setExpanded(value => !value)
    setBodyLimit(CROSS_CHAT_BODY_CHUNK)
  }
  return <CrossChatMessageSurface identity={`cross-chat-handoff-${envelopeId || event.id}`} incoming={incoming}
    layoutWidth={layoutWidth} sessionId={sessionId} peerId={sourceId === sessionId || targetId === sessionId ? counterpartId : null}
    title={title} time={formatCrossChatTime(anchorTs || event.ts)}>
    {fullText ? <MarkdownContent value={`${visibleBody}${locallyHidden ? '…' : ''}`} compact fontScale={fontScale} color={colors.text} />
      : <Text style={[styles.note, { color: colors.muted }]}>{detail || 'Message body available on demand.'}</Text>}
    {moreBodyAvailable || longBody ? <Pressable testID={`cross-chat-handoff-body-${envelopeId}`} accessibilityRole="button"
      accessibilityLabel={bodyToggleLabel} accessibilityState={{ expanded, busy: bodyLoading, disabled: bodyLoading }} disabled={bodyLoading}
      onPress={toggleBody} style={styles.conversationBodyToggle}>
      <Text style={[styles.conversationBodyToggleText, { color: colors.muted }]}>{bodyToggleLabel}</Text>
    </Pressable> : null}
    {failed && preview ? <InlineError message={detail || crossChatTitle(displayEvent, counterpartTitle, sessionId)} /> : null}
    {incoming && status === 'cancelled' ? <Text style={[styles.note, { color: colors.muted }]}>Cancelled</Text> : null}
    {!incoming ? <Text style={[styles.note, { color: colors.muted }]} accessibilityLiveRegion="polite">{legacyOutgoingDeliveryStatus(status, displayEvent.type)}</Text> : null}
    {bodyError ? <InlineError prefix="Could not load full message" message={bodyError} /> : null}
    {cancelError ? <InlineError prefix="Could not cancel handoff" message={cancelError} /> : null}
    {canCancel ? <CardAction testID={`cross-chat-cancel-handoff-${envelopeId}`} label={cancelling ? 'Cancelling…' : 'Cancel handoff'} destructive disabled={cancelling} onPress={() => void cancelHandoff()} /> : null}
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
  const conversationPalette = useColorScheme() === 'light'
    ? CROSS_CHAT_CONVERSATION_LIGHT
    : CROSS_CHAT_CONVERSATION_DARK
  const exchangeId = event.exchange_id?.trim() || event.cross_chat_exchange_id?.trim() || ''
  const lifecycleEvents = useMemo(() => (events?.length ? events : [event])
    .filter(candidate => (candidate.exchange_id?.trim() || candidate.cross_chat_exchange_id?.trim() || '') === exchangeId)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)), [event, events, exchangeId])
  const observedLegs = useMemo(() => lifecycleExchangeLegs(lifecycleEvents), [lifecycleEvents])
  const sessions = useAppStore(state => state.sessions)
  const canSkipExactDelivery = useAppStore(state => exactQueuedDeliverySkipAvailable(state.health))
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
  const [detailsOpen, setDetailsOpen] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
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
    setDetailsOpen(false)
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

  const initialAction = (latestExchangeString(lifecycleEvents, candidate => candidate.exchange_initial_action)
    || exchange?.initial_action
    || null) as CrossChatExchange['initial_action']
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
  const maxLegs = latestExchangeNumber(lifecycleEvents, candidate => candidate.exchange_max_legs) ?? exchange?.max_legs ?? 6
  const usedLegs = latestExchangeNumber(lifecycleEvents, candidate => candidate.exchange_used_legs) ?? exchange?.used_legs ?? conversationLegs.length
  const remainingLegs = latestExchangeNumber(lifecycleEvents, candidate => candidate.exchange_remaining_legs) ?? exchange?.remaining_legs ?? null
  const participant = exchange ? exchangeParticipant(exchange, sessionId) : [requesterId, responderId, sourceId, targetId].includes(sessionId)
  const canCancel = participant && Boolean(exchangeId) && (!queuedDelivery || !canSkipExactDelivery) && ['waiting_request', 'active'].includes(exchangeStatus)
  const authorizationKind = latestExchangeString(lifecycleEvents, candidate => candidate.exchange_authorization_kind)
  const authorizationLabel = crossChatAuthorizationLabel(authorizationKind)
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
  const technicalNotes = [...new Set([
    ...(failed && errorText ? [exchangeRecoveryNote(String(errorText))] : []),
    ...conversationLegs.flatMap(leg => (
      leg.status === 'failed'
        ? [exchangeRecoveryNote(leg.error || leg.error_code || '')].filter(Boolean)
        : []
    )),
    ...(failed
      ? [exchange?.error_code, errorEvent?.exchange_error_code, ...conversationLegs.map(leg => leg.status === 'failed' ? leg.error_code : '')]
          .filter((value): value is string => Boolean(value))
          .map(code => `Reason code: ${code}`)
      : []),
  ])]
  const showConversationDetails = Boolean(authorizationLabel || initialAction || maxLegs || technicalNotes.length)
  const stateColor = crossChatConversationStateColor(conversationPalette, exchangeStatus, failed)

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
      return <ConversationLeg key={leg.id}
        leg={leg} index={index} sessionId={sessionId}
        sourceTitle={titleFor(leg.source_session_id, 'Other agent')}
        targetTitle={titleFor(leg.target_session_id, 'Other agent')}
        current={!terminalStatus && actionMessage}
        bodyComplete={snapshotCurrent} loading={loading} palette={conversationPalette}
        fontScale={fontScale} layoutWidth={layoutWidth} anchorTs={anchorTs}
        onRequestFull={() => { setOpen(true); void loadExchange() }}
      >
        {actionMessage ? <>
          <Text accessibilityRole="text" accessibilityLabel={`Conversation status: ${stateLabel}`} accessibilityLiveRegion="polite" style={[styles.note, { color: stateColor }]}>
            {skippedQueuedId ? 'Queued message removed.' : deliveryPromoted && !terminalStatus ? 'Starting' : stateLabel}
          </Text>
          {failureSummary ? <ConversationInlineError prefix="Could not complete conversation" message={failureSummary} palette={conversationPalette} /> : null}
          {showConversationDetails ? <View style={styles.conversationDetails}>
            <Pressable testID={`cross-chat-details-${exchangeId}`} accessibilityRole="button"
              accessibilityLabel={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
              accessibilityState={{ expanded: detailsOpen }} onPress={() => setDetailsOpen(value => !value)} style={styles.conversationDetailsToggle}>
              <Text style={[styles.conversationDetailsToggleText, { color: conversationPalette.toggle }]}>Details</Text>
            </Pressable>
            {detailsOpen ? <View style={styles.conversationDetailLines}>
              {authorizationLabel ? <ConversationDetailLine label="Access" value={authorizationLabel} palette={conversationPalette} /> : null}
              {initialAction ? <ConversationDetailLine label="Started as" value={initialAction === 'instruction' ? 'Instruction' : 'Question with replies'} palette={conversationPalette} /> : null}
              <ConversationDetailLine label="Messages" value={`${usedLegs} of ${maxLegs}`} palette={conversationPalette} />
              {!terminalStatus && remainingLegs != null ? <ConversationDetailLine label="Remaining" value={String(remainingLegs)} palette={conversationPalette} /> : null}
              {technicalNotes.map(note => <ConversationDetailLine key={note} label="System note" value={note} note palette={conversationPalette} />)}
            </View> : null}
          </View> : null}
          {cancelError ? <ConversationInlineError prefix="Could not end the conversation" message={cancelError} palette={conversationPalette} /> : null}
          {skipError ? <ConversationInlineError prefix="Could not remove the queued message" message={skipError} palette={conversationPalette} /> : null}
          {queuedDelivery && canSkipExactDelivery ? <ConversationAction testID={`cross-chat-skip-delivery-${queuedDelivery.queued_id}`} label={skipping ? 'Removing…' : 'Remove queued message'} destructive disabled={skipping} palette={conversationPalette} onPress={() => void skipQueuedDelivery()} /> : null}
          {canCancel ? <ConversationAction testID={`cross-chat-cancel-exchange-${exchangeId}`} label={cancelling ? 'Ending…' : 'End conversation'} accessibilityHint="Stops future messages; work already in progress may still finish." destructive disabled={cancelling} palette={conversationPalette} onPress={() => void cancelExchange()} /> : null}
        </> : null}
        {loadError ? <ConversationInlineError prefix="Could not load full message" message={loadError} palette={conversationPalette} /> : null}
      </ConversationLeg>
    })}
    {!displayedLegs.length ? <CrossChatMessageSurface identity={`cross-chat-empty-${exchangeId}`} incoming={targetId === sessionId && sourceId !== sessionId}
      layoutWidth={layoutWidth} sessionId={sessionId} peerId={participant ? counterpartId : null} title={counterpartTitle} time={formatCrossChatTime(event.ts)}>
      <Text style={[styles.note, { color: conversationPalette.placeholder }]}>{stateLabel}</Text>
      <ConversationControl testID={`cross-chat-load-exchange-${exchangeId}`} label={loading ? 'Loading messages…' : 'View message'}
        palette={conversationPalette} onPress={() => { setOpen(true); void loadExchange() }} />
      {canCancel ? <ConversationAction testID={`cross-chat-cancel-exchange-${exchangeId}`} label={cancelling ? 'Ending…' : 'End conversation'} destructive disabled={cancelling} palette={conversationPalette} onPress={() => void cancelExchange()} /> : null}
      {loadError ? <ConversationInlineError prefix="Could not load full message" message={loadError} palette={conversationPalette} /> : null}
      {cancelError ? <ConversationInlineError prefix="Could not end the conversation" message={cancelError} palette={conversationPalette} /> : null}
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

function crossChatConversationStateColor(
  palette: CrossChatConversationPalette,
  status: CrossChatExchangeStatus | null,
  failed: boolean,
): string {
  if (failed || status === 'failed') return palette.stateFailed
  if (status === 'completed') return palette.stateCompleted
  if (status === 'cancelled' || status === 'expired') return palette.stateTerminal
  return palette.state
}

function crossChatAuthorizationLabel(kind: string): string | null {
  if (kind === 'configured_route') return 'Agent-authored same-server access'
  if (kind === 'explicit_prompt') return 'User-addressed'
  return null
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
  if (!body) return true
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

function formatCrossChatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? crossChatTimeFormatter.format(date) : ''
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

function ConversationLeg({
  leg,
  index,
  sessionId,
  sourceTitle,
  targetTitle,
  current,
  bodyComplete,
  loading,
  palette,
  fontScale,
  layoutWidth,
  anchorTs,
  children,
  onRequestFull,
}: {
  leg: CrossChatConversationLeg
  index: number
  sessionId: string
  sourceTitle: string
  targetTitle: string
  current: boolean
  bodyComplete: boolean
  loading: boolean
  palette: CrossChatConversationPalette
  fontScale: number
  layoutWidth?: number
  anchorTs?: string
  children?: ReactNode
  onRequestFull: () => void
}) {
  const identity = `${leg.exchange_id}:${leg.id}:${leg.body_sha256}`
  const colors = usePalette()
  const [expanded, setExpanded] = useRecyclingState(false, [leg.exchange_id, leg.id])
  const [limit, setLimit] = useRecyclingState(CROSS_CHAT_BODY_CHUNK, [identity])
  const fromThisChat = leg.source_session_id === sessionId
  const incoming = leg.target_session_id === sessionId && !fromThisChat
  const messageNumber = leg.ordinal > 0 ? leg.ordinal : index + 1
  const mayHaveMoreBody = crossChatLegMayHaveMoreBody(leg, bodyComplete)
  const longBody = crossChatLegBodyIsLong(leg)
  const bodyExpanded = expanded || !longBody
  const completeVisibleBody = bodyExpanded ? leg.body : crossChatCollapsedText(leg.body)
  const visibleBody = completeVisibleBody.slice(0, limit)
  const locallyHidden = Math.max(0, completeVisibleBody.length - visibleBody.length)
  const showBodyToggle = mayHaveMoreBody || longBody || locallyHidden > 0
  const toggleLabel = mayHaveMoreBody && loading
    ? 'Loading…'
    : mayHaveMoreBody || !bodyExpanded || locallyHidden > 0
      ? locallyHidden > 0 && expanded ? 'Show more' : 'View message'
      : 'Show less'
  const toggleBody = () => {
    if (mayHaveMoreBody) {
      setExpanded(true)
      onRequestFull()
      return
    }
    if (!bodyExpanded) {
      setExpanded(true)
      return
    }
    if (locallyHidden > 0) {
      setLimit(value => Math.min(completeVisibleBody.length, value + CROSS_CHAT_BODY_CHUNK))
      return
    }
    setExpanded(false)
  }
  const accessibilityLabel = [
    `Message ${messageNumber} from ${sourceTitle} to ${targetTitle}.`,
    `${statusLabel(leg.status)}.`,
    fromThisChat ? 'From this chat.' : '',
    current ? 'Current conversation step.' : '',
  ].filter(Boolean).join(' ')

  return <CrossChatMessageSurface identity={`cross-chat-message-${leg.id}`} incoming={incoming} layoutWidth={layoutWidth}
    sessionId={sessionId} peerId={leg.source_session_id === sessionId || leg.target_session_id === sessionId ? incoming ? leg.source_session_id : leg.target_session_id : null}
    title={incoming ? sourceTitle : `To ${targetTitle}`} time={formatCrossChatTime(anchorTs || leg.created_at)}>
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: current }}
    >
    {leg.body ? <MarkdownContent value={`${visibleBody}${locallyHidden ? '…' : ''}`} compact color={colors.text} fontScale={fontScale} />
      : null}
    {!leg.body && mayHaveMoreBody ? <Text style={[styles.conversationPlaceholder, { color: palette.placeholder }]}>Message body available on demand.</Text> : null}
    {showBodyToggle ? <Pressable
      testID={`cross-chat-message-toggle-${leg.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${toggleLabel} for message ${messageNumber}`}
      accessibilityState={{ expanded: !mayHaveMoreBody && bodyExpanded && locallyHidden === 0, disabled: mayHaveMoreBody && loading }}
      disabled={mayHaveMoreBody && loading}
      onPress={toggleBody}
      style={({ pressed }) => [styles.conversationBodyToggle, { opacity: mayHaveMoreBody && loading ? 0.6 : pressed ? 0.72 : 1 }]}
    ><Text style={[styles.conversationBodyToggleText, { color: palette.toggle }]}>{toggleLabel}</Text></Pressable> : null}
    {children}
    </View>
  </CrossChatMessageSurface>
}

function ConversationControl({
  testID,
  label,
  expanded,
  palette,
  onPress,
}: {
  testID: string
  label: string
  expanded?: boolean
  palette: CrossChatConversationPalette
  onPress: () => void
}) {
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={typeof expanded === 'boolean' ? { expanded } : undefined}
    onPress={onPress}
    style={styles.conversationControl}
  >{({ pressed }) => <Text style={[styles.conversationControlText, { color: pressed ? palette.controlPressed : palette.control }]}>{label}</Text>}</Pressable>
}

function ConversationInlineError({ prefix, message, palette }: { prefix: string; message: string; palette: CrossChatConversationPalette }) {
  const detail = boundedInlineText(message)
  return <View accessibilityRole="alert" style={styles.conversationInlineError}>
    <AlertTriangle size={12} color={palette.failure} />
    <Text selectable style={[styles.conversationInlineErrorText, { color: palette.failure }]}>{prefix}: {detail}</Text>
  </View>
}

function ConversationDetailLine({
  label,
  value,
  note = false,
  palette,
}: {
  label: string
  value: string
  note?: boolean
  palette: CrossChatConversationPalette
}) {
  return <Text selectable style={[styles.conversationDetailLine, { color: note ? palette.detailNote : palette.detailText }]}>
    <Text style={{ color: palette.detailStrong, fontWeight: '700' }}>{label}:</Text> {value}
  </Text>
}

function ConversationAction({
  testID,
  label,
  accessibilityHint,
  destructive = false,
  disabled = false,
  palette,
  onPress,
}: {
  testID: string
  label: string
  accessibilityHint?: string
  destructive?: boolean
  disabled?: boolean
  palette: CrossChatConversationPalette
  onPress: () => void
}) {
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={accessibilityHint}
    accessibilityState={{ disabled, busy: disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.conversationAction, { opacity: disabled ? 0.6 : pressed ? 0.72 : 1 }]}
  >{({ pressed }) => <Text style={[
    styles.conversationActionText,
    { color: destructive ? pressed ? palette.destructivePressed : palette.destructive : palette.link },
  ]}>{label}</Text>}</Pressable>
}

function InlineError({ prefix, message }: { prefix?: string; message: string }) {
  const colors = usePalette()
  const detail = boundedInlineText(message)
  return <View accessibilityRole="alert" style={styles.inlineError}><AlertTriangle size={13} color={colors.red} /><Text selectable style={[styles.errorText, { color: colors.red }]}>{prefix ? `${prefix}: ${detail}` : detail}</Text></View>
}

function CardAction({ testID, label, onPress, destructive = false, disabled = false }: { testID: string; label: string; onPress: () => void; destructive?: boolean; disabled?: boolean }) {
  const colors = usePalette()
  const color = destructive ? colors.red : colors.blue
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.action, { borderColor: color, backgroundColor: `${color}${pressed ? '20' : '0D'}`, opacity: disabled ? 0.55 : 1 }]}
  ><Text style={[styles.actionText, { color }]} numberOfLines={1}>{label}</Text></Pressable>
}

const styles = StyleSheet.create({
  asyncMessage: { minWidth: 0, marginHorizontal: 14, marginVertical: 8 },
  asyncMessageSurface: { minWidth: 0, maxWidth: 760, paddingVertical: 10, paddingHorizontal: 13, borderWidth: 1, borderRadius: 10 },
  asyncMessageHeader: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 },
  asyncMessageTitle: { flexShrink: 1, minWidth: 0, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  referenceList: { gap: 6, marginTop: 8 },
  referenceChip: { minHeight: 44, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  referenceText: { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 16 },
  referenceStrong: { fontWeight: '800' },
  note: { fontSize: 10.5, lineHeight: 15, marginTop: 6 },
  inlineError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorText: { flex: 1, fontSize: 10.5, lineHeight: 15 },
  action: { minHeight: 44, maxWidth: '100%', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: 11, fontWeight: '800' },
  conversationTime: { flexShrink: 0, marginLeft: 'auto', fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  conversationControl: { minWidth: 44, minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 2 },
  conversationControlText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationPlaceholder: { marginTop: 6, fontSize: 9, lineHeight: 13 },
  conversationBodyToggle: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  conversationBodyToggleText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationInlineError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6 },
  conversationInlineErrorText: { minWidth: 0, flex: 1, fontSize: 9.5, lineHeight: 14 },
  conversationDetails: { marginTop: 3 },
  conversationDetailsToggle: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  conversationDetailsToggleText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationDetailLines: { marginTop: -4, paddingBottom: 3 },
  conversationDetailLine: { marginVertical: 2, fontSize: 9, lineHeight: 14 },
  conversationAction: { minWidth: 44, minHeight: 44, maxWidth: '100%', justifyContent: 'center' },
  conversationActionText: { fontSize: 10, lineHeight: 15, fontWeight: '700' },
})
