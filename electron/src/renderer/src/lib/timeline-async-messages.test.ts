import { beforeEach, describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { timelineSemanticUnits } from '@shared/semantic-timeline'
import { updateQueuedTurns } from '@shared/queue'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { buildTimelineLandmarks } from './timeline-minimap'

const message = (seq: number, status: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'recipient', seq, ts: `2026-09-10T10:00:${String(seq).padStart(2, '0')}Z`,
  type: `chat_conversation_message_${status}`, conversation_mode: 'async_route_v1',
  conversation_id: 'pair-a', message_id: 'message-a', handoff_id: 'message-a', cross_chat_envelope_id: 'message-a',
  source_session_id: 'sender', target_session_id: 'recipient', source_title: 'Research agent', target_title: 'Desktop agent',
  handoff_status: status, handoff_action: 'instruction', handoff_preview: 'Review the keyboard behavior.',
  ...patch
})

describe('independent async chat messages', () => {
  beforeEach(clearTimelineProjectionCache)

  it('keeps pending and cancelled incoming messages exclusively in the ordinary queue', () => {
    const events = [message(1, 'received'), message(2, 'queued', { queued_id: 'queued-a' })]
    expect(renderTimelineItems(projectTimeline(events, []))).toEqual([])
    expect(renderTimelineItems(projectTimeline([...events, message(3, 'cancelled')], []))).toEqual([])
    expect(buildTimelineLandmarks(renderTimelineItems(projectTimeline(events, [])))).toEqual([])
  })

  it('anchors one received message when execution starts and keeps assistant work ordinary', () => {
    const events = [
      message(1, 'received'), message(2, 'queued', { queued_id: 'queued-a' }),
      message(3, 'started', { queued_id: 'queued-a', handoff_status: 'running' }),
      message(4, 'started', { type: 'turn_started', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', prompt: 'Provider authority wrapper', queued_id: 'queued-a' }),
      message(5, 'delivered', { type: 'turn_finished', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', result_text: 'The review is complete.' }),
      message(6, 'delivered')
    ]
    const rows = renderTimelineItems(projectTimeline(events, []))
    expect(rows.filter(row => row.kind === 'system')).toMatchObject([{
      key: 'cross-chat:handoff:message-a', seq: 3, crossChatMessage: true,
      anchorTs: events[2].ts, event: { handoff_status: 'delivered' }
    }])
    expect(rows.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(rows.filter(row => row.kind === 'message')).toMatchObject([{ role: 'assistant' }])
    const units = timelineSemanticUnits(events)
    expect(units).toHaveLength(1)
    expect(units[0].key).toBe('cross-chat:handoff:message-a')
    const landmarks = buildTimelineLandmarks(rows)
    expect(landmarks[0]).toMatchObject({ start_seq: 3, title: 'Message from Research agent', preview: 'Review the keyboard behavior.' })
  })

  it('keeps each explicit reply independent even when the pair ID is shared', () => {
    const first = message(1, 'registered', { session_id: 'sender' })
    const second = message(2, 'started', {
      session_id: 'sender', source_session_id: 'recipient', target_session_id: 'sender',
      source_title: 'Desktop agent', target_title: 'Research agent',
      message_id: 'message-b', handoff_id: 'message-b', cross_chat_envelope_id: 'message-b',
      handoff_preview: 'The keyboard issue is fixed.'
    })
    const rows = renderTimelineItems(projectTimeline([first, second, message(3, 'delivered', { session_id: 'sender' })], []))
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.key)).toEqual(['cross-chat:handoff:message-a', 'cross-chat:handoff:message-b'])
    expect(rows.map(row => row.seq)).toEqual([1, 2])
  })

  it('matches live append and reopened history through queued, started, reply and cancellation transitions', () => {
    const events = [message(1, 'received'), message(2, 'queued', { queued_id: 'queued-a' })]
    expect(cachedTimelineProjection('async-live', events, []).rendered).toEqual([])
    for (const next of [
      message(3, 'started'), message(4, 'delivered'),
      message(5, 'registered', { source_session_id: 'recipient', target_session_id: 'sender', message_id: 'reply', handoff_id: 'reply', cross_chat_envelope_id: 'reply' }),
      message(6, 'cancelled', { source_session_id: 'recipient', target_session_id: 'sender', message_id: 'reply', handoff_id: 'reply', cross_chat_envelope_id: 'reply' })
    ]) {
      events.push(next)
      const live = cachedTimelineProjection('async-live', events, []).rendered
      expect(live).toEqual(cachedTimelineProjection(`async-cold-${next.seq}`, events, []).rendered)
      expect(new Set(live.map(row => row.key)).size).toBe(live.length)
    }
  })

  it('retains legacy handoff presentation unless the exact new event contract is present', () => {
    for (const event of [
      message(1, 'received', { type: 'cross_chat_handoff_received', conversation_mode: undefined }),
      message(1, 'received', { conversation_mode: undefined }),
      message(1, 'received', { type: 'chat_conversation_message_future' })
    ]) {
      const rows = renderTimelineItems(projectTimeline([event], []))
      expect(rows).toHaveLength(1)
      expect(rows[0]).not.toHaveProperty('crossChatMessage')
    }
  })

  it('keeps the started message after the busy recipient finishes across live and cold projections', () => {
    const events: Event[] = []
    for (const next of [
      message(1, 'started', { type: 'turn_started', run_id: 'busy-run', prompt: 'Finish existing work' }),
      message(2, 'received'), message(3, 'queued'),
      message(4, 'delivered', { type: 'assistant_text', run_id: 'busy-run', text: 'Existing result' }),
      message(5, 'delivered', { type: 'turn_finished', run_id: 'busy-run', result_text: 'Existing result' }),
      message(6, 'started'),
      message(7, 'started', { type: 'turn_started', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', prompt: 'Internal provider wrapper' }),
      message(8, 'delivered', { type: 'turn_finished', purpose: 'cross_chat_handoff_delivery', run_id: 'delivery-run', result_text: 'Message handled' }),
      message(9, 'delivered')
    ]) {
      events.push(next)
      const live = cachedTimelineProjection('async-busy-live', events, []).rendered
      expect(live).toEqual(cachedTimelineProjection(`async-busy-cold-${next.seq}`, events, []).rendered)
    }
    const rows = cachedTimelineProjection('async-busy-live', events, []).rendered
    const messageIndex = rows.findIndex(row => row.kind === 'system' && row.crossChatMessage)
    expect(messageIndex).toBe(2)
    expect(rows[messageIndex].seq).toBe(6)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
  })

  it('preserves live queue mode and sender identity through updates and removes only the started envelope', () => {
    const queued = updateQueuedTurns([], message(1, 'queued', {
      type: 'turn_queued', purpose: 'cross_chat_handoff_delivery', queued_id: 'queued-a',
      prompt: 'Agent message', position: 2
    }))
    expect(queued[0]).toMatchObject({ conversation_mode: 'async_route_v1', source_title: 'Research agent', cross_chat_envelope_id: 'message-a' })
    const reordered = updateQueuedTurns(queued, message(2, 'queued', { type: 'turn_queue_updated', queued_id: 'queued-a', position: 1 }))
    expect(reordered[0]).toMatchObject({ conversation_mode: 'async_route_v1', source_title: 'Research agent', position: 1 })
    expect(updateQueuedTurns(reordered, message(3, 'started', { type: 'turn_started', queued_id: 'queued-a' }))).toEqual([])
  })
})
