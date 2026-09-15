import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexRuntimeSnapshot, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { announceCodexGoalsConfigurationChanged } from '../lib/codex-goals'
import { CodexContextIndicator, CodexGoalBar, CodexStatusButton } from './CodexControls'
import { CodexInteractionShelf } from './CodexInteractionShelf'
import { CodexRuntimeProvider, useCodexRuntime } from './CodexRuntimeContext'

const session: Session = {
  id: 'chat-1',
  title: 'App-server work',
  backend: 'codex',
  codex_thread_id: 'thread-1',
  codex_approval_policy: 'on-request',
  codex_sandbox_mode: 'workspace-write',
  codex_approvals_reviewer: 'user'
}

const runtime: CodexRuntimeSnapshot = {
  available: true,
  transport: 'app_server',
  interactive_capability: 'codex_interactive_v1',
  thread_loaded: true,
  persisted_thread: true,
  status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  goal: {
    threadId: 'thread-1',
    objective: 'Finish the integration',
    status: 'active',
    tokenBudget: 50_000,
    tokensUsed: 12_500,
    timeUsedSeconds: 45,
    createdAt: Date.now(),
    updatedAt: Date.now()
  },
  time_budget_seconds: 600,
  time_budget_exhausted: false,
  token_usage: {
    total: { totalTokens: 250_000, inputTokens: 240_000, outputTokens: 10_000 },
    last: { totalTokens: 92_000, inputTokens: 90_000, cachedInputTokens: 80_000, outputTokens: 2_000 },
    modelContextWindow: 100_000
  },
  token_usage_snapshot: {
    run_id: 'run-live',
    turn_id: 'turn-live',
    thread_id: 'thread-1',
    snapshot_at: '2026-07-31T12:00:00Z',
    context_tokens: 92_000,
    context_window: 100_000,
    context_percent: 92,
    cumulative_total_tokens: 250_000,
    token_usage: {
      total: { totalTokens: 250_000, inputTokens: 240_000, outputTokens: 10_000 },
      last: { totalTokens: 92_000, inputTokens: 90_000, cachedInputTokens: 80_000, outputTokens: 2_000 },
      modelContextWindow: 100_000
    }
  },
  pending_interactions: [],
  permission_profiles: [{ id: ':workspace', name: 'Workspace', allowed: true }],
  background_terminals_supported: true
}
let runtimeResponse = runtime
let runtimeFailure: Error | null = null

