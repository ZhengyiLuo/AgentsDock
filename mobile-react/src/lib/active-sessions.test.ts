import type { Health } from '../types'
import { healthActiveSessions, reconcileHealthActiveSessions } from './active-sessions'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const health = { ok: true, active: ['chat-server'], active_sessions: ['chat-legacy'] } satisfies Health
const parsed = healthActiveSessions(health)
assert(parsed.has('chat-server') && parsed.has('chat-legacy'), 'health should accept both active ID fields')

const current = new Set(['chat-live'])
assert(
  reconcileHealthActiveSessions(health, current, 4, 5) === current,
  'a live event newer than the health request must win',
)

const refreshed = reconcileHealthActiveSessions(health, current, 5, 5)
assert(refreshed.has('chat-server') && !refreshed.has('chat-live'), 'a current health response should be authoritative')

console.log('active session reconciliation regressions passed')
