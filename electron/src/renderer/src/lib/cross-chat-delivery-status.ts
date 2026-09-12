import type { Event } from '@shared/types'

export function legacyOutgoingDeliveryStatus(status: string, type = ''): string {
  if (status === 'cancelled' || type.endsWith('_cancelled')) return 'timeline.inbox.cancelled'
  if (status === 'failed' || type.endsWith('_failed')) return 'timeline.delivery.failed'
  if (status === 'delivered' || type.endsWith('_delivered')) return 'timeline.delivery.delivered'
  if (status === 'running' || status === 'started' || type.endsWith('_started')) return 'timeline.delivery.processing'
  if (status === 'queued' || status === 'deferred' || type.endsWith('_queued')) return 'timeline.delivery.queued'
  return 'timeline.delivery.unconfirmed'
}

/** Only receipts for this exact envelope can strengthen its delivery claim. */
export function outgoingDeliveryStatus(event: Event, events: readonly Event[]): string {
  const id = (value: Event) => value.cross_chat_envelope_id || value.handoff_id || value.message_id
  const envelope = id(event)
  if (!envelope) return 'timeline.delivery.unconfirmed'
  const receipts = events.filter(value => id(value) === envelope
    && (!value.source_session_id || value.source_session_id === event.source_session_id)
    && (!value.target_session_id || value.target_session_id === event.target_session_id)
    && (!value.conversation_id || value.conversation_id === event.conversation_id))
  if (receipts.some(value => value.handoff_status === 'deleted' || value.type === 'chat_conversation_message_deleted')) return 'timeline.inbox.deleted'
  if (receipts.some(value => value.handoff_status === 'cancelled' || value.type === 'chat_conversation_message_cancelled')) return 'timeline.inbox.cancelled'
  if (receipts.some(value => value.handoff_status === 'failed' || value.type === 'chat_conversation_message_failed')) return 'timeline.delivery.failed'
  if (receipts.some(value => value.delivery_mode === 'mailbox' && value.inbox_state === 'read'
    && (value.handoff_status === 'stored' || value.handoff_status === 'read' || value.type === 'chat_conversation_message_read'))) return 'timeline.inbox.read'
  if (receipts.some(value => value.delivery_mode === 'mailbox')) {
    return receipts.some(value => value.handoff_status === 'stored' && value.inbox_state === 'unread')
      ? 'timeline.delivery.inboxUnread' : 'timeline.delivery.unconfirmed'
  }
  for (const value of [...receipts].reverse()) {
    const label = legacyOutgoingDeliveryStatus(value.handoff_status || '', value.type)
    if (label !== 'timeline.delivery.unconfirmed') return label
  }
  return 'timeline.delivery.unconfirmed'
}
