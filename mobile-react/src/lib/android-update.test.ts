import {
  ANDROID_RELEASES_API_URL,
  ANDROID_UPDATE_MANIFEST_ASSET,
  ANDROID_UPDATE_PACKAGE,
  ANDROID_UPDATE_SIGNER_SHA256,
  androidUpdateManifest,
  cachedAndroidUpdate,
  latestAndroidUpdate,
  loadAndroidReleaseHistory,
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

async function assertRejects(callback: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await callback() } catch (error) {
    if (pattern.test(String(error))) return
    throw error
  }
  throw new Error(`Expected ${String(pattern)} to be rejected`)
}

const sha = 'a'.repeat(64)
const pageRequests: string[] = []
const paged = await loadAndroidReleaseHistory(async url => {
  pageRequests.push(url)
  return pageRequests.length === 1 ? Array.from({ length: 100 }, (_, index) => ({ tag_name: `desktop-${index}` })) : [{ tag_name: 'android-v0.1.1-beta.8' }]
})
assertEqual(paged.length, 101)
assertEqual(pageRequests.length, 2)
assertEqual(pageRequests[1], `${ANDROID_RELEASES_API_URL}&page=2`)
let boundedReads = 0
try {
  await loadAndroidReleaseHistory(async () => { boundedReads++; return Array(100).fill({}) })
  throw new Error('Expected incomplete history to fail')
} catch (error) {
  assert(/complete Android release history/.test(String(error)), 'Incomplete history must not mean up-to-date')
}
assertEqual(boundedReads, 5)
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

// Shared desktop releases can push the newest Android APK onto a later page.
const olderManifest = { ...manifest, versionCode: 3, tagName: 'android-v0.1.1-beta.1' }
const olderRelease = {
  ...release,
  tag_name: olderManifest.tagName,
  html_url: `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/${olderManifest.tagName}`,
}
const firstPage = [olderRelease, ...Array.from({ length: 99 }, (_, index) => ({
  ...release, tag_name: `desktop-${index}`, assets: [],
}))]
const loadTestManifest = async (url: string) => url.includes('beta.2') ? manifest : olderManifest
olderRelease.assets = release.assets.map(asset => ({
  ...asset, browser_download_url: asset.browser_download_url.replace(manifest.tagName, olderManifest.tagName),
}))
assertEqual(await latestAndroidUpdate(firstPage, 3, loadTestManifest), null)
for (let attempt = 0; attempt < 3; attempt++) {
  const history = await loadAndroidReleaseHistory(async url => url.endsWith('page=1') ? firstPage : [release])
  assertEqual((await latestAndroidUpdate(history, 3, loadTestManifest))?.versionCode, 4)
}
let secondPageFailed = false
try {
  const history = await loadAndroidReleaseHistory(async url => {
    if (url.endsWith('page=1')) return firstPage
    throw new Error('Network request failed')
  })
  await latestAndroidUpdate(history, 3, loadTestManifest)
} catch (error) {
  secondPageFailed = /Network request failed/.test(String(error))
}
assert(secondPageFailed, 'A failed later page must not report the installed version as current')

const forgedSigner = structuredClone(manifest) as Record<string, unknown>
forgedSigner.signingCertificateSha256 = 'c'.repeat(64)
await assertRejects(() => latestAndroidUpdate([release], 3, async () => forgedSigner), /Could not verify/)

const digestMismatch = structuredClone(release)
digestMismatch.assets[1].digest = `sha256:${'d'.repeat(64)}`
await assertRejects(() => latestAndroidUpdate([digestMismatch], 3, async () => manifest), /Could not verify/)

for (let attempt = 0; attempt < 3; attempt++) {
  await assertRejects(() => latestAndroidUpdate([release], 3, async () => {
    throw new Error('Network request failed')
  }), /Could not verify/)
  assertEqual((await latestAndroidUpdate([release], 3, async () => manifest))?.versionCode, 4)
}
const partialRelease = { ...release, assets: [release.assets[0]] }
await assertRejects(() => latestAndroidUpdate([partialRelease], 3, async () => manifest), /Could not verify/)
// A valid older update remains usable, but a failed newer manifest is never
// proof that an already-installed older version is current.
assertEqual((await latestAndroidUpdate([release, olderRelease], 2, async url => {
  if (url.includes('beta.2')) throw new Error('HTTP 503')
  return olderManifest
}))?.versionCode, 3)
await assertRejects(() => latestAndroidUpdate([release, olderRelease], 3, async url => {
  if (url.includes('beta.2')) throw new Error('HTTP 503')
  return olderManifest
}), /Could not verify/)

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
