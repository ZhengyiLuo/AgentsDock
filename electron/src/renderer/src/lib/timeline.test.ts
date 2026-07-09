import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { extractUnifiedDiff, parseUnifiedDiff, projectTimeline, reconcileTimelineItems, renderTimelineItems } from './timeline'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: `2026-07-09T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})

describe('projectTimeline', () => {
  it('projects raw provider traffic into one semantic turn with media at the end', () => {
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4', seq: 5 }
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Render it' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', text: 'Checking inputs' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Finished.' }),
      event(5, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(6, 'turn_finished', { run_id: 'run-1', result_text: 'Finished.' })
    ], [file])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'turn', files: [file] })
    if (items[0].kind === 'turn') {
      expect(items[0].assistant).toHaveLength(1)
      expect(items[0].trace.map(item => item.type)).toEqual(['reasoning_summary', 'tool_started'])
    }
  })

  it('keeps queued turns out of transcript history and groups recurring job output', () => {
    const items = projectTimeline([
      event(1, 'turn_queued', { prompt: 'Later' }),
      event(2, 'job_started', { job_id: 'job-1', message: 'Started' }),
      event(3, 'job_finished', { job_id: 'job-1', result_text: 'Healthy' })
    ], [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'job', events: [{ type: 'job_started' }, { type: 'job_finished' }] })
  })

  it('preserves unchanged row identities when one new turn is appended', () => {
    const firstEvents = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'First' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'Done' }),
      event(3, 'turn_finished', { run_id: 'run-1' })
    ]
    const previous = projectTimeline(firstEvents, [])
    const next = reconcileTimelineItems(previous, projectTimeline([
      ...firstEvents,
      event(4, 'turn_started', { run_id: 'run-2', prompt: 'Second' })
    ], []))
    expect(next[0]).toBe(previous[0])
    expect(next).toHaveLength(2)
  })

  it('splits a large turn into independently virtualized message, trace, and media rows', () => {
    const file: AgentFile = { id: 'image-1', filename: 'result.png', content_type: 'image/png', seq: 4 }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'First update' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(5, 'assistant_text', { run_id: 'run-1', text: 'Final update' })
    ], [file]))
    expect(rows.map(row => row.kind)).toEqual(['message', 'message', 'message', 'trace', 'media'])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  })

  it('keeps every imported prompt when a provider reuses one run id', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'import-1', prompt: 'First question' }),
      event(2, 'assistant_text', { run_id: 'import-1', text: 'First answer' }),
      event(3, 'turn_started', { run_id: 'import-1', prompt: 'Second question' }),
      event(4, 'assistant_text', { run_id: 'import-1', text: 'Second answer' })
    ], []))
    expect(rows.filter(row => row.kind === 'message').map(row => row.kind === 'message' ? row.event.prompt || row.event.text : '')).toEqual([
      'First question', 'First answer', 'Second question', 'Second answer'
    ])
  })
})

describe('parseUnifiedDiff', () => {
  it('counts additions and deletions while retaining line numbers', () => {
    const files = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 })
    expect(files[0].lines.some(line => line.kind === 'add' && line.newLine === 1)).toBe(true)
  })

  it('recognizes Claude apply_patch input as a reviewable change', () => {
    const source = extractUnifiedDiff([event(1, 'tool_started', { tool: { name: 'Edit', input: { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' } } })])
    const files = parseUnifiedDiff(source)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 })
  })
})
