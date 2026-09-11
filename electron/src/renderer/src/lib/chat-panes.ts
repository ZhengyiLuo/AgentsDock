export type ChatPane = 'primary' | 'secondary'

export interface ChatPanes {
  primary: string | null
  secondary: string | null
}

export interface ChatPaneLayout {
  panes: ChatPanes
  focusedPane: ChatPane
}

export function visibleChatSessionIds(panes: ChatPanes): string[] {
  return [...new Set([panes.primary, panes.secondary].filter((id): id is string => Boolean(id)))]
}

export function focusedChatSessionId(layout: ChatPaneLayout): string | null {
  return layout.panes[layout.focusedPane]
}

export function selectChatInPane(layout: ChatPaneLayout, sessionId: string, pane: ChatPane): ChatPaneLayout {
  const existingPane = layout.panes.primary === sessionId
    ? 'primary'
    : layout.panes.secondary === sessionId
      ? 'secondary'
      : null
  if (existingPane) return { panes: layout.panes, focusedPane: existingPane }
  return { panes: { ...layout.panes, [pane]: sessionId }, focusedPane: pane }
}

export function closeChatPane(layout: ChatPaneLayout, pane: ChatPane): ChatPaneLayout {
  if (pane === 'primary') {
    return {
      panes: { primary: layout.panes.secondary, secondary: null },
      focusedPane: 'primary'
    }
  }
  return {
    panes: { ...layout.panes, secondary: null },
    focusedPane: layout.focusedPane === 'secondary' ? 'primary' : layout.focusedPane
  }
}

export function swapChatPanes(layout: ChatPaneLayout): ChatPaneLayout {
  if (!layout.panes.secondary) return layout
  return {
    panes: { primary: layout.panes.secondary, secondary: layout.panes.primary },
    focusedPane: layout.focusedPane === 'primary' ? 'secondary' : 'primary'
  }
}

export function reconcileChatPaneLayout(
  layout: ChatPaneLayout,
  validSessionIds: ReadonlySet<string>,
  fallbackPrimary: string | null = null
): ChatPaneLayout {
  const primary = layout.panes.primary && validSessionIds.has(layout.panes.primary)
    ? layout.panes.primary
    : null
  const secondary = layout.panes.secondary
    && layout.panes.secondary !== primary
    && validSessionIds.has(layout.panes.secondary)
    ? layout.panes.secondary
    : null
  if (primary) {
    return {
      panes: { primary, secondary },
      focusedPane: layout.focusedPane === 'secondary' && secondary ? 'secondary' : 'primary'
    }
  }
  if (secondary) return { panes: { primary: secondary, secondary: null }, focusedPane: 'primary' }
  const fallback = fallbackPrimary && validSessionIds.has(fallbackPrimary) ? fallbackPrimary : null
  return { panes: { primary: fallback, secondary: null }, focusedPane: 'primary' }
}
