import type { Event, ReasoningSummaryStreamItem } from '@shared/types'
import { crossChatSemanticKey } from '@shared/semantic-timeline'
import { interleaveChronologicalSystemRows, isPublicCommentary, reconcileRenderTimelineItems,
  type ProgressItem, type RenderTimelineItem, type SystemItem, type TimelineItem, type TurnItem } from './timeline'

/** Presentation identity shared by the live snapshot and its durable completion. */
export function reasoningItemKey(event: Pick<Event, 'run_id' | 'item_id' | 'id' | 'phase'>): string {
  return event.run_id && event.item_id ? `reasoning:${JSON.stringify([
    event.run_id, event.item_id, ...(event.phase === 'reasoning' ? ['reasoning'] : [])
  ])}` : event.id
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
  for (const item of [...items].sort((left, right) => left.after_seq - right.after_seq)) {
    if (!item.text.trim()) continue
    const seq = item.after_seq + 0.5
    const owner = semantic.findLast(turn => turn.kind === 'turn' && turn.runId === item.run_id
      && (turn.afterSeq == null || seq > turn.afterSeq)
      && (turn.throughSeq == null || seq <= turn.throughSeq))
    // A snapshot can race its durable completion or terminal delivery. Durable
    // history always wins, including after reconnecting with a stale snapshot.
    if (owner?.kind === 'turn' && (owner.finishedAt || owner.stoppedAt
      || owner.trace.some(event => (event.type === 'reasoning_summary' || event.type === 'reasoning_text') && event.item_id === item.item_id && event.run_id === item.run_id
        && (event.phase === 'reasoning') === (item.phase === 'reasoning')))) continue
    const event: Event = {
      ...item, id: `stream:${JSON.stringify([item.run_id, item.item_id, ...(item.phase === 'reasoning' ? ['reasoning'] : [])])}`,
      session_id: sessionId, type: item.phase === 'reasoning' ? 'reasoning_text' : 'reasoning_summary', seq,
      reasoning_after_seq: item.after_seq
    }
    if (!owner || owner.kind !== 'turn') {
      // Scheduled work remains inside its existing compact job card.
      const index = result.findLastIndex(row => row.kind === 'job' && row.events.some(event => event.run_id === item.run_id))
      if (index < 0) continue
      const row = result[index]
      if (row.kind !== 'job' || row.events.some(event => event.run_id === item.run_id
        && ((event.item_id === item.item_id && (event.phase === 'reasoning') === (item.phase === 'reasoning'))
          || ['turn_finished', 'turn_stopped', 'turn_failed'].includes(event.type)))) continue
      if (result === rows) result = [...rows]
      result[index] = { ...row, events: [...row.events, event] }
      continue
    }
    const previousAnswer = owner.assistant.findLast(event => !isPublicCommentary(event) && event.seq < seq)
    const suffix = previousAnswer ? `:after:${previousAnswer.id}` : ''
    const prefix = `${owner.key}:activity${suffix}`
    const index = result.findIndex(row => row.kind === 'progress'
      && ownsProgressSegment(row, prefix)
      && (row.afterSeq == null || seq > row.afterSeq)
      && (row.throughSeq == null || seq <= row.throughSeq))
    if (index >= 0 && seq >= result[index].seq) {
      const row = result[index] as ProgressItem
      if (row.events.some(candidate => reasoningItemKey(candidate) === reasoningItemKey(event))) continue
      if (result === rows) result = [...rows]
      result[index] = {
        ...row, seq: Math.min(row.seq, seq),
        events: [...row.events, event], sourceEvents: [...(row.sourceEvents ?? row.events), event]
      }
    } else {
      result = insertMissingReasoningSegment(result, owner, prefix, suffix, previousAnswer, event)
    }
  }
  return result
}

function ownsProgressSegment(row: ProgressItem, prefix: string): boolean {
  return row.key === prefix || row.key.startsWith(`${prefix}:after:message:`)
}

