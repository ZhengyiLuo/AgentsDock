import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, Health, Session, SessionSnapshot } from '@shared/types'
import { clearTimelineProjectionCache } from '../lib/timeline-projection-cache'
import { clearTimelineViewStates, Timeline } from './Timeline'
import { useAppStore } from '../store/app-store'
import type { RenderTimelineItem } from '../lib/timeline'

const harness = vi.hoisted(() => ({ rows: [] as RenderTimelineItem[], scrollToIndex: vi.fn() }))
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  return { Virtuoso: React.forwardRef(function MockVirtuoso(props: {
    data: RenderTimelineItem[]
    computeItemKey: (index: number, item: RenderTimelineItem) => string
    itemContent: (index: number, item: RenderTimelineItem) => React.ReactNode
    components?: { Header?: React.ComponentType; Footer?: React.ComponentType }
    scrollerRef?: (node: HTMLElement | Window | null) => void
  }, ref: React.ForwardedRef<unknown>) {
    harness.rows = props.data
    React.useImperativeHandle(ref, () => ({ scrollToIndex: harness.scrollToIndex }))
    const setScroller = React.useCallback((node: HTMLDivElement | null) => props.scrollerRef?.(node), [props.scrollerRef])
    const Header = props.components?.Header, Footer = props.components?.Footer
    return <div ref={setScroller} data-testid="active-edge-list">
      {Header && <Header />}
      {props.data.map((item, index) => <div key={props.computeItemKey(index, item)}>{props.itemContent(index, item)}</div>)}
      {Footer && <Footer />}
    </div>
  }) }
})

const SESSION_ID = 'active-edge-chat'
const session: Session = { id: SESSION_ID, title: 'Synthetic active edge', backend: 'codex',
  codex_thread_id: 'synthetic-root-thread', codex_thread_status: { type: 'idle' } }
const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `edge-${seq}`, session_id: SESSION_ID, backend: 'codex', seq, type,
  ts: `2026-09-13T12:00:${String(seq).padStart(2, '0')}Z`, ...fields
})
const completedHistory = () => [
  event(10, 'turn_started', { run_id: 'old-run', prompt: 'Original human question' }),
  event(11, 'reasoning_summary', { run_id: 'old-run', phase: 'commentary', text: 'Original completed work' }),
  event(12, 'turn_finished', { run_id: 'old-run', result_text: 'Original completed answer' }),
  event(13, 'chat_conversation_message_received', {
    message_id: 'peer-arrival', cross_chat_envelope_id: 'peer-arrival', conversation_id: 'synthetic-pair',
    conversation_mode: 'async_route_v1', delivery_mode: 'mailbox', inbox_state: 'unread',
    source_session_id: 'synthetic-peer', source_title: 'Synthetic Peer', target_session_id: SESSION_ID,
    handoff_preview: 'The real peer message remains at its arrival position.'
  })
]
const snapshot = (events: Event[]): SessionSnapshot => ({ session, events, files: [], queuedTurns: [],
  hasMoreEvents: false, historyVerified: true, filesTotal: 0, cachedAt: 0 })
const health = (active: boolean, runId: string | null = 'current-native-run'): Health => ({
  ok: true, active: active ? [SESSION_ID] : [],
  active_runs: active && runId ? [{ session_id: SESSION_ID, run_id: runId }] : []
})

