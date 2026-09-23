import type { Session } from '../types'

/**
 * A title match represents the chat itself, while a history-only match
 * represents one exact timeline result. Never attach both meanings to the
 * same visible row: doing so makes a correct title result open an unrelated
 * older message from that chat.
 */
export function sidebarContentResult<T>(
  title: string,
  query: string,
  contentResult: T | undefined,
): T | undefined {
  return sidebarNameMatchRank(title, query) !== null
    ? undefined
    : contentResult
}
function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function sidebarNameMatchRank(title: string, query: string): number | null {
  const needle = normalizeName(query)
  if (!needle) return 0
  const name = normalizeName(title)
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(needle))) return 2
  if (name.includes(needle)) return 3
  return null
}

/** Keep the Mac search order across folders: names, history, then metadata. */
export function rankSidebarSessions(sessions: Session[], query: string, historySessionIds: ReadonlySet<string>): Session[] {
  const clean = query.trim().toLocaleLowerCase()
  if (!clean) return sessions
  return sessions.map((session, index) => {
    const metadataMatches = [
      session.id, session.folder, session.backend, session.model, session.effort,
      session.cwd, session.session_id, session.claude_session_id, session.codex_thread_id,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(clean)
    const rank = sidebarNameMatchRank(session.title, query) ?? (session.archived
      ? Number.POSITIVE_INFINITY
      : historySessionIds.has(session.id) ? 10
        : metadataMatches ? 20 : Number.POSITIVE_INFINITY)
    return { session, index, rank }
  }).filter(result => Number.isFinite(result.rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(result => result.session)
}
