import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  ClaudePendingInteraction,
  ClaudeRuntimeSnapshot,
  Session
} from '@shared/types'
import { useAppStore } from '../store/app-store'

export const CLAUDE_RUNTIME_REFRESH_TIMEOUT_MS = 10_000

export type ClaudeInteraction = ClaudePendingInteraction
export type { ClaudeRuntimeSnapshot }

interface ClaudeRuntimeContextValue {
  supported: boolean
  loading: boolean
  refreshing: boolean
  mutating: boolean
  runtimeError: string | null
  interactionError: string | null
  contextUsageError: string | null
  runtime: ClaudeRuntimeSnapshot | null
  session: Session | null
  refresh(): Promise<ClaudeRuntimeSnapshot | null>
  refreshContextUsage(): Promise<ClaudeRuntimeSnapshot | null>
  run<T>(operation: () => Promise<T>): Promise<T>
}

const ClaudeRuntimeContext = createContext<ClaudeRuntimeContextValue>({
  supported: false,
  loading: false,
  refreshing: false,
  mutating: false,
  runtimeError: null,
  interactionError: null,
  contextUsageError: null,
  runtime: null,
  session: null,
  refresh: async () => null,
  refreshContextUsage: async () => null,
  run: async operation => operation()
})

interface ClaudeRuntimeProviderProps {
  session: Session | null
  capability?: unknown
  children: ReactNode
}

