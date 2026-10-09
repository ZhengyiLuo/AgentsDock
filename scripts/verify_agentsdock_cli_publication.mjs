#!/usr/bin/env node
// Read-only CLI publication gates. Never install, rebuild, publish, or change tags.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDescriptor } from './stage_coordinated_release.mjs'
import { verifyArchiveBytes as verifyRuntimeBytes, verifyRegistry as verifyRuntimeRegistry } from './verify_npm_publication.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org'
const RECEIPT = 'agentsdock-cli-receipt.json'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const FILES = ['package.json', 'cli.cjs', 'postinstall.cjs', 'README.md', 'LICENSE', 'NOTICE']
const MAX_CLI = 4 * 1024 * 1024
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const integrity = bytes => `sha512-${digest(bytes, 'sha512', 'base64')}`
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = value => JSON.stringify(value, (_, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const same = (a, b) => canonical(a) === canonical(b)

function readRegular(filename, limit) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('CLI publication inputs must be bounded regular files.')
    const bytes = readFileSync(fd)
    if (bytes.length > limit) throw new Error('CLI publication input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

function sourceFile(sourceRoot, sourceSHA, filename) {
  const args = ['--no-replace-objects', '-C', sourceRoot]
  const entry = execFileSync('git', [...args, 'ls-tree', sourceSHA, '--', filename], { encoding: 'utf8', timeout: 30000 })
  if (!new RegExp(`^100(?:644|755) blob [a-f0-9]{40}\\t${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`).test(entry)) {
    throw new Error(`Reviewed source must contain a regular file: ${filename}`)
  }
  return execFileSync('git', [...args, 'show', `${sourceSHA}:${filename}`], { maxBuffer: 1024 * 1024, timeout: 30000 })
}

function inspectArchive(bytes) {
  // Inspect the already-hashed bytes, not a second path read. No extraction or
  // package execution; bound decompressed members as well as compressed input.
  const program = `import base64, gzip, io, json, sys, tarfile
expected = {"package/" + name for name in ${JSON.stringify(FILES)}}
result = {}
with gzip.GzipFile(fileobj=io.BytesIO(sys.stdin.buffer.read())) as compressed:
    data = compressed.read(8 * 1024 * 1024 + 1)
if len(data) > 8 * 1024 * 1024:
    raise ValueError("CLI archive expands beyond its size limit")
with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
    for member in archive:
        if member.name not in expected or member.name in result or not member.isfile():
            raise ValueError("CLI archive has an unexpected, duplicate or non-regular member")
        # The packager copies fixed-mode payloads but creates package.json with
        # the invoking umask: both normal 022 and private 077 are supported.
        modes = (0o755,) if member.name == "package/cli.cjs" else (0o644,)
        if member.name == "package/package.json":
            modes = (0o600, 0o644)
        if member.mode not in modes or member.size > 1048576:
            raise ValueError("CLI archive member has unsafe permissions or size")
        result[member.name] = base64.b64encode(archive.extractfile(member).read()).decode("ascii")
if set(result) != expected:
    raise ValueError("CLI archive does not contain the exact six-file allowlist")
print(json.dumps(result))
`
  try {
    return JSON.parse(execFileSync('python3', ['-c', program], { input: bytes, encoding: 'utf8', maxBuffer: 9 * 1024 * 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }))
  } catch { throw new Error('CLI archive failed its exact file allowlist, regular-file, permissions or size checks.') }
}

function expectedMetadata(source, version) {
  const keys = ['name', 'version', 'private', 'description', 'license', 'repository', 'bin', 'engines', 'os', 'files', 'scripts', 'dependencies', 'publishConfig']
  if (!same(Object.keys(source).sort(), keys.sort()) || source.name !== 'agentsdock' || source.version !== '0.0.0-development' || source.private !== true ||
      !same(source.bin, { agentsdock: 'cli.cjs' }) || !same(source.dependencies, { '@agentsdock/server': '0.0.0-development' }) ||
      !same(source.scripts, { postinstall: 'node postinstall.cjs' }) ||
      !same(source.repository, { type: 'git', url: 'git+https://github.com/ZhengyiLuo/AgentsDock.git', directory: 'server/npm/agentsdock' }) ||
      !same(source.publishConfig, { access: 'public', registry: `${REGISTRY}/` }) ||
      !same(source.files, FILES.slice(1))) throw new Error('CLI source has an unreviewed identity, dependency, hook, or packaging setting.')
  const metadata = { ...source, version, dependencies: { '@agentsdock/server': version } }
  delete metadata.private
  return metadata
}

function verifyCliBytes(bytes, receipt) {
  if (bytes.length !== receipt.archive.size || digest(bytes) !== receipt.archive.sha256 || integrity(bytes) !== receipt.archive.integrity) {
    throw new Error('CLI archive bytes differ from the accepted checksum receipt.')
  }
}

export function validateCandidate({ directory, version, sourceSHA, acceptedReceiptSHA256, runtimeDirectory, acceptedManifestSHA256, expectedLatest, expectedRuntimeLatest, sourceRoot = ROOT }) {
  if (!VERSION.test(version) || !/^[a-f0-9]{40}$/.test(sourceSHA) || !/^[a-f0-9]{64}$/.test(acceptedReceiptSHA256) || !/^[a-f0-9]{64}$/.test(acceptedManifestSHA256)) {
    throw new Error('Explicit version, reviewed source, accepted receipt and accepted runtime manifest hashes are required.')
  }
  if (expectedLatest !== 'absent' && (!VERSION.test(expectedLatest) || expectedLatest.includes('-'))) {
    throw new Error('Provide the pre-publication latest baseline: a stable version or absent.')
  }
  if (expectedRuntimeLatest !== undefined && (!VERSION.test(expectedRuntimeLatest) || expectedRuntimeLatest.includes('-'))) {
    throw new Error('Runtime latest baseline must be an explicit stable version.')
  }
  const readSource = filename => sourceFile(sourceRoot, sourceSHA, filename)
  if (readSource('server/VERSION').toString('utf8').trim() !== version) throw new Error('CLI version differs from the committed server VERSION.')
  const receiptBytes = readRegular(join(directory, RECEIPT), 8192)
  if (digest(receiptBytes) !== acceptedReceiptSHA256) throw new Error('CLI receipt differs from its accepted hash.')
  const receipt = JSON.parse(receiptBytes)
  const archiveName = `agentsdock-${version}.tgz`
  if (!record(receipt.archive) || !Number.isSafeInteger(receipt.archive.size) || receipt.archive.size < 1 || receipt.archive.size > MAX_CLI ||
      !/^[a-f0-9]{64}$/.test(receipt.archive.sha256) || typeof receipt.archive.integrity !== 'string' ||
      !same(receipt, { schema: 1, name: 'agentsdock', version, commit: sourceSHA, runtime: { name: '@agentsdock/server', version },
        archive: { name: archiveName, sha256: receipt.archive.sha256, integrity: receipt.archive.integrity, size: receipt.archive.size } })) {
    throw new Error('CLI receipt identity, source, runtime pin or archive metadata is invalid.')
  }
  const archive = resolve(directory, archiveName)
  const bytes = readRegular(archive, MAX_CLI)
  verifyCliBytes(bytes, receipt)
  const contents = inspectArchive(bytes)
  const metadata = expectedMetadata(JSON.parse(readSource('server/npm/agentsdock/package.json')), version)
  if (!same(JSON.parse(Buffer.from(contents['package/package.json'], 'base64')), metadata)) throw new Error('CLI package metadata differs from reviewed stamped source.')
  for (const name of FILES.slice(1)) {
    const source = ['LICENSE', 'NOTICE'].includes(name) ? name : `server/npm/agentsdock/${name}`
    if (!Buffer.from(contents[`package/${name}`], 'base64').equals(readSource(source))) throw new Error(`CLI packaged ${name} differs from exact committed source bytes.`)
  }
  const manifest = readRegular(join(runtimeDirectory, 'agents-server-npm-manifest.json'), 8192)
  if (digest(manifest) !== acceptedManifestSHA256) throw new Error('Runtime descriptor differs from the accepted manifest hash.')
  const descriptor = validateDescriptor(manifest, readRegular(join(runtimeDirectory, 'agents-server-npm-manifest.sig'), 64), readSource('server/release-public-key.pem'), version)
  if (descriptor.commit !== sourceSHA) throw new Error('Signed runtime and CLI must share the reviewed source commit.')
  verifyRuntimeBytes(readRegular(join(runtimeDirectory, descriptor.archive.name), 200 * 1024 * 1024), descriptor)
  return { receipt, archive, metadata, descriptor, version, sourceSHA, acceptedReceiptSHA256, acceptedManifestSHA256,
    distTag: version.includes('-') ? 'beta' : 'latest', expectedLatest: expectedLatest === 'absent' ? null : expectedLatest,
    ...(expectedRuntimeLatest === undefined ? {} : { expectedRuntimeLatest }),
    archiveURL: `${REGISTRY}/agentsdock/-/${archiveName}` }
}

async function requestBytes(url, limit, fetchImpl, allowMissing = false) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json' } })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`CLI registry request failed (${response.status}).`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('CLI registry response exceeds its size limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function packument(fetchImpl, allowMissing = false) {
  const bytes = await requestBytes(`${REGISTRY}/agentsdock`, 4 * 1024 * 1024, fetchImpl, allowMissing)
  if (bytes === null) return null
  const metadata = JSON.parse(bytes)
  if (metadata.name !== 'agentsdock' || !record(metadata.versions) || !record(metadata['dist-tags'])) throw new Error('CLI registry returned invalid package metadata.')
  return metadata
}

function advances(candidate, current) {
  const parts = value => {
    const match = VERSION.exec(value)
    if (!match) throw new Error('CLI registry tag has an unsupported version; review it before publishing.')
    return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] === undefined ? null : BigInt(match[4])]
  }
  const next = parts(candidate), previous = parts(current)
  for (let index = 0; index < 3; index++) if (next[index] !== previous[index]) return next[index] > previous[index]
  return next[3] !== previous[3] && (next[3] === null || (previous[3] !== null && next[3] > previous[3]))
}

function checkLatest(candidate, metadata) {
  if ((metadata?.['dist-tags'].latest ?? null) !== candidate.expectedLatest) throw new Error('CLI latest tag differs from the explicit pre-publication baseline; no tag will be changed.')
}

function publishedMetadata(candidate, metadata) {
  const version = metadata.versions[candidate.version]
  // Registry metadata drives dependency resolution before npm opens the
  // tarball. In particular optionalDependencies can shadow dependencies, so
  // matching the archive alone cannot establish the exact runtime pin.
  const resolverFields = ['dependencies', 'scripts', 'bin', 'engines', 'os', 'cpu', 'libc',
    'optionalDependencies', 'acceptDependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies',
    'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'dependenciesMeta',
    'workspaces', 'pnpm', 'packageManager', 'engineStrict', 'devEngines', 'gypfile', 'installConfig',
    'exports', 'imports', 'main', 'type', 'directories', 'config']
  if (!version || version.name !== 'agentsdock' || version.version !== candidate.version ||
      resolverFields.some(key => Object.hasOwn(version, key) !== Object.hasOwn(candidate.metadata, key) || !same(version[key], candidate.metadata[key])) ||
      // npm can add these derived fields. The exact allowlist has no shrinkwrap
      // and the reviewed package does have a postinstall hook.
      (Object.hasOwn(version, '_hasShrinkwrap') && version._hasShrinkwrap !== false) ||
      (Object.hasOwn(version, 'hasInstallScript') && version.hasInstallScript !== true) ||
      version.dist?.integrity !== candidate.receipt.archive.integrity || version.dist?.tarball !== candidate.archiveURL) {
    throw new Error('Published CLI metadata differs from the accepted package or is missing.')
  }
  if (metadata['dist-tags'][candidate.distTag] !== candidate.version) throw new Error('CLI dist-tag does not select the accepted version; no tag will be changed.')
  if (candidate.distTag === 'beta') checkLatest(candidate, metadata)
}

async function verifyPublished(candidate, metadata, fetchImpl) {
  publishedMetadata(candidate, metadata)
  verifyCliBytes(await requestBytes(candidate.archiveURL, candidate.receipt.archive.size, fetchImpl), candidate.receipt)
}

export async function publicationPreflight(candidate, { fetchImpl = fetch } = {}) {
  // Publishing a facade before its exact signed dependency is public is unsafe.
  await verifyRuntimeRegistry(candidate, { fetchImpl })
  const metadata = await packument(fetchImpl, true)
  const result = { publish: true, firstPublication: metadata === null, ownershipVerified: false,
    version: candidate.version, distTag: candidate.distTag, archive: candidate.archive, expectedLatest: candidate.expectedLatest }
  if (metadata && Object.hasOwn(metadata.versions, candidate.version)) {
    await verifyPublished(candidate, metadata, fetchImpl)
    return { ...result, publish: false }
  }
  checkLatest(candidate, metadata)
  const current = metadata?.['dist-tags'][candidate.distTag]
  if ((current !== undefined && !advances(candidate.version, current)) || (candidate.expectedLatest !== null && !advances(candidate.version, candidate.expectedLatest))) {
    throw new Error('Refusing to move a CLI channel backward or publish a beta superseded by latest.')
  }
  // A 404 is not ownership evidence; npm authentication/name rights and native
  // acceptance remain separate publication requirements, outside this verifier.
  return result
}

export async function verifyRegistry(candidate, { fetchImpl = fetch } = {}) {
  await verifyRuntimeRegistry(candidate, { fetchImpl })
  await verifyPublished(candidate, await packument(fetchImpl), fetchImpl)
  return { version: candidate.version, distTag: candidate.distTag, integrity: candidate.receipt.archive.integrity,
    verified: true, runtimeVerified: true, ...(candidate.distTag === 'beta' ? { latestPreserved: true, latest: candidate.expectedLatest } : {}) }
}

async function main() {
  const [operation, directory, version, sourceSHA, acceptedReceiptSHA256, runtimeDirectory, acceptedManifestSHA256, expectedLatest] = process.argv.slice(2)
  if (!['inspect', 'preflight', 'verify'].includes(operation) || process.argv.length !== 10) {
    throw new Error('Usage: verify_agentsdock_cli_publication.mjs inspect|preflight|verify CLI_DIRECTORY VERSION SOURCE_SHA ACCEPTED_RECEIPT_SHA256 RUNTIME_DIRECTORY ACCEPTED_MANIFEST_SHA256 EXPECTED_LATEST_OR_absent')
  }
  const candidate = validateCandidate({ directory, version, sourceSHA, acceptedReceiptSHA256, runtimeDirectory, acceptedManifestSHA256, expectedLatest,
    expectedRuntimeLatest: process.env.EXPECTED_NPM_LATEST })
  const result = operation === 'inspect'
    ? { version, sourceSHA, archive: candidate.archive, distTag: candidate.distTag, acceptedReceiptSHA256, acceptedManifestSHA256, expectedLatest: candidate.expectedLatest, registryVerified: false }
    : operation === 'preflight' ? await publicationPreflight(candidate) : await verifyRegistry(candidate)
  // JSON stdout only: no GITHUB_OUTPUT/summary writes or credential inspection.
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
