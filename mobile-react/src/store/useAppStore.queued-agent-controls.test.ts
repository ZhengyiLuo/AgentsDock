import assert from 'node:assert/strict'
import test from 'node:test'
import { ServerError } from '../api/AgentServerClient'
import { queueCodexPermissionUpdate } from '../lib/codex-permission-updates'
import { queueClaudePermissionUpdate } from '../lib/claude-permission-updates'
import type { Health, QueuedRunNowResponse, QueuedTurn, Session } from '../types'
import { client, useAppStore } from './useAppStore'

const session: Session = { id: 'recipient', title: 'Recipient', backend: 'codex' }
const health: Health = { ok: true, server_identity: 'uninitialized', server_instance_id: 'instance', capabilities: { cross_chat_handoffs_v1: { available: true, features: { async_queued_message_controls: true } } } }
const message: QueuedTurn = { queued_id: 'queue', session_id: session.id, target_session_id: session.id, source_session_id: 'sender', cross_chat_envelope_id: 'message', purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1', prompt: 'Preview', message_body: 'Full body', message_revision: 0, file_ids: [] }
const original = { queue: client.queue, update: client.updateQueued, run: client.runQueuedNow, health: client.health, fork: client.forkSession, sync: useAppStore.getState().syncSelectedSession, fetch: globalThis.fetch }
let publicQueue: QueuedTurn[] = []
let updates: unknown[][] = []
let runs = 0
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
function reset(turn: QueuedTurn = message) {
  client.markValidated()
  publicQueue = [turn]; updates = []; runs = 0
  client.queue = async () => publicQueue
  client.updateQueued = async (...args) => { updates.push(args); publicQueue = [{ ...turn, message_body: args[2], message_revision: (turn.message_revision ?? 0) + 1, message_edited_by_user: true }] }
  client.runQueuedNow = async () => { runs += 1; publicQueue = []; return { ok: true } }
  useAppStore.setState({
    initialized: true, serverConfigured: true, activeProfileId: 'uninitialized', profileGeneration: 0, connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    selectedSessionId: session.id, health, sessions: [session], error: null, queuedRunStatus: {}, pendingQueuedRunIds: new Set(), activeSessionIds: new Set(),
    drafts: { [session.id]: 'Unrelated unsent draft' },
    snapshots: { [session.id]: { session, events: [], queuedTurns: [turn], files: [], filesTotal: 0, hasMore: false, cachedAt: Date.now() } },
    syncSelectedSession: async () => {},
  })
}
const save = (revision = 0) => useAppStore.getState().updateQueuedAgentMessage(session.id, 'queue', 'Edited recipient body', revision, 0)
const run = () => useAppStore.getState().runQueuedNow(session.id, 'queue', 0)
function replaceQueue(turns: QueuedTurn[]) {
  publicQueue = turns
  const snapshot = useAppStore.getState().snapshots[session.id]
  useAppStore.setState({ snapshots: { [session.id]: { ...snapshot, queuedTurns: turns } } })
}
function replaceOperationScope(change: 'validation' | 'instance') {
  if (change === 'validation') { client.revokeValidation(); client.markValidated() }
  else useAppStore.setState({ health: { ...health, server_instance_id: 'replacement' } })
}

try {
  globalThis.fetch = async () => { throw new Error('Queue tests must not contact a live server') }
  await test('recipient edits send an exact CAS revision without granting composer references', async () => {
    reset()
    assert.equal(await save(), true)
    assert.deepEqual(updates, [[session.id, 'queue', 'Edited recipient body', undefined, undefined, undefined, 0]])
    assert.equal(useAppStore.getState().snapshots[session.id].queuedTurns[0].message_revision, 1)
    assert.equal(useAppStore.getState().drafts[session.id], 'Unrelated unsent draft')
  })
  await test('unadvertised controls and system-owned, passive, promoted, or foreign rows cannot be edited', async () => {
    for (const patch of [{ purpose: 'scheduled_job' }, { purpose: 'secure_peer_handoff_delivery' }, { delivery_mode: 'mailbox' as const }, { promoted: true }, { target_session_id: 'other' }, { message_revision: undefined }]) {
      reset({ ...message, ...patch })
      assert.equal(await save(), false)
      assert.equal(updates.length, 0)
    }
    reset(); useAppStore.setState({ health: { ok: true } })
    assert.equal(await save(), false)
    assert.equal(updates.length, 0)
  })
  await test('a stale revision or changed owner stops before PATCH', async () => {
    reset(); assert.equal(await save(2), false); assert.equal(updates.length, 0)
    reset(); publicQueue = [{ ...message, cross_chat_envelope_id: 'different' }]
    assert.equal(await save(), false); assert.equal(updates.length, 0)
    assert.match(useAppStore.getState().error ?? '', /changed|started/u)
  })
  await test('same-tick duplicate Save is admitted only once', async () => {
    reset()
    const read = deferred<QueuedTurn[]>()
    let calls = 0
    client.queue = () => ++calls === 1 ? read.promise : Promise.resolve(publicQueue)
    const pending = save()
    assert.equal(await save(), false)
    read.resolve(publicQueue)
    assert.equal(await pending, true)
    assert.equal(updates.length, 1)
  })
  await test('CAS conflicts refresh without automatically overwriting the newer revision', async () => {
    reset()
    client.updateQueued = async (...args) => { updates.push(args); publicQueue = [{ ...message, message_revision: 2, message_body: 'Newer edit' }]; throw new ServerError(409, 'Message revision changed') }
    assert.equal(await save(), false)
    assert.equal(updates.length, 1)
    assert.equal(useAppStore.getState().snapshots[session.id].queuedTurns[0].message_body, 'Newer edit')
  })
  await test('an unchanged response cannot claim edit success or replace the queue optimistically', async () => {
    reset(); client.updateQueued = async (...args) => { updates.push(args) }
    assert.equal(await save(), false)
    assert.equal(useAppStore.getState().snapshots[session.id].queuedTurns[0].message_body, 'Full body')
    assert.match(useAppStore.getState().error ?? '', /not confirmed/u)
  })
  await test('revalidation, server restart, capability loss and workspace adoption fence pending edits', async () => {
    for (const change of ['validation', 'instance', 'capability', 'adoption']) {
      reset(); const read = deferred<QueuedTurn[]>(); client.queue = () => read.promise
      const pending = save()
      if (change === 'validation') client.revokeValidation()
      else if (change === 'instance') useAppStore.setState({ health: { ...health, server_instance_id: 'new' } })
      else if (change === 'capability') useAppStore.setState({ health: { ...health, capabilities: {} } })
      else useAppStore.setState({ workspaceAdopting: true })
      read.resolve(publicQueue)
      assert.equal(await pending, false)
      assert.equal(updates.length, 0)
    }
  })
  await test('an overtaking live revision invalidates the owner read before editing', async () => {
    reset(); const read = deferred<QueuedTurn[]>(); let reads = 0
    client.queue = () => ++reads === 1 ? read.promise : Promise.resolve(publicQueue)
    const pending = save()
    publicQueue = [{ ...message, message_revision: 1 }]
    const snapshot = useAppStore.getState().snapshots[session.id]
    useAppStore.setState({ snapshots: { [session.id]: { ...snapshot, queuedTurns: publicQueue } } })
    read.resolve([message])
    assert.equal(await pending, false)
    assert.equal(reads >= 2, true)
    assert.equal(updates.length, 0)
  })
  await test('Send now permits only an exact capable async owner and remains single-flight', async () => {
    reset(); const read = deferred<QueuedTurn[]>(); let reads = 0
    client.queue = () => ++reads === 1 ? read.promise : Promise.resolve(publicQueue)
    const pending = run()
    const duplicate = run()
    read.resolve(publicQueue)
    assert.equal(await pending, true)
    assert.equal(await duplicate, true)
    assert.equal(runs, 1)
    reset(); useAppStore.setState({ health: { ok: true } })
    assert.equal(await run(), false); assert.equal(runs, 0)
    reset(); publicQueue = [{ ...message, message_revision: 1 }]
    assert.equal(await run(), false); assert.equal(runs, 0)
  })
  await test('Send now cannot start passive mailbox or scheduled work', async () => {
    for (const turn of [{ ...message, delivery_mode: 'mailbox' as const }, { ...message, purpose: 'scheduled_job' }]) {
      reset(turn); assert.equal(await run(), false); assert.equal(runs, 0)
    }
  })
  for (const backend of ['codex', 'claude'] as const) {
    await test(`${backend} Send now rereads owner, revision and promoted barriers after permission waits`, async () => {
      for (const changed of [
        [{ ...message, message_revision: 1 }],
        [{ ...message, cross_chat_envelope_id: 'replacement-owner' }],
        [{ ...message, queued_id: 'earlier', promoted: true }, message],
      ]) {
        reset()
        useAppStore.setState({ sessions: [{ ...session, backend }] })
        const permissions = deferred<void>()
        const queuePermissions = backend === 'codex' ? queueCodexPermissionUpdate : queueClaudePermissionUpdate
        const permissionUpdate = queuePermissions({ profileId: 'uninitialized', profileGeneration: 0, sessionId: session.id }, () => permissions.promise)
        let reads = 0
        client.queue = async () => { reads += 1; return publicQueue }
        const pending = run()
        await flush()
        assert.equal(reads, 0, 'preflight queue read must occur after held permissions')
        assert.equal(runs, 0)
        replaceQueue(changed)
        permissions.resolve()
        await permissionUpdate
        assert.equal(await pending, false)
        assert.equal(reads, 1)
        assert.equal(runs, 0)
        assert.match(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /changed|earlier/u)
        assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queue'), false)
      }
    })
  }
  await test('a current promoted barrier appearing during queue publication still blocks POST', async () => {
    reset()
    const replacement = [{ ...message, queued_id: 'earlier', promoted: true }, message]
    let injected = false
    const unsubscribe = useAppStore.subscribe(state => {
      if (injected || state.snapshots[session.id]?.queuedTurns !== publicQueue) return
      injected = true
      replaceQueue(replacement)
    })
    try {
      // Keep the initial array distinct so this subscriber runs only when the
      // preflight response publishes, after the helper's overtaking-read check.
      publicQueue = [{ ...message }]
      assert.equal(await run(), false)
      assert.equal(injected, true)
      assert.equal(runs, 0)
    } finally { unsubscribe() }
  })
  for (const change of ['validation', 'instance'] as const) {
    await test(`a hung old Save cannot block or release a replacement ${change} Save`, async () => {
      reset()
      const oldPatch = deferred<void>()
      const nextPatch = deferred<void>()
      client.updateQueued = (...args) => { updates.push(args); return updates.length === 1 ? oldPatch.promise : nextPatch.promise }
      const oldSave = save()
      await flush()
      assert.equal(updates.length, 1)
      replaceOperationScope(change)
      const nextSave = save()
      await flush()
      assert.equal(updates.length, 2, 'new validated instance owns an independent Save')
      oldPatch.resolve()
      assert.equal(await oldSave, false)
      assert.equal(await save(), false, 'old finally cannot release the newer Save gate')
      assert.equal(updates.length, 2)
      publicQueue = [{ ...message, message_revision: 1, message_body: 'Edited recipient body', message_edited_by_user: true }]
      nextPatch.resolve()
      assert.equal(await nextSave, true)
      assert.equal(useAppStore.getState().error, null)
    })
    await test(`a hung old Run now cannot block or clear a replacement ${change} spinner`, async () => {
      reset()
      const oldPost = deferred<QueuedRunNowResponse>()
      const nextPost = deferred<QueuedRunNowResponse>()
      client.runQueuedNow = () => { runs += 1; return runs === 1 ? oldPost.promise : nextPost.promise }
      const oldRun = run()
      await flush()
      assert.equal(runs, 1)
      replaceOperationScope(change)
      const nextRun = run()
      await flush()
      assert.equal(runs, 2)
      oldPost.resolve({ ok: true })
      assert.equal(await oldRun, false)
      assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queue'), true, 'late old cleanup preserves the new spinner')
      const duplicate = run()
      await flush()
      assert.equal(runs, 2, 'new instance still owns its single-flight gate')
      let forks = 0
      client.forkSession = async () => { forks += 1; return { session: { ...session, id: 'forked' } } }
      await useAppStore.getState().forkSession(session.id, 0)
      assert.equal(forks, 0, 'Fork uses the same current validated Run now admission')
      publicQueue = []
      nextPost.resolve({ ok: true })
      assert.equal(await nextRun, true)
      assert.equal(await duplicate, true)
      assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queue'), false)
    })
  }
  await test('reconnect immediately releases a hung queue spinner before health settles', async () => {
    reset()
    const post = deferred<QueuedRunNowResponse>()
    client.runQueuedNow = () => { runs += 1; return post.promise }
    const pending = run()
    await flush()
    assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queue'), true)
    const healthRead = deferred<Health>()
    client.health = () => healthRead.promise
    const reconnect = useAppStore.getState().reconnect()
    assert.equal(useAppStore.getState().connecting, true)
    assert.equal(useAppStore.getState().pendingQueuedRunIds.has('queue'), false)
    healthRead.resolve({ ok: false })
    await reconnect
    post.resolve({ ok: true })
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().pendingQueuedRunIds.size, 0)
  })
  await flush()
} finally {
  client.queue = original.queue; client.updateQueued = original.update; client.runQueuedNow = original.run
  client.health = original.health; client.forkSession = original.fork
  globalThis.fetch = original.fetch
  useAppStore.setState({ connected: false, syncSelectedSession: original.sync })
}
