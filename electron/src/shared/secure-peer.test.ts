import { describe, expect, it } from 'vitest'
import {
  normalizeSecurePeerEndpoint,
  normalizeSecurePeerJoinTarget,
  normalizeSecurePeerScopes
} from './secure-peer'

describe('secure peer join targets', () => {
  it('accepts canonical private, public, and CGNAT IPv4 with an unprivileged port', () => {
    expect(normalizeSecurePeerEndpoint('192.168.1.20')).toEqual({ host: '192.168.1.20', port: 7851, endpoint: '192.168.1.20:7851' })
    expect(normalizeSecurePeerEndpoint('100.64.0.1:8445').endpoint).toBe('100.64.0.1:8445')
    expect(normalizeSecurePeerEndpoint('8.8.8.8:65535').endpoint).toBe('8.8.8.8:65535')
  })

  it.each([
    'localhost:7851', 'server.example:7851', '127.0.0.1:7851', '0.0.0.0:7851',
    '169.254.169.254:7851', '224.0.0.1:7851', '255.255.255.255:7851',
    '192.168.001.20:7851', '192.168.1.20:80', '192.168.1.20:65536',
    '192.168.1.20:07851', '192.168.1.20:+7851', '192.168.1.20:8e3', '192.168.1.20:7851.0',
    'http://192.168.1.20:7851', 'user@192.168.1.20:7851', '[::1]:7851',
    '192.168.1.20:7851/path', ' 192.168.1.20:7851'
  ])('rejects unsafe or ambiguous endpoint %s', value => {
    expect(() => normalizeSecurePeerEndpoint(value)).toThrow()
  })

  it('parses an exact secret-free pairing link and binds its CA fingerprint', () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`
    expect(normalizeSecurePeerJoinTarget(link)).toEqual({
      host: '100.64.0.1', port: 7851, endpoint: '100.64.0.1:7851', expectedCaFingerprint: fingerprint
    })
    expect(normalizeSecurePeerJoinTarget('100.64.0.1')).toMatchObject({ expectedCaFingerprint: null })
  })

  it.each([
    `agentsdock://secure-peer/join?host=100.64.0.1&host=10.0.0.1&port=7851&fingerprint=sha256:${'a'.repeat(64)}`,
    `agentsdock://secure-peer/join?host=169.254.169.254&port=7851&fingerprint=sha256:${'a'.repeat(64)}`,
    `agentsdock://secure-peer/join?host=100.64.0.1&port=80&fingerprint=sha256:${'a'.repeat(64)}`,
    `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256:${'a'.repeat(63)}`,
    `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256:${'a'.repeat(64)}&secret=oops`,
    `agentsdock://attacker/join?host=100.64.0.1&port=7851&fingerprint=sha256:${'a'.repeat(64)}`,
    `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(63)}%ZZ`
  ])('rejects malformed or authority-expanding pairing link %s', value => {
    expect(() => normalizeSecurePeerJoinTarget(value)).toThrow()
  })
})

describe('secure peer scopes', () => {
  it('preserves the exact requested subset without adding permissions', () => {
    expect(normalizeSecurePeerScopes(['teamspace.read', 'cross_chat.instruction'])).toEqual([
      'teamspace.read', 'cross_chat.instruction'
    ])
  })

  const invalidScopeSets: unknown[][] = [
    [],
    ['teamspace.read', 'teamspace.read'],
    ['teamspace.read', 'admin'],
    ['teamspace.read', 'teamspace.write', 'cross_chat.instruction', 'cross_chat.request_reply', 'extra']
  ]
  it.each(invalidScopeSets.map(scopes => [scopes]))('rejects empty, duplicate, or unknown scope sets', scopes => {
    expect(() => normalizeSecurePeerScopes(scopes)).toThrow()
  })
})
