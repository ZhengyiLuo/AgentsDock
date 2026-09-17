import { describe, expect, it, vi } from 'vitest'
import { AppService } from './service'
import { SideQuestionRequests } from './side-question-requests'

const expected = { profileId: 'profile-a', profileGeneration: 7 }
const input = { request_id: 'request-a', question: 'Why?', side_chat_id: 'side-a' }
const answer = { request_id: input.request_id, session_id: 'chat-a', backend: 'codex', answer: 'Because.' }

function fixture() {
  const mainClient = { sendTurn: vi.fn(), stopTurn: vi.fn(), dispose: vi.fn() }
  const sideClient = { askSideQuestion: vi.fn().mockResolvedValue(answer), cancelSideQuestion: vi.fn(),
    closeSideChat: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }
  const scope = { profileId: expected.profileId, generation: expected.profileGeneration,
    serverUrl: 'https://synthetic.example.test', client: mainClient }
  const clientFactory = vi.fn().mockReturnValue(sideClient)
  const service = Object.create(AppService.prototype) as AppService
  const cache = { putEvents: vi.fn(), putSessions: vi.fn() }
  Object.assign(service, {
    scope, profileGeneration: 7, activeProfileId: expected.profileId, clientFactory,
    settings: { accessToken: vi.fn().mockReturnValue('synthetic-owner-token') },
    ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
    sessions: [{ id: 'chat-a', backend: 'codex' }], cache,
    sideQuestions: new SideQuestionRequests(),
    health: { ok: true, capabilities: { side_questions: {
      available: true, version: 2, native_context: true, backends: ['codex', 'claude'], max_question_chars: 8000
    } } }
  })
  return { service, mainClient, sideClient, clientFactory, cache }
}

describe('main side-question service scope', () => {
  it('uses one separately owned client without writing conversation cache or controlling the main turn', async () => {
    const { service, mainClient, sideClient, clientFactory, cache } = fixture()
    await expect(service.askSideQuestion(expected, 'chat-a', input)).resolves.toEqual(answer)
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith('https://synthetic.example.test', 'synthetic-owner-token')
    expect(sideClient.askSideQuestion).toHaveBeenCalledExactlyOnceWith('chat-a', input, expect.any(AbortSignal))
    expect(sideClient.dispose).not.toHaveBeenCalled()
    await service.closeSideChat(expected, 'chat-a', input.side_chat_id)
    expect(sideClient.closeSideChat).toHaveBeenCalledExactlyOnceWith('chat-a', input.side_chat_id)
    expect(sideClient.dispose).toHaveBeenCalledOnce()
    for (const operation of [...Object.values(mainClient), ...Object.values(cache)]) expect(operation).not.toHaveBeenCalled()
  })

  it.each(['stale-profile', 'missing-session', 'old-server', 'unsupported-backend'] as const)('rejects %s before dispatch', async reason => {
    const { service, clientFactory } = fixture()
    if (reason === 'old-server') Object.assign(service, { health: { ok: true } })
    if (reason === 'unsupported-backend') Object.assign(service, { sessions: [{ id: 'chat-a', backend: 'cursor' }] })
    await expect(service.askSideQuestion(reason === 'stale-profile' ? { ...expected, profileGeneration: 6 } : expected,
      reason === 'missing-session' ? 'missing-chat' : 'chat-a', input)).rejects.toThrow()
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('rejects oversized input before creating a transport', async () => {
    const { service, clientFactory } = fixture()
    await expect(service.askSideQuestion(expected, 'chat-a', { ...input, question: 'x'.repeat(8001) })).rejects.toThrow('invalid_question')
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('rejects client-supplied history before dispatch instead of replaying old context', async () => {
    const { service, clientFactory } = fixture()
    await expect(service.askSideQuestion(expected, 'chat-a', { ...input, history: [
      { role: 'user', text: 'First?' }, { role: 'assistant', text: 'First answer.' }
    ] })).rejects.toThrow()
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('sends the native follow-up cursor only through its own client', async () => {
    const { service, sideClient, mainClient, cache } = fixture()
    const followup = { ...input, after_request_id: 'previous-a' }
    await expect(service.askSideQuestion(expected, 'chat-a', followup)).resolves.toEqual(answer)
    expect(sideClient.askSideQuestion).toHaveBeenCalledExactlyOnceWith('chat-a', followup, expect.any(AbortSignal))
    for (const operation of [...Object.values(mainClient), ...Object.values(cache)]) expect(operation).not.toHaveBeenCalled()
    await service.closeSideChat(expected, 'chat-a', input.side_chat_id)
  })

  it('requires the native conversation identity and rejects even empty copied history', async () => {
    const { service, clientFactory } = fixture()
    await expect(service.askSideQuestion(expected, 'chat-a', { request_id: 'request-a', question: 'Why?' })).rejects.toThrow()
    await expect(service.askSideQuestion(expected, 'chat-a', { ...input, history: [] })).rejects.toThrow()
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it.each([{ version: 1, native_context: true }, { version: 2, native_context: false }])(
    'never downgrades native side chat to a snapshot server %j', async capability => {
      const { service, clientFactory } = fixture()
      Object.assign(service, { health: { capabilities: { side_questions: {
        available: true, backends: ['codex'], max_question_chars: 8000, history: true, ...capability
      } } } })
      await expect(service.askSideQuestion(expected, 'chat-a', input)).rejects.toThrow('side_question_unsupported')
      expect(clientFactory).not.toHaveBeenCalled()
    })

  it('closes the captured old profile conversation after switching server scope', async () => {
    const { service, sideClient, mainClient } = fixture()
    await service.askSideQuestion(expected, 'chat-a', input)
    Object.assign(service, { activeProfileId: 'profile-b', profileGeneration: 8 })
    await service.closeSideChat({ ...expected, profileGeneration: 8 }, 'chat-a', input.side_chat_id)
    expect(sideClient.closeSideChat).not.toHaveBeenCalled()
    await service.closeSideChat(expected, 'chat-a', input.side_chat_id)
    expect(sideClient.closeSideChat).toHaveBeenCalledExactlyOnceWith('chat-a', input.side_chat_id)
    expect(mainClient.dispose).not.toHaveBeenCalled()
  })
})
