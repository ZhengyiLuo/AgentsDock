import { DEFAULT_CODEX_PERMISSION_SETTINGS } from './codex-permissions'

const expected = {
  codex_approval_policy: 'never',
  codex_sandbox_mode: 'danger-full-access',
  codex_permission_profile: null,
  codex_approvals_reviewer: 'user',
}

if (JSON.stringify(DEFAULT_CODEX_PERMISSION_SETTINGS) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected Codex permission defaults: ${JSON.stringify(DEFAULT_CODEX_PERMISSION_SETTINGS)}`)
}

console.log('codex permission default tests passed')
