/** Keep native error codes, never error messages, URLs, credentials or bodies. */
export function networkErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== 'object' || depth >= 4) return {}
  const value = error as Record<string, unknown>
  const detail: Record<string, unknown> = {}
  if (typeof value.name === 'string' && ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError'].includes(value.name)) {
    detail.name = value.name
  }
  if (typeof value.code === 'string' && /^(?:E[A-Z0-9_]{1,40}|UND_ERR_[A-Z0-9_]{1,40})$/.test(value.code)) detail.code = value.code
  if (typeof value.syscall === 'string' && ['connect', 'read', 'write', 'getaddrinfo', 'getnameinfo'].includes(value.syscall)) detail.syscall = value.syscall
  if (value.cause) detail.cause = networkErrorDetails(value.cause, depth + 1)
  if (Array.isArray(value.errors)) detail.errors = value.errors.slice(0, 4).map(item => networkErrorDetails(item, depth + 1))
  return detail
}
