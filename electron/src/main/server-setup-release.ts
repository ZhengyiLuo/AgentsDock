import { verify } from 'node:crypto'
import { compareReleaseVersions, SERVER_RELEASE_PUBLIC_KEY } from './coordinated-updates'

export interface PinnedServerRelease {
  track: 'stable' | 'beta'
  version: string
  url: string
  sha256: string
}

const RELEASES = 'https://github.com/ZhengyiLuo/AgentsServer/releases'
const RELEASES_API = 'https://api.github.com/repos/ZhengyiLuo/AgentsServer/releases?per_page=100'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const MAX_MANIFEST_BYTES = 8 * 1024
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && value.trim() === value && VERSION.test(value)
}

/** Run on the installation host before allowing an older Beta to replace its current server. */
export function serverSetupVersionGuard(release: PinnedServerRelease): string {
  if (release.track !== 'beta') return ''
  if (!validVersion(release.version) || !release.version.includes('-beta.')) throw new Error('Invalid Beta server version.')
  return `AGENTSDOCK_SETUP_VERSION_FILE="\${AGENTS_SERVER_INSTALL_DIR:-$HOME/.local/share/agents-server}/current/VERSION"
if [ -e "$AGENTSDOCK_SETUP_VERSION_FILE" ]; then
  AGENTSDOCK_SETUP_CURRENT_VERSION="$(tr -d '[:space:]' < "$AGENTSDOCK_SETUP_VERSION_FILE")" || exit 78
  if ! awk -v current="$AGENTSDOCK_SETUP_CURRENT_VERSION" -v target='${release.version}' '
    function compare_number(a, b) {
      if (length(a) != length(b)) return length(a) > length(b) ? 1 : -1
      return ("x" a) == ("x" b) ? 0 : (("x" a) > ("x" b) ? 1 : -1)
    }
    BEGIN {
      if (current !~ /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-beta[.][1-9][0-9]*)?$/) {
        print "AGENTSDOCK_PREFLIGHT_ERROR=Could not verify the installed server version. No installer was started."
        exit 1
      }
      split(current, old, "-"); split(target, next_version, "-")
      split(old[1], old_core, "[.]"); split(next_version[1], next_core, "[.]")
      difference = 0
      for (i = 1; i <= 3; i++) {
        difference = compare_number(old_core[i], next_core[i])
        if (difference != 0) break
      }
      if (difference == 0) {
        if (old[2] == "") difference = 1
        else {
          sub(/^beta[.]/, "", old[2]); sub(/^beta[.]/, "", next_version[2])
          difference = compare_number(old[2], next_version[2])
        }
      }
      if (difference > 0) {
        print "AGENTSDOCK_PREFLIGHT_ERROR=Refusing to downgrade AgentsServer " current " to Beta " target ". Choose Stable or a newer Beta release."
        exit 1
      }
    }
  ' >&2; then exit 78; fi
fi
`
}

class ReleaseHTTPError extends Error {
  constructor(readonly status: number) {
    super(`Could not read the AgentsServer release (HTTP ${status}). Try guided setup again later.`)
  }
}

function verifiedRelease(bytes: Buffer, signature: Buffer, track: PinnedServerRelease['track'], expectedVersion?: string): PinnedServerRelease {
  if (signature.length !== 64 || !verify(null, bytes, SERVER_RELEASE_PUBLIC_KEY, signature)) {
    throw new Error('The AgentsServer release signature is invalid. No installer was started.')
  }
  const manifest = JSON.parse(bytes.toString('utf8'))
  const version = manifest?.version
  if (manifest?.schema !== 1 || !validVersion(version)
    || (expectedVersion !== undefined && version !== expectedVersion)
    || manifest.track !== track || manifest.prerelease !== (track === 'beta')
    || version.includes('-') !== (track === 'beta')) {
    throw new Error('The signed AgentsServer release does not match the selected version and channel.')
  }
  const archive = manifest.archive
  const name = `agents-server-${version}.tar.gz`
  const url = `${RELEASES}/download/v${version}/${name}`
  if (archive?.name !== name || archive.url !== url || typeof archive.sha256 !== 'string'
    || archive.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(archive.sha256) || !Number.isSafeInteger(archive.size)
    || archive.size < 1 || archive.size > 200 * 1024 * 1024) {
    throw new Error('The signed AgentsServer archive metadata is invalid. No installer was started.')
  }
  return Object.freeze({ track, version, url, sha256: archive.sha256 })
}

/** Discovery selects a channel; only an immutable publisher-signed release can supply installer input. */
export async function resolveServerSetupRelease(
  track: PinnedServerRelease['track'],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<PinnedServerRelease> {
  if (track !== 'stable' && track !== 'beta') throw new Error('Choose the Stable or Beta AgentsServer channel.')
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)])
  const download = async (url: string, limit: number): Promise<Buffer> => {
    requestSignal.throwIfAborted()
    const response = await fetcher(url, {
      signal: requestSignal,
      headers: { 'User-Agent': 'AgentsDock-Guided-Setup', Accept: url === RELEASES_API ? 'application/vnd.github+json' : '*/*' }
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new ReleaseHTTPError(response.status)
    }
    if (!response.body) throw new Error('The AgentsServer release response was empty.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        requestSignal.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > limit) throw new Error('The AgentsServer release metadata exceeds its size limit.')
        chunks.push(next.value)
      }
    } finally { await reader.cancel() }
    requestSignal.throwIfAborted()
    return Buffer.concat(chunks)
  }
  const releaseAt = async (root: string, expectedVersion?: string): Promise<PinnedServerRelease> => {
    const [bytes, signature] = await Promise.all([
      download(`${root}/agents-server-manifest.json`, MAX_MANIFEST_BYTES),
      download(`${root}/agents-server-manifest.sig`, 64)
    ])
    return verifiedRelease(bytes, signature, track, expectedVersion)
  }

  let version: string
  if (track === 'stable') {
    // The public latest redirect avoids GitHub API rate limits. Pin the signed
    // version again below so a channel moving during setup cannot mix releases.
    version = (await releaseAt(`${RELEASES}/latest/download`)).version
  } else {
    let candidates: string[]
    try {
      const releases: unknown = JSON.parse((await download(RELEASES_API, MAX_DISCOVERY_BYTES)).toString('utf8'))
      if (!Array.isArray(releases)) throw new Error('The AgentsServer releases response is invalid.')
      candidates = releases.flatMap(release => {
        const candidate = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : ''
        return release?.draft !== true && release?.prerelease === true
          && validVersion(candidate) && candidate.includes('-beta.') ? [candidate] : []
      })
    } catch (error) {
      if (!(error instanceof ReleaseHTTPError) || (error.status !== 403 && error.status !== 429)) throw error
      const html = (await download(RELEASES, MAX_DISCOVERY_BYTES)).toString('utf8')
      candidates = [...html.matchAll(/\/ZhengyiLuo\/AgentsServer\/releases\/tag\/v([^"'<>/?#\s]+)/g)]
        .map(match => match[1]).filter(candidate => validVersion(candidate) && candidate.includes('-beta.'))
    }
    candidates.sort((left, right) => compareReleaseVersions(right, left))
    if (!candidates.length) throw new Error('No published Beta AgentsServer release is available. No installer was started.')
    version = candidates[0]
  }
  return releaseAt(`${RELEASES}/download/v${version}`, version)
}
