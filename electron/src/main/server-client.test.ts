import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '../shared/types'
import { AgentServerClient } from './server-client'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>()
  readonly sent: unknown[] = []
  closed = false
  readyState = 1
  binaryType = ''

  constructor(readonly url: URL) { FakeWebSocket.instances.push(this) }
  addEventListener(name: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  send(data: unknown): void { this.sent.push(data) }
  close(): void { this.closed = true; this.readyState = 3 }
  emit(name: string, data?: unknown, event: { code?: number; reason?: string } = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data, ...event })
  }
}

describe('AgentServerClient live stream', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeWebSocket.instances = [] })

  it('reconnects after the newest received sequence instead of replaying the stream', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received: Event[] = []
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const stop = client.stream('chat', 5, event => received.push(event), () => {})
    const first = FakeWebSocket.instances[0]
    expect(String(first.url)).toContain('after=5')
    first.emit('open')
    first.emit('message', JSON.stringify({ id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    first.emit('close')
    vi.advanceTimersByTime(500)
    const second = FakeWebSocket.instances[1]
    expect(String(second.url)).toContain('after=6')
    second.emit('message', JSON.stringify({ id: 'e6-again', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    expect(received).toHaveLength(1)
    stop()
    expect(second.closed).toBe(true)
  })

  it('can issue a lightweight visible tail check after the cached sequence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' },
      events: [],
      queued_turns: [],
      events_omitted_before: 0,
      event_count: 80
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.sessionPage('chat', { after: 42, limit: 120, tail: false, visible: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat?')
    expect(url).toContain('after=42')
    expect(url).toContain('tail=false')
    expect(url).toContain('visible=true')
    expect(new Headers(init.headers).get('X-ZenithDock-Token')).toBe('secret')
  })

  it('requests the adjacent previous page and preserves directional pagination metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' },
      events: [{ id: 'e80', session_id: 'chat', seq: 80, type: 'assistant_text', ts: 'now', text: 'Older' }],
      queued_turns: [],
      events_omitted_before: 42,
      events_omitted_after: 0,
      latest_seq: 100,
      event_count: 180
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const page = await client.sessionPage('chat', { before: 100, limit: 120, tail: true, visible: true })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('before=100')
    expect(url).toContain('tail=true')
    expect(page).toMatchObject({ has_more: true, latest_seq: 100, events_omitted_before: 42, events_omitted_after: 0 })
  })

  it('authorizes server-side linked file requests without exposing the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('file', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.linkedFileRequest('chat', 'out/report.csv')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat/links/file?target=out%2Freport.csv')
    expect(url).not.toContain('secret')
    expect(new Headers(init.headers).get('X-ZenithDock-Token')).toBe('secret')
  })

  it('searches complete history across chats through one authenticated request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ session_id: 'chat-a', event_id: 'event-8', seq: 8, role: 'assistant', snippet: 'Force gate audit complete.' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const results = await client.searchSessions('force gate', 75)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/search?')
    expect(url).toContain('q=force+gate')
    expect(url).toContain('limit=75')
    expect(new Headers(init.headers).get('X-ZenithDock-Token')).toBe('secret')
    expect(results[0]).toMatchObject({ session_id: 'chat-a', seq: 8 })
  })

  it('downloads the complete per-turn patch as authenticated text', async () => {
    const patch = 'diff --git a/app.ts b/app.ts\n-old\n+new\n'
    const fetchMock = vi.fn().mockResolvedValue(new Response(patch, {
      status: 200,
      headers: { 'Content-Type': 'text/x-diff' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await expect(client.codeDiff('chat one', 'run-42')).resolves.toBe(patch)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat%20one/diffs/run-42')
    expect(new Headers(init.headers).get('X-ZenithDock-Token')).toBe('secret')
  })

  it('closes a specific tmux window through the structured terminal API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'chat',
      name: 'zd_chat',
      exists: true,
      windows: [{ id: '@1', index: 0, name: 'bash', active: true, panes: 1 }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.terminalAction('chat', 'kill-window', '2')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat/terminal/action')
    expect(JSON.parse(String(init.body))).toEqual({ action: 'kill-window', target: '2' })
  })

  it('attaches a binary terminal stream with dimensions, input, resize, and intentional detach', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const output: string[] = []
    const states: string[] = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const connection = client.terminal(
      'chat with spaces',
      { cwd: '/tmp/project path', columns: 132, rows: 44 },
      data => output.push(data),
      state => states.push(state.state)
    )
    const socket = FakeWebSocket.instances[0]
    expect(String(socket.url)).toContain('/api/sessions/chat%20with%20spaces/terminal/ws')
    expect(socket.url.searchParams.get('token')).toBe('secret')
    expect(socket.url.searchParams.get('cwd')).toBe('/tmp/project path')
    expect(socket.url.searchParams.get('columns')).toBe('132')
    expect(socket.url.searchParams.get('rows')).toBe('44')

    socket.emit('message', JSON.stringify({ type: 'ready', name: 'zd_chat_with_spaces' }))
    socket.emit('message', new TextEncoder().encode('hello λ\r\n').buffer)
    expect(states).toEqual(['connecting', 'connected'])
    expect(output.join('')).toBe('hello λ\r\n')

    connection.write('pwd\r')
    connection.resize(160, 52)
    connection.scroll(-6)
    expect(new TextDecoder().decode(socket.sent[0] as Uint8Array)).toBe('pwd\r')
    expect(JSON.parse(String(socket.sent[1]))).toEqual({ type: 'resize', columns: 160, rows: 52 })
    expect(JSON.parse(String(socket.sent[2]))).toEqual({ type: 'scroll', delta: -6 })

    connection.close()
    socket.emit('close', undefined, { code: 1000 })
    vi.advanceTimersByTime(20_000)
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states.at(-1)).toBe('disconnected')
  })
})
