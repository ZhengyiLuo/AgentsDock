export interface NativeFileSelectionGateOptions {
  now?: () => number
  ttlMs?: number
  maxTickets?: number
}

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_TICKETS = 512

/**
 * Converts trusted browser file-selection gestures into short-lived, one-use
 * capabilities. The renderer can retain a native File object, so the exposed
 * preload API must not treat every later call with that object as a new user
 * selection.
 */
export class NativeFileSelectionGate {
  private readonly tickets = new Map<string, number[]>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxTickets: number

  constructor(
    private readonly pathForFile: (file: File) => string,
    options: NativeFileSelectionGateOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS)
    this.maxTickets = positiveInteger(options.maxTickets, DEFAULT_MAX_TICKETS)
  }

  authorize(files: FileList | readonly File[] | null | undefined, trusted: boolean): void {
    if (!trusted || !files) return
    const now = this.now()
    this.prune(now)
    let remaining = this.maxTickets - this.ticketCount()
    if (remaining <= 0) return
    for (const file of Array.from(files)) {
      if (remaining <= 0) break
      const path = this.pathForFile(file)
      if (!path) continue
      const key = ticketKey(path, file)
      const expirations = this.tickets.get(key) ?? []
      expirations.push(now + this.ttlMs)
      this.tickets.set(key, expirations)
      remaining -= 1
    }
  }

  consume(file: File): string | null {
    return this.consumeBatch([file])[0]
  }

  consumeBatch(files: readonly File[]): Array<string | null> {
    this.prune(this.now())
    const selections = files.map(file => {
      const path = this.pathForFile(file)
      return { path, key: path ? ticketKey(path, file) : null }
    })
    const required = new Map<string, number>()
    for (const selection of selections) {
      if (!selection.key) continue
      required.set(selection.key, (required.get(selection.key) ?? 0) + 1)
    }
    for (const [key, count] of required) {
      if ((this.tickets.get(key)?.length ?? 0) < count) {
        throw new Error('Choose this file again before uploading it.')
      }
    }
    for (const [key, count] of required) {
      const expirations = this.tickets.get(key)!
      expirations.splice(0, count)
      if (expirations.length) this.tickets.set(key, expirations)
      else this.tickets.delete(key)
    }
    return selections.map(selection => selection.path || null)
  }

  private prune(now: number): void {
    for (const [key, expirations] of this.tickets) {
      const live = expirations.filter(expiresAt => expiresAt > now)
      if (live.length) this.tickets.set(key, live)
      else this.tickets.delete(key)
    }
  }

  private ticketCount(): number {
    let count = 0
    for (const expirations of this.tickets.values()) count += expirations.length
    return count
  }
}

export function nativeFileDropTarget(event: Pick<Event, 'composedPath'>): boolean {
  return event.composedPath().some(target => (
    target instanceof Element
    && (target.classList.contains('chat-workspace') || target.classList.contains('shared-chat-shell'))
  ))
}

export function nativeFilePasteTarget(event: Pick<Event, 'composedPath'>): boolean {
  return event.composedPath().some(target => (
    target instanceof Element && target.classList.contains('composer')
  ))
}

function ticketKey(path: string, file: File): string {
  return JSON.stringify([path, file.name, file.size, file.type, file.lastModified])
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}
