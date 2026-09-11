import { describe, expect, it } from 'vitest'
import type { Health, ServerUpdateStatus } from '@shared/types'
import {
  parseServerUpdateIntents,
  readServerUpdateIntents,
  serverUpdateIntentHealthResolved,
  serverUpdateIntentKey,
  serverUpdateIntentResolved,
  serverUpdateStartErrorIsAmbiguous,
  type ServerUpdateIntent
} from './server-update-intent'

const intent: ServerUpdateIntent = {
  attemptId: 'attempt-1',
  profileId: 'profile-a',
  serverIdentity: 'server-a',
  serverUrl: 'https://server-a.example',
  version: '0.1.26-beta.46',
  track: 'beta',
  submittedAt: Date.parse('2026-09-09T10:00:00Z'),
  startingVersion: '0.1.26-beta.45',
  baselineUpdateId: 'old-update',
  baselineScheduleId: 'old-schedule',
  baselineTimestamp: '2026-09-09T09:59:59Z'
}

const key = serverUpdateIntentKey(intent.profileId, intent.serverIdentity, intent.serverUrl)
const status: ServerUpdateStatus = {
  phase: 'installing',
  current_version: intent.startingVersion,
  server_identity: intent.serverIdentity,
  target_version: intent.version,
  track: intent.track
}

