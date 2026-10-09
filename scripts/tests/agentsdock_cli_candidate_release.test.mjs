import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { CliCandidateRelease, cliCandidateTag, stageCliCandidate, verifyCliCandidate } from '../agentsdock-cli-candidate-release.mjs'

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const integrity = bytes => `sha512-${hash(bytes, 'sha512', 'base64')}`

function fixture(t, version = '1.0.10-beta.5') {
  const work = mkdtempSync(join(tmpdir(), 'agentsdock-cli-handoff-test-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const sourceRoot = join(work, 'source'), source = join(sourceRoot, 'server/npm/agentsdock')
  const assets = join(work, 'cli'), npmAssets = join(work, 'runtime')
  for (const directory of [source, assets, npmAssets]) mkdirSync(directory, { recursive: true })
  const metadata = JSON.parse(readFileSync(new URL('../../server/npm/agentsdock/package.json', import.meta.url)))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(source, 'package.json'), JSON.stringify(metadata))
  writeFileSync(join(sourceRoot, 'server/VERSION'), version + '\n')
  writeFileSync(join(sourceRoot, 'server/release-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
  const files = { 'cli.cjs': '#!/usr/bin/env node\n// synthetic CLI\n', 'postinstall.cjs': '// synthetic hook\n',
    'README.md': 'Fixture\n', LICENSE: 'Fixture license\n', NOTICE: 'Fixture notice\n' }
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(['LICENSE', 'NOTICE'].includes(name) ? sourceRoot : source, name), bytes)
  const git = args => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet']); git(['add', '.'])
  git(['-c', 'user.name=CLI handoff fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic committed fixture'])
  const sourceSha = git(['rev-parse', 'HEAD']).trim()
  const stamped = { ...metadata, version, dependencies: { '@agentsdock/server': version } }
  delete stamped.private
  const members = Object.entries({ 'package.json': JSON.stringify(stamped, null, 2) + '\n', ...files })
    .map(([name, bytes]) => ({ name: `package/${name}`, bytes: Buffer.from(bytes).toString('base64'), mode: name === 'cli.cjs' ? 0o755 : 0o644 }))
  const archiveName = `agentsdock-${version}.tgz`
  execFileSync('python3', ['-c', `import base64, io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for item in json.load(sys.stdin):
        data = base64.b64decode(item['bytes'])
        entry = tarfile.TarInfo(item['name'])
        entry.size, entry.mode = len(data), item['mode']
        archive.addfile(entry, io.BytesIO(data))
`, join(assets, archiveName)], { input: JSON.stringify(members) })
  const bytes = readFileSync(join(assets, archiveName))
  const receipt = Buffer.from(JSON.stringify({ schema: 1, name: 'agentsdock', version, commit: sourceSha,
    runtime: { name: '@agentsdock/server', version },
    archive: { name: archiveName, sha256: hash(bytes), integrity: integrity(bytes), size: bytes.length } }))
  writeFileSync(join(assets, 'agentsdock-cli-receipt.json'), receipt)
  const runtimeBytes = Buffer.from('synthetic signed runtime bytes\n'), runtimeArchive = `server-${version}.tgz`
  const track = version.includes('-') ? 'beta' : 'stable'
  const descriptor = Buffer.from(JSON.stringify({ schema: 2, distribution: 'npm', version, track, prerelease: track === 'beta',
    commit: sourceSha, api_contract_version: 28, minimum_server_api_contract: 8,
    npm: { name: '@agentsdock/server', version, integrity: integrity(runtimeBytes) },
    archive: { name: runtimeArchive, url: `https://registry.npmjs.org/@agentsdock/server/-/${runtimeArchive}`,
      sha256: hash(runtimeBytes), size: runtimeBytes.length } }))
  writeFileSync(join(npmAssets, runtimeArchive), runtimeBytes)
  writeFileSync(join(npmAssets, 'agents-server-npm-manifest.json'), descriptor)
  writeFileSync(join(npmAssets, 'agents-server-npm-manifest.sig'), sign(null, descriptor, privateKey))
  return { sourceRoot, archiveName, options: { assets, npmAssets, version, track, sourceSha, sourceRef: 'release/1.0.10-beta.5',
    acceptedReceiptSha256: hash(receipt), acceptedManifestSha256: hash(descriptor), expectedLatest: 'absent' } }
}

class CandidateGitHub {
  constructor() { this.value = null; this.files = new Map(); this.writes = [] }
  release(repository, tag) {
    assert.equal(repository, 'ZhengyiLuo/AgentsDock')
    if (this.value) assert.equal(tag, this.value.tag_name)
    return structuredClone(this.value)
  }
  verifySourceTag(release, sha) { assert.equal(release.target_commitish, sha) }
  download(repository, tag, directory) {
    assert.equal(repository, 'ZhengyiLuo/AgentsDock'); assert.equal(tag, this.value.tag_name)
    for (const [name, bytes] of this.files) writeFileSync(join(directory, name), bytes)
  }
  run(args) {
    this.writes.push(args)
    assert.deepEqual(args.slice(0, 2), ['release', 'create'])
    for (const flag of ['--draft', '--prerelease', '--latest=false']) assert.ok(args.includes(flag))
    const paths = args.slice(3, args.indexOf('--repo'))
    this.files = new Map(paths.map(path => [basename(path), readFileSync(path)]))
    this.value = { tag_name: args[2], draft: true, target_commitish: args[args.indexOf('--target') + 1],
      body: args[args.indexOf('--notes') + 1], assets: paths.map(path => ({ name: basename(path) })) }
  }
}

test('stages only two exact source-bound CLI assets and leaves the runtime bundle separate', async t => {
  const f = fixture(t), client = new CandidateGitHub()
  const verified = await verifyCliCandidate(f.options.assets, f.options, f)
  assert.deepEqual(verified.names, ['agentsdock-1.0.10-beta.5.tgz', 'agentsdock-cli-receipt.json'])
  assert.equal(await new CliCandidateRelease(client, f).inspect(f.options), null)
  assert.equal(client.writes.length, 0)
  const result = await stageCliCandidate(f.options, { client, ...f })
  assert.equal(result.tag, cliCandidateTag(f.options.version))
  assert.equal(result.receiptSha256, f.options.acceptedReceiptSha256)
  assert.equal(result.manifestSha256, f.options.acceptedManifestSha256)
  assert.equal(result.expectedLatest, 'absent')
  assert.equal(result.staged, true)
  assert.equal(client.writes.length, 1)
  assert.equal(client.files.size, 2)
  assert.match(client.value.body, /Candidate type: agentsdock-cli-v1\n/)
  assert.match(client.value.body, /CLI latest baseline: absent\n/)
  await stageCliCandidate(f.options, { client, ...f })
  assert.equal(client.writes.length, 1)
})

test('stable candidate remains a private draft and cannot change npm or GitHub latest', async t => {
  const f = fixture(t, '1.0.10'), client = new CandidateGitHub()
  await stageCliCandidate(f.options, { client, ...f })
  assert.match(client.value.body, /Update track: stable\n/)
  assert.equal(client.value.draft, true)
  assert.equal(client.writes.length, 1)
})

test('invalid local artifacts or identity fail before any external write', async t => {
  for (const mutation of ['extra', 'archive', 'receipt', 'signature', 'source', 'track', 'source-ref', 'latest', 'manifest-pin', 'receipt-pin']) {
    const f = fixture(t), client = new CandidateGitHub()
    if (mutation === 'extra') writeFileSync(join(f.options.assets, 'unreviewed'), 'no')
    if (mutation === 'archive') writeFileSync(join(f.options.assets, f.archiveName), 'changed')
    if (mutation === 'receipt') writeFileSync(join(f.options.assets, 'agentsdock-cli-receipt.json'), '{}')
    if (mutation === 'signature') writeFileSync(join(f.options.npmAssets, 'agents-server-npm-manifest.sig'), Buffer.alloc(64))
    if (mutation === 'source') f.options.sourceSha = 'b'.repeat(40)
    if (mutation === 'track') f.options.track = 'stable'
    if (mutation === 'source-ref') f.options.sourceRef = 'release/../main'
    if (mutation === 'latest') f.options.expectedLatest = 'beta'
    if (mutation === 'manifest-pin') f.options.acceptedManifestSha256 = 'b'.repeat(64)
    if (mutation === 'receipt-pin') f.options.acceptedReceiptSha256 = 'b'.repeat(64)
    await assert.rejects(stageCliCandidate(f.options, { client, ...f }), undefined, mutation)
    assert.equal(client.writes.length, 0, mutation)
  }
})

test('existing conflicting or partially uploaded drafts are never overwritten or repaired', async t => {
  for (const mutation of ['published', 'source', 'body', 'runtime-pin', 'latest', 'missing', 'duplicate', 'bytes', 'receipt-bytes']) {
    const f = fixture(t), client = new CandidateGitHub()
    await stageCliCandidate(f.options, { client, ...f })
    if (mutation === 'published') client.value.draft = false
    if (mutation === 'source') client.value.target_commitish = 'b'.repeat(40)
    if (mutation === 'body') client.value.body += 'Source commit: changed\n'
    if (mutation === 'runtime-pin') client.value.body = client.value.body.replace(f.options.acceptedManifestSha256, 'b'.repeat(64))
    if (mutation === 'latest') client.value.body = client.value.body.replace('CLI latest baseline: absent', 'CLI latest baseline: 1.0.9')
    if (mutation === 'missing') client.value.assets.pop()
    if (mutation === 'duplicate') client.value.assets.push(client.value.assets[0])
    if (mutation === 'bytes') client.files.set(f.archiveName, Buffer.from('changed'))
    if (mutation === 'receipt-bytes') client.files.set('agentsdock-cli-receipt.json', Buffer.from('{}'))
    await assert.rejects(stageCliCandidate(f.options, { client, ...f }), undefined, mutation)
    assert.equal(client.writes.length, 1, mutation)
  }
})

test('a tag pointing elsewhere aborts both inspection and retry without writing', async t => {
  const f = fixture(t), client = new CandidateGitHub()
  const helper = new CliCandidateRelease(client, f)
  await helper.stage(f.options)
  client.verifySourceTag = () => { throw Error('source tag mismatch') }
  await assert.rejects(helper.inspect(f.options), /source tag mismatch/)
  await assert.rejects(helper.stage(f.options), /source tag mismatch/)
  assert.equal(client.writes.length, 1)
})

test('an orphan conflicting source tag prevents draft creation', async t => {
  const f = fixture(t), client = new CandidateGitHub()
  client.verifySourceTag = () => { throw Error('source tag mismatch') }
  await assert.rejects(stageCliCandidate(f.options, { client, ...f }), /source tag mismatch/)
  assert.equal(client.value, null)
  assert.equal(client.writes.length, 0)
})

test('CLI refuses incomplete, duplicate or unsupported options before GitHub use', () => {
  for (const args of [[], ['publish'], ['stage', '--assets', '/missing'],
    ['stage', ...Array(9).fill(['--assets', '/missing']).flat()]]) {
    assert.throws(() => execFileSync(process.execPath, [new URL('../agentsdock-cli-candidate-release.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && /Usage|Invalid CLI/.test(error.stderr))
  }
})
