import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { ArrowLeft, Ellipsis, FolderOpen, PanelRight, RefreshCw, Search, Server } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { runtimeSummary } from '../lib/format'
import { isWelcomeSession } from '../lib/welcome-session'
import { Text } from './AppText'
import { CodexContextIndicator, CodexStatusButton } from './CodexControls'
import { ClaudeContextIndicator } from './ClaudeContextIndicator'
import { IconButton } from './ui'

export function ChatHeader({ sessionId, compact, onBack, onOptions, onSearch, onFiles, onToggleInspector, onSetupServer }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onFiles: () => void; onToggleInspector: () => void; onSetupServer: () => void }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(value => value.id === sessionId))
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const syncSessionId = useAppStore(state => state.syncSessionId)
  const syncStatus = useAppStore(state => state.syncStatus)
  const syncError = useAppStore(state => state.syncError)
  const syncRetryAttempt = useAppStore(state => state.syncRetryAttempt)
  const retryConnection = useAppStore(state => state.retryConnection)
  if (!session) return null
  if (isWelcomeSession(sessionId)) return <View style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
    {compact ? <IconButton icon={ArrowLeft} onPress={onBack} label="Chats" /> : null}
    <Image source={require('../../assets/icon.png')} contentFit="contain" style={styles.welcomeIcon} />
    <View style={styles.titleWrap}><Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>Welcome to AgentsDock</Text><Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>Local guide · no server connected</Text></View>
    <Pressable testID="welcome-setup-server" accessibilityRole="button" accessibilityLabel="Set up your server" onPress={onSetupServer} style={({ pressed }) => [styles.setup, { backgroundColor: colors.blue, opacity: pressed ? 0.72 : 1 }]}><Server size={16} color="white" /><Text style={styles.setupText}>Set up</Text></Pressable>
  </View>
  const selectedStatus = syncSessionId === sessionId ? syncStatus : 'cached'
  const status = !connected ? (connecting ? 'reconnecting' : 'offline') : selectedStatus
  const statusLabel = status === 'live' ? 'Live'
    : status === 'syncing' ? 'Syncing'
      : status === 'reconnecting' ? (syncRetryAttempt > 0 ? `Retrying ${syncRetryAttempt}/6` : 'Retrying')
        : status === 'error' ? (syncRetryAttempt > 0 ? `Retry ${syncRetryAttempt}/6` : 'Sync paused')
          : status === 'offline' ? 'Offline'
            : 'Cached'
  const statusColor = status === 'live' ? colors.green
    : status === 'error' || status === 'offline' ? colors.red
      : status === 'syncing' || status === 'reconnecting' ? colors.orange
        : colors.muted
  const isSpinning = status === 'syncing' || status === 'reconnecting'
  const visibleSyncError = status !== 'live' && syncError ? syncError.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  const handleStatusPress = () => {
    if (status === 'live') onOptions()
    else void retryConnection()
  }
  return <View style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
    {compact ? <IconButton icon={ArrowLeft} onPress={onBack} label="Chats" /> : null}
    <View style={styles.titleWrap}><Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{session.title}</Text><Text style={[styles.subtitle, { color: visibleSyncError ? colors.orange : colors.muted }]} numberOfLines={1}>{visibleSyncError || `${runtimeSummary(session)}${session.session_id || session.codex_thread_id || session.claude_session_id || session.cursor_session_id ? ` · session ${(session.session_id || session.codex_thread_id || session.claude_session_id || session.cursor_session_id)?.slice(0, 12)}` : ''}`}</Text></View>
    {!compact ? <IconButton icon={RefreshCw} onPress={() => void retryConnection()} label="Refresh" /> : null}
    <IconButton icon={Search} onPress={onSearch} label="Find in chat" />
    <IconButton icon={FolderOpen} onPress={onFiles} label="Browse workspace files" testID="chat-workspace-files" />
    {!compact ? <IconButton icon={PanelRight} onPress={onToggleInspector} label="Toggle details" /> : null}
    <CodexContextIndicator />
    <ClaudeContextIndicator />
    <CodexStatusButton compact={compact} />
    <Pressable testID="chat-details" accessibilityRole="button" accessibilityLabel={`${statusLabel}. ${syncError ? `${syncError}. ` : ''}${status === 'live' ? 'Open chat details' : 'Retry chat sync'}`} onPress={handleStatusPress} style={[styles.online, compact && styles.onlineCompact, { backgroundColor: colors.raised }]}>
      {isSpinning ? <ActivityIndicator size="small" color={statusColor} style={styles.spinner} /> : <View style={[styles.dot, { backgroundColor: statusColor }]} />}
      <Text style={[styles.statusLabel, { color: colors.text }]} numberOfLines={1}>{statusLabel}</Text>
      {!compact ? <Ellipsis size={14} color={colors.muted} /> : null}
    </Pressable>
  </View>
}

const styles = StyleSheet.create({
  root: { minHeight: 68, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  titleWrap: { flex: 1, minWidth: 0, paddingLeft: 4 }, title: { fontSize: 16, fontWeight: '800' }, subtitle: { fontSize: 10.5, marginTop: 3 },
  online: { minHeight: 44, borderRadius: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 },
  onlineCompact: { minWidth: 78, paddingHorizontal: 9 },
  statusLabel: { fontSize: 11, fontWeight: '700', flexShrink: 0 },
  dot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
  spinner: { width: 20, height: 20, flexShrink: 0 },
  welcomeIcon: { width: 32, height: 32, borderRadius: 7, flexShrink: 0 },
  setup: { minHeight: 44, borderRadius: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 },
  setupText: { color: 'white', fontSize: 12, fontWeight: '800' },
})
