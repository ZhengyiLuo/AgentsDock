import type { Event, QueuedTurn } from './types'

export function updateQueuedTurns(current: QueuedTurn[], event: Event): QueuedTurn[] {
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
      created_at: event.ts
    }
    return [...current.filter(turn => turn.queued_id !== next.queued_id), next].sort(queueSort)
  }
  if ((event.type === 'turn_unqueued' || event.type === 'turn_started') && event.queued_id) {
    return current.filter(turn => turn.queued_id !== event.queued_id)
  }
  if (event.type === 'turn_queue_updated' && event.queued_id) {
    return current.map(turn => turn.queued_id === event.queued_id ? {
      ...turn,
      prompt: event.prompt ?? turn.prompt,
      display_prompt: event.prompt ?? turn.display_prompt,
      file_ids: event.file_ids ?? turn.file_ids,
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