describe('authoritative live status outside loaded timeline history', () => {
  const search = vi.fn<AgentsDockAPI['timeline']['search']>()
  const around = vi.fn<AgentsDockAPI['timeline']['around']>()
  beforeEach(() => {
    harness.rows = []; harness.scrollToIndex.mockReset(); search.mockReset(); around.mockReset()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      timeline: {
        index: vi.fn().mockResolvedValue({ session_id: SESSION_ID, landmarks: [], latest_seq: 13, event_count: 4 }),
        search, around, saveViewState: vi.fn().mockResolvedValue(undefined),
        trace: vi.fn().mockResolvedValue({ events: [], has_more: false, next_after: null })
      },
      pins: { list: vi.fn().mockResolvedValue([]) }, files: { findEvent: vi.fn().mockResolvedValue(null) },
      events: { on: vi.fn().mockReturnValue(() => {}) }, native: { log: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ activeProfileId: null, profileGeneration: 0, profiles: [], selectedSessionId: SESSION_ID,
      sessions: [session], snapshots: { [SESSION_ID]: snapshot(completedHistory()) },
      health: health(true), activeSessionIds: new Set([SESSION_ID]), loadingSessionId: null,
      loadingSessionIds: new Set(), error: null })
  })
  afterEach(() => { cleanup(); clearTimelineProjectionCache(); clearTimelineViewStates(); vi.restoreAllMocks() })

  it.each(['current-native-run', null])('shows an ephemeral footer for an authoritative owner absent from history (%s)', runId => {
    useAppStore.setState({ health: health(true, runId) })
    const stored = useAppStore.getState().snapshots[SESSION_ID].events
    const { container } = render(<Timeline />)
    expect(screen.getAllByText('Working', { exact: true })).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(container.querySelectorAll('.chat-inbox-group')).toHaveLength(1)
    expect(screen.getByText('Original completed answer')).toBeInTheDocument()
    expect(container.querySelectorAll('.message-row.user')).toHaveLength(1)
    expect(harness.rows.filter(row => row.kind === 'progress' && row.active !== false)).toEqual([])
    const keys = harness.rows.map(row => row.key)
    expect(useAppStore.getState().snapshots[SESSION_ID].events).toBe(stored)
    act(() => useAppStore.setState({ health: health(false), activeSessionIds: new Set() }))
    expect(screen.queryByText('Working', { exact: true })).not.toBeInTheDocument()
    expect(harness.rows.map(row => row.key)).toEqual(keys)
    expect(useAppStore.getState().snapshots[SESSION_ID].events).toBe(stored)
  })

  it('does not show live status before either server or provider activity is known', () => {
    const unloaded: Session = { ...session, codex_thread_status: { type: 'notLoaded' } }
    useAppStore.setState({ sessions: [unloaded],
      snapshots: { [SESSION_ID]: { ...snapshot(completedHistory()), session: unloaded } },
      health: null, activeSessionIds: new Set() })
    render(<Timeline />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Working', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Original completed answer')).toBeInTheDocument()
  })

  it('covers a silent mailbox start, survives imported finish, and yields to actual native activity', () => {
    const wake = event(14, 'turn_started', { run_id: 'current-native-run', prompt: '', purpose: 'chat_mailbox_wake',
      provider_generated: true, mailbox_wake_id: `mailwake_${'a'.repeat(32)}`,
      mailbox_wake_through_seq: 13, provider_input_sha256: 'b'.repeat(64) })
    const records = [...completedHistory(), wake]
    useAppStore.setState({ snapshots: { [SESSION_ID]: snapshot(records) } })
    const { container } = render(<Timeline />)
    expect(screen.getAllByText('Working', { exact: true })).toHaveLength(1)
    const historyKeys = harness.rows.map(row => row.key)
    const importedFinish = event(15, 'turn_finished', { run_id: 'import_old_history', imported: true })
    act(() => useAppStore.setState({ snapshots: { [SESSION_ID]: snapshot([...records, importedFinish]) } }))
    expect(screen.getAllByText('Working', { exact: true })).toHaveLength(1)
    expect(harness.rows.map(row => row.key)).toEqual(historyKeys)
    const activity = event(16, 'reasoning_summary', { run_id: 'current-native-run', phase: 'commentary', text: 'Real native activity has arrived' })
    act(() => useAppStore.setState({ snapshots: { [SESSION_ID]: snapshot([...records, importedFinish, activity]) } }))
    expect(screen.queryByText('Working', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Real native activity has arrived')).toBeInTheDocument()
    expect(harness.rows.filter(row => row.kind === 'progress' && row.active !== false)).toHaveLength(1)
    expect(container.querySelectorAll('.message-row.user')).toHaveLength(1)
    expect(container.querySelectorAll('.chat-inbox-group')).toHaveLength(1)
    expect(useAppStore.getState().snapshots[SESSION_ID].events).toEqual([...records, importedFinish, activity])
  })

  it.each([false, true])('does not infer this chat is running from provider activity or another owner (other owner: %s)', otherOwner => {
    const providerActive: Session = { ...session, codex_thread_status: { type: 'active', activeFlags: [] } }
    useAppStore.setState({ sessions: [providerActive], snapshots: { [SESSION_ID]: { ...snapshot(completedHistory()), session: providerActive } },
      health: { ok: true, active: otherOwner ? ['other-chat'] : [],
        active_runs: otherOwner ? [{ session_id: 'other-chat', run_id: 'other-native-run' }] : [] },
      activeSessionIds: new Set(otherOwner ? ['other-chat'] : []) })
    render(<Timeline />)
    expect(screen.queryByText('Working', { exact: true })).not.toBeInTheDocument()
    expect(harness.rows.some(row => row.kind === 'progress' && row.active !== false)).toBe(false)
    expect(screen.getByText('Original completed answer')).toBeInTheDocument()
  })

  it('keeps a searched historical window settled while the live owner continues elsewhere', async () => {
    const old = event(1, 'assistant_text', { run_id: 'older-native-run', text: 'Historical answer remains settled' })
    search.mockResolvedValue([{ session_id: SESSION_ID, event_id: old.id, seq: old.seq, ts: old.ts,
      role: 'assistant', snippet: 'Historical answer remains settled' }])
    around.mockResolvedValue({ session, events: [old], has_more: false, next_before: null, latest_seq: 16 })
    render(<Timeline />)
    expect(screen.getByText('Working', { exact: true })).toBeInTheDocument()
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:find-in-chat', { detail: { sessionId: SESSION_ID } })))
    fireEvent.change(screen.getByPlaceholderText('Search full chat history'), { target: { value: 'Historical answer' } })
    const found = await screen.findByText('Historical answer remains settled')
    fireEvent.click(found.closest('button')!)
    await waitFor(() => expect(around).toHaveBeenCalledWith(SESSION_ID, 1, expect.any(Number)))
    await waitFor(() => expect(screen.queryByText('Working', { exact: true })).not.toBeInTheDocument())
    expect(screen.getByText('Historical answer remains settled')).toBeInTheDocument()
    expect(harness.rows.some(row => row.kind === 'progress' && row.active !== false)).toBe(false)
    expect(useAppStore.getState().activeSessionIds.has(SESSION_ID)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Return to latest' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Working'))
    expect(screen.getByText('Original completed answer')).toBeInTheDocument()
    expect(harness.rows.some(row => row.kind === 'progress' && row.active !== false)).toBe(false)
  })
})
