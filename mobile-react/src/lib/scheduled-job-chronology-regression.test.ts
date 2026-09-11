import assert from 'node:assert/strict'
import type { Event } from '../types'
import { projectTimeline } from './timeline'

function event(seq: number, type: string, extra: Partial<Event> = {}): Event {
  return {
    id: `event-${seq}-${type}`,
    seq,
    session_id: 'chat-1',
    type,
    ts: new Date(Date.UTC(2026, 7, 26, 12, 0, seq)).toISOString(),
    ...extra,
  }
}

const rows = projectTimeline([
  event(5, 'job_summary', {
    purpose: 'scheduled_job',
    job_id: 'job-capacity',
    job_title: 'Capacity monitor',
    job_status: 'running',
    job_status_run_id: 'scheduled-run-capacity',
  }),
  // This packet is chronologically part of the first job occurrence. If its
  // summary-declared run link is ignored, it becomes generic live progress
  // and projectTimeline appends it after every otherwise ordered row.
  event(6, 'reasoning_summary', {
    run_id: 'scheduled-run-capacity',
    phase: 'commentary',
    text: 'Reading capacity at the scheduled run time.',
  }),
  event(10, 'error', { message: 'A later visible timeline event.' }),
  event(15, 'job_summary', {
    purpose: 'scheduled_job',
    job_id: 'job-backup',
    job_title: 'Backup monitor',
    job_status: 'completed',
    job_status_run_id: 'scheduled-run-backup',
    result_text: 'Backup is healthy.',
  }),
], [])

assert.deepEqual(
  rows.map(row => row.key),
  [
    'job:job-capacity',
    'event:event-10-error',
    'job:job-backup',
  ],
  'scheduled commentary must stay at its chronological job occurrence instead of becoming tail progress',
)
assert(
  rows.every((row, index) => index === 0 || rows[index - 1]!.seq <= row.seq),
  'scheduled-job projection must remain sequence chronological rather than appending an older row at the live edge',
)
const capacityRow = rows[0]
assert.equal(capacityRow?.kind, 'job')
if (capacityRow?.kind !== 'job') throw new Error('Expected the capacity scheduled job row')
assert(
  capacityRow.events.some(candidate => (
    candidate.type === 'reasoning_summary'
    && candidate.text === 'Reading capacity at the scheduled run time.'
  )),
  'scheduled commentary must remain available in the job reasoning trace',
)
assert(
  !rows.some(row => row.kind === 'progress'),
  'scheduled commentary must never be promoted to generic live-edge progress',
)

console.log('scheduled job chronological placement regressions passed')
