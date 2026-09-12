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
  it('uses exact admin routes with no browser headers or URL credentials on actual native HTTP', async () => {
    const responses = [
      { messages: [{ role: 'user', text: 'Synthetic preview' }], digest: 'a'.repeat(64), through_bytes: 12, warning: 'Synthetic privacy warning' },
      { share_id: 'share_qa', title: 'QA', created_at: 1, expires_at: null, revoked_at: null, message_count: 1, path: `/share/${'b'.repeat(43)}`, url: null },
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
  it('rejects redirects without visiting their target', async () => {
    let requests = 0
    await localTransport((_request, response) => { requests++; response.writeHead(302, { Location: '/other' }); response.end() }, async client => {
      await expect(client.listChatShares('qa-chat', 'snapshot')).rejects.toThrow(/redirect/i)
      expect(requests).toBe(1)
    })
  })
})
