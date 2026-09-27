#!/usr/bin/env node
// Test-only exact-artifact origin replay. This is not a proxy or acceptance proof.
// It never installs certificates, changes DNS, fetches URLs, or publishes assets.
import { createHash, createPublicKey, X509Certificate } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { expectedAssets, verifyAssets } from './direct-release-mirror.mjs'
import { validatePreparationRun, verifyReceiptBundle } from './product-release.mjs'

const HOSTS = ['github.com', 'api.github.com', 'registry.npmjs.org']
const DESKTOP_REPOSITORIES = ['ZhengyiLuo/AgentsDock', 'ZhengyiLuo/AgentsDock-Releases']
const SERVER_REPOSITORY = 'ZhengyiLuo/AgentsServer'
const MAX_FILE = 2 * 1024 * 1024 * 1024
const MAX_METADATA = 32768
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const need = (condition, message) => { if (!condition) throw new Error(message) }

async function regular(path, maximum = MAX_METADATA) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    need(stat.isFile() && stat.size <= maximum, 'Replay input must be a bounded regular file.')
    const bytes = await file.readFile()
    need(bytes.length <= maximum, 'Replay input exceeded its size limit.')
    return bytes
  } finally { await file.close() }
}

async function directory(path) {
  need((await lstat(path)).isDirectory(), 'Replay asset directory must not be a symlink.')
}

export async function readReplayMetadata(path, expectedSha256) {
  const bytes = await regular(path)
  need(/^[a-f0-9]{64}$/.test(expectedSha256) && digest(bytes) === expectedSha256,
    'Replay metadata bytes differ from the product receipt.')
  return bytes
}

// Hash before serving, and retain this exact open descriptor for the response.
// The owner must not mutate artifacts during replay. Native clients still verify
// their normal package checksums/signatures; this helper never replaces those.
async function verifiedFile(path, expected) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    need(before.isFile() && before.size > 0n && before.size <= BigInt(MAX_FILE), 'Invalid replay asset size or type.')
    if (expected.size !== undefined) need(before.size === BigInt(expected.size), 'Replay asset size changed.')
    const hash = createHash('sha256'), chunk = Buffer.alloc(256 * 1024)
    let offset = 0
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      need(offset <= MAX_FILE && BigInt(offset) <= before.size, 'Replay asset grew while being verified.')
      hash.update(chunk.subarray(0, bytesRead))
    }
    const after = await file.stat({ bigint: true })
    need(BigInt(offset) === before.size && before.size === after.size && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs && hash.digest('hex') === expected.sha256, 'Replay asset bytes changed or differ from the receipt.')
    return { file, size: offset }
  } catch (error) { await file.close(); throw error }
}

function contentType(name) {
  return name.endsWith('.json') ? 'application/json' : name.endsWith('.yml') ? 'text/yaml'
    : name.endsWith('.atom') ? 'application/atom+xml' : 'application/octet-stream'
}

function errorResponse(status) {
  const body = Buffer.from(`Replay request refused (${status}).\n`)
  return { status, headers: { 'content-type': 'text/plain', 'content-length': String(body.length), 'cache-control': 'no-store' },
    body, dispose: async () => {} }
}

export function parseReplayRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false }
  need(typeof value === 'string', 'Invalid replay byte range.')
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  need(match && (match[1] || match[2]), 'Only a single byte range is supported.')
  let start, end
  if (!match[1]) {
    const suffix = Number(match[2])
    need(Number.isSafeInteger(suffix) && suffix > 0, 'Invalid suffix byte range.')
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1
    need(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start,
      'Unsatisfiable byte range.')
    end = Math.min(end, size - 1)
  }
  return { start, end, partial: true }
}

/** Verifies inputs offline. publicKey is an explicit fixture-only library seam;
 * the CLI always uses the committed production trust root. No acceptance result
 * is produced by successful replay construction or by serving a response. */
