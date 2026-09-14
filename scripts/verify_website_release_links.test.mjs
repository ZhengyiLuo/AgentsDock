import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(new URL('../website/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../website/index.html', import.meta.url), 'utf8')
const canonical = 'https://api.github.com/repos/ZhengyiLuo/AgentsDock/releases?per_page=30'
const legacy = 'https://api.github.com/repos/ZhengyiLuo/AgentsDock-Releases/releases?per_page=30'
const desktopPlatforms = ['macos', 'linux', 'linux-arm64', 'windows']
const suffixes = { macos: 'mac-universal.dmg', linux: 'linux-x86_64.AppImage', 'linux-arm64': 'linux-arm64.AppImage', windows: 'win-x64.exe', android: 'android-arm64.apk' }
const release = (repo, version, date, platforms = desktopPlatforms, extra = {}) => ({
  tag_name: `v${version}`, published_at: date, draft: false,
  assets: platforms.map(platform => ({ name: `AgentsDock-${version}-${suffixes[platform]}`, browser_download_url: `https://github.com/ZhengyiLuo/${repo}/releases/download/v${version}/AgentsDock-${version}-${suffixes[platform]}` })), ...extra
})
const stable = release('AgentsDock', '1.0.0', '2026-09-14T23:20:43Z')
const oldBeta = release('AgentsDock-Releases', '1.0.0-beta.2', '2026-09-15T00:00:00Z')
const android = release('AgentsDock-Releases', '0.1.1-beta.8', '2026-09-15T00:01:00Z', ['android'])
const response = body => ({ ok: true, json: async () => body })
const flush = () => new Promise(resolve => setImmediate(resolve))

async function render(replies) {
  const links = new Map()
  for (const [, platform, href] of html.matchAll(/<a\b[^>]*data-dl="([^"]+)"[^>]*href="([^"]+)"/g)) {
    if (!links.has(platform)) links.set(platform, [])
    links.get(platform).push({ href })
  }
  const initial = new Map([...links].map(([key, values]) => [key, values.map(value => value.href)]))
  const label = { textContent: html.match(/id="release-version">([^<]+)/)[1] }
  const calls = []
  const pending = vm.runInNewContext(script, {
    document: {
      querySelectorAll: selector => links.get(selector.match(/data-dl="([^"]+)"/)[1]) || [],
      querySelector: selector => selector === '#release-version' ? label : null
    },
    fetch: async (url, options) => {
      calls.push({ url, options })
      assert(Object.hasOwn(replies, url), 'Unexpected release endpoint')
      const reply = replies[url]
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply() : reply
    },
    setTimeout: () => assert.fail('No download polling or timers'),
    setInterval: () => assert.fail('No download polling or timers')
  })
  await flush()
  assert.deepEqual(calls.map(call => call.url).sort(), [canonical, legacy].sort())
  assert(calls.every(call => call.options.cache === 'no-store'))
  return { links, initial, label, calls, pending }
}

function expectDesktop(state, version) {
  for (const platform of desktopPlatforms) {
    assert.equal(state.links.get(platform).length, 2)
    for (const link of state.links.get(platform)) assert.equal(link.href, `https://github.com/ZhengyiLuo/AgentsDock/releases/download/v${version}/AgentsDock-${version}-${suffixes[platform]}`)
  }
  assert.equal(state.label.textContent, `Version ${version}`)
}

test('canonical desktop wins over a later legacy beta; Android stays on its legacy feed', async () => {
  const state = await render({ [canonical]: response([stable]), [legacy]: response([oldBeta, android]) })
  expectDesktop(state, '1.0.0')
  assert(state.links.get('android').every(link => link.href === android.assets[0].browser_download_url))
})

for (const [name, failed] of [
  ['HTTP failure', { ok: false, status: 403 }], ['network failure', new Error('Offline')],
  ['empty response', response([])], ['invalid response', response({ message: 'Unavailable' })]
]) test(`canonical ${name} retains stable fallbacks without legacy desktop downgrade`, async () => {
  const state = await render({ [canonical]: failed, [legacy]: response([oldBeta, android]) })
  expectDesktop(state, '1.0.0')
  for (const platform of desktopPlatforms) assert.deepEqual(state.links.get(platform).map(link => link.href), state.initial.get(platform))
  assert(state.links.get('android').every(link => link.href === android.assets[0].browser_download_url))
})

test('Android failure leaves its fallback untouched without blocking canonical desktop', async () => {
  const newer = release('AgentsDock', '1.1.0', '2026-09-20T00:00:00Z')
  const state = await render({ [canonical]: response([stable, newer]), [legacy]: new Error('Offline') })
  expectDesktop(state, '1.1.0')
  assert.deepEqual(state.links.get('android').map(link => link.href), state.initial.get('android'))
})

test('canonical newest-per-platform policy still includes prereleases but excludes drafts', async () => {
  const beta = release('AgentsDock', '1.1.0-beta.1', '2026-09-20T00:00:00Z', desktopPlatforms, { prerelease: true })
  const draft = release('AgentsDock', '9.0.0', '2026-09-21T00:00:00Z', desktopPlatforms, { draft: true })
  const state = await render({ [canonical]: response([draft, stable, beta]), [legacy]: response([]) })
  expectDesktop(state, '1.1.0-beta.1')
})

test('a pending Android lookup does not delay desktop links', async () => {
  let finish
  const newer = release('AgentsDock', '1.1.0', '2026-09-20T00:00:00Z')
  const state = await render({ [canonical]: response([newer]), [legacy]: () => new Promise(resolve => { finish = resolve }) })
  expectDesktop(state, '1.1.0')
  finish(response([android]))
  await state.pending
  assert(state.links.get('android').every(link => link.href === android.assets[0].browser_download_url))
  assert.equal(state.calls.length, 2)
})

test('a pending desktop lookup does not delay Android or replace stable fallbacks', async () => {
  let finish
  const state = await render({ [canonical]: () => new Promise(resolve => { finish = resolve }), [legacy]: response([oldBeta, android]) })
  expectDesktop(state, '1.0.0')
  assert(state.links.get('android').every(link => link.href === android.assets[0].browser_download_url))
  finish(response([stable]))
  await flush()
  expectDesktop(state, '1.0.0')
  assert.equal(state.calls.length, 2)
})
