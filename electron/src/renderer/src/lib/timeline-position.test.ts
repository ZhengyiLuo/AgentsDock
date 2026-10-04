import { describe, expect, it } from 'vitest'
import type { ViewState } from '@shared/types'
import {
  initialTimelineLocation,
  isLatestTimelineLocation,
  remountTimelineLocation,
  shiftedTimelineFirstItemIndex
} from './timeline-position'

const NOW = 1_000_000_000_000
const saved = (topItemId: string, updatedAt = NOW - 1_000): ViewState => ({
  sessionId: 'chat-1', topItemId, topOffset: 17, atBottom: false, updatedAt
})

describe('initial timeline position', () => {
  it('restores the saved semantic row and its pixel offset when returning to a chat', () => {
    expect(initialTimelineLocation(saved('b'), ['a', 'b', 'c'], false, NOW)).toEqual({ index: 1, align: 'start', offset: -17 })
  })

  it('opens first visits and readers already at the bottom at latest', () => {
    expect(initialTimelineLocation(undefined, ['a', 'b'], false, NOW)).toEqual({ index: 'LAST', align: 'end' })
    expect(initialTimelineLocation({ ...saved('a'), atBottom: true }, ['a', 'b'], false, NOW)).toEqual({ index: 'LAST', align: 'end' })
  })

  it('opens at latest when the saved row is outside the cached tail', () => {
    expect(initialTimelineLocation(saved('old-row'), ['new-a', 'new-b'], false, NOW)).toEqual({ index: 'LAST', align: 'end' })
  })

  it('keeps the reading position when new unread messages arrive elsewhere in the chat', () => {
    expect(initialTimelineLocation(saved('a'), ['a', 'b'], true, NOW)).toEqual({ index: 0, align: 'start', offset: -17 })
  })

  it('identifies the latest location', () => {
    expect(isLatestTimelineLocation({ index: 'LAST', align: 'end' })).toBe(true)
    expect(isLatestTimelineLocation({ index: 3, align: 'start' })).toBe(false)
    expect(isLatestTimelineLocation(undefined)).toBe(false)
  })
})

describe('replacement-generation timeline position', () => {
  it('resolves a retained mid-scroll semantic anchor against the replacement rows', () => {
    expect(remountTimelineLocation(
      { atBottom: false, topItemId: 'kept-row', topOffset: -12 },
      ['new-prefix', 'kept-row', 'new-tail']
    )).toEqual({ index: 1, align: 'start', offset: 12 })
  })

  it('keeps a reader who was at latest on the replacement tail', () => {
    expect(remountTimelineLocation(
      { atBottom: true, topItemId: 'old-tail', topOffset: 0 },
      ['replacement-tail']
    )).toEqual({ index: 'LAST', align: 'end' })
  })

  it('falls back to latest instead of reusing an out-of-range old index', () => {
    expect(remountTimelineLocation(
      { atBottom: false, topItemId: 'removed-row', topOffset: 9 },
      ['replacement-a', 'replacement-b']
    )).toEqual({ index: 'LAST', align: 'end' })
  })

  it('preserves an explicit sequence-derived user seek location', () => {
    const seek = { index: 4, align: 'center' as const }
    expect(remountTimelineLocation(
      { atBottom: false, topItemId: 'unrelated-live-row', topOffset: 2 },
      ['history-a', 'history-b'],
      seek
    )).toEqual(seek)
  })
})

describe('bounded timeline first-item index', () => {
  it('tracks both prepended rows and rows trimmed from the leading edge', () => {
    expect(shiftedTimelineFirstItemIndex(1_000_000, ['b', 'c'], ['a', 'b', 'c'])).toBe(999_999)
    expect(shiftedTimelineFirstItemIndex(999_999, ['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(1_000_000)
  })

  it('does not infer an offset when replacement rows have no proven overlap', () => {
    expect(shiftedTimelineFirstItemIndex(1_000_000, ['old-a', 'old-b'], ['new-a', 'new-b'])).toBe(1_000_000)
  })
})
