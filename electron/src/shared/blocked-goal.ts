import type { CodexGoal, Event } from './types'

/** Native goals carry no reason field. Show a report only from the owning turn,
 * never reinterpret an unrelated latest reply as the cause of a blocked goal. */
export function blockedGoalReport(goal: CodexGoal | null | undefined, events: readonly Event[], sessionId: string): string | null {
  if (goal?.status !== 'blocked') return null
  let owner: string | null = null
  let blockedRun: string | null = null
  let inBlockedState = false
  const reports = new Map<string, string>()
  for (const event of events) {
    if (event.session_id !== sessionId || event.forked || event.imported || event.metadata_only) continue
    if (event.type === 'turn_started') owner = event.run_id || null
    if (event.type === 'codex_goal_cleared') { inBlockedState = false; blockedRun = null }
    if (event.type === 'codex_goal_updated') {
      const current = event.goal
      const matches = current?.threadId === goal.threadId && current.createdAt === goal.createdAt
        && current.objective === goal.objective && current.status === 'blocked'
      if (!matches) { inBlockedState = false; blockedRun = null }
      else if (!inBlockedState) {
        inBlockedState = true
        blockedRun = event.run_id || owner
      }
    }
    if (event.run_id && event.type === 'assistant_text' && event.phase === 'final_answer' && event.text?.trim()) {
      reports.set(event.run_id, event.text.trim())
    }
    if (event.type === 'turn_finished') {
      if (event.run_id && event.result_text?.trim()) reports.set(event.run_id, event.result_text.trim())
      if (!event.run_id || event.run_id === owner) owner = null
    }
    if (event.type === 'turn_stopped' && (!event.run_id || event.run_id === owner)) owner = null
  }
  return blockedRun ? reports.get(blockedRun) ?? null : null
}
