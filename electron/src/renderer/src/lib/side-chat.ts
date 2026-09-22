import { sideQuestionLimit, sideQuestionsAvailable, sideQuestionOwnerKey,
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

/** App-owned transient state: hiding the dock does not own or stop requests. */
export class SideChatController {
  private snapshots = new Map<string, SideChatSnapshot>()
  private scopes = new Map<string, SideQuestionScope>()
  private listeners = new Map<string, Set<() => void>>()
  private requests = new Map<string, { scope: SideQuestionScope; sessionId: string; requestId: string }>()
  private detailsOffsets = new Map<string, number>()
  private historyPositions = new Map<string, SideChatScrollPosition>()
  private epoch = 0
  private key(scope: SideQuestionScope, sessionId: string): string { return JSON.stringify([sideQuestionOwnerKey(scope), sessionId]) }

  snapshot(scope: SideQuestionScope, sessionId: string): SideChatSnapshot {
    const key = this.key(scope, sessionId)
    this.scopes.set(key, scope)
    if (!this.snapshots.has(key)) this.snapshots.set(key, emptySnapshot())
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

  async send(scope: SideQuestionScope, session: Session): Promise<void> {
    const api = window.agentsDock.sideQuestions
    const app = useAppStore.getState()
    const snapshot = this.snapshot(scope, session.id)
    const question = snapshot.draft.trim()
    if (!api || window.agentsDock.sharedChat || !this.current(scope) || !app.connected
      || !sideQuestionsAvailable(app.health, session.backend) || snapshot.pending
      || !question || Array.from(question).length > sideQuestionLimit(app.health)) return
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
    const sideChatId = this.snapshot(scope, sessionId).sideChatId
    void this.cancel(scope, sessionId)
    void window.agentsDock.sideQuestions?.close?.(scope, sessionId, sideChatId).catch(() => undefined)
    this.historyPositions.delete(this.key(scope, sessionId))
    this.update(scope, sessionId, () => emptySnapshot())
  }
  reconcileProfiles(profiles: PublicServerProfile[]): void {
    for (const [key, scope] of this.scopes) {
      const profile = profiles.find(profile => profile.id === scope.profileId)
      if (profile && (!scope.serverIdentity || profile.serverIdentity === scope.serverIdentity)) continue
      const [, sessionId] = JSON.parse(key)
      this.clear(scope, sessionId)
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
      void window.agentsDock.sideQuestions?.close?.(this.scopes.get(key)!, sessionId, snapshot.sideChatId).catch(() => undefined)
    }
    this.snapshots.clear()
    this.scopes.clear()
    this.detailsOffsets.clear()
    this.historyPositions.clear()
    for (const request of requests) void window.agentsDock.sideQuestions?.cancel(request.scope, request.sessionId, request.requestId).catch(() => undefined)
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
  }
}
