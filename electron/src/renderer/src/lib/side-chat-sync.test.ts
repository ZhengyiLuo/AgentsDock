import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEventMap } from '@shared/types'
import type { SyncedSideChat } from '@shared/side-questions'
import { SideChatController } from './side-chat'
import { useAppStore } from '../store/app-store'

const scope = { profileId: 'a', profileGeneration: 7, serverIdentity: 'server-a' }
const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
function chat(revision = 0, exchange?: Partial<SyncedSideChat['exchanges'][number]>, sideId = 'side-a'): SyncedSideChat {
  return { session_id: session.id, side_chat_id: sideId, revision, last_request_id: exchange && exchange.status !== 'running' ? 'request-a' : null,
    exchanges: exchange ? [{ request_id: 'request-a', question: 'First question', status: 'completed', answer: 'First answer',
      created_at: 'now', updated_at: 'now', ...exchange }] : [] }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const api = { read: vi.fn().mockResolvedValue(chat()), submit: vi.fn(), stop: vi.fn(), clear: vi.fn(), ask: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
  const listeners = new Map<string, Set<(event: any) => void>>()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, events: {
    on: (name: string, listener: (event: any) => void) => {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set)
      return () => set.delete(listener)
    }
  } } })
  const emit = <K extends keyof AppEventMap>(name: K, event: AppEventMap[K]) => { for (const listener of listeners.get(name) ?? []) listener(event) }
  return { api, emit, controller: new SideChatController() }
}
beforeEach(() => useAppStore.setState({ activeProfileId: 'a', profileGeneration: 7, switchingProfileId: null, connected: true,
  syncBySession: {}, syncSessionId: null, syncStatus: 'idle',
  profiles: [{ id: 'a', name: 'A', serverUrl: 'http://server-a', serverIdentity: 'server-a', hasAccessToken: true,
    connectionState: 'online', serverSetupComplete: true, cachedUnreadCount: 0 }],
  health: { ok: true, capabilities: { side_questions: { available: true, version: 2, native_context: true, sync: true, backends: ['codex'], max_question_chars: 8000 } } } }))