export async function createProductReplay({ receiptPath, acceptedReceiptSha256, preparationRunPath,
  serverDirectory, desktopDirectory, publicKey }) {
  const bytes = await regular(receiptPath)
  need(/^[a-f0-9]{64}$/.test(acceptedReceiptSha256) && digest(bytes) === acceptedReceiptSha256,
    'Replay receipt differs from the independently accepted SHA-256.')
  const receipt = JSON.parse(bytes)
  await directory(serverDirectory); await directory(desktopDirectory)
  verifyReceiptBundle(receipt, serverDirectory, publicKey)
  validatePreparationRun(JSON.parse(await regular(preparationRunPath)), receipt)
  need(await verifyAssets(desktopDirectory, receipt.version, receipt.track, { ...receipt, coordinatedUpdates: true, publicKey })
    === receipt.desktopManifestSha256, 'Replay desktop checksum manifest differs from the product receipt.')
  for (const name of ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']) {
    need((await regular(join(desktopDirectory, name))).equals(await regular(join(serverDirectory, 'npm', name))),
      'Desktop and server signed descriptor bytes differ.')
  }
  // Rebind the actual buffers used to select routes, not just earlier reads by
  // the validators; replacing metadata between those reads must fail closed.
  const npm = JSON.parse(await readReplayMetadata(join(serverDirectory, 'npm/agents-server-npm-manifest.json'), receipt.npmManifestSha256))
  const legacy = JSON.parse(await readReplayMetadata(join(serverDirectory, 'legacy/agents-server-manifest.json'), receipt.legacyManifestSha256))
  const inventory = JSON.parse(await readReplayMetadata(join(serverDirectory, 'product-server-bundle.json'), receipt.serverBundleSha256))
  const sums = new Map((await readReplayMetadata(join(desktopDirectory, 'SHA256SUMS'), receipt.desktopManifestSha256)).toString('utf8').trimEnd()
    .split('\n').map(line => [line.slice(66), line.slice(0, 64)]))
  const routes = new Map()
  const add = (url, record) => { need(!routes.has(url), 'Duplicate replay route.'); routes.set(url, Object.freeze(record)) }
  const generated = (url, value, type) => {
    const body = Buffer.from(value)
    add(url, { body, size: body.length, sha256: digest(body), generated: true, contentType: type })
  }
  const asset = async (url, path, sha256) => {
    const checked = await verifiedFile(path, { sha256 })
    await checked.file.close()
    add(url, { path, sha256, size: checked.size, generated: false, contentType: contentType(path) })
  }
  const releaseDocument = repository => ({ tag_name: `v${receipt.version}`, name: `AgentsDock replay ${receipt.version}`,
    draft: false, prerelease: receipt.track === 'beta', html_url: `https://github.com/${repository}/releases/tag/v${receipt.version}`,
    // Discovery is explicitly synthetic. It is not evidence of public delivery.
    body: 'Disposable exact-artifact replay; not a published release.' })
  for (const repository of [...DESKTOP_REPOSITORIES, SERVER_REPOSITORY]) {
    const release = releaseDocument(repository)
    const root = `https://github.com/${repository}/releases`
    generated(`${root}.atom`, `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${root}</id><title>Disposable release replay</title><updated>2000-01-01T00:00:00Z</updated><entry><id>${release.html_url}</id><title>${receipt.version}</title><updated>2000-01-01T00:00:00Z</updated><link href="${release.html_url}"/><content type="text">Exact-artifact replay</content></entry></feed>`, 'application/atom+xml')
    generated(`https://api.github.com/repos/${repository}/releases?per_page=100`, JSON.stringify([release]), 'application/json')
    generated(`https://api.github.com/repos/${repository}/releases/tags/v${receipt.version}`, JSON.stringify(release), 'application/json')
    // Never manufacture a stable latest alias for a beta candidate.
    if (receipt.track === 'stable') {
      generated(`https://api.github.com/repos/${repository}/releases/latest`, JSON.stringify(release), 'application/json')
      // GitHubProvider requests this web endpoint with Accept: application/json.
      generated(`${root}/latest`, JSON.stringify(release), 'application/json')
    }
  }
  for (const repository of DESKTOP_REPOSITORIES) {
    for (const name of expectedAssets(receipt.version, receipt.track, true)) {
      const path = join(desktopDirectory, name), sha256 = name === 'SHA256SUMS' ? receipt.desktopManifestSha256 : sums.get(name)
      await asset(`https://github.com/${repository}/releases/download/v${receipt.version}/${name}`, path, sha256)
      if (receipt.track === 'stable') await asset(`https://github.com/${repository}/releases/latest/download/${name}`, path, sha256)
    }
  }
  for (const name of ['agents-server-manifest.json', 'agents-server-manifest.sig', legacy.archive.name]) {
    await asset(`https://github.com/${SERVER_REPOSITORY}/releases/download/v${receipt.version}/${name}`,
      join(serverDirectory, 'legacy', name), inventory.artifacts[`legacy/${name}`].sha256)
    if (receipt.track === 'stable') await asset(`https://github.com/${SERVER_REPOSITORY}/releases/latest/download/${name}`,
      join(serverDirectory, 'legacy', name), inventory.artifacts[`legacy/${name}`].sha256)
  }
  await asset(npm.archive.url, join(serverDirectory, 'npm', npm.archive.name), npm.archive.sha256)

  return Object.freeze({
    identity: Object.freeze({ version: receipt.version, track: receipt.track, sourceSha: receipt.sourceSha,
      prepareRunId: receipt.prepareRunId, releaseReceiptSha256: acceptedReceiptSha256, discovery: 'synthetic-replay-not-publication' }),
    inventory: () => [...routes].map(([url, entry]) => ({ url, size: entry.size, sha256: entry.sha256, generated: entry.generated })),
    async respond({ method, host, path, headers = {} }) {
      if (!['GET', 'HEAD'].includes(method)) return errorResponse(405)
      if (Object.entries(headers).some(([name, value]) => /^(authorization|proxy-authorization|cookie)$/i.test(name) && value)) return errorResponse(400)
      if (typeof host !== 'string' || !HOSTS.includes(host.replace(/:443$/, '')) || typeof path !== 'string'
        || !path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) return errorResponse(400)
      host = host.replace(/:443$/, '')
      // electron-updater6.8 uses base32 timestamps on GenericProvider YAML only.
      const cacheBuster = /^(\/[^?]+\.yml)\?noCache=[0-9a-v]{1,16}$/.exec(path)
      const entry = routes.get(`https://${host}${cacheBuster ? cacheBuster[1] : path}`)
      if (!entry) return errorResponse(404)
      let range
      try { range = parseReplayRange(headers.range, entry.size) }
      catch { return { ...errorResponse(416), headers: { ...errorResponse(416).headers, 'content-range': `bytes */${entry.size}` } } }
      let opened
      if (!entry.generated) opened = await verifiedFile(entry.path, entry)
      else need(digest(entry.body) === entry.sha256, 'Generated replay discovery changed.')
      const responseHeaders = { 'content-type': entry.contentType, 'content-length': String(range.end - range.start + 1),
        'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-agentsdock-replay': 'test-only' }
      if (range.partial) responseHeaders['content-range'] = `bytes ${range.start}-${range.end}/${entry.size}`
      if (method === 'HEAD') {
        await opened?.file.close()
        return { status: range.partial ? 206 : 200, headers: responseHeaders, body: Buffer.alloc(0), dispose: async () => {} }
      }
      const body = opened ? opened.file.createReadStream({ start: range.start, end: range.end, autoClose: true })
        : Buffer.from(entry.body.subarray(range.start, range.end + 1))
      return { status: range.partial ? 206 : 200, headers: responseHeaders, body,
        dispose: async () => { if (opened) { body.destroy(); await opened.file.close() } } }
    }
  })
}

