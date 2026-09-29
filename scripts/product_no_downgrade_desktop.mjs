#!/usr/bin/env node
// Distinct negative journey: an unchanged signed beta app must leave an actual
// installed stable server alone. This is never a positive migration receipt.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDescriptor } from './stage_coordinated_release.mjs'
import { verifyArchiveBytes } from './verify_npm_publication.mjs'
import { assertCandidateCheckout, assertCandidateRunner, inspectCandidate } from './product-candidate-receipt.mjs'
import { boundedNativeLog } from './product_desktop_acceptance.mjs'
import { connect, freePort, hashFile, openMigrationUpdateSettings, run, stopOwned, until, verifyApp } from './verify_electron_migration.mjs'
import { createNativeObservationRelay, ownedLoopbackURL } from './product_no_downgrade_relay.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STABLE_IDENTITY = Object.freeze({ version: '1.0.8',
  sourceSha: '8a965007408c6ab9672d746366b9fc0bd58feff6',
  manifestSha256: '64881777ab0ebf8ad029ec1f4f1212e1699f9ee7a1d62420ae32e5f3dcfe7198',
  signatureSha256: 'e224f89215b2b0d047a49aa0264ff803ef96c3ea71a6a39985b68eef67b6f18d',
  archiveSha256: 'c9846ca863312478f64979cc579feea521902dc23c15f0f30ca5eebdb544808f', archiveBytes: 3721335 })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const PROFILE = 'candidate-no-downgrade', NAME = 'Acceptance stable server'
const ACCOUNT = `agent-access-token:${PROFILE}`, KEYCHAIN = 'com.zhengyiluo.AgentsDock'
const SERVER_HELPER = join(ROOT, 'scripts/product_no_downgrade_server.py')

export async function readRegular(path, maximum = 32768, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum, 'Expected bounded single-link regular input')
    if (privateFile) assert(stat.uid === process.getuid() && !(stat.mode & 0o077), 'Fixture must be private and runner-owned')
    return await file.readFile()
  } finally { await file.close() }
}

export function assertStableIdentity(descriptor, manifestHash, signatureHash) {
  assert.equal(manifestHash, STABLE_IDENTITY.manifestSha256, 'Stable descriptor differs from independently accepted bytes')
  assert.equal(signatureHash, STABLE_IDENTITY.signatureSha256, 'Stable signature differs from independently accepted bytes')
  assert(descriptor.version === STABLE_IDENTITY.version && descriptor.track === 'stable' && descriptor.prerelease === false
    && descriptor.commit === STABLE_IDENTITY.sourceSha && descriptor.archive.sha256 === STABLE_IDENTITY.archiveSha256
    && descriptor.archive.size === STABLE_IDENTITY.archiveBytes, 'Stable artifact/source identity differs')
}

export async function verifyStableDirectory(directory) {
  const manifest = await readRegular(join(directory, 'agents-server-npm-manifest.json'), 8192)
  const signature = await readRegular(join(directory, 'agents-server-npm-manifest.sig'), 64)
  assert.equal(digest(manifest), STABLE_IDENTITY.manifestSha256, 'Stable descriptor differs from independently accepted bytes')
  assert.equal(digest(signature), STABLE_IDENTITY.signatureSha256, 'Stable signature differs from independently accepted bytes')
  // The existing official trust root is not injectable through this CLI.
  const descriptor = validateDescriptor(manifest, signature, await readRegular(join(ROOT, 'server/release-public-key.pem'), 4096), '1.0.8')
  assertStableIdentity(descriptor, digest(manifest), digest(signature))
  verifyArchiveBytes(await readRegular(join(directory, 'server-1.0.8.tgz'), STABLE_IDENTITY.archiveBytes), descriptor)
  return { ...STABLE_IDENTITY }
}

export function parseArguments(argv) {
  const keys = ['receipt', 'receipt-sha256', 'server-directory', 'desktop-directory', 'stable-directory', 'work', 'fixture', 'output']
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].replace(/^--/, '')
    assert(argv[index] === `--${name}` && keys.includes(name) && !Object.hasOwn(options, name) && argv[index + 1], 'Invalid or duplicate no-downgrade argument')
    options[name] = argv[index + 1]
  }
  assert(keys.every(key => options[key]), 'Missing no-downgrade input')
  assert(/^[a-f0-9]{64}$/.test(options['receipt-sha256']), 'Invalid candidate receipt digest')
  for (const key of keys.filter(key => key !== 'receipt-sha256')) assert(isAbsolute(options[key]), 'All acceptance paths must be absolute')
  return options
}

