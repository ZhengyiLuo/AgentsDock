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

for (const runField of [
  'job_status_run_id',
  'job_latest_status_run_id',
  'job_latest_run_id',
] as const) {
  const rows = projectTimeline([
    event(10, 'job_summary', {
      purpose: 'scheduled_job',
      job_id: 'job-health',
      job_title: 'Workspace health',
      job_status: 'running',
      [runField]: 'scheduled-run-current',
    }),
    // Live provider activity can omit job_id/purpose; the semantic summary's
    // current-run aliases are the authoritative link back to the job card.
    event(11, 'reasoning_summary', {
      run_id: 'scheduled-run-current',
      text: 'Checking workspace health.',
    }),
    event(12, 'tool_started', {
      run_id: 'scheduled-run-current',
      tool: { name: 'workspace_health' },
    }),
  ], [])

  assert.equal(
    rows.length,
    1,
    `${runField} must keep metadata-light scheduled activity in one job row`,
  )
  assert.equal(rows[0]?.kind, 'job', `${runField} must not create an ordinary chat trace`)
  if (rows[0]?.kind !== 'job') throw new Error(`Expected a scheduled job row for ${runField}`)
  assert.deepEqual(
    rows[0].events.map(candidate => candidate.type),
    ['job_summary', 'reasoning_summary', 'tool_started'],
    `${runField} must preserve scheduled reasoning and tool activity for the in-card trace`,
  )
}

console.log('scheduled job reasoning trace regressions passed')
