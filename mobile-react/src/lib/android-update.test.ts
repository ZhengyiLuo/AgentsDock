import {
  ANDROID_RELEASES_API_URL,
  ANDROID_UPDATE_MANIFEST_ASSET,
  ANDROID_UPDATE_PACKAGE,
  ANDROID_UPDATE_SIGNER_SHA256,
  androidUpdateManifest,
  cachedAndroidUpdate,
  latestAndroidUpdate,
  safeReleaseDownloadUrl,
  updateDownloadPercent,
} from './android-update'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
}

function assertThrows(callback: () => unknown, pattern: RegExp): void {
  try { callback() } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return
    throw error
  }
  throw new Error(`Expected ${String(pattern)} to be thrown`)
}

const sha = 'a'.repeat(64)
assertEqual(
  ANDROID_RELEASES_API_URL,
  'https://api.github.com/repos/ZhengyiLuo/AgentsDock-Releases/releases?per_page=100',
)
const manifest = {
  schemaVersion: 1,
  channel: 'beta',
  tagName: 'android-v0.1.1-beta.2',
  packageName: ANDROID_UPDATE_PACKAGE,
  versionName: '0.1.1',
  versionCode: 4,
  publishedAt: '2026-08-13T20:00:00Z',
  signingCertificateSha256: ANDROID_UPDATE_SIGNER_SHA256,
  apk: {
    assetName: 'AgentsDock-0.1.1-android-arm64-beta.2.apk',
    sizeBytes: 1234,
    sha256: sha,
  },
} as const
const release = {
  tag_name: manifest.tagName,
  html_url: `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/${manifest.tagName}`,
  draft: false,
  prerelease: true,
  published_at: manifest.publishedAt,
  assets: [
    {
      name: ANDROID_UPDATE_MANIFEST_ASSET,
      size: 600,
      digest: `sha256:${'b'.repeat(64)}`,
      browser_download_url: `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/${manifest.tagName}/${ANDROID_UPDATE_MANIFEST_ASSET}`,
    },
    {
      name: manifest.apk.assetName,
      size: manifest.apk.sizeBytes,
      digest: `sha256:${sha}`,
      browser_download_url: `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/${manifest.tagName}/${manifest.apk.assetName}`,
    },
  ],
}

const found = await latestAndroidUpdate([release], 3, async () => manifest)
assert(found, 'expected beta update')
assertEqual(found.versionCode, 4)
assertEqual(found.apk.sha256, sha)
assertEqual(await latestAndroidUpdate([release], 4, async () => manifest), null)

const forgedSigner = structuredClone(manifest) as Record<string, unknown>
forgedSigner.signingCertificateSha256 = 'c'.repeat(64)
assertEqual(await latestAndroidUpdate([release], 3, async () => forgedSigner), null)

const digestMismatch = structuredClone(release)
digestMismatch.assets[1].digest = `sha256:${'d'.repeat(64)}`
assertEqual(await latestAndroidUpdate([digestMismatch], 3, async () => manifest), null)

assertThrows(() => androidUpdateManifest({ ...manifest, versionCode: 0 }), /versionCode/)
assertThrows(() => androidUpdateManifest({ ...manifest, apk: { ...manifest.apk, assetName: '../bad.apk' } }), /asset name/)
assertThrows(() => androidUpdateManifest({ ...manifest, apk: { ...manifest.apk, sha256: 'nope' } }), /sha256/)
assertEqual(safeReleaseDownloadUrl(release.assets[1].browser_download_url), true)
assertEqual(safeReleaseDownloadUrl('https://example.com/AgentsDock.apk'), false)
assertEqual(safeReleaseDownloadUrl('http://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/x/a.apk'), false)
assertEqual(updateDownloadPercent(25, 100), 25)
assertEqual(updateDownloadPercent(150, 100), 100)
assertEqual(updateDownloadPercent(-1, 100), 0)
assertEqual(cachedAndroidUpdate(found)?.versionCode, 4)
assertEqual(cachedAndroidUpdate({ ...found, downloadUrl: 'https://example.com/bad.apk' }), null)

console.log('Android updater manifest regressions passed')
