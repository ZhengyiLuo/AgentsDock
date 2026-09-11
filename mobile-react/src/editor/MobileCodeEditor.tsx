import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { Text } from '../components/AppText'
import { usePalette } from '../theme'
import { CODE_EDITOR_HTML } from './codeEditorAssets'
import { codeEditorLanguage, type CodeEditorLanguageDefinition } from './codeEditorLanguage'
import {
  CODE_EDITOR_NATIVE_SOURCE,
  CODE_EDITOR_PROTOCOL_VERSION,
  parseCodeEditorEngineMessage,
  serializeCodeEditorHostMessage,
  type CodeEditorExecuteAction,
  type CodeEditorHostCommand,
  type CodeEditorHostMessage,
  type CodeEditorViewState,
} from './codeEditorProtocol'
import { MobileCodeEditorToolbar } from './MobileCodeEditorToolbar'
import {
  DEFAULT_EDITOR_APPEARANCE,
  normalizeEditorAppearance,
  readEditorAppearance,
  writeEditorAppearance,
  type EditorAppearance,
  type EditorThemeId,
} from './editorAppearance'
import {
  acceptMobileCodeEditorMessage,
  createMobileCodeEditorMirror,
  markMobileCodeEditorClean,
  replaceMobileCodeEditorDocument,
  resetMobileCodeEditorEngine,
  type MobileCodeEditorMirror,
} from './mobileCodeEditorState'
import {
  cachedMobileCodeEditorViewState,
  rememberMobileCodeEditorViewState,
} from './mobileCodeEditorViewState'
import {
  MOBILE_CODE_EDITOR_BASE_URL,
  mobileCodeEditorNavigationAllowed,
} from './mobileCodeEditorSecurity'

const ACK_TIMEOUT_MS = 6_000
const INITIALIZATION_TIMEOUT_MS = 6_000
const MAX_ACK_ATTEMPTS = 2
const MAX_RECOVERY_ATTEMPTS = 2
const MAX_INITIALIZATION_RECOVERY_ATTEMPTS = 1
const RECOVERY_STABILITY_MS = 5_000
const PAD_TOOLBAR_MIN_WIDTH = 700

export type MobileCodeEditorPhase = 'loading' | 'ready' | 'recovering' | 'error' | 'fallback'

export interface MobileCodeEditorMetadata {
  path: string
  language: CodeEditorLanguageDefinition
  sequence: number
  dirty: boolean
  lines: number
  utf8Bytes: number
  viewState: CodeEditorViewState
}

export interface MobileCodeEditorSnapshot extends MobileCodeEditorMetadata {
  value: string
  content: string
}

export type EditorSnapshot = MobileCodeEditorSnapshot

export interface MobileCodeEditorStatus extends MobileCodeEditorMetadata {
  phase: MobileCodeEditorPhase
  ready: boolean
  focused: boolean
  recovering: boolean
  fallback: boolean
  error: string | null
  appearance: EditorAppearance
}

export interface MobileCodeEditorFallbackContext {
  reason: string
  snapshot: MobileCodeEditorSnapshot
  retry: () => void
}

export interface MobileCodeEditorController {
  flush(): Promise<MobileCodeEditorSnapshot>
  flushAndBlur(): Promise<MobileCodeEditorSnapshot>
  getSnapshot(): MobileCodeEditorSnapshot
  focus(): void
  blur(): void
  execute(action: CodeEditorExecuteAction, location?: { line?: number; column?: number }): void
  replaceDocument(value: string, options?: { clean?: boolean; viewState?: CodeEditorViewState }): void
  markClean(value?: string): void
  retry(): void
}

export type SyntaxEditorController = MobileCodeEditorController

