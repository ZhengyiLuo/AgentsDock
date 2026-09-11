import { describe, expect, it } from 'vitest'
import type { Event, QueuedTurn } from '@shared/types'
import type { JobItem, SystemItem } from './timeline'
import { omitQueuedPendingTimelineItems } from './timeline-pending-queue'

describe('pending timeline queue presentation', () => {
  it('moves only exact pending incoming deliveries and job occurrences into the queue', () => {
    const incoming: Event = {
      id: 'incoming', session_id: 'target', seq: 2, ts: '2026-09-09T00:00:00Z',
      type: 'cross_chat_exchange_leg_queued', exchange_id: 'exchange', exchange_leg_id: 'leg',
      exchange_status: 'active', exchange_leg_status: 'queued',
      source_session_id: 'source', target_session_id: 'target', queued_id: 'queued-message'
    }
    const system = (id: string, event: Event, events = [event]): SystemItem => ({
      kind: 'system', id, key: id, seq: event.seq, event, events
    })
    const pending: Event = {
      id: 'deferred', session_id: 'target', seq: 3, ts: incoming.ts, type: 'job_deferred',
      job_id: 'job', job_scheduled_run_at: 100, queued_id: 'queued-job', message: 'Chat is busy.'
    }
    const job: JobItem = {
      kind: 'job', id: 'pending-job', key: 'pending-job', jobId: 'job', seq: 3, title: 'Scheduled check',
      events: [pending], latest: pending, latestStatus: pending, runCount: 0, eventCount: 1, startSeq: 3, endSeq: 3
    }
    const otherOccurrence = { ...pending, queued_id: null, job_scheduled_run_at: 101 }
    const previousResult = { ...pending, type: 'turn_finished', run_id: 'previous-run', result_text: 'Prior report' }
    const items = [
      system('pending-incoming', incoming),
      system('full-pending-lifecycle', incoming, [
        { ...incoming, type: 'cross_chat_exchange_registered', exchange_leg_status: 'registered' },
        { ...incoming, type: 'cross_chat_exchange_leg_registered', exchange_leg_status: 'registered' },
        { ...incoming, type: 'cross_chat_exchange_leg_received', exchange_leg_status: 'submitting' },
        incoming
      ]),
      system('legacy-pending-handoff', { ...incoming, type: 'cross_chat_handoff_queued', handoff_status: 'queued' }, [
        { ...incoming, type: 'cross_chat_handoff_registered', handoff_status: 'registered' },
        { ...incoming, type: 'cross_chat_handoff_received', handoff_status: 'submitting' },
        { ...incoming, type: 'cross_chat_handoff_queued', handoff_status: 'queued' }
      ]),
      system('outgoing-wait', { ...incoming, source_session_id: 'target', target_session_id: 'source' }),
      system('mixed-history', incoming, [{ ...incoming, seq: 1, type: 'cross_chat_exchange_leg_delivered', exchange_leg_status: 'delivered' }, incoming]),
      system('started', { ...incoming, type: 'cross_chat_exchange_leg_started', exchange_leg_status: 'running' }),
      system('unmatched', { ...incoming, queued_id: 'another-message' }),
      job,
      { ...job, id: 'job-history', key: 'job-history', runCount: 1, events: [previousResult, pending] },
      { ...job, id: 'other-occurrence', key: 'other-occurrence', events: [otherOccurrence], latest: otherOccurrence, latestStatus: otherOccurrence }
    ]
    const queue: QueuedTurn[] = [{
      queued_id: 'queued-message', session_id: 'target', prompt: 'Incoming instruction', file_ids: [],
      purpose: 'cross_chat_handoff_delivery', cross_chat_exchange_id: 'exchange', cross_chat_exchange_leg_id: 'leg'
    }, {
      queued_id: 'queued-job', session_id: 'target', prompt: 'Scheduled check', file_ids: [],
      purpose: 'scheduled_job', job_id: 'job', job_scheduled_run_at: 100
    }]

    expect(omitQueuedPendingTimelineItems(items, queue, 'target').map(item => item.id)).toEqual([
      'outgoing-wait', 'mixed-history', 'started', 'unmatched', 'job-history', 'other-occurrence'
    ])
    expect(omitQueuedPendingTimelineItems(items, [], 'target')).toBe(items)
    expect(omitQueuedPendingTimelineItems(items, queue.map(turn => ({ ...turn, promoted: true })), 'target')).toBe(items)
  })
})