describe('durable server update intent parsing', () => {
  it('round trips only the allowlisted intent fields', () => {
    const stored = { ...intent, accessToken: 'must-not-survive', payload: { secret: true } }
    expect(parseServerUpdateIntents(JSON.stringify({ [key]: stored }))).toEqual({ [key]: intent })
    expect(readServerUpdateIntents).toBe(parseServerUpdateIntents)
  })

  it('keeps changes to a profile identity or URL as separate bindings', () => {
    const other = { ...intent, serverIdentity: 'server-b', serverUrl: 'https://server-b.example' }
    const otherKey = serverUpdateIntentKey(other.profileId, other.serverIdentity, other.serverUrl)
    expect(otherKey).not.toBe(key)
    expect(Object.keys(parseServerUpdateIntents(JSON.stringify({ [key]: intent, [otherKey]: other })))).toEqual([key, otherKey])
    expect(parseServerUpdateIntents(JSON.stringify({ [key]: other }))).toEqual({})
    expect(parseServerUpdateIntents(JSON.stringify({ [intent.profileId]: intent }))).toEqual({})
  })

  it.each([null, '', '{', '[]', 'null', '42', '"string"', ' '.repeat(1024 * 1024 + 1)])('rejects malformed or oversized storage (%#)', raw => {
    expect(parseServerUpdateIntents(raw)).toEqual({})
  })

  it.each([
    { attemptId: '' }, { profileId: '' }, { serverIdentity: '' }, { version: '' },
    { version: 'v'.repeat(129) }, { track: 'nightly' }, { submittedAt: null },
    { submittedAt: -1 }, { submittedAt: 0.5 }, { submittedAt: Number.MAX_VALUE },
    { serverUrl: 'file:///tmp/server' }, { serverUrl: 'https://user:secret@server.example' },
    { serverUrl: 'https://server.example?token=secret' }, { serverUrl: 'not a URL' }
  ])('rejects invalid required data (%#)', patch => {
    const candidate = { ...intent, ...patch }
    const candidateKey = serverUpdateIntentKey(candidate.profileId, candidate.serverIdentity, candidate.serverUrl)
    expect(parseServerUpdateIntents(JSON.stringify({ [candidateKey]: candidate }))).toEqual({})
  })

  it('discards malformed optional metadata without losing the acknowledgement guard', () => {
    const { baselineUpdateId: _update, baselineScheduleId: _schedule, baselineTimestamp: _time, ...required } = intent
    expect(parseServerUpdateIntents(JSON.stringify({ [key]: {
      ...required, baselineUpdateId: {}, baselineScheduleId: 'x'.repeat(257), baselineTimestamp: 'not a date'
    } }))).toEqual({ [key]: required })
  })

  it('never treats malformed baseline IDs as proof that an old terminal receipt is new', () => {
    const restored = parseServerUpdateIntents(JSON.stringify({ [key]: { ...intent, baselineUpdateId: {} } }))[key]
    expect(restored).toBeDefined()
    expect(restored.baselineTimestamp).toBeUndefined()
    expect(serverUpdateIntentResolved(restored, {
      ...status, phase: 'complete', update_id: 'old-update', updated_at: '2026-09-09T10:00:01Z'
    })).toBe(false)
  })

  it('ignores inherited-property names and does not pollute the returned map', () => {
    const parsed = parseServerUpdateIntents('{"__proto__":{"polluted":true},"constructor":{},"prototype":{}}')
    expect(parsed).toEqual({})
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('server update intent receipts', () => {
  it.each(['pending', 'starting', 'checking', 'downloading', 'verifying', 'installing', 'restarting'] as const)('accepts matching live %s work', phase => {
    expect(serverUpdateIntentResolved(intent, { ...status, phase })).toBe(true)
  })

  it.each(['pending', 'starting', 'checking', 'downloading', 'verifying', 'installing', 'restarting'] as const)('rejects known earlier %s receipts unless another receipt ID advances', phase => {
    expect(serverUpdateIntentResolved(intent, { ...status, phase, update_id: intent.baselineUpdateId })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, phase, schedule_id: intent.baselineScheduleId })).toBe(false)
    expect(serverUpdateIntentResolved(intent, {
      ...status, phase, update_id: intent.baselineUpdateId, schedule_id: intent.baselineScheduleId
    })).toBe(false)
    expect(serverUpdateIntentResolved(intent, {
      ...status, phase, update_id: 'new-update', schedule_id: intent.baselineScheduleId
    })).toBe(true)
    expect(serverUpdateIntentResolved(intent, {
      ...status, phase, update_id: intent.baselineUpdateId, schedule_id: 'new-schedule'
    })).toBe(true)
  })

  it.each(['idle', 'current', 'available', 'unavailable'] as const)('never treats %s catalogue state as acceptance', phase => {
    expect(serverUpdateIntentResolved(intent, {
      ...status, phase, current_version: intent.version, installed_version: intent.version,
      update_id: 'new-update', updated_at: '2026-09-09T10:00:01Z'
    })).toBe(false)
  })

  it('requires the matching target, channel and any advertised identity', () => {
    expect(serverUpdateIntentResolved(intent, { ...status, target_version: '0.1.25' })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, track: 'stable' })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, track: undefined })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, server_identity: 'server-b' })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, target_version: undefined, latest_version: intent.version })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...status, server_identity: undefined })).toBe(true)
    expect(serverUpdateIntentResolved(intent, null)).toBe(false)
  })

  it('permits an omitted track only for an exact stable legacy target', () => {
    const stableIntent = { ...intent, version: '0.1.25', track: 'stable' as const }
    expect(serverUpdateIntentResolved(stableIntent, { ...status, target_version: stableIntent.version, track: undefined })).toBe(true)
    expect(serverUpdateIntentResolved({ ...intent, track: 'stable' }, { ...status, track: undefined })).toBe(false)
  })

  it.each(['failed', 'complete'] as const)('requires a new receipt and server-relative freshness for %s', phase => {
    const receipt = { ...status, phase, update_id: 'new-update', started_at: '2026-09-09T10:00:01Z', finished_at: '2026-09-09T10:00:02Z' }
    expect(serverUpdateIntentResolved(intent, receipt)).toBe(true)
    expect(serverUpdateIntentResolved(intent, { ...receipt, update_id: intent.baselineUpdateId })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...receipt, update_id: undefined })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...receipt, started_at: intent.baselineTimestamp })).toBe(true)
    expect(serverUpdateIntentResolved(intent, { ...receipt, started_at: '2026-09-09T09:00:00Z' })).toBe(false)
    expect(serverUpdateIntentResolved({ ...intent, baselineTimestamp: undefined }, receipt)).toBe(false)
    expect(serverUpdateIntentResolved({ ...intent, baselineTimestamp: 'invalid' }, receipt)).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...receipt, started_at: undefined, finished_at: undefined, checked_at: '2026-09-09T11:00:00Z' })).toBe(false)
  })

  it.each(['failed', 'complete'] as const)('accepts a new same-second %s receipt but not an old receipt with the same timestamp', phase => {
    const receipt = { ...status, phase, update_id: 'new-update', updated_at: intent.baselineTimestamp }
    expect(serverUpdateIntentResolved(intent, receipt)).toBe(true)
    expect(serverUpdateIntentResolved(intent, { ...receipt, update_id: intent.baselineUpdateId })).toBe(false)
    expect(serverUpdateIntentResolved(intent, { ...receipt, update_id: undefined })).toBe(false)
  })

  it('accepts a new schedule receipt but not an unchanged reservation', () => {
    const receipt = { ...status, phase: 'failed' as const, schedule_id: 'new-schedule', pending_at: '2026-09-09T10:00:01Z' }
    expect(serverUpdateIntentResolved(intent, receipt)).toBe(true)
    expect(serverUpdateIntentResolved(intent, { ...receipt, schedule_id: intent.baselineScheduleId })).toBe(false)
  })

  it('ignores client clock skew and refuses a missing server baseline', () => {
    const receipt = { ...status, phase: 'complete' as const, update_id: 'new-update', updated_at: '2026-09-09T10:00:01Z' }
    expect(serverUpdateIntentResolved({ ...intent, submittedAt: Date.parse('2030-01-01T00:00:00Z') }, receipt)).toBe(true)
    expect(serverUpdateIntentResolved({ ...intent, submittedAt: 0, baselineTimestamp: undefined }, receipt)).toBe(false)
  })
})

