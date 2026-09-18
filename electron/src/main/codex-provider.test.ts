import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'
import { parseCodexProviderConfiguration, parseCodexProviderTestResult, validateCodexProviderInput } from '../shared/codex-provider'

const fakeKey = 'synthetic-provider-key'
const input = { base_url: 'https://gateway.example/v1', model: 'gpt-6-astra', api_key: fakeKey }
const config = { available: true, configured: true, base_url: input.base_url, model: input.model, has_api_key: true, wire_api: 'responses' }
const empty = { ...config, configured: false, base_url: null, model: null, has_api_key: false }

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

describe('Codex custom provider native transport', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('uses exact operator routes, strips secret-bearing response fields, never uses generic fetch', async () => {
    const calls: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    const fetch = vi.fn(() => { throw new Error('browser fetch forbidden') }); vi.stubGlobal('fetch', fetch)
    await withServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part))
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.end(JSON.stringify(req.url?.endsWith('/test') ? { ok: true, status: 'ready', message: fakeKey, api_key: fakeKey }
        : { ...(req.method === 'DELETE' ? empty : config), api_key: fakeKey }))
    }, async url => {
      const client = new AgentServerClient(`${url}/mount`, 'synthetic-admin')
      try {
        expect(await client.codexProvider()).toEqual(config)
        expect(await client.testCodexProvider(input)).toEqual({ ok: true, status: 'ready', message: '' })
        expect(await client.setCodexProvider(input)).toEqual(config)
        expect(await client.resetCodexProvider()).toEqual(empty)
      } finally { client.dispose() }
    })
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', '/mount/api/admin/codex/provider'], ['POST', '/mount/api/admin/codex/provider/test'],
      ['PUT', '/mount/api/admin/codex/provider'], ['DELETE', '/mount/api/admin/codex/provider']
    ])
    expect(JSON.parse(calls[1].body)).toEqual(input)
    expect(JSON.parse(calls[2].body)).toEqual(input)
    expect(calls[0].body).toBe(''); expect(calls[3].body).toBe('')
    for (const call of calls) {
      expect(call.headers['x-agentsdock-token']).toBe('synthetic-admin')
      for (const header of ['origin', 'cookie', 'sec-fetch-mode', 'authorization']) expect(call.headers[header]).toBeUndefined()
      expect(call.url).not.toContain(fakeKey)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([[400, 'INVALID'], [401, 'ADMIN'], [403, 'ADMIN'], [404, 'UPDATE'], [405, 'UPDATE'], [409, 'BUSY'], [413, 'INVALID'], [422, 'INVALID'], [500, 'FAILED'], [501, 'UPDATE']])(
    'maps HTTP %s without echoing credentials or retrying', async (status, code) => {
      let calls = 0
      await withServer((_req, res) => { calls++; res.statusCode = Number(status); res.end(JSON.stringify({ detail: fakeKey })) }, async url => {
        const client = new AgentServerClient(url, 'synthetic-admin')
        try { await expect(client.testCodexProvider(input)).rejects.toThrow(`CODEX_PROVIDER_${code}`) }
        finally { client.dispose() }
      })
      expect(calls).toBe(1)
    }
  )
  it('never forwards credentials across an HTTP redirect', async () => {
    let forwarded = 0
    await withServer((_req, res) => { forwarded++; res.end(JSON.stringify(config)) }, async destination => {
      await withServer((_req, res) => { res.writeHead(307, { Location: destination }); res.end() }, async url => {
        const client = new AgentServerClient(url, 'synthetic-admin')
        try { await expect(client.setCodexProvider(input)).rejects.toThrow('CODEX_PROVIDER_FAILED') }
        finally { client.dispose() }
      })
    })
    expect(forwarded).toBe(0)
  })
  it.each(['file:///secrets', 'http://gateway.example/v1', 'https://user:password@example.com/v1',
    'https://example.com/v1?key=secret', 'https://example.com/v1#key', 'https://example.com/v1/responses',
    'https://example.com/v1/chat/completions', 'https://example.com\\evil', 'not-url'])('rejects unsafe or operation URL %s before transport', base_url => {
    expect(() => validateCodexProviderInput({ ...input, base_url })).toThrow('CODEX_PROVIDER_INVALID')
  })
  it('normalizes only safe input and preserves the exact model ID', () => {
    expect(validateCodexProviderInput({ ...input, base_url: ' https://gateway.example/v1/ ', api_key: ` ${fakeKey} ` })).toEqual(input)
    expect(validateCodexProviderInput({ ...input, base_url: 'http://localhost:8080/v1' }).base_url).toBe('http://localhost:8080/v1')
    expect(validateCodexProviderInput({ ...input, model: 'openai/openai/gpt-6-astra' }).model).toBe('openai/openai/gpt-6-astra')
  })
  it('rejects inconsistent successful or malformed provider results', () => {
    for (const value of [null, [], { ok: true, status: 'failed' }, { ok: false, status: 'ready' }, { ok: true, status: ['ready'] }]) {
      expect(() => parseCodexProviderTestResult(value)).toThrow('CODEX_PROVIDER_RESPONSE')
    }
    for (const value of [null, [], { ...config, wire_api: 'chat' }, { ...empty, has_api_key: true }, { ...config, base_url: 'https://user:secret@example.com' }]) {
      expect(() => parseCodexProviderConfiguration(value)).toThrow('CODEX_PROVIDER_RESPONSE')
    }
  })
})
