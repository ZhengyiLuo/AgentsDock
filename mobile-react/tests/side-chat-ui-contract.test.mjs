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

test('native sheet opens before keyboard dismissal but closes after releasing its input, without cancellation', () => {
  assert.match(screen, /onSideChat=\{\(\) => \{ setOpenSideChatScope\(sideChatScope\); requestAnimationFrame\(dismissAppKeyboard\) \}\}/)
  const close = sheet.slice(sheet.indexOf('const close = () => {'), sheet.indexOf('const send = async () => {'))
  assert.match(close, /if \(!mounted\.current \|\| closing\.current\) return/)
  assert.ok(close.indexOf('input.current?.blur()') < close.indexOf('dismissAppKeyboard()'))
  assert.ok(close.indexOf('dismissAppKeyboard()') < close.indexOf('onClose()'))
  assert.doesNotMatch(close, /requestAnimationFrame|setTimeout/)
  assert.match(sheet, /<TextInput ref=\{input\} testID="side-chat-question"/)
  assert.match(sheet, /<SheetCloseButton label="Close side chat" testID="side-chat-close" onPress=\{close\}/)
  assert.match(sheet, /useSideChat\(sessionId, true\)/)
  assert.doesNotMatch(sheet, /\.cancelRun\(|\.cancelSession\(|\.stopSession\(/)
})
