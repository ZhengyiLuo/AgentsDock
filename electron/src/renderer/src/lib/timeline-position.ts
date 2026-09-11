import type { ViewState } from '@shared/types'

export type TimelineInitialLocation = number | { index: number | 'LAST'; align: 'start' | 'center' | 'end'; offset?: number } | undefined

export interface TimelineRemountAnchor {
  atBottom: boolean
  topItemId: string | null
  topOffset?: number
}

export function initialTimelineLocation(
  _saved: ViewState | null | undefined,
  _itemKeys: string[],
  _unread: boolean,
  _now = Date.now()
): TimelineInitialLocation {
  // Selecting or reopening a chat is navigation, not a continuation of the
  // previous viewport. Always land on the latest message; explicit search and
  // history navigation still preserve their own anchors while the chat stays
  // open.
  return { index: 'LAST', align: 'end' }
}

export function isLatestTimelineLocation(location: TimelineInitialLocation): boolean {
  return typeof location === 'object' && location !== null && location.index === 'LAST'
}

/**
 * Resolve the location for a new Virtuoso source. A replacement generation
 * may reuse a semantic row key, but its old numeric index has no authority in
 * the new array. Preserve the semantic anchor only while it still exists;
 * otherwise land at the verified tail. Explicit history navigation supplies
 * its own sequence-derived location and always wins.
 */
export function remountTimelineLocation(
  anchor: TimelineRemountAnchor,
  itemKeys: string[],
  explicitLocation?: TimelineInitialLocation
): TimelineInitialLocation {
  if (explicitLocation !== undefined) return explicitLocation
  if (!anchor.atBottom && anchor.topItemId) {
    const index = itemKeys.indexOf(anchor.topItemId)
    if (index >= 0) return { index, align: 'start', offset: -(anchor.topOffset ?? 0) }
  }
  return { index: 'LAST', align: 'end' }
}

/**
 * Keep Virtuoso's absolute first index aligned when a stable source prepends
 * rows or slides a bounded window forward. The first row shared by both
 * projections proves how many rows moved across the leading edge.
 */
export function shiftedTimelineFirstItemIndex(
  current: number,
  previousKeys: readonly string[],
  nextKeys: readonly string[]
): number {
  if (!previousKeys.length || !nextKeys.length) return current
  const previousIndexes = new Map(previousKeys.map((key, index) => [key, index]))
  for (let nextIndex = 0; nextIndex < nextKeys.length; nextIndex += 1) {
    const previousIndex = previousIndexes.get(nextKeys[nextIndex])
    if (previousIndex !== undefined) return current + previousIndex - nextIndex
  }
  return current
}
