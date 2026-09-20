import type { Event, ReasoningSummaryStreamItem } from '@shared/types'
import { isPublicCommentary, type ProgressItem, type RenderTimelineItem, type TimelineItem } from './timeline'

/** Presentation identity shared by the live snapshot and its durable completion. */
export function reasoningItemKey(event: Pick<Event, 'run_id' | 'item_id' | 'id'>): string {
  return event.run_id && event.item_id ? `reasoning:${JSON.stringify([event.run_id, event.item_id])}` : event.id
}

/**
 * Overlay a bounded live snapshot on already projected rows. Never append these
 * events to the ledger, advance a cache/read cursor, or re-project old history.
 */
export function overlayReasoningStream(
  rows: RenderTimelineItem[],
  semantic: TimelineItem[],
  items: ReasoningSummaryStreamItem[] | undefined,
  sessionId: string
): RenderTimelineItem[] {
  if (!items?.length) return rows
  let result = rows
  for (const item of items) {
    if (!item.text.trim()) continue
    const seq = item.after_seq + 0.5
    const owner = semantic.findLast(turn => turn.kind === 'turn' && turn.runId === item.run_id
      && (turn.afterSeq == null || seq > turn.afterSeq)
      && (turn.throughSeq == null || seq <= turn.throughSeq))
    // A snapshot can race its durable completion or terminal delivery. Durable
    // history always wins, including after reconnecting with a stale snapshot.
    if (owner?.kind === 'turn' && (owner.finishedAt || owner.stoppedAt
      || owner.trace.some(event => event.type === 'reasoning_summary' && event.item_id === item.item_id && event.run_id === item.run_id))) continue
    const event: Event = {
      ...item, id: `stream:${JSON.stringify([item.run_id, item.item_id])}`,
      session_id: sessionId, type: 'reasoning_summary', seq,
      reasoning_after_seq: item.after_seq
    }
    if (!owner || owner.kind !== 'turn') {
      // Scheduled work remains inside its existing compact job card.
      const index = result.findLastIndex(row => row.kind === 'job' && row.events.some(event => event.run_id === item.run_id))
      if (index < 0) continue
      const row = result[index]
      if (row.kind !== 'job' || row.events.some(event => event.run_id === item.run_id
        && (event.item_id === item.item_id || ['turn_finished', 'turn_stopped', 'turn_failed'].includes(event.type)))) continue
      if (result === rows) result = [...rows]
      result[index] = { ...row, events: [...row.events, event] }
      continue
    }
    const previousAnswer = owner.assistant.findLast(event => !isPublicCommentary(event) && event.seq < seq)
    const suffix = previousAnswer ? `:after:${previousAnswer.id}` : ''
    const prefix = `${owner.key}:activity${suffix}`
    const index = result.findIndex(row => row.kind === 'progress'
      && row.key === prefix
      && (row.afterSeq == null || seq > row.afterSeq)
      && (row.throughSeq == null || seq <= row.throughSeq))
    if (result === rows) result = [...rows]
    if (index >= 0) {
      const row = result[index] as ProgressItem
      result[index] = {
        ...row, seq: Math.min(row.seq, seq),
        events: [...row.events, event], sourceEvents: [...(row.sourceEvents ?? row.events), event]
      }
    } else {
      const row: ProgressItem = {
        kind: 'progress', id: `${owner.id}:activity${suffix}`, key: prefix, seq,
        events: [event], sourceEvents: [event], active: true, hasFinalResponse: false,
        startedAt: previousAnswer ? item.ts : owner.startedAt ?? item.ts,
        afterSeq: previousAnswer?.seq ?? owner.afterSeq, throughSeq: owner.throughSeq
      }
      const before = result.findIndex(row => row.seq > seq)
      result.splice(before < 0 ? result.length : before, 0, row)
    }
  }
  return result
}
