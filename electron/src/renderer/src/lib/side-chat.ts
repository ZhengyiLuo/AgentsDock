import { sideChatSyncAvailable, type SyncedSideChat, sideQuestionLimit, sideQuestionsAvailable, sideQuestionOwnerKey,
  SIDE_QUESTION_MAX_HISTORY_CHARS, SIDE_QUESTION_MAX_HISTORY_ITEMS,
  type SideQuestionHistoryItem, type SideQuestionScope } from '@shared/side-questions'
import type { PublicServerProfile, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'

export interface SideChatExchange {
  id: string
  question: string
  answer?: string
  state: 'pending' | 'answered' | 'cancelled' | 'error'
  error?: string
}
export interface SideChatSnapshot {
  sideChatId: string
  synced?: boolean
  connectionGeneration?: number
  revision?: number
  loading?: boolean
  lastRequestId?: string
  draft: string
  exchanges: SideChatExchange[]
  pending: string | null
  contextNote: string
  historyOmitted: boolean
  error: string | null
}
export interface SideChatScrollPosition {
  scrollTop: number
  atBottom: boolean
}
const emptySnapshot = (): SideChatSnapshot => ({ sideChatId: crypto.randomUUID(), draft: '', exchanges: [], pending: null, contextNote: '', historyOmitted: false, error: null })

export function sideChatHistory(exchanges: SideChatExchange[], maxItems = SIDE_QUESTION_MAX_HISTORY_ITEMS,
  maxChars = SIDE_QUESTION_MAX_HISTORY_CHARS): { history: SideQuestionHistoryItem[]; omitted: boolean } {
  const answered = exchanges.filter(item => item.state === 'answered' && item.answer !== undefined)
  const history: SideQuestionHistoryItem[] = []
  let chars = 0
  for (const exchange of [...answered].reverse()) {
    const pairChars = Array.from(exchange.question).length + Array.from(exchange.answer!).length
    if (history.length + 2 > maxItems || chars + pairChars > maxChars) break
    history.unshift({ role: 'user', text: exchange.question }, { role: 'assistant', text: exchange.answer! })
    chars += pairChars
  }
  return { history, omitted: history.length < answered.length * 2 }
}

/** Server-owned history when supported; old servers retain their transient path. */
export class SideChatController {
  private snapshots = new Map<string, SideChatSnapshot>()
  private scopes = new Map<string, SideQuestionScope>()
  private listeners = new Map<string, Set<() => void>>()
  private requests = new Map<string, { scope: SideQuestionScope; sessionId: string; requestId: string }>()
  private detailsOffsets = new Map<string, number>()
  private historyPositions = new Map<string, SideChatScrollPosition>()
  private reads = new Map<string, { promise: Promise<void>; dirty: boolean; generation: number }>()
  private optimistic = new Map<string, { requestId: string; sideChatId: string; accepted?: Promise<SyncedSideChat> }>()
  private clearing = new Set<string>()
  private epoch = 0
  private key(scope: SideQuestionScope, sessionId: string): string { return JSON.stringify([sideQuestionOwnerKey(scope), sessionId]) }

  snapshot(scope: SideQuestionScope, sessionId: string): SideChatSnapshot {
    const key = this.key(scope, sessionId)
    this.scopes.set(key, scope)
    if (!this.snapshots.has(key)) this.snapshots.set(key, emptySnapshot())
    const snapshot = this.snapshots.get(key)!
    // The same verified server can be revisited with changed credentials.
    // Reauthorize history before displaying a previous connection's data.
    if (snapshot.synced && snapshot.connectionGeneration !== scope.profileGeneration) {
      this.snapshots.set(key, { ...emptySnapshot(), synced: true, loading: true, connectionGeneration: scope.profileGeneration })
      this.optimistic.delete(key)
    }
    return this.snapshots.get(key)!
  }
  subscribe(scope: SideQuestionScope, sessionId: string, listener: () => void): () => void {
    const key = this.key(scope, sessionId)
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key) }
  }
  private update(scope: SideQuestionScope, sessionId: string, update: (state: SideChatSnapshot) => SideChatSnapshot): void {
    const key = this.key(scope, sessionId)
    this.snapshots.set(key, update(this.snapshot(scope, sessionId)))
    for (const listener of this.listeners.get(key) ?? []) listener()
  }
  setDraft(scope: SideQuestionScope, sessionId: string, draft: string): void { this.update(scope, sessionId, state => ({ ...state, draft })) }
  detailsScroll(scope: SideQuestionScope, sessionId: string): number { return this.detailsOffsets.get(this.key(scope, sessionId)) ?? 0 }
  saveDetailsScroll(scope: SideQuestionScope, sessionId: string, offset: number): void { this.detailsOffsets.set(this.key(scope, sessionId), offset) }
  historyScroll(scope: SideQuestionScope, sessionId: string): SideChatScrollPosition | undefined {
    return this.historyPositions.get(this.key(scope, sessionId))
  }
  saveHistoryScroll(scope: SideQuestionScope, sessionId: string, sideChatId: string, position: SideChatScrollPosition): void {
    const key = this.key(scope, sessionId)
    // A closing view must not restore the position of a cleared conversation.
    if (this.snapshots.get(key)?.sideChatId !== sideChatId) return
    this.historyPositions.set(key, position)
  }
  private current(scope: SideQuestionScope): boolean {
    const state = useAppStore.getState()
    return state.activeProfileId === scope.profileId && state.profileGeneration === scope.profileGeneration && !state.switchingProfileId
      && (!scope.serverIdentity || state.profiles.find(profile => profile.id === scope.profileId)?.serverIdentity === scope.serverIdentity)
  }

  /** Opening and reconnecting reconcile once; pushes invalidate without polling. */
  connect(scope: SideQuestionScope, session: Session): () => void {
    if (!sideChatSyncAvailable(useAppStore.getState().health) || !window.agentsDock.sideQuestions?.read) return () => undefined
    void this.refresh(scope, session.id)
    const owned = (event: { profileId: string; profileGeneration: number; sessionId: string }) =>
      event.profileId === scope.profileId && event.profileGeneration === scope.profileGeneration && event.sessionId === session.id && this.current(scope)
    const changed = window.agentsDock.events?.on('side-chat:changed', event => {
      if (owned(event) && event.revision > (this.snapshot(scope, session.id).revision ?? -1)) void this.refresh(scope, session.id)
    })
    const app = useAppStore.getState()
    let live = (app.syncBySession[session.id]?.status
      ?? (app.syncSessionId === session.id ? app.syncStatus : undefined)) === 'live'
    const reconnected = window.agentsDock.events?.on('server:sync', event => {
      if (!owned(event)) return
      const wasLive = live
      live = event.state === 'live'
      // Main-process health/activity notices repeat the existing live state.
      // Only a stream transition can have missed an invalidation and needs GET.
      if (live && !wasLive) void this.refresh(scope, session.id)
    })
    return () => { changed?.(); reconnected?.() }
  }

  async refresh(scope: SideQuestionScope, sessionId: string): Promise<void> {
    const read = window.agentsDock.sideQuestions?.read
    if (!read || !this.current(scope) || !sideChatSyncAvailable(useAppStore.getState().health)) return
    const key = this.key(scope, sessionId)
    const existing = this.reads.get(key)
    if (existing?.generation === scope.profileGeneration) { existing.dirty = true; return existing.promise }
    const epoch = this.epoch
    this.update(scope, sessionId, state => ({ ...state, synced: true, connectionGeneration: scope.profileGeneration, loading: state.revision === undefined, error: null }))
    const record = { promise: Promise.resolve(), dirty: false, generation: scope.profileGeneration }
    const current = () => this.epoch === epoch && this.current(scope) && this.reads.get(key) === record
    record.promise = (async () => {
      do {
        record.dirty = false
        try {
          const snapshot = await read(scope, sessionId)
          if (!current()) return
          this.applySynced(scope, sessionId, snapshot)
        } catch {
          if (current()) this.update(scope, sessionId, state => ({ ...state, loading: false, error: 'side_chat_sync_failed' }))
          return
        }
      } while (record.dirty && current())
    })().finally(() => { if (this.reads.get(key) === record) this.reads.delete(key) })
    this.reads.set(key, record)
    return record.promise
  }

  private applySynced(scope: SideQuestionScope, sessionId: string, chat: SyncedSideChat): void {
    const key = this.key(scope, sessionId)
    const before = this.snapshot(scope, sessionId)
    if (chat.session_id !== sessionId || chat.revision < (before.revision ?? -1)) return
    const optimistic = this.optimistic.get(key)
    const exchanges: SideChatExchange[] = chat.exchanges.map(item => ({ id: item.request_id, question: item.question,
      answer: item.answer, state: item.status === 'running' ? 'pending' : item.status === 'completed' ? 'answered'
        : item.status === 'cancelled' ? 'cancelled' : 'error',
      error: item.status === 'interrupted' ? 'side_question_interrupted' : item.error }))
    // A read dispatched before POST acceptance may not contain our optimistic
    // question. A newer clear is authoritative and must not be resurrected.
    if (optimistic && chat.side_chat_id === optimistic.sideChatId && !exchanges.some(item => item.id === optimistic.requestId)) {
      const pending = before.exchanges.find(item => item.id === optimistic.requestId)
      if (pending) exchanges.push(pending)
    }
    if (chat.side_chat_id !== before.sideChatId) this.historyPositions.delete(key)
    this.update(scope, sessionId, state => ({ ...state, synced: true, loading: false, revision: chat.revision,
      sideChatId: chat.side_chat_id, lastRequestId: chat.last_request_id ?? undefined, exchanges,
      pending: exchanges.find(item => item.state === 'pending')?.id ?? null, error: null,
      contextNote: chat.exchanges.findLast(item => item.context_note)?.context_note ?? '' }))
  }

  private async sendSynced(scope: SideQuestionScope, session: Session, question: string): Promise<void> {
    const api = window.agentsDock.sideQuestions
    if (!api?.submit) return
    const before = this.snapshot(scope, session.id)
    const key = this.key(scope, session.id)
    if (before.revision === undefined || this.clearing.has(key)) return
    const epoch = this.epoch
    const requestId = crypto.randomUUID()
    this.optimistic.set(key, { requestId, sideChatId: before.sideChatId })
    this.update(scope, session.id, state => ({ ...state, draft: '', pending: requestId, error: null,
      exchanges: [...state.exchanges, { id: requestId, question, state: 'pending' }] }))
    try {
      const accepted = api.submit(scope, session.id, { request_id: requestId, question, side_chat_id: before.sideChatId,
        ...(before.lastRequestId ? { after_request_id: before.lastRequestId } : {}) })
      this.optimistic.get(key)!.accepted = accepted
      const result = await accepted
      if (this.epoch !== epoch || !this.current(scope)) return
      this.optimistic.delete(key)
      this.applySynced(scope, session.id, result)
    } catch (cause) {
      if (this.epoch !== epoch || !this.current(scope)) return
      this.optimistic.delete(key)
      const error = cause instanceof Error ? cause.message : String(cause)
      this.update(scope, session.id, state => ({ ...state, pending: null,
        exchanges: state.exchanges.map(item => item.id === requestId && item.state === 'pending' ? { ...item, state: 'error', error } : item) }))
      // The acknowledgement can be lost after server acceptance. Reconcile
      // once instead of resending and risking a duplicate provider request.
      await this.refresh(scope, session.id)
      if (this.epoch === epoch && this.current(scope) && !this.snapshot(scope, session.id).exchanges.some(item => item.id === requestId)) {
        this.update(scope, session.id, state => ({ ...state, draft: state.draft || question, error }))
      }
    } finally {
      if (this.optimistic.get(key)?.requestId === requestId) this.optimistic.delete(key)
    }
  }

  async send(scope: SideQuestionScope, session: Session): Promise<void> {
    const api = window.agentsDock.sideQuestions
    const app = useAppStore.getState()
    const snapshot = this.snapshot(scope, session.id)
    const question = snapshot.draft.trim()
    if (!api || window.agentsDock.sharedChat || !this.current(scope) || !app.connected
      || !sideQuestionsAvailable(app.health, session.backend) || snapshot.pending
      || !question || Array.from(question).length > sideQuestionLimit(app.health)) return
    if (sideChatSyncAvailable(app.health)) { await this.sendSynced(scope, session, question); return }
    const requestId = crypto.randomUUID()
    const key = this.key(scope, session.id)
    const epoch = this.epoch
    this.requests.set(key, { scope, sessionId: session.id, requestId })
    this.update(scope, session.id, state => ({ ...state, draft: '', pending: requestId, error: null,
      historyOmitted: false, exchanges: [...state.exchanges, { id: requestId, question, state: 'pending' }] }))
    const current = () => this.epoch === epoch && this.requests.get(key)?.requestId === requestId
    try {
      const answer = await api.ask(scope, session.id, { request_id: requestId, question, side_chat_id: snapshot.sideChatId,
        ...(snapshot.lastRequestId ? { after_request_id: snapshot.lastRequestId } : {}) })
      if (!current()) return
      if (answer.request_id !== requestId || answer.session_id !== session.id || answer.backend !== session.backend) throw new Error('side_question_invalid_response')
      this.update(scope, session.id, state => ({ ...state, pending: null, lastRequestId: requestId, contextNote: answer.context_note ?? state.contextNote,
        exchanges: state.exchanges.map(item => item.id === requestId ? { ...item, state: 'answered', answer: answer.answer } : item) }))
    } catch (cause) {
      if (!current()) return
      const error = cause instanceof Error ? cause.message : String(cause)
      this.update(scope, session.id, state => ({ ...state, pending: null,
        exchanges: state.exchanges.map(item => item.id === requestId ? { ...item, state: 'error', error } : item) }))
    } finally {
      if (this.requests.get(key)?.requestId === requestId) this.requests.delete(key)
    }
  }

  async cancel(scope: SideQuestionScope, sessionId: string): Promise<void> {
    const key = this.key(scope, sessionId)
    if (this.snapshot(scope, sessionId).synced) {
      const requestId = this.snapshot(scope, sessionId).pending
      if (!requestId || !this.current(scope)) return
      const epoch = this.epoch
      try {
        // Stop pressed immediately after Send must follow POST acceptance,
        // otherwise DELETE could arrive before the request exists remotely.
        await this.optimistic.get(key)?.accepted?.catch(() => undefined)
        if (this.epoch !== epoch || !this.current(scope)) return
        const result = await window.agentsDock.sideQuestions?.stop?.(scope, sessionId, requestId)
        if (result && this.epoch === epoch && this.current(scope)) this.applySynced(scope, sessionId, result)
      } catch {
        if (this.epoch === epoch && this.current(scope)) this.update(scope, sessionId, state => ({ ...state, error: 'side_question_cancel_failed' }))
      }
      return
    }
    const request = this.requests.get(key)
    if (!request) return
    this.requests.delete(key)
    this.update(scope, sessionId, state => ({ ...state, pending: null,
      exchanges: state.exchanges.map(item => item.id === request.requestId ? { ...item, state: 'cancelled' } : item) }))
    const epoch = this.epoch
    try { await window.agentsDock.sideQuestions?.cancel(request.scope, sessionId, request.requestId) }
    catch {
      if (this.epoch !== epoch || !this.snapshots.has(key)) return
      this.update(scope, sessionId, state => ({ ...state,
        exchanges: state.exchanges.map(item => item.id === request.requestId && item.state === 'cancelled'
          ? { ...item, state: 'error', error: 'side_question_cancel_failed' } : item) }))
    }
  }
  clear(scope: SideQuestionScope, sessionId: string): void {
    const snapshot = this.snapshot(scope, sessionId)
    const sideChatId = snapshot.sideChatId
    if (snapshot.synced) { void this.clearSynced(scope, sessionId); return }
    void this.cancel(scope, sessionId)
    void window.agentsDock.sideQuestions?.close?.(scope, sessionId, sideChatId).catch(() => undefined)
    this.historyPositions.delete(this.key(scope, sessionId))
    this.update(scope, sessionId, () => emptySnapshot())
  }
  private async clearSynced(scope: SideQuestionScope, sessionId: string): Promise<void> {
    const key = this.key(scope, sessionId)
    const api = window.agentsDock.sideQuestions
    if (!api?.clear || !this.current(scope) || this.clearing.has(key)) return
    const snapshot = this.snapshot(scope, sessionId)
    if (snapshot.revision === undefined) return
    const epoch = this.epoch
    this.clearing.add(key)
    // Clear the draft at the user's action boundary. Anything typed while the
    // server closes the previous conversation belongs to the next one.
    this.update(scope, sessionId, state => ({ ...state, draft: '' }))
    try {
      const result = await api.clear(scope, sessionId, snapshot.sideChatId)
      if (this.epoch !== epoch || !this.current(scope)) return
      this.optimistic.delete(key)
      this.applySynced(scope, sessionId, result)
    } catch {
      if (this.epoch === epoch && this.current(scope)) {
        await this.refresh(scope, sessionId)
        if (this.epoch !== epoch || !this.current(scope)) return
        this.update(scope, sessionId, state => ({ ...state, error: 'side_chat_sync_failed' }))
      }
    } finally { this.clearing.delete(key) }
  }
  reconcileProfiles(profiles: PublicServerProfile[]): void {
    for (const [key, scope] of this.scopes) {
      const profile = profiles.find(profile => profile.id === scope.profileId)
      if (profile && (!scope.serverIdentity || profile.serverIdentity === scope.serverIdentity)) continue
      const [, sessionId] = JSON.parse(key)
      if (!this.snapshots.get(key)?.synced) this.clear(scope, sessionId)
      this.optimistic.delete(key)
      this.reads.delete(key)
      this.snapshots.delete(key)
      this.scopes.delete(key)
      this.detailsOffsets.delete(key)
      this.historyPositions.delete(key)
    }
  }
  reset(): void {
    this.epoch += 1
    const requests = [...this.requests.values()]
    this.requests.clear()
    for (const [key, snapshot] of this.snapshots) {
      const [, sessionId] = JSON.parse(key)
      if (!snapshot.synced) void window.agentsDock.sideQuestions?.close?.(this.scopes.get(key)!, sessionId, snapshot.sideChatId).catch(() => undefined)
    }
    this.snapshots.clear()
    this.reads.clear()
    this.optimistic.clear()
    this.clearing.clear()
    this.scopes.clear()
    this.detailsOffsets.clear()
    this.historyPositions.clear()
    for (const request of requests) void window.agentsDock.sideQuestions?.cancel(request.scope, request.sessionId, request.requestId).catch(() => undefined)
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
  }
}
