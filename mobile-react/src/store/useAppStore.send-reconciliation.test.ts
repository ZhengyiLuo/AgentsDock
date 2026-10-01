import assert from 'node:assert/strict'
import test from 'node:test'
import type { Health, Session } from '../types'
import { client, useAppStore } from './useAppStore'

// Exercise the real turn transport with synthetic responses only. Accepted
// sends must never return to the composer merely because reconciliation fails.
const session: Session = { id: 'send-reconciliation', title: 'Synthetic send', backend: 'codex' }
const health: Health = { ok: true, server_identity: 'synthetic-server', server_instance_id: 'synthetic-boot' }
const originalFetch = globalThis.fetch
const originalSync = useAppStore.getState().syncSelectedSession
const admittedFile = { id: 'sent-file', filename: 'sent.txt' }
const nextFile = { id: 'next-file', filename: 'next.txt' }
const requests: Array<{ path: string; method: string }> = []
let syncs = 0
let respond: () => Promise<Response>
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function reset() {
  client.markValidated()
  requests.length = 0
  syncs = 0
  useAppStore.setState({ initialized: true, serverConfigured: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false, selectedSessionId: session.id,
    sessions: [session], health, runtime: null, drafts: { [session.id]: 'Submitted message' },
    uploads: { [session.id]: [admittedFile] }, uploadPending: {}, uploadFailed: {},
    chatReferencesBySession: {}, teamReferencesBySession: {}, snapshots: {}, historyWindow: null,
    sendingSessionIds: new Set(), turnAdmissionTokens: {}, error: null,
    syncSelectedSession: async () => { syncs += 1 },
  })
}
const send = (steer = false) => useAppStore.getState().sendPrompt(steer, 0, session.id)

try {
  globalThis.fetch = async (input, init) => {
    const request = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET' }
    requests.push(request)
    assert.equal(request.method, 'POST')
    assert.equal(request.path, `/api/sessions/${session.id}/turns`)
    return respond()
  }

  for (const failure of ['revoked-before-response', 'revoked-reading-response', 'invalid-response', 'invalid-envelope'] as const) {
    for (const steer of [false, true]) {
      await test(`${steer ? 'Steer' : 'Send'} retains acceptance after ${failure} without restoring or replaying the submitted draft`, async () => {
        reset()
        const finish = deferred<void>()
        const reading = deferred<void>()
        respond = async () => {
          if (failure !== 'revoked-reading-response') await finish.promise
          if (failure === 'invalid-response') return new Response('not valid JSON', { status: 200 })
          if (failure === 'invalid-envelope') return json(null)
          const response = json({ session, queued: true, queued_id: 'accepted-queued-id' })
          if (failure === 'revoked-reading-response') {
            response.json = async () => { reading.resolve(); await finish.promise; return { session } }
          }
          return response
        }
        const sending = send(steer)
        assert.equal(useAppStore.getState().drafts[session.id], '')
        if (failure === 'revoked-reading-response') await reading.promise
        useAppStore.getState().setSessionDraft(session.id, 'Keep newer dictation', 0)
        const newlyPickedSameId = { ...admittedFile }
        useAppStore.setState({ uploads: { [session.id]: [admittedFile, nextFile, newlyPickedSameId] } })
        const revoke = failure.startsWith('revoked-')
        if (revoke) client.revokeValidation()
        finish.resolve()
        assert.equal(await sending, false, 'the response projection is unavailable even though submission succeeded')
        assert.equal(useAppStore.getState().drafts[session.id], 'Keep newer dictation', 'HTTP success must not restore the submitted text')
        assert.deepEqual(useAppStore.getState().uploads[session.id], [nextFile, newlyPickedSameId])
        assert.match(useAppStore.getState().error ?? '', /accepted.*[Rr]efresh.*before sending it again/u)
        assert.equal(requests.length, 1, 'neither another send nor queue steering is safe from an unusable response')
        assert.equal(syncs, revoke ? 0 : 1, 'read recovery requires a validated connection')
        assert.equal(useAppStore.getState().sendingSessionIds.size, 0)
        assert.equal(useAppStore.getState().turnAdmissionTokens[session.id], undefined)
      })
    }
  }

  for (const replacement of ['identity', 'profile', 'generation', 'selection'] as const) {
    await test(`a received acceptance never projects into a changed ${replacement}`, async () => {
      reset()
      const finish = deferred<void>()
      respond = async () => { await finish.promise; return new Response('invalid JSON', { status: 200 }) }
      const sending = send()
      useAppStore.setState({ drafts: { [session.id]: 'Replacement draft' }, uploads: { [session.id]: [nextFile] },
        error: 'Keep replacement status',
        ...(replacement === 'identity' ? { health: { ...health, server_identity: 'replacement-server' } } : {}),
        ...(replacement === 'profile' ? { activeProfileId: 'replacement-profile' } : {}),
        ...(replacement === 'generation' ? { profileGeneration: 1 } : {}),
        ...(replacement === 'selection' ? { selectedSessionId: 'another-chat' } : {}),
      })
      finish.resolve()
      assert.equal(await sending, false)
      assert.equal(useAppStore.getState().drafts[session.id], 'Replacement draft')
      assert.deepEqual(useAppStore.getState().uploads[session.id], [nextFile])
      assert.equal(useAppStore.getState().error, 'Keep replacement status')
      assert.equal(requests.length, 1)
      assert.equal(syncs, 0)
    })
  }

  await test('a definite server rejection restores admitted text alongside newer typing', async () => {
    reset()
    const finish = deferred<void>()
    respond = async () => { await finish.promise; return json({ detail: 'Message rejected' }, 409) }
    const sending = send()
    useAppStore.getState().setSessionDraft(session.id, 'Keep newer typing', 0)
    finish.resolve()
    assert.equal(await sending, false)
    assert.equal(useAppStore.getState().drafts[session.id], 'Submitted message\n\nKeep newer typing')
    assert.deepEqual(useAppStore.getState().uploads[session.id], [admittedFile])
    assert.match(useAppStore.getState().error ?? '', /Message rejected/u)
    assert.equal(requests.length, 1)
  })

  await test('a transport failure without a received success does not claim the message was accepted or retry it', async () => {
    reset()
    respond = async () => { throw new Error('Synthetic transport unavailable') }
    assert.equal(await send(), false)
    assert.equal(useAppStore.getState().drafts[session.id], 'Submitted message')
    assert.deepEqual(useAppStore.getState().uploads[session.id], [admittedFile])
    assert.equal(useAppStore.getState().error, 'Synthetic transport unavailable')
    assert.equal(requests.length, 1)
  })
} finally {
  client.markValidated()
  globalThis.fetch = originalFetch
  useAppStore.setState({ syncSelectedSession: originalSync })
}
