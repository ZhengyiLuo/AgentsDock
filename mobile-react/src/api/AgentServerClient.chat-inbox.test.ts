import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentServerClient, ServerError } from './AgentServerClient'

// Shipping transport/decoder with mocked fetch; not native/server acceptance.
const originalFetch = globalThis.fetch
const client = new AgentServerClient('https://inbox.example.invalid', 'test-only-token')
const page = (sessionId = 'recipient') => ({ session_id: sessionId, messages: [], senders: [], next_cursor: null, has_more: false })
try {
  await test('inbox disclosure performs one bounded authenticated GET and never marks provider mail read', async () => {
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/sessions/chat%20%2F%3F%26%23/inbox')
      assert.equal(url.search, '?limit=25&cursor=123')
      assert.equal(init?.method ?? 'GET', 'GET')
      assert.equal(init?.body, undefined)
      assert.equal(new Headers(init?.headers).get('X-ZenithDock-Token'), 'test-only-token')
      return new Response(JSON.stringify(page('chat /?&#')), { status: 200 })
    }
    assert.deepEqual(await client.chatInbox('chat /?&#', '123'), page('chat /?&#'))
    assert.equal(calls, 1)
  })
  await test('invalid pagination fails locally without network traffic', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls += 1; return new Response('{}') }
    for (const limit of [-1, 0, 26, 1.5, Number.NaN]) await assert.rejects(client.chatInbox('recipient', null, limit))
    for (const cursor of ['', '-1', '1.5', 'other&limit=999']) await assert.rejects(client.chatInbox('recipient', cursor))
    assert.equal(calls, 0)
  })
  await test('wrong-session pages and authorization errors remain retryable errors without fallback writes', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(page('other')), { status: 200 }) }
    await assert.rejects(client.chatInbox('recipient'), /Invalid chat inbox response/)
    globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ detail: 'Denied' }), { status: 403 }) }
    await assert.rejects(client.chatInbox('recipient'), error => error instanceof ServerError && error.status === 403)
    assert.equal(calls, 2)
  })
  await test('explicit deletion addresses one message and accepts only its exact deletion receipt', async () => {
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      assert.equal(new URL(String(input)).pathname, '/api/sessions/chat%20%2F/inbox/message%20%2F')
      assert.equal(init?.method, 'DELETE')
      return new Response(JSON.stringify({ ok: true, session_id: 'chat /', message_id: 'message /', state: 'deleted' }), { status: 200 })
    }
    assert.equal((await client.deleteChatInboxMessage('chat /', 'message /')).state, 'deleted')
    assert.equal(calls, 1)
    for (const patch of [{ ok: false }, { session_id: 'other' }, { message_id: 'other' }, { state: 'read' }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, session_id: 'recipient', message_id: 'message', state: 'deleted', ...patch }), { status: 200 })
      await assert.rejects(client.deleteChatInboxMessage('recipient', 'message'), /Invalid chat inbox deletion receipt/)
    }
  })
  await test('switching the authenticated client scope cancels a stale inbox read without replay', async () => {
    const scoped = new AgentServerClient('https://old.example.invalid', 'old-test-token')
    let finish: ((value: Response) => void) | undefined
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Promise<Response>(resolve => { finish = resolve })
    }
    const pending = scoped.chatInbox('recipient')
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
    scoped.configure('https://new.example.invalid', 'new-test-token')
    await rejected
    finish?.(new Response(JSON.stringify(page()), { status: 200 }))
    assert.equal(calls, 1)
    scoped.dispose()
  })
} finally {
  globalThis.fetch = originalFetch
  client.dispose()
}
