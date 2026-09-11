import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import {
  ArchiveRestore,
  Bot,
  Check,
  ChevronDown,
  CircleGauge,
  ClipboardCheck,
  Goal,
  MessageSquareText,
  Play,
  RefreshCw,
  Shield,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { codexControlsPresentation } from '../lib/codex-goals'
import { queueCodexPermissionUpdate } from '../lib/codex-permission-updates'
import {
  DEFAULT_CODEX_APPROVAL_POLICY,
  DEFAULT_CODEX_APPROVALS_REVIEWER,
  DEFAULT_CODEX_SANDBOX_MODE,
} from '../lib/codex-permissions'
import {
  contextUsagePercent,
  formatCompactTokens,
  formatContextUsage,
  formatContextUsageDetail,
  latestCodexContextUsage,
  type CodexContextUsage,
} from '../lib/codex-token-usage'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexBackgroundTerminal,
  CodexReviewTarget,
  CodexSandboxMode,
  JsonValue,
  RuntimeOption,
  Session,
} from '../types'
import { Text, TextInput } from './AppText'
import { CodexInteractionCard } from './CodexInteractionShelf'
import { CodexGoalEditor } from './CodexGoalBar'
import { codexStatusLabel, useCodexRuntime } from './CodexRuntimeContext'
import { IconButton, SheetCloseButton } from './ui'

type NoticeTone = 'success' | 'warning'
type ChoiceOption = RuntimeOption & { disabled?: boolean }

export function CodexStatusButton({ compact }: { compact: boolean }) {
  const colors = usePalette()
  const { supported, loading, runtime, session, error, scopeKey } = useCodexRuntime()
  const lifecycleActive = useAppStore(state => session ? state.activeSessionIds.has(session.id) : false)
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [scopeKey])
  useEffect(() => {
    if (supported || !open) return
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [open, supported])
  if (!supported) return null
  const pending = runtime?.pending_interactions.length ?? 0
  const { tone, label } = codexControlsPresentation({ runtime, loading, error, lifecycleActive })
  const accent = tone === 'waiting' ? colors.orange : tone === 'error' ? colors.red : tone === 'active' ? colors.green : colors.muted
  const close = () => { setOpen(false); requestAnimationFrame(dismissAppKeyboard) }
  return (
    <>
      <Pressable
        testID="codex-status"
        accessibilityRole="button"
        accessibilityLabel={`Codex controls: ${label}`}
        onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }}
        style={({ pressed }) => [
          styles.statusButton,
          compact && styles.statusButtonCompact,
          { backgroundColor: colors.raised, opacity: pressed ? 0.68 : 1 },
        ]}
      >
        {loading ? <ActivityIndicator size="small" color={accent} /> : <Bot size={17} color={accent} />}
        {!compact ? <Text style={[styles.statusButtonText, { color: colors.text }]} numberOfLines={1}>Codex · {label}</Text> : null}
        {pending ? <View style={[styles.badge, { backgroundColor: colors.orange }]}><Text style={styles.badgeText}>{pending}</Text></View> : null}
      </Pressable>
      {open ? <CodexControlsSheet visible onClose={close} /> : null}
    </>
  )
}

