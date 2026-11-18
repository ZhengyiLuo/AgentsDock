import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../website/app.js', import.meta.url), 'utf8')
const apk = version => `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/android-v0.1.1-beta.${version}/AgentsDock-0.1.1-android-arm64-beta.${version}.apk`
const android = (version, date) => ({
  tag_name: `android-v0.1.1-beta.${version}`, published_at: date, prerelease: true,
  assets: [{ name: `AgentsDock-0.1.1-android-arm64-beta.${version}.apk`, browser_download_url: apk(version) }]
})
const currentAndroid = {
  tag_name: 'android-v0.1.4-beta.1', published_at: '2026-11-18T20:44:23Z', prerelease: true,
  html_url: 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/android-v0.1.4-beta.1',
  assets: [{
    name: 'AgentsDock-0.1.4-android-arm64-build12.apk',
    browser_download_url: 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/android-v0.1.4-beta.1/AgentsDock-0.1.4-android-arm64-build12.apk'
  }]
}
const currentApk = currentAndroid.assets[0].browser_download_url
const fullPage = () => Array.from({ length: 100 }, () => ({
  published_at: '2026-09-01T00:00:00Z', assets: []
}))

async function harness(language = 'en') {
  const elements = new Map()
  const sandbox = {
    URL,
    fetch: async () => ({ ok: true, json: async () => [] }),
    document: {
      documentElement: { lang: language },
      querySelector: selector => elements.get(selector)?.[0] || null,
      querySelectorAll: selector => elements.get(selector) || []
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  await new Promise(resolve => setImmediate(resolve))
  return { sandbox, elements }
}

test('Android discovery reaches page two and chooses the newest published APK', async () => {
  const { sandbox, elements } = await harness()
  const links = [{ href: apk(9) }, { href: apk(9) }]
  elements.set('a[data-dl="android"]', links)
  const first = fullPage()
  first[0] = android(7, '2026-08-17T00:00:00Z')
  const calls = []
  sandbox.fetch = async url => {
    calls.push(new URL(url))
    return { ok: true, json: async () => calls.length === 1 ? first : [
      android(9, '2026-10-27T04:09:42Z'),
      { ...android(11, '2026-10-29T00:00:00Z'), draft: true },
      android(10, '2026-10-28T00:00:00Z')
    ] }
  }
  await sandbox.loadAndroidRelease()
  assert.deepEqual(links.map(link => link.href), [apk(10), apk(10)])
  assert.deepEqual(calls.map(url => url.searchParams.get('page')), ['1', '2'])
  assert(calls.every(url => url.searchParams.get('per_page') === '100'))
})

test('a stale feed cannot replace the pinned APK with an older release', async () => {
  const { sandbox, elements } = await harness()
  const link = { href: apk(9) }
  elements.set('a[data-dl="android"]', [link])
  sandbox.fetch = async () => ({ ok: true, json: async () => [android(7, '2026-08-17T00:00:00Z')] })
  await sandbox.loadAndroidRelease()
  assert.equal(link.href, apk(9))
})

test('Android discovery accepts the build-numbered 0.1.4 APK without changing desktop links', async () => {
  const { sandbox, elements } = await harness()
  const links = [{ href: apk(9) }, { href: apk(9) }]
  const desktop = { href: 'https://example.com/unchanged.dmg' }
  elements.set('a[data-dl="android"]', links)
  elements.set('a[data-dl="macos"]', [desktop])
  sandbox.fetch = async () => ({ ok: true, json: async () => [android(9, '2026-10-27T04:09:42Z'), currentAndroid] })
  await sandbox.loadAndroidRelease()
  assert.deepEqual(links.map(link => link.href), [currentApk, currentApk])
  assert.equal(desktop.href, 'https://example.com/unchanged.dmg')
})

test('the pinned build 12 survives a stale feed that only contains 0.1.1 APKs', async () => {
  const { sandbox, elements } = await harness()
  const link = { href: currentApk }
  elements.set('a[data-dl="android"]', [link])
  sandbox.fetch = async () => ({ ok: true, json: async () => [android(9, '2026-10-27T04:09:42Z')] })
  await sandbox.loadAndroidRelease()
  assert.equal(link.href, currentApk)
})

for (const locale of ['', 'zh/']) {
  for (const name of ['index.html', 'iphone.html']) {
    test(`mobile downloads retain verified public destinations (${locale}${name})`, () => {
      const html = readFileSync(new URL(`../../website/${locale}${name}`, import.meta.url), 'utf8')
      const apkLinks = [...html.matchAll(/href="([^"]+\.apk)"/g)].map(match => match[1])
      assert.deepEqual(apkLinks, name === 'index.html' ? [currentApk, currentApk] : [currentApk])
      assert.doesNotMatch(html, /android-v0\.1\.1|0\.1\.1 beta\.9|build 11|build 196/)
      assert.ok(html.includes('href="https://apps.apple.com/us/app/agentsdock/id6769275751"'))
      assert.ok(html.includes('href="https://testflight.apple.com/join/2JjWy2Z2"'))
      if (name === 'iphone.html') {
        assert.ok(html.includes(`href="${currentAndroid.html_url}"`))
        assert.match(html, /AgentsDock 0\.1\.4 beta\.1 arm64 \(build 12\)/)
        assert.match(html, locale ? /内部测试版本不会通过此公开链接提供/ : /internal-only builds are not offered through this public link/)
      } else {
        assert.match(html, locale ? /arm64 · 测试版/ : /arm64 · Beta/)
      }
    })
  }
}

test('failure on a later page preserves the static APK fallback', async () => {
  const { sandbox, elements } = await harness()
  const link = { href: apk(9) }
  elements.set('a[data-dl="android"]', [link])
  let calls = 0
  sandbox.fetch = async () => ++calls === 1
    ? { ok: true, json: async () => fullPage() }
    : { ok: false, status: 403 }
  await sandbox.loadAndroidRelease()
  assert.equal(calls, 2)
  assert.equal(link.href, apk(9))
})

test('Android pagination is bounded and keeps an undiscovered pinned fallback', async () => {
  const { sandbox, elements } = await harness()
  const link = { href: apk(9) }
  elements.set('a[data-dl="android"]', [link])
  let calls = 0
  sandbox.fetch = async () => { calls += 1; return { ok: true, json: async () => fullPage() } }
  await sandbox.loadAndroidRelease()
  assert.equal(calls, 3)
  assert.equal(link.href, apk(9))
})

test('invalid API data preserves the pinned fallback', async () => {
  const { sandbox, elements } = await harness()
  const link = { href: apk(9) }
  elements.set('a[data-dl="android"]', [link])
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ message: 'unavailable' }) })
  await sandbox.loadAndroidRelease()
  assert.equal(link.href, apk(9))
})

