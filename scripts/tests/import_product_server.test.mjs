import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractProductServerImport, inspectProductServerImport, validateSignerArtifact } from '../import_product_server.mjs'

const SOURCE = 'a'.repeat(40), EXPORT = 'b'.repeat(40), ROOT_TREE = 'c'.repeat(40), SERVER_TREE = 'd'.repeat(40)
const VERSION = '1.0.7-beta.16', SIGNER = 'ZhengyiLuo/AgentsServer'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const options = () => ({ sourceSha: SOURCE, sourceRef: 'release/test-candidate', version: VERSION, signerRunId: '123' })
function provenance() {
  const run = { id: 123, run_attempt: 2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    path: '.github/workflows/server-npm-candidate.yml', head_sha: EXPORT, head_branch: 'release/test-signer',
    repository: { id: 456, full_name: SIGNER }, head_repository: { id: 456, full_name: SIGNER } }
  const artifact = { id: 789, expired: false, size_in_bytes: 42, digest: `sha256:${'e'.repeat(64)}`,
    name: `signed-product-server-${VERSION}-${SOURCE}-123-2`,
    workflow_run: { id: 123, head_sha: EXPORT, head_branch: run.head_branch, repository_id: 456, head_repository_id: 456 } }
  return { run, artifact, listing: { total_count: 1, artifacts: [artifact] } }
}

