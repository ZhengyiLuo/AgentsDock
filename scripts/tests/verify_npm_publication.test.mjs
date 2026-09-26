import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publicationPreflight, validateCandidate, verifyRegistry } from '../verify_npm_publication.mjs'

const MANIFEST = 'agents-server-npm-manifest.json'
const SIGNATURE = 'agents-server-npm-manifest.sig'
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

function fixture(t, { version = '1.0.4-beta.10', packageChanges = {} } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agentsdock-publication-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const archiveName = `server-${version}.tgz`
  const metadata = { name: '@agentsdock/server', version, repository: { url: 'git+https://github.com/ZhengyiLuo/AgentsDock.git' }, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' }, ...packageChanges }
  execFileSync('python3', ['-c', 'import io, sys, tarfile\ndata = sys.stdin.buffer.read()\nwith tarfile.open(sys.argv[1], "w:gz") as archive:\n    member = tarfile.TarInfo("package/package.json")\n    member.size = len(data)\n    archive.addfile(member, io.BytesIO(data))', join(directory, archiveName)], { input: JSON.stringify(metadata) })
  const bytes = readFileSync(join(directory, archiveName))
  const descriptor = { schema: 2, distribution: 'npm', version, track: version.includes('-') ? 'beta' : 'stable', prerelease: version.includes('-'), commit: 'a'.repeat(40), api_contract_version: 28, minimum_server_api_contract: 8, npm: { name: '@agentsdock/server', version, integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` }, archive: { name: archiveName, url: `https://registry.npmjs.org/@agentsdock/server/-/${archiveName}`, size: bytes.length, sha256: digest(bytes) } }
  const options = { directory, sourceSHA: descriptor.commit, appVersion: version, publicKey: publicKey.export({ format: 'pem', type: 'spki' }), release: { tagName: `npm-candidate-v${version}`, isDraft: true, assets: [MANIFEST, SIGNATURE, archiveName].map(name => ({ name })) } }
  function resign() {
    const manifest = Buffer.from(JSON.stringify(descriptor))
    writeFileSync(join(directory, MANIFEST), manifest)
    writeFileSync(join(directory, SIGNATURE), sign(null, manifest, privateKey))
    options.acceptedManifestSHA256 = digest(manifest)
  }
  resign()
  return { options, descriptor, bytes, resign }
}

function registry(candidate, bytes, { published = true, tag = candidate.descriptor.version, tags = {}, mutate = () => {} } = {}) {
  const { descriptor, distTag } = candidate
  const metadata = { name: '@agentsdock/server', 'dist-tags': { [distTag]: tag, ...tags }, versions: {} }
  for (const version of Object.values(metadata['dist-tags'])) {
    if (typeof version === 'string' && version !== descriptor.version) metadata.versions[version] = { name: descriptor.npm.name, version }
  }
  if (published) metadata.versions[descriptor.version] = { name: descriptor.npm.name, version: descriptor.version, dist: { integrity: descriptor.npm.integrity, tarball: descriptor.archive.url } }
  mutate(metadata)
  const requests = []
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error')
    requests.push(url)
    if (url === 'https://registry.npmjs.org/@agentsdock%2fserver') return new Response(JSON.stringify(metadata))
    assert.equal(url, descriptor.archive.url)
    return new Response(bytes)
  }
  return { fetchImpl, requests, metadata }
}

test('accepts the exact signed beta bundle and chooses beta; stable chooses latest', t => {
  for (const [version, expectedTag] of [['1.0.4-beta.10', 'beta'], ['1.0.4', 'latest']]) {
    const { options } = fixture(t, { version })
    const candidate = validateCandidate(options)
    assert.equal(candidate.distTag, expectedTag)
    assert.equal(candidate.archive, join(options.directory, `server-${version}.tgz`))
  }
})

test('inspect CLI validates accepted bytes offline without Actions outputs and rejects a wrong pin', t => {
  const { options } = fixture(t)
  const scripts = join(options.directory, 'scripts')
  const server = join(options.directory, 'server')
  mkdirSync(scripts)
  mkdirSync(server)
  // Exercise unchanged production CLI code in a disposable source tree whose
  // checked-in trust root is the fixture key. The CLI has no key override.
  for (const name of ['verify_npm_publication.mjs', 'stage_coordinated_release.mjs']) copyFileSync(new URL(`../${name}`, import.meta.url), join(scripts, name))
  writeFileSync(join(server, 'release-public-key.pem'), options.publicKey)
  writeFileSync(join(server, 'VERSION'), options.appVersion)
  const release = join(options.directory, 'draft.json')
  writeFileSync(release, JSON.stringify(options.release))
  const preload = join(options.directory, 'offline.mjs')
  writeFileSync(preload, 'globalThis.fetch = () => { throw Error("inspect must not access the network") }\n')
  const args = ['--import', preload, join(scripts, 'verify_npm_publication.mjs'), 'inspect', options.directory, options.sourceSHA, options.acceptedManifestSHA256, release]
  const env = { ...process.env, NODE_OPTIONS: '' }
  delete env.GITHUB_OUTPUT
  delete env.GITHUB_STEP_SUMMARY
  const expected = { version: options.appVersion, distTag: 'beta', archive: join(options.directory, `server-${options.appVersion}.tgz`), manifestSHA256: options.acceptedManifestSHA256 }
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', env })), expected)
  const output = join(options.directory, 'actions-output')
  writeFileSync(output, 'unchanged\n')
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output } })), expected)
  assert.equal(readFileSync(output, 'utf8'), 'unchanged\n')
  const invalid = [...args]
  invalid[6] = 'b'.repeat(64)
  assert.throws(() => execFileSync(process.execPath, invalid, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && error.stdout === '' && /accepted manifest hash/.test(error.stderr))
})

