import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, ActivityIndicator, BackHandler, Linking, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import * as Notifications from 'expo-notifications'
import { useShallow } from 'zustand/react/shallow'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { AlertCircle, Settings, X } from 'lucide-react-native'
import { trackEvent } from '../lib/analytics'
import { dismissAppKeyboard, useAppKeyboardLifecycle } from '../lib/app-keyboard'
import { chatWorkspaceLayout } from '../lib/chat-layout'
import { isServerSetupRequired, shouldPresentServerSetup } from '../lib/first-launch'
import { fullscreenModalTopPadding } from '../lib/fullscreen-modal-layout'
import { profileNamespace } from '../lib/server-profiles'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { ChatScreen } from './ChatScreen'
import { ClaudeMcpDialog } from './ClaudeMcpDialog'
import { AndroidUpdateCoordinator } from './AndroidUpdater'
import { Text } from './AppText'
import { CodeReview } from './CodeReview'
import { DigestDialog, JobDialog, ProcessDialog, SearchDialog, ServerSetupDialog, SettingsDialog, TmuxDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { ServerProfilesSheet, type ServerProfileListItem } from './ServerProfiles'
import { TerminalView } from './TerminalView'
import { TeamNetwork } from './TeamNetwork'
import { EmptyState, IconButton, Loading, SheetCloseButton } from './ui'
import { isWelcomeSession, welcomeWorkspacePatch } from '../lib/welcome-session'
import { FileViewerProvider } from './file-viewer/FileViewerHost'
import { useFileViewer } from './file-viewer/FileViewerContext'

type InspectorAction = {
  kind: 'digest' | 'job' | 'terminal' | 'processes' | 'tmux'
  jobId?: string
}

const IOS_INSPECTOR_HANDOFF_FALLBACK_MS = 1_000

export function AppShell() {
  return <FileViewerProvider><AppShellContent /></FileViewerProvider>
}

function AppShellContent() {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { closeViewer, setPresentationBlocked } = useFileViewer()
  const { width, height } = useWindowDimensions()
  useAppKeyboardLifecycle()
  const initialized = useAppStore(state => state.initialized)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const serverConfigured = useAppStore(state => state.serverConfigured)
  const serverURL = useAppStore(state => state.serverURL)
  const selectedId = useAppStore(state => state.selectedSessionId)
  const selected = useAppStore(useShallow(state => {
    const session = state.sessions.find(value => value.id === state.selectedSessionId)
    return session ? {
      id: session.id,
      title: session.title,
      backend: session.backend,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
    } : null
  }))
  const error = useAppStore(state => state.error)
  const clearError = useAppStore(state => state.clearError)
  const pendingServerUpdate = useAppStore(state => state.pendingServerUpdate)
  const cancelingServerUpdate = useAppStore(state => state.cancelingServerUpdate)
  const cancelPendingServerUpdate = useAppStore(state => state.cancelPendingServerUpdate)
  const initialize = useAppStore(state => state.initialize)
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const testServerProfile = useAppStore(state => state.testServerProfile)
  const createServerProfile = useAppStore(state => state.createServerProfile)
  const updateServerProfile = useAppStore(state => state.updateServerProfile)
  const removeServerProfile = useAppStore(state => state.removeServerProfile)
  const reorderServerProfiles = useAppStore(state => state.reorderServerProfiles)
  const switchServerProfile = useAppStore(state => state.switchServerProfile)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [settings, setSettings] = useState(false)
  const [teamNetwork, setTeamNetwork] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(true)
  const setupNextMode = useRef<'edit-active' | null>(null)
  const [servers, setServers] = useState<'manage' | 'add' | 'edit-active' | null>(null)
  const quickChatInFlight = useRef(false)
  const [options, setOptions] = useState(false)
  const [search, setSearch] = useState(false)
  const [digest, setDigest] = useState(false)
  const [jobEditor, setJobEditor] = useState<string | 'new' | null>(null)
  const [processes, setProcesses] = useState(false)
  const [tmux, setTmux] = useState(false)
  const [mcpSessionId, setMcpSessionId] = useState<string | null>(null)
  const [terminal, setTerminal] = useState(false)
  const [reviewRun, setReviewRun] = useState<string | null>(null)
  const pendingInspectorAction = useRef<InspectorAction | null>(null)
  const pendingInspectorFallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [modalGeneration, setModalGeneration] = useState(profileGeneration)
  const modalScopeCurrent = modalGeneration === profileGeneration
  const chatLayout = chatWorkspaceLayout(width, height)
  const compact = chatLayout.compact
  const showInspector = chatLayout.inlineInspectorAvailable && inspectorVisible
  const serverProfileItems = useMemo<ServerProfileListItem[]>(() => profiles.map(profile => ({
    id: profile.id,
    name: profile.name,
    serverUrl: profile.serverURL,
    serverIdentity: profile.serverIdentity,
    hasAccessToken: profile.hasAccessToken,
    serverSetupComplete: profile.serverConfigured,
    connectionState: profile.connectionState,
    cachedUnreadCount: profile.cachedUnreadCount,
    lastConnectionError: profile.lastConnectionError,
    serverVersion: profile.serverVersion,
  })), [profiles])
  const showServerSetup = shouldPresentServerSetup({ initialized, connected, serverConfigured, serverURL, setupDismissed })
  const canCancelPendingServerUpdate = pendingServerUpdate?.profileId === activeProfileId
    && pendingServerUpdate.profileGeneration === profileGeneration
    && pendingServerUpdate.canCancel
  const cancelCurrentServerUpdate = useCallback(async () => {
    const canceled = await cancelPendingServerUpdate(profileGeneration)
    if (canceled) {
      AccessibilityInfo.announceForAccessibility('Scheduled server update canceled. You can send your message now.')
    }
  }, [cancelPendingServerUpdate, profileGeneration])
  const openMobileChat = useCallback(() => {
    setMobileChatOpen(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const closeMobileChat = useCallback(() => {
    setMobileChatOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openServers = useCallback((mode: 'manage' | 'add') => {
    setServers(mode)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const closeServers = useCallback(() => {
    setServers(null)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openSettings = useCallback(() => {
    setSettings(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openTeamNetwork = useCallback(() => {
    setTeamNetwork(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openClaudeMcp = useCallback((sessionId: string) => {
    setMcpSessionId(sessionId)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const quickNewChat = useCallback(async () => {
    if (quickChatInFlight.current) return
    quickChatInFlight.current = true
    try {
      const created = await useAppStore.getState().quickCreateSession(profileGeneration)
      if (created) {
        trackEvent('chat_created')
        if (compact) setMobileChatOpen(true)
        requestAnimationFrame(dismissAppKeyboard)
      }
    } finally {
      quickChatInFlight.current = false
    }
  }, [compact, profileGeneration])
  const openOptions = useCallback(() => {
    setPresentationBlocked(true)
    setOptions(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [setPresentationBlocked])
  const closeOptions = useCallback(() => {
    setOptions(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openSearch = useCallback(() => {
    // Preserve the existing keyboard while the page sheet is published. Its
    // onShow handler transfers focus directly to the search field, avoiding a
    // hide/show race that can make UIKit drop or mis-size the presentation.
    setSearch(true)
    trackEvent('search_opened')
  }, [])
  const openReview = useCallback((runId: string) => {
    setReviewRun(runId)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const closeReview = useCallback(() => {
    setReviewRun(null)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openInspectorAction = useCallback((kind: 'digest' | 'job' | 'terminal' | 'processes' | 'tmux', jobId?: string) => {
    if (kind === 'digest') { setDigest(true); trackEvent('digest_opened') }
    else if (kind === 'job') { setJobEditor(jobId ?? 'new'); trackEvent('job_schedule_opened') }
    else if (kind === 'terminal') { setTerminal(true); trackEvent('terminal_opened') }
    else if (kind === 'processes') setProcesses(true)
    else setTmux(true)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const clearInspectorFallback = useCallback(() => {
    if (pendingInspectorFallback.current == null) return
    clearTimeout(pendingInspectorFallback.current)
    pendingInspectorFallback.current = null
  }, [])
  const finishOptionsDismissal = useCallback(() => {
    clearInspectorFallback()
    setPresentationBlocked(false)
    const action = pendingInspectorAction.current
    pendingInspectorAction.current = null
    if (action) openInspectorAction(action.kind, action.jobId)
  }, [clearInspectorFallback, openInspectorAction, setPresentationBlocked])
  const queueInspectorAction = useCallback((kind: InspectorAction['kind'], jobId?: string) => {
    clearInspectorFallback()
    pendingInspectorAction.current = { kind, jobId }
    closeOptions()
    if (Platform.OS !== 'ios') {
      requestAnimationFrame(finishOptionsDismissal)
      return
    }
    // UIKit normally acknowledges the page-sheet dismissal through onDismiss.
    // Keep an exactly-once fallback for interrupted native transitions so a
    // queued inspector action cannot remain inert forever.
    pendingInspectorFallback.current = setTimeout(() => {
      pendingInspectorFallback.current = null
      finishOptionsDismissal()
    }, IOS_INSPECTOR_HANDOFF_FALLBACK_MS)
  }, [clearInspectorFallback, closeOptions, finishOptionsDismissal])
  const closeTerminal = useCallback(() => {
    setTerminal(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const switchServer = useCallback(async (profileId: string) => {
    dismissAppKeyboard()
    try {
      const success = await switchServerProfile(profileId)
      trackEvent('server_switched', { success })
      return success
    } catch (error) {
      trackEvent('server_switched', { success: false })
      throw error
    }
  }, [switchServerProfile])

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
      if (/:\/\/terminal(?:[/?#]|$)/i.test(url)) openInspectorAction('terminal')
    }
    const subscription = Linking.addEventListener('url', openDeepLink)
    void Linking.getInitialURL().then(url => { if (url) openDeepLink({ url }) })
    return () => subscription.remove()
  }, [openInspectorAction])
  const finishSetupDismissal = useCallback(() => {
    const nextMode = setupNextMode.current
    setupNextMode.current = null
    if (nextMode) setServers(nextMode)
  }, [])
  useEffect(() => {
    if (!profileGeneration) return
    clearInspectorFallback()
    dismissAppKeyboard()
    setMobileChatOpen(false)
    setSettings(false)
    setTeamNetwork(false)
    setOptions(false)
    setSearch(false)
    setDigest(false)
    setJobEditor(null)
    setProcesses(false)
    setTmux(false)
    setMcpSessionId(null)
    setTerminal(false)
    setReviewRun(null)
    pendingInspectorAction.current = null
    closeViewer()
    setPresentationBlocked(false)
    setModalGeneration(profileGeneration)
  }, [clearInspectorFallback, closeViewer, profileGeneration, setPresentationBlocked])
  useEffect(() => clearInspectorFallback, [clearInspectorFallback])
  useEffect(() => {
    setMcpSessionId(current => current === selectedId ? current : null)
  }, [selectedId])
  useEffect(() => {
    let handledIdentifier: string | null = null
    let notificationIntent = 0
    const openNotification = async (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier
      if (identifier === handledIdentifier) return
      handledIdentifier = identifier
      const intent = ++notificationIntent
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined)
      const data = response.notification.request.content.data ?? {}
      const profileId = typeof data.profileId === 'string' ? data.profileId : null
      const serverIdentity = typeof data.serverIdentity === 'string' ? data.serverIdentity : null
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null
      if (!profileId || !serverIdentity || !sessionId) return
      await useAppStore.getState().initialize()
      if (intent !== notificationIntent) return
      const before = useAppStore.getState()
      const target = before.profiles.find(profile => profile.id === profileId)
      if (!target || profileNamespace(target) !== serverIdentity) return
      if ((before.activeProfileId !== profileId || before.switchingProfileId) && !await before.switchServerProfile(profileId)) return
      if (intent !== notificationIntent) return
      let current = useAppStore.getState()
      let currentTarget = current.profiles.find(profile => profile.id === profileId)
      if (current.activeProfileId !== profileId || current.switchingProfileId || !currentTarget || profileNamespace(currentTarget) !== serverIdentity) return
      if (!current.sessions.some(session => session.id === sessionId)) await current.refreshSessions()
      if (intent !== notificationIntent) return
      current = useAppStore.getState()
      currentTarget = current.profiles.find(profile => profile.id === profileId)
      if (current.activeProfileId !== profileId || current.switchingProfileId || !currentTarget || profileNamespace(currentTarget) !== serverIdentity || !current.sessions.some(session => session.id === sessionId)) return
      await useAppStore.getState().selectSession(sessionId)
      if (intent !== notificationIntent) return
      current = useAppStore.getState()
      currentTarget = current.profiles.find(profile => profile.id === profileId)
      if (current.activeProfileId !== profileId || current.switchingProfileId || current.selectedSessionId !== sessionId || !currentTarget || profileNamespace(currentTarget) !== serverIdentity) return
      openMobileChat()
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(response => { void openNotification(response).catch(() => undefined) })
    void Notifications.getLastNotificationResponseAsync().then(response => { if (response) void openNotification(response).catch(() => undefined) })
    return () => subscription.remove()
  }, [openMobileChat])

  useEffect(() => {
    if (!initialized) return
    const needsSetup = isServerSetupRequired({ serverConfigured, serverURL })
    const patch = welcomeWorkspacePatch(useAppStore.getState(), needsSetup)
    if (patch) useAppStore.setState(patch)
  }, [initialized, serverConfigured, serverURL])

  if (!initialized) return <View style={[styles.fill, { backgroundColor: colors.background }]}><Loading label="Starting AgentsDock" /></View>

  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const sidebar = <Sidebar key={`sidebar:${connectionKey}`} profiles={serverProfileItems} activeProfileId={activeProfileId} switchingProfileId={switchingProfileId} onSwitchServer={switchServer} onAddServer={() => openServers('add')} onManageServers={() => openServers('manage')} onSettings={openSettings} onTeamNetwork={openTeamNetwork} onNewChat={() => void quickNewChat()} onOpenChat={() => { trackEvent('chat_opened'); openMobileChat() }} />
  const chat = selected
    ? <ChatScreen key={`${connectionKey}:${selected.id}`} sessionId={selected.id} compact={compact} inlineInspectorAvailable={chatLayout.inlineInspectorAvailable} onBack={closeMobileChat} onOptions={openOptions} onSearch={openSearch} onToggleInspector={() => setInspectorVisible(value => !value)} onReview={openReview} onSetupServer={() => openServers('add')} onOpenMcp={() => openClaudeMcp(selected.id)} />
    : <NoChat connecting={connecting} onSettings={() => openServers('manage')} />

  return <View style={[styles.fill, { backgroundColor: colors.background }]}>
    <AndroidUpdateCoordinator />
    {error && !showServerSetup ? <View testID="global-error-slot" style={styles.errorSlot}><View style={[styles.error, { backgroundColor: colors.surface, borderColor: colors.red }]}><AlertCircle size={17} color={colors.red} /><View style={styles.errorContent}><Text style={[styles.errorText, { color: colors.text }]} numberOfLines={canCancelPendingServerUpdate ? 4 : 3}>{error}</Text>{canCancelPendingServerUpdate ? <Pressable accessibilityRole="button" accessibilityLabel="Cancel scheduled server update" accessibilityHint="Cancels the pending update so messages can be sent again" accessibilityState={{ disabled: cancelingServerUpdate, busy: cancelingServerUpdate }} testID="error-cancel-server-update" disabled={cancelingServerUpdate} onPress={() => { void cancelCurrentServerUpdate() }} style={({ pressed }) => [styles.errorAction, { backgroundColor: colors.raised, borderColor: colors.border, opacity: cancelingServerUpdate ? 0.45 : pressed ? 0.68 : 1 }]}>{cancelingServerUpdate ? <ActivityIndicator size="small" color={colors.blue} /> : <Text style={[styles.errorActionText, { color: colors.blue }]}>Cancel update</Text>}</Pressable> : null}</View>{!canCancelPendingServerUpdate ? <IconButton icon={Settings} size={15} onPress={openSettings} label="Settings" testID="error-settings" /> : null}<IconButton icon={X} size={15} onPress={clearError} disabled={cancelingServerUpdate} label="Dismiss" testID="error-dismiss" /></View></View> : null}
    {compact ? <View style={styles.fill}>{sidebar}{modalScopeCurrent && mobileChatOpen && selected ? <MobileChatPane width={width} backgroundColor={colors.background} onClose={closeMobileChat}>{chat}</MobileChatPane> : null}</View> : <View style={styles.workspace}><View style={{ width: width >= 1180 ? 285 : 255 }}>{sidebar}</View><View style={styles.chat}>{chat}</View>{showInspector && selected && !isWelcomeSession(selected.id) ? <View style={{ width: Math.min(350, width * 0.29) }}><Inspector key={`inspector:${connectionKey}:${selected.id}`} sessionId={selected.id} onDigest={() => openInspectorAction('digest')} onJob={jobId => openInspectorAction('job', jobId)} onTerminal={() => openInspectorAction('terminal')} onProcesses={() => openInspectorAction('processes')} onTmux={() => openInspectorAction('tmux')} /></View> : null}</View>}

    <ServerSetupDialog
      visible={showServerSetup}
      onClose={() => {
        setupNextMode.current = null
        setSetupDismissed(true)
      }}
      onConfigure={() => {
        setupNextMode.current = 'edit-active'
        setSetupDismissed(true)
        if (Platform.OS !== 'ios') requestAnimationFrame(finishSetupDismissal)
      }}
      onDidDismiss={finishSetupDismissal}
    />
    <ServerProfilesSheet
      key={`servers:${servers ?? 'closed'}`}
      visible={servers != null}
      initialMode={servers ?? 'manage'}
      profiles={serverProfileItems}
      activeProfileId={activeProfileId}
      switchingProfileId={switchingProfileId}
      onClose={closeServers}
      onSwitchProfile={switchServer}
      onTestConnection={async input => {
        try {
          const health = await testServerProfile({ profileId: input.profileId, serverURL: input.serverUrl, accessToken: input.accessToken })
          trackEvent('connection_tested', { success: health.ok === true })
          const version = health.server_version ?? health.version
          return { ok: health.ok, server_identity: health.server_identity ?? null, version: typeof version === 'string' ? version : null }
        } catch (error) {
          trackEvent('connection_tested', { success: false })
          throw error
        }
      }}
      onCreateProfile={async input => {
        try {
          const created = await createServerProfile({
            name: input.name,
            serverURL: input.serverUrl,
            accessToken: input.accessToken,
            serverIdentity: input.serverIdentity,
            serverConfigured: input.serverSetupComplete,
            setActive: false,
          })
          trackEvent('server_added', { success: true })
          return created
        } catch (error) {
          trackEvent('server_added', { success: false })
          throw error
        }
      }}
      onUpdateProfile={(profileId, patch) => updateServerProfile(profileId, {
        name: patch.name,
        serverURL: patch.serverUrl,
        accessToken: patch.accessToken,
        serverIdentity: patch.serverIdentity,
        resetServerIdentity: patch.resetServerIdentity,
      })}
      onReorderProfiles={reorderServerProfiles}
      onRemoveProfile={removeServerProfile}
    />
    <SettingsDialog key={`settings:${connectionKey}`} visible={modalScopeCurrent && settings} onClose={() => setSettings(false)} />
    <TeamNetwork key={`team-network:${connectionKey}`} visible={modalScopeCurrent && teamNetwork} onClose={() => setTeamNetwork(false)} />
    <ClaudeMcpDialog key={`claude-mcp:${connectionKey}:${mcpSessionId ?? 'closed'}`} visible={modalScopeCurrent && mcpSessionId != null && mcpSessionId === selected?.id} sessionId={mcpSessionId} onClose={() => setMcpSessionId(null)} />
    <SearchDialog visible={modalScopeCurrent && search && !isWelcomeSession(selected?.id)} sessionId={selected?.id} onClose={() => setSearch(false)} />
    <DigestDialog visible={modalScopeCurrent && digest} source={selected} onClose={() => setDigest(false)} />
    <JobDialog key={`job:${connectionKey}:${selected?.id ?? 'none'}`} visible={modalScopeCurrent && jobEditor != null} session={selected} jobId={jobEditor === 'new' ? null : jobEditor} onClose={() => setJobEditor(null)} />
    <ProcessDialog key={`processes:${connectionKey}:${selected?.id ?? 'none'}`} visible={modalScopeCurrent && processes} sessionId={selected?.id ?? null} onClose={() => setProcesses(false)} />
    <TmuxDialog visible={modalScopeCurrent && tmux} sessionId={selected?.id ?? null} onClose={() => setTmux(false)} />
    <CodeReview sessionId={selected?.id ?? ''} runId={modalScopeCurrent ? reviewRun : null} onClose={closeReview} />
    <Modal visible={modalScopeCurrent && options && Boolean(selected) && !isWelcomeSession(selected?.id)} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={closeOptions} onDismiss={finishOptionsDismissal}>{selected && !isWelcomeSession(selected.id) ? <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['bottom']}><View style={styles.modalGrabber} /><View style={styles.modalTop}><Text style={[styles.modalTitle, { color: colors.text }]}>Chat details</Text><SheetCloseButton onPress={closeOptions} label="Close chat details" testID="chat-details-close" /></View><Inspector key={`options-inspector:${connectionKey}:${selected.id}`} sessionId={selected.id} onDigest={() => queueInspectorAction('digest')} onJob={jobId => queueInspectorAction('job', jobId)} onTerminal={() => queueInspectorAction('terminal')} onProcesses={() => queueInspectorAction('processes')} onTmux={() => queueInspectorAction('tmux')} onFileViewerRequested={closeOptions} /></SafeAreaView> : null}</Modal>
    {modalScopeCurrent && terminal && selected && !isWelcomeSession(selected.id) ? <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={closeTerminal}><SafeAreaView
      testID="terminal-modal"
      style={[styles.fill, {
        backgroundColor: colors.background,
        // A native full-screen Modal has its own root and can report a zero top
        // inset through SafeAreaView. Keep the toolbar below the status area
        // using the inset captured by AppShell's persistent provider.
        paddingTop: fullscreenModalTopPadding(insets, Platform.OS),
      }]}
      edges={['right', 'bottom', 'left']}
    ><TerminalView session={selected} onClose={closeTerminal} /></SafeAreaView></Modal> : null}
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
      if (shouldClose) {
        // Navigation state must not depend on an animation completion callback:
        // iOS can cancel it while backgrounding and leave this absolute pane
        // mounted over the visible selector. Resolve the navigation now.
        translateX.value = width
        runOnJS(onClose)()
        return
      }
      translateX.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.cubic) })
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
  return <View style={styles.fill}>{connecting ? <Loading label="Connecting to agent server" /> : <><EmptyState title="No chat selected" body="Choose a chat from the sidebar or connect to a server." /><Pressable accessibilityRole="button" accessibilityLabel="Connection settings" onPress={onSettings} style={[styles.connectionSettings, { backgroundColor: colors.raised, borderColor: colors.border }]}><Settings size={15} color={colors.muted} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Connection settings</Text></Pressable></>}</View>
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, workspace: { flex: 1, flexDirection: 'row' }, chat: { flex: 1, minWidth: 0 }, mobileChatPane: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2 },
  errorSlot: { flexShrink: 0, paddingHorizontal: 12, paddingVertical: 8 },
  error: { width: '100%', minHeight: 50, maxWidth: 740, alignSelf: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorContent: { flex: 1, minWidth: 0, paddingVertical: 3, gap: 4 }, errorText: { fontSize: 12 },
  errorAction: { minHeight: 44, alignSelf: 'flex-start', minWidth: 112, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' }, errorActionText: { fontSize: 12, fontWeight: '800' },
  modalGrabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, borderRadius: 3, backgroundColor: '#8a8a8a88' }, modalTop: { minHeight: 64, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center' }, modalTitle: { flex: 1, fontSize: 16, fontWeight: '800' }, connectionSettings: { position: 'absolute', alignSelf: 'center', top: '58%', minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
})
