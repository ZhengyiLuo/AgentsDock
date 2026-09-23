import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionSheetIOS, Alert, FlatList, Image, Platform, Pressable, StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction, type MenuComponentRef } from '@expo/ui/community/menu'
import { ChevronDown, ChevronRight, FolderPlus, MoreHorizontal, Network, Plus, RefreshCw, Search, Server, Settings } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session, TimelineSearchResult } from '../types'
import { formatChatDateTime, isUnread, runtimeSummary } from '../lib/format'
import { compareSessions, orderedSessionSections, sessionSection } from '../lib/session-order'
import { completedPrefixForkAvailable, RUNNING_FORK_DESCRIPTION, RUNNING_FORK_UNAVAILABLE } from '../lib/session-fork'
import { sessionNeedsProviderInteraction, sessionPendingInteractionCount } from '../lib/claude-controls'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { isServerSetupRequired } from '../lib/first-launch'
import { serverSearchQuery } from '../lib/server-search'
import { rankSidebarSessions, sidebarContentResult } from '../lib/sidebar-search'
import { isWelcomeSession } from '../lib/welcome-session'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { useTextPrompt, type TextPromptOptions } from './TextPromptDialog'
import { IconButton } from './ui'
import { ServerProfileSelector, type ServerProfileListItem } from './ServerProfiles'
import { localSessionImportSupported } from '../lib/local-session-import'

type Row = { kind: 'header'; key: string; title: string; folder: string; count: number } | { kind: 'session'; key: string; session: Session; searchResult?: TimelineSearchResult }

type ProfileScope = {
  activeProfileId: string | null
  profileGeneration: number
}

function profileScopeIsCurrent(scope: ProfileScope): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === scope.activeProfileId
    && state.profileGeneration === scope.profileGeneration
    && state.switchingProfileId === null
    && !state.workspaceAdopting
}

function profileScopeCanNavigate(scope: ProfileScope): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === scope.activeProfileId
    && state.profileGeneration === scope.profileGeneration
    && state.switchingProfileId === null
}

function sidebarImportAvailable(state: ReturnType<typeof useAppStore.getState>): boolean {
  return Boolean(state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting
    && client.isValidated && localSessionImportSupported(state.health))
}

function sessionScopeIsCurrent(scope: ProfileScope, sessionId: string): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === scope.activeProfileId
    && state.profileGeneration === scope.profileGeneration
    && state.switchingProfileId === null
    && !state.workspaceAdopting
    && state.sessions.some(session => session.id === sessionId)
}

