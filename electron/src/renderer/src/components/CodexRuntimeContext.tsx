// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from '@shared/provider-origin'
import { useLocale } from '../lib/i18n'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react'
import type {
  CodexBackgroundTerminal,
  CodexGoalSnapshot,
  CodexGoalStatus,
  CodexPendingInteraction,
  CodexPermissionProfile,
  CodexRuntimeSnapshot,
  Session
} from '@shared/types'
import {
  CODEX_GOALS_CONFIGURATION_CHANGED_EVENT,
  type CodexGoalsConfigurationChangedDetail
} from '../lib/codex-goals'
import { useAppStore } from '../store/app-store'

export type CodexInteraction = CodexPendingInteraction
export type { CodexBackgroundTerminal, CodexGoalStatus, CodexPermissionProfile, CodexRuntimeSnapshot }

interface CodexRuntimeContextValue {
  supported: boolean
  loading: boolean
  refreshing: boolean
  mutating: boolean
  error: string | null
  runtime: CodexRuntimeSnapshot | null
  session: Session | null
  refresh(): Promise<CodexRuntimeSnapshot | null>
  run<T>(operation: () => Promise<T>): Promise<T>
  applyGoalSnapshot(snapshot: CodexGoalSnapshot): void
}

const CodexRuntimeContext = createContext<CodexRuntimeContextValue>({
  supported: false,
  loading: false,
  refreshing: false,
  mutating: false,
  error: null,
  runtime: null,
  session: null,
  refresh: async () => null,
  run: async operation => operation(),
  applyGoalSnapshot: () => undefined
})

const SELECTED_THREAD_LOAD_SETTLE_MS = 120
const ACTIVE_RUNTIME_POLL_MS = 2_000

interface CodexRuntimeProviderProps {
  session: Session | null
  capability?: unknown
  focused?: boolean
  children: ReactNode
}

