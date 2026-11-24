import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SideChatController, type SideChatTransport } from './side-chat-controller'
import type { SideQuestionInput, SyncedSideChat } from './side-chat'

const empty = (revision = 0, side = 'side-a'): SyncedSideChat => ({
  session_id: 'chat-a', side_chat_id: side, revision, last_request_id: null, exchanges: [],
})
function answer(input: SideQuestionInput, revision: number, status: 'running' | 'completed' = 'completed'): SyncedSideChat {
  return { ...empty(revision), last_request_id: input.request_id, exchanges: [{
    request_id: input.request_id, question: input.question, status, backend: 'codex',
    ...(status === 'completed' ? { answer: 'Side answer' } : {}), created_at: 'now', updated_at: 'now',
  }] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(overrides: Partial<SideChatTransport> = {}) {
  let current = true, id = 0
  const transport: SideChatTransport = {
    readSyncedSideChat: async () => empty(),
    submitSyncedSideChat: async (_session, input) => answer(input, 1),
    stopSyncedSideChat: async () => empty(2), clearSyncedSideChat: async () => empty(3, 'side-b'),
    ...overrides,
  }
  return { controller: new SideChatController(transport, 'chat-a', () => current, 1000, () => `request-${++id}`),
    invalidateScope: () => { current = false } }
}

test('submit requires a loaded snapshot, trims input, and never copies parent history', async () => {
  const writes: SideQuestionInput[] = []
  const { controller } = setup({ submitSyncedSideChat: async (session, input) => {
    assert.equal(session, 'chat-a'); writes.push(input); return answer(input, writes.length)
  } })
  assert.equal(await controller.submit('before read'), false)
  await controller.refresh()
  assert.equal(await controller.submit(' First? '), true)
  assert.equal(await controller.submit('Follow up?'), true)
  assert.deepEqual(writes, [
    { request_id: 'request-1', question: 'First?', side_chat_id: 'side-a' },
    { request_id: 'request-2', question: 'Follow up?', side_chat_id: 'side-a', after_request_id: 'request-1' },
  ])
})

test('repeated sends are single flight and a server-owned running side reply blocks another send', async () => {
  const pending = deferred<SyncedSideChat>(); let calls = 0
  const { controller } = setup({ submitSyncedSideChat: () => { calls++; return pending.promise } })
  await controller.refresh()
  const first = controller.submit('First?')
  assert.equal(await controller.submit('First?'), false)
  assert.equal(controller.getSnapshot().mutating, true)
  pending.resolve(answer({ request_id: 'request-1', question: 'First?' }, 1, 'running'))
  assert.equal(await first, true)
  assert.equal(await controller.submit('Another?'), false)
  assert.equal(calls, 1)
})

test('late read cannot resurrect history after Clear advances the server revision', async () => {
  const late = deferred<SyncedSideChat>(); let reads = 0
  const { controller } = setup({ readSyncedSideChat: async () => ++reads === 1 ? empty(1) : late.promise })
  await controller.refresh()
  const read = controller.refresh()
  await controller.clear()
  late.resolve(empty(2))
  await read
  assert.equal(controller.getSnapshot().snapshot?.side_chat_id, 'side-b')
  assert.equal(controller.getSnapshot().snapshot?.revision, 3)
})

test('lost submission acknowledgement reconciles once without resending', async () => {
  let accepted: SyncedSideChat | null = null, submits = 0
  const { controller } = setup({
    readSyncedSideChat: async () => accepted ?? empty(),
    submitSyncedSideChat: async (_session, input) => { submits++; accepted = answer(input, 1); throw new Error('timeout') },
  })
  await controller.refresh()
  assert.equal(await controller.submit('Question?'), true)
  assert.equal(submits, 1)
  assert.equal(controller.getSnapshot().error, null)
})

test('explicit retry of unconfirmed submission keeps its request identity', async () => {
  const inputs: SideQuestionInput[] = []
  const { controller } = setup({ submitSyncedSideChat: async (_session, input) => {
    inputs.push(input); if (inputs.length === 1) throw new Error('connection lost'); return answer(input, 1)
  } })
  await controller.refresh()
  assert.equal(await controller.submit('Question?'), false)
  assert.equal(await controller.submit('Different question?'), false)
  assert.equal(await controller.submit('Question?'), true)
  assert.deepEqual(inputs[0], inputs[1])
})

test('explicit server rejection does not trap a different corrected question', async () => {
  let submits = 0
  const { controller } = setup({ submitSyncedSideChat: async (_session, input) => {
    if (++submits === 1) throw Object.assign(new Error('No native context yet'), { status: 409 })
    return answer(input, 1)
  } })
  await controller.refresh()
  assert.equal(await controller.submit('First?'), false)
  assert.equal(await controller.submit('Corrected?'), true)
})

test('Stop targets only the matching active side request; close never cancels server work', async () => {
  const stops: string[] = []
  const { controller } = setup({
    readSyncedSideChat: async () => answer({ request_id: 'side-request', question: 'Q' }, 1, 'running'),
    stopSyncedSideChat: async (session, id) => { assert.equal(session, 'chat-a'); stops.push(id); return empty(2) },
  })
  await controller.refresh()
  await controller.stop('parent-request')
  assert.deepEqual(stops, [])
  await controller.stop('side-request')
  controller.dispose()
  assert.deepEqual(stops, ['side-request'])
})

test('profile/session revocation discards late results and rejects retained action callbacks', async () => {
  const late = deferred<SyncedSideChat>()
  const { controller, invalidateScope } = setup({ readSyncedSideChat: () => late.promise })
  const read = controller.refresh()
  invalidateScope(); late.resolve(empty(5)); await read
  assert.equal(controller.getSnapshot().snapshot, null)
  assert.equal(await controller.submit('wrong server'), false)
})

test('invalidation is event-driven, coalesces an active read, and ignores already observed revisions', async () => {
  const late = deferred<SyncedSideChat>(); let reads = 0
  const { controller } = setup({ readSyncedSideChat: async () => ++reads === 1 ? late.promise : empty(3) })
  const read = controller.refresh()
  controller.invalidate(1); controller.invalidate(2)
  assert.equal(controller.refresh(), read)
  late.resolve(empty(1)); await read; await controller.refresh()
  assert.equal(reads, 2)
  controller.invalidate(3); controller.invalidate(2)
  assert.equal(reads, 2)
})

test('effect cleanup/reactivation fences the old read, including its finally handler', async () => {
  const old = deferred<SyncedSideChat>(), fresh = deferred<SyncedSideChat>(); let reads = 0
  const { controller } = setup({ readSyncedSideChat: () => ++reads === 1 ? old.promise : fresh.promise })
  controller.activate(); const a = controller.refresh(); await Promise.resolve()
  controller.dispose(); controller.activate(); const b = controller.refresh(); await Promise.resolve()
  old.resolve(empty(9)); await a
  assert.equal(controller.getSnapshot().snapshot, null)
  assert.equal(controller.refresh(), b)
  fresh.resolve(empty(1)); await b
  assert.equal(controller.getSnapshot().snapshot?.revision, 1)
})
