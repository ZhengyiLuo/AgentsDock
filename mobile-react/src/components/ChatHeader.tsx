import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ArrowLeft, Ellipsis, PanelRight, RefreshCw, Search } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { runtimeSummary } from '../lib/format'
import { IconButton, Pill } from './ui'

export function ChatHeader({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(value => value.id === sessionId))
  const connected = useAppStore(state => state.connected)
  const syncSessionId = useAppStore(state => state.syncSessionId)
  const syncStatus = useAppStore(state => state.syncStatus)
  const reconnect = useAppStore(state => state.reconnect)
  const syncSelectedSession = useAppStore(state => state.syncSelectedSession)
  if (!session) return null
  const selectedStatus = syncSessionId === sessionId ? syncStatus : 'cached'
  const status = !connected ? 'offline' : selectedStatus
  const statusLabel = status === 'live' ? 'Live'
    : status === 'syncing' ? 'Syncing'
      : status === 'reconnecting' ? 'Retrying'
        : status === 'error' ? 'Sync paused'
          : status === 'offline' ? 'Offline'
            : 'Cached'
  const statusColor = status === 'live' ? colors.green
    : status === 'error' || status === 'offline' ? colors.red
      : status === 'syncing' || status === 'reconnecting' ? colors.orange
        : colors.muted
  const isSpinning = status === 'syncing' || status === 'reconnecting'
  const handleStatusPress = () => {
    if (!connected) void reconnect()
    else if (status === 'error' || status === 'reconnecting' || status === 'cached') void syncSelectedSession('manual')
    else onOptions()
  }
  return <View style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
    {compact ? <IconButton icon={ArrowLeft} onPress={onBack} label="Chats" /> : null}
    <View style={styles.titleWrap}><Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{session.title}</Text><Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>{runtimeSummary(session)}{session.session_id || session.codex_thread_id || session.claude_session_id ? ` · session ${(session.session_id || session.codex_thread_id || session.claude_session_id)?.slice(0, 12)}` : ''}</Text></View>
    <IconButton icon={RefreshCw} onPress={() => void syncSelectedSession('manual')} label="Refresh" />
    <IconButton icon={Search} onPress={onSearch} label="Find in chat" />
    {!compact ? <IconButton icon={PanelRight} onPress={onToggleInspector} label="Toggle details" /> : null}
    <Pressable testID="chat-details" accessibilityRole="button" accessibilityLabel={`${statusLabel}. ${status === 'live' ? 'Open chat details' : 'Retry chat sync'}`} onPress={handleStatusPress} style={[styles.online, { backgroundColor: colors.raised }]}>
      {isSpinning ? <ActivityIndicator size="small" color={statusColor} style={styles.spinner} /> : <View style={[styles.dot, { backgroundColor: statusColor }]} />}
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>{statusLabel}</Text>
      <Ellipsis size={14} color={colors.muted} />
    </Pressable>
  </View>
}

const styles = StyleSheet.create({
  root: { height: 68, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4 },
  titleWrap: { flex: 1, minWidth: 0, paddingLeft: 4 }, title: { fontSize: 16, fontWeight: '800' }, subtitle: { fontSize: 10.5, marginTop: 3 },
  online: { minHeight: 32, borderRadius: 6, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  spinner: { width: 9, height: 9, transform: [{ scale: 0.65 }] },
})
