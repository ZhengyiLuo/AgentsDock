import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { ForwardedPort } from '../shared/types'

export const PORT_TUNNEL_SUBPROTOCOL = 'agentsdock-port-tunnel-v1'
export const PORT_TUNNEL_LOOPBACK_HOST = '127.0.0.1'
export const PORT_TUNNEL_MAX_LISTENERS_GLOBAL = 64
export const PORT_TUNNEL_MAX_LISTENERS_PER_SESSION = 16
export const PORT_TUNNEL_MAX_BRIDGES_GLOBAL = 64
export const PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL = 16

const MAX_PENDING_BYTES = 4 * 1024 * 1024
const WEBSOCKET_HIGH_WATER_BYTES = 1024 * 1024
const WEBSOCKET_LOW_WATER_BYTES = 256 * 1024
const BACKPRESSURE_POLL_MS = 10
const REMOTE_CONNECT_TIMEOUT_MS = 10_000

interface TunnelBridge {
  close(): void
}

type PortTunnelChangeListener = (ports: ForwardedPort[]) => void

interface ManagedTunnel {
  readonly key: number
  readonly sessionId: string
  readonly remotePort: number
  readonly preferredLocalPort: number | undefined
  readonly server: Server
  readonly createRemoteSocket: () => WebSocket
  readonly maxBridgesPerSession: number
  readonly bridges: Set<TunnelBridge>
  localPort: number
  state: ForwardedPort['state']
  error: string | null
  closed: boolean
  ready: Promise<void>
}

/**
 * Owns the desktop side of raw port forwarding. Every listener is explicitly
 * IPv4 loopback-only; callers cannot provide a bind address.
 */
export class PortTunnelManager {
  private readonly tunnels = new Map<number, ManagedTunnel>()
  private changeListener: PortTunnelChangeListener | null = null

  setChangeListener(listener: PortTunnelChangeListener | null): void {
    this.changeListener = listener
  }

  list(): ForwardedPort[] {
    return [...this.tunnels.values()]
      .filter(tunnel => !tunnel.closed)
      .sort((left, right) => left.remotePort - right.remotePort)
      .map(snapshot)
  }

  async start(
    sessionId: string,
    remotePort: number,
    preferredLocalPort: number | undefined,
    createRemoteSocket: () => WebSocket,
    maxBridgesPerSession = PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL
  ): Promise<ForwardedPort> {
    requireSessionId(sessionId)
    requireTCPPort(remotePort, 'Remote')
    if (preferredLocalPort !== undefined) requireTCPPort(preferredLocalPort, 'Local')
    if (typeof createRemoteSocket !== 'function') throw new Error('A remote port tunnel transport is required.')
    const boundedSessionBridgeLimit = boundedBridgeLimit(maxBridgesPerSession)

    const key = remotePort
    const existing = this.tunnels.get(key)
    if (existing && !existing.closed) {
      await existing.ready
      if (preferredLocalPort !== undefined && preferredLocalPort !== existing.localPort) {
        throw new Error(`Remote port ${remotePort} is already forwarded on local port ${existing.localPort}.`)
      }
      return snapshot(existing)
    }

    if (this.tunnels.size >= PORT_TUNNEL_MAX_LISTENERS_GLOBAL) {
      throw new Error(`At most ${PORT_TUNNEL_MAX_LISTENERS_GLOBAL} port forwards can be active at once.`)
    }
    const sessionListenerCount = [...this.tunnels.values()]
      .filter(tunnel => tunnel.sessionId === sessionId && !tunnel.closed)
      .length
    if (sessionListenerCount >= PORT_TUNNEL_MAX_LISTENERS_PER_SESSION) {
      throw new Error(`At most ${PORT_TUNNEL_MAX_LISTENERS_PER_SESSION} ports can be forwarded for one chat.`)
    }

    const server = createServer(localSocket => this.acceptLocalSocket(tunnel, localSocket))
    const tunnel: ManagedTunnel = {
      key,
      sessionId,
      remotePort,
      preferredLocalPort,
      server,
      createRemoteSocket,
      maxBridgesPerSession: boundedSessionBridgeLimit,
      bridges: new Set(),
      localPort: 0,
      state: 'starting',
      error: null,
      closed: false,
      ready: Promise.resolve()
    }
    this.tunnels.set(key, tunnel)
    this.notifyChanged()
    tunnel.ready = this.listen(tunnel)

    try {
      await tunnel.ready
      return snapshot(tunnel)
    } catch (error) {
      if (this.tunnels.get(key) === tunnel) {
        this.tunnels.delete(key)
        this.notifyChanged()
      }
      tunnel.closed = true
      closeServer(tunnel.server)
      throw error
    }
  }

