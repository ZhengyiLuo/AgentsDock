import { validateCodexApiKey } from './codex-auth'
import type { CodexProviderConfiguration, CodexProviderInput, CodexProviderModels, CodexProviderTestResult, RuntimeOption } from './types'

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

export function parseCodexProviderConfiguration(value: unknown): CodexProviderConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
  const item = value as Record<string, unknown>
  if (typeof item.available !== 'boolean' || typeof item.configured !== 'boolean'
    || typeof item.has_api_key !== 'boolean' || item.wire_api !== 'responses') throw new Error('CODEX_PROVIDER_RESPONSE')
  try {
    if (!item.configured && (item.base_url !== null || item.model !== null || item.has_api_key)) throw new Error()
    return { available: item.available, configured: item.configured, has_api_key: item.has_api_key,
      base_url: item.configured ? validateCodexProviderURL(item.base_url) : null,
      model: item.configured && item.model != null && item.model !== '' ? modelID(item.model) : null, wire_api: 'responses' }
  } catch { throw new Error('CODEX_PROVIDER_RESPONSE') }
}

export function parseCodexProviderTestResult(value: unknown): CodexProviderTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROVIDER_RESPONSE')
  const item = value as Record<string, unknown>
  if (typeof item.ok !== 'boolean' || typeof item.status !== 'string'
    || !['ready', 'unsupported', 'authentication_failed', 'connection_failed', 'model_unavailable', 'failed'].includes(item.status)
    || item.ok !== (item.status === 'ready')) throw new Error('CODEX_PROVIDER_RESPONSE')
  // Never expose provider text: even a successful HTTP response may echo keys.
  return { ok: item.ok, status: item.status as CodexProviderTestResult['status'], message: '' }
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
  return {
    models: options(item.models), efforts: options(item.efforts), model_efforts: modelEfforts,
    default_model: typeof item.default_model === 'string' ? item.default_model : null,
    default_effort: typeof item.default_effort === 'string' ? item.default_effort : null
  }
}
