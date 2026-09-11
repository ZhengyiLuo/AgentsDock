import { getLocale, t } from '@shared/i18n'
import { titleCase } from './format'

const statusKeys: Record<string, string> = {
  starting: 'starting', running: 'running', active: 'active', stopped: 'stopped',
  success: 'success', succeeded: 'success', failed: 'failed', error: 'failed',
  queued: 'queued', pending: 'queued', deferred: 'deferred', completed: 'completed',
  complete: 'completed', cancelled: 'cancelled', canceled: 'cancelled', updated: 'updated',
  requested: 'requested', resolved: 'resolved', answered: 'resolved', approved: 'approved',
  rejected: 'rejected', denied: 'rejected', expired: 'expired', submitted: 'submitted',
  registered: 'registered', submitting: 'submitting', delivered: 'delivered',
  paused: 'paused', blocked: 'blocked', tracking_lost: 'trackingLost', killed: 'killed'
}

const eventKeys: Record<string, string> = {
  session_created: 'sessionCreated', session_updated: 'sessionUpdated',
  session_resumed: 'sessionResumed', session_imported: 'sessionImported',
  user_message: 'userMessage', assistant_message: 'assistantMessage',
  turn_started: 'turnStarted', turn_finished: 'turnFinished', turn_stopped: 'turnStopped',
  tool_started: 'toolStarted', tool_finished: 'toolFinished', error: 'error',
  reasoning_summary: 'reasoningSummary', system: 'system', system_message: 'systemMessage',
  working_directory_changed: 'workingDirectoryChanged',
  handoff_digest_received: 'digestReceived', handoff_digest_sent: 'digestSent',
  handoff_digest_error: 'digestFailed', handoff_digest_started: 'digestStarted'
}

/** Only known semantic fields are translated; arbitrary provider content is never a key. */
export function timelineStatusLabel(status: string): string {
  const key = Object.hasOwn(statusKeys, status) ? statusKeys[status] : undefined
  return key ? t(`timeline.status.${key}`) : titleCase(status)
}

export function timelineEventLabel(type: string): string {
  const key = Object.hasOwn(eventKeys, type) ? eventKeys[type] : undefined
  return key ? t(`timeline.event.${key}`) : titleCase(type)
}

export function timelineCount(kind: string, count: number): string {
  return t(`timeline.count.${kind}.${count === 1 ? 'one' : 'other'}`, { count: count.toLocaleString(getLocale()) })
}
