import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SideQuestionAnswer } from '@shared/side-questions'
import { useAppStore } from '../store/app-store'
import { SideChatController, sideChatHistory, type SideChatExchange } from './side-chat'

const scope = { profileId: 'a', profileGeneration: 7 }
const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
const capability = { available: true, version: 2, native_context: true, backends: ['codex' as const], max_question_chars: 8000 }
function deferred() { let resolve!: (answer: SideQuestionAnswer) => void; return { promise: new Promise<SideQuestionAnswer>(r => { resolve = r }), resolve: (value: SideQuestionAnswer) => resolve(value) } }
beforeEach(() => useAppStore.setState({ activeProfileId: 'a', profileGeneration: 7, switchingProfileId: null, connected: true,
  health: { ok: true, capabilities: { side_questions: capability } } }))

describe('SideChatController', () => {
  it('keeps only whole recent pairs and discloses dropped history', () => {
    const exchanges: SideChatExchange[] = Array.from({ length: 20 }, (_, index) => ({ id: String(index), question: `q${index}`, answer: `a${index}`, state: 'answered' }))
    const result = sideChatHistory(exchanges)
    expect(result.history).toHaveLength(32)
    expect(result.history[0]).toEqual({ role: 'user', text: 'q4' })
    expect(result.omitted).toBe(true)
    expect(sideChatHistory(exchanges, 32, 6).history).toEqual([{ role: 'user', text: 'q19' }, { role: 'assistant', text: 'a19' }])
    expect(sideChatHistory([{ id: '1', question: 'x', state: 'cancelled' }]).history).toEqual([])
  })

  it('retires a failed profile switch without resurrecting a pending answer', async () => {
    const response = deferred()
    const ask = vi.fn().mockReturnValue(response.promise)
    const cancel = vi.fn().mockResolvedValue({ status: 'cancelled' })
    const close = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask, cancel, close } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'Why?')
    const pending = controller.send(scope, session)
    const requestId = ask.mock.calls[0][2].request_id
    const sideId = ask.mock.calls[0][2].side_chat_id
    useAppStore.setState({ switchingProfileId: 'b' })
    controller.reset()
    response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Stale' })
    await pending
    useAppStore.setState({ switchingProfileId: null })
    expect(controller.snapshot(scope, session.id)).toMatchObject({ pending: null, exchanges: [] })
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scope, session.id, requestId)
    expect(close).toHaveBeenCalledExactlyOnceWith(scope, session.id, sideId)
    expect(controller.snapshot(scope, session.id).sideChatId).not.toBe(sideId)
  })

  it('ignores the old response after clear and a new send', async () => {
    const first = deferred(), second = deferred()
    const ask = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const cancel = vi.fn().mockResolvedValue({ status: 'cancelled' })
    const close = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask, cancel, close } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'Old')
    const old = controller.send(scope, session)
    const oldSideId = ask.mock.calls[0][2].side_chat_id
    controller.clear(scope, session.id)
    controller.setDraft(scope, session.id, 'New')
    const next = controller.send(scope, session)
    expect(ask.mock.calls[1][2].side_chat_id).not.toBe(oldSideId)
    expect(ask.mock.calls[1][2]).not.toHaveProperty('after_request_id')
    expect(close).toHaveBeenCalledExactlyOnceWith(scope, session.id, oldSideId)
    first.resolve({ request_id: ask.mock.calls[0][2].request_id, session_id: session.id, backend: 'codex', answer: 'Discard' })
    second.resolve({ request_id: ask.mock.calls[1][2].request_id, session_id: session.id, backend: 'codex', answer: 'Keep' })
    await Promise.all([old, next])
    expect(controller.snapshot(scope, session.id).exchanges).toHaveLength(1)
    expect(controller.snapshot(scope, session.id).exchanges[0]).toMatchObject({ question: 'New', answer: 'Keep' })
  })

  it('reuses native identity and advances only the last successful request cursor without replaying history', async () => {
    const ask = vi.fn().mockImplementation((_scope, sessionId, input) => Promise.resolve({
      request_id: input.request_id, session_id: sessionId, backend: 'codex', answer: 'Provider answer'
    }))
    const close = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask, close } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'First question')
    await controller.send(scope, session)
    const first = ask.mock.calls[0][2]
    expect(first).not.toHaveProperty('history')
    expect(first).not.toHaveProperty('after_request_id')
    ask.mockRejectedValueOnce(new Error('side_question_http_503'))
    controller.setDraft(scope, session.id, 'Failed followup')
    await controller.send(scope, session)
    controller.setDraft(scope, session.id, 'Next followup')
    await controller.send(scope, session)
    for (const call of ask.mock.calls.slice(1)) {
      expect(call[2]).toMatchObject({ side_chat_id: first.side_chat_id, after_request_id: first.request_id })
      expect(call[2]).not.toHaveProperty('history')
    }
    expect(controller.snapshot(scope, session.id).lastRequestId).toBe(ask.mock.calls[2][2].request_id)
    controller.clear(scope, session.id)
    expect(close).toHaveBeenCalledExactlyOnceWith(scope, session.id, first.side_chat_id)
    expect(controller.snapshot(scope, session.id).lastRequestId).toBeUndefined()
  })

  it('does not accept a foreign reply or advance the native cursor', async () => {
    const ask = vi.fn().mockResolvedValue({ request_id: 'foreign', session_id: session.id, backend: 'codex', answer: 'Wrong owner' })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'Question')
    await controller.send(scope, session)
    expect(controller.snapshot(scope, session.id).lastRequestId).toBeUndefined()
    expect(controller.snapshot(scope, session.id)).toMatchObject({
      exchanges: [{ state: 'error', error: 'side_question_invalid_response' }] })
    expect(controller.snapshot(scope, session.id).exchanges[0].answer).toBeUndefined()
  })

  it('isolates native identity and reset cleanup by both profile generation and parent session', () => {
    const close = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { close } } })
    const controller = new SideChatController()
    const scopes = [[scope, session.id], [{ ...scope, profileGeneration: 8 }, session.id], [scope, 'other-chat']] as const
    const ids = scopes.map(([owner, id]) => controller.snapshot(owner, id).sideChatId)
    expect(new Set(ids).size).toBe(3)
    controller.reset()
    scopes.forEach(([owner, id], index) => expect(close).toHaveBeenCalledWith(owner, id, ids[index]))
    expect(close).toHaveBeenCalledTimes(3)
  })
})
