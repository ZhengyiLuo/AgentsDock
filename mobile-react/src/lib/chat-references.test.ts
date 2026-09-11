import assert from 'node:assert/strict'
import type { ChatReference, Health } from '../types'
import {
  caretAfterTextChange,
  chatMentionAction,
  chatMentionTrigger,
  chatReferenceWithAction,
  chatReferencesEqual,
  crossChatCapabilityVersion,
  crossChatHandoffsAvailable,
  defaultCrossChatAction,
  exactQueuedDeliverySkipAvailable,
  insertChatReference,
  interactiveClientCapabilities,
  localChatReferenceContractSupported,
  parseStoredChatReferences,
  reconcileChatReferences,
  removeChatReferencesForSession,
  restoreFailedChatComposer,
  routeHintMentionsAvailable,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences,
  MAX_CHAT_REFERENCES,
} from './chat-references'

function health(version: number, available = true): Health {
  return {
    ok: true,
    capabilities: {
      cross_chat_handoffs_v1: {
        available,
        version,
        actions: version >= 2
          ? ['request_reply', 'instruction', 'final_result']
          : ['instruction', 'final_result'],
        default_action: version >= 2 ? 'request_reply' : 'instruction',
        supported_target_backends: ['codex', 'claude'],
      },
      codex_controls: {
        available: true,
        version: 2,
        interactive_client_capability: 'codex_interactive_v1',
      },
      claude_controls: {
        available: true,
        version: 2,
        interactive_client_capability: 'claude_sdk_interactive_v1',
      },
    },
  }
}

const hardenedV7: Health = {
  ok: true,
  capabilities: {
    cross_chat_handoffs_v1: {
      available: true,
      version: 7,
      actions: ['route', 'instruction', 'request_reply', 'final_result'],
      supported_target_backends: ['codex', 'claude', 'cursor'],
      features: {
        durable_route_grants: true,
        agent_cross_chat_routes: true,
        agent_ambient_local_handoffs: false,
        route_hint_mentions: true,
      },
      agent_routes: {
        client_capability: 'agent_cross_chat_routes_v2',
        policy: 'default_deny',
        actions: ['instruction', 'request_reply'],
      },
    },
  },
}

assert.equal(crossChatHandoffsAvailable(health(1)), true)
assert.equal(crossChatCapabilityVersion(health(2)), 2)
assert.equal(crossChatHandoffsAvailable({
  ok: true,
  capabilities: { cross_chat_handoffs_v1: { available: true, version: '2' as unknown as number } },
}), false)
assert.deepEqual(supportedCrossChatActions(health(1)), ['instruction', 'final_result'])
assert.equal(defaultCrossChatAction(health(1), 'codex'), 'instruction')
assert.equal(defaultCrossChatAction(health(2), 'codex'), 'instruction')
assert.deepEqual(supportedCrossChatTargetBackends(health(2)), ['codex', 'claude'])
assert.deepEqual(interactiveClientCapabilities({ backend: 'codex' }, health(2)), [
  'codex_interactive_v1',
  'cross_chat_handoffs_v1',
  'cross_chat_handoffs_v2',
])
assert.deepEqual(interactiveClientCapabilities({ backend: 'claude' }, health(1)), [
  'claude_sdk_interactive_v1',
  'cross_chat_handoffs_v1',
])
assert.deepEqual(interactiveClientCapabilities({ backend: 'codex' }, health(2, false)), [
  'codex_interactive_v1',
])
assert.equal(routeHintMentionsAvailable(hardenedV7), true)
assert.equal(exactQueuedDeliverySkipAvailable({ ok: true, capabilities: { cross_chat_handoffs_v1: {
  available: true,
  version: 9,
  features: { exact_queued_delivery_skip: true },
} } }), true)
assert.equal(exactQueuedDeliverySkipAvailable({ ok: true, capabilities: { cross_chat_handoffs_v1: {
  available: true,
  version: 8,
  features: { exact_queued_delivery_skip: true },
} } }), false, 'exact queue removal must fail closed on pre-v9 servers')
assert.equal(routeHintMentionsAvailable({
  ...hardenedV7,
  capabilities: {
    ...hardenedV7.capabilities,
    cross_chat_handoffs_v1: {
      ...hardenedV7.capabilities?.cross_chat_handoffs_v1,
      features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: true },
    },
  },
}), false, 'ambient local handoffs must fail the v7 default-deny gate')
assert.deepEqual(interactiveClientCapabilities({ backend: 'cursor' }, hardenedV7), [
  'cross_chat_handoffs_v1',
  'cross_chat_handoffs_v2',
  'agent_cross_chat_routes_v2',
])

