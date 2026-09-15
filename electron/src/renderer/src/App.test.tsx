import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session } from '@shared/types'
import { handleMenuCommand, useAppStore } from './store/app-store'
import { installChatSwitcherShortcut } from './lib/chat-switcher-shortcut'
import { App } from './App'

const workspaceEditorHarness = vi.hoisted(() => ({
  autoReady: true,
  onReady: null as (() => void) | null
}))
const appRenderHarness = vi.hoisted(() => ({ sidebarRenders: 0 }))
const teamspaceHarness = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  props: null as null | {
    initialMailboxTarget?: { teamId: string; address: { kind: 'server' | 'agent' | 'human'; id: string } } | null
    initialMailboxRequestId?: number
    initialMessageTarget?: { teamId: string; messageId: string; mailboxBox?: 'inbox' | 'sent' } | null
    onInitialMessageConsumed?: () => void
    initialSection?: 'feed' | 'mail' | 'skills' | 'directory'
    pendingSecurePeerInvite?: { id: number; invite: string } | null
    onSecurePeerInviteHandled?: (requestId: number) => void
  }
}))

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ hidden = false }: { hidden?: boolean }) => {
    appRenderHarness.sidebarRenders += 1
    return <aside data-testid="sidebar" aria-hidden={hidden} />
  }
}))
vi.mock('./components/ChatHeader', () => ({
  ChatHeader: ({ session }: { session?: Session | null }) => {
    const selectedSessionId = useAppStore(state => state.selectedSessionId)
    return <header data-testid="header">header:{session?.id ?? selectedSessionId}</header>
  }
}))
vi.mock('./components/Timeline', () => ({
  Timeline: ({ sessionId }: { sessionId?: string | null }) => {
    const selectedSessionId = useAppStore(state => state.selectedSessionId)
    return <div data-testid="timeline">timeline:{sessionId ?? selectedSessionId}</div>
  }
}))
vi.mock('./components/Composer', () => ({
  Composer: ({ dropActive = false, sessionId }: { dropActive?: boolean; sessionId?: string | null }) => {
    const selectedSessionId = useAppStore(state => state.selectedSessionId)
    return <div data-testid="composer" data-drop-active={dropActive}>composer:{sessionId ?? selectedSessionId}</div>
  }
}))
vi.mock('./components/Dialogs', () => ({ Dialogs: () => <div data-testid="dialogs" /> }))
vi.mock('./components/InspectorDock', () => ({ InspectorDock: () => <div data-testid="inspector" /> }))
vi.mock('./components/CodeReview', () => ({ CodeReview: () => <div data-testid="review" /> }))
vi.mock('./components/TerminalDock', () => ({ TerminalDock: () => <div data-testid="terminal" /> }))
vi.mock('./components/TeamNetwork', () => ({
  TeamNetwork: (props: {
    initialMailboxTarget?: { teamId: string; address: { kind: 'server' | 'agent' | 'human'; id: string } } | null
    initialMailboxRequestId?: number
    initialSection?: 'feed' | 'mail' | 'skills' | 'directory'
    pendingSecurePeerInvite?: { id: number; invite: string } | null
    onSecurePeerInviteHandled?: (requestId: number) => void
  }) => {
    teamspaceHarness.props = props
    useEffect(() => {
      teamspaceHarness.mounts += 1
      return () => { teamspaceHarness.unmounts += 1 }
    }, [])
    return <div data-testid="teamspace">Teamspace</div>
  }
}))
vi.mock('./components/WorkspaceEditor', () => ({
  WorkspaceEditor: ({
    session,
    available,
    workspaceKey,
    maxTextFileBytes,
    chatContent,
    onReady
  }: {
    session: Session
    available: boolean | null
    workspaceKey: string
    maxTextFileBytes?: number
    chatContent: ReactNode
    onReady?: () => void
  }) => {
    useEffect(() => {
      workspaceEditorHarness.onReady = onReady ?? null
      if (workspaceEditorHarness.autoReady) onReady?.()
      return () => {
        if (workspaceEditorHarness.onReady === onReady) workspaceEditorHarness.onReady = null
      }
    }, [onReady, session.id])
    return <div
      data-testid="workspace-editor"
      data-session={session.id}
      data-cwd={session.cwd}
      data-available={String(available)}
      data-workspace-key={workspaceKey}
      data-max-text-file-bytes={maxTextFileBytes}
    ><div data-testid="code-editor" role="textbox" contentEditable suppressContentEditableWarning>code</div>{chatContent}</div>
  }
}))
vi.mock('./components/WorkspaceResizeHandles', () => ({
  WorkspaceResizeHandles: ({ sidebarVisible = true }: { sidebarVisible?: boolean }) => <div data-testid="resize" data-sidebar-visible={String(sidebarVisible)} />,
  savedWorkspaceColumnStyle: () => ({}),
  savedWorkspaceSidebarVisible: (workspaceKey: string) => (
    localStorage.getItem(`test:sidebar-visible:${workspaceKey}`) !== 'false'
  ),
  persistWorkspaceSidebarVisible: (workspaceKey: string, visible: boolean) => {
    localStorage.setItem(`test:sidebar-visible:${workspaceKey}`, String(visible))
  }
}))
vi.mock('./lib/renderer-stall-monitor', () => ({ installRendererStallMonitor: () => () => undefined }))

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}
const sessions: Session[] = [
  { id: 'chat-a', title: 'Chat A', backend: 'codex', cwd: '/work/alpha' },
  { id: 'chat-b', title: 'Chat B', backend: 'claude', cwd: '/work/beta' }
]

