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
const peerMessage = (seq: number, id: string): Event => event(seq, 'chat_conversation_message_received', {
  run_id: undefined, conversation_mode: 'async_route_v1', delivery_mode: 'mailbox',
  message_id: id, cross_chat_envelope_id: id, source_session_id: 'peer', target_session_id: 'chat',
  received_at: `2026-09-20T04:00:${String(seq).padStart(2, '0')}Z`, inbox_state: 'unread',
  handoff_preview: `Synthetic peer message ${id}`
})
const streamed = (after_seq: number, item_id: string): ReasoningSummaryStreamItem => ({
  ...stream, after_seq, item_id, text: `Synthetic reasoning ${item_id}`
})
const assertUniqueRowsAndOneLiveTail = (rows: ReturnType<typeof renderTimelineItems>) => {
  expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  expect(rows.filter(row => row.kind === 'progress' && row.active)).toHaveLength(1)
  expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true })
}

describe('transient reasoning presentation', () => {
  it('uses the existing activity segment after an inter-chat message without duplicating its original key', () => {
    const initial = project([start, event(2, 'reasoning_summary', { item_id: 'before', text: 'Before the message' }),
      peerMessage(3, 'peer-one'), event(4, 'tool_started', { tool_id: 'tool', tool: { name: 'read_file' } })])
    const tail = initial.rows.at(-1)!
    const live = overlayReasoningStream(initial.rows, initial.semantic, [streamed(4, 'after')], 'chat')
    assertUniqueRowsAndOneLiveTail(live)
    expect(live).toHaveLength(initial.rows.length)
    expect(live.at(-1)).toMatchObject({ key: tail.key, afterSeq: 3, events: [
      { type: 'tool_started' }, { text: 'Synthetic reasoning after' }
    ] })
    expect(live[1]).toBe(initial.rows[1])
  })

  it('keeps live reasoning on each side of multiple peer messages and matches durable completion keys', () => {
    const events = [start, event(2, 'reasoning_summary', { item_id: 'before', text: 'Before messages' }),
      peerMessage(3, 'peer-one'), event(4, 'tool_started', { tool_id: 'tool', tool: { name: 'read_file' } }),
      peerMessage(5, 'peer-two'), event(6, 'tool_finished', { tool_id: 'tool', output: 'Done' })]
    const items = [streamed(5, 'after-both'), streamed(3, 'between')]
    const initial = project(events)
    const before = JSON.stringify(initial)
    const live = overlayReasoningStream(initial.rows, initial.semantic, items, 'chat')
    assertUniqueRowsAndOneLiveTail(live)
    expect(live.filter(row => row.kind === 'progress').map(row => row.events.filter(event => event.id.startsWith('stream:')).map(event => event.item_id)))
      .toEqual([[], ['between'], ['after-both']])
    const completed = project([...events,
      event(7, 'reasoning_summary', { item_id: 'between', text: 'Synthetic reasoning between', reasoning_after_seq: 3 }),
      event(8, 'reasoning_summary', { item_id: 'after-both', text: 'Synthetic reasoning after-both', reasoning_after_seq: 5 })])
    expect(live.map(row => row.key)).toEqual(completed.rows.map(row => row.key))
    expect(overlayReasoningStream(completed.rows, completed.semantic, items, 'chat')).toBe(completed.rows)
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('creates missing activity segments between grouped mailbox messages in chronological order', () => {
    const events = [start, peerMessage(3, 'peer-one'), peerMessage(5, 'peer-two')]
    const initial = project(events)
    const items = [streamed(5, 'after'), streamed(1, 'before'), streamed(3, 'between')]
    const before = JSON.stringify(initial)
    const live = overlayReasoningStream(initial.rows, initial.semantic, items, 'chat')
    assertUniqueRowsAndOneLiveTail(live)
    expect(live.map(row => row.kind)).toEqual(['message', 'progress', 'system', 'progress', 'system', 'progress'])
    expect(live.filter(row => row.kind === 'progress').map(row => row.events.map(event => event.item_id)))
      .toEqual([['before'], ['between'], ['after']])
    expect(live.filter(row => row.kind === 'system').map(row => row.mailboxMessages?.map(message => message.event.message_id)))
      .toEqual([['peer-one'], ['peer-two']])
    expect(overlayReasoningStream(live, initial.semantic, items, 'chat')).toBe(live)
    const completed = project([...events, ...items.map((item, index) => event(6 + index, 'reasoning_summary', {
      item_id: item.item_id, text: item.text, reasoning_after_seq: item.after_seq
    }))])
    expect(live.map(row => row.key)).toEqual(completed.rows.map(row => row.key))
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('keeps final-answer and peer-message boundaries when a continuation streams', () => {
    const events = [start, event(2, 'reasoning_summary', { item_id: 'first', text: 'First part' }),
      event(3, 'assistant_text', { text: 'First answer', phase: 'final_answer' }),
      event(4, 'tool_started', { tool_id: 'next-tool', tool: { name: 'read_file' } }), peerMessage(5, 'peer-one')]
    const initial = project(events)
    const live = overlayReasoningStream(initial.rows, initial.semantic, [streamed(5, 'continuation')], 'chat')
    assertUniqueRowsAndOneLiveTail(live)
    expect(live.at(-1)).toMatchObject({ key: 'turn:run:activity:after:event-3:after:message:cross-chat:handoff:peer-one', afterSeq: 5 })
    expect(live.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(1)
    expect(live.findIndex(row => row.kind === 'system')).toBeGreaterThan(live.findIndex(row => row.kind === 'message' && row.role === 'assistant'))
  })

  it('does not duplicate an overlaid reasoning item or attach an unknown run to a peer-message segment', () => {
    const initial = project([start, event(2, 'reasoning_summary', { text: 'Before message', item_id: 'before' }), peerMessage(3, 'peer-one')])
    const item = streamed(3, 'after')
    const live = overlayReasoningStream(initial.rows, initial.semantic, [item, item, { ...item, run_id: 'unowned' }], 'chat')
    assertUniqueRowsAndOneLiveTail(live)
    expect(live.flatMap(row => row.kind === 'progress' ? row.events : []).filter(event => event.item_id === 'after')).toHaveLength(1)
  })

  it('places a late live snapshot between prior commentary and its final without reactivating that finished segment', () => {
    for (const continued of [false, true]) {
      const commentary = event(2, 'assistant_text', { text: 'Checking before the message', phase: 'commentary' })
      const answer = event(5, 'assistant_text', { text: 'First answer', phase: 'final_answer' })
      const events = [start, commentary, peerMessage(3, 'peer-one'), answer,
        ...(continued ? [event(6, 'tool_started', { tool_id: 'next', tool: { name: 'read_file' } }), peerMessage(7, 'peer-two')] : [])]
      const initial = project(events)
      const before = initial.rows.find(row => row.kind === 'progress')!
      const item = streamed(3, 'between-commentary-and-final')
      const live = overlayReasoningStream(initial.rows, initial.semantic, [item], 'chat')
      expect(new Set(live.map(row => row.key)).size).toBe(live.length)
      expect(live.filter(row => row.kind === 'progress' && row.active)).toHaveLength(continued ? 1 : 0)
      const summaryIndex = live.findIndex(row => row.kind === 'progress' && row.events.some(event => event.item_id === item.item_id))
      const finalIndex = live.findIndex(row => row.kind === 'message' && row.role === 'assistant')
      expect(live[summaryIndex - 1]).toMatchObject({ kind: 'system', seq: 3 })
      expect(live[summaryIndex]).toMatchObject({ kind: 'progress', afterSeq: 3, active: false, finalEvents: [answer] })
      expect(summaryIndex).toBeLessThan(finalIndex)
      expect(live.find(row => row.key === before.key)).toBe(before)
      expect(overlayReasoningStream(live, initial.semantic, [item], 'chat')).toBe(live)
      const completed = project([...events, event(8, 'reasoning_summary', {
        item_id: item.item_id, text: item.text, reasoning_after_seq: item.after_seq
      })])
      expect(live.map(row => row.key)).toEqual(completed.rows.map(row => row.key))
      expect(completed.rows[summaryIndex]).toMatchObject({ kind: 'progress', active: false, afterSeq: 3 })
    }
  })

  it('retains final ordering evidence when an earlier stream requires a new first segment', () => {
    const answer = event(5, 'assistant_text', { text: 'The answer', phase: 'final_answer' })
    const delayedCommentary = event(6, 'assistant_text', {
      text: 'Earlier commentary delivered late', phase: 'commentary', ts: event(4, 'assistant_text').ts
    })
    const initial = project([start, peerMessage(3, 'peer-one'), answer, delayedCommentary])
    const existing = initial.rows.find(row => row.kind === 'progress')!
    if (existing.kind !== 'progress') throw Error('missing progress')
    expect(existing.orderingFinalEvents).toEqual([answer])
    const live = overlayReasoningStream(initial.rows, initial.semantic, [streamed(1, 'first')], 'chat')
    expect(live.map(row => row.kind)).toEqual(['message', 'progress', 'system', 'progress', 'message'])
    for (const row of live) if (row.kind === 'progress') {
      expect(row.finalEvents).toBe(existing.finalEvents)
      expect(row.orderingFinalEvents).toBe(existing.orderingFinalEvents)
      expect(row.active).toBe(false)
      expect(row.startedAt).toBe(existing.startedAt)
    }
    expect(live[3]).toMatchObject({ events: existing.events, finishedAt: existing.finishedAt })
  })

  it('keeps summary and exposed reasoning independent when native item identity is shared', () => {
    const summary = event(2, 'reasoning_summary', { item_id: stream.item_id, phase: 'summary', text: 'Saved summary' })
    const raw: ReasoningSummaryStreamItem = { ...stream, phase: 'reasoning', text: 'Provider plaintext' }
    const initial = project([start, summary])
    const live = overlayReasoningStream(initial.rows, initial.semantic, [stream, raw], 'chat')
    const progress = live.find(row => row.kind === 'progress')!
    if (progress.kind !== 'progress') throw Error('missing progress')
    expect(progress.events.map(event => event.text)).toEqual(['Saved summary', 'Provider plaintext'])
    expect(new Set(progress.events.map(reasoningItemKey)).size).toBe(2)
    const completed = project([start, summary, event(3, 'reasoning_text', { item_id: stream.item_id, phase: 'reasoning', text: raw.text })])
    expect(overlayReasoningStream(completed.rows, completed.semantic, [stream, raw], 'chat')).toBe(completed.rows)
  })
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
