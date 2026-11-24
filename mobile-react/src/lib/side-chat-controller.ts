import { validateSideQuestionInput, type SideQuestionInput, type SyncedSideChat } from './side-chat'

export interface SideChatTransport {
  readSyncedSideChat(sessionId: string): Promise<SyncedSideChat>
  submitSyncedSideChat(sessionId: string, input: SideQuestionInput): Promise<SyncedSideChat>
  stopSyncedSideChat(sessionId: string, requestId: string): Promise<SyncedSideChat>
  clearSyncedSideChat(sessionId: string, sideChatId: string): Promise<SyncedSideChat>
}

export interface SideChatState {
  snapshot: SyncedSideChat | null
  loading: boolean
  mutating: boolean
  error: string | null
}

const initialState: SideChatState = { snapshot: null, loading: false, mutating: false, error: null }
let requestSequence = 0
function newRequestId(): string {
  return `mobile-side-${Date.now().toString(36)}-${(++requestSequence).toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** One visible, verified server/chat scope. The server owns history and provider work. */
export class SideChatController {
  private state: SideChatState = initialState
  private listeners = new Set<() => void>()
  private disposed = false
  private epoch = 0
  private read: Promise<void> | null = null
  private invalidatedDuringRead = false
  private pendingSubmission: SideQuestionInput | null = null

  constructor(
    private readonly transport: SideChatTransport,
    private readonly sessionId: string,
    private readonly isCurrent: () => boolean,
    private readonly questionLimit: number,
    private readonly requestId = newRequestId,
  ) {}

  getSnapshot = (): SideChatState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private current(): boolean { return !this.disposed && this.isCurrent() }
  private update(patch: Partial<SideChatState>): void {
    if (!this.current()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private accept(snapshot: SyncedSideChat): void {
    if (!this.current() || snapshot.session_id !== this.sessionId) return
    // HTTP reads, mutation acknowledgements and WebSocket invalidations race.
    // A clear advances revision too; never restore older history afterwards.
    if (this.state.snapshot && snapshot.revision < this.state.snapshot.revision) return
    this.update({ snapshot })
    if (this.pendingSubmission && (snapshot.side_chat_id !== this.pendingSubmission.side_chat_id
      || snapshot.exchanges.some(exchange => exchange.request_id === this.pendingSubmission?.request_id))) {
      this.pendingSubmission = null
    }
  }

  refresh = (): Promise<void> => {
    if (!this.current()) return Promise.resolve()
    if (this.read) return this.read
    const epoch = this.epoch
    const current = () => this.current() && epoch === this.epoch
    this.update({ loading: true })
    const operation = (async () => {
      try {
        const snapshot = await Promise.resolve().then(() => this.transport.readSyncedSideChat(this.sessionId))
        if (!current()) return
        this.accept(snapshot)
        this.update({ error: null })
      } catch (error) {
        if (current()) this.update({ error: message(error) })
      } finally {
        if (!current()) return
        this.read = null
        this.update({ loading: false })
        // Only a real invalidation arriving during the read requests another
        // read. No idle, per-keystroke or timer polling is introduced.
        if (this.invalidatedDuringRead && this.current()) {
          this.invalidatedDuringRead = false
          void this.refresh()
        }
      }
    })()
    this.read = operation
    return operation
  }

  invalidate = (revision: number): void => {
    if (!this.current() || (this.state.snapshot && revision <= this.state.snapshot.revision)) return
    if (this.read) this.invalidatedDuringRead = true
    else void this.refresh()
  }

  submit = async (question: string): Promise<boolean> => {
    const snapshot = this.state.snapshot
    if (!this.current() || !snapshot || this.state.mutating || this.state.loading
      || snapshot.exchanges.some(exchange => exchange.status === 'running')) return false
    let input: SideQuestionInput
    try {
      input = validateSideQuestionInput({
        request_id: this.requestId(), question, side_chat_id: snapshot.side_chat_id,
        ...(snapshot.last_request_id ? { after_request_id: snapshot.last_request_id } : {}),
      }, this.questionLimit)
      if (this.pendingSubmission) {
        if (this.pendingSubmission.question !== input.question || this.pendingSubmission.side_chat_id !== snapshot.side_chat_id) {
          throw new Error('The previous side reply is unconfirmed. Refresh or retry the same question first.')
        }
        // Explicit retry of an uncertain POST keeps its receipt identity. Never
        // blindly replay a mutation with a new id or copied transcript context.
        input = this.pendingSubmission
      }
    } catch (error) {
      this.update({ error: message(error) })
      return false
    }
    this.pendingSubmission = input
    const epoch = this.epoch
    const current = () => this.current() && epoch === this.epoch
    this.update({ mutating: true, error: null })
    try {
      const next = await this.transport.submitSyncedSideChat(this.sessionId, input)
      if (!current()) return false
      this.accept(next)
      this.pendingSubmission = null
      return true
    } catch (error) {
      if (!current()) return false
      const failure = message(error)
      const status = error && typeof error === 'object' && 'status' in error ? error.status : null
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) this.pendingSubmission = null
      // A timeout can hide an accepted POST. Read once to reconcile, never send
      // again automatically. If still uncertain, a manual retry reuses the id.
      await this.refresh()
      if (!current()) return false
      if (this.state.snapshot?.exchanges.some(exchange => exchange.request_id === input.request_id)) {
        this.pendingSubmission = null
        this.update({ error: null })
        return true
      }
      this.update({ error: failure })
      return false
    } finally {
      if (current()) this.update({ mutating: false })
    }
  }

  stop = async (requestId: string): Promise<void> => {
    if (!this.state.snapshot?.exchanges.some(exchange => exchange.request_id === requestId && exchange.status === 'running')) return
    await this.mutate(() => this.transport.stopSyncedSideChat(this.sessionId, requestId))
  }

  clear = async (): Promise<void> => {
    const snapshot = this.state.snapshot
    if (!snapshot) return
    await this.mutate(() => this.transport.clearSyncedSideChat(this.sessionId, snapshot.side_chat_id))
  }

  private async mutate(operation: () => Promise<SyncedSideChat>): Promise<void> {
    if (!this.current() || this.state.mutating) return
    const epoch = this.epoch
    const current = () => this.current() && epoch === this.epoch
    this.update({ mutating: true, error: null })
    try {
      const snapshot = await operation()
      if (current()) this.accept(snapshot)
    }
    catch (error) {
      if (!current()) return
      const failure = message(error)
      await this.refresh()
      if (current()) this.update({ error: failure })
    } finally { if (current()) this.update({ mutating: false }) }
  }

  activate(): void {
    this.disposed = false
    this.epoch += 1
    this.read = null
    this.invalidatedDuringRead = false
  }

  dispose(): void {
    // Closing/navigating away is not Stop. The server retains the side reply
    // and history, available when this or another client opens it again.
    this.disposed = true
    this.epoch += 1
    this.read = null
    this.state = { ...this.state, loading: false, mutating: false }
    this.listeners.clear()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Side chat could not be updated. Please try again.'
}
