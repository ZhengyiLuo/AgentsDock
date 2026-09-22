import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { Sidebar } from './Sidebar'

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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('profile-scoped sidebar position', () => {
  it('restores the active profile scroll and joins the switch flush', async () => {
    const get = vi.fn().mockResolvedValue(42)
    const set = vi.fn().mockResolvedValue(undefined)
    const status = vi.fn().mockResolvedValue({ currentVersion: '1.0.0-beta.7' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { preferences: { get, set }, updates: { status } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 3,
      switchingProfileId: null,
      sessions: [],
      selectedSessionId: null,
      folderOrder: [],
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      runtimeCatalog: null
    })

    const toggleSidebar = vi.fn()
    window.addEventListener('agentsdock:toggle-sidebar', toggleSidebar)
    const { container } = render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Resume chat' })).toHaveTextContent('Resume')
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat list' }))
    expect(toggleSidebar).toHaveBeenCalledOnce()
    const list = container.querySelector<HTMLDivElement>('.session-list')!
    await waitFor(() => expect(list.scrollTop).toBe(42))
    expect(screen.getByTitle('AgentsDock v1.0.0-beta.7')).toHaveTextContent('v1.0.0-beta.7')
    expect(status).toHaveBeenCalledOnce()

    list.scrollTop = 91
    fireEvent.scroll(list)
    const pending: Promise<unknown>[] = []
    await act(async () => {
      window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', {
        detail: { waitUntil: (value: PromiseLike<unknown>) => pending.push(Promise.resolve(value)) }
      }))
      await Promise.all(pending)
    })

    expect(get).toHaveBeenCalledWith('sidebarScrollTop:v1', 0)
    expect(set).toHaveBeenCalledWith('sidebarScrollTop:v1', 91)
    window.removeEventListener('agentsdock:toggle-sidebar', toggleSidebar)
  })

  it('does not prefetch timelines for rows passing beneath the pointer while scrolling', async () => {
    vi.useFakeTimers()
    const originalPrefetchSession = useAppStore.getState().prefetchSession
    const prefetchSession = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { preferences: { get: vi.fn().mockResolvedValue(0), set: vi.fn().mockResolvedValue(undefined) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 3,
      switchingProfileId: null,
      sessions: Array.from({ length: 160 }, (_, index) => ({
        id: `chat-${index}`,
        title: `Chat ${index}`,
        backend: 'codex' as const,
        folder: 'General'
      })),
      selectedSessionId: 'chat-0',
      folderOrder: ['General'],
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      runtimeCatalog: null,
      prefetchSession
    })

    const { container } = render(<Sidebar />)
    const list = container.querySelector<HTMLDivElement>('.session-list')!
    const row = screen.getByText('Chat 80').closest<HTMLElement>('.session-row')!
    list.scrollTop = 1_000
    fireEvent.scroll(list)
    fireEvent.mouseEnter(row)
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(prefetchSession).not.toHaveBeenCalled()

    fireEvent.mouseEnter(row)
    await act(async () => vi.advanceTimersByTimeAsync(180))
    expect(prefetchSession).toHaveBeenCalledOnce()
    expect(prefetchSession).toHaveBeenCalledWith('chat-80')
    useAppStore.setState({ prefetchSession: originalPrefetchSession })
  })
})
