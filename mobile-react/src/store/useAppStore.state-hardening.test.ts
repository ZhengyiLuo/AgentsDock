import assert from 'node:assert/strict'
import type { Job, PublicServerProfile } from '../types'
import { client, useAppStore } from './useAppStore'

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const timestamp = '2026-07-31T12:00:00Z'
const profile = (id: string, serverURL: string): PublicServerProfile => ({
  id,
  name: id,
  serverURL,
  serverIdentity: `identity-${id}`,
  serverConfigured: true,
  credentialVersion: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  hasAccessToken: true,
  connectionState: id === 'uninitialized' ? 'online' : 'cached',
  cachedUnreadCount: 0,
})

client.markValidated()
const originalClient = client
const profiles = [
  profile('uninitialized', 'http://127.0.0.1:7850'),
  profile('profile-b', 'http://127.0.0.1:7851'),
]
useAppStore.setState({
  initialized: true,
  profiles,
  activeProfileId: 'uninitialized',
  profileGeneration: 0,
  serverURL: 'http://127.0.0.1:7850',
  connected: true,
  connecting: false,
  switchingProfileId: null,
  sendingSessionIds: new Set(['chat-sending']),
  error: null,
})

await assert.rejects(
  useAppStore.getState().switchServerProfile('profile-b'),
  /message is still sending/i,
  'switching profiles must be rejected while an optimistic send owns the active connection',
)
let state = useAppStore.getState()
assert.equal(state.activeProfileId, 'uninitialized')
assert.equal(state.profileGeneration, 0)
assert.equal(state.switchingProfileId, null)
assert.equal(client, originalClient, 'a rejected switch must preserve the active connection object')
assert.equal(state.profiles.find(value => value.id === 'profile-b')?.connectionState, 'cached', 'a local send guard must not mark the target server offline')
assert.match(state.error ?? '', /message is still sending/i)

await assert.rejects(
  useAppStore.getState().updateServerProfile('uninitialized', { serverURL: 'http://127.0.0.1:7999' }),
  /message is still sending/i,
  'editing the active connection must be rejected before probing or persisting it',
)
state = useAppStore.getState()
assert.equal(state.serverURL, 'http://127.0.0.1:7850')
assert.equal(state.profiles[0]?.serverURL, 'http://127.0.0.1:7850')
assert.equal(client, originalClient)

useAppStore.setState({ sendingSessionIds: new Set(), error: null, jobs: [] })
let jobsCalls = 0
const jobsGate = deferred<void>()
const returnedJob: Job = {
  id: 'job-1',
  session_id: 'chat-1',
  title: 'Status report',
  prompt: 'Report status',
  interval_seconds: null,
}
const originalJobs = originalClient.jobs.bind(originalClient)
originalClient.jobs = async () => {
  jobsCalls += 1
  await jobsGate.promise
  return [returnedJob]
}
try {
  const firstRefresh = useAppStore.getState().refreshJobs(0)
  const coalescedRefresh = useAppStore.getState().refreshJobs(0)
  const alsoCoalescedRefresh = useAppStore.getState().refreshJobs(0)
  await Promise.resolve()
  assert.equal(jobsCalls, 1, 'same-scope job refreshes must share one server request')
  jobsGate.resolve(undefined)
  await Promise.all([firstRefresh, coalescedRefresh, alsoCoalescedRefresh])
  assert.equal(jobsCalls, 2, 'invalidations received in flight must collapse into exactly one trailing refresh')
  assert.deepEqual(useAppStore.getState().jobs, [returnedJob])
} finally {
  originalClient.jobs = originalJobs
}

async function assertMutationSurvivesStaleJobRefresh(
  label: string,
  initialJobs: Job[],
  staleJobs: Job[],
  expectedJobs: Job[],
  mutate: () => Promise<void>,
): Promise<void> {
  useAppStore.setState({ jobs: initialJobs })
  const staleGate = deferred<void>()
  const trailingGate = deferred<void>()
  let calls = 0
  let refresh: Promise<void> | null = null
  originalClient.jobs = async () => {
    calls += 1
    if (calls === 1) {
      await staleGate.promise
      return staleJobs
    }
    await trailingGate.promise
    return expectedJobs
  }
  try {
    refresh = useAppStore.getState().refreshJobs(0)
    await Promise.resolve()
    assert.equal(calls, 1, `${label} must begin with one job refresh`)

    await mutate()
    assert.deepEqual(useAppStore.getState().jobs, expectedJobs, `${label} must update the local list immediately`)

    staleGate.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(calls, 2, `${label} must invalidate an older job response and start a trailing refresh`)
    assert.deepEqual(useAppStore.getState().jobs, expectedJobs, `${label} must not be overwritten by the stale response`)

    trailingGate.resolve(undefined)
    await refresh
    assert.deepEqual(useAppStore.getState().jobs, expectedJobs, `${label} must converge on the authoritative list`)
  } finally {
    staleGate.resolve(undefined)
    trailingGate.resolve(undefined)
    if (refresh) await refresh.catch(() => undefined)
    originalClient.jobs = originalJobs
  }
}

