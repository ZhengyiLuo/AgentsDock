import { useEffect, useMemo, useState } from 'react'
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronDown, ChevronRight, Plus, Search, Settings } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session } from '../types'
import { isUnread, runtimeSummary } from '../lib/format'
import { BackendMark } from './BackendMark'
import { IconButton } from './ui'

type Row = { kind: 'header'; key: string; title: string; folder: string; count: number } | { kind: 'session'; key: string; session: Session }

export function Sidebar({ onSettings, onNewChat, onOpenChat }: { onSettings: () => void; onNewChat: () => void; onOpenChat?: () => void }) {
  const colors = usePalette()
  const sessions = useAppStore(state => state.sessions)
  const selected = useAppStore(state => state.selectedSessionId)
  const active = useAppStore(state => state.activeSessionIds)
  const folderOrder = useAppStore(state => state.folderOrder)
  const searchResults = useAppStore(state => state.searchResults)
  const searchBusy = useAppStore(state => state.searchBusy)
  const search = useAppStore(state => state.search)
  const clearSearch = useAppStore(state => state.clearSearch)
  const select = useAppStore(state => state.selectSession)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['Archived']))

  useEffect(() => {
    const timer = setTimeout(() => { if (query.trim()) void search(query); else clearSearch() }, 260)
    return () => clearTimeout(timer)
  }, [clearSearch, query, search])

  const rows = useMemo(() => {
    const matchedByContent = new Set(searchResults.map(value => value.session_id))
    const clean = query.trim().toLowerCase()
    const filtered = clean
      ? sessions.filter(session => session.title.toLowerCase().includes(clean) || matchedByContent.has(session.id))
          .sort((a, b) => Number(b.title.toLowerCase().includes(clean)) - Number(a.title.toLowerCase().includes(clean)))
      : sessions
    const groups = new Map<string, Session[]>()
    for (const session of filtered) {
      const folder = session.archived ? 'Archived' : session.pinned ? 'Pinned' : session.folder?.trim() || 'General'
      groups.set(folder, [...(groups.get(folder) ?? []), session])
    }
    const orderedFolders = ['Pinned', ...folderOrder, ...[...groups.keys()].filter(folder => !['Pinned', 'Archived'].includes(folder) && !folderOrder.includes(folder)).sort(), 'General', 'Archived']
      .filter((value, index, values) => values.indexOf(value) === index && groups.has(value))
    return orderedFolders.flatMap<Row>(folder => {
      const values = [...(groups.get(folder) ?? [])].sort(sessionOrder)
      return [
        { kind: 'header', key: `header:${folder}`, title: folder, folder, count: values.length },
        ...((collapsed.has(folder) ? [] : values.map(session => ({ kind: 'session' as const, key: session.id, session })))),
      ]
    })
  }, [collapsed, folderOrder, query, searchResults, sessions])

  return (
    <View style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>AgentsDock</Text>
        <View style={styles.actions}><IconButton icon={Plus} onPress={onNewChat} label="New chat" /><IconButton icon={Settings} onPress={onSettings} label="Settings" /></View>
      </View>
      <View style={[styles.search, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Search size={16} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats and history"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          style={[styles.searchInput, { color: colors.text }]}
        />
        {searchBusy ? <Text style={{ color: colors.muted }}>…</Text> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={item => item.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        renderItem={({ item }) => item.kind === 'header' ? (
          <Pressable onPress={() => setCollapsed(value => { const next = new Set(value); if (next.has(item.folder)) next.delete(item.folder); else next.add(item.folder); return next })} style={styles.header}>
            {collapsed.has(item.folder) ? <ChevronRight size={13} color={colors.muted} /> : <ChevronDown size={13} color={colors.muted} />}
            <Text style={[styles.headerText, { color: colors.muted }]}>{item.title}</Text>
            <Text style={[styles.count, { color: colors.muted }]}>{item.count}</Text>
          </Pressable>
        ) : (
          <SessionRow
            session={item.session}
            selected={selected === item.session.id}
            running={active.has(item.session.id)}
            onPress={() => { void select(item.session.id); onOpenChat?.() }}
          />
        )}
      />
    </View>
  )
}

function SessionRow({ session, selected, running, onPress }: { session: Session; selected: boolean; running: boolean; onPress: () => void }) {
  const colors = usePalette()
  const unread = isUnread(session)
  const markRead = useAppStore(state => state.markRead)
  const markUnread = useAppStore(state => state.markUnread)
  const toggleReadState = () => { void (unread ? markRead(session.id) : markUnread(session.id)) }
  const showActions = () => {
    const action = unread ? 'Mark as read' : 'Mark as unread'
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [action, 'Cancel'], cancelButtonIndex: 1, title: session.title },
        index => { if (index === 0) toggleReadState() },
      )
      return
    }
    Alert.alert(session.title, undefined, [
      { text: action, onPress: toggleReadState },
      { text: 'Cancel', style: 'cancel' },
    ])
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={showActions}
      delayLongPress={360}
      style={({ pressed }) => [styles.session, { backgroundColor: selected ? colors.raised : pressed ? `${colors.raised}99` : 'transparent' }]}
    >
      <BackendMark backend={session.backend} size={22} />
      <View style={styles.sessionText}>
        <Text style={[styles.sessionTitle, { color: colors.text }]} numberOfLines={1}>{session.title}</Text>
        <Text style={[styles.sessionMeta, { color: unread ? colors.blue : colors.muted }]} numberOfLines={1}>
          {running ? `${runtimeSummary(session)} · running` : unread ? `${runtimeSummary(session)} · new` : runtimeSummary(session)}
        </Text>
      </View>
      <View style={[styles.statusDot, { backgroundColor: running ? colors.green : unread ? colors.blue : 'transparent' }]} />
    </Pressable>
  )
}

function sessionOrder(a: Session, b: Session): number {
  const left = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const right = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (left !== right) return left - right
  return (a.created_at ?? '').localeCompare(b.created_at ?? '')
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 250, borderRightWidth: StyleSheet.hairlineWidth },
  titleRow: { height: 54, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 15, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 2 },
  search: { height: 38, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  list: { paddingHorizontal: 6, paddingBottom: 24 },
  header: { height: 32, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerText: { flex: 1, fontSize: 11, fontWeight: '700' },
  count: { fontSize: 10 },
  session: { minHeight: 51, borderRadius: 6, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 9 },
  sessionText: { flex: 1, minWidth: 0 },
  sessionTitle: { fontSize: 13, fontWeight: '700' },
  sessionMeta: { marginTop: 2, fontSize: 10.5, fontWeight: '600' },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
})
