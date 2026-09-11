import { describe, expect, it } from 'vitest'
import type { Health } from '@shared/types'
import {
  agentCrossChatRoutesAvailable,
  agentCrossChatRoutesSupported,
  atomicChatReferenceCaret,
  atomicChatReferenceDeletion,
  atomicChatReferenceNavigation,
  canonicalizeLocalRouteHints,
  chatMentionAction,
  chatMentionTrigger,
  chatReferenceDisplayText,
  chatReferenceText,
  currentRouteHintReference,
  defaultCrossChatAction,
  insertChatReference,
  insertSecurePeerChatReference,
  MAX_CHAT_REFERENCES,
  parseStoredChatReferences,
  reconcileChatReferences,
  routeHintMentionsAvailable,
  securePeerReferenceMatchesRoute,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences
} from './chat-references'
import type { SecurePeerRemoteRoute } from '@shared/secure-peer'

const secureRoute: SecurePeerRemoteRoute = {
  peerServerIdentity: 'server-studio',
  peerDisplayName: 'Studio',
  connectionId: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
  routeId: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
  revision: `rev_${'a'.repeat(32)}`,
  alias: 'training',
  displayTitle: 'Training agent',
  actions: ['instruction', 'request_reply']
}

describe('chat references', () => {
  it('separates durable route administration support from live turn authority', () => {
    const supportedButOffline: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: false, required: false, message: 'transport unavailable', action: null,
        version: 7,
        actions: ['route', 'instruction', 'request_reply'],
        features: {
          durable_route_grants: true,
          agent_cross_chat_routes: true,
          agent_ambient_local_handoffs: false
        },
        agent_routes: { client_capability: 'agent_cross_chat_routes_v2', policy: 'default_deny' }
      }
    } }
    expect(agentCrossChatRoutesSupported(supportedButOffline)).toBe(true)
    expect(agentCrossChatRoutesAvailable(supportedButOffline)).toBe(false)
    expect(agentCrossChatRoutesAvailable({
      ...supportedButOffline,
      capabilities: { cross_chat_handoffs_v1: { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, available: true } }
    })).toBe(true)

    for (const malformed of [
      { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, version: 6, available: true },
      { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, features: { durable_route_grants: false, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false }, available: true },
      { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, features: { agent_cross_chat_routes: false }, available: true },
      { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, agent_routes: { client_capability: 'wrong', policy: 'default_deny' as const }, available: true },
      { ...supportedButOffline.capabilities!.cross_chat_handoffs_v1!, agent_routes: { client_capability: 'agent_cross_chat_routes_v2' }, available: true }
    ]) {
      const health: Health = { ok: true, capabilities: { cross_chat_handoffs_v1: malformed } }
      expect(agentCrossChatRoutesSupported(health)).toBe(false)
      expect(agentCrossChatRoutesAvailable(health)).toBe(false)
    }

    const automaticV4: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null,
        version: 4,
        features: { agent_cross_chat_routes: false, agent_ambient_local_handoffs: true },
        ambient_local_handoffs: {
          enabled: true, policy: 'automatic', scope: 'all_same_server_chats', setup_required: false
        }
      }
    } }
    expect(agentCrossChatRoutesSupported(automaticV4)).toBe(false)
    expect(agentCrossChatRoutesAvailable(automaticV4)).toBe(false)
  })

  it('uses one @ route-hint syntax and treats /chat as an insertion alias at UTF-16 textarea offsets', () => {
    expect(chatMentionTrigger('Ask @Run 16', 11)).toEqual({ kind: '@', start: 4, end: 11, query: 'Run 16' })
    expect(chatMentionTrigger('Ask @@Run 16', 12)).toBeNull()
    expect(chatMentionTrigger('😀 /chat Training', 17)).toEqual({ kind: '/chat', start: 3, end: 17, query: 'Training' })
    expect(chatMentionTrigger('/chat/sess_abc123', 17)).toEqual({ kind: '/chat', start: 0, end: 17, query: 'sess_abc123' })
    expect(chatMentionTrigger('email@example.com', 17)).toBeNull()
    expect(chatMentionTrigger('bad@@target', 11)).toBeNull()
    expect(chatMentionAction({ kind: '@' })).toBe('route')
    expect(chatMentionAction({ kind: '/chat' })).toBe('route')
  })

  it('does not reopen a resolved mention while the user types the instruction', () => {
    const text = 'Ask @Training to verify this'
    expect(chatMentionTrigger(text, text.length, [{
      session_id: 'chat-2',
      display_title_snapshot: 'Training',
      source_text_start: 4,
      source_text_end: 13,
      action: 'instruction'
    }])).toBeNull()
  })

  it('does not reopen a resolved route hint while the user types after it', () => {
    const text = 'Let @Training inspect this'
    const reference = {
      session_id: 'chat-2',
      display_title_snapshot: 'Training',
      source_text_start: 4,
      source_text_end: 13,
      action: 'route' as const
    }
    expect(chatReferenceText(reference)).toBe('@Training')
    expect(currentRouteHintReference(text, reference)).toBe(true)
    expect(chatMentionTrigger(text, text.length, [reference])).toBeNull()
  })

  it('keeps a historical @@ route marker readable without making it authorable', () => {
    const text = 'Let @@Training inspect this'
    const reference = {
      session_id: 'chat-2', display_title_snapshot: 'Training',
      source_text_start: 4, source_text_end: 14, action: 'route' as const
    }
    expect(chatReferenceDisplayText(text, reference)).toBe('@@Training')
    expect(currentRouteHintReference(text, reference)).toBe(false)
    expect(chatMentionTrigger(text, text.length, [reference])).toBeNull()
  })

  it('does not treat an @ inside a resolved chat title as a new mention', () => {
    const text = 'Ask @CMA @ES to continue'
    expect(chatMentionTrigger(text, text.length, [{
      session_id: 'chat-2',
      display_title_snapshot: 'CMA @ES',
      source_text_start: 4,
      source_text_end: 12,
      action: 'instruction'
    }])).toBeNull()
  })

  it('does not treat /chat inside a resolved chat title as a new mention', () => {
    const text = 'Ask @Ops /chat review to continue'
    expect(chatMentionTrigger(text, text.length, [{
      session_id: 'chat-2',
      display_title_snapshot: 'Ops /chat review',
      source_text_start: 4,
      source_text_end: 21,
      action: 'instruction'
    }])).toBeNull()
  })

  it('uses only actions advertised by an authenticated server capability', () => {
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null, version: 5,
        actions: ['direct_message', 'route', 'instruction'],
        features: { direct_message_mentions: true, route_mentions: true }
      }
    } })).toEqual(['direct_message', 'route', 'instruction'])
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'missing feature gates', action: null, version: 5,
        actions: ['direct_message', 'route', 'instruction'],
        features: { direct_message_mentions: true }
      }
    } })).toEqual(['direct_message', 'instruction'])
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'old version', action: null, version: 4,
        actions: ['direct_message', 'route', 'instruction'],
        features: { direct_message_mentions: true, route_mentions: true }
      }
    } })).toEqual(['instruction'])

    const current: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null, version: 7,
        actions: ['route', 'instruction', 'request_reply'],
        features: {
          durable_route_grants: true,
          agent_cross_chat_routes: true,
          agent_ambient_local_handoffs: false
        },
        agent_routes: { client_capability: 'agent_cross_chat_routes_v2', policy: 'default_deny' }
      }
    } }
    expect(routeHintMentionsAvailable(current)).toBe(true)
    expect(routeHintMentionsAvailable({ ...current, capabilities: {
      cross_chat_handoffs_v1: { ...current.capabilities!.cross_chat_handoffs_v1!, version: 6 }
    } })).toBe(false)
    expect(routeHintMentionsAvailable({ ...current, capabilities: {
      cross_chat_handoffs_v1: {
        ...current.capabilities!.cross_chat_handoffs_v1!,
        features: { durable_route_grants: false, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false, route_mentions: true }
      }
    } })).toBe(false)
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: { available: true, required: false, message: 'ready', action: null, version: 1, actions: ['instruction'] }
    } })).toEqual(['instruction'])
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: { available: false, required: false, message: 'disabled', action: null, version: 1, actions: ['instruction', 'final_result'] }
    } })).toEqual([])
    expect(supportedCrossChatActions({ ok: true, capabilities: {
      cross_chat_handoffs_v1: { available: true, required: false, message: 'ready', action: null, version: 1, actions: ['instruction', 'instruction'] }
    } })).toEqual(['instruction'])
  })

  it('defaults a plain @ mention to optional instruction even when the server prefers request-reply', () => {
    const v2: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null,
        version: 2, actions: ['request_reply', 'instruction', 'final_result'],
        default_action: 'request_reply'
      }
    } }
    expect(supportedCrossChatActions(v2)).toEqual(['request_reply', 'instruction', 'final_result'])
    expect(defaultCrossChatAction(v2, 'codex')).toBe('instruction')
    expect(defaultCrossChatAction(v2)).toBe('instruction')

    const sendOnlyDefault: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null,
        version: 2, actions: ['request_reply', 'instruction', 'final_result'],
        default_action: 'instruction'
      }
    } }
    expect(defaultCrossChatAction(sendOnlyDefault, 'codex')).toBe('instruction')

    const malformedV1: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'legacy', action: null,
        version: 1, actions: ['request_reply', 'instruction']
      }
    } }
    expect(supportedCrossChatActions(malformedV1)).toEqual(['instruction'])
    expect(defaultCrossChatAction(malformedV1)).toBe('instruction')
  })

  it('defaults to optional instruction regardless of reply transport support', () => {
    const health: Health = { ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'ready', action: null,
        version: 2, actions: ['request_reply', 'instruction'],
        default_action: 'request_reply',
        supported_target_backends: ['codex']
      }
    } }
    expect(defaultCrossChatAction(health, 'claude')).toBe('instruction')
    expect(defaultCrossChatAction(health, 'codex')).toBe('instruction')
  })

  it('uses only target backends advertised by the server transport gate', () => {
    expect(supportedCrossChatTargetBackends({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true,
        required: false,
        message: 'ready',
        action: null,
        version: 1,
        supported_target_backends: ['codex']
      }
    } })).toEqual(['codex'])
    expect(supportedCrossChatTargetBackends({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true,
        required: false,
        message: 'Cursor ready',
        action: null,
        version: 7,
        supported_target_backends: ['codex', 'cursor', 'unknown' as never]
      }
    } })).toEqual(['codex', 'cursor'])
    expect(supportedCrossChatTargetBackends({ ok: true, capabilities: {
      cross_chat_handoffs_v1: {
        available: true,
        required: false,
        message: 'legacy server',
        action: null,
        version: 1
      }
    } })).toEqual(['codex', 'claude'])
  })

  it('inserts a readable route-hint chip while retaining an immutable session ID and UTF-16 span', () => {
    const trigger = chatMentionTrigger('😀 ask @tra', 11)!
    const result = insertChatReference('😀 ask @tra', trigger, { id: 'sess-target', title: 'Training' })
    expect(result.text).toBe('😀 ask @Training ')
    expect(result.reference).toEqual({
      session_id: 'sess-target',
      display_title_snapshot: 'Training',
      source_text_start: 7,
      source_text_end: 16,
      action: 'route'
    })
    expect(result.caret).toBe(17)
  })

  it('marks only an explicitly new canonical local @ chip as a pending durable grant', () => {
    const source = 'Ask @tra'
    const trigger = chatMentionTrigger(source, source.length)!
    const result = insertChatReference(source, trigger, { id: 'sess-target', title: 'Training' }, 'route', { grantIntent: true })
    expect(result.reference).toMatchObject({ action: 'route', grant_intent: true })
    expect(validChatReferences(result.text, [result.reference])).toEqual([result.reference])

    expect(validChatReferences('@@Training ', [{
      ...result.reference,
      source_text_start: 0,
      source_text_end: 10,
      grant_intent: true
    }])).toEqual([{
      session_id: 'sess-target',
      display_title_snapshot: 'Training',
      source_text_start: 0,
      source_text_end: 10,
      action: 'route'
    }])
    expect(result.reference).toHaveProperty('grant_intent', true)
  })

  it('inserts the identical @ route hint through /chat', () => {
    for (const source of ['Route @tra', 'Route /chat tra']) {
      const trigger = chatMentionTrigger(source, source.length)!
      const result = insertChatReference(source, trigger, { id: 'sess-target', title: 'Training' })
      expect(result.text).toBe('Route @Training ')
      expect(result.reference).toEqual({
        session_id: 'sess-target',
        display_title_snapshot: 'Training',
        source_text_start: 6,
        source_text_end: 15,
        action: 'route'
      })
    }
  })

  it('rejects ambiguous target titles beginning with @', () => {
    const trigger = chatMentionTrigger('Ask @ops', 8)!
    expect(() => insertChatReference(
      'Ask @ops',
      trigger,
      { id: 'sess-target', title: '@Ops' }
    )).toThrow(/beginning with @/i)
    expect(validChatReferences('@@Ops ', [{
      session_id: 'sess-target',
      display_title_snapshot: '@Ops',
      source_text_start: 0,
      source_text_end: 5,
      action: 'direct_message'
    }])).toEqual([])
  })

  it('binds a remote mention to the exact advertised secure route without transcript or file authority', () => {
    const trigger = chatMentionTrigger('Ask @train', 10)!
    const result = insertSecurePeerChatReference('Ask @train', trigger, secureRoute, 'request_reply')
    expect(result.text).toBe('Ask @Studio/training ')
    expect(result.reference).toEqual({
      session_id: secureRoute.routeId,
      display_title_snapshot: 'Studio/training',
      source_text_start: 4,
      source_text_end: 20,
      action: 'request_reply',
      target_kind: 'secure_peer',
      target_server_identity: 'server-studio',
      target_connection_id: secureRoute.connectionId,
      target_route_id: secureRoute.routeId,
      target_route_revision: secureRoute.revision
    })

    const stored = {
      ...result.reference,
      transcript: 'must-not-be-authorized',
      file_grants: ['/private/data']
    }
    expect(parseStoredChatReferences([stored], result.text)).toEqual([result.reference])
  })

  it('rejects stale, rebound, and action-escalated secure routes', () => {
    const reference = insertSecurePeerChatReference('Ask @train', chatMentionTrigger('Ask @train', 10)!, secureRoute, 'instruction').reference
    expect(securePeerReferenceMatchesRoute(reference, secureRoute)).toBe(true)
    expect(securePeerReferenceMatchesRoute(reference, { ...secureRoute, revision: `rev_${'b'.repeat(32)}` })).toBe(false)
    expect(securePeerReferenceMatchesRoute(reference, { ...secureRoute, connectionId: '32e7bb2e-3b47-4be7-89fc-2cecd90f4434' })).toBe(false)
    expect(securePeerReferenceMatchesRoute({ ...reference, action: 'request_reply' }, { ...secureRoute, actions: ['instruction'] })).toBe(false)
  })

  it('rejects an ambiguous leading-@ secure-peer label', () => {
    const trigger = chatMentionTrigger('Ask @studio', 11)!
    expect(() => insertSecurePeerChatReference(
      'Ask @studio',
      trigger,
      { ...secureRoute, peerDisplayName: '@Studio' },
      'instruction'
    )).toThrow(/labels beginning with @/i)
  })

  it('shifts untouched spans and revokes authority for edits that overlap a chip', () => {
    const reference = {
      session_id: 'target', display_title_snapshot: 'Agent B', action: 'instruction' as const,
      source_text_start: 5, source_text_end: 13
    }
    expect(reconcileChatReferences('Tell @Agent B now', 'Please Tell @Agent B now', [reference])[0]).toMatchObject({
      source_text_start: 12,
      source_text_end: 20
    })
    expect(reconcileChatReferences('Tell @Agent B now', 'Tell @Agent C now', [reference])).toEqual([])
    expect(reconcileChatReferences('Tell @Agent B now', 'Tell @Agent B right now', [reference])).toEqual([reference])
  })

  it('revokes authority when an adjacent edit removes either token boundary', () => {
    const reference = {
      session_id: 'target', display_title_snapshot: 'Agent', action: 'direct_message' as const,
      source_text_start: 5, source_text_end: 11
    }
    expect(reconcileChatReferences('Tell @Agent now', 'Tell @Agent2 now', [reference])).toEqual([])
    expect(reconcileChatReferences('Tell @Agent now', 'Tellx@Agent now', [reference])).toEqual([])
    expect(validChatReferences('Tell @Agent2 now', [reference])).toEqual([])
    expect(validChatReferences('Tellx@Agent now', [{
      ...reference,
      source_text_start: 5,
      source_text_end: 11
    }])).toEqual([])
  })

  it('rejects forged, self-targeting, overlapping, and text-mismatched spans', () => {
    const text = '@One and @Two'
    expect(validChatReferences(text, [
      { session_id: 'source', display_title_snapshot: 'One', source_text_start: 0, source_text_end: 4, action: 'instruction' },
      { session_id: 'two', display_title_snapshot: 'Wrong', source_text_start: 9, source_text_end: 13, action: 'final_result' },
      { session_id: 'two', display_title_snapshot: 'Two', source_text_start: 9, source_text_end: 13, action: 'final_result' }
    ], 'source')).toEqual([
      { session_id: 'two', display_title_snapshot: 'Two', source_text_start: 9, source_text_end: 13, action: 'final_result' }
    ])
  })

  it('accepts current route hints and keeps legacy direct-message and @@ records parseable', () => {
    const text = '@Direct and @@Route and @Legacy'
    expect(validChatReferences(text, [
      { session_id: 'direct', display_title_snapshot: 'Direct', source_text_start: 0, source_text_end: 7, action: 'direct_message' },
      { session_id: 'route', display_title_snapshot: 'Route', source_text_start: 12, source_text_end: 19, action: 'route' },
      { session_id: 'legacy', display_title_snapshot: 'Legacy', source_text_start: 24, source_text_end: 31, action: 'instruction' },
      { session_id: 'wrong-direct', display_title_snapshot: 'Route', source_text_start: 12, source_text_end: 19, action: 'direct_message' },
      { session_id: 'wrong-route', display_title_snapshot: 'Direct', source_text_start: 0, source_text_end: 7, action: 'route' }
    ])).toEqual([
      { session_id: 'direct', display_title_snapshot: 'Direct', source_text_start: 0, source_text_end: 7, action: 'direct_message' },
      { session_id: 'route', display_title_snapshot: 'Route', source_text_start: 12, source_text_end: 19, action: 'route' },
      { session_id: 'legacy', display_title_snapshot: 'Legacy', source_text_start: 24, source_text_end: 31, action: 'instruction' }
    ])
  })

  it('canonicalizes legacy local references to @ route hints and shifts later UTF-16 spans', () => {
    const text = '😀 @Direct then @@Route then @Legacy'
    const result = canonicalizeLocalRouteHints(text, [
      { session_id: 'direct', display_title_snapshot: 'Direct', source_text_start: 3, source_text_end: 10, action: 'direct_message' },
      { session_id: 'route', display_title_snapshot: 'Route', source_text_start: 16, source_text_end: 23, action: 'route' },
      { session_id: 'legacy', display_title_snapshot: 'Legacy', source_text_start: 29, source_text_end: 36, action: 'instruction' }
    ], 'source')
    expect(result.text).toBe('😀 @Direct then @Route then @Legacy')
    expect(result.references).toEqual([
      { session_id: 'direct', display_title_snapshot: 'Direct', source_text_start: 3, source_text_end: 10, action: 'route' },
      { session_id: 'route', display_title_snapshot: 'Route', source_text_start: 16, source_text_end: 22, action: 'route' },
      { session_id: 'legacy', display_title_snapshot: 'Legacy', source_text_start: 28, source_text_end: 35, action: 'instruction' }
    ])
  })

  it('treats a resolved @ route hint as one atomic textarea token', () => {
    const text = 'Tell @Training now'
    const reference = {
      session_id: 'training', display_title_snapshot: 'Training',
      source_text_start: 5, source_text_end: 14, action: 'route' as const
    }
    expect(atomicChatReferenceCaret(8, [reference])).toBe(5)
    expect(atomicChatReferenceCaret(12, [reference])).toBe(14)
    expect(atomicChatReferenceNavigation(14, [reference], 'ArrowLeft')).toBe(5)
    expect(atomicChatReferenceNavigation(5, [reference], 'ArrowRight')).toBe(14)
    expect(atomicChatReferenceDeletion(text, [reference], 14, 14, 'Backspace')).toEqual({ text: 'Tell now', caret: 5 })
    expect(atomicChatReferenceDeletion(text, [reference], 5, 5, 'Delete')).toEqual({ text: 'Tell now', caret: 5 })
  })

  it('keeps at most one authority grant for each target and action', () => {
    const text = '@One then @One'
    expect(validChatReferences(text, [
      { session_id: 'one', display_title_snapshot: 'One', source_text_start: 0, source_text_end: 4, action: 'instruction' },
      { session_id: 'one', display_title_snapshot: 'One', source_text_start: 10, source_text_end: 14, action: 'instruction' },
      { session_id: 'one', display_title_snapshot: 'One', source_text_start: 10, source_text_end: 14, action: 'final_result' }
    ])).toEqual([
      { session_id: 'one', display_title_snapshot: 'One', source_text_start: 0, source_text_end: 4, action: 'instruction' },
      { session_id: 'one', display_title_snapshot: 'One', source_text_start: 10, source_text_end: 14, action: 'final_result' }
    ])
  })

  it('fails closed at the server maximum of 16 chat references', () => {
    const tokens = Array.from({ length: MAX_CHAT_REFERENCES + 1 }, (_, index) => `@Agent${index}`)
    const text = tokens.join(' ')
    let offset = 0
    const references = tokens.map((token, index) => {
      const reference = {
        session_id: `agent-${index}`,
        display_title_snapshot: `Agent${index}`,
        source_text_start: offset,
        source_text_end: offset + token.length,
        action: 'instruction' as const
      }
      offset += token.length + 1
      return reference
    })

    const valid = validChatReferences(text, references)
    expect(valid).toHaveLength(MAX_CHAT_REFERENCES)
    expect(valid.at(-1)?.session_id).toBe('agent-15')
  })

  it('preserves a durable request-reply authority without prose inference', () => {
    const text = 'Ask @Agent B to inspect this'
    expect(validChatReferences(text, [{
      session_id: 'agent-b', display_title_snapshot: 'Agent B',
      source_text_start: 4, source_text_end: 12, action: 'request_reply'
    }])).toEqual([{
      session_id: 'agent-b', display_title_snapshot: 'Agent B',
      source_text_start: 4, source_text_end: 12, action: 'request_reply'
    }])
  })

  it('restores request-reply authority from a persisted draft unchanged', () => {
    const text = 'Ask @Agent B to inspect this'
    const persisted = [{
      session_id: 'agent-b', display_title_snapshot: 'Agent B',
      source_text_start: 4, source_text_end: 12, action: 'request_reply'
    }]

    expect(parseStoredChatReferences(persisted, text, 'source-chat')).toEqual(persisted)
  })

  it('preserves a saved scheduled route action ceiling', () => {
    const text = 'Notify @@Agent B later'
    const persisted = [{
      session_id: 'agent-b', display_title_snapshot: 'Agent B',
      source_text_start: 7, source_text_end: 16, action: 'route' as const,
      route_action: 'instruction' as const
    }]

    expect(parseStoredChatReferences(persisted, text, 'source-chat')).toEqual(persisted)
  })
})
