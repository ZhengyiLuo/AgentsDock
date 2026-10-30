import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { BootstrapPayload, ProfileSyncEvent, PublicServerProfile, Session, SessionSnapshot, WorkspaceProfileScope } from '@shared/types'
import { useAppStore } from './app-store'

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))

const sessions: Session[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, title: `Chat ${id}`, backend: 'codex' }))
const profiles: PublicServerProfile[] = ['one', 'two'].map(id => ({
  id, name: id, serverUrl: `http://${id}.test`, serverIdentity: `server-${id}`,
  hasAccessToken: false, serverSetupComplete: true, connectionState: 'offline', cachedUnreadCount: 0
}))
const snapshot = (id: string): SessionSnapshot => ({
  session: sessions.find(session => session.id === id)!,
  events: [{ id: `${id}-1`, session_id: id, seq: 1, type: 'assistant_text', text: id, ts: '2026-10-23T00:00:00Z' }],
  queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
})
const payload = (profileId = 'one', generation = 1): BootstrapPayload => ({
  settings: { serverUrl: profiles.find(profile => profile.id === profileId)!.serverUrl, hasAccessToken: false, serverSetupComplete: true },
  health: null, sessions, jobs: [], runtimeCatalog: null, selectedSessionId: 'a',
  folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: false,
  activeProfileId: profileId, profiles, profileGeneration: generation
})
const key = (scope: WorkspaceProfileScope, name: string): string => `${scope.serverIdentity ?? scope.profileId}:${name}`

let persisted: Map<string, unknown>
let api: {
  bootstrap: ReturnType<typeof vi.fn>
  timeline: { cached: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> }
  preferences: { getScoped: ReturnType<typeof vi.fn>; setScoped: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }
  servers: { switch: ReturnType<typeof vi.fn> }
  native: { log: ReturnType<typeof vi.fn>; setBadge: ReturnType<typeof vi.fn> }
  events: { on: ReturnType<typeof vi.fn> }
}

async function initialize(): Promise<void> {
  useAppStore.setState(useAppStore.getInitialState(), true)
  await useAppStore.getState().initialize()
}

beforeEach(async () => {
  persisted = new Map()
  api = {
    bootstrap: vi.fn(async () => payload()),
    timeline: {
      cached: vi.fn(async (id: string) => snapshot(id)), subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined), open: vi.fn(async (id: string) => snapshot(id))
    },
    preferences: {
      getScoped: vi.fn(async (scope: WorkspaceProfileScope, name: string, fallback: unknown) => persisted.get(key(scope, name)) ?? fallback),
      setScoped: vi.fn(async (scope: WorkspaceProfileScope, name: string, value: unknown) => { persisted.set(key(scope, name), structuredClone(value)) }),
      get: vi.fn(async (_name: string, fallback: unknown) => fallback), set: vi.fn().mockResolvedValue(undefined)
    },
    servers: { switch: vi.fn(async (id: string) => payload(id, useAppStore.getState().profileGeneration + 1)) },
    native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
    events: { on: vi.fn().mockReturnValue(() => {}) }
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: api as unknown as AgentsDockAPI })
  await initialize()
  api.timeline.subscribe.mockClear()
  api.timeline.unsubscribe.mockClear()
})

