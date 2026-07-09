import { describe, expect, it, vi } from 'vitest'
import type { BootstrapPayload, Event, QueuedTurn, Session, SessionSnapshot, TimelinePage } from '@shared/types'
import type { AgentsDockAPI } from '@shared/ipc'
import { cacheSnapshot, mergeEvents, updateActiveSessions, updateQueuedTurns, useAppStore } from './app-store'

const event = (type: string, patch: Partial<Event> = {}): Event => ({ id: `event-${type}`, session_id: 'chat-1', seq: 1, type, ts: '2026-07-09T10:00:00Z', ...patch })

describe('live run state', () => {
  it('tracks start and every terminal event without mutating the previous set', () => {
    const empty = new Set<string>()
    const running = updateActiveSessions(empty, event('turn_started'))
    expect([...running]).toEqual(['chat-1'])
    expect(empty.size).toBe(0)
    expect(updateActiveSessions(running, event('turn_finished')).size).toBe(0)
    expect(updateActiveSessions(running, event('turn_stopped')).size).toBe(0)
    expect(updateActiveSessions(running, event('error')).size).toBe(0)
  })
})

describe('live queue state', () => {
  it('adds, edits, reorders, and removes queued messages from stream events', () => {
    let queue: QueuedTurn[] = []
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'a', prompt: 'First', position: 1 }))
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'b', prompt: 'Second', position: 2 }))
    queue = updateQueuedTurns(queue, event('turn_queue_updated', { queued_id: 'b', prompt: 'Edited' }))
    expect(queue.map(turn => turn.prompt)).toEqual(['First', 'Edited'])
    queue = updateQueuedTurns(queue, event('turn_queue_reordered', { positions: [{ queued_id: 'a', position: 2 }, { queued_id: 'b', position: 1 }] }))
    expect(queue.map(turn => turn.queued_id)).toEqual(['b', 'a'])
    queue = updateQueuedTurns(queue, event('turn_started', { queued_id: 'b' }))
    expect(queue.map(turn => turn.queued_id)).toEqual(['a'])
    queue = updateQueuedTurns(queue, event('turn_unqueued', { queued_id: 'a' }))
    expect(queue).toEqual([])
  })

  it('updates the requested chat even when another chat is selected', () => {
    const a = snapshot('chat-a', [eventFor('chat-a', 1)])
    const b = snapshot('chat-b', [eventFor('chat-b', 1)])
    useAppStore.setState({ selectedSessionId: 'chat-b', snapshots: { 'chat-a': a, 'chat-b': b } })
    const queue = [{ queued_id: 'qa', prompt: 'For A', display_prompt: 'For A', file_ids: [] }]
    useAppStore.getState().setQueued('chat-a', queue)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual(queue)
    expect(useAppStore.getState().snapshots['chat-b'].queuedTurns).toEqual([])
  })
})

describe('older timeline paging', () => {
  it('merges against the current snapshot so streamed events are not discarded', async () => {
    const session = sessionFor('chat-a')
    let resolvePage!: (page: TimelinePage) => void
    const page = new Promise<TimelinePage>(resolve => { resolvePage = resolve })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { older: vi.fn(() => page) } }
    })
    useAppStore.setState({ selectedSessionId: 'chat-a', snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 10)], true) } })
    const pending = useAppStore.getState().loadOlder()
    useAppStore.setState(state => ({ snapshots: {
      ...state.snapshots,
      'chat-a': { ...state.snapshots['chat-a'], events: [...state.snapshots['chat-a'].events, eventFor('chat-a', 11)] }
    } }))
    resolvePage({ session, events: [eventFor('chat-a', 1)], has_more: false })
    await pending
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([1, 10, 11])
  })

  it('collects trace-heavy pages and publishes one coherent prepend', async () => {
    const current = [eventFor('chat-a', 100), eventFor('chat-a', 101)]
    const older = vi.fn()
      .mockResolvedValueOnce({ session: sessionFor('chat-a'), events: [eventFor('chat-a', 90)], has_more: true })
      .mockResolvedValueOnce({ session: sessionFor('chat-a'), events: [eventFor('chat-a', 80)], has_more: false })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { older } } as unknown as AgentsDockAPI })
    useAppStore.setState({ selectedSessionId: 'chat-a', snapshots: { 'chat-a': snapshot('chat-a', current, true) } })
    let publications = 0
    const unsubscribe = useAppStore.subscribe(() => { publications += 1 })
    await useAppStore.getState().loadOlder()
    unsubscribe()
    expect(older).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([80, 90, 100, 101])
    expect(publications).toBe(1)
  })
})

