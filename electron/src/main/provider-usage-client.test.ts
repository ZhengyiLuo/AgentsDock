import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AgentServerClient } from './server-client'

describe('provider usage native HTTP', () => {
  it('uses the authenticated native transport and preserves selected-chat routing', async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, unknown> }> = []
    const server = createServer((request, response) => {
      requests.push({ url: request.url!, method: request.method!, headers: request.headers })
      const browser = Object.keys(request.headers).some(key => key === 'origin' || key === 'cookie' || key.startsWith('sec-fetch-'))
      response.writeHead(browser ? 403 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ backend: 'codex', status: 'unavailable', source: null, account_kind: 'custom', observed_at: null, windows: [] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-token')
    try {
      await expect(client.providerUsage('codex', 'chat_custom', true)).resolves.toMatchObject({ account_kind: 'custom', status: 'unavailable' })
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe('/api/runtime/usage?backend=codex&session_id=chat_custom&refresh=true')
      expect(requests[0].method).toBe('GET')
      expect(requests[0].headers['x-agentsdock-token']).toBe('synthetic-token')
      expect(Object.keys(requests[0].headers).filter(key => key.startsWith('sec-fetch-'))).toEqual([])
      await expect(client.providerUsage('claude', 'chat_custom')).rejects.toThrow('Invalid provider usage response')
    } finally {
      client.dispose()
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  })
})
