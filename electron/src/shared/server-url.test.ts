import { describe, expect, it } from 'vitest'
import { normalizeServerURL } from './server-url'

describe('normalizeServerURL', () => {
  it('accepts the short host and port form used by the apps', () => {
    expect(normalizeServerURL('100.64.0.10:7850')).toBe('http://100.64.0.10:7850')
  })

  it('removes only a health suffix, query, hash, and trailing slash', () => {
    expect(normalizeServerURL('https://dock.example/api/health/?x=1#status')).toBe('https://dock.example')
  })
})
