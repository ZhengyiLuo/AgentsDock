import { describe, expect, it } from 'vitest'
import type { Event, ReasoningSummaryStreamItem } from '@shared/types'
import { activityEventSequence, projectTimeline, renderTimelineItems } from './timeline'
import { overlayReasoningStream, reasoningItemKey } from './timeline-reasoning-stream'

const event = (seq: number, type: string, extra: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, seq, type, session_id: 'chat', run_id: 'run', backend: 'codex',
  ts: `2026-09-20T04:00:${String(seq).padStart(2, '0')}Z`, ...extra
})
const start = event(1, 'turn_started', { prompt: 'Check the example' })
const stream: ReasoningSummaryStreamItem = {
  run_id: 'run', item_id: 'summary-1', backend: 'codex', phase: 'summary',
  text: 'Checking the example', ts: start.ts, after_seq: 1
}
const project = (events: Event[]) => {
  const semantic = projectTimeline(events, [])
  return { semantic, rows: renderTimelineItems(semantic) }
}

describe('transient reasoning presentation', () => {
  it('shows the first summary without a durable trace row and leaves the durable projection untouched', () => {
    const { semantic, rows } = project([start])
    const before = JSON.stringify({ semantic, rows })
    const live = overlayReasoningStream(rows, semantic, [stream], 'chat')
    expect(live).toHaveLength(rows.length + 1)
    expect(live[0]).toBe(rows[0])
    expect(live.at(-1)).toMatchObject({ kind: 'progress', active: true, seq: 1.5, events: [{ text: stream.text }] })
    expect(JSON.stringify({ semantic, rows })).toBe(before)
    expect(overlayReasoningStream(rows, semantic, [], 'chat')).toBe(rows)
  })

  it('updates only the owning row and keeps summary/tool chronology through durable completion', () => {
    const tool = event(2, 'tool_started', { tool_id: 'tool-1', tool: { name: 'read_file' } })
    const initial = project([start, tool])
    const live = overlayReasoningStream(initial.rows, initial.semantic, [stream], 'chat')
    const progress = live.find(row => row.kind === 'progress')!
    expect(progress.kind).toBe('progress')
    if (progress.kind !== 'progress') throw Error('missing progress')
    expect([...progress.events].sort((a, b) => activityEventSequence(a) - activityEventSequence(b)).map(event => event.type))
      .toEqual(['reasoning_summary', 'tool_started'])
    expect(live[0]).toBe(initial.rows[0])
    const final = event(3, 'reasoning_summary', { item_id: stream.item_id, text: 'Checking the example completely.', reasoning_after_seq: 1 })
    const completed = project([start, tool, final])
    expect(overlayReasoningStream(completed.rows, completed.semantic, [stream], 'chat')).toBe(completed.rows)
    expect(activityEventSequence(final)).toBe(1.5)
    expect(final.seq).toBe(3)
    expect(reasoningItemKey(progress.events.find(event => event.type === 'reasoning_summary')!)).toBe(reasoningItemKey(final))
  })

  it('does not attach stale streams to another run, a stopped run, or an unknown owner', () => {
    const stopped = project([start, event(2, 'turn_stopped')])
    expect(overlayReasoningStream(stopped.rows, stopped.semantic, [stream], 'chat')).toBe(stopped.rows)
    const active = project([start])
    expect(overlayReasoningStream(active.rows, active.semantic, [{ ...stream, run_id: 'other' }], 'chat')).toBe(active.rows)
    expect(overlayReasoningStream(active.rows, active.semantic, [{ ...stream, text: '' }], 'chat')).toBe(active.rows)
  })

  it('keeps a scheduled summary inside its job card without advancing counts or durable bounds', () => {
    const job = event(1, 'turn_started', { job_id: 'job', purpose: 'scheduled_job', prompt: 'Internal job instruction' })
    const { rows, semantic } = project([job])
    const live = overlayReasoningStream(rows, semantic, [{ ...stream, job_id: 'job', purpose: 'scheduled_job' }], 'chat')
    expect(live).toHaveLength(rows.length)
    expect(live[0]).toMatchObject({ kind: 'job', startSeq: 1, endSeq: 1, eventCount: 1, runCount: 1 })
    expect(live[0].kind === 'job' && live[0].events.at(-1)?.text).toBe(stream.text)
    const done = project([job, event(2, 'turn_finished', { job_id: 'job', purpose: 'scheduled_job' })])
    expect(overlayReasoningStream(done.rows, done.semantic, [stream], 'chat')).toBe(done.rows)
  })

  it('keeps a continuation after an earlier answer on its own stable activity row', () => {
    const first = event(2, 'reasoning_summary', { item_id: 'previous', text: 'First part' })
    const answer = event(3, 'assistant_text', { text: 'First answer', phase: 'final_answer' })
    const initial = project([start, first, answer])
    const live = overlayReasoningStream(initial.rows, initial.semantic, [{ ...stream, after_seq: 3 }], 'chat')
    const continuation = live.at(-1)!
    expect(continuation).toMatchObject({ kind: 'progress', afterSeq: 3 })
    expect(new Set(live.map(row => row.key)).size).toBe(live.length)
    const saved = project([start, first, answer, event(4, 'reasoning_summary', {
      item_id: stream.item_id, text: stream.text, reasoning_after_seq: 3
    })])
    expect(saved.rows.at(-1)?.key).toBe(continuation.key)
  })

  it('rejects malformed completed anchors and keeps ordinary reasoning in arrival order', () => {
    for (const reasoning_after_seq of [-1, 4, 1.2, Number.NaN]) {
      expect(activityEventSequence(event(3, 'reasoning_summary', { reasoning_after_seq }))).toBe(3)
    }
    expect(activityEventSequence(event(3, 'reasoning_summary'))).toBe(3)
  })

  it('retains a received partial summary persisted after the stopped terminal at its original position', () => {
    const partial = event(4, 'reasoning_summary', {
      item_id: stream.item_id, text: stream.text, reasoning_after_seq: 1, partial: true
    })
    const stopped = project([start, event(2, 'tool_started', { tool_id: 'tool', tool: { name: 'read_file' } }),
      event(3, 'turn_stopped'), partial])
    const progress = stopped.rows.find(row => row.kind === 'progress')
    expect(progress?.kind === 'progress' && progress.events).toContainEqual(partial)
    expect(progress?.kind === 'progress' && progress.active).toBe(false)
    expect(activityEventSequence(partial)).toBe(1.5)
    expect(overlayReasoningStream(stopped.rows, stopped.semantic, [stream], 'chat')).toBe(stopped.rows)
  })
})
