import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Job, Session } from '@shared/types'
import { navigableSessions, type SidebarGroupingOptions } from '../lib/sessions'
import { useAppStore } from '../store/app-store'
import { buildSections, resolveSidebarDrop, Sidebar } from './Sidebar'

const chat = (id: string, patch: Partial<Session> = {}): Session => ({ id, title: id, backend: 'codex', folder: 'Work', ...patch })
const groups = (sessions: Session[], active = new Set<string>(), folders: string[] = [], options: SidebarGroupingOptions = {}) =>
  buildSections(sessions, folders, '', new Set(), active, options).map(section => [section.id, section.sessions.map(session => session.id)])
const job = (sessionId: string, patch: Partial<Job> = {}): Job => ({ id: `job-${sessionId}`, session_id: sessionId, title: 'Scheduled task', prompt: 'Check', interval_seconds: 60, enabled: true, ...patch })

describe('sidebar status grouping', () => {
  it.each([
    [true, false, true, ['reply', 'running', 'cron', 'idle']],
    [true, true, true, ['cron', 'reply', 'running', 'idle']],
    [true, false, false, ['reply', 'cron', 'running', 'idle']],
    [true, true, false, ['cron', 'reply', 'running', 'idle']],
    [false, false, true, ['running', 'cron', 'reply', 'idle']],
    [false, true, true, ['running', 'cron', 'reply', 'idle']],
    [false, false, false, ['cron', 'reply', 'running', 'idle']],
    [false, true, false, ['cron', 'reply', 'running', 'idle']]
  ] as const)('keeps visible and keyboard order aligned for unread=%s cron=%s running=%s', (groupUnreadChats, includeCronInUnread, groupRunningChats, expected) => {
    const options = { groupUnreadChats, includeCronInUnread, groupRunningChats }
    const sessions = [
      chat('cron', { latest_agent_event_seq: 10, latest_non_job_agent_event_seq: 0 }),
      chat('reply', { latest_agent_event_seq: 9, latest_non_job_agent_event_seq: 9 }),
      chat('running', { manual_unread: true }), chat('idle')
    ]
    const active = new Set(['running'])
    const sections = buildSections(sessions, [], '', new Set(), active, options)
    expect(sections.flatMap(section => section.sessions.map(session => session.id))).toEqual(expected)
    expect(navigableSessions(sessions, [], new Set(), active, new Set(), false, options).map(session => session.id)).toEqual(expected)
    if (!groupRunningChats) {
      expect(sections.some(section => section.id === 'status:running')).toBe(false)
      expect(sections.find(section => section.sessions.some(session => session.id === 'running'))?.id).toBe('folder:Work')
    }
    if (!groupUnreadChats) expect(sections.some(section => section.id === 'status:unread')).toBe(false)
  })

  it('keeps cron-only unread output in folders and pins while prioritizing ordinary replies', () => {
    const sessions = [
      chat('cron', { folder: 'Schedules', latest_agent_event_seq: 12, latest_non_job_agent_event_seq: 2, last_read_agent_event_seq: 2 }),
      chat('reply', { latest_agent_event_seq: 9, latest_non_job_agent_event_seq: 9, last_read_agent_event_seq: 2 }),
      chat('cron-pinned', { pinned: true, latest_agent_event_seq: 6, latest_non_job_agent_event_seq: 0 }),
      chat('reply-pinned', { pinned: true, latest_agent_event_seq: 7, latest_non_job_agent_event_seq: 7 }),
      chat('running-cron', { latest_agent_event_seq: 8, latest_non_job_agent_event_seq: 0 })
    ]
    const original = structuredClone(sessions)
    expect(groups(sessions, new Set(['running-cron']))).toEqual([
      ['status:unread', ['reply', 'reply-pinned']], ['status:running', ['running-cron']],
      ['pinned', ['cron-pinned']], ['folder:Schedules', ['cron']]
    ])
    expect(navigableSessions(sessions, [], new Set(), new Set(['running-cron'])).map(session => session.id))
      .toEqual(['reply', 'reply-pinned', 'running-cron', 'cron-pinned', 'cron'])
    expect(navigableSessions(sessions, [], new Set(['Schedules']), new Set(['running-cron']), new Set(), true).map(session => session.id))
      .toEqual(['reply', 'reply-pinned', 'running-cron'])
    expect(sessions).toEqual(original)
  })

  it('retains an unread ordinary reply across later scheduled runs until the chat is read', () => {
    const mixed = chat('mixed', { latest_agent_event_seq: 30, latest_non_job_agent_event_seq: 10, last_read_agent_event_seq: 4 })
    expect(groups([mixed])).toEqual([['status:unread', ['mixed']]])
    const afterReadAndAnotherJob = { ...mixed, last_read_agent_event_seq: 30, latest_agent_event_seq: 40 }
    expect(groups([afterReadAndAnotherJob])).toEqual([['folder:Work', ['mixed']]])
    expect(groups([{ ...afterReadAndAnotherJob, latest_agent_event_seq: 50, latest_non_job_agent_event_seq: 50 }]))
      .toEqual([['status:unread', ['mixed']]])
    expect(groups([{ ...afterReadAndAnotherJob, manual_unread: true }])).toEqual([['status:unread', ['mixed']]])
    expect(groups([{ ...mixed, archived: true }])).toEqual([['archived', ['mixed']]])
  })

  it('preserves normal unread grouping without provenance or an associated job', () => {
    const unknown = chat('legacy', { latest_agent_event_seq: 12, last_read_agent_event_seq: 2 })
    expect(groups([unknown])).toEqual([['status:unread', ['legacy']]])
    expect(groups([{ ...unknown, latest_non_job_agent_event_seq: null }])).toEqual([['status:unread', ['legacy']]])
  })

  it('never promotes a read chat from recovered provenance alone', () => {
    const read = chat('read', { latest_agent_event_seq: 2, last_read_agent_event_seq: 2, latest_non_job_agent_event_seq: 12 })
    expect(groups([read])).toEqual([['folder:Work', ['read']]])
    expect(groups([read], new Set(), [], { includeCronInUnread: true })).toEqual([['folder:Work', ['read']]])
  })

  it('puts unread before running, without duplicating or mutating folders and pinned state', () => {
    const sessions = [chat('idle'), chat('running', { manual_unread: true }), chat('unread', { pinned: true, latest_agent_event_seq: 4, last_read_agent_event_seq: 2 }), chat('archived', { archived: true, manual_unread: true })]
    const original = structuredClone(sessions)
    expect(groups(sessions, new Set(['running', 'archived']))).toEqual([
      ['status:unread', ['unread']], ['status:running', ['running']], ['folder:Work', ['idle']], ['archived', ['archived']]
    ])
    expect(sessions).toEqual(original)
  })

  it('returns a completed read chat to its folder or pinned section and hides empty status groups', () => {
    const session = chat('chat', { latest_agent_event_seq: 5, last_read_agent_event_seq: 2 })
    expect(groups([session], new Set(['chat']))).toEqual([['status:running', ['chat']]])
    expect(groups([session])).toEqual([['status:unread', ['chat']]])
    const read = { ...session, last_read_agent_event_seq: 5 }
    expect(groups([read])).toEqual([['folder:Work', ['chat']]])
    expect(groups([{ ...read, pinned: true }])).toEqual([['pinned', ['chat']]])
    expect(groups([], new Set(['missing']), ['Empty'])).toEqual([['folder:Empty', []]])
  })

  it('keeps real folders named Unread and Running independent, preserving all provider ordering', () => {
    const sessions = [
      chat('claude', { backend: 'claude', manual_unread: true }),
      chat('cursor', { backend: 'cursor', manual_unread: true }),
      chat('opencode', { backend: 'opencode', manual_unread: true }),
      chat('gemini', { backend: 'gemini', manual_unread: true }),
      chat('real-unread', { folder: 'Unread' }), chat('real-running', { folder: 'Running' })
    ]
    expect(groups(sessions, new Set(), ['Unread', 'Running'])).toEqual([
      ['status:unread', ['claude', 'cursor', 'opencode', 'gemini']], ['folder:Unread', ['real-unread']], ['folder:Running', ['real-running']]
    ])
    expect(buildSections(sessions, [], 'claude', new Set(), new Set(['claude'])).map(section => section.id)).toEqual(['search'])
  })

  it('does not reorder status groups or move chats into them, but permits an explicit move out', () => {
    for (const status of ['status:unread', 'status:running']) {
      for (const from of ['folder:Work', status]) {
        expect(resolveSidebarDrop('session:a', { type: 'session', section: from }, 'session:b', { type: 'session', section: status }, { id: 'session:b', placement: 'after' }, ['Work'])).toBeNull()
      }
      expect(resolveSidebarDrop('session:a', { type: 'session', section: status }, 'session:b', { type: 'session', section: 'folder:Work' }, { id: 'session:b', placement: 'after' }, ['Work'])).toEqual({ kind: 'move-session', sessionId: 'a', folder: 'Work' })
    }
  })

  it('matches keyboard navigation to visible status and folder groups', () => {
    const sessions = [chat('idle'), chat('running'), chat('unread', { manual_unread: true }), chat('archived', { archived: true })]
    expect(navigableSessions(sessions, [], new Set(), new Set(['running'])).map(session => session.id)).toEqual(['unread', 'running', 'idle'])
    expect(navigableSessions(sessions, [], new Set(['Work']), new Set(['running']), new Set(['unread'])).map(session => session.id)).toEqual(['running'])
  })
})