export interface MobileCodeEditorProps {
  value: string
  path: string
  readOnly?: boolean
  maxBytes?: number
  initialViewState?: CodeEditorViewState
  theme?: EditorThemeId
  fontSize?: number
  autoFocus?: boolean
  showToolbar?: boolean
  style?: StyleProp<ViewStyle>
  testID?: string
  onChange?: (value: string, metadata: MobileCodeEditorMetadata) => void
  onStatusChange?: (status: MobileCodeEditorStatus) => void
  onViewStateChange?: (viewState: CodeEditorViewState) => void
  onAppearanceChange?: (appearance: EditorAppearance) => void
  onLimitExceeded?: (details: { maxBytes: number; attemptedBytes: number }) => void
  onError?: (error: Error) => void
  onExternalNavigationBlocked?: (url: string) => void
  onFallbackRequested?: (context: MobileCodeEditorFallbackContext) => void
  renderFallback?: (context: MobileCodeEditorFallbackContext) => ReactNode
}

interface PendingSnapshotRequest {
  requestId: string
  command: 'flush' | 'flushAndBlur'
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
  resolve: (snapshot: MobileCodeEditorSnapshot) => void
  reject: (error: Error) => void
}

type MobileCodeEditorRenderState = Omit<MobileCodeEditorMirror, 'content' | 'cleanContent'>

export class MobileCodeEditorAckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileCodeEditorAckError'
  }
}

