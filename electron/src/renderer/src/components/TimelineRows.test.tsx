import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFile, CrossChatExchange, Event, WorkspaceProfileScope } from '@shared/types'
import { TOOL_OUTPUT_PREVIEW_CHARS } from '@shared/event-compaction'
import type { AgentsDockAPI } from '@shared/ipc'
import { projectTimeline, renderTimelineItems, type JobItem, type MessageItem, type ProgressItem, type SystemItem, type TraceItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView as TimelineRowViewImpl } from './TimelineRows'
import { setLocale } from '@shared/i18n'
import { formatTime } from '../lib/format'
import { setReasoningDisplay } from '../lib/reasoning-display'

afterEach(cleanup)
afterEach(() => setLocale('en'))
afterEach(() => setReasoningDisplay('compact'))
const originalSelectSession = useAppStore.getState().selectSession
const originalAcknowledgeEmergency = useAppStore.getState().acknowledgeEmergency
const TEST_PIN_PROFILE_SCOPE: WorkspaceProfileScope = {
  profileId: 'profile-a',
  profileGeneration: 0,
  serverIdentity: null
}

function TimelineRowView(props: Omit<ComponentProps<typeof TimelineRowViewImpl>, 'profileScope'> & { profileScope?: WorkspaceProfileScope | null }) {
  return <TimelineRowViewImpl {...props} profileScope={props.profileScope ?? TEST_PIN_PROFILE_SCOPE} />
}

