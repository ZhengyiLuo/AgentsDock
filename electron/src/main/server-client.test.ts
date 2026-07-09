import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '../shared/types'
import { AgentServerClient } from './server-client'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>()
  closed = false

  constructor(readonly url: URL) { FakeWebSocket.instances.push(this) }
  addEventListener(name: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  close(): void { this.closed = true }
  emit(name: string, data?: string): void { for (const listener of this.listeners.get(name) ?? []) listener({ data }) }
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
})
