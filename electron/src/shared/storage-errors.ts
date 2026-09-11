/** Only identify actual local storage exhaustion, not arbitrary I/O failures. */
export function isStorageFullError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; errcode?: unknown; name?: unknown; message?: unknown }
  return value.code === 'ENOSPC' || value.code === 'EDQUOT' || value.code === 'SQLITE_FULL'
    || (value.code === 'ERR_SQLITE_ERROR' && value.errcode === 13)
    || value.name === 'QuotaExceededError'
    || (value.code === 'ERR_SQLITE_ERROR' && typeof value.message === 'string' && /database or disk is full/i.test(value.message))
}
