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

export function orderedActiveSessions(sessions: Session[], folderOrder: string[]): Session[] {
  const pinned = sessions.filter(session => session.pinned && !session.archived)
  const regular = sessions.filter(session => !session.pinned && !session.archived)
  const folders = [...new Set(regular.map(session => session.folder?.trim() || 'General'))]
  const order = new Map(folderOrder.map((folder, index) => [folder, index]))
  folders.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
  return [...pinned, ...folders.flatMap(folder => regular.filter(session => (session.folder?.trim() || 'General') === folder))]
}

export function navigableSessions(sessions: Session[], folderOrder: string[], collapsedFolders: Set<string>): Session[] {
  return orderedActiveSessions(sessions, folderOrder).filter(session => session.pinned || !collapsedFolders.has(session.folder?.trim() || 'General'))
}