export function CodexRuntimeProvider({ session, capability, focused = true, children }: CodexRuntimeProviderProps) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const [runtime, setRuntime] = useState<CodexRuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestEpoch = useRef(0)
  const refreshCount = useRef(0)
  const refreshQueued = useRef<number | null>(null)
  const runtimeRef = useRef<CodexRuntimeSnapshot | null>(null)
  const loadThreadInFlight = useRef<{
    sessionId: string
    promise: Promise<CodexRuntimeSnapshot>
  } | null>(null)
  const mutationCount = useRef(0)
  const connectedRef = useRef(connected)
  const previouslyFocusedRef = useRef(focused)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const sessionIdRef = useRef(session?.id)
  sessionIdRef.current = session?.id
  const bridgeAvailable = Boolean(codexBridge())
  const capabilityAvailable = isCapabilityAvailable(capability)
  const supported = Boolean(session?.backend === 'codex' && bridgeAvailable && capabilityAvailable)

  useEffect(() => () => {
    // App keys this provider by the selected chat, so switching chats unmounts
    // the old instance instead of updating its session prop. Invalidate any
    // pending settle window before it can resume a thread the user already left.
    requestEpoch.current += 1
    sessionIdRef.current = undefined
    loadThreadInFlight.current = null
  }, [])

  const refresh = useCallback(async () => {
    const sessionId = session?.id
    const bridge = codexBridge()
    if (mutationCount.current > 0) return runtimeRef.current
    if (!supported || !sessionId || !bridge || sessionIdRef.current !== sessionId) {
      setRuntime(null)
      setError(null)
      setLoading(false)
      setRefreshing(false)
      return null
    }
    const epoch = ++requestEpoch.current
    refreshCount.current += 1
    setRefreshing(current => {
      if (!runtimeRef.current) setLoading(true)
      return Boolean(runtimeRef.current) || current
    })
    try {
      const observed = await bridge.runtime(sessionId)
      if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
      let next = observed
      if (focusedRef.current && shouldLoadPersistedThread(session, observed)) {
        try {
          // A short selection settle window prevents fast chat-list browsing
          // from launching expensive, uncancellable app-server resumes for
          // chats the user has already left.
          await new Promise(resolve => window.setTimeout(resolve, SELECTED_THREAD_LOAD_SETTLE_MS))
          if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
          if (focusedRef.current) {
            next = await loadPersistedThread(bridge, sessionId, loadThreadInFlight)
          }
        } catch (cause) {
          // Preserve the authoritative unloaded snapshot when resume fails so
          // the UI never continues to advertise a stale pre-restart state.
          runtimeRef.current = observed
          setRuntime(observed)
          throw cause
        }
      }
      if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
      runtimeRef.current = next
      setRuntime(next)
      setError(null)
      return next
    } catch (cause) {
      if (epoch !== requestEpoch.current || sessionIdRef.current !== sessionId) return null
      setError(errorMessage(cause))
      return null
    } finally {
      refreshCount.current = Math.max(0, refreshCount.current - 1)
      if (epoch === requestEpoch.current && sessionIdRef.current === sessionId) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [session?.codex_thread_id, session?.id, session?.session_id, supported])

  useEffect(() => {
    requestEpoch.current += 1
    runtimeRef.current = null
    loadThreadInFlight.current = null
    mutationCount.current = 0
    setRuntime(null)
    setError(null)
    setMutating(false)
    setLoading(false)
    setRefreshing(false)
    if (supported) void refresh()
  }, [activeProfileId, capabilityAvailable, profileGeneration, refresh, session?.id, supported])

  useEffect(() => {
    const becameFocused = focused && !previouslyFocusedRef.current
    previouslyFocusedRef.current = focused
    if (becameFocused && supported) void refresh()
  }, [focused, refresh, supported])

  useEffect(() => {
    const reconnected = connected && !connectedRef.current
    connectedRef.current = connected
    if (reconnected && supported) void refresh()
  }, [connected, refresh, supported])

  useEffect(() => {
    if (!supported) return
    const onGoalsConfigurationChanged = (event: Event) => {
      const detail = (event as CustomEvent<CodexGoalsConfigurationChangedDetail>).detail
      if (
        !detail
        || detail.profileId !== activeProfileId
        || detail.profileGeneration !== profileGeneration
      ) return

      // The setting response is authoritative. Apply it immediately so a
      // disabled server never leaves stale goal mutation buttons clickable
      // while the selected thread snapshot is being reloaded.
      setRuntime(current => {
        if (!current) return current
        const next = { ...current, goals_enabled: detail.enabled }
        runtimeRef.current = next
        return next
      })
      void refresh()
    }
    window.addEventListener(CODEX_GOALS_CONFIGURATION_CHANGED_EVENT, onGoalsConfigurationChanged)
    return () => window.removeEventListener(CODEX_GOALS_CONFIGURATION_CHANGED_EVENT, onGoalsConfigurationChanged)
  }, [activeProfileId, profileGeneration, refresh, supported])

  useEffect(() => {
    if (!supported || !session?.id) return
    const queueRefresh = () => {
      if (mutationCount.current > 0) return
      if (refreshQueued.current !== null) return
      refreshQueued.current = window.setTimeout(() => {
        refreshQueued.current = null
        if (mutationCount.current > 0) return
        void refresh()
      }, 60)
    }
    const unsubscribeEvent = window.agentsDock.events.on('server:event', payload => {
      if (
        payload.profileId !== activeProfileId
        || payload.profileGeneration !== profileGeneration
        || payload.event.session_id !== session.id
        || isImportedProviderControlMetadata(payload.event)
        || isImportedHistoryRecord(payload.event)
        || !isCodexControlEvent(payload.event.type)
      ) return
      queueRefresh()
    })
    const unsubscribeProviderRuntime = window.agentsDock.events.on('server:provider-runtime', payload => {
      if (
        payload.profileId !== activeProfileId
        || payload.profileGeneration !== profileGeneration
        || payload.event.session_id !== session.id
        || payload.event.backend !== 'codex'
        || payload.event.runtime !== 'context_usage'
      ) return
      queueRefresh()
    })
    const unsubscribeSessions = window.agentsDock.events.on('server:sessions', payload => {
      if (payload.profileId !== activeProfileId || payload.profileGeneration !== profileGeneration) return
      const updated = payload.sessions.find(candidate => candidate.id === session.id)
      if (!updated) return
      const previousCount = numberField(session, 'codex_pending_interaction_count')
      const nextCount = numberField(updated, 'codex_pending_interaction_count')
      if (previousCount !== nextCount || booleanField(session, 'codex_needs_user_action') !== booleanField(updated, 'codex_needs_user_action')) {
        queueRefresh()
      }
    })
    return () => {
      unsubscribeEvent()
      unsubscribeProviderRuntime()
      unsubscribeSessions()
      if (refreshQueued.current !== null) window.clearTimeout(refreshQueued.current)
      refreshQueued.current = null
    }
  }, [activeProfileId, profileGeneration, refresh, session, supported])

  useEffect(() => {
    const sessionId = session?.id
    const bridge = codexBridge()
    if (
      !supported
      || !connected
      || !sessionId
      || !bridge
      || runtime?.status?.type !== 'active'
    ) return

    let cancelled = false
    let timer: number | null = null
    let polling = false

    const schedule = () => {
      if (cancelled || timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        void poll()
      }, ACTIVE_RUNTIME_POLL_MS)
    }
    const poll = async () => {
      if (cancelled || polling) return
      if (
        document.visibilityState !== 'visible'
        || mutationCount.current > 0
        || refreshCount.current > 0
      ) {
        schedule()
        return
      }
      const epoch = requestEpoch.current
      polling = true
      try {
        const next = await bridge.runtime(sessionId)
        if (
          cancelled
          || sessionIdRef.current !== sessionId
          || requestEpoch.current !== epoch
          || mutationCount.current > 0
          || refreshCount.current > 0
        ) return
        runtimeRef.current = next
        setRuntime(next)
      } catch {
        // The normal event/reconnect path owns user-visible errors. Telemetry
        // polling is deliberately quiet and will retry while the turn is live.
      } finally {
        polling = false
        schedule()
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      void poll()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [connected, runtime?.status?.type, session?.id, supported])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const sessionId = session?.id
    const inFlightThreadLoad = loadThreadInFlight.current
    const pendingThreadLoad = inFlightThreadLoad && inFlightThreadLoad.sessionId === sessionId
      ? inFlightThreadLoad.promise
      : null
    requestEpoch.current += 1
    if (refreshQueued.current !== null) {
      window.clearTimeout(refreshQueued.current)
      refreshQueued.current = null
    }
    setLoading(false)
    setRefreshing(false)
    setError(null)
    mutationCount.current += 1
    setMutating(true)
    let succeeded = false
    try {
      // A passive thread/resume owns the server's per-session lifecycle lock.
      // Wait for the already-started resume before sending a mutation so its
      // shorter HTTP timeout cannot expire in the lock queue and apply later
      // as a ghost write. A mutation that arrives during the settle window
      // invalidates that refresh before it starts, so only an actual in-flight
      // provider load is awaited here.
      if (pendingThreadLoad) {
        await pendingThreadLoad
        if (sessionIdRef.current !== sessionId) {
          throw new Error('The selected Codex chat changed while its thread was loading.')
        }
      }
      const result = await operation()
      succeeded = true
      return result
    } catch (cause) {
      if (sessionIdRef.current === sessionId) setError(errorMessage(cause))
      throw cause
    } finally {
      if (sessionIdRef.current === sessionId) {
        mutationCount.current = Math.max(0, mutationCount.current - 1)
        setMutating(mutationCount.current > 0)
        if (succeeded) void refresh()
      }
    }
  }, [refresh, session?.id])

  const applyGoalSnapshot = useCallback((snapshot: CodexGoalSnapshot) => {
    const sessionId = session?.id
    if (sessionIdRef.current !== sessionId) return
    requestEpoch.current += 1
    setRuntime(current => {
      if (sessionIdRef.current !== sessionId) return current
      if (!current) return current
      const next = {
        ...current,
        goal: snapshot.goal,
        time_budget_seconds: snapshot.time_budget_seconds,
        time_budget_exhausted: snapshot.time_budget_exhausted ?? false
      }
      runtimeRef.current = next
      return next
    })
  }, [session?.id])

  const value = useMemo<CodexRuntimeContextValue>(() => ({
    supported,
    loading,
    refreshing,
    mutating,
    error,
    runtime,
    session,
    refresh,
    run,
    applyGoalSnapshot
  }), [applyGoalSnapshot, error, loading, mutating, refresh, refreshing, run, runtime, session, supported])

  return <CodexRuntimeContext.Provider value={value}>{children}</CodexRuntimeContext.Provider>
}

export function useCodexRuntime(): CodexRuntimeContextValue {
  return useContext(CodexRuntimeContext)
}

export function codexStatusLabel(status: CodexRuntimeSnapshot['status'] | undefined): string {
  const value = status?.type || 'idle'
  const flags = status?.type === 'active' ? status.activeFlags : []
  if (flags.includes('waitingOnApproval')) return t("ui.CodexRuntimeContext.codexStatusLabel.approval_needed_9928dd8")
  if (flags.includes('waitingOnUserInput')) return t("ui.CodexRuntimeContext.codexStatusLabel.answer_needed_1a6227e")
  if (value === 'active') return t("ui.CodexRuntimeContext.codexStatusLabel.running_f4ccae2")
  if (value === 'systemError') return 'Runtime error'
  if (value === 'notLoaded') return 'Not loaded'
  return value === 'idle' ? t("ui.CodexRuntimeContext.codexStatusLabel.idle_ab0171c") : sentenceCase(value)
}

export function codexStatusTone(runtime: CodexRuntimeSnapshot | null): 'idle' | 'active' | 'waiting' | 'error' {
  if ((runtime?.pending_interactions?.length ?? 0) > 0) return 'waiting'
  const status = runtime?.status
  const value = status?.type || 'idle'
  const flags = status?.type === 'active' ? status.activeFlags : []
  if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return 'waiting'
  if (value === 'systemError') return 'error'
  if (value === 'active') return 'active'
  return 'idle'
}

export function codexBridge(): typeof window.agentsDock.codex | null {
  return window.agentsDock?.codex ?? null
}

function isCapabilityAvailable(capability: unknown): boolean {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return false
  return (capability as { available?: unknown }).available === true
}

function isCodexControlEvent(type: string): boolean {
  return type.startsWith('codex_')
    || type === 'context_compaction'
    || type.startsWith('review_')
    || type === 'turn_started'
    || type === 'turn_finished'
    || type === 'turn_stopped'
    || type === 'error'
}

function shouldLoadPersistedThread(
  session: Session | null,
  runtime: CodexRuntimeSnapshot
): boolean {
  const persistedThread = runtime.persisted_thread === true
    || (runtime.persisted_thread == null && Boolean(session?.codex_thread_id || session?.session_id))
  return runtime.available !== false
    && runtime.thread_loaded === false
    && runtime.status?.type === 'notLoaded'
    && persistedThread
}

async function loadPersistedThread(
  bridge: NonNullable<ReturnType<typeof codexBridge>>,
  sessionId: string,
  inFlight: MutableRefObject<{
    sessionId: string
    promise: Promise<CodexRuntimeSnapshot>
  } | null>
): Promise<CodexRuntimeSnapshot> {
  if (inFlight.current?.sessionId === sessionId) return inFlight.current.promise
  const promise = bridge.loadThread(sessionId)
  inFlight.current = { sessionId, promise }
  try {
    return await promise
  } finally {
    if (inFlight.current?.promise === promise) inFlight.current = null
  }
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function sentenceCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, match => match.toUpperCase())
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
