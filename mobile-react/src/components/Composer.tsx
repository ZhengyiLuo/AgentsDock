import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as Clipboard from 'expo-clipboard'
import { useShallow } from 'zustand/react/shallow'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { AlertCircle, ArrowDown, ArrowUp, Check, ChevronDown, CornerDownRight, File as FileIcon, Mail, MessageCircleMore, MessageSquareShare, Paperclip, Search, Send, Square, Trash2, X } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import {
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_MIN_HEIGHT,
  composerInputHeight,
  composerKeyboardToolsCollapsed,
  composerViewportLimits,
  measuredComposerInputHeight,
} from '../lib/composer-input-size'
import { trackEvent } from '../lib/analytics'
import { backendLabel, formatBytes, isImage } from '../lib/format'
import { FULLSCREEN_HEADER_GUTTER, FULLSCREEN_HEADER_MIN_HEIGHT, fullscreenModalPadding } from '../lib/fullscreen-modal-layout'
import { asyncQueuedMessageControlsAvailable, isAsyncQueuedChatMessage, isCrossChatDeliveryQueuedTurn, isUserQueuedTurn, isVisibleQueuedTurn, queuedDeliverySkipIdentity, queuedMoveCrossesDeliveryBarrier, queuedTurnHasEarlierDeliveryBarrier } from '../lib/queue'
import { isImageUpload, photoAssetsToUploads } from '../lib/uploads'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { awaitCodexPermissionUpdates } from '../lib/codex-permission-updates'
import { awaitClaudePermissionUpdates } from '../lib/claude-permission-updates'
import { awaitCursorPermissionUpdates } from '../lib/cursor-permission-updates'
import { isClaudeMcpCommand } from '../lib/claude-mcp'
import { isTeamMailCommandCandidate, TEAM_MAIL_COMMAND_SYNTAX, TEAM_MAIL_COMMAND_TEMPLATE, teamMailCapabilityError, teamMailCommandError } from '../lib/team-mail-command'
import { insertTeamReference, MAX_TEAM_REFERENCES, reconcileTeamReferences, teamMentionTrigger, teamMessagesAvailable, teamReferenceContractSupported, validTeamReferences, type TeamMentionCandidate, type TeamMentionTrigger } from '../lib/team-references'
import {
  caretAfterTextChange,
  chatMentionAction,
  chatMentionTrigger,
  chatReferenceLabel,
  chatReferenceWithAction,
  insertChatReference,
  localChatReferenceContractSupported,
  MAX_CHAT_REFERENCES,
  parseStoredChatReferences,
  reconcileChatReferences,
  routeHintMentionsAvailable,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences,
  type ChatMentionTrigger,
} from '../lib/chat-references'
import { authenticatedChatMessageBody } from '../lib/chat-message-body'
import {
  COMPOSER_CARD_MAX_HEIGHT,
  COMPOSER_COMPACT_BACKEND_SLOT_WIDTH,
  COMPOSER_COMPACT_TOOLBAR_GAP,
  COMPOSER_COMPACT_TOOLBAR_HEIGHT,
  COMPOSER_COMPACT_TOOLBAR_PADDING,
  COMPOSER_DENSE_BACKEND_SLOT_WIDTH,
  COMPOSER_DENSE_TOOLBAR_GAP,
  COMPOSER_DENSE_TOOLBAR_PADDING,
  COMPOSER_EMPTY_CARD_MIN_HEIGHT,
  COMPOSER_SHELL_PADDING,
  COMPOSER_TOOLBAR_TOUCH_SIZE,
  isCompactComposerToolbar,
  isDenseComposerToolbar,
} from '../lib/composer-toolbar-layout'
import { cursorBackendUnavailableReason, isBackendLocked, selectableChatBackends } from '../lib/runtime-catalog'
import { usePalette } from '../theme'
import type { AgentCrossChatRoute, AgentFile, Backend, ChatReference, ChatReferenceAction, FailedUpload, Health, QueuedTurn, Session, TeamReference, UploadRef } from '../types'
import { appendWelcomeExchange, isWelcomeSession } from '../lib/welcome-session'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { CodexPermissionMenu } from './CodexPermissionMenu'
import { useCodexRuntime } from './CodexRuntimeContext'
import { CodexGoalBar } from './CodexGoalBar'
import { ClaudePermissionMenu } from './ClaudePermissionMenu'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { CursorPermissionMenu } from './CursorPermissionMenu'
import { IconButton, Pill, SheetCloseButton } from './ui'
import { FullscreenViewerCloseButton, SwipeDismissImage } from './FullscreenImageViewer'
import { TeamTargetPicker } from './TeamTargetPicker'

const EMPTY_FILES: AgentFile[] = []
const EMPTY_PENDING: UploadRef[] = []
const EMPTY_FAILED: FailedUpload[] = []
const EMPTY_QUEUE: QueuedTurn[] = []
const EMPTY_CHAT_REFERENCES: ChatReference[] = []
const EMPTY_TEAM_REFERENCES: TeamReference[] = []
const EMPTY_SESSIONS: Session[] = []
const EMPTY_ROUTES: AgentCrossChatRoute[] = []
const EMPTY_ROUTE_IDS: ReadonlySet<string> = new Set()
const ATTACHMENT_PICKER_SEND_GUARD_MS = 600
const QUICK_MESSAGES = ['Status report', 'Keep going.', 'Verify the result carefully.'] as const
const QUICK_MESSAGE_ACTIONS: MenuAction[] = QUICK_MESSAGES.map((title, index) => ({
  id: `quick-message:${index}`,
  title,
}))
type AttachmentImageSource = { uri: string; headers?: Record<string, string> }
type ComposerSelection = { start: number; end: number }
type ComposerMentionTrigger = ChatMentionTrigger | TeamMentionTrigger