describe('timeline pin state', () => {
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  const loadTrace = vi.fn()
  const loadJobRuns = vi.fn()
  const loadHandoff = vi.fn()
  const cancelHandoff = vi.fn()
  const loadExchange = vi.fn()
  const cancelExchange = vi.fn()
  const listQueue = vi.fn()
  const skipCrossChatDelivery = vi.fn()

  beforeEach(() => {
    writeClipboard.mockClear()
    loadTrace.mockReset()
    loadTrace.mockResolvedValue({ events: [], has_more: false, next_after: null })
    loadJobRuns.mockReset()
    loadJobRuns.mockResolvedValue({ runs: [], total: 0, has_more: false, next_before: null, supported: false })
    loadHandoff.mockReset()
    cancelHandoff.mockReset()
    cancelHandoff.mockResolvedValue({
      id: 'handoff-1', kind: 'instruction', action: 'instruction', status: 'cancelled',
      source_session_id: 'chat-1', source_run_id: 'run-1', target_session_id: 'chat-2',
      created_at: '2026-07-10T14:31:00Z', updated_at: '2026-07-10T14:32:00Z'
    })
    loadExchange.mockReset()
    cancelExchange.mockReset()
    listQueue.mockReset()
    listQueue.mockResolvedValue([])
    skipCrossChatDelivery.mockReset()
    skipCrossChatDelivery.mockResolvedValue(true)
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 0, selectedSessionId: null,
      connected: true, connectionGeneration: 3,
      health: { ok: true, server_instance_id: 'instance-a' },
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary',
      profiles: [], sessions: [], snapshots: {}, jobs: [], selectSession: originalSelectSession,
      acknowledgeEmergency: originalAcknowledgeEmergency
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { writeClipboard },
        files: {
          mediaURL: vi.fn((
            _profileId: string,
            _generation: number,
            _sessionId: string,
            fileId: string
          ) => `agentsdock-media://file/${fileId}`),
          open: vi.fn(), save: vi.fn(), reveal: vi.fn()
        },
        pins: { put: vi.fn(), remove: vi.fn() },
        timeline: { trace: loadTrace },
        handoffs: { get: loadHandoff, cancel: cancelHandoff },
        exchanges: { get: loadExchange, cancel: cancelExchange },
        queue: { list: listQueue, skipCrossChatDelivery },
        jobs: { runs: loadJobRuns }
      } as unknown as AgentsDockAPI
    })
  })

  it.each([
    ['registered', undefined, 'unread', 'Delivery unconfirmed'],
    ['registered', 'stored', 'unread', 'In inbox · unread by agent'],
    ['read', 'read', 'read', 'Read by agent'],
    ['cancelled', 'cancelled', 'cancelled', 'Cancelled'],
    ['failed', 'failed', 'unread', 'Delivery failed']
  ] as const)('labels the outgoing %s receipt honestly (%s)', (phase, status, inboxState, expected) => {
    const event: Event = {
      id: 'mailbox-receipt', seq: 1, session_id: 'chat-1', ts: '2026-09-12T00:00:00Z',
      type: `chat_conversation_message_${phase}`, conversation_mode: 'async_route_v1',
      delivery_mode: 'mailbox', conversation_id: 'pair-one', message_id: 'message-one',
      source_session_id: 'chat-1', target_session_id: 'chat-2', target_title: 'Training',
      handoff_status: status, inbox_state: inboxState, received_at: '2026-09-12T00:00:00Z',
      handoff_preview: 'The exact original message.'
    }
    render(<TimelineRowView item={{ kind: 'system', id: 'mailbox-one', key: 'mailbox-one', seq: 1,
      event, events: [event], crossChatMessage: true }} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByRole('button', { name: 'To Training' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(expected)
    expect(screen.queryByText('Sent to Training')).not.toBeInTheDocument()
    expect(loadHandoff).not.toHaveBeenCalled()
  })

  it('updates memoized message controls when language changes and preserves authored text', () => {
    const event: Event = {
      id: 'locale-message', session_id: 'chat-1', seq: 1, type: 'assistant_text',
      ts: '2026-07-10T14:29:00Z', text: 'Working / New chat / /tmp/Prompt.txt'
    }
    const item: MessageItem = {
      kind: 'message', id: 'locale-message', key: 'locale-message', seq: 1,
      event, events: [event], role: 'assistant', files: []
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByTitle('Copy full message')).toBeInTheDocument()
    act(() => setLocale('zh-CN'))
    expect(screen.getByTitle('复制完整消息')).toBeInTheDocument()
    expect(screen.getByTitle('置顶消息')).toBeInTheDocument()
    expect(screen.getByText(event.text!)).toBeInTheDocument()
    act(() => setLocale('en'))
    expect(screen.getByTitle('Copy full message')).toBeInTheDocument()
  })

  it('localizes Team Network generated copy while preserving the authored title', () => {
    const timestamp = new Date().toISOString()
    setLocale('zh-CN')
    const event: Event = {
      id: 'team-locale', session_id: 'chat-1', seq: 1, type: 'team_message_sent',
      ts: timestamp, kind: 'message', title: 'Team release',
      recipients: [{ kind: 'all', display_name: 'Everyone' }]
    }
    const item: SystemItem = { kind: 'system', id: 'team-locale', key: 'team-locale', seq: 1, event }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByText('已广播“Team release”至公告栏')).toBeInTheDocument()
    expect(screen.getByText(formatTime(timestamp), { selector: 'time' })).toBeInTheDocument()
    act(() => setLocale('en'))
    expect(screen.getByText('Broadcast “Team release” to Bulletin')).toBeInTheDocument()
  })

  it('shows a filled unpin action for a pinned message', () => {
    const event: Event = {
      id: 'event-1', session_id: 'chat-1', seq: 1, type: 'assistant_text',
      ts: '2026-07-10T14:29:00Z', text: 'Pinned response'
    }
    const item: MessageItem = {
      kind: 'message', id: 'message-1', key: 'message-1', seq: 1,
      event, events: [event], role: 'assistant', files: []
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set(['message:event-1'])} />)

    expect(screen.getByTitle('Unpin message')).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders a completed digest as one compact status without its generated body', () => {
    const event: Event = {
      id: 'digest-sent', session_id: 'chat-1', seq: 8, type: 'handoff_digest_sent',
      ts: '2026-07-10T14:29:00Z', digest_job_id: 'digest-1',
      message: 'Context digest from Source was sent to Target.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'digest:digest-1', key: 'digest:digest-1', seq: 2, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Digest Sent')).toBeInTheDocument()
    expect(screen.getByText('Context digest from Source was sent to Target.')).toBeInTheDocument()
    expect(screen.queryByText('AgentsDock Context Digest')).not.toBeInTheDocument()
  })

  it('renders a sent team message as one blue link to Team Network', () => {
    const event: Event = {
      id: 'team-message-sent-1', session_id: 'chat-1', seq: 9, type: 'team_message_sent',
      ts: '2026-09-03T15:00:00Z', message_id: 'message-1', kind: 'skill', title: 'Safe deployment runbook',
      recipients: [{ kind: 'all', display_name: 'Everyone' }],
      attachments: 2, skill_slug: 'deploy-safely', skill_version: 3
    }
    const item = renderTimelineItems(projectTimeline([event], []))[0]
    expect(item).toMatchObject({ kind: 'system', event: { type: 'team_message_sent' } })

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(container.querySelector('.system-row.team-message-sent')).toHaveAttribute('data-message-id', 'message-1')
    const link = screen.getByRole('button', { name: 'Open Published “Safe deployment runbook” to Bulletin' })
    expect(link).toHaveClass('team-message-sent')
    const open = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', open, { once: true })
    fireEvent.click(link)
    expect((open.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'feed' })
  })

  it('opens explicit all-server fanout in Team Mail, not Bulletin', () => {
    const event: Event = { id: 'fanout-sent', session_id: 'chat-1', seq: 10, type: 'team_message_sent',
      ts: '2026-09-08T12:00:00Z', team_id: 'team-1', message_id: 'fanout-1', kind: 'message', destination: 'all_servers',
      recipients: [{ kind: 'server', display_name: 'Studio' }, { kind: 'server', display_name: 'Atlas' }] }
    const item = renderTimelineItems(projectTimeline([event], []))[0]
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const open = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', open, { once: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open Sent a team message to all server inboxes' }))
    expect((open.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'mail', teamId: 'team-1', messageId: 'fanout-1', mailboxBox: 'sent', profileId: 'profile-a' })
  })

  it('renders coalesced provider interaction history as one compact disclosure', () => {
    const request: Event = {
      id: 'request-event', session_id: 'chat-1', seq: 7, type: 'claude_interaction_requested',
      ts: '2026-07-10T14:27:00Z',
      interaction: {
        id: 'request-1', session_id: 'chat-1', thread_id: 'thread-1', method: 'item/commandExecution/requestApproval',
        params: {}, created_at: '2026-07-10T14:27:00Z'
      }
    }
    const resolved: Event = {
      id: 'resolved-event', session_id: 'chat-1', seq: 8, type: 'claude_interaction_resolved',
      ts: '2026-07-10T14:28:00Z', interaction_id: 'request-1',
      request_method: 'item/commandExecution/requestApproval', resolution: 'answered'
    }
    const item: SystemItem = {
      kind: 'system', id: 'provider-interaction-audit:claude:run-1',
      key: 'provider-interaction-audit:claude:run-1', seq: 8, event: resolved,
      events: [request, resolved]
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const disclosure = container.querySelector('.system-row.provider-interaction-audit')
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.getByText('Claude request history')).toBeInTheDocument()
    expect(screen.getByText('1 request · 1 resolved')).toBeInTheDocument()
    expect(container.querySelectorAll('.system-row')).toHaveLength(1)

    fireEvent.click(screen.getByText('Claude request history'))
    expect(disclosure).toHaveAttribute('open')
    expect(screen.getByText('Command approval')).toBeInTheDocument()
    expect(screen.getByText('Resolved')).toBeInTheDocument()
    expect(screen.getByText(
      'This history is read-only. Any current request appears above the message box.'
    )).toBeInTheDocument()
    expect(screen.queryByText(/approval panel/i)).not.toBeInTheDocument()
  })

  it('renders an imported Claude task notification as a compact system row', () => {
    const source: Event[] = [{
      id: 'provider-task-1', session_id: 'chat-1', seq: 9, type: 'turn_started',
      ts: '2026-09-08T05:47:00Z', run_id: 'import_history_1', backend: 'claude', imported: true,
      prompt: '<task-notification><task-id>task-1</task-id><tool-use-id>tool-1</tool-use-id><status>stopped</status><summary>No completion record was found.</summary></task-notification>'
    }]
    const [item] = renderTimelineItems(projectTimeline(source, []))
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(container.querySelector('.system-row')).toHaveTextContent('Claude background task')
    expect(container.querySelector('.system-row')).toHaveTextContent('Background task stopped. No completion record was found.')
    expect(container.querySelector('.message-row.user')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('<task-notification>')
  })

  it.each(['steer', 'stop', 'unknown'] as const)('renders a proven %s interruption at its original time, without user or live controls', cause => {
    const source: Event = {
      id: 'repaired-interruption', session_id: 'chat-1', seq: 18526, type: 'provider_interruption',
      ts: '2026-09-09T20:33:00Z', backend: 'claude', imported: true,
      prompt: '[Request interrupted by user]',
      provider_origin: { provider: 'claude', kind: 'interruption', cause,
        event_id: '6ab1aa42-7518-4ad3-9175-e605e381936e', session_id: 'f8061024-af24-4765-a395-74c638c37b03',
        timestamp: '2026-09-09T20:16:54.515Z' }
    }
    const [item] = renderTimelineItems(projectTimeline([source], []))
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(container.querySelector('.system-row')).toHaveTextContent('Claude interruption')
    expect(container.querySelector('time')).toHaveTextContent(formatTime(source.provider_origin!.timestamp))
    expect(container).toHaveTextContent('Historical record; not a new message.')
    if (cause === 'steer') expect(container).toHaveTextContent('interrupted by a steering message')
    if (cause === 'stop') expect(container).toHaveTextContent('earlier response was stopped')
    if (cause === 'unknown') {
      expect(container).toHaveTextContent('Its cause is not confirmed')
      expect(container).not.toHaveTextContent('was stopped')
    }
    expect(container.querySelector('.message-row.user')).not.toBeInTheDocument()
    expect(container.querySelector('.system-row.error')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('[Request interrupted by user]')
    expect(container.querySelector('button')).not.toBeInTheDocument()
    act(() => setLocale('zh-CN'))
    expect(container).toHaveTextContent('Claude 中断记录')
  })

  it('renders an emergency alert as its own red system card', () => {
    const event: Event = {
      id: 'emergency-raised', session_id: 'chat-1', seq: 7, type: 'emergency_alert_raised',
      ts: '2026-08-25T12:00:00Z', emergency_alert_id: 'alert-1',
      message: 'The production rollback needs approval.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'event:emergency-raised', key: 'event:emergency-raised', seq: 7, event
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const row = container.querySelector('.system-row.emergency')
    expect(row).toHaveAttribute('data-event-id', 'emergency-raised')
    expect(row).toHaveTextContent('Emergency alert raised')
    expect(row).toHaveTextContent('The production rollback needs approval.')
    expect(container.querySelectorAll('.system-row')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Acknowledge emergency/ })).not.toBeInTheDocument()
  })

  it('acknowledges the exact active alert once from its timeline card and exposes pending state', async () => {
    let resolveAcknowledge: (acknowledged: boolean) => void = () => undefined
    const acknowledgeEmergency = vi.fn(() => new Promise<boolean>(resolve => {
      resolveAcknowledge = resolve
    }))
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Production watch', backend: 'codex',
        emergency_alert: {
          id: 'alert-1', status: 'active', severity: 'critical',
          message: 'The production rollback needs approval.',
          raised_at: '2026-08-25T12:00:00Z'
        },
        unacknowledged_emergency_count: 1
      }],
      acknowledgeEmergency
    })
    const event: Event = {
      id: 'emergency-raised', session_id: 'chat-1', seq: 7, type: 'emergency_alert_raised',
      ts: '2026-08-25T12:00:00Z', emergency_alert_id: 'alert-1',
      message: 'The production rollback needs approval.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'event:emergency-raised', key: 'event:emergency-raised', seq: 7, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    const button = screen.getByRole('button', { name: 'Acknowledge emergency in Production watch' })
    fireEvent.click(button)

    expect(acknowledgeEmergency).toHaveBeenCalledOnce()
    expect(acknowledgeEmergency).toHaveBeenCalledWith('chat-1', 'alert-1')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(acknowledgeEmergency).toHaveBeenCalledOnce()

    await act(async () => resolveAcknowledge(true))

    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
  })

  it('keeps a failed timeline acknowledgement visible and retryable', async () => {
    const acknowledgeEmergency = vi.fn().mockResolvedValue(false)
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Production watch', backend: 'codex',
        emergency_alert: {
          id: 'alert-2', status: 'active', severity: 'critical',
          message: 'The database is no longer accepting writes.',
          raised_at: '2026-08-25T12:01:00Z'
        },
        unacknowledged_emergency_count: 1
      }],
      acknowledgeEmergency
    })
    const event: Event = {
      id: 'emergency-raised-2', session_id: 'chat-1', seq: 8, type: 'emergency_alert_raised',
      ts: '2026-08-25T12:01:00Z', emergency_alert_id: 'alert-2',
      message: 'The database is no longer accepting writes.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'event:emergency-raised-2', key: 'event:emergency-raised-2', seq: 8, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    const button = screen.getByRole('button', { name: 'Acknowledge emergency in Production watch' })
    fireEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t acknowledge. Try again.')
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
    fireEvent.click(button)
    await waitFor(() => expect(acknowledgeEmergency).toHaveBeenCalledTimes(2))
  })

  it('uses the durable embedded alert ID and removes only the action after acknowledgement', async () => {
    const alert = {
      id: 'alert-embedded', status: 'active' as const, severity: 'critical' as const,
      message: 'The storage controller needs intervention.',
      raised_at: '2026-08-25T12:02:00Z'
    }
    const acknowledgeEmergency = vi.fn(async () => {
      useAppStore.setState({
        sessions: [{
          id: 'chat-1', title: 'Storage watch', backend: 'codex',
          emergency_alert: { ...alert, status: 'acknowledged' },
          unacknowledged_emergency_count: 0
        }]
      })
      return true
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Storage watch', backend: 'codex',
        emergency_alert: alert, unacknowledged_emergency_count: 1
      }],
      acknowledgeEmergency
    })
    const event: Event = {
      id: 'emergency-embedded', session_id: 'chat-1', seq: 9, type: 'emergency_alert_raised',
      ts: alert.raised_at, emergency_alert: alert, message: alert.message
    }
    const item: SystemItem = {
      kind: 'system', id: 'event:emergency-embedded', key: 'event:emergency-embedded', seq: 9, event
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge emergency in Storage watch' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /Acknowledge emergency/ })).not.toBeInTheDocument())
    expect(acknowledgeEmergency).toHaveBeenCalledWith('chat-1', 'alert-embedded')
    expect(container.querySelector('.system-row.emergency')).toHaveTextContent('The storage controller needs intervention.')
  })

  it('does not expose acknowledgement on a stale emergency card', () => {
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Production watch', backend: 'codex',
        emergency_alert: {
          id: 'alert-current', status: 'active', severity: 'critical',
          message: 'A newer emergency is active.', raised_at: '2026-08-25T12:03:00Z'
        },
        unacknowledged_emergency_count: 1
      }]
    })
    const event: Event = {
      id: 'emergency-stale', session_id: 'chat-1', seq: 6, type: 'emergency_alert_raised',
      ts: '2026-08-25T11:59:00Z', emergency_alert_id: 'alert-old', message: 'Old emergency.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'event:emergency-stale', key: 'event:emergency-stale', seq: 6, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.queryByRole('button', { name: /Acknowledge emergency/ })).not.toBeInTheDocument()
  })

  it('renders a received digest as a folded target-chat handoff', () => {
    const event: Event = {
      id: 'digest-received', session_id: 'chat-2', seq: 9, type: 'handoff_digest_received',
      ts: '2026-07-10T14:30:00Z', digest_job_id: 'digest-1', source_session_id: 'chat-1',
      message: 'Context digest from Source was delivered to this chat.',
      digest: '# AgentsDock Context Digest\n\nPrivate handoff body'
    }
    const item: SystemItem = {
      kind: 'system', id: 'digest:digest-1', key: 'digest:digest-1', seq: 9, event
    }
    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Context Digest')).toBeInTheDocument()
    expect(screen.getByText('Context digest from Source was delivered to this chat.')).toBeInTheDocument()
    expect(screen.getByText('View digest')).toBeInTheDocument()
    expect(screen.getByText('AgentsDock Context Digest')).not.toBeVisible()
  })

  it('renders immutable sent chat references as clickable navigation pills', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      selectSession,
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Renamed target', backend: 'claude' }
      ]
    })
    const event: Event = {
      id: 'turn-start', session_id: 'chat-1', seq: 12, type: 'turn_started',
      ts: '2026-07-10T14:31:00Z', prompt: 'Ask @Training to verify this.',
      chat_references: [{
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: 4, source_text_end: 13, action: 'instruction'
      }]
    }
    const item: MessageItem = {
      kind: 'message', id: 'turn', key: 'turn', seq: 12,
      event, events: [event], role: 'user', files: []
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent may send to Training' }))

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('chat-2'))
  })

  it('keeps legacy direct-message history readable without duplicating current route hints', () => {
    useAppStore.setState({ sessions: [
      { id: 'chat-2', title: 'Direct target', backend: 'claude' },
      { id: 'chat-3', title: 'Route target', backend: 'codex' }
    ] })
    const event: Event = {
      id: 'addressed-turn', session_id: 'chat-1', seq: 13, type: 'turn_started',
      ts: '2026-08-26T14:31:00Z', prompt: '@Direct @@Route',
      chat_references: [
        { session_id: 'chat-2', display_title_snapshot: 'Direct', source_text_start: 0, source_text_end: 7, action: 'direct_message' },
        { session_id: 'chat-3', display_title_snapshot: 'Route', source_text_start: 8, source_text_end: 15, action: 'route' }
      ]
    }
    const item: MessageItem = {
      kind: 'message', id: 'addressed-turn', key: 'addressed-turn', seq: 13,
      event, events: [event], role: 'user', files: []
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByRole('button', { name: 'Legacy chat reference to Direct' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Route hint for Route' })).toHaveTextContent('@@Route')
    expect(screen.queryByRole('button', { name: /Route hint for Route/ })).not.toBeInTheDocument()
  })

  it('renders a structured @Chat route inline and navigates by its immutable session id', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      selectSession,
      sessions: [{ id: 'chat-2', title: 'Renamed target', backend: 'codex' }]
    })
    const prompt = ':wave: Ask @Training to **verify** this.'
    const start = prompt.indexOf('@Training')
    const event: Event = {
      id: 'route-turn-start', session_id: 'chat-1', seq: 14, type: 'turn_started',
      ts: '2026-08-27T14:31:00Z', prompt,
      chat_references: [{
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: start, source_text_end: start + '@Training'.length, action: 'route'
      }]
    }
    const item: MessageItem = {
      kind: 'message', id: 'route-turn', key: 'route-turn', seq: 14,
      event, events: [event], role: 'user', files: []
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const reference = screen.getByRole('link', { name: 'Route hint for Training' })
    expect(reference).toHaveTextContent('@Training')
    expect(reference).toHaveClass('timeline-inline-chat-reference', 'action-route')
    expect(screen.getByText('verify').closest('strong')).not.toBeNull()
    expect(container.querySelector('.sent-chat-references')).not.toBeInTheDocument()

    fireEvent.click(reference)
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('chat-2'))
  })

  it('renders structured Team Network people and server inboxes as distinct inline references', () => {
    const prompt = 'Tell @@Pat then notify @@Atlas now.'
    const patStart = prompt.indexOf('@@Pat')
    const atlasStart = prompt.indexOf('@@Atlas')
    const event: Event = {
      id: 'team-turn-start', session_id: 'chat-1', seq: 15, type: 'turn_started',
      ts: '2026-09-06T16:45:00Z', prompt,
      team_references: [{
        kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'human-1',
        display_name_snapshot: 'Pat', source_text_start: patStart,
        source_text_end: patStart + '@@Pat'.length, grant_intent: true
      }, {
        kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'server-1',
        display_name_snapshot: 'Atlas', source_text_start: atlasStart,
        source_text_end: atlasStart + '@@Atlas'.length, grant_intent: true
      }]
    }
    const item: MessageItem = {
      kind: 'message', id: 'team-turn', key: 'team-turn', seq: 15,
      event, events: [event], role: 'user', files: []
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByLabelText('@@Pat · Person')).toHaveClass(
      'timeline-inline-chat-reference', 'action-team', 'team'
    )
    expect(screen.getByLabelText('@@Atlas · Server inbox')).toHaveClass(
      'timeline-inline-chat-reference', 'action-team', 'team'
    )
  })

  it('does not turn raw or span-mismatched @ text into a timeline route', () => {
    const rawEvent: Event = {
      id: 'raw-at-turn', session_id: 'chat-1', seq: 15, type: 'turn_started',
      ts: '2026-08-27T14:32:00Z', prompt: 'Ask @Training, but this is ordinary text.'
    }
    const mismatchedEvent: Event = {
      id: 'bad-at-turn', session_id: 'chat-1', seq: 16, type: 'turn_started',
      ts: '2026-08-27T14:33:00Z', prompt: 'Ask @Training, but the stored span is wrong.',
      chat_references: [{
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: 5, source_text_end: 14, action: 'route'
      }]
    }
    const makeItem = (event: Event): MessageItem => ({
      kind: 'message', id: event.id, key: event.id, seq: event.seq,
      event, events: [event], role: 'user', files: []
    })

    const { rerender } = render(
      <TimelineRowView item={makeItem(rawEvent)} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    expect(screen.queryByRole('link', { name: /Route hint for/ })).not.toBeInTheDocument()

    rerender(
      <TimelineRowView item={makeItem(mismatchedEvent)} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    expect(screen.queryByRole('link', { name: /Route hint for/ })).not.toBeInTheDocument()
  })

  it('keeps a secure-peer @ route inline without a duplicate remote pill', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession, sessions: [] })
    const event: Event = {
      id: 'remote-turn-start', session_id: 'chat-1', seq: 13, type: 'turn_started',
      ts: '2026-08-21T14:31:00Z', prompt: 'Ask @Studio reviewer to verify this.',
      chat_references: [{
        session_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
        display_title_snapshot: 'Studio reviewer',
        source_text_start: 4, source_text_end: 20, action: 'instruction',
        target_kind: 'secure_peer',
        target_server_identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        target_connection_id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
        target_route_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
        target_route_revision: 'rev_0123456789abcdef0123456789abcdef'
      }]
    }
    const item: MessageItem = {
      kind: 'message', id: 'remote-turn', key: 'remote-turn', seq: 13,
      event, events: [event], role: 'user', files: []
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByTitle('@Studio reviewer · Secure route on paired server')).toHaveClass(
      'timeline-inline-chat-reference', 'remote'
    )
    expect(screen.queryByLabelText('Referenced chats')).not.toBeInTheDocument()
    expect(selectSession).not.toHaveBeenCalled()
  })

  it('preserves a historical secure-peer reply request as a read-only timeline pill', () => {
    const event: Event = {
      id: 'remote-reply-turn-start', session_id: 'chat-1', seq: 14, type: 'turn_started',
      ts: '2026-08-21T14:32:00Z', prompt: 'Ask @Studio to verify this.',
      chat_references: [{
        session_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
        display_title_snapshot: 'Studio reviewer',
        source_text_start: 4, source_text_end: 11, action: 'request_reply',
        target_kind: 'secure_peer',
        target_server_identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        target_connection_id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
        target_route_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
        target_route_revision: 'rev_0123456789abcdef0123456789abcdef'
      }]
    }
    const item: MessageItem = {
      kind: 'message', id: 'remote-reply-turn', key: 'remote-reply-turn', seq: 14,
      event, events: [event], role: 'user', files: []
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByRole('button', {
      name: 'Reply expected from Studio reviewer · secure paired server'
    })).toBeDisabled()
  })

  it.each(['codex', 'claude'] as const)('renders an imported %s reply as an incoming bubble without transport wrappers or actionable routes', backend => {
    const prompt = '[AgentsDock delivery kind=reply leg=2/2 origin=route from=DEMO-A Submitter]\n'
      + '[Source user instruction — verbatim, user-authored]\nInspect the results.\n[End source user instruction]\n'
      + '[Agent-prepared reply/result]\nThe inspection is ready.\n[End agent-prepared reply/result]\n'
      + 'reply: use the respond command in the provider-authority block only if a reply or follow-up is needed.\n[End delivery]'
    const rows = renderTimelineItems(projectTimeline([{
      id: 'imported-reply-1', session_id: 'chat-1', seq: 12, type: 'turn_started',
      ts: '2026-07-10T14:31:00Z', backend, imported: true, run_id: 'import_shared', prompt
    }], []))
    const view = render(<>{rows.map(item => <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)}</>)

    expect(screen.queryByText('Agent conversation')).not.toBeInTheDocument()
    expect(screen.getByText('DEMO-A Submitter')).toBeVisible()
    expect(screen.getByText('The inspection is ready.')).toBeVisible()
    expect(view.container.querySelectorAll('.cross-chat-message')).toHaveLength(1)
    expect(view.container.querySelector('.cross-chat-message')).toHaveClass('incoming')
    expect(view.container.querySelector('.exchange-conversation')).toBeNull()
    expect(view.container.querySelector('.message-row.user')).toBeNull()
    expect(screen.queryByText('You')).not.toBeInTheDocument()
    expect(view.container.textContent).not.toContain('AgentsDock delivery')
    expect(view.container.textContent).not.toContain('provider-authority')
    expect(view.container.textContent).not.toContain('Agent-prepared')
    expect(screen.queryByRole('button', { name: /Cancel|Open CMA|Reply/ })).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()
    expect(loadHandoff).not.toHaveBeenCalled()
    expect(listQueue).not.toHaveBeenCalled()
    expect(screen.queryByText('Source request')).not.toBeInTheDocument()
    expect(screen.queryByText('Inspect the results.')).not.toBeInTheDocument()
  })

  it.each([false, true])('preserves an explicitly user-authored same-wrapper message (imported=%s) beside an unproven delivery', imported => {
    const prompt = '[AgentsDock delivery kind=reply leg=2/2 origin=route from=Reviewer]\n'
      + '[Source user instruction — verbatim, user-authored]\nReview the output.\n[End source user instruction]\n'
      + '[Agent-prepared reply/result]\nThe same public reply.\n[End agent-prepared reply/result]\n[End delivery]'
    const events: Event[] = [
      { id: 'unproven-import', session_id: 'chat-1', seq: 12, type: 'turn_started',
        ts: '2026-09-10T21:13:30Z', backend: 'claude', imported: true, run_id: 'import_unproven', prompt },
      { id: 'human-quotation', session_id: 'chat-1', seq: 13, type: 'turn_started',
        ts: '2026-09-10T21:14:30Z', backend: 'claude', imported, provider_user_authored: true,
        run_id: imported ? 'import_human_quote' : 'human-quote', prompt }
    ]
    const rows = renderTimelineItems(projectTimeline(events, []))
    const view = render(<>{rows.map(item => <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)}</>)
    expect(view.container.querySelectorAll('.cross-chat-message')).toHaveLength(1)
    expect(view.container.querySelector('.cross-chat-message')).toHaveClass('incoming')
    expect(view.container.querySelector('.cross-chat-message')).toHaveTextContent('The same public reply.')
    expect(view.container.querySelectorAll('.message-row.user')).toHaveLength(1)
    expect(view.container.querySelector('.message-row.user')).toHaveTextContent('The same public reply.')
    expect(view.container.querySelector('.message-row.user')).toHaveTextContent('AgentsDock delivery')
    expect(loadExchange).not.toHaveBeenCalled()
    expect(cancelExchange).not.toHaveBeenCalled()
  })

  it.each([
    ['created', 'Created'], ['updated', 'Updated'], ['deleted', 'Removed']
  ])('renders the %s route receipt with the exact chat name instead of its protocol alias', (action, verb) => {
    const targetTitle = 'Robot *Lab* [notes]'
    useAppStore.setState({ sessions: [{ id: 'chat-2', title: targetTitle, backend: 'claude' }] })
    const event: Event & { route_id: string; alias: string } = {
      id: `route-${action}`, session_id: 'chat-1', seq: 12,
      type: `agent_handoff_route_${action}`, ts: '2026-07-10T14:31:00Z',
      target_session_id: 'chat-2', target_title: 'Saved target title',
      route_id: 'route-protocol-id', alias: 'chat1',
      message: `${verb} approved agent handoff route @chat1.`
    }
    const original = structuredClone(event)
    const item = renderTimelineItems(projectTimeline([event], []))[0]
    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByText(`${verb} approved chat route to ${targetTitle}.`)).toBeInTheDocument()
    expect(view.container.textContent).not.toContain('@chat1')
    expect(view.container.querySelector('em, a')).toBeNull()
    act(() => useAppStore.setState({ sessions: [{ id: 'chat-2', title: 'Renamed target', backend: 'claude' }] }))
    expect(screen.getByText(`${verb} approved chat route to Renamed target.`)).toBeInTheDocument()
    expect(event).toEqual(original)
    expect(loadHandoff).not.toHaveBeenCalled()
    expect(loadExchange).not.toHaveBeenCalled()
    expect(listQueue).not.toHaveBeenCalled()
  })

  it('uses a saved route target name or a neutral fallback without leaking the alias across locales or workspaces', () => {
    useAppStore.setState({ sessions: [{ id: 'chat-2', title: 'Wrong workspace name', backend: 'claude' }], profileGeneration: 1 })
    const event: Event = {
      id: 'route-created', session_id: 'chat-1', seq: 12,
      type: 'agent_handoff_route_created', ts: '2026-07-10T14:31:00Z',
      target_session_id: 'chat-2', target_title: 'Saved target',
      message: 'Created approved agent handoff route @chat1.'
    }
    const item: SystemItem = { kind: 'system', id: event.id, key: event.id, seq: event.seq, event }
    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByText('Created approved chat route to Saved target.')).toBeInTheDocument()
    act(() => setLocale('zh-CN'))
    expect(screen.getByText('已创建通往 Saved target 的授权会话访问。')).toBeInTheDocument()
    view.rerender(<TimelineRowView item={{ ...item, event: { ...event, target_title: null } }} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByText('已创建通往 其他会话 的授权会话访问。')).toBeInTheDocument()
    expect(view.container.textContent).not.toContain('@chat1')
    expect(view.container.textContent).not.toContain('Wrong workspace name')
  })

  it('renders the current target name and preserves exact handoff cancellation', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      selectSession,
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null },
      sessions: [{ id: 'chat-2', title: 'Current target title', backend: 'claude' }]
    })
    const event: Event = {
      id: 'handoff-queued', session_id: 'chat-1', seq: 12,
      type: 'cross_chat_handoff_queued', ts: '2026-07-10T14:31:00Z',
      handoff_id: 'handoff-1', handoff_status: 'queued',
      source_session_id: 'chat-1', target_session_id: 'chat-2', target_title: 'Old title',
      handoff_authorization_kind: 'explicit_prompt'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-1',
      key: 'cross-chat:handoff:handoff-1', seq: 4, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(screen.getByText('Queued in Current target title')).toBeInTheDocument()
    expect(screen.queryByText('User-addressed')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Current target title' })).not.toBeInTheDocument()
    expect(selectSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel handoff' }))
    await waitFor(() => expect(cancelHandoff).toHaveBeenCalledWith('handoff-1'))
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('uses source-aware labels for an incoming final-result handoff', () => {
    useAppStore.setState({
      selectedSessionId: 'chat-2',
      chatPanes: { primary: 'chat-2', secondary: null },
      sessions: [
        { id: 'chat-2', title: 'Target', backend: 'claude' },
        { id: 'chat-1', title: 'Research', backend: 'codex' }
      ]
    })
    const event: Event = {
      id: 'cross-chat-result', session_id: 'chat-2', seq: 5,
      type: 'cross_chat_handoff_started', ts: '2026-07-10T14:32:00Z',
      handoff_id: 'handoff-result', handoff_status: 'running', handoff_action: 'final_result',
      source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-result',
      key: 'cross-chat:handoff:handoff-result', seq: 5, event
    }
    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Working on result from Research')).toBeInTheDocument()
  })

  it('keeps configured-route authority labels and identifiers out of the message bubble', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-2', title: 'AgentsDock Mobile', backend: 'codex' }]
    })
    const routeId = `route_${'a'.repeat(32)}`
    const event: Event = {
      id: 'handoff-agent-route', session_id: 'chat-1', seq: 13,
      type: 'cross_chat_handoff_queued', ts: '2026-08-18T14:31:00Z',
      handoff_id: 'handoff-route', handoff_status: 'queued',
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_authorization_kind: 'configured_route', handoff_authorization_route_id: routeId
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-route',
      key: 'cross-chat:handoff:handoff-route', seq: 13, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.queryByText('Agent-authored same-server access')).not.toBeInTheDocument()
    expect(screen.queryByText(routeId)).not.toBeInTheDocument()
  })

  it('loads the full handoff body only when a truncated message is expanded', async () => {
    loadHandoff.mockResolvedValue({
      id: 'handoff-long', kind: 'instruction', action: 'instruction',
      source_session_id: 'chat-1', source_run_id: 'run-1', target_session_id: 'chat-2',
      status: 'queued', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
      body: 'Complete instruction body', body_chars: 25, body_sha256: 'hash'
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Target', backend: 'claude' }
      ],
      selectedSessionId: 'chat-2',
      chatPanes: { primary: 'chat-2', secondary: null }
    })
    const event: Event = {
      id: 'cross-chat-long', session_id: 'chat-2', seq: 6,
      type: 'cross_chat_handoff_queued', ts: '2026-08-10T00:00:01Z',
      handoff_id: 'handoff-long', handoff_status: 'queued', handoff_action: 'instruction',
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_preview: 'Complete instruction…', handoff_body_chars: 25,
      handoff_body_sha256: 'hash', handoff_body_truncated: true
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-long',
      key: 'cross-chat:handoff:handoff-long', seq: 6, event
    }
    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(loadHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    await waitFor(() => expect(loadHandoff).toHaveBeenCalledWith('handoff-long'))
    expect(await screen.findByText('Complete instruction body')).toBeInTheDocument()
  })

  it.each([
    ['server instance', { health: { ok: true, server_instance_id: 'instance-b' } }],
    ['connection state', { connected: false }],
    ['connection generation', { connectionGeneration: 4 }]
  ])('discards legacy handoff detail when the %s changes in flight', async (_boundary, boundaryPatch) => {
    let resolveHandoff!: (value: {
      id: string; kind: 'instruction'; action: 'instruction'; source_session_id: string; source_run_id: string;
      target_session_id: string; status: string; created_at: string; updated_at: string;
      body: string; body_chars: number; body_sha256: string
    }) => void
    loadHandoff.mockImplementation(() => new Promise(resolve => { resolveHandoff = resolve }))
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4,
      profiles: [profileFixture('profile-a', 'server-a')],
      selectedSessionId: 'chat-2', chatPanes: { primary: 'chat-2', secondary: null },
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const event: Event = {
      id: 'cross-chat-stale', session_id: 'chat-2', seq: 7,
      type: 'cross_chat_handoff_queued', ts: '2026-08-10T00:00:01Z',
      handoff_id: 'handoff-stale', handoff_status: 'queued', handoff_action: 'instruction',
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_preview: 'Preview…', handoff_body_chars: 24, handoff_body_truncated: true
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-stale',
      key: 'cross-chat:handoff:handoff-stale', seq: 7, event
    }
    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(loadHandoff).toHaveBeenCalledWith('handoff-stale'))

    act(() => useAppStore.setState(boundaryPatch))
    expect(screen.queryByText('Loading full message…')).not.toBeInTheDocument()
    await act(async () => resolveHandoff({
      id: 'handoff-stale', kind: 'instruction', action: 'instruction',
      source_session_id: 'chat-1', source_run_id: 'run-1', target_session_id: 'chat-2',
      status: 'queued', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
      body: 'Old server private body', body_chars: 24, body_sha256: 'hash'
    }))

    expect(screen.queryByText('Old server private body')).not.toBeInTheDocument()
  })

  it('rejects legacy handoff detail for a foreign chat participant', async () => {
    loadHandoff.mockResolvedValue({
      id: 'handoff-foreign', kind: 'instruction', action: 'instruction',
      source_session_id: 'foreign-a', source_run_id: 'run-foreign', target_session_id: 'foreign-b',
      status: 'queued', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
      body: 'Foreign private body', body_chars: 20, body_sha256: 'hash'
    })
    useAppStore.setState({
      selectedSessionId: 'chat-2', chatPanes: { primary: 'chat-2', secondary: null },
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const event: Event = {
      id: 'cross-chat-foreign', session_id: 'chat-2', seq: 8,
      type: 'cross_chat_handoff_queued', ts: '2026-08-10T00:00:01Z',
      handoff_id: 'handoff-foreign', handoff_status: 'queued', handoff_action: 'instruction',
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_preview: 'Preview…', handoff_body_chars: 20, handoff_body_truncated: true
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat:handoff:handoff-foreign',
      key: 'cross-chat:handoff:handoff-foreign', seq: 8, event
    }
    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('not a participant in the handoff')
    expect(screen.queryByText('Foreign private body')).not.toBeInTheDocument()
  })

  it('does not apply a delayed legacy cancellation to a newer handoff card', async () => {
    let resolveCancel!: (value: {
      id: string; kind: 'instruction'; action: 'instruction'; source_session_id: string; source_run_id: string;
      target_session_id: string; status: string; created_at: string; updated_at: string
    }) => void
    cancelHandoff.mockImplementation(() => new Promise(resolve => { resolveCancel = resolve }))
    useAppStore.setState({
      selectedSessionId: 'chat-1', chatPanes: { primary: 'chat-1', secondary: null },
      sessions: [{ id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const handoffEvent = (id: string, seq: number): Event => ({
      id: `event-${id}`, session_id: 'chat-1', seq, type: 'cross_chat_handoff_queued',
      ts: '2026-08-10T00:00:01Z', handoff_id: id, handoff_status: 'queued',
      source_session_id: 'chat-1', target_session_id: 'chat-2'
    })
    const firstEvent = handoffEvent('handoff-old', 9)
    const { rerender } = render(<TimelineRowView item={{
      kind: 'system', id: 'cross-chat:handoff:handoff-old', key: 'cross-chat:handoff:handoff-old', seq: 9, event: firstEvent
    }} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel handoff' }))
    await waitFor(() => expect(cancelHandoff).toHaveBeenCalledWith('handoff-old'))

    const nextEvent = handoffEvent('handoff-new', 10)
    rerender(<TimelineRowView item={{
      kind: 'system', id: 'cross-chat:handoff:handoff-new', key: 'cross-chat:handoff:handoff-new', seq: 10, event: nextEvent
    }} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    await act(async () => resolveCancel({
      id: 'handoff-old', kind: 'instruction', action: 'instruction',
      source_session_id: 'chat-1', source_run_id: 'run-old', target_session_id: 'chat-2', status: 'cancelled',
      created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:02Z'
    }))

    expect(screen.getByText('Queued in Target')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel handoff' })).toBeEnabled()
    expect(screen.queryByText('Handoff to Target cancelled')).not.toBeInTheDocument()
  })

  it('renders a v2 request as a bubble and lazily loads its exact message', async () => {
    const exchange = exchangeFixture()
    loadExchange.mockResolvedValue(exchange)
    cancelExchange.mockResolvedValue({ ...exchange, status: 'cancelled' })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const routeId = `route_${'b'.repeat(32)}`
    const event: Event = {
      id: 'exchange-leg-running', session_id: 'chat-1', seq: 20,
      type: 'cross_chat_exchange_leg_started', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5, exchange_expires_at: '2026-08-13T00:00:00Z',
      source_session_id: 'chat-1', target_session_id: 'chat-2', handoff_preview: '😀'.repeat(16),
      handoff_body_chars: 28, handoff_body_truncated: true,
      exchange_authorization_kind: 'configured_route', exchange_authorization_route_id: routeId
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:leg-1',
      key: 'cross-chat-exchange:exchange-1:leg-1', seq: 20, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText(/^(?:To )?Training$/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Reply pending · Recipient processing')
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Tracks message delivery and replies, not this chat’s run status.')
    expect(screen.queryByText('Agent-authored same-server access')).not.toBeInTheDocument()
    expect(document.querySelector('.exchange-conversation')).not.toBeInTheDocument()
    expect(screen.queryByText(routeId)).not.toBeInTheDocument()
    expect(screen.queryByText('Reply expected')).not.toBeInTheDocument()
    expect(screen.queryByText(/Round 1|Message 1/)).not.toBeInTheDocument()
    expect(document.querySelector('.cross-chat-leg-meta')).not.toBeInTheDocument()
    expect(document.querySelector('.exchange-conversation .cross-chat-exchange-meta')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/^Expires /)).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()

    expect(screen.queryByText(/View full conversation/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    await waitFor(() => expect(loadExchange).toHaveBeenCalledWith('exchange-1'))
    expect(await screen.findByText('Inspect the renderer carefully.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'End conversation' }))
    await waitFor(() => expect(cancelExchange).toHaveBeenCalledWith('exchange-1'))
  })

  it('retries only the read when an individual message cannot be loaded', async () => {
    loadExchange
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce(exchangeFixture())
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }]
    })
    const event: Event = {
      id: 'exchange-load-retry', session_id: 'chat-1', seq: 20,
      type: 'cross_chat_exchange_leg_started', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_preview: 'Short preview', handoff_body_truncated: true
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: event.seq, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    expect(await screen.findByText('Inspect the renderer carefully.')).toBeInTheDocument()
    expect(loadExchange).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('lets each long inline message collapse and expand without creating a duplicate transcript', async () => {
    const longBody = `Full message start. ${'Detailed context. '.repeat(48)}Full message end.`
    const exchange = exchangeFixture()
    loadExchange.mockResolvedValue({
      ...exchange,
      legs: [{ ...exchange.legs[0], body: longBody, body_chars: longBody.length }]
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const event: Event = {
      id: 'exchange-long-message', session_id: 'chat-1', seq: 20,
      type: 'cross_chat_exchange_leg_started', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      handoff_preview: 'Full message start…', handoff_body_chars: longBody.length
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:leg-1',
      key: 'cross-chat-exchange:exchange-1:leg-1', seq: event.seq, event
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages') as HTMLElement
    fireEvent.click(within(boundary).getByRole('button', { name: 'View message' }))

    await waitFor(() => expect(loadExchange).toHaveBeenCalledWith('exchange-1'))
    expect(await within(boundary).findByText(longBody)).toBeInTheDocument()
    expect(boundary.querySelectorAll('.cross-chat-message')).toHaveLength(1)
    expect(view.container.querySelector('.exchange-conversation')).not.toBeInTheDocument()

    fireEvent.click(within(boundary).getByRole('button', { name: 'Show less' }))
    expect(within(boundary).queryByText(longBody)).not.toBeInTheDocument()
    const showMore = within(boundary).getByRole('button', { name: 'View message' })
    expect(showMore).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(showMore)
    expect(within(boundary).getByText(longBody)).toBeInTheDocument()
    expect(loadExchange).toHaveBeenCalledTimes(1)
  })

  it('keeps the first outgoing queued message in its own bubble', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const event: Event = {
      id: 'exchange-outgoing-queued', session_id: 'chat-1', seq: 20,
      type: 'cross_chat_exchange_leg_queued', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'queued', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      handoff_preview: 'Check the latest training checkpoint.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event, events: [event]
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(document.querySelector('.cross-chat-message')).toHaveClass('outgoing')
    expect(screen.queryByText('Agent conversation')).not.toBeInTheDocument()
    expect(screen.getByText('Check the latest training checkpoint.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Reply pending · Queued')
    expect(screen.queryByText('Queued message removed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
  })

  it('renders an exact queued incoming leg as a source-side message and cancels only that delivery', async () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 9, actions: ['request_reply', 'instruction'],
            features: { exact_queued_delivery_skip: true },
            supported_target_backends: ['codex', 'claude']
          }
        }
      }
    })
    const event: Event = {
      id: 'exchange-leg-queued', session_id: 'chat-2', seq: 20,
      type: 'cross_chat_exchange_leg_queued', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'queued', exchange_leg_kind: 'request', exchange_direction: 'incoming',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2', queued_id: 'queued-delivery-1',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      handoff_preview: 'Check the latest training checkpoint.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event, events: [event]
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent conversation')).not.toBeInTheDocument()
    expect(screen.getByText('Source')).toBeVisible()
    expect(document.querySelector('.cross-chat-message')).toHaveClass('incoming')
    expect(screen.getAllByText('Source')).not.toHaveLength(0)
    expect(screen.getByText('Check the latest training checkpoint.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Queued')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))

    await waitFor(() => expect(skipCrossChatDelivery).toHaveBeenCalledWith('chat-2', 'queued-delivery-1', {
      cross_chat_exchange_id: 'exchange-1',
      cross_chat_exchange_leg_id: 'leg-1'
    }))
    expect(cancelExchange).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('Queued message removed')
    expect(listQueue).toHaveBeenCalledWith('chat-2')
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument()
  })

  it('shows a promoted delivery as starting when cancellation loses the queue race', async () => {
    skipCrossChatDelivery.mockRejectedValue(new Error('409 queued turn is already running'))
    listQueue.mockResolvedValue([])
    cancelExchange.mockRejectedValue(new Error('exchange cancellation unavailable'))
    loadExchange.mockRejectedValue(new Error('exchange refresh unavailable'))
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 9, actions: ['request_reply', 'instruction'],
            features: { exact_queued_delivery_skip: true },
            supported_target_backends: ['codex', 'claude']
          }
        }
      }
    })
    const event: Event = {
      id: 'exchange-leg-promoted', session_id: 'chat-2', seq: 20,
      type: 'cross_chat_exchange_leg_queued', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'queued', exchange_leg_kind: 'request', exchange_direction: 'incoming',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2', queued_id: 'queued-delivery-1',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      handoff_preview: 'Check the latest training checkpoint.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event, events: [event]
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))

    await waitFor(() => expect(listQueue).toHaveBeenCalledWith('chat-2'))
    expect(await screen.findByRole('status')).toHaveTextContent('Starting')
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
    expect(cancelExchange).toHaveBeenCalledWith('exchange-1')
    expect(loadExchange).toHaveBeenCalledWith('exchange-1')
  })

  it('renders completed truth when completion wins the promoted-delivery cancellation race', async () => {
    skipCrossChatDelivery.mockRejectedValue(new Error('409 queued turn is already running'))
    listQueue.mockResolvedValue([])
    cancelExchange.mockResolvedValue({
      ...exchangeFixture(),
      status: 'completed',
      active_leg_id: null,
      updated_at: '2026-08-10T00:00:02Z'
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 9, actions: ['request_reply', 'instruction'],
            features: { exact_queued_delivery_skip: true },
            supported_target_backends: ['codex', 'claude']
          }
        }
      }
    })
    const event: Event = {
      id: 'exchange-leg-completion-race', session_id: 'chat-2', seq: 20,
      type: 'cross_chat_exchange_leg_queued', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'queued', exchange_leg_kind: 'request', exchange_direction: 'incoming',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2', queued_id: 'queued-delivery-1',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      handoff_preview: 'Check the latest training checkpoint.'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event, events: [event]
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))

    await waitFor(() => expect(cancelExchange).toHaveBeenCalledWith('exchange-1'))
    expect(await screen.findByRole('status')).toHaveTextContent('Completed')
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument()
    expect(screen.queryByText('Starting')).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()
  })

  it('keeps exchange cancellation available when an older server cannot skip an exact queued leg', async () => {
    const exchange = exchangeFixture()
    cancelExchange.mockResolvedValue({ ...exchange, status: 'cancelled' })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 8, actions: ['request_reply', 'instruction'],
            features: {},
            supported_target_backends: ['codex', 'claude']
          }
        }
      }
    })
    const event: Event = {
      id: 'exchange-leg-queued-v8', session_id: 'chat-2', seq: 20,
      type: 'cross_chat_exchange_leg_queued', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'queued', exchange_leg_kind: 'request', exchange_direction: 'incoming',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      source_session_id: 'chat-1', target_session_id: 'chat-2', queued_id: 'queued-delivery-1',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event, events: [event]
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.queryByText('Agent conversation')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Queued')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }))

    await waitFor(() => expect(cancelExchange).toHaveBeenCalledWith('exchange-1'))
    expect(skipCrossChatDelivery).not.toHaveBeenCalled()
  })

  it('retains earlier conversation legs when a reply is queued, with Cancel on that reply', () => {
    useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')], sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }
      ] })
    const first: Event = { id: 'request-delivered', session_id: 'chat-1', seq: 10,
      type: 'cross_chat_exchange_leg_delivered', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'delivered', exchange_leg_kind: 'request', exchange_direction: 'outgoing', exchange_ordinal: 1,
      source_session_id: 'chat-1', target_session_id: 'chat-2', requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      handoff_preview: 'The original question remains visible.' }
    const reply: Event = { ...first, id: 'reply-queued', seq: 20, type: 'cross_chat_exchange_leg_queued',
      exchange_leg_id: 'leg-2', exchange_leg_status: 'queued', exchange_leg_kind: 'reply', exchange_direction: 'incoming',
      exchange_ordinal: 2, exchange_used_legs: 2, source_session_id: 'chat-2', target_session_id: 'chat-1',
      queued_id: 'queued-reply', handoff_preview: 'This later reply is waiting in the inbox.' }
    const item: SystemItem = { kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 20, event: reply, events: [first, reply] }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(container.querySelector('.exchange-conversation')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.cross-chat-message')).toHaveLength(2)
    expect(screen.getByText(first.handoff_preview!)).toBeVisible()
    expect(screen.getByText(reply.handoff_preview!)).toBeVisible()
    expect(container.querySelector('[data-exchange-leg-id="leg-1"]')).toHaveClass('outgoing')
    const queued = container.querySelector('[data-exchange-leg-id="leg-2"]') as HTMLElement
    expect(queued).toHaveClass('incoming')
    expect(within(queued).getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Show full conversation' })).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()
  })

  it('renders each exchange leg once with direction relative to the displayed chat', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const events: Event[] = [
      {
        id: 'exchange-summary', session_id: 'chat-1', seq: 10,
        type: 'cross_chat_exchange_registered', ts: '2026-08-10T00:00:00Z',
        exchange_id: 'exchange-1', exchange_status: 'active', exchange_initial_action: 'request_reply',
        exchange_max_legs: 6, exchange_used_legs: 1, exchange_remaining_legs: 5,
        exchange_expires_at: '2026-08-13T00:00:00Z', requester_session_id: 'chat-1',
        responder_session_id: 'chat-2', requester_title: 'Source', responder_title: 'Training'
      },
      {
        id: 'exchange-request', session_id: 'chat-1', seq: 11,
        type: 'cross_chat_exchange_leg_delivered', ts: '2026-08-10T00:00:01Z',
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
        exchange_leg_status: 'delivered', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
        exchange_expects_reply: true, exchange_ordinal: 1, source_session_id: 'chat-1',
        target_session_id: 'chat-2', handoff_preview: 'Can you verify the updater state?'
      },
      {
        id: 'exchange-reply', session_id: 'chat-1', seq: 12,
        type: 'cross_chat_exchange_leg_delivered', ts: '2026-08-10T00:00:02Z',
        exchange_id: 'exchange-1', exchange_leg_id: 'leg-2', exchange_status: 'completed',
        exchange_leg_status: 'delivered', exchange_leg_kind: 'reply', exchange_direction: 'incoming',
        exchange_expects_reply: false, exchange_ordinal: 2, exchange_used_legs: 2,
        exchange_remaining_legs: 4, source_session_id: 'chat-2', target_session_id: 'chat-1',
        handoff_preview: 'Verified: the updater is idle.'
      }
    ]
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 10, event: events[2], events
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages')
    expect(boundary).toBeInTheDocument()
    expect(boundary).toHaveAttribute('data-exchange-id', 'exchange-1')
    expect(view.container.querySelector('.exchange-conversation')).not.toBeInTheDocument()
    expect(boundary?.querySelector('.cross-chat-participants')).not.toBeInTheDocument()
    expect(within(boundary as HTMLElement).getByRole('status')).toHaveTextContent('Completed')

    const legs = boundary?.querySelectorAll('.cross-chat-message') ?? []
    expect(legs).toHaveLength(2)
    expect(legs[0]).toHaveClass('outgoing')
    expect(within(legs[0] as HTMLElement).getByRole('button', { name: 'To Training' })).toBeVisible()
    expect(legs[0]).toHaveTextContent('Can you verify the updater state?')
    expect(legs[1]).toHaveClass('incoming')
    expect(within(legs[1] as HTMLElement).getByRole('button', { name: 'Training' })).toBeVisible()
    expect(legs[1]).toHaveTextContent('Verified: the updater is idle.')
    expect(boundary?.querySelector('.cross-chat-leg-meta')).not.toBeInTheDocument()
    expect(boundary?.querySelector('.cross-chat-exchange-footer')).not.toBeInTheDocument()

    view.rerender(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const responderViewLegs = view.container.querySelectorAll('.cross-chat-message')
    expect(responderViewLegs[0]).toHaveClass('incoming')
    expect(responderViewLegs[1]).toHaveClass('outgoing')
  })

  it('keeps every completed exchange leg visible and expands only a requested message', async () => {
    loadExchange.mockResolvedValue(multiTurnExchangeFixture())
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const events = multiTurnLifecycleEvents('completed')
    events.find(event => event.exchange_leg_id === 'multi-leg-2')!.handoff_body_truncated = true
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-multi', key: 'cross-chat-exchange:exchange-multi',
      seq: events.at(-1)!.seq, event: events.at(-1)!, events
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages') as HTMLElement
    const visibleLegs = () => [...boundary.querySelectorAll<HTMLElement>('.cross-chat-message')]

    expect(visibleLegs().map(leg => leg.dataset.exchangeLegId)).toEqual(['multi-leg-1', 'multi-leg-2', 'multi-leg-3', 'multi-leg-4'])
    expect(within(boundary).getByText('Opening question preview')).toBeInTheDocument()
    expect(within(boundary).getByText('Final answer preview')).toBeInTheDocument()
    expect(within(boundary).getByText('First follow-up preview')).toBeInTheDocument()
    expect(within(boundary).queryByText(/Round \d|Message \d/)).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()

    expect(screen.queryByRole('button', { name: /Show .*earlier messages|Show full conversation/ })).not.toBeInTheDocument()
    const followup = boundary.querySelector('[data-exchange-leg-id="multi-leg-2"]') as HTMLElement
    fireEvent.click(within(followup).getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(loadExchange).toHaveBeenCalledWith('exchange-multi'))
    expect(await within(boundary).findByText('Complete first follow-up body.')).toBeInTheDocument()
    expect(visibleLegs()).toHaveLength(4)
    expect(within(boundary).queryByText(/View full conversation/)).not.toBeInTheDocument()

    expect(visibleLegs().map(leg => leg.dataset.exchangeLegId)).toEqual(['multi-leg-1', 'multi-leg-2', 'multi-leg-3', 'multi-leg-4'])
    expect(view.container.querySelector('.exchange-conversation')).not.toBeInTheDocument()
  })

  it('scopes active conversation controls to the newest message bubble', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const events = multiTurnLifecycleEvents('active')
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-multi', key: 'cross-chat-exchange:exchange-multi',
      seq: events.at(-1)!.seq, event: events.at(-1)!, events
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages') as HTMLElement
    const visibleLegs = boundary.querySelectorAll<HTMLElement>('.cross-chat-message')

    expect(visibleLegs).toHaveLength(4)
    expect(visibleLegs[3]).toHaveAttribute('data-exchange-leg-id', 'multi-leg-4')
    expect(visibleLegs[3]).toHaveTextContent('Final answer preview')
    expect(within(visibleLegs[3]).getByRole('button', { name: 'End conversation' })).toBeEnabled()
    for (const prior of [...visibleLegs].slice(0, 3)) expect(within(prior).queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
    expect(within(boundary).getByRole('status')).toHaveTextContent('Reply pending · Recipient processing')
  })

  it('shows terminal exchange failure without expiry metadata in the conversation UI', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }]
    })
    const events: Event[] = [
      {
        id: 'failed-request', session_id: 'chat-1', seq: 20,
        type: 'cross_chat_exchange_leg_failed', ts: '2026-08-10T00:00:01Z',
        exchange_id: 'exchange-failed', exchange_leg_id: 'leg-failed', exchange_status: 'failed',
        exchange_leg_status: 'failed', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
        exchange_ordinal: 1, exchange_max_legs: 6, exchange_used_legs: 1, exchange_remaining_legs: 5,
        exchange_expires_at: '2026-08-13T00:00:00Z', exchange_error_code: 'recipient_failed',
        source_session_id: 'chat-1', target_session_id: 'chat-2', source_title: 'Source', target_title: 'Training',
        handoff_preview: 'Please inspect this state.', message: 'Training could not start the requested work.'
      },
      {
        id: 'failed-summary', session_id: 'chat-1', seq: 21,
        type: 'cross_chat_exchange_failed', ts: '2026-08-10T00:00:02Z',
        exchange_id: 'exchange-failed', exchange_status: 'failed', exchange_error_code: 'recipient_failed',
        requester_session_id: 'chat-1', responder_session_id: 'chat-2', requester_title: 'Source',
        responder_title: 'Training', exchange_expires_at: '2026-08-13T00:00:00Z',
        message: 'Training could not start the requested work.'
      }
    ]
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-failed', key: 'cross-chat-exchange:exchange-failed',
      seq: 20, event: events[1], events
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages') as HTMLElement
    expect(boundary.querySelector('.cross-chat-message')).toHaveClass('failed')
    expect(within(boundary).getByText(/^(?:To )?Training$/)).toBeInTheDocument()
    expect(within(boundary).getByRole('status')).toHaveTextContent("Couldn't complete")
    expect(within(boundary).getByRole('alert')).toHaveTextContent('Training could not start the requested work.')
    expect(within(boundary).queryByText(/Expires/)).not.toBeInTheDocument()
    expect(boundary.querySelector('.cross-chat-exchange-footer')).not.toBeInTheDocument()
  })

  it('renders a recovered cancellation as one intelligible terminal status, not a failure', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }]
    })
    const recoveryMessage = 'Recovered terminal exchange leg state: cancelled.'
    const events: Event[] = [
      {
        id: 'cancelled-leg', session_id: 'chat-1', seq: 20,
        type: 'cross_chat_exchange_leg_cancelled', ts: '2026-08-10T00:00:01Z',
        exchange_id: 'exchange-cancelled', exchange_leg_id: 'leg-cancelled', exchange_status: 'cancelled',
        exchange_leg_status: 'cancelled', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
        exchange_ordinal: 1, exchange_max_legs: 6, exchange_used_legs: 1, exchange_remaining_legs: 5,
        exchange_error_code: 'cancelled_by_user', source_session_id: 'chat-1', target_session_id: 'chat-2',
        source_title: 'Source', target_title: 'Training', handoff_preview: 'Please check the renderer.',
        message: recoveryMessage
      },
      {
        id: 'cancelled-summary', session_id: 'chat-1', seq: 21,
        type: 'cross_chat_exchange_cancelled', ts: '2026-08-10T00:00:02Z',
        exchange_id: 'exchange-cancelled', exchange_status: 'cancelled', exchange_error_code: 'cancelled_by_user',
        requester_session_id: 'chat-1', responder_session_id: 'chat-2', requester_title: 'Source',
        responder_title: 'Training', message: recoveryMessage
      }
    ]
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-cancelled', key: 'cross-chat-exchange:exchange-cancelled',
      seq: 21, event: events[1], events
    }

    const view = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const boundary = view.container.querySelector('.cross-chat-legacy-messages') as HTMLElement
    expect(boundary.querySelector('.cross-chat-message')).not.toHaveClass('failed')
    expect(within(boundary).getByText(/^(?:To )?Training$/)).toBeInTheDocument()
    expect(within(boundary).getByRole('status')).toHaveTextContent('Cancelled before completion')
    expect(within(boundary).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(boundary).queryByText(recoveryMessage)).not.toBeInTheDocument()
    expect(within(boundary).queryByText(/Exchange failed/i)).not.toBeInTheDocument()
    expect(boundary.querySelector('.cross-chat-leg-error')).not.toBeInTheDocument()
    expect(within(boundary).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    expect(within(boundary).queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
  })

  it.each([
    {
      direction: 'outgoing' as const,
      sessionId: 'chat-1',
      title: 'To Training'
    },
    {
      direction: 'incoming' as const,
      sessionId: 'chat-2',
      title: 'Source'
    }
  ])('renders an $direction instruction exchange as an instruction with a scoped reply available', ({ direction, sessionId, title }) => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: sessionId,
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ]
    })
    const event: Event = {
      id: `instruction-${direction}`, session_id: sessionId, seq: 21,
      type: 'cross_chat_exchange_leg_started', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-instruction', exchange_leg_id: 'instruction-leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_initial_action: 'instruction',
      exchange_direction: direction, exchange_expects_reply: false, exchange_ordinal: 1, exchange_max_legs: 2,
      exchange_used_legs: 1, exchange_remaining_legs: 1,
      source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-instruction:instruction-leg-1',
      key: 'cross-chat-exchange:exchange-instruction:instruction-leg-1', seq: event.seq, event
    }

    render(<TimelineRowView item={item} sessionId={sessionId} onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText(title)).toBeInTheDocument()
    expect(document.querySelector('.cross-chat-exchange-detail-lines')).not.toBeInTheDocument()
    expect(document.querySelector('.cross-chat-message')).toHaveClass(direction)
    expect(screen.getByRole('status')).toHaveTextContent('Delivery in progress')
    expect(screen.queryByText('Reply expected')).not.toBeInTheDocument()
    expect(screen.queryByText('No reply expected')).not.toBeInTheDocument()
    expect(screen.queryByText('Reply available')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Asking /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Request from /)).not.toBeInTheDocument()
  })

  it('renders an instruction exchange summary without claiming it is an Ask', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }]
    })
    const event: Event = {
      id: 'instruction-summary', session_id: 'chat-1', seq: 22,
      type: 'cross_chat_exchange_registered', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-instruction', exchange_status: 'active', exchange_initial_action: 'instruction',
      exchange_max_legs: 2, exchange_used_legs: 1, exchange_remaining_legs: 1,
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      requester_title: 'Source', responder_title: 'Training'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-instruction:summary',
      key: 'cross-chat-exchange:exchange-instruction:summary', seq: event.seq, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText(/^(?:To )?Training$/)).toBeInTheDocument()
    expect(document.querySelector('.cross-chat-exchange-detail-lines')).not.toBeInTheDocument()
    expect(screen.getByText('Delivery in progress')).toBeInTheDocument()
    expect(screen.queryByText('Reply expected from Training')).not.toBeInTheDocument()
    expect(screen.queryByText('Reply expected')).not.toBeInTheDocument()
  })

  it('derives an exchange summary counterpart from authenticated detail and lets either participant cancel', async () => {
    const exchange = exchangeFixture()
    loadExchange.mockResolvedValue(exchange)
    cancelExchange.mockResolvedValue({ ...exchange, status: 'cancelled' })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [
        { id: 'chat-1', title: 'Research', backend: 'codex' },
        { id: 'chat-2', title: 'Target', backend: 'claude' }
      ]
    })
    const event: Event = {
      id: 'exchange-summary', session_id: 'chat-2', seq: 21,
      type: 'cross_chat_exchange_registered', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_status: 'active', exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5, exchange_expires_at: '2026-08-13T00:00:00Z'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:summary',
      key: 'cross-chat-exchange:exchange-1:summary', seq: 21, event
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    expect(await screen.findByText('Research')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Research' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'End conversation' })).toHaveAttribute(
      'title', 'Cancels queued work and stops a running target on supported servers.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'End conversation' }))
    await waitFor(() => expect(cancelExchange).toHaveBeenCalledWith('exchange-1'))
    expect(await screen.findByRole('status')).toHaveTextContent('Cancelled before completion')
    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
  })

  it('renders canonical requester/responder summary fields before loading detail', () => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')], sessions: []
    })
    const event: Event = {
      id: 'exchange-summary-canonical', session_id: 'chat-1', seq: 22,
      type: 'cross_chat_exchange_registered', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_status: 'waiting_request', exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5, exchange_expires_at: '2026-08-13T00:00:00Z',
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      requester_title: 'Source', responder_title: 'Training'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:summary',
      key: 'cross-chat-exchange:exchange-1:summary', seq: 22, event
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText(/^(?:To )?Training$/)).toBeInTheDocument()
    expect(screen.getByText('Waiting to start')).toBeInTheDocument()
    expect(screen.queryByText('Reply expected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View message' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Training' })).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()
  })

  it('lets a propagated terminal summary override stale loaded active detail on a running leg', async () => {
    const exchange = exchangeFixture()
    loadExchange.mockResolvedValue(exchange)
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Training', backend: 'claude' }]
    })
    const event: Event = {
      id: 'exchange-leg-stale-active', session_id: 'chat-1', seq: 23,
      type: 'cross_chat_exchange_leg_started', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:leg-1',
      key: 'cross-chat-exchange:exchange-1:leg-1', seq: 23, event
    }
    const props = { sessionId: 'chat-1', onFindFile: () => {}, pinnedItemIds: new Set<string>() }
    const view = render(<TimelineRowView item={item} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(loadExchange).toHaveBeenCalledWith('exchange-1'))
    expect(screen.getByRole('button', { name: 'End conversation' })).toBeInTheDocument()

    view.rerender(<TimelineRowView item={{ ...item, event: { ...event, exchange_status: 'cancelled' } }} {...props} />)

    expect(screen.getByRole('status')).toHaveTextContent('Cancelled before completion')
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
  })

  it.each([
    { ordinal: 2, kind: 'reply' as const, expectsReply: false, used: 2, remaining: 4 },
    { ordinal: 2, kind: 'request' as const, expectsReply: true, used: 2, remaining: 4 },
    { ordinal: 3, kind: 'request' as const, expectsReply: true, used: 3, remaining: 3 },
    { ordinal: 3, kind: 'reply' as const, expectsReply: false, used: 3, remaining: 3 },
    { ordinal: 4, kind: 'reply' as const, expectsReply: false, used: 4, remaining: 2 },
    { ordinal: 5, kind: 'request' as const, expectsReply: true, used: 5, remaining: 1 },
    { ordinal: 6, kind: 'reply' as const, expectsReply: false, used: 6, remaining: 0 }
  ])('keeps leg $ordinal $kind metadata out of bubbles while preserving scoped controls', ({ ordinal, kind, expectsReply, used, remaining }) => {
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-2',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Research', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const event: Event = {
      id: `exchange-leg-${ordinal}`, session_id: 'chat-2', seq: 30 + ordinal,
      type: 'cross_chat_exchange_leg_delivered', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: `leg-${ordinal}`, exchange_status: expectsReply ? 'active' : 'completed',
      exchange_leg_status: 'delivered', exchange_leg_kind: kind, exchange_direction: 'incoming',
      exchange_expects_reply: expectsReply, exchange_ordinal: ordinal, exchange_max_legs: 6,
      exchange_used_legs: used, exchange_remaining_legs: remaining,
      source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: `cross-chat-exchange:exchange-1:leg-${ordinal}`,
      key: `cross-chat-exchange:exchange-1:leg-${ordinal}`, seq: event.seq, event
    }

    render(<TimelineRowView item={item} sessionId="chat-2" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.queryByText(/Reply expected|No reply expected|Round \d/)).not.toBeInTheDocument()
    expect(document.querySelector('.cross-chat-exchange-detail-lines')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.cross-chat-message')).toHaveLength(1)
    expect(document.querySelector('.cross-chat-message')).toHaveClass('incoming')
    expect(screen.queryByText(/Messages:|Remaining:/)).not.toBeInTheDocument()
    if (expectsReply) expect(screen.getByRole('button', { name: 'End conversation' })).toBeInTheDocument()
    else expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
  })

  it('discards exchange detail when the active profile changes in flight', async () => {
    let resolveExchange!: (exchange: CrossChatExchange) => void
    loadExchange.mockImplementation(() => new Promise(resolve => { resolveExchange = resolve }))
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const event: Event = {
      id: 'exchange-stale', session_id: 'chat-1', seq: 22,
      type: 'cross_chat_exchange_leg_received', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:leg-1',
      key: 'cross-chat-exchange:exchange-1:leg-1', seq: 22, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(loadExchange).toHaveBeenCalled())

    useAppStore.setState({
      activeProfileId: 'profile-b', profileGeneration: 5, selectedSessionId: 'chat-other',
      profiles: [profileFixture('profile-b', 'server-b')]
    })
    resolveExchange(exchangeFixture())

    await waitFor(() => expect(screen.queryByText('Inspect the renderer carefully.')).not.toBeInTheDocument())
  })

  it('rejects exchange detail that does not include the displayed chat as a participant', async () => {
    loadExchange.mockResolvedValue({
      ...exchangeFixture(), requester_session_id: 'foreign-a', responder_session_id: 'foreign-b'
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      profiles: [profileFixture('profile-a', 'server-a')],
      sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }]
    })
    const event: Event = {
      id: 'exchange-participant-mismatch', session_id: 'chat-1', seq: 23,
      type: 'cross_chat_exchange_leg_received', ts: '2026-08-10T00:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1:leg-1',
      key: 'cross-chat-exchange:exchange-1:leg-1', seq: 23, event
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))

    await waitFor(() => expect(loadExchange).toHaveBeenCalledWith('exchange-1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('not a participant in the exchange')
    expect(screen.queryByText('Inspect the renderer carefully.')).not.toBeInTheDocument()
  })

  it('renders Codex lifecycle state as a compact collapsed marker', () => {
    const event: Event = {
      id: 'compact-complete',
      session_id: 'chat-1',
      seq: 12,
      type: 'codex_compaction_completed',
      ts: '2026-07-10T14:31:00Z',
      operation_id: 'compact-1',
      message: 'Codex completed automatic context compaction.'
    }
    const item: SystemItem = {
      kind: 'system',
      id: 'codex:compaction:compact-1',
      key: 'codex:compaction:compact-1',
      seq: 12,
      event
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(screen.getByText('Context compacted')).toBeInTheDocument()
    expect(screen.getByText('Codex completed automatic context compaction.')).not.toBeVisible()
    expect(container.querySelector('.system-row.codex-lifecycle')).not.toHaveAttribute('open')

    fireEvent.click(screen.getByText('Context compacted'))

    expect(screen.getByText('Codex completed automatic context compaction.')).toBeVisible()
  })

  it('renders an in-progress compaction at its anchored timeline time', () => {
    const event: Event = {
      id: 'compact-start',
      session_id: 'chat-1',
      seq: 12,
      type: 'codex_compaction_started',
      ts: '2026-07-10T14:31:00Z',
      operation_id: 'compact-1',
      message: 'Codex started compacting this thread context.'
    }
    const item: SystemItem = {
      kind: 'system',
      id: 'codex:compaction:compact-1',
      key: 'codex:compaction:compact-1',
      seq: 12,
      anchorTs: event.ts,
      event
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} codexLifecycleActive />
    )

    expect(screen.getByText('Compacting context…')).toBeInTheDocument()
    expect(container.querySelector('.system-icon .spin')).toBeInTheDocument()
  })

  it('keeps an owned run visibly live through compaction until its actual finish', () => {
    const progress: Event = {
      id: 'working', session_id: 'chat-1', seq: 10, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:30:00Z', text: 'Checking the incoming message.'
    }
    const compacting: Event = {
      id: 'compact-start', session_id: 'chat-1', seq: 11, type: 'codex_compaction_started',
      ts: '2026-07-10T14:30:14Z', compaction_id: 'compact-live'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-live', key: 'progress-live', seq: 11,
      active: true, startedAt: progress.ts, events: [progress],
      lifecycle: [{
        kind: 'system', id: 'compact-live', key: 'codex:compaction:compact-live',
        seq: 11, event: compacting, anchorTs: compacting.ts
      }]
    }
    const row = (value: ProgressItem) => <TimelineRowView item={value} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    const { container, rerender } = render(row(item))
    expect(container.querySelector('.run-activity-summary')).toHaveTextContent('Compacting context…')
    expect(container.querySelector('.run-activity-summary .activity-ring')).not.toBeNull()
    expect(screen.queryByText('Worked for 14s')).not.toBeInTheDocument()

    const completed: ProgressItem = {
      ...item,
      lifecycle: item.lifecycle!.map(marker => ({
        ...marker, event: { ...marker.event, type: 'codex_compaction_completed', ts: '2026-07-10T14:32:00Z' }
      }))
    }
    rerender(row(completed))
    expect(container.querySelector('.run-activity-summary')).toHaveTextContent('Working for')
    expect(container.querySelector('.run-activity-summary .activity-ring')).not.toBeNull()

    rerender(row({ ...completed, active: false, finishedAt: '2026-07-10T14:33:00Z' }))
    expect(container.querySelector('.run-activity-summary')).toHaveTextContent('Worked for 3m')
    expect(container.querySelector('.run-activity-summary .activity-ring')).toBeNull()
  })

  it('renders an in-turn compaction between live updates in one progress surface', () => {
    const before: Event = {
      id: 'before', session_id: 'chat-1', seq: 10, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:30:00Z', text: 'Before compaction.'
    }
    const after: Event = {
      id: 'after', session_id: 'chat-1', seq: 14, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:32:00Z', text: 'After compaction.'
    }
    const compaction: Event = {
      id: 'compact-complete', session_id: 'chat-1', seq: 13,
      type: 'codex_compaction_completed', ts: '2026-07-10T14:31:00Z',
      compaction_id: 'compact-1', message: 'Context compaction completed.'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-1', key: 'progress-1', seq: 14,
      events: [before, after],
      lifecycle: [{
        kind: 'system', id: 'compact-1', key: 'codex:compaction:compact-1',
        seq: 11, event: compaction, anchorTs: '2026-07-10T14:31:00Z'
      }]
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const surface = container.querySelector('.run-activity .trace-activity')
    expect(surface).not.toBeNull()
    expect(container.querySelectorAll('.run-activity')).toHaveLength(1)
    expect([...surface!.children].map(child => child.textContent)).toEqual([
      'Before compaction.',
      '1 status update',
      'After compaction.'
    ])
    expect(within(container).queryByText('Context compacted')).not.toBeInTheDocument()
    fireEvent.click(within(container).getByRole('button', { name: '1 status update' }))
    expect(within(container).getByText('Context compacted')).toBeInTheDocument()
    expect(within(container).queryByText(/Progress updates/)).not.toBeInTheDocument()
  })

  it('renders a live cross-chat lifecycle card inline at its immutable sequence', () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Target', backend: 'codex' },
        { id: 'chat-2', title: 'Research', backend: 'claude' }
      ]
    })
    const before: Event = {
      id: 'before-handoff', session_id: 'chat-1', seq: 10, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:30:00Z', text: 'Before the handoff.'
    }
    const after: Event = {
      id: 'after-handoff', session_id: 'chat-1', seq: 14, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:32:00Z', text: 'After the handoff.'
    }
    const handoff: Event = {
      id: 'handoff-started', session_id: 'chat-1', seq: 30,
      type: 'cross_chat_handoff_started', ts: '2026-07-10T14:31:00Z',
      handoff_id: 'handoff-live', handoff_status: 'running', handoff_action: 'instruction',
      source_session_id: 'chat-2', target_session_id: 'chat-1'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-handoff', key: 'progress-handoff', seq: 14,
      events: [before, after],
      lifecycle: [{
        kind: 'system', id: 'cross-chat:handoff:handoff-live',
        key: 'cross-chat:handoff:handoff-live', seq: 12, event: handoff
      }]
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const surface = container.querySelector('.run-activity .trace-activity')
    const parts = [...surface!.children]

    expect(container.querySelectorAll('.run-activity')).toHaveLength(1)
    expect(parts.map(part => part.textContent)).toEqual([
      'Before the handoff.',
      '1 status update',
      'After the handoff.'
    ])
    expect(within(container).queryByText(/Progress updates/)).not.toBeInTheDocument()
    expect(parts[1]).toHaveClass('run-activity-support')
    fireEvent.click(within(parts[1] as HTMLElement).getByRole('button', { name: '1 status update' }))
    expect(parts[1].querySelector('.cross-chat-message')).toHaveAttribute('data-event-id', 'handoff-started')
  })

  it('renders a live emergency lifecycle card inline between commentary updates', () => {
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Production watch', backend: 'codex',
        emergency_alert: {
          id: 'alert-live', status: 'active', severity: 'critical',
          message: 'The production rollback needs approval.',
          raised_at: '2026-08-25T12:01:00Z'
        },
        unacknowledged_emergency_count: 1
      }]
    })
    const before: Event = {
      id: 'before-emergency', session_id: 'chat-1', seq: 20, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-08-25T12:00:00Z', text: 'Before the emergency.'
    }
    const after: Event = {
      id: 'after-emergency', session_id: 'chat-1', seq: 22, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-08-25T12:02:00Z', text: 'After the emergency.'
    }
    const emergency: Event = {
      id: 'emergency-live', session_id: 'chat-1', seq: 21, type: 'emergency_alert_raised',
      ts: '2026-08-25T12:01:00Z', emergency_alert_id: 'alert-live',
      message: 'The production rollback needs approval.'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-emergency', key: 'progress-emergency', seq: 22,
      events: [before, after],
      lifecycle: [{
        kind: 'system', id: 'event:emergency-live', key: 'event:emergency-live', seq: 21, event: emergency
      }]
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const surface = container.querySelector('.run-activity .trace-activity')
    const parts = [...surface!.children]

    expect(parts.map(part => part.textContent)).toEqual([
      'Before the emergency.',
      '1 status update',
      'After the emergency.'
    ])
    expect(within(container).queryByText(/Progress updates/)).not.toBeInTheDocument()
    fireEvent.click(within(parts[1] as HTMLElement).getByRole('button', { name: '1 status update' }))
    expect(parts[1].querySelector('.system-row.emergency')).toHaveAttribute('data-event-id', 'emergency-live')
    expect(within(parts[1] as HTMLElement).getByRole('button', { name: 'Acknowledge emergency in Production watch' })).toBeVisible()
  })

  it('keeps commentary, reasoning, and lifecycle events in one live activity stream', () => {
    const commentary: Event = {
      id: 'commentary', session_id: 'chat-1', seq: 10, type: 'reasoning_summary',
      phase: 'commentary', ts: '2026-07-10T14:30:00Z', text: 'Checking the renderer.'
    }
    const activity: Event = {
      id: 'activity', session_id: 'chat-1', seq: 11, type: 'reasoning_summary',
      ts: '2026-07-10T14:31:00Z', text: 'Inspecting timeline ownership.'
    }
    const compaction: Event = {
      id: 'compact-complete', session_id: 'chat-1', seq: 12,
      type: 'codex_compaction_completed', ts: '2026-07-10T14:32:00Z',
      compaction_id: 'compact-1', message: 'Context compaction completed.'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-1', key: 'progress-1', seq: 12,
      events: [commentary, activity],
      lifecycle: [{
        kind: 'system', id: 'compact-1', key: 'codex:compaction:compact-1',
        seq: 12, event: compaction, anchorTs: compaction.ts
      }]
    }

    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const surface = container.querySelector('.run-activity .trace-activity')
    expect([...surface!.children].map(child => child.textContent)).toEqual([
      'Checking the renderer.',
      'Thinking summaryInspecting timeline ownership.',
      '1 status update'
    ])
    expect(container.querySelectorAll('.run-activity-support')).toHaveLength(1)
    expect(within(container).getByText('Inspecting timeline ownership.')).toBeInTheDocument()
    expect(within(container).queryByText('Context compacted')).not.toBeInTheDocument()
    fireEvent.click(within(container).getByRole('button', { name: '1 status update' }))
    expect(within(container).getByText('Inspecting timeline ownership.')).toBeInTheDocument()
    expect(within(container).getByText('Context compacted')).toBeInTheDocument()
    expect(container.querySelector('.message-row.assistant')).not.toBeInTheDocument()
  })

  it('renders a durable start-only compaction as historical when the turn is idle', () => {
    const event: Event = {
      id: 'compact-start',
      session_id: 'chat-1',
      seq: 12,
      type: 'codex_compaction_started',
      ts: '2026-07-10T14:31:00Z',
      compaction_id: 'native:thread-1:turn-1:item-1',
      message: 'Codex started compacting this thread context.'
    }
    const item: SystemItem = {
      kind: 'system',
      id: 'codex:compaction:native:thread-1:turn-1:item-1',
      key: 'codex:compaction:native:thread-1:turn-1:item-1',
      seq: 12,
      anchorTs: event.ts,
      event
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(screen.getByText('Context compaction started')).toBeInTheDocument()
    expect(container.querySelector('.system-icon .spin')).not.toBeInTheDocument()
  })

  it('copies the complete aggregated assistant message through native IPC', () => {
    const first: Event = {
      id: 'event-1', session_id: 'chat-1', seq: 1, type: 'assistant_text',
      ts: '2026-07-10T14:29:00Z', text: 'First update'
    }
    const second: Event = {
      id: 'event-2', session_id: 'chat-1', seq: 2, type: 'assistant_text',
      ts: '2026-07-10T14:30:00Z', text: 'Final update'
    }
    const item: MessageItem = {
      kind: 'message', id: 'message-1', key: 'message-1', seq: 1,
      event: first, events: [first, second], role: 'assistant', files: []
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByTitle('Copy full message'))

    expect(writeClipboard).toHaveBeenCalledWith('First update\n\nFinal update')
  })

  it('renders a generic-MIME PNG inside its user message bubble', () => {
    const event: Event = {
      id: 'event-user', session_id: 'chat-1', seq: 1, type: 'turn_started',
      ts: '2026-07-10T14:29:00Z', prompt: 'What is this?', file_ids: ['input-image']
    }
    const file: AgentFile = {
      id: 'input-image', filename: 'question.png', content_type: 'application/octet-stream'
    }
    const item: MessageItem = {
      kind: 'message', id: 'message-user', key: 'message-user', seq: 1,
      event, events: [event], role: 'user', files: [file]
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const surface = container.querySelector('.message-row.user .message-surface')

    expect(surface).not.toBeNull()
    expect(within(surface as HTMLElement).getByRole('img', { name: 'question.png' })).toHaveAttribute('src', 'agentsdock-media://file/input-image')
  })

  it('shows the omission marker for an oversized tool result', () => {
    const toolResult: Event = {
      id: 'tool-result', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', output: 'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 11),
      tool: { name: 'exec' }
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 1, events: [toolResult], promotedCommentaryIds: [], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(screen.getByRole('button', { name: /1 tool/ }))
    fireEvent.click(within(container).getByRole('button', { name: /exec.*Success/i }))

    expect(container.querySelector('.tool-event pre')?.textContent?.slice(TOOL_OUTPUT_PREVIEW_CHARS)).toBe(
      '\n\n[AgentsDock omitted 11 characters from this tool output]'
    )
  })

  it('shows every active commentary update in one flat expanded activity stream', () => {
    const firstCommentary: Event = {
      id: 'progress-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary',
      text: 'The release validation is still running.'
    }
    const secondCommentary: Event = {
      id: 'progress-2', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:30:00Z', phase: 'commentary',
      text: 'The signed package passed verification.'
    }
    const initialItem: ProgressItem = {
      kind: 'progress', id: 'turn:run-1:activity', key: 'turn:run-1:activity', seq: 1,
      events: [firstCommentary], active: true, startedAt: firstCommentary.ts
    }
    const rendered = render(
      <TimelineRowView item={initialItem} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const firstLine = rendered.container.querySelector('.trace-activity-item.commentary')
    const updatedItem: ProgressItem = {
      ...initialItem,
      seq: 2,
      events: [firstCommentary, secondCommentary]
    }
    rendered.rerender(
      <TimelineRowView item={updatedItem} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const liveHeader = rendered.container.querySelector('.run-activity-summary')
    expect(liveHeader).not.toHaveAttribute('role')
    expect(liveHeader).not.toHaveAttribute('aria-live')
    expect(rendered.container.querySelector('.trace-progress-card')).not.toBeInTheDocument()
    expect(rendered.container.querySelector('.trace-activity-item.commentary')).toBe(firstLine)
    expect([...rendered.container.querySelectorAll('.trace-commentary .markdown')].map(row => row.textContent)).toEqual([
      'The release validation is still running.',
      'The signed package passed verification.'
    ])
    expect(within(rendered.container).queryByText(/Progress updates/)).not.toBeInTheDocument()
    expect(within(rendered.container).getByText(/Working for/)).toBeInTheDocument()
    expect(rendered.container.querySelector('.message-row.assistant')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByTitle('Pin message')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByTitle('Copy full message')).not.toBeInTheDocument()
  })

  it('shows current goal progress below the old answer without mounting its bulk tool history', async () => {
    const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
      id: `goal-${seq}`, session_id: 'chat-1', run_id: 'goal-run', backend: 'codex',
      seq, type, ts: '2026-07-10T14:29:00Z', ...fields
    })
    const tools = Array.from({ length: 307 }, (_, index) => event(4 + index, 'tool_finished', {
      tool_id: `tool-${index}`, tool: { name: 'exec' }, output: `Long tool detail ${index}`
    }))
    const source = [
      event(1, 'turn_started', { prompt: 'Keep working' }),
      event(2, 'reasoning_summary', { phase: 'commentary', text: 'Old progress.' }),
      event(3, 'assistant_text', { text: 'The earlier answer.' }),
      ...tools,
      event(311, 'reasoning_summary', { text: 'An old unclassified summary remains supporting detail.' }),
      event(312, 'reasoning_summary', { phase: 'commentary', text: 'The continuation is still working.' })
    ]
    loadTrace.mockResolvedValueOnce({ events: source, has_more: false, next_after: 312 })
    const rows = renderTimelineItems(projectTimeline(source, []))
    const { container } = render(<>{rows.map(item =>
      <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )}</>)
    const latest = container.querySelectorAll('.run-activity')[1]
    expect(container.querySelectorAll('.message-row.assistant')).toHaveLength(1)
    expect(within(latest as HTMLElement).getByText(/Working for/)).toBeInTheDocument()
    expect(within(latest as HTMLElement).getByText('The continuation is still working.')).toBeInTheDocument()
    expect(within(latest as HTMLElement).getByRole('button', { name: 'Ran commands' })).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelectorAll('.tool-event')).toHaveLength(0)
    expect(screen.queryByText('Old progress.')).not.toBeInTheDocument()
    expect(screen.getByText('An old unclassified summary remains supporting detail.')).toBeInTheDocument()
    expect(loadTrace).not.toHaveBeenCalled()
    expect(within(latest as HTMLElement).queryByRole('button', { name: 'Load available activity' })).not.toBeInTheDocument()
    act(() => setReasoningDisplay('expanded'))
    fireEvent.click(within(latest as HTMLElement).getByRole('button', { name: 'Load available activity' }))
    await within(latest as HTMLElement).findByRole('button', { name: 'Use compact trace' })
    expect(loadTrace).toHaveBeenCalledWith('chat-1', 'goal-run', 312, 3)
    expect(within(latest as HTMLElement).queryByText('Old progress.')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.tool-event')).toHaveLength(0)
    const earlier = container.querySelectorAll('.run-activity')[0] as HTMLElement
    loadTrace.mockResolvedValueOnce({ events: source, has_more: true, next_after: 312 })
    fireEvent.click(within(earlier).getByRole('button', { name: /Worked for/ }))
    fireEvent.click(within(earlier).getByRole('button', { name: 'Load available activity' }))
    await within(earlier).findByRole('button', { name: 'Use compact trace' })
    expect(within(earlier).queryByText('The continuation is still working.')).not.toBeInTheDocument()
    expect(within(earlier).queryByRole('button', { name: 'Load more activity' })).not.toBeInTheDocument()
    expect(within(earlier).queryByRole('button', { name: 'Check for newer activity' })).not.toBeInTheDocument()
  })

  it('renders native goal follow-up input between bounded same-owner activity segments', async () => {
    const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
      id: `goal-steer-${seq}`, session_id: 'chat-1', run_id: 'goal-owner', backend: 'codex',
      seq, type, ts: `2026-09-10T10:00:0${seq}Z`, ...fields
    })
    const source = [
      event(1, 'turn_started', { prompt: 'Keep pursuing the goal.' }),
      event(2, 'reasoning_summary', { phase: 'commentary', text: 'Goal progress before the follow-up.' }),
      event(3, 'turn_steered', { purpose: 'codex_goal_resume', native_steer: true, native_goal_steer: true,
        provider_user_authored: true, queued_id: 'queued-followup', provider_turn_id: 'native-turn',
        prompt: 'Please incorporate this additional detail.', file_ids: [] }),
      event(4, 'reasoning_summary', { phase: 'commentary', text: 'The same goal continues after the follow-up.' })
    ]
    loadTrace.mockResolvedValue({ events: source, has_more: true, next_after: 4 })
    const rows = renderTimelineItems(projectTimeline(source, []))
    const { container } = render(<>{rows.map(item =>
      <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )}</>)
    const users = container.querySelectorAll('.message-row.user')
    expect(users).toHaveLength(2)
    expect(users[1]).toHaveTextContent('Please incorporate this additional detail.')
    const [earlier, latest] = [...container.querySelectorAll<HTMLElement>('.run-activity')]
    expect(earlier.compareDocumentPosition(users[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(users[1].compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(latest).getByText(/Working for/)).toBeInTheDocument()
    expect(within(earlier).queryByText(/Working for/)).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('You stopped')
    expect(loadTrace).not.toHaveBeenCalled()
    expect(within(latest).queryByRole('button', { name: 'Load available activity' })).not.toBeInTheDocument()
    act(() => setReasoningDisplay('expanded'))
    fireEvent.click(within(latest).getByRole('button', { name: 'Load available activity' }))
    await within(latest).findByRole('button', { name: 'Use compact trace' })
    expect(loadTrace).toHaveBeenLastCalledWith('chat-1', 'goal-owner', 4, 3)
    expect(within(latest).queryByText('Goal progress before the follow-up.')).not.toBeInTheDocument()
    fireEvent.click(within(earlier).getByRole('button', { name: /Worked for/ }))
    fireEvent.click(within(earlier).getByRole('button', { name: 'Load available activity' }))
    await within(earlier).findByRole('button', { name: 'Use compact trace' })
    expect(within(earlier).queryByText('The same goal continues after the follow-up.')).not.toBeInTheDocument()
    expect(within(earlier).queryByRole('button', { name: 'Load more activity' })).not.toBeInTheDocument()
  })

  it('updates elapsed time without reading the activity text again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T14:29:00Z'))
    const readText = vi.fn(() => 'An expensive progress update stays unchanged.')
    const commentary: Event = {
      id: 'timer-commentary', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary',
      get text() { return readText() }
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'timer-activity', key: 'timer-activity', seq: 1,
      events: [commentary], active: true, startedAt: commentary.ts
    }
    try {
      const rendered = render(
        <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
      )
      const initialReads = readText.mock.calls.length
      expect(initialReads).toBeGreaterThan(0)
      act(() => { vi.advanceTimersByTime(3000) })
      expect(within(rendered.container).getByText('Working for 3s')).toBeInTheDocument()
      expect(readText).toHaveBeenCalledTimes(initialReads)
      expect(rendered.container.querySelector('.run-activity-summary')).not.toHaveAttribute('aria-live')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps completed activity open and renders the final as a separate message', () => {
    const commentary: Event = {
      id: 'commentary-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary', text: 'I am validating the release.'
    }
    const live: ProgressItem = {
      kind: 'progress', id: 'turn:run-1:activity', key: 'turn:run-1:activity', seq: 1,
      events: [commentary], active: true, startedAt: commentary.ts
    }
    const rendered = render(
      <TimelineRowView item={live} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const activity = rendered.container.querySelector('.run-activity')
    const finalEvent: Event = {
      id: 'final-1', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', result_text: 'The release passed validation.'
    }
    const final: MessageItem = {
      kind: 'message', id: 'turn:run-1:assistant', key: 'turn:run-1:assistant', seq: 2,
      event: finalEvent, events: [finalEvent], role: 'assistant', files: []
    }
    const completed: ProgressItem = {
      ...live, active: false, finishedAt: finalEvent.ts, hasFinalResponse: true
    }

    rendered.rerender(
      <>
        <TimelineRowView item={completed} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
        <TimelineRowView item={final} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
      </>
    )

    expect(rendered.container.querySelector('.run-activity')).toBe(activity)
    expect(within(rendered.container).queryByText(/Working for/)).not.toBeInTheDocument()
    const completedToggle = within(rendered.container).getByRole('button', { name: 'Worked for 1m 0s' })
    expect(completedToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText('I am validating the release.')).toBeInTheDocument()
    expect(within(rendered.container).getByText('The release passed validation.')).toBeInTheDocument()
    fireEvent.click(completedToggle)
    expect(completedToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(completedToggle)
    expect(completedToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText('I am validating the release.')).toBeInTheDocument()
    expect(within(rendered.container).queryByText(/Progress updates/)).not.toBeInTheDocument()
    expect(within(rendered.container).getByTitle('Pin message')).toBeInTheDocument()
    expect(within(rendered.container).getByTitle('Copy full message')).toBeInTheDocument()
  })

  it.each(['reasoning_summary', 'assistant_text'])('keeps one Claude final answer after loading phased %s activity', async commentaryType => {
    const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
      id: `claude-full-${seq}`, session_id: 'chat-1', run_id: 'claude-full', backend: 'claude',
      seq, type, ts: `2026-07-10T14:29:0${seq}Z`, ...fields
    })
    const finalText = 'The final answer is separate and appears once.'
    const source = [
      event(1, 'turn_started', { prompt: 'Inspect the UI.' }),
      event(2, commentaryType, { phase: 'commentary', text: 'I am checking the requested UI behavior.' }),
      event(3, 'tool_started', { tool: { id: 'read-1', name: 'Read', input: { file_path: 'fixture.txt' } } }),
      event(4, 'tool_finished', { tool_id: 'read-1', output: 'Fixture inspected.' }),
      event(5, commentaryType, { phase: 'commentary', text: finalText }),
      event(6, 'code_diff', { files_changed: 1, diff_files: [{ path: 'file.ts', additions: 1, deletions: 0 }] }),
      event(7, 'turn_finished', { result_text: finalText })
    ]
    loadTrace.mockResolvedValueOnce({ events: source, has_more: false, next_after: 7 })
    const rows = renderTimelineItems(projectTimeline(source, []))
    const { container } = render(<>{rows.map(item =>
      <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )}</>)

    fireEvent.click(within(container).getByRole('button', { name: 'Worked for 6s' }))
    expect(within(container).getAllByText(finalText)).toHaveLength(1)
    fireEvent.click(within(container).getByRole('button', { name: 'Load available activity' }))
    await within(container).findByRole('button', { name: 'Use compact trace' })

    expect(within(container).getAllByText(finalText)).toHaveLength(1)
    expect(container.querySelector('.run-activity')).not.toHaveTextContent(finalText)
    expect(within(container).getByText('I am checking the requested UI behavior.')).toBeInTheDocument()
    expect(container.querySelector('.run-activity')).toHaveTextContent('1 tool call')
    expect(within(container).getByRole('button', { name: /Edited 1 file.*Review/ })).toBeInTheDocument()
  })

  it('keeps delayed commentary above the answer when opening and paging a split goal trace', async () => {
    const event = (seq: number, type: string, ts: string, fields: Partial<Event> = {}): Event => ({
      id: `delayed-${seq}`, session_id: 'chat-1', run_id: 'delayed-goal', backend: 'codex',
      seq, type, ts: `2026-07-10T14:29:${ts}Z`, ...fields
    })
    const source = [
      event(1, 'turn_started', '00', { prompt: 'Continue' }),
      event(2, 'reasoning_summary', '10', { phase: 'commentary', text: 'Initial progress.' }),
      event(3, 'assistant_text', '30', { text: 'Earlier answer.' }),
      event(4, 'reasoning_summary', '40', { phase: 'commentary', text: 'True continuation.' }),
      event(5, 'reasoning_summary', '20', { phase: 'commentary', text: 'Delayed earlier progress.' })
    ]
    loadTrace.mockResolvedValueOnce({
      events: [event(6, 'reasoning_summary', '25', { phase: 'commentary', text: 'Another earlier update from full history.' })],
      has_more: true, next_after: 6
    })
    const rows = renderTimelineItems(projectTimeline(source, []))
    const { container } = render(<>{rows.map(item =>
      <TimelineRowView key={item.key} item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )}</>)
    const activities = container.querySelectorAll<HTMLElement>('.run-activity')
    fireEvent.click(within(activities[0]).getByRole('button', { name: 'Worked for 30s' }))
    expect(activities[0]).toHaveTextContent('Delayed earlier progress.')
    expect(activities[0]).not.toHaveTextContent('True continuation.')
    expect(activities[1]).toHaveTextContent('True continuation.')
    expect(activities[1]).not.toHaveTextContent('Delayed earlier progress.')
    fireEvent.click(within(activities[0]).getByRole('button', { name: 'Load available activity' }))
    await within(activities[0]).findByText('Another earlier update from full history.')
    expect(within(activities[0]).getByRole('button', { name: 'Load more activity' })).toBeInTheDocument()
    expect(activities[1]).not.toHaveTextContent('Another earlier update from full history.')
    expect(within(container).getAllByText('Earlier answer.')).toHaveLength(1)
  })

  it('keeps a live run open when stop and a real final arrive together', () => {
    const commentary: Event = {
      id: 'same-frame-commentary', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary', text: 'Finishing the requested check.'
    }
    const live: ProgressItem = {
      kind: 'progress', id: 'same-frame-activity', key: 'same-frame-activity', seq: 1,
      events: [commentary], active: true, hasFinalResponse: false, startedAt: commentary.ts
    }
    const row = (item: ProgressItem) => <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    const rendered = render(row(live))
    const completed: ProgressItem = {
      ...live,
      active: false,
      hasFinalResponse: true,
      stoppedAt: '2026-07-10T14:29:30Z',
      finishedAt: '2026-07-10T14:29:30Z'
    }

    rendered.rerender(row(completed))

    const toggle = within(rendered.container).getByRole('button', { name: 'You stopped after 30s' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
    rendered.rerender(row({ ...completed, events: [...completed.events] }))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps stopped activity open when its final response arrives later', () => {
    const commentary: Event = {
      id: 'late-final-commentary', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary', text: 'Waiting for the final response record.'
    }
    const live: ProgressItem = {
      kind: 'progress', id: 'late-final-activity', key: 'late-final-activity', seq: 1,
      events: [commentary], active: true, hasFinalResponse: false, startedAt: commentary.ts
    }
    const row = (item: ProgressItem) => <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    const rendered = render(row(live))
    const stopped: ProgressItem = {
      ...live,
      active: false,
      stoppedAt: '2026-07-10T14:29:30Z',
      finishedAt: '2026-07-10T14:29:30Z'
    }

    rendered.rerender(row(stopped))
    const toggle = within(rendered.container).getByRole('button', { name: 'You stopped after 30s' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()

    rendered.rerender(row({ ...stopped, hasFinalResponse: true }))

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
  })

  it('keeps historical stopped commentary visible while trace details stay opt-in', () => {
    const commentary: Event = {
      id: 'commentary-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary', text: 'I was checking the release.'
    }
    const reasoning: Event = {
      id: 'reasoning-1', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', text: 'Private trace detail stays collapsed.'
    }
    const tool: Event = {
      id: 'tool-1', session_id: 'chat-1', seq: 3, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', tool: { id: 'tool-1', name: 'Bash' }, output: 'large output'
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'turn:run-1:activity', key: 'turn:run-1:activity', seq: 1,
      events: [commentary, reasoning, tool], active: false, hasFinalResponse: false,
      startedAt: '2026-07-10T14:28:30Z', stoppedAt: commentary.ts
    }
    const rendered = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const toggle = within(rendered.container).getByRole('button', { name: 'You stopped after 30s' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const visibleCommentary = within(rendered.container).getByText('I was checking the release.')
    expect(within(rendered.container).queryByText('Private trace detail stays collapsed.')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByText('Bash')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getAllByText('I was checking the release.')).toHaveLength(1)
    expect(within(rendered.container).getByText('I was checking the release.')).toBe(visibleCommentary)
    expect(within(rendered.container).getByText('Private trace detail stays collapsed.')).toBeInTheDocument()
    expect(within(rendered.container).queryByText('Bash')).not.toBeInTheDocument()
    const support = within(rendered.container).getByRole('button', { name: '1 tool call' })
    expect(support).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(support)
    expect(support).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText('Private trace detail stays collapsed.')).toBeInTheDocument()
    expect(within(rendered.container).getByText('Bash')).toBeInTheDocument()
    expect(within(rendered.container).getAllByText('I was checking the release.')).toHaveLength(1)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(rendered.container).getByText('I was checking the release.')).toBe(visibleCommentary)
    expect(within(rendered.container).queryByText('Private trace detail stays collapsed.')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByText('Bash')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByText('Stopped before final response')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByText(/Progress updates/)).not.toBeInTheDocument()
    expect(rendered.container.querySelector('.message-row.assistant')).not.toBeInTheDocument()
  })

  it('keeps a live stop visible but lets the user collapse it, including after more history arrives', () => {
    const commentary: Event = {
      id: 'stopping-commentary', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', phase: 'commentary', text: 'The work so far stays available.'
    }
    const live: ProgressItem = {
      kind: 'progress', id: 'stopping-activity', key: 'stopping-activity', seq: 1,
      events: [commentary], active: true, startedAt: commentary.ts, hasFinalResponse: false
    }
    const row = (item: ProgressItem) => <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    const rendered = render(row(live))
    const stopped = { ...live, active: false, stoppedAt: '2026-07-10T14:29:30Z' }
    rendered.rerender(row(stopped))
    const toggle = within(rendered.container).getByRole('button', { name: 'You stopped after 30s' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    rendered.rerender(row({ ...stopped, events: [...stopped.events] }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
    expect(rendered.container.querySelector('.message-row.assistant')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // A successor's metadata can prove this was steering after the stopped
    // finish arrived. Preserve the reader's explicit expansion.
    rendered.rerender(row({ ...stopped, stoppedAt: undefined, finishedAt: stopped.stoppedAt }))
    expect(within(rendered.container).getByRole('button', { name: 'Worked for 30s' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(rendered.container).getByText(commentary.text!)).toBeInTheDocument()
  })

  it('does not duplicate a private thinking summary in the live assistant surface', () => {
    const item: ProgressItem = {
      kind: 'progress', id: 'progress-1', key: 'progress-1', seq: 2,
      events: [{
        id: 'progress-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
        ts: '2026-07-10T14:29:00Z', phase: 'commentary',
        text: 'I am validating the release.'
      }, {
        id: 'activity-1', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
        ts: '2026-07-10T14:30:00Z',
        text: '**Inspecting release metadata**\n\nLong internal detail remains in the trace.'
      }]
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(container.querySelectorAll('.trace-commentary .markdown')).toHaveLength(1)
    expect(container.querySelector('.message-row.assistant')).not.toBeInTheDocument()
    expect(container.querySelector('.run-activity')).toHaveTextContent('I am validating the release.')
    expect(container.querySelectorAll('.trace-reasoning-body')).toHaveLength(1)
    expect(container.querySelector('.run-activity')).toHaveTextContent('Inspecting release metadata')
    expect(container.querySelector('.run-activity')).toHaveTextContent('Long internal detail')
    expect(container.querySelectorAll('.trace-commentary .markdown')).toHaveLength(1)
  })

  it('renders one chronological activity rail and pairs each tool lifecycle by ID', () => {
    const events: Event[] = [{
      id: 'thought-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Inspecting the workspace'
    }, {
      id: 'thought-2', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:01Z', run_id: 'run-1', text: 'Checking the manifest\nChecking the lockfile'
    }, {
      id: 'tool-a-start', session_id: 'chat-1', seq: 3, type: 'tool_started',
      ts: '2026-07-10T14:29:02Z', run_id: 'run-1',
      tool: { id: 'tool-a', name: 'read_file', input: { path: 'package.json' } }
    }, {
      id: 'tool-a-finish', session_id: 'chat-1', seq: 4, type: 'tool_finished',
      ts: '2026-07-10T14:29:03Z', run_id: 'run-1', tool_id: 'tool-a',
      tool: { id: 'tool-a', name: 'read_file' }, output: 'manifest contents', exit_code: 0
    }, {
      id: 'thought-3', session_id: 'chat-1', seq: 5, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:04Z', run_id: 'run-1', text: 'Planning the change'
    }, {
      id: 'tool-b-start', session_id: 'chat-1', seq: 6, type: 'tool_started',
      ts: '2026-07-10T14:29:05Z', run_id: 'run-1',
      tool: { id: 'tool-b', name: 'read_file', input: { path: 'src/app.ts' } }
    }]
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 1,
      events, promotedCommentaryIds: [], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const traceToggle = within(container).getByRole('button', { name: /Reasoning trace/ })
    expect(traceToggle).toHaveAccessibleName('Reasoning trace. 2 tools · 3 thinking summaries. Show details.')
    fireEvent.click(traceToggle)

    const entries = [...container.querySelectorAll<HTMLElement>('.trace-activity-item')]
    expect(entries.map(entry => entry.dataset.eventSeq)).toEqual(['1', '3', '5', '6'])
    expect(entries[0]).toHaveTextContent('Inspecting the workspace')
    expect(entries[0]).toHaveTextContent('Checking the manifest')
    expect(entries[1]).toHaveTextContent('read_fileSuccess')
    expect(entries[2]).toHaveTextContent('Planning the change')
    expect(entries[3]).toHaveTextContent('read_fileRunning')
    expect(container.querySelectorAll('.trace-reasoning')).toHaveLength(2)
    expect(container.querySelectorAll('.tool-event')).toHaveLength(2)
    expect(container.querySelector('.trace-reasoning-body')).toBeInTheDocument()
    expect(container.querySelector('.tool-event-body')).not.toBeInTheDocument()

    expect(entries[0].querySelector('.trace-reasoning-body')).toHaveTextContent('Checking the lockfile')
    fireEvent.click(within(entries[1]).getByRole('button', { name: /read_file.*Success/i }))
    expect(entries[1].querySelector('.tool-event-body')).toHaveTextContent('package.json')
    expect(entries[1].querySelector('.tool-event-body')).toHaveTextContent('manifest contents')
  })

  it('keeps expanded reasoning and tool rows stable while a trace streams', () => {
    const first: Event = {
      id: 'thought-1', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Inspecting the workspace'
    }
    const second: Event = {
      id: 'thought-2', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:01Z', run_id: 'run-1', text: 'Checking the manifest'
    }
    const started: Event = {
      id: 'tool-start', session_id: 'chat-1', seq: 3, type: 'tool_started',
      ts: '2026-07-10T14:29:02Z', run_id: 'run-1',
      tool: { id: 'tool-a', name: 'read_file', input: { path: 'package.json' } }
    }
    const finished: Event = {
      id: 'tool-finish', session_id: 'chat-1', seq: 4, type: 'tool_finished',
      ts: '2026-07-10T14:29:03Z', run_id: 'run-1', tool_id: 'tool-a',
      tool: { id: 'tool-a', name: 'read_file' }, output: 'done', exit_code: 0
    }
    const trace = (events: Event[]): TraceItem => ({
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 1,
      events, promotedCommentaryIds: [], active: true
    })
    const rendered = render(
      <TimelineRowView item={trace([first])} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(rendered.container).getByRole('button', { name: /Reasoning trace/ }))
    const reasoning = rendered.container.querySelector('.trace-reasoning')

    rendered.rerender(
      <TimelineRowView item={trace([first, second])} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    expect(rendered.container.querySelector('.trace')).toHaveClass('open')
    expect(rendered.container.querySelector('.trace-reasoning')).toBe(reasoning)
    expect(within(reasoning as HTMLElement).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(reasoning).toHaveTextContent('Checking the manifest')

    rendered.rerender(
      <TimelineRowView item={trace([first, second, started])} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    const tool = rendered.container.querySelector('.tool-event')
    expect(tool).toHaveTextContent('Running')
    rendered.rerender(
      <TimelineRowView item={trace([first, second, started, finished])} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )
    expect(rendered.container.querySelector('.tool-event')).toBe(tool)
    expect(tool).toHaveTextContent('Success')
    expect(rendered.container.querySelectorAll('.tool-event')).toHaveLength(1)
  })

  it('keeps a legacy ID-less tool as one row when its start loads after the finish anchor', async () => {
    const finished: Event = {
      id: 'legacy-finish', session_id: 'chat-1', seq: 2, type: 'tool_finished',
      ts: '2026-07-10T14:29:01Z', run_id: 'run-1', tool: { name: 'legacy_exec' },
      output: 'done', exit_code: 0
    }
    loadTrace.mockResolvedValueOnce({
      events: [{
        id: 'legacy-start', session_id: 'chat-1', seq: 1, type: 'tool_started',
        ts: '2026-07-10T14:29:00Z', run_id: 'run-1', tool: { name: 'legacy_exec' }
      }],
      has_more: false,
      next_after: 2
    })
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 2,
      events: [finished], promotedCommentaryIds: [], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(within(container).getByRole('button', { name: /Reasoning trace/ })).toHaveAccessibleName(
      'Reasoning trace. 1 tool. Show details.'
    )
    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))

    await waitFor(() => expect(loadTrace).toHaveBeenCalledTimes(1))
    expect(container.querySelectorAll('.tool-event')).toHaveLength(1)
    expect(within(container).getByRole('button', { name: /Reasoning trace/ })).toHaveAccessibleName(
      'Reasoning trace. 1 tool. Hide details.'
    )
    expect(container.querySelector('.tool-event')).toHaveTextContent('legacy_execSuccess')
  })

  it.each(['codex', 'claude'] as const)('opens the complete %s summary as readable Markdown without repeating the clipped preview', backend => {
    const summaryText = `Inspecting ${'a'.repeat(1_400)}`
    const fullText = `**Renderer check**\n\n${summaryText}\n\n- Event order\n- Disclosure state`
    const event: Event = {
      id: 'long-thought', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', backend, text: fullText
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 1,
      events: [event], promotedCommentaryIds: [], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(container.querySelector('.trace-summary-preview')?.textContent?.length).toBeLessThanOrEqual(320)
    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))
    const reasoningToggle = container.querySelector<HTMLButtonElement>(backend === 'codex' ? '.codex-activity-line' : '.trace-reasoning-toggle')
    expect(reasoningToggle).not.toBeNull()
    expect(reasoningToggle?.getAttribute('aria-label')?.length).toBeLessThanOrEqual(250)
    if (backend === 'codex') {
      expect(reasoningToggle).toHaveAccessibleName('Renderer check')
      expect(reasoningToggle).not.toHaveTextContent('Thinking summary')
    } else {
      expect(container.querySelector('.trace-reasoning-preview')?.textContent?.length).toBeLessThanOrEqual(600)
      expect(reasoningToggle).toHaveAccessibleName('Thinking summary')
      expect(reasoningToggle).not.toHaveTextContent('Renderer check')
    }
    const body = container.querySelector('.trace-reasoning-body')!
    expect(body).toHaveTextContent(summaryText)
    expect(body.querySelector('strong')).toHaveTextContent('Renderer check')
    expect(within(body as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
    expect(body.querySelector('.markdown')).not.toHaveClass('compact')
    fireEvent.click(reasoningToggle!)
    expect(container.querySelector('.trace-reasoning-body')).not.toBeInTheDocument()
    expect(reasoningToggle).toHaveTextContent('Renderer check')
    if (backend === 'claude') expect(container.querySelector('.trace-reasoning-preview')).toHaveTextContent('…')
  })

  it('labels a saved partial summary while preserving its received text', () => {
    const item: TraceItem = {
      kind: 'trace', id: 'partial-trace', key: 'partial-trace', seq: 1, active: true,
      promotedCommentaryIds: [], events: [{ id: 'partial-summary', session_id: 'chat-1', seq: 1,
        type: 'reasoning_summary', ts: '2026-07-10T14:29:00Z', run_id: 'run-1', backend: 'codex',
        text: 'Received before the run stopped.', partial: true }]
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))
    expect(container.querySelector('.trace-reasoning')).toHaveTextContent('Partial thinking summary')
    expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Received before the run stopped.')
  })

  it('loads every completed trace page on demand and can fold back to the sampled trace', async () => {
    loadTrace
      .mockResolvedValueOnce({
        events: [{
          id: 'thought-early', session_id: 'chat-1', seq: 11, type: 'reasoning_summary',
          ts: '2026-07-10T14:27:00Z', run_id: 'run-1', text: 'Early detailed thought.'
        }],
        has_more: true,
        next_after: 20
      })
      .mockResolvedValueOnce({
        events: [{
          id: 'thought-middle', session_id: 'chat-1', seq: 25, type: 'reasoning_summary',
          ts: '2026-07-10T14:28:00Z', run_id: 'run-1', text: 'Middle detailed thought.'
        }],
        has_more: false,
        next_after: 30
      })
    const sampled: Event = {
      id: 'thought-sampled', session_id: 'chat-1', seq: 30, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Latest sampled thought.'
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 30, events: [sampled], promotedCommentaryIds: [], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))

    await waitFor(() => expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Early detailed thought.'))
    expect(loadTrace).toHaveBeenNthCalledWith(1, 'chat-1', 'run-1', 30, 0)

    fireEvent.click(within(container).getByRole('button', { name: 'Load more activity' }))

    await waitFor(() => expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Middle detailed thought.'))
    expect(loadTrace).toHaveBeenNthCalledWith(2, 'chat-1', 'run-1', 30, 20)
    await waitFor(() => expect(within(container).getByRole('button', { name: 'Use compact trace' })).toBeEnabled())

    fireEvent.click(within(container).getByRole('button', { name: 'Use compact trace' }))

    expect(container.querySelector('.trace-reasoning-body')).not.toHaveTextContent('Early detailed thought.')
    expect(container.querySelector('.trace-reasoning-body')).not.toHaveTextContent('Middle detailed thought.')
    expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Latest sampled thought.')
  })

  it('does not duplicate promoted steer commentary when a retired trace is expanded', async () => {
    loadTrace.mockResolvedValueOnce({
      events: [{
        id: 'commentary-promoted', session_id: 'chat-1', seq: 20, type: 'reasoning_summary',
        ts: '2026-07-10T14:28:00Z', run_id: 'run-1', phase: 'commentary',
        text: 'This commentary is already a normal assistant message.'
      }, {
        id: 'thought-detail', session_id: 'chat-1', seq: 25, type: 'reasoning_summary',
        ts: '2026-07-10T14:28:30Z', run_id: 'run-1',
        text: 'Private trace detail remains available.'
      }],
      has_more: false,
      next_after: 30
    })
    const sampled: Event = {
      id: 'thought-sampled', session_id: 'chat-1', seq: 30, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Latest sampled thought.'
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 30, events: [sampled],
      promotedCommentaryIds: ['commentary-promoted'], active: false
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))

    await waitFor(() => expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Private trace detail remains available.'))
    expect(container).not.toHaveTextContent('This commentary is already a normal assistant message.')
  })

  it('does not reintroduce live assistant commentary from a remotely loaded trace page', async () => {
    loadTrace.mockResolvedValueOnce({
      events: [{
        id: 'commentary-remote', session_id: 'chat-1', seq: 20, type: 'reasoning_summary',
        ts: '2026-07-10T14:28:00Z', run_id: 'run-1', phase: 'commentary',
        text: 'This update already appears in the assistant surface.'
      }, {
        id: 'thought-remote', session_id: 'chat-1', seq: 25, type: 'reasoning_summary',
        ts: '2026-07-10T14:28:30Z', run_id: 'run-1', text: 'Private trace detail.'
      }],
      has_more: false,
      next_after: 30
    })
    const sampled: Event = {
      id: 'thought-sampled', session_id: 'chat-1', seq: 30, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Latest sampled thought.'
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 30, events: [sampled],
      promotedCommentaryIds: [], active: true
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))

    await waitFor(() => expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Private trace detail.'))
    expect(container).not.toHaveTextContent('This update already appears in the assistant surface.')
  })

  it('loads the available durable trace while a live turn is still streaming', async () => {
    const thought: Event = {
      id: 'thought-live', session_id: 'chat-1', seq: 30, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: '**Live detailed thought.**\n\nThe second line remains readable.'
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 30, events: [thought], promotedCommentaryIds: [], active: true
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const toggle = within(container).getByRole('button', { name: /Reasoning trace/ })
    expect(toggle).toHaveAccessibleName('Reasoning trace. 1 thinking summary. Show details.')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls')
    expect(container.querySelector('.trace-summary-preview')).toHaveTextContent('Live detailed thought. The second line remains readable.')
    expect(container.querySelector('.trace-summary-preview')).not.toHaveTextContent('**')
    fireEvent.click(toggle)

    expect(toggle).toHaveAccessibleName('Reasoning trace. 1 thinking summary. Hide details.')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const thoughtToggle = within(container).getByRole('button', { name: 'Thinking summary' })
    expect(thoughtToggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(container).getByText('Live detailed thought.')).toBeVisible()
    expect(within(container).getByText('The second line remains readable.')).toBeVisible()
    const details = within(container).getByRole('region', { name: 'Reasoning and tool details' })
    await waitFor(() => expect(details).toHaveAttribute('aria-busy', 'false'))
    await waitFor(() => expect(loadTrace).toHaveBeenCalledWith('chat-1', 'run-1', 30, 0))
    expect(within(container).getByRole('button', { name: 'Check for newer activity' })).toBeEnabled()
  })

  it('keeps active trace loading retryable after a snapshot error', async () => {
    loadTrace.mockRejectedValueOnce(new Error('Trace snapshot was unavailable'))
    const thought: Event = {
      id: 'thought-live', session_id: 'chat-1', seq: 30, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', text: 'Live detailed thought.'
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 30, events: [thought], promotedCommentaryIds: [], active: true
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))
    const load = within(container).getByRole('button', { name: 'Load available activity' })
    fireEvent.click(load)

    expect(await within(container).findByRole('alert')).toHaveTextContent('Trace snapshot was unavailable')
    expect(load).toBeEnabled()
    fireEvent.click(load)
    await waitFor(() => expect(loadTrace).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(container).queryByRole('alert')).not.toBeInTheDocument())
  })

  it.each(['trace', 'progress'] as const)('defers legacy diff extraction until %s is expanded and retains the discovered summary after collapse', kind => {
    const toolResult: Event = {
      id: 'tool-result', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', tool: { name: 'exec' }
    }
    let outputReads = 0
    Object.defineProperty(toolResult, 'output', {
      configurable: true,
      get: () => {
        outputReads++
        return 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new'
      }
    })
    const item: TraceItem | ProgressItem = {
      kind, id: 'trace-1', key: 'trace-1', seq: 1, events: [toolResult], promotedCommentaryIds: [], active: false
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(outputReads).toBe(0)
    expect(within(container).queryByRole('button', { name: /Edited 1 file/ })).not.toBeInTheDocument()

    const toggle = container.querySelector<HTMLButtonElement>('.trace-summary, .run-activity-summary')!
    fireEvent.click(toggle)

    expect(outputReads).toBeGreaterThan(0)
    expect(within(container).getByRole('button', { name: /Edited 1 file/ })).toBeInTheDocument()
    const expandedReads = outputReads
    fireEvent.click(toggle)
    expect(outputReads).toBe(expandedReads)
    expect(within(container).getAllByRole('button', { name: /Edited 1 file/ })).toHaveLength(1)
    expect(container.querySelector('.changes-file-name')).toHaveTextContent('app.ts')
    expect(container.querySelector('.trace-details')).not.toBeInTheDocument()
  })

  it.each(['trace', 'progress'] as const)('shows structured Codex changes in collapsed %s and opens their review without reading legacy output', kind => {
    const toolResult: Event = {
      id: 'tool-result', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', tool_id: 'patch-1',
      tool: {
        id: 'patch-1', name: 'apply_patch', input: {
          changes: [{
            path: '/Volumes/Dev/agi/ZenithDock-worktree/src/app.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra'
          }]
        }
      }
    }
    let outputReads = 0
    Object.defineProperty(toolResult, 'output', {
      configurable: true,
      get: () => {
        outputReads++
        return 'unrelated output'
      }
    })
    const item: TraceItem | ProgressItem = {
      kind, id: 'trace-1', key: 'trace-1', seq: 1, events: [toolResult], promotedCommentaryIds: [], active: false
    }
    const onReview = vi.fn()
    const listener: EventListener = event => onReview((event as CustomEvent).detail)
    window.addEventListener('agentsdock:review-diff', listener)
    try {
      const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

      const reviewButton = within(container).getByRole('button', { name: /Edited 1 file/ })
      expect(reviewButton).toHaveTextContent('+2')
      expect(reviewButton).toHaveTextContent('-1')
      expect(reviewButton).toHaveTextContent('app.ts')
      expect(container.querySelector('.trace-details')).not.toBeInTheDocument()
      expect(outputReads).toBe(0)

      fireEvent.click(reviewButton)

      expect(outputReads).toBe(1)
      expect(onReview).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'chat-1',
        runId: undefined,
        source: expect.stringContaining('*** Update File: /Volumes/Dev/agi/ZenithDock-worktree/src/app.ts'),
        additions: 2,
        deletions: 1
      }))
    } finally {
      window.removeEventListener('agentsdock:review-diff', listener)
    }
  })

  it('shows a canonical diff while collapsed without inspecting legacy tool output', () => {
    const toolResult: Event = {
      id: 'tool-result', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', tool: { name: 'exec' }
    }
    let outputReads = 0
    Object.defineProperty(toolResult, 'output', {
      configurable: true,
      get: () => {
        outputReads++
        return 'diff --git a/legacy.ts b/legacy.ts'
      }
    })
    const canonicalDiff: Event = {
      id: 'code-diff', session_id: 'chat-1', seq: 2, type: 'code_diff',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-1', files_changed: 2,
      additions: 7, deletions: 3, diff_files: [
        { path: 'src/app.ts', additions: 5, deletions: 2 },
        { path: 'src/app.test.ts', additions: 2, deletions: 1 }
      ]
    }
    const item: TraceItem = {
      kind: 'trace', id: 'trace-1', key: 'trace-1', seq: 1, events: [toolResult, canonicalDiff], promotedCommentaryIds: [], active: false
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(within(container).getByRole('button', { name: /Edited 2 files/ })).toBeInTheDocument()
    expect(outputReads).toBe(0)

    fireEvent.click(within(container).getByRole('button', { name: /1 tool/ }))

    expect(outputReads).toBe(1)
  })

  it('keeps one bounded canonical change summary outside completed progress and opens Review while collapsed', () => {
    const output = vi.fn(() => 'unrelated legacy output')
    const tool: Event = {
      id: 'tool', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', tool: { name: 'exec' }
    }
    Object.defineProperty(tool, 'output', { get: output })
    const canonicalDiff: Event = {
      id: 'diff', session_id: 'chat-1', seq: 2, type: 'code_diff',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-1', files_changed: 5,
      additions: 12, deletions: 4, repository_root: '/workspace',
      diff_files: Array.from({ length: 5 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: 1, deletions: 0 }))
    }
    const item: ProgressItem = {
      kind: 'progress', id: 'activity', key: 'activity', seq: 1, events: [tool, canonicalDiff],
      active: false, hasFinalResponse: true, startedAt: tool.ts, finishedAt: canonicalDiff.ts
    }
    const review = vi.fn()
    const listener: EventListener = event => review((event as CustomEvent).detail)
    window.addEventListener('agentsdock:review-diff', listener)
    try {
      const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
      const toggle = within(container).getByRole('button', { name: 'Worked for 1m 0s' })
      const card = within(container).getByRole('button', { name: /Edited 5 files.*Review/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelector('.trace-details')).not.toBeInTheDocument()
      expect(card).toHaveTextContent('+12')
      expect(card).toHaveTextContent('-4')
      expect(card.querySelectorAll('.changes-file-name')).toHaveLength(3)
      expect(card.querySelector('.changes-file-remaining')).toHaveTextContent('+2')
      expect(within(card).getByText('file-0.ts')).toHaveAttribute('title', 'src/file-0.ts')
      fireEvent.click(card)
      expect(output).not.toHaveBeenCalled()
      expect(review).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'chat-1', runId: 'run-1', files: canonicalDiff.diff_files,
        additions: 12, deletions: 4, repositoryRoot: '/workspace'
      }))
      fireEvent.click(toggle)
      expect(container.querySelector('.trace-details')).not.toContainElement(card)
      expect(container.querySelectorAll('.changes-card')).toHaveLength(1)
      fireEvent.click(toggle)
      expect(card).toBeVisible()
      expect(container.querySelectorAll('.changes-card')).toHaveLength(1)
    } finally {
      window.removeEventListener('agentsdock:review-diff', listener)
    }
  })

  it('retains known filenames and counts when live activity completes without collapsing', () => {
    const readDiff = vi.fn(() => '@@ -1 +1,2 @@\n-old\n+new\n+extra')
    const change = { path: 'src/app.ts', kind: 'update' }
    Object.defineProperty(change, 'diff', { get: readDiff })
    const tool: Event = {
      id: 'patch', session_id: 'chat-1', seq: 1, type: 'tool_finished',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-1', tool: { name: 'apply_patch', input: { changes: [change] } }
    }
    const live: ProgressItem = {
      kind: 'progress', id: 'activity', key: 'activity', seq: 1, events: [tool], active: true, startedAt: tool.ts
    }
    const row = (item: ProgressItem) => <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    const { container, rerender } = render(row(live))
    const reads = readDiff.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    rerender(row({ ...live, active: false, hasFinalResponse: true, finishedAt: '2026-07-10T14:30:00Z' }))
    expect(within(container).getByRole('button', { name: 'Worked for 1m 0s' })).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.trace-details')).toBeInTheDocument()
    const card = within(container).getByRole('button', { name: /Edited 1 file.*Review/ })
    expect(card).toHaveTextContent('app.ts')
    expect(card).toHaveTextContent('+2')
    expect(card).toHaveTextContent('-1')
    expect(readDiff).toHaveBeenCalledTimes(reads)
  })

  it('shows a scheduled run change summary once when its nested trace opens', () => {
    const diff: Event = {
      id: 'job-diff', session_id: 'chat-1', seq: 1, type: 'code_diff',
      ts: '2026-07-10T14:29:00Z', run_id: 'job-run', job_id: 'job-1',
      files_changed: 1, additions: 2, deletions: 1,
      diff_files: [{ path: 'src/job.ts', additions: 2, deletions: 1 }]
    }
    const latest: Event = {
      id: 'job-finished', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run', job_id: 'job-1', result_text: 'Updated the scheduled check.'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 2, title: 'Scheduled check',
      events: [diff, latest], latest, eventCount: 2, runCount: 1, startSeq: 1, endSeq: 2
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(within(container).getAllByRole('button', { name: /Edited 1 file.*Review/ })).toHaveLength(1)
    expect(container.querySelector('.changes-card')).toHaveTextContent('job.ts')
    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))
    expect(within(container).getAllByRole('button', { name: /Edited 1 file.*Review/ })).toHaveLength(1)
  })

  it('keeps current job changes visible beside a retained previous-run result', () => {
    const previousDiff: Event = {
      id: 'old-diff', session_id: 'chat-1', seq: 1, type: 'code_diff',
      ts: '2026-07-10T14:29:00Z', run_id: 'old-run', job_id: 'job-1',
      files_changed: 1, diff_files: [{ path: 'previous.ts', additions: 1, deletions: 0 }]
    }
    const latest: Event = {
      id: 'old-finished', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'old-run', job_id: 'job-1', result_text: 'Previous result.'
    }
    const running: Event = {
      ...latest, id: 'current-start', seq: 3, type: 'turn_started', run_id: 'current-run', result_text: undefined
    }
    const currentDiff: Event = {
      ...previousDiff, id: 'current-diff', seq: 4, run_id: 'current-run', diff_files: [{ path: 'current.ts', additions: 2, deletions: 1 }]
    }
    const summary: Event = { ...latest, id: 'job-summary', seq: 5, type: 'job_summary', job_status: 'running' }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 5, title: 'Scheduled check',
      events: [previousDiff, latest, running, currentDiff, summary], latest: summary, latestStatus: running,
      eventCount: 5, runCount: 2, startSeq: 1, endSeq: 5
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(within(container).getAllByRole('button', { name: /Edited 1 file.*Review/ })).toHaveLength(2)
    expect(container.querySelector('.job-run-trace .changes-card')).toHaveTextContent('current.ts')
    expect(within(container).getByRole('button', { name: /Edited 1 file.*previous.ts/ })).toBeVisible()
  })

  it('labels retained output as history when the scheduled job no longer exists', () => {
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-2', job_id: 'job-1',
      result_text: 'Latest scheduled result'
    }
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Previous scheduled result'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [previous, latest], latest,
      eventCount: 2, runCount: 2, startSeq: 2, endSeq: 3
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Scheduled Job')).toBeInTheDocument()
    expect(screen.getByText(/schedule no longer exists/)).toBeInTheDocument()
    expect(document.querySelector('.job-row')).toHaveClass('historical')
    expect(document.querySelector('.job-row')).toHaveAttribute('data-job-state', 'historical')
    expect(screen.queryByText('Previous scheduled result')).not.toBeInTheDocument()
    expect(screen.getByText('Latest scheduled result')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(document.querySelector('.job-latest')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Job Run History/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous runs 1' }))
    expect(screen.getByText('Previous scheduled result')).toBeInTheDocument()
  })

  it('uses a neutral scheduled-job label for live cards', () => {
    useAppStore.setState({
      jobs: [{
        id: 'job-1', session_id: 'chat-1', title: 'Workspace health', prompt: 'Check it',
        interval_seconds: 3600, enabled: true
      }]
    })
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Latest scheduled result'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [latest], latest,
      eventCount: 1, runCount: 1, startSeq: 3, endSeq: 3
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Scheduled Job')).toBeInTheDocument()
    expect(screen.queryByText(/schedule no longer exists/)).not.toBeInTheDocument()
    expect(document.querySelector('.job-row')).not.toHaveClass('historical')
    expect(document.querySelector('.job-row')).toHaveAttribute('data-job-state', 'scheduled')
  })

  it('keeps a runless deferral compact and moves the retained result into run history', () => {
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Previous scheduled result with a very large report'
    }
    const deferred: Event = {
      id: 'job-deferred', session_id: 'chat-1', seq: 3, type: 'job_deferred',
      ts: '2026-07-10T14:31:00Z', job_id: 'job-1',
      message: 'Scheduled job deferred: this chat is busy'
    }
    const summary: Event = {
      id: 'job-summary', session_id: 'chat-1', seq: 4, type: 'job_summary',
      ts: '2026-07-10T14:31:00Z', job_id: 'job-1',
      result_text: previous.result_text,
      message: deferred.message,
      job_status: 'deferred', job_status_type: 'job_deferred',
      job_latest_run_id: 'job-run-1'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 4,
      title: 'Workspace health', events: [previous, deferred, summary], latest: summary,
      latestStatus: summary, eventCount: 3, runCount: 1, startSeq: 2, endSeq: 4
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(within(container).getByText('Deferred')).toBeVisible()
    expect(within(container).getByText('Scheduled job deferred: this chat is busy')).toBeVisible()
    expect(within(container).queryByText(previous.result_text!)).not.toBeInTheDocument()

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))
    expect(within(container).getByText(previous.result_text!)).toBeInTheDocument()
  })

  it('does not count repeated runless deferrals as previous executions', () => {
    const deferrals = Array.from({ length: 64 }, (_, index): Event => ({
      id: `job-deferred-${index + 1}`,
      session_id: 'chat-1',
      seq: index + 1,
      type: 'job_deferred',
      ts: `2026-07-10T14:${String(index % 60).padStart(2, '0')}:00Z`,
      job_id: 'job-1',
      message: 'Scheduled job deferred: this chat is busy'
    }))
    const latest = deferrals.at(-1)!
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: latest.seq,
      title: 'Workspace health', events: deferrals, latest,
      latestStatus: latest, eventCount: deferrals.length, runCount: 0,
      startSeq: 1, endSeq: latest.seq
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(container.querySelector('.job-summary small')).toHaveTextContent('Workspace health · schedule no longer exists · 0 runs')
    expect(within(container).queryByRole('button', { name: /Previous runs/ })).not.toBeInTheDocument()
  })

  it('uses authoritative lazy history without duplicating its bundled runless status', async () => {
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 10, type: 'turn_finished',
      ts: '2026-07-10T14:10:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'Previous scheduled result'
    }
    const deferred: Event = {
      id: 'job-deferred', session_id: 'chat-1', seq: 20, type: 'job_deferred',
      ts: '2026-07-10T14:20:00Z', job_id: 'job-1',
      message: 'Scheduled job deferred: this chat is busy'
    }
    const indexedDeferred: Event = {
      ...deferred,
      id: 'job_run:status:job-1:occurrence:scheduled:1775000000'
    }
    loadJobRuns.mockResolvedValue({
      runs: [indexedDeferred, previous],
      total: 2,
      has_more: false,
      next_before: null,
      supported: true
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: deferred.seq,
      title: 'Workspace health', events: [previous, deferred], latest: deferred,
      latestStatus: deferred, eventCount: 3, runCount: 1,
      startSeq: 1, endSeq: deferred.seq
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))

    expect(await within(container).findByText('Previous scheduled result')).toBeVisible()
    await waitFor(() => expect(container.querySelectorAll('.job-history-run')).toHaveLength(1))
    expect(within(container).getAllByText(deferred.message!)).toHaveLength(1)
  })

  it('marks a force-steered scheduled run cancelled and unlocks its retained trace', async () => {
    const reasoning: Event = {
      id: 'job-reasoning', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'job-run', job_id: 'job-1',
      purpose: 'scheduled_job', phase: 'commentary', text: 'Checking the current status.'
    }
    const tool: Event = {
      id: 'job-tool', session_id: 'chat-1', seq: 3, type: 'tool_started',
      ts: '2026-07-10T14:29:30Z', run_id: 'job-run', job_id: 'job-1',
      purpose: 'scheduled_job', tool: { name: 'exec' }
    }
    const stopped: Event = {
      id: 'job-stopped', session_id: 'chat-1', seq: 4, type: 'turn_stopped',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run', job_id: 'job-1',
      purpose: 'scheduled_job', native_steer: true, superseded_by_run_id: 'user-run'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 4,
      title: 'Status check', events: [reasoning, tool, stopped], latest: stopped,
      latestStatus: stopped, eventCount: 3, runCount: 1, startSeq: 2, endSeq: 4
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(within(container).getByText('Cancelled')).toBeVisible()
    fireEvent.click(within(container).getByRole('button', { name: /1 tool/ }))
    expect(within(container).getAllByText('Checking the current status.')).toHaveLength(1)
    await waitFor(() => expect(loadTrace).toHaveBeenCalledWith('chat-1', 'job-run', 4, 0))
    await waitFor(() => expect(within(container).getByRole('button', { name: 'Check for newer activity' })).toBeEnabled())
  })

  it('shows a runner-finished stopped job as cancelled despite stale completed metadata', () => {
    const cancelled: Event = {
      id: 'job-cancelled', session_id: 'chat-1', seq: 4, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run', job_id: 'job-1',
      purpose: 'scheduled_job', stopped: true, job_status: 'completed',
      result_text: '{"status":"PENDING"}'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 4,
      title: 'Status check', events: [cancelled], latest: cancelled,
      latestStatus: cancelled, eventCount: 1, runCount: 1, startSeq: 4, endSeq: 4
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    const pill = container.querySelector('.job-status-pill')
    expect(pill).toHaveTextContent('Cancelled')
    expect(pill).toHaveClass('stopped')
    expect(pill).not.toHaveTextContent('Completed')
  })

  it('does not attach an earlier run diff to the latest scheduled result', () => {
    const previousDiff: Event = {
      id: 'job-previous-diff', session_id: 'chat-1', seq: 1, type: 'code_diff',
      ts: '2026-07-10T14:29:00Z', run_id: 'job-run-1',
      files_changed: 1, additions: 4, deletions: 1,
      diff_files: [{ path: 'src/old-change.ts', additions: 4, deletions: 1 }]
    }
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Previous scheduled result'
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-2', job_id: 'job-1',
      result_text: 'Latest scheduled result without a diff'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [previousDiff, previous, latest], latest,
      eventCount: 3, runCount: 2, startSeq: 1, endSeq: 3
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(within(container).getByText('Latest scheduled result without a diff')).toBeInTheDocument()
    expect(within(container).queryByRole('button', { name: /Edited 1 file/ })).not.toBeInTheDocument()
  })

  it('renders the full latest scheduled output instead of a truncated preview', () => {
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-2', job_id: 'job-1',
      result_text: 'Running the requested report now.\n\n## Capacity — latest\n\n| Pool | Free |\n|---|---:|\n| H100 | 42 |'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [latest], latest,
      eventCount: 1, runCount: 1, startSeq: 3, endSeq: 3
    }
    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Running the requested report now.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Capacity — latest' })).toBeInTheDocument()
  })

  it('summarizes structured job output and reveals pretty detail on demand', () => {
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-2', job_id: 'job-1',
      result_text: JSON.stringify({
        collector: 'bottle',
        collector_status: 'advanced',
        queue_status: 'completed',
        report_json: '/tmp/latest.json',
        status: 'COMPLETED'
      })
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [latest], latest,
      eventCount: 1, runCount: 1, startSeq: 3, endSeq: 3
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(screen.getByText('Status: COMPLETED · Queue: Completed · Collector: Bottle')).toBeVisible()
    expect(container.querySelector('.job-structured-detail')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))

    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.job-structured-detail')).toHaveTextContent('"report_json": "/tmp/latest.json"')
  })

  it('does not apply the generic long-message fold to the latest scheduled output', () => {
    const latestText = `Latest scheduled output\n\n${'x'.repeat(6_500)}`
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-2', job_id: 'job-1',
      result_text: latestText
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [latest], latest,
      eventCount: 1, runCount: 1, startSeq: 3, endSeq: 3
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('Latest scheduled output')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /characters hidden/ })).not.toBeInTheDocument()
    expect(container.querySelector('.job-latest')?.textContent).toContain('x'.repeat(6_500))
  })

  it('keeps previous scheduled-run output collapsed inside the one grouped timeline row', () => {
    const events = Array.from({ length: 9 }, (_, index): Event => ({
      id: `job-run-${index + 1}`, session_id: 'chat-1', seq: index + 1, type: 'turn_finished',
      ts: `2026-07-10T14:${String(20 + index).padStart(2, '0')}:00Z`,
      run_id: `run-${index + 1}`, job_id: 'job-1', result_text: `Scheduled result ${index + 1}`
    }))
    const latest = events.at(-1)!
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: latest.seq,
      title: 'Workspace health', events, latest,
      eventCount: events.length, runCount: events.length, startSeq: 1, endSeq: latest.seq
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(container.querySelectorAll('details')).toHaveLength(0)
    expect(within(container).queryByText('Scheduled result 1')).not.toBeInTheDocument()
    expect(within(container).queryByText('Scheduled result 8')).not.toBeInTheDocument()
    expect(within(container).getByText('Scheduled result 9')).toBeInTheDocument()

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 8' }))
    expect(container.querySelectorAll('.job-history-run')).toHaveLength(8)
    expect(within(container).getByText('Scheduled result 1')).toBeInTheDocument()
    expect(within(container).getByText('Scheduled result 8')).toBeInTheDocument()
  })

  it('shows recent scheduled runs and explains when an older server cannot load the rest', async () => {
    const events = Array.from({ length: 7 }, (_, index): Event => ({
      id: `job-run-${index + 6}`, session_id: 'chat-1', seq: index + 1, type: 'turn_finished',
      ts: `2026-07-10T14:${String(20 + index).padStart(2, '0')}:00Z`,
      run_id: `run-${index + 6}`, job_id: 'job-1', result_text: `Scheduled result ${index + 6}`
    }))
    const latest = events.at(-1)!
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: latest.seq,
      title: 'Workspace health', events, latest,
      eventCount: 60, runCount: 12, startSeq: 1, endSeq: latest.seq
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 11' }))
    expect(container.querySelectorAll('.job-history-run')).toHaveLength(6)
    expect(within(container).getByText('Scheduled result 12')).toBeInTheDocument()
    await waitFor(() => expect(within(container).getByText(/Update the server to load all 11 previous runs/)).toBeVisible())
  })

  it('loads older scheduled-run output lazily without adding timeline rows', async () => {
    const previous: Event = {
      id: 'job-run-2', session_id: 'chat-1', seq: 20, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-2', job_id: 'job-1',
      result_text: 'Recent bundled result'
    }
    const latest: Event = {
      id: 'job-run-3', session_id: 'chat-1', seq: 30, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-3', job_id: 'job-1',
      result_text: 'Latest result'
    }
    const older: Event = {
      id: 'job-run-1', session_id: 'chat-1', seq: 10, type: 'turn_finished',
      ts: '2026-07-10T14:10:00Z', run_id: 'run-1', job_id: 'job-1',
      result_text: 'Older lazy result'
    }
    loadJobRuns.mockResolvedValue({
      runs: [latest, previous, older],
      total: 3,
      has_more: false,
      next_before: null,
      timeline_group_id: 'job:job-1',
      supported: true
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: latest.seq,
      title: 'Workspace health', events: [previous, latest], latest,
      eventCount: 3, runCount: 3, startSeq: 10, endSeq: latest.seq
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 2' }))
    expect(within(container).getByText('Recent bundled result')).toBeVisible()
    expect(await within(container).findByText('Older lazy result')).toBeVisible()
    expect(loadJobRuns).toHaveBeenCalledWith('chat-1', 'job-1', 31, 20, 'job:job-1')
    expect(container.querySelectorAll('.job-row')).toHaveLength(1)
  })

  it('does not import lifetime history when a legacy server ignores the timeline group', async () => {
    const bundled: Event = {
      id: 'job-run-2', session_id: 'chat-1', seq: 20, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-2', job_id: 'job-1',
      result_text: 'This card bundled result'
    }
    const latest: Event = {
      id: 'job-run-3', session_id: 'chat-1', seq: 30, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-3', job_id: 'job-1',
      result_text: 'This card latest result'
    }
    loadJobRuns.mockResolvedValue({
      runs: [{
        id: 'job-run-from-earlier-card', session_id: 'chat-1', seq: 5, type: 'turn_finished',
        ts: '2026-07-10T14:05:00Z', run_id: 'run-old', job_id: 'job-1',
        result_text: 'Earlier card result'
      }],
      total: 50,
      has_more: false,
      next_before: null,
      // Old servers can report support for the endpoint while omitting the
      // timeline_group_id echo because they ignored that additive filter.
      supported: true
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1:segment:20', key: 'job:job-1:segment:20', seq: 20,
      jobId: 'job-1', timelineGroupId: 'job:job-1:segment:20',
      title: 'Workspace health', events: [bundled, latest], latest,
      eventCount: 2, runCount: 2, startSeq: 20, endSeq: 30
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))

    expect(within(container).getByText('This card bundled result')).toBeVisible()
    await waitFor(() => expect(loadJobRuns).toHaveBeenCalled())
    expect(within(container).queryByText('Earlier card result')).not.toBeInTheDocument()
  })

  it('resets lazy history when the authoritative timeline group changes', async () => {
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 20, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'Bundled previous result'
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 30, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-latest', job_id: 'job-1',
      result_text: 'Bundled latest result'
    }
    loadJobRuns
      .mockResolvedValueOnce({
        runs: [previous], total: 2, has_more: false, next_before: null,
        timeline_group_id: 'provisional-group', supported: true
      })
      .mockResolvedValueOnce({
        runs: [previous], total: 2, has_more: false, next_before: null,
        timeline_group_id: 'authoritative-group', supported: true
      })
    const base: JobItem = {
      kind: 'job', id: 'stable-card', key: 'stable-card', seq: 20,
      jobId: 'job-1', timelineGroupId: 'provisional-group',
      title: 'Workspace health', events: [previous, latest], latest,
      eventCount: 2, runCount: 2, startSeq: 20, endSeq: 30
    }
    const rendered = render(
      <TimelineRowView item={base} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(rendered.container).getByRole('button', { name: 'Previous runs 1' }))
    await waitFor(() => expect(loadJobRuns).toHaveBeenCalledWith(
      'chat-1', 'job-1', 31, 20, 'provisional-group'
    ))

    rendered.rerender(
      <TimelineRowView
        item={{ ...base, timelineGroupId: 'authoritative-group' }}
        sessionId="chat-1"
        onFindFile={() => {}}
        pinnedItemIds={new Set()}
      />
    )
    await waitFor(() => expect(
      within(rendered.container).getByRole('button', { name: 'Previous runs 1' })
    ).toHaveAttribute('aria-expanded', 'false'))
    fireEvent.click(within(rendered.container).getByRole('button', { name: 'Previous runs 1' }))

    await waitFor(() => expect(loadJobRuns).toHaveBeenLastCalledWith(
      'chat-1', 'job-1', 31, 20, 'authoritative-group'
    ))
    expect(loadJobRuns).toHaveBeenCalledTimes(2)
  })

  it('keeps the latest scheduled reasoning and tool trace inside the job card', () => {
    const thought: Event = {
      id: 'job-thought', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-1', job_id: 'job-1',
      text: 'Checking collector health'
    }
    const tool: Event = {
      id: 'job-tool', session_id: 'chat-1', seq: 3, type: 'tool_started',
      ts: '2026-07-10T14:30:01Z', run_id: 'run-1', job_id: 'job-1',
      tool: { name: 'collector_status' }
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 4, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'run-1', job_id: 'job-1',
      result_text: 'Collector complete'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 4,
      title: 'Collector', events: [thought, tool, latest], latest,
      eventCount: 3, runCount: 1, startSeq: 2, endSeq: 4
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(within(container).getByRole('button', { name: /1 tool/ })).toBeVisible()
    fireEvent.click(within(container).getByRole('button', { name: /1 tool/ }))
    expect(container.querySelector('.trace-reasoning-body')).toHaveTextContent('Checking collector health')
  })

  it('keeps loaded scheduled trace history when the same occurrence advances', async () => {
    const thought: Event = {
      id: 'job-thought', session_id: 'chat-1', seq: 2, type: 'reasoning_summary',
      ts: '2026-07-10T14:30:00Z', run_id: 'recycled-run', job_id: 'job-1',
      job_occurrence_id: 'occurrence-1', text: 'Current sampled thought'
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'recycled-run', job_id: 'job-1',
      job_occurrence_id: 'occurrence-1', result_text: 'Collector complete'
    }
    const later: Event = {
      id: 'job-later-thought', session_id: 'chat-1', seq: 4, type: 'reasoning_summary',
      ts: '2026-07-10T14:31:01Z', run_id: 'recycled-run', job_id: 'job-1',
      job_occurrence_id: 'occurrence-1', text: 'New streamed thought'
    }
    loadTrace.mockResolvedValueOnce({
      events: [{
        id: 'job-early-thought', session_id: 'chat-1', seq: 1, type: 'reasoning_summary',
        ts: '2026-07-10T14:29:00Z', run_id: 'recycled-run', job_id: 'job-1',
        job_occurrence_id: 'occurrence-1', text: 'Loaded earlier thought'
      }],
      has_more: false,
      next_after: 3
    })
    const job = (events: Event[], endSeq: number): JobItem => ({
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: endSeq,
      timelineGroupId: 'job-segment-1', title: 'Collector', events, latest,
      latestStatus: latest, eventCount: events.length, runCount: 1, startSeq: 1, endSeq
    })
    const rendered = render(
      <TimelineRowView item={job([thought, latest], 3)} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(rendered.container).getByRole('button', { name: /Reasoning trace/ }))
    fireEvent.click(within(rendered.container).getByRole('button', { name: 'Load available activity' }))
    await waitFor(() => expect(rendered.container.querySelector('.trace-reasoning-body')).toHaveTextContent('Loaded earlier thought'))

    rendered.rerender(
      <TimelineRowView item={job([thought, latest, later], 4)} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    expect(rendered.container.querySelector('.trace-reasoning-body')).toHaveTextContent('Loaded earlier thought')
    expect(rendered.container.querySelector('.trace-reasoning-body')).toHaveTextContent('New streamed thought')
    expect(within(rendered.container).getByRole('button', { name: 'Check for newer activity' })).toBeEnabled()
    expect(loadTrace).toHaveBeenCalledTimes(1)
  })

  it('shows the authoritative running status and loads its unanchored trace', async () => {
    const completed: Event = {
      id: 'job-completed', session_id: 'chat-1', seq: 90, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'Last completed output'
    }
    const running: Event = {
      id: 'job-summary', session_id: 'chat-1', seq: 100, type: 'job_summary',
      ts: '2026-07-10T14:30:00Z', job_id: 'job-1',
      result_text: 'Last completed output', job_status: 'running',
      job_status_run_id: 'run-current', job_run_count: 2
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 100,
      title: 'Collector', events: [completed, running], latest: running,
      latestStatus: running, eventCount: 10, runCount: 2,
      startSeq: 1, endSeq: 100
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(within(container).getByText('Running')).toBeVisible()
    expect(within(container).getByText('Last completed output')).toBeVisible()
    expect(within(container).queryByRole('button', { name: /Previous runs/ })).not.toBeInTheDocument()
    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))
    await waitFor(() => expect(loadTrace).toHaveBeenCalledWith(
      'chat-1',
      'run-current',
      0,
      0
    ))
  })

  it('keeps previous job outputs available while a newer run is active', async () => {
    const running: Event = {
      id: 'job-running', session_id: 'chat-1', seq: 100, type: 'job_ran',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-current', job_id: 'job-1',
      message: 'Scheduled job ran: Chaser status every 30 minutes',
      job_status: 'running', job_run_count: 3
    }
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 80, type: 'turn_finished',
      ts: '2026-07-10T14:00:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'Previous chaser output', status: 'completed'
    }
    const oldest: Event = {
      id: 'job-oldest', session_id: 'chat-1', seq: 60, type: 'turn_finished',
      ts: '2026-07-10T13:30:00Z', run_id: 'run-oldest', job_id: 'job-1',
      result_text: 'Oldest chaser output', status: 'completed'
    }
    loadJobRuns.mockResolvedValue({
      runs: [running, previous, oldest],
      total: 3,
      has_more: false,
      next_before: null,
      timeline_group_id: 'job:job-1',
      supported: true
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 100,
      title: 'Chaser status every 30 minutes', events: [running], latest: running,
      latestStatus: running, eventCount: 20, runCount: 3,
      startSeq: 60, endSeq: 100
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 2' }))

    expect(await within(container).findByText('Previous chaser output')).toBeVisible()
    expect(within(container).getByText('Oldest chaser output')).toBeVisible()
    expect(loadJobRuns).toHaveBeenCalledWith('chat-1', 'job-1', 101, 20, 'job:job-1')
  })

  it('keeps an older occurrence when the provider recycles the current run ID', async () => {
    const first: Event = {
      id: 'job_run:run:reused', session_id: 'chat-1', seq: 2, type: 'turn_finished',
      ts: '2026-07-10T14:00:00Z', run_id: 'reused', job_id: 'job-1',
      result_text: 'First recycled-ID output', job_run_status_seq: 2
    }
    const latest: Event = {
      id: 'job_run:run:reused:start-3', session_id: 'chat-1', seq: 4, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'reused', job_id: 'job-1',
      result_text: 'Second recycled-ID output', job_run_status_seq: 4
    }
    loadJobRuns.mockResolvedValue({
      runs: [latest, first], total: 2, has_more: false, next_before: null,
      timeline_group_id: 'job:job-1', supported: true
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 1,
      jobId: 'job-1', timelineGroupId: 'job:job-1',
      title: 'Recycled run monitor', events: [latest], displayUpdates: [latest], latest,
      latestStatus: latest, eventCount: 4, runCount: 2, startSeq: 1, endSeq: 4
    }
    const { container } = render(
      <TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />
    )

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))

    expect(await within(container).findByText('First recycled-ID output')).toBeVisible()
    expect(within(container).queryAllByText('Second recycled-ID output')).toHaveLength(1)
  })

  it('pages the current job trace from a real run event instead of a later runless summary', async () => {
    const thought: Event = {
      id: 'job-current-thought', session_id: 'chat-1', seq: 95, type: 'reasoning_summary',
      ts: '2026-07-10T14:29:00Z', run_id: 'run-current', job_id: 'job-1',
      text: 'Checking the current job'
    }
    const summary: Event = {
      id: 'job-summary', session_id: 'chat-1', seq: 100, type: 'job_summary',
      ts: '2026-07-10T14:30:00Z', job_id: 'job-1',
      result_text: 'Current job complete', job_status: 'completed',
      job_status_run_id: 'run-current', job_run_count: 1
    }
    loadTrace.mockResolvedValue({
      events: [thought],
      has_more: false,
      next_after: 95
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 100,
      title: 'Collector', events: [thought, summary], latest: summary,
      latestStatus: summary, eventCount: 2, runCount: 1,
      startSeq: 95, endSeq: 100
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: /Reasoning trace/ }))

    await waitFor(() => expect(loadTrace).toHaveBeenCalledWith(
      'chat-1',
      'run-current',
      95,
      0
    ))
  })

  it('lets a newer lifecycle event override stale structured output status', () => {
    const completed: Event = {
      id: 'job-completed', session_id: 'chat-1', seq: 90, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: '{"status":"completed","summary":"Previous monitor result"}'
    }
    const running: Event = {
      id: 'job-running', session_id: 'chat-1', seq: 100, type: 'turn_started',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-current', job_id: 'job-1'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 100,
      title: 'Collector', events: [completed, running], latest: completed,
      latestStatus: running, eventCount: 10, runCount: 2,
      startSeq: 1, endSeq: 100
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(within(container).getByText('Running')).toBeVisible()
    expect(within(container).queryByText('Completed')).not.toBeInTheDocument()
  })

  it('keeps distinct previous runs even when their output text is identical', () => {
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 20, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'No changes detected'
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 30, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-latest', job_id: 'job-1',
      result_text: 'No changes detected'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 30,
      title: 'Collector', events: [previous, latest], latest,
      latestStatus: latest, eventCount: 8, runCount: 2,
      startSeq: 1, endSeq: 30
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))
    expect(container.querySelectorAll('.job-history-run')).toHaveLength(1)
  })

  it('loads reasoning and tools on demand for an expanded previous run', async () => {
    const previous: Event = {
      id: 'job-previous', session_id: 'chat-1', seq: 20, type: 'turn_finished',
      ts: '2026-07-10T14:20:00Z', run_id: 'run-previous', job_id: 'job-1',
      result_text: 'Previous output', status: 'completed'
    }
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 30, type: 'turn_finished',
      ts: '2026-07-10T14:30:00Z', run_id: 'run-latest', job_id: 'job-1',
      result_text: 'Latest output', status: 'completed'
    }
    loadTrace.mockResolvedValue({
      events: [{
        id: 'previous-thought', session_id: 'chat-1', seq: 18,
        type: 'reasoning_summary', ts: '2026-07-10T14:19:00Z',
        run_id: 'run-previous', job_id: 'job-1',
        text: 'Reasoned through the previous run'
      }],
      has_more: false,
      next_after: 20
    })
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 30,
      title: 'Collector', events: [previous, latest], latest,
      latestStatus: latest, eventCount: 8, runCount: 2,
      startSeq: 1, endSeq: 30
    }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    fireEvent.click(within(container).getByRole('button', { name: 'Previous runs 1' }))
    const previousOutput = await within(container).findByText('Previous output')
    fireEvent.click(previousOutput)
    const previousRun = previousOutput.closest('details')
    expect(previousRun).not.toBeNull()
    fireEvent.click(await within(previousRun!).findByRole('button', { name: /Reasoning trace/ }))
    fireEvent.click(await within(previousRun!).findByRole('button', { name: 'Load available activity' }))

    await waitFor(() => expect(previousRun!.querySelector('.trace-reasoning-body')).toHaveTextContent('Reasoned through the previous run'))
    expect(loadTrace).toHaveBeenCalledWith('chat-1', 'run-previous', 20, 0)
  })

  it('does not render a job artifact explicitly owned by another chat', () => {
    const latest: Event = {
      id: 'job-latest', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Latest scheduled result'
    }
    const currentArtifact: Event = {
      id: 'current-artifact', session_id: 'chat-1', seq: 4, type: 'artifact_created',
      ts: '2026-07-10T14:31:01Z', run_id: 'job-run-1', job_id: 'job-1',
      artifact: {
        id: 'current-file', session_id: 'chat-1', filename: 'current.txt',
        content_type: 'text/plain'
      }
    }
    const foreignArtifact: Event = {
      id: 'foreign-artifact', session_id: 'chat-1', seq: 5, type: 'artifact_created',
      ts: '2026-07-10T14:31:02Z', run_id: 'job-run-1', job_id: 'job-1',
      artifact: {
        id: 'parent-file', session_id: 'parent-chat', filename: 'parent-secret.txt',
        content_type: 'text/plain'
      }
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 3,
      title: 'Workspace health', events: [latest, currentArtifact, foreignArtifact], latest,
      eventCount: 3, runCount: 1, startSeq: 3, endSeq: 5
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('current.txt')).toBeInTheDocument()
    expect(screen.queryByText('parent-secret.txt')).not.toBeInTheDocument()
  })

  it('retains the latest run artifact after a runless completion marker', () => {
    const result: Event = {
      id: 'job-result', session_id: 'chat-1', seq: 3, type: 'turn_finished',
      ts: '2026-07-10T14:31:00Z', run_id: 'job-run-1', job_id: 'job-1',
      result_text: 'Latest scheduled result'
    }
    const artifact: Event = {
      id: 'job-artifact', session_id: 'chat-1', seq: 4, type: 'artifact_created',
      ts: '2026-07-10T14:31:01Z', run_id: 'job-run-1', job_id: 'job-1',
      artifact: {
        id: 'current-file', session_id: 'chat-1', filename: 'current.txt',
        content_type: 'text/plain'
      }
    }
    const finished: Event = {
      id: 'job-finished', session_id: 'chat-1', seq: 5, type: 'job_finished',
      ts: '2026-07-10T14:31:02Z', job_id: 'job-1', message: 'Job complete'
    }
    const item: JobItem = {
      kind: 'job', id: 'job:job-1', key: 'job:job-1', seq: 5,
      title: 'Workspace health', events: [result, artifact, finished], latest: finished,
      latestStatus: finished, eventCount: 3, runCount: 1, startSeq: 3, endSeq: 5
    }

    render(<TimelineRowView item={item} sessionId="chat-1" onFindFile={() => {}} pinnedItemIds={new Set()} />)

    expect(screen.getByText('current.txt')).toBeInTheDocument()
  })
})

