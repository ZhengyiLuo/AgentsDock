import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'
import { DEFAULT_TERMINAL_DOCK_HEIGHT, TERMINAL_DOCK_ANIMATION_MS, TerminalDock } from './TerminalDock'

vi.mock('./TerminalWorkspace', () => ({
  TerminalWorkspace: () => <div data-testid="terminal-workspace" />
}))

const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }

describe('TerminalDock', () => {
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers() })

  it('reveals from a mounted shell and detaches only after the close animation', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<TerminalDock session={session} open={false} onRequestClose={() => {}} />)
    expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument()

    rerender(<TerminalDock session={session} open onRequestClose={() => {}} />)
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(40))
    expect(container.querySelector('.terminal-dock-shell')).toHaveClass('open')

    rerender(<TerminalDock session={session} open={false} onRequestClose={() => {}} />)
    expect(container.querySelector('.terminal-dock-shell')).not.toHaveClass('open')
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(TERMINAL_DOCK_ANIMATION_MS))
    expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument()
  })

  it('starts compact and persists keyboard resizing', () => {
    vi.useFakeTimers()
    const { container } = render(<TerminalDock session={session} open onRequestClose={() => {}} />)
    act(() => vi.advanceTimersByTime(40))
    const shell = container.querySelector<HTMLElement>('.terminal-dock-shell')
    const handle = screen.getByRole('separator', { name: 'Resize terminal panel' })

    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT}px`)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 20}px`)
    expect(localStorage.getItem('agentsdock:terminal-dock-height')).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 20))
  })

  it('tracks pointer resizing outside the narrow drag handle', () => {
    vi.useFakeTimers()
    const { container } = render(<TerminalDock session={session} open onRequestClose={() => {}} />)
    act(() => vi.advanceTimersByTime(40))
    const shell = container.querySelector<HTMLElement>('.terminal-dock-shell')
    const handle = screen.getByRole('separator', { name: 'Resize terminal panel' })

    fireEvent.pointerDown(handle, { pointerId: 7, clientY: 500 })
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 420 })

    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 80}px`)

    fireEvent.pointerUp(window, { pointerId: 7, clientY: 420 })
    expect(localStorage.getItem('agentsdock:terminal-dock-height')).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 80))
    expect(document.body).not.toHaveClass('terminal-resizing')
  })
})
