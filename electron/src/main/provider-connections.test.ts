import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'
import { connectionRequest, parseConnectionReply, parseCLIAccount } from '../shared/provider-connections'
import { customModelInput, parseCustomModels } from '../shared/custom-models'

const input = { base_url: 'https://gateway.example/api', model: 'test/model', api_key: 'synthetic-only',
  protocol: 'anthropic' as const, auth_header: 'bearer' as const, expected_revision: 0 }
const config = { backend: 'claude', scope: 'settings_only', revision: 1, configured: true, has_api_key: true,
  base_url: input.base_url, model: input.model, protocol: input.protocol, auth_header: input.auth_header,
  checked_at: '2026-09-27T20:00:00Z', last_result: 'verified' }
const empty = { ...config, configured: false, has_api_key: false, base_url: null, model: null, protocol: null,
  auth_header: null, checked_at: null, last_result: null }

describe('settings-only provider connection native transport', () => {
  it('permits only the exact native Cursor credential and model routes', async () => {
    const calls: string[] = []
    const cursorConfig = { ...config, backend: 'cursor', scope: 'per_chat', base_url: 'https://api2.cursor.sh', model: 'auto', protocol: 'cursor' }
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain synthetic key without logging */ }
      calls.push(`${req.method} ${req.url}`)
      expect(req.headers['x-agentsdock-token']).toBe('synthetic-admin')
      expect(req.headers['sec-fetch-mode']).toBeUndefined()
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url?.includes('provider-models')
        ? { backend: 'cursor', revision: 1, default_model: 'auto', models: [{ value: 'auto', label: 'Auto' }], discovery_status: 'ready' }
        : ['PUT', 'POST'].includes(req.method!) ? { ok: true, status: 'verified', configuration: cursorConfig }
          : req.method === 'DELETE' ? { ...empty, backend: 'cursor' } : cursorConfig))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-admin')
    try {
      await client.providerConnectionRequest('cursor', 'get')
      await client.providerConnectionRequest('cursor', 'save', { ...input, protocol: 'cursor', base_url: 'https://api2.cursor.sh', model: null })
      await client.providerConnectionRequest('cursor', 'check', { expected_revision: 1 })
      await client.customModels('cursor')
      await client.providerConnectionRequest('cursor', 'forget', { expected_revision: 1 })
      expect(calls).toHaveLength(5)
    } finally { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('reads and saves custom model defaults through native HTTP without resubmitting a key', async () => {
    const calls: { method?: string; url?: string; body: string }[] = []
    const metadata = { backend: 'claude' as const, revision: 1, default_model: 'fixture/one', models: [{ value: 'fixture/one', label: 'Friendly' }], discovery_status: 'ready' }
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
      expect(req.headers['x-agentsdock-token']).toBe('synthetic-admin')
      expect(req.headers['origin']).toBeUndefined(); expect(req.headers['sec-fetch-mode']).toBeUndefined()
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...metadata, api_key: 'should-not-return' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-admin')
    try {
      expect(await client.customModels('claude')).toEqual(metadata)
      expect(await client.customModels('claude', { model: 'fixture/one', expected_revision: 1 })).toEqual({ backend: 'claude', revision: 1, default_model: 'fixture/one' })
      await client.customModels('claude', undefined, 'session-one')
      expect(calls.map(c => [c.method, c.url])).toEqual([
        ['GET', '/api/admin/provider-models/claude'], ['PUT', '/api/admin/provider-models/claude'], ['GET', '/api/admin/provider-models/claude?session_id=session-one']])
      expect(JSON.parse(calls[1].body)).toEqual({ model: 'fixture/one', expected_revision: 1 })
      expect(() => customModelInput('claude', { model: 'bad model', expected_revision: 1 })).toThrow()
      expect(() => customModelInput('codex', { model: 'valid', expected_revision: 1 })).toThrow()
      expect(() => parseCustomModels('opencode', metadata, true)).toThrow()
    } finally { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('reads CLI account metadata over native HTTP and drops unexpected credentials', async () => {
    const metadata = { backend: 'cursor', email: 'fixture@example.test', plan_type: 'Pro', source: 'cli' }
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('generic fetch forbidden'))
    const server = createServer((req, res) => {
      expect(req.url).toBe('/api/admin/provider-accounts/cursor')
      expect(req.method).toBe('GET')
      expect(req.headers['x-agentsdock-token']).toBe('synthetic-admin')
      expect(req.headers['origin']).toBeUndefined(); expect(req.headers['sec-fetch-mode']).toBeUndefined()
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...metadata, accessToken: 'synthetic-secret' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-admin')
    try {
      expect(await client.providerAccount('cursor')).toEqual(metadata)
      expect(fetch).not.toHaveBeenCalled()
      expect(() => parseCLIAccount('claude', metadata)).toThrow('CLI_ACCOUNT_INVALID')
      expect(() => parseCLIAccount('cursor', { ...metadata, email: 'bad\nemail' })).toThrow('CLI_ACCOUNT_INVALID')
    } finally { client.dispose(); fetch.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
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
    const cursor = { ...input, base_url: 'https://api2.cursor.sh', protocol: 'cursor', auth_header: 'bearer', model: null }
    expect(connectionRequest('cursor', 'save', cursor)).toEqual(cursor)
    expect(() => connectionRequest('cursor', 'save', { ...cursor, base_url: 'https://gateway.invalid' })).toThrow()
    expect(() => connectionRequest('opencode', 'save', cursor)).toThrow()
    for (const invalid of [{ ...input, model: [] }, { ...input, protocol: [] }, { ...input, expected_revision: -1 },
      { ...input, base_url: 'http://remote.example' }, { ...input, base_url: 'https://example/api?key=secret' },
      { ...input, protocol: 'responses' }, { ...input, unexpected: true }]) {
      expect(() => connectionRequest('claude', 'save', invalid)).toThrow('PROVIDER_CONNECTION_INVALID')
    }
    expect(() => connectionRequest('cursor' as 'claude', 'save', input)).toThrow('PROVIDER_CONNECTION_INVALID')
    expect(() => connectionRequest('claude', 'check', input)).toThrow('PROVIDER_CONNECTION_INVALID')
    expect(connectionRequest('claude', 'save', { ...input, model: null })).toEqual({ ...input, model: null })
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
