import assert from 'node:assert/strict'
import { canQueryScheduledJobHistory } from './job-history'

assert.equal(
  canQueryScheduledJobHistory('job-current-only'),
  true,
  'a stable job ID must expose authoritative run-history discovery even when no prior run is loaded locally',
)
assert.equal(canQueryScheduledJobHistory('  '), false, 'blank server job IDs must not create a broken history action')
assert.equal(canQueryScheduledJobHistory(null), false, 'timeline rows without a job ID cannot query server history')

console.log('scheduled job history discovery regressions passed')
