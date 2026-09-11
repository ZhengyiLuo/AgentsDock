// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexSandboxMode
} from '@shared/types'

export const CODEX_APPROVAL_PROMPT_LABELS: Record<CodexApprovalPolicy, string> = {
  get never() { return t("ui.codex-permission-copy.copy.never_prompt_c6ccbef") },
  get 'on-request'() { return t("ui.codex-permission-copy.copy.ask_when_more_access_is_needed_b1ce18f") },
  get untrusted() { return t("ui.codex-permission-copy.copy.ask_before_untrusted_commands_58c109a") }
}

export const CODEX_APPROVAL_REVIEWER_LABELS: Record<CodexApprovalsReviewer, string> = {
  get user() { return t("ui.codex-permission-copy.copy.me_codex_default_b3d921f") },
  get auto_review() { return t("ui.codex-permission-copy.copy.automatic_reviewer_46f5929") },
  get guardian_subagent() { return t("ui.codex-permission-copy.copy.guardian_reviewer_legacy_eb55b52") }
}

export function codexApprovalPromptHelp(
  policy: CodexApprovalPolicy,
  sandbox: CodexSandboxMode,
  profileActive = false
): string {
  if (policy === 'on-request') {
    if (!profileActive && sandbox === 'danger-full-access') {
      return t("ui.codex-permission-copy.codexApprovalPromptHelp.commands_and_files_already_have_full_acces_53c535a")
    }
    return t("ui.codex-permission-copy.codexApprovalPromptHelp.codex_asks_before_it_needs_to_cross_the_cu_c179b1e")
  }
  if (policy === 'untrusted') {
    return t("ui.codex-permission-copy.codexApprovalPromptHelp.only_known_safe_read_only_commands_run_aut_b540b13")
  }
  if (!profileActive && sandbox === 'danger-full-access') {
    return t("ui.codex-permission-copy.codexApprovalPromptHelp.codex_can_run_commands_anywhere_without_pr_fd881f4")
  }
  return t("ui.codex-permission-copy.codexApprovalPromptHelp.codex_will_not_show_approval_prompts_actio_3024416")
}

export function codexApprovalReviewerHelp(
  reviewer: CodexApprovalsReviewer,
  policy: CodexApprovalPolicy
): string {
  if (policy === 'never') {
    return t("ui.codex-permission-copy.codexApprovalReviewerHelp.the_selected_reviewer_is_inactive_while_ap_04cd29f")
  }
  if (reviewer === 'user') {
    return t("ui.codex-permission-copy.codexApprovalReviewerHelp.approval_requests_pause_for_your_decision_ccfac6d")
  }
  if (reviewer === 'auto_review') {
    return t("ui.codex-permission-copy.codexApprovalReviewerHelp.a_separate_reviewer_agent_evaluates_eligib_31a83ea")
  }
  return t("ui.codex-permission-copy.codexApprovalReviewerHelp.legacy_reviewer_mode_retained_for_existing_aa1b7f1")
}
