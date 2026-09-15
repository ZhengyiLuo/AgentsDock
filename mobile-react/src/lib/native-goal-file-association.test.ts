import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, QueuedTurn } from '../types'
import { NativeGoalFileAssociation, retainNativeGoalAcknowledgementFiles } from './native-goal-file-association'
import { mergeEvents } from './format'
import { mergeAndSanitizeIncomingEvents, sanitizeTimelineEvent } from './timeline-memory'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `synthetic-${seq}`, seq, type, session_id: 'chat', queued_id: 'queued', run_id: 'goal-owner',
  backend: 'codex', ts: '2026-09-15T12:00:00Z', ...patch,
})
const ack = (seq = 5, patch: Partial<Event> = {}) => event(seq, 'turn_steered', {
  native_goal_steer: true, native_steer: true, purpose: 'codex_goal_resume', provider_user_authored: true, file_ids: [], ...patch,
})
const turn = (patch: Partial<QueuedTurn> = {}): QueuedTurn => ({ queued_id: 'queued', session_id: 'chat', prompt: 'Synthetic only', file_ids: ['file-one'], ...patch })

test('live queue ownership survives run-now and HTTP absence until exact native acknowledgement', () => {
  const association = new NativeGoalFileAssociation()
  const queued = event(1, 'turn_queued', { file_ids: ['file-one'] }), input = ack()
  const original = JSON.stringify([queued, input])
  association.observe(queued)
  association.observe(event(3, 'turn_queue_run_now', { native_goal_steer: true, native_steer: true }))
  association.rememberSnapshot('chat', [])
  assert.deepEqual(association.observe(input).file_ids, ['file-one'])
  assert.equal(JSON.stringify([queued, input]), original)
  assert.deepEqual(association.observe(ack(7)).file_ids, [], 'consumed queue ownership must not attach to another acknowledgement')
})

test('current snapshots seed exact owned IDs, but other-chat and blank identities never seed them', () => {
  for (const session_id of ['chat', undefined]) {
    const association = new NativeGoalFileAssociation()
    association.rememberSnapshot('chat', [turn({ session_id })])
    assert.deepEqual(association.observe(ack()).file_ids, ['file-one'])
  }
  for (const patch of [{ session_id: 'other' }, { queued_id: '' }, { queued_id: ' queued' }]) {
    const association = new NativeGoalFileAssociation()
    association.rememberSnapshot('chat', [turn(patch)])
    assert.deepEqual(association.observe(ack()).file_ids, [])
  }
})

test('latest file update wins, explicit empty edit removes files, and stale receipts cannot roll it back', () => {
  for (const latest of [['file-two'], []]) {
    const association = new NativeGoalFileAssociation()
    association.observe(event(1, 'turn_queued', { file_ids: ['file-one'] }))
    association.observe(event(3, 'turn_queue_updated', { file_ids: latest }))
    association.observe(event(2, 'turn_queue_updated', { file_ids: ['stale'] }))
    association.observe(event(4, 'turn_queue_updated', { prompt: 'No file edit' }))
    assert.deepEqual(association.observe(ack()).file_ids, latest)
  }
})

test('explicit cancellation and ordinary consumption reject stale events and snapshots for that queue ID', () => {
  for (const type of ['turn_unqueued', 'turn_started']) {
    const association = new NativeGoalFileAssociation()
    association.observe(event(1, 'turn_queued', { file_ids: ['file-one'] }))
    association.observe(event(3, type))
    association.observe(event(2, 'turn_queued', { file_ids: ['stale'] }))
    association.rememberSnapshot('chat', [turn()])
    assert.deepEqual(association.observe(ack()).file_ids, [])
  }
})

test('same-ID duplicate native receipt retains its own files without enriching a different event or owner', () => {
  const association = new NativeGoalFileAssociation()
  association.rememberSnapshot('chat', [turn()])
  assert.deepEqual(association.observe(ack()).file_ids, ['file-one'])
  assert.deepEqual(association.observe({ ...ack(), display_prompt: 'Authoritative display metadata' }).file_ids, ['file-one'])
  for (const patch of [{ id: 'different' }, { seq: 6 }, { run_id: 'other-owner' }, { session_id: 'other-chat' }, { queued_id: 'other-queue' }]) {
    assert.deepEqual(association.observe(ack(5, patch)).file_ids, [])
  }
})

