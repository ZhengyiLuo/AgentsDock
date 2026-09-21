#!/usr/bin/env node

// Manual release automation. Never rebuild, replace, or repair existing assets.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, readdir, lstat, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateElectronReleaseVersion } from './validate_electron_release_version.mjs'
import { COORDINATED_ASSETS, verifyCoordinatedDirectory, verifyPublishedServerPaths } from './coordinated-release.mjs'

export const REPOSITORIES = ['ZhengyiLuo/AgentsDock', 'ZhengyiLuo/AgentsDock-Releases']
const PRIMARY = REPOSITORIES[0]

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function expectedAssets(version, track, coordinatedUpdates = false) {
  validateElectronReleaseVersion(version, track, [])
  const channel = track === 'beta' ? 'beta' : 'latest'
  return [
    `AgentsDock-${version}-linux-arm64.AppImage`,
    `AgentsDock-${version}-linux-arm64.tar.gz`,
    `AgentsDock-${version}-linux-x64.tar.gz`,
    `AgentsDock-${version}-linux-x86_64.AppImage`,
    `AgentsDock-${version}-mac-universal.dmg`,
    `AgentsDock-${version}-mac-universal.zip`,
    `AgentsDock-${version}-mac-universal.zip.blockmap`,
    `AgentsDock-${version}-win-x64.exe`,
    `AgentsDock-${version}-win-x64.exe.blockmap`,
    `${channel}-linux-arm64.yml`, `${channel}-linux.yml`,
    `${channel}-mac.yml`, `${channel}.yml`, 'SHA256SUMS', ...(coordinatedUpdates ? COORDINATED_ASSETS : [])
  ].sort()
}

function sameNames(actual, expected, message) {
  requireValue(JSON.stringify([...actual].sort()) === JSON.stringify(expected), message)
}

function sourceIdentity(identity) {
  requireValue(/^[0-9a-f]{40}$/.test(identity.sourceSha), 'A full lowercase source SHA is required.')
  requireValue(/^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(identity.sourceRef), 'Source must be main or a reviewed release branch.')
  requireValue(!identity.sourceRef.includes('..') && !identity.sourceRef.includes('//') &&
    !identity.sourceRef.endsWith('/') && !identity.sourceRef.endsWith('.') &&
    !identity.sourceRef.split('/').some(part => part.endsWith('.lock')), 'Invalid source branch.')
  requireValue(['signed', 'unsigned'].includes(identity.windowsSigning), 'Invalid Windows signing state.')
  return identity
}

export function releaseTag(repository, version, track, legacyTag = '') {
  requireValue(REPOSITORIES.includes(repository), 'Release tag repository is not an approved mirror.')
  requireValue(typeof legacyTag === 'string' && (!legacyTag || (legacyTag === '1.0.0' && version === '1.0.0' && track === 'stable')),
    'Legacy tag override is restricted to stable 1.0.0 using the exact tag 1.0.0.')
  // The deleted immutable legacy v1.0.0 cannot be reused. This explicit alias
  // changes only that mirror tag, never package/YAML versions or source identity.
  return repository === REPOSITORIES[1] && legacyTag ? legacyTag : `v${version}`
}

export function releaseIdentity(release, version, track, repository = PRIMARY, legacyTag = '') {
  requireValue(release.tag_name === releaseTag(repository, version, track, legacyTag), 'Release tag does not match the candidate.')
  const fields = {}
  for (const name of ['Source repository', 'Source commit', 'Source ref', 'Update track', 'Windows signing']) {
    const matches = String(release.body ?? '').split('\n').filter(line => line.startsWith(`${name}: `))
    requireValue(matches.length === 1, `Release must contain exactly one ${name} field.`)
    fields[name] = matches[0].slice(name.length + 2)
  }
  requireValue(fields['Source repository'] === PRIMARY, 'Release source is not the canonical public repository.')
  requireValue(fields['Update track'] === track, 'Release update track does not match.')
  requireValue(release.draft || release.prerelease === (track === 'beta'), 'Published release has the wrong prerelease state.')
  const enrollment = String(release.body ?? '').split('\n').filter(line => line.startsWith('Coordinated updates:'))
  requireValue(enrollment.length <= 1 && (!enrollment.length || enrollment[0] === 'Coordinated updates: npm-v1'), 'Invalid coordinated enrollment identity.')
  const coordinatedUpdates = enrollment.length === 1
  sameNames((release.assets ?? []).map(asset => asset.name), expectedAssets(version, track, coordinatedUpdates), 'Release has incomplete or conflicting assets; refusing to overwrite.')
  return sourceIdentity({ sourceSha: fields['Source commit'], sourceRef: fields['Source ref'], windowsSigning: fields['Windows signing'], coordinatedUpdates })
}

