import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { claudeCompactOutput } from '../lib/claude-compact-output'
import { projectTimeline, reconcileRenderTimelineItems, renderTimelineItems, type MessageItem } from '../lib/timeline'
import { TimelineRowView } from './TimelineRows'

const input: Event = { id: 'input', seq: 1, session_id: 'test-chat', run_id: 'test-run',
  backend: 'claude', type: 'turn_started', ts: '2026-11-03T20:00:00Z', prompt: '/compact' }
const hook = 'Compacted PostCompact [echo "${HOME}"; printf "{}"] completed successfully: {}'
const output: Event = { ...input, id: 'output', seq: 2, type: 'assistant_text', prompt: undefined,
  provider_message_id: 'native-command-output', text: hook }
const clipboard = vi.fn().mockResolvedValue(undefined)

function row(events: Event[] = [input, output]): MessageItem {
  return renderTimelineItems(projectTimeline(events, [])).find(item => item.kind === 'message'
    && item.role === 'assistant') as MessageItem
}
function show(item = row()) {
  return render(<TimelineRowView item={item} sessionId="test-chat" profileScope={null}
    pinnedItemIds={new Set()} onFindFile={() => {}} />)
}
beforeEach(() => {
  clipboard.mockClear()
  Object.defineProperty(window, 'agentsDock', { configurable: true,
    value: { native: { writeClipboard: clipboard } } as unknown as AgentsDockAPI })
})
afterEach(cleanup)
afterEach(() => setLocale('en'))

describe('Claude compact command presentation', () => {
  it('folds successful hook diagnostics without modifying stored or copied text', async () => {
    const events = structuredClone([input, output])
    const { container, rerender } = show(row(events))
    expect(screen.getByText('Context compacted')).toBeVisible()
    expect(screen.getByText('Command output')).toBeVisible()
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')!.textContent).toBe(hook)
    expect(container.querySelector('.katex')).toBeNull()
    fireEvent.click(screen.getByText('Command output'))
    expect(details.open).toBe(true)
    fireEvent.click(screen.getByTitle('Copy full message'))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(hook))
    rerender(<TimelineRowView item={row(structuredClone(events))} sessionId="test-chat"
      profileScope={null} pinnedItemIds={new Set()} onFindFile={() => {}} />)
    expect(container.querySelectorAll('.claude-compact-output')).toHaveLength(1)
    expect(events).toEqual([input, output])
  })

  it('localizes controls but keeps native diagnostic bytes intact', () => {
    const { container } = show()
    act(() => setLocale('zh-CN'))
    expect(screen.getByText('上下文已压缩')).toBeVisible()
    expect(screen.getByText('命令输出')).toBeVisible()
    expect(container.querySelector('pre')!.textContent).toBe(hook)
  })

  it('updates a retained row when its exact compact input arrives or changes', () => {
    const complete = row()
    const partial = { ...complete, claudeCompactInput: undefined }
    expect(reconcileRenderTimelineItems([partial], [complete])[0]).toBe(complete)
    expect(reconcileRenderTimelineItems([complete], [partial])[0]).toBe(partial)
    expect(reconcileRenderTimelineItems([complete], [{ ...complete }])[0]).toBe(complete)
  })

  it.each([
    'Compacted PostCompact [helper] failed: exit code 1',
    'Compacted PostCompact [helper] completed successfully: warning: check settings',
    'Compacted PostCompact [helper] completed successfully: {"message":"Keep this output"}',
    'Compacted PostCompact [helper] timed out',
    'Compacted PostCompact [one] completed successfully: {} PostCompact [two] failed: denied',
    'Compacted PostCompact [one] failed: denied PostCompact [two] completed successfully: {}',
    'Compacted PostCompact [helper] completed successfully: {}\nImportant extra output',
  ])('keeps non-empty, unknown or failed hook output expanded: %s', text => {
    const { container } = show(row([input, { ...output, text }]))
    expect(container.querySelector('details')!.open).toBe(true)
    expect(container.querySelector('pre')!.textContent).toBe(text)
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('renders long shell/math/HTML-like output literally, never as executable HTML or math', () => {
    const text = 'Compacted PostCompact [<script>bad()</script> $HOME ' + 'x'.repeat(12000)
      + '] completed successfully: {}'
    const { container } = show(row([input, { ...output, text }]))
    expect(container.querySelector('pre')!.textContent).toBe(text)
    expect(container.querySelector('script, .katex')).toBeNull()
  })

  it.each([
    { backend: 'codex' as const }, { run_id: 'other-run' }, { session_id: 'other-chat' },
    { seq: 0 }, { provider_message_id: null }, { type: 'reasoning_summary' },
    { text: 'Here is a quote: ' + hook }, { text: 'Compacted' },
  ])('does not special-case unproven or unrelated output: %j', patch => {
    expect(claudeCompactOutput({ ...output, ...patch }, input)).toBeNull()
  })

  it.each([undefined, { ...input, prompt: 'Explain /compact' }, { ...input, backend: 'codex' as const },
    { ...input, prompt: '/compact-other' }, { ...input, run_id: undefined }])('requires the exact owning compact input: %j', source => {
    expect(claudeCompactOutput(output, source)).toBeNull()
  })

  it('preserves ordinary assistant and user lookalikes', () => {
    const { container, unmount } = show(row([{ ...input, prompt: 'Explain this shell command' }, output]))
    expect(container.querySelector('.claude-compact-output')).toBeNull()
    unmount()
    const user = renderTimelineItems(projectTimeline([{ ...input, prompt: hook }], []))[0] as MessageItem
    expect(show(user).container.querySelector('.claude-compact-output')).toBeNull()
  })

  it('supports source-identified history and custom compact arguments', () => {
    expect(claudeCompactOutput({ ...output, provider_message_id: null, imported: true,
      provider_origin: { provider: 'claude', event_id: 'native-output', kind: 'assistant' } },
    { ...input, prompt: '/compact retain file names' })).toEqual({ text: hook, collapsed: true })
    expect(claudeCompactOutput({ ...output, is_error: true }, input)?.collapsed).toBe(false)
  })
})
