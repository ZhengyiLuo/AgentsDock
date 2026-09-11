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
  codexControlsCapability,
  codexStatusLabel,
  codexStatusTone,
  latestCodexControlEventSeq,
  remainingAutoResolveSeconds,
} from '../lib/codex-controls'
import { client, useAppStore } from '../store/useAppStore'
import { mergeGoalSnapshot } from '../lib/codex-goals'
import { subscribeCodexGoalsConfiguration } from '../lib/codex-goals-configuration'
import type { CodexGoal, CodexGoalInput, CodexGoalSnapshot, CodexRuntimeSnapshot, Session } from '../types'
import type { AgentServerClient } from '../api/AgentServerClient'

export {
  codexStatusLabel,
  codexStatusTone,
  remainingAutoResolveSeconds,
} from '../lib/codex-controls'

interface CodexRuntimeContextValue {
  supported: boolean
  goalsSupported: boolean
  goalsEnabled: boolean
  scopeKey: string
  loading: boolean
  refreshing: boolean
  mutating: boolean
  error: string | null
  runtime: CodexRuntimeSnapshot | null
  session: Session | null
  refresh(): Promise<CodexRuntimeSnapshot | null>
  run<T>(operation: () => Promise<T>): Promise<T>
  updateGoal(input: CodexGoalInput): Promise<CodexGoalSnapshot | null>
  clearGoal(expectedGoal?: Pick<CodexGoal, 'threadId' | 'objective' | 'createdAt'>): Promise<CodexGoalSnapshot | null>
}

const CodexRuntimeContext = createContext<CodexRuntimeContextValue>({
  supported: false,
  goalsSupported: false,
  goalsEnabled: false,
  scopeKey: '',
  loading: false,
  refreshing: false,
  mutating: false,
  error: null,
  runtime: null,
  session: null,
  refresh: async () => null,
  run: operation => operation(),
  updateGoal: async () => null,
  clearGoal: async () => null,
})

// Runtime events still trigger immediate refreshes. While a turn is actively
// generating, sample slowly enough for useful context/status feedback without
// importing the desktop client's battery-heavy polling cadence to iOS.
const ACTIVE_RUNTIME_POLL_MS = 5_000

