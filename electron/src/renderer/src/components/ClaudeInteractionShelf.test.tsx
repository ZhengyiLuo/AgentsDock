import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type { ClaudeRuntimeSnapshot, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ClaudeInteractionShelf } from './ClaudeInteractionShelf'
import { ClaudeContextIndicator } from './ClaudeContextIndicator'
import { CLAUDE_RUNTIME_REFRESH_TIMEOUT_MS, ClaudeRuntimeProvider, useClaudeRuntime } from './ClaudeRuntimeContext'

const session: Session = {
  id: 'claude-chat',
  title: 'Claude SDK work',
  backend: 'claude',
  claude_session_id: 'claude-session'
}

const summaryPendingSession: Session = {
  ...session,
  claude_pending_interaction_count: 1,
  claude_needs_user_action: true
}

const interaction = {
  id: 'permission-1',
  session_id: session.id,
  claude_session_id: 'claude-session',
  tool_use_id: 'tool-1',
  method: 'item/commandExecution/requestApproval',
  params: {
    toolName: 'Bash',
    displayName: 'Run shell command',
    toolInput: { command: 'git status --short' },
    availableDecisions: ['accept', 'decline']
  },
  created_at: '2026-08-05T12:00:00Z'
} satisfies ClaudeRuntimeSnapshot['pending_interactions'][number]

const runtime: ClaudeRuntimeSnapshot = {
  available: true,
  transport: 'sdk',
  interactive_capability: 'claude_sdk_interactive_v1',
  persisted_session: true,
  session_loaded: true,
  status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  pending_interactions: [interaction],
  policy: { permission_mode: 'default' }
}