describe('Codex controls', () => {
  const loadThread = vi.fn()
  const shell = vi.fn().mockResolvedValue({ accepted: true, operation_id: 'op-1' })
  const compact = vi.fn().mockResolvedValue({ accepted: true, operation_id: 'op-2' })
  const rollback = vi.fn().mockResolvedValue({ accepted: true, thread: {} })
  const setGoal = vi.fn().mockResolvedValue({ goal: runtime.goal, time_budget_seconds: runtime.time_budget_seconds })
  const clearGoal = vi.fn().mockResolvedValue({ goal: null, time_budget_seconds: null })
  const backgroundTerminals = vi.fn().mockResolvedValue({ supported: true, terminals: [] })
  const terminateBackgroundTerminal = vi.fn().mockResolvedValue(true)
  const cleanBackgroundTerminals = vi.fn().mockResolvedValue(true)

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeResponse = runtime
    runtimeFailure = null
    loadThread.mockImplementation(async () => ({
      ...runtimeResponse,
      thread_loaded: true,
      status: { type: 'idle' }
    }))
    useAppStore.setState({
      activeProfileId: 'profile-1',
      profileGeneration: 4,
      sessions: [session],
      selectedSessionId: session.id,
      activeSessionIds: new Set()
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        codex: {
          runtime: vi.fn().mockImplementation(() => (
            runtimeFailure ? Promise.reject(runtimeFailure) : Promise.resolve(runtimeResponse)
          )),
          loadThread,
          resolveInteraction: vi.fn(),
          goal: vi.fn().mockResolvedValue({ goal: runtime.goal, time_budget_seconds: runtime.time_budget_seconds }),
          setGoal,
          clearGoal,
          compact,
          rollback,
          review: vi.fn().mockResolvedValue({ accepted: true, operation_id: 'op-review' }),
          shell,
          backgroundTerminals,
          terminateBackgroundTerminal,
          cleanBackgroundTerminals
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows native thread status without duplicating composer permissions', async () => {
    renderControls()

    const trigger = await screen.findByRole('button', { name: 'Codex controls: Approval needed' })
    expect(screen.getByRole('progressbar', { name: 'Codex context usage' })).toHaveAttribute('aria-valuenow', '90.91')
    await userEvent.setup().click(trigger)

    expect(await screen.findByRole('heading', { name: 'Codex thread controls' })).toBeInTheDocument()
    expect(screen.getByText('Live state from Codex app-server')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '80k of 88k usable context tokens used' })).toBeInTheDocument()
    expect(screen.queryByText('Permissions and approvals')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument()
  })

  it('disables shared goal controls when access is lost, while keeping Close available', async () => {
    Object.assign(window.agentsDock, { sharedChat: true })
    useAppStore.setState({ connected: true })
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Approval needed' }))
    expect(await screen.findByRole('button', { name: 'Save goal' })).toBeEnabled()
    act(() => { useAppStore.setState({ connected: false }) })
    expect(screen.getByRole('button', { name: 'Save goal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh Codex status' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close Codex controls' })).toBeEnabled()
  })

  it('opens goal controls only for the addressed Codex chat', async () => {
    renderControls()
    await screen.findByRole('button', { name: 'Codex controls: Approval needed' })
    const runtimeCall = vi.mocked(window.agentsDock.codex.runtime)
    const baselineCalls = runtimeCall.mock.calls.length

    await act(async () => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-codex-controls', {
        detail: { sessionId: 'another-chat', focus: 'goal' }
      }))
      await Promise.resolve()
    })
    expect(screen.queryByRole('heading', { name: 'Codex thread controls' })).not.toBeInTheDocument()
    expect(runtimeCall).toHaveBeenCalledTimes(baselineCalls)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-codex-controls', {
        detail: { sessionId: session.id, focus: 'goal' }
      }))
    })

    expect(await screen.findByRole('heading', { name: 'Codex thread controls' })).toBeVisible()
    expect(screen.getByPlaceholderText('What should Codex keep working toward?')).toHaveFocus()
    await waitFor(() => expect(runtimeCall.mock.calls.length).toBeGreaterThan(baselineCalls))
    expect(runtimeCall).toHaveBeenLastCalledWith(session.id)
  })

  it('lets the authoritative active-run lifecycle override a stale idle thread snapshot', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()

    expect(await screen.findByRole('button', { name: 'Codex controls: Idle' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex controls: Idle' }).querySelector('.spin')).toBeNull()

    act(() => {
      useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    })

    expect(await screen.findByRole('button', { name: 'Codex controls: Running' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex controls: Running' }).querySelector('.spin')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Codex controls: Idle' })).not.toBeInTheDocument()
    act(() => {
      useAppStore.setState({ activeSessionIds: new Set() })
    })
    expect(screen.getByRole('button', { name: 'Codex controls: Idle' }).querySelector('.spin')).toBeNull()
  })

  it('quietly polls active threads for fresh context occupancy', async () => {
    vi.useFakeTimers()
    try {
      useAppStore.setState({ connected: true })
      renderControls()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('progressbar', { name: 'Codex context usage' })).toHaveAttribute('aria-valuenow', '90.91')

      runtimeResponse = {
        ...runtimeResponse,
        token_usage_snapshot: {
          ...(runtime.token_usage_snapshot ?? {}),
          context_tokens: 47_000,
          context_percent: 47,
          snapshot_at: '2026-07-31T12:00:02Z'
        }
      }
      await act(async () => {
        vi.advanceTimersByTime(2_000)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(screen.getByRole('progressbar', { name: 'Codex context usage' })).toHaveAttribute('aria-valuenow', '39.77')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an in-flight telemetry poll overwrite a newer runtime update', async () => {
    vi.useFakeTimers()
    try {
      useAppStore.setState({ connected: true })
      let resolvePoll!: (value: CodexRuntimeSnapshot) => void
      render(
        <CodexRuntimeProvider session={session} capability={{ available: true }}>
          <RuntimeGoalClearProbe />
          <CodexGoalBar />
        </CodexRuntimeProvider>
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByLabelText('Persistent Codex goal')).toBeInTheDocument()

      vi.mocked(window.agentsDock.codex.runtime).mockImplementationOnce(
        () => new Promise(resolve => { resolvePoll = resolve })
      )
      await act(async () => {
        vi.advanceTimersByTime(2_000)
        await Promise.resolve()
      })

      fireEvent.click(screen.getByRole('button', { name: 'Apply newer runtime state' }))
      expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument()

      await act(async () => {
        resolvePoll(runtime)
        await Promise.resolve()
      })
      expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a Codex-style persistent goal bar with direct pause, clear, and detail controls', async () => {
    renderControls(false, true)

    expect(await screen.findByLabelText('Persistent Codex goal')).toBeInTheDocument()
    expect(screen.getByText('Pursuing goal')).toBeVisible()
    expect(screen.getByText('Finish the integration')).toBeVisible()
    expect(screen.getByLabelText('Goal elapsed time 45s')).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Show goal details' }))
    expect(screen.getByText('12,500 / 50,000')).toBeVisible()
    expect(screen.getByText('45s / 10m')).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Pause goal' }))
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith('chat-1', { status: 'paused' }))

    runtimeResponse = { ...runtimeResponse, goal: null, time_budget_seconds: null }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear goal' }))
    await waitFor(() => expect(clearGoal).toHaveBeenCalledWith('chat-1'))
    await waitFor(() => expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument())
  })

  it('keeps disabled goals visible but removes every failing goal mutation', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' }, goals_enabled: false }
    renderControls(false, true)

    expect(await screen.findByText('Goals disabled')).toBeVisible()
    expect(screen.getByText('Finish the integration')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit goal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume goal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause goal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear goal' })).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Codex controls: Idle' }))
    expect(await screen.findByLabelText('Persistent goals disabled')).toBeInTheDocument()
    expect(screen.getByText('Persistent goals are disabled on this server.')).toBeVisible()
    expect(screen.getByText(/Normal chat turns and scheduled jobs still run/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save goal' })).not.toBeInTheDocument()
    expect(setGoal).not.toHaveBeenCalled()
    expect(clearGoal).not.toHaveBeenCalled()
  })

  it('refreshes only the selected matching server profile after the global goal switch changes', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' }, goals_enabled: true }
    renderControls(false, true)
    expect(await screen.findByRole('button', { name: 'Edit goal' })).toBeInTheDocument()
    const runtimeCall = vi.mocked(window.agentsDock.codex.runtime)
    const baselineCalls = runtimeCall.mock.calls.length

    runtimeResponse = { ...runtimeResponse, goals_enabled: false }
    act(() => announceCodexGoalsConfigurationChanged('another-profile', 4, false))
    act(() => announceCodexGoalsConfigurationChanged('profile-1', 3, false))
    await act(async () => { await Promise.resolve() })
    expect(runtimeCall).toHaveBeenCalledTimes(baselineCalls)
    expect(screen.getByRole('button', { name: 'Edit goal' })).toBeInTheDocument()

    act(() => announceCodexGoalsConfigurationChanged('profile-1', 4, false))
    expect(screen.getByText('Goals disabled')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit goal' })).not.toBeInTheDocument()
    await waitFor(() => expect(runtimeCall.mock.calls.length).toBeGreaterThan(baselineCalls))
  })

  it('shows immediate goal-save progress and ignores duplicate submits', async () => {
    let resolveSave!: (value: { goal: CodexRuntimeSnapshot['goal']; time_budget_seconds: number | null }) => void
    setGoal.mockImplementationOnce(() => new Promise(resolve => {
      resolveSave = resolve
    }))
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    const save = screen.getByRole('button', { name: 'Save goal' })
    fireEvent.click(save)
    fireEvent.click(save)

    expect(setGoal).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      resolveSave({ goal: runtime.goal, time_budget_seconds: runtime.time_budget_seconds })
      await Promise.resolve()
    })
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeEnabled()
    expect(screen.getByText('Persistent goal updated.')).toBeVisible()
  })

  it('shows goal-save failures beside the button and allows an immediate retry', async () => {
    setGoal.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'codex:goal:set': Error: Goal save failed"
    ))
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Save goal' }))

    expect(await screen.findByRole('button', { name: 'Retry save' })).toBeEnabled()
    expect(screen.getAllByRole('alert').some(item => item.textContent === 'Goal save failed')).toBe(true)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(setGoal).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeEnabled()
  })

  it('does not apply a late goal-save response after switching chats', async () => {
    let resolveSave!: (value: { goal: CodexRuntimeSnapshot['goal']; time_budget_seconds: number | null }) => void
    setGoal.mockImplementationOnce(() => new Promise(resolve => {
      resolveSave = resolve
    }))
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    const view = renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    const firstObjective = screen.getByPlaceholderText('What should Codex keep working toward?')
    await userEvent.setup().clear(firstObjective)
    await userEvent.setup().type(firstObjective, 'Unsaved work for chat one')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save goal' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()

    const nextSession: Session = {
      ...session,
      id: 'chat-2',
      title: 'Second chat',
      codex_thread_id: 'thread-2'
    }
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, threadId: 'thread-2', objective: 'Second chat goal' } : null
    }
    view.rerender(
      <CodexRuntimeProvider key={nextSession.id} session={nextSession} capability={{ available: true }}>
        <CodexStatusButton />
      </CodexRuntimeProvider>
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    expect(screen.getByPlaceholderText('What should Codex keep working toward?')).toHaveValue('Second chat goal')

    await act(async () => {
      resolveSave({ goal: runtime.goal, time_budget_seconds: runtime.time_budget_seconds })
      await Promise.resolve()
    })
    expect(screen.getByPlaceholderText('What should Codex keep working toward?')).toHaveValue('Second chat goal')
  })

  it('reports invalid goal budgets inline instead of silently blocking form submission', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    const tokenBudget = screen.getByLabelText('Token budget')
    await userEvent.setup().clear(tokenBudget)
    await userEvent.setup().type(tokenBudget, '1.5')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save goal' }))

    expect(setGoal).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Token budget must be a positive whole number or left empty.'
    )
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeEnabled()
  })

  it('waits for an in-flight passive thread load before sending a goal mutation', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await waitFor(() => expect(window.agentsDock.codex.runtime).toHaveBeenCalledTimes(2))

    let resolveLoad!: (value: CodexRuntimeSnapshot) => void
    loadThread.mockImplementationOnce(() => new Promise(resolve => {
      resolveLoad = resolve
    }))
    runtimeResponse = {
      ...runtime,
      thread_loaded: false,
      persisted_thread: true,
      status: { type: 'notLoaded' }
    }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Codex status' }))
    await waitFor(() => expect(loadThread).toHaveBeenCalledOnce())

    await userEvent.setup().click(screen.getByRole('button', { name: 'Save goal' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(setGoal).not.toHaveBeenCalled()

    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    await act(async () => {
      resolveLoad(runtimeResponse)
      await Promise.resolve()
    })

    await waitFor(() => expect(setGoal).toHaveBeenCalledOnce())
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeEnabled()
  })

  it('keeps goal actions usable during passive refresh and ignores its stale result', async () => {
    let resolveStale!: (value: CodexRuntimeSnapshot) => void
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <RuntimeRefreshProbe />
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )
    expect(await screen.findByLabelText('Persistent Codex goal')).toBeInTheDocument()
    const runtimeCall = vi.mocked(window.agentsDock.codex.runtime)
    runtimeCall.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve }))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh probe' }))
    await waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Clear goal' })).toBeEnabled()

    runtimeResponse = { ...runtimeResponse, goal: null, time_budget_seconds: null }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear goal' }))
    await waitFor(() => expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument())

    await act(async () => {
      resolveStale(runtime)
      await Promise.resolve()
    })
    expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument()
  })

  it('surfaces a failed goal clear and re-enables the control', async () => {
    clearGoal.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'codex:goal:clear': Error: Goal clear failed"
    ))
    renderControls(false, true)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit goal' }))
    const clear = await screen.findByRole('button', { name: 'Clear goal' })
    await userEvent.setup().click(clear)

    expect(await screen.findByText('Goal clear failed', { selector: '.codex-inline-action-error' })).toBeVisible()
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Persistent Codex goal')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Retry clear' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save goal' })).toBeEnabled()
  })

  it('cancels an overlapping passive refresh when a goal clear fails', async () => {
    let resolveStale!: (value: CodexRuntimeSnapshot) => void
    clearGoal.mockRejectedValueOnce(new Error('Goal clear failed'))
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <RuntimeRefreshProbe />
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )
    expect(await screen.findByLabelText('Persistent Codex goal')).toBeInTheDocument()
    const runtimeCall = vi.mocked(window.agentsDock.codex.runtime)
    runtimeCall.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve }))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh probe' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh probe' })).toBeDisabled())
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear goal' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Goal clear failed')
    expect(screen.getByRole('button', { name: 'Refresh probe' })).toBeEnabled()
    await act(async () => {
      resolveStale(runtime)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Refresh probe' })).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Goal clear failed')
  })

  it('resumes only a paused goal and does not expose a false resume action for limited goals', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    renderControls(false, true)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Resume goal' }))
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith('chat-1', { status: 'active' }))

    cleanup()
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'budgetLimited' } : null
    }
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )
    expect(await screen.findByText('Budget limited')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Resume goal' })).not.toBeInTheDocument()
  })

  it.each(['idle', 'active'] as const)('distinguishes a paused goal from a running message with an %s thread snapshot', async threadStatus => {
    runtimeResponse = {
      ...runtime,
      status: threadStatus === 'active' ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    renderControls(false, true)

    expect(await screen.findByText('Goal paused · Message running')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Resume goal' })).toBeEnabled()
    expect(setGoal).not.toHaveBeenCalled()

    act(() => { useAppStore.setState({ activeSessionIds: new Set() }) })

    expect(screen.getByText('Goal paused')).toBeVisible()
    expect(screen.queryByText('Goal paused · Message running')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume goal' })).toBeEnabled()
  })

  it.each([
    ['blocked', 'Goal blocked'], ['complete', 'Goal complete'], ['budgetLimited', 'Budget limited']
  ] as const)('distinguishes a %s goal from separately running chat work', async (status, label) => {
    runtimeResponse = { ...runtime, goal: runtime.goal ? { ...runtime.goal, status } : null }
    useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    renderControls(false, true)
    expect(await screen.findByText(`${label} · Message running`)).toBeVisible()
    expect(setGoal).not.toHaveBeenCalled()
    act(() => { useAppStore.setState({ activeSessionIds: new Set() }) })
    expect(screen.getByText(label)).toBeVisible()
  })

  it('shows immediate resume progress and sends only one status update while pending', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    let resolveResume!: (value: { goal: CodexRuntimeSnapshot['goal']; time_budget_seconds: number | null }) => void
    setGoal.mockImplementationOnce(() => new Promise(resolve => { resolveResume = resolve }))
    renderControls(false, true)

    const resume = await screen.findByRole('button', { name: 'Resume goal' })
    fireEvent.click(resume)
    fireEvent.click(resume)

    expect(setGoal).toHaveBeenCalledOnce()
    expect(setGoal).toHaveBeenCalledWith('chat-1', { status: 'active' })
    expect(screen.getByText('Resuming goal…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Resuming goal…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resuming goal…' })).toHaveAttribute('aria-busy', 'true')

    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    await act(async () => {
      resolveResume({ goal: runtime.goal, time_budget_seconds: runtime.time_budget_seconds })
      await Promise.resolve()
    })
    expect(await screen.findByRole('button', { name: 'Pause goal' })).toBeEnabled()
    expect(screen.queryByText('Resuming goal…')).not.toBeInTheDocument()
  })

  it('keeps a resume failure visible across passive refresh and offers retry', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    setGoal.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'codex:goal:set': Error: Goal owner could not start"
    ))
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <RuntimeRefreshProbe />
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Resume goal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not resume goal: Goal owner could not start')
    expect(screen.getByRole('button', { name: 'Retry resume goal' })).toBeEnabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh probe' }))
    await waitFor(() => expect(window.agentsDock.codex.runtime).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not resume goal: Goal owner could not start')

    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry resume goal' }))
    await waitFor(() => expect(setGoal).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Pause goal' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps Pause correct when authoritative activation arrives before a late resume rejection', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    let rejectResume!: (error: Error) => void
    setGoal.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectResume = reject }))
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <RuntimeRefreshProbe />
        <RuntimeGoalActivateProbe />
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Resume goal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply active goal' }))
    await act(async () => {
      rejectResume(new Error('The goal response was disconnected.'))
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Pause goal' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry resume goal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Only the superseded mutation error is hidden, not a subsequent failure.
    runtimeFailure = new Error('Runtime is unreachable.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh probe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Runtime is unreachable.')
    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }))
    await waitFor(() => expect(setGoal).toHaveBeenLastCalledWith('chat-1', { status: 'paused' }))
  })

  it('shows resume progress while waiting for an already-started thread load', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      goal: runtime.goal ? { ...runtime.goal, status: 'paused' } : null
    }
    render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <RuntimeRefreshProbe />
        <CodexGoalBar />
      </CodexRuntimeProvider>
    )
    await screen.findByRole('button', { name: 'Resume goal' })

    let resolveLoad!: (value: CodexRuntimeSnapshot) => void
    loadThread.mockImplementationOnce(() => new Promise(resolve => { resolveLoad = resolve }))
    runtimeResponse = { ...runtimeResponse, thread_loaded: false, status: { type: 'notLoaded' } }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh probe' }))
    await waitFor(() => expect(loadThread).toHaveBeenCalledOnce())
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume goal' }))
    expect(screen.getByRole('button', { name: 'Resuming goal…' })).toBeDisabled()
    expect(setGoal).not.toHaveBeenCalled()

    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    await act(async () => {
      resolveLoad(runtimeResponse)
      await Promise.resolve()
    })
    await waitFor(() => expect(setGoal).toHaveBeenCalledOnce())
    expect(await screen.findByRole('button', { name: 'Pause goal' })).toBeEnabled()
  })

  it('opens goal editing from the compact goal bar', async () => {
    renderControls(false, true)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit goal' }))

    expect(await screen.findByRole('heading', { name: 'Codex thread controls' })).toBeVisible()
    expect(screen.getByPlaceholderText('What should Codex keep working toward?')).toHaveFocus()
  })

  it('hides the compact goal bar when this thread has no goal', async () => {
    runtimeResponse = { ...runtime, goal: null }
    renderControls(false, true)
    await waitFor(() => expect(window.agentsDock.codex.runtime).toHaveBeenCalled())
    expect(screen.queryByLabelText('Persistent Codex goal')).not.toBeInTheDocument()
  })

  it('requires explicit confirmation before an unsandboxed shell command', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Advanced and unsandboxed actions' }))

    const run = screen.getByRole('button', { name: 'Run command' })
    expect(run).toBeDisabled()
    await userEvent.setup().type(screen.getByPlaceholderText('Enter an exact shell command'), 'git status')
    expect(run).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'I explicitly approve running this command with full access.' }))
    expect(run).toBeEnabled()
    await userEvent.setup().click(run)

    await waitFor(() => expect(shell).toHaveBeenCalledWith('chat-1', {
      command: 'git status',
      confirmed: true
    }))
  })

  it('shows an explicit warning and status when the persistent goal time budget is exhausted', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' }, time_budget_exhausted: true }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    expect(await screen.findByText('Time budget exhausted')).toBeInTheDocument()
    expect(screen.getByText('New goal turns are blocked. Increase the time limit or change the objective to continue.')).toBeInTheDocument()
    expect(screen.getByText('Time exhausted')).toBeInTheDocument()
    expect(screen.getByText('Exhausted. Raise this limit or change the objective before starting another goal turn.')).toBeInTheDocument()
  })

  it('starts native compaction without a destructive warning', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact' }))
    await waitFor(() => expect(compact).toHaveBeenCalledWith('chat-1'))
    expect(await screen.findByText('Native context compaction started.')).toBeInTheDocument()
  })

  it('automatically reloads a persisted thread after an app-server restart', async () => {
    runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
    const summarySession: Session = {
      id: 'chat-1',
      title: 'Summary-only chat',
      backend: 'codex'
    }
    renderControls(false, false, summarySession)

    expect(await screen.findByRole('button', { name: 'Codex controls: Idle' })).toBeInTheDocument()
    expect(loadThread).toHaveBeenCalledOnce()
    expect(loadThread).toHaveBeenCalledWith('chat-1')
  })

  it('does not passively resume an unfocused split-pane thread', async () => {
    runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
    const view = render(
      <CodexRuntimeProvider session={session} capability={{ available: true }} focused={false}>
        <CodexContextIndicator />
      </CodexRuntimeProvider>
    )

    await waitFor(() => expect(runtime).toBeDefined())
    expect(loadThread).not.toHaveBeenCalled()

    view.rerender(
      <CodexRuntimeProvider session={session} capability={{ available: true }} focused>
        <CodexContextIndicator />
      </CodexRuntimeProvider>
    )
    await waitFor(() => expect(loadThread).toHaveBeenCalledWith('chat-1'))
  })

  it('cancels a passive resume when its pane loses focus during the settle window', async () => {
    vi.useFakeTimers()
    try {
      runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
      const view = render(
        <CodexRuntimeProvider session={session} capability={{ available: true }} focused>
          <CodexContextIndicator />
        </CodexRuntimeProvider>
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(window.agentsDock.codex.runtime).toHaveBeenCalled()

      view.rerender(
        <CodexRuntimeProvider session={session} capability={{ available: true }} focused={false}>
          <CodexContextIndicator />
        </CodexRuntimeProvider>
      )
      await act(async () => {
        vi.advanceTimersByTime(150)
        await Promise.resolve()
      })
      expect(loadThread).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an approval mutation locked when its split pane loses focus', async () => {
    const approval: CodexRuntimeSnapshot['pending_interactions'][number] = {
      id: 'approval-1',
      session_id: session.id,
      thread_id: 'thread-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        command: 'git status',
        reason: 'Inspect the working tree',
        availableDecisions: ['accept', 'decline', 'cancel']
      },
      created_at: new Date().toISOString()
    }
    runtimeResponse = {
      ...runtime,
      pending_interactions: [approval]
    }
    let finishApproval!: () => void
    const resolveInteraction = vi.mocked(window.agentsDock.codex.resolveInteraction)
    resolveInteraction.mockImplementationOnce(() => new Promise(resolve => {
      finishApproval = () => resolve(approval)
    }))
    const view = render(
      <CodexRuntimeProvider session={session} capability={{ available: true }} focused>
        <CodexInteractionShelf />
      </CodexRuntimeProvider>
    )

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Approve & run' }))
    expect(resolveInteraction).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()

    view.rerender(
      <CodexRuntimeProvider session={session} capability={{ available: true }} focused={false}>
        <CodexInteractionShelf />
      </CodexRuntimeProvider>
    )
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
    expect(resolveInteraction).toHaveBeenCalledOnce()

    await act(async () => {
      finishApproval()
      await Promise.resolve()
    })
    expect(resolveInteraction).toHaveBeenCalledOnce()
  })

  it('does not resume a stale thread while the user is rapidly switching chats', async () => {
    runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
    const nextSession: Session = {
      ...session,
      id: 'chat-2',
      title: 'Next chat',
      codex_thread_id: 'thread-2'
    }
    const view = render(
      <CodexRuntimeProvider key={session.id} session={session} capability={{ available: true }}>
        <div />
      </CodexRuntimeProvider>
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    view.rerender(
      <CodexRuntimeProvider key={nextSession.id} session={nextSession} capability={{ available: true }}>
        <div />
      </CodexRuntimeProvider>
    )

    await waitFor(() => expect(loadThread).toHaveBeenCalledWith('chat-2'))
    expect(loadThread).not.toHaveBeenCalledWith('chat-1')
  })

  it('retries a failed automatic thread load from the controls', async () => {
    runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
    loadThread
      .mockRejectedValueOnce(new Error('Codex thread resume failed'))
      .mockResolvedValueOnce({ ...runtime, thread_loaded: true, status: { type: 'idle' } })
    renderControls()
    const trigger = await screen.findByRole('button', { name: 'Codex controls: Error' })

    await userEvent.setup().click(trigger)

    await waitFor(() => {
      expect(screen.getByText('Idle', { selector: 'strong' })).toBeInTheDocument()
      expect(screen.getByText('Loaded', { selector: 'strong' })).toBeInTheDocument()
    })
    expect(loadThread).toHaveBeenCalledTimes(2)
  })

  it('keeps a brand-new chat unloaded until its first Codex turn', async () => {
    runtimeResponse = {
      ...runtime,
      persisted_thread: false,
      thread_loaded: false,
      status: { type: 'notLoaded' }
    }
    const emptySession: Session = {
      id: 'chat-empty',
      title: 'New chat',
      backend: 'codex'
    }
    renderControls(false, false, emptySession)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Not loaded' }))

    expect(loadThread).not.toHaveBeenCalled()
    expect(screen.getByText('Start a Codex turn in this chat before using thread actions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('keeps older servers observational when on-demand loading is unsupported', async () => {
    const legacySnapshot: CodexRuntimeSnapshot = {
      ...runtime,
      persisted_thread: undefined,
      thread_loaded: false,
      status: { type: 'notLoaded' }
    }
    runtimeResponse = legacySnapshot
    loadThread.mockResolvedValue(legacySnapshot)
    renderControls()

    expect(await screen.findByRole('button', { name: 'Codex controls: Not loaded' })).toBeInTheDocument()
    expect(loadThread).toHaveBeenCalledWith('chat-1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reloads the selected persisted thread when the server reconnects', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    expect(await screen.findByRole('button', { name: 'Codex controls: Idle' })).toBeInTheDocument()

    runtimeResponse = { ...runtime, thread_loaded: false, status: { type: 'notLoaded' } }
    act(() => useAppStore.setState({ connected: false }))
    act(() => useAppStore.setState({ connected: true }))

    await waitFor(() => expect(loadThread).toHaveBeenCalledWith('chat-1'))
    expect(screen.getByRole('button', { name: 'Codex controls: Idle' })).toBeInTheDocument()
  })

  it('requires confirmation before stopping every background terminal', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    backgroundTerminals.mockResolvedValue({
      supported: true,
      terminals: [{
        itemId: 'item-1',
        processId: 'process-1',
        command: 'python3 worker.py',
        cwd: '/work'
      }]
    })
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /^Background terminals/ }))
    const stopAll = await screen.findByRole('button', { name: 'Stop all terminals' })
    expect(stopAll).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('checkbox', {
      name: 'I understand this stops every running background terminal in this thread.'
    }))
    await userEvent.setup().click(stopAll)
    await waitFor(() => expect(cleanBackgroundTerminals).toHaveBeenCalledWith(
      'chat-1',
      { confirmed: true }
    ))
  })

  it('requires a second explicit action before terminating one background terminal', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    backgroundTerminals.mockResolvedValue({
      supported: true,
      terminals: [{
        itemId: 'item-1',
        processId: 'process-1',
        command: 'python3 worker.py',
        cwd: '/work'
      }]
    })
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: /^Background terminals/ }))
    const terminate = await screen.findByRole('button', { name: 'Terminate' })

    await userEvent.setup().click(terminate)
    expect(terminateBackgroundTerminal).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm terminate' }))

    await waitFor(() => expect(terminateBackgroundTerminal).toHaveBeenCalledWith('chat-1', {
      process_id: 'process-1',
      confirmed: true
    }))
  })

  it('sends explicit confirmation for provider-context rollback', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Advanced and unsandboxed actions' }))

    const submit = screen.getByRole('button', { name: 'Roll back' })
    expect(submit).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'I understand this does not revert files.' }))
    await userEvent.setup().click(submit)

    await waitFor(() => expect(rollback).toHaveBeenCalledWith('chat-1', {
      num_turns: 1,
      confirmed: true
    }))
  })

  it('preserves an unsaved goal draft across fresh runtime snapshots', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    const objective = screen.getByPlaceholderText('What should Codex keep working toward?')
    await userEvent.setup().clear(objective)
    await userEvent.setup().type(objective, 'Local unsaved objective')
    runtimeResponse = {
      ...runtimeResponse,
      goal: runtimeResponse.goal ? { ...runtimeResponse.goal } : null
    }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Codex status' }))

    await waitFor(() => expect(objective).toHaveValue('Local unsaved objective'))
  })

  it('surfaces an unavailable runtime and disables native thread actions', async () => {
    runtimeResponse = { ...runtime, available: false, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Unavailable' }))

    expect(screen.getByText('Controls unavailable', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('treats an explicitly unloaded runtime thread as authoritative over stale session IDs', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'idle' },
      thread_loaded: false
    }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))

    expect(screen.getByText('Start a Codex turn in this chat before using thread actions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('surfaces runtime loading errors instead of reporting an idle thread', async () => {
    runtimeFailure = new Error('App-server connection failed')
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Error' }))

    expect(screen.getByRole('alert')).toHaveTextContent('App-server connection failed')
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('disables native actions when a refresh fails after a successful snapshot', async () => {
    runtimeResponse = { ...runtime, status: { type: 'idle' } }
    renderControls()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Codex controls: Idle' }))
    expect(screen.getByRole('button', { name: 'Compact' })).toBeEnabled()

    runtimeFailure = new Error('App-server connection failed')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Codex status' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('App-server connection failed'))
    expect(screen.getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('reopens a collapsed interaction shelf when a same-count request is replaced', async () => {
    runtimeResponse = {
      ...runtime,
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      pending_interactions: [pendingQuestion('request-1', 'First question')]
    }
    renderControls(true)
    expect(await screen.findByText('First question')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide requests' }))
    expect(screen.getByRole('button', { name: 'Show requests' })).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Codex controls: 1 waiting' }))
    runtimeResponse = {
      ...runtimeResponse,
      pending_interactions: [pendingQuestion('request-2', 'Replacement question')]
    }
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Codex status' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close Codex controls' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide requests' })).toBeInTheDocument())
  })
})

function renderControls(withShelf = false, withGoal = false, selectedSession = session) {
  return render(
    <CodexRuntimeProvider session={selectedSession} capability={{ available: true }}>
      <CodexContextIndicator />
      <CodexStatusButton />
      {withShelf && <CodexInteractionShelf />}
      {withGoal && <CodexGoalBar />}
    </CodexRuntimeProvider>
  )
}

function RuntimeRefreshProbe() {
  const { refresh, refreshing } = useCodexRuntime()
  return <button type="button" disabled={refreshing} onClick={() => void refresh()}>Refresh probe</button>
}

function RuntimeGoalClearProbe() {
  const { applyGoalSnapshot } = useCodexRuntime()
  return <button
    type="button"
    onClick={() => applyGoalSnapshot({
      goal: null,
      time_budget_seconds: null,
      time_budget_exhausted: false
    })}
  >Apply newer runtime state</button>
}

function RuntimeGoalActivateProbe() {
  const { applyGoalSnapshot } = useCodexRuntime()
  return <button type="button" onClick={() => applyGoalSnapshot({
    goal: runtime.goal,
    time_budget_seconds: runtime.time_budget_seconds,
    time_budget_exhausted: false
  })}>Apply active goal</button>
}

function pendingQuestion(id: string, question: string): CodexRuntimeSnapshot['pending_interactions'][number] {
  return {
    id,
    session_id: session.id,
    thread_id: session.codex_thread_id!,
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{ id: 'question', question, options: [{ label: 'Continue' }] }]
    },
    created_at: new Date().toISOString()
  }
}