export function CodexRuntimeProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const health = useAppStore(state => state.health)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const lifecycleActive = useAppStore(state => state.activeSessionIds.has(sessionId))
  const pendingCount = session?.codex_pending_interaction_count ?? 0
  const controlEventSeq = useAppStore(state => (
    latestCodexControlEventSeq(state.snapshots[sessionId]?.events ?? [])
  ))
  const capability = codexControlsCapability(health)
  const supported = Boolean(
    session?.backend === 'codex'
    && capability
    && connected
    && !connecting
    && !switchingProfileId
    && !workspaceAdopting
    && client.isValidated,
  )
  const [runtime, setRuntime] = useState<CodexRuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [appActive, setAppActive] = useState(NativeAppState.currentState === 'active')
  const runtimeRef = useRef<CodexRuntimeSnapshot | null>(null)
  const requestEpoch = useRef(0)
  const refreshCount = useRef(0)
  const mutationCount = useRef(0)
  const mutationEpoch = useRef(0)
  const goalOperationInFlight = useRef<Promise<CodexGoalSnapshot | null> | null>(null)
  const scopeKey = `${activeProfileId ?? ''}:${profileGeneration}:${sessionId}`
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const goalsSupported = supported && capability?.features?.goals !== false
  const goalsEnabled = goalsSupported && runtime?.goals_enabled !== false
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshCycle = useRef<{
    key: string
    dirty: boolean
    promise: Promise<CodexRuntimeSnapshot | null>
  } | null>(null)
  const refreshSignal = `${controlEventSeq}:${pendingCount}`
  const previousRefreshSignal = useRef(refreshSignal)
  const waitingForUser = runtime?.status?.type === 'active' && (
    runtime.status.activeFlags.includes('waitingOnApproval')
    || runtime.status.activeFlags.includes('waitingOnUserInput')
  )

  const performRefresh = useCallback(async (): Promise<CodexRuntimeSnapshot | null> => {
    if (!supported || !activeProfileId) {
      requestEpoch.current += 1
      runtimeRef.current = null
      setRuntime(null)
      setRefreshError(null)
      setOperationError(null)
      setLoading(false)
      setRefreshing(false)
      setMutating(false)
      return null
    }
    if (mutationCount.current > 0) return runtimeRef.current
    const connection = client
    const expectedProfileId = activeProfileId
    const expectedGeneration = profileGeneration
    const expectedSessionId = sessionId
    const epoch = ++requestEpoch.current
    refreshCount.current += 1
    if (runtimeRef.current) setRefreshing(true)
    else setLoading(true)
    try {
      const next = await connection.codexRuntime(expectedSessionId)
      if (epoch !== requestEpoch.current || !runtimeScopeIsCurrent(
        connection,
        expectedProfileId,
        expectedGeneration,
        expectedSessionId,
      )) return null
      runtimeRef.current = next
      setRuntime(next)
      setRefreshError(null)
      return next
    } catch (cause) {
      if (epoch === requestEpoch.current && runtimeScopeIsCurrent(
        connection,
        expectedProfileId,
        expectedGeneration,
        expectedSessionId,
      )) setRefreshError(errorMessage(cause))
      return null
    } finally {
      refreshCount.current = Math.max(0, refreshCount.current - 1)
      if (epoch === requestEpoch.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [activeProfileId, profileGeneration, sessionId, supported])

  const refresh = useCallback((): Promise<CodexRuntimeSnapshot | null> => {
    if (!supported || !activeProfileId) {
      refreshCycle.current = null
      return performRefresh()
    }
    const key = `${activeProfileId}:${profileGeneration}:${sessionId}`
    const current = refreshCycle.current
    if (current?.key === key) {
      // A control event can arrive while the operation's finally block is
      // already refreshing. Share the active request and retain one trailing
      // refresh so the final pending-interaction/status state is not lost.
      current.dirty = true
      return current.promise
    }
    const cycle = {
      key,
      dirty: false,
      promise: Promise.resolve<CodexRuntimeSnapshot | null>(null),
    }
    const operation = (async () => {
      let value = await performRefresh()
      while (
        cycle.dirty
        && refreshCycle.current === cycle
        && runtimeScopeIsCurrent(client, activeProfileId, profileGeneration, sessionId)
      ) {
        cycle.dirty = false
        value = await performRefresh()
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

  useEffect(() => {
    requestEpoch.current += 1
    runtimeRef.current = null
    mutationCount.current = 0
    mutationEpoch.current += 1
    goalOperationInFlight.current = null
    setMutating(false)
    setRuntime(null)
    setRefreshError(null)
    setOperationError(null)
    previousRefreshSignal.current = refreshSignal
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
    if (supported) void refresh()
  }, [activeProfileId, profileGeneration, refresh, sessionId, supported])

  useEffect(() => subscribeCodexGoalsConfiguration(detail => {
    if (!activeProfileId || detail.profileId !== activeProfileId || detail.profileGeneration !== profileGeneration) return
    if (!runtimeScopeIsCurrent(client, activeProfileId, profileGeneration, sessionId)) return
    // Invalidate an older observation before publishing the confirmed setting.
    requestEpoch.current += 1
    if (runtimeRef.current) {
      const next = { ...runtimeRef.current, goals_enabled: detail.enabled }
      runtimeRef.current = next
      setRuntime(next)
    }
    void refresh()
  }), [activeProfileId, profileGeneration, refresh, sessionId])

  useEffect(() => {
    if (!supported) {
      previousRefreshSignal.current = refreshSignal
      return
    }
    if (previousRefreshSignal.current === refreshSignal) return
    previousRefreshSignal.current = refreshSignal
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      void refresh()
    }, 60)
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [refresh, refreshSignal, supported])

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => {
      const active = state === 'active'
      setAppActive(active)
      if (active && supported) void refresh()
    })
    return () => subscription.remove()
  }, [refresh, supported])

  useEffect(() => {
    if (
      !supported
      || !activeProfileId
      || !appActive
      || (runtime?.status?.type !== 'active' && !lifecycleActive)
      || waitingForUser
    ) return
    const connection = client
    const expectedProfileId = activeProfileId
    const expectedGeneration = profileGeneration
    const expectedSessionId = sessionId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let polling = false

    const schedule = () => {
      if (cancelled || timer) return
      timer = setTimeout(() => {
        timer = null
        void poll()
      }, ACTIVE_RUNTIME_POLL_MS)
    }
    const poll = async () => {
      if (cancelled || polling) return
      if (
        NativeAppState.currentState !== 'active'
        || mutationCount.current > 0
        || refreshCount.current > 0
      ) {
        schedule()
        return
      }
      const epoch = requestEpoch.current
      polling = true
      try {
        const next = await connection.codexRuntime(expectedSessionId)
        if (
          cancelled
          || requestEpoch.current !== epoch
          || mutationCount.current > 0
          || refreshCount.current > 0
          || !runtimeScopeIsCurrent(
            connection,
            expectedProfileId,
            expectedGeneration,
            expectedSessionId,
          )
        ) return
        runtimeRef.current = next
        setRuntime(next)
      } catch {
        // Event and reconnect refreshes own visible errors. This telemetry
        // sample is quiet and exists only while the selected turn is active.
      } finally {
        polling = false
        schedule()
      }
    }

    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeProfileId, appActive, lifecycleActive, profileGeneration, runtime?.status?.type, sessionId, supported, waitingForUser])

  useEffect(() => () => {
    requestEpoch.current += 1
    scopeKeyRef.current = ''
    mutationCount.current = 0
    mutationEpoch.current += 1
    refreshCycle.current = null
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
  }, [])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const expectedScopeKey = scopeKeyRef.current
    const expectedMutationEpoch = mutationEpoch.current
    if (!activeProfileId || expectedScopeKey !== scopeKey || !runtimeScopeIsCurrent(client, activeProfileId, profileGeneration, sessionId)) {
      throw new Error('The selected server or Codex chat changed. Reopen its controls and try again.')
    }
    requestEpoch.current += 1
    mutationCount.current += 1
    setOperationError(null)
    setMutating(true)
    setRefreshing(true)
    try {
      return await operation()
    } catch (cause) {
      if (scopeKeyRef.current === expectedScopeKey && mutationEpoch.current === expectedMutationEpoch) setOperationError(errorMessage(cause))
      throw cause
    } finally {
      if (scopeKeyRef.current === expectedScopeKey && mutationEpoch.current === expectedMutationEpoch) {
        mutationCount.current = Math.max(0, mutationCount.current - 1)
        setMutating(mutationCount.current > 0)
        setRefreshing(mutationCount.current > 0)
        if (mutationCount.current === 0) void refresh()
      }
    }
  }, [activeProfileId, profileGeneration, refresh, scopeKey, sessionId])

  const performGoalOperation = useCallback((input: CodexGoalInput | null, expectedGoal?: Pick<CodexGoal, 'threadId' | 'objective' | 'createdAt'>): Promise<CodexGoalSnapshot | null> => {
    // A ref closes the gap before React renders disabled buttons, including
    // taps arriving from both the composer card and the editor sheet.
    if (goalOperationInFlight.current || mutationCount.current > 0) return Promise.resolve(null)
    const connection = client
    const expectedScopeKey = scopeKey
    const expectedMutationEpoch = mutationEpoch.current
    const operation = run(async () => {
      const state = useAppStore.getState()
      const feature = codexControlsCapability(state.health)?.features?.goals
      if (!activeProfileId || scopeKeyRef.current !== expectedScopeKey || !runtimeScopeIsCurrent(connection, activeProfileId, profileGeneration, sessionId)) {
        throw new Error('The selected server or Codex chat changed. Reopen its goal and try again.')
      }
      if (!goalsSupported || feature === false || state.sessions.find(candidate => candidate.id === sessionId)?.backend !== 'codex' || !runtimeRef.current || runtimeRef.current.available === false) {
        throw new Error('Persistent goals are unavailable for this Codex chat.')
      }
      if (runtimeRef.current.goals_enabled === false) {
        throw new Error('Persistent goals are disabled on this server. Enable them in Settings first.')
      }
      const currentGoal = runtimeRef.current.goal
      if (expectedGoal && (!currentGoal || currentGoal.threadId !== expectedGoal.threadId || currentGoal.objective !== expectedGoal.objective || currentGoal.createdAt !== expectedGoal.createdAt)) {
        throw new Error('The goal changed. Review it before clearing.')
      }
      const snapshot = input === null
        ? await connection.clearCodexGoal(sessionId)
        : await connection.setCodexGoal(sessionId, input)
      if (scopeKeyRef.current !== expectedScopeKey || mutationEpoch.current !== expectedMutationEpoch || !runtimeScopeIsCurrent(connection, activeProfileId, profileGeneration, sessionId)) return null
      // A request started before this mutation must never restore the old goal.
      requestEpoch.current += 1
      const next = mergeGoalSnapshot(runtimeRef.current, snapshot)
      runtimeRef.current = next
      setRuntime(next)
      return snapshot
    }).catch(cause => {
      // A prior connection's failure is no longer an error for this card or
      // editor. Suppress it for callers just as we discard its late snapshot.
      if (mutationEpoch.current !== expectedMutationEpoch) return null
      throw cause
    })
    goalOperationInFlight.current = operation
    void operation.finally(() => {
      if (goalOperationInFlight.current === operation) goalOperationInFlight.current = null
    }).catch(() => undefined)
    return operation
  }, [activeProfileId, goalsSupported, profileGeneration, run, scopeKey, sessionId])

  const updateGoal = useCallback((input: CodexGoalInput) => performGoalOperation(input), [performGoalOperation])
  const clearGoal = useCallback((expectedGoal?: Pick<CodexGoal, 'threadId' | 'objective' | 'createdAt'>) => performGoalOperation(null, expectedGoal), [performGoalOperation])

  const value = useMemo<CodexRuntimeContextValue>(() => ({
    supported,
    goalsSupported,
    goalsEnabled,
    scopeKey,
    loading,
    refreshing,
    mutating,
    error: operationError ?? refreshError,
    runtime,
    session,
    refresh,
    run,
    updateGoal,
    clearGoal,
  }), [clearGoal, goalsEnabled, goalsSupported, loading, mutating, operationError, refresh, refreshError, refreshing, run, runtime, scopeKey, session, supported, updateGoal])
  return <CodexRuntimeContext.Provider value={value}>{children}</CodexRuntimeContext.Provider>
}

export function useCodexRuntime(): CodexRuntimeContextValue {
  return useContext(CodexRuntimeContext)
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
    && state.selectedSessionId === sessionId
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