function exchangeFixture(): CrossChatExchange {
  return {
    id: 'exchange-1', status: 'active', initial_action: 'request_reply',
    requester_session_id: 'chat-1', responder_session_id: 'chat-2',
    authorization_source_run_id: 'run-source', max_legs: 6, used_legs: 1, remaining_legs: 5,
    active_leg_id: 'leg-1', error_code: null, error: null,
    expires_at: '2026-08-13T00:00:00Z', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
    legs: [{
      id: 'leg-1', exchange_id: 'exchange-1', parent_leg_id: null, ordinal: 1,
      kind: 'request', expects_reply: true, response_state: 'open', status: 'running',
      source_session_id: 'chat-1', source_run_id: 'run-source', target_session_id: 'chat-2', target_run_id: 'run-target',
      queued_id: null, body: 'Inspect the renderer carefully.', body_chars: 28, body_sha256: 'hash',
      error_code: null, error: null, created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z'
    }]
  }
}

function multiTurnLifecycleEvents(status: 'active' | 'completed'): Event[] {
  const previews = [
    'Opening question preview',
    'First follow-up preview',
    'Second follow-up preview',
    'Final answer preview'
  ]
  return [
    {
      id: 'multi-summary', session_id: 'chat-1', seq: 40,
      type: 'cross_chat_exchange_registered', ts: '2026-08-10T00:00:00Z',
      exchange_id: 'exchange-multi', exchange_status: 'active', exchange_initial_action: 'request_reply',
      exchange_max_legs: 6, exchange_used_legs: 1, exchange_remaining_legs: 5,
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      requester_title: 'Source', responder_title: 'Training'
    },
    ...previews.map((preview, index): Event => {
      const ordinal = index + 1
      const outgoing = ordinal % 2 === 1
      const final = ordinal === previews.length
      return {
        id: `multi-event-${ordinal}`, session_id: 'chat-1', seq: 40 + ordinal,
        type: final && status === 'active' ? 'cross_chat_exchange_leg_started' : 'cross_chat_exchange_leg_delivered',
        ts: `2026-08-10T00:00:0${ordinal}Z`,
        exchange_id: 'exchange-multi', exchange_leg_id: `multi-leg-${ordinal}`,
        exchange_status: final ? status : 'active',
        exchange_leg_status: final && status === 'active' ? 'running' : 'delivered',
        exchange_leg_kind: outgoing ? 'request' : 'reply',
        exchange_direction: outgoing ? 'outgoing' : 'incoming',
        exchange_expects_reply: final ? status === 'active' : true,
        exchange_ordinal: ordinal, exchange_max_legs: 6,
        exchange_used_legs: ordinal, exchange_remaining_legs: 6 - ordinal,
        source_session_id: outgoing ? 'chat-1' : 'chat-2',
        target_session_id: outgoing ? 'chat-2' : 'chat-1',
        source_title: outgoing ? 'Source' : 'Training',
        target_title: outgoing ? 'Training' : 'Source',
        handoff_preview: preview
      }
    })
  ]
}