export function ClaudeRuntimeProvider({ session, capability, children }: ClaudeRuntimeProviderProps) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const [runtime, setRuntime] = useState<ClaudeRuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const [contextUsageError, setContextUsageError] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const refreshQueued = useRef<number | null>(null)
  const contextUsageRefreshEpoch = useRef<number | null>(null)
  const contextUsageGenerationRef = useRef<number | null>(null)
  const mutationCount = useRef(0)
  const connectedRef = useRef(connected)
  const runtimeRef = useRef<ClaudeRuntimeSnapshot | null>(null)
  const sessionIdRef = useRef(session?.id)
  sessionIdRef.current = session?.id
  const profileIdentity = `${activeProfileId ?? ''}\u0000${profileGeneration}`
  const profileIdentityRef = useRef(profileIdentity)
  profileIdentityRef.current = profileIdentity
  const bridgeAvailable = Boolean(claudeBridge())
  const capabilityAvailable = isClaudeCapabilityAvailable(capability)
  const supported = Boolean(session?.backend === 'claude' && bridgeAvailable && capabilityAvailable)

  useEffect(() => {
    // React StrictMode replays effects without rendering between cleanup and
    // setup. Restore the current identity so the replayed initial refresh is
    // not mistaken for a stale session.
    sessionIdRef.current = session?.id
    return () => {
      requestEpoch.current += 1
      sessionIdRef.current = undefined
    }
  }, [session?.id])

  const refreshRuntime = useCallback(async (errorTarget: 'runtime' | 'contextUsage') => {
    const sessionId = session?.id
    const bridge = claudeBridge()
    if (mutationCount.current > 0) return runtimeRef.current
    if (!supported || !sessionId || !bridge || sessionIdRef.current !== sessionId) {
      runtimeRef.current = null
      setRuntime(null)
      setRuntimeError(null)
      setInteractionError(null)
      setContextUsageError(null)
      contextUsageGenerationRef.current = null
      setLoading(false)
      setRefreshing(false)
      return null
    }
    const epoch = ++requestEpoch.current
    setRefreshing(Boolean(runtimeRef.current))
    if (!runtimeRef.current) setLoading(true)
    try {
      const next = await boundedClaudeRefresh(
        bridge.runtime(sessionId),
        'Claude runtime refresh timed out.'
      )
      if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
      const previousUsageGeneration = contextUsageGenerationRef.current
      const nextUsageGeneration = claudeUsageGeneration(next)
      const usageGenerationAdvanced = previousUsageGeneration !== null
        && nextUsageGeneration !== null
        && nextUsageGeneration > previousUsageGeneration
      if (
        nextUsageGeneration !== null
        && (previousUsageGeneration === null || nextUsageGeneration > previousUsageGeneration)
      ) contextUsageGenerationRef.current = nextUsageGeneration
      runtimeRef.current = next
      setRuntime(next)
      if (errorTarget === 'contextUsage' || usageGenerationAdvanced) {
        setContextUsageError(null)
      }
      if (errorTarget === 'runtime') setRuntimeError(null)
      return next
    } catch (cause) {
      if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
      if (errorTarget === 'contextUsage') setContextUsageError(errorMessage(cause))
      else setRuntimeError(errorMessage(cause))
      return null
    } finally {
      if (epoch === requestEpoch.current && sessionIdRef.current === sessionId) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [session?.id, supported])

  const refresh = useCallback(
    () => refreshRuntime('runtime'),
    [refreshRuntime]
  )

  const refreshContextUsage = useCallback(async () => {
    const sessionId = session?.id
    const bridge = claudeBridge()
    if (mutationCount.current > 0) return runtimeRef.current
    if (!supported || !sessionId || !bridge || sessionIdRef.current !== sessionId) return null

    // Older AgentsServer builds expose the observational runtime endpoint but
    // not the additive SDK sampling route. Keep their existing behavior and
    // never probe a route they did not advertise.
    if (
      runtimeRef.current?.features?.context_usage_refresh !== true
      || typeof bridge.refreshContextUsage !== 'function'
    ) return refreshRuntime('contextUsage')

    const requestProfileIdentity = profileIdentity
    const epoch = ++requestEpoch.current
    if (refreshQueued.current !== null) {
      window.clearTimeout(refreshQueued.current)
      refreshQueued.current = null
    }
    setRefreshing(true)
    contextUsageRefreshEpoch.current = epoch
    try {
      const next = await boundedClaudeRefresh(
        bridge.refreshContextUsage(sessionId),
        'Claude context refresh timed out.'
      )
      if (
        epoch !== requestEpoch.current
        || sessionIdRef.current !== sessionId
        || profileIdentityRef.current !== requestProfileIdentity
      ) return null
      const nextUsageGeneration = claudeUsageGeneration(next)
      const previousUsageGeneration = contextUsageGenerationRef.current
      if (
        nextUsageGeneration !== null
        && (previousUsageGeneration === null || nextUsageGeneration > previousUsageGeneration)
      ) contextUsageGenerationRef.current = nextUsageGeneration
      runtimeRef.current = next
      setRuntime(next)
      setContextUsageError(null)
      return next
    } catch (cause) {
      if (
        epoch !== requestEpoch.current
        || sessionIdRef.current !== sessionId
        || profileIdentityRef.current !== requestProfileIdentity
      ) return null
      // Keep the last authoritative sample visible. The refresh error is
      // supplemental state, not evidence that the stored sample disappeared.
      setContextUsageError(errorMessage(cause))
      return null
    } finally {
      if (contextUsageRefreshEpoch.current === epoch) {
        contextUsageRefreshEpoch.current = null
      }
      if (
        epoch === requestEpoch.current
        && sessionIdRef.current === sessionId
        && profileIdentityRef.current === requestProfileIdentity
      ) setRefreshing(false)
    }
  }, [profileIdentity, refreshRuntime, session?.id, supported])

  useEffect(() => {
    requestEpoch.current += 1
    mutationCount.current = 0
    runtimeRef.current = null
    setRuntime(null)
    setRuntimeError(null)
    setInteractionError(null)
    setContextUsageError(null)
    contextUsageRefreshEpoch.current = null
    contextUsageGenerationRef.current = null
    setMutating(false)
    setLoading(false)
    setRefreshing(false)
    if (supported) void refresh()
  }, [activeProfileId, capabilityAvailable, profileGeneration, refresh, session?.id, supported])

  useEffect(() => {
    const reconnected = connected && !connectedRef.current
    connectedRef.current = connected
    if (reconnected && supported) void refresh()
  }, [connected, refresh, supported])

  useEffect(() => {
    // Apply the shared bridge's cached runtime after the new Session commits;
    // replacing Session also cleans up any pre-commit event refresh timer.
    if (window.agentsDock.sharedChat && supported) void refresh()
  }, [refresh, session, supported])

  useEffect(() => {
    if (!supported || !session?.id) return
    const queueRefresh = () => {
      if (
        mutationCount.current > 0
        || contextUsageRefreshEpoch.current !== null
        || refreshQueued.current !== null
      ) return
      refreshQueued.current = window.setTimeout(() => {
        refreshQueued.current = null
        if (mutationCount.current === 0) void refresh()
      }, 60)
    }
    const unsubscribeEvent = window.agentsDock.events.on('server:event', payload => {
      if (
        payload.profileId !== activeProfileId
        || payload.profileGeneration !== profileGeneration
        || payload.event.session_id !== session.id
        || !isClaudeControlEvent(payload.event.type)
      ) return
      queueRefresh()
    })
    const unsubscribeProviderRuntime = window.agentsDock.events.on('server:provider-runtime', payload => {
      if (
        payload.profileId !== activeProfileId
        || payload.profileGeneration !== profileGeneration
        || payload.event.session_id !== session.id
        || payload.event.backend !== 'claude'
        || payload.event.runtime !== 'context_usage'
      ) return
      queueRefresh()
    })
    const unsubscribeSessions = window.agentsDock.events.on('server:sessions', payload => {
      if (payload.profileId !== activeProfileId || payload.profileGeneration !== profileGeneration) return
      const updated = payload.sessions.find(candidate => candidate.id === session.id)
      if (!updated) return
      if (
        numberField(session, 'claude_pending_interaction_count') !== numberField(updated, 'claude_pending_interaction_count')
        || booleanField(session, 'claude_needs_user_action') !== booleanField(updated, 'claude_needs_user_action')
      ) queueRefresh()
    })
    return () => {
      unsubscribeEvent()
      unsubscribeProviderRuntime()
      unsubscribeSessions()
      if (refreshQueued.current !== null) window.clearTimeout(refreshQueued.current)
      refreshQueued.current = null
    }
  }, [activeProfileId, profileGeneration, refresh, session, supported])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const sessionId = session?.id
    requestEpoch.current += 1
    if (refreshQueued.current !== null) {
      window.clearTimeout(refreshQueued.current)
      refreshQueued.current = null
    }
    setLoading(false)
    setRefreshing(false)
    setInteractionError(null)
    mutationCount.current += 1
    setMutating(true)
    let succeeded = false
    try {
      const result = await operation()
      succeeded = true
      return result
    } catch (cause) {
      if (sessionIdRef.current === sessionId) setInteractionError(errorMessage(cause))
      throw cause
    } finally {
      if (sessionIdRef.current === sessionId) {
        mutationCount.current = Math.max(0, mutationCount.current - 1)
        setMutating(mutationCount.current > 0)
        if (succeeded) void refresh()
      }
    }
  }, [refresh, session?.id])

  const value = useMemo<ClaudeRuntimeContextValue>(() => ({
    supported,
    loading,
    refreshing,
    mutating,
    runtimeError,
    interactionError,
    contextUsageError,
    runtime,
    session,
    refresh,
    refreshContextUsage,
    run
  }), [contextUsageError, interactionError, loading, mutating, refresh, refreshContextUsage, refreshing, run, runtime, runtimeError, session, supported])

  return <ClaudeRuntimeContext.Provider value={value}>{children}</ClaudeRuntimeContext.Provider>
}

