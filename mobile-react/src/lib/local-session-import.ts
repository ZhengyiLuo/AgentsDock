import type {
  Backend,
  BulkImportSessionItem,
  BulkImportSessionResult,
  Health,
  LocalSessionCandidate,
  LocalSessionImportCapability
} from '../types'

export const LOCAL_SESSION_IMPORT_API_CONTRACT_VERSION = 15
export const LOCAL_SESSION_IMPORT_CAPABILITY_VERSION = 1
export const LOCAL_SESSION_IMPORT_HARD_BATCH_LIMIT = 25
export const LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT = 500

const MAX_PROVIDER_SESSION_ID_CHARS = 512
const MAX_PATH_CHARS = 16_384
const MAX_TITLE_CHARS = 500
const MAX_LABEL_CHARS = 2_000
const MAX_TIMESTAMP_CHARS = 100
const MAX_RESULT_CODE_CHARS = 100
const MAX_ERROR_CHARS = 4_000

export function localSessionImportCapability(health: Health | null | undefined): LocalSessionImportCapability | null {
  const capability = health?.capabilities?.local_session_import_v1
  if (
    health?.ok !== true
    || !Number.isInteger(health.api_contract_version)
    || Number(health.api_contract_version) < LOCAL_SESSION_IMPORT_API_CONTRACT_VERSION
    || !isRecord(capability)
    || capability.available !== true
    || typeof capability.required !== 'boolean'
    || typeof capability.message !== 'string'
    || (capability.action !== null && typeof capability.action !== 'string')
    || !Number.isInteger(capability.version)
    || Number(capability.version) < LOCAL_SESSION_IMPORT_CAPABILITY_VERSION
    || !positiveInteger(capability.max_batch_items)
    || !positiveInteger(capability.max_list_items)
  ) return null
  return capability as unknown as LocalSessionImportCapability
}

export function localSessionImportSupported(health: Health | null | undefined): boolean {
  return localSessionImportCapability(health) != null
}

export function requireLocalSessionImportCapability(health: Health | null | undefined): LocalSessionImportCapability {
  const capability = localSessionImportCapability(health)
  if (!capability) {
    throw new Error('Import Chat requires AgentsServer API 15 with local session import support.')
  }
  return capability
}

export function localSessionImportBatchLimit(capability: LocalSessionImportCapability): number {
  return Math.min(capability.max_batch_items, LOCAL_SESSION_IMPORT_HARD_BATCH_LIMIT)
}

export function localSessionImportListLimit(capability: LocalSessionImportCapability): number {
  return Math.min(capability.max_list_items, LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT)
}

export function parseBulkImportSessionItems(value: unknown, maxItems = LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT): BulkImportSessionItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`Import Chat accepts between 1 and ${maxItems} items.`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw invalidInput(`item ${index + 1}`)
    const providerSessionId = requiredString(entry.provider_session_id, MAX_PROVIDER_SESSION_ID_CHARS, `item ${index + 1} provider session ID`)
    const backend = parseBackend(entry.backend, `item ${index + 1} backend`)
    const key = localSessionImportKey(backend, providerSessionId)
    if (seen.has(key)) throw new Error(`Import Chat item ${index + 1} duplicates an earlier provider session.`)
    seen.add(key)
    const cwd = optionalNullableString(entry.cwd, MAX_PATH_CHARS, `item ${index + 1} working directory`)
    const title = optionalNullableString(entry.title, MAX_TITLE_CHARS, `item ${index + 1} title`)
    return {
      provider_session_id: providerSessionId,
      backend,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title } : {})
    }
  })
}

export function parseLocalSessionCandidatesResponse(value: unknown, maxItems = LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT): LocalSessionCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > maxItems) {
    throw new Error('AgentsServer returned an invalid local session list.')
  }
  const seen = new Set<string>()
  return value.sessions.map((entry, index) => {
    if (!isRecord(entry)) throw invalidResponse(`local session ${index + 1}`)
    const providerSessionId = responseString(entry.provider_session_id, MAX_PROVIDER_SESSION_ID_CHARS, `local session ${index + 1} provider ID`)
    const backend = parseBackendResponse(entry.backend, `local session ${index + 1} backend`)
    const key = localSessionImportKey(backend, providerSessionId)
    if (seen.has(key)) throw new Error('AgentsServer returned duplicate local sessions.')
    seen.add(key)
    return {
      provider_session_id: providerSessionId,
      backend,
      label: responseLabel(entry.label, backend, providerSessionId),
      updated_at: responseString(entry.updated_at, MAX_TIMESTAMP_CHARS, `local session ${index + 1} timestamp`),
      cwd: nullableResponseString(entry.cwd, MAX_PATH_CHARS, `local session ${index + 1} working directory`)
    }
  })
}