describe('Claude interaction shelf', () => {
  const runtimeRequest = vi.fn()
  const refreshContextUsage = vi.fn()
  const resolveInteraction = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeRequest.mockResolvedValue(runtime)
    refreshContextUsage.mockResolvedValue(runtime)
    resolveInteraction.mockResolvedValue(interaction)
    useAppStore.setState({
      activeProfileId: 'profile-1',
      profileGeneration: 3,
      connected: true,
      sessions: [session],
      selectedSessionId: session.id
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        claude: { runtime: runtimeRequest, refreshContextUsage, resolveInteraction },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
  })

  afterEach(() => {
    cleanup()
    setLocale('en')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders and resolves an SDK permission through the Claude-specific bridge', async () => {
    renderShelf({
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    })

    const shelf = await screen.findByLabelText('Claude is waiting for approval')
    expect(shelf).toBeInTheDocument()
    expect(shelf).not.toHaveAttribute('aria-live')
    expect(screen.getByText('Review the command below. Claude stays paused until you choose.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve & run' }))

    await waitFor(() => expect(resolveInteraction).toHaveBeenCalledWith(
      session.id,
      interaction.id,
      { decision: 'accept' }
    ))
  })

  it('keeps a summarized pending request visible while its live controls load', async () => {
    const pending = deferred<ClaudeRuntimeSnapshot>()
    runtimeRequest.mockReturnValueOnce(pending.promise)
    renderShelf({
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    }, summaryPendingSession)

    expect(await screen.findByLabelText('Claude may need your response')).toBeInTheDocument()
    expect(screen.getByText('Loading pending request details…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload Claude requests' })).toBeDisabled()

    await act(async () => {
      pending.resolve(runtime)
      await pending.promise
    })

    expect(await screen.findByLabelText('Claude is waiting for approval')).toBeInTheDocument()
    expect(screen.queryByText('Loading pending request details…')).not.toBeInTheDocument()
  })

  it('reloads a summarized pending request after its runtime controls fail to load', async () => {
    runtimeRequest
      .mockRejectedValueOnce(new Error('Runtime observation failed'))
      .mockResolvedValueOnce(runtime)
    renderShelf({
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    }, summaryPendingSession)

    expect(await screen.findByText('The pending request could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Runtime observation failed')).toBeInTheDocument()
    const reload = screen.getByRole('button', { name: 'Reload Claude requests' })
    expect(reload).toBeEnabled()
    await userEvent.setup().click(reload)

    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('Claude is waiting for approval')).toBeInTheDocument()
    expect(screen.queryByText('Runtime observation failed')).not.toBeInTheDocument()
  })

  it('localizes the new recovery controls while preserving the raw error and retry behavior', async () => {
    runtimeRequest
      .mockRejectedValueOnce(new Error('Raw runtime failure: /tmp/Message.txt'))
      .mockResolvedValueOnce(runtime)
    setLocale('zh-CN')
    renderShelf({
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    }, summaryPendingSession)
    expect(await screen.findByText('无法加载待处理请求。')).toBeInTheDocument()
    expect(screen.getByLabelText('Claude 可能需要你回复')).toBeInTheDocument()
    expect(screen.getByText('Raw runtime failure: /tmp/Message.txt')).toBeInTheDocument()
    const reload = screen.getByRole('button', { name: '重新加载 Claude 请求' })
    act(() => setLocale('en'))
    expect(screen.getByRole('button', { name: 'Reload Claude requests' })).toBe(reload)
    await userEvent.setup().click(reload)
    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('Claude is waiting for approval')).toBeInTheDocument()
  })

  it('trusts a successful empty runtime over stale pending summary metadata', async () => {
    const pending = deferred<ClaudeRuntimeSnapshot>()
    runtimeRequest.mockReturnValueOnce(pending.promise)
    renderShelf({
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    }, summaryPendingSession)

    expect(await screen.findByText('Loading pending request details…')).toBeInTheDocument()
    await act(async () => {
      pending.resolve({
        ...runtime,
        status: { type: 'idle' },
        pending_interactions: []
      })
      await pending.promise
    })

    await waitFor(() => expect(screen.queryByLabelText('Claude may need your response')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Reload Claude requests' })).not.toBeInTheDocument()
  })

  it('does not call additive Claude routes when an older server lacks the capability', async () => {
    renderShelf(undefined)

    await Promise.resolve()
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Claude is waiting for approval')).not.toBeInTheDocument()
  })

  it('requires the exact SDK client capability rather than only an available flag', async () => {
    renderShelf({ available: true })

    await Promise.resolve()
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('never mounts Claude controls in a Codex chat', async () => {
    render(
      <ClaudeRuntimeProvider
        session={{ ...session, backend: 'codex' }}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeInteractionShelf />
      </ClaudeRuntimeProvider>
    )

    await Promise.resolve()
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('shows context details and requests an authoritative SDK refresh on click', async () => {
    const initial = {
      ...runtime,
      status: { type: 'idle' as const },
      pending_interactions: [],
      features: { context_usage_refresh: true },
      context_usage_state: 'available',
      context_usage_snapshot: {
        context_tokens: 66_000,
        effective_context_window: 100_000,
        raw_context_window: 200_000,
        context_percent: 66,
        model: 'claude-opus-4-1',
        provider_session_id: 'claude-session',
        usage_generation: 2
      }
    }
    runtimeRequest.mockResolvedValue(initial)
    refreshContextUsage.mockResolvedValue({
      ...initial,
      context_usage_refreshed: true,
      context_usage_snapshot: {
        ...initial.context_usage_snapshot,
        context_tokens: 72_000,
        context_percent: 72,
        usage_generation: 3
      }
    })
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )

    const progress = await screen.findByRole('progressbar', { name: 'Claude context usage' })
    expect(progress).toHaveAttribute('aria-valuenow', '66')
    const button = screen.getByRole('button', { name: 'Refresh Claude context usage' })
    expect(progress).toHaveAttribute(
      'aria-valuetext',
      '66% context used · 66k / 100k usable tokens · 200k raw window · claude-opus-4-1'
    )
    const user = userEvent.setup()
    await user.hover(button)
    expect((await screen.findAllByText(
      '66k / 100k usable tokens · 200k raw window · claude-opus-4-1'
    ))[0]).toBeVisible()

    await user.click(button)
    await waitFor(() => expect(refreshContextUsage).toHaveBeenCalledWith(session.id))
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '72'))
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it('does not POST context refresh when an older server omits the feature', async () => {
    runtimeRequest.mockResolvedValue({
      ...runtime,
      status: { type: 'idle' },
      pending_interactions: [],
      context_usage_snapshot: {
        context_tokens: 30_000,
        effective_context_window: 100_000,
        context_percent: 30
      }
    })
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )

    await screen.findByRole('progressbar', { name: 'Claude context usage' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Claude context usage' }))
    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(2))
    expect(refreshContextUsage).not.toHaveBeenCalled()
  })

  it('waits for terminal sampling instead of sending an SDK control during an active turn', async () => {
    runtimeRequest.mockResolvedValue({
      ...runtime,
      features: { context_usage_refresh: true },
      context_usage_snapshot: {
        context_tokens: 30_000,
        effective_context_window: 100_000,
        context_percent: 30
      }
    })
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )

    await screen.findByRole('progressbar', { name: 'Claude context usage' })
    const button = screen.getByRole('button', { name: 'Refresh Claude context usage' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.setup().click(button)
    expect(refreshContextUsage).not.toHaveBeenCalled()
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it('preserves the last good context sample when an on-demand refresh fails', async () => {
    const lastGood = {
      ...runtime,
      status: { type: 'idle' as const },
      pending_interactions: [],
      features: { context_usage_refresh: true },
      context_usage_snapshot: {
        context_tokens: 48_000,
        effective_context_window: 100_000,
        context_percent: 48,
        model: 'claude-opus'
      }
    }
    runtimeRequest.mockResolvedValue(lastGood)
    refreshContextUsage.mockRejectedValue(new Error('Claude context sampling timed out'))
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )

    const progress = await screen.findByRole('progressbar', { name: 'Claude context usage' })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Claude context usage' }))
    await waitFor(() => expect(refreshContextUsage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '48'))
    expect(progress).toHaveAttribute('aria-valuetext', expect.stringContaining('48% context used'))
  })

  it('stops a context refresh spinner when the bridge never settles', async () => {
    const snapshot = interactiveRuntimeWithContext()
    const pending = deferred<ClaudeRuntimeSnapshot>()
    runtimeRequest.mockResolvedValue(snapshot)
    refreshContextUsage.mockReturnValue(pending.promise)
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
        <ContextUsageErrorProbe />
      </ClaudeRuntimeProvider>
    )

    const refreshButton = await screen.findByRole('button', { name: 'Refresh Claude context usage' })
    vi.useFakeTimers()
    fireEvent.click(refreshButton)
    expect(refreshButton).toHaveAttribute('aria-busy', 'true')

    await act(async () => vi.advanceTimersByTimeAsync(CLAUDE_RUNTIME_REFRESH_TIMEOUT_MS))

    expect(refreshButton).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('claude-context-usage-error')).toHaveTextContent('Claude context refresh timed out.')
  })

  it('bounds an observational runtime refresh when the bridge never settles', async () => {
    const pending = deferred<ClaudeRuntimeSnapshot>()
    runtimeRequest.mockResolvedValueOnce(runtime).mockReturnValueOnce(pending.promise)
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <RuntimeRefreshProbe />
      </ClaudeRuntimeProvider>
    )

    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Claude runtime' }))
    expect(runtimeRequest).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(CLAUDE_RUNTIME_REFRESH_TIMEOUT_MS))

    expect(screen.getByTestId('claude-runtime-error')).toHaveTextContent('Claude runtime refresh timed out.')
  })

  it('shows context sampling failures only in the context indicator', async () => {
    const snapshot = interactiveRuntimeWithContext()
    runtimeRequest.mockResolvedValue(snapshot)
    refreshContextUsage.mockRejectedValue(new Error('Claude context sampling timed out'))
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
        <ClaudeInteractionShelf />
      </ClaudeRuntimeProvider>
    )

    expect(await screen.findByLabelText('Claude is waiting for approval')).toBeInTheDocument()
    const refreshButton = screen.getByRole('button', { name: 'Refresh Claude context usage' })
    const user = userEvent.setup()
    await user.click(refreshButton)
    await waitFor(() => expect(refreshContextUsage).toHaveBeenCalledTimes(1))
    await user.unhover(refreshButton)
    await user.hover(refreshButton)
    expect((await screen.findAllByText(
      'Refresh failed: Claude context sampling timed out'
    ))[0]).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a context refresh error across an automatic cached runtime snapshot', async () => {
    const listeners = captureServerEventListeners()
    const snapshot = interactiveRuntimeWithContextGeneration(2)
    runtimeRequest.mockResolvedValue(snapshot)
    refreshContextUsage.mockRejectedValue(new Error('Claude context sampling timed out'))
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
        <ContextUsageErrorProbe />
      </ClaudeRuntimeProvider>
    )

    const refreshButton = await screen.findByRole('button', { name: 'Refresh Claude context usage' })
    await userEvent.setup().click(refreshButton)
    await waitFor(() => expect(screen.getByTestId('claude-context-usage-error')).toHaveTextContent(
      'Claude context sampling timed out'
    ))

    runtimeRequest.mockResolvedValueOnce(interactiveRuntimeWithContextGeneration(2))
    act(() => emitClaudeContextRuntimeChange(listeners, 2))
    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('claude-context-usage-error')).toHaveTextContent(
      'Claude context sampling timed out'
    )
  })

  it('clears a context refresh error after a newer automatic runtime snapshot', async () => {
    const listeners = captureServerEventListeners()
    const snapshot = interactiveRuntimeWithContextGeneration(2)
    runtimeRequest.mockResolvedValue(snapshot)
    refreshContextUsage.mockRejectedValue(new Error('Claude context sampling timed out'))
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
        <ContextUsageErrorProbe />
      </ClaudeRuntimeProvider>
    )

    const refreshButton = await screen.findByRole('button', { name: 'Refresh Claude context usage' })
    await userEvent.setup().click(refreshButton)
    await waitFor(() => expect(screen.getByTestId('claude-context-usage-error')).toHaveTextContent(
      'Claude context sampling timed out'
    ))

    runtimeRequest.mockResolvedValueOnce({
      ...interactiveRuntimeWithContextGeneration(2),
      usage_generation: 3,
      context_usage_snapshot: {
        ...snapshot.context_usage_snapshot,
        context_tokens: 35_000,
        context_percent: 35,
        usage_generation: 3
      }
    })
    act(() => emitClaudeContextRuntimeChange(listeners, 3))
    await waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('claude-context-usage-error')).toBeEmptyDOMElement())
  })

  it('keeps approval failures out of the context indicator and through context refreshes', async () => {
    const snapshot = interactiveRuntimeWithContext()
    runtimeRequest.mockResolvedValue(snapshot)
    refreshContextUsage.mockResolvedValue(snapshot)
    resolveInteraction.mockRejectedValue(new Error('Approval response failed'))
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <ClaudeContextIndicator />
        <ClaudeInteractionShelf />
      </ClaudeRuntimeProvider>
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Approve & run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Approval response failed')

    const refreshButton = screen.getByRole('button', { name: 'Refresh Claude context usage' })
    await user.hover(refreshButton)
    expect((await screen.findAllByText('Click to refresh now'))[0]).toBeVisible()
    expect(screen.queryByText('Refresh failed: Approval response failed')).not.toBeInTheDocument()

    await user.click(refreshButton)
    await waitFor(() => expect(refreshContextUsage).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alert')).toHaveTextContent('Approval response failed')
  })

  it('keeps observational runtime failures out of the interaction shelf', async () => {
    runtimeRequest.mockResolvedValue(runtime)
    render(
      <ClaudeRuntimeProvider
        session={session}
        capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
      >
        <RuntimeRefreshProbe />
        <ClaudeInteractionShelf />
      </ClaudeRuntimeProvider>
    )

    expect(await screen.findByLabelText('Claude is waiting for approval')).toBeInTheDocument()
    runtimeRequest.mockRejectedValueOnce(new Error('Runtime observation failed'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Claude runtime' }))
    await waitFor(() => expect(screen.getByTestId('claude-runtime-error')).toHaveTextContent(
      'Runtime observation failed'
    ))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a context refresh response after switching chats', async () => {
    const pending = deferred<ClaudeRuntimeSnapshot>()
    const sessionTwo: Session = {
      ...session,
      id: 'claude-chat-two',
      claude_session_id: 'claude-session-two'
    }
    runtimeRequest.mockImplementation(async (sessionId: string) => ({
      ...runtime,
      status: { type: 'idle' },
      pending_interactions: [],
      features: { context_usage_refresh: true },
      context_usage_snapshot: {
        context_tokens: sessionId === sessionTwo.id ? 25_000 : 40_000,
        effective_context_window: 100_000,
        context_percent: sessionId === sessionTwo.id ? 25 : 40
      }
    }))
    refreshContextUsage.mockReturnValueOnce(pending.promise)
    const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
    const view = render(
      <ClaudeRuntimeProvider session={session} capability={capability}>
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )

    const progress = await screen.findByRole('progressbar', { name: 'Claude context usage' })
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '40'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Claude context usage' }))
    await waitFor(() => expect(refreshContextUsage).toHaveBeenCalledWith(session.id))

    view.rerender(
      <ClaudeRuntimeProvider session={sessionTwo} capability={capability}>
        <ClaudeContextIndicator />
      </ClaudeRuntimeProvider>
    )
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '25'))
    await act(async () => {
      pending.resolve({
        ...runtime,
        features: { context_usage_refresh: true },
        context_usage_refreshed: true,
        context_usage_snapshot: {
          context_tokens: 99_000,
          effective_context_window: 100_000,
          context_percent: 99
        }
      })
      await pending.promise
    })
    expect(progress).toHaveAttribute('aria-valuenow', '25')
  })

  it('preserves the terminal runtime refresh when timeline updates replace the same session', async () => {
    vi.useFakeTimers()
    const listeners = captureServerEventListeners()
    const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
    const view = render(
      <ClaudeRuntimeProvider session={session} capability={capability}>
        <RuntimeStatusProbe />
      </ClaudeRuntimeProvider>
    )
    await act(async () => {})
    expect(screen.getByTestId('claude-runtime-status')).toHaveTextContent('active')
    runtimeRequest.mockResolvedValue({ ...runtime, status: { type: 'idle' }, pending_interactions: [] })

    act(() => listeners.get('server:event')?.({
      profileId: 'profile-1', profileGeneration: 3,
      event: { session_id: session.id, type: 'turn_finished', seq: 42 }
    }))
    view.rerender(
      <ClaudeRuntimeProvider session={{ ...session, latest_event_seq: 42 }} capability={capability}>
        <RuntimeStatusProbe />
      </ClaudeRuntimeProvider>
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(runtimeRequest).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('claude-runtime-status')).toHaveTextContent('idle')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function interactiveRuntimeWithContext(): ClaudeRuntimeSnapshot {
  return {
    ...runtime,
    status: { type: 'idle' },
    features: { context_usage_refresh: true },
    context_usage_snapshot: {
      context_tokens: 30_000,
      effective_context_window: 100_000,
      context_percent: 30,
      model: 'claude-opus'
    }
  }
}

function interactiveRuntimeWithContextGeneration(generation: number): ClaudeRuntimeSnapshot {
  return {
    ...interactiveRuntimeWithContext(),
    context_usage_snapshot: {
      context_tokens: 30_000,
      effective_context_window: 100_000,
      context_percent: 30,
      model: 'claude-opus',
      usage_generation: generation
    }
  }
}

function captureServerEventListeners(): Map<string, (payload: unknown) => void> {
  const listeners = new Map<string, (payload: unknown) => void>()
  const eventsOn = vi.fn((name: string, listener: (payload: unknown) => void) => {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  })
  window.agentsDock.events.on = eventsOn as AgentsDockAPI['events']['on']
  return listeners
}

function emitClaudeContextRuntimeChange(
  listeners: Map<string, (payload: unknown) => void>,
  usageGeneration: number
) {
  listeners.get('server:provider-runtime')?.({
    profileId: 'profile-1',
    profileGeneration: 3,
    event: {
      type: 'provider_runtime_changed',
      session_id: session.id,
      backend: 'claude',
      runtime: 'context_usage',
      ephemeral: true,
      usage_generation: usageGeneration
    }
  })
}

function ContextUsageErrorProbe() {
  const { contextUsageError } = useClaudeRuntime()
  return <output data-testid="claude-context-usage-error">{contextUsageError}</output>
}

function RuntimeRefreshProbe() {
  const { refresh, runtimeError } = useClaudeRuntime()
  return <>
    <button type="button" onClick={() => void refresh()}>Refresh Claude runtime</button>
    <output data-testid="claude-runtime-error">{runtimeError}</output>
  </>
}

function RuntimeStatusProbe() {
  return <output data-testid="claude-runtime-status">{useClaudeRuntime().runtime?.status?.type}</output>
}

function renderShelf(capability: unknown, selectedSession: Session = session) {
  return render(
    <ClaudeRuntimeProvider session={selectedSession} capability={capability}>
      <ClaudeInteractionShelf />
    </ClaudeRuntimeProvider>
  )
}
