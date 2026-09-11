import type { Event, TimelinePage } from '@shared/types'
import { mergeProviderInterruptionEvent } from '@shared/provider-origin'

export type HistoricalEdgeAction = 'load' | 'return-live' | 'none'

// A jump should land with enough surrounding conversation to browse without
// immediately paging again. Directional older loads can use the full server
// page instead of spending half their budget on already-visible events.
export const HISTORICAL_SEEK_EVENT_LIMIT = 1_200
export const HISTORICAL_OLDER_EVENT_LIMIT = 1_000
export const HISTORICAL_NEWER_WINDOW_LIMIT = 1_200
// Keep a generous two-page sliding window. Edge metadata accounts for rows
// trimmed from either side, so the discarded side remains reloadable without
// retaining/reprojecting an unbounded conversation in the renderer.
export const HISTORICAL_RETAINED_EVENT_LIMIT = 2_400

export function historicalPageHasOlder(page: TimelinePage): boolean {
  return Boolean(page.has_more) || (page.events_omitted_before ?? 0) > 0
}

export function historicalPageHasNewer(page: TimelinePage): boolean {
  const lastSequence = page.events.at(-1)?.seq ?? 0
  return (page.events_omitted_after ?? Math.max(0, (page.latest_seq ?? lastSequence) - lastSequence)) > 0
}

export function historicalEdgeAction(page: TimelinePage, direction: 'older' | 'newer'): HistoricalEdgeAction {
  if (direction === 'older') return historicalPageHasOlder(page) ? 'load' : 'none'
  return historicalPageHasNewer(page) ? 'load' : 'return-live'
}

export function mergeHistoricalPages(
  current: TimelinePage,
  incoming: TimelinePage,
  direction?: 'older' | 'newer'
): TimelinePage {
  const mergedEvents = mergeEvents(current.events, incoming.events)
  const currentFirst = current.events[0]?.seq ?? Number.MAX_SAFE_INTEGER
  const incomingFirst = incoming.events[0]?.seq ?? Number.MAX_SAFE_INTEGER
  const currentLast = current.events.at(-1)?.seq ?? 0
  const incomingLast = incoming.events.at(-1)?.seq ?? 0
  const beginning = incomingFirst <= currentFirst ? incoming : current
  const ending = incomingLast >= currentLast ? incoming : current
  let eventsOmittedBefore = beginning.events_omitted_before ?? (beginning.has_more ? 1 : 0)
  let eventsOmittedAfter = ending.events_omitted_after ?? Math.max(0, (ending.latest_seq ?? incoming.latest_seq ?? current.latest_seq ?? 0) - (mergedEvents.at(-1)?.seq ?? 0))
  const retainedDirection = direction ?? (incomingFirst < currentFirst ? 'older' : 'newer')
  let events = mergedEvents
  if (mergedEvents.length > HISTORICAL_RETAINED_EVENT_LIMIT) {
    const trimmed = mergedEvents.length - HISTORICAL_RETAINED_EVENT_LIMIT
    if (retainedDirection === 'older') {
      events = mergedEvents.slice(0, HISTORICAL_RETAINED_EVENT_LIMIT)
      eventsOmittedAfter += trimmed
    } else {
      events = mergedEvents.slice(trimmed)
      eventsOmittedBefore += trimmed
    }
  }

  return {
    ...current,
    session: incoming.session,
    events,
    queued_turns: incoming.queued_turns ?? current.queued_turns,
    has_more: eventsOmittedBefore > 0,
    before: events[0]?.seq ?? null,
    total: Math.max(current.total ?? 0, incoming.total ?? 0) || null,
    latest_seq: Math.max(current.latest_seq ?? 0, incoming.latest_seq ?? 0) || null,
    events_omitted_before: eventsOmittedBefore,
    events_omitted_after: eventsOmittedAfter
  }
}

export function bridgeHistoricalPageToLive(page: TimelinePage, liveEvents: Event[]): TimelinePage {
  if (!liveEvents.length) return page
  const historicalLast = page.events.at(-1)?.seq ?? 0
  const liveFirst = liveEvents[0]?.seq ?? Number.MAX_SAFE_INTEGER
  if (historicalPageHasNewer(page) && historicalLast < liveFirst) return page
  const mergedEvents = mergeEvents(page.events, liveEvents)
  const trimmed = Math.max(0, mergedEvents.length - HISTORICAL_RETAINED_EVENT_LIMIT)
  const events = trimmed ? mergedEvents.slice(trimmed) : mergedEvents
  return {
    ...page,
    events,
    before: events[0]?.seq ?? null,
    latest_seq: Math.max(page.latest_seq ?? 0, events.at(-1)?.seq ?? 0) || null,
    events_omitted_before: (page.events_omitted_before ?? (page.has_more ? 1 : 0)) + trimmed,
    has_more: (page.events_omitted_before ?? (page.has_more ? 1 : 0)) + trimmed > 0,
    events_omitted_after: 0
  }
}

function mergeEvents(current: Event[], incoming: Event[]): Event[] {
  const byId = new Map(current.map(event => [event.id, event]))
  for (const event of incoming) {
    const previous = byId.get(event.id)
    byId.set(event.id, previous ? mergeProviderInterruptionEvent(previous, event) : event)
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}
