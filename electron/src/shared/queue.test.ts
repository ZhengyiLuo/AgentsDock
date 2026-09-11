import { describe, expect, it } from 'vitest'
import type { Event, QueuedTurn } from './types'
import { updateQueuedTurns } from './queue'

const queue: QueuedTurn[] = [
  { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'First', file_ids: [], position: 1, paused: false },
  { queued_id: 'queued-2', session_id: 'chat-1', prompt: 'Second', file_ids: [], position: 2, paused: true, pause_reason: 'stopped' }
]
const interruption: Event = {
  id: 'imported-control', session_id: 'chat-1', seq: 3,
  type: 'provider_interruption', ts: '2026-09-09T10:00:00Z', imported: true, backend: 'claude',
  provider_origin: {
    provider: 'claude', kind: 'interruption',
    event_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-09-09T10:00:00Z', cause: 'stop'
  },
  queued_id: 'queued-1', queued_ids: ['queued-1', 'queued-2'],
  superseded_queued_ids: ['queued-2'], promoted: true,
  positions: [{ queued_id: 'queued-1', position: 2 }, { queued_id: 'queued-2', position: 1 }]
}

describe('imported provider control queue neutrality', () => {
  it.each(['provider_interruption', 'history_imported', 'turn_finished'])('does not mutate queued turns from retained %s queue fields', type => {
    const control = type === 'provider_interruption' ? interruption : {
      ...interruption, type, metadata_only: true, run_id: 'import_control-only', provider_origin: undefined
    }
    const result = updateQueuedTurns(queue, control)
    expect(result).toBe(queue)
    expect(result.map(turn => [turn.queued_id, turn.position, turn.paused, turn.promoted])).toEqual([
      ['queued-1', 1, false, undefined],
      ['queued-2', 2, true, undefined]
    ])
  })

  it('keeps real start and pause events authoritative despite lookalike origin fields', () => {
    expect(updateQueuedTurns(queue, { ...interruption, type: 'turn_started', imported: false })).toEqual([queue[1]])
    expect(updateQueuedTurns(queue, { ...interruption, type: 'turn_queue_paused', imported: false })[0]).toMatchObject({
      queued_id: 'queued-1', paused: true, pause_reason: 'stopped'
    })
  })

  it('retains normal position updates without proven interruption provenance', () => {
    const result = updateQueuedTurns(queue, { ...interruption, provider_origin: undefined })
    expect(result.map(turn => turn.queued_id)).toEqual(['queued-2', 'queued-1'])
  })
})
