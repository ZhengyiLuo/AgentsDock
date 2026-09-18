import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'
import { parseCodexAuthStatus, validateCodexApiKey } from '../shared/codex-auth'

const account = { available: true, auth_mode: 'apiKey', email: null, plan_type: null, requires_openai_auth: true }
const fakeKey = 'synthetic-key-not-a-real-credential'

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

describe('native Codex account transport', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('passes the key only to the exact native operator route, without browser headers or generic fetch', async () => {
    const calls: Array<{ method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }> = []
    const fetch = vi.fn(() => { throw Error('generic fetch forbidden') })
    vi.stubGlobal('fetch', fetch)
    await withServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.end(JSON.stringify({ ...account, api_key: fakeKey, message: fakeKey }))
    }, async url => {
      const client = new AgentServerClient(`${url}/mounted`, 'synthetic-admin-token')
      try {
        expect(await client.codexAuth()).toEqual(account)
        expect(await client.codexLoginWithApiKey(` ${fakeKey} `)).toEqual(account)
      } finally { client.dispose() }
    })
    expect(calls.map(item => [item.method, item.url])).toEqual([
      ['GET', '/mounted/api/admin/codex/auth'], ['POST', '/mounted/api/admin/codex/auth/api-key']
    ])
    expect(calls[0].body).toBe('')
    expect(JSON.parse(calls[1].body)).toEqual({ api_key: fakeKey })
    for (const call of calls) {
      expect(call.headers['x-agentsdock-token']).toBe('synthetic-admin-token')
      for (const header of ['origin', 'cookie', 'sec-fetch-mode', 'authorization']) expect(call.headers[header]).toBeUndefined()
      expect(call.url).not.toContain(fakeKey)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([[400, 'INVALID_KEY'], [401, 'ADMIN'], [403, 'ADMIN'], [404, 'UPDATE'], [405, 'UPDATE'],
    [409, 'BUSY'], [422, 'INVALID_KEY'], [500, 'FAILED'], [501, 'UPDATE'], [502, 'FAILED']])(
    'sanitizes HTTP %s including echoed secrets and does not retry', async (status, code) => {
      let count = 0
      await withServer((_req, res) => { count++; res.statusCode = Number(status); res.end(JSON.stringify({ detail: fakeKey })) }, async url => {
        const client = new AgentServerClient(url, 'synthetic-token')
        try {
          await expect(client.codexLoginWithApiKey(fakeKey)).rejects.toThrow(`CODEX_AUTH_${code}`)
        } finally { client.dispose() }
      })
      expect(count).toBe(1)
    }
  )

  it('never follows a redirect with the secret', async () => {
    let destinationCalls = 0
    await withServer((_req, res) => { destinationCalls++; res.end(JSON.stringify(account)) }, async destination => {
      await withServer((_req, res) => { res.writeHead(307, { Location: destination }); res.end() }, async url => {
        const client = new AgentServerClient(url, 'synthetic-token')
        try { await expect(client.codexLoginWithApiKey(fakeKey)).rejects.toThrow('CODEX_AUTH_FAILED') }
        finally { client.dispose() }
      })
    })
    expect(destinationCalls).toBe(0)
  })

  it('does not forward malformed provider data or account secrets', () => {
    expect(parseCodexAuthStatus({ ...account, email: fakeKey, plan_type: fakeKey, token: fakeKey })).toEqual(account)
    for (const value of [null, [], { ...account, auth_mode: fakeKey }, { ...account, auth_mode: ['apiKey'] }, { ...account, available: 1 }]) {
      expect(() => parseCodexAuthStatus(value)).toThrow('CODEX_AUTH_RESPONSE')
    }
  })

  it.each([null, undefined, 42, {}, '', ' ', 'one\ntwo', 'one\u0000two', 'x'.repeat(4097)])(
    'rejects malformed input without echoing it', value => {
      expect(() => validateCodexApiKey(value)).toThrow('CODEX_AUTH_INVALID_KEY')
    }
  )
})
