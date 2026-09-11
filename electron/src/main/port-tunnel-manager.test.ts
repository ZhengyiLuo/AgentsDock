import { createConnection, createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForwardedPort } from '../shared/types'
import {
  PORT_TUNNEL_LOOPBACK_HOST,
  PORT_TUNNEL_MAX_BRIDGES_GLOBAL,
  PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL,
  PORT_TUNNEL_MAX_LISTENERS_GLOBAL,
  PORT_TUNNEL_MAX_LISTENERS_PER_SESSION,
  PORT_TUNNEL_SUBPROTOCOL,
  PortTunnelManager
} from './port-tunnel-manager'

type FakeEvent = { data?: unknown; code?: number; reason?: string }

class FakeWebSocket {
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>()
  readonly sent: ArrayBuffer[] = []
  binaryType = ''
  bufferedAmount = 0
  readyState = 0
  protocol = PORT_TUNNEL_SUBPROTOCOL

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string' || data instanceof Blob) throw new Error('test tunnel expected binary bytes')
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    this.sent.push(Uint8Array.from(view).buffer)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState > 1) return
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(data: unknown): void {
    this.emit('message', { data })
  }

  private emit(name: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
}

const managers: PortTunnelManager[] = []
const sockets: Socket[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll()
  for (const socket of sockets.splice(0)) socket.destroy()
  vi.restoreAllMocks()
})

