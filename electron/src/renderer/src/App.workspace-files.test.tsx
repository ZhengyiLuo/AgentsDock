import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session, WorkspaceFile } from '@shared/types'
import { App } from './App'
import { resetWorkspaceEditorMemoryForTests } from './components/WorkspaceEditor'
import { WorkspaceFilesHost, workspaceFilesKey } from './components/WorkspaceFilesContext'
import { handleMenuCommand, useAppStore } from './store/app-store'
import { requestOpenWorkspaceReference } from './lib/workspace-file-links'

vi.mock('./components/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./components/ChatHeader', () => ({ ChatHeader: () => null }))
vi.mock('./components/Timeline', () => ({ Timeline: ({ sessionId }: { sessionId?: string }) => {
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const owner = sessionId ?? selectedSessionId!
  return <><p>Timeline {owner}</p>{['previous.ts', 'example.ts'].map(path => <a key={path} href={`agentsdock-workspace:${path}`} onClick={event => {
    event.preventDefault()
    requestOpenWorkspaceReference(owner, { path })
  }}>Open {path} from {owner}</a>)}</>
} }))
vi.mock('./components/Composer', () => ({ Composer: ({ sessionId }: { sessionId: string }) => <textarea aria-label={`Draft ${sessionId}`} defaultValue={`Draft for ${sessionId}`} /> }))
vi.mock('./components/Dialogs', () => ({ Dialogs: () => null }))
vi.mock('./components/InspectorDock', () => ({ InspectorDock: ({ content }: any) => content }))
vi.mock('./components/InspectorWorkspace', () => ({ InspectorWorkspace: ({ session, scope, tab }: any) => tab === 'files'
  ? <WorkspaceFilesHost owner={workspaceFilesKey(scope, session.id, session.cwd)} /> : null }))
vi.mock('./components/SideChatPopover', () => ({ SideChatPopover: () => null }))
vi.mock('./components/TerminalDock', () => ({ TerminalDock: () => null }))
vi.mock('./components/WorkspaceResizeHandles', async importOriginal => ({ ...await importOriginal<typeof import('./components/WorkspaceResizeHandles')>(), WorkspaceResizeHandles: () => null }))
vi.mock('./lib/renderer-stall-monitor', () => ({ installRendererStallMonitor: () => () => undefined }))
vi.mock('./components/CodeMirrorEditor', () => ({ CodeMirrorEditor: ({ value, ariaLabel, readOnly, onChange }: any) => <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value, 1)} /> }))

const sessions: Session[] = [
  { id: 'chat-a', title: 'Chat A', backend: 'codex', cwd: '/work/alpha' },
  { id: 'chat-b', title: 'Chat B', backend: 'claude', cwd: '/work/beta' }
]

