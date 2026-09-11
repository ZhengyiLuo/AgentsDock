import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const api = source('src/api/AgentServerClient.ts')
const types = source('src/types.ts')
const composer = source('src/components/Composer.tsx')
const header = source('src/components/ChatHeader.tsx')
const permissionMenu = source('src/components/ClaudePermissionMenu.tsx')
const permissionCopy = source('src/lib/claude-permission-copy.ts')
const permissionUpdates = source('src/lib/claude-permission-updates.ts')
const contextIndicator = source('src/components/ClaudeContextIndicator.tsx')
const runtimeProvider = source('src/components/ClaudeRuntimeContext.tsx')
const interactionShelf = source('src/components/ClaudeInteractionShelf.tsx')
const contextUsage = source('src/lib/claude-context-usage.ts')
const store = source('src/store/useAppStore.ts')

test('mobile exposes the complete current Claude SDK runtime contract', () => {
  assert.match(types, /export type ClaudePermissionMode = 'default' \| 'acceptEdits' \| 'plan' \| 'bypassPermissions' \| 'dontAsk' \| 'auto'/)
  assert.match(types, /permission_modes\?: ClaudePermissionMode\[\]/)
  assert.match(types, /context_usage_snapshot\?: ClaudeTokenUsage \| null/)
  assert.match(types, /context_usage_state\?: 'available' \| 'cleared' \| 'unavailable' \| null/)
  assert.match(types, /context_usage_refresh\?: boolean/)
  assert.match(types, /context_usage_refreshed\?: boolean/)
  assert.match(api, /claude_permission_mode: input\.claude_permission_mode \?\? null/)
  assert.match(api, /refreshClaudeContextUsage\(sessionId: string\)[\s\S]*?claude\/context-usage\/refresh`[\s\S]*?\{\}/)
})

test('Claude permission choices follow Mac labels and fail closed on server gates', () => {
  assert.match(permissionCopy, /'default',[\s\S]*?'acceptEdits',[\s\S]*?'plan',[\s\S]*?'bypassPermissions',[\s\S]*?'dontAsk',[\s\S]*?'auto'/)
  assert.match(permissionMenu, /runtime\?\.features\?\.permission_mode_control === true/)
  assert.match(permissionMenu, /const modesResolved = supportedModes\.length > 0/)
  assert.match(permissionMenu, /const policyResolved = \(session\?\.claude_permission_mode \?\? runtime\?\.policy\?\.permission_mode\) != null/)
  assert.match(permissionMenu, /const modeSupported = supportedModes\.includes\(mode\)/)
  assert.match(permissionMenu, /const turnActive = running \|\| runtime\?\.status\?\.type === 'active'/)
  assert.match(permissionMenu, /const controlsDisabled = turnActive \|\| admitting \|\| mutating \|\| saveState === 'saving'/)
  assert.match(permissionMenu, /accessibilityState=\{\{ disabled: controlsDisabled, selected: value === mode \}\}/)
})

test('Claude permission writes serialize and finish before every dispatch path', () => {
  assert.match(permissionUpdates, /const pendingByScope = new Map<string, Promise<void>>\(\)/)
  assert.match(permissionUpdates, /previous\.catch\(\(\) => undefined\)\.then\(update\)/)
  assert.match(permissionMenu, /queueClaudePermissionUpdate\(expectedScope/)
  assert.match(permissionMenu, /updated\?\.claude_permission_mode !== next/)
  assert.match(composer, /backend === 'claude' && activeProfileId[\s\S]*?await awaitClaudePermissionUpdates\(\{ profileId: activeProfileId, profileGeneration, sessionId \}\)/)
  assert.ok(composer.indexOf('beginTurnAdmission(sessionId)') < composer.indexOf('await awaitClaudePermissionUpdates'))
  assert.ok(composer.indexOf('await awaitClaudePermissionUpdates') < composer.indexOf('const request = sendPrompt('))
  assert.match(composer, /admissionToken,/)
  assert.match(composer, /const admittedDraft = consumeComposer \? currentDraft : undefined/)
  assert.match(composer, /const admittedFiles = consumeComposer \? currentUploads : undefined/)
  assert.match(composer, /const admissionPreflight = admitting && !sending/)
  assert.match(composer, /editable=\{!switching && !admissionPreflight\}/)
  assert.match(store, /turnAdmissionTokens: Record<string, string>/)
  assert.match(store, /const originalDraft = options\?\.admittedDraft \?\? get\(\)\.drafts\[sessionId\] \?\? ''/)
  assert.match(store, /const files = consumeComposer \? options\?\.admittedFiles \?\? get\(\)\.uploads\[sessionId\] \?\? \[\] : \[\]/)
  assert.match(store, /state\.turnAdmissionTokens\[sessionId\] !== token/)
  assert.match(store, /patch\.backend !== before\.backend[\s\S]*?turnAdmissionTokens\[sessionId\]/)
  assert.match(store, /async runQueuedNow\(sessionId, queuedId, expectedGeneration\)[\s\S]*?session\?\.backend === 'claude'[\s\S]*?await awaitClaudePermissionUpdates/)
  assert.match(store, /await Promise\.all\(\[[\s\S]*?awaitAllCodexPermissionUpdates\(\)[\s\S]*?awaitAllClaudePermissionUpdates\(\)/)
})

test('Claude context consumption is visible and refreshable like the Mac app', () => {
  assert.match(header, /<ClaudeContextIndicator \/>/)
  assert.match(contextIndicator, /runtime\.context_usage_snapshot !== undefined/)
  assert.match(contextIndicator, /testID="claude-context-usage"/)
  assert.match(contextIndicator, /void refreshContextUsage\(\)/)
  assert.match(contextIndicator, /context_usage_state/)
  assert.match(contextIndicator, /runtime\?\.features\?\.context_usage_refresh === true/)
  assert.match(contextIndicator, /runtimeStatus === 'idle'/)
  assert.match(runtimeProvider, /connection\.refreshClaudeContextUsage\(expectedSessionId\)/)
  assert.match(runtimeProvider, /runtimeRef\.current\?\.features\?\.context_usage_refresh !== true[\s\S]*?performRefresh\('contextUsage'\)/)
  assert.match(runtimeProvider, /runtimeError: string \| null/)
  assert.match(runtimeProvider, /interactionError: string \| null/)
  assert.match(runtimeProvider, /contextUsageError: string \| null/)
  assert.doesNotMatch(interactionShelf, /contextUsageError/)
  assert.match(interactionShelf, /error=\{interactionError \?\? \(runtime === null \? runtimeError : null\)\}/)
  assert.match(contextUsage, /\['context_usage', 'contextUsage', 'native', 'raw'\]/)
  assert.match(contextUsage, /clampPercent\(explicitPercent \?\? contextTokens \/ effectiveContextWindow \* 100\)/)
})

test('Claude permission sheet keeps an inspectable, dismissible native surface', () => {
  assert.match(composer, /backend === 'claude' \? <ClaudePermissionMenu sessionId=\{sessionId\} compact=\{compactToolbar\}/)
  assert.match(permissionMenu, /disabled=\{!available\}/)
  assert.match(permissionMenu, /<Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose=\{close\}>/)
  assert.match(permissionMenu, /<SheetCloseButton label="Close Claude permissions" testID="claude-permissions-close" onPress=\{close\} \/>/)
  assert.match(permissionMenu, /automaticallyAdjustKeyboardInsets/)
})
