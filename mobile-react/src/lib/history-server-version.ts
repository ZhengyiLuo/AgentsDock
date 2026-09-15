import type { Snapshot } from '../types'

/** Never purge content or fan an upgrade out to unopened chats. */
export function historyNeedsServerRevalidation(snapshot: Snapshot | undefined, version: string | null): boolean {
  return Boolean(snapshot && version && snapshot.verifiedServerVersion !== version)
}
