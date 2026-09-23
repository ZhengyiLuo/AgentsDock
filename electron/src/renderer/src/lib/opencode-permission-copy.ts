import { t } from '@shared/i18n'
import type { OpenCodePermissionMode } from '@shared/types'
export { supportedOpenCodePermissionModes } from '@shared/opencode-permissions'

export const OPENCODE_PERMISSION_MODE_LABELS: Record<OpenCodePermissionMode, string> = {
  get default() { return t('opencode.permissions.default') },
  get full_access() { return t('opencode.permissions.fullAccess') },
  get plan() { return t('opencode.permissions.plan') }
}
export const OPENCODE_PERMISSION_MODE_HELP: Record<OpenCodePermissionMode, string> = {
  get default() { return t('opencode.permissions.defaultHelp') },
  get full_access() { return t('opencode.permissions.fullAccessHelp') },
  get plan() { return t('opencode.permissions.planHelp') }
}
