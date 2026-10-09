import type { ConnectionProtocol } from '@shared/provider-connections'

type Backend = 'codex' | 'claude' | 'opencode' | 'cursor'
export interface EndpointDraft {
  baseURL: string
  model: string
  protocol: ConnectionProtocol
  authHeader: 'bearer' | 'x-api-key'
}

const pending = new Map<string, { draft: EndpointDraft; timer: ReturnType<typeof setTimeout> }>()
const fallback = new Map<string, EndpointDraft>()
const storageKey = (profileId: string, backend: Backend) => `agentsdock.endpoint-draft.v1:${JSON.stringify([profileId, backend])}`

function safeDraft(value: unknown): EndpointDraft | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.baseURL !== 'string' || item.baseURL.length > 2048 || typeof item.model !== 'string' || item.model.length > 256
    || !['anthropic', 'responses', 'chat_completions', 'cursor'].includes(String(item.protocol))
    || !['bearer', 'x-api-key'].includes(String(item.authHeader))) return null
  // Allow incomplete URL drafts, but never persist credentials embedded in a
  // URL. The server still validates the complete URL on explicit submission.
  const baseURL = /[@?#\x00-\x20\x7f]/.test(item.baseURL.trim()) ? '' : item.baseURL.trim()
  return { baseURL, model: item.model, protocol: item.protocol as ConnectionProtocol,
    authHeader: item.authHeader as EndpointDraft['authHeader'] }
}

export function readEndpointDraft(profileId: string | null, backend: Backend): EndpointDraft | null {
  if (!profileId) return null
  const key = storageKey(profileId, backend)
  try {
    const draft = safeDraft(pending.get(key)?.draft ?? fallback.get(key) ?? JSON.parse(localStorage.getItem(key) ?? 'null'))
    if (!draft || backend === 'codex' && draft.protocol !== 'responses' || backend === 'claude' && draft.protocol !== 'anthropic'
      || (backend === 'cursor') !== (draft.protocol === 'cursor') || draft.protocol !== 'anthropic' && draft.authHeader !== 'bearer') return null
    return draft
  }
  catch { return null }
}

export function flushEndpointDraft(profileId: string | null, backend: Backend): void {
  if (!profileId) return
  const key = storageKey(profileId, backend), value = pending.get(key)
  if (!value) return
  clearTimeout(value.timer)
  pending.delete(key)
  try { localStorage.setItem(key, JSON.stringify(value.draft)); fallback.delete(key) }
  catch {
    fallback.set(key, value.draft)
    while (fallback.size > 64) fallback.delete(fallback.keys().next().value!)
  }
}

export function queueEndpointDraft(profileId: string | null, backend: Backend, value: EndpointDraft): void {
  if (!profileId) return
  const draft = safeDraft(value)
  if (!draft) return
  const key = storageKey(profileId, backend)
  const previous = pending.get(key)
  if (previous) clearTimeout(previous.timer)
  pending.set(key, { draft, timer: setTimeout(() => flushEndpointDraft(profileId, backend), 400) })
}
