import type { Event, QueuedTurn } from '@shared/types'
import type { RenderTimelineItem } from './timeline'
import { isVisibleQueuedTurn } from './queue-actions'

const pendingCrossChatTypes = new Set([
  'cross_chat_exchange_registered', 'cross_chat_exchange_leg_registered',
  'cross_chat_exchange_leg_queued', 'cross_chat_exchange_leg_received',
  'cross_chat_handoff_registered', 'cross_chat_handoff_received',
  'cross_chat_handoff_queued', 'cross_chat_handoff_deferred'
])
const pendingJobTypes = new Set(['job_created', 'job_deferred', 'job_summary', 'turn_queued'])
const pendingStatuses = new Set(['queued', 'pending', 'deferred'])
// "received / submitting" means the server accepted the delivery, not that
// its agent turn started. These predecessors remain in the grouped card.
const preStartStatuses = new Set(['registered', 'submitting', ...pendingStatuses])

function sameDelivery(event: Event, turn: QueuedTurn): boolean {
  if (event.queued_id) return event.queued_id === turn.queued_id
  const envelope = event.handoff_id || event.correlation_id || event.cross_chat_envelope_id
  if (envelope) return envelope === turn.cross_chat_envelope_id
  const exchange = event.exchange_id || event.cross_chat_exchange_id
  const leg = event.exchange_leg_id || event.cross_chat_exchange_leg_id
  return Boolean(exchange && leg && exchange === turn.cross_chat_exchange_id && leg === turn.cross_chat_exchange_leg_id)
}

/** Hide only pending-only cards already represented by an exact visible queue row. */
export function omitQueuedPendingTimelineItems(
  items: RenderTimelineItem[],
  queuedTurns: readonly QueuedTurn[],
  sessionId: string
): RenderTimelineItem[] {
  const queue = queuedTurns.filter(turn => isVisibleQueuedTurn(turn)
    && turn.promoted !== true && (!turn.session_id || turn.session_id === sessionId))
  if (!queue.length) return items
  return items.filter(item => {
    if (item.kind === 'system') {
      const events = item.events ?? [item.event]
      const event = item.event
      if (event.target_session_id !== sessionId || event.source_session_id === sessionId) return true
      if (!events.every(candidate => pendingCrossChatTypes.has(candidate.type)
        && (!candidate.exchange_leg_status || preStartStatuses.has(candidate.exchange_leg_status))
        && (!candidate.exchange_status || ['active', 'waiting_request'].includes(candidate.exchange_status))
        && (!candidate.handoff_status || preStartStatuses.has(candidate.handoff_status)))) return true
      const pending = event.exchange_leg_status === 'queued'
        || pendingStatuses.has(event.handoff_status || '')
        || ['cross_chat_handoff_queued', 'cross_chat_handoff_deferred'].includes(event.type)
      return !pending || !queue.some(turn => turn.purpose === 'cross_chat_handoff_delivery'
        && (!turn.target_session_id || turn.target_session_id === sessionId) && sameDelivery(event, turn))
    }
    if (item.kind !== 'job' || item.runCount !== 0) return true
    // A deferred summary can retain an earlier result even when its run events
    // were not loaded. Never hide that history with the new pending occurrence.
    if (!item.events.every(event => pendingJobTypes.has(event.type)
      && !event.run_id && !event.job_latest_run_id && !event.job_status_run_id && !event.job_latest_status_run_id
      && !(event.job_run_count && event.job_run_count > 0)
      && !event.result_text && !event.text && !event.output && !event.artifact && !event.file)) return true
    const event = item.latestStatus ?? item.latest
    const status = event.job_status || event.job_latest_status || event.job_run_status || ''
    if (event.type !== 'job_deferred' && !pendingStatuses.has(status)) return true
    const jobId = item.jobId || event.job_id || event.job?.id
    return !queue.some(turn => turn.purpose === 'scheduled_job' && turn.job_id === jobId && (
      event.queued_id ? event.queued_id === turn.queued_id
        : typeof event.job_scheduled_run_at === 'number' && event.job_scheduled_run_at === turn.job_scheduled_run_at
    ))
  })
}
