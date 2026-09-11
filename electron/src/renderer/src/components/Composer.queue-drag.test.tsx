import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent, DragOverEvent } from '@dnd-kit/core'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, Health, QueuedTurn } from '@shared/types'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { Composer } from './Composer'

const dndHarness = vi.hoisted(() => ({
  onDragOver: null as ((event: DragOverEvent) => void) | null,
  onDragEnd: null as ((event: DragEndEvent) => void) | null,
  sensorRenders: 0,
  composerRenderHooks: 0
}))

vi.mock('./ClaudeRuntimeContext', () => ({
  useClaudeRuntime: () => {
    dndHarness.composerRenderHooks += 1
    return {
      supported: false,
      runtime: null,
      mutating: false,
      run: async <T,>(operation: () => Promise<T>) => operation()
    }
  }
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragOver,
    onDragEnd
  }: {
    children: ReactNode
    onDragOver?: (event: DragOverEvent) => void
    onDragEnd?: (event: DragEndEvent) => void
  }) => {
    dndHarness.onDragOver = onDragOver ?? null
    dndHarness.onDragEnd = onDragEnd ?? null
    return children
  },
  PointerSensor: class PointerSensor {},
  useSensor: () => ({}),
  useSensors: () => {
    dndHarness.sensorRenders += 1
    return []
  },
  useDraggable: () => ({
    attributes: {}, listeners: {}, isDragging: false, setNodeRef: () => undefined
  }),
  useDroppable: () => ({ setNodeRef: () => undefined })
}))

