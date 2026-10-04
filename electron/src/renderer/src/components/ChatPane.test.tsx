import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health, NativeFileRef, PublicServerProfile, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ChatPane } from './ChatPane'

const nativeFiles = vi.hoisted(() => ({
  fromFiles: vi.fn()
}))
const runtimeProviders = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn()
}))

vi.mock('../lib/native-files', () => ({ nativeFileRefsFromFiles: nativeFiles.fromFiles }))
vi.mock('./ChatHeader', () => ({
  ChatHeader: ({ session }: { session: Session }) => <div data-testid="chat-header">Header:{session.id}</div>
}))
vi.mock('./ClaudeRuntimeContext', () => ({
  ClaudeRuntimeProvider: ({ children }: { children: React.ReactNode }) => {
    runtimeProviders.claude()
    return children
  }
}))
vi.mock('./CodexRuntimeContext', () => ({
  CodexRuntimeProvider: ({ children }: { children: React.ReactNode }) => {
    runtimeProviders.codex()
    return children
  }
}))
vi.mock('./ClaudeInteractionShelf', () => ({ ClaudeInteractionShelf: () => null }))
vi.mock('./CodexInteractionShelf', () => ({ CodexInteractionShelf: () => null }))
vi.mock('./CodexControls', () => ({ CodexGoalBar: () => null }))
vi.mock('./Timeline', () => ({
  Timeline: ({ sessionId, focused }: { sessionId: string; focused: boolean }) => (
    <div data-testid="timeline" data-session-id={sessionId} data-focused={String(focused)} />
  )
}))
vi.mock('./Composer', () => ({
  Composer: ({ sessionId, dropActive }: { sessionId: string; dropActive: boolean }) => (
    <div data-testid="composer" data-session-id={sessionId} data-drop-active={String(dropActive)} />
  )
}))

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Profile A',
  serverUrl: 'http://server.test:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}
const primary: Session = { id: 'chat-a', title: 'Primary', backend: 'codex' }
const secondary: Session = { id: 'chat-b', title: 'Secondary', backend: 'claude' }

