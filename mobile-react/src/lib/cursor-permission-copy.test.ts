import {
  CURSOR_PERMISSION_MODE_HELP,
  CURSOR_PERMISSION_MODE_LABELS,
  CURSOR_PERMISSION_MODES,
} from './cursor-permission-copy'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(
  CURSOR_PERMISSION_MODES.join(',') === 'default,full_access,plan',
  'Cursor permission modes must match the server contract order',
)
assert(new Set(Object.values(CURSOR_PERMISSION_MODE_LABELS)).size === CURSOR_PERMISSION_MODES.length, 'every mode needs a distinct label')
assert(new Set(Object.values(CURSOR_PERMISSION_MODE_HELP)).size === CURSOR_PERMISSION_MODES.length, 'every mode needs distinct help')

console.log('Cursor permission copy tests passed')
