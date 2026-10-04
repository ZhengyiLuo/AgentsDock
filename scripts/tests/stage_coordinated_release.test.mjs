import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { verifyCoordinatedResources } from '../verify_coordinated_resources.mjs'
import { stageCoordinatedRelease } from '../stage_coordinated_release.mjs'
import { coordinatedInputs, prepareElectronCoordinatedConfig } from '../prepare_electron_coordinated_config.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-coordinate-stage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const options = { packageJSON: join(root, 'package.json'), resourcesDirectory: join(root, 'build/coordinated-release'), manifestPath: join(root, 'manifest.json'), signaturePath: join(root, 'manifest.sig'), appVersion: '1.2.3-beta.4', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }
  writeFileSync(options.packageJSON, JSON.stringify({ version: options.appVersion, build: { buildVersion: '1185', extraResources: [{ from: '../LICENSE', to: 'licenses/LICENSE' }] } }))
  const descriptor = { schema: 2, distribution: 'npm', version: options.appVersion, track: 'beta', prerelease: true, api_contract_version: 28, minimum_server_api_contract: 8, commit: 'a'.repeat(40), npm: { name: '@agentsdock/server', version: options.appVersion, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` }, archive: { name: `server-${options.appVersion}.tgz`, url: `https://registry.npmjs.org/@agentsdock/server/-/server-${options.appVersion}.tgz`, sha256: 'b'.repeat(64), size: 123 } }
  const resign = () => { writeFileSync(options.manifestPath, JSON.stringify(descriptor, null, 2) + '\n'); writeFileSync(options.signaturePath, sign(null, readFileSync(options.manifestPath), privateKey)) }
  resign()
  return { options, descriptor, resign }
}

test('copies signed raw bytes, explicitly enrolls staged app, and preserves app/build versions', t => {
  const { options } = fixture(t)
  assert.equal(stageCoordinatedRelease(options).enrolled, true)
  const metadata = JSON.parse(readFileSync(options.packageJSON))
  assert.equal(metadata.version, options.appVersion)
  assert.equal(metadata.build.buildVersion, '1185')
  assert.equal(metadata.agentsDock.coordinatedUpdates, true)
  assert.deepEqual(metadata.build.extraResources.at(-1), { from: 'build/coordinated-release', to: 'coordinated-release', filter: ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig'] })
  assert.deepEqual(readFileSync(join(options.resourcesDirectory, 'agents-server-npm-manifest.json')), readFileSync(options.manifestPath))
  assert.deepEqual(readFileSync(join(options.resourcesDirectory, 'agents-server-npm-manifest.sig')), readFileSync(options.signaturePath))
  stageCoordinatedRelease(options)
  assert.equal(JSON.parse(readFileSync(options.packageJSON)).build.extraResources.length, 2)
})

test('invalid signature leaves staged package and resources untouched', t => {
  const { options } = fixture(t)
  const original = readFileSync(options.packageJSON)
  writeFileSync(options.signaturePath, Buffer.alloc(64))
  assert.throws(() => stageCoordinatedRelease(options), /signature is invalid/)
  assert.deepEqual(readFileSync(options.packageJSON), original)
  assert.equal(existsSync(options.resourcesDirectory), false)
})

test('signed mismatched version, malformed registry identity, or compatibility range are rejected', t => {
  for (const change of [d => { d.version = '1.2.4-beta.1' }, d => { d.archive.url = 'https://example.com/server.tgz' }, d => { d.minimum_server_api_contract = 29 }, d => { d.npm.integrity = 'sha512-not-a-digest' }]) {
    const { options, descriptor, resign } = fixture(t)
    change(descriptor); resign()
    assert.throws(() => stageCoordinatedRelease(options), /Coordinated release/)
    assert.equal(existsSync(options.resourcesDirectory), false)
  }
})

test('cannot rewrite source package metadata or choose a resource directory outside staged build', t => {
  const { options } = fixture(t)
  assert.throws(() => stageCoordinatedRelease({ ...options, packageJSON: resolve('electron/package.json') }), /Refusing to modify source/)
  assert.throws(() => stageCoordinatedRelease({ ...options, resourcesDirectory: join(tmpdir(), 'elsewhere') }), /staged package build/)
  assert.throws(() => stageCoordinatedRelease({ ...options, appVersion: '1.2.3-beta.5' }), /Stage the app version explicitly/)
})

test('cannot replace previously staged signed payload with a different signed payload', t => {
  const { options, descriptor, resign } = fixture(t)
  stageCoordinatedRelease(options)
  descriptor.commit = 'c'.repeat(40); resign()
  assert.throws(() => stageCoordinatedRelease(options), /different coordinated release/)
})

test('builder integration opts in only with both explicit absolute input paths', () => {
  assert.equal(coordinatedInputs({}), null)
  assert.equal(prepareElectronCoordinatedConfig({ environment: {} }), null)
  assert.throws(() => coordinatedInputs({ AGENTSDOCK_COORDINATED_MANIFEST: '/tmp/manifest' }), /both/)
  assert.throws(() => coordinatedInputs({ AGENTSDOCK_COORDINATED_MANIFEST: 'relative/manifest', AGENTSDOCK_COORDINATED_SIGNATURE: 'relative/signature' }), /absolute/)
})

test('builder config embeds pair from a disposable stage without rewriting source metadata', t => {
  const { options } = fixture(t)
  const outputDirectory = mkdtempSync(join(tmpdir(), 'agentsdock-builder-stage-'))
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }))
  const original = readFileSync(options.packageJSON)
  const result = prepareElectronCoordinatedConfig({ project: dirname(options.packageJSON), outputDirectory, publicKey: options.publicKey, environment: { AGENTSDOCK_COORDINATED_MANIFEST: options.manifestPath, AGENTSDOCK_COORDINATED_SIGNATURE: options.signaturePath } })
  assert.deepEqual(readFileSync(options.packageJSON), original)
  const config = JSON.parse(readFileSync(result))
  assert.equal(config.extraMetadata.agentsDock.coordinatedUpdates, true)
  assert.equal(config.buildVersion, '1185')
  const resource = config.extraResources.at(-1)
  assert.equal(resource.to, 'coordinated-release')
  assert.deepEqual(readFileSync(join(resource.from, 'agents-server-npm-manifest.json')), readFileSync(options.manifestPath))
  assert.deepEqual(readFileSync(join(resource.from, 'agents-server-npm-manifest.sig')), readFileSync(options.signaturePath))
})