describe('App split workspace files', () => {
  beforeEach(() => {
    localStorage.clear()
    resetWorkspaceEditorMemoryForTests()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        events: { on: vi.fn().mockReturnValue(() => undefined) },
        updates: { status: vi.fn().mockResolvedValue(null) },
        native: { log: vi.fn().mockResolvedValue(undefined), readyForNotifications: vi.fn().mockResolvedValue(true), readyForSecurePeerInvite: vi.fn().mockResolvedValue(true) },
        preferences: {
          get: vi.fn((_key, fallback) => Promise.resolve(fallback)), set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn((_scope, _key, fallback) => Promise.resolve(fallback)), setScoped: vi.fn().mockResolvedValue(undefined)
        },
        workspace: {
          entries: vi.fn((sessionId: string) => Promise.resolve({ root: sessions.find(session => session.id === sessionId)!.cwd, path: '', entries: [{ name: 'example.ts', path: 'example.ts', kind: 'file' }], has_more: false })),
          search: vi.fn().mockResolvedValue({ root: '/work/alpha', query: '', entries: [{ name: 'example.ts', path: 'example.ts', kind: 'file' }], scanned: 1, truncated: false, limit: 100 }),
          read: vi.fn((sessionId: string, path: string) => Promise.resolve({ root: sessions.find(session => session.id === sessionId)!.cwd, path, name: path, content: `Content from ${sessionId}`, revision: 'rev-1', size: 19, mtime_ns: 1, writable: true })),
          mediaURL: vi.fn((_profileId, _generation, sessionId, path) => `agentsdock-media://workspace/profile-a/4/${sessionId}/${path}`)
        },
        files: {
          cancelReadText: vi.fn().mockResolvedValue(true),
          mediaURL: vi.fn((_profileId, _generation, sessionId, id) => `agentsdock-media://file/profile-a/4/${sessionId}/${id}`)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true, initialize: vi.fn().mockResolvedValue(undefined),
      profiles: [{ id: 'profile-a', name: 'Alpha', serverUrl: 'https://alpha.example:7850', serverIdentity: 'server-a', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
      activeProfileId: 'profile-a', profileGeneration: 4, switchingProfileId: null, sessions,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'primary',
      chatPaneCount: 2, activeChatWorkspaceId: 'workspace-a',
      chatWorkspaces: [{ id: 'workspace-a', panes: { primary: 'chat-a', secondary: 'chat-b' }, focusedPane: 'primary', paneCount: 2, columnRatio: 0.5, rowRatio: 0.5 }],
      inspectorVisible: false, health: { ok: true, capabilities: { workspace_files: { available: true, version: 6, required: false, message: '', action: null } } },
      error: null, storageFull: false, uploadsBySession: {}, uploadPathsBySession: {}
    })
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('cycles workspace tabs with Command-Control arrows while preserving drafts', async () => {
    const first = useAppStore.getState().chatWorkspaces[0]
    useAppStore.setState({ chatWorkspaces: [first, { ...first, id: 'workspace-b', title: 'Second workspace' }] })
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-a' }), { target: { value: 'Keep typed draft' } })
    const chord = { metaKey: true, ctrlKey: true }
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Draft chat-a' }), { key: 'ArrowRight', ...chord }))
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('workspace-b')
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toHaveValue('Keep typed draft')
    await act(async () => fireEvent.keyDown(window, { key: 'ArrowRight', ...chord }))
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('workspace-a')
    await act(async () => fireEvent.keyDown(window, { key: 'ArrowLeft', ...chord }))
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('workspace-b')
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...chord, shiftKey: true })
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true })
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('workspace-b')
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...chord })
    expect(useAppStore.getState().activeChatWorkspaceId).toBe('workspace-b')
    modal.remove()
  })

  it('moves keyboard focus across three columns without remounting their drafts', () => {
    const three = [...sessions, { ...sessions[0], id: 'chat-c', title: 'Chat C' }]
    useAppStore.setState({ sessions: three, chatPaneCount: 3,
      chatPanes: { primary: 'chat-a', secondary: 'chat-b', tertiary: 'chat-c' },
      chatWorkspaces: [{ ...useAppStore.getState().chatWorkspaces[0], paneCount: 3,
        threePaneLayout: 'columns', panes: { primary: 'chat-a', secondary: 'chat-b', tertiary: 'chat-c' } }] })
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-b' }), { target: { value: 'Keep center draft' } })
    const modifiers = /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
      ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }
    fireEvent.keyDown(window, { key: 'ArrowRight', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    fireEvent.keyDown(window, { key: 'ArrowRight', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('tertiary')
    fireEvent.keyDown(window, { key: 'ArrowDown', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('tertiary')
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    fireEvent.click(screen.getByRole('button', { name: '3 panes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Three columns' }))
    expect(screen.getByRole('textbox', { name: 'Draft chat-b' })).toHaveValue('Keep center draft')
  })

  it('opens a fourth-pane file without changing the first three conversations', async () => {
    const four = [...sessions,
      { ...sessions[0], id: 'chat-c', title: 'Chat C' },
      { ...sessions[1], id: 'chat-d', title: 'Chat D' }]
    vi.mocked(window.agentsDock.workspace.read).mockImplementation(async (id, path) => ({
      root: four.find(session => session.id === id)!.cwd!, path, name: path,
      content: `Content from ${id}`, revision: 'rev-1', size: 19, mtime_ns: 1, writable: true
    }))
    useAppStore.setState({ sessions: four, chatPaneCount: 4,
      chatPanes: { primary: 'chat-a', secondary: 'chat-b', tertiary: 'chat-c', quaternary: 'chat-d' } })
    const view = render(<App />)
    const fourth = view.container.querySelector('[data-chat-pane="quaternary"]') as HTMLElement
    fireEvent.pointerDown(within(fourth).getByRole('link', { name: 'Open example.ts from chat-d' }))
    fireEvent.click(within(fourth).getByRole('link', { name: 'Open example.ts from chat-d' }))
    expect(await within(fourth).findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-d')
    expect(useAppStore.getState().selectedSessionId).toBe('chat-d')
    for (const id of ['chat-a', 'chat-b', 'chat-c']) expect(screen.getByRole('textbox', { name: `Draft ${id}` })).toBeVisible()
    expect(window.agentsDock.workspace.read).toHaveBeenCalledTimes(1)
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-d', 'example.ts')
    const modifiers = /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
      ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('tertiary')
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('tertiary')
    fireEvent.keyDown(window, { key: 'ArrowUp', ...modifiers })
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
  })

  it('opens files inside their owning panes while both chats and drafts remain mounted', async () => {
    const view = render(<StrictMode><App /></StrictMode>)
    const primary = view.container.querySelector('[data-chat-pane="primary"]') as HTMLElement
    const secondary = view.container.querySelector('[data-chat-pane="secondary"]') as HTMLElement
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-a' }), { target: { value: 'Keep primary draft' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-b' }), { target: { value: 'Keep secondary draft' } })
    fireEvent.click(within(secondary).getByRole('link', { name: 'Open example.ts from chat-b' }))
    expect(await within(secondary).findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-b', 'example.ts')
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toBeVisible()
    expect(view.container.querySelector('.split-workspace-overlay')).toBeNull()
    fireEvent.click(within(secondary).getByRole('button', { name: /Chat.*pinned/i }))
    expect(view.container.querySelector('[data-chat-pane="primary"]')).toBe(primary)
    expect(view.container.querySelector('[data-chat-pane="secondary"]')).toBe(secondary)
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toHaveValue('Keep primary draft')
    expect(screen.getByRole('textbox', { name: 'Draft chat-b' })).toHaveValue('Keep secondary draft')
    fireEvent.click(within(primary).getByRole('link', { name: 'Open example.ts from chat-a' }))
    expect(await within(primary).findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-a')
    expect(screen.getByRole('textbox', { name: 'Draft chat-b' })).toBeVisible()
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
  })

  it('keeps a newly requested file active when saved tabs restore before its read completes', async () => {
    vi.mocked(window.agentsDock.preferences.getScoped).mockImplementation((_scope, key, fallback) => Promise.resolve(key === 'workspace-editor:chat-b'
      ? { version: 1, cwd: '/work/beta', activePath: 'previous.ts', tabs: [{ path: 'previous.ts' }] }
      : fallback))
    let finishRead!: (file: WorkspaceFile) => void
    const pendingRead = new Promise<WorkspaceFile>(resolve => { finishRead = resolve })
    const read = window.agentsDock.workspace.read
    const ordinaryRead = vi.mocked(read).getMockImplementation()!
    vi.mocked(read).mockImplementation((sessionId, path) => path === 'example.ts' ? pendingRead : ordinaryRead(sessionId, path))
    render(<App />)

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'example.ts' } })))
    await waitFor(() => expect(read).toHaveBeenCalledWith('chat-b', 'example.ts'))
    expect(await screen.findByRole('tab', { name: 'previous.ts' })).toBeInTheDocument()
    await act(async () => finishRead(await ordinaryRead('chat-b', 'example.ts')))

    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    expect(screen.getByRole('tab', { name: 'example.ts' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the clicked reference after a single chat file was retained into split view', async () => {
    useAppStore.setState({ chatPanes: { primary: 'chat-a', secondary: null }, chatPaneCount: 1 })
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Open previous.ts from chat-a' }))
    expect(await screen.findByRole('textbox', { name: 'Contents of previous.ts' })).toHaveValue('Content from chat-a')
    act(() => useAppStore.setState({ chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, chatPaneCount: 2, selectedSessionId: 'chat-b', focusedChatPane: 'secondary' }))
    fireEvent.click(screen.getAllByRole('button', { name: /Chat.*pinned/i })[0])
    const link = screen.getByRole('link', { name: 'Open example.ts from chat-a' })
    fireEvent.pointerDown(link)
    fireEvent.click(link)
    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-a')
  })

  it('opens the file picker with keyboard focus and cancels back to the focused split chat', async () => {
    const view = render(<StrictMode><App /></StrictMode>)
    act(() => handleMenuCommand('open-workspace-file', useAppStore.getState, value => useAppStore.setState(value)))
    const search = await screen.findByRole('combobox', { name: 'Find a workspace file' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Close file picker' }))
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toBeVisible()
    expect(view.container.querySelector('.split-workspace-overlay')).toBeNull()
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
  })

  it('opens workspace and attachment image previews without discarding either chat', async () => {
    render(<StrictMode><App /></StrictMode>)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'image.png' } })))
    expect(await screen.findByRole('img', { name: 'image.png' })).toHaveAttribute('src', 'agentsdock-media://workspace/profile-a/4/chat-b/image.png')
    fireEvent.click(screen.getAllByRole('button', { name: /Chat.*pinned/i })[1])
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', { detail: { sessionId: 'chat-a', file: { id: 'artifact', session_id: 'chat-a', filename: 'attachment.png', content_type: 'image/png' } } })))
    expect(await screen.findByRole('img', { name: 'attachment.png' })).toHaveAttribute('src', 'agentsdock-media://file/profile-a/4/chat-a/artifact')
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
  })

  it('keeps an owner-targeted open in its pane when focus changes during restoration', async () => {
    let restore!: (value: null) => void
    const pendingRestore = new Promise<null>(resolve => { restore = resolve })
    vi.mocked(window.agentsDock.preferences.getScoped).mockImplementation((_scope, key, fallback) => key === 'workspace-editor:chat-b' ? pendingRestore : Promise.resolve(fallback))
    const view = render(<StrictMode><App /></StrictMode>)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'example.ts' } })))
    act(() => useAppStore.getState().focusChatPane('primary'))
    await act(async () => restore(null))
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-b', 'example.ts'))
    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toBeVisible()
    expect(view.container.querySelector('.split-workspace-overlay')).toBeNull()
    expect(useAppStore.getState().selectedSessionId).toBe('chat-a')
  })
})
