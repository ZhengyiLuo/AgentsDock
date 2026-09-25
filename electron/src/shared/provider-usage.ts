import type { ProfileEventContext } from './types'

export type UsageBackend = 'codex' | 'claude'
export type ProviderUsageScope = ProfileEventContext

export interface ProviderUsageWindow {
  id: string
  label: string | null
  used_percent: number | null
  resets_at: number | null
  window_minutes: number | null
  observed_at: string
  status?: 'allowed' | 'allowed_warning' | 'rejected'
}

/** Provider-reported account allowance; separate from a chat's context or token count. */
export interface ProviderUsageSnapshot {
  backend: UsageBackend
  status: 'available' | 'unavailable'
  source: 'codex-account' | 'claude-events' | null
  observed_at: string | null
  account_kind: 'chatgpt' | 'subscription' | 'api_key' | 'custom' | 'unknown'
  windows: ProviderUsageWindow[]
  credits?: { balance: string | null; has_credits: boolean; unlimited: boolean }
  reason?: string
}

export function parseProviderUsage(value: unknown, backend: UsageBackend): ProviderUsageSnapshot {
  const data = value as ProviderUsageSnapshot | null
  if (!data || data.backend !== backend || !['available', 'unavailable'].includes(data.status)
    || !Array.isArray(data.windows)
    || !data.windows.every(window => window && typeof window.id === 'string'
      && (window.used_percent === null || (typeof window.used_percent === 'number' && Number.isFinite(window.used_percent)))
      && (window.resets_at === null || (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at)))
      && typeof window.observed_at === 'string')
    || (data.credits !== undefined && (!data.credits || typeof data.credits.has_credits !== 'boolean'
      || typeof data.credits.unlimited !== 'boolean'
      || (data.credits.balance !== null && typeof data.credits.balance !== 'string')))) {
    throw new Error('Invalid provider usage response')
  }
  return data
}

export function providerUsageRemaining(usage: ProviderUsageSnapshot): number | null {
  const values = usage.windows.flatMap(window => window.used_percent === null ? [] : [Math.max(0, Math.min(100, 100 - window.used_percent))])
  return values.length ? Math.min(...values) : null
}
