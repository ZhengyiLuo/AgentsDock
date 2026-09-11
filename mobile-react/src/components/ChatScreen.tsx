import { useEffect, useReducer, useState } from 'react'
import { AppState, Keyboard, Platform, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView, KeyboardController } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { initialIOSKeyboardLifecycle, IOS_KEYBOARD_HIDE_FALLBACK_MS, reduceIOSKeyboardLifecycle } from '../lib/keyboard-lifecycle'
import { usePalette } from '../theme'
import { ChatHeader } from './ChatHeader'
import { ClaudeInteractionShelf } from './ClaudeInteractionShelf'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { CodexInteractionShelf } from './CodexInteractionShelf'
import { CodexRuntimeProvider } from './CodexRuntimeContext'
import { Composer } from './Composer'
import { Timeline } from './Timeline'
import { RuntimeHealthNotice } from './RuntimeHealth'
import { useAppStore } from '../store/useAppStore'
import { trackEvent } from '../lib/analytics'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { isWelcomeSession } from '../lib/welcome-session'
import { useFileViewer } from './file-viewer/FileViewerContext'

export function ChatScreen({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector, onReview, onSetupServer, onOpenMcp }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void; onReview: (runId: string) => void; onSetupServer: () => void; onOpenMcp: () => void }) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { openWorkspace } = useFileViewer()
  const welcome = isWelcomeSession(sessionId)
  const [scrollRequest, setScrollRequest] = useState(0)
  const [nonIOSKeyboardVisible, setNonIOSKeyboardVisible] = useState(() => Platform.OS !== 'ios' && KeyboardController.isVisible())
  const [iosKeyboard, dispatchIOSKeyboard] = useReducer(reduceIOSKeyboardLifecycle, AppState.currentState === 'active', initialIOSKeyboardLifecycle)
  const keyboardVisible = Platform.OS === 'ios' ? iosKeyboard.visible : nonIOSKeyboardVisible
  // During interactive iOS dismissal, `visible` clears at willHide while the
  // keyboard-avoidance frame remains active until didHide. Keep the composer
  // in its constrained layout for that full interval so its rails cannot grow
  // into the still keyboard-reduced viewport and hide the toolbar.
  const composerKeyboardConstrained = Platform.OS === 'ios' ? iosKeyboard.avoidanceEnabled : keyboardVisible
  const [keyboardSettleRequest, setKeyboardSettleRequest] = useState(0)
  const backend = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.backend)
  useEffect(() => {
    let hideFallbackTimer: ReturnType<typeof setTimeout> | null = null
    const cancelHideFallback = () => {
      if (hideFallbackTimer != null) clearTimeout(hideFallbackTimer)
      hideFallbackTimer = null
    }
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      if (Platform.OS === 'ios') {
        cancelHideFallback()
        dispatchIOSKeyboard({ type: 'keyboard-will-show' })
      } else {
        setNonIOSKeyboardVisible(true)
        setKeyboardSettleRequest(value => value + 1)
      }
    })
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      if (Platform.OS === 'ios') {
        dispatchIOSKeyboard({ type: 'keyboard-will-hide' })
      } else {
        setNonIOSKeyboardVisible(false)
        setKeyboardSettleRequest(value => value + 1)
      }
      if (Platform.OS === 'ios') {
        cancelHideFallback()
        hideFallbackTimer = setTimeout(() => {
          hideFallbackTimer = null
          dispatchIOSKeyboard({ type: 'keyboard-hide-timeout' })
          setKeyboardSettleRequest(value => value + 1)
        }, IOS_KEYBOARD_HIDE_FALLBACK_MS)
      }
    })
    const didShow = Platform.OS === 'ios' ? Keyboard.addListener('keyboardDidShow', () => {
      cancelHideFallback()
      dispatchIOSKeyboard({ type: 'keyboard-did-show' })
      setKeyboardSettleRequest(value => value + 1)
    }) : null
    const didHide = Platform.OS === 'ios' ? Keyboard.addListener('keyboardDidHide', () => {
      cancelHideFallback()
      dispatchIOSKeyboard({ type: 'keyboard-did-hide' })
      setKeyboardSettleRequest(value => value + 1)
    }) : null
    const appState = AppState.addEventListener('change', state => {
      // iOS can skip its keyboard hide notification while backgrounding. The
      // persistent app shell and native app delegate both end editing whenever
      // the scene resigns active, so revoke avoidance geometry on that exact
      // transition instead of waiting for a hide completion that may not come.
      if (Platform.OS === 'ios') {
        if (state !== 'active') cancelHideFallback()
        if (state === 'active' || state === 'inactive' || state === 'background') {
          dispatchIOSKeyboard({ type: 'app-state', status: state })
        }
        if (state === 'active') setKeyboardSettleRequest(value => value + 1)
      } else if (state !== 'active') setNonIOSKeyboardVisible(false)
    })
    return () => {
      cancelHideFallback()
      show.remove()
      hide.remove()
      didShow?.remove()
      didHide?.remove()
      appState.remove()
    }
  }, [])
  const content = (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ChatHeader sessionId={sessionId} compact={compact} onBack={onBack} onOptions={onOptions} onSearch={onSearch} onFiles={() => { trackEvent('open_file_clicked'); dismissAppKeyboard(); openWorkspace(sessionId) }} onToggleInspector={onToggleInspector} onSetupServer={onSetupServer} />
      {!welcome && backend ? <RuntimeHealthNotice backend={backend} sessionId={sessionId} /> : null}
      <KeyboardAvoidingView
            style={styles.body}
            behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
            enabled={Platform.OS !== 'ios' || iosKeyboard.avoidanceEnabled}
            // Expo's edge-to-edge Android root deliberately preserves the full
            // window instead of applying adjustResize padding. Measure this
            // chat body in screen coordinates and shrink it by the actual IME
            // overlap so the absolute mobile pane cannot remain under the
            // keyboard. iOS keeps its explicit, deterministic safe-area offset.
            automaticOffset={Platform.OS === 'android'}
            // App.tsx lays this view out below the top safe area, while iOS reports
            // keyboard frames in full-screen coordinates. Correct that offset or
            // the composer toolbar can remain underneath the keyboard on notched
            // and Dynamic Island phones.
            keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
          >
            <View style={styles.timeline}>
              <Timeline sessionId={sessionId} scrollRequest={scrollRequest} keyboardVisible={keyboardVisible} keyboardSettleRequest={keyboardSettleRequest} bottomInset={0} onReview={onReview} />
            </View>
            {!welcome ? <CodexInteractionShelf /> : null}
            {!welcome ? <ClaudeInteractionShelf /> : null}
            <View
              style={[styles.composerDock, {
                paddingBottom: Platform.OS === 'ios'
                  ? iosKeyboard.avoidanceEnabled ? 0 : insets.bottom
                  : keyboardVisible ? 0 : insets.bottom,
              }]}
            >
              <Composer sessionId={sessionId} keyboardVisible={composerKeyboardConstrained} onSent={() => setScrollRequest(value => value + 1)} onOpenMcp={onOpenMcp} />
            </View>
      </KeyboardAvoidingView>
    </View>
  )
  if (welcome) return content
  return <CodexRuntimeProvider sessionId={sessionId}><ClaudeRuntimeProvider sessionId={sessionId}>{content}</ClaudeRuntimeProvider></CodexRuntimeProvider>
}
const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  timeline: { flex: 1, minHeight: 0, overflow: 'hidden' },
  composerDock: { flexShrink: 0 },
})
