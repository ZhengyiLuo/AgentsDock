import type { Event, Health, JsonValue, Session } from '../types'

export const CLAUDE_INTERACTIVE_CLIENT_CAPABILITY = 'claude_sdk_interactive_v1'

export interface ClaudeControlsCapability {
  available: true
  version: number
  interactive_client_capability: string
  features?: Record<string, JsonValue>
  fallback_transport?: string | null
}

export function claudeControlsCapability(health: Health | null | undefined): ClaudeControlsCapability | null {
  const capabilities = recordValue(health?.capabilities)
  const candidate = recordValue(capabilities.claude_controls)
  const version = finiteNumber(candidate.version)
  if (candidate.available !== true || version == null || version < 1) return null
  const advertised = typeof candidate.interactive_client_capability === 'string'
    ? candidate.interactive_client_capability.trim()
    : typeof candidate.interactive_capability === 'string'
      ? candidate.interactive_capability.trim()
      : ''
  if (advertised !== CLAUDE_INTERACTIVE_CLIENT_CAPABILITY) return null
  return {
    available: true,
    version,
    interactive_client_capability: advertised,
    features: recordValue(candidate.features),
    fallback_transport: typeof candidate.fallback_transport === 'string'
      ? candidate.fallback_transport
      : null,
  }
}

export function claudeInteractiveClientCapability(health: Health | null | undefined): string | null {
  return claudeControlsCapability(health)?.interactive_client_capability ?? null
}

export function isClaudeControlEvent(type: string): boolean {
  return type.startsWith('claude_')
    || type === 'provider_runtime_changed'
    || ['turn_started', 'turn_finished', 'turn_stopped', 'error'].includes(type)
}

export function latestClaudeControlEventSeq(events: readonly Event[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (isClaudeControlEvent(event.type)) return event.seq
  }
  return 0
}

export function sessionNeedsClaudeInteraction(session: Pick<
  Session,
  'backend' | 'claude_pending_interaction_count' | 'claude_needs_user_action' | 'latest_event_type'
>): boolean {
  return session.backend === 'claude' && (
    Boolean(session.claude_needs_user_action)
    || (session.claude_pending_interaction_count ?? 0) > 0
    || session.latest_event_type === 'claude_interaction_requested'
  )
}

export function sessionPendingInteractionCount(session: Pick<
  Session,
  | 'backend'
  | 'codex_pending_interaction_count'
  | 'codex_needs_user_action'
  | 'claude_pending_interaction_count'
  | 'claude_needs_user_action'
  | 'latest_event_type'
>): number {
  if (session.backend === 'claude') {
    const count = Math.max(0, session.claude_pending_interaction_count ?? 0)
    return session.claude_needs_user_action || session.latest_event_type === 'claude_interaction_requested'
      ? Math.max(1, count)
      : count
  }
  const count = Math.max(0, session.codex_pending_interaction_count ?? 0)
  return session.codex_needs_user_action || session.latest_event_type === 'codex_interaction_requested'
    ? Math.max(1, count)
    : count
}

export function sessionNeedsProviderInteraction(session: Pick<
  Session,
  | 'backend'
  | 'codex_pending_interaction_count'
  | 'codex_needs_user_action'
  | 'claude_pending_interaction_count'
  | 'claude_needs_user_action'
  | 'latest_event_type'
>): boolean {
  return sessionPendingInteractionCount(session) > 0
}

function recordValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