const trigger = chatMentionTrigger('Ask @tar', 'Ask @tar'.length)
assert.deepEqual(trigger, { kind: '@', start: 4, end: 8, query: 'tar' })
assert.deepEqual(chatMentionTrigger('Ask @', 'Ask @'.length), { kind: '@', start: 4, end: 5, query: '' })
const slash = chatMentionTrigger('Please /chat Target', 'Please /chat Target'.length)
assert.deepEqual(slash, { kind: '/chat', start: 7, end: 19, query: 'Target' })

assert.equal(caretAfterTextChange('Ask ', 'Ask @', { start: 4, end: 4 }), 5)
assert.equal(
  caretAfterTextChange('Ask ', 'Ask @', { start: 0, end: 0 }),
  5,
  'a stale iOS selection must fall back to the actual contiguous text edit',
)
assert.equal(caretAfterTextChange('Ask abc', 'Ask @', { start: 4, end: 7 }), 5)

assert(trigger)
const inserted = insertChatReference('Ask @tar', trigger, { id: 'target', title: 'Target' }, 'request_reply')
assert.equal(inserted.text, 'Ask @Target ')
assert.deepEqual(inserted.reference, {
  session_id: 'target',
  display_title_snapshot: 'Target',
  source_text_start: 4,
  source_text_end: 11,
  action: 'request_reply',
})
assert.equal(chatMentionTrigger(inserted.text, 5, [inserted.reference]), null)

const routeInserted = insertChatReference('Ask @tar', trigger, { id: 'target', title: 'Target' }, chatMentionAction(trigger))
assert.equal(routeInserted.reference.action, 'route')
assert.equal(routeInserted.reference.grant_intent, true, 'a v7 local route insertion must carry explicit pending-grant intent')
assert.equal(localChatReferenceContractSupported(hardenedV7, routeInserted.reference), true)
assert.equal(localChatReferenceContractSupported(health(2), routeInserted.reference), false, 'v2 handoffs must not admit local @ routes')
assert.equal(localChatReferenceContractSupported(hardenedV7, { ...routeInserted.reference, grant_intent: undefined }), false, 'a route without explicit grant intent must fail closed')
const instructionTransition = chatReferenceWithAction(routeInserted.reference, 'instruction')
assert.equal(instructionTransition.grant_intent, undefined, 'changing away from route must remove pending-grant authority')
assert.equal(localChatReferenceContractSupported(hardenedV7, instructionTransition), true)
const routeTransition = chatReferenceWithAction(instructionTransition, 'route')
assert.equal(routeTransition.grant_intent, true, 'changing back to route must restore explicit pending-grant intent')
assert.equal(localChatReferenceContractSupported(hardenedV7, { ...instructionTransition, grant_intent: true }), false, 'a non-route action must not retain route grant intent')

