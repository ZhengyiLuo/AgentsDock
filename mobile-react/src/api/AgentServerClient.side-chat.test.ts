import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as nativeRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { AgentServerClient, AgentServerClientDisposedError, AgentServerClientUnvalidatedError } from './AgentServerClient'
import { SIDE_CHAT_MAX_RESPONSE_BYTES } from '../lib/side-chat'

const snapshot = { session_id: 'chat-a', side_chat_id: 'side-a', revision: 1, last_request_id: null, exchanges: [] }
const input = { request_id: 'request-a', side_chat_id: 'side-a', question: 'Why?' }
const accepted = { ...snapshot, exchanges: [{ request_id: input.request_id, question: input.question, status: 'running', created_at: 'now', updated_at: 'now' }] }
const originalFetch = globalThis.fetch

// Exercise real TCP request bytes using a native-like transport. Node's browser
// fetch injects Sec-Fetch-Mode; this adapter does not claim native iOS acceptance.
const nativeFetch: typeof fetch = (url, init) => new Promise((resolve, reject) => {
  const req = nativeRequest(String(url), { method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined }, response => {
    const bytes: Buffer[] = []
    response.on('data', chunk => bytes.push(chunk))
    response.on('error', reject)
    response.on('end', () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode, headers: response.headers as Record<string, string> })))
  })
  req.on('error', reject)
  req.end(init?.body)
})

async function wire(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (client: AgentServerClient) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const client = new AgentServerClient(`http://127.0.0.1:${address.port}/gateway`, 'fixture-only-token')
  globalThis.fetch = nativeFetch
  try { await run(client) }
  finally { client.dispose(); globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

await test('all synchronized operations carry exactly native-control auth through real local HTTP', async () => {
  const received: Array<{ method: string; path: string; body: string }> = []
  await wire((request, response) => {
    assert.equal(request.headers['x-agentsdock-token'], 'fixture-only-token')
    for (const header of ['authorization', 'cookie', 'origin', 'x-zenithdock-token']) assert.equal(request.headers[header], undefined)
    assert(!Object.keys(request.headers).some(header => header.startsWith('sec-fetch-')))
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      received.push({ method: request.method!, path: request.url!, body })
      response.writeHead(request.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(request.method === 'POST' ? accepted
        : request.url!.endsWith('/side-a') ? { ...snapshot, side_chat_id: 'side-new' } : snapshot))
    })
  }, async client => {
    assert.deepEqual(await client.readSyncedSideChat('chat-a'), snapshot)
    assert.deepEqual(await client.submitSyncedSideChat('chat-a', input), accepted)
    await client.stopSyncedSideChat('chat-a', input.request_id)
    await client.clearSyncedSideChat('chat-a', input.side_chat_id)
  })
  assert.deepEqual(received.map(({ method, path }) => [method, path]), [
    ['GET', '/gateway/api/sessions/chat-a/side-chat'], ['POST', '/gateway/api/sessions/chat-a/side-chat'],
    ['DELETE', '/gateway/api/sessions/chat-a/side-chat/requests/request-a'], ['DELETE', '/gateway/api/sessions/chat-a/side-chat/side-a'],
  ])
  assert.deepEqual(JSON.parse(received[1].body), input)
})

await test('wrong status and owner are rejected without replaying a POST', async () => {
  for (const [status, value] of [[200, snapshot], [202, { ...snapshot, session_id: 'foreign' }]] as const) {
    let requests = 0
    await wire((_request, response) => { requests += 1; response.writeHead(status); response.end(JSON.stringify(value)) }, async client => {
      await assert.rejects(client.submitSyncedSideChat('chat-a', input), /side_question_invalid_response/)
    })
    assert.equal(requests, 1)
  }
})

