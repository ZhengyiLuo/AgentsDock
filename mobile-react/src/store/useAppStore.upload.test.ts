import assert from 'node:assert/strict'
import { AgentServerClientUnvalidatedError } from '../api/AgentServerClient'
import { client, useAppStore } from './useAppStore'
import type { AgentFile, Session, UploadRef } from '../types'

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const SESSION_ID = 'chat-upload'
const session: Session = { id: SESSION_ID, title: 'Uploads', backend: 'codex' }
const uploadedFile: AgentFile = { id: 'file-1', filename: 'photo.jpg' }
const fileRef = (name: string): UploadRef => ({ uri: `file:///tmp/${name}`, name })

client.markValidated()
const originalUpload = client.upload.bind(client)

function resetStore(): void {
  useAppStore.setState({
    initialized: true,
    activeProfileId: 'uninitialized',
    profileGeneration: 0,
    serverURL: 'http://127.0.0.1:7850',
    connected: true,
    connecting: false,
    switchingProfileId: null,
    workspaceAdopting: false,
    selectedSessionId: SESSION_ID,
    sessions: [session],
    uploads: {},
    uploadPending: {},
    uploadFailed: {},
    snapshots: {},
    error: null,
  })
}

const pendingUris = (): string[] => (useAppStore.getState().uploadPending[SESSION_ID] ?? []).map(file => file.uri)
const failedUploads = () => useAppStore.getState().uploadFailed[SESSION_ID] ?? []

try {
  // 1) A successful upload clears its pending row and records the file.
  resetStore()
  client.upload = async () => uploadedFile
  await useAppStore.getState().attachFiles([fileRef('ok.jpg')], undefined, SESSION_ID)
  assert.deepEqual(pendingUris(), [], 'a successful upload must clear its pending row')
  assert.equal(useAppStore.getState().uploads[SESSION_ID]?.[0]?.id, 'file-1')
  assert.deepEqual(failedUploads(), [])

  // 2) A real (non-stale) error surfaces as failed AND clears pending — never stuck on "Uploading…".
  resetStore()
  client.upload = async () => { throw new Error('server exploded') }
  await useAppStore.getState().attachFiles([fileRef('boom.jpg')], undefined, SESSION_ID)
  assert.deepEqual(pendingUris(), [], 'a failed upload must not stay stuck on Uploading…')
  assert.equal(failedUploads().length, 1)
  assert.match(failedUploads()[0]?.error ?? '', /server exploded/)

  // 3) The core regression: an upload that rejects after the scope is no longer
  //    authoritative (revoked validation / canceled fetch) clears pending silently.
  resetStore()
  const revoked = deferred<AgentFile>()
  client.upload = () => revoked.promise
  const revokedRun = useAppStore.getState().attachFiles([fileRef('revoked.jpg')], undefined, SESSION_ID)
  await Promise.resolve()
  assert.deepEqual(pendingUris(), ['file:///tmp/revoked.jpg'], 'the file is pending while in flight')
  revoked.reject(new AgentServerClientUnvalidatedError('validation revoked'))
  await revokedRun
  assert.deepEqual(pendingUris(), [], 'a revoked/canceled upload must clear pending, not hang')
  assert.deepEqual(failedUploads(), [], 'a stale upload clears silently rather than showing a spurious error')

  // 4) A success that lands after the active session is gone (e.g. a profile
  //    switch reset sessions) must still clear pending.
  resetStore()
  const late = deferred<AgentFile>()
  client.upload = () => late.promise
  const lateRun = useAppStore.getState().attachFiles([fileRef('late.jpg')], undefined, SESSION_ID)
  await Promise.resolve()
  assert.deepEqual(pendingUris(), ['file:///tmp/late.jpg'])
  useAppStore.setState({ sessions: [] }) // the active session vanished under us
  late.resolve(uploadedFile)
  await lateRun
  assert.deepEqual(pendingUris(), [], 'a success for a vanished session must still clear pending')

  // 5) Batch safety: when one file aborts on a stale scope, later queued files
  //    are not left pending and are not blindly re-attempted.
  resetStore()
  let uploadCalls = 0
  client.upload = async () => { uploadCalls += 1; throw new AgentServerClientUnvalidatedError('revoked mid-batch') }
  await useAppStore.getState().attachFiles([fileRef('a.jpg'), fileRef('b.jpg')], undefined, SESSION_ID)
  assert.equal(uploadCalls, 1, 'the batch stops after the stale upload')
  assert.deepEqual(pendingUris(), [], 'later queued files must not be left stuck when the batch aborts')
} finally {
  client.upload = originalUpload
}

console.log('upload pending-state regressions passed')
