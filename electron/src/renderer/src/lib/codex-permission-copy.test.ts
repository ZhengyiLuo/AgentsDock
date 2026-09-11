import { describe, expect, it } from 'vitest'
import {
  CODEX_APPROVAL_PROMPT_LABELS,
  CODEX_APPROVAL_REVIEWER_LABELS,
  codexApprovalPromptHelp,
  codexApprovalReviewerHelp
} from './codex-permission-copy'

describe('Codex permission copy', () => {
  it('explains approval policies without implying that never means approve everything', () => {
    expect(CODEX_APPROVAL_PROMPT_LABELS).toEqual({
      never: 'Never prompt',
      'on-request': 'Ask when more access is needed',
      untrusted: 'Ask before untrusted commands'
    })
    expect(codexApprovalPromptHelp('never', 'workspace-write')).toBe(
      'Codex will not show approval prompts; actions outside the allowed sandbox are rejected.'
    )
    expect(codexApprovalPromptHelp('never', 'danger-full-access')).toBe(
      'Codex can run commands anywhere without prompting.'
    )
    expect(codexApprovalPromptHelp('untrusted', 'workspace-write')).toBe(
      'Only known-safe read-only commands run automatically; other commands require approval.'
    )
  })

  it('clarifies that on-request has little command-level effect with full access', () => {
    expect(codexApprovalPromptHelp('on-request', 'workspace-write')).toBe(
      'Codex asks before it needs to cross the current sandbox boundary.'
    )
    expect(codexApprovalPromptHelp('on-request', 'danger-full-access')).toBe(
      'Commands and files already have full access; Codex only prompts for other eligible actions, such as app or MCP tools.'
    )
  })

  it('labels the current reviewer and keeps the legacy reviewer understandable', () => {
    expect(CODEX_APPROVAL_REVIEWER_LABELS).toEqual({
      user: 'Me (Codex default)',
      auto_review: 'Automatic reviewer',
      guardian_subagent: 'Guardian reviewer (legacy)'
    })
    expect(codexApprovalReviewerHelp('auto_review', 'on-request')).toContain('additional model calls')
    expect(codexApprovalReviewerHelp('auto_review', 'never')).toContain('inactive')
  })
})
