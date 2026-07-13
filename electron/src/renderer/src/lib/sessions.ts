import type { Session } from '@shared/types'

export function sessionMatchesQuery(session: Session, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [
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

export function navigableSessions(sessions: Session[], folderOrder: string[], collapsedFolders: Set<string>): Session[] {
  return orderedActiveSessions(sessions, folderOrder).filter(session => session.pinned || !collapsedFolders.has(session.folder?.trim() || 'General'))
}
