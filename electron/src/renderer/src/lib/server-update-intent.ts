import type { Health, ServerUpdateStatus, ServerUpdateTrack } from '@shared/types'

/** A local acknowledgement guard, never a request to replay an update. */
export interface ServerUpdateIntent {
  attemptId: string
  profileId: string
  serverIdentity: string
  serverUrl: string
  version: string
  track: ServerUpdateTrack
  submittedAt: number
  startingVersion: string
  baselineUpdateId?: string
  baselineScheduleId?: string
  /** Latest timestamp from the server status captured before submission. */
  baselineTimestamp?: string
}

const MAX_STORED_CHARACTERS = 1024 * 1024
const MAX_STORED_INTENTS = 256
const ACTIVE_PHASES = new Set<ServerUpdateStatus['phase']>([
  'pending', 'starting', 'checking', 'downloading', 'verifying', 'installing', 'restarting'
])
const UPDATE_TOPOLOGY_REJECTIONS = new Set([
  'Managed update cannot start because the detached tmux server is inside agents-server.service and would be terminated by the restart. Finish terminal work, stop the tmux daemon, then retry.',
  'Managed update cannot safely start because AgentsServer could not create the default tmux server outside agents-server.service. From a login shell, start a detached tmux session, then retry.',
  "Managed update cannot safely start because AgentsServer could not verify the detached tmux server's cgroup. Retry after confirming tmux is running from a login shell.",
  'Managed update cannot safely start because an untracked process remains inside agents-server.service. Let current provider cleanup finish, then retry.'
])