export function parseBulkImportSessionResultsResponse(
  value: unknown,
  requested: readonly BulkImportSessionItem[]
): BulkImportSessionResult[] {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== requested.length) {
    throw new Error('AgentsServer returned an invalid Import Chat result count.')
  }
  const expected = new Set(requested.map(item => localSessionImportKey(item.backend, item.provider_session_id)))
  const seen = new Set<string>()
  return value.results.map((entry, index) => {
    if (!isRecord(entry)) throw invalidResponse(`import result ${index + 1}`)
    const providerSessionId = responseString(entry.provider_session_id, MAX_PROVIDER_SESSION_ID_CHARS, `import result ${index + 1} provider ID`)
    const backend = parseBackendResponse(entry.backend, `import result ${index + 1} backend`)
    const key = localSessionImportKey(backend, providerSessionId)
    if (!expected.has(key) || seen.has(key)) {
      throw new Error('AgentsServer returned an Import Chat result that does not match the request.')
    }
    seen.add(key)
    if (typeof entry.ok !== 'boolean' || !Number.isInteger(entry.imported) || Number(entry.imported) < 0) {
      throw invalidResponse(`import result ${index + 1}`)
    }
    const ok = entry.ok
    const imported = Number(entry.imported)
    const sessionId = nullableResponseString(entry.session_id, MAX_PROVIDER_SESSION_ID_CHARS, `import result ${index + 1} session ID`)
    const code = optionalResponseString(entry.code, MAX_RESULT_CODE_CHARS, `import result ${index + 1} code`)
    const error = optionalResponseString(entry.error, MAX_ERROR_CHARS, `import result ${index + 1} error`, true)
    if (ok ? imported < 1 || !sessionId : imported !== 0 || sessionId !== null) {
      throw new Error('AgentsServer returned an internally inconsistent Import Chat result.')
    }
    return {
      provider_session_id: providerSessionId,
      backend,
      session_id: sessionId,
      ok,
      imported,
      ...(code !== undefined ? { code } : {}),
      ...(error !== undefined ? { error } : {})
    }
  })
}

export function localSessionImportKey(backend: Backend, providerSessionId: string): string {
  return `${backend}\u0000${providerSessionId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0
}

function parseBackend(value: unknown, field: string): Backend {
  if (value !== 'claude' && value !== 'codex') throw new Error(`Import Chat ${field} is invalid.`)
  return value
}

function parseBackendResponse(value: unknown, field: string): Backend {
  if (value !== 'claude' && value !== 'codex') throw invalidResponse(field)
  return value
}

function requiredString(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value || containsControl(value)) {
    throw new Error(`Import Chat ${field} is invalid.`)
  }
  return value
}

function optionalNullableString(value: unknown, max: number, field: string): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.length > max || containsControl(value)) throw new Error(`Import Chat ${field} is invalid.`)
  return value
}

function responseString(value: unknown, max: number, field: string, allowWhitespace = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || containsControl(value, allowWhitespace)) throw invalidResponse(field)
  return value
}

function responseLabel(value: unknown, backend: Backend, providerSessionId: string): string {
  const fallback = `${backend === 'claude' ? 'Claude' : 'Codex'} chat ${providerSessionId.slice(0, 8)}`
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_LABEL_CHARS
    || containsControl(value, true)
  ) return fallback
  return value
}

function nullableResponseString(value: unknown, max: number, field: string): string | null {
  if (value === null) return null
  return responseString(value, max, field)
}

function optionalResponseString(value: unknown, max: number, field: string, allowWhitespace = false): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max || containsControl(value, allowWhitespace)) throw invalidResponse(field)
  return value
}

function containsControl(value: string, allowWhitespace = false): boolean {
  const pattern = allowWhitespace ? /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/
  return pattern.test(value)
}

function invalidInput(field: string): Error {
  return new Error(`Import Chat ${field} is invalid.`)
}

function invalidResponse(field: string): Error {
  return new Error(`AgentsServer returned an invalid ${field}.`)
}
