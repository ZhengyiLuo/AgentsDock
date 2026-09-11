import {
  enumSelectionIndex,
  initialMcpContent,
  jsonIdentity,
  jsonValuesEqual,
  mcpConstraintHints,
  mcpContentIsValid,
  mcpFieldValueIsValid,
  mcpMultiSelectOptions,
  mcpSingleSelectOptions,
  mcpStringMatchesFormat,
  multiSelectionIndices,
  parseMcpNumericDraft,
  toggleMultiSelectValue,
} from './codex-mcp-form'
import type { JsonValue } from '../types'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}

const properties = {
  enabled: { type: 'boolean' },
  channels: {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: {
      anyOf: [
        { const: 'stable', title: 'Stable' },
        { const: { lane: 'preview', region: 'us' }, title: 'Preview US' },
      ],
    },
  },
  retries: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
  label: { type: 'string', minLength: 3, maxLength: 8 },
  email: { type: 'string', format: 'email' },
  endpoint: { type: 'string', format: 'uri' },
  day: { type: 'string', format: 'date' },
  startsAt: { type: 'string', format: 'date-time' },
  copiedDefault: { type: 'array', default: [{ id: 1 }] },
} satisfies Record<string, JsonValue>
const required = new Set(['enabled', 'channels', 'retries', 'label'])
const initial = initialMcpContent(properties, required)

equal(initial.enabled, false, 'required booleans initialize to a sendable false value')
assert(Array.isArray(initial.channels) && initial.channels.length === 0, 'required arrays initialize empty')
equal(initial.retries, 2, 'schema defaults initialize numeric fields')
assert(Array.isArray(initial.copiedDefault), 'array defaults initialize')
;(initial.copiedDefault as JsonValue[]).push({ id: 2 })
equal((properties.copiedDefault.default as JsonValue[]).length, 1, 'mutable defaults are cloned from the schema')
assert(!mcpContentIsValid(properties, required, initial), 'minimum items and missing required text keep initial content invalid')

const complete = {
  ...initial,
  channels: [{ region: 'us', lane: 'preview' }],
  label: 'release',
}
assert(mcpContentIsValid(properties, required, complete), 'structurally equal JSON enum values validate regardless of object key order')
assert(!mcpContentIsValid(properties, required, { ...complete, channels: [] }), 'minItems is enforced')
assert(!mcpContentIsValid(properties, required, { ...complete, channels: ['stable', { lane: 'preview', region: 'us' }, 'extra'] }), 'maxItems is enforced')
assert(!mcpContentIsValid(properties, required, { ...complete, extra: true }), 'unrequested content is rejected')
assert(!mcpContentIsValid(properties, new Set(['missing']), { missing: 'value' }), 'required keys absent from the schema fail closed')

assert(mcpFieldValueIsValid({ type: 'boolean' }, false, true), 'false satisfies a required boolean')
assert(!mcpFieldValueIsValid({ type: 'string' }, '', true), 'empty text does not satisfy a required field')
assert(!mcpFieldValueIsValid({ type: 'string', minLength: 3 }, 'hi', false), 'minLength is enforced')
assert(!mcpFieldValueIsValid({ type: 'string', maxLength: 3 }, 'long', false), 'maxLength is enforced')
assert(mcpFieldValueIsValid({ type: 'integer', minimum: -2, maximum: 2 }, -1, true), 'bounded integers accept an in-range integer')
assert(!mcpFieldValueIsValid({ type: 'integer', minimum: -2, maximum: 2 }, 1.5, true), 'integer fields reject fractions')
assert(!mcpFieldValueIsValid({ type: 'number', minimum: 0, maximum: 1 }, 2, true), 'numeric maximum is enforced')
equal(parseMcpNumericDraft('-', 'number'), undefined, 'an incomplete negative number stays invalid while editing')
equal(parseMcpNumericDraft('1.', 'number'), undefined, 'an incomplete decimal stays invalid while editing')
equal(parseMcpNumericDraft('-1.25', 'number'), -1.25, 'negative decimals parse once complete')
equal(parseMcpNumericDraft('.5e2', 'number'), 50, 'scientific decimal notation parses once complete')
equal(parseMcpNumericDraft('-12', 'integer'), -12, 'negative integers parse once complete')
equal(parseMcpNumericDraft('1.5', 'integer'), undefined, 'integer drafts reject fractions')

const singleOptions = mcpSingleSelectOptions({
  oneOf: [
    { const: { kind: 'fast' }, title: 'Fast mode' },
    { const: false, title: 'Disabled' },
  ],
})
equal(singleOptions[0]?.label, 'Fast mode', 'oneOf titles become single-select labels')
equal(enumSelectionIndex(singleOptions.map(option => option.value), { kind: 'fast' }), 0, 'single selects use JSON identity rather than reference equality')

const duplicateOptions = mcpSingleSelectOptions({ enum: [{ value: 1 }, { value: 1 }] })
equal(duplicateOptions.length, 2, 'duplicate enum values remain addressable by their option index')
equal(enumSelectionIndex(duplicateOptions.map(option => option.value), { value: 1 }), 0, 'duplicate JSON values resolve deterministically')
equal(jsonIdentity({ b: 2, a: 1 }), jsonIdentity({ a: 1, b: 2 }), 'JSON identity is stable across object key order')
assert(jsonValuesEqual({ nested: [{ b: 2, a: 1 }] }, { nested: [{ a: 1, b: 2 }] }), 'nested JSON equality is structural')

const multiOptions = mcpMultiSelectOptions(properties.channels as Record<string, JsonValue>)
equal(multiOptions.length, 2, 'items.anyOf becomes a multi-select')
equal(multiOptions[1]?.label, 'Preview US', 'items.anyOf titles are retained')
const selected = toggleMultiSelectValue([], multiOptions[1].value)
equal(multiSelectionIndices(multiOptions, selected).join(','), '1', 'multi-select indices use JSON identity')
equal(toggleMultiSelectValue(selected, { region: 'us', lane: 'preview' }).length, 0, 'toggling a structural JSON match removes it')
equal(mcpMultiSelectOptions({ type: 'array', items: { enum: ['a', 'b'] } }).length, 2, 'items.enum becomes a multi-select')

assert(mcpStringMatchesFormat('person@example.com', 'email'), 'valid email accepted')
assert(!mcpStringMatchesFormat('person@localhost', 'email'), 'invalid email rejected')
assert(mcpStringMatchesFormat('https://example.com/path', 'uri'), 'absolute URI accepted')
assert(!mcpStringMatchesFormat('not a uri', 'uri'), 'invalid URI rejected')
assert(mcpStringMatchesFormat('2028-02-29', 'date'), 'valid leap date accepted')
assert(!mcpStringMatchesFormat('2027-02-29', 'date'), 'invalid calendar date rejected')
assert(mcpStringMatchesFormat('2026-07-28T12:34:56Z', 'date-time'), 'RFC3339 UTC date-time accepted')
assert(mcpStringMatchesFormat('2026-07-28T12:34:56-07:00', 'date-time'), 'RFC3339 offset date-time accepted')
assert(!mcpStringMatchesFormat('2027-02-29T12:34:56Z', 'date-time'), 'date-time rejects an invalid calendar date')
assert(!mcpStringMatchesFormat('2026-07-28 12:34:56', 'date-time'), 'date-time requires the RFC3339 separator and zone')

equal(
  mcpConstraintHints({ minItems: 1, maxItems: 2, minLength: 3, maxLength: 8, minimum: 0, maximum: 10, format: 'email' }).length,
  7,
  'all supported schema constraints are surfaced to the user',
)

console.log('Codex MCP form parity checks passed')
