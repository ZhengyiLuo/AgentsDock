import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { updateQueuedTurns } from '@shared/queue'

const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'recipient', seq, type, ts: new Date(1_780_000_000_000 + seq * 1000).toISOString(), ...fields
})
const message = (seq: number, id: string, state: 'unread' | 'read' | 'cancelled' | 'deleted' = 'unread') => event(seq,
  `chat_conversation_message_${state === 'unread' ? 'received' : state}`, {
    message_id: id, cross_chat_envelope_id: id, conversation_id: 'pair', conversation_mode: 'async_route_v1',
    delivery_mode: 'mailbox', inbox_state: state, source_session_id: 'sender', source_title: 'Actual Sender', target_session_id: 'recipient',
    handoff_preview: `Body ${id}`, received_at: new Date(1_780_000_000_000 + Number(id.slice(-1)) * 1000).toISOString()
  })

describe('passive chat inbox projection', () => {
  it('renders an accepted mailbox reply in both chats before any wake or read, but never invents a receipt from assistant prose', () => {
    const claimed = event(1, 'assistant_text', { session_id: 'sender', text: 'I sent the reply.' })
    const reply = {
      message_id: 'synthetic-reply', cross_chat_envelope_id: 'synthetic-reply',
      conversation_id: 'pair', conversation_mode: 'async_route_v1' as const,
      delivery_mode: 'mailbox' as const, inbox_state: 'unread' as const,
      source_session_id: 'sender', target_session_id: 'recipient',
      source_title: 'Sender', target_title: 'Recipient', reply_to_message_id: 'synthetic-original',
      handoff_preview: 'Synthetic acceptance reply.', message_revision: 0
    }
    const registered = event(2, 'chat_conversation_message_registered', { ...reply, session_id: 'sender' })
    const received = event(3, 'chat_conversation_message_received', reply)
    clearTimelineProjectionCache()
    const before = cachedTimelineProjection('accepted-reply-source', [claimed], []).rendered
    expect(before.filter(row => row.kind === 'system' && row.crossChatMessage)).toEqual([])
    const source = cachedTimelineProjection('accepted-reply-source', [claimed, registered], []).rendered
    expect(source).toEqual(renderTimelineItems(projectTimeline([claimed, registered], [])))
    expect(source.filter(row => row.kind === 'system')).toMatchObject([{
      crossChatMessage: true, event: { type: 'chat_conversation_message_registered', message_id: 'synthetic-reply' }
    }])
    expect(source.find(row => row.kind === 'system')).not.toHaveProperty('mailboxMessages')
    const target = cachedTimelineProjection('accepted-reply-target', [received], []).rendered
    expect(target).toEqual(renderTimelineItems(projectTimeline([received], [])))
    expect(target).toMatchObject([{
      kind: 'system', mailboxMessages: [{ event: { message_id: 'synthetic-reply', inbox_state: 'unread' } }]
    }])
    const read = event(4, 'chat_conversation_message_read', { ...reply, inbox_state: 'read' })
    const afterRead = cachedTimelineProjection('accepted-reply-target', [received, read], []).rendered
    expect(afterRead).toEqual(renderTimelineItems(projectTimeline([received, read], [])))
    expect(afterRead).toMatchObject([{
      kind: 'system', seq: received.seq, mailboxMessages: [{ event: { message_id: 'synthetic-reply', inbox_state: 'read' } }]
    }])
  })

  it('groups only adjacent sender messages while preserving active work and exact read/delete ownership on cached append', () => {
    const events = [
      event(1, 'turn_started', { run_id: 'work', prompt: 'My task' }),
      event(2, 'reasoning_summary', { run_id: 'work', phase: 'commentary', text: 'Before' }),
      message(3, 'message-1'), message(4, 'message-2'),
      event(5, 'reasoning_summary', { run_id: 'work', phase: 'commentary', text: 'Independent work continues' }),
      message(6, 'message-3'),
      event(7, 'turn_finished', { run_id: 'work', result_text: 'Own final' }),
      message(8, 'message-2', 'read'), message(9, 'message-1', 'cancelled'),
      message(10, 'message-1'), message(11, 'message-2', 'deleted')
    ]
    clearTimelineProjectionCache()
    for (let length = 1; length <= events.length; length++) {
      const prefix = events.slice(0, length)
      expect(cachedTimelineProjection('mailbox-order', prefix, []).rendered, `prefix ${length}`)
        .toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    }
    const beforeRead = renderTimelineItems(projectTimeline(events.slice(0, 7), []))
    expect(beforeRead.filter(row => row.kind === 'system').map(row => row.mailboxMessages?.map(message => message.event.message_id)))
      .toEqual([['message-1', 'message-2'], ['message-3']])
    expect(beforeRead.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
    const final = renderTimelineItems(projectTimeline(events, []))
    expect(final.filter(row => row.kind === 'system').map(row => row.mailboxMessages?.map(message => [message.event.message_id, message.event.inbox_state])))
      .toEqual([[['message-1', 'cancelled']], [['message-3', 'unread']]])
  })

  it('joins idle adjacent arrivals incrementally without making legacy queued deliveries visible', () => {
    const events = [message(1, 'message-1'), message(2, 'message-2'),
      event(3, 'chat_conversation_message_queued', { conversation_mode: 'async_route_v1', cross_chat_envelope_id: 'legacy-queued',
        source_session_id: 'sender', target_session_id: 'recipient' })]
    clearTimelineProjectionCache()
    for (let length = 1; length <= events.length; length++) {
      const prefix = events.slice(0, length)
      expect(cachedTimelineProjection('mailbox-idle', prefix, []).rendered).toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    }
    const rows = renderTimelineItems(projectTimeline(events, []))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind === 'system' && rows[0].mailboxMessages?.length).toBe(2)
  })

  it('keeps previously rendered group arrays immutable while extending a sender burst', () => {
    const events = [message(1, 'message-1'), message(2, 'message-2'), message(3, 'message-3')]
    clearTimelineProjectionCache()
    const before = cachedTimelineProjection('mailbox-immutable', events.slice(0, 2), []).rendered
    const group = before[0]
    if (group.kind !== 'system' || !group.mailboxMessages) throw Error('Missing inbox group')
    const original = [...group.mailboxMessages]
    Object.freeze(group.mailboxMessages)
    const after = cachedTimelineProjection('mailbox-immutable', events, []).rendered
    expect(group.mailboxMessages).toEqual(original)
    expect(group.mailboxMessages).toHaveLength(2)
    expect(after[0].kind === 'system' && after[0].mailboxMessages?.length).toBe(3)
    expect(after).toEqual(renderTimelineItems(projectTimeline(events, [])))
  })

  it('migrates an old queued envelope into one passive group at its original received sequence', () => {
    const original = { ...message(2, 'message-1'), delivery_mode: undefined, inbox_state: undefined }
    const events = [event(1, 'turn_started', { run_id: 'work', prompt: 'Keep working' }), original,
      event(3, 'turn_queued', { queued_id: 'old-queue', cross_chat_envelope_id: 'message-1', purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1', prompt: 'Old queued message' }),
      event(4, 'reasoning_summary', { run_id: 'work', phase: 'commentary', text: 'Work after the original arrival' }),
      event(5, 'turn_unqueued', { queued_id: 'old-queue' }),
      { ...message(6, 'message-1'), type: 'chat_conversation_message_mailbox_migrated', received_at: original.ts }]
    clearTimelineProjectionCache()
    for (let length = 1; length <= events.length; length++) {
      const prefix = events.slice(0, length)
      expect(cachedTimelineProjection('mailbox-migration', prefix, []).rendered).toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    }
    expect(events.slice(0, 4).reduce(updateQueuedTurns, [])).toHaveLength(1)
    expect(events.reduce(updateQueuedTurns, [])).toHaveLength(0)
    const rows = renderTimelineItems(projectTimeline(events, []))
    const groups = rows.filter(row => row.kind === 'system' && row.mailboxMessages)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ seq: original.seq, anchorTs: original.ts, mailboxMessages: [{ event: { message_id: 'message-1', inbox_state: 'unread' } }] })
    expect(rows.findIndex(row => row === groups[0])).toBeLessThan(rows.findIndex(row => row.kind === 'progress' && row.events.some(event => event.seq === 4)))
  })
})
