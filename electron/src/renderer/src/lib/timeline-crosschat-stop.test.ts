import { beforeEach, describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `stop-edge-${seq}`, session_id: 'local', seq, type,
  ts: `2026-09-11T10:00:0${seq}Z`, ...fields
})

describe('an empty stopped activity tail stays after its sent message', () => {
  beforeEach(clearTimelineProjectionCache)

  it.each([
    ['codex', 'turn_finished'], ['codex', 'turn_stopped'],
    ['claude', 'turn_finished'], ['claude', 'turn_stopped']
  ] as const)('%s %s keeps the live-tail key when stopping without output', (backend, terminalType) => {
    const sent = event(3, 'chat_conversation_message_registered', {
      run_id: 'working-run', conversation_mode: 'async_route_v1', conversation_id: 'local-peer-pair',
      message_id: 'outgoing', handoff_id: 'outgoing', cross_chat_envelope_id: 'outgoing',
      source_session_id: 'local', target_session_id: 'peer', source_title: 'Local agent', target_title: 'Peer agent',
      handoff_action: 'instruction', handoff_status: 'registered', handoff_preview: 'Synthetic message.'
    })
    const prefix = [
      event(1, 'turn_started', { run_id: 'working-run', backend, prompt: 'Continue the synthetic task.' }),
      event(2, 'reasoning_summary', { run_id: 'working-run', backend, phase: 'commentary', text: 'Before sending.' }),
      sent
    ]
    const live = cachedTimelineProjection('stop-edge', prefix, []).rendered
    const tailKey = live.at(-1)?.key
    expect(live.at(-1)).toMatchObject({ kind: 'progress', active: true, events: [] })
    const stopped = [...prefix, event(4, terminalType, {
      run_id: 'working-run', backend, stopped: true, result_text: ''
    })]
    for (const events of [stopped, [...stopped, {
      ...sent, id: 'stop-edge-5', seq: 5, ts: '2026-09-11T10:00:05Z',
      type: 'chat_conversation_message_delivered', handoff_status: 'delivered'
    }]]) {
      const appended = cachedTimelineProjection('stop-edge', events, []).rendered
      expect(appended).toEqual(renderTimelineItems(projectTimeline(events, [])))
      expect(appended.map(row => row.kind)).toEqual(['message', 'progress', 'system', 'progress'])
      expect(appended.at(-1)).toMatchObject({ key: tailKey, active: false, events: [],
        stoppedAt: '2026-09-11T10:00:04Z', terminalSeq: 4 })
      expect(appended[1]).toMatchObject({ kind: 'progress', active: false, continues: true, stoppedAt: undefined })
    }
  })
})
