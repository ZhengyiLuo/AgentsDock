import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { setLocale } from '@shared/i18n'
import type { ProgressItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'
import { ReasoningDisplaySettings } from './ReasoningDisplaySettings'
import { readReasoningDisplay, setReasoningDisplay } from '../lib/reasoning-display'

const event = (seq: number, type: string, extra: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', run_id: 'run-1', backend: 'codex', seq,
  type, ts: `2026-09-20T10:00:${String(seq).padStart(2, '0')}Z`, ...extra
})
const early = event(1, 'reasoning_summary', { item_id: 'early', text: '**Inspecting the workspace**\n\nThe complete earlier explanation.' })
const commentary = event(2, 'reasoning_summary', { phase: 'commentary', text: 'I will check the local marker.' })
const latest = event(3, 'reasoning_summary', { item_id: 'latest', text: '# Planning the next check\n\nThe full current explanation.' })
const start = event(4, 'tool_started', { tool_id: 'tool-1', tool: { name: 'exec_command', input: { cmd: 'printf TRACE_QA_TOOL' } } })
const finish = event(5, 'tool_finished', { tool_id: 'tool-1', tool: { name: 'exec_command' }, output: 'TRACE_QA_TOOL', exit_code: 0 })
const item = (events: Event[], extra: Partial<ProgressItem> = {}): ProgressItem => ({
  kind: 'progress', id: 'progress', key: 'progress', seq: 1, events, active: true,
  startedAt: early.ts, ...extra
})
const row = (value: ProgressItem) => <TimelineRowView item={value} sessionId="chat-1" profileScope={null} onFindFile={() => {}} pinnedItemIds={new Set()} />

beforeEach(() => {
  setReasoningDisplay('compact')
  setLocale('en')
  useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Codex', backend: 'codex' }], snapshots: {} })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { trace: vi.fn().mockResolvedValue({ events: [], has_more: false, next_after: null }) } } })
})
afterEach(cleanup)
afterEach(() => setReasoningDisplay('compact'))

