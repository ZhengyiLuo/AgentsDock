// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedChatBridge, type SharedChatState } from './bridge'

const prefix = '/interactive-chat/interactive_' + '1'.repeat(32)
const state = { revision: '1111111111111111:1', csrf: 'synthetic-csrf', session: { id: 'shared-one', backend: 'codex', title: 'Synthetic shared chat' }, events: [], queue: [], active: false, jobs: [], goal: { goal: null }, codex_runtime: null, claude_runtime: null, health: null, runtime_catalog: null } as unknown as SharedChatState
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('the restricted shared browser bridge', () => {
  it('rejects an oversized chooser batch without leaving a pending promise or partially staging it', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(state)))
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
    expect(connection).not.toHaveBeenCalled() // A GET snapshot is not a live stream.
    const event = { id: 'event-one', seq: 1, session_id: 'shared-one', type: 'turn_started', prompt: 'Real prompt', ts: '2026-09-12T00:00:00Z' }
    Stream.instance.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ ...state, revision: '1111111111111111:2', events: [event], active: true }) }))
    expect(request).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls.at(-1)?.[0].events).toEqual([event])
    expect(connection).toHaveBeenLastCalledWith(true)
    Stream.instance.dispatchEvent(new MessageEvent('unavailable'))
    expect(connection).toHaveBeenLastCalledWith(false, 'This shared chat is no longer available.')
    bridge.close()
    expect(Stream.instance.close).toHaveBeenCalled()
  })
})
