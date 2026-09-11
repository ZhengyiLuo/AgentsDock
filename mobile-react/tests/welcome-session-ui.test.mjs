import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const appShell = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8')
const chatHeader = readFileSync(new URL('../src/components/ChatHeader.tsx', import.meta.url), 'utf8')
const chatScreen = readFileSync(new URL('../src/components/ChatScreen.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store/useAppStore.ts', import.meta.url), 'utf8')

test('first launch exposes a local welcome chat without a blocking setup sheet', () => {
  assert.match(appShell, /const \[setupDismissed, setSetupDismissed\] = useState\(true\)/)
  assert.match(appShell, /welcomeWorkspacePatch\(useAppStore\.getState\(\), needsSetup\)/)
  assert.match(appShell, /onSetupServer=\{\(\) => openServers\('add'\)\}/)
  assert.match(sidebar, /testID="sidebar-setup-server"[\s\S]*?onAddServer\(\)/)
  assert.match(chatHeader, /if \(isWelcomeSession\(sessionId\)\) return[\s\S]*?testID="welcome-setup-server"/)
})

test('the welcome surface has no server-backed dead controls or requests', () => {
  assert.match(chatScreen, /const welcome = isWelcomeSession\(sessionId\)/)
  assert.match(chatScreen, /if \(welcome\) return content[\s\S]*?CodexRuntimeProvider/)
  assert.match(chatScreen, /!welcome \? <CodexInteractionShelf/)
  assert.match(chatScreen, /!welcome \? <ClaudeInteractionShelf/)
  assert.match(sidebar, /if \(!clean \|\| needsServerSetup\)[\s\S]*?clearSearch\(\)[\s\S]*?return/)
  assert.match(sidebar, /onLongPress=\{!welcome && Platform\.OS === 'ios' \? openActionSheet : undefined\}/)
  assert.match(sidebar, /if \(welcome \|\| Platform\.OS === 'ios'\) return pressableRow/)
  assert.match(sidebar, /if \(isWelcomeSession\(session\.id\)\) \{[\s\S]*?selectedSessionId: session\.id,[\s\S]*?syncStatus: 'cached',[\s\S]*?onOpenChat\?\.\(\)[\s\S]*?return[\s\S]*?const selection = select/)
  assert.match(composer, /if \(welcome\) \{[\s\S]*?appendWelcomeExchange\(snapshot, text\)[\s\S]*?return[\s\S]*?remoteComposerScopeIsCurrent/)
  assert.match(composer, /\{!welcome \? <IconButton icon=\{Paperclip\}/)
  assert.match(composer, /\{!welcome \? quickMessageControl : null\}/)
  assert.match(composer, /<ChatTargetPicker\s+visible=\{!welcome && pickerTrigger != null && pickerTrigger.kind !== '@@'\}/)
  assert.match(composer, /<TeamTargetPicker\s+visible=\{!welcome && pickerTrigger\?\.kind === '@@'\}/)
})

test('the synthetic chat cannot leak into persisted server-workspace state', () => {
  assert.match(store, /selectedSessionId: isWelcomeSession\(state\.selectedSessionId\) \? null : state\.selectedSessionId/)
  assert.match(store, /drafts: withoutWelcomeRecord\(state\.drafts\)/)
  assert.match(store, /chatReferencesBySession: withoutWelcomeRecord\(state\.chatReferencesBySession\)/)
})
