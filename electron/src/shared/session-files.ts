import type { AgentFile, Event, SessionSnapshot } from './types'

export function agentFileBelongsToSession(
  file: AgentFile | null | undefined,
  sessionId: string
): boolean {
  if (!file) return true
  const owner = String(file.session_id ?? '').trim()
  return !owner || owner === sessionId
}

export function eventFileForSession(event: Event): AgentFile | null {
  const file = event.artifact || event.file || null
  return file && agentFileBelongsToSession(file, event.session_id) ? file : null
}

export function isolateSessionEvent(event: Event, sessionId: string): Event | null {
  if (event.session_id !== sessionId) return null
  let isolated = event
  for (const key of ['file', 'artifact'] as const) {
    if (agentFileBelongsToSession(event[key], sessionId)) continue
    if (event.type === 'artifact_created' || event.type === 'file_uploaded') return null
    if (isolated === event) isolated = { ...event }
    delete isolated[key]
  }
  return isolated
}

export function isolateSessionSnapshot(
  snapshot: SessionSnapshot,
  sessionId: string
): SessionSnapshot | null {
  if (snapshot.session.id !== sessionId) return null
  const events = snapshot.events
    .map(event => isolateSessionEvent(event, sessionId))
    .filter((event): event is Event => Boolean(event))
  const files = snapshot.files.filter(file => agentFileBelongsToSession(file, sessionId))
  return events.length === snapshot.events.length
    && events.every((event, index) => event === snapshot.events[index])
    && files.length === snapshot.files.length
    ? snapshot
    : {
        ...snapshot,
        events,
        files,
        filesTotal: Math.max(
          files.length,
          snapshot.filesTotal - (snapshot.files.length - files.length)
        )
      }
}
