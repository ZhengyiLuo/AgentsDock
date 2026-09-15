import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, Health, Job } from '../types'
import { activeScheduledJobId, activeSessionRunId, currentRunningJobIds, scheduledJobRuntimeError } from './scheduled-job-activity'
const event = (seq: number, patch: Partial<Event> = {}): Event => ({ id: `e${seq}`, seq, session_id: 'chat', ts: '2026-09-14T10:00:00Z', type: 'job_started', job_id: 'job', run_id: 'run', ...patch })
test('only the exact active run can identify a stoppable job', () => {
  assert.equal(activeScheduledJobId([event(1)], 'run'), 'job')
  assert.equal(activeScheduledJobId([event(1)], 'user-run'), null)
  assert.equal(activeScheduledJobId([event(1)], null), null)
  assert.deepEqual([...currentRunningJobIds([event(1)], true, 'user-run')], [])
})
test('semantic job status aliases identify active ownership', () => {
  for (const alias of ['job_status_run_id', 'job_latest_status_run_id', 'job_latest_run_id']) {
    assert.equal(activeScheduledJobId([event(1, { run_id: undefined, [alias]: 'run', job_status: 'running' })], 'run'), 'job')
  }
})
test('latest terminal status wins even in out-of-order semantic history', () => {
  const events = [event(2, { type: 'job_finished', job_status_seq: 50 }), event(3, { job_status: 'running' })]
  assert.equal(activeScheduledJobId(events, 'run'), null)
  assert.equal(currentRunningJobIds(events, true).size, 0)
})
test('deferred and queued states are not running, and inactive chats never show running jobs', () => {
  for (const status of ['queued', 'deferred', 'cancelled', 'failed', 'completed']) assert.equal(activeScheduledJobId([event(1, { job_status: status })], 'run'), null)
  assert.equal(currentRunningJobIds([event(1)], false).size, 0)
  assert.deepEqual([...currentRunningJobIds([event(1)], true)], ['job'])
})
test('health run IDs must be nonblank strings and belong to this chat', () => {
  const health = (run_id: unknown) => ({ active_runs: [{ session_id: 'chat', run_id }] }) as Health
  assert.equal(activeSessionRunId(health('run'), 'chat'), 'run')
  assert.equal(activeSessionRunId(health('run'), 'elsewhere'), null)
  for (const malformed of ['', ' ', 123, true, {}]) assert.equal(activeSessionRunId(health(malformed), 'chat'), null)
})
test('standalone runtime follows job backend; continuation follows the chat backend', () => {
  const job = { backend: 'cursor', context_mode: 'standalone' } as Job
  assert.match(scheduledJobRuntimeError(job, { backend: 'codex' }, null, null)!, /Cursor/)
  assert.equal(scheduledJobRuntimeError({ ...job, context_mode: 'continuation' } as Job, { backend: 'codex' }, null, null), null)
})
