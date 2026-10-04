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
const activityView = (events: Event[], extra: Partial<ProgressItem> = {}) => {
  const item: ProgressItem = { kind: 'progress', id: 'progress', key: 'progress', seq: 1, events, active: true, startedAt: events[0].ts, ...extra }
  return <><ReasoningDisplaySettings /><TimelineRowView item={item} sessionId="chat-1" profileScope={null} onFindFile={() => {}} pinnedItemIds={new Set()} /></>
}
const renderActivity = (events: Event[]) => render(activityView(events))

beforeEach(() => {
  setReasoningDisplay('compact')
  setLocale('en')
  useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Codex', backend: 'codex' }], snapshots: {} })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { trace: vi.fn().mockResolvedValue({ events: [], has_more: false, next_after: null }) } } })
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

  it('keeps a new running command in the same compact row as earlier commands in its block', () => {
    const pending = command(4)[0]
    const events = [...command(1), reasoning(3), pending]
    const view = renderActivity(events)
    const activity = () => view.container.querySelector('.trace-activity')!
    expect(activity().children).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Ran printf marker_1' })).not.toBeInTheDocument()
    const group = screen.getByRole('button', { name: 'Running printf marker_4' })
    expect(group).toHaveClass('run-activity-support-toggle', 'is-active')
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(1)

    fireEvent.click(group)
    expect(screen.getByRole('button', { name: 'Ran printf marker_1' })).toBeInTheDocument()
    expect(view.container.querySelectorAll('.tool-event-toggle')).toHaveLength(2)
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(1)
    expect(window.agentsDock.timeline.trace).not.toHaveBeenCalled()

    fireEvent.click(group)
    const completed = [...events, command(4)[1]]
    view.rerender(activityView(completed))
    expect(activity().children).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Ran commands' })).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(0)
    view.rerender(activityView(completed, { active: false, finishedAt: completed.at(-1)!.ts, hasFinalResponse: true }))
    expect(screen.getByRole('button', { name: /Worked for/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Ran commands' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(screen.getByRole('button', { name: 'Ran commands' })).toBeInTheDocument()
  })

  it('retains distinct tool rows across commentary while the current single command pulses', () => {
    const commentary = event(5, 'reasoning_summary', { phase: 'commentary', text: 'The first checks passed; I will run the final check.' })
    const { container } = renderActivity([...command(1), ...command(3), commentary, command(6)[0]])
    expect([...container.querySelector('.trace-activity')!.children].map(element => element.textContent))
      .toEqual(['Ran commands', commentary.text, 'Running printf marker_6'])
    expect(screen.getByRole('button', { name: 'Running printf marker_6' })).toHaveClass('tool-event-toggle', 'is-active')
    expect(container.querySelectorAll('.is-active')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Ran commands' }))
    expect(screen.getByRole('button', { name: 'Ran printf marker_1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ran printf marker_3' })).toBeInTheDocument()
  })

  it('keeps visible reasoning between completed and running commands in its original position', () => {
    const { container } = renderActivity([...command(1), reasoning(3), command(4)[0]])
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect([...container.querySelector('.trace-activity')!.children].map(element => element.getAttribute('data-event-seq')))
      .toEqual(['1', '3', '4'])
    expect(screen.getByRole('button', { name: 'Ran printf marker_1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Running printf marker_4' })).toHaveClass('is-active')
    expect(container.querySelectorAll('.is-active')).toHaveLength(1)
  })

  it('retains lifecycle markers in an active group without adding a second running row', () => {
    const lifecycle = event(3, 'codex_compaction_completed', { compaction_id: 'compact-1', message: 'Context compaction completed.' })
    const { container } = render(activityView([...command(1), command(4)[0]], {
      lifecycle: [{ kind: 'system', id: 'compact-1', key: 'compact-1', seq: lifecycle.seq, event: lifecycle, anchorTs: lifecycle.ts }]
    }))
    expect(container.querySelector('.trace-activity')!.children).toHaveLength(1)
    const group = screen.getByRole('button', { name: 'Running printf marker_4' })
    expect(group).toHaveClass('is-active')
    fireEvent.click(group)
    expect(container.querySelectorAll('.run-activity-lifecycle')).toHaveLength(1)
    expect(container.querySelectorAll('.tool-event-toggle')).toHaveLength(2)
    expect(container.querySelectorAll('.is-active')).toHaveLength(1)
  })
})
