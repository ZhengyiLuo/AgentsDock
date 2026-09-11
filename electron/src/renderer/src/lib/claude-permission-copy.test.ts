import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PERMISSION_MODE_HELP,
  CLAUDE_PERMISSION_MODE_LABELS,
  CLAUDE_PERMISSION_MODES,
  supportedClaudePermissionModes
} from './claude-permission-copy'

describe('Claude permission copy', () => {
  it('covers every native SDK mode with distinct labels and explanations', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual([
      'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'
    ])
    expect(new Set(Object.values(CLAUDE_PERMISSION_MODE_LABELS)).size).toBe(CLAUDE_PERMISSION_MODES.length)
    expect(new Set(Object.values(CLAUDE_PERMISSION_MODE_HELP)).size).toBe(CLAUDE_PERMISSION_MODES.length)
  })

  it('distinguishes bypassing prompts from denying anything unapproved', () => {
    expect(CLAUDE_PERMISSION_MODE_HELP.bypassPermissions).toContain('auto-approves tool use except explicit deny rules')
    expect(CLAUDE_PERMISSION_MODE_HELP.bypassPermissions).toContain('can still prompt or block')
    expect(CLAUDE_PERMISSION_MODE_HELP.dontAsk).toContain('Anything not already allowed')
    expect(CLAUDE_PERMISSION_MODE_HELP.dontAsk).toContain('denied')
  })

  it('filters provider-advertised modes to controls the app can render', () => {
    expect(supportedClaudePermissionModes(['plan', 'default'])).toEqual(['plan', 'default'])
    expect(supportedClaudePermissionModes(['future-mode' as never, 'auto'])).toEqual(['auto'])
    expect(supportedClaudePermissionModes(null)).toEqual([])
  })
})
