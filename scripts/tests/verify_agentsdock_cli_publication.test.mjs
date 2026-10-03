import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { publicationPreflight, validateCandidate, verifyRegistry } from '../verify_agentsdock_cli_publication.mjs'

const REGISTRY = 'https://registry.npmjs.org'
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const integrity = bytes => `sha512-${digest(bytes, 'sha512', 'base64')}`

function fixture(t, { version = '1.0.10-beta.2', packageChanges = {}, sourceChanges = {}, mutateArchive = () => {}, expectedLatest = '1.0.9' } = {}) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'agentsdock-cli-publication-')))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const sourceRoot = join(work, 'source'), directory = join(work, 'cli'), runtimeDirectory = join(work, 'runtime')
  const source = join(sourceRoot, 'server/npm/agentsdock')
  for (const path of [source, directory, runtimeDirectory, join(sourceRoot, 'scripts')]) mkdirSync(path, { recursive: true })
  const sourceMetadata = { ...JSON.parse(readFileSync(new URL('../../server/npm/agentsdock/package.json', import.meta.url))), ...sourceChanges }
  writeFileSync(join(source, 'package.json'), JSON.stringify(sourceMetadata))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(sourceRoot, 'server/release-public-key.pem'), publicKey.export({ format: 'pem', type: 'spki' }))
  writeFileSync(join(sourceRoot, 'server/VERSION'), version + '\n')
  const sourceFiles = { 'cli.cjs': '#!/usr/bin/env node\n// fixture CLI\n', 'postinstall.cjs': '// fixture reviewed hook\n', 'README.md': 'Fixture CLI\n', LICENSE: 'Fixture license\n', NOTICE: 'Fixture notice\n' }
  for (const [name, bytes] of Object.entries(sourceFiles)) writeFileSync(join(['LICENSE', 'NOTICE'].includes(name) ? sourceRoot : source, name), bytes)
  for (const name of ['verify_agentsdock_cli_publication.mjs', 'verify_npm_publication.mjs', 'stage_coordinated_release.mjs']) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(sourceRoot, 'scripts', name))
  }
  const git = args => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['-c', 'user.name=CLI verifier fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic reviewed fixture'])
  const sourceSHA = git(['rev-parse', 'HEAD']).trim()
  const packageMetadata = { ...sourceMetadata, version, dependencies: { '@agentsdock/server': version }, ...packageChanges }
  delete packageMetadata.private
  const members = Object.entries({ 'package.json': JSON.stringify(packageMetadata, null, 2) + '\n', ...sourceFiles })
    .map(([name, bytes]) => ({ name: `package/${name}`, bytes: Buffer.from(bytes).toString('base64'), mode: name === 'cli.cjs' ? 0o755 : 0o644 }))
  mutateArchive(members)
  const archiveName = `agentsdock-${version}.tgz`
  execFileSync('python3', ['-c', `import base64, io, json, sys, tarfile
members = json.load(sys.stdin)
with tarfile.open(sys.argv[1], "w:gz") as archive:
    for item in members:
        data = base64.b64decode(item["bytes"])
        member = tarfile.TarInfo(item["name"])
        member.mode = item["mode"]
        member.size = len(data)
        if item.get("link"):
            member.type = tarfile.SYMTYPE
            member.linkname = "cli.cjs"
            member.size = 0
        archive.addfile(member, io.BytesIO(data))
`, join(directory, archiveName)], { input: JSON.stringify(members) })
  const bytes = readFileSync(join(directory, archiveName))
  const receipt = { schema: 1, name: 'agentsdock', version, commit: sourceSHA, runtime: { name: '@agentsdock/server', version },
    archive: { name: archiveName, sha256: digest(bytes), integrity: integrity(bytes), size: bytes.length } }
  const runtimeBytes = Buffer.from('Synthetic signed runtime archive fixture\n')
  const runtimeArchive = `server-${version}.tgz`
  const descriptor = { schema: 2, distribution: 'npm', version, track: version.includes('-') ? 'beta' : 'stable', prerelease: version.includes('-'), commit: sourceSHA,
    api_contract_version: 28, minimum_server_api_contract: 8, npm: { name: '@agentsdock/server', version, integrity: integrity(runtimeBytes) },
    archive: { name: runtimeArchive, url: `${REGISTRY}/@agentsdock/server/-/${runtimeArchive}`, sha256: digest(runtimeBytes), size: runtimeBytes.length } }
  writeFileSync(join(runtimeDirectory, runtimeArchive), runtimeBytes)
  const options = { directory, version, sourceSHA, sourceRoot, runtimeDirectory, expectedLatest }
  const resealReceipt = () => {
    const data = Buffer.from(JSON.stringify(receipt))
    writeFileSync(join(directory, 'agentsdock-cli-receipt.json'), data)
    options.acceptedReceiptSHA256 = digest(data)
  }
  const resign = () => {
    const manifest = Buffer.from(JSON.stringify(descriptor))
    writeFileSync(join(runtimeDirectory, 'agents-server-npm-manifest.json'), manifest)
    writeFileSync(join(runtimeDirectory, 'agents-server-npm-manifest.sig'), sign(null, manifest, privateKey))
    options.acceptedManifestSHA256 = digest(manifest)
  }
  resealReceipt(); resign()
  return { work, options, receipt, descriptor, bytes, runtimeBytes, resealReceipt, resign }
}

