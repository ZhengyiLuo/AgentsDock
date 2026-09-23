#!/usr/bin/env node
// Read-only publication gates. Only the manually protected workflow runs npm publish.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDescriptor } from './stage_coordinated_release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'agents-server-npm-manifest.json'
const SIGNATURE = 'agents-server-npm-manifest.sig'
const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE_URL = `${REGISTRY}/@agentsdock%2fserver`
const MAX_ARCHIVE = 200 * 1024 * 1024
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

function readRegular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Publication inputs must be bounded regular files.')
    const bytes = readFileSync(fd)
    if (bytes.length > limit) throw new Error('Publication input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

export function verifyArchiveBytes(bytes, descriptor) {
  if (bytes.length !== descriptor.archive.size || hash(bytes) !== descriptor.archive.sha256 || `sha512-${hash(bytes, 'sha512', 'base64')}` !== descriptor.npm.integrity) throw new Error('Archive bytes do not match the accepted signed descriptor.')
}

function readPackageMetadata(archive) {
  // Inspect in memory; never extract or execute package files. Reject duplicate
  // package metadata and links even if a mistakenly signed archive contains them.
  const program = `import json, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    names = [member.name for member in members]
    if len(names) != len(set(names)) or any(not m.isfile() or not m.name.startswith("package/") or ".." in m.name.split("/") for m in members):
        raise ValueError("package archive has duplicate, unsafe or non-regular members")
    member = archive.getmember("package/package.json")
    if member.size > 65536:
        raise ValueError("package metadata is too large")
    print(json.dumps(json.load(archive.extractfile(member))))
`
  return JSON.parse(execFileSync('python3', ['-c', program, archive], { encoding: 'utf8', maxBuffer: 65536, timeout: 30000 }))
}

export function validateCandidate({ directory, sourceSHA, acceptedManifestSHA256, appVersion, release, publicKey = readFileSync(join(ROOT, 'server/release-public-key.pem')) }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSHA) || !/^[a-f0-9]{64}$/.test(acceptedManifestSHA256)) throw new Error('Explicit reviewed source and accepted manifest hashes are required.')
  const manifest = readRegular(join(directory, MANIFEST), 8192)
  if (hash(manifest) !== acceptedManifestSHA256) throw new Error('Candidate descriptor differs from the accepted manifest hash.')
  const descriptor = validateDescriptor(manifest, readRegular(join(directory, SIGNATURE), 64), publicKey, appVersion)
  if (descriptor.commit !== sourceSHA) throw new Error('Candidate does not belong to the reviewed source commit.')
  const expectedAssets = [MANIFEST, SIGNATURE, descriptor.archive.name].sort()
  if (release.isDraft !== true || release.tagName !== `npm-candidate-v${appVersion}` || !Array.isArray(release.assets) || JSON.stringify(release.assets.map(asset => asset.name).sort()) !== JSON.stringify(expectedAssets)) throw new Error('Publication requires the separate npm candidate draft with exactly three signed bundle assets.')
  const archive = resolve(directory, descriptor.archive.name)
  verifyArchiveBytes(readRegular(archive, MAX_ARCHIVE), descriptor)
  const metadata = readPackageMetadata(archive)
  if (metadata.name !== descriptor.npm.name || metadata.version !== descriptor.version || metadata.private || metadata.repository?.url !== 'git+https://github.com/ZhengyiLuo/AgentsDock.git' || metadata.publishConfig?.registry !== `${REGISTRY}/` || metadata.publishConfig?.access !== 'public' || Object.keys(metadata.publishConfig).some(key => !['access', 'registry'].includes(key))) throw new Error('Package identity, repository or publication settings do not match the accepted release.')
  if (metadata.scripts || metadata.dependencies || metadata.optionalDependencies || metadata.peerDependencies || metadata.bundledDependencies || metadata.bundleDependencies) throw new Error('Server package must have no lifecycle scripts or npm dependencies.')
  return { descriptor, archive, distTag: descriptor.track === 'beta' ? 'beta' : 'latest', manifestSHA256: acceptedManifestSHA256 }
}

