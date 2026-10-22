import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, RuntimeCatalog, SessionSnapshot } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { RuntimeHealthNotice, RuntimeHealthPanel } from './RuntimeHealth'

afterEach(cleanup)

it('labels a Gemini API error as Gemini, not Codex', () => {
  useAppStore.setState({ health: null, runtimeCatalog: null, snapshots: {}, sessions: [] })
  render(<RuntimeHealthNotice backend="gemini" codexProvider="custom" sessionId="gemini-test" admissionError="API test failed" />)
  expect(screen.getByText('Gemini')).toBeTruthy()
  expect(screen.queryByText(/Codex runtime/)).toBeNull()
})

const readyCatalog: RuntimeCatalog = {
  generated_at: '2026-07-30T20:01:00Z',
  backends: {
    claude: {
      models: [{ value: 'sonnet', label: 'Sonnet' }],
      efforts: [],
      diagnostic: {
        backend: 'claude',
        status: 'ready',
        available: true,
        installed: true,
        authenticated: true,
        message: 'Claude Code is installed and authenticated.',
        checked_at: '2026-07-30T20:01:00Z',
      },
    },
    codex: {
      models: [{ value: 'gpt-5.6', label: 'GPT-5.6' }],
      efforts: [],
      diagnostic: {
        backend: 'codex',
        status: 'ready',
        available: true,
        installed: true,
        authenticated: true,
        message: 'Codex is installed and authenticated.',
        checked_at: '2026-07-30T20:01:00Z',
      },
    },
  },
}

beforeEach(() => {
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      runtime: { catalog: vi.fn().mockResolvedValue(readyCatalog) },
      native: { writeClipboard: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AgentsDockAPI,
  })
  useAppStore.setState({ error: null })
})

it('copies the complete error and command, including text beyond the old 520-character cutoff', async () => {
  const message = 'Long diagnostic. '.repeat(50) + 'Run `codex unarchive example-thread` to unarchive it first.'
  useAppStore.setState({ health: null, runtimeCatalog: null, snapshots: {}, sessions: [] })
  const { rerender } = render(<RuntimeHealthNotice backend="codex" sessionId="copy-test" admissionError={message} />)
  expect(screen.getByText(message)).toHaveClass('runtime-detail')
  await userEvent.click(screen.getByRole('button', { name: 'Copy error details' }))
  expect(window.agentsDock.native.writeClipboard).toHaveBeenCalledWith(message)
  expect(screen.getByRole('button', { name: 'Error details copied' })).toBeInTheDocument()
  rerender(<RuntimeHealthNotice backend="codex" sessionId="copy-test" admissionError="Another error" />)
  expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument()
})

