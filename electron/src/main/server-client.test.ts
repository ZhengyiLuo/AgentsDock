import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../shared/event-compaction'
import type { Event, PinnedItem, ServerUpdateStatus, Session } from '../shared/types'
import {
  AgentServerClient,
  LOCAL_SESSION_IMPORT_RESPONSE_MAX_BYTES,
  LOCAL_SESSION_LIST_RESPONSE_MAX_BYTES,
  uploadRequestTimeoutMs
} from './server-client'
import { PinRevisionConflictError } from './pin-sync'
import { TEAM_MAIL_HINTS_PATH, TEAM_MAIL_HINTS_PROTOCOL, type MailboxCoverage } from '../shared/team-mail-hints'
import { emptyBulletinCursor, TEAM_ACTIVITY_HINTS_PROTOCOL, type BulletinChangeCursor } from '../shared/team-bulletin-hints'
import { appLog } from './logger'

vi.mock('./logger', () => ({ appLog: vi.fn() }))

describe('AgentServerClient network diagnostics', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(appLog).mockClear() })

  it('records nested socket codes without secrets and preserves the original failure without retrying', async () => {
    const socket = Object.assign(new Error('secret token and request body'), { code: 'ECONNRESET', syscall: 'read' })
    const cause = Object.assign(new AggregateError([socket], 'private query'), { code: 'UND_ERR_SOCKET' })
    const error = new TypeError('fetch failed with secret', { cause })
    const fetchMock = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret-token')

    await expect(client.health()).rejects.toBe(error)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(appLog).toHaveBeenCalledWith('transport', 'server request failed', {
      origin: 'http://example.test:7850', path: '/api/health', method: 'GET', durationMs: expect.any(Number),
      error: { name: 'TypeError', cause: { name: 'AggregateError', code: 'UND_ERR_SOCKET', errors: [{ name: 'Error', code: 'ECONNRESET', syscall: 'read' }] } }
    })
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toMatch(/secret|private/)
  })
})

async function withLocalHTTPServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseURL: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      response.statusCode = 500
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ detail: error instanceof Error ? error.message : 'test server failed' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

async function incomingBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>()
  readonly sent: unknown[] = []
  closed = false
  readyState = 1
  binaryType = ''
  protocol: string

  constructor(readonly url: URL, readonly protocols?: string | string[]) {
    this.protocol = typeof protocols === 'string' ? protocols : protocols?.[0] ?? ''
    FakeWebSocket.instances.push(this)
  }
  addEventListener(name: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  send(data: unknown): void { this.sent.push(data) }
  close(): void { this.closed = true; this.readyState = 3 }
  emit(name: string, data?: unknown, event: { code?: number; reason?: string } = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data, ...event })
  }
}

describe('Team Mail metadata websocket', () => {
  const mailbox = { hub_id: 'hub-a', team_id: 'team-a', recipient_server_id: null }
  const cursor = { version: 1 as const, team_id: 'team-a', recipient_server_id: 'node-a',
    through_sequence: 3, arrival_id: `tmsg_${'a'.repeat(32)}` }
  const snapshot = { type: 'snapshot', server_identity: 'server-a', hub_id: 'hub-a', stream_id: 'a'.repeat(32),
    cursor: { ...cursor, reset: false } }
  afterEach(() => { FakeWebSocket.instances = []; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  function connect(previous: () => MailboxCoverage | null = () => null, activity?: { previousBulletin(): BulletinChangeCursor | null }) {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('https://example.test:7850', 'private-token')
    const packet = vi.fn(), fatal = vi.fn(), disconnected = vi.fn()
    const stop = client.mailHintStream('server-a', mailbox, previous, packet, fatal, disconnected, activity)
    return { client, packet, fatal, disconnected, stop, fetchMock, socket: FakeWebSocket.instances.at(-1)! }
  }
  it('uses only bounded metadata and subprotocol credentials, with no idle requests or timers', () => {
    const test = connect(() => cursor)
    expect(test.socket.url.pathname).toBe(TEAM_MAIL_HINTS_PATH)
    expect(test.socket.url.search).toBe('')
    expect(test.socket.protocols).toEqual([TEAM_MAIL_HINTS_PROTOCOL, `agentsdock-token.${Buffer.from('private-token').toString('base64url')}`])
    test.socket.emit('open')
    expect(JSON.parse(String(test.socket.sent[0]))).toEqual({ version: 1, team_id: 'team-a', previous_cursor: cursor })
    test.socket.emit('message', JSON.stringify(snapshot))
    test.socket.emit('message', JSON.stringify({ ...snapshot, type: 'hint' }))
    vi.advanceTimersByTime(300_000)
    expect(test.packet).toHaveBeenCalledTimes(2)
    expect(test.fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    test.stop()
  })
  it.each([
    { ...snapshot, type: 'hint' },
    { ...snapshot, server_identity: 'foreign' },
    { ...snapshot, hub_id: 'foreign' },
    { ...snapshot, cursor: { ...snapshot.cursor, team_id: 'foreign' } },
    { ...snapshot, body: 'not metadata' },
    { ...snapshot, stream_id: `${'a'.repeat(32)}\n` },
    { ...snapshot, cursor: { ...snapshot.cursor, arrival_id: `${cursor.arrival_id}\n` } }
  ])('fails closed on a malformed or wrong-scope first frame', invalid => {
    const test = connect()
    test.socket.emit('message', JSON.stringify(invalid))
    vi.advanceTimersByTime(30_000)
    expect(test.packet).not.toHaveBeenCalled()
    expect(test.fatal).toHaveBeenCalledOnce()
    expect(test.socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
  it('requires reset proof for a foreign retained recipient and never permits a midstream switch', () => {
    const test = connect(() => ({ ...cursor, recipient_server_id: 'old-node' }))
    test.socket.emit('open')
    test.socket.emit('message', JSON.stringify({ ...snapshot, cursor: { ...snapshot.cursor, reset: true } }))
    expect(test.packet).toHaveBeenCalledOnce()
    test.socket.emit('message', JSON.stringify({ ...snapshot, type: 'hint', cursor: { ...snapshot.cursor, recipient_server_id: 'other-node' } }))
    expect(test.packet).toHaveBeenCalledOnce()
    expect(test.fatal).toHaveBeenCalledOnce()
  })
  it('rejects an unreset retained-recipient replacement before projecting it', () => {
    const test = connect(() => ({ ...cursor, recipient_server_id: 'old-node' }))
    test.socket.emit('open')
    test.socket.emit('message', JSON.stringify(snapshot))
    expect(test.packet).not.toHaveBeenCalled()
    expect(test.fatal).toHaveBeenCalledOnce()
  })
  it.each([1008, 4401, 4403, 4406])('does not retry fatal close %i', code => {
    const test = connect()
    test.socket.emit('close', undefined, { code, reason: 'must not expose raw reason' })
    vi.advanceTimersByTime(30_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(test.fatal).toHaveBeenCalledWith()
    expect(test.disconnected).not.toHaveBeenCalled()
  })
  it.each([1012, 1013, 1006])('reconnects transport failure %i and fences old socket packets', code => {
    let retained: MailboxCoverage | null = null
    const test = connect(() => retained)
    test.socket.emit('open')
    test.socket.emit('message', JSON.stringify(snapshot))
    test.socket.emit('close', undefined, { code })
    expect(test.disconnected).toHaveBeenCalledOnce()
    retained = cursor
    vi.advanceTimersByTime(500)
    const next = FakeWebSocket.instances[1]
    next.emit('open')
    expect(JSON.parse(String(next.sent[0])).previous_cursor).toEqual(cursor)
    test.socket.emit('message', JSON.stringify({ ...snapshot, type: 'hint' }))
    expect(test.packet).toHaveBeenCalledOnce()
    next.emit('message', JSON.stringify({ ...snapshot, stream_id: 'b'.repeat(32) }))
    expect(test.packet).toHaveBeenCalledTimes(2)
    test.client.dispose()
    next.emit('message', JSON.stringify({ ...snapshot, type: 'hint' }))
    vi.advanceTimersByTime(30_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(next.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds the initial snapshot wait even after a socket opens', () => {
    const test = connect()
    test.socket.emit('open')
    vi.advanceTimersByTime(30_000)
    expect(test.socket.closed).toBe(false)
    expect(test.disconnected).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(test.socket.closed).toBe(true)
    expect(test.disconnected).toHaveBeenCalledOnce()
    test.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not send a retained cursor when the server fails to negotiate the exact protocol', () => {
    const test = connect(() => cursor)
    test.socket.protocol = ''
    test.socket.emit('open')
    expect(test.socket.sent).toEqual([])
    expect(test.fatal).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('negotiates one v2 stream with independent retained heads and no idle content requests', () => {
    const bulletin = emptyBulletinCursor('team-a')
    const test = connect(() => cursor, { previousBulletin: () => bulletin })
    expect(test.socket.protocol).toBe(TEAM_ACTIVITY_HINTS_PROTOCOL)
    test.socket.emit('open')
    expect(JSON.parse(String(test.socket.sent[0]))).toEqual({ version: 2, team_id: 'team-a',
      previous_cursor: { version: 2, mail: { ...cursor, reset: false }, bulletin: { ...bulletin, reset: false } } })
    test.socket.emit('message', JSON.stringify({ ...snapshot,
      cursor: { version: 2, mail: snapshot.cursor, bulletin: { ...bulletin, reset: false } } }))
    expect(test.packet).toHaveBeenCalledWith({ ...snapshot, bulletin: { ...bulletin, reset: false } })
    vi.advanceTimersByTime(600_000)
    expect(test.fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    test.stop()
  })
  it('rejects foreign Bulletin metadata without retry loops or silently mixing protocol versions', () => {
    const test = connect(() => null, { previousBulletin: () => null })
    test.socket.emit('message', JSON.stringify({ ...snapshot,
      cursor: { version: 2, mail: snapshot.cursor, bulletin: { ...emptyBulletinCursor('foreign'), reset: false } } }))
    expect(test.fatal).toHaveBeenCalledOnce()
    expect(test.packet).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(test.fetchMock).not.toHaveBeenCalled()
  })
})

describe('AgentServerClient Claude session policy', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('includes the additive Claude permission mode when creating a chat', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: {
          id: 'claude-chat', title: 'Claude', folder: 'General', cwd: '/work', backend: 'claude',
          claude_permission_mode: 'acceptEdits'
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createSession({
      title: 'Claude',
      folder: 'General',
      cwd: '/work',
      backend: 'claude',
      claude_permission_mode: 'acceptEdits'
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({
      backend: 'claude',
      claude_permission_mode: 'acceptEdits'
    }))
  })
})

describe('AgentServerClient Cursor session policy', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('includes the additive Cursor permission mode when creating a chat', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: {
          id: 'cursor-chat', title: 'Cursor', folder: 'General', cwd: '/work', backend: 'cursor',
          cursor_permission_mode: 'full_access'
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createSession({
      title: 'Cursor',
      folder: 'General',
      cwd: '/work',
      backend: 'cursor',
      cursor_permission_mode: 'full_access'
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({
      backend: 'cursor',
      cursor_permission_mode: 'full_access'
    }))
  })

  it('resumes Cursor provider context without claiming to import its transcript', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: { id: 'cursor-chat', title: 'Cursor', folder: 'General', cwd: '/work', backend: 'cursor' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createSession({
      title: 'Cursor', folder: 'General', cwd: '/work', backend: 'cursor', providerId: 'cursor-session-1'
    })

    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({
      backend: 'cursor',
      provider_session_id: 'cursor-session-1',
      import_history: false
    }))
  })

  it('keeps transcript import enabled for a Claude provider resume', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: { id: 'claude-chat', title: 'Claude', folder: 'General', cwd: '/work', backend: 'claude' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createSession({
      title: 'Claude', folder: 'General', cwd: '/work', backend: 'claude', providerId: 'claude-session-1'
    })

    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({ import_history: true }))
  })

  it('normalizes legacy auto-review writes to the safe Cursor default', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: { id: 'cursor-chat', title: 'Cursor', folder: 'General', cwd: '/work', backend: 'cursor', cursor_permission_mode: 'default' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createSession({
      title: 'Cursor', folder: 'General', cwd: '/work', backend: 'cursor',
      cursor_permission_mode: 'auto_review'
    } as unknown as Parameters<AgentServerClient['createSession']>[0])
    await client.updateSession('cursor-chat', {
      cursor_permission_mode: 'auto_review'
    } as unknown as Parameters<AgentServerClient['updateSession']>[1])

    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({ cursor_permission_mode: 'default' }))
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ cursor_permission_mode: 'default' })
  })
})

describe('AgentServerClient scheduled-job serialization', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('sends only fields in the job create and update contracts', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        job: { id: 'job-1', session_id: 'chat-1', title: 'Status', prompt: 'Check', interval_seconds: 60 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.createJob({
      session_id: 'chat-1', title: 'Status', prompt: 'Check', interval_seconds: 60,
      loop: true, enabled: true, context_mode: 'standalone', backend: 'cursor',
      model: 'must-not-leak', effort: 'high'
    } as Parameters<AgentServerClient['createJob']>[0] & { model: string; effort: string })
    await client.updateJob('job-1', {
      enabled: false, model: 'must-not-leak', effort: 'high'
    } as Parameters<AgentServerClient['updateJob']>[1] & { model: string; effort: string })

    const createBody = JSON.parse(String(calls[0].init.body))
    const updateBody = JSON.parse(String(calls[1].init.body))
    expect(createBody).toEqual(expect.objectContaining({ context_mode: 'standalone', backend: 'cursor' }))
    expect(createBody).not.toHaveProperty('model')
    expect(createBody).not.toHaveProperty('effort')
    expect(updateBody).toEqual({ enabled: false })
  })

  it('preserves a deferred Run Now result from AgentsServer', async () => {
    const deferredResult = {
      ok: true,
      job_id: 'job-1',
      run_id: null,
      queued: true,
      deferred: true,
      manual_run_pending: true,
      message: 'Run now is queued until the chat is available.'
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(deferredResult), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.runJob('job-1')).resolves.toEqual(deferredResult)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/jobs/job-1/run')
    expect(init.method).toBe('POST')
  })
})

describe('AgentServerClient local session import', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('lists local session candidates from GET /api/local-sessions', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        sessions: [
          { provider_session_id: 'claude-abc', backend: 'claude', label: 'widget: hello', updated_at: '2026-08-01T00:00:00Z', cwd: '/work/widget' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    const candidates = await client.listLocalSessions()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/local-sessions?limit=500')
    expect(candidates).toEqual([
      { provider_session_id: 'claude-abc', backend: 'claude', label: 'widget: hello', updated_at: '2026-08-01T00:00:00Z', cwd: '/work/widget' }
    ])
  })

  it('posts the exact items to POST /api/sessions/bulk-import and returns per-item results', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        results: [{ provider_session_id: 'claude-abc', backend: 'claude', session_id: 'sess_1', ok: true, imported: 4 }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    const items = [{ provider_session_id: 'claude-abc', backend: 'claude' as const, cwd: '/work/widget' }]
    const results = await client.bulkImportSessions(items)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/sessions/bulk-import')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ items })
    expect(results).toEqual([{ provider_session_id: 'claude-abc', backend: 'claude', session_id: 'sess_1', ok: true, imported: 4 }])
  })

  it('rejects malformed local session responses at the main-process client boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      sessions: [
        { provider_session_id: 'claude-abc', backend: 'other', label: 'hello', updated_at: '2026-08-01T00:00:00Z', cwd: null }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.listLocalSessions()).rejects.toThrow(/invalid local session 1 backend/i)
  })

  it('rejects bulk results that do not correspond exactly to the requested backend and provider ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ provider_session_id: 'claude-abc', backend: 'codex', session_id: 'sess_1', ok: true, imported: 4 }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.bulkImportSessions([
      { provider_session_id: 'claude-abc', backend: 'claude' }
    ])).rejects.toThrow(/does not match the request/i)
  })

  it('rejects oversized bulk requests before making a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.bulkImportSessions(Array.from({ length: 26 }, (_, index) => ({
      provider_session_id: `provider-${index}`,
      backend: 'claude' as const
    })))).rejects.toThrow(/between 1 and 25 items/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized local-session response from Content-Length before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"sessions":[]}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(LOCAL_SESSION_LIST_RESPONSE_MAX_BYTES + 1)
      }
    })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.listLocalSessions()).rejects.toThrow(/exceeds.*safety limit/i)
  })

  it('rejects an oversized chunked bulk-import response without a Content-Length header', async () => {
    const chunk = new Uint8Array(Math.floor(LOCAL_SESSION_IMPORT_RESPONSE_MAX_BYTES / 2) + 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.bulkImportSessions([
      { provider_session_id: 'claude-abc', backend: 'claude' }
    ])).rejects.toThrow(/exceeds.*safety limit/i)
  })
})

