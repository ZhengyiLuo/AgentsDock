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
    cancelSideQuestion: vi.fn().mockResolvedValue({ request_id: input.request_id, status: 'cancelled' }),
    closeSideChat: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }
  return { response, client, typedClient: client as unknown as AgentServerClient }
}

describe('SideQuestionRequests isolation', () => {
  it('does not dispatch a duplicate pending native request', async () => {
    const requests = new SideQuestionRequests()
    const { response, client, typedClient } = clientFixture()
    const native = { ...input, side_chat_id: 'side-a' }
    const prepare = vi.fn().mockResolvedValue(typedClient)
    const pending = requests.ask(scope, 'chat-a', native, prepare, () => true)
    await expect(requests.ask(scope, 'chat-a', native, prepare, () => true)).rejects.toThrow('side_question_duplicate')
    response.resolve(answer)
    await pending
    expect(prepare).toHaveBeenCalledOnce()
    expect(client.askSideQuestion).toHaveBeenCalledOnce()
    await requests.close(scope, 'chat-a', native.side_chat_id)
  })

  it('retains the captured native transport across followups and disposes it on exact close', async () => {
    const requests = new SideQuestionRequests()
    const first = clientFixture(), next = clientFixture()
    const native = { ...input, side_chat_id: 'side-a' }
    first.response.resolve(answer)
    await expect(requests.ask(scope, 'chat-a', native, async () => first.typedClient, () => true)).resolves.toEqual(answer)
    expect(first.client.dispose).not.toHaveBeenCalled()
    const followup = { ...native, request_id: 'request-b', after_request_id: input.request_id }
    await requests.ask(scope, 'chat-a', followup, async () => next.typedClient, () => true)
    expect(next.client.dispose).toHaveBeenCalledOnce()
    expect(next.client.askSideQuestion).not.toHaveBeenCalled()
    expect(first.client.askSideQuestion).toHaveBeenLastCalledWith('chat-a', followup, expect.any(AbortSignal))
    for (const [otherScope, sessionId, sideId] of [
      [{ ...scope, profileId: 'profile-b' }, 'chat-a', native.side_chat_id],
      [{ ...scope, profileGeneration: 8 }, 'chat-a', native.side_chat_id],
      [scope, 'chat-b', native.side_chat_id], [scope, 'chat-a', 'side-b']
    ] as const) await requests.close(otherScope, sessionId, sideId)
    expect(first.client.closeSideChat).not.toHaveBeenCalled()
    await requests.close(scope, 'chat-a', native.side_chat_id)
    await requests.close(scope, 'chat-a', native.side_chat_id)
    expect(first.client.closeSideChat).toHaveBeenCalledExactlyOnceWith('chat-a', native.side_chat_id)
    expect(first.client.dispose).toHaveBeenCalledOnce()
  })

  it('cancelAll closes completed native conversations using their captured profile scopes', async () => {
    const requests = new SideQuestionRequests()
    const first = clientFixture(), second = clientFixture()
    first.response.resolve(answer)
    second.response.resolve(answer)
    await requests.ask(scope, 'chat-a', { ...input, side_chat_id: 'side-a' }, async () => first.typedClient, () => true)
    await requests.ask({ profileId: 'profile-b', profileGeneration: 8 }, 'chat-b',
      { ...input, side_chat_id: 'side-b' }, async () => second.typedClient, () => true)
    requests.cancelAll()
    await vi.waitFor(() => {
      expect(first.client.closeSideChat).toHaveBeenCalledExactlyOnceWith('chat-a', 'side-a')
      expect(second.client.closeSideChat).toHaveBeenCalledExactlyOnceWith('chat-b', 'side-b')
      expect(first.client.dispose).toHaveBeenCalledOnce()
      expect(second.client.dispose).toHaveBeenCalledOnce()
    })
  })

  it('close during preparation prevents the delayed first request from opening a native fork', async () => {
    const requests = new SideQuestionRequests()
    const { client, typedClient } = clientFixture()
    const preparation = deferred<AgentServerClient>()
    const result = requests.ask(scope, 'chat-a', { ...input, side_chat_id: 'side-a' }, () => preparation.promise, () => true)
    const assertion = expect(result).rejects.toThrow('side_question_cancelled')
    await requests.close(scope, 'chat-a', 'side-a')
    preparation.resolve(typedClient)
    await assertion
    expect(client.askSideQuestion).not.toHaveBeenCalled()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('waits for the native close acknowledgement before disposing the captured transport', async () => {
    const requests = new SideQuestionRequests()
    const { response, client, typedClient } = clientFixture()
    response.resolve(answer)
    await requests.ask(scope, 'chat-a', { ...input, side_chat_id: 'side-a' }, async () => typedClient, () => true)
    const acknowledgement = deferred<void>()
    client.closeSideChat.mockReturnValue(acknowledgement.promise)
    const first = requests.close(scope, 'chat-a', 'side-a')
    const second = requests.close(scope, 'chat-a', 'side-a')
    await Promise.resolve()
    expect(client.closeSideChat).toHaveBeenCalledOnce()
    expect(client.dispose).not.toHaveBeenCalled()
    acknowledgement.resolve(undefined)
    await Promise.all([first, second])
    expect(client.dispose).toHaveBeenCalledOnce()
  })

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
