import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { messageItemText, projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `wake-${seq}`, session_id: 'chat-wake', seq, type,
  ts: `2026-09-12T12:00:0${seq}Z`, run_id: 'native-wake', backend: 'codex', ...patch
})
const wake = (patch: Partial<Event> = {}): Event => event(1, 'turn_started', {
  purpose: 'chat_mailbox_wake', prompt: '', provider_generated: true,
  mailbox_wake_id: `mailwake_${'a'.repeat(32)}`, mailbox_wake_through_seq: 7,
  provider_input_sha256: 'b'.repeat(64), ...patch
})

describe('native quiet mailbox wake', () => {
  it.each(['codex', 'claude'] as const)('keeps %s live work and results without a fake You input, cold and appended', backend => {
    const records = [wake({ backend }),
      event(2, 'reasoning_summary', { backend, text: 'Checking the mailbox', phase: 'commentary' })]
    clearTimelineProjectionCache()
    const live = cachedTimelineProjection(`wake-${backend}`, records, []).rendered
    expect(live.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(live.find(row => row.kind === 'progress')).toMatchObject({ active: true })
    records.push(event(3, 'turn_finished', { backend, result_text: 'The requested response is ready.' }))
    const cold = renderTimelineItems(projectTimeline(records, []))
    expect(cachedTimelineProjection(`wake-${backend}`, records, []).rendered).toEqual(cold)
    expect(cold.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(cold.filter(row => row.kind === 'message').map(row => messageItemText(row))).toEqual(['The requested response is ready.'])
    expect(cold.find(row => row.kind === 'progress')).toMatchObject({ active: false })
  })

  it.each([
    { purpose: undefined }, { provider_generated: false }, { mailbox_wake_id: 'unproven' },
    { mailbox_wake_through_seq: 0 }, { provider_input_sha256: 'incomplete' },
    { provider_user_authored: true }, { imported: true, run_id: 'import_wake' },
    { prompt: 'Check the unread mailbox using the chat inbox tool.' }
  ] satisfies Partial<Event>[])('preserves inputs without the exact native marker: %j', patch => {
    const input = wake(patch)
    const rows = renderTimelineItems(projectTimeline([input], []))
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
    expect(messageItemText(rows.find(row => row.kind === 'message')!)).toBe(input.prompt)
  })
})
