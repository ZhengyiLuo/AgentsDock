import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedSideChat, SyncedSideChatList } from '@shared/side-questions'
import { SideChatController } from './side-chat'
import { useAppStore } from '../store/app-store'

const scope = { profileId: 'a', profileGeneration: 7, serverIdentity: 'server-a' }
const session = { id: 'chat', title: 'Chat', backend: 'codex' as const }
function chat(id = 'original', revision = 0, request?: { id: string; status: 'running' | 'completed' | 'cancelled' }, conversationId = id): SyncedSideChat {
  return { session_id: session.id, side_chat_id: id, conversation_id: conversationId, revision,
    last_request_id: request && request.status === 'completed' ? request.id : null,
    exchanges: request ? [{ request_id: request.id, question: `Question ${request.id}`, status: request.status,
      ...(request.status === 'completed' ? { answer: `Answer ${request.id}` } : {}),
      activity: [{ id: `activity-${request.id}`, kind: 'reasoning', text: `Thinking ${request.id}`, status: request.status === 'running' ? 'running' : 'completed' }],
      created_at: 'now', updated_at: 'now' }] : [] }
}
const list = (...chats: SyncedSideChat[]): SyncedSideChatList => ({ session_id: session.id, side_chats: chats })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const api = { list: vi.fn().mockResolvedValue(list(chat())), create: vi.fn(), read: vi.fn(), submit: vi.fn(), stop: vi.fn(), clear: vi.fn(), ask: vi.fn(), cancel: vi.fn(), close: vi.fn() }
  const listeners = new Map<string, Set<(event: any) => void>>()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, events: {
    on: (name: string, listener: (event: any) => void) => {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set)
      return () => set.delete(listener)
    }
  } } })
  const emit = (name: string, event: object) => { for (const listener of listeners.get(name) ?? []) listener({ ...scope, sessionId: session.id, ...event }) }
  return { api, emit, controller: new SideChatController() }
}
beforeEach(() => useAppStore.setState({ activeProfileId: 'a', profileGeneration: 7, switchingProfileId: null, connected: true,
  syncBySession: {}, syncSessionId: null, syncStatus: 'idle',
  profiles: [{ id: 'a', name: 'A', serverUrl: 'http://server-a', serverIdentity: 'server-a', hasAccessToken: true,
    connectionState: 'online', serverSetupComplete: true, cachedUnreadCount: 0 }],
  health: { ok: true, capabilities: { side_questions: { available: true, version: 2, native_context: true, sync: true, multiple: true, max_question_chars: 8000, backends: ['codex', 'claude'] } } } }))

