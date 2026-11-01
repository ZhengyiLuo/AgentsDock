import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer as createHTTPServer } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { completeOwnedClientReset, createNativeObservationRelay, NativeRequestObserver, ownedLoopbackURL } from '../product_no_downgrade_relay.mjs'
import { assertNoUpdateRequests } from '../product_no_downgrade_desktop.mjs'

const request = 'GET /api/health?private=value HTTP/1.1\r\nHost: 127.0.0.1\r\nX-AgentsDock-Token: never-record-me\r\n\r\n'
function observe(bytes, fragments = false) {
  const records = [], observer = new NativeRequestObserver(record => records.push(record))
  if (fragments) for (const byte of Buffer.from(bytes)) observer.feed(Buffer.from([byte]))
  else observer.feed(Buffer.from(bytes))
  observer.finish(); return records
}

test('only a literal nonprivileged loopback target and explicit ownership proof are accepted', async () => {
  assert.equal(ownedLoopbackURL('http://127.0.0.1:18000').port, '18000')
  for (const url of ['http://localhost:18000', 'http://127.0.0.2:18000', 'http://[::1]:18000', 'http://2130706433:18000', 'http://127.1:18000',
    'https://127.0.0.1:18000', 'http://127.0.0.1:80', 'http://user:secret@127.0.0.1:18000',
    'http://127.0.0.1:18000/other', 'http://127.0.0.1:18000/?secret=value']) assert.throws(() => ownedLoopbackURL(url))
  await assert.rejects(createNativeObservationRelay({ targetURL: 'http://127.0.0.1:18000' }))
  await assert.rejects(createNativeObservationRelay({ targetURL: 'http://127.0.0.1:18000', assertOwnedTarget: () => { throw Error('not owned') } }))
})

test('fragmented persistent requests record only sanitized methods and fixed path categories', () => {
  const records = observe(request + 'GET /api/sessions/private-id?token=secret HTTP/1.1\r\nHost: local\r\n\r\n', true)
  assert.deepEqual(records, [{ method: 'GET', path: '/api/health', upgrade: false }, { method: 'GET', path: 'other', upgrade: false }])
  assert(!JSON.stringify(records).match(/private|secret|token|never-record/i))
})

