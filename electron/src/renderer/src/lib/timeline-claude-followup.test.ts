import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { incompleteLeadingRunId, isNativeGoalSteerEvent, timelineSemanticUnits } from '@shared/semantic-timeline'
import { updateQueuedTurns } from '@shared/queue'
import { mergeEvents, snapshotNeedsAuthoritativeTail, updateActiveSessions } from '../store/app-store'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `claude-event-${seq}`, seq, type, session_id: 'chat', run_id: 'claude-owner', backend: 'claude',
  ts: new Date(Date.UTC(2026, 9, 23, 10, 0, seq)).toISOString(), ...patch
})
const followup = (seq = 4, patch: Partial<Event> = {}): Event => event(seq, 'turn_steered', {
  native_steer: true, native_followup: true, provider_user_authored: true,
  provider_message_id: `accepted-native-${seq}`, queued_id: `queued-${seq}`,
  prompt: 'Also check the deployment logs.', file_ids: [], ...patch
})
const history = (): Event[] => [
  event(1, 'turn_started', { prompt: 'Verify deployment.' }),
  event(2, 'reasoning_summary', { text: 'Checking the deployment.' }),
  event(3, 'tool_started', { tool_id: 'tool-one', tool: { name: 'Bash' } }),
  followup(),
  event(5, 'tool_finished', { tool_id: 'tool-one', tool: { name: 'Bash' }, output: 'Deployment verified.' }),
  event(6, 'reasoning_summary', { text: 'Checking logs while keeping the same workflow.' })
]

describe('accepted Claude native follow-up', () => {
  beforeEach(clearTimelineProjectionCache)

  it('shows one chronological user bubble while preserving tool, reasoning and active-run state', () => {
    const items = projectTimeline(history(), [])
    const rows = renderTimelineItems(items)
    expect(rows.filter(row => row.kind === 'message').map(row => [row.seq, row.role, row.event.prompt])).toEqual([
      [1, 'user', 'Verify deployment.'], [4, 'user', 'Also check the deployment logs.']
    ])
    expect(items.filter(item => item.kind === 'turn').flatMap(item => item.trace.map(trace => trace.seq))).toEqual([2, 3, 5, 6])
    expect(rows.filter(row => row.kind === 'progress').at(-1)).toMatchObject({ active: true, stoppedAt: undefined })
    const active = new Set(['chat'])
    expect(updateActiveSessions(active, followup())).toBe(active)
    expect(updateActiveSessions(new Set(), followup())).toEqual(new Set())
  })

  it('matches live appends, duplicate replay, partial history and cold reopen', () => {
    const source = history()
    for (let count = 1; count <= source.length; count++) {
      const events = source.slice(0, count)
      expect(cachedTimelineProjection('claude-followup-live', events, []).rendered)
        .toEqual(renderTimelineItems(projectTimeline(events, [])))
    }
    const replayed = mergeEvents(mergeEvents([], source.slice(3)), source)
    expect(replayed).toEqual(source)
    expect(renderTimelineItems(projectTimeline(replayed, [])))
      .toEqual(cachedTimelineProjection('claude-followup-live', source, []).rendered)
    expect(incompleteLeadingRunId(source.slice(3))).toBeNull()
    expect(timelineSemanticUnits(source).map(unit => [unit.key, unit.events.map(value => value.seq)])).toEqual([
      ['run:claude-owner', [1, 2, 3]], ['run:claude-owner:start-4', [4, 5, 6]]
    ])
  })

  it('shows human input separately from its still-running scheduled owner without moving job output', () => {
    const source = history().map(value => value.seq === 4 ? value : { ...value, purpose: 'scheduled_job', job_id: 'job-one' })
    const items = projectTimeline(source, [])
    const rows = renderTimelineItems(items)
    expect(rows.filter(row => row.kind === 'message')).toHaveLength(1)
    expect(rows.find(row => row.kind === 'message')).toMatchObject({ role: 'user', seq: 4, event: { prompt: followup().prompt } })
    const job = items.find(item => item.kind === 'job')!
    expect(job.kind).toBe('job')
    if (job.kind !== 'job') throw Error('missing job')
    expect(job.events.some(value => value.id === followup().id)).toBe(false)
    expect(job.events.map(value => value.seq)).toEqual(expect.arrayContaining([2, 3, 5, 6]))
    expect(timelineSemanticUnits(source).map(unit => [unit.key, unit.events.map(value => value.seq)])).toEqual([
      ['job:job-one', [1, 2, 3, 5, 6]], ['run:claude-owner:start-4', [4]]
    ])
    expect(updateActiveSessions(new Set(['chat']), followup())).toEqual(new Set(['chat']))
  })

  it('clears only its accepted queue row and retains attachment-only user input', () => {
    const file = { id: 'file-1', session_id: 'chat', filename: 'notes.txt', kind: 'text', mime_type: 'text/plain' } as AgentFile
    const input = followup(4, { prompt: '', file_ids: ['file-1'] })
    const queue = [4, 9].map(seq => ({ queued_id: `queued-${seq}`, session_id: 'chat', prompt: 'follow-up', file_ids: [], position: seq }))
    expect(updateQueuedTurns(queue, input)).toEqual([queue[1]])
    expect(renderTimelineItems(projectTimeline([input], [file]))[0]).toMatchObject({ role: 'user', files: [file] })
    expect(snapshotNeedsAuthoritativeTail({ session: { id: 'chat', title: 'Claude', backend: 'claude' }, events: [input],
      files: [file], queuedTurns: [], hasMoreEvents: false, eventsTotal: 1, filesTotal: 1, cachedAt: 0 })).toBe(false)
  })

  it.each([
    { native_followup: false }, { native_steer: false }, { backend: 'codex' as const },
    { purpose: 'scheduled_job' }, { purpose: 'chat_mailbox_wake' }, { provider_generated: true },
    { provider_user_authored: undefined }, { run_id: undefined }, { provider_message_id: undefined }, { provider_message_id: ' ' }
  ])('does not promote unproven/internal events into user input: %j', patch => {
    const input = followup(4, patch)
    expect(isNativeGoalSteerEvent(input)).toBe(false)
    expect(renderTimelineItems(projectTimeline([input], [])).some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    const queue = [{ queued_id: 'queued-4', session_id: 'chat', prompt: 'Held', file_ids: [] }]
    expect(updateQueuedTurns(queue, input)).toBe(queue)
  })
})
