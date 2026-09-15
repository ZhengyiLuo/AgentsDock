import type { CrossChatHandoffSummary, Event } from '../types'

export type CrossChatDeliveryStatus = 'Unconfirmed' | 'Queued' | 'Processing' | 'Delivered' | 'Inbox · unread' | 'Read' | 'Cancelled' | 'Deleted' | 'Failed'

export function legacyOutgoingDeliveryStatus(status: string, type = ''): CrossChatDeliveryStatus {
  if (status === 'cancelled' || type.endsWith('_cancelled')) return 'Cancelled'
  if (status === 'failed' || type.endsWith('_failed')) return 'Failed'
  if (status === 'delivered' || type.endsWith('_delivered')) return 'Delivered'
  if (status === 'running' || status === 'started' || type.endsWith('_started')) return 'Processing'
  if (status === 'queued' || status === 'deferred' || type.endsWith('_queued')) return 'Queued'
  return 'Unconfirmed'
}

const envelopeId = (event: Event) => event.cross_chat_envelope_id || event.handoff_id || event.message_id

/** Only receipts for this envelope and its known participants can strengthen a claim. */
export function outgoingDeliveryStatus(event: Event, events: readonly Event[]): CrossChatDeliveryStatus {
  const id = envelopeId(event)
  if (!id) return 'Unconfirmed'
  const receipts = events.filter(value => envelopeId(value) === id
    && (!value.source_session_id || value.source_session_id === event.source_session_id)
    && (!value.target_session_id || value.target_session_id === event.target_session_id)
    && (!value.conversation_id || value.conversation_id === event.conversation_id))
  if (receipts.some(value => value.handoff_status === 'deleted' || value.type === 'chat_conversation_message_deleted')) return 'Deleted'
  if (receipts.some(value => value.handoff_status === 'cancelled' || value.type === 'chat_conversation_message_cancelled')) return 'Cancelled'
  if (receipts.some(value => value.handoff_status === 'failed' || value.type === 'chat_conversation_message_failed')) return 'Failed'
  if (receipts.some(value => value.delivery_mode === 'mailbox' && value.inbox_state === 'read'
    && (value.handoff_status === 'stored' || value.handoff_status === 'read' || value.type === 'chat_conversation_message_read'))) return 'Read'
  if (receipts.some(value => value.delivery_mode === 'mailbox')) return receipts.some(value => value.handoff_status === 'stored' && value.inbox_state === 'unread') ? 'Inbox · unread' : 'Unconfirmed'
  for (const value of [...receipts].sort((a, b) => b.seq - a.seq)) {
    const status = legacyOutgoingDeliveryStatus(value.handoff_status || '', value.type)
    if (status !== 'Unconfirmed') return status
  }
  return 'Unconfirmed'
}

export function outgoingMailboxCanCancel(event: Event, events: readonly Event[], sessionId: string): boolean {
  return event.conversation_mode === 'async_route_v1' && event.delivery_mode === 'mailbox'
    && Boolean(envelopeId(event) && event.conversation_id && event.target_session_id)
    && event.source_session_id === sessionId && event.target_session_id !== sessionId
    && outgoingDeliveryStatus(event, events) === 'Inbox · unread'
}

export function requireMailboxCancellationReceipt(receipt: CrossChatHandoffSummary, event: Event): void {
  if (!receipt || receipt.id !== envelopeId(event) || receipt.source_session_id !== event.source_session_id
    || receipt.target_session_id !== event.target_session_id || receipt.conversation_id !== event.conversation_id
    || receipt.status !== 'cancelled') throw new Error('AgentsServer did not confirm cancellation of this mailbox message.')
}