describe('sidebar status controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn((_key, fallback) => Promise.resolve(fallback)), set: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ ...useAppStore.getInitialState(),
      sessions: [chat('Idle chat'), chat('Running chat'), chat('Unread chat', { manual_unread: true }), chat('Real folder chat', { folder: 'Unread' })],
      activeSessionIds: new Set(['Running chat']), folderOrder: ['Work', 'Unread'],
      activeProfileId: 'profile-a', profileGeneration: 1,
      prefetchSession: vi.fn().mockResolvedValue(undefined)
    }, true)
  })
  afterEach(() => { cleanup(); useAppStore.setState(useAppStore.getInitialState(), true); vi.restoreAllMocks() })

  it('updates legacy cron grouping and keyboard order as jobs arrive or change without altering unread state', async () => {
    const cron = chat('Forwarding', { backend: 'claude', folder: 'Schedules', latest_agent_event_seq: 20, last_read_agent_event_seq: 3 })
    const reply = chat('Ordinary reply', { latest_agent_event_seq: 10 })
    const idle = chat('Idle')
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [cron, reply, idle], jobs: [], activeSessionIds: new Set(),
      selectedSessionId: cron.id, folderOrder: ['Schedules', 'Work'], selectSession })
    const original = useAppStore.getState().sessions
    render(<Sidebar />)
    const row = (name: string) => screen.getByText(name).closest('.session-row')!
    expect(row(cron.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    act(() => useAppStore.setState({ jobs: [job(cron.id)] }))
    expect(row(cron.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Schedules')
    expect(row(cron.title).querySelector('.status-dot')).toHaveClass('unread')
    expect(row(reply.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    await act(async () => useAppStore.getState().selectAdjacent(1))
    expect(selectSession).toHaveBeenLastCalledWith(idle.id)
    act(() => useAppStore.getState().setIncludeCronInUnread(true))
    expect(row(cron.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    await act(async () => useAppStore.getState().selectAdjacent(1))
    expect(selectSession).toHaveBeenLastCalledWith(reply.id)
    act(() => useAppStore.getState().setIncludeCronInUnread(false))
    act(() => useAppStore.setState({ jobs: [job(reply.id, { enabled: false })] }))
    expect(row(cron.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(row(reply.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Work')
    act(() => useAppStore.setState({ jobs: [] }))
    expect(row(reply.title).closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(useAppStore.getState().sessions).toBe(original)
  })

  it('keeps unknown cron chats pinned and respects collapsed folders in keyboard navigation', () => {
    const cron = chat('cron', { pinned: true, latest_agent_event_seq: 10, latest_non_job_agent_event_seq: null })
    const scheduled = chat('scheduled', { folder: 'Schedules', latest_agent_event_seq: 12 })
    const reply = chat('reply', { latest_agent_event_seq: 15 })
    const options = { jobSessionIds: new Set(['cron', 'scheduled']) }
    expect(groups([cron, scheduled, reply], new Set(), [], options)).toEqual([
      ['status:unread', ['reply']], ['pinned', ['cron']], ['folder:Schedules', ['scheduled']]
    ])
    expect(navigableSessions([cron, scheduled, reply], [], new Set(['Schedules']), new Set(), new Set(), true, options)).toEqual([reply])
  })

  it('keeps dots and activity visible while changing each server-scoped grouping option', () => {
    const cron = chat('Cron result', { folder: 'Schedules', latest_agent_event_seq: 20, latest_non_job_agent_event_seq: 0 })
    const setScoped = vi.fn().mockResolvedValue(undefined)
    window.agentsDock.preferences.setScoped = setScoped
    useAppStore.setState(state => ({ sessions: [...state.sessions, cron] }))
    const original = useAppStore.getState().sessions
    const { container } = render(<Sidebar />)
    const cronRow = () => screen.getByText(cron.title).closest('.session-row')!
    const runningRow = () => screen.getByText('Running chat').closest('.session-row')!
    const scope = { profileId: 'profile-a', profileGeneration: 1, serverIdentity: null }
    act(() => useAppStore.getState().setIncludeCronInUnread(true))
    expect(cronRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(setScoped).toHaveBeenLastCalledWith(scope, 'includeCronInUnread', true)
    act(() => useAppStore.getState().setGroupUnreadChats(false))
    expect(container.querySelector('[data-section-id="status:unread"]')).toBeNull()
    expect(cronRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Schedules')
    expect(cronRow().querySelector('.status-dot')).toHaveClass('unread')
    expect(setScoped).toHaveBeenLastCalledWith(scope, 'groupUnreadChats', false)
    act(() => useAppStore.getState().setGroupRunningChats(false))
    expect(container.querySelector('[data-section-id="status:running"]')).toBeNull()
    expect(runningRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Work')
    expect(runningRow().querySelector('.status-dot')).toHaveClass('running')
    expect(setScoped).toHaveBeenLastCalledWith(scope, 'groupRunningChats', false)
    expect(useAppStore.getState().sessions).toBe(original)
    expect(useAppStore.getState().activeSessionIds).toEqual(new Set(['Running chat']))
    act(() => useAppStore.getState().setGroupUnreadChats(true))
    expect(cronRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(runningRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Work')
    act(() => useAppStore.getState().setIncludeCronInUnread(false))
    expect(cronRow().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Schedules')
  })

  it('keeps a cron result unread in its folder and responds when an ordinary reply arrives', () => {
    const cron = chat('Cron result', { folder: 'Schedules', latest_agent_event_seq: 20, latest_non_job_agent_event_seq: 0, last_read_agent_event_seq: 3 })
    useAppStore.setState(state => ({ sessions: [...state.sessions, cron], selectedSessionId: cron.id }))
    const { container } = render(<Sidebar />)
    const row = () => screen.getByText(cron.title).closest('.session-row')!
    expect(row()).toHaveClass('unread', 'selected')
    expect(row().querySelector('.status-dot')).toHaveClass('unread')
    expect(row().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Schedules')
    expect(container.querySelector('[data-section-id="status:unread"]')).not.toBeNull()
    act(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === cron.id
      ? { ...session, latest_agent_event_seq: 25, latest_non_job_agent_event_seq: 25 } : session) })))
    expect(row().closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(row()).toHaveClass('unread', 'selected')
  })

  it('shows status dots and rightmost chevrons; collapse does not write server preferences', () => {
    const { container } = render(<Sidebar />)
    const unread = container.querySelector<HTMLElement>('[data-section-id="status:unread"]')!
    const running = container.querySelector<HTMLElement>('[data-section-id="status:running"]')!
    expect(unread.querySelector('.section-status-dot')).toHaveClass('unread')
    expect(running.querySelector('.section-status-dot')).toHaveClass('running')
    for (const section of [unread, running, container.querySelector<HTMLElement>('[data-section-id="folder:Work"]')!]) {
      const header = section.querySelector('button')!
      expect(header.lastElementChild).toHaveClass('section-chevron')
      expect(header).toHaveAttribute('aria-expanded', 'true')
      expect(header).not.toHaveAttribute('aria-disabled', 'true')
    }
    fireEvent.click(within(unread).getByRole('button', { name: 'Unread' }))
    expect(screen.queryByText('Unread chat')).not.toBeInTheDocument()
    expect(screen.getByText('Real folder chat')).toBeInTheDocument()
    expect(within(unread).getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(within(running).getByRole('button', { name: 'Running' }))
    expect(screen.queryByText('Running chat')).not.toBeInTheDocument()
    fireEvent.click(within(unread).getByRole('button', { name: 'Unread' }))
    expect(screen.getByText('Unread chat')).toBeInTheDocument()
    expect(window.agentsDock.preferences.set).not.toHaveBeenCalled()
    expect(useAppStore.getState().collapsedFolders.size).toBe(0)
  })

  it('reacts to live active and read-state changes without losing the selected row', () => {
    useAppStore.setState({ selectedSessionId: 'Running chat' })
    const { container } = render(<Sidebar />)
    act(() => useAppStore.setState(state => ({ activeSessionIds: new Set(), sessions: state.sessions.map(session => session.id === 'Running chat' ? { ...session, manual_unread: true } : session) })))
    expect(container.querySelector('[data-section-id="status:running"]')).toBeNull()
    expect(screen.getByText('Running chat').closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:unread')
    expect(screen.getByText('Running chat').closest('.session-row')).toHaveClass('selected')
    act(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, manual_unread: false })) })))
    expect(container.querySelector('[data-section-id="status:unread"]')).toBeNull()
    expect(screen.getByText('Running chat').closest('.sidebar-section')).toHaveAttribute('data-section-id', 'folder:Work')
  })

  it('collapses pinned independently of folders and status groups and persists its own preference', () => {
    useAppStore.setState(state => ({ sessions: [...state.sessions,
      chat('Pinned chat', { pinned: true }), chat('Same-name folder chat', { folder: 'Pinned' })
    ] }))
    const { container } = render(<Sidebar />)
    const pinned = container.querySelector<HTMLElement>('[data-section-id="pinned"]')!
    const header = within(pinned).getByRole('button', { name: 'Pinned' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(header.lastElementChild).toHaveClass('section-chevron')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Pinned chat')).not.toBeInTheDocument()
    expect(screen.getByText('Same-name folder chat')).toBeInTheDocument()
    expect(screen.getByText('Running chat')).toBeInTheDocument()
    expect(useAppStore.getState().collapsedFolders.size).toBe(0)
    expect(window.agentsDock.preferences.set).toHaveBeenLastCalledWith('pinnedCollapsed', true)
    fireEvent.click(header)
    expect(screen.getByText('Pinned chat')).toBeInTheDocument()
    expect(window.agentsDock.preferences.set).toHaveBeenLastCalledWith('pinnedCollapsed', false)
    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('skips collapsed pinned chats in keyboard navigation but still includes pinned status chats', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState(state => ({ sessions: [...state.sessions,
      chat('Pinned chat', { pinned: true }), chat('Unread pinned chat', { pinned: true, manual_unread: true })
    ], selectedSessionId: 'Running chat', selectSession }))
    const { container } = render(<Sidebar />)
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenLastCalledWith('Pinned chat')
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-section-id="pinned"]')!).getByRole('button', { name: 'Pinned' }))
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenLastCalledWith('Idle chat')
    act(() => useAppStore.setState({ selectedSessionId: 'Unread chat' }))
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenLastCalledWith('Unread pinned chat')
  })

  it('scopes the pinned preference to its server and retains it while pinned chats temporarily run', () => {
    const setScoped = vi.fn().mockResolvedValue(undefined)
    window.agentsDock.preferences.setScoped = setScoped
    useAppStore.setState(state => ({ sessions: [...state.sessions, chat('Pinned chat', { pinned: true })] }))
    const { container } = render(<Sidebar />)
    fireEvent.click(within(container.querySelector<HTMLElement>('[data-section-id="pinned"]')!).getByRole('button', { name: 'Pinned' }))
    expect(setScoped).toHaveBeenCalledWith({ profileId: 'profile-a', profileGeneration: 1, serverIdentity: null }, 'pinnedCollapsed', true)
    expect(window.agentsDock.preferences.set).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ activeSessionIds: new Set(['Pinned chat']) }))
    expect(container.querySelector('[data-section-id="pinned"]')).toBeNull()
    expect(screen.getByText('Pinned chat').closest('.sidebar-section')).toHaveAttribute('data-section-id', 'status:running')
    act(() => useAppStore.setState({ activeSessionIds: new Set() }))
    expect(container.querySelector('[data-section-id="pinned"] button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Pinned chat')).not.toBeInTheDocument()
  })

  it('uses the new visible order for next-chat commands and blocks toggles during a server switch', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectedSessionId: 'Unread chat', selectSession })
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenLastCalledWith('Running chat')
    useAppStore.getState().toggleStatusGroup('running')
    await useAppStore.getState().selectAdjacent(1)
    expect(selectSession).toHaveBeenLastCalledWith('Idle chat')
    useAppStore.setState({ switchingProfileId: 'profile-b' })
    useAppStore.getState().toggleStatusGroup('unread')
    expect(useAppStore.getState().collapsedStatusGroups).toEqual(new Set(['running']))
  })
})
