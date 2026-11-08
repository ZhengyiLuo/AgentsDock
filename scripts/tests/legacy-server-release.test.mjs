import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { LEGACY_METADATA, LEGACY_REPOSITORY, LegacyServerRelease, verifyExportSource, verifyLegacyCandidate } from '../legacy-server-release.mjs'

const SOURCE = 'a'.repeat(40), EXPORT = 'b'.repeat(40), ROOT_TREE = 'c'.repeat(40), SERVER_TREE = 'd'.repeat(40)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t, { mutation = '', version = '1.0.7-beta.15' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-legacy-handoff-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const npmAssets = join(directory, 'npm'), assets = join(directory, 'legacy')
  mkdirSync(npmAssets); mkdirSync(assets)
  execFileSync('python3', ['-c', `
import io,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]); version=sys.argv[2]; mutation=sys.argv[3]
runtime={'VERSION':(version+'\\n').encode(),'agent_server.py':b'server','update_runner.py':b'updater','install.sh':b'installer','release-public-key.pem':b'key'}
for npm in [True,False]:
    filename=root/('npm/server-'+version+'.tgz' if npm else 'legacy/agents-server-'+version+'.tar.gz')
    with tarfile.open(filename,'w:gz',format=tarfile.PAX_FORMAT) as archive:
        payload=dict(runtime)
        if not npm and mutation=='bytes': payload['agent_server.py']=b'other server'
        if not npm and mutation=='missing': del payload['agent_server.py']
        if not npm and mutation=='extra': payload['extra.py']=b'other code'
        for name,data in payload.items():
            member=tarfile.TarInfo(('package/server/' if npm else 'agents-server-'+version+'/')+name)
            member.size=len(data); member.mode=0o755 if name in {'install.sh','update_runner.py'} else 0o644
            if not npm and mutation=='mode' and name=='install.sh': member.mode=0o644
            archive.addfile(member,io.BytesIO(data))
        if not npm and mutation=='link':
            member=tarfile.TarInfo('agents-server-'+version+'/link'); member.type=tarfile.SYMTYPE; member.linkname='/etc/passwd'; archive.addfile(member)
        if npm:
            for name in ['package.json','README.md','LICENSE','NOTICE','npm/cli.cjs']:
                member=tarfile.TarInfo('package/'+name); member.size=1; member.mode=0o644; archive.addfile(member,io.BytesIO(b'x'))
`, directory, version, mutation])
  const npmName = `server-${version}.tgz`, legacyName = `agents-server-${version}.tar.gz`
  const npmBytes = readFileSync(join(npmAssets, npmName)), legacyBytes = readFileSync(join(assets, legacyName))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const track = version.includes('-') ? 'beta' : 'stable'
  const shared = { version, track, prerelease: track === 'beta', api_contract_version: 28, commit: SOURCE }
  const npm = { ...shared, schema: 2, distribution: 'npm', minimum_server_api_contract: 8, npm: { name: '@agentsdock/server', version, integrity: `sha512-${createHash('sha512').update(npmBytes).digest('base64')}` }, archive: { name: npmName, url: `https://registry.npmjs.org/@agentsdock/server/-/${npmName}`, sha256: digest(npmBytes), size: npmBytes.length } }
  const legacy = { ...shared, schema: 1, archive: { name: legacyName, url: `https://github.com/${LEGACY_REPOSITORY}/releases/download/v${version}/${legacyName}`, sha256: digest(legacyBytes), size: legacyBytes.length } }
  function saveDescriptor(folder, name, descriptor) {
    const bytes = Buffer.from(JSON.stringify(descriptor))
    writeFileSync(join(folder, `${name}.json`), bytes)
    writeFileSync(join(folder, `${name}.sig`), sign(null, bytes, privateKey))
    return digest(bytes)
  }
  const acceptedManifestSha256 = saveDescriptor(npmAssets, 'agents-server-npm-manifest', npm)
  saveDescriptor(assets, 'agents-server-manifest', legacy)
  const options = { assets, npmAssets, version, track, sourceSha: SOURCE, sourceRef: 'release/1.0', exportSha: EXPORT, acceptedManifestSha256 }
  const execute = (command, args, settings) => {
    if (command !== 'git') return execFileSync(command, args, settings)
    assert.deepEqual(args.slice(0, 2), ['-C', '/synthetic/repository'])
    const expression = args.at(-1)
    if (expression === `${SOURCE}^{commit}`) return `${SOURCE}\n`
    if (expression === `${SOURCE}^{tree}`) return `${ROOT_TREE}\n`
    if (expression === `${SOURCE}:server`) return `${SERVER_TREE}\n`
    assert.deepEqual(args.slice(2), ['cat-file', '-t', SERVER_TREE])
    return 'tree\n'
  }
  return { options, npm, legacy, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey, execute, saveDescriptor }
}