export function Composer({ sessionId, keyboardVisible, onSent, onOpenMcp }: { sessionId: string; keyboardVisible: boolean; onSent: () => void; onOpenMcp: () => void }) {
  const welcome = isWelcomeSession(sessionId)
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const draft = useAppStore(state => state.drafts[sessionId] ?? '')
  const uploads = useAppStore(state => state.uploads[sessionId]) ?? EMPTY_FILES
  const pending = useAppStore(state => state.uploadPending[sessionId]) ?? EMPTY_PENDING
  const failed = useAppStore(state => state.uploadFailed[sessionId]) ?? EMPTY_FAILED
  const queuedTurns = useAppStore(state => state.snapshots[sessionId]?.queuedTurns) ?? EMPTY_QUEUE
  const queuedRunStatus = useAppStore(state => state.queuedRunStatus[sessionId])
  const health = useAppStore(state => state.health)
  const references = useAppStore(state => state.chatReferencesBySession[sessionId]) ?? EMPTY_CHAT_REFERENCES
  const teamReferences = useAppStore(state => state.teamReferencesBySession[sessionId]) ?? EMPTY_TEAM_REFERENCES
  const sourceSession = useAppStore(useShallow(state => {
    const session = state.sessions.find(value => value.id === sessionId)
    return session ? {
      backend: session.backend,
      model: session.model,
      effort: session.effort,
      backend_locked: session.backend_locked,
      session_id: session.session_id,
      claude_session_id: session.claude_session_id,
      codex_thread_id: session.codex_thread_id,
      cursor_session_id: session.cursor_session_id,
    } : null
  }))
  const backend = sourceSession?.backend
  const model = sourceSession?.model
  const effort = sourceSession?.effort
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const setSessionDraft = useAppStore(state => state.setSessionDraft)
  const setChatReferencesForSession = useAppStore(state => state.setChatReferencesForSession)
  const setTeamReferencesForSession = useAppStore(state => state.setTeamReferencesForSession)
  const sendPrompt = useAppStore(state => state.sendPrompt)
  const stopTurn = useAppStore(state => state.stopTurn)
  const reloadProvider = useAppStore(state => state.reloadProvider)
  const updateSession = useAppStore(state => state.updateSession)
  const runtime = useAppStore(state => state.runtime)
  const { refresh: refreshCodexRuntime } = useCodexRuntime()
  const { refresh: refreshClaudeRuntime } = useClaudeRuntime()
  const attachFiles = useAppStore(state => state.attachFiles)
  const removeUpload = useAppStore(state => state.removeUpload)
  const removeFailedUpload = useAppStore(state => state.removeFailedUpload)
  const sending = useAppStore(state => state.sendingSessionIds.has(sessionId))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]))
  const admissionPreflight = admitting && !sending
  const stopping = useAppStore(state => state.stoppingSessionIds.has(sessionId))
  const [pickingAttachment, setPickingAttachment] = useState(false)
  const [providerReloading, setProviderReloading] = useState(false)
  const [attachmentSendGuarded, setAttachmentSendGuarded] = useState(false)
  const [preview, setPreview] = useState<{ name: string; source: AttachmentImageSource } | null>(null)
  const [pickerTrigger, setPickerTrigger] = useState<ComposerMentionTrigger | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  const [inputHeight, setInputHeight] = useState(COMPOSER_INPUT_MIN_HEIGHT)
  const [composerWidth, setComposerWidth] = useState(0)
  const [queueReviewRequest, setQueueReviewRequest] = useState(0)
  const [queueHasEdit, setQueueHasEdit] = useState(false)
  const [primaryActionsHeight, setPrimaryActionsHeight] = useState(48)
  const inputRef = useRef<TextInput>(null)
  const draftRef = useRef(draft)
  const referencesRef = useRef<ChatReference[]>(references)
  const teamReferencesRef = useRef<TeamReference[]>(teamReferences)
  const pickerTriggerRef = useRef<ComposerMentionTrigger | null>(pickerTrigger)
  const mentionOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTeamPicker = useRef<TeamMentionTrigger | null>(null)
  const selectionRef = useRef<ComposerSelection>({ start: draft.length, end: draft.length })
  const pendingCaretRef = useRef<number | null>(null)
  const restoreInputAfterPickerRef = useRef(false)
  const dismissedMentionStartRef = useRef<number | null>(null)
  const attachmentSendGuardedRef = useRef(false)
  const attachmentSendGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queued = useMemo(() => queuedTurns.filter(isVisibleQueuedTurn), [queuedTurns])
  const routeRevoking = useAppStore(state => [...(state.revokingAgentRouteIds ?? EMPTY_ROUTE_IDS)].some(key => key.startsWith(`${sessionId}:`)))
  const referencedTargetIds = useMemo(() => new Set(references.map(reference => reference.session_id)), [references])
  // Live events replace the sessions array and the active session object. Keep
  // typing isolated from that high-frequency stream: referenced target objects
  // stay referentially stable unless their own eligibility actually changes.
  useAppStore(state => referencedTargetIds.size ? [...referencedTargetIds].map(targetId => {
    const target = state.sessions.find(candidate => candidate.id === targetId)
    return target ? `${target.id}:${target.backend}:${target.archived ? 1 : 0}` : `${targetId}:missing`
  }).join('|') : '')
  const supportedChatActions = useMemo(() => supportedCrossChatActions(health), [health])
  const supportedTargetBackends = useMemo(() => supportedCrossChatTargetBackends(health), [health])
  const routeHintsSupported = routeHintMentionsAvailable(health)
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && Boolean(backend && supportedTargetBackends.includes(backend))
  const crossChatSupported = routeHintsSupported
    && supportedChatActions.includes('route')
    && supportedTargetBackends.length > 0
  const referenceSupported = useCallback((reference: ChatReference): boolean => {
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      crossChatSupported
      && localChatReferenceContractSupported(health, reference)
      && (reference.action !== 'request_reply' || requestReplySupportedForSource)
      && target
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  }, [crossChatSupported, health, requestReplySupportedForSource, supportedTargetBackends])
  const referencesSupported = references.length === 0 || references.every(referenceSupported)
  const teamMentionsSupported = teamMessagesAvailable(health)
  const teamReferencesSupported = teamReferences.every(reference => teamReferenceContractSupported(health, reference))
  const switching = Boolean(switchingProfileId) || workspaceAdopting
  const networkDisabled = !connected || connecting || switching || !client.isValidated
  const hasReadyContent = Boolean(draft.trim()) || (!welcome && uploads.length > 0)
  const steerReviewsQueue = !hasReadyContent && (queued.length > 0 || Boolean(queuedRunStatus) || queueHasEdit)
  const mcpCommand = !welcome && isClaudeMcpCommand(draft)
  const mailCommandSuggested = !welcome && isTeamMailCommandCandidate(draft)
  const mcpCommandLabel = backend === 'claude' ? 'Open Claude MCP servers' : 'Run /mcp command'
  const sendDisabled = welcome ? false : (networkDisabled || pending.length > 0 || failed.length > 0 || sending || admitting || routeRevoking || attachmentSendGuarded || !referencesSupported || !teamReferencesSupported)
  const effectiveSendDisabled = mcpCommand ? switching || admitting : sendDisabled
  const effectiveSendBusy = !mcpCommand && (sending || admitting)
  const attachmentDisabled = networkDisabled || pickingAttachment || admissionPreflight
  const quickMessageDisabled = networkDisabled || sending || admitting
  const providerReloadDisabled = networkDisabled || active || sending || admitting || stopping || providerReloading || !backend || backend === 'cursor'
  // A brand-new chat has no provider session yet, so its coding agent can still
  // change. Once the agent starts (backend_locked or a provider session id) or a
  // turn is in flight, the backend is fixed and only reload remains.
  const backendSwitchable = Boolean(backend) && !networkDisabled && !active && !admitting && !sending && !stopping && !providerReloading && !(sourceSession && isBackendLocked(sourceSession))
  // Provider tools stay compact; primary turn actions get their own labeled
  // row while active so Queue and Steer remain distinct on a narrow phone.
  // Window width is not the usable composer width when the sidebar or
  // inspector is beside the chat. Measure the card itself before choosing
  // labeled controls; the first render stays compact to avoid a clipped flash.
  const compactToolbar = composerWidth === 0 || isCompactComposerToolbar(composerWidth)
  const denseToolbar = compactToolbar && (composerWidth === 0 ? width < 352 : isDenseComposerToolbar(composerWidth))
  const viewportLimits = composerViewportLimits(width, height, keyboardVisible)
  const constrainedKeyboard = composerKeyboardToolsCollapsed(width, height, keyboardVisible)
  const primaryInputBudget = active && !constrainedKeyboard ? Math.max(COMPOSER_INPUT_MIN_HEIGHT, COMPOSER_CARD_MAX_HEIGHT - primaryActionsHeight - 50) : COMPOSER_INPUT_MAX_HEIGHT
  const displayedInputHeight = Math.min(composerInputHeight(draft, inputHeight), viewportLimits.inputMaxHeight, primaryInputBudget)
  const hasGoalPanel = !welcome && backend === 'codex'
  const hasAuxiliaryContent = mailCommandSuggested || references.length > 0 || teamReferences.length > 0 || queued.length > 0 || Boolean(queuedRunStatus) || queueHasEdit || uploads.length > 0 || pending.length > 0 || failed.length > 0 || hasGoalPanel
  const validationRevision = client.validationRevision
  useEffect(() => {
    if (welcome || networkDisabled || !routeHintsSupported) return
    void useAppStore.getState().refreshAgentRoutes(sessionId, profileGeneration)
  }, [welcome, networkDisabled, routeHintsSupported, activeProfileId, profileGeneration, sessionId, validationRevision, health?.server_identity, health?.server_instance_id])
  const closePreview = useCallback(() => {
    setPreview(null)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openPreview = useCallback((name: string, source: AttachmentImageSource) => {
    setPreview({ name, source })
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  // Native TextInput can deliver multiple edits before React commits a render.
  // Keep authority-bearing spans synchronized with the latest native edit,
  // rather than with the render closure that happened to create the handler.
  draftRef.current = draft
  referencesRef.current = references
  teamReferencesRef.current = teamReferences
  pickerTriggerRef.current = pickerTrigger
  useEffect(() => {
    setPreview(null)
    setPickerTrigger(null)
    setPickerQuery('')
    selectionRef.current = { start: draft.length, end: draft.length }
    pendingCaretRef.current = null
    pendingTeamPicker.current = null
    restoreInputAfterPickerRef.current = false
    dismissedMentionStartRef.current = null
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    mentionOpenTimer.current = null
    return () => { if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current) }
  }, [activeProfileId, profileGeneration, sessionId])
  useEffect(() => setInputHeight(COMPOSER_INPUT_MIN_HEIGHT), [activeProfileId, profileGeneration, sessionId])
  useEffect(() => {
    if (!draft.length) setInputHeight(COMPOSER_INPUT_MIN_HEIGHT)
  }, [draft.length])
  useEffect(() => {
    attachmentSendGuardedRef.current = false
    setAttachmentSendGuarded(false)
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
    attachmentSendGuardTimer.current = null
  }, [activeProfileId, profileGeneration, sessionId])
  useEffect(() => () => {
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
  }, [])

  const guardSendAfterPicker = useCallback(() => {
    attachmentSendGuardedRef.current = true
    setAttachmentSendGuarded(true)
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
    attachmentSendGuardTimer.current = setTimeout(() => {
      attachmentSendGuardTimer.current = null
      attachmentSendGuardedRef.current = false
      setAttachmentSendGuarded(false)
    }, ATTACHMENT_PICKER_SEND_GUARD_MS)
  }, [])

  const storeReferences = useCallback((next: ChatReference[]) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    referencesRef.current = next
    setChatReferencesForSession(sessionId, next, profileGeneration)
  }, [activeProfileId, profileGeneration, sessionId, setChatReferencesForSession])

  const storeTeamReferences = useCallback((next: TeamReference[]) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    teamReferencesRef.current = next
    setTeamReferencesForSession(sessionId, next, profileGeneration)
  }, [activeProfileId, profileGeneration, sessionId, setTeamReferencesForSession])

  const discoverMention = useCallback((trigger: ComposerMentionTrigger | null) => {
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    mentionOpenTimer.current = null
    if (!trigger) { dismissedMentionStartRef.current = null; return }
    if (pickerTriggerRef.current || dismissedMentionStartRef.current === trigger.start) return
    if (trigger.kind !== '@@' && !crossChatSupported) return
    const show = () => {
      mentionOpenTimer.current = null
      if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId) || pickerTriggerRef.current) return
      setPickerQuery(trigger.query)
      pickerTriggerRef.current = trigger
      setPickerTrigger(trigger)
    }
    // Native @ opens a sheet; leave a brief window for the second @ first.
    if (trigger.kind === '@') mentionOpenTimer.current = setTimeout(show, 250)
    else show()
  }, [activeProfileId, profileGeneration, sessionId, crossChatSupported])

  const updateComposerDraft = useCallback((text: string) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const previousDraft = draftRef.current
    const nextReferences = reconcileChatReferences(previousDraft, text, referencesRef.current)
    const nextTeamReferences = reconcileTeamReferences(previousDraft, text, teamReferencesRef.current)
    const previousSelection = selectionRef.current
    const caret = caretAfterTextChange(previousDraft, text, previousSelection)
    draftRef.current = text
    referencesRef.current = nextReferences
    teamReferencesRef.current = nextTeamReferences
    selectionRef.current = { start: caret, end: caret }
    if (!text.length) setInputHeight(COMPOSER_INPUT_MIN_HEIGHT)
    setSessionDraft(sessionId, text, profileGeneration)
    setChatReferencesForSession(sessionId, nextReferences, profileGeneration)
    setTeamReferencesForSession(sessionId, nextTeamReferences, profileGeneration)
    const trigger = teamMentionTrigger(text, caret, nextReferences, nextTeamReferences) ?? chatMentionTrigger(text, caret, nextReferences)
    discoverMention(trigger)
  }, [activeProfileId, discoverMention, profileGeneration, sessionId, setChatReferencesForSession, setTeamReferencesForSession, setSessionDraft])

  const finishTargetPickerDismissal = useCallback(() => {
    if (!restoreInputAfterPickerRef.current) return
    restoreInputAfterPickerRef.current = false
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
      pendingCaretRef.current = null
      pendingTeamPicker.current = null
      return
    }
    const teamTrigger = pendingTeamPicker.current
    if (teamTrigger) {
      pendingTeamPicker.current = null
      dismissedMentionStartRef.current = null
      pickerTriggerRef.current = teamTrigger
      setPickerTrigger(teamTrigger)
      setPickerQuery(teamTrigger.query)
      return
    }
    const pendingCaret = pendingCaretRef.current
    pendingCaretRef.current = null
    const selection = pendingCaret == null
      ? selectionRef.current
      : { start: pendingCaret, end: pendingCaret }
    requestAnimationFrame(() => {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      inputRef.current?.focus()
      inputRef.current?.setNativeProps({ selection })
      selectionRef.current = selection
    })
  }, [activeProfileId, profileGeneration, sessionId])

  const closeTargetPicker = useCallback(() => {
    const currentTrigger = pickerTriggerRef.current
    if (!currentTrigger) return
    dismissedMentionStartRef.current = currentTrigger.start
    restoreInputAfterPickerRef.current = true
    pickerTriggerRef.current = null
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
  }, [finishTargetPickerDismissal])

  const openTeamFromChatPicker = useCallback((query = '') => {
    const trigger = pickerTriggerRef.current
    if (!trigger || trigger.kind === '@@') return
    pendingTeamPicker.current = { ...trigger, kind: '@@', query }
    closeTargetPicker()
  }, [closeTargetPicker])

  const openTargetPicker = useCallback((trigger?: ComposerMentionTrigger) => {
    if (trigger?.kind !== '@@' && !crossChatSupported) {
      Alert.alert('Chat handoffs unavailable', 'Update the active AgentsServer to use agent-to-agent chat handoffs.')
      return
    }
    const selection = selectionRef.current
    const nextTrigger = trigger ?? {
      kind: '@' as const,
      start: Math.min(selection.start, selection.end),
      end: Math.max(selection.start, selection.end),
      query: '',
    }
    dismissedMentionStartRef.current = null
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    setPickerQuery(nextTrigger.query)
    pickerTriggerRef.current = nextTrigger
    setPickerTrigger(nextTrigger)
  }, [crossChatSupported])

  const chooseTarget = useCallback((target: Session): boolean => {
    const currentTrigger = pickerTriggerRef.current
    if (!currentTrigger || currentTrigger.kind === '@@' || !crossChatSupported || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return false
    if (referencesRef.current.length >= MAX_CHAT_REFERENCES) {
      Alert.alert('Chat reference limit reached', `A message can reference up to ${MAX_CHAT_REFERENCES} chats. Remove one before adding another.`)
      return false
    }
    const action = chatMentionAction(currentTrigger)
    if (!supportedChatActions.includes(action)) {
      Alert.alert('Chat handoffs unavailable', 'This server did not advertise a supported handoff action.')
      return false
    }
    const currentReferences = referencesRef.current
    const state = useAppStore.getState()
    const currentTarget = state.sessions.find(candidate => candidate.id === target.id)
    if (!currentTarget || currentTarget.archived || currentTarget.id === sessionId || !supportedCrossChatTargetBackends(state.health).includes(currentTarget.backend)) return false
    const routeSnapshot = state.agentRoutesBySession?.[sessionId]
    if (routeSnapshot && routeCapacityReached(routeSnapshot.routes, routeSnapshot.max_routes, currentReferences, target.id)) {
      Alert.alert('Route access limit reached', 'Revoke a granted route before adding another chat. Already granted chats remain available.')
      return false
    }
    if (currentReferences.some(reference => reference.session_id === target.id && reference.action === action)) {
      Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${target.title}.`)
      return false
    }
    const currentDraft = draftRef.current
    const inserted = insertChatReference(currentDraft, currentTrigger, target, action)
    const shifted = reconcileChatReferences(currentDraft, inserted.text, currentReferences)
    const nextReferences = [...shifted, inserted.reference]
      .sort((left, right) => left.source_text_start - right.source_text_start)
    pendingCaretRef.current = inserted.caret
    selectionRef.current = { start: inserted.caret, end: inserted.caret }
    draftRef.current = inserted.text
    restoreInputAfterPickerRef.current = true
    pickerTriggerRef.current = null
    setSessionDraft(sessionId, inserted.text, profileGeneration)
    storeReferences(nextReferences)
    storeTeamReferences(reconcileTeamReferences(currentDraft, inserted.text, teamReferencesRef.current))
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
    return true
  }, [activeProfileId, backend, crossChatSupported, finishTargetPickerDismissal, health, profileGeneration, sessionId, setSessionDraft, storeReferences, storeTeamReferences])

  const chooseTeamTarget = useCallback((candidate: TeamMentionCandidate) => {
    const trigger = pickerTriggerRef.current
    if (!trigger || trigger.kind !== '@@' || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId) || !teamMessagesAvailable(useAppStore.getState().health)) return false
    if (teamReferencesRef.current.length >= MAX_TEAM_REFERENCES) return false
    if (teamReferencesRef.current.some(reference => reference.team_id === candidate.target.team_id && reference.target_id === candidate.target.target_id)) {
      Alert.alert('Already selected', `${candidate.label} is already selected for this message.`)
      return false
    }
    const previousText = draftRef.current
    const inserted = insertTeamReference(previousText, trigger, candidate.target)
    if (!teamReferenceContractSupported(useAppStore.getState().health, inserted.reference)) return false
    const nextTeamReferences = [...reconcileTeamReferences(previousText, inserted.text, teamReferencesRef.current), inserted.reference]
    pickerTriggerRef.current = null
    pendingCaretRef.current = inserted.caret
    selectionRef.current = { start: inserted.caret, end: inserted.caret }
    draftRef.current = inserted.text
    restoreInputAfterPickerRef.current = true
    setSessionDraft(sessionId, inserted.text, profileGeneration)
    storeReferences(reconcileChatReferences(previousText, inserted.text, referencesRef.current))
    storeTeamReferences(nextTeamReferences)
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
    return true
  }, [activeProfileId, profileGeneration, sessionId, finishTargetPickerDismissal, setSessionDraft, storeReferences, storeTeamReferences])

  const changeReferenceAction = useCallback((reference: ChatReference) => {
    showReferenceActionPicker({
      width,
      reference,
      actions: availableChatReferenceActions(supportedChatActions, requestReplySupportedForSource),
      onSelect: action => {
        const currentReferences = referencesRef.current
        const selected = currentReferences.find(candidate => sameChatReference(candidate, reference))
        if (!selected) return
        if (currentReferences.some(candidate => !sameChatReference(candidate, selected) && candidate.session_id === selected.session_id && candidate.action === action)) {
          Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${reference.display_title_snapshot}.`)
          return
        }
        storeReferences(currentReferences.map(candidate => sameChatReference(candidate, selected) ? chatReferenceWithAction(candidate, action) : candidate))
      },
    })
  }, [requestReplySupportedForSource, storeReferences, supportedChatActions, width])

  const revokeReference = useCallback((reference: ChatReference) => {
    storeReferences(referencesRef.current.filter(candidate => !sameChatReference(candidate, reference)))
  }, [storeReferences])

  const handleSelectionChange = useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const selection = event.nativeEvent.selection
    selectionRef.current = selection
    if (selection.start !== selection.end) { discoverMention(null); return }
    const trigger = teamMentionTrigger(draftRef.current, selection.start, referencesRef.current, teamReferencesRef.current) ?? chatMentionTrigger(draftRef.current, selection.start, referencesRef.current)
    discoverMention(trigger)
  }, [discoverMention])

  const send = async (steer = false, promptOverride?: string, consumeComposer = true) => {
    if (welcome) {
      if (!consumeComposer) return
      const text = (useAppStore.getState().drafts[sessionId] ?? draftRef.current).trim()
      if (!text) return
      const snapshot = useAppStore.getState().snapshots[sessionId]
      if (!snapshot || !isWelcomeSession(snapshot.session.id)) return
      const nextSnapshot = appendWelcomeExchange(snapshot, text)
      useAppStore.setState(prev => {
        const prevSnapshot = prev.snapshots[sessionId]
        if (prevSnapshot !== snapshot) return prev
        return {
          snapshots: { ...prev.snapshots, [sessionId]: nextSnapshot },
          sessions: prev.sessions.map(session => isWelcomeSession(session.id) ? nextSnapshot.session : session),
          drafts: { ...prev.drafts, [sessionId]: '' },
          chatReferencesBySession: { ...prev.chatReferencesBySession, [sessionId]: [] },
          teamReferencesBySession: { ...prev.teamReferencesBySession, [sessionId]: [] },
        }
      })
      inputRef.current?.clear()
      onSent()
      return
    }
    const currentState = useAppStore.getState()
    const currentDraft = consumeComposer ? currentState.drafts[sessionId] ?? draftRef.current : ''
    if (consumeComposer && isClaudeMcpCommand(currentDraft)) {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      const currentSession = currentState.sessions.find(candidate => candidate.id === sessionId)
      draftRef.current = ''
      setSessionDraft(sessionId, '', profileGeneration)
      inputRef.current?.clear()
      if (currentSession?.backend === 'claude') onOpenMcp()
      else Alert.alert('Claude MCP only', '/mcp is available in Claude chats only.')
      return
    }
    if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const currentUploads = consumeComposer ? currentState.uploads[sessionId] ?? uploads : EMPTY_FILES
    const currentReferences = consumeComposer ? currentState.chatReferencesBySession[sessionId] ?? referencesRef.current : EMPTY_CHAT_REFERENCES
    const currentTeamReferences = consumeComposer ? currentState.teamReferencesBySession[sessionId] ?? teamReferencesRef.current : EMPTY_TEAM_REFERENCES
    const currentHasReadyContent = Boolean(currentDraft.trim()) || currentUploads.length > 0
    const currentReferencesSupported = currentReferences.every(referenceSupported)
    const currentSendDisabled = networkDisabled
      || (currentState.uploadPending[sessionId]?.length ?? 0) > 0
      || (currentState.uploadFailed[sessionId]?.length ?? 0) > 0
      || currentState.sendingSessionIds.has(sessionId)
      || Boolean(currentState.turnAdmissionTokens[sessionId])
      || attachmentSendGuardedRef.current
      || !currentReferencesSupported
      || (currentTeamReferences.length > 0 && !teamMessagesAvailable(currentState.health))
    if (consumeComposer && (currentSendDisabled || !currentHasReadyContent)) return
    if (!consumeComposer && (networkDisabled || sending || admitting || !promptOverride?.trim())) return
    const mailError = consumeComposer ? teamMailCommandError(currentState.health, currentDraft) : null
    if (mailError) {
      Alert.alert('Team Network mail unavailable', mailError)
      return
    }
    const outgoingReferences = consumeComposer
      ? validChatReferences(currentDraft, currentReferences, sessionId)
      : EMPTY_CHAT_REFERENCES
    if (consumeComposer && outgoingReferences.length !== currentReferences.length) {
      Alert.alert('Chat reference changed', 'Remove the changed reference and select that chat again.')
      return
    }
    if (consumeComposer && !outgoingReferences.every(referenceSupported)) {
      Alert.alert('Chat handoff unavailable', 'This server cannot deliver one or more selected actions or target chats.')
      return
    }
    const outgoingTeamReferences = validTeamReferences(currentDraft, currentTeamReferences, outgoingReferences)
    if (outgoingTeamReferences.length !== currentTeamReferences.length) {
      Alert.alert('Team Network reference changed', 'Remove the changed reference and select that recipient again.')
      return
    }
    const admissionToken = useAppStore.getState().beginTurnAdmission(sessionId)
    if (!admissionToken) return
    const admittedDraft = consumeComposer ? currentDraft : undefined
    const admittedFiles = consumeComposer ? currentUploads : undefined
    try {
      if (backend === 'codex' && activeProfileId) {
        try {
          await awaitCodexPermissionUpdates({ profileId: activeProfileId, profileGeneration, sessionId })
        } catch (error) {
          if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
            useAppStore.setState({ error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      }
      if (backend === 'claude' && activeProfileId) {
        try {
          await awaitClaudePermissionUpdates({ profileId: activeProfileId, profileGeneration, sessionId })
        } catch (error) {
          if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
            useAppStore.setState({ error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      }
      if (backend === 'cursor' && activeProfileId) {
        try {
          await awaitCursorPermissionUpdates({ profileId: activeProfileId, profileGeneration, sessionId })
        } catch (error) {
          if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
            useAppStore.setState({ error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      }
      try {
        const request = sendPrompt(steer, profileGeneration, sessionId, {
          promptOverride,
          consumeComposer,
          admissionToken,
          admittedDraft,
          admittedFiles,
          chatReferences: outgoingReferences,
          teamReferences: outgoingTeamReferences,
        })
        // sendPrompt consumes an accepted composer draft synchronously, before
        // its first network await. Clear the focused native buffer in the same
        // turn so iOS cannot echo the submitted text back through onChangeText.
        if (
          consumeComposer
          && useAppStore.getState().sendingSessionIds.has(sessionId)
          && !(useAppStore.getState().drafts[sessionId] ?? '').length
        ) inputRef.current?.clear()
        const sent = await request
        if (sent) trackEvent('message_sent')
        if (sent && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) onSent()
      } catch {
        // The store surfaces request failures; keep the draft available to retry.
      }
    } finally {
      useAppStore.getState().endTurnAdmission(sessionId, admissionToken)
    }
  }
  const pickFiles = async () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setPickingAttachment(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      if (!result.canceled && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        guardSendAfterPicker()
        void attachFiles(result.assets.map(file => ({ uri: file.uri, name: file.name, type: file.mimeType ?? undefined, size: file.size })), profileGeneration, sessionId)
      }
    } catch (error) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Files unavailable', pickerError(error))
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setPickingAttachment(false)
    }
  }
  const pickPhotos = async () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setPickingAttachment(true)
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 20,
      })
      if (!result.canceled && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        const photos = photoAssetsToUploads(result.assets)
        if (photos.length) {
          guardSendAfterPicker()
          void attachFiles(photos, profileGeneration, sessionId)
        }
      }
    } catch (error) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Photos unavailable', pickerError(error))
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setPickingAttachment(false)
    }
  }
  const chooseAttachment = () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const choose = (index: number) => {
      if (index === 0) openTargetPicker()
      else if (index === 1) void pickPhotos()
      else if (index === 2) void pickFiles()
      else if (index === 3) openTargetPicker({ kind: '@@', start: Math.min(selectionRef.current.start, selectionRef.current.end), end: Math.max(selectionRef.current.start, selectionRef.current.end), query: '' })
    }
    if (Platform.OS === 'ios' && width < 720) {
      const options = ['Reference another chat', 'Photo Library', 'Files', 'Reference a server (@@)', 'Cancel']
      ActionSheetIOS.showActionSheetWithOptions({
        title: 'Add',
        options,
        cancelButtonIndex: options.length - 1,
      }, choose)
      return
    }
    Alert.alert('Add', undefined, [
      { text: 'Reference another chat', onPress: () => choose(0) },
      { text: 'Photo Library', onPress: () => choose(1) },
      { text: 'Files', onPress: () => choose(2) },
      { text: 'Reference a server (@@)', onPress: () => choose(3) },
      { text: 'Cancel', style: 'cancel' },
    ])
  }
  const quickMessageTrigger = <View
    testID="chat-quick-messages"
    accessible
    accessibilityRole="button"
    accessibilityLabel="Quick messages"
    accessibilityState={{ disabled: quickMessageDisabled }}
    style={[styles.quickMessages, { opacity: quickMessageDisabled ? 0.35 : 1 }]}
  >
    <MessageCircleMore size={19} color={colors.muted} strokeWidth={1.9} />
  </View>
  const quickMessageControl = quickMessageDisabled ? quickMessageTrigger : <MenuView
    title="Quick messages"
    actions={QUICK_MESSAGE_ACTIONS}
    onPressAction={event => {
      if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      const prefix = 'quick-message:'
      if (!event.nativeEvent.event.startsWith(prefix)) return
      const phrase = QUICK_MESSAGES[Number(event.nativeEvent.event.slice(prefix.length))]
      if (phrase) void send(false, phrase, false)
    }}
    style={styles.quickMessagesMenu}
  >
    {quickMessageTrigger}
  </MenuView>
  const chooseMailCommand = () => {
    if (networkDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const capabilityError = teamMailCapabilityError(health)
    if (capabilityError) {
      Alert.alert('Team Network mail unavailable', capabilityError)
      return
    }
    const caret = TEAM_MAIL_COMMAND_TEMPLATE.length
    updateComposerDraft(TEAM_MAIL_COMMAND_TEMPLATE)
    pendingCaretRef.current = caret
    selectionRef.current = { start: caret, end: caret }
    requestAnimationFrame(() => {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      inputRef.current?.focus()
      inputRef.current?.setNativeProps({ selection: { start: caret, end: caret } })
      pendingCaretRef.current = null
    })
  }
  const providerName = backend ? backendLabel(backend) : 'Claude'
  const reloadChatAgent = async () => {
    if (providerReloadDisabled || !backend || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setProviderReloading(true)
    try {
      const result = await reloadProvider(sessionId, profileGeneration)
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      if (!result) {
        Alert.alert(`Could not reload ${providerName}`, useAppStore.getState().error || 'The server did not reload this chat agent.')
        return
      }
      if (backend === 'codex') await refreshCodexRuntime()
      else await refreshClaudeRuntime()
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        Alert.alert(`${providerName} reloaded`, result.message?.trim() || 'This chat kept its transcript and now has a fresh agent process.')
      }
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setProviderReloading(false)
    }
  }
  const switchChatBackend = async (next: Backend) => {
    if (!backendSwitchable || next === backend || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    // Clear model and effort: they are catalogued per backend, so the new agent
    // falls back to its server default rather than inheriting an invalid pick.
    const changed = await updateSession(sessionId, { backend: next, model: null, effort: null }, profileGeneration)
    if (!changed && composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
      Alert.alert('Could not change chat agent', useAppStore.getState().error || 'The server did not change this chat agent.')
    }
  }
  const cursorUnavailableReason = cursorBackendUnavailableReason(health, runtime)
  const backendActions: MenuAction[] = backendSwitchable ? selectableChatBackends(health).map(value => ({
    id: `switch-backend:${value}`,
    title: backendLabel(value),
    state: value === backend ? 'on' : 'off',
    attributes: value === 'cursor' && Boolean(cursorUnavailableReason) ? { disabled: true } : undefined,
  })) : []
  const runtimeActions: MenuAction[] = []
  if (backendActions.length) runtimeActions.push({ id: 'switch-backend', title: 'Coding agent', displayInline: true, subactions: backendActions })
  if (!providerReloadDisabled) runtimeActions.push({ id: 'reload-provider', title: `Reload ${providerName}`, image: 'arrow.clockwise' })
  const runtimeInteractive = runtimeActions.length > 0
  const runtimeTrigger = welcome ? <View
    testID="chat-runtime-menu"
    accessible
    accessibilityRole="text"
    accessibilityLabel="AgentsDock"
    style={[styles.runtime, compactToolbar && styles.runtimeCompact, denseToolbar && styles.runtimeDense]}
  >
    <Image source={require('../../assets/icon.png')} contentFit="contain" style={{ width: 21, height: 21, borderRadius: 5 }} />
    {!compactToolbar ? <Text style={[styles.backend, { color: colors.text }]}>AgentsDock</Text> : null}
  </View> : backend ? <View
    testID="chat-runtime-menu"
    accessible
    accessibilityRole="button"
    accessibilityLabel={`Chat agent options for ${providerName}`}
    accessibilityState={{ disabled: !runtimeInteractive, busy: providerReloading }}
    style={[styles.runtime, compactToolbar && styles.runtimeCompact, denseToolbar && styles.runtimeDense, { opacity: runtimeInteractive ? 1 : 0.45 }]}
  >
    {providerReloading ? <ActivityIndicator size="small" color={colors.muted} /> : <BackendMark backend={backend} size={21} />}
    {!compactToolbar ? <><Text style={[styles.backend, { color: colors.text }]}>{providerName}</Text><Pill tone="neutral">{model || 'Server model'}{effort ? ` · ${effort}` : ''}</Pill></> : null}
  </View> : null
  const runtimeControl = welcome || !runtimeTrigger || !runtimeInteractive ? runtimeTrigger : <MenuView
    title={`${providerName} agent`}
    actions={runtimeActions}
    onPressAction={event => {
      const action = event.nativeEvent.event
      if (action === 'reload-provider') void reloadChatAgent()
      else if (action.startsWith('switch-backend:')) void switchChatBackend(action.slice('switch-backend:'.length) as Backend)
    }}
    style={[styles.runtimeMenu, compactToolbar && styles.runtimeMenuCompact, denseToolbar && styles.runtimeMenuDense]}
  >
    {runtimeTrigger}
  </MenuView>

  const sendControl = <Pressable
    accessibilityRole="button"
    accessibilityLabel={mcpCommand ? mcpCommandLabel : active ? 'Queue message' : 'Send message'}
    accessibilityHint={active ? 'Wait until the current turn finishes. To change the current turn, use Steer.' : undefined}
    accessibilityState={{ disabled: effectiveSendDisabled || !hasReadyContent, busy: effectiveSendBusy }}
    testID="chat-send"
    disabled={effectiveSendDisabled || !hasReadyContent}
    onPress={() => void send(false)}
    style={({ pressed }) => [styles.primaryButton, !active && !constrainedKeyboard && styles.idleSend, { backgroundColor: !effectiveSendDisabled && hasReadyContent ? colors.blue : colors.raised, opacity: effectiveSendDisabled || !hasReadyContent || pressed ? 0.6 : 1 }]}
  >
    {effectiveSendBusy ? <ActivityIndicator size="small" color={colors.text} /> : <Send size={16} color={!effectiveSendDisabled && hasReadyContent ? 'white' : colors.muted} />}
    <Text maxFontSizeMultiplier={constrainedKeyboard ? 1.3 : undefined} numberOfLines={constrainedKeyboard ? 1 : undefined} adjustsFontSizeToFit={constrainedKeyboard} minimumFontScale={0.8} style={[styles.primaryButtonText, { color: !effectiveSendDisabled && hasReadyContent ? 'white' : colors.muted }]}>{mcpCommand ? 'Open MCP' : active ? 'Queue' : 'Send'}</Text>
  </Pressable>

  return (
    <View testID="chat-composer" style={[styles.shell, constrainedKeyboard && styles.shellConstrained, { backgroundColor: colors.background }]}>
      {hasAuxiliaryContent ? <ScrollView
        testID="composer-auxiliary-scroll"
        style={[styles.auxiliaryScroll, { maxHeight: viewportLimits.auxiliaryMaxHeight }]}
        contentContainerStyle={styles.auxiliaryContent}
        keyboardShouldPersistTaps="always"
        accessibilityElementsHidden={viewportLimits.auxiliaryMaxHeight === 0}
        importantForAccessibility={viewportLimits.auxiliaryMaxHeight === 0 ? 'no-hide-descendants' : 'auto'}
        pointerEvents={viewportLimits.auxiliaryMaxHeight === 0 ? 'none' : 'auto'}
        nestedScrollEnabled
      >
        {hasGoalPanel ? <CodexGoalBar /> : null}
        {mailCommandSuggested ? <Pressable
          testID="chat-mail-command-suggestion"
          accessibilityRole="button"
          accessibilityLabel={`Send Team Network mail. Use ${TEAM_MAIL_COMMAND_SYNTAX}`}
          accessibilityState={{ disabled: networkDisabled }}
          disabled={networkDisabled}
          onPress={chooseMailCommand}
          style={({ pressed }) => [styles.commandSuggestion, { backgroundColor: colors.raised, borderColor: colors.border, opacity: networkDisabled ? 0.45 : pressed ? 0.68 : 1 }]}
        >
          <Mail size={17} color={colors.blue} />
          <View style={styles.commandSuggestionText}>
            <Text style={[styles.commandSuggestionTitle, { color: colors.text }]}>Send Team Network mail</Text>
            <Text style={[styles.commandSuggestionSyntax, { color: colors.muted }]}>{TEAM_MAIL_COMMAND_SYNTAX}</Text>
          </View>
        </Pressable> : null}
        {references.length ? <ChatReferenceShelf
          references={references}
          referenceSupported={referenceSupported}
          onChangeAction={changeReferenceAction}
          onRemove={revokeReference}
          warning={!referencesSupported ? 'This server cannot deliver one or more selected actions or target chats.' : null}
          testID="composer-chat-references"
        /> : null}
        {teamReferences.length ? <View testID="composer-team-references" accessibilityLabel="Team Network recipients" style={styles.referenceShelfWrap}>
          {teamReferences.map(reference => <View key={`${reference.team_id}:${reference.target_id}`} style={[styles.referenceShelf, { borderColor: colors.border }]}>
            <Mail size={16} color={colors.blue} /><Text style={{ flex: 1, color: colors.text }}>@@{reference.display_name_snapshot} · Server inbox</Text>
            <IconButton icon={X} size={16} touchSize={44} label={`Remove reference to ${reference.display_name_snapshot}`} onPress={() => storeTeamReferences(teamReferencesRef.current.filter(candidate => candidate.team_id !== reference.team_id || candidate.target_id !== reference.target_id))} />
          </View>)}
          {!teamReferencesSupported ? <Text accessibilityRole="alert" style={{ color: colors.red }}>Reconnect this server to Team Network or remove the recipient reference.</Text> : null}
        </View> : null}
        {queued.length || queuedRunStatus || queueHasEdit ? <QueueShelf key={`${activeProfileId}:${profileGeneration}:${sessionId}`} sessionId={sessionId} profileId={activeProfileId} profileGeneration={profileGeneration} networkDisabled={networkDisabled} auxiliaryHidden={viewportLimits.auxiliaryMaxHeight === 0} reviewRequest={queueReviewRequest} onEditingChange={setQueueHasEdit} onSent={onSent} /> : null}
        {(uploads.length || pending.length || failed.length) ? <AttachmentShelf
          sessionId={sessionId}
          uploads={uploads}
          pending={pending}
          failed={failed}
          connectionReady={!networkDisabled}
          disabled={switching || admissionPreflight}
          retryDisabled={networkDisabled || admissionPreflight}
          onPreview={openPreview}
          onRemove={fileId => { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) removeUpload(fileId, profileGeneration, sessionId) }}
          onRemoveFailed={fileUri => { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) removeFailedUpload(fileUri, profileGeneration, sessionId) }}
          onRetry={file => { if (remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) void attachFiles([file], profileGeneration, sessionId) }}
        /> : null}
      </ScrollView> : null}
      <View
        onLayout={event => {
          const nextWidth = Math.floor(event.nativeEvent.layout.width)
          setComposerWidth(current => current === nextWidth ? current : nextWidth)
        }}
        style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <TextInput
          ref={inputRef}
          testID="chat-composer-input"
          accessibilityLabel="Message"
          value={draft}
          onChangeText={updateComposerDraft}
          onSelectionChange={handleSelectionChange}
          onContentSizeChange={event => setInputHeight(measuredComposerInputHeight(event.nativeEvent.contentSize.height))}
          placeholder={welcome ? 'Ask about setup…' : workspaceAdopting ? 'Preparing this server workspace…' : networkDisabled ? 'Server offline — drafts stay on this device' : active ? 'Queue a follow-up…' : 'Message'}
          placeholderTextColor={colors.muted}
          multiline
          editable={!switching && !admissionPreflight}
          textAlignVertical="top"
          scrollEnabled
          autoCorrect
          style={[styles.input, constrainedKeyboard && styles.inputConstrained, { color: colors.text, height: displayedInputHeight, maxHeight: viewportLimits.inputMaxHeight }]}
        />
        {!constrainedKeyboard ? <View style={[styles.toolbar, compactToolbar && styles.toolbarCompact, denseToolbar && styles.toolbarDense]}>
          {!welcome ? <IconButton icon={Paperclip} disabled={attachmentDisabled} onPress={chooseAttachment} label="Add files, photos, or another chat" testID="chat-attach" /> : null}
          {runtimeControl}
          {!welcome ? quickMessageControl : null}
          {!welcome && backend === 'codex' ? <CodexPermissionMenu sessionId={sessionId} compact={compactToolbar} /> : null}
          {!welcome && backend === 'claude' ? <ClaudePermissionMenu sessionId={sessionId} compact={compactToolbar} /> : null}
          {!welcome && backend === 'cursor' ? <CursorPermissionMenu sessionId={sessionId} compact={compactToolbar} /> : null}
          <View style={styles.toolbarSpacer} />
          {active && keyboardVisible ? <Pressable testID="chat-hide-keyboard" accessibilityRole="button" accessibilityLabel="Hide keyboard to review goal and queue" onPress={dismissAppKeyboard} style={styles.keyboardDismiss}><ChevronDown size={20} color={colors.muted} /></Pressable> : null}
          {!active ? sendControl : null}
        </View> : null}
        {active || constrainedKeyboard ? <View testID="chat-primary-actions" onLayout={event => { const measured = Math.ceil(event.nativeEvent.layout.height); if (Number.isFinite(measured) && measured >= 44) setPrimaryActionsHeight(measured) }} style={[styles.primaryActions, constrainedKeyboard && styles.primaryActionsConstrained]}>
          {active ? <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopping ? 'Stopping agent' : 'Stop agent'}
            accessibilityState={{ disabled: networkDisabled || stopping, busy: stopping }}
            testID="chat-stop"
            disabled={networkDisabled || stopping}
            onPress={() => { if (remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) void stopTurn(profileGeneration, sessionId) }}
            style={({ pressed }) => [styles.primaryButton, { backgroundColor: `${colors.red}18`, opacity: networkDisabled || stopping || pressed ? 0.45 : 1 }]}
          >{stopping ? <ActivityIndicator size="small" color={colors.red} /> : <Square size={14} color={colors.red} fill={colors.red} />}<Text maxFontSizeMultiplier={constrainedKeyboard ? 1.3 : undefined} numberOfLines={constrainedKeyboard ? 1 : undefined} adjustsFontSizeToFit={constrainedKeyboard} minimumFontScale={0.8} style={[styles.primaryButtonText, { color: colors.red }]}>{stopping ? 'Stopping' : 'Stop'}</Text></Pressable> : null}
          {active && !mcpCommand ? <Pressable
            accessibilityRole="button"
            accessibilityLabel={steerReviewsQueue ? 'Review queued messages to steer' : 'Steer current turn'}
            accessibilityHint={steerReviewsQueue ? 'Open the existing queued message and full error. Nothing is sent until you explicitly choose Steer in Review.' : hasReadyContent ? 'Send this draft into the current turn instead of waiting in the queue.' : 'Write a draft to steer the current turn.'}
            accessibilityState={{ disabled: !steerReviewsQueue && (sendDisabled || !hasReadyContent), busy: !steerReviewsQueue && (sending || admitting) }}
            testID="chat-send-now"
            disabled={!steerReviewsQueue && (sendDisabled || !hasReadyContent)}
            onPress={() => { if (steerReviewsQueue) { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setQueueReviewRequest(value => value + 1) } else void send(true) }}
            style={({ pressed }) => [styles.primaryButton, { backgroundColor: `${colors.blue}14`, opacity: !steerReviewsQueue && (sendDisabled || !hasReadyContent) || pressed ? 0.45 : 1 }]}
          >{sending || admitting ? <ActivityIndicator size="small" color={colors.blue} /> : <CornerDownRight size={16} color={colors.blue} />}<Text maxFontSizeMultiplier={constrainedKeyboard ? 1.3 : undefined} numberOfLines={constrainedKeyboard ? 1 : undefined} adjustsFontSizeToFit={constrainedKeyboard} minimumFontScale={0.8} style={[styles.primaryButtonText, { color: colors.blue }]}>Steer</Text></Pressable> : null}
          {sendControl}
          {constrainedKeyboard && (queued.length > 0 || queuedRunStatus || queueHasEdit) ? <Pressable testID="chat-review-queue" accessibilityRole="button" accessibilityLabel="Review queued messages and full error" onPress={() => { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setQueueReviewRequest(value => value + 1) }} style={styles.queueReviewButton}><Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.primaryButtonText, { color: colors.blue }]}>Review</Text></Pressable> : null}
          {constrainedKeyboard ? <Pressable testID="chat-hide-keyboard" accessibilityRole="button" accessibilityLabel="Hide keyboard to show chat tools and panels" onPress={dismissAppKeyboard} style={styles.keyboardDismiss}><ChevronDown size={20} color={colors.muted} /></Pressable> : null}
        </View> : null}
      </View>
      <Modal visible={preview != null} animationType="fade" presentationStyle="fullScreen" onRequestClose={closePreview}>
        {preview ? <View onAccessibilityEscape={closePreview} style={[styles.previewModal, { backgroundColor: colors.background }, fullscreenModalPadding(insets, Platform.OS)]}>
          <View style={[styles.previewHeader, { borderColor: colors.border }]}><FullscreenViewerCloseButton onPress={closePreview} label="Close image preview" testID="attachment-preview-close" /><Text style={[styles.previewTitle, { color: colors.text }]} numberOfLines={1}>{preview.name}</Text></View>
          <SwipeDismissImage onDismiss={closePreview} resetKey={preview.source.uri} testID="attachment-image-dismiss-surface" gestureTestID="attachment-image-dismiss-gesture" style={styles.previewImage}>
            <Image source={preview.source} contentFit="contain" style={StyleSheet.absoluteFill} transition={120} />
          </SwipeDismissImage>
        </View> : null}
      </Modal>
      <ChatTargetPicker
        visible={!welcome && pickerTrigger != null && pickerTrigger.kind !== '@@'}
        width={width}
        query={pickerQuery}
        sourceSessionId={sessionId}
        supportedTargetBackends={supportedTargetBackends}
        references={references}
        requestReplySupported={requestReplySupportedForSource}
        referenceLimitReached={references.length >= MAX_CHAT_REFERENCES}
        onQueryChange={query => { if (query.startsWith('@')) openTeamFromChatPicker(query.replace(/^@+/u, '')); else setPickerQuery(query) }}
        onTeamNetwork={() => openTeamFromChatPicker()}
        onSelect={chooseTarget}
        onClose={closeTargetPicker}
        onDidDismiss={finishTargetPickerDismissal}
      />
      <TeamTargetPicker
        visible={!welcome && pickerTrigger?.kind === '@@'}
        width={width}
        query={pickerQuery}
        sourceSessionId={sessionId}
        referenceLimitReached={teamReferences.length >= MAX_TEAM_REFERENCES}
        onQueryChange={setPickerQuery}
        onSelect={chooseTeamTarget}
        onClose={closeTargetPicker}
        onDidDismiss={finishTargetPickerDismissal}
      />
    </View>
  )
}

