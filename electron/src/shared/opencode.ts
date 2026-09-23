import type { Event, Health, Session } from './types'
import { opencodeBackendSupported } from './runtime-catalog'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from './provider-origin'

export function openCodeProviderCommandsAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.local_provider_commands_v1
  return opencodeBackendSupported(health) && capability?.available === true
    && capability.version === 1 && capability.supported_backends?.includes('opencode') === true
}

/** Apply only newer, live server-owned bindings; never revive quarantined context. */
export function applyOpenCodeSessionEvent(session: Session, event: Event): Session {
  if (session.backend !== 'opencode' || event.backend !== 'opencode' || event.session_id !== session.id
    || !['provider_session', 'provider_session_reset'].includes(event.type)
    || isImportedHistoryRecord(event) || isImportedProviderControlMetadata(event)
    || event.seq <= (session.latest_event_seq ?? 0)) return session
  if (event.type === 'provider_session') {
    const id = event.provider_session_id?.trim()
    if (!id) return session
    return { ...session, session_id: id, opencode_session_id: id, backend_locked: true, latest_event_seq: event.seq }
  }
  const current = session.opencode_session_id || session.session_id
  if (current && event.previous_provider_session_id && current !== event.previous_provider_session_id) return session
  return { ...session, session_id: null, opencode_session_id: null, latest_event_seq: event.seq }
}
