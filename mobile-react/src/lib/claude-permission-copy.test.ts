import {
  CLAUDE_PERMISSION_MODE_HELP,
  CLAUDE_PERMISSION_MODE_LABELS,
  CLAUDE_PERMISSION_MODES,
} from './claude-permission-copy'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(
  CLAUDE_PERMISSION_MODES.join(',') === 'default,acceptEdits,plan,bypassPermissions,dontAsk,auto',
  'Claude permission modes must match the Mac and SDK order',
)
assert(new Set(Object.values(CLAUDE_PERMISSION_MODE_LABELS)).size === CLAUDE_PERMISSION_MODES.length, 'every mode needs a distinct label')
assert(new Set(Object.values(CLAUDE_PERMISSION_MODE_HELP)).size === CLAUDE_PERMISSION_MODES.length, 'every mode needs distinct help')
assert(CLAUDE_PERMISSION_MODE_HELP.bypassPermissions.includes('explicit deny rules'), 'bypass help must retain deny-rule semantics')
assert(CLAUDE_PERMISSION_MODE_HELP.dontAsk.includes('denied'), 'dontAsk help must explain denial')

console.log('Claude permission copy tests passed')
