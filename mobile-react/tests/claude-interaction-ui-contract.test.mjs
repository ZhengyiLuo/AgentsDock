import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const providerShelf = fs.readFileSync(path.resolve('src/components/CodexInteractionShelf.tsx'), 'utf8')
const claudeShelf = fs.readFileSync(path.resolve('src/components/ClaudeInteractionShelf.tsx'), 'utf8')
const claudeRuntime = fs.readFileSync(path.resolve('src/components/ClaudeRuntimeContext.tsx'), 'utf8')
const chatScreen = fs.readFileSync(path.resolve('src/components/ChatScreen.tsx'), 'utf8')

test('Claude runtime is mounted with profile fences and event-driven mobile refreshes', () => {
  assert.match(chatScreen, /<ClaudeRuntimeProvider sessionId=\{sessionId\}>/)
  assert.match(chatScreen, /<ClaudeInteractionShelf \/>/)
  assert.match(claudeRuntime, /claudeControlsCapability\(health\)/)
  assert.match(claudeRuntime, /switchingProfileId === null/)
  assert.match(claudeRuntime, /latestClaudeControlEventSeq/)
  assert.match(claudeRuntime, /expectedProfileId[\s\S]*?expectedGeneration[\s\S]*?expectedSessionId/)
  assert.match(claudeRuntime, /state\.selectedSessionId === sessionId/)
  assert.match(claudeRuntime, /state\.switchingProfileId === null/)
  assert.match(claudeRuntime, /NativeAppState\.addEventListener\('change'/)
  assert.doesNotMatch(claudeRuntime, /setInterval|ACTIVE_RUNTIME_POLL_MS/)
})

test('Claude reuses the provider-scoped interaction shelf and response bridge', () => {
  assert.match(providerShelf, /export function ProviderInteractionShelf/)
  assert.match(providerShelf, /export function ProviderInteractionCard/)
  assert.match(providerShelf, /providerName: string/)
  assert.match(claudeShelf, /providerName="Claude"/)
  assert.doesNotMatch(claudeShelf, /import \{ client \}/)
  assert.match(claudeShelf, /connection\.resolveClaudeInteraction\(targetSessionId, interactionId, response\)/)
  assert.match(claudeShelf, /busy=\{mutating\}/)
  assert.doesNotMatch(claudeShelf, /busy=\{loading \|\| refreshing \|\| mutating\}/)
})

test('provider request sheets keep pending failures reachable above the keyboard', () => {
  assert.match(providerShelf, /automaticallyAdjustKeyboardInsets=\{Platform\.OS === 'ios'\}/)
  assert.match(providerShelf, /keyboardDismissMode=\{Platform\.OS === 'ios' \? 'interactive' : 'on-drag'\}/)
  assert.match(providerShelf, /const visibleCount = Math\.max\(interactions\.length, pendingInteractionCount\)/)
  assert.match(providerShelf, /Retry loading request/)
  assert.match(claudeShelf, /session\?\.claude_pending_interaction_count/)
  assert.match(claudeShelf, /session\?\.latest_event_type === 'claude_interaction_requested'/)
  assert.match(claudeShelf, /onRetry=\{refresh\}/)
})

test('provider approvals preserve Mac tool metadata and exact advertised decisions', () => {
  assert.match(providerShelf, /const toolName = stringValue\(params\.toolName\) \|\| stringValue\(params\.name\)/)
  assert.match(providerShelf, /const displayName = stringValue\(params\.displayName\)/)
  assert.match(providerShelf, /\['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch'\]\.includes\(toolName\)/)
  assert.match(providerShelf, /const proposedChanges = params\.changes \?\? params\.fileChanges \?\? approvalItem\.changes/)
  assert.match(providerShelf, /const toolCommand = stringValue\(recordValue\(params\.toolInput\)\.command\)/)
  assert.match(providerShelf, /allowed\('acceptForSession'\)/)
  assert.match(providerShelf, /respond\(\{ decision: sessionDecision \}\)/)
  assert.match(providerShelf, /respond\(\{ decision: onceDecision \}\)/)
})

test('provider questions support multi-select plus Other and send answer arrays', () => {
  assert.match(providerShelf, /multiSelect: question\.multiSelect === true \|\| question\.multi_select === true/)
  assert.match(providerShelf, /useState<Record<string, string\[\]>>\(\{\}\)/)
  assert.match(providerShelf, /accessibilityRole=\{question\.multiSelect \? 'checkbox' : 'radio'\}/)
  assert.match(providerShelf, /const other = otherSelected\[question\.id\] \? textAnswers\[question\.id\]\?\.trim\(\) : ''/)
  assert.match(providerShelf, /responseAnswers\[question\.id\] = \{ answers: values \}/)
  assert.match(providerShelf, /onRespond\(\{ answers: \{\} \}\)/)
})
