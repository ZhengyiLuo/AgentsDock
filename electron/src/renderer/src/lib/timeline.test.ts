import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { extractUnifiedDiff, jobDisplayEvents, messageItemText, messageText, parseReviewableDiff, parseUnifiedDiff, projectTimeline, reconcileRenderTimelineItems, reconcileTimelineItems, renderTimelineItems, reviewTargetBelongsToSession } from './timeline'

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

  it('does not render turn_finished when it repeats the accumulated assistant updates', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix the sync' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I found the missing fields.' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'The transport test now passes.' }),
      event(4, 'turn_finished', {
        run_id: 'run-1',
        result_text: 'I found the missing fields.\n\nThe transport test now passes.'
      })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(
      'I found the missing fields.\n\nThe transport test now passes.'
    )
  })

  it('uses a cumulative finish payload instead of duplicating its earlier updates', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix the sync' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I found the missing fields.' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'The transport test now passes.' }),
      event(4, 'turn_finished', {
        run_id: 'run-1',
        result_text: 'I found the missing fields.\n\nThe transport test now passes.\n\nThe server is ready.'
      })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ events: [{ id: 'event-4' }] })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(
      'I found the missing fields.\n\nThe transport test now passes.\n\nThe server is ready.'
    )
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

  it('folds a scheduled agent run into its job card, including legacy job_ran links', () => {
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-job-1', prompt: 'Check training status' }),
      event(2, 'job_ran', { run_id: 'run-job-1', job_id: 'job-1', job: { id: 'job-1', session_id: 'chat-1', title: 'Training status', prompt: 'Check training status', interval_seconds: 3600 } }),
      event(3, 'assistant_text', { run_id: 'run-job-1', text: 'Training is healthy.' }),
      event(4, 'turn_finished', { run_id: 'run-job-1', result_text: 'Training is healthy.' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'job', title: 'Training status' })
    const rows = renderTimelineItems(items)
    expect(rows.map(row => row.kind)).toEqual(['job'])
    if (items[0].kind === 'job') {
      expect(jobDisplayEvents(items[0].events)).toMatchObject([{ type: 'turn_finished', result_text: 'Training is healthy.' }])
    }
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
    expect(rows.map(row => row.kind)).toEqual(['message', 'message', 'trace', 'media'])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  })

  it('does not mount an empty trace row for provisional run metadata', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Start working' }),
      event(2, 'process_started', { run_id: 'run-1' }),
      event(3, 'provider_session', { run_id: 'run-1' }),
      event(4, 'reasoning_summary', { run_id: 'run-1', text: '   ' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message'])
  })

  it('mounts the trace row once visible reasoning arrives', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Start working' }),
      event(2, 'process_started', { run_id: 'run-1' }),
      event(3, 'reasoning_summary', { run_id: 'run-1', text: 'Checking the repository' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message', 'trace'])
  })

  it('keeps canonical per-turn code diffs inside the folded trace', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix it' }),
      event(2, 'code_diff', {
        run_id: 'run-1', files_changed: 1, additions: 4, deletions: 2,
        diff_files: [{ path: 'src/app.ts', additions: 4, deletions: 2 }]
      }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Fixed.' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message', 'message', 'trace'])
    expect(rows[2]).toMatchObject({ kind: 'trace', events: [{ type: 'code_diff' }] })
  })

  it('coalesces assistant updates into one stable response row', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Monitor it' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'First update' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'Second update' }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Final update' })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'turn:run-1:assistant', events: [{ id: 'event-2' }, { id: 'event-3' }, { id: 'event-4' }] })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe('First update\n\nSecond update\n\nFinal update')
  })

  it('preserves every unchanged row when one update reaches a large chat', () => {
    let seq = 0
    const source: Event[] = []
    for (let turn = 0; turn < 200; turn += 1) {
      const runId = `run-${turn}`
      source.push(event(++seq, 'turn_started', { run_id: runId, prompt: `Prompt ${turn}` }))
      for (let update = 0; update < 4; update += 1) {
        source.push(event(++seq, 'assistant_text', { run_id: runId, text: `Turn ${turn} update ${update}` }))
      }
    }
    const semantic = projectTimeline(source, [])
    const previous = renderTimelineItems(semantic)
    expect(previous).toHaveLength(400)
    expect(previous.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(200)
    expect(new Set(previous.map(row => row.key)).size).toBe(previous.length)

    const nextEvent = event(++seq, 'assistant_text', { run_id: 'run-199', text: 'One final update' })
    const nextSemantic = reconcileTimelineItems(semantic, projectTimeline([...source, nextEvent], []))
    const next = reconcileRenderTimelineItems(previous, renderTimelineItems(nextSemantic))
    expect(next.filter((row, index) => row !== previous[index])).toHaveLength(1)
    const latest = next.findLast(row => row.kind === 'message' && row.role === 'assistant')
    expect(latest?.kind === 'message' ? latest.events : []).toHaveLength(5)
  })

  it('keeps every imported prompt when a provider reuses one run id', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'import-1', prompt: 'First question' }),
      event(2, 'assistant_text', { run_id: 'import-1', text: 'First answer' }),
      event(3, 'turn_started', { run_id: 'import-1', prompt: 'Second question' }),
      event(4, 'assistant_text', { run_id: 'import-1', text: 'Second answer' })
    ], []))
    expect(rows.filter(row => row.kind === 'message').map(row => row.kind === 'message' ? messageItemText(row) : '')).toEqual([
      'First question', 'First answer', 'Second question', 'Second answer'
    ])
  })

  it('renders run-scoped provider errors as visible system rows instead of trace details', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Try it' }),
      event(2, 'error', { run_id: 'run-1', error: 'Model request failed' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'system'])
    expect(rows[1]).toMatchObject({ kind: 'system', event: { error: 'Model request failed' } })
  })

  it('extracts the message from structured provider errors', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'error', { run_id: 'run-1', error: { type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Upgrade the CLI' } } })
    ], []))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'system' })
    if (rows[0].kind === 'system') expect(messageText(rows[0].event)).toBe('Upgrade the CLI')
  })

  it('extracts provider errors encoded as JSON message strings', () => {
    const value = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Upgrade the CLI' } })
    expect(messageText(event(1, 'error', { message: value }))).toBe('Upgrade the CLI')
  })

  it('keeps ordinary tool failures folded into the trace', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'tool_finished', { run_id: 'run-1', is_error: true, output: 'Exit code 1' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'trace'])
  })
})