describe('chat selection', () => {
  it('activates an in-memory chat without reopening and replacing its snapshot', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { subscribe, open } } as unknown as AgentsDockAPI })
    const cached = snapshot('chat-a', [eventFor('chat-a', 7)])
    useAppStore.setState({ selectedSessionId: 'chat-b', sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': cached } })
    await useAppStore.getState().selectSession('chat-a')
    expect(subscribe).toHaveBeenCalledWith('chat-a', 7)
    expect(open).not.toHaveBeenCalled()
    expect(useAppStore.getState().snapshots['chat-a']).toBe(cached)
  })

  it('ignores an obsolete completion across an A to B to A switch', async () => {
    const resolvers: Array<(value: SessionSnapshot) => void> = []
    const open = vi.fn(() => new Promise<SessionSnapshot>(resolve => resolvers.push(resolve)))
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { open, subscribe: vi.fn() } } as unknown as AgentsDockAPI })
    useAppStore.setState({ selectedSessionId: null, loadingSessionId: null, sessions: [sessionFor('a'), sessionFor('b')], snapshots: {} })
    const firstA = useAppStore.getState().selectSession('a')
    const b = useAppStore.getState().selectSession('b')
    const secondA = useAppStore.getState().selectSession('a')
    resolvers[2](snapshot('a', [eventFor('a', 30)]))
    await secondA
    resolvers[0](snapshot('a', [eventFor('a', 10)]))
    resolvers[1](snapshot('b', [eventFor('b', 20)]))
    await Promise.all([firstA, b])
    expect(useAppStore.getState().selectedSessionId).toBe('a')
    expect(useAppStore.getState().snapshots.a.events.map(item => item.seq)).toEqual([30])
    expect(useAppStore.getState().snapshots.b).toBeUndefined()
  })
})

describe('read state', () => {
  it('clears a manual unread marker when the open chat is read', async () => {
    const unread: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 12, last_read_agent_event_seq: 11, manual_unread: true
    }
    const updated: Session = { ...unread, last_read_agent_event_seq: 12, manual_unread: false }
    const markRead = vi.fn().mockResolvedValue(updated)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [unread],
      snapshots: { 'chat-a': { ...snapshot('chat-a', [eventFor('chat-a', 12)]), session: unread } }
    })

    await useAppStore.getState().markRead('chat-a')

    expect(markRead).toHaveBeenCalledWith('chat-a', 12)
    expect(useAppStore.getState().sessions[0].manual_unread).toBe(false)
    expect(useAppStore.getState().snapshots['chat-a'].session.manual_unread).toBe(false)
  })
})

describe('event merging', () => {
  it('retains the existing array and objects for equivalent server events', () => {
    const existing = [eventFor('chat-a', 1), eventFor('chat-a', 2)]
    const merged = mergeEvents(existing, existing.map(item => ({ ...item })))
    expect(merged).toBe(existing)
    expect(merged[0]).toBe(existing[0])
  })

  it('uses append and prepend fast paths while preserving order', () => {
    const middle = [eventFor('chat-a', 10)]
    expect(mergeEvents(middle, [eventFor('chat-a', 11)]).map(item => item.seq)).toEqual([10, 11])
    expect(mergeEvents(middle, [eventFor('chat-a', 9)]).map(item => item.seq)).toEqual([9, 10])
  })
})

describe('timeline memory cache', () => {
  it('keeps the selected chat while evicting least-recently-used prefetched chats', () => {
    let snapshots: Record<string, SessionSnapshot> = {}
    snapshots = cacheSnapshot(snapshots, 'selected', snapshot('selected', []), 'selected')
    for (let index = 0; index < 24; index += 1) {
      const id = `hover-${index}`
      snapshots = cacheSnapshot(snapshots, id, snapshot(id, []), 'selected')
    }
    expect(Object.keys(snapshots).length).toBeLessThanOrEqual(14)
    expect(snapshots.selected).toBeDefined()
    expect(snapshots['hover-23']).toBeDefined()
    expect(snapshots['hover-0']).toBeUndefined()
  })
})

describe('bootstrap', () => {
  it('coalesces concurrent React StrictMode initialization calls', async () => {
    let resolveBootstrap!: (payload: BootstrapPayload) => void
    const bootstrap = vi.fn(() => new Promise<BootstrapPayload>(resolve => { resolveBootstrap = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap,
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => {}) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, sessions: [], selectedSessionId: null })
    const first = useAppStore.getState().initialize()
    const second = useAppStore.getState().initialize()
    expect(bootstrap).toHaveBeenCalledTimes(1)
    resolveBootstrap({
      settings: { serverUrl: 'http://example.test', hasAccessToken: false },
      health: null,
      sessions: [],
      jobs: [],
      runtimeCatalog: null,
      folderOrder: [],
      collapsedFolders: [],
      archivedCollapsed: false,
      inspectorVisible: true
    })
    await Promise.all([first, second])
    expect(useAppStore.getState().initialized).toBe(true)
  })
})

function sessionFor(id: string): Session { return { id, title: id, backend: 'codex' } }
function eventFor(sessionId: string, seq: number): Event { return { id: `${sessionId}-${seq}`, session_id: sessionId, seq, type: 'assistant_text', ts: '2026-07-09T10:00:00Z', text: String(seq) } }
function snapshot(id: string, events: Event[], hasMoreEvents = false): SessionSnapshot {
  return { session: sessionFor(id), events, queuedTurns: [], files: [], hasMoreEvents, filesTotal: 0, cachedAt: 0 }
}
