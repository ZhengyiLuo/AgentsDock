import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const inspector = fs.readFileSync(path.resolve('src/components/Inspector.tsx'), 'utf8')

test('Fork exposes and enforces the active-turn and pending-message restrictions', () => {
  assert.match(inspector, /state\.activeSessionIds\.has\(sessionId\)/)
  assert.match(inspector, /state\.stoppingSessionIds\.has\(sessionId\)/)
  assert.match(inspector, /Boolean\(state\.turnAdmissionTokens\[sessionId\]\) \|\| state\.sendingSessionIds\.has\(sessionId\)/)
  assert.match(inspector, /state\.snapshots\[sessionId\]\?\.queuedTurns\.some\(turn => state\.pendingQueuedRunIds\.has\(turn\.queued_id\)\)/)
  assert.match(inspector, /const forkDisabled = !connected \|\| running \|\| stopping \|\| admitting/)
  assert.doesNotMatch(inspector, /state\.queuedRunStatus\[sessionId\]/, 'Historical queue notices must not lock Fork')
  assert.match(inspector, /testID="inspector-fork-chat" disabled=\{forkDisabled\}/)
  assert.match(inspector, /if \(!forkDisabled && scopeIsCurrent\(\)\) void fork\(sessionId, profileGeneration\)/)
  const command = inspector.slice(inspector.indexOf('function Command('), inspector.indexOf('function ChoiceField('))
  assert.match(command, /accessibilityState=\{\{ disabled \}\} disabled=\{disabled\}/)
  assert.match(command, /accessibilityHint=\{hint\}/)
})

test('Copy session uses the full provider identifier and reports clipboard success or failure', () => {
  for (const field of ['session_id', 'codex_thread_id', 'claude_session_id', 'cursor_session_id']) {
    assert.match(inspector, new RegExp(`${field}: value\\.${field}`))
    assert.match(inspector, new RegExp(`session\\?\\.${field}\\?\\.trim\\(\\)`))
  }
  assert.match(inspector, /testID="inspector-copy-session-id" disabled=\{!providerSessionId\}/)
  const copy = inspector.slice(inspector.indexOf('const copySessionId ='), inspector.indexOf('const openPinnedItem ='))
  assert.match(copy, /if \(!providerSessionId \|\| !scopeIsCurrent\(\)\) return/)
  assert.match(copy, /await Clipboard\.setStringAsync\(providerSessionId\)/)
  assert.match(copy, /AccessibilityInfo\.announceForAccessibility\('Session ID copied'\)/)
  assert.match(copy, /Alert\.alert\('Could not copy session ID'/)
})
