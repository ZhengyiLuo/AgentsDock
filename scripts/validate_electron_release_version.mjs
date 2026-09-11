#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STABLE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/

export function validateElectronReleaseVersion(candidate, track, releasePayload) {
  const candidateVersion = parseVersion(candidate)
  const expectedPrerelease = track === 'beta'
  if (track !== 'stable' && track !== 'beta') throw new Error(`Unknown release track: ${track}`)
  if (!candidateVersion || (candidateVersion.beta !== null) !== expectedPrerelease) {
    throw new Error(track === 'beta'
      ? 'Beta versions must use x.y.z-beta.N SemVer without a leading v.'
      : 'Stable versions must use x.y.z SemVer without a leading v.')
  }

  const published = flattenReleases(releasePayload)
    .filter(release => !Boolean(release.draft ?? release.isDraft))
    .map(release => release.tag_name ?? release.tagName)
    .filter(tag => typeof tag === 'string' && /^v\d/.test(tag))
    .map(tag => parseVersion(tag.slice(1)))
    .filter(version => version !== null)

  const latestStable = greatest(published.filter(version => !version.beta))
  const latestPublic = greatest(published)
  const baselines = [latestStable, latestPublic]
    .filter(version => version !== null)
    .filter((version, index, versions) => versions.findIndex(other => other.raw === version.raw) === index)

  for (const baseline of baselines) {
    if (compareVersions(candidateVersion, baseline) <= 0) {
      throw new Error(`Release ${candidate} must be greater than public AgentsDock ${baseline.raw}.`)
    }
  }

  return {
    candidate,
    latestStable: latestStable?.raw ?? null,
    latestPublic: latestPublic?.raw ?? null
  }
}

function parseVersion(raw) {
  let match = STABLE_PATTERN.exec(raw)
  if (match) return { raw, core: [match[1], match[2], match[3]], beta: null }
  match = BETA_PATTERN.exec(raw)
  return match ? { raw, core: [match[1], match[2], match[3]], beta: match[4] } : null
}

function compareVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index], right.core[index])
    if (comparison !== 0) return comparison
  }
  if (left.beta === null && right.beta === null) return 0
  if (left.beta === null) return 1
  if (right.beta === null) return -1
  return compareNumericIdentifiers(left.beta, right.beta)
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}

function greatest(versions) {
  return versions.reduce((current, version) => (
    current === null || compareVersions(version, current) > 0 ? version : current
  ), null)
}

function flattenReleases(value) {
  if (Array.isArray(value)) return value.flatMap(flattenReleases)
  return value && typeof value === 'object' ? [value] : []
}

function main() {
  const [candidate, track, releasesPath] = process.argv.slice(2)
  if (!candidate || !track || !releasesPath) {
    throw new Error('Usage: validate_electron_release_version.mjs VERSION TRACK RELEASES_JSON')
  }
  const result = validateElectronReleaseVersion(
    candidate,
    track,
    JSON.parse(readFileSync(releasesPath, 'utf8'))
  )
  process.stdout.write(`Release version accepted: ${result.candidate} (stable: ${result.latestStable ?? 'none'}, public: ${result.latestPublic ?? 'none'})\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
