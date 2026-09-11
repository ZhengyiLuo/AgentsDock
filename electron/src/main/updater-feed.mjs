const BETA_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/
const RELEASE_TAG_LINK_PATTERN = /<link\b[^>]*\bhref=["'][^"']*\/releases\/tag\/v?([^"'/?#]+)["'][^>]*>/gi

/**
 * GitHub's releases Atom feed is ordered by release activity, not SemVer.
 * Select the greatest AgentsDock beta explicitly so a recently edited stable
 * release (or an unrelated release tag) cannot hide a newer beta.
 */
export function newestBetaVersionFromAtom(feed) {
  let newest = null

  for (const match of feed.matchAll(RELEASE_TAG_LINK_PATTERN)) {
    const version = match[1]
    const parsed = parseBetaVersion(version)
    if (!parsed) continue
    if (!newest || compareParsedBetaVersions(parsed, newest.parsed) > 0) {
      newest = { version, parsed }
    }
  }

  return newest?.version ?? null
}

function parseBetaVersion(version) {
  const match = BETA_VERSION_PATTERN.exec(version)
  return match ? [match[1], match[2], match[3], match[4]] : null
}

function compareParsedBetaVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareNumericIdentifiers(left[index], right[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}