function registry(candidate, f, { published = true, missing = false, latest = candidate.expectedLatest, tag = candidate.version, mutate = () => {}, runtimeMutate = () => {}, cliBytes = f.bytes, runtimeBytes = f.runtimeBytes, runtimeStatus = 200, cliStatus = 200 } = {}) {
  const metadata = { name: 'agentsdock', 'dist-tags': { [candidate.distTag]: tag }, versions: {} }
  if (candidate.distTag === 'beta') {
    if (latest !== null) metadata['dist-tags'].latest = latest
  }
  if (published) metadata.versions[candidate.version] = { ...candidate.metadata, dist: { integrity: candidate.receipt.archive.integrity, tarball: candidate.archiveURL } }
  mutate(metadata)
  const runtime = { name: '@agentsdock/server', 'dist-tags': { [candidate.distTag]: candidate.version }, versions: {
    [candidate.version]: { name: '@agentsdock/server', version: candidate.version, dist: { integrity: candidate.descriptor.npm.integrity, tarball: candidate.descriptor.archive.url } },
  } }
  runtimeMutate(runtime)
  const requests = []
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, undefined)
    assert.equal(options.headers.authorization, undefined)
    requests.push(url)
    if (url === `${REGISTRY}/@agentsdock%2fserver`) return new Response(JSON.stringify(runtime), { status: runtimeStatus })
    if (url === candidate.descriptor.archive.url) return new Response(runtimeBytes)
    if (url === `${REGISTRY}/agentsdock`) return new Response(JSON.stringify(metadata), { status: missing ? 404 : cliStatus })
    assert.equal(url, candidate.archiveURL)
    return new Response(cliBytes)
  }
  return { fetchImpl, requests }
}

test('binds exact committed CLI content, receipt and signed runtime for beta and stable', t => {
  for (const version of ['1.0.10-beta.2', '1.0.10']) {
    const f = fixture(t, { version })
    const candidate = validateCandidate(f.options)
    assert.equal(candidate.distTag, version.includes('-') ? 'beta' : 'latest')
    assert.deepEqual(candidate.metadata.dependencies, { '@agentsdock/server': version })
    assert.equal(candidate.acceptedReceiptSHA256, f.options.acceptedReceiptSHA256)
  }
})

test('source comparison ignores dirty worktree bytes and checks immutable git blobs', t => {
  const f = fixture(t)
  writeFileSync(join(f.options.sourceRoot, 'server/npm/agentsdock/cli.cjs'), 'uncommitted unrelated work')
  assert.equal(validateCandidate(f.options).sourceSHA, f.options.sourceSHA)
})

test('accepts actual offline packager output and checkout-root legal documents without installation', t => {
  const f = fixture(t)
  const directory = join(f.work, 'actual-pack')
  const scripts = fileURLToPath(new URL('../../server/scripts/', import.meta.url))
  execFileSync('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\nfrom package_agentsdock_cli import prepare\nprepare(Path(sys.argv[2]), Path(sys.argv[3]), require_clean_source=True)',
    scripts, join(f.options.sourceRoot, 'server'), directory], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  const receipt = readFileSync(join(directory, 'agentsdock-cli-receipt.json'))
  const candidate = validateCandidate({ ...f.options, directory, acceptedReceiptSHA256: digest(receipt) })
  assert.equal(candidate.version, f.options.version)
  assert.equal(candidate.archive, join(directory, f.receipt.archive.name))
})

