import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const componentRoot = path.resolve('src/components')
const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8')
const appText = fs.readFileSync(path.join(componentRoot, 'AppText.tsx'), 'utf8')
const dialogs = fs.readFileSync(path.join(componentRoot, 'Dialogs.tsx'), 'utf8')
const chatHeader = fs.readFileSync(path.join(componentRoot, 'ChatHeader.tsx'), 'utf8')
const composer = fs.readFileSync(path.join(componentRoot, 'Composer.tsx'), 'utf8')
const sidebar = fs.readFileSync(path.join(componentRoot, 'Sidebar.tsx'), 'utf8')
const serverProfiles = fs.readFileSync(path.join(componentRoot, 'ServerProfiles.tsx'), 'utf8')
const terminalView = fs.readFileSync(path.join(componentRoot, 'TerminalView.tsx'), 'utf8')
const timelineRows = fs.readFileSync(path.join(componentRoot, 'TimelineRows.tsx'), 'utf8')
const terminalModule = fs.readFileSync(path.resolve('modules/agentsdock-native-terminal/ios/AgentsDockNativeTerminalModule.swift'), 'utf8')
const terminal = fs.readFileSync(path.resolve('modules/agentsdock-native-terminal/ios/AgentsDockTerminalView.swift'), 'utf8')

test('all first-party React Native text uses app-scaled primitives', () => {
  const files = fs.readdirSync(componentRoot).filter(file => file.endsWith('.tsx') && file !== 'AppText.tsx')
  const textComponents = files.filter(file => /<Text(?:Input)?\b/.test(fs.readFileSync(path.join(componentRoot, file), 'utf8')))
  assert.ok(textComponents.includes('Sidebar.tsx'))
  assert.ok(textComponents.includes('ServerProfiles.tsx'))
  for (const file of textComponents) {
    const source = fs.readFileSync(path.join(componentRoot, file), 'utf8')
    assert.match(source, /import \{[^}]*\bText(?:Input)?\b[^}]*\} from '\.\/AppText'/, `${file} must import the app typography primitive`)
    assert.doesNotMatch(source, /import \{[^}]*\bText(?:Input)?\b[^}]*\} from 'react-native'/, `${file} bypasses app typography`)
  }
})

test('typography provider scales text metrics and preserves native input refs', () => {
  assert.match(app, /<AppTypographyProvider>/)
  assert.match(appText, /useAppStore\(state => state\.fontScale\)/)
  assert.match(appText, /StyleSheet\.flatten\(style\)/)
  assert.match(appText, /override\.lineHeight = scaleAppFont/)
  assert.match(appText, /forwardRef<Text, TextProps>/)
  assert.match(appText, /forwardRef<TextInput, TextInputProps>/)
  assert.match(sidebar, /const searchInput = useRef<TextInput>\(null\)/)
  assert.match(dialogs, /const searchInput = useRef<TextInput>\(null\)/)
})

test('settings and primary selectors expose app-wide text sizing', () => {
  assert.match(dialogs, /<Label text="App text size"/)
  assert.match(dialogs, /Decrease app text size/)
  assert.match(dialogs, /Increase app text size/)
  assert.match(dialogs, /Applies to chats, navigation, settings, server management, and terminal text\./)
  assert.doesNotMatch(dialogs, /Navigation stays compact/)
  assert.match(sidebar, /import \{ Text, TextInput \} from '\.\/AppText'/)
  assert.match(serverProfiles, /import \{ Text, TextInput \} from '\.\/AppText'/)
})

test('large app text keeps narrow navigation and chat controls usable', () => {
  assert.match(sidebar, /<\/View>\s*<View style=\{styles\.actions\}>/)
  assert.match(sidebar, /actions: \{ minHeight: 44[\s\S]*?justifyContent: 'space-between'/)
  assert.match(chatHeader, /<Text style=\{\[styles\.statusLabel[\s\S]*?numberOfLines=\{1\}>\{statusLabel\}<\/Text>/)
  assert.match(chatHeader, /onlineCompact: \{ minWidth: 78/)
  assert.match(timelineRows, /styles\.time[\s\S]*?numberOfLines=\{1\}/)
  assert.match(timelineRows, /time: \{ minWidth: 0, flexShrink: 1/)
  assert.match(composer, /<View style=\{styles\.queueActions\}>/)
  assert.doesNotMatch(dialogs, /numberOfLines=\{2\}[^>]*>Navigation and chats resize immediately\./)
})

test('native terminal keeps monospace while following app scale', () => {
  assert.match(terminalView, /fontSize=\{scaleAppFont\(13, fontScale\)\}/)
  assert.match(terminalModule, /Prop\("fontSize"\)/)
  assert.match(terminal, /setFontSize/)
  assert.match(terminal, /UIFont\.monospacedSystemFont/)
})
