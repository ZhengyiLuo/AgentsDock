import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable } from 'react-native'
import { client, useAppStore } from '../store/useAppStore'
import type { GeminiRuntimeSnapshot, JsonValue } from '../types'
import { ProviderInteractionShelf } from './CodexInteractionShelf'
import { Text } from './AppText'

export function GeminiInteractionShelf({ sessionId }: { sessionId: string }) {
  const profile = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const supported = useAppStore(state => state.sessions.find(item => item.id === sessionId)?.backend === 'gemini'
    && state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting
    && state.health?.capabilities?.gemini_backend?.client_capability === 'gemini_acp_v1')
  return supported ? <ScopedGeminiShelf key={`${profile}:${generation}:${sessionId}`} sessionId={sessionId} /> : null
}

function ScopedGeminiShelf({ sessionId }: { sessionId: string }) {
  const [runtime, setRuntime] = useState<GeminiRuntimeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const owner = useRef({ connection: client, profile: useAppStore.getState().activeProfileId, generation: useAppStore.getState().profileGeneration })
  const mounted = useRef(true)
  const inFlight = useRef<Promise<void> | null>(null)
  const dirty = useRef(false)
  const signal = useAppStore(state => {
    const events = state.snapshots[sessionId]?.events ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      if (['gemini_interaction_requested', 'gemini_interaction_resolved', 'turn_finished', 'turn_stopped', 'error'].includes(events[i].type)) return events[i].seq
    }
    return 0
  })
  const current = useCallback(() => {
    const state = useAppStore.getState()
    return mounted.current && client === owner.current.connection && client.isValidated && !client.isDisposed
      && state.activeProfileId === owner.current.profile && state.profileGeneration === owner.current.generation
      && state.selectedSessionId === sessionId && state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting
  }, [sessionId])
  const refresh = useCallback((): Promise<void> => {
    if (!current()) return Promise.resolve()
    if (inFlight.current) { dirty.current = true; return inFlight.current }
    const operation = (async () => {
      do {
        dirty.current = false
        try {
          const next = await owner.current.connection.geminiRuntime(sessionId)
          if (!current()) return
          setRuntime(next); setError(null)
        } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
      } while (dirty.current && current())
    })().finally(() => { if (inFlight.current === operation) inFlight.current = null })
    inFlight.current = operation
    return operation
  }, [current, sessionId])
  useEffect(() => {
    mounted.current = true
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void refresh() })
    return () => { mounted.current = false; listener.remove() }
  }, [refresh])
  useEffect(() => { void refresh() }, [signal, refresh])
  const respond = async (interactionId: string, response: Record<string, JsonValue>) => {
    if (!current() || busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      await owner.current.connection.resolveGeminiInteraction(sessionId, interactionId, response)
      if (current()) await refresh()
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { busyRef.current = false; if (current()) setBusy(false) }
  }
  return <>
    {error && !runtime?.pending_interactions.length ? <Pressable testID="gemini-requests-retry" accessibilityRole="button" onPress={() => void refresh()}><Text localize>Could not load Gemini requests. Retry</Text></Pressable> : null}
    <ProviderInteractionShelf providerName="Gemini" supported busy={busy} error={error} sessionId={sessionId} interactions={runtime?.pending_interactions ?? []} onRetry={refresh} onRespond={respond} />
  </>
}