export const MobileCodeEditor = forwardRef<MobileCodeEditorController, MobileCodeEditorProps>(function MobileCodeEditor({
  value,
  path,
  readOnly = false,
  maxBytes = 0,
  initialViewState,
  theme,
  fontSize,
  autoFocus = false,
  showToolbar = true,
  style,
  testID = 'mobile-code-editor',
  onChange,
  onStatusChange,
  onViewStateChange,
  onAppearanceChange,
  onLimitExceeded,
  onError,
  onExternalNavigationBlocked,
  onFallbackRequested,
  renderFallback,
}, forwardedRef) {
  const colors = usePalette()
  const window = useWindowDimensions()
  // Large documents must have one authoritative owner. Keeping the strings in a
  // ref prevents React from retaining a new multi-megabyte state object for each
  // CodeMirror transaction while status UI still updates from stripped metadata.
  const mirrorRef = useAuthoritativeMirrorRef(value, path, initialViewState)
  const [renderState, setRenderState] = useState<MobileCodeEditorRenderState>(() => renderStateFromMirror(mirrorRef.current))
  const pendingRenderStateRef = useRef<MobileCodeEditorRenderState | null>(null)
  const renderFrameRef = useRef<number | null>(null)
  const [appearance, setAppearance] = useState<EditorAppearance>(() => normalizeEditorAppearance({
    theme: theme ?? DEFAULT_EDITOR_APPEARANCE.theme,
    fontSize: fontSize ?? DEFAULT_EDITOR_APPEARANCE.fontSize,
  }))
  const appearanceRef = useRef(appearance)
  const [webViewKey, setWebViewKey] = useState(0)
  const activeWebViewGenerationRef = useRef(webViewKey)
  const [layoutWidth, setLayoutWidth] = useState(window.width)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const fallbackReasonRef = useRef<string | null>(fallbackReason)
  const webViewRef = useRef<WebView>(null)
  const outboundSequenceRef = useRef(0)
  const requestCounterRef = useRef(0)
  const pendingRequestsRef = useRef(new Map<string, PendingSnapshotRequest>())
  const engineInitializedRef = useRef(false)
  const initializationSentRef = useRef(false)
  const initializationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryAttemptsRef = useRef(0)
  const recoveryStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoverySnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryRequestIdRef = useRef<string | null>(null)
  const malformedMessagesRef = useRef(0)
  const disposedRef = useRef(false)
  const propDocumentRef = useRef({ path, value })
  const lastEmittedValueRef = useRef<string | null>(null)
  const livePropsRef = useRef({ path, readOnly, maxBytes, autoFocus })
  const onChangeRef = useRef(onChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  const onLimitExceededRef = useRef(onLimitExceeded)
  const onErrorRef = useRef(onError)
  const recoveryHandlerRef = useRef<(reason: string) => void>(() => undefined)

  livePropsRef.current = { path, readOnly, maxBytes, autoFocus }
  onChangeRef.current = onChange
  onViewStateChangeRef.current = onViewStateChange
  onLimitExceededRef.current = onLimitExceeded
  onErrorRef.current = onError
  appearanceRef.current = appearance
  fallbackReasonRef.current = fallbackReason

  const publicSnapshot = useCallback((source = mirrorRef.current): MobileCodeEditorSnapshot => ({
    value: source.content,
    content: source.content,
    path: livePropsRef.current.path,
    language: codeEditorLanguage(livePropsRef.current.path),
    sequence: source.sequence,
    dirty: source.dirty,
    lines: source.lines,
    utf8Bytes: source.utf8Bytes,
    viewState: source.viewState,
  }), [])

  const publishRenderState = useCallback((next: MobileCodeEditorMirror, coalesce: boolean) => {
    const stripped = renderStateFromMirror(next)
    if (!coalesce) {
      if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current)
      renderFrameRef.current = null
      pendingRenderStateRef.current = null
      setRenderState(stripped)
      return
    }
    pendingRenderStateRef.current = stripped
    if (renderFrameRef.current !== null) return
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = null
      const pending = pendingRenderStateRef.current
      pendingRenderStateRef.current = null
      if (pending && !disposedRef.current) setRenderState(pending)
    })
  }, [])

  const commitMirror = useCallback((next: MobileCodeEditorMirror, contentChanged = false, publishViewState = false) => {
    mirrorRef.current = next
    publishRenderState(next, contentChanged)
    if (publishViewState) {
      rememberMobileCodeEditorViewState(livePropsRef.current.path, next.viewState)
      onViewStateChangeRef.current?.(next.viewState)
    }
    if (contentChanged) {
      lastEmittedValueRef.current = next.content
      onChangeRef.current?.(next.content, metadataFromMirror(next, livePropsRef.current.path))
    }
  }, [publishRenderState])

  const nextRequestId = useCallback((prefix: string): string => {
    requestCounterRef.current += 1
    return `${prefix}-${Date.now().toString(36)}-${requestCounterRef.current.toString(36)}`
  }, [])

  const postCommand = useCallback((command: CodeEditorHostCommand, requestId?: string): boolean => {
    const target = webViewRef.current
    if (!target || disposedRef.current || fallbackReasonRef.current) return false
    outboundSequenceRef.current += 1
    const message: CodeEditorHostMessage = {
      source: CODE_EDITOR_NATIVE_SOURCE,
      version: CODE_EDITOR_PROTOCOL_VERSION,
      sequence: outboundSequenceRef.current,
      ...(requestId ? { requestId } : {}),
      command,
    }
    target.postMessage(serializeCodeEditorHostMessage(message))
    return true
  }, [])

  const documentCommand = useCallback((type: 'initialize' | 'replaceDocument'): CodeEditorHostCommand => {
    const current = mirrorRef.current
    const props = livePropsRef.current
    const document = {
      path: props.path,
      content: current.content,
      readOnly: props.readOnly,
      maxBytes: normalizedMaxBytes(props.maxBytes),
      viewState: current.viewState,
    }
    return type === 'initialize'
      ? { type, ...document, theme: appearanceRef.current.theme, fontSize: appearanceRef.current.fontSize }
      : { type, ...document }
  }, [])

  const clearInitializationTimeout = useCallback(() => {
    if (initializationTimerRef.current) clearTimeout(initializationTimerRef.current)
    initializationTimerRef.current = null
  }, [])

  const advanceWebViewGeneration = useCallback(() => {
    const nextGeneration = activeWebViewGenerationRef.current + 1
    // Fence the retiring WebView synchronously. Native callbacks can arrive
    // before React commits the keyed replacement.
    activeWebViewGenerationRef.current = nextGeneration
    setWebViewKey(nextGeneration)
  }, [])

  const enterFallback = useCallback((reason: string) => {
    if (fallbackReasonRef.current) return
    fallbackReasonRef.current = reason
    clearInitializationTimeout()
    engineInitializedRef.current = false
    initializationSentRef.current = false
    setFallbackReason(reason)
    for (const pending of pendingRequestsRef.current.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new MobileCodeEditorAckError(reason))
    }
    pendingRequestsRef.current.clear()
  }, [clearInitializationTimeout])

  const startRecovery = useCallback((reason: string) => {
    if (disposedRef.current || fallbackReasonRef.current) return
    clearInitializationTimeout()
    recoveryAttemptsRef.current += 1
    if (recoveryAttemptsRef.current > MAX_RECOVERY_ATTEMPTS) {
      enterFallback(reason)
      return
    }
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current)
    if (recoverySnapshotTimerRef.current) clearTimeout(recoverySnapshotTimerRef.current)
    recoveryStabilityTimerRef.current = null
    recoverySnapshotTimerRef.current = null
    recoveryRequestIdRef.current = null
    engineInitializedRef.current = false
    initializationSentRef.current = false
    outboundSequenceRef.current = 0
    malformedMessagesRef.current = 0
    commitMirror(resetMobileCodeEditorEngine(mirrorRef.current))
    advanceWebViewGeneration()
  }, [advanceWebViewGeneration, clearInitializationTimeout, commitMirror, enterFallback])
  recoveryHandlerRef.current = startRecovery

  const sendInitialize = useCallback((): boolean => {
    if (disposedRef.current || fallbackReasonRef.current || engineInitializedRef.current || initializationSentRef.current) return false
    const sent = postCommand(documentCommand('initialize'), nextRequestId('initialize'))
    if (sent) initializationSentRef.current = true
    return sent
  }, [documentCommand, nextRequestId, postCommand])

  const armInitializationTimeout = useCallback((generation: number) => {
    if (generation !== activeWebViewGenerationRef.current) return
    clearInitializationTimeout()
    if (disposedRef.current || fallbackReasonRef.current || engineInitializedRef.current) return
    initializationTimerRef.current = setTimeout(() => {
      initializationTimerRef.current = null
      if (generation !== activeWebViewGenerationRef.current || disposedRef.current || engineInitializedRef.current) return
      const reason = 'Editor did not finish loading.'
      if (recoveryAttemptsRef.current >= MAX_INITIALIZATION_RECOVERY_ATTEMPTS) {
        enterFallback(reason)
        return
      }
      recoveryHandlerRef.current(`${reason} Retrying once.`)
    }, INITIALIZATION_TIMEOUT_MS)
  }, [clearInitializationTimeout, enterFallback])

  // Native load callbacks are useful re-arm points, but WebKit is not allowed
  // to make the editor unbounded by omitting either callback.
  useEffect(() => {
    armInitializationTimeout(webViewKey)
    return clearInitializationTimeout
  }, [armInitializationTimeout, clearInitializationTimeout, webViewKey])

  const armPendingTimeout = useCallback((pending: PendingSnapshotRequest) => {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      pending.timer = null
      if (!pendingRequestsRef.current.has(pending.requestId)) return
      if (pending.attempts >= MAX_ACK_ATTEMPTS) {
        pendingRequestsRef.current.delete(pending.requestId)
        const error = new MobileCodeEditorAckError(`Editor did not acknowledge ${pending.command}.`)
        pending.reject(error)
        onErrorRef.current?.(error)
        enterFallback(error.message)
        return
      }
      recoveryHandlerRef.current(`Editor did not acknowledge ${pending.command}; recovering the editor process.`)
    }, ACK_TIMEOUT_MS)
  }, [enterFallback])

  const sendPendingRequest = useCallback((pending: PendingSnapshotRequest) => {
    if (!engineInitializedRef.current) {
      armPendingTimeout(pending)
      return
    }
    pending.attempts += 1
    if (postCommand({ type: pending.command }, pending.requestId)) armPendingTimeout(pending)
  }, [armPendingTimeout, postCommand])

  const drainPendingRequests = useCallback(() => {
    for (const pending of pendingRequestsRef.current.values()) sendPendingRequest(pending)
  }, [sendPendingRequest])

  const requestSnapshot = useCallback((command: 'flush' | 'flushAndBlur'): Promise<MobileCodeEditorSnapshot> => {
    if (fallbackReason) return Promise.reject(new MobileCodeEditorAckError(fallbackReason))
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId(command)
      const pending: PendingSnapshotRequest = { requestId, command, attempts: 0, timer: null, resolve, reject }
      pendingRequestsRef.current.set(requestId, pending)
      sendPendingRequest(pending)
    })
  }, [fallbackReason, nextRequestId, sendPendingRequest])

  const execute = useCallback((action: CodeEditorExecuteAction, location?: { line?: number; column?: number }) => {
    if (!engineInitializedRef.current) return
    postCommand({ type: 'execute', action, ...normalizedLocation(location) })
  }, [postCommand])

  const focus = useCallback(() => {
    if (engineInitializedRef.current) postCommand({ type: 'focus' })
  }, [postCommand])

  const blur = useCallback(() => {
    if (engineInitializedRef.current) postCommand({ type: 'blur' })
  }, [postCommand])

  const retry = useCallback(() => {
    clearInitializationTimeout()
    recoveryAttemptsRef.current = 0
    initializationSentRef.current = false
    fallbackReasonRef.current = null
    setFallbackReason(null)
    outboundSequenceRef.current = 0
    engineInitializedRef.current = false
    commitMirror(resetMobileCodeEditorEngine(mirrorRef.current))
    advanceWebViewGeneration()
  }, [advanceWebViewGeneration, clearInitializationTimeout, commitMirror])

  const replaceDocument = useCallback((content: string, options?: { clean?: boolean; viewState?: CodeEditorViewState }) => {
    let next = replaceMobileCodeEditorDocument(mirrorRef.current, content, options?.clean ?? true)
    if (options?.viewState) next = { ...next, viewState: options.viewState }
    commitMirror(next, false, Boolean(options?.viewState))
    if (engineInitializedRef.current) postCommand(documentCommand('replaceDocument'))
  }, [commitMirror, documentCommand, postCommand])

  const markClean = useCallback((content?: string) => {
    commitMirror(markMobileCodeEditorClean(mirrorRef.current, content))
  }, [commitMirror])

  useImperativeHandle(forwardedRef, () => ({
    flush: () => requestSnapshot('flush'),
    flushAndBlur: () => requestSnapshot('flushAndBlur'),
    getSnapshot: () => publicSnapshot(),
    focus,
    blur,
    execute,
    replaceDocument,
    markClean,
    retry,
  }), [blur, execute, focus, markClean, publicSnapshot, replaceDocument, requestSnapshot, retry])

  const handleEngineMessage = useCallback((event: WebViewMessageEvent, generation: number) => {
    if (generation !== activeWebViewGenerationRef.current) return
    const message = parseCodeEditorEngineMessage(event.nativeEvent.data)
    if (!message) {
      malformedMessagesRef.current += 1
      if (malformedMessagesRef.current >= 3) startRecovery('The editor bridge returned malformed messages.')
      return
    }
    malformedMessagesRef.current = 0
    const transition = acceptMobileCodeEditorMessage(mirrorRef.current, message)
    if (transition.needsSnapshot) {
      commitMirror(transition.mirror)
      if (!recoveryRequestIdRef.current && engineInitializedRef.current) {
        const requestId = nextRequestId('recover')
        recoveryRequestIdRef.current = requestId
        postCommand({ type: 'flush' }, requestId)
        recoverySnapshotTimerRef.current = setTimeout(() => {
          recoverySnapshotTimerRef.current = null
          if (recoveryRequestIdRef.current === requestId) {
            recoveryRequestIdRef.current = null
            startRecovery(`Editor ${transition.recoveryReason ?? 'sequence'} recovery timed out.`)
          }
        }, ACK_TIMEOUT_MS)
      }
      return
    }
    if (!transition.accepted) return

    const eventType = message.event.type
    const publishesViewState = eventType === 'initialized'
      || eventType === 'changed'
      || eventType === 'snapshot'
      || eventType === 'blurred'
    commitMirror(transition.mirror, transition.contentChanged, publishesViewState)

    if (eventType === 'ready') {
      engineInitializedRef.current = false
      sendInitialize()
      return
    }
    if (eventType === 'initialized') {
      clearInitializationTimeout()
      engineInitializedRef.current = true
      initializationSentRef.current = true
      if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current)
      recoveryStabilityTimerRef.current = setTimeout(() => {
        recoveryStabilityTimerRef.current = null
        recoveryAttemptsRef.current = 0
      }, RECOVERY_STABILITY_MS)
      drainPendingRequests()
      if (livePropsRef.current.autoFocus) postCommand({ type: 'focus' })
    }
    if (eventType === 'snapshot' || eventType === 'blurred') {
      if (recoveryRequestIdRef.current === message.requestId) {
        recoveryRequestIdRef.current = null
        if (recoverySnapshotTimerRef.current) clearTimeout(recoverySnapshotTimerRef.current)
        recoverySnapshotTimerRef.current = null
      }
      if (message.requestId) {
        const pending = pendingRequestsRef.current.get(message.requestId)
        if (pending) {
          pendingRequestsRef.current.delete(message.requestId)
          if (pending.timer) clearTimeout(pending.timer)
          pending.resolve(publicSnapshot(transition.mirror))
        }
      }
    }
    if (eventType === 'limitExceeded') {
      onLimitExceededRef.current?.({
        maxBytes: message.event.maxBytes,
        attemptedBytes: message.event.attemptedBytes,
      })
    }
    if (eventType === 'error') {
      onErrorRef.current?.(new Error(message.event.message))
    }
  }, [clearInitializationTimeout, commitMirror, drainPendingRequests, nextRequestId, postCommand, publicSnapshot, sendInitialize, startRecovery])

  const updateAppearance = useCallback((nextValue: EditorAppearance, persist = true) => {
    const next = normalizeEditorAppearance(nextValue)
    appearanceRef.current = next
    setAppearance(next)
    onAppearanceChange?.(next)
    if (persist) void writeEditorAppearance(next)
    if (engineInitializedRef.current) postCommand({ type: 'setAppearance', ...next })
  }, [onAppearanceChange, postCommand])

  useEffect(() => {
    if (theme !== undefined || fontSize !== undefined) {
      updateAppearance({
        theme: theme ?? appearanceRef.current.theme,
        fontSize: fontSize ?? appearanceRef.current.fontSize,
      }, false)
      return
    }
    let active = true
    void readEditorAppearance().then(stored => {
      if (active) updateAppearance(stored, false)
    })
    return () => { active = false }
  }, [fontSize, theme])

  useEffect(() => {
    const previous = propDocumentRef.current
    propDocumentRef.current = { path, value }
    if (previous.path !== path) {
      const viewState = initialViewState ?? cachedMobileCodeEditorViewState(path)
      const next = createMobileCodeEditorMirror(value, viewState)
      lastEmittedValueRef.current = null
      commitMirror(next, false, true)
      if (engineInitializedRef.current) postCommand(documentCommand('replaceDocument'))
      return
    }
    if (previous.value === value || value === mirrorRef.current.content || value === lastEmittedValueRef.current) return
    const next = replaceMobileCodeEditorDocument(mirrorRef.current, value, true)
    commitMirror(next)
    if (engineInitializedRef.current) postCommand(documentCommand('replaceDocument'))
  }, [commitMirror, documentCommand, initialViewState, path, postCommand, value])

  const previousReadOnlyRef = useRef(readOnly)
  useEffect(() => {
    if (previousReadOnlyRef.current === readOnly) return
    previousReadOnlyRef.current = readOnly
    if (engineInitializedRef.current) postCommand({ type: 'setReadOnly', readOnly })
  }, [postCommand, readOnly])

  const previousMaxBytesRef = useRef(maxBytes)
  useEffect(() => {
    if (previousMaxBytesRef.current === maxBytes) return
    previousMaxBytesRef.current = maxBytes
    if (engineInitializedRef.current) postCommand(documentCommand('replaceDocument'))
  }, [documentCommand, maxBytes, postCommand])

  useEffect(() => () => {
    disposedRef.current = true
    clearInitializationTimeout()
    if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current)
    renderFrameRef.current = null
    pendingRenderStateRef.current = null
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current)
    if (recoverySnapshotTimerRef.current) clearTimeout(recoverySnapshotTimerRef.current)
    for (const pending of pendingRequestsRef.current.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new MobileCodeEditorAckError('Editor was closed before its snapshot was acknowledged.'))
    }
    pendingRequestsRef.current.clear()
  }, [clearInitializationTimeout])

  const phase: MobileCodeEditorPhase = fallbackReason
    ? 'fallback'
    : renderState.recovering
      ? 'recovering'
      : renderState.error
        ? 'error'
        : renderState.initialized
          ? 'ready'
          : 'loading'
  const status = useMemo<MobileCodeEditorStatus>(() => ({
    ...metadataFromMirror(renderState, path),
    phase,
    ready: phase === 'ready' || phase === 'error',
    focused: renderState.focused,
    recovering: phase === 'recovering',
    fallback: phase === 'fallback',
    error: fallbackReason ?? renderState.error,
    appearance,
  }), [appearance, fallbackReason, path, phase, renderState])
  useEffect(() => { onStatusChange?.(status) }, [onStatusChange, status])

  const fallbackContext = useMemo<MobileCodeEditorFallbackContext | null>(() => fallbackReason ? {
    reason: fallbackReason,
    snapshot: publicSnapshot(),
    retry,
  } : null, [fallbackReason, publicSnapshot, retry])
  useEffect(() => {
    if (fallbackContext) onFallbackRequested?.(fallbackContext)
  }, [fallbackContext, onFallbackRequested])

  const source = useMemo(() => ({ html: CODE_EDITOR_HTML, baseUrl: MOBILE_CODE_EDITOR_BASE_URL }), [])
  const compactToolbar = layoutWidth < PAD_TOOLBAR_MIN_WIDTH
  const handleLayout = (event: LayoutChangeEvent) => setLayoutWidth(event.nativeEvent.layout.width)

  if (fallbackContext) {
    return <View testID={testID} onLayout={handleLayout} style={[styles.root, { backgroundColor: colors.background }, style]}>
      {renderFallback?.(fallbackContext) ?? <DefaultEditorFallback context={fallbackContext} />}
    </View>
  }

  return <View testID={testID} onLayout={handleLayout} style={[styles.root, { backgroundColor: colors.background }, style]}>
    {showToolbar ? <MobileCodeEditorToolbar
      compact={compactToolbar}
      ready={status.ready}
      readOnly={readOnly}
      appearance={appearance}
      onAppearanceChange={next => updateAppearance(next)}
      onExecute={action => execute(action)}
      onFocus={focus}
    /> : null}
    <View style={styles.webViewHost}>
      <WebView
        key={webViewKey}
        ref={webViewRef}
        testID="code-editor-webview"
        source={source}
        originWhitelist={['about:blank', 'https://agentsdock.local']}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        mixedContentMode="never"
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
        style={[styles.webView, { backgroundColor: colors.background }]}
        onLoadStart={() => {
          if (webViewKey !== activeWebViewGenerationRef.current) return
          engineInitializedRef.current = false
          initializationSentRef.current = false
          armInitializationTimeout(webViewKey)
        }}
        onLoadEnd={() => {
          if (webViewKey !== activeWebViewGenerationRef.current) return
          sendInitialize()
          armInitializationTimeout(webViewKey)
        }}
        onMessage={event => handleEngineMessage(event, webViewKey)}
        onShouldStartLoadWithRequest={request => {
          if (webViewKey !== activeWebViewGenerationRef.current) return false
          const allowed = mobileCodeEditorNavigationAllowed(request.url)
          if (!allowed) onExternalNavigationBlocked?.(request.url)
          return allowed
        }}
        onContentProcessDidTerminate={() => {
          if (webViewKey === activeWebViewGenerationRef.current) startRecovery('The editor process stopped unexpectedly.')
        }}
        onRenderProcessGone={() => {
          if (webViewKey === activeWebViewGenerationRef.current) startRecovery('The editor renderer stopped unexpectedly.')
        }}
        onError={event => {
          if (webViewKey !== activeWebViewGenerationRef.current) return
          const error = new Error(event.nativeEvent.description || 'The editor failed to load.')
          onErrorRef.current?.(error)
          startRecovery(error.message)
        }}
      />
      {phase === 'loading' || phase === 'recovering' ? <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={phase === 'recovering' ? 'Recovering editor' : 'Loading editor'}
        accessibilityLiveRegion="polite"
        accessibilityState={{ busy: true }}
        pointerEvents="auto"
        style={[styles.loadingOverlay, { backgroundColor: colors.background }]}
      >
        <Text style={[styles.loadingText, { color: colors.muted }]}>{phase === 'recovering' ? 'Recovering editor…' : 'Loading editor…'}</Text>
      </View> : null}
    </View>
    <EditorStatusBar status={status} />
  </View>
})

