import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'
import { TeamHubClient } from './team-hub-client'

const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'

async function withLocalHTTPServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('secure Teamspace proxy authentication realms', () => {
  it('sends endpoint migration only as a native PUT to the member control origin', async () => {
    let received: IncomingMessage | undefined
    let body = ''
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    const input = { request_id: connectionId, expected_server_identity: 'member',
      expected_server_instance_id: 'instance', expected_host_server_identity: 'host', expected_hub_id: 'hub',
      expected_host_ip: '100.64.0.1', expected_port: 7851, host_ip: '100.64.0.2', port: 7852, confirmed: true }
    await withLocalHTTPServer((request, response) => {
      received = request
      request.on('data', chunk => { body += chunk.toString() })
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json')
        response.end('{"version":2}')
      })
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'member-control-secret')
      await expect(client.updateSecurePeerConnectionEndpoint(connectionId, input)).resolves.toEqual({ version: 2 })
      await expect(client.updateSecurePeerConnectionEndpoint('../escape', input)).rejects.toThrow()
      client.dispose()
    })
    expect(received?.method).toBe('PUT')
    expect(received?.url).toBe(`/api/admin/secure-peers/v1/connections/${connectionId}/endpoint`)
    expect(received?.headers['x-agentsdock-token']).toBe('member-control-secret')
    expect(received?.headers.authorization).toBeUndefined()
    expect(JSON.parse(body)).toEqual(input)
    expect(browserFetch).not.toHaveBeenCalled()
  })
  it('admits a warm five-read burst across proxy closures only four at a time through full bodies', async () => {
    const responses: ServerResponse[] = []
    let notify: (() => void) | undefined
    const arrived = (count: number) => responses.length >= count ? Promise.resolve() : new Promise<void>(resolve => { notify = resolve })
    await withLocalHTTPServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      responses.push(response)
      notify?.()
      notify = undefined
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'control')
      const path = `/api/team-hub-secure/${connectionId}`
      const one = client.secureTeamHubProxyFetch(path)
      const two = client.secureTeamHubProxyFetch(path)
      const results = Array.from({ length: 5 }, (_, index) => (index % 2 ? one : two)(`${baseURL}${path}/v1/teams?read=${index}`))
      // Each callback wakes the next bounded arrival; no polling or timers.
      while (responses.length < 4) await arrived(4)
      expect(responses).toHaveLength(4)
      responses[0].write('{"ok":')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(responses).toHaveLength(4)
      responses[0].end('true}')
      while (responses.length < 5) await arrived(5)
      responses.slice(1).forEach(response => response.end('{"ok":true}'))
      const values = await Promise.all(results)
      expect(await Promise.all(values.map(value => value.json()))).toEqual(Array(5).fill({ ok: true }))
      client.dispose()
    })
    expect(responses).toHaveLength(5)
  })

  it('cancels queued old-configuration work without sending it and admits a fresh configured request', async () => {
    const requests: IncomingMessage[] = []
    let notify: (() => void) | undefined
    await withLocalHTTPServer((request, response) => {
      requests.push(request)
      if (request.url?.includes('fresh')) {
        response.setHeader('Content-Type', 'application/json')
        response.end('{"ok":true}')
      }
      notify?.()
      notify = undefined
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'old-control')
      const path = `/api/team-hub-secure/${connectionId}`
      const proxy = client.secureTeamHubProxyFetch(path)
      const results = Promise.allSettled(Array.from({ length: 5 }, (_, index) => proxy(`${baseURL}${path}/v1/teams?old=${index}`)))
      while (requests.length < 4) await new Promise<void>(resolve => { notify = resolve })
      client.configure(baseURL, 'new-control')
      expect((await results).every(result => result.status === 'rejected')).toBe(true)
      expect(requests).toHaveLength(4)
      await expect(proxy(`${baseURL}${path}/v1/teams?stale=1`)).rejects.toThrow(/profile changed/)
      const fresh = client.secureTeamHubProxyFetch(path)
      await expect(fresh(`${baseURL}${path}/v1/teams?fresh=1`)).resolves.toBeInstanceOf(Response)
      expect(requests).toHaveLength(5)
      expect(requests[4].headers['x-agentsdock-token']).toBe('new-control')
      client.dispose()
    })
  })

  it('uses one bounded native completion GET with exact identity query and no browser transport', async () => {
    let received: IncomingMessage | undefined
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    await withLocalHTTPServer((request, response) => {
      received = request
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ version: 1, completion_state: 'expired' }))
    }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'local-control-secret')
      const controller = new AbortController()
      await expect(client.securePeerPairingCompletion(connectionId, {
        expected_server_identity: 'server-local', expected_server_instance_id: 'instance-local', expected_transcript_hash: 'c'.repeat(64)
      }, controller.signal)).resolves.toMatchObject({ completion_state: 'expired' })
      client.dispose()
    })
    const url = new URL(received!.url!, 'http://127.0.0.1')
    expect(url.pathname).toBe(`/api/admin/secure-peers/v1/pairings/${connectionId}/completion`)
    expect([...url.searchParams.keys()]).toEqual(['expected_server_identity', 'expected_server_instance_id', 'expected_transcript_hash'])
    expect(received?.method).toBe('GET')
    expect(received?.headers['x-agentsdock-token']).toBe('local-control-secret')
    expect(received?.headers.authorization).toBeUndefined()
    expect(timeout).toHaveBeenCalledWith(610_000)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('aborts the exact pending native completion request without a second request', async () => {
    let admit!: () => void
    const admitted = new Promise<void>(resolve => { admit = resolve })
    let requests = 0
    await withLocalHTTPServer(() => { requests += 1; admit() }, async baseURL => {
      const client = new AgentServerClient(baseURL, 'local-control-secret')
      const controller = new AbortController()
      const result = client.securePeerPairingCompletion(connectionId, {
        expected_server_identity: 'server-local', expected_server_instance_id: 'instance-local', expected_transcript_hash: 'c'.repeat(64)
      }, controller.signal)
      const rejected = expect(result).rejects.toThrow()
      await admitted
      controller.abort()
      await rejected
      client.dispose()
    })
    expect(requests).toBe(1)
  })

  it('refuses redirects on every secure-peer control request before the token can follow them', async () => {
    const requests: IncomingMessage[] = []
    await withLocalHTTPServer((request, response) => {
      requests.push(request)
      response.statusCode = 307
      response.setHeader('Location', '/collect-control-token')
      response.end()
    }, async baseURL => {
      const server = new AgentServerClient(baseURL, 'local-control-secret')
      await expect(server.securePeerStatus()).rejects.toThrow(/307/)
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/admin/secure-peers/v1/status')
    expect(requests[0].headers['x-agentsdock-token']).toBe('local-control-secret')
  })

  it('adds the control token only on the exact proxy and strips every Hub Authorization bearer', async () => {
    let received: IncomingMessage | undefined
    await withLocalHTTPServer((request, response) => {
      received = request
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ teams: [] }))
    }, async baseURL => {
      const proxyBase = `${baseURL}/api/team-hub-secure/${connectionId}`
      const server = new AgentServerClient(baseURL, 'local-control-secret')
      const client = new TeamHubClient(proxyBase, {
        fetch: server.secureTeamHubProxyFetch(`/api/team-hub-secure/${connectionId}`)
      })

      await expect(client.teams('must-not-leave-desktop')).resolves.toEqual({ teams: [] })
    })
    expect(received?.url).toBe(`/api/team-hub-secure/${connectionId}/v1/teams`)
    expect(received?.headers['x-agentsdock-token']).toBe('local-control-secret')
    expect(received?.headers.authorization).toBeUndefined()
    expect(JSON.stringify(received?.headers)).not.toContain('must-not-leave-desktop')
  })

  it('refuses an origin or path escape before exposing the control token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const server = new AgentServerClient('http://127.0.0.1:7850', 'local-control-secret')
    const proxyFetch = server.secureTeamHubProxyFetch(`/api/team-hub-secure/${connectionId}`)

    await expect(proxyFetch('https://attacker.invalid/v1/teams')).rejects.toThrow(/escaped/i)
    await expect(proxyFetch('http://127.0.0.1:7850/api/team-hub/v1/teams')).rejects.toThrow(/escaped/i)
    await expect(proxyFetch(`http://127.0.0.1:7850/api/team-hub-secure/${connectionId}`)).rejects.toThrow(/escaped/i)
    await expect(proxyFetch(`http://127.0.0.1:7850/api/team-hub-secure/${connectionId}/not-v1`)).rejects.toThrow(/escaped/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses mTLS peer-session semantics without any remote Hub credential', async () => {
    const payload = {
      session: { id: 'peer-session', device_label: 'Paired server', expires_at: '2027-01-01T00:00:00Z' },
      principal: { id: 'node-principal', kind: 'node', display_name: 'Studio server', email: null },
      teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
    }
    let received: IncomingMessage | undefined
    await withLocalHTTPServer((request, response) => {
      received = request
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(payload))
    }, async baseURL => {
      const proxyBase = `${baseURL}/api/team-hub-secure/${connectionId}`
      const server = new AgentServerClient(baseURL, 'local-control-secret')
      const client = new TeamHubClient(proxyBase, {
        fetch: server.secureTeamHubProxyFetch(`/api/team-hub-secure/${connectionId}`)
      })

      await expect(client.peerSession()).resolves.toMatchObject({ principal: { kind: 'node' } })
    })
    expect(received?.headers.authorization).toBeUndefined()
    expect(received?.headers['x-agentsdock-token']).toBe('local-control-secret')
  })

  it('does not add the control token to ordinary Hub or Tailscale requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ teams: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    const client = new TeamHubClient('https://studio.example.ts.net:8444/api/team-hub', { fetch: fetchMock as typeof fetch })

    await client.teams('ordinary-hub-bearer')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer ordinary-hub-bearer')
    expect(headers.get('X-AgentsDock-Token')).toBeNull()
  })
})
