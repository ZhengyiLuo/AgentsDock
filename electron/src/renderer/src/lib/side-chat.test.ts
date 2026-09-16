import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SideQuestionAnswer } from '@shared/side-questions'
import { useAppStore } from '../store/app-store'
import { SideChatController, sideChatHistory, type SideChatExchange } from './side-chat'

const scope = { profileId: 'a', profileGeneration: 7 }
const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
const capability = { available: true, version: 1, backends: ['codex' as const], max_question_chars: 8000, history: true }
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
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask, cancel } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'Why?')
    const pending = controller.send(scope, session)
    const requestId = ask.mock.calls[0][2].request_id
    useAppStore.setState({ switchingProfileId: 'b' })
    controller.reset()
    response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Stale' })
    await pending
    useAppStore.setState({ switchingProfileId: null })
    expect(controller.snapshot(scope, session.id)).toMatchObject({ pending: null, exchanges: [] })
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scope, session.id, requestId)
  })

  it('ignores the old response after clear and a new send', async () => {
    const first = deferred(), second = deferred()
    const ask = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const cancel = vi.fn().mockResolvedValue({ status: 'cancelled' })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: { ask, cancel } } })
    const controller = new SideChatController()
    controller.setDraft(scope, session.id, 'Old')
    const old = controller.send(scope, session)
    controller.clear(scope, session.id)
    controller.setDraft(scope, session.id, 'New')
    const next = controller.send(scope, session)
    first.resolve({ request_id: ask.mock.calls[0][2].request_id, session_id: session.id, backend: 'codex', answer: 'Discard' })
    second.resolve({ request_id: ask.mock.calls[1][2].request_id, session_id: session.id, backend: 'codex', answer: 'Keep' })
    await Promise.all([old, next])
    expect(controller.snapshot(scope, session.id).exchanges).toHaveLength(1)
    expect(controller.snapshot(scope, session.id).exchanges[0]).toMatchObject({ question: 'New', answer: 'Keep' })
  })
})
