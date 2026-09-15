import { describe, expect, it } from 'vitest'
import type { Event } from './types'
import {
  incompleteLeadingRunId,
  timelineSemanticItemCount,
  timelineSemanticUnits
} from './semantic-timeline'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`,
  session_id: 'chat',
  seq,
  type,
  ts: `2026-07-26T12:00:${String(seq).padStart(2, '0')}Z`,
  ...patch
})

describe('timeline semantic units', () => {
  it('does not count the internal reconciliation-consumed receipt as transcript content', () => {
    expect(timelineSemanticUnits([event(1, 'claude_background_task_reconciliation_consumed')])).toEqual([])
    expect(timelineSemanticUnits([event(1, 'assistant_text', { text: 'Claude Background Task Reconciliation Consumed' })])).toHaveLength(1)
  })

  it('counts provider interaction lifecycle history as one latest-anchored audit unit', () => {
    const units = timelineSemanticUnits([
      event(1, 'claude_interaction_requested', {
        interaction: {
          id: 'request-a', session_id: 'chat', thread_id: 'thread-a', method: 'item/tool/requestApproval',
          params: {}, created_at: '2026-07-26T12:00:01Z'
        }
      }),
      event(2, 'claude_interaction_resolved', { interaction_id: 'request-a', resolution: 'answered' }),
      event(7, 'claude_interaction_requested', {
        interaction: {
          id: 'request-b', session_id: 'chat', thread_id: 'thread-a', method: 'item/commandExecution/requestApproval',
          params: {}, created_at: '2026-07-26T12:00:07Z'
        }
      }),
      event(9, 'claude_interaction_resolved', { interaction_id: 'request-b', resolution: 'answered' })
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      key: 'provider-interaction-audit:claude:session',
      anchorSeq: 9
    })
    expect(units[0].events).toHaveLength(4)
  })

  it('does not merge provider interaction audits across runs', () => {
    const units = timelineSemanticUnits([
      event(1, 'cursor_interaction_requested', { run_id: 'run-a', interaction_id: 'request-a' }),
      event(2, 'cursor_interaction_resolved', { run_id: 'run-a', interaction_id: 'request-a' }),
      event(3, 'cursor_interaction_requested', { run_id: 'run-b', interaction_id: 'request-b' }),
      event(4, 'cursor_interaction_resolved', { run_id: 'run-b', interaction_id: 'request-b' })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'provider-interaction-audit:cursor:run-a',
      'provider-interaction-audit:cursor:run-b'
    ])
  })

  it('counts a cross-chat lifecycle as one semantic item', () => {
    const events = [
      event(1, 'cross_chat_handoff_registered', { handoff_id: 'handoff-a' }),
      event(4, 'cross_chat_handoff_running', { handoff_id: 'handoff-a' }),
      event(8, 'cross_chat_handoff_delivered', { handoff_id: 'handoff-a' })
    ]
    const units = timelineSemanticUnits(events)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ key: 'cross-chat:handoff:handoff-a', anchorSeq: 1 })
    expect(units[0].events).toHaveLength(3)
  })

  it('pages a target handoff lifecycle and its internal answer as one unit', () => {
    const common = {
      purpose: 'cross_chat_handoff_delivery',
      cross_chat_envelope_id: 'handoff-a',
      run_id: 'target-run'
    }
    const units = timelineSemanticUnits([
      event(1, 'cross_chat_handoff_received', { handoff_id: 'handoff-a' }),
      event(2, 'turn_started', { ...common, prompt: 'Untrusted relayed instruction' }),
      event(3, 'reasoning_summary', { ...common, text: 'Working on the request.' }),
      event(4, 'turn_finished', { ...common, result_text: 'Target answer' }),
      event(5, 'cross_chat_handoff_delivered', { handoff_id: 'handoff-a' })
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ key: 'cross-chat:handoff:handoff-a', anchorSeq: 1 })
    expect(units[0].events.map(candidate => candidate.type)).toEqual([
      'cross_chat_handoff_received',
      'turn_started',
      'reasoning_summary',
      'turn_finished',
      'cross_chat_handoff_delivered'
    ])
  })

  it('groups every exchange leg into one conversation boundary', () => {
    const firstDelivery = {
      purpose: 'cross_chat_handoff_delivery',
      cross_chat_exchange_id: 'exchange-a',
      cross_chat_exchange_leg_id: 'leg-1',
      run_id: 'target-run-1'
    }
    const secondDelivery = {
      purpose: 'cross_chat_handoff_delivery',
      cross_chat_exchange_id: 'exchange-a',
      cross_chat_exchange_leg_id: 'leg-2',
      run_id: 'target-run-2'
    }
    const units = timelineSemanticUnits([
      event(1, 'cross_chat_exchange_leg_received', { exchange_id: 'exchange-a', exchange_leg_id: 'leg-1', exchange_ordinal: 1 }),
      event(2, 'turn_started', { ...firstDelivery, prompt: 'Internal request prompt' }),
      event(3, 'reasoning_summary', { ...firstDelivery, text: 'Working on the request.' }),
      event(4, 'turn_finished', { ...firstDelivery, result_text: 'First response' }),
      event(5, 'cross_chat_exchange_leg_delivered', { exchange_id: 'exchange-a', exchange_leg_id: 'leg-1', exchange_leg_status: 'delivered' }),
      event(6, 'cross_chat_exchange_leg_received', { exchange_id: 'exchange-a', exchange_leg_id: 'leg-2', exchange_ordinal: 2 }),
      event(7, 'turn_started', { ...secondDelivery, prompt: 'Internal reply prompt' }),
      event(8, 'turn_finished', { ...secondDelivery, result_text: 'Second response' })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'cross-chat-exchange:exchange-a'
    ])
    expect(units[0].events).toHaveLength(8)
  })

  it('detects when a raw page starts in the middle of a run', () => {
    expect(incompleteLeadingRunId([
      event(20, 'tool_started', { run_id: 'long-run' }),
      event(21, 'assistant_text', { run_id: 'long-run', text: 'Done' })
    ])).toBe('long-run')
    expect(incompleteLeadingRunId([
      event(1, 'turn_started', { run_id: 'complete-run', prompt: 'Question' }),
      event(2, 'assistant_text', { run_id: 'complete-run', text: 'Answer' })
    ])).toBeNull()
  })

  it('counts a scheduled job, ordinary run, and handoff digest once each', () => {
    const events = [
      event(1, 'turn_started', { run_id: 'ordinary', prompt: 'Hello' }),
      event(2, 'assistant_text', { run_id: 'ordinary', text: 'Hi' }),
      event(3, 'job_ran', { run_id: 'scheduled-1', job_id: 'job-1' }),
      event(4, 'turn_started', { run_id: 'scheduled-1' }),
      event(5, 'turn_finished', { run_id: 'scheduled-1', result_text: 'Healthy' }),
      event(6, 'job_ran', { run_id: 'scheduled-2', job_id: 'job-1' }),
      event(7, 'turn_finished', { run_id: 'scheduled-2', result_text: 'Still healthy' }),
      event(8, 'handoff_digest_started', { digest_job_id: 'digest-1' }),
      event(9, 'handoff_digest_sent', { digest_job_id: 'digest-1' })
    ]

    expect(timelineSemanticItemCount(events)).toBe(3)
    expect(timelineSemanticUnits(events).map(unit => unit.key)).toEqual([
      'run:ordinary',
      'job:job-1',
      'digest:digest-1'
    ])
  })

  it('gives a run-scoped team send receipt its own system identity on reload', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_started', {
        run_id: 'scheduled-send', job_id: 'job-1', purpose: 'scheduled_job'
      }),
      event(2, 'team_message_sent', {
        id: 'team-send-1', run_id: 'scheduled-send', job_id: 'job-1',
        purpose: 'scheduled_job', message_id: 'message-1'
      }),
      event(3, 'job_finished', {
        run_id: 'scheduled-send', job_id: 'job-1', purpose: 'scheduled_job'
      })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      ['job:job-1', 1],
      ['event:team-send-1', 2]
    ])
    expect(units[0].events.map(candidate => candidate.type)).toEqual(['job_started', 'job_finished'])
    expect(units[1].events).toEqual([
      expect.objectContaining({ type: 'team_message_sent', run_id: 'scheduled-send' })
    ])
  })

  it('groups adjacent firings of the same scheduled job into one semantic unit', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_ran', { run_id: 'job-a-run-1', job_id: 'job-a' }),
      event(2, 'turn_finished', { run_id: 'job-a-run-1', result_text: 'First result' }),
      event(3, 'job_ran', { run_id: 'job-a-run-2', job_id: 'job-a' }),
      event(4, 'turn_finished', { run_id: 'job-a-run-2', result_text: 'Second result' })
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ key: 'job:job-a', anchorSeq: 1 })
    expect(units[0].events.map(candidate => candidate.id)).toEqual([
      'event-1',
      'event-2',
      'event-3',
      'event-4'
    ])
  })

  it('splits firings of the same scheduled job around an ordinary chat turn', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_ran', { run_id: 'job-a-run-1', job_id: 'job-a' }),
      event(2, 'turn_finished', { run_id: 'job-a-run-1', result_text: 'First job result' }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Interleaved answer' }),
      event(5, 'job_ran', { run_id: 'job-a-run-2', job_id: 'job-a' }),
      event(6, 'turn_finished', { run_id: 'job-a-run-2', result_text: 'Second job result' })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      ['job:job-a', 1],
      ['run:chat-run', 3],
      ['job:job-a:segment:5', 5]
    ])
    expect(units[0].events.map(candidate => candidate.run_id)).toEqual([
      'job-a-run-1',
      'job-a-run-1'
    ])
    expect(units[2].events.map(candidate => candidate.run_id)).toEqual([
      'job-a-run-2',
      'job-a-run-2'
    ])
  })

  it('keeps different jobs separate and treats them as grouping boundaries', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_ran', { run_id: 'job-a-run-1', job_id: 'job-a' }),
      event(2, 'turn_finished', { run_id: 'job-a-run-1', result_text: 'First A result' }),
      event(3, 'job_ran', { run_id: 'job-b-run-1', job_id: 'job-b' }),
      event(4, 'turn_finished', { run_id: 'job-b-run-1', result_text: 'B result' }),
      event(5, 'job_ran', { run_id: 'job-a-run-2', job_id: 'job-a' }),
      event(6, 'turn_finished', { run_id: 'job-a-run-2', result_text: 'Second A result' })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      ['job:job-a', 1],
      ['job:job-b', 3],
      ['job:job-a:segment:5', 5]
    ])
    expect(units.map(unit => [...new Set(unit.events.map(candidate => candidate.job_id).filter(Boolean))])).toEqual([
      ['job-a'],
      ['job-b'],
      ['job-a']
    ])
  })

  it('updates a late event in its original scheduled run without moving that group', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_ran', { run_id: 'job-a-run-1', job_id: 'job-a' }),
      event(2, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(3, 'turn_finished', { run_id: 'chat-run', result_text: 'Interleaved answer' }),
      event(4, 'turn_finished', { run_id: 'job-a-run-1', result_text: 'Late first result' }),
      event(5, 'job_ran', { run_id: 'job-a-run-2', job_id: 'job-a' }),
      event(6, 'turn_finished', { run_id: 'job-a-run-2', result_text: 'Second result' })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      ['job:job-a', 1],
      ['run:chat-run', 2],
      ['job:job-a:segment:5', 5]
    ])
    expect(units[0].events.map(candidate => candidate.id)).toEqual(['event-1', 'event-4'])
    expect(units[2].events.map(candidate => candidate.id)).toEqual(['event-5', 'event-6'])
  })

  it('uses explicit job timeline group IDs to keep detail and summaries segment-local', () => {
    const firstGroup = 'job:job-a:segment:1'
    const secondGroup = 'job:job-a:segment:5'
    const units = timelineSemanticUnits([
      event(1, 'reasoning_summary', { run_id: 'job-a-run-1', text: 'First detail' }),
      event(2, 'turn_finished', { run_id: 'job-a-run-1', result_text: 'First result' }),
      event(3, 'job_summary', {
        job_id: 'job-a', job_status_run_id: 'job-a-run-1', job_timeline_group_id: firstGroup
      }),
      event(4, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(5, 'reasoning_summary', { run_id: 'job-a-run-2', text: 'Second detail' }),
      event(6, 'turn_finished', { run_id: 'job-a-run-2', result_text: 'Second result' }),
      event(7, 'job_summary', {
        job_id: 'job-a', job_status_run_id: 'job-a-run-2', job_timeline_group_id: secondGroup
      })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      [firstGroup, 1],
      ['run:chat-run', 4],
      [secondGroup, 5]
    ])
    expect(units[0].events.map(candidate => candidate.id)).toEqual(['event-1', 'event-2', 'event-3'])
    expect(units[2].events.map(candidate => candidate.id)).toEqual(['event-5', 'event-6', 'event-7'])
  })

  it('keeps recycled run-ID occurrences bound to their own authoritative groups', () => {
    const units = timelineSemanticUnits([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_timeline_group_id: 'server-group-a'
      }),
      event(2, 'turn_finished', { run_id: 'recycled-run', result_text: 'A result' }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Boundary' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Boundary answer' }),
      event(5, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-b',
        job_timeline_group_id: 'server-group-b'
      }),
      event(6, 'turn_finished', { run_id: 'recycled-run', result_text: 'B result' })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'server-group-a',
      'run:chat-run',
      'server-group-b'
    ])
    expect(units[0].events.map(candidate => candidate.id)).toEqual(['event-1', 'event-2'])
    expect(units[2].events.map(candidate => candidate.id)).toEqual(['event-5', 'event-6'])
  })

  it('routes a late recycled-run event by its stable scheduled occurrence', () => {
    const units = timelineSemanticUnits([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_000_000
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', job_scheduled_run_at: 1_775_000_000,
        result_text: 'First result'
      }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Boundary' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Boundary answer' }),
      event(5, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_003_600
      }),
      event(6, 'turn_finished', {
        run_id: 'recycled-run', job_scheduled_run_at: 1_775_003_600,
        result_text: 'Second result'
      }),
      event(7, 'job_finished', {
        run_id: 'recycled-run', job_id: 'job-a',
        job_scheduled_run_at: 1_775_000_000, message: 'Late first completion'
      })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'job:job-a',
      'run:chat-run',
      'job:job-a:segment:5'
    ])
    expect(units[0].events.map(candidate => candidate.id)).toEqual(['event-1', 'event-2', 'event-7'])
    expect(units[2].events.map(candidate => candidate.id)).toEqual(['event-5', 'event-6'])
  })

  it('uses nested scheduled time to keep a runless deferral on its original unit', () => {
    const scheduledJob = (scheduledRunAt: number) => ({
      id: 'job-a', session_id: 'chat', title: 'Capacity monitor', prompt: 'Check capacity',
      interval_seconds: 3_600, scheduled_run_at: scheduledRunAt
    })
    const units = timelineSemanticUnits([
      event(1, 'job_deferred', {
        job_id: 'job-a', job: scheduledJob(1_775_000_000), message: 'First deferral'
      }),
      event(2, 'turn_started', { run_id: 'chat-run', prompt: 'Boundary' }),
      event(3, 'turn_finished', { run_id: 'chat-run', result_text: 'Boundary answer' }),
      event(4, 'job_deferred', {
        job_id: 'job-a', job: scheduledJob(1_775_000_000), message: 'Late retry deferral'
      }),
      event(5, 'job_deferred', {
        job_id: 'job-a', job: scheduledJob(1_775_003_600), message: 'Next occurrence deferral'
      })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'job:job-a',
      'run:chat-run',
      'job:job-a:segment:5'
    ])
    expect(units[0].events.map(candidate => candidate.id)).toEqual(['event-1', 'event-4'])
    expect(units[2].events.map(candidate => candidate.id)).toEqual(['event-5'])
  })

  it('keeps digest-delivery responses and run-scoped errors as separate rows', () => {
    const units = timelineSemanticUnits([
      event(1, 'handoff_digest_received', { digest_job_id: 'digest-1' }),
      event(2, 'turn_started', {
        run_id: 'delivery',
        digest_job_id: 'digest-1',
        purpose: 'handoff_digest_delivery'
      }),
      event(3, 'assistant_text', {
        run_id: 'delivery',
        digest_job_id: 'digest-1',
        purpose: 'handoff_digest_delivery'
      }),
      event(4, 'artifact_error', { run_id: 'delivery', error: 'failed' })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'digest:digest-1',
      'run:delivery',
      'event:event-4'
    ])
  })

  it('orders ordinary units and recurring-job groups by their first event', () => {
    const units = timelineSemanticUnits([
      event(1, 'turn_started', { run_id: 'long-turn', prompt: 'Long question' }),
      event(2, 'error', { error: 'Independent failure' }),
      event(3, 'job_ran', { run_id: 'job-run-1', job_id: 'job-1' }),
      event(4, 'turn_finished', { run_id: 'long-turn', result_text: 'Long answer' }),
      event(5, 'turn_started', { run_id: 'job-run-1' }),
      event(6, 'turn_finished', { run_id: 'job-run-1', result_text: 'Job answer' }),
      event(7, 'job_ran', { run_id: 'job-run-2', job_id: 'job-1' }),
      event(8, 'turn_finished', { run_id: 'job-run-2', result_text: 'Latest job answer' })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq])).toEqual([
      ['run:long-turn', 1],
      ['event:event-2', 2],
      ['job:job-1', 3]
    ])
  })

  it('uses a later explicit legacy job link for earlier scheduled-run events', () => {
    const units = timelineSemanticUnits([
      event(1, 'turn_started', {
        run_id: 'legacy-run',
        purpose: 'scheduled_job',
        prompt: 'Check training'
      }),
      event(2, 'turn_finished', {
        run_id: 'legacy-run',
        purpose: 'scheduled_job',
        result_text: 'Training is healthy'
      }),
      event(3, 'job_ran', {
        run_id: 'legacy-run',
        job_id: 'job-1'
      })
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      key: 'job:job-1',
      anchorSeq: 1
    })
    expect(units[0].events.map(candidate => candidate.id)).toEqual([
      'event-1',
      'event-2',
      'event-3'
    ])
  })

  it.each([
    'job_status_run_id',
    'job_latest_status_run_id',
    'job_latest_run_id'
  ] as const)('groups metadata-light scheduled activity through the %s summary alias', runField => {
    const units = timelineSemanticUnits([
      event(1, 'reasoning_summary', {
        run_id: 'current-job-run',
        text: 'Checking current capacity.'
      }),
      event(2, 'tool_started', {
        run_id: 'current-job-run',
        tool: { name: 'capacity_check' }
      }),
      event(3, 'job_summary', {
        purpose: 'scheduled_job',
        job_id: 'job-1',
        [runField]: 'current-job-run'
      })
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      key: 'job:job-1',
      anchorSeq: 1
    })
    expect(units[0].events.map(candidate => candidate.type)).toEqual([
      'reasoning_summary',
      'tool_started',
      'job_summary'
    ])
  })

  it('does not fold an unrelated live turn into an aliased scheduled-job run', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_summary', {
        purpose: 'scheduled_job',
        job_id: 'job-1',
        job_status_run_id: 'current-job-run'
      }),
      event(2, 'reasoning_summary', {
        run_id: 'current-job-run',
        text: 'Checking current capacity.'
      }),
      event(3, 'turn_started', {
        run_id: 'interactive-run',
        prompt: 'Explain the latest result.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'interactive-run',
        text: 'Reviewing the latest result.'
      })
    ])

    expect(units.map(unit => unit.key)).toEqual([
      'job:job-1',
      'run:interactive-run'
    ])
  })

  it('excludes runtime status and native-steer bookkeeping from page counts', () => {
    const events = [
      event(1, 'codex_thread_status', { message: 'Codex is working.' }),
      event(2, 'turn_stopped', { run_id: 'old-run', superseded_by_run_id: 'steered-run' }),
      event(3, 'turn_started', { run_id: 'steered-run', prompt: 'New direction' })
    ]

    expect(timelineSemanticItemCount(events)).toBe(1)
    expect(timelineSemanticUnits(events).map(unit => unit.key)).toEqual(['run:steered-run'])
  })

  it('retains a native-steer stop when it terminates a scheduled job run', () => {
    const common = {
      run_id: 'job-run',
      purpose: 'scheduled_job',
      job_id: 'job-1'
    }
    const units = timelineSemanticUnits([
      event(1, 'turn_started', { ...common, prompt: 'Check status' }),
      event(2, 'reasoning_summary', { ...common, text: 'Checking status.' }),
      event(3, 'turn_stopped', {
        ...common,
        native_steer: true,
        superseded_by_run_id: 'user-run'
      }),
      event(4, 'turn_started', {
        run_id: 'user-run',
        native_steer: true,
        steer_interrupted_run_id: 'job-run',
        prompt: 'New request'
      })
    ])

    expect(units.map(unit => unit.key)).toEqual(['job:job-1', 'run:user-run'])
    expect(units[0].events.map(candidate => candidate.type)).toEqual([
      'turn_started',
      'reasoning_summary',
      'turn_stopped'
    ])
  })

  it('retains a metadata-light native stop through an earlier legacy job link', () => {
    const units = timelineSemanticUnits([
      event(1, 'job_ran', { run_id: 'legacy-job-run', job_id: 'job-1' }),
      event(2, 'reasoning_summary', { run_id: 'legacy-job-run', text: 'Checking status.' }),
      event(3, 'turn_stopped', {
        run_id: 'legacy-job-run',
        native_steer: true,
        superseded_by_run_id: 'user-run'
      })
    ])

    expect(units).toHaveLength(1)
    expect(units[0].key).toBe('job:job-1')
    expect(units[0].events.map(candidate => candidate.type)).toEqual([
      'job_ran',
      'reasoning_summary',
      'turn_stopped'
    ])
  })

  it('keeps goal state out of page counts and anchors compaction at its start', () => {
    const units = timelineSemanticUnits([
      event(1, 'codex_goal_updated'),
      event(2, 'codex_compaction_started', { operation_id: 'compact-1' }),
      event(3, 'codex_goal_cleared'),
      event(4, 'codex_token_usage', { context_tokens: 12_000, context_window: 258_400 }),
      event(5, 'codex_compaction_completed', { operation_id: 'compact-1' })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq, unit.events.length])).toEqual([
      ['codex:compaction:compact-1', 2, 2]
    ])
  })

  it('keeps separate native compaction items in the same turn distinct', () => {
    const units = timelineSemanticUnits([
      event(1, 'codex_compaction_started', {
        compaction_id: 'native:thread-1:turn-1:item-1',
        operation_id: 'shared-operation',
        turn_id: 'turn-1',
        item_id: 'item-1'
      }),
      event(2, 'codex_compaction_completed', {
        compaction_id: 'native:thread-1:turn-1:item-1',
        operation_id: 'shared-operation',
        turn_id: 'turn-1',
        item_id: 'item-1'
      }),
      event(3, 'codex_compaction_started', {
        compaction_id: 'native:thread-1:turn-1:item-2',
        operation_id: 'shared-operation',
        turn_id: 'turn-1',
        item_id: 'item-2'
      }),
      event(4, 'codex_compaction_completed', {
        compaction_id: 'native:thread-1:turn-1:item-2',
        operation_id: 'shared-operation',
        turn_id: 'turn-1',
        item_id: 'item-2'
      })
    ])

    expect(units.map(unit => [unit.key, unit.anchorSeq, unit.events.length])).toEqual([
      ['codex:compaction:native:thread-1:turn-1:item-1', 1, 2],
      ['codex:compaction:native:thread-1:turn-1:item-2', 3, 2]
    ])
  })
})
