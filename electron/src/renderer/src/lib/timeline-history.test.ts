import { describe, expect, it } from 'vitest'
import type { Event, Session, TimelinePage } from '@shared/types'
import { bridgeHistoricalPageToLive, historicalEdgeAction, historicalPageHasNewer, historicalPageHasOlder, mergeHistoricalPages } from './timeline-history'

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
})
