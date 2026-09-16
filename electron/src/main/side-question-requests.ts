import type { AgentServerClient } from './server-client'
import type { SideQuestionAnswer, SideQuestionCancellation, SideQuestionInput, SideQuestionScope } from '../shared/side-questions'

interface PendingSideQuestion {
  scope: SideQuestionScope
  sessionId: string
  requestId: string
  controller: AbortController
  client?: AgentServerClient
  cancelled: boolean
  cancellation?: Promise<SideQuestionCancellation>
}

/** Owns only transient side-question transports; no session/cache/event writes. */
export class SideQuestionRequests {
  private pending = new Map<string, PendingSideQuestion>()

  async ask(scope: SideQuestionScope, sessionId: string, input: SideQuestionInput,
    prepare: () => Promise<AgentServerClient>, isCurrent: () => boolean): Promise<SideQuestionAnswer> {
    const key = this.key(scope, sessionId, input.request_id)
    if (this.pending.has(key)) throw new Error('side_question_duplicate')
    const request: PendingSideQuestion = {
      scope, sessionId, requestId: input.request_id, controller: new AbortController(), cancelled: false
    }
    this.pending.set(key, request)
    try {
      request.client = await prepare()
      if (request.cancelled || !isCurrent()) throw new Error('side_question_cancelled')
      const answer = await request.client.askSideQuestion(sessionId, input, request.controller.signal)
      if (request.cancelled || !isCurrent()) throw new Error('side_question_cancelled')
      return answer
    } finally {
      // Cancellation uses its own captured server client, including after a
      // profile switch. Keep it alive until that exact DELETE has completed.
      await request.cancellation?.catch(() => undefined)
      request.client?.dispose()
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
  }

  private key(scope: SideQuestionScope, sessionId: string, requestId: string): string {
    return JSON.stringify([scope.profileId, scope.profileGeneration, sessionId, requestId])
  }
}
