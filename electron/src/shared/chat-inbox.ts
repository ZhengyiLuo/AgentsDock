import type { ChatInboxDeleteReceipt, ChatInboxMessage, ChatInboxPage, Event, Health } from './types'

export function chatMailboxAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return capability?.available === true && capability.features?.chat_mailbox_v1 === true
}

export function isChatMailboxEvent(event: Event): boolean {
  return event.conversation_mode === 'async_route_v1' && event.delivery_mode === 'mailbox'
    && /^chat_conversation_message_(registered|received|mailbox_migrated|read|cancelled|deleted)$/.test(event.type)
}

export function chatInboxMessageId(event: Event): string {
  return event.message_id?.trim() || event.cross_chat_envelope_id?.trim() || event.handoff_id?.trim() || ''
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const nullableText = (value: unknown) => value === null || text(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

export function parseChatInboxPage(value: unknown, sessionId: string, limit: number): ChatInboxPage {
  if (!record(value) || value.session_id !== sessionId || !Array.isArray(value.messages) || value.messages.length > limit
    || !Array.isArray(value.senders) || typeof value.has_more !== 'boolean'
    || !(value.next_cursor === null || typeof value.next_cursor === 'string' && /^\d+$/.test(value.next_cursor))
    || value.has_more && value.next_cursor === null) throw new Error('Invalid chat inbox response.')
  const ids = new Set<string>()
  for (const message of value.messages) {
    if (!record(message) || !text(message.message_id) || ids.has(message.message_id)
      || message.target_session_id !== sessionId || !text(message.source_session_id) || typeof message.source_title !== 'string'
      || !text(message.conversation_id) || message.conversation_mode !== 'async_route_v1' || message.delivery_mode !== 'mailbox'
      || !['unread', 'read', 'cancelled', 'deleted'].includes(String(message.state))
      || typeof message.body !== 'string' || !count(message.body_chars) || !count(message.message_revision)
      || typeof message.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(message.body_sha256)
      || !text(message.created_at) || !nullableText(message.received_at) || !nullableText(message.read_at)
      || !nullableText(message.reply_to_message_id)) throw new Error('Invalid chat inbox message.')
    ids.add(message.message_id)
  }
  for (const sender of value.senders) {
    if (!record(sender) || !text(sender.source_session_id) || typeof sender.source_title !== 'string'
      || !count(sender.unread_count)) throw new Error('Invalid chat inbox sender.')
  }
  return value as unknown as ChatInboxPage
}

export function parseChatInboxDelete(value: unknown, sessionId: string, messageId: string): ChatInboxDeleteReceipt {
  if (!record(value) || value.ok !== true || value.session_id !== sessionId || value.message_id !== messageId
    || value.state !== 'deleted') throw new Error('Invalid chat inbox deletion receipt.')
  return value as unknown as ChatInboxDeleteReceipt
}

export function inboxMessageMatchesEvent(message: ChatInboxMessage, event: Event): boolean {
  return message.message_id === chatInboxMessageId(event) && message.source_session_id === event.source_session_id
    && message.target_session_id === event.target_session_id && message.conversation_id === event.conversation_id
    && message.message_revision === (event.message_revision ?? 0)
}
