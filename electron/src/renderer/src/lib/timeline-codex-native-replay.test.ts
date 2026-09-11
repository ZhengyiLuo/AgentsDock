import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event } from '@shared/types'
import { isImportedSourceProvenNativeReplay, mergeProviderInterruptionEvent } from '@shared/provider-origin'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, extra: Partial<Event>): Event => ({
  seq, type, id: `example-${seq}`, session_id: 'example-chat', ts: '2026-09-11T12:00:00Z', backend: 'codex', ...extra
})
function repaired(source: Event, nativeId: string): Event {
  const body = source.type === 'turn_started' ? source.prompt! : source.text!
  return { ...source, ...(source.type === 'turn_started' ? { prompt: '' } : { text: '' }),
    metadata_only: true, provider_history_repair: 'source_proven_native_replay',
    provider_origin: { provider: 'codex', kind: source.type === 'turn_started' ? 'user' : 'assistant',
      event_id: `source-${source.id}`, turn_id: `turn-${nativeId}`, session_id: 'provider-thread',
      timestamp: source.ts, native_event_id: nativeId, source_text_sha256: bytesToHex(sha256(utf8ToBytes(body))) } }
}

describe('source-proven native Codex history copies', () => {
  it('preserves original human/answer then job while removing only exact imported copies from a mixed batch', () => {
    const originals = [event(1, 'turn_started', { run_id: 'human', prompt: 'Set up monitoring' }),
      event(2, 'turn_finished', { run_id: 'human', result_text: 'Monitoring enabled' }),
      event(3, 'turn_started', { run_id: 'job-run', job_id: 'job', purpose: 'scheduled_job', prompt: 'Scheduled input' }),
      event(4, 'turn_finished', { run_id: 'job-run', job_id: 'job', result_text: 'Scheduled report' })]
    const imported = [event(100, 'turn_started', { run_id: 'import_batch', imported: true, provider_user_authored: true, prompt: 'Set up monitoring' }),
      event(101, 'assistant_text', { run_id: 'import_batch', imported: true, text: 'Monitoring enabled' }),
      event(102, 'turn_started', { run_id: 'import_batch', imported: true, provider_user_authored: true, prompt: 'Scheduled input' }),
      event(103, 'assistant_text', { run_id: 'import_batch', imported: true, text: 'Scheduled report' })]
    const corrected = imported.map((row, index) => repaired(row, originals[index].id))
    const unrelated = [event(104, 'assistant_text', { run_id: 'import_batch', imported: true, text: 'Unmatched later output remains' }),
      event(105, 'turn_started', { run_id: 'import_batch', imported: true, provider_user_authored: true, prompt: 'A real question quoting Scheduled input' }),
      event(106, 'turn_finished', { run_id: 'import_batch', imported: true, result_text: 'Genuine later answer' })]
    const final = [...originals, ...corrected, ...unrelated]
    clearTimelineProjectionCache()
    cachedTimelineProjection('codex-native-replay', [...originals, ...imported], [])
    const rows = cachedTimelineProjection('codex-native-replay', final, []).rendered
    expect(rows).toEqual(renderTimelineItems(projectTimeline(final, [])))
    expect(rows.map(row => row.kind === 'message' ? row.role : row.kind)).toEqual(['user', 'assistant', 'job', 'assistant', 'user', 'assistant'])
    expect(rows.flatMap(row => row.kind === 'message' && row.role === 'user' ? [row.event.prompt] : []))
      .toEqual(['Set up monitoring', 'A real question quoting Scheduled input'])
  })

  it('retains a repaired exact same-ID copy against stale cache replay, without hiding changed text', () => {
    const stale = event(100, 'turn_started', { run_id: 'import_batch', imported: true, provider_user_authored: true, prompt: 'Exact duplicate' })
    const correction = repaired(stale, 'native-original')
    expect(isImportedSourceProvenNativeReplay(correction)).toBe(true)
    expect(mergeProviderInterruptionEvent(correction, stale)).toBe(correction)
    expect(mergeProviderInterruptionEvent(stale, correction)).toBe(correction)
    const changed = { ...stale, prompt: 'Different genuine text' }
    expect(mergeProviderInterruptionEvent(correction, changed)).toBe(changed)
    for (const invalid of [{ ...correction, metadata_only: false }, { ...correction, provider_origin: null },
      { ...correction, backend: 'claude' as const }, { ...correction, imported: false }]) {
      expect(isImportedSourceProvenNativeReplay(invalid)).toBe(false)
    }
  })
})
