import { describe, expect, it, vi } from 'vitest'
import { TeamHubClient } from './team-hub-client'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const now = '2026-08-24T12:00:00Z'
const later = '2026-08-24T13:00:00Z'
const human = { kind: 'human', id: 'human-1', display_name: 'Owner' }
const server = { kind: 'server', id: 'server-1', server_identity: 'identity-1', display_name: 'Studio' }
const baseItem = {
  id: 'item-1', sequence: 1, kind: 'message', from: human, to: server,
  body_format: 'markdown', body: 'Hello', request_id: null, created_at: now, expires_at: null
}
const available = { id: 'delivery-1', state: 'available', available_at: now, delivered_at: null, read_at: null }

describe('TeamHubClient Team Network V1', () => {
  it('renames only the authenticated server profile with no selectable target on the wire', async () => {
    const server = { id: 'node-1', server_identity: 'identity-1', display_name: 'New name' }
    const fetch = vi.fn().mockResolvedValue(json({ server }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.renameNetworkServer('access', 'team/one', 'New name')).resolves.toEqual({ server })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:7850/api/team-hub/v1/teams/team%2Fone/network/server-profile')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ display_name: 'New name' })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access')
    expect(init.redirect).toBe('error')
  })

  it('rejects unsupported or widened rename responses without retry', async () => {
    for (const response of [new Response(JSON.stringify({ error: { code: 'not_found', message: 'Unavailable' } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }), json({ server: {
      id: 'node-1', server_identity: 'identity-1', display_name: 'New name', owned_by_caller: true
    } })]) {
      const fetch = vi.fn().mockResolvedValue(response)
      const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
      await expect(client.renameNetworkServer('access', 'team-1', 'New name')).rejects.toThrow()
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('parses the capability gate from health', async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      ok: true, service: 'agentsdock-team-hub', api_version: 1, hub_id: 'hub-1', instance_id: 'instance-1',
      bootstrapped: true, bootstrap_required: false,
      capabilities: { team_network_v1: {
        available: true, version: 1, logical_servers: true, agent_registry: true,
        bulletin: true, mailbox: true, delivery_receipts: ['delivered', 'read'], passive_requests: true,
        server_invites: false, skill_attachments: false, dispatch: false,
        max_agents_per_server: 256, max_page_items: 100, max_body_bytes: 8_192
      } }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.health()).resolves.toMatchObject({
      capabilities: { team_network_v1: {
        available: true, dispatch: false, skill_attachments: false, max_agents_per_server: 256
      } }
    })
  })

  it('uses only the frozen projection, agent, Bulletin, mailbox, receipt, and request routes', async () => {
    const requestItem = {
      ...baseItem, id: 'request-1', sequence: 2, kind: 'request', request_id: 'request-1',
      body: 'Please reply', expires_at: later
    }
    const replyItem = {
      ...baseItem, id: 'reply-1', sequence: 3, kind: 'reply', from: server, to: human,
      body: 'Done', request_id: 'request-1'
    }
    const openRequest = { id: 'request-1', status: 'open', expires_at: later, reply_item_id: null }
    const repliedRequest = { ...openRequest, status: 'replied', reply_item_id: 'reply-1' }
    const bulletinPost = {
      id: 'post-1', sequence: 1, author: { kind: 'human', id: 'human-1', display_name: 'Owner' },
      body_format: 'markdown', body: 'Update', thread_root_post_id: null, reply_to_post_id: null, created_at: now
    }
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init.method ?? 'GET'
      if (url.pathname.endsWith('/network') && method === 'GET') return json({
        network: { id: 'team/one', display_name: 'Studio', hub_id: 'hub-1' },
        servers: [{ id: 'server-1', server_identity: 'identity-1', display_name: 'Studio', status: 'active', is_host: true, owned_by_caller: true }],
        agents: [],
        next_after_server_id: 'server-1',
        has_more: true
      })
      if (url.pathname.endsWith('/network/agents')) return json({
        agent: { id: 'agent-1', server_id: 'server-1', external_agent_id: 'chat-1', backend: 'codex', display_name: 'Georgia', status: 'active' }
      })
      if (url.pathname.endsWith('/network/bulletin')) return method === 'POST'
        ? json({ post: bulletinPost })
        : json({ posts: [bulletinPost], next_after_sequence: 1, has_more: false })
      if (url.pathname.endsWith('/network/mailbox')) return method === 'POST'
        ? json({ item: baseItem, delivery: available })
        : json({ items: [{ item: baseItem, delivery: available }], next_after_sequence: 1, has_more: false })
      if (url.pathname.endsWith('/network/items/item-1')) return json({ item: baseItem, delivery: available })
      if (url.pathname.endsWith('/network/deliveries/delivery-1/receipts')) return json({
        delivery: { ...available, state: 'delivered', delivered_at: now }
      })
      if (url.pathname.endsWith('/network/requests')) return json({ item: requestItem, delivery: available, request: openRequest })
      if (url.pathname.endsWith('/network/requests/request-1/replies')) return json({ item: replyItem, delivery: available, request: repliedRequest })
      if (url.pathname.endsWith('/network/requests/request-1')) return json({
        item: requestItem, delivery: available, request: openRequest, reply: null
      })
      throw new Error('unexpected route ' + method + ' ' + url.pathname)
    })
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await client.network('access', 'team/one', 'server/before', 25)
    await client.registerNetworkAgent('access', 'team/one', {
      external_agent_id: 'chat-1', backend: 'codex', display_name: 'Georgia', idempotency_key: 'agent-key'
    })
    await client.networkBulletin('access', 'team/one', 0, 50)
    await client.postNetworkBulletin('access', 'team/one', {
      body: 'Update', body_format: 'markdown', idempotency_key: 'post-key'
    })
    await client.networkMailbox('access', 'team/one', { kind: 'human', id: 'human-1' }, 0, 50)
    await client.sendNetworkMailbox('access', 'team/one', {
      to: { kind: 'server', id: 'server-1' }, body: 'Hello', body_format: 'markdown', idempotency_key: 'mail-key'
    })
    await client.networkItem('access', 'team/one', 'item-1')
    await client.recordNetworkDeliveryReceipt('access', 'team/one', 'delivery-1', {
      state: 'delivered', idempotency_key: 'receipt-key'
    })
    await client.createNetworkPassiveRequest('access', 'team/one', {
      to: { kind: 'server', id: 'server-1' }, body: 'Please reply', body_format: 'markdown',
      idempotency_key: 'request-key', expires_in_seconds: 3600
    })
    await client.networkPassiveRequest('access', 'team/one', 'request-1')
    await client.replyNetworkPassiveRequest('access', 'team/one', 'request-1', {
      body: 'Done', body_format: 'markdown', idempotency_key: 'reply-key'
    })

    const calls = fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }))
    expect(calls[0].url).toContain('/v1/teams/team%2Fone/network?limit=25&after_server_id=server%2Fbefore')
    expect(calls[2].url).toContain('after_sequence=0&limit=50')
    expect(calls[4].url).toContain('address_kind=human&address_id=human-1&after_sequence=0&limit=50')
    expect(calls[5].body).toEqual({
      to: { kind: 'server', id: 'server-1' }, body: 'Hello', body_format: 'markdown', idempotency_key: 'mail-key'
    })
    expect(calls[8].body).toEqual({
      to: { kind: 'server', id: 'server-1' }, body: 'Please reply', body_format: 'markdown',
      idempotency_key: 'request-key', expires_in_seconds: 3600
    })
    expect(JSON.stringify(calls)).not.toMatch(/dispatch|attachment|channel/)
  })
})
