import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, ChevronDown, Shield } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { COMPOSER_PERMISSION_FACE_SIZE, COMPOSER_TOOLBAR_TOUCH_SIZE } from '../lib/composer-toolbar-layout'
import {
  DEFAULT_CODEX_APPROVAL_POLICY,
  DEFAULT_CODEX_APPROVALS_REVIEWER,
  DEFAULT_CODEX_SANDBOX_MODE,
} from '../lib/codex-permissions'
import {
  codexPermissionScopeKey,
  queueCodexPermissionUpdate,
  type CodexPermissionUpdateScope,
} from '../lib/codex-permission-updates'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexRuntimePolicy,
  CodexSandboxMode,
  Session,
} from '../types'
import { Text } from './AppText'
import { useCodexRuntime } from './CodexRuntimeContext'
import { SheetCloseButton } from './ui'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface PermissionDraft {
  policy: CodexApprovalPolicy
  sandbox: CodexSandboxMode
  profile: string
  reviewer: CodexApprovalsReviewer
}

interface PermissionOption {
  value: string
  label: string
  disabled?: boolean
}

const APPROVAL_LABELS: Record<CodexApprovalPolicy, string> = {
  never: 'Never ask',
  'on-request': 'Ask when needed',
  untrusted: 'Ask for untrusted',
}

const SANDBOX_LABELS: Record<CodexSandboxMode, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

const REVIEWER_LABELS: Record<CodexApprovalsReviewer, string> = {
  user: 'Ask me',
  auto_review: 'Codex auto-review',
  guardian_subagent: 'Guardian subagent',
}