describe('server-owned side chat', () => {
  it('restores completed history on a fresh client and only refreshes from notices or reconnect', async () => {
    const { api, emit, controller } = fixture()
    api.read.mockResolvedValue(chat(2, {}))
    const stop = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(2))
    expect(controller.snapshot(scope, session.id).exchanges[0].answer).toBe('First answer')
    for (let index = 0; index < 50; index++) controller.setDraft(scope, session.id, `Local ${index}`)
    expect(api.read).toHaveBeenCalledOnce()
    emit('side-chat:changed', { ...scope, sessionId: 'other', revision: 3 })
    emit('side-chat:changed', { ...scope, profileGeneration: 6, sessionId: session.id, revision: 3 })
    emit('side-chat:changed', { ...scope, sessionId: session.id, revision: 2 })
    expect(api.read).toHaveBeenCalledOnce()
    api.read.mockResolvedValue(chat(3, { answer: 'Updated answer' }))
    emit('side-chat:changed', { ...scope, sessionId: session.id, revision: 3 })
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(3))
    expect(controller.snapshot(scope, session.id).draft).toBe('Local 49')
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(3))
    stop()
    emit('side-chat:changed', { ...scope, sessionId: session.id, revision: 4 })
    expect(api.read).toHaveBeenCalledTimes(3)
  })

  it.each(['session', 'legacy'] as const)('ignores repeated live heartbeats when opened on an already-live %s stream', async kind => {
    const { api, emit, controller } = fixture()
    useAppStore.setState(kind === 'session' ? { syncBySession: { [session.id]: { status: 'live', error: null } } }
      : { syncSessionId: session.id, syncStatus: 'live' })
    api.read.mockResolvedValue(chat(2, {}))
    const stop = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(2))
    for (let count = 0; count < 6; count++) emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    expect(api.read).toHaveBeenCalledOnce()
    emit('server:sync', { ...scope, profileGeneration: 6, sessionId: session.id, state: 'reconnecting' })
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    expect(api.read).toHaveBeenCalledOnce()

    api.read.mockResolvedValue(chat(3, { answer: 'Completed while disconnected' }))
    emit('server:sync', { ...scope, sessionId: session.id, state: 'reconnecting' })
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(3))
    expect(controller.snapshot(scope, session.id).exchanges[0].answer).toBe('Completed while disconnected')
    expect(api.read).toHaveBeenCalledTimes(2)
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    expect(api.read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('reconciles once when the stream first becomes live after the initial open read', async () => {
    const { api, emit, controller } = fixture()
    useAppStore.setState({ syncBySession: { [session.id]: { status: 'syncing', error: null } } })
    const stop = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(0))
    api.read.mockResolvedValue(chat(1, { answer: 'Arrived before websocket connected' }))
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(1))
    emit('server:sync', { ...scope, sessionId: session.id, state: 'live' })
    expect(api.read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('can stop work started by another client and clear it for both clients', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(1, { status: 'running', answer: undefined }))
    api.stop.mockResolvedValue(chat(2, { status: 'cancelled', answer: undefined }))
    api.clear.mockResolvedValue(chat(3, undefined, 'side-b'))
    await controller.refresh(scope, session.id)
    expect(controller.snapshot(scope, session.id).pending).toBe('request-a')
    await controller.cancel(scope, session.id)
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(scope, session.id, 'request-a')
    expect(controller.snapshot(scope, session.id).exchanges[0].state).toBe('cancelled')
    controller.clear(scope, session.id)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).sideChatId).toBe('side-b'))
    expect(controller.snapshot(scope, session.id).exchanges).toEqual([])
    expect(api.close).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('preserves a new draft typed while Clear is awaiting the server', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(2, {}))
    await controller.refresh(scope, session.id)
    controller.setDraft(scope, session.id, 'Old unsent draft')
    const cleared = deferred<SyncedSideChat>()
    api.clear.mockReturnValue(cleared.promise)
    controller.clear(scope, session.id)
    expect(controller.snapshot(scope, session.id).draft).toBe('')
    controller.setDraft(scope, session.id, 'New question after Clear')
    cleared.resolve(chat(3, undefined, 'side-b'))
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).sideChatId).toBe('side-b'))
    expect(controller.snapshot(scope, session.id)).toMatchObject({ draft: 'New question after Clear', exchanges: [], pending: null })
  })

  it('cannot overwrite a new connection after a failed Clear awaits an old-generation read', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(2, {}))
    await controller.refresh(scope, session.id)
    const oldRead = deferred<SyncedSideChat>()
    api.clear.mockRejectedValue(new Error('Clear failed'))
    api.read.mockReturnValueOnce(oldRead.promise)
    controller.clear(scope, session.id)
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(2))
    useAppStore.setState({ profileGeneration: 9 })
    const returned = { ...scope, profileGeneration: 9 }
    api.read.mockResolvedValue(chat(3, { answer: 'New connection answer' }))
    await controller.refresh(returned, session.id)
    controller.setDraft(returned, session.id, 'New connection draft')
    oldRead.resolve(chat(2, {}))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.snapshot(returned, session.id)).toMatchObject({ revision: 3, draft: 'New connection draft', error: null,
      exchanges: [{ answer: 'New connection answer' }] })
  })

  it('does not drop optimistic pending when an older same-conversation read finishes before POST acceptance', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    const accepted = deferred<SyncedSideChat>()
    api.submit.mockReturnValue(accepted.promise)
    controller.setDraft(scope, session.id, 'New question')
    const send = controller.send(scope, session)
    const request = api.submit.mock.calls[0][2]
    await controller.refresh(scope, session.id)
    expect(controller.snapshot(scope, session.id).pending).toBe(request.request_id)
    accepted.resolve(chat(1, { request_id: request.request_id, question: request.question, status: 'running', answer: undefined }))
    await send
    expect(controller.snapshot(scope, session.id).exchanges).toHaveLength(1)
    expect(api.ask).not.toHaveBeenCalled()
  })

  it('orders an immediate Stop after POST acceptance so it cannot miss the request', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    const accepted = deferred<SyncedSideChat>()
    api.submit.mockReturnValue(accepted.promise)
    controller.setDraft(scope, session.id, 'Please think')
    const send = controller.send(scope, session)
    const request = api.submit.mock.calls[0][2]
    const cancel = controller.cancel(scope, session.id)
    expect(api.stop).not.toHaveBeenCalled()
    api.stop.mockResolvedValue(chat(2, { request_id: request.request_id, status: 'cancelled', answer: undefined }))
    accepted.resolve(chat(1, { request_id: request.request_id, status: 'running', answer: undefined }))
    await Promise.all([send, cancel])
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(scope, session.id, request.request_id)
    expect(controller.snapshot(scope, session.id).pending).toBeNull()
    expect(controller.snapshot(scope, session.id).exchanges[0].state).toBe('cancelled')
  })

  it('restores an unaccepted question to the local draft without retrying submission', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    api.submit.mockRejectedValue(new Error('Connection failed'))
    controller.setDraft(scope, session.id, 'Keep this question')
    await controller.send(scope, session)
    expect(api.submit).toHaveBeenCalledOnce()
    expect(controller.snapshot(scope, session.id)).toMatchObject({ draft: 'Keep this question', error: 'Connection failed', exchanges: [] })
  })

  it('resumes a restored conversation using its native cursor, never copied history', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(2, {}))
    await controller.refresh(scope, session.id)
    api.submit.mockResolvedValue(chat(3, { status: 'running', answer: undefined }))
    controller.setDraft(scope, session.id, 'Follow up from another device')
    await controller.send(scope, session)
    expect(api.submit.mock.calls[0][2]).toMatchObject({ side_chat_id: 'side-a', after_request_id: 'request-a' })
    expect(api.submit.mock.calls[0][2]).not.toHaveProperty('history')
  })

  it('a remote clear cannot be resurrected by a delayed accepted POST response', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    const accepted = deferred<SyncedSideChat>()
    api.submit.mockReturnValue(accepted.promise)
    controller.setDraft(scope, session.id, 'Old question')
    const send = controller.send(scope, session)
    const request = api.submit.mock.calls[0][2]
    api.read.mockResolvedValue(chat(3, undefined, 'side-b'))
    await controller.refresh(scope, session.id)
    expect(controller.snapshot(scope, session.id).exchanges).toEqual([])
    accepted.resolve(chat(1, { request_id: request.request_id, status: 'running', answer: undefined }))
    await send
    expect(controller.snapshot(scope, session.id)).toMatchObject({ sideChatId: 'side-b', revision: 3, exchanges: [], pending: null })
  })

  it('coalesces a notice arriving during a read and rejects stale revisions', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    const first = deferred<SyncedSideChat>()
    api.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(chat(4, {}))
    const refresh = controller.refresh(scope, session.id)
    void controller.refresh(scope, session.id)
    void controller.refresh(scope, session.id)
    first.resolve(chat(3, { status: 'running', answer: undefined }))
    await refresh
    expect(api.read).toHaveBeenCalledTimes(3)
    expect(controller.snapshot(scope, session.id).revision).toBe(4)
    api.read.mockResolvedValue(chat(1))
    await controller.refresh(scope, session.id)
    expect(controller.snapshot(scope, session.id).revision).toBe(4)
  })

  it('does not cancel or clear server-owned work on shutdown, profile removal, or server switches', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(1, { status: 'running', answer: undefined }))
    await controller.refresh(scope, session.id)
    controller.reconcileProfiles([])
    await controller.refresh(scope, session.id)
    controller.reset()
    expect(api.stop).not.toHaveBeenCalled()
    expect(api.clear).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
  })

  it('does not display a previous credential owner on a new connection before reauthorization', async () => {
    const { api, controller } = fixture()
    api.read.mockResolvedValue(chat(2, {}))
    await controller.refresh(scope, session.id)
    controller.setDraft(scope, session.id, 'Private unsent draft')
    useAppStore.setState({ profileGeneration: 9 })
    const next = { ...scope, profileGeneration: 9 }
    expect(controller.snapshot(next, session.id)).toMatchObject({ exchanges: [], draft: '', pending: null, loading: true })
    expect(controller.snapshot(next, session.id).revision).toBeUndefined()
    api.read.mockResolvedValue(chat(0, undefined, 'other-owner-side'))
    await controller.refresh(next, session.id)
    expect(controller.snapshot(next, session.id)).toMatchObject({ sideChatId: 'other-owner-side', revision: 0, exchanges: [] })
  })

  it('starts a fresh read after revisiting a server even if the old-generation read is still pending', async () => {
    const { api, controller } = fixture()
    const old = deferred<SyncedSideChat>()
    api.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(chat(2, {}))
    const previous = controller.refresh(scope, session.id)
    useAppStore.setState({ profileGeneration: 9 })
    const returned = { ...scope, profileGeneration: 9 }
    await controller.refresh(returned, session.id)
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(controller.snapshot(returned, session.id).revision).toBe(2)
    old.resolve(chat(1))
    await previous
    expect(controller.snapshot(returned, session.id).revision).toBe(2)
  })

  it('ignores reads from a retired server generation or reset controller', async () => {
    const { api, controller } = fixture()
    const read = deferred<SyncedSideChat>()
    api.read.mockReturnValue(read.promise)
    const refresh = controller.refresh(scope, session.id)
    useAppStore.setState({ profileGeneration: 8 })
    read.resolve(chat(2, {}))
    await refresh
    expect(controller.snapshot(scope, session.id).exchanges).toEqual([])
    expect(controller.snapshot({ ...scope, serverIdentity: 'another-server' }, session.id).exchanges).toEqual([])
    controller.reset()
    expect(controller.snapshot(scope, session.id).revision).toBeUndefined()
  })

  it('reconciles a lost acknowledgement without resubmitting', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    api.submit.mockImplementation(async (_scope, _id, input) => {
      api.read.mockResolvedValue(chat(1, { request_id: input.request_id, question: input.question, status: 'running', answer: undefined }))
      throw new Error('Network lost')
    })
    controller.setDraft(scope, session.id, 'Question accepted before disconnect')
    await controller.send(scope, session)
    expect(api.submit).toHaveBeenCalledOnce()
    expect(controller.snapshot(scope, session.id).exchanges).toMatchObject([{ state: 'pending' }])
  })
})
