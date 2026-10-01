#!/usr/bin/env node
// Test-only exact-artifact origin replay. This is not a proxy or acceptance proof.
// It never installs certificates, changes DNS, fetches URLs, or publishes assets.
import { createHash, createPublicKey, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, writeFile } from 'node:fs/promises'
import { createServer, request as httpsRequest } from 'node:https'
import { createSecureContext, checkServerIdentity } from 'node:tls'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { expectedAssets, verifyAssets } from './direct-release-mirror.mjs'
import { validatePreparationRun, verifyReceiptBundle } from './product-release.mjs'
import { assertCandidateCheckout, assertCandidateRunner, assertCandidateServerCheckout, assertCandidateServerRunner,
  candidateAssets, inspectCandidate, verifyBaselineDesktop } from './product-candidate-receipt.mjs'

const HOSTS = ['github.com', 'api.github.com', 'registry.npmjs.org']
const DESKTOP_REPOSITORIES = ['ZhengyiLuo/AgentsDock', 'ZhengyiLuo/AgentsDock-Releases']
const SERVER_REPOSITORY = 'ZhengyiLuo/AgentsServer'
const MAX_FILE = 2 * 1024 * 1024 * 1024
const MAX_METADATA = 32768
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const need = (condition, message) => { if (!condition) throw new Error(message) }

export function replayBaselineMetadata(baselineVersion, candidateVersion, candidate = false) {
  const parse = version => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(version)
    need(match, 'Invalid replay baseline or candidate version.')
    return [...match.slice(1, 4).map(Number), match[4] === undefined ? Infinity : Number(match[4])]
  }
  const a = parse(baselineVersion), b = parse(candidateVersion)
  const difference = a.findIndex((value, index) => value !== b[index])
  need(difference >= 0 && a[difference] < b[difference], 'Replay baseline must be strictly older than the candidate.')
  const beta = baselineVersion.includes('-beta.')
  need(!beta || (candidate && candidateVersion === '1.0.9' && baselineVersion === '1.0.8-beta.5'),
    'Beta desktop baseline requires the reviewed stable 1.0.9 journey.')
  if (candidate && candidateVersion === '1.0.9') need(['1.0.6', '1.0.8-beta.5'].includes(baselineVersion),
    'Stable candidate requires an independently pinned desktop baseline.')
  return { track: beta ? 'beta' : 'stable', metadata: `${beta ? 'beta' : 'latest'}-mac.yml`, prerelease: beta }
}
const STARTUP_STAGES = Object.freeze(['arguments', 'runner-guard', 'input-containment', 'artifact-verification',
  'checkout-verification', 'tls-input-validation', 'certificate-validation', 'tls-context', 'listener-bind',
  'drop-privileges', 'pid-write', 'serving'])
const STARTUP_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EADDRINUSE', 'EADDRNOTAVAIL',
  'EMFILE', 'ENFILE', 'ENOMEM', 'EPIPE', 'ERR_ASSERTION', 'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_UNSUPPORTED',
  'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'ERR_CRYPTO_INVALID_KEYTYPE', 'STARTUP_REJECTED'])

// No messages, subprocess output, paths, URLs, environment or request data may
// enter these records. They diagnose disposable test infrastructure, not product
// acceptance. The workflow must validate the complete bounded JSONL log before
// making any of it public.
export function parseReplayStartupDiagnostics(bytes) {
  need(typeof bytes === 'string' || Buffer.isBuffer(bytes), 'Invalid startup diagnostic input.')
  need(Buffer.byteLength(bytes) <= 32768, 'Startup diagnostic input exceeds its size limit.')
  const lines = bytes.toString().trim().split('\n')
  need(lines.length > 0 && lines.length <= STARTUP_STAGES.length + 1 && lines.every(Boolean), 'Invalid startup diagnostic record count.')
  let previous = -1, terminal = false
  return lines.map((line, index) => {
    const value = JSON.parse(line)
    need(value && typeof value === 'object' && !Array.isArray(value), 'Invalid startup diagnostic record.')
    const keys = ['schema', 'kind', 'sequence', 'stage', 'status', 'releaseAcceptance', ...(value.status === 'failed' ? ['code'] : [])]
    need(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()), 'Unexpected startup diagnostic field.')
    const stage = STARTUP_STAGES.indexOf(value.stage)
    need(value.schema === 1 && value.kind === 'replay-startup-diagnostic' && value.releaseAcceptance === false
      && value.sequence === index + 1 && !terminal && stage >= 0, 'Invalid startup diagnostic identity.')
    if (value.status === 'failed') {
      need(stage === previous && STARTUP_CODES.has(value.code), 'Invalid startup failure diagnostic.')
      terminal = true
    } else {
      need(stage > previous && (value.status === 'entered' && value.stage !== 'serving'
        || value.status === 'ready' && value.stage === 'serving'), 'Invalid startup phase transition.')
      previous = stage
      terminal = value.status === 'ready'
    }
    return value
  })
}

