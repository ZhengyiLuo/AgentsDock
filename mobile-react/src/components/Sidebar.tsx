import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, FolderPlus, Pin, PinOff, Plus, RefreshCw, Search, Settings, Trash2, type LucideIcon } from 'lucide-react-native'
import Swipeable from 'react-native-gesture-handler/Swipeable'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session } from '../types'
import { isUnread, runtimeSummary } from '../lib/format'
import { compareSessions, orderedSessionSections, sessionSection } from '../lib/session-order'
import { BackendMark } from './BackendMark'
import { IconButton } from './ui'

type Row = { kind: 'header'; key: string; title: string; folder: string; count: number } | { kind: 'session'; key: string; session: Session }

export function Sidebar({ onSettings, onNewChat, onOpenChat }: { onSettings: () => void; onNewChat: () => void; onOpenChat?: () => void }) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const sessions = useAppStore(state => state.sessions)
  const selected = useAppStore(state => state.selectedSessionId)
  const active = useAppStore(state => state.activeSessionIds)
  const folderOrder = useAppStore(state => state.folderOrder)
  const searchResults = useAppStore(state => state.searchResults)
  const searchBusy = useAppStore(state => state.searchBusy)
  const search = useAppStore(state => state.search)
  const clearSearch = useAppStore(state => state.clearSearch)
  const select = useAppStore(state => state.selectSession)
  const reorder = useAppStore(state => state.reorderSession)
  const refreshSessions = useAppStore(state => state.refreshSessions)
  const setFolderOrder = useAppStore(state => state.setFolderOrder)
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
    return orderedSessionSections(filtered, folderOrder).flatMap<Row>(section => {
      const folder = section.id
      const values = section.sessions
      return [
        { kind: 'header', key: `header:${folder}`, title: folder, folder, count: values.length },
        ...((collapsed.has(folder) ? [] : values.map(session => ({ kind: 'session' as const, key: session.id, session })))),
      ]
    })
  }, [collapsed, folderOrder, query, searchResults, sessions])
  const reorderNeighbors = useMemo(() => {
    const groups = new Map<string, Session[]>()
    for (const session of sessions) {
      const section = sessionSection(session)
      groups.set(section, [...(groups.get(section) ?? []), session])
    }
    const result = new Map<string, { previousId: string | null; nextId: string | null }>()
    for (const values of groups.values()) {
      values.sort(compareSessions).forEach((session, index) => result.set(session.id, {
        previousId: values[index - 1]?.id ?? null,
        nextId: values[index + 1]?.id ?? null,
      }))
    }
    return result
  }, [sessions])
  const folders = useMemo(() => {
    const values = new Set(['General', ...folderOrder])
    for (const session of sessions) {
      const folder = session.folder?.trim()
      if (folder && !['Pinned', 'Archived'].includes(folder)) values.add(folder)
    }
    return [...values]
  }, [folderOrder, sessions])
  const movableFolders = useMemo(() => folders.filter(folder => folder !== 'General'), [folders])
  const createFolder = () => {
    Alert.prompt('New folder', 'Create a folder, then move chats into it from their long-press menu.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Create', onPress: (value?: string) => { const name = value?.trim(); if (name && !folders.includes(name)) setFolderOrder([...movableFolders, name]) } },
    ], 'plain-text')
  }
  const moveFolder = (folder: string, direction: 'up' | 'down') => {
    const order = [...movableFolders]
    const index = order.indexOf(folder)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    setFolderOrder(order)
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>AgentsDock</Text>
        <View style={styles.actions}><IconButton icon={RefreshCw} onPress={() => void refreshSessions()} label="Refresh chats" /><IconButton icon={FolderPlus} onPress={createFolder} label="New folder" /><IconButton icon={Plus} onPress={onNewChat} label="New chat" /><IconButton icon={Settings} onPress={onSettings} label="Settings" testID="sidebar-settings" /></View>
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
        renderItem={({ item }) => item.kind === 'header' ? <FolderHeader
          item={item}
          collapsed={collapsed.has(item.folder)}
          canMoveUp={movableFolders.indexOf(item.folder) > 0}
          canMoveDown={movableFolders.indexOf(item.folder) >= 0 && movableFolders.indexOf(item.folder) < movableFolders.length - 1}
          onToggle={() => setCollapsed(value => { const next = new Set(value); if (next.has(item.folder)) next.delete(item.folder); else next.add(item.folder); return next })}
          onMove={direction => moveFolder(item.folder, direction)}
        /> : (() => {
          const { previousId, nextId } = reorderNeighbors.get(item.session.id) ?? { previousId: null, nextId: null }
          return <SessionRow
            session={item.session}
            selected={selected === item.session.id}
            running={active.has(item.session.id)}
            folders={folders}
            canMoveUp={Boolean(previousId)}
            canMoveDown={Boolean(nextId)}
            onMoveUp={() => { if (previousId) void reorder(item.session.id, previousId, 'before') }}
            onMoveDown={() => { if (nextId) void reorder(item.session.id, nextId, 'after') }}
            onPress={() => { void select(item.session.id); onOpenChat?.() }}
          />
        })()}
      />
      <View style={[styles.footer, { borderColor: colors.border, minHeight: 34 + insets.bottom, paddingBottom: insets.bottom }]}><Text style={{ color: colors.muted, fontSize: 10 }}>{sessions.length} chats</Text><View style={{ flex: 1 }} /><View style={[styles.footerDot, { backgroundColor: active.size ? colors.green : colors.muted }]} /><Text style={{ color: colors.muted, fontSize: 10 }}>{active.size} active</Text></View>
    </View>
  )
}