test('signer provenance requires exact controlled repository, run, workflow, attempt and artifact', () => {
  const f = provenance()
  assert.equal(validateSignerArtifact(f.run, f.listing, options()).artifact.id, 789)
  for (const change of [{ id: 124 }, { run_attempt: 1 }, { conclusion: 'failure' }, { status: 'in_progress' },
    { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { head_sha: 'main' }, { head_branch: 'feature/unreviewed' },
    { repository: { id: 456, full_name: 'fork/AgentsServer' } }, { head_repository: { id: 999, full_name: SIGNER } }]) {
    assert.throws(() => validateSignerArtifact({ ...f.run, ...change }, f.listing, options()))
  }
  for (const change of [{ expired: true }, { digest: '' }, { size_in_bytes: 0 }, { size_in_bytes: 501 * 1024 * 1024 },
    { id: 'unsafe' }, { name: 'signed-npm-server-something' }, { workflow_run: { ...f.artifact.workflow_run, head_sha: SOURCE } },
    { workflow_run: { ...f.artifact.workflow_run, head_repository_id: 999 } }]) {
    assert.throws(() => validateSignerArtifact(f.run, { total_count: 1, artifacts: [{ ...f.artifact, ...change }] }, options()))
  }
  for (const listing of [{ total_count: 101, artifacts: [f.artifact] }, { total_count: 2, artifacts: [f.artifact] },
    { total_count: 2, artifacts: [f.artifact, f.artifact] }]) assert.throws(() => validateSignerArtifact(f.run, listing, options()))
})

function fixture(t, mutation = '') {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-server-import-test-')), assets = join(directory, 'server')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(assets); mkdirSync(join(assets, 'npm')); mkdirSync(join(assets, 'legacy'))
  const f = provenance(), { privateKey, publicKey } = generateKeyPairSync('ed25519')
  execFileSync('python3', ['-c', `
import io,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]); version=sys.argv[2]; mutation=sys.argv[3]
runtime={'VERSION':(version+'\\n').encode(),'agent_server.py':b'server','update_runner.py':b'updater','install.sh':b'installer','release-public-key.pem':b'key'}
for npm in [True,False]:
    name='npm/server-'+version+'.tgz' if npm else 'legacy/agents-server-'+version+'.tar.gz'
    with tarfile.open(root/name,'w:gz') as archive:
        for name,data in runtime.items():
            if mutation=='runtime' and not npm and name=='agent_server.py': data=b'different'
            member=tarfile.TarInfo(('package/server/' if npm else 'agents-server-'+version+'/')+name)
            member.size=len(data); member.mode=0o755 if name=='install.sh' else 0o644
            archive.addfile(member,io.BytesIO(data))
        if npm:
            for name in ['package.json','README.md','LICENSE','NOTICE','npm/cli.cjs']:
                member=tarfile.TarInfo('package/'+name); member.size=1; archive.addfile(member,io.BytesIO(b'x'))
`, assets, VERSION, mutation])
  const common = { version: VERSION, track: 'beta', prerelease: true, commit: SOURCE, api_contract_version: 28 }
  const inventory = { schema: 1, version: VERSION, track: 'beta', sourceSha: SOURCE, artifacts: {} }
  for (const npm of [true, false]) {
    const folder = npm ? 'npm' : 'legacy', prefix = npm ? 'agents-server-npm-manifest' : 'agents-server-manifest'
    const archiveName = npm ? `server-${VERSION}.tgz` : `agents-server-${VERSION}.tar.gz`
    const payload = readFileSync(join(assets, folder, archiveName))
    const descriptor = { ...common, schema: npm ? 2 : 1,
      archive: { name: archiveName, size: payload.length, sha256: hash(payload),
        url: npm ? `https://registry.npmjs.org/@agentsdock/server/-/${archiveName}` : `https://github.com/${SIGNER}/releases/download/v${VERSION}/${archiveName}` } }
    if (npm) Object.assign(descriptor, { distribution: 'npm', minimum_server_api_contract: 8,
      npm: { name: '@agentsdock/server', version: VERSION, integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}` } })
    const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`)
    writeFileSync(join(assets, folder, `${prefix}.json`), bytes)
    writeFileSync(join(assets, folder, `${prefix}.sig`), sign(null, bytes, privateKey))
    inventory[npm ? 'npmManifestSha256' : 'legacyManifestSha256'] = hash(bytes)
    for (const name of [`${prefix}.json`, `${prefix}.sig`, archiveName]) {
      const content = readFileSync(join(assets, folder, name))
      inventory.artifacts[`${folder}/${name}`] = { size: content.length, sha256: hash(content) }
    }
  }
  writeFileSync(join(assets, 'product-server-bundle.json'), JSON.stringify(inventory))
  const archive = join(directory, 'signer-artifact.zip')
  const rezip = (zipMutation = '') => {
    execFileSync('python3', ['-c', `
import sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]); target=sys.argv[2]; mutation=sys.argv[3]
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file(): archive.write(file,str(file.relative_to(root)))
    if mutation=='extra': archive.writestr('../unexpected',b'unsafe')
    if mutation=='duplicate': archive.writestr('product-server-bundle.json',b'conflicting duplicate')
`, assets, archive, zipMutation], { stdio: 'pipe' })
    const bytes = readFileSync(archive)
    f.artifact.size_in_bytes = bytes.length; f.artifact.digest = `sha256:${hash(bytes)}`
  }
  rezip()
  const calls = [], client = { optional(path) {
    calls.push(path)
    if (path === `repos/${SIGNER}/actions/runs/123`) return f.run
    if (path === `repos/${SIGNER}/actions/runs/123/artifacts?per_page=100`) return f.listing
    if (path === `repos/ZhengyiLuo/AgentsDock/git/commits/${SOURCE}`) return { sha: SOURCE, tree: { sha: ROOT_TREE } }
    if (path === `repos/ZhengyiLuo/AgentsDock/compare/${SOURCE}...release%2Ftest-candidate`) return { status: 'identical', merge_base_commit: { sha: SOURCE } }
    if (path === `repos/${SIGNER}/git/commits/${EXPORT}`) return { sha: EXPORT, tree: { sha: f.exportTree ?? SERVER_TREE } }
    assert.fail(`Unexpected API call: ${path}`)
  } }
  const execute = (command, args, settings) => {
    if (command !== 'git') return execFileSync(command, args, settings)
    const expression = args.at(-1)
    if (expression === 'HEAD') return f.checkout ?? SOURCE
    if (expression === `${SOURCE}^{commit}`) return SOURCE
    if (expression === `${SOURCE}^{tree}`) return ROOT_TREE
    if (expression === `${SOURCE}:server`) return SERVER_TREE
    assert.deepEqual(args.slice(2), ['cat-file', '-t', SERVER_TREE]); return 'tree'
  }
  const dependencies = { client, execute, repositoryDirectory: '/synthetic/repository', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
  return { ...f, directory, assets, archive, calls, rezip, setExportTree: value => { f.exportTree = value },
    setCheckout: value => { f.checkout = value },
    inspect: changes => inspectProductServerImport({ ...options(), assets, archive, ...changes }, dependencies),
    extract: changes => extractProductServerImport({ ...options(), assets, archive, ...changes }, dependencies) }
}

test('imports only exact artifact bytes, current-key signatures, source/export tree and runtime parity without mutations', async t => {
  const f = fixture(t), report = await f.inspect()
  assert.equal(report.kind, 'artifact-only-server-import'); assert.equal(report.releaseAcceptance, false)
  assert.equal(report.sourceSha, SOURCE); assert.equal(report.exportSha, EXPORT)
  assert.equal(report.signerRunAttempt, '2'); assert.equal(report.signerArtifactDigest, f.artifact.digest)
  assert.equal(report.serverBundleSha256, hash(readFileSync(join(f.assets, 'product-server-bundle.json'))))
  assert.equal(f.calls.length, 5)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|descriptorBase64|signatureBase64/)
})

test('import rejects wrong export tree before inspecting downloaded artifacts', async t => {
  const f = fixture(t)
  f.run.head_sha = SOURCE
  await assert.rejects(f.inspect(), /provenance/)
  f.run.head_sha = EXPORT
  f.setExportTree('f'.repeat(40))
  await assert.rejects(f.inspect(), /export.*tree/)
  f.setExportTree(SERVER_TREE)
  f.setCheckout('e'.repeat(40))
  await assert.rejects(f.inspect(), /checkout differs/)
})

test('candidate import opt-in cannot bypass the disposable canonical runner guard', async t => {
  const f = fixture(t)
  await assert.rejects(f.inspect({ candidateRehearsal: 'false' }), /explicit true opt-in/)
  await assert.rejects(f.inspect({ candidateRehearsal: 'true' }), /Candidate replay requires/)
  f.setCheckout('e'.repeat(40))
  await assert.rejects(f.inspect(), /checkout differs/)
})

test('import requires original ZIP identity and exact extracted member bytes', async t => {
  const f = fixture(t)
  await assert.rejects(f.inspect({ archive: '' }), /original Actions ZIP/)
  f.artifact.digest = `sha256:${'0'.repeat(64)}`
  await assert.rejects(f.inspect(), /digest/)
  f.rezip('extra')
  await assert.rejects(f.inspect(), /exact seven/)
  f.rezip('duplicate')
  await assert.rejects(f.inspect(), /exact seven/)
  f.rezip()
  // Equivalent inventory with different formatting is still not the uploaded ZIP.
  const path = join(f.assets, 'product-server-bundle.json')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
  await assert.rejects(f.inspect(), /exact seven/)
})

test('import refuses mismatched archive runtime, tampered signatures and unsealed extra files', async t => {
  const divergent = fixture(t, 'runtime')
  await assert.rejects(divergent.inspect(), /identical valid runtime/)
  const f = fixture(t)
  writeFileSync(join(f.assets, 'npm/agents-server-npm-manifest.sig'), Buffer.alloc(64))
  f.rezip()
  await assert.rejects(f.inspect(), /signature/)
  const extra = fixture(t)
  writeFileSync(join(extra.assets, 'private.pem'), 'unexpected')
  extra.rezip()
  await assert.rejects(extra.inspect(), /Unexpected server bundle root/)
})

test('extraction creates only a new exact seven-file bundle after proving the original artifact', async t => {
  const f = fixture(t), destination = join(f.directory, 'extracted')
  const expected = await f.inspect()
  assert.deepEqual(await f.extract({ assets: destination }), expected)
  assert.deepEqual(await f.inspect({ assets: destination }), expected)
  await assert.rejects(f.extract({ assets: destination }), /new directory/)
  assert.deepEqual(await f.inspect({ assets: destination }), expected)
})

test('bad archive identity or unsafe ZIP member is rejected before creating an output directory', async t => {
  const f = fixture(t), destination = join(f.directory, 'must-not-exist')
  f.artifact.digest = `sha256:${'0'.repeat(64)}`
  await assert.rejects(f.extract({ assets: destination }), /digest/)
  assert.equal(existsSync(destination), false)
  for (const mutation of ['extra', 'duplicate']) {
    f.rezip(mutation)
    await assert.rejects(f.extract({ assets: destination }), /seven bounded regular/)
    assert.equal(existsSync(destination), false)
  }
})
