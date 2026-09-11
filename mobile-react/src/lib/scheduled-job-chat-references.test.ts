import assert from 'node:assert/strict'
import type { ChatReference, Health } from '../types'
import {
  normalizeScheduledJobChatReferences,
  scheduledJobChatReferencesForWrite,
  scheduledJobChatReferencesAvailable,
  scheduledJobRouteHintsAvailable,
} from './scheduled-job-chat-references'

const capable: Health = {
  ok: true,
  capabilities: {
    scheduled_jobs: {
      available: true,
      version: 5,
      features: { chat_references: true, route_hint_mentions: true },
    },
    cross_chat_handoffs_v1: {
      available: true,
      version: 7,
      actions: ['route'],
      features: {
        durable_route_grants: true,
        agent_cross_chat_routes: true,
        agent_ambient_local_handoffs: false,
      },
      agent_routes: {
        client_capability: 'agent_cross_chat_routes_v2',
        policy: 'default_deny',
        actions: ['instruction', 'request_reply'],
      },
    },
  },
}

assert.equal(scheduledJobChatReferencesAvailable(capable), true)
assert.equal(scheduledJobRouteHintsAvailable(capable), true)
assert.equal(scheduledJobRouteHintsAvailable({
  ...capable,
  capabilities: {
    ...capable.capabilities,
    scheduled_jobs: { available: true, version: 4, features: { chat_references: true, route_hint_mentions: true } },
  },
}), false, 'route hints must fail closed below scheduled-jobs v5')

const reference: ChatReference = {
  session_id: 'target',
  display_title_snapshot: 'Target',
  source_text_start: 6,
  source_text_end: 13,
  action: 'route',
  grant_intent: true,
}
assert.deepEqual(
  scheduledJobChatReferencesForWrite(capable, [reference]),
  [reference],
  'a complete scheduled route-hint contract may serialize normalized references',
)
assert.equal(
  scheduledJobChatReferencesForWrite({
    ok: true,
    capabilities: {
      scheduled_jobs: { available: true, version: 3, features: { chat_references: true } },
    },
  }, []),
  undefined,
  'a storage-only legacy server must omit chat_references instead of sending an empty array that erases stored routes',
)
assert.deepEqual(
  normalizeScheduledJobChatReferences('Check @Target', [reference], 'source'),
  [{ ...reference, grant_intent: undefined }].map(value => {
    delete value.grant_intent
    return value
  }),
  'scheduled grants must strip ordinary-composer durable route intent',
)
assert.deepEqual(
  normalizeScheduledJobChatReferences('Check @Target', [{ ...reference, action: 'request_reply' }], 'source'),
  [],
  'scheduled jobs must reject legacy authority actions instead of broadening them',
)

console.log('scheduled job chat reference regressions passed')