test('fixed-length and chunked bodies are not mistaken for HTTP requests across byte fragments', () => {
  const body = 'POST /api/admin/update/ensure HTTP/1.1\r\n\r\n'
  for (const framed of [
    `POST /api/sessions HTTP/1.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    `POST /api/sessions HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)};extension=value\r\n${body}\r\n0\r\n\r\n`,
  ]) assert.deepEqual(observe(framed + request, true).map(item => item.path), ['other', '/api/health'])
})

test('update control requests are observed, not suppressed or rewritten', () => {
  assert.deepEqual(observe('POST /api/admin/update/ensure HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}'),
    [{ method: 'POST', path: '/api/admin/update/ensure', upgrade: false }])
  assert.equal(observe('POST /api/admin/update/private-future-control?secret=value HTTP/1.1\r\n\r\n')[0].path, '/api/admin/update/other')
  assert.equal(observe('POST /api/admin/%75pdate/ensure HTTP/1.1\r\n\r\n')[0].path, '/api/admin/update/ensure')
})

test('ambiguous, unsupported, oversized and incomplete framing fail closed', () => {
  for (const bytes of [
    'GET /api/health HTTP/2.0\r\n\r\n', 'CONNECT localhost:80 HTTP/1.1\r\n\r\n',
    'GET //elsewhere HTTP/1.1\r\n\r\n', 'GET /api/health HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n',
    'POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx',
    'POST / HTTP/1.1\r\nContent-Length: 8388609\r\n\r\n', 'POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nx',
    'POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n',
    'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: private\r\n\r\n',
    'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n800001\r\n',
    'GET / HTTP/1.1\r\nX: ' + 'a'.repeat(65536), 'GET / HTTP/1.1\r\nX: bad\0value\r\n\r\n',
  ]) assert.throws(() => observe(bytes), undefined, bytes.slice(0, 80))
})

test('websocket frames become opaque only after actual upstream 101, never on request alone', () => {
  const upgrade = 'GET /ws/events?private=value HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
  let observer = new NativeRequestObserver(() => {})
  observer.feed(Buffer.from(upgrade)); assert.throws(() => observer.finish())
  assert.throws(() => observer.feed(Buffer.from([0x81, 0x00])))
  assert.throws(() => observer.acceptUpgrade(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')))
  observer = new NativeRequestObserver(() => {})
  observer.feed(Buffer.from(upgrade))
  observer.acceptUpgrade(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
  observer.feed(Buffer.from([0x81, 0x02, 0x00, 0xff])); observer.finish()
})

test('persistent HTTP can upgrade only after complete prior request framing and real upstream 101', () => {
  const upgrade = 'GET /events HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n'
  const response = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  for (const preceding of [request, 'POST /api/sessions HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}',
    'POST /api/sessions HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n']) {
    const records = [], observer = new NativeRequestObserver(record => records.push(record))
    observer.feed(Buffer.from(preceding)); observer.finish()
    for (const byte of Buffer.from(upgrade)) observer.feed(Buffer.from([byte]))
    assert.equal(observer.state, 'upgrade-wait')
    assert.throws(() => observer.finish())
    observer.acceptUpgrade(response)
    observer.feed(Buffer.from([0x81, 0x00])); observer.finish()
    assert.equal(records.length, 2)
    assert.equal(records[1].upgrade, true)
  }
})

test('reused connection still rejects unsupported upgrades, incomplete bodies and pre-101 pipelining', () => {
  const upgrade = 'GET /events HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
  for (const invalid of [upgrade.replace('GET ', 'POST '), upgrade.replace('websocket', 'h2c'),
    upgrade.replace('Connection: Upgrade\r\n', ''), upgrade.replace('\r\n\r\n', '\r\nContent-Length: 0\r\n\r\n'),
    upgrade.replace('\r\n\r\n', '\r\nTransfer-Encoding: chunked\r\n\r\n'), upgrade + 'GET /api/health HTTP/1.1\r\n\r\n']) {
    const observer = new NativeRequestObserver(() => {})
    observer.feed(Buffer.from(request))
    assert.throws(() => observer.feed(Buffer.from(invalid)))
  }
  for (const together of [true, false]) {
    const observer = new NativeRequestObserver(() => {})
    observer.feed(Buffer.from(request))
    if (!together) observer.feed(Buffer.from(upgrade))
    assert.throws(() => observer.feed(Buffer.concat([...(together ? [Buffer.from(upgrade)] : []), Buffer.from([0x81, 0x00])])))
  }
  const partial = new NativeRequestObserver(() => {})
  partial.feed(Buffer.from('POST /api/sessions HTTP/1.1\r\nContent-Length: 8192\r\n\r\n{'))
  partial.feed(Buffer.from(upgrade))
  assert.equal(partial.state, 'body')
  assert.throws(() => partial.acceptUpgrade(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')))
  assert.throws(() => partial.finish())
  for (const invalid of ['HTTP/1.1 200 OK\r\n\r\n', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n']) {
    const observer = new NativeRequestObserver(() => {})
    observer.feed(Buffer.from(request)); observer.feed(Buffer.from(upgrade))
    assert.throws(() => observer.acceptUpgrade(Buffer.from(invalid)))
    assert.throws(() => observer.finish())
  }
})

test('real global fetch then WebSocket reuses one TCP connection through actual upstream 101', { timeout: 5000 }, async t => {
  const sockets = new Set()
  let httpSocket, upgradeSocket, upstreamConnections = 0, websocket
  const upstream = createHTTPServer((req, res) => {
    assert.equal(req.url, '/api/health')
    httpSocket = req.socket
    res.writeHead(200, { 'Content-Length': '2' }); res.end('{}')
  })
  upstream.on('connection', socket => {
    upstreamConnections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket))
  })
  upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/events'); assert.equal(head.length, 0)
    upgradeSocket = socket
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const relay = await createNativeObservationRelay({ targetURL: `http://127.0.0.1:${upstream.address().port}`,
    assertOwnedTarget: () => assert.equal(upstream.listening, true) })
  t.after(async () => {
    if (websocket?.readyState === WebSocket.OPEN) websocket.close()
    await relay.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve))
  })
  assert.equal(await (await fetch(relay.url + '/api/health')).text(), '{}')
  await delay(100) // Allow native undici to return the consumed connection to its pool.
  websocket = new WebSocket(relay.url.replace('http:', 'ws:') + '/events')
  const closed = once(websocket, 'close')
  await once(websocket, 'open'); await closed
  assert.equal(upgradeSocket, httpSocket, 'The native clients must actually reuse the same upstream TCP connection')
  assert.equal(upstreamConnections, 1)
  assert.equal(relay.snapshot().connections, 1)
  assert.equal(relay.snapshot().upgrades, 1)
  assert.deepEqual(relay.snapshot().requests, { 'GET /api/health': 1, 'GET other': 1 })
  relay.assertValid(); assertNoUpdateRequests(relay.snapshot())
})

