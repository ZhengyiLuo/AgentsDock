import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { buildTimelineLandmarks, compactPreview } from './timeline-minimap'

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
    expect(landmarks[0]).toMatchObject({ index: 0, endIndex: 4, title: 'Render the result', preview: 'Done.' })
    expect(landmarks[0].meta).toContain('result.mp4')
    expect(landmarks.find(item => item.kind === 'error')?.preview).toBe('Provider unavailable')
  })

  it('keeps hover previews compact without discarding the source row', () => {
    const preview = compactPreview(`Start\n${'long '.repeat(100)}`, 60)
    expect(preview.length).toBeLessThanOrEqual(60)
    expect(preview).toMatch(/^Start long/)
    expect(preview.endsWith('…')).toBe(true)
  })
})
