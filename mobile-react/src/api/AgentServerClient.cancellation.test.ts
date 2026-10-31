import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentServerClient, AgentServerClientDisposedError, ServerError } from './AgentServerClient'

const nativeCancellation = () => new Error('fetch failed: FetchRequestCanceledException: Fetch request has been canceled (at Expo/NativeResponse.swift:63)')
const originalFetch = globalThis.fetch

function untilAbort(signal: AbortSignal, error: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(error())
    else signal.addEventListener('abort', () => reject(error()), { once: true })
  })
}

async function withClient(run: (client: AgentServerClient) => Promise<void>) {
  const client = new AgentServerClient('https://sync.example')
  try { await run(client) }
  finally { client.dispose(); globalThis.fetch = originalFetch }
}

for (const [label, error] of [
  ['Expo cancellation', nativeCancellation],
  ['standard abort', () => new DOMException('The operation was aborted.', 'AbortError')],
] as const) {
  await test(`deadline normalizes ${label} without exposing native details`, () => withClient(async client => {
    globalThis.fetch = (_, init) => untilAbort(init!.signal!, error)
    await assert.rejects(client.health(10), { name: 'AgentServerRequestTimeoutError', message: 'The server request timed out. Please try again.' })
    assert.equal(client.isDisposed, false)
  }))
}

await test('caller cancellation retains its reason even when Expo discards it', () => withClient(async client => {
  globalThis.fetch = (_, init) => untilAbort(init!.signal!, nativeCancellation)
  const controller = new AbortController()
  const reason = new Error('superseded probe')
  const request = client.health(1000, controller.signal)
  controller.abort(reason)
  await assert.rejects(request, error => error === reason)
}))

await test('disposed requests cannot leak a native cancellation', () => withClient(async client => {
  globalThis.fetch = (_, init) => untilAbort(init!.signal!, nativeCancellation)
  const request = client.health()
  client.dispose()
  await assert.rejects(request, AgentServerClientDisposedError)
}))

await test('timeout covers a stalled response body, not only response headers', () => withClient(async client => {
  globalThis.fetch = async (_, init) => ({
    ok: true, status: 200,
    json: () => untilAbort(init!.signal!, nativeCancellation),
  }) as Response
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    await assert.rejects(Promise.race([
      client.health(10),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Body was not bounded')), 200) }),
    ]), { name: 'AgentServerRequestTimeoutError' })
  } finally { clearTimeout(guard) }
}))

await test('disposing during body download still rejects as a stale client', () => withClient(async client => {
  let bodyStarted!: () => void
  const started = new Promise<void>(resolve => { bodyStarted = resolve })
  globalThis.fetch = async (_, init) => ({ ok: true, status: 200, json: () => {
    bodyStarted()
    return untilAbort(init!.signal!, nativeCancellation)
  } }) as Response
  const request = client.health()
  await started
  client.dispose()
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    await assert.rejects(Promise.race([request, new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('Body scope detached too early')), 200)
    })]), AgentServerClientDisposedError)
  } finally { clearTimeout(guard) }
}))

await test('unexpected native cancellation is retryable interruption, not intentional cancellation', () => withClient(async client => {
  for (const message of [nativeCancellation().message, 'fetch failed: Fetch request has been canceled']) {
    globalThis.fetch = async () => { throw new Error(message) }
    await assert.rejects(client.health(), { name: 'AgentServerRequestInterruptedError', message: 'The connection was interrupted. Please try again.' })
  }
}))

await test('Expo native timeout is classified as a retryable timeout', () => withClient(async client => {
  globalThis.fetch = async () => { throw new Error('fetch failed: The request timed out.') }
  await assert.rejects(client.health(), {
    name: 'AgentServerRequestTimeoutError',
    message: 'The server request timed out. Please try again.',
  })
}))

await test('a native body reader that never settles after abort cannot strand the request', { timeout: 1000 }, () => withClient(async client => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response
  await assert.rejects(client.health(10), { name: 'AgentServerRequestTimeoutError' })
}))

await test('pre-canceled calls do no network work', () => withClient(async client => {
  globalThis.fetch = async () => { assert.fail('A canceled probe reached fetch') }
  const controller = new AbortController()
  const reason = new Error('probe no longer needed')
  controller.abort(reason)
  await assert.rejects(client.health(10, controller.signal), error => error === reason)
}))

await test('a stalled 401 body preserves the HTTP rejection and late completion has no side effects', async () => {
  let finishBody!: (value: unknown) => void
  let reports = 0
  const client = new AgentServerClient('https://sync.example', '', {
    requireValidation: true, onServerError: () => { reports += 1 },
  })
  client.markValidated()
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: () => new Promise(resolve => { finishBody = resolve }) }) as Response
    await assert.rejects(client.health(10), error => error instanceof ServerError && error.status === 401)
    assert.equal(client.isValidated, false)
    assert.equal(reports, 1)
    finishBody({ detail: 'late rejection' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(client.isValidated, false)
    assert.equal(reports, 1)
  } finally { client.dispose(); globalThis.fetch = originalFetch }
})

await test('normal completion clears its timer and keeps real server errors intact', () => withClient(async client => {
  let signal!: AbortSignal
  globalThis.fetch = async (_, init) => {
    signal = init!.signal!
    return new Response(JSON.stringify({ ok: true }))
  }
  assert.equal((await client.health(10)).ok, true)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(signal.aborted, false)
  for (const status of [401, 403, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'server rejection' }), { status })
    await assert.rejects(client.health(), error => error instanceof ServerError && error.status === status && error.message === 'server rejection')
  }
  const unknown = new Error('Unexpected application failure')
  globalThis.fetch = async () => { throw unknown }
  await assert.rejects(client.health(), error => error === unknown)
}))

await test('a failed mutation is never automatically replayed', () => withClient(async client => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw nativeCancellation() }
  await assert.rejects(client.markRead('chat', 1), { name: 'AgentServerRequestInterruptedError' })
  assert.equal(calls, 1)
}))