test('rejects changed acceptance hash, signature, source or version', t => {
  const { options } = fixture(t)
  assert.throws(() => validateCandidate({ ...options, acceptedManifestSHA256: 'b'.repeat(64) }), /accepted manifest hash/)
  assert.throws(() => validateCandidate({ ...options, sourceSHA: 'b'.repeat(40) }), /reviewed source commit/)
  assert.throws(() => validateCandidate({ ...options, appVersion: '1.0.4-beta.11' }), /exact staged app version/)
  writeFileSync(join(options.directory, SIGNATURE), Buffer.alloc(64))
  assert.throws(() => validateCandidate(options), /signature is invalid/)
})

test('requires the separate unpublished candidate and exact asset set', t => {
  const { options } = fixture(t)
  for (const change of [r => { r.isDraft = false }, r => { r.tagName = 'v1.0.4-beta.10' }, r => { r.assets.push({ name: 'AgentsDock.dmg' }) }, r => { r.assets.pop() }, r => { r.assets[2] = r.assets[1] }]) {
    const release = structuredClone(options.release)
    change(release)
    assert.throws(() => validateCandidate({ ...options, release }), /separate npm candidate draft/)
  }
})

test('rejects modified tarball, invalid signed URL, and symlink input', t => {
  const { options, descriptor, bytes, resign } = fixture(t)
  const archive = join(options.directory, descriptor.archive.name)
  writeFileSync(archive, Buffer.concat([bytes, Buffer.from('changed')]))
  assert.throws(() => validateCandidate(options), /Archive bytes/)
  writeFileSync(archive, bytes)
  descriptor.archive.url = 'https://example.com/package.tgz'
  resign()
  assert.throws(() => validateCandidate(options), /archive metadata/)
  descriptor.archive.url = `https://registry.npmjs.org/@agentsdock/server/-/${descriptor.archive.name}`
  resign()
  rmSync(archive)
  symlinkSync(join(options.directory, MANIFEST), archive)
  assert.throws(() => validateCandidate(options), /ELOOP/)
})

