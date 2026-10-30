import { describe, expect, it } from 'vitest'
import {
  closeChatPane, focusedChatSessionId, reconcileChatPaneLayout, selectChatInPane, swapChatPanes,
  visibleChatSessionIds, parseChatWorkspaces, visibleWorkspaceLayout, workspaceWithLayout,
  type ChatPaneLayout, type ChatWorkspace
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

  it('keeps four panes distinct and preserves focused chat after a different pane closes', () => {
    const grid: ChatPaneLayout = {
      panes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' },
      focusedPane: 'quaternary', paneCount: 4
    }
    expect(visibleChatSessionIds(grid.panes)).toEqual(['a', 'b', 'c', 'd'])
    expect(selectChatInPane(grid, 'c', 'primary').focusedPane).toBe('tertiary')
    expect(closeChatPane(grid, 'secondary')).toEqual({
      panes: { primary: 'a', secondary: 'c', tertiary: 'd' }, focusedPane: 'tertiary', paneCount: 3
    })
  })

  it('retains hidden assignments while editing a smaller visible grid', () => {
    const workspace: ChatWorkspace = {
      id: 'one', panes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' },
      paneCount: 1, focusedPane: 'primary', columnRatio: 0.6, rowRatio: 0.4
    }
    const visible = visibleWorkspaceLayout(workspace)
    expect(visible.panes).toEqual({ primary: 'a', secondary: null })
    const changed = workspaceWithLayout(workspace, selectChatInPane(visible, 'c', 'primary'))
    expect(changed.panes).toEqual({ primary: 'c', secondary: 'b', tertiary: null, quaternary: 'd' })
    expect(visibleWorkspaceLayout({ ...changed, paneCount: 4 }).panes).toEqual(changed.panes)
  })

  it('validates saved workspaces without replacing intentional empty slots', () => {
    const restored = parseChatWorkspaces({
      activeWorkspaceId: 'two', workspaces: [
        { id: 'one', panes: { primary: 'a', secondary: 'a', tertiary: 'deleted', quaternary: 'd' }, paneCount: 2, focusedPane: 'quaternary', columnRatio: 4 },
        { id: 'two', panes: { primary: null, secondary: 'b' }, paneCount: 4, focusedPane: 'tertiary', rowRatio: 0.3 },
        { id: 'one', panes: { primary: 'd' } }
      ]
    }, new Set(['a', 'b', 'd']))!
    expect(restored.workspaces).toHaveLength(2)
    expect(restored.activeWorkspaceId).toBe('two')
    expect(restored.workspaces[0]).toMatchObject({
      panes: { primary: 'a', secondary: null, tertiary: null, quaternary: 'd' }, focusedPane: 'primary', columnRatio: 0.8, rowRatio: 0.5
    })
    expect(visibleWorkspaceLayout(restored.workspaces[1])).toEqual({
      panes: { primary: null, secondary: 'b', tertiary: null, quaternary: null }, paneCount: 4, focusedPane: 'tertiary'
    })
  })

  it('restores older three-pane workspaces as the original split layout', () => {
    const restored = parseChatWorkspaces({ workspaces: [{
      id: 'old', panes: { primary: 'a', secondary: 'b', tertiary: 'c' },
      paneCount: 3, focusedPane: 'tertiary', columnRatio: 0.6, rowRatio: 0.4
    }] }, new Set(['a', 'b', 'c']))!
    expect(restored.workspaces[0]).toMatchObject({
      threePaneLayout: 'split', threeColumnRatios: [1 / 3, 2 / 3],
      columnRatio: 0.6, rowRatio: 0.4, focusedPane: 'tertiary'
    })
  })

  it('round-trips the column layout and preserves it through pane edits', () => {
    const workspace: ChatWorkspace = {
      id: 'columns', panes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' },
      paneCount: 3, focusedPane: 'tertiary', columnRatio: 0.55, rowRatio: 0.45,
      threePaneLayout: 'columns', threeColumnRatios: [0.25, 0.7]
    }
    const stored = { activeWorkspaceId: workspace.id, workspaces: [workspace] }
    expect(parseChatWorkspaces(JSON.parse(JSON.stringify(stored)), new Set(['a', 'b', 'c', 'd']))).toEqual(stored)
    const metadata = { threePaneLayout: 'columns', threeColumnRatios: [0.25, 0.7] }
    expect(closeChatPane(workspace, 'secondary')).toMatchObject(metadata)
    expect(reconcileChatPaneLayout(workspace, new Set(['a', 'c', 'd']))).toMatchObject(metadata)
    const changed = workspaceWithLayout(workspace, selectChatInPane(visibleWorkspaceLayout(workspace), 'e', 'secondary'))
    expect(changed).toMatchObject({ ...metadata, panes: { primary: 'a', secondary: 'e', tertiary: 'c', quaternary: 'd' } })
  })

  it.each([
    { ratios: [-1, 2], expected: [0.2, 0.8] },
    { ratios: [0.7, 0.3], expected: [0.6, 0.8] },
    { ratios: [0.25, 0.3], expected: [0.25, 0.45] },
    { ratios: [0.1, 0.45], expected: [0.2, 0.45] },
    { ratios: [Number.NaN, 0.7], expected: [1 / 3, 2 / 3] },
    { ratios: [0.3, Number.POSITIVE_INFINITY], expected: [1 / 3, 2 / 3] },
    { ratios: [0.3], expected: [1 / 3, 2 / 3] },
    { ratios: '0.3,0.7', expected: [1 / 3, 2 / 3] }
  ])('normalizes saved column divider boundaries: $ratios', ({ ratios, expected }) => {
    const restored = parseChatWorkspaces({ workspaces: [{
      id: 'one', panes: { primary: 'a' }, paneCount: 3,
      threePaneLayout: 'invalid', threeColumnRatios: ratios
    }] }, new Set(['a']))!.workspaces[0]
    expect(restored.threePaneLayout).toBe('split')
    expect(restored.threeColumnRatios).toEqual(expected)
  })
})
