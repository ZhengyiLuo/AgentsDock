import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import type { MessageItem } from '../lib/timeline'
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
})
