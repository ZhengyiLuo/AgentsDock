import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatInboxMessage, ChatInboxPage, Event, Health } from '../types'
import { AgentServerClient } from '../api/AgentServerClient'
import { chatInboxMessageId, chatMailboxAvailable, inboxMessageMatchesEvent, isChatMailboxEvent, parseChatInboxDelete, parseChatInboxPage } from './chat-mailbox'

const message: ChatInboxMessage = {
  message_id: 'message', conversation_id: 'pair', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox',
  source_session_id: 'source', source_title: 'Sender', target_session_id: 'target', state: 'unread',
  created_at: '2026-09-11T12:00:00Z', received_at: '2026-09-11T12:00:01Z', read_at: null,
  reply_to_message_id: null, body: 'Hello', body_chars: 5, body_sha256: 'a'.repeat(64), message_revision: 0,
}
const page: ChatInboxPage = {
  session_id: 'target', messages: [message], next_cursor: null, has_more: false,
  senders: [{ source_session_id: 'source', source_title: 'Sender', unread_count: 1 }],
}
const event: Event = {
  id: 'receipt', session_id: 'target', seq: 1, ts: message.created_at, type: 'chat_conversation_message_received',
  conversation_mode: 'async_route_v1', delivery_mode: 'mailbox', message_id: 'message', conversation_id: 'pair',
  source_session_id: 'source', target_session_id: 'target', inbox_state: 'unread',
}

await test('mailbox and lifecycle gates require exact negotiated protocol markers', () => {
  const capability = { available: true, features: { chat_mailbox_v1: true } }
  assert.equal(chatMailboxAvailable({ ok: true, capabilities: { cross_chat_handoffs_v1: capability } }), true)
  for (const cap of [undefined, { ...capability, available: false }, { ...capability, features: {} }, { ...capability, features: { chat_mailbox_v1: 'true' } }]) {
    assert.equal(chatMailboxAvailable({ ok: true, capabilities: { cross_chat_handoffs_v1: cap } } as Health), false)
  }
  for (const status of ['registered', 'received', 'mailbox_migrated', 'read', 'cancelled', 'deleted']) {
    assert.equal(isChatMailboxEvent({ ...event, type: `chat_conversation_message_${status}` }), true)
  }
  for (const patch of [{ delivery_mode: undefined }, { conversation_mode: undefined }, { type: 'chat_conversation_message_read_extra' }, { type: 'chat_conversation_message_started' }]) {
    assert.equal(isChatMailboxEvent({ ...event, ...patch }), false)
  }
})

await test('strict inbox pages preserve passive state and bounded decimal pagination', () => {
  assert.equal(parseChatInboxPage(page, 'target', 25), page)
  assert.equal(parseChatInboxPage({ ...page, next_cursor: '25', has_more: true }, 'target', 1).next_cursor, '25')
  for (const patch of [
    { session_id: 'other' }, { messages: [message, message] }, { messages: {} }, { senders: null },
    { has_more: true }, { has_more: 'false' }, { next_cursor: 'next' }, { next_cursor: -1 },
    { senders: [{ source_session_id: 'source', source_title: 'Sender', unread_count: -1 }] },
  ]) assert.throws(() => parseChatInboxPage({ ...page, ...patch }, 'target', 25), /Invalid chat inbox/u)
  for (const limit of [0, 26, NaN, 1.5]) assert.throws(() => parseChatInboxPage(page, 'target', limit), /Invalid/u)
  assert.throws(() => parseChatInboxPage({ ...page, messages: [message, { ...message, message_id: 'second' }] }, 'target', 1), /Invalid/u)
})

await test('inbox message identity, body metadata, state and nullable fields fail closed', () => {
  for (const patch of [
    { message_id: '' }, { source_session_id: '' }, { target_session_id: 'other' }, { conversation_id: '' },
    { conversation_mode: 'legacy' }, { delivery_mode: 'queued' }, { source_title: null },
    { state: 'running' }, { state: {} }, { body: null }, { body_chars: -1 }, { body_chars: 1.5 },
    { body_sha256: 'bad' }, { message_revision: -1 }, { message_revision: Number.MAX_SAFE_INTEGER + 1 },
    { created_at: '' }, { received_at: undefined }, { read_at: undefined }, { reply_to_message_id: undefined },
  ]) assert.throws(() => parseChatInboxPage({ ...page, messages: [{ ...message, ...patch }] }, 'target', 25), /Invalid chat inbox message/u)
  for (const patch of [
    { message_id: 'other' }, { source_session_id: 'other' }, { target_session_id: 'other' },
    { conversation_id: 'other' }, { message_revision: 1 },
  ]) assert.equal(inboxMessageMatchesEvent({ ...message, ...patch }, event), false)
  assert.equal(inboxMessageMatchesEvent(message, event), true)
  assert.equal(inboxMessageMatchesEvent(message, { ...event, delivery_mode: undefined }), false)
  assert.equal(chatInboxMessageId({ ...event, message_id: undefined, cross_chat_envelope_id: 'envelope', handoff_id: 'handoff' }), 'envelope')
})

await test('delete receipt must identify exactly the requested message and receiving chat', () => {
  const receipt = { ok: true, session_id: 'target', message_id: 'message', state: 'deleted' }
  assert.equal(parseChatInboxDelete(receipt, 'target', 'message'), receipt)
  for (const patch of [{ ok: false }, { session_id: 'other' }, { message_id: 'other' }, { state: 'read' }]) {
    assert.throws(() => parseChatInboxDelete({ ...receipt, ...patch }, 'target', 'message'), /Invalid/u)
  }
})

await test('API inbox GET is passive, pagination/identifiers encoded, deletion explicit, revisions exact', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: URL; method: string; body: unknown }> = []
  const api = new AgentServerClient('https://example.invalid', 'synthetic')
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = method === 'DELETE' ? { ok: true, session_id: 'target /?', message_id: 'message /?', state: 'deleted' }
      : url.pathname.endsWith('/inbox') ? { ...page, session_id: 'target /?', messages: [{ ...message, target_session_id: 'target /?' }] }
      : { routes: [], max_routes: null }
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  try {
    await api.chatInbox('target /?', '25', 25)
    await api.deleteChatInboxMessage('target /?', 'message /?')
    await api.agentHandoffRoutes('target /?')
    await api.updateQueued('target /?', 'queue /?', 'Edited', undefined, undefined, undefined, 0)
    assert.equal(requests[0].method, 'GET')
    assert.equal(requests[0].url.pathname, '/api/sessions/target%20%2F%3F/inbox')
    assert.equal(requests[0].url.search, '?limit=25&cursor=25')
    assert.equal(requests[1].method, 'DELETE')
    assert.equal(requests[1].url.pathname, '/api/sessions/target%20%2F%3F/inbox/message%20%2F%3F')
    assert.equal(requests[2].url.searchParams.get('unlimited_routes'), 'true')
    assert.equal(requests[3].method, 'PATCH')
    assert.deepEqual(requests[3].body, { prompt: 'Edited', expected_message_revision: 0 })
    for (const cursor of ['-1', '1.5', 'abc', ' 1']) await assert.rejects(api.chatInbox('target', cursor), /Invalid/u)
    await assert.rejects(api.chatInbox('target', null, 26), /Invalid/u)
    await assert.rejects(api.updateQueued('target', 'queue', 'Edited', undefined, undefined, undefined, -1), /Invalid/u)
    assert.equal(requests.length, 4, 'invalid input must not issue requests; reading must never mark read or send a turn')
  } finally { globalThis.fetch = originalFetch; api.dispose() }
})
