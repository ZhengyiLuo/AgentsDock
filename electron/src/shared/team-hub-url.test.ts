import { describe, expect, it } from 'vitest'
import {
  deriveMountedTeamHubURL,
  deriveSecurePeerTeamHubURL,
  deriveServerTeamHubURL,
  deriveTeamHubBootstrapControlURL,
  normalizeDirectIPTeamHubURL,
  normalizeMountedTeamHubURL,
  normalizeTailscaleServeTeamHubURL
} from './team-hub-url'

describe('deriveMountedTeamHubURL', () => {
  it('derives and normalizes only the exact server-scoped proxy path', () => {
    expect(deriveServerTeamHubURL('https://dock.example.test/prefix', '/api/team-hub-server')).toBe(
      'https://dock.example.test/prefix/api/team-hub-server'
    )
    expect(normalizeMountedTeamHubURL('https://dock.example.test/prefix/api/team-hub-server')).toBe(
      'https://dock.example.test/prefix/api/team-hub-server'
    )
    expect(() => deriveServerTeamHubURL(
      'https://dock.example.test/prefix',
      '/api/team-hub-server/escape'
    )).toThrow(/invalid server Teamspace proxy path/i)
  })

  it('derives a secure-peer proxy from the active control server and exact UUID-bound path', () => {
    const path = '/api/team-hub-secure/09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    expect(deriveSecurePeerTeamHubURL('https://dock.example.test/prefix', path, null)).toBe(
      `https://dock.example.test/prefix${path}`
    )
    expect(() => deriveSecurePeerTeamHubURL(
      'https://dock.example.test/prefix',
      path,
      `https://attacker.invalid${path}`
    )).toThrow(/outside the active control origin/i)
  })

  it.each([
    '/api/team-hub-secure/not-a-uuid',
    '/api/team-hub-secure/09D7BB2E-3B47-4BE7-89FC-2CECD90F4434',
    '/api/team-hub-secure/09d7bb2e-3b47-4be7-89fc-2cecd90f4434/escape',
    '/api/team-hub-secure/09d7bb2e-3b47-4be7-89fc-2cecd90f4434?next=evil',
    '//attacker.invalid/api/team-hub-secure/09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
  ])('rejects malformed secure proxy path %s', path => {
    expect(() => deriveSecurePeerTeamHubURL('http://100.64.0.1:7850', path, null)).toThrow()
  })

  it('keeps discovery on the verified loopback AgentsServer origin', () => {
    expect(deriveMountedTeamHubURL('http://127.0.0.1:7850', '/api/team-hub')).toBe(
      'http://127.0.0.1:7850/api/team-hub'
    )
    expect(deriveMountedTeamHubURL('http://localhost:7850/agents', '/api/team-hub')).toBe(
      'http://localhost:7850/agents/api/team-hub'
    )
  })

  it('rejects every remote origin and path-based routing attack', () => {
    expect(() => deriveMountedTeamHubURL('http://100.64.1.2:7850', '/api/team-hub')).toThrow('only from the designated host')
    expect(() => deriveMountedTeamHubURL('https://server.example.test', '/api/team-hub')).toThrow('only from the designated host')
    for (const path of [
      'https://attacker.test/api/team-hub',
      '//attacker.test/api/team-hub',
      '/api/../team-hub',
      '/api/%2e%2e/team-hub',
      '/api%2fteam-hub',
      '/api\\team-hub',
      '/api/team-hub?next=https://attacker.test',
      '/api/team-hub#secret',
      '/api/team-hub/'
    ]) expect(() => deriveMountedTeamHubURL('http://127.0.0.1:7850', path)).toThrow('invalid Team Hub API path')
    expect(() => deriveMountedTeamHubURL('http://127.0.0.1:7850/prefix%2fescape', '/api/team-hub')).toThrow('base path is invalid')
  })

  it('normalizes only already-derived same-origin Hub bases for the client', () => {
    expect(normalizeMountedTeamHubURL('http://127.0.0.1:7850/api/team-hub')).toBe(
      'http://127.0.0.1:7850/api/team-hub'
    )
    expect(normalizeMountedTeamHubURL('http://localhost:7850/prefix/api/team-hub')).toBe(
      'http://localhost:7850/prefix/api/team-hub'
    )
    expect(() => normalizeMountedTeamHubURL('http://user:secret@127.0.0.1:7850/api/team-hub')).toThrow('invalid')
    expect(() => normalizeMountedTeamHubURL('http://127.0.0.1:7850/api/%2e%2e/team-hub')).toThrow('invalid')
    expect(() => normalizeMountedTeamHubURL('http://127.0.0.1:7850/other-api')).toThrow('invalid')
  })

  it('normalizes a connection-bound secure proxy beneath an AgentsServer base-path prefix', () => {
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    expect(normalizeMountedTeamHubURL(
      `http://100.64.0.1:7850/prefix/api/team-hub-secure/${connectionId}`
    )).toBe(`http://100.64.0.1:7850/prefix/api/team-hub-secure/${connectionId}`)
    expect(() => normalizeMountedTeamHubURL(
      `http://100.64.0.1:7850/prefix/api/team-hub-secure/${connectionId}/escape`
    )).toThrow('invalid')
  })

  it('accepts only the exact private Tailscale Serve URL and derives its fixed admin exchange', () => {
    const hub = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    expect(normalizeTailscaleServeTeamHubURL(hub)).toBe(hub)
    expect(normalizeMountedTeamHubURL(hub)).toBe(hub)
    expect(() => normalizeMountedTeamHubURL(
      'https://atlas.my-tailnet.ts.net:8444/prefix/api/team-hub'
    )).toThrow('invalid')
    expect(deriveTeamHubBootstrapControlURL(hub)).toBe(
      'https://atlas.my-tailnet.ts.net:8444/api/admin/team-hub/bootstrap-proof'
    )
  })

  it('bounds advertised private Serve URLs before parsing them', () => {
    expect(() => normalizeTailscaleServeTeamHubURL(`https://${'a'.repeat(2048)}.ts.net:8444/api/team-hub`)).toThrow(
      'advertised Team Hub URL is invalid'
    )
  })

  it('accepts only an exact literal-IP Teamspace route on the active AgentsServer origin', () => {
    const hub = 'http://100.64.0.1:7850/api/team-hub'
    expect(normalizeDirectIPTeamHubURL(hub, 'http://100.64.0.1:7850')).toBe(hub)
    expect(normalizeMountedTeamHubURL(hub)).toBe(hub)
    expect(deriveTeamHubBootstrapControlURL(hub)).toBe(
      'http://100.64.0.1:7850/api/admin/team-hub/bootstrap-proof'
    )
  })

  it.each([
    ['http://100.64.0.1:7850/api/team-hub', 'http://100.64.0.2:7850'],
    ['http://100.64.0.1:7850/api/team-hub', 'http://100.64.0.1:7850/prefix'],
    ['http://100.64.0.1:7850/api/team-hub', 'http://user:secret@100.64.0.1:7850'],
    ['http://100.64.0.1:7850/api/team-hub', 'http://100.64.0.1:7850/?next=evil'],
    ['http://100.64.0.1:7850/api/team-hub', 'http://100.64.0.1:7850/#fragment'],
    ['http://100.64.0.1:7850/api/team-hub', 'https://100.64.0.1:7850']
  ])('rejects direct route %s against non-exact active server %s', (hub, server) => {
    expect(() => normalizeDirectIPTeamHubURL(hub, server)).toThrow()
  })

  it.each([
    'https://100.64.0.1:7850/api/team-hub',
    'http://atlas.example.test:7850/api/team-hub',
    'http://127.0.0.1:7850/api/team-hub',
    'http://0.73.184.23:7850/api/team-hub',
    'http://224.1.2.3:7850/api/team-hub',
    'http://100.064.0.1:7850/api/team-hub',
    'http://100.64.0.1/api/team-hub',
    'http://100.64.0.1:7850/prefix/api/team-hub',
    'http://100.64.0.1:7850/api/team-hub/',
    'http://100.64.0.1:7850/api/%74eam-hub',
    'http://100.64.0.1:7850/api/team-hub?next=evil',
    'http://user:secret@100.64.0.1:7850/api/team-hub'
  ])('rejects non-canonical direct-IP URL %s', value => {
    expect(() => normalizeDirectIPTeamHubURL(value)).toThrow()
  })

  it.each([
    'http://atlas.my-tailnet.ts.net:8444/api/team-hub',
    'https://100.64.0.1:8444/api/team-hub',
    'https://atlas.example.com:8444/api/team-hub',
    'https://atlas.my-tailnet.ts.net/api/team-hub',
    'https://atlas.my-tailnet.ts.net:8443/api/team-hub',
    'https://atlas.my-tailnet.ts.net:8444/prefix/api/team-hub',
    'https://atlas.my-tailnet.ts.net:8444/api/team-hub/',
    'https://atlas.my-tailnet.ts.net:8444/api/team-hub?next=evil',
    'https://user:secret@atlas.my-tailnet.ts.net:8444/api/team-hub',
    'https://Atlas.my-tailnet.ts.net:8444/api/team-hub',
    'https://host.ts.net:8444/api/team-hub'
  ])('rejects non-private or non-canonical advertised Serve URL %s', value => {
    expect(() => normalizeTailscaleServeTeamHubURL(value)).toThrow()
  })
})