export function assertReplayRunner(env = process.env, platform = process.platform) {
  need(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock'
    && ((platform === 'darwin' && env.RUNNER_OS === 'macOS') || (platform === 'linux' && env.RUNNER_OS === 'Linux'))
    && /^ZhengyiLuo\/AgentsDock\/\.github\/workflows\/product-release-acceptance\.yml@refs\/heads\/(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(env.GITHUB_WORKFLOW_REF ?? '')
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && isAbsolute(env.RUNNER_TEMP ?? '') && resolve(env.RUNNER_TEMP) !== '/',
  'TLS replay is restricted to the canonical acceptance workflow on disposable hosted runners.')
}

async function insideRunner(path) {
  const root = await realpath(process.env.RUNNER_TEMP), actual = await realpath(path), part = relative(root, actual)
  need(root !== '/' && part && !part.startsWith('..') && !isAbsolute(part), 'TLS replay inputs must be inside RUNNER_TEMP.')
  return actual
}

// No DNS, trust-store or packet-routing changes are made here. An independently
// reviewed disposable-runner setup must route the three HTTPS origins to this
// listener and trust its ephemeral certificate. Never run that setup locally.
export async function serveProductReplay(replay, { certificatePath, privateKeyPath, port = 443 }) {
  assertReplayRunner()
  need(replay.identity.sourceSha === process.env.GITHUB_SHA, 'Replay must run at the exact accepted product source.')
  need(Number.isInteger(port) && port >= 1 && port <= 65535, 'Invalid replay listener port.')
  await insideRunner(certificatePath); await insideRunner(privateKeyPath)
  need(((await lstat(privateKeyPath)).mode & 0o077) === 0, 'Ephemeral TLS key permissions must be private.')
  const cert = await regular(certificatePath, 16384), key = await regular(privateKeyPath, 16384)
  const x509 = new X509Certificate(cert)
  need(!x509.ca && Date.parse(x509.validFrom) <= Date.now() && Date.parse(x509.validTo) > Date.now()
    && HOSTS.every(host => x509.checkHost(host, { wildcards: false }) === host), 'Ephemeral certificate must cover every exact replay hostname.')
  need(createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(x509.publicKey.export({ type: 'spki', format: 'der' })), 'Ephemeral TLS key does not match its certificate.')
  const context = createSecureContext({ cert, key })
  const server = createServer({ cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 16384,
    SNICallback: (host, done) => done(HOSTS.includes(host) ? null : new Error('Replay SNI refused.'), context) }, async (request, response) => {
    let result
    try {
      need(request.socket.servername === request.headers.host?.replace(/:443$/, ''), 'Replay SNI and Host differ.')
      result = await replay.respond({ method: request.method, host: request.headers.host, path: request.url, headers: request.headers })
      response.writeHead(result.status, result.headers)
      if (Buffer.isBuffer(result.body)) response.end(result.body)
      else await pipeline(result.body, response)
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'content-length': '0', 'cache-control': 'no-store' })
      response.end()
    } finally { await result?.dispose() }
  })
  server.on('connect', (_request, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  return server
}

export function parseReplayArguments(argv) {
  const [operation, ...args] = argv
  need(['inspect', 'serve'].includes(operation), 'Usage: product-release-replay.mjs inspect|serve --receipt PATH --receipt-sha256 SHA256 --prepare-run PATH --server-assets DIR --desktop-assets DIR [--certificate PATH --private-key PATH --port NUMBER]')
  const required = ['--receipt', '--receipt-sha256', '--prepare-run', '--server-assets', '--desktop-assets']
  const allowed = operation === 'serve' ? [...required, '--certificate', '--private-key', '--port'] : required
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    need(allowed.includes(args[i]) && args[i + 1] && options[args[i]] === undefined, 'Unknown, incomplete or duplicate replay argument.')
    options[args[i]] = args[i + 1]
  }
  need(required.every(name => options[name]), 'Missing replay artifact inputs.')
  if (operation === 'serve') need(options['--certificate'] && options['--private-key'], 'Ephemeral replay certificate and private key are required.')
  return { operation, options }
}

