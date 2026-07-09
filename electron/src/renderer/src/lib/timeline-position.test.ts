import { describe, expect, it } from 'vitest'
import type { ViewState } from '@shared/types'
import { initialTimelineLocation } from './timeline-position'

const saved = (topItemId: string): ViewState => ({
  sessionId: 'chat-1', topItemId, topOffset: 17, atBottom: false, updatedAt: 1
})

describe('initial timeline position', () => {
  it('restores a saved row when that row is present in the cached window', () => {
    expect(initialTimelineLocation(saved('b'), ['a', 'b', 'c'], false)).toEqual({ index: 1, align: 'start', offset: -17 })
  })

  it('opens at latest when the saved row is outside the cached tail', () => {
    expect(initialTimelineLocation(saved('old-row'), ['new-a', 'new-b'], false)).toEqual({ index: 'LAST', align: 'end' })
  })

  it('opens unread conversations at latest so opening can mark them read', () => {
    expect(initialTimelineLocation(saved('a'), ['a', 'b'], true)).toEqual({ index: 'LAST', align: 'end' })
  })
})
