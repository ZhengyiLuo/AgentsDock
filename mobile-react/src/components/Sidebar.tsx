import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller'
import { MenuView, type MenuAction, type MenuComponentRef } from '@expo/ui/community/menu'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { ChevronDown, ChevronRight, FolderPlus, MoreHorizontal, Plus, Search, Server, Settings, X } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAppStore } from '../store/useAppStore'
import { fontWeight, radius, spacing, typography, usePalette } from '../theme'
import type { Session, TimelineSearchResult } from '../types'
import { formatChatDate, isUnread, runtimeSummary } from '../lib/format'
import { compareSessions, sessionSection } from '../lib/session-order'
import { sidebarSessionSections, sidebarSessionStatus, type SidebarStatus } from '../lib/sidebar-sections'
import { sessionNeedsProviderInteraction, sessionPendingInteractionCount } from '../lib/claude-controls'
import { sessionAttentionLevel, type NotificationLevel } from '../lib/notification-levels'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { isServerSetupRequired } from '../lib/first-launch'
import { serverSearchQuery } from '../lib/server-search'
import { sidebarContentResult } from '../lib/sidebar-search'
import { isWelcomeSession } from '../lib/welcome-session'
import { t } from '../i18n'
import { useLanguageStore } from '../store/useLanguageStore'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { useTextPrompt, type TextPromptOptions } from './TextPromptDialog'
import { IconButton } from './ui'
import { ServerProfileSelector, type ServerProfileListItem } from './ServerProfiles'

type Row = { kind: 'header'; key: string; title: string; folder: string; count: number; status?: SidebarStatus; attentionLevel?: NotificationLevel } | { kind: 'session'; key: string; session: Session; status?: SidebarStatus; searchResult?: TimelineSearchResult }

const HOME_ACTION_SIZE = 52

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

function sessionScopeIsCurrent(scope: ProfileScope, sessionId: string): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === scope.activeProfileId
    && state.profileGeneration === scope.profileGeneration
    && state.switchingProfileId === null
    && !state.workspaceAdopting
    && state.sessions.some(session => session.id === sessionId)
}