function ChatReferenceShelf({ references, referenceSupported, onChangeAction, onRemove, warning, testID }: {
  references: readonly ChatReference[]
  referenceSupported: (reference: ChatReference) => boolean
  onChangeAction: (reference: ChatReference) => void
  onRemove?: (reference: ChatReference) => void
  warning?: string | null
  testID: string
}) {
  const colors = usePalette()
  return <View testID={testID} accessibilityLabel="Cross-chat actions" style={styles.referenceShelfWrap}>
    <ScrollView
      horizontal
      style={styles.referenceRail}
      contentContainerStyle={styles.referenceShelf}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
    >
      {references.map(reference => {
        const supported = referenceSupported(reference)
        return <View
          key={`${reference.session_id}:${reference.source_text_start}:${reference.source_text_end}`}
          style={[styles.referenceChip, { backgroundColor: supported ? `${colors.blue}14` : `${colors.red}14`, borderColor: supported ? `${colors.blue}66` : colors.red }]}
        >
          <MessageSquareShare size={14} color={supported ? colors.blue : colors.red} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cross-chat action for ${reference.display_title_snapshot}: ${chatReferenceLabel(reference.action)}. Change action`}
            onPress={() => onChangeAction(reference)}
            style={styles.referenceAction}
          >
            <Text style={[styles.referenceTitle, { color: colors.text }]} numberOfLines={1}>@{reference.display_title_snapshot}</Text>
            <Text style={[styles.referenceLabel, { color: supported ? colors.blue : colors.red }]} numberOfLines={1}>· {chatReferenceLabel(reference.action)}</Text>
            <ChevronDown size={13} color={supported ? colors.blue : colors.red} />
          </Pressable>
          {onRemove ? <IconButton icon={X} size={13} touchSize={44} onPress={() => onRemove(reference)} label={`Remove reference to ${reference.display_title_snapshot}`} /> : null}
        </View>
      })}
    </ScrollView>
    {warning ? <View accessibilityRole="alert" style={styles.referenceWarning}><AlertCircle size={13} color={colors.red} /><Text style={[styles.referenceWarningText, { color: colors.red }]}>{warning}</Text></View> : null}
  </View>
}

export function ChatTargetPicker({ visible, width, query, sourceSessionId, supportedTargetBackends, references, requestReplySupported, referenceLimitReached, onQueryChange, onTeamNetwork, onSelect, onClose, onDidDismiss }: {
  visible: boolean
  width: number
  query: string
  sourceSessionId: string
  supportedTargetBackends: readonly Session['backend'][]
  references: readonly ChatReference[]
  requestReplySupported: boolean
  referenceLimitReached: boolean
  onQueryChange: (query: string) => void
  onTeamNetwork: () => void
  onSelect: (target: Session) => boolean
  onClose: () => void
  onDidDismiss: () => void
}) {
  const colors = usePalette()
  const tablet = width >= 720
  const searchInputRef = useRef<TextInput>(null)
  const routeSnapshot = useAppStore(state => visible ? state.agentRoutesBySession?.[sourceSessionId] : undefined)
  const routes = routeSnapshot?.routes ?? EMPTY_ROUTES
  const loading = useAppStore(state => visible && (state.agentRouteLoadingSessionIds?.has(sourceSessionId) ?? false))
  const error = useAppStore(state => visible ? state.agentRouteErrorsBySession?.[sourceSessionId] : undefined)
  const revoking = useAppStore(state => visible ? state.revokingAgentRouteIds ?? EMPTY_ROUTE_IDS : EMPTY_ROUTE_IDS)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting)
  const revokedInFlight = useRef(new Map<string, symbol>())
  const selected = useRef(false)
  const validationRevision = client.validationRevision
  const actionScopeKey = useAppStore(state => composerActionScopeKey(state, sourceSessionId))
  useEffect(() => {
    selected.current = false
    revokedInFlight.current.clear()
    if (visible && connected && client.isValidated) void useAppStore.getState().refreshAgentRoutes(sourceSessionId, generation)
    return () => { revokedInFlight.current.clear() }
  }, [visible, sourceSessionId, profileId, generation, connected, validationRevision, actionScopeKey])
  const grantByTarget = useMemo(() => new Map(routes.map(route => [route.target_session_id, route])), [routes])
  const revoke = async (route: AgentCrossChatRoute) => {
    if (revokedInFlight.current.has(route.route_id) || !remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId) || composerActionScopeKey(useAppStore.getState(), sourceSessionId) !== actionScopeKey) return
    const token = Symbol()
    revokedInFlight.current.set(route.route_id, token)
    try { await useAppStore.getState().revokeAgentRoute(sourceSessionId, route.route_id, route.revision, generation) }
    finally { if (revokedInFlight.current.get(route.route_id) === token) revokedInFlight.current.delete(route.route_id) }
  }
  const targets = useAppStore(useShallow(state => visible ? rankChatTargets(
    state.sessions.filter(candidate => (
      candidate.id !== sourceSessionId
      && !candidate.archived
      && supportedTargetBackends.includes(candidate.backend)
    )),
    query,
  ) : EMPTY_SESSIONS))
  // Status changes that do not affect session metadata (notably queued-turn
  // bookkeeping) still refresh an open picker through one stable primitive.
  useAppStore(state => visible ? targets.map(target => [
    target.id,
    state.activeSessionIds.has(target.id) ? 1 : 0,
    state.snapshots[target.id]?.queuedTurns.filter(isUserQueuedTurn).length ?? 0,
  ].join(':')).join('|') : '')
  const activeSessionIds = useAppStore.getState().activeSessionIds
  const queuedCount = (targetId: string) => useAppStore.getState().snapshots[targetId]?.queuedTurns.filter(isUserQueuedTurn).length ?? 0
  const needle = query.trim().toLocaleLowerCase()
  const detachedGrants = routes.filter(route => !targets.some(target => target.id === route.target_session_id)
    && (!needle || [route.alias, route.target.title, route.target_session_id].some(value => value?.toLocaleLowerCase().includes(needle))))
  const routeRevokeButton = (route: AgentCrossChatRoute) => {
    const busy = revoking.has(`${sourceSessionId}:${route.route_id}`)
    const disabled = busy || !connected || !client.isValidated
    return <Pressable testID={`chat-route-revoke-${route.route_id}`} accessibilityRole="button" accessibilityLabel={`Revoke access to ${route.target.title || route.alias || 'chat'}`} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={() => void revoke(route)} style={({ pressed }) => [styles.routeRevoke, { opacity: disabled || pressed ? 0.5 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.red} /> : <Text style={{ color: colors.red, fontSize: 12, fontWeight: '700' }}>Revoke</Text>}</Pressable>
  }
  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle={Platform.OS === 'ios' ? tablet ? 'formSheet' : 'pageSheet' : 'fullScreen'}
    allowSwipeDismissal
    onShow={() => searchInputRef.current?.focus()}
    onRequestClose={onClose}
    onDismiss={onDidDismiss}
  >
    {visible ? <SafeAreaView edges={Platform.OS === 'ios' ? ['bottom'] : ['top', 'bottom']} onAccessibilityEscape={onClose} style={[styles.targetPickerSafe, { backgroundColor: colors.background }]}>
      <View style={styles.targetPickerGrabber} />
      <View style={[styles.targetPickerPanel, tablet && styles.targetPickerPanelTablet]}>
        <View style={[styles.targetPickerHeader, { borderColor: colors.border }]}>
          <View style={styles.targetPickerHeading}>
            <Text style={[styles.targetPickerTitle, { color: colors.text }]}>Reference another chat</Text>
            <Text style={[styles.targetPickerSubtitle, { color: colors.muted }]}>Choose a chat. New access is granted when you send.</Text>
          </View>
          <SheetCloseButton onPress={onClose} label="Close chat picker" testID="chat-target-picker-close" />
        </View>
        <View style={[styles.targetSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Search size={17} color={colors.muted} />
          <TextInput
            ref={searchInputRef}
            testID="chat-target-search"
            accessibilityLabel="Search target chats"
            value={query}
            onChangeText={onQueryChange}
            returnKeyType="search"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={dismissAppKeyboard}
            clearButtonMode="while-editing"
            placeholder="Search chats"
            placeholderTextColor={colors.muted}
            style={[styles.targetSearchInput, { color: colors.text }]}
          />
        </View>
        {referenceLimitReached ? <View accessibilityRole="alert" testID="chat-target-reference-limit" style={[styles.referenceWarning, styles.targetLimitWarning]}><AlertCircle size={14} color={colors.red} /><Text style={[styles.referenceWarningText, { color: colors.red }]}>Maximum {MAX_CHAT_REFERENCES} chat references reached. Remove one before adding another.</Text></View> : null}
        {loading ? <View testID="chat-routes-loading" style={styles.routeNotice}><ActivityIndicator size="small" color={colors.blue} /><Text style={{ color: colors.muted }}>Refreshing granted access…</Text></View> : null}
        {error ? <View testID="chat-routes-error" accessibilityRole="alert" style={styles.routeNotice}><Text style={{ color: colors.red, flex: 1 }}>{error}</Text><Pressable testID="chat-routes-retry" accessibilityRole="button" accessibilityLabel="Retry loading granted chat access" disabled={!connected || loading} onPress={() => { if (remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId)) void useAppStore.getState().refreshAgentRoutes(sourceSessionId, generation) }} style={styles.routeRevoke}><Text style={{ color: colors.blue }}>Retry</Text></Pressable></View> : null}
        <Pressable testID="chat-target-team-network" accessibilityRole="button" accessibilityLabel="Reference a server inbox with @@" onPress={onTeamNetwork} style={[styles.targetRow, { marginHorizontal: 16, backgroundColor: colors.surface, borderColor: colors.border }]}><Mail size={20} color={colors.blue} /><Text style={{ color: colors.blue }}>Servers (@@) · Team Network inbox</Text></Pressable>
        <FlatList
          testID="chat-target-list"
          data={targets}
          keyExtractor={target => target.id}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={dismissAppKeyboard}
          contentContainerStyle={[styles.targetList, !targets.length && styles.targetListEmpty]}
          ListEmptyComponent={<View style={styles.targetEmpty}><MessageSquareShare size={28} color={colors.muted} /><Text style={[styles.targetEmptyTitle, { color: colors.text }]}>No matching chats</Text><Text style={[styles.targetEmptyBody, { color: colors.muted }]}>Try another title, folder, backend, or chat ID.</Text></View>}
          ListFooterComponent={<View style={{ gap: 8 }}>
            {detachedGrants.map(route => <View key={route.route_id} testID={`chat-detached-route-${route.route_id}`} style={[styles.targetRow, { borderColor: colors.border, backgroundColor: colors.surface }]}><View style={styles.targetIdentity}><Text style={[styles.targetTitle, { color: colors.text }]}>{route.target.title || route.alias || 'Unavailable chat'}</Text><Text style={[styles.targetMeta, { color: colors.muted }]}>Granted · {routeActionLabel(route)} · {route.target.available ? 'Available' : 'Target unavailable'}</Text></View>{routeRevokeButton(route)}</View>)}
            {routeSnapshot && routeCapacityReached(routes, routeSnapshot.max_routes, references) ? <Text testID="chat-route-capacity" style={{ color: colors.orange, fontSize: 12 }}>Route access limit reached. Granted chats remain available; revoke one to grant another.</Text> : null}
            {routes.length ? <Text style={{ color: colors.muted, fontSize: 12 }}>Revoke removes this chat’s granted cross-chat access. Removing a draft reference does not revoke access.</Text> : null}
          </View>}
          renderItem={({ item }) => {
            const count = queuedCount(item.id)
            const status = chatTargetStatus(item, activeSessionIds.has(item.id), count)
            const meta = [item.folder?.trim(), backendLabel(item.backend), tablet ? item.id.slice(0, 8) : null].filter(Boolean).join(' · ')
            const grant = grantByTarget.get(item.id)
            const capacityReached = Boolean(routeSnapshot && routeCapacityReached(routes, routeSnapshot.max_routes, references, item.id))
            const disabled = referenceLimitReached || capacityReached || !connected || !client.isValidated || Boolean(grant && revoking.has(`${sourceSessionId}:${grant.route_id}`))
            return <View style={[styles.routeRow, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable
              testID={`chat-target-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Reference ${item.title}. ${grant ? 'Granted' : 'Will grant when sent'}. ${status}`}
              accessibilityHint={capacityReached ? 'Revoke an existing route to grant another chat.' : undefined}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => {
                if (selected.current || disabled || !remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId) || composerActionScopeKey(useAppStore.getState(), sourceSessionId) !== actionScopeKey) return
                selected.current = onSelect(item)
              }}
              style={({ pressed }) => [styles.targetRow, styles.routeTarget, tablet && styles.targetRowTablet, { backgroundColor: pressed ? colors.raised : colors.surface, opacity: disabled ? 0.45 : 1 }]}
            >
              <View style={[styles.targetBackend, { backgroundColor: colors.raised }]}><BackendMark backend={item.backend} size={22} /></View>
              <View style={styles.targetIdentity}><Text style={[styles.targetTitle, { color: colors.text }]} numberOfLines={1}>{item.title || item.id}</Text><Text style={[styles.targetMeta, { color: colors.muted }]}>{grant ? `Granted · ${routeActionLabel(grant)}` : `Will grant when sent · ${requestReplySupported ? 'Send + Ask' : 'Send'}`}</Text><Text style={[styles.targetMeta, { color: colors.muted }]} numberOfLines={1}>{meta} · {status}</Text></View>
            </Pressable>{grant ? routeRevokeButton(grant) : null}</View>
          }}
        />
      </View>
    </SafeAreaView> : null}
  </Modal>
}

function availableChatReferenceActions(actions: readonly ChatReferenceAction[], requestReplySupportedForSource: boolean): ChatReferenceAction[] {
  // Modern local mentions grant a route; legacy one-shot actions must not be
  // offered as if they could be submitted through the current v7 contract.
  if (actions.includes('route')) return ['route']
  return actions.filter(action => action !== 'request_reply' || requestReplySupportedForSource)
}

function routeActionLabel(route: AgentCrossChatRoute): string {
  const send = route.actions.includes('instruction')
  const ask = route.actions.includes('request_reply')
  return send && ask ? 'Send + Ask' : send ? 'Send' : ask ? 'Ask' : 'No actions'
}

function routeCapacityReached(routes: readonly AgentCrossChatRoute[], maximum: number | null, references: readonly ChatReference[], targetId?: string): boolean {
  if (maximum === null) return false
  const granted = new Set(routes.map(route => route.target_session_id))
  const pending = new Set(references.filter(reference => reference.target_kind !== 'secure_peer' && reference.action === 'route' && reference.grant_intent === true && !granted.has(reference.session_id)).map(reference => reference.session_id))
  if (targetId && (granted.has(targetId) || pending.has(targetId))) return false
  return routes.length + pending.size >= maximum
}

function sameChatReference(left: ChatReference, right: ChatReference): boolean {
  return left.session_id === right.session_id
    && left.display_title_snapshot === right.display_title_snapshot
    && left.source_text_start === right.source_text_start
    && left.source_text_end === right.source_text_end
}

function showReferenceActionPicker({ width, reference, actions, onSelect }: {
  width: number
  reference: ChatReference
  actions: readonly ChatReferenceAction[]
  onSelect: (action: ChatReferenceAction) => void
}) {
  const ordered = (['route', 'direct_message', 'request_reply', 'instruction', 'final_result'] as const).filter(action => actions.includes(action))
  if (!ordered.length) {
    Alert.alert('Chat handoffs unavailable', 'This server did not advertise any compatible actions.')
    return
  }
  const labels = ordered.map(chatReferenceActionMenuLabel)
  if (Platform.OS === 'ios' && width < 720) {
    const options = [...labels, 'Cancel']
    ActionSheetIOS.showActionSheetWithOptions({
      title: `@${reference.display_title_snapshot} · ${chatReferenceLabel(reference.action)}`,
      options,
      cancelButtonIndex: options.length - 1,
    }, index => {
      const action = ordered[index]
      if (action) onSelect(action)
    })
    return
  }
  Alert.alert(`@${reference.display_title_snapshot}`, 'Choose how this chat should receive the message.', [
    ...ordered.map(action => ({ text: chatReferenceActionMenuLabel(action), onPress: () => onSelect(action) })),
    { text: 'Cancel', style: 'cancel' as const },
  ])
}

function chatReferenceActionMenuLabel(action: ChatReferenceAction): string {
  if (action === 'route') return 'Grant durable route'
  if (action === 'direct_message') return 'Direct message'
  if (action === 'request_reply') return 'Ask & return reply'
  if (action === 'final_result') return 'Send my final result'
  return 'Send only'
}

function rankChatTargets(targets: Session[], query: string): Session[] {
  const needle = query.trim().toLocaleLowerCase()
  return [...targets].sort((left, right) => {
    const leftRank = chatTargetSearchRank(left, needle)
    const rightRank = chatTargetSearchRank(right, needle)
    if (leftRank !== rightRank) return leftRank - rightRank
    const leftActivity = Date.parse(left.latest_event_at || left.updated_at || left.created_at || '') || 0
    const rightActivity = Date.parse(right.latest_event_at || right.updated_at || right.created_at || '') || 0
    if (leftActivity !== rightActivity) return rightActivity - leftActivity
    return (left.title || left.id).localeCompare(right.title || right.id)
  }).filter(target => chatTargetSearchRank(target, needle) < 9)
}

function chatTargetSearchRank(target: Session, needle: string): number {
  if (!needle) return 0
  const title = (target.title || '').toLocaleLowerCase()
  const folder = (target.folder || '').toLocaleLowerCase()
  const backend = target.backend.toLocaleLowerCase()
  const id = target.id.toLocaleLowerCase()
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (title.includes(needle)) return 2
  if (folder.startsWith(needle)) return 3
  if (folder.includes(needle) || backend.includes(needle) || id.includes(needle)) return 4
  return 9
}

function chatTargetStatus(session: Session, active: boolean, queued: number): string {
  if (session.codex_needs_user_action || session.claude_needs_user_action) return 'Needs approval'
  if (active) return 'Running'
  if (queued > 0) return `Queued ${queued}`
  return 'Idle'
}

function AttachmentShelf({ sessionId, uploads, pending, failed, connectionReady, disabled, retryDisabled, onPreview, onRemove, onRemoveFailed, onRetry }: {
  sessionId: string
  uploads: AgentFile[]
  pending: UploadRef[]
  failed: FailedUpload[]
  connectionReady: boolean
  disabled: boolean
  retryDisabled: boolean
  onPreview: (name: string, source: AttachmentImageSource) => void
  onRemove: (fileId: string) => void
  onRemoveFailed: (fileUri: string) => void
  onRetry: (file: FailedUpload) => void
}) {
  const colors = usePalette()
  return <ScrollView
    horizontal
    testID="attachment-shelf"
    style={styles.uploadRail}
    contentContainerStyle={styles.uploads}
    showsHorizontalScrollIndicator={false}
    keyboardShouldPersistTaps="handled"
  >
    {uploads.map(file => {
      const image = isImage(file)
      // fileURL/authHeaders intentionally assert a validated connection, so
      // never evaluate them while the app is offline or switching servers.
      const source = image && connectionReady ? { uri: client.fileURL(sessionId, file.id), headers: client.authHeaders() } : null
      return <View key={`ready:${file.id}`} testID={`attachment-ready-${file.id}`} style={[styles.upload, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pressable disabled={!source} accessibilityRole={source ? 'button' : undefined} accessibilityLabel={source ? `Preview ${file.filename}` : file.filename} onPress={() => source && onPreview(file.filename, source)} style={styles.uploadIdentity}>
          <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{source ? <Image source={source} contentFit="cover" style={StyleSheet.absoluteFill} transition={120} /> : <FileIcon size={21} color={colors.muted} strokeWidth={1.8} />}</View>
          <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.filename}</Text><Text style={[styles.uploadMeta, { color: colors.muted }]} numberOfLines={1}>{formatBytes(file.size) || (image ? 'Photo ready' : 'File ready')}</Text></View>
        </Pressable>
        <IconButton icon={X} size={14} disabled={disabled} onPress={() => onRemove(file.id)} label={`Remove ${file.filename}`} />
      </View>
    })}
    {pending.map((file, index) => {
      const image = isImageUpload(file)
      const source = image ? { uri: file.uri } : null
      return <View key={`pending:${file.uri}`} testID={`attachment-pending-${index}`} style={[styles.upload, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pressable disabled={!source} accessibilityRole={source ? 'button' : undefined} accessibilityLabel={source ? `Preview ${file.name}` : file.name} onPress={() => source && onPreview(file.name, source)} style={styles.uploadIdentity}>
          <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{source ? <Image source={source} contentFit="cover" style={StyleSheet.absoluteFill} /> : <FileIcon size={21} color={colors.muted} strokeWidth={1.8} />}<View style={styles.uploadBusy}><ActivityIndicator size="small" color="white" /></View></View>
          <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.name}</Text><Text style={[styles.uploadMeta, { color: colors.blue }]} numberOfLines={1}>Uploading…</Text></View>
        </Pressable>
        <View style={styles.uploadActionSpacer} />
      </View>
    })}
    {failed.map((file, index) => <View key={`failed:${file.uri}`} testID={`attachment-failed-${index}`} style={[styles.upload, { backgroundColor: `${colors.red}12`, borderColor: colors.red }]}>
      <Pressable disabled={retryDisabled} accessibilityRole="button" accessibilityLabel={`Retry ${file.name}`} onPress={() => onRetry(file)} style={styles.uploadIdentity}>
        <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{isImageUpload(file) ? <Image source={{ uri: file.uri }} contentFit="cover" style={StyleSheet.absoluteFill} /> : <FileIcon size={21} color={colors.red} strokeWidth={1.8} />}<View style={styles.uploadError}><AlertCircle size={15} color="white" fill={colors.red} /></View></View>
        <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.name}</Text><Text style={[styles.uploadMeta, { color: colors.red }]} numberOfLines={1}>Upload failed · Tap to retry</Text></View>
      </Pressable>
      <IconButton icon={X} size={14} disabled={disabled} onPress={() => onRemoveFailed(file.uri)} label={`Remove ${file.name}`} />
    </View>)}
  </ScrollView>
}

export function QueueShelf({ sessionId, profileId, profileGeneration, networkDisabled, auxiliaryHidden = false, reviewRequest = 0, onEditingChange, onSent }: { sessionId: string; profileId: string | null; profileGeneration: number; networkDisabled: boolean; auxiliaryHidden?: boolean; reviewRequest?: number; onEditingChange?: (editing: boolean) => void; onSent: () => void }) {
  const colors = usePalette()
  const agentPalette = useColorScheme() === 'light'
    ? { background: '#f4effb', accent: '#8566bd', sender: '#7050aa' }
    // Mac mixes #9d7ac9 at 12% over #222 for a pending agent message.
    : { background: '#312d36', accent: '#9d7ac9', sender: '#c3a9e4' }
  const { width } = useWindowDimensions()
  const allTurns = useAppStore(state => state.snapshots[sessionId]?.queuedTurns) ?? EMPTY_QUEUE
  const turns = useMemo(() => allTurns.filter(isVisibleQueuedTurn), [allTurns])
  const health = useAppStore(state => state.health)
  const sourceBackend = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.backend)
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const queuedTargetIds = useMemo(() => new Set(turns.flatMap(turn => (turn.chat_references ?? []).map(reference => reference.session_id))), [turns])
  useAppStore(state => queuedTargetIds.size ? [...queuedTargetIds].map(targetId => {
    const target = state.sessions.find(candidate => candidate.id === targetId)
    return target ? `${target.id}:${target.backend}:${target.archived ? 1 : 0}` : `${targetId}:missing`
  }).join('|') : '')
  const supportedChatActions = useMemo(() => supportedCrossChatActions(health), [health])
  const supportedTargetBackends = useMemo(() => supportedCrossChatTargetBackends(health), [health])
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && Boolean(sourceBackend && supportedTargetBackends.includes(sourceBackend))
  const pendingQueuedRunIds = useAppStore(state => state.pendingQueuedRunIds)
  const runStatus = useAppStore(state => state.queuedRunStatus[sessionId])
  const update = useAppStore(state => state.updateQueued)
  const updateAgentMessage = useAppStore(state => state.updateQueuedAgentMessage)
  const remove = useAppStore(state => state.removeQueued)
  const move = useAppStore(state => state.moveQueued)
  const runNow = useAppStore(state => state.runQueuedNow)
  const skipDelivery = useAppStore(state => state.skipQueuedDelivery)
  const skippingDeliveryIds = useAppStore(state => state.skippingQueuedDeliveryIds ?? EMPTY_ROUTE_IDS)
  const sourceTitles = useAppStore(useShallow(state => Object.fromEntries(turns.filter(isAsyncQueuedChatMessage).map(turn => [turn.source_session_id ?? '', state.sessions.find(session => session.id === turn.source_session_id)?.title ?? 'Unknown agent']))))
  const clearRunStatus = useAppStore(state => state.clearQueuedRunStatus)
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const reviewOpenRef = useRef(false)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => { onEditingChange?.(Boolean(editing)) }, [editing, onEditingChange])
  const [editText, setEditText] = useState('')
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [editReferences, setEditReferences] = useState<ChatReference[]>([])
  const [editTeamReferences, setEditTeamReferences] = useState<TeamReference[]>([])
  const editTextRef = useRef('')
  const editReferencesRef = useRef<ChatReference[]>([])
  const editTeamReferencesRef = useRef<TeamReference[]>([])
  const editingQueuedIdRef = useRef<string | null>(null)
  const editingAgentRef = useRef<QueuedTurn | null>(null)
  const editingUserRef = useRef<QueuedTurn | null>(null)
  const queueInputRef = useRef<TextInput>(null)
  const auxiliaryHiddenRef = useRef(auxiliaryHidden)
  auxiliaryHiddenRef.current = auxiliaryHidden
  useEffect(() => {
    // Keep the draft mounted across viewport changes, but never leave typing
    // focused in an invisible queue editor. Do not disturb main-composer focus.
    if (auxiliaryHidden && !reviewOpen && queueInputRef.current?.isFocused()) queueInputRef.current.blur()
  }, [auxiliaryHidden, reviewOpen])
  const queueControlsVisible = () => reviewOpenRef.current || (!auxiliaryHiddenRef.current && expandedRef.current)
  const [busyTurn, setBusyTurn] = useState<string | null>(null)
  const actionInFlight = useRef<symbol | null>(null)
  const actionScopeKey = useAppStore(state => composerActionScopeKey(state, sessionId))
  useEffect(() => { setCopyNotice(null) }, [editing, actionScopeKey])
  useEffect(() => {
    actionInFlight.current = null
    setBusyTurn(null)
    return () => { actionInFlight.current = null }
  }, [actionScopeKey])
  useEffect(() => {
    expandedRef.current = false
    setExpanded(false)
    reviewOpenRef.current = false
    setReviewOpen(false)
    setPanelError(null)
    editingAgentRef.current = null
    editingUserRef.current = null
    editingQueuedIdRef.current = null
    editTextRef.current = ''
    editReferencesRef.current = []
    editTeamReferencesRef.current = []
    setEditing(null)
    setEditText('')
    setEditReferences([])
    setEditTeamReferences([])
  }, [profileId, profileGeneration, sessionId])
  const actionScopeCurrent = () => remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)
    && composerActionScopeKey(useAppStore.getState(), sessionId) === actionScopeKey
  const closeReview = () => {
    reviewOpenRef.current = false
    setReviewOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }
  const openReview = () => {
    if (!composerScopeIsCurrent(profileId, profileGeneration, sessionId)) return
    reviewOpenRef.current = true
    setReviewOpen(true)
    requestAnimationFrame(dismissAppKeyboard)
  }
  const lastReviewRequest = useRef(reviewRequest)
  useEffect(() => {
    if (lastReviewRequest.current === reviewRequest) return
    lastReviewRequest.current = reviewRequest
    openReview()
  }, [reviewRequest])
  const referenceSupported = useCallback((reference: ChatReference): boolean => {
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      localChatReferenceContractSupported(health, reference)
      && (reference.action !== 'request_reply' || requestReplySupportedForSource)
      && target
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  }, [health, requestReplySupportedForSource, supportedTargetBackends])
  const beginEdit = (turn: QueuedTurn, references?: ChatReference[]) => {
    if (!queueControlsVisible() || !isUserQueuedTurn(turn) || actionInFlight.current || !actionScopeCurrent()) return
    const currentTurn = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === turn.queued_id)
    if (!currentTurn || queuedUserEditIdentity(currentTurn) !== queuedUserEditIdentity(turn)) return
    if (editingQueuedIdRef.current && editingQueuedIdRef.current !== turn.queued_id) {
      Alert.alert('Keep your unsaved edit', 'Copy or discard the existing edit before editing another queued message.')
      return
    }
    editingAgentRef.current = null
    editingUserRef.current = currentTurn
    const text = turn.display_prompt || turn.prompt
    const nextReferences = references ?? parseStoredChatReferences(turn.chat_references, text, sessionId)
    const nextTeamReferences = validTeamReferences(text, turn.team_references ?? [])
    if (nextTeamReferences.length !== (turn.team_references?.length ?? 0)) {
      Alert.alert('Recipient unavailable', 'This queued item has a Team Network reference that Mobile cannot edit. Edit it from Mac.')
      return
    }
    editTextRef.current = text
    editingQueuedIdRef.current = turn.queued_id
    editReferencesRef.current = nextReferences
    editTeamReferencesRef.current = nextTeamReferences
    setEditTeamReferences(nextTeamReferences)
    setEditing(turn.queued_id)
    setEditText(text)
    setEditReferences(nextReferences)
  }
  const cancelEdit = () => {
    editingAgentRef.current = null
    editingUserRef.current = null
    editingQueuedIdRef.current = null
    editTextRef.current = ''
    editReferencesRef.current = []
    editTeamReferencesRef.current = []
    setEditTeamReferences([])
    setEditing(null)
    setEditText('')
    setEditReferences([])
  }
  const commitEdit = async (turn: QueuedTurn) => {
    if (!queueControlsVisible() || networkDisabled || actionInFlight.current || editingQueuedIdRef.current !== turn.queued_id || !actionScopeCurrent()) return
    const agentSnapshot = editingAgentRef.current
    if (agentSnapshot) {
      const currentTurn = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === agentSnapshot.queued_id)
      if (!currentTurn || !canEditQueuedAgentMessage(currentTurn, sessionId, useAppStore.getState().health)
        || queuedMessageIdentity(currentTurn) !== queuedMessageIdentity(agentSnapshot)) {
        setPanelError('Queued message changed. Your unsaved draft is preserved; reopen the current message before saving.')
        Alert.alert('Queued message changed', 'Keep your draft, then reopen the current message before saving.')
        return
      }
      if (!editTextRef.current.trim()) { Alert.alert('Queued message is empty', 'Enter a message or cancel editing.'); return }
      await act(turn.queued_id, async () => {
        const updated = await updateAgentMessage(sessionId, turn.queued_id, editTextRef.current.trim(), agentSnapshot.message_revision!, profileGeneration)
        if (updated && actionScopeCurrent()) cancelEdit()
        else if (actionScopeCurrent()) setPanelError(useAppStore.getState().error || 'This queued message could not be saved. Your draft is preserved.')
        return updated
      }, true)
      return
    }
    const currentTurn = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === turn.queued_id)
    if (!currentTurn || !editingUserRef.current || queuedUserEditIdentity(currentTurn) !== queuedUserEditIdentity(editingUserRef.current)) {
      setPanelError('Queued message changed. Your unsaved draft is preserved; reopen the current message before saving.')
      return
    }
    const currentText = editTextRef.current
    const currentReferences = editReferencesRef.current
    const currentTeamReferences = editTeamReferencesRef.current
    const prompt = currentText.trim()
    const leadingWhitespace = currentText.length - currentText.trimStart().length
    const references = validChatReferences(currentText, currentReferences, sessionId).map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    if (!prompt && !canPreserveQueuedAttachments(currentTurn)) {
      Alert.alert('Queued message is empty', 'Enter a message or cancel editing.')
      return
    }
    if (references.length !== currentReferences.length) {
      Alert.alert('Chat reference changed', 'Remove the changed reference or restore its exact @chat text.')
      return
    }
    if (!currentReferences.every(referenceSupported)) {
      Alert.alert('Chat handoff unavailable', 'This server cannot deliver one or more queued actions or target chats.')
      return
    }
    const teamReferences = validTeamReferences(currentText, currentTeamReferences, currentReferences).map(reference => ({ ...reference, source_text_start: reference.source_text_start - leadingWhitespace, source_text_end: reference.source_text_end - leadingWhitespace }))
    if (teamReferences.length !== currentTeamReferences.length || !teamReferences.every(reference => teamReferenceContractSupported(health, reference))) {
      Alert.alert('Team Network reference unavailable', 'Reconnect this server or remove the recipient reference.')
      return
    }
    await act(turn.queued_id, async () => {
      const updated = await update(sessionId, turn.queued_id, prompt, references, profileGeneration, teamReferences)
      if (updated && actionScopeCurrent()) { setPanelError(null); cancelEdit() }
      else if (actionScopeCurrent()) setPanelError(useAppStore.getState().error || 'This queued message could not be saved. Your draft is preserved.')
      return updated
    }, true)
  }
  const chooseQueuedAction = (turn: QueuedTurn, reference: ChatReference, currentReferences: ChatReference[]) => {
    if (!queueControlsVisible() || !actionScopeCurrent()) return
    if (editing && editing !== turn.queued_id) {
      Alert.alert('Finish the current edit', 'Save or cancel the queued message you are editing first.')
      return
    }
    showReferenceActionPicker({
      width,
      reference,
      actions: availableChatReferenceActions(supportedChatActions, requestReplySupportedForSource),
      onSelect: action => {
        if (!queueControlsVisible() || !actionScopeCurrent()) return
        const availableReferences = editing === turn.queued_id ? editReferencesRef.current : currentReferences
        const selected = availableReferences.find(candidate => sameChatReference(candidate, reference))
        if (!selected) return
        if (availableReferences.some(candidate => !sameChatReference(candidate, selected) && candidate.session_id === selected.session_id && candidate.action === action)) {
          Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${reference.display_title_snapshot}.`)
          return
        }
        const next = availableReferences.map(candidate => sameChatReference(candidate, selected) ? chatReferenceWithAction(candidate, action) : candidate)
        if (editing !== turn.queued_id) beginEdit(turn, next)
        else {
          editReferencesRef.current = next
          setEditReferences(next)
        }
      },
    })
  }
  const act = async (queuedId: string, action: () => Promise<boolean>, savingEdit = false) => {
    if (!queueControlsVisible() || actionInFlight.current || (!savingEdit && editingQueuedIdRef.current && useAppStore.getState().snapshots[sessionId]?.queuedTurns.some(turn => turn.queued_id === editingQueuedIdRef.current)) || pendingQueuedRunIds.has(queuedId) || networkDisabled || !actionScopeCurrent()) return false
    const token = Symbol()
    actionInFlight.current = token
    setBusyTurn(queuedId)
    try {
      const result = await action()
      return actionInFlight.current === token && actionScopeCurrent() ? result : false
    }
    catch { return false }
    finally {
      if (actionInFlight.current === token) {
        actionInFlight.current = null
        if (actionScopeCurrent()) setBusyTurn(null)
      }
    }
  }
  const beginAgentEdit = (turn: QueuedTurn, body: string) => {
    const currentTurn = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === turn.queued_id)
    if (!queueControlsVisible() || actionInFlight.current || editingQueuedIdRef.current || !actionScopeCurrent()
      || !currentTurn || !canEditQueuedAgentMessage(currentTurn, sessionId, useAppStore.getState().health)
      || queuedMessageIdentity(currentTurn) !== queuedMessageIdentity(turn)) return
    editingAgentRef.current = turn
    editingUserRef.current = null
    setPanelError(null)
    editingQueuedIdRef.current = turn.queued_id
    editTextRef.current = body
    editReferencesRef.current = []
    editTeamReferencesRef.current = []
    setEditReferences([])
    setEditTeamReferences([])
    setEditing(turn.queued_id)
    setEditText(body)
  }
  const orphanedEdit = Boolean(editing) && !turns.some(turn => turn.queued_id === editing)
  const queueBusy = Boolean(busyTurn) || Boolean(editing && !orphanedEdit) || turns.some(value => pendingQueuedRunIds.has(value.queued_id) || skippingDeliveryIds.has(`${sessionId}:${value.queued_id}`))
  const paused = turns.some(turn => turn.paused)
  const deliveryUncertain = turns.some(turn => turn.paused === true && turn.pause_reason === 'delivery_uncertain')
  const summaryError = Boolean(panelError || runStatus?.tone === 'error')
  const summary = panelError || (runStatus?.tone === 'error' ? runStatus.message : null)
    || (deliveryUncertain ? 'Delivery unconfirmed — review before retrying' : null)
    || runStatus?.message || (editing ? 'Unsaved edit' : queueBusy ? 'Updating…' : paused ? 'Paused' : 'Waiting')
  const rejectedTurn = runStatus?.goal_steer_rejected ? turns.find(turn => turn.queued_id === runStatus.queued_id && isUserQueuedTurn(turn)) : null
  const queueBody = <ScrollView testID="queued-section-body" style={[styles.queueScroll, reviewOpen && styles.queueReviewScroll]} contentContainerStyle={styles.queueList} nestedScrollEnabled keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag">
    {orphanedEdit ? <View testID="queued-orphaned-edit" style={styles.queueRecovery}>
      <Text accessibilityRole="alert" style={[styles.queueText, { color: colors.orange }]}>This message is no longer queued. Your unsaved edit is kept below; copy it before discarding. It has not been resent.</Text>
      <ScrollView style={styles.queueMessageScroll} nestedScrollEnabled keyboardShouldPersistTaps="always"><Text testID="queued-recovered-draft" selectable style={[styles.queueText, { color: colors.text }]}>{editText}</Text></ScrollView>
      <View style={styles.queuePreviewActions}>
        <Pressable testID="queued-recovered-copy" accessibilityRole="button" onPress={() => {
          if (!queueControlsVisible() || !composerScopeIsCurrent(profileId, profileGeneration, sessionId)) return
          const text = editTextRef.current
          const queuedId = editingQueuedIdRef.current
          const current = () => composerScopeIsCurrent(profileId, profileGeneration, sessionId) && composerActionScopeKey(useAppStore.getState(), sessionId) === actionScopeKey && editingQueuedIdRef.current === queuedId && editTextRef.current === text
          void Clipboard.setStringAsync(text).then(() => { if (current()) setCopyNotice('Draft copied.') }).catch(() => { if (current()) setCopyNotice('Copy failed. Select the text above to copy it manually.') })
        }} style={styles.runNow}><Text style={{ color: colors.blue }}>Copy draft</Text></Pressable>
        <Pressable testID="queued-recovered-discard" accessibilityRole="button" onPress={() => {
          if (!queueControlsVisible() || !composerScopeIsCurrent(profileId, profileGeneration, sessionId)) return
          const text = editTextRef.current
          const queuedId = editingQueuedIdRef.current
          Alert.alert('Discard recovered draft?', 'This unsaved edit will be removed from this device.', [{ text: 'Keep', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { if (queueControlsVisible() && composerScopeIsCurrent(profileId, profileGeneration, sessionId) && composerActionScopeKey(useAppStore.getState(), sessionId) === actionScopeKey && editingQueuedIdRef.current === queuedId && editTextRef.current === text) cancelEdit() } }])
        }} style={styles.runNow}><Text style={{ color: colors.red }}>Discard draft</Text></Pressable>
      </View>
      {copyNotice ? <Text testID="queued-recovered-copy-status" accessibilityLiveRegion="polite" style={[styles.queueText, { color: colors.text }]}>{copyNotice}</Text> : null}
    </View> : null}
    {panelError ? <Text testID="queued-message-error" accessibilityRole="alert" style={[styles.queueStatusText, { color: colors.red }]}>{panelError}</Text> : null}
    {runStatus ? <View testID="queued-run-status" accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.queueStatus, { backgroundColor: runStatus.tone === 'error' ? `${colors.red}14` : `${colors.yellow}14`, borderColor: runStatus.tone === 'error' ? colors.red : colors.yellow }]}>
      <AlertCircle size={14} color={runStatus.tone === 'error' ? colors.red : colors.yellow} />
      <ScrollView testID="queued-run-error-scroll" style={styles.queueMessageScroll} nestedScrollEnabled keyboardShouldPersistTaps="always"><Text testID="queued-run-error-full" selectable style={[styles.queueStatusText, { color: colors.text }]}>{runStatus.message}</Text></ScrollView>
      <IconButton icon={X} size={13} onPress={() => { if (composerScopeIsCurrent(profileId, profileGeneration, sessionId)) clearRunStatus(sessionId, profileGeneration) }} label="Dismiss queue status" />
    </View> : null}
    {rejectedTurn ? <View testID="queued-goal-steer-recovery" style={styles.queueRecovery}>
      <Text style={[styles.queueText, { color: colors.text }]}>If queued before this app update: Edit, then Save this same message, then Steer. Saving does not send it or create a duplicate.</Text>
      <Pressable testID="queued-recovery-edit" accessibilityRole="button" accessibilityLabel="Edit this existing queued message before retrying Steer" disabled={networkDisabled || queueBusy} onPress={() => beginEdit(rejectedTurn)} style={[styles.queueEditButton, { backgroundColor: colors.raised, opacity: networkDisabled || queueBusy ? 0.45 : 1 }]}><Text style={[styles.queueEditButtonText, { color: colors.blue }]}>Edit this message</Text></Pressable>
    </View> : null}
      {turns.map((turn, index) => {
        const busy = busyTurn === turn.queued_id || pendingQueuedRunIds.has(turn.queued_id) || skippingDeliveryIds.has(`${sessionId}:${turn.queued_id}`)
        const crossChatDelivery = isCrossChatDeliveryQueuedTurn(turn)
        const agentMessage = isAsyncQueuedChatMessage(turn)
        const sender = turn.source_title?.trim() || sourceTitles[turn.source_session_id ?? ''] || 'Unknown agent'
        const canSkip = Boolean(queuedDeliverySkipIdentity(turn, health))
        const canControlAgent = canEditQueuedAgentMessage(turn, sessionId, health)
        const blockedByEarlierDelivery = queuedTurnHasEarlierDeliveryBarrier(allTurns, turn.queued_id, asyncQueuedMessageControlsAvailable(health))
        const pausedLabel = turn.paused !== true
          ? null
          : turn.pause_reason === 'delivery_uncertain'
            ? 'Delivery unconfirmed — review before retrying'
            : turn.pause_reason === 'stopped'
              ? 'Paused after Stop'
              : 'Paused'
        const turnText = turn.display_prompt || turn.prompt
        const storedReferences = parseStoredChatReferences(turn.chat_references, turnText, sessionId)
        const rowReferences = editing === turn.queued_id ? editReferences : storedReferences
        const validEditReferences = editing !== turn.queued_id
          || (validChatReferences(editText, editReferences, sessionId).length === editReferences.length && editReferences.every(referenceSupported)
            && validTeamReferences(editText, editTeamReferences, editReferences).length === editTeamReferences.length
            && editTeamReferences.every(reference => teamReferenceContractSupported(health, reference)))
        const editHasContent = Boolean(editText.trim()) || canPreserveQueuedAttachments(turn)
        return <View key={turn.queued_id} testID={`queued-row-${turn.queued_id}`} style={[styles.queueRow, { backgroundColor: agentMessage ? agentPalette.background : colors.queued, borderColor: agentMessage ? agentPalette.accent : colors.yellow, borderLeftWidth: agentMessage ? 2 : StyleSheet.hairlineWidth }]}>
          {!agentMessage && turn.file_ids.length > 0 ? <Text testID={`queued-attachments-${turn.queued_id}`} style={[styles.queueText, { color: colors.muted }]}>{turn.file_ids.length} attached {turn.file_ids.length === 1 ? 'file' : 'files'} · kept with this queued message</Text> : null}
          {editing === turn.queued_id ? <TextInput
            ref={queueInputRef}
            testID={`queued-editor-${turn.queued_id}`}
            autoFocus
            editable={(!auxiliaryHidden || reviewOpen) && !networkDisabled && !busy}
            value={editText}
            onChangeText={next => {
              if (!queueControlsVisible()) return
              const nextReferences = reconcileChatReferences(editTextRef.current, next, editReferencesRef.current)
              const nextTeamReferences = reconcileTeamReferences(editTextRef.current, next, editTeamReferencesRef.current)
              editTeamReferencesRef.current = nextTeamReferences
              setEditTeamReferences(nextTeamReferences)
              editTextRef.current = next
              editReferencesRef.current = nextReferences
              setEditReferences(nextReferences)
              setEditText(next)
            }}
            multiline
            scrollEnabled
            style={[styles.queueInput, { color: colors.text }]}
          /> : <QueuedMessagePreview turn={turn} sender={sender} sessionId={sessionId} profileId={profileId} profileGeneration={profileGeneration}
            disabled={networkDisabled || queueBusy} canEditAgent={canControlAgent} onEdit={() => beginEdit(turn)} onEditAgent={body => beginAgentEdit(turn, body)} onError={setPanelError} />}
          {!agentMessage && pausedLabel ? <Text style={{ color: colors.orange, fontSize: 10 }}>{pausedLabel}</Text> : null}
          {!crossChatDelivery && rowReferences.length ? <ChatReferenceShelf
            references={rowReferences}
            referenceSupported={referenceSupported}
            onChangeAction={reference => chooseQueuedAction(turn, reference, rowReferences)}
            onRemove={reference => {
              if (!queueControlsVisible() || !actionScopeCurrent()) return
              if (editing && editing !== turn.queued_id) {
                Alert.alert('Finish the current edit', 'Save or cancel the queued message you are editing first.')
                return
              }
              const next = rowReferences.filter(candidate => candidate !== reference)
              if (editing !== turn.queued_id) beginEdit(turn, next)
              else {
                editReferencesRef.current = next
                setEditReferences(next)
              }
            }}
            warning={!rowReferences.every(referenceSupported) ? 'Change this action or target before saving.' : null}
            testID={`queued-chat-references-${turn.queued_id}`}
          /> : null}
          {crossChatDelivery && editing !== turn.queued_id ? <View style={styles.queueActions}>
            {canControlAgent ? <Pressable testID={`queued-send-now-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel="Run queued agent message now" accessibilityState={{ disabled: networkDisabled || queueBusy || blockedByEarlierDelivery, busy }} disabled={networkDisabled || queueBusy || blockedByEarlierDelivery} onPress={() => {
              const currentTurn = useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === turn.queued_id)
              if (!currentTurn || !canEditQueuedAgentMessage(currentTurn, sessionId, useAppStore.getState().health) || queuedMessageIdentity(currentTurn) !== queuedMessageIdentity(turn)) return
              void act(turn.queued_id, () => runNow(sessionId, turn.queued_id, profileGeneration)).then(sent => { if (sent && actionScopeCurrent()) onSent() })
            }} style={({ pressed }) => [styles.runNow, { opacity: networkDisabled || queueBusy || blockedByEarlierDelivery || pressed ? 0.45 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.yellow} /> : <CornerDownRight size={14} color={colors.yellow} />}<Text style={{ color: colors.yellow }}>Run now</Text></Pressable> : null}
            <View style={styles.toolbarSpacer} /><Pressable testID={`queued-skip-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel={`Remove queued message from ${sender}`} accessibilityHint={!canSkip ? 'Update AgentsServer to safely remove this delivery.' : undefined} accessibilityState={{ disabled: networkDisabled || queueBusy || !canSkip, busy }} disabled={networkDisabled || queueBusy || !canSkip} onPress={() => void act(turn.queued_id, () => skipDelivery(sessionId, turn.queued_id, profileGeneration))} style={({ pressed }) => [styles.routeRevoke, { opacity: networkDisabled || queueBusy || !canSkip || pressed ? 0.45 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.red} /> : <Trash2 size={16} color={colors.red} />}</Pressable></View> : editing === turn.queued_id ? <View style={styles.queueEditActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel queued message edit" disabled={Boolean(busyTurn)} onPress={() => {
              if (queueControlsVisible() && !actionInFlight.current && editingQueuedIdRef.current === turn.queued_id && composerScopeIsCurrent(profileId, profileGeneration, sessionId)) cancelEdit()
            }} style={({ pressed }) => [styles.queueEditButton, { backgroundColor: colors.raised, opacity: busyTurn || pressed ? 0.5 : 1 }]}><Text style={[styles.queueEditButtonText, { color: colors.text }]}>Cancel</Text></Pressable>
            <Pressable testID={`queued-save-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel="Save queued message" accessibilityState={{ disabled: networkDisabled || busy || !editHasContent || !validEditReferences, busy }} disabled={networkDisabled || busy || !editHasContent || !validEditReferences} onPress={() => void commitEdit(turn)} style={({ pressed }) => [styles.queueEditButton, { backgroundColor: colors.blue, opacity: networkDisabled || busy || !editHasContent || !validEditReferences || pressed ? 0.45 : 1 }]}>{busy ? <ActivityIndicator size="small" color="white" /> : <><Check size={14} color="white" /><Text style={[styles.queueEditButtonText, { color: 'white' }]}>Save</Text></>}</Pressable>
          </View> : <View style={styles.queueActions}>
            <Pressable testID={`queued-send-now-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel={active ? "Steer with queued message" : "Run queued message now"} accessibilityHint={blockedByEarlierDelivery ? 'Wait for the earlier delivery barrier to finish.' : undefined} accessibilityState={{ disabled: networkDisabled || queueBusy || blockedByEarlierDelivery, busy }} disabled={networkDisabled || queueBusy || blockedByEarlierDelivery} onPress={() => void act(turn.queued_id, () => runNow(sessionId, turn.queued_id, profileGeneration)).then(sent => { if (sent && remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)) onSent() })} style={({ pressed }) => [styles.runNow, { opacity: networkDisabled || blockedByEarlierDelivery || pressed || queueBusy && !busy ? 0.45 : 1 }]}>
              {busy ? <ActivityIndicator size="small" color={colors.yellow} /> : <CornerDownRight size={14} color={colors.yellow} />}
              <Text style={{ color: colors.yellow, fontSize: 11, fontWeight: '800' }}>{active ? 'Steer' : 'Run now'}</Text>
            </Pressable>
            <View style={styles.toolbarSpacer} />
            <IconButton icon={ArrowUp} size={13} disabled={networkDisabled || index === 0 || queueBusy || queuedMoveCrossesDeliveryBarrier(allTurns, turn.queued_id, 'up')} onPress={() => void act(turn.queued_id, () => move(sessionId, turn.queued_id, 'up', profileGeneration))} label="Move up" />
            <IconButton icon={ArrowDown} size={13} disabled={networkDisabled || index === turns.length - 1 || queueBusy || queuedMoveCrossesDeliveryBarrier(allTurns, turn.queued_id, 'down')} onPress={() => void act(turn.queued_id, () => move(sessionId, turn.queued_id, 'down', profileGeneration))} label="Move down" />
            <IconButton icon={Trash2} size={13} disabled={networkDisabled || queueBusy} onPress={() => void act(turn.queued_id, () => remove(sessionId, turn.queued_id, profileGeneration))} label="Remove from queue" />
          </View>}
        </View>
      })}
    </ScrollView>
  return <View testID="queued-shelf" style={styles.queue}>
    <View style={styles.queueHeaderRow}><Pressable testID="queued-section-toggle" accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} queued messages (${turns.length}). ${summary}`} accessibilityState={{ expanded }}
      onPress={() => {
        if (auxiliaryHiddenRef.current || !composerScopeIsCurrent(profileId, profileGeneration, sessionId)) return
        expandedRef.current = !expandedRef.current
        setExpanded(expandedRef.current)
      }} style={({ pressed }) => [styles.queueHeader, styles.queueHeaderToggle, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
      <AlertCircle size={16} color={summaryError ? colors.red : deliveryUncertain ? colors.orange : colors.yellow} />
      <Text style={[styles.queueHeading, { color: colors.text }]}>Queued {turns.length}</Text>
      <Text testID="queued-section-summary" accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.queueSummary, { color: summaryError ? colors.red : deliveryUncertain ? colors.orange : colors.muted }]}>{summary}</Text>
      <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: expanded ? '0deg' : '-90deg' }] }} />
    </Pressable>
      <Pressable testID="queued-review-open" accessibilityRole="button" accessibilityLabel="Review queued messages and full error" accessibilityHint="Open full messages, errors, Edit, Save, and Steer controls." onPress={openReview} style={[styles.queueReviewButton, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.primaryButtonText, { color: colors.blue }]}>Review</Text></Pressable>
    </View>
    {expanded && !reviewOpen ? queueBody : null}
    <Modal visible={reviewOpen && composerScopeIsCurrent(profileId, profileGeneration, sessionId)} animationType="slide" presentationStyle="fullScreen" onRequestClose={closeReview}>
      {reviewOpen ? <SafeAreaView testID="queued-review-sheet" style={[styles.queueReviewSafe, { backgroundColor: colors.background }]} onAccessibilityEscape={closeReview}>
        <View style={[styles.queueReviewHeader, { borderColor: colors.border }]}>
          <Text accessibilityRole="header" style={[styles.queueReviewTitle, { color: colors.text }]}>Queued messages ({turns.length})</Text>
          <SheetCloseButton testID="queued-review-close" label="Close queued message review" onPress={closeReview} />
        </View>
        <KeyboardAvoidingView style={styles.queueReviewSafe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          {queueBody}
        </KeyboardAvoidingView>
      </SafeAreaView> : null}
    </Modal>
  </View>
}

function queuedMessageIdentity(turn: QueuedTurn): string {
  return JSON.stringify([turn.queued_id, turn.cross_chat_envelope_id, turn.source_session_id, turn.target_session_id,
    turn.conversation_mode, turn.delivery_mode, turn.message_revision, turn.message_edited_by_user, turn.promoted])
}

function queuedUserEditIdentity(turn: QueuedTurn): string {
  return JSON.stringify([turn.queued_id, turn.prompt, turn.display_prompt, turn.file_ids, turn.chat_references, turn.team_references])
}

function canPreserveQueuedAttachments(turn: QueuedTurn): boolean {
  return isUserQueuedTurn(turn) && !turn.prompt.trim() && !(turn.display_prompt ?? '').trim() && turn.file_ids.length > 0
    && !(turn.chat_references?.length) && !(turn.team_references?.length)
}

function canEditQueuedAgentMessage(turn: QueuedTurn, sessionId: string, health: Health | null): boolean {
  return isAsyncQueuedChatMessage(turn) && asyncQueuedMessageControlsAvailable(health)
    && !turn.promoted && turn.delivery_mode !== 'mailbox' && !turn.secure_peer_envelope_id
    && Boolean(turn.cross_chat_envelope_id?.trim() && turn.source_session_id?.trim())
    && turn.target_session_id === sessionId && turn.source_session_id !== sessionId
    && typeof turn.message_revision === 'number' && Number.isSafeInteger(turn.message_revision) && turn.message_revision >= 0
}

/** Reading a long queue body never increases the shelf's height without bound. */
function QueuedMessagePreview({ turn, sender, sessionId, profileId, profileGeneration, disabled, canEditAgent, onEdit, onEditAgent, onError }: {
  turn: QueuedTurn; sender: string; sessionId: string; profileId: string | null; profileGeneration: number;
  disabled: boolean; canEditAgent: boolean; onEdit: () => void; onEditAgent: (body: string) => void; onError: (error: string | null) => void;
}) {
  const colors = usePalette()
  const senderColor = useColorScheme() === 'light' ? '#7050aa' : '#c3a9e4'
  const agent = isAsyncQueuedChatMessage(turn)
  const identity = queuedMessageIdentity(turn)
  const actionScopeKey = useAppStore(state => composerActionScopeKey(state, sessionId))
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef<symbol | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    setExpanded(false); setLoaded(null); setLoading(false); request.current = null
    return () => { mounted.current = false; request.current = null }
  }, [identity, actionScopeKey, turn.message_body])
  const current = () => mounted.current && composerScopeIsCurrent(profileId, profileGeneration, sessionId)
    && queuedMessageIdentity(useAppStore.getState().snapshots[sessionId]?.queuedTurns.find(value => value.queued_id === turn.queued_id) ?? { queued_id: '', prompt: '', file_ids: [] }) === identity
  const body = agent ? turn.message_body ?? loaded : turn.display_prompt || turn.prompt
  const queuedPreview = turn.display_prompt || turn.prompt
  const preview = body ?? (agent && queuedPreview.trim() === 'Agent-authored same-server handoff' ? `Message from ${sender}` : queuedPreview)
  const load = async (): Promise<string | null> => {
    if (!current()) return null
    if (body != null) return body
    if (request.current || !agent || !turn.cross_chat_envelope_id || !turn.source_session_id || turn.target_session_id !== sessionId
      || !remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)) return null
    const token = Symbol()
    request.current = token
    setLoading(true); onError(null)
    const valid = () => request.current === token && current() && remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)
      && composerActionScopeKey(useAppStore.getState(), sessionId) === actionScopeKey
    try {
      const detail = await client.crossChatHandoff(turn.cross_chat_envelope_id)
      if (!valid()) return null
      const verified = authenticatedChatMessageBody(detail, {
        messageId: turn.cross_chat_envelope_id, sourceSessionId: turn.source_session_id, targetSessionId: sessionId,
        queuedId: turn.queued_id, messageRevision: turn.message_revision ?? undefined,
        editedByUser: turn.message_edited_by_user === true, incoming: true,
      })
      setLoaded(verified)
      return verified
    } catch (error) {
      if (valid()) onError(error instanceof Error ? error.message : 'The full queued message could not be loaded. Try again.')
      return null
    } finally {
      if (valid()) { request.current = null; setLoading(false) }
    }
  }
  const showBody = async () => {
    if (!current()) return
    if (expanded) { setExpanded(false); return }
    if (await load() != null && current()) setExpanded(true)
  }
  const editAgent = async () => {
    if (disabled || !canEditAgent || !current()) return
    const verified = await load()
    if (verified != null && current()) onEditAgent(verified)
  }
  return <View style={styles.queuePreview}>
    {agent ? <Text numberOfLines={1} style={{ color: senderColor, fontSize: 11 }}>{sender}{turn.message_edited_by_user ? ' · Edited by you' : ''}</Text> : null}
    {expanded ? <ScrollView testID={`queued-message-body-${turn.queued_id}`} style={styles.queueMessageScroll} nestedScrollEnabled keyboardShouldPersistTaps="always"><Text selectable style={[styles.queueText, { color: colors.text }]}>{body}</Text></ScrollView>
      : <Pressable accessibilityRole={agent ? undefined : 'button'} accessibilityLabel={agent ? `${sender}: ${preview}` : 'Edit queued message'} disabled={agent || disabled} onPress={onEdit} style={styles.queuePrompt}><Text numberOfLines={3} style={[styles.queueText, { color: colors.text }]}>{preview}</Text></Pressable>}
    <View style={styles.queuePreviewActions}>
      <Pressable testID={`queued-message-view-${turn.queued_id}`} accessibilityRole="button" accessibilityState={{ expanded, busy: loading }} disabled={loading} onPress={() => void showBody()} style={styles.runNow}><Text style={{ color: colors.blue }}>{loading ? 'Loading…' : expanded ? 'Show less' : 'View full message'}</Text></Pressable>
      {canEditAgent || !agent && isUserQueuedTurn(turn) ? <Pressable testID={`queued-message-edit-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel={agent ? 'Edit queued agent message' : 'Edit existing queued message'} disabled={disabled || loading} onPress={() => { if (agent) void editAgent(); else if (!disabled && current()) onEdit() }} style={styles.runNow}><Text style={{ color: disabled || loading ? colors.muted : colors.blue }}>Edit</Text></Pressable> : null}
    </View>
  </View>
}

