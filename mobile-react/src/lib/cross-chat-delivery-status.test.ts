import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, CrossChatHandoffSummary } from '../types'
import { legacyOutgoingDeliveryStatus, outgoingDeliveryStatus, outgoingMailboxCanCancel, requireMailboxCancellationReceipt } from './cross-chat-delivery-status'
const event = (patch: Partial<Event> = {}): Event => ({ id: 'e', seq: 1, ts: '2026-09-14', session_id: 'source', type: 'chat_conversation_message_registered', source_session_id: 'source', target_session_id: 'target', conversation_id: 'pair', message_id: 'm', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox', handoff_status: 'stored', inbox_state: 'unread', ...patch })
test('mailbox status requires stored receipt, not registration or labels', () => {
  const pending = event({ handoff_status: 'registered' })
  assert.equal(outgoingDeliveryStatus(pending, [pending]), 'Unconfirmed')
  assert.equal(outgoingDeliveryStatus(event(), [event()]), 'Inbox · unread')
  assert.equal(outgoingMailboxCanCancel(event(), [event()], 'source'), true)
  assert.equal(outgoingMailboxCanCancel(pending, [pending], 'source'), false)
  assert.equal(outgoingMailboxCanCancel(event(), [event()], 'target'), false)
})
test('exact-envelope terminal/read receipts dominate stale unread without foreign participants', () => {
  for (const patch of [{ message_id: 'other' }, { source_session_id: 'other' }, { target_session_id: 'other' }, { conversation_id: 'other' }]) {
    assert.equal(outgoingDeliveryStatus(event(), [event(), event({ ...patch, type: 'chat_conversation_message_read', inbox_state: 'read' })]), 'Inbox · unread')
  }
  for (const [type, state] of [['read', 'Read'], ['cancelled', 'Cancelled'], ['deleted', 'Deleted'], ['failed', 'Failed']]) {
    const receipt = event({ seq: 2, type: `chat_conversation_message_${type}`, inbox_state: type === 'read' ? 'read' : undefined })
    assert.equal(outgoingDeliveryStatus(event(), [receipt, event()]), state)
    assert.equal(outgoingMailboxCanCancel(event(), [receipt, event()], 'source'), false)
  }
})
test('legacy delivery labels do not infer completion from sent/unknown', () => {
  for (const [status, label] of [['queued', 'Queued'], ['running', 'Processing'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['failed', 'Failed'], ['sent', 'Unconfirmed']]) assert.equal(legacyOutgoingDeliveryStatus(status), label)
})
test('cancellation needs the exact authoritative receipt', () => {
  const receipt = { id: 'm', source_session_id: 'source', target_session_id: 'target', conversation_id: 'pair', status: 'cancelled' } as CrossChatHandoffSummary
  assert.doesNotThrow(() => requireMailboxCancellationReceipt(receipt, event()))
  for (const key of ['id', 'source_session_id', 'target_session_id', 'conversation_id', 'status']) assert.throws(() => requireMailboxCancellationReceipt({ ...receipt, [key]: 'other' }, event()))
})
