#!/usr/bin/env node
// Public signed metadata only. Never reads npm credentials or publishes packages.
import { execFileSync } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const COORDINATED_ASSETS = ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ARCHIVE = 200 * 1024 * 1024
const need = (condition, message) => { if (!condition) throw new Error(message) }

function regular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size <= limit, 'Coordinated input must be a bounded regular file.')
    const bytes = readFileSync(fd)
    need(bytes.length <= limit, 'Coordinated input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

export function verifyCoordinatedBytes(bytes, signature, { version, track, sourceSha, publicKey = regular(join(ROOT, 'server/release-public-key.pem'), 4096) }) {
  need(bytes.length > 0 && bytes.length <= 8192 && signature.length === 64, 'Invalid coordinated descriptor or signature size.')
  const key = createPublicKey(publicKey)
  need(key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signature), 'Invalid coordinated release signature.')
  const value = JSON.parse(bytes.toString('utf8'))
  need(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version), 'Invalid coordinated release version.')
  need(value.schema === 2 && value.distribution === 'npm' && value.version === version && value.track === track && value.prerelease === (track === 'beta') && (version.includes('-') ? 'beta' : 'stable') === track, 'Coordinated app/server version or track differs.')
  need(/^[a-f0-9]{40}$/.test(sourceSha) && value.commit === sourceSha, 'Coordinated server source differs from the pinned app source.')
  need(Number.isSafeInteger(value.minimum_server_api_contract) && value.minimum_server_api_contract >= 1 && Number.isSafeInteger(value.api_contract_version) && value.api_contract_version >= value.minimum_server_api_contract, 'Invalid coordinated API compatibility metadata.')
  need(value.npm?.name === '@agentsdock/server' && value.npm?.version === version && typeof value.npm?.integrity === 'string' && value.npm.integrity.startsWith('sha512-'), 'Invalid coordinated npm identity.')
  const integrity = Buffer.from(value.npm.integrity.slice(7), 'base64')
  need(integrity.length === 64 && `sha512-${integrity.toString('base64')}` === value.npm.integrity, 'Invalid coordinated npm integrity.')
  const name = `server-${version}.tgz`
  need(value.archive?.name === name && value.archive?.url === `https://registry.npmjs.org/@agentsdock/server/-/${name}` && /^[a-f0-9]{64}$/.test(value.archive?.sha256) && Number.isSafeInteger(value.archive?.size) && value.archive.size > 0 && value.archive.size <= MAX_ARCHIVE, 'Invalid coordinated npm archive identity.')
  return value
}

export function verifyCoordinatedDirectory(directory, identity) {
  return verifyCoordinatedBytes(regular(join(directory, COORDINATED_ASSETS[0]), 8192), regular(join(directory, COORDINATED_ASSETS[1]), 64), identity)
}

// Read exact tarball bytes; npm metadata and dist-tags cannot authorize a release.
export async function verifyRegistryPayload(value, fetchImpl = fetch, archivePath) {
  const response = await fetchImpl(value.archive.url, { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Accept: 'application/octet-stream' } })
  need(response.ok && response.body, 'The signed npm package is not publicly available. Publish and verify it before exposing the desktop release.')
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  let size = 0
  const reader = response.body.getReader()
  const destination = archivePath ? await open(archivePath, 'wx', 0o600) : null
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      need(size <= value.archive.size && size <= MAX_ARCHIVE, 'Published npm payload exceeds the signed size.')
      sha256.update(chunk.value); sha512.update(chunk.value)
      if (destination) await destination.writeFile(chunk.value)
    }
    need(size === value.archive.size && sha256.digest('hex') === value.archive.sha256 && `sha512-${sha512.digest('base64')}` === value.npm.integrity, 'Published npm payload differs from the signed descriptor.')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await destination?.close() }
}

// GitHub public assets redirect to its HTTPS asset CDN. No credentials are sent.
async function publicGitHubResponse(url, fetchImpl) {
  let current = url
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(current)
    need(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname), 'Standalone bridge redirected outside trusted public GitHub asset hosts.')
    const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(60000), headers: { Accept: 'application/octet-stream' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      need(location && redirects < 4, 'Standalone bridge redirect is invalid.')
      current = new URL(location, current).href
      continue
    }
    need(response.ok && response.body, 'The signed standalone bridge is not publicly available. Publish it before the desktop release.')
    return response
  }
  throw new Error('Standalone bridge redirect limit exceeded.')
}

async function publicGitHubBytes(url, limit, fetchImpl, archivePath) {
  const response = await publicGitHubResponse(url, fetchImpl)
  const reader = response.body.getReader(), chunks = [], hash = createHash('sha256')
  const destination = archivePath ? await open(archivePath, 'wx', 0o600) : null
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      need(size <= limit, 'Standalone bridge asset exceeds its signed bounds.')
      hash.update(part.value)
      if (destination) await destination.writeFile(part.value)
      else chunks.push(part.value)
    }
    return archivePath ? { size, sha256: hash.digest('hex') } : Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await destination?.close() }
}

