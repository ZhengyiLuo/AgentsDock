import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

function sourceSection(text, start, end) {
  const startIndex = text.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing source section start: ${start}`)
  const endIndex = text.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing source section end: ${end}`)
  return text.slice(startIndex, endIndex)
}

const api = source('src/api/AgentServerClient.ts')
const composer = source('src/components/Composer.tsx')
const controls = source('src/components/CodexControls.tsx')
const goalBar = source('src/components/CodexGoalBar.tsx')
const goalHelpers = source('src/lib/codex-goals.ts')
const permissionMenu = source('src/components/CodexPermissionMenu.tsx')
const interactionShelf = source('src/components/CodexInteractionShelf.tsx')
const runtimeContext = source('src/components/CodexRuntimeContext.tsx')
const chatScreen = source('src/components/ChatScreen.tsx')
const chatHeader = source('src/components/ChatHeader.tsx')
const store = source('src/store/useAppStore.ts')
const capability = source('src/lib/codex-controls.ts')
const claudeCapability = source('src/lib/claude-controls.ts')
const interactiveCapabilities = source('src/lib/chat-references.ts')
const permissionDefaults = source('src/lib/codex-permissions.ts')
const permissionUpdates = source('src/lib/codex-permission-updates.ts')
const types = source('src/types.ts')
const tokenUsage = source('src/lib/codex-token-usage.ts')
const timelineProjection = source('src/lib/timeline.ts')
const runtimeRefresh = sourceSection(runtimeContext, '  const performRefresh = useCallback', '\n\n  const refresh = useCallback')
const runtimeRefreshSuccess = sourceSection(runtimeRefresh, '      const next = await', '\n    } catch (cause) {')
const runtimeRun = sourceSection(runtimeContext, '  const run = useCallback', '\n\n  const value = useMemo')
const storeUpdateSession = sourceSection(store, '  async updateSession(', '\n  async createSession(')

test('Codex app-server controls are mounted in the active mobile chat', () => {
  assert.match(chatScreen, /<CodexRuntimeProvider sessionId=\{sessionId\}>/)
  assert.match(chatScreen, /<CodexInteractionShelf \/>/)
  assert.match(chatHeader, /<CodexStatusButton compact=\{compact\} \/>/)
  assert.match(chatHeader, /<CodexContextIndicator \/>/)
  assert.match(controls, /testID="codex-status"/)
  assert.match(controls, /testID="codex-context-usage"/)
  assert.match(controls, /onPress=\{\(\) => \{ setOpen\(true\); requestAnimationFrame\(dismissAppKeyboard\) \}\}/)
  assert.match(controls, /Codex thread controls/)
})

test('observational runtime refreshes never disable provider decisions', () => {
  assert.match(runtimeContext, /mutating: boolean/)
  assert.match(runtimeContext, /setMutating\(true\)/)
  assert.match(runtimeContext, /setMutating\(mutationCount\.current > 0\)/)
  assert.match(interactionShelf, /busy=\{mutating\}/)
  assert.doesNotMatch(interactionShelf, /busy=\{loading \|\| refreshing\}/)
})

test('mobile defaults new Codex chats to the current Mac/server permission policy', () => {
  assert.match(permissionDefaults, /DEFAULT_CODEX_APPROVAL_POLICY[^=]*= 'never'/)
  assert.match(permissionDefaults, /DEFAULT_CODEX_SANDBOX_MODE[^=]*= 'danger-full-access'/)
  assert.match(permissionDefaults, /DEFAULT_CODEX_PERMISSION_PROFILE[^=]*= null/)
  assert.match(permissionDefaults, /DEFAULT_CODEX_APPROVALS_REVIEWER[^=]*= 'user'/)
  assert.doesNotMatch(api, /DEFAULT_CODEX_PERMISSION_SETTINGS/)
  assert.match(api, /codex_approval_policy: input\.codex_approval_policy \?\? null/)
  assert.match(api, /codex_sandbox_mode: input\.codex_sandbox_mode \?\? null/)
  assert.match(api, /codex_permission_profile: input\.codex_permission_profile \?\? null/)
  assert.match(api, /codex_approvals_reviewer: input\.codex_approvals_reviewer \?\? null/)
})

