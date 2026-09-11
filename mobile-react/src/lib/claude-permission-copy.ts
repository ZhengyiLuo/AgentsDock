import type { ClaudePermissionMode } from '../types'

export const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]

export const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  default: 'Ask for access',
  acceptEdits: 'Auto-approve edits',
  plan: 'Plan only',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask; deny unapproved",
  auto: 'Automatic approvals',
}

export const CLAUDE_PERMISSION_MODE_HELP: Record<ClaudePermissionMode, string> = {
  default: 'Claude follows your Claude Code allow and deny rules and asks in AgentsDock when more access is needed.',
  acceptEdits: 'Claude applies file edits without prompting and still asks for other restricted tools.',
  plan: 'Claude can inspect and plan but cannot make changes or run execution tools.',
  bypassPermissions: 'Claude auto-approves tool use except explicit deny rules. Interaction-required tools and AgentsDock hooks can still prompt or block.',
  dontAsk: 'Claude never asks. Anything not already allowed by your rules is denied.',
  auto: "Claude's classifier approves or denies tool requests automatically.",
}
