import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, useColorScheme, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import { AlertTriangle, ChevronDown, ChevronRight, MessageSquareShare } from 'lucide-react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import type { AgentServerClient } from '../api/AgentServerClient'
import { exactQueuedDeliverySkipAvailable } from '../lib/chat-references'
import { formatDateTime, messageText } from '../lib/format'
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

// Shared by conversation surfaces so legacy one-shot handoffs retain their
// blue treatment. These are the current Mac conversation colors, not generic
// app theme tokens.
export const CROSS_CHAT_CONVERSATION_DARK = {
  gradientStart: '#281f3b',
  gradientEnd: '#211b31',
  border: '#594675',
  accent: '#8c6fe8',
  shadow: '#130c22',
  shadowOpacity: 0.28,
  icon: '#bca8ff',
  eyebrow: '#bba9ef',
  state: '#cfc3ef',
  stateCompleted: '#aee2c4',
  stateFailed: '#ffb4af',
  stateTerminal: '#b7a9d6',
  title: '#eee9ff',
  participants: '#a99bc9',
  participantCurrent: '#e8e0ff',
  bridge: '#9682ca',
  speaker: '#eee8ff',
  currentDot: '#a98cf5',
  body: '#ded6f1',
  incomingBackground: '#302640',
  incomingBorder: '#4d3e61',
  toggle: '#b9a5ec',
  control: '#c3b2ee',
  controlPressed: '#f0ebff',
  placeholder: '#a99bc9',
  empty: '#ad9fcf',
  failure: '#ffbbb6',
  details: '#9f91bf',
  detailText: '#a99bc9',
  detailStrong: '#c9bde6',
  detailNote: '#baabc9',
  link: '#7eb8e6',
  destructive: '#93adc3',
  destructivePressed: '#ffaaa5',
} as const

export const CROSS_CHAT_CONVERSATION_LIGHT: CrossChatConversationPalette = {
  gradientStart: '#f5f1ff',
  gradientEnd: '#eee8fb',
  border: '#c8b7e3',
  accent: '#8566bd',
  shadow: '#5b477c',
  shadowOpacity: 0.1,
  icon: '#7050aa',
  eyebrow: '#7055a1',
  state: '#5c467f',
  stateCompleted: '#276847',
  stateFailed: '#922824',
  stateTerminal: '#705c89',
  title: '#3f2e61',
  participants: '#705c89',
  participantCurrent: '#452d6b',
  bridge: '#8065aa',
  speaker: '#46315f',
  currentDot: '#7652ad',
  body: '#503e68',
  incomingBackground: '#faf8ff',
  incomingBorder: '#d4c7e6',
  toggle: '#67458f',
  control: '#5b3d80',
  controlPressed: '#3f265f',
  placeholder: '#75618f',
  empty: '#705c89',
  failure: '#842722',
  details: '#705c89',
  detailText: '#705c89',
  detailStrong: '#52366f',
  detailNote: '#765f86',
  link: '#276997',
  destructive: '#58778f',
  destructivePressed: '#922824',
}

export type CrossChatConversationPalette = {
  [Key in Exclude<keyof typeof CROSS_CHAT_CONVERSATION_DARK, 'shadowOpacity'>]: string
} & { shadowOpacity: number }

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

