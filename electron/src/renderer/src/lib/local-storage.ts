import { isStorageFullError } from '@shared/storage-errors'
import { secureRandomUUID } from './browser-crypto'

let warningPending = false

/** Optional UI layout persistence must never throw from a React updater. */
export function saveLocalStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) }
  catch (error) {
    if (isStorageFullError(error) && !warningPending) {
      warningPending = true
      queueMicrotask(() => {
        warningPending = false
        window.dispatchEvent(new Event('agentsdock:storage-full'))
      })
    }
  }
}

export function verifyLocalStorageWritable(): void {
  const key = `agentsdock:storage-probe:${secureRandomUUID()}`
  window.localStorage.setItem(key, '1')
  window.localStorage.removeItem(key)
}