function matchIdentity(actual, expected) {
  if (expected.coordinatedUpdates !== undefined) requireValue(actual.coordinatedUpdates === expected.coordinatedUpdates, 'Release coordinated enrollment changed or conflicts.')
  for (const key of ['sourceSha', 'sourceRef', 'windowsSigning']) {
    if (expected[key]) requireValue(actual[key] === expected[key], `Release ${key} changed or conflicts.`)
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function readManifest(directory, version, track, coordinatedUpdates = false) {
  const names = expectedAssets(version, track, coordinatedUpdates)
  const manifestPath = join(directory, 'SHA256SUMS')
  const manifestStat = await lstat(manifestPath)
  requireValue(manifestStat.isFile() && manifestStat.size <= 16384, 'Checksum manifest must be a bounded regular file.')
  const checksums = new Map()
  for (const line of (await readFile(manifestPath, 'utf8')).trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64}) [ *]([^\r\n]+)$/.exec(line)
    requireValue(match && match[2] === basename(match[2]) && !checksums.has(match[2]), 'Checksum manifest has an unsafe or duplicate entry.')
    checksums.set(match[2], match[1])
  }
  sameNames([...checksums.keys()], names.filter(name => name !== 'SHA256SUMS'), 'Checksum manifest does not cover the exact asset set.')
  return { checksums, manifestSha256: await sha256(manifestPath) }
}

export async function verifyAssets(directory, version, track, identity = {}) {
  const names = expectedAssets(version, track, identity.coordinatedUpdates)
  sameNames(await readdir(directory), names, 'Downloaded/local release asset set is not exact.')
  for (const name of names) requireValue((await lstat(join(directory, name))).isFile(), 'Release assets must be regular files.')
  const { checksums, manifestSha256 } = await readManifest(directory, version, track, identity.coordinatedUpdates)
  for (const [name, checksum] of checksums) requireValue(await sha256(join(directory, name)) === checksum, `Checksum mismatch: ${name}`)
  if (identity.coordinatedUpdates) verifyCoordinatedDirectory(directory, { ...identity, version, track })
  return manifestSha256
}

export class GitHubClient {
  constructor(execute = execFileSync) { this.execute = execute }

