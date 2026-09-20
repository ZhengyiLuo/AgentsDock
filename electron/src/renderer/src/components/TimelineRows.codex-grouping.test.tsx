import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { setLocale } from '@shared/i18n'
import type { ProgressItem } from '../lib/timeline'
import { setReasoningDisplay } from '../lib/reasoning-display'
import { useAppStore } from '../store/app-store'
import { ReasoningDisplaySettings } from './ReasoningDisplaySettings'
import { TimelineRowView } from './TimelineRows'

const event = (seq: number, type: string, extra: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', run_id: 'run-1', backend: 'codex', seq,
  type, ts: `2026-09-20T10:00:${String(seq).padStart(2, '0')}Z`, ...extra
})
const command = (seq: number): Event[] => [
  event(seq, 'tool_started', { tool_id: `tool-${seq}`, tool: { name: 'exec_command', input: { cmd: `printf marker_${seq}` } } }),
  event(seq + 1, 'tool_finished', { tool_id: `tool-${seq}`, tool: { name: 'exec_command' }, output: `marker_${seq}`, exit_code: 0 })
]
const reasoning = (seq: number) => event(seq, 'reasoning_summary', { item_id: `reasoning-${seq}`, phase: 'summary', text: `Checking step ${seq}` })
const renderActivity = (events: Event[]) => {
  const item: ProgressItem = { kind: 'progress', id: 'progress', key: 'progress', seq: 1, events, active: true, startedAt: events[0].ts }
  return render(<><ReasoningDisplaySettings /><TimelineRowView item={item} sessionId="chat-1" profileScope={null} onFindFile={() => {}} pinnedItemIds={new Set()} /></>)
}

beforeEach(() => {
  setReasoningDisplay('compact')
  setLocale('en')
  useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Codex', backend: 'codex' }], snapshots: {} })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { trace: vi.fn() } } })
})
afterEach(cleanup)
afterEach(() => setReasoningDisplay('compact'))

describe('compact Codex command grouping', () => {
  it('groups commands across hidden reasoning, retaining every command and restoring visible chronology', () => {
    const { container } = renderActivity([
      ...command(1), ...command(3), reasoning(5),
      ...command(6), ...command(8), reasoning(10),
      ...command(11), ...command(13)
    ])
    expect(screen.getAllByRole('button', { name: 'Ran commands' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Ran commands' }))
    for (const seq of [1, 3, 6, 8, 11, 13]) expect(screen.getByRole('button', { name: `Ran printf marker_${seq}` })).toBeInTheDocument()
    expect(window.agentsDock.timeline.trace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(screen.getAllByRole('button', { name: 'Ran commands' })).toHaveLength(3)
    expect([...container.querySelector('.trace-activity')!.children].map(element => element.classList.contains('reasoning') ? element.getAttribute('data-event-seq') : 'tools'))
      .toEqual(['tools', '5', 'tools', '10', 'tools'])
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(screen.getAllByRole('button', { name: 'Ran commands' })).toHaveLength(1)
    expect(window.agentsDock.timeline.trace).not.toHaveBeenCalled()
  })

  it('keeps command groups on their respective sides of visible commentary', () => {
    const commentary = event(6, 'reasoning_summary', { phase: 'commentary', text: 'I found the first result and will check the second.' })
    const { container } = renderActivity([
      ...command(1), reasoning(3), ...command(4), commentary,
      ...command(7), reasoning(9), ...command(10)
    ])
    expect(screen.getAllByRole('button', { name: 'Ran commands' })).toHaveLength(2)
    expect([...container.querySelector('.trace-activity')!.children].map(element => element.classList.contains('commentary') ? element.textContent : 'tools'))
      .toEqual(['tools', commentary.text, 'tools'])
  })
})
