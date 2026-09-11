import type { Event, Health, QueuedCrossChatDeliveryIdentity, QueuedTurn } from '../types'
import { crossChatCapabilityVersion, crossChatHandoffsAvailable, exactQueuedDeliverySkipAvailable } from './chat-references'
import { isAsyncCrossChatMessage } from './timeline'

export function isUserQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose !== 'handoff_digest'
    && turn.purpose !== 'handoff_digest_delivery'
    && turn.purpose !== 'cross_chat_handoff_delivery'
    && turn.purpose !== 'secure_peer_handoff_delivery'
}

export function isCrossChatDeliveryQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose === 'cross_chat_handoff_delivery'
}

export function isDeliveryBarrierQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose === 'cross_chat_handoff_delivery'
    || turn.purpose === 'secure_peer_handoff_delivery'
}

export function isVisibleQueuedTurn(turn: QueuedTurn): boolean {
  // Delivery lifecycle belongs to the chronological timeline. Keep delivery
  // turns in the raw queue for FIFO fencing, but never duplicate them in the
  // user-editable composer shelf.
  return isUserQueuedTurn(turn) || isAsyncQueuedChatMessage(turn)
}

export function isAsyncQueuedChatMessage(turn: QueuedTurn): boolean {
  return turn.purpose === 'cross_chat_handoff_delivery' && turn.conversation_mode === 'async_route_v1'
}

/** Bind Skip to one advertised durable owner, never to position or prompt text. */
export function queuedDeliverySkipIdentity(turn: QueuedTurn, health: Health | null | undefined): QueuedCrossChatDeliveryIdentity | null {
  if (!turn.queued_id.trim() || turn.promoted || !crossChatHandoffsAvailable(health)) return null
  if (turn.purpose === 'secure_peer_handoff_delivery') {
    const envelope = turn.secure_peer_envelope_id?.trim()
    return crossChatCapabilityVersion(health) >= 10
      && health?.capabilities?.cross_chat_handoffs_v1?.features?.exact_queued_peer_delivery_skip === true
      && envelope ? { secure_peer_envelope_id: envelope } : null
  }
  if (turn.purpose !== 'cross_chat_handoff_delivery' || !exactQueuedDeliverySkipAvailable(health)) return null
  const envelope = turn.cross_chat_envelope_id?.trim() || null
  const exchange = turn.cross_chat_exchange_id?.trim() || null
  const leg = turn.cross_chat_exchange_leg_id?.trim() || null
  return envelope || (exchange && leg)
    ? { cross_chat_envelope_id: envelope, cross_chat_exchange_id: exchange, cross_chat_exchange_leg_id: leg }
    : null
}

/** Public lifecycle events trigger an authoritative queue read only in the target chat. */
export function crossChatQueueRefreshSessionId(event: Event): string | null {
  if (!event.queued_id || event.session_id !== event.target_session_id) return null
  return event.type.startsWith('cross_chat_handoff_') || event.type.startsWith('cross_chat_exchange_leg_') || isAsyncCrossChatMessage(event)
    ? event.session_id : null
}

/** A server-confirmed user message delivered within the current native goal run. */
export function isNativeGoalSteerEvent(event: Event): boolean {
  return event.type === 'turn_steered'
    && event.native_goal_steer === true
    && event.native_steer === true
    && event.backend === 'codex'
    && event.purpose === 'codex_goal_resume'
    && event.provider_user_authored === true
    && Boolean(event.run_id?.trim())
}

/** Positions cannot prove removal: a membership gap requests a full public queue read. */
export function queueSnapshotRequiresRefresh(event: Event, current: readonly QueuedTurn[]): boolean {
  if (event.type !== 'queue_snapshot' || !Array.isArray(event.positions)) return false
  const ids = new Set<string>()
  for (const item of event.positions) {
    if (!item || typeof item.queued_id !== 'string' || !item.queued_id.trim()
      || item.queued_id !== item.queued_id.trim() || ids.has(item.queued_id)
      || !Number.isSafeInteger(item.position) || item.position < 0) return true
    ids.add(item.queued_id)
  }
  return ids.size !== current.length || current.some(turn => !ids.has(turn.queued_id))
}

export function queuedTurnHasEarlierDeliveryBarrier(turns: readonly QueuedTurn[], queuedId: string): boolean {
  const ordered = orderedQueuedTurns(turns)
  const index = ordered.findIndex(turn => turn.queued_id === queuedId)
  return index > 0 && ordered.slice(0, index).some(isDeliveryBarrierQueuedTurn)
}