it('copies an entire timeline error and reports clipboard failure without executing it', async () => {
  const message = 'Diagnostic '.repeat(70) + 'codex unarchive test-thread'
  useAppStore.setState({ health: null, runtimeCatalog: null, sessions: [], snapshots: {
    copy: { session: { id: 'copy', title: 'Copy', backend: 'codex' }, events: [
      { id: 'error', seq: 1, type: 'error', backend: 'codex', message, run_id: 'r', session_id: 'copy', ts: '' },
      { id: 'finished', seq: 2, type: 'turn_finished', backend: 'codex', is_error: true, run_id: 'r', session_id: 'copy', ts: '' }
    ], queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0 }
  } })
  vi.mocked(window.agentsDock.native.writeClipboard).mockRejectedValue(new Error('unavailable'))
  render(<RuntimeHealthNotice backend="codex" sessionId="copy" />)
  expect(screen.getByText(message)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Copy error details' }))
  expect(window.agentsDock.native.writeClipboard).toHaveBeenCalledWith(message)
  expect(useAppStore.getState().error).toMatch(/Select the error text/)
})

it('offers Configure API for an old Gemini CLI chat instead of a login recheck', () => {
  useAppStore.setState({ health: null, runtimeCatalog: null, snapshots: {}, sessions: [] })
  render(<RuntimeHealthNotice backend="gemini" sessionId="legacy" admissionError="API connections only" />)
  expect(screen.getByRole('button', { name: 'Configure API' })).toBeInTheDocument()
  expect(screen.queryByText('Recheck')).not.toBeInTheDocument()
})

it('opens the relevant provider settings from a missing custom API without rechecking CLI', async () => {
  useAppStore.setState({ health: null, runtimeCatalog: readyCatalog, snapshots: {}, sessions: [],
    modals: { ...useAppStore.getState().modals, appSettings: false } })
  const listener = vi.fn()
  window.addEventListener('agentsdock:app-settings-section', listener)
  try {
    render(<RuntimeHealthNotice backend="claude" codexProvider="custom" sessionId="missing" admissionError="Configure your API endpoint" />)
    await userEvent.click(screen.getByRole('button', { name: 'Configure API' }))
    expect(listener.mock.calls[0][0].detail).toEqual({ section: 'providers', backend: 'claude' })
    expect(useAppStore.getState().modals.appSettings).toBe(true)
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  } finally { window.removeEventListener('agentsdock:app-settings-section', listener) }
})

describe('passive Claude authentication in the composer', () => {
  const message = 'Claude Code is installed. Authentication will be checked by Claude when you send a message.'
  const failure = 'Not logged in. Please run claude auth login and retry your message.'
  const snapshot = (events: Event[] = []): SessionSnapshot => ({
    session: { id: 'claude-chat', title: 'Chat', backend: 'claude' },
    events, queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
  })
  const event = (type: string, run: string, seq: number, text?: string): Event => ({
    id: `event-${seq}`, seq, session_id: 'claude-chat', backend: 'claude',
    type, run_id: run, ts: '2026-09-25T20:00:00Z', message: text,
  })
  const setup = (status: 'unknown' | 'unauthenticated', events: Event[] = []) => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: { backends: { claude: {
        models: [{ value: 'sonnet', label: 'Sonnet' }], efforts: [], available: false,
        diagnostic: {
          backend: 'claude', status, installed: true, available: false,
          authenticated: status === 'unknown' ? null : false,
          message: status === 'unknown' ? message : failure,
          action: status === 'unknown' ? null : 'Run claude auth login, then retry your message.',
        },
      } } },
      snapshots: { 'claude-chat': snapshot(events) },
    })
  }

  it.each(['unknown', 'unauthenticated'] as const)('does not warn before this chat sends when backend auth is %s', status => {
    setup(status)
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('stays quiet after a successful reply while the client still has unknown readiness', () => {
    setup('unknown', [event('assistant_message', 'run-1', 1, 'Hello!'), event('turn_finished', 'run-1', 2)])
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an actual authentication failure from this chat without blocking a native retry', () => {
    setup('unauthenticated', [event('error', 'run-1', 1, failure)])
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Latest chat error')).toBeInTheDocument()
    expect(screen.getByText(failure)).toBeInTheDocument()
    expect(screen.getByText('Run claude auth login, then retry your message.')).toBeInTheDocument()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('clears the warning after a successful retry even if cached authentication is stale', () => {
    setup('unauthenticated', [event('error', 'run-1', 1, failure), event('turn_finished', 'run-2', 2)])
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not hide a real send error while readiness is unknown', () => {
    setup('unknown', [event('error', 'run-1', 1, 'Request timed out.')])
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Request timed out.')).toBeInTheDocument()
    expect(screen.queryByText(/Run claude auth login/)).not.toBeInTheDocument()
  })

  it('keeps the passive status available in Settings', () => {
    setup('unknown')
    render(<RuntimeHealthPanel />)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recheck CLIs' })).toBeEnabled()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('does not warn from cached missing status before a send', () => {
    useAppStore.setState({ health: { ok: true, runtimes: { claude: {
      backend: 'claude', status: 'missing', installed: false, available: false,
      message: 'Claude Code is not installed.',
    } } }, runtimeCatalog: null, snapshots: {} })
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.queryByText('Claude Code is not installed.')).not.toBeInTheDocument()
  })
})

describe('latest chat error ownership', () => {
  const oldError = 'stream disconnected: An error occurred while processing the request.'
  const latestError = 'The latest provider request failed.'
  const event = (type: string, run: string | null, seq: number, extra: Partial<Event> = {}): Event => ({
    id: `event-${seq}`, seq, session_id: 'chat', backend: 'codex',
    type, run_id: run, ts: '2026-10-01T03:44:38Z', ...extra,
  })
  const setup = (events: Event[]) => {
    useAppStore.setState({ health: null, runtimeCatalog: readyCatalog, sessions: [], snapshots: {
      chat: { session: { id: 'chat', title: 'Chat', backend: 'codex' }, events,
        queuedTurns: [], files: [], hasMoreEvents: true, filesTotal: 0, cachedAt: 0 },
    } })
  }
  const failedRun = [
    event('turn_started', 'old-run', 1),
    event('error', 'old-run', 2, { message: oldError }),
    event('turn_finished', 'old-run', 3, { exit_code: 1, is_error: true }),
  ]

  it('does not revive an old failure when subagent snapshots arrive after a successful reply', () => {
    setup([
      ...failedRun,
      event('turn_started', 'latest-run', 4),
      event('assistant_text', 'latest-run', 5, { text: 'The requested work is complete.' }),
      event('turn_finished', 'latest-run', 6, { exit_code: 0 }),
      event('subagent_state', 'old-run', 7, { subagent_id: 'child', subagent_status: 'completed' }),
      event('subagent_state', 'old-run', 8, { subagent_id: 'child', subagent_status: 'completed' }),
    ])
    const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['subagent_state', 'codex_goal_updated', 'codex_token_usage', 'raw_event'])(
    'ignores late %s attribution when selecting a run from a bounded history window', type => {
      setup([...failedRun, event('turn_finished', 'latest-run', 4, { exit_code: 0 }),
        event(type, 'old-run', 5, { error: 'Background diagnostic' })])
      const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
      expect(container).toBeEmptyDOMElement()
    },
  )

  it('keeps the latest failure visible despite late snapshots from a different successful run', () => {
    setup([event('turn_finished', 'old-run', 1, { exit_code: 0 }),
      event('error', 'latest-run', 2, { message: latestError }),
      event('turn_finished', 'latest-run', 3, { exit_code: 1, is_error: true }),
      event('subagent_state', 'old-run', 4, { subagent_id: 'child' })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it('does not let imported lifecycle records clear a current failure', () => {
    setup([event('error', 'latest-run', 1, { message: latestError }),
      event('turn_started', 'import_history', 2, { imported: true }),
      event('turn_finished', 'import_history', 3, { imported: true, exit_code: 0 })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it('does not revive imported errors after a successful current run', () => {
    setup([event('turn_finished', 'latest-run', 1, { exit_code: 0 }),
      event('error', 'import_history', 2, { imported: true, message: oldError })])
    const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('filters child errors from both owner selection and the current run detail', () => {
    setup([event('turn_finished', 'latest-run', 1, { exit_code: 0 }),
      event('error', 'latest-run', 2, { subagent_id: 'child', message: 'Child failed' })])
    const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['subagent_state', 'codex_goal_updated', 'codex_token_usage'])(
    'does not treat a current-run %s diagnostic as a primary turn error', type => {
      setup([event('turn_finished', 'latest-run', 1, { exit_code: 0 }),
        event(type, 'latest-run', 2, { error: 'Background diagnostic' })])
      const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
      expect(container).toBeEmptyDOMElement()
    },
  )

  it('preserves artifact failures belonging to the latest foreground run', () => {
    setup([event('turn_started', 'latest-run', 1),
      event('artifact_error', 'latest-run', 2, { error: 'Artifact manifest is invalid.' }),
      event('turn_finished', 'latest-run', 3, { exit_code: 0 })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText('Artifact manifest is invalid.')).toBeInTheDocument()
  })

  it('does not let an old-run artifact error replace the latest foreground failure', () => {
    setup([event('error', 'latest-run', 1, { message: latestError }),
      event('turn_finished', 'latest-run', 2, { exit_code: 1, is_error: true }),
      event('artifact_error', 'old-run', 3, { error: 'Old artifact failed.' })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it.each(['codex_review_started', 'codex_review_finished', 'codex_shell_started', 'codex_shell_finished'])(
    'recognizes %s as a newer foreground lifecycle boundary', type => {
      setup([...failedRun, event(type, 'latest-run', 4)])
      const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
      expect(container).toBeEmptyDOMElement()
    },
  )

  it('keeps a current failure when the goal becomes paused', () => {
    setup([event('error', 'latest-run', 1, { message: latestError }),
      event('turn_finished', 'latest-run', 2, { exit_code: 1, is_error: true }),
      event('codex_goal_updated', null, 3, { message: 'Goal paused' })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it('clears the previous failure when a new turn starts', () => {
    setup([...failedRun, event('turn_started', 'latest-run', 4)])
    const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('preserves error-only startup failures and ignores another backend', () => {
    setup([event('error', 'latest-run', 1, { backend: undefined, message: latestError }),
      event('turn_finished', 'claude-run', 2, { backend: 'claude', exit_code: 0 }),
      event('error', 'latest-run', 3, { backend: 'claude', message: 'Other backend failed' })])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it('keeps newer runless failures but ignores empty error markers', () => {
    setup([event('turn_finished', 'latest-run', 1, { exit_code: 0 }),
      event('error', null, 2, { message: latestError }), event('error', null, 3)])
    render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(screen.getByText(latestError)).toBeInTheDocument()
  })

  it('does not resurrect a runless error across a successful lifecycle boundary', () => {
    setup([event('error', null, 1, { message: oldError }),
      event('turn_finished', 'latest-run', 2, { exit_code: 0 })])
    const { container } = render(<RuntimeHealthNotice backend="codex" sessionId="chat" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('RuntimeHealthPanel tmux prerequisite', () => {
  it('shows a missing tmux capability with actionable installation guidance', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          tmux: {
            available: false,
            required: true,
            message: 'tmux is missing; terminal sessions and detached updates are unavailable.',
            action: 'Install tmux, then restart AgentsServer.'
          }
        }
      },
      runtimeCatalog: null
    })

    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByText('tmux is missing; terminal sessions and detached updates are unavailable.')).toBeInTheDocument()
    expect(screen.getByText('Install tmux, then restart AgentsServer.')).toHaveClass('runtime-action')
  })

  it('shows tmux as ready when the server reports it available', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          tmux: { available: true, required: true, message: 'tmux is available.', action: null }
        }
      },
      runtimeCatalog: null
    })

    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('tmux is available.')).toBeInTheDocument()
  })

  it('keeps older servers without capability data in an unknown state', () => {
    useAppStore.setState({ health: { ok: true }, runtimeCatalog: null })

    const { container } = render(<RuntimeHealthPanel />)

    expect(screen.getByText('Not reported')).toBeInTheDocument()
    expect(screen.getByText('This AgentsServer version has not reported tmux readiness.')).toBeInTheDocument()
    expect(container.querySelector('.runtime-health-row.unknown')).toBeInTheDocument()
    expect(container.querySelector('.runtime-health-row.unknown')).not.toHaveClass('warning', 'error')
  })

  it('does not advertise Cursor in Settings on a legacy server', () => {
    useAppStore.setState({
      health: { ok: true },
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          cursor: {
            available: true,
            models: [{ value: 'auto', label: 'Auto' }],
            efforts: []
          }
        }
      }
    })

    render(<RuntimeHealthPanel />)

    expect(screen.queryByText('Cursor')).not.toBeInTheDocument()
  })

  it('keeps an existing Cursor chat readable with an explicit legacy-server diagnostic', () => {
    useAppStore.setState({
      health: { ok: true },
      runtimeCatalog: readyCatalog,
      snapshots: {}
    })

    render(<RuntimeHealthNotice backend="cursor" sessionId="cursor-chat" admissionError="Cursor is unavailable because this AgentsServer does not support it yet. Update the server, then reconnect." />)

    expect(screen.getByRole('alert')).toHaveTextContent('Cursor Check failed')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cursor is unavailable because this AgentsServer does not support it yet. Update the server, then reconnect.'
    )
  })

  it('shows catalog loading instead of contradictory setup guidance for ready Cursor health', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor backend is supported.',
            action: null,
            version: 2,
          }
        },
        runtimes: {
          cursor: {
            backend: 'cursor',
            status: 'ready',
            available: true,
            installed: true,
            authenticated: true,
            message: 'Cursor is installed and authenticated.',
            checked_at: '2026-07-30T20:02:00Z',
          }
        }
      },
      runtimeCatalog: null,
      snapshots: {}
    })

    render(<RuntimeHealthNotice backend="cursor" sessionId="cursor-chat" />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('forces a fresh CLI probe and applies its returned diagnostics immediately', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true)
    await waitFor(() => expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument())
    expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument()
  })

  it('lets a user recheck an unavailable CLI directly from the composer warning', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
      snapshots: {},
    })
    const user = userEvent.setup()
    const { rerender } = render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" admissionError="Codex is not available." />)

    await user.click(screen.getByRole('button', { name: 'Recheck Codex CLI status' }))

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true)
    rerender(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)
    await waitFor(() => expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Recheck Codex CLI status' })).not.toBeInTheDocument()
  })

  it('keeps the warning actionable when a CLI recheck fails and allows retry', async () => {
    vi.mocked(window.agentsDock.runtime.catalog)
      .mockRejectedValueOnce(new Error('CLI probe timed out'))
      .mockResolvedValueOnce(readyCatalog)
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
      snapshots: {},
    })
    const user = userEvent.setup()
    const { rerender } = render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" admissionError="Codex is not available." />)

    const recheck = screen.getByRole('button', { name: 'Recheck Codex CLI status' })
    await user.click(recheck)

    await waitFor(() => expect(useAppStore.getState().error).toBe('CLI probe timed out'))
    expect(screen.getByText('Codex is not available.')).toBeInTheDocument()
    expect(recheck).toBeEnabled()

    await user.click(recheck)

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledTimes(2)
    rerender(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)
    await waitFor(() => expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument())
    expect(useAppStore.getState().error).toBeNull()
  })

  it('shows a current provider failure in Settings and clears it after rechecking', async () => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          codex: {
            ...readyCatalog.backends.codex,
            diagnostic: {
              ...readyCatalog.backends.codex.diagnostic!,
              checked_at: '2026-07-30T20:00:00Z',
              last_error: 'Codex failed before launching.',
              last_error_at: '2026-07-30T20:00:30Z',
            },
          },
        },
      },
      snapshots: {},
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Codex failed before launching.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    await waitFor(() => expect(screen.queryByText('Codex failed before launching.')).not.toBeInTheDocument())
  })

  it('does not display an older provider error after a newer successful probe', () => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          codex: {
            ...readyCatalog.backends.codex,
            diagnostic: {
              ...readyCatalog.backends.codex.diagnostic!,
              checked_at: '2026-07-30T20:02:00Z',
              last_error: 'This failure is stale.',
              last_error_at: '2026-07-30T20:01:00Z',
            },
          },
        },
      },
    })

    render(<RuntimeHealthPanel />)

    expect(screen.queryByText('This failure is stale.')).not.toBeInTheDocument()
    expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument()
  })

  it('causally clears an equal-second provider error after a successful explicit recheck', async () => {
    const checkedAt = '2026-07-30T20:01:00Z'
    const equalSecondCatalog: RuntimeCatalog = {
      ...readyCatalog,
      generated_at: checkedAt,
      backends: {
        ...readyCatalog.backends,
        codex: {
          ...readyCatalog.backends.codex,
          diagnostic: {
            ...readyCatalog.backends.codex.diagnostic!,
            checked_at: checkedAt,
            last_error: 'Codex failed in the same timestamp second.',
            last_error_at: checkedAt,
          },
        },
      },
    }
    vi.mocked(window.agentsDock.runtime.catalog).mockResolvedValueOnce(equalSecondCatalog)
    useAppStore.setState({
      health: null,
      runtimeCatalog: equalSecondCatalog,
      error: 'Previous recheck failed',
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Codex failed in the same timestamp second.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    await waitFor(() => expect(screen.queryByText('Codex failed in the same timestamp second.')).not.toBeInTheDocument())
    expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument()
    expect(useAppStore.getState().runtimeCatalog?.backends.codex.diagnostic?.last_error).toBeNull()
    expect(useAppStore.getState().error).toBeNull()
  })
})
