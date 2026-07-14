import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BackHandler, Linking, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { AlertCircle, Settings, X } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { ChatScreen } from './ChatScreen'
import { CodeReview } from './CodeReview'
import { DigestDialog, JobDialog, NewChatDialog, ProcessDialog, SearchDialog, SettingsDialog, TmuxDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { TerminalView } from './TerminalView'
import { EmptyState, IconButton, Loading } from './ui'

export function AppShell() {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const initialized = useAppStore(state => state.initialized)
  const connecting = useAppStore(state => state.connecting)
  const sessions = useAppStore(state => state.sessions)
  const selectedId = useAppStore(state => state.selectedSessionId)
  const error = useAppStore(state => state.error)
  const clearError = useAppStore(state => state.clearError)
  const initialize = useAppStore(state => state.initialize)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [settings, setSettings] = useState(false)
  const [newChat, setNewChat] = useState(false)
  const [options, setOptions] = useState(false)
  const [search, setSearch] = useState(false)
  const [digest, setDigest] = useState(false)
  const [jobEditor, setJobEditor] = useState<string | 'new' | null>(null)
  const [processes, setProcesses] = useState(false)
  const [tmux, setTmux] = useState(false)
  const [terminal, setTerminal] = useState(false)
  const [reviewRun, setReviewRun] = useState<string | null>(null)
  const [pendingInspectorAction, setPendingInspectorAction] = useState<{ kind: 'digest' | 'job' | 'terminal' | 'processes' | 'tmux'; jobId?: string } | null>(null)
  // Keep phones in the stacked navigator when they rotate to landscape. Using
  // width alone rebuilt the entire workspace as an iPad layout mid-rotation.
  const compact = width < 720 || Math.min(width, height) < 600
  const showInspector = !compact && width >= 1080 && inspectorVisible
  const selected = sessions.find(value => value.id === selectedId) ?? null
  const openMobileChat = useCallback(() => setMobileChatOpen(true), [])
  const closeMobileChat = useCallback(() => setMobileChatOpen(false), [])

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => { if (!selectedId) setMobileChatOpen(false) }, [selectedId])
  useEffect(() => {
    if (!compact || !mobileChatOpen) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeMobileChat()
      return true
    })
    return () => subscription.remove()
  }, [closeMobileChat, compact, mobileChatOpen])
  useEffect(() => {
    const openDeepLink = ({ url }: { url: string }) => {
      if (/:\/\/terminal(?:[/?#]|$)/i.test(url)) setTerminal(true)
    }
    const subscription = Linking.addEventListener('url', openDeepLink)
    void Linking.getInitialURL().then(url => { if (url) openDeepLink({ url }) })
    return () => subscription.remove()
  }, [])
  useEffect(() => {
    if (options || !pendingInspectorAction) return
    const timer = setTimeout(() => {
      if (pendingInspectorAction.kind === 'digest') setDigest(true)
      else if (pendingInspectorAction.kind === 'job') setJobEditor(pendingInspectorAction.jobId ?? 'new')
      else if (pendingInspectorAction.kind === 'terminal') setTerminal(true)
      else if (pendingInspectorAction.kind === 'processes') setProcesses(true)
      else if (pendingInspectorAction.kind === 'tmux') setTmux(true)
      setPendingInspectorAction(null)
    }, Platform.OS === 'ios' ? 280 : 0)
    return () => clearTimeout(timer)
  }, [options, pendingInspectorAction])

  if (!initialized) return <View style={[styles.fill, { backgroundColor: colors.background }]}><Loading label="Starting AgentsDock" /></View>

  const sidebar = <Sidebar onSettings={() => setSettings(true)} onNewChat={() => setNewChat(true)} onOpenChat={openMobileChat} />
  const chat = selected ? <ChatScreen sessionId={selected.id} compact={compact} onBack={closeMobileChat} onOptions={() => setOptions(true)} onSearch={() => setSearch(true)} onToggleInspector={() => setInspectorVisible(value => !value)} onReview={setReviewRun} /> : <NoChat connecting={connecting} onSettings={() => setSettings(true)} />

  return <View style={[styles.fill, { backgroundColor: colors.background }]}>
    {compact ? <View style={styles.fill}>{sidebar}{mobileChatOpen && selected ? <MobileChatPane width={width} backgroundColor={colors.background} onClose={closeMobileChat}>{chat}</MobileChatPane> : null}</View> : <View style={styles.workspace}><View style={{ width: width >= 1180 ? 285 : 255 }}>{sidebar}</View><View style={styles.chat}>{chat}</View>{showInspector && selected ? <View style={{ width: Math.min(350, width * 0.29) }}><Inspector sessionId={selected.id} onDigest={() => setDigest(true)} onJob={jobId => setJobEditor(jobId ?? 'new')} onTerminal={() => setTerminal(true)} onProcesses={() => setProcesses(true)} onTmux={() => setTmux(true)} /></View> : null}</View>}
    {error ? <View style={[styles.error, { bottom: insets.bottom + 12, backgroundColor: colors.surface, borderColor: colors.red }]}><AlertCircle size={17} color={colors.red} /><Text style={[styles.errorText, { color: colors.text }]} numberOfLines={3}>{error}</Text><IconButton icon={Settings} size={15} onPress={() => setSettings(true)} label="Settings" testID="error-settings" /><IconButton icon={X} size={15} onPress={clearError} label="Dismiss" testID="error-dismiss" /></View> : null}

    <SettingsDialog visible={settings} onClose={() => setSettings(false)} />
    <NewChatDialog visible={newChat} onClose={() => setNewChat(false)} />
    <SearchDialog visible={search} sessionId={selected?.id} onClose={() => setSearch(false)} />
    <DigestDialog visible={digest} source={selected} onClose={() => setDigest(false)} />
    <JobDialog visible={jobEditor != null} session={selected} jobId={jobEditor === 'new' ? null : jobEditor} onClose={() => setJobEditor(null)} />
    <ProcessDialog visible={processes} sessionId={selected?.id ?? null} onClose={() => setProcesses(false)} />
    <TmuxDialog visible={tmux} sessionId={selected?.id ?? null} onClose={() => setTmux(false)} />
    <CodeReview sessionId={selected?.id ?? ''} runId={reviewRun} onClose={() => setReviewRun(null)} />
    <Modal visible={options && Boolean(selected)} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={() => setOptions(false)}>{selected ? <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['bottom']}><View style={styles.modalGrabber} /><View style={styles.modalTop}><Text style={[styles.modalTitle, { color: colors.text }]}>Chat details</Text><IconButton icon={X} onPress={() => setOptions(false)} label="Close" /></View><Inspector sessionId={selected.id} onDigest={() => { setPendingInspectorAction({ kind: 'digest' }); setOptions(false) }} onJob={jobId => { setPendingInspectorAction({ kind: 'job', jobId }); setOptions(false) }} onTerminal={() => { setPendingInspectorAction({ kind: 'terminal' }); setOptions(false) }} onProcesses={() => { setPendingInspectorAction({ kind: 'processes' }); setOptions(false) }} onTmux={() => { setPendingInspectorAction({ kind: 'tmux' }); setOptions(false) }} /></SafeAreaView> : null}</Modal>
    <Modal visible={terminal && Boolean(selected)} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={() => setTerminal(false)}>{selected ? <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['top', 'bottom']}><TerminalView session={selected} onClose={() => setTerminal(false)} /></SafeAreaView> : null}</Modal>
  </View>
}

