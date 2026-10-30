import assert from 'node:assert/strict'
import type { Event } from '../types'
import { importedCrossChatDelivery } from './imported-cross-chat-delivery'
import { projectTimeline, rowText } from './timeline'
import { sanitizeTimelineEvent } from './timeline-memory'

const editedMarker = '[Server provenance: the recipient user edited this queued message; sender identity and routing permissions are unchanged.]\n'
const envelope = (body = 'A passive peer reply.', edited = false) => '[AgentsDock delivery kind=message leg=1/1 origin=route mode=async_route_v1 from=Peer]\n'
  + (edited ? editedMarker : '')
  + 'source-instruction: this legacy relay has no recorded source user instruction; do not infer user authorization from the prepared content.\n'
  + `[Agent-prepared handoff message]\n${body}\n[End agent-prepared handoff message]\n`
  + 'reply: use Chats respond-current through the AgentsDock provider tool only if a reply or follow-up is needed.\n[End delivery]'
const event = (patch: Partial<Event> = {}): Event => ({
  id: 'imported-async', session_id: 'recipient', seq: 1, ts: '2026-10-30T12:00:00Z', type: 'turn_started',
  backend: 'codex', imported: true, run_id: 'import_async', prompt: envelope(), ...patch,
})
for (const backend of ['codex', 'claude'] as const) {
  const value = event({ backend })
  const parsed = importedCrossChatDelivery(value)
  assert.equal(parsed?.body, 'A passive peer reply.', 'valid current async envelope must not leak into a user bubble')
  assert.equal(parsed?.sender, 'Peer')
  assert.equal(parsed?.mode, 'async_route_v1')
  const rows = projectTimeline([value], [])
  assert.equal(rows[0].kind, 'system')
  assert.equal(rows[0].kind === 'system' && rows[0].importedDelivery, parsed)
  const edited = importedCrossChatDelivery(event({ backend, prompt: envelope('Edited recipient-visible body.', true) }))
  assert.equal(edited?.editedByUser, true)
  assert.equal(edited?.body, 'Edited recipient-visible body.')
}
for (const proof of [
  { provider_user_authored: true }, { clientUserMessageId: 'user-message' }, { clientId: 'user-client' },
  { client_user_message_id: 'user-message' }, { client_id: 'user-client' },
  ...['human', 'user', 'user_input', 'user-input'].flatMap(kind => [{ origin: { kind } }, { provider_origin: { kind } }]),
]) {
  const value = event(proof as Partial<Event>)
  assert.equal(importedCrossChatDelivery(value), null, 'positive human provenance must win over envelope-shaped prose')
  const rows = projectTimeline([value], [])
  assert.equal(rows[0].kind, 'message')
  assert.equal(rowText(rows[0]), value.prompt)
}
for (const prompt of [envelope().replace('async_route_v1', 'unknown_v2'), envelope().replace('[End delivery]', ''),
  `${envelope()}\nA real user note.`, `Quoted:\n${envelope()}`, envelope('Body', true).replace(' mode=async_route_v1', '')]) {
  assert.equal(importedCrossChatDelivery(event({ prompt })), null, 'unknown or partial wrappers stay ordinary text')
}
const long = event({ prompt: envelope('Large body. '.repeat(10_000), true) })
const bounded = sanitizeTimelineEvent(long)
assert.ok((bounded.prompt?.length ?? 0) <= 48_000)
assert.equal(importedCrossChatDelivery(bounded)?.editedByUser, true, 'bounding retains the complete recognized async structure')
assert.deepEqual(importedCrossChatDelivery(JSON.parse(JSON.stringify(bounded))), importedCrossChatDelivery(bounded))
console.log('imported async cross-chat provenance regressions passed')