export function serverUpdateIntentKey(profileId: string, serverIdentity: string, serverUrl: string): string {
  return JSON.stringify([profileId, serverIdentity, serverUrl])
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.length > 0)
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function serverTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function safeServerUrl(value: unknown): value is string {
  if (!boundedString(value, 4096)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

/** Read only the allowlisted intent fields; credentials and arbitrary payloads never survive. */
export function parseServerUpdateIntents(raw: string | null): Record<string, ServerUpdateIntent> {
  const intents: Record<string, ServerUpdateIntent> = {}
  if (!raw || raw.length > MAX_STORED_CHARACTERS) return intents
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return intents }
  if (!record(parsed)) return intents
  for (const [key, value] of Object.entries(parsed).slice(0, MAX_STORED_INTENTS)) {
    if (!record(value)
      || !boundedString(value.attemptId, 256)
      || !boundedString(value.profileId, 256)
      || !boundedString(value.serverIdentity, 256)
      || !safeServerUrl(value.serverUrl)
      || !boundedString(value.version, 128)
      || !boundedString(value.startingVersion, 128, true)
      || (value.track !== 'stable' && value.track !== 'beta')
      || typeof value.submittedAt !== 'number'
      || !Number.isSafeInteger(value.submittedAt) || value.submittedAt < 0
      || key !== serverUpdateIntentKey(value.profileId, value.serverIdentity, value.serverUrl)
    ) continue
    const intent: ServerUpdateIntent = {
      attemptId: value.attemptId,
      profileId: value.profileId,
      serverIdentity: value.serverIdentity,
      serverUrl: value.serverUrl,
      version: value.version,
      track: value.track,
      submittedAt: value.submittedAt,
      startingVersion: value.startingVersion
    }
    const invalidBaseline = (value.baselineUpdateId !== undefined && !boundedString(value.baselineUpdateId, 256))
      || (value.baselineScheduleId !== undefined && !boundedString(value.baselineScheduleId, 256))
      || (value.baselineTimestamp !== undefined && serverTimestamp(value.baselineTimestamp) === null)
    // Malformed receipt metadata must not turn an old ID into a "new" one.
    // Keep the guard, but disable terminal resolution until live evidence arrives.
    if (!invalidBaseline) {
      if (boundedString(value.baselineUpdateId, 256)) intent.baselineUpdateId = value.baselineUpdateId
      if (boundedString(value.baselineScheduleId, 256)) intent.baselineScheduleId = value.baselineScheduleId
      if (serverTimestamp(value.baselineTimestamp) !== null) intent.baselineTimestamp = value.baselineTimestamp as string
    }
    intents[key] = intent
  }
  return intents
}

export const readServerUpdateIntents = parseServerUpdateIntents

function matchingTarget(intent: ServerUpdateIntent, status: ServerUpdateStatus): boolean {
  if (status.server_identity !== undefined && status.server_identity !== intent.serverIdentity) return false
  if (status.target_version !== intent.version) return false
  // Old stable servers omit the track. Do not extend this exception to prereleases.
  return status.track === intent.track
    || (status.track === undefined && intent.track === 'stable' && /^v?\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(intent.version))
}

/** The caller must supply status read from the intent's exact, still-current profile binding. */
export function serverUpdateIntentResolved(intent: ServerUpdateIntent, status: ServerUpdateStatus | null | undefined): boolean {
  if (!status || !matchingTarget(intent, status)) return false
  const hasNewReceipt = (boundedString(status.update_id, 256) && status.update_id !== intent.baselineUpdateId)
    || (boundedString(status.schedule_id, 256) && status.schedule_id !== intent.baselineScheduleId)
  const hasBaselineReceipt = (boundedString(status.update_id, 256) && status.update_id === intent.baselineUpdateId)
    || (boundedString(status.schedule_id, 256) && status.schedule_id === intent.baselineScheduleId)
  if (ACTIVE_PHASES.has(status.phase)) {
    // Legacy active statuses may omit IDs, but an explicitly repeated baseline
    // receipt belongs to an earlier attempt unless a second ID has advanced.
    return !hasBaselineReceipt || hasNewReceipt
  }
  if (status.phase !== 'complete' && status.phase !== 'failed') return false

  const baseline = serverTimestamp(intent.baselineTimestamp)
  if (baseline === null) return false
  if (!hasNewReceipt) return false

  // A fresh catalogue check is not a receipt. Require the earliest available
  // receipt timestamp to be no older than the server's pre-submission baseline.
  // Equality is valid because server timestamps can have second granularity;
  // the new receipt ID provides the additional evidence. The client's
  // submittedAt is deliberately not compared with the server clock.
  const receiptTimes = [status.pending_at, status.started_at, status.updated_at, status.finished_at]
    .map(serverTimestamp)
    .filter((value): value is number => value !== null)
  return receiptTimes.length > 0 && Math.min(...receiptTimes) >= baseline
}

/** The caller also guards health snapshot freshness and the exact profile URL. */
export function serverUpdateIntentHealthResolved(intent: ServerUpdateIntent, health: Health | null | undefined, connected: boolean): boolean {
  return connected
    && health?.ok === true
    && health.server_identity === intent.serverIdentity
    && health.server_version === intent.version
    && intent.startingVersion.length > 0
    && intent.startingVersion !== intent.version
}

/** Unknown errors stay ambiguous: losing a response must never authorize a replay. */
export function serverUpdateStartErrorIsAmbiguous(error: unknown): boolean {
  if (record(error) && typeof error.status === 'number' && Number.isInteger(error.status)) {
    if (error.status >= 400 && error.status < 500 && error.status !== 408) return false
  }
  const message = typeof error === 'string'
    ? error
    : record(error) && typeof error.message === 'string' ? error.message : ''
  const httpStatus = message.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*(4\d\d)\b/i)
    ?? message.match(/(?:^|:\s*)(4\d\d)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Gone|Unprocessable (?:Entity|Content)|Too Many Requests)\b/i)
  if (httpStatus && Number(httpStatus[1]) !== 408) return false
  // These exact local preflight errors are raised before sending the POST.
  if (/Update or reconnect AgentsServer before starting(?: or canceling)? a managed update\./.test(message)) return false
  if (message === 'Privileged native control route is invalid.'
    || message === 'The active AgentsServer administrator credential is unavailable.') return false
  if (UPDATE_TOPOLOGY_REJECTIONS.has(message)) return false
  // Legacy servers wrapped these specific admission-time 409s in a generic
  // detached-updater error. Other updater failures can occur after acceptance.
  if (/(?:^|:\s*)Could not start detached updater: 409:\s*\{\s*['"]code['"]:\s*['"]unsafe_update_(?:service|tmux)_cgroup['"](?:\s*,|\s*\})/.test(message)) return false
  return true
}
