// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedChatBridge, type SharedChatState } from './bridge'
import { useAppStore } from '../store/app-store'
import { cursorBackendAvailable, runtimeSelectionError } from '@shared/runtime-catalog'

const prefix = '/interactive-chat/interactive_' + '1'.repeat(32)
const state = { revision: '1111111111111111:1', csrf: 'synthetic-csrf', session: { id: 'shared-one', backend: 'codex', title: 'Synthetic shared chat' }, events: [], queue: [], active: false, jobs: [], goal: { goal: null }, codex_runtime: null, claude_runtime: null, health: null, runtime_catalog: null } as unknown as SharedChatState
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('the restricted shared browser bridge', () => {
  it('keeps the manual invitation flow available after cookie-only resume is unauthorized', async () => {
    class Stream extends EventTarget { close = vi.fn(); onerror: (() => void) | null = null }
    vi.stubGlobal('EventSource', Stream)
    let redeemed = false
    let redeemAttempts = 0
    const request = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path.endsWith('/redeem')) {
        redeemAttempts++
        if (redeemAttempts === 1) return new Response(JSON.stringify({ detail: 'Invitation expired.' }), { status: 410 })
        redeemed = true
        return new Response(JSON.stringify({ csrf: 'new-csrf' }))
      }
      return redeemed
        ? new Response(JSON.stringify(state))
        : new Response(JSON.stringify({ detail: 'Enter the invitation token.' }), { status: 401 })
    })
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await expect(bridge.start()).rejects.toThrow('Enter the invitation token')
    await expect(bridge.redeem('a'.repeat(43))).rejects.toThrow('Invitation expired')
    await expect(bridge.redeem('b'.repeat(43))).resolves.toBeUndefined()
    await expect(bridge.start()).resolves.toBeUndefined()
    bridge.close()
  })

  it('reads exact participant message detail only on demand, preserving recipient edit metadata', async () => {
    const handoff = { id: 'handoff-one', message_id: 'handoff-one', conversation_id: 'pair-one', conversation_mode: 'async_route_v1',
      source_session_id: 'synthetic-peer', target_session_id: state.session.id, body: 'Original synthetic body',
      target_body: 'Recipient-edited synthetic body', message_edited_by_user: true, message_revision: 2 }
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/state') ? state : { result: { handoff } })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    await expect(bridge.api.handoffs.get('handoff-one')).resolves.toEqual(handoff)
    expect(request).toHaveBeenCalledTimes(2)
    const input = request.mock.calls[1] as unknown as [string, RequestInit]
    expect(input[0]).toBe(prefix + '/controls')
    expect(JSON.parse(String(input[1].body))).toMatchObject({ action: 'handoffs.get', payload: { id: 'handoff-one' } })
    await expect(bridge.api.handoffs.cancel('handoff-one')).rejects.toThrow('not available')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects mismatched message details without navigating to another chat', async () => {
    let handoff = { id: 'handoff-one', source_session_id: 'another-chat', target_session_id: 'different-chat', body: 'Synthetic body' }
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/state') ? state : { result: { handoff } })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    await expect(bridge.api.handoffs.get('handoff-one')).rejects.toThrow('Invalid shared chat message detail')
    handoff = { ...handoff, id: 'wrong-envelope', target_session_id: state.session.id }
    await expect(bridge.api.handoffs.get('handoff-one')).rejects.toThrow('Invalid shared chat message detail')
  })
  it('loads a semantic older page through the native store without losing its exact session', async () => {
    const event = (seq: number) => ({ id: `synthetic-${seq}`, seq, session_id: state.session.id, type: 'turn_started', prompt: `Prompt ${seq}`, ts: '2026-09-12T00:00:00Z' })
    const initial = { ...state, events: [event(3)], hasMoreEvents: true, nextTimelineBefore: 3 }
    const page = { events: [event(1)], has_more: false, next_before: null, semantic_paging: true, semantic_item_count: 1 }
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/state') ? initial : { result: page })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    const previous = useAppStore.getState()
    const previousAPI = window.agentsDock
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: bridge.api })
    try {
      useAppStore.setState({ activeProfileId: 'shared-chat', profileGeneration: 1, switchingProfileId: null,
        selectedSessionId: state.session.id, sessions: [state.session], snapshots: { [state.session.id]: bridge.snapshot() } })
      expect(await useAppStore.getState().loadOlderForSession(state.session.id)).toBe(1)
      const snapshot = useAppStore.getState().snapshots[state.session.id]
      expect(snapshot.session).toEqual(state.session)
      expect(snapshot.session.backend).toBe('codex') // Timeline's first dereference.
      expect(snapshot.events.map(row => row.seq)).toEqual([1, 3])
      expect(snapshot.hasMoreEvents).toBe(false)
      expect(request).toHaveBeenCalledTimes(2)
      expect(await bridge.api.timeline.around(state.session.id, 1)).toMatchObject({ ...page, session: state.session })
      expect(await bridge.api.timeline.historicalOlder(state.session.id, 3)).toMatchObject({ ...page, session: state.session })
    } finally {
      bridge.close()
      useAppStore.setState(previous, true)
      Object.defineProperty(window, 'agentsDock', { configurable: true, value: previousAPI })
    }
  })
  it('rejects another chat in a history page instead of injecting its events or session', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/state') ? state : { result: { events: [], session: { id: 'another-chat' } } })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    await expect(bridge.api.timeline.older(state.session.id, 10)).rejects.toThrow('Invalid shared chat history page')
    request.mockImplementation(async () => new Response(JSON.stringify({ result: { events: [{ session_id: 'another-chat' }] } })))
    await expect(bridge.api.timeline.around(state.session.id, 1)).rejects.toThrow('Invalid shared chat history page')
  })
  it.each(['network', 'server', 'receipt'] as const)('blocks a new mutation after an ambiguous %s acknowledgment, including after live updates', async failure => {
    class Stream extends EventTarget { static instance: Stream; close = vi.fn(); constructor() { super(); Stream.instance = this } }
    vi.stubGlobal('EventSource', Stream)
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/state')) return new Response(JSON.stringify(state))
      if (failure === 'network') throw new Error('Connection lost')
      return new Response(JSON.stringify(failure === 'server' ? { detail: 'Acceptance unknown' } : { accepted: true }), { status: failure === 'server' ? 503 : 200 })
    })
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, request)
    await bridge.start()
    Stream.instance.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }))
    await expect(bridge.api.turns.send({ sessionId: state.session.id, prompt: 'One synthetic prompt', fileIds: [] })).rejects.toThrow('Acceptance is unconfirmed')
    Stream.instance.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision: '1111111111111111:2' }) }))
    expect(connection).toHaveBeenLastCalledWith('terminal', expect.stringContaining('Acceptance is unconfirmed'))
    await expect(bridge.api.turns.send({ sessionId: state.session.id, prompt: 'One synthetic prompt', fileIds: [] })).rejects.toThrow('Acceptance is unconfirmed')
    await expect(bridge.api.queue.remove(state.session.id, 'queued-one')).rejects.toThrow('Acceptance is unconfirmed')
    expect(request).toHaveBeenCalledTimes(2)
    bridge.close()
  })
  it('reports typed validation denial without latching or treating it as acceptance', async () => {
    let writes = 0
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/state')) return new Response(JSON.stringify(state))
      const { action, request_id } = JSON.parse(String(init?.body))
      writes++
      return new Response(JSON.stringify(writes === 1
        ? { accepted: false, action, request_id, error_code: 'invalid_request', detail: 'Invalid chat control request' }
        : { accepted: true, action, request_id, result: { stopped: true } }), { status: writes === 1 ? 403 : 200 })
    })
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, request)
    await bridge.refresh()
    await expect(bridge.api.turns.stop(state.session.id)).rejects.toThrow('Invalid chat control request')
    await expect(bridge.api.turns.stop(state.session.id)).resolves.toEqual({ stopped: true })
    expect(connection).not.toHaveBeenCalled()
    expect(writes).toBe(2)
  })
  it('releases a failed upload batch staging count without deleting server data', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/state') ? state : { detail: 'Invalid upload name' }), { status: String(url).endsWith('/state') ? 200 : 400 }))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    const files = await Promise.all(Array.from({ length: 4 }, (_, index) => bridge.api.files.stageNativeFile(new File(['synthetic'], `file-${index}.txt`))))
    await expect(bridge.api.files.upload(state.session.id, files.map(file => file!.path))).rejects.toThrow('Invalid upload name')
    for (let index = 0; index < 4; index++) await expect(bridge.api.files.stageNativeFile(new File(['synthetic'], `replacement-${index}.txt`))).resolves.toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('retains the discovered model choices across live baseline snapshots for this chat', async () => {
    class Stream extends EventTarget { static instance: Stream; close = vi.fn(); constructor() { super(); Stream.instance = this } }
    vi.stubGlobal('EventSource', Stream)
    const baseline = { backends: { codex: { models: [{ value: 'selected', label: 'Selected' }], efforts: [] } } }
    const catalog = { backends: { codex: { models: [...baseline.backends.codex.models, { value: 'another', label: 'Another model' }], efforts: [] } } }
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(
      String(url).endsWith('/controls') ? { result: catalog } : { ...state, runtime_catalog: baseline }
    )))
    const receive = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, vi.fn(), request)
    await bridge.start()
    await bridge.catalog()
    for (const revision of ['1111111111111111:2', '2222222222222222:1']) {
      Stream.instance.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision, runtime_catalog: baseline }) }))
      expect(receive.mock.calls.at(-1)?.[0].runtime_catalog).toEqual(catalog)
    }
    expect(request).toHaveBeenCalledTimes(2) // No rediscovery or polling on updates.
    bridge.close()
  })
  it('allows the shared UI to refresh only the read-only runtime catalog', async () => {
    const baseline = { backends: { codex: { models: [{ value: 'selected', label: 'Selected' }], efforts: [] } } }
    const catalog = { backends: { codex: { models: [...baseline.backends.codex.models, { value: 'another', label: 'Another model' }], efforts: [] } } }
    const request = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(
      String(url).endsWith('/controls') ? { result: catalog } : { ...state, runtime_catalog: baseline }
    )))
    const receive = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, vi.fn(), request)
    await bridge.refresh()

    await expect(bridge.api.runtime.catalog(true)).resolves.toEqual(catalog)
    expect(request).toHaveBeenCalledTimes(2)
    const input = request.mock.calls[1] as unknown as [string, RequestInit]
    expect(input[0]).toBe(prefix + '/controls')
    expect(input[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' })
    expect(JSON.parse(String(input[1].body))).toEqual({
      action: 'runtime.catalog',
      payload: {},
      request_id: expect.any(String)
    })
    expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({ runtime_catalog: catalog })

    const unrelatedRuntimeMethod = (bridge.api.runtime as unknown as { restart(): Promise<unknown> }).restart
    await expect(unrelatedRuntimeMethod()).rejects.toThrow('not available in a shared chat')
    expect(request).toHaveBeenCalledTimes(2)
    bridge.close()
  })
  it('preserves and admits a ready shared Cursor session from its sanitized snapshot', async () => {
    const cursorState = {
      ...state,
      session: { ...state.session, backend: 'cursor', model: 'auto' },
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is ready.',
            action: null,
            version: 2,
            permission_modes: ['default', 'full_access', 'plan']
          }
        }
      },
      runtime_catalog: {
        backends: {
          cursor: {
            available: true,
            models: [{ value: '', label: 'Server default' }, { value: 'auto', label: 'Auto' }],
            efforts: [],
            diagnostic: {
              backend: 'cursor',
              status: 'ready',
              available: true,
              message: 'Cursor is installed and authenticated.'
            }
          }
        }
      }
    } as SharedChatState

    const receive = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, vi.fn(), vi.fn(async () => new Response(JSON.stringify(cursorState))))
    await bridge.refresh()
    const received = receive.mock.calls.at(-1)?.[0] as SharedChatState
    expect(received.health?.capabilities?.cursor_backend).toMatchObject({ available: true, version: 2 })
    expect(cursorBackendAvailable(received.health, received.runtime_catalog)).toBe(true)
    expect(runtimeSelectionError(received.health, received.runtime_catalog, 'cursor', received.session.model)).toBeNull()
    bridge.close()
  })
  it('rejects an oversized chooser batch without leaving a pending promise or partially staging it', async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(state)))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: Array.from({ length: 5 }, (_, index) => new File(['synthetic'], `file-${index}.txt`)) })
      this.dispatchEvent(new Event('change'))
    })
    await expect(bridge.api.files.choose()).rejects.toThrow('at most 4 files')
    for (let index = 0; index < 4; index++) await expect(bridge.api.files.stageNativeFile(new File(['synthetic'], `valid-${index}.txt`))).resolves.toMatchObject({ name: `valid-${index}.txt` })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rejects other chats, direct files, terminal and server administration without a request', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(state)))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    await expect(bridge.api.turns.stop('another-chat')).rejects.toThrow()
    await expect(bridge.api.workspace.info('shared-one')).rejects.toThrow()
    await expect(bridge.api.files.openLinked('shared-one', '/private/file')).rejects.toThrow()
    await expect(bridge.api.codex.shell('shared-one', { command: 'pwd', confirmed: true })).rejects.toThrow()
    await expect(bridge.api.sessions.update('shared-one', { cwd: '/elsewhere' })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('keeps exact queue revision and native result; no replay after ambiguous acknowledgment', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/state')) return new Response(JSON.stringify(state))
      throw new Error('Connection lost before acknowledgment')
    })
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    await expect(bridge.api.queue.update('shared-one', 'queued-one', 'Edited prompt', undefined, undefined, undefined, 4)).rejects.toThrow('Connection lost')
    expect(request).toHaveBeenCalledTimes(2)
    const input = request.mock.calls[1] as unknown as [string, RequestInit]
    const body = JSON.parse(String(input[1].body))
    expect(body).toMatchObject({ action: 'queue.edit', payload: { id: 'queued-one', prompt: 'Edited prompt', expected_message_revision: 4 } })
    expect(body.payload.session_id).toBeUndefined()
    expect(input[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', headers: { 'X-Chat-CSRF': 'synthetic-csrf' } })
  })
  it('consumes native push state without polling or a second fetch and closes its stream', async () => {
    class Stream extends EventTarget { static instance: Stream; close = vi.fn(); onerror: (() => void) | null = null; constructor() { super(); Stream.instance = this } }
    vi.stubGlobal('EventSource', Stream)
    const request = vi.fn(async () => new Response(JSON.stringify(state)))
    const receive = vi.fn()
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, connection, request)
    await bridge.start()
    expect(connection).toHaveBeenLastCalledWith('reconnecting') // A GET snapshot is not a live stream.
    const event = { id: 'event-one', seq: 1, session_id: 'shared-one', type: 'turn_started', prompt: 'Real prompt', ts: '2026-09-12T00:00:00Z' }
    Stream.instance.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision: '1111111111111111:2', events: [event], active: true }) }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls.at(-1)?.[0].events).toEqual([event])
    expect(connection).toHaveBeenLastCalledWith('live')
    Stream.instance.dispatchEvent(new MessageEvent('unavailable'))
    expect(connection).toHaveBeenLastCalledWith('terminal', 'This shared chat is no longer available.')
    await bridge.retry()
    expect(Stream.instance.close).toHaveBeenCalledTimes(1)
    bridge.close()
    expect(Stream.instance.close).toHaveBeenCalled()
  })

  it('recovers transient stream failures without replaying writes and deduplicates lifecycle retries', async () => {
    class Stream extends EventTarget {
      static instances: Stream[] = []
      close = vi.fn()
      onerror: (() => void) | null = null
      constructor() { super(); Stream.instances.push(this) }
    }
    vi.stubGlobal('EventSource', Stream)
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(state)))
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, request)
    await bridge.start()
    const first = Stream.instances[0]!
    first.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }))
    expect(connection).toHaveBeenLastCalledWith('live')

    first.onerror?.()
    expect(connection).toHaveBeenLastCalledWith('reconnecting')
    expect(first.close).not.toHaveBeenCalled()
    await expect(bridge.api.turns.send({ sessionId: state.session.id, prompt: 'Do not replay', fileIds: [] }))
      .rejects.toThrow('Reconnect before trying this action again')
    expect(request).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(Stream.instances).toHaveLength(2))
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== 'POST')).toBe(true)
    first.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision: '1111111111111111:2' }) }))
    expect(connection).toHaveBeenLastCalledWith('reconnecting')
    Stream.instances[1]!.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision: '1111111111111111:2' }) }))
    expect(connection).toHaveBeenLastCalledWith('live')

    bridge.close()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    expect(Stream.instances).toHaveLength(2)
  })

  it('turns a revoked EventSource handshake into a terminal state during lifecycle recovery', async () => {
    class Stream extends EventTarget {
      static instances: Stream[] = []
      close = vi.fn()
      onerror: (() => void) | null = null
      constructor() { super(); Stream.instances.push(this) }
    }
    vi.stubGlobal('EventSource', Stream)
    let revoked = false
    const request = vi.fn(async () => revoked
      ? new Response(JSON.stringify({ detail: 'This shared chat was revoked.' }), { status: 404 })
      : new Response(JSON.stringify(state)))
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, request)
    await bridge.start()
    Stream.instances[0]!.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }))
    Stream.instances[0]!.onerror?.()
    revoked = true
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(connection).toHaveBeenLastCalledWith('terminal', 'This shared chat was revoked.'))
    expect(Stream.instances).toHaveLength(1)
    expect(Stream.instances[0]!.close).toHaveBeenCalledTimes(1)
    await bridge.retry()
    expect(request).toHaveBeenCalledTimes(2)
    bridge.close()
  })

  it('keeps a stream that recovers natively while lifecycle state revalidation is in flight', async () => {
    class Stream extends EventTarget {
      static instances: Stream[] = []
      close = vi.fn()
      onerror: (() => void) | null = null
      constructor() { super(); Stream.instances.push(this) }
    }
    vi.stubGlobal('EventSource', Stream)
    let reads = 0
    let failRefresh!: (error: Error) => void
    const request = vi.fn(async () => {
      reads++
      if (reads === 1) return new Response(JSON.stringify(state))
      return new Promise<Response>((_resolve, reject) => { failRefresh = reject })
    })
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, request)
    await bridge.start()
    const stream = Stream.instances[0]!
    stream.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }))
    stream.onerror?.()
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(reads).toBe(2))
    const recovery = bridge.retry()
    const recovered = { ...state, revision: '1111111111111111:2' }
    stream.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(recovered) }))
    failRefresh(new Error('Stale state request failed'))
    await expect(recovery).rejects.toThrow('Stale state request failed')
    expect(connection).toHaveBeenLastCalledWith('live')
    expect(Stream.instances).toHaveLength(1)
    expect(stream.close).not.toHaveBeenCalled()
    bridge.close()
  })

  it('latches malformed stream state and does not reconnect it', async () => {
    class Stream extends EventTarget {
      static instances: Stream[] = []
      close = vi.fn()
      onerror: (() => void) | null = null
      constructor() { super(); Stream.instances.push(this) }
    }
    vi.stubGlobal('EventSource', Stream)
    const connection = vi.fn()
    const bridge = createSharedChatBridge(prefix, vi.fn(), connection, vi.fn(async () => new Response(JSON.stringify(state))))
    await bridge.start()
    Stream.instances[0]!.dispatchEvent(new MessageEvent('state', { data: '{not-json' }))
    expect(connection).toHaveBeenLastCalledWith('terminal', expect.stringContaining('invalid data'))
    expect(Stream.instances[0]!.close).toHaveBeenCalledTimes(1)
    await bridge.retry()
    window.dispatchEvent(new Event('online'))
    expect(Stream.instances).toHaveLength(1)
    bridge.close()
  })
})
