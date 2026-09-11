import { describe, expect, it } from 'vitest'
import { parentDirectory } from './working-directory-path'

describe('parentDirectory', () => {
  it.each([
    ['/', '/'],
    ['/srv/work/', '/srv'],
    ['relative', 'relative'],
    ['relative/child', 'relative'],
    ['C:\\', 'C:\\'],
    ['C:\\Users\\me', 'C:\\Users'],
    ['C:/', 'C:/'],
    ['C:/Users/me', 'C:/Users'],
    ['\\\\server\\share', '\\\\server\\share'],
    ['\\\\server\\share\\folder', '\\\\server\\share']
  ])('returns the parent of %s', (path, expected) => {
    expect(parentDirectory(path)).toBe(expected)
  })
})
