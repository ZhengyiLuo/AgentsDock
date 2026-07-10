import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'
import { TERMINAL_DOCK_ANIMATION_MS, TerminalDock } from './TerminalDock'

vi.mock('./TerminalWorkspace', () => ({
  TerminalWorkspace: () => <div data-testid="terminal-workspace" />
}))

const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }

describe('TerminalDock', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

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
})
