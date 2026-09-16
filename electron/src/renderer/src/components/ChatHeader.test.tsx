import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { RUNNING_FORK_DESCRIPTION, RUNNING_FORK_UNAVAILABLE } from '@shared/session-fork'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'
import { CodexRuntimeProvider } from './CodexRuntimeContext'

const originalAcknowledgeEmergency = useAppStore.getState().acknowledgeEmergency
const originalUpdateSession = useAppStore.getState().updateSession
const originalForkSession = useAppStore.getState().forkSession
const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('ChatHeader', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState({ updateSession: originalUpdateSession, forkSession: originalForkSession })
  })

  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: false,
      health: null,
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      connectionError: 'Server unavailable',
      syncSessionId: null,
      syncStatus: 'idle',
      syncError: null,
      syncBySession: {},
      sessions: [],
      selectedSessionId: null,
      acknowledgeEmergency: originalAcknowledgeEmergency,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false,
        importChats: false
      }
    })
  })

  it('toggles the docked terminal without replacing the chat workspace', async () => {
    const toggle = vi.fn()
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex' }],
      selectedSessionId: 'chat'
    })
    render(<ChatHeader terminalOpen={false} onTerminalToggle={toggle} />)

    const button = screen.getByRole('button', { name: 'Open terminal panel' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.setup().click(button)
    expect(toggle).toHaveBeenCalledOnce()
    expect(screen.queryByRole('navigation', { name: 'Chat workspace' })).not.toBeInTheDocument()
  })

  it('shows the chat-list restore control only while the sidebar is collapsed', () => {
    const toggle = vi.fn()
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex' }],
      selectedSessionId: 'chat'
    })
    const view = render(<ChatHeader sidebarVisible={false} onSidebarToggle={toggle} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show chat list' }))
    expect(toggle).toHaveBeenCalledOnce()

    view.rerender(<ChatHeader sidebarVisible onSidebarToggle={toggle} />)
    expect(screen.queryByRole('button', { name: 'Show chat list' })).not.toBeInTheDocument()
  })

  it('places chat actions first in the header icon group', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex' }],
      selectedSessionId: 'chat'
    })
    const { container } = render(<ChatHeader sidebarVisible={false} onSidebarToggle={() => undefined} onTerminalToggle={() => undefined} />)

    expect(container.querySelector('.header-actions > :first-child')).toBe(screen.getByRole('button', { name: 'Chat actions' }))
    expect(screen.getByRole('button', { name: 'Show chat list' })).toBeInTheDocument()
  })

  it('opens side chat for the displayed pane in one click without mounting a dialog', async () => {
    const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
    const displayed = { id: 'other', title: 'Other', backend: 'claude' as const }
    useAppStore.setState({ sessions: [session, displayed], selectedSessionId: session.id, activeProfileId: 'profile', profileGeneration: 7 })
    const open = vi.fn()
    window.addEventListener('agentsdock:open-side-chat', open)
    try {
      render(<ChatHeader session={displayed} focused={false} />)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Side chat' }))
      expect(open).toHaveBeenCalledOnce()
      expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: displayed.id, profileId: 'profile', profileGeneration: 7 })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally {
      window.removeEventListener('agentsdock:open-side-chat', open)
    }
  })

  it.each(['cursor', 'shared-guest'] as const)('omits the side-question entry for %s', kind => {
    const session = { id: 'chat', title: 'Chat', backend: kind === 'cursor' ? 'cursor' as const : 'claude' as const }
    if (kind === 'shared-guest') Object.defineProperty(window.agentsDock, 'sharedChat', { value: true })
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id })
    render(<ChatHeader />)
    expect(screen.queryByRole('button', { name: 'Side chat' })).not.toBeInTheDocument()
  })

  it.each(['running', 'admitting'] as const)('forks a %s chat through its completed prefix on a capable server', async state => {
    const forkSession = vi.fn().mockResolvedValue(undefined)
    const session = { id: 'chat', title: 'Chat', backend: 'claude' as const }
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      activeSessionIds: new Set(state === 'running' ? [session.id] : []),
      turnAdmissionTokens: state === 'admitting' ? { [session.id]: 'pending-turn' } : {},
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: ['claude']
      } } },
      forkSession
    })
    const user = userEvent.setup()
    render(<ChatHeader />)
    await user.click(screen.getByRole('button', { name: 'Chat actions' }))

    const fork = screen.getByRole('menuitem', { name: 'Fork chat' })
    expect(fork).not.toHaveAttribute('aria-disabled', 'true')
    expect(fork).toHaveAttribute('title', RUNNING_FORK_DESCRIPTION)
    await user.click(fork)
    expect(forkSession).toHaveBeenCalledOnce()
    expect(forkSession).toHaveBeenCalledWith(session.id)
  })

  it.each(['running', 'admitting'] as const)('blocks a %s chat fork on an older server', async state => {
    const forkSession = vi.fn().mockResolvedValue(undefined)
    const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      activeSessionIds: new Set(state === 'running' ? [session.id] : []),
      turnAdmissionTokens: state === 'admitting' ? { [session.id]: 'pending-turn' } : {},
      health: { ok: true },
      forkSession
    })
    const user = userEvent.setup()
    render(<ChatHeader />)
    await user.click(screen.getByRole('button', { name: 'Chat actions' }))

    const fork = screen.getByRole('menuitem', { name: 'Fork chat' })
    expect(fork).toHaveAttribute('aria-disabled', 'true')
    expect(fork).toHaveAttribute('title', RUNNING_FORK_UNAVAILABLE)
    await user.click(fork)
    expect(forkSession).not.toHaveBeenCalled()
  })

  it('uses the displayed pane backend when checking live fork support', async () => {
    const selected = { id: 'selected', title: 'Selected', backend: 'codex' as const }
    const displayed = { id: 'displayed', title: 'Displayed', backend: 'claude' as const }
    useAppStore.setState({
      sessions: [selected, displayed],
      selectedSessionId: selected.id,
      activeSessionIds: new Set([displayed.id]),
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: ['codex']
      } } }
    })
    render(<ChatHeader session={displayed} focused={false} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Chat actions' }))

    const fork = screen.getByRole('menuitem', { name: 'Fork chat' })
    expect(fork).toHaveAttribute('aria-disabled', 'true')
    expect(fork).toHaveAttribute('title', RUNNING_FORK_UNAVAILABLE)
  })

  it('keeps an idle chat fork available without the live fork capability', async () => {
    const forkSession = vi.fn().mockResolvedValue(undefined)
    const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id, forkSession })
    const user = userEvent.setup()
    render(<ChatHeader />)
    await user.click(screen.getByRole('button', { name: 'Chat actions' }))

    const fork = screen.getByRole('menuitem', { name: 'Fork chat' })
    expect(fork).not.toHaveAttribute('aria-disabled', 'true')
    expect(fork).not.toHaveAttribute('title')
    await user.click(fork)
    expect(forkSession).toHaveBeenCalledWith(session.id)
  })

  it('shows the organizational folder beside the title instead of the working directory', () => {
    const session = { id: 'chat', title: 'Chat', folder: 'Research', cwd: '/work/not-the-folder', backend: 'codex' as const }
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id })

    render(<ChatHeader />)

    expect(screen.getByLabelText('Folder: Research')).toHaveTextContent('Research')
    expect(screen.queryByText('/work/not-the-folder')).not.toBeInTheDocument()
  })

  it('labels an unfiled chat as General', () => {
    const session = { id: 'chat', title: 'Chat', folder: '  ', backend: 'codex' as const }
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id })

    render(<ChatHeader />)

    expect(screen.getByLabelText('Folder: General')).toHaveTextContent('General')
  })

  it('keeps context usage out of the header now that it lives in the composer', () => {
    const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined)
        },
        codex: {
          runtime: vi.fn().mockResolvedValue({
            available: true,
            transport: 'app_server',
            interactive_capability: 'codex_interactive_v1',
            thread_loaded: true,
            status: { type: 'idle' },
            goal: null,
            time_budget_seconds: null,
            pending_interactions: [],
            permission_profiles: [],
            background_terminals_supported: true,
            token_usage_snapshot: { context_tokens: 50_000, context_window: 100_000, context_percent: 50 }
          })
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id })

    const { container } = render(
      <CodexRuntimeProvider session={session} capability={{ available: true }}>
        <ChatHeader />
      </CodexRuntimeProvider>
    )

    expect(screen.getByRole('button', { name: /Codex controls:/ })).toBeInTheDocument()
    expect(container.querySelector('.codex-context-indicator')).toBeNull()
  })

  it('keeps the running status visible for Codex without the controls capability', () => {
    const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      activeSessionIds: new Set([session.id])
    })

    render(<ChatHeader />)

    expect(screen.getByRole('status', { name: 'Codex Running' })).toHaveTextContent('CodexRunning')
    expect(screen.queryByRole('button', { name: /Codex controls:/ })).not.toBeInTheDocument()
  })

  it('shows the same running status for Claude', () => {
    const session = { id: 'chat', title: 'Chat', backend: 'claude' as const }
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      activeSessionIds: new Set([session.id])
    })

    render(<ChatHeader />)

    expect(screen.getByRole('status', { name: 'Claude Running' })).toHaveTextContent('ClaudeRunning')
  })

  it('does not fabricate a lifecycle status for an idle Claude chat', () => {
    const session = { id: 'chat', title: 'Chat', backend: 'claude' as const }
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id })

    render(<ChatHeader />)

    expect(screen.queryByRole('status', { name: 'Claude Running' })).not.toBeInTheDocument()
  })

  it('shows Syncing from the displayed pane without leaking the focused pane status', () => {
    const selected = { id: 'selected', title: 'Selected', backend: 'codex' as const }
    const displayed = { id: 'displayed', title: 'Displayed', backend: 'claude' as const }
    useAppStore.setState({
      connected: true,
      sessions: [selected, displayed],
      selectedSessionId: selected.id,
      syncSessionId: selected.id,
      syncStatus: 'live',
      syncBySession: {
        [selected.id]: { status: 'live', error: null },
        [displayed.id]: { status: 'syncing', error: null }
      }
    })

    render(<ChatHeader session={displayed} focused={false} />)
    expect(screen.getByRole('status', { name: 'Syncing' })).toBeInTheDocument()

    act(() => useAppStore.setState({
      syncStatus: 'syncing',
      syncBySession: {
        [selected.id]: { status: 'syncing', error: null },
        [displayed.id]: { status: 'live', error: null }
      }
    }))
    expect(screen.queryByRole('status', { name: 'Syncing' })).not.toBeInTheDocument()
  })

  it('moves a chat from its folder label and keeps that action out of the chat menu', async () => {
    const primary = { id: 'chat-1', title: 'Primary', backend: 'codex' as const, folder: 'General' }
    const candidate = { id: 'chat-2', title: 'Research chat', backend: 'claude' as const, folder: 'Research' }
    const updateSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      sessions: [primary, candidate],
      selectedSessionId: primary.id,
      folderOrder: ['General', 'Research'],
      updateSession
    })
    const user = userEvent.setup()
    render(<ChatHeader session={primary} onOpenSplit={() => undefined} />)

    await user.click(screen.getByRole('button', { name: 'Folder: General' }))
    expect(screen.getByText('Move to folder')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Research' }))

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith(primary.id, { folder: 'Research', archived: false }))

    await user.click(screen.getByRole('button', { name: 'Chat actions' }))

    const menu = screen.getByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Open split view' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move to folder' })).not.toBeInTheDocument()
    expect(menu.querySelectorAll('.menu-separator')).toHaveLength(3)
  })

  it('keeps split-chat selection available to the slash command and opens it only for the addressed chat', async () => {
    const primary = { id: 'chat-1', title: 'Primary', backend: 'codex' as const }
    const candidate = { id: 'chat-2', title: 'Pairing chat', backend: 'claude' as const }
    const openSplit = vi.fn()
    useAppStore.setState({
      sessions: [primary, candidate],
      selectedSessionId: primary.id,
      chatPanes: { primary: primary.id, secondary: null },
      focusedChatPane: 'primary'
    })
    render(<ChatHeader session={primary} onOpenSplit={openSplit} />)
    expect(screen.queryByRole('button', { name: 'Open split chat' })).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-split-chat-menu', {
        detail: { sessionId: 'another-chat' }
      }))
    })
    expect(screen.queryByText('Open beside Primary')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-split-chat-menu', {
        detail: { sessionId: primary.id }
      }))
    })
    const splitView = await screen.findByRole('menuitem', { name: 'Open split view' })
    expect(splitView).toBeVisible()
    await userEvent.setup().click(splitView)
    expect(await screen.findByText('Open beside Primary')).toBeVisible()

    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Pairing chatClaude' }))
    expect(openSplit).toHaveBeenCalledOnce()
    expect(openSplit).toHaveBeenCalledWith(candidate.id)
  })

  it('copies the full session id from the header', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined)
    ;(window.agentsDock as unknown as { native: { writeClipboard: typeof writeClipboard } }).native = { writeClipboard }
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex', session_id: '01a04c9e-7ac-full-value' }],
      selectedSessionId: 'chat'
    })
    render(<ChatHeader />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy session' }))

    expect(writeClipboard).toHaveBeenCalledWith('01a04c9e-7ac-full-value')
    expect(await screen.findByRole('button', { name: 'Session copied' })).toBeInTheDocument()
  })

  it('sizes the rename field to its title instead of filling the header', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Mac app', backend: 'codex' }],
      selectedSessionId: 'chat'
    })
    render(<ChatHeader />)

    const input = screen.getByRole('textbox', { name: 'Rename Mac app' })
    expect(input).toHaveAttribute('size', '7')

    const longerTitle = 'A somewhat longer title'
    fireEvent.change(input, { target: { value: longerTitle } })
    expect(input).toHaveAttribute('size', String(Array.from(longerTitle).length))
    expect(styles).toMatch(
      /\.editable-title input \{[^}]*min-width: 4ch;[^}]*max-width: min\(100%, 700px\);[^}]*width: auto;[^}]*field-sizing: content;[^}]*\}/s
    )
  })

  it('keeps emergency acknowledgement out of the fixed chat header', () => {
    const emergencySession = {
      id: 'chat',
      title: 'Production watch',
      backend: 'codex' as const,
      emergency_alert: {
        id: 'alert-1',
        status: 'active' as const,
        severity: 'critical' as const,
        message: 'The deployment rollback needs approval.',
        raised_at: '2026-08-25T12:00:00Z'
      }
    }
    useAppStore.setState({
      sessions: [emergencySession],
      selectedSessionId: emergencySession.id
    })

    const { container } = render(<ChatHeader />)

    expect(container.querySelector('.chat-header')).not.toHaveClass('emergency-active')
    expect(container.querySelector('.emergency-banner')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Acknowledge emergency in Production watch' })).not.toBeInTheDocument()
  })
})
