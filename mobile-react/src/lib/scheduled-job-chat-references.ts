import type { ChatReference, Health } from '../types'
import { routeHintMentionsAvailable, validChatReferences } from './chat-references'

export const MAX_SCHEDULED_CHAT_REFERENCES = 16

export function scheduledJobChatReferencesAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.scheduled_jobs
  return capability?.available === true
    && Number(capability.version ?? 1) >= 3
    && capability.features?.chat_references === true
}

export function scheduledJobRouteHintsAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.scheduled_jobs
  return scheduledJobChatReferencesAvailable(health)
    && Number(capability?.version ?? 1) >= 5
    && capability?.features?.route_hint_mentions === true
    && routeHintMentionsAvailable(health)
}

/**
 * Editing support, not mere storage support, controls whether mobile may send
 * this field. Omitting it preserves legacy references byte-for-byte on older
 * servers instead of accidentally replacing them with an empty array.
 */
export function scheduledJobChatReferencesForWrite(
  health: Health | null | undefined,
  references: readonly ChatReference[],
): ChatReference[] | undefined {
  return scheduledJobRouteHintsAvailable(health) ? [...references] : undefined
}

/**
 * Scheduled jobs store an exact, local route grant. Ordinary composer route
 * intent is deliberately stripped because the scheduler owns the grant for
 * each occurrence instead of mutating the source chat's durable route set.
 */
export function normalizeScheduledJobChatReferences(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId: string,
): ChatReference[] {
  return validChatReferences(text, references, sourceSessionId)
    .filter(reference => reference.action === 'route')
    .map(reference => {
      const normalized: ChatReference = { ...reference }
      delete normalized.grant_intent
      return normalized
    })
    .slice(0, MAX_SCHEDULED_CHAT_REFERENCES)
}