describe('ChatPane', () => {
  let focusChatPane: ReturnType<typeof vi.fn>
  let attachPathsForSession: ReturnType<typeof vi.fn>

  beforeEach(() => {
    focusChatPane = vi.fn()
    attachPathsForSession = vi.fn().mockResolvedValue(undefined)
    nativeFiles.fromFiles.mockReset()
    runtimeProviders.claude.mockClear()
    runtimeProviders.codex.mockClear()
    useAppStore.setState({
      activeProfileId: profile.id,
      profileGeneration: 7,
      profiles: [profile],
      switchingProfileId: null,
      chatPanes: { primary: primary.id, secondary: secondary.id },
      focusedChatPane: 'primary',
      selectedSessionId: primary.id,
      sessions: [primary, secondary],
      health: null,
      focusChatPane: focusChatPane as ReturnType<typeof useAppStore.getState>['focusChatPane'],
      attachPathsForSession: attachPathsForSession as ReturnType<typeof useAppStore.getState>['attachPathsForSession']
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the explicit pane session and focuses that pane on interaction', () => {
    renderSecondary()

    expect(screen.getByTestId('chat-header')).toHaveTextContent('Header:chat-b')
    expect(screen.getByTestId('timeline')).toHaveAttribute('data-session-id', secondary.id)
    expect(screen.getByTestId('timeline')).toHaveAttribute('data-focused', 'false')
    expect(screen.getByTestId('composer')).toHaveAttribute('data-session-id', secondary.id)

    fireEvent.pointerDown(screen.getByRole('region', { name: 'Secondary chat pane' }))
    expect(focusChatPane).toHaveBeenCalledWith('secondary')
  })

  it('ignores equivalent health telemetry and unchanged parent renders', () => {
    const health = (active: string[]): Health => ({
      active,
      capabilities: {
        codex_controls: { available: true },
        claude_controls: {
          available: true,
          interactive_client_capability: 'claude_sdk_interactive_v1'
        }
      }
    } as unknown as Health)
    useAppStore.setState({ health: health(['chat-a']) })
    const view = renderSecondary()
    runtimeProviders.claude.mockClear()
    runtimeProviders.codex.mockClear()

    act(() => useAppStore.setState({ health: health(['chat-b']) }))
    view.rerender(<ChatPane
      pane="secondary"
      session={secondary}
      focused={false}
      split
      terminalOpen={false}
    />)

    expect(runtimeProviders.claude).not.toHaveBeenCalled()
    expect(runtimeProviders.codex).not.toHaveBeenCalled()
  })

  it('keeps an active emergency outside the scrolling timeline directly above the composer', () => {
    const emergencyPrimary: Session = {
      ...primary,
      emergency_alert: {
        id: 'alert-pinned',
        status: 'active',
        severity: 'critical',
        message: 'Production requires immediate attention.',
        raised_at: '2026-09-05T12:05:00Z'
      },
      unacknowledged_emergency_count: 1
    }
    useAppStore.setState({ sessions: [emergencyPrimary, secondary] })
    const { container } = render(<ChatPane
      pane="primary"
      session={emergencyPrimary}
      focused
      split
      terminalOpen={false}
    />)

    const workspace = container.querySelector('.chat-workspace')
    const children = Array.from(workspace?.children ?? [])
    const timeline = screen.getByTestId('timeline')
    const dock = screen.getByRole('region', { name: 'Active emergency in Primary' })
    const composer = screen.getByTestId('composer')

    expect(children.indexOf(dock)).toBeGreaterThan(children.indexOf(timeline))
    expect(children.indexOf(dock)).toBe(children.indexOf(composer.closest('.chat-workspace-composer')!) - 1)
  })

  it('stages a drop for the explicit session and uploads only to that pane', async () => {
    const file = new File(['report'], 'report.txt', { type: 'text/plain' })
    const refs: NativeFileRef[] = [{ path: '/tmp/report.txt', name: 'report.txt', size: 6, type: 'text/plain' }]
    nativeFiles.fromFiles.mockResolvedValue(refs)
    const { container } = renderSecondary()
    const workspace = container.querySelector('.chat-workspace') as HTMLDivElement
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    fireEvent.dragEnter(workspace, { dataTransfer })
    expect(focusChatPane).toHaveBeenCalledWith('secondary')
    expect(screen.getByTestId('composer')).toHaveAttribute('data-drop-active', 'true')
    fireEvent.drop(workspace, { dataTransfer })

    await waitFor(() => expect(attachPathsForSession).toHaveBeenCalledWith(secondary.id, refs))
    expect(nativeFiles.fromFiles).toHaveBeenCalledWith([file])
    expect(attachPathsForSession).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('composer')).toHaveAttribute('data-drop-active', 'false')
  })

  it('drops a staged upload when the profile scope changes before staging finishes', async () => {
    let finishStaging!: (refs: NativeFileRef[]) => void
    nativeFiles.fromFiles.mockImplementation(() => new Promise<NativeFileRef[]>(resolve => { finishStaging = resolve }))
    const { container } = renderSecondary()
    const workspace = container.querySelector('.chat-workspace') as HTMLDivElement
    const dataTransfer = { types: ['Files'], files: [new File(['late'], 'late.txt')], dropEffect: 'none' }

    fireEvent.drop(workspace, { dataTransfer })
    useAppStore.setState({ profileGeneration: 8 })
    await act(async () => finishStaging([{ path: '/tmp/late.txt', name: 'late.txt' }]))

    expect(attachPathsForSession).not.toHaveBeenCalled()
  })

  it('surfaces a native staging rejection only while the pane scope is current', async () => {
    nativeFiles.fromFiles.mockRejectedValueOnce(new Error('Could not stage private file'))
    const { container } = renderSecondary()
    const workspace = container.querySelector('.chat-workspace') as HTMLDivElement

    fireEvent.drop(workspace, {
      dataTransfer: { types: ['Files'], files: [new File(['private'], 'private.txt')], dropEffect: 'none' }
    })

    await waitFor(() => expect(useAppStore.getState().error).toBe('Could not stage private file'))
    expect(attachPathsForSession).not.toHaveBeenCalled()
  })

  it('shows the archived notice instead of a composer and refuses file drops', async () => {
    const archived = { ...secondary, archived: true }
    useAppStore.setState({ sessions: [primary, archived] })
    const { container } = renderSecondary(archived)
    const workspace = container.querySelector('.chat-workspace') as HTMLDivElement

    expect(screen.getByText('Archived chat. Unarchive it to send a message.')).toBeInTheDocument()
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    expect(runtimeProviders.claude).not.toHaveBeenCalled()
    expect(runtimeProviders.codex).not.toHaveBeenCalled()
    fireEvent.drop(workspace, {
      dataTransfer: { types: ['Files'], files: [new File(['blocked'], 'blocked.txt')], dropEffect: 'none' }
    })
    await Promise.resolve()
    expect(nativeFiles.fromFiles).not.toHaveBeenCalled()
    expect(attachPathsForSession).not.toHaveBeenCalled()
  })
})

function renderSecondary(session: Session = secondary) {
  return render(<ChatPane
    pane="secondary"
    session={session}
    focused={false}
    split
    terminalOpen={false}
  />)
}
