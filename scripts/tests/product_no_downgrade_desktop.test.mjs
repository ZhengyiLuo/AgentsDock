import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, link, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertCurrentWithoutOperation, assertNoUpdateRequests, assertSameBaseBetaVersion, assertStableHealth, assertStableIdentity,
  noDowngradeDiagnostic, parseArguments, readRegular, STABLE_IDENTITY, validateFixture, verifyStableDirectory } from '../product_no_downgrade_desktop.mjs'

const clone = value => structuredClone(value)
const receipt = { sourceSha: 'b'.repeat(40), version: '1.0.8-beta.1' }, receiptHash = 'c'.repeat(64)
const env = { GITHUB_SHA: 'd'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }
const fixture = { schema: 1, kind: 'native-stable-no-downgrade-fixture', candidateSourceSha: receipt.sourceSha,
  candidateVersion: receipt.version, candidateReceiptSha256: receiptHash, harnessSourceSha: env.GITHUB_SHA,
  runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, stableIdentity: STABLE_IDENTITY,
  serverUrl: 'http://127.0.0.1:18000', token: 'test-only-credential-'.repeat(3), serverIdentity: 'owned-server',
  componentIdentity: { serverInstanceId: 'server-instance', gateway: { pid: 1234, instanceId: 'gateway-instance' },
    execution: { pid: 1235, instanceId: 'execution-instance' } } }
const health = { ok: true, server_version: '1.0.8', server_identity: fixture.serverIdentity, server_instance_id: 'server-instance',
  gateway: { protocol: 1, version: '1.0.8', pid: 1234, instance_id: 'gateway-instance', maintenance_held: false },
  execution_service: { protocol: 1, version: '1.0.8', pid: 1235, instance_id: 'execution-instance', maintenance_held: false } }
const status = { currentVersion: receipt.version, serverUpdates: [{ profileId: 'candidate-no-downgrade', phase: 'current',
  serverIdentity: fixture.serverIdentity, targetVersion: receipt.version, serverInstanceId: 'server-instance' }] }

test('native failure diagnostics distinguish the failing boundary without exposing native data', () => {
  const privateMarker = 'private-test-value-do-not-emit'
  const observed = noDowngradeDiagnostic({ stage: 'coordinator-status', attempt: 0,
    status: { ...status, token: privateMarker, serverUpdates: [{ ...status.serverUpdates[0], phase: 'blocked',
      message: privateMarker, name: privateMarker }] }, fixture, candidateVersion: receipt.version,
    wire: { valid: true, connections: 3, clientResets: 2, failureKind: 'client-reset-incomplete', failureState: 'body',
      requests: { 'GET /api/health': 2, 'POST /api/admin/update/ensure': 1,
      [`GET /${privateMarker}`]: 7 }, privateData: privateMarker },
    child: { exitCode: null, signalCode: null } })
  assert.equal(observed.stage, 'coordinator-status')
  assert.equal(observed.phase, 'blocked')
  assert.equal(observed.matchingProfileRecords, 1)
  assert.equal(observed.healthRequests, 2)
  assert.equal(observed.updateRequests, 1)
  assert.equal(observed.wireFailureKind, 'client-reset-incomplete')
  assert.equal(observed.wireFailureState, 'body')
  assert.equal(observed.completeClientResets, 2)
  assert.equal(observed.expectedServerIdentity, true)
  assert.equal(observed.appExited, false)
  assert(!JSON.stringify(observed).includes(privateMarker))
  assert(!JSON.stringify(observed).includes(fixture.serverIdentity))
  const unknown = noDowngradeDiagnostic({ stage: 'renderer-connect', attempt: 1, fixture,
    candidateVersion: receipt.version, status: { serverUpdates: [{ ...status.serverUpdates[0], phase: privateMarker }] },
    wire: { failureKind: privateMarker, failureState: privateMarker, clientResets: privateMarker },
    child: { exitCode: 1, signalCode: privateMarker } })
  assert.equal(unknown.phase, null)
  assert.equal(unknown.appExitSignal, null)
  assert.equal(unknown.appExitCode, 1)
  assert.equal(unknown.wireFailureKind, null)
  assert.equal(unknown.wireFailureState, null)
  assert.equal(unknown.completeClientResets, null)
  assert(!JSON.stringify(unknown).includes(privateMarker))
  for (const changes of [{ stage: privateMarker }, { attempt: 2 }]) {
    assert.throws(() => noDowngradeDiagnostic({ stage: 'renderer-connect', attempt: 0, fixture,
      candidateVersion: receipt.version, ...changes }))
  }
})