describe('AgentServerClient health capability parsing', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('accepts only the exact top-level Bulletin alias capability', async () => {
    const alias = {
      available: true, required: false, version: 1,
      mention: '@@bulletin', legacy_mention: '@@all'
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, capabilities: { team_bulletin_alias_v1: alias }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, capabilities: { team_bulletin_alias_v1: { ...alias, mention: '@@all' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.health()).resolves.toMatchObject({
      capabilities: { team_bulletin_alias_v1: alias }
    })
    await expect(client.health()).rejects.toThrow('Team Bulletin alias capability')
  })
})

describe('AgentServerClient managed restart', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('uses the authenticated admin route and preserves the exact fenced restart request', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const phase = init.method === 'POST' ? 'accepted' : 'idle'
      return new Response(JSON.stringify({ phase, message: `${phase}.` }), {
        status: init.method === 'POST' ? 202 : 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'chat-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true as const
    }

    await expect(client.serverRestartStatus()).resolves.toMatchObject({ phase: 'idle' })
    await expect(client.restartServer(request)).resolves.toMatchObject({ phase: 'accepted' })

    const [statusURL, statusInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [restartURL, restartInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(statusURL).toBe('http://example.test:7850/api/admin/restart')
    expect(statusInit.method).toBeUndefined()
    expect(statusInit.redirect).toBe('error')
    expect(restartURL).toBe('http://example.test:7850/api/admin/restart')
    expect(restartInit.method).toBe('POST')
    expect(restartInit.redirect).toBe('error')
    expect(JSON.parse(String(restartInit.body))).toEqual(request)
    const headers = new Headers(restartInit.headers)
    expect(headers.get('X-AgentsDock-Token')).toBe('chat-secret')
    expect(headers.get('X-AgentsServer-Admin-Token')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Origin')).toBeNull()
    expect(headers.get('Sec-Fetch-Site')).toBeNull()
  })

  it('preserves every explicit force-restart fence without translating the wire fields', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init: RequestInit = {}) => new Response(JSON.stringify({
      phase: 'accepted',
      forced: true,
      update_schedule_id: '1'.repeat(32),
      message: 'Forced restart accepted.'
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://192.0.2.44:7850', 'chat-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true as const,
      force: true as const,
      force_confirmed: true as const,
      expected_blocker_revision: 'a'.repeat(64),
      expected_update_schedule_id: '1'.repeat(32)
    }

    await expect(client.restartServer(request)).resolves.toMatchObject({
      forced: true,
      update_schedule_id: '1'.repeat(32)
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [restartURL, restartInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(restartURL).toBe('http://192.0.2.44:7850/api/admin/restart')
    expect(restartInit.method).toBe('POST')
    expect(JSON.parse(String(restartInit.body))).toEqual(request)
  })

  it('fails closed on redirects during a bounded restart health probe', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init: RequestInit = {}) => new Response(null, {
      status: 302,
      headers: { Location: 'https://redirect.example.test/api/health' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'chat-secret')

    await expect(client.health(250, 'error')).rejects.toMatchObject({ status: 302 })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('chat-secret')
  })

  it('does not retry an ambiguous restart transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connection closed'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.restartServer({
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true
    })).rejects.toThrow('connection closed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('AgentServerClient authenticated redirect boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('does not follow a same-origin redirect for a binary/range request', async () => {
    const requests: Array<{ url: string; token: string | undefined; range: string | undefined }> = []
    await withLocalHTTPServer((request, response) => {
      requests.push({
        url: request.url ?? '',
        token: request.headers['x-agentsdock-token'] as string | undefined,
        range: request.headers.range
      })
      if (request.url === '/redirect-target') {
        response.end('must not be reached')
        return
      }
      response.statusCode = 307
      response.setHeader('Location', '/redirect-target')
      response.end()
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'binary-secret')
      const request = new Request('https://renderer.invalid/file', {
        headers: { Range: 'bytes=1-4' }
      })
      await expect(client.fileRequest('chat', 'file', request)).rejects.toThrow()
    })

    expect(requests).toEqual([{
      url: '/api/sessions/chat/files/file',
      token: 'binary-secret',
      range: 'bytes=1-4'
    }])
  })

  it('does not follow a cross-origin redirect or disclose the profile token', async () => {
    const targetTokens: Array<string | undefined> = []
    await withLocalHTTPServer((request, response) => {
      targetTokens.push(request.headers['x-agentsdock-token'] as string | undefined)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
    }, async targetURL => {
      const sourceRequests: string[] = []
      await withLocalHTTPServer((request, response) => {
        sourceRequests.push(request.url ?? '')
        response.statusCode = 302
        response.setHeader('Location', `${targetURL}/capture`)
        response.end()
      }, async sourceURL => {
        const client = new AgentServerClient(sourceURL, 'must-not-leak')
        await expect(client.health()).rejects.toThrow()
      })
      expect(sourceRequests).toEqual(['/api/health'])
    })

    expect(targetTokens).toEqual([])
  })
})

describe('AgentServerClient secure peer transport', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('uses exact JSON framing and no browser authority headers for controls', async () => {
    const received: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    await withLocalHTTPServer(async (request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await incomingBody(request)
      })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ configured: true }))
    }, async baseURL => {
      const fetchMock = vi.fn(() => { throw new Error('global fetch must not be used') })
      vi.stubGlobal('fetch', fetchMock)
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      const input = { enabled: true, expected_server_identity: 'server-a' }

      await expect(client.configureSecurePeerHost(input)).resolves.toEqual({ configured: true })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(received).toHaveLength(1)
      expect(received[0].method).toBe('PUT')
      expect(received[0].url).toBe('/api/admin/secure-peers/v1/host')
      expect(JSON.parse(received[0].body)).toEqual(input)
      expect(received[0].headers['x-agentsdock-token']).toBe('exact-control-secret')
      expect(received[0].headers['content-type']).toBe('application/json')
      expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(received[0].body)))
      for (const name of [
        'authorization', 'cookie', 'origin', 'sec-fetch-mode', 'sec-fetch-site',
        'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host',
        'x-forwarded-proto', 'x-real-ip', 'x-zenithdock-token', 'user-agent'
      ]) expect(received[0].headers[name]).toBeUndefined()
    })
  })

  it('strips caller authority and proxies JSON plus bounded attachment bytes only on the bound route', async () => {
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const received: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    await withLocalHTTPServer(async (request, response) => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body: await incomingBody(request) })
      if (request.url?.endsWith('/network/attachments/attachment-1/content')) {
        if (request.method === 'PUT') {
          response.statusCode = 204
          response.end()
          return
        }
        const bytes = Buffer.from('2345')
        response.statusCode = 206
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Content-Length', String(bytes.byteLength))
        response.setHeader('Content-Range', 'bytes 1-4/6')
        response.end(bytes)
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ accepted: true }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      const basePath = `/api/team-hub-secure/${connectionId}`
      const proxyFetch = client.secureTeamHubProxyFetch(basePath)
      const body = JSON.stringify({ message: 'hello' })
      const response = await proxyFetch(`${baseURL}${basePath}/v1/messages?limit=2`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer must-not-leave',
          Cookie: 'ambient=yes',
          Origin: 'https://browser.example',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-AgentsDock-Token': 'caller-token',
          'X-ZenithDock-Token': 'legacy-token'
        },
        body
      })

      await expect(response.json()).resolves.toEqual({ accepted: true })
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ method: 'POST', url: `${basePath}/v1/messages?limit=2`, body })
      expect(received[0].headers['x-agentsdock-token']).toBe('exact-control-secret')
      expect(received[0].headers.authorization).toBeUndefined()
      expect(received[0].headers.cookie).toBeUndefined()
      expect(received[0].headers.origin).toBeUndefined()
      expect(received[0].headers['sec-fetch-mode']).toBeUndefined()
      expect(received[0].headers['sec-fetch-site']).toBeUndefined()
      expect(received[0].headers['x-zenithdock-token']).toBeUndefined()

      const contentURL = `${baseURL}${basePath}/v1/teams/team-1/network/attachments/attachment-1/content`
      const uploaded = Buffer.from('012345')
      await expect(proxyFetch(contentURL, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer must-not-leave',
          'Content-Range': 'bytes 0-5/6'
        },
        body: uploaded
      })).resolves.toMatchObject({ status: 204 })
      const downloaded = await proxyFetch(contentURL, { headers: { Range: 'bytes=1-4' } })
      expect(downloaded.status).toBe(206)
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from('2345'))
      expect(received[1]).toMatchObject({ method: 'PUT', url: contentURL.slice(baseURL.length), body: '012345' })
      expect(received[1].headers['content-range']).toBe('bytes 0-5/6')
      expect(received[1].headers['x-agentsdock-token']).toBe('exact-control-secret')
      expect(received[1].headers.authorization).toBeUndefined()
      expect(received[2]).toMatchObject({ method: 'GET', url: contentURL.slice(baseURL.length), body: '' })
      expect(received[2].headers.range).toBe('bytes=1-4')
      await expect(proxyFetch(contentURL, {
        method: 'PUT',
        headers: {
          'Content-Range': 'bytes 0-5/6',
          Range: 'bytes=0-5'
        },
        body: uploaded
      })).rejects.toThrow('uploads cannot carry a Range header')
      expect(received).toHaveLength(3)
    })
  })

  it.each([
    {
      label: 'secure-peer',
      basePath: '/api/team-hub-secure/09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      proxy: (client: AgentServerClient, basePath: string) => client.secureTeamHubProxyFetch(basePath)
    },
    {
      label: 'server-hosted',
      basePath: '/api/team-hub-server',
      proxy: (client: AgentServerClient, basePath: string) => client.serverTeamHubProxyFetch(basePath)
    }
  ])('forwards an empty $label Teamspace DELETE on the exact JSON route', async ({ basePath, proxy }) => {
    const received: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    await withLocalHTTPServer(async (request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await incomingBody(request)
      })
      response.statusCode = 204
      response.end()
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      const proxyFetch = proxy(client, basePath)
      const target = `${baseURL}${basePath}/v1/teams/team-1/network/messages/message-1`
      const body = JSON.stringify({ idempotency_key: 'delete-message-1' })

      await expect(proxyFetch(target, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer must-not-leave',
          Cookie: 'ambient=yes',
          'X-AgentsDock-Token': 'caller-token'
        },
        body
      })).resolves.toMatchObject({ status: 204 })

      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        method: 'DELETE',
        url: target.slice(baseURL.length),
        body
      })
      expect(received[0].headers['x-agentsdock-token']).toBe('exact-control-secret')
      expect(received[0].headers['content-type']).toBe('application/json')
      expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)))
      expect(received[0].headers.authorization).toBeUndefined()
      expect(received[0].headers.cookie).toBeUndefined()
    })
  })

  it('fails closed on redirects without replaying the control token', async () => {
    const paths: string[] = []
    await withLocalHTTPServer((request, response) => {
      paths.push(request.url ?? '')
      if (request.url === '/redirect-target') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ leaked: true }))
        return
      }
      response.statusCode = 307
      response.setHeader('Location', '/redirect-target')
      response.end()
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      await expect(client.securePeerStatus()).rejects.toMatchObject({ status: 307 })
    })
    expect(paths).toEqual(['/api/admin/secure-peers/v1/status'])
  })

  it('preserves the authenticated structured error from a secure peer control', async () => {
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    await withLocalHTTPServer((_request, response) => {
      response.statusCode = 409
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        error: {
          code: 'connection_changed',
          message: 'Secure peer connection identity changed'
        }
      }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      await expect(client.forgetSecurePeerConnection(connectionId, {
        expected_server_identity: 'server-a'
      })).rejects.toMatchObject({
        status: 409,
        message: 'Secure peer connection identity changed',
        detail: {
          code: 'connection_changed',
          message: 'Secure peer connection identity changed'
        }
      })
    })
  })

  it('caps responses and propagates a caller abort to an in-flight proxy request', async () => {
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    let releaseRequest: (() => void) | undefined
    const requestSeen = new Promise<void>(resolve => { releaseRequest = resolve })
    await withLocalHTTPServer((request, response) => {
      if (request.url?.endsWith('/v1/oversized')) {
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Content-Length', String(2 * 1024 * 1024 + 1))
        response.end()
        return
      }
      if (request.url?.endsWith('/network/attachments/attachment-1/content')) {
        response.statusCode = 502
        response.setHeader('Content-Type', 'application/json')
        response.write(Buffer.alloc(64 * 1024, 0x61))
        response.end(Buffer.from([0x61]))
        return
      }
      releaseRequest?.()
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'exact-control-secret')
      const basePath = `/api/team-hub-secure/${connectionId}`
      const proxyFetch = client.secureTeamHubProxyFetch(basePath)
      await expect(proxyFetch(`${baseURL}${basePath}/v1/oversized`)).rejects.toThrow('too large')
      await expect(proxyFetch(
        `${baseURL}${basePath}/v1/teams/team-1/network/attachments/attachment-1/content`,
        { headers: { Range: 'bytes=0-3' } }
      )).rejects.toThrow('too large')

      const abort = new AbortController()
      const pending = proxyFetch(`${baseURL}${basePath}/v1/wait`, { signal: abort.signal })
      await requestSeen
      abort.abort(new Error('caller stopped'))
      await expect(pending).rejects.toThrow('caller stopped')
    })
  })
})

