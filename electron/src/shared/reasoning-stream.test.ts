import { describe, expect, it } from 'vitest'
import { isReasoningSummaryStream } from './reasoning-stream'

const item = { run_id: 'run', item_id: 'native-item', backend: 'codex', phase: 'summary', text: 'Summary', after_seq: 1, ts: '2026-09-20T10:00:00Z' }
const packet = { type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot', revision: 1, items: [item] }

describe('reasoning channel validation', () => {
  it('accepts independent summary and plaintext channels, rejecting duplicates or unknown phases', () => {
    expect(isReasoningSummaryStream({ ...packet, items: [item, { ...item, phase: 'reasoning', text: 'Provider plaintext' }] })).toBe(true)
    expect(isReasoningSummaryStream({ ...packet, items: [item, { ...item }] })).toBe(false)
    expect(isReasoningSummaryStream({ ...packet, items: [{ ...item, phase: 'encrypted' }] })).toBe(false)
  })
})