test('separate immutable official stable identity is not the beta artifact identity', () => {
  assert.notEqual(STABLE_IDENTITY.sourceSha, receipt.sourceSha)
  const descriptor = { version: '1.0.8', track: 'stable', prerelease: false, commit: STABLE_IDENTITY.sourceSha,
    archive: { sha256: STABLE_IDENTITY.archiveSha256, size: STABLE_IDENTITY.archiveBytes } }
  const check = value => assertStableIdentity(value, STABLE_IDENTITY.manifestSha256, STABLE_IDENTITY.signatureSha256)
  check(descriptor)
  for (const changes of [{ version: receipt.version }, { commit: receipt.sourceSha }, { track: 'beta' }, { prerelease: true },
    { archive: { ...descriptor.archive, sha256: receiptHash } }, { archive: { ...descriptor.archive, size: 1 } }]) assert.throws(() => check({ ...descriptor, ...changes }))
  assert.throws(() => assertStableIdentity(descriptor, receiptHash, STABLE_IDENTITY.signatureSha256))
  assert.throws(() => assertStableIdentity(descriptor, STABLE_IDENTITY.manifestSha256, receiptHash))
})

test('same-base stable server is current only with both native components and no operation', () => {
  assert.equal(assertCurrentWithoutOperation(status, health, fixture, receipt.version).phase, 'current')
  for (const changes of [{ phase: 'pending' }, { phase: 'blocked' }, { operationId: 'operation' }, { scheduleId: 'reservation' },
    { operationOwned: true }, { paused: true }, { targetVersion: '1.0.8' }, { serverInstanceId: 'changed' }, { serverIdentity: 'changed' }]) {
    const changed = clone(status); Object.assign(changed.serverUpdates[0], changes)
    assert.throws(() => assertCurrentWithoutOperation(changed, health, fixture, receipt.version))
  }
  assert.throws(() => assertCurrentWithoutOperation({ ...status, serverUpdates: [...status.serverUpdates, ...status.serverUpdates] }, health, fixture, receipt.version))
  assert.throws(() => assertCurrentWithoutOperation(status, health, fixture, '1.0.8-beta.2'))
})

test('same-base beta.2 uses its own receipt-bound fixture without broadening the stable target', () => {
  for (const version of ['1.0.8-beta.1', '1.0.8-beta.2', '1.0.8-beta.12']) {
    assertSameBaseBetaVersion(version)
    const candidateStatus = clone(status)
    candidateStatus.currentVersion = version
    candidateStatus.serverUpdates[0].targetVersion = version
    const candidateFixture = { ...fixture, candidateVersion: version }
    assert.equal(assertCurrentWithoutOperation(candidateStatus, health, candidateFixture, version).visibleVersion, version)
    if (version !== receipt.version) assert.throws(() => assertCurrentWithoutOperation(candidateStatus, health, fixture, version))
  }
  for (const version of ['1.0.9-beta.2', '1.0.7-beta.2', '1.0.8', '1.0.8-rc.2', '1.0.8-beta.0',
    '1.0.8-beta.02', '1.0.8-beta.2.extra', '1.0.8-beta.2+local', '1.0.8-beta.2\n', undefined, 2]) {
    assert.throws(() => assertSameBaseBetaVersion(version))
  }
})