describe('AgentServerClient Teamspace bootstrap control', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('sends the core bearer only to the exact private Serve admin route', async () => {
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas',
      expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas',
      expected_hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      confirmed: true as const,
      recipient_email: 'owner@example.test',
      display_name: 'Owner',
      device_label: 'AgentsDock Desktop'
    }
    const payload = {
      request_id: request.request_id,
      server_identity: request.expected_server_identity,
      server_instance_id: request.expected_server_instance_id,
      hub_id: request.expected_hub_id,
      tailnet_login: 'owner@example.test',
      expires_at: '2026-08-21T00:00:00Z',
      bootstrap_proof: `bootstrap_remote.${'a'.repeat(43)}`
    }
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init: RequestInit = {}) => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')

    await expect(client.teamHubBootstrapProof(request.expected_hub_url, request)).resolves.toEqual(payload)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://atlas.my-tailnet.ts.net:8444/api/admin/team-hub/bootstrap-proof')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(JSON.parse(String(init.body))).toEqual(request)
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer core-admin-secret')
    expect(headers.get('X-AgentsDock-Token')).toBeNull()
    expect(headers.get('Origin')).toBeNull()
    expect(headers.get('Content-Length')).toBe(String(Buffer.byteLength(String(init.body))))
  })

  it('sends the core bearer to Direct IP only when it is the exact active AgentsServer origin', async () => {
    const hubURL = 'http://100.64.0.1:7850/api/team-hub'
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: hubURL,
      expected_transport: 'direct_ip' as const, confirmed: true as const, unsafe_direct_ip_confirmed: true as const,
      recipient_email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }
    const payload = {
      request_id: request.request_id, server_identity: 'server-atlas', server_instance_id: 'instance-atlas',
      hub_id: 'hub-atlas', tailnet_login: 'owner@example.test', expires_at: '2026-08-21T00:00:00Z',
      bootstrap_proof: `bootstrap_remote.${'d'.repeat(43)}`
    }
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init: RequestInit = {}) => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')

    await expect(client.teamHubBootstrapProof(hubURL, request)).resolves.toEqual(payload)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://100.64.0.1:7850/api/admin/team-hub/bootstrap-proof')
    expect(init.redirect).toBe('manual')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer core-admin-secret')

    const otherOrigin = new AgentServerClient('http://100.64.0.2:7850', 'core-admin-secret')
    await expect(otherOrigin.teamHubBootstrapProof(hubURL, request)).rejects.toThrow('exact active AgentsServer origin')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an unapproved origin before sending the core bearer', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: 'https://evil.example:8444/api/team-hub',
      confirmed: true as const, recipient_email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }

    await expect(client.teamHubBootstrapProof(request.expected_hub_url, request)).rejects.toThrow('invalid private')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not follow or retry a redirect from the exact private control origin', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init: RequestInit = {}) => new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/bootstrap' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      confirmed: true as const, recipient_email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }

    const error = await client.teamHubBootstrapProof(request.expected_hub_url, request).catch(cause => cause)
    expect(error).toMatchObject({ status: 302, message: 'Teamspace setup refused an unexpected redirect.' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
    expect(String(error.message)).not.toContain('attacker.example')
  })

  it('redacts the core credential and authorization values echoed by a bounded non-success response', async () => {
    const proof = `bootstrap_remote.${'z'.repeat(43)}`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: `Rejected core-admin-secret Authorization: Bearer second-secret ${proof}`
    }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      confirmed: true as const, recipient_email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }

    const error = await client.teamHubBootstrapProof(request.expected_hub_url, request).catch(cause => cause)
    expect(String(error.message)).toContain('[redacted]')
    expect(String(error.message)).not.toContain(proof)
    expect(String(error.message)).not.toContain('core-admin-secret')
    expect(String(error.message)).not.toContain('second-secret')
    expect((error as { detail?: unknown }).detail).toBeUndefined()
  })

  it('rejects a non-JSON control response before interpreting its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('core-admin-secret', {
      status: 502, headers: { 'Content-Type': 'text/plain' }
    })))
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      confirmed: true as const, recipient_email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }

    await expect(client.teamHubBootstrapProof(request.expected_hub_url, request)).rejects.toThrow(
      'Teamspace setup returned an invalid response.'
    )
  })

  it('surfaces a bounded Hub error message without retaining its raw payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'bootstrap_identity_mismatch',
        message: 'Bootstrap recipient does not match the verified Tailnet identity'
      }
    }), {
      status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })))
    const client = new AgentServerClient('http://100.64.0.1:7850', 'core-admin-secret')
    const request = {
      request_id: '0dc9411c-d409-4d3e-ac83-9f03e3a55d98',
      expected_server_identity: 'server-atlas', expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas', expected_hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      confirmed: true as const, recipient_email: 'other@example.test', display_name: 'Owner', device_label: 'Desktop'
    }

    const error = await client.teamHubBootstrapProof(request.expected_hub_url, request).catch(cause => cause)
    expect(error.message).toBe('Bootstrap recipient does not match the verified Tailnet identity')
    expect((error as { detail?: unknown }).detail).toBeUndefined()
  })
})

describe('AgentServerClient provider scheduled-jobs access', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('persists the additive per-chat access field through the session PATCH', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: {
          id: 'chat /?', title: 'Controlled jobs', backend: 'codex',
          provider_jobs_access: 'read_only'
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.updateSession('chat /?', {
      provider_jobs_access: 'read_only'
    })).resolves.toMatchObject({ provider_jobs_access: 'read_only' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      provider_jobs_access: 'read_only'
    })
  })
})

describe('AgentServerClient provider reload', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('reloads only the selected chat provider through the additive endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        session: { id: 'chat /?', title: 'Chat', backend: 'claude' },
        reloaded: true,
        message: 'Claude reloaded.'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'secret-token')

    await expect(client.reloadProvider('chat /?')).resolves.toMatchObject({
      reloaded: true,
      session: { id: 'chat /?', backend: 'claude' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/provider/reload')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({})
    expect(new Headers(calls[0].init.headers).get('X-AgentsDock-Token')).toBe('secret-token')
  })

  it('explains the required server upgrade when the endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://legacy.test:7850', 'token')

    await expect(client.reloadProvider('chat-1')).rejects.toThrow(
      'This AgentsServer version does not support reloading a chat agent. Update the server and try again.'
    )
  })

  it('preserves a selected-chat 404 from a server that supports the endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.reloadProvider('deleted-chat')).rejects.toMatchObject({
      status: 404,
      message: 'session not found'
    })
  })
})

describe('AgentServerClient stop acknowledgement', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('preserves a retryable pending Stop response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      stopped: false,
      pending: true,
      deferred: true,
      native_interrupt: true,
      message: 'Stop is pending.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.stopTurn('chat-1')).resolves.toEqual({
      ok: true,
      stopped: false,
      pending: true,
      deferred: true,
      native_interrupt: true,
      message: 'Stop is pending.'
    })
  })

  it('normalizes an older server acknowledgement without dropping compatibility', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.stopTurn('chat-1')).resolves.toEqual({ ok: true, stopped: true })
  })
})

describe('AgentServerClient queued Force Send', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('negotiates and preserves a typed deferred queue response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const deferred = {
      ok: false,
      queued_id: 'queued /?',
      deferred: true,
      retryable: true,
      delivery_uncertain: false,
      message: 'The message remains queued.',
      remaining: 1
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(deferred), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.runQueuedNow('chat /?', 'queued /?')).resolves.toEqual(deferred)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/queue/queued%20%2F%3F/run-now')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      accept_deferred_queue_response: true
    })
  })
})

describe('AgentServerClient server-wide Codex goals', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('reads and updates the authoritative server setting', async () => {
    const calls: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []
    await withLocalHTTPServer(async (request, response) => {
      const body = await incomingBody(request)
      calls.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      const enabled = request.method === 'PUT' ? JSON.parse(body).enabled : true
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        enabled,
        configurable: true,
        message: enabled ? 'Goals enabled.' : 'Goals disabled.'
      }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'secret-token')
      await expect(client.codexServerGoals()).resolves.toMatchObject({ enabled: true, configurable: true })
      await expect(client.setCodexServerGoals(false)).resolves.toMatchObject({ enabled: false, configurable: true })
    })

    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', '/api/admin/codex/goals'],
      ['PUT', '/api/admin/codex/goals']
    ])
    expect(JSON.parse(calls[1].body)).toEqual({ enabled: false })
    expect(calls[1].headers['x-agentsdock-token']).toBe('secret-token')
    expect(calls[1].headers['content-length']).toBe(String(Buffer.byteLength(calls[1].body)))
    for (const call of calls) {
      expect(call.headers.origin).toBeUndefined()
      expect(call.headers.cookie).toBeUndefined()
      expect(call.headers['sec-fetch-mode']).toBeUndefined()
      expect(call.headers.authorization).toBeUndefined()
    }
  })
})

describe('AgentServerClient server-wide Codex subagents', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('uses only the exact prefixed native admin GET/PUT route and preserves null reset', async () => {
    const calls: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []
    const fetchMock = vi.fn(() => { throw new Error('Privileged settings must use native transport') })
    vi.stubGlobal('fetch', fetchMock)
    await withLocalHTTPServer(async (request, response) => {
      const body = await incomingBody(request)
      calls.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ configurable: true, scope: 'server',
        max_concurrent_threads_per_session: request.method === 'PUT'
          ? JSON.parse(body).max_concurrent_threads_per_session : 4,
        applies_to: 'new_or_reloaded_threads', message: 'Synthetic acknowledged setting.' }))
    }, async baseURL => {
      const client = new AgentServerClient(`${baseURL}/mounted`, 'synthetic-admin-token')
      try {
        await expect(client.codexServerSubagents()).resolves.toMatchObject({
          configurable: true, max_concurrent_threads_per_session: 4,
          applies_to: 'new_or_reloaded_threads'
        })
        await expect(client.setCodexServerSubagents(32)).resolves.toMatchObject({ max_concurrent_threads_per_session: 32 })
        await expect(client.setCodexServerSubagents(null)).resolves.toMatchObject({ max_concurrent_threads_per_session: null })
      } finally { client.dispose() }
    })
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', '/mounted/api/admin/codex/subagents'],
      ['PUT', '/mounted/api/admin/codex/subagents'],
      ['PUT', '/mounted/api/admin/codex/subagents']
    ])
    expect(calls[0].body).toBe('')
    expect(JSON.parse(calls[1].body)).toEqual({ max_concurrent_threads_per_session: 32 })
    expect(JSON.parse(calls[2].body)).toEqual({ max_concurrent_threads_per_session: null })
    for (const call of calls) {
      expect(call.headers['x-agentsdock-token']).toBe('synthetic-admin-token')
      expect(call.headers.origin).toBeUndefined()
      expect(call.headers.cookie).toBeUndefined()
      expect(call.headers['sec-fetch-mode']).toBeUndefined()
      expect(call.headers.authorization).toBeUndefined()
      if (call.method === 'PUT') expect(call.headers['content-length']).toBe(String(Buffer.byteLength(call.body)))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '4', undefined])(
    'rejects invalid subagent limit %s before transport', invalid => {
      const client = new AgentServerClient('http://127.0.0.1:1', 'synthetic-token')
      try {
        expect(() => client.setCodexServerSubagents(invalid as number)).toThrow('positive whole number')
      } finally { client.dispose() }
    }
  )

  it.each([401, 403, 404, 405, 501])('preserves authenticated HTTP %s errors without fallback or retry', async status => {
    let requests = 0
    await withLocalHTTPServer((_request, response) => {
      requests += 1
      response.statusCode = status
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ detail: 'Synthetic unsupported or unauthorized setting.' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'synthetic-token')
      try {
        await expect(client.codexServerSubagents()).rejects.toMatchObject({ status })
        await expect(client.setCodexServerSubagents(8)).rejects.toMatchObject({ status })
      } finally { client.dispose() }
    })
    expect(requests).toBe(2)
  })
})

