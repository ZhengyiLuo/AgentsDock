// Inspect locally, emit only a bounded enum. Never return an error/message/URL.
export const ANALYTICS_FAILURE_CATEGORIES = ['not_found', 'authentication', 'scope_changed', 'download', 'native_open', 'network', 'timeout', 'unavailable', 'unknown'] as const
export type AnalyticsFailureCategory = typeof ANALYTICS_FAILURE_CATEGORIES[number]

export function analyticsFailureCategory(error: unknown): AnalyticsFailureCategory {
  const value = error instanceof Error ? error.message : ''
  if (/Native file open failed:/i.test(value)) return 'native_open'
  if (/active server changed|server connection changed|stale (?:profile|connection)|profile scope|Server profile switch superseded/i.test(value)) return 'scope_changed'
  if (/(?:failed[: (]+|HTTP\s+|status[: =]+)(?:401|403)\b|unauthorized|authentication required|invalid access token/i.test(value)) return 'authentication'
  if (/(?:failed[: (]+|HTTP\s+|status[: =]+)404\b/i.test(value)) return 'not_found'
  if (/timed?\s*out|ETIMEDOUT|TimeoutError/i.test(value)) return 'timeout'
  if (/Download failed|Linked file failed/i.test(value)) return 'download'
  if (/Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network error/i.test(value)) return 'network'
  if (/Server health check reported unavailable/i.test(value)) return 'unavailable'
  return 'unknown'
}
