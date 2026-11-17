import type { Backend, Event as SessionEvent, ProfileBootstrapPayload } from '@shared/types'
import { SUBMISSION_REJECTED_PREFIX } from '@shared/server-errors'
import { trackEvent, type AnalyticsEvent } from './analytics'

// Per-renderer milestones, not a new user/session identifier. All ownership
// keys below stay in memory and are never properties in an analytics payload.
const milestones = new Set<AnalyticsEvent>()
export function trackMilestone(name: 'app_launched' | 'app_initialized' | 'app_server_ready' | 'app_first_message_accepted' | 'app_first_reply_observed', success?: boolean): void {
  if (milestones.has(name)) return
  milestones.add(name)
  trackEvent(name, success === undefined ? undefined : { success })
}

// Main deduplicates unchanged connection notifications. A foreground refresh
// can therefore validate Health without emitting another notification. Only a
// check performed during this request counts; a cached bootstrap never does.
export function observeFreshServerReady(payload: ProfileBootstrapPayload, requestedAt: number, minimumApi: number): void {
  const profile = payload.profiles.find(value => value.id === payload.activeProfileId)
  if (profile?.connectionState !== 'online' || typeof payload.healthCheckedAt !== 'number'
    || payload.healthCheckedAt < requestedAt || payload.health?.ok !== true
    || payload.health.chat_readiness?.ready === false
    || (payload.health.api_contract_version ?? minimumApi) < minimumApi) return
  trackMilestone('app_server_ready')
}

type Owner = { profileId: string | null; generation: number; sessionId: string }
type Pending = Owner & { created: number; runId?: string; queuedId?: string; backend: Backend }
const awaitingReply: Pending[] = []
const sameOwner = (a: Owner, b: Owner) => a.profileId === b.profileId && a.generation === b.generation && a.sessionId === b.sessionId

/** One IPC submission, after local validation. Never retries the message. */
export function beginMessageObservation(owner: Owner, backend: Backend): {
  accepted(event?: SessionEvent | null, queuedId?: string): void
  failed(error: unknown): void
} {
  trackEvent('message_submission_attempted', { backend })
  let settled = false
  return {
    accepted(event, queuedId) {
      if (settled) return
      settled = true
      const receipt = event?.session_id === owner.sessionId && ['turn_started', 'turn_queued', 'user_message'].includes(event.type)
      const accepted = Boolean(receipt || queuedId)
      trackEvent('message_submission_settled', { backend, outcome: accepted ? 'accepted' : 'unknown' })
      if (!accepted) return
      trackMilestone('app_first_message_accepted')
      if (milestones.has('app_first_reply_observed')) return
      // Queue ownership is not the currently running turn. Bind only when the
      // exact queued id later appears in a turn_started event.
      const acceptedQueue = queuedId || (receipt ? event?.queued_id ?? undefined : undefined)
      awaitingReply.push({ ...owner, backend, created: Date.now(), queuedId: acceptedQueue,
        // A user_message receipt with an exact run id is also supported by
        // this observer; accepting it without binding the run loses replies.
        runId: receipt && !acceptedQueue && event?.type !== 'turn_queued' ? event?.run_id ?? undefined : undefined })
      if (awaitingReply.length > 32) awaitingReply.shift()
    },
    failed(error) {
      if (settled) return
      settled = true
      // A transport failure cannot prove rejection. Only the native bridge's
      // explicit HTTP 4xx marker proves the server rejected this submission.
      const text = error instanceof Error ? error.message : ''
      const rejected = text.startsWith(SUBMISSION_REJECTED_PREFIX)
        || /^Error invoking remote method ['"]turns:send['"]:\s*(?:Error:\s*)?\[submission_rejected\] /.test(text)
      trackEvent('message_submission_settled', { backend, outcome: rejected ? 'rejected' : 'unknown' })
    }
  }
}

export function observeReply(owner: Owner, event: SessionEvent): void {
  if (milestones.has('app_first_reply_observed') || event.session_id !== owner.sessionId
    || event.imported || event.forked || event.metadata_only) return
  for (let index = awaitingReply.length - 1; index >= 0; index--) {
    const pending = awaitingReply[index]
    if (Date.now() - pending.created > 30 * 60_000) { awaitingReply.splice(index, 1); continue }
    if (!sameOwner(pending, owner)) continue
    if (event.type === 'turn_started' && pending.queuedId && event.queued_id === pending.queuedId && event.run_id) pending.runId = event.run_id
    if (!pending.runId || pending.runId !== event.run_id) continue
    const text = event.type === 'assistant_text' ? event.text : event.type === 'turn_finished' ? event.result_text : null
    // Legacy providers omit phase. Explicit reasoning/commentary or unknown
    // future phases must not inflate the user-facing answer milestone.
    if (typeof text === 'string' && text.trim() && (!event.phase || event.phase === 'final_answer')) {
      trackMilestone('app_first_reply_observed')
      awaitingReply.length = 0
      return
    }
  }
}
