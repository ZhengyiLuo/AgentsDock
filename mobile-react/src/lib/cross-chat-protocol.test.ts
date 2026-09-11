import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCrossChatRoute, ChatReference, Event, Health, QueuedTurn } from '../types'
import { agentRouteCapacityError, isAgentRouteRevisionConflict } from './agent-route-policy'
import { ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY, asyncChatRouteAvailable, interactiveClientCapabilities } from './chat-references'
import { crossChatQueueRefreshSessionId, isVisibleQueuedTurn, queuedDeliverySkipIdentity, updateQueuedTurns } from './queue'
import { sanitizeTimelineEvent } from './timeline-memory'

const capability = {
  available: true, version: 10, actions: ['route' as const, 'instruction' as const],
  features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false, async_route_v1: true, exact_queued_delivery_skip: true, exact_queued_peer_delivery_skip: true },
  agent_routes: { policy: 'default_deny' as const, client_capability: 'agent_cross_chat_routes_v2', async_route_v1: { available: true, mode: 'async_route_v1' as const, client_capability: ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY } },
}
const health: Health = { ok: true, capabilities: { cross_chat_handoffs_v1: capability } }
const event: Event = { id: 'event', seq: 1, session_id: 'target', target_session_id: 'target', type: 'chat_conversation_message_queued', ts: '2026-09-11T00:00:00Z', queued_id: 'queued', conversation_mode: 'async_route_v1', conversation_id: 'conversation', message_id: 'message', cross_chat_envelope_id: 'message' }

await test('async negotiation requires every exact durable-route and mode discriminator', () => {
  assert.equal(asyncChatRouteAvailable(health), true)
  assert(interactiveClientCapabilities({ backend: 'codex' }, health).includes(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY))
  const invalid = [
    { ...capability, available: false }, { ...capability, version: 6 }, { ...capability, version: NaN },
    { ...capability, features: { ...capability.features, durable_route_grants: false } },
    { ...capability, features: { ...capability.features, agent_ambient_local_handoffs: true } },
    { ...capability, features: { ...capability.features, async_route_v1: false } },
    { ...capability, agent_routes: { ...capability.agent_routes, policy: 'automatic' } },
    { ...capability, agent_routes: { ...capability.agent_routes, async_route_v1: undefined } },
    ...['available', 'mode', 'client_capability'].map(field => ({ ...capability, agent_routes: { ...capability.agent_routes, async_route_v1: { ...capability.agent_routes.async_route_v1, [field]: undefined } } })),
  ]
  for (const value of invalid) {
    const candidate = { ok: true, capabilities: { cross_chat_handoffs_v1: value } } as Health
    assert.equal(asyncChatRouteAvailable(candidate), false)
    assert(!interactiveClientCapabilities({ backend: 'codex' }, candidate).includes(ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY))
  }
})

await test('queue and cache preserve exact async identities without reconstructing authority', () => {
  const restored = JSON.parse(JSON.stringify(sanitizeTimelineEvent(event))) as Event
  assert.equal(restored.conversation_mode, 'async_route_v1')
  assert.equal(restored.conversation_id, 'conversation')
  assert.equal(restored.message_id, 'message')
  const queued = updateQueuedTurns([], { ...event, type: 'turn_queued', purpose: 'cross_chat_handoff_delivery', source_title: 'Sender' })[0]
  assert.equal(queued.conversation_mode, 'async_route_v1')
  assert.equal(queued.cross_chat_envelope_id, 'message')
  assert.equal(queued.source_title, 'Sender')
  assert.equal(isVisibleQueuedTurn(queued), true)
  assert.equal(isVisibleQueuedTurn({ ...queued, conversation_mode: undefined }), false)
  assert.equal(isVisibleQueuedTurn({ ...queued, purpose: 'secure_peer_handoff_delivery' }), false)
  assert.equal(queued.chat_references, undefined)
})

await test('public lifecycle refreshes only the exact receiving chat queue', () => {
  assert.equal(crossChatQueueRefreshSessionId(event), 'target')
  assert.equal(crossChatQueueRefreshSessionId({ ...event, session_id: 'source' }), null)
  assert.equal(crossChatQueueRefreshSessionId({ ...event, conversation_mode: undefined }), null)
  assert.equal(crossChatQueueRefreshSessionId({ ...event, type: 'chat_conversation_message_future' }), null)
  assert.equal(crossChatQueueRefreshSessionId({ ...event, type: 'cross_chat_handoff_started' }), 'target')
  assert.equal(crossChatQueueRefreshSessionId({ ...event, queued_id: null }), null)
})

await test('skip requires an advertised exact owner and refuses promoted or malformed deliveries', () => {
  const queued: QueuedTurn = { queued_id: 'queued', prompt: 'Message', file_ids: [], purpose: 'cross_chat_handoff_delivery', cross_chat_envelope_id: 'envelope' }
  assert.deepEqual(queuedDeliverySkipIdentity(queued, health), { cross_chat_envelope_id: 'envelope', cross_chat_exchange_id: null, cross_chat_exchange_leg_id: null })
  const legacy = { ...queued, cross_chat_envelope_id: null, cross_chat_exchange_id: 'exchange', cross_chat_exchange_leg_id: 'leg' }
  assert(queuedDeliverySkipIdentity(legacy, health))
  for (const patch of [{ promoted: true }, { queued_id: '' }, { purpose: 'scheduled_job' }, { cross_chat_envelope_id: '' }]) assert.equal(queuedDeliverySkipIdentity({ ...queued, ...patch }, health), null)
  assert.equal(queuedDeliverySkipIdentity({ ...legacy, cross_chat_exchange_leg_id: null }, health), null)
  assert.equal(queuedDeliverySkipIdentity(queued, { ...health, capabilities: { cross_chat_handoffs_v1: { ...capability, version: 8 } } }), null)
  assert.equal(queuedDeliverySkipIdentity(queued, { ...health, capabilities: { cross_chat_handoffs_v1: { ...capability, available: false } } }), null)
  const peer = { ...queued, purpose: 'secure_peer_handoff_delivery', secure_peer_envelope_id: 'peer' }
  assert.deepEqual(queuedDeliverySkipIdentity(peer, health), { secure_peer_envelope_id: 'peer' })
  assert.equal(queuedDeliverySkipIdentity(peer, { ...health, capabilities: { cross_chat_handoffs_v1: { ...capability, version: 9 } } }), null)
})

await test('capacity counts unique explicit new targets while revision conflicts remain exact', () => {
  const granted = { target_session_id: 'granted' } as AgentCrossChatRoute
  const reference = { session_id: 'new', action: 'route', grant_intent: true } as ChatReference
  assert.match(agentRouteCapacityError({ routes: [granted], max_routes: 1 }, [reference]) ?? '', /limit/u)
  assert.equal(agentRouteCapacityError({ routes: [granted], max_routes: 2 }, [reference, reference]), null)
  assert.equal(agentRouteCapacityError({ routes: [granted], max_routes: 1 }, [{ ...reference, session_id: 'granted' }]), null)
  assert.equal(agentRouteCapacityError({ routes: [granted], max_routes: 1 }, [{ ...reference, grant_intent: undefined }]), null)
  assert.equal(isAgentRouteRevisionConflict({ status: 409, detail: { code: 'route_revision_conflict' } }), true)
  assert.equal(isAgentRouteRevisionConflict({ status: 409, detail: 'route revision conflict' }), true)
  assert.equal(isAgentRouteRevisionConflict({ status: 409, detail: { code: 'other_conflict' } }), false)
})