class LegacyGitHub {
  constructor() { this.value = null; this.files = new Map(); this.writes = []; this.extraHistory = []; this.tag = null; this.sourceTree = ROOT_TREE; this.exportTree = SERVER_TREE; this.ancestry = 'ahead' }
  optional(path) {
    if (path === `repos/ZhengyiLuo/AgentsDock/git/commits/${SOURCE}`) return { sha: SOURCE, tree: { sha: this.sourceTree } }
    if (path === `repos/ZhengyiLuo/AgentsDock/compare/${SOURCE}...release%2F1.0`) return { status: this.ancestry, merge_base_commit: { sha: SOURCE } }
    if (path === `repos/${LEGACY_REPOSITORY}/git/commits/${EXPORT}`) return this.exportTree ? { sha: EXPORT, tree: { sha: this.exportTree } } : null
    if (path.startsWith(`repos/${LEGACY_REPOSITORY}/git/ref/tags/v`)) return this.tag ? { object: this.tag } : null
    if (path === `repos/${LEGACY_REPOSITORY}/git/tags/${'e'.repeat(40)}`) return { object: { type: 'commit', sha: EXPORT } }
    assert.fail(`Unexpected read: ${path}`)
  }
  release(repo, tag) { assert.equal(repo, LEGACY_REPOSITORY); if (this.value) assert.equal(tag, this.value.tag_name); return structuredClone(this.value) }
  history(repo) { assert.equal(repo, LEGACY_REPOSITORY); return [...this.extraHistory, ...(this.value ? [structuredClone(this.value)] : [])] }
  download(repo, tag, directory) { assert.equal(repo, LEGACY_REPOSITORY); for (const [name, bytes] of this.files) writeFileSync(join(directory, name), bytes) }
  run(args) {
    this.writes.push(args)
    assert.deepEqual(args.slice(0, 2), ['release', 'create'])
    assert.equal(args[args.indexOf('--repo') + 1], LEGACY_REPOSITORY)
    assert.ok(args.includes('--draft')); assert.ok(args.includes('--latest=false'))
    const names = args.slice(3, args.indexOf('--repo'))
    this.files = new Map(names.map(path => [basename(path), readFileSync(path)]))
    this.value = { tag_name: args[2], draft: true, target_commitish: args[args.indexOf('--target') + 1], body: args[args.indexOf('--notes') + 1], assets: names.map(path => ({ name: basename(path) })) }
  }
  publish(repo, tag, track) {
    assert.equal(repo, LEGACY_REPOSITORY); assert.equal(tag, this.value.tag_name)
    this.writes.push(['publish', tag, track]); this.value.draft = false; this.value.prerelease = track === 'beta'; this.tag = { type: 'commit', sha: this.value.target_commitish }
  }
}

function harness(f, client = new LegacyGitHub(), changes = {}) {
  const checks = []
  const helper = new LegacyServerRelease({ client, publicKey: f.publicKey, execute: f.execute, repositoryDirectory: '/synthetic/repository', registryVerifier: async value => { assert.deepEqual(value, f.npm); checks.push('npm') }, publicationVerifier: async value => { assert.deepEqual(value, f.npm); checks.push('public-paths') }, ...changes })
  return { helper, client, checks }
}

