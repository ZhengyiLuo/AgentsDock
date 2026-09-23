import type { TimelineRow } from './timeline'

export interface TimelineNavigationTarget {
  eventId: string
  seq: number
}

/**
 * Live chats keep their bottom edge stable while new rows arrive. A detached
 * search window has the opposite invariant: its selected result must stay put
 * while Markdown and native selectable-text rows finish measuring.
 */
export const LIVE_TIMELINE_MAINTAIN_VISIBLE_POSITION = {
  startRenderingFromBottom: true,
  autoscrollToBottomThreshold: -1,
} as const

export const SEARCH_TIMELINE_MAINTAIN_VISIBLE_POSITION = {
  disabled: true,
} as const

export function timelineMaintainVisiblePosition(searchTargetAlignmentLocked: boolean) {
  return searchTargetAlignmentLocked
    ? SEARCH_TIMELINE_MAINTAIN_VISIBLE_POSITION
    : LIVE_TIMELINE_MAINTAIN_VISIBLE_POSITION
}

/**
 * Locate a search result in a projected semantic timeline. Exact event/file
 * identity wins; compact history can replace that packet with another event
 * from the same logical row, so sequence containment is the durable fallback.
 */
export function timelineTargetRowIndex(
  rows: readonly TimelineRow[],
  target: TimelineNavigationTarget,
): number {
  const represented = representedTimelineTargetRowIndex(rows, target)
  if (represented >= 0) return represented

  // A semantic page may retain only a nearby representative for a matched
  // trace. Match the Mac behavior by choosing the first row at/after the
  // anchor, falling back to the last row for an end-of-chat result.
  const after = rows.findIndex(row => timelineRowSequenceRange(row)[1] >= target.seq)
  return after >= 0 ? after : rows.length - 1
}

/** Refuse to claim a search hit loaded when the bounded page omitted it. */
export function timelineTargetIsRepresented(
  rows: readonly TimelineRow[],
  target: TimelineNavigationTarget,
): boolean {
  return representedTimelineTargetRowIndex(rows, target) >= 0
}

export function timelineRowSequenceRange(row: TimelineRow): readonly [number, number] {
  const sequences = [row.seq]
  if (row.kind === 'message' || row.kind === 'trace' || row.kind === 'progress' || row.kind === 'job') {
    for (const event of row.events) if (Number.isFinite(event.seq)) sequences.push(event.seq)
  } else if (row.kind === 'system') {
    if (!row.crossChatLegId && Number.isFinite(row.event.seq)) sequences.push(row.event.seq)
    for (const seq of row.representedEventSeqs ?? []) if (Number.isFinite(seq)) sequences.push(seq)
  } else {
    for (const file of row.files) if (Number.isFinite(file.seq)) sequences.push(file.seq!)
  }
  return [Math.min(...sequences), Math.max(...sequences)]
}

/** A detached search window's local bottom is never the live edge. */
export function shouldShowTimelineLatest(
  rowCount: number,
  nearBottom: boolean,
  detachedHistory: boolean,
): boolean {
  return rowCount > 0 && (detachedHistory || !nearBottom)
}

/** Older-page publication must not masquerade as new live output. */
export function liveTimelineAdvanced(previousSeq: number, nextSeq: number): boolean {
  return Number.isFinite(nextSeq) && nextSeq > previousSeq
}

function timelineRowIds(row: TimelineRow): string[] {
  if (row.kind === 'message' || row.kind === 'trace' || row.kind === 'progress' || row.kind === 'job') {
    return row.events.map(event => event.id)
  }
  if (row.kind === 'system') return row.representedEventIds ?? [row.event.id]
  return row.files.map(file => file.id)
}

function representedTimelineTargetRowIndex(
  rows: readonly TimelineRow[],
  target: TimelineNavigationTarget,
): number {
  const exact = rows.findIndex(row => timelineRowIds(row).includes(target.eventId))
  if (exact >= 0) return exact
  return rows.findIndex(row => {
    if (row.kind === 'message' || row.kind === 'trace' || row.kind === 'progress') {
      const [start, end] = timelineRowSequenceRange(row)
      return start <= target.seq && target.seq <= end
    }
    // Scheduled-job cards aggregate separate historical runs. Their overall
    // min/max range can span events that the bounded page did not load, so a
    // target sequence must be represented by an actual event in that card.
    if (row.kind === 'job') return row.events.some(event => event.seq === target.seq)
    if (row.kind === 'system') return row.crossChatLegId
      ? row.representedEventSeqs?.includes(target.seq) === true
      : row.event.seq === target.seq
    return row.files.some(file => file.seq === target.seq)
  })
}