describe('AgentServerClient session ordering', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('requests one atomic cross-folder reorder on a current server', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        sessions: [
          { id: 'target', title: 'Target', backend: 'codex', folder: 'General' },
          { id: 'source', title: 'Source', backend: 'codex', folder: 'General' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.reorderSession('source', 'target', 'after', 'General')).resolves.toHaveLength(2)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://example.test:7850/api/sessions/source/order')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      target_id: 'target',
      placement: 'after',
      target_folder: 'General'
    })
  })

  it('falls back to move then reorder against an older server', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (calls.length === 1) {
        return new Response(JSON.stringify({ detail: 'sessions must be in the same section' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({
          session: { id: 'source', title: 'Source', backend: 'codex', folder: 'General' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        sessions: [
          { id: 'target', title: 'Target', backend: 'codex', folder: 'General' },
          { id: 'source', title: 'Source', backend: 'codex', folder: 'General' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const client = new AgentServerClient('http://legacy.test:7850', 'token')

    await expect(client.reorderSession('source', 'target', 'after', 'General')).resolves.toHaveLength(2)

    expect(calls.map(call => [call.init.method, call.url])).toEqual([
      ['POST', 'http://legacy.test:7850/api/sessions/source/order'],
      ['PATCH', 'http://legacy.test:7850/api/sessions/source'],
      ['POST', 'http://legacy.test:7850/api/sessions/source/order']
    ])
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      folder: 'General',
      pinned: false,
      archived: false
    })
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      target_id: 'target',
      placement: 'after'
    })
  })
})

describe('AgentServerClient pinned items', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const item: PinnedItem = {
    id: 'message:event-1',
    sessionId: 'chat-1',
    kind: 'message',
    eventId: 'event-1',
    title: 'Assistant',
    body: 'Pinned response',
    createdAt: 10
  }

  it('accepts the canonical pristine revision-0 snapshot', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      pins: [], revision: 0, updatedAt: null, capabilityVersion: 1
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await expect(client.pinnedItems('chat-1')).resolves.toEqual({
      pins: [], revision: 0, updatedAt: null, capabilityVersion: 1
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://example.test:7850/api/sessions/chat-1/pins')
  })

  it('sends ordinary PUT and DELETE mutations with a quoted If-Match revision', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({
        pins: init.method === 'DELETE' ? [] : [item],
        revision: init.method === 'DELETE' ? 8 : 7,
        updatedAt: '2026-08-25T00:00:07Z',
        capabilityVersion: 1
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'token')

    await client.putPinnedItem(item, 6)
    await client.removePinnedItem('chat-1', item.id, 7)

    expect(calls.map(call => [call.init.method, call.url, new Headers(call.init.headers).get('If-Match')])).toEqual([
      ['PUT', 'http://example.test:7850/api/sessions/chat-1/pins/message%3Aevent-1', '"6"'],
      ['DELETE', 'http://example.test:7850/api/sessions/chat-1/pins/message%3Aevent-1', '"7"']
    ])
    expect(JSON.parse(String(calls[0].init.body))).toEqual(item)
  })

  it('turns a revision-conflict detail into a rebaseable snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: {
        code: 'pin_revision_conflict',
        pins: [item],
        revision: 4,
        updatedAt: '2026-08-25T00:00:04Z',
        capabilityVersion: 1
      }
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'token')

    const error = await client.removePinnedItem('chat-1', item.id, 3).catch(value => value)
    expect(error).toBeInstanceOf(PinRevisionConflictError)
    expect((error as PinRevisionConflictError).snapshot).toMatchObject({ revision: 4, pins: [item] })
  })
})

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
    expect(first.url.searchParams.get('visible')).toBe('true')
    expect(first.url.searchParams.get('token')).toBe('token')
    expect(first.protocols).toBeUndefined()
    first.emit('open')
    first.emit('message', JSON.stringify({ id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    first.emit('close')
    vi.advanceTimersByTime(500)
    const second = FakeWebSocket.instances[1]
    expect(String(second.url)).toContain('after=6')
    expect(second.url.searchParams.get('token')).toBe('token')
    expect(second.protocols).toBeUndefined()
    second.emit('message', JSON.stringify({ id: 'e6-again', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    expect(received).toHaveLength(1)
    stop()
    expect(second.closed).toBe(true)
  })

  it('uses fixed endpoint and token subprotocols only after health advertises websocket auth', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      capabilities: {
        websocket_auth_v1: {
          available: true,
          required: false,
          message: '',
          action: null,
          version: 1
        }
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('https://example.test:7850', 'negotiated-secret')

    await client.health()
    const stopStream = client.stream('chat with spaces', 0, () => {}, () => {})
    const terminal = client.terminal(
      'chat with spaces',
      { columns: 100, rows: 30 },
      () => {},
      () => {}
    )
    const [eventsSocket, terminalSocket] = FakeWebSocket.instances
    const tokenProtocol = `agentsdock-token.${Buffer.from('negotiated-secret', 'utf8').toString('base64url')}`

    expect(eventsSocket.url.protocol).toBe('wss:')
    expect(eventsSocket.url.pathname).toBe('/api/sessions/chat%20with%20spaces/events')
    expect(eventsSocket.url.searchParams.get('token')).toBeNull()
    expect(eventsSocket.protocols).toEqual(['agentsdock-events-v1', tokenProtocol])
    expect(terminalSocket.url.protocol).toBe('wss:')
    expect(terminalSocket.url.pathname).toBe('/api/sessions/chat%20with%20spaces/terminal/ws')
    expect(terminalSocket.url.searchParams.get('token')).toBeNull()
    expect(terminalSocket.protocols).toEqual(['agentsdock-terminal-v1', tokenProtocol])

    stopStream()
    terminal.close()
  })

  it('compacts oversized live tool results before invoking the event consumer', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received: Event[] = []
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const stop = client.stream('chat', 0, event => received.push(event), () => {})
    const socket = FakeWebSocket.instances[0]

    socket.emit('message', JSON.stringify({
      id: 'tool-result',
      session_id: 'chat',
      seq: 1,
      type: 'tool_finished',
      ts: 'now',
      output: 'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 19)
    }))

    expect(received[0].output).toBe(
      `${'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS)}\n\n[AgentsDock omitted 19 characters from this tool output]`
    )
    stop()
  })

  it('routes ephemeral provider runtime packets without advancing the durable cursor', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received: Event[] = []
    const runtimePackets: Array<{ session_id: string; usage_generation?: number | null }> = []
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const stop = client.stream(
      'chat',
      5,
      event => received.push(event),
      () => {},
      event => runtimePackets.push(event)
    )
    const first = FakeWebSocket.instances[0]

    first.emit('message', JSON.stringify({
      type: 'provider_runtime_changed',
      session_id: 'chat',
      backend: 'claude',
      runtime: 'context_usage',
      ephemeral: true,
      usage_generation: 7
    }))
    first.emit('message', JSON.stringify({
      type: 'provider_runtime_changed',
      session_id: 'another-chat',
      backend: 'claude',
      runtime: 'context_usage',
      ephemeral: true,
      usage_generation: 8
    }))
    first.emit('message', JSON.stringify({ id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    first.emit('close')
    vi.advanceTimersByTime(500)

    expect(runtimePackets).toHaveLength(1)
    expect(runtimePackets[0]).toMatchObject({ session_id: 'chat', usage_generation: 7 })
    expect(received).toHaveLength(1)
    expect(String(FakeWebSocket.instances[1].url)).toContain('after=6')
    stop()
  })

  it('routes ephemeral pinned-item invalidations without advancing the durable cursor', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received: Event[] = []
    const pinPackets: Array<{ session_id: string; revision: number }> = []
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const stop = client.stream(
      'chat',
      5,
      event => received.push(event),
      () => {},
      undefined,
      event => pinPackets.push(event)
    )
    const first = FakeWebSocket.instances[0]

    first.emit('message', JSON.stringify({
      type: 'timeline_pins_changed',
      session_id: 'chat',
      revision: 3,
      updated_at: '2026-08-25T00:00:03Z'
    }))
    first.emit('message', JSON.stringify({ id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    first.emit('close')
    vi.advanceTimersByTime(500)

    expect(pinPackets).toEqual([{ type: 'timeline_pins_changed', session_id: 'chat', revision: 3, updated_at: '2026-08-25T00:00:03Z' }])
    expect(received).toHaveLength(1)
    expect(String(FakeWebSocket.instances[1].url)).toContain('after=6')
    stop()
  })

  it('routes only current-session reasoning snapshots in increasing instance-bound revisions', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const event = vi.fn(), summary = vi.fn()
    const stop = client.stream('chat', 5, event, vi.fn(), undefined, undefined, summary)
    const socket = FakeWebSocket.instances[0]
    const snapshot = {
      type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot-a', revision: 3,
      items: [{ run_id: 'run-a', item_id: 'item-a', backend: 'codex', phase: 'summary',
        text: 'Checking the first option.', ts: '2026-09-20T05:00:00Z', after_seq: 5 }]
    }
    expect(socket.url.searchParams.get('reasoning_stream')).toBe('true')
    expect(socket.url.searchParams.get('reasoning_text')).toBe('true')
    socket.emit('message', JSON.stringify(snapshot))
    socket.emit('message', JSON.stringify({ ...snapshot, revision: 2 }))
    socket.emit('message', JSON.stringify(snapshot))
    socket.emit('message', JSON.stringify({ ...snapshot, session_id: 'other-chat', revision: 99 }))
    socket.emit('message', JSON.stringify({ ...snapshot, instance_id: 'other-boot', revision: 99 }))
    const cleared = { ...snapshot, revision: 4, items: [] }
    socket.emit('message', JSON.stringify(cleared))
    expect(summary.mock.calls.map(([value]) => value)).toEqual([snapshot, cleared])
    expect(event).not.toHaveBeenCalled()
    stop()
    socket.emit('message', JSON.stringify({ ...snapshot, revision: 5 }))
    expect(summary).toHaveBeenCalledTimes(2)
  })

  it('consumes malformed reasoning frames without poisoning the durable reconnect cursor or snapshot revision', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const event = vi.fn(), summary = vi.fn()
    const stop = client.stream('chat', 5, event, vi.fn(), undefined, undefined, summary)
    const first = FakeWebSocket.instances[0]
    const snapshot = { type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot-a', revision: 3, items: [] }
    for (const malformed of [
      { ...snapshot, revision: -1 }, { ...snapshot, items: null },
      { ...snapshot, items: [{ run_id: 'run', item_id: 'item', backend: 'codex', phase: 'summary', text: 7, after_seq: 5, ts: 'now' }] },
      { ...snapshot, instance_id: '', revision: 99 }
    ]) first.emit('message', JSON.stringify({ ...malformed, seq: 10000 }))
    first.emit('message', '{malformed')
    first.emit('message', JSON.stringify(snapshot))
    const durable: Event = { id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now', text: 'Done.' }
    first.emit('message', JSON.stringify(durable))
    first.emit('close')
    // Queued frames from the closed transport cannot change either cursor.
    first.emit('message', JSON.stringify({ ...snapshot, revision: 100 }))
    first.emit('message', JSON.stringify({ ...durable, seq: 9000 }))
    vi.advanceTimersByTime(500)
    const second = FakeWebSocket.instances[1]
    expect(second.url.searchParams.get('after')).toBe('6')
    expect(second.url.searchParams.get('reasoning_stream')).toBe('true')
    const restarted = { ...snapshot, instance_id: 'boot-b', revision: 0 }
    second.emit('message', JSON.stringify(restarted))
    first.emit('message', JSON.stringify({ ...snapshot, revision: 101 }))
    expect(event).toHaveBeenCalledExactlyOnceWith(durable)
    expect(summary.mock.calls.map(([value]) => value)).toEqual([snapshot, restarted])
    stop()
  })

  it('keeps reasoning packets out of the durable lane without opting older callers into streaming', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const event = vi.fn()
    const stop = client.stream('chat', 5, event, vi.fn())
    const socket = FakeWebSocket.instances[0]
    expect(socket.url.searchParams.has('reasoning_stream')).toBe(false)
    expect(socket.url.searchParams.has('reasoning_text')).toBe(false)
    socket.emit('message', JSON.stringify({ type: 'reasoning_summary_stream', seq: 500 }))
    socket.emit('message', JSON.stringify({ id: 'e6', session_id: 'chat', seq: 6, type: 'assistant_text', ts: 'now' }))
    expect(event).toHaveBeenCalledOnce()
    expect(event.mock.calls[0][0].seq).toBe(6)
    stop()
  })

  it('times out a stalled websocket handshake and keeps retrying', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ connected: boolean; error?: string }> = []
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const stop = client.stream('chat', 0, () => {}, (connected, error) => states.push({ connected, error }))
    const first = FakeWebSocket.instances[0]
    first.readyState = 0

    vi.advanceTimersByTime(10_000)
    expect(first.closed).toBe(true)
    expect(states).toEqual([{ connected: false, error: 'Live updates timed out' }])
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    stop()
  })

  it('dispose aborts outstanding JSON and file requests without affecting a new client', async () => {
    const calls: Array<{ url: string; signal: AbortSignal }> = []
    const fetchMock = vi.fn((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      const signal = init.signal as AbortSignal
      calls.push({ url, signal })
      if (url.startsWith('http://new.example.test')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const oldClient = new AgentServerClient('http://old.example.test:7850', 'old-token')
    const newClient = new AgentServerClient('http://new.example.test:7850', 'new-token')
    const oldHealth = expect(oldClient.health()).rejects.toMatchObject({ name: 'AbortError' })
    const oldFile = expect(oldClient.fileRequest('chat-old', 'artifact')).rejects.toMatchObject({ name: 'AbortError' })
    const newHealth = newClient.health()

    oldClient.dispose()

    const oldCalls = calls.filter(call => call.url.startsWith('http://old.example.test'))
    const newCall = calls.find(call => call.url.startsWith('http://new.example.test'))
    expect(oldCalls).toHaveLength(2)
    expect(oldCalls.every(call => call.signal.aborted)).toBe(true)
    expect(newCall?.signal.aborted).toBe(false)
    await Promise.all([oldHealth, oldFile])
    await expect(newHealth).resolves.toMatchObject({ ok: true })
  })

  it('configure aborts the previous request scope and keeps its legacy reuse behavior', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchMock = vi.fn((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith('http://second.example.test')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      const signal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://first.example.test:7850', 'first-token')
    const first = expect(client.health()).rejects.toMatchObject({ name: 'AbortError' })

    client.configure('http://second.example.test:7850', 'second-token')
    await first
    await expect(client.health()).resolves.toMatchObject({ ok: true })

    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true)
    expect(calls[1].url).toBe('http://second.example.test:7850/api/health')
    expect(new Headers(calls[1].init.headers).get('X-AgentsDock-Token')).toBe('second-token')
    expect((calls[1].init.signal as AbortSignal).aborted).toBe(false)
  })

  it('configure cancels an old stream retry and resets negotiated auth for a legacy profile', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      capabilities: {
        websocket_auth_v1: {
          available: true,
          required: false,
          message: '',
          action: null,
          version: 1
        }
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const received: Event[] = []
    const client = new AgentServerClient('http://first.example.test:7850', 'first-token')
    await client.health()
    const stopFirst = client.stream('chat', 0, event => received.push(event), () => {})
    const first = FakeWebSocket.instances[0]
    expect(first.url.hostname).toBe('first.example.test')
    expect(first.url.searchParams.get('token')).toBeNull()
    expect(first.protocols).toEqual([
      'agentsdock-events-v1',
      `agentsdock-token.${Buffer.from('first-token', 'utf8').toString('base64url')}`
    ])
    first.emit('close')

    client.configure('http://second.example.test:7850', 'second-token')
    first.emit('message', JSON.stringify({ id: 'late', session_id: 'chat', seq: 1, type: 'assistant_text', ts: 'now' }))
    const stopSecond = client.stream('chat', 0, event => received.push(event), () => {})
    vi.advanceTimersByTime(5_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url.hostname).toBe('second.example.test')
    expect(FakeWebSocket.instances[1].url.searchParams.get('token')).toBe('second-token')
    expect(FakeWebSocket.instances[1].protocols).toBeUndefined()
    expect(received).toEqual([])
    stopFirst()
    stopSecond()
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
    await client.sessionPage('chat', { after: 42, limit: 120, tail: false, visible: true, compact: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat?')
    expect(url).toContain('after=42')
    expect(url).toContain('tail=false')
    expect(url).toContain('visible=true')
    expect(url).toContain('compact=true')
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('loads encoded scheduled job run history with cursor pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'chat one',
      job_id: 'job/one',
      runs: [{
        id: 'run-result',
        session_id: 'chat one',
        seq: 31,
        type: 'turn_finished',
        ts: 'now',
        run_id: 'run-3',
        job_id: 'job/one',
        result_text: 'Done'
      }],
      total: 3,
      has_more: true,
      next_before: 31,
      timeline_group_id: 'job:job/one:segment:10'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    const page = await client.jobRuns('chat one', 'job/one', 40, 12, 'job:job/one:segment:10')

    expect(page).toEqual({
      runs: [expect.objectContaining({ id: 'run-result', seq: 31 })],
      total: 3,
      has_more: true,
      next_before: 31,
      timeline_group_id: 'job:job/one:segment:10',
      supported: true
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://example.test:7850/api/sessions/chat%20one/jobs/job%2Fone/runs?limit=12&before_seq=40&timeline_group_id=job%3Ajob%2Fone%3Asegment%3A10'
    )
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('loads a scheduled run trace directly from the additive server endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{
        id: 'thought-1',
        session_id: 'chat one',
        seq: 18,
        type: 'reasoning_summary',
        ts: 'now',
        run_id: 'run/one',
        text: 'Checked the latest state'
      }],
      has_more: true,
      next_after: 18
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.runTrace('chat one', 'run/one', 25, 12, 40)).resolves.toEqual({
      events: [expect.objectContaining({ id: 'thought-1', seq: 18 })],
      has_more: true,
      next_after: 18
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://example.test:7850/api/sessions/chat%20one/runs/run%2Fone/trace?anchor_seq=25&after_seq=12&limit=40'
    )
  })

  it('omits an unavailable run-trace anchor so the server can select the latest run occurrence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [],
      has_more: false,
      next_after: 0
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.runTrace('chat one', 'run/one', 0, 0, 40)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://example.test:7850/api/sessions/chat%20one/runs/run%2Fone/trace?after_seq=0&limit=40'
    )
  })

  it('compacts oversized tool results in timeline pages before returning them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' },
      events: [{
        id: 'tool-result',
        session_id: 'chat',
        seq: 1,
        type: 'tool_finished',
        ts: 'now',
        output: 'y'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 7)
      }],
      queued_turns: [],
      events_omitted_before: 0,
      event_count: 1
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    const page = await client.sessionPage('chat')

    expect(page.events[0].output).toBe(
      `${'y'.repeat(TOOL_OUTPUT_PREVIEW_CHARS)}\n\n[AgentsDock omitted 7 characters from this tool output]`
    )
  })

  it('can force a fresh provider runtime probe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ backends: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.runtimeCatalog(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/runtime/catalog?refresh=true')
  })

  it('uses authenticated, encoded workspace routes and revision-checked mutations', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      root: '/work/project',
      entries: [],
      total: 0,
      content: 'updated',
      revision: 'b'.repeat(64)
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.workspaceInfo('chat one')
    await client.workspaceEntries('chat one', 'src/nested dir', 5, 25)
    await client.workspaceSearch('chat one', 'app shell', 30)
    await client.workspaceFile('chat one', 'src/App.tsx')
    await client.absoluteFile('chat one', '/home/dev/.codex/AGENTS.md')
    await client.writeAbsoluteFile('chat one', '/home/dev/.codex/AGENTS.md', 'absolute update', 'd'.repeat(64))
    await client.createWorkspaceEntry('chat one', 'src/New File.tsx', 'file')
    await client.writeWorkspaceFile('chat one', 'src/App.tsx', 'updated', 'a'.repeat(64))
    await client.renameWorkspaceEntry('chat one', 'src/App.tsx', 'Shell.tsx', 'b'.repeat(64))
    await client.removeWorkspaceEntry('chat one', 'src/nested dir', 'c'.repeat(64), true)

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    expect(calls[0][0]).toBe('http://example.test:7850/api/sessions/chat%20one/workspace')
    expect(calls[1][0]).toContain('/workspace/entries?path=src%2Fnested+dir&offset=5&limit=25')
    expect(calls[2][0]).toContain('/workspace/search?q=app+shell&limit=30')
    expect(calls[3][0]).toContain('/workspace/file?path=src%2FApp.tsx')
    expect(calls[4][0]).toContain('/workspace/absolute-file?path=%2Fhome%2Fdev%2F.codex%2FAGENTS.md')
    expect(calls.every(([, init]) => new Headers(init.headers).get('X-AgentsDock-Token') === 'secret')).toBe(true)
    expect(calls[5][0]).toBe('http://example.test:7850/api/sessions/chat%20one/workspace/absolute-file')
    expect(calls[5][1].method).toBe('PUT')
    expect(JSON.parse(String(calls[5][1].body))).toEqual({
      path: '/home/dev/.codex/AGENTS.md',
      content: 'absolute update',
      expected_revision: 'd'.repeat(64)
    })
    expect(calls[6][0]).toBe('http://example.test:7850/api/sessions/chat%20one/workspace/entry')
    expect(calls[6][1].method).toBe('POST')
    expect(JSON.parse(String(calls[6][1].body))).toEqual({
      path: 'src/New File.tsx',
      kind: 'file'
    })
    expect(calls[7][1].method).toBe('PUT')
    expect(new Headers(calls[7][1].headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(calls[7][1].body))).toEqual({
      path: 'src/App.tsx',
      content: 'updated',
      expected_revision: 'a'.repeat(64)
    })
    expect(calls[8][0]).toBe('http://example.test:7850/api/sessions/chat%20one/workspace/entry')
    expect(calls[8][1].method).toBe('PATCH')
    expect(JSON.parse(String(calls[8][1].body))).toEqual({
      path: 'src/App.tsx',
      new_name: 'Shell.tsx',
      expected_revision: 'b'.repeat(64)
    })
    expect(calls[9][0]).toContain('/workspace/entry?path=src%2Fnested+dir')
    expect(calls[9][0]).toContain(`expected_revision=${'c'.repeat(64)}`)
    expect(calls[9][0]).toContain('recursive=true')
    expect(calls[9][1].method).toBe('DELETE')
  })

  it('requests working-directory completions from the active remote server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      input: '/srv/pro',
      resolved_path: '/srv/pro',
      exists: false,
      base_path: '/srv',
      suggestions: [{ name: 'project one', path: '/srv/project one/' }],
      truncated: false,
      message: null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.completeWorkingDirectory('/srv/pro', 12)).resolves.toMatchObject({
      suggestions: [{ path: '/srv/project one/' }]
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://example.test:7850/api/working-directories/complete?path=%2Fsrv%2Fpro&limit=12')
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('proxies workspace previews with encoded paths, HEAD, and Range without forwarding unrelated headers', async () => {
    const serverResponse = new Response(null, {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes 100-199/500',
        'Content-Type': 'application/pdf'
      }
    })
    const fetchMock = vi.fn().mockResolvedValue(serverResponse)
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const request = new Request('agentsdock-media://workspace/profile-a/1/chat/src%2Freport.pdf', {
      method: 'HEAD',
      headers: {
        Range: 'bytes=100-199',
        'X-Untrusted-Renderer-Header': 'ignore-me'
      }
    })

    const response = await client.workspacePreviewRequest('chat one', 'docs/report #1.pdf', request)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://example.test:7850/api/sessions/chat%20one/workspace/preview?path=docs%2Freport+%231.pdf'
    )
    expect(init.method).toBe('HEAD')
    const headers = new Headers(init.headers)
    expect(headers.get('Range')).toBe('bytes=100-199')
    expect(headers.get('X-AgentsDock-Token')).toBe('secret')
    expect(headers.get('X-Untrusted-Renderer-Header')).toBeNull()
    expect(response).toBe(serverResponse)
  })

  it('passes workspace preview HTTP errors through as responses', async () => {
    const serverResponse = new Response('Not found', { status: 404 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverResponse))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.workspacePreviewRequest('chat', 'missing.png')).resolves.toBe(serverResponse)
  })

  it('downloads workspace files through the authenticated encoded binary route', async () => {
    const serverResponse = new Response(new Uint8Array([0x00, 0xff]), {
      status: 200,
      headers: {
        'Content-Disposition': 'attachment; filename="weights.bin"',
        'Content-Type': 'application/octet-stream'
      }
    })
    const fetchMock = vi.fn().mockResolvedValue(serverResponse)
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    const response = await client.workspaceDownloadRequest('chat one', 'models/weights #1.bin')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://example.test:7850/api/sessions/chat%20one/workspace/download?path=models%2Fweights+%231.bin'
    )
    expect(init.method).toBe('GET')
    const headers = new Headers(init.headers)
    expect(headers.get('X-AgentsDock-Token')).toBe('secret')
    expect(response).toBe(serverResponse)
  })

  it('sends an inferred PNG content type with file uploads', async () => {
    class CapturedFormData {
      readonly parts = new Map<string, { value: unknown; filename?: string }>()
      append(name: string, value: unknown, filename?: string): void { this.parts.set(name, { value, filename }) }
      get(name: string): unknown { return this.parts.get(name)?.value ?? null }
    }
    vi.stubGlobal('FormData', CapturedFormData)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-upload-test-'))
    const path = join(directory, 'screen.png')
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      file: { id: 'image-1', filename: 'screen.png', content_type: 'image/png' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const client = new AgentServerClient('http://example.test:7850', 'secret')
      await client.upload('chat', path)
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const part = (init.body as unknown as CapturedFormData).parts.get('file')

      expect(part?.filename).toBe('screen.png')
      expect((part?.value as { type?: string }).type).toBe('image/png')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('derives bounded upload deadlines for small, maximum-contract, and oversized files', () => {
    expect(uploadRequestTimeoutMs(1)).toBe(5 * 60_000)
    expect(uploadRequestTimeoutMs(25 * 1024 * 1024 * 1024)).toBe((2 * 60 + 25 * 1024) * 1_000)
    expect(uploadRequestTimeoutMs(100 * 1024 * 1024 * 1024)).toBe(8 * 60 * 60_000)
  })

  it('gives large uploads a dedicated deadline above 30 seconds while retaining profile cancellation', async () => {
    class CapturedFormData {
      append(): void { /* the request body is not material to this timeout check */ }
    }
    vi.stubGlobal('FormData', CapturedFormData)
    const deadline = new AbortController()
    const timeoutSignal = vi.fn((_timeoutMs: number) => deadline.signal)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-upload-timeout-test-'))
    const path = join(directory, 'archive.bin')
    await writeFile(path, new Uint8Array([0x00, 0x01]))
    let requestSignal: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      requestSignal = init.signal as AbortSignal
      return new Response(JSON.stringify({
        file: { id: 'archive-1', filename: 'archive.bin', content_type: 'application/octet-stream' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    try {
      const client = new AgentServerClient('http://example.test:7850', 'secret', {
        uploadTimeoutMs: 120_000,
        timeoutSignal
      })
      await client.upload('chat', path)

      expect(timeoutSignal).toHaveBeenCalledOnce()
      expect(timeoutSignal).toHaveBeenCalledWith(120_000)
      expect(timeoutSignal.mock.calls[0][0]).toBeGreaterThan(30_000)
      expect(requestSignal).not.toBeNull()
      expect(requestSignal!.aborted).toBe(false)
      client.dispose()
      expect(requestSignal!.aborted).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('aborts a hung upload at its injected hard deadline', async () => {
    class CapturedFormData { append(): void { /* request body is not material */ } }
    vi.stubGlobal('FormData', CapturedFormData)
    const deadline = new AbortController()
    const timeoutSignal = vi.fn((_timeoutMs: number) => deadline.signal)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-upload-deadline-test-'))
    const path = join(directory, 'archive.bin')
    await writeFile(path, new Uint8Array([0x00, 0x01]))
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init: RequestInit = {}) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))

    try {
      const client = new AgentServerClient('http://example.test:7850', 'secret', {
        uploadTimeoutMs: 90_000,
        timeoutSignal
      })
      const upload = client.upload('chat', path)
      await requestStarted
      deadline.abort(new DOMException('Upload timed out.', 'TimeoutError'))

      await expect(upload).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(timeoutSignal).toHaveBeenCalledWith(90_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the normal access token and propagates signed server update tracks', async () => {
    const calls: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []
    const target = {
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-a'
    }
    await withLocalHTTPServer(async (request, response) => {
      const body = await incomingBody(request)
      calls.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ phase: 'current', current_version: '0.1.0' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      await client.checkServerUpdate('beta', target)
      await client.startServerUpdate('0.1.19-beta.7', 'beta', false, target)
    })

    expect(calls[0].url).toBe('/api/admin/update/check')
    expect(JSON.parse(calls[0].body)).toEqual({ track: 'beta', ...target })
    expect(calls[1].url).toBe('/api/admin/update/start')
    expect(JSON.parse(calls[1].body)).toEqual({ version: '0.1.19-beta.7', track: 'beta', ...target })
    for (const call of calls) {
      expect(call.headers['x-agentsdock-token']).toBe('chat-secret')
      expect(call.headers['x-agentsserver-admin-token']).toBeUndefined()
      expect(call.headers['content-length']).toBe(String(Buffer.byteLength(call.body)))
      expect(call.headers.origin).toBeUndefined()
      expect(call.headers.cookie).toBeUndefined()
      expect(call.headers['sec-fetch-mode']).toBeUndefined()
      expect(call.headers.authorization).toBeUndefined()
    }
  })

  it('carries paired signed bytes and identity fences through the actual native HTTP transport', async () => {
    // Actual Node HTTP client/socket; the endpoint here is a bounded fake server,
    // not acceptance of the production server's signature/admission/installer.
    const calls: Array<{ headers: IncomingMessage['headers']; body: string; url: string }> = []
    const envelope = { manifest_base64: Buffer.from('{"schema":2}').toString('base64'), signature_base64: Buffer.alloc(64, 1).toString('base64') }
    const target = { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' }
    await withLocalHTTPServer(async (request, response) => {
      calls.push({ headers: request.headers, body: await incomingBody(request), url: request.url ?? '' })
      response.setHeader('Content-Type', 'application/json')
      response.statusCode = calls.length === 1 ? 200 : 409
      response.end(JSON.stringify(calls.length === 1
        ? { phase: 'pending', current_version: '1.1.0', server_identity: 'server-a', server_instance_id: 'boot-a', schedule_id: 'durable-schedule' }
        : { detail: 'server_update_channel_conflict' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'fixture-token')
      expect(await client.ensureServerUpdate(envelope, target)).toMatchObject({ phase: 'pending', schedule_id: 'durable-schedule' })
      await expect(client.ensureServerUpdate(envelope, target)).rejects.toMatchObject({ status: 409 })
      client.dispose()
    })
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe('/api/admin/update/ensure')
      expect(JSON.parse(call.body)).toEqual({ ...envelope, ...target })
      expect(call.headers['x-agentsdock-token']).toBe('fixture-token')
      expect(call.headers.origin).toBeUndefined()
      expect(call.headers['sec-fetch-mode']).toBeUndefined()
      expect(call.headers.authorization).toBeUndefined()
    }
  })

  it('enables Team Hub hosting through the exact privileged native route and body', async () => {
    const calls: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []
    const receipt = {
      phase: 'complete' as const,
      request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9',
      operation: 'reactivate' as const,
      server_identity: 'server-studio',
      server_instance_id: 'boot-studio',
      server_name: 'Studio',
      reconnect_required: false as const,
      message: 'This server is now the Team Network host.',
      team_hub: {
        available: true,
        designated_host: true,
        version: 1 as const,
        base_path: '/api/team-hub',
        transport: 'loopback' as const,
        hub_url: null,
        hub_id: 'hub-studio',
        host_server_identity: 'server-studio',
        message: 'Team Network host is ready.',
        action: null
      }
    }
    await withLocalHTTPServer(async (request, response) => {
      const body = await incomingBody(request)
      calls.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(receipt))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      const input = {
        request_id: receipt.request_id,
        expected_server_identity: 'server-studio',
        expected_server_instance_id: 'boot-studio',
        server_name: 'Studio',
        // The public method rebuilds its wire object so even an untyped caller
        // cannot add fields or remove the explicit confirmation.
        confirmed: false,
        network_name: 'Research',
        untrusted_extra: 'must-not-leak'
      } as unknown as Parameters<AgentServerClient['enableTeamHubHost']>[0]

      await expect(client.enableTeamHubHost(input)).resolves.toEqual(receipt)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('/api/admin/team-hub/host/enable')
    expect(JSON.parse(calls[0].body)).toEqual({
      request_id: receipt.request_id,
      expected_server_identity: 'server-studio',
      expected_server_instance_id: 'boot-studio',
      confirmed: true,
      server_name: 'Studio',
      network_name: 'Research'
    })
    expect(calls[0].headers['x-agentsdock-token']).toBe('chat-secret')
    expect(calls[0].headers['x-agentsserver-admin-token']).toBeUndefined()
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(calls[0].headers['content-length']).toBe(String(Buffer.byteLength(calls[0].body)))
    expect(calls[0].headers.origin).toBeUndefined()
    expect(calls[0].headers.cookie).toBeUndefined()
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('rejects a non-200 response from the Team Hub host-enable control', async () => {
    await withLocalHTTPServer((_request, response) => {
      response.statusCode = 201
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        phase: 'complete',
        request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9',
        operation: 'create',
        reconnect_required: false
      }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      await expect(client.enableTeamHubHost({
        request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9',
        expected_server_identity: 'server-studio',
        expected_server_instance_id: 'boot-studio',
        confirmed: true,
        server_name: 'Studio'
      })).rejects.toMatchObject({ status: 201 })
    })
  })

  it('switches to the member role through the exact privileged native route and named body', async () => {
    let call: { method: string; url: string; body: string } | null = null
    await withLocalHTTPServer(async (request, response) => {
      call = { method: request.method ?? '', url: request.url ?? '', body: await incomingBody(request) }
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ phase: 'complete', request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      await client.disableTeamHubHost({
        request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9',
        expected_server_identity: 'server-studio', expected_server_instance_id: 'boot-studio',
        confirmed: true, server_name: 'Studio member'
      })
    })

    expect(call).toEqual({
      method: 'POST', url: '/api/admin/team-hub/host/disable',
      body: JSON.stringify({
        request_id: 'c619e47e-a4ee-4d1c-a9ca-edf814ab05a9',
        expected_server_identity: 'server-studio', expected_server_instance_id: 'boot-studio',
        confirmed: true, server_name: 'Studio member'
      })
    })
  })

  it('binds update status reads to the exact server identity and boot', async () => {
    const calls: Array<{ url: string; headers: IncomingMessage['headers'] }> = []
    await withLocalHTTPServer((request, response) => {
      calls.push({ url: request.url ?? '', headers: request.headers })
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        phase: 'current', current_version: '0.1.26-beta.28',
        server_identity: 'server-a', server_instance_id: 'boot-a'
      }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      await client.serverUpdateStatus({
        expected_server_identity: 'server-a',
        expected_server_instance_id: 'boot-a'
      })
    })

    expect(calls[0].url).toBe(
      '/api/admin/update?expected_server_identity=server-a&expected_server_instance_id=boot-a'
    )
    expect(calls[0].headers['x-agentsdock-token']).toBe('chat-secret')
    expect(calls[0].url).not.toContain('chat-secret')
    expect(calls[0].headers['sec-fetch-mode']).toBeUndefined()
  })

  it('normalizes stale update-available flags on every terminal update response', async () => {
    const statuses: Record<string, unknown> = {
      '/api/admin/update': { phase: 'current', current_version: '0.1.26-beta.26', update_available: true },
      '/api/admin/update/check': {
        phase: 'complete', current_version: '0.1.26-beta.26', installed_version: '0.1.26-beta.26',
        update_available: true
      },
      '/api/admin/update/start': {
        phase: 'complete', current_version: '0.1.26-beta.26', target_version: '0.1.26-beta.26',
        update_available: true
      },
      '/api/admin/update/cancel': { phase: 'current', current_version: '0.1.26-beta.26', update_available: true }
    }
    let responses: ServerUpdateStatus[] = []
    await withLocalHTTPServer((request, response) => {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(statuses[request.url ?? '']))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      responses = await Promise.all([
        client.serverUpdateStatus(),
        client.checkServerUpdate('beta'),
        client.startServerUpdate('0.1.26-beta.26', 'beta'),
        client.cancelServerUpdate('44444444444444444444444444444444')
      ])
    })

    expect(responses.map(status => status.update_available)).toEqual([false, false, false, false])
  })

  it('requests a durable update-when-idle reservation and can cancel its exact id', async () => {
    const calls: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = []
    const target = {
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-a'
    }
    await withLocalHTTPServer(async (request, response) => {
      const body = await incomingBody(request)
      calls.push({ url: request.url ?? '', headers: request.headers, body })
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ phase: 'available', current_version: '0.1.0' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'chat-secret')
      await client.startServerUpdate('0.1.26-beta.11', 'beta', true, target)
      await client.cancelServerUpdate('44444444444444444444444444444444', target)
    })

    expect(calls[0].url).toBe('/api/admin/update/start')
    expect(JSON.parse(calls[0].body)).toEqual({
      version: '0.1.26-beta.11',
      track: 'beta',
      when_idle: true,
      ...target
    })
    expect(calls[1].url).toBe('/api/admin/update/cancel')
    expect(JSON.parse(calls[1].body)).toEqual({
      schedule_id: '44444444444444444444444444444444',
      ...target
    })
    expect(calls[0].headers['x-agentsdock-token']).toBe('chat-secret')
    expect(calls[1].headers['x-agentsdock-token']).toBe('chat-secret')
    expect(calls[0].headers['sec-fetch-mode']).toBeUndefined()
    expect(calls[1].headers['sec-fetch-mode']).toBeUndefined()
  })

  it('requests compact session summaries for background synchronization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.sessions()

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://example.test:7850/api/sessions?summary=true')
  })

  it('renders structured runtime preflight errors as actionable text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { code: 'runtime_unavailable', message: 'Codex is not installed.', action: 'Install Codex, then refresh runtime status.' }
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await expect(client.runtimeCatalog()).rejects.toThrow('Codex is not installed. Install Codex, then refresh runtime status.')
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

  it('opts into semantic paging and preserves its counts and boundary cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' },
      events: [{ id: 'e80', session_id: 'chat', seq: 80, type: 'turn_finished', ts: 'now', run_id: 'run-1' }],
      queued_turns: [],
      events_omitted_before: 500,
      event_count: 5_000,
      semantic_item_count: 1,
      semantic_total: 900,
      semantic_omitted_before: 899,
      semantic_omitted_after: 0,
      next_semantic_before: 75
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    const page = await client.sessionPage('chat', {
      before: 100,
      limit: 120,
      tail: true,
      visible: true,
      pageMode: 'semantic'
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('page_mode=semantic')
    expect(page).toMatchObject({
      has_more: true,
      semantic_item_count: 1,
      semantic_total: 900,
      semantic_omitted_before: 899,
      semantic_omitted_after: 0,
      next_semantic_before: 75
    })
  })

  it('detects a legacy server that ignores semantic paging and falls back to raw omission metadata', async () => {
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

    const page = await client.sessionPage('chat', {
      before: 100,
      limit: 120,
      tail: true,
      visible: true,
      pageMode: 'semantic'
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('page_mode=semantic')
    expect(page).toMatchObject({
      has_more: true,
      events_omitted_before: 42,
      semantic_item_count: null,
      semantic_omitted_before: null,
      semantic_paging: false
    })
  })

  it('authorizes server-side linked file requests without exposing the token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('file', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.linkedFileRequest('chat', 'out/report.csv')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sessions/chat/links/file?target=out%2Freport.csv')
    expect(url).not.toContain('secret')
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
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
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
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
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
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
    expect(socket.protocols).toBeUndefined()
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
    vi.advanceTimersByTime(120)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [resizeURL, resizeInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(resizeURL).toContain('/api/sessions/chat%20with%20spaces/terminal/resize')
    expect(JSON.parse(String(resizeInit.body))).toEqual({ columns: 160, rows: 52 })

    connection.close()
    socket.emit('close', undefined, { code: 1000 })
    vi.advanceTimersByTime(20_000)
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states.at(-1)).toBe('disconnected')
  })

  it('times out and retries a terminal websocket stuck during connection', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ state: string; error?: string | null }> = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const connection = client.terminal('chat', { columns: 80, rows: 24 }, () => {}, state => states.push(state))
    const first = FakeWebSocket.instances[0]
    first.readyState = 0

    vi.advanceTimersByTime(10_000)
    expect(first.closed).toBe(true)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      state: 'reconnecting',
      error: 'Terminal connection timed out'
    }))
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    connection.close()
  })

  it('keeps the replacement terminal watchdog armed when the timed-out socket opens late', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const connection = client.terminal('chat', { columns: 80, rows: 24 }, () => {}, () => {})
    const first = FakeWebSocket.instances[0]
    first.readyState = 0

    vi.advanceTimersByTime(10_500)
    const second = FakeWebSocket.instances[1]
    second.readyState = 0
    first.emit('open')
    vi.advanceTimersByTime(10_000)

    expect(second.closed).toBe(true)
    connection.close()
  })

  it('does not let a late close flush the replacement terminal decoder', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const output: string[] = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const connection = client.terminal('chat', { columns: 80, rows: 24 }, data => output.push(data), () => {})
    const first = FakeWebSocket.instances[0]

    first.emit('error')
    vi.advanceTimersByTime(500)
    const second = FakeWebSocket.instances[1]
    second.emit('message', Uint8Array.of(0xe2).buffer)
    first.emit('close', undefined, { code: 1006 })
    second.emit('message', Uint8Array.of(0x82, 0xac).buffer)

    expect(output).toEqual(['', '€'])
    connection.close()
  })

  it('opens port tunnels with encoded routes and subprotocol-only authentication', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('https://example.test:7850', 'port-secret')

    const socket = client.portTunnelSocket('chat /?', 7007)
    const created = FakeWebSocket.instances[0]

    expect(created.url.protocol).toBe('wss:')
    expect(created.url.pathname).toBe('/api/sessions/chat%20%2F%3F/ports/7007/tunnel/ws')
    expect(created.url.searchParams.get('token')).toBeNull()
    expect(created.protocols).toEqual([
      'agentsdock-port-tunnel-v1',
      `agentsdock-token.${Buffer.from('port-secret', 'utf8').toString('base64url')}`
    ])
    expect(created.binaryType).toBe('arraybuffer')

    client.dispose()
    expect(socket.readyState).toBe(3)
    expect(created.closed).toBe(true)
  })

  it('rejects privileged remote port tunnel destinations', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    expect(() => client.portTunnelSocket('chat', 443)).toThrow('1024 through 65535')
    expect(FakeWebSocket.instances).toEqual([])
  })

  it('reconnects after an unmarked terminal error control packet and preserves its message', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ state: string; error?: string | null }> = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const connection = client.terminal('chat', { columns: 80, rows: 24 }, () => {}, state => states.push(state))
    const socket = FakeWebSocket.instances[0]

    socket.emit('message', JSON.stringify({ type: 'error', message: 'Terminal attach raced a managed restart.' }))
    socket.emit('close', undefined, { code: 1006, reason: 'closed after error' })
    expect(states.at(-1)).toEqual(expect.objectContaining({
      state: 'reconnecting', error: 'Terminal attach raced a managed restart.'
    }))
    vi.advanceTimersByTime(500)

    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(socket.sent).toEqual([])
    connection.close()
  })

  it('does not retry a terminal for an archived chat', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ state: string; error?: string | null }> = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    client.terminal('chat', { columns: 80, rows: 24 }, () => {}, state => states.push(state))

    FakeWebSocket.instances[0].emit('close', undefined, { code: 4409 })
    vi.advanceTimersByTime(20_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      state: 'error',
      error: 'Unarchive this chat before opening its terminal.'
    }))
  })

  it.each([
    [4401, 'Terminal authorization failed'],
    [4406, 'Terminal protocol was rejected']
  ])('does not retry a terminal after fatal close code %i', (code, message) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ state: string; error?: string | null }> = []
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    client.terminal('chat', { columns: 80, rows: 24 }, () => {}, state => states.push(state))

    FakeWebSocket.instances[0].emit('close', undefined, { code })
    vi.advanceTimersByTime(20_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states.at(-1)).toEqual(expect.objectContaining({ state: 'error', error: message }))
  })

  it('configure cancels an old terminal retry and binds deferred resize to one credential scope', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://first.example.test:7850', 'first-token')
    const firstConnection = client.terminal('chat', { columns: 100, rows: 30 }, () => {}, () => {})
    const first = FakeWebSocket.instances[0]
    expect(first.url.hostname).toBe('first.example.test')
    expect(first.url.searchParams.get('token')).toBe('first-token')
    expect(first.protocols).toBeUndefined()
    first.emit('close')

    client.configure('http://second.example.test:7850', 'second-token')
    firstConnection.resize(120, 40)
    const secondConnection = client.terminal('chat', { columns: 120, rows: 40 }, () => {}, () => {})
    secondConnection.resize(140, 50)
    vi.advanceTimersByTime(5_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url.hostname).toBe('second.example.test')
    expect(FakeWebSocket.instances[1].url.searchParams.get('token')).toBe('second-token')
    expect(FakeWebSocket.instances[1].protocols).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [resizeURL, resizeInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(resizeURL).toContain('http://second.example.test:7850/api/sessions/chat/terminal/resize')
    expect(new Headers(resizeInit.headers).get('X-AgentsDock-Token')).toBe('second-token')
    secondConnection.close()
  })

  it('uses authenticated, encoded routes for every Codex control operation', async () => {
    const interaction = {
      id: 'request-1',
      session_id: 'chat one',
      thread_id: 'thread-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
      created_at: '2026-07-27T00:00:00Z'
    }
    const payload = {
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [interaction],
      permission_profiles: [{ id: ':workspace', allowed: true }],
      background_terminals_supported: true,
      interaction,
      profiles: [{ id: ':workspace', allowed: true }],
      accepted: true,
      operation_id: 'operation-1',
      thread: { id: 'thread-1' },
      supported: true,
      terminals: [],
      terminated: true,
      cleaned: true
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.codexRuntime('chat one')
    await client.loadCodexThread('chat one')
    await client.resolveCodexInteraction('chat one', 'request/1', { decision: 'accept' })
    await client.codexPermissionProfiles('chat one')
    await client.codexGoal('chat one')
    await client.setCodexGoal('chat one', {
      objective: 'Finish the migration',
      token_budget: 20_000,
      time_budget_seconds: 3_600
    })
    await client.clearCodexGoal('chat one')
    await client.compactCodexThread('chat one')
    await client.rollbackCodexThread('chat one', {
      num_turns: 2,
      confirmed: true
    })
    await client.reviewCodexThread('chat one', {
      target: { type: 'baseBranch', branch: 'main' }
    })
    await client.shellCodexThread('chat one', { command: 'git status --short', confirmed: true })
    await client.codexBackgroundTerminals('chat one')
    await client.terminateCodexBackgroundTerminal('chat one', {
      process_id: 'process/1',
      confirmed: true
    })
    await client.cleanCodexBackgroundTerminals('chat one', { confirmed: true })

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url]) => url)).toEqual([
      'http://example.test:7850/api/sessions/chat%20one/codex/runtime',
      'http://example.test:7850/api/sessions/chat%20one/codex/load',
      'http://example.test:7850/api/sessions/chat%20one/codex/interactions/request%2F1/resolve',
      'http://example.test:7850/api/sessions/chat%20one/codex/permission-profiles',
      'http://example.test:7850/api/sessions/chat%20one/codex/goal',
      'http://example.test:7850/api/sessions/chat%20one/codex/goal',
      'http://example.test:7850/api/sessions/chat%20one/codex/goal',
      'http://example.test:7850/api/sessions/chat%20one/codex/compact',
      'http://example.test:7850/api/sessions/chat%20one/codex/rollback',
      'http://example.test:7850/api/sessions/chat%20one/codex/review',
      'http://example.test:7850/api/sessions/chat%20one/codex/shell',
      'http://example.test:7850/api/sessions/chat%20one/codex/background-terminals',
      'http://example.test:7850/api/sessions/chat%20one/codex/background-terminals/terminate',
      'http://example.test:7850/api/sessions/chat%20one/codex/background-terminals/clean'
    ])
    expect(calls.every(([, init]) => new Headers(init.headers).get('X-AgentsDock-Token') === 'secret')).toBe(true)
    expect(calls.map(([, init]) => init.method ?? 'GET')).toEqual([
      'GET', 'POST', 'POST', 'GET', 'GET', 'PUT', 'DELETE', 'POST', 'POST', 'POST', 'POST', 'GET', 'POST', 'POST'
    ])
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ response: { decision: 'accept' } })
    expect(JSON.parse(String(calls[5][1].body))).toEqual({
      objective: 'Finish the migration',
      token_budget: 20_000,
      time_budget_seconds: 3_600
    })
    expect(JSON.parse(String(calls[8][1].body))).toEqual({
      num_turns: 2,
      confirmed: true
    })
    expect(JSON.parse(String(calls[9][1].body))).toEqual({
      target: { type: 'baseBranch', branch: 'main' },
      delivery: 'inline'
    })
    expect(JSON.parse(String(calls[10][1].body))).toEqual({
      command: 'git status --short',
      confirmed: true
    })
    expect(JSON.parse(String(calls[12][1].body))).toEqual({
      process_id: 'process/1',
      confirmed: true
    })
    expect(JSON.parse(String(calls[13][1].body))).toEqual({ confirmed: true })
  })

  it('uses authenticated, encoded routes for Claude SDK runtime, MCP controls, refresh, and interactions', async () => {
    const interaction = {
      id: 'permission-1',
      session_id: 'claude chat',
      claude_session_id: 'provider-1',
      method: 'item/tool/requestApproval',
      params: {},
      created_at: '2026-08-05T00:00:00Z'
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      available: true,
      transport: 'sdk',
      interactive_capability: 'claude_sdk_interactive_v1',
      session_loaded: true,
      status: { type: 'idle' },
      pending_interactions: [interaction],
      interaction
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.claudeRuntime('claude chat')
    await client.refreshClaudeContextUsage('claude chat')
    await client.claudeMcp('claude chat')
    await client.controlClaudeMcp('claude chat', {
      version: 1,
      action: 'reconnect_all',
      server_name: null,
      expected_generation: 'owner-a:sdk-7'
    })
    await client.resolveClaudeInteraction('claude chat', 'permission/1', { decision: 'accept' })

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url]) => url)).toEqual([
      'http://example.test:7850/api/sessions/claude%20chat/claude/runtime',
      'http://example.test:7850/api/sessions/claude%20chat/claude/context-usage/refresh',
      'http://example.test:7850/api/sessions/claude%20chat/claude/mcp',
      'http://example.test:7850/api/sessions/claude%20chat/claude/mcp',
      'http://example.test:7850/api/sessions/claude%20chat/claude/interactions/permission%2F1/resolve'
    ])
    expect(calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET', 'POST', 'POST'])
    expect(calls.every(([, init]) => new Headers(init.headers).get('X-AgentsDock-Token') === 'secret')).toBe(true)
    expect(JSON.parse(String(calls[1][1].body))).toEqual({})
    expect(JSON.parse(String(calls[3][1].body))).toEqual({
      version: 1,
      action: 'reconnect_all',
      server_name: null,
      expected_generation: 'owner-a:sdk-7'
    })
    expect(JSON.parse(String(calls[4][1].body))).toEqual({ response: { decision: 'accept' } })
  })

  it('allows a native Codex thread resume to use the full lifecycle timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      persisted_thread: true,
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: true
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.loadCodexThread('chat')

    expect(timeout).toHaveBeenCalledWith(300_000)
  })

  it('allows digest preview to outlive the server LLM timeout window', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      digest: '# AgentsDock Context Digest\n\nReady.'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.previewDigest('source chat', 'target chat', 'normal', 'Focus here')).resolves.toContain('Context Digest')

    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(210_000)
  })

  it('bounds background subagent hydration with its dedicated short timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'chat',
      subagents: [],
      count: 0,
      active_count: 0,
      latest_seq: 0
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.subagents('chat')

    expect(timeout).toHaveBeenCalledWith(15_000)
  })

  it('opts Electron turns into interactive app-server prompts without changing the public composer input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.sendTurn('chat', 'Review this', [], 'gpt-5', 'high')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Review this',
      file_ids: [],
      model: 'gpt-5',
      effort: 'high',
      client_capabilities: ['codex_interactive_v1']
    })
  })

  it('lists session-scoped provider commands and forwards opaque skill selections without paths', async () => {
    const selection = {
      id: 'pcmd_0123456789abcdef0123456789abcdef',
      revision: 'pcmdrev_0123456789abcdef0123456789abcdef'
    }
    const snapshot = {
      backend: 'codex',
      revision: selection.revision,
      support: { available: true, mode: 'native' },
      commands: [{
        id: selection.id, name: 'review-code', label: 'Review code',
        description: 'Review the current change', scope: 'project', source: 'codex',
        kind: 'skill', invocation: '/review-code'
      }]
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: { id: 'chat', title: 'Chat', backend: 'codex' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.providerCommands('chat /?')).resolves.toEqual(snapshot)
    await expect(client.providerCommands('chat /?', true)).resolves.toEqual(snapshot)
    await client.sendTurn('chat', '/review-code focus on races', [], null, null, [], [], [], selection)

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/provider-commands?refresh=false')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/provider-commands?refresh=true')
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.skill_selection).toEqual(selection)
    expect(JSON.stringify(body.skill_selection)).not.toContain('path')

    await expect(client.sendTurn('chat', '/review-code', [], null, null, [], [], [], {
      ...selection,
      path: '/Users/example/.codex/skills/review-code'
    } as typeof selection)).rejects.toThrow('Invalid provider command selection.')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('forwards an explicitly capability-gated Claude SDK opt-in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'claude' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await client.sendTurn('chat', 'Continue', [], null, null, [
      'codex_interactive_v1',
      'claude_sdk_interactive_v1'
    ])

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).client_capabilities).toEqual([
      'codex_interactive_v1',
      'claude_sdk_interactive_v1'
    ])
  })

  it('forwards structured chat references only when the composer supplied them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const reference = {
      session_id: 'target',
      display_title_snapshot: 'Target',
      source_text_start: 7,
      source_text_end: 14,
      action: 'instruction' as const
    }

    await client.sendTurn('chat', 'Ask in @Target', [], null, null, ['cross_chat_handoffs_v1'], [reference])

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      client_capabilities: ['cross_chat_handoffs_v1'],
      chat_references: [reference]
    })
  })

  it('projects FastAPI Team Network validation details without raw recipient records', async () => {
    const detail = [{
      type: 'value_error',
      loc: ['body', 'team_references', 0],
      msg: "Value error, team-wide recipients use the visible token '@@all'",
      input: {
        kind: 'recipient', recipient_kind: 'all', team_id: 'team_93daaefe6a0', target_id: 'all',
        display_name_snapshot: 'bulletin', source_text_start: 34, source_text_end: 44,
        grant_intent: true
      },
      ctx: { error: {} }
    }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.sendTurn('chat', 'Post to @@bulletin', [], null, null, [], [], [{
      kind: 'recipient', recipient_kind: 'all', team_id: 'team_93daaefe6a0', target_id: 'all',
      display_name_snapshot: 'bulletin', source_text_start: 8, source_text_end: 18, grant_intent: true
    }])).rejects.toMatchObject({
      status: 422,
      detail,
      message: 'This AgentsServer does not support @@bulletin yet. Update the server and try again.'
    })
  })

  it('edits an exact queued agent message with its expected revision and no route grants', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await client.updateQueued('chat', 'queued-agent', 'Revised reply with literal @name', undefined, undefined, undefined, 3)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/sessions/chat/queue/queued-agent')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'Revised reply with literal @name', expected_message_revision: 3 })
  })

  it('forwards the additive v2 client capability with request-reply authority', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'chat', title: 'Chat', backend: 'codex' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const reference = {
      session_id: 'target', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'request_reply' as const
    }

    await client.sendTurn('chat', 'Ask @Target', [], null, null, [
      'codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'
    ], [reference])

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Ask @Target', file_ids: [], model: '', effort: '',
      client_capabilities: ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'],
      chat_references: [reference]
    })
  })

  it('forwards refreshed v2 capabilities on a queued-turn action upgrade', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    const reference = {
      session_id: 'target', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'request_reply' as const
    }
    const capabilities = ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2']

    await client.updateQueued('chat /?', 'queued /?', 'Ask @Target', [reference], capabilities)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/queue/queued%20%2F%3F')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Ask @Target', chat_references: [reference], client_capabilities: capabilities
    })
  })

  it('loads a full cross-chat handoff only through the authenticated detail route', async () => {
    const handoff = {
      id: 'handoff-1', kind: 'instruction', action: 'instruction',
      source_session_id: 'source', source_run_id: 'run-1', target_session_id: 'target',
      status: 'queued', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
      body: 'Inspect the renderer.', body_chars: 21, body_sha256: 'abc123'
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ handoff }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.crossChatHandoff('handoff/1')).resolves.toEqual(handoff)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/cross-chat/handoffs/handoff%2F1')
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit)?.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('cancels a queued handoff through its authenticated mutation route', async () => {
    const handoff = {
      id: 'handoff-1', kind: 'instruction', action: 'instruction',
      source_session_id: 'source', source_run_id: 'run-1', target_session_id: 'target',
      status: 'cancelled', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
      body: '', body_chars: 0, body_sha256: ''
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ handoff }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.cancelCrossChatHandoff('handoff-1')).resolves.toEqual(handoff)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/cross-chat/handoffs/handoff-1/cancel')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit)?.method).toBe('POST')
  })

  it('loads bounded exchange details through the authenticated v2 route', async () => {
    const exchange = crossChatExchangeFixture()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ exchange }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.crossChatExchange('exchange/1')).resolves.toEqual(exchange)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/cross-chat/exchanges/exchange%2F1')
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit)?.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('cancels a bounded exchange with an empty authenticated POST', async () => {
    const exchange = { ...crossChatExchangeFixture(), status: 'cancelled' as const }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ exchange }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.cancelCrossChatExchange('exchange-1')).resolves.toEqual(exchange)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://example.test:7850/api/cross-chat/exchanges/exchange-1/cancel')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({})
  })
})

