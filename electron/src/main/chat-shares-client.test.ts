import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AgentServerClient } from './server-client'

async function localTransport(handler: (request: IncomingMessage, response: ServerResponse) => void, test: (client: AgentServerClient) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-admin-credential')
  try { await test(client) } finally { client.dispose(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}

describe('native chat-share management client', () => {
  it('defaults either mode to the selected native HTTP origin and ignores unknown URL fields', async () => {
    const bodies: Record<string, unknown>[] = []
    await localTransport((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const value = JSON.parse(body)
        bodies.push(value)
        expect(value.base_url).toBe(`http://${request.headers.host}`)
        const interactive = request.url?.includes('interactive-chat-shares')
        const id = `interactive_${'a'.repeat(32)}`
        const share_id = `share_${'c'.repeat(32)}`
        const access_token = 'b'.repeat(43)
        const path = interactive ? `/interactive-chat/${id}` : `/shared-chat/${share_id}`
        response.writeHead(201, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id, share_id, title: 'Example', created_at: 1, access_token,
          expires_at: null, revoked_at: null, path, url: `${value.base_url}${path}`,
          ...(interactive ? {} : { token_url: `${value.base_url}/share/${access_token}` }) }))
      })
    }, async client => {
      client.configure(`${client.url('')}/api/health`, 'synthetic-admin-credential')
      const view = await client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true,
        title: 'Example', url: 'http://untrusted.example.test', token: 'ignored' } as never)
      expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/shared-chat\/share_[a-f0-9]{32}$/)
      expect(view.access_token).toBe('b'.repeat(43))
      expect(view.token_url).toBe(`${new URL(client.url('')).origin}/share/${view.access_token}`)
      const interactive = await client.createChatShare('qa-chat', { mode: 'interactive', confirmed_interactive: true,
        url: 'https://untrusted.example.test' } as never)
      expect(interactive.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/interactive-chat\/interactive_[a-f0-9]{32}$/)
      expect(interactive.access_token).toBe('b'.repeat(43))
      expect(interactive).not.toHaveProperty('token_url')
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual({ confirmed_public: true, title: 'Example', base_url: expect.any(String) })
    expect(bodies[1]).toEqual({ confirmed_interactive: true, base_url: expect.any(String) })
  })
  it('uses the chosen share origin only as body data and never sends admin credentials or probes there', async () => {
    let alternateRequests = 0
    const alternate = createServer((_request, response) => {
      alternateRequests++; response.writeHead(500); response.end()
    })
    await new Promise<void>(resolve => alternate.listen(0, '127.0.0.1', resolve))
    const address = `http://127.0.0.1:${(alternate.address() as AddressInfo).port}`
    const bodies: Record<string, unknown>[] = []
    try {
      await localTransport((request, response) => {
        let raw = ''
        request.on('data', chunk => { raw += chunk })
        request.on('end', () => {
          const body = JSON.parse(raw)
          bodies.push(body)
          expect(`http://${request.headers.host}`).not.toBe(address)
          expect(request.headers['x-agentsdock-token']).toBe('synthetic-admin-credential')
          expect(request.url).toMatch(/^\/api\/admin\/(interactive-chat-shares|chat-shares)\/qa-chat$/)
          const interactive = request.url!.includes('interactive-chat-shares')
          const id = `${interactive ? 'interactive' : 'share'}_${'a'.repeat(32)}`
          const path = `/${interactive ? 'interactive-chat' : 'shared-chat'}/${id}`
          response.writeHead(201, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ id, share_id: id, title: 'Example', created_at: 1,
            expires_at: null, revoked_at: null, path, url: `${address}${path}`, access_token: 'b'.repeat(43) }))
        })
      }, async client => {
        const view = await client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true, base_url: address + '/' })
        const interactive = await client.createChatShare('qa-chat', { mode: 'interactive', confirmed_interactive: true, base_url: address })
        expect(new URL(view.url!).origin).toBe(address)
        expect(new URL(interactive.url!).origin).toBe(address)
      })
      expect(bodies).toEqual([{ confirmed_public: true, base_url: address }, { confirmed_interactive: true, base_url: address }])
      expect(alternateRequests).toBe(0)
    } finally {
      await new Promise<void>(resolve => { alternate.close(() => resolve()); alternate.closeAllConnections() })
    }
  })
  it('rejects invalid addresses before sending a create request', async () => {
    let requests = 0
    await localTransport((_request, response) => { requests++; response.writeHead(500); response.end() }, async client => {
      for (const base_url of ['http://secret@192.0.2.4:7850', 'http://192.0.2.4:7850/path', 'http://192.0.2.4:7850?token=secret']) {
        await expect(client.createChatShare('qa-chat', { mode: 'interactive', confirmed_interactive: true, base_url })).rejects.toThrow('Enter an HTTP')
      }
      expect(requests).toBe(0)
    })
  })
  it('rejects a response at a different origin without retrying or exposing its token', async () => {
    let requests = 0
    const token = 's'.repeat(43)
    await localTransport((_request, response) => {
      requests++
      const id = `interactive_${'c'.repeat(32)}`
      const path = `/interactive-chat/${id}`
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id, title: 'Example', created_at: 1, expires_at: null, revoked_at: null,
        path, url: `http://192.0.2.9:7850${path}`, access_token: token }))
    }, async client => {
      const result = client.createChatShare('qa-chat', { mode: 'interactive', confirmed_interactive: true, base_url: 'http://192.0.2.4:7850' })
      await expect(result).rejects.toThrow('did not confirm the selected share address')
      await expect(result).rejects.not.toThrow(token)
      expect(requests).toBe(1)
    })
  })
  it('requires a hosted URL for an explicitly chosen address, while preserving legacy omitted-address handling', async () => {
    let requests = 0
    await localTransport((_request, response) => {
      requests++
      const id = `share_${'c'.repeat(32)}`
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ share_id: id, title: 'Example', created_at: 1, expires_at: null, revoked_at: null,
        path: `/shared-chat/${id}`, url: null, access_token: 's'.repeat(43) }))
    }, async client => {
      await expect(client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true,
        base_url: 'http://192.0.2.4:7850' })).rejects.toThrow('did not confirm the selected share address')
      expect(requests).toBe(1)
      const legacy = await client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true })
      expect(legacy.url).toBeNull()
      expect(requests).toBe(2)
    })
  })
  it('uses exact admin routes with no browser headers or URL credentials on actual native HTTP', async () => {
    const responses = [
      { messages: [{ role: 'user', text: 'Synthetic preview' }], digest: 'a'.repeat(64), through_bytes: 12, warning: 'Synthetic privacy warning' },
      { share_id: `share_${'c'.repeat(32)}`, title: 'QA', created_at: 1, expires_at: null, revoked_at: null,
        message_count: 1, path: `/shared-chat/share_${'c'.repeat(32)}`, url: null, access_token: 'b'.repeat(43) },
      { shares: [] }, { revoked: true }
    ]
    const requests: IncomingMessage[] = []
    await localTransport((request, response) => {
      requests.push(request); response.statusCode = requests.length === 2 ? 201 : 200
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(responses.shift()))
    }, async client => {
      const preview = await client.previewChatShare('qa-chat')
      await client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true, digest: preview.digest, through_bytes: preview.through_bytes })
      await client.listChatShares('qa-chat', 'interactive')
      await client.revokeChatShare('qa-chat', 'snapshot', 'share_qa')
    })
    expect(requests.map(request => request.url)).toEqual([
      '/api/admin/chat-shares/qa-chat/preview', '/api/admin/chat-shares/qa-chat',
      '/api/admin/interactive-chat-shares/qa-chat', '/api/admin/chat-shares/qa-chat/share_qa'
    ])
    for (const request of requests) {
      expect(request.headers['x-agentsdock-token']).toBe('synthetic-admin-credential')
      expect(Object.keys(request.headers).filter(key => key.startsWith('sec-fetch-') || ['origin', 'cookie', 'authorization'].includes(key))).toEqual([])
    }
  })
  it('does not replay ambiguous creation or admit malformed identities', async () => {
    let requests = 0
    await localTransport((request) => { requests++; request.socket.destroy() }, async client => {
      await expect(client.createChatShare('qa-chat', { mode: 'interactive', confirmed_interactive: true })).rejects.toThrow()
      expect(requests).toBe(1)
      await expect(client.listChatShares('../other-chat', 'snapshot')).rejects.toThrow()
      expect(requests).toBe(1)
    })
  })
  it('rejects an old server bearer-link response without retrying or exposing its token', async () => {
    let requests = 0
    const token = 'z'.repeat(43)
    await localTransport((_request, response) => {
      requests++
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ share_id: `share_${'c'.repeat(32)}`, title: 'Legacy', created_at: 1,
        expires_at: null, revoked_at: null, path: `/share/${token}`, url: `http://share.example.test/share/${token}` }))
    }, async client => {
      const result = client.createChatShare('qa-chat', { mode: 'snapshot', confirmed_public: true })
      await expect(result).rejects.toThrow('Update the server')
      await expect(result).rejects.not.toThrow(token)
      expect(requests).toBe(1)
    })
  })
  it('rejects redirects without visiting their target', async () => {
    let requests = 0
    await localTransport((_request, response) => { requests++; response.writeHead(302, { Location: '/other' }); response.end() }, async client => {
      await expect(client.listChatShares('qa-chat', 'snapshot')).rejects.toThrow(/redirect/i)
      expect(requests).toBe(1)
    })
  })
})
