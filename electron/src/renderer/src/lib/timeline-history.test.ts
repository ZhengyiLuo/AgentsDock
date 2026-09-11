import { describe, expect, it } from 'vitest'
import type { Event, Session, TimelinePage } from '@shared/types'
import {
  bridgeHistoricalPageToLive,
  HISTORICAL_NEWER_WINDOW_LIMIT,
  HISTORICAL_OLDER_EVENT_LIMIT,
  HISTORICAL_RETAINED_EVENT_LIMIT,
  HISTORICAL_SEEK_EVENT_LIMIT,
  historicalEdgeAction,
  historicalPageHasNewer,
  historicalPageHasOlder,
  mergeHistoricalPages
} from './timeline-history'

const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
const event = (seq: number): Event => ({ id: `event-${seq}`, session_id: 'chat', seq, type: 'assistant_text', ts: '2026-07-11T00:00:00Z', text: String(seq) })
const page = (sequences: number[], before: number, after: number): TimelinePage => ({
  session,
  events: sequences.map(event),
  has_more: before > 0,
  events_omitted_before: before,
  events_omitted_after: after,
  latest_seq: 100,
  total: 100
})

describe('historical timeline paging', () => {
  it('keeps source-proven assistant repairs when old same-ID copies bridge live and history pages', () => {
    const legacy: Event = { ...event(80), imported: true, backend: 'claude', run_id: 'import_mixed', text: 'Old report',
      provider_origin: { provider: 'claude', event_id: 'source-one', session_id: 'provider-one', timestamp: '2026-07-11T00:00:00.321Z' } }
    const corrected: Event = { ...legacy, text: '', metadata_only: true, provider_history_repair: 'source_proven_assistant_replay' }
    const correctedPage = { ...page([80], 79, 20), events: [corrected] }
    expect(bridgeHistoricalPageToLive(correctedPage, [legacy, event(90)]).events).toEqual([corrected, event(90)])
    expect(mergeHistoricalPages(correctedPage, { ...correctedPage, events: [legacy] }).events).toEqual([corrected])
    expect(mergeHistoricalPages({ ...correctedPage, events: [legacy] }, correctedPage).events).toEqual([corrected])
  })

  it('keeps proven same-ID interruption repairs when a historical window bridges a stale live cache', () => {
    const legacy: Event = { ...event(80), type: 'turn_started', imported: true, backend: 'claude', prompt: '[Request interrupted by user]' }
    const corrected: Event = { ...legacy, type: 'provider_interruption', prompt: null,
      provider_origin: { provider: 'claude', kind: 'interruption', cause: 'steer',
        event_id: '6ab1aa42-7518-4ad3-9175-e605e381936e', session_id: 'f8061024-af24-4765-a395-74c638c37b03',
        timestamp: '2026-09-09T20:16:54.515Z' } }
    const correctedPage = { ...page([80], 79, 20), events: [corrected] }
    expect(bridgeHistoricalPageToLive(correctedPage, [legacy, event(90)]).events).toEqual([corrected, event(90)])
    expect(mergeHistoricalPages(correctedPage, { ...correctedPage, events: [legacy] }).events).toEqual([corrected])
    expect(mergeHistoricalPages({ ...correctedPage, events: [legacy] }, correctedPage).events).toEqual([corrected])
  })

  it('keeps jumps and edge continuation large enough to avoid tiny-page churn', () => {
    expect(HISTORICAL_SEEK_EVENT_LIMIT).toBe(1_200)
    expect(HISTORICAL_OLDER_EVENT_LIMIT).toBe(1_000)
    expect(HISTORICAL_NEWER_WINDOW_LIMIT).toBe(1_200)
    expect(HISTORICAL_RETAINED_EVENT_LIMIT).toBe(2_400)
  })

  it('merges overlapping adjacent pages without duplicating events', () => {
    const merged = mergeHistoricalPages(page([40, 50, 60], 39, 40), page([20, 30, 40, 50], 19, 50))
    expect(merged.events.map(item => item.seq)).toEqual([20, 30, 40, 50, 60])
    expect(merged.events_omitted_before).toBe(19)
    expect(merged.events_omitted_after).toBe(40)
    expect(historicalPageHasOlder(merged)).toBe(true)
    expect(historicalPageHasNewer(merged)).toBe(true)
  })

  it('bridges into the cached live tail only after the windows meet', () => {
    const distant = page([20, 30, 40], 19, 60)
    expect(bridgeHistoricalPageToLive(distant, [event(80), event(90), event(100)])).toBe(distant)

    const overlapping = page([60, 70, 80], 59, 20)
    const bridged = bridgeHistoricalPageToLive(overlapping, [event(80), event(90), event(100)])
    expect(bridged.events.map(item => item.seq)).toEqual([60, 70, 80, 90, 100])
    expect(bridged.events_omitted_after).toBe(0)
    expect(historicalPageHasNewer(bridged)).toBe(false)
  })

  it('never leaves a navigated slice as a dead-end segment', () => {
    expect(historicalEdgeAction(page([40, 50, 60], 39, 40), 'older')).toBe('load')
    expect(historicalEdgeAction(page([40, 50, 60], 39, 40), 'newer')).toBe('load')
    expect(historicalEdgeAction(page([1, 2, 3], 0, 97), 'older')).toBe('none')
    expect(historicalEdgeAction(page([98, 99, 100], 97, 0), 'newer')).toBe('return-live')
  })

  it('slides a bounded window across many older and newer pages without closing either paging edge', () => {
    const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => start + index)
    let window: TimelinePage = {
      ...page(range(4_801, 6_000), 4_800, 4_000),
      latest_seq: 10_000,
      total: 10_000
    }

    for (const start of [3_801, 2_801, 1_801, 801, 1]) {
      window = mergeHistoricalPages(window, {
        ...page(range(start, start + 1_000), start - 1, 10_000 - (start + 1_000)),
        latest_seq: 10_000,
        total: 10_000
      }, 'older')
      expect(window.events.length).toBeLessThanOrEqual(HISTORICAL_RETAINED_EVENT_LIMIT)
      expect(window.before).toBe(window.events[0].seq)
      expect(historicalEdgeAction(window, 'newer')).toBe('load')
    }
    expect(window.events[0].seq).toBe(1)
    expect(historicalEdgeAction(window, 'older')).toBe('none')

    for (let start = window.events.at(-1)!.seq; start < 10_000; start = window.events.at(-1)!.seq) {
      const end = Math.min(10_000, start + 1_200)
      window = mergeHistoricalPages(window, {
        ...page(range(start, end), start - 1, 10_000 - end),
        latest_seq: 10_000,
        total: 10_000
      }, 'newer')
      expect(window.events.length).toBeLessThanOrEqual(HISTORICAL_RETAINED_EVENT_LIMIT)
      expect(window.events_omitted_before).toBeGreaterThan(0)
      expect(historicalEdgeAction(window, 'older')).toBe('load')
    }
    expect(window.events.at(-1)?.seq).toBe(10_000)
    expect(historicalEdgeAction(window, 'newer')).toBe('return-live')
  })

  it('keeps the live bridge bounded and preserves an older reload cursor', () => {
    const historical = {
      ...page(Array.from({ length: 2_400 }, (_, index) => index + 1), 0, 600),
      latest_seq: 3_000,
      total: 3_000
    }
    const bridged = bridgeHistoricalPageToLive(
      historical,
      Array.from({ length: 601 }, (_, index) => event(index + 2_400))
    )
    expect(bridged.events).toHaveLength(HISTORICAL_RETAINED_EVENT_LIMIT)
    expect(bridged.events.at(-1)?.seq).toBe(3_000)
    expect(bridged.events_omitted_before).toBe(600)
    expect(historicalEdgeAction(bridged, 'older')).toBe('load')
    expect(historicalEdgeAction(bridged, 'newer')).toBe('return-live')
  })
})
