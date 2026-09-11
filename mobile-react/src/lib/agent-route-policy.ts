import type { AgentCrossChatRoutesSnapshot, ChatReference } from '../types'

/** Count only explicit new grants; repeated references never invent extra routes. */
export function agentRouteCapacityError(snapshot: AgentCrossChatRoutesSnapshot | undefined, references: readonly ChatReference[]): string | null {
  if (!snapshot || !Number.isSafeInteger(snapshot.max_routes) || snapshot.max_routes < 0) return null
  const granted = new Set(snapshot.routes.map(route => route.target_session_id))
  const pending = new Set(references.flatMap(reference => (
    reference.target_kind !== 'secure_peer' && reference.action === 'route' && reference.grant_intent === true && !granted.has(reference.session_id)
      ? [reference.session_id] : []
  )))
  return snapshot.routes.length + pending.size > snapshot.max_routes
    ? `This chat has reached its route access limit (${snapshot.max_routes} ${snapshot.max_routes === 1 ? 'route' : 'routes'} maximum). Revoke a granted route before adding another chat.`
    : null
}

export function isAgentRouteRevisionConflict(error: { status?: unknown; detail?: unknown }): boolean {
  if (error.status !== 409) return false
  if (error.detail === 'route revision conflict') return true
  return Boolean(error.detail && typeof error.detail === 'object' && !Array.isArray(error.detail)
    && (error.detail as { code?: unknown }).code === 'route_revision_conflict')
}