test('rejects wrong acceptance pins, source binding, version and latest baseline', t => {
  const f = fixture(t)
  for (const change of [{ acceptedReceiptSHA256: '0'.repeat(64) }, { acceptedManifestSHA256: '0'.repeat(64) }, { sourceSHA: 'HEAD' }, { version: '1.0.10-beta.3' }, { expectedLatest: undefined }, { expectedLatest: '1.0.9-beta.1' }]) {
    assert.throws(() => validateCandidate({ ...f.options, ...change }), /accepted|Explicit|committed|baseline/)
  }
  f.receipt.commit = 'b'.repeat(40); f.resealReceipt()
  assert.throws(() => validateCandidate(f.options), /receipt identity/)
})

test('rejects changed runtime signature, runtime source and local bytes', t => {
  const f = fixture(t)
  writeFileSync(join(f.options.runtimeDirectory, 'agents-server-npm-manifest.sig'), Buffer.alloc(64))
  assert.throws(() => validateCandidate(f.options), /signature is invalid/)
  f.descriptor.commit = 'b'.repeat(40); f.resign()
  assert.throws(() => validateCandidate(f.options), /share the reviewed source/)
  f.descriptor.commit = f.options.sourceSHA; f.resign()
  writeFileSync(join(f.options.runtimeDirectory, f.descriptor.archive.name), 'changed')
  assert.throws(() => validateCandidate(f.options), /Archive bytes/)
})

test('rejects metadata overrides even when the checksum receipt matches the tarball', t => {
  for (const packageChanges of [{ name: 'other' }, { dependencies: { '@agentsdock/server': '^1.0.10-beta.2' } }, { scripts: { postinstall: 'node other.cjs' } }, { scripts: { postinstall: 'node postinstall.cjs', prepare: 'bad' } }, { bin: { other: 'cli.cjs' } }, { optionalDependencies: { extra: '*' } }, { publishConfig: { access: 'public', registry: `${REGISTRY}/`, tag: 'latest' } }]) {
    assert.throws(() => validateCandidate(fixture(t, { packageChanges }).options), /metadata differs/)
  }
})

test('rejects an unreviewed hook or extra metadata even when committed source agrees', t => {
  for (const sourceChanges of [{ scripts: { postinstall: 'node changed.cjs' } }, { optionalDependencies: {} }]) {
    assert.throws(() => validateCandidate(fixture(t, { sourceChanges }).options), /unreviewed identity/)
  }
})

test('rejects changed source files, added files, duplicates, links and wrong modes', t => {
  for (const mutateArchive of [
    members => { members[1].bytes = Buffer.from('changed CLI').toString('base64') },
    members => { members.push({ ...members[1], name: 'package/.env' }) },
    members => { members.push(members[1]) },
    members => { members[1].link = true },
    members => { members[1].mode = 0o777 },
    members => { members.pop() },
    members => { members[1].name = 'package/../cli.cjs' },
  ]) assert.throws(() => validateCandidate(fixture(t, { mutateArchive }).options), /committed source bytes|allowlist/)
})

test('rejects changed tarball bytes, extra receipt fields and symlink inputs', t => {
  const f = fixture(t)
  const archive = join(f.options.directory, f.receipt.archive.name)
  writeFileSync(archive, Buffer.concat([f.bytes, Buffer.from('changed')]))
  assert.throws(() => validateCandidate(f.options), /archive bytes differ/)
  writeFileSync(archive, f.bytes)
  f.receipt.extra = true; f.resealReceipt()
  assert.throws(() => validateCandidate(f.options), /receipt identity/)
  delete f.receipt.extra; f.resealReceipt()
  rmSync(archive)
  symlinkSync(join(f.options.directory, 'agentsdock-cli-receipt.json'), archive)
  assert.throws(() => validateCandidate(f.options), /ELOOP/)
})

