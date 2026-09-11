import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')

test('sidebar list explicitly invalidates recycled rows when selection changes', () => {
  assert.match(source, /const listState = useMemo\(\(\) => \(\{ active, selected, openingSearchResultId \}\)/)
  assert.match(source, /<FlatList[\s\S]*?extraData=\{listState\}/)
  assert.match(source, /accessibilityState=\{\{ selected, disabled: opening \}\}/)
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
  assert.match(source, /backgroundColor: selected \? `\$\{colors\.blue\}22` : pressed \? colors\.raised : colors\.surface/)
  assert.match(source, /session: \{ minHeight: 51,[^}]*overflow: 'hidden' \}/)
  assert.match(source, /sessionInShell: \{ flex: 1 \}/)
  assert.match(source, /moreButton: \{ width: 44, minHeight: 44/)
})

test('ordinary chat selection opens the pane before timeline synchronization settles', () => {
  assert.match(source, /const selection = select\(session\.id, profileScope\.profileGeneration\)[\s\S]*?useAppStore\.getState\(\)\.selectedSessionId === session\.id[\s\S]*?onOpenChat\?\.\(\)[\s\S]*?void selection/)
  assert.doesNotMatch(source, /select\(session\.id, profileScope\.profileGeneration\)\.then\([\s\S]*?onOpenChat/)
})

test('selected chat has a persistent visual indicator', () => {
  assert.match(source, /selected \? <View pointerEvents="none" style=\{\[styles\.selectedIndicator/)
  assert.match(source, /borderColor: selected \? `\$\{colors\.blue\}88` : 'transparent'/)
})

test('provider requests waiting for the user are unmistakable without polling', () => {
  assert.match(source, /const waitingSessionCount = useMemo\(\(\) => sessions\.filter\(sessionNeedsProviderInteraction\)\.length, \[sessions\]\)/)
  assert.match(source, /waiting \? `\$\{runtimeSummary\(session\)\} · waiting for you`/)
  assert.match(source, /const waitingProviderName = session\.backend === 'claude' \? 'Claude' : 'Codex'/)
  assert.match(source, /accessibilityLabel=\{`\$\{pendingInteractionCount\} \$\{waitingProviderName\} \$\{pendingInteractionCount === 1 \? 'request' : 'requests'\} waiting for you`\}/)
  assert.match(source, /style=\{\[styles\.waitingBadge, \{ backgroundColor: colors\.orange \}\]\}/)
  assert.match(source, />\{waitingSessionCount\} waiting<\/Text>/)
  assert.doesNotMatch(source, /setInterval|setTimeout\([^)]*codex|pollCodex/i)
})

test('renaming a chat is offered on both platforms and shares one prompt/update path', () => {
  assert.match(source, /const requestRename = \(\) => \{[\s\S]*?promptText\(\{[\s\S]*?title: 'Rename Chat',[\s\S]*?initialValue: session\.title,[\s\S]*?confirmLabel: 'Rename',[\s\S]*?\}\)\.then\(value => \{[\s\S]*?if \(!sessionScopeIsCurrent\(scope, session\.id\)\) return[\s\S]*?const name = value\?\.trim\(\)[\s\S]*?if \(name && name !== session\.title\) void update\(session\.id, \{ title: name \}, scope\.profileGeneration\)/)
  assert.match(source, /else if \(id === 'rename'\) requestRename\(\)/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Chat', image: 'pencil' \}/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Chat' \}/)
  assert.match(source, /promptText: \(options: TextPromptOptions\) => Promise<string \| null>/)
})
