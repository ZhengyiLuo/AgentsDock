import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')

test('sidebar list invalidates status rows without presenting a persistent selection', () => {
  assert.match(source, /const listState = useMemo\(\(\) => \(\{ active, openingSearchResultId \}\)/)
  assert.match(source, /<FlatList[\s\S]*?extraData=\{listState\}/)
  assert.match(source, /accessibilityState=\{\{ disabled: opening \}\}/)
  assert.doesNotMatch(source, /selected=\{selected === item\.session\.id\}|selected: boolean/)
})

test('temporary status sections have isolated collapse state and cannot be moved like real folders', () => {
  assert.match(source, /sidebarSessionSections\(filtered, active, folderOrder, !clean\)/)
  assert.match(source, /header:status:\$\{section\.status\}/)
  assert.match(source, /header:folder:\$\{folder\}/)
  assert.match(source, /const movable = !item\.status &&/)
  assert.match(source, /if \(sidebarSessionStatus\(session, active\)\) continue/)
  assert.match(source, /if \(status\) \{[\s\S]*?setCollapsedStatuses\([\s\S]*?return\s*\}\s*const next = new Set\(collapsed\)/)
  assert.match(source, /item\.status === 'running' \? colors\.green : item\.attentionLevel === 'emergency' \? colors\.red : item\.attentionLevel === 'important' \? colors\.pink : colors\.blue/)
  const folderOptions = source.slice(source.indexOf('const folders = useMemo'), source.indexOf('const movableFolders'))
  assert.doesNotMatch(folderOptions, /SidebarStatus|collapsedStatuses|sidebarSessionSections/)
})

test('urgent chat labels replace the date and name their status', () => {
  const row = source.slice(source.indexOf('function SessionRow'), source.indexOf('const styles = StyleSheet.create'))
  assert.match(row, /\{\(attentionLevel === 'important' \|\| attentionLevel === 'emergency'\)[\s\S]*?<\/Text> : activityDate \? <Text[^>]+>\{activityDate\}<\/Text> : null\}/)
  assert.match(row, /t\(attentionLevel === 'emergency' \? 'Emergency' : 'Important'\)/)
  assert.match(source, /sessionLevel: \{ \.\.\.typography\.caption, fontWeight: fontWeight\.semibold/)
})

test('folder and status headers put the collapse indicator after the count on the right', () => {
  const header = source.slice(source.indexOf('const header = <Pressable'), source.indexOf('if (!movable || Platform.OS'))
  assert.ok(header.indexOf('styles.headerText') < header.indexOf('styles.headerTrailing'))
  assert.ok(header.indexOf('styles.count') < header.indexOf('<ChevronRight'))
  assert.equal((header.match(/<ChevronRight/g) ?? []).length, 1)
  assert.equal((header.match(/<ChevronDown/g) ?? []).length, 1)
  assert.match(header, /accessibilityState=\{\{ expanded: !collapsed \}\}/)
  assert.match(header, /onPress=\{\(\) => \{ onDismissKeyboard\(\); onToggle\(\) \}\}/)
  assert.match(source, /headerTrailing: \{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing\.sm \}/)
})

test('chat taps on both platforms stay on a plain native press target', () => {
  const rowPress = source.match(/const pressableRow = \(([\s\S]*?)\n  \)\n  \/\/ The chat identity/)?.[1] ?? ''
  assert.match(rowPress, /if \(!sessionScopeIsCurrent\(profileScope, session\.id\)\) return[\s\S]*?onPress\(\)/)
  assert.match(source, /onLongPress=\{!welcome && Platform\.OS === 'ios' \? openActionSheet : undefined\}/)
  assert.match(source, /if \(welcome \|\| Platform\.OS === 'ios'\) return pressableRow/)
  assert.doesNotMatch(source, /from 'react-native-gesture-handler\/ReanimatedSwipeable'|<ReanimatedSwipeable|SwipeableMethods/)
  assert.doesNotMatch(source, /<MenuView[^>]*>\{pressableRow\}<\/MenuView>/)
})

test('Android chat and folder actions use adjacent controls instead of wrapping row taps', () => {
  assert.match(source, /<View style=\{styles\.sessionShell\}>\{pressableRow\}<AndroidMoreMenu/)
  assert.match(source, /testID=\{`chat-actions-\$\{session\.id\}`\}/)
  assert.match(source, /label=\{`\$\{session\.title\} chat actions`\}/)
  assert.match(source, /<View style=\{styles\.folderHeaderShell\}>\{header\}<AndroidMoreMenu/)
  assert.match(source, /testID=\{`folder-actions-\$\{item\.folder\}`\}/)
  assert.match(source, /onPress=\{\(\) => menu\.current\?\.show\(\)\}/)
})

test('closed chat rows fully cover their action surfaces', () => {
  assert.match(source, /backgroundColor: pressed \? colors\.raised : colors\.background/)
  assert.match(source, /session: \{ minHeight: 64,[^}]*overflow: 'hidden' \}/)
  assert.match(source, /sessionInShell: \{ flex: 1 \}/)
  assert.match(source, /moreButton: \{ width: 44, minHeight: 44/)
})

test('ordinary chat selection opens the pane before timeline synchronization settles', () => {
  assert.match(source, /const selection = select\(session\.id, profileScope\.profileGeneration\)[\s\S]*?useAppStore\.getState\(\)\.selectedSessionId === session\.id[\s\S]*?onOpenChat\?\.\(\)[\s\S]*?void selection/)
  assert.doesNotMatch(source, /select\(session\.id, profileScope\.profileGeneration\)\.then\([\s\S]*?onOpenChat/)
})

test('chat rows have press feedback but no selected background or blue rail', () => {
  assert.doesNotMatch(source, /selectedIndicator|backgroundColor: selected|selected \|\| pressed/)
  assert.match(source, /backgroundColor: pressed \? colors\.raised : colors\.background/)
})

test('provider requests waiting for the user are unmistakable without polling', () => {
  assert.match(source, /waiting \? `\$\{runtimeSummary\(session, t\)\} · \$\{t\('waiting for you'\)\}`/)
  assert.match(source, /const waitingProviderName = session\.backend === 'gemini' \? 'Gemini' : session\.backend === 'claude' \? 'Claude' : 'Codex'/)
  assert.match(source, /accessibilityLabel=\{`\$\{pendingInteractionCount\} \$\{waitingProviderName\} \$\{pendingInteractionCount === 1 \? 'request' : 'requests'\} waiting for you`\}/)
  assert.match(source, /style=\{\[styles\.waitingBadge, \{ backgroundColor: colors\.pink \}\]\}/)
  assert.doesNotMatch(source, /setInterval|setTimeout\([^)]*codex|pollCodex/i)
})

test('home removes the brand title and aggregate chat counters', () => {
  assert.doesNotMatch(source, />AgentsDock<\/Text>|styles\.titleRow/)
  assert.doesNotMatch(source, /\{sessions\.length\} chats|\{active\.size\} active|waitingSessionCount|footerDot/)
})

test('home floats two circular actions without a full-width footer surface', () => {
  const footer = source.match(/<View testID="sidebar-footer"([\s\S]*?)<\/View>/)?.[1] ?? ''
  assert.match(footer, /pointerEvents="box-none"/)
  assert.match(footer, /bottom: insets\.bottom \+ spacing\.sm/)
  assert.match(footer, /onPress=\{\(\) => \{ if \(profileScopeIsCurrent\(profileScope\)\) onSettings\(\) \}\}/)
  assert.match(footer, /testID="sidebar-settings"[\s\S]*?<Settings/)
  assert.match(footer, /testID="sidebar-new-chat"[\s\S]*?onNewChat\(\)[\s\S]*?<Plus/)
  assert.equal((source.match(/testID="sidebar-settings"/g) ?? []).length, 1)
  assert.equal((source.match(/testID="sidebar-new-chat"/g) ?? []).length, 1)
  assert.doesNotMatch(footer, /<Text/)
  const footerStyle = source.match(/footer: \{([^}]+)\}/)?.[1] ?? ''
  assert.doesNotMatch(footerStyle, /border|backgroundColor/)
  assert.match(footerStyle, /position: 'absolute'.*justifyContent: 'space-between'/)
  assert.match(source, /homeAction: \{ width: HOME_ACTION_SIZE, height: HOME_ACTION_SIZE, borderRadius: radius\.round, borderWidth: 1/)
  assert.equal((footer.match(/borderColor: colors\.controlBorder/g) ?? []).length, 2)
  assert.equal((footer.match(/backgroundColor: pressed \? colors\.raised : colors\.controlSurface/g) ?? []).length, 2)
  assert.match(source, /testID="sidebar-chat-list"\s+style=\{styles\.chatList\}/)
  assert.match(source, /contentContainerStyle=\{\[styles\.list, needsServerSetup && styles\.welcomeList, \{ paddingBottom: compact && searchVisible \? spacing\.xl : HOME_ACTION_SIZE \+ spacing\.lg \+ spacing\.sm \+ spacing\.xl \+ insets\.bottom/)
  assert.doesNotMatch(source.match(/chatList: \{([^}]+)\}/)?.[1] ?? '', /marginBottom|paddingBottom/)
  const topActions = source.match(/<View style=\{styles\.actions\}>([\s\S]*?)<\/View>/)?.[1] ?? ''
  assert.doesNotMatch(topActions, /sidebar-new-chat|icon=\{Plus\}/)
})

test('chat dates keep the activity source but use compact calendar labels and a shared subtle style', () => {
  assert.match(source, /formatChatDate\(session\.latest_event_at \?\? session\.updated_at \?\? session\.created_at, new Date\(\), locale\)/)
  assert.match(source, /styles\.sessionDate, \{ color: colors\.subtle \}/)
  assert.match(source, /sessionDate: \{ \.\.\.typography\.caption, fontWeight: fontWeight\.regular/)
  assert.doesNotMatch(source, /formatChatDateTime/)
})

test('home puts the server title first and replaces the refresh button with pull to refresh', () => {
  assert.match(source, /<KeyboardAvoidingView[\s\S]*?<View style=\{styles\.topRow\}>\s*<View style=\{styles\.serverSelector\}>/)
  assert.match(source, /serverSelector: \{ flex: 1, maxWidth: '50%', minWidth: 0 \}/)
  assert.doesNotMatch(source, /RefreshCw|label="Refresh chats"/)
  assert.match(source, /refreshing=\{refreshingScope === profileScope\}/)
  assert.match(source, /<ServerProfileSelector[\s\S]*?refreshing=\{refreshingScope === profileScope\}/)
  assert.match(source, /onRefresh=\{workspaceAdopting \|\| needsServerSetup \|\| switchingProfileId \? undefined : refreshChats\}/)
  assert.match(source, /list: \{ flexGrow: 1/)
  assert.match(source, /if \(needsServerSetup \|\| refreshingScope === profileScope \|\| !profileScopeIsCurrent\(profileScope\)\) return/)
  assert.match(source, /await refreshSessions\(profileScope\.profileGeneration\)/)
  assert.match(source, /finally \{[\s\S]*?setRefreshingScope\(current => current === profileScope \? null : current\)/)
})

test('top-right search opens a focused field and closing it clears the filter', () => {
  const searchButton = source.match(/testID="sidebar-search-open"([\s\S]*?)<\/Pressable>/)?.[1] ?? ''
  assert.match(searchButton, /accessibilityLabel=\{t\('Search chat'\)\}/)
  assert.match(searchButton, /<Search size=\{18\}/)
  assert.doesNotMatch(searchButton, /<Text/)
  assert.match(source, /searchButton: \{ width: 44, height: 44/)
  assert.match(source, /const \[searchVisible, setSearchVisible\] = useState\(false\)/)
  assert.match(source, /testID="sidebar-search-open"[\s\S]*?setSearchVisible\(true\)[\s\S]*?searchInput\.current\?\.focus\(\)/)
  assert.match(source, /const searchField = searchVisible \? <View[\s\S]*?<TextInput\s+ref=\{searchInput\}\s+autoFocus/)
  assert.match(source, /testID="sidebar-search-close" onPress=\{closeSearch\}/)
  assert.match(source, /const closeSearch = useCallback\(\(\) => \{[\s\S]*?handleSearchChange\(''\)[\s\S]*?setSearchVisible\(false\)[\s\S]*?dismissSearchKeyboard\(\)/)
})

test('new folder shares the top row to the left of search with wider spacing', () => {
  assert.match(source, /<View style=\{styles\.topActions\}>\s*<IconButton icon=\{FolderPlus\} testID="sidebar-new-folder"[\s\S]*?testID="sidebar-search-open"/)
  assert.match(source, /topActions: \{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: spacing\.lg \}/)
  assert.doesNotMatch(source, /styles\.actions/)
})

test('empty search closes on outside taps or blur without dismissing typed queries', () => {
  assert.match(source, /const closeEmptySearch = useCallback\(\(\) => \{\s*if \(!searchVisible \|\| query\.trim\(\)\) return\s*closeSearch\(\)/)
  assert.match(source, /testID="sidebar"\s+onTouchEnd=\{closeEmptySearch\}/)
  assert.match(source, /onBlur=\{closeEmptySearch\}/)
  for (const id of ['sidebar-search-dock', 'sidebar-search-open']) {
    assert.match(source, new RegExp(`testID="${id}"\\s+onTouchEnd=\\{event => event\\.stopPropagation\\(\\)\\}`))
  }
  assert.doesNotMatch(source, /onTouchStart=\{closeEmptySearch\}|onStartShouldSetResponderCapture/)
})

test('footer fades vertically from transparent to theme shade without capturing touches', () => {
  assert.match(source, /testID="sidebar-footer-fade"\s+pointerEvents="none"\s+accessible=\{false\}/)
  assert.match(source, /<LinearGradient id="home-footer-fade" x1="0%" y1="0%" x2="0%" y2="100%">/)
  assert.match(source, /<Stop offset="0%" stopColor=\{colors\.homeFooter\} stopOpacity=\{0\}/)
  assert.match(source, /<Stop offset="100%" stopColor=\{colors\.homeFooter\} stopOpacity=\{1\}/)
  assert.match(source, /footerFade: \{ position: 'absolute', bottom: 0, left: 0, right: 0 \}/)
})

test('phone search sits below results and follows the keyboard without covering rows', () => {
  assert.match(source, /<KeyboardAvoidingView[\s\S]*?enabled=\{compact && searchVisible\}/)
  assert.match(source, /keyboardVerticalOffset=\{Platform\.OS === 'ios' \? insets\.top : 0\}/)
  assert.match(source, /automaticOffset=\{Platform\.OS === 'android'\}/)
  assert.match(source, /\{!compact \? searchField : null\}[\s\S]*?<FlatList[\s\S]*?\{compact && searchVisible \? searchField : <View testID="sidebar-footer"/)
  assert.match(source, /paddingBottom: spacing\.sm \+ \(keyboardVisible \? 0 : insets\.bottom\)/)
  assert.match(source, /returnKeyType="search"/)
  assert.match(source, /onSubmitEditing=\{\(\) => \{[\s\S]*?clearTimeout\(searchTimer\.current\)[\s\S]*?retrySearch\(\)[\s\S]*?dismissSearchKeyboard\(\)/)
  assert.match(source, /keyboardShouldPersistTaps="handled"/)
})

test('home shares the safe-area background instead of drawing a separate panel', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8')
  assert.match(app, /<SafeAreaView style=\{\{ flex: 1, backgroundColor: colors\.background \}\}/)
  assert.match(source, /styles\.root, \{ backgroundColor: colors\.background/)
  assert.match(source, /!compact && styles\.sidebarDivider/)
})

test('renaming a chat is offered on both platforms and shares one prompt/update path', () => {
  assert.match(source, /const requestRename = \(\) => \{[\s\S]*?promptText\(\{[\s\S]*?title: 'Rename Chat',[\s\S]*?initialValue: session\.title,[\s\S]*?confirmLabel: 'Rename',[\s\S]*?\}\)\.then\(value => \{[\s\S]*?if \(!sessionScopeIsCurrent\(scope, session\.id\)\) return[\s\S]*?const name = value\?\.trim\(\)[\s\S]*?if \(name && name !== session\.title\) void update\(session\.id, \{ title: name \}, scope\.profileGeneration\)/)
  assert.match(source, /else if \(id === 'rename'\) requestRename\(\)/)
  assert.match(source, /\{ id: 'rename', title: t\('Rename Chat'\), image: 'pencil' \}/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Chat' \}/)
  assert.match(source, /promptText: \(options: TextPromptOptions\) => Promise<string \| null>/)
})