async function socketFixture(t, onData) {
  const sockets = new Set()
  const upstream = createServer(socket => { sockets.add(socket); socket.on('data', bytes => onData(socket, bytes)); socket.on('close', () => sockets.delete(socket)) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  let ownershipChecks = 0
  const relay = await createNativeObservationRelay({ targetURL: `http://127.0.0.1:${upstream.address().port}`, assertOwnedTarget: () => { ownershipChecks++ } })
  const client = createConnection({ host: '127.0.0.1', port: Number(new URL(relay.url).port) })
  await once(client, 'connect')
  t.after(async () => { client.destroy(); await relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)) })
  assert.equal(ownershipChecks, 1)
  return { client, relay }
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await delay(10)
  }
  assert.fail('Owned TCP observation did not settle')
}

test('only an exact client ECONNRESET after complete framing is accepted', () => {
  const observer = new NativeRequestObserver(() => {})
  observer.feed(Buffer.from(request))
  for (const code of ['EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'UNKNOWN', undefined]) {
    assert.equal(completeOwnedClientReset(observer, { code, message: 'private error value' }), false)
  }
  assert.equal(completeOwnedClientReset(observer, { code: 'ECONNRESET' }), true)
  for (const bytes of [
    'POST /api/admin/up',
    'POST /api/admin/update/ensure HTTP/1.1\r\nContent-Length: 2\r\n\r\n{',
    'POST /api/admin/update/ensure HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{',
    'GET /events HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
  ]) {
    const incomplete = new NativeRequestObserver(() => {})
    incomplete.feed(Buffer.from(bytes))
    assert.throws(() => completeOwnedClientReset(incomplete, { code: 'ECONNRESET' }))
  }
})

test('real client reset after complete HTTP remains valid across reconnection', { timeout: 5000 }, async t => {
  const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
  const { client, relay } = await socketFixture(t, socket => socket.write(response))
  let incoming = once(client, 'data'); client.write(request); assert.deepEqual((await incoming)[0], response)
  client.resetAndDestroy(); await once(client, 'close')
  await waitFor(() => relay.snapshot().clientResets === 1)
  relay.assertValid(); assertNoUpdateRequests(relay.snapshot())
  const next = createConnection({ host: '127.0.0.1', port: Number(new URL(relay.url).port) })
  t.after(() => next.destroy()); await once(next, 'connect')
  incoming = once(next, 'data'); next.write(request); assert.deepEqual((await incoming)[0], response)
  next.end(); await once(next, 'close')
  relay.assertValid(); assertNoUpdateRequests(relay.snapshot())
  assert.equal(relay.snapshot().requests['GET /api/health'], 2)
  assert.equal(relay.snapshot().connections, 2)
})

test('real client reset after established WebSocket tunnel preserves completed observation', { timeout: 5000 }, async t => {
  const upgrade = Buffer.from('GET /events HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  const response = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  const { client, relay } = await socketFixture(t, socket => socket.write(response))
  const incoming = once(client, 'data'); client.write(upgrade); assert.deepEqual((await incoming)[0], response)
  client.resetAndDestroy(); await once(client, 'close')
  await waitFor(() => relay.snapshot().clientResets === 1)
  relay.assertValid(); assert.equal(relay.snapshot().upgrades, 1)
  assert.equal((await relay.close()).valid, true)
})

test('real reset with incomplete framing permanently invalidates observation', { timeout: 5000 }, async t => {
  let arrived
  const delivered = new Promise(resolve => { arrived = resolve })
  const { client, relay } = await socketFixture(t, () => arrived())
  client.write(request + 'POST /api/admin/update/ensure HTTP/1.1\r\nContent-Length: 2\r\n\r\n{')
  await delivered
  client.resetAndDestroy(); await once(client, 'close')
  await waitFor(() => !relay.snapshot().valid)
  assert.equal(relay.snapshot().failureKind, 'client-reset-incomplete')
  assert.equal(relay.snapshot().failureState, 'body')
  assert.equal(relay.snapshot().clientResets, 0)
  assert.throws(() => assertNoUpdateRequests(relay.snapshot()))
  const before = relay.snapshot()
  const next = createConnection({ host: '127.0.0.1', port: Number(new URL(relay.url).port) })
  t.after(() => next.destroy()); await once(next, 'connect')
  next.end(request); await once(next, 'close')
  assert.equal(relay.snapshot().valid, false)
  assert.equal(relay.snapshot().failureKind, before.failureKind)
  assert.equal((await relay.close()).failure, 'HTTP_OBSERVATION_INVALID')
})

test('real upstream reset remains a failure even after a complete request', { timeout: 5000 }, async t => {
  const { client, relay } = await socketFixture(t, socket => socket.resetAndDestroy())
  client.write(request); await once(client, 'close')
  assert.equal(relay.snapshot().valid, false)
  assert.equal(relay.snapshot().failureKind, 'upstream-socket')
  assert.equal(relay.snapshot().clientResets, 0)
})

test('actual TCP relay preserves request and response bytes on persistent fixed/chunked HTTP', { timeout: 5000 }, async t => {
  const wire = Buffer.from(request + 'POST /api/admin/update/ensure HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n')
  const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n')
  let received = Buffer.alloc(0)
  const { client, relay } = await socketFixture(t, (socket, bytes) => {
    received = Buffer.concat([received, bytes]); if (received.length === wire.length) socket.write(response)
  })
  const incoming = once(client, 'data'); client.write(wire.subarray(0, 9)); client.write(wire.subarray(9))
  assert.deepEqual((await incoming)[0], response); assert.deepEqual(received, wire)
  assert.deepEqual(relay.snapshot().requests, { 'GET /api/health': 1, 'POST /api/admin/update/ensure': 1 })
  client.end(); await once(client, 'close'); relay.assertValid()
  const receipt = JSON.stringify(await relay.close())
  assert(!receipt.match(/never-record|private|value|token/i))
})

test('actual TCP relay forwards websocket upgrade and opaque frames unchanged', { timeout: 5000 }, async t => {
  const upgrade = Buffer.from('GET /events HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  const response = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  let first = true
  const { client, relay } = await socketFixture(t, (socket, bytes) => {
    if (first) { first = false; assert.deepEqual(bytes, upgrade); socket.write(response) } else socket.write(bytes)
  })
  let next = once(client, 'data'); client.write(upgrade); assert.deepEqual((await next)[0], response)
  const frame = Buffer.from([0x81, 0x83, 1, 2, 3, 4, 8, 9, 10])
  next = once(client, 'data'); client.write(frame); assert.deepEqual((await next)[0], frame)
  relay.assertValid(); assert.equal(relay.snapshot().upgrades, 1)
})

test('incomplete real socket traffic makes final observation permanently invalid', { timeout: 5000 }, async t => {
  const { client, relay } = await socketFixture(t, () => {})
  client.end('POST /api/admin/update/ensure HTTP/1.1\r\nContent-Length: 2\r\n\r\n{')
  await once(client, 'close')
  assert.equal(relay.snapshot().valid, false); assert.throws(() => relay.assertValid())
  assert.equal((await relay.close()).failure, 'HTTP_OBSERVATION_INVALID')
})

test('deliberate shutdown cannot bless a partial second request after valid health', { timeout: 5000 }, async t => {
  let delivered
  const arrived = new Promise(resolve => { delivered = resolve })
  const { client, relay } = await socketFixture(t, () => delivered())
  client.write(request + 'POST /api/admin/update/ensure HTTP/1.1\r\nContent-Length: 2\r\n\r\n{')
  await arrived
  assert.equal(relay.snapshot().requests['GET /api/health'], 1)
  assert.equal((await relay.close()).valid, false)
})
