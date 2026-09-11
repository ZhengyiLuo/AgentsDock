import type { Event, ProviderInterruptionOrigin } from './types'

const canonicalUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sourceISOTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Saved history may contain real user text, but never owns a live run. */
export function isImportedHistoryRecord(event: Event): boolean {
  return event.imported === true && typeof event.run_id === 'string' && event.run_id.startsWith('import_')
}

/**
 * Trust the server's explicit import provenance, never the text of a message.
 * This is historical control metadata, not a new user turn or a live stop.
 */
export function isImportedProviderInterruption(event: Event): event is Event & {
  type: 'provider_interruption'
  imported: true
  provider_origin: ProviderInterruptionOrigin
} {
  const origin = event.provider_origin
  return event.type === 'provider_interruption'
    && event.imported === true
    && (event.backend == null || event.backend === 'claude')
    && origin != null
    && typeof origin === 'object'
    && origin.provider === 'claude'
    && origin.kind === 'interruption'
    && typeof origin.event_id === 'string'
    && canonicalUUID.test(origin.event_id)
    && typeof origin.session_id === 'string'
    && canonicalUUID.test(origin.session_id)
    && typeof origin.timestamp === 'string'
    && sourceISOTimestamp.test(origin.timestamp)
    && Number.isFinite(Date.parse(origin.timestamp))
    && (origin.cause === 'steer' || origin.cause === 'stop' || origin.cause === 'unknown')
}

/** Hidden batch bookkeeping, never a live provider terminal or agent reply. */
export function isImportedClaudeControlCompanion(event: Event): event is Event & {
  type: 'history_imported' | 'turn_finished'
  imported: true
  metadata_only: true
  backend: 'claude'
  run_id: string
} {
  return (event.type === 'history_imported' || event.type === 'turn_finished')
    && event.imported === true
    && event.metadata_only === true
    && event.backend === 'claude'
    && typeof event.run_id === 'string'
    && event.run_id.startsWith('import_')
}

/**
 * Codex can represent goal-runtime injections as user starts. The server must
 * prove their provider content origin; import flags and matching text alone
 * cannot distinguish them from a user's literal quotation of the wrapper.
 */
export function isImportedCodexGoalContext(event: Event): boolean {
  if (
    event.type !== 'turn_started'
    || event.imported !== true
    || event.backend !== 'codex'
    || typeof event.run_id !== 'string'
    || !event.run_id.startsWith('import_')
    || event.provider_runtime_context !== 'goal'
    || event.metadata_only !== true
    || (event.prompt != null && typeof event.prompt !== 'string')
    || hasProviderUserProvenance(event)
  ) return false
  const prompt = event.prompt?.trim() || ''
  return !prompt || isExactGoalRuntimePrompt(prompt)
}

function isExactGoalRuntimePrompt(prompt: string): boolean {
  const envelope = /^<codex_internal_context source=(["'])goal\1>([\s\S]*)<\/codex_internal_context>$/.exec(prompt)
  if (!envelope) return false
  const body = envelope[2].trim()
  return /^Continue working toward the active thread goal\.\s/.test(body)
    && !/<\/?codex_internal_context\b/.test(body)
    && (body.match(/<objective>/g)?.length ?? 0) === 1
    && (body.match(/<\/objective>/g)?.length ?? 0) === 1
    && /<objective>[\s\S]*\S[\s\S]*<\/objective>/.test(body)
}

function hasProviderUserProvenance(event: Event): boolean {
  // Preserve aliases retained by older importers without treating arbitrary
  // message text as origin authority.
  const fields = event as unknown as Record<string, unknown>
  if (event.provider_user_authored === true) return true
  if (['clientUserMessageId', 'clientId', 'client_user_message_id', 'client_id']
    .some(key => typeof fields[key] === 'string' && (fields[key] as string).trim())) return true
  return ['origin', 'provider_origin'].some(key => {
    const origin = fields[key]
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false
    const value = origin as Record<string, unknown>
    return typeof value.kind === 'string'
      && ['human', 'user', 'user_input', 'user-input'].includes(value.kind)
  })
}

export function isImportedProviderControlMetadata(event: Event): boolean {
  return isImportedProviderInterruption(event) || isImportedClaudeControlCompanion(event) || isImportedCodexGoalContext(event)
}

/**
 * A proven in-place repair must survive a stale history/live copy of the same
 * imported turn. All other collisions keep the caller's incoming precedence.
 */
export function mergeProviderInterruptionEvent(current: Event, incoming: Event): Event {
  if (current.id !== incoming.id || current.session_id !== incoming.session_id) return incoming
  if (
    isImportedCodexGoalContext(current)
    && incoming.seq === current.seq
    && incoming.type === current.type
    && incoming.run_id === current.run_id
    && incoming.imported === true
    && incoming.backend === 'codex'
    && incoming.metadata_only == null
    && incoming.provider_runtime_context == null
    && !hasProviderUserProvenance(incoming)
    && (incoming.prompt == null || typeof incoming.prompt === 'string')
    && (!incoming.prompt?.trim() || isExactGoalRuntimePrompt(incoming.prompt.trim()))
  ) return current
  if (
    isImportedProviderInterruption(current)
    && incoming.type === 'turn_started'
    && incoming.imported === true
    && incoming.backend === 'claude'
  ) return current
  if (
    isImportedClaudeControlCompanion(current)
    && incoming.seq === current.seq
    && incoming.type === current.type
    && incoming.run_id === current.run_id
    && incoming.backend === 'claude'
    && incoming.metadata_only == null
    && (incoming.imported === true || (incoming.type === 'history_imported' && incoming.imported == null))
  ) return current
  return incoming
}
