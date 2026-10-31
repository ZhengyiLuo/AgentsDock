import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { AgentServerClient } from './server-client'
import { CODE_INTELLIGENCE_PROTOCOL } from '../shared/code-intelligence'

const credential = 'synthetic-code-intelligence-token'
const status = { root: '/remote/project space', root_uri: 'file:///remote/project%20space',
  languages: [{ id: 'python', available: true }, { id: 'typescript', available: false, install_hint: 'Install a language server.' }] }

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string, server: ReturnType<typeof createServer>) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, server) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Socket failed to open')), { once: true })
  })
}

describe('code intelligence native transport', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('sends status through native HTTP with exactly one token header and no browser metadata', async () => {
    const fetch = vi.fn(() => { throw new Error('Generic fetch cannot carry native authority') })
    vi.stubGlobal('fetch', fetch)
    const calls: IncomingMessage[] = []
    await withServer((request, response) => {
      calls.push(request)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(status))
    }, async url => {
      const client = new AgentServerClient(`${url}/mount`, credential)
      try { expect(await client.workspaceIntelligenceStatus('chat-a')).toEqual(status) }
      finally { client.dispose() }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('/mount/api/sessions/chat-a/workspace/intelligence')
    expect(calls[0].headers['x-agentsdock-token']).toBe(credential)
    for (const key of ['origin', 'cookie', 'sec-fetch-mode', 'authorization', 'x-zenithdock-token']) {
      expect(calls[0].headers[key]).toBeUndefined()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opens a native WebSocket, carries JSON text both ways, and closes on profile retirement', async () => {
    const builtin = vi.fn(() => { throw new Error('Built-in WebSocket adds Sec-Fetch-Mode') })
    vi.stubGlobal('WebSocket', builtin)
    const requests: IncomingMessage[] = []
    await withServer((_request, response) => response.writeHead(404).end(), async (url, server) => {
      const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => CODE_INTELLIGENCE_PROTOCOL })
      server.on('upgrade', (request, socket, head) => {
        requests.push(request)
        sockets.handleUpgrade(request, socket, head, peer => {
          peer.on('message', data => peer.send(data.toString()))
        })
      })
      const client = new AgentServerClient(`${url}/mount`, credential)
      try {
        const socket = client.workspaceIntelligenceSocket('chat-a', 'python')
        await opened(socket)
        expect(socket.protocol).toBe(CODE_INTELLIGENCE_PROTOCOL)
        const received = new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(event.data), { once: true }))
        const packet = JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: 'workspace/configuration', params: { items: [] } })
        socket.send(packet)
        expect(await received).toBe(packet)
        const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }))
        client.configure(url, 'new-disposable-token')
        await closed
      } finally {
        client.dispose()
        for (const socket of sockets.clients) socket.terminate()
        await new Promise<void>(resolve => sockets.close(() => resolve()))
      }
    })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request.url).toBe('/mount/api/sessions/chat-a/workspace/intelligence/python')
    expect(request.headers['sec-websocket-protocol']?.split(',')).toEqual([
      CODE_INTELLIGENCE_PROTOCOL, `agentsdock-token.${Buffer.from(credential).toString('base64url')}`
    ])
    for (const key of ['origin', 'cookie', 'sec-fetch-mode', 'authorization', 'x-agentsdock-token', 'x-zenithdock-token']) {
      expect(request.headers[key]).toBeUndefined()
    }
    expect(builtin).not.toHaveBeenCalled()
  })

  it('does not forward native credentials through HTTP or WebSocket redirects', async () => {
    let forwarded = 0
    await withServer((_request, response) => { forwarded++; response.end('{}') }, async destination => {
      await withServer((_request, response) => response.writeHead(307, { Location: destination }).end(), async url => {
        const client = new AgentServerClient(url, credential)
        try {
          await expect(client.workspaceIntelligenceStatus('chat-a')).rejects.toThrow()
          const socket = client.workspaceIntelligenceSocket('chat-a', 'python')
          await expect(opened(socket)).rejects.toThrow('Socket failed to open')
        } finally { client.dispose() }
      })
    })
    expect(forwarded).toBe(0)
  })

  it('fails a stalled intelligence handshake without disrupting other client requests', async () => {
    await withServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(status))
    }, async (url, server) => {
      // Accept TCP and the Upgrade request, but never send an HTTP handshake.
      // This runs the real native timeout rather than changing production limits.
      const stalledSockets = new Set<import('node:stream').Duplex>()
      server.on('upgrade', (_request, socket) => { stalledSockets.add(socket) })
      const client = new AgentServerClient(url, credential)
      try {
        const socket = client.workspaceIntelligenceSocket('chat-a', 'python')
        const failure = opened(socket)
        const observed = expect(failure).rejects.toThrow('Socket failed to open')
        expect(await client.workspaceIntelligenceStatus('chat-b')).toEqual(status)
        await observed
        expect(await client.workspaceIntelligenceStatus('chat-b')).toEqual(status)
      } finally {
        client.dispose()
        for (const socket of stalledSockets) socket.destroy()
      }
    })
  }, 20_000)

  it('rejects client-selected commands and unsafe chat identifiers before opening transports', () => {
    const client = new AgentServerClient('http://127.0.0.1:1', credential)
    expect(() => client.workspaceIntelligenceSocket('chat-a', '/bin/sh' as never)).toThrow('Unsupported code language')
    expect(() => client.workspaceIntelligenceSocket('../chat', 'python')).toThrow()
    client.dispose()
  })
})
