// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import type { CursorPermissionMode } from '@shared/types'
import { SAFE_CURSOR_PERMISSION_MODES } from '@shared/cursor-permissions'

export const CURSOR_PERMISSION_MODES: CursorPermissionMode[] = [...SAFE_CURSOR_PERMISSION_MODES]

export function supportedCursorPermissionModes(
  advertised: readonly unknown[] | null | undefined
): CursorPermissionMode[] {
  const supported = (advertised ?? []).filter(
    (candidate): candidate is CursorPermissionMode => typeof candidate === 'string'
      && CURSOR_PERMISSION_MODES.includes(candidate as CursorPermissionMode)
  )
  // Older/partial Cursor capability responses did not advertise modes. The
  // only safe compatibility choice is --trust without --force. Cursor's own
  // global/project permission configuration remains authoritative.
  return supported.length > 0 ? supported : ['default']
}

export const CURSOR_PERMISSION_MODE_LABELS: Record<CursorPermissionMode, string> = {
  get default() { return t("ui.cursor-permission-copy.copy.cursor_defaults_a0e7de2") },
  get full_access() { return t("ui.cursor-permission-copy.copy.full_access_f19611c") },
  get plan() { return t("ui.cursor-permission-copy.copy.plan_only_d98936a") }
}

export const CURSOR_PERMISSION_MODE_HELP: Record<CursorPermissionMode, string> = {
  get default() { return t("ui.cursor-permission-copy.copy.uses_cursor_s_configured_permissions_witho_ce265e2") },
  get full_access() { return t("ui.cursor-permission-copy.copy.allows_tools_and_commands_automatically_ex_6de889f") },
  get plan() { return t("ui.cursor-permission-copy.copy.read_only_planning_no_file_edits_or_shell__45546d7") }
}
