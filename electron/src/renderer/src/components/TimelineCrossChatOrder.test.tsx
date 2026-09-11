import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { projectTimeline, renderTimelineItems } from '../lib/timeline'
import { TimelineRowView } from './TimelineRows'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `detail-event-${seq}`, session_id: 'local', run_id: 'active-run', seq, type,
  ts: `2026-09-11T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})
const commentary = (seq: number, text: string): Event =>
  event(seq, 'reasoning_summary', { phase: 'commentary', text })

describe('cross-chat activity detail boundaries', () => {
  const trace = vi.fn()
  beforeEach(() => {
    setLocale('en')
    trace.mockReset()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { trace } } })
  })
  afterEach(cleanup)

  it.each([true, false])('keeps a straddling tool and its fetched result before the message (compact tool: %s)', async sampledTool => {
    const before = commentary(2, 'Progress before the message.')
    const toolStart = event(3, 'tool_started', { tool: { id: 'crossing-read', name: 'Read', input: { file_path: 'example.txt' } } })
    const moreBefore = commentary(4, 'Earlier detail loaded on demand.')
    const send = event(5, 'chat_conversation_message_registered', {
      run_id: undefined, conversation_mode: 'async_route_v1', conversation_id: 'local-peer-pair',
      message_id: 'sent-message', handoff_id: 'sent-message', cross_chat_envelope_id: 'sent-message',
      source_session_id: 'local', target_session_id: 'peer', handoff_status: 'registered', handoff_preview: 'A separate message.'
    })
    const moreAfter = commentary(6, 'Later detail loaded on demand.')
    const toolFinish = event(7, 'tool_finished', { tool_id: 'crossing-read', output: 'The complete tool result.' })
    const after = commentary(8, 'The sender continues working.')
    const compact = [event(1, 'turn_started', { prompt: 'Keep working.' }), before,
      ...(sampledTool ? [toolStart] : []), send, ...(sampledTool ? [toolFinish] : []), after]
    // The first full page crosses the message boundary; the tool result is
    // on a later page. Both chunk disclosures must discover its real start.
    trace.mockImplementation(async (_session: string, _run: string, _anchor: number, cursor: number) => cursor === 0
      ? { events: [before, toolStart, moreBefore, moreAfter], has_more: true, next_after: 6 }
      : { events: [toolFinish, after], has_more: false, next_after: 8 })
    const chunks = renderTimelineItems(projectTimeline(compact, [])).filter(row => row.kind === 'progress')
    expect(chunks).toHaveLength(2)
    const { container } = render(<>{chunks.map((item, index) => <section key={item.key} data-testid={`chunk-${index}`}>
      <TimelineRowView item={item} sessionId="local" profileScope={null} onFindFile={() => {}} pinnedItemIds={new Set()} />
    </section>)}</>)
    const earlier = within(container).getByTestId('chunk-0')
    const later = within(container).getByTestId('chunk-1')
    expect(trace).not.toHaveBeenCalled()
    expect(within(earlier).getByRole('button', { name: 'Progress' })).toBeInTheDocument()
    expect(within(later).getByText(/Working for/)).toBeInTheDocument()
    fireEvent.click(within(earlier).getByRole('button', { name: 'Progress' }))

    for (const chunk of [earlier, later]) {
      fireEvent.click(within(chunk).getByRole('button', { name: 'Load available activity' }))
      fireEvent.click(await within(chunk).findByRole('button', { name: 'Load more activity' }))
      await waitFor(() => expect(within(chunk).queryByRole('button', { name: 'Load more activity' })).not.toBeInTheDocument())
      expect(within(chunk).getByRole('button', { name: 'Use compact trace' })).toBeInTheDocument()
    }
    expect(trace.mock.calls.map(call => call[3])).toEqual([0, 6, 0, 6])
    fireEvent.click(within(earlier).getByRole('button', { name: '1 tool call' }))
    fireEvent.click(within(earlier).getByRole('button', { name: /^Read\s*Success$/ }))
    expect(within(earlier).getByText('The complete tool result.')).toBeInTheDocument()
    expect(within(earlier).queryByText('Later detail loaded on demand.')).not.toBeInTheDocument()
    expect(within(earlier).queryByText('The sender continues working.')).not.toBeInTheDocument()
    expect(within(later).queryByText('Earlier detail loaded on demand.')).not.toBeInTheDocument()
    expect(within(later).queryByRole('button', { name: /tool call/ })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.tool-event')).toHaveLength(1)
    for (const text of ['Progress before the message.', 'Earlier detail loaded on demand.', 'Later detail loaded on demand.', 'The sender continues working.']) {
      expect(within(container).getAllByText(text)).toHaveLength(1)
    }
  })
})