test('pages without Android downloads do not fetch the Android release feed', async () => {
  const { sandbox } = await harness()
  sandbox.fetch = async () => { throw new Error('Unexpected request') }
  await sandbox.loadAndroidRelease()
})

for (const language of ['en', 'zh-Hans']) {
  test(`desktop links, version and release notes stay on stable releases (${language})`, async () => {
    const { sandbox, elements } = await harness(language)
    const label = { textContent: '' }
    const notes = { href: '', textContent: '' }
    const link = { href: '' }
    elements.set('#release-version', [label])
    elements.set('[data-release-notes]', [notes])
    elements.set('a[data-dl="macos"]', [link])
    const stable = {
      tag_name: 'v1.0.12', published_at: '2026-10-28T00:00:00Z',
      html_url: 'https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.12',
      assets: [{ name: 'AgentsDock-1.0.12-mac-universal.dmg', browser_download_url: 'https://example.com/stable.dmg' }]
    }
    sandbox.fetch = async () => ({ ok: true, json: async () => [
      { ...stable, tag_name: 'v2.0.0-beta.1', prerelease: true, published_at: '2026-10-29T00:00:00Z' }, stable
    ] })
    await sandbox.loadRelease()
    assert.equal(link.href, 'https://example.com/stable.dmg')
    assert.equal(label.textContent, language === 'en' ? 'Desktop 1.0.12' : '桌面版 1.0.12')
    assert.equal(notes.href, stable.html_url)
    assert.equal(notes.textContent, language === 'en' ? 'Release notes v1.0.12' : 'v1.0.12 发布说明')
  })
}
