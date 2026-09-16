import { describe, expect, it, vi } from 'vitest'
import type { AgentServerClient } from './server-client'
import { SideQuestionRequests } from './side-question-requests'

const scope = { profileId: 'profile-a', profileGeneration: 7 }
const input = { request_id: 'request-a', question: 'Why?' }
const answer = { request_id: input.request_id, session_id: 'chat-a', backend: 'codex' as const, answer: 'Because.' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function clientFixture() {
  const response = deferred<typeof answer>()
  const client = { askSideQuestion: vi.fn().mockReturnValue(response.promise),
    cancelSideQuestion: vi.fn().mockResolvedValue({ request_id: input.request_id, status: 'cancelled' }), dispose: vi.fn() }
  return { response, client, typedClient: client as unknown as AgentServerClient }
}

describe('SideQuestionRequests isolation', () => {
  it('returns one answer and disposes the independent transport', async () => {
    const requests = new SideQuestionRequests()
    const { response, client, typedClient } = clientFixture()
    const result = requests.ask(scope, 'chat-a', input, async () => typedClient, () => true)
    response.resolve(answer)
    await expect(result).resolves.toEqual(answer)
    expect(client.dispose).toHaveBeenCalledOnce()
    expect(client.cancelSideQuestion).not.toHaveBeenCalled()
  })

  it('cannot cancel another session/profile/request and cancels the original server after a switch', async () => {
    const requests = new SideQuestionRequests()
    const { response, client, typedClient } = clientFixture()
    let current = true
    const result = requests.ask(scope, 'chat-a', input, async () => typedClient, () => current)
    const assertion = expect(result).rejects.toThrow('side_question_cancelled')
    await Promise.resolve()
    for (const [otherScope, sessionId, requestId] of [
      [{ ...scope, profileId: 'profile-b' }, 'chat-a', input.request_id],
      [scope, 'chat-b', input.request_id], [scope, 'chat-a', 'request-b']
    ] as const) {
      expect(await requests.cancel(otherScope, sessionId, requestId)).toEqual({ request_id: requestId, status: 'not_found' })
    }
    expect(client.cancelSideQuestion).not.toHaveBeenCalled()
    current = false
    await requests.cancel(scope, 'chat-a', input.request_id)
    expect(client.cancelSideQuestion).toHaveBeenCalledExactlyOnceWith('chat-a', input.request_id)
    response.resolve(answer)
    await assertion
  })

  it('cancels during validation before any provider request is dispatched', async () => {
    const requests = new SideQuestionRequests()
    const { client, typedClient } = clientFixture()
    const preparation = deferred<AgentServerClient>()
    const result = requests.ask(scope, 'chat-a', input, () => preparation.promise, () => true)
    const assertion = expect(result).rejects.toThrow('side_question_cancelled')
    await requests.cancel(scope, 'chat-a', input.request_id)
    preparation.resolve(typedClient)
    await assertion
    expect(client.askSideQuestion).not.toHaveBeenCalled()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('keeps the old client alive until cancellation settles and deduplicates cancel', async () => {
    const requests = new SideQuestionRequests()
    const { response, client, typedClient } = clientFixture()
    const cancellation = deferred<{ request_id: string; status: 'cancelled' }>()
    client.cancelSideQuestion.mockReturnValue(cancellation.promise)
    const result = requests.ask(scope, 'chat-a', input, async () => typedClient, () => true)
    const assertion = expect(result).rejects.toThrow('side_question_cancelled')
    await Promise.resolve()
    const firstCancel = requests.cancel(scope, 'chat-a', input.request_id)
    expect(requests.cancel(scope, 'chat-a', input.request_id)).toBe(firstCancel)
    response.resolve(answer)
    await Promise.resolve()
    expect(client.dispose).not.toHaveBeenCalled()
    cancellation.resolve({ request_id: input.request_id, status: 'cancelled' })
    await firstCancel
    await assertion
    expect(client.dispose).toHaveBeenCalledOnce()
  })
})
