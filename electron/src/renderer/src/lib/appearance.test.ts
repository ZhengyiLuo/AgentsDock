import { describe, expect, it } from 'vitest'
import { resolveAppearance } from './appearance'

describe('resolveAppearance', () => {
  it('follows the system preference in system mode', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
  })

  it('keeps explicit appearance choices stable', () => {
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })
})