test('rejects a signed archive with wrong npm identity or lifecycle hooks', t => {
  for (const packageChanges of [{ name: '@other/server' }, { version: '1.0.4-beta.9' }, { scripts: { postinstall: 'exit 1' } }, { dependencies: { bad: '*' } }, { repository: { url: 'git+https://github.com/other/repo.git' } }, { publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', tag: 'latest' } }]) {
    const { options } = fixture(t, { packageChanges })
    assert.throws(() => validateCandidate(options), /Package identity|no lifecycle scripts/)
  }
})

test('permits a new version only when its channel tag advances', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const allowed = registry(candidate, bytes, { published: false, tag: '1.0.4-beta.9' })
  const { publish, snapshot } = await publicationPreflight(candidate, allowed)
  assert.equal(publish, true)
  assert.deepEqual(snapshot.distTags, { latest: null, beta: '1.0.4-beta.9' })
  assert.equal(allowed.requests.length, 1)
  for (const tag of ['1.0.4-beta.10', '1.0.4-beta.11', '1.0.4', '2.0.0', 'unexpected-tag']) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag })), /Refusing|unsupported version|existing matching package version/)
  }
})

test('retry verifies an already published exact version without requesting publication', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const remote = registry(candidate, bytes)
  const { publish, snapshot } = await publicationPreflight(candidate, remote)
  assert.equal(publish, false)
  assert.equal(snapshot.distTags.beta, candidate.descriptor.version)
  assert.equal(remote.requests.at(-1), candidate.descriptor.archive.url)
})

test('rejects existing versions with different metadata, changed tags or altered registry bytes', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  for (const mutate of [m => { m.versions[candidate.descriptor.version].dist.integrity = 'sha512-bad' }, m => { m.versions[candidate.descriptor.version].dist.tarball = 'https://example.com/archive.tgz' }]) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { mutate })), /differs from the accepted/)
  }
  await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { tag: '1.0.4-beta.11' })), /dist-tag/)
  const changed = Buffer.from(bytes)
  changed[changed.length - 1] ^= 1
  const { snapshot } = await publicationPreflight(candidate, registry(candidate, bytes))
  await assert.rejects(verifyRegistry(candidate, { ...registry(candidate, changed), snapshot }), /Archive bytes/)
  await assert.rejects(publicationPreflight(candidate, registry(candidate, changed)), /Archive bytes/)
})

test('registry verification checks actual tarball bytes after metadata matches', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const remote = registry(candidate, bytes)
  const { snapshot } = await publicationPreflight(candidate, registry(candidate, bytes))
  assert.deepEqual(await verifyRegistry(candidate, { ...remote, snapshot }), { version: candidate.descriptor.version, distTag: 'beta', integrity: candidate.descriptor.npm.integrity, verified: true })
  assert.equal(remote.requests.length, 2)
})

test('missing package requires first-publication bootstrap and registry failures fail closed', async t => {
  const candidate = validateCandidate(fixture(t).options)
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: async () => new Response('', { status: 404 }) }), /First publish.*interactively/)
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: async () => new Response('', { status: 503 }) }), /Registry request failed/)
})

test('rejects prerelease latest before publishing or accepting a retry, without registry mutations', async t => {
  for (const version of ['1.0.7-beta.6', '1.0.7']) {
    const { options, bytes } = fixture(t, { version })
    const candidate = validateCandidate(options)
    for (const published of [false, true]) {
      const remote = registry(candidate, bytes, { published, tag: published ? version : '1.0.7-beta.5', tags: { latest: '1.0.7-beta.5' } })
      const initialMetadata = structuredClone(remote.metadata)
      await assert.rejects(publicationPreflight(candidate, remote), /latest must select a stable version, never a prerelease/)
      assert.equal(remote.requests.length, 1)
      assert.deepEqual(remote.metadata, initialMetadata)
    }
  }
})

test('beta readback preserves stable latest exactly, including an absent first-stable tag', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  for (const latest of [undefined, '1.0.3']) {
    const tags = latest === undefined ? {} : { latest }
    const { snapshot } = await publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag: '1.0.4-beta.9', tags }))
    await verifyRegistry(candidate, { ...registry(candidate, bytes, { tags }), snapshot })
    for (const replacement of [undefined, '1.0.2', '1.0.3', '1.0.4', candidate.descriptor.version]) {
      if (replacement === latest) continue
      const changedTags = replacement === undefined ? {} : { latest: replacement }
      await assert.rejects(verifyRegistry(candidate, { ...registry(candidate, bytes, { tags: changedTags }), snapshot }), /untouched npm latest|latest must select a stable/)
    }
  }
})

