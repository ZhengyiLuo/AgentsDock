import {
  CODEX_INTERACTIVE_CLIENT_CAPABILITY,
  advertisedStructuredDecisions,
  codexControlsCapability,
  codexInteractiveClientCapability,
  codexStatusLabel,
  codexStatusTone,
  isAgentActivityEvent,
  isCodexControlEvent,
  latestCodexControlEventSeq,
  remainingAutoResolveSeconds,
  sessionNeedsCodexInteraction,
} from './codex-controls'
import type { CodexPendingInteraction, Event, Health, Session } from '../types'

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, received ${String(actual)}`)
}

const capableHealth = {
  ok: true,
  capabilities: {
    codex_controls: {
      available: true,
      version: 1,
      interactive_client_capability: 'codex_interactive_v1',
      features: { approvals: true },
    },
  },
} as Health
equal(codexControlsCapability(capableHealth)?.version, 1)
equal(codexInteractiveClientCapability(capableHealth), CODEX_INTERACTIVE_CLIENT_CAPABILITY)
equal(codexControlsCapability({ ok: true } as Health), null)
equal(codexControlsCapability({ ok: true, capabilities: { codex_controls: { available: false, version: 1 } } } as Health), null)
equal(codexControlsCapability({ ok: true, capabilities: { codex_controls: { available: true, version: 0 } } } as Health), null)
equal(
  codexInteractiveClientCapability({
    ok: true,
    capabilities: { codex_controls: { available: true, version: 1 } },
  } as Health),
  null,
)
equal(
  codexInteractiveClientCapability({
    ok: true,
    capabilities: {
      codex_controls: {
        available: true,
        version: 1,
        interactive_client_capability: 'unknown_interactive_v2',
      },
    },
  } as Health),
  null,
)

const advertisedExecDecision = {
  acceptWithExecpolicyAmendment: {
    execpolicy_amendment: ['git', 'status'],
  },
}
const advertisedNetworkDecision = {
  applyNetworkPolicyAmendment: {
    network_policy_amendment: { action: 'allow', host: 'example.com' },
  },
}
const availableDecisions = [
  'accept',
  advertisedExecDecision,
  advertisedNetworkDecision,
  { acceptWithExecpolicyAmendment: 'invalid' },
]
const execDecisions = advertisedStructuredDecisions(
  availableDecisions,
  'acceptWithExecpolicyAmendment',
)
equal(execDecisions.length, 1)
equal(execDecisions[0], advertisedExecDecision, 'advertised decisions must be returned unchanged')
const networkDecisions = advertisedStructuredDecisions(
  availableDecisions,
  'applyNetworkPolicyAmendment',
)
equal(networkDecisions.length, 1)
equal(networkDecisions[0], advertisedNetworkDecision, 'network decisions must be returned unchanged')
equal(advertisedStructuredDecisions(undefined, 'acceptWithExecpolicyAmendment').length, 0)
equal(advertisedStructuredDecisions(['accept'], 'acceptWithExecpolicyAmendment').length, 0)

equal(codexStatusLabel({ type: 'idle' }), 'Idle')
equal(codexStatusLabel({ type: 'active', activeFlags: [] }), 'Running')
equal(codexStatusLabel({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'Approval needed')
equal(codexStatusLabel({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'Answer needed')
equal(codexStatusTone({
  available: true,
  transport: 'app-server',
  interactive_capability: CODEX_INTERACTIVE_CLIENT_CAPABILITY,
  thread_loaded: true,
  status: { type: 'active', activeFlags: [] },
  goal: null,
  time_budget_seconds: null,
  pending_interactions: [],
  permission_profiles: [],
  background_terminals_supported: false,
}), 'active')

assert(isCodexControlEvent('codex_interaction_requested'))
assert(isCodexControlEvent('codex_token_usage'))
assert(isCodexControlEvent('review_finished'))
assert(isCodexControlEvent('context_compaction'))
assert(isCodexControlEvent('turn_started'))
assert(isCodexControlEvent('turn_finished'))
assert(isCodexControlEvent('turn_stopped'))
assert(isCodexControlEvent('error'))
assert(!isCodexControlEvent('assistant_text'))
assert(isAgentActivityEvent({ type: 'codex_interaction_requested' }))
assert(isAgentActivityEvent({ type: 'claude_interaction_requested' }))
assert(!isAgentActivityEvent({ type: 'codex_interaction_resolved' }))
assert(!isAgentActivityEvent({ type: 'claude_interaction_resolved' }))
assert(sessionNeedsCodexInteraction({
  backend: 'codex',
  codex_pending_interaction_count: 1,
} as Session))
assert(sessionNeedsCodexInteraction({
  backend: 'codex',
  codex_needs_user_action: true,
} as Session))
assert(sessionNeedsCodexInteraction({
  backend: 'codex',
  latest_event_type: 'codex_interaction_requested',
} as Session))
assert(!sessionNeedsCodexInteraction({
  backend: 'codex',
  codex_pending_interaction_count: 0,
  codex_needs_user_action: false,
  latest_event_type: 'codex_interaction_resolved',
} as Session))
assert(!sessionNeedsCodexInteraction({
  backend: 'claude',
  codex_pending_interaction_count: 2,
  codex_needs_user_action: true,
  latest_event_type: 'codex_interaction_requested',
} as Session))
const controlEvents = [
  { seq: 1, id: 'a', session_id: 's', type: 'codex_goal_updated', ts: '' },
  { seq: 2, id: 'b', session_id: 's', type: 'assistant_text', ts: '' },
  { seq: 3, id: 'c', session_id: 's', type: 'codex_interaction_requested', ts: '' },
] satisfies Event[]
equal(latestCodexControlEventSeq(controlEvents), 3)

const interaction = {
  id: 'i',
  session_id: 's',
  thread_id: 't',
  method: 'item/tool/requestUserInput',
  params: {},
  created_at: '2026-07-28T00:00:00.000Z',
  auto_resolution_ms: 60_000,
} satisfies CodexPendingInteraction
equal(remainingAutoResolveSeconds(interaction, Date.parse('2026-07-28T00:00:15.100Z')), 45)
equal(remainingAutoResolveSeconds({ ...interaction, auto_resolution_ms: null }), null)

console.log('Codex control helpers passed')
