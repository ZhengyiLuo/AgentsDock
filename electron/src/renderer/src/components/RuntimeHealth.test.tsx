import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, RuntimeCatalog, SessionSnapshot } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { RuntimeHealthNotice, RuntimeHealthPanel } from './RuntimeHealth'

afterEach(cleanup)

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
    } as unknown as AgentsDockAPI,
  })
  useAppStore.setState({ error: null })
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

  it('still warns when Claude is actually missing', () => {
    useAppStore.setState({ health: { ok: true, runtimes: { claude: {
      backend: 'claude', status: 'missing', installed: false, available: false,
      message: 'Claude Code is not installed.',
    } } }, runtimeCatalog: null, snapshots: {} })
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Claude Code is not installed.')).toBeInTheDocument()
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

    render(<RuntimeHealthNotice backend="cursor" sessionId="cursor-chat" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Cursor Unavailable')
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

    expect(screen.getByRole('alert')).toHaveTextContent('Cursor Unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent(/model choices are still loading/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent('Cursor is installed and authenticated.')
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
    render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)

    await user.click(screen.getByRole('button', { name: 'Recheck Codex CLI status' }))

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true)
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
    render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)

    const recheck = screen.getByRole('button', { name: 'Recheck Codex CLI status' })
    await user.click(recheck)

    await waitFor(() => expect(useAppStore.getState().error).toBe('CLI probe timed out'))
    expect(screen.getByText('Codex is not available.')).toBeInTheDocument()
    expect(recheck).toBeEnabled()

    await user.click(recheck)

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledTimes(2)
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