test('stages exactly three signed legacy assets, pins the actual export tag, and resumes without writes', async t => {
  const f = fixture(t), { helper, client } = harness(f)
  const result = await helper.stage(f.options)
  assert.equal(result.published, false); assert.equal(result.exportSha, EXPORT)
  assert.equal(client.files.size, 3); assert.equal(client.value.target_commitish, EXPORT)
  assert.match(client.value.body, new RegExp(`Source commit: ${SOURCE}`))
  assert.match(client.value.body, new RegExp(`Standalone export commit: ${EXPORT}`))
  assert.deepEqual(await helper.inspect(f.options), result)
  assert.deepEqual(await helper.stage(f.options), result)
  assert.equal(client.writes.length, 1)
})

test('source proof requires exact public canonical and exported trees plus reviewed ancestry', async t => {
  const f = fixture(t)
  for (const mutation of ['canonical-tree', 'export-tree', 'missing-export', 'ancestry', 'tag']) {
    const { helper, client } = harness(f)
    if (mutation === 'canonical-tree') client.sourceTree = 'e'.repeat(40)
    if (mutation === 'export-tree') client.exportTree = 'e'.repeat(40)
    if (mutation === 'missing-export') client.exportTree = null
    if (mutation === 'ancestry') client.ancestry = 'diverged'
    if (mutation === 'tag') client.tag = { type: 'commit', sha: SOURCE }
    await assert.rejects(helper.stage(f.options), /public|export|reviewed|tag/i)
    assert.equal(client.writes.length, 0)
  }
})

test('public export verification also runs the real git object/tree inspection locally', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-export-proof-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'server')); writeFileSync(join(directory, 'server', 'VERSION'), '1.0.7-beta.15\n')
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet'); git('add', 'server')
  git('-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source')
  const sourceSha = git('rev-parse', 'HEAD'), serverTree = git('rev-parse', 'HEAD:server'), rootTree = git('rev-parse', 'HEAD^{tree}')
  const options = { version: '1.0.7-beta.15', track: 'beta', sourceSha, sourceRef: 'main', exportSha: EXPORT }
  const client = { optional(path) {
    if (path.endsWith(`/git/commits/${sourceSha}`)) return { sha: sourceSha, tree: { sha: rootTree } }
    if (path.endsWith(`/${sourceSha}...main`)) return { status: 'identical', merge_base_commit: { sha: sourceSha } }
    assert.equal(path, `repos/${LEGACY_REPOSITORY}/git/commits/${EXPORT}`)
    return { sha: EXPORT, tree: { sha: serverTree } }
  } }
  assert.deepEqual(verifyExportSource(options, { client, repositoryDirectory: directory }), { sourceSha, exportSha: EXPORT, serverTree })
})

test('rejects signed runtime differences, executable-mode changes, missing/extra files and links before writes', async t => {
  for (const mutation of ['bytes', 'mode', 'missing', 'extra', 'link']) {
    const f = fixture(t, { mutation }), { helper, client } = harness(f)
    await assert.rejects(helper.stage(f.options), /runtime/)
    assert.equal(client.writes.length, 0)
  }
})

test('rejects changed signatures, hashes, identity, unsafe refs, extra assets and symlinks before writes', async t => {
  for (const mutation of ['signature', 'archive', 'accepted-hash', 'legacy-commit', 'source-ref', 'export-sha', 'extra', 'symlink', 'npm-bytes']) {
    const f = fixture(t), { helper, client } = harness(f)
    if (mutation === 'signature') writeFileSync(join(f.options.assets, LEGACY_METADATA[1]), Buffer.alloc(64))
    if (mutation === 'archive') writeFileSync(join(f.options.assets, f.legacy.archive.name), 'different')
    if (mutation === 'accepted-hash') f.options.acceptedManifestSha256 = '0'.repeat(64)
    if (mutation === 'legacy-commit') { f.legacy.commit = EXPORT; f.saveDescriptor(f.options.assets, 'agents-server-manifest', f.legacy) }
    if (mutation === 'source-ref') f.options.sourceRef = 'release/../main'
    if (mutation === 'export-sha') delete f.options.exportSha
    if (mutation === 'extra') writeFileSync(join(f.options.assets, 'extra.txt'), 'extra')
    if (mutation === 'symlink') { const path = join(f.options.assets, LEGACY_METADATA[0]); const bytes = readFileSync(path); rmSync(path); writeFileSync(join(f.options.assets, 'target'), bytes); symlinkSync('target', path) }
    if (mutation === 'npm-bytes') writeFileSync(join(f.options.npmAssets, f.npm.archive.name), 'different')
    await assert.rejects(helper.stage(f.options))
    assert.equal(client.writes.length, 0)
  }
})

