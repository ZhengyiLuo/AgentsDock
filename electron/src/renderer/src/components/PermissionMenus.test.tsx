import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ClaudeRuntimeSnapshot, CodexRuntimeSnapshot, CursorPermissionMode, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ClaudePermissionMenu } from './ClaudePermissionMenu'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { CodexPermissionMenu } from './CodexPermissionMenu'
import { CodexRuntimeProvider } from './CodexRuntimeContext'
import { CursorPermissionMenu } from './CursorPermissionMenu'

const codexSession: Session = {
  id: 'codex-chat',
  title: 'Codex chat',
  backend: 'codex',
  codex_approval_policy: 'on-request',
  codex_sandbox_mode: 'workspace-write',
  codex_approvals_reviewer: 'user'
}

const claudeSession: Session = {
  id: 'claude-chat',
  title: 'Claude chat',
  backend: 'claude',
  claude_permission_mode: 'default'
}

const cursorSession: Session = {
  id: 'cursor-chat',
  title: 'Cursor chat',
  backend: 'cursor',
  cursor_permission_mode: 'default'
}

const codexRuntime: CodexRuntimeSnapshot = {
  available: true,
  transport: 'app_server',
  interactive_capability: 'codex_interactive_v1',
  thread_loaded: true,
  status: { type: 'idle' },
  goal: null,
  time_budget_seconds: null,
  pending_interactions: [],
  permission_profiles: [],
  policy: {
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    approvals_reviewer: 'user'
  },
  background_terminals_supported: true
}

const claudeRuntime: ClaudeRuntimeSnapshot = {
  available: true,
  transport: 'sdk',
  interactive_capability: 'claude_sdk_interactive_v1',
  persisted_session: true,
  session_loaded: true,
  status: { type: 'idle' },
  pending_interactions: [],
  policy: { permission_mode: 'default' },
  features: { permission_mode_control: true },
  permission_modes: ['default', 'acceptEdits', 'plan']
}