  run(args) {
    // Tokens remain only in gh's inherited environment; never interpolate a shell.
    try { return this.execute('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) {
      // Classify only fixed labels and numeric statuses. gh stderr may contain
      // credentials, release notes, URLs or command arguments; never print it.
      const stderr = String(error.stderr ?? '')
      const httpStatus = /(?:HTTP\s+|\()([45]\d\d)\b/.exec(stderr)?.[1]
      const notFound = httpStatus === '404'
      const endpoint = args.find(argument => /^repos\//.test(argument)) ?? ''
      const repository = REPOSITORIES.find(repo => endpoint.startsWith(`repos/${repo}/`) || args[args.indexOf('--repo') + 1] === repo)
      let operation = 'request'
      if (args[0] === 'api') {
        operation = endpoint.includes('/releases/tags/') ? 'read release' :
          endpoint.includes('/releases?') ? 'list releases' :
            endpoint.includes('/git/') ? 'read source tag' : 'API request'
      } else if (args[0] === 'release') {
        operation = ({ create: 'create draft', download: 'download assets', edit: 'publish release' })[args[1]] ?? 'release request'
      }
      const details = []
      if (httpStatus) details.push(`HTTP ${httpStatus}`)
      if (Number.isSafeInteger(error.status)) details.push(`exit ${error.status}`)
      if (/unknown flag|unknown command|unrecognized (?:argument|option)/i.test(stderr)) details.push('unsupported gh CLI option')
      else if (/resource not accessible|permission|forbidden|authentication|bad credentials/i.test(stderr)) details.push('authorization denied')
      else if (/rate limit/i.test(stderr)) details.push('API rate limit')
      else if (/validation failed|unprocessable/i.test(stderr)) details.push('request validation failed')
      else if (/timed? ?out|timeout/i.test(stderr)) details.push('network timeout')
      if (['ENOBUFS', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'E2BIG'].includes(error.code)) details.push(error.code)
      const context = `${operation}${repository ? ` in ${repository}` : ''}`
      const message = `GitHub ${context} failed${details.length ? ` (${details.join('; ')})` : ''}. Preserve sealed artifacts; do not replace existing assets.`
      throw Object.assign(new Error(message), { notFound })
    }
  }
  optional(path) {
    try { return JSON.parse(this.run(['api', path])) }
    catch (error) { if (error.notFound) return null; throw error }
  }
  release(repo, tag) {
    const published = this.optional(`repos/${repo}/releases/tags/${tag}`)
    if (published) return published
    // The by-tag endpoint excludes drafts, even for an authenticated owner.
    // Authenticated release listing includes them; require one exact identity
    // rather than treating an existing sealed draft as a missing release.
    const matches = this.history(repo).filter(release => release.tag_name === tag)
    requireValue(matches.length <= 1, 'Multiple releases match the candidate tag; refusing ambiguous draft identity.')
    return matches[0] ?? null
  }
  history(repo) { return JSON.parse(this.run(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat() }
  download(repo, tag, directory, pattern) {
    this.run(['release', 'download', tag, '--repo', repo, '--dir', directory, ...(pattern ? ['--pattern', pattern] : [])])
  }
  create(repo, tag, directory, names, body, sourceSha) {
    const args = ['release', 'create', tag, ...names.map(name => join(directory, name)), '--repo', repo, '--draft', '--title', `AgentsDock ${tag.slice(1)}`, '--notes', body]
    if (repo === PRIMARY) args.push('--target', sourceSha)
    this.run(args)
  }
  publish(repo, tag, track) {
    this.run(['release', 'edit', tag, '--repo', repo, '--tag', tag, '--draft=false', ...(track === 'beta' ? ['--prerelease', '--latest=false'] : ['--prerelease=false', '--latest'])])
  }
  verifySourceTag(release, sourceSha) {
    requireValue(release.target_commitish === sourceSha, 'Public release target is not the pinned source SHA.')
    let object = this.optional(`repos/${PRIMARY}/git/ref/tags/${release.tag_name}`)?.object
    requireValue(release.draft || object, 'Published public release has no source tag.')
    const hadTag = Boolean(object)
    for (let count = 0; object?.type === 'tag' && count < 5; count++) {
      object = this.optional(`repos/${PRIMARY}/git/tags/${object.sha}`)?.object
    }
    if (hadTag) requireValue(object?.type === 'commit' && object.sha === sourceSha, 'Public release tag could not resolve to the pinned source commit.')
  }
}

export class ReleaseMirror {
  constructor(client = new GitHubClient(), { publicKey, publicationVerifier = verifyPublishedServerPaths } = {}) { this.client = client; this.publicKey = publicKey; this.publicationVerifier = publicationVerifier }

  checkVersion(version, track, legacyTag = '') {
    // Same-version entries are excluded ONLY after inspect/stage verified their
    // complete bytes and source identity. This permits a half-published retry.
    const history = REPOSITORIES.flatMap(repo => {
      const tag = releaseTag(repo, version, track, legacyTag)
      return this.client.history(repo).filter(release => release.tag_name !== tag)
        // Keep the one non-v legacy alias as a version baseline in future passes.
        .map(release => repo === REPOSITORIES[1] && release.tag_name === '1.0.0'
          ? { ...release, tag_name: 'v1.0.0' } : release)
    })
    validateElectronReleaseVersion(version, track, history)
  }

  async existing(repo, options, expected = {}) {
    const release = this.client.release(repo, releaseTag(repo, options.version, options.track, options.legacyTag))
    if (!release) return null
    const identity = releaseIdentity(release, options.version, options.track, repo, options.legacyTag)
    matchIdentity(identity, expected)
    if (repo === PRIMARY) this.client.verifySourceTag(release, identity.sourceSha)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-mirror-check-'))
    try {
      let manifestSha256, coordinatedDescriptor
      // GitHub's authenticated asset records bind immutable bytes to SHA-256.
      // Use this only for a complete uploaded asset set with valid identities;
      // older release records without digests retain full-byte verification.
      const assets = release.assets
      const hasDigests = assets.every(asset => /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? ''))
      if (hasDigests) {
        requireValue(assets.every(asset => asset.state === 'uploaded' && Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size) && asset.size > 0) &&
          new Set(assets.map(asset => asset.id)).size === assets.length, 'GitHub release asset identities or upload states are invalid.')
        this.client.download(repo, release.tag_name, directory, 'SHA256SUMS')
        sameNames(await readdir(directory), ['SHA256SUMS'], 'Checksum download contains unexpected assets.')
        const manifest = await readManifest(directory, options.version, options.track, identity.coordinatedUpdates)
        manifestSha256 = manifest.manifestSha256
        for (const asset of assets) {
          const checksum = asset.name === 'SHA256SUMS' ? manifestSha256 : manifest.checksums.get(asset.name)
          requireValue(asset.digest === `sha256:${checksum}`, `Checksum mismatch: ${asset.name}`)
        }
        if (identity.coordinatedUpdates) {
          for (const name of COORDINATED_ASSETS) {
            this.client.download(repo, release.tag_name, directory, name)
            requireValue(await sha256(join(directory, name)) === manifest.checksums.get(name), `Checksum mismatch: ${name}`)
          }
        }
      } else {
        this.client.download(repo, release.tag_name, directory)
        manifestSha256 = await verifyAssets(directory, options.version, options.track, { ...identity, publicKey: this.publicKey })
      }
      if (identity.coordinatedUpdates) coordinatedDescriptor = verifyCoordinatedDirectory(directory, { ...identity, version: options.version, track: options.track, publicKey: this.publicKey })
      if (expected.manifestSha256) requireValue(manifestSha256 === expected.manifestSha256, 'Mirror checksum manifest changed or conflicts; refusing to overwrite.')
      return { release, ...identity, manifestSha256, coordinatedDescriptor, ...(options.legacyTag ? { legacyTag: options.legacyTag } : {}) }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }

  async stage(options) {
    sourceIdentity(options)
    requireValue(options.coordinatedUpdates === undefined || typeof options.coordinatedUpdates === 'boolean', 'Invalid coordinated enrollment option.')
    options = { ...options, coordinatedUpdates: options.coordinatedUpdates ?? false }
    const manifestSha256 = await verifyAssets(options.assets, options.version, options.track, { ...options, publicKey: this.publicKey })
    const expected = { ...options, manifestSha256 }
    const existing = []
    for (const repo of REPOSITORIES) existing.push(await this.existing(repo, options, expected))
    this.checkVersion(options.version, options.track, options.legacyTag)
    // Reject injected provenance lines before any external writes.
    const notes = String(options.notes ?? '')
    requireValue(!/^(Source repository|Source commit|Source ref|Update track|Windows signing|Coordinated updates):/m.test(notes), 'Release notes must not override provenance fields.')
    const body = `${notes}\n\nUpdate track: ${options.track}\nWindows signing: ${options.windowsSigning}\nSource repository: ${PRIMARY}\nSource ref: ${options.sourceRef}\nSource commit: ${options.sourceSha}\n${options.coordinatedUpdates ? 'Coordinated updates: npm-v1\n' : ''}`
    for (let index = 0; index < REPOSITORIES.length; index++) {
      if (!existing[index]) this.client.create(REPOSITORIES[index], releaseTag(REPOSITORIES[index], options.version, options.track, options.legacyTag), options.assets, expectedAssets(options.version, options.track, options.coordinatedUpdates), body, options.sourceSha)
      requireValue(await this.existing(REPOSITORIES[index], options, expected), 'Created draft could not be verified.')
    }
    return expected
  }

  async inspect(options) {
    const primary = await this.existing(PRIMARY, options, options)
    requireValue(primary, 'Canonical public draft/release is missing; rerun draft creation with the original sealed artifacts.')
    requireValue(await this.existing(REPOSITORIES[1], options, primary), 'Legacy mirror is missing; rerun draft creation with the original sealed artifacts.')
    this.checkVersion(options.version, options.track, options.legacyTag)
    if (options.track === 'stable' && primary.windowsSigning === 'unsigned') {
      requireValue(options.allowUnsignedWindows === 'true', 'Publishing an unsigned stable Windows installer requires allow_unsigned_windows.')
    }
    if (options.assets) {
      await mkdir(options.assets, { recursive: true })
      requireValue((await readdir(options.assets)).length === 0, 'Replay asset directory must be empty.')
      this.client.download(PRIMARY, `v${options.version}`, options.assets)
      requireValue(await verifyAssets(options.assets, options.version, options.track, { ...primary, publicKey: this.publicKey }) === primary.manifestSha256, 'Canonical assets changed during replay download.')
    }
    return primary
  }

  async publish(options) {
    // All platforms supply the accepted seal and identity from inspect. Both
    // repositories must still match before making either release public.
    requireValue(/^[0-9a-f]{64}$/.test(options.manifestSha256 ?? ''), 'Publication requires the platform-verified checksum-manifest identity.')
    sourceIdentity(options)
    const accepted = await this.inspect(options)
    if (accepted.coordinatedUpdates) await this.publicationVerifier(accepted.coordinatedDescriptor, { publicKey: this.publicKey })
    for (const repo of REPOSITORIES) {
      const current = await this.existing(repo, options, accepted)
      requireValue(current, 'Accepted mirror disappeared before publication.')
      this.checkVersion(options.version, options.track, options.legacyTag)
      if (current.release.draft) this.client.publish(repo, releaseTag(repo, options.version, options.track, options.legacyTag), options.track)
      const published = await this.existing(repo, options, accepted)
      requireValue(published && !published.release.draft, 'Release publication is incomplete; retry the same sealed release.')
    }
    return accepted
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  requireValue(['stage', 'inspect', 'publish'].includes(command) && args.length % 2 === 0, 'Usage: direct-release-mirror.mjs stage|inspect|publish --version V --track T [options]')
  const options = {}
  const allowed = new Set(['version', 'track', 'source-sha', 'source-ref', 'windows-signing', 'manifest-sha256', 'assets', 'notes', 'allow-unsigned-windows', 'legacy-tag', 'coordinated-updates'])
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '')
    requireValue(args[index].startsWith('--') && allowed.has(name), 'Unknown release mirror option.')
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    requireValue(!(key in options), 'Duplicate release mirror option.')
    options[key] = args[index + 1]
  }
  if (options.coordinatedUpdates !== undefined) {
    requireValue(['true', 'false'].includes(options.coordinatedUpdates), 'Coordinated enrollment must be true or false.')
    options.coordinatedUpdates = options.coordinatedUpdates === 'true'
  }
  if (options.assets) options.assets = resolve(options.assets)
  const result = await new ReleaseMirror()[command](options)
  process.stdout.write(`coordinated_updates=${result.coordinatedUpdates}\nsource_sha=${result.sourceSha}\nsource_ref=${result.sourceRef}\nmanifest_sha256=${result.manifestSha256}\nwindows_signing_policy=${result.windowsSigning === 'signed' ? 'require-signed' : 'allow-unsigned'}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