describe('PortTunnelManager', () => {
  it('binds an ephemeral listener only on IPv4 loopback and bridges exact binary bytes', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const remoteSockets: FakeWebSocket[] = []
    const forwarded = await manager.start('chat /?', 7007, undefined, () => {
      const socket = new FakeWebSocket()
      remoteSockets.push(socket)
      return socket as unknown as WebSocket
    })

    expect(forwarded).toMatchObject({
      sessionId: 'chat /?',
      remotePort: 7007,
      state: 'open',
      error: null,
      localUrl: `http://${PORT_TUNNEL_LOOPBACK_HOST}:${forwarded.localPort}`
    })
    expect(forwarded.localPort).toBeGreaterThanOrEqual(1024)

    const local = createConnection({ host: PORT_TUNNEL_LOOPBACK_HOST, port: forwarded.localPort })
    sockets.push(local)
    await onceEvent(local, 'connect')
    await eventually(() => remoteSockets.length === 1)
    expect(remoteSockets).toHaveLength(1)
    const remote = remoteSockets[0]

    local.write(Buffer.from([0, 1, 2, 255]))
    remote.open()
    await eventually(() => remote.sent.length === 1)
    expect([...new Uint8Array(remote.sent[0])]).toEqual([0, 1, 2, 255])

    const received = onceData(local)
    remote.message(Uint8Array.from([9, 8, 0, 7]).buffer)
    expect([...(await received)]).toEqual([9, 8, 0, 7])
  })

  it('uses an exact preferred port and keeps duplicate starts idempotent', async () => {
    const preferredPort = await reserveLoopbackPort()

    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = () => new FakeWebSocket() as unknown as WebSocket
    const first = await manager.start('chat-a', 8080, preferredPort, createRemote)
    const second = await manager.start('chat-b', 8080, preferredPort, () => new FakeWebSocket() as unknown as WebSocket)

    expect(first.localPort).toBe(preferredPort)
    expect(second).toEqual(first)
    expect(second.sessionId).toBe('chat-a')
    await expect(manager.start('chat-b', 8080, preferredPort + 1, createRemote))
      .rejects.toThrow(`already forwarded on local port ${preferredPort}`)
  })

  it('publishes full profile-wide snapshots after listener lifecycle changes', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const snapshots: ForwardedPort[][] = []
    manager.setChangeListener(ports => snapshots.push(ports))

    await manager.start('chat-a', 7007, undefined, () => new FakeWebSocket() as unknown as WebSocket)
    await manager.start('chat-b', 8080, undefined, () => new FakeWebSocket() as unknown as WebSocket)

    expect(snapshots).toContainEqual([
      expect.objectContaining({ sessionId: 'chat-a', remotePort: 7007, state: 'starting' })
    ])
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({ sessionId: 'chat-a', remotePort: 7007, state: 'open' }),
      expect.objectContaining({ sessionId: 'chat-b', remotePort: 8080, state: 'open' })
    ])

    manager.disposeSession('chat-a')
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({ sessionId: 'chat-b', remotePort: 8080 })
    ])

    await manager.stop(8080)
    expect(snapshots.at(-1)).toEqual([])

    await manager.start('chat-c', 9090, undefined, () => new FakeWebSocket() as unknown as WebSocket)
    manager.disposeAll()
    expect(snapshots.at(-1)).toEqual([])
  })

  it('rejects privileged or malformed ports before opening a listener', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = vi.fn(() => new FakeWebSocket() as unknown as WebSocket)

    await expect(manager.start('chat-a', 80, undefined, createRemote)).rejects.toThrow('1024 through 65535')
    await expect(manager.start('chat-a', 7007, 443, createRemote)).rejects.toThrow('1024 through 65535')
    await expect(manager.start('chat-a', Number.NaN, undefined, createRemote)).rejects.toThrow('1024 through 65535')
    expect(manager.list()).toEqual([])
    expect(createRemote).not.toHaveBeenCalled()
  })

  it('hard-caps forwarded listeners globally and per chat', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = vi.fn(() => new FakeWebSocket() as unknown as WebSocket)

    for (let index = 0; index < PORT_TUNNEL_MAX_LISTENERS_PER_SESSION; index += 1) {
      await manager.start('chat-a', 10_000 + index, undefined, createRemote)
    }
    await expect(manager.start('chat-a', 20_000, undefined, createRemote))
      .rejects.toThrow(`At most ${PORT_TUNNEL_MAX_LISTENERS_PER_SESSION} ports can be forwarded for one chat.`)

    for (let index = PORT_TUNNEL_MAX_LISTENERS_PER_SESSION; index < PORT_TUNNEL_MAX_LISTENERS_GLOBAL; index += 1) {
      const sessionIndex = Math.floor(index / PORT_TUNNEL_MAX_LISTENERS_PER_SESSION)
      await manager.start(`chat-${sessionIndex}`, 10_000 + index, undefined, createRemote)
    }
    await expect(manager.start('chat-overflow', 30_000, undefined, createRemote))
      .rejects.toThrow(`At most ${PORT_TUNNEL_MAX_LISTENERS_GLOBAL} port forwards can be active at once.`)

    expect(manager.list()).toHaveLength(PORT_TUNNEL_MAX_LISTENERS_GLOBAL)
    expect(createRemote).not.toHaveBeenCalled()
  })

  it('destroys connections above the per-tunnel bridge cap before allocating a WebSocket', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = vi.fn(() => new FakeWebSocket() as unknown as WebSocket)
    const forwarded = await manager.start('chat-a', 7007, undefined, createRemote)

    await openLocalConnections(forwarded.localPort, PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL)
    await eventually(() => createRemote.mock.calls.length === PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL)

    const excess = await openLocalConnection(forwarded.localPort)
    await onceClosed(excess)
    expect(createRemote).toHaveBeenCalledTimes(PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL)
  })

  it('enforces the advertised bridge cap across every tunnel owned by one chat', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = vi.fn(() => new FakeWebSocket() as unknown as WebSocket)
    const first = await manager.start('chat-a', 7007, undefined, createRemote, 3)
    const second = await manager.start('chat-a', 7008, undefined, createRemote, 3)
    const otherChat = await manager.start('chat-b', 7009, undefined, createRemote, 3)

    await openLocalConnections(first.localPort, 2)
    await openLocalConnections(second.localPort, 1)
    await eventually(() => createRemote.mock.calls.length === 3)

    const excess = await openLocalConnection(second.localPort)
    await onceClosed(excess)
    expect(createRemote).toHaveBeenCalledTimes(3)

    await openLocalConnection(otherChat.localPort)
    await eventually(() => createRemote.mock.calls.length === 4)
  })

  it('destroys connections above the global bridge cap before allocating a WebSocket', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const createRemote = vi.fn(() => new FakeWebSocket() as unknown as WebSocket)
    const tunnelCount = Math.ceil(PORT_TUNNEL_MAX_BRIDGES_GLOBAL / PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL) + 1
    const forwards = await Promise.all(Array.from({ length: tunnelCount }, (_, index) => (
      manager.start(`chat-${index}`, 7_000 + index, undefined, createRemote)
    )))

    let remaining = PORT_TUNNEL_MAX_BRIDGES_GLOBAL
    for (const forwarded of forwards.slice(0, -1)) {
      const count = Math.min(PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL, remaining)
      await openLocalConnections(forwarded.localPort, count)
      remaining -= count
      if (remaining === 0) break
    }
    await eventually(() => createRemote.mock.calls.length === PORT_TUNNEL_MAX_BRIDGES_GLOBAL)

    const excess = await openLocalConnection(forwards.at(-1)!.localPort)
    await onceClosed(excess)
    expect(createRemote).toHaveBeenCalledTimes(PORT_TUNNEL_MAX_BRIDGES_GLOBAL)
  })

  it('rejects a remote WebSocket that does not accept the tunnel subprotocol', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const snapshots: ForwardedPort[][] = []
    manager.setChangeListener(ports => snapshots.push(ports))
    const remoteSockets: FakeWebSocket[] = []
    const forwarded = await manager.start('chat-a', 7007, undefined, () => {
      const remote = new FakeWebSocket()
      remote.protocol = ''
      remoteSockets.push(remote)
      return remote as unknown as WebSocket
    })
    const local = createConnection({ host: PORT_TUNNEL_LOOPBACK_HOST, port: forwarded.localPort })
    sockets.push(local)
    await onceEvent(local, 'connect')
    await eventually(() => remoteSockets.length === 1)

    remoteSockets[0].open()
    await eventually(() => manager.list()[0]?.state === 'error')
    expect(manager.list()[0]).toMatchObject({
      state: 'error',
      error: 'AgentsServer did not accept the authenticated port tunnel protocol.'
    })
    expect(snapshots.at(-1)?.[0]).toMatchObject({
      state: 'error',
      error: 'AgentsServer did not accept the authenticated port tunnel protocol.'
    })
  })

  it('stops listeners and active bridges without retaining stale forwards', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const remote = new FakeWebSocket()
    const forwarded = await manager.start('chat-a', 7007, undefined, () => remote as unknown as WebSocket)
    const local = createConnection({ host: PORT_TUNNEL_LOOPBACK_HOST, port: forwarded.localPort })
    sockets.push(local)
    await onceEvent(local, 'connect')
    await eventually(() => remote.listeners.has('open'))
    remote.open()

    await manager.stop(7007)

    expect(manager.list()).toEqual([])
    expect(remote.readyState).toBe(3)
    await expect(connectOutcome(forwarded.localPort)).resolves.toBe('refused')
  })

  it.each([4401, 4404, 4409])('disposes the entire forward after fatal remote close code %i', async code => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const snapshots: ForwardedPort[][] = []
    manager.setChangeListener(ports => snapshots.push(ports))
    const remoteSockets: FakeWebSocket[] = []
    const forwarded = await manager.start('chat-a', 7007, undefined, () => {
      const remote = new FakeWebSocket()
      remoteSockets.push(remote)
      return remote as unknown as WebSocket
    })
    await openLocalConnections(forwarded.localPort, 2)
    await eventually(() => remoteSockets.length === 2)
    for (const remote of remoteSockets) remote.open()

    remoteSockets[0].close(code)

    await eventually(() => manager.list().length === 0)
    expect(snapshots.at(-1)).toEqual([])
    expect(remoteSockets[1].readyState).toBe(3)
    expect(() => manager.url(7007)).toThrow('is not forwarded for this server profile')
    await expect(connectOutcome(forwarded.localPort)).resolves.toBe('refused')
  })

  it('invalidates only the archived chat while preserving other chat forwards', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    await manager.start('chat-a', 7007, undefined, () => new FakeWebSocket() as unknown as WebSocket)
    await manager.start('chat-b', 8080, undefined, () => new FakeWebSocket() as unknown as WebSocket)

    manager.disposeSession('chat-a')

    expect(manager.list()).toEqual([expect.objectContaining({ sessionId: 'chat-b', remotePort: 8080 })])
  })

  it('invalidates a post-start failure only when the exact transport factory still owns the tunnel', async () => {
    const manager = new PortTunnelManager()
    managers.push(manager)
    const oldOwner = () => new FakeWebSocket() as unknown as WebSocket
    const otherOwner = () => new FakeWebSocket() as unknown as WebSocket
    await manager.start('chat-a', 7007, undefined, oldOwner)

    expect(manager.disposeIfOwned('chat-a', 7007, otherOwner)).toBe(false)
    expect(manager.disposeIfOwned('chat-b', 7007, oldOwner)).toBe(false)
    expect(manager.list()).toHaveLength(1)
    expect(manager.disposeIfOwned('chat-a', 7007, oldOwner)).toBe(true)
    expect(manager.list()).toEqual([])

    await manager.start('chat-a', 7007, undefined, otherOwner)
    expect(manager.disposeIfOwned('chat-a', 7007, oldOwner)).toBe(false)
    expect(manager.list()).toEqual([
      expect.objectContaining({ sessionId: 'chat-a', remotePort: 7007 })
    ])
  })
})

function onceEvent(socket: Socket, name: 'connect'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(name, resolve)
    socket.once('error', reject)
  })
}

function onceData(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', data => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data)))
    socket.once('error', reject)
  })
}

async function openLocalConnection(port: number): Promise<Socket> {
  const socket = createConnection({ host: PORT_TUNNEL_LOOPBACK_HOST, port })
  sockets.push(socket)
  await onceEvent(socket, 'connect')
  return socket
}

async function openLocalConnections(port: number, count: number): Promise<Socket[]> {
  return Promise.all(Array.from({ length: count }, () => openLocalConnection(port)))
}

function onceClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise(resolve => socket.once('close', resolve))
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, PORT_TUNNEL_LOOPBACK_HOST, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not bind')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function connectOutcome(port: number): Promise<'connected' | 'refused'> {
  return new Promise(resolve => {
    const socket = createConnection({ host: PORT_TUNNEL_LOOPBACK_HOST, port })
    sockets.push(socket)
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', () => resolve('refused'))
  })
}