export function createReplayStartupDiagnostics(write) {
  let sequence = 0, previous = -1, terminal = false
  const emit = value => write(`${JSON.stringify({ schema: 1, kind: 'replay-startup-diagnostic',
    sequence: ++sequence, ...value, releaseAcceptance: false })}\n`)
  return Object.freeze({
    stage(name) {
      const position = STARTUP_STAGES.indexOf(name)
      need(!terminal && position > previous, 'Invalid startup phase transition.')
      previous = position
      terminal = name === 'serving'
      emit({ stage: name, status: terminal ? 'ready' : 'entered' })
    },
    failure(error) {
      if (terminal) return
      need(previous >= 0, 'Startup diagnostic requires an initial phase.')
      terminal = true
      emit({ stage: STARTUP_STAGES[previous], status: 'failed',
        code: STARTUP_CODES.has(error?.code) ? error.code : 'STARTUP_REJECTED' })
    }
  })
}

export function parseReplayProbeDiagnostics(bytes, headers) {
  need((typeof bytes === 'string' || Buffer.isBuffer(bytes)) && Buffer.byteLength(bytes) <= 128
    && (typeof headers === 'string' || Buffer.isBuffer(headers)) && Buffer.byteLength(headers) <= 32768,
  'Invalid or unbounded replay probe diagnostics.')
  const match = /^([0-9a-fA-F:.]{0,45})\|([0-9]{1,3})\|([0-9]{3})\n$/.exec(bytes.toString())
  need(match && (match[1] === '' || isIP(match[1])) && Number(match[2]) <= 255 && (Number(match[3]) === 0
    || Number(match[3]) >= 100 && Number(match[3]) <= 599), 'Invalid replay probe observations.')
  const text = headers.toString()
  need(!/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), 'Invalid replay response headers.')
  const lines = text.trimEnd() ? text.trimEnd().split(/\r?\n/) : []
  need(lines.length <= 128 && (lines.length === 0 && Number(match[3]) === 0
    || lines.length > 0 && /^HTTP\/[0-9.]+ [1-5][0-9]{2}(?: |$)/.test(lines[0])),
    'Invalid replay response status.')
  if (lines.length) need(Number(lines[0].split(' ')[1]) === Number(match[3]), 'Replay probe HTTP status differs.')
  const marker = []
  for (const line of lines.slice(1)) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line)
    need(header, 'Invalid replay response header.')
    if (header[1].toLowerCase() === 'x-agentsdock-replay') marker.push(header[2].trim())
  }
  return { remoteIp: match[1] || null, sslVerifyResult: Number(match[2]), httpCode: Number(match[3]),
    replayMarker: marker.length === 1 && marker[0] === 'test-only' }
}

