import type { Session } from '@shared/types'

export type SidebarStatus = 'unread' | 'running'

export interface SidebarGroupingOptions {
  groupUnreadChats?: boolean
  includeCronInUnread?: boolean
  groupRunningChats?: boolean
  jobSessionIds?: ReadonlySet<string>
}

export function isUnread(session: Session): boolean {
  return Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0)
}

function promotesUnread(session: Session, options: SidebarGroupingOptions): boolean {
  if (!isUnread(session)) return false
  if (options.includeCronInUnread === true || session.manual_unread) return true
  const latest = session.latest_non_job_agent_event_seq
  // Older servers cannot separate human replies from scheduled output. Their
  // registered jobs still identify cron chats without inspecting transcripts.
  if (latest == null) return !options.jobSessionIds?.has(session.id)
  return latest > (session.last_read_agent_event_seq ?? 0)
}

export function sidebarSessionGroups(sessions: Session[], activeSessionIds: ReadonlySet<string>, options: SidebarGroupingOptions = {}) {
  const groups: Record<SidebarStatus | 'ordinary', Session[]> = { unread: [], running: [], ordinary: [] }
  for (const session of sessions) {
    if (!session.archived && activeSessionIds.has(session.id)) {
      groups[options.groupRunningChats === false ? 'ordinary' : 'running'].push(session)
    }
    else if (options.groupUnreadChats !== false && !session.archived && promotesUnread(session, options)) groups.unread.push(session)
    else groups.ordinary.push(session)
  }
  return groups
}

/**
 * Cheap preflight for a possible direct-create placeholder. Callers must also
 * prove its direct-create marker and one-event timeline before removing it.
 * `backend_locked` is the authoritative first-turn fence even while a
 * provider has not returned its own session ID yet.
 */
export function isUntouchedNewChat(session: Session): boolean {
  const latestEventSequence = session.latest_event_seq ?? 0
  return session.title === 'New chat'
    && session.backend_locked === false
    && !session.session_id
    && !session.claude_session_id
    && !session.codex_thread_id
    && !session.cursor_session_id
    && !session.opencode_session_id
    && !session.parent_id
    && !session.pinned
    && !session.archived
    && !session.codex_goal
    && (session.codex_pending_interaction_count ?? 0) === 0
    && !session.codex_needs_user_action
    && (session.claude_pending_interaction_count ?? 0) === 0
    && !session.claude_needs_user_action
    && !session.manual_unread
    && !session.emergency_alert
    && (session.unacknowledged_emergency_count ?? 0) === 0
    && latestEventSequence <= 1
    && (!session.latest_event_type || session.latest_event_type === 'session_created')
    && (session.latest_agent_event_seq ?? 0) === 0
}

export function sessionMatchesQuery(session: Session, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [
    session.id,
    session.title,
    session.folder,
    session.backend,
    session.model,
    session.effort,
    session.cwd,
    session.session_id,
    session.claude_session_id,
    session.codex_thread_id
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
}

export function sessionNameMatchRank(session: Session, query: string): number | null {
  const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (!needle) return 0
  const title = session.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (title.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(needle))) return 2
  if (title.includes(needle)) return 3
  return null
}

export function rankSessionsForSearch(sessions: Session[], query: string, historySessionIds: Set<string>): Session[] {
  const clean = query.trim()
  if (!clean) return sessions
  return sessions
    .map((session, index) => {
      const nameRank = sessionNameMatchRank(session, clean)
      const rank = nameRank ?? (session.archived
        ? Number.POSITIVE_INFINITY
        : historySessionIds.has(session.id) ? 10
          : sessionMatchesQuery(session, clean) ? 20
            : Number.POSITIVE_INFINITY)
      return { session, index, rank }
    })
    .filter(result => Number.isFinite(result.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(result => result.session)
}

export function orderedActiveSessions(sessions: Session[], folderOrder: string[]): Session[] {
  const pinned = sessions.filter(session => session.pinned && !session.archived)
  const regular = sessions.filter(session => !session.pinned && !session.archived)
  const folders = [...new Set(regular.map(session => session.folder?.trim() || 'General'))]
  const order = new Map(folderOrder.map((folder, index) => [folder, index]))
  folders.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
  return [...pinned, ...folders.flatMap(folder => regular.filter(session => (session.folder?.trim() || 'General') === folder))]
}

export interface DigestTargetSection {
  id: string
  title: string
  sessions: Session[]
}

export function digestTargetSections(
  sessions: Session[],
  folderOrder: string[],
  sourceSessionId: string | null,
  query = ''
): DigestTargetSection[] {
  const needle = query.trim().toLocaleLowerCase()
  const targets = orderedActiveSessions(sessions, folderOrder).filter(session => {
    if (session.id === sourceSessionId) return false
    if (!needle) return true
    return `${session.title} ${session.folder || 'General'} ${session.backend}`.toLocaleLowerCase().includes(needle)
  })
  const sections: DigestTargetSection[] = []
  const pinned = targets.filter(session => session.pinned)
  if (pinned.length) sections.push({ id: 'pinned', title: 'Pinned', sessions: pinned })

  const regular = targets.filter(session => !session.pinned)
  const folders = [...new Set(regular.map(session => session.folder?.trim() || 'General'))]
  for (const folder of folders) {
    const folderSessions = regular.filter(session => (session.folder?.trim() || 'General') === folder)
    if (folderSessions.length) sections.push({ id: `folder:${folder}`, title: folder, sessions: folderSessions })
  }
  return sections
}

export function navigableSessions(sessions: Session[], folderOrder: string[], collapsedFolders: Set<string>, activeSessionIds: ReadonlySet<string> = new Set(), collapsedStatuses: ReadonlySet<SidebarStatus> = new Set(), pinnedCollapsed = false, options: SidebarGroupingOptions = {}): Session[] {
  const groups = sidebarSessionGroups(sessions, activeSessionIds, options)
  return [
    ...(!collapsedStatuses.has('unread') ? groups.unread : []),
    ...(!collapsedStatuses.has('running') ? groups.running : []),
    ...orderedActiveSessions(groups.ordinary, folderOrder).filter(session => session.pinned ? !pinnedCollapsed : !collapsedFolders.has(session.folder?.trim() || 'General'))
  ]
}
