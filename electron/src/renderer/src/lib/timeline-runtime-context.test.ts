import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { isAgentVisibleEvent, isTimelineError, messageItemText, projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const prompt = '<codex_internal_context source="goal">\n'
  + 'Continue working toward the active thread goal.\n'
  + '<objective>Finish the renderer task.</objective>\n</codex_internal_context>'
const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: `2026-09-10T10:00:0${seq}Z`, ...patch
})
const context = (seq: number, patch: Partial<Event> = {}): Event => event(seq, 'turn_started', {
  imported: true, backend: 'codex', run_id: 'import_codex-history', prompt,
  provider_runtime_context: 'goal', metadata_only: true, ...patch
})

describe('goal-runtime timeline projection', () => {
  it('keeps Claude goal refresh events out of the visible conversation', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend: 'claude', run_id: 'goal-run', prompt: '/goal Complete the task' }),
      event(2, 'claude_goal_changed', { backend: 'claude' }),
      event(3, 'assistant_text', { backend: 'claude', run_id: 'goal-run', text: 'The task is complete.' }),
      event(4, 'turn_finished', { backend: 'claude', run_id: 'goal-run' })
    ], []))
    expect(rows.filter(row => row.kind === 'message').map(row => messageItemText(row)))
      .toEqual(['/goal Complete the task', 'The task is complete.'])
    expect(rows.some(row => row.kind === 'system')).toBe(false)
  })

  it('ends only the echoed import slice when a new goal continuation follows it', () => {
    const suffix = '\n\n[AgentsDock provider authority]\n'
      + 'authority-file=/Users/test/.agentsdock/cross_chat_authority/run_aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)\n'
      + 'actions=cross_chat_instruction\nusage: see AgentsDock instructions\n[End AgentsDock provider authority]'
    const run_id = 'import_codex-history'
    const records = [
      event(1, 'turn_started', { backend: 'codex', imported: true, run_id, prompt: `Duplicated native prompt${suffix}` }),
      event(2, 'assistant_text', { backend: 'codex', imported: true, run_id, text: 'Duplicated native answer' }),
      context(3),
      event(4, 'assistant_text', { backend: 'codex', imported: true, run_id, text: 'New goal continuation answer' }),
      event(5, 'turn_finished', { backend: 'codex', imported: true, run_id })
    ]
    const rows = renderTimelineItems(projectTimeline(records, []))
    expect(rows.map(row => row.kind === 'message' ? messageItemText(row) : row.kind))
      .toEqual(['New goal continuation answer'])
    clearTimelineProjectionCache()
    cachedTimelineProjection('echo-goal', records.slice(0, 2), [])
    expect(cachedTimelineProjection('echo-goal', records, []).rendered).toEqual(rows)
  })

  it.each(['codex', 'claude'] as const)('keeps %s work after an earlier answer visible through interruption', backend => {
    const live = [
      event(1, 'turn_started', { backend, run_id: 'goal-run', prompt: 'Review the task' }),
      event(2, 'assistant_text', { backend, run_id: 'goal-run', text: 'An earlier answer', phase: 'final_answer' }),
      event(3, 'reasoning_summary', { backend, run_id: 'goal-run', phase: 'commentary', text: 'The next part is still being checked' })
    ]
    const running = renderTimelineItems(projectTimeline(live, []))
    expect(running.map(row => row.kind)).toEqual(['message', 'message', 'progress'])
    expect(running.at(-1)).toMatchObject({ kind: 'progress', active: true, hasFinalResponse: false })
    const stopped = renderTimelineItems(projectTimeline([
      ...live, event(4, 'turn_stopped', { backend, run_id: 'goal-run' })
    ], []))
    expect(stopped.at(-1)).toMatchObject({ kind: 'progress', active: false, hasFinalResponse: false, stoppedAt: expect.any(String) })
    const finished = renderTimelineItems(projectTimeline([
      ...live, event(4, 'turn_finished', { backend, run_id: 'goal-run', result_text: 'The latest final answer' })
    ], []))
    expect(finished.map(row => row.kind)).toEqual(['message', 'message', 'progress', 'message'])
    expect(finished.at(-2)).toMatchObject({ kind: 'progress', active: false, hasFinalResponse: true })
  })

  it('hides proven context without retiring live work or projecting control fields', () => {
    const start = event(1, 'turn_started', { run_id: 'live-run', prompt: 'Keep working on the real task' })
    const control = context(2, { job_id: 'false-job', purpose: 'scheduled_job', is_error: true, error: 'Not an error' })
    const items = projectTimeline([
      start, control, context(3, { prompt: '', metadata_only: true, provider_runtime_context: 'goal' }),
      event(4, 'reasoning_summary', { run_id: 'live-run', text: 'Real progress' })
    ], [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'turn', runId: 'live-run', user: start })
    expect(items[0].kind === 'turn' && items[0].finishedAt).toBeUndefined()
    expect(renderTimelineItems(items).filter(row => row.kind === 'message')).toHaveLength(1)
    expect(isAgentVisibleEvent(control)).toBe(false)
    expect(isTimelineError(control)).toBe(false)
  })

  it('retains assistant continuations and later real user turns in one imported run', () => {
    const imported = { imported: true, backend: 'codex' as const, run_id: 'import_codex-history' }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { ...imported, prompt: 'Actual user request' }),
      event(2, 'assistant_text', { ...imported, text: 'Initial answer' }), context(3),
      event(4, 'assistant_text', { ...imported, text: 'Goal continuation answer' }),
      event(5, 'turn_started', { ...imported, prompt: 'Another actual user request' }),
      event(6, 'turn_finished', { ...imported, result_text: 'Final answer' })
    ], []))
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user').map(row =>
      row.kind === 'message' && messageItemText(row)
    )).toEqual(['Actual user request', 'Another actual user request'])
    const assistants = rows.filter(row => row.kind === 'message' && row.role === 'assistant')
      .map(row => row.kind === 'message' ? messageItemText(row) : '').join('\n')
    expect(assistants).toContain('Initial answer')
    expect(assistants).toContain('Goal continuation answer')
    expect(assistants).toContain('Final answer')
    expect(rows.some(row => row.kind === 'message' && messageItemText(row).includes('codex_internal_context'))).toBe(false)
  })

  it.each([
    { imported: false }, { provider_user_authored: true },
    { provider_runtime_context: undefined, metadata_only: undefined },
    { prompt: `Explain this:\n${prompt}` }, { prompt: `${prompt}\nWhat is it?` }
  ])('retains genuine user quotations %j', patch => {
    const record = context(1, patch)
    const rows = renderTimelineItems(projectTimeline([record], []))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', role: 'user', event: record })
  })

  it('keeps cached append projection identical to cold history without adding a user bubble', () => {
    clearTimelineProjectionCache()
    const events = [event(1, 'turn_started', { run_id: 'live-run', prompt: 'Real task' })]
    const first = cachedTimelineProjection('chat-1:runtime-live', events, [])
    events.push(context(2))
    const next = cachedTimelineProjection('chat-1:runtime-live', events, [])
    expect(next.strategy).toBe('append')
    expect(next.rendered).toBe(first.rendered)
    expect(next.semantic[0]).toBe(first.semantic[0])
    expect(next.rendered).toEqual(cachedTimelineProjection('chat-1:runtime-cold', events, []).rendered)
  })
})
