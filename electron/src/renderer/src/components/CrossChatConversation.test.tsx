import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CrossChatExchange, CrossChatExchangeLeg, Event, WorkspaceProfileScope } from '@shared/types'
import type { SystemItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'

const profileScope: WorkspaceProfileScope = {
  profileId: 'profile-a', profileGeneration: 4, serverIdentity: 'server-a'
}

afterEach(cleanup)
const originalSelectSession = useAppStore.getState().selectSession
afterEach(() => useAppStore.setState({ selectSession: originalSelectSession }))

describe('cross-chat message lifecycle', () => {
  const loadExchange = vi.fn()

  beforeEach(() => {
    loadExchange.mockReset()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        exchanges: { get: loadExchange, cancel: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4, selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' }, focusedChatPane: 'primary',
      profiles: [{
        id: 'profile-a', name: 'Profile A', serverUrl: 'http://profile-a.test', serverIdentity: 'server-a',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-2', title: 'Reviewer', backend: 'claude' }
      ]
    })
  })

  it.each([
    { label: 'plain text and soft line breaks', text: 'Run on 20 episodes.\nOperator body: mean 0.06 degrees.', rendered: 'Run on 20 episodes.\nOperator body: mean 0.06 degrees.' },
    { label: 'adjacent Markdown and inline code', text: 'Run on **20** `episodes`.\n**Operator** `body`: mean **0.06** degrees.', rendered: 'Run on 20 episodes.\nOperator body: mean 0.06 degrees.' },
    { label: 'link boundaries', text: 'Run on [20 episodes](report.md).\nOperator [body](src/body.ts): mean 0.06 degrees.', rendered: 'Run on 20 episodes.\nOperator body: mean 0.06 degrees.' },
    { label: 'intentionally joined source text', text: 'Run on20episodes.\nOperatorbody:mean.0608641,max.7392861.', rendered: 'Run on20episodes.\nOperatorbody:mean.0608641,max.7392861.' }
  ])('preserves authored spacing in $label through cross-chat preview and expansion', ({ text, rendered }) => {
    const body = `${text}\n\n${'Detailed unchanged context. '.repeat(32)}Full message end.`
    const event: Event = {
      id: 'spacing-message', session_id: 'chat-1', seq: 10, ts: '2026-09-04T01:00:00Z',
      type: 'chat_conversation_message_registered', conversation_mode: 'async_route_v1',
      conversation_id: 'spacing-conversation', message_id: 'spacing-handoff', handoff_id: 'spacing-handoff',
      source_session_id: 'chat-1', target_session_id: 'chat-2', source_title: 'Source', target_title: 'Reviewer',
      handoff_preview: body, handoff_body_chars: body.length, handoff_body_truncated: false
    }
    const item: SystemItem = { kind: 'system', id: event.id, key: event.id, seq: event.seq, event, crossChatMessage: true }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" profileScope={profileScope} onFindFile={() => {}} pinnedItemIds={new Set()} />)
    const paragraph = () => container.querySelector('.cross-chat-message .markdown p')
    expect(paragraph()?.textContent).toBe(rendered)
    expect(container).not.toHaveTextContent('Full message end.')
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    expect(paragraph()?.textContent).toBe(rendered)
    expect(container).toHaveTextContent('Full message end.')
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(paragraph()?.textContent).toBe(rendered)
    expect(event.handoff_preview).toBe(body)
    expect(loadExchange).not.toHaveBeenCalled()
  })

  it('preserves explicit Markdown line breaks between cross-chat text and code spans', () => {
    const event: Event = {
      id: 'line-break-message', session_id: 'chat-1', seq: 10, ts: '2026-09-04T01:00:00Z',
      type: 'chat_conversation_message_registered', conversation_mode: 'async_route_v1',
      conversation_id: 'line-break-conversation', message_id: 'line-break-handoff',
      source_session_id: 'chat-1', target_session_id: 'chat-2', target_title: 'Reviewer',
      handoff_preview: 'Run on **20**  \nepisodes.\n\nOperator  \n`body`: mean 0.06 degrees.'
    }
    const item: SystemItem = { kind: 'system', id: event.id, key: event.id, seq: event.seq, event, crossChatMessage: true }
    const { container } = render(<TimelineRowView item={item} sessionId="chat-1" profileScope={profileScope} onFindFile={() => {}} pinnedItemIds={new Set()} />)
    expect(container.querySelectorAll('.cross-chat-message .markdown p')).toHaveLength(2)
    expect(container.querySelectorAll('.cross-chat-message .markdown br')).toHaveLength(2)
    expect(container.querySelector('.cross-chat-message code')).toHaveTextContent('body')
  })

  it.each(['cross_chat_exchange_leg_delivered', 'cross_chat_received'])('opens the exact peer from older %s headings without loading message details', type => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })
    const event: Event = { id: 'older-message', session_id: 'chat-1', seq: 10, ts: '2026-09-04T01:00:00Z', type,
      source_session_id: 'chat-2', target_session_id: 'chat-1', source_title: 'Reviewer', target_title: 'Source',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'completed',
      exchange_leg_status: 'delivered', exchange_leg_kind: 'reply', exchange_ordinal: 1,
      requester_session_id: 'chat-1', responder_session_id: 'chat-2', handoff_id: 'older-envelope', handoff_preview: 'Saved reply.' }
    const item: SystemItem = { kind: 'system', id: 'older-message', key: 'older-message', seq: 10, event }
    const props = { item, sessionId: 'chat-1', profileScope, onFindFile: () => {}, pinnedItemIds: new Set<string>() }
    const view = render(<TimelineRowView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }))
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('chat-2')
    view.rerender(<TimelineRowView {...props} sessionId="chat-2" />)
    fireEvent.click(screen.getByRole('button', { name: 'To Source' }))
    expect(selectSession).toHaveBeenLastCalledWith('chat-1')
    expect(loadExchange).not.toHaveBeenCalled()
  })

  it('loads exact leg bodies on demand, preserves them across pane focus, and settles controls at terminal state', async () => {
    const first: Event = {
      id: 'exchange-first', session_id: 'chat-1', seq: 10,
      type: 'cross_chat_exchange_leg_delivered', ts: '2026-09-04T01:00:00Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-1', exchange_status: 'active',
      exchange_leg_status: 'delivered', exchange_leg_kind: 'request', exchange_direction: 'outgoing',
      exchange_expects_reply: true, exchange_ordinal: 1, exchange_max_legs: 6,
      exchange_used_legs: 1, exchange_remaining_legs: 5,
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      source_session_id: 'chat-1', target_session_id: 'chat-2'
    }
    const returned: Event = {
      id: 'exchange-returned', session_id: 'chat-1', seq: 11,
      type: 'cross_chat_exchange_leg_started', ts: '2026-09-04T01:00:01Z',
      exchange_id: 'exchange-1', exchange_leg_id: 'leg-2', exchange_status: 'active',
      exchange_leg_status: 'running', exchange_leg_kind: 'request', exchange_direction: 'incoming',
      exchange_expects_reply: true, exchange_ordinal: 2, exchange_max_legs: 6,
      exchange_used_legs: 2, exchange_remaining_legs: 4,
      requester_session_id: 'chat-1', responder_session_id: 'chat-2',
      source_session_id: 'chat-2', target_session_id: 'chat-1'
    }
    const item: SystemItem = {
      kind: 'system', id: 'cross-chat-exchange:exchange-1', key: 'cross-chat-exchange:exchange-1',
      seq: 10, event: returned, events: [first, returned]
    }
    const props = {
      item, sessionId: 'chat-1', profileScope, onFindFile: () => {}, pinnedItemIds: new Set<string>()
    }
    const firstLeg = leg('leg-1', 1, 'chat-1', 'chat-2', 'delivered', 'First request body')
    const returnedLeg = leg('leg-2', 2, 'chat-2', 'chat-1', 'running', 'First reply and follow-up body')
    loadExchange.mockResolvedValueOnce(exchange([firstLeg, returnedLeg], 'leg-2'))
    const view = render(<TimelineRowView {...props} />)

    const message = (id: string) => view.container.querySelector(`[data-exchange-leg-id="${id}"]`) as HTMLElement
    const messageIds = () => [...view.container.querySelectorAll<HTMLElement>('.cross-chat-message')].map(row => row.dataset.exchangeLegId)
    expect(view.container.querySelector('.exchange-conversation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show full conversation' })).not.toBeInTheDocument()
    expect(messageIds()).toEqual(['leg-1', 'leg-2'])
    expect(message('leg-1')).toHaveClass('outgoing')
    expect(message('leg-2')).toHaveClass('incoming')
    expect(within(message('leg-2')).getByRole('status')).toHaveTextContent('Reply pending · Recipient processing')
    expect(within(message('leg-2')).getByRole('button', { name: 'End conversation' })).toBeEnabled()
    expect(within(message('leg-1')).queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
    expect(loadExchange).not.toHaveBeenCalled()

    fireEvent.click(within(message('leg-2')).getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(within(message('leg-2')).getByText(returnedLeg.body)).toBeInTheDocument())
    expect(within(message('leg-1')).getByText(firstLeg.body)).toBeInTheDocument()
    expect(loadExchange).toHaveBeenNthCalledWith(1, 'exchange-1')

    act(() => useAppStore.setState({ selectedSessionId: 'chat-2', focusedChatPane: 'secondary' }))
    expect(within(message('leg-2')).getByText(returnedLeg.body)).toBeInTheDocument()
    expect(message('leg-2')).toHaveClass('incoming')
    expect(loadExchange).toHaveBeenCalledTimes(1)

    const third: Event = {
      ...returned, id: 'exchange-third', seq: 12, exchange_leg_id: 'leg-3', exchange_direction: 'outgoing',
      exchange_ordinal: 3, exchange_used_legs: 3, exchange_remaining_legs: 3,
      source_session_id: 'chat-1', target_session_id: 'chat-2', handoff_preview: 'Second follow-up…',
      handoff_body_truncated: true, handoff_body_chars: 'Second follow-up full body'.length
    }
    const thirdLeg = leg('leg-3', 3, 'chat-1', 'chat-2', 'running', 'Second follow-up full body')
    loadExchange.mockResolvedValueOnce(exchange([firstLeg, { ...returnedLeg, status: 'delivered' }, thirdLeg], 'leg-3'))
    view.rerender(<TimelineRowView {...props} item={{ ...item, event: third, events: [first, returned, third] }} />)

    expect(messageIds()).toEqual(['leg-1', 'leg-2', 'leg-3'])
    expect(message('leg-3')).toHaveClass('outgoing')
    expect(within(message('leg-3')).getByRole('status')).toHaveTextContent('Reply pending · Recipient processing')
    expect(within(message('leg-3')).getByRole('button', { name: 'End conversation' })).toBeEnabled()
    expect(within(message('leg-2')).queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
    expect(within(message('leg-2')).getByText(returnedLeg.body)).toBeInTheDocument()
    expect(loadExchange).toHaveBeenCalledTimes(1)
    fireEvent.click(within(message('leg-3')).getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(within(message('leg-3')).getByText(thirdLeg.body)).toBeInTheDocument())
    expect(loadExchange).toHaveBeenCalledTimes(2)
    expect(loadExchange).toHaveBeenNthCalledWith(2, 'exchange-1')

    const completed: Event = {
      ...third, id: 'exchange-completed', seq: 13, type: 'cross_chat_exchange_completed',
      ts: '2026-09-04T01:00:03Z', exchange_leg_id: undefined, exchange_status: 'completed'
    }
    view.rerender(<TimelineRowView {...props} item={{ ...item, event: completed, events: [first, returned, third, completed] }} />)

    expect(screen.queryByText(/^Baton with /)).not.toBeInTheDocument()
    expect(within(message('leg-3')).getByRole('status')).toHaveTextContent('Completed')
    expect(screen.queryByRole('button', { name: 'End conversation' })).not.toBeInTheDocument()
    expect(messageIds()).toEqual(['leg-1', 'leg-2', 'leg-3'])
    expect(within(message('leg-1')).getByText(firstLeg.body)).toBeInTheDocument()
    expect(within(message('leg-2')).getByText(returnedLeg.body)).toBeInTheDocument()
    expect(within(message('leg-3')).getByText(thirdLeg.body)).toBeInTheDocument()
    expect(loadExchange).toHaveBeenCalledTimes(2)
  })
})