async function main() {
  const { operation, options } = parseReplayArguments(process.argv.slice(2))
  if (operation === 'serve') {
    assertReplayRunner()
    for (const name of ['--receipt', '--prepare-run', '--server-assets', '--desktop-assets']) await insideRunner(options[name])
  }
  const replay = await createProductReplay({ receiptPath: options['--receipt'], acceptedReceiptSha256: options['--receipt-sha256'],
    preparationRunPath: options['--prepare-run'], serverDirectory: options['--server-assets'], desktopDirectory: options['--desktop-assets'] })
  if (operation === 'inspect') process.stdout.write(`${JSON.stringify({ ...replay.identity, routes: replay.inventory() }, null, 2)}\n`)
  else {
    const server = await serveProductReplay(replay, { certificatePath: options['--certificate'], privateKeyPath: options['--private-key'],
      port: options['--port'] === undefined ? 443 : Number(options['--port']) })
    process.stdout.write(`${JSON.stringify({ ...replay.identity, listening: '127.0.0.1', port: server.address().port })}\n`)
    const close = () => { server.closeAllConnections(); server.close() }
    process.once('SIGTERM', close); process.once('SIGINT', close)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Exact-artifact replay failed; verify inputs and disposable-runner prerequisites. No acceptance result was produced.\n'); process.exitCode = 1 })
}