test('never repairs a conflicting existing draft or public release', async t => {
  for (const mutation of ['target', 'body', 'assets', 'bytes', 'channel', 'tag']) {
    const f = fixture(t), { helper, client } = harness(f)
    await helper.stage(f.options)
    if (mutation === 'target') client.value.target_commitish = SOURCE
    if (mutation === 'body') client.value.body += 'Source commit: changed\n'
    if (mutation === 'assets') client.value.assets.pop()
    if (mutation === 'bytes') client.files.set(f.legacy.archive.name, Buffer.from('different'))
    if (mutation === 'channel') { client.value.draft = false; client.value.prerelease = false; client.tag = { type: 'commit', sha: EXPORT } }
    if (mutation === 'tag') client.tag = { type: 'commit', sha: SOURCE }
    await assert.rejects(helper.stage(f.options))
    assert.equal(client.writes.length, 1)
  }
})

test('publication requires explicit acceptance, an existing exact draft and public npm before its only write', async t => {
  const f = fixture(t), { helper, client, checks } = harness(f)
  await assert.rejects(helper.publish({ ...f.options, acceptedManifestSha256: undefined }), /accepted npm/)
  await assert.rejects(helper.publish(f.options), /draft is missing/)
  assert.equal(client.writes.length, 0)
  await helper.stage(f.options)
  assert.equal((await helper.publish(f.options)).published, true)
  assert.deepEqual(checks, ['npm', 'public-paths'])
  assert.deepEqual(client.writes[1], ['publish', `v${f.options.version}`, 'beta'])
  await helper.publish(f.options)
  await helper.stage(f.options)
  assert.equal(client.writes.length, 2)
  assert.deepEqual(checks, ['npm', 'public-paths', 'npm', 'public-paths'])
})

test('npm failure or draft mutation during registry verification prevents legacy publication', async t => {
  for (const mutation of ['npm', 'draft']) {
    const f = fixture(t), client = new LegacyGitHub()
    const { helper } = harness(f, client, { registryVerifier: async () => {
      if (mutation === 'npm') throw new Error('npm unavailable')
      client.value.body += 'Update track: stable\n'
    } })
    await helper.stage(f.options)
    await assert.rejects(helper.publish(f.options), /npm unavailable|identity/)
    assert.equal(client.writes.length, 1)
  }
})

test('failed public readback resumes exact published bytes without republishing', async t => {
  const f = fixture(t), client = new LegacyGitHub()
  let attempts = 0
  const { helper } = harness(f, client, { publicationVerifier: async () => { if (++attempts === 1) throw new Error('public propagation pending') } })
  await helper.stage(f.options)
  await assert.rejects(helper.publish(f.options), /propagation/)
  assert.equal((await helper.publish(f.options)).published, true)
  assert.equal(client.writes.length, 2); assert.equal(attempts, 2)
})

test('rejects stale versions without moving tags and correctly accepts stable publication and annotated export tags', async t => {
  const f = fixture(t, { version: '1.0.7' }), { helper, client } = harness(f)
  client.extraHistory = [{ tag_name: 'v1.0.8-beta.1', draft: false }]
  await assert.rejects(helper.stage(f.options), /must be greater/)
  assert.equal(client.writes.length, 0)
  client.extraHistory = []
  client.tag = { type: 'tag', sha: 'e'.repeat(40) }
  await helper.stage(f.options)
  await helper.publish(f.options)
  assert.deepEqual(client.writes[1], ['publish', 'v1.0.7', 'stable'])
})

test('candidate inspection alone never invokes a publishing client or needs acceptance', async t => {
  const f = fixture(t)
  delete f.options.acceptedManifestSha256
  const verified = await verifyLegacyCandidate(f.options, { publicKey: f.publicKey })
  assert.equal(verified.runtimeFiles, 5); assert.equal(verified.names.length, 3)
})
