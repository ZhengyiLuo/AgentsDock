import assert from 'node:assert/strict'
import { chatInboxMessageId, chatMailboxAvailable, inboxMessageMatchesEvent, isChatMailboxEvent, parseChatInboxDelete, parseChatInboxPage } from './chat-inbox'
import type { ChatInboxMessage, Event, Health } from '../types'

const message: ChatInboxMessage = {
  message_id: 'message-a', conversation_id: 'pair-a', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox',
  source_session_id: 'sender', source_title: 'Peer', target_session_id: 'recipient', state: 'unread',
  created_at: '2026-10-30T12:00:00Z', received_at: '2026-10-30T12:00:00Z', read_at: null, reply_to_message_id: null,
  body: 'Actual peer body', body_chars: 16, body_sha256: 'a'.repeat(64), message_revision: 0,
}
const page = () => ({ session_id: 'recipient', messages: [{ ...message }], next_cursor: null, has_more: false,
  senders: [{ source_session_id: 'sender', source_title: 'Peer', unread_count: 1 }] })
const event = { id: 'event-a', session_id: 'recipient', seq: 1, ts: message.created_at,
  type: 'chat_conversation_message_received', ...message, inbox_state: 'unread' } as Event
assert.deepEqual(parseChatInboxPage(page(), 'recipient', 25), page())
assert.equal(chatInboxMessageId(event), 'message-a')
assert.equal(inboxMessageMatchesEvent(message, event), true)
for (const patch of [{ message_id: 'other' }, { conversation_id: 'other' }, { source_session_id: 'other' },
  { target_session_id: 'other' }, { message_revision: 1 }]) {
  assert.equal(inboxMessageMatchesEvent({ ...message, ...patch }, event), false)
}
for (const patch of [{ session_id: 'other' }, { messages: [message, message] }, { messages: [message, { ...message, message_id: 'b' }] },
  { next_cursor: null, has_more: true }, { next_cursor: '-1' }, { senders: [{ source_session_id: 'sender', source_title: 'Peer', unread_count: -1 }] }]) {
  assert.throws(() => parseChatInboxPage({ ...page(), ...patch }, 'recipient', 1), /Invalid chat inbox/)
}
for (const patch of [{ target_session_id: 'other' }, { delivery_mode: 'queued' }, { conversation_mode: 'future' },
  { state: 'unknown' }, { message_revision: -1 }, { message_revision: 1.1 }, { body: null }, { body_chars: -1 },
  { body_sha256: 'bad' }, { source_title: null }, { reply_to_message_id: 5 }]) {
  assert.throws(() => parseChatInboxPage({ ...page(), messages: [{ ...message, ...patch }] }, 'recipient', 25), /Invalid chat inbox/)
}
assert.equal(isChatMailboxEvent(event), true)
assert.equal(isChatMailboxEvent({ ...event, delivery_mode: undefined }), false)
assert.equal(isChatMailboxEvent({ ...event, conversation_mode: undefined }), false)
assert.equal(isChatMailboxEvent({ ...event, type: 'chat_conversation_message_future' }), false)
assert.equal(chatMailboxAvailable({ capabilities: { cross_chat_handoffs_v1: { available: true, features: { chat_mailbox_v1: true } } } } as Health), true)
assert.equal(chatMailboxAvailable({ capabilities: { cross_chat_handoffs_v1: { available: false, features: { chat_mailbox_v1: true } } } } as Health), false)
assert.equal(chatMailboxAvailable(null), false)
const deletion = { ok: true, session_id: 'recipient', message_id: 'message-a', state: 'deleted' }
assert.deepEqual(parseChatInboxDelete(deletion, 'recipient', 'message-a'), deletion)
for (const patch of [{ ok: false }, { session_id: 'other' }, { message_id: 'other' }, { state: 'read' }]) {
  assert.throws(() => parseChatInboxDelete({ ...deletion, ...patch }, 'recipient', 'message-a'), /Invalid chat inbox deletion receipt/)
}
console.log('chat inbox response validation regressions passed')
