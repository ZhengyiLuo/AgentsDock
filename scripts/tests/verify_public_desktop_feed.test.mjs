import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { REPOSITORIES, releaseTag } from '../direct-release-mirror.mjs'
import { verifyPublicDesktopFeed } from '../verify_public_desktop_feed.mjs'

const helper = fileURLToPath(new URL('../verify_public_desktop_feed.mjs', import.meta.url))
const suffixes = ['-mac.yml', '-linux.yml', '-linux-arm64.yml', '.yml']

function fixture({ version = '1.0.7-beta.6', track = 'beta', legacyTag = '' } = {}) {
  const identity = { version, track, legacyTag }
  const metadata = new Map(), responses = new Map(), apiReads = [], publicReads = [], waits = []
  for (const repository of REPOSITORIES) {
    const tag = releaseTag(repository, version, track, legacyTag)
    const release = { tag_name: tag, draft: false, prerelease: track === 'beta' }
    metadata.set(`repos/${repository}/releases/tags/${tag}`, release)
    metadata.set(`repos/${repository}/releases/latest`, track === 'stable' ? release : { tag_name: 'v1.0.6', draft: false, prerelease: false })
    responses.set(`https://github.com/${repository}/releases.atom`, { body: `<feed><entry><link href="https://github.com/${repository}/releases/tag/v${version}" /></entry><entry><link href="https://github.com/${repository}/releases/tag/v1.0.6" /></entry></feed>` })
    const root = track === 'beta' ? `https://github.com/${repository}/releases/download/v${version}/beta` : `https://github.com/${repository}/releases/latest/download/latest`
    for (const suffix of suffixes) responses.set(`${root}${suffix}`, { body: `version: ${version}\nfiles: []\n` })
  }
  const client = { optional(path) {
    apiReads.push(path)
    assert(metadata.has(path), `unexpected metadata read: ${path}`)
    const value = metadata.get(path)
    if (value instanceof Error) throw value
    return structuredClone(value)
  } }
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual')
    assert(options.signal instanceof AbortSignal)
    assert.equal(options.headers.authorization, undefined)
    assert.equal(options.method, undefined)
    publicReads.push(url)
    assert(responses.has(url), `unexpected public read: ${url}`)
    const { body = '', status = 200, headers = {} } = responses.get(url)
    return new Response(body, { status, headers })
  }
  const dependencies = { client, fetchImpl, attempts: 1, sleepImpl: async duration => { waits.push(duration) } }
  return { identity, metadata, responses, apiReads, publicReads, waits, dependencies, run: extra => verifyPublicDesktopFeed(identity, { ...dependencies, ...extra }) }
}

test('beta checks both public Atom feeds and all four discovered platform YAMLs', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), { version: f.identity.version, track: 'beta', repositories: REPOSITORIES, verified: true })
  assert.equal(f.apiReads.length, 4)
  assert.equal(f.publicReads.length, 10)
  for (const repository of REPOSITORIES) {
    assert(f.publicReads.includes(`https://github.com/${repository}/releases.atom`))
    for (const suffix of suffixes) assert(f.publicReads.includes(`https://github.com/${repository}/releases/download/v${f.identity.version}/beta${suffix}`))
  }
})

test('stable checks latest pointers and all four public latest/download YAMLs, retaining the legacy 1.0.0 alias', async () => {
  for (const identity of [{ version: '1.0.7', track: 'stable' }, { version: '1.0.0', track: 'stable', legacyTag: '1.0.0' }]) {
    const f = fixture(identity)
    await f.run()
    assert.equal(f.publicReads.length, 8)
    assert(!f.publicReads.some(url => url.endsWith('.atom')))
    for (const repository of REPOSITORIES) {
      const tag = releaseTag(repository, identity.version, identity.track, identity.legacyTag || '')
      assert(f.apiReads.includes(`repos/${repository}/releases/tags/${tag}`))
      for (const suffix of suffixes) assert(f.publicReads.includes(`https://github.com/${repository}/releases/latest/download/latest${suffix}`))
    }
  }
})

