import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, Session } from '@shared/types'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { Composer } from './Composer'

const session: Session = { id: 'chat-1', title: 'Parent', backend: 'codex' }
const childEvent = (seq: number, status: string, patch: Partial<Event> = {}): Event => ({
  id: `child-event-${seq}`, seq, session_id: session.id, run_id: 'parent-run',
  type: 'subagent_state', backend: 'codex', ts: '2026-09-28T12:00:00Z',
  subagent_id: 'native-child', subagent_status: status, ...patch
})
function snapshot(events: Event[], owner = session) {
  return { session: owner, events, queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0 }
}

function expectNoStopControl() {
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stop subagents' })).toBeNull()
}

describe('Composer Stop with native Codex subagents', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      turns: { stop: vi.fn().mockResolvedValue({ stopped: true }) },
      sessions: { reloadProvider: vi.fn(), update: vi.fn() }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 0, profiles: [], switchingProfileId: null,
      connected: false, connectionGeneration: 0, syncStatus: 'live', syncError: null,
      syncBySession: { [session.id]: { status: 'live', error: null } },
      selectedSessionId: session.id, chatPanes: { primary: session.id, secondary: null }, focusedChatPane: 'primary',
      sessions: [session], snapshots: {}, uploadsBySession: {}, uploadPathsBySession: {}, drafts: {},
      chatReferencesBySession: {}, teamReferencesBySession: {}, agentRoutesBySession: {},
      agentRouteLoadingSessionIds: new Set(), agentRouteErrorsBySession: {}, revokingAgentRouteIds: new Set(),
      activeSessionIds: new Set(), turnAdmissionTokens: {}, pendingTurnSubmissions: {}, stoppingSessionIds: new Set(),
      runtimeCatalog: null, health: null, error: null
    })
  })
  afterEach(() => { cleanup(); resetTransientCloseStackForTests(); vi.restoreAllMocks() })

  it('offers native Stop for an idle parent with a live child without changing Send into Queue', async () => {
    const live = childEvent(1, 'running')
    useAppStore.setState({ snapshots: { [session.id]: snapshot([live]) } })
    let finish!: (value: { stopped: boolean; pending: boolean; message: string }) => void
    const stop = vi.fn(() => new Promise<{ stopped: boolean; pending: boolean; message: string }>(resolve => { finish = resolve }))
    window.agentsDock.turns.stop = stop
    const user = userEvent.setup()
    render(<Composer />)

    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue message' })).toBeNull()
    expect(useAppStore.getState().activeSessionIds.has(session.id)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toHaveAttribute('title', '1 subagent running · Stop the running subagents. The main chat is idle.')
    await user.click(screen.getByRole('button', { name: 'Stop subagents' }))
    expect(stop).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    expect(window.agentsDock.sessions.reloadProvider).not.toHaveBeenCalled()
    expect(window.agentsDock.sessions.update).not.toHaveBeenCalled()

    finish({ stopped: false, pending: true, message: 'Still stopping the child. Retry Stop.' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled())
    expect(useAppStore.getState().error).toBe('Still stopping the child. Retry Stop.')
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([live, childEvent(2, 'stopped')]) } }))
    expectNoStopControl()
  })

  it('keeps Stop scoped to the active main turn and its live children', async () => {
    useAppStore.setState({ activeSessionIds: new Set([session.id]), snapshots: {
      [session.id]: snapshot([childEvent(1, 'running')])
    } })
    render(<Composer />)
    expect(screen.queryByRole('button', { name: 'Stop subagents' })).toBeNull()
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop).toHaveAttribute('title', '1 subagent running · Stop the main chat and its running subagents.')
    await userEvent.click(stop)
    expect(window.agentsDock.turns.stop).toHaveBeenCalledExactlyOnceWith(session.id)
  })

  it.each(['completed', 'failed', 'stopped', 'tracking_lost'])('does not treat historical %s children as live work', status => {
    useAppStore.setState({ snapshots: { [session.id]: snapshot([childEvent(1, 'running'), childEvent(2, status)]) } })
    render(<Composer />)
    expectNoStopControl()
  })

  it.each(['turn_finished', 'turn_stopped'])('removes stale Stop when an unfinished spawn owner emits %s', terminal => {
    const owner: Session = { ...session, codex_thread_id: 'current-root' }
    const spawn: Event = { id: 'unfinished-spawn', seq: 1, session_id: session.id,
      run_id: 'parent-run', backend: 'codex', type: 'tool_started', ts: '2026-09-28T12:00:00Z',
      tool: { id: 'unfinished-call', name: 'spawn_agent', input: {} } }
    useAppStore.setState({ sessions: [owner], snapshots: { [session.id]: snapshot([spawn], owner) } })
    render(<Composer />)
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()
    const finished: Event = { ...spawn, id: 'parent-ended', seq: 2, type: terminal, tool: undefined }
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([spawn, finished], owner) } }))
    expectNoStopControl()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
    expect(window.agentsDock.turns.stop).not.toHaveBeenCalled()
    const confirmed = childEvent(3, 'running', { subagent_id: 'late-child',
      subagent_tool_id: 'unfinished-call', subagent_parent_thread_id: 'current-root' })
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([spawn, finished, confirmed], owner) } }))
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()
  })

  it('does not infer ownership when an older server omits a nested ancestor and root metadata', () => {
    const owner: Session = { ...session, codex_thread_id: 'current-root' }
    useAppStore.setState({ sessions: [owner], snapshots: { [session.id]: snapshot([
      childEvent(1, 'running', { subagent_parent_thread_id: 'omitted-parent' })
    ], owner) } })
    render(<Composer />)
    expectNoStopControl()
  })

  it('does not show Stop for inherited spawn records in an idle fork, but allows stopping new work', () => {
    const owner: Session = { ...session, codex_thread_id: 'fork-root' }
    const copied: Event = {
      id: 'copied-spawn', seq: 1, session_id: session.id, run_id: 'source-run',
      type: 'tool_started', ts: '2026-09-28T12:00:00Z', forked: true,
      tool: { id: 'source-call', name: 'spawn_agent', input: {} }
    }
    useAppStore.setState({ sessions: [owner], snapshots: { [session.id]: snapshot([copied], owner) } })
    render(<Composer />)
    expectNoStopControl()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
    const live = childEvent(2, 'running', { subagent_parent_thread_id: 'fork-root' })
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([copied, live], owner) } }))
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([copied, live,
      childEvent(3, 'stopped', { subagent_parent_thread_id: 'fork-root' })], owner) } }))
    expectNoStopControl()
  })

  it('ignores running children from an earlier native thread but keeps nested current children stoppable', () => {
    const owner: Session = { ...session, codex_thread_id: 'current-root' }
    const old = childEvent(1, 'running', { subagent_parent_thread_id: 'old-root' })
    useAppStore.setState({ sessions: [owner], snapshots: { [session.id]: snapshot([old], owner) } })
    render(<Composer />)
    expectNoStopControl()
    const parent = childEvent(2, 'completed', { subagent_id: 'current-child', subagent_parent_thread_id: 'current-root' })
    const nested = childEvent(3, 'running', { subagent_id: 'nested-child', subagent_parent_thread_id: 'current-child' })
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([old, parent, nested], owner) } }))
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()
    act(() => useAppStore.setState({ snapshots: { [session.id]: snapshot([old, parent, nested,
      childEvent(4, 'stopped', { subagent_id: 'nested-child', subagent_parent_thread_id: 'current-child' })], owner) } }))
    expectNoStopControl()
  })

  it('keeps a current nested child stoppable when its completed parent is outside the history page', () => {
    const owner: Session = { ...session, codex_thread_id: 'current-root' }
    useAppStore.setState({ sessions: [owner], snapshots: { [session.id]: snapshot([
      childEvent(4, 'running', { subagent_parent_thread_id: 'omitted-parent', subagent_root_thread_id: 'current-root' })
    ], owner) } })
    render(<Composer />)
    expect(screen.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()
  })

  it('keeps the Stop action scoped to the visible composer and does not infer Claude behavior', async () => {
    const other: Session = { id: 'chat-2', title: 'Other', backend: 'codex' }
    useAppStore.setState({ sessions: [session, other], snapshots: {
      [session.id]: snapshot([]),
      [other.id]: snapshot([childEvent(1, 'running', { session_id: other.id })], other)
    } })
    const rendered = render(<Composer />)
    expectNoStopControl()
    rendered.rerender(<Composer sessionId={other.id} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop subagents' }))
    expect(window.agentsDock.turns.stop).toHaveBeenCalledExactlyOnceWith(other.id)
    const claude: Session = { ...session, backend: 'claude' }
    act(() => useAppStore.setState({ sessions: [claude], snapshots: {
      [session.id]: snapshot([childEvent(1, 'running', { backend: 'claude' })], claude)
    } }))
    rendered.rerender(<Composer sessionId={session.id} />)
    expectNoStopControl()
  })
})
