// Acceptance-only byte-transparent loopback relay. It never fabricates an HTTP
// response, changes headers/body, or implements a server route. Unsupported or
// incomplete traffic invalidates the observation and closes the owned sockets.
import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'

const HEADER_LIMIT = 64 * 1024
const BODY_LIMIT = 8 * 1024 * 1024
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const PATHS = new Set(['/api/health', '/api/admin/update', '/api/admin/update/ensure',
  '/api/admin/update/start', '/api/admin/update/cancel', '/api/admin/update/check'])
const OBSERVER_STATES = new Set(['headers', 'body', 'chunk-size', 'chunk-body', 'chunk-end', 'trailers', 'upgrade-wait', 'tunnel'])
const need = condition => assert(condition, 'Unsupported or incomplete native HTTP traffic')

export function ownedLoopbackURL(value) {
  assert(typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*\/?$/.test(value), 'Relay target must use literal loopback syntax')
  const url = new URL(value)
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^[1-9]\d*$/.test(url.port)
    && Number(url.port) > 1024 && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Relay target must be an owned literal IPv4 loopback HTTP endpoint')
  return url
}

/** Bounded request framing; body contents are discarded, never recorded. */
export class NativeRequestObserver {
  constructor(record) { this.record = record; this.buffer = Buffer.alloc(0); this.state = 'headers'; this.remaining = 0; this.bodyBytes = 0; this.requests = 0 }
  feed(bytes) {
    if (this.state === 'tunnel') return
    need(this.state !== 'upgrade-wait')
    this.buffer = Buffer.concat([this.buffer, bytes])
    for (;;) {
      if (this.state === 'headers') {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) { need(this.buffer.length <= HEADER_LIMIT); return }
        need(end <= HEADER_LIMIT)
        const text = this.buffer.subarray(0, end).toString('latin1')
        need(!/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text.replaceAll('\r\n', '')))
        const [line, ...lines] = text.split('\r\n')
        const match = /^([A-Z]+) (\/[^\s]*) HTTP\/1\.[01]$/.exec(line)
        need(match && METHODS.has(match[1]) && !match[2].startsWith('//'))
        const headers = new Map()
        for (const line of lines) {
          const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line)
          need(header)
          const name = header[1].toLowerCase()
          need(!headers.has(name)); headers.set(name, header[2].trim())
        }
        const length = headers.get('content-length'), transfer = headers.get('transfer-encoding')
        need(!(length !== undefined && transfer !== undefined))
        need(length === undefined || /^(0|[1-9]\d*)$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) <= BODY_LIMIT)
        need(transfer === undefined || transfer.toLowerCase() === 'chunked')
        const upgrade = headers.get('upgrade')
        if (upgrade !== undefined) need(this.requests === 0 && match[1] === 'GET' && upgrade.toLowerCase() === 'websocket'
          && headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade') && length === undefined && transfer === undefined)
        const path = decodeURIComponent(match[2].split('?')[0])
        const category = PATHS.has(path) ? path : path.startsWith('/api/admin/update/') ? '/api/admin/update/other' : 'other'
        this.record({ method: match[1], path: category, upgrade: upgrade !== undefined })
        this.requests++; this.buffer = this.buffer.subarray(end + 4); this.bodyBytes = 0
        if (upgrade !== undefined) { need(this.buffer.length === 0); this.state = 'upgrade-wait'; return }
        if (transfer !== undefined) this.state = 'chunk-size'
        else if (Number(length) > 0) { this.remaining = Number(length); this.state = 'body' }
        if (!this.buffer.length) return
      } else if (this.state === 'body' || this.state === 'chunk-body') {
        const amount = Math.min(this.remaining, this.buffer.length)
        this.remaining -= amount; this.buffer = this.buffer.subarray(amount)
        if (this.remaining) return
        this.state = this.state === 'body' ? 'headers' : 'chunk-end'
      } else if (this.state === 'chunk-size') {
        const end = this.buffer.indexOf('\r\n')
        if (end < 0) { need(this.buffer.length <= 1024); return }
        need(end <= 1024)
        const line = this.buffer.subarray(0, end).toString('ascii')
        need(/^[0-9A-Fa-f]{1,8}(?:;[\x20-\x7e]*)?$/.test(line))
        this.remaining = parseInt(line.split(';')[0], 16); this.bodyBytes += this.remaining
        need(this.bodyBytes <= BODY_LIMIT); this.buffer = this.buffer.subarray(end + 2)
        this.state = this.remaining ? 'chunk-body' : 'trailers'
      } else if (this.state === 'chunk-end') {
        if (this.buffer.length < 2) return
        need(this.buffer.subarray(0, 2).toString() === '\r\n'); this.buffer = this.buffer.subarray(2); this.state = 'chunk-size'
      } else if (this.state === 'trailers') {
        // Native requests in this journey do not need HTTP trailers. Refuse
        // them rather than claiming observation of unparsed framing.
        if (this.buffer.length < 2) return
        need(this.buffer.subarray(0, 2).toString() === '\r\n'); this.buffer = this.buffer.subarray(2); this.state = 'headers'
      }
      if (!this.buffer.length) return
    }
  }
  acceptUpgrade(header) {
    need(this.state === 'upgrade-wait' && header.length <= HEADER_LIMIT)
    const lines = header.toString('latin1').split('\r\n')
    need(/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0]) && lines.some(line => /^upgrade:\s*websocket\s*$/i.test(line))
      && lines.some(line => /^connection:.*\bupgrade\b/i.test(line)))
    this.state = 'tunnel'
  }
  finish() { need(this.state === 'tunnel' || this.state === 'headers' && this.buffer.length === 0) }
}