export function Sidebar({ profiles, activeProfileId, switchingProfileId, onSwitchServer, onAddServer, onManageServers, onSettings, onTeamNetwork, onNewChat, onOpenChat, onImportChat }: {
  profiles: readonly ServerProfileListItem[]
  activeProfileId: string | null
  switchingProfileId?: string | null
  onSwitchServer: (profileId: string) => Promise<boolean>
  onAddServer: () => void
  onManageServers: () => void
  onSettings: () => void
  onTeamNetwork: () => void
  onNewChat: () => void
  onOpenChat?: () => void
  onImportChat?: () => void
}) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const needsServerSetup = useAppStore(state => isServerSetupRequired({ serverConfigured: state.serverConfigured, serverURL: state.serverURL }))
  const sessions = useAppStore(state => state.sessions)
  const selected = useAppStore(state => state.selectedSessionId)
  const active = useAppStore(state => state.activeSessionIds)
  const folderOrder = useAppStore(state => state.folderOrder)
  const collapsedFolders = useAppStore(state => state.collapsedFolders)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const importAvailable = useAppStore(sidebarImportAvailable)
  const searchResults = useAppStore(state => state.searchResults)
  const searchBusy = useAppStore(state => state.searchBusy)
  const searchError = useAppStore(state => state.searchError)
  const search = useAppStore(state => state.search)
  const clearSearch = useAppStore(state => state.clearSearch)
  const select = useAppStore(state => state.selectSession)
  const seekTimelineResult = useAppStore(state => state.seekTimelineResult)
  const cancelTimelineSeek = useAppStore(state => state.cancelTimelineSeek)
  const reorder = useAppStore(state => state.reorderSession)
  const refreshSessions = useAppStore(state => state.refreshSessions)
  const setFolderOrder = useAppStore(state => state.setFolderOrder)
  const setCollapsedFolders = useAppStore(state => state.setCollapsedFolders)
  const [query, setQuery] = useState('')
  const [openingSearchResultId, setOpeningSearchResultId] = useState<string | null>(null)
  const { promptText, textPromptDialog } = useTextPrompt()
  const waitingSessionCount = useMemo(() => sessions.filter(sessionNeedsProviderInteraction).length, [sessions])
  const profileScope = useMemo<ProfileScope>(() => ({ activeProfileId, profileGeneration }), [activeProfileId, profileGeneration])
  const collapsed = useMemo(() => new Set(collapsedFolders), [collapsedFolders])
  const listState = useMemo(() => ({ active, selected, openingSearchResultId }), [active, openingSearchResultId, selected])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInput = useRef<TextInput>(null)
  const openingSearchResult = useRef<symbol | null>(null)
  const dismissSearchKeyboard = useCallback(() => {
    searchInput.current?.blur()
    dismissAppKeyboard()
  }, [])
  const handleSearchChange = useCallback((value: string) => {
    if (openingSearchResult.current) {
      openingSearchResult.current = null
      if (profileScopeIsCurrent(profileScope)) cancelTimelineSeek()
      setOpeningSearchResultId(null)
    }
    // Clear synchronously with the edit so results for the previous query
    // never render under the new text while its debounce is pending.
    clearSearch()
    setQuery(value)
  }, [cancelTimelineSeek, clearSearch, profileScope])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const clean = serverSearchQuery(query)
    if (!clean || needsServerSetup) {
      searchTimer.current = null
      clearSearch()
      return
    }
    const scope = profileScope
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      if (!profileScopeIsCurrent(scope)) return
      void search(clean, undefined, scope.profileGeneration)
    }, 260)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
  }, [clearSearch, needsServerSetup, profileScope, query, search, switchingProfileId, workspaceAdopting])

  useEffect(() => {
    openingSearchResult.current = null
    setOpeningSearchResultId(null)
  }, [profileScope])

  const retrySearch = useCallback(() => {
    const clean = serverSearchQuery(query)
    if (!clean || needsServerSetup || !profileScopeIsCurrent(profileScope)) return
    clearSearch()
    void search(clean, undefined, profileScope.profileGeneration)
  }, [clearSearch, needsServerSetup, profileScope, query, search])

  const rows = useMemo(() => {
    const contentResults = new Map<string, TimelineSearchResult>()
    if (serverSearchQuery(query)) {
      for (const result of searchResults) {
        if (!contentResults.has(result.session_id)) contentResults.set(result.session_id, result)
      }
    }
    const matchedByContent = new Set(contentResults.keys())
    const clean = query.trim()
    // Search is one ranked list. Passing these matches back through folder
    // ordering buries names beneath pinned/history hits and re-sorts their rank.
    if (clean) return rankSidebarSessions(sessions, clean, matchedByContent).map<Row>(session => ({
      kind: 'session', key: session.id, session,
      // A name match opens the chat at its live position, even if history also
      // matches; content-only hits retain their exact timeline destination.
      searchResult: sidebarContentResult(session.title, clean, contentResults.get(session.id)),
    }))
    return orderedSessionSections(sessions, folderOrder, true, true).flatMap<Row>(section => {
      const folder = section.id
      const values = section.sessions
      return [
        { kind: 'header', key: `header:${folder}`, title: folder, folder, count: values.length },
        ...((collapsed.has(folder) ? [] : values.map(session => ({
          kind: 'session' as const,
          key: session.id,
          session,
        })))),
      ]
    })
  }, [collapsed, folderOrder, query, searchResults, sessions])
  const openSessionRow = useCallback((session: Session, result?: TimelineSearchResult) => {
    if (!sessionScopeIsCurrent(profileScope, session.id) || openingSearchResult.current) return
    dismissSearchKeyboard()
    if (!result) {
      if (isWelcomeSession(session.id)) {
        useAppStore.setState(state => {
          const currentSession = state.sessions.find(candidate => candidate.id === session.id)
          if (!currentSession) return state
          const nextSession = currentSession.manual_unread
            ? { ...currentSession, manual_unread: false }
            : currentSession
          const snapshot = state.snapshots[session.id]
          return {
            sessions: nextSession === currentSession
              ? state.sessions
              : state.sessions.map(candidate => candidate.id === session.id ? nextSession : candidate),
            snapshots: snapshot && snapshot.session !== nextSession
              ? { ...state.snapshots, [session.id]: { ...snapshot, session: nextSession } }
              : state.snapshots,
            selectedSessionId: session.id,
            historyWindow: null,
            error: null,
            liveConnected: false,
            syncSessionId: session.id,
            syncStatus: 'cached',
            syncError: null,
            loadingSessionId: null,
          }
        })
        if (
          sessionScopeIsCurrent(profileScope, session.id)
          && useAppStore.getState().selectedSessionId === session.id
        ) onOpenChat?.()
        return
      }
      // selectSession publishes the target synchronously, then hydrates and
      // reconciles its timeline. Open the mobile pane immediately instead of
      // making a row tap wait for a potentially slow history request.
      const selection = select(session.id, profileScope.profileGeneration)
      if (
        sessionScopeIsCurrent(profileScope, session.id)
        && useAppStore.getState().selectedSessionId === session.id
      ) onOpenChat?.()
      void selection
      return
    }
    const request = Symbol('open-search-result')
    openingSearchResult.current = request
    setOpeningSearchResultId(result.event_id)
    void seekTimelineResult(result, profileScope.profileGeneration).then(opened => {
      if (opened && openingSearchResult.current === request && sessionScopeIsCurrent(profileScope, session.id)) onOpenChat?.()
    }).finally(() => {
      if (openingSearchResult.current !== request) return
      openingSearchResult.current = null
      if (profileScopeIsCurrent(profileScope)) setOpeningSearchResultId(null)
    })
  }, [dismissSearchKeyboard, onOpenChat, profileScope, seekTimelineResult, select])
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
    const scope = profileScope
    if (!profileScopeIsCurrent(scope)) return
    dismissSearchKeyboard()
    void promptText({
      title: 'New folder',
      message: 'Create a folder, then move chats into it from the chat actions menu.',
      confirmLabel: 'Create',
      placeholder: 'Folder name',
    }).then(value => {
      if (!profileScopeIsCurrent(scope)) return
      const name = value?.trim()
      if (name && !folders.includes(name)) setFolderOrder([...movableFolders, name], scope.profileGeneration)
    })
  }
  const moveFolder = (folder: string, direction: 'up' | 'down') => {
    if (!profileScopeIsCurrent(profileScope)) return
    const order = [...movableFolders]
    const index = order.indexOf(folder)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    setFolderOrder(order, profileScope.profileGeneration)
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]}>AgentsDock</Text>
      </View>
      <View style={styles.actions}>
        <IconButton icon={RefreshCw} disabled={workspaceAdopting || needsServerSetup} onPress={() => { dismissSearchKeyboard(); if (profileScopeIsCurrent(profileScope)) void refreshSessions(profileScope.profileGeneration) }} label="Refresh chats" />
        <IconButton icon={FolderPlus} disabled={workspaceAdopting || needsServerSetup} onPress={createFolder} label="New folder" />
        <IconButton icon={Plus} disabled={workspaceAdopting || needsServerSetup} onPress={onNewChat} label="New chat" testID="sidebar-new-chat" />
        {onImportChat && importAvailable ? <Pressable testID="sidebar-import-chat" accessibilityRole="button" accessibilityLabel="Import chat from provider history" onPress={() => { dismissSearchKeyboard(); if (profileScopeIsCurrent(profileScope) && sidebarImportAvailable(useAppStore.getState())) onImportChat() }} style={styles.importButton}><Text style={{ color: colors.blue, fontSize: 12 }}>Import</Text></Pressable> : null}
        <IconButton icon={Settings} disabled={workspaceAdopting} onPress={() => { if (profileScopeIsCurrent(profileScope)) onSettings() }} label="Settings" testID="sidebar-settings" />
      </View>
      <View style={styles.serverSelector}><ServerProfileSelector
          profiles={profiles}
          activeProfileId={activeProfileId}
          switchingProfileId={switchingProfileId}
          onSelectProfile={profileId => { dismissSearchKeyboard(); return profileScopeCanNavigate(profileScope) ? onSwitchServer(profileId) : Promise.resolve(false) }}
          onAddServer={() => { if (profileScopeCanNavigate(profileScope)) onAddServer() }}
          onManageServers={() => { if (profileScopeCanNavigate(profileScope)) onManageServers() }}
        /></View>
      {!needsServerSetup ? <Pressable
        testID="sidebar-team-network"
        accessibilityRole="button"
        accessibilityLabel="Open Team Network"
        accessibilityState={{ disabled: workspaceAdopting || Boolean(switchingProfileId) }}
        disabled={workspaceAdopting || Boolean(switchingProfileId)}
        onPress={() => { dismissSearchKeyboard(); if (profileScopeCanNavigate(profileScope)) onTeamNetwork() }}
        style={({ pressed }) => [styles.teamNetworkButton, { backgroundColor: colors.raised, borderColor: colors.border, opacity: workspaceAdopting || switchingProfileId ? 0.4 : pressed ? 0.68 : 1 }]}
      ><Network size={16} color={colors.blue} /><Text style={[styles.teamNetworkButtonText, { color: colors.text }]}>Team Network</Text><ChevronRight size={15} color={colors.muted} /></Pressable> : null}
      {needsServerSetup ? <Pressable
        testID="sidebar-setup-server"
        accessibilityRole="button"
        accessibilityLabel="Set up your server"
        onPress={() => { if (profileScopeCanNavigate(profileScope)) onAddServer() }}
        style={({ pressed }) => [styles.setupBanner, { backgroundColor: colors.blue, opacity: pressed ? 0.85 : 1 }]}
      >
        <Server size={16} color="white" />
        <Text style={styles.setupBannerText}>Set up your server</Text>
      </Pressable> : null}
      <View
        style={[styles.search, { backgroundColor: colors.raised, borderColor: colors.border }]}
      >
        <Search size={16} color={colors.muted} />
        <TextInput
          ref={searchInput}
          value={query}
          onChangeText={handleSearchChange}
          editable={!workspaceAdopting && !switchingProfileId}
          placeholder={workspaceAdopting ? 'Preparing server workspace…' : 'Search chats and history'}
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          accessibilityLabel="Search chats and history"
          testID="sidebar-search-input"
          returnKeyType="search"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={dismissSearchKeyboard}
          clearButtonMode={Platform.OS === 'ios' ? 'while-editing' : 'never'}
          style={[styles.searchInput, { color: colors.text }]}
        />
        {!needsServerSetup && searchBusy ? <Text style={{ color: colors.muted }}>…</Text> : null}
      </View>
      {!needsServerSetup && searchError && serverSearchQuery(query) ? <View accessibilityRole="alert" style={styles.searchError}>
        <Text style={[styles.searchErrorText, { color: colors.red }]}>History search failed.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry history search"
          testID="sidebar-search-retry"
          onPress={retrySearch}
          style={({ pressed }) => [styles.searchRetry, { borderColor: colors.red, opacity: pressed ? 0.6 : 1 }]}
        ><Text style={[styles.searchRetryText, { color: colors.red }]}>Retry</Text></Pressable>
      </View> : null}
      <FlatList
        pointerEvents={workspaceAdopting ? 'none' : 'auto'}
        data={rows}
        extraData={listState}
        keyExtractor={item => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={Platform.OS === 'ios'}
        onScrollBeginDrag={dismissSearchKeyboard}
        contentContainerStyle={styles.list}
        ListHeaderComponent={query.trim() && rows.length ? <View style={styles.header}>
          <Search size={13} color={colors.muted} />
          <Text style={[styles.headerText, { color: colors.muted }]}>Matches</Text>
          <Text style={[styles.count, { color: colors.muted }]}>{rows.length}</Text>
        </View> : null}
        ListEmptyComponent={query.trim() ? <Text style={[styles.searchEmpty, { color: colors.muted }]}>
          {searchBusy ? 'Searching history…' : 'No matching chats'}
        </Text> : null}
        renderItem={({ item }) => item.kind === 'header' ? <FolderHeader
          item={item}
          profileScope={profileScope}
          collapsed={collapsed.has(item.folder)}
          canMoveUp={movableFolders.indexOf(item.folder) > 0}
          canMoveDown={movableFolders.indexOf(item.folder) >= 0 && movableFolders.indexOf(item.folder) < movableFolders.length - 1}
          onDismissKeyboard={dismissSearchKeyboard}
          onToggle={() => {
            if (!profileScopeIsCurrent(profileScope)) return
            const next = new Set(collapsed)
            if (next.has(item.folder)) next.delete(item.folder)
            else next.add(item.folder)
            setCollapsedFolders([...next], profileScope.profileGeneration)
          }}
          onMove={direction => moveFolder(item.folder, direction)}
        /> : (() => {
          const { previousId, nextId } = reorderNeighbors.get(item.session.id) ?? { previousId: null, nextId: null }
          return <SessionRow
            session={item.session}
            profileScope={profileScope}
            selected={selected === item.session.id}
            running={active.has(item.session.id)}
            searchSnippet={item.searchResult?.snippet}
            opening={openingSearchResultId === item.searchResult?.event_id}
            folders={folders}
            canMoveUp={Boolean(previousId)}
            canMoveDown={Boolean(nextId)}
            onMoveUp={() => { if (previousId && sessionScopeIsCurrent(profileScope, item.session.id)) void reorder(item.session.id, previousId, 'before', profileScope.profileGeneration) }}
            onMoveDown={() => { if (nextId && sessionScopeIsCurrent(profileScope, item.session.id)) void reorder(item.session.id, nextId, 'after', profileScope.profileGeneration) }}
            onDismissKeyboard={dismissSearchKeyboard}
            onPress={() => {
              openSessionRow(item.session, item.searchResult)
            }}
            promptText={promptText}
          />
        })()}
      />
      <View style={[styles.footer, { borderColor: colors.border, minHeight: 34 + insets.bottom, paddingBottom: insets.bottom }]}>
        <Text style={{ color: colors.muted, fontSize: 10 }}>{query.trim() ? `${rows.length} ${rows.length === 1 ? 'match' : 'matches'}` : `${sessions.length} chats`}</Text>
        <View style={{ flex: 1 }} />
        {waitingSessionCount ? <>
          <View style={[styles.footerDot, { backgroundColor: colors.orange }]} />
          <Text style={{ color: colors.orange, fontSize: 10, fontWeight: '700' }}>{waitingSessionCount} waiting</Text>
        </> : null}
        <View style={[styles.footerDot, { backgroundColor: active.size ? colors.green : colors.muted }]} />
        <Text style={{ color: colors.muted, fontSize: 10 }}>{active.size} active</Text>
      </View>
      {textPromptDialog}
    </View>
  )
}