describe('Composer queue drag', () => {
  afterEach(() => {
    cleanup()
    resetTransientCloseStackForTests()
    dndHarness.onDragOver = null
    dndHarness.onDragEnd = null
    dndHarness.sensorRenders = 0
    dndHarness.composerRenderHooks = 0
  })

  it('finishes a multi-step drag when each durable move streams before its queue response', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    let sequence = 10
    let serverQueue: QueuedTurn[] = [
      queuedTurn('queued-a', 'A', 1),
      queuedTurn('queued-b', 'B', 2),
      queuedTurn('queued-c', 'C', 3),
      queuedTurn('queued-d', 'D', 4)
    ]
    const move = vi.fn(async (sessionId: string, queuedId: string, direction: 'up' | 'down') => {
      const current = serverQueue.findIndex(turn => turn.queued_id === queuedId)
      const adjacent = current + (direction === 'down' ? 1 : -1)
      const reordered = [...serverQueue]
      ;[reordered[current], reordered[adjacent]] = [reordered[adjacent], reordered[current]]
      serverQueue = reordered.map((turn, index) => ({ ...turn, position: index + 1 }))
      const event: Event = {
        id: `reordered-${sequence}`,
        session_id: sessionId,
        seq: sequence++,
        type: 'turn_queue_reordered',
        ts: '2026-08-28T12:00:00Z',
        positions: serverQueue.map(turn => ({ queued_id: turn.queued_id, position: turn.position! }))
      }
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event })
      return serverQueue.map(turn => ({ ...turn }))
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null, sessions: [], jobs: [], runtimeCatalog: null,
          folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
          inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        preferences: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
        queue: { move },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => {}
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, activeProfileId: null, profileGeneration: 0,
      profiles: [], switchingProfileId: null, selectedSessionId: null,
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary',
      sessions: [], snapshots: {}, health: null, runtimeCatalog: null,
      uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
      chatReferencesBySession: {}, agentRoutesBySession: {}, activeSessionIds: new Set(),
      turnAdmissionTokens: {}, stoppingSessionIds: new Set(), error: null
    })
    await useAppStore.getState().initialize()
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null },
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: serverQueue, files: [], hasMoreEvents: false,
          filesTotal: 0, cachedAt: 0
        }
      }
    })
    render(<Composer />)

    act(() => dndHarness.onDragOver?.({
      active: { id: 'queued-a', rect: { current: { translated: { top: 100, height: 20 } } } },
      over: { id: 'queued-d', rect: { top: 0, height: 20 } }
    } as unknown as DragOverEvent))
    act(() => dndHarness.onDragEnd?.({
      active: { id: 'queued-a' }, over: { id: 'queued-d' }
    } as unknown as DragEndEvent))

    await waitFor(() => expect(move).toHaveBeenCalledTimes(3))
    expect(move.mock.calls.map(([, queuedId, direction]) => [queuedId, direction])).toEqual([
      ['queued-a', 'down'], ['queued-a', 'down'], ['queued-a', 'down']
    ])
    await waitFor(() => expect(queueLabels()).toEqual(['B', 'C', 'D', 'A']))
  })

  it.each(['cross_chat_handoff_delivery', 'scheduled_job'])('keeps visible %s work at its immutable arrival position', async purpose => {
    const move = vi.fn()
    const serverQueue: QueuedTurn[] = [
      queuedTurn('queued-a', 'A', 1),
      {
        ...queuedTurn('queued-delivery', 'Incoming delivery', 2),
        purpose,
        ...(purpose === 'scheduled_job' ? { job_id: 'job-1', job_title: 'Scheduled check', job_scheduled_run_at: 1_789_000_000 } : {})
      },
      queuedTurn('queued-b', 'B', 3)
    ]
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
        queue: { move }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true, activeProfileId: null, profileGeneration: 0,
      profiles: [], switchingProfileId: null, selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null }, focusedChatPane: 'primary',
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: serverQueue, files: [], hasMoreEvents: false,
          filesTotal: 0, cachedAt: 0
        }
      },
      health: null, runtimeCatalog: null,
      uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
      chatReferencesBySession: {}, agentRoutesBySession: {}, activeSessionIds: new Set(),
      turnAdmissionTokens: {}, stoppingSessionIds: new Set(), error: null
    })
    render(<Composer />)

    expect(queueLabels()).toEqual(['A', 'Incoming delivery', 'B'])

    act(() => dndHarness.onDragOver?.({
      active: { id: 'queued-b', rect: { current: { translated: { top: -20, height: 20 } } } },
      over: { id: 'queued-a', rect: { top: 0, height: 20 } }
    } as unknown as DragOverEvent))
    act(() => dndHarness.onDragEnd?.({
      active: { id: 'queued-b' }, over: { id: 'queued-a' }
    } as unknown as DragEndEvent))

    await waitFor(() => expect(useAppStore.getState().error).toMatch(/keep.*arrival position/i))
    expect(move).not.toHaveBeenCalled()
  })

  it('does not rerender the queued-turn shelf while the main composer draft changes', () => {
    const serverQueue = [queuedTurn('queued-a', 'Already queued', 1)]
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true, activeProfileId: null, profileGeneration: 0,
      profiles: [], switchingProfileId: null, selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null }, focusedChatPane: 'primary',
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: serverQueue, files: [], hasMoreEvents: false,
          filesTotal: 0, cachedAt: 0
        }
      },
      health: null, runtimeCatalog: null,
      uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
      chatReferencesBySession: {}, teamReferencesBySession: {}, agentRoutesBySession: {},
      agentRouteLoadingSessionIds: new Set(), agentRouteErrorsBySession: {},
      revokingAgentRouteIds: new Set(), activeSessionIds: new Set(),
      turnAdmissionTokens: {}, stoppingSessionIds: new Set(), error: null
    })
    render(<Composer />)
    const shelfRendersAfterMount = dndHarness.sensorRenders

    fireEvent.change(screen.getByPlaceholderText('Message'), {
      target: { value: 'Fast local draft', selectionStart: 16 }
    })

    expect(screen.getByPlaceholderText('Message')).toHaveValue('Fast local draft')
    expect(dndHarness.sensorRenders).toBe(shelfRendersAfterMount)
  })

  it.each(['cross_chat_handoff_delivery', 'secure_peer_handoff_delivery', 'scheduled_job'])('reorders %s with user turns using exact neighbors, without rewriting or sending it', async purpose => {
    let serverQueue = [queuedTurn('a', 'A', 1), {
      ...queuedTurn('system', 'Authenticated content', 2), purpose,
      cross_chat_envelope_id: 'envelope-1', secure_peer_envelope_id: 'peer-1'
    }, queuedTurn('b', 'B', 3)]
    const originalSystem = { ...serverQueue[1] }
    const move = vi.fn(async (_sessionId: string, queuedId: string, direction: 'up' | 'down', expectedAdjacentQueuedId?: string) => {
      const from = serverQueue.findIndex(turn => turn.queued_id === queuedId)
      const to = from + (direction === 'up' ? -1 : 1)
      expect(serverQueue[to].queued_id).toBe(expectedAdjacentQueuedId)
      ;[serverQueue[from], serverQueue[to]] = [serverQueue[to], serverQueue[from]]
      serverQueue = serverQueue.map((turn, index) => ({ ...turn, position: index + 1 }))
      return serverQueue.map(turn => ({ ...turn }))
    })
    setupMixedQueue(serverQueue, move)
    render(<Composer />)
    expect(document.querySelectorAll('.queue-grip')).toHaveLength(3)
    const systemRow = screen.getByText('Authenticated content').closest('.queued-row')!
    expect(systemRow.querySelector('[title="More queue actions"]')).not.toBeNull()
    expect(systemRow.textContent).not.toContain('Send now')

    dragQueue('system', 'a', 'before')
    await waitFor(() => expect(queueLabels()).toEqual(['Authenticated content', 'A', 'B']))
    expect(move).toHaveBeenLastCalledWith('chat-1', 'system', 'up', 'a')
    await act(async () => undefined)
    dragQueue('system', 'b', 'after')
    await waitFor(() => expect(queueLabels()).toEqual(['A', 'B', 'Authenticated content']))
    expect(move.mock.calls.map(([, , direction, adjacent]) => [direction, adjacent])).toEqual([
      ['up', 'a'], ['down', 'a'], ['down', 'b']
    ])
    expect(serverQueue[2]).toEqual({ ...originalSystem, position: 3 })
    expect(useAppStore.getState().error).toBeNull()
  })

  it('moves async agent messages and ordinary messages across each other using exact neighbors', async () => {
    const agent: QueuedTurn = {
      ...queuedTurn('agent', 'Authenticated message', 2), purpose: 'cross_chat_handoff_delivery',
      conversation_mode: 'async_route_v1', source_title: 'Research agent',
      source_session_id: 'sender', cross_chat_envelope_id: 'envelope-1'
    }
    let serverQueue = [queuedTurn('user', 'User message', 1), agent]
    const move = vi.fn(async (_sessionId: string, queuedId: string, direction: 'up' | 'down', expectedAdjacentQueuedId?: string) => {
      const from = serverQueue.findIndex(turn => turn.queued_id === queuedId)
      const to = from + (direction === 'up' ? -1 : 1)
      expect(serverQueue[to].queued_id).toBe(expectedAdjacentQueuedId)
      ;[serverQueue[from], serverQueue[to]] = [serverQueue[to], serverQueue[from]]
      serverQueue = serverQueue.map((turn, index) => ({ ...turn, position: index + 1 }))
      return serverQueue.map(turn => ({ ...turn }))
    })
    setupMixedQueue(serverQueue, move)
    render(<Composer />)
    expect(document.querySelectorAll('.queue-grip')).toHaveLength(2)

    dragQueue('agent', 'user', 'before')
    await waitFor(() => expect(queueLabels()).toEqual(['Authenticated message', 'User message']))
    await act(async () => undefined)
    dragQueue('user', 'agent', 'before')
    await waitFor(() => expect(queueLabels()).toEqual(['User message', 'Authenticated message']))
    expect(move.mock.calls).toEqual([
      ['chat-1', 'agent', 'up', 'user'],
      ['chat-1', 'user', 'up', 'agent']
    ])
    expect(serverQueue[1]).toEqual(agent)
    expect(screen.getByText('Authenticated message').closest('.queued-row')).toHaveClass('agent-message')
    expect(screen.getByText('User message').closest('.queued-row')).not.toHaveClass('agent-message')
  })

  it('blocks an async agent message drag after promotion without submitting a move', async () => {
    const agent: QueuedTurn = {
      ...queuedTurn('agent', 'Authenticated message', 2), purpose: 'cross_chat_handoff_delivery',
      conversation_mode: 'async_route_v1', source_title: 'Research agent'
    }
    const initialQueue = [queuedTurn('user', 'User message', 1), agent]
    const promotedQueue = [initialQueue[0], { ...agent, promoted: true }]
    const move = vi.fn()
    setupMixedQueue(initialQueue, move, promotedQueue)
    render(<Composer />)
    act(() => useAppStore.getState().setQueued('chat-1', promotedQueue))
    dragQueue('agent', 'user', 'before')
    await waitFor(() => expect(useAppStore.getState().error).toMatch(/already starting/))
    expect(move).not.toHaveBeenCalled()
    expect(queueLabels()).toEqual(['User message', 'Authenticated message'])
    expect(screen.getByText('Authenticated message').closest('.queued-row')?.querySelector('button')).toBeNull()
  })

  it('stops a drag when the authoritative next neighbor changes and refreshes without extra moves', async () => {
    const initialQueue = [queuedTurn('a', 'A', 1), queuedTurn('b', 'B', 2), queuedTurn('c', 'C', 3)]
    const changedQueue = [queuedTurn('b', 'B', 1), queuedTurn('a', 'A', 2), queuedTurn('new', 'New arrival', 3), queuedTurn('c', 'C', 4)]
    const move = vi.fn().mockResolvedValue(changedQueue)
    const list = setupMixedQueue(initialQueue, move, changedQueue)
    render(<Composer />)
    dragQueue('a', 'c', 'after')
    await waitFor(() => expect(useAppStore.getState().error).toMatch(/queue changed/i))
    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith('chat-1', 'a', 'down', 'b')
    expect(list).toHaveBeenCalledTimes(1)
    expect(queueLabels()).toEqual(['B', 'A', 'New arrival', 'C'])
  })

  it('refreshes and stops on a server exact-neighbor conflict without retrying or optimistic ordering', async () => {
    const initialQueue = [queuedTurn('a', 'A', 1), queuedTurn('b', 'B', 2)]
    const move = vi.fn().mockRejectedValue(new Error('Queue neighbor changed'))
    const list = setupMixedQueue(initialQueue, move)
    render(<Composer />)
    dragQueue('a', 'b', 'after')
    await waitFor(() => expect(useAppStore.getState().error).toBe('Queue neighbor changed'))
    expect(move).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(queueLabels()).toEqual(['A', 'B'])
  })

  it('ignores volatile health churn and an unchanged parent render across the composer and queue shelf', async () => {
    const serializeCrossChatContract = vi.fn(() => ({ available: false, version: 7 }))
    const health = {
      ok: true,
      server_instance_id: 'boot-stable',
      active: ['chat-1'],
      active_sessions: ['chat-1'],
      queued: { 'chat-1': 1 },
      capabilities: {
        cross_chat_handoffs_v1: {
          available: false,
          version: 7,
          toJSON: serializeCrossChatContract
        }
      }
    } as unknown as Health
    const serverQueue = [queuedTurn('queued-a', 'Already queued', 1)]
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true, activeProfileId: null, profileGeneration: 0,
      profiles: [], switchingProfileId: null, selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null }, focusedChatPane: 'primary',
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: serverQueue, files: [], hasMoreEvents: false,
          filesTotal: 0, cachedAt: 0
        }
      },
      health, runtimeCatalog: null,
      uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
      chatReferencesBySession: {}, teamReferencesBySession: {}, agentRoutesBySession: {},
      agentRouteLoadingSessionIds: new Set(), agentRouteErrorsBySession: {},
      revokingAgentRouteIds: new Set(), activeSessionIds: new Set(),
      turnAdmissionTokens: {}, stoppingSessionIds: new Set(), error: null
    })
    const view = render(<Composer />)
    await act(async () => undefined)
    const composerRendersAfterMount = dndHarness.composerRenderHooks
    const shelfRendersAfterMount = dndHarness.sensorRenders
    const contractSerializationsAfterMount = serializeCrossChatContract.mock.calls.length

    // Streamed timeline/store updates retain the same health reference. Their
    // selectors must take the WeakMap fast path instead of serializing health
    // contracts on every event.
    act(() => useAppStore.setState({ error: 'unrelated streamed update' }))
    expect(serializeCrossChatContract).toHaveBeenCalledTimes(contractSerializationsAfterMount)

    view.rerender(<Composer />)
    await act(async () => undefined)
    expect(dndHarness.composerRenderHooks).toBe(composerRendersAfterMount)
    expect(dndHarness.sensorRenders).toBe(shelfRendersAfterMount)

    act(() => useAppStore.setState({
      health: {
        ...health,
        active: ['some-other-chat'],
        active_sessions: ['some-other-chat'],
        queued: { 'some-other-chat': 99 },
        state_dir: '/different-volatile-telemetry'
      }
    }))

    expect(dndHarness.composerRenderHooks).toBe(composerRendersAfterMount)
    expect(dndHarness.sensorRenders).toBe(shelfRendersAfterMount)
  })
})

