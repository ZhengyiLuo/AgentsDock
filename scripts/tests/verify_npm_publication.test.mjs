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

function registry(candidate, bytes, { published = true, tag = candidate.descriptor.version, mutate = () => {} } = {}) {
  const { descriptor, distTag } = candidate
  const metadata = { name: '@agentsdock/server', 'dist-tags': { [distTag]: tag }, versions: {} }
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
  return { fetchImpl, requests }
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
  assert.equal(await publicationPreflight(candidate, allowed), true)
  assert.equal(allowed.requests.length, 1)
  for (const tag of ['1.0.4-beta.10', '1.0.4-beta.11', '1.0.4', '2.0.0', 'unexpected-tag']) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, bytes, { published: false, tag })), /Refusing|unsupported version/)
  }
})

test('retry verifies an already published exact version without requesting publication', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const remote = registry(candidate, bytes)
  assert.equal(await publicationPreflight(candidate, remote), false)
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
  await assert.rejects(verifyRegistry(candidate, registry(candidate, changed)), /Archive bytes/)
})

test('registry verification checks actual tarball bytes after metadata matches', async t => {
  const { options, bytes } = fixture(t)
  const candidate = validateCandidate(options)
  const remote = registry(candidate, bytes)
  assert.deepEqual(await verifyRegistry(candidate, remote), { version: candidate.descriptor.version, distTag: 'beta', integrity: candidate.descriptor.npm.integrity, verified: true })
  assert.equal(remote.requests.length, 2)
})

test('missing package requires first-publication bootstrap and registry failures fail closed', async t => {
  const candidate = validateCandidate(fixture(t).options)
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: async () => new Response('', { status: 404 }) }), /First publish.*interactively/)
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: async () => new Response('', { status: 503 }) }), /Registry request failed/)
})
