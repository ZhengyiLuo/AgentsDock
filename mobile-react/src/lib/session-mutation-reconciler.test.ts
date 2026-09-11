import assert from 'node:assert/strict'
import type { Session } from '../types'
import { SessionMutationReconciler } from './session-mutation-reconciler'

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'chat-1',
  title: 'Original',
  folder: 'General',
  backend: 'codex',
  archived: false,
  updated_at: 'before',
  ...patch,
})

{
  const reconciler = new SessionMutationReconciler()
  let current = session()
  const title = reconciler.begin(current, { title: 'Local title' })
  current = { ...current, title: 'Local title' }
  const folder = reconciler.begin(current, { folder: 'Work' })
  current = { ...current, folder: 'Work' }

  current = reconciler.succeed(current, session({ title: 'Original', folder: 'Work', updated_at: 'folder-response' }), folder)
  assert.equal(current.title, 'Local title', 'a full response for another field must not erase an optimistic title')
  assert.equal(current.folder, 'Work')
  assert.equal(current.updated_at, 'folder-response')

  current = reconciler.succeed(current, session({ title: 'Saved title', folder: 'General', updated_at: 'older-response' }), title)
  assert.equal(current.title, 'Saved title')
  assert.equal(current.folder, 'Work', 'an older response must not restore unrelated server fields')
  assert.equal(current.updated_at, 'folder-response', 'older response metadata must not replace the newest response metadata')
}

{
  const reconciler = new SessionMutationReconciler()
  let current = session()
  const first = reconciler.begin(current, { title: 'First' })
  current = { ...current, title: 'First' }
  const second = reconciler.begin(current, { title: 'Second' })
  current = { ...current, title: 'Second' }

  current = reconciler.succeed(current, session({ title: 'First normalized' }), first)
  assert.equal(current.title, 'Second', 'older same-field success must stay behind the newer optimistic edit')
  current = reconciler.succeed(current, session({ title: 'Second normalized' }), second)
  assert.equal(current.title, 'Second normalized')
}

{
  const reconciler = new SessionMutationReconciler()
  let current = session()
  const first = reconciler.begin(current, { title: 'First' })
  current = { ...current, title: 'First' }
  const second = reconciler.begin(current, { title: 'Second' })
  current = { ...current, title: 'Second' }

  current = reconciler.fail(current, first)
  assert.equal(current.title, 'Second')
  current = reconciler.fail(current, second)
  assert.equal(current.title, 'Original', 'two failed overlapping saves must unwind to the pre-mutation value')
}

{
  const reconciler = new SessionMutationReconciler()
  let current = session()
  const first = reconciler.begin(current, { title: 'First' })
  current = { ...current, title: 'First' }
  const second = reconciler.begin(current, { title: 'Second' })
  current = { ...current, title: 'Second' }

  current = reconciler.succeed(current, session({ title: 'First normalized' }), first)
  current = reconciler.fail(current, second)
  assert.equal(current.title, 'First normalized', 'a newer rejection must reveal the accepted predecessor')
}

{
  const reconciler = new SessionMutationReconciler()
  const oldToken = reconciler.begin(session(), { title: 'Old profile edit' })
  reconciler.clear()
  let current = session({ title: 'New profile' })
  const newToken = reconciler.begin(current, { title: 'New profile edit' })
  current = { ...current, title: 'New profile edit' }

  reconciler.abandon(oldToken)
  current = reconciler.succeed(current, session({ title: 'New profile saved' }), newToken)
  assert.equal(current.title, 'New profile saved', 'an old-profile cleanup must not remove a new same-ID mutation')
  assert.notEqual(oldToken.revision, newToken.revision, 'profile clears must not recycle mutation revisions')
}

{
  const reconciler = new SessionMutationReconciler()
  const staleRefresh = reconciler.captureRead()
  let current = session({ updated_at: '2026-09-02T10:00:00Z' })
  const mutation = reconciler.begin(current, { title: 'Optimistic title' })
  current = { ...current, title: 'Optimistic title' }

  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'Original', updated_at: '2026-09-02T10:00:01Z', latest_event_seq: 10 }),
    staleRefresh,
  )
  assert.equal(current.title, 'Optimistic title', 'a refresh started before a pending PATCH must preserve local intent')
  assert.equal(current.latest_event_seq, 10, 'reconciliation must retain unrelated remote metadata')

  current = reconciler.succeed(
    current,
    session({ title: 'Saved title', updated_at: '2026-09-02T10:00:02Z', latest_event_seq: 11 }),
    mutation,
  )
  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'Original', updated_at: '2026-09-02T10:00:01Z', latest_event_seq: 12 }),
    staleRefresh,
  )
  assert.equal(current.title, 'Saved title', 'the same late refresh must remain fenced after PATCH completion')
  assert.equal(current.latest_event_seq, 12)
}

{
  const reconciler = new SessionMutationReconciler()
  let current = session({ updated_at: '2026-09-02T10:00:00Z' })
  const mutation = reconciler.begin(current, { title: 'Saved title' })
  current = { ...current, title: 'Saved title' }
  current = reconciler.succeed(
    current,
    session({ title: 'Saved title', updated_at: '2026-09-02T10:00:02Z' }),
    mutation,
  )

  const propagationRead = reconciler.captureRead()
  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'Original', updated_at: '2026-09-02T10:00:01Z' }),
    propagationRead,
  )
  assert.equal(current.title, 'Saved title', 'a completed PATCH must survive a lagging fresh server read')

  const newerServerRead = reconciler.captureRead()
  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'Edited elsewhere', updated_at: '2026-09-02T10:00:03Z' }),
    newerServerRead,
  )
  assert.equal(current.title, 'Edited elsewhere', 'a strictly newer server edit must retire the local overlay')
}

{
  const reconciler = new SessionMutationReconciler()
  const oldRead = reconciler.captureRead()
  const oldMutation = reconciler.begin(session(), { title: 'Old profile edit' })
  reconciler.clear()

  let current = session({ title: 'New profile', updated_at: '2026-09-02T11:00:00Z' })
  const newMutation = reconciler.begin(current, { title: 'New profile edit' })
  current = { ...current, title: 'New profile edit' }
  current = reconciler.succeed(
    current,
    session({ title: 'New profile saved', updated_at: '2026-09-02T11:00:01Z' }),
    newMutation,
  )

  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'Old profile payload', updated_at: '2026-09-02T12:00:00Z' }),
    oldRead,
  )
  reconciler.abandon(oldMutation)
  assert.equal(current.title, 'New profile saved', 'an old-generation read cannot overwrite a reused session ID')

  const newRead = reconciler.captureRead()
  current = reconciler.reconcileIncoming(
    current,
    session({ title: 'New profile saved', updated_at: '2026-09-02T11:00:01Z' }),
    newRead,
  )
  assert.equal(current.title, 'New profile saved', 'the active generation must still reconcile normally')
}