/** Always-visible, neutral context accounting for the selected Codex chat. */
export function CodexContextIndicator() {
  const colors = usePalette()
  const { supported, runtime, session, scopeKey } = useCodexRuntime()
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [scopeKey])
  const events = useAppStore(state => session ? state.snapshots[session.id]?.events ?? EMPTY_EVENTS : EMPTY_EVENTS)
  const threadId = session?.codex_thread_id || session?.session_id || null
  const usage = useMemo(
    () => latestCodexContextUsage(events, runtime?.token_usage_snapshot ?? runtime?.token_usage, threadId, runtime?.context_usage_state),
    [events, runtime?.context_usage_state, runtime?.token_usage, runtime?.token_usage_snapshot, threadId],
  )
  useEffect(() => {
    if (supported || !open) return
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [open, supported])
  if (!supported || !session) return null
  const percent = contextUsagePercent(usage)
  const label = formatContextUsage(usage)
  const circumference = Math.PI * 16
  const close = () => { setOpen(false); requestAnimationFrame(dismissAppKeyboard) }
  return <>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Codex context usage: ${label}. Open details`}
      accessibilityValue={percent == null
        ? { text: 'Not available' }
        : { min: 0, max: 100, now: Math.round(percent), text: label }}
      testID="codex-context-usage"
      onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }}
      style={({ pressed }) => [styles.contextIndicator, { opacity: pressed ? 0.62 : 1 }]}
    >
      <Svg width={22} height={22} viewBox="0 0 22 22">
        <Circle cx={11} cy={11} r={8} fill="none" stroke={colors.border} strokeWidth={2.5} strokeDasharray={percent == null ? [2, 3] : undefined} />
        {percent == null ? null : <Circle
          cx={11}
          cy={11}
          r={8}
          fill="none"
          stroke={colors.muted}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={[circumference, circumference]}
          strokeDashoffset={circumference * (1 - percent / 100)}
          rotation={-90}
          origin="11, 11"
        />}
      </Svg>
    </Pressable>
    {open ? <CodexControlsSheet visible onClose={close} /> : null}
  </>
}

function CodexControlsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = usePalette()
  const {
    runtime,
    session,
    loading,
    refreshing,
    error,
    refresh,
    run,
    scopeKey,
  } = useCodexRuntime()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const runtimePermissionProfilesKey = permissionProfilesFingerprint(runtime?.permission_profiles ?? [])
  const runtimeStatusType = runtime?.status?.type ?? 'notLoaded'
  const events = useAppStore(state => session ? state.snapshots[session.id]?.events ?? EMPTY_EVENTS : EMPTY_EVENTS)
  const updateSession = useAppStore(state => state.updateSession)
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>(null)
  const [permissionProfiles, setPermissionProfiles] = useState<ChoiceOption[]>([])
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null)
  const [profileLoadBusy, setProfileLoadBusy] = useState(false)
  const [approvalPolicy, setApprovalPolicy] = useState<CodexApprovalPolicy>(DEFAULT_CODEX_APPROVAL_POLICY)
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>(DEFAULT_CODEX_SANDBOX_MODE)
  const [permissionProfile, setPermissionProfile] = useState('')
  const [reviewer, setReviewer] = useState<CodexApprovalsReviewer>(DEFAULT_CODEX_APPROVALS_REVIEWER)
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [reviewType, setReviewType] = useState<'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom'>('uncommittedChanges')
  const [reviewValue, setReviewValue] = useState('')
  const [rollbackTurns, setRollbackTurns] = useState('1')
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false)
  const [shellCommand, setShellCommand] = useState('')
  const [shellConfirmed, setShellConfirmed] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const permissionSaveInFlight = useRef(false)
  const permissionSaveEpoch = useRef(0)
  const permissionProfileLoadKey = useRef('')

  useEffect(() => { if (visible) void refresh() }, [refresh, visible])

  useEffect(() => {
    if (!session) return
    const sessionPolicyIsAuthoritative = session.codex_approval_policy != null
      && session.codex_sandbox_mode != null
      && session.codex_approvals_reviewer != null
    setApprovalPolicy(session.codex_approval_policy ?? runtime?.policy?.approval_policy ?? DEFAULT_CODEX_APPROVAL_POLICY)
    setSandboxMode(session.codex_sandbox_mode ?? runtime?.policy?.sandbox_mode ?? DEFAULT_CODEX_SANDBOX_MODE)
    setPermissionProfile(sessionPolicyIsAuthoritative
      ? session.codex_permission_profile ?? ''
      : runtime?.policy?.permission_profile ?? '')
    setReviewer(session.codex_approvals_reviewer ?? runtime?.policy?.approvals_reviewer ?? DEFAULT_CODEX_APPROVALS_REVIEWER)
  }, [
    runtime?.policy?.approval_policy,
    runtime?.policy?.approvals_reviewer,
    runtime?.policy?.permission_profile,
    runtime?.policy?.sandbox_mode,
    session?.codex_approval_policy,
    session?.codex_approvals_reviewer,
    session?.codex_permission_profile,
    session?.codex_sandbox_mode,
    session?.id,
  ])
  useEffect(() => {
    permissionSaveEpoch.current += 1
    permissionSaveInFlight.current = false
    setSavingPermissions(false)
  }, [activeProfileId, profileGeneration, session?.id])
  useEffect(() => {
    if (!visible || !session || !activeProfileId) {
      permissionProfileLoadKey.current = ''
      setProfileLoadBusy(false)
      return
    }
    const loadKey = `${activeProfileId}:${profileGeneration}:${session.id}:${runtimePermissionProfilesKey}:${runtimeStatusType}`
    if (runtime?.permission_profiles?.length) {
      permissionProfileLoadKey.current = loadKey
      setPermissionProfiles(permissionProfileChoices(runtime.permission_profiles))
      setProfileLoadError(null)
      setProfileLoadBusy(false)
      return
    }
    if (permissionProfileLoadKey.current === loadKey) return
    permissionProfileLoadKey.current = loadKey
    setNotice(null)
    setPermissionProfiles([])
    setProfileLoadError(null)
    setProfileLoadBusy(false)
    const connection = client
    const requestIsCurrent = () => {
      const state = useAppStore.getState()
      return client === connection
        && state.activeProfileId === activeProfileId
        && state.profileGeneration === profileGeneration
        && state.selectedSessionId === session.id
    }
    let cancelled = false
    void connection.codexPermissionProfiles(session.id)
      .then(profiles => {
        if (cancelled || !requestIsCurrent()) return
        setPermissionProfiles(permissionProfileChoices(profiles))
        setProfileLoadBusy(false)
      })
      .catch(cause => {
        if (cancelled || !requestIsCurrent()) return
        const detail = errorMessage(cause)
        const busy = permissionProfilesBusy(detail)
        setProfileLoadBusy(busy)
        setProfileLoadError(busy
          ? 'Codex is busy. Permission profiles will refresh after the active turn finishes.'
          : detail)
      })
    return () => { cancelled = true }
  }, [activeProfileId, profileGeneration, runtimePermissionProfilesKey, runtimeStatusType, session?.id, visible])
  const threadId = session?.codex_thread_id || session?.session_id || null
  const usage = useMemo(
    () => latestCodexContextUsage(events, runtime?.token_usage_snapshot ?? runtime?.token_usage, threadId, runtime?.context_usage_state),
    [events, runtime?.context_usage_state, runtime?.token_usage, runtime?.token_usage_snapshot, threadId],
  )
  const permissionProfileOptions = useMemo(() => {
    const options: ChoiceOption[] = [{ value: '', label: 'Custom settings' }, ...permissionProfiles]
    if (permissionProfile && !options.some(option => option.value === permissionProfile)) {
      options.splice(1, 0, {
        value: permissionProfile,
        label: `${permissionProfile} (current, unavailable)`,
        disabled: true,
      })
    }
    return options
  }, [permissionProfile, permissionProfiles])

  if (!session) return null
  const scopeIsCurrent = () => {
    const state = useAppStore.getState()
    return state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && state.selectedSessionId === session.id
      && !state.workspaceAdopting
  }
  const perform = (operation: () => Promise<unknown>, success: string) => {
    if (!scopeIsCurrent()) return
    setNotice(null)
    void run(operation)
      .then(() => {
        if (scopeIsCurrent()) setNotice({ text: success, tone: 'success' })
      })
      .catch(() => undefined)
  }
  const savePermissions = () => {
    if (permissionSaveInFlight.current || !activeProfileId || !scopeIsCurrent()) return
    const operationEpoch = ++permissionSaveEpoch.current
    permissionSaveInFlight.current = true
    setSavingPermissions(true)
    setNotice(null)
    const patch = {
      codex_approval_policy: approvalPolicy,
      codex_sandbox_mode: sandboxMode,
      codex_permission_profile: permissionProfile || null,
      codex_approvals_reviewer: reviewer,
    }
    void run(() => queueCodexPermissionUpdate({
      profileId: activeProfileId,
      profileGeneration,
      sessionId: session.id,
    }, async () => {
      const saved = await updateSession(session.id, patch, profileGeneration)
      const state = useAppStore.getState()
      const updated = state.sessions.find(candidate => candidate.id === session.id)
      if (!saved || !updated || !codexPermissionPatchMatches(updated, patch)) {
        throw new Error(state.error || 'The server did not save the Codex permission settings.')
      }
    }))
      .then(() => {
        if (operationEpoch === permissionSaveEpoch.current && scopeIsCurrent()) {
          setNotice({ text: 'Permission settings saved for this chat.', tone: 'success' })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (operationEpoch !== permissionSaveEpoch.current) return
        permissionSaveInFlight.current = false
        if (scopeIsCurrent()) setSavingPermissions(false)
      })
  }
  const startReview = () => perform(
    () => client.reviewCodexThread(session.id, { target: reviewTarget(reviewType, reviewValue), delivery: 'inline' }),
    'Inline Codex review started.',
  )
  const rollback = () => perform(async () => {
    await client.rollbackCodexThread(session.id, {
      num_turns: Math.min(100, Math.max(1, Number.parseInt(rollbackTurns, 10) || 1)),
      confirmed: true,
    })
    setRollbackConfirmed(false)
  }, 'Provider thread rolled back. Files and this chat timeline were not changed.')
  const runShell = () => perform(async () => {
    await client.shellCodexThread(session.id, { command: shellCommand.trim(), confirmed: true })
    setShellCommand('')
    setShellConfirmed(false)
  }, 'Unsandboxed background command started.')
  const flags = runtime?.status?.type === 'active' ? runtime.status.activeFlags : []
  const timeBudgetExhausted = runtime?.time_budget_exhausted === true || Boolean(
    runtime?.goal
    && runtime.time_budget_seconds != null
    && runtime.goal.timeUsedSeconds >= runtime.time_budget_seconds,
  )
  const hasProviderThread = Boolean(session.codex_thread_id || session.session_id)
  const actionsEnabled = Boolean(
    runtime
    && hasProviderThread
    && runtime.status?.type !== 'active'
    && runtime.status?.type !== 'systemError',
  )

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={onClose}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
          <View style={[styles.sheetMark, { backgroundColor: colors.raised }]}><Bot size={20} color={colors.blue} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Codex thread controls</Text>
            <Text style={[styles.sheetSubtitle, { color: colors.muted }]}>
              {runtime?.transport || 'app-server'} · {codexStatusLabel(runtime?.status)}
            </Text>
          </View>
          <IconButton testID="codex-controls-refresh" icon={RefreshCw} label="Refresh Codex status" disabled={refreshing} onPress={() => void refresh()} />
          <SheetCloseButton label="Close Codex controls" testID="codex-controls-close" onPress={onClose} />
        </View>
        <ScrollView
          testID="codex-controls-scroll"
          style={{ flex: 1 }}
          contentContainerStyle={styles.controls}
          keyboardShouldPersistTaps="always"
        >
          {loading ? <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Loading thread controls…</Text></View> : null}
          {error ? <Notice text={error} tone="warning" /> : null}
          {notice ? <Notice text={notice.text} tone={notice.tone} onClose={() => setNotice(null)} /> : null}

          {runtime?.pending_interactions.length ? (
            <Section
              icon={MessageSquareText}
              title="Waiting for you"
              subtitle="Respond here without leaving the thread controls"
            >
              {runtime.pending_interactions.map(interaction => (
                <CodexInteractionCard
                  key={interaction.id}
                  interaction={interaction}
                  busy={refreshing}
                  onRespond={response => run(async () => {
                    await client.resolveCodexInteraction(session.id, interaction.id, response)
                  })}
                />
              ))}
            </Section>
          ) : null}

          <Section icon={CircleGauge} title="Thread status" subtitle="Live state from Codex app-server">
            <View style={styles.statusGrid}>
              <Datum label="State" value={codexStatusLabel(runtime?.status)} />
              <Datum label="Thread" value={runtime?.thread_loaded === false ? 'Not loaded' : 'Loaded'} />
              <Datum label="Context" value={formatContextUsage(usage)} accessibilityLabel={formatContextUsageDetail(usage)} />
              <Datum label="Transport" value={runtime?.transport || 'app-server'} />
              <Datum label="Waiting" value={flags.length ? flags.map(sentenceCase).join(', ') : 'No'} />
              <Datum label="Budget" value={timeBudgetExhausted ? 'Time exhausted' : runtime?.time_budget_seconds ? 'Available' : 'No time limit'} />
            </View>
            {usage ? <ContextUsageDetail usage={usage} /> : null}
            {timeBudgetExhausted ? (
              <Notice
                text="Time budget exhausted. New goal turns are blocked; increase the time limit or change the objective to continue."
                tone="warning"
              />
            ) : null}
            {runtime?.goal ? (
              <View style={[styles.goalSummary, { backgroundColor: colors.background }]}>
                <Text style={[styles.goalSummaryTitle, { color: colors.text }]} numberOfLines={2}>{runtime.goal.objective}</Text>
                <Text style={{ color: colors.muted, fontSize: 11 }}>
                  {runtime.goal.status} · {runtime.goal.tokensUsed.toLocaleString()}
                  {runtime.goal.tokenBudget ? ` / ${runtime.goal.tokenBudget.toLocaleString()} tokens` : ' tokens'}
                  {' · '}{Math.round(runtime.goal.timeUsedSeconds)}s elapsed
                  {runtime.time_budget_seconds ? ` / ${runtime.time_budget_seconds}s` : ''}
                </Text>
              </View>
            ) : null}
          </Section>

          <Section icon={Shield} title="Permissions and approvals" subtitle="Applied to future interactive turns in this chat">
            <Choice
              testID="codex-permission-profile"
              label="Permission profile"
              value={permissionProfile}
              options={permissionProfileOptions}
              busy={savingPermissions}
              onChange={setPermissionProfile}
            />
            <Choice
              testID="codex-filesystem-sandbox"
              label="Filesystem sandbox"
              value={sandboxMode}
              disabled={Boolean(permissionProfile)}
              busy={savingPermissions}
              options={[
                { value: 'read-only', label: 'Read only' },
                { value: 'workspace-write', label: 'Workspace write' },
                { value: 'danger-full-access', label: 'Full access' },
              ]}
              onChange={value => setSandboxMode(value as CodexSandboxMode)}
            />
            <Choice
              testID="codex-command-approvals"
              label="Command approvals"
              value={approvalPolicy}
              busy={savingPermissions}
              options={[
                { value: 'never', label: 'Never ask' },
                { value: 'on-request', label: 'Ask when Codex requests' },
                { value: 'untrusted', label: 'Ask for untrusted actions' },
              ]}
              onChange={value => setApprovalPolicy(value as CodexApprovalPolicy)}
            />
            <Choice
              testID="codex-approval-reviewer"
              label="Approval reviewer"
              value={reviewer}
              busy={savingPermissions}
              options={[
                { value: 'user', label: 'Ask me' },
                { value: 'auto_review', label: 'Codex auto-review' },
                { value: 'guardian_subagent', label: 'Guardian subagent' },
              ]}
              onChange={value => setReviewer(value as CodexApprovalsReviewer)}
            />
            {permissionProfile ? <Text testID="codex-permission-profile-hint" style={[styles.permissionHint, { color: colors.muted }]}>The selected profile replaces the custom filesystem sandbox. Choose Custom settings to edit the sandbox directly.</Text> : null}
            {profileLoadError ? <Text testID="codex-permission-profile-error" accessibilityRole="alert" style={[styles.permissionHint, { color: profileLoadBusy ? colors.yellow : colors.red }]}>{profileLoadBusy ? profileLoadError : `Profiles unavailable: ${profileLoadError}`}</Text> : null}
            <View style={styles.actions}><Action testID="codex-permissions-save" label={savingPermissions ? 'Saving permissions…' : 'Save permissions'} primary disabled={savingPermissions} onPress={savePermissions} /></View>
          </Section>

          <Section icon={Goal} title="Persistent goal" subtitle="Survives turns in this Codex thread">
            <CodexGoalEditor key={scopeKey} />
          </Section>

          <Section icon={ClipboardCheck} title="Thread actions" subtitle="Native Codex app-server operations">
            {!actionsEnabled ? (
              <Notice
                text="Actions require an existing Codex thread that is not currently running."
                tone="warning"
              />
            ) : null}
            <ActionRow
              title="Compact context"
              description="Condense provider context without deleting this chat timeline."
              action={<Action label="Compact" disabled={refreshing || !actionsEnabled} onPress={() => perform(() => client.compactCodexThread(session.id), 'Native context compaction started.')} />}
            />
            <Field label="Inline review target">
              <Choice
                testID="codex-review-target"
                value={reviewType}
                options={[
                  { value: 'uncommittedChanges', label: 'Uncommitted changes' },
                  { value: 'baseBranch', label: 'Changes against branch' },
                  { value: 'commit', label: 'Specific commit' },
                  { value: 'custom', label: 'Custom instructions' },
                ]}
                onChange={value => setReviewType(value as typeof reviewType)}
              />
            </Field>
            {reviewType !== 'uncommittedChanges' ? (
              <TextInput
                value={reviewValue}
                onChangeText={setReviewValue}
                multiline={reviewType === 'custom'}
                placeholder={reviewType === 'baseBranch' ? 'main' : reviewType === 'commit' ? 'Commit SHA' : 'What should Codex review?'}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                style={[reviewType === 'custom' ? styles.textarea : styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
            ) : null}
            <View style={styles.actions}><Action label="Start inline review" disabled={refreshing || !actionsEnabled || reviewType !== 'uncommittedChanges' && !reviewValue.trim()} onPress={startReview} /></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Advanced and unsandboxed actions" accessibilityState={{ expanded: advancedOpen }} onPress={() => setAdvancedOpen(value => !value)} style={[styles.advancedToggle, { backgroundColor: colors.background }]}>
              <Text style={{ color: colors.orange, fontSize: 12, fontWeight: '800', flex: 1 }}>Advanced and unsandboxed actions</Text>
              <ChevronDown size={16} color={colors.orange} style={{ transform: [{ rotate: advancedOpen ? '180deg' : '0deg' }] }} />
            </Pressable>
            {advancedOpen ? (
              <>
                <View style={[styles.dangerBox, { borderColor: colors.red }]}>
                  <Text style={[styles.actionRowTitle, { color: colors.text }]}>Roll back provider thread</Text>
                  <Text style={[styles.actionRowDescription, { color: colors.muted }]}>Removes provider turns only. It does not revert files or erase this chat timeline.</Text>
                  <TextInput value={rollbackTurns} onChangeText={value => setRollbackTurns(digitsOnly(value))} keyboardType="number-pad" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
                  <ConfirmSwitch label="I understand this does not revert files." value={rollbackConfirmed} onChange={setRollbackConfirmed} />
                  <View style={styles.actions}><Action label="Roll back" tone="danger" disabled={refreshing || !actionsEnabled || !rollbackConfirmed} onPress={rollback} /></View>
                </View>
                <View style={[styles.dangerBox, { borderColor: colors.red }]}>
                  <Text style={[styles.actionRowTitle, { color: colors.text }]}>Background shell command</Text>
                  <Text style={[styles.actionRowDescription, { color: colors.muted }]}>Unsandboxed and has full access to the server host.</Text>
                  <TextInput value={shellCommand} onChangeText={setShellCommand} multiline placeholder="Enter an exact shell command" placeholderTextColor={colors.muted} autoCapitalize="none" style={[styles.textarea, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
                  <ConfirmSwitch label="I explicitly approve running this command with full access." value={shellConfirmed} onChange={setShellConfirmed} />
                  <View style={styles.actions}><Action label="Run command" tone="danger" disabled={refreshing || !actionsEnabled || !shellConfirmed || !shellCommand.trim()} onPress={runShell} /></View>
                </View>
              </>
            ) : null}
          </Section>

          {runtime ? (
            <BackgroundTerminals
              sessionId={session.id}
              runtimeSupported={runtime.background_terminals_supported}
              busy={refreshing}
              perform={perform}
            />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

function BackgroundTerminals({ sessionId, runtimeSupported, busy, perform }: {
  sessionId: string
  runtimeSupported: boolean | null
  busy: boolean
  perform(operation: () => Promise<unknown>, success: string): void
}) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [terminals, setTerminals] = useState<CodexBackgroundTerminal[]>([])
  const [supported, setSupported] = useState<boolean | null>(runtimeSupported)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingProcessId, setConfirmingProcessId] = useState<string | null>(null)
  const [stopAllConfirmed, setStopAllConfirmed] = useState(false)
  const requestEpoch = useRef(0)
  useEffect(() => {
    requestEpoch.current += 1
    setOpen(false)
    setTerminals([])
    setSupported(runtimeSupported)
    setLoadError(null)
    setConfirmingProcessId(null)
    setStopAllConfirmed(false)
    return () => { requestEpoch.current += 1 }
  }, [activeProfileId, profileGeneration, runtimeSupported, sessionId])
  const scopeIsCurrent = (connection: typeof client, epoch: number) => {
    const state = useAppStore.getState()
    return epoch === requestEpoch.current
      && client === connection
      && !connection.isDisposed
      && connection.isValidated
      && state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && state.selectedSessionId === sessionId
      && !state.workspaceAdopting
  }
  const load = () => {
    const connection = client
    const epoch = ++requestEpoch.current
    setLoading(true)
    setLoadError(null)
    void connection.codexBackgroundTerminals(sessionId)
      .then(snapshot => {
        if (!scopeIsCurrent(connection, epoch)) return
        setSupported(snapshot.supported)
        setTerminals(snapshot.terminals)
      })
      .catch(cause => {
        if (!scopeIsCurrent(connection, epoch)) return
        setTerminals([])
        setLoadError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (scopeIsCurrent(connection, epoch)) setLoading(false)
      })
  }
  const toggle = () => {
    setOpen(value => {
      const next = !value
      if (next) load()
      return next
    })
  }
  return (
    <Section icon={SquareTerminal} title="Background terminals" subtitle="Loaded only when this section is open">
      <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Hide background terminal processes' : 'Show background terminal processes'} accessibilityState={{ expanded: open }} onPress={toggle} style={[styles.advancedToggle, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800', flex: 1 }}>{open ? 'Hide processes' : 'Show processes'}</Text>
        <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open ? (
        <>
          <View style={styles.actions}>
            <Action label="Refresh" disabled={loading || busy} onPress={load} />
          </View>
          {loading ? <ActivityIndicator color={colors.blue} /> : null}
          {!loading && loadError ? <Notice text={loadError} tone="warning" /> : null}
          {!loading && !loadError && supported === false ? <Text style={{ color: colors.muted, fontSize: 12 }}>Unsupported by this Codex version.</Text> : null}
          {!loading && !loadError && supported !== false && !terminals.length ? <Text style={{ color: colors.muted, fontSize: 12 }}>No background terminals.</Text> : null}
          {terminals.map(terminal => (
            <View key={terminal.processId || terminal.itemId} style={[styles.terminal, { backgroundColor: colors.background }]}>
              <SquareTerminal size={16} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800' }} numberOfLines={2}>{terminal.command || terminal.processId}</Text>
                <Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{[terminal.osPid ? `PID ${terminal.osPid}` : '', terminal.cwd].filter(Boolean).join(' · ')}</Text>
              </View>
              {terminal.processId ? confirmingProcessId === terminal.processId ? (
                <View style={styles.terminalConfirm}>
                  <Text style={{ color: colors.red, fontSize: 10.5, fontWeight: '800' }}>Stop this process?</Text>
                  <View style={styles.actions}>
                    <Action label="Cancel" disabled={busy} onPress={() => setConfirmingProcessId(null)} />
                    <Action
                      label="Confirm terminate"
                      tone="danger"
                      disabled={busy}
                      onPress={() => perform(async () => {
                        await client.terminateCodexBackgroundTerminal(sessionId, {
                          process_id: terminal.processId,
                          confirmed: true,
                        })
                        setConfirmingProcessId(null)
                        load()
                      }, 'Background terminal terminated.')}
                    />
                  </View>
                </View>
              ) : (
                <Action
                  label="Terminate"
                  tone="danger"
                  disabled={busy}
                  onPress={() => setConfirmingProcessId(terminal.processId)}
                />
              ) : null}
            </View>
          ))}
          {supported !== false && terminals.length ? (
            <View style={[styles.dangerBox, { borderColor: colors.red }]}>
              <ConfirmSwitch
                label="I understand this stops every running background terminal in this thread."
                value={stopAllConfirmed}
                onChange={setStopAllConfirmed}
              />
              <View style={styles.actions}>
                <Action
                  label="Stop all terminals"
                  tone="danger"
                  disabled={loading || busy || !stopAllConfirmed}
                  onPress={() => perform(async () => {
                    await client.cleanCodexBackgroundTerminals(sessionId, { confirmed: true })
                    setStopAllConfirmed(false)
                    load()
                  }, 'All running background terminals stopped.')}
                />
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </Section>
  )
}

function Section({ icon: Icon, title, subtitle, children }: {
  icon: typeof Bot
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  const colors = usePalette()
  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.sectionHeader}>
        <Icon size={17} color={colors.blue} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>{subtitle}</Text>
        </View>
      </View>
      {children}
    </View>
  )
}

function Datum({ label, value, accessibilityLabel }: { label: string; value: string; accessibilityLabel?: string }) {
  const colors = usePalette()
  return <View accessible={Boolean(accessibilityLabel)} accessibilityLabel={accessibilityLabel} style={[styles.datum, { backgroundColor: colors.background }]}><Text style={{ color: colors.muted, fontSize: 10 }}>{label}</Text><Text style={{ color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 2 }} numberOfLines={2}>{value}</Text></View>
}

function ContextUsageDetail({ usage }: { usage: CodexContextUsage }) {
  const colors = usePalette()
  const percent = contextUsagePercent(usage)
  const latestId = usage.runId || usage.turnId
  const metrics = [
    ['Input', usage.inputTokens],
    ['Cached', usage.cachedInputTokens],
    ['Cache write', usage.cacheWriteInputTokens],
    ['Output', usage.outputTokens],
    ['Reasoning', usage.reasoningOutputTokens],
    ['Session total', usage.totalTokens],
  ] as const
  return <View style={[styles.contextDetail, { backgroundColor: colors.background, borderColor: colors.border }]}>
    <View style={styles.contextDetailHeading}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.contextDetailTitle, { color: colors.text }]}>Context usage</Text>
        <Text style={[styles.contextDetailSubtitle, { color: colors.muted }]} numberOfLines={2}>{formatContextUsageDetail(usage)}</Text>
      </View>
      {latestId ? <View><Text style={[styles.contextDetailLabel, { color: colors.muted }]}>Latest turn</Text><Text style={[styles.contextDetailId, { color: colors.muted }]}>{shortUsageId(latestId)}</Text></View> : null}
    </View>
    {percent == null ? null : <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${formatCompactTokens(usage.contextTokens ?? 0)} of ${formatCompactTokens(usage.contextWindow ?? 0)} context tokens used`}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent), text: formatContextUsage(usage) }}
      style={[styles.contextProgress, { backgroundColor: colors.border }]}
    ><View style={[styles.contextProgressValue, { width: `${percent}%`, backgroundColor: colors.blue }]} /></View>}
    <View style={styles.contextMetrics}>{metrics.map(([label, value]) => value == null ? null : <View key={label} style={[styles.contextMetric, { backgroundColor: colors.surface }]}><Text style={[styles.contextMetricLabel, { color: colors.muted }]}>{label}</Text><Text style={[styles.contextMetricValue, { color: colors.text }]}>{formatCompactTokens(value)}</Text></View>)}</View>
  </View>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const colors = usePalette()
  return <View style={{ gap: 5 }}><Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text>{children}</View>
}

