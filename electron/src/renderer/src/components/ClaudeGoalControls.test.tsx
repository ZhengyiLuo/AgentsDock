import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ClaudeRuntimeSnapshot, Session } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { ClaudeGoalControls } from './ClaudeGoalControls'

const session: Session = { id: 'claude-chat', backend: 'claude', title: 'Claude chat' }
const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
const empty: ClaudeRuntimeSnapshot = {
  available: true, transport: 'sdk', interactive_capability: 'claude_sdk_interactive_v1',
  session_loaded: true, pending_interactions: [], features: { goals: true }, goal: null
}
const active: ClaudeRuntimeSnapshot = {
  ...empty, status: { type: 'active', activeFlags: [] }, goal: {
    condition: 'The application builds.', status: 'active', set_at: Date.now() - 20_000,
    iterations: 2, last_reason: 'One build error remains.'
  }
}
const runtime = vi.fn()
const setGoal = vi.fn()
const clearGoal = vi.fn()
const listeners = new Map<string, (payload: unknown) => void>()

function surface(open = true) {
  return <ClaudeRuntimeProvider session={session} capability={capability}>
    <ClaudeGoalControls open={open} onOpenChange={vi.fn()} />
  </ClaudeRuntimeProvider>
}

describe('Claude native goals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    runtime.mockResolvedValue(empty)
    setGoal.mockResolvedValue(empty)
    clearGoal.mockResolvedValue(empty)
    setLocale('en')
    useAppStore.setState({ activeProfileId: 'a', profileGeneration: 1, switchingProfileId: null, connected: true })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      claude: { runtime, setGoal, clearGoal },
      events: { on: (name: string, callback: (payload: unknown) => void) => {
        listeners.set(name, callback)
        return () => { listeners.delete(name) }
      } }
    } as unknown as AgentsDockAPI })
  })
  afterEach(() => { cleanup(); setLocale('en') })

  it('waits for native goal state, refreshes on a matching event, and permits busy clear', async () => {
    render(surface())
    const user = userEvent.setup()
    const field = await screen.findByRole('textbox', { name: 'Completion condition' })
    await waitFor(() => expect(field).toBeEnabled())
    await user.type(field, 'The application builds.')
    setGoal.mockResolvedValue({ ...empty, goal_starting: true })
    runtime.mockResolvedValue({ ...empty, goal_starting: true })
    await user.click(screen.getByRole('button', { name: 'Start goal' }))
    expect(setGoal).toHaveBeenCalledWith(session.id, 'The application builds.')
    expect(await screen.findByText('Request sent to Claude. Waiting for goal status…')).toBeInTheDocument()
    expect(screen.queryByText('Active goal')).not.toBeInTheDocument()

    runtime.mockResolvedValue(active)
    act(() => listeners.get('server:event')?.({ profileId: 'another-server', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(screen.queryByText('Active goal')).not.toBeInTheDocument()
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(await screen.findByText('Active goal')).toBeInTheDocument()
    expect(screen.getByText('One build error remains.')).toBeInTheDocument()
    expect(screen.queryByText('Request sent to Claude. Waiting for goal status…')).not.toBeInTheDocument()

    const cleared = { ...active, status: { type: 'idle' as const }, goal: { ...active.goal!, status: 'cleared' as const, duration_ms: 22_000 } }
    runtime.mockResolvedValue(cleared)
    clearGoal.mockResolvedValue(cleared)
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Clear goal and stop current work' }))
    expect(clearGoal).toHaveBeenCalledWith(session.id)
    expect(await screen.findByText('Goal cleared')).toBeInTheDocument()
    expect(screen.getByText('00:22')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Start goal' })).toBeEnabled()
  })

  it.each([
    ['Start goal', { ...empty, status: active.status }],
    ['Replace goal', active]
  ] as const)('allows %s during current work and waits for native acknowledgement', async (label, initial) => {
    runtime.mockResolvedValue(initial)
    render(surface())
    const user = userEvent.setup()
    const field = screen.getByRole('textbox', { name: 'Completion condition' })
    await waitFor(() => expect(field).toBeEnabled())
    await waitFor(() => expect(field).toHaveValue(initial.goal?.condition ?? ''))
    await user.clear(field)
    await user.type(field, 'All requested checks pass.')
    const submit = screen.getByRole('button', { name: label })
    expect(submit).toBeEnabled()
    expect(screen.queryByText(/Wait for current work|Clear & stop before replacing/)).not.toBeInTheDocument()

    let acknowledge!: (value: ClaudeRuntimeSnapshot) => void
    setGoal.mockImplementationOnce(() => new Promise<ClaudeRuntimeSnapshot>(resolve => { acknowledge = resolve }))
    await user.click(submit)
    expect(setGoal).toHaveBeenCalledExactlyOnceWith(session.id, 'All requested checks pass.')
    expect(submit).toBeDisabled()
    expect(clearGoal).not.toHaveBeenCalled()
    expect(field).toHaveValue('All requested checks pass.')

    const next = { ...active, goal: { ...active.goal!, condition: 'All requested checks pass.' } }
    runtime.mockResolvedValue(next)
    await act(async () => acknowledge(next))
    expect(await screen.findByRole('button', { name: 'Replace goal' })).toBeEnabled()
    expect(within(screen.getByRole('dialog')).getByText('Active goal')).toBeInTheDocument()
    expect(clearGoal).not.toHaveBeenCalled()
  })

  it('keeps old servers usable without probing unsupported goal mutations', async () => {
    runtime.mockResolvedValue({ ...empty, features: {} })
    render(surface())
    expect(await screen.findByText(/Native Claude goals are unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeDisabled()
    expect(setGoal).not.toHaveBeenCalled()
    expect(clearGoal).not.toHaveBeenCalled()
  })

  it('surfaces a later native goal refusal even after closing the dialog and permits retry', async () => {
    const pending = { ...empty, status: active.status, goal_starting: true }
    runtime.mockResolvedValue(pending)
    const view = render(surface(false))
    expect(await screen.findByRole('status')).toHaveTextContent('Request sent to Claude')

    const rejected = { ...empty, status: active.status, goal_starting: false,
      goal_error: 'Claude could not set this goal. Try again.' }
    runtime.mockResolvedValue(rejected)
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent(rejected.goal_error)
    expect(screen.queryByText('Request sent to Claude. Waiting for goal status…')).not.toBeInTheDocument()

    view.rerender(surface())
    const field = screen.getByRole('textbox', { name: 'Completion condition' })
    fireEvent.change(field, { target: { value: 'The checks pass.' } })
    runtime.mockResolvedValue({ ...active, goal_error: null })
    setGoal.mockResolvedValue({ ...active, goal_error: null })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start goal' }))
    expect(setGoal).toHaveBeenCalledExactlyOnceWith(session.id, 'The checks pass.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retains retryable errors and does not apply a late goal to another server', async () => {
    runtime.mockResolvedValue({ ...empty, status: active.status })
    render(surface())
    const field = screen.getByRole('textbox', { name: 'Completion condition' })
    await waitFor(() => expect(field).toBeEnabled())
    fireEvent.change(field, { target: { value: 'Build succeeds.' } })
    setGoal.mockRejectedValueOnce(new Error('Claude is unavailable.'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start goal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude is unavailable.')
    expect(field).toHaveValue('Build succeeds.')

    let resolve!: (value: ClaudeRuntimeSnapshot) => void
    setGoal.mockImplementationOnce(() => new Promise<ClaudeRuntimeSnapshot>(done => { resolve = done }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start goal' }))
    act(() => useAppStore.setState({ activeProfileId: 'b', profileGeneration: 2 }))
    await act(async () => resolve(active))
    expect(screen.queryByText('Active goal')).not.toBeInTheDocument()
    expect(screen.queryByText('One build error remains.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows achieved native history and localized controls without a running goal bar', async () => {
    setLocale('zh-CN')
    runtime.mockResolvedValue({ ...active, status: { type: 'idle' }, goal: { ...active.goal!, status: 'achieved', duration_ms: 45_000 } })
    render(surface())
    expect(await screen.findByText('目标已达成')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '开始目标' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /清除/ })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '完成条件' })).toHaveAttribute('maxlength', '4000')
  })
})