function FolderHeader({ item, collapsed, canMoveUp, canMoveDown, onToggle, onMove }: {
  item: Extract<Row, { kind: 'header' }>
  collapsed: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onToggle: () => void
  onMove: (direction: 'up' | 'down') => void
}) {
  const colors = usePalette()
  const movable = !['Pinned', 'General', 'Archived'].includes(item.folder)
  const header = <Pressable onPress={onToggle} style={styles.header}>
    {collapsed ? <ChevronRight size={13} color={colors.muted} /> : <ChevronDown size={13} color={colors.muted} />}
    <Text style={[styles.headerText, { color: colors.muted }]}>{item.title}</Text>
    <Text style={[styles.count, { color: colors.muted }]}>{item.count}</Text>
  </Pressable>
  if (!movable) return header
  return <MenuView shouldOpenOnLongPress title={item.title} actions={[
    { id: 'move-up', title: 'Move Folder Up', image: 'arrow.up', attributes: { disabled: !canMoveUp } },
    { id: 'move-down', title: 'Move Folder Down', image: 'arrow.down', attributes: { disabled: !canMoveDown } },
  ]} onPressAction={event => { if (event.nativeEvent.event === 'move-up') onMove('up'); if (event.nativeEvent.event === 'move-down') onMove('down') }} style={styles.menuTrigger}>{header}</MenuView>
}