function Choice({ label, value, options, onChange, disabled, busy, testID }: {
  label?: string
  value: string
  options: ChoiceOption[]
  onChange(value: string): void
  disabled?: boolean
  busy?: boolean
  testID?: string
}) {
  const colors = usePalette()
  const [open, setOpen] = useState(false)
  const unavailable = Boolean(disabled || busy)
  const selected = options.find(option => option.value === value)
    ?? (value ? { value, label: value } : options[0])
  useEffect(() => {
    if (unavailable && open) setOpen(false)
  }, [open, unavailable])
  return (
    <View style={{ gap: 5 }}>
      {label ? <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text> : null}
      <Pressable
        testID={testID}
        disabled={unavailable}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${selected?.label || value || 'Choose'}` : selected?.label || value || 'Choose'}
        accessibilityHint="Shows the available choices inline"
        accessibilityState={{ disabled: unavailable, busy: Boolean(busy), expanded: open }}
        onPress={() => { setOpen(current => !current); requestAnimationFrame(dismissAppKeyboard) }}
        style={[styles.choice, { borderColor: colors.border, backgroundColor: colors.background, opacity: unavailable ? 0.45 : 1 }]}
      >
        <Text style={{ flex: 1, color: colors.text, fontSize: 12 }} numberOfLines={1}>{selected?.label || value}</Text>
        <ChevronDown size={15} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open ? <View testID={testID ? `${testID}-options` : undefined} accessibilityRole="menu" style={[styles.choiceMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {options.map(option => (
          <Pressable
            key={option.value || '__empty'}
            testID={testID ? `${testID}-option-${option.value || 'custom'}` : undefined}
            disabled={option.disabled}
            accessibilityRole="menuitem"
            accessibilityLabel={option.label}
            accessibilityState={{ disabled: Boolean(option.disabled), selected: option.value === value }}
            onPress={() => { if (!option.disabled) { onChange(option.value); setOpen(false) } }}
            style={[styles.choiceOption, { backgroundColor: option.value === value ? colors.raised : 'transparent', opacity: option.disabled ? 0.42 : 1 }]}
          >
            <Text style={{ color: colors.text, fontSize: 13 }}>{option.label}</Text>
            {option.value === value ? <Check size={15} color={colors.blue} /> : null}
          </Pressable>
        ))}
      </View> : null}
    </View>
  )
}

function Action({ label, onPress, disabled, primary, tone, testID }: {
  label: string
  onPress: () => void
  disabled?: boolean
  primary?: boolean
  tone?: 'danger'
  testID?: string
}) {
  const colors = usePalette()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: primary ? colors.blue : colors.raised, opacity: disabled ? 0.4 : pressed ? 0.68 : 1 },
      ]}
    >
      {tone === 'danger' ? <Trash2 size={14} color={colors.red} /> : primary ? <Check size={14} color="white" /> : null}
      <Text style={{ color: primary ? 'white' : tone === 'danger' ? colors.red : colors.text, fontSize: 11.5, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  )
}

function ActionRow({ title, description, action }: { title: string; description: string; action: React.ReactNode }) {
  const colors = usePalette()
  return <View style={styles.actionRow}><View style={{ flex: 1 }}><Text style={[styles.actionRowTitle, { color: colors.text }]}>{title}</Text><Text style={[styles.actionRowDescription, { color: colors.muted }]}>{description}</Text></View>{action}</View>
}

function ConfirmSwitch({ label, value, onChange }: { label: string; value: boolean; onChange(value: boolean): void }) {
  const colors = usePalette()
  return <View style={styles.confirmRow}><Switch accessibilityLabel={label} value={value} onValueChange={onChange} /><Text style={{ color: colors.text, fontSize: 11.5, lineHeight: 16, flex: 1 }}>{label}</Text></View>
}

function Notice({ text, tone, onClose }: { text: string; tone: NoticeTone; onClose?: () => void }) {
  const colors = usePalette()
  const accent = tone === 'warning' ? colors.red : colors.green
  return <View style={[styles.notice, { backgroundColor: `${accent}18`, borderColor: accent }]}><Text style={{ color: accent, fontSize: 11.5, lineHeight: 16, flex: 1 }}>{text}</Text>{onClose ? <IconButton icon={X} size={13} label="Dismiss notice" onPress={onClose} /> : null}</View>
}

function reviewTarget(type: 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom', value: string): CodexReviewTarget {
  if (type === 'baseBranch') return { type, branch: value.trim() }
  if (type === 'commit') return { type, sha: value.trim() }
  if (type === 'custom') return { type, instructions: value.trim() }
  return { type }
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '')
}

function sentenceCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, match => match.toUpperCase())
}

function shortUsageId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value
}

function permissionProfileChoices(profiles: Array<{ id: string; name?: string | null; allowed?: boolean }>): ChoiceOption[] {
  const choices = new Map<string, ChoiceOption>()
  for (const profile of profiles) {
    const value = profile.id || profile.name || ''
    if (!value || choices.has(value)) continue
    choices.set(value, {
      value,
      label: profile.allowed === false ? `${profile.name || value} (unavailable)` : profile.name || value,
      disabled: profile.allowed === false,
    })
  }
  return [...choices.values()]
}

function permissionProfilesFingerprint(profiles: Array<{ id: string; name?: string | null; allowed?: boolean }>): string {
  return profiles
    .map(profile => `${profile.id}\u0000${profile.name ?? ''}\u0000${profile.allowed === false ? '0' : '1'}`)
    .join('\u0001')
}

function codexPermissionPatchMatches(
  session: Session,
  patch: {
    codex_approval_policy: CodexApprovalPolicy
    codex_sandbox_mode: CodexSandboxMode
    codex_permission_profile: string | null
    codex_approvals_reviewer: CodexApprovalsReviewer
  },
): boolean {
  return session.codex_approval_policy === patch.codex_approval_policy
    && session.codex_sandbox_mode === patch.codex_sandbox_mode
    && (session.codex_permission_profile ?? null) === patch.codex_permission_profile
    && session.codex_approvals_reviewer === patch.codex_approvals_reviewer
}

function permissionProfilesBusy(error: string): boolean {
  return /wait for (?:the )?(?:\d+ )?active codex turns? to finish/i.test(error)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause)
}

const EMPTY_EVENTS = [] as const

const styles = StyleSheet.create({
  statusButton: { minHeight: 44, maxWidth: 150, borderRadius: 8, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  statusButtonCompact: { width: 44, paddingHorizontal: 0 },
  statusButtonText: { fontSize: 10.5, fontWeight: '800', flexShrink: 1 },
  contextIndicator: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: 'white', fontSize: 9, fontWeight: '900' },
  sheet: { flex: 1 },
  sheetHeader: { minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
  sheetMark: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { fontSize: 17, fontWeight: '900' },
  sheetSubtitle: { fontSize: 10.5, marginTop: 2 },
  controls: { width: '100%', maxWidth: 800, alignSelf: 'center', padding: 10, paddingBottom: 40, gap: 9 },
  loading: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  notice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 6 },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, gap: 10 },
  sectionHeader: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 13.5, fontWeight: '900' },
  sectionSubtitle: { fontSize: 10.5, marginTop: 2 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  datum: { minWidth: '46%', flexBasis: '46%', flexGrow: 1, borderRadius: 7, padding: 9 },
  contextDetail: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 9, gap: 8 },
  contextDetailHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  contextDetailTitle: { fontSize: 11, fontWeight: '800' },
  contextDetailSubtitle: { marginTop: 2, fontSize: 9.5, lineHeight: 13 },
  contextDetailLabel: { fontSize: 9, textAlign: 'right' },
  contextDetailId: { marginTop: 2, fontSize: 9.5, fontFamily: 'Menlo' },
  contextProgress: { height: 6, overflow: 'hidden', borderRadius: 3 },
  contextProgressValue: { height: '100%', borderRadius: 3 },
  contextMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  contextMetric: { minWidth: '30%', flexGrow: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 5, flexDirection: 'row', justifyContent: 'space-between', gap: 7 },
  contextMetricLabel: { fontSize: 9 },
  contextMetricValue: { fontSize: 9.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  goalSummary: { borderRadius: 7, padding: 9, gap: 4 },
  goalSummaryTitle: { fontSize: 12, fontWeight: '800' },
  fieldLabel: { fontSize: 10.5, fontWeight: '800' },
  permissionHint: { fontSize: 10.5, lineHeight: 15 },
  choice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  input: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12.5 },
  textarea: { minHeight: 82, maxHeight: 150, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 9, fontSize: 12.5, textAlignVertical: 'top' },
  twoColumns: { flexDirection: 'row', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 7 },
  action: { minHeight: 44, borderRadius: 7, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  actionRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 9 },
  actionRowTitle: { fontSize: 12, fontWeight: '800' },
  actionRowDescription: { fontSize: 10.5, lineHeight: 15, marginTop: 2 },
  advancedToggle: { minHeight: 46, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  dangerBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, gap: 8 },
  confirmRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  terminal: { minHeight: 58, borderRadius: 7, padding: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  terminalConfirm: { width: '100%', alignItems: 'flex-end', gap: 4 },
  choiceMenu: { width: '100%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 6 },
  choiceOption: { minHeight: 46, borderRadius: 6, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
})