test('a stale native acknowledgement cannot consume a newer edit and unproven native flags do not consume ownership', () => {
  const association = new NativeGoalFileAssociation()
  association.observe(event(4, 'turn_queue_updated', { file_ids: ['file-two'] }))
  assert.deepEqual(association.observe(ack(3)).file_ids, [])
  assert.deepEqual(association.observe(ack(5, { provider_user_authored: false })).file_ids, [])
  assert.deepEqual(association.observe(ack(6)).file_ids, ['file-two'])
})

test('fresh validated-scope instances never inherit prior profile, validation or server file ownership', () => {
  const old = new NativeGoalFileAssociation()
  old.rememberSnapshot('chat', [turn()])
  assert.deepEqual(new NativeGoalFileAssociation().observe(ack()).file_ids, [])
  assert.deepEqual(old.observe(ack()).file_ids, ['file-one'])
})

test('bounded ownership degrades to explicit event files and rejects malformed or oversized selections', () => {
  const association = new NativeGoalFileAssociation()
  for (let index = 0; index < 300; index += 1) association.rememberSnapshot('chat', [turn({ queued_id: `queued-${index}` })])
  assert.deepEqual(association.observe(ack(5, { queued_id: 'queued-0', file_ids: ['explicit'] })).file_ids, ['explicit'])
  assert.deepEqual(association.observe(ack(5, { queued_id: 'queued-299' })).file_ids, ['file-one'])
  for (const files of [Array(257).fill('file'), [''], [' file']]) {
    const fresh = new NativeGoalFileAssociation()
    fresh.observe(event(1, 'turn_queued', { file_ids: files }))
    assert.deepEqual(fresh.observe(ack()).file_ids, [])
  }
})

test('visible queue file IDs override provider replay files, including an explicitly empty display selection', () => {
  for (const display of [['visible-file'], []]) {
    for (const type of ['turn_queued', 'turn_queue_updated']) {
      const association = new NativeGoalFileAssociation()
      association.observe(event(1, type, { display_file_ids: display, file_ids: ['provider-replay-file'] }))
      assert.deepEqual(association.observe(ack()).file_ids, display)
    }
  }
})

test('new HTTP owners cannot enrich older acknowledgements, while known ownership survives later read boundaries', () => {
  const fresh = new NativeGoalFileAssociation()
  fresh.rememberSnapshot('chat', [turn()], 10)
  assert.deepEqual(fresh.observe(ack(9)).file_ids, [])
  assert.deepEqual(fresh.observe(ack(10)).file_ids, [])
  assert.deepEqual(fresh.observe(ack(11)).file_ids, ['file-one'])
  const known = new NativeGoalFileAssociation()
  known.observe(event(1, 'turn_queued', { file_ids: ['file-one'] }))
  known.rememberSnapshot('chat', [turn()], 10)
  assert.deepEqual(known.observe(ack(5)).file_ids, ['file-one'])
  const changed = new NativeGoalFileAssociation()
  changed.observe(event(1, 'turn_queued', { file_ids: ['file-one'] }))
  changed.rememberSnapshot('chat', [turn({ file_ids: ['file-two'] })], 10)
  assert.deepEqual(changed.observe(ack(5)).file_ids, [])
  assert.deepEqual(changed.observe(ack(11)).file_ids, ['file-two'])
})

test('accepted explicit Remove prevents snapshot reseeding and later native attachment invention', () => {
  const association = new NativeGoalFileAssociation()
  association.rememberSnapshot('chat', [turn()])
  association.forget('chat', 'queued')
  association.rememberSnapshot('chat', [turn()])
  association.observe(event(3, 'turn_queue_updated', { file_ids: ['stale'] }))
  assert.deepEqual(association.observe(ack()).file_ids, [])
})