export function queuedMoveCrossesDeliveryBarrier(
  turns: readonly QueuedTurn[],
  queuedIdOrIndex: string | number,
  direction: 'up' | 'down',
): boolean {
  const queuedId = typeof queuedIdOrIndex === 'number' ? turns[queuedIdOrIndex]?.queued_id : queuedIdOrIndex
  if (!queuedId) return false
  const ordered = orderedQueuedTurns(turns)
  const index = ordered.findIndex(turn => turn.queued_id === queuedId)
  if (index < 0) return false
  const adjacent = ordered[index + (direction === 'up' ? -1 : 1)]
  return Boolean(adjacent && (isDeliveryBarrierQueuedTurn(ordered[index]) || isDeliveryBarrierQueuedTurn(adjacent)))
}

export function updateQueuedTurns(current: QueuedTurn[], event: Event): QueuedTurn[] {
  if ((event.type === 'turn_queued' || event.type === 'turn_queue_delivery_fenced') && event.queued_id) {
    const prompt = event.display_prompt ?? event.prompt ?? event.request_prompt ?? ''
    const turn: QueuedTurn = {
      queued_id: event.queued_id,
      session_id: event.session_id,
      prompt,
      display_prompt: prompt,
      file_ids: event.display_file_ids ?? event.file_ids ?? [],
      backend: event.backend,
      model: event.model,
      effort: event.effort,
      position: event.position ?? (event.type === 'turn_queue_delivery_fenced' ? 0 : null),
      purpose: event.purpose,
      digest_job_id: event.digest_job_id,
      source_session_id: event.source_session_id,
      target_session_id: event.target_session_id,
      source_title: event.source_title,
      conversation_mode: event.conversation_mode,
      cross_chat_envelope_id: event.cross_chat_envelope_id,
      cross_chat_exchange_id: event.cross_chat_exchange_id,
      cross_chat_exchange_leg_id: event.cross_chat_exchange_leg_id,
      cross_chat_exchange_status: event.cross_chat_exchange_status,
      secure_peer_envelope_id: event.secure_peer_envelope_id,
      promoted: event.promoted,
      chat_references: event.chat_references,
      team_references: event.team_references,
      created_at: event.ts,
      paused: event.paused,
      pause_reason: event.pause_reason,
    }
    return [...current.filter(value => value.queued_id !== turn.queued_id), turn].sort(queueSort)
  }
  if ((event.type === 'turn_unqueued' || event.type === 'turn_started' || isNativeGoalSteerEvent(event)) && event.queued_id) {
    return removeQueuedIds(current, new Set([event.queued_id]))
  }
  if (event.type === 'turn_queue_run_now' && event.queued_id) {
    return removeQueuedIds(current, new Set([event.queued_id, ...(event.superseded_queued_ids ?? [])]))
  }
  if (event.type === 'turn_queue_updated' && event.queued_id) {
    return current.map(value => value.queued_id === event.queued_id ? {
      ...value,
      prompt: event.prompt ?? value.prompt,
      display_prompt: event.prompt ?? value.display_prompt,
      file_ids: event.file_ids ?? value.file_ids,
      chat_references: event.chat_references ?? value.chat_references,
      team_references: event.team_references ?? value.team_references,
      position: event.position ?? value.position,
      paused: event.paused ?? value.paused,
      pause_reason: event.pause_reason ?? value.pause_reason,
    } : value).sort(queueSort)
  }
  if (event.type === 'turn_queue_paused' && event.queued_id) {
    return current.map(value => value.queued_id === event.queued_id ? {
      ...value,
      paused: event.paused ?? true,
      pause_reason: event.pause_reason ?? value.pause_reason,
    } : value)
  }
  if (Array.isArray(event.positions) && event.positions.length) {
    const positions = new Map(event.positions
      .filter(value => value && typeof value.queued_id === 'string'
        && Number.isSafeInteger(value.position) && value.position >= 0)
      .map(value => [value.queued_id, value.position]))
    return current.map(value => ({ ...value, position: positions.get(value.queued_id) ?? value.position })).sort(queueSort)
  }
  return current
}

export function resolveNewQueuedTurn(prompt: string, previousIds: ReadonlySet<string>, turns: readonly QueuedTurn[]): string | null {
  const created = turns.filter(turn => !previousIds.has(turn.queued_id))
  const cleanPrompt = prompt.trim()
  return created.find(turn => (turn.display_prompt || turn.prompt).trim() === cleanPrompt)?.queued_id
    ?? (created.length === 1 ? created[0].queued_id : null)
}

function queueSort(left: QueuedTurn, right: QueuedTurn): number {
  return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
}

function removeQueuedIds(current: QueuedTurn[], ids: ReadonlySet<string>): QueuedTurn[] {
  return current.some(turn => ids.has(turn.queued_id))
    ? current.filter(turn => !ids.has(turn.queued_id))
    : current
}

function orderedQueuedTurns(turns: readonly QueuedTurn[]): QueuedTurn[] {
  return [...turns].sort(queueSort)
}
