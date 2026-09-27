import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'
import { connectionRequest, parseConnectionReply } from '../shared/provider-connections'

const input = { base_url: 'https://gateway.example/api', model: 'test/model', api_key: 'synthetic-only',
  protocol: 'anthropic' as const, auth_header: 'bearer' as const, expected_revision: 0 }
const config = { backend: 'claude', scope: 'settings_only', revision: 1, configured: true, has_api_key: true,
  base_url: input.base_url, model: input.model, protocol: input.protocol, auth_header: input.auth_header,
  checked_at: '2026-09-27T20:00:00Z', last_result: 'verified' }
const empty = { ...config, configured: false, has_api_key: false, base_url: null, model: null, protocol: null,
  auth_header: null, checked_at: null, last_result: null }

describe('settings-only provider connection native transport', () => {
  it('uses exact native routes and strips extra secret fields from successful responses', async () => {
    const calls: { url?: string; method?: string; body: string }[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('generic fetch forbidden'))
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      calls.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() })
      expect(req.headers['x-agentsdock-token']).toBe('synthetic-admin')
      expect(req.headers['origin']).toBeUndefined(); expect(req.headers['sec-fetch-mode']).toBeUndefined()
      const safe = { ...(req.method === 'DELETE' ? empty : config), api_key: input.api_key }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(['PUT', 'POST'].includes(req.method!) ? { ok: true, status: 'verified', configuration: safe, secret: input.api_key } : safe))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mount`, 'synthetic-admin')
    try {
      expect(await client.providerConnectionRequest('claude', 'get')).toEqual({ configuration: config })
      for (const action of ['save', 'check'] as const) {
        expect(await client.providerConnectionRequest('claude', action, action === 'save' ? input : { expected_revision: 1 }))
          .toEqual({ ok: true, status: 'verified', configuration: config })
      }
      expect(await client.providerConnectionRequest('claude', 'forget', { expected_revision: 1 })).toEqual({ configuration: empty })
      expect(calls.map(c => [c.method, c.url])).toEqual([
        ['GET', '/mount/api/admin/provider-connections/claude'], ['PUT', '/mount/api/admin/provider-connections/claude'],
        ['POST', '/mount/api/admin/provider-connections/claude/check'], ['DELETE', '/mount/api/admin/provider-connections/claude']])
      expect(JSON.parse(calls[1].body)).toEqual(input)
      expect(JSON.parse(calls[2].body)).toEqual({ expected_revision: 1 })
      expect(fetch).not.toHaveBeenCalled()
    } finally { client.dispose(); fetch.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('rejects malformed and cross-provider selections before transport', () => {
    for (const invalid of [{ ...input, model: null }, { ...input, protocol: [] }, { ...input, expected_revision: -1 },
      { ...input, base_url: 'http://remote.example' }, { ...input, base_url: 'https://example/api?key=secret' },
      { ...input, protocol: 'responses' }, { ...input, unexpected: true }]) {
      expect(() => connectionRequest('claude', 'save', invalid)).toThrow('PROVIDER_CONNECTION_INVALID')
    }
    expect(() => connectionRequest('cursor' as 'claude', 'save', input)).toThrow('PROVIDER_CONNECTION_INVALID')
    expect(() => connectionRequest('claude', 'check', input)).toThrow('PROVIDER_CONNECTION_INVALID')
  })

  it('does not treat inconsistent or stale-looking response evidence as a verified API', () => {
    for (const configuration of [{ ...config, backend: 'opencode' }, { ...config, last_result: 'authentication_failed' },
      { ...config, checked_at: 'not-time' }, { ...config, scope: 'chat' }]) {
      expect(() => parseConnectionReply('claude', 'save', { ok: true, status: 'verified', configuration })).toThrow('PROVIDER_CONNECTION_RESPONSE')
    }
    expect(parseConnectionReply('claude', 'save', { ok: false, status: 'authentication_failed', error: input.api_key }))
      .toEqual({ ok: false, status: 'authentication_failed' })
  })
})