function multiTurnExchangeFixture(): CrossChatExchange {
  const bodies = [
    'Complete opening question body.',
    'Complete first follow-up body.',
    'Complete second follow-up body.',
    'Complete final answer body.'
  ]
  const legs: CrossChatExchange['legs'] = bodies.map((body, index) => {
    const ordinal = index + 1
    const outgoing = ordinal % 2 === 1
    return {
      id: `multi-leg-${ordinal}`, exchange_id: 'exchange-multi',
      parent_leg_id: ordinal === 1 ? null : `multi-leg-${ordinal - 1}`, ordinal,
      kind: outgoing ? 'request' : 'reply', expects_reply: ordinal < bodies.length,
      response_state: ordinal < bodies.length ? 'closed' : 'closed', status: 'delivered',
      source_session_id: outgoing ? 'chat-1' : 'chat-2', source_run_id: `source-run-${ordinal}`,
      target_session_id: outgoing ? 'chat-2' : 'chat-1', target_run_id: `target-run-${ordinal}`,
      queued_id: null, body, body_chars: body.length, body_sha256: `hash-${ordinal}`,
      error_code: null, error: null, created_at: `2026-08-10T00:00:0${ordinal}Z`,
      updated_at: `2026-08-10T00:00:0${ordinal}Z`
    }
  })
  return {
    id: 'exchange-multi', status: 'completed', initial_action: 'request_reply',
    requester_session_id: 'chat-1', responder_session_id: 'chat-2',
    authorization_source_run_id: 'run-source', max_legs: 6, used_legs: 4, remaining_legs: 2,
    active_leg_id: null, error_code: null, error: null,
    expires_at: '2026-08-13T00:00:00Z', created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:04Z', legs
  }
}

function profileFixture(id: string, serverIdentity: string) {
  return {
    id, name: id, serverUrl: `http://${id}.test`, serverIdentity,
    hasAccessToken: true, serverSetupComplete: true,
    connectionState: 'online' as const, cachedUnreadCount: 0
  }
}