export const SyntaxEditor = MobileCodeEditor

function EditorStatusBar({ status }: { status: MobileCodeEditorStatus }) {
  const colors = usePalette()
  const size = formatByteCount(status.utf8Bytes)
  const state = status.recovering ? 'Recovering' : status.error ? 'Editor warning' : status.dirty ? 'Modified' : 'Saved'
  return <View testID="code-editor-status" style={[styles.statusBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.statusText, { color: colors.muted }]} numberOfLines={1}>{status.language.label}</Text>
    <View style={styles.statusSpacer} />
    <Text style={[styles.statusText, { color: colors.muted }]} numberOfLines={1}>{status.lines.toLocaleString()} {status.lines === 1 ? 'line' : 'lines'} · {size} · {state}</Text>
  </View>
}

function DefaultEditorFallback({ context }: { context: MobileCodeEditorFallbackContext }) {
  const colors = usePalette()
  return <View style={styles.fallback}>
    <Text style={[styles.fallbackTitle, { color: colors.text }]}>Editor unavailable</Text>
    <Text style={[styles.fallbackBody, { color: colors.muted }]}>{context.reason}</Text>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Retry code editor"
      testID="code-editor-retry"
      onPress={context.retry}
      style={({ pressed }) => [styles.retryButton, { backgroundColor: colors.blue, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={styles.retryText}>Retry</Text>
    </Pressable>
  </View>
}

function useAuthoritativeMirrorRef(
  value: string,
  path: string,
  initialViewState: CodeEditorViewState | undefined,
): { current: MobileCodeEditorMirror } {
  const ref = useRef<MobileCodeEditorMirror | null>(null)
  if (ref.current === null) {
    ref.current = createMobileCodeEditorMirror(
      value,
      initialViewState ?? cachedMobileCodeEditorViewState(path),
    )
  }
  return ref as { current: MobileCodeEditorMirror }
}

function renderStateFromMirror(mirror: MobileCodeEditorMirror): MobileCodeEditorRenderState {
  return {
    utf8Bytes: mirror.utf8Bytes,
    lines: mirror.lines,
    viewState: mirror.viewState,
    sequence: mirror.sequence,
    engineReady: mirror.engineReady,
    initialized: mirror.initialized,
    focused: mirror.focused,
    recovering: mirror.recovering,
    dirty: mirror.dirty,
    error: mirror.error,
  }
}

function metadataFromMirror(
  mirror: Pick<MobileCodeEditorMirror, 'sequence' | 'dirty' | 'lines' | 'utf8Bytes' | 'viewState'>,
  path: string,
): MobileCodeEditorMetadata {
  return {
    path,
    language: codeEditorLanguage(path),
    sequence: mirror.sequence,
    dirty: mirror.dirty,
    lines: mirror.lines,
    utf8Bytes: mirror.utf8Bytes,
    viewState: mirror.viewState,
  }
}

function normalizedMaxBytes(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 0
}

function normalizedLocation(location: { line?: number; column?: number } | undefined): { line?: number; column?: number } {
  const positive = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value : undefined
  const line = positive(location?.line)
  const column = positive(location?.column)
  return { ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

function formatByteCount(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.max(0.1, bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${Math.max(0.1, bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  webViewHost: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
  },
  webView: {
    flex: 1,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 12,
  },
  statusBar: {
    minHeight: 26,
    flexShrink: 0,
    paddingHorizontal: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusSpacer: {
    flex: 1,
  },
  statusText: {
    maxWidth: '72%',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  fallback: {
    flex: 1,
    minHeight: 180,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  fallbackTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  fallbackBody: {
    maxWidth: 360,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 96,
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
})
