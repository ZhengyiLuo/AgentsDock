import { describe, expect, it, vi } from 'vitest'
import type { Event } from './types'
import { compactTimelineEvent, compactTimelineEvents, TOOL_OUTPUT_PREVIEW_CHARS } from './event-compaction'
import { hasTimelineChangeSignal } from './timeline-change-signal'

function event(type: string, values: Partial<Event> = {}): Event {
  return {
    id: `event-${type}`,
    session_id: 'chat',
    seq: 1,
    type,
    ts: '2026-07-24T12:00:00Z',
    ...values
  }
}

describe('timeline event compaction', () => {
  it('retains the displayed tool output and appends a clear omission marker', () => {
    const original = event('tool_finished', { output: 'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 37) })

    const compacted = compactTimelineEvent(original)

    expect(compacted).not.toBe(original)
    expect(compacted.output?.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)).toBe('x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS))
    expect(compacted.output?.slice(TOOL_OUTPUT_PREVIEW_CHARS)).toBe(
      '\n\n[AgentsDock omitted 37 characters from this tool output]'
    )
    expect(original.output).toHaveLength(TOOL_OUTPUT_PREVIEW_CHARS + 37)
    expect(compactTimelineEvent(compacted)).toBe(compacted)
  })

  it('does not truncate user, assistant, or non-result tool events', () => {
    const text = 'a'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 500)
    const events = [
      event('assistant_text', { text }),
      event('turn_started', { prompt: text }),
      event('tool_started', { output: text })
    ]

    expect(compactTimelineEvents(events)).toBe(events)
    expect(events[0].text).toBe(text)
    expect(events[1].prompt).toBe(text)
    expect(events[2].output).toBe(text)
  })

  it.each([
    'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
    '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch',
    '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
    ' M src/app.ts'
  ])('preserves oversized change output for code review: %s', changeSignal => {
    const output = `${'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 100)}\n${changeSignal}`
    const original = event('tool_finished', { output })

    expect(compactTimelineEvent(original)).toBe(original)
    expect(original.output).toBe(output)
  })

  it.each([
    'DIFF --GIT a/src/app.ts b/src/app.ts',
    '*** BEGIN PATCH\n*** UPDATE FILE: src/app.ts',
    '*** Add File: src/app.ts',
    '*** DELETE FILE: src/app.ts'
  ])('matches change markers case-insensitively without lowercasing the full output: %s', marker => {
    const toLocaleLowerCase = vi.spyOn(String.prototype, 'toLocaleLowerCase')

    const result = hasTimelineChangeSignal(`${'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS)}\n${marker}`)
    const lowercaseCalls = toLocaleLowerCase.mock.calls.length
    toLocaleLowerCase.mockRestore()

    expect(result).toBe(true)
    expect(lowercaseCalls).toBe(0)
  })
})
