import { describe, expect, it } from 'vitest'
import type { Event, QueuedTurn } from './types'
import { isImportedCodexGoalContext, isImportedProviderControlMetadata, mergeProviderInterruptionEvent } from './provider-origin'
import { updateQueuedTurns } from './queue'
import { incompleteLeadingRunId, timelineSemanticUnits } from './semantic-timeline'

const goalPrompt = '<codex_internal_context source="goal">\n'
  + 'Continue working toward the active thread goal.\n'
  + '<objective>Finish the renderer task.</objective>\n'
  + 'Keep the goal active until the work is complete.\n</codex_internal_context>'

const context = (patch: Partial<Event> = {}): Event => ({
  id: 'imported-goal', session_id: 'chat-1', seq: 2, type: 'turn_started',
  ts: '2026-09-10T10:00:00Z', imported: true, backend: 'codex',
  run_id: 'import_codex-history', prompt: goalPrompt,
  provider_runtime_context: 'goal', metadata_only: true, ...patch
})

describe('imported Codex goal-runtime provenance', () => {
  it('recognizes the exact imported runtime envelope and server-projected metadata', () => {
    for (const record of [context(), context({ prompt: goalPrompt.replace('"goal"', "'goal'") }), context({
      prompt: '', provider_runtime_context: 'goal', metadata_only: true
    })]) {
      expect(isImportedCodexGoalContext(record)).toBe(true)
      expect(isImportedProviderControlMetadata(record)).toBe(true)
    }
  })

  it.each([
    ['native user input', { imported: false }],
    ['missing import provenance', { imported: undefined }],
    ['other provider', { backend: 'claude' }],
    ['missing provider', { backend: undefined }],
    ['native run', { run_id: 'native-run' }],
    ['missing run', { run_id: undefined }],
    ['malformed run', { run_id: 12 }],
    ['malformed prompt', { prompt: { text: goalPrompt } }],
    ['exact wrapper without proven content origin', { provider_runtime_context: undefined, metadata_only: undefined }],
    ['missing runtime kind', { provider_runtime_context: undefined }],
    ['missing metadata flag', { metadata_only: undefined }],
    ['assistant output', { type: 'assistant_text', text: goalPrompt }],
    ['unproven empty input', { prompt: '', provider_runtime_context: undefined, metadata_only: undefined }],
    ['empty input without metadata flag', { prompt: '', metadata_only: undefined }],
    ['empty input without runtime kind', { prompt: '', provider_runtime_context: undefined }],
    ['positive human provenance', { provider_user_authored: true }],
    ['user preface', { prompt: `Explain this wrapper:\n${goalPrompt}` }],
    ['user follow-up', { prompt: `${goalPrompt}\nWhat does this mean?` }],
    ['code quotation', { prompt: `\`\`\`xml\n${goalPrompt}\n\`\`\`` }],
    ['ordinary text inside the wrapper', { prompt: '<codex_internal_context source="goal">Please explain goals.</codex_internal_context>' }],
    ['missing objective', { prompt: goalPrompt.replace(/<objective>.*<\/objective>/, '') }],
    ['duplicate objective', { prompt: goalPrompt.replace('</objective>', '</objective><objective>Other goal</objective>') }],
    ['nested context wrapper', { prompt: goalPrompt.replace('</objective>', `</objective>${goalPrompt}`) }],
    ['unclosed wrapper', { prompt: goalPrompt.replace('</codex_internal_context>', '') }]
  ])('preserves %s as ordinary input', (_name, patch) => {
    expect(isImportedCodexGoalContext(context(patch as Partial<Event>))).toBe(false)
  })

  it('preserves exact wrapper quotations with provider client IDs or human origin aliases', () => {
    const provenance = [
      { clientUserMessageId: 'client-message' }, { clientId: 'client' },
      { client_user_message_id: 'client-message' }, { client_id: 'client' },
      ...['human', 'user', 'user_input', 'user-input'].flatMap(kind => [
        { origin: { provider: 'codex', kind } }, { provider_origin: { provider: 'codex', kind } }
      ])
    ]
    for (const fields of provenance) {
      expect(isImportedCodexGoalContext({ ...context(), ...fields } as Event)).toBe(false)
    }
  })

  it('does not consume or reorder the real queue from imported control fields', () => {
    const queue: QueuedTurn[] = [
      { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Real user input', file_ids: [], position: 1 }
    ]
    expect(updateQueuedTurns(queue, context({
      queued_id: 'queued-1', positions: [{ queued_id: 'queued-1', position: 8 }]
    }))).toBe(queue)
  })

  it('does not spend semantic history slots or hide the leading real run that needs backfill', () => {
    expect(timelineSemanticUnits([context()])).toEqual([])
    const continuation = { ...context(), id: 'real-continuation', seq: 3, type: 'assistant_text',
      run_id: 'real-run', text: 'Real output', provider_runtime_context: undefined, metadata_only: undefined }
    expect(timelineSemanticUnits([context(), continuation])).toEqual([
      expect.objectContaining({ key: 'run:real-run', events: [continuation] })
    ])
    expect(incompleteLeadingRunId([context(), continuation])).toBe('real-run')
    expect(incompleteLeadingRunId([context()])).toBeNull()
  })

  it('preserves a proven context correction over its stale unmarked history copy', () => {
    const corrected = context({ prompt: '' })
    const stale = context({ provider_runtime_context: undefined, metadata_only: undefined })
    expect(mergeProviderInterruptionEvent(stale, corrected)).toBe(corrected)
    expect(mergeProviderInterruptionEvent(corrected, stale)).toBe(corrected)
  })

  it.each([
    { id: 'different-event' }, { session_id: 'different-chat' }, { seq: 3 }, { run_id: 'import_other' },
    { imported: false }, { backend: 'claude' }, { metadata_only: false }, { provider_user_authored: true },
    { prompt: 'Actually authored by the user' }, { prompt: { text: goalPrompt } }
  ])('keeps incoming authority when a context correction does not prove the same stale event %j', patch => {
    const incoming = context({ provider_runtime_context: undefined, metadata_only: undefined, ...patch } as Partial<Event>)
    expect(mergeProviderInterruptionEvent(context({ prompt: '' }), incoming)).toBe(incoming)
  })
})
