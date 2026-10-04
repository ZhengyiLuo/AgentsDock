import type { AgentServerClient } from './server-client'
import { sideQuestionOwnerKey } from '../shared/side-questions'
import type { SideQuestionAnswer, SideQuestionCancellation, SideQuestionInput, SideQuestionScope } from '../shared/side-questions'

interface PendingSideQuestion {
  scope: SideQuestionScope
  sessionId: string
  requestId: string
  controller: AbortController
  client?: AgentServerClient
  cancelled: boolean
  cancellation?: Promise<SideQuestionCancellation>
  sideChatId?: string
  conversation?: NativeSideConversation
}

interface NativeSideConversation {
  scope: SideQuestionScope
  sessionId: string
  sideChatId: string
  client: AgentServerClient
  closing?: Promise<void>
}

/** Owns only transient side-question transports; no session/cache/event writes. */
export class SideQuestionRequests {
  private pending = new Map<string, PendingSideQuestion>()
  private conversations = new Map<string, NativeSideConversation>()

  async ask(scope: SideQuestionScope, sessionId: string, input: SideQuestionInput,
    prepare: () => Promise<AgentServerClient>, isCurrent: () => boolean): Promise<SideQuestionAnswer> {
    const key = this.key(scope, sessionId, input.request_id)
    if (this.pending.has(key)) throw new Error('side_question_duplicate')
    const request: PendingSideQuestion = {
      scope, sessionId, requestId: input.request_id, controller: new AbortController(), cancelled: false, sideChatId: input.side_chat_id
    }
    this.pending.set(key, request)
    try {
      request.client = await prepare()
      if (request.cancelled || !isCurrent()) throw new Error('side_question_cancelled')
      if (input.side_chat_id) {
        const conversationKey = this.key(scope, sessionId, input.side_chat_id)
        const existing = this.conversations.get(conversationKey)
        if (existing?.closing) throw new Error('side_question_cancelled')
        if (existing) {
          if (request.client !== existing.client) request.client.dispose()
          request.client = existing.client
          request.conversation = existing
        } else {
          request.conversation = { scope, sessionId, sideChatId: input.side_chat_id, client: request.client }
          this.conversations.set(conversationKey, request.conversation)
        }
      }
      const answer = await request.client.askSideQuestion(sessionId, input, request.controller.signal)
      // Selection only authorizes dispatch. The captured server still owns a
      // submitted answer while another profile is visible.
      if (request.cancelled) throw new Error('side_question_cancelled')
      return answer
    } finally {
      // Cancellation uses its own captured server client, including after a
      // profile switch. Keep it alive until that exact DELETE has completed.
      await request.cancellation?.catch(() => undefined)
      if (!request.conversation) request.client?.dispose()
      this.pending.delete(key)
    }
  }

  cancel(scope: SideQuestionScope, sessionId: string, requestId: string): Promise<SideQuestionCancellation> {
    const request = this.pending.get(this.key(scope, sessionId, requestId))
    if (!request) return Promise.resolve({ request_id: requestId, status: 'not_found' })
    if (request.cancellation) return request.cancellation
    request.cancelled = true
    request.cancellation = (request.client
      ? request.client.cancelSideQuestion(sessionId, requestId)
      : Promise.resolve({ request_id: requestId, status: 'cancelled' as const }))
      .finally(() => request.controller.abort())
    return request.cancellation
  }

  cancelAll(): void {
    for (const request of this.pending.values()) {
      void this.cancel(request.scope, request.sessionId, request.requestId).catch(() => undefined)
    }
    for (const conversation of this.conversations.values()) {
      void this.close(conversation.scope, conversation.sessionId, conversation.sideChatId).catch(() => undefined)
    }
  }

  cancelProfile(profileId: string): void {
    for (const request of this.pending.values()) {
      if (request.scope.profileId === profileId) void this.cancel(request.scope, request.sessionId, request.requestId).catch(() => undefined)
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.scope.profileId === profileId) void this.close(conversation.scope, conversation.sessionId, conversation.sideChatId).catch(() => undefined)
    }
  }

  async close(scope: SideQuestionScope, sessionId: string, sideChatId: string): Promise<void> {
    const key = this.key(scope, sessionId, sideChatId)
    const conversation = this.conversations.get(key)
    if (conversation?.closing) return conversation.closing
    const cancelPending = () => Promise.all([...this.pending.values()]
      .filter(request => request.sessionId === sessionId && request.sideChatId === sideChatId
        && sideQuestionOwnerKey(request.scope) === sideQuestionOwnerKey(scope))
      .map(request => this.cancel(request.scope, sessionId, request.requestId).catch(() => undefined)))
    if (!conversation) { await cancelPending(); return }
    conversation.closing = (async () => {
      try {
        await cancelPending()
        await conversation.client.closeSideChat(sessionId, sideChatId)
      } finally {
        conversation.client.dispose()
        if (this.conversations.get(key) === conversation) this.conversations.delete(key)
      }
    })()
    return conversation.closing
  }

  private key(scope: SideQuestionScope, sessionId: string, requestId: string): string {
    return JSON.stringify([sideQuestionOwnerKey(scope), sessionId, requestId])
  }
}
