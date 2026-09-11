import type { Event } from '../types'
import type { TimelineRow } from './timeline'

export function reuseStableTimelineRows(previous: readonly TimelineRow[], next: TimelineRow[]): TimelineRow[] {
  if (!previous.length || !next.length) return next
  const previousByKey = new Map(previous.map(row => [row.key, row]))
  let reused = 0
  const stable = next.map(row => {
    const candidate = previousByKey.get(row.key)
    if (!candidate || !sameTimelineRow(candidate, row)) return row
    reused += 1
    return candidate
  })
  if (reused === next.length && previous.length === next.length && stable.every((row, index) => row === previous[index])) {
    return previous as TimelineRow[]
  }
  return stable
}

export function sameTimelineRow(left: TimelineRow, right: TimelineRow): boolean {
  if (left === right) return true
  if (left.kind !== right.kind || left.key !== right.key || left.seq !== right.seq) return false
  if (left.kind === 'message' && right.kind === 'message') {
    return left.role === right.role
      && sameEvents(left.events, right.events)
      && sameReferences(left.files, right.files)
  }
  if (left.kind === 'trace' && right.kind === 'trace') {
    return left.runId === right.runId
      && left.active === right.active
      && sameEvents(left.events, right.events)
      && sameReferences(left.promotedCommentaryIds, right.promotedCommentaryIds)
  }
  if (left.kind === 'progress' && right.kind === 'progress') {
    return left.hiddenCount === right.hiddenCount
      && sameEvents(left.events, right.events)
  }
  if (left.kind === 'media' && right.kind === 'media') {
    return sameReferences(left.files, right.files)
  }
  if (left.kind === 'job' && right.kind === 'job') {
    return left.title === right.title && sameReferences(left.events, right.events)
  }
  return left.kind === 'system' && right.kind === 'system'
    // Cross-chat terminal normalization is memoized by source event + status
    // in the projector. Compare immutable event references without scanning
    // their bodies: previews may be 48k across hundreds of lifecycle cards.
    && left.event === right.event
    && left.crossChatMessage === right.crossChatMessage
    && left.anchorTs === right.anchorTs
    && sameOptionalReferences(left.events, right.events)
    && sameOptionalReferences(left.representedEventIds, right.representedEventIds)
    && sameOptionalReferences(left.representedEventSeqs, right.representedEventSeqs)
}

function sameReferences(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left === right || left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalReferences(left?: readonly unknown[], right?: readonly unknown[]): boolean {
  return left === right || Boolean(left && right && sameReferences(left, right))
}

function sameEvents(left: readonly Event[], right: readonly Event[]): boolean {
  return left === right || left.length === right.length && left.every((event, index) =>
    event === right[index] || sameSerializableRecord(event, right[index])
  )
}

function sameSerializableRecord(left: object, right: object): boolean {
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every(key => Object.hasOwn(rightRecord, key) && sameSerializableValue(leftRecord[key], rightRecord[key]))
}

function sameSerializableValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameSerializableValue(value, right[index]))
  }
  return sameSerializableRecord(left, right)
}