test('first CLI 404 permits only registry preconditions, never claims ownership', async t => {
  const f = fixture(t, { expectedLatest: 'absent' }), candidate = validateCandidate(f.options)
  const remote = registry(candidate, f, { missing: true })
  const result = await publicationPreflight(candidate, remote)
  assert.equal(result.publish, true)
  assert.equal(result.firstPublication, true)
  assert.equal(result.ownershipVerified, false)
  assert.equal(result.expectedLatest, null)
  assert.deepEqual(remote.requests, [`${REGISTRY}/@agentsdock%2fserver`, candidate.descriptor.archive.url, `${REGISTRY}/agentsdock`])
})

test('public scoped runtime must verify before CLI checks can allow publication', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  for (const changes of [{ runtimeStatus: 404 }, { runtimeStatus: 503 }, { runtimeBytes: Buffer.from('bad bytes') },
    { runtimeMutate: m => { m['dist-tags'].beta = '1.0.10-beta.1' } },
    { runtimeMutate: m => { m.versions[candidate.version].dist.integrity = 'bad' } }]) {
    const remote = registry(candidate, f, changes)
    await assert.rejects(publicationPreflight(candidate, remote))
    assert.equal(remote.requests.includes(`${REGISTRY}/agentsdock`), false)
  }
})

test('new beta advances its channel and preserves the explicit stable/latest baseline', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  assert.equal((await publicationPreflight(candidate, registry(candidate, f, { published: false, tag: '1.0.10-beta.1' }))).publish, true)
  for (const tag of ['1.0.10-beta.2', '1.0.10-beta.3', '1.0.10', '2.0.0', 'malformed']) {
    await assert.rejects(publicationPreflight(candidate, registry(candidate, f, { published: false, tag })), /Refusing|unsupported version/)
  }
  await assert.rejects(publicationPreflight(candidate, registry(candidate, f, { published: false, latest: '1.0.8' })), /latest tag/)
  await assert.rejects(publicationPreflight(candidate, registry(candidate, f, { missing: true })), /latest tag/)
  const superseded = validateCandidate({ ...f.options, expectedLatest: '1.0.10' })
  await assert.rejects(publicationPreflight(superseded, registry(superseded, f, { published: false, tag: '1.0.10-beta.1' })), /superseded/)
})

test('identical published retry verifies actual bytes without requesting republication', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  const remote = registry(candidate, f)
  const result = await publicationPreflight(candidate, remote)
  assert.equal(result.publish, false)
  assert.equal(result.firstPublication, false)
  assert.equal(remote.requests.at(-1), candidate.archiveURL)
})

test('post-publication verification checks exact bytes, beta tag and untouched latest', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  assert.deepEqual(await verifyRegistry(candidate, registry(candidate, f)), { version: candidate.version, distTag: 'beta', integrity: candidate.receipt.archive.integrity, verified: true, runtimeVerified: true, latestPreserved: true, latest: '1.0.9' })
  for (const options of [{ tag: '1.0.10-beta.1' }, { latest: candidate.version }, { latest: null }, { cliBytes: Buffer.from('bad bytes') }]) {
    await assert.rejects(verifyRegistry(candidate, registry(candidate, f, options)))
  }
  const first = validateCandidate({ ...f.options, expectedLatest: 'absent' })
  assert.equal((await verifyRegistry(first, registry(first, f, { latest: null }))).latest, null)
  await assert.rejects(verifyRegistry(first, registry(first, f, { latest: candidate.version })), /latest tag/)
})

test('existing versions with wrong dependency, hooks, bin or registry integrity never overwrite', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  for (const change of [v => { v.dependencies = { '@agentsdock/server': 'latest' } }, v => { v.scripts.postinstall = 'bad' }, v => { v.bin = {} }, v => { v.dist.integrity = 'bad' }, v => { v.dist.tarball = 'https://example.invalid/other.tgz' }]) {
    const remote = registry(candidate, f, { mutate: m => { m.versions[candidate.version] = structuredClone(m.versions[candidate.version]); change(m.versions[candidate.version]) } })
    await assert.rejects(publicationPreflight(candidate, remote), /Published CLI metadata/)
  }
})

