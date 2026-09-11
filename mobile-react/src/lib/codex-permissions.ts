import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexSandboxMode,
} from '../types'

export const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = 'never'
export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access'
export const DEFAULT_CODEX_PERMISSION_PROFILE: null = null
export const DEFAULT_CODEX_APPROVALS_REVIEWER: CodexApprovalsReviewer = 'user'

export const DEFAULT_CODEX_PERMISSION_SETTINGS = Object.freeze({
  codex_approval_policy: DEFAULT_CODEX_APPROVAL_POLICY,
  codex_sandbox_mode: DEFAULT_CODEX_SANDBOX_MODE,
  codex_permission_profile: DEFAULT_CODEX_PERMISSION_PROFILE,
  codex_approvals_reviewer: DEFAULT_CODEX_APPROVALS_REVIEWER,
})