function SessionRow({ session, selected, running, folders, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onPress }: {
  session: Session
  selected: boolean
  running: boolean
  folders: string[]
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onPress: () => void
}) {
  const colors = usePalette()
  const unread = isUnread(session)
  const markRead = useAppStore(state => state.markRead)
  const markUnread = useAppStore(state => state.markUnread)
  const update = useAppStore(state => state.updateSession)
  const fork = useAppStore(state => state.forkSession)
  const remove = useAppStore(state => state.deleteSession)
  const swipeRef = useRef<Swipeable>(null)
  const confirmDelete = () => {
    Alert.alert('Delete chat?', `“${session.title}” and its AgentsDock history will be removed. Provider history is not deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete chat', style: 'destructive', onPress: () => { void remove(session.id) } },
    ])
  }
  const runAction = (id: string) => {
    if (id === 'read-state') void (unread ? markRead(session.id) : markUnread(session.id))
    else if (id === 'fork') void fork(session.id)
    else if (id === 'move-up') onMoveUp()
    else if (id === 'move-down') onMoveDown()
    else if (id === 'pin') void update(session.id, { pinned: !session.pinned })
    else if (id === 'archive') void update(session.id, { archived: !session.archived })
    else if (id === 'delete') confirmDelete()
    else if (id.startsWith('folder:')) void update(session.id, { folder: decodeURIComponent(id.slice(7)), pinned: false })
  }
  const folderActions: MenuAction[] = folders.map(folder => ({
    id: `folder:${encodeURIComponent(folder)}`,
    title: folder,
    state: !session.pinned && (session.folder?.trim() || 'General') === folder ? 'on' : 'off',
  }))
  const actions: MenuAction[] = [
    { id: 'read-state', title: unread ? 'Mark as Read' : 'Mark as Unread', image: unread ? 'envelope.open' : 'envelope.badge' },
    { id: 'primary-actions', title: '', displayInline: true, subactions: [
      { id: 'fork', title: 'Fork Chat', image: 'arrow.triangle.branch' },
      { id: 'move-up', title: 'Move Up', image: 'arrow.up', attributes: { disabled: !canMoveUp } },
      { id: 'move-down', title: 'Move Down', image: 'arrow.down', attributes: { disabled: !canMoveDown } },
    ] },
    ...(session.archived ? [] : [
      { id: 'pin', title: session.pinned ? 'Unpin Chat' : 'Pin Chat', image: session.pinned ? 'pin.slash' : 'pin' } satisfies MenuAction,
      { id: 'move-folder', title: 'Move to Folder', image: 'folder', subactions: folderActions } satisfies MenuAction,
    ]),
    { id: 'archive', title: session.archived ? 'Unarchive Chat' : 'Archive Chat', image: 'archivebox' },
    { id: 'delete', title: 'Delete Chat', image: 'trash', attributes: { destructive: true } },
  ]
  const row = <MenuView shouldOpenOnLongPress title={session.title} actions={actions} onPressAction={event => runAction(event.nativeEvent.event)} style={styles.menuTrigger}>
    <Pressable
      testID={`chat-row-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={session.title}
      onPress={onPress}
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
  </MenuView>
  return (
    <Swipeable
      ref={swipeRef}
      friction={1.7}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={() => session.archived
        ? <SwipeAction icon={ArchiveRestore} label="Unarchive" color={colors.muted} onPress={() => { swipeRef.current?.close(); void update(session.id, { archived: false }) }} />
        : <SwipeAction icon={session.pinned ? PinOff : Pin} label={session.pinned ? 'Unpin' : 'Pin'} color={colors.blue} onPress={() => { swipeRef.current?.close(); void update(session.id, { pinned: !session.pinned }) }} />}
      renderRightActions={() => <View style={styles.swipeActions}>
        {!session.archived ? <SwipeAction icon={Archive} label="Archive" color={colors.muted} onPress={() => { swipeRef.current?.close(); void update(session.id, { archived: true }) }} /> : null}
        <SwipeAction icon={Trash2} label="Delete" color={colors.red} onPress={() => { swipeRef.current?.close(); confirmDelete() }} />
      </View>}
    >
      {row}
    </Swipeable>
  )
}

function SwipeAction({ icon: Icon, label, color, onPress }: { icon: LucideIcon; label: string; color: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.swipeAction, { backgroundColor: color }]}><Icon size={17} color="white" /><Text style={styles.swipeActionText}>{label}</Text></Pressable>
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
  menuTrigger: { flex: 1 },
  sessionText: { flex: 1, minWidth: 0 },
  sessionTitle: { fontSize: 13, fontWeight: '700' },
  sessionMeta: { marginTop: 2, fontSize: 10.5, fontWeight: '600' },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  swipeActions: { flexDirection: 'row' },
  swipeAction: { width: 76, minHeight: 51, alignItems: 'center', justifyContent: 'center', gap: 3 },
  swipeActionText: { color: 'white', fontSize: 10, fontWeight: '700' },
  footer: { minHeight: 34, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 5 }, footerDot: { width: 6, height: 6, borderRadius: 3 },
})
