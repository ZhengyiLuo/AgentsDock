import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { officialElectronDownloader } from '../cache_electron_runtime.mjs'

const version = '43.1.1'
const name = `electron-v${version}-linux-x64.zip`
const canonical = `https://github.com/electron/electron/releases/download/v${version}/${name}`
const api = 'https://api.github.com/repos/electron/electron'
const bytes = Buffer.from('isolated runtime fixture, never executed')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const metadata = () => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ id: 123, name, state: 'uploaded', size: bytes.length, browser_download_url: 'https://untrusted.invalid/ignored' }] })

async function fixture(t, responses, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'electron-cache-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const downloader = officialElectronDownloader({ version, platform: 'linux', arch: 'x64', sha256,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      assert(responses.length, 'unexpected extra network request')
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    }, ...options })
  return { downloader, calls, target: join(directory, name) }
}

test('normal official download is checksum-verified without any API fallback', async t => {
  const f = await fixture(t, [new Response(bytes)])
  await f.downloader.download(canonical, f.target)
  assert.deepEqual(await readFile(f.target), bytes)
  assert.deepEqual(f.calls.map(call => call.url), [canonical])
  assert.equal(f.calls[0].init.credentials, 'omit')
})

for (const failure of [502, 503, 504, 'offline', 'timeout']) {
  test(`one official API fallback handles ${failure} without changing the pin`, async t => {
    const first = failure === 'offline' ? new TypeError('network unavailable')
      : failure === 'timeout' ? new DOMException('timeout', 'TimeoutError')
        : new Response('unavailable', { status: failure })
    const f = await fixture(t, [first, Response.json(metadata()), new Response(bytes)])
    await f.downloader.download(canonical, f.target)
    assert.deepEqual(await readFile(f.target), bytes)
    assert.deepEqual(f.calls.map(call => call.url), [canonical, `${api}/releases/tags/v${version}`, `${api}/releases/assets/123`])
    assert.equal(f.calls[2].init.headers.Accept, 'application/octet-stream')
    for (const { init } of f.calls) {
      assert.equal(init.credentials, 'omit')
      assert(init.signal instanceof AbortSignal)
      assert.equal(init.headers?.Authorization, undefined)
    }
  })
}

for (const status of [401, 403, 404, 429]) {
  test(`does not hide HTTP ${status} or retry an authentication/rate-limit/not-found error`, async t => {
    const f = await fixture(t, [new Response('no', { status })])
    await assert.rejects(f.downloader.download(canonical, f.target), new RegExp(`HTTP ${status}`))
    assert.equal(f.calls.length, 1)
  })
}

for (const fallback of [false, true]) {
  test(`rejects checksum mismatch on ${fallback ? 'API' : 'normal'} transport`, async t => {
    const responses = fallback ? [new Response('', { status: 504 }), Response.json(metadata())] : []
    const f = await fixture(t, [...responses, new Response('modified runtime')])
    await assert.rejects(f.downloader.download(canonical, f.target), /npm-pinned SHA-256/)
  })
}

test('API failure is fatal; there is no unbounded retry or alternate repository', async t => {
  const f = await fixture(t, [new Response('', { status: 504 }), new Response('', { status: 403 })])
  await assert.rejects(f.downloader.download(canonical, f.target), /lookup returned HTTP 403/)
  assert.equal(f.calls.length, 2)
})

for (const change of [
  m => { m.tag_name = 'v43.1.2' }, m => { m.draft = true }, m => { m.prerelease = true },
  m => { m.assets = [] }, m => { m.assets.push({ ...m.assets[0] }) },
  m => { m.assets[0].id = '../another' }, m => { m.assets[0].state = 'new' },
  m => { m.assets[0].size = 513 * 1024 * 1024 }
]) {
  test(`rejects unexpected release metadata: ${change}`, async t => {
    const m = metadata(); change(m)
    const f = await fixture(t, [new Response('', { status: 504 }), Response.json(m)])
    await assert.rejects(f.downloader.download(canonical, f.target), /exact published Electron artifact/)
    assert.equal(f.calls.length, 2)
  })
}

test('refuses unpinned versions, targets, checksums and noncanonical URLs', async t => {
  const good = { version, platform: 'linux', arch: 'x64', sha256 }
  for (const patch of [{ version: '^43.1.1' }, { platform: '../linux' }, { arch: '../x64' }, { sha256: '' }]) {
    assert.throws(() => officialElectronDownloader({ ...good, ...patch }), /exact Electron/)
  }
  const f = await fixture(t, [])
  await assert.rejects(f.downloader.download('https://untrusted.invalid/runtime.zip', f.target), /Unexpected Electron artifact URL/)
  assert.equal(f.calls.length, 0)
})

test('source CI warms the checked cache and still runs the original installer and complete checks', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const electron = workflow.slice(workflow.indexOf('\n  electron:'), workflow.indexOf('\n  mobile-source:'))
  const commands = ['pnpm install --frozen-lockfile', 'node ../scripts/cache_electron_runtime.mjs',
    'node node_modules/electron/install.js', 'pnpm typecheck', 'pnpm test', 'pnpm build']
  let previous = -1
  for (const command of commands) {
    const next = electron.indexOf(`run: ${command}`)
    assert(next > previous, command)
    previous = next
  }
  assert(!electron.includes('continue-on-error'))
  assert(!electron.includes('ELECTRON_SKIP_BINARY_DOWNLOAD'))
})
