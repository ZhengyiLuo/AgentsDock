import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { buildTimelineLandmarks, compactPreview, mergeTimelineLandmarks, TIMELINE_TICK_PITCH, timelineTickY } from './timeline-minimap'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: `2026-07-09T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})

describe('timeline minimap landmarks', () => {
  it('projects messages, traces, media, jobs, and errors in row order', () => {
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4', seq: 4 }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Render the result' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I am rendering it now.' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Done.' }),
      event(6, 'job_finished', { job_id: 'job-1', message: 'Health check passed' }),
      event(7, 'error', { error: 'Provider unavailable' })
    ], [file]))

    const landmarks = buildTimelineLandmarks(rows)
    expect(landmarks.map(item => item.kind)).toEqual(['user', 'job', 'error'])
    expect(landmarks[0]).toMatchObject({ index: 0, endIndex: 3, title: 'Render the result', preview: 'I am rendering it now. Done.' })
    expect(landmarks[0]).toMatchObject({ start_seq: 1, end_seq: 5 })
    expect(landmarks[0].meta).toContain('result.mp4')
    expect(landmarks.find(item => item.kind === 'error')?.preview).toBe('Provider unavailable')
  })

  it('keeps hover previews compact without discarding the source row', () => {
    const preview = compactPreview(`Start\n${'long '.repeat(100)}`, 60)
    expect(preview.length).toBeLessThanOrEqual(60)
    expect(preview).toMatch(/^Start long/)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('merges loaded rows into a whole-chat index without changing landmark order', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(101, 'turn_started', { run_id: 'run-latest', prompt: 'Latest prompt' }),
      event(102, 'turn_finished', { run_id: 'run-latest', result_text: 'Latest answer' })
    ], []))
    const loaded = buildTimelineLandmarks(rows)
    const merged = mergeTimelineLandmarks([
      { key: 'turn:run-old', kind: 'user', start_seq: 1, end_seq: 8, title: 'Old prompt', preview: 'Old answer' },
      { key: 'turn:run-latest', kind: 'user', start_seq: 101, end_seq: 102, title: 'Stale title', preview: 'Stale answer' }
    ], loaded)

    expect(merged.map(landmark => landmark.key)).toEqual(['turn:run-old', 'turn:run-latest'])
    expect(merged[0].index).toBeUndefined()
    expect(merged[1]).toMatchObject({ index: 0, title: 'Latest prompt', preview: 'Latest answer' })
  })

  it('keeps rail spacing fixed regardless of conversation length', () => {
    expect(timelineTickY(1) - timelineTickY(0)).toBe(TIMELINE_TICK_PITCH)
    expect(timelineTickY(10_000) - timelineTickY(9_999)).toBe(TIMELINE_TICK_PITCH)
    expect(timelineTickY(50, 240) - timelineTickY(49, 240)).toBe(TIMELINE_TICK_PITCH)
  })
})