export function verifyLegacyBridge(bytes, signature, npmManifest, publicKey = regular(join(ROOT, 'server/release-public-key.pem'), 4096)) {
  need(bytes.length > 0 && bytes.length <= 8192 && signature.length === 64, 'Invalid standalone bridge descriptor size.')
  const key = createPublicKey(publicKey)
  need(key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signature), 'Invalid standalone bridge signature.')
  const value = JSON.parse(bytes.toString('utf8'))
  need(value.schema === 1 && value.version === npmManifest.version && value.track === npmManifest.track && value.prerelease === (npmManifest.track === 'beta') && value.api_contract_version === npmManifest.api_contract_version, 'Standalone bridge version, track or API contract differs from the paired npm release.')
  // Subtree exports have another commit ID. Signed runtime bytes below, rather
  // than repository-specific commit IDs, establish source continuity.
  need(/^[a-f0-9]{40}$/.test(value.commit), 'Standalone bridge source identity is invalid.')
  const name = `agents-server-${value.version}.tar.gz`
  need(value.archive?.name === name && value.archive?.url === `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${value.version}/${name}` && /^[a-f0-9]{64}$/.test(value.archive?.sha256) && Number.isSafeInteger(value.archive?.size) && value.archive.size > 0 && value.archive.size <= MAX_ARCHIVE, 'Standalone bridge archive identity is invalid.')
  return value
}

export async function verifyPublishedServerPaths(value, { fetchImpl = fetch, publicKey } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentsdock-published-servers-'))
  try {
    const npmArchive = join(directory, 'npm.tgz'), legacyArchive = join(directory, 'legacy.tar.gz')
    await verifyRegistryPayload(value, fetchImpl, npmArchive)
    const root = `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${value.version}/agents-server-manifest`
    const [bytes, signature] = await Promise.all([publicGitHubBytes(`${root}.json`, 8192, fetchImpl), publicGitHubBytes(`${root}.sig`, 64, fetchImpl)])
    const legacy = verifyLegacyBridge(bytes, signature, value, publicKey)
    const archive = await publicGitHubBytes(legacy.archive.url, legacy.archive.size, fetchImpl, legacyArchive)
    need(archive.size === legacy.archive.size && archive.sha256 === legacy.archive.sha256, 'Standalone bridge archive differs from its signed size or hash.')
    let parity
    try {
      parity = JSON.parse(execFileSync('python3', [join(ROOT, 'scripts/verify_server_runtime_parity.py'), npmArchive, legacyArchive, value.version], { encoding: 'utf8', timeout: 60000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch { throw new Error('Standalone bridge runtime does not match the signed npm runtime, or archive parity verification could not complete.') }
    need(parity.identical === true && parity.version === value.version, 'Standalone bridge runtime parity was not confirmed.')
    return parity
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export function decodeCoordinatedInputs(manifestBase64, signatureBase64, identity, output) {
  if (!manifestBase64 && !signatureBase64) return false
  need(Boolean(manifestBase64) && Boolean(signatureBase64), 'Provide both signed coordinated descriptor inputs, or neither.')
  const decode = (text, maximum) => {
    need(typeof text === 'string' && text.length <= Math.ceil(maximum / 3) * 4, 'Coordinated base64 input exceeds its limit.')
    const bytes = Buffer.from(text, 'base64')
    need(bytes.toString('base64') === text, 'Coordinated inputs require canonical single-line base64.')
    return bytes
  }
  const bytes = decode(manifestBase64, 8192), signature = decode(signatureBase64, 64)
  const descriptor = verifyCoordinatedBytes(bytes, signature, identity)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, COORDINATED_ASSETS[0]), bytes, { flag: 'wx' })
  writeFileSync(join(output, COORDINATED_ASSETS[1]), signature, { flag: 'wx' })
  return descriptor
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory] = process.argv.slice(2)
    need(['prepare', 'verify'].includes(command) && directory && process.argv.length === 4, 'Usage: coordinated-release.mjs prepare|verify DIRECTORY')
    const identity = { version: process.env.RELEASE_VERSION, track: process.env.RELEASE_TRACK, sourceSha: process.env.SOURCE_SHA }
    const value = command === 'prepare'
      ? decodeCoordinatedInputs(process.env.COORDINATED_MANIFEST_BASE64, process.env.COORDINATED_SIGNATURE_BASE64, identity, resolve(directory))
      : verifyCoordinatedDirectory(resolve(directory), identity)
    process.stdout.write(`coordinated_updates=${Boolean(value)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
