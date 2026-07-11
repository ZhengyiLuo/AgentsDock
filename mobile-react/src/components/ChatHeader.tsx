import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ArrowLeft, Ellipsis, PanelRight, RefreshCw, Search } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { runtimeSummary } from '../lib/format'
import { IconButton, Pill } from './ui'

export function ChatHeader({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(value => value.id === sessionId))
  const connected = useAppStore(state => state.connected)
  const reconnect = useAppStore(state => state.reconnect)
  if (!session) return null
  return <View style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
    {compact ? <IconButton icon={ArrowLeft} onPress={onBack} label="Chats" /> : null}
    <View style={styles.titleWrap}><Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{session.title}</Text><Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>{runtimeSummary(session)}{session.session_id || session.codex_thread_id || session.claude_session_id ? ` · session ${(session.session_id || session.codex_thread_id || session.claude_session_id)?.slice(0, 12)}` : ''}</Text></View>
    <IconButton icon={RefreshCw} onPress={() => void useAppStore.getState().selectSession(sessionId)} label="Refresh" />
    <IconButton icon={Search} onPress={onSearch} label="Find in chat" />
    {!compact ? <IconButton icon={PanelRight} onPress={onToggleInspector} label="Toggle details" /> : null}
    <Pressable onPress={connected ? onOptions : () => void reconnect()} style={[styles.online, { backgroundColor: colors.raised }]}><View style={[styles.dot, { backgroundColor: connected ? colors.green : colors.red }]} /><Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>{connected ? 'Online' : 'Offline'}</Text><Ellipsis size={14} color={colors.muted} /></Pressable>
  </View>
}

const styles = StyleSheet.create({
  root: { height: 68, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4 },
  titleWrap: { flex: 1, minWidth: 0, paddingLeft: 4 }, title: { fontSize: 16, fontWeight: '800' }, subtitle: { fontSize: 10.5, marginTop: 3 },
  online: { minHeight: 32, borderRadius: 6, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 7, height: 7, borderRadius: 4 },
})
