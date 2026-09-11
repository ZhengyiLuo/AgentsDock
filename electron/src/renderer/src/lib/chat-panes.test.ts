import { describe, expect, it } from 'vitest'
import {
  closeChatPane, focusedChatSessionId, reconcileChatPaneLayout, selectChatInPane, swapChatPanes,
  visibleChatSessionIds, type ChatPaneLayout
} from './chat-panes'

const split: ChatPaneLayout = {
  panes: { primary: 'chat-a', secondary: 'chat-b' },
  focusedPane: 'secondary'
}

describe('chat pane layout', () => {
  it('keeps session IDs distinct and focuses an already visible chat', () => {
    expect(selectChatInPane(split, 'chat-a', 'secondary')).toEqual({
      panes: split.panes,
      focusedPane: 'primary'
    })
    expect(visibleChatSessionIds({ primary: 'chat-a', secondary: 'chat-a' })).toEqual(['chat-a'])
  })

  it('promotes the secondary chat when the primary pane closes', () => {
    const closed = closeChatPane(split, 'primary')
    expect(closed).toEqual({ panes: { primary: 'chat-b', secondary: null }, focusedPane: 'primary' })
    expect(focusedChatSessionId(closed)).toBe('chat-b')
  })

  it('normalizes a secondary-only layout into the primary pane', () => {
    expect(reconcileChatPaneLayout(
      { panes: { primary: null, secondary: 'chat-b' }, focusedPane: 'secondary' },
      new Set(['chat-b'])
    )).toEqual({ panes: { primary: 'chat-b', secondary: null }, focusedPane: 'primary' })
  })

  it('preserves the focused session while swapping panes', () => {
    const swapped = swapChatPanes(split)
    expect(swapped).toEqual({
      panes: { primary: 'chat-b', secondary: 'chat-a' },
      focusedPane: 'primary'
    })
    expect(focusedChatSessionId(swapped)).toBe('chat-b')
  })

  it('reconciles removed chats but keeps any archived chat the caller considers valid', () => {
    expect(reconcileChatPaneLayout(split, new Set(['chat-b']), 'chat-c')).toEqual({
      panes: { primary: 'chat-b', secondary: null },
      focusedPane: 'primary'
    })
    expect(reconcileChatPaneLayout(split, new Set(['chat-c']), 'chat-c')).toEqual({
      panes: { primary: 'chat-c', secondary: null },
      focusedPane: 'primary'
    })
  })
})