export function Sidebar({ compact, profiles, activeProfileId, switchingProfileId, onAddServer, onManageServers, onSettings, onNewChat, onOpenChat }: {
  compact: boolean
  profiles: readonly ServerProfileListItem[]
  activeProfileId: string | null
  switchingProfileId?: string | null
  onAddServer: () => void
  onManageServers: () => void
  onSettings: () => void
  onNewChat: () => void
  onOpenChat?: () => void
}) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardState(state => state.isVisible)
  const needsServerSetup = useAppStore(state => isServerSetupRequired({ serverConfigured: state.serverConfigured, serverURL: state.serverURL }))
  const sessions = useAppStore(state => state.sessions)
  const active = useAppStore(state => state.activeSessionIds)
  const folderOrder = useAppStore(state => state.folderOrder)
  const collapsedFolders = useAppStore(state => state.collapsedFolders)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const searchResults = useAppStore(state => state.searchResults)
  const searchBusy = useAppStore(state => state.searchBusy)
  const searchError = useAppStore(state => state.searchError)
  const search = useAppStore(state => state.search)
  const clearSearch = useAppStore(state => state.clearSearch)
  const select = useAppStore(state => state.selectSession)
  const seekTimelineResult = useAppStore(state => state.seekTimelineResult)
  const reorder = useAppStore(state => state.reorderSession)
  const refreshSessions = useAppStore(state => state.refreshSessions)
  const setFolderOrder = useAppStore(state => state.setFolderOrder)
  const setCollapsedFolders = useAppStore(state => state.setCollapsedFolders)
  const [query, setQuery] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<SidebarStatus>>(() => new Set())
  const [refreshingScope, setRefreshingScope] = useState<ProfileScope | null>(null)
  const [openingSearchResultId, setOpeningSearchResultId] = useState<string | null>(null)
  const { promptText, textPromptDialog } = useTextPrompt()
  const profileScope = useMemo<ProfileScope>(() => ({ activeProfileId, profileGeneration }), [activeProfileId, profileGeneration])
  const collapsed = useMemo(() => new Set(collapsedFolders), [collapsedFolders])
  const listState = useMemo(() => ({ active, openingSearchResultId }), [active, openingSearchResultId])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInput = useRef<TextInput>(null)
  const openingSearchResult = useRef(false)
  const dismissSearchKeyboard = useCallback(() => {
    searchInput.current?.blur()
    dismissAppKeyboard()
  }, [])
  const handleSearchChange = useCallback((value: string) => {
    // Clear synchronously with the edit so results for the previous query
    // never render under the new text while its debounce is pending.
    clearSearch()
    setQuery(value)
  }, [clearSearch])
  const closeSearch = useCallback(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = null
    handleSearchChange('')
    setSearchVisible(false)
    dismissSearchKeyboard()
  }, [dismissSearchKeyboard, handleSearchChange])
  const closeEmptySearch = useCallback(() => {
    if (!searchVisible || query.trim()) return
    closeSearch()
  }, [closeSearch, query, searchVisible])

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
  }, [clearSearch, needsServerSetup, profileScope, query, search, switchingProfileId])

  useEffect(() => {
    openingSearchResult.current = false
    setOpeningSearchResultId(null)
    setCollapsedStatuses(new Set())
  }, [profileScope])

  const retrySearch = useCallback(() => {
    const clean = serverSearchQuery(query)
    if (!clean || needsServerSetup || !profileScopeIsCurrent(profileScope)) return
    clearSearch()
    void search(clean, undefined, profileScope.profileGeneration)
  }, [clearSearch, needsServerSetup, profileScope, query, search])

  const refreshChats = useCallback(async () => {
    if (needsServerSetup || refreshingScope === profileScope || !profileScopeIsCurrent(profileScope)) return
    dismissSearchKeyboard()
    setRefreshingScope(profileScope)
    try {
      await refreshSessions(profileScope.profileGeneration)
    } catch (error) {
      if (profileScopeIsCurrent(profileScope)) Alert.alert('Could not refresh chats', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      // An old server's completion must not clear a newer server's spinner.
      setRefreshingScope(current => current === profileScope ? null : current)
    }
  }, [dismissSearchKeyboard, needsServerSetup, profileScope, refreshSessions, refreshingScope])

  const rows = useMemo(() => {
    if (needsServerSetup) return []
    const contentResults = new Map<string, TimelineSearchResult>()
    if (serverSearchQuery(query)) {
      for (const result of searchResults) {
        if (!contentResults.has(result.session_id)) contentResults.set(result.session_id, result)
      }
    }
    const matchedByContent = new Set(contentResults.keys())
    const clean = query.trim().toLowerCase()
    const filtered = clean
      ? sessions.filter(session => !isWelcomeSession(session.id) && (session.title.toLowerCase().includes(clean) || matchedByContent.has(session.id)))
          .sort((a, b) => Number(b.title.toLowerCase().includes(clean)) - Number(a.title.toLowerCase().includes(clean)))
      : sessions.filter(session => !isWelcomeSession(session.id))
    return sidebarSessionSections(filtered, active, folderOrder, !clean).flatMap<Row>(section => {
      const folder = section.id
      const values = section.sessions
      const isCollapsed = section.status ? collapsedStatuses.has(section.status) : collapsed.has(folder)
      return [
        { kind: 'header', key: section.status ? `header:status:${section.status}` : `header:folder:${folder}`, title: section.title, folder, status: section.status, attentionLevel: section.attentionLevel, count: values.length },
        ...((isCollapsed && !clean ? [] : values.map(session => ({
          kind: 'session' as const,
          key: session.id,
          session,
          status: section.status,
          // A visible title match is a request to open that chat at its live
          // position. Do not silently reinterpret the same row as an older
          // content hit merely because the server also found the query in its
          // transcript.
          searchResult: sidebarContentResult(session.title, clean, contentResults.get(session.id)),
        })))),
      ]
    })
  }, [active, collapsed, collapsedStatuses, folderOrder, needsServerSetup, query, searchResults, sessions])
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
        ) {
          closeSearch()
          onOpenChat?.()
        }
        return
      }
      // selectSession publishes the target synchronously, then hydrates and
      // reconciles its timeline. Open the mobile pane immediately instead of
      // making a row tap wait for a potentially slow history request.
      const selection = select(session.id, profileScope.profileGeneration)
      if (
        sessionScopeIsCurrent(profileScope, session.id)
        && useAppStore.getState().selectedSessionId === session.id
      ) {
        closeSearch()
        onOpenChat?.()
      }
      void selection
      return
    }
    openingSearchResult.current = true
    setOpeningSearchResultId(result.event_id)
    void seekTimelineResult(result, profileScope.profileGeneration).then(opened => {
      if (opened && sessionScopeIsCurrent(profileScope, session.id)) {
        closeSearch()
        onOpenChat?.()
      }
    }).finally(() => {
      openingSearchResult.current = false
      if (profileScopeIsCurrent(profileScope)) setOpeningSearchResultId(null)
    })
  }, [closeSearch, dismissSearchKeyboard, onOpenChat, profileScope, seekTimelineResult, select])
  const reorderNeighbors = useMemo(() => {
    const groups = new Map<string, Session[]>()
    for (const session of sessions) {
      if (sidebarSessionStatus(session, active)) continue
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
  }, [active, sessions])
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

  const searchField = searchVisible ? <View
    testID="sidebar-search-dock"
    onTouchEnd={event => event.stopPropagation()}
    style={[styles.searchDock, compact && { paddingBottom: spacing.sm + (keyboardVisible ? 0 : insets.bottom) }]}
  >
    <View style={[styles.search, { backgroundColor: colors.raised }]}>
      <Search size={18} color={colors.muted} />
      <TextInput
        ref={searchInput}
        autoFocus
        value={query}
        onChangeText={handleSearchChange}
        onBlur={closeEmptySearch}
        editable={!workspaceAdopting && !switchingProfileId}
        placeholder={workspaceAdopting ? 'Preparing server workspace…' : 'Search chats and history'}
        placeholderTextColor={colors.muted}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search chats and history"
        testID="sidebar-search-input"
        returnKeyType="search"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={() => {
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = null
          retrySearch()
          dismissSearchKeyboard()
        }}
        clearButtonMode={Platform.OS === 'ios' ? 'while-editing' : 'never'}
        style={[styles.searchInput, { color: colors.text }]}
      />
      {!needsServerSetup && searchBusy ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      <IconButton icon={X} label="Close search" testID="sidebar-search-close" onPress={closeSearch} />
    </View>
  </View> : null

  return (
    <KeyboardAvoidingView
      testID="sidebar"
      onTouchEnd={closeEmptySearch}
      style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }, !compact && styles.sidebarDivider]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      enabled={compact && searchVisible}
      automaticOffset={Platform.OS === 'android'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={styles.topRow}>
        <View style={styles.serverSelector}><ServerProfileSelector
          profiles={profiles}
          activeProfileId={activeProfileId}
          switchingProfileId={switchingProfileId}
          refreshing={refreshingScope === profileScope}
          disabled={workspaceAdopting}
          onPress={() => { if (profileScopeCanNavigate(profileScope)) onManageServers() }}
        /></View>
        <View style={styles.topActions}>
          <IconButton icon={FolderPlus} testID="sidebar-new-folder" disabled={workspaceAdopting || needsServerSetup || Boolean(switchingProfileId)} onPress={createFolder} label="New folder" />
          <Pressable
            testID="sidebar-search-open"
            onTouchEnd={event => event.stopPropagation()}
            accessibilityRole="button"
            accessibilityLabel={t('Search chat')}
            accessibilityState={{ expanded: searchVisible, disabled: workspaceAdopting || Boolean(switchingProfileId) }}
            disabled={workspaceAdopting || Boolean(switchingProfileId)}
            onPress={() => {
              if (!profileScopeIsCurrent(profileScope)) return
              setSearchVisible(true)
              searchInput.current?.focus()
            }}
            style={({ pressed }) => [styles.searchButton, { opacity: workspaceAdopting || switchingProfileId ? 0.4 : pressed ? 0.6 : 1 }]}
          >
            <Search size={18} color={colors.muted} strokeWidth={1.8} />
          </Pressable>
        </View>
      </View>
      {!compact ? searchField : null}
      {!needsServerSetup && searchError && serverSearchQuery(query) ? <View accessibilityRole="alert" style={styles.searchError}>
        <Text style={[styles.searchErrorText, { color: colors.red }]} localize>History search failed.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Retry history search')}
          testID="sidebar-search-retry"
          onPress={retrySearch}
          style={({ pressed }) => [styles.searchRetry, { borderColor: colors.red, opacity: pressed ? 0.6 : 1 }]}
        ><Text style={[styles.searchRetryText, { color: colors.red }]} localize>Retry</Text></Pressable>
      </View> : null}
      {/* Extend the viewport behind the fade; padding lets the final row scroll clear of it. */}
      <FlatList
        testID="sidebar-chat-list"
        style={styles.chatList}
        pointerEvents={workspaceAdopting ? 'none' : 'auto'}
        data={rows}
        extraData={listState}
        keyExtractor={item => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={Platform.OS === 'ios'}
        refreshing={refreshingScope === profileScope}
        onRefresh={workspaceAdopting || needsServerSetup || switchingProfileId ? undefined : refreshChats}
        onScrollBeginDrag={dismissSearchKeyboard}
        contentContainerStyle={[styles.list, needsServerSetup && styles.welcomeList, { paddingBottom: compact && searchVisible ? spacing.xl : HOME_ACTION_SIZE + spacing.lg + spacing.sm + spacing.xl + insets.bottom }]}
        ListEmptyComponent={needsServerSetup ? <View testID="sidebar-welcome" style={styles.welcome}>
          <Image source={require('../../assets/icon.png')} style={styles.welcomeIcon} />
          <Text style={[styles.welcomeTitle, { color: colors.text }]} localize>Welcome to AgentsDock</Text>
          <Pressable testID="sidebar-setup-server" accessibilityRole="button" accessibilityLabel={t('Set up your server')} onPress={() => { if (profileScopeCanNavigate(profileScope)) onAddServer() }} style={({ pressed }) => [styles.setupBanner, { backgroundColor: colors.blue, opacity: pressed ? 0.85 : 1 }]}>
            <Server size={16} color={colors.onAccent} />
            <Text style={[styles.setupBannerText, { color: colors.onAccent }]} localize>Set up your server</Text>
          </Pressable>
        </View> : query.trim() ? <Text style={[styles.emptySearch, { color: colors.muted }]}>{t(searchBusy ? 'Searching history…' : 'No matching chats')}</Text> : null}
        renderItem={({ item }) => item.kind === 'header' ? <FolderHeader
          item={item}
          profileScope={profileScope}
          collapsed={!query.trim() && (item.status ? collapsedStatuses.has(item.status) : collapsed.has(item.folder))}
          canMoveUp={movableFolders.indexOf(item.folder) > 0}
          canMoveDown={movableFolders.indexOf(item.folder) >= 0 && movableFolders.indexOf(item.folder) < movableFolders.length - 1}
          onDismissKeyboard={dismissSearchKeyboard}
          onToggle={() => {
            if (!profileScopeIsCurrent(profileScope)) return
            const status = item.status
            if (status) {
              setCollapsedStatuses(current => {
                const next = new Set(current)
                if (next.has(status)) next.delete(status)
                else next.add(status)
                return next
              })
              return
            }
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
            running={active.has(item.session.id)}
            searchSnippet={item.searchResult?.snippet}
            opening={openingSearchResultId === item.searchResult?.event_id}
            folders={folders}
            canMoveUp={!item.status && Boolean(previousId)}
            canMoveDown={!item.status && Boolean(nextId)}
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
      {!(compact && searchVisible) ? <View
        testID="sidebar-footer-fade"
        pointerEvents="none"
        accessible={false}
        style={[styles.footerFade, { height: HOME_ACTION_SIZE + spacing.lg + spacing.sm + spacing.xl + insets.bottom }]}
      >
        <Svg width="100%" height="100%" accessible={false}>
          <Defs>
            <LinearGradient id="home-footer-fade" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%" stopColor={colors.homeFooter} stopOpacity={0} />
              <Stop offset="60%" stopColor={colors.homeFooter} stopOpacity={0.65} />
              <Stop offset="100%" stopColor={colors.homeFooter} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#home-footer-fade)" />
        </Svg>
      </View> : null}
      {compact && searchVisible ? searchField : <View testID="sidebar-footer" pointerEvents="box-none" style={[styles.footer, { bottom: insets.bottom + spacing.sm }]}>
        <Pressable
          testID="sidebar-settings"
          accessibilityRole="button"
          accessibilityLabel={t('Settings')}
          accessibilityState={{ disabled: workspaceAdopting || Boolean(switchingProfileId) }}
          disabled={workspaceAdopting || Boolean(switchingProfileId)}
          onPress={() => { if (profileScopeIsCurrent(profileScope)) onSettings() }}
          style={({ pressed }) => [styles.homeAction, { backgroundColor: pressed ? colors.raised : colors.controlSurface, borderColor: colors.controlBorder, opacity: workspaceAdopting || switchingProfileId ? 0.35 : pressed ? 0.65 : 1 }]}
        ><Settings size={22} color={colors.text} strokeWidth={1.8} /></Pressable>
        <Pressable
          testID="sidebar-new-chat"
          accessibilityRole="button"
          accessibilityLabel={t('New chat')}
          accessibilityState={{ disabled: workspaceAdopting || needsServerSetup || Boolean(switchingProfileId) }}
          disabled={workspaceAdopting || needsServerSetup || Boolean(switchingProfileId)}
          onPress={() => { if (profileScopeIsCurrent(profileScope)) onNewChat() }}
          style={({ pressed }) => [styles.homeAction, { backgroundColor: pressed ? colors.raised : colors.controlSurface, borderColor: colors.controlBorder, opacity: workspaceAdopting || needsServerSetup || switchingProfileId ? 0.35 : pressed ? 0.65 : 1 }]}
        ><Plus size={24} color={colors.text} strokeWidth={2} /></Pressable>
      </View>}
      {textPromptDialog}
    </KeyboardAvoidingView>
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
  const movable = !item.status && !['Pinned', 'General', 'Archived'].includes(item.folder)
  const displayTitle = item.status || !movable ? t(item.title) : item.title
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
      options: [...available.map(action => t(action.title)), t('Cancel')],
      cancelButtonIndex,
    }, index => {
      const action = available[index]
      if (action && profileScopeIsCurrent(profileScope)) onMove(action.direction)
    })
  }
  const header = <Pressable
    testID={item.status ? `sidebar-status-${item.status}` : `sidebar-folder-${item.folder}`}
    accessibilityRole="button"
    accessibilityLabel={`${t(collapsed ? 'Expand' : 'Collapse')} ${displayTitle}`}
    accessibilityState={{ expanded: !collapsed }}
    accessibilityHint={movable && Platform.OS === 'ios' ? 'Long press to reorder this folder.' : undefined}
    onPress={() => { onDismissKeyboard(); onToggle() }}
    onLongPress={movable && Platform.OS === 'ios' ? openMoveSheet : undefined}
    delayLongPress={350}
    style={[styles.header, movable && Platform.OS !== 'ios' && styles.headerInShell]}
  >
    {item.status ? <View style={[styles.statusGroupDot, { backgroundColor: item.status === 'running' ? colors.green : item.attentionLevel === 'emergency' ? colors.red : item.attentionLevel === 'important' ? colors.pink : colors.blue }]} /> : null}
    <Text style={[styles.headerText, { color: colors.muted }]}>{displayTitle}</Text>
    <View style={styles.headerTrailing}>
      <Text style={[styles.count, { color: colors.muted }]}>{item.count}</Text>
      {collapsed ? <ChevronRight size={13} color={colors.muted} /> : <ChevronDown size={13} color={colors.muted} />}
    </View>
  </Pressable>
  if (!movable || Platform.OS === 'ios') return header
  return <View style={styles.folderHeaderShell}>{header}<AndroidMoreMenu testID={`folder-actions-${item.folder}`} label={`${item.title} folder actions`} title={item.title} color={colors.muted} actions={[
    { id: 'move-up', title: t('Move Folder Up'), image: 'arrow.up', attributes: { disabled: !canMoveUp } },
    { id: 'move-down', title: t('Move Folder Down'), image: 'arrow.down', attributes: { disabled: !canMoveDown } },
  ]} onAction={action => {
    if (!profileScopeIsCurrent(profileScope)) return
    if (action === 'move-up') onMove('up')
    if (action === 'move-down') onMove('down')
  }} /></View>
}

function SessionRow({ session, profileScope, running, searchSnippet, opening, folders, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onDismissKeyboard, onPress, promptText }: {
  session: Session
  profileScope: ProfileScope
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
  const locale = useLanguageStore(state => state.locale)
  const welcome = isWelcomeSession(session.id)
  const unread = isUnread(session)
  const attentionLevel = sessionAttentionLevel(session)
  const attentionColor = attentionLevel === 'emergency' ? colors.red : attentionLevel === 'important' ? colors.pink : colors.blue
  const waiting = sessionNeedsProviderInteraction(session)
  const pendingInteractionCount = sessionPendingInteractionCount(session)
  const waitingProviderName = session.backend === 'gemini' ? 'Gemini' : session.backend === 'claude' ? 'Claude' : 'Codex'
  const activityDate = formatChatDate(session.latest_event_at ?? session.updated_at ?? session.created_at, new Date(), locale)
  const markRead = useAppStore(state => state.markRead)
  const markUnread = useAppStore(state => state.markUnread)
  const update = useAppStore(state => state.updateSession)
  const fork = useAppStore(state => state.forkSession)
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
    Alert.alert(t('Delete chat?'), t('“{title}” and its AgentsDock history will be removed. Provider history is not deleted.', { title: session.title }), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete chat'), style: 'destructive', onPress: () => {
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
    { id: 'read-state', title: t(unread ? 'Mark as Read' : 'Mark as Unread'), image: unread ? 'envelope.open' : 'envelope.badge' },
    { id: 'rename', title: t('Rename Chat'), image: 'pencil' },
    { id: 'primary-actions', title: '', displayInline: true, subactions: [
      { id: 'fork', title: t('Fork Chat'), image: 'arrow.triangle.branch' },
      { id: 'move-up', title: t('Move Up'), image: 'arrow.up', attributes: { disabled: !canMoveUp } },
      { id: 'move-down', title: t('Move Down'), image: 'arrow.down', attributes: { disabled: !canMoveDown } },
    ] },
    ...(session.archived ? [] : [
      { id: 'pin', title: t(session.pinned ? 'Unpin Chat' : 'Pin Chat'), image: session.pinned ? 'pin.slash' : 'pin' } satisfies MenuAction,
      { id: 'move-folder', title: t('Move to Folder'), image: 'folder', subactions: folderActions } satisfies MenuAction,
    ]),
    { id: 'archive', title: t(session.archived ? 'Unarchive Chat' : 'Archive Chat'), image: 'archivebox' },
    { id: 'delete', title: t('Delete Chat'), image: 'trash', attributes: { destructive: true } },
  ]
  const openFolderSheet = () => {
    const scope = profileScope
    if (!sessionScopeIsCurrent(scope, session.id)) return
    onDismissKeyboard()
    const cancelButtonIndex = folders.length
    const currentFolder = session.folder?.trim() || 'General'
    ActionSheetIOS.showActionSheetWithOptions({
      title: t('Move to Folder'),
      message: session.title,
      options: [...folders.map(folder => folder === currentFolder && !session.pinned ? `✓ ${folder}` : folder), t('Cancel')],
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
      options: [...sheetActions.map(action => t(action.title)), t('Cancel')],
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
      accessibilityState={{ disabled: opening }}
      disabled={opening}
      delayLongPress={350}
      onLongPress={!welcome && Platform.OS === 'ios' ? openActionSheet : undefined}
      onPress={() => {
        if (!sessionScopeIsCurrent(profileScope, session.id)) return
        onPress()
      }}
      style={({ pressed }) => [styles.session, Platform.OS !== 'ios' && styles.sessionInShell, {
        backgroundColor: pressed ? colors.raised : colors.background,
      }]}
    >
      <View style={styles.backendStatus}>{welcome ? <Image source={require('../../assets/icon.png')} resizeMode="contain" style={{ width: 22, height: 22, borderRadius: radius.md }} /> : <BackendMark backend={session.backend} size={22} />}</View>
      <View style={styles.sessionText}>
        <Text style={[styles.sessionTitle, { color: colors.text }]} numberOfLines={1}>{session.title}</Text>
        <View style={styles.sessionMetaRow}>
          <Text style={[styles.sessionMeta, { color: attentionLevel ? attentionColor : colors.muted }]} numberOfLines={1}>
            {welcome ? t('Local setup guide') : (searchSnippet || (waiting ? `${runtimeSummary(session, t)} · ${t('waiting for you')}` : running ? `${runtimeSummary(session, t)} · ${t('running')}` : unread ? `${runtimeSummary(session, t)} · ${t('new')}` : runtimeSummary(session, t)))}
          </Text>
          {(attentionLevel === 'important' || attentionLevel === 'emergency') ? <Text style={[styles.sessionLevel, { color: attentionColor }]} numberOfLines={1}>
            {t(attentionLevel === 'emergency' ? 'Emergency' : 'Important')}
          </Text> : activityDate ? <Text style={[styles.sessionDate, { color: colors.subtle }]} numberOfLines={1}>{activityDate}</Text> : null}
        </View>
      </View>
      {attentionLevel === 'emergency' ? <View
        accessibilityLabel="Emergency alert needs acknowledgment"
        style={[styles.trailingStatusDot, { backgroundColor: colors.red }]}
      /> : waiting ? <View
        accessibilityLabel={`${pendingInteractionCount} ${waitingProviderName} ${pendingInteractionCount === 1 ? 'request' : 'requests'} waiting for you`}
        style={[styles.waitingBadge, { backgroundColor: colors.pink }]}
      ><Text style={[styles.waitingBadgeText, { color: colors.background }]}>{pendingInteractionCount > 9 ? '9+' : pendingInteractionCount}</Text></View> : (running || attentionLevel) ? <View
        accessibilityLabel={running && attentionLevel !== 'important' ? 'Agent running' : attentionLevel === 'important' ? 'Important unread message' : 'Unread messages'}
        style={[styles.trailingStatusDot, { backgroundColor: attentionLevel === 'important' ? colors.pink : running ? colors.green : colors.blue }]}
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
  statusGroupDot: { width: 8, height: 8, borderRadius: radius.round, flexShrink: 0 },
  root: { flex: 1, minWidth: 250 },
  sidebarDivider: { borderRightWidth: StyleSheet.hairlineWidth },
  topActions: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  topRow: { minHeight: 44, marginHorizontal: spacing.lg, marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  serverSelector: { flex: 1, maxWidth: '50%', minWidth: 0 },
  searchButton: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  welcomeList: { flexGrow: 1 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.lg },
  welcomeIcon: { width: 56, height: 56, borderRadius: radius.md },
  welcomeTitle: { ...typography.heading, fontWeight: fontWeight.semibold, textAlign: 'center' },
  setupBanner: { minHeight: 44, borderRadius: radius.md, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  setupBannerText: { ...typography.label, fontWeight: fontWeight.semibold },
  searchDock: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  search: { minHeight: 48, borderRadius: radius.md, paddingLeft: spacing.md, paddingRight: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchInput: { ...typography.body, flex: 1, minWidth: 0, paddingVertical: 0 },
  searchError: { minHeight: 44, marginHorizontal: spacing.md, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchErrorText: { ...typography.caption, flex: 1 },
  searchRetry: { minWidth: 64, minHeight: 44, paddingHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  searchRetryText: { ...typography.label, fontWeight: fontWeight.semibold },
  chatList: { flex: 1 },
  list: { flexGrow: 1, paddingHorizontal: spacing.sm, paddingBottom: spacing.xl },
  emptySearch: { ...typography.body, textAlign: 'center', padding: spacing.xl },
  folderHeaderShell: { minHeight: 44, flexDirection: 'row', alignItems: 'stretch' },
  header: { minHeight: 44, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  headerInShell: { flex: 1 },
  headerText: { ...typography.caption, flex: 1, fontWeight: fontWeight.semibold },
  headerTrailing: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  count: { ...typography.caption },
  sessionShell: { minHeight: 64, flexDirection: 'row', alignItems: 'stretch', gap: spacing.xs },
  session: { minHeight: 64, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.md, overflow: 'hidden' },
  sessionInShell: { flex: 1 },
  moreMenuTrigger: { width: 44, minHeight: 44 },
  moreButton: { width: 44, minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center' },
  sessionText: { flex: 1, minWidth: 0 },
  sessionTitle: { ...typography.body, fontWeight: fontWeight.semibold },
  sessionMetaRow: { marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sessionMeta: { ...typography.caption, flex: 1, minWidth: 0 },
  sessionDate: { ...typography.caption, fontWeight: fontWeight.regular, flexShrink: 1, maxWidth: '48%' },
  sessionLevel: { ...typography.caption, fontWeight: fontWeight.semibold, flexShrink: 0 },
  backendStatus: { width: 22, height: 22 },
  trailingStatusDot: { width: 8, height: 8, flexShrink: 0, marginHorizontal: 4, borderRadius: radius.round },
  waitingBadge: { minWidth: 24, minHeight: 24, flexShrink: 0, paddingHorizontal: spacing.xs, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  waitingBadgeText: { ...typography.caption, fontWeight: fontWeight.semibold },
  footer: { position: 'absolute', left: spacing.lg, right: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerFade: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  homeAction: { width: HOME_ACTION_SIZE, height: HOME_ACTION_SIZE, borderRadius: radius.round, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
})
