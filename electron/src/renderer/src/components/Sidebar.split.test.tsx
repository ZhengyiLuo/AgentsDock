import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
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

const sessions: Session[] = [
  { id: 'chat-1', title: 'Primary chat', folder: 'General', backend: 'codex' },
  { id: 'chat-2', title: 'Secondary chat', folder: 'General', backend: 'claude' }
]
const realRequestNewChat = useAppStore.getState().requestNewChat

describe('sidebar split pane context', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockResolvedValue(0),
          set: vi.fn().mockResolvedValue(undefined)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 1,
      switchingProfileId: null,
      connected: true,
      sessions,
      selectedSessionId: sessions[0].id,
      chatPanes: { primary: sessions[0].id, secondary: null },
      folderOrder: ['General'],
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      activeSessionIds: new Set(),
      runtimeCatalog: null,
      creatingChat: false,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState({ requestNewChat: realRequestNewChat, creatingChat: false })
  })

  it('does not render a pane marker or pane label for a single chat', () => {
    const { container } = render(<Sidebar />)

    const row = screen.getByText('Primary chat').closest<HTMLElement>('.session-row')!
    expect(row).not.toHaveClass('visible-in-split')
    expect(container.querySelector('.session-pane-marker')).not.toBeInTheDocument()
    expect(within(row).queryByText(/split pane/i)).not.toBeInTheDocument()
    expect(row).not.toHaveTextContent(/(?:^|\s)[12](?:\s|$)/)
  })

  it('opens Team Network from one labeled action and disables it during a profile switch', () => {
    const open = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', open)
    const { container } = render(<Sidebar />)
    const actions = container.querySelector<HTMLElement>('.sidebar-actions')!
    const buttons = within(actions).getAllByRole('button')
    const network = within(actions).getByRole('button', { name: 'Open Team Network' })

    expect(network).toHaveTextContent('Team Network')
    fireEvent.click(network)
    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'mail' })
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'Open Team Network',
      'Resume chat'
    ])

    act(() => useAppStore.setState({ switchingProfileId: profile.id }))
    expect(within(actions).getByRole('button', { name: 'Open Team Network' })).toBeDisabled()
    window.removeEventListener('agentsdock:open-teamspace', open)
  })

  it('opens the chat picker from Resume when local history import is supported', () => {
    useAppStore.setState({
      health: {
        ok: true,
        api_contract_version: 15,
        capabilities: {
          local_session_import_v1: {
            available: true,
            required: false,
            message: '',
            action: null,
            version: 1,
            max_batch_items: 25,
            max_list_items: 500
          }
        }
      }
    })
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume chat' }))

    expect(useAppStore.getState().modals.importChats).toBe(true)
    expect(useAppStore.getState().modals.resume).toBe(false)
  })

  it('groups folder creation and popup search beside the active chat count', () => {
    const { container } = render(<Sidebar />)
    const project = container.querySelector<HTMLElement>('.sidebar-project-header')!

    expect(within(project).getByText('2 chats')).toBeInTheDocument()
    expect(within(project).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Create folder',
      'Search chats'
    ])

    fireEvent.click(within(project).getByRole('button', { name: 'Search chats' }))
    expect(useAppStore.getState().modals.search).toBe(true)
    act(() => useAppStore.getState().setModal('search', false))

    fireEvent.click(within(project).getByRole('button', { name: 'Create folder' }))
    expect(useAppStore.getState().modals.folder).toBe(true)

    act(() => useAppStore.setState({ switchingProfileId: profile.id }))
    expect(within(project).getByRole('button', { name: 'Search chats' })).toBeDisabled()
    expect(within(project).getByRole('button', { name: 'Create folder' })).toBeDisabled()
  })

  it('routes the top plus button through guarded instant chat creation', () => {
    const requestNewChat = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ requestNewChat })
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    expect(requestNewChat).toHaveBeenCalledOnce()
  })

  it('uses singular chat-count copy and excludes archived chats', () => {
    useAppStore.setState({ sessions: [sessions[0], { ...sessions[1], archived: true }] })

    const { container } = render(<Sidebar />)
    const header = container.querySelector<HTMLElement>('.sidebar-project-header')!
    expect(within(header).getByText('1 chat')).toBeInTheDocument()
  })

  it('opens app settings from the footer instead of showing a chat count', () => {
    const { container } = render(<Sidebar />)
    const footer = container.querySelector<HTMLElement>('.sidebar-footer')!

    expect(within(footer).queryByText('2 chats')).not.toBeInTheDocument()
    const settings = within(footer).getByRole('button', { name: 'Open app settings' })
    expect(settings).toHaveTextContent('Settings')
    fireEvent.click(settings)
    expect(useAppStore.getState().modals.appSettings).toBe(true)

    act(() => useAppStore.setState({ switchingProfileId: profile.id }))
    expect(settings).toBeEnabled()
  })

  it('exposes pane positions to screen readers without visible number badges in a real split', () => {
    useAppStore.setState({
      selectedSessionId: sessions[1].id,
      chatPanes: { primary: sessions[0].id, secondary: sessions[1].id }
    })

    const { container } = render(<Sidebar />)
    const primaryRow = screen.getByText('Primary chat').closest<HTMLElement>('.session-row')!
    const secondaryRow = screen.getByText('Secondary chat').closest<HTMLElement>('.session-row')!

    expect(primaryRow).toHaveClass('visible-in-split')
    expect(secondaryRow).toHaveClass('selected')
    expect(within(primaryRow).getByText('First split pane')).toHaveClass('sr-only')
    expect(within(secondaryRow).getByText('Second split pane')).toHaveClass('sr-only')
    expect(container.querySelector('.session-pane-marker')).not.toBeInTheDocument()
    expect(primaryRow).not.toHaveTextContent(/(?:^|\s)1(?:\s|$)/)
    expect(secondaryRow).not.toHaveTextContent(/(?:^|\s)2(?:\s|$)/)
  })
})