test('rejects a mismatched, missing or malformed YAML on either repository and every platform', async () => {
  for (const track of ['stable', 'beta']) {
    for (const repository of REPOSITORIES) {
      for (const suffix of suffixes) {
        for (const mutation of ['old', 'missing', 'duplicate', 'malformed']) {
          const version = track === 'beta' ? '1.0.7-beta.6' : '1.0.7'
          const f = fixture({ version, track })
          const root = track === 'beta' ? `https://github.com/${repository}/releases/download/v${version}/beta` : `https://github.com/${repository}/releases/latest/download/latest`
          f.responses.set(`${root}${suffix}`, mutation === 'missing' ? { status: 404 } : { body: mutation === 'old' ? 'version: 1.0.6\n' : mutation === 'duplicate' ? `version: ${version}\nversion: ${version}\n` : 'version: [invalid]\n' })
          await assert.rejects(f.run(), /did not resolve.*accepted version|unavailable|exactly one|malformed/)
        }
      }
    }
  }
})

test('supports the quoted YAML versions emitted by release metadata', async () => {
  for (const quote of ['"', "'"]) {
    const f = fixture()
    for (const [url] of f.responses) if (url.endsWith('.yml')) f.responses.set(url, { body: `version: ${quote}${f.identity.version}${quote}\r\nfiles: []\r\n` })
    await f.run()
  }
})

test('beta discovery uses SemVer order and rejects stale, missing, or newer beta selections in either feed', async () => {
  for (const repository of REPOSITORIES) {
    const f = fixture()
    const url = `https://github.com/${repository}/releases.atom`
    const link = version => `<entry><link href="https://github.com/${repository}/releases/tag/v${version}" /></entry>`
    f.responses.set(url, { body: `<feed>${link(f.identity.version)}${link('1.0.7-beta.5')}${link('1.0.6')}</feed>` })
    await f.run()
    for (const body of [`<feed>${link('1.0.7-beta.5')}</feed>`, '<feed/>', `<feed>${link(f.identity.version)}${link('1.0.7-beta.10')}</feed>`]) {
      f.responses.set(url, { body })
      await assert.rejects(f.run(), /beta discovery does not select/)
    }
  }
})

test('publication metadata must be public and on the requested channel', async () => {
  for (const repository of REPOSITORIES) {
    for (const identity of [{ version: '1.0.7-beta.6', track: 'beta' }, { version: '1.0.7', track: 'stable' }]) {
      for (const mutation of [null, { draft: true }, { prerelease: identity.track !== 'beta' }, { tag_name: 'v1.0.6' }]) {
        const f = fixture(identity)
        const path = `repos/${repository}/releases/tags/v${identity.version}`
        f.metadata.set(path, mutation === null ? null : { ...f.metadata.get(path), ...mutation })
        await assert.rejects(f.run(), /wrong tag, visibility or prerelease/)
      }
    }
  }
})

test('latest must select stable publication and must never select a beta; missing first stable is allowed only for beta', async () => {
  for (const repository of REPOSITORIES) {
    const path = `repos/${repository}/releases/latest`
    for (const identity of [{ version: '1.0.7-beta.6', track: 'beta' }, { version: '1.0.7', track: 'stable' }]) {
      const f = fixture(identity)
      for (const value of [{ tag_name: 'v1.0.7-beta.6', draft: false, prerelease: true }, { tag_name: `v${identity.version}`, draft: true, prerelease: false }]) {
        f.metadata.set(path, value)
        await assert.rejects(f.run(), /public latest|Public latest/)
      }
      f.metadata.set(path, null)
      if (identity.track === 'beta') await f.run()
      else await assert.rejects(f.run(), /Public latest/)
    }
  }
})

test('transient visibility failures retry only reads and success waits for both repositories', async () => {
  const f = fixture()
  const path = `repos/${REPOSITORIES[1]}/releases/tags/v${f.identity.version}`
  const release = f.metadata.get(path)
  f.metadata.set(path, null)
  const logs = []
  await f.run({ attempts: 6, log: message => logs.push(message), sleepImpl: async delay => {
    assert.equal(delay, 10000)
    f.waits.push(delay)
    f.metadata.set(path, release)
  } })
  assert.deepEqual(f.waits, [10000])
  assert.equal(logs.length, 1)
  assert.equal(f.apiReads.filter(value => value === path).length, 2)
  assert.equal(f.apiReads.filter(value => value.includes(`${REPOSITORIES[0]}/releases/tags/`)).length, 1)
})

test('permanent visibility and metadata API failures stop after six read-only attempts', async () => {
  for (const failure of [null, new Error('Synthetic metadata API unavailable')]) {
    const f = fixture()
    f.metadata.set(`repos/${REPOSITORIES[0]}/releases/tags/v${f.identity.version}`, failure)
    await assert.rejects(f.run({ attempts: 6 }), /metadata or beta discovery did not resolve/)
    assert.equal(f.apiReads.length, 6)
    assert.equal(f.waits.length, 5)
    assert.equal(f.publicReads.length, 0)
  }
})

