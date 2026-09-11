// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, LoaderCircle, Shield, X } from 'lucide-react'
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexPermissionProfile,
  CodexRuntimePolicy,
  CodexSandboxMode,
  Session
} from '@shared/types'
import {
  CODEX_APPROVAL_PROMPT_LABELS,
  CODEX_APPROVAL_REVIEWER_LABELS,
  codexApprovalPromptHelp,
  codexApprovalReviewerHelp
} from '../lib/codex-permission-copy'
import { queueCodexPermissionUpdate, type CodexPermissionPatch } from '../lib/codex-permission-updates'
import { useAppStore } from '../store/app-store'
import { codexBridge, useCodexRuntime } from './CodexRuntimeContext'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface PermissionDraft {
  policy: CodexApprovalPolicy
  sandbox: CodexSandboxMode
  profile: string
  reviewer: CodexApprovalsReviewer
}

const SANDBOX_LABELS: Record<CodexSandboxMode, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access'
}

export function CodexPermissionMenu({
  session,
  open: controlledOpen,
  onOpenChange
}: {
  session: Session
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  useLocale()
  const { runtime, supported } = useCodexRuntime()
  const [internalOpen, setInternalOpen] = useState(false)
  const [discoveredProfiles, setDiscoveredProfiles] = useState<CodexPermissionProfile[]>([])
  const [profilesError, setProfilesError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [draft, setDraft] = useState<PermissionDraft>(() => permissionDraft(session, runtime?.policy))
  const draftRef = useRef(draft)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const profiles = runtime?.permission_profiles?.length
    ? runtime.permission_profiles
    : discoveredProfiles
  const { policy, sandbox, profile, reviewer } = draft
  const policyResolved = hasPermissionPolicy(session, runtime?.policy)
  const editable = supported && policyResolved
  const profileLabel = useMemo(
    () => profiles.find(item => (item.id || item.name) === profile)?.name || profile,
    [profile, profiles, getLocale()]
  )
  const accessLabel = profile ? profileLabel : SANDBOX_LABELS[sandbox]
  const approvalLabel = compactApprovalPolicyLabel(policy)
  const compactAccessLabel = profile ? profileLabel : compactSandboxLabel(sandbox)
  const compactApprovalLabel = compactApprovalPolicyLabel(policy)
  const accessibleLabel = !supported
    ? 'Codex permissions unavailable; update AgentsServer and use Codex app-server'
    : !policyResolved
      ? 'Codex permissions loading'
      : [
        `Codex permissions: ${accessLabel}`,
        `approval prompts: ${CODEX_APPROVAL_PROMPT_LABELS[policy].toLowerCase()}`,
        `reviewer: ${CODEX_APPROVAL_REVIEWER_LABELS[reviewer]}`
      ].join('; ')
  const open = controlledOpen ?? internalOpen
  const effectiveOpen = open && editable
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    saveEpoch.current += 1
    setSaveState('idle')
    setSaveError(null)
    setDiscoveredProfiles([])
    setProfilesError(null)
    const next = permissionDraft(session, runtime?.policy)
    draftRef.current = next
    setDraft(next)
  }, [session.id])

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
    session.codex_approval_policy,
    session.codex_approvals_reviewer,
    session.codex_permission_profile,
    session.codex_sandbox_mode
  ])

  useEffect(() => {
    if (runtime?.permission_profiles?.length) {
      setDiscoveredProfiles([])
      setProfilesError(null)
    }
  }, [runtime?.permission_profiles])

  useEffect(() => {
    if (!effectiveOpen || runtime?.permission_profiles?.length || discoveredProfiles.length) return
    const bridge = codexBridge()
    if (!bridge) return
    let cancelled = false
    setProfilesError(null)
    void bridge.permissionProfiles(session.id)
      .then(items => {
        if (!cancelled) setDiscoveredProfiles(items)
      })
      .catch(cause => {
        if (!cancelled) setProfilesError(errorMessage(cause))
      })
    return () => { cancelled = true }
  }, [discoveredProfiles.length, effectiveOpen, runtime?.permission_profiles, session.id])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = window.setTimeout(() => setSaveState('idle'), 1_400)
    return () => window.clearTimeout(timer)
  }, [saveState])

  const apply = (change: Partial<PermissionDraft>) => {
    if (!editable) return
    const next = { ...draftRef.current, ...change }
    draftRef.current = next
    setDraft(next)
    const epoch = ++saveEpoch.current
    setSaveState('saving')
    setSaveError(null)
    void queueCodexPermissionUpdate(session.id, permissionPatch(next))
      .then(() => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        setSaveState('saved')
      })
      .catch(cause => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
        const fallback = permissionDraft(updated ?? session, runtime?.policy)
        draftRef.current = fallback
        setDraft(fallback)
        setSaveState('error')
        setSaveError(errorMessage(cause))
      })
  }

  return <Popover.Root open={effectiveOpen} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button
        type="button"
        className={`codex-permission-chip${editable ? '' : ' unavailable'}`}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        disabled={!editable}
      >
        <Shield size={14} aria-hidden="true" />
        {editable
          ? <>
            <span className="codex-permission-primary">{accessLabel}</span>
            <span className="codex-permission-secondary">· {approvalLabel}</span>
            <span className="codex-permission-compact">{compactAccessLabel} · {compactApprovalLabel}</span>
          </>
          : <span className="codex-permission-unavailable">{supported ? t("ui.CodexPermissionMenu.CodexPermissionMenu.loading_permissions_6a1ca9c") : t("ui.CodexPermissionMenu.CodexPermissionMenu.permissions_unavailable_bf8f124")}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        className="codex-permission-popover"
        side="top"
        align="start"
        sideOffset={8}
        aria-labelledby="codex-permission-title"
        aria-describedby="codex-permission-description"
      >
        <header>
          <span className="codex-permission-popover-icon"><Shield size={16} aria-hidden="true" /></span>
          <div>
            <h3 id="codex-permission-title">{t("ui.CodexPermissionMenu.CodexPermissionMenu.codex_permissions_0584c0a")}</h3>
            <p id="codex-permission-description">{t("ui.CodexPermissionMenu.CodexPermissionMenu.applies_to_future_turns_in_this_chat_95b5680")}</p>
          </div>
          <div className="codex-permission-popover-actions">
            <span className={`codex-permission-save-state ${saveState}`} role="status" aria-live="polite">
              {saveState === 'saving' && <><LoaderCircle className="spin" size={12} />{" "}{t("ui.CodexPermissionMenu.CodexPermissionMenu.saving_096b736")}</>}
              {saveState === 'saved' && <><Check size={12} />{" "}{t("ui.CodexPermissionMenu.CodexPermissionMenu.saved_b5c120b")}</>}
              {saveState === 'error' && 'Not saved'}
            </span>
            <Popover.Close asChild>
              <button type="button" className="codex-permission-popover-close" aria-label={t("ui.CodexPermissionMenu.CodexPermissionMenu.close_codex_permissions_056cef9")} title={t("ui.CodexPermissionMenu.CodexPermissionMenu.close_7d9eb7a")}>
                <X size={14} aria-hidden="true" />
              </button>
            </Popover.Close>
          </div>
        </header>
        <div className="codex-permission-fields">
          <label>
            <span>{t("ui.CodexPermissionMenu.CodexPermissionMenu.permission_profile_ffcd396")}</span>
            <select
              value={profile}
              onChange={event => apply({ profile: event.target.value })}
            >
              <option value="">{t("ui.CodexPermissionMenu.CodexPermissionMenu.custom_settings_4229eea")}</option>
              {profiles.map(item => {
                const value = item.id || item.name || ''
                return value
                  ? <option key={value} value={value} disabled={item.allowed === false}>{item.name || value}</option>
                  : null
              })}
            </select>
          </label>
          <label>
            <span>{t("ui.CodexPermissionMenu.CodexPermissionMenu.filesystem_sandbox_8e1f1cf")}</span>
            <select
              disabled={Boolean(profile)}
              value={sandbox}
              onChange={event => apply({ sandbox: event.target.value as CodexSandboxMode })}
            >
              <option value="read-only">{t("ui.CodexPermissionMenu.CodexPermissionMenu.read_only_8ac7673")}</option>
              <option value="workspace-write">{t("ui.CodexPermissionMenu.CodexPermissionMenu.workspace_write_30f7aaa")}</option>
              <option value="danger-full-access">{t("ui.CodexPermissionMenu.CodexPermissionMenu.full_access_f19611c")}</option>
            </select>
          </label>
          <label>
            <span>{t("ui.CodexPermissionMenu.CodexPermissionMenu.approval_prompts_60d8110")}</span>
            <select
              value={policy}
              onChange={event => apply({ policy: event.target.value as CodexApprovalPolicy })}
            >
              {Object.entries(CODEX_APPROVAL_PROMPT_LABELS).map(([value, label]) =>
                <option key={value} value={value}>{label}</option>
              )}
            </select>
          </label>
          <label>
            <span>{t("ui.CodexPermissionMenu.CodexPermissionMenu.who_approves_58343a1")}</span>
            <select
              value={reviewer}
              onChange={event => apply({ reviewer: event.target.value as CodexApprovalsReviewer })}
            >
              {Object.entries(CODEX_APPROVAL_REVIEWER_LABELS).map(([value, label]) =>
                <option key={value} value={value}>{label}</option>
              )}
            </select>
          </label>
        </div>
        {profile && <p className="codex-permission-hint">{t("ui.CodexPermissionMenu.CodexPermissionMenu.the_selected_profile_replaces_the_custom_f_be23dfb")}</p>}
        <p className="codex-permission-hint">
          {codexApprovalPromptHelp(policy, sandbox, Boolean(profile))}
        </p>
        <p className="codex-permission-hint">{codexApprovalReviewerHelp(reviewer, policy)}</p>
        {profilesError && <p className="codex-permission-error" role="alert">{t("ui.CodexPermissionMenu.CodexPermissionMenu.profiles_unavailable_8867d9c")}{" "}{profilesError}</p>}
        {saveError && <p className="codex-permission-error" role="alert">{saveError}</p>}
        <Popover.Arrow className="codex-permission-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function hasPermissionPolicy(session: Session, runtimePolicy?: CodexRuntimePolicy | null): boolean {
  return (
    (session.codex_approval_policy ?? runtimePolicy?.approval_policy) != null
    && (session.codex_sandbox_mode ?? runtimePolicy?.sandbox_mode) != null
    && (session.codex_approvals_reviewer ?? runtimePolicy?.approvals_reviewer) != null
  )
}