const emojiText = '😀 Ask @目标'
const emojiReference: ChatReference = {
  session_id: 'target',
  display_title_snapshot: '目标',
  source_text_start: 7,
  source_text_end: 10,
  action: 'request_reply',
}
assert.deepEqual(validChatReferences(emojiText, [emojiReference], 'source'), [emojiReference])
assert.deepEqual(validChatReferences(emojiText, [{ ...emojiReference, source_text_start: 6 }], 'source'), [])
assert.deepEqual(validChatReferences(emojiText, [{ ...emojiReference, session_id: 'source' }], 'source'), [])
assert.deepEqual(validChatReferences(emojiText, [emojiReference, { ...emojiReference }], 'source'), [emojiReference])
assert.equal(chatReferencesEqual(
  [emojiReference, { ...emojiReference, session_id: 'second', action: 'instruction' }],
  [{ ...emojiReference, session_id: 'second', action: 'instruction' }, emojiReference],
), true)
assert.equal(chatReferencesEqual([emojiReference], [{ ...emojiReference, action: 'instruction' }]), false)

let manyReferenceText = ''
const manyReferences = Array.from({ length: MAX_CHAT_REFERENCES + 1 }, (_, index): ChatReference => {
  if (manyReferenceText) manyReferenceText += ' '
  const display = `@T${index}`
  const start = manyReferenceText.length
  manyReferenceText += display
  return {
    session_id: `target-${index}`,
    display_title_snapshot: `T${index}`,
    source_text_start: start,
    source_text_end: start + display.length,
    action: 'instruction',
  }
})
assert.deepEqual(validChatReferences(manyReferenceText, manyReferences, 'source'), [])
assert.deepEqual(parseStoredChatReferences(manyReferences, manyReferenceText, 'source'), [])
assert.deepEqual(validChatReferences('@Target', [{ ...emojiReference, session_id: ' target', display_title_snapshot: 'Target', source_text_start: 0, source_text_end: 7 }]), [])
assert.deepEqual(validChatReferences('@\ud800', [{ ...emojiReference, display_title_snapshot: '\ud800', source_text_start: 0, source_text_end: 2 }]), [])
assert.deepEqual(validChatReferences('\ud800 @Target', [{
  ...emojiReference,
  display_title_snapshot: 'Target',
  source_text_start: 2,
  source_text_end: 9,
}]), [])

const shifted = reconcileChatReferences(emojiText, `Prefix ${emojiText}`, [emojiReference])
assert.deepEqual(shifted, [{ ...emojiReference, source_text_start: 14, source_text_end: 17 }])
assert.deepEqual(reconcileChatReferences(emojiText, '😀 Ask @变更', [emojiReference]), [])
assert.deepEqual(parseStoredChatReferences([emojiReference], emojiText, 'source'), [emojiReference])
assert.deepEqual(parseStoredChatReferences([{ ...emojiReference, action: 'bogus' }], emojiText, 'source'), [])

const newlyTypedReference: ChatReference = {
  session_id: 'other-target',
  display_title_snapshot: 'Other',
  source_text_start: 5,
  source_text_end: 11,
  action: 'instruction',
}
const admittedReference: ChatReference = {
  ...emojiReference,
  source_text_start: 4,
  source_text_end: 7,
}
assert.deepEqual(
  restoreFailedChatComposer('Ask @目标', [admittedReference], 'Then @Other', [newlyTypedReference], 'source'),
  {
    text: 'Ask @目标\n\nThen @Other',
    references: [
      admittedReference,
      { ...newlyTypedReference, source_text_start: 14, source_text_end: 20 },
    ],
  },
)
assert.deepEqual(
  restoreFailedChatComposer('', [], 'Then @Other', [newlyTypedReference], 'source'),
  { text: 'Then @Other', references: [newlyTypedReference] },
)
assert.deepEqual(
  restoreFailedChatComposer('Ask @目标', [admittedReference], '', [], 'source'),
  { text: 'Ask @目标', references: [admittedReference] },
)
assert.deepEqual(removeChatReferencesForSession({
  source: [emojiReference, { ...emojiReference, session_id: 'keep', action: 'instruction' }],
  target: [{ ...emojiReference, session_id: 'keep' }],
}, 'target'), {
  source: [{ ...emojiReference, session_id: 'keep', action: 'instruction' }],
})

console.log('cross-chat reference regressions passed')
