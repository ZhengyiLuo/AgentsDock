import type { JsonValue } from '../types'

export interface McpSelectOption {
  value: JsonValue
  label: string
}

export function initialMcpContent(
  properties: Record<string, JsonValue>,
  required: ReadonlySet<string>,
): Record<string, JsonValue> {
  const content: Record<string, JsonValue> = {}
  for (const [name, rawDefinition] of Object.entries(properties)) {
    const definition = recordValue(rawDefinition)
    if (
      Object.prototype.hasOwnProperty.call(definition, 'default')
      && definition.default !== null
      && definition.default !== undefined
    ) {
      content[name] = cloneJsonValue(definition.default)
      continue
    }
    if (required.has(name) && stringValue(definition.type) === 'boolean') {
      content[name] = false
    } else if (required.has(name) && stringValue(definition.type) === 'array') {
      content[name] = []
    }
  }
  return content
}

export function mcpContentIsValid(
  properties: Record<string, JsonValue>,
  required: ReadonlySet<string>,
  content: Record<string, JsonValue>,
): boolean {
  for (const name of required) {
    if (
      !Object.prototype.hasOwnProperty.call(properties, name)
      || !Object.prototype.hasOwnProperty.call(content, name)
    ) return false
  }
  return Object.entries(content).every(([name, value]) => (
    Object.prototype.hasOwnProperty.call(properties, name)
    && mcpFieldValueIsValid(recordValue(properties[name]), value, required.has(name))
  ))
}

export function mcpFieldValueIsValid(
  definition: Record<string, JsonValue>,
  value: JsonValue | undefined,
  required: boolean,
): boolean {
  if (value === undefined) return !required

  const type = stringValue(definition.type)
  const singleOptions = mcpSingleSelectOptions(definition)
  if (singleOptions.length > 0 && !singleOptions.some(option => jsonValuesEqual(option.value, value))) {
    return false
  }

  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (type === 'integer' && !Number.isInteger(value)) return false
    const minimum = finiteNumber(definition.minimum)
    const maximum = finiteNumber(definition.maximum)
    return (minimum === undefined || value >= minimum)
      && (maximum === undefined || value <= maximum)
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false
    const options = mcpMultiSelectOptions(definition)
    if (options.length > 0 && value.some(item => (
      !options.some(option => jsonValuesEqual(option.value, item))
    ))) {
      return false
    }
    const minItems = nonNegativeInteger(definition.minItems)
    const maxItems = nonNegativeInteger(definition.maxItems)
    return (minItems === undefined || value.length >= minItems)
      && (maxItems === undefined || value.length <= maxItems)
  }

  if (!type && singleOptions.length > 0) return true
  if (type && type !== 'string') return false
  if (typeof value !== 'string') return false
  if (required && value.length === 0) return false
  const minLength = nonNegativeInteger(definition.minLength)
  const maxLength = nonNegativeInteger(definition.maxLength)
  if (minLength !== undefined && value.length < minLength) return false
  if (maxLength !== undefined && value.length > maxLength) return false
  return mcpStringMatchesFormat(value, stringValue(definition.format))
}

export function mcpSingleSelectOptions(definition: Record<string, JsonValue>): McpSelectOption[] {
  const titled = arrayValue(definition.oneOf).flatMap(rawOption => {
    const option = recordValue(rawOption)
    if (!Object.prototype.hasOwnProperty.call(option, 'const')) return []
    return [{
      value: option.const,
      label: stringValue(option.title) || jsonValueLabel(option.const),
    }]
  })
  if (titled.length > 0) return titled

  const values = arrayValue(definition.enum)
  const names = arrayValue(definition.enumNames)
  return values.map((value, index) => ({
    value,
    label: typeof names[index] === 'string' ? names[index] : jsonValueLabel(value),
  }))
}

export function mcpMultiSelectOptions(definition: Record<string, JsonValue>): McpSelectOption[] {
  if (stringValue(definition.type) !== 'array') return []
  const items = recordValue(definition.items)
  const titled = arrayValue(items.anyOf).flatMap(rawOption => {
    const option = recordValue(rawOption)
    if (!Object.prototype.hasOwnProperty.call(option, 'const')) return []
    return [{
      value: option.const,
      label: stringValue(option.title) || jsonValueLabel(option.const),
    }]
  })
  if (titled.length > 0) return titled
  return arrayValue(items.enum).map(value => ({ value, label: jsonValueLabel(value) }))
}

export function enumSelectionIndex(options: readonly JsonValue[], selected: JsonValue | undefined): number {
  if (selected === undefined) return -1
  return options.findIndex(option => jsonValuesEqual(option, selected))
}

export function multiSelectionIndices(
  options: readonly McpSelectOption[],
  selected: JsonValue | undefined,
): number[] {
  if (!Array.isArray(selected)) return []
  return options.flatMap((option, index) => (
    selected.some(value => jsonValuesEqual(value, option.value)) ? [index] : []
  ))
}

export function toggleMultiSelectValue(
  selected: JsonValue | undefined,
  option: JsonValue,
): JsonValue[] {
  const values = Array.isArray(selected) ? selected : []
  if (values.some(value => jsonValuesEqual(value, option))) {
    return values.filter(value => !jsonValuesEqual(value, option))
  }
  return [...values, option]
}

export function jsonIdentity(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(item => jsonIdentity(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${jsonIdentity(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

export function jsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return jsonIdentity(left) === jsonIdentity(right)
}

export function mcpStringMatchesFormat(value: string, format: string): boolean {
  if (!format || !value) return true
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'uri') {
    try {
      return Boolean(new URL(value).protocol)
    } catch {
      return false
    }
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }
  if (format === 'date-time') {
    return DATE_TIME_PATTERN.test(value)
      && mcpStringMatchesFormat(value.slice(0, 10), 'date')
      && Number.isFinite(Date.parse(value))
  }
  return true
}

export function parseMcpNumericDraft(value: string, type: 'number' | 'integer'): number | undefined {
  const pattern = type === 'integer' ? INTEGER_PATTERN : NUMBER_PATTERN
  if (!pattern.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function mcpConstraintHints(definition: Record<string, JsonValue>): string[] {
  const minItems = nonNegativeInteger(definition.minItems)
  const maxItems = nonNegativeInteger(definition.maxItems)
  const minLength = nonNegativeInteger(definition.minLength)
  const maxLength = nonNegativeInteger(definition.maxLength)
  const minimum = finiteNumber(definition.minimum)
  const maximum = finiteNumber(definition.maximum)
  return [
    minItems !== undefined ? `Choose at least ${minItems}` : '',
    maxItems !== undefined ? `Choose at most ${maxItems}` : '',
    minLength !== undefined ? `Minimum ${minLength} characters` : '',
    maxLength !== undefined ? `Maximum ${maxLength} characters` : '',
    minimum !== undefined ? `Minimum ${minimum}` : '',
    maximum !== undefined ? `Maximum ${maximum}` : '',
    stringValue(definition.format) ? `Format: ${stringValue(definition.format)}` : '',
  ].filter(Boolean)
}

export function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function nonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]))
  }
  return value
}

function jsonValueLabel(value: JsonValue): string {
  return typeof value === 'string' ? value : jsonIdentity(value)
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const DATE_TIME_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const INTEGER_PATTERN = /^[+-]?\d+$/
const NUMBER_PATTERN = /^[+-]?(?:\d+|\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/