describe('parseUnifiedDiff', () => {
  it('counts additions and deletions while retaining line numbers', () => {
    const files = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 })
    expect(files[0].lines.some(line => line.kind === 'add' && line.newLine === 1)).toBe(true)
  })

  it('does not present git status output as a line-level code review', () => {
    const source = [
      ' M groot/rl/scripts/sim2sim/run_eval.py',
      '?? groot/rl/scripts/sim2sim/configs/new.yaml'
    ].join('\n')

    expect(parseUnifiedDiff(source)).toHaveLength(2)
    expect(parseReviewableDiff(source)).toEqual([])
  })

  it('retains complete git patches for the code review workspace', () => {
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(parseReviewableDiff(source)).toMatchObject([{ path: 'a.ts', additions: 1, deletions: 1 }])
  })

  it('recognizes Claude apply_patch input as a reviewable change', () => {
    const source = extractUnifiedDiff([event(1, 'tool_started', { tool: { name: 'Edit', input: { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' } } })])
    const files = parseUnifiedDiff(source)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 })
  })

  it('parses every file and hunk in a complete Git patch without advancing metadata lines', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,3 @@',
      ' same',
      '-old',
      '+new',
      '+extra',
      'diff --git a/b.ts b/b.ts',
      'index 3333333..4444444 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -40 +40 @@',
      '-before',
      '+after'
    ].join('\n'))

    expect(files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: 'a.ts', additions: 2, deletions: 1 },
      { path: 'b.ts', additions: 1, deletions: 1 }
    ])
    expect(files[0].lines.find(line => line.kind === 'context')).toMatchObject({ oldLine: 10, newLine: 10 })
    expect(files[1].lines.find(line => line.kind === 'remove')).toMatchObject({ oldLine: 40 })
  })
})

describe('reviewTargetBelongsToSession', () => {
  it('accepts only the currently selected chat as the owner of a review', () => {
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-1')).toBe(true)
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-2')).toBe(false)
    expect(reviewTargetBelongsToSession(null, 'chat-1')).toBe(false)
  })
})
