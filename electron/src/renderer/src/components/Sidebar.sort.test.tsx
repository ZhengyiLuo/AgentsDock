import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { navigableSessions, normalizeSidebarSortMode, sortSidebarSessions } from '../lib/sessions'
import { useAppStore } from '../store/app-store'
import { buildSections, Sidebar } from './Sidebar'

const chat = (id: string, patch: Partial<Session> = {}): Session => ({ id, title: id, backend: 'codex', folder: 'Work', ...patch })
const sessions = [
  chat('ten', { title: 'Chat 10', folder: 'A', latest_agent_event_at: '2026-10-30T00:00:00Z' }),
  chat('two', { title: 'Chat 2', folder: 'B', latest_agent_event_at: '2026-10-31T00:00:00Z' }),
  chat('unread', { title: 'Z unread', manual_unread: true }),
  chat('running', { title: 'Z running', pinned: true, manual_unread: true }),
  chat('pin', { title: 'Z pin', pinned: true }),
  chat('archive', { title: 'A archive', archived: true })
]
const active = new Set(['running'])

describe('sidebar display sorting', () => {
  it.each(['latest', 'name'] as const)('flattens folders in %s without changing status, pin or archive membership', mode => {
    const before = structuredClone(sessions)
    const sections = buildSections(sessions, ['A', 'B', 'Empty'], '', new Set(), active, { sortMode: mode })
    expect(sections.map(s => s.id)).toEqual(['status:unread', 'status:running', 'pinned', 'sorted', 'archived'])
    expect(sections.map(s => s.sessions.map(s => s.id))).toEqual([['unread'], ['running'], ['pin'], ['two', 'ten'], ['archive']])
    expect(sessions).toEqual(before)
    expect(buildSections(sessions, ['A', 'B'], '', new Set(), active).map(s => s.id))
      .toEqual(['status:unread', 'status:running', 'pinned', 'folder:A', 'folder:B', 'archived'])
  })

  it('uses last reply, falls back safely and breaks equal timestamps deterministically', () => {
    const values = [chat('missing', { updated_at: '2026-11-01' }),
      chat('fallback', { latest_agent_event_at: 'invalid', created_at: '2026-10-29', latest_event_at: '2026-11-01' }),
      chat('b', { created_at: '2026-10-30' }), chat('a', { latest_agent_event_at: '2026-10-30', updated_at: '2026-10-31' })]
    expect(sortSidebarSessions(values, 'latest').map(s => s.id)).toEqual(['a', 'b', 'fallback', 'missing'])
    expect(sortSidebarSessions(values, 'default')).toBe(values)
    expect(sortSidebarSessions([chat('z', { title: 'Alpha' }), chat('a', { title: 'alpha' })], 'name').map(s => s.id)).toEqual(['a', 'z'])
    expect(normalizeSidebarSortMode('oldest')).toBe('default')
    expect(normalizeSidebarSortMode(undefined)).toBe('default')
  })

  it('does not promote a chat when opened, read, renamed or sent a prompt without a reply', () => {
    const old = chat('old', { latest_agent_event_at: '2026-10-29', created_at: '2026-10-28' })
    const recent = chat('recent', { latest_agent_event_at: '2026-10-30' })
    const opened = { ...old, latest_event_at: '2026-10-31', updated_at: '2026-10-31', last_read_agent_event_seq: 20 }
    expect(sortSidebarSessions([opened, recent], 'latest').map(s => s.id)).toEqual(['recent', 'old'])
    expect(sortSidebarSessions([{ ...opened, latest_agent_event_at: '2026-11-01' }, recent], 'latest').map(s => s.id)).toEqual(['old', 'recent'])
  })

  it.each(['default', 'latest', 'name'] as const)('matches keyboard order in %s, with hidden folders and status groups collapsed', sortMode => {
    const options = { sortMode }
    const visible = buildSections(sessions, ['A', 'B'], '', new Set(), active, options)
      .filter(s => s.id !== 'status:unread' && s.id !== 'pinned' && s.id !== 'archived' && s.id !== 'folder:B')
      .flatMap(s => s.sessions)
    expect(navigableSessions(sessions, ['A', 'B'], new Set(['B']), active, new Set(['unread']), true, options)).toEqual(visible)
  })

  it('retains search ranking and grouping settings instead of reclassifying matching or disabled groups', () => {
    expect(buildSections(sessions, [], 'Chat', new Set(), active, { sortMode: 'name' })[0].sessions.map(s => s.id)).toEqual(['ten', 'two'])
    expect(buildSections(sessions, [], '', new Set(), active, { sortMode: 'name', groupUnreadChats: false, groupRunningChats: false }).map(s => s.id))
      .toEqual(['pinned', 'sorted', 'archived'])
  })
})

