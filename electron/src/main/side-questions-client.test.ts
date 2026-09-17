import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentServerClient, type AgentServerClientOptions } from './server-client'

const token = 'synthetic-owner-token'
const input = { request_id: 'request-a', question: 'Why?' }
const answer = { request_id: 'request-a', session_id: 'chat-a', backend: 'codex', answer: 'Because.', context_note: 'Recent snapshot.' }
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('side-question native HTTP contract', () => {
  it('passes the native owner guard that rejects real fetch and preserves follow-up history', async () => {
    vi.unstubAllGlobals() // Restore actual Node fetch instead of the global test safety stub.
    const requests: Array<{ request: IncomingMessage; body: string }> = []
    const timeoutSignal = vi.fn(() => new AbortController().signal)
    const followup = { ...input, history: [
      { role: 'user' as const, text: 'First?' }, { role: 'assistant' as const, text: 'First answer.' }
    ] }
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
    expect(timeoutSignal).toHaveBeenCalledExactlyOnceWith(210_000)
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
      })
      expect(requests).toEqual([`POST ${path}`, `DELETE ${path}/request-a`])
    })
    expect(redirected).toBe(0)
  })

  it('rejects malformed side-question paths before sending credentials', async () => {
    let requests = 0
    await localTransport((_request, response) => { requests++; json(response, answer) }, async client => {
      await expect(client.askSideQuestion('chat/a', input)).rejects.toThrow('route is invalid')
      await expect(client.cancelSideQuestion('chat-a', 'request/a')).rejects.toThrow('route is invalid')
    })
    expect(requests).toBe(0)
  })

  it.each(['caller', 'timeout', 'configure', 'dispose'] as const)('aborts the in-flight native request on %s', async source => {
    const caller = new AbortController()
    const deadline = new AbortController()
    let received!: () => void
    const started = new Promise<void>(resolve => { received = resolve })
    await localTransport((_request, _response) => { received() }, async client => {
      const pending = client.askSideQuestion('chat-a', input, caller.signal)
      const rejected = expect(pending).rejects.toBeInstanceOf(Error)
      await started
      if (source === 'caller') caller.abort(new Error('caller cancelled'))
      if (source === 'timeout') deadline.abort(new Error('deadline elapsed'))
      if (source === 'configure') client.configure(client.url(''), 'replacement-token')
      if (source === 'dispose') client.dispose()
      await rejected
    }, { timeoutSignal: () => deadline.signal })
  })
})
