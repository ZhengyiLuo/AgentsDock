// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import type { ClaudePermissionMode } from '@shared/types'

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto'
]

export function supportedClaudePermissionModes(
  advertised: readonly ClaudePermissionMode[] | null | undefined
): ClaudePermissionMode[] {
  return (advertised ?? []).filter(candidate => CLAUDE_PERMISSION_MODES.includes(candidate))
}

export const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  get default() { return t("ui.claude-permission-copy.copy.ask_for_access_3dffe37") },
  get acceptEdits() { return t("ui.claude-permission-copy.copy.auto_approve_edits_e663e0f") },
  get plan() { return t("ui.claude-permission-copy.copy.plan_only_d98936a") },
  get bypassPermissions() { return t("ui.claude-permission-copy.copy.bypass_permissions_8f7a3f7") },
  get dontAsk() { return t("ui.claude-permission-copy.copy.don_t_ask_deny_unapproved_d9751a7") },
  get auto() { return t("ui.claude-permission-copy.copy.automatic_approvals_fb35ba3") }
}

export const CLAUDE_PERMISSION_MODE_HELP: Record<ClaudePermissionMode, string> = {
  get default() { return t("ui.claude-permission-copy.copy.claude_follows_your_claude_code_allow_and__1129434") },
  get acceptEdits() { return t("ui.claude-permission-copy.copy.claude_applies_file_edits_without_promptin_0cbae12") },
  get plan() { return t("ui.claude-permission-copy.copy.claude_can_inspect_and_plan_but_cannot_mak_689c823") },
  get bypassPermissions() { return t("ui.claude-permission-copy.copy.claude_auto_approves_tool_use_except_expli_1d9ebcf") },
  get dontAsk() { return t("ui.claude-permission-copy.copy.claude_never_asks_anything_not_already_all_871a52b") },
  get auto() { return t("ui.claude-permission-copy.copy.claude_s_classifier_approves_or_denies_too_36e162f") }
}
