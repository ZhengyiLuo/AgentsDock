import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/TerminalView.tsx'), 'utf8')
const shell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')

test('terminal toolbar stays outside the platform terminal hit-testing surface', () => {
  const toolbar = source.indexOf('testID="terminal-toolbar"')
  const terminal = source.indexOf('\n      <TerminalViewport')

  assert.ok(toolbar >= 0, 'terminal toolbar must remain identifiable')
  assert.ok(terminal > toolbar, 'toolbar must be laid out before the native terminal')
  assert.doesNotMatch(source, /tabs:\s*\{[^}]*position:\s*['"]absolute['"]/)
  assert.doesNotMatch(source, /terminal:\s*\{[^}]*marginTop:/)
})

test('platform terminal is clipped below an elevated non-collapsible toolbar', () => {
  assert.match(source, /testID="terminal-platform-viewport"/)
  assert.match(source, /terminalViewport:\s*\{[^}]*overflow:\s*['"]hidden['"]/)
  assert.match(source, /tabs:\s*\{[^}]*zIndex:\s*2/)
  assert.match(source, /testID="terminal-toolbar"[\s\S]*?<\/View>[\s\S]*?testID="terminal-platform-viewport"/)
})

test('terminal uses a full-screen modal without a sheet dismissal recognizer', () => {
  const terminalModal = shell.match(/\{modalScopeCurrent && terminal && selected && !isWelcomeSession\(selected\.id\) \? <Modal visible[\s\S]*?<\/Modal> : null\}/)?.[0] ?? ''
  assert.match(terminalModal, /presentationStyle="fullScreen"/)
  assert.doesNotMatch(terminalModal, /allowSwipeDismissal/)
  assert.match(terminalModal, /paddingTop:\s*fullscreenModalTopPadding\(insets, Platform\.OS\)/)
  assert.match(terminalModal, /edges=\{\['right', 'bottom', 'left'\]\}/)
})
