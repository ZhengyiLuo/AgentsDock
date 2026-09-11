import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event, SessionSnapshot } from '@shared/types'
import { isAgentVisibleEvent, isTimelineError, messageItemText, projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { mergeEvents, snapshotNeedsAuthoritativeTail, updateActiveSessions } from '../store/app-store'

describe.each([
  ['subagent_notification', '<subagent_notification>{"agent_path":"synthetic-worker","status":{"completed":"Synthetic result"}}</subagent_notification>'],
  ['turn_aborted', '<turn_aborted>The previous turn was interrupted. A synthetic task may still be running.</turn_aborted>'],
  ['provider_notice', 'Synthetic provider compaction summary, not a human message.']
] as const)('%s runtime context projection', (kind, prompt) => {
  const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
    id: `event-${seq}`, session_id: 'chat', seq, type, ts: '2026-09-11T10:00:00Z', backend: 'codex', ...patch
  })
  const notification = (): Event => event(3, 'turn_started', {
    imported: true, run_id: 'import_history', prompt: '', metadata_only: true,
    provider_runtime_context: kind,
    provider_origin: { provider: 'codex', kind, event_id: 'provider-item',
      session_id: 'provider-thread', turn_id: 'provider-turn', timestamp: '2026-09-11T09:58:00.125Z',
      source_text_sha256: bytesToHex(sha256(utf8ToBytes(prompt))) }
  })

  it('hides only the proven input without deleting its assistant continuation or changing native activity', () => {
    const record = notification()
    const records = [event(1, 'turn_started', { run_id: 'native', prompt: 'Actual task' }),
      event(2, 'turn_finished', { run_id: 'native', result_text: 'Actual final answer' }), record,
      event(4, 'assistant_text', { imported: true, run_id: 'import_history', text: 'Actual continuation' })]
    const rows = renderTimelineItems(projectTimeline(records, []))
    expect(rows.filter(row => row.kind === 'message').map(row => messageItemText(row)))
      .toEqual(['Actual task', 'Actual final answer', 'Actual continuation'])
    expect(isAgentVisibleEvent(record)).toBe(false)
    expect(isTimelineError({ ...record, is_error: true, error: 'Not a live error' })).toBe(false)
    const active = new Set(['chat'])
    expect(updateActiveSessions(active, record)).toBe(active)
    const idle = new Set<string>()
    expect(updateActiveSessions(idle, record)).toBe(idle)
  })

  it('preserves unproven wrappers, exact human quotations, and incomplete or mixed text', () => {
    for (const patch of [
      { provider_runtime_context: undefined, metadata_only: undefined, provider_origin: undefined },
      { provider_user_authored: true }, { imported: false },
      { prompt: `Explain this:\n${prompt}` }, { prompt: prompt.replace(`</${kind}>`, '') }
    ]) {
      const record = { ...notification(), prompt, ...patch } as Event
      expect(renderTimelineItems(projectTimeline([record], []))).toEqual([
        expect.objectContaining({ kind: 'message', role: 'user', event: record })
      ])
    }
  })

  it('repairs a stale cached input in either merge order and remains stable on append and reopen', () => {
    clearTimelineProjectionCache()
    const repair = notification()
    const stale: Event = { ...repair, prompt, provider_runtime_context: undefined, metadata_only: undefined, provider_origin: undefined }
    const records = [event(1, 'turn_started', { run_id: 'native', prompt: 'Actual task' })]
    const original = cachedTimelineProjection('subagent', records, [])
    records.push(repair)
    const appended = cachedTimelineProjection('subagent', records, [])
    expect(appended.strategy).toBe('append')
    expect(appended.rendered).toBe(original.rendered)
    expect(appended.rendered).toEqual(cachedTimelineProjection('reopened', records, []).rendered)
    expect(mergeEvents([stale], [repair])).toEqual([repair])
    expect(mergeEvents([repair], [stale])).toEqual([repair])
    const snapshot: SessionSnapshot = { session: { id: 'chat', title: 'Synthetic chat', backend: 'codex' },
      events: [repair], files: [], queuedTurns: [], eventsTotal: 1, historyVerified: true,
      hasMoreEvents: false, filesTotal: 0, cachedAt: 0 }
    expect(snapshotNeedsAuthoritativeTail(snapshot)).toBe(false)
    expect(snapshotNeedsAuthoritativeTail({ ...snapshot, historyVerified: false })).toBe(true)
    expect(snapshotNeedsAuthoritativeTail({ ...snapshot, historyDiscontinuity: true })).toBe(true)
  })
})
