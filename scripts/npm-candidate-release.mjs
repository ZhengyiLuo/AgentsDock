#!/usr/bin/env node
// Manual draft handoff only. This script never publishes npm or a GitHub release.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GitHubClient } from './direct-release-mirror.mjs'
import { COORDINATED_ASSETS, verifyCoordinatedDirectory } from './coordinated-release.mjs'

const REPOSITORY = 'ZhengyiLuo/AgentsDock'
const need = (condition, message) => { if (!condition) throw new Error(message) }
export const npmCandidateTag = version => `npm-candidate-v${version}`

function sourceIdentity(options) {
  need(/^[a-f0-9]{40}$/.test(options.sourceSha), 'A full lowercase reviewed source SHA is required.')
  need(/^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(options.sourceRef) && !options.sourceRef.includes('..') && !options.sourceRef.includes('//') && !/[/.]$/.test(options.sourceRef) && !options.sourceRef.split('/').some(part => part.endsWith('.lock')), 'Source must be main or a reviewed release branch.')
}

async function hashFile(path, algorithm, encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}

export async function verifyNpmCandidate(directory, options, publicKey) {
  sourceIdentity(options)
  const manifest = verifyCoordinatedDirectory(directory, { ...options, publicKey })
  const names = [...COORDINATED_ASSETS, manifest.archive.name].sort()
  need(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(names), 'Npm candidate must contain exactly the signed descriptor, signature and tarball.')
  for (const name of names) need((await lstat(join(directory, name))).isFile(), 'Npm candidate assets must be regular files.')
  const archive = join(directory, manifest.archive.name)
  need((await lstat(archive)).size === manifest.archive.size, 'Npm candidate archive size differs from the signed descriptor.')
  need(await hashFile(archive, 'sha256') === manifest.archive.sha256 && `sha512-${await hashFile(archive, 'sha512', 'base64')}` === manifest.npm.integrity, 'Npm candidate archive differs from its signed hashes.')
  const assetSha256 = Object.fromEntries(await Promise.all(names.map(async name => [name, await hashFile(join(directory, name), 'sha256')])))
  return { manifest, names, assetSha256, manifestSha256: assetSha256[COORDINATED_ASSETS[0]] }
}

function candidateIdentity(release, options, verified) {
  need(release.tag_name === npmCandidateTag(options.version) && release.draft === true && release.target_commitish === options.sourceSha, 'Existing npm candidate is not the exact source-pinned draft; refusing to overwrite.')
  const expected = { 'Candidate type': 'npm-server-v1', 'Source repository': REPOSITORY, 'Source commit': options.sourceSha, 'Source ref': options.sourceRef, 'Update track': options.track, 'Npm manifest SHA256': verified.manifestSha256 }
  for (const [key, value] of Object.entries(expected)) {
    const lines = String(release.body ?? '').split('\n').filter(line => line.startsWith(`${key}:`))
    need(lines.length === 1 && lines[0] === `${key}: ${value}`, 'Existing npm candidate identity changed; refusing to overwrite.')
  }
  need(JSON.stringify((release.assets ?? []).map(asset => asset.name).sort()) === JSON.stringify(verified.names), 'Existing npm candidate asset set is incomplete or conflicting; refusing to overwrite.')
}

export async function stageNpmCandidate(options, { client = new GitHubClient(), publicKey } = {}) {
  const verified = await verifyNpmCandidate(options.assets, options, publicKey)
  const tag = npmCandidateTag(options.version)
  const inspect = async () => {
    const release = client.release(REPOSITORY, tag)
    if (!release) return false
    candidateIdentity(release, options, verified)
    client.verifySourceTag(release, options.sourceSha)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-npm-candidate-'))
    try {
      client.download(REPOSITORY, tag, directory)
      const received = await verifyNpmCandidate(directory, options, publicKey)
      need(JSON.stringify(received.assetSha256) === JSON.stringify(verified.assetSha256), 'Existing npm candidate bytes differ; refusing to overwrite.')
    } finally { await rm(directory, { recursive: true, force: true }) }
    return true
  }
  if (!await inspect()) {
    const body = `Prepared npm server candidate; this draft is not a published app or npm release.\n\nCandidate type: npm-server-v1\nSource repository: ${REPOSITORY}\nSource commit: ${options.sourceSha}\nSource ref: ${options.sourceRef}\nUpdate track: ${options.track}\nNpm manifest SHA256: ${verified.manifestSha256}\n`
    client.run(['release', 'create', tag, ...verified.names.map(name => join(options.assets, name)), '--repo', REPOSITORY, '--draft', '--prerelease', '--latest=false', '--target', options.sourceSha, '--title', `AgentsDock npm candidate ${options.version}`, '--notes', body])
    need(await inspect(), 'Created npm candidate draft could not be verified.')
  }
  return { tag, manifestSha256: verified.manifestSha256, sourceSha: options.sourceSha, version: options.version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    need(['verify', 'stage'].includes(command) && args.length === 10, 'Usage: npm-candidate-release.mjs verify|stage --assets DIRECTORY --version VERSION --track TRACK --source-sha SHA --source-ref REF')
    const allowed = new Set(['assets', 'version', 'track', 'source-sha', 'source-ref']), options = {}
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2), key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      need(args[index].startsWith('--') && allowed.has(name) && !(key in options), 'Invalid npm candidate option.')
      options[key] = args[index + 1]
    }
    options.assets = resolve(options.assets)
    const result = command === 'stage' ? await stageNpmCandidate(options) : await verifyNpmCandidate(options.assets, options)
    process.stdout.write(`accepted_manifest_sha256=${result.manifestSha256}\ncandidate_tag=${npmCandidateTag(options.version)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