const ORIGIN_PROBE_CODES = new Set(['VERIFIED', 'INPUT_REJECTED', 'CHAIN_REJECTED', 'DNS_NOT_LOOPBACK', 'TIMEOUT',
  'TLS_UNAUTHORIZED', 'PEER_NOT_LOOPBACK', 'LEAF_MISMATCH', 'RESPONSE_REJECTED', 'BODY_REJECTED', 'PROBE_FAILED',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'])

export function parseReplayOriginProbe(bytes) {
  need((typeof bytes === 'string' || Buffer.isBuffer(bytes)) && Buffer.byteLength(bytes) <= 2048,
    'Invalid or unbounded origin probe result.')
  const value = JSON.parse(bytes.toString())
  need(value && typeof value === 'object' && !Array.isArray(value), 'Invalid origin probe result.')
  const keys = ['kind', 'verified', 'code', ...(value.verified === true
    ? ['remoteIp', 'tlsAuthorized', 'leafMatched', 'httpCode', 'replayMarker', 'bodyBytes', 'bodySha256', 'leafSha256'] : [])]
  need(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()) && value.kind === 'replay-origin-probe'
    && typeof value.verified === 'boolean' && ORIGIN_PROBE_CODES.has(value.code), 'Invalid origin probe fields.')
  if (value.verified) need(value.code === 'VERIFIED' && value.remoteIp === '127.0.0.1' && value.tlsAuthorized === true
    && value.leafMatched === true && value.httpCode === 200 && value.replayMarker === true
    && Number.isSafeInteger(value.bodyBytes) && value.bodyBytes > 0 && value.bodyBytes <= 32768
    && /^[a-f0-9]{64}$/.test(value.bodySha256) && /^[a-f0-9]{64}$/.test(value.leafSha256), 'Invalid verified origin probe.')
  else need(value.code !== 'VERIFIED', 'Failed origin probe cannot claim verification.')
  return value
}

async function ownedProbeFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    need(stat.isFile() && stat.size > 0 && stat.size <= 16384 && stat.uid === process.getuid?.()
      && stat.uid > 0 && (stat.mode & 0o077) === 0, 'Probe certificate must be private and runner-owned.')
    const bytes = await file.readFile()
    need(bytes.length <= 16384, 'Probe certificate exceeded its size limit.')
    return bytes
  } finally { await file.close() }
}

// The workflow owns the hosted-runner guard. This library cannot reach another
// origin: real DNS must yield loopback first, TLS must authorize the fixed public
// hostname using the exact private test CA, and the served leaf is pinned too.
// Tests inject inert DNS/transport observations, not native runtime/CI hooks.
export async function probeReplayOrigin({ caPath, expectedLeafPath, serverOnly = false }, { lookup = dnsLookup, request = httpsRequest } = {}) {
  const failure = code => ({ kind: 'replay-origin-probe', verified: false,
    code: ORIGIN_PROBE_CODES.has(code) && code !== 'VERIFIED' ? code : 'PROBE_FAILED' })
  let caBytes, leaf, address
  try {
    need(typeof serverOnly === 'boolean', 'Probe scope must be explicit.')
    need([caPath, expectedLeafPath].every(path => typeof path === 'string' && isAbsolute(path)
      && !/[\r\n\0]/.test(path)) && dirname(caPath) === dirname(expectedLeafPath), 'Invalid probe input paths.')
    const work = await lstat(dirname(caPath))
    need(work.isDirectory() && work.uid === process.getuid?.() && work.uid > 0 && (work.mode & 0o077) === 0,
      'Probe certificates require a private runner-owned directory.')
    caBytes = await ownedProbeFile(caPath)
    const ca = new X509Certificate(caBytes)
    leaf = new X509Certificate(await ownedProbeFile(expectedLeafPath))
    if (!ca.ca || leaf.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)
      || leaf.checkHost('github.com', { wildcards: false }) !== 'github.com'
      || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()
      || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) return failure('CHAIN_REJECTED')
  } catch { return failure('INPUT_REJECTED') }
  const deadline = Date.now() + 10000
  let dnsTimer
  try {
    address = await Promise.race([lookup('github.com', { family: 4 }), new Promise((_, reject) => {
      dnsTimer = setTimeout(() => reject(Object.assign(new Error(), { code: 'TIMEOUT' })), 10000)
    })])
  } catch (error) { return failure(error?.code) }
  finally { clearTimeout(dnsTimer) }
  if (address?.address !== '127.0.0.1' || address.family !== 4) return failure('DNS_NOT_LOOPBACK')
  const leafSha256 = digest(leaf.raw)
  return new Promise(resolveProbe => {
    let settled = false, req, response
    const finish = value => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (!value.verified) { response?.destroy(); req?.destroy() }
      resolveProbe(value)
    }
    const timer = setTimeout(() => finish(failure('TIMEOUT')), Math.max(1, deadline - Date.now()))
    try {
      req = request(`https://github.com/ZhengyiLuo/${serverOnly ? 'AgentsServer' : 'AgentsDock'}/releases.atom`, {
        ca: caBytes, rejectUnauthorized: true, checkServerIdentity, servername: 'github.com', family: 4,
        autoSelectFamily: false, agent: false, headers: { Accept: 'application/atom+xml' },
        lookup: (host, _options, done) => host === 'github.com'
          ? done(null, address.address, address.family) : done(Object.assign(new Error(), { code: 'DNS_NOT_LOOPBACK' }))
      }, incoming => {
        try {
          response = incoming
          const socket = incoming.socket
          if (socket?.authorized !== true) return finish(failure('TLS_UNAUTHORIZED'))
          if (socket.remoteAddress !== '127.0.0.1') return finish(failure('PEER_NOT_LOOPBACK'))
          const peer = socket.getPeerCertificate()?.raw
          if (!Buffer.isBuffer(peer) || digest(peer) !== leafSha256) return finish(failure('LEAF_MISMATCH'))
          const markers = []
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            if (incoming.rawHeaders[index].toLowerCase() === 'x-agentsdock-replay') markers.push(incoming.rawHeaders[index + 1])
          }
          if (incoming.statusCode !== 200 || markers.length !== 1 || markers[0].trim() !== 'test-only') {
            return finish(failure('RESPONSE_REJECTED'))
          }
          let bodyBytes = 0
          const hash = createHash('sha256')
          incoming.on('data', chunk => {
            if (settled) return
            try {
              bodyBytes += chunk.length
              if (bodyBytes > 32768) return finish(failure('BODY_REJECTED'))
              hash.update(chunk)
            } catch { finish(failure('BODY_REJECTED')) }
          })
          incoming.once('error', error => finish(failure(error?.code)))
          incoming.once('aborted', () => finish(failure('ECONNRESET')))
          incoming.once('end', () => {
            if (settled) return
            if (!bodyBytes) return finish(failure('BODY_REJECTED'))
            finish({ kind: 'replay-origin-probe', verified: true, code: 'VERIFIED', remoteIp: '127.0.0.1',
              tlsAuthorized: true, leafMatched: true, httpCode: 200, replayMarker: true,
              bodyBytes, bodySha256: hash.digest('hex'), leafSha256 })
          })
        } catch { finish(failure('RESPONSE_REJECTED')) }
      })
      req.once('error', error => finish(failure(error?.code)))
      req.end()
    } catch (error) { finish(failure(error?.code)) }
  })
}

