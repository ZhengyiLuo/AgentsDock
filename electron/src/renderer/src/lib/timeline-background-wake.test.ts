import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { updateActiveSessions } from '../store/app-store'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `wake-${seq}`, session_id: 'chat-wake', seq, type,
  ts: `2026-10-27T12:00:0${seq}Z`, run_id: 'native-wake', backend: 'claude', ...patch
})
const wake = (patch: Partial<Event> = {}): Event => event(1, 'turn_started', {
  purpose: 'provider_background_wake', prompt: '', provider_generated: true, metadata_only: true,
  parent_run_id: 'native-parent', parent_run_ids: ['native-parent'], provider_session_id: 'native-thread',
  provider_task_id: 'task-1', provider_task_ids: ['task-1'], provider_task_type: 'local_bash',
  provider_tool_use_id: 'tool-1', ...patch
})
const scheduledWake = (patch: Partial<Event> = {}): Event => wake({
  provider_wake_kind: 'schedule', provider_schedule_id: 'schedule-1', provider_schedule_ids: ['schedule-1'],
  provider_native_wake_id: 'native-command-1', provider_task_id: undefined,
  provider_task_ids: undefined, provider_task_type: undefined, ...patch
})

describe('native background wake boundary', () => {
  it('keeps a deferred human input in place while showing its later execution after the native wake', () => {
    const records = [
      event(1, 'turn_started', { run_id: 'human', prompt: 'A normal follow-up.' }),
      scheduledWake({ seq: 2, id: 'cron-start', ts: '2026-10-27T12:00:02Z' }),
      event(3, 'tool_started', { tool: { id: 'cron-tool', name: 'Bash', input: {} } }),
      event(4, 'assistant_text', { text: 'Cron complete.' }),
      event(5, 'turn_finished'),
    ]
    clearTimelineProjectionCache()
    cachedTimelineProjection('deferred-cron-human', records, [])
    records.push(event(6, 'reasoning_summary', { run_id: 'human', text: 'Answering the follow-up.',
      provider_admission_after_run_id: 'native-wake' }))
    const active = cachedTimelineProjection('deferred-cron-human', records, []).rendered
    expect(active.filter(row => row.kind === 'progress').at(-1)).toMatchObject({
      active: true, events: [{ run_id: 'human' }], afterSeq: 5
    })
    records.push(event(7, 'assistant_text', { run_id: 'human', text: 'Human reply.',
      provider_admission_after_run_id: 'native-wake' }), event(8, 'turn_finished', {
      run_id: 'human', provider_admission_after_run_id: 'native-wake'
    }))
    const cold = renderTimelineItems(projectTimeline(records, []))
    expect(cachedTimelineProjection('deferred-cron-human', records, []).rendered).toEqual(cold)
    expect(cold.filter(row => row.kind === 'message').map(row => row.event.seq)).toEqual([1, 4, 7])
    // Compact history may omit the trace, but the retained final still carries
    // the server's exact execution boundary. It must not duplicate the input.
    const compact = renderTimelineItems(projectTimeline(records.filter(e => ![3, 6].includes(e.seq)), []))
    expect(compact.filter(row => row.kind === 'message').map(row => row.event.seq)).toEqual([1, 4, 7])
  })

  it.each([['schedule-1'], ['schedule-1', 'schedule-2']])('streams a scheduled wake with candidate schedules %j without showing its internal input', (...ids) => {
    const records = [scheduledWake({ provider_schedule_id: ids.length === 1 ? ids[0] : undefined, provider_schedule_ids: ids }),
      event(2, 'reasoning_summary', { text: 'Checking scheduled work.', phase: 'commentary' })]
    clearTimelineProjectionCache()
    const live = cachedTimelineProjection('scheduled-wake', records, []).rendered
    expect(live.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(live.find(row => row.kind === 'progress')).toMatchObject({ active: true })
    expect(updateActiveSessions(new Set(), records[0]).has('chat-wake')).toBe(true)
    records.push(event(3, 'assistant_text', { text: 'Scheduled work complete.' }), event(4, 'turn_finished'))
    const cold = renderTimelineItems(projectTimeline(records, []))
    expect(cachedTimelineProjection('scheduled-wake', records, []).rendered).toEqual(cold)
    expect(cold.filter(row => row.kind === 'message')).toMatchObject([{ role: 'assistant', event: { seq: 3 } }])
    expect(records.reduce(updateActiveSessions, new Set<string>()).has('chat-wake')).toBe(false)
  })

  it.each([
    { provider_native_wake_id: undefined }, { provider_schedule_ids: [] },
    { provider_schedule_ids: [''] }, { provider_schedule_id: 'another-schedule' },
    { provider_tool_use_id: undefined }, { provider_user_authored: true },
    { prompt: 'A real user instruction.' }, { metadata_only: false }
  ] satisfies Partial<Event>[])('retains user or unproven schedule input: %j', patch => {
    const rows = renderTimelineItems(projectTimeline([scheduledWake(patch)], []))
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
  })

  it('keeps active work and its answer without an empty user bubble, cold and appended', () => {
    const records = [wake(), event(2, 'reasoning_summary', { text: 'Checking the background result.', phase: 'commentary' })]
    clearTimelineProjectionCache()
    const live = cachedTimelineProjection('background-wake', records, []).rendered
    expect(live.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(live.find(row => row.kind === 'progress')).toMatchObject({ active: true, events: [{ run_id: 'native-wake' }] })
    expect(updateActiveSessions(new Set(), records[0]).has('chat-wake')).toBe(true)
    records.push(event(3, 'turn_finished', { result_text: 'The background result is ready.' }))
    const cold = renderTimelineItems(projectTimeline(records, []))
    expect(cachedTimelineProjection('background-wake', records, []).rendered).toEqual(cold)
    expect(cold.filter(row => row.kind === 'message')).toMatchObject([{ role: 'assistant', event: { seq: 3 } }])
    expect(cold.find(row => row.kind === 'progress')).toMatchObject({ active: false })
  })

  it('keeps the native owner stoppable and retires its progress on Stop', () => {
    const records = [wake(), event(2, 'reasoning_summary', { text: 'Working.', phase: 'commentary' }), event(3, 'turn_stopped')]
    const rows = renderTimelineItems(projectTimeline(records, []))
    expect(rows.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({ active: false, events: [{ run_id: 'native-wake' }] })
    expect(records.reduce(updateActiveSessions, new Set<string>()).has('chat-wake')).toBe(false)
  })

  it.each([
    { purpose: undefined }, { provider_generated: false }, { metadata_only: false },
    { parent_run_id: undefined }, { parent_run_id: 'native-wake' }, { provider_session_id: undefined },
    { provider_task_id: undefined }, { provider_task_ids: ['different-task'] },
    { provider_task_type: 'unknown' }, { provider_tool_use_id: undefined },
    { provider_user_authored: true }, { imported: true, run_id: 'import_wake' },
    { backend: 'codex' }, { prompt: 'A real user instruction.' }
  ] satisfies Partial<Event>[])('preserves unproven or user-authored input: %j', patch => {
    const rows = renderTimelineItems(projectTimeline([wake(patch)], []))
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
  })
})
