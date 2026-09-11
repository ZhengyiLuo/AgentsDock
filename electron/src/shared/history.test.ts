import { describe, expect, it } from 'vitest'
import { timelineCacheHasGap } from './history'

describe('timeline cache completeness', () => {
  it('detects a sparse legacy cache even when it contains sequence one and the newest tail', () => {
    expect(timelineCacheHasGap(240, 0, 74_130, 1)).toBe(true)
  })

  it('accepts a complete cache plus its not-yet-persisted delta', () => {
    expect(timelineCacheHasGap(240, 3, 243, 1)).toBe(false)
  })

  it('keeps a contiguous partial tail that can continue paging backward', () => {
    expect(timelineCacheHasGap(240, 0, 74_130, 103_000)).toBe(false)
  })
})
