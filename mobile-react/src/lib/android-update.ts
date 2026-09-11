export const ANDROID_RELEASES_API_URL = 'https://api.github.com/repos/ZhengyiLuo/AgentsDock-Releases/releases?per_page=100'
export const ANDROID_UPDATE_MANIFEST_ASSET = 'AgentsDock-android-update.json'
export const ANDROID_UPDATE_PACKAGE = 'com.zhengyiluo.agentsdock'
export const ANDROID_UPDATE_SIGNER_SHA256 = '3ff67f11c62187c52f18e48e7ecd3cf25aa1fcf21ba0477c9eb9e3feeab82e5a'
export const ANDROID_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000

export interface AndroidUpdateManifest {
  schemaVersion: 1
  channel: 'beta'
  tagName: string
  packageName: string
  versionName: string
  versionCode: number
  publishedAt: string
  signingCertificateSha256: string
  apk: {
    assetName: string
    sizeBytes: number
    sha256: string
  }
}

export interface AvailableAndroidUpdate extends AndroidUpdateManifest {
  downloadUrl: string
  releaseUrl: string
}

interface GitHubReleaseAsset {
  name: string
  size: number
  digest: string | null
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: GitHubReleaseAsset[]
}

export type AndroidUpdateManifestLoader = (url: string) => Promise<unknown>

export async function latestAndroidUpdate(
  releasesValue: unknown,
  currentVersionCode: number,
  loadManifest: AndroidUpdateManifestLoader,
): Promise<AvailableAndroidUpdate | null> {
  if (!Number.isSafeInteger(currentVersionCode) || currentVersionCode < 1) {
    throw new Error('Installed Android version code is invalid')
  }
  const releases = githubReleases(releasesValue)
    .filter(release => !release.draft && release.prerelease && release.tag_name.startsWith('android-v'))
    .sort((left, right) => Date.parse(right.published_at ?? '') - Date.parse(left.published_at ?? ''))
    .slice(0, 6)
  let best: AvailableAndroidUpdate | null = null
  for (const release of releases) {
    const manifestAsset = release.assets.find(asset => asset.name === ANDROID_UPDATE_MANIFEST_ASSET)
    if (!manifestAsset || !safeReleaseDownloadUrl(manifestAsset.browser_download_url)) continue
    try {
      const manifest = androidUpdateManifest(await loadManifest(manifestAsset.browser_download_url))
      const apkAsset = release.assets.find(asset => asset.name === manifest.apk.assetName)
      if (!apkAsset || !safeReleaseDownloadUrl(apkAsset.browser_download_url)) continue
      if (manifest.tagName !== release.tag_name) continue
      if (release.html_url !== githubReleaseUrl(manifest.tagName)) continue
      if (manifest.packageName !== ANDROID_UPDATE_PACKAGE) continue
      if (manifest.signingCertificateSha256 !== ANDROID_UPDATE_SIGNER_SHA256) continue
      if (manifest.apk.sizeBytes !== apkAsset.size) continue
      if (apkAsset.digest !== `sha256:${manifest.apk.sha256}`) continue
      if (manifest.versionCode <= currentVersionCode) continue
      if (!best || manifest.versionCode > best.versionCode) {
        best = {
          ...manifest,
          downloadUrl: apkAsset.browser_download_url,
          releaseUrl: release.html_url,
        }
      }
    } catch {
      // A malformed or partially uploaded release must not prevent a known-good
      // older beta from being discovered.
    }
  }
  return best
}

