import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentServerClient, type AgentServerClientOptions } from './server-client'

const token = 'synthetic-owner-token'
const input = { request_id: 'request-a', question: 'Why?', side_chat_id: 'side-a' }
const answer = { request_id: 'request-a', session_id: 'chat-a', backend: 'codex', answer: 'Because.', context_note: 'Native ephemeral fork.' }
const path = '/api/sessions/chat-a/side-questions'

async function localTransport(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  test: (client: AgentServerClient) => Promise<void>,
  options: AgentServerClientOptions = {}
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ detail: String(error) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, options)
  try { await test(client) } finally {
    client.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function browserHeaders(request: IncomingMessage): string[] {
  // Match AgentsServer's privileged_native_browser_request_forbidden boundary.
  return Object.keys(request.headers).filter(name => name === 'origin' || name === 'cookie' || name.startsWith('sec-fetch-'))
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('side-question native HTTP contract', () => {
  it('uses native authenticated transport for synced reads, submission, Stop and Clear', async () => {
    const requests: Array<{ method?: string; url?: string; body: string }> = []
    const snapshot = { session_id: 'chat-a', side_chat_id: 'side-a', revision: 0, last_request_id: null, exchanges: [] }
    await localTransport(async (request, response) => {
      expect(browserHeaders(request)).toEqual([])
      expect(request.headers['x-agentsdock-token']).toBe(token)
      requests.push({ method: request.method, url: request.url, body: await body(request) })
      json(response, snapshot, request.method === 'POST' ? 202 : 200)
    }, async client => {
      await expect(client.readSyncedSideChat('chat-a')).resolves.toEqual(snapshot)
      await expect(client.submitSyncedSideChat('chat-a', input)).resolves.toEqual(snapshot)
      await expect(client.stopSyncedSideChat('chat-a', input.request_id)).resolves.toEqual(snapshot)
      await expect(client.clearSyncedSideChat('chat-a', input.side_chat_id)).resolves.toEqual(snapshot)
    })
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/sessions/chat-a/side-chat'], ['POST', '/api/sessions/chat-a/side-chat'],
      ['DELETE', '/api/sessions/chat-a/side-chat/requests/request-a'], ['DELETE', '/api/sessions/chat-a/side-chat/side-a']
    ])
    expect(JSON.parse(requests[1].body)).toEqual(input)
  })

  it('rejects foreign or malformed synced snapshots and invalid native paths', async () => {
    await localTransport((_request, response) => json(response, { session_id: 'foreign', side_chat_id: 'side-a', revision: 0, last_request_id: null, exchanges: [] }), async client => {
      await expect(client.readSyncedSideChat('chat-a')).rejects.toThrow('side_question_invalid_response')
      await expect(client.readSyncedSideChat('chat/a')).rejects.toThrow('route is invalid')
      await expect(client.stopSyncedSideChat('chat-a', 'request/a')).rejects.toThrow('route is invalid')
    })
  })

  it('passes the native owner guard and sends only the native follow-up cursor', async () => {
    vi.unstubAllGlobals() // Restore actual Node fetch instead of the global test safety stub.
    const requests: Array<{ request: IncomingMessage; body: string }> = []
    const timeoutSignal = vi.fn(() => new AbortController().signal)
    const followup = { ...input, after_request_id: 'previous-a' }
    await localTransport(async (request, response) => {
      requests.push({ request, body: await body(request) })
      if (browserHeaders(request).length) return json(response, { detail: 'forbidden' }, 403)
      if (request.headers['x-agentsdock-token'] !== token) return json(response, { detail: 'unauthorized' }, 401)
      json(response, answer)
    }, async client => {
      const rejected = await fetch(client.url(path), {
        method: 'POST', headers: { 'X-AgentsDock-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(followup), redirect: 'error'
      })
      expect(rejected.status).toBe(403)
      await rejected.text()
      await expect(client.askSideQuestion('chat-a', followup)).resolves.toEqual(answer)
    }, { timeoutSignal })
    expect(requests).toHaveLength(2)
    expect(requests[0].request.headers['sec-fetch-mode']).toBe('cors')
    const sent = requests[1]
    expect(sent.request.method).toBe('POST')
    expect(sent.request.url).toBe(path)
    expect(browserHeaders(sent.request)).toEqual([])
    expect(sent.request.headers.authorization).toBeUndefined()
    expect(sent.request.headers['x-zenithdock-token']).toBeUndefined()
    expect(sent.request.headers['x-agentsdock-token']).toBe(token)
    expect(sent.request.rawHeaders.filter(value => value.toLowerCase() === 'x-agentsdock-token')).toHaveLength(1)
    expect(JSON.parse(sent.body)).toEqual(followup)
    expect(JSON.parse(sent.body)).not.toHaveProperty('history')
    expect(timeoutSignal).not.toHaveBeenCalled()
  })

  it('keeps a native answer pending beyond the old deadline and accepts its eventual response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    let received!: (response: ServerResponse) => void
    const started = new Promise<ServerResponse>(resolve => { received = resolve })
    await localTransport((_request, response) => { received(response) }, async client => {
      let settled = false
      const pending = client.askSideQuestion('chat-a', input)
      void pending.then(() => { settled = true }, () => { settled = true })
      const response = await started
      await vi.advanceTimersByTimeAsync(210_001)
      expect(settled).toBe(false)
      expect(response.destroyed).toBe(false)
      expect(deadline).not.toHaveBeenCalled()
      json(response, answer)
      await expect(pending).resolves.toEqual(answer)
    })
  })

  it.each([{ session_id: 'wrong' }, { request_id: 'wrong' }])('rejects foreign response ownership %j', async foreign => {
    await localTransport((_request, response) => json(response, { ...answer, ...foreign }), async client => {
      await expect(client.askSideQuestion('chat-a', input)).rejects.toThrow('side_question_invalid_response')
    })
  })

  it('never retries a failed provider request or falls back to a normal turn', async () => {
    const requests: string[] = []
    await localTransport((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      json(response, { detail: 'Provider unavailable' }, 503)
    }, async client => {
      await expect(client.askSideQuestion('chat-a', input)).rejects.toThrow('Provider unavailable')
    })
    expect(requests).toEqual([`POST ${path}`])
  })

  it('cancels only the exact side-question URL using native owner headers', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    const requests: IncomingMessage[] = []
    const cancelled = { request_id: 'request-a', status: 'cancelled' }
    await localTransport((request, response) => {
      requests.push(request)
      json(response, cancelled)
    }, async client => {
      client.configure(`${new URL(client.url('')).origin}/gateway`, token)
      await expect(client.cancelSideQuestion('chat-a', 'request-a')).resolves.toEqual(cancelled)
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('DELETE')
    expect(requests[0].url).toBe(`/gateway${path}/request-a`)
    expect(browserHeaders(requests[0])).toEqual([])
    expect(requests[0].headers['x-agentsdock-token']).toBe(token)
    expect(deadline).toHaveBeenCalledExactlyOnceWith(30_000)
  })

  it('closes only the native conversation with owner headers and no request replay', async () => {
    const requests: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    await localTransport(async (request, response) => {
      expect(browserHeaders(request)).toEqual([])
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: await body(request) })
      json(response, { side_chat_id: 'side-a', status: 'closed' })
    }, async client => {
      client.configure(`${new URL(client.url('')).origin}/gateway`, token)
      await client.closeSideChat('chat-a', 'side-a')
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/gateway/api/sessions/chat-a/side-chats/side-a', body: '' })
    expect(requests[0].headers['x-agentsdock-token']).toBe(token)
  })

  it.each([{ side_chat_id: 'foreign', status: 'closed' }, { side_chat_id: 'side-a', status: 'not_found' }])(
    'rejects a mismatched native close acknowledgement %j', async receipt => {
      await localTransport((_request, response) => json(response, receipt), async client => {
        await expect(client.closeSideChat('chat-a', 'side-a')).rejects.toThrow('side_question_invalid_response')
      })
    })

  it('does not follow redirects or forward the owner credential', async () => {
    let redirected = 0
    await localTransport((_request, response) => { redirected++; json(response, answer) }, async destination => {
      const requests: string[] = []
      await localTransport((request, response) => {
        requests.push(`${request.method} ${request.url}`)
        response.writeHead(307, { Location: destination.url(path) })
        response.end()
      }, async client => {
        await expect(client.askSideQuestion('chat-a', input)).rejects.toThrow('refused an unexpected redirect')
        await expect(client.cancelSideQuestion('chat-a', input.request_id)).rejects.toThrow('refused an unexpected redirect')
        await expect(client.closeSideChat('chat-a', input.side_chat_id)).rejects.toThrow('refused an unexpected redirect')
      })
      expect(requests).toEqual([`POST ${path}`, `DELETE ${path}/request-a`, 'DELETE /api/sessions/chat-a/side-chats/side-a'])
    })
    expect(redirected).toBe(0)
  })

  it('rejects malformed side-question paths before sending credentials', async () => {
    let requests = 0
    await localTransport((_request, response) => { requests++; json(response, answer) }, async client => {
      await expect(client.askSideQuestion('chat/a', input)).rejects.toThrow('route is invalid')
      await expect(client.cancelSideQuestion('chat-a', 'request/a')).rejects.toThrow('route is invalid')
      await expect(client.closeSideChat('chat-a', 'side/a')).rejects.toThrow('route is invalid')
    })
    expect(requests).toBe(0)
  })

  it.each(['caller', 'configure', 'dispose', 'disconnect'] as const)('still ends a long-running native request on %s', async source => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const caller = new AbortController()
    let received!: (response: ServerResponse) => void
    const started = new Promise<ServerResponse>(resolve => { received = resolve })
    await localTransport((_request, response) => { received(response) }, async client => {
      const pending = client.askSideQuestion('chat-a', input, caller.signal)
      const rejected = expect(pending).rejects.toBeInstanceOf(Error)
      const response = await started
      await vi.advanceTimersByTimeAsync(210_001)
      if (source === 'caller') caller.abort(new Error('caller cancelled'))
      if (source === 'configure') client.configure(client.url(''), 'replacement-token')
      if (source === 'dispose') client.dispose()
      if (source === 'disconnect') response.destroy()
      await rejected
    })
  })
})