describe('server update intent health evidence', () => {
  const health: Health = { ok: true, server_identity: intent.serverIdentity, server_version: intent.version }

  it('accepts only a connected, healthy exact identity newly running the target version', () => {
    expect(serverUpdateIntentHealthResolved(intent, health, true)).toBe(true)
    expect(serverUpdateIntentHealthResolved(intent, health, false)).toBe(false)
    expect(serverUpdateIntentHealthResolved(intent, { ...health, ok: false }, true)).toBe(false)
    expect(serverUpdateIntentHealthResolved(intent, { ...health, server_identity: 'server-b' }, true)).toBe(false)
    expect(serverUpdateIntentHealthResolved(intent, { ...health, server_version: intent.startingVersion }, true)).toBe(false)
    expect(serverUpdateIntentHealthResolved({ ...intent, startingVersion: intent.version }, health, true)).toBe(false)
    expect(serverUpdateIntentHealthResolved({ ...intent, startingVersion: '' }, health, true)).toBe(false)
    expect(serverUpdateIntentHealthResolved(intent, null, true)).toBe(false)
  })
})

describe('server update start ambiguity', () => {
  it.each([
    'Server update request timed out.', 'AbortError', 'fetch failed', 'ECONNRESET', 'ENOTFOUND',
    'ETIMEDOUT', 'Socket closed', 'Network disconnected', 'Invalid JSON response',
    'HTTP 408 Request Timeout', 'HTTP 502 Bad Gateway', 'HTTP 503 Service Unavailable',
    'Server profile switch superseded this operation.',
    'AgentsServer returned update state for a different server instance. Refresh Settings before retrying.',
    'An unfamiliar failure'
  ])('preserves unknown acceptance for %s', message => {
    expect(serverUpdateStartErrorIsAmbiguous(new Error(message))).toBe(true)
  })

  it.each([400, 401, 403, 404, 409, 422, 429])('recognizes an authoritative HTTP %s rejection', status => {
    expect(serverUpdateStartErrorIsAmbiguous({ status, message: 'Rejected' })).toBe(false)
    expect(serverUpdateStartErrorIsAmbiguous(new Error(`HTTP ${status}: Rejected`))).toBe(false)
  })

  it('recognizes explicit local preflight rejections and wrapped HTTP errors', () => {
    expect(serverUpdateStartErrorIsAmbiguous(new Error('Update or reconnect AgentsServer before starting a managed update.'))).toBe(false)
    expect(serverUpdateStartErrorIsAmbiguous(new Error('Update or reconnect AgentsServer before starting or canceling a managed update.'))).toBe(false)
    expect(serverUpdateStartErrorIsAmbiguous(new Error("Error invoking remote method 'server:update:start': Error: 403 Forbidden"))).toBe(false)
    expect(serverUpdateStartErrorIsAmbiguous({ status: 408, message: 'Request Timeout' })).toBe(true)
    expect(serverUpdateStartErrorIsAmbiguous({ status: 503, message: 'Service Unavailable' })).toBe(true)
    expect(serverUpdateStartErrorIsAmbiguous(undefined)).toBe(true)
  })

  it.each([
    'Managed update cannot start because the detached tmux server is inside agents-server.service and would be terminated by the restart. Finish terminal work, stop the tmux daemon, then retry.',
    'Managed update cannot safely start because AgentsServer could not create the default tmux server outside agents-server.service. From a login shell, start a detached tmux session, then retry.',
    "Managed update cannot safely start because AgentsServer could not verify the detached tmux server's cgroup. Retry after confirming tmux is running from a login shell.",
    'Managed update cannot safely start because an untracked process remains inside agents-server.service. Let current provider cleanup finish, then retry.',
    "Could not start detached updater: 409: {'code': 'unsafe_update_service_cgroup', 'message': 'An attachment is still closing.'}",
    "Could not start detached updater: 409: {'code': 'unsafe_update_tmux_cgroup', 'message': 'Unsafe tmux topology.'}",
    "Error invoking remote method 'server:update:start': Error: Could not start detached updater: 409: {'code': 'unsafe_update_service_cgroup', 'message': 'An attachment is still closing.'}"
  ])('recognizes only known topology admission rejections (%#)', message => {
    expect(serverUpdateStartErrorIsAmbiguous(new Error(message))).toBe(false)
  })

  it.each([
    'Managed update cannot safely start for an unfamiliar reason.',
    'Could not start detached updater: connection lost',
    "Could not start detached updater: 500: {'code': 'unsafe_update_service_cgroup'}",
    "Could not start detached updater: 409: {'code': 'unfamiliar_update_failure'}",
    "Could not start detached updater: {'code': 'unsafe_update_tmux_cgroup'}"
  ])('keeps unfamiliar or non-authoritative updater failures ambiguous (%#)', message => {
    expect(serverUpdateStartErrorIsAmbiguous(new Error(message))).toBe(true)
  })
})
