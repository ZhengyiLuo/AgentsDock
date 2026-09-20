import { validateCodexApiKey } from './codex-auth'
import type { CodexProviderConfiguration, CodexProviderInput, CodexProviderModelTestInput, CodexProviderModels, CodexProviderTestResult, RuntimeModelCapability, RuntimeOption } from './types'

export function validateCodexProviderSelection(value: unknown): 'default' | 'custom' | undefined {
  if (value === undefined || value === 'default' || value === 'custom') return value
  throw new Error('Invalid Codex endpoint selection.')
}

export function validateCodexProviderURL(value: unknown): string {
  if (typeof value !== 'string') throw new Error('CODEX_PROVIDER_INVALID')
  const text = value.trim()
  if (!text || text.length > 2048 || /[^\x21-\x7e]|\\/.test(text)) throw new Error('CODEX_PROVIDER_INVALID')
  let url: URL
  try { url = new URL(text) } catch { throw new Error('CODEX_PROVIDER_INVALID') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || /\/(?:responses|chat\/completions)\/?$/i.test(url.pathname)) throw new Error('CODEX_PROVIDER_INVALID')
  return url.toString().replace(/\/+$/, '')
}

function modelID(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256
    || /[^\x21-\x7e]/.test(value.trim())) throw new Error('CODEX_PROVIDER_INVALID')
  return value.trim()
}

export function validateCodexProviderInput(value: unknown): CodexProviderInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_INVALID')
  const input = value as Record<string, unknown>
  try {
    return { base_url: validateCodexProviderURL(input.base_url),
      ...(input.model == null || input.model === '' ? {} : { model: modelID(input.model) }),
      api_key: validateCodexApiKey(input.api_key) }
  } catch { throw new Error('CODEX_PROVIDER_INVALID') }
}

export function validateCodexProviderModelTestInput(value: unknown): CodexProviderModelTestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_INVALID')
  const input = value as Record<string, unknown>
  if (input.credential_id !== undefined && (typeof input.credential_id !== 'string' || !/^[a-f0-9]{32}$/.test(input.credential_id))) throw new Error('CODEX_PROVIDER_INVALID')
  if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.session_id))) throw new Error('CODEX_PROVIDER_INVALID')
  return { model: modelID(input.model), ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
    ...(input.credential_id !== undefined ? { credential_id: input.credential_id } : {}) }
}

export function parseCodexProviderConfiguration(value: unknown): CodexProviderConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
  const item = value as Record<string, unknown>
  if (typeof item.available !== 'boolean' || typeof item.configured !== 'boolean'
    || typeof item.has_api_key !== 'boolean' || item.wire_api !== 'responses') throw new Error('CODEX_PROVIDER_RESPONSE')
  try {
    if (!item.configured && (item.base_url !== null || item.model !== null || item.has_api_key)) throw new Error()
    return { available: item.available, configured: item.configured, has_api_key: item.has_api_key,
      base_url: item.configured ? validateCodexProviderURL(item.base_url) : null,
      model: item.configured && item.model != null && item.model !== '' ? modelID(item.model) : null, wire_api: 'responses',
      ...(typeof item.credential_id === 'string' && /^[a-f0-9]{32}$/.test(item.credential_id) ? { credential_id: item.credential_id } : {}) }
  } catch { throw new Error('CODEX_PROVIDER_RESPONSE') }
}

export function parseCodexProviderTestResult(value: unknown): CodexProviderTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
  const item = value as Record<string, unknown>
  if (typeof item.ok !== 'boolean' || typeof item.status !== 'string'
    || !['ready', 'unsupported', 'unsupported_parameter', 'inconclusive', 'authentication_failed', 'connection_failed', 'model_unavailable', 'failed'].includes(item.status)
    || item.ok !== (item.status === 'ready')) throw new Error('CODEX_PROVIDER_RESPONSE')
  // Never expose provider text: even a successful HTTP response may echo keys.
  const checks = item.checks as Record<string, unknown> | undefined
  return { ok: item.ok, status: item.status as CodexProviderTestResult['status'], message: '',
    ...(typeof item.model === 'string' ? { model: modelID(item.model) } : {}),
    ...(['unverified', 'verified', 'unsupported'].includes(String(item.compatibility))
      ? { compatibility: item.compatibility as CodexProviderTestResult['compatibility'] } : {}),
    ...(item.scope === 'isolated_native_tools_and_continuation' ? { scope: item.scope } : {}),
    ...(checks && ['native_tool_call', 'tool_roundtrip', 'continuation'].every(key => typeof checks[key] === 'boolean')
      ? { checks: { native_tool_call: checks.native_tool_call as boolean, tool_roundtrip: checks.tool_roundtrip as boolean, continuation: checks.continuation as boolean } } : {}) }
}

export function parseCodexProviderModels(value: unknown): CodexProviderModels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
  const item = value as Record<string, unknown>
  function options(value: unknown): RuntimeOption[] {
    if (!Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
    return value.map(option => {
      if (!option || typeof option !== 'object' || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('CODEX_PROVIDER_RESPONSE')
      return { value: option.value, label: option.label }
    })
  }
  const modelEfforts: Record<string, RuntimeOption[]> = Object.create(null)
  if (item.model_efforts && typeof item.model_efforts === 'object' && !Array.isArray(item.model_efforts)) {
    for (const [model, values] of Object.entries(item.model_efforts)) modelEfforts[model] = options(values)
  }
  const capabilities: Record<string, RuntimeModelCapability> = Object.create(null)
  if (item.model_capabilities !== undefined) {
    if (!item.model_capabilities || typeof item.model_capabilities !== 'object' || Array.isArray(item.model_capabilities)) throw new Error('CODEX_PROVIDER_RESPONSE')
    for (const [model, raw] of Object.entries(item.model_capabilities)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CODEX_PROVIDER_RESPONSE')
      const cap = raw as Record<string, unknown>
      if (!['chat', 'unknown'].includes(String(cap.kind)) || !['unverified', 'verified', 'unsupported'].includes(String(cap.compatibility))
        || !Array.isArray(cap.reasoning_efforts) || !cap.reasoning_efforts.every(value => typeof value === 'string')
        || !(cap.reasoning_supported === null || typeof cap.reasoning_supported === 'boolean')) throw new Error('CODEX_PROVIDER_RESPONSE')
      capabilities[model] = { kind: cap.kind as RuntimeModelCapability['kind'], compatibility: cap.compatibility as RuntimeModelCapability['compatibility'],
        reasoning_efforts: cap.reasoning_efforts as string[], reasoning_supported: cap.reasoning_supported as boolean | null }
    }
  }
  return {
    models: options(item.models), efforts: options(item.efforts), model_efforts: modelEfforts,
    ...(item.model_capabilities !== undefined ? { model_capabilities: capabilities } : {}),
    default_model: typeof item.default_model === 'string' ? item.default_model : null,
    default_effort: typeof item.default_effort === 'string' ? item.default_effort : null
  }
}
