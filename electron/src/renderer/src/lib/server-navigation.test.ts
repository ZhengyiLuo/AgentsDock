import { describe, expect, it } from 'vitest'
import { adjacentServerProfileId } from './server-navigation'

const profiles = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }]

describe('server keyboard navigation', () => {
  it('moves in saved profile order and wraps in both directions', () => {
    expect(adjacentServerProfileId(profiles, 'alpha', 1)).toBe('beta')
    expect(adjacentServerProfileId(profiles, 'gamma', 1)).toBe('alpha')
    expect(adjacentServerProfileId(profiles, 'alpha', -1)).toBe('gamma')
    expect(adjacentServerProfileId(profiles, 'beta', -1)).toBe('alpha')
  })

  it('does nothing without a real adjacent target', () => {
    expect(adjacentServerProfileId([], null, 1)).toBeNull()
    expect(adjacentServerProfileId([{ id: 'alpha' }], 'alpha', 1)).toBeNull()
    expect(adjacentServerProfileId(profiles, 'missing', 1)).toBeNull()
  })
})
