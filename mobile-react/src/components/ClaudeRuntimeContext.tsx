import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AppState as NativeAppState } from 'react-native'
import {
  claudeControlsCapability,
  latestClaudeControlEventSeq,
} from '../lib/claude-controls'
import { subscribeProviderRuntimeChanged } from '../lib/provider-runtime-events'
import { client, useAppStore } from '../store/useAppStore'
import type { ClaudeRuntimeSnapshot, Session } from '../types'
import type { AgentServerClient } from '../api/AgentServerClient'

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
  run<T>(operation: (connection: AgentServerClient, sessionId: string) => Promise<T>): Promise<T>
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
  run: async () => { throw new Error('Claude controls are unavailable.') },
})

/**
 * Mirrors the Mac Claude SDK runtime contract while retaining the mobile
 * client's profile-generation fences. Claude runtime state is event driven;
 * avoiding a background poll here keeps an idle chat from consuming battery.
 */
export function ClaudeRuntimeProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const health = useAppStore(state => state.health)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const pendingCount = session?.claude_pending_interaction_count ?? 0
  const needsUserAction = session?.claude_needs_user_action === true
  const controlEventSeq = useAppStore(state => (
    latestClaudeControlEventSeq(state.snapshots[sessionId]?.events ?? [])
  ))
  const capability = claudeControlsCapability(health)
  const supported = Boolean(
    session?.backend === 'claude'
    && capability
    && connected
    && !connecting
    && !workspaceAdopting
    && switchingProfileId === null
    && client.isValidated,
  )
  const [runtime, setRuntime] = useState<ClaudeRuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const [contextUsageError, setContextUsageError] = useState<string | null>(null)
  const runtimeRef = useRef<ClaudeRuntimeSnapshot | null>(null)
  const requestEpoch = useRef(0)
  const contextUsageRefreshEpoch = useRef<number | null>(null)
  const refreshAfterContextUsage = useRef(false)
  const mutationCount = useRef(0)
  const scopeKey = `${activeProfileId ?? ''}:${profileGeneration}:${sessionId}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshCycle = useRef<{
    key: string
    dirty: boolean
    promise: Promise<ClaudeRuntimeSnapshot | null>
  } | null>(null)
  const refreshSignal = `${controlEventSeq}:${pendingCount}:${needsUserAction ? 1 : 0}`
  const previousRefreshSignal = useRef(refreshSignal)

  const performRefresh = useCallback(async (
    errorTarget: 'runtime' | 'contextUsage',
  ): Promise<ClaudeRuntimeSnapshot | null> => {
    if (!supported || !activeProfileId) {
      requestEpoch.current += 1
      runtimeRef.current = null
      setRuntime(null)
      setRuntimeError(null)
      setInteractionError(null)
      setContextUsageError(null)
      setLoading(false)
      setRefreshing(false)
      return null
    }
    if (mutationCount.current > 0) return runtimeRef.current
    const connection = client
    const expectedProfileId = activeProfileId
    const expectedGeneration = profileGeneration
    const expectedSessionId = sessionId
    const epoch = ++requestEpoch.current
    if (runtimeRef.current) setRefreshing(true)
    else setLoading(true)
    try {
      const next = await connection.claudeRuntime(expectedSessionId)
      if (epoch !== requestEpoch.current || !runtimeScopeIsCurrent(
        connection,
        expectedProfileId,
        expectedGeneration,
        expectedSessionId,
      )) return null
      runtimeRef.current = next
      setRuntime(next)
      if (errorTarget === 'contextUsage') setContextUsageError(null)
      else setRuntimeError(null)
      return next
    } catch (cause) {
      if (epoch === requestEpoch.current && runtimeScopeIsCurrent(
        connection,
        expectedProfileId,
        expectedGeneration,
        expectedSessionId,
      )) {
        if (errorTarget === 'contextUsage') setContextUsageError(errorMessage(cause))
        else setRuntimeError(errorMessage(cause))
      }
      return null
    } finally {
      if (epoch === requestEpoch.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [activeProfileId, profileGeneration, sessionId, supported])

  const refresh = useCallback((): Promise<ClaudeRuntimeSnapshot | null> => {
    if (contextUsageRefreshEpoch.current !== null) {
      refreshAfterContextUsage.current = true
      return Promise.resolve(runtimeRef.current)
    }
    if (!supported || !activeProfileId) {
      refreshCycle.current = null
      return performRefresh('runtime')
    }
    const key = `${activeProfileId}:${profileGeneration}:${sessionId}`
    const current = refreshCycle.current
    if (current?.key === key) {
      current.dirty = true
      return current.promise
    }
    const cycle = {
      key,
      dirty: false,
      promise: Promise.resolve<ClaudeRuntimeSnapshot | null>(null),
    }
    const operation = (async () => {
      let value = await performRefresh('runtime')
      while (
        cycle.dirty
        && refreshCycle.current === cycle
        && runtimeScopeIsCurrent(client, activeProfileId, profileGeneration, sessionId)
      ) {
        cycle.dirty = false
        value = await performRefresh('runtime')
      }
      return value
    })()
    cycle.promise = operation
    refreshCycle.current = cycle
    void operation.finally(() => {
      if (refreshCycle.current === cycle) refreshCycle.current = null
    })
    return operation
  }, [activeProfileId, performRefresh, profileGeneration, sessionId, supported])

  const refreshContextUsage = useCallback(async (): Promise<ClaudeRuntimeSnapshot | null> => {
    if (mutationCount.current > 0) return runtimeRef.current
    if (!supported || !activeProfileId) return null
    if (contextUsageRefreshEpoch.current !== null) return runtimeRef.current

    // Older servers expose only the observational runtime GET. Do not probe
    // the additive sampling route until the server advertises it.
    if (runtimeRef.current?.features?.context_usage_refresh !== true) {
      return performRefresh('contextUsage')
    }

    const connection = client
    const expectedProfileId = activeProfileId
    const expectedGeneration = profileGeneration
    const expectedSessionId = sessionId
    const expectedScopeKey = scopeKeyRef.current
    const epoch = ++requestEpoch.current
    refreshCycle.current = null
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
    setLoading(false)
    setRefreshing(true)
    setContextUsageError(null)
    refreshAfterContextUsage.current = false
    contextUsageRefreshEpoch.current = epoch
    try {
      const next = await connection.refreshClaudeContextUsage(expectedSessionId)
      if (
        epoch !== requestEpoch.current
        || scopeKeyRef.current !== expectedScopeKey
        || !runtimeScopeIsCurrent(
          connection,
          expectedProfileId,
          expectedGeneration,
          expectedSessionId,
        )
      ) return null
      runtimeRef.current = next
      setRuntime(next)
      setContextUsageError(null)
      return next
    } catch (cause) {
      if (
        epoch === requestEpoch.current
        && scopeKeyRef.current === expectedScopeKey
        && runtimeScopeIsCurrent(
          connection,
          expectedProfileId,
          expectedGeneration,
          expectedSessionId,
        )
      ) setContextUsageError(errorMessage(cause))
      return null
    } finally {
      if (contextUsageRefreshEpoch.current === epoch) {
        contextUsageRefreshEpoch.current = null
      }
      if (
        epoch === requestEpoch.current
        && scopeKeyRef.current === expectedScopeKey
        && runtimeScopeIsCurrent(
          connection,
          expectedProfileId,
          expectedGeneration,
          expectedSessionId,
        )
      ) {
        setRefreshing(false)
        if (refreshAfterContextUsage.current) {
          refreshAfterContextUsage.current = false
          void refresh()
        }
      } else {
        refreshAfterContextUsage.current = false
      }
    }
  }, [activeProfileId, performRefresh, profileGeneration, refresh, sessionId, supported])

  useEffect(() => {
    requestEpoch.current += 1
    runtimeRef.current = null
    mutationCount.current = 0
    setRuntime(null)
    setRuntimeError(null)
    setInteractionError(null)
    setContextUsageError(null)
    contextUsageRefreshEpoch.current = null
    refreshAfterContextUsage.current = false
    setMutating(false)
    setLoading(false)
    setRefreshing(false)
    previousRefreshSignal.current = refreshSignal
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
    if (supported) void refresh()
  }, [activeProfileId, profileGeneration, refresh, sessionId, supported])

  useEffect(() => {
    if (!supported) {
      previousRefreshSignal.current = refreshSignal
      return
    }
    if (previousRefreshSignal.current === refreshSignal) return
    previousRefreshSignal.current = refreshSignal
    if (contextUsageRefreshEpoch.current !== null) {
      refreshAfterContextUsage.current = true
      return
    }
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      if (contextUsageRefreshEpoch.current === null) void refresh()
    }, 60)
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [refresh, refreshSignal, supported])

  useEffect(() => {
    if (!supported || !activeProfileId) return
    return subscribeProviderRuntimeChanged(notification => {
      if (
        notification.connection !== client
        || notification.profileId !== activeProfileId
        || notification.profileGeneration !== profileGeneration
        || notification.event.session_id !== sessionId
        || notification.event.backend !== 'claude'
        || notification.event.runtime !== 'context_usage'
      ) return
      // A completing mutation always performs its own authoritative refresh.
      if (mutationCount.current > 0) return
      if (contextUsageRefreshEpoch.current !== null) {
        refreshAfterContextUsage.current = true
        return
      }
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        if (contextUsageRefreshEpoch.current === null) void refresh()
      }, 60)
    })
  }, [activeProfileId, profileGeneration, refresh, sessionId, supported])

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => {
      if (state === 'active' && supported) void refresh()
    })
    return () => subscription.remove()
  }, [refresh, supported])

  useEffect(() => () => {
    requestEpoch.current += 1
    scopeKeyRef.current = ''
    mutationCount.current = 0
    contextUsageRefreshEpoch.current = null
    refreshAfterContextUsage.current = false
    refreshCycle.current = null
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
  }, [])

  const run = useCallback(async <T,>(
    operation: (connection: AgentServerClient, targetSessionId: string) => Promise<T>,
  ): Promise<T> => {
    const connection = client
    const expectedProfileId = activeProfileId
    const expectedGeneration = profileGeneration
    const expectedSessionId = sessionId
    if (
      !supported
      || !expectedProfileId
      || !runtimeScopeIsCurrent(connection, expectedProfileId, expectedGeneration, expectedSessionId)
    ) throw new Error('Claude controls are no longer available for this chat.')
    const expectedScopeKey = scopeKeyRef.current
    requestEpoch.current += 1
    contextUsageRefreshEpoch.current = null
    refreshAfterContextUsage.current = false
    mutationCount.current += 1
    setInteractionError(null)
    setMutating(true)
    setRefreshing(true)
    try {
      return await operation(connection, expectedSessionId)
    } catch (cause) {
      if (
        scopeKeyRef.current === expectedScopeKey
        && runtimeScopeIsCurrent(connection, expectedProfileId, expectedGeneration, expectedSessionId)
      ) setInteractionError(errorMessage(cause))
      throw cause
    } finally {
      mutationCount.current = Math.max(0, mutationCount.current - 1)
      if (
        scopeKeyRef.current === expectedScopeKey
        && runtimeScopeIsCurrent(connection, expectedProfileId, expectedGeneration, expectedSessionId)
      ) {
        setMutating(mutationCount.current > 0)
        setRefreshing(mutationCount.current > 0)
        if (mutationCount.current === 0) void refresh()
      }
    }
  }, [activeProfileId, profileGeneration, refresh, sessionId, supported])

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
    run,
  }), [contextUsageError, interactionError, loading, mutating, refresh, refreshContextUsage, refreshing, run, runtime, runtimeError, session, supported])

  return <ClaudeRuntimeContext.Provider value={value}>{children}</ClaudeRuntimeContext.Provider>
}

export function useClaudeRuntime(): ClaudeRuntimeContextValue {
  return useContext(ClaudeRuntimeContext)
}

function runtimeScopeIsCurrent(
  connection: AgentServerClient,
  profileId: string,
  generation: number,
  sessionId: string,
): boolean {
  const state = useAppStore.getState()
  return client === connection
    && !connection.isDisposed
    && connection.isValidated
    && state.activeProfileId === profileId
    && state.profileGeneration === generation
    && state.switchingProfileId === null
    && state.selectedSessionId === sessionId
    && state.connected
    && !state.connecting
    && !state.workspaceAdopting
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
