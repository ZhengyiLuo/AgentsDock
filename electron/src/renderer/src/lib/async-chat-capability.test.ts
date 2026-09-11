import { describe, expect, it } from 'vitest'
import type { CrossChatHandoffsCapability, Event, Health } from '@shared/types'
import { crossChatQueueRefreshSessionId, interactiveClientCapabilities } from '../store/app-store'
import { ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY, asyncChatRouteAvailable } from './chat-references'

const capability = (): CrossChatHandoffsCapability => ({
  available: true, required: false, message: '', action: null, version: 10,
  features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false, async_route_v1: true },
  agent_routes: { client_capability: 'agent_cross_chat_routes_v2', policy: 'default_deny',
    async_route_v1: { available: true, client_capability: ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY, mode: 'async_route_v1' } }
})

describe('async route capability negotiation', () => {
  it('advertises the new mode only when the server confirms the exact contract', () => {
    const health: Health = { ok: true, capabilities: { cross_chat_handoffs_v1: capability() } }
    expect(asyncChatRouteAvailable(health)).toBe(true)
    expect(interactiveClientCapabilities(undefined, health)).toContain(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY)
    expect(interactiveClientCapabilities(undefined, null)).not.toContain(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY)
    for (const patch of [
      { available: false },
      { features: { ...capability().features, async_route_v1: false } },
      { agent_routes: { ...capability().agent_routes, async_route_v1: undefined } },
      { agent_routes: { ...capability().agent_routes, async_route_v1: { available: true, client_capability: 'future-mode', mode: 'async_route_v1' as const } } }
    ]) {
      const incompatible: Health = { ok: true, capabilities: { cross_chat_handoffs_v1: { ...capability(), ...patch } } }
      expect(asyncChatRouteAvailable(incompatible)).toBe(false)
      expect(interactiveClientCapabilities(undefined, incompatible)).not.toContain(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY)
    }
  })

  it('uses existing targeted queue refresh on the recipient lifecycle only', () => {
    const event: Event = {
      id: 'event', seq: 1, ts: '2026-09-10T10:00:00Z', session_id: 'recipient',
      type: 'chat_conversation_message_queued', conversation_mode: 'async_route_v1',
      source_session_id: 'sender', target_session_id: 'recipient', queued_id: 'queued-a'
    }
    expect(crossChatQueueRefreshSessionId(event)).toBe('recipient')
    expect(crossChatQueueRefreshSessionId({ ...event, type: 'chat_conversation_message_started' })).toBe('recipient')
    expect(crossChatQueueRefreshSessionId({ ...event, session_id: 'sender' })).toBeNull()
    expect(crossChatQueueRefreshSessionId({ ...event, conversation_mode: undefined })).toBeNull()
    expect(crossChatQueueRefreshSessionId({ ...event, queued_id: undefined })).toBeNull()
  })
})