export function assertStableHealth(health, fixture) {
  assert(health?.ok === true && health.server_version === '1.0.8' && health.server_identity === fixture.serverIdentity
    && health.server_instance_id === fixture.componentIdentity.serverInstanceId, 'Stable server version or identity changed')
  for (const [name, key] of [['gateway', 'gateway'], ['execution_service', 'execution']]) {
    const component = health[name], expected = fixture.componentIdentity[key]
    assert(component?.protocol === 1 && component.version === '1.0.8' && component.pid === expected.pid
      && component.instance_id === expected.instanceId && component.maintenance_held !== true, 'Stable native component changed or entered maintenance')
  }
}

export function assertCurrentWithoutOperation(status, health, fixture, candidateVersion) {
  assert.equal(candidateVersion, '1.0.8-beta.1', 'This negative journey is pinned to the same-base beta')
  assertStableHealth(health, fixture)
  assert.equal(status?.currentVersion, candidateVersion)
  const records = status.serverUpdates?.filter(record => record.profileId === PROFILE)
  assert(records?.length === 1, 'Missing or ambiguous production coordinator record')
  const record = records[0]
  assert(record.phase === 'current' && record.serverIdentity === fixture.serverIdentity && record.targetVersion === candidateVersion
    && record.serverInstanceId === health.server_instance_id && !record.operationId && !record.scheduleId
    && !record.operationOwned && !record.paused, 'Stable server was not accepted without an update operation')
  return { visibleVersion: candidateVersion, phase: record.phase, operationAbsent: true, stableComponentsUnchanged: true }
}

export function assertNoUpdateRequests(observation) {
  assert(observation?.valid === true && observation.connections > 0, 'Native wire observation was not valid')
  assert((observation.requests['GET /api/health'] ?? 0) > 0, 'Relay did not observe genuine native health traffic')
  for (const [request, count] of Object.entries(observation.requests)) {
    assert(Number.isSafeInteger(count) && count > 0, 'Invalid request count')
    assert(!/^\w+ \/api\/admin\/update(?:\/|$)/.test(request), 'Stable server received an update control request')
  }
}

async function insideRunner(path, absent = false) {
  const temporary = await realpath(process.env.RUNNER_TEMP)
  const actual = absent ? join(await realpath(dirname(path)), path.split('/').at(-1)) : await realpath(path)
  const part = relative(temporary, actual)
  assert(part && !part.startsWith('..') && !isAbsolute(part), 'Acceptance input/output must be inside RUNNER_TEMP')
  if (absent) { await assert.rejects(lstat(path), { code: 'ENOENT' }) }
  else assert(!(await lstat(path)).isSymbolicLink(), 'Acceptance paths cannot be symlinks')
}

export function validateFixture(fixture, receipt, receiptHash, env = process.env) {
  assert(fixture?.schema === 1 && fixture.kind === 'native-stable-no-downgrade-fixture'
    && fixture.candidateSourceSha === receipt.sourceSha && fixture.candidateVersion === receipt.version
    && fixture.candidateReceiptSha256 === receiptHash && fixture.harnessSourceSha === env.GITHUB_SHA
    && fixture.runId === env.GITHUB_RUN_ID && fixture.runAttempt === env.GITHUB_RUN_ATTEMPT, 'Fixture belongs to another candidate or run')
  assert.deepEqual(fixture.stableIdentity, STABLE_IDENTITY)
  ownedLoopbackURL(fixture.serverUrl)
  assert(typeof fixture.token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(fixture.token), 'Invalid private disposable credential')
  return fixture
}

async function health(fixture) {
  const response = await fetch(`${fixture.serverUrl}/api/health`, { headers: { 'X-AgentsDock-Token': fixture.token },
    redirect: 'error', signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200, 'Owned stable native health failed')
  const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= 64 * 1024, 'Oversized health response')
  const value = JSON.parse(bytes); assertStableHealth(value, fixture); return value
}

