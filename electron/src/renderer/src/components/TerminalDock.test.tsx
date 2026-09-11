import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'
import { DEFAULT_TERMINAL_DOCK_HEIGHT, TERMINAL_DOCK_ANIMATION_MS, TerminalDock, terminalDockStorageKey } from './TerminalDock'

const terminalWorkspaceHarness = vi.hoisted(() => ({ renders: 0 }))

vi.mock('./TerminalWorkspace', () => ({
  TerminalWorkspace: ({ layoutHeight }: { layoutHeight: number }) => {
    terminalWorkspaceHarness.renders += 1
    return <div data-testid="terminal-workspace" data-layout-height={layoutHeight} />
  }
}))

const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
const workspaceKey = 'server:alpha'

describe('TerminalDock', () => {
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); terminalWorkspaceHarness.renders = 0 })

  it('does not rerender xterm ownership during unrelated parent churn', () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const { rerender } = render(<TerminalDock workspaceKey={workspaceKey} session={session} open onRequestClose={close} />)
    act(() => vi.advanceTimersByTime(40))
    const renders = terminalWorkspaceHarness.renders

    // App-level status, notification, and Team Network state can rerender the
    // parent shell. Stable terminal inputs must not fan that work into xterm.
    rerender(<TerminalDock workspaceKey={workspaceKey} session={session} open onRequestClose={close} />)

    expect(terminalWorkspaceHarness.renders).toBe(renders)
  })

  it('reveals from a mounted shell and detaches only after the close animation', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<TerminalDock workspaceKey={workspaceKey} session={session} open={false} onRequestClose={() => {}} />)
    expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument()

    rerender(<TerminalDock workspaceKey={workspaceKey} session={session} open onRequestClose={() => {}} />)
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(40))
    expect(container.querySelector('.terminal-dock-shell')).toHaveClass('open')

    rerender(<TerminalDock workspaceKey={workspaceKey} session={session} open={false} onRequestClose={() => {}} />)
    expect(container.querySelector('.terminal-dock-shell')).not.toHaveClass('open')
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(TERMINAL_DOCK_ANIMATION_MS))
    expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument()
  })

  it('starts compact and persists keyboard resizing', () => {
    vi.useFakeTimers()
    const { container } = render(<TerminalDock workspaceKey={workspaceKey} session={session} open onRequestClose={() => {}} />)
    act(() => vi.advanceTimersByTime(40))
    const shell = container.querySelector<HTMLElement>('.terminal-dock-shell')
    const handle = screen.getByRole('separator', { name: 'Resize terminal panel' })

    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT}px`)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 20}px`)
    expect(localStorage.getItem(terminalDockStorageKey(workspaceKey))).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 20))
  })

  it('tracks pointer resizing outside the narrow drag handle', () => {
    vi.useFakeTimers()
    const { container } = render(<TerminalDock workspaceKey={workspaceKey} session={session} open onRequestClose={() => {}} />)
    act(() => vi.advanceTimersByTime(40))
    const shell = container.querySelector<HTMLElement>('.terminal-dock-shell')
    const handle = screen.getByRole('separator', { name: 'Resize terminal panel' })

    fireEvent.pointerDown(handle, { pointerId: 7, clientY: 500 })
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 420 })

    expect(shell?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 80}px`)
    expect(screen.getByTestId('terminal-workspace')).toHaveAttribute('data-layout-height', String(DEFAULT_TERMINAL_DOCK_HEIGHT + 80))

    fireEvent.pointerUp(window, { pointerId: 7, clientY: 420 })
    expect(localStorage.getItem(terminalDockStorageKey(workspaceKey))).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 80))
    expect(document.body).not.toHaveClass('terminal-resizing')
  })

  it('restores independent terminal heights across A to B to A', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<TerminalDock workspaceKey="server:alpha" session={session} open onRequestClose={() => {}} />)
    act(() => vi.advanceTimersByTime(40))
    let handle = screen.getByRole('separator', { name: 'Resize terminal panel' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })

    rerender(<TerminalDock workspaceKey="server:beta" session={session} open onRequestClose={() => {}} />)
    handle = screen.getByRole('separator', { name: 'Resize terminal panel' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })

    expect(container.querySelector<HTMLElement>('.terminal-dock-shell')?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 40}px`)
    expect(localStorage.getItem(terminalDockStorageKey('server:alpha'))).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 20))
    expect(localStorage.getItem(terminalDockStorageKey('server:beta'))).toBe(String(DEFAULT_TERMINAL_DOCK_HEIGHT + 40))

    rerender(<TerminalDock workspaceKey="server:alpha" session={session} open onRequestClose={() => {}} />)
    expect(container.querySelector<HTMLElement>('.terminal-dock-shell')?.style.getPropertyValue('--terminal-dock-height')).toBe(`${DEFAULT_TERMINAL_DOCK_HEIGHT + 20}px`)
  })
})
