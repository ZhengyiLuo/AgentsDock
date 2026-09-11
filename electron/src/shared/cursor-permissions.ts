import type { CursorPermissionMode } from './types'

export const SAFE_CURSOR_PERMISSION_MODES: readonly CursorPermissionMode[] = [
  'default',
  'full_access',
  'plan'
]

/** Normalize stale or untrusted persisted values to Cursor's least-privileged edit mode. */
export function normalizeCursorPermissionMode(value: unknown): CursorPermissionMode {
  return typeof value === 'string'
    && SAFE_CURSOR_PERMISSION_MODES.includes(value as CursorPermissionMode)
    ? value as CursorPermissionMode
    : 'default'
}
