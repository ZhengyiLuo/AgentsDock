import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CrossChatHandoff, Event, WorkspaceProfileScope } from '@shared/types'
import { projectTimeline, renderTimelineItems } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { TimelineRowView } from './TimelineRows'
import { setLocale } from '@shared/i18n'

const profileScope: WorkspaceProfileScope = { profileId: 'profile-a', profileGeneration: 0, serverIdentity: null }
const originalSelectSession = useAppStore.getState().selectSession
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

function messageRow(value: Event, prior: Event[] = []) {
  const item = renderTimelineItems(projectTimeline([...prior, value], []))[0]
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
  afterEach(() => useAppStore.setState({ selectSession: originalSelectSession }))
  afterEach(() => setLocale('en'))

  it('opens the exact sender or recipient chat only when its heading is clicked', async () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })
    useAppStore.setState({ sessions: [
      { id: 'sender', title: 'Renamed agent', backend: 'codex' },
      { id: 'recipient', title: 'Desktop agent', backend: 'codex' },
      { id: 'same-title-different-chat', title: 'Research agent', backend: 'codex' }
    ] })
    const view = render(messageRow(event()))
    fireEvent.click(screen.getByText('Review the keyboard behavior.'))
    expect(selectSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Research agent' }))
    expect(selectSession).toHaveBeenCalledExactlyOnceWith('sender')
    view.rerender(messageRow(event({ session_id: 'sender', type: 'chat_conversation_message_registered' })))
    fireEvent.click(screen.getByRole('button', { name: 'Sent to Desktop agent' }))
    expect(selectSession).toHaveBeenLastCalledWith('recipient')
    expect(getHandoff).not.toHaveBeenCalled()
    expect(getExchange).not.toHaveBeenCalled()
  })

  it('does not navigate stale server rows or guess a missing chat from its title', () => {
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })
    render(messageRow(event()))
    useAppStore.setState({ sessions: [{ id: 'wrong-id', title: 'Research agent', backend: 'codex' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Research agent' }))
    expect(selectSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBe('That chat is no longer available.')
    useAppStore.setState({ activeProfileId: 'another-profile', profileGeneration: 1,
      sessions: [{ id: 'sender', title: 'Research agent', backend: 'codex' }], error: null })
    fireEvent.click(screen.getByRole('button', { name: 'Research agent' }))
    expect(selectSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBeNull()
  })

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

  it('shows the recipient edited revision under the sender name without changing the original sender message', () => {
    const original = event({ type: 'chat_conversation_message_queued', handoff_preview: 'Sender original body.', message_revision: 0 })
    const edited = event({ id: 'edited-event', seq: 2, message_edited_by_user: true, message_revision: 1,
      handoff_preview: 'Recipient edited body.', handoff_body_chars: 22, handoff_body_truncated: false })
    const saved = structuredClone([original, edited])
    const view = render(messageRow(edited, [original]))
    expect(screen.getByText('Research agent')).toBeVisible()
    expect(screen.getByText('Edited by you')).toBeVisible()
    expect(screen.getByText('Recipient edited body.')).toBeVisible()
    expect(screen.queryByText('Sender original body.')).not.toBeInTheDocument()
    expect(view.container.querySelector('.message-row.user')).toBeNull()
    act(() => setLocale('zh-CN'))
    expect(screen.getByText('由你编辑')).toBeVisible()
    expect(screen.getByText('Research agent')).toBeVisible()
    act(() => setLocale('en'))
    view.rerender(messageRow(event({ session_id: 'sender', type: 'chat_conversation_message_registered',
      handoff_preview: 'Sender original body.' })))
    expect(screen.getByText('Sender original body.')).toBeVisible()
    expect(screen.queryByText('Edited by you')).not.toBeInTheDocument()
    expect([original, edited]).toEqual(saved)
    expect(getHandoff).not.toHaveBeenCalled()
  })

  it('discards an in-flight original full body when an edited recipient revision arrives', async () => {
    let resolve!: (value: CrossChatHandoff) => void
    getHandoff.mockReturnValue(new Promise<CrossChatHandoff>(done => { resolve = done }))
    const view = render(messageRow(event({ handoff_preview: 'Original preview…', handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await waitFor(() => expect(getHandoff).toHaveBeenCalledTimes(1))
    view.rerender(messageRow(event({ id: 'edited-event', seq: 2, message_edited_by_user: true, message_revision: 1,
      handoff_preview: 'Recipient edited body.', handoff_body_chars: 22, handoff_body_truncated: false })))
    await act(async () => resolve(handoff()))
    expect(screen.getByText('Recipient edited body.')).toBeVisible()
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
    expect(screen.queryByText('Original preview…')).not.toBeInTheDocument()
    expect(getHandoff).toHaveBeenCalledTimes(1)
  })

  it('loads only the matching edited full body for the recipient and invalidates its cached previous revision', async () => {
    getHandoff.mockResolvedValue(handoff({ target_body: 'Full edited recipient body, revision one.',
      message_edited_by_user: true, message_revision: 1 }))
    const edited = event({ message_edited_by_user: true, message_revision: 1,
      handoff_preview: 'Edited preview…', handoff_body_chars: 2000, handoff_body_truncated: true })
    const view = render(messageRow(edited))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByText('Full edited recipient body, revision one.')
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
    view.rerender(messageRow(event({ ...edited, id: 'revision-two', seq: 2, message_revision: 2,
      handoff_preview: 'New edited preview…' }), [edited]))
    expect(screen.getByText('New edited preview…')).toBeVisible()
    expect(screen.queryByText('Full edited recipient body, revision one.')).not.toBeInTheDocument()
    getHandoff.mockResolvedValue(handoff({ target_body: 'Full edited recipient body, revision two.',
      message_edited_by_user: true, message_revision: 2 }))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByText('Full edited recipient body, revision two.')
    expect(getHandoff).toHaveBeenCalledTimes(2)
  })

  it.each([
    {}, { target_body: 'Wrong revision body', message_edited_by_user: true, message_revision: 2 },
    { target_body: 'Unverified body', message_edited_by_user: false, message_revision: 1 },
    { message_edited_by_user: true, message_revision: 1 }
  ])('never falls back to the original body when edited detail metadata is missing or mismatched: %j', async patch => {
    getHandoff.mockResolvedValue(handoff(patch))
    render(messageRow(event({ message_edited_by_user: true, message_revision: 1,
      handoff_preview: 'Edited preview…', handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByRole('alert')
    expect(screen.getByText('Edited preview…')).toBeVisible()
    expect(screen.queryByText('The complete authenticated agent message.')).not.toBeInTheDocument()
  })

  it('keeps the sender full body original even when recipient edit metadata is present in detail', async () => {
    useAppStore.setState({ selectedSessionId: 'sender', chatPanes: { primary: 'sender', secondary: null } })
    getHandoff.mockResolvedValue(handoff({ target_body: 'Recipient-only edited body.',
      message_edited_by_user: true, message_revision: 1 }))
    render(messageRow(event({ session_id: 'sender', type: 'chat_conversation_message_registered',
      handoff_preview: 'Original preview…', handoff_body_truncated: true })))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    await screen.findByText('The complete authenticated agent message.')
    expect(screen.queryByText('Recipient-only edited body.')).not.toBeInTheDocument()
    expect(screen.queryByText('Edited by you')).not.toBeInTheDocument()
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
