const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const RELEASE_TAG_LINK_PATTERN = /<link\b[^>]*\bhref=["'][^"']*\/releases\/tag\/v?([^"'/?#]+)["'][^>]*>/gi

/**
 * GitHub's releases Atom feed is ordered by release activity, not SemVer.
 * Select the greatest AgentsDock beta explicitly so a recently edited stable
 * release (or an unrelated release tag) cannot hide a newer beta.
 */
export function newestBetaVersionFromAtom(feed) {
  return newestReleaseFromAtom(feed, true)?.version ?? null
}

/**
 * Beta is an opt-in to prereleases, not an opt-out from stable releases. A
 * stable release outranks every beta with the same core; a beta with a newer
 * core still wins. Keep its metadata track separate from the user's saved
 * channel so promotion to stable does not unsubscribe the user from Beta.
 */
export function newestCompatibleReleaseFromAtom(feed) {
  return newestReleaseFromAtom(feed, false)
}

function newestReleaseFromAtom(feed, betaOnly) {
  let newest = null

  for (const match of feed.matchAll(RELEASE_TAG_LINK_PATTERN)) {
    const version = match[1]
    const parsed = parseReleaseVersion(version)
    if (!parsed || (betaOnly && parsed[3] === undefined)) continue
    if (!newest || compareParsedReleaseVersions(parsed, newest.parsed) > 0) {
      newest = { version, parsed }
    }
  }

  return newest ? { version: newest.version, track: newest.parsed[3] === undefined ? 'stable' : 'beta' } : null
}

function parseReleaseVersion(version) {
  const match = RELEASE_VERSION_PATTERN.exec(version)
  return match ? [match[1], match[2], match[3], match[4]] : null
}

function compareParsedReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(left[index], right[index])
    if (comparison !== 0) return comparison
  }
  if (left[3] === undefined) return right[3] === undefined ? 0 : 1
  if (right[3] === undefined) return -1
  return compareNumericIdentifiers(left[3], right[3])
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}
