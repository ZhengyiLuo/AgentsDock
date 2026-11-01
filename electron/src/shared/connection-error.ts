/** IPC preserves error text, not custom Error prototypes. Match only known
 * transport/validation failures, never provider login or arbitrary run errors. */
export function isServerConnectionError(message: string | null | undefined): boolean {
  const detail = (message ?? '').replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error|TypeError):\s*/, '').trim()
  return /^(?:fetch failed|Failed to fetch|Network request failed)(?:\.|$)/i.test(detail)
    || /^(?:TimeoutError: )?The operation was aborted due to timeout\.?$/.test(detail)
    || detail === 'The server profile has not passed its identity check.'
}
