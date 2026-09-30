import { describe, expect, it } from 'vitest'
import type { CodexGoal, Event } from '@shared/types'
import { blockedGoalReport } from '@shared/blocked-goal'
const goal: CodexGoal = { threadId: 'thread', objective: 'Fix task', status: 'blocked', createdAt: 1, updatedAt: 10, tokensUsed: 1, timeUsedSeconds: 1 }
const e = (seq: number, type: string, extra: Partial<Event> = {}): Event => ({ seq, id: String(seq), session_id: 'chat', type, ts: '2026-09-29T00:00:00Z', ...extra })
const start = e(1, 'turn_started', { run_id: 'run' })
const block = e(2, 'codex_goal_updated', { goal })
const report = e(3, 'assistant_text', { run_id: 'run', phase: 'final_answer', text: 'Need the missing dataset.' })
const finish = e(4, 'turn_finished', { run_id: 'run' })
describe('blocked goal report ownership', () => {
  it('shows the matching turn report before and after completion', () => {
    expect(blockedGoalReport(goal, [start, block, report], 'chat')).toBe(report.text)
    expect(blockedGoalReport(goal, [start, block, report, finish], 'chat')).toBe(report.text)
  })
  it('retains the blocked transition across usage snapshots and unrelated follow-up messages', () => {
    expect(blockedGoalReport(goal, [start, block, report, finish, e(5, 'codex_goal_updated', { goal: { ...goal, updatedAt: 11 } }), e(6, 'turn_started', { run_id: 'later' }), e(7, 'turn_finished', { run_id: 'later', result_text: 'Unrelated reply' })], 'chat')).toBe(report.text)
  })
  it('accepts authoritative final text and a final preceding the blocked notification', () => {
    expect(blockedGoalReport(goal, [start, report, block, e(4, 'turn_finished', { run_id: 'run', result_text: 'Final report' })], 'chat')).toBe('Final report')
  })
  it('does not borrow an old report when the user blocks an idle goal', () => {
    expect(blockedGoalReport(goal, [start, report, finish, e(5, 'codex_goal_updated', { goal })], 'chat')).toBeNull()
  })
  it('does not treat commentary or reasoning as a reason', () => {
    expect(blockedGoalReport(goal, [start, block, { ...report, phase: 'commentary' }, e(4, 'reasoning_summary', { run_id: 'run', text: 'Private analysis' })], 'chat')).toBeNull()
  })
  it.each([{ session_id: 'other' }, { forked: true }, { imported: true }, { metadata_only: true }, { run_id: 'child' }])('rejects foreign or historical reports %s', extra => {
    expect(blockedGoalReport(goal, [start, block, { ...report, ...extra }], 'chat')).toBeNull()
  })
  it('never keeps a previous goal or blocking episode report', () => {
    expect(blockedGoalReport({ ...goal, createdAt: 2 }, [start, block, report], 'chat')).toBeNull()
    expect(blockedGoalReport({ ...goal, status: 'active' }, [start, block, report], 'chat')).toBeNull()
    expect(blockedGoalReport(goal, [start, block, report, finish, e(5, 'codex_goal_updated', { goal: { ...goal, status: 'active' } }), e(6, 'codex_goal_updated', { goal })], 'chat')).toBeNull()
  })
})
