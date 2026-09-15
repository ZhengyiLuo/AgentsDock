import { describe, expect, it } from 'vitest'
import { ActivityHealthProjection } from './activity-health'
import type { Event, Health } from '../shared/types'

const scope = 'profile-a:1'
const health = (active: string[] = [], instance = 'boot-a'): Health => ({
  ok: true, server_identity: 'server-a', server_instance_id: instance, active
})
const event = (type: string, seq: number, run = 'run-new'): Event => ({
  id: `evt-${seq}`, session_id: 'chat', seq, run_id: run, type, ts: '2026-09-14T05:09:24Z'
})

describe('health activity freshness', () => {
  it('keeps a streamed start that arrives after the health request began', () => {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, health())
    const request = projection.capture(scope)
    projection.observe(scope, event('turn_started', 10))
    expect(projection.accept(scope, health(), request).active).toEqual(['chat'])
  })

  it('keeps a streamed terminal after a request and lets a genuinely fresh idle sample clear a stale start', () => {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, health(['chat']))
    projection.observe(scope, event('turn_started', 10))
    const beforeStop = projection.capture(scope)
    projection.observe(scope, event('turn_finished', 11))
    expect(projection.accept(scope, health(['chat']), beforeStop).active).toEqual([])
    projection.observe(scope, event('turn_started', 12, 'run-next'))
    expect(projection.accept(scope, health(), projection.capture(scope)).active).toEqual([])
  })

  it('does not reactivate a run from an out-of-order health completion', () => {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, health(['chat']))
    const older = projection.capture(scope)
    projection.observe(scope, event('turn_finished', 11))
    const newer = projection.capture(scope)
    const latest = projection.accept(scope, health(), newer)
    expect(projection.accept(scope, health(['chat']), older)).toBe(latest)
  })

  it('does not carry activity across server boots or profile generations', () => {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, health())
    const oldBootRequest = projection.capture(scope)
    projection.observe(scope, event('turn_started', 10))
    const newBoot = projection.accept(scope, health([], 'boot-b'), projection.capture(scope))
    expect(newBoot.active).toEqual([])
    expect(projection.accept(scope, health(['chat']), oldBootRequest)).toBe(newBoot)
    projection.observe(scope, event('turn_started', 12))
    expect(projection.accept('profile-a:2', health()).active).toEqual([])
  })

  it('ignores imported lifecycle, duplicate sequence and terminals owned by another run', () => {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, health())
    const request = projection.capture(scope)
    projection.observe(scope, event('turn_started', 10))
    for (const stale of [
      event('turn_finished', 9), event('turn_finished', 11, 'run-old'),
      { ...event('turn_finished', 12, 'import_history'), imported: true },
      { ...event('turn_started', 13, 'import_history'), imported: true },
      { ...event('turn_stopped', 14), native_steer: true }
    ]) projection.observe(scope, stale)
    expect(projection.accept(scope, health(), request).active).toEqual(['chat'])
  })

  it('keeps its cached activity current without changing the original response or unrelated fields', () => {
    const projection = new ActivityHealthProjection()
    const incoming = { ...health(), active_sessions: [] }
    projection.accept(scope, incoming)
    const next = projection.observe(scope, event('turn_started', 10))!
    expect(next.active).toEqual(['chat'])
    expect(next.active_sessions).toEqual(['chat'])
    expect(next.server_identity).toBe(incoming.server_identity)
    expect(incoming.active).toEqual([])
    expect(projection.observe(scope, event('reasoning_summary', 11))).toBe(next)
  })

  it('updates run ownership with unchanged active IDs and honors a newer health owner', () => {
    const projection = new ActivityHealthProjection()
    const initial = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'run-old', backend: 'codex' }] }
    projection.accept(scope, initial)
    const request = projection.capture(scope)
    projection.observe(scope, event('turn_started', 10, 'run-new'))
    expect(projection.accept(scope, initial, request).active_runs).toEqual([{ session_id: 'chat', run_id: 'run-new' }])
    const current = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'run-next', backend: 'codex' }] }
    expect(projection.accept(scope, current, projection.capture(scope))).toBe(current)
    expect(projection.observe(scope, event('turn_finished', 11, 'run-new'))).toBe(current)
    expect(projection.observe(scope, event('error', 12, 'run-next'))).toBe(current)
    const finished = projection.observe(scope, event('turn_finished', 13, 'run-next'))!
    expect(finished.active).toEqual([])
    expect(finished.active_runs).toEqual([])
  })

  it('fences a late terminal against a health owner even without a streamed start', () => {
    const projection = new ActivityHealthProjection()
    const current = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'run-new' }] }
    projection.accept(scope, current)
    expect(projection.observe(scope, event('turn_finished', 10, 'run-old'))).toBe(current)
  })
})
