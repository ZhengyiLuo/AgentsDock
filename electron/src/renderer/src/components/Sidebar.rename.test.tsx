import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session } from '@shared/types'
import { RUNNING_FORK_DESCRIPTION, RUNNING_FORK_UNAVAILABLE } from '@shared/session-fork'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { RenameChatDialog } from './Dialogs'
import { Sidebar } from './Sidebar'

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Studio',
  serverUrl: 'https://studio.example:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const session: Session = {
  id: 'chat-1',
  title: 'Original chat',
  folder: 'General',
  backend: 'codex'
}

describe('sidebar chat rename', () => {
  beforeEach(() => {
    resetTransientCloseStackForTests()
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({ ...session, ...patch }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockResolvedValue(0),
          set: vi.fn().mockResolvedValue(undefined)
        },
      sessions: { update }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 1,
      switchingProfileId: null,
      connected: true,
      sessions: [session],
      selectedSessionId: session.id,
      folderOrder: ['General'],
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      activeSessionIds: new Set(),
      runtimeCatalog: null,
      health: null,
      error: null
    })
  })

  it.each([false, true])('gates running Fork Chat on completed-prefix support=%s', async supported => {
    useAppStore.setState({
      activeSessionIds: new Set([session.id]),
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: supported ? ['codex'] : ['claude']
      } } }
    })
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    const fork = await screen.findByRole('menuitem', { name: 'Fork Chat' })

    if (supported) expect(fork).not.toHaveAttribute('data-disabled')
    else expect(fork).toHaveAttribute('data-disabled')
    expect(fork).toHaveAttribute('title', supported ? RUNNING_FORK_DESCRIPTION : RUNNING_FORK_UNAVAILABLE)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renames a chat from its sidebar context menu', async () => {
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))

    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    expect(input).toHaveValue('Original chat')
    await user.clear(input)
    await user.type(input, '  Deployment notes  ')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(window.agentsDock.sessions.update).toHaveBeenCalledWith('chat-1', { title: 'Deployment notes' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument())
    expect(screen.getByText('Deployment notes')).toBeInTheDocument()
  })

  it('disables blank names and closes unchanged trimmed names without an update', async () => {
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, '   ')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    await user.type(input, 'Original chat   ')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(window.agentsDock.sessions.update).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument()
  })

  it('blocks duplicate updates and closing while a rename is in flight', async () => {
    let resolveUpdate: (value: Session) => void = () => undefined
    vi.mocked(window.agentsDock.sessions.update).mockImplementationOnce(() => (
      new Promise<Session>(resolve => { resolveUpdate = resolve })
    ))
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, 'Deployment notes')
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(window.agentsDock.sessions.update).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close Rename chat' })).toBeDisabled()

    await act(async () => {
      resolveUpdate({ ...session, title: 'Deployment notes' })
    })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument())
  })

  it('keeps the rename dialog open when the server rejects the update', async () => {
    vi.mocked(window.agentsDock.sessions.update).mockRejectedValueOnce(new Error('Server unavailable'))
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, 'Deployment notes')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(useAppStore.getState().error).toBe('Server unavailable'))
    expect(screen.getByRole('heading', { name: 'Rename chat' })).toBeInTheDocument()
    expect(input).toHaveValue('Deployment notes')
    expect(screen.getByText('Original chat')).toBeInTheDocument()
  })

  it('turns the entire chat row amber when an active agent needs user action', () => {
    useAppStore.setState({
      sessions: [{ ...session, backend: 'claude', claude_needs_user_action: true, manual_unread: true }],
      activeSessionIds: new Set([session.id])
    })

    render(<Sidebar />)

    const row = screen.getByText('Original chat').closest('.session-row')
    expect(row).toHaveClass('action-needed')
    expect(row).toHaveClass('unread')
    expect(row).toHaveClass('selected')
    expect(row).toHaveAttribute('title', 'Original chat · action needed')
    expect(row).toHaveTextContent('Claude · action needed')
    expect(row).not.toHaveTextContent('running')
    expect(row?.querySelector('.status-dot')).toHaveClass('attention')
    expect(row?.querySelector('.status-dot')).not.toHaveClass('running')
  })

  it('gives a critical emergency red priority over action-needed, running, and unread states', () => {
    useAppStore.setState({
      sessions: [{
        ...session,
        backend: 'claude',
        claude_needs_user_action: true,
        manual_unread: true,
        emergency_alert: {
          id: 'alert-1',
          status: 'active',
          severity: 'critical',
          message: 'The production deploy is failing.',
          raised_at: '2026-08-25T12:00:00Z'
        }
      }],
      activeSessionIds: new Set([session.id])
    })

    render(<Sidebar />)

    const row = screen.getByText('Original chat').closest('.session-row')
    expect(row).toHaveClass('emergency', 'action-needed', 'unread', 'selected')
    expect(row).toHaveAttribute('title', 'Original chat · emergency · The production deploy is failing.')
    expect(row).toHaveAttribute('aria-label', 'Original chat, emergency: The production deploy is failing.')
    expect(row).toHaveTextContent('EMERGENCY · The production deploy is failing.')
    expect(row).not.toHaveTextContent('action needed')
    expect(row).not.toHaveTextContent('running')
    expect(screen.getByRole('alert')).toHaveTextContent('Emergency in Original chat: The production deploy is failing.')
    expect(row?.querySelector('.status-dot')).toHaveClass('emergency')
    expect(row?.querySelector('.status-dot')).not.toHaveClass('attention', 'running', 'unread')
  })
})