function crossChatExchangeFixture() {
  return {
    id: 'exchange-1', status: 'active' as const,
    requester_session_id: 'source', responder_session_id: 'target',
    authorization_source_run_id: 'run-1', max_legs: 6, used_legs: 1, remaining_legs: 5,
    active_leg_id: 'leg-1', error_code: null, error: null,
    expires_at: '2026-08-13T00:00:00Z', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z',
    legs: [{
      id: 'leg-1', exchange_id: 'exchange-1', parent_leg_id: null, ordinal: 1,
      kind: 'request' as const, expects_reply: true, response_state: 'open' as const, status: 'running' as const,
      source_session_id: 'source', source_run_id: 'run-1', target_session_id: 'target', target_run_id: 'run-2',
      queued_id: null, body: 'Inspect the renderer.', body_chars: 21, body_sha256: 'abc123',
      error_code: null, error: null, created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:01Z'
    }]
  }
}

describe('AgentServerClient persistent agent handoff routes', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('lists and revision-deletes individual Mail routes with encoded source and route IDs', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit = {}) => new Response(JSON.stringify(init.method === 'DELETE'
      ? { ok: true, deleted: true, route_id: 'mailgrant /?' }
      : { routes: [], max_routes: 16 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await expect(client.agentTeamMailRoutes('source /?')).resolves.toEqual({ routes: [], max_routes: 16 })
    await expect(client.deleteAgentTeamMailRoute('source /?', 'mailgrant /?', 'rev /?')).resolves.toMatchObject({ deleted: true })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://example.test:7850/api/sessions/source%20%2F%3F/agent-team-mail-routes',
      'http://example.test:7850/api/sessions/source%20%2F%3F/agent-team-mail-routes/mailgrant%20%2F%3F?expected_revision=rev+%2F%3F'
    ])
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE')
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('uses the authenticated v3 admin routes with encoded source and route IDs', async () => {
    const route = {
      route_id: 'route /?', revision: `rev_${'a'.repeat(32)}`, alias: 'agentsdock-mobile', target_session_id: 'target /?',
      actions: ['instruction', 'request_reply'], created_at: '2026-08-18T00:00:00Z', updated_at: '2026-08-18T00:00:00Z',
      target: { title: 'AgentsDock Mobile', folder: 'Apps', backend: 'codex', available: true, unavailable_reason: null }
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      if (url.includes('/api/chats/search?')) return new Response(JSON.stringify({
        chats: [{ id: 'target /?', title: 'AgentsDock Mobile', folder: 'Apps', backend: 'codex', cross_chat_handoff_supported: true }],
        query: 'Mobile', limit: 12, truncated: false, server_identity: 'server-a'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (init.method === 'DELETE') return new Response(JSON.stringify({ ok: true, deleted: true, route_id: route.route_id }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (init.method === 'POST' || init.method === 'PATCH') return new Response(JSON.stringify({ route }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ routes: [route], max_routes: 16 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.agentHandoffRoutes('source /?')).resolves.toEqual({ routes: [route], max_routes: 16 })
    await expect(client.searchAgentHandoffTargets('Mobile', 'source /?', 12)).resolves.toMatchObject({ query: 'Mobile' })
    await expect(client.createAgentHandoffRoute('source /?', {
      alias: 'agentsdock-mobile', target_session_id: 'target /?', actions: ['instruction', 'request_reply']
    })).resolves.toEqual(route)
    await expect(client.updateAgentHandoffRoute('source /?', 'route /?', {
      expected_revision: `rev_${'a'.repeat(32)}`, alias: 'mobile', actions: ['request_reply']
    })).resolves.toEqual(route)
    const deleteRevision = `rev_${'b'.repeat(32)}`
    await expect(client.deleteAgentHandoffRoute('source /?', 'route /?', deleteRevision)).resolves.toEqual({
      ok: true, deleted: true, route_id: 'route /?'
    })

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://example.test:7850/api/sessions/source%20%2F%3F/agent-handoff-routes?unlimited_routes=true',
      'http://example.test:7850/api/chats/search?q=Mobile&limit=12&exclude_session_id=source+%2F%3F',
      'http://example.test:7850/api/sessions/source%20%2F%3F/agent-handoff-routes',
      'http://example.test:7850/api/sessions/source%20%2F%3F/agent-handoff-routes/route%20%2F%3F',
      `http://example.test:7850/api/sessions/source%20%2F%3F/agent-handoff-routes/route%20%2F%3F?expected_revision=${deleteRevision}`
    ])
    expect(fetchMock.mock.calls.map(call => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual([
      'GET', 'GET', 'POST', 'PATCH', 'DELETE'
    ])
    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call[1] as RequestInit | undefined)?.headers).get('X-AgentsDock-Token')).toBe('secret')
    }
    expect(JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body))).toEqual({
      expected_revision: `rev_${'a'.repeat(32)}`, alias: 'mobile', actions: ['request_reply']
    })
  })

  it('opts into an unlimited route snapshot without replacing its null limit', async () => {
    const snapshot = { routes: Array.from({ length: 20 }, (_, index) => ({
      route_id: `route-${index}`, revision: `rev_${'a'.repeat(32)}`, alias: `target-${index}`, target_session_id: `chat-${index}`,
      actions: ['instruction'], created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
      target: { title: `Target ${index}`, folder: null, backend: 'codex', available: true, unavailable_reason: null }
    })), max_routes: null }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')
    await expect(client.agentHandoffRoutes('source /?')).resolves.toEqual(snapshot)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.test:7850/api/sessions/source%20%2F%3F/agent-handoff-routes?unlimited_routes=true')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves structured server error detail for revision-conflict handling', async () => {
    const detail = { code: 'route_revision_conflict', message: 'Changed elsewhere.', current_route: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail }), {
      status: 409, headers: { 'Content-Type': 'application/json' }
    })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.updateAgentHandoffRoute('source', 'route-1', {
      expected_revision: `rev_${'a'.repeat(32)}`, alias: 'mobile'
    })).rejects.toMatchObject({ status: 409, detail })
  })
})