function captureTimelineWorkspaceScope(sessionId: string): TimelineWorkspaceScope {
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

function timelineWorkspaceScopeCurrent(scope: TimelineWorkspaceScope): boolean {
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

function useTimelineWorkspaceRevision(sessionId: string): string {
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

interface CrossChatCardProps { event: Event; events?: Event[]; rowKey: string; sessionId: string; fontScale?: number }

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

function CrossChatHandoffCardScoped({ event, rowKey, sessionId, profileGeneration }: CrossChatCardProps & { profileGeneration: number }) {
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
  const counterpartAvailable = Boolean(counterpart && !counterpart.archived)
  const preview = event.handoff_preview?.trim() || ''
  const truncated = event.handoff_body_truncated === true
  const [open, setOpen] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
  const [body, setBody] = useState(truncated ? '' : preview)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const [cancelled, setCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [openError, setOpenError] = useState('')
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
    setCancelled(false)
    setCancelling(false)
    setCancelError('')
    setOpenError('')
  }, [envelopeId, preview, profileGeneration, rowKey, sessionId, truncated, workspaceRevision])

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
      setCancelled(true)
    } catch (error) {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) setCancelError(timelineActionError(error))
    } finally {
      if (request === cancelRequest.current && timelineWorkspaceScopeCurrent(scope)) {
        cancellingRef.current = false
        setCancelling(false)
      }
    }
  }

  const displayEvent = cancelled ? { ...event, handoff_status: 'cancelled' } : event
  const status = handoffStatus(displayEvent)
  const failed = /failed|error/u.test(status)
  const title = crossChatTitle(displayEvent, counterpartTitle, sessionId)
  const detail = messageText(event).trim()
  const canCancel = sourceId === sessionId && /queued|deferred/u.test(status) && Boolean(envelopeId)
  const hasDetail = Boolean(envelopeId || preview || detail || counterpartId || canCancel)
  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next) void loadBody()
  }

  return <View style={[styles.card, { borderColor: failed ? colors.red : colors.blue, backgroundColor: failed ? `${colors.red}12` : `${colors.blue}0D` }]}>
    <Pressable
      testID={`cross-chat-handoff-${envelopeId || event.id}`}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: open }}
      disabled={!hasDetail}
      onPress={toggleOpen}
      style={styles.cardHeader}
    >
      {failed ? <AlertTriangle size={15} color={colors.red} /> : <MessageSquareShare size={15} color={colors.blue} />}
      <View style={styles.heading}>
        <Text style={[styles.title, { color: failed ? colors.red : colors.text }]} numberOfLines={2}>{title}</Text>
        <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>{directionLabel(sourceId, sessionId)} · {statusLabel(status)} · {formatDateTime(event.ts)}</Text>
      </View>
      {hasDetail ? open ? <ChevronDown size={15} color={colors.muted} /> : <ChevronRight size={15} color={colors.muted} /> : null}
    </Pressable>
    {open ? <View style={[styles.detail, { borderTopColor: colors.border }]}>
      {detail && detail !== title ? <Text selectable style={[styles.detailText, { color: colors.text }]}>{boundedInlineText(detail)}</Text> : null}
      {body || preview ? <BoundedBody identity={`${envelopeId}:${event.handoff_body_sha256 || body.length}`} text={body || preview} /> : null}
      {bodyLoading ? <InlineStatus label="Loading full message…" /> : null}
      {!bodyLoading && truncated && !body && !bodyError ? <Text style={[styles.note, { color: colors.muted }]}>Preview shown while the full message loads.</Text> : null}
      {bodyError ? <InlineError prefix="Could not load full message" message={bodyError} /> : null}
      {cancelError ? <InlineError prefix="Could not cancel handoff" message={cancelError} /> : null}
      {openError ? <InlineError prefix="Could not open referenced chat" message={openError} /> : null}
      <View style={styles.actions}>
        {counterpartId && counterpartAvailable ? <CardAction testID={`cross-chat-open-${counterpartId}`} label={`Open ${counterpartTitle}`} onPress={() => {
          setOpenError('')
          openTargetSession(counterpartId, sessionId, profileGeneration, setOpenError)
        }} /> : null}
        {canCancel ? <CardAction testID={`cross-chat-cancel-handoff-${envelopeId}`} label={cancelling ? 'Cancelling…' : 'Cancel handoff'} destructive disabled={cancelling} onPress={() => void cancelHandoff()} /> : null}
      </View>
    </View> : null}
  </View>
}

export function CrossChatExchangeCard(props: CrossChatCardProps) {
  const profileGeneration = useAppStore(state => state.profileGeneration)
  return <CrossChatExchangeCardScoped
    key={`${profileGeneration}:${props.sessionId}:${props.rowKey}`}
    {...props}
    profileGeneration={profileGeneration}
  />
}