function verifyService(options, output) {
  const args = [SERVER_HELPER, 'verify', ...['receipt', 'receipt-sha256', 'server-directory', 'desktop-directory', 'stable-directory', 'work', 'fixture']
    .flatMap(name => [`--${name}`, options[name]]), '--evidence', output]
  const result = execFileSync('python3', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe'] })
  const proof = JSON.parse(result)
  assert(proof.observed === true && /^[a-f0-9]{64}$/.test(proof.evidenceSha256), 'Native service verification did not produce evidence')
  return proof.evidenceSha256
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  assertCandidateRunner()
  for (const key of ['receipt', 'server-directory', 'desktop-directory', 'stable-directory', 'work', 'fixture']) await insideRunner(options[key])
  await insideRunner(options.output, true)
  const outputRelative = relative(await realpath(options.work), options.output)
  assert(outputRelative && !outputRelative.startsWith('..') && !isAbsolute(outputRelative), 'Output must belong to the owned fixture work directory')
  const receipt = await inspectCandidate({ receiptPath: options.receipt, receiptSha256: options['receipt-sha256'],
    serverDirectory: options['server-directory'], desktopDirectory: options['desktop-directory'] })
  const harness = assertCandidateCheckout(receipt)
  assert.equal(receipt.version, '1.0.8-beta.1')
  await verifyStableDirectory(options['stable-directory'])
  const fixture = validateFixture(JSON.parse(await readRegular(options.fixture, 1024 * 1024, true)), receipt, options['receipt-sha256'])
  assert(!run('/bin/ps', ['-axo', 'command=']).includes('/AgentsDock.app/Contents/MacOS/AgentsDock'), 'An AgentsDock app is already running')
  await mkdir(options.output, { mode: 0o700 })
  const preflight = verifyService(options, join(options.output, 'service-preflight.json'))
  const installation = join(options.output, 'installation'); await mkdir(installation, { mode: 0o700 })
  const archive = join(options['desktop-directory'], `AgentsDock-${receipt.version}-mac-universal.zip`)
  run('python3', [join(ROOT, 'scripts/verify_electron_app_zip.py'), archive])
  run('/usr/bin/ditto', ['-x', '-k', archive, installation])
  const app = join(installation, 'AgentsDock.app'); verifyApp(app, receipt.version)
  for (const name of ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']) {
    assert((await readRegular(join(app, 'Contents/Resources/coordinated-release', name), 8192))
      .equals(await readRegular(join(options['server-directory'], 'npm', name), 8192)), 'Signed app contains another server descriptor')
  }
  const asar = join(app, 'Contents/Resources/app.asar'), asarSha256 = await hashFile(asar)
  const profile = join(options.output, 'profile'); await mkdir(profile, { mode: 0o700 })
  const relay = await createNativeObservationRelay({ targetURL: fixture.serverUrl, assertOwnedTarget: () => health(fixture) })
  let keychainCreated = false, client, child, completed = false
  const logs = boundedNativeLog(createWriteStream(join(options.output, 'native-private.log'), { flags: 'wx', mode: 0o600 }))
  const observations = []
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 2, activeProfileId: PROFILE, profiles: [{
      id: PROFILE, name: NAME, serverUrl: relay.url, serverIdentity: fixture.serverIdentity, keychainAccessToken: true,
      serverSetupComplete: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }), { flag: 'wx', mode: 0o600 })
    await writeFile(join(profile, 'app-language.json'), '{"preference":"en"}\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(profile, 'update-track'), 'beta\n', { flag: 'wx', mode: 0o600 })
    let exists = false
    try { execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN, '-a', ACCOUNT], { stdio: 'ignore', timeout: 5000 }); exists = true }
    catch (error) { assert.equal(error.status, 44, 'Cannot safely inspect the disposable keychain account') }
    assert(!exists, 'Refusing to replace an existing keychain entry')
    execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -s ${KEYCHAIN} -a ${ACCOUNT} -w ${fixture.token}\n`, timeout: 5000, stdio: ['pipe', 'ignore', 'pipe'] })
    keychainCreated = true
    const port = await freePort()
    const observeCurrent = async name => {
      const result = await until('Native beta app accepts the unchanged stable server', async () => {
        relay.assertValid()
        const status = await client.evaluate('window.agentsDock?.updates.status()')
        const current = await health(fixture)
        try { return assertCurrentWithoutOperation(status, current, fixture, receipt.version) } catch { return null }
      }, 60000)
      await until('Visible unchanged stable server row', async () => client.evaluate(`(() => {const rows=[...document.querySelectorAll('.coordinated-server-update-row')].filter(e=>e.getClientRects().length && e.querySelector('strong')?.textContent?.trim()===${JSON.stringify(NAME)});return rows.length===1 && /up to date|current/i.test(rows[0].querySelector('.app-settings-value')?.textContent||'')})()`))
      relay.assertValid(); assertNoUpdateRequests(relay.snapshot())
      await client.screenshot(join(options.output, `${name}.png`))
      observations.push({ name, ...result })
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      child = spawn(join(app, 'Contents/MacOS/AgentsDock'), [`--remote-debugging-port=${port}`], {
        env: { ...process.env, AGENTSDOCK_USER_DATA: profile, AGENTSDOCK_DISABLE_ANALYTICS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', bytes => logs.write(bytes)); child.stderr.on('data', bytes => logs.write(bytes))
      child.once('error', () => logs.write('Owned native app launch failed.\n'))
      client = await until('Signed native candidate renderer', () => connect(port)); await client.call('Page.bringToFront')
      await openMigrationUpdateSettings(client)
      await observeCurrent(attempt ? '02-app-reopened-current' : '00-stable-current')
      if (!attempt) {
        await client.clickButton(['Close Settings'])
        await openMigrationUpdateSettings(client)
        await observeCurrent('01-settings-reopened-current')
      }
      client.close(); client = null; await stopOwned(app)
      assertStableHealth(await health(fixture), fixture)
    }
    const preservationEvidenceSha256 = verifyService(options, join(options.output, 'service-verification.json'))
    verifyApp(app, receipt.version); assert.equal(await hashFile(asar), asarSha256)
    const saved = JSON.parse(await readRegular(join(profile, 'settings.json'), 1024 * 1024))
    assert.equal(saved.activeProfileId, PROFILE)
    assert(saved.profiles.some(item => item.id === PROFILE && item.serverIdentity === fixture.serverIdentity && item.serverUrl === relay.url))
    relay.assertValid(); const wire = await relay.close(); assertNoUpdateRequests(wire); logs.assertHealthy()
    const report = { schema: 1, kind: 'candidate-no-downgrade-observations', publicationEligible: false, releaseAcceptance: false,
      sourceSha: receipt.sourceSha, harnessSourceSha: harness.harnessSourceSha, releaseReceiptSha256: options['receipt-sha256'],
      version: receipt.version, stableIdentity: STABLE_IDENTITY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: 'darwin', native: true, observed: true, preflightEvidenceSha256: preflight, preservationEvidenceSha256,
      targetZipSha256: await hashFile(archive), installedAsarSha256: asarSha256, observations, wire,
      boundaries: { unchangedSignedApp: true, actualNpmCLIAndLaunchd: true, productionNativeGuard: true,
        byteTransparentLoopbackRelay: true, nativeInstallerMocked: false, nativeHealthMocked: false,
        wireWindow: 'candidate-app-only-after-stable-bootstrap-and-rejection-checks',
        desktopSelfReplacementObserved: false, liveProviderWorkObserved: false, publicFeedDeliveryObserved: false } }
    await writeFile(join(options.output, 'no-downgrade.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    completed = true
  } finally {
    try { client?.close(); await stopOwned(app) }
    finally {
      await relay.close().catch(() => {}); logs.end()
      if (keychainCreated) execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN, '-a', ACCOUNT], { timeout: 5000, stdio: 'ignore' })
    }
  }
  assert(completed, 'Native no-downgrade journey did not finish')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  (process.argv[2] === 'verify-stable' && process.argv.length === 4
    ? verifyStableDirectory(resolve(process.argv[3])).then(value => process.stdout.write(`${JSON.stringify(value)}\n`)) : main())
    .catch(() => { process.stderr.write('Native no-downgrade acceptance failed; private details withheld.\n'); process.exitCode = 1 })
}