/**
 * A stream can be the first visible activity between peer messages. Reuse the
 * durable splitter on this activity and its message anchors only; the ledger
 * and unrelated turns are never re-projected. Existing segment keys must be
 * joined before splitting again, otherwise each delta adds another suffix.
 */
function insertMissingReasoningSegment(
  rows: RenderTimelineItem[], owner: TurnItem, prefix: string, suffix: string,
  previousAnswer: Event | undefined, event: Event
): RenderTimelineItem[] {
  const siblings = rows.filter((row): row is ProgressItem => row.kind === 'progress' && ownsProgressSegment(row, prefix))
  const first = siblings[0]
  const last = siblings.at(-1)
  const nextAnswer = owner.assistant.find(candidate => !isPublicCommentary(candidate) && candidate.seq > event.seq)
  const mergeEvents = (events: Event[]) => [...new Map(events.map(candidate => [candidate.id, candidate])).values()]
  const events = mergeEvents([...siblings.flatMap(row => row.events), event])
  const sourceEvents = mergeEvents([...siblings.flatMap(row => row.sourceEvents ?? row.events), event])
  const lifecycle = [...new Map(siblings.flatMap(row => row.lifecycle ?? []).map(row => [row.key, row])).values()]
  const row: ProgressItem = {
    ...first, kind: 'progress', id: `${owner.id}:activity${suffix}`, key: prefix,
    seq: Math.min(first?.seq ?? event.seq, event.seq), events, sourceEvents,
    active: !nextAnswer, continues: undefined, hasFinalResponse: first?.hasFinalResponse ?? Boolean(nextAnswer),
    finalEvents: first?.finalEvents ?? (nextAnswer ? [nextAnswer] : []),
    startedAt: first?.startedAt ?? (previousAnswer ? event.ts : owner.startedAt ?? event.ts),
    finishedAt: last?.continues ? nextAnswer?.ts : last?.finishedAt, stoppedAt: undefined,
    afterSeq: previousAnswer?.seq ?? owner.afterSeq,
    throughSeq: nextAnswer?.seq ?? owner.throughSeq,
    ...(lifecycle.length ? { lifecycle } : {})
  }
  const endSeq = row.throughSeq ?? Number.POSITIVE_INFINITY
  const anchored = rows.filter((candidate): candidate is SystemItem => candidate.kind === 'system'
    && (candidate.mailboxMessages ?? [candidate]).some(message => crossChatSemanticKey(message.event) !== null
      && message.seq >= row.seq && message.seq < endSeq))
  const messages = anchored.flatMap(candidate => candidate.mailboxMessages ?? [candidate])
    .map(message => ({ ...message, mailboxMessages: undefined }))
  const replaced = new Set<RenderTimelineItem>([...siblings, ...anchored])
  const generated = reconcileRenderTimelineItems([...siblings, ...anchored],
    interleaveChronologicalSystemRows([row, ...messages]))
  const indices = rows.flatMap((candidate, index) => replaced.has(candidate) ? [index] : [])
  if (!indices.length) {
    const before = rows.findIndex(candidate => candidate.seq > row.seq)
    const at = before < 0 ? rows.length : before
    return [...rows.slice(0, at), ...generated, ...rows.slice(at)]
  }
  const firstAfter = rows.findIndex(candidate => candidate.seq >= row.seq)
  const from = firstAfter < 0 ? indices[0] : Math.min(indices[0], firstAfter)
  const through = indices.at(-1)!
  const result = rows.slice(0, from)
  let cursor = 0
  for (const candidate of rows.slice(from, through + 1)) {
    if (replaced.has(candidate)) continue
    while (cursor < generated.length && generated[cursor].seq <= candidate.seq) result.push(generated[cursor++])
    result.push(candidate)
  }
  result.push(...generated.slice(cursor), ...rows.slice(through + 1))
  return result
}