const createdJob: Job = {
  id: 'job-created',
  session_id: 'chat-1',
  title: 'Created job',
  prompt: 'Create status',
  interval_seconds: 600,
}
const originalCreateJob = originalClient.createJob.bind(originalClient)
originalClient.createJob = async () => createdJob
try {
  await assertMutationSurvivesStaleJobRefresh('createJob', [], [], [createdJob], async () => {
    const created = await useAppStore.getState().createJob({
      session_id: 'chat-1',
      title: createdJob.title,
      prompt: createdJob.prompt,
      interval_seconds: createdJob.interval_seconds,
      loop: true,
      enabled: true,
    }, 0)
    assert.equal(created, true)
  })
} finally {
  originalClient.createJob = originalCreateJob
}

const updatedJob: Job = {
  id: 'job-updated',
  session_id: 'chat-1',
  title: 'Updated job',
  prompt: 'Updated status',
  interval_seconds: 1200,
}
const originalUpdateJob = originalClient.updateJob.bind(originalClient)
originalClient.updateJob = async () => updatedJob
try {
  await assertMutationSurvivesStaleJobRefresh('updateJob', [], [], [updatedJob], async () => {
    const updated = await useAppStore.getState().updateJob(updatedJob.id, { title: updatedJob.title }, 0)
    assert.equal(updated, true)
  })
} finally {
  originalClient.updateJob = originalUpdateJob
}

const deletedJob: Job = {
  id: 'job-deleted',
  session_id: 'chat-1',
  title: 'Deleted job',
  prompt: 'Delete status',
  interval_seconds: 1800,
}
const originalDeleteJob = originalClient.deleteJob.bind(originalClient)
originalClient.deleteJob = async () => undefined
try {
  await assertMutationSurvivesStaleJobRefresh('deleteJob', [deletedJob], [deletedJob], [], async () => {
    await useAppStore.getState().deleteJob(deletedJob.id, 0)
  })
} finally {
  originalClient.deleteJob = originalDeleteJob
}

const jobBeforeRun: Job = {
  id: 'job-run',
  session_id: 'chat-1',
  title: 'Run job',
  prompt: 'Run status',
  interval_seconds: 1800,
  run_count: 0,
  manual_run_pending: false,
}
const jobAfterRun: Job = {
  ...jobBeforeRun,
  manual_run_pending: true,
}
const originalRunJob = originalClient.runJob.bind(originalClient)
let runJobCalls = 0
originalClient.runJob = async () => {
  runJobCalls += 1
  return {
    ok: true,
    queued: true,
    deferred: true,
    job_id: jobAfterRun.id,
    job: jobAfterRun,
    message: 'Waiting for this chat to become idle.',
  }
}
try {
  await assertMutationSurvivesStaleJobRefresh('runJob', [jobBeforeRun], [jobBeforeRun], [jobAfterRun], async () => {
    const [result, duplicateResult] = await Promise.all([
      useAppStore.getState().runJob(jobBeforeRun.id, 0),
      useAppStore.getState().runJob(jobBeforeRun.id, 0),
    ])
    assert.equal(runJobCalls, 1, 'runJob must coalesce duplicate requests across mounted controls')
    assert.equal(result?.deferred, true)
    assert.equal(duplicateResult?.deferred, true)
    assert.equal(result?.job?.manual_run_pending, true)
  })

  originalClient.runJob = async () => { throw new Error('manual run rejected') }
  useAppStore.setState({ error: null })
  const failedResult = await useAppStore.getState().runJob(jobBeforeRun.id, 0)
  assert.equal(failedResult?.ok, false)
  assert.match(failedResult?.error ?? '', /manual run rejected/)
  assert.equal(useAppStore.getState().error, null, 'inline job-run errors must not leak behind the modal as a stale global error')
  assert.equal(useAppStore.getState().pendingJobRunIds.has(jobBeforeRun.id), false, 'failed run requests must release their pending gate')
} finally {
  originalClient.runJob = originalRunJob
}

console.log('store send/profile and job-refresh mutation hardening regressions passed')
