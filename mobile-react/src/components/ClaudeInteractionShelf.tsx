import type { JsonValue } from '../types'
import { ProviderInteractionShelf } from './CodexInteractionShelf'
import { useClaudeRuntime } from './ClaudeRuntimeContext'

export function ClaudeInteractionShelf() {
  const {
    supported,
    mutating,
    runtimeError,
    interactionError,
    runtime,
    session,
    refresh,
    run,
  } = useClaudeRuntime()

  const respond = (interactionId: string, response: Record<string, JsonValue>) => {
    if (!supported || !session) return Promise.resolve(null)
    return run(async (connection, targetSessionId) => {
      await connection.resolveClaudeInteraction(targetSessionId, interactionId, response)
    })
  }

  return <ProviderInteractionShelf
    providerName="Claude"
    supported={supported}
    // Runtime refreshes are observational and must never disable a decision.
    // Claude can emit another control event while this sheet is open, so using
    // `refreshing` here made every button temporarily (and, under a busy event
    // stream, effectively permanently) untappable. Only an actual response
    // mutation owns the interaction controls.
    busy={mutating}
    error={interactionError ?? (runtime === null ? runtimeError : null)}
    sessionId={session?.id ?? null}
    interactions={runtime?.pending_interactions ?? []}
    pendingInteractionCount={Math.max(
      session?.claude_pending_interaction_count ?? 0,
      session?.claude_needs_user_action ? 1 : 0,
      session?.latest_event_type === 'claude_interaction_requested' ? 1 : 0,
    )}
    closeTestID="claude-requests-close"
    onRetry={refresh}
    onRespond={respond}
  />
}
