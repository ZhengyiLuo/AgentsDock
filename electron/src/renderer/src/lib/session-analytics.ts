import type { BulkImportSessionItem, BulkImportSessionResult, Session } from '@shared/types'
import { trackEvent, type AnalyticsEventProps } from './analytics'

/** Snapshot before submission, never infer from credentials or a later selected chat.
 * "default" describes routing, not whether the CLI itself uses an API key. */
export function messageAnalyticsProps(session: Session | undefined): AnalyticsEventProps {
  if (!session) return {}
  const connection = session.backend === 'codex' ? session.codex_provider : session.provider_connection
  return {
    backend: session.backend,
    ...(connection === 'custom' ? { connection_kind: 'custom_api' as const }
      : connection === 'default' ? { connection_kind: 'default' as const } : {})
  }
}

type SessionPatch = Partial<Session> & { gemini_connect_api?: boolean }
const permissionFields: Partial<Record<Session['backend'], (keyof Session)[]>> = {
  codex: ['codex_approval_policy', 'codex_sandbox_mode', 'codex_permission_profile', 'codex_approvals_reviewer'],
  claude: ['claude_permission_mode'], cursor: ['cursor_permission_mode'],
  opencode: ['opencode_permission_mode'], gemini: ['gemini_permission_mode']
}

/** Called only for a user patch confirmed by the server in its owning profile.
 * Never call from a snapshot, subscription, import replay or model migration.
 * Values are compared locally, never passed to the telemetry boundary. */
export function trackConfirmedSessionChange(before: Session, patch: SessionPatch, after: Session): void {
  const backend = after.backend
  const agentChanged = before.backend !== after.backend
    || (before.provider_connection === 'custom') !== (after.provider_connection === 'custom')
    || (before.codex_provider === 'custom') !== (after.codex_provider === 'custom')
  if (patch.backend !== undefined && agentChanged) trackEvent('chat_agent_changed', { backend })
  // Selecting another Agent resets its model/permissions; that is not a
  // separate user model or permission choice.
  if (patch.backend === undefined && !agentChanged && !patch.gemini_connect_api) {
    if (patch.model !== undefined && (before.model ?? '') !== (after.model ?? '')
      && (patch.model ?? '') === (after.model ?? '')) trackEvent('chat_model_changed', { backend })
    if ((permissionFields[backend] ?? []).some(key => patch[key] !== undefined
      && (before[key] ?? null) !== (after[key] ?? null) && patch[key] === after[key])) {
      trackEvent('chat_permission_mode_changed', { backend })
    }
  }
  if (patch.archived !== undefined && Boolean(before.archived) !== Boolean(after.archived)
    && patch.archived === Boolean(after.archived)) trackEvent(after.archived ? 'chat_archived' : 'chat_unarchived')
}

export function isImportedAPIConnection(before: Session | undefined, patch: SessionPatch): boolean {
  return Boolean(patch.gemini_connect_api === true && before?.backend === 'gemini'
    && before.session_id && before.provider_connection !== 'custom')
}

/** One outcome per explicitly API-bound import, not per refreshed transcript. */
export function trackImportedAPIResults(items: BulkImportSessionItem[], results: BulkImportSessionResult[]): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (item.backend !== 'gemini' || item.provider_connection !== 'custom' || seen.has(item.provider_session_id)) continue
    seen.add(item.provider_session_id)
    const result = results.find(value => value.backend === item.backend && value.provider_session_id === item.provider_session_id)
    // An unconfirmed transport outcome isn't a confirmed rejection or binding.
    if (!result || result.code === 'client_status_unknown' || result.code === 'already_imported') continue
    trackEvent('imported_chat_api_connected', { backend: 'gemini', success: result.ok && Boolean(result.session_id) })
  }
}
