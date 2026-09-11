import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { incompleteLeadingRunId, isNativeGoalSteerEvent, timelineSemanticUnits } from '@shared/semantic-timeline'
import { updateQueuedTurns } from '@shared/queue'
import { mergeEvents, snapshotNeedsAuthoritativeTail, updateActiveSessions } from '../store/app-store'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { buildTimelineLandmarks } from './timeline-minimap'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `goal-event-${seq}`, seq, type, session_id: 'chat', run_id: 'goal-owner', backend: 'codex',
  ts: new Date(Date.UTC(2026, 8, 10, 10, 0, seq)).toISOString(), ...patch
})
const steer = (seq = 5, patch: Partial<Event> = {}): Event => event(seq, 'turn_steered', {
  purpose: 'codex_goal_resume', native_steer: true, native_goal_steer: true, provider_user_authored: true,
  provider_turn_id: 'native-turn', queued_id: `queued-${seq}`, prompt: `Follow-up ${seq}: keep the same goal running.`, file_ids: [], ...patch
})
const history = (): Event[] => [
  event(1, 'turn_started', { prompt: 'Keep working on the overnight goal.' }),
  event(2, 'reasoning_summary', { phase: 'commentary', text: 'Earlier goal progress.' }),
  event(3, 'assistant_text', { phase: 'final_answer', text: 'Earlier goal result.' }),
  event(4, 'reasoning_summary', { phase: 'commentary', text: 'Progress before the follow-up.' }),
  steer(),
  event(6, 'reasoning_summary', { phase: 'commentary', text: 'Progress after the follow-up.' }),
  event(7, 'assistant_text', { phase: 'final_answer', text: 'The follow-up is incorporated.' }),
  event(8, 'reasoning_summary', { phase: 'commentary', text: 'The same goal continues.' }),
  steer(9),
  event(10, 'reasoning_summary', { phase: 'commentary', text: 'Continuing after the second follow-up.' })
]

describe('native goal steering presentation', () => {
  beforeEach(clearTimelineProjectionCache)

  it('adds chronological user segments without rebinding, stopping, or replacing the goal owner', () => {
    const items = projectTimeline(history(), [])
    expect(items.filter(item => item.kind === 'turn').map(item => [item.key, item.runId])).toEqual([
      ['turn:goal-owner', 'goal-owner'], ['turn:goal-owner:start-5', 'goal-owner'], ['turn:goal-owner:start-9', 'goal-owner']
    ])
    const rows = renderTimelineItems(items)
    expect(rows.map(row => [row.kind, row.seq])).toEqual([
      ['message', 1], ['progress', 2], ['message', 3], ['progress', 4],
      ['message', 5], ['progress', 6], ['message', 7], ['progress', 8], ['message', 9], ['progress', 10]
    ])
    expect(rows.filter(row => row.kind === 'progress').map(row => [row.seq, row.active, row.afterSeq, row.throughSeq, row.stoppedAt])).toEqual([
      [2, false, undefined, 3, undefined], [4, false, 3, 4, undefined],
      [6, false, 5, 7, undefined], [8, false, 7, 8, undefined], [10, true, 9, undefined, undefined]
    ])
    const active = new Set(['chat'])
    expect(updateActiveSessions(active, steer())).toBe(active)
    expect(updateActiveSessions(new Set(), steer())).toEqual(new Set())
  })

  it('is identical after every incremental append, duplicate replay, and cold reopen', () => {
    let events: Event[] = []
    for (const next of history()) {
      events = [...events, next]
      const live = cachedTimelineProjection('goal-steer-live', events, []).rendered
      expect(live).toEqual(cachedTimelineProjection(`goal-steer-cold-${next.seq}`, events, []).rendered)
      expect(new Set(live.map(row => row.key)).size).toBe(live.length)
    }
    const replayed = mergeEvents(mergeEvents([], events.slice(4)), events)
    expect(replayed).toEqual(events)
    expect(renderTimelineItems(projectTimeline(replayed, []))).toEqual(cachedTimelineProjection('goal-steer-live', events, []).rendered)
  })

  it('keeps stable partial-page identity and a separate semantic/minimap boundary', () => {
    const units = timelineSemanticUnits(history())
    expect(units.map(unit => [unit.key, unit.anchorSeq, unit.events.map(item => item.seq)])).toEqual([
      ['run:goal-owner', 1, [1, 2, 3, 4]], ['run:goal-owner:start-5', 5, [5, 6, 7, 8]], ['run:goal-owner:start-9', 9, [9, 10]]
    ])
    const partial = renderTimelineItems(projectTimeline(history().slice(4), []))
    expect(partial[0]).toMatchObject({ key: 'turn:goal-owner:start-5:user:goal-event-5', role: 'user', seq: 5 })
    expect(incompleteLeadingRunId(history().slice(4))).toBeNull()
    const landmarks = buildTimelineLandmarks(renderTimelineItems(projectTimeline(history(), [])))
    expect(landmarks.map(mark => [mark.key, mark.start_seq])).toEqual([
      ['turn:goal-owner', 1], ['turn:goal-owner:start-5', 5], ['turn:goal-owner:start-9', 9]
    ])
    expect(landmarks[1]).toMatchObject({ kind: 'user', title: 'Follow-up 5: keep the same goal running.' })
  })

  it('removes only the accepted queue row without a synthetic turn_started', () => {
    const queue = [5, 9].map(seq => ({ queued_id: `queued-${seq}`, session_id: 'chat', prompt: `Follow-up ${seq}`, file_ids: [], position: seq }))
    const promoted = updateQueuedTurns(queue, event(4, 'turn_queue_run_now', { queued_id: 'queued-5', native_goal_steer: true, native_steer: true }))
    expect(promoted[0].promoted).toBe(true)
    expect(updateQueuedTurns(promoted, steer())).toEqual([queue[1]])
  })

  it('keeps input attachments on the genuine follow-up and accepts it as loaded history', () => {
    const file = { id: 'file-1', session_id: 'chat', filename: 'notes.txt', title: 'notes.txt', kind: 'text', mime_type: 'text/plain' } as AgentFile
    const input = steer(5, { prompt: '', file_ids: ['file-1'] })
    const rows = renderTimelineItems(projectTimeline([input], [file]))
    expect(rows[0]).toMatchObject({ role: 'user', files: [file] })
    expect(snapshotNeedsAuthoritativeTail({ session: { id: 'chat', title: 'Goal', backend: 'codex' }, events: [input],
      files: [file], queuedTurns: [], hasMoreEvents: false, eventsTotal: 1, filesTotal: 1, cachedAt: 0 })).toBe(false)
  })

  it('keeps an actual Stop terminal only on the newest presentation segment', () => {
    const rows = renderTimelineItems(projectTimeline([...history(), event(11, 'turn_stopped')], []))
    expect(rows.filter(row => row.kind === 'progress' && row.stoppedAt).map(row => row.seq)).toEqual([10])
    expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: false, stoppedAt: event(11, '').ts })
  })

  it.each([
    { native_goal_steer: false }, { native_steer: false }, { backend: 'claude' as const },
    { purpose: 'scheduled_job' }, { provider_user_authored: undefined }, { run_id: undefined }
  ])('does not reinterpret an unproven event as a native goal user boundary: %j', patch => {
    const input = steer(5, patch)
    expect(isNativeGoalSteerEvent(input)).toBe(false)
    const queue = [{ queued_id: 'queued-5', session_id: 'chat', prompt: 'Held', file_ids: [] }]
    expect(updateQueuedTurns(queue, input)).toBe(queue)
  })
})