describe('AgentServerClient emergency contact bridge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    FakeWebSocket.instances = []
  })

  it('acknowledges the exact alert through the encoded authenticated session route', async () => {
    const alertId = `emergency_${'a'.repeat(32)}`
    const session: Session = {
      id: 'chat /?', title: 'Emergency chat', backend: 'codex',
      emergency_alert: null, unacknowledged_emergency_count: 0
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session,
      acknowledged: true
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.acknowledgeEmergency('chat /?', alertId)).resolves.toEqual(session)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://example.test:7850/api/sessions/chat%20%2F%3F/emergency/acknowledge')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ expected_alert_id: alertId })
    expect(new Headers(init.headers).get('X-AgentsDock-Token')).toBe('secret')
  })

  it('rejects an acknowledgement response for a different chat', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session: {
        id: 'different-chat', title: 'Wrong chat', backend: 'codex',
        emergency_alert: null, unacknowledged_emergency_count: 0
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const client = new AgentServerClient('http://example.test:7850', 'secret')

    await expect(client.acknowledgeEmergency(
      'expected-chat',
      `emergency_${'a'.repeat(32)}`
    )).rejects.toThrow('invalid emergency acknowledgement')
  })

  it('delivers validated global snapshots and changes while rejecting malformed alert packets', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received: Array<{ sessions: Session[]; snapshot: boolean; removedSessionId?: string }> = []
    const states: Array<{ connected: boolean; error?: string }> = []
    const client = new AgentServerClient('https://example.test:7850', 'stream-secret')
    const stop = client.emergencyStream(
      'server-expected',
      (sessions, snapshot, removedSessionId) => received.push({ sessions, snapshot, removedSessionId }),
      (connected, error) => states.push({ connected, error })
    )
    const socket = FakeWebSocket.instances[0]
    const quiet: Session = {
      id: 'quiet', title: 'Quiet', backend: 'claude',
      emergency_alert: null, unacknowledged_emergency_count: 0
    }
    const active: Session = {
      id: 'urgent', title: 'Urgent', backend: 'cursor',
      emergency_alert: {
        id: `emergency_${'b'.repeat(32)}`,
        status: 'active',
        severity: 'critical',
        message: 'The deployment is unsafe.',
        raised_at: '2026-08-25T12:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }

    expect(socket.url.protocol).toBe('wss:')
    expect(socket.url.pathname).toBe('/api/emergency-alerts/events')
    expect(socket.url.searchParams.get('token')).toBeNull()
    expect(socket.protocols).toEqual([
      'agentsdock-emergency-v1',
      `agentsdock-token.${Buffer.from('stream-secret', 'utf8').toString('base64url')}`
    ])
    socket.emit('open')
    socket.emit('message', JSON.stringify({ type: 'emergency_snapshot', server_identity: 'server-expected', sessions: [quiet, active] }))
    socket.emit('message', JSON.stringify({ type: 'emergency_changed', server_identity: 'server-expected', session: quiet }))
    socket.emit('message', JSON.stringify({ type: 'emergency_removed', server_identity: 'server-expected', session_id: 'quiet' }))
    socket.emit('message', JSON.stringify({
      type: 'emergency_changed',
      server_identity: 'server-expected',
      session: {
        ...active,
        emergency_alert: { ...active.emergency_alert, message: 'x'.repeat(501) }
      }
    }))

    expect(states).toEqual([
      { connected: true, error: undefined },
      { connected: false, error: 'Emergency alert stream sent an invalid update' }
    ])
    expect(received).toEqual([
      { sessions: [quiet, active], snapshot: true, removedSessionId: undefined },
      { sessions: [quiet], snapshot: false, removedSessionId: undefined },
      { sessions: [], snapshot: false, removedSessionId: 'quiet' }
    ])
    expect(socket.closed).toBe(true)
    socket.emit('open')
    socket.emit('message', JSON.stringify({
      type: 'emergency_changed', server_identity: 'server-expected', session: active
    }))
    expect(states).toHaveLength(2)
    expect(received).toHaveLength(3)
    stop()
  })

  it('rejects packets from a replacement server before exposing any session state', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const received = vi.fn()
    const states: Array<{ connected: boolean; error?: string }> = []
    const client = new AgentServerClient('https://example.test:7850', 'stream-secret')
    const stop = client.emergencyStream(
      'server-expected',
      received,
      (connected, error) => states.push({ connected, error })
    )
    const socket = FakeWebSocket.instances[0]

    socket.emit('open')
    socket.emit('message', JSON.stringify({
      type: 'emergency_snapshot',
      server_identity: 'server-replacement',
      sessions: []
    }))

    expect(received).not.toHaveBeenCalled()
    expect(states).toEqual([
      { connected: true, error: undefined },
      { connected: false, error: 'Emergency alert stream server identity changed' }
    ])
    expect(socket.closed).toBe(true)
    stop()
  })

  it.each([
    [4401, 'Emergency alert authorization failed'],
    [4406, 'Emergency alert protocol was rejected']
  ])('stops the emergency stream without retrying fatal close code %i', (code, error) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: Array<{ connected: boolean; error?: string }> = []
    const client = new AgentServerClient('https://example.test:7850', 'stream-secret')
    client.emergencyStream(
      'server-expected',
      () => {},
      (connected, stateError) => states.push({ connected, error: stateError })
    )
    const socket = FakeWebSocket.instances[0]

    socket.emit('close', undefined, { code })
    vi.advanceTimersByTime(20_000)

    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states).toEqual([{ connected: false, error }])
  })
})