test('stable publication preserves beta and supports the first stable latest tag', async t => {
  const { options, bytes } = fixture(t, { version: '1.0.4' })
  const candidate = validateCandidate(options)
  const tags = { beta: '1.0.4-beta.10' }
  const before = registry(candidate, bytes, { published: false, tags, mutate: metadata => { delete metadata['dist-tags'].latest } })
  const { publish, snapshot } = await publicationPreflight(candidate, before)
  assert.equal(publish, true)
  assert.equal(snapshot.distTags.latest, null)
  await verifyRegistry(candidate, { ...registry(candidate, bytes, { tags }), snapshot })
  for (const replacement of [undefined, '1.0.4-beta.9', '1.0.5-beta.1', '1.0.4']) {
    await assert.rejects(verifyRegistry(candidate, { ...registry(candidate, bytes, { tags: replacement === undefined ? {} : { beta: replacement } }), snapshot }), /untouched npm beta/)
  }
})

test('new beta must advance stable latest even if beta is absent or behind', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  for (const latest of ['1.0.4', '2.0.0']) {
    for (const omitBeta of [false, true]) {
      await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag: '1.0.4-beta.9', tags: { latest }, mutate: metadata => { if (omitBeta) delete metadata['dist-tags'].beta } })), /beta that does not advance.*stable/)
    }
  }
  const { publish } = await publicationPreflight(candidate, registry(candidate, bytes, { published: false, tags: { latest: '1.0.3' }, mutate: metadata => { delete metadata['dist-tags'].beta } }))
  assert.equal(publish, true)
})

test('stable latest cannot move backward and retries never repair a moved selected tag', async t => {
  const { options, bytes } = fixture(t, { version: '1.0.4' })
  const candidate = validateCandidate(options)
  for (const tag of ['1.0.5', '2.0.0']) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag })), /Refusing to move/)
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { tag })), /does not select the accepted version/)
  }
  assert.equal((await publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag: '1.0.3' }))).publish, true)
  assert.equal((await publicationPreflight(candidate, registry(candidate, bytes))).publish, false)
})

test('registry readback requires the snapshot for this candidate and the exact selected tag', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const { snapshot } = await publicationPreflight(candidate, registry(candidate, bytes))
  const remote = registry(candidate, bytes)
  for (const invalid of [undefined, null, {}, ...['schema', 'package', 'version', 'distTag', 'sourceSHA', 'manifestSHA256'].map(key => ({ ...snapshot, [key]: 'different' }))]) {
    await assert.rejects(verifyRegistry(candidate, { ...remote, snapshot: invalid }), /preflight snapshot bound/)
  }
  assert.equal(remote.requests.length, 0)
  await assert.rejects(verifyRegistry(candidate, { ...registry(candidate, bytes, { tag: '1.0.4-beta.11' }), snapshot }), /does not select the accepted version/)
  await assert.rejects(verifyRegistry(candidate, { ...remote, snapshot: { ...snapshot, distTags: { beta: snapshot.distTags.beta } } }), /invalid channel tags/)
})

test('both registry channels fail closed on malformed or dangling tags', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  for (const tag of ['latest', 'beta']) {
    for (const value of [null, 1004, '', 'banana', '1.0.4-rc.1', '01.0.4']) {
      await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { tags: { [tag]: value } })), /malformed|unsupported version/)
    }
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { tags: { [tag]: '1.0.3' }, mutate: metadata => { delete metadata.versions['1.0.3'] } })), /existing matching package version/)
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { tags: { [tag]: '1.0.3' }, mutate: metadata => { metadata.versions['1.0.3'].name = '@other/package' } })), /existing matching package version/)
  }
  for (const mutate of [metadata => { metadata.versions = [] }, metadata => { metadata['dist-tags'] = [] }, metadata => { metadata.name = '@other/package' }]) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { mutate })), /invalid package metadata/)
  }
})

