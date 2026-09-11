export const DEFAULT_DEFERRED_IMPORT_TIMEOUT_MS = 8_000

/**
 * Bound a Metro dynamic import so a suspended native surface can always fall
 * through to its app-owned error boundary instead of displaying a spinner
 * forever. The underlying import is allowed to settle later, but its result is
 * ignored after the deadline.
 */
export function importWithDeadline<T>(
  load: () => Promise<T>,
  label: string,
  timeoutMs = DEFAULT_DEFERRED_IMPORT_TIMEOUT_MS,
): Promise<T> {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : DEFAULT_DEFERRED_IMPORT_TIMEOUT_MS
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} did not load within ${timeout} ms.`))
    }, timeout)

    Promise.resolve()
      .then(load)
      .then(value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }, cause => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(cause)
      })
  })
}