describe('multiple server-owned side chats', () => {
  it('does not clear or close a placeholder before the initial list is authorized', async () => {
    const { api, controller } = fixture()
    const reading = deferred<SyncedSideChatList>()
    api.list.mockReturnValue(reading.promise)
    const refresh = controller.refresh(scope, session.id)
    controller.clear(scope, session.id)
    expect(api.clear).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
    reading.resolve(list(chat()))
    await refresh
    expect(controller.snapshot(scope, session.id).sideChatId).toBe('original')
  })

  it.each(['codex', 'claude'] as const)('preserves the migrated %s history, local draft and scroll while creating another chat', async backend => {
    const { api, controller } = fixture()
    controller.setDraft(scope, session.id, 'Unsent original draft')
    api.list.mockResolvedValue(list(chat('original', 3, { id: 'old', status: 'completed' }, 'default')))
    await controller.refresh(scope, session.id)
    controller.saveHistoryScroll(scope, session.id, 'original', { scrollTop: 120, atBottom: false })
    api.create.mockImplementation((_scope, _sessionId, id) => Promise.resolve(chat(id)))
    await controller.create(scope, session.id)
    const created = controller.snapshot(scope, session.id).sideChatId
    controller.setDraft(scope, session.id, 'New draft')
    controller.select(scope, session.id, 'original')
    expect(controller.snapshot(scope, session.id)).toMatchObject({ draft: 'Unsent original draft', exchanges: [{ answer: 'Answer old' }] })
    expect(controller.historyScroll(scope, session.id)).toEqual({ scrollTop: 120, atBottom: false })
    controller.select(scope, session.id, created)
    expect(controller.snapshot(scope, session.id)).toMatchObject({ draft: 'New draft', exchanges: [] })
    // Even a late scroll event from the old view belongs to its original tab.
    controller.saveHistoryScroll(scope, session.id, 'original', { scrollTop: 155, atBottom: false })
    expect(controller.historyScroll(scope, session.id)).toBeUndefined()
    controller.select(scope, session.id, 'original')
    expect(controller.historyScroll(scope, session.id)?.scrollTop).toBe(155)
    api.submit.mockImplementation((_scope, _sessionId, input) => Promise.resolve(chat('original', 4, { id: input.request_id, status: 'running' }, 'default')))
    await controller.send(scope, { ...session, backend })
    expect(api.submit.mock.calls[0][2]).toMatchObject({ side_chat_id: 'original', after_request_id: 'old' })
    expect(api.clear).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
  })

  it('keeps concurrent replies and activity in their owning tabs and stops only the selected request', async () => {
    const { api, controller, emit } = fixture()
    api.list.mockResolvedValue(list(chat(), chat('second')))
    const disconnect = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.tabs(scope, session.id).chats).toHaveLength(2))
    const accepted = deferred<SyncedSideChat>()
    api.submit.mockReturnValueOnce(accepted.promise).mockImplementation((_scope, _sessionId, input) => Promise.resolve(chat('second', 1, { id: input.request_id, status: 'running' })))
    controller.setDraft(scope, session.id, 'First running question')
    const sending = controller.send(scope, session)
    const firstId = api.submit.mock.calls[0][2].request_id
    controller.select(scope, session.id, 'second')
    controller.setDraft(scope, session.id, 'Second running question')
    await controller.send(scope, session)
    const secondId = api.submit.mock.calls[1][2].request_id
    accepted.resolve(chat('original', 1, { id: firstId, status: 'running' }))
    await sending
    expect(controller.tabs(scope, session.id).chats.map(chat => chat.pending)).toEqual([firstId, secondId])
    expect(controller.snapshot(scope, session.id).exchanges[0].activity?.[0].text).toBe(`Thinking ${secondId}`)
    api.read.mockResolvedValue(chat('original', 2, { id: firstId, status: 'completed' }))
    emit('side-chat:changed', { sideChatId: 'original', revision: 2 })
    await vi.waitFor(() => expect(controller.tabs(scope, session.id).chats[0].pending).toBeNull())
    expect(api.read).toHaveBeenCalledExactlyOnceWith(scope, session.id, 'original')
    expect(controller.snapshot(scope, session.id).pending).toBe(secondId)
    api.stop.mockResolvedValue(chat('second', 2, { id: secondId, status: 'cancelled' }))
    await controller.cancel(scope, session.id)
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(scope, session.id, secondId, 'second')
    controller.select(scope, session.id, 'original')
    expect(controller.snapshot(scope, session.id).exchanges[0].answer).toBe(`Answer ${firstId}`)
    disconnect()
    expect(api.close).not.toHaveBeenCalled()
  })

  it('preserves selection and drafts when another client clears a tab or creates a new one', async () => {
    const { api, controller, emit } = fixture()
    api.list.mockResolvedValue(list(chat('original', 3), chat('second', 2, undefined, 'stable-second')))
    const disconnect = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.tabs(scope, session.id).chats).toHaveLength(2))
    controller.select(scope, session.id, 'second')
    controller.setDraft(scope, session.id, 'Draft after remote clear')
    controller.saveHistoryScroll(scope, session.id, 'second', { scrollTop: 40, atBottom: false })
    api.list.mockResolvedValue(list(chat('original', 3), chat('second-cleared', 3, undefined, 'stable-second'), chat('third')))
    emit('side-chat:changed', { sideChatId: 'second-cleared', revision: 3 })
    await vi.waitFor(() => expect(controller.tabs(scope, session.id).chats).toHaveLength(3))
    expect(controller.snapshot(scope, session.id)).toMatchObject({ sideChatId: 'second-cleared', draft: 'Draft after remote clear' })
    expect(controller.historyScroll(scope, session.id)).toBeUndefined()
    disconnect()
  })

  it('reconciles all conversations on reopening and reconnect without resetting selection', async () => {
    const { api, controller, emit } = fixture()
    api.list.mockResolvedValue(list(chat(), chat('second')))
    let disconnect = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.tabs(scope, session.id).chats).toHaveLength(2))
    controller.select(scope, session.id, 'second')
    controller.setDraft(scope, session.id, 'Retained')
    disconnect()
    api.list.mockResolvedValue(list(chat('original', 2, { id: 'first', status: 'completed' }), chat('second', 2, { id: 'second', status: 'completed' })))
    disconnect = controller.connect(scope, session)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).revision).toBe(2))
    expect(controller.snapshot(scope, session.id)).toMatchObject({ sideChatId: 'second', draft: 'Retained', exchanges: [{ answer: 'Answer second' }] })
    emit('server:sync', { state: 'reconnecting' })
    emit('server:sync', { state: 'live' })
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(3))
    emit('server:sync', { state: 'live' })
    expect(api.list).toHaveBeenCalledTimes(3)
    disconnect()
  })

  it('retries an unacknowledged create idempotently and fences stale list reads', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    api.create.mockRejectedValueOnce(new Error('lost acknowledgement')).mockImplementation((_scope, _sessionId, id) => Promise.resolve(chat(id)))
    await controller.create(scope, session.id)
    expect(controller.tabs(scope, session.id).error).toBe('side_chat_sync_failed')
    const stale = deferred<SyncedSideChatList>()
    api.list.mockReturnValueOnce(stale.promise).mockImplementation(() => Promise.resolve(list(chat(), chat(api.create.mock.calls[0][2]))))
    const refreshing = controller.refresh(scope, session.id)
    await controller.create(scope, session.id)
    expect(api.create.mock.calls[1][2]).toBe(api.create.mock.calls[0][2])
    const selected = controller.snapshot(scope, session.id).sideChatId
    stale.resolve(list(chat()))
    await refreshing
    expect(controller.tabs(scope, session.id).chats).toHaveLength(2)
    expect(controller.snapshot(scope, session.id).sideChatId).toBe(selected)
  })

  it('recovers a committed clear with a lost acknowledgement and missed push by listing stable conversations', async () => {
    const { api, controller } = fixture()
    api.list.mockResolvedValueOnce(list(chat(), chat('second', 2, undefined, 'stable-second')))
      .mockResolvedValue(list(chat(), chat('cleared-second', 3, undefined, 'stable-second')))
    api.clear.mockRejectedValue(new Error('lost clear acknowledgement'))
    await controller.refresh(scope, session.id)
    controller.select(scope, session.id, 'second')
    controller.clear(scope, session.id)
    await vi.waitFor(() => expect(controller.snapshot(scope, session.id).sideChatId).toBe('cleared-second'))
    expect(api.read).not.toHaveBeenCalled()
    expect(controller.tabs(scope, session.id).chats).toHaveLength(2)
  })

  it('does not resurrect a stale epoch when another client clears a newly created chat before acknowledgement', async () => {
    const { api, controller } = fixture()
    await controller.refresh(scope, session.id)
    const accepted = deferred<SyncedSideChat>()
    api.create.mockReturnValue(accepted.promise)
    const creating = controller.create(scope, session.id)
    const id = api.create.mock.calls[0][2]
    api.list.mockResolvedValue(list(chat(), chat(id, 0, undefined, 'stable-created')))
    await controller.refresh(scope, session.id)
    api.list.mockResolvedValue(list(chat(), chat('created-cleared', 1, undefined, 'stable-created')))
    await controller.refresh(scope, session.id)
    accepted.resolve(chat(id, 0, undefined, 'stable-created'))
    await creating
    expect(controller.tabs(scope, session.id).chats).toHaveLength(2)
    expect(controller.snapshot(scope, session.id).sideChatId).toBe('created-cleared')
  })

  it('continues notifying a mounted subscriber after resetting all conversations', async () => {
    const { controller } = fixture()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(scope, session.id, listener)
    await controller.refresh(scope, session.id)
    controller.reset()
    const count = listener.mock.calls.length
    controller.setDraft(scope, session.id, 'After reset')
    expect(listener.mock.calls.length).toBeGreaterThan(count)
    expect(controller.snapshot(scope, session.id).draft).toBe('After reset')
    unsubscribe()
  })

  it('hides all prior credential history until the new generation is authorized', async () => {
    const { api, controller } = fixture()
    api.list.mockResolvedValue(list(chat('original', 2, { id: 'first', status: 'completed' }), chat('second', 2, { id: 'second', status: 'completed' })))
    await controller.refresh(scope, session.id)
    const nextScope = { ...scope, profileGeneration: 8 }
    useAppStore.setState({ profileGeneration: 8 })
    expect(controller.tabs(nextScope, session.id).chats.every(chat => !chat.exchanges.length)).toBe(true)
    api.list.mockRejectedValue(new Error('unauthorized'))
    await controller.refresh(nextScope, session.id)
    expect(controller.tabs(nextScope, session.id).chats.every(chat => !chat.exchanges.length)).toBe(true)
    expect(controller.tabs(nextScope, session.id).error).toBe('side_chat_sync_failed')
  })
})