test('staging respects the server 8 KiB signed descriptor limit', t => {
  const { options, descriptor, resign } = fixture(t)
  descriptor.padding = 'x'.repeat(8192); resign()
  assert.throws(() => stageCoordinatedRelease(options), /bounded regular files/)
  assert.equal(existsSync(options.resourcesDirectory), false)
})

test('builder cannot override the verified app version or package a different app directory', t => {
  for (const build of [{ extraMetadata: { version: '9.9.9' } }, { directories: { app: 'other-app' } }]) {
    const { options } = fixture(t)
    writeFileSync(options.packageJSON, JSON.stringify({ version: options.appVersion, build }))
    assert.throws(() => stageCoordinatedRelease(options), /overrides the coordinated app version|explicit Electron app package directory/)
    assert.equal(existsSync(options.resourcesDirectory), false)
  }
})

function packaged(options) {
  return { ...options, resources: dirname(options.resourcesDirectory) }
}

test('packaged resource verification accepts legacy absence and exact enrolled resources', t => {
  const { options } = fixture(t)
  assert.deepEqual(verifyCoordinatedResources({ ...packaged(options), manifestPath: '', signaturePath: '' }), { enrolled: false })
  stageCoordinatedRelease(options)
  assert.deepEqual(verifyCoordinatedResources(packaged(options)), { enrolled: true, version: options.appVersion })
  assert.throws(() => verifyCoordinatedResources({ ...packaged(options), manifestPath: '', signaturePath: '' }), /explicit expected descriptor/)
  assert.throws(() => verifyCoordinatedResources({ ...packaged(options), signaturePath: '' }), /Both expected/)
})

test('packaged resource verification rejects missing enrollment, bytes, extra files and symlinks', t => {
  for (const mutation of ['metadata', 'bytes', 'missing', 'extra', 'symlink']) {
    const { options } = fixture(t)
    stageCoordinatedRelease(options)
    const manifest = join(options.resourcesDirectory, 'agents-server-npm-manifest.json')
    if (mutation === 'metadata') writeFileSync(options.packageJSON, JSON.stringify({ version: options.appVersion }))
    if (mutation === 'bytes') writeFileSync(manifest, readFileSync(manifest, 'utf8') + ' ')
    if (mutation === 'missing') rmSync(manifest)
    if (mutation === 'extra') writeFileSync(join(options.resourcesDirectory, 'extra'), 'unexpected')
    if (mutation === 'symlink') { rmSync(manifest); symlinkSync(options.manifestPath, manifest) }
    assert.throws(() => verifyCoordinatedResources(packaged(options)), /enrollment|differ|not exact|ELOOP/)
  }
})
