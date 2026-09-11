export class SerialWorkQueue {
  private active: WorkEntry | null = null
  private readonly pending: WorkEntry[] = []

  enqueue(start: (finish: () => void) => void): () => void {
    const entry: WorkEntry = { start, finished: false }
    this.pending.push(entry)
    this.drain()
    return () => this.finish(entry)
  }

  private drain(): void {
    if (this.active) return
    let entry = this.pending.shift()
    while (entry?.finished) entry = this.pending.shift()
    if (!entry) return
    this.active = entry
    entry.start(() => this.finish(entry!))
  }

  private finish(entry: WorkEntry): void {
    if (entry.finished) return
    entry.finished = true
    if (this.active === entry) {
      this.active = null
      this.drain()
      return
    }
    const index = this.pending.indexOf(entry)
    if (index >= 0) this.pending.splice(index, 1)
  }
}

interface WorkEntry {
  readonly start: (finish: () => void) => void
  finished: boolean
}