test('registry-only dependency modifiers cannot shadow the exact pin despite an unchanged tarball', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  const additions = {
    optionalDependencies: { '@agentsdock/server': '1.0.9' },
    acceptDependencies: { '@agentsdock/server': '1.0.9' },
    peerDependencies: { '@agentsdock/server': '*' }, peerDependenciesMeta: { '@agentsdock/server': { optional: true } },
    devDependencies: { extra: '*' }, bundledDependencies: ['@agentsdock/server'], bundleDependencies: true,
    overrides: { '@agentsdock/server': '1.0.9' }, resolutions: { '@agentsdock/server': '1.0.9' },
    dependenciesMeta: { '@agentsdock/server': { optional: true } }, workspaces: ['*'],
    pnpm: { overrides: { '@agentsdock/server': '1.0.9' } }, packageManager: 'yarn@4.0.0',
    devEngines: { runtime: { name: 'other' } }, gypfile: true, installConfig: { hoistingLimits: 'workspaces' },
    _hasShrinkwrap: true, hasInstallScript: false,
    exports: './other.cjs', imports: { '#core': './other.cjs' }, config: { extra: true },
  }
  for (const [key, value] of Object.entries(additions)) {
    const remote = registry(candidate, f, { mutate: m => { m.versions[candidate.version][key] = value } })
    await assert.rejects(publicationPreflight(candidate, remote), /Published CLI metadata/)
    await assert.rejects(verifyRegistry(candidate, remote), /Published CLI metadata/)
  }
  const derived = registry(candidate, f, { mutate: m => Object.assign(m.versions[candidate.version], { _hasShrinkwrap: false, hasInstallScript: true }) })
  assert.equal((await publicationPreflight(candidate, derived)).publish, false)
  assert.equal((await verifyRegistry(candidate, derived)).verified, true)
})

test('stable uses latest intentionally and never rewrites a different public candidate', async t => {
  const f = fixture(t, { version: '1.0.10' }), candidate = validateCandidate(f.options)
  assert.equal((await publicationPreflight(candidate, registry(candidate, f, { published: false, tag: '1.0.9' }))).publish, true)
  const result = await verifyRegistry(candidate, registry(candidate, f))
  assert.equal(result.distTag, 'latest')
  assert.equal(result.latestPreserved, undefined)
  await assert.rejects(publicationPreflight(candidate, registry(candidate, f, { published: false, tag: '1.0.11' })), /latest tag/)
})

test('transport errors fail closed; post-publication 404 is never a successful verification', async t => {
  const f = fixture(t), candidate = validateCandidate(f.options)
  await assert.rejects(publicationPreflight(candidate, registry(candidate, f, { cliStatus: 503 })), /CLI registry request failed/)
  await assert.rejects(verifyRegistry(candidate, registry(candidate, f, { missing: true })), /CLI registry request failed/)
  const remote = registry(candidate, f)
  await assert.rejects(publicationPreflight(candidate, { fetchImpl: async (url, options) => url === `${REGISTRY}/agentsdock`
    ? new Response('x'.repeat(4 * 1024 * 1024 + 1)) : remote.fetchImpl(url, options) }), /size limit/)
})

test('inspect CLI is offline, read-only and validates explicit immutable inputs', t => {
  const f = fixture(t)
  const { options } = f
  const preload = join(f.work, 'offline.mjs')
  writeFileSync(preload, 'globalThis.fetch = () => { throw Error("inspect must be offline") }\n')
  const output = join(f.work, 'untouched-output')
  writeFileSync(output, 'unchanged\n')
  const args = ['--import', preload, join(options.sourceRoot, 'scripts/verify_agentsdock_cli_publication.mjs'), 'inspect', options.directory, options.version,
    options.sourceSHA, options.acceptedReceiptSHA256, options.runtimeDirectory, options.acceptedManifestSHA256, options.expectedLatest]
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output } }))
  assert.equal(result.registryVerified, false)
  assert.equal(result.acceptedReceiptSHA256, options.acceptedReceiptSHA256)
  assert.equal(result.distTag, 'beta')
  assert.equal(readFileSync(output, 'utf8'), 'unchanged\n')
  const invalid = [...args]; invalid[7] = '0'.repeat(64)
  assert.throws(() => execFileSync(process.execPath, invalid, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && error.stdout === '' && /receipt differs/.test(error.stderr))
})
