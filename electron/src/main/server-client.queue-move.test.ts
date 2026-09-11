import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentServerClient } from './server-client'

describe('AgentServerClient exact queue movement', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the exact adjacent identity and keeps the later authoritative list order', async () => {
    const queue = [
      { queued_id: 'delivery', purpose: 'cross_chat_handoff_delivery', prompt: 'Authenticated', file_ids: [], position: 1 },
      { queued_id: 'user', prompt: 'User', file_ids: [], position: 2 }
    ]
    const fetch = vi.fn(async (_input: unknown, init: RequestInit = {}) => new Response(JSON.stringify(
      init.method === 'POST'
        ? { positions: [{ queued_id: 'delivery', position: 2 }, { queued_id: 'user', position: 1 }] }
        : { session: { id: 'chat' }, events: [], queued_turns: queue }
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    expect(await client.moveQueued('chat', 'delivery', 'up', 'user')).toEqual(queue)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ direction: 'up', expected_adjacent_queued_id: 'user' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps old-server user-only move payloads compatible', async () => {
    const fetch = vi.fn(async (_input: unknown, _init: RequestInit = {}) => new Response(JSON.stringify({ session: { id: 'chat' }, events: [], queued_turns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    await client.moveQueued('chat', 'user', 'down')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ direction: 'down' })
  })

  it('does not retry or fetch a fabricated success after a rejected exact-neighbor move', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: 'Queue neighbor changed' }), { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    await expect(client.moveQueued('chat', 'delivery', 'up', 'user')).rejects.toThrow('Queue neighbor changed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
