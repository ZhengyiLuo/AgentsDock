import { beforeEach, describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { updateQueuedTurns } from '@shared/queue'
import { activityEventSequence, projectTimeline, renderTimelineItems, type RenderTimelineItem } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `order-event-${seq}`, session_id: 'local', seq, type,
  ts: `2026-09-11T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})
const work = (seq: number, type: string, patch: Partial<Event> = {}): Event =>
  event(seq, type, { run_id: 'working-run', ...patch })
const progress = (seq: number): Event =>
  work(seq, 'reasoning_summary', { phase: 'commentary', text: `Progress at ${seq}.` })
const start = (): Event => work(1, 'turn_started', { prompt: 'Continue the local work.' })
const message = (seq: number, id = 'outgoing', status = 'registered', patch: Partial<Event> = {}): Event =>
  event(seq, `chat_conversation_message_${status}`, {
    conversation_mode: 'async_route_v1', conversation_id: 'local-peer-pair',
    message_id: id, handoff_id: id, cross_chat_envelope_id: id,
    source_session_id: 'local', target_session_id: 'peer',
    source_title: 'Local agent', target_title: 'Peer agent', handoff_action: 'instruction',
    handoff_status: status, handoff_preview: `Independent message ${id}.`, ...patch
  })
const reply = (seq: number, status = 'started'): Event => message(seq, 'reply', status, {
  source_session_id: 'peer', target_session_id: 'local', source_title: 'Peer agent', target_title: 'Local agent'
})
const legacyLeg = (seq: number, kind: 'request' | 'reply', patch: Partial<Event> = {}): Event =>
  event(seq, 'cross_chat_exchange_leg_registered', {
    exchange_id: 'legacy-exchange', exchange_leg_id: `${kind}-leg`, exchange_leg_kind: kind,
    exchange_ordinal: kind === 'request' ? 1 : 2, exchange_max_legs: 2,
    source_session_id: kind === 'request' ? 'local' : 'peer',
    target_session_id: kind === 'request' ? 'peer' : 'local', handoff_preview: `${kind} body`, ...patch
  })

// Exercise every live prefix, then compare it with reopening the same event history.
function projections(events: Event[]): RenderTimelineItem[][] {
  let live: RenderTimelineItem[] = []
  for (let length = 1; length <= events.length; length++) {
    const prefix = events.slice(0, length)
    live = cachedTimelineProjection('crosschat-order-live', prefix, []).rendered
    expect(live, `live prefix ending at sequence ${prefix.at(-1)?.seq}`)
      .toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    expect(new Set(live.map(row => row.key)).size).toBe(live.length)
  }
  return [renderTimelineItems(projectTimeline(events, [])), live]
}

function visibleOrder(rows: RenderTimelineItem[]): string[] {
  return rows.flatMap(row => {
    if (row.kind === 'progress') return row.events.map(item => `activity:${item.seq}`)
    if (row.kind === 'system' && (row.crossChatMessage || row.crossChatLegId)) return [`delivery:${row.seq}`]
    if (row.kind === 'message') return [`${row.role}:${row.seq}`]
    return []
  })
}

describe('cross-chat messages stay at their place in ongoing work', () => {
  beforeEach(clearTimelineProjectionCache)

  it.each(['claude', 'codex'] as const)('interleaves a sent message with subsequent %s work in live and reopened history', backend => {
    const events = [start(), progress(2), message(3), progress(4),
      work(5, 'tool_started', { tool: { id: 'read-file', name: 'Read', input: { file_path: 'example.txt' } } }),
      work(6, 'tool_finished', { tool_id: 'read-file', output: 'Read complete.' }), progress(7)]
      .map(item => item.run_id ? { ...item, backend } : item)
    for (const rows of projections(events)) {
      expect(visibleOrder(rows)).toEqual([
        'user:1', 'activity:2', 'delivery:3', 'activity:4', 'activity:5', 'activity:6', 'activity:7'
      ])
      expect(rows.filter(row => row.kind === 'progress' && row.active)).toHaveLength(1)
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true })
    }
  })

  it.each(['claude', 'codex'] as const)('keeps the %s live edge after a send that changes no existing turn events', backend => {
    const events = [start(), progress(2), message(3)].map(item => item.run_id ? { ...item, backend } : item)
    for (const rows of projections(events)) {
      expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'delivery:3'])
      expect(rows.filter(row => row.kind === 'progress' && row.active)).toHaveLength(1)
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true, events: [] })
      const beforeMessage = rows.slice(0, rows.findIndex(row => row.kind === 'system' && row.crossChatMessage))
      expect(beforeMessage.some(row => row.kind === 'progress' && row.active)).toBe(false)
    }
  })

  it('keeps the final answer after the send and never moves the bubble on a terminal receipt', () => {
    const sent = message(3)
    const finished = [start(), progress(2), sent, progress(4),
      work(5, 'turn_finished', { result_text: 'Local work is complete.' })]
    for (const events of [finished, [...finished, message(6, 'outgoing', 'delivered')]]) {
      for (const rows of projections(events)) {
        expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'delivery:3', 'activity:4', 'assistant:5'])
        expect(rows.filter(row => row.kind === 'progress' && row.active)).toEqual([])
        expect(rows.filter(row => row.kind === 'system' && row.crossChatMessage))
          .toMatchObject([{ seq: sent.seq, anchorTs: sent.ts }])
      }
    }
  })

  it('keeps a second send and a started reply separate while work continues around each', () => {
    const events = [start(), progress(2), message(3), progress(4), message(5, 'second-send'),
      progress(6), reply(7, 'received'), reply(8), progress(9)]
    for (const rows of projections(events)) {
      expect(visibleOrder(rows)).toEqual([
        'user:1', 'activity:2', 'delivery:3', 'activity:4', 'delivery:5', 'activity:6', 'delivery:8', 'activity:9'
      ])
      expect(rows.filter(row => row.kind === 'progress' && row.active)).toHaveLength(1)
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true })
    }
  })

  it('interleaves legacy request and reply legs without moving their original timestamps on completion', () => {
    const events = [start(), progress(2), legacyLeg(3, 'request'), progress(4), legacyLeg(5, 'reply'), progress(6),
      legacyLeg(7, 'reply', { type: 'cross_chat_exchange_leg_delivered', exchange_leg_status: 'delivered', exchange_status: 'completed' })]
    for (const rows of projections(events)) {
      expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'delivery:3', 'activity:4', 'delivery:5', 'activity:6'])
      expect(rows.filter(row => row.kind === 'system' && row.crossChatLegId))
        .toMatchObject([{ seq: 3, anchorTs: events[2].ts }, { seq: 5, anchorTs: events[4].ts }])
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true })
    }
  })

  it('keeps one tool call at its start position when its result arrives after a send', () => {
    const events = [start(),
      work(2, 'tool_started', { tool: { id: 'read-across-send', name: 'Read', input: { file_path: 'example.txt' } } }),
      message(3), work(4, 'tool_finished', { tool_id: 'read-across-send', output: 'Read complete.' }), progress(5)]
    for (const rows of projections(events)) {
      const deliveryIndex = rows.findIndex(row => row.kind === 'system' && row.crossChatMessage)
      const toolOwner = rows.findIndex(row => row.kind === 'progress' && row.events.some(item => item.seq === 2))
      expect(toolOwner).toBeLessThan(deliveryIndex)
      expect(rows[toolOwner]).toMatchObject({ kind: 'progress', active: false, events: [{ seq: 2 }, { seq: 4 }] })
      expect(rows.flatMap(row => row.kind === 'progress' ? row.events : []).map(item => item.seq)).toEqual([2, 4, 5])
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true, events: [{ seq: 5 }] })
    }
  })

  it('does not move an old send or steal the live edge when its receipt arrives during a newer turn', () => {
    const sent = message(3)
    const events = [start(), progress(2), sent, work(4, 'turn_finished', { result_text: 'Earlier work is complete.' }),
      event(5, 'turn_started', { run_id: 'newer-run', prompt: 'Do the next task.' }),
      event(6, 'reasoning_summary', { run_id: 'newer-run', phase: 'commentary', text: 'Newer work.' }),
      message(7, 'outgoing', 'delivered')]
    for (const rows of projections(events)) {
      expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'delivery:3', 'assistant:4', 'user:5', 'activity:6'])
      expect(rows.filter(row => row.kind === 'system' && row.crossChatMessage))
        .toMatchObject([{ seq: 3, anchorTs: sent.ts, event: { seq: 7 } }])
      expect(rows.filter(row => row.kind === 'progress' && row.active)).toHaveLength(1)
      expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true, events: [{ run_id: 'newer-run' }] })
    }
  })

  it('keeps pending incoming content only in the queue, then anchors it when delivery starts', () => {
    const queued = { ...reply(4, 'queued'), type: 'turn_queued', queued_id: 'pending-reply',
      purpose: 'cross_chat_handoff_delivery', prompt: 'Pending agent message.' }
    const pending = [start(), progress(2), reply(3, 'received'), queued, reply(5, 'queued'), progress(6)]
    expect(updateQueuedTurns([], queued)).toHaveLength(1)
    for (const rows of projections(pending)) {
      expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'activity:6'])
      expect(rows.filter(row => row.kind === 'system' && row.crossChatMessage)).toEqual([])
    }
    const nativeStart = event(9, 'turn_started', {
      ...reply(9), type: 'turn_started', run_id: 'reply-run', queued_id: 'pending-reply',
      purpose: 'cross_chat_handoff_delivery', prompt: 'Internal delivery wrapper; never a user bubble.'
    })
    const delivered = [...pending, work(7, 'turn_finished', { result_text: 'Previous work is done.' }), reply(8), nativeStart,
      event(10, 'turn_finished', { run_id: 'reply-run', result_text: 'Agent message handled.' })]
    expect(updateQueuedTurns(updateQueuedTurns([], queued), nativeStart)).toEqual([])
    for (const rows of projections(delivered)) {
      expect(visibleOrder(rows)).toEqual(['user:1', 'activity:2', 'activity:6', 'assistant:7', 'delivery:8', 'assistant:10'])
      expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
    }
  })

  it('bounds each activity segment so full run detail pages cannot cross a message boundary', () => {
    const events = [start(), progress(2), message(3), progress(4), message(5, 'second-send'), progress(6)]
    const allDetails = events.filter(item => item.type === 'reasoning_summary')
    for (const rows of projections(events)) {
      const segments = rows.filter(row => row.kind === 'progress')
      expect(segments).toHaveLength(3)
      expect(segments.map(segment => allDetails.filter(item => {
        const seq = activityEventSequence(item, segment.orderingFinalEvents ?? segment.finalEvents)
        return (segment.afterSeq == null || seq > segment.afterSeq)
          && (segment.throughSeq == null || seq <= segment.throughSeq)
      }).map(item => item.seq))).toEqual([[2], [4], [6]])
      expect(segments.map(segment => segment.events.map(item => item.seq))).toEqual([[2], [4], [6]])
      expect(segments.map(segment => Boolean(segment.active))).toEqual([false, false, true])
    }
  })
})
