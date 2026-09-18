import { validateCodexApiKey } from './codex-auth'
import type { CodexProviderConfiguration, CodexProviderInput, CodexProviderTestResult } from './types'

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
    return { base_url: validateCodexProviderURL(input.base_url), model: modelID(input.model), api_key: validateCodexApiKey(input.api_key) }
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
      model: item.configured ? modelID(item.model) : null, wire_api: 'responses' }
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
