// Bounded, in-memory best-effort delivery. Never persist events or block UI/quit.
// Retries reuse the entire original envelope (including time and $insert_id).
export interface AnalyticsEnvelope {
  event: string
  properties: Record<string, string | boolean | number>
}

const ENDPOINT = 'https://api.mixpanel.com/track?ip=0&verbose=1'
const CAPACITY = 100
const CONCURRENCY = 8
const MAX_ATTEMPTS = 3
const MAX_AGE_MS = 30 * 60_000
interface Entry { payload: AnalyticsEnvelope; created: number; attempts: number; next: number; active: boolean }

export class AnalyticsDelivery {
  private entries = new Set<Entry>()
  private controllers = new Set<AbortController>()
  private timer: number | undefined
  private revision = 0
  constructor(private readonly surface: Window, private readonly enabled: () => boolean) {}

  enqueue(payload: AnalyticsEnvelope): void {
    if (this.entries.size >= CAPACITY) return
    const now = this.surface.performance.now()
    this.entries.add({ payload, created: now, attempts: 0, next: now, active: false })
    this.flush()
  }

  clear(): void {
    this.revision++
    this.entries.clear()
    if (this.timer !== undefined) this.surface.clearTimeout(this.timer)
    this.timer = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  listen(): () => void {
    const online = () => this.flush()
    // Pending requests already use keepalive. Flush waiting entries once on
    // page exit; no beacon (which cannot enforce credentials/referrer policy).
    const exit = () => this.flush(true)
    this.surface.addEventListener('online', online)
    this.surface.addEventListener('pagehide', exit)
    return () => {
      this.surface.removeEventListener('online', online)
      this.surface.removeEventListener('pagehide', exit)
    }
  }

  flush(exiting = false): void {
    if (!this.enabled()) { this.clear(); return }
    if (this.timer !== undefined) this.surface.clearTimeout(this.timer)
    this.timer = undefined
    const now = this.surface.performance.now()
    for (const entry of this.entries) {
      if (!entry.active && now - entry.created >= MAX_AGE_MS) this.entries.delete(entry)
    }
    if (this.surface.navigator.onLine === false) return
    for (const entry of this.entries) {
      if (this.controllers.size >= CONCURRENCY) break
      if (!entry.active && (exiting || entry.next <= now)) void this.send(entry)
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== undefined || this.controllers.size >= CONCURRENCY || this.surface.navigator.onLine === false) return
    const pending = [...this.entries].filter(entry => !entry.active)
    if (!pending.length) return
    // Retries/expiry are durations, not calendar dates. NTP/manual clock
    // changes must not freeze delivery or expire a fresh event. The payload's
    // original wall-clock timestamp is unchanged.
    const delay = Math.max(0, Math.min(...pending.map(entry => entry.next)) - this.surface.performance.now())
    this.timer = this.surface.setTimeout(() => { this.timer = undefined; this.flush() }, delay)
  }

  private async send(entry: Entry): Promise<void> {
    const revision = this.revision
    const controller = new AbortController()
    this.controllers.add(controller)
    entry.active = true
    entry.attempts++
    const timeout = this.surface.setTimeout(() => controller.abort(), 10_000)
    let retry = false
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([entry.payload]), credentials: 'omit',
        referrerPolicy: 'no-referrer', signal: controller.signal, keepalive: true
      })
      if (response.ok) {
        // HTTP 200 is not acceptance: Mixpanel can reply with status:0.
        const body = await response.text()
        const decoded: unknown = JSON.parse(body)
        const accepted = decoded === 1 || (typeof decoded === 'object' && decoded !== null && 'status' in decoded && decoded.status === 1)
        // An explicit rejection is permanent. Do not retry bad payloads/tokens.
        retry = !accepted && decoded !== 0 && !(typeof decoded === 'object' && decoded !== null && 'status' in decoded && decoded.status === 0)
      } else {
        retry = [408, 429, 500, 502, 503, 504].includes(response.status)
      }
    } catch {
      retry = true
    } finally {
      this.surface.clearTimeout(timeout)
      this.controllers.delete(controller)
      if (revision !== this.revision) return
      entry.active = false
      if (!retry || entry.attempts >= MAX_ATTEMPTS || this.surface.performance.now() - entry.created >= MAX_AGE_MS) this.entries.delete(entry)
      else entry.next = this.surface.performance.now() + 1_000 * 4 ** (entry.attempts - 1) + Math.floor(Math.random() * 250)
      // Do not synchronously send other requests from a completion callback.
      this.schedule()
    }
  }
}