export function androidUpdateManifest(value: unknown): AndroidUpdateManifest {
  const manifest = objectValue(value, 'Android update manifest')
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported Android update manifest')
  if (manifest.channel !== 'beta') throw new Error('Unexpected Android update channel')
  const tagName = boundedString(manifest.tagName, 'tagName', 1, 120)
  if (!/^android-v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tagName)) throw new Error('Invalid Android update tag')
  const packageName = boundedString(manifest.packageName, 'packageName', 1, 160)
  const versionName = boundedString(manifest.versionName, 'versionName', 1, 80)
  const versionCode = positiveSafeInteger(manifest.versionCode, 'versionCode')
  const publishedAt = boundedString(manifest.publishedAt, 'publishedAt', 1, 80)
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Invalid Android update publication time')
  const signingCertificateSha256 = sha256Value(manifest.signingCertificateSha256, 'signingCertificateSha256')
  const apkValue = objectValue(manifest.apk, 'apk')
  const assetName = boundedString(apkValue.assetName, 'apk.assetName', 1, 180)
  if (!/^[A-Za-z0-9._-]+\.apk$/.test(assetName)) throw new Error('Invalid Android APK asset name')
  const sizeBytes = positiveSafeInteger(apkValue.sizeBytes, 'apk.sizeBytes')
  const sha256 = sha256Value(apkValue.sha256, 'apk.sha256')
  return {
    schemaVersion: 1,
    channel: 'beta',
    tagName,
    packageName,
    versionName,
    versionCode,
    publishedAt,
    signingCertificateSha256,
    apk: { assetName, sizeBytes, sha256 },
  }
}

export function safeReleaseDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/ZhengyiLuo/AgentsDock-Releases/releases/download/')
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

export function cachedAndroidUpdate(value: unknown): AvailableAndroidUpdate | null {
  try {
    const candidate = objectValue(value, 'cached Android update')
    const manifest = androidUpdateManifest(candidate)
    const downloadUrl = boundedString(candidate.downloadUrl, 'downloadUrl', 1, 500)
    const releaseUrl = boundedString(candidate.releaseUrl, 'releaseUrl', 1, 500)
    if (!safeReleaseDownloadUrl(downloadUrl)) return null
    const expectedReleaseUrl = githubReleaseUrl(manifest.tagName)
    if (releaseUrl !== expectedReleaseUrl) return null
    if (manifest.packageName !== ANDROID_UPDATE_PACKAGE) return null
    if (manifest.signingCertificateSha256 !== ANDROID_UPDATE_SIGNER_SHA256) return null
    return { ...manifest, downloadUrl, releaseUrl }
  } catch {
    return null
  }
}

function githubReleaseUrl(tagName: string): string {
  return `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/${encodeURIComponent(tagName)}`
}

export function updateDownloadPercent(written: number, expected: number): number {
  if (!Number.isFinite(written) || !Number.isFinite(expected) || expected <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((written / expected) * 100)))
}

function githubReleases(value: unknown): GitHubRelease[] {
  if (!Array.isArray(value)) throw new Error('GitHub release response is not an array')
  return value.map((candidate, index) => {
    const release = objectValue(candidate, `release ${index}`)
    const tagName = boundedString(release.tag_name, 'release tag', 1, 120)
    const htmlUrl = boundedString(release.html_url, 'release URL', 1, 500)
    const publishedAt = release.published_at == null ? null : boundedString(release.published_at, 'published_at', 1, 80)
    if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || !Array.isArray(release.assets)) {
      throw new Error('GitHub release shape is invalid')
    }
    return {
      tag_name: tagName,
      html_url: htmlUrl,
      draft: release.draft,
      prerelease: release.prerelease,
      published_at: publishedAt,
      assets: release.assets.map((assetValue, assetIndex) => {
        const asset = objectValue(assetValue, `release asset ${assetIndex}`)
        return {
          name: boundedString(asset.name, 'asset name', 1, 180),
          size: positiveSafeInteger(asset.size, 'asset size'),
          digest: asset.digest == null ? null : boundedString(asset.digest, 'asset digest', 1, 100),
          browser_download_url: boundedString(asset.browser_download_url, 'asset URL', 1, 500),
        }
      }),
    }
  })
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim() !== value) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`)
  return value as number
}

function sha256Value(value: unknown, label: string): string {
  const string = boundedString(value, label, 64, 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(string)) throw new Error(`${label} is invalid`)
  return string
}
