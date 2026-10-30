export const CHAT_PANE_IDS = ['primary', 'secondary', 'tertiary', 'quaternary'] as const
export type ChatPane = typeof CHAT_PANE_IDS[number]
export type ChatPaneCount = 1 | 2 | 3 | 4
export type ChatThreePaneLayout = 'split' | 'columns'

export interface ChatPanes {
  primary: string | null
  secondary: string | null
  tertiary?: string | null
  quaternary?: string | null
}

export interface ChatPaneLayout {
  panes: ChatPanes
  focusedPane: ChatPane
  paneCount?: ChatPaneCount
}

export interface ChatWorkspace extends ChatPaneLayout {
  id: string
  title?: string
  paneCount: ChatPaneCount
  columnRatio: number
  rowRatio: number
  threePaneLayout?: ChatThreePaneLayout
  threeColumnRatios?: [number, number]
}

export interface ChatWorkspaceState {
  activeWorkspaceId: string
  workspaces: ChatWorkspace[]
}

export function chatPaneCount(layout: ChatPaneLayout): ChatPaneCount {
  const assigned = CHAT_PANE_IDS.reduce((count, pane, index) => layout.panes[pane] ? index + 1 : count, 1)
  return (layout.paneCount ?? assigned) as ChatPaneCount
}

export function visibleChatSessionIds(panes: ChatPanes): string[] {
  return [...new Set(CHAT_PANE_IDS.map(pane => panes[pane]).filter((id): id is string => Boolean(id)))]
}

export function chatPaneForSession(panes: ChatPanes, sessionId: string): ChatPane | undefined {
  return CHAT_PANE_IDS.find(pane => panes[pane] === sessionId)
}

export function focusedChatSessionId(layout: ChatPaneLayout): string | null {
  return layout.panes[layout.focusedPane] ?? null
}

export function selectChatInPane(layout: ChatPaneLayout, sessionId: string, pane: ChatPane): ChatPaneLayout {
  const existingPane = chatPaneForSession(layout.panes, sessionId)
  if (existingPane) return { ...layout, focusedPane: existingPane }
  return {
    ...layout,
    panes: { ...layout.panes, [pane]: sessionId },
    focusedPane: pane,
    ...(layout.paneCount ? { paneCount: Math.max(layout.paneCount, CHAT_PANE_IDS.indexOf(pane) + 1) as ChatPaneCount } : {})
  }
}

export function closeChatPane(layout: ChatPaneLayout, pane: ChatPane): ChatPaneLayout {
  const count = chatPaneCount(layout)
  const index = CHAT_PANE_IDS.indexOf(pane)
  if (index >= count) return layout
  const ids = CHAT_PANE_IDS.slice(0, count).map(id => layout.panes[id] ?? null)
  ids.splice(index, 1)
  const panes: ChatPanes = { primary: ids[0] ?? null, secondary: ids[1] ?? null }
  if (ids.length > 2) panes.tertiary = ids[2]
  const focusedId = focusedChatSessionId(layout)
  const focusedPane = (focusedId && chatPaneForSession(panes, focusedId)) || CHAT_PANE_IDS[Math.min(index, Math.max(ids.length - 1, 0))]
  return {
    ...layout,
    panes,
    focusedPane,
    ...(layout.paneCount ? { paneCount: Math.max(1, count - 1) as ChatPaneCount } : {})
  }
}

export function swapChatPanes(layout: ChatPaneLayout): ChatPaneLayout {
  if (!layout.panes.secondary) return layout
  return {
    ...layout,
    panes: { ...layout.panes, primary: layout.panes.secondary, secondary: layout.panes.primary },
    focusedPane: layout.focusedPane === 'primary' ? 'secondary' : layout.focusedPane === 'secondary' ? 'primary' : layout.focusedPane
  }
}

