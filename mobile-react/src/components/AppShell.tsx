import { useEffect, useState } from 'react'
import { Linking, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { AlertCircle, PanelRight, Settings, X } from 'lucide-react-native'
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
  const { width } = useWindowDimensions()
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
  const compact = width < 720
  const showInspector = !compact && width >= 1080 && inspectorVisible
  const selected = sessions.find(value => value.id === selectedId) ?? null

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => { if (!selectedId) setMobileChatOpen(false) }, [selectedId])
  useEffect(() => {
    const openDeepLink = ({ url }: { url: string }) => {
      if (/:\/\/terminal(?:[/?#]|$)/i.test(url)) setTerminal(true)
    }
    const subscription = Linking.addEventListener('url', openDeepLink)
    void Linking.getInitialURL().then(url => { if (url) openDeepLink({ url }) })
    return () => subscription.remove()
  }, [])

  if (!initialized) return <View style={[styles.fill, { backgroundColor: colors.background }]}><Loading label="Starting AgentsDock" /></View>

  const sidebar = <Sidebar onSettings={() => setSettings(true)} onNewChat={() => setNewChat(true)} onOpenChat={() => setMobileChatOpen(true)} />
  const chat = selected ? <ChatScreen sessionId={selected.id} compact={compact} onBack={() => setMobileChatOpen(false)} onOptions={() => setOptions(true)} onSearch={() => setSearch(true)} onToggleInspector={() => setInspectorVisible(value => !value)} onReview={setReviewRun} /> : <NoChat connecting={connecting} onSettings={() => setSettings(true)} />

  return <View style={[styles.fill, { backgroundColor: colors.background }]}>
    {compact ? (mobileChatOpen && selected ? chat : sidebar) : <View style={styles.workspace}><View style={{ width: width >= 1180 ? 285 : 255 }}>{sidebar}</View><View style={styles.chat}>{chat}</View>{showInspector && selected ? <View style={{ width: Math.min(350, width * 0.29) }}><Inspector sessionId={selected.id} onDigest={() => setDigest(true)} onJob={jobId => setJobEditor(jobId ?? 'new')} onTerminal={() => setTerminal(true)} onProcesses={() => setProcesses(true)} onTmux={() => setTmux(true)} /></View> : null}</View>}
    {!compact && selected && !showInspector ? <Pressable onPress={() => setInspectorVisible(true)} style={[styles.restoreInspector, { backgroundColor: colors.raised, borderColor: colors.border }]}><PanelRight size={17} color={colors.muted} /></Pressable> : null}
    {error ? <View style={[styles.error, { backgroundColor: colors.surface, borderColor: colors.red }]}><AlertCircle size={17} color={colors.red} /><Text style={[styles.errorText, { color: colors.text }]} numberOfLines={3}>{error}</Text><IconButton icon={Settings} size={15} onPress={() => setSettings(true)} label="Settings" /><IconButton icon={X} size={15} onPress={clearError} label="Dismiss" /></View> : null}

    <SettingsDialog visible={settings} onClose={() => setSettings(false)} />
    <NewChatDialog visible={newChat} onClose={() => setNewChat(false)} />
    <SearchDialog visible={search} sessionId={selected?.id} onClose={() => setSearch(false)} />
    <DigestDialog visible={digest} source={selected} onClose={() => setDigest(false)} />
    <JobDialog visible={jobEditor != null} session={selected} jobId={jobEditor === 'new' ? null : jobEditor} onClose={() => setJobEditor(null)} />
    <ProcessDialog visible={processes} sessionId={selected?.id ?? null} onClose={() => setProcesses(false)} />
    <TmuxDialog visible={tmux} sessionId={selected?.id ?? null} onClose={() => setTmux(false)} />
    <CodeReview sessionId={selected?.id ?? ''} runId={reviewRun} onClose={() => setReviewRun(null)} />
    <Modal visible={options && Boolean(selected)} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOptions(false)}>{selected ? <View style={[styles.fill, { backgroundColor: colors.background }]}><View style={styles.modalTop}><Text style={[styles.modalTitle, { color: colors.text }]}>Chat details</Text><IconButton icon={X} onPress={() => setOptions(false)} label="Close" /></View><Inspector sessionId={selected.id} onDigest={() => { setOptions(false); setDigest(true) }} onJob={jobId => { setOptions(false); setJobEditor(jobId ?? 'new') }} onTerminal={() => { setOptions(false); setTerminal(true) }} onProcesses={() => { setOptions(false); setProcesses(true) }} onTmux={() => { setOptions(false); setTmux(true) }} /></View> : null}</Modal>
    <Modal visible={terminal && Boolean(selected)} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setTerminal(false)}>{selected ? <TerminalView session={selected} onClose={() => setTerminal(false)} /> : null}</Modal>
  </View>
}

function NoChat({ connecting, onSettings }: { connecting: boolean; onSettings: () => void }) {
  const colors = usePalette()
  return <View style={styles.fill}>{connecting ? <Loading label="Connecting to agent server" /> : <><EmptyState title="No chat selected" body="Choose a chat from the sidebar or connect to a server." /><Pressable onPress={onSettings} style={[styles.connectionSettings, { backgroundColor: colors.raised, borderColor: colors.border }]}><Settings size={15} color={colors.muted} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Connection settings</Text></Pressable></>}</View>
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, workspace: { flex: 1, flexDirection: 'row' }, chat: { flex: 1, minWidth: 0 },
  restoreInspector: { position: 'absolute', top: 17, right: 10, width: 35, height: 35, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  error: { position: 'absolute', left: 12, right: 12, bottom: 12, minHeight: 50, maxWidth: 740, alignSelf: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 }, errorText: { flex: 1, fontSize: 12 },
  modalTop: { height: 54, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' }, modalTitle: { flex: 1, fontSize: 16, fontWeight: '800' }, connectionSettings: { position: 'absolute', alignSelf: 'center', top: '58%', minHeight: 38, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
})
