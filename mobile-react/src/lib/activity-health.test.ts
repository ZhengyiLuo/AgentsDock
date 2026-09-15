import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityHealthProjection } from './activity-health'
import type { Event, Health } from '../types'

const scope = 'profile:1'
const health = (active: string[] = [], instance = 'boot-a'): Health => ({ ok: true,
  server_identity: 'server', server_instance_id: instance, active })
const event = (type: string, seq: number, run = 'run-new'): Event => ({ id: `event-${seq}`,
  session_id: 'chat', seq, run_id: run, type, ts: '2026-09-14T12:00:00Z' })

test('a streamed start overtakes an older health request; a later idle sample may settle it', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, health())
  const request = projection.capture(scope)
  projection.observe(scope, event('turn_started', 10))
  assert.deepEqual(projection.accept(scope, health(), request).active, ['chat'])
  assert.deepEqual(projection.accept(scope, health(), projection.capture(scope)).active, [])
})

test('a streamed terminal wins over old active health and older completions cannot resurrect it', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, health(['chat']))
  projection.observe(scope, event('turn_started', 10))
  const old = projection.capture(scope)
  projection.observe(scope, event('turn_finished', 11))
  assert.deepEqual(projection.accept(scope, health(['chat']), old).active, [])
  const latest = projection.accept(scope, health(), projection.capture(scope))
  assert.equal(projection.accept(scope, health(['chat']), old), latest)
})

test('profile and boot changes drop old facts without accepting an out-of-order old boot', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, health())
  const old = projection.capture(scope)
  projection.observe(scope, event('turn_started', 10))
  const replacement = projection.accept(scope, health([], 'boot-b'), projection.capture(scope))
  assert.deepEqual(replacement.active, [])
  assert.equal(projection.accept(scope, health(['chat']), old), replacement)
  projection.observe(scope, event('turn_started', 12))
  assert.deepEqual(projection.accept('profile:2', health()).active, [])
})

test('an externally adopted boot replaces prior admissions before another optimistic acknowledgement', () => {
  const projection = new ActivityHealthProjection()
  projection.initialize(scope, health())
  projection.admit(scope, 'old-chat')
  projection.initialize(scope, health([], 'boot-b'))
  const next = projection.admit(scope, 'new-chat')!
  assert.equal(next.server_instance_id, 'boot-b')
  assert.deepEqual(next.active, ['new-chat'])
})

test('imports, duplicate sequences, errors and terminals from a different run do not change ownership', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, health())
  const request = projection.capture(scope)
  projection.observe(scope, event('turn_started', 10))
  for (const stale of [event('turn_finished', 9), event('turn_finished', 11, 'old-run'),
    { ...event('turn_finished', 12, 'import_history'), imported: true },
    { ...event('turn_started', 13, 'import_history'), imported: true },
    { ...event('turn_stopped', 14), native_steer: true }, event('error', 15),
    { ...event('turn_started', 16), seq: NaN },
    { ...event('turn_finished', 17), run_id: undefined }]) projection.observe(scope, stale)
  assert.deepEqual(projection.accept(scope, health(), request).active, ['chat'])
})

test('a health owner fences late stops even without a streamed start and updates owners with stable active IDs', () => {
  const projection = new ActivityHealthProjection()
  const initial = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'old-run' }] }
  projection.accept(scope, initial)
  const request = projection.capture(scope)
  projection.observe(scope, event('turn_started', 10))
  assert.deepEqual(projection.accept(scope, initial, request).active_runs, [{ session_id: 'chat', run_id: 'run-new' }])
  const newest = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'next-run' }] }
  assert.equal(projection.accept(scope, newest, projection.capture(scope)), newest)
  assert.equal(projection.observe(scope, event('turn_finished', 11)), newest)
  assert.equal(projection.observe(scope, event('error', 12, 'next-run')), newest)
  assert.deepEqual(projection.observe(scope, event('turn_finished', 13, 'next-run'))?.active_runs, [])
})

test('activity changes preserve health fields and synchronize active aliases without mutating source arrays', () => {
  const projection = new ActivityHealthProjection()
  const initial = { ...health(), active_sessions: [] }
  projection.initialize(scope, initial)
  const next = projection.observe(scope, event('turn_started', 10))!
  assert.deepEqual(next.active, ['chat'])
  assert.deepEqual(next.active_sessions, ['chat'])
  assert.equal(next.server_identity, initial.server_identity)
  assert.deepEqual(initial.active, [])
  assert.deepEqual(initial.active_sessions, [])
  assert.equal(projection.observe(scope, event('reasoning_summary', 11)), next)
})

test('optimistic admission beats an old poll but a genuinely newer poll settles missing start', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, health())
  const old = projection.capture(scope)
  assert.deepEqual(projection.admit(scope, 'chat')?.active, ['chat'])
  assert.deepEqual(projection.accept(scope, health(), old).active, ['chat'])
  assert.deepEqual(projection.accept(scope, health(), projection.capture(scope)).active, [])
})

test('a streamed start and matching finish replace optimistic admission without resurrecting it', () => {
  const projection = new ActivityHealthProjection()
  projection.accept(scope, { ...health(), active_runs: [] })
  const old = projection.capture(scope)
  projection.admit(scope, 'chat')
  projection.observe(scope, event('turn_started', 10))
  assert.equal(projection.runId('chat'), 'run-new')
  projection.observe(scope, event('turn_finished', 11))
  assert.deepEqual(projection.accept(scope, health(['chat']), old).active, [])
  assert.equal(projection.runId('chat'), null)
})

test('a stop acknowledgement cannot clear a newer run or admission', () => {
  for (const kind of ['run', 'admission']) {
    const projection = new ActivityHealthProjection()
    projection.accept(scope, { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'old-run' }] })
    const request = projection.capture(scope)
    const owner = projection.runId('chat')
    if (kind === 'run') projection.observe(scope, event('turn_started', 10))
    else projection.admit(scope, 'chat')
    assert.equal(projection.confirmStopped(scope, 'chat', request, owner), false)
  }
})

test('an exact stop acknowledgement fences old health until a newer response settles', () => {
  const projection = new ActivityHealthProjection()
  const initial = { ...health(['chat']), active_runs: [{ session_id: 'chat', run_id: 'old-run' }] }
  projection.accept(scope, initial)
  const request = projection.capture(scope)
  assert.equal(projection.confirmStopped(scope, 'chat', request, 'old-run'), true)
  assert.deepEqual(projection.accept(scope, initial, request).active, [])
  assert.deepEqual(projection.accept(scope, health(['chat']), projection.capture(scope)).active, ['chat'])
})
