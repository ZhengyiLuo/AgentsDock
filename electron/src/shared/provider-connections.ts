import { validateCodexProviderURL } from './codex-provider'
import { validateCodexApiKey } from './codex-auth'

export type ConnectionBackend = 'claude' | 'opencode'
export type ConnectionAction = 'get' | 'save' | 'check' | 'forget'
export type ConnectionProtocol = 'anthropic' | 'chat_completions' | 'responses'
export type ConnectionResult = 'verified' | 'authentication_failed' | 'rate_limited' | 'unsupported' | 'connection_failed' | 'invalid_response'
export interface ProviderConnectionInput {
  base_url: string; api_key: string; model: string; protocol: ConnectionProtocol
  auth_header: 'bearer' | 'x-api-key'; expected_revision: number
}
export interface ProviderConnectionConfiguration {
  backend: ConnectionBackend; scope: 'settings_only'; revision: number; configured: boolean; has_api_key: boolean
  base_url: string | null; model: string | null; protocol: ConnectionProtocol | null
  auth_header: 'bearer' | 'x-api-key' | null; checked_at: string | null; last_result: ConnectionResult | null
}
export interface ProviderConnectionReply {
  configuration?: ProviderConnectionConfiguration; ok?: boolean; status?: ConnectionResult
}
export type ProviderConnectionRequest = ProviderConnectionInput | { expected_revision: number }
const results: ConnectionResult[] = ['verified', 'authentication_failed', 'rate_limited', 'unsupported', 'connection_failed', 'invalid_response']
function invalid(): never { throw new Error('PROVIDER_CONNECTION_INVALID') }
export function connectionBackend(value: unknown): ConnectionBackend {
  if (value !== 'claude' && value !== 'opencode') return invalid()
  return value
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) return invalid()
  return Number(value)
}
function fields(backend: ConnectionBackend, input: Record<string, unknown>) {
  const base_url = validateCodexProviderURL(input.base_url)
  if (/\/messages\/?$/i.test(base_url) || typeof input.model !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(input.model.trim())) return invalid()
  const protocol = input.protocol as ConnectionProtocol, auth_header = input.auth_header as ProviderConnectionInput['auth_header']
  if (!['anthropic', 'chat_completions', 'responses'].includes(protocol) || backend === 'claude' && protocol !== 'anthropic'
    || !['bearer', 'x-api-key'].includes(auth_header) || protocol !== 'anthropic' && auth_header !== 'bearer') return invalid()
  return { base_url, model: input.model.trim(), protocol, auth_header }
}
export function connectionRequest(backend: ConnectionBackend, action: ConnectionAction, value?: unknown): ProviderConnectionRequest | undefined {
  connectionBackend(backend)
  if (!['get', 'save', 'check', 'forget'].includes(action)) return invalid()
  if (action === 'get') { if (value !== undefined) return invalid(); return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  try {
    const expected_revision = revision(input.expected_revision)
    if (action !== 'save') {
      if (Object.keys(input).length !== 1) return invalid()
      return { expected_revision }
    }
    if (Object.keys(input).sort().join() !== 'api_key,auth_header,base_url,expected_revision,model,protocol') return invalid()
    return { ...fields(backend, input), api_key: validateCodexApiKey(input.api_key), expected_revision }
  } catch { return invalid() }
}
export function parseConnection(backend: ConnectionBackend, value: unknown): ProviderConnectionConfiguration {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const item = value as Record<string, unknown>
    if (item.backend !== backend || item.scope !== 'settings_only' || typeof item.configured !== 'boolean'
      || item.has_api_key !== item.configured) return invalid()
    const common = { backend, scope: 'settings_only' as const, revision: revision(item.revision), configured: item.configured, has_api_key: item.configured }
    if (!item.configured) {
      if (['base_url', 'model', 'protocol', 'auth_header', 'checked_at', 'last_result'].some(key => item[key] !== null)) return invalid()
      return { ...common, base_url: null, model: null, protocol: null, auth_header: null, checked_at: null, last_result: null }
    }
    if (!results.includes(item.last_result as ConnectionResult) || typeof item.checked_at !== 'string'
      || item.checked_at.length > 40 || !Number.isFinite(Date.parse(item.checked_at))) return invalid()
    return { ...common, ...fields(backend, item), checked_at: item.checked_at, last_result: item.last_result as ConnectionResult }
  } catch { throw new Error('PROVIDER_CONNECTION_RESPONSE') }
}
export function parseConnectionReply(backend: ConnectionBackend, action: ConnectionAction, value: unknown): ProviderConnectionReply {
  if (action === 'get' || action === 'forget') return { configuration: parseConnection(backend, value) }
  if (!value || typeof value !== 'object') throw new Error('PROVIDER_CONNECTION_RESPONSE')
  const item = value as Record<string, unknown>
  if (!results.includes(item.status as ConnectionResult) || item.ok !== (item.status === 'verified')
    || item.ok && !item.configuration || action === 'check' && !item.configuration) throw new Error('PROVIDER_CONNECTION_RESPONSE')
  const configuration = item.configuration ? parseConnection(backend, item.configuration) : undefined
  if (configuration && (!configuration.configured || configuration.last_result !== item.status)) throw new Error('PROVIDER_CONNECTION_RESPONSE')
  return { ok: item.ok as boolean, status: item.status as ConnectionResult, ...(configuration ? { configuration } : {}) }
}