describe('native Codex activity presentation', () => {
  it('shows one current line after commentary and keeps earlier full text in chronological history', () => {
    const { container } = render(row(item([early, commentary, latest])))
    expect(container.querySelectorAll('.is-active')).toHaveLength(1)
    expect(container.querySelector('.is-active')).toHaveTextContent('Planning the next check')
    expect(container.querySelectorAll('.trace-reasoning-body')).toHaveLength(0)
    expect(screen.queryByText('Thinking summary')).not.toBeInTheDocument()
    expect(screen.queryByText('Inspecting the workspace')).not.toBeInTheDocument()
    expect(container.querySelector('.trace-activity')?.lastElementChild).toHaveTextContent('Planning the next check')
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText('The complete earlier explanation.')).toBeInTheDocument()
    expect(container.querySelector('.trace-activity')?.firstElementChild).toHaveAttribute('data-event-seq', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Planning the next check' }))
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
    expect(container.querySelector('.trace-commentary')).toHaveTextContent(commentary.text!)
  })

  it('replaces the summary status with the actual latest command and stops pulsing on completion', () => {
    const view = render(row(item([early, commentary, latest])))
    view.rerender(row(item([early, commentary, latest, start])))
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(1)
    expect(view.container.querySelector('.is-active')).toHaveTextContent('Running printf TRACE_QA_TOOL')
    expect(screen.queryByRole('button', { name: 'Planning the next check' })).not.toBeInTheDocument()
    expect(view.container.querySelector('.trace-activity')?.lastElementChild).toHaveTextContent('Running printf TRACE_QA_TOOL')
    view.rerender(row(item([early, commentary, latest, start, finish], { active: false, finishedAt: finish.ts, hasFinalResponse: true })))
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(0)
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Ran printf TRACE_QA_TOOL' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(screen.getByRole('button', { name: 'Ran printf TRACE_QA_TOOL' })).toBeInTheDocument()
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
  })

  it('retains partial text after stop and on an explicit historical expansion without a pulse', () => {
    const partial = { ...latest, partial: true }
    const view = render(row(item([early, commentary, partial])))
    view.rerender(row(item([early, commentary, partial], { active: false, stoppedAt: partial.ts, hasFinalResponse: false })))
    expect(screen.queryByText('Partial thinking summary')).not.toBeInTheDocument()
    expect(screen.getByText(commentary.text!)).toBeInTheDocument()
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /You stopped after/ }))
    expect(screen.queryByRole('button', { name: 'Planning the next check' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText('Partial thinking summary')).toBeInTheDocument()
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
    view.unmount()
    const historical = render(row(item([early, commentary, partial], { active: false, stoppedAt: partial.ts, hasFinalResponse: false })))
    fireEvent.click(screen.getByRole('button', { name: /You stopped after/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText('Partial thinking summary')).toBeInTheDocument()
    expect(historical.container.querySelectorAll('.is-active')).toHaveLength(0)
  })

  it('retains the native provider boundary instead of applying Codex presentation to Claude', () => {
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Claude', backend: 'claude' }] })
    const { container } = render(row(item([{ ...latest, backend: 'claude' }])))
    expect(container.querySelector('.codex-native-activity')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Thinking summary' })).toBeInTheDocument()
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
  })

  it('persists optional full reasoning, keeps both native channels, and restores the compact default on request', () => {
    const raw = event(4, 'reasoning_text', { phase: 'reasoning', partial: true, item_id: latest.item_id,
      text: `Provider plaintext. ${'Long received text. '.repeat(450)}END_OF_RECEIVED_REASONING` })
    const view = render(<><ReasoningDisplaySettings />{row(item([early, commentary, { ...latest, phase: 'summary' }, raw]))}</>)
    expect(screen.queryByText(/END_OF_RECEIVED_REASONING/)).not.toBeInTheDocument()
    expect(view.container.querySelector('.is-active')).toHaveTextContent('Planning the next check')
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.queryByText(/END_OF_RECEIVED_REASONING/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(readReasoningDisplay()).toBe('expanded')
    expect(window.localStorage.getItem('agentsdock.reasoningDisplay')).toBe('expanded')
    expect(screen.getByText(/END_OF_RECEIVED_REASONING/)).toBeInTheDocument()
    expect(screen.getByText('Provider-supplied reasoning')).toBeInTheDocument()
    expect(screen.getByText('Partial provider-supplied reasoning')).toBeInTheDocument()
    expect(screen.getAllByText('Reasoning summary')).toHaveLength(2)
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
    expect(screen.getByText('The complete earlier explanation.')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.markdown-fold-toggle')).toHaveLength(0)
    view.unmount()
    render(<><ReasoningDisplaySettings />{row(item([latest, raw]))}</>)
    expect(screen.getByRole('switch', { name: 'Show reasoning traces' })).toBeChecked()
    expect(screen.getByText(/END_OF_RECEIVED_REASONING/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(screen.queryByText(/END_OF_RECEIVED_REASONING/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Planning the next check' })).toBeInTheDocument()
  })

  it.each([
    ['compact', 'completed'], ['expanded', 'completed'],
    ['compact', 'stopped'], ['expanded', 'stopped']
  ] as const)('collapses %s live traces when the turn is %s and preserves manual history access', (display, terminal) => {
    setReasoningDisplay(display)
    const raw = event(6, 'reasoning_text', { phase: 'reasoning', partial: terminal === 'stopped', item_id: latest.item_id,
      text: 'Provider plaintext retained for manual history.' })
    const events = [early, commentary, latest, start, finish, raw]
    const view = render(row(item(events)))
    if (display === 'expanded') {
      expect(screen.getByText(raw.text!, { selector: '.trace-reasoning-body p' })).toBeInTheDocument()
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
      expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
      expect(screen.queryByText(raw.text!)).not.toBeInTheDocument()
    }
    const completed = item(events, {
      active: false,
      ...(terminal === 'completed' ? { finishedAt: raw.ts, hasFinalResponse: true } : { stoppedAt: raw.ts, hasFinalResponse: false })
    })
    view.rerender(row(completed))
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(0)
    expect(screen.queryByText(raw.text!)).not.toBeInTheDocument()
    expect(screen.queryByText('The full current explanation.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: terminal === 'completed' ? /Worked for/ : /You stopped after/ }))
    expect(screen.queryByText(raw.text!)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Planning the next check' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Earlier activity' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText(raw.text!, { selector: '.trace-reasoning-body p' })).toBeInTheDocument()
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
    expect(screen.getByText('The complete earlier explanation.')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.is-active')).toHaveLength(0)
  })

  it.each(['compact', 'expanded'] as const)('does not reopen or alter completed history when changing the %s preference', display => {
    setReasoningDisplay(display)
    const raw = event(6, 'reasoning_text', { phase: 'reasoning', item_id: latest.item_id, text: 'Historical provider plaintext.' })
    const completed = item([early, commentary, latest, start, finish, raw], { active: false, finishedAt: raw.ts, hasFinalResponse: true })
    const view = render(<><ReasoningDisplaySettings />{row(completed)}</>)
    const history = () => view.container.querySelector('.trace')!
    const collapsedText = history().textContent
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(history().textContent).toBe(collapsedText)
    expect(view.container.querySelector('.run-activity-summary')).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Earlier activity' }))
    expect(screen.getByText(raw.text!, { selector: '.trace-reasoning-body p' })).toBeInTheDocument()
    const manualText = history().textContent
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning traces' }))
    expect(history().textContent).toBe(manualText)
    expect(screen.getByRole('button', { name: 'Earlier activity' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(raw.text!, { selector: '.trace-reasoning-body p' })).toBeInTheDocument()
  })

  it('keeps the reasoning preference from opening a legacy historical trace', () => {
    setReasoningDisplay('expanded')
    const raw = event(4, 'reasoning_text', { phase: 'reasoning', item_id: latest.item_id, text: 'Legacy provider plaintext.' })
    const view = render(<TimelineRowView item={{ kind: 'trace', id: 'legacy-trace', key: 'legacy-trace', seq: 1, events: [latest, raw], promotedCommentaryIds: [], active: false }}
      sessionId="chat-1" profileScope={null} onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(view.container.querySelector('.trace-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(raw.text!)).not.toBeInTheDocument()
    fireEvent.click(view.container.querySelector('.trace-summary')!)
    expect(screen.getByText(raw.text!, { selector: '.trace-reasoning-body p' })).toBeInTheDocument()
    expect(screen.getByText('The full current explanation.')).toBeInTheDocument()
  })
})
