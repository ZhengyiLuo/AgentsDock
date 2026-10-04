import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { isHandoffDigestEvent, projectTimeline, renderTimelineItems } from './timeline'

describe('OpenCode visible native context breaks', () => {
  it.each([
    ['ordinary', {}],
    ['scheduled', { purpose: 'scheduled_job', job_id: 'job' }],
    ['digest', { purpose: 'handoff_digest', digest_job_id: 'digest' }]
  ] as const)('retains a standalone reset notice for %s turns in compact history', (_label, context) => {
    const make = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({ id: `event-${seq}`, session_id: 'chat', seq, type, ts: '', backend: 'opencode', run_id: 'run', ...context, ...patch })
    const events = [make(1, 'turn_started', { prompt: 'Inspect files' }),
      make(2, 'provider_session_reset', { message: 'The interrupted OpenCode session was quarantined. The next turn starts fresh.' }),
      make(3, 'turn_stopped', { message: 'Stopped' })]
    const projected = projectTimeline(events, [])
    const notice = projected.find(item => item.kind === 'system' && item.event.type === 'provider_session_reset')
    expect(notice).toMatchObject({ kind: 'system', seq: 2, event: { message: expect.stringContaining('starts fresh') } })
    expect(renderTimelineItems(projected)).toContain(notice)
    // SystemView uses the same predicate for title/body selection. A digest
    // owner must not replace the visible reset message with digest status.
    expect(isHandoffDigestEvent(events[1])).toBe(false)
  })
})
