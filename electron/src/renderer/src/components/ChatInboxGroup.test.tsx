import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { projectTimeline, renderTimelineItems, type SystemItem } from '../lib/timeline'
import { useAppStore } from '../store/app-store'
import { ChatInboxGroup } from './ChatInboxGroup'

vi.mock('./MarkdownContent', () => ({ MarkdownContent: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(cleanup)
const scope = { profileId: 'profile', profileGeneration: 1, serverIdentity: null }
const events: Event[] = [1, 2].map(number => ({ id: `event-${number}`, seq: number, session_id: 'recipient',
  ts: '2026-09-11T12:00:00Z', type: 'chat_conversation_message_received', conversation_mode: 'async_route_v1',
  delivery_mode: 'mailbox', inbox_state: 'unread', conversation_id: 'pair', message_id: `message-${number}`,
  source_session_id: 'sender', source_title: 'Actual Sender', target_session_id: 'recipient',
  message_revision: 0, handoff_preview: `Preview ${number}`, handoff_body_truncated: true }))
const group = () => renderTimelineItems(projectTimeline(events, []))[0] as SystemItem
const list = vi.fn(), remove = vi.fn(), get = vi.fn()
beforeEach(() => {
  list.mockReset(); remove.mockReset(); get.mockReset()
  list.mockResolvedValue({ session_id: 'recipient', messages: [], next_cursor: '25', has_more: true,
    senders: [{ source_session_id: 'sender', source_title: 'Actual Sender', unread_count: 2 }] })
  useAppStore.setState({ activeProfileId: 'profile', profileGeneration: 1, profiles: [], selectedSessionId: 'recipient',
    health: { ok: true, capabilities: { cross_chat_handoffs_v1: { available: true, required: false, message: '', action: null, features: { chat_mailbox_v1: true } } } } })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { chatInbox: { list, remove }, handoffs: { get } } })
})

describe('sender-grouped chat inbox', () => {
  it('loads exact out-of-page message body on demand without acknowledging or starting a turn', async () => {
    get.mockResolvedValue({ id: 'message-1', message_id: 'message-1', source_session_id: 'sender', target_session_id: 'recipient',
      conversation_id: 'pair', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox', inbox_state: 'unread',
      message_revision: 0, body: 'Full original body and exact tail.' })
    render(<ChatInboxGroup item={group()} sessionId="recipient" profileScope={scope} />)
    expect(list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Actual Sender · 2 unread' }))
    await waitFor(() => expect(list).toHaveBeenCalledExactlyOnceWith(scope, 'recipient', null, 25))
    fireEvent.click(screen.getAllByRole('button', { name: 'View message' })[0])
    expect(await screen.findByText('Full original body and exact tail.')).toBeInTheDocument()
    expect(get).toHaveBeenCalledExactlyOnceWith('message-1')
    expect(screen.getByRole('button', { name: 'Actual Sender · 2 unread' })).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByText('Send now')).not.toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not delete another message on a mismatched receipt and never probes an older server', async () => {
    remove.mockResolvedValue({ ok: true, session_id: 'recipient', message_id: 'different-message', state: 'deleted' })
    const view = render(<ChatInboxGroup item={group()} sessionId="recipient" profileScope={scope} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actual Sender · 2 unread' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this message')
    expect(screen.getAllByRole('button', { name: 'Delete message' })).toHaveLength(2)
    expect(remove).toHaveBeenCalledExactlyOnceWith(scope, 'recipient', 'message-1')
    view.unmount(); list.mockClear()
    useAppStore.setState({ health: { ok: true } })
    render(<ChatInboxGroup item={group()} sessionId="recipient" profileScope={scope} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actual Sender · 2 unread' }))
    expect(list).not.toHaveBeenCalled()
    expect(screen.getByText('Update the server to manage inbox messages.')).toBeInTheDocument()
  })

  it('expands the exact edited recipient body rather than the immutable original source body', async () => {
    const body = 'Recipient-only edited message and exact tail.'
    const edited = { ...events[0], type: 'chat_conversation_message_mailbox_migrated', message_revision: 2,
      message_edited_by_user: true, handoff_body_sha256: bytesToHex(sha256(utf8ToBytes(body))) }
    const item = renderTimelineItems(projectTimeline([edited], []))[0] as SystemItem
    get.mockResolvedValue({ id: 'message-1', message_id: 'message-1', source_session_id: 'sender', target_session_id: 'recipient',
      conversation_id: 'pair', conversation_mode: 'async_route_v1', delivery_mode: 'mailbox', inbox_state: 'unread',
      message_revision: 2, message_edited_by_user: true, body: 'Immutable original source body.', target_body: body,
      body_sha256: bytesToHex(sha256(utf8ToBytes('Immutable original source body.'))) })
    render(<ChatInboxGroup item={item} sessionId="recipient" profileScope={scope} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actual Sender · 1 unread' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    expect(await screen.findByText(body)).toBeInTheDocument()
    expect(screen.queryByText('Immutable original source body.')).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledExactlyOnceWith('message-1')
  })
})