export function CodexPermissionMenu({ sessionId, compact }: { sessionId: string; compact: boolean }) {
  const colors = usePalette()
  const { runtime, supported } = useCodexRuntime()
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]))
  const runtimePermissionProfilesKey = permissionProfilesFingerprint(runtime?.permission_profiles ?? [])
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState(runtime?.permission_profiles ?? [])
  const [profilesError, setProfilesError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [draft, setDraft] = useState<PermissionDraft>(() => permissionDraft(session, runtime?.policy))
  const draftRef = useRef(draft)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const profileLoadAttempted = useRef(false)
  const runtimeHadPermissionProfiles = useRef(Boolean(runtime?.permission_profiles?.length))
  const scope: CodexPermissionUpdateScope = {
    profileId: activeProfileId ?? '',
    profileGeneration,
    sessionId,
  }
  const scopeKey = codexPermissionScopeKey(scope)
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const policyResolved = Boolean(session && hasPermissionPolicy(session, runtime?.policy))
  const editable = Boolean(session && activeProfileId && supported && policyResolved && !admitting)
  const profileLabel = useMemo(
    () => profiles.find(item => (item.id || item.name) === draft.profile)?.name || draft.profile,
    [draft.profile, profiles],
  )
  const accessLabel = draft.profile ? profileLabel : SANDBOX_LABELS[draft.sandbox]
  const approvalLabel = APPROVAL_LABELS[draft.policy]
  const riskyPermissions = !draft.profile && draft.sandbox === 'danger-full-access' && draft.policy === 'never'
  const accessibleLabel = !supported
    ? 'Codex permissions unavailable; update AgentsServer and use Codex app-server'
    : !policyResolved
      ? 'Codex permissions loading'
      : `Codex permissions: ${accessLabel}; commands ${approvalLabel.toLowerCase()}; ${REVIEWER_LABELS[draft.reviewer]}`

  useEffect(() => {
    saveEpoch.current += 1
    setSaveState('idle')
    setSaveError(null)
    setProfiles(runtime?.permission_profiles ?? [])
    setProfilesError(null)
    profileLoadAttempted.current = false
    const next = permissionDraft(session, runtime?.policy)
    draftRef.current = next
    setDraft(next)
    setOpen(false)
  }, [scopeKey])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saveEpoch.current += 1
    }
  }, [])

  useEffect(() => {
    if (saveState === 'saving') return
    const next = permissionDraft(session, runtime?.policy)
    draftRef.current = next
    setDraft(next)
  }, [
    runtime?.policy?.approval_policy,
    runtime?.policy?.approvals_reviewer,
    runtime?.policy?.permission_profile,
    runtime?.policy?.sandbox_mode,
    saveState,
    session?.codex_approval_policy,
    session?.codex_approvals_reviewer,
    session?.codex_permission_profile,
    session?.codex_sandbox_mode,
  ])

  useEffect(() => {
    const runtimePermissionProfiles = runtime?.permission_profiles ?? []
    const hasRuntimePermissionProfiles = runtimePermissionProfiles.length > 0
    if (hasRuntimePermissionProfiles) {
      setProfiles(runtimePermissionProfiles)
      setProfilesError(null)
    } else if (runtimeHadPermissionProfiles.current) {
      setProfiles([])
      profileLoadAttempted.current = false
    }
    runtimeHadPermissionProfiles.current = hasRuntimePermissionProfiles
  }, [runtimePermissionProfilesKey])

  useEffect(() => {
    if (!open) {
      profileLoadAttempted.current = false
      return
    }
    if (!editable || !session || runtime?.permission_profiles?.length || profileLoadAttempted.current) return
    profileLoadAttempted.current = true
    const connection = client
    const expectedScopeKey = scopeKey
    let cancelled = false
    setProfilesError(null)
    void connection.codexPermissionProfiles(session.id)
      .then(items => {
        if (!cancelled && client === connection && scopeKeyRef.current === expectedScopeKey) setProfiles(items)
      })
      .catch(cause => {
        if (!cancelled && client === connection && scopeKeyRef.current === expectedScopeKey) setProfilesError(errorMessage(cause))
      })
    return () => { cancelled = true }
  }, [editable, open, runtimePermissionProfilesKey, scopeKey, session?.id])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = setTimeout(() => setSaveState('idle'), 1_400)
    return () => clearTimeout(timer)
  }, [saveState])

  useEffect(() => {
    if (supported || !open) return
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [open, supported])

  if (!session || session.backend !== 'codex') return null

  const close = () => {
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }
  const apply = (change: Partial<PermissionDraft>) => {
    if (!editable || !activeProfileId) return
    const next = { ...draftRef.current, ...change }
    const expectedScope = { ...scope, profileId: activeProfileId }
    const expectedScopeKey = codexPermissionScopeKey(expectedScope)
    const epoch = ++saveEpoch.current
    draftRef.current = next
    setDraft(next)
    setSaveState('saving')
    setSaveError(null)
    void queueCodexPermissionUpdate(expectedScope, async () => {
      const saved = await useAppStore.getState().updateSession(session.id, permissionPatch(next), profileGeneration)
      const current = useAppStore.getState()
      const updated = current.sessions.find(candidate => candidate.id === session.id)
      if (!saved || !updated || !permissionPatchMatches(updated, permissionPatch(next))) {
        throw new Error(current.error || 'Could not update Codex permissions.')
      }
    }).then(() => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      setSaveState('saved')
    }).catch(cause => {
      if (!mounted.current || epoch !== saveEpoch.current || scopeKeyRef.current !== expectedScopeKey) return
      const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
      const fallback = permissionDraft(updated ?? session, runtime?.policy)
      draftRef.current = fallback
      setDraft(fallback)
      setSaveState('error')
      setSaveError(errorMessage(cause))
    })
  }

  const profileOptions: PermissionOption[] = [
    { value: '', label: 'Custom settings' },
    ...(draft.profile && !profiles.some(item => (item.id || item.name) === draft.profile)
      ? [{ value: draft.profile, label: `${profileLabel || draft.profile} (current, unavailable)`, disabled: true }]
      : []),
    ...profiles.flatMap(item => {
      const value = item.id || item.name || ''
      return value ? [{ value, label: item.name || value, disabled: item.allowed === false }] : []
    }),
  ]

  return <>
    <Pressable
      testID="codex-permissions"
      accessibilityRole="button"
      accessibilityLabel={accessibleLabel}
      accessibilityState={{ disabled: !editable, expanded: open }}
      disabled={!editable}
      onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }}
      style={({ pressed }) => [
        styles.trigger,
        compact ? styles.triggerCompact : styles.triggerWide,
        {
          backgroundColor: compact ? 'transparent' : colors.raised,
          borderColor: compact ? 'transparent' : colors.border,
          opacity: !editable ? 0.38 : pressed ? 0.64 : 1,
        },
      ]}
    >
      {compact ? <View style={[styles.triggerCompactFace, { backgroundColor: colors.raised }]}><Shield size={16} color={colors.muted} />{riskyPermissions ? <View style={[styles.triggerWarningDot, { backgroundColor: colors.orange }]} /> : null}</View> : <><Shield size={17} color={colors.muted} /><Text style={[styles.triggerText, { color: colors.text }]} numberOfLines={1}>{accessLabel} · {compactApprovalLabel(draft.policy)}</Text><ChevronDown size={13} color={colors.muted} /></>}
    </Pressable>
    {open ? <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
      <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={[styles.headerMark, { backgroundColor: colors.raised }]}><Shield size={19} color={colors.blue} /></View>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>Codex permissions</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Applies to future turns in this chat.</Text>
          </View>
          <View accessibilityLiveRegion="polite" style={styles.saveStatus}>
            {saveState === 'saving' ? <ActivityIndicator size="small" color={colors.blue} /> : null}
            <Text style={[styles.saveStatusText, { color: saveState === 'error' ? colors.red : colors.muted }]}>
              {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
            </Text>
          </View>
          <SheetCloseButton label="Close Codex permissions" testID="codex-permissions-close" onPress={close} />
        </View>
        <ScrollView
          testID="codex-permissions-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="always"
        >
          <InlineChoice
            testID="codex-permission-profile"
            label="Permission profile"
            value={draft.profile}
            options={profileOptions}
            onChange={value => apply({ profile: value })}
          />
          <InlineChoice
            testID="codex-permission-sandbox"
            label="Filesystem sandbox"
            value={draft.sandbox}
            disabled={Boolean(draft.profile)}
            options={[
              { value: 'read-only', label: 'Read only' },
              { value: 'workspace-write', label: 'Workspace write' },
              { value: 'danger-full-access', label: 'Full access' },
            ]}
            onChange={value => apply({ sandbox: value as CodexSandboxMode })}
          />
          <InlineChoice
            testID="codex-permission-approvals"
            label="Command approvals"
            value={draft.policy}
            options={[
              { value: 'never', label: 'Never ask' },
              { value: 'on-request', label: 'Ask when Codex requests' },
              { value: 'untrusted', label: 'Ask for untrusted actions' },
            ]}
            onChange={value => apply({ policy: value as CodexApprovalPolicy })}
          />
          <InlineChoice
            testID="codex-permission-reviewer"
            label="Approval reviewer"
            value={draft.reviewer}
            options={[
              { value: 'user', label: 'Ask me' },
              { value: 'auto_review', label: 'Codex auto-review' },
              { value: 'guardian_subagent', label: 'Guardian subagent' },
            ]}
            onChange={value => apply({ reviewer: value as CodexApprovalsReviewer })}
          />
          {draft.profile ? <Text style={[styles.hint, { color: colors.muted }]}>The selected profile replaces the custom filesystem sandbox. Clearing it restores the preserved sandbox.</Text> : null}
          {profilesError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>Profiles unavailable: {profilesError}</Text> : null}
          {saveError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>{saveError}</Text> : null}
          {riskyPermissions ? <Text style={[styles.warning, { color: colors.orange, borderColor: colors.orange }]}>Full access with no command prompts is enabled for this chat.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>
}

function InlineChoice({ testID, label, value, options, onChange, disabled }: {
  testID: string
  label: string
  value: string
  options: PermissionOption[]
  onChange(value: string): void
  disabled?: boolean
}) {
  const colors = usePalette()
  const [expanded, setExpanded] = useState(false)
  const selected = options.find(option => option.value === value) ?? options[0]
  useEffect(() => {
    if (disabled && expanded) setExpanded(false)
  }, [disabled, expanded])
  return <View style={styles.field}>
    <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${selected?.label || value}`}
      accessibilityState={{ disabled: Boolean(disabled), expanded }}
      disabled={disabled}
      onPress={() => setExpanded(current => !current)}
      style={({ pressed }) => [styles.choice, {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        opacity: disabled ? 0.42 : pressed ? 0.68 : 1,
      }]}
    >
      <Text style={[styles.choiceText, { color: colors.text }]} numberOfLines={1}>{selected?.label || value}</Text>
      <ChevronDown size={15} color={colors.muted} style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
    </Pressable>
    {expanded ? <View style={[styles.options, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {options.map(option => <Pressable
        key={option.value || '__custom'}
        testID={`${testID}-option-${option.value || 'custom'}`}
        accessibilityRole="button"
        accessibilityLabel={option.label}
        accessibilityState={{ disabled: Boolean(option.disabled), selected: option.value === value }}
        disabled={option.disabled}
        onPress={() => {
          setExpanded(false)
          if (option.value !== value) onChange(option.value)
        }}
        style={({ pressed }) => [styles.option, {
          backgroundColor: option.value === value ? colors.raised : 'transparent',
          opacity: option.disabled ? 0.38 : pressed ? 0.65 : 1,
        }]}
      >
        <Text style={[styles.optionText, { color: colors.text }]}>{option.label}</Text>
        {option.value === value ? <Check size={16} color={colors.blue} /> : null}
      </Pressable>)}
    </View> : null}
  </View>
}

function permissionDraft(session: Session | null, runtimePolicy?: CodexRuntimePolicy | null): PermissionDraft {
  const sessionPolicyIsAuthoritative = Boolean(session && hasSessionPermissionPolicy(session))
  return {
    policy: session?.codex_approval_policy ?? runtimePolicy?.approval_policy ?? DEFAULT_CODEX_APPROVAL_POLICY,
    sandbox: session?.codex_sandbox_mode ?? runtimePolicy?.sandbox_mode ?? DEFAULT_CODEX_SANDBOX_MODE,
    profile: sessionPolicyIsAuthoritative
      ? session?.codex_permission_profile ?? ''
      : runtimePolicy?.permission_profile ?? '',
    reviewer: session?.codex_approvals_reviewer ?? runtimePolicy?.approvals_reviewer ?? DEFAULT_CODEX_APPROVALS_REVIEWER,
  }
}

function hasPermissionPolicy(session: Session, runtimePolicy?: CodexRuntimePolicy | null): boolean {
  return (session.codex_approval_policy ?? runtimePolicy?.approval_policy) != null
    && (session.codex_sandbox_mode ?? runtimePolicy?.sandbox_mode) != null
    && (session.codex_approvals_reviewer ?? runtimePolicy?.approvals_reviewer) != null
}

function hasSessionPermissionPolicy(session: Session): boolean {
  return session.codex_approval_policy != null
    && session.codex_sandbox_mode != null
    && session.codex_approvals_reviewer != null
}

function permissionPatch(draft: PermissionDraft) {
  return {
    codex_approval_policy: draft.policy,
    codex_sandbox_mode: draft.sandbox,
    codex_permission_profile: draft.profile || null,
    codex_approvals_reviewer: draft.reviewer,
  }
}

function permissionPatchMatches(session: Session, patch: ReturnType<typeof permissionPatch>): boolean {
  return session.codex_approval_policy === patch.codex_approval_policy
    && session.codex_sandbox_mode === patch.codex_sandbox_mode
    && (session.codex_permission_profile ?? null) === patch.codex_permission_profile
    && session.codex_approvals_reviewer === patch.codex_approvals_reviewer
}

function permissionProfilesFingerprint(profiles: Array<{ id: string; name?: string | null; allowed?: boolean }>): string {
  return profiles
    .map(profile => `${profile.id}\u0000${profile.name ?? ''}\u0000${profile.allowed === false ? '0' : '1'}`)
    .join('\u0001')
}

function compactApprovalLabel(value: CodexApprovalPolicy): string {
  if (value === 'never') return 'Never'
  if (value === 'on-request') return 'Ask'
  return 'Untrusted'
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const styles = StyleSheet.create({
  trigger: { height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  triggerCompact: { width: COMPOSER_TOOLBAR_TOUCH_SIZE },
  triggerWide: { minWidth: COMPOSER_TOOLBAR_TOUCH_SIZE, maxWidth: 160, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9 },
  triggerCompactFace: { width: COMPOSER_PERMISSION_FACE_SIZE, height: COMPOSER_PERMISSION_FACE_SIZE, position: 'relative', borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  triggerWarningDot: { width: 5, height: 5, position: 'absolute', top: 3, right: 3, borderRadius: 3 },
  triggerText: { minWidth: 0, flexShrink: 1, fontSize: 10.5, fontWeight: '800' },
  sheet: { flex: 1 },
  header: { minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerMark: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '900' },
  subtitle: { marginTop: 2, fontSize: 10.5 },
  saveStatus: { minWidth: 58, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  saveStatusText: { fontSize: 10.5, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 14, paddingBottom: 44, gap: 12 },
  field: { gap: 5 },
  label: { fontSize: 10.5, fontWeight: '800' },
  choice: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 8 },
  choiceText: { minWidth: 0, flex: 1, fontSize: 13 },
  options: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 5, gap: 2 },
  option: { minHeight: 46, borderRadius: 6, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  optionText: { minWidth: 0, flex: 1, fontSize: 13 },
  hint: { fontSize: 10.5, lineHeight: 15 },
  error: { fontSize: 11, lineHeight: 16 },
  warning: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, fontSize: 11, lineHeight: 16 },
})
