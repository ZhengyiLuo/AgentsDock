import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import type { MessageItem, SystemItem } from '../lib/timeline'
import { TimelineRowView } from './TimelineRows'

describe('timeline pin state', () => {
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
    expect(screen.queryByText('ZenithDock Context Digest')).not.toBeInTheDocument()
  })
})