export function completeOwnedClientReset(observer, error) {
  if (error?.code !== 'ECONNRESET') return false
  // The app's own TCP reset after a complete request/tunnel is a disconnect,
  // not missing HTTP evidence. An incomplete request/upgrade still throws.
  observer.finish()
  return true
}

export async function createNativeObservationRelay({ targetURL, assertOwnedTarget }) {
  const target = ownedLoopbackURL(targetURL)
  assert(typeof assertOwnedTarget === 'function', 'Native target ownership check is required')
  await assertOwnedTarget()
  const sockets = new Set(), counts = new Map(), observers = new Set()
  let failure = null, failureKind = null, failureState = null, connections = 0, upgrades = 0, clientResets = 0, closed = false, closing
  const reject = (kind, observer) => {
    if (failure === null) {
      failure = 'HTTP_OBSERVATION_INVALID'; failureKind = kind
      failureState = OBSERVER_STATES.has(observer?.state) ? observer.state : null
    }
    for (const socket of sockets) socket.destroy()
  }
  const listener = createServer(client => {
    connections++
    if (client.remoteAddress !== '127.0.0.1' || closed) { reject('client-origin'); client.destroy(); return }
    const remote = createConnection({ host: '127.0.0.1', port: Number(target.port) })
    sockets.add(client); sockets.add(remote)
    const observer = new NativeRequestObserver(({ method, path, upgrade }) => {
      const key = `${method} ${path}`; counts.set(key, (counts.get(key) ?? 0) + 1); if (upgrade) upgrades++
    })
    observers.add(observer)
    let responseHeader = Buffer.alloc(0)
    client.on('data', bytes => {
      try { observer.feed(bytes); if (!remote.write(bytes)) client.pause() } catch { reject('request-framing', observer) }
    })
    remote.on('drain', () => client.resume())
    remote.on('data', bytes => {
      try {
        if (observer.state === 'upgrade-wait') {
          responseHeader = Buffer.concat([responseHeader, bytes]); const end = responseHeader.indexOf('\r\n\r\n')
          if (end < 0) need(responseHeader.length <= HEADER_LIMIT)
          else { observer.acceptUpgrade(responseHeader.subarray(0, end + 4)); responseHeader = Buffer.alloc(0) }
        }
        if (!client.write(bytes)) remote.pause()
      } catch { reject('response-upgrade', observer) }
    })
    client.on('drain', () => remote.resume())
    client.on('end', () => { try { observer.finish(); remote.end() } catch { reject('client-end-incomplete', observer) } })
    remote.on('end', () => client.end())
    client.on('error', error => {
      if (closed) return
      try {
        if (completeOwnedClientReset(observer, error)) {
          clientResets++
          client.destroy(); remote.destroy()
        } else reject('client-socket', observer)
      } catch { reject('client-reset-incomplete', observer) }
    })
    // An upstream reset is not evidence of a normal app disconnect.
    remote.on('error', () => { if (!closed) reject('upstream-socket', observer) })
    client.on('close', () => { sockets.delete(client); observers.delete(observer); remote.destroy(); try { observer.finish() } catch { reject('client-close-incomplete', observer) } })
    remote.on('close', () => { sockets.delete(remote); client.destroy() })
  })
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const snapshot = () => ({ schema: 1, kind: 'transparent-loopback-http-observation', valid: failure === null,
    failure, failureKind, failureState, connections, upgrades, clientResets,
    requests: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) })
  return {
    url: `http://127.0.0.1:${listener.address().port}`,
    snapshot,
    assertValid() { assert.equal(failure, null, 'Native HTTP observation is incomplete or unsupported') },
    async close() {
      if (!closing) {
        for (const observer of observers) { try { observer.finish() } catch { reject('shutdown-incomplete', observer) } }
        closed = true
        for (const socket of sockets) socket.destroy()
        closing = new Promise(resolve => listener.close(resolve))
      }
      await closing; return snapshot()
    }
  }
}
