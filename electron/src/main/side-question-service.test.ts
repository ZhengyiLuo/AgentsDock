import { describe, expect, it, vi } from 'vitest'
import { AppService } from './service'
import { SideQuestionRequests } from './side-question-requests'

const expected = { profileId: 'profile-a', profileGeneration: 7 }
const input = { request_id: 'request-a', question: 'Why?' }
const answer = { request_id: input.request_id, session_id: 'chat-a', backend: 'codex', answer: 'Because.' }

function fixture() {
  const mainClient = { sendTurn: vi.fn(), stopTurn: vi.fn(), dispose: vi.fn() }
  const sideClient = { askSideQuestion: vi.fn().mockResolvedValue(answer), cancelSideQuestion: vi.fn(), dispose: vi.fn() }
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
      available: true, version: 1, backends: ['codex', 'claude'], max_question_chars: 8000
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
})
