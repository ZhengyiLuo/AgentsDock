import type {
  CodexPendingInteraction,
  CodexRuntimeSnapshot,
  CodexThreadStatus,
  Event,
  Health,
  JsonValue,
  Session,
} from '../types'

export const CODEX_INTERACTIVE_CLIENT_CAPABILITY = 'codex_interactive_v1'

export interface CodexControlsCapability {
  available: true
  version: number
  interactive_client_capability: string
  features?: Record<string, JsonValue>
}

export function codexControlsCapability(health: Health | null | undefined): CodexControlsCapability | null {
  const capabilities = recordValue(health?.capabilities)
  const candidate = recordValue(capabilities.codex_controls)
  const version = finiteNumber(candidate.version)
  if (candidate.available !== true || version == null || version < 1) return null
  const advertised = typeof candidate.interactive_client_capability === 'string'
    ? candidate.interactive_client_capability.trim()
    : ''
  if (advertised !== CODEX_INTERACTIVE_CLIENT_CAPABILITY) return null
  return {
    available: true,
    version,
    interactive_client_capability: advertised,
    features: recordValue(candidate.features),
  }
}

export function codexInteractiveClientCapability(health: Health | null | undefined): string | null {
  return codexControlsCapability(health)?.interactive_client_capability ?? null
}

export function advertisedStructuredDecisions(
  availableDecisions: JsonValue | undefined,
  key: string,
): Array<Record<string, JsonValue>> {
  if (!Array.isArray(availableDecisions)) return []
  return availableDecisions.filter((decision): decision is Record<string, JsonValue> => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false
    const body = decision[key]
    return Boolean(body && typeof body === 'object' && !Array.isArray(body))
  })
}

export function codexStatusLabel(status: CodexThreadStatus | null | undefined): string {
  const flags = status?.type === 'active' ? status.activeFlags : []
  if (flags.includes('waitingOnApproval')) return 'Approval needed'
  if (flags.includes('waitingOnUserInput')) return 'Answer needed'
  if (status?.type === 'active') return 'Running'
  if (status?.type === 'systemError') return 'Runtime error'
  if (status?.type === 'notLoaded') return 'Not loaded'
  return 'Idle'
}

export function codexStatusTone(runtime: CodexRuntimeSnapshot | null): 'idle' | 'active' | 'waiting' | 'error' {
  if ((runtime?.pending_interactions.length ?? 0) > 0) return 'waiting'
  const status = runtime?.status
  const flags = status?.type === 'active' ? status.activeFlags : []
  if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return 'waiting'
  if (status?.type === 'systemError') return 'error'
  if (status?.type === 'active') return 'active'
  return 'idle'
}

export function isCodexControlEvent(type: string): boolean {
  return type.startsWith('codex_')
    || type === 'context_compaction'
    || type.startsWith('review_')
    || ['turn_started', 'turn_finished', 'turn_stopped', 'error'].includes(type)
}

export function sessionNeedsCodexInteraction(session: Pick<
  Session,
  'backend' | 'codex_pending_interaction_count' | 'codex_needs_user_action' | 'latest_event_type'
>): boolean {
  return session.backend === 'codex' && (
    Boolean(session.codex_needs_user_action)
    || (session.codex_pending_interaction_count ?? 0) > 0
    || session.latest_event_type === 'codex_interaction_requested'
  )
}

export function isAgentActivityEvent(event: Pick<Event, 'type'>): boolean {
  return [
    'assistant_text',
    'turn_finished',
    'artifact_created',
    'file_uploaded',
    'job_finished',
    'job_error',
    'codex_interaction_requested',
    'claude_interaction_requested',
  ].includes(event.type)
}

export function latestCodexControlEventSeq(events: readonly Event[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (isCodexControlEvent(event.type)) return event.seq
  }
  return 0
}

export function remainingAutoResolveSeconds(
  interaction: CodexPendingInteraction,
  now = Date.now(),
): number | null {
  if (!interaction.auto_resolution_ms) return null
  const createdAt = Date.parse(interaction.created_at)
  if (!Number.isFinite(createdAt)) return Math.ceil(interaction.auto_resolution_ms / 1_000)
  return Math.max(0, Math.ceil((createdAt + interaction.auto_resolution_ms - now) / 1_000))
}

function recordValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
