import type { Event, QueuedTurn } from './types'
import { isImportedProviderControlMetadata } from './provider-origin'
import { isNativeGoalSteerEvent } from './semantic-timeline'

export function updateQueuedTurns(current: QueuedTurn[], event: Event): QueuedTurn[] {
  if (isImportedProviderControlMetadata(event)) return current
  if (event.type === 'turn_queued' && event.queued_id) {
    const next: QueuedTurn = {
      queued_id: event.queued_id,
      session_id: event.session_id,
      prompt: event.prompt || '',
      display_prompt: event.prompt,
      file_ids: event.file_ids || [],
      backend: event.backend,
      position: event.position,
      purpose: event.purpose,
      job_id: event.job_id,
      job_title: event.job_title,
      job_scheduled_run_at: event.job_scheduled_run_at,
      source_session_id: event.source_session_id,
      target_session_id: event.target_session_id,
      chat_references: event.chat_references,
      team_references: event.team_references,
      cross_chat_envelope_id: event.cross_chat_envelope_id,
      secure_peer_envelope_id: event.secure_peer_envelope_id,
      cross_chat_exchange_id: event.cross_chat_exchange_id,
      cross_chat_exchange_leg_id: event.cross_chat_exchange_leg_id,
      cross_chat_exchange_status: event.cross_chat_exchange_status,
      conversation_mode: event.conversation_mode,
      source_title: event.source_title,
      created_at: event.ts,
      paused: false,
      pause_reason: null,
      promoted: event.promoted === true
    }
    return [...current.filter(turn => turn.queued_id !== next.queued_id), next].sort(queueSort)
  }
  if (event.type === 'turn_queue_delivery_fenced' && event.queued_id) {
    const next: QueuedTurn = {
      queued_id: event.queued_id,
      session_id: event.session_id,
      prompt: event.prompt || '',
      display_prompt: event.prompt,
      file_ids: event.file_ids || [],
      backend: event.backend,
      position: event.position,
      purpose: event.purpose,
      source_session_id: event.source_session_id,
      target_session_id: event.target_session_id,
      chat_references: event.chat_references,
      team_references: event.team_references,
      cross_chat_envelope_id: event.cross_chat_envelope_id,
      secure_peer_envelope_id: event.secure_peer_envelope_id,
      cross_chat_exchange_id: event.cross_chat_exchange_id,
      cross_chat_exchange_leg_id: event.cross_chat_exchange_leg_id,
      cross_chat_exchange_status: event.cross_chat_exchange_status,
      conversation_mode: event.conversation_mode,
      source_title: event.source_title,
      created_at: event.ts,
      paused: true,
      pause_reason: 'delivery_uncertain',
      promoted: event.promoted === true
    }
    return [...current.filter(turn => turn.queued_id !== next.queued_id), next].sort(queueSort)
  }
  if (event.type === 'turn_queue_paused') {
    const pausedIds = new Set(event.queued_ids ?? (event.queued_id ? [event.queued_id] : []))
    if (!pausedIds.size) return current
    let changed = false
    const next = current.map(turn => {
      if (
        !pausedIds.has(turn.queued_id)
        || (turn.paused === true && (turn.pause_reason === 'stopped' || turn.pause_reason === 'delivery_uncertain'))
      ) return turn
      changed = true
      return { ...turn, paused: true, pause_reason: 'stopped' as const }
    })
    return changed ? next : current
  }
  if ((event.type === 'turn_unqueued' || event.type === 'turn_started' || isNativeGoalSteerEvent(event)) && event.queued_id) {
    return current.filter(turn => turn.queued_id !== event.queued_id)
  }
  if (event.type === 'turn_queue_run_now' && event.queued_id) {
    const superseded = new Set(event.superseded_queued_ids ?? [])
    return current
      .filter(turn => !superseded.has(turn.queued_id))
      .map(turn => turn.queued_id === event.queued_id ? {
        ...turn,
        promoted: true,
        paused: false,
        pause_reason: null
      } : turn)
  }
  if (event.type === 'turn_queue_updated' && event.queued_id) {
    return current.map(turn => turn.queued_id === event.queued_id ? {
      ...turn,
      prompt: event.prompt ?? turn.prompt,
      display_prompt: event.prompt ?? turn.display_prompt,
      file_ids: event.file_ids ?? turn.file_ids,
      chat_references: event.chat_references ?? turn.chat_references,
      team_references: event.team_references ?? turn.team_references,
      conversation_mode: event.conversation_mode ?? turn.conversation_mode,
      source_title: event.source_title ?? turn.source_title,
      position: event.position ?? turn.position
    } : turn).sort(queueSort)
  }
  if (event.positions?.length) {
    const positions = new Map(event.positions.map(item => [item.queued_id, item.position]))
    return current.map(turn => ({ ...turn, position: positions.get(turn.queued_id) ?? turn.position })).sort(queueSort)
  }
  return current
}

function queueSort(a: QueuedTurn, b: QueuedTurn): number {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
}