export function reconcileChatPaneLayout(
  layout: ChatPaneLayout,
  validSessionIds: ReadonlySet<string>,
  fallbackPrimary: string | null = null
): ChatPaneLayout {
  const seen = new Set<string>()
  const panes: ChatPanes = { primary: null, secondary: null }
  for (const pane of CHAT_PANE_IDS) {
    const id = layout.panes[pane]
    if (id && validSessionIds.has(id) && !seen.has(id)) {
      panes[pane] = id
      seen.add(id)
    } else if (pane in layout.panes) panes[pane] = null
  }
  if (layout.paneCount) {
    const focusedPane = CHAT_PANE_IDS.slice(0, layout.paneCount).includes(layout.focusedPane) ? layout.focusedPane : 'primary'
    return { ...layout, panes, focusedPane, paneCount: layout.paneCount }
  }
  // Older two-pane preferences had no empty-slot concept; preserve migration.
  if (!panes.primary) {
    const first = visibleChatSessionIds(panes)[0]
    if (first) {
      const source = chatPaneForSession(panes, first)!
      panes.primary = first
      panes[source] = null
    } else panes.primary = fallbackPrimary && validSessionIds.has(fallbackPrimary) ? fallbackPrimary : null
  }
  return { ...layout, panes, focusedPane: panes[layout.focusedPane] ? layout.focusedPane : 'primary' }
}

export function visibleWorkspaceLayout(workspace: ChatWorkspace): ChatPaneLayout {
  const panes: ChatPanes = { primary: null, secondary: null }
  for (const pane of CHAT_PANE_IDS.slice(0, workspace.paneCount)) panes[pane] = workspace.panes[pane] ?? null
  return { panes, focusedPane: workspace.focusedPane, paneCount: workspace.paneCount }
}

export function workspaceWithLayout(workspace: ChatWorkspace, layout: ChatPaneLayout): ChatWorkspace {
  const panes = { ...workspace.panes }
  // Active replacements must not erase assignments hidden by a smaller grid.
  for (const pane of CHAT_PANE_IDS.slice(0, workspace.paneCount)) panes[pane] = null
  for (const pane of CHAT_PANE_IDS.slice(0, chatPaneCount(layout))) panes[pane] = layout.panes[pane] ?? null
  const visible = new Set(visibleChatSessionIds(layout.panes))
  for (const pane of CHAT_PANE_IDS.slice(chatPaneCount(layout))) {
    if (panes[pane] && visible.has(panes[pane]!)) panes[pane] = null
  }
  return { ...workspace, panes, focusedPane: layout.focusedPane, paneCount: chatPaneCount(layout) }
}

export function workspaceRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5
}

export function workspaceThreeColumnRatios(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2
    || !value.every(boundary => typeof boundary === 'number' && Number.isFinite(boundary))) return [1 / 3, 2 / 3]
  const first = Math.min(0.6, Math.max(0.2, value[0]))
  return [first, Math.min(0.8, Math.max(first + 0.2, value[1]))]
}

export function parseChatWorkspaces(value: unknown, validSessionIds: ReadonlySet<string>): ChatWorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as Partial<ChatWorkspaceState>
  if (!Array.isArray(stored.workspaces)) return null
  const workspaces: ChatWorkspace[] = []
  const ids = new Set<string>()
  for (const raw of stored.workspaces) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)
      || !raw.panes || typeof raw.panes !== 'object') continue
    const panes: ChatPanes = { primary: null, secondary: null }
    for (const pane of CHAT_PANE_IDS) {
      if (typeof raw.panes[pane] === 'string') panes[pane] = raw.panes[pane]
    }
    const paneCount = ([1, 2, 3, 4].includes(raw.paneCount) ? raw.paneCount : chatPaneCount({ panes, focusedPane: 'primary' })) as ChatPaneCount
    const focusedPane = CHAT_PANE_IDS.slice(0, paneCount).includes(raw.focusedPane) ? raw.focusedPane : 'primary'
    const layout = reconcileChatPaneLayout({ panes, focusedPane, paneCount }, validSessionIds)
    workspaces.push({
      id: raw.id, ...layout, paneCount,
      ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim() } : {}),
      columnRatio: workspaceRatio(raw.columnRatio), rowRatio: workspaceRatio(raw.rowRatio),
      threePaneLayout: raw.threePaneLayout === 'columns' ? 'columns' : 'split',
      threeColumnRatios: workspaceThreeColumnRatios(raw.threeColumnRatios)
    })
    ids.add(raw.id)
  }
  if (!workspaces.length) return null
  return { activeWorkspaceId: typeof stored.activeWorkspaceId === 'string' && ids.has(stored.activeWorkspaceId) ? stored.activeWorkspaceId : workspaces[0].id, workspaces }
}
