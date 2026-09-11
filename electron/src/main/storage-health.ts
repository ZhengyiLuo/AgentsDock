import { isStorageFullError } from '../shared/storage-errors'
import { statfsSync } from 'node:fs'

let storageFull = false
const listeners = new Set<() => void>()

export function localStorageWasFull(): boolean { return storageFull }

/** Called only after an explicit user retry has verified a durable write. */
export function clearStorageError(): void { storageFull = false }

/** Latched for this app session: an unrelated successful write cannot prove drafts were saved. */
export function reportStorageError(error: unknown): boolean {
  if (!isStorageFullError(error)) return false
  if (!storageFull) {
    storageFull = true
    for (const listener of listeners) {
      try { listener() } catch { /* A closed renderer must not mask the original I/O failure. */ }
    }
  }
  return true
}

/** SQLite can report CANTOPEN/IOERR before it can identify SQLITE_FULL. */
export function reportStartupStorageError(error: unknown, directory: string): boolean {
  if (reportStorageError(error)) return true
  const sqlite = error as { code?: unknown; errcode?: unknown } | null
  if (sqlite?.code !== 'ERR_SQLITE_ERROR' || typeof sqlite.errcode !== 'number'
    || ![10, 14].includes(sqlite.errcode & 0xff)) return false
  try {
    // One error-path-only filesystem metadata read, never a poll or a scan.
    if (statfsSync(directory).bavail === 0) return reportStorageError({ code: 'ENOSPC' })
  } catch { /* Permission/corruption/unknown I/O failures are not disk-full proof. */ }
  return false
}

export function observeStorageErrors(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