test('mobile preserves structured Stop and provider reload contracts', () => {
  assert.match(types, /export interface TurnStopResult/)
  assert.match(types, /stopped: boolean/)
  assert.match(types, /pending\?: boolean/)
  assert.match(types, /deferred\?: boolean/)
  assert.match(types, /export interface ProviderReloadResult/)
  assert.match(types, /backend_locked\?: boolean \| null/)
  assert.match(api, /async stopTurn\(sessionId: string\): Promise<TurnStopResult>/)
  assert.match(api, /stopped: response\.stopped \?\? response\.ok \?\? true/)
  assert.match(api, /async reloadProvider\(sessionId: string\): Promise<ProviderReloadResult>/)
  assert.match(composer, /title: `Reload \$\{providerName\}`/)
  assert.match(store, /if \(!result\.stopped\)/)
  assert.match(store, /result\.pending \|\| result\.deferred/)
})

test('mobile mirrors the Mac permission menu policy and persistence contract', () => {
  assert.match(types, /export interface CodexRuntimePolicy/)
  assert.match(types, /approval_policy\?: CodexApprovalPolicy \| null/)
  assert.match(types, /sandbox_mode\?: CodexSandboxMode \| null/)
  assert.match(types, /permission_profile\?: string \| null/)
  assert.match(types, /approvals_reviewer\?: CodexApprovalsReviewer \| null/)
  assert.match(types, /policy\?: CodexRuntimePolicy \| null/)
  assert.match(composer, /<CodexPermissionMenu sessionId=\{sessionId\}/)
  assert.ok(
    composer.indexOf('<CodexPermissionMenu sessionId={sessionId}') > composer.indexOf('<BackendMark backend={backend}'),
    'the permission control must follow the backend identity in the composer toolbar',
  )
  assert.match(permissionMenu, /permissionDraft\(session, runtime\?\.policy\)/)
  assert.match(permissionMenu, /if \(saveState === 'saving'\) return/)
  assert.match(permissionMenu, /const sessionPolicyIsAuthoritative = Boolean\(session && hasSessionPermissionPolicy\(session\)\)/)
  assert.match(permissionMenu, /sessionPolicyIsAuthoritative[\s\S]*?session\?\.codex_permission_profile \?\? ''[\s\S]*?runtimePolicy\?\.permission_profile \?\? ''/)
  assert.match(permissionMenu, /queueCodexPermissionUpdate\(expectedScope/)
  assert.match(permissionMenu, /profileId: activeProfileId[\s\S]*?profileGeneration[\s\S]*?sessionId/)
  assert.match(permissionMenu, /codex_approval_policy: draft\.policy/)
  assert.match(permissionMenu, /codex_sandbox_mode: draft\.sandbox/)
  assert.match(permissionMenu, /codex_permission_profile: draft\.profile \|\| null/)
  assert.match(permissionMenu, /codex_approvals_reviewer: draft\.reviewer/)
  assert.match(permissionUpdates, /const pendingByScope = new Map<string, Promise<void>>\(\)/)
  assert.match(permissionUpdates, /const previous = pendingByScope\.get\(key\) \?\? Promise\.resolve\(\)/)
  assert.match(permissionUpdates, /previous\.catch\(\(\) => undefined\)\.then\(update\)/)
})

test('permission writes finish before Codex sends or server-profile switching', () => {
  const send = sourceSection(composer, '  const send = async', '\n  const pickFiles = async')
  const legacySave = sourceSection(controls, '  const savePermissions = () => {', '\n  const startReview = () =>')
  assert.match(send, /backend === 'codex' && activeProfileId/)
  assert.match(send, /await awaitCodexPermissionUpdates\(\{ profileId: activeProfileId, profileGeneration, sessionId \}\)/)
  assert.ok(
    send.indexOf('await awaitCodexPermissionUpdates') < send.indexOf('const request = sendPrompt('),
    'the next turn must not start before its permission writes finish',
  )
  assert.match(send, /catch \(error\)[\s\S]*?useAppStore\.setState\(\{ error:[\s\S]*?return/)
  assert.match(send, /if \(!remoteComposerScopeIsCurrent\(activeProfileId, profileGeneration, sessionId\)\) return/)
  assert.match(legacySave, /queueCodexPermissionUpdate\(\{[\s\S]*?profileId: activeProfileId,[\s\S]*?profileGeneration,[\s\S]*?sessionId: session\.id/)
  assert.match(legacySave, /codexPermissionPatchMatches\(updated, patch\)/)
  assert.match(store, /async runQueuedNow\(sessionId, queuedId, expectedGeneration\)[\s\S]*?await awaitCodexPermissionUpdates\(\{[\s\S]*?profileId: scope\.profileId,[\s\S]*?profileGeneration: scope\.generation,[\s\S]*?sessionId/)
  assert.match(store, /async function prepareServerProfileActivation\([\s\S]*?await Promise\.all\(\[[\s\S]*?awaitAllCodexPermissionUpdates\(\)[\s\S]*?const profile = get\(\)\.profiles/)
})

test('Codex permission choices avoid nested native modals and keep every tap', () => {
  const permissionChoice = sourceSection(permissionMenu, 'function InlineChoice(', '\n\nfunction permissionDraft(')
  assert.doesNotMatch(permissionChoice, /<Modal\b/, 'permission options must expand inside their owning page sheet')
  assert.match(permissionChoice, /onPress=\{\(\) => setExpanded\(current => !current\)\}/)
  assert.match(permissionChoice, /onPress=\{\(\) => \{[\s\S]*?setExpanded\(false\)[\s\S]*?onChange\(option\.value\)/)
  assert.match(permissionMenu, /<SheetCloseButton label="Close Codex permissions" testID="codex-permissions-close" onPress=\{close\} \/>/)
  assert.match(permissionMenu, /<ScrollView[\s\S]*?keyboardShouldPersistTaps="always"/)
  assert.match(permissionMenu, /runtimePermissionProfilesKey = permissionProfilesFingerprint/)
  assert.match(permissionMenu, /runtimeHadPermissionProfiles = useRef/)
  assert.match(permissionMenu, /else if \(runtimeHadPermissionProfiles\.current\) \{[\s\S]*?setProfiles\(\[\]\)[\s\S]*?profileLoadAttempted\.current = false/)
  assert.match(permissionMenu, /\[editable, open, runtimePermissionProfilesKey, scopeKey, session\?\.id\]/)

  const controlsSheet = sourceSection(controls, 'function CodexControlsSheet(', '\n\nfunction BackgroundTerminals(')
  const rootScrollStart = controlsSheet.indexOf('<ScrollView')
  assert.notEqual(rootScrollStart, -1, 'Codex controls sheet must contain its root ScrollView')
  const rootScrollEnd = controlsSheet.indexOf('>', rootScrollStart)
  assert.notEqual(rootScrollEnd, -1, 'Codex controls root ScrollView must have a complete opening tag')
  const rootScroll = controlsSheet.slice(rootScrollStart, rootScrollEnd + 1)
  assert.match(rootScroll, /keyboardShouldPersistTaps="always"/)
  assert.match(controls, /const loadKey = `\$\{activeProfileId\}:\$\{profileGeneration\}:\$\{session\.id\}:\$\{runtimePermissionProfilesKey\}:\$\{runtimeStatusType\}`/)
  assert.match(controls, /if \(runtime\?\.permission_profiles\?\.length\) \{[\s\S]*?permissionProfileLoadKey\.current = loadKey[\s\S]*?if \(permissionProfileLoadKey\.current === loadKey\) return/)
  assert.match(controls, /\[activeProfileId, profileGeneration, runtimePermissionProfilesKey, runtimeStatusType, session\?\.id, visible\]/)
  assert.match(controls, /const busy = permissionProfilesBusy\(detail\)/)
  assert.match(controls, /Codex is busy\. Permission profiles will refresh after the active turn finishes\./)

  const legacyChoice = sourceSection(controls, 'function Choice(', '\n\nfunction Action(')
  assert.doesNotMatch(legacyChoice, /<Modal\b/, 'Codex controls choices must not present a Modal from inside a Modal')
})

test('mobile mirrors Mac context-consumption accounting', () => {
  assert.match(types, /export type CodexTokenUsage = Record<string, JsonValue>/)
  assert.match(types, /token_usage\?: CodexTokenUsage \| null/)
  assert.match(types, /token_usage_snapshot\?: CodexTokenUsage \| null/)
  assert.match(types, /token_usage_after\?: CodexTokenUsage \| null/)
  assert.match(tokenUsage, /explicitContextTokens \?\? lastTotal \?\? sumKnown/)
  assert.match(tokenUsage, /cumulative_total_tokens/)
  assert.match(tokenUsage, /event\.type === 'codex_compaction_completed'/)
  assert.match(controls, /latestCodexContextUsage\(events, runtime\?\.token_usage_snapshot \?\? runtime\?\.token_usage, threadId, runtime\?\.context_usage_state\)/)
  assert.match(controls, /\[events, runtime\?\.context_usage_state, runtime\?\.token_usage, runtime\?\.token_usage_snapshot, threadId\]/)
  assert.match(tokenUsage, /if \(contextUsageState === 'cleared' \|\| contextUsageState === 'unavailable'\) return null/)
  assert.match(controls, /accessibilityRole="button"/)
  assert.match(controls, /if \(!supported \|\| !session\) return null/)
  assert.match(tokenUsage, /event\.type === 'provider_rollover'/)
  assert.match(tokenUsage, /usage\.threadId !== expectedThreadId/)
  assert.match(controls, /Session total/)
  assert.match(timelineProjection, /'codex_token_usage'/)
  assert.match(capability, /type\.startsWith\('codex_'\)/)
  assert.match(runtimeContext, /ACTIVE_RUNTIME_POLL_MS = 5_000/)
})

test('interactive opt-in is strict and only attached by the store capability gate', () => {
  assert.match(capability, /advertised !== CODEX_INTERACTIVE_CLIENT_CAPABILITY/)
  assert.match(claudeCapability, /advertised !== CLAUDE_INTERACTIVE_CLIENT_CAPABILITY/)
  assert.match(interactiveCapabilities, /session\?\.backend === 'codex'[\s\S]*?codexInteractiveClientCapability\(health\)/)
  assert.match(interactiveCapabilities, /session\?\.backend === 'claude'[\s\S]*?claudeInteractiveClientCapability\(health\)/)
  assert.match(store, /interactiveClientCapabilities\(session, get\(\)\.health\)/)
  assert.match(api, /clientCapabilities: readonly string\[\] = \[\]/)
  assert.match(api, /if \(clientCapabilities\.length\) body\.client_capabilities = \[\.\.\.clientCapabilities\]/)
})

test('runtime refreshes are scoped, event-driven, and foreground-aware', () => {
  assert.match(runtimeContext, /latestCodexControlEventSeq/)
  assert.match(runtimeContext, /const refreshSignal = `\$\{controlEventSeq\}:\$\{pendingCount\}`/)
  assert.match(runtimeContext, /if \(previousRefreshSignal\.current === refreshSignal\) return/)
  assert.match(runtimeContext, /\}, \[refresh, refreshSignal, supported\]\)/)
  assert.doesNotMatch(
    runtimeContext,
    /if \(!supported \|\| !runtimeRef\.current\) return/,
    'a failed initial runtime request must still retry when the event signal changes',
  )
  assert.match(runtimeContext, /NativeAppState\.addEventListener\('change'/)
  assert.match(runtimeContext, /runtime\?\.status\?\.type !== 'active'/)
  assert.match(runtimeContext, /NativeAppState\.currentState !== 'active'/)
  assert.match(runtimeContext, /const refreshCount = useRef\(0\)/)
  assert.match(runtimeContext, /const mutationCount = useRef\(0\)/)
  assert.match(runtimeContext, /mutationCount\.current > 0[\s\S]*?refreshCount\.current > 0/)
  assert.match(runtimeContext, /const epoch = requestEpoch\.current[\s\S]*?requestEpoch\.current !== epoch/)
  assert.match(runtimeContext, /const expectedScopeKey = scopeKeyRef\.current/)
  assert.match(runtimeContext, /scopeKeyRef\.current = ''/)
  assert.match(runtimeContext, /waitingForUser/)
  assert.match(runtimeContext, /setTimeout\([\s\S]*?ACTIVE_RUNTIME_POLL_MS/)
  assert.match(runtimeContext, /catch \{[\s\S]*?telemetry[\s\S]*?\} finally \{[\s\S]*?schedule\(\)/)
  assert.match(runtimeContext, /expectedProfileId[\s\S]*?expectedGeneration[\s\S]*?expectedSessionId/)
  assert.match(runtimeContext, /state\.selectedSessionId === sessionId/)
  assert.doesNotMatch(runtimeContext, /setInterval/)
})

test('runtime operation errors survive the follow-up status refresh and are visible', () => {
  assert.match(runtimeContext, /const \[refreshError, setRefreshError\] = useState<string \| null>\(null\)/)
  assert.match(runtimeContext, /const \[operationError, setOperationError\] = useState<RuntimeOperationError \| null>\(null\)/)
  assert.match(
    runtimeRefreshSuccess,
    /runtimeRef\.current = next\s+setRuntime\(next\)\s+setRefreshError\(null\)\s+return next/,
  )
  assert.doesNotMatch(
    runtimeRefreshSuccess,
    /setOperationError/,
    'a successful status refresh must not erase the preceding operation failure',
  )
  assert.match(
    runtimeRun,
    /catch \(cause\) \{\s+if \(scopeKeyRef\.current === expectedScopeKey && mutationEpoch\.current === expectedMutationEpoch\) setOperationError\(\{ message: errorMessage\(cause\), goalStatusIntent \}\)\s+throw cause/,
  )
  assert.match(runtimeRun, /finally \{[\s\S]*?void refresh\(\)/)
  assert.match(runtimeContext, /error: \(goalStatusErrorRetired\(operationError\?\.goalStatusIntent, runtime\) \? null : operationError\?\.message\) \?\? refreshError/)
  assert.match(interactionShelf, /\{available && error \? \(/)
  assert.match(controls, /\{error \? <Notice text=\{error\} tone="warning" \/> : null\}/)
})

test('mobile can resolve every interactive Codex request family', () => {
  assert.match(interactionShelf, /item\/tool\/requestUserInput/)
  assert.match(interactionShelf, /item\/permissions\/requestApproval/)
  assert.match(interactionShelf, /mcpServer\/elicitation\/request/)
  assert.match(interactionShelf, /applyPatchApproval/)
  assert.match(interactionShelf, /execCommandApproval/)
  assert.match(interactionShelf, /acceptWithExecpolicyAmendment/)
  assert.match(interactionShelf, /Cancel turn/)
  assert.match(interactionShelf, /Grant requested subset/)
  assert.match(interactionShelf, /Share with tool/)
  assert.match(interactionShelf, /Skip/)
})

test('custom question answers remain distinct from predefined choices', () => {
  assert.match(interactionShelf, /const \[otherSelected, setOtherSelected\]/)
  assert.match(interactionShelf, /\(answers\[question\.id\] \?\? \[\]\)\.includes\(option\.label\)/)
  assert.match(interactionShelf, /const other = otherSelected\[question\.id\] \? textAnswers\[question\.id\]\?\.trim\(\) : ''/)
  assert.match(interactionShelf, /accessibilityLabel=\{`Other answer: \$\{question\.question\}`\}/)
  assert.doesNotMatch(interactionShelf, /`Other: \$\{value\}`/)
})

test('approval and authorization interactions retain the Mac safety gates', () => {
  assert.match(interactionShelf, /const approvalItem = recordValue\(params\.approvalItem\)/)
  assert.match(interactionShelf, /const proposedChanges = params\.changes \?\? params\.fileChanges \?\? approvalItem\.changes/)
  assert.match(interactionShelf, /\{providerName\} did not provide a patch preview/)
  assert.match(interactionShelf, /stringValue\(props\.interaction\.params\.mode\) === 'url'/)
  assert.match(interactionShelf, /const safeUrl = isSafeExternalUrl\(url\)/)
  assert.match(interactionShelf, /await Linking\.openURL\(url\)/)
  assert.match(interactionShelf, /disabled=\{busy \|\| !opened\}/)
  assert.match(interactionShelf, /Only HTTPS or HTTP authorization links can be opened\./)
  assert.match(interactionShelf, /const decisionsSpecified = Array\.isArray\(params\.availableDecisions\)/)
  assert.match(interactionShelf, /advertisedStructuredDecisions\(\s+params\.availableDecisions,\s+'acceptWithExecpolicyAmendment'/)
  assert.match(interactionShelf, /advertisedStructuredDecisions\(\s+params\.availableDecisions,\s+'applyNetworkPolicyAmendment'/)
  assert.match(interactionShelf, /respond\(\{ decision: execAmendmentDecision \}\)/)
  assert.match(interactionShelf, /respond\(\{ decision \}\)/)
  assert.doesNotMatch(
    interactionShelf,
    /proposedExecpolicyAmendment|proposedNetworkPolicyAmendments/,
    'mobile must never fabricate a structured decision the server did not advertise',
  )
})

test('closed interaction sheets do not keep countdown components mounted', () => {
  assert.match(interactionShelf, /\{open \? <Modal visible/)
  assert.doesNotMatch(interactionShelf, /<Modal visible=\{open\}/)
})

test('interaction sheets finish forced dismissal before unmounting', () => {
  const shelf = sourceSection(
    interactionShelf,
    'export function CodexInteractionShelf()',
    '\n\nexport function CodexInteractionCard',
  )
  const close = sourceSection(shelf, '  const close = useCallback', '\n\n  useEffect')
  assert.ok(close.indexOf('setOpen(false)') < close.indexOf('requestAnimationFrame(dismissAppKeyboard)'))
  assert.match(shelf, /if \(available \|\| !open\) return\s+close\(\)/)
  assert.match(shelf, /if \(!available && !open\) return null/)
  assert.match(shelf, /\{available \? <Pressable/)
  assert.match(shelf, /\{available \? interactions\.map/)
})

test('destructive and unsandboxed Codex controls require explicit confirmations', () => {
  assert.match(controls, /confirmed: true/)
  assert.match(controls, /I understand this does not revert files\./)
  assert.match(controls, /I explicitly approve running this command with full access\./)
  assert.match(controls, /Stop this process\?/)
  assert.match(controls, /process_id: terminal\.processId,[\s\S]*?confirmed: true/)
  assert.match(api, /rollbackCodexThread\(sessionId: string, input: CodexRollbackInput\)/)
  assert.match(api, /shellCodexThread\(sessionId: string, input: CodexShellInput\)/)
  assert.match(api, /terminateCodexBackgroundTerminal\([\s\S]*?input: CodexBackgroundTerminalTerminateInput/)
})

test('permission settings report failure instead of showing false success', () => {
  const savePermissions = sourceSection(controls, '  const savePermissions = () => {', '\n  const startReview = () =>')
  assert.match(savePermissions, /queueCodexPermissionUpdate/)
  assert.match(savePermissions, /const saved = await updateSession\(session\.id/)
  assert.match(savePermissions, /if \(!saved \|\| !updated \|\| !codexPermissionPatchMatches\(updated, patch\)\)/)
  assert.match(storeUpdateSession, /async updateSession\(sessionId, patch, expectedGeneration\)/)
  assert.match(storeUpdateSession, /const updated = await scope\.client\.updateSession\(sessionId, patch\)[\s\S]*?return true/)
  assert.match(storeUpdateSession, /catch \(error\) \{[\s\S]*?return false\s+\}/)
  const commandApprovalChoice = sourceSection(controls, '              label="Command approvals"', '              options={[')
  assert.doesNotMatch(
    commandApprovalChoice,
    /disabled=\{Boolean\(permissionProfile\)\}/,
    'permission profiles replace only the sandbox policy; command approvals remain independently configurable',
  )
  assert.match(commandApprovalChoice, /busy=\{savingPermissions\}/, 'permission controls must reject overlapping saves')
})

test('time-budget exhaustion is visible before a blocked goal turn', () => {
  assert.match(types, /time_budget_exhausted\?: boolean/)
  assert.match(controls, /runtime\?\.time_budget_exhausted === true \|\| Boolean\(/)
  assert.match(controls, /runtime\.goal\.timeUsedSeconds >= runtime\.time_budget_seconds/)
  assert.match(controls, /Time budget exhausted\. New goal turns are blocked/)
  assert.match(goalHelpers, /Time budget exhausted\. Increase or remove the time limit/)
  assert.match(goalBar, /view\.timeBudgetExhausted \|\| view\.tokenBudgetExhausted/)
})

test('mobile persistent goal controls are visible, directly editable, and touch accessible', () => {
  assert.match(composer, /<CodexGoalBar \/>/)
  assert.match(controls, /<CodexGoalEditor key=\{scopeKey\} \/>/)
  assert.match(controls, /useEffect\(\(\) => \{ if \(visible\) void refresh\(\)/)
  assert.match(goalBar, /accessibilityLabel="Persistent Codex goal"/)
  assert.match(goalBar, /accessibilityLabel="Edit goal"/)
  assert.match(goalBar, /accessibilityLabel=\{actionLabel\}/)
  assert.match(goalBar, /action: \{ minHeight: 44, minWidth: 44/)
  assert.match(goalBar, /Alert\.alert\('Clear persistent goal\?'/)
  assert.match(goalBar, /text: 'Cancel', style: 'cancel'/)
  assert.match(goalBar, /text: 'Clear goal', style: 'destructive'/)
})

test('mobile exposes the full native Codex control endpoint surface', () => {
  for (const endpoint of [
    '/codex/runtime',
    '/codex/permission-profiles',
    '/codex/goal',
    '/codex/compact',
    '/codex/rollback',
    '/codex/review',
    '/codex/shell',
    '/codex/background-terminals',
  ]) {
    assert.match(api, new RegExp(endpoint.replaceAll('/', '\\/')))
  }
  assert.match(api, /\/codex\/interactions\/\$\{encodeURIComponent\(interactionId\)\}\/resolve/)
})