test('public responses are bounded and redirects stay on trusted HTTPS GitHub hosts', async () => {
  const f = fixture()
  const url = `https://github.com/${REPOSITORIES[0]}/releases/download/v${f.identity.version}/beta-mac.yml`
  const cdn = 'https://release-assets.githubusercontent.com/synthetic/metadata'
  f.responses.set(url, { status: 302, headers: { location: cdn } })
  f.responses.set(cdn, { body: `version: ${f.identity.version}\n` })
  await f.run()
  for (const location of ['https://example.invalid/metadata', 'http://github.com/metadata', 'https://user:password@github.com/metadata']) {
    f.responses.set(url, { status: 302, headers: { location } })
    await assert.rejects(f.run(), /outside trusted GitHub hosts/)
    assert(!f.publicReads.includes(location))
  }
  f.responses.set(url, { status: 302, headers: { location: url } })
  await assert.rejects(f.run(), /redirect is invalid/)
  f.responses.set(url, { body: Buffer.alloc(2 * 1024 * 1024 + 1) })
  await assert.rejects(f.run(), /size limit/)
})

test('invalid identity, exceptional legacy aliases and unbounded retry options fail before reads', async () => {
  const f = fixture()
  for (const identity of [{ version: '1.0.7', track: 'beta' }, { version: '1.0.7-beta.6', track: 'stable' }, { ...f.identity, legacyTag: 'other' }, { version: '1.0.7', track: 'stable', legacyTag: '1.0.0' }]) {
    await assert.rejects(verifyPublicDesktopFeed(identity, f.dependencies), /versions must use|Legacy tag override/)
  }
  for (const options of [{ attempts: 0 }, { attempts: 7 }, { retryDelayMs: 10001 }]) await assert.rejects(f.run(options), /retry bounds/)
  assert.equal(f.apiReads.length, 0)
  assert.equal(f.publicReads.length, 0)
})

test('CLI consumes the workflow identity and performs only mocked metadata and public reads', t => {
  const f = fixture({ version: '1.0.0', track: 'stable', legacyTag: '1.0.0' })
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-public-feed-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const preload = join(directory, 'offline.mjs')
  writeFileSync(preload, `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const fixture = JSON.parse(process.env.TEST_PUBLIC_FEED)
childProcess.execFileSync = (command, args) => {
  if (command !== 'gh' || args[0] !== 'api' || args.length !== 2 || !Object.hasOwn(fixture.metadata, args[1])) throw Error('Unexpected command')
  return JSON.stringify(fixture.metadata[args[1]])
}
syncBuiltinESMExports()
globalThis.fetch = async (url, options) => {
  if (!Object.hasOwn(fixture.responses, url) || options.redirect !== 'manual' || options.headers.authorization) throw Error('Unexpected fetch')
  return new Response(fixture.responses[url].body)
}
`)
  const env = { ...process.env, NODE_OPTIONS: '', RELEASE_VERSION: f.identity.version, RELEASE_TRACK: f.identity.track, LEGACY_RELEASE_TAG: f.identity.legacyTag, TEST_PUBLIC_FEED: JSON.stringify({ metadata: Object.fromEntries(f.metadata), responses: Object.fromEntries(f.responses) }) }
  const result = spawnSync(process.execPath, ['--import', preload, helper], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).verified, true)
  const invalid = spawnSync(process.execPath, ['--import', preload, helper, '--publish'], { env, encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /without arguments/)
})

test('both publication entrypoints run the shared public verification after publication and before reporting completion', () => {
  for (const name of ['direct-desktop-release-publish.yml', 'product-release.yml']) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
    const start = workflow.indexOf(name === 'product-release.yml' ? '\n  publish-product:\n' : '\n  publish:\n')
    const publication = workflow.slice(start).split(/\n  [a-z][a-z-]+:\n/)[1]
    assert(publication.indexOf('direct-release-mirror.mjs publish') < publication.indexOf('verify_public_desktop_feed.mjs'))
    assert.match(publication, /name: Verify public updater metadata[\s\S]*RELEASE_VERSION:[\s\S]*RELEASE_TRACK:[\s\S]*run: node scripts\/verify_public_desktop_feed\.mjs/)
    if (name === 'product-release.yml') assert(publication.indexOf('verify_public_desktop_feed.mjs') < publication.indexOf('name: Record publication completion'))
    else assert.match(publication, /LEGACY_RELEASE_TAG: \$\{\{ inputs\.legacy_tag \}\}/)
  }
})
