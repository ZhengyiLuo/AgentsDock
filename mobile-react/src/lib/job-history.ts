/**
 * A stable job ID is enough to ask the server for authoritative run history.
 * Local compact timeline rows may contain only the latest run, so a zero local
 * count must not hide or disable history discovery.
 */
export function canQueryScheduledJobHistory(jobId: string | null | undefined): jobId is string {
  return typeof jobId === 'string' && Boolean(jobId.trim())
}
