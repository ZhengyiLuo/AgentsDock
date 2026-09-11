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

describe('streamed async queued message bodies', () => {
  // Fields emitted together by async_route_queue_fields and the durable
  // turn_queue_updated receipt, independent of the short prompt preview.
  const original = 'Original agent report.\n'.repeat(220) + 'ORIGINAL-TAIL'
  const edited = 'Recipient edit: @Local and @@Remote remain plain text.\n'.repeat(110) + 'EDITED-TAIL'
  const queued: Event = {
    id: 'async-queued', session_id: 'recipient', seq: 1, ts: '2026-09-11T10:00:00Z', type: 'turn_queued',
    queued_id: 'queued-message', purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1',
    conversation_id: 'pair-example', message_id: 'message-example', cross_chat_envelope_id: 'message-example',
    source_session_id: 'sender', target_session_id: 'recipient', source_title: 'Peer agent',
    prompt: original.slice(0, 4096), message_body: original, message_revision: 0, message_edited_by_user: false,
    chat_references: [], team_references: [], position: 1
  }
  const update: Event = {
    ...queued, id: 'async-edited', seq: 2, type: 'turn_queue_updated',
    prompt: edited.slice(0, 4096), message_body: edited, message_revision: 1, message_edited_by_user: true
  }

  it('keeps the complete public body and initial edit revision on the first streamed arrival', () => {
    const result = updateQueuedTurns([], queued)
    expect(result).toMatchObject([{
      prompt: original, display_prompt: original, message_body: original, message_revision: 0,
      message_edited_by_user: false, source_title: 'Peer agent', cross_chat_envelope_id: 'message-example'
    }])
  })

  it('applies a committed edit atomically without losing its tail, sender, or plain-text intent', () => {
    const result = updateQueuedTurns(updateQueuedTurns([], queued), update)
    expect(result).toMatchObject([{
      prompt: edited, display_prompt: edited, message_body: edited, message_revision: 1,
      message_edited_by_user: true, source_session_id: 'sender', source_title: 'Peer agent',
      cross_chat_envelope_id: 'message-example', chat_references: [], team_references: []
    }])
  })

  it.each(['turn_queued', 'turn_queue_updated', 'turn_queue_delivery_fenced'])('does not regress a committed body on an older %s replay', type => {
    const committed: QueuedTurn = {
      queued_id: 'queued-message', session_id: 'recipient', purpose: queued.purpose,
      conversation_mode: 'async_route_v1', prompt: edited, display_prompt: edited, file_ids: [],
      message_body: edited, message_revision: 1, message_edited_by_user: true,
      source_session_id: 'sender', source_title: 'Peer agent', cross_chat_envelope_id: 'message-example'
    }
    const result = updateQueuedTurns([committed], { ...queued, type })
    expect(result).toMatchObject([{
      prompt: edited, display_prompt: edited, message_body: edited, message_revision: 1, message_edited_by_user: true
    }])
    if (type === 'turn_queue_delivery_fenced') expect(result[0]).toMatchObject({ paused: true, pause_reason: 'delivery_uncertain' })
  })

  it('retains versioned text during an unversioned position update while keeping legacy edits unchanged', () => {
    const current = updateQueuedTurns(updateQueuedTurns([], queued), update)
    const reordered = updateQueuedTurns(current, {
      ...queued, type: 'turn_queue_updated', position: 3, prompt: 'Old preview',
      purpose: null, conversation_mode: null,
      message_body: undefined, message_revision: undefined, message_edited_by_user: undefined
    })
    expect(reordered[0]).toMatchObject({ message_body: edited, prompt: edited, message_revision: 1, position: 3 })
    const ordinary = updateQueuedTurns(queue, { ...queued, queued_id: 'queued-1', type: 'turn_queue_updated',
      purpose: undefined, conversation_mode: undefined, message_body: undefined, message_revision: undefined,
      message_edited_by_user: undefined, prompt: 'A normal user edit' })
    expect(ordinary[0].prompt).toBe('A normal user edit')
    expect(ordinary[0].message_body).toBeUndefined()
  })
})
