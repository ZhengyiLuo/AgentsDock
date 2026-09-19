import assert from 'node:assert/strict'
import type { Health } from '../types'
import { completedPrefixForkAvailable } from './session-fork'

const health: Health = { ok: true, capabilities: { session_fork_completed_prefix_v1: {
  available: true, version: 1, supported_backends: ['codex', 'claude'],
} } }
assert.equal(completedPrefixForkAvailable(health, 'codex'), true)
assert.equal(completedPrefixForkAvailable(health, 'claude'), true)
assert.equal(completedPrefixForkAvailable(health, 'cursor'), false)
assert.equal(completedPrefixForkAvailable(health, undefined), false)
assert.equal(completedPrefixForkAvailable(null, 'codex'), false)
assert.equal(completedPrefixForkAvailable({ ok: true }, 'codex'), false)
assert.equal(completedPrefixForkAvailable({ ...health, ok: false }, 'codex'), false)
for (const capability of [null, {}, { available: false, version: 1, supported_backends: ['codex'] },
  { available: true, version: 2, supported_backends: ['codex'] },
  { available: true, version: 1, supported_backends: 'codex' },
  { available: true, version: 1, supported_backends: [] },
]) {
  assert.equal(completedPrefixForkAvailable({ ok: true, capabilities: { session_fork_completed_prefix_v1: capability } } as Health, 'codex'), false)
}
console.log('completed-prefix fork capability regressions passed')
