import type { OpenCodePermissionMode } from './types'

export const OPENCODE_PERMISSION_MODES: readonly OpenCodePermissionMode[] = ['default', 'full_access', 'plan']

/** Default retains native OpenCode policy; it is not a no-shell sandbox. */
export function normalizeOpenCodePermissionMode(value: unknown): OpenCodePermissionMode {
  return typeof value === 'string' && OPENCODE_PERMISSION_MODES.includes(value as OpenCodePermissionMode)
    ? value as OpenCodePermissionMode : 'default'
}

export function supportedOpenCodePermissionModes(advertised: readonly unknown[] | null | undefined): OpenCodePermissionMode[] {
  const modes = OPENCODE_PERMISSION_MODES.filter(mode => advertised?.includes(mode))
  return modes.length ? modes : ['default']
}