function MobileChatPane({ children, width, backgroundColor, onClose }: { children: ReactNode; width: number; backgroundColor: string; onClose: () => void }) {
  const translateX = useSharedValue(0)
  useEffect(() => {
    translateX.value = 0
  }, [translateX, width])
  const edgeBackGesture = useMemo(() => Gesture.Pan()
    .hitSlop({ left: 0, width: 28 })
    .activeOffsetX(10)
    .failOffsetY([-18, 18])
    .onUpdate(event => {
      translateX.value = Math.min(width, Math.max(0, event.translationX))
    })
    .onEnd(event => {
      const shouldClose = event.translationX > width * 0.28 || (event.translationX > 24 && event.velocityX > 650)
      translateX.value = withTiming(shouldClose ? width : 0, {
        duration: shouldClose ? 170 : 140,
        easing: Easing.out(Easing.cubic),
      }, finished => {
        if (finished && shouldClose) runOnJS(onClose)()
      })
    })
    .onTouchesCancelled(() => {
      translateX.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.cubic) })
    }), [onClose, translateX, width])
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }))

  return <GestureDetector gesture={edgeBackGesture}>
    <Animated.View style={[styles.mobileChatPane, { backgroundColor }, animatedStyle]}>{children}</Animated.View>
  </GestureDetector>
}

function NoChat({ connecting, onSettings }: { connecting: boolean; onSettings: () => void }) {
  const colors = usePalette()
  return <View style={styles.fill}>{connecting ? <Loading label="Connecting to agent server" /> : <><EmptyState title="No chat selected" body="Choose a chat from the sidebar or connect to a server." /><Pressable onPress={onSettings} style={[styles.connectionSettings, { backgroundColor: colors.raised, borderColor: colors.border }]}><Settings size={15} color={colors.muted} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Connection settings</Text></Pressable></>}</View>
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, workspace: { flex: 1, flexDirection: 'row' }, chat: { flex: 1, minWidth: 0 }, mobileChatPane: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2 },
  error: { position: 'absolute', left: 12, right: 12, minHeight: 50, maxWidth: 740, alignSelf: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 }, errorText: { flex: 1, fontSize: 12 },
  modalGrabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, borderRadius: 3, backgroundColor: '#8a8a8a88' }, modalTop: { height: 54, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' }, modalTitle: { flex: 1, fontSize: 16, fontWeight: '800' }, connectionSettings: { position: 'absolute', alignSelf: 'center', top: '58%', minHeight: 38, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
})
