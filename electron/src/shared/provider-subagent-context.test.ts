import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event, ProviderHistoryOrigin, QueuedTurn } from './types'
import { isImportedCodexRuntimeNotification, isImportedProviderControlMetadata, mergeProviderInterruptionEvent } from './provider-origin'
import { incompleteLeadingRunId, timelineSemanticUnits } from './semantic-timeline'
import { updateQueuedTurns } from './queue'

describe.each([
  ['subagent_notification', '<subagent_notification>{"agent_path":"synthetic-worker","status":{"completed":"Synthetic result"}}</subagent_notification>'],
  ['turn_aborted', '<turn_aborted>The previous turn was interrupted. A synthetic task may still be running.</turn_aborted>']
] as const)('source-proven Codex %s runtime context', (kind, prompt) => {
  const corrected = (): Event & { provider_origin: ProviderHistoryOrigin } => ({
    id: 'notification', session_id: 'chat', seq: 8, type: 'turn_started', ts: '2026-09-11T10:00:00Z',
    run_id: 'import_history', backend: 'codex', imported: true, prompt: '',
    provider_runtime_context: kind, metadata_only: true,
    provider_origin: { provider: 'codex', kind, event_id: 'provider-item',
      session_id: 'provider-thread', turn_id: 'provider-turn', timestamp: '2026-09-11T09:58:00.125Z',
      source_text_sha256: bytesToHex(sha256(utf8ToBytes(prompt))) }
  })
  const stale = (): Event => ({ ...corrected(), prompt, provider_runtime_context: undefined,
    metadata_only: undefined, provider_origin: undefined })

  it('requires complete runtime provenance and preserves raw wrappers and positive user evidence', () => {
    expect(isImportedCodexRuntimeNotification(corrected())).toBe(true)
    expect(isImportedProviderControlMetadata(corrected())).toBe(true)
    const rejected: Partial<Event>[] = [
      { imported: false }, { backend: 'claude' }, { run_id: 'native-run' }, { type: 'assistant_text' },
      { provider_runtime_context: undefined }, { metadata_only: false }, { prompt },
      { provider_user_authored: true }, { provider_origin: undefined },
      ...['event_id', 'session_id', 'turn_id', 'source_text_sha256', 'timestamp'].map(key => ({
        provider_origin: { ...corrected().provider_origin!, [key]: '' }
      })),
      { provider_origin: { ...corrected().provider_origin!, kind: 'user' } },
      { provider_origin: { ...corrected().provider_origin!, kind: kind === 'turn_aborted' ? 'subagent_notification' : 'turn_aborted' } },
      { provider_origin: { ...corrected().provider_origin!, timestamp: '2026-09-11' } }
    ]
    for (const patch of rejected) expect(isImportedCodexRuntimeNotification({ ...corrected(), ...patch })).toBe(false)
    for (const key of ['clientUserMessageId', 'clientId', 'client_user_message_id', 'client_id']) {
      expect(isImportedCodexRuntimeNotification({ ...corrected(), [key]: 'human-client' } as Event)).toBe(false)
    }
    expect(isImportedCodexRuntimeNotification(stale())).toBe(false)
  })

  it('retains only an exact same-record full-hash repair through a stale merge', () => {
    const repair = corrected()
    expect(mergeProviderInterruptionEvent(stale(), repair)).toBe(repair)
    expect(mergeProviderInterruptionEvent(repair, stale())).toBe(repair)
    for (const patch of [{ id: 'other' }, { session_id: 'other' }, { seq: 9 }, { run_id: 'import_other' },
      { ts: '2026-09-11T10:01:00Z' }, { prompt: `${prompt}\nExplain this.` }, { provider_user_authored: true },
      { metadata_only: false }, { backend: 'claude' }]) {
      const incoming = { ...stale(), ...patch } as Event
      expect(mergeProviderInterruptionEvent(repair, incoming)).toBe(incoming)
    }
  })

  it('does not consume queue entries or history slots, or hide a real continuation needing backfill', () => {
    const notification = corrected()
    const queue: QueuedTurn[] = [{ queued_id: 'queued', session_id: 'chat', prompt: 'Actual user input', position: 1, file_ids: [] }]
    expect(updateQueuedTurns(queue, { ...notification, queued_id: 'queued' })).toBe(queue)
    expect(timelineSemanticUnits([notification])).toEqual([])
    const continuation: Event = { ...stale(), id: 'answer', seq: 9, type: 'assistant_text', text: 'Actual continuation' }
    expect(timelineSemanticUnits([notification, continuation])).toEqual([
      expect.objectContaining({ key: 'run:import_history', events: [continuation] })
    ])
    expect(incompleteLeadingRunId([notification, continuation])).toBe('import_history')
  })
})