function composerScopeIsCurrent(profileId: string | null, profileGeneration: number, sessionId: string): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === profileId
    && state.profileGeneration === profileGeneration
    && state.selectedSessionId === sessionId
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function composerActionScopeKey(state: ReturnType<typeof useAppStore.getState>, sessionId: string): string {
  return JSON.stringify([
    state.activeProfileId, state.profileGeneration, sessionId, state.selectedSessionId,
    client.validationRevision, client.isValidated,
    state.health?.server_identity, state.health?.server_instance_id,
    state.connected, state.connecting, state.switchingProfileId, state.workspaceAdopting,
  ])
}

function remoteComposerScopeIsCurrent(profileId: string | null, profileGeneration: number, sessionId: string): boolean {
  const state = useAppStore.getState()
  return composerScopeIsCurrent(profileId, profileGeneration, sessionId) && client.isValidated && state.connected && !state.connecting
}

function pickerError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The attachment picker could not be opened.'
}

const styles = StyleSheet.create({
  routeNotice: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row', alignItems: 'center' },
  routeRow: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  routeTarget: { flex: 1, minWidth: 0, borderWidth: 0 },
  routeRevoke: { minWidth: 64, minHeight: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  shell: { padding: COMPOSER_SHELL_PADDING, gap: 7 },
  shellConstrained: { paddingVertical: 0, gap: 0 },
  auxiliaryScroll: { flexGrow: 0 }, auxiliaryContent: { gap: 7 },
  commandSuggestion: { minHeight: 54, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 9 }, commandSuggestionText: { minWidth: 0, flex: 1, gap: 2 }, commandSuggestionTitle: { fontSize: 12.5, fontWeight: '800' }, commandSuggestionSyntax: { fontSize: 10.5, fontFamily: 'Menlo' },
  referenceShelfWrap: { minWidth: 0, gap: 3 },
  referenceRail: { flexGrow: 0, minHeight: 44, maxHeight: 44 },
  referenceShelf: { flexDirection: 'row', gap: 6, paddingRight: 2 },
  referenceChip: { minWidth: 0, maxWidth: 310, height: 44, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingLeft: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  referenceAction: { minWidth: 0, maxWidth: 230, height: 44, flexDirection: 'row', alignItems: 'center', gap: 3 },
  referenceTitle: { minWidth: 34, maxWidth: 118, flexShrink: 1, fontSize: 11.5, fontWeight: '800' },
  referenceLabel: { minWidth: 0, maxWidth: 114, flexShrink: 1, fontSize: 10.5, fontWeight: '700' },
  referenceWarning: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 },
  referenceWarningText: { minWidth: 0, flex: 1, fontSize: 10.5, lineHeight: 14, fontWeight: '600' },
  composer: { maxHeight: COMPOSER_CARD_MAX_HEIGHT, minHeight: COMPOSER_EMPTY_CARD_MIN_HEIGHT, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  input: { minHeight: COMPOSER_INPUT_MIN_HEIGHT, maxHeight: COMPOSER_INPUT_MAX_HEIGHT, paddingHorizontal: 14, paddingTop: 10, fontSize: 15.5, lineHeight: 21 },
  inputConstrained: { minHeight: 44 },
  toolbar: { minHeight: 48, flexShrink: 0, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolbarCompact: { minHeight: COMPOSER_COMPACT_TOOLBAR_HEIGHT, paddingHorizontal: COMPOSER_COMPACT_TOOLBAR_PADDING, gap: COMPOSER_COMPACT_TOOLBAR_GAP },
  toolbarDense: { paddingHorizontal: COMPOSER_DENSE_TOOLBAR_PADDING, gap: COMPOSER_DENSE_TOOLBAR_GAP },
  primaryActions: { minHeight: 48, flexShrink: 0, paddingHorizontal: 6, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 6 },
  primaryActionsConstrained: { minHeight: 44, paddingBottom: 0 },
  primaryButton: { flex: 1, minWidth: 44, minHeight: 44, paddingHorizontal: 6, paddingVertical: 6, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  primaryButtonText: { fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
  idleSend: { flex: 0, minWidth: 82, marginVertical: 2 },
  keyboardDismiss: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  quickMessagesMenu: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0 }, quickMessages: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  runtimeMenu: { minWidth: 0, flexShrink: 1 }, runtimeMenuCompact: { width: COMPOSER_COMPACT_BACKEND_SLOT_WIDTH, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0 }, runtimeMenuDense: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, alignItems: 'center', justifyContent: 'center' }, runtime: { minWidth: 0, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }, runtimeCompact: { width: COMPOSER_COMPACT_BACKEND_SLOT_WIDTH, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, justifyContent: 'center', gap: 0 }, runtimeDense: { width: COMPOSER_DENSE_BACKEND_SLOT_WIDTH }, backend: { fontSize: 12, fontWeight: '700' }, toolbarSpacer: { flex: 1, minWidth: 0 },
  uploadRail: { flexGrow: 0, minHeight: 64, maxHeight: 64 }, uploads: { flexDirection: 'row', gap: 7, paddingRight: 2 }, upload: { width: 216, height: 64, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingLeft: 7, flexDirection: 'row', alignItems: 'center' }, uploadIdentity: { minWidth: 0, flex: 1, height: 62, flexDirection: 'row', alignItems: 'center', gap: 8 }, fileIconWell: { width: 48, height: 48, minWidth: 48, flexShrink: 0, borderRadius: 6, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, uploadText: { minWidth: 0, flex: 1, gap: 2 }, uploadName: { fontSize: 12, fontWeight: '700' }, uploadMeta: { fontSize: 10.5 }, uploadActionSpacer: { width: 44, height: 44, flexShrink: 0 }, uploadBusy: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000066' }, uploadError: { position: 'absolute', right: 3, bottom: 3, width: 19, height: 19, borderRadius: 10, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  previewModal: { flex: 1 }, previewHeader: { minHeight: FULLSCREEN_HEADER_MIN_HEIGHT, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: FULLSCREEN_HEADER_GUTTER, flexDirection: 'row', alignItems: 'center', gap: 8 }, previewTitle: { minWidth: 0, flex: 1, fontSize: 14, fontWeight: '700' }, previewImage: { flex: 1, margin: 12 },
  targetPickerSafe: { flex: 1 },
  targetPickerGrabber: { width: 38, height: 5, marginTop: 8, marginBottom: 3, borderRadius: 3, backgroundColor: '#8e8e9380', alignSelf: 'center' },
  targetPickerPanel: { flex: 1, width: '100%', alignSelf: 'center' }, targetPickerPanelTablet: { maxWidth: 760 },
  targetPickerHeader: { minHeight: 70, paddingLeft: 16, paddingRight: 10, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10 },
  targetPickerHeading: { minWidth: 0, flex: 1, gap: 3 }, targetPickerTitle: { fontSize: 18, fontWeight: '800' }, targetPickerSubtitle: { fontSize: 12.5 },
  targetSearch: { height: 46, marginHorizontal: 12, marginTop: 12, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  targetSearchInput: { minWidth: 0, flex: 1, height: 44, paddingVertical: 0, fontSize: 15 },
  targetLimitWarning: { minHeight: 40, marginHorizontal: 12, marginBottom: 8, paddingVertical: 6 },
  targetList: { paddingHorizontal: 12, paddingBottom: 20, gap: 7 }, targetListEmpty: { flexGrow: 1 },
  targetRow: { minHeight: 66, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 }, targetRowTablet: { minHeight: 74, paddingHorizontal: 14 },
  targetBackend: { width: 40, height: 40, flexShrink: 0, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  targetIdentity: { minWidth: 0, flex: 1, gap: 3 }, targetTitle: { fontSize: 14, fontWeight: '700' }, targetMeta: { fontSize: 10.5 },
  targetStatus: { minHeight: 25, maxWidth: 104, borderRadius: 7, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' }, targetStatusText: { fontSize: 10.5, fontWeight: '700' },
  targetEmpty: { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 7, padding: 24 }, targetEmptyTitle: { fontSize: 17, fontWeight: '700' }, targetEmptyBody: { maxWidth: 300, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  queue: { minWidth: 0, gap: 5 }, queueHeader: { minHeight: 44, minWidth: 0, paddingHorizontal: 10, gap: 7, flexDirection: 'row', alignItems: 'center', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  queueHeaderRow: { minWidth: 0, flexDirection: 'row', alignItems: 'stretch', gap: 5 }, queueHeaderToggle: { flex: 1 },
  queueReviewButton: { minWidth: 64, minHeight: 44, paddingHorizontal: 8, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  queueReviewSafe: { flex: 1, minHeight: 0 }, queueReviewHeader: { minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  queueReviewTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '700' },
  queueReviewScroll: { flex: 1, flexGrow: 1, maxHeight: undefined, paddingHorizontal: 12 },
  queueRecovery: { gap: 6, paddingVertical: 8, alignItems: 'flex-start' },
  queueHeading: { fontSize: 13, fontWeight: '600', flexShrink: 0 }, queueSummary: { flex: 1, minWidth: 0, fontSize: 12 },
  queueScroll: { flexGrow: 0, maxHeight: 180 }, queuePreview: { minWidth: 0 }, queuePreviewActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  queueMessageScroll: { flexGrow: 0, maxHeight: 144 },
  queueStatus: { minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 7 }, queueStatusText: { minWidth: 0, flex: 1, paddingVertical: 8, fontSize: 11.5, lineHeight: 16 },
  queueList: { gap: 5 },
  queueRow: { minHeight: 44, minWidth: 0, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingTop: 6, gap: 4 }, queuePrompt: { width: '100%', minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: 6 }, queueText: { fontSize: 12.5, lineHeight: 17 }, queueInput: { width: '100%', minHeight: 52, maxHeight: 144, fontSize: 12.5, lineHeight: 17, paddingVertical: 6 }, queueActions: { minHeight: 44, width: '100%', flexDirection: 'row', alignItems: 'center' }, runNow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 7 },
  queueEditActions: { minHeight: 50, width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  queueEditButton: { minWidth: 82, height: 44, borderRadius: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, queueEditButtonText: { fontSize: 12, fontWeight: '800' },
})
