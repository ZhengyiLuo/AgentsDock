import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SideChatExchange } from '../lib/side-chat'
import { setReasoningDisplay } from '../lib/reasoning-display'
import { SideChatResponse } from './SideChatResponse'

const pending: SideChatExchange = { id: 'r', question: 'Question', state: 'pending', activity: [
  { id: 'r:reasoning_summary', kind: 'reasoning_summary', text: '**Checking files**\n\nProvider summary body.', status: 'running' }
] }
afterEach(() => { cleanup(); setReasoningDisplay('compact') })

describe('Side chat native progress', () => {
  it('keeps one compact pulsing activity line and shares the live reasoning preference', () => {
    const view = render(<SideChatResponse exchange={pending} />)
    expect(screen.getByRole('button', { name: 'Activity details' })).toHaveTextContent('Checking files')
    expect(screen.getByRole('button', { name: 'Activity details' })).toHaveClass('is-active')
    expect(screen.queryByText('Provider summary body.')).toBeNull()
    act(() => setReasoningDisplay('expanded'))
    expect(screen.getByText('Provider summary body.')).toBeVisible()
    view.rerender(<SideChatResponse exchange={{ ...pending, state: 'answered', answer: 'Final answer' }} />)
    expect(screen.queryByText('Provider summary body.')).toBeNull()
    expect(screen.getByText('Final answer')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Activity details' })).not.toHaveClass('is-active')
    fireEvent.click(screen.getByRole('button', { name: 'Activity details' }))
    expect(screen.getByText('Provider summary body.')).toBeVisible()
  })

  it('streams commentary and answer in chronological order without duplicate final text', () => {
    const exchange: SideChatExchange = { ...pending, state: 'answered', answer: 'Final answer', activity: [
      pending.activity![0],
      { id: 'c', kind: 'commentary', text: 'Checking now', status: 'completed' },
      { id: 't', kind: 'tool', text: 'pwd\necho next', status: 'completed' },
      { id: 'a', kind: 'answer', text: 'Final answer', status: 'completed' }
    ] }
    const { container } = render(<SideChatResponse exchange={exchange} />)
    expect(screen.getAllByText('Final answer')).toHaveLength(1)
    expect(container.textContent!.indexOf('Checking now')).toBeLessThan(container.textContent!.indexOf('Final answer'))
    expect(screen.queryByText('pwd')).toBeNull()
    for (const button of screen.getAllByRole('button', { name: 'Activity details' })) fireEvent.click(button)
    expect(screen.getByText('pwd echo next')).toBeVisible()
  })

  it('uses the authoritative final answer when a streamed item remained partial', () => {
    render(<SideChatResponse exchange={{ ...pending, state: 'answered', answer: 'The complete answer', activity: [
      { id: 'a', kind: 'answer', text: 'Partial answer', status: 'running' }
    ] }} />)
    expect(screen.getByText('The complete answer')).toBeVisible()
    expect(screen.queryByText('Partial answer')).toBeNull()
  })

  it('retains partial reasoning on cancellation without implying activity is still running', () => {
    setReasoningDisplay('expanded')
    const view = render(<SideChatResponse exchange={pending} />)
    view.rerender(<SideChatResponse exchange={{ ...pending, state: 'cancelled' }} />)
    expect(screen.queryByText('Provider summary body.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Activity details' }))
    expect(screen.getByText('Provider summary body.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Activity details' })).not.toHaveClass('is-active')
  })
})
