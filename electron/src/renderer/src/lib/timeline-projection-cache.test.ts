import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { cachedTimelineProjection, clearTimelineProjectionCache, dropTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`,
  session_id: 'chat-1',
  seq,
  type,
  ts: `2026-07-15T10:00:${String(seq).padStart(2, '0')}Z`,
  ...patch
})

const exchangeLeg = (seq: number, leg: 'request' | 'reply', patch: Partial<Event> = {}): Event =>
  event(seq, 'cross_chat_exchange_leg_registered', {
    exchange_id: 'exchange-one', exchange_leg_id: `${leg}-leg`, exchange_leg_kind: leg,
    exchange_ordinal: leg === 'request' ? 1 : 2, exchange_max_legs: 2,
    source_session_id: leg === 'request' ? 'chat-1' : 'peer',
    target_session_id: leg === 'request' ? 'peer' : 'chat-1',
    handoff_preview: `${leg} body`, ...patch
  })

describe('timeline projection cache', () => {
  it('replaces split exchange-leg rows exactly once when a leg receives a live update', () => {
    clearTimelineProjectionCache()
    const events = [exchangeLeg(1, 'request'), exchangeLeg(2, 'reply')]
    const first = cachedTimelineProjection('split-legs-live', events, [])
    expect(first.rendered.filter(row => row.kind === 'system' && row.crossChatLegId)).toHaveLength(2)
    const updated = [...events, exchangeLeg(3, 'reply', {
      type: 'cross_chat_exchange_leg_delivered', exchange_leg_status: 'delivered', exchange_status: 'completed'
    })]
    const next = cachedTimelineProjection('split-legs-live', updated, [])
    expect(next.strategy).toBe('append')
    expect(next.rendered.filter(row => row.kind === 'system' && row.crossChatLegId)).toHaveLength(2)
    expect(new Set(next.rendered.map(row => row.key)).size).toBe(next.rendered.length)
    expect(next.rendered).toEqual(cachedTimelineProjection('split-legs-cold', updated, []).rendered)
  })

  it('retains one unresolved imported-delivery card and its files when its answer arrives, preserving a human quotation', () => {
    clearTimelineProjectionCache()
    const prompt = '[AgentsDock delivery kind=reply leg=2/2 origin=route from=Peer]\n'
      + '[Source user instruction — verbatim, user-authored]\nReview the renderer.\n[End source user instruction]\n'
      + '[Agent-prepared reply/result]\nThe exact reply body.\n[End agent-prepared reply/result]\n'
      + 'reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.\n[End delivery]'
    const files: AgentFile[] = [{ id: 'delivery-file', session_id: 'chat-1', filename: 'result.txt', content_type: 'text/plain' }]
    const events = [
      event(1, 'turn_started', { run_id: 'human-run', prompt }),
      event(2, 'turn_finished', { run_id: 'human-run', result_text: 'Human quotation retained.' }),
      event(3, 'turn_started', { run_id: 'import_unresolved', imported: true, backend: 'claude', prompt, file_ids: ['delivery-file'] })
    ]
    cachedTimelineProjection('unresolved-delivery-live', events, files)
    const updated = [...events, event(4, 'assistant_text', {
      run_id: 'import_unresolved', imported: true, backend: 'claude', text: 'The imported answer.'
    })]
    const next = cachedTimelineProjection('unresolved-delivery-live', updated, files)
    expect(next.strategy).toBe('append')
    expect(next.rendered.filter(row => row.kind === 'system' && row.importedDelivery)).toHaveLength(1)
    expect(next.rendered.filter(row => row.key.endsWith(':delivery-files'))).toHaveLength(1)
    expect(next.rendered.filter(row => row.kind === 'message' && row.role === 'user'))
      .toMatchObject([{ event: { id: events[0].id, prompt } }])
    expect(next.rendered).toEqual(cachedTimelineProjection('unresolved-delivery-cold', updated, files).rendered)
  })

  it('carries an unchanged exchange reply across an updated turn without rerendering intervening history', () => {
    clearTimelineProjectionCache()
    const events = [exchangeLeg(1, 'request')]
    for (let turn = 0; turn < 200; turn++) {
      events.push(
        event(turn * 2 + 2, 'turn_started', { run_id: `past-${turn}`, prompt: 'Earlier question' }),
        event(turn * 2 + 3, 'turn_finished', { run_id: `past-${turn}`, result_text: 'Earlier answer' })
      )
    }
    events.push(
      event(402, 'turn_started', { run_id: 'current-turn', prompt: 'Current question' }),
      event(403, 'assistant_text', { run_id: 'current-turn', text: 'First output.' }),
      exchangeLeg(404, 'reply')
    )
    const first = cachedTimelineProjection('crossing-reply-live', events, [])
    const updated = [...events, event(405, 'assistant_text', { run_id: 'current-turn', text: 'More output.' })]
    const next = cachedTimelineProjection('crossing-reply-live', updated, [])
    expect(next.strategy).toBe('append')
    expect(next.renderedSemanticCount).toBe(2)
    expect(next.rendered[0]).toBe(first.rendered[0])
    expect(next.rendered.filter(row => row.kind === 'system' && row.crossChatLegId)).toHaveLength(2)
    expect(next.rendered).toEqual(cachedTimelineProjection('crossing-reply-cold', updated, []).rendered)
  })

  it('reuses the exact rendered projection when reopening an unchanged chat', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Hello' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Hi' })
    ]
    const files: AgentFile[] = []
    const first = cachedTimelineProjection('chat-1:live', events, files)
    const second = cachedTimelineProjection('chat-1:live', events, files)

    expect(second.semantic).toBe(first.semantic)
    expect(second.rendered).toBe(first.rendered)
    expect(second.strategy).toBe('reuse')
  })

  it('retains unchanged rows when only the live tail advances', () => {
    clearTimelineProjectionCache()
    const firstEvents = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'First' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Done' }),
      event(3, 'turn_started', { run_id: 'run-2', prompt: 'Second' })
    ]
    const first = cachedTimelineProjection('chat-1:live', firstEvents, [])
    const next = cachedTimelineProjection('chat-1:live', [
      ...firstEvents,
      event(4, 'assistant_text', { run_id: 'run-2', text: 'Working' })
    ], [])

    expect(next.rendered[0]).toBe(first.rendered[0])
    expect(next.rendered[1]).toBe(first.rendered[1])
    expect(next.rendered.at(-1)).not.toBe(first.rendered.at(-1))
    expect(next.strategy).toBe('append')
  })

  it('appends native goal continuations after prior finals without stale or duplicate rows', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'goal-run', backend: 'codex', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', { run_id: 'goal-run', phase: 'commentary', text: 'Initial progress.' }),
      event(3, 'assistant_text', { run_id: 'goal-run', text: 'Initial answer.' })
    ]
    const first = cachedTimelineProjection('chat-1:goal-live', events, [])
    events.push(event(4, 'reasoning_summary', { run_id: 'goal-run', phase: 'commentary', text: 'Continuation progress.' }))
    const second = cachedTimelineProjection('chat-1:goal-live', events, [])
    expect(second.strategy).toBe('append')
    expect(second.rendered[2]).toBe(first.rendered[2])
    expect(second.rendered.at(-1)).toMatchObject({ kind: 'progress', active: true, afterSeq: 3, events: [{ seq: 4 }] })
    const continuationKey = second.rendered.at(-1)?.key
    events.push(event(5, 'assistant_text', { run_id: 'goal-run', text: 'Continuation answer.' }))
    const third = cachedTimelineProjection('chat-1:goal-live', events, [])
    expect(third.rendered.find(row => row.key === continuationKey)).toMatchObject({ active: false })
    events.push(event(6, 'tool_finished', { run_id: 'goal-run', tool_id: 'next-tool' }))
    const fourth = cachedTimelineProjection('chat-1:goal-live', events, [])
    expect(fourth.rendered.at(-1)).toMatchObject({ kind: 'progress', active: true, afterSeq: 5, events: [{ seq: 6 }] })
    expect(new Set(fourth.rendered.map(row => row.key)).size).toBe(fourth.rendered.length)
    expect(fourth.rendered).toEqual(cachedTimelineProjection('chat-1:goal-cold', events, []).rendered)
  })

  it('rebuilds on the new source revision when an interior event is corrected', () => {
    clearTimelineProjectionCache()
    const firstEvents = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Question' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'Old answer' }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Old answer' })
    ]
    const first = cachedTimelineProjection('chat-1:corrected', firstEvents, [])
    const corrected = event(2, 'assistant_text', { run_id: 'run-1', text: 'Corrected answer' })
    const next = cachedTimelineProjection('chat-1:corrected-revision-2', [firstEvents[0], corrected, firstEvents[2]], [])

    expect(next.strategy).toBe('rebuild')
    expect(next.rendered).not.toBe(first.rendered)
    expect(next.semantic[0]).not.toBe(first.semantic[0])
  })

  it('does not append onto an older source revision after an interior correction', () => {
    clearTimelineProjectionCache()
    const firstEvents = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Question' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'Old answer' }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Old answer' })
    ]
    cachedTimelineProjection('chat-1:corrected-append', firstEvents, [])
    const corrected = event(2, 'assistant_text', { run_id: 'run-1', text: 'Corrected answer' })
    const next = cachedTimelineProjection('chat-1:corrected-append-revision-2', [
      firstEvents[0],
      corrected,
      firstEvents[2],
      event(4, 'server_notice', { message: 'Tail advanced' })
    ], [])

    expect(next.strategy).toBe('rebuild')
    expect(next.semantic).toHaveLength(2)
  })

  it('renders only the appended semantic tail of a long completed chat', () => {
    clearTimelineProjectionCache()
    const events: Event[] = []
    for (let turn = 0; turn < 1_000; turn += 1) {
      const startSeq = turn * 2 + 1
      const runId = `run-${turn}`
      events.push(
        event(startSeq, 'turn_started', { run_id: runId, prompt: `Question ${turn}` }),
        event(startSeq + 1, 'turn_finished', { run_id: runId, result_text: `Answer ${turn}` })
      )
    }
    const first = cachedTimelineProjection('chat-1:long-live', events, [])
    const next = cachedTimelineProjection('chat-1:long-live', [
      ...events,
      event(2_001, 'server_notice', { message: 'Live tail advanced' })
    ], [])

    expect(first.semantic).toHaveLength(1_000)
    expect(next.strategy).toBe('append')
    expect(next.semantic).toHaveLength(1_001)
    expect(next.renderedSemanticCount).toBe(1)
    expect(next.rendered[0]).toBe(first.rendered[0])
    expect(next.rendered.at(-1)).toMatchObject({ kind: 'system', event: { seq: 2_001 } })
  })

  it('does not mistake completed activity rows for the live edge', () => {
    clearTimelineProjectionCache()
    const events: Event[] = []
    for (let turn = 0; turn < 200; turn += 1) {
      const startSeq = turn * 3 + 1
      const runId = `run-${turn}`
      events.push(
        event(startSeq, 'turn_started', { run_id: runId, prompt: `Question ${turn}` }),
        event(startSeq + 1, 'reasoning_summary', { run_id: runId, text: `Checking ${turn}` }),
        event(startSeq + 2, 'turn_finished', { run_id: runId, result_text: `Answer ${turn}` })
      )
    }
    const first = cachedTimelineProjection('chat-1:completed-activity', events, [])
    const next = cachedTimelineProjection('chat-1:completed-activity', [
      ...events,
      event(601, 'server_notice', { message: 'Live tail advanced' })
    ], [])

    expect(first.rendered.some(item => item.kind === 'progress' && item.active === false)).toBe(true)
    expect(next.strategy).toBe('append')
    expect(next.renderedSemanticCount).toBe(1)
    expect(next.rendered[0]).toBe(first.rendered[0])
    expect(next.rendered.at(-1)).toMatchObject({ kind: 'system', event: { seq: 601 } })
  })

  it('keeps live progress stable when a system event is appended', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-live', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-live',
        phase: 'commentary',
        text: 'Working through it'
      })
    ]
    const first = cachedTimelineProjection('chat-1:progress-live', events, [])
    const next = cachedTimelineProjection('chat-1:progress-live', [
      ...events,
      event(3, 'server_notice', { message: 'Connection recovered' })
    ], [])

    expect(first.rendered.at(-1)?.kind).toBe('progress')
    expect(next.renderedSemanticCount).toBe(1)
    expect(next.rendered.at(-2)?.kind).toBe('progress')
    expect(next.rendered.at(-1)).toMatchObject({ kind: 'system', event: { seq: 3 } })
  })

  it('does not rerender when an appended event has no timeline presentation', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Hello' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Hi' })
    ]
    const first = cachedTimelineProjection('chat-1:hidden-tail', events, [])
    const next = cachedTimelineProjection('chat-1:hidden-tail', [
      ...events,
      event(3, 'turn_queue_updated', { queued_id: 'queued-1', prompt: 'Later' }),
      event(4, 'turn_queue_paused', { queued_id: 'queued-1' }),
      event(5, 'turn_queue_delivery_fenced', { queued_id: 'queued-1' }),
      event(6, 'claude_subagents_stopped', { run_id: 'run-1' })
    ], [])

    expect(next.strategy).toBe('append')
    expect(next.renderedSemanticCount).toBe(0)
    expect(next.rendered).toBe(first.rendered)
  })

  it('keeps historical compactions while incrementally rendering a new tail', () => {
    clearTimelineProjectionCache()
    const events: Event[] = [
      event(1, 'turn_started', { run_id: 'run-0', prompt: 'First' }),
      event(2, 'codex_compaction_started', {
        run_id: 'run-0',
        thread_id: 'thread-1',
        compaction_id: 'native:thread-1:turn-0:item-1'
      }),
      event(3, 'codex_compaction_completed', {
        run_id: 'run-0',
        thread_id: 'thread-1',
        compaction_id: 'native:thread-1:turn-0:item-1'
      }),
      event(4, 'turn_finished', { run_id: 'run-0', result_text: 'First answer' })
    ]
    for (let turn = 1; turn < 500; turn += 1) {
      const startSeq = turn * 2 + 3
      const runId = `run-${turn}`
      events.push(
        event(startSeq, 'turn_started', { run_id: runId, prompt: `Question ${turn}` }),
        event(startSeq + 1, 'turn_finished', { run_id: runId, result_text: `Answer ${turn}` })
      )
    }
    const nextEvents = [
      ...events,
      event(1_004, 'server_notice', { message: 'New tail' })
    ]
    const first = cachedTimelineProjection('chat-1:compacted-live', events, [])
    const next = cachedTimelineProjection('chat-1:compacted-live', nextEvents, [])
    const cold = cachedTimelineProjection('chat-1:compacted-cold', nextEvents, [])

    expect(first.rendered.some(item => item.kind === 'system' && item.event.type === 'codex_compaction_completed')).toBe(true)
    expect(next.strategy).toBe('append')
    expect(next.renderedSemanticCount).toBe(1)
    expect(next.rendered).toEqual(cold.rendered)
  })

  it('merges newly loaded file metadata without rebuilding the event projection', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect this', file_ids: ['file-1'] }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Done' })
    ]
    const first = cachedTimelineProjection('chat-1:live', events, [])
    const file: AgentFile = { id: 'file-1', filename: 'trace.png', content_type: 'image/png' }
    const next = cachedTimelineProjection('chat-1:live', events, [file])

    expect(next.strategy).toBe('files')
    expect(next.semantic).not.toBe(first.semantic)
    expect(next.semantic[0]).toMatchObject({ kind: 'turn', files: [file] })
    expect(next.rendered.at(-1)).toMatchObject({ kind: 'message', event: events[1] })
  })

  it('incrementally advances a large recurring job without retaining every raw event', () => {
    clearTimelineProjectionCache()
    const events: Event[] = [event(1, 'job_started', { job_id: 'job-1', run_id: 'run-1' })]
    for (let seq = 2; seq <= 12_000; seq += 1) {
      events.push(event(seq, 'tool_finished', { job_id: 'job-1', run_id: 'run-1', output: `poll ${seq}` }))
    }
    const first = cachedTimelineProjection('chat-1:live', events, [])
    const next = cachedTimelineProjection('chat-1:live', [
      ...events,
      event(12_001, 'turn_finished', { job_id: 'job-1', run_id: 'run-1', result_text: 'Healthy' })
    ], [])

    expect(next.strategy).toBe('append')
    expect(next.semantic).toHaveLength(1)
    expect(next.semantic[0]).toMatchObject({
      kind: 'job', eventCount: 12_001, runCount: 1, startSeq: 1, endSeq: 12_001
    })
    expect(next.semantic[0].kind === 'job' ? next.semantic[0].events.length : 0).toBeLessThan(8)
    expect(next.rendered[0]).not.toBe(first.rendered[0])
  })

  it('rebuilds once when a late scheduler link reclassifies an existing turn', () => {
    clearTimelineProjectionCache()
    const firstEvents = [event(1, 'turn_started', { run_id: 'run-job', prompt: 'Check status' })]
    cachedTimelineProjection('chat-1:live', firstEvents, [])
    const next = cachedTimelineProjection('chat-1:live', [
      ...firstEvents,
      event(2, 'job_ran', { run_id: 'run-job', job_id: 'job-1', job_title: 'Status check' }),
      event(3, 'turn_finished', { run_id: 'run-job', result_text: 'Healthy' })
    ], [])

    expect(next.strategy).toBe('rebuild')
    expect(next.semantic).toHaveLength(1)
    expect(next.semantic[0]).toMatchObject({ kind: 'job', title: 'Status check', eventCount: 3 })
  })

  it('updates a scheduled run in its original segment and starts a new card after a chat boundary', () => {
    clearTimelineProjectionCache()
    const firstEvents = [
      event(1, 'job_started', { job_id: 'job-1', run_id: 'job-run-1' }),
      event(2, 'turn_started', { run_id: 'chat-run', prompt: 'Hello' }),
      event(3, 'turn_finished', { run_id: 'chat-run', result_text: 'Hi' })
    ]
    const first = cachedTimelineProjection('chat-1:live', firstEvents, [])
    const completedEvents = [
      ...firstEvents,
      event(4, 'turn_finished', { job_id: 'job-1', run_id: 'job-run-1', result_text: 'Still healthy' })
    ]
    const completed = cachedTimelineProjection('chat-1:live', completedEvents, [])

    expect(first.semantic.map(item => item.kind)).toEqual(['job', 'turn'])
    expect(completed.strategy).toBe('append')
    expect(completed.semantic.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-1'],
      ['turn', 'turn:chat-run']
    ])
    expect(completed.semantic[0]).toMatchObject({
      kind: 'job', seq: 1, startSeq: 1, endSeq: 4,
      latest: { run_id: 'job-run-1', result_text: 'Still healthy' }
    })
    expect(completed.rendered.map(item => item.kind)).toEqual(['job', 'message', 'message'])

    const nextRunEvents = [
      ...completedEvents,
      event(5, 'turn_finished', {
        job_id: 'job-1', run_id: 'job-run-2', purpose: 'scheduled_job', result_text: 'Healthy again'
      })
    ]
    const nextRun = cachedTimelineProjection('chat-1:live', nextRunEvents, [])

    expect(nextRun.strategy).toBe('append')
    expect(nextRun.semantic.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-1'],
      ['turn', 'turn:chat-run'],
      ['job', 'job:job-1:segment:5']
    ])
    expect(nextRun.semantic.at(-1)).toMatchObject({
      kind: 'job', seq: 5, startSeq: 5, endSeq: 5, runCount: 1,
      latest: { run_id: 'job-run-2', result_text: 'Healthy again' }
    })
  })

  it('drops only the background chat projection', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Hello' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Done' })
    ]
    const files: AgentFile[] = []
    const first = cachedTimelineProjection('chat-1:live:0', events, files)
    const other = cachedTimelineProjection('chat-2:live:0', events, files)

    dropTimelineProjectionCache('chat-1')

    expect(cachedTimelineProjection('chat-1:live:0', events, files).rendered).not.toBe(first.rendered)
    expect(cachedTimelineProjection('chat-2:live:0', events, files).rendered).toBe(other.rendered)
  })

  it('keeps projections separate for identical session IDs on different profiles', () => {
    clearTimelineProjectionCache()
    const events = [event(1, 'turn_started', { run_id: 'run-1', prompt: 'Hello' })]
    const profileA = cachedTimelineProjection('profile-a:shared-chat:live:0', events, [])
    const profileB = cachedTimelineProjection('profile-b:shared-chat:live:0', events, [])

    expect(profileB.rendered).not.toBe(profileA.rendered)
    expect(cachedTimelineProjection('profile-a:shared-chat:live:0', events, []).rendered).toBe(profileA.rendered)
    expect(cachedTimelineProjection('profile-b:shared-chat:live:0', events, []).rendered).toBe(profileB.rendered)
  })

  it('rebuilds when authoritative Codex thread ownership changes', () => {
    clearTimelineProjectionCache()
    const events = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(2, 'codex_compaction_started', {
        run_id: 'run-1',
        thread_id: 'thread-a',
        compaction_id: 'native:thread-a:turn-1:item-1'
      })
    ]
    const first = cachedTimelineProjection('chat-1:live', events, [], {
      rootThreadId: 'thread-a',
      activeRunId: 'run-1'
    })
    const next = cachedTimelineProjection('chat-1:live', events, [], {
      rootThreadId: 'thread-b',
      activeRunId: 'run-1'
    })

    expect(first.semantic.some(item => item.kind === 'system')).toBe(true)
    expect(next.semantic.some(item => item.kind === 'system')).toBe(false)
    expect(next.strategy).toBe('rebuild')
  })
})
