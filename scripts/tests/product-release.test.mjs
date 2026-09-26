import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ACCEPTANCE_CHECKS, releaseIdentity, validateReceipt, verifyReceiptBundle, validatePreparationRun, validateAcceptance, receiptOutputs } from '../product-release.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceSha = 'a'.repeat(40), workflowSha = 'b'.repeat(40)
function receipt() {
  return { schema: 1, ...releaseIdentity('1.0.7-beta.15', sourceSha, 'main', workflowSha),
    exportSha: 'c'.repeat(40), prepareRunId: '100', prepareRunNumber: '3', buildNumber: '5003',
    desktopManifestSha256: 'd'.repeat(64), npmManifestSha256: 'e'.repeat(64), legacyManifestSha256: 'f'.repeat(64),
    serverBundleSha256: '1'.repeat(64), windowsSigning: 'signed' }
}

test('one product identity derives channel and preserves exact source/workflow pins', () => {
  assert.equal(releaseIdentity('1.0.7', sourceSha, 'release/1.0.7', workflowSha).track, 'stable')
  assert.equal(releaseIdentity('1.0.7-beta.15', sourceSha, 'main', workflowSha).track, 'beta')
  for (const version of ['01.0.7', 'v1.0.7', '1.0.7-rc.1', '1.0.7-beta.0', '1.0.7\n']) {
    assert.throws(() => releaseIdentity(version, sourceSha, 'main', workflowSha))
  }
  for (const ref of ['feature/x', 'release/../main', 'release/x.lock', 'release/x/', 'release/x\n']) {
    assert.throws(() => releaseIdentity('1.0.7', sourceSha, ref, workflowSha))
  }
  assert.throws(() => releaseIdentity('1.0.7', 'main', 'main', workflowSha))
})

test('receipt rejects missing pins, mismatched channel, old counter and invalid seals', () => {
  assert.equal(validateReceipt(receipt()).buildNumber, '5003')
  for (const change of [{ schema: 2 }, { track: 'stable' }, { buildNumber: '1188' }, { prepareRunId: '-1' },
    { prepareRunNumber: '5000', buildNumber: '10000' }, { exportSha: 'main' }, { windowsSigning: '' },
    ...['desktopManifestSha256', 'npmManifestSha256', 'legacyManifestSha256', 'serverBundleSha256'].map(key => ({ [key]: '' }))]) {
    assert.throws(() => validateReceipt({ ...receipt(), ...change }), JSON.stringify(change))
  }
})