  async stop(remotePort: number): Promise<void> {
    requireTCPPort(remotePort, 'Remote')
    const tunnel = this.tunnels.get(remotePort)
    if (!tunnel) return
    this.tunnels.delete(remotePort)
    this.notifyChanged()
    await stopTunnel(tunnel)
  }

  /**
   * Invalidates only the tunnel created by the supplied transport factory.
   * This lets a caller clean up a post-start validation failure without
   * touching a same-chat tunnel created later by another profile generation.
   */
  disposeIfOwned(
    sessionId: string,
    remotePort: number,
    createRemoteSocket: () => WebSocket
  ): boolean {
    requireSessionId(sessionId)
    requireTCPPort(remotePort, 'Remote')
    const tunnel = this.tunnels.get(remotePort)
    if (
      !tunnel
      || tunnel.sessionId !== sessionId
      || tunnel.createRemoteSocket !== createRemoteSocket
    ) return false
    this.tunnels.delete(remotePort)
    this.notifyChanged()
    void stopTunnel(tunnel)
    return true
  }

  url(remotePort: number): string {
    requireTCPPort(remotePort, 'Remote')
    const tunnel = this.tunnels.get(remotePort)
    if (!tunnel || tunnel.closed || tunnel.localPort < 1) {
      throw new Error(`Remote port ${remotePort} is not forwarded for this server profile.`)
    }
    return localURL(tunnel.localPort)
  }

  /** Synchronous invalidation used before a profile/client generation changes. */
  disposeAll(): void {
    const tunnels = [...this.tunnels.values()]
    if (!tunnels.length) return
    this.tunnels.clear()
    this.notifyChanged()
    for (const tunnel of tunnels) void stopTunnel(tunnel)
  }

