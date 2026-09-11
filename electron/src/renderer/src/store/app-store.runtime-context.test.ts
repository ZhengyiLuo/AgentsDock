import { describe, expect, it } from 'vitest'
import type { Event, SessionSnapshot } from '@shared/types'
import { mergeEvents, snapshotNeedsAuthoritativeTail, updateActiveSessions } from './app-store'

const runtimeContext: Event = {
  id: 'runtime-goal', session_id: 'chat-1', seq: 2, type: 'turn_started', ts: '2026-09-10T10:00:00Z',
  imported: true, backend: 'codex', run_id: 'import_codex-history',
  provider_runtime_context: 'goal', metadata_only: true,
  prompt: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n'
    + '<objective>Finish the renderer task.</objective>\n</codex_internal_context>'
}
const snapshot = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  session: { id: 'chat-1', title: 'Chat', backend: 'codex', latest_agent_event_seq: 0 },
  events: [runtimeContext], files: [], queuedTurns: [], eventsTotal: 1, historyVerified: true,
  hasMoreEvents: false, filesTotal: 0, cachedAt: 0, ...patch
})

describe('goal-runtime state neutrality', () => {
  it('does not start an idle chat or change a running chat', () => {
    for (const record of [runtimeContext, {
      ...runtimeContext, prompt: '', provider_runtime_context: 'goal' as const, metadata_only: true
    }]) {
      const idle = new Set<string>()
      const running = new Set(['chat-1'])
      expect(updateActiveSessions(idle, record)).toBe(idle)
      expect(updateActiveSessions(running, record)).toBe(running)
    }
  })

  it('keeps a verified context-only history settled and still repairs unverified or discontinuous history', () => {
    expect(snapshotNeedsAuthoritativeTail(snapshot())).toBe(false)
    expect(snapshotNeedsAuthoritativeTail(snapshot({ historyVerified: false }))).toBe(true)
    expect(snapshotNeedsAuthoritativeTail(snapshot({ historyDiscontinuity: true }))).toBe(true)
  })

  it('preserves real user runtime-wrapper quotations as visible history without inventing live work', () => {
    const record = { ...runtimeContext, provider_user_authored: true }
    const idle = new Set<string>()
    expect(updateActiveSessions(idle, record)).toBe(idle)
    expect(updateActiveSessions(idle, { ...record, imported: false, run_id: 'native-run' })).toEqual(new Set(['chat-1']))
    expect(snapshotNeedsAuthoritativeTail(snapshot({ events: [record], historyVerified: false }))).toBe(false)
  })

  it.each(['codex', 'claude'] as const)('does not stop an unrelated live %s run when a saved import finishes', backend => {
    const running = new Set(['chat-1'])
    const start = { ...runtimeContext, backend }
    const terminal = { ...start, id: 'import-finish', seq: 3, type: 'turn_finished',
      provider_runtime_context: undefined, metadata_only: undefined, prompt: undefined }
    expect(updateActiveSessions(updateActiveSessions(running, start), terminal)).toBe(running)
    expect(updateActiveSessions(running, { ...terminal, imported: false, run_id: 'native-run' })).toEqual(new Set())
  })

  it('retains the server-proven repair when stale history and live copies overlap', () => {
    const corrected = { ...runtimeContext, prompt: '' }
    const stale = { ...runtimeContext, provider_runtime_context: undefined, metadata_only: undefined }
    const repaired = [corrected]
    expect(mergeEvents([stale], repaired)).toEqual(repaired)
    expect(mergeEvents(repaired, [stale])).toBe(repaired)
    expect(mergeEvents([stale], [corrected, stale])).toEqual(repaired)
  })
})