describe('tabbed chat workspaces', () => {
  it('persists reordered workspaces without changing active panes, drafts, files or subscriptions', async () => {
    const first = useAppStore.getState().activeChatWorkspaceId
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    useAppStore.getState().setChatThreePaneLayout('columns')
    useAppStore.getState().setChatWorkspaceRatios({ threeColumnRatios: [0.25, 0.7] })
    useAppStore.getState().focusChatPane('secondary')
    useAppStore.getState().setDraftForSession('b', 'unfinished draft')
    await useAppStore.getState().createChatWorkspace('e')
    const second = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace()
    const third = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().selectChatWorkspace(first)
    useAppStore.setState(state => ({ snapshots: { ...state.snapshots,
      b: { ...state.snapshots.b, files: [{ id: 'b-file', filename: 'notes.txt', session_id: 'b' }], filesTotal: 1 }
    } }))
    const before = useAppStore.getState()
    api.timeline.subscribe.mockClear()
    api.timeline.unsubscribe.mockClear()
    api.timeline.cached.mockClear()
    api.timeline.open.mockClear()
    useAppStore.getState().moveChatWorkspace(third, first)
    useAppStore.getState().moveChatWorkspace(first, second)
    const state = useAppStore.getState()
    expect(state.chatWorkspaces.map(workspace => workspace.id)).toEqual([third, second, first])
    expect(state.activeChatWorkspaceId).toBe(first)
    expect(state.chatPanes).toBe(before.chatPanes)
    expect(state.focusedChatPane).toBe('secondary')
    expect(state.selectedSessionId).toBe('b')
    expect(state.drafts).toBe(before.drafts)
    expect(state.snapshots).toBe(before.snapshots)
    expect(state.chatWorkspaces.find(workspace => workspace.id === first)).toMatchObject({
      threePaneLayout: 'columns', threeColumnRatios: [0.25, 0.7], panes: { quaternary: 'd' }
    })
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
    expect(api.timeline.cached).not.toHaveBeenCalled()
    expect(api.timeline.open).not.toHaveBeenCalled()
    await useAppStore.getState().switchServer('two')
    expect(useAppStore.getState().chatWorkspaces.map(workspace => workspace.id)).toEqual(['workspace-main'])
    await useAppStore.getState().switchServer('one')
    expect(useAppStore.getState().chatWorkspaces.map(workspace => workspace.id)).toEqual([third, second, first])
    await initialize()
    expect(useAppStore.getState().chatWorkspaces.map(workspace => workspace.id)).toEqual([third, second, first])
    expect(useAppStore.getState().activeChatWorkspaceId).toBe(first)
    expect(useAppStore.getState().chatPanes).toEqual(before.chatPanes)
  })

  it('ignores missing, unchanged and switching-profile reorder requests without persisting', async () => {
    const first = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace('e')
    const second = useAppStore.getState().activeChatWorkspaceId
    const before = useAppStore.getState().chatWorkspaces
    api.preferences.setScoped.mockClear()
    useAppStore.getState().moveChatWorkspace(first, first)
    useAppStore.getState().moveChatWorkspace('deleted', first)
    useAppStore.getState().moveChatWorkspace(first, 'deleted')
    useAppStore.setState({ switchingProfileId: 'two' })
    useAppStore.getState().moveChatWorkspace(first, second)
    expect(useAppStore.getState().chatWorkspaces).toBe(before)
    expect(api.preferences.setScoped).not.toHaveBeenCalled()
  })

  it('forgets an ended subscription and reattaches only on explicit cached-chat selection', async () => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    const onSync = api.events.on.mock.calls.find(([event]) => event === 'server:sync')![1] as (event: ProfileSyncEvent) => void
    api.timeline.subscribe.mockClear()
    onSync({ profileId: 'one', profileGeneration: 0, sessionId: 'a', state: 'idle' })
    await useAppStore.getState().selectSession('a')
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    onSync({ profileId: 'one', profileGeneration: 1, sessionId: 'a', state: 'reconnecting' })
    await useAppStore.getState().selectSession('a')
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    onSync({ profileId: 'one', profileGeneration: 1, sessionId: 'a', state: 'idle' })
    await Promise.resolve()
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    await useAppStore.getState().selectSession('a')
    expect(api.timeline.subscribe).toHaveBeenCalledExactlyOnceWith('a', 1)
    await useAppStore.getState().selectSession('a')
    expect(api.timeline.subscribe).toHaveBeenCalledTimes(1)
    // A delayed idle notification from the previous owner must not stop or
    // automatically restart the stream attached by the explicit selection.
    onSync({ profileId: 'one', profileGeneration: 1, sessionId: 'a', state: 'idle' })
    await Promise.resolve()
    expect(api.timeline.subscribe).toHaveBeenCalledTimes(1)
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
  })

  it.each([3, 4])('owns all %s visible streams and releases only panes leaving the active workspace', async count => {
    const ids = ['a', 'b', 'c', 'd'].slice(0, count)
    for (const id of ids.slice(1)) await useAppStore.getState().openSessionInSplit(id)
    const first = useAppStore.getState().activeChatWorkspaceId
    expect(api.timeline.subscribe.mock.calls.map(([id]) => id)).toEqual(ids.slice(1))
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
    api.timeline.subscribe.mockClear()
    await useAppStore.getState().createChatWorkspace('b')
    const second = useAppStore.getState().activeChatWorkspaceId
    const hidden = ids.filter(id => id !== 'b')
    expect(api.timeline.unsubscribe.mock.calls.map(([id]) => id)).toEqual(hidden)
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    api.timeline.unsubscribe.mockClear()
    await useAppStore.getState().selectChatWorkspace(first)
    expect(api.timeline.subscribe.mock.calls.map(([id]) => id)).toEqual(hidden)
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
    api.timeline.subscribe.mockClear()
    useAppStore.getState().closeChatPane('secondary')
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('b')
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    api.timeline.unsubscribe.mockClear()
    await useAppStore.getState().closeChatWorkspace(first)
    expect(useAppStore.getState().activeChatWorkspaceId).toBe(second)
    expect(api.timeline.unsubscribe.mock.calls.map(([id]) => id)).toEqual(hidden)
    expect(api.timeline.subscribe).toHaveBeenCalledExactlyOnceWith('b', 1)
    api.timeline.unsubscribe.mockClear()
    api.timeline.subscribe.mockClear()
    await useAppStore.getState().closeChatWorkspace(second)
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('b')
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
  })

  it('returns to an existing workspace and focuses its chat without replacing the departing pane', async () => {
    await useAppStore.getState().openSessionInSplit('b')
    const first = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().focusChatPane('primary')
    useAppStore.getState().setDraftForSession('b', 'draft B')
    useAppStore.setState(state => ({ snapshots: {
      ...state.snapshots, b: { ...state.snapshots.b, files: [{ id: 'b-file', filename: 'notes.txt', session_id: 'b' }], filesTotal: 1 }
    } }))
    await useAppStore.getState().createChatWorkspace('c')
    const second = useAppStore.getState().activeChatWorkspaceId
    const capture = vi.fn()
    window.addEventListener('agentsdock:capture-timeline', capture)
    api.timeline.subscribe.mockClear()
    api.timeline.unsubscribe.mockClear()
    await useAppStore.getState().selectSession('b')
    window.removeEventListener('agentsdock:capture-timeline', capture)
    expect(useAppStore.getState()).toMatchObject({
      activeChatWorkspaceId: first, focusedChatPane: 'secondary', selectedSessionId: 'b',
      chatPanes: { primary: 'a', secondary: 'b' }
    })
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === second)?.panes).toEqual({ primary: 'c', secondary: null })
    expect(useAppStore.getState().chatWorkspaces.flatMap(workspace => Object.values(workspace.panes)).filter(id => id === 'b')).toHaveLength(1)
    expect(useAppStore.getState().drafts.b).toBe('draft B')
    expect(useAppStore.getState().snapshots.b.files).toEqual([{ id: 'b-file', filename: 'notes.txt', session_id: 'b' }])
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ detail: { sessionId: 'c' } }))
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('c')
    expect(api.timeline.subscribe.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  })

  it.each([false, true])('reveals a saved hidden pane without changing its assignment (other workspace: %s)', async otherWorkspace => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    const first = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatThreePaneLayout('columns')
    useAppStore.getState().setChatWorkspaceRatios({ threeColumnRatios: [0.25, 0.7] })
    useAppStore.getState().setChatPaneCount(1)
    if (otherWorkspace) await useAppStore.getState().createChatWorkspace('e')
    await useAppStore.getState().selectSession('c')
    expect(useAppStore.getState()).toMatchObject({
      activeChatWorkspaceId: first, chatPaneCount: 3, focusedChatPane: 'tertiary', selectedSessionId: 'c',
      chatPanes: { primary: 'a', secondary: 'b', tertiary: 'c' }
    })
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)).toMatchObject({
      panes: { quaternary: 'd' }, threePaneLayout: 'columns', threeColumnRatios: [0.25, 0.7]
    })
  })

  it('prefers the current workspace when explicit placement opened the chat in multiple tabs', async () => {
    await useAppStore.getState().openSessionInSplit('b')
    const first = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace('c')
    const second = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().openSessionInSplit('b')
    expect(useAppStore.getState().activeChatWorkspaceId).toBe(second)
    useAppStore.getState().setChatPaneCount(1)
    await useAppStore.getState().selectSession('b')
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: second, chatPaneCount: 2, focusedChatPane: 'secondary' })
    await useAppStore.getState().createChatWorkspace('d')
    await useAppStore.getState().selectSession('b')
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: first, focusedChatPane: 'secondary' })
  })

  it('keeps explicit pane placement and unopened normal selections in the current workspace', async () => {
    const first = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace('b')
    const second = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().selectSessionInPane('a', 'secondary')
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: second, chatPanes: { primary: 'b', secondary: 'a' } })
    await useAppStore.getState().selectSession('e')
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: second, chatPanes: { primary: 'b', secondary: 'e' } })
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)?.panes.primary).toBe('a')
  })

  it('uses the existing workspace when next-chat keyboard navigation selects its chat', async () => {
    const first = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace('b')
    const second = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().selectChatWorkspace(first)
    await useAppStore.getState().selectAdjacent(1)
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: second, selectedSessionId: 'b' })
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)?.panes.primary).toBe('a')
  })

  it('fills all four slots, keeps existing streams, then replaces only the focused slot', async () => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    expect(useAppStore.getState()).toMatchObject({
      chatPanes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' }, chatPaneCount: 4, focusedChatPane: 'quaternary'
    })
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
    expect(api.timeline.subscribe.mock.calls.map(([id]) => id)).toEqual(['b', 'c', 'd'])
    await useAppStore.getState().selectSession('c')
    await useAppStore.getState().openSessionInSplit('e')
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: 'b', tertiary: 'e', quaternary: 'd' })
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('c')
  })

  it('retains hidden chats and drafts across shrinking, empty focus, and expansion', async () => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    useAppStore.getState().setDraftForSession('d', 'unfinished')
    useAppStore.getState().setChatPaneCount(1)
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: null })
    expect(useAppStore.getState().selectedSessionId).toBe('a')
    expect(useAppStore.getState().chatWorkspaces[0].panes.quaternary).toBe('d')
    useAppStore.getState().setChatPaneCount(4)
    await vi.waitFor(() => expect(api.timeline.subscribe).toHaveBeenLastCalledWith('d', 1))
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' })
    expect(useAppStore.getState().drafts.d).toBe('unfinished')
    await useAppStore.getState().createChatWorkspace()
    useAppStore.getState().setChatPaneCount(4)
    useAppStore.getState().focusChatPane('tertiary')
    expect(useAppStore.getState()).toMatchObject({ focusedChatPane: 'tertiary', selectedSessionId: null, chatPaneCount: 4 })
    await useAppStore.getState().selectSession('e')
    expect(useAppStore.getState().chatPanes.tertiary).toBe('e')
  })

  it('switches three-pane modes without losing hidden chats, focus, drafts or split sizes', async () => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    useAppStore.getState().setDraftForSession('d', 'unfinished')
    useAppStore.getState().setChatWorkspaceRatios({ columnRatio: 0.6, rowRatio: 0.4, threeColumnRatios: [0.25, 0.7] })
    useAppStore.getState().setChatThreePaneLayout('columns')
    expect(useAppStore.getState()).toMatchObject({ chatPaneCount: 3, focusedChatPane: 'primary', selectedSessionId: 'a' })
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: 'b', tertiary: 'c' })
    expect(useAppStore.getState().chatWorkspaces[0]).toMatchObject({
      panes: { quaternary: 'd' }, threePaneLayout: 'columns', threeColumnRatios: [0.25, 0.7], columnRatio: 0.6, rowRatio: 0.4
    })
    await vi.waitFor(() => expect(useAppStore.getState().loadingSessionIds.size).toBe(0))
    useAppStore.getState().focusChatPane('tertiary')
    api.timeline.cached.mockClear()
    api.timeline.subscribe.mockClear()
    api.timeline.unsubscribe.mockClear()
    useAppStore.getState().setChatThreePaneLayout('split')
    expect(useAppStore.getState()).toMatchObject({ chatPaneCount: 3, focusedChatPane: 'tertiary', selectedSessionId: 'c' })
    expect(useAppStore.getState().chatWorkspaces[0]).toMatchObject({
      threePaneLayout: 'split', threeColumnRatios: [0.25, 0.7], columnRatio: 0.6, rowRatio: 0.4
    })
    expect(api.timeline.cached).not.toHaveBeenCalled()
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
    expect(api.timeline.unsubscribe).not.toHaveBeenCalled()
    useAppStore.getState().setChatPaneCount(1)
    useAppStore.getState().setChatThreePaneLayout('columns')
    useAppStore.getState().setChatPaneCount(4)
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' })
    expect(useAppStore.getState().drafts.d).toBe('unfinished')
  })

  it('persists independent three-pane modes and bounded divider ratios per workspace and server', async () => {
    const first = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatThreePaneLayout('columns')
    useAppStore.getState().setChatWorkspaceRatios({ threeColumnRatios: [0.1, 0.95] })
    await useAppStore.getState().createChatWorkspace('b')
    const second = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatThreePaneLayout('split')
    useAppStore.getState().setChatWorkspaceRatios({ threeColumnRatios: [0.3, 0.55] })
    await useAppStore.getState().selectChatWorkspace(first)
    await initialize()
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)).toMatchObject({
      threePaneLayout: 'columns', threeColumnRatios: [0.2, 0.8], paneCount: 3
    })
    await useAppStore.getState().switchServer('two')
    expect(useAppStore.getState().chatWorkspaces[0]).toMatchObject({ threePaneLayout: 'split', threeColumnRatios: [1 / 3, 2 / 3] })
    useAppStore.getState().setChatThreePaneLayout('columns')
    useAppStore.getState().setChatWorkspaceRatios({ threeColumnRatios: [0.4, 0.65] })
    await useAppStore.getState().switchServer('one')
    expect(useAppStore.getState().activeChatWorkspaceId).toBe(first)
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)).toMatchObject({
      threePaneLayout: 'columns', threeColumnRatios: [0.2, 0.8]
    })
    await useAppStore.getState().selectChatWorkspace(second)
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === second)).toMatchObject({
      threePaneLayout: 'split', threeColumnRatios: [0.3, 0.55]
    })
  })

  it('preserves workspace layouts, ratios, names and shared subscriptions when changing tabs', async () => {
    await useAppStore.getState().openSessionInSplit('b')
    const first = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatWorkspaceRatios({ columnRatio: 0.63, rowRatio: 0.42 })
    useAppStore.getState().renameChatWorkspace(first, 'Research')
    useAppStore.getState().setDraftForSession('a', 'draft A')
    const capture = vi.fn()
    window.addEventListener('agentsdock:capture-timeline', capture)
    await useAppStore.getState().createChatWorkspace('b')
    const second = useAppStore.getState().activeChatWorkspaceId
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('a')
    expect(capture).toHaveBeenCalledTimes(2)
    window.removeEventListener('agentsdock:capture-timeline', capture)
    await useAppStore.getState().openSessionInSplit('c')
    api.timeline.unsubscribe.mockClear()
    api.timeline.subscribe.mockClear()
    await useAppStore.getState().selectChatWorkspace(first)
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'a', secondary: 'b' })
    expect(useAppStore.getState().selectedSessionId).toBe('b')
    expect(api.timeline.unsubscribe).toHaveBeenCalledExactlyOnceWith('c')
    expect(api.timeline.subscribe).toHaveBeenCalledExactlyOnceWith('a', 1)
    expect(useAppStore.getState().drafts.a).toBe('draft A')
    expect(useAppStore.getState().chatWorkspaces.find(workspace => workspace.id === first)).toMatchObject({ title: 'Research', columnRatio: 0.63, rowRatio: 0.42 })
    await useAppStore.getState().closeChatWorkspace(second)
    expect(useAppStore.getState().activeChatWorkspaceId).toBe(first)
    expect(useAppStore.getState().chatWorkspaces).toHaveLength(1)
    await useAppStore.getState().closeChatWorkspace(first)
    expect(useAppStore.getState().chatWorkspaces).toHaveLength(1)
    expect(useAppStore.getState().selectedSessionId).toBeNull()
    expect(useAppStore.getState().drafts.a).toBe('draft A')
  })

  it('restores tabs, hidden assignments and focus on restart, hydrating only active visible chats', async () => {
    for (const id of ['b', 'c', 'd']) await useAppStore.getState().openSessionInSplit(id)
    const first = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatPaneCount(2)
    useAppStore.getState().focusChatPane('secondary')
    useAppStore.getState().setChatWorkspaceRatios({ columnRatio: 0.72 })
    await useAppStore.getState().createChatWorkspace('e')
    await useAppStore.getState().selectChatWorkspace(first)
    api.timeline.cached.mockClear()
    api.timeline.subscribe.mockClear()
    await initialize()
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: first, chatPaneCount: 2, focusedChatPane: 'secondary' })
    expect(useAppStore.getState().chatWorkspaces).toHaveLength(2)
    expect(useAppStore.getState().chatWorkspaces[0]).toMatchObject({ panes: { tertiary: 'c', quaternary: 'd' }, columnRatio: 0.72 })
    expect(api.timeline.cached.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(api.timeline.subscribe.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    useAppStore.getState().setChatPaneCount(4)
    await vi.waitFor(() => expect(useAppStore.getState().snapshots.d).toBeDefined())
    expect(useAppStore.getState().chatPanes.quaternary).toBe('d')
  })

  it('isolates saved workspace tabs by server and restores them after switching back', async () => {
    await useAppStore.getState().createChatWorkspace('c')
    const firstServerTab = useAppStore.getState().activeChatWorkspaceId
    useAppStore.getState().setChatPaneCount(3)
    useAppStore.getState().focusChatPane('tertiary')
    await useAppStore.getState().switchServer('two')
    expect(useAppStore.getState().chatWorkspaces).toHaveLength(1)
    expect(useAppStore.getState().chatPaneCount).toBe(1)
    await useAppStore.getState().createChatWorkspace('e')
    await useAppStore.getState().switchServer('one')
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: firstServerTab, chatPaneCount: 3, focusedChatPane: 'tertiary', selectedSessionId: null })
    expect(useAppStore.getState().chatPanes.primary).toBe('c')
    expect(persisted.get('server-one:chatWorkspaces')).not.toEqual(persisted.get('server-two:chatWorkspaces'))
  })

  it('discards a delayed hidden-chat load after switching workspaces', async () => {
    let resolve!: (value: SessionSnapshot) => void
    api.timeline.cached.mockImplementation((id: string) => id === 'b' ? new Promise<SessionSnapshot>(done => { resolve = done }) : Promise.resolve(snapshot(id)))
    const opening = useAppStore.getState().openSessionInSplit('b')
    await useAppStore.getState().createChatWorkspace('c')
    const active = useAppStore.getState().activeChatWorkspaceId
    resolve(snapshot('b'))
    await opening
    expect(useAppStore.getState()).toMatchObject({ activeChatWorkspaceId: active, selectedSessionId: 'c', chatPanes: { primary: 'c', secondary: null } })
    expect(api.timeline.subscribe).not.toHaveBeenCalledWith('b', 1)
    expect(useAppStore.getState().snapshots.b).toBeUndefined()
  })

  it('clears deleted chats before reopening an inactive workspace, including hidden slots', async () => {
    Object.assign(api, { sessions: { remove: vi.fn().mockResolvedValue(undefined) } })
    const first = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().createChatWorkspace('c')
    const second = useAppStore.getState().activeChatWorkspaceId
    await useAppStore.getState().openSessionInSplit('d')
    useAppStore.getState().setChatPaneCount(1)
    await useAppStore.getState().selectChatWorkspace(first)
    await useAppStore.getState().deleteSession('c')
    await useAppStore.getState().deleteSession('d')
    api.timeline.cached.mockClear()
    api.timeline.subscribe.mockClear()
    await useAppStore.getState().selectChatWorkspace(second)
    useAppStore.getState().setChatPaneCount(2)
    expect(useAppStore.getState().chatPanes).toEqual({ primary: null, secondary: null })
    expect(api.timeline.cached).not.toHaveBeenCalled()
    expect(api.timeline.subscribe).not.toHaveBeenCalled()
  })
})