  /** Synchronous invalidation used when a chat is archived or removed. */
  disposeSession(sessionId: string): void {
    requireSessionId(sessionId)
    let changed = false
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.sessionId !== sessionId) continue
      this.tunnels.delete(tunnel.key)
      changed = true
      void stopTunnel(tunnel)
    }
    if (changed) this.notifyChanged()
  }

  private listen(tunnel: ManagedTunnel): Promise<void> {
    return new Promise((resolve, reject) => {
      let starting = true
      const fail = (error: Error): void => {
        if (starting) {
          starting = false
          reject(new Error(`Could not listen on ${PORT_TUNNEL_LOOPBACK_HOST}:${tunnel.preferredLocalPort ?? 0}: ${error.message}`))
          return
        }
        this.markError(tunnel, `Local port listener failed: ${error.message}`)
        for (const bridge of [...tunnel.bridges]) bridge.close()
      }
      tunnel.server.on('error', fail)
      tunnel.server.listen({
        host: PORT_TUNNEL_LOOPBACK_HOST,
        port: tunnel.preferredLocalPort ?? 0,
        exclusive: true
      }, () => {
        if (!starting) return
        starting = false
        if (tunnel.closed || this.tunnels.get(tunnel.key) !== tunnel) {
          closeServer(tunnel.server)
          reject(new Error('The server profile changed before the port forward was ready.'))
          return
        }
        const address = tunnel.server.address()
        if (!address || typeof address === 'string' || address.address !== PORT_TUNNEL_LOOPBACK_HOST) {
          closeServer(tunnel.server)
          reject(new Error('The port forward could not verify its loopback-only listener.'))
          return
        }
        tunnel.localPort = (address as AddressInfo).port
        this.markOpen(tunnel)
        tunnel.server.unref()
        resolve()
      })
    })
  }

  private acceptLocalSocket(tunnel: ManagedTunnel, localSocket: Socket): void {
    if (tunnel.closed || this.tunnels.get(tunnel.key) !== tunnel) {
      localSocket.destroy()
      return
    }
    if (
      tunnel.bridges.size >= PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL
      || this.activeBridgeCount(tunnel.sessionId) >= this.bridgeLimitForSession(tunnel.sessionId)
      || this.activeBridgeCount() >= PORT_TUNNEL_MAX_BRIDGES_GLOBAL
    ) {
      localSocket.destroy()
      return
    }

    let closed = false
    let remoteSocket: WebSocket | null = null
    let finish: (closeLocal?: boolean, closeRemote?: boolean) => void = (closeLocal = true, closeRemote = true): void => {
      if (closed) return
      closed = true
      tunnel.bridges.delete(bridge)
      if (closeLocal && !localSocket.destroyed) localSocket.destroy()
      if (closeRemote && remoteSocket && remoteSocket.readyState < 2) {
        remoteSocket.close(1000, 'Local connection closed')
      }
    }
    const bridge: TunnelBridge = { close: () => finish() }
    tunnel.bridges.add(bridge)

    try {
      remoteSocket = tunnel.createRemoteSocket()
    } catch (error) {
      this.markError(tunnel, `Remote port tunnel failed: ${errorText(error)}`)
      finish()
      return
    }
    if (closed || tunnel.closed || this.tunnels.get(tunnel.key) !== tunnel) {
      if (remoteSocket.readyState < 2) remoteSocket.close(1000, 'Port forward closed')
      finish()
      return
    }

    const transport = remoteSocket
    localSocket.setNoDelay(true)
    transport.binaryType = 'arraybuffer'

    let acceptedProtocol = false
    let opened = false
    let pendingBytes = 0
    const pending: Buffer[] = []
    let backpressureTimer: NodeJS.Timeout | null = null
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
      connectTimer = null
      if (closed || opened) return
      this.markError(tunnel, 'Timed out connecting to the remote port tunnel.')
      finish()
    }, REMOTE_CONNECT_TIMEOUT_MS)
    connectTimer.unref?.()

    finish = (closeLocal = true, closeRemote = true): void => {
      if (closed) return
      closed = true
      if (backpressureTimer) clearTimeout(backpressureTimer)
      if (connectTimer) clearTimeout(connectTimer)
      backpressureTimer = null
      connectTimer = null
      tunnel.bridges.delete(bridge)
      pending.length = 0
      pendingBytes = 0
      if (closeLocal && !localSocket.destroyed) localSocket.destroy()
      if (closeRemote && transport.readyState < 2) transport.close(1000, 'Local connection closed')
    }

    const checkRemoteBackpressure = (): void => {
      if (closed || transport.readyState !== 1) return
      if (transport.bufferedAmount > MAX_PENDING_BYTES) {
        this.markError(tunnel, 'Port tunnel closed because the remote connection could not keep up.')
        finish()
        return
      }
      if (transport.bufferedAmount > WEBSOCKET_LOW_WATER_BYTES) {
        if (!backpressureTimer) {
          backpressureTimer = setTimeout(() => {
            backpressureTimer = null
            checkRemoteBackpressure()
          }, BACKPRESSURE_POLL_MS)
          backpressureTimer.unref?.()
        }
        return
      }
      localSocket.resume()
    }
    const sendRemote = (bytes: Uint8Array): void => {
      if (closed || !acceptedProtocol || transport.readyState !== 1) return
      try {
        const payload = new Uint8Array(bytes.byteLength)
        payload.set(bytes)
        transport.send(payload.buffer)
        if (transport.bufferedAmount > WEBSOCKET_HIGH_WATER_BYTES) {
          localSocket.pause()
          checkRemoteBackpressure()
        }
      } catch (error) {
        this.markError(tunnel, `Port tunnel write failed: ${errorText(error)}`)
        finish()
      }
    }

    localSocket.on('data', data => {
      if (closed) return
      const bytes = typeof data === 'string' ? Buffer.from(data) : data
      if (acceptedProtocol && transport.readyState === 1) {
        sendRemote(bytes)
        return
      }
      if (transport.readyState > 1) {
        finish()
        return
      }
      pendingBytes += bytes.byteLength
      if (pendingBytes > MAX_PENDING_BYTES) {
        this.markError(tunnel, 'Port tunnel closed because too much data arrived before the remote connection was ready.')
        finish()
        return
      }
      pending.push(Buffer.from(bytes))
    })
    localSocket.on('error', () => finish(false))
    localSocket.on('close', () => finish(false))

    transport.addEventListener('open', () => {
      if (closed) return
      opened = true
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
      if (transport.protocol !== PORT_TUNNEL_SUBPROTOCOL) {
        this.markError(tunnel, 'AgentsServer did not accept the authenticated port tunnel protocol.')
        finish(true, false)
        transport.close(1002, 'Port tunnel protocol was not accepted')
        return
      }
      acceptedProtocol = true
      this.markOpen(tunnel)
      for (const bytes of pending.splice(0)) sendRemote(bytes)
      pendingBytes = 0
    })
    transport.addEventListener('message', event => {
      if (closed || !acceptedProtocol) return
      void binaryMessage(event.data).then(bytes => {
        if (closed || !bytes) {
          if (!closed && bytes === null) {
            this.markError(tunnel, 'AgentsServer sent a non-binary port tunnel packet.')
            finish()
          }
          return
        }
        if (localSocket.writableLength + bytes.byteLength > MAX_PENDING_BYTES) {
          this.markError(tunnel, 'Port tunnel closed because the local connection could not keep up.')
          finish()
          return
        }
        localSocket.write(bytes)
      }).catch(error => {
        if (!closed) {
          this.markError(tunnel, `Port tunnel packet failed: ${errorText(error)}`)
          finish()
        }
      })
    })
    transport.addEventListener('error', () => {
      if (!closed && !opened) this.markError(tunnel, 'Could not connect to the remote port tunnel.')
    })
    transport.addEventListener('close', event => {
      if (!closed && isFatalTunnelClose(event.code)) {
        this.disposeTunnel(tunnel)
        return
      }
      if (!closed) {
        const reason = event.reason?.trim() || closeReason(event.code)
        if (!acceptedProtocol) {
          this.markError(tunnel, `Remote port tunnel closed before it was ready${reason ? `: ${reason}` : '.'}`)
        } else if (event.code !== 1000 && event.code !== 1001) {
          this.markError(tunnel, `Remote port tunnel closed${reason ? `: ${reason}` : '.'}`)
        }
      }
      finish(true, false)
    })
  }

  private activeBridgeCount(sessionId?: string): number {
    let count = 0
    for (const tunnel of this.tunnels.values()) {
      if (sessionId !== undefined && tunnel.sessionId !== sessionId) continue
      count += tunnel.bridges.size
    }
    return count
  }

  private bridgeLimitForSession(sessionId: string): number {
    let limit = PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL
    for (const tunnel of this.tunnels.values()) {
      if (!tunnel.closed && tunnel.sessionId === sessionId) {
        limit = Math.min(limit, tunnel.maxBridgesPerSession)
      }
    }
    return limit
  }

  private disposeTunnel(tunnel: ManagedTunnel): void {
    if (this.tunnels.get(tunnel.key) !== tunnel) return
    this.tunnels.delete(tunnel.key)
    this.notifyChanged()
    void stopTunnel(tunnel)
  }

  private markError(tunnel: ManagedTunnel, message: string): void {
    if (tunnel.closed || this.tunnels.get(tunnel.key) !== tunnel) return
    if (tunnel.state === 'error' && tunnel.error === message) return
    tunnel.state = 'error'
    tunnel.error = message
    this.notifyChanged()
  }

  private markOpen(tunnel: ManagedTunnel): void {
    if (tunnel.closed || this.tunnels.get(tunnel.key) !== tunnel) return
    if (tunnel.state === 'open' && tunnel.error === null) return
    tunnel.state = 'open'
    tunnel.error = null
    this.notifyChanged()
  }

  private notifyChanged(): void {
    if (!this.changeListener) return
    try {
      this.changeListener(this.list())
    } catch {
      // UI synchronization must never destabilize listener or bridge cleanup.
    }
  }
}

