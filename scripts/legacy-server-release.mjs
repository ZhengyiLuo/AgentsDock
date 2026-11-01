#!/usr/bin/env node
// Exact legacy compatibility handoff only. Never export/push source, rebuild,
// replace assets, sign descriptors, or publish npm from this helper.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GitHubClient } from './direct-release-mirror.mjs'
import { verifyNpmCandidate } from './npm-candidate-release.mjs'
import { verifyLegacyBridge, verifyPublishedServerPaths, verifyRegistryPayload } from './coordinated-release.mjs'
import { validateElectronReleaseVersion } from './validate_electron_release_version.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRIMARY = 'ZhengyiLuo/AgentsDock'
export const LEGACY_REPOSITORY = 'ZhengyiLuo/AgentsServer'
export const LEGACY_METADATA = ['agents-server-manifest.json', 'agents-server-manifest.sig']
const SHA = /^[a-f0-9]{40}$/
const need = (condition, message) => { if (!condition) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function identity(options) {
  validateElectronReleaseVersion(options.version, options.track, [])
  need(SHA.test(options.sourceSha) && SHA.test(options.exportSha), 'Explicit canonical and standalone export commit SHAs are required.')
  need(/^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(options.sourceRef) && !options.sourceRef.includes('..') && !options.sourceRef.includes('//') && !/[/.]$/.test(options.sourceRef) && !options.sourceRef.split('/').some(part => part.endsWith('.lock')), 'Source must be main or a reviewed release branch.')
  need(options.acceptedManifestSha256 === undefined || /^[a-f0-9]{64}$/.test(options.acceptedManifestSha256), 'Accepted npm descriptor hash must be a full SHA-256.')
}

function regular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Legacy inputs must be bounded regular files.')
    const bytes = readFileSync(fd)
    need(bytes.length <= limit, 'Legacy input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

export async function verifyLegacyCandidate(options, { publicKey, execute = execFileSync } = {}) {
  identity(options)
  const npm = await verifyNpmCandidate(options.npmAssets, options, publicKey)
  if (options.acceptedManifestSha256 !== undefined) need(npm.manifestSha256 === options.acceptedManifestSha256, 'Npm descriptor differs from the accepted manifest hash.')
  const bytes = regular(join(options.assets, LEGACY_METADATA[0]), 8192)
  const signature = regular(join(options.assets, LEGACY_METADATA[1]), 64)
  const legacy = verifyLegacyBridge(bytes, signature, npm.manifest, publicKey)
  need(legacy.commit === options.sourceSha, 'Legacy descriptor must pin the canonical product source, not its export commit.')
  const names = [...LEGACY_METADATA, legacy.archive.name].sort()
  need(JSON.stringify((await readdir(options.assets)).sort()) === JSON.stringify(names), 'Legacy release must contain exactly three signed bundle assets.')
  for (const name of names) need((await lstat(join(options.assets, name))).isFile(), 'Legacy release assets must be regular files.')
  const archivePath = join(options.assets, legacy.archive.name)
  const archive = regular(archivePath, 200 * 1024 * 1024)
  need(archive.length === legacy.archive.size && hash(archive) === legacy.archive.sha256, 'Legacy archive differs from its signed size or hash.')
  let parity
  try {
    parity = JSON.parse(execute('python3', [join(ROOT, 'scripts/verify_server_runtime_parity.py'), join(options.npmAssets, npm.manifest.archive.name), archivePath, options.version], { encoding: 'utf8', timeout: 60000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch { throw new Error('Legacy archive runtime does not match the signed npm runtime.') }
  need(parity.identical === true && parity.version === options.version, 'Legacy runtime parity was not confirmed.')
  return { npm, legacy, names, assetSha256: { [LEGACY_METADATA[0]]: hash(bytes), [LEGACY_METADATA[1]]: hash(signature), [legacy.archive.name]: hash(archive) }, legacyManifestSha256: hash(bytes), runtimeFiles: parity.runtime_files }
}

// Exporting is a separate, authorized operation. A caller can obtain exportSha
// with prepare_server_export.py, push that fast-forward export, then call us.
// Never point an AgentsServer tag at a canonical SHA absent from that repository.
export function verifyExportSource(options, { client = new GitHubClient(), execute = execFileSync, repositoryDirectory = ROOT } = {}) {
  identity(options)
  const git = (...args) => {
    try { return execute('git', ['-C', repositoryDirectory, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
    catch { throw new Error('The reviewed canonical source and server subtree must be present locally.') }
  }
  need(git('rev-parse', '--verify', '--end-of-options', `${options.sourceSha}^{commit}`) === options.sourceSha, 'Local canonical source identity differs.')
  const rootTree = git('rev-parse', `${options.sourceSha}^{tree}`)
  const serverTree = git('rev-parse', `${options.sourceSha}:server`)
  need(SHA.test(rootTree) && SHA.test(serverTree) && git('cat-file', '-t', serverTree) === 'tree', 'Canonical server subtree is invalid.')
  const canonical = client.optional(`repos/${PRIMARY}/git/commits/${options.sourceSha}`)
  need(canonical?.sha === options.sourceSha && canonical.tree?.sha === rootTree, 'Canonical source is not the exact public commit.')
  const ancestry = client.optional(`repos/${PRIMARY}/compare/${options.sourceSha}...${encodeURIComponent(options.sourceRef)}`)
  need(['ahead', 'identical'].includes(ancestry?.status) && ancestry.merge_base_commit?.sha === options.sourceSha, 'Canonical source is not on the reviewed public branch.')
  const exported = client.optional(`repos/${LEGACY_REPOSITORY}/git/commits/${options.exportSha}`)
  need(exported?.sha === options.exportSha && exported.tree?.sha === serverTree, 'Standalone export must already exist publicly with the exact canonical server tree.')
  return { sourceSha: options.sourceSha, exportSha: options.exportSha, serverTree }
}

function verifyTag(client, options, release) {
  const tag = `v${options.version}`
  if (release) need(release.target_commitish === options.exportSha, 'Legacy release target differs from the reviewed standalone export.')
  let object = client.optional(`repos/${LEGACY_REPOSITORY}/git/ref/tags/${tag}`)?.object
  need(!release || release.draft || object, 'Published legacy release has no source tag.')
  const hadTag = Boolean(object)
  for (let count = 0; object?.type === 'tag' && count < 5; count++) object = client.optional(`repos/${LEGACY_REPOSITORY}/git/tags/${object.sha}`)?.object
  need(!hadTag || (object?.type === 'commit' && object.sha === options.exportSha), 'Legacy tag differs from the reviewed standalone export; refusing to move it.')
}

function fields(options, verified) {
  return { 'Release type': 'canonical-server-compatibility-v1', 'Source repository': PRIMARY, 'Source commit': options.sourceSha, 'Source ref': options.sourceRef, 'Standalone export commit': options.exportSha, 'Update track': options.track, 'Npm manifest SHA256': verified.npm.manifestSha256, 'Legacy manifest SHA256': verified.legacyManifestSha256 }
}

function verifyReleaseIdentity(release, options, verified) {
  need(release.tag_name === `v${options.version}` && typeof release.draft === 'boolean', 'Legacy release identity is invalid.')
  need(release.draft || release.prerelease === (options.track === 'beta'), 'Published legacy release has the wrong channel.')
  for (const [key, value] of Object.entries(fields(options, verified))) {
    const lines = String(release.body ?? '').split('\n').filter(line => line.startsWith(`${key}:`))
    need(lines.length === 1 && lines[0] === `${key}: ${value}`, 'Existing legacy release identity differs; refusing to overwrite.')
  }
  need(JSON.stringify((release.assets ?? []).map(asset => asset.name).sort()) === JSON.stringify(verified.names), 'Existing legacy release has an incomplete or conflicting asset set.')
}

export class LegacyServerRelease {
  constructor({ client = new GitHubClient(), publicKey, execute = execFileSync, repositoryDirectory = ROOT, registryVerifier = verifyRegistryPayload, publicationVerifier = verifyPublishedServerPaths } = {}) {
    Object.assign(this, { client, publicKey, execute, repositoryDirectory, registryVerifier, publicationVerifier })
  }

  async existing(options, verified) {
    const release = this.client.release(LEGACY_REPOSITORY, `v${options.version}`)
    verifyTag(this.client, options, release)
    if (!release) return null
    verifyReleaseIdentity(release, options, verified)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-legacy-release-'))
    try {
      this.client.download(LEGACY_REPOSITORY, release.tag_name, directory)
      const received = await verifyLegacyCandidate({ ...options, assets: directory }, this)
      need(JSON.stringify(received.assetSha256) === JSON.stringify(verified.assetSha256), 'Existing legacy release bytes differ; refusing to replace assets.')
    } finally { await rm(directory, { recursive: true, force: true }) }
    return release
  }

  checkVersion(options) {
    validateElectronReleaseVersion(options.version, options.track, this.client.history(LEGACY_REPOSITORY).filter(release => release.tag_name !== `v${options.version}`))
  }

  result(options, verified, release) {
    return { tag: `v${options.version}`, version: options.version, sourceSha: options.sourceSha, exportSha: options.exportSha, npmManifestSha256: verified.npm.manifestSha256, legacyManifestSha256: verified.legacyManifestSha256, published: !release.draft }
  }

  async inspect(options) {
    const verified = await verifyLegacyCandidate(options, this)
    verifyExportSource(options, this)
    const release = await this.existing(options, verified)
    need(release, 'Exact legacy release draft is missing; stage the original accepted bytes first.')
    this.checkVersion(options)
    return this.result(options, verified, release)
  }

  async stage(options) {
    const verified = await verifyLegacyCandidate(options, this)
    verifyExportSource(options, this)
    let release = await this.existing(options, verified)
    this.checkVersion(options)
    if (!release) {
      const body = `Signed compatibility distribution of the canonical AgentsDock server.\n\n${Object.entries(fields(options, verified)).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`
      this.client.run(['release', 'create', `v${options.version}`, ...verified.names.map(name => join(options.assets, name)), '--repo', LEGACY_REPOSITORY, '--draft', '--prerelease', '--latest=false', '--target', options.exportSha, '--title', `AgentsServer ${options.version}`, '--notes', body])
      release = await this.existing(options, verified)
      need(release, 'Created legacy release draft could not be verified.')
    }
    return this.result(options, verified, release)
  }

  async publish(options) {
    need(/^[a-f0-9]{64}$/.test(options.acceptedManifestSha256 ?? ''), 'Legacy publication requires the accepted npm descriptor hash.')
    const verified = await verifyLegacyCandidate(options, this)
    verifyExportSource(options, this)
    let release = await this.existing(options, verified)
    need(release, 'Exact legacy release draft is missing; publication never creates or repairs it.')
    this.checkVersion(options)
    await this.registryVerifier(verified.npm.manifest)
    // Re-read the sealed draft after the registry request, immediately before
    // the only publication write. A retry never rebuilds or replaces anything.
    release = await this.existing(options, verified)
    need(release, 'Accepted legacy release disappeared before publication.')
    this.checkVersion(options)
    if (release.draft) this.client.publish(LEGACY_REPOSITORY, `v${options.version}`, options.track)
    release = await this.existing(options, verified)
    need(release && !release.draft, 'Legacy publication is incomplete; retry the same sealed release.')
    await this.publicationVerifier(verified.npm.manifest, { publicKey: this.publicKey })
    return this.result(options, verified, release)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    need(['stage', 'inspect', 'publish'].includes(command) && args.length % 2 === 0, 'Usage: legacy-server-release.mjs stage|inspect|publish --assets DIRECTORY --npm-assets DIRECTORY --version VERSION --track TRACK --source-sha SHA --source-ref REF --export-sha SHA [--accepted-manifest-sha256 SHA256]')
    const allowed = new Set(['assets', 'npm-assets', 'version', 'track', 'source-sha', 'source-ref', 'export-sha', 'accepted-manifest-sha256']), options = {}
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2), key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      need(args[index].startsWith('--') && allowed.has(name) && !(key in options) && args[index + 1], 'Invalid legacy release option.')
      options[key] = args[index + 1]
    }
    need(options.assets && options.npmAssets, 'Explicit legacy and npm asset directories are required.')
    options.assets = resolve(options.assets); options.npmAssets = resolve(options.npmAssets)
    const result = await new LegacyServerRelease()[command](options)
    process.stdout.write(`legacy_tag=${result.tag}\nlegacy_manifest_sha256=${result.legacyManifestSha256}\nnpm_manifest_sha256=${result.npmManifestSha256}\nsource_sha=${result.sourceSha}\nexport_sha=${result.exportSha}\npublished=${result.published}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
