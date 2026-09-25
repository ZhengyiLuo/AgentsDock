import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AgentServerClient } from './server-client'

const snapshot = { root: '/work/demo', branch: 'main', head: 'abc', revision: 'rev-1', operation: null, files: [], staged_count: 0, conflict_count: 0 }
async function transport(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  run: (client: AgentServerClient) => Promise<void>) {
  const server = createServer((req, res) => { void Promise.resolve(handle(req, res)).catch(error => { res.writeHead(500); res.end(String(error)) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new AgentServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix`, 'synthetic-owner')
  try { await run(client) } finally {
    client.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage) {
  const parts = []; for await (const part of req) parts.push(Buffer.from(part))
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

describe('workspace Git native transport', () => {
  it('preserves native authorization, prefix, literal filenames and reviewed revision through all operations', async () => {
    const calls: string[] = []
    await transport(async (req, res) => {
      expect(req.headers['x-agentsdock-token']).toBe('synthetic-owner')
      expect(Object.keys(req.headers).filter(key => key === 'origin' || key === 'cookie' || key.startsWith('sec-fetch-'))).toEqual([])
      const url = new URL(req.url!, 'http://localhost')
      calls.push(`${req.method} ${url.pathname}`)
      expect(url.pathname.startsWith('/prefix/api/sessions/chat-1/workspace/git')).toBe(true)
      if (url.pathname.endsWith('/diff')) {
        expect(url.searchParams.get('path')).toBe('src/my file #1.ts')
        expect(url.searchParams.get('view')).toBe('staged')
        return json(res, { path: 'src/my file #1.ts', view: 'staged', diff: '+new', binary: false, truncated: false, revision: 'rev-1' })
      }
      if (url.pathname.endsWith('/conflict')) return json(res, { path: 'src/conflict.ts', base: 'base', ours: 'ours', theirs: 'theirs', result: 'merged', binary: false, revision: 'rev-1' })
      if (req.method === 'POST') expect(await body(req)).toEqual({ action: 'stage', paths: ['src/my file #1.ts'], expected_revision: 'rev-1' })
      json(res, snapshot)
    }, async client => {
      await expect(client.workspaceGitStatus('chat-1')).resolves.toEqual(snapshot)
      await client.workspaceGitDiff('chat-1', 'src/my file #1.ts', 'staged')
      await client.workspaceGitConflict('chat-1', 'src/conflict.ts')
      await client.workspaceGitAction('chat-1', { action: 'stage', paths: ['src/my file #1.ts'], expected_revision: 'rev-1' })
    })
    expect(calls).toHaveLength(4)
  })

  it('rejects malformed sessions, traversal and unconfirmed abort before sending credentials', async () => {
    let calls = 0
    await transport((_req, res) => { calls++; json(res, snapshot) }, async client => {
      await expect(client.workspaceGitStatus('../admin')).rejects.toThrow('Invalid workspace')
      for (const path of ['../outside', '/etc/passwd', '.git/config', 'a/../file']) {
        await expect(client.workspaceGitDiff('chat-1', path, 'unstaged')).rejects.toThrow('Invalid repository')
      }
      await expect(client.workspaceGitAction('chat-1', { action: 'abort', expected_revision: 'rev-1' })).rejects.toThrow('Confirm')
      await expect(client.workspaceGitAction('chat-1', { action: 'commit', expected_revision: 'rev-1', message: ' ' })).rejects.toThrow('commit message')
    })
    expect(calls).toBe(0)
  })

  it('sends text resolutions larger than the unrelated 64 KiB control-message bound', async () => {
    const content = 'resolved line\n'.repeat(7000)
    await transport(async (req, res) => {
      expect((await body(req)).content).toBe(content)
      json(res, snapshot)
    }, async client => {
      await client.workspaceGitAction('chat-1', { action: 'resolve', path: 'large.ts', content, expected_revision: 'rev-1' })
    })
  })

  it('reports stale state without retrying or silently changing the reviewed revision', async () => {
    let calls = 0
    await transport(async (req, res) => {
      calls++; expect((await body(req)).expected_revision).toBe('old-revision')
      json(res, { detail: 'Repository changed. Refresh Changes before retrying.' }, 409)
    }, async client => {
      await expect(client.workspaceGitAction('chat-1', { action: 'commit', message: 'Reviewed change', expected_revision: 'old-revision' })).rejects.toMatchObject({ status: 409 })
    })
    expect(calls).toBe(1)
  })

  it('rejects redirects without forwarding the owner credential', async () => {
    let calls = 0
    await transport((_req, res) => {
      calls++; res.writeHead(302, { Location: '/elsewhere' }); res.end()
    }, async client => { await expect(client.workspaceGitStatus('chat-1')).rejects.toThrow() })
    expect(calls).toBe(1)
  })

  it('rejects a diff belonging to another file', async () => {
    await transport((_req, res) => json(res, { path: 'other', view: 'unstaged', diff: 'wrong', binary: false, truncated: false, revision: 'rev' }), async client => {
      await expect(client.workspaceGitDiff('chat-1', 'selected', 'unstaged')).rejects.toThrow('Invalid Git diff')
    })
  })

  it('aborts an in-flight observation when its server configuration is replaced', async () => {
    let arrived!: () => void
    const requestArrived = new Promise<void>(resolve => { arrived = resolve })
    await transport(() => { arrived() }, async client => {
      const pending = client.workspaceGitStatus('chat-1')
      const rejected = expect(pending).rejects.toThrow()
      await requestArrived
      client.dispose()
      await rejected
    })
  })
})