await test('mutation acknowledgments prove the exact request and cleared conversation', async () => {
  for (const value of [snapshot, { ...accepted, side_chat_id: 'foreign-side' },
    { ...accepted, exchanges: [{ ...accepted.exchanges[0], request_id: 'foreign-request' }] },
    { ...accepted, exchanges: [{ ...accepted.exchanges[0], question: 'foreign-question' }] }]) {
    await wire((_request, response) => { response.writeHead(202); response.end(JSON.stringify(value)) }, async client => {
      await assert.rejects(client.submitSyncedSideChat('chat-a', input), /side_question_invalid_response/)
    })
  }
  await wire((_request, response) => response.end(JSON.stringify(accepted)), async client => {
    await assert.rejects(client.stopSyncedSideChat('chat-a', 'request-a'), /side_question_invalid_response/)
    await assert.rejects(client.clearSyncedSideChat('chat-a', 'side-a'), /side_question_invalid_response/)
  })
})

await test('side reads are bounded, redirects refused and native auth is exclusive', async () => {
  const client = new AgentServerClient('https://fixture.invalid', 'fixture-only-token')
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), { 'x-agentsdock-token': 'fixture-only-token' })
      return new Response('{}', { headers: { 'content-length': String(SIDE_CHAT_MAX_RESPONSE_BYTES + 1) } })
    }
    await assert.rejects(client.readSyncedSideChat('chat-a'), /side_question_invalid_response/)
    globalThis.fetch = async () => new Response(' '.repeat(SIDE_CHAT_MAX_RESPONSE_BYTES + 1))
    await assert.rejects(client.readSyncedSideChat('chat-a'), /side_question_invalid_response/)
    globalThis.fetch = async () => new Response('not json')
    await assert.rejects(client.readSyncedSideChat('chat-a'), /side_question_invalid_response/)
  } finally { client.dispose(); globalThis.fetch = originalFetch }
})

await test('validation and disposal fence side operations; no old response can escape', async () => {
  const client = new AgentServerClient('https://fixture.invalid', '', { requireValidation: true })
  try {
    await assert.rejects(client.readSyncedSideChat('chat-a'), AgentServerClientUnvalidatedError)
    client.markValidated()
    let finish!: (value: Response) => void
    globalThis.fetch = () => new Promise(resolve => { finish = resolve })
    const pending = client.readSyncedSideChat('chat-a')
    client.dispose()
    finish(new Response(JSON.stringify(snapshot)))
    await assert.rejects(pending, AgentServerClientDisposedError)
  } finally { client.dispose(); globalThis.fetch = originalFetch }
})

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number; reason: string }) => void
  onerror?: () => void
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
  packet(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

await test('side invalidations are instance/session-owned and never consume the durable cursor', () => {
  const originalSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  const client = new AgentServerClient('https://fixture.invalid', 'fixture-only-token')
  const other = new AgentServerClient('https://other.invalid', 'other-fixture')
  try {
    const updates: Array<[string, number]> = []
    const events: number[] = []
    const unsubscribe = client.subscribeSideChatChanges((session, revision) => updates.push([session, revision]))
    other.subscribeSideChatChanges(() => assert.fail('different client received side progress'))
    const stop = client.stream('chat-a', 1, event => events.push(event.seq), () => {})
    const socket = FakeWebSocket.instances.at(-1)!
    socket.packet({ type: 'side_chat_updated', session_id: 'chat-a', revision: 2, seq: 999 })
    socket.packet({ type: 'side_chat_updated', session_id: 'other-chat', revision: 3 })
    socket.packet({ type: 'side_chat_updated', session_id: 'chat-a', revision: -1 })
    socket.packet({ type: 'assistant_text', session_id: 'chat-a', seq: 2 })
    assert.deepEqual(updates, [['chat-a', 2]])
    assert.deepEqual(events, [2])
    unsubscribe()
    socket.packet({ type: 'side_chat_updated', session_id: 'chat-a', revision: 3 })
    assert.equal(updates.length, 1)
    stop()
    socket.packet({ type: 'side_chat_updated', session_id: 'chat-a', revision: 4 })
    assert.equal(updates.length, 1)
  } finally { client.dispose(); other.dispose(); globalThis.WebSocket = originalSocket }
})
