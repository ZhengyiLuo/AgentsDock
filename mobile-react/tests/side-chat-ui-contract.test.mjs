import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const screen = readFileSync('src/components/ChatScreen.tsx', 'utf8')
const header = readFileSync('src/components/ChatHeader.tsx', 'utf8')
const sheet = readFileSync('src/components/SideChatSheet.tsx', 'utf8')

test('entry is capability gated and changing chat/server synchronously unmounts the sheet', () => {
  assert.match(screen, /const supportsSideChat = !welcome && sideChatSupported\(health, backend\)/)
  assert.match(screen, /const sideChatScope = `\$\{activeProfileId \?\? ''\}:\$\{profileGeneration\}:\$\{sessionId\}`/)
  assert.match(screen, /!welcome && openSideChatScope === sideChatScope \? <SideChatSheet key=\{sideChatScope\}/)
  assert.doesNotMatch(screen, /supportsSideChat && openSideChatScope/)
  assert.match(screen, /useEffect\(\(\) => \{ setOpenSideChatScope\(null\) \}, \[sideChatScope\]\)/)
  assert.match(header, /sideChatSupported && onSideChat \? <Pressable testID="chat-side-chat"/)
  assert.match(header, /sideChat: \{ minHeight: 44/)
})

test('native sheet opens and closes before deferred keyboard dismissal, with no implicit cancellation', () => {
  assert.match(screen, /onSideChat=\{\(\) => \{ setOpenSideChatScope\(sideChatScope\); requestAnimationFrame\(dismissAppKeyboard\) \}\}/)
  assert.match(sheet, /const close = \(\) => \{ onClose\(\); requestAnimationFrame\(dismissAppKeyboard\) \}/)
  assert.match(sheet, /<SheetCloseButton label="Close side chat" testID="side-chat-close" onPress=\{close\}/)
  assert.match(sheet, /useSideChat\(sessionId, true\)/)
  assert.doesNotMatch(sheet, /\.cancelRun\(|\.cancelSession\(|\.stopSession\(/)
})