describe('controlled permission menus', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeProfileId: 'profile-1',
      profileGeneration: 1,
      connected: true,
      sessions: [codexSession, claudeSession, cursorSession],
      selectedSessionId: codexSession.id,
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is ready.',
            action: null,
            version: 2,
            permission_modes: ['default', 'full_access', 'plan']
          }
        }
      },
      runtimeCatalog: {
        backends: {
          cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('honors the controlled Codex open state and reports explicit close changes', async () => {
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        codex: {
          runtime: vi.fn().mockResolvedValue(codexRuntime),
          permissionProfiles: vi.fn().mockResolvedValue([])
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const view = render(codexMenu(false, onOpenChange))
    await screen.findByRole('button', { name: /Codex permissions: Workspace write/ })
    expect(screen.queryByRole('heading', { name: 'Codex permissions' })).not.toBeInTheDocument()

    view.rerender(codexMenu(true, onOpenChange))
    expect(await screen.findByRole('heading', { name: 'Codex permissions' })).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close Codex permissions' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    view.rerender(codexMenu(false, onOpenChange))
    expect(screen.queryByRole('heading', { name: 'Codex permissions' })).not.toBeInTheDocument()
  })

  it('honors the controlled Claude open state and reports explicit close changes', async () => {
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        claude: { runtime: vi.fn().mockResolvedValue(claudeRuntime) },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const view = render(claudeMenu(false, onOpenChange))
    await screen.findByRole('button', { name: 'Claude permissions: Ask for access' })
    onOpenChange.mockClear()
    expect(screen.queryByRole('heading', { name: 'Claude permissions' })).not.toBeInTheDocument()

    view.rerender(claudeMenu(true, onOpenChange))
    expect(await screen.findByRole('heading', { name: 'Claude permissions' })).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close Claude permissions' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    view.rerender(claudeMenu(false, onOpenChange))
    expect(screen.queryByRole('heading', { name: 'Claude permissions' })).not.toBeInTheDocument()
  })

  it('honors the controlled Cursor open state and reports explicit close changes', async () => {
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { events: { on: vi.fn().mockReturnValue(() => undefined) } } as unknown as AgentsDockAPI
    })
    const view = render(cursorMenu(false, onOpenChange, true))
    screen.getByRole('button', { name: 'Cursor permissions: Cursor defaults' })
    expect(screen.queryByRole('heading', { name: 'Cursor permissions' })).not.toBeInTheDocument()

    view.rerender(cursorMenu(true, onOpenChange, true))
    expect(await screen.findByRole('heading', { name: 'Cursor permissions' })).toBeVisible()
    expect(screen.getByLabelText('Permission mode')).toBeEnabled()
    expect(screen.getByText('This change applies to the next turn; the active turn keeps its current access.')).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Close Cursor permissions' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    view.rerender(cursorMenu(false, onOpenChange, true))
    expect(screen.queryByRole('heading', { name: 'Cursor permissions' })).not.toBeInTheDocument()
  })

  it('keeps Cursor permission controls unavailable without the explicit server contract', () => {
    useAppStore.setState({ health: { ok: true, capabilities: {} }, runtimeCatalog: null })

    render(cursorMenu(false, vi.fn()))

    const trigger = screen.getByRole('button', { name: 'Cursor permissions: Cursor defaults' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('title', expect.stringContaining('Cursor is unavailable'))
  })

  for (const backend of ['codex', 'claude'] as const) it(`closes the open shared ${backend} permission menu when access is lost`, async () => {
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      sharedChat: true,
      codex: { runtime: vi.fn().mockResolvedValue(codexRuntime), permissionProfiles: vi.fn().mockResolvedValue([]) },
      claude: { runtime: vi.fn().mockResolvedValue(claudeRuntime) },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI })
    render(backend === 'codex' ? codexMenu(true, vi.fn()) : claudeMenu(true, vi.fn()))
    const title = backend === 'codex' ? 'Codex permissions' : 'Claude permissions'
    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    act(() => { useAppStore.setState({ connected: false }) })
    expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`^${title}:`) })).toBeDisabled()
  })

  it('keeps the Claude permissions close button available during an active turn', async () => {
    const onOpenChange = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        claude: { runtime: vi.fn().mockResolvedValue(claudeRuntime) },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })

    render(<ClaudeRuntimeProvider session={claudeSession} capability={{
      available: true,
      interactive_client_capability: 'claude_sdk_interactive_v1'
    }}>
      <ClaudePermissionMenu session={claudeSession} running open onOpenChange={onOpenChange} />
    </ClaudeRuntimeProvider>)

    const close = await screen.findByRole('button', { name: 'Close Claude permissions' })
    expect(close).toBeEnabled()
    await userEvent.setup().click(close)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows only safe server-advertised Cursor permission modes', () => {
    useAppStore.setState(state => ({
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is ready.',
            action: null,
            version: 2,
            // auto_review remains a protocol value for compatibility, but the
            // desktop beta must not expose it until headless approval is bridged.
            permission_modes: ['default', 'auto_review', 'plan'] as unknown as CursorPermissionMode[]
          }
        }
      },
      runtimeCatalog: state.runtimeCatalog
    }))

    render(cursorMenu(true, vi.fn()))

    const select = screen.getByLabelText('Permission mode')
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Cursor defaults', 'Plan only'
    ])
    expect(within(select).queryByRole('option', { name: 'Auto-review' })).not.toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'Full access' })).not.toBeInTheDocument()
  })

  it('falls back to Cursor-configured permissions when permission modes are absent', () => {
    useAppStore.setState(state => ({
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is ready.',
            action: null,
            version: 2
          }
        }
      },
      runtimeCatalog: state.runtimeCatalog
    }))

    render(cursorMenu(true, vi.fn()))

    expect(screen.getByRole('button', { name: 'Cursor permissions: Cursor defaults' })).toBeEnabled()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Cursor defaults'])
    expect(screen.getByText(/Cursor’s configured permissions/)).toBeInTheDocument()
  })

  it('recovers a legacy auto-review session as the safe default instead of hiding the menu', () => {
    const legacySession = {
      ...cursorSession,
      cursor_permission_mode: 'auto_review'
    } as unknown as Session

    render(<CursorPermissionMenu session={legacySession} running={false} open onOpenChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Cursor permissions: Cursor defaults' })).toBeEnabled()
    expect(screen.getByLabelText('Permission mode')).toHaveValue('default')
    expect(screen.queryByRole('option', { name: /Auto-review/i })).not.toBeInTheDocument()
  })

  it('saves a new Cursor permission mode through the session-update queue', async () => {
    const update = vi.fn(async (_id: string, patch: Partial<Session>) => ({ ...cursorSession, ...patch }) as Session)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: { update },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    // Mirrors how Composer.tsx sources `session`: a live store subscription,
    // not a static prop - so the confirmed mode flows back in after saving,
    // same as the real app (a static prop would let the post-save resync
    // effect stomp the optimistic value with the stale prop).
    render(<ConnectedCursorMenu />)

    await user.selectOptions(screen.getByLabelText('Permission mode'), 'full_access')

    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('cursor-chat', { cursor_permission_mode: 'full_access' }))
    expect(await screen.findByRole('button', { name: 'Cursor permissions: Full access' })).toBeInTheDocument()
    expect(screen.getByText(/except operations explicitly denied by Cursor configuration/)).toBeInTheDocument()
  })
})

function codexMenu(open: boolean, onOpenChange: (open: boolean) => void) {
  return <CodexRuntimeProvider session={codexSession} capability={{ available: true }}>
    <CodexPermissionMenu session={codexSession} open={open} onOpenChange={onOpenChange} />
  </CodexRuntimeProvider>
}

function claudeMenu(open: boolean, onOpenChange: (open: boolean) => void) {
  return <ClaudeRuntimeProvider session={claudeSession} capability={{
    available: true,
    interactive_client_capability: 'claude_sdk_interactive_v1'
  }}>
    <ClaudePermissionMenu session={claudeSession} running={false} open={open} onOpenChange={onOpenChange} />
  </ClaudeRuntimeProvider>
}

function cursorMenu(open: boolean, onOpenChange: (open: boolean) => void, running = false) {
  return <CursorPermissionMenu session={cursorSession} running={running} open={open} onOpenChange={onOpenChange} />
}

function ConnectedCursorMenu() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === 'cursor-chat')!)
  return <CursorPermissionMenu session={session} running={false} open onOpenChange={() => undefined} />
}