function FolderHeader({ item, profileScope, collapsed, canMoveUp, canMoveDown, onDismissKeyboard, onToggle, onMove }: {
  item: Extract<Row, { kind: 'header' }>
  profileScope: ProfileScope
  collapsed: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onDismissKeyboard: () => void
  onToggle: () => void
  onMove: (direction: 'up' | 'down') => void
}) {
  const colors = usePalette()
  const movable = !['Pinned', 'General', 'Archived'].includes(item.folder)
  const openMoveSheet = () => {
    if (!profileScopeIsCurrent(profileScope)) return
    onDismissKeyboard()
    const available = [
      ...(canMoveUp ? [{ title: 'Move Folder Up', direction: 'up' as const }] : []),
      ...(canMoveDown ? [{ title: 'Move Folder Down', direction: 'down' as const }] : []),
    ]
    const cancelButtonIndex = available.length
    ActionSheetIOS.showActionSheetWithOptions({
      title: item.title,
      options: [...available.map(action => action.title), 'Cancel'],
      cancelButtonIndex,
    }, index => {
      const action = available[index]
      if (action && profileScopeIsCurrent(profileScope)) onMove(action.direction)
    })
  }
  const header = <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${collapsed ? 'Expand' : 'Collapse'} ${item.title}`}
    accessibilityHint={movable && Platform.OS === 'ios' ? 'Long press to reorder this folder.' : undefined}
    onPress={() => { onDismissKeyboard(); onToggle() }}
    onLongPress={movable && Platform.OS === 'ios' ? openMoveSheet : undefined}
    delayLongPress={350}
    style={[styles.header, movable && Platform.OS !== 'ios' && styles.headerInShell]}
  >
    {collapsed ? <ChevronRight size={13} color={colors.muted} /> : <ChevronDown size={13} color={colors.muted} />}
    <Text style={[styles.headerText, { color: colors.muted }]}>{item.title}</Text>
    <Text style={[styles.count, { color: colors.muted }]}>{item.count}</Text>
  </Pressable>
  if (!movable || Platform.OS === 'ios') return header
  return <View style={styles.folderHeaderShell}>{header}<AndroidMoreMenu testID={`folder-actions-${item.folder}`} label={`${item.title} folder actions`} title={item.title} color={colors.muted} actions={[
    { id: 'move-up', title: 'Move Folder Up', image: 'arrow.up', attributes: { disabled: !canMoveUp } },
    { id: 'move-down', title: 'Move Folder Down', image: 'arrow.down', attributes: { disabled: !canMoveDown } },
  ]} onAction={action => {
    if (!profileScopeIsCurrent(profileScope)) return
    if (action === 'move-up') onMove('up')
    if (action === 'move-down') onMove('down')
  }} /></View>
}

function SessionRow({ session, profileScope, selected, running, searchSnippet, opening, folders, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onDismissKeyboard, onPress, promptText }: {
  session: Session
  profileScope: ProfileScope
  selected: boolean
  running: boolean
  searchSnippet?: string
  opening: boolean
  folders: string[]
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onDismissKeyboard: () => void
  onPress: () => void
  promptText: (options: TextPromptOptions) => Promise<string | null>
}) {
  const colors = usePalette()
  const welcome = isWelcomeSession(session.id)
  const unread = isUnread(session)
  const waiting = sessionNeedsProviderInteraction(session)
  const pendingInteractionCount = sessionPendingInteractionCount(session)
  const waitingProviderName = session.backend === 'claude' ? 'Claude' : 'Codex'
  const activityDate = formatChatDateTime(session.latest_event_at ?? session.updated_at ?? session.created_at)
  const markRead = useAppStore(state => state.markRead)
  const markUnread = useAppStore(state => state.markUnread)
  const update = useAppStore(state => state.updateSession)
  const fork = useAppStore(state => state.forkSession)
  const connected = useAppStore(state => state.connected)
  const liveFork = useAppStore(state => state.activeSessionIds.has(session.id) || state.stoppingSessionIds.has(session.id)
    || Boolean(state.turnAdmissionTokens[session.id]) || state.sendingSessionIds.has(session.id)
    || Boolean(state.snapshots[session.id]?.queuedTurns.some(turn => state.pendingQueuedRunIds.has(turn.queued_id))))
  const liveForkSupported = useAppStore(state => completedPrefixForkAvailable(state.health, session.backend))
  const forkDisabled = !connected || (liveFork && !liveForkSupported)
  const forkHint = !connected ? 'Connect to the server to fork this chat.' : forkDisabled ? RUNNING_FORK_UNAVAILABLE : liveFork ? RUNNING_FORK_DESCRIPTION : undefined
  const remove = useAppStore(state => state.deleteSession)
  const folderSheetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (folderSheetTimer.current) clearTimeout(folderSheetTimer.current)
    folderSheetTimer.current = null
  }, [profileScope.activeProfileId, profileScope.profileGeneration, session.id])
  const requestRename = () => {
    const scope = profileScope
    if (!sessionScopeIsCurrent(scope, session.id)) return
    onDismissKeyboard()
    void promptText({
      title: 'Rename Chat',
      initialValue: session.title,
      confirmLabel: 'Rename',
      placeholder: 'Chat name',
    }).then(value => {
      if (!sessionScopeIsCurrent(scope, session.id)) return
      const name = value?.trim()
      if (name && name !== session.title) void update(session.id, { title: name }, scope.profileGeneration)
    })
  }
  const confirmDelete = () => {
    const scope = profileScope
    if (!sessionScopeIsCurrent(scope, session.id)) return
    Alert.alert('Delete chat?', `“${session.title}” and its AgentsDock history will be removed. Provider history is not deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete chat', style: 'destructive', onPress: () => {
        if (!sessionScopeIsCurrent(scope, session.id)) return
        void remove(session.id, scope.profileGeneration)
      } },
    ])
  }
  const runAction = (id: string) => {
    if (!sessionScopeIsCurrent(profileScope, session.id)) return
    if (id === 'read-state') void (unread ? markRead(session.id, profileScope.profileGeneration) : markUnread(session.id, profileScope.profileGeneration))
    else if (id === 'rename') requestRename()
    else if (id === 'fork') void fork(session.id, profileScope.profileGeneration)
    else if (id === 'move-up') onMoveUp()
    else if (id === 'move-down') onMoveDown()
    else if (id === 'pin') void update(session.id, { pinned: !session.pinned }, profileScope.profileGeneration)
    else if (id === 'archive') void update(session.id, { archived: !session.archived }, profileScope.profileGeneration)
    else if (id === 'delete') confirmDelete()
    else if (id.startsWith('folder:')) void update(session.id, { folder: decodeURIComponent(id.slice(7)), pinned: false }, profileScope.profileGeneration)
  }
  const folderActions: MenuAction[] = folders.map(folder => ({
    id: `folder:${encodeURIComponent(folder)}`,
    title: folder,
    state: !session.pinned && (session.folder?.trim() || 'General') === folder ? 'on' : 'off',
  }))
  const actions: MenuAction[] = [
    { id: 'read-state', title: unread ? 'Mark as Read' : 'Mark as Unread', image: unread ? 'envelope.open' : 'envelope.badge' },
    { id: 'rename', title: 'Rename Chat', image: 'pencil' },
    { id: 'primary-actions', title: '', displayInline: true, subactions: [
      { id: 'fork', title: 'Fork Chat', image: 'arrow.triangle.branch', attributes: { disabled: forkDisabled } },
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
  const openFolderSheet = () => {
    const scope = profileScope
    if (!sessionScopeIsCurrent(scope, session.id)) return
    onDismissKeyboard()
    const cancelButtonIndex = folders.length
    const currentFolder = session.folder?.trim() || 'General'
    ActionSheetIOS.showActionSheetWithOptions({
      title: 'Move to Folder',
      message: session.title,
      options: [...folders.map(folder => folder === currentFolder && !session.pinned ? `✓ ${folder}` : folder), 'Cancel'],
      cancelButtonIndex,
    }, index => {
      if (!sessionScopeIsCurrent(scope, session.id)) return
      const folder = folders[index]
      if (folder) void update(session.id, { folder, pinned: false }, scope.profileGeneration)
    })
  }
  const openActionSheet = () => {
    const scope = profileScope
    if (!sessionScopeIsCurrent(scope, session.id)) return
    onDismissKeyboard()
    const sheetActions: Array<{ id: string; title: string; destructive?: boolean }> = [
      { id: 'read-state', title: unread ? 'Mark as Read' : 'Mark as Unread' },
      { id: 'rename', title: 'Rename Chat' },
      { id: 'fork', title: 'Fork Chat' },
      ...(canMoveUp ? [{ id: 'move-up', title: 'Move Up' }] : []),
      ...(canMoveDown ? [{ id: 'move-down', title: 'Move Down' }] : []),
      ...(session.archived ? [] : [
        { id: 'pin', title: session.pinned ? 'Unpin Chat' : 'Pin Chat' },
        { id: 'move-folder', title: 'Move to Folder…' },
      ]),
      { id: 'archive', title: session.archived ? 'Unarchive Chat' : 'Archive Chat' },
      { id: 'delete', title: 'Delete Chat', destructive: true },
    ]
    const cancelButtonIndex = sheetActions.length
    const destructiveButtonIndex = sheetActions.findIndex(action => action.destructive)
    ActionSheetIOS.showActionSheetWithOptions({
      title: session.title,
      message: forkHint,
      options: [...sheetActions.map(action => action.title), 'Cancel'],
      disabledButtonIndices: forkDisabled ? [sheetActions.findIndex(action => action.id === 'fork')] : [],
      cancelButtonIndex,
      destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
    }, index => {
      if (!sessionScopeIsCurrent(scope, session.id)) return
      const action = sheetActions[index]
      if (!action) return
      if (action.id === 'move-folder') {
        if (folderSheetTimer.current) clearTimeout(folderSheetTimer.current)
        folderSheetTimer.current = setTimeout(() => {
          folderSheetTimer.current = null
          if (!sessionScopeIsCurrent(scope, session.id)) return
          openFolderSheet()
        }, 180)
        return
      }
      runAction(action.id)
    })
  }
  const pressableRow = (
    <Pressable
      testID={`chat-row-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={session.title}
      accessibilityHint={welcome ? 'Tap to open the local setup guide.' : Platform.OS === 'ios' ? 'Tap to open. Long press for chat actions.' : 'Tap to open. Use the adjacent More button for chat actions.'}
      accessibilityState={{ selected, disabled: opening }}
      disabled={opening}
      delayLongPress={350}
      onLongPress={!welcome && Platform.OS === 'ios' ? openActionSheet : undefined}
      onPress={() => {
        if (!sessionScopeIsCurrent(profileScope, session.id)) return
        onPress()
      }}
      style={({ pressed }) => [styles.session, Platform.OS !== 'ios' && styles.sessionInShell, {
        backgroundColor: selected ? `${colors.blue}22` : pressed ? colors.raised : colors.surface,
        borderColor: selected ? `${colors.blue}88` : 'transparent',
      }]}
    >
      {selected ? <View pointerEvents="none" style={[styles.selectedIndicator, { backgroundColor: colors.blue }]} /> : null}
      <View style={styles.backendStatus}>{welcome ? <Image source={require('../../assets/icon.png')} resizeMode="contain" style={{ width: 22, height: 22, borderRadius: 5 }} /> : <BackendMark backend={session.backend} size={22} />}</View>
      <View style={styles.sessionText}>
        <Text style={[styles.sessionTitle, { color: colors.text }]} numberOfLines={1}>{session.title}</Text>
        <View style={styles.sessionMetaRow}>
          <Text style={[styles.sessionMeta, { color: unread ? colors.blue : colors.muted }]} numberOfLines={1}>
            {welcome ? 'Local setup guide' : (searchSnippet ? `History · ${searchSnippet}` : (waiting ? `${runtimeSummary(session)} · waiting for you` : running ? `${runtimeSummary(session)} · running` : unread ? `${runtimeSummary(session)} · new` : runtimeSummary(session)))}
          </Text>
          {activityDate ? <Text style={[styles.sessionDate, { color: colors.muted }]} numberOfLines={1}>{activityDate}</Text> : null}
        </View>
      </View>
      {waiting ? <View
        accessibilityLabel={`${pendingInteractionCount} ${waitingProviderName} ${pendingInteractionCount === 1 ? 'request' : 'requests'} waiting for you`}
        style={[styles.waitingBadge, { backgroundColor: colors.orange }]}
      ><Text style={styles.waitingBadgeText}>{pendingInteractionCount > 9 ? '9+' : pendingInteractionCount}</Text></View> : (running || unread) ? <View
        accessibilityLabel={running ? 'Agent running' : 'Unread messages'}
        style={[styles.trailingStatusDot, { backgroundColor: running ? colors.green : colors.blue }]}
      /> : null}
    </Pressable>
  )
  // The chat identity is always a plain native Pressable. Wrapping the entire
  // Android row in Compose MenuView + ReanimatedSwipeable lets their gesture
  // hosts retain the touch after returning from a chat, making every row look
  // dead. Android actions live behind a separate 44pt More target instead.
  if (welcome || Platform.OS === 'ios') return pressableRow
  return <View style={styles.sessionShell}>{pressableRow}<AndroidMoreMenu testID={`chat-actions-${session.id}`} label={`${session.title} chat actions`} title={session.title} color={colors.muted} actions={actions} onAction={action => {
    if (!sessionScopeIsCurrent(profileScope, session.id)) return
    runAction(action)
  }} /></View>
}

function AndroidMoreMenu({ testID, label, title, color, actions, onAction }: { testID: string; label: string; title: string; color: string; actions: MenuAction[]; onAction: (action: string) => void }) {
  const menu = useRef<MenuComponentRef>(null)
  return <MenuView ref={menu} title={title} actions={actions} onPressAction={event => onAction(event.nativeEvent.event)} style={styles.moreMenuTrigger}><Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={() => menu.current?.show()} style={styles.moreButton}><MoreHorizontal size={18} color={color} /></Pressable></MenuView>
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 250, borderRightWidth: StyleSheet.hairlineWidth },
  titleRow: { minHeight: 48, paddingHorizontal: 12, paddingTop: 4, flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 15, fontWeight: '800' },
  actions: { minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 2 },
  importButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  serverSelector: { marginHorizontal: 10, marginBottom: 8 },
  teamNetworkButton: { minHeight: 44, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, teamNetworkButtonText: { flex: 1, fontSize: 12.5, fontWeight: '800' },
  setupBanner: { minHeight: 40, borderRadius: 7, marginHorizontal: 10, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  setupBannerText: { color: 'white', fontSize: 13, fontWeight: '700' },
  search: { minHeight: 38, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 10, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 7 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  searchError: { minHeight: 36, marginHorizontal: 10, marginTop: -3, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchErrorText: { flex: 1, fontSize: 11.5, fontWeight: '600' },
  searchRetry: { minWidth: 64, minHeight: 44, paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  searchRetryText: { fontSize: 11.5, fontWeight: '800' },
  searchEmpty: { paddingHorizontal: 12, paddingVertical: 20, fontSize: 13 },
  list: { paddingHorizontal: 6, paddingBottom: 24 },
  folderHeaderShell: { minHeight: 44, flexDirection: 'row', alignItems: 'stretch' },
  header: { minHeight: 44, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerInShell: { flex: 1 },
  headerText: { flex: 1, fontSize: 11, fontWeight: '700' },
  count: { fontSize: 10 },
  sessionShell: { minHeight: 51, flexDirection: 'row', alignItems: 'stretch', gap: 2 },
  session: { minHeight: 51, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 9, overflow: 'hidden' },
  sessionInShell: { flex: 1 },
  selectedIndicator: { position: 'absolute', top: 7, bottom: 7, left: 0, width: 3, borderRadius: 2 },
  moreMenuTrigger: { width: 44, minHeight: 44 },
  moreButton: { width: 44, minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center' },
  sessionText: { flex: 1, minWidth: 0 },
  sessionTitle: { fontSize: 13, fontWeight: '700' },
  sessionMetaRow: { marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 6 },
  sessionMeta: { flex: 1, minWidth: 0, fontSize: 10.5, fontWeight: '600' },
  sessionDate: { flexShrink: 0, fontSize: 9.5, fontWeight: '500' },
  backendStatus: { width: 22, height: 22 },
  trailingStatusDot: { width: 8, height: 8, flexShrink: 0, marginHorizontal: 4, borderRadius: 4 },
  waitingBadge: { minWidth: 20, height: 20, flexShrink: 0, marginHorizontal: 1, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  waitingBadgeText: { color: 'white', fontSize: 10, fontWeight: '800' },
  footer: { minHeight: 34, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 5 }, footerDot: { width: 6, height: 6, borderRadius: 3 },
})
