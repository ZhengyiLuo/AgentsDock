// Download buttons carry a direct link to the current release as a no-JS
// fallback (see [data-dl] anchors in index.html). On load we ask the GitHub
// Releases API for the newest builds and upgrade each link in place, so the
// site always points at the latest version without a manual edit per release.
const DESKTOP_RELEASES_API = 'https://api.github.com/repos/ZhengyiLuo/AgentsDock/releases?per_page=30'
const ANDROID_RELEASES_API = 'https://api.github.com/repos/ZhengyiLuo/AgentsDock-Releases/releases?per_page=30'

// Match the right asset for each platform button by file-name pattern.
const ASSET_MATCHERS = {
  macos: /mac-universal\.dmg$/i,
  linux: /linux-x86_64\.AppImage$/i,
  'linux-arm64': /linux-arm64\.AppImage$/i,
  windows: /win-x64\.exe$/i,
  android: /\.apk$/i
}

function setPlatformHref(platform, url) {
  if (!url) return
  document.querySelectorAll(`a[data-dl="${platform}"]`).forEach(a => { a.href = url })
}

function findAsset(release, matcher) {
  const asset = (release?.assets || []).find(a => matcher.test(a.name))
  return asset && asset.browser_download_url
}

async function loadReleases(url) {
  let releases
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Releases API returned ${res.status}`)
    releases = await res.json()
    if (!Array.isArray(releases) || !releases.length) throw new Error('No releases')
  } catch {
    return [] // keep the hardcoded fallback links + copy already in the HTML
  }

  // Newest release first — by publish date, INCLUDING betas/prereleases, so
  // every button tracks the absolute latest build (not just the latest stable).
  return releases
    .filter(r => !r.draft)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
}

async function loadRelease() {
  // Desktop releases moved to the public source repository. A failed lookup
  // keeps its canonical HTML links; the older mirror must not replace them.
  const sorted = await loadReleases(DESKTOP_RELEASES_API)

  // The newest release that actually ships each platform's asset. Desktop
  // builds (dmg/AppImage/exe) travel together; Android ships in its own release.
  const latestWith = matcher => sorted.find(r => (r.assets || []).some(a => matcher.test(a.name)))

  const desktop = latestWith(ASSET_MATCHERS.macos)
  if (desktop) {
    setPlatformHref('macos', findAsset(desktop, ASSET_MATCHERS.macos))
    setPlatformHref('linux', findAsset(latestWith(ASSET_MATCHERS.linux), ASSET_MATCHERS.linux))
    setPlatformHref('linux-arm64', findAsset(latestWith(ASSET_MATCHERS['linux-arm64']), ASSET_MATCHERS['linux-arm64']))
    setPlatformHref('windows', findAsset(latestWith(ASSET_MATCHERS.windows), ASSET_MATCHERS.windows))
    const version = (desktop.tag_name || '').replace(/^v/, '')
    const label = document.querySelector('#release-version')
    if (label && version) label.textContent = `Version ${version}`
  }

}

async function loadAndroidRelease() {
  // Android still publishes separately to the legacy repository.
  const sorted = await loadReleases(ANDROID_RELEASES_API)
  const android = sorted.find(r => (r.assets || []).some(a => ASSET_MATCHERS.android.test(a.name)))
  setPlatformHref('android', findAsset(android, ASSET_MATCHERS.android))
}

loadRelease()
loadAndroidRelease()


// Live star count for the hero GitHub chip (falls back to the number in the HTML).
;(async () => {
  const els = document.querySelectorAll('[data-gh-stars]')
  if (!els.length) return
  try {
    const res = await fetch('https://api.github.com/repos/ZhengyiLuo/AgentsDock', { cache: 'no-store' })
    if (!res.ok) return
    const { stargazers_count: n } = await res.json()
    if (typeof n !== 'number') return
    const text = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n)
    els.forEach(el => { el.textContent = text })
  } catch {}
})()
