#!/usr/bin/env node
// Explicit private-draft handoff only. Never publish npm or a GitHub release.
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GitHubClient } from './direct-release-mirror.mjs'
import { validateCandidate } from './verify_agentsdock_cli_publication.mjs'

const REPOSITORY = 'ZhengyiLuo/AgentsDock'
const RECEIPT = 'agentsdock-cli-receipt.json'
const need = (condition, message) => { if (!condition) throw new Error(message) }
export const cliCandidateTag = version => `cli-candidate-v${version}`

function sourceIdentity(options) {
  need(/^[a-f0-9]{40}$/.test(options.sourceSha), 'A full lowercase reviewed source SHA is required.')
  need(/^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(options.sourceRef) &&
    !options.sourceRef.includes('..') && !options.sourceRef.includes('//') && !/[/.]$/.test(options.sourceRef) &&
    !options.sourceRef.split('/').some(part => part.endsWith('.lock')), 'Source must be main or a reviewed release branch.')
}

export async function verifyCliCandidate(directory, options, { sourceRoot } = {}) {
  sourceIdentity(options)
  const candidate = validateCandidate({ directory, version: options.version, sourceSHA: options.sourceSha,
    acceptedReceiptSHA256: options.acceptedReceiptSha256, runtimeDirectory: options.npmAssets,
    acceptedManifestSHA256: options.acceptedManifestSha256, expectedLatest: options.expectedLatest,
    ...(sourceRoot ? { sourceRoot } : {}) })
  need(candidate.descriptor.track === options.track, 'CLI candidate version and signed runtime must match the selected track.')
  const names = [RECEIPT, candidate.receipt.archive.name].sort()
  need(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(names), 'CLI candidate must contain exactly its checksum receipt and tarball.')
  for (const name of names) need((await lstat(join(directory, name))).isFile(), 'CLI candidate assets must be regular files.')
  return { candidate, names, assetSha256: { [RECEIPT]: options.acceptedReceiptSha256,
    [candidate.receipt.archive.name]: candidate.receipt.archive.sha256 } }
}

function fields(options) {
  return { 'Candidate type': 'agentsdock-cli-v1', 'Source repository': REPOSITORY,
    'Source commit': options.sourceSha, 'Source ref': options.sourceRef, 'Update track': options.track,
    'CLI receipt SHA256': options.acceptedReceiptSha256, 'Npm manifest SHA256': options.acceptedManifestSha256,
    'CLI latest baseline': options.expectedLatest }
}

function candidateIdentity(release, options, verified) {
  need(release.tag_name === cliCandidateTag(options.version) && release.draft === true &&
    release.target_commitish === options.sourceSha, 'Existing CLI candidate is not the exact source-pinned draft; refusing to overwrite.')
  for (const [key, value] of Object.entries(fields(options))) {
    const lines = String(release.body ?? '').split('\n').filter(line => line.startsWith(`${key}:`))
    need(lines.length === 1 && lines[0] === `${key}: ${value}`, 'Existing CLI candidate identity changed; refusing to overwrite.')
  }
  need(JSON.stringify((release.assets ?? []).map(asset => asset.name).sort()) === JSON.stringify(verified.names),
    'Existing CLI candidate asset set is incomplete or conflicting; refusing to overwrite.')
}

export class CliCandidateRelease {
  constructor(client = new GitHubClient(), { sourceRoot } = {}) { this.client = client; this.sourceRoot = sourceRoot }

  async inspect(options) {
    const verified = await verifyCliCandidate(options.assets, options, { sourceRoot: this.sourceRoot })
    const tag = cliCandidateTag(options.version)
    const release = this.client.release(REPOSITORY, tag)
    if (!release) return null
    candidateIdentity(release, options, verified)
    this.client.verifySourceTag(release, options.sourceSha)
    const directory = await mkdtemp(join(tmpdir(), 'agentsdock-cli-candidate-'))
    try {
      this.client.download(REPOSITORY, tag, directory)
      const received = await verifyCliCandidate(directory, options, { sourceRoot: this.sourceRoot })
      need(JSON.stringify(received.assetSha256) === JSON.stringify(verified.assetSha256),
        'Existing CLI candidate bytes differ; refusing to overwrite.')
    } finally { await rm(directory, { recursive: true, force: true }) }
    return { tag, version: options.version, sourceSha: options.sourceSha,
      receiptSha256: options.acceptedReceiptSha256, manifestSha256: options.acceptedManifestSha256,
      expectedLatest: options.expectedLatest, staged: true }
  }

  async stage(options) {
    const verified = await verifyCliCandidate(options.assets, options, { sourceRoot: this.sourceRoot })
    const existing = await this.inspect(options)
    if (existing) return existing
    const tag = cliCandidateTag(options.version)
    // A tag can outlive a deleted release. Check it before creating a new draft,
    // not just afterward; never attach this candidate to another source commit.
    this.client.verifySourceTag({ tag_name: tag, draft: true, target_commitish: options.sourceSha }, options.sourceSha)
    const body = 'Prepared agentsdock CLI candidate; this private draft is not a published npm or desktop release.\n\n' +
      Object.entries(fields(options)).map(([key, value]) => `${key}: ${value}\n`).join('')
    this.client.run(['release', 'create', tag, ...verified.names.map(name => join(options.assets, name)),
      '--repo', REPOSITORY, '--draft', '--prerelease', '--latest=false', '--target', options.sourceSha,
      '--title', `AgentsDock CLI candidate ${options.version}`, '--notes', body])
    const result = await this.inspect(options)
    need(result, 'Created CLI candidate draft could not be verified.')
    return result
  }
}

export const stageCliCandidate = (options, { client, sourceRoot } = {}) => new CliCandidateRelease(client, { sourceRoot }).stage(options)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    const allowed = new Set(['assets', 'npm-assets', 'version', 'track', 'source-sha', 'source-ref',
      'accepted-receipt-sha256', 'accepted-manifest-sha256', 'expected-latest'])
    need(['inspect', 'stage'].includes(command) && args.length === 18,
      'Usage: agentsdock-cli-candidate-release.mjs inspect|stage --assets DIRECTORY --npm-assets DIRECTORY --version VERSION --track TRACK --source-sha SHA --source-ref REF --accepted-receipt-sha256 SHA256 --accepted-manifest-sha256 SHA256 --expected-latest STABLE_OR_absent')
    const options = {}
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2), key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      need(args[index].startsWith('--') && allowed.has(name) && !(key in options), 'Invalid CLI candidate option.')
      options[key] = args[index + 1]
    }
    options.assets = resolve(options.assets); options.npmAssets = resolve(options.npmAssets)
    const helper = new CliCandidateRelease()
    const result = command === 'stage' ? await helper.stage(options) : await helper.inspect(options)
    console.log(JSON.stringify(result ?? { tag: cliCandidateTag(options.version), staged: false }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