function boundedBridgeLimit(value: number): number {
  if (!Number.isFinite(value)) return PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL
  return Math.max(1, Math.min(PORT_TUNNEL_MAX_BRIDGES_PER_TUNNEL, Math.floor(value)))
}

function snapshot(tunnel: ManagedTunnel): ForwardedPort {
  return {
    sessionId: tunnel.sessionId,
    remotePort: tunnel.remotePort,
    localPort: tunnel.localPort,
    localUrl: tunnel.localPort > 0 ? localURL(tunnel.localPort) : '',
    state: tunnel.state,
    error: tunnel.error
  }
}

async function stopTunnel(tunnel: ManagedTunnel): Promise<void> {
  if (tunnel.closed) return
  tunnel.closed = true
  for (const bridge of [...tunnel.bridges]) bridge.close()
  tunnel.bridges.clear()
  await closeServer(tunnel.server)
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => server.close(() => resolve()))
}

async function binaryMessage(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  return null
}

function requireSessionId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid chat for port forwarding.')
  }
}

function requireTCPPort(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error(`${label} port must be an integer from 1024 through 65535.`)
  }
}

function localURL(localPort: number): string {
  return `http://${PORT_TUNNEL_LOOPBACK_HOST}:${localPort}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function closeReason(code: number): string {
  if (code === 4400) return 'the tunnel request was invalid'
  if (code === 4401) return 'authorization failed'
  if (code === 4404) return 'chat or remote port was not found'
  if (code === 4406) return 'the required tunnel protocol was rejected'
  if (code === 4409) return 'the chat is archived'
  if (code === 4429) return 'the server connection limit was reached'
  if (code === 4502) return 'the remote loopback service is unavailable'
  return code && code !== 1000 ? `WebSocket code ${code}` : ''
}

function isFatalTunnelClose(code: number): boolean {
  return code === 4401 || code === 4404 || code === 4409
}
