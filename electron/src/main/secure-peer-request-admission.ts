type Lane = 'json' | 'binary'
type Release = () => void
interface Waiter {
  lane: Lane
  signal: AbortSignal
  resolve: (release: Release) => void
  reject: (reason: unknown) => void
  abort: () => void
}

/** Local admission only: other app processes may still compete for the host's four slots. */
export class SecurePeerRequestAdmission {
  private active = 0
  private binaryActive = 0
  private readonly waiting: Waiter[] = []

  get idle(): boolean { return this.active === 0 && this.waiting.length === 0 }

  async run<T>(lane: Lane, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(lane, signal)
    try {
      signal.throwIfAborted()
      return await operation()
    } finally {
      release()
    }
  }

  private acquire(lane: Lane, signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(signal.reason)
    // At most 32 small JSON bodies, and only four queued 8 MiB attachment chunks.
    if (this.waiting.length >= 32 || (lane === 'binary' && this.waiting.filter(item => item.lane === 'binary').length >= 4)) {
      return Promise.reject(new Error('Too many pending secure peer requests. Let the current requests finish before trying again.'))
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { lane, signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        reject(signal.reason)
        this.drain()
      } }
      this.waiting.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
      else this.drain()
    })
  }

  private drain(): void {
    while (this.active < 4) {
      // FIFO among eligible requests. A busy binary lane must not block JSON
      // controls; once it frees, its oldest waiter competes in original order.
      const index = this.waiting.findIndex(item => item.lane === 'json' || this.binaryActive === 0)
      if (index < 0) return
      const [waiter] = this.waiting.splice(index, 1)
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue }
      this.active += 1
      if (waiter.lane === 'binary') this.binaryActive += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        if (waiter.lane === 'binary') this.binaryActive -= 1
        this.drain()
      })
    }
  }
}