export async function assertReplayReadiness({ logPath, pidPath, nodeProbe }, { queryProcess = pid => execFileSync('/bin/ps',
  ['-p', String(pid), '-o', 'pid=', '-o', 'uid=', '-o', 'command='],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  need([logPath, pidPath].every(path => typeof path === 'string'
    && isAbsolute(path) && dirname(path) === dirname(logPath) && !/[\r\n\0]/.test(path)), 'Invalid replay readiness paths.')
  const work = await lstat(dirname(logPath))
  need(work.isDirectory() && work.uid === process.getuid?.() && work.uid > 0 && (work.mode & 0o077) === 0,
    'Replay readiness files must share a private runner-owned work directory.')
  const probe = parseReplayOriginProbe(JSON.stringify(nodeProbe))
  need(probe.verified,
    'Replay HTTPS probe did not reach the authenticated loopback replay origin.')
  const records = parseReplayStartupDiagnostics(await regular(logPath, 32768))
  need(records.at(-1)?.stage === 'serving' && records.at(-1)?.status === 'ready', 'Replay startup has not completed.')
  const file = await open(pidPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let pid
  try {
    const stat = await file.stat()
    need(stat.isFile() && stat.size <= 32 && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()
      && stat.uid > 0, 'Replay PID file must be private and owned by the non-root runner.')
    const text = await file.readFile('utf8')
    need(/^[1-9][0-9]{0,9}\n$/.test(text), 'Invalid replay PID identity.')
    pid = Number(text.trim())
  } finally { await file.close() }
  const output = await queryProcess(pid)
  need(typeof output === 'string' && Buffer.byteLength(output) <= 8192, 'Invalid replay process observation.')
  const match = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\n?$/.exec(output)
  need(match && Number(match[1]) === pid && Number(match[2]) === process.getuid?.(), 'Replay process identity differs.')
  const command = match[3]
  need([`scripts/product-release-replay.mjs`, fileURLToPath(import.meta.url)]
    .some(script => command.startsWith(`${process.execPath} ${script} serve `))
    && command.split(/\s+/).filter(token => token === '--pid-file').length === 1
    && command.includes(` --pid-file ${pidPath}`)
    && command.split(` --pid-file ${pidPath}`)[1].match(/^(?:\s|$)/)
    && command.includes(` --private-key ${join(dirname(pidPath), 'leaf.key')} `),
  'Replay process is not the expected owned listener.')
  return { ready: true, pid }
}

// Unit tests inject only this completion callback and an inert server-shaped
// object. Native serving still uses the real privilege drop and PID write.
export async function finalizeReplayListener(server, initialize) {
  try { await initialize() }
  catch (error) {
    try { server.closeAllConnections() }
    finally { await new Promise(done => server.close(done)) }
    throw error
  }
  return server
}

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
  serverDirectory, desktopDirectory, baselineDesktopDirectory, baselineVersion, publicKey }) {
  return createReplay({ receiptPath, acceptedReceiptSha256, preparationRunPath, serverDirectory, desktopDirectory,
    baselineDesktopDirectory, baselineVersion, publicKey }, false)
}

export async function createCandidateReplay(options) { return createReplay(options, true) }
export async function createCandidateServerReplay(options) { return createReplay(options, true, true) }

async function createReplay({ receiptPath, acceptedReceiptSha256, preparationRunPath,
  serverDirectory, desktopDirectory, baselineDesktopDirectory, baselineVersion, publicKey }, candidate, serverOnly = false) {
  need(!serverOnly || (!baselineDesktopDirectory && !baselineVersion), 'Server-only replay cannot select or serve a desktop baseline.')
  const bytes = await regular(receiptPath)
  need(/^[a-f0-9]{64}$/.test(acceptedReceiptSha256) && digest(bytes) === acceptedReceiptSha256,
    'Replay receipt differs from the independently accepted SHA-256.')
  const receipt = JSON.parse(bytes)
  await directory(serverDirectory); await directory(desktopDirectory)
  if (candidate) {
    await inspectCandidate({ receiptPath, receiptSha256: acceptedReceiptSha256, serverDirectory, desktopDirectory, publicKey })
  } else {
    verifyReceiptBundle(receipt, serverDirectory, publicKey)
    validatePreparationRun(JSON.parse(await regular(preparationRunPath)), receipt)
    need(await verifyAssets(desktopDirectory, receipt.version, receipt.track, { ...receipt, coordinatedUpdates: true, publicKey })
      === receipt.desktopManifestSha256, 'Replay desktop checksum manifest differs from the product receipt.')
  }
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
  let baselineSums, baselineMetadata
  if (baselineDesktopDirectory || baselineVersion) {
    need(baselineDesktopDirectory && baselineVersion, 'Replay baseline requires its directory and explicit version.')
    baselineMetadata = replayBaselineMetadata(baselineVersion, receipt.version, candidate)
    await directory(baselineDesktopDirectory)
    if (candidate && receipt.version === '1.0.9') await verifyBaselineDesktop(
      baselineVersion === '1.0.6' ? 'stable108' : 'beta1085', baselineDesktopDirectory, receipt.version)
    const bytes = await regular(join(baselineDesktopDirectory, 'SHA256SUMS'))
    const lines = bytes.toString('utf8').trimEnd().split('\n')
    need(lines.every(line => /^[a-f0-9]{64}  [A-Za-z0-9._-]+$/.test(line)), 'Invalid baseline checksum manifest.')
    baselineSums = new Map(lines.map(line => [line.slice(66), line.slice(0, 64)]))
    need(baselineSums.size === lines.length, 'Duplicate baseline asset checksum.')
    for (const name of [`AgentsDock-${baselineVersion}-mac-universal.zip`, baselineMetadata.metadata]) {
      need(baselineSums.has(name), 'Baseline updater metadata or ZIP is missing its checksum.')
      const file = await verifiedFile(join(baselineDesktopDirectory, name), { sha256: baselineSums.get(name) })
      await file.file.close()
    }
    const yaml = (await regular(join(baselineDesktopDirectory, baselineMetadata.metadata))).toString('utf8')
    need(yaml.split('\n').includes(`version: ${baselineVersion}`), 'Baseline channel metadata has the wrong version.')
  }
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
  for (const repository of [...(serverOnly ? [] : DESKTOP_REPOSITORIES), SERVER_REPOSITORY]) {
    const release = releaseDocument(repository)
    const root = `https://github.com/${repository}/releases`
    const baseline = baselineSums && DESKTOP_REPOSITORIES.includes(repository)
      ? { tag_name: `v${baselineVersion}`, name: `AgentsDock ${baselineVersion}`, draft: false, prerelease: baselineMetadata.prerelease,
        html_url: `${root}/tag/v${baselineVersion}`, body: 'Previously published baseline; disposable replay.' } : null
    const releases = [release, ...(baseline ? [baseline] : [])]
    const entries = releases.map(item => `<entry><id>${item.html_url}</id><title>${item.tag_name.slice(1)}</title><updated>2000-01-01T00:00:00Z</updated><link href="${item.html_url}"/><content type="text">Exact-artifact replay</content></entry>`).join('')
    generated(`${root}.atom`, `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${root}</id><title>Disposable release replay</title><updated>2000-01-01T00:00:00Z</updated>${entries}</feed>`, 'application/atom+xml')
    generated(`https://api.github.com/repos/${repository}/releases?per_page=100`, JSON.stringify(releases), 'application/json')
    generated(`https://api.github.com/repos/${repository}/releases/tags/v${receipt.version}`, JSON.stringify(release), 'application/json')
    // Never manufacture a stable latest alias for a beta candidate.
    if (receipt.track === 'stable') {
      generated(`https://api.github.com/repos/${repository}/releases/latest`, JSON.stringify(release), 'application/json')
      // GitHubProvider requests this web endpoint with Accept: application/json.
      generated(`${root}/latest`, JSON.stringify(release), 'application/json')
    } else if (baseline && !baseline.prerelease) {
      generated(`https://api.github.com/repos/${repository}/releases/latest`, JSON.stringify(baseline), 'application/json')
      generated(`${root}/latest`, JSON.stringify(baseline), 'application/json')
    }
    if (baseline) generated(`https://api.github.com/repos/${repository}/releases/tags/v${baselineVersion}`, JSON.stringify(baseline), 'application/json')
  }
  for (const repository of serverOnly ? [] : DESKTOP_REPOSITORIES) {
    for (const name of candidate ? candidateAssets(receipt.version, receipt.track) : expectedAssets(receipt.version, receipt.track, true)) {
      const path = join(desktopDirectory, name), sha256 = name === 'SHA256SUMS' ? receipt.desktopManifestSha256 : sums.get(name)
      await asset(`https://github.com/${repository}/releases/download/v${receipt.version}/${name}`, path, sha256)
      if (receipt.track === 'stable') await asset(`https://github.com/${repository}/releases/latest/download/${name}`, path, sha256)
    }
    if (baselineSums) {
      for (const name of [`AgentsDock-${baselineVersion}-mac-universal.zip`, baselineMetadata.metadata]) {
        await asset(`https://github.com/${repository}/releases/download/v${baselineVersion}/${name}`,
          join(baselineDesktopDirectory, name), baselineSums.get(name))
        if (receipt.track === 'beta' && !baselineMetadata.prerelease) await asset(`https://github.com/${repository}/releases/latest/download/${name}`,
          join(baselineDesktopDirectory, name), baselineSums.get(name))
      }
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
      ...(candidate ? { kind: serverOnly ? 'candidate-server-linux' : 'candidate', publicationEligible: false, sourceRef: receipt.sourceRef,
        ...(serverOnly ? { desktopAcceptance: false } : {}) } : { prepareRunId: receipt.prepareRunId }),
      releaseReceiptSha256: acceptedReceiptSha256, discovery: 'synthetic-replay-not-publication' }),
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
export async function serveProductReplay(replay, { certificatePath, privateKeyPath, port = 443,
  faultControlPath, faultObservedPath, pidPath, diagnostics }) {
  diagnostics?.stage('checkout-verification')
  if (replay.identity.kind === 'candidate-server-linux') assertCandidateServerCheckout(replay.identity)
  else if (replay.identity.kind === 'candidate') assertCandidateCheckout(replay.identity)
  else {
    assertReplayRunner()
    need(replay.identity.sourceSha === process.env.GITHUB_SHA, 'Replay must run at the exact accepted product source.')
  }
  diagnostics?.stage('tls-input-validation')
  need(Number.isInteger(port) && port >= 1 && port <= 65535, 'Invalid replay listener port.')
  await insideRunner(certificatePath); await insideRunner(privateKeyPath)
  const keyStat = await lstat(privateKeyPath)
  need((keyStat.mode & 0o077) === 0, 'Ephemeral TLS key permissions must be private.')
  need(Boolean(faultControlPath) === Boolean(faultObservedPath), 'Both one-shot fault paths are required.')
  for (const path of [faultControlPath, faultObservedPath, pidPath].filter(Boolean)) {
    await insideRunner(dirname(path))
    need(isAbsolute(path), 'Replay control paths must be absolute.')
  }
  const cert = await regular(certificatePath, 16384), key = await regular(privateKeyPath, 16384)
  diagnostics?.stage('certificate-validation')
  const x509 = new X509Certificate(cert)
  need(!x509.ca && Date.parse(x509.validFrom) <= Date.now() && Date.parse(x509.validTo) > Date.now()
    && HOSTS.every(host => x509.checkHost(host, { wildcards: false }) === host), 'Ephemeral certificate must cover every exact replay hostname.')
  need(createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(x509.publicKey.export({ type: 'spki', format: 'der' })), 'Ephemeral TLS key does not match its certificate.')
  diagnostics?.stage('tls-context')
  const context = createSecureContext({ cert, key })
  let ready = false
  const server = createServer({ cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 16384,
    SNICallback: (host, done) => done(HOSTS.includes(host) ? null : new Error('Replay SNI refused.'), context) }, async (request, response) => {
    let result
    try {
      need(ready, 'Replay startup has not completed.')
      need(request.socket.servername === request.headers.host?.replace(/:443$/, ''), 'Replay SNI and Host differ.')
      result = await replay.respond({ method: request.method, host: request.headers.host, path: request.url, headers: request.headers })
      const fault = faultControlPath && request.method === 'GET' && result.status === 200
        && !request.headers.range && await consumeReplayFault(replay, faultControlPath, request.headers.host, request.url)
      response.writeHead(result.status, result.headers)
      if (fault) {
        const totalBytes = Number(result.headers['content-length']), limit = Math.max(1, Math.floor(totalBytes / 2))
        let offered = 0
        for await (const chunk of result.body) {
          const bytes = chunk.subarray(0, Math.min(chunk.length, limit - offered))
          response.write(bytes); offered += bytes.length
          if (offered >= limit) break
        }
        response.destroy()
        need(offered > 0 && offered < totalBytes, 'Fault did not interrupt an incomplete body.')
        await writeFile(faultObservedPath, `${JSON.stringify({ schema: 1, kind: 'truncate-legacy-once',
          sourceSha: replay.identity.sourceSha, releaseReceiptSha256: replay.identity.releaseReceiptSha256,
          archiveSha256: fault.sha256, interrupted: true, socketDestroyed: true, bytesOffered: offered, totalBytes })}\n`,
        { flag: 'wx', mode: 0o600 })
        return
      }
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
  diagnostics?.stage('listener-bind')
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  // Only binding the privileged port needs root. All request processing and
  // one-shot fault observations run as the disposable runner account.
  return finalizeReplayListener(server, async () => {
    diagnostics?.stage('drop-privileges')
    if (process.getuid?.() === 0) {
      need(keyStat.uid > 0 && keyStat.gid > 0, 'Root listener must drop to the ephemeral key owner.')
      process.setgroups([])
      process.setgid(keyStat.gid); process.setuid(keyStat.uid)
    }
    diagnostics?.stage('pid-write')
    if (pidPath) await writeFile(pidPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    ready = true
    diagnostics?.stage('serving')
  })
}

export async function consumeReplayFault(replay, controlPath, host, path,
  { statControl = lstat, readControl = regular } = {}) {
  if (host !== 'github.com') return null
  const entry = replay.inventory().find(item => item.url === `https://${host}${path}` && !item.generated
    && item.url.startsWith(`https://github.com/${SERVER_REPOSITORY}/releases/download/v${replay.identity.version}/`)
    && item.url.endsWith('.tar.gz'))
  if (!entry) return null
  let stat
  try { stat = await statControl(controlPath) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  need(stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid(), 'Fault control must be a private owned regular file.')
  let controlBytes
  try { controlBytes = await readControl(controlPath) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const control = JSON.parse(controlBytes)
  need(control.schema === 1 && control.kind === 'truncate-legacy-once' && control.sourceSha === replay.identity.sourceSha
    && control.releaseReceiptSha256 === replay.identity.releaseReceiptSha256, 'Fault control belongs to another prepared product.')
  // Rename is the one-shot admission lock. Concurrent downloads cannot both
  // consume the same control file. It never modifies signed package bytes.
  let alreadyConsumed = false
  try { await statControl(`${controlPath}.consumed`); alreadyConsumed = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (alreadyConsumed) {
    // Another admitted request can rename the control after this request read
    // it. That loser must serve normally, not inject a second HTTP failure.
    // A newly rearmed control beside the marker still fails closed.
    try { await statControl(controlPath) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    throw new Error('One-shot fault was already consumed.')
  }
  try { await rename(controlPath, `${controlPath}.consumed`) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return entry
}

export function parseReplayArguments(argv) {
  const [operation, ...args] = argv
  need(['inspect', 'serve'].includes(operation), 'Usage: product-release-replay.mjs inspect|serve --receipt PATH --receipt-sha256 SHA256 --prepare-run PATH --server-assets DIR --desktop-assets DIR [--certificate PATH --private-key PATH --port NUMBER]')
  const required = ['--receipt', '--receipt-sha256', '--prepare-run', '--server-assets', '--desktop-assets']
  const common = [...required, '--baseline-desktop', '--baseline-version', '--scope']
  const allowed = operation === 'serve' ? [...common, '--certificate', '--private-key', '--port', '--pid-file', '--fault-control', '--fault-observed'] : common
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    need(allowed.includes(args[i]) && args[i + 1] && options[args[i]] === undefined, 'Unknown, incomplete or duplicate replay argument.')
    options[args[i]] = args[i + 1]
  }
  need(required.filter(name => !(['candidate', 'candidate-server-linux'].includes(options['--scope']) && name === '--prepare-run')).every(name => options[name]), 'Missing replay artifact inputs.')
  need(options['--scope'] === undefined || ['candidate', 'candidate-server-linux'].includes(options['--scope']), 'Unknown replay scope.')
  need(options['--scope'] !== 'candidate-server-linux' || (!options['--baseline-desktop'] && !options['--baseline-version']
    && !options['--fault-control'] && !options['--fault-observed']), 'Server-only replay excludes desktop baseline and transfer faults.')
  need(Boolean(options['--baseline-desktop']) === Boolean(options['--baseline-version']), 'Baseline directory and version must be supplied together.')
  need(Boolean(options['--fault-control']) === Boolean(options['--fault-observed']), 'Both one-shot fault paths are required.')
  if (operation === 'serve') need(options['--certificate'] && options['--private-key'], 'Ephemeral replay certificate and private key are required.')
  return { operation, options }
}

async function main(diagnostics) {
  const { operation, options } = parseReplayArguments(process.argv.slice(2))
  if (operation === 'serve') {
    diagnostics?.stage('runner-guard')
    if (options['--scope'] === 'candidate-server-linux') assertCandidateServerRunner()
    else if (options['--scope'] === 'candidate') assertCandidateRunner()
    else assertReplayRunner()
    diagnostics?.stage('input-containment')
    for (const name of ['--receipt', '--prepare-run', '--server-assets', '--desktop-assets']) if (options[name]) await insideRunner(options[name])
    if (options['--baseline-desktop']) await insideRunner(options['--baseline-desktop'])
  }
  diagnostics?.stage('artifact-verification')
  const factory = options['--scope'] === 'candidate-server-linux' ? createCandidateServerReplay
    : options['--scope'] === 'candidate' ? createCandidateReplay : createProductReplay
  const replay = await factory({ receiptPath: options['--receipt'], acceptedReceiptSha256: options['--receipt-sha256'],
    preparationRunPath: options['--prepare-run'], serverDirectory: options['--server-assets'], desktopDirectory: options['--desktop-assets'],
    baselineDesktopDirectory: options['--baseline-desktop'], baselineVersion: options['--baseline-version'] })
  if (operation === 'inspect') process.stdout.write(`${JSON.stringify({ ...replay.identity, routes: replay.inventory() }, null, 2)}\n`)
  else {
    const server = await serveProductReplay(replay, { certificatePath: options['--certificate'], privateKeyPath: options['--private-key'],
      port: options['--port'] === undefined ? 443 : Number(options['--port']), pidPath: options['--pid-file'],
      faultControlPath: options['--fault-control'], faultObservedPath: options['--fault-observed'], diagnostics })
    const close = () => { server.closeAllConnections(); server.close() }
    process.once('SIGTERM', close); process.once('SIGINT', close)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const diagnostics = process.argv[2] === 'serve' ? createReplayStartupDiagnostics(line => process.stdout.write(line)) : undefined
  diagnostics?.stage('arguments')
  main(diagnostics).catch(error => {
    if (diagnostics) diagnostics.failure(error)
    else process.stderr.write('Exact-artifact replay failed; verify inputs and disposable-runner prerequisites. No acceptance result was produced.\n')
    process.exitCode = 1
  })
}