function permissionDraft(session: Session, runtimePolicy?: CodexRuntimePolicy | null): PermissionDraft {
  const sessionPolicyIsAuthoritative = hasSessionPermissionPolicy(session)
  return {
    policy: session.codex_approval_policy ?? runtimePolicy?.approval_policy ?? 'never',
    sandbox: session.codex_sandbox_mode ?? runtimePolicy?.sandbox_mode ?? 'danger-full-access',
    profile: sessionPolicyIsAuthoritative
      ? session.codex_permission_profile ?? ''
      : runtimePolicy?.permission_profile ?? '',
    reviewer: session.codex_approvals_reviewer ?? runtimePolicy?.approvals_reviewer ?? 'user'
  }
}

function hasSessionPermissionPolicy(session: Session): boolean {
  return session.codex_approval_policy != null
    && session.codex_sandbox_mode != null
    && session.codex_approvals_reviewer != null
}

function permissionPatch(draft: PermissionDraft): CodexPermissionPatch {
  return {
    codex_approval_policy: draft.policy,
    codex_sandbox_mode: draft.sandbox,
    codex_permission_profile: draft.profile || null,
    codex_approvals_reviewer: draft.reviewer
  }
}

function compactSandboxLabel(value: CodexSandboxMode): string {
  if (value === 'danger-full-access') return t("ui.CodexPermissionMenu.compactSandboxLabel.full_008dacb")
  if (value === 'workspace-write') return t("ui.CodexPermissionMenu.compactSandboxLabel.workspace_87bb59b")
  return t("ui.CodexPermissionMenu.compactSandboxLabel.read_only_8ac7673")
}

function compactApprovalPolicyLabel(value: CodexApprovalPolicy): string {
  if (value === 'never') return t("ui.CodexPermissionMenu.compactApprovalPolicyLabel.no_prompts_f104637")
  if (value === 'on-request') return t("ui.CodexPermissionMenu.compactApprovalPolicyLabel.ask_for_access_3dffe37")
  return t("ui.CodexPermissionMenu.compactApprovalPolicyLabel.ask_for_untrusted_43017a9")
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}
