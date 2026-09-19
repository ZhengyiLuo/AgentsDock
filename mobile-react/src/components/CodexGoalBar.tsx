import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronDown, Goal, Pause, Pencil, Play, Trash2 } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { buildCodexGoalInput, formatGoalBudget, goalElapsedSeconds, goalStatusLabel, goalViewState } from '../lib/codex-goals'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { CodexGoal, CodexGoalSnapshot, CodexGoalStatus } from '../types'
import { Text, TextInput } from './AppText'
import { useCodexRuntime } from './CodexRuntimeContext'
import { SheetCloseButton } from './ui'

export function CodexGoalBar() {
  const colors = usePalette()
  const { supported, goalsSupported, goalsEnabled, runtime, session, mutating, error, scopeKey, refresh, updateGoal } = useCodexRuntime()
  const lifecycleActive = useAppStore(state => session ? state.activeSessionIds.has(session.id) : false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [statusAction, setStatusAction] = useState<{ status: 'active' | 'paused'; pending: boolean; error: string | null } | null>(null)
  const statusActionEpoch = useRef(0)
  const statusActionInFlight = useRef(false)
  const [clock, setClock] = useState(() => Date.now())
  const [observedAt, setObservedAt] = useState(() => Date.now())
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  const goal = runtime ? runtime.goal : session?.codex_goal ?? null
  const { confirmClear, clearError } = useConfirmedGoalClear(goal)
  const threadActive = lifecycleActive || runtime?.status?.type === 'active'
  const view = goalViewState(goal, runtime)
  const actionIdentity = JSON.stringify([scopeKey, supported, goalsSupported, goalsEnabled, runtime?.available,
    goal?.threadId, goal?.createdAt, goal?.objective, goal?.status])
  const currentActionIdentity = useRef<string | null>(null)

  useLayoutEffect(() => {
    currentActionIdentity.current = actionIdentity
    return () => { currentActionIdentity.current = null }
  }, [actionIdentity])

  useEffect(() => {
    setEditorOpen(false)
    setExpanded(false)
  }, [scopeKey])
  useLayoutEffect(() => {
    // Retire the old action before this goal becomes tappable. A passive reset
    // can erase the first Resume tap committed for a replacement goal.
    statusActionEpoch.current += 1
    statusActionInFlight.current = false
    setStatusAction(null)
    return () => { statusActionEpoch.current += 1 }
  }, [scopeKey, supported, goal?.threadId, goal?.createdAt, goal?.objective])
  useEffect(() => {
    setStatusAction(current => current?.error && goal?.status === current.status ? null : current)
  }, [goal?.status, statusAction])
  useEffect(() => {
    if (!supported) setEditorOpen(false)
  }, [supported])
  useEffect(() => {
    const now = Date.now()
    setObservedAt(now)
    setClock(now)
  }, [goal?.status, goal?.timeUsedSeconds, goal?.updatedAt, goalsEnabled, scopeKey, threadActive])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setAppActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  useEffect(() => {
    if (!appActive || !goalsEnabled || goal?.status !== 'active' || !threadActive) return
    const timer = setInterval(() => setClock(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [appActive, goal?.status, goalsEnabled, threadActive])
  if (!supported || !session || !goal || !view) return null
  const elapsed = goalElapsedSeconds(goal, { threadActive: goalsEnabled && threadActive, observedAt, now: clock })
  const accent = !goalsEnabled || goal.status === 'paused' || view.tone === 'warning' ? colors.orange : view.tone === 'success' ? colors.green : colors.blue
  const available = goalsSupported && goalsEnabled && runtime?.available === true
  const actionError = statusAction?.error && statusAction.status !== goal.status
    ? `Could not ${statusAction.status === 'active' ? 'resume' : 'pause'} goal: ${statusAction.error}`
    : null
  const pendingLabel = statusAction?.pending ? statusAction.status === 'active' ? 'Resuming goal…' : 'Pausing goal…' : null
  const goalError = actionError ?? clearError ?? error
  const displayedStatus = goal.status !== 'active' && lifecycleActive ? `${view.label} · Message running` : view.label
  const statusLabel = !goalsSupported ? `${displayedStatus} · Goals unavailable` : !goalsEnabled ? `${displayedStatus} · Goals disabled` : pendingLabel ?? displayedStatus
  const actionLabel = pendingLabel ?? (actionError ? `Retry ${view.canPause ? 'pause' : 'resume'} goal` : view.canPause ? 'Pause goal' : 'Resume goal')
  const toggle = async () => {
    if (currentActionIdentity.current !== actionIdentity) return
    if (!available || mutating || statusActionInFlight.current || !(view.canPause || view.canResume)) return
    const epoch = statusActionEpoch.current
    const status = view.canPause ? 'paused' : 'active'
    statusActionInFlight.current = true
    setStatusAction({ status, pending: true, error: null })
    try {
      await updateGoal({ status })
      if (statusActionEpoch.current === epoch) setStatusAction(null)
    } catch (cause) {
      if (statusActionEpoch.current === epoch) setStatusAction({ status, pending: false, error: errorMessage(cause) })
    } finally {
      if (statusActionEpoch.current === epoch) statusActionInFlight.current = false
    }
  }
  const closeEditor = () => { setEditorOpen(false); requestAnimationFrame(dismissAppKeyboard) }
  return <>
    <View testID="codex-goal-bar" accessibilityLabel="Persistent Codex goal" style={[styles.card, { backgroundColor: colors.surface, borderColor: accent }]}>
      <Pressable
        testID="codex-goal-details"
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Hide' : 'Show'} goal details. ${statusLabel}. ${goal.objective}`}
        accessibilityHint={!expanded && goalError ? 'Goal alert. Expand the details to read the full error and goal controls.' : undefined}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={styles.summary}
      >
        <Goal size={18} color={accent} />
        <View style={styles.grow}>
          <Text testID="codex-goal-state" style={[styles.status, { color: accent }]}>{statusLabel}</Text>
          <Text testID="codex-goal-objective" style={[styles.objective, { color: colors.text }]} numberOfLines={1} ellipsizeMode="tail">{goal.objective}</Text>
          {!expanded && goalError ? <Text testID="codex-goal-error" accessibilityRole="alert" numberOfLines={1} ellipsizeMode="tail" style={[styles.help, { color: colors.red }]}>{goalError}</Text> : null}
        </View>
        <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: expanded ? '0deg' : '-90deg' }] }} />
      </Pressable>
      {expanded ? <ScrollView testID="codex-goal-body" style={styles.details} contentContainerStyle={styles.detailContent} nestedScrollEnabled keyboardShouldPersistTaps="always">
        <Text testID="codex-goal-progress" style={[styles.progress, { color: colors.muted }]}>
          {formatGoalBudget(elapsed, runtime?.time_budget_seconds, true)} elapsed · {formatGoalBudget(goal.tokensUsed, goal.tokenBudget)} tokens
        </Text>
        {goalsSupported && goalsEnabled ? <View style={styles.actions}>
          {view.canPause || goal.status === 'paused' ? <GoalAction
            testID="codex-goal-toggle"
            label={pendingLabel ?? (actionError ? view.canPause ? 'Retry pause' : 'Retry resume' : view.canPause ? 'Pause' : 'Resume')}
            accessibilityLabel={actionLabel}
            icon={view.canPause ? Pause : Play}
            busy={statusAction?.pending}
            disabled={!available || mutating || statusAction?.pending || !(view.canPause || view.canResume)}
            onPress={() => void toggle()}
          /> : null}
          <GoalAction testID="codex-goal-edit" label="Edit" accessibilityLabel="Edit goal" icon={Pencil} disabled={!available || mutating} onPress={() => { setEditorOpen(true); void refresh(); requestAnimationFrame(dismissAppKeyboard) }} />
          <GoalAction testID="codex-goal-clear" label="Clear" accessibilityLabel="Clear goal" icon={Trash2} danger disabled={!available || mutating} onPress={() => confirmClear()} />
        </View> : null}
        {goalError ? <Text testID="codex-goal-error" accessibilityRole="alert" selectable style={[styles.help, { color: colors.red }]}>{goalError}</Text> : null}
        <Text testID="codex-goal-objective-full" selectable style={[styles.objective, { color: colors.text }]}>{goal.objective}</Text>
        <Text style={[styles.help, { color: colors.muted }]}>{!goalsSupported
          ? 'This server does not support persistent goal controls.'
          : !goalsEnabled
            ? 'Persistent goals are disabled server-wide. Enable them in Settings to edit or continue this goal.'
            : view.message}</Text>
      </ScrollView> : null}
    </View>
    {editorOpen ? <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={closeEditor}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
          <Goal size={21} color={colors.blue} />
          <Text style={[styles.title, styles.grow, { color: colors.text }]}>Persistent goal</Text>
          <SheetCloseButton testID="codex-goal-editor-close" label="Close goal editor" onPress={closeEditor} />
        </View>
        <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="always">
          <CodexGoalEditor key={scopeKey} />
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>
}

/** Shared by the direct composer editor and the full Codex controls sheet. */
export function CodexGoalEditor() {
  const colors = usePalette()
  const { runtime, session, goalsSupported, goalsEnabled, scopeKey, mutating, error, updateGoal } = useCodexRuntime()
  const goal = runtime ? runtime.goal : session?.codex_goal ?? null
  const [draft, setDraft] = useState(() => goalDraft(goal, runtime?.time_budget_seconds))
  const [statusOpen, setStatusOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = useRef(false)
  const revision = useRef(0)
  const saveInFlight = useRef(false)
  const draftScope = useRef(scopeKey)
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const { confirmClear, clearError } = useConfirmedGoalClear(goal)

  useEffect(() => {
    if (draftScope.current !== scopeKey) {
      draftScope.current = scopeKey
      dirty.current = false
      revision.current += 1
      saveInFlight.current = false
      setSaving(false)
      setSaveError(null)
      setFeedback(null)
    }
    // Goal polling changes token/time counters. Never replace an unsaved draft,
    // even if a different device edits the server goal while this sheet is open.
    if (!dirty.current) setDraft(goalDraft(goal, runtime?.time_budget_seconds))
  }, [goal?.objective, goal?.status, goal?.tokenBudget, runtime?.time_budget_seconds, scopeKey])
  useEffect(() => {
    currentScope.current = scopeKey
    return () => { currentScope.current = '' }
  }, [scopeKey])

  const edit = (patch: Partial<GoalDraft>) => {
    if (runtime?.available !== true) return
    dirty.current = true
    revision.current += 1
    setDraft(current => ({ ...current, ...patch }))
    setFeedback(null)
    setSaveError(null)
  }
  const applyFormSnapshot = (snapshot: CodexGoalSnapshot, submittedRevision: number) => {
    if (revision.current !== submittedRevision) return false
    dirty.current = false
    setDraft(goalDraft(snapshot.goal, snapshot.time_budget_seconds))
    return true
  }
  const save = async () => {
    if (saveInFlight.current || mutating || !goalsEnabled || runtime?.available !== true) return
    let input
    try { input = buildCodexGoalInput(draft) } catch (cause) { setSaveError(errorMessage(cause)); return }
    const submittedRevision = revision.current
    const expectedScope = scopeKey
    saveInFlight.current = true
    setSaving(true)
    setSaveError(null)
    setFeedback(null)
    try {
      const snapshot = await updateGoal(input)
      if (!snapshot || currentScope.current !== expectedScope) return
      setFeedback(applyFormSnapshot(snapshot, submittedRevision)
        ? 'Persistent goal saved.'
        : 'Goal saved. Your newer edits are still unsaved.')
    } catch (cause) {
      if (currentScope.current === expectedScope) setSaveError(errorMessage(cause))
    } finally {
      if (currentScope.current === expectedScope) {
        saveInFlight.current = false
        setSaving(false)
      }
    }
  }

  if (!goalsSupported || !goalsEnabled) return <Text testID="codex-goals-disabled" style={[styles.help, { color: colors.muted }]}>{!goalsSupported
    ? 'Persistent goals are unavailable on this server.'
    : 'Persistent goals are disabled on this server. Normal chats and scheduled jobs still run. Enable goals in Settings to create, edit, or continue a goal.'}</Text>
  const available = runtime?.available === true
  const view = goalViewState(goal, runtime)
  return <View testID="codex-goal-editor" style={styles.editor}>
    <Text style={[styles.fieldLabel, { color: colors.text }]}>Objective</Text>
    <TextInput testID="codex-goal-objective-input" accessibilityLabel="Goal objective" value={draft.objective} onChangeText={objective => edit({ objective })} editable={available} multiline maxLength={4_000} placeholder="What should Codex keep working toward?" placeholderTextColor={colors.muted} style={[styles.textarea, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} />
    <Text style={[styles.fieldLabel, { color: colors.text }]}>Status</Text>
    <Pressable testID="codex-goal-status" accessibilityRole="button" accessibilityLabel={`Goal status: ${goalStatusLabel(draft.status)}`} accessibilityState={{ expanded: statusOpen, disabled: !available }} disabled={!available} onPress={() => setStatusOpen(value => !value)} style={[styles.choice, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Text style={[styles.grow, { color: colors.text }]}>{goalStatusLabel(draft.status)}</Text><ChevronDown size={16} color={colors.muted} />
    </Pressable>
    {statusOpen ? <View style={styles.statusOptions}>{GOAL_STATUSES.map(status => <Pressable key={status} testID={`codex-goal-status-${status}`} accessibilityRole="button" accessibilityState={{ selected: draft.status === status }} onPress={() => { edit({ status }); setStatusOpen(false) }} style={[styles.choice, { borderColor: colors.border, backgroundColor: draft.status === status ? colors.raised : colors.background }]}><Text style={{ color: colors.text }}>{goalStatusLabel(status)}</Text></Pressable>)}</View> : null}
    <View style={styles.budgets}>
      <View style={styles.grow}><Text style={[styles.fieldLabel, { color: colors.text }]}>Token budget</Text><TextInput testID="codex-goal-token-budget" accessibilityLabel="Goal token budget" value={draft.tokenBudget} onChangeText={tokenBudget => edit({ tokenBudget })} editable={available} keyboardType="number-pad" placeholder="No limit" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} /></View>
      <View style={styles.grow}><Text style={[styles.fieldLabel, { color: colors.text }]}>Time limit (seconds)</Text><TextInput testID="codex-goal-time-budget" accessibilityLabel="Goal time limit in seconds" value={draft.timeBudget} onChangeText={timeBudget => edit({ timeBudget })} editable={available} keyboardType="number-pad" placeholder="No limit" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} /></View>
    </View>
    {view?.message ? <Text style={[styles.help, { color: view.timeBudgetExhausted || view.tokenBudgetExhausted ? colors.orange : colors.muted }]}>{view.message}</Text> : null}
    <Text style={[styles.help, { color: colors.muted }]}>The time limit is enforced by AgentsDock; Codex reports elapsed time.</Text>
    {!available ? <Text accessibilityRole="alert" style={[styles.help, { color: colors.orange }]}>Goal controls are unavailable until the Codex runtime is loaded.</Text> : null}
    {saveError || clearError || error ? <Text testID="codex-goal-save-error" accessibilityRole="alert" style={[styles.help, { color: colors.red }]}>{saveError ?? clearError ?? error}</Text> : null}
    {feedback ? <Text testID="codex-goal-feedback" accessibilityLiveRegion="polite" style={[styles.help, { color: colors.green }]}>{feedback}</Text> : null}
    <View style={styles.actions}>
      {goal ? <GoalAction testID="codex-goal-editor-clear" label="Clear goal" icon={Trash2} danger disabled={!available || mutating} onPress={() => {
        const submittedRevision = revision.current
        confirmClear(snapshot => {
          setFeedback(applyFormSnapshot(snapshot, submittedRevision) ? 'Persistent goal cleared.' : 'Goal cleared. Your newer draft is still unsaved.')
          setSaveError(null)
        })
      }} /> : null}
      <GoalAction testID="codex-goal-save" label={saving ? 'Saving…' : saveError ? 'Retry save' : 'Save goal'} icon={Goal} busy={saving} disabled={!available || mutating || !draft.objective.trim()} onPress={() => void save()} />
    </View>
  </View>
}

function useConfirmedGoalClear(goal: CodexGoal | null) {
  const { clearGoal, scopeKey, mutating, goalsEnabled } = useCodexRuntime()
  const [clearError, setClearError] = useState<string | null>(null)
  const confirming = useRef(false)
  const current = useRef({ goal, scopeKey, goalsEnabled })
  current.current = { goal, scopeKey, goalsEnabled }
  useEffect(() => { setClearError(null); confirming.current = false }, [scopeKey])
  useEffect(() => {
    current.current = { goal, scopeKey, goalsEnabled }
    return () => { current.current = { goal: null, scopeKey: '', goalsEnabled: false } }
  }, [scopeKey])
  const confirmClear = (onCleared?: (snapshot: CodexGoalSnapshot) => void) => {
    if (!goal || !goalsEnabled || mutating || confirming.current) return
    confirming.current = true
    const expectedGoal = goal
    const expectedScope = scopeKey
    const cancel = () => { confirming.current = false }
    Alert.alert('Clear persistent goal?', 'This removes the objective and its budgets from this chat.', [
      { text: 'Cancel', style: 'cancel', onPress: cancel },
      { text: 'Clear goal', style: 'destructive', onPress: () => {
        cancel()
        const latest = current.current
        if (latest.scopeKey !== expectedScope || !latest.goalsEnabled) return
        if (latest.goal?.threadId !== expectedGoal.threadId || latest.goal?.objective !== expectedGoal.objective || latest.goal?.createdAt !== expectedGoal.createdAt) {
          setClearError('The goal changed. Review it before clearing.')
          return
        }
        setClearError(null)
        void clearGoal(expectedGoal).then(snapshot => {
          if (snapshot && current.current.scopeKey === expectedScope) onCleared?.(snapshot)
        }).catch(cause => {
          if (current.current.scopeKey === expectedScope) setClearError(errorMessage(cause))
        })
      } },
    ], { cancelable: true, onDismiss: cancel })
  }
  return { confirmClear, clearError }
}

interface GoalDraft { objective: string; status: CodexGoalStatus; tokenBudget: string; timeBudget: string }
function goalDraft(goal: CodexGoal | null, timeBudget?: number | null): GoalDraft {
  return { objective: goal?.objective ?? '', status: goal?.status ?? 'active', tokenBudget: goal?.tokenBudget ? String(goal.tokenBudget) : '', timeBudget: timeBudget ? String(timeBudget) : '' }
}

function GoalAction({ label, accessibilityLabel = label, icon: Icon, disabled, busy, danger, onPress, testID }: {
  label: string; accessibilityLabel?: string; icon: typeof Goal; disabled?: boolean; busy?: boolean; danger?: boolean; onPress(): void; testID: string
}) {
  const colors = usePalette()
  const accent = danger ? colors.red : colors.blue
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: colors.raised, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 }]}>
    {busy ? <ActivityIndicator size="small" color={accent} /> : <Icon size={15} color={accent} />}<Text style={[styles.actionLabel, { color: accent }]}>{label}</Text>
  </Pressable>
}

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
const GOAL_STATUSES: CodexGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5, gap: 4, marginBottom: 7 },
  grow: { flex: 1, minWidth: 0 },
  summary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { fontSize: 12, fontWeight: '900' },
  objective: { fontSize: 12, lineHeight: 17 },
  progress: { fontSize: 10.5, lineHeight: 15, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  action: { minHeight: 44, minWidth: 44, flexGrow: 1, paddingHorizontal: 10, borderRadius: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  actionLabel: { fontSize: 12, fontWeight: '700' },
  details: { maxHeight: 152, flexShrink: 1 },
  detailContent: { gap: 6, paddingVertical: 5 },
  help: { fontSize: 11.5, lineHeight: 17 },
  sheet: { flex: 1 },
  sheetHeader: { minHeight: 64, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: '800' },
  sheetContent: { padding: 14, paddingBottom: 40, width: '100%', maxWidth: 700, alignSelf: 'center' },
  editor: { gap: 9 },
  fieldLabel: { fontSize: 11.5, fontWeight: '700', marginBottom: 3 },
  textarea: { minHeight: 100, maxHeight: 180, textAlignVertical: 'top', borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 10, fontSize: 14 },
  input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, fontSize: 13 },
  choice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusOptions: { gap: 3 },
  budgets: { flexDirection: 'row', gap: 9 },
})