describe('sidebar sorting control', () => {
  beforeEach(() => {
    setLocale('en')
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn((_key, fallback) => Promise.resolve(fallback)), set: vi.fn().mockResolvedValue(undefined), setScoped: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ ...useAppStore.getInitialState(), sessions, activeSessionIds: active,
      activeProfileId: 'profile-a', profileGeneration: 4, folderOrder: ['A', 'B'], collapsedFolders: new Set(['B']),
      selectedSessionId: 'two', prefetchSession: vi.fn().mockResolvedValue(undefined) })
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); setLocale('en'); useAppStore.setState(useAppStore.getInitialState()); vi.restoreAllMocks() })

  const openWithKeyboard = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Sort by' }), { key: 'ArrowDown' })

  it('offers only three radio choices, preserves selection and manual order, and persists by server', async () => {
    const { container } = render(<Sidebar />)
    const count = container.querySelector('.sidebar-project-label')!
    expect(count.nextElementSibling).toBe(screen.getByRole('button', { name: 'Sort by' }))
    expect(screen.getByRole('button', { name: 'Sort by' }).querySelector('.lucide-arrow-up-down')).not.toBeNull()
    expect(container.querySelector('.sidebar-project-actions .sidebar-sort-trigger')).toBeNull()
    openWithKeyboard()
    expect(await screen.findByRole('menuitemradio', { name: 'Folders' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'Latest' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Name' }))
    expect(useAppStore.getState().sidebarSortMode).toBe('name')
    expect(container.querySelector('.sidebar-sort-feedback')).toHaveTextContent('By Name')
    expect(container.querySelector('[data-section-id^="folder:"]')).toBeNull()
    expect(container.querySelector('[data-section-id="pinned"] + .sidebar-section')).toHaveAttribute('data-section-id', 'sorted')
    expect([...container.querySelectorAll('[data-section-id="sorted"] strong')].map(e => e.textContent)).toEqual(['Chat 2', 'Chat 10'])
    expect(screen.getByText('Chat 2').closest('.session-row')).toHaveClass('selected')
    expect(screen.getByText('Chat 2').closest('.session-row')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Chat 2').closest('.session-row')).not.toHaveAttribute('aria-roledescription', 'draggable')
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledWith({ profileId: 'profile-a', profileGeneration: 4, serverIdentity: null }, 'sidebarSortMode', 'name')
    expect(useAppStore.getState().sessions).toEqual(sessions)
    expect(useAppStore.getState().folderOrder).toEqual(['A', 'B'])
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    openWithKeyboard()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Folders' }))
    await waitFor(() => expect(container.querySelector('[data-section-id="folder:B"] button')).toHaveAttribute('aria-expanded', 'false'))
  })

  it('cycles all three modes with repeated clicks without opening a menu or double advancing', () => {
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    for (const mode of ['latest', 'name', 'default']) {
      const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      fireEvent(button, down)
      expect(down.defaultPrevented).toBe(true)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      fireEvent.click(button)
      expect(useAppStore.getState().sidebarSortMode).toBe(mode)
      expect(button).toHaveAttribute('data-sort-mode', mode)
      expect(button).toHaveFocus()
    }
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledTimes(3)
    expect(useAppStore.getState().sessions).toEqual(sessions)
    expect(useAppStore.getState().selectedSessionId).toBe('two')
  })

  it('shows the current choice beside the button for two seconds and restarts the timer on each click', async () => {
    vi.useFakeTimers()
    const { container, unmount } = render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    const feedback = container.querySelector('.sidebar-sort-feedback')!
    expect(button.nextElementSibling).toBe(feedback)
    expect(feedback).toHaveAttribute('role', 'status')
    expect(feedback).toHaveAttribute('aria-live', 'polite')
    expect(feedback).toBeEmptyDOMElement()
    fireEvent.click(button)
    expect(feedback).toHaveTextContent('By Latest')
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    fireEvent.click(button)
    expect(feedback).toHaveTextContent('By Name')
    await act(async () => vi.advanceTimersByTimeAsync(1_001))
    expect(feedback).toHaveTextContent('By Name')
    await act(async () => vi.advanceTimersByTimeAsync(998))
    expect(feedback).toHaveTextContent('By Name')
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(feedback).toBeEmptyDOMElement()
    expect(button).toHaveAttribute('data-sort-mode', 'name')
    fireEvent.click(button)
    expect(feedback).toHaveTextContent('By Folders')
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(vi.mocked(window.agentsDock.preferences.setScoped).mock.calls.filter(([, key]) => key === 'sidebarSortMode')).toHaveLength(3)
  })

  it('suppresses pointer focus decoration without removing keyboard focus or focus restoration', async () => {
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    fireEvent.click(button, { detail: 1 })
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('data-pointer-focus', 'true')
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(button).not.toHaveAttribute('data-pointer-focus')
    expect(button).toHaveFocus()
    openWithKeyboard()
    const choice = await screen.findByRole('menuitemradio', { name: 'Folders' })
    fireEvent.pointerUp(choice)
    fireEvent.click(choice)
    await waitFor(() => expect(button).toHaveFocus())
    expect(button).toHaveAttribute('data-pointer-focus', 'true')
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(button).toHaveFocus())
    expect(button).not.toHaveAttribute('data-pointer-focus')
  })

  it('localizes keyboard feedback and clears it when the selected server changes or the control is disabled', () => {
    const { container } = render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(container.querySelector('.sidebar-sort-feedback')).toHaveTextContent('By Latest')
    act(() => setLocale('zh-CN'))
    expect(container.querySelector('.sidebar-sort-feedback')).toHaveTextContent('按最近排序')
    act(() => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 5, sidebarSortMode: 'name' }))
    expect(container.querySelector('.sidebar-sort-feedback')).toBeEmptyDOMElement()
    fireEvent.keyDown(screen.getByRole('button', { name: '排序方式' }), { key: ' ' })
    expect(container.querySelector('.sidebar-sort-feedback')).toHaveTextContent('按文件夹排序')
    act(() => useAppStore.setState({ switchingProfileId: 'profile-a' }))
    expect(container.querySelector('.sidebar-sort-feedback')).toBeEmptyDOMElement()
    act(() => useAppStore.setState({ switchingProfileId: null }))
    expect(container.querySelector('.sidebar-sort-feedback')).toBeEmptyDOMElement()
  })

  it('cycles with Enter/Space, ignores key-repeat and opens choices with ArrowDown', async () => {
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(useAppStore.getState().sidebarSortMode).toBe('latest')
    fireEvent.keyDown(button, { key: 'Enter', repeat: true })
    expect(useAppStore.getState().sidebarSortMode).toBe('latest')
    fireEvent.keyDown(button, { key: ' ' })
    expect(useAppStore.getState().sidebarSortMode).toBe('name')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    openWithKeyboard()
    expect(await screen.findByRole('menuitemradio', { name: 'Name' })).toHaveAttribute('aria-checked', 'true')
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledTimes(2)
  })

  it('cycles safely from an open hover menu and still allows a direct hover choice', async () => {
    vi.useFakeTimers()
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'Sort by' })
    const hover = async () => {
      const enter = new Event('pointerover', { bubbles: true })
      Object.defineProperty(enter, 'pointerType', { value: 'mouse' })
      fireEvent(button, enter)
      await act(async () => vi.advanceTimersByTimeAsync(220))
    }
    await hover()
    expect(screen.getByRole('menuitemradio', { name: 'Folders' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(button)
    expect(useAppStore.getState().sidebarSortMode).toBe('latest')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.pointerLeave(button)
    await hover()
    expect(screen.getByRole('menuitemradio', { name: 'Latest' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Folders' }))
    expect(useAppStore.getState().sidebarSortMode).toBe('default')
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledTimes(2)
  })

  it('opens on mouse hover and closes after leaving without persisting a choice', async () => {
    vi.useFakeTimers()
    render(<Sidebar />)
    // jsdom has no PointerEvent constructor; provide the native mouse type.
    const enter = new Event('pointerover', { bubbles: true })
    Object.defineProperty(enter, 'pointerType', { value: 'mouse' })
    fireEvent(screen.getByRole('button', { name: 'Sort by' }), enter)
    await act(async () => vi.advanceTimersByTimeAsync(220))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerLeave(screen.getByRole('menu'))
    await act(async () => vi.advanceTimersByTimeAsync(220))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(window.agentsDock.preferences.setScoped).not.toHaveBeenCalled()
    expect(screen.queryByText(/^By /)).not.toBeInTheDocument()
  })

  it('closes and blocks changes while switching servers, and navigates by the chosen order', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ sidebarSortMode: 'name', selectSession })
    render(<Sidebar />)
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenCalledWith('ten')
    openWithKeyboard()
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Sort by' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Sort by' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Sort by' }), { key: 'Enter' })
    act(() => useAppStore.getState().setSidebarSortMode('latest'))
    expect(useAppStore.getState().sidebarSortMode).toBe('name')
  })
})
