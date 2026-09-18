import type { CodexAuthStatus } from './types'

export function validateCodexApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('CODEX_AUTH_INVALID_KEY')
  const key = value.trim()
  // Validate shape only. Codex owns authentication; do not assume a key prefix
  // or claim that storing a key verifies API billing/model access.
  if (!key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) {
    throw new Error('CODEX_AUTH_INVALID_KEY')
  }
  return key
}

export function parseCodexAuthStatus(value: unknown): CodexAuthStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_AUTH_RESPONSE')
  const item = value as Record<string, unknown>
  if (typeof item.available !== 'boolean' || typeof item.requires_openai_auth !== 'boolean'
    || typeof item.auth_mode !== 'string' || !['apiKey', 'chatgpt', 'other', 'none'].includes(item.auth_mode)) {
    throw new Error('CODEX_AUTH_RESPONSE')
  }
  const label = (field: string): string | null => {
    const text = item[field]
    if (text == null) return null
    if (typeof text !== 'string' || text.length > 320 || /[\x00-\x1f\x7f]/.test(text)) {
      throw new Error('CODEX_AUTH_RESPONSE')
    }
    return text
  }
  // Pick fields rather than forwarding a provider response, even for errors.
  // In API-key mode there is no email/plan to expose.
  return {
    available: item.available,
    auth_mode: item.auth_mode as CodexAuthStatus['auth_mode'],
    email: item.auth_mode === 'chatgpt' ? label('email') : null,
    plan_type: item.auth_mode === 'chatgpt' ? label('plan_type') : null,
    requires_openai_auth: item.requires_openai_auth,
  }
}
