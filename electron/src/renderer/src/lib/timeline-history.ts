import type { Event, TimelinePage } from '@shared/types'

export type HistoricalEdgeAction = 'load' | 'return-live' | 'none'

// A jump should land with enough surrounding conversation to browse without
// immediately paging again. Directional older loads can use the full server
// page instead of spending half their budget on already-visible events.
export const HISTORICAL_SEEK_EVENT_LIMIT = 1_200
export const HISTORICAL_OLDER_EVENT_LIMIT = 1_000
export const HISTORICAL_NEWER_WINDOW_LIMIT = 1_200

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

export function mergeHistoricalPages(current: TimelinePage, incoming: TimelinePage): TimelinePage {
  const events = mergeEvents(current.events, incoming.events)
  const currentFirst = current.events[0]?.seq ?? Number.MAX_SAFE_INTEGER
  const incomingFirst = incoming.events[0]?.seq ?? Number.MAX_SAFE_INTEGER
  const currentLast = current.events.at(-1)?.seq ?? 0
  const incomingLast = incoming.events.at(-1)?.seq ?? 0
  const beginning = incomingFirst <= currentFirst ? incoming : current
  const ending = incomingLast >= currentLast ? incoming : current
  const eventsOmittedBefore = beginning.events_omitted_before ?? (beginning.has_more ? 1 : 0)
  const eventsOmittedAfter = ending.events_omitted_after ?? Math.max(0, (ending.latest_seq ?? incoming.latest_seq ?? current.latest_seq ?? 0) - (events.at(-1)?.seq ?? 0))

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
  const events = mergeEvents(page.events, liveEvents)
  return {
    ...page,
    events,
    before: events[0]?.seq ?? null,
    latest_seq: Math.max(page.latest_seq ?? 0, events.at(-1)?.seq ?? 0) || null,
    events_omitted_after: 0
  }
}

function mergeEvents(current: Event[], incoming: Event[]): Event[] {
  const byId = new Map(current.map(event => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}