function CrossChatExchangeCardScoped({ event, events, rowKey, sessionId, profileGeneration, fontScale = 1 }: CrossChatCardProps & { profileGeneration: number }) {
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
  const [showEarlier, setShowEarlier] = useRecyclingState(false, [profileGeneration, rowKey, sessionId])
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
  const [openError, setOpenError] = useState('')
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
    setOpenError('')
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
  const requesterTitle = titleFor(requesterId, requesterId === sessionId ? 'This chat' : 'Requesting agent')
  const responderTitle = titleFor(responderId, responderId === sessionId ? 'This chat' : 'Responding agent')
  const counterpartId = counterpartSessionId(sessionId, sourceId, targetId, requesterId, responderId)
  const counterpartTitle = titleFor(counterpartId, 'another chat')
  const counterpartAvailable = sessions.some(candidate => candidate.id === counterpartId && !candidate.archived)

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
  const title = counterpartId ? `Conversation with ${counterpartTitle}` : 'Agent conversation'
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
  const primaryIds = new Set([conversationLegs[0]?.id, conversationLegs.at(-1)?.id, terminalStatus ? null : actionLeg?.id].filter((value): value is string => Boolean(value)))
  const hiddenLegs = conversationLegs.filter(leg => !primaryIds.has(leg.id))
  const firstHiddenLegId = hiddenLegs[0]?.id || ''
  const allConversationLegsVisible = showEarlier || open
  const hasExpandableMessage = conversationLegs.some(leg => crossChatLegMayHaveMoreBody(leg, snapshotCurrent) || crossChatLegBodyIsLong(leg))
  const showConversationControls = Boolean(exchangeId) && (
    open
    || !exchange
    || !snapshotCurrent
    || hiddenLegs.length > 0
    || hasExpandableMessage
  )
  const showConversationDetails = Boolean(authorizationLabel || initialAction || maxLegs || technicalNotes.length)
  const preview = latestExchangeString(lifecycleEvents, candidate => candidate.handoff_preview)
  const conversationLabel = `Agent conversation between ${requesterTitle} and ${responderTitle}`
  const stateColor = crossChatConversationStateColor(conversationPalette, exchangeStatus, failed)
  const expandConversation = () => {
    setOpen(true)
    setShowEarlier(true)
    if (!exchange || !snapshotCurrent || conversationLegs.some(leg => crossChatLegMayHaveMoreBody(leg, snapshotCurrent))) void loadExchange()
  }
  const collapseConversation = () => {
    setOpen(false)
    setShowEarlier(false)
  }

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

  return <CrossChatConversationSurface
    testID={`cross-chat-exchange-${exchangeId || event.id}`}
    palette={conversationPalette}
    failed={failed}
  >
    <View style={styles.conversationHeader}>
      <Text style={[styles.conversationEyebrow, { color: conversationPalette.eyebrow }]}>Agent conversation</Text>
      <Text style={[styles.conversationTime, { color: conversationPalette.participants }]}>{formatCrossChatTime(event.ts)}</Text>
    </View>
    <View style={styles.conversationHeading}>
      <Text style={[styles.conversationTitle, { color: conversationPalette.title }]} numberOfLines={1}>{title}</Text>
      <View accessibilityRole="text" accessibilityLabel={`Conversation status: ${stateLabel}`} style={styles.conversationState}>
        {failed ? <AlertTriangle size={11} color={stateColor} /> : null}
        <Text style={[styles.conversationStateText, { color: stateColor }]} numberOfLines={1}>{stateLabel}</Text>
      </View>
    </View>
    <View accessible accessibilityRole="text" accessibilityLabel={conversationLabel} style={styles.conversationParticipants}>
      <Text style={[styles.conversationParticipant, { color: requesterId === sessionId ? conversationPalette.participantCurrent : conversationPalette.participants }]} numberOfLines={1}>
        {requesterTitle}{requesterId === sessionId ? ' (this chat)' : ''}
      </Text>
      <Text accessibilityElementsHidden style={[styles.conversationBridge, { color: conversationPalette.bridge }]}>↔</Text>
      <Text style={[styles.conversationParticipant, { color: responderId === sessionId ? conversationPalette.participantCurrent : conversationPalette.participants }]} numberOfLines={1}>
        {responderTitle}{responderId === sessionId ? ' (this chat)' : ''}
      </Text>
    </View>
    {showConversationControls ? <View style={styles.conversationControls}>
      <ConversationControl
        testID={`cross-chat-toggle-conversation-${exchangeId}`}
        label={open ? 'Show less' : 'Show full conversation'}
        expanded={open}
        palette={conversationPalette}
        onPress={open ? collapseConversation : expandConversation}
      />
      {loading ? <ConversationInlineStatus label="Loading messages…" palette={conversationPalette} /> : null}
      {loadError && !loading ? <ConversationControl testID={`cross-chat-retry-exchange-${exchangeId}`} label="Retry loading" palette={conversationPalette} onPress={() => void loadExchange()} /> : null}
    </View> : null}
    {loadError ? <ConversationInlineError prefix="Could not load the full conversation" message={loadError} palette={conversationPalette} /> : null}
    <View accessibilityLabel={conversationLabel} style={styles.conversationTranscript}>
      {conversationLegs.map((leg, index) => {
        const isFirstHidden = leg.id === firstHiddenLegId
        const fold = isFirstHidden && !open ? <ConversationFold
          testID={allConversationLegsVisible ? `cross-chat-hide-earlier-${exchangeId}` : `cross-chat-show-earlier-${exchangeId}`}
          label={allConversationLegsVisible
            ? 'Hide earlier messages'
            : `Show ${hiddenLegs.length} earlier ${hiddenLegs.length === 1 ? 'message' : 'messages'}`}
          expanded={allConversationLegsVisible}
          palette={conversationPalette}
          onPress={() => setShowEarlier(value => !value)}
        /> : null
        if (!allConversationLegsVisible && !primaryIds.has(leg.id)) {
          return fold ? <Fragment key={`fold:${leg.id}`}>{fold}</Fragment> : null
        }
        const sourceTitle = titleFor(leg.source_session_id, leg.source_session_id === sessionId ? 'This chat' : 'Other agent')
        const targetTitle = titleFor(leg.target_session_id, leg.target_session_id === sessionId ? 'This chat' : 'Other agent')
        return <Fragment key={leg.id}>
          {fold}
          <ConversationLeg
            leg={leg}
            index={index}
            requesterId={requesterId}
            sessionId={sessionId}
            sourceTitle={sourceTitle}
            targetTitle={targetTitle}
            current={!terminalStatus && actionLeg?.id === leg.id}
            conversationExpanded={open}
            bodyComplete={snapshotCurrent}
            loading={loading}
            palette={conversationPalette}
            fontScale={fontScale}
            onRequestFull={() => void loadExchange()}
          />
        </Fragment>
      })}
      {!conversationLegs.length && preview ? <Text selectable style={[styles.conversationPreview, { color: conversationPalette.body }]}>{crossChatCollapsedText(preview)}</Text> : null}
      {!conversationLegs.length && !preview && !loading ? <Text style={[styles.conversationEmpty, { color: conversationPalette.empty }]}>Waiting for the first agent message.</Text> : null}
    </View>
    {failureSummary ? <Text accessibilityRole="alert" selectable style={[styles.conversationFailure, { color: conversationPalette.failure }]}>{failureSummary}</Text> : null}
    {showConversationDetails ? <View style={styles.conversationDetails}>
      <Pressable
        testID={`cross-chat-details-${exchangeId}`}
        accessibilityRole="button"
        accessibilityLabel={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
        accessibilityState={{ expanded: detailsOpen }}
        onPress={() => setDetailsOpen(value => !value)}
        style={styles.conversationDetailsToggle}
      ><Text style={[styles.conversationDetailsToggleText, { color: conversationPalette.toggle }]}>Details</Text></Pressable>
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
    {skippedQueuedId ? <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[styles.conversationNotice, { color: conversationPalette.details }]}>Queued message removed.</Text> : null}
    {openError ? <ConversationInlineError prefix="Could not open referenced chat" message={openError} palette={conversationPalette} /> : null}
    <View style={styles.conversationActions}>
      {counterpartId && counterpartAvailable ? <ConversationAction testID={`cross-chat-open-${counterpartId}`} label={`Open ${counterpartTitle}`} palette={conversationPalette} onPress={() => { setOpenError(''); openTargetSession(counterpartId, sessionId, profileGeneration, setOpenError) }} /> : null}
      {queuedDelivery && canSkipExactDelivery ? <ConversationAction testID={`cross-chat-skip-delivery-${queuedDelivery.queued_id}`} label={skipping ? 'Removing…' : 'Remove queued message'} destructive disabled={skipping} palette={conversationPalette} onPress={() => void skipQueuedDelivery()} /> : null}
      {canCancel ? <ConversationAction testID={`cross-chat-cancel-exchange-${exchangeId}`} label={cancelling ? 'Ending…' : 'End conversation'} accessibilityHint="Stops future messages; work already in progress may still finish." destructive disabled={cancelling} palette={conversationPalette} onPress={() => void cancelExchange()} /> : null}
    </View>
  </CrossChatConversationSurface>
}

export function CrossChatConversationSurface({ testID, palette, children, failed = false }: {
  testID: string
  palette: CrossChatConversationPalette
  children: ReactNode
  failed?: boolean
}) {
  return <View style={[
    styles.conversationShadow,
    { shadowColor: palette.shadow, shadowOpacity: palette.shadowOpacity },
  ]}>
    <View
      testID={testID}
      style={[
        styles.conversationCard,
        { borderColor: palette.border, backgroundColor: palette.gradientEnd },
      ]}
    >
      <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="cross-chat-conversation-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={palette.gradientStart} />
            <Stop offset="100%" stopColor={palette.gradientEnd} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#cross-chat-conversation-gradient)" />
      </Svg>
      <View pointerEvents="none" style={[styles.conversationAccent, { backgroundColor: palette.accent }]} />
      <View style={styles.conversationLayout}>
        <View style={styles.conversationIcon}>
          {failed
            ? <AlertTriangle size={14} color={palette.icon} />
            : <MessageSquareShare size={14} color={palette.icon} />}
        </View>
        <View style={styles.conversationContent}>{children}</View>
      </View>
    </View>
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
  if ((leg.body_chars ?? 0) > body.length) return true
  return body.endsWith('…') || body.endsWith('...')
}

function crossChatLegBodyIsLong(leg: CrossChatConversationLeg): boolean {
  return (leg.body_chars ?? leg.body.length) > CROSS_CHAT_LONG_MESSAGE_CHARS
    || leg.body.split('\n').length > CROSS_CHAT_LONG_MESSAGE_LINES
}

function crossChatCollapsedText(value: string): string {
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

function directionLabel(sourceId: string, sessionId: string): string {
  return sourceId && sourceId !== sessionId ? 'Incoming' : 'Outgoing'
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
  requesterId,
  sessionId,
  sourceTitle,
  targetTitle,
  current,
  conversationExpanded,
  bodyComplete,
  loading,
  palette,
  fontScale,
  onRequestFull,
}: {
  leg: CrossChatConversationLeg
  index: number
  requesterId: string
  sessionId: string
  sourceTitle: string
  targetTitle: string
  current: boolean
  conversationExpanded: boolean
  bodyComplete: boolean
  loading: boolean
  palette: CrossChatConversationPalette
  fontScale: number
  onRequestFull: () => void
}) {
  const identity = `${leg.exchange_id}:${leg.id}:${leg.body_sha256}`
  const [expanded, setExpanded] = useRecyclingState(false, [leg.exchange_id, leg.id, conversationExpanded])
  const [limit, setLimit] = useRecyclingState(CROSS_CHAT_BODY_CHUNK, [identity])
  const fromThisChat = leg.source_session_id === sessionId
  const requesterSide = leg.source_session_id === requesterId || (!requesterId && fromThisChat)
  const messageNumber = leg.ordinal > 0 ? leg.ordinal : index + 1
  const mayHaveMoreBody = crossChatLegMayHaveMoreBody(leg, bodyComplete)
  const longBody = crossChatLegBodyIsLong(leg)
  const bodyExpanded = conversationExpanded || expanded || !longBody
  const completeVisibleBody = bodyExpanded ? leg.body : crossChatCollapsedText(leg.body)
  const visibleBody = conversationExpanded ? completeVisibleBody : completeVisibleBody.slice(0, limit)
  const locallyHidden = Math.max(0, completeVisibleBody.length - visibleBody.length)
  const showBodyToggle = !conversationExpanded && (mayHaveMoreBody || longBody || locallyHidden > 0)
  const toggleLabel = mayHaveMoreBody && loading
    ? 'Loading…'
    : mayHaveMoreBody || !bodyExpanded || locallyHidden > 0
      ? 'Show more'
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
  const failed = leg.status === 'failed'
  const speakerColor = failed ? palette.stateFailed : palette.speaker
  const accessibilityLabel = [
    `Message ${messageNumber} from ${sourceTitle} to ${targetTitle}.`,
    `${statusLabel(leg.status)}.`,
    fromThisChat ? 'From this chat.' : '',
    current ? 'Current conversation step.' : '',
  ].filter(Boolean).join(' ')

  return <View style={[
      styles.conversationLeg,
      requesterSide ? styles.conversationLegRequester : styles.conversationLegResponder,
    ]}>
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: current }}
      style={styles.conversationLegHeader}
    >
      <View style={styles.conversationSpeakerRow}>
        <Text style={[styles.conversationSpeaker, { color: speakerColor }]} numberOfLines={1}>{sourceTitle}</Text>
        {current ? <View accessibilityElementsHidden style={[styles.conversationCurrentDot, { backgroundColor: palette.currentDot }]} /> : null}
      </View>
      <Text style={[styles.conversationLegTime, { color: palette.participants }]}>{formatCrossChatTime(leg.updated_at || leg.created_at)}</Text>
    </View>
    {leg.body ? conversationExpanded || expanded
      ? <MarkdownContent value={`${visibleBody}${locallyHidden ? '…' : ''}`} compact color={palette.body} fontScale={fontScale} />
      : <Text selectable style={[styles.conversationBody, { color: palette.body }]}>{visibleBody}{locallyHidden ? '…' : ''}</Text>
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
  </View>
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

function ConversationFold({
  testID,
  label,
  expanded,
  palette,
  onPress,
}: {
  testID: string
  label: string
  expanded: boolean
  palette: CrossChatConversationPalette
  onPress: () => void
}) {
  return <View style={styles.conversationFold}>
    <ConversationControl testID={testID} label={label} expanded={expanded} palette={palette} onPress={onPress} />
  </View>
}

function ConversationInlineStatus({ label, palette }: { label: string; palette: CrossChatConversationPalette }) {
  return <View accessibilityRole="progressbar" style={styles.conversationInlineStatus}>
    <ActivityIndicator size="small" color={palette.toggle} />
    <Text style={[styles.conversationStatusNote, { color: palette.placeholder }]}>{label}</Text>
  </View>
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

function BoundedBody({ identity, text }: { identity: string; text: string }) {
  const colors = usePalette()
  const [limit, setLimit] = useRecyclingState(CROSS_CHAT_BODY_CHUNK, [identity])
  const visible = text.slice(0, limit)
  const hidden = Math.max(0, text.length - visible.length)
  return <View style={[styles.body, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Text selectable style={[styles.bodyText, { color: colors.text }]}>{visible}{hidden ? '\n…' : ''}</Text>
    {hidden ? <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${Math.min(CROSS_CHAT_BODY_CHUNK, hidden)} more characters`}
      onPress={() => setLimit(current => Math.min(text.length, current + CROSS_CHAT_BODY_CHUNK))}
      style={styles.showMore}
    ><Text style={[styles.showMoreText, { color: colors.blue }]}>{hidden.toLocaleString()} characters hidden · Show more</Text></Pressable> : null}
  </View>
}

function InlineStatus({ label }: { label: string }) {
  const colors = usePalette()
  return <View accessibilityRole="progressbar" style={styles.inlineStatus}><ActivityIndicator size="small" color={colors.blue} /><Text style={[styles.note, { color: colors.muted }]}>{label}</Text></View>
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
  referenceList: { gap: 6, marginTop: 8 },
  referenceChip: { minHeight: 44, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  referenceText: { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 16 },
  referenceStrong: { fontWeight: '800' },
  card: { marginHorizontal: 14, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  cardHeader: { minHeight: 54, paddingHorizontal: 11, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontSize: 12, lineHeight: 16, fontWeight: '800' },
  meta: { fontSize: 10, lineHeight: 14 },
  detail: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, paddingVertical: 10, gap: 8 },
  detailText: { fontSize: 12, lineHeight: 17 },
  body: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  bodyText: { paddingHorizontal: 10, paddingTop: 9, paddingBottom: 8, fontSize: 11.5, lineHeight: 17, fontFamily: 'Menlo' },
  showMore: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  showMoreText: { fontSize: 11, fontWeight: '800' },
  note: { flex: 1, fontSize: 10.5, lineHeight: 15 },
  inlineStatus: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  inlineError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorText: { flex: 1, fontSize: 10.5, lineHeight: 15 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  action: { minHeight: 44, maxWidth: '100%', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: 11, fontWeight: '800' },
  conversationShadow: {
    marginHorizontal: 14,
    marginVertical: 8,
    borderRadius: 7,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 12,
    elevation: 5,
  },
  conversationCard: { position: 'relative', overflow: 'hidden', borderRadius: 7, borderWidth: 1 },
  conversationAccent: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 3 },
  conversationLayout: { minWidth: 0, flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  conversationIcon: { width: 18, flexShrink: 0, alignItems: 'center', paddingTop: 1 },
  conversationContent: { minWidth: 0, flex: 1 },
  conversationHeader: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  conversationEyebrow: { flex: 1, minWidth: 0, fontSize: 9, lineHeight: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  conversationTime: { flexShrink: 0, fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  conversationHeading: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 },
  conversationTitle: { minWidth: 0, flex: 1, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  conversationState: { maxWidth: '54%', flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  conversationStateText: { flexShrink: 1, fontSize: 9, lineHeight: 13, fontWeight: '700' },
  conversationParticipants: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1, marginBottom: 8 },
  conversationParticipant: { minWidth: 0, flexShrink: 1, fontSize: 9, lineHeight: 13 },
  conversationBridge: { flexShrink: 0, fontSize: 11, lineHeight: 14 },
  conversationControls: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', columnGap: 8 },
  conversationControl: { minWidth: 44, minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 2 },
  conversationControlText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationTranscript: { minWidth: 0, gap: 12, marginTop: 3, marginBottom: 5, paddingVertical: 4 },
  conversationLeg: { width: '80%', minWidth: 0, paddingHorizontal: 2, paddingVertical: 3 },
  conversationLegRequester: { alignSelf: 'flex-start' },
  conversationLegResponder: { alignSelf: 'flex-end' },
  conversationLegHeader: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  conversationSpeakerRow: { minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  conversationSpeaker: { minWidth: 0, flexShrink: 1, fontSize: 9.5, lineHeight: 14, fontWeight: '800' },
  conversationCurrentDot: { width: 5, height: 5, flexShrink: 0, borderRadius: 999 },
  conversationLegTime: { flexShrink: 0, fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  conversationBody: { minWidth: 0, fontSize: 12, lineHeight: 19 },
  conversationPlaceholder: { marginTop: 6, fontSize: 9, lineHeight: 13 },
  conversationBodyToggle: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  conversationBodyToggleText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationFold: { width: '100%', minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  conversationPreview: { width: '80%', alignSelf: 'flex-start', paddingHorizontal: 2, paddingVertical: 3, fontSize: 12, lineHeight: 19 },
  conversationEmpty: { alignSelf: 'center', paddingVertical: 5, fontSize: 10, lineHeight: 15 },
  conversationFailure: { marginTop: 6, marginBottom: 2, fontSize: 10, lineHeight: 15 },
  conversationInlineStatus: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  conversationStatusNote: { fontSize: 9, lineHeight: 13 },
  conversationInlineError: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6 },
  conversationInlineErrorText: { minWidth: 0, flex: 1, fontSize: 9.5, lineHeight: 14 },
  conversationDetails: { marginTop: 3 },
  conversationDetailsToggle: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  conversationDetailsToggleText: { fontSize: 9.5, lineHeight: 14, fontWeight: '700' },
  conversationDetailLines: { marginTop: -4, paddingBottom: 3 },
  conversationDetailLine: { marginVertical: 2, fontSize: 9, lineHeight: 14 },
  conversationNotice: { fontSize: 9.5, lineHeight: 14 },
  conversationActions: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, marginTop: 3 },
  conversationAction: { minWidth: 44, minHeight: 44, maxWidth: '100%', justifyContent: 'center' },
  conversationActionText: { fontSize: 10, lineHeight: 15, fontWeight: '700' },
})
