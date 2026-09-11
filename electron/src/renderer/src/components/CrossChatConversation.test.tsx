import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('cross-chat conversation baton', () => {
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

  it('tracks baton ownership across live legs, refreshes the expanded transcript, and clears it at terminal state', async () => {
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

    expect(view.container.querySelector('.cross-chat-exchange-state')).toHaveTextContent('This chat is working')

    fireEvent.click(screen.getByRole('button', { name: 'Show full conversation' }))
    const conversation = screen.getByRole('list', { name: 'Agent conversation between Source and Reviewer' })
    await waitFor(() => expect(within(conversation).getByText('First reply and follow-up body')).toBeInTheDocument())

    useAppStore.setState({ selectedSessionId: 'chat-2', focusedChatPane: 'secondary' })
    expect(within(conversation).getByText('First reply and follow-up body')).toBeInTheDocument()
    expect(loadExchange).toHaveBeenCalledTimes(1)

    const third: Event = {
      ...returned, id: 'exchange-third', seq: 12, exchange_leg_id: 'leg-3', exchange_direction: 'outgoing',
      exchange_ordinal: 3, exchange_used_legs: 3, exchange_remaining_legs: 3,
      source_session_id: 'chat-1', target_session_id: 'chat-2', handoff_preview: 'Second follow-up preview'
    }
    const thirdLeg = leg('leg-3', 3, 'chat-1', 'chat-2', 'running', 'Second follow-up full body')
    loadExchange.mockResolvedValueOnce(exchange([firstLeg, { ...returnedLeg, status: 'delivered' }, thirdLeg], 'leg-3'))
    view.rerender(<TimelineRowView {...props} item={{ ...item, event: third, events: [first, returned, third] }} />)

    expect(view.container.querySelector('.cross-chat-exchange-state')).toHaveTextContent('Reviewer is working')
    await waitFor(() => expect(loadExchange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(conversation).getByText('Second follow-up full body')).toBeInTheDocument())

    const completed: Event = {
      ...third, id: 'exchange-completed', seq: 13, type: 'cross_chat_exchange_completed',
      ts: '2026-09-04T01:00:03Z', exchange_leg_id: undefined, exchange_status: 'completed'
    }
    const completedThirdLeg = leg('leg-3', 3, 'chat-1', 'chat-2', 'delivered', 'Final terminal body')
    loadExchange.mockResolvedValueOnce({
      ...exchange([firstLeg, { ...returnedLeg, status: 'delivered' }, completedThirdLeg], ''),
      status: 'completed', active_leg_id: null
    })
    view.rerender(<TimelineRowView {...props} item={{ ...item, event: completed, events: [first, returned, third, completed] }} />)

    expect(screen.queryByText(/^Baton with /)).not.toBeInTheDocument()
    expect(view.container.querySelector('.cross-chat-exchange-state')).toHaveTextContent('Completed')
    await waitFor(() => expect(loadExchange).toHaveBeenCalledTimes(3))
    expect(await within(conversation).findByText('Final terminal body')).toBeInTheDocument()
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
