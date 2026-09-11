import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CrossChatHandoff, Event, WorkspaceProfileScope } from '@shared/types'
import { projectTimeline, renderTimelineItems } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'

const profileScope: WorkspaceProfileScope = { profileId: 'profile-a', profileGeneration: 0, serverIdentity: null }
const event = (patch: Partial<Event> = {}): Event => ({
  id: 'event-a', session_id: 'recipient', seq: 1, ts: '2026-09-10T10:00:00Z',
  type: 'chat_conversation_message_started', conversation_mode: 'async_route_v1',
  conversation_id: 'pair-a', message_id: 'message-a', handoff_id: 'message-a', cross_chat_envelope_id: 'message-a',
  source_session_id: 'sender', target_session_id: 'recipient', source_title: 'Research agent', target_title: 'Desktop agent',
  handoff_preview: 'Review the keyboard behavior.', handoff_status: 'running', handoff_action: 'instruction', ...patch
})
const handoff = (patch: Partial<CrossChatHandoff> = {}): CrossChatHandoff => ({
  id: 'message-a', kind: 'instruction', action: 'instruction', status: 'running',
  source_session_id: 'sender', source_run_id: 'source-run', target_session_id: 'recipient',
  conversation_mode: 'async_route_v1', conversation_id: 'pair-a', message_id: 'message-a',
  body: 'The complete authenticated agent message.', body_chars: 41, body_sha256: 'body-hash',
  created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z', ...patch
})

function messageRow(value: Event) {
  const item = renderTimelineItems(projectTimeline([value], []))[0]
  return <TimelineRowView item={item} sessionId={value.session_id} profileScope={profileScope} onFindFile={() => {}} pinnedItemIds={new Set()} />
}

describe('async agent message cards', () => {
  const getHandoff = vi.fn()
  const getExchange = vi.fn()
  beforeEach(() => {
    getHandoff.mockReset().mockResolvedValue(handoff())
    getExchange.mockReset()
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 0, selectedSessionId: 'recipient',
      connected: true, connectionGeneration: 1, health: { ok: true, server_instance_id: 'instance-a' },
      profiles: [], sessions: [{ id: 'sender', title: 'Renamed agent', backend: 'codex' }],
      chatPanes: { primary: 'recipient', secondary: null }, focusedChatPane: 'primary'
    })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      handoffs: { get: getHandoff }, exchanges: { get: getExchange }
    } as unknown as AgentsDockAPI })
  })
  afterEach(cleanup)

  it('shows received text on the right with the saved sender and outgoing text on the left', () => {
    const incoming = render(messageRow(event()))
    expect(incoming.container.querySelector('article')).toHaveClass('cross-chat-message', 'incoming')
    expect(screen.getByText('Research agent')).toBeVisible()
    expect(screen.getByText('Review the keyboard behavior.')).toBeVisible()
    expect(screen.queryByText('Renamed agent')).not.toBeInTheDocument()
    incoming.unmount()
    const outgoing = render(messageRow(event({ session_id: 'sender', type: 'chat_conversation_message_registered' })))
    expect(outgoing.container.querySelector('article')).toHaveClass('cross-chat-message', 'outgoing')
    expect(screen.getByText('Sent to Desktop agent')).toBeVisible()
    expect(getHandoff).not.toHaveBeenCalled()
    expect(getExchange).not.toHaveBeenCalled()
  })

  it('loads one full envelope only on demand, then reuses its body', async () => {
    render(messageRow(event({ handoff_preview: 'Short preview…', handoff_body_truncated: true, handoff_body_chars: 2000 })))
    expect(getHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByText('The complete authenticated agent message.')
    expect(getHandoff).toHaveBeenCalledExactlyOnceWith('message-a')
    expect(getExchange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByText('Short preview…')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    expect(screen.getByText('The complete authenticated agent message.')).toBeVisible()
    expect(getHandoff).toHaveBeenCalledTimes(1)
  })

  it.each([
    { id: 'another-envelope' }, { message_id: 'another-message' }, { message_id: undefined },
    { conversation_id: 'another-pair' }, { conversation_id: undefined }, { conversation_mode: undefined },
    { source_session_id: 'another-sender' }, { target_session_id: 'another-recipient' }
  ])('rejects a body response for a different envelope or participant: %j', async patch => {
    getHandoff.mockResolvedValue(handoff(patch))
    render(messageRow(event({ handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
  })

  it('discards a body response after the workspace profile changes', async () => {
    let resolve!: (value: CrossChatHandoff) => void
    getHandoff.mockReturnValue(new Promise<CrossChatHandoff>(done => { resolve = done }))
    render(messageRow(event({ handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(getHandoff).toHaveBeenCalledTimes(1))
    act(() => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 1 }))
    await act(async () => resolve(handoff()))
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
  })

  it('does not accept matching absent pair identities as a valid message body', async () => {
    getHandoff.mockResolvedValue(handoff({ conversation_id: undefined }))
    render(messageRow(event({ conversation_id: undefined, handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
  })
})