test('CLI persists a candidate-bound snapshot once and requires it for post-publication verification', t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const scripts = join(options.directory, 'scripts')
  const server = join(options.directory, 'server')
  mkdirSync(scripts)
  mkdirSync(server)
  for (const name of ['verify_npm_publication.mjs', 'stage_coordinated_release.mjs']) copyFileSync(new URL(`../${name}`, import.meta.url), join(scripts, name))
  writeFileSync(join(server, 'release-public-key.pem'), options.publicKey)
  writeFileSync(join(server, 'VERSION'), options.appVersion)
  const release = join(options.directory, 'draft.json')
  const snapshotPath = join(options.directory, 'registry-before.json')
  const registryPath = join(options.directory, 'registry-response.json')
  const output = join(options.directory, 'actions-output')
  const preload = join(options.directory, 'registry-fixture.mjs')
  writeFileSync(release, JSON.stringify(options.release))
  writeFileSync(preload, `import { readFileSync } from 'node:fs'
globalThis.fetch = async (url, options) => {
  if (options.redirect !== 'error') throw Error('Redirects must be refused')
  if (options.method && options.method !== 'GET') throw Error('Registry must remain read-only')
  const fixture = JSON.parse(readFileSync(process.env.TEST_REGISTRY_PATH, 'utf8'))
  if (url === 'https://registry.npmjs.org/@agentsdock%2fserver') return new Response(JSON.stringify(fixture.metadata))
  if (url === fixture.archiveURL) return new Response(Buffer.from(fixture.archive, 'base64'))
  throw Error('Unexpected registry URL')
}
`)
  const writeRegistry = metadata => writeFileSync(registryPath, JSON.stringify({ metadata, archiveURL: candidate.descriptor.archive.url, archive: bytes.toString('base64') }))
  writeRegistry(registry(candidate, bytes, { published: false, tag: '1.0.4-beta.9', tags: { latest: '1.0.3' } }).metadata)
  const args = operation => ['--import', preload, join(scripts, 'verify_npm_publication.mjs'), operation, options.directory, options.sourceSHA, options.acceptedManifestSHA256, release, snapshotPath]
  const env = { ...process.env, NODE_OPTIONS: '', TEST_REGISTRY_PATH: registryPath, GITHUB_OUTPUT: output }
  delete env.GITHUB_STEP_SUMMARY
  const run = operation => execFileSync(process.execPath, args(operation), { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(JSON.parse(run('preflight')).publish, true)
  assert.match(readFileSync(output, 'utf8'), /publish=true\narchive=.*\ndist_tag=beta\n/)
  const savedSnapshot = readFileSync(snapshotPath, 'utf8')
  assert.deepEqual(JSON.parse(savedSnapshot), { schema: 1, package: '@agentsdock/server', version: options.appVersion, distTag: 'beta', sourceSHA: options.sourceSHA, manifestSHA256: options.acceptedManifestSHA256, distTags: { latest: '1.0.3', beta: '1.0.4-beta.9' } })
  assert.throws(() => run('preflight'), error => error.status === 1 && /EEXIST/.test(error.stderr))
  assert.equal(readFileSync(snapshotPath, 'utf8'), savedSnapshot)
  writeRegistry(registry(candidate, bytes, { tags: { latest: '1.0.3' } }).metadata)
  assert.equal(JSON.parse(run('verify')).verified, true)
  writeRegistry(registry(candidate, bytes, { tags: { latest: '1.0.4' } }).metadata)
  assert.throws(() => run('verify'), error => error.status === 1 && /untouched npm latest/.test(error.stderr))
  assert.equal(readFileSync(snapshotPath, 'utf8'), savedSnapshot)
  for (const operation of ['preflight', 'verify']) {
    assert.throws(() => execFileSync(process.execPath, args(operation).slice(0, -1), { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && /REGISTRY_SNAPSHOT_JSON/.test(error.stderr))
  }
  rmSync(snapshotPath)
  symlinkSync(registryPath, snapshotPath)
  assert.throws(() => run('verify'), error => error.status === 1 && /ELOOP/.test(error.stderr))
})

test('immutable retry detects an untouched channel changing during byte verification', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const before = registry(candidate, bytes, { tags: { latest: '1.0.2' } })
  const after = registry(candidate, bytes, { tags: { latest: '1.0.3' } })
  let requests = 0
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: (...args) => (++requests === 1 ? before : after).fetchImpl(...args) }), /untouched npm latest/)
  assert.equal(requests, 2)
})
