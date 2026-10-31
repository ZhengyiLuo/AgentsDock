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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocale('en') })

  it('shows a saved goal as idle without counting time since it was set', async () => {
    runtime.mockResolvedValue({ ...active, status: { type: 'idle' },
      goal: { ...active.goal!, set_at: Date.now() - 14 * 60 * 60 * 1000 } })
    const view = render(surface(false))
    const bar = await screen.findByRole('region', { name: 'Claude goal' })
    expect(bar).toHaveTextContent('Goal set · Claude idle')
    expect(bar).not.toHaveTextContent(/\d+:\d\d/)
    expect(within(bar).getByRole('button', { name: 'Clear goal' })).toBeEnabled()
    expect(setGoal).not.toHaveBeenCalled()

    view.rerender(surface())
    const progress = screen.getByRole('region', { name: 'Goal progress' })
    expect(progress).toHaveTextContent('Goal set · Claude idle')
    expect(within(progress).getByText('Duration reported by Claude').nextElementSibling).toHaveTextContent('—')
  })

  it.each([
    [{ type: 'active', activeFlags: [] }, 'Claude working'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'Waiting for approval'],
    [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'Waiting for input'],
    [{ type: 'systemError' }, 'Claude status unavailable'],
    [undefined, 'Claude status unavailable']
  ] as const)('keeps native goal state separate from runtime %j', async (status, label) => {
    runtime.mockResolvedValue({ ...active, status })
    render(surface(false))
    const bar = await screen.findByRole('region', { name: 'Claude goal' })
    expect(bar).toHaveTextContent(`Goal set · ${label}`)
    expect(bar).not.toHaveTextContent(/\d+:\d\d/)
    expect(screen.queryByRole('button', { name: 'Continue goal' })).not.toBeInTheDocument()
    expect(setGoal).not.toHaveBeenCalled()
  })

  it('updates working to idle on a runtime event and retains only native reported duration', async () => {
    const reported = { ...active, goal: { ...active.goal!, duration_ms: 45_000 } }
    runtime.mockResolvedValue(reported)
    render(surface(false))
    const bar = await screen.findByRole('region', { name: 'Claude goal' })
    expect(bar).toHaveTextContent('Goal set · Claude working')
    expect(bar).toHaveTextContent('Claude reports 00:45')

    runtime.mockResolvedValue({ ...reported, status: { type: 'idle' } })
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'turn_finished' } }))
    await waitFor(() => expect(bar).toHaveTextContent('Goal set · Claude idle'))
    expect(bar).toHaveTextContent('Claude reports 00:45')
    expect(within(bar).getByRole('button', { name: 'Clear goal' })).toBeEnabled()
  })

  it.each(['idle', 'notLoaded'] as const)('continues a goal from %s only on a click, using its exact native condition and current chat', async type => {
    runtime.mockResolvedValue({ ...active, status: { type } })
    render(surface(false))
    const button = await screen.findByRole('button', { name: 'Continue goal' })
    expect(screen.getByRole('region', { name: 'Claude goal' })).toHaveTextContent(type === 'idle' ? 'Claude idle' : 'Claude not running')
    expect(setGoal).not.toHaveBeenCalled()
    let confirm!: (value: ClaudeRuntimeSnapshot) => void
    setGoal.mockImplementationOnce(() => new Promise<ClaudeRuntimeSnapshot>(resolve => { confirm = resolve }))
    await userEvent.setup().click(button)
    expect(setGoal).toHaveBeenCalledExactlyOnceWith(session.id, active.goal!.condition)
    expect(button).toBeDisabled()
    expect(clearGoal).not.toHaveBeenCalled()
    runtime.mockResolvedValue(active)
    await act(async () => confirm(active))
    expect(screen.getByRole('region', { name: 'Claude goal' })).toHaveTextContent('Goal set · Claude working')
    expect(screen.queryByRole('button', { name: 'Continue goal' })).not.toBeInTheDocument()
  })

  it('does not continue while an earlier goal request is still pending', async () => {
    runtime.mockResolvedValue({ ...active, status: { type: 'idle' }, goal_starting: true })
    render(surface(false))
    const button = await screen.findByRole('button', { name: 'Continue goal' })
    expect(button).toBeDisabled()
    await userEvent.setup().click(button)
    expect(setGoal).not.toHaveBeenCalled()
  })

  it('keeps a pending replacement distinct from the current native goal and later receipt', async () => {
    runtime.mockResolvedValue(active)
    const view = render(surface())
    const user = userEvent.setup()
    const field = screen.getByRole('textbox', { name: 'Completion condition' })
    await waitFor(() => expect(field).toHaveValue(active.goal!.condition))
    await user.clear(field)
    await user.type(field, 'The release checks pass.')
    const pending = { ...active, goal_starting: true }
    setGoal.mockResolvedValue(pending)
    runtime.mockResolvedValue(pending)
    await user.click(screen.getByRole('button', { name: 'Replace goal' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Goal request sent. Waiting for Claude to confirm…')
    const progress = screen.getByRole('region', { name: 'Goal progress' })
    expect(progress).toHaveTextContent(active.goal!.condition)
    expect(progress).not.toHaveTextContent('The release checks pass.')
    expect(within(screen.getByRole('dialog')).getByText('Goal set · Claude working')).toBeInTheDocument()

    view.rerender(surface(false))
    const bar = screen.getByRole('region', { name: 'Claude goal' })
    expect(bar).toHaveTextContent(active.goal!.condition)
    expect(bar).not.toHaveTextContent('The release checks pass.')
    expect(screen.getByRole('status')).toHaveClass('goal-composer-feedback')
    runtime.mockResolvedValue({ ...pending, goal: { ...active.goal!, condition: 'The release checks pass.' } })
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    await waitFor(() => expect(bar).toHaveTextContent('The release checks pass.'))
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for Claude to confirm')
    expect(bar).toHaveTextContent('Goal set · Claude working')

    runtime.mockResolvedValue({ ...active, goal: { ...active.goal!, condition: 'The release checks pass.' } })
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('shows a native failed verdict without a running goal bar', async () => {
    runtime.mockResolvedValue({ ...active, status: { type: 'idle' },
      goal: { ...active.goal!, status: 'failed', last_reason: 'The requested condition is impossible.', duration_ms: 45_000 } })
    render(surface())
    expect(await screen.findByText('Goal failed')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Claude goal' })).not.toBeInTheDocument()
    expect(screen.getByText('The requested condition is impossible.')).toBeInTheDocument()
    expect(screen.getByText('00:45')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start goal' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Clear goal' })).not.toBeInTheDocument()
  })

  it('describes a pending clear separately from a pending set request', async () => {
    const idle = { ...active, status: { type: 'idle' as const } }
    runtime.mockResolvedValue(idle)
    clearGoal.mockResolvedValue(idle)
    render(surface(false))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Clear goal' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting for Claude to clear the goal…')
    expect(screen.getByRole('button', { name: 'Continue goal' })).toBeDisabled()
    expect(setGoal).not.toHaveBeenCalled()
  })

  it('localizes idle activity and the explicit continue action', async () => {
    setLocale('zh-CN')
    runtime.mockResolvedValue({ ...active, status: { type: 'idle' } })
    render(surface(false))
    const bar = await screen.findByRole('region', { name: 'Claude 目标' })
    expect(bar).toHaveTextContent('目标已设置 · Claude 空闲')
    expect(within(bar).getByRole('button', { name: '继续目标' })).toBeEnabled()
    expect(bar).not.toHaveTextContent(/\d+:\d\d/)
  })

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
    expect(await screen.findByText('Goal request sent. Waiting for Claude to confirm…')).toBeInTheDocument()
    expect(screen.queryByText('Goal set · Claude working')).not.toBeInTheDocument()

    runtime.mockResolvedValue(active)
    act(() => listeners.get('server:event')?.({ profileId: 'another-server', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(screen.queryByText('Goal set · Claude working')).not.toBeInTheDocument()
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(await screen.findByText('Goal set · Claude working')).toBeInTheDocument()
    expect(screen.getByText('One build error remains.')).toBeInTheDocument()
    expect(screen.queryByText('Goal request sent. Waiting for Claude to confirm…')).not.toBeInTheDocument()

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
    expect(within(screen.getByRole('dialog')).getByText('Goal set · Claude working')).toBeInTheDocument()
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
    expect(await screen.findByRole('status')).toHaveTextContent('Goal request sent')

    const rejected = { ...empty, status: active.status, goal_starting: false,
      goal_error: 'Claude could not set this goal. Try again.' }
    runtime.mockResolvedValue(rejected)
    act(() => listeners.get('server:event')?.({ profileId: 'a', profileGeneration: 1,
      event: { session_id: session.id, type: 'claude_goal_changed' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent(rejected.goal_error)
    expect(screen.queryByText('Goal request sent. Waiting for Claude to confirm…')).not.toBeInTheDocument()

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
    expect(screen.queryByText('Goal set · Claude working')).not.toBeInTheDocument()
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
