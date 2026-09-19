import {
  CODEX_GOAL_OBJECTIVE_MAX_LENGTH,
  buildCodexGoalInput,
  codexControlsPresentation,
  formatGoalBudget,
  formatGoalDuration,
  goalElapsedSeconds,
  goalStatusLabel,
  goalViewState,
  mergeGoalSnapshot,
  parseGoalBudget,
} from './codex-goals'
import type { CodexGoal, CodexGoalStatus, CodexRuntimeSnapshot } from '../types'

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, received ${String(actual)}`)
}

function rejects(operation: () => unknown, text: string): void {
  let error: unknown
  try { operation() } catch (cause) { error = cause }
  assert(error instanceof Error && error.message.includes(text), `Expected error containing ${text}`)
}

const goal: CodexGoal = {
  threadId: 'thread-1',
  objective: 'Finish the mobile controls',
  status: 'active',
  tokenBudget: 20_000,
  tokensUsed: 4_500,
  timeUsedSeconds: 70,
  createdAt: 1,
  updatedAt: 2,
}
const runtime: CodexRuntimeSnapshot = {
  available: true,
  transport: 'app-server',
  interactive_capability: 'codex_interactive_v1',
  thread_loaded: true,
  status: { type: 'idle' },
  goal,
  time_budget_seconds: 600,
  time_budget_exhausted: false,
  pending_interactions: [],
  permission_profiles: [],
  background_terminals_supported: true,
}

equal(goalViewState(null), null)
equal(goalViewState(undefined, runtime), null)
equal(goalViewState(goal, runtime)?.label, 'Pursuing goal')
equal(goalViewState(goal, runtime)?.canPause, true)
equal(goalViewState(goal, runtime)?.canResume, false)

const statusCases: Array<[CodexGoalStatus, string, boolean]> = [
  ['paused', 'Goal paused', true],
  ['blocked', 'Goal blocked', false],
  ['usageLimited', 'Usage limited', false],
  ['budgetLimited', 'Budget limited', false],
  ['complete', 'Goal complete', false],
]
for (const [status, label, canResume] of statusCases) {
  const view = goalViewState({ ...goal, status }, runtime)
  equal(view?.label, label)
  equal(goalStatusLabel(status), label)
  equal(view?.canPause, false)
  equal(view?.canResume, canResume, `Only a paused goal offers Resume: ${status}`)
  assert(view?.message, `${status} should explain the goal state`)
}

const timeLimitedRuntime = { ...runtime, time_budget_exhausted: true }
equal(goalViewState(goal, timeLimitedRuntime)?.status, 'timeBudgetExhausted')
equal(goalViewState(goal, timeLimitedRuntime)?.canPause, true, 'An active goal can still be paused after its time budget runs out')
equal(goalViewState({ ...goal, status: 'budgetLimited' }, timeLimitedRuntime)?.label, 'Time budget exhausted')
const pausedAtTimeLimit = goalViewState({ ...goal, status: 'paused' }, timeLimitedRuntime)
equal(pausedAtTimeLimit?.label, 'Goal paused', 'Time exhaustion must not conceal that the goal is paused')
equal(pausedAtTimeLimit?.canResume, true, 'The server decides whether a paused goal can activate with its current time budget')
assert(pausedAtTimeLimit?.message?.includes('Time budget exhausted'))
equal(goalViewState({ ...goal, status: 'complete' }, timeLimitedRuntime)?.label, 'Goal complete')
equal(goalViewState({ ...goal, status: 'blocked' }, timeLimitedRuntime)?.label, 'Goal blocked')

// Older servers lack an exhaustion flag; keep their reported exhaustion visible
// without overriding the desktop status-only activation contract.
equal(goalViewState({ ...goal, timeUsedSeconds: 600 }, { time_budget_seconds: 600 })?.timeBudgetExhausted, true)
equal(goalViewState({ ...goal, timeUsedSeconds: 601 }, { time_budget_seconds: 600 })?.timeBudgetExhausted, true)
equal(goalViewState(goal, { time_budget_seconds: null })?.timeBudgetExhausted, false)
equal(goalViewState(goal, { time_budget_seconds: 0 })?.timeBudgetExhausted, false)
const pausedAtTokenLimit = goalViewState({ ...goal, status: 'paused', tokensUsed: 20_000 }, runtime)
equal(pausedAtTokenLimit?.canResume, true)
equal(pausedAtTokenLimit?.tokenBudgetExhausted, true)
assert(pausedAtTokenLimit?.message?.includes('Token budget exhausted'))
equal(goalViewState({ ...goal, tokensUsed: 20_000 }, runtime)?.label, 'Budget limited', 'Exhausted token usage must not appear to be pursuing a goal')
equal(goalViewState({ ...goal, tokensUsed: 20_000 }, runtime)?.canPause, true, 'An active goal can still be paused after its token budget runs out')
equal(goalViewState({ ...goal, tokenBudget: null, tokensUsed: 1_000_000 }, runtime)?.tokenBudgetExhausted, false)

// A local display clock advances only an actively pursued, running goal.
const clock = { threadActive: true, observedAt: 10_000, now: 14_900 }
equal(goalElapsedSeconds(goal, clock), 74)
equal(goalElapsedSeconds(goal, { ...clock, threadActive: false }), 70)
equal(goalElapsedSeconds({ ...goal, status: 'paused' }, clock), 70)
equal(goalElapsedSeconds({ ...goal, status: 'complete' }, clock), 70)
equal(goalElapsedSeconds(goal, { ...clock, now: 9_000 }), 70, 'Clock rollback must not reduce server elapsed time')
equal(goalElapsedSeconds({ ...goal, timeUsedSeconds: -3 }, { ...clock, now: Number.NaN }), 0)
equal(formatGoalDuration(59.9), '59s')
equal(formatGoalDuration(60), '1m')
equal(formatGoalDuration(3_600), '1h')
equal(formatGoalDuration(7_325), '2h 2m')
equal(formatGoalDuration(Number.POSITIVE_INFINITY), '0s')
equal(formatGoalBudget(4_500, 20_000), `${(4_500).toLocaleString()} / ${(20_000).toLocaleString()}`)
equal(formatGoalBudget(70, 600, true), '1m / 10m')
equal(formatGoalBudget(70, null, true), '1m')
equal(formatGoalBudget(-1, Number.NaN), '0')

equal(parseGoalBudget(''), null)
equal(parseGoalBudget(' \n '), null)
equal(parseGoalBudget(' 42 '), 42)
equal(parseGoalBudget(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e309', '9007199254740992', '12 tokens']) {
  rejects(() => parseGoalBudget(invalid, 'Token budget'), 'Token budget must be a positive whole number')
}
const draft = { objective: '  Ship the goal controls\n', status: 'paused' as const, tokenBudget: '5000', timeBudget: ' ' }
const input = buildCodexGoalInput(draft)
equal(input.objective, 'Ship the goal controls')
equal(input.status, 'paused')
equal(input.token_budget, 5_000)
equal(input.time_budget_seconds, null, 'A blank limit explicitly clears an existing budget')
rejects(() => buildCodexGoalInput({ ...draft, objective: ' \n ' }), 'Enter an objective')
rejects(() => buildCodexGoalInput({ ...draft, objective: 'a'.repeat(CODEX_GOAL_OBJECTIVE_MAX_LENGTH + 1) }), 'characters or fewer')
rejects(() => buildCodexGoalInput({ ...draft, timeBudget: '0' }), 'Time budget must be a positive whole number')
equal(buildCodexGoalInput({ ...draft, objective: '😀'.repeat(CODEX_GOAL_OBJECTIVE_MAX_LENGTH) }).objective?.length, 8_000)

// The mutation reply takes effect immediately, while unrelated runtime data
// survives until the next complete runtime snapshot arrives.
const pausedGoal = { ...goal, status: 'paused' as const }
const pausedRuntime = mergeGoalSnapshot(runtime, {
  goal: pausedGoal,
  time_budget_seconds: 1_200,
  time_budget_exhausted: false,
})
assert(pausedRuntime)
equal(pausedRuntime.goal, pausedGoal)
equal(pausedRuntime.time_budget_seconds, 1_200)
equal(pausedRuntime.status, runtime.status)
equal(pausedRuntime.pending_interactions, runtime.pending_interactions)
equal(runtime.goal, goal, 'Merging must not mutate the original runtime')
const limitedRuntime = mergeGoalSnapshot(pausedRuntime, {
  goal: pausedGoal,
  time_budget_seconds: 70,
  time_budget_exhausted: true,
})
equal(limitedRuntime?.time_budget_exhausted, true)
const clearedRuntime = mergeGoalSnapshot(limitedRuntime, { goal: null, time_budget_seconds: null })
equal(clearedRuntime?.goal, null)
equal(clearedRuntime?.time_budget_seconds, null)
equal(clearedRuntime?.time_budget_exhausted, false, 'An older reply must not inherit a previous goal exhaustion flag')
equal(mergeGoalSnapshot(null, { goal, time_budget_seconds: 900 }), null, 'A goal-only reply cannot invent runtime availability')

equal(codexControlsPresentation({ runtime, lifecycleActive: true }).label, 'Running')
equal(codexControlsPresentation({ runtime, lifecycleActive: true }).tone, 'active')
equal(codexControlsPresentation({ runtime: null, lifecycleActive: true, loading: true }).label, 'Running')
equal(codexControlsPresentation({ runtime, lifecycleActive: false }).label, 'Idle')
equal(codexControlsPresentation({ runtime: null, loading: true }).label, 'Loading')
equal(codexControlsPresentation({ runtime, lifecycleActive: true, error: 'Refresh failed' }).label, 'Error')
equal(codexControlsPresentation({ runtime: { ...runtime, available: false }, lifecycleActive: true }).label, 'Unavailable')
equal(codexControlsPresentation({ runtime: { ...runtime, status: { type: 'systemError' } }, lifecycleActive: true }).label, 'Runtime error')
const approvalRuntime: CodexRuntimeSnapshot = { ...runtime, status: { type: 'active', activeFlags: ['waitingOnApproval'] } }
equal(codexControlsPresentation({ runtime: approvalRuntime, lifecycleActive: true }).label, 'Approval needed')
equal(codexControlsPresentation({ runtime: approvalRuntime, lifecycleActive: true }).tone, 'waiting')
const answerRuntime: CodexRuntimeSnapshot = { ...runtime, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }
equal(codexControlsPresentation({ runtime: answerRuntime, lifecycleActive: true }).label, 'Answer needed')
const pendingRuntime: CodexRuntimeSnapshot = {
  ...runtime,
  pending_interactions: [{ id: 'approval-1', session_id: 'chat-1', thread_id: 'thread-1', method: 'approval', params: {}, created_at: '' }],
}
equal(codexControlsPresentation({ runtime: pendingRuntime, lifecycleActive: true }).label, '1 waiting')
equal(codexControlsPresentation({ runtime: pendingRuntime, lifecycleActive: true, error: 'Refresh failed' }).label, '1 waiting')
equal(codexControlsPresentation({ runtime: pendingRuntime, lifecycleActive: true, error: 'Refresh failed' }).tone, 'error')

console.log('codex goal helper tests passed')
