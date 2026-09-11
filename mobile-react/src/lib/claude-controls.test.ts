import {
  CLAUDE_INTERACTIVE_CLIENT_CAPABILITY,
  claudeControlsCapability,
  claudeInteractiveClientCapability,
  isClaudeControlEvent,
  latestClaudeControlEventSeq,
  sessionNeedsClaudeInteraction,
  sessionNeedsProviderInteraction,
  sessionPendingInteractionCount,
} from './claude-controls'
import type { Event, Health, Session } from '../types'

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, received ${String(actual)}`)
}

const capableHealth = {
  ok: true,
  capabilities: {
    claude_controls: {
      available: true,
      version: 2,
      interactive_client_capability: CLAUDE_INTERACTIVE_CLIENT_CAPABILITY,
      features: { approvals: true, questions: true },
      fallback_transport: 'print',
    },
  },
} satisfies Health
equal(claudeControlsCapability(capableHealth)?.version, 2)
equal(claudeControlsCapability(capableHealth)?.fallback_transport, 'print')
equal(claudeInteractiveClientCapability(capableHealth), CLAUDE_INTERACTIVE_CLIENT_CAPABILITY)
equal(claudeControlsCapability({ ok: true }), null)
equal(claudeControlsCapability({
  ok: true,
  capabilities: { claude_controls: { available: false, version: 1 } },
}), null)
equal(claudeControlsCapability({
  ok: true,
  capabilities: {
    claude_controls: {
      available: true,
      version: 1,
      interactive_client_capability: 'claude_sdk_interactive_v2',
    },
  },
}), null)
equal(claudeInteractiveClientCapability({
  ok: true,
  capabilities: {
    claude_controls: {
      available: true,
      version: 1,
      interactive_capability: CLAUDE_INTERACTIVE_CLIENT_CAPABILITY,
    },
  },
}), CLAUDE_INTERACTIVE_CLIENT_CAPABILITY)

assert(isClaudeControlEvent('claude_interaction_requested'))
assert(isClaudeControlEvent('claude_interaction_resolved'))
assert(isClaudeControlEvent('provider_runtime_changed'))
assert(isClaudeControlEvent('turn_started'))
assert(isClaudeControlEvent('turn_finished'))
assert(isClaudeControlEvent('turn_stopped'))
assert(isClaudeControlEvent('error'))
assert(!isClaudeControlEvent('assistant_text'))

const controlEvents = [
  { seq: 2, id: 'a', session_id: 's', type: 'claude_interaction_requested', ts: '' },
  { seq: 3, id: 'b', session_id: 's', type: 'assistant_text', ts: '' },
  { seq: 4, id: 'c', session_id: 's', type: 'claude_interaction_resolved', ts: '' },
] satisfies Event[]
equal(latestClaudeControlEventSeq(controlEvents), 4)

const claudeWaiting = {
  id: 'claude',
  title: 'Claude',
  backend: 'claude',
  claude_pending_interaction_count: 2,
} satisfies Session
assert(sessionNeedsClaudeInteraction(claudeWaiting))
assert(sessionNeedsProviderInteraction(claudeWaiting))
equal(sessionPendingInteractionCount(claudeWaiting), 2)
assert(sessionNeedsClaudeInteraction({
  ...claudeWaiting,
  claude_pending_interaction_count: 0,
  claude_needs_user_action: true,
}))
equal(sessionPendingInteractionCount({
  ...claudeWaiting,
  claude_pending_interaction_count: 0,
  claude_needs_user_action: true,
}), 1)
assert(sessionNeedsClaudeInteraction({
  ...claudeWaiting,
  claude_pending_interaction_count: 0,
  latest_event_type: 'claude_interaction_requested',
}))
assert(!sessionNeedsClaudeInteraction({
  ...claudeWaiting,
  claude_pending_interaction_count: 0,
  claude_needs_user_action: false,
  latest_event_type: 'claude_interaction_resolved',
}))

const codexWaiting = {
  id: 'codex',
  title: 'Codex',
  backend: 'codex',
  codex_pending_interaction_count: 3,
} satisfies Session
assert(!sessionNeedsClaudeInteraction(codexWaiting))
assert(sessionNeedsProviderInteraction(codexWaiting))
equal(sessionPendingInteractionCount(codexWaiting), 3)
equal(sessionPendingInteractionCount({
  ...codexWaiting,
  codex_pending_interaction_count: 0,
  codex_needs_user_action: false,
}), 0)

console.log('Claude control helpers passed')
