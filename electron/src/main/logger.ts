import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024
let cachedPath: string | null = null

export function appLog(scope: string, message: string, data?: unknown): void {
  try {
    const path = logPath()
    rotate(path)
    const suffix = data === undefined ? '' : ` ${safeJSON(data)}`
    appendFileSync(path, `${new Date().toISOString()} [${scope}] ${message}${suffix}\n`, 'utf8')
  } catch { /* logging must never affect the app */ }
}

export function currentLogPath(): string { return logPath() }

function logPath(): string {
  if (cachedPath) return cachedPath
  cachedPath = join(app.getPath('userData'), 'logs', 'agentsdock.log')
  mkdirSync(dirname(cachedPath), { recursive: true })
  return cachedPath
}

function rotate(path: string): void {
  if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return
  const previous = `${path}.1`
  try { renameSync(path, previous) } catch { /* the active log remains usable */ }
}

function safeJSON(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === 'string' && item.length > 1200 ? `${item.slice(0, 1200)}…` : item) }
  catch { return String(value) }
}