export function useClaudeRuntime(): ClaudeRuntimeContextValue {
  return useContext(ClaudeRuntimeContext)
}

export function claudeBridge(): typeof window.agentsDock.claude | null {
  return window.agentsDock?.claude ?? null
}

function isClaudeCapabilityAvailable(capability: unknown): boolean {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return false
  const value = capability as {
    available?: unknown
    interactive_capability?: unknown
    interactive_client_capability?: unknown
  }
  return value.available === true
    && (value.interactive_client_capability ?? value.interactive_capability) === 'claude_sdk_interactive_v1'
}

function isClaudeControlEvent(type: string): boolean {
  return type.startsWith('claude_')
    || type === 'turn_started'
    || type === 'turn_finished'
    || type === 'turn_stopped'
    || type === 'error'
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

async function boundedClaudeRefresh<T>(request: Promise<T>, timeoutMessage: string): Promise<T> {
  let timeoutId: number | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(timeoutMessage)), CLAUDE_RUNTIME_REFRESH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  }
}

function numberField(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' ? candidate : 0
}

function booleanField(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>)[key] === true
}

function claudeUsageGeneration(snapshot: ClaudeRuntimeSnapshot): number | null {
  const direct = snapshot.usage_generation
  if (isUsageGeneration(direct)) return direct
  const usage = snapshot.context_usage_snapshot ?? snapshot.context_usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const nested = usage.usage_generation
  return isUsageGeneration(nested) ? nested : null
}

function isUsageGeneration(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
}