test('exact HTTP acknowledgement replay retains known files without trusting unrelated or imported input', () => {
  const previous = ack(5, { prompt: '', file_ids: ['file-one'] }), incoming = ack(5, { prompt: '' })
  assert.deepEqual(retainNativeGoalAcknowledgementFiles(previous, incoming).file_ids, ['file-one'])
  assert.deepEqual(mergeEvents([previous], [incoming])[0].file_ids, ['file-one'])
  assert.deepEqual(mergeAndSanitizeIncomingEvents([sanitizeTimelineEvent(previous)], [incoming])[0].file_ids, ['file-one'])
  assert.deepEqual(incoming.file_ids, [])
  for (const patch of [{ id: 'other' }, { seq: 6 }, { run_id: 'other' }, { session_id: 'other' }, { queued_id: 'other' },
    { prompt: 'Changed text' }, { imported: true }, { provider_user_authored: false }]) {
    const replacement = { ...incoming, ...patch }
    assert.equal(retainNativeGoalAcknowledgementFiles(previous, replacement), replacement)
  }
  const explicit = { ...incoming, file_ids: ['new-explicit-file'] }
  assert.equal(retainNativeGoalAcknowledgementFiles(previous, explicit), explicit)
  const historical = { ...incoming, imported: true }
  const association = new NativeGoalFileAssociation()
  association.rememberSnapshot('chat', [turn()])
  assert.equal(association.observe(historical), historical)
  assert.deepEqual(association.observe(incoming).file_ids, ['file-one'])
})

test('native display selection wins over remembered visible files, which win over raw provider file IDs', () => {
  for (const display of [['native-visible'], []]) {
    const association = new NativeGoalFileAssociation()
    association.rememberSnapshot('chat', [turn()])
    const input = ack(5, { display_file_ids: display, file_ids: ['raw-provider'] })
    assert.deepEqual(association.observe(input).file_ids, display)
    assert.deepEqual(association.observe({ ...input, display_file_ids: undefined, file_ids: [] }).file_ids, display)
    assert.deepEqual(retainNativeGoalAcknowledgementFiles(ack(5, { file_ids: ['previous-visible'] }), input).file_ids, display)
  }
  const association = new NativeGoalFileAssociation()
  association.rememberSnapshot('chat', [turn({ file_ids: [] })])
  const hidden = association.observe(ack(5, { file_ids: ['raw-provider'] }))
  assert.deepEqual(hidden.file_ids, [])
  assert.deepEqual(hidden.display_file_ids, [])
  assert.deepEqual(retainNativeGoalAcknowledgementFiles(hidden, ack(5, { file_ids: ['raw-provider'] })).file_ids, [])
  assert.deepEqual(mergeAndSanitizeIncomingEvents([hidden], [ack(5, { file_ids: ['raw-provider'] })])[0].display_file_ids, [])
  assert.deepEqual(new NativeGoalFileAssociation().observe(ack(5, { file_ids: ['raw-provider'] })).file_ids, ['raw-provider'])
})

test('forward-delta read proof survives native run-now and unchanged HTTP queue publication', () => {
  const association = new NativeGoalFileAssociation()
  association.observe(event(1, 'turn_queued', { file_ids: ['file-one'] }))
  const read = association.captureAcknowledgementRead()
  association.observe(event(3, 'turn_queue_run_now', { native_goal_steer: true, native_steer: true }))
  association.rememberSnapshot('chat', [turn()], 10)
  assert.deepEqual(read(ack()).file_ids, ['file-one'])
  assert.deepEqual(association.observe(ack(7)).file_ids, [], 'read acknowledgement consumes only its captured queue owner')
})

test('forward-delta reads never borrow ownership learned or edited after the request began', () => {
  for (const change of ['new', 'live-edit', 'http-edit', 'remove', 'ordinary', 'forget']) {
    const association = new NativeGoalFileAssociation()
    if (change !== 'new') association.rememberSnapshot('chat', [turn()], 1)
    const read = association.captureAcknowledgementRead()
    if (change === 'new') association.rememberSnapshot('chat', [turn()], 2)
    if (change === 'live-edit') association.observe(event(3, 'turn_queue_updated', { file_ids: ['file-two'] }))
    if (change === 'http-edit') association.rememberSnapshot('chat', [turn({ file_ids: ['file-two'] })], 3)
    if (change === 'remove') association.observe(event(3, 'turn_unqueued'))
    if (change === 'ordinary') association.observe(event(3, 'turn_started'))
    if (change === 'forget') association.forget('chat', 'queued')
    assert.deepEqual(read(ack()).file_ids, [], change)
  }
})