describe('App chat workspace identity', () => {
  beforeEach(() => {
    appRenderHarness.sidebarRenders = 0
    workspaceEditorHarness.autoReady = true
    workspaceEditorHarness.onReady = null
    teamspaceHarness.mounts = 0
    teamspaceHarness.unmounts = 0
    teamspaceHarness.props = null
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        updates: {
          status: vi.fn().mockResolvedValue(null),
          install: vi.fn().mockResolvedValue(undefined)
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) },
        native: {
          closeWindow: vi.fn().mockResolvedValue(undefined),
          completeCloseFlush: vi.fn().mockResolvedValue(true),
          readyForNotifications: vi.fn().mockResolvedValue(true),
          readyForSecurePeerInvite: vi.fn().mockResolvedValue(true),
          log: vi.fn().mockResolvedValue(undefined)
        },
        files: {
          pathForFile: vi.fn((file: File) => `/tmp/${file.name}`),
          stageNativeFile: vi.fn((file: File) => Promise.resolve({
            path: `/tmp/${file.name}`, name: file.name, size: file.size, type: file.type
          })),
          stageClipboardImage: vi.fn(),
          upload: vi.fn().mockResolvedValue([])
        },
        preferences: {
          get: vi.fn((_key, fallback) => Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn((_scope, _key, fallback) => Promise.resolve(fallback)),
          setScoped: vi.fn().mockResolvedValue(undefined)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 4,
      switchingProfileId: null,
      sessions,
      selectedSessionId: sessions[0].id,
      chatPanes: { primary: sessions[0].id, secondary: null },
      focusedChatPane: 'primary',
      inspectorVisible: false,
      health: {
        ok: true,
        capabilities: {
          workspace_files: {
            available: true,
            required: false,
            message: 'Workspace files available.',
            action: null,
            version: 1,
            max_text_file_bytes: 2_097_152
          }
        }
      },
      uploadsBySession: {},
      uploadPathsBySession: {},
      error: null,
      storageFull: false,
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

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
    vi.restoreAllMocks()
  })

  it('wraps every selected chat in its cwd-scoped workspace editor while keeping chat visible', () => {
    render(<App />)

    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-a')
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-cwd', '/work/alpha')
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-available', 'true')
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-workspace-key', 'server:server-a:chat-a:cwd:/work/alpha')
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-max-text-file-bytes', '2097152')
    expect(screen.getByTestId('timeline')).toBeVisible()
    expect(screen.getByTestId('composer')).toBeVisible()
    expect(screen.getByTestId('dialogs')).toBeInTheDocument()
  })

  it('does not repaint the app shell for volatile health activity and queue telemetry', () => {
    render(<App />)
    const shellRenders = appRenderHarness.sidebarRenders
    const health = useAppStore.getState().health!

    act(() => useAppStore.setState({
      health: {
        ...health,
        active: ['chat-b'],
        active_sessions: ['chat-b'],
        queued: { 'chat-b': 42 },
        update_blocking_queued_count: 42
      }
    }))

    expect(appRenderHarness.sidebarRenders).toBe(shellRenders)
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-available', 'true')
  })

  it('keeps the active emergency immediately above the composer in the normal chat view', () => {
    act(() => useAppStore.setState({
      sessions: [{
        ...sessions[0],
        emergency_alert: {
          id: 'alert-a',
          status: 'active',
          severity: 'critical',
          message: 'Chat A needs immediate attention.',
          raised_at: '2026-09-05T12:05:00Z'
        },
        unacknowledged_emergency_count: 1
      }, sessions[1]]
    }))

    render(<App />)

    const workspace = document.querySelector('.chat-workspace')
    const dock = screen.getByRole('region', { name: 'Active emergency in Chat A' })
    const composer = screen.getByTestId('composer')
    expect(workspace).not.toBeNull()
    expect(dock).toBeVisible()
    expect(dock).toHaveTextContent('Chat A needs immediate attention.')
    expect(workspace).toContainElement(dock)
    expect(dock.nextElementSibling).toBe(composer)
  })

  it('closes Teamspace when the active server scope changes and does not reopen on switch-back', async () => {
    render(<App />)
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace')) })
    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe('mail')
    expect(teamspaceHarness).toMatchObject({ mounts: 1, unmounts: 0 })

    act(() => useAppStore.setState({
      profiles: [profile, { ...profile, id: 'profile-b', name: 'Beta', serverIdentity: 'server-b' }],
      activeProfileId: 'profile-b',
      profileGeneration: 5
    }))

    await waitFor(() => expect(teamspaceHarness).toMatchObject({ mounts: 1, unmounts: 1 }))
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()
    expect(screen.getByTestId('timeline')).toBeVisible()

    act(() => useAppStore.setState({ activeProfileId: profile.id, profileGeneration: 6 }))
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()
    expect(teamspaceHarness.mounts).toBe(1)
  })

  it('opens Teamspace directly to Inbox when a received-mail notice requests it', async () => {
    render(<App />)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: {
      section: 'mail',
      teamId: 'team-1',
      mailboxAddress: { kind: 'agent', id: 'agent-1' }
    } })) })

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe('mail')
    expect(teamspaceHarness.props?.initialMailboxTarget).toEqual({ teamId: 'team-1', address: { kind: 'agent', id: 'agent-1' } })
    expect(teamspaceHarness.props?.initialMailboxRequestId).toBeGreaterThan(0)
  })

  it.each(['mac', 'other'] as const)('reveals the selected chat after %s chat-switcher navigation from Team Network', async platform => {
    const { SearchDialog } = await vi.importActual<typeof import('./components/Dialogs')>('./components/Dialogs')
    vi.spyOn(useAppStore.getState(), 'selectSession').mockImplementation(async selectedSessionId => {
      useAppStore.setState({ selectedSessionId, chatPanes: { primary: selectedSessionId, secondary: null } })
    })
    const removeShortcut = installChatSwitcherShortcut(window, () => {
      handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))
    }, platform)
    try {
      render(<><App /><SearchDialog /></>)
      act(() => { window.dispatchEvent(new Event('agentsdock:open-teamspace')) })
      expect(await screen.findByTestId('teamspace')).toBeVisible()
      fireEvent.keyDown(screen.getByTestId('teamspace'), { key: 'p', code: 'KeyP', metaKey: platform === 'mac', ctrlKey: platform === 'other' })
      expect(await screen.findByRole('combobox')).toBeVisible()
      fireEvent.click(screen.getByRole('option', { name: /Chat B/ }))
      await waitFor(() => expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument())
      expect(screen.getByTestId('timeline')).toHaveTextContent('timeline:chat-b')
      expect(useAppStore.getState().modals.search).toBe(false)
    } finally {
      removeShortcut()
    }
  })

  it('opens the exact linked message and clears the consumed navigation target', async () => {
    render(<App />)
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: {
      section: 'feed', teamId: 'team-1', messageId: 'message-1'
    } })) })
    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe('feed')
    expect(teamspaceHarness.props?.initialMessageTarget).toEqual({ teamId: 'team-1', messageId: 'message-1', mailboxBox: 'inbox' })
    act(() => { teamspaceHarness.props?.onInitialMessageConsumed?.() })
    expect(teamspaceHarness.props?.initialMessageTarget).toBeNull()
  })

  it('does not open a message under a different server identity', async () => {
    render(<App />)
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: {
      section: 'mail', teamId: 'team-1', messageId: 'message-1', serverIdentity: 'another-server'
    } })) })
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()
    expect(useAppStore.getState().error).toContain('belongs to another server')
  })

  it.each(['feed', 'directory'] as const)('preserves an explicit %s Team Network destination', async section => {
    render(<App />)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: { section } })) })

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe(section)
  })

  it('gives every Inbox open event a fresh navigation request even for the same mailbox', async () => {
    render(<App />)
    const detail = {
      section: 'mail',
      teamId: 'team-1',
      mailboxAddress: { kind: 'agent', id: 'agent-1' }
    }

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail })) })
    expect(await screen.findByTestId('teamspace')).toBeVisible()
    const firstRequest = teamspaceHarness.props?.initialMailboxRequestId
    expect(firstRequest).toBeGreaterThan(0)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail })) })
    expect(teamspaceHarness.props?.initialMailboxRequestId).toBeGreaterThan(firstRequest!)
  })

  it('preserves the exact human My replies target from a received-mail notice', async () => {
    render(<App />)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: {
      section: 'mail',
      teamId: 'team-1',
      mailboxAddress: { kind: 'human', id: 'owner' }
    } })) })

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe('mail')
    expect(teamspaceHarness.props?.initialMailboxTarget).toEqual({ teamId: 'team-1', address: { kind: 'human', id: 'owner' } })
  })

  it('opens Team Network with the newest typed secure-peer invite without connecting', async () => {
    let receiveInvite!: (payload: { invite: string }) => void
    const eventsOn = vi.fn((name: string, listener: (payload: { invite: string }) => void) => {
      if (name === 'native:secure-peer-invite') receiveInvite = listener
      return () => undefined
    })
    window.agentsDock.events.on = eventsOn as AgentsDockAPI['events']['on']
    const invite = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`

    render(<App />)
    expect(receiveInvite).toBeTypeOf('function')
    expect(window.agentsDock.native.readyForNotifications).toHaveBeenCalled()
    expect(window.agentsDock.native.readyForSecurePeerInvite).toHaveBeenCalled()

    act(() => receiveInvite({ invite: `${invite}&secret=not-allowed` }))
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()

    act(() => receiveInvite({ invite }))

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.initialSection).toBe('directory')
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toEqual({ id: 1, invite })
    expect('requestSecurePeerPairing' in (window.agentsDock.teamHub ?? {})).toBe(false)

    act(() => teamspaceHarness.props?.onSecurePeerInviteHandled?.(1))
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toBeNull()
  })

  it('retains a pending secure-peer invite across server and generation changes until handled', async () => {
    const invite = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`
    const nextProfile = { ...profile, id: 'profile-b', name: 'Beta', serverIdentity: 'server-b' }
    render(<App />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-secure-peer-invite', { detail: { invite } })))
    expect(await screen.findByTestId('teamspace')).toBeVisible()

    act(() => useAppStore.setState({ switchingProfileId: nextProfile.id }))
    act(() => useAppStore.setState({
      profiles: [profile, nextProfile],
      activeProfileId: nextProfile.id,
      profileGeneration: 5,
      switchingProfileId: null
    }))
    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toEqual({ id: 1, invite })
    act(() => useAppStore.setState({ profileGeneration: 6 }))
    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toEqual({ id: 1, invite })

    act(() => teamspaceHarness.props?.onSecurePeerInviteHandled?.(1))
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toBeNull()
    act(() => useAppStore.setState({ activeProfileId: profile.id, profileGeneration: 7 }))
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()
  })

  it('holds a cold secure-peer invite until initialization has a stable server identity', async () => {
    let receiveInvite!: (payload: { invite: string }) => void
    const eventsOn = vi.fn((name: string, listener: (payload: { invite: string }) => void) => {
      if (name === 'native:secure-peer-invite') receiveInvite = listener
      return () => undefined
    })
    const invite = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'a'.repeat(64)}`
    window.agentsDock.events.on = eventsOn as AgentsDockAPI['events']['on']
    const ready = vi.fn(async () => { receiveInvite({ invite }); return true })
    window.agentsDock.native.readyForSecurePeerInvite = ready
    useAppStore.setState({
      initialized: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      sessions: [],
      selectedSessionId: null,
      chatPanes: { primary: null, secondary: null }
    })

    render(<App />)
    expect(receiveInvite).toBeTypeOf('function')
    expect(ready).not.toHaveBeenCalled()

    act(() => useAppStore.setState({
      initialized: true,
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 4
    }))

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(ready).toHaveBeenCalledOnce()
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toEqual({ id: 1, invite })
  })

  it('queues an invite delivered during a profile switch for the adopted server scope', async () => {
    let receiveInvite!: (payload: { invite: string }) => void
    window.agentsDock.events.on = vi.fn((name: string, listener: (payload: { invite: string }) => void) => {
      if (name === 'native:secure-peer-invite') receiveInvite = listener
      return () => undefined
    }) as AgentsDockAPI['events']['on']
    const invite = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=sha256%3A${'b'.repeat(64)}`
    const nextProfile = { ...profile, id: 'profile-b', name: 'Beta', serverIdentity: 'server-b' }

    render(<App />)
    expect(receiveInvite).toBeTypeOf('function')

    act(() => useAppStore.setState({ switchingProfileId: nextProfile.id }))
    act(() => receiveInvite({ invite }))
    expect(screen.queryByTestId('teamspace')).not.toBeInTheDocument()

    act(() => useAppStore.setState({
      profiles: [profile, nextProfile],
      activeProfileId: nextProfile.id,
      profileGeneration: 5,
      switchingProfileId: null
    }))

    expect(await screen.findByTestId('teamspace')).toBeVisible()
    expect(teamspaceHarness.props?.pendingSecurePeerInvite).toEqual({ id: 1, invite })
    expect(teamspaceHarness).toMatchObject({ mounts: 1, unmounts: 0 })
  })

  it('keeps an archived-only workspace read-only without loading its provider runtime', async () => {
    const archived = { ...sessions[0], archived: true }
    const runtime = vi.fn().mockResolvedValue({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: null
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { ...window.agentsDock, codex: { runtime } } as unknown as AgentsDockAPI
    })
    act(() => useAppStore.setState(state => ({
      sessions: [archived],
      selectedSessionId: archived.id,
      chatPanes: { primary: archived.id, secondary: null },
      focusedChatPane: 'primary',
      health: {
        ...state.health!,
        capabilities: {
          ...state.health?.capabilities,
          codex_controls: {
            available: true,
            required: false,
            message: 'Codex controls available.',
            action: null
          }
        }
      }
    })))

    render(<App />)

    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', archived.id)
    expect(screen.getByText('Archived chat. Unarchive it to send a message.')).toBeVisible()
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
    expect(runtime).not.toHaveBeenCalled()
  })

  it('keeps an archived target read-only while its file workspace preserves split view', async () => {
    const archived = { ...sessions[1], archived: true }
    act(() => useAppStore.setState({
      sessions: [sessions[0], archived],
      selectedSessionId: sessions[0].id,
      chatPanes: { primary: sessions[0].id, secondary: archived.id },
      focusedChatPane: 'primary'
    }))
    render(<App />)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: archived.id, path: 'README.md' }
      }))
    })

    await waitFor(() => expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', archived.id))
    expect(useAppStore.getState().chatPanes).toEqual({ primary: sessions[0].id, secondary: archived.id })
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', archived.id)
    expect(screen.getByText('Archived chat. Unarchive it to send a message.')).toBeVisible()
    expect(screen.getAllByTestId('composer')).toHaveLength(1)
    expect(screen.getByTestId('composer')).toHaveTextContent('composer:chat-a')
  })

  it('dismisses a downloaded update notice without starting installation', async () => {
    vi.mocked(window.agentsDock.updates.status).mockResolvedValueOnce({
      state: 'downloaded',
      channel: 'direct',
      track: 'beta',
      currentVersion: '0.2.7-beta.16',
      availableVersion: '0.2.7-beta.17'
    })
    render(<App />)

    expect(await screen.findByText('AgentsDock 0.2.7-beta.17 is ready')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect(screen.queryByText('AgentsDock 0.2.7-beta.17 is ready')).not.toBeInTheDocument()
    expect(window.agentsDock.updates.install).not.toHaveBeenCalled()
  })

  it('toggles and persists the chat sidebar with Cmd/Ctrl+/ even when the code editor has focus', () => {
    const first = render(<App />)
    const shell = document.querySelector('.app-shell')!
    const editor = screen.getByTestId('code-editor')
    expect(shell).not.toHaveClass('sidebar-hidden')
    expect(screen.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'false')

    editor.focus()
    const hide = new KeyboardEvent('keydown', {
      key: '/',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => { editor.dispatchEvent(hide) })

    expect(hide.defaultPrevented).toBe(true)
    expect(shell).toHaveClass('sidebar-hidden')
    expect(screen.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('resize')).toHaveAttribute('data-sidebar-visible', 'false')
    expect(editor).toHaveTextContent('code')

    first.unmount()
    render(<App />)
    expect(document.querySelector('.app-shell')).toHaveClass('sidebar-hidden')

    const show = new KeyboardEvent('keydown', {
      key: '/',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => { screen.getByTestId('code-editor').dispatchEvent(show) })
    expect(show.defaultPrevented).toBe(true)
    expect(document.querySelector('.app-shell')).not.toHaveClass('sidebar-hidden')
  })

  it('passes an unavailable capability without removing the chat workspace', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          workspace_files: {
            available: false,
            required: false,
            message: 'Upgrade needed.',
            action: 'Update AgentsServer.'
          }
        }
      }
    })
    render(<App />)

    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-available', 'false')
    expect(screen.getByTestId('timeline')).toBeVisible()
    expect(screen.getByTestId('composer')).toBeVisible()
    expect(screen.getByTestId('dialogs')).toBeInTheDocument()
  })

  it('treats a connected older server with no workspace capability as unavailable', () => {
    useAppStore.setState({ health: { ok: true, capabilities: {} } })
    render(<App />)

    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-available', 'false')
    expect(screen.getByTestId('timeline')).toBeVisible()
  })

  it('renders A → B → A without duplicate sibling keys or stale workspace children', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<App />)
    expect(screen.getByTestId('timeline')).toHaveTextContent('timeline:chat-a')
    expect(screen.getByTestId('composer')).toHaveTextContent('composer:chat-a')

    act(() => useAppStore.setState({ selectedSessionId: 'chat-b', chatPanes: { primary: 'chat-b', secondary: null } }))
    expect(screen.getByTestId('timeline')).toHaveTextContent('timeline:chat-b')
    expect(screen.getByTestId('composer')).toHaveTextContent('composer:chat-b')

    act(() => useAppStore.setState({ selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null } }))
    expect(screen.getByTestId('timeline')).toHaveTextContent('timeline:chat-a')
    expect(screen.getByTestId('composer')).toHaveTextContent('composer:chat-a')
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/i)
  })

  it('renders two stable interactive chat panes and keeps shared surfaces on the focused chat', () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary'
    }))
    render(<App />)

    expect(screen.getAllByTestId('timeline').map(node => node.textContent)).toEqual(['timeline:chat-a', 'timeline:chat-b'])
    expect(screen.getAllByTestId('composer').map(node => node.textContent)).toEqual(['composer:chat-a', 'composer:chat-b'])
    expect(screen.queryByTestId('workspace-editor')).not.toBeInTheDocument()
    expect(document.querySelector('[data-chat-pane="primary"]')).toHaveClass('focused')
    expect(document.querySelector('[data-chat-pane="secondary"]')).not.toHaveClass('focused')

    fireEvent.pointerDown(document.querySelector('[data-chat-pane="secondary"]')!)
    expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(document.querySelector('[data-chat-pane="secondary"]')).toHaveClass('focused')
  })

  it('focuses split chat panes with exact non-Mac Control-Alt-arrow shortcuts', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('AgentsDock')
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary'
    }))
    render(<App />)

    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true, repeat: true })
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true })
    expect(useAppStore.getState().focusedChatPane).toBe('primary')

    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })
    expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(document.activeElement).toBe(document.querySelector('[data-chat-pane="secondary"]'))

    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true })
    expect(useAppStore.getState().selectedSessionId).toBe('chat-a')
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
    expect(document.activeElement).toBe(document.querySelector('[data-chat-pane="primary"]'))
  })

  it('uses Option-Command-arrows on Mac and leaves the shortcut alone outside split view', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('AgentsDock')
    const view = render(<App />)
    const singlePaneShortcut = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    })

    screen.getByTestId('code-editor').dispatchEvent(singlePaneShortcut)
    expect(singlePaneShortcut.defaultPrevented).toBe(false)
    expect(useAppStore.getState().selectedSessionId).toBe('chat-a')

    act(() => useAppStore.setState({
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary'
    }))
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true })
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(document.activeElement).toBe(view.container.querySelector('[data-chat-pane="secondary"]'))
  })

  it('uses a pane shortcut to leave the split file workspace without crossing an open modal', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('AgentsDock')
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-b',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'secondary'
    }))
    render(<App />)
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    expect(screen.getByRole('region', { name: 'Chat B file workspace' })).toBeInTheDocument()

    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true })
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(screen.getByRole('region', { name: 'Chat B file workspace' })).toBeInTheDocument()

    modal.remove()
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true })
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
    expect(screen.queryByRole('region', { name: 'Chat B file workspace' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-chat-pane="primary"]')))
  })

  it('preserves both chat panes and consumes the exact targeted workspace request once on editor readiness', async () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary'
    }))
    workspaceEditorHarness.autoReady = false
    const view = render(<App />)
    const primaryPane = view.container.querySelector('[data-chat-pane="primary"]')
    const secondaryPane = view.container.querySelector('[data-chat-pane="secondary"]')
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', opened)
    try {
      const request = new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-b', path: 'src/index.ts' }
      })
      act(() => { window.dispatchEvent(request) })

      expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
      expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
      expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-b')
      expect(view.container.querySelector('[data-chat-pane="primary"]')).toBe(primaryPane)
      expect(view.container.querySelector('[data-chat-pane="secondary"]')).toBe(secondaryPane)
      expect(view.container.querySelector('.chat-split-view')).toHaveAttribute('inert')
      expect(view.container.querySelector('.chat-split-view')).toHaveAttribute('aria-hidden', 'true')
      expect(opened).not.toHaveBeenCalled()
      expect(workspaceEditorHarness.onReady).toBeTypeOf('function')

      act(() => workspaceEditorHarness.onReady?.())
      expect(opened).toHaveBeenCalledOnce()
      act(() => workspaceEditorHarness.onReady?.())
      expect(opened).toHaveBeenCalledOnce()

      const secondRequest = new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-b', path: 'src/other.ts' }
      })
      act(() => { window.dispatchEvent(secondRequest) })
      expect(opened).toHaveBeenCalledTimes(2)
      expect(opened.mock.calls[1][0]).toBe(secondRequest)

      fireEvent.click(screen.getByRole('button', { name: 'Return to split chats' }))
      expect(screen.queryByRole('region', { name: 'Chat B file workspace' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('workspace-editor')).not.toBeInTheDocument()
      expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
      expect(view.container.querySelector('[data-chat-pane="primary"]')).toBe(primaryPane)
      expect(view.container.querySelector('[data-chat-pane="secondary"]')).toBe(secondaryPane)
      expect(view.container.querySelector('.chat-split-view')).not.toHaveAttribute('inert')
      expect(view.container.querySelector('.chat-split-view')).not.toHaveAttribute('aria-hidden')
      expect(opened.mock.calls[0][0]).toBe(request)
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe(request.detail)

    } finally {
      window.removeEventListener('agentsdock:open-workspace-path', opened)
    }
  })

  it('replays the exact menu open-file event only after the targeted editor is ready', () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-b',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'secondary'
    }))
    workspaceEditorHarness.autoReady = false
    render(<App />)
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-workspace-file', opened)
    try {
      const request = new CustomEvent('agentsdock:open-workspace-file')
      act(() => { window.dispatchEvent(request) })

      expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
      expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-b')
      expect(opened).not.toHaveBeenCalled()

      act(() => workspaceEditorHarness.onReady?.())
      expect(opened).toHaveBeenCalledOnce()
      expect(opened.mock.calls[0][0]).toBe(request)
    } finally {
      window.removeEventListener('agentsdock:open-workspace-file', opened)
    }
  })

  it('dismisses a split file workspace before closing either chat pane', () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-b',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'secondary'
    }))
    render(<App />)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-b')

    fireEvent(window, new Event('agentsdock:close-surface'))

    expect(screen.queryByTestId('workspace-editor')).not.toBeInTheDocument()
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
    expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
    expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
  })

  it('cancels a pending split workspace replay when its pane is removed', () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary'
    }))
    workspaceEditorHarness.autoReady = false
    render(<App />)
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-workspace-path', opened)
    try {
      act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-b', path: 'src/index.ts' }
      })) })
      expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-b')

      act(() => useAppStore.setState({
        selectedSessionId: 'chat-a',
        chatPanes: { primary: 'chat-a', secondary: null },
        focusedChatPane: 'primary'
      }))

      expect(screen.queryByRole('region', { name: 'Chat B file workspace' })).not.toBeInTheDocument()
      expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-session', 'chat-a')
      act(() => workspaceEditorHarness.onReady?.())
      expect(opened).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:open-workspace-path', opened)
    }
  })

  it('closes the focused split pane before closing the app window', () => {
    act(() => useAppStore.setState({
      selectedSessionId: 'chat-b',
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'secondary'
    }))
    render(<App />)

    fireEvent(window, new Event('agentsdock:close-surface'))

    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: null })
    expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
  })

  it('lets an active workspace file consume close-surface before the window closes', () => {
    render(<App />)
    const consume = (event: Event) => event.preventDefault()
    window.addEventListener('agentsdock:workspace-close-active', consume)
    fireEvent(window, new Event('agentsdock:close-surface'))
    window.removeEventListener('agentsdock:workspace-close-active', consume)

    expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
  })

  it('waits for every workspace persistence task and keeps the window open when one fails', async () => {
    let finishPersistence!: () => void
    const persistence = new Promise<void>(resolve => { finishPersistence = resolve })
    const collect = (event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil(value: PromiseLike<unknown>): void }>).detail
      detail.waitUntil(Promise.reject(new Error('draft persistence failed')))
      detail.waitUntil(persistence)
    }
    window.addEventListener('agentsdock:flush-draft', collect)
    try {
      render(<App />)

      fireEvent(window, new Event('agentsdock:close-surface'))
      await Promise.resolve()
      expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()

      await Promise.resolve()
      expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
      finishPersistence()
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be saved'))
      expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:flush-draft', collect)
    }
  })

  it('flushes renderer persistence before acknowledging native close or Cmd+Q', async () => {
    let requestClose!: (payload: { requestId: string }) => void
    let finishPersistence!: () => void
    const persistence = new Promise<void>(resolve => { finishPersistence = resolve })
    const eventsOn = vi.fn((name: string, listener: (payload: { requestId: string }) => void) => {
      if (name === 'native:close-request') requestClose = listener
      return () => undefined
    })
    window.agentsDock.events.on = eventsOn as AgentsDockAPI['events']['on']
    const collect = (event: Event) => {
      const detail = (event as CustomEvent<{ waitUntil(value: PromiseLike<unknown>): void }>).detail
      detail.waitUntil(persistence)
    }
    window.addEventListener('agentsdock:flush-draft', collect)
    try {
      render(<App />)
      expect(requestClose).toBeTypeOf('function')

      act(() => requestClose({ requestId: 'native-close-1' }))
      await Promise.resolve()
      expect(window.agentsDock.native.completeCloseFlush).not.toHaveBeenCalled()

      finishPersistence()
      await waitFor(() => expect(window.agentsDock.native.completeCloseFlush).toHaveBeenCalledWith('native-close-1', true))
      expect(window.agentsDock.native.closeWindow).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:flush-draft', collect)
    }
  })

  it('uses one stable file-only drop target across the chat workspace', async () => {
    const view = render(<App />)
    const workspace = view.container.querySelector('.chat-workspace') as HTMLElement
    const timeline = screen.getByTestId('timeline')
    const composer = screen.getByTestId('composer')
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const files = { types: ['Files'], files: [file], dropEffect: 'none' }

    fireEvent.dragEnter(workspace, { dataTransfer: { types: ['text/plain'], files: [] } })
    expect(composer).toHaveAttribute('data-drop-active', 'false')

    fireEvent.dragEnter(workspace, { dataTransfer: files })
    fireEvent.dragEnter(timeline, { dataTransfer: files })
    fireEvent.dragLeave(timeline, { dataTransfer: files, relatedTarget: composer })
    expect(composer).toHaveAttribute('data-drop-active', 'true')

    fireEvent.drop(workspace, { dataTransfer: files })
    expect(composer).toHaveAttribute('data-drop-active', 'false')
    await waitFor(() => expect(window.agentsDock.files.upload).toHaveBeenCalledWith('chat-a', ['/tmp/notes.txt']))
  })

  it('dismisses a stale file-drop overlay without requiring a matching dragleave', () => {
    const view = render(<App />)
    const workspace = view.container.querySelector('.chat-workspace') as HTMLElement
    const composer = screen.getByTestId('composer')
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const files = { types: ['Files'], files: [file], dropEffect: 'none' }

    fireEvent.dragEnter(workspace, { dataTransfer: files })
    expect(composer).toHaveAttribute('data-drop-active', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(composer).toHaveAttribute('data-drop-active', 'false')

    fireEvent.dragEnter(workspace, { dataTransfer: files })
    fireEvent.pointerDown(window)
    expect(composer).toHaveAttribute('data-drop-active', 'false')

    fireEvent.dragEnter(workspace, { dataTransfer: files })
    fireEvent.blur(window)
    expect(composer).toHaveAttribute('data-drop-active', 'false')
  })

  it('expires the file-drop overlay and refreshes that watchdog during dragover', () => {
    vi.useFakeTimers()
    try {
      const view = render(<App />)
      const workspace = view.container.querySelector('.chat-workspace') as HTMLElement
      const composer = screen.getByTestId('composer')
      const files = { types: ['Files'], files: [], dropEffect: 'none' }

      fireEvent.dragEnter(workspace, { dataTransfer: files })
      act(() => vi.advanceTimersByTime(1_000))
      fireEvent.dragOver(workspace, { dataTransfer: files })
      act(() => vi.advanceTimersByTime(1_000))
      expect(composer).toHaveAttribute('data-drop-active', 'true')

      act(() => vi.advanceTimersByTime(501))
      expect(composer).toHaveAttribute('data-drop-active', 'false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the context digest from Cmd+D inside the chat surface', () => {
    render(<App />)
    const composer = screen.getByTestId('composer')

    expect(useAppStore.getState().modals.digest).toBe(false)
    fireEvent.keyDown(composer, { key: 'd', metaKey: true })

    expect(useAppStore.getState().modals.digest).toBe(true)

    act(() => useAppStore.getState().setModal('digest', false))
    fireEvent.keyDown(screen.getByTestId('header'), { key: 'd', metaKey: true })
    expect(useAppStore.getState().modals.digest).toBe(false)
  })

  it('stages a dropped virtual image when Electron cannot resolve a native path', async () => {
    const view = render(<App />)
    const workspace = view.container.querySelector('.chat-workspace') as HTMLElement
    const file = new File(['image'], 'diagram.png', { type: 'image/png' })
    const bytes = new ArrayBuffer(5)
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(bytes) })
    vi.mocked(window.agentsDock.files.stageNativeFile).mockResolvedValueOnce(null)
    vi.mocked(window.agentsDock.files.stageClipboardImage).mockResolvedValue({ path: '/tmp/staged-diagram.png', name: 'diagram.png', size: 5, type: 'image/png' })

    fireEvent.drop(workspace, { dataTransfer: { types: ['Files'], files: [file], dropEffect: 'none' } })

    await waitFor(() => expect(window.agentsDock.files.stageClipboardImage).toHaveBeenCalledWith(bytes, 'diagram.png', 'image/png'))
    expect(window.agentsDock.files.upload).toHaveBeenCalledWith('chat-a', ['/tmp/staged-diagram.png'])
  })

  it('surfaces a current-scope native staging rejection from the workspace drop target', async () => {
    const view = render(<App />)
    const workspace = view.container.querySelector('.chat-workspace') as HTMLElement
    vi.mocked(window.agentsDock.files.stageNativeFile).mockRejectedValueOnce(new Error('Native staging denied'))

    fireEvent.drop(workspace, {
      dataTransfer: { types: ['Files'], files: [new File(['private'], 'private.txt')], dropEffect: 'none' }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Native staging denied')
    expect(window.agentsDock.files.upload).not.toHaveBeenCalled()
  })
})