function queuedTurn(queuedId: string, prompt: string, position: number): QueuedTurn {
  return { queued_id: queuedId, session_id: 'chat-1', prompt, file_ids: [], position }
}

function dragQueue(activeId: string, targetId: string, placement: 'before' | 'after'): void {
  act(() => dndHarness.onDragOver?.({
    active: { id: activeId, rect: { current: { translated: { top: placement === 'before' ? -20 : 100, height: 20 } } } },
    over: { id: targetId, rect: { top: 0, height: 20 } }
  } as unknown as DragOverEvent))
  act(() => dndHarness.onDragEnd?.({ active: { id: activeId }, over: { id: targetId } } as unknown as DragEndEvent))
}

function setupMixedQueue(turns: QueuedTurn[], move: unknown, refreshedTurns = turns) {
  const list = vi.fn().mockResolvedValue(refreshedTurns)
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      preferences: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
      queue: { move, list }
    } as unknown as AgentsDockAPI
  })
  useAppStore.setState({
    initialized: true, activeProfileId: null, profileGeneration: 0,
    profiles: [], switchingProfileId: null, selectedSessionId: 'chat-1',
    chatPanes: { primary: 'chat-1', secondary: null }, focusedChatPane: 'primary',
    sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
    snapshots: { 'chat-1': {
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [], queuedTurns: turns,
      files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
    } },
    health: { capabilities: { cross_chat_handoffs_v1: { available: true, features: { exact_queued_delivery_reorder: true } } } } as Health,
    runtimeCatalog: null, uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
    chatReferencesBySession: {}, teamReferencesBySession: {}, agentRoutesBySession: {}, activeSessionIds: new Set(),
    turnAdmissionTokens: {}, stoppingSessionIds: new Set(), error: null
  })
  return list
}

function queueLabels(): string[] {
  return [...document.querySelectorAll('.queue-prompt')].map(element => element.textContent ?? '')
}
