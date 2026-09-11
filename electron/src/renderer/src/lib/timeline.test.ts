import { describe, expect, it } from 'vitest'
import type { AgentFile, Event } from '@shared/types'
import { extractStructuredToolDiff, extractUnifiedDiff, importedCrossChatDelivery, isAgentVisibleEvent, isTimelineError, jobDisplayEvents, jobDisplaySelection, jobResultPresentation, messageItemText, messageText, parseReviewableDiff, parseUnifiedDiff, projectTimeline, reconcileRenderTimelineItems, reconcileTimelineItems, renderTimelineItems, reviewTargetBelongsToSession, sameCodeReviewTarget, settleInactiveTimelineItems, summarizeStructuredToolDiff, TimelineProjector, type RenderTimelineItem, type TimelineItem } from './timeline'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: `2026-07-09T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})

function importedDeliveryPrompt(kind = 'reply', body = 'The renderer audit is complete.', sender = 'DEMO-A Scalable') {
  const label = kind === 'reply' ? 'Agent-prepared reply/result' : 'Agent-prepared handoff message'
  return `[AgentsDock delivery kind=${kind} leg=2/2 origin=route from=${sender}]\n`
    + '[Source user instruction — verbatim, user-authored]\nReview the renderer.\n[End source user instruction]\n'
    + `[${label}]\n${body}\n[End ${label.toLowerCase()}]\n`
    + 'reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.\n[End delivery]'
}

describe('projectTimeline', () => {
  it('ignores proven control-only import companions without creating or finishing a turn', () => {
    const history = event(2, 'history_imported', { backend: 'claude', imported: true, metadata_only: true, run_id: 'import_control' })
    const finished = event(3, 'turn_finished', { backend: 'claude', imported: true, metadata_only: true,
      run_id: 'import_control', result_text: 'Legacy companion payload must not become an answer.', is_error: true })
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'live-run', prompt: 'Real work is still running' }), history, finished,
      event(4, 'assistant_text', { run_id: 'live-run', text: 'Real work continues' })
    ], [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'turn', runId: 'live-run', trace: [] })
    expect(items[0].kind === 'turn' && items[0].finishedAt).toBeUndefined()
    const rows = renderTimelineItems(items)
    expect(rows.filter(item => item.kind === 'message')).toHaveLength(2)
    expect(rows.some(item => item.kind === 'system')).toBe(false)
    expect(isAgentVisibleEvent(finished)).toBe(false)
    expect(isTimelineError(finished)).toBe(false)
  })

  it('preserves normal imported completion output without the exact control-only companion flag', () => {
    const finished = event(2, 'turn_finished', { backend: 'claude', imported: true,
      run_id: 'import_normal', result_text: 'The actual imported answer.' })
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend: 'claude', imported: true, run_id: 'import_normal', prompt: 'Actual imported user turn' }), finished
    ], []))
    expect(rows.filter(item => item.kind === 'message')).toHaveLength(2)
    expect(isAgentVisibleEvent(finished)).toBe(true)
    expect(rows.some(item => item.kind === 'message' && messageItemText(item) === 'The actual imported answer.')).toBe(true)
  })

  it('projects proven imported interruptions as deduplicated neutral history without changing a live run', () => {
    const control = event(3, 'provider_interruption', {
      imported: true, backend: 'claude', run_id: 'live-run', job_id: 'not-a-job', purpose: 'scheduled_job',
      prompt: '[Request interrupted by user]', is_error: true,
      provider_origin: { provider: 'claude', kind: 'interruption', cause: 'steer',
        event_id: '6ab1aa42-7518-4ad3-9175-e605e381936e', session_id: 'f8061024-af24-4765-a395-74c638c37b03',
        timestamp: '2026-09-09T20:16:54.515Z' }
    })
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'live-run', prompt: 'Continue the actual work' }),
      event(2, 'assistant_text', { run_id: 'live-run', text: 'Before control metadata' }), control,
      { ...control, seq: 4, id: 'duplicate-import-id', provider_origin: {
        ...control.provider_origin!, event_id: control.provider_origin!.event_id.toUpperCase()
      } },
      event(5, 'assistant_text', { run_id: 'live-run', text: 'After control metadata' })
    ], [])
    expect(items.filter(item => item.kind === 'turn')).toHaveLength(1)
    const liveTurn = items.find(item => item.kind === 'turn')
    expect(liveTurn).toMatchObject({ runId: 'live-run' })
    expect(liveTurn?.finishedAt).toBeUndefined()
    expect(items.some(item => item.kind === 'job')).toBe(false)
    const rows = renderTimelineItems(items)
    const systems = rows.filter(item => item.kind === 'system')
    expect(systems).toHaveLength(1)
    expect(systems[0]).toMatchObject({ seq: 3, event: { type: 'provider_interruption', prompt: null, ts: '2026-09-09T20:16:54.515Z' } })
    expect(rows.filter(item => item.kind === 'message' && item.role === 'user')).toHaveLength(1)
    expect(isTimelineError(control)).toBe(false)
    expect(isAgentVisibleEvent(control)).toBe(false)
  })

  it.each([false, true])('preserves unproven interruption text authored or imported as a user turn (imported=%s)', imported => {
    const prompt = '[Request interrupted by user]'
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend: 'claude', imported, prompt })
    ], []))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(rows[0].kind === 'message' && messageItemText(rows[0])).toBe(prompt)
  })

  it.each(['codex', 'claude'] as const)('presents a skipped zero-leg %s status without a synthetic user message', backend => {
    const prompt = '[AgentsDock delivery kind=status leg=0/2 origin=route from=AgentsDock Sept]\n'
      + '[Source user instruction — verbatim, user-authored]\nTell @AgentsDock Sept to fix this\n[End source user instruction]\n'
      + '[Server-generated exchange status]\nThe cross-chat exchange ended before the other chat could answer.\nReason: queued target delivery was skipped by the user\n[End server-generated exchange status]\n'
      + 'reply: none (terminal status notice; do not respond to the exchange)\n[End delivery]'
    const start = event(1, 'turn_started', { backend, imported: true, run_id: 'import_skipped', prompt })
    const rows = renderTimelineItems(projectTimeline([start], []))
    expect(rows[0]).toMatchObject({ kind: 'system', importedDelivery: { kind: 'status', sender: 'AgentsDock Sept' } })
    expect(rows.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(rows[0].kind === 'system' && rows[0].event.prompt).toBeNull()
    expect(importedCrossChatDelivery({ ...start, imported: false })).toBeNull()
    expect(importedCrossChatDelivery({ ...start, prompt: prompt.replace('kind=status', 'kind=request') })).toBeNull()
    expect(importedCrossChatDelivery({ ...start, prompt: prompt.replace('[End delivery]', '') })).toBeNull()
  })

  it.each(['codex', 'claude'] as const)('renders an imported %s delivery as a read-only agent message, preserving its answer', backend => {
    const prompt = importedDeliveryPrompt()
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend, imported: true, run_id: 'import_reply', prompt }),
      event(2, 'assistant_text', { backend, imported: true, run_id: 'import_reply', text: 'I will use that result.' }),
      event(3, 'turn_finished', { backend, imported: true, run_id: 'import_reply' })
    ], []))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      kind: 'system', key: 'imported-cross-chat-delivery:event-1',
      importedDelivery: { sender: 'DEMO-A Scalable', kind: 'reply', body: 'The renderer audit is complete.', sourceRequest: 'Review the renderer.' },
      event: { prompt: null, text: 'The renderer audit is complete.' }
    })
    expect(rows[0].kind === 'system' && rows[0].event.exchange_id).toBeUndefined()
    expect(rows[1]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(rows[1].kind === 'message' && messageItemText(rows[1])).toBe('I will use that result.')
  })

  it('keeps multiple deliveries and ordinary messages distinct inside one imported run', () => {
    const common = { backend: 'claude' as const, imported: true, run_id: 'import_shared' }
    const events = [
      event(1, 'turn_started', { ...common, prompt: importedDeliveryPrompt('request', 'First request', 'Audit') }),
      event(2, 'assistant_text', { ...common, text: 'First answer' }),
      event(3, 'turn_started', { ...common, prompt: importedDeliveryPrompt('reply', 'Second reply', 'Submitter') }),
      event(4, 'assistant_text', { ...common, text: 'Second answer' }),
      event(5, 'turn_started', { ...common, prompt: importedDeliveryPrompt('instruction', 'Third instruction', 'Audit') }),
      event(6, 'assistant_text', { ...common, text: 'Third answer' }),
      event(7, 'turn_started', { ...common, prompt: 'A real user follow-up.' }),
      event(8, 'assistant_text', { ...common, text: 'Fourth answer' }),
      event(9, 'turn_finished', common)
    ]
    const projector = new TimelineProjector([])
    for (const value of events) expect(projector.append([value])).toBe(true)
    const rows = renderTimelineItems(projector.items)
    expect(rows).toEqual(renderTimelineItems(projectTimeline(events, [])))
    expect(rows.filter(row => row.kind === 'system').map(row => row.key)).toEqual([
      'imported-cross-chat-delivery:event-1', 'imported-cross-chat-delivery:event-3', 'imported-cross-chat-delivery:event-5'
    ])
    expect(rows.filter(row => row.kind === 'message').map(row => messageItemText(row))).toEqual([
      'First answer', 'Second answer', 'Third answer', 'A real user follow-up.', 'Fourth answer'
    ])
  })

  it.each([
    ['codex', 'instruction', 'reply: optional one-time terminal reply route via the respond command in the provider-authority block, only if a result, acknowledgement, or clarification should reach the origin; never add --request-response.'],
    ['claude', 'instruction', 'reply: optional one-time terminal reply route via the respond command in the provider-authority block, only if a result, acknowledgement, or clarification should reach the origin; never add --request-response.'],
    ['codex', 'request', 'reply: exactly one terminal response remains; use the respond command in the provider-authority block without --request-response.'],
    ['claude', 'request', 'reply: exactly one terminal response remains; use the respond command in the provider-authority block without --request-response.']
  ] as const)('recovers the legacy terminal footer in imported %s %s history', (backend, kind, footer) => {
    const prompt = importedDeliveryPrompt(kind, 'The audit is ready.', 'Audit')
      .replace('leg=2/2', 'leg=1/2')
      .replace('reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.',
        footer)
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend, imported: true, run_id: 'import_legacy_instruction', prompt }),
      event(2, 'assistant_text', { backend, imported: true, run_id: 'import_legacy_instruction', text: 'Preserved answer.' })
    ], []))
    expect(rows[0]).toMatchObject({ kind: 'system', importedDelivery: { sender: 'Audit', kind, body: 'The audit is ready.' } })
    expect(rows[1]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(rows[1].kind === 'message' && messageItemText(rows[1])).toBe('Preserved answer.')
  })

  it('strips the known legacy authority suffix without suppressing imported Claude delivery output', () => {
    const prompt = importedDeliveryPrompt() + '\n\n[AgentsDock provider authority]\n'
      + 'authority-file=/Users/test/.agentsdock/cross_chat_authority/run_aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)\n'
      + 'actions=cross_chat_instruction\nusage: see AgentsDock instructions\n[End AgentsDock provider authority]'
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend: 'claude', imported: true, run_id: 'import_claude', prompt }),
      event(2, 'assistant_text', { backend: 'claude', imported: true, run_id: 'import_claude', text: 'Preserved reply' })
    ], []))
    expect(rows[0]).toMatchObject({ kind: 'system', importedDelivery: { body: 'The renderer audit is complete.' } })
    expect(rows[1]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(rows[1].kind === 'message' && messageItemText(rows[1])).toBe('Preserved reply')
    const withUserNote = event(4, 'turn_started', {
      backend: 'claude', imported: true, run_id: 'import_claude', prompt: `${prompt}\nKeep this additional user note.`
    })
    expect(importedCrossChatDelivery(withUserNote)).toBeNull()
    const noteRows = renderTimelineItems(projectTimeline([withUserNote], []))
    expect(noteRows[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(noteRows[0].kind === 'message' && messageItemText(noteRows[0])).toContain('Keep this additional user note.')

    const unknownFooter = { ...withUserNote, prompt: prompt.replace('reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.', 'Unknown future footer.') }
    const unknownRows = renderTimelineItems(projectTimeline([
      unknownFooter,
      event(5, 'assistant_text', { run_id: 'import_claude', text: 'Keep the imported answer.' })
    ], []))
    expect(unknownRows.map(row => row.kind)).toEqual(['message', 'message'])
    expect(unknownRows[0].kind === 'message' && messageItemText(unknownRows[0])).toContain('Unknown future footer.')
    expect(unknownRows[1].kind === 'message' && messageItemText(unknownRows[1])).toBe('Keep the imported answer.')

    const suffix = prompt.slice(importedDeliveryPrompt().length)
    const mixed = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { backend: 'claude', imported: true, run_id: 'import_shared', prompt: `A native prompt echo${suffix}` }),
      event(2, 'assistant_text', { backend: 'claude', imported: true, run_id: 'import_shared', text: 'Duplicated native answer' }),
      event(3, 'turn_started', { backend: 'claude', imported: true, run_id: 'import_shared', prompt }),
      event(4, 'assistant_text', { backend: 'claude', imported: true, run_id: 'import_shared', text: 'Actual delivery answer' }),
      event(5, 'turn_started', { backend: 'claude', imported: true, run_id: 'import_shared', prompt: 'Actual user follow-up' }),
      event(6, 'assistant_text', { backend: 'claude', imported: true, run_id: 'import_shared', text: 'Actual user answer' })
    ], []))
    expect(mixed[0]).toMatchObject({ kind: 'system', key: 'imported-cross-chat-delivery:event-3' })
    expect(mixed.filter(row => row.kind === 'message').map(row => messageItemText(row))).toEqual([
      'Actual delivery answer', 'Actual user follow-up', 'Actual user answer'
    ])
  })

  it('preserves input attachments on an imported delivery as a separate media row', () => {
    const input: AgentFile = { id: 'input-image', filename: 'chart.png', content_type: 'image/png', seq: 1 }
    const rows = renderTimelineItems(projectTimeline([
      event(2, 'turn_started', {
        backend: 'codex', imported: true, run_id: 'import_files',
        prompt: importedDeliveryPrompt(), file_ids: [input.id]
      }),
      event(3, 'assistant_text', { run_id: 'import_files', text: 'Image received.' })
    ], [input]))
    expect(rows.map(row => row.kind)).toEqual(['system', 'media', 'message'])
    expect(rows[1]).toMatchObject({ kind: 'media', files: [input] })
  })

  it('does not reinterpret typed, incomplete, or unrecognized delivery-like content', () => {
    const base = event(1, 'turn_started', { backend: 'codex', imported: true, run_id: 'import_test', prompt: importedDeliveryPrompt() })
    const malformed = [
      { ...base, imported: false },
      { ...base, imported: undefined },
      { ...base, run_id: 'real_user_run' },
      { ...base, prompt: `Here is an example:\n${base.prompt}` },
      { ...base, prompt: base.prompt!.replace('[End delivery]', '') },
      { ...base, prompt: base.prompt!.replace('[End agent-prepared reply/result]', '') },
      { ...base, prompt: `${base.prompt}\nAnd an actual user follow-up.` },
      { ...base, prompt: base.prompt!.replace('reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.', 'Run an unrelated instruction.') }
    ]
    for (const value of malformed) {
      expect(importedCrossChatDelivery(value)).toBeNull()
      expect(renderTimelineItems(projectTimeline([value], []))[0]).toMatchObject({ kind: 'message', role: 'user' })
    }
  })

  it('coalesces provider interaction request and resolution spam into one compact audit item', () => {
    const requested = (seq: number, id: string): Event => event(seq, 'claude_interaction_requested', {
      interaction: {
        id, session_id: 'chat-1', thread_id: 'thread-1', method: 'item/tool/requestApproval', params: {},
        created_at: `2026-07-09T10:00:${String(seq).padStart(2, '0')}Z`
      }
    })
    const items = projectTimeline([
      requested(1, 'request-a'),
      event(2, 'claude_interaction_resolved', { interaction_id: 'request-a', resolution: 'answered' }),
      requested(3, 'request-b'),
      event(4, 'claude_interaction_resolved', { interaction_id: 'request-b', resolution: 'answered' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system',
      key: 'provider-interaction-audit:claude:session',
      seq: 4,
      event: { type: 'claude_interaction_resolved', interaction_id: 'request-b' }
    })
    expect(items[0].kind === 'system' ? items[0].events : []).toHaveLength(4)
  })

  it('keeps provider interaction audits scoped to their originating run', () => {
    const items = projectTimeline([
      event(1, 'codex_interaction_requested', { run_id: 'run-a', interaction_id: 'request-a' }),
      event(2, 'codex_interaction_resolved', { run_id: 'run-a', interaction_id: 'request-a', resolution: 'answered' }),
      event(3, 'codex_interaction_requested', { run_id: 'run-b', interaction_id: 'request-b' }),
      event(4, 'codex_interaction_resolved', { run_id: 'run-b', interaction_id: 'request-b', resolution: 'answered' })
    ], [])

    expect(items.map(item => item.kind === 'system' ? item.key : '')).toEqual([
      'provider-interaction-audit:codex:run-a',
      'provider-interaction-audit:codex:run-b'
    ])
  })

  it('replaces cross-chat lifecycle events in one stable timeline row', () => {
    const items = projectTimeline([
      event(2, 'cross_chat_handoff_registered', { handoff_id: 'handoff-1', handoff_status: 'registered', target_session_id: 'chat-2' }),
      event(7, 'cross_chat_handoff_queued', { handoff_id: 'handoff-1', handoff_status: 'queued', target_session_id: 'chat-2' }),
      event(9, 'cross_chat_handoff_delivered', { handoff_id: 'handoff-1', handoff_status: 'delivered', target_session_id: 'chat-2' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system',
      key: 'cross-chat:handoff:handoff-1',
      seq: 2,
      event: { type: 'cross_chat_handoff_delivered', handoff_status: 'delivered' }
    })
  })

  it('suppresses the synthetic user row for a handoff delivery but keeps its answer', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'cross_chat_handoff_received', { handoff_id: 'handoff-1', source_session_id: 'chat-2', target_session_id: 'chat-1' }),
      event(2, 'turn_started', { run_id: 'delivery', purpose: 'cross_chat_handoff_delivery', cross_chat_envelope_id: 'handoff-1', prompt: 'Untrusted relayed instruction' }),
      event(3, 'turn_finished', { run_id: 'delivery', purpose: 'cross_chat_handoff_delivery', cross_chat_envelope_id: 'handoff-1', result_text: 'Target result' }),
      event(4, 'cross_chat_handoff_delivered', { handoff_id: 'handoff-1', source_session_id: 'chat-2', target_session_id: 'chat-1' })
    ], []))

    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(0)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'system')).toHaveLength(1)
  })

  it('places a cross-chat card where it arrived inside a completed turn', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', text: 'First checkpoint' }),
      event(3, 'cross_chat_handoff_received', {
        handoff_id: 'handoff-mid-turn', source_session_id: 'chat-2', target_session_id: 'chat-1'
      }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Finished after the handoff' }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Finished after the handoff' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message', 'progress', 'system', 'message'])
    expect(rows[2]).toMatchObject({ kind: 'system', seq: 3, event: { type: 'cross_chat_handoff_received' } })
  })

  it('embeds a cross-chat card between live commentary updates at its arrival sequence', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-live', prompt: 'Keep monitoring' }),
      event(2, 'reasoning_summary', { run_id: 'run-live', phase: 'commentary', text: 'Before the handoff.' }),
      event(3, 'cross_chat_handoff_received', {
        handoff_id: 'handoff-live', source_session_id: 'chat-2', target_session_id: 'chat-1'
      }),
      event(4, 'reasoning_summary', { run_id: 'run-live', phase: 'commentary', text: 'After the handoff.' })
    ], []))
    const progress = rows.find((row): row is Extract<RenderTimelineItem, { kind: 'progress' }> => row.kind === 'progress')

    expect(progress?.lifecycle).toBeUndefined()
    expect(rows.find(row => row.kind === 'system')).toMatchObject({ seq: 3, event: { type: 'cross_chat_handoff_received' } })

    const settled = settleInactiveTimelineItems(rows)
    expect(settled.map(row => row.kind)).toEqual(['message', 'progress', 'system'])
    expect(settled[1]).toMatchObject({
      kind: 'progress', active: false
    })
  })

  it('suppresses a beta3-purpose exchange prompt while retaining native reasoning, tools, artifacts, and final', () => {
    const file: AgentFile = { id: 'exchange-artifact', filename: 'result.mp4', content_type: 'video/mp4', seq: 6 }
    const common = {
      run_id: 'exchange-delivery',
      purpose: 'cross_chat_handoff_delivery',
      cross_chat_exchange_id: 'exchange-1',
      cross_chat_exchange_leg_id: 'leg-1'
    }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'cross_chat_exchange_leg_received', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_ordinal: 1,
        exchange_leg_kind: 'request', exchange_direction: 'incoming'
      }),
      event(2, 'turn_started', { ...common, prompt: 'Internal exchange prompt' }),
      event(3, 'reasoning_summary', { ...common, text: 'Inspecting the request.' }),
      event(4, 'tool_started', { ...common, tool: { name: 'Bash' } }),
      event(5, 'assistant_text', { ...common, text: 'Target answer' }),
      event(6, 'artifact_created', { ...common, artifact: file }),
      event(7, 'turn_finished', { ...common, result_text: 'Target answer' }),
      event(8, 'cross_chat_exchange_leg_delivered', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_ordinal: 1,
        exchange_leg_kind: 'request', exchange_leg_status: 'delivered'
      })
    ], [file]))

    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(0)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'progress')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'media')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'system')).toHaveLength(1)
  })

  it('groups an exchange into one conversation and never resurrects stale controls', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'cross_chat_exchange_leg_started', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
        exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_expects_reply: true
      }),
      event(2, 'cross_chat_exchange_registered', {
        exchange_id: 'exchange-1', exchange_status: 'active'
      })
    ])).toBe(true)
    expect(projector.append([
      event(3, 'cross_chat_exchange_cancelled', {
        exchange_id: 'exchange-1', exchange_status: 'cancelled'
      })
    ])).toBe(true)
    expect(projector.append([
      event(4, 'cross_chat_exchange_leg_delivered', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
        exchange_leg_status: 'delivered', exchange_leg_kind: 'request', exchange_expects_reply: true
      })
    ])).toBe(true)
    const items = projector.items

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: 'cross-chat-exchange:exchange-1',
      event: { type: 'cross_chat_exchange_leg_delivered', exchange_status: 'cancelled' }
    })
    expect(items[0].kind === 'system' ? items[0].events : []).toEqual([
      expect.objectContaining({ type: 'cross_chat_exchange_leg_started', exchange_status: 'cancelled' }),
      expect.objectContaining({ type: 'cross_chat_exchange_registered', exchange_status: 'cancelled' }),
      expect.objectContaining({ type: 'cross_chat_exchange_cancelled', exchange_status: 'cancelled' }),
      expect.objectContaining({ type: 'cross_chat_exchange_leg_delivered', exchange_status: 'cancelled' })
    ])
  })

  it('keeps late exchange history in one first-event-anchored conversation row', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(15, 'session_note', { message: 'Between exchange events' }),
      event(20, 'cross_chat_exchange_leg_delivered', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-2', exchange_ordinal: 2,
        exchange_leg_kind: 'reply', exchange_leg_status: 'delivered', exchange_status: 'completed'
      })
    ])).toBe(true)

    expect(projector.append([
      event(10, 'cross_chat_exchange_registered', {
        exchange_id: 'exchange-1', exchange_status: 'active'
      }),
      event(11, 'cross_chat_exchange_leg_delivered', {
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_ordinal: 1,
        exchange_leg_kind: 'request', exchange_leg_status: 'delivered', exchange_status: 'active'
      })
    ])).toBe(true)

    expect(projector.items.map(item => item.key)).toEqual([
      'cross-chat-exchange:exchange-1',
      'event:event-15'
    ])
    expect(projector.items[0]).toMatchObject({
      seq: 10,
      event: { exchange_leg_id: 'leg-2', exchange_status: 'completed' }
    })
    expect(projector.items[0].kind === 'system' ? projector.items[0].events?.map(item => item.seq) : []).toEqual([10, 11, 20])
  })

  it('projects raw provider traffic into one semantic turn with media at the end', () => {
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4', seq: 5 }
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Render it' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', text: 'Checking inputs' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Finished.' }),
      event(5, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(6, 'turn_finished', { run_id: 'run-1', result_text: 'Finished.' })
    ], [file])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'turn', files: [file] })
    if (items[0].kind === 'turn') {
      expect(items[0].assistant).toHaveLength(1)
      expect(items[0].trace.map(item => item.type)).toEqual(['reasoning_summary', 'tool_started'])
    }
  })

  it('routes a late artifact to its matching run instead of the active turn', () => {
    const file: AgentFile = {
      id: 'late-video', filename: 'late-result.mp4', content_type: 'video/mp4'
    }
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Render the video' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Rendered.' }),
      event(3, 'turn_started', { run_id: 'run-2', prompt: 'Start something else' }),
      event(4, 'artifact_created', { run_id: 'run-1', artifact: file })
    ], [file])

    const first = items.find(item => item.kind === 'turn' && item.runId === 'run-1')
    const second = items.find(item => item.kind === 'turn' && item.runId === 'run-2')
    expect(first?.kind === 'turn' ? first.files : []).toEqual([file])
    expect(second?.kind === 'turn' ? second.files : []).toEqual([])
  })

  it('keeps a run-scoped artifact visible when its earlier turn page is not loaded yet', () => {
    const file: AgentFile = {
      id: 'paged-video', filename: 'paged-result.mp4', content_type: 'video/mp4'
    }
    const items = projectTimeline([
      event(40, 'artifact_created', { run_id: 'run-from-older-page', artifact: file })
    ], [file])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'turn',
      runId: 'run-from-older-page',
      files: [file]
    })
  })

  it('never attaches an explicitly foreign file from fork history', () => {
    const foreign: AgentFile = {
      id: 'parent-file',
      session_id: 'parent-chat',
      filename: 'parent-output.png',
      content_type: 'image/png'
    }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', {
        run_id: 'forked-run',
        prompt: 'Forked text remains',
        file_ids: [foreign.id]
      }),
      event(2, 'assistant_text', { run_id: 'forked-run', text: 'Forked answer remains' }),
      event(3, 'artifact_created', {
        run_id: 'forked-run',
        artifact: foreign
      })
    ], [foreign]))

    expect(rows.filter(row => row.kind === 'message')).toHaveLength(2)
    expect(rows.some(row => row.kind === 'media')).toBe(false)
    expect(rows.every(row => !('files' in row) || row.files.length === 0)).toBe(true)
  })

  it('collapses repeated deferred notices for the same queued message', () => {
    const items = projectTimeline([
      event(1, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' }),
      event(2, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' }),
      event(3, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system',
      key: 'turn-deferred:queued-1',
      seq: 3,
      event: { id: 'event-3' }
    })
  })

  it('retires a deferred notice when the queued message starts', () => {
    const items = projectTimeline([
      event(1, 'turn_queued', { queued_id: 'queued-1', prompt: 'Run this' }),
      event(2, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' }),
      event(3, 'turn_started', { queued_id: 'queued-1', run_id: 'run-1', prompt: 'Run this' })
    ], [])

    expect(items.some(item => item.key === 'turn-deferred:queued-1')).toBe(false)
    expect(items).toMatchObject([{ kind: 'turn', runId: 'run-1' }])
  })

  it('moves an incrementally updated deferred notice to its latest timeline position', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' }),
      event(2, 'error', { message: 'A separate warning' })
    ])).toBe(true)
    expect(projector.items.map(item => item.key)).toEqual([
      'turn-deferred:queued-1',
      'event:event-2'
    ])

    expect(projector.append([
      event(3, 'turn_deferred', { queued_id: 'queued-1', message: 'Provider is still starting.' })
    ])).toBe(true)
    expect(projector.items.map(item => item.key)).toEqual([
      'event:event-2',
      'turn-deferred:queued-1'
    ])
  })

  it('keeps a user message visible when its turn stops without assistant text', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'stopped-run', prompt: 'This message must remain visible' }),
      event(2, 'turn_stopped', { run_id: 'stopped-run' }),
      event(3, 'turn_finished', { run_id: 'stopped-run', result_text: '' })
    ], []))

    const user = rows.find(row => row.kind === 'message' && row.role === 'user')
    expect(user?.kind === 'message' ? messageItemText(user) : null).toBe('This message must remain visible')
  })

  it('hides runtime-only Codex status and native-steer transition stops while preserving a real stop', () => {
    const items = projectTimeline([
      event(1, 'codex_thread_status', {
        message: 'Codex is working.',
        status: { type: 'active', activeFlags: [] }
      }),
      event(2, 'turn_stopped', {
        run_id: 'superseded-run',
        superseded_by_run_id: 'steered-run',
        message: 'Previous logical run superseded.'
      }),
      event(3, 'codex_thread_status', {
        message: 'Codex is idle.',
        status: { type: 'idle' }
      }),
      event(4, 'turn_stopped', { message: 'Stopped by user.' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system',
      event: { id: 'event-4', type: 'turn_stopped' }
    })
  })

  it('keeps a native-steer stop as the terminal status of an interrupted scheduled job', () => {
    const common = {
      run_id: 'job-run',
      purpose: 'scheduled_job',
      job_id: 'job-1',
      job_title: 'Status check'
    }
    const items = projectTimeline([
      event(1, 'turn_started', { ...common, prompt: 'Check status' }),
      event(2, 'reasoning_summary', {
        ...common,
        phase: 'commentary',
        text: 'Checking the current status.'
      }),
      event(3, 'tool_started', { ...common, tool: { name: 'exec' } }),
      event(4, 'turn_stopped', {
        ...common,
        native_steer: true,
        superseded_by_run_id: 'user-run'
      }),
      event(5, 'turn_started', {
        run_id: 'user-run',
        native_steer: true,
        steer_interrupted_run_id: 'job-run',
        prompt: 'New user request'
      }),
      event(6, 'reasoning_summary', {
        run_id: 'user-run',
        text: 'Following the new request.'
      })
    ], [])

    expect(items).toHaveLength(2)
    const job = items.find(item => item.kind === 'job')
    expect(job).toMatchObject({
      kind: 'job',
      key: 'job:job-1',
      latestStatus: {
        type: 'turn_stopped',
        run_id: 'job-run',
        native_steer: true
      }
    })
    expect(job?.kind === 'job' ? job.events.map(candidate => candidate.type) : []).toEqual(
      expect.arrayContaining(['reasoning_summary', 'tool_started', 'turn_stopped'])
    )
    const rows = renderTimelineItems(items)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:user-run:activity',
      active: true,
      events: [{ run_id: 'user-run', text: 'Following the new request.' }]
    })
  })

  it('routes a metadata-light native stop through an earlier legacy job link', () => {
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'legacy-job-run', prompt: 'Check status' }),
      event(2, 'job_ran', { run_id: 'legacy-job-run', job_id: 'job-1', job_title: 'Status check' }),
      event(3, 'reasoning_summary', { run_id: 'legacy-job-run', text: 'Checking status.' }),
      event(4, 'turn_stopped', {
        run_id: 'legacy-job-run',
        native_steer: true,
        superseded_by_run_id: 'user-run'
      })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'job',
      key: 'job:job-1',
      latestStatus: { type: 'turn_stopped', run_id: 'legacy-job-run' }
    })
  })

  it('keeps goal state in controls and updates a compaction marker at its start anchor', () => {
    const items = projectTimeline([
      event(1, 'codex_goal_updated', {
        goal: {
          threadId: 'thread-1', objective: 'Ship it', status: 'active',
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1
        }
      }),
      event(2, 'codex_compaction_started', {
        operation_id: 'compact-1',
        message: 'Codex started compacting this thread context.'
      }),
      event(3, 'codex_goal_cleared'),
      event(4, 'codex_token_usage', {
        context_tokens: 12_000,
        context_window: 258_400
      }),
      event(5, 'codex_compaction_completed', {
        operation_id: 'compact-1',
        message: 'Context compaction completed.'
      })
    ], [])

    expect(items).toMatchObject([{
      kind: 'system',
      key: 'codex:compaction:compact-1',
      seq: 2,
      anchorTs: '2026-07-09T10:00:02Z',
      event: { id: 'event-5', type: 'codex_compaction_completed' }
    }])
  })

  it('hides historical child compactions leaked into the parent chat', () => {
    const items = projectTimeline([
      event(1, 'codex_compaction_completed', {
        compaction_id: 'native:child-thread:child-turn:child-item',
        thread_id: 'child-thread',
        token_usage_before: {
          thread_id: 'root-thread',
          context_tokens: 226_128,
          context_window: 258_400
        }
      }),
      event(2, 'codex_compaction_completed', {
        compaction_id: 'native:root-thread:root-turn:root-item',
        thread_id: 'root-thread',
        token_usage_before: {
          thread_id: 'root-thread',
          context_tokens: 226_128,
          context_window: 258_400
        }
      })
    ], [])

    expect(items.map(item => item.key)).toEqual([
      'codex:compaction:native:root-thread:root-turn:root-item'
    ])
  })

  it('uses root turn ownership to hide child compactions without token snapshots', () => {
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(2, 'provider_session', {
        run_id: 'run-1',
        provider_session_id: 'root-thread'
      }),
      event(3, 'codex_compaction_started', {
        compaction_id: 'native:child-thread:child-turn:child-item',
        thread_id: 'child-thread'
      }),
      event(4, 'codex_compaction_started', {
        run_id: 'run-1',
        compaction_id: 'native:root-thread:root-turn:root-item',
        thread_id: 'root-thread'
      })
    ], [], { rootThreadId: 'root-thread', activeRunId: 'run-1' })

    expect(items.map(item => item.key)).toContain(
      'codex:compaction:native:root-thread:root-turn:root-item'
    )
    expect(items.map(item => item.key)).not.toContain(
      'codex:compaction:native:child-thread:child-turn:child-item'
    )
  })

  it('interleaves distinct compactions with messages and never moves a completed row', () => {
    const projector = new TimelineProjector([])
    projector.append([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(2, 'codex_compaction_started', {
        operation_id: 'compact-1',
        message: 'Codex started compacting this thread context.'
      }),
      event(3, 'codex_compaction_completed', {
        operation_id: 'automatic-1',
        item_id: 'automatic-1',
        message: 'Codex completed automatic context compaction.'
      }),
      event(4, 'codex_compaction_started', {
        operation_id: 'compact-2',
        message: 'Codex started compacting this thread context.'
      }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Still working.' }),
      event(6, 'codex_compaction_completed', {
        operation_id: 'automatic-2',
        item_id: 'automatic-2',
        message: 'Codex completed automatic context compaction.'
      })
    ])

    expect(renderTimelineItems(projector.items).map(row => [row.seq, row.key])).toEqual([
      [1, 'turn:run-1:user:event-1'],
      [2, 'codex:compaction:compact-1'],
      [3, 'codex:compaction:automatic-1'],
      [4, 'codex:compaction:compact-2'],
      [5, 'turn:run-1:assistant'],
      [6, 'codex:compaction:automatic-2']
    ])

    projector.append([event(7, 'codex_compaction_completed', {
      operation_id: 'compact-1',
      message: 'Context compaction completed.'
    })])
    const completed = projector.items.find(item => item.key === 'codex:compaction:compact-1')
    expect(completed).toMatchObject({
      kind: 'system',
      seq: 2,
      anchorTs: '2026-07-09T10:00:02Z',
      event: { id: 'event-7', type: 'codex_compaction_completed' }
    })
    expect(renderTimelineItems(projector.items).map(row => [row.seq, row.key])).toEqual([
      [1, 'turn:run-1:user:event-1'],
      [2, 'codex:compaction:compact-1'],
      [3, 'codex:compaction:automatic-1'],
      [4, 'codex:compaction:compact-2'],
      [5, 'turn:run-1:assistant'],
      [6, 'codex:compaction:automatic-2']
    ])
  })

  it('embeds a later compaction after earlier live commentary instead of forcing it above the live edge', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(9, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am still working.'
      }),
      event(10, 'codex_compaction_completed', {
        operation_id: 'automatic-1',
        item_id: 'automatic-1',
        message: 'Codex completed automatic context compaction.'
      })
    ], []))

    expect(rows.map(row => [row.seq, row.key])).toEqual([
      [1, 'turn:run-1:user:event-1'],
      [9, 'turn:run-1:activity']
    ])
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      kind: 'progress',
      events: [{ text: 'I am still working.' }],
      lifecycle: [{ key: 'codex:compaction:automatic-1', seq: 10 }]
    })
  })

  it('keeps live commentary on both sides of an in-turn compaction', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'First progress update.'
      }),
      event(3, 'codex_compaction_started', {
        compaction_id: 'automatic-1',
        message: 'Codex started automatic context compaction.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'Second progress update.'
      }),
      event(5, 'codex_compaction_completed', {
        compaction_id: 'automatic-1',
        message: 'Codex completed automatic context compaction.'
      }),
      event(6, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'Third progress update.'
      })
    ], []))

    expect(rows.map(row => [row.seq, row.key])).toEqual([
      [1, 'turn:run-1:user:event-1'],
      [2, 'turn:run-1:activity']
    ])
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      kind: 'progress',
      events: [
        { text: 'First progress update.' },
        { text: 'Second progress update.' },
        { text: 'Third progress update.' }
      ],
      lifecycle: [{
        key: 'codex:compaction:automatic-1',
        seq: 3,
        event: { type: 'codex_compaction_completed' }
      }]
    })
  })

  it('stably interleaves multiple compactions at equal and adjacent sequences', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Checking the current state.'
      }),
      event(2, 'codex_compaction_completed', {
        id: 'compaction-at-trace',
        compaction_id: 'compaction-at-trace',
        message: 'First context compaction completed.'
      }),
      event(3, 'codex_compaction_completed', {
        id: 'compaction-after-trace-1',
        compaction_id: 'compaction-after-trace-1',
        message: 'Second context compaction completed.'
      }),
      event(3, 'codex_compaction_completed', {
        id: 'compaction-after-trace-2',
        compaction_id: 'compaction-after-trace-2',
        message: 'Third context compaction completed.'
      }),
      event(4, 'turn_finished', { run_id: 'run-1', result_text: 'Done.' })
    ], []))

    expect(rows.map(row => row.key)).toEqual([
      'turn:run-1:user:event-1',
      'turn:run-1:activity',
      'turn:run-1:assistant'
    ])
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      lifecycle: [
        { key: 'codex:compaction:compaction-at-trace' },
        { key: 'codex:compaction:compaction-after-trace-1' },
        { key: 'codex:compaction:compaction-after-trace-2' }
      ]
    })
  })

  it('places compaction after an older live-progress row moved behind newer content', () => {
    const user = event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep going' })
    const progress = event(9, 'reasoning_summary', {
      run_id: 'run-1',
      phase: 'commentary',
      text: 'Still working.'
    })
    const compaction = event(10, 'codex_compaction_completed', {
      compaction_id: 'automatic-1',
      message: 'Context compaction completed.'
    })
    const newerStatus = event(12, 'server_notice', { message: 'Newer durable status.' })
    const items: TimelineItem[] = [
      {
        kind: 'turn', id: 'turn-1', key: 'turn:run-1', seq: 1, runId: 'run-1',
        user, assistant: [], trace: [progress], promotedCommentaryIds: [], files: [],
        startedAt: user.ts
      },
      {
        kind: 'system', id: 'automatic-1', key: 'codex:compaction:automatic-1',
        seq: 10, anchorTs: compaction.ts, event: compaction
      },
      {
        kind: 'system', id: 'status-12', key: 'event:status-12', seq: 12, event: newerStatus
      }
    ]

    const rows = renderTimelineItems(items)
    expect(rows.map(row => [row.seq, row.key])).toEqual([
      [1, 'turn:run-1:user:event-1'],
      [9, 'turn:run-1:activity'],
      [12, 'event:status-12']
    ])
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      kind: 'progress',
      lifecycle: [{ key: 'codex:compaction:automatic-1', seq: 10 }]
    })

    expect(settleInactiveTimelineItems(rows)).toMatchObject([
      { key: 'turn:run-1:user:event-1' },
      { key: 'turn:run-1:activity', active: false,
        lifecycle: [{ key: 'codex:compaction:automatic-1' }] },
      { key: 'event:status-12' }
    ])
  })

  it('does not embed a late compaction owned by a prior run in current progress', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-current', prompt: 'Keep going' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-current',
        phase: 'commentary',
        text: 'Current progress.'
      }),
      event(3, 'codex_compaction_completed', {
        run_id: 'run-prior',
        compaction_id: 'prior-compaction',
        message: 'Prior turn context compaction completed.'
      })
    ], []))

    const progressRow = rows.find(row => row.kind === 'progress')
    expect(progressRow).toMatchObject({ kind: 'progress' })
    expect(progressRow?.kind === 'progress' ? progressRow.lifecycle : undefined).toBeUndefined()
    expect(rows.find(row => row.key === 'codex:compaction:prior-compaction')).toMatchObject({
      kind: 'system',
      seq: 3
    })
  })

  it('retires orphaned live progress when Codex authoritatively becomes idle', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(12_155, 'turn_started', {
        run_id: 'run-missing-terminal',
        backend: 'codex',
        prompt: 'Finish the active tick writes'
      }),
      event(12_170, 'reasoning_summary', {
        run_id: 'run-missing-terminal',
        phase: 'commentary',
        text: 'I am planning the final active tick writes.'
      }),
      event(12_178, 'reasoning_summary', {
        run_id: 'run-missing-terminal',
        text: 'Planning final active tick writes.'
      })
    ])).toBe(true)

    const live = renderTimelineItems(projector.items).find(row => row.kind === 'progress')
    expect(live).toMatchObject({
      key: 'turn:run-missing-terminal:activity',
      active: true,
      events: [
        { phase: 'commentary', text: 'I am planning the final active tick writes.' },
        { text: 'Planning final active tick writes.' }
      ]
    })

    expect(projector.append([
      event(12_179, 'codex_thread_status', {
        status: { type: 'idle' }
      }),
      event(12_180, 'codex_goal_cleared')
    ])).toBe(true)

    const idleRows = renderTimelineItems(projector.items)
    expect(idleRows.find(row => row.kind === 'progress')).toMatchObject({
      key: live?.key,
      active: false,
      events: [
        { phase: 'commentary', text: 'I am planning the final active tick writes.' },
        { text: 'Planning final active tick writes.' }
      ]
    })
    expect(idleRows.some(row => row.kind === 'message' && row.role === 'assistant')).toBe(false)

    expect(projector.append([
      event(12_181, 'turn_started', {
        run_id: 'next-run',
        prompt: 'Continue with the next request'
      }),
      event(12_182, 'reasoning_summary', {
        run_id: 'next-run',
        text: 'Inspecting the next request.'
      })
    ])).toBe(true)

    const resumedRows = renderTimelineItems(projector.items)
    expect(resumedRows.find(row => row.kind === 'progress' && row.key === 'turn:next-run:activity')).toMatchObject({
      active: true,
      events: [{ text: 'Inspecting the next request.' }]
    })
    expect(resumedRows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
  })

  it('does not let a stale Codex idle status retire an active Claude turn', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'turn_started', {
        run_id: 'claude-run',
        backend: 'claude',
        prompt: 'Keep working after the backend switch'
      }),
      event(2, 'reasoning_summary', {
        run_id: 'claude-run',
        backend: 'claude',
        text: 'Claude is still working.'
      }),
      event(3, 'codex_thread_status', {
        backend: 'codex',
        status: { type: 'idle' }
      })
    ])).toBe(true)

    const liveRows = renderTimelineItems(projector.items)
    expect(liveRows.find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:claude-run:activity',
      active: true,
      events: [{ text: 'Claude is still working.' }]
    })
    expect(liveRows.some(row => row.kind === 'message' && row.role === 'assistant')).toBe(false)

    expect(projector.append([
      event(4, 'turn_finished', {
        run_id: 'claude-run',
        backend: 'claude',
        result_text: 'Claude finished normally.'
      })
    ])).toBe(true)
    expect(renderTimelineItems(projector.items).find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      key: 'turn:claude-run:assistant',
      events: [{ result_text: 'Claude finished normally.' }]
    })
  })

  it('settles reconstructed progress when semantic history omitted the idle status event', () => {
    const activeRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'orphaned-run', prompt: 'Finish it' }),
      event(2, 'reasoning_summary', {
        run_id: 'orphaned-run',
        phase: 'commentary',
        text: 'I completed the visible update.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'orphaned-run',
        text: 'Private activity remains folded.'
      })
    ], []))
    const live = activeRows.find(row => row.kind === 'progress')

    const settled = settleInactiveTimelineItems(activeRows)

    expect(settled.find(row => row.kind === 'progress')).toMatchObject({
      key: live?.key,
      active: false,
      events: [
        { phase: 'commentary', text: 'I completed the visible update.' },
        { text: 'Private activity remains folded.' }
      ]
    })
    expect(settled.some(row => row.kind === 'message' && row.role === 'assistant')).toBe(false)
  })

  it('settles chronologically split progress without duplicating commentary', () => {
    const activeRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'orphaned-run', prompt: 'Finish it' }),
      event(2, 'reasoning_summary', {
        run_id: 'orphaned-run',
        phase: 'commentary',
        text: 'Before compaction.'
      }),
      event(3, 'codex_compaction_completed', {
        compaction_id: 'automatic-1',
        message: 'Context compaction completed.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'orphaned-run',
        phase: 'commentary',
        text: 'After compaction.'
      })
    ], []))

    const settled = settleInactiveTimelineItems(activeRows)
    expect(settled.find(row => row.kind === 'progress')).toMatchObject({
      active: false,
      events: [{ text: 'Before compaction.' }, { text: 'After compaction.' }],
      lifecycle: [{
        key: 'codex:compaction:automatic-1', seq: 3,
        event: { type: 'codex_compaction_completed' }
      }]
    })
  })

  it('keeps commentary, tools, and reasoning in one live activity after lifecycle markers', () => {
    const activeRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Ship it' }),
      event(2, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(3, 'codex_compaction_completed', {
        operation_id: 'compact-1',
        message: 'Context compaction completed.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'The release is still publishing.'
      }),
      event(5, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Checking the signed package.'
      }),
      event(6, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Verifying the release feed.'
      })
    ], []))

    const progressIndex = activeRows.findIndex(row => row.kind === 'progress')
    expect(progressIndex).toBeGreaterThanOrEqual(0)
    expect(activeRows[progressIndex]).toMatchObject({
      kind: 'progress',
      key: 'turn:run-1:activity',
      seq: 2,
      events: [
        { type: 'tool_started' },
        { phase: 'commentary', text: 'The release is still publishing.' },
        { text: 'Checking the signed package.' },
        { text: 'Verifying the release feed.' }
      ],
      lifecycle: [{ key: 'codex:compaction:compact-1', seq: 3 }]
    })
    expect(activeRows.some(row => row.kind === 'trace')).toBe(false)

    const finishedRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Ship it' }),
      event(2, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(3, 'codex_compaction_completed', {
        operation_id: 'compact-1',
        message: 'Context compaction completed.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'The release is still publishing.'
      }),
      event(5, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Checking the signed package.'
      }),
      event(6, 'turn_finished', { run_id: 'run-1', result_text: 'Published.' })
    ], []))
    expect(finishedRows.find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:run-1:activity', active: false,
      events: [
        { type: 'tool_started' },
        { phase: 'commentary', text: 'The release is still publishing.' },
        { text: 'Checking the signed package.' }
      ]
    })
    expect(finishedRows.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      key: 'turn:run-1:assistant',
      events: [{ result_text: 'Published.' }]
    })
    expect(finishedRows.some(row => row.kind === 'trace')).toBe(false)
  })

  it('keeps earlier reasoning before later commentary in one activity stream', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Inspecting the implementation.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I found the relevant code path.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      kind: 'progress',
      events: [
        { text: 'Inspecting the implementation.' },
        { phase: 'commentary', text: 'I found the relevant code path.' }
      ]
    })
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
  })

  it('keeps commentary and reasoning chronological in one live activity stream', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am checking the renderer.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Inspecting the projection cache.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'The renderer now follows the native event hierarchy.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      kind: 'progress',
      events: [
        { phase: 'commentary', text: 'I am checking the renderer.' },
        { text: 'Inspecting the projection cache.' },
        { phase: 'commentary', text: 'The renderer now follows the native event hierarchy.' }
      ]
    })
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
  })

  it('updates one cached activity stream as reasoning and commentary arrive', () => {
    const projector = new TimelineProjector([])
    projector.append([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am checking the renderer.'
      })
    ])
    const progressEvents = () => {
      const progress = renderTimelineItems(projector.items).find(row => row.kind === 'progress')
      return progress?.kind === 'progress' ? progress.events.map(candidate => candidate.text) : []
    }
    expect(progressEvents()).toEqual(['I am checking the renderer.'])
    projector.append([event(3, 'reasoning_summary', {
      run_id: 'run-1',
      text: 'Inspecting the projection cache.'
    })])
    expect(progressEvents()).toEqual(['I am checking the renderer.', 'Inspecting the projection cache.'])
    projector.append([event(4, 'reasoning_summary', {
      run_id: 'run-1',
      text: 'Checking the reconciled rows.'
    })])
    expect(progressEvents()).toEqual([
      'I am checking the renderer.',
      'Inspecting the projection cache.',
      'Checking the reconciled rows.'
    ])
    projector.append([event(5, 'reasoning_summary', {
      run_id: 'run-1',
      phase: 'commentary',
      text: 'The live row now stays current.'
    })])
    expect(progressEvents()).toEqual([
      'I am checking the renderer.',
      'Inspecting the projection cache.',
      'Checking the reconciled rows.',
      'The live row now stays current.'
    ])
  })

  it('keeps reasoning in live activity and leaves unrelated later compaction separate', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Planning the next implementation step.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'run-1',
        text: 'Checking the current implementation.'
      }),
      event(4, 'codex_compaction_completed', {
        operation_id: 'compact-1',
        message: 'Context compaction completed.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:run-1:activity',
      active: true,
      events: [
        { text: 'Planning the next implementation step.' },
        { text: 'Checking the current implementation.' }
      ]
    })
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      lifecycle: [{ key: 'codex:compaction:compact-1', seq: 4 }]
    })
  })

  it('collapses completed activity without fabricating an assistant response', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am checking the renderer.'
      }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: '' })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:run-1:activity', active: false,
      events: [{ phase: 'commentary', text: 'I am checking the renderer.' }]
    })
    expect(rows.some(row => row.kind === 'trace')).toBe(false)
    expect(rows.some(row => row.kind === 'message' && row.role === 'assistant')).toBe(false)
  })

  it('anchors private trace activity after an earlier commentary and compaction', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-1', phase: 'commentary', text: 'Public progress update.'
      }),
      event(3, 'codex_compaction_completed', {
        run_id: 'run-1', compaction_id: 'compact-1', message: 'Context compacted.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-1', text: 'Private reasoning after compaction.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      seq: 2,
      events: [
        { seq: 2, text: 'Public progress update.' },
        { seq: 4, text: 'Private reasoning after compaction.' }
      ]
    })
    expect(rows.findIndex(row => row.key === 'codex:compaction:compact-1')).toBeLessThan(
      rows.findIndex(row => row.kind === 'progress')
    )
  })

  it('keeps activity stable and renders the final under a separate row key', () => {
    const activeRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(3, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am checking the renderer.'
      })
    ], []))
    const live = activeRows.find(row => row.kind === 'progress')
    expect(live).toMatchObject({ key: 'turn:run-1:activity', active: true })

    const finishedRows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep working' }),
      event(2, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(3, 'reasoning_summary', {
        run_id: 'run-1',
        phase: 'commentary',
        text: 'I am checking the renderer.'
      }),
      event(4, 'turn_finished', { run_id: 'run-1', result_text: 'The renderer is correct.' })
    ], []))
    const final = finishedRows.find(row => row.kind === 'message' && row.role === 'assistant')

    expect(finishedRows.find(row => row.kind === 'progress')).toMatchObject({
      key: live?.key,
      active: false
    })
    expect(final).toMatchObject({
      key: 'turn:run-1:assistant',
      events: [{ result_text: 'The renderer is correct.' }]
    })
    expect(finishedRows.map(row => row.kind)).toEqual(['message', 'progress', 'message'])
  })

  it('keeps native goal continuations after each answer visible until the run really ends', () => {
    const source = [
      event(1, 'turn_started', { run_id: 'goal-run', backend: 'codex', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', { run_id: 'goal-run', phase: 'commentary', text: 'First progress.' }),
      event(3, 'assistant_text', { run_id: 'goal-run', text: 'First answer.' }),
      event(4, 'reasoning_summary', { run_id: 'goal-run', text: 'Legacy continuation summary without phase.' }),
      event(5, 'assistant_text', { run_id: 'goal-run', text: 'Second answer.' }),
      event(6, 'codex_compaction_completed', { run_id: 'goal-run', compaction_id: 'continued-compaction' }),
      event(7, 'reasoning_summary', { run_id: 'goal-run', phase: 'commentary', text: 'Current progress.' }),
      event(8, 'tool_finished', { run_id: 'goal-run', tool_id: 'current-tool', output: 'Tool result.' })
    ]
    const projector = new TimelineProjector([])
    projector.append(source)
    const live = renderTimelineItems(projector.items)
    expect(live.map(row => row.kind)).toEqual(['message', 'progress', 'message', 'progress', 'message', 'progress'])
    expect(live.filter(row => row.kind === 'progress')).toMatchObject([
      { key: 'turn:goal-run:activity', active: false, throughSeq: 3, events: [{ seq: 2 }] },
      { key: 'turn:goal-run:activity:after:event-3', active: false, afterSeq: 3, throughSeq: 5, events: [{ seq: 4 }] },
      { key: 'turn:goal-run:activity:after:event-5', active: true, afterSeq: 5, hasFinalResponse: false,
        events: [{ seq: 7 }, { seq: 8 }], lifecycle: [{ seq: 6 }] }
    ])
    expect(live.filter(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject([
      { events: [{ text: 'First answer.' }] }, { events: [{ text: 'Second answer.' }] }
    ])
    const stop = event(9, 'turn_stopped', { run_id: 'goal-run' })
    projector.append([stop])
    const stopped = renderTimelineItems(projector.items)
    expect(stopped.at(-1)).toMatchObject({ active: false, hasFinalResponse: false, stoppedAt: stop.ts })
    expect(stopped).toEqual(renderTimelineItems(projectTimeline([...source, stop], [])))
  })

  it('keeps post-answer bookkeeping in the original activity without inventing a continuation', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', phase: 'commentary', text: 'Inspecting.' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'Done.' }),
      event(4, 'code_diff', { run_id: 'run-1', files_changed: 1 }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Done.' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'progress', 'message'])
    expect(rows[1]).toMatchObject({ active: false, events: [{ seq: 2 }, { seq: 4 }] })
  })

  it('recognizes partial native goal history by its persisted purpose when the start is absent', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(3, 'assistant_text', { run_id: 'codexgoal-run', purpose: 'codex_goal_resume', text: 'Earlier answer.' }),
      event(4, 'reasoning_summary', { run_id: 'codexgoal-run', purpose: 'codex_goal_resume', text: 'Legacy summary.' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'progress'])
    expect(rows[1]).toMatchObject({ active: true, afterSeq: 3, events: [{ seq: 4 }] })
  })

  it('removes a multi-block terminal Claude commentary suffix when the canonical final arrives', () => {
    const streamed = [
      event(1, 'turn_started', { run_id: 'claude-run', backend: 'claude', prompt: 'Inspect it' }),
      event(2, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'I am inspecting the implementation.'
      }),
      event(3, 'tool_started', {
        run_id: 'claude-run', backend: 'claude', tool: { id: 'tool-1', name: 'Bash' }
      }),
      event(4, 'tool_finished', {
        run_id: 'claude-run', backend: 'claude', tool_id: 'tool-1', output: 'done'
      }),
      event(5, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'The first final paragraph.'
      }),
      event(6, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'The second final paragraph.'
      })
    ]
    const terminal = event(7, 'turn_finished', {
      run_id: 'claude-run', backend: 'claude',
      result_text: 'The first final paragraph.\n\nThe second final paragraph.'
    })
    const projector = new TimelineProjector([])
    projector.append(streamed)

    expect(renderTimelineItems(projector.items).find(row => row.kind === 'progress')).toMatchObject({
      active: true,
      events: [{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }]
    })

    projector.append([terminal])
    const incremental = renderTimelineItems(projector.items)
    const cold = renderTimelineItems(projectTimeline([...streamed, terminal], []))
    const shape = (rows: RenderTimelineItem[]) => rows.map(row => ({
      key: row.key,
      kind: row.kind,
      events: 'events' in row ? (row.events ?? []).map(candidate => candidate.seq) : []
    }))

    expect(shape(incremental)).toEqual(shape(cold))
    expect(incremental.find(row => row.kind === 'progress')).toMatchObject({
      active: false,
      events: [{ seq: 2 }, { seq: 3 }, { seq: 4 }]
    })
    expect(incremental.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      events: [{ seq: 7, result_text: 'The first final paragraph.\n\nThe second final paragraph.' }]
    })
  })

  it('removes only the terminal Claude repetition of a final answer', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'claude-run', backend: 'claude', prompt: 'Answer it' }),
      event(2, 'tool_finished', {
        run_id: 'claude-run', backend: 'claude', tool_id: 'tool-1', output: 'done'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'The shared answer.'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'The shared answer.'
      }),
      event(5, 'turn_finished', {
        run_id: 'claude-run', backend: 'claude', result_text: 'The shared answer.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      events: [{ seq: 2 }, { seq: 3, text: 'The shared answer.' }]
    })
    expect(rows.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      events: [{ seq: 5, result_text: 'The shared answer.' }]
    })
  })

  it('preserves code-diff bookkeeping emitted after terminal Claude commentary', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'claude-run', backend: 'claude', prompt: 'Patch it' }),
      event(2, 'tool_finished', {
        run_id: 'claude-run', backend: 'claude', tool_id: 'tool-1', output: 'done'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'The patch is complete.'
      }),
      event(4, 'code_diff', {
        run_id: 'claude-run', backend: 'claude', files_changed: 1,
        diff_files: [{ path: 'file.ts', additions: 1, deletions: 0 }]
      }),
      event(5, 'turn_finished', {
        run_id: 'claude-run', backend: 'claude', result_text: 'The patch is complete.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      events: [{ seq: 2 }, { seq: 4, type: 'code_diff' }]
    })
    expect(rows.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      events: [{ seq: 5, result_text: 'The patch is complete.' }]
    })
  })

  it('retains nonmatching Claude commentary alongside the canonical final', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'claude-run', backend: 'claude', prompt: 'Answer it' }),
      event(2, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'I found a related issue.'
      }),
      event(3, 'turn_finished', {
        run_id: 'claude-run', backend: 'claude', result_text: 'The final answer is different.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      events: [{ seq: 2, text: 'I found a related issue.' }]
    })
    expect(rows.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      events: [{ seq: 3, result_text: 'The final answer is different.' }]
    })
  })

  it('never applies Claude final deduplication to Codex commentary', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'codex-run', backend: 'codex', prompt: 'Answer it' }),
      event(2, 'reasoning_summary', {
        run_id: 'codex-run', backend: 'codex', phase: 'commentary', text: 'The final answer.'
      }),
      event(3, 'turn_finished', {
        run_id: 'codex-run', backend: 'codex', result_text: 'The final answer.'
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      events: [{ seq: 2, text: 'The final answer.' }]
    })
    expect(rows.find(row => row.kind === 'message' && row.role === 'assistant')).toMatchObject({
      events: [{ seq: 3, result_text: 'The final answer.' }]
    })
  })

  it('keeps all Claude commentary when a stopped turn has no canonical result', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'claude-run', backend: 'claude', prompt: 'Keep working' }),
      event(2, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'First partial answer.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'claude-run', backend: 'claude', phase: 'commentary', text: 'Second partial answer.'
      }),
      event(4, 'turn_finished', {
        run_id: 'claude-run', backend: 'claude', stopped: true, result_text: ''
      })
    ], []))

    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      active: false,
      hasFinalResponse: false,
      events: [
        { seq: 2, text: 'First partial answer.' },
        { seq: 3, text: 'Second partial answer.' }
      ]
    })
    expect(rows.some(row => row.kind === 'message' && row.role === 'assistant')).toBe(false)
  })

  it('never revives commentary from an older unfinished turn at the live edge', () => {
    const withoutCurrentCommentary = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
      event(2, 'reasoning_summary', {
        run_id: 'stale-run',
        phase: 'commentary',
        text: 'Old progress from a truncated run.'
      }),
      event(3, 'turn_started', { run_id: 'current-run', prompt: 'Current request' })
    ], []))
    expect(withoutCurrentCommentary.filter(row => row.kind === 'progress')).toMatchObject([{
      key: 'turn:stale-run:activity', active: false,
      events: [{ text: 'Old progress from a truncated run.' }]
    }])

    const withCurrentCommentary = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
      event(2, 'reasoning_summary', {
        run_id: 'stale-run',
        phase: 'commentary',
        text: 'Old progress from a truncated run.'
      }),
      event(3, 'turn_started', { run_id: 'current-run', prompt: 'Current request' }),
      event(4, 'reasoning_summary', {
        run_id: 'current-run',
        phase: 'commentary',
        text: 'Current progress.'
      })
    ], []))
    expect(withCurrentCommentary.filter(row => row.kind === 'progress')).toMatchObject([
      { key: 'turn:stale-run:activity', active: false,
        events: [{ text: 'Old progress from a truncated run.' }] },
      { key: 'turn:current-run:activity', active: true, seq: 4,
        events: [{ text: 'Current progress.' }] }
    ])

    const withCurrentAssistantOutput = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
      event(2, 'reasoning_summary', {
        run_id: 'stale-run',
        phase: 'commentary',
        text: 'Old progress from a truncated run.'
      }),
      event(3, 'turn_started', { run_id: 'current-run', prompt: 'Current request' }),
      event(4, 'assistant_text', { run_id: 'current-run', text: 'Current answer.' })
    ], []))
    expect(withCurrentAssistantOutput.filter(row => row.kind === 'progress')).toMatchObject([{
      key: 'turn:stale-run:activity', active: false
    }])

    const afterCurrentTurnFinished = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'stale-run', prompt: 'Old request' }),
      event(2, 'reasoning_summary', {
        run_id: 'stale-run',
        phase: 'commentary',
        text: 'Old progress from a truncated run.'
      }),
      event(3, 'turn_started', { run_id: 'current-run', prompt: 'Current request' }),
      event(4, 'assistant_text', { run_id: 'current-run', text: 'Current answer.' }),
      event(5, 'turn_finished', { run_id: 'current-run', result_text: 'Current answer.' })
    ], []))
    expect(afterCurrentTurnFinished.filter(row => row.kind === 'progress')).toMatchObject([{
      key: 'turn:stale-run:activity', active: false
    }])
  })

  it('summarizes structured job results without discarding pretty detail', () => {
    const presentation = jobResultPresentation(event(1, 'turn_finished', {
      result_text: JSON.stringify({
        collector: 'bottle',
        queue_status: 'completed',
        report_json: '/tmp/latest.json',
        status: 'COMPLETED'
      })
    }))

    expect(presentation).toEqual({
      structured: true,
      preview: 'Status: COMPLETED · Queue: Completed · Collector: Bottle',
      detail: '{\n  "collector": "bottle",\n  "queue_status": "completed",\n  "report_json": "/tmp/latest.json",\n  "status": "COMPLETED"\n}'
    })
  })

  it('uses a deferred-specific fallback when an older summary omits its message', () => {
    const presentation = jobResultPresentation(event(1, 'job_summary', {
      job_status: 'deferred',
      job_status_type: 'job_deferred'
    }))

    expect(presentation).toMatchObject({
      structured: false,
      detail: 'Scheduled job deferred until this chat is available.'
    })
  })

  it('uses a cancelled fallback for a stopped runner terminal without output', () => {
    const presentation = jobResultPresentation(event(1, 'turn_finished', {
      stopped: true,
      job_status: 'completed'
    }))

    expect(presentation).toMatchObject({
      structured: false,
      detail: 'Scheduled job was cancelled.'
    })
  })

  it('keeps a scheduled-run goal budget marker outside the job card', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'job-run',
        purpose: 'scheduled_job',
        job_id: 'job-1',
        job_title: 'Capacity monitor',
        prompt: 'Check capacity'
      }),
      event(2, 'codex_goal_budget_limited', {
        run_id: 'job-run',
        message: 'The persistent goal reached its time limit.'
      })
    ], [])

    expect(items.map(item => item.key)).toEqual([
      'job:job-1',
      'codex:goal-budget'
    ])
    expect(items[0]).toMatchObject({
      kind: 'job',
      events: [{ id: 'event-1' }]
    })
    expect(items[1]).toMatchObject({
      kind: 'system',
      event: { id: 'event-2', type: 'codex_goal_budget_limited' }
    })
  })

  it('retires predecessor activity while leaving the steered turn active', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'old-run', prompt: 'Original request' }),
      event(2, 'reasoning_summary', { run_id: 'old-run', text: 'Working on the original request.' }),
      event(3, 'turn_stopped', {
        run_id: 'old-run',
        superseded_by_run_id: 'steered-run'
      }),
      event(4, 'turn_started', {
        run_id: 'steered-run',
        native_steer: true,
        prompt: 'Use this new direction'
      }),
      event(5, 'reasoning_summary', {
        run_id: 'steered-run',
        text: 'Following the new direction.'
      })
    ], []))

    const activities = rows.filter(row => row.kind === 'progress')
    expect(activities).toMatchObject([
      { key: 'turn:old-run:activity', active: false },
      { key: 'turn:steered-run:activity', active: true }
    ])
    expect(rows.some(row => row.kind === 'system' && row.event.type === 'turn_stopped')).toBe(false)
  })

  it('keeps completed commentary in predecessor activity on native steer', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'turn_started', { run_id: 'old-run', prompt: 'Original request' }),
      event(2, 'reasoning_summary', {
        run_id: 'old-run',
        item_id: 'reason-before',
        text: 'Completed reasoning before steering.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'old-run',
        item_id: 'commentary-before',
        phase: 'commentary',
        text: 'Completed commentary before steering.'
      }),
      event(4, 'turn_stopped', {
        run_id: 'old-run',
        native_steer: true,
        superseded_by_run_id: 'steered-run'
      }),
      event(5, 'turn_started', {
        run_id: 'steered-run',
        native_steer: true,
        steer_interrupted_run_id: 'old-run',
        prompt: 'Use this new direction'
      })
    ])).toBe(true)

    let rows = renderTimelineItems(projector.items)
    const oldActivity = rows.find(row => row.kind === 'progress' && row.key === 'turn:old-run:activity')
    expect(oldActivity).toMatchObject({ active: false })
    expect(oldActivity?.kind === 'progress' ? oldActivity.events.map(item => item.text) : []).toEqual([
      'Completed reasoning before steering.',
      'Completed commentary before steering.'
    ])
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
    expect(rows.filter((row): row is Extract<RenderTimelineItem, { kind: 'message' }> => row.kind === 'message' && row.role === 'user').map(row => row.events[0].prompt)).toEqual([
      'Original request', 'Use this new direction'
    ])

    expect(projector.append([
      event(6, 'reasoning_summary', {
        run_id: 'steered-run',
        item_id: 'reason-after',
        text: 'Completed reasoning after steering.'
      })
    ])).toBe(true)
    rows = renderTimelineItems(projector.items)
    expect(rows.find(row => row.kind === 'progress' && row.key === 'turn:steered-run:activity')).toMatchObject({
      active: true,
      events: [{ text: 'Completed reasoning after steering.' }]
    })
    expect(rows
      .filter((row): row is Extract<RenderTimelineItem, { kind: 'message' }> => (
        row.kind === 'message' && row.role === 'assistant'
      ))
      .flatMap(row => row.events.map(item => item.text))
    ).toEqual([])
  })

  it('reconstructs repeated native-steer activity from successor metadata', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-a', prompt: 'Original request' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-a',
        item_id: 'commentary-a',
        phase: 'commentary',
        text: 'Progress from A.'
      }),
      // Semantic pages omit native transition stops, so only the successor
      // metadata is available when this chat is reloaded.
      event(3, 'turn_started', {
        run_id: 'run-b',
        native_steer: true,
        steer_interrupted_run_id: 'run-a',
        prompt: 'First steer'
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-b',
        item_id: 'commentary-b',
        phase: 'commentary',
        text: 'Progress from B.'
      }),
      event(5, 'turn_started', {
        run_id: 'run-c',
        native_steer: true,
        steer_interrupted_run_id: 'run-b',
        prompt: 'Second steer'
      })
    ], []))

    const activities = rows.filter(row => row.kind === 'progress')
    expect(activities).toHaveLength(2)
    expect(activities.flatMap(row => row.events.map(item => item.text))).toEqual([
      'Progress from A.',
      'Progress from B.'
    ])
    expect(activities.every(row => row.active === false)).toBe(true)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
    expect(rows.filter((row): row is Extract<RenderTimelineItem, { kind: 'message' }> => row.kind === 'message' && row.role === 'user').map(row => row.events[0].prompt)).toEqual([
      'Original request', 'First steer', 'Second steer'
    ])
  })

  it('reclassifies a stopped finish when its successor identifies a steering transition', () => {
    const events = [
      event(1, 'turn_started', { run_id: 'old-run', prompt: 'Original request' }),
      event(2, 'reasoning_summary', {
        run_id: 'old-run',
        item_id: 'commentary-before-steer',
        phase: 'commentary',
        text: 'Progress before steering.'
      }),
      // The provider first reports the predecessor using the same stopped
      // finish shape as an explicit user Stop.
      event(3, 'turn_finished', {
        run_id: 'old-run',
        result_text: '',
        stopped: true
      }),
      // Only the successor proves that the predecessor ended by steering.
      event(4, 'turn_started', {
        run_id: 'steered-run',
        steer_interrupted_run_id: 'old-run',
        prompt: 'Use this new direction'
      })
    ]
    const projector = new TimelineProjector([])

    expect(projector.append(events.slice(0, 3))).toBe(true)
    expect(renderTimelineItems(projector.items).find(row => row.kind === 'progress')).toMatchObject({
      key: 'turn:old-run:activity',
      active: false,
      stoppedAt: '2026-07-09T10:00:03Z'
    })

    expect(projector.append(events.slice(3))).toBe(true)
    const incrementalRows = renderTimelineItems(projector.items)
    expect(incrementalRows.find(row => row.key === 'turn:old-run:activity')).toMatchObject({
      active: false,
      hasFinalResponse: false,
      stoppedAt: undefined
    })
    expect(incrementalRows
      .filter((row): row is Extract<RenderTimelineItem, { kind: 'message' }> => row.kind === 'message' && row.role === 'user')
      .map(row => row.events[0].prompt)
    ).toEqual(['Original request', 'Use this new direction'])

    // A cold history projection must classify the same sequence identically.
    expect(renderTimelineItems(projectTimeline(events, []))).toEqual(incrementalRows)
  })

  it('keeps complete activity and one final answer across native steer', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'old-run', prompt: 'Original request' }),
      event(2, 'reasoning_summary', {
        run_id: 'old-run',
        item_id: 'reason-before',
        text: 'Completed reasoning before steering.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'old-run',
        item_id: 'commentary-before',
        phase: 'commentary',
        text: 'Completed commentary before steering.'
      }),
      event(4, 'turn_stopped', {
        run_id: 'old-run',
        native_steer: true,
        superseded_by_run_id: 'steered-run'
      }),
      event(5, 'turn_started', {
        run_id: 'steered-run',
        native_steer: true,
        prompt: 'Use this new direction'
      }),
      event(6, 'reasoning_summary', {
        run_id: 'steered-run',
        item_id: 'reason-after',
        text: 'Completed reasoning after steering.'
      }),
      event(7, 'reasoning_summary', {
        run_id: 'steered-run',
        item_id: 'commentary-after',
        phase: 'commentary',
        text: 'Completed commentary after steering.'
      }),
      event(8, 'assistant_text', {
        run_id: 'steered-run',
        item_id: 'final-after',
        text: 'Final answer after steering.'
      }),
      event(9, 'turn_finished', {
        run_id: 'steered-run',
        result_text: 'Final answer after steering.'
      })
    ], []))

    const activities = rows.filter(row => row.kind === 'progress')
    expect(activities).toHaveLength(2)
    expect(activities.flatMap(activity => activity.events.map(item => item.text))).toEqual([
      'Completed reasoning before steering.',
      'Completed commentary before steering.',
      'Completed reasoning after steering.',
      'Completed commentary after steering.'
    ])
    expect(activities.every(activity => activity.active === false)).toBe(true)
    expect(activities.map(activity => activity.hasFinalResponse)).toEqual([false, true])
    const assistantMessages = rows
      .filter(row => row.kind === 'message')
      .filter(row => row.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages.flatMap(row => row.events.map(item => item.text))).toEqual([
      'Final answer after steering.'
    ])
  })

  it('keeps stopped activity expanded without a duplicate stop row or assistant response', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'turn_started', { run_id: 'stopped-run', prompt: 'Please keep this message' }),
      event(2, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'private-reasoning',
        text: 'Private reasoning remains in the folded trace.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'completed-commentary',
        phase: 'commentary',
        text: 'Completed commentary remains visible after Stop.'
      }),
      event(4, 'tool_started', {
        run_id: 'stopped-run',
        tool: { name: 'exec' }
      })
    ])).toBe(true)
    const live = renderTimelineItems(projector.items).find(row => row.kind === 'progress')
    expect(live).toMatchObject({ key: 'turn:stopped-run:activity', active: true })

    expect(projector.append([
      event(5, 'turn_stopped', {
        run_id: 'stopped-run',
        message: 'Stopped by user.'
      })
    ])).toBe(true)

    let rows = renderTimelineItems(projector.items)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({
      key: live?.key, active: false, stoppedAt: '2026-07-09T10:00:05Z'
    })
    expect(rows.some(row => row.kind === 'system' && row.event.type === 'turn_stopped')).toBe(false)

    expect(projector.append([
      event(6, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'late-private-reasoning',
        text: 'Late private reasoning also remains folded.'
      }),
      event(7, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'late-completed-commentary',
        phase: 'commentary',
        text: 'Late completed commentary is also retained exactly once.'
      }),
      event(8, 'turn_finished', {
        run_id: 'stopped-run',
        result_text: ''
      }),
      event(9, 'turn_stopped', {
        run_id: 'stopped-run',
        message: 'Duplicate stop notification.'
      })
    ])).toBe(true)

    rows = renderTimelineItems(projector.items)
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
    const activity = rows.find(row => row.kind === 'progress')
    expect(activity?.kind === 'progress' ? activity.events.map(item => item.id) : []).toEqual([
      'event-2', 'event-3', 'event-4', 'event-6', 'event-7'
    ])
    const stopRows = rows.filter(row => row.kind === 'system' && row.event.type === 'turn_stopped')
    expect(stopRows).toHaveLength(0)
  })

  it('keeps stopped commentary and reasoning in activity when acknowledgement is turn_finished', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', {
        run_id: 'stopped-run',
        prompt: 'Stop this turn'
      }),
      event(2, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'completed-commentary',
        phase: 'commentary',
        text: 'Keep this interrupted commentary.'
      }),
      event(3, 'reasoning_summary', {
        run_id: 'stopped-run',
        item_id: 'private-reasoning',
        text: 'Keep this folded.'
      }),
      event(4, 'turn_finished', {
        run_id: 'stopped-run',
        result_text: '',
        stopped: true
      })
    ], []))

    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(0)
    const activity = rows.find(row => row.kind === 'progress')
    expect(activity).toMatchObject({ active: false, hasFinalResponse: false, stoppedAt: '2026-07-09T10:00:04Z' })
    expect(activity?.kind === 'progress' ? activity.events.map(item => item.text) : []).toEqual([
      'Keep this interrupted commentary.', 'Keep this folded.'
    ])
  })

  it('keeps unrelated runless stop notices separate when no logical turn owns them', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_stopped', { message: 'First standalone stop.' }),
      event(2, 'turn_stopped', { message: 'Second standalone stop.' })
    ], []))

    expect(rows).toMatchObject([
      { kind: 'system', key: 'event:event-1', event: { message: 'First standalone stop.' } },
      { kind: 'system', key: 'event:event-2', event: { message: 'Second standalone stop.' } }
    ])
  })

  it('does not render turn_finished when it repeats the accumulated assistant updates', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix the sync' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I found the missing fields.' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'The transport test now passes.' }),
      event(4, 'turn_finished', {
        run_id: 'run-1',
        result_text: 'I found the missing fields.\n\nThe transport test now passes.'
      })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(
      'I found the missing fields.\n\nThe transport test now passes.'
    )
  })

  it('uses a cumulative finish payload instead of duplicating its earlier updates', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix the sync' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I found the missing fields.' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'The transport test now passes.' }),
      event(4, 'turn_finished', {
        run_id: 'run-1',
        result_text: 'I found the missing fields.\n\nThe transport test now passes.\n\nThe server is ready.'
      })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ events: [{ id: 'event-4' }] })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(
      'I found the missing fields.\n\nThe transport test now passes.\n\nThe server is ready.'
    )
  })

  it('keeps queued turns out of transcript history and groups recurring job output', () => {
    const items = projectTimeline([
      event(1, 'turn_queued', { prompt: 'Later' }),
      event(2, 'job_started', { job_id: 'job-1', message: 'Started' }),
      event(3, 'job_finished', { job_id: 'job-1', result_text: 'Healthy' })
    ], [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'job', events: [{ type: 'job_started' }, { type: 'job_finished' }] })
  })

  it('keeps job mutation notifications out of the visible timeline', () => {
    expect(projectTimeline([
      event(1, 'job_updated', { job_id: 'job-1' }),
      event(2, 'job_deleted', { job_id: 'job-1' })
    ], [])).toEqual([])
  })

  it('uses queued attachment ownership for legacy steered turns', () => {
    const interruptedImage: AgentFile = { id: 'old-image', filename: 'old.png', content_type: 'image/png' }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_queued', { queued_id: 'queued-steer', prompt: 'Text-only steer', file_ids: [] }),
      event(2, 'turn_queue_run_now', { queued_id: 'queued-steer', file_ids: [interruptedImage.id] }),
      event(3, 'turn_started', {
        queued_id: 'queued-steer', run_id: 'run-steer', prompt: 'Text-only steer', file_ids: [interruptedImage.id]
      })
    ], [interruptedImage]))

    const user = rows.find(row => row.kind === 'message' && row.role === 'user')
    expect(user).toMatchObject({ kind: 'message', files: [] })
    expect(rows.some(row => row.kind === 'media')).toBe(false)
  })

  it('collapses a source-chat digest turn into one lifecycle row', () => {
    const digest = { purpose: 'handoff_digest', digest_job_id: 'digest-1', target_session_id: 'chat-2' }
    const items = projectTimeline([
      event(1, 'turn_queued', { ...digest, queued_id: 'queued-digest', prompt: 'Generate a handoff digest for Target.' }),
      event(2, 'turn_started', { ...digest, queued_id: 'queued-digest', run_id: 'run-digest', prompt: 'Generate a handoff digest for Target.' }),
      event(3, 'reasoning_summary', { ...digest, run_id: 'run-digest', text: 'Selecting durable context' }),
      event(4, 'assistant_text', { ...digest, run_id: 'run-digest', text: '# AgentsDock Context Digest\n\nPrivate generated body' }),
      event(5, 'turn_finished', { ...digest, run_id: 'run-digest', result_text: '# AgentsDock Context Digest\n\nPrivate generated body' }),
      event(6, 'handoff_digest_sent', { digest_job_id: 'digest-1', target_session_id: 'chat-2', message: 'Context digest was sent to Target.' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system', key: 'digest:digest-1', seq: 1,
      event: { type: 'handoff_digest_sent', message: 'Context digest was sent to Target.' }
    })
    expect(renderTimelineItems(items)).toHaveLength(1)
  })

  it('renders a target digest as a folded handoff followed by the agent response', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'handoff_digest_received', {
        digest_job_id: 'digest-1', source_session_id: 'chat-source', target_session_id: 'chat-1',
        message: 'Context digest from Source was delivered to this chat.',
        digest: '# AgentsDock Context Digest\n\nDelivered context'
      }),
      event(2, 'turn_started', {
        run_id: 'target-run', purpose: 'handoff_digest_delivery', digest_job_id: 'digest-1',
        source_session_id: 'chat-source', target_session_id: 'chat-1', prompt: 'Context digest from Source.'
      }),
      event(3, 'assistant_text', {
        run_id: 'target-run', purpose: 'handoff_digest_delivery', digest_job_id: 'digest-1',
        source_session_id: 'chat-source', target_session_id: 'chat-1', text: 'I have the context.'
      })
    ], []))

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'system', event: { type: 'handoff_digest_received' } })
    expect(rows[1]).toMatchObject({ kind: 'message', role: 'assistant' })
    expect(rows).not.toContainEqual(expect.objectContaining({ kind: 'message', role: 'user' }))
  })

  it('does not let a late source-provider event overwrite a failed digest lifecycle', () => {
    const digest = { purpose: 'handoff_digest', digest_job_id: 'digest-1', target_session_id: 'chat-2' }
    const items = projectTimeline([
      event(1, 'handoff_digest_started', { digest_job_id: 'digest-1', target_session_id: 'chat-2' }),
      event(2, 'handoff_digest_error', { digest_job_id: 'digest-1', target_session_id: 'chat-2', message: 'Digest timed out.' }),
      event(3, 'assistant_text', { ...digest, run_id: 'run-digest', text: 'Late generated output' }),
      event(4, 'turn_finished', { ...digest, run_id: 'run-digest', result_text: 'Late generated output' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'system', event: { type: 'handoff_digest_error', message: 'Digest timed out.' } })
  })

  it('folds a scheduled agent run into its job card, including legacy job_ran links', () => {
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-job-1', prompt: 'Check training status' }),
      event(2, 'job_ran', { run_id: 'run-job-1', job_id: 'job-1', job: { id: 'job-1', session_id: 'chat-1', title: 'Training status', prompt: 'Check training status', interval_seconds: 3600 } }),
      event(3, 'assistant_text', { run_id: 'run-job-1', text: 'Training is healthy.' }),
      event(4, 'turn_finished', { run_id: 'run-job-1', result_text: 'Training is healthy.' })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'job', title: 'Training status' })
    const rows = renderTimelineItems(items)
    expect(rows.map(row => row.kind)).toEqual(['job'])
    if (items[0].kind === 'job') {
      expect(jobDisplayEvents(items[0].events)).toMatchObject([{ type: 'turn_finished', result_text: 'Training is healthy.' }])
      expect(items[0]).toMatchObject({ eventCount: 4, runCount: 1, startSeq: 1, endSeq: 4 })
    }
  })

  it('does not regress a cancelled scheduled run to running on a late job marker', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'run-job-1', purpose: 'scheduled_job', job_id: 'job-1',
        prompt: 'Check training status'
      }),
      event(2, 'turn_finished', {
        run_id: 'run-job-1', purpose: 'scheduled_job', job_id: 'job-1',
        stopped: true, result_text: 'Stopped before completion.'
      }),
      event(3, 'job_ran', {
        run_id: 'run-job-1', job_id: 'job-1', job_title: 'Training status'
      })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'job',
      latestStatus: {
        type: 'turn_finished',
        run_id: 'run-job-1',
        stopped: true
      }
    })
  })

  it('groups many adjacent runs of one scheduled job into one rendered timeline row', () => {
    const events = Array.from({ length: 40 }, (_, index) => event(index + 1, 'turn_finished', {
      run_id: `job-run-${index + 1}`,
      purpose: 'scheduled_job',
      job_id: 'job-1',
      job_title: 'Capacity monitor',
      result_text: `Capacity result ${index + 1}`
    }))

    const rows = renderTimelineItems(projectTimeline(events, []))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'job',
      key: 'job:job-1',
      runCount: 40
    })
    expect(rows[0].kind === 'job' ? rows[0].events.length : 0).toBeLessThanOrEqual(21)
  })

  it('starts a new scheduled-job card when a chat turn separates runs of the same job', () => {
    const items = projectTimeline([
      event(1, 'turn_finished', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        job_title: 'Capacity monitor', result_text: 'First capacity result'
      }),
      event(2, 'turn_started', { run_id: 'chat-run', prompt: 'Explain the first result' }),
      event(3, 'turn_finished', { run_id: 'chat-run', result_text: 'The first result is healthy.' }),
      event(4, 'turn_finished', {
        run_id: 'job-run-2', purpose: 'scheduled_job', job_id: 'job-1',
        job_title: 'Capacity monitor', result_text: 'Second capacity result'
      })
    ], [])

    expect(items.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-1'],
      ['turn', 'turn:chat-run'],
      ['job', 'job:job-1:segment:4']
    ])
    const jobs = items.filter((item): item is Extract<TimelineItem, { kind: 'job' }> => item.kind === 'job')
    expect(jobs).toMatchObject([
      { seq: 1, startSeq: 1, endSeq: 1, runCount: 1 },
      { seq: 4, startSeq: 4, endSeq: 4, runCount: 1 }
    ])
    expect(jobs.map(item => jobDisplaySelection(item).latest.result_text)).toEqual([
      'First capacity result',
      'Second capacity result'
    ])
    expect(renderTimelineItems(items).map(row => row.kind)).toEqual([
      'job', 'message', 'message', 'job'
    ])
  })

  it('starts a new scheduled-job card when another visible timeline item separates runs', () => {
    const items = projectTimeline([
      event(1, 'turn_finished', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'First result'
      }),
      event(2, 'error', { error: 'Visible failure' }),
      event(3, 'turn_finished', {
        run_id: 'job-run-2', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Second result'
      })
    ], [])

    expect(items.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-1'],
      ['system', 'event:event-2'],
      ['job', 'job:job-1:segment:3']
    ])
  })

  it('keeps A-B-A scheduled runs as three chronological cards', () => {
    const items = projectTimeline([
      event(1, 'turn_finished', {
        run_id: 'job-a-run-1', purpose: 'scheduled_job', job_id: 'job-a',
        result_text: 'A first'
      }),
      event(2, 'turn_finished', {
        run_id: 'job-b-run-1', purpose: 'scheduled_job', job_id: 'job-b',
        result_text: 'B first'
      }),
      event(3, 'turn_finished', {
        run_id: 'job-a-run-2', purpose: 'scheduled_job', job_id: 'job-a',
        result_text: 'A second'
      })
    ], [])

    expect(items.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-a'],
      ['job', 'job:job-b'],
      ['job', 'job:job-a:segment:3']
    ])
    expect(items.map(item => item.kind === 'job' ? item.jobId : null)).toEqual([
      'job-a', 'job-b', 'job-a'
    ])
  })

  it('splits a recycled provider run ID across a visible chat boundary', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a'
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a', result_text: 'First firing'
      }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Interleaved answer' }),
      event(5, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a'
      }),
      event(6, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a', result_text: 'Second firing'
      })
    ], [])

    expect(items.map(item => [item.kind, item.key])).toEqual([
      ['job', 'job:job-a'],
      ['turn', 'turn:chat-run'],
      ['job', 'job:job-a:segment:5']
    ])
  })

  it('routes a late recycled-run event by its stable scheduled occurrence', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_000_000
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_000_000, result_text: 'First firing'
      }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Interleaved answer' }),
      event(5, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_003_600
      }),
      event(6, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_scheduled_run_at: 1_775_003_600, result_text: 'Second firing'
      }),
      event(7, 'job_finished', {
        run_id: 'recycled-run', job_id: 'job-a',
        job_scheduled_run_at: 1_775_000_000, message: 'Late first completion'
      })
    ], [])

    const jobs = items.filter((item): item is Extract<TimelineItem, { kind: 'job' }> => item.kind === 'job')
    expect(items.map(item => item.key)).toEqual([
      'job:job-a',
      'turn:chat-run',
      'job:job-a:segment:5'
    ])
    expect(jobs[0]).toMatchObject({ startSeq: 1, endSeq: 7, runCount: 1 })
    expect(jobs[0].events.some(candidate => candidate.id === 'event-7')).toBe(true)
    expect(jobs[1]).toMatchObject({ startSeq: 5, endSeq: 6, runCount: 1 })
    expect(jobs[1].events.some(candidate => candidate.id === 'event-7')).toBe(false)
  })

  it('uses nested scheduled time to keep a runless deferral on its original card', () => {
    const scheduledJob = (scheduledRunAt: number) => ({
      id: 'job-a', session_id: 'chat-1', title: 'Capacity monitor', prompt: 'Check capacity',
      interval_seconds: 3_600, scheduled_run_at: scheduledRunAt
    })
    const items = projectTimeline([
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
    ], [])

    expect(items.map(item => item.key)).toEqual([
      'job:job-a',
      'turn:chat-run',
      'job:job-a:segment:5'
    ])
    const jobs = items.filter((item): item is Extract<TimelineItem, { kind: 'job' }> => item.kind === 'job')
    expect(jobs[0]).toMatchObject({ startSeq: 1, endSeq: 4 })
    expect(jobs[1]).toMatchObject({ startSeq: 5, endSeq: 5 })
  })

  it('never shares a card when different jobs recycle the same provider run ID', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a'
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a', result_text: 'A result'
      }),
      event(3, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-b'
      }),
      event(4, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-b', result_text: 'B result'
      })
    ], [])

    expect(items.map(item => item.kind === 'job' ? [item.key, item.jobId] : [item.key, null])).toEqual([
      ['job:job-a', 'job-a'],
      ['job:job-b', 'job-b']
    ])
  })

  it('counts and preserves consecutive firings that recycle one provider run ID', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a'
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a', result_text: 'First firing'
      }),
      event(3, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a'
      }),
      event(4, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a', result_text: 'Second firing'
      })
    ], [])

    expect(items).toHaveLength(1)
    if (items[0].kind !== 'job') throw new Error('Expected job item')
    expect(items[0].runCount).toBe(2)
    expect(jobDisplaySelection(items[0]).updates.map(candidate => candidate.result_text)).toEqual([
      'First firing',
      'Second firing'
    ])
  })

  it('rekeys a provisional card to an unknown authoritative server group', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([event(1, 'turn_started', {
      run_id: 'job-run', purpose: 'scheduled_job', job_id: 'job-a'
    })])).toBe(true)

    expect(projector.append([event(2, 'job_ran', {
      run_id: 'job-run', job_id: 'job-a',
      job_timeline_group_id: 'server-job-group-a'
    })])).toBe(true)

    expect(projector.items).toHaveLength(1)
    expect(projector.items[0]).toMatchObject({
      kind: 'job', id: 'server-job-group-a', key: 'server-job-group-a',
      timelineGroupId: 'server-job-group-a'
    })
  })

  it('does not alias a new authoritative group onto an older group for a recycled run ID', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_timeline_group_id: 'server-group-first'
      }),
      event(2, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_timeline_group_id: 'server-group-first', result_text: 'First firing'
      }),
      event(3, 'turn_started', { run_id: 'chat-run', prompt: 'Boundary' }),
      event(4, 'turn_finished', { run_id: 'chat-run', result_text: 'Boundary answer' }),
      event(5, 'turn_started', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_timeline_group_id: 'server-group-second'
      }),
      event(6, 'turn_finished', {
        run_id: 'recycled-run', purpose: 'scheduled_job', job_id: 'job-a',
        job_timeline_group_id: 'server-group-second', result_text: 'Second firing'
      })
    ], [])

    expect(items.map(item => item.key)).toEqual([
      'server-group-first',
      'turn:chat-run',
      'server-group-second'
    ])
  })

  it('keeps a runless legacy summary on the newest card after an older run finishes late', () => {
    const items = projectTimeline([
      event(1, 'job_started', { run_id: 'job-run-1', job_id: 'job-1' }),
      event(2, 'turn_started', { run_id: 'chat-run', prompt: 'Interleaved question' }),
      event(3, 'turn_finished', { run_id: 'chat-run', result_text: 'Interleaved answer' }),
      event(4, 'job_started', { run_id: 'job-run-2', job_id: 'job-1' }),
      event(5, 'job_finished', { run_id: 'job-run-2', job_id: 'job-1', result_text: 'Second result' }),
      event(6, 'job_finished', { run_id: 'job-run-1', job_id: 'job-1', result_text: 'Late first result' }),
      event(7, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1',
        job_status: 'deferred', message: 'Next firing deferred'
      })
    ], [])

    const jobs = items.filter((item): item is Extract<TimelineItem, { kind: 'job' }> => item.kind === 'job')
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ key: 'job:job-1', startSeq: 1, endSeq: 6 })
    expect(jobs[0].events.some(candidate => candidate.type === 'job_summary')).toBe(false)
    expect(jobs[1]).toMatchObject({ key: 'job:job-1:segment:4', startSeq: 4, endSeq: 7 })
    expect(jobs[1].events.some(candidate => candidate.type === 'job_summary')).toBe(true)
  })

  it('retains the latest scheduled reasoning and tools for the in-card trace', () => {
    const items = projectTimeline([
      event(1, 'turn_started', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        prompt: 'Check health'
      }),
      event(2, 'reasoning_summary', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        text: 'Checking the service'
      }),
      event(3, 'tool_started', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        tool: { name: 'health_check' }
      }),
      event(4, 'tool_finished', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        tool: { name: 'health_check' }, output: 'healthy'
      }),
      event(5, 'turn_finished', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Healthy'
      })
    ], [])

    expect(items).toHaveLength(1)
    if (items[0].kind !== 'job') throw new Error('Expected job item')
    expect(items[0].events.map(candidate => candidate.type)).toEqual(expect.arrayContaining([
      'reasoning_summary',
      'tool_started',
      'tool_finished',
      'turn_finished'
    ]))
    expect(items[0].latestStatus).toMatchObject({
      type: 'turn_finished',
      run_id: 'job-run-1'
    })
  })

  it('requests a rebuild when a late legacy link replaces a scheduled-run fallback ID', () => {
    const scheduledRun = [
      event(1, 'turn_started', {
        run_id: 'legacy-run',
        purpose: 'scheduled_job',
        prompt: 'Check training status'
      }),
      event(2, 'turn_finished', {
        run_id: 'legacy-run',
        purpose: 'scheduled_job',
        result_text: 'Training is healthy.'
      })
    ]
    const legacyLink = event(3, 'job_ran', {
      run_id: 'legacy-run',
      job_id: 'job-1',
      job_title: 'Training status'
    })
    const projector = new TimelineProjector([])

    expect(projector.append(scheduledRun)).toBe(true)
    expect(projector.items).toMatchObject([{ kind: 'job', id: 'job:legacy-run' }])
    expect(projector.append([legacyLink])).toBe(false)

    const rebuilt = projectTimeline([...scheduledRun, legacyLink], [])
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]).toMatchObject({
      kind: 'job',
      id: 'job:job-1',
      title: 'Training status',
      eventCount: 3,
      runCount: 1
    })
  })

  it('keeps the latest scheduled-run artifact when a runless lifecycle event follows it', () => {
    const file: AgentFile = { id: 'job-video', filename: 'status.mp4', content_type: 'video/mp4', seq: 3 }
    const items = projectTimeline([
      event(1, 'job_ran', { run_id: 'run-job-1', job_id: 'job-1', job_title: 'Render status' }),
      event(2, 'turn_started', { run_id: 'run-job-1', prompt: 'Render status' }),
      event(3, 'artifact_created', { run_id: 'run-job-1', artifact: file }),
      event(4, 'job_finished', { job_id: 'job-1', message: 'Job complete' })
    ], [file])

    expect(items).toHaveLength(1)
    expect(items[0].kind === 'job' ? items[0].events.some(candidate => candidate.artifact?.id === file.id) : false).toBe(true)
  })

  it('uses semantic job summary totals without rendering the summary as another run', () => {
    const items = projectTimeline([
      event(91, 'turn_finished', {
        run_id: 'job-run-11', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Previous status'
      }),
      event(99, 'turn_finished', {
        run_id: 'job-run-12', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Latest status'
      }),
      event(100, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1', job_title: 'Capacity monitor',
        result_text: 'Latest status', job_run_count: 12, job_event_count: 57,
        job_start_seq: 3, job_end_seq: 100
      })
    ], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'job',
      title: 'Capacity monitor',
      runCount: 12,
      eventCount: 57,
      startSeq: 3,
      endSeq: 100
    })
    if (items[0].kind === 'job') {
      expect(jobDisplayEvents(items[0].events).map(candidate => candidate.run_id)).toEqual([
        'job-run-11',
        'job-run-12'
      ])
    }
  })

  it('uses a current semantic summary when bounded detail only retains a marker-only newer run', () => {
    const items = projectTimeline([
      event(90, 'turn_finished', {
        run_id: 'job-run-170', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Latest completed capacity result'
      }),
      event(99, 'job_ran', {
        run_id: 'job-run-171', job_id: 'job-1',
        message: 'Scheduled job ran: Capacity monitor'
      }),
      event(100, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1', job_title: 'Capacity monitor',
        result_text: 'Latest completed capacity result',
        job_status: 'running', job_status_run_id: 'job-run-171',
        job_run_count: 171, job_event_count: 2_850,
        job_start_seq: 1, job_end_seq: 100
      })
    ], [])

    expect(items).toHaveLength(1)
    if (items[0].kind !== 'job') throw new Error('Expected job item')
    const selection = jobDisplaySelection(items[0])

    expect(selection.latest).toMatchObject({
      type: 'job_summary',
      result_text: 'Latest completed capacity result'
    })
    expect(selection.previous).toMatchObject([
      { type: 'job_ran', message: 'Scheduled job ran: Capacity monitor' }
    ])
    expect(selection.updates).toHaveLength(2)
    expect(items[0].latestStatus).toMatchObject({
      type: 'job_summary',
      job_status: 'running',
      job_status_run_id: 'job-run-171'
    })
  })

  it('uses an immutably anchored semantic summary as the authoritative segment snapshot', () => {
    const items = projectTimeline([
      event(1, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1',
        job_timeline_group_id: 'job:job-1', job_title: 'Capacity monitor',
        result_text: 'Latest completed capacity result',
        job_status: 'completed', job_status_run_id: 'job-run-171',
        job_status_seq: 100, job_run_count: 171, job_event_count: 2_850,
        job_start_seq: 1, job_end_seq: 100
      }),
      event(90, 'turn_finished', {
        run_id: 'job-run-170', purpose: 'scheduled_job', job_id: 'job-1',
        job_timeline_group_id: 'job:job-1', result_text: 'Earlier retained result'
      }),
      event(99, 'job_ran', {
        run_id: 'job-run-171', job_id: 'job-1',
        job_timeline_group_id: 'job:job-1', message: 'Scheduled job ran: Capacity monitor'
      })
    ], [])

    expect(items).toHaveLength(1)
    if (items[0].kind !== 'job') throw new Error('Expected job item')
    expect(items[0]).toMatchObject({
      seq: 1,
      startSeq: 1,
      endSeq: 100,
      runCount: 171,
      eventCount: 2_850,
      latestStatus: { type: 'job_summary', job_status: 'completed' }
    })
    expect(jobDisplaySelection(items[0]).latest).toMatchObject({
      type: 'job_summary',
      result_text: 'Latest completed capacity result'
    })
  })

  it('shows a runless deferral instead of stale output retained by a semantic summary', () => {
    const items = projectTimeline([
      event(90, 'turn_finished', {
        run_id: 'job-run-1', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Previous completed output'
      }),
      event(99, 'job_deferred', {
        purpose: 'scheduled_job', job_id: 'job-1',
        message: 'Scheduled job deferred: chat is busy'
      }),
      event(100, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1', job_title: 'Capacity monitor',
        result_text: 'Previous completed output',
        message: 'Scheduled job deferred: chat is busy',
        job_status: 'deferred', job_status_type: 'job_deferred',
        job_run_count: 1, job_event_count: 3,
        job_start_seq: 90, job_end_seq: 100
      })
    ], [])

    expect(items).toHaveLength(1)
    if (items[0].kind !== 'job') throw new Error('Expected job item')
    const selection = jobDisplaySelection(items[0])

    expect(selection.latest).toMatchObject({
      type: 'job_deferred',
      message: 'Scheduled job deferred: chat is busy'
    })
    expect(selection.previous).toMatchObject([
      { type: 'turn_finished', result_text: 'Previous completed output' }
    ])
  })

  it.each([
    'job_status_run_id',
    'job_latest_status_run_id',
    'job_latest_run_id'
  ] as const)('keeps metadata-light live activity in its scheduled-job card via %s', runField => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(100, 'job_summary', {
        purpose: 'scheduled_job',
        job_id: 'job-1',
        job_title: 'Capacity monitor',
        job_status: 'running',
        [runField]: 'current-job-run'
      })
    ])).toBe(true)
    expect(projector.append([
      event(101, 'reasoning_summary', {
        run_id: 'current-job-run',
        phase: 'commentary',
        text: 'Checking current capacity.'
      }),
      event(102, 'tool_started', {
        run_id: 'current-job-run',
        tool: { name: 'capacity_check' }
      })
    ])).toBe(true)

    expect(projector.items).toHaveLength(1)
    expect(projector.items[0]).toMatchObject({
      kind: 'job',
      key: 'job:job-1'
    })
    expect(projector.items[0].kind === 'job'
      ? projector.items[0].events.map(candidate => candidate.type)
      : []).toEqual(expect.arrayContaining(['reasoning_summary', 'tool_started']))
    expect(renderTimelineItems(projector.items).some(row => row.kind === 'progress')).toBe(false)
  })

  it('keeps unrelated live progress visible while a scheduled job is running', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(100, 'job_summary', {
        purpose: 'scheduled_job',
        job_id: 'job-1',
        job_title: 'Capacity monitor',
        job_status: 'running',
        job_status_run_id: 'current-job-run'
      }),
      event(101, 'reasoning_summary', {
        run_id: 'current-job-run',
        phase: 'commentary',
        text: 'Checking current capacity.'
      }),
      event(102, 'turn_started', {
        run_id: 'interactive-run',
        prompt: 'Explain the latest result.'
      }),
      event(103, 'reasoning_summary', {
        run_id: 'interactive-run',
        phase: 'commentary',
        text: 'Reviewing the latest result.'
      })
    ])).toBe(true)

    expect(projector.items.map(item => item.key)).toEqual([
      'job:job-1',
      'turn:interactive-run'
    ])
    expect(renderTimelineItems(projector.items).filter(row => row.kind === 'progress')).toMatchObject([{
      events: [{ run_id: 'interactive-run', text: 'Reviewing the latest result.' }]
    }])
  })

  it('increments aggregate run totals when a new scheduled run arrives live', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(90, 'turn_finished', {
        run_id: 'job-run-12', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Current status'
      }),
      event(100, 'job_summary', {
        purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'Current status', job_run_count: 12, job_event_count: 57
      })
    ])).toBe(true)
    expect(projector.append([
      event(101, 'turn_started', {
        run_id: 'job-run-13', purpose: 'scheduled_job', job_id: 'job-1',
        prompt: 'Check again'
      }),
      event(102, 'turn_finished', {
        run_id: 'job-run-13', purpose: 'scheduled_job', job_id: 'job-1',
        result_text: 'New status'
      })
    ])).toBe(true)

    expect(projector.items[0]).toMatchObject({
      kind: 'job',
      runCount: 13,
      eventCount: 59
    })
  })

  it('preserves unchanged row identities when one new turn is appended', () => {
    const firstEvents = [
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'First' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'Done' }),
      event(3, 'turn_finished', { run_id: 'run-1' })
    ]
    const previous = projectTimeline(firstEvents, [])
    const next = reconcileTimelineItems(previous, projectTimeline([
      ...firstEvents,
      event(4, 'turn_started', { run_id: 'run-2', prompt: 'Second' })
    ], []))
    expect(next[0]).toBe(previous[0])
    expect(next).toHaveLength(2)
  })

  it('splits a large turn into independently virtualized message, activity, and media rows', () => {
    const file: AgentFile = { id: 'image-1', filename: 'result.png', content_type: 'image/png', seq: 4 }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'First update' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(5, 'assistant_text', { run_id: 'run-1', text: 'Final update' })
    ], [file]))
    expect(rows.map(row => row.kind)).toEqual(['message', 'message', 'progress', 'message', 'media'])
    expect(rows.filter(row => row.kind === 'message' && row.role === 'assistant').map(row =>
      row.kind === 'message' ? messageItemText(row) : ''
    )).toEqual(['First update', 'Final update'])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  })

  it('binds uploaded inputs only to their referenced user turn and does not duplicate them as output media', () => {
    const file: AgentFile = { id: 'input-image', filename: 'question.png', content_type: 'application/octet-stream' }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Long-running work' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'Still working.' }),
      event(3, 'file_uploaded', { file }),
      event(4, 'turn_queued', { queued_id: 'queued-2', prompt: 'What is this?', file_ids: [file.id] }),
      event(5, 'turn_queue_updated', { queued_id: 'queued-2', prompt: 'What is this?', file_ids: [file.id], message: 'Queued turn updated.' }),
      event(6, 'turn_queue_reordered', { queued_id: 'queued-2', message: 'Queued turn moved.' }),
      event(7, 'turn_queue_run_now', { queued_id: 'queued-2', prompt: 'What is this?', file_ids: [file.id], message: 'Steering message promoted.' }),
      event(8, 'turn_finished', { run_id: 'run-1', result_text: 'Done.' }),
      event(9, 'turn_started', { run_id: 'run-2', queued_id: 'queued-2', prompt: 'What is this?', file_ids: [file.id] })
    ], []))

    const users = rows.filter((row): row is Extract<typeof row, { kind: 'message' }> => row.kind === 'message' && row.role === 'user')
    expect(users).toHaveLength(2)
    expect(users.map(messageItemText)).toEqual(['Long-running work', 'What is this?'])
    expect(users[0].files).toEqual([])
    expect(users[1].files).toEqual([file])
    expect(rows.some(row => row.kind === 'system')).toBe(false)
    expect(rows.some(row => row.kind === 'media')).toBe(false)
  })

  it('renders an image-only input as one user message with its owned attachment', () => {
    const file: AgentFile = { id: 'input-image', filename: 'question.png', content_type: 'image/png' }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: '', file_ids: [file.id] })
    ], [file]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', role: 'user', files: [file] })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : 'unexpected').toBe('')
  })

  it('hides legacy internal EDE diagnostics while preserving real provider errors', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'error', { message: '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use' }),
      event(2, 'error', { message: '  Claude stopped before\n completing the turn.  ' }),
      event(3, 'error', { message: 'Claude authentication failed.' })
    ], []))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'system', event: { message: 'Claude authentication failed.' } })
  })

  it('does not mount an empty trace row for provisional run metadata', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Start working' }),
      event(2, 'process_started', { run_id: 'run-1' }),
      event(3, 'provider_session', { run_id: 'run-1' }),
      event(4, 'reasoning_summary', { run_id: 'run-1', text: '   ' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message'])
  })

  it('mounts private reasoning once in the run activity row', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Start working' }),
      event(2, 'process_started', { run_id: 'run-1' }),
      event(3, 'reasoning_summary', { run_id: 'run-1', text: 'Checking the repository' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message', 'progress'])
    const activity = rows[1]
    expect(activity).toMatchObject({ kind: 'progress', active: true })
    expect(activity.kind === 'progress'
      ? activity.events.filter(candidate => candidate.type === 'reasoning_summary')
      : []
    ).toMatchObject([{ text: 'Checking the repository' }])
  })

  it('keeps canonical per-turn code diffs inside completed activity', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Fix it' }),
      event(2, 'code_diff', {
        run_id: 'run-1', files_changed: 1, additions: 4, deletions: 2,
        diff_files: [{ path: 'src/app.ts', additions: 4, deletions: 2 }]
      }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Fixed.' })
    ], []))

    expect(rows.map(row => row.kind)).toEqual(['message', 'progress', 'message'])
    expect(rows[1]).toMatchObject({ kind: 'progress', active: false, events: [{ type: 'code_diff' }] })
  })

  it('coalesces assistant updates into one stable response row', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Monitor it' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'First update' }),
      event(3, 'assistant_text', { run_id: 'run-1', text: 'Second update' }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Final update' })
    ], [])).filter(row => row.kind === 'message' && row.role === 'assistant')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'turn:run-1:assistant', events: [{ id: 'event-2' }, { id: 'event-3' }, { id: 'event-4' }] })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe('First update\n\nSecond update\n\nFinal update')
  })

  it('incrementally projects a large streamed response without rescanning earlier chunks', () => {
    const projector = new TimelineProjector([])
    expect(projector.append([
      event(1, 'turn_started', { run_id: 'run-stream', prompt: 'Stream it' })
    ])).toBe(true)

    for (let seq = 2; seq <= 2_001; seq += 1) {
      expect(projector.append([
        event(seq, 'assistant_text', { run_id: 'run-stream', text: `Unique streamed chunk ${seq}` })
      ])).toBe(true)
    }
    expect(projector.append([
      event(2_002, 'turn_finished', {
        run_id: 'run-stream',
        result_text: Array.from({ length: 2_000 }, (_, index) => `Unique streamed chunk ${index + 2}`).join('\n')
      })
    ])).toBe(true)

    const rows = renderTimelineItems(projector.items)
    const assistant = rows.find(row => row.kind === 'message' && row.role === 'assistant')
    expect(assistant).toMatchObject({ kind: 'message' })
    expect(assistant?.kind === 'message' ? assistant.events : []).toHaveLength(2_000)
    expect(assistant?.kind === 'message' ? assistant.events.at(-1)?.id : '').toBe('event-2001')
  })

  it('preserves every unchanged row when one update reaches a large chat', () => {
    let seq = 0
    const source: Event[] = []
    for (let turn = 0; turn < 200; turn += 1) {
      const runId = `run-${turn}`
      source.push(event(++seq, 'turn_started', { run_id: runId, prompt: `Prompt ${turn}` }))
      for (let update = 0; update < 4; update += 1) {
        source.push(event(++seq, 'assistant_text', { run_id: runId, text: `Turn ${turn} update ${update}` }))
      }
    }
    const semantic = projectTimeline(source, [])
    const previous = renderTimelineItems(semantic)
    expect(previous).toHaveLength(400)
    expect(previous.filter(row => row.kind === 'message' && row.role === 'assistant')).toHaveLength(200)
    expect(new Set(previous.map(row => row.key)).size).toBe(previous.length)

    const nextEvent = event(++seq, 'assistant_text', { run_id: 'run-199', text: 'One final update' })
    const nextSemantic = reconcileTimelineItems(semantic, projectTimeline([...source, nextEvent], []))
    const next = reconcileRenderTimelineItems(previous, renderTimelineItems(nextSemantic))
    expect(next.filter((row, index) => row !== previous[index])).toHaveLength(1)
    const latest = next.findLast(row => row.kind === 'message' && row.role === 'assistant')
    expect(latest?.kind === 'message' ? latest.events : []).toHaveLength(5)
  })

  it('refreshes activity visibility when a separate final answer arrives', () => {
    const previous: Extract<RenderTimelineItem, { kind: 'progress' }> = {
      kind: 'progress', id: 'activity', key: 'activity', seq: 1,
      active: false, hasFinalResponse: false,
      events: [event(1, 'reasoning_summary', { phase: 'commentary', text: 'Partial output' })]
    }
    expect(reconcileRenderTimelineItems([previous], [{ ...previous }])[0]).toBe(previous)
    const completed = { ...previous, hasFinalResponse: true }
    expect(reconcileRenderTimelineItems([previous], [completed])[0]).toBe(completed)
  })

  it('reuses rendered rows for unchanged semantic turns', () => {
    const semantic = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'tool_finished', { run_id: 'run-1', output: 'Done' }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Finished' })
    ], [])
    const first = renderTimelineItems(semantic)
    const second = renderTimelineItems(semantic)

    expect(second).not.toBe(first)
    expect(second).toHaveLength(first.length)
    expect(second.every((row, index) => row === first[index])).toBe(true)
  })

  it('keeps every imported prompt when a provider reuses one run id', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'import-1', prompt: 'First question' }),
      event(2, 'assistant_text', { run_id: 'import-1', text: 'First answer' }),
      event(3, 'turn_started', { run_id: 'import-1', prompt: 'Second question' }),
      event(4, 'assistant_text', { run_id: 'import-1', text: 'Second answer' })
    ], []))
    expect(rows.filter(row => row.kind === 'message').map(row => row.kind === 'message' ? messageItemText(row) : '')).toEqual([
      'First question', 'First answer', 'Second question', 'Second answer'
    ])
  })

  it('renders run-scoped provider errors as visible system rows instead of trace details', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Try it' }),
      event(2, 'error', { run_id: 'run-1', error: 'Model request failed' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'system'])
    expect(rows[1]).toMatchObject({ kind: 'system', event: { error: 'Model request failed' } })
  })

  it('keeps a run-scoped emergency alert as a standalone timeline row instead of folding it into the turn', () => {
    const items = projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Watch the deployment' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', text: 'Checking production health.' }),
      event(3, 'emergency_alert_raised', {
        run_id: 'run-1',
        emergency_alert_id: 'alert-1',
        message: 'The rollback needs immediate approval.'
      }),
      event(4, 'assistant_text', { run_id: 'run-1', text: 'Waiting for approval.' }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Waiting for approval.' }),
      event(6, 'turn_started', { run_id: 'run-2', prompt: 'Follow-up message' })
    ], [])

    expect(items.map(item => item.kind)).toEqual(['turn', 'system', 'turn'])
    expect(items[1]).toMatchObject({
      kind: 'system',
      id: 'event:event-3',
      key: 'event:event-3',
      seq: 3,
      event: {
        type: 'emergency_alert_raised',
        run_id: 'run-1',
        emergency_alert_id: 'alert-1',
        message: 'The rollback needs immediate approval.'
      }
    })
    const firstTurn = items[0]
    expect(firstTurn.kind === 'turn' ? firstTurn.trace.map(candidate => candidate.type) : []).toEqual(['reasoning_summary'])
    const foldedTurnEvents = firstTurn.kind === 'turn'
      ? [firstTurn.user, ...firstTurn.trace, ...firstTurn.assistant].filter((candidate): candidate is Event => Boolean(candidate))
      : []
    expect(foldedTurnEvents.some(candidate => candidate.type === 'emergency_alert_raised')).toBe(false)

    const rows = renderTimelineItems(items)
    expect(rows.filter(row => row.kind === 'system')).toHaveLength(1)
    expect(rows.find(row => row.kind === 'system')).toMatchObject({
      kind: 'system', event: { id: 'event-3', type: 'emergency_alert_raised' }
    })
    expect(rows.map(row => row.kind)).toEqual(['message', 'progress', 'system', 'message', 'message'])
  })

  it('keeps a live run-scoped team send receipt out of the trace and at its arrival position', () => {
    const projector = new TimelineProjector([])
    projector.append([
      event(1, 'turn_started', { run_id: 'run-live', prompt: 'Send the runbook to the team' }),
      event(2, 'reasoning_summary', {
        run_id: 'run-live', phase: 'commentary', text: 'Preparing the team message.'
      })
    ])
    projector.append([
      event(3, 'team_message_sent', {
        run_id: 'run-live', message_id: 'message-1', kind: 'message',
        recipients: [{ kind: 'human', display_name: 'DPark' }]
      }),
      event(4, 'reasoning_summary', {
        run_id: 'run-live', phase: 'commentary', text: 'The team message is saved.'
      })
    ])

    expect(projector.items.map(item => item.kind)).toEqual(['turn', 'system'])
    const turn = projector.items.find(item => item.kind === 'turn')
    expect(turn?.kind === 'turn' ? turn.trace.map(candidate => candidate.type) : []).toEqual([
      'reasoning_summary',
      'reasoning_summary'
    ])

    const rows = renderTimelineItems(projector.items)
    const progress = rows.find((row): row is Extract<RenderTimelineItem, { kind: 'progress' }> => row.kind === 'progress')
    expect(progress?.lifecycle).toBeUndefined()
    expect(rows.find(row => row.kind === 'system')).toMatchObject({
      kind: 'system', seq: 3,
      event: { type: 'team_message_sent', message_id: 'message-1' }
    })
    expect(settleInactiveTimelineItems(rows).map(row => (
      row.kind === 'system' ? row.event.type : row.kind
    ))).toEqual(['message', 'progress', 'team_message_sent'])
    expect(settleInactiveTimelineItems(rows).find(row => row.kind === 'progress')).toMatchObject({
      active: false
    })
  })

  it('keeps an emergency raised by a scheduled job out of the folded job card', () => {
    const items = projectTimeline([
      event(1, 'job_started', { run_id: 'run-job', job_id: 'job-1', purpose: 'scheduled_job' }),
      event(2, 'emergency_alert_raised', {
        run_id: 'run-job',
        job_id: 'job-1',
        purpose: 'scheduled_job',
        message: 'The scheduled deployment is damaging production.'
      }),
      event(3, 'job_finished', { run_id: 'run-job', job_id: 'job-1', purpose: 'scheduled_job' })
    ], [])

    expect(items.map(item => item.kind)).toEqual(['job', 'system'])
    expect(items[1]).toMatchObject({
      kind: 'system',
      event: { type: 'emergency_alert_raised', message: 'The scheduled deployment is damaging production.' }
    })
  })

  it('extracts the message from structured provider errors', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'error', { run_id: 'run-1', error: { type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Upgrade the CLI' } } })
    ], []))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'system' })
    if (rows[0].kind === 'system') expect(messageText(rows[0].event)).toBe('Upgrade the CLI')
  })

  it('extracts provider errors encoded as JSON message strings', () => {
    const value = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Upgrade the CLI' } })
    expect(messageText(event(1, 'error', { message: value }))).toBe('Upgrade the CLI')
  })

  it('never renders a compact injected provider-authority block as user text', () => {
    const prompt = [
      '@@Pat Tell Pat I said Hi.',
      '',
      '[AgentsDock provider authority]',
      'authority-file=/Users/test/.agentsdock/cross_chat_authority/run_aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)',
      'actions=cross_chat_instruction,team_send',
      'usage: see AgentsDock instructions',
      '[End AgentsDock provider authority]'
    ].join('\n')

    expect(messageText(event(1, 'turn_started', { prompt }))).toBe('@@Pat Tell Pat I said Hi.')
  })

  it('preserves ordinary user-authored provider-authority lookalike text', () => {
    const prompt = 'Document this example:\n\n[AgentsDock provider authority]\nnot a generated block\n[End AgentsDock provider authority]'
    expect(messageText(event(1, 'turn_started', { prompt }))).toBe(prompt)
  })

  it('suppresses an entire imported provider echo carrying generated authority', () => {
    const injectedPrompt = [
      '@@Atlas Send this to the server inbox.',
      '',
      '[AgentsDock provider authority]',
      'authority-file=/Users/test/.agentsdock/cross_chat_authority/run_aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json chat-id=sess_4f43bf0478084d9c (bound to this server, chat, and live run)',
      'actions=team_send',
      'usage: see AgentsDock instructions',
      '[End AgentsDock provider authority]'
    ].join('\n')
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-native', prompt: '@@Atlas Send this to the server inbox.' }),
      event(2, 'assistant_text', { run_id: 'run-native', text: 'Sent.' }),
      event(3, 'turn_finished', { run_id: 'run-native' }),
      event(4, 'history_imported', { message: 'Provider history synchronized.' }),
      event(5, 'turn_started', { run_id: 'import_abc', prompt: injectedPrompt }),
      event(6, 'assistant_text', { run_id: 'import_abc', text: 'Sent.' }),
      event(7, 'turn_finished', { run_id: 'import_abc' })
    ], []))

    expect(rows.filter(row => row.kind === 'message')).toHaveLength(2)
    expect(rows.filter(row => row.kind === 'message').map(row => row.role)).toEqual(['user', 'assistant'])
  })

  it('renders an imported Claude task notification as a bounded system update, never a user message', () => {
    const prompt = [
      '<task-notification>',
      '<task-id>task-background-1</task-id>',
      '<tool-use-id>toolu_01D2c1cBvxiaMKDYwSDnWt6m</tool-use-id>',
      '<status>stopped</status>',
      '<summary>No completion record was found for the background workflow. It may have stopped when the previous Claude process exited.</summary>',
      '</task-notification>'
    ].join('')
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'history_imported', { run_id: 'import_history_1', backend: 'claude' }),
      event(2, 'turn_started', { run_id: 'import_history_1', backend: 'claude', imported: true, prompt })
    ], []))

    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(0)
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'system',
        event: expect.objectContaining({
          type: 'provider_background_task_update',
          message: 'Background task stopped. No completion record was found for the background workflow. It may have stopped when the previous Claude process exited.'
        })
      })
    ])
  })

  it('preserves a user-authored Claude task-notification lookalike in a real turn', () => {
    const prompt = '<task-notification><task-id>example</task-id><tool-use-id>example</tool-use-id><status>stopped</status><summary>Keep this example.</summary></task-notification>'
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-user', backend: 'claude', prompt })
    ], []))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(rows[0].kind === 'message' ? messageItemText(rows[0]) : '').toBe(prompt)
  })

  it('keeps ordinary tool failures in the run activity', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect it' }),
      event(2, 'tool_finished', { run_id: 'run-1', is_error: true, output: 'Exit code 1' })
    ], []))
    expect(rows.map(row => row.kind)).toEqual(['message', 'progress'])
  })
})

describe('parseUnifiedDiff', () => {
  it('counts additions and deletions while retaining line numbers', () => {
    const files = parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 })
    expect(files[0].lines.some(line => line.kind === 'add' && line.newLine === 1)).toBe(true)
  })

  it('does not present git status output as a line-level code review', () => {
    const source = [
      ' M robot/rl/scripts/sim2sim/run_eval.py',
      '?? robot/rl/scripts/sim2sim/configs/new.yaml'
    ].join('\n')

    expect(parseUnifiedDiff(source)).toHaveLength(2)
    expect(parseReviewableDiff(source)).toEqual([])
  })

  it('retains complete git patches for the code review workspace', () => {
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(parseReviewableDiff(source)).toMatchObject([{ path: 'a.ts', additions: 1, deletions: 1 }])
  })

  it('recognizes Claude apply_patch input as a reviewable change', () => {
    const source = extractUnifiedDiff([event(1, 'tool_started', { tool: { name: 'Edit', input: { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' } } })])
    const files = parseUnifiedDiff(source)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 })
  })

  it('recovers structured Codex file changes across worktrees without duplicating tool completion', () => {
    const tool = {
      id: 'patch-1',
      name: 'apply_patch',
      input: {
        changes: [
          {
            path: '/Volumes/Dev/agi/ZenithDock-worktree/src/app.ts',
            filePath: null,
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra'
          },
          {
            path: null,
            filePath: '/Volumes/Other/project/src/new.ts',
            kind: { type: 'add', move_path: null },
            diff: '@@ -0,0 +1 @@\n+export const ready = true'
          }
        ]
      }
    }
    const events = [
      event(1, 'tool_started', { tool }),
      event(2, 'tool_finished', { tool, tool_id: 'patch-1' })
    ]

    const source = extractStructuredToolDiff(events)
    expect(parseReviewableDiff(source)).toMatchObject([
      { path: '/Volumes/Dev/agi/ZenithDock-worktree/src/app.ts', additions: 2, deletions: 1 },
      { path: '/Volumes/Other/project/src/new.ts', additions: 1, deletions: 0 }
    ])
    expect(source.match(/ZenithDock-worktree\/src\/app\.ts/g)).toHaveLength(1)
    expect(summarizeStructuredToolDiff(events)).toMatchObject({
      filesChanged: 2,
      additions: 3,
      deletions: 1
    })
  })

  it('groups multiple structured edits to one path and ignores unrelated changes arrays', () => {
    const path = '/Volumes/Dev/agi/ZenithDock-worktree/src/app.ts'
    const events = [
      event(1, 'tool_started', {
        tool: { id: 'patch-1', name: 'functions/apply_patch', input: { changes: [{ path, kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' }] } }
      }),
      event(2, 'tool_started', {
        tool: { id: 'patch-2', name: 'apply-patch', input: { changes: [{ path, kind: 'update', diff: '@@ -2 +2 @@\n-c\n+d' }] } }
      }),
      event(3, 'tool_started', {
        tool: { id: 'search-1', name: 'search', input: { changes: [{ path, diff: '@@ -3 +3 @@\n-e\n+f' }] } }
      })
    ]

    const source = extractUnifiedDiff(events)
    expect(parseReviewableDiff(source)).toMatchObject([
      { path, additions: 2, deletions: 2 }
    ])
    expect(summarizeStructuredToolDiff(events)?.filesChanged).toBe(1)
    expect(source).not.toContain('-e')
  })

  it('parses every file and hunk in a complete Git patch without advancing metadata lines', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,3 @@',
      ' same',
      '-old',
      '+new',
      '+extra',
      'diff --git a/b.ts b/b.ts',
      'index 3333333..4444444 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -40 +40 @@',
      '-before',
      '+after'
    ].join('\n'))

    expect(files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: 'a.ts', additions: 2, deletions: 1 },
      { path: 'b.ts', additions: 1, deletions: 1 }
    ])
    expect(files[0].lines.find(line => line.kind === 'context')).toMatchObject({ oldLine: 10, newLine: 10 })
    expect(files[1].lines.find(line => line.kind === 'remove')).toMatchObject({ oldLine: 40 })
  })
})

describe('reviewTargetBelongsToSession', () => {
  it('accepts only the currently selected chat as the owner of a review', () => {
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-1')).toBe(true)
    expect(reviewTargetBelongsToSession({ sessionId: 'chat-1', runId: 'run-1' }, 'chat-2')).toBe(false)
    expect(reviewTargetBelongsToSession(null, 'chat-1')).toBe(false)
  })
})

describe('sameCodeReviewTarget', () => {
  it('matches the same provider run so its Review button can toggle the dock', () => {
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', runId: 'run-1' },
      { sessionId: 'chat-1', runId: 'run-1', additions: 3 }
    )).toBe(true)
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', runId: 'run-1' },
      { sessionId: 'chat-1', runId: 'run-2' }
    )).toBe(false)
  })

  it('matches legacy inline reviews by their complete diff', () => {
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' },
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' }
    )).toBe(true)
    expect(sameCodeReviewTarget(
      { sessionId: 'chat-1', source: 'diff --git a/a b/a' },
      { sessionId: 'chat-2', source: 'diff --git a/a b/a' }
    )).toBe(false)
  })
})
