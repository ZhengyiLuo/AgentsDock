import type { CodexGoal, CodexGoalInput, CodexGoalSnapshot, CodexGoalStatus, CodexRuntimeSnapshot } from '../types'
import { codexStatusLabel, codexStatusTone } from './codex-controls'

export const CODEX_GOAL_OBJECTIVE_MAX_LENGTH = 4_000

export type CodexControlsTone = 'idle' | 'active' | 'waiting' | 'error'

export function codexControlsPresentation({
  runtime,
  loading = false,
  error,
  lifecycleActive = false,
}: {
  runtime: CodexRuntimeSnapshot | null
  loading?: boolean
  error?: string | null
  lifecycleActive?: boolean
}): { label: string; tone: CodexControlsTone } {
  const count = runtime?.pending_interactions.length ?? 0
  const unavailable = runtime?.available === false
  const runtimeTone = codexStatusTone(runtime)
  // Lifecycle events can arrive before the provider's thread snapshot updates.
  const lifecycleRunning = lifecycleActive && !error && !unavailable && runtimeTone === 'idle'
  const tone = error || unavailable ? 'error' : lifecycleRunning ? 'active' : runtimeTone
  const label = count > 0
    ? `${count} waiting`
    : error
      ? 'Error'
      : unavailable
        ? 'Unavailable'
        : lifecycleRunning
          ? 'Running'
          : loading
            ? 'Loading'
            : codexStatusLabel(runtime?.status)
  return { label, tone }
}

export interface CodexGoalViewState {
  status: CodexGoalStatus | 'timeBudgetExhausted'
  label: string
  tone: 'idle' | 'active' | 'warning' | 'success'
  message: string | null
  timeBudgetExhausted: boolean
  tokenBudgetExhausted: boolean
  canPause: boolean
  canResume: boolean
}

export function goalStatusLabel(status: CodexGoalStatus): string {
  switch (status) {
    case 'active': return 'Pursuing goal'
    case 'paused': return 'Goal paused'
    case 'blocked': return 'Goal blocked'
    case 'usageLimited': return 'Usage limited'
    case 'budgetLimited': return 'Budget limited'
    case 'complete': return 'Goal complete'
  }
}

export function goalViewState(
  goal: CodexGoal | null | undefined,
  runtime?: Partial<Pick<CodexRuntimeSnapshot, 'time_budget_seconds' | 'time_budget_exhausted'>> | null,
): CodexGoalViewState | null {
  if (!goal) return null
  const timeLimit = positiveNumber(runtime?.time_budget_seconds)
  const tokenLimit = positiveNumber(goal.tokenBudget)
  const timeBudgetExhausted = runtime?.time_budget_exhausted === true
    || (timeLimit != null && nonnegativeNumber(goal.timeUsedSeconds) >= timeLimit)
  const tokenBudgetExhausted = tokenLimit != null && nonnegativeNumber(goal.tokensUsed) >= tokenLimit
  const status = timeBudgetExhausted && (goal.status === 'active' || goal.status === 'budgetLimited')
    ? 'timeBudgetExhausted'
    : tokenBudgetExhausted && goal.status === 'active'
      ? 'budgetLimited'
      : goal.status
  const budgetMessage = timeBudgetExhausted
    ? 'Time budget exhausted. Increase or remove the time limit, or change the objective, to continue.'
    : tokenBudgetExhausted
      ? 'Token budget exhausted. Increase or remove the token limit to continue.'
      : null
  let message: string | null = null
  switch (status) {
    case 'paused':
      message = budgetMessage
        ? `The goal is paused. ${budgetMessage}`
        : 'The goal is paused. Resume it to continue pursuing this objective.'
      break
    case 'blocked':
      message = `The goal is blocked. Resolve the blocker, then edit the goal to continue.${budgetMessage ? ` ${budgetMessage}` : ''}`
      break
    case 'usageLimited':
      message = `Codex usage is limited. When usage is available, edit the goal to continue.${budgetMessage ? ` ${budgetMessage}` : ''}`
      break
    case 'budgetLimited':
      message = budgetMessage ?? 'The goal reached a budget limit. Edit its budgets to continue.'
      break
    case 'complete':
      message = 'The goal is complete. Edit it to set a new objective, or clear it.'
      break
    case 'timeBudgetExhausted':
    case 'active':
      message = budgetMessage
      break
  }
  return {
    status,
    label: status === 'timeBudgetExhausted' ? 'Time budget exhausted' : goalStatusLabel(status),
    tone: status === 'complete'
      ? 'success'
      : status === 'paused'
        ? 'idle'
        : status === 'active' && !tokenBudgetExhausted
          ? 'active'
          : 'warning',
    message,
    timeBudgetExhausted,
    tokenBudgetExhausted,
    canPause: goal.status === 'active',
    // Match desktop: a paused goal can request activation. Keep exhaustion
    // visible, but let the server decide whether its current budget permits it.
    canResume: goal.status === 'paused',
  }
}

export function goalElapsedSeconds(
  goal: CodexGoal,
  { threadActive, observedAt, now }: { threadActive: boolean; observedAt: number; now: number },
): number {
  const elapsed = nonnegativeNumber(goal.timeUsedSeconds)
  if (goal.status !== 'active' || !threadActive) return elapsed
  const sinceObserved = nonnegativeNumber((now - observedAt) / 1_000)
  return elapsed + Math.floor(sinceObserved)
}

export function formatGoalDuration(seconds: number): string {
  const whole = Math.floor(nonnegativeNumber(seconds))
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

export function formatGoalBudget(used: number, budget?: number | null, duration = false): string {
  const format = duration
    ? formatGoalDuration
    : (value: number) => Math.floor(nonnegativeNumber(value)).toLocaleString()
  const current = format(used)
  const limit = positiveNumber(budget)
  return limit == null ? current : `${current} / ${format(limit)}`
}

export function parseGoalBudget(value: string, label = 'Budget'): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number or left empty.`)
  }
  return parsed
}

export function buildCodexGoalInput({ objective, status = 'active', tokenBudget, timeBudget }: {
  objective: string
  status?: CodexGoalStatus
  tokenBudget: string
  timeBudget: string
}): CodexGoalInput {
  const trimmedObjective = objective.trim()
  if (!trimmedObjective) throw new Error('Enter an objective for this goal.')
  if (Array.from(trimmedObjective).length > CODEX_GOAL_OBJECTIVE_MAX_LENGTH) {
    throw new Error(`The objective must be ${CODEX_GOAL_OBJECTIVE_MAX_LENGTH.toLocaleString()} characters or fewer.`)
  }
  return {
    objective: trimmedObjective,
    status,
    token_budget: parseGoalBudget(tokenBudget, 'Token budget'),
    time_budget_seconds: parseGoalBudget(timeBudget, 'Time budget'),
  }
}

export function mergeGoalSnapshot(
  runtime: CodexRuntimeSnapshot | null,
  snapshot: CodexGoalSnapshot,
): CodexRuntimeSnapshot | null {
  if (!runtime) return null
  return {
    ...runtime,
    goal: snapshot.goal,
    // A returned null clears the old limit, including on a clear-goal reply.
    time_budget_seconds: snapshot.time_budget_seconds,
    time_budget_exhausted: snapshot.time_budget_exhausted ?? false,
  }
}

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function nonnegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
