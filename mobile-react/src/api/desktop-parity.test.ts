import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentServerClient, AgentServerClientUnvalidatedError } from './AgentServerClient'

const originalFetch = globalThis.fetch
const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
const client = new AgentServerClient('https://synthetic.invalid/mounted', 'synthetic-token', { requireValidation: true })
try {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (String(url).includes('/api/local-sessions?')) return new Response(JSON.stringify({ sessions: [{ provider_session_id: 'provider-a', backend: 'codex', label: 'Saved chat', updated_at: '2026-09-14T00:00:00Z', cwd: '/synthetic/project' }] }), { status: 200 })
    if (String(url).endsWith('/api/sessions/bulk-import')) return new Response(JSON.stringify({ results: [{ provider_session_id: 'provider-a', backend: 'codex', session_id: 'imported-a', ok: true, imported: 12 }] }), { status: 200 })
    return new Response(JSON.stringify({ configurable: true, max_concurrent_threads_per_session: null, message: 'Default' }), { status: 200 })
  }
  await test('subagent administration requires validation and exact native credential header', async () => {
    await assert.rejects(client.codexServerSubagents(), AgentServerClientUnvalidatedError)
    assert.equal(calls.length, 0)
    client.markValidated()
    await client.codexServerSubagents()
    await client.setCodexServerSubagents(12)
    await client.setCodexServerSubagents(null)
    assert.deepEqual(calls.map(row => [row.method, row.url, row.body]), [
      ['GET', 'https://synthetic.invalid/mounted/api/admin/codex/subagents', null],
      ['PUT', 'https://synthetic.invalid/mounted/api/admin/codex/subagents', { max_concurrent_threads_per_session: 12 }],
      ['PUT', 'https://synthetic.invalid/mounted/api/admin/codex/subagents', { max_concurrent_threads_per_session: null }],
    ])
    for (const call of calls) {
      assert.equal(call.headers.get('X-AgentsDock-Token'), 'synthetic-token')
      assert.equal(call.headers.get('X-ZenithDock-Token'), null)
      assert.equal(call.headers.get('Authorization'), null)
    }
  })
  await test('invalid subagent limits are rejected before transport', () => {
    for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', undefined]) {
      assert.throws(() => client.setCodexServerSubagents(value as number), /positive whole number/)
    }
    assert.equal(calls.length, 3)
  })
  await test('Cursor resume never requests unsupported history import', async () => {
    await client.createSession({ title: 'Resume', backend: 'cursor', providerId: 'synthetic-provider-session' })
    assert.equal((calls.at(-1)!.body as Record<string, unknown>).import_history, false)
    await client.createSession({ title: 'Resume', backend: 'codex', providerId: 'synthetic-provider-session' })
    assert.equal((calls.at(-1)!.body as Record<string, unknown>).import_history, true)
  })
  await test('local provider browse and import use bounded exact mounted routes', async () => {
    const candidates = await client.listLocalSessions(20)
    assert.equal(candidates[0].provider_session_id, 'provider-a')
    const result = await client.bulkImportSessions([{ backend: 'codex', provider_session_id: 'provider-a', cwd: '/synthetic/project' }])
    assert.equal(result[0].session_id, 'imported-a')
    assert.deepEqual(calls.slice(-2).map(row => [row.method, row.url]), [
      ['GET', 'https://synthetic.invalid/mounted/api/local-sessions?limit=20'],
      ['POST', 'https://synthetic.invalid/mounted/api/sessions/bulk-import'],
    ])
    const count = calls.length
    await assert.rejects(client.listLocalSessions(501), /limit is invalid/)
    await assert.rejects(client.bulkImportSessions([]), /between 1 and 25/)
    await assert.rejects(client.bulkImportSessions([{ backend: 'cursor', provider_session_id: 'provider-a' }]), /backend is invalid/)
    await assert.rejects(client.bulkImportSessions([{ backend: 'codex', provider_session_id: 'other-provider' }]), /does not match/)
    assert.equal(calls.length, count + 1, 'invalid local requests make no network call')
  })
} finally { client.dispose(); globalThis.fetch = originalFetch }
