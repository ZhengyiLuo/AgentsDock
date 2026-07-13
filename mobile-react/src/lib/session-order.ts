import type { Session } from '../types'

export interface SessionSection {
  id: string
  title: string
  sessions: Session[]
}
export function compareSessions(leftSession: Session, rightSession: Session): number {
  const left = leftSession.sort_order ?? Number.MAX_SAFE_INTEGER
  const right = rightSession.sort_order ?? Number.MAX_SAFE_INTEGER
  if (left !== right) return left - right
  return (leftSession.created_at ?? '').localeCompare(rightSession.created_at ?? '')
}

export function sessionSection(session: Session): string {
  return session.archived ? 'Archived' : session.pinned ? 'Pinned' : session.folder?.trim() || 'General'
}

export function orderedSessionSections(sessions: Session[], folderOrder: string[], includeArchived = true): SessionSection[] {
  const groups = new Map<string, Session[]>()
  for (const folder of folderOrder) groups.set(folder, [])
  for (const session of sessions) {
    if (!includeArchived && session.archived) continue
    const folder = sessionSection(session)
    groups.set(folder, [...(groups.get(folder) ?? []), session])
  }
  const remaining = [...groups.keys()]
    .filter(folder => !['Pinned', 'General', 'Archived'].includes(folder) && !folderOrder.includes(folder))
    .sort((left, right) => left.localeCompare(right))
  const orderedFolders = ['Pinned', ...folderOrder, ...remaining, 'General', ...(includeArchived ? ['Archived'] : [])]
    .filter((folder, index, values) => values.indexOf(folder) === index && (groups.get(folder)?.length ?? 0) > 0)
  return orderedFolders.map(folder => ({ id: folder, title: folder, sessions: [...(groups.get(folder) ?? [])].sort(compareSessions) }))
}