async function requestBytes(url, limit, fetchImpl, allowMissing = false) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json' } })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`Registry request failed (${response.status}).`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('Registry response exceeds its size limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function packument(fetchImpl) {
  const bytes = await requestBytes(PACKAGE_URL, 4 * 1024 * 1024, fetchImpl, true)
  if (!bytes) throw new Error('The npm package does not exist yet. First publish the accepted tarball interactively, then configure its trusted publisher.')
  const metadata = JSON.parse(bytes.toString('utf8'))
  if (metadata.name !== '@agentsdock/server' || !metadata.versions || !metadata['dist-tags']) throw new Error('Registry returned invalid package metadata.')
  return metadata
}

function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(version)
  if (!match) throw new Error('Registry dist-tag has an unsupported version; review it before publishing.')
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] === undefined ? null : BigInt(match[4])]
}

function advancesVersion(candidate, current) {
  const next = versionParts(candidate), previous = versionParts(current)
  for (let index = 0; index < 3; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index]
  }
  if (next[3] === previous[3]) return false
  return next[3] === null || (previous[3] !== null && next[3] > previous[3])
}

function verifyPublishedMetadata(candidate, metadata) {
  const { descriptor, distTag } = candidate
  const version = metadata.versions[descriptor.version]
  if (!version || version.name !== descriptor.npm.name || version.version !== descriptor.version || version.dist?.integrity !== descriptor.npm.integrity || version.dist?.tarball !== descriptor.archive.url) throw new Error('Published npm version differs from the accepted descriptor or is missing.')
  if (metadata['dist-tags'][distTag] !== descriptor.version) throw new Error('Published dist-tag does not select the accepted version; no tag will be changed automatically.')
}

export async function verifyRegistry(candidate, { fetchImpl = fetch } = {}) {
  verifyPublishedMetadata(candidate, await packument(fetchImpl))
  const archive = await requestBytes(candidate.descriptor.archive.url, candidate.descriptor.archive.size, fetchImpl)
  verifyArchiveBytes(archive, candidate.descriptor)
  return { version: candidate.descriptor.version, distTag: candidate.distTag, integrity: candidate.descriptor.npm.integrity, verified: true }
}

export async function publicationPreflight(candidate, { fetchImpl = fetch } = {}) {
  const metadata = await packument(fetchImpl)
  const version = candidate.descriptor.version
  if (Object.hasOwn(metadata.versions, version)) {
    // A retry after successful publication verifies identical bytes, and never
    // republishes an immutable version or silently moves a dist-tag backward.
    verifyPublishedMetadata(candidate, metadata)
    await verifyRegistry(candidate, { fetchImpl })
    return false
  }
  const current = metadata['dist-tags'][candidate.distTag]
  if (current !== undefined && !advancesVersion(version, current)) throw new Error('Refusing to move the npm dist-tag backward or overwrite its current version.')
  return true
}

async function main() {
  const [operation, directory, sourceSHA, acceptedManifestSHA256, releasePath] = process.argv.slice(2)
  if (!['inspect', 'preflight', 'verify'].includes(operation) || !releasePath || process.argv.length !== 7) throw new Error('Usage: verify_npm_publication.mjs inspect|preflight|verify DIRECTORY SOURCE_SHA ACCEPTED_MANIFEST_SHA256 DRAFT_RELEASE_JSON')
  const candidate = validateCandidate({ directory, sourceSHA, acceptedManifestSHA256, appVersion: readFileSync(join(ROOT, 'server/VERSION'), 'utf8').trim(), release: JSON.parse(readRegular(releasePath, 1024 * 1024)) })
  if (operation === 'inspect') {
    console.log(JSON.stringify({ version: candidate.descriptor.version, distTag: candidate.distTag, archive: candidate.archive, manifestSHA256: candidate.manifestSHA256 }))
  } else if (operation === 'preflight') {
    const publish = await publicationPreflight(candidate)
    if (!process.env.GITHUB_OUTPUT) throw new Error('Publication preflight requires a GitHub Actions output file.')
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\narchive=${candidate.archive}\ndist_tag=${candidate.distTag}\n`)
    console.log(JSON.stringify({ version: candidate.descriptor.version, distTag: candidate.distTag, publish, manifestSHA256: candidate.manifestSHA256 }))
  } else {
    const result = await verifyRegistry(candidate)
    console.log(JSON.stringify(result))
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Verified npm **@agentsdock/server@${result.version}** on **${result.distTag}** against accepted manifest \`${candidate.manifestSHA256}\`. No desktop release was published.\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