function leg(
  id: string,
  ordinal: number,
  source: string,
  target: string,
  status: CrossChatExchangeLeg['status'],
  body: string
): CrossChatExchangeLeg {
  return {
    id, exchange_id: 'exchange-1', parent_leg_id: ordinal === 1 ? null : `leg-${ordinal - 1}`,
    ordinal, kind: 'request', expects_reply: true, response_state: 'open', status,
    source_session_id: source, source_run_id: `run-${source}-${ordinal}`,
    target_session_id: target, target_run_id: status === 'running' ? `run-${target}-${ordinal}` : null,
    queued_id: null, body, body_chars: body.length, body_sha256: `hash-${ordinal}`,
    error_code: null, error: null, created_at: `2026-09-04T01:00:0${ordinal - 1}Z`,
    updated_at: `2026-09-04T01:00:0${ordinal}Z`
  }
}

function exchange(legs: CrossChatExchangeLeg[], activeLegId: string): CrossChatExchange {
  return {
    id: 'exchange-1', status: 'active', initial_action: 'request_reply',
    requester_session_id: 'chat-1', responder_session_id: 'chat-2', authorization_source_run_id: 'run-source',
    max_legs: 6, used_legs: legs.length, remaining_legs: 6 - legs.length, active_leg_id: activeLegId,
    error_code: null, error: null, expires_at: '2026-09-07T01:00:00Z',
    created_at: '2026-09-04T01:00:00Z', updated_at: '2026-09-04T01:00:03Z', legs
  }
}
