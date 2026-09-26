#!/usr/bin/env node
// Read-only post-publication verification shared by both desktop publishers.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { newestBetaVersionFromAtom } from '../electron/src/main/updater-feed.mjs'
import { GitHubClient, releaseTag, REPOSITORIES } from './direct-release-mirror.mjs'
import { validateElectronReleaseVersion } from './validate_electron_release_version.mjs'

const need = (condition, message) => { if (!condition) throw new Error(message) }
const MAX_METADATA = 2 * 1024 * 1024
const PUBLIC_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const PLATFORMS = ['-mac.yml', '-linux.yml', '-linux-arm64.yml', '.yml']

async function publicText(url, fetchImpl) {
  // No token or Authorization header is sent to public feed/asset URLs.
  let current = url
  const signal = AbortSignal.timeout(30000)
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(current)
    need(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && PUBLIC_HOSTS.has(parsed.hostname), 'Public updater metadata redirected outside trusted GitHub hosts.')
    const response = await fetchImpl(current, { redirect: 'manual', signal, headers: { accept: 'text/plain, application/atom+xml' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      need(location && redirects < 4, 'Public updater metadata redirect is invalid.')
      current = new URL(location, current).href
      continue
    }
    need(response.ok && response.body, 'Public updater metadata is unavailable.')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      need(size <= MAX_METADATA, 'Public updater metadata exceeds its size limit.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  throw new Error('Public updater metadata redirect limit exceeded.')
}

function updaterVersion(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => /^version:/.test(line))
  need(lines.length === 1, 'Public updater YAML must contain exactly one top-level version.')
  const match = /^version:\s*(['"]?)([0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?)\1\s*(?:#.*)?$/.exec(lines[0])
  need(match, 'Public updater YAML version is malformed.')
  return match[2]
}

async function verifyRepository(repository, { version, track, legacyTag }, client, fetchImpl) {
  const tag = releaseTag(repository, version, track, legacyTag)
  const release = client.optional(`repos/${repository}/releases/tags/${tag}`)
  need(release?.tag_name === tag && release.draft === false && release.prerelease === (track === 'beta'), 'Published desktop release has the wrong tag, visibility or prerelease state.')
  const latest = client.optional(`repos/${repository}/releases/latest`)
  if (track === 'stable') {
    need(latest?.tag_name === tag && latest.draft === false && latest.prerelease === false, 'Public latest does not select the accepted stable release.')
  } else {
    // Before the first stable release, /latest may legitimately be absent.
    need(latest === null || (latest.tag_name !== tag && latest.draft === false && latest.prerelease === false && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latest.tag_name)), 'A beta must not become the public latest stable release.')
    const feed = await publicText(`https://github.com/${repository}/releases.atom`, fetchImpl)
    need(newestBetaVersionFromAtom(feed) === version, 'Public beta discovery does not select the accepted version.')
  }
  const root = track === 'beta'
    ? `https://github.com/${repository}/releases/download/v${version}/beta`
    : `https://github.com/${repository}/releases/latest/download/latest`
  // For beta, Atom must select this exact version before these URLs are read:
  // the candidate and discovered platform YAML checks therefore coincide.
  const results = await Promise.allSettled(PLATFORMS.map(async suffix => {
    need(updaterVersion(await publicText(`${root}${suffix}`, fetchImpl)) === version, `Public ${track}${suffix} does not select the accepted version.`)
  }))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
}

export async function verifyPublicDesktopFeed(identity, {
  client = new GitHubClient((command, args, options) => execFileSync(command, args, { ...options, timeout: 30000 })),
  fetchImpl = fetch, sleepImpl = sleep, log = () => {}, attempts = 6, retryDelayMs = 10000,
} = {}) {
  const { version, track, legacyTag = '' } = identity
  validateElectronReleaseVersion(version, track, [])
  // Validate the exceptional immutable legacy tag before any network request.
  for (const repository of REPOSITORIES) releaseTag(repository, version, track, legacyTag)
  need(Number.isInteger(attempts) && attempts >= 1 && attempts <= 6 && Number.isInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 10000, 'Invalid public verification retry bounds.')
  for (const repository of REPOSITORIES) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await verifyRepository(repository, { version, track, legacyTag }, client, fetchImpl)
        break
      } catch (error) {
        if (attempt === attempts) throw new Error(`${repository} metadata or beta discovery did not resolve to ${version}: ${error.message}`)
        log(`${repository} public updater verification has not succeeded (attempt ${attempt}/${attempts}); retrying read-only checks.`)
        await sleepImpl(retryDelayMs)
      }
    }
  }
  return { version, track, repositories: [...REPOSITORIES], verified: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: set RELEASE_VERSION, RELEASE_TRACK and optional LEGACY_RELEASE_TAG; run verify_public_desktop_feed.mjs without arguments.\n')
    process.exitCode = 1
  } else {
    verifyPublicDesktopFeed({ version: process.env.RELEASE_VERSION, track: process.env.RELEASE_TRACK, legacyTag: process.env.LEGACY_RELEASE_TAG || '' }, { log: message => process.stderr.write(`${message}\n`) })
      .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  }
}
