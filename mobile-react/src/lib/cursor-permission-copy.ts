import type { CursorPermissionMode } from '../types'

export const CURSOR_PERMISSION_MODES: CursorPermissionMode[] = [
  'default',
  'full_access',
  'plan',
]

export function supportedCursorPermissionModes(advertised: readonly unknown[] | null | undefined): CursorPermissionMode[] {
  const supported = (advertised ?? []).filter(
    (candidate): candidate is CursorPermissionMode => typeof candidate === 'string'
      && CURSOR_PERMISSION_MODES.includes(candidate as CursorPermissionMode),
  )
  return supported.length ? supported : ['default']
}

export const CURSOR_PERMISSION_MODE_LABELS: Record<CursorPermissionMode, string> = {
  default: 'Cursor defaults',
  full_access: 'Full access',
  plan: 'Plan only',
}

export const CURSOR_PERMISSION_MODE_HELP: Record<CursorPermissionMode, string> = {
  default: 'Uses Cursor’s configured permissions without forcing tools or shell commands.',
  full_access: 'Allows tools and commands automatically except operations explicitly denied by Cursor configuration.',
  plan: 'Read-only planning: no file edits or shell commands.',
}