function bundle(t, mutation = '') {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-product-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'npm')); mkdirSync(join(directory, 'legacy'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const value = receipt()
  execFileSync('python3', ['-c', `
import io,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]); version=sys.argv[2]; mutation=sys.argv[3]
runtime={'VERSION':(version+'\\n').encode(),'agent_server.py':b'server','update_runner.py':b'updater','install.sh':b'installer','release-public-key.pem':b'key'}
for npm in [True,False]:
    filename=root/('npm/server-'+version+'.tgz' if npm else 'legacy/agents-server-'+version+'.tar.gz')
    with tarfile.open(filename,'w:gz') as archive:
        for name,data in runtime.items():
            if not npm and mutation=='runtime' and name=='agent_server.py': data=b'different runtime'
            member=tarfile.TarInfo(('package/server/' if npm else 'agents-server-'+version+'/')+name)
            member.size=len(data); member.mode=0o755 if name=='install.sh' else 0o644
            if not npm and mutation=='mode' and name=='install.sh': member.mode=0o644
            archive.addfile(member,io.BytesIO(data))
        if npm:
            for name in ['package.json','README.md','LICENSE','NOTICE','npm/cli.cjs']:
                member=tarfile.TarInfo('package/'+name); member.size=1; archive.addfile(member,io.BytesIO(b'x'))
if mutation=='invalid':
    for name in ['npm/server-'+version+'.tgz','legacy/agents-server-'+version+'.tar.gz']: (root/name).write_bytes(b'not an archive')
`, directory, value.version, mutation])
  const payload = readFileSync(join(directory, 'npm', `server-${value.version}.tgz`))
  const legacyPayload = readFileSync(join(directory, 'legacy', `agents-server-${value.version}.tar.gz`))
  const common = { version: value.version, track: value.track, prerelease: true, commit: sourceSha, api_contract_version: 28 }
  const npm = { ...common, schema: 2, distribution: 'npm', minimum_server_api_contract: 8,
    npm: { name: '@agentsdock/server', version: value.version, integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}` },
    archive: { name: `server-${value.version}.tgz`, url: `https://registry.npmjs.org/@agentsdock/server/-/server-${value.version}.tgz`, size: payload.length, sha256: hash(payload) } }
  const legacy = { ...common, schema: 1, archive: { name: `agents-server-${value.version}.tar.gz`,
    url: `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${value.version}/agents-server-${value.version}.tar.gz`, size: legacyPayload.length, sha256: hash(legacyPayload) } }
  const artifacts = {}
  for (const [dir, name, descriptor] of [['npm', 'agents-server-npm-manifest', npm], ['legacy', 'agents-server-manifest', legacy]]) {
    const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`)
    writeFileSync(join(directory, dir, `${name}.json`), bytes)
    writeFileSync(join(directory, dir, `${name}.sig`), sign(null, bytes, privateKey))
    value[dir === 'npm' ? 'npmManifestSha256' : 'legacyManifestSha256'] = hash(bytes)
    for (const filename of [`${name}.json`, `${name}.sig`, descriptor.archive.name]) {
      const content = readFileSync(join(directory, dir, filename))
      artifacts[`${dir}/${filename}`] = { size: content.length, sha256: hash(content) }
    }
  }
  const inventory = { schema: 1, version: value.version, track: value.track, sourceSha,
    npmManifestSha256: value.npmManifestSha256, legacyManifestSha256: value.legacyManifestSha256, artifacts }
  const saveInventory = changes => {
    const bundleBytes = JSON.stringify({ ...inventory, ...changes })
    writeFileSync(join(directory, 'product-server-bundle.json'), bundleBytes)
    value.serverBundleSha256 = hash(bundleBytes)
  }
  saveInventory({})
  return { directory, value, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), npm, inventory, saveInventory }
}

test('signed product bundle must bind both server distributions and exact accepted bytes', t => {
  const fixture = bundle(t)
  assert.equal(verifyReceiptBundle(fixture.value, fixture.directory, fixture.publicKey), fixture.value)
  assert.throws(() => verifyReceiptBundle({ ...fixture.value, sourceSha: workflowSha }, fixture.directory, fixture.publicKey), /source differs/)
  assert.throws(() => verifyReceiptBundle({ ...fixture.value, npmManifestSha256: '2'.repeat(64) }, fixture.directory, fixture.publicKey), /differs/)
  writeFileSync(join(fixture.directory, 'npm', fixture.npm.archive.name), 'changed')
  assert.throws(() => verifyReceiptBundle(fixture.value, fixture.directory, fixture.publicKey), /inventory differs/)
})

test('signed hashes alone do not authorize invalid archives or differing server runtimes', t => {
  for (const mutation of ['invalid', 'runtime', 'mode']) {
    const f = bundle(t, mutation)
    assert.throws(() => verifyReceiptBundle(f.value, f.directory, f.publicKey), /identical valid runtime/)
  }
})

test('bundle inventory must match identity, exact asset set and every asset hash', t => {
  const f = bundle(t)
  for (const change of [{ schema: 2 }, { sourceSha: workflowSha }, { version: '1.0.7' }, { track: 'stable' },
    { npmManifestSha256: '' }, { legacyManifestSha256: '' }, { artifacts: {} },
    { artifacts: { ...f.inventory.artifacts, extra: { size: 1, sha256: 'a'.repeat(64) } } }]) {
    f.saveInventory(change)
    assert.throws(() => verifyReceiptBundle(f.value, f.directory, f.publicKey), /inventory/)
  }
  f.saveInventory({})
  writeFileSync(join(f.directory, 'npm', 'unexpected.txt'), 'extra')
  assert.throws(() => verifyReceiptBundle(f.value, f.directory, f.publicKey), /Unexpected server bundle asset/)
})

test('bundle and input symlinks cannot stand in for accepted regular files', t => {
  const f = bundle(t)
  symlinkSync(f.directory, `${f.directory}-link`)
  t.after(() => rmSync(`${f.directory}-link`))
  assert.throws(() => verifyReceiptBundle(f.value, `${f.directory}-link`, f.publicKey), /symlinks/)
})

test('unsigned or missing server data cannot become an app-only product receipt', t => {
  const fixture = bundle(t)
  writeFileSync(join(fixture.directory, 'npm/agents-server-npm-manifest.sig'), Buffer.alloc(64))
  assert.throws(() => verifyReceiptBundle(fixture.value, fixture.directory, fixture.publicKey), /signature/)
})

test('preparation run binds receipt to exact canonical workflow, branch and successful run', () => {
  const value = receipt()
  const run = { id: 100, run_number: 3, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_sha: workflowSha, head_branch: 'main', head_repository: { full_name: 'ZhengyiLuo/AgentsDock' },
    path: '.github/workflows/product-release.yml' }
  assert.equal(validatePreparationRun(run, value), true)
  for (const change of [{ id: 101 }, { run_number: 4 }, { event: 'pull_request' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { head_sha: sourceSha }, { head_branch: 'feature/unsafe' },
    { head_repository: { full_name: 'fork/AgentsDock' } }, { path: '.github/workflows/not-product-release.yml' }]) {
    assert.throws(() => validatePreparationRun({ ...run, ...change }, value))
  }
})

function acceptance() {
  const value = receipt(), receiptHash = '2'.repeat(64)
  const run = { id: 101, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: sourceSha,
    head_repository: { full_name: 'ZhengyiLuo/AgentsDock' }, path: '.github/workflows/product-release-acceptance.yml' }
  const report = { schema: 1, version: value.version, sourceSha, releaseReceiptSha256: receiptHash, runId: '101',
    checks: ACCEPTANCE_CHECKS.map(name => ({ name, result: 'passed' })) }
  return { value, receiptHash, run, report }
}

test('publication requires successful exact-source native acceptance, not packaging success', () => {
  const f = acceptance()
  assert.equal(validateAcceptance(f.report, f.value, f.receiptHash, f.run), true)
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_sha: workflowSha },
    { head_repository: { full_name: 'someone/AgentsDock' } }, { path: '.github/workflows/product-release.yml' }, { event: 'pull_request' }]) {
    assert.throws(() => validateAcceptance(f.report, f.value, f.receiptHash, { ...f.run, ...change }))
  }
  for (const change of [{ schema: 2 }, { sourceSha: workflowSha }, { version: '1.0.7' }, { releaseReceiptSha256: '3'.repeat(64) }, { runId: '102' }]) {
    assert.throws(() => validateAcceptance({ ...f.report, ...change }, f.value, f.receiptHash, f.run))
  }
})

test('every named acceptance scenario is required once and must actually pass', () => {
  const f = acceptance()
  for (const name of ACCEPTANCE_CHECKS) {
    for (const checks of [f.report.checks.filter(check => check.name !== name),
      f.report.checks.map(check => check.name === name ? { name, result: 'skipped' } : check),
      [...f.report.checks, { name, result: 'passed' }]]) {
      assert.throws(() => validateAcceptance({ ...f.report, checks }, f.value, f.receiptHash, f.run), /has not passed/)
    }
  }
})

test('workflow outputs derive npm candidate and signing policy from the accepted receipt', () => {
  const values = receiptOutputs(receipt())
  assert.equal(values.candidate_tag, 'npm-candidate-v1.0.7-beta.15')
  assert.equal(values.source_sha, sourceSha)
  assert.equal(values.windows_signing, 'signed')
  assert.equal(values.build_number, '5003')
})