test('mixed versions, replaced PIDs/instances and maintenance fail exact incumbent equality', () => {
  assertStableHealth(health, fixture)
  for (const component of ['gateway', 'execution_service']) for (const changes of [
    { version: '1.0.8-beta.1' }, { version: '1.0.7' }, { pid: 4321 }, { instance_id: 'new-instance' }, { protocol: 2 }, { maintenance_held: true },
  ]) { const changed = clone(health); Object.assign(changed[component], changes); assert.throws(() => assertStableHealth(changed, fixture)) }
  for (const changes of [{ ok: false }, { server_version: receipt.version }, { server_identity: 'other' }, { server_instance_id: 'other' }]) assert.throws(() => assertStableHealth({ ...health, ...changes }, fixture))
})

test('wire receipt requires real health traffic and rejects every observed update endpoint', () => {
  const observed = { valid: true, connections: 1, requests: { 'GET /api/health': 1, 'GET other': 2 } }
  assertNoUpdateRequests(observed)
  for (const path of ['/api/admin/update', '/api/admin/update/ensure', '/api/admin/update/start', '/api/admin/update/cancel', '/api/admin/update/check']) {
    for (const method of ['GET', 'POST']) assert.throws(() => assertNoUpdateRequests({ ...observed, requests: { ...observed.requests, [`${method} ${path}`]: 1 } }))
  }
  for (const changes of [{ valid: false }, { connections: 0 }, { requests: {} }, { requests: { 'GET /api/health': -1 } }]) assert.throws(() => assertNoUpdateRequests({ ...observed, ...changes }))
})

test('private fixture cannot cross stable/candidate identities, runs or local target boundaries', () => {
  assert.equal(validateFixture(fixture, receipt, receiptHash, env), fixture)
  for (const changes of [{ kind: 'product-fixture' }, { candidateSourceSha: STABLE_IDENTITY.sourceSha }, { candidateReceiptSha256: 'f'.repeat(64) },
    { harnessSourceSha: receipt.sourceSha }, { runId: '124' }, { runAttempt: '2' }, { stableIdentity: { ...STABLE_IDENTITY, version: receipt.version } },
    { serverUrl: 'http://localhost:18000' }, { token: 'bad\nsecret' }]) assert.throws(() => validateFixture({ ...fixture, ...changes }, receipt, receiptHash, env))
})

test('CLI allows only exact absolute pinned inputs, never trust overrides', () => {
  const args = ['receipt', 'receipt-sha256', 'server-directory', 'desktop-directory', 'stable-directory', 'work', 'fixture', 'output']
    .flatMap(key => [`--${key}`, key === 'receipt-sha256' ? receiptHash : `/temporary/${key}`])
  assert.equal(parseArguments(args)['receipt-sha256'], receiptHash)
  for (const changed of [args.slice(2), [...args, '--public-key', '/test/key'], [...args, '--receipt', '/other'],
    args.map(value => value === '/temporary/work' ? '.' : value), args.map(value => value === receiptHash ? 'invalid' : value)]) assert.throws(() => parseArguments(changed))
})

test('bounded regular inputs reject symlink, hardlink, broad fixture access and counterfeit stable bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentsdock-no-downgrade-input-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'private.json'); await writeFile(file, '{}', { mode: 0o600 })
  assert.equal((await readRegular(file, 10, true)).toString(), '{}')
  await symlink(file, join(root, 'linked.json')); await assert.rejects(readRegular(join(root, 'linked.json')))
  await assert.rejects(readRegular(file, 1)); await chmod(file, 0o644); await assert.rejects(readRegular(file, 10, true))
  await link(file, join(root, 'hardlinked.json')); await assert.rejects(readRegular(file))
  await writeFile(join(root, 'agents-server-npm-manifest.json'), '{}')
  await writeFile(join(root, 'agents-server-npm-manifest.sig'), Buffer.alloc(64))
  await assert.rejects(verifyStableDirectory(root), /independently accepted bytes/)
})
