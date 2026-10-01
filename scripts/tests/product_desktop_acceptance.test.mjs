import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertCurrentPairedServer, assertDesktopRunner, assertOlderVersion, assertSharedOperation, boundedNativeLog,
  assertStableDiscovery, assertVisibleCoordinatedRow, checksumForMacArchive, collectReconciliationSnapshot, collectSharedOperationSnapshot, emitNativeProgress,
  migrationCoverage, parseDesktopAcceptanceArguments, parseReconciliationSnapshot, parseSharedOperationSnapshot, reconciliationSnapshot,
  retainSharedOperationObservation, desktopJourney,
  terminalReconciliationFailure, validateDesktopFixture } from '../product_desktop_acceptance.mjs'

// These are harness contract tests only: no app/service installation, native
// process, private signing identity, account, DNS, or trust-store mutation.
const identity = { version: '1.0.7-beta.17', sourceSha: 'a'.repeat(40), releaseReceiptSha256: 'b'.repeat(64) }
const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
  RUNNER_OS: 'macOS', GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/release/candidate',
  GITHUB_SHA: identity.sourceSha, RUNNER_TEMP: '/tmp/runner', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }
const fixture = () => ({ schema: 1, ...identity, runId: '123', runAttempt: '1', targetVersion: identity.version,
  baselineVersion: '1.0.3', serverIdentity: 'server-identity-owned', serverInstanceId: 'old-service-instance',
  serverUrl: 'http://127.0.0.1:18753', token: 'synthetic-test-token-only',
  installRoot: '/tmp/runner/service/install', stateRoot: '/tmp/runner/service/state', configRoot: '/tmp/runner/service/config',
  workDirectory: '/tmp/runner/service', baselineStateSha256: 'c'.repeat(64) })
const valid = ['--receipt', '/tmp/runner/release.json', '--receipt-sha256', identity.releaseReceiptSha256,
  '--preparation-run', '/tmp/runner/run.json', '--server-directory', '/tmp/runner/server', '--desktop-directory', '/tmp/runner/desktop',
  '--baseline-directory', '/tmp/runner/baseline', '--baseline-version', '1.0.6',
  '--server-fixture', '/tmp/runner/fixture.json', '--output', '/tmp/runner/native-output']
const record = () => ({ profileId: 'product-acceptance-legacy', serverIdentity: fixture().serverIdentity,
  targetVersion: identity.version, phase: 'current', operationId: 'one-production-operation', serverInstanceId: 'new-service-instance' })
const status = () => ({ currentVersion: identity.version, serverUpdates: [record()] })
const health = () => ({ ok: true, server_identity: fixture().serverIdentity,
  server_instance_id: 'new-service-instance', server_version: identity.version,
  gateway: { version: identity.version }, execution_service: { version: identity.version, maintenance_held: false } })

test('stable baseline subscriptions are preserved instead of forced through Beta', () => {
  assert.deepEqual(desktopJourney('1.0.9', '1.0.6', 'stable108'),
    {initialTrack: 'stable', installedTrack: 'stable', switchToBeta: false})
  assert.deepEqual(desktopJourney('1.0.9', '1.0.8-beta.5', 'beta1085'),
    {initialTrack: 'beta', installedTrack: 'beta', switchToBeta: false})
  assert.deepEqual(desktopJourney('1.0.9', '1.0.6'),
    {initialTrack: 'stable', installedTrack: 'stable', switchToBeta: false})
  assert.deepEqual(desktopJourney('1.0.8-beta.5', '1.0.6'),
    {initialTrack: 'stable', installedTrack: 'beta', switchToBeta: true})
  for (const args of [['1.0.8-beta.5', '1.0.6', 'stable108'], ['1.0.9', '1.0.8-beta.4', 'beta1085'],
    ['1.0.9', '1.0.6', 'unknown'], ['1.0.9', '1.0.8-beta.5', 'legacy']]) assert.throws(() => desktopJourney(...args))
})

test('stable candidate discovery requires exact downloaded stable version', () => {
  const status = {track: 'stable', state: 'downloaded', availableVersion: '1.0.9', checkedAt: '2026-09-30T00:00:00Z'}
  assert.equal(assertStableDiscovery(status, '1.0.9').availableVersion, '1.0.9')
  for (const change of [{track: 'beta'}, {state: 'not-available'}, {availableVersion: '1.0.8'}, {checkedAt: undefined}]) {
    assert.throws(() => assertStableDiscovery({...status, ...change}, '1.0.9'))
  }
})

test('native progress prints only a fixed phase and canonical timestamp', () => {
  const lines = [], write = line => lines.push(line)
  const at = '2026-09-27T20:17:13.123Z'
  emitNativeProgress('baseline-native-connected', at, write)
  assert.deepEqual(lines, [`${JSON.stringify({ kind: 'native-acceptance-progress', stage: 'baseline-native-connected', at })}\n`])
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['at', 'kind', 'stage'])
  for (const stage of ['', 'token=private', 'baseline-native-connected\nprivate', { stage: 'baseline-native-connected' }]) {
    assert.throws(() => emitNativeProgress(stage, at, write))
  }
  for (const timestamp of ['', 'private-profile', '2026-09-27T20:17:13Z', '2026-99-27T20:17:13.123Z', `${at}\nprivate`]) {
    assert.throws(() => emitNativeProgress('baseline-native-connected', timestamp, write))
  }
  assert.equal(lines.length, 1, 'invalid values must never reach the log writer')
})

test('reconciliation diagnostics project finite categories and equality flags without private fields', () => {
  const privateValue = 'private-token-https://private.example/profile'
  const snapshot = reconciliationSnapshot({ ...status(), state: 'idle', track: 'beta', message: privateValue,
    serverUpdates: [{ ...record(), phase: 'blocked', message: privateValue, name: privateValue, operationId: privateValue }] },
  { reachable: true, httpStatus: 200, health: { ...health(), private: privateValue } }, fixture(), identity.version)
  assert.equal(snapshot.code, 'COORDINATOR_BLOCKED')
  assert.equal(snapshot.recordPhase, 'blocked')
  assert.equal(snapshot.recordTargetMatches, true)
  assert.equal(snapshot.recordIdentityMatches, true)
  assert.equal(snapshot.healthVersionMatches, true)
  assert.equal(snapshot.healthInstanceChanged, true)
  assert.equal(snapshot.executionMaintenanceHeld, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /private|token|https:|server-identity|operationId|targetVersion/)
  const invalid = reconciliationSnapshot({ ...status(), state: privateValue, track: privateValue,
    serverUpdates: [{ ...record(), phase: privateValue, paused: privateValue }] },
  { reachable: true, httpStatus: privateValue, health: { ok: privateValue } }, fixture(), identity.version)
  assert.equal(invalid.appState, 'unknown')
  assert.equal(invalid.appTrack, 'unknown')
  assert.equal(invalid.recordPhase, 'unknown')
  assert.equal(invalid.recordPaused, null)
  assert.equal(invalid.healthHttpStatus, null)
  assert.doesNotMatch(JSON.stringify(invalid), /private-token/)
})

test('failed health and failed app probes preserve the independent successful observation', async () => {
  const app = { ...status(), state: 'idle', track: 'beta' }
  const first = await collectReconciliationSnapshot(() => app, () => { throw new Error('private URL/token') }, fixture(), identity.version)
  assert.equal(first.snapshot.appVersionMatches, true)
  assert.equal(first.snapshot.recordPhase, 'current')
  assert.equal(first.snapshot.healthReachable, false)
  assert.equal(first.snapshot.code, 'HEALTH_UNREACHABLE')
  const second = await collectReconciliationSnapshot(() => Promise.reject(new Error('private native log')),
    () => ({ reachable: true, httpStatus: 200, health: health() }), fixture(), identity.version)
  assert.equal(second.snapshot.code, 'APP_STATUS_UNAVAILABLE')
  assert.equal(second.snapshot.healthIdentityMatches, true)
  assert.equal(second.snapshot.healthVersionMatches, true)
  assert.doesNotMatch(JSON.stringify([first.snapshot, second.snapshot]), /private|Error|URL|token/)
})

test('public reconciliation parser rejects unbounded, extra and unexpected diagnostic values', () => {
  const snapshot = reconciliationSnapshot({ ...status(), state: 'idle', track: 'beta' },
    { reachable: false, httpStatus: null, health: null }, fixture(), identity.version)
  assert.deepEqual(parseReconciliationSnapshot(JSON.stringify(snapshot)), snapshot)
  for (const patch of [{ token: 'private' }, { code: 'private' }, { appState: 'secret' }, { appTrack: 'secret' },
    { recordPhase: 'secret' }, { healthHttpStatus: '200' }, { healthHttpStatus: 600 }, { appVersionMatches: 'yes' },
    { healthReachable: null }, { schema: 2 }, { kind: 'other' }]) {
    assert.throws(() => parseReconciliationSnapshot(JSON.stringify({ ...snapshot, ...patch })))
  }
  assert.throws(() => parseReconciliationSnapshot(' '.repeat(4097)))
  assert.throws(() => parseReconciliationSnapshot(JSON.stringify({ ...snapshot, healthValid: undefined })))
})

test('only repeated paused failure of the exact paired candidate ends reconciliation early', () => {
  const failed = reconciliationSnapshot({ ...status(), state: 'not-available', track: 'beta',
    serverUpdates: [{ ...record(), phase: 'failed', paused: true }] },
  { reachable: false, httpStatus: null, health: null }, fixture(), identity.version)
  assert.equal(terminalReconciliationFailure(null, failed), false)
  assert.equal(terminalReconciliationFailure(failed, failed), true)
  for (const patch of [{ recordPhase: 'offline' }, { recordPhase: 'blocked' }, { recordPhase: 'updating' },
    { recordPhase: 'pending' }, { recordPhase: 'current' }, { recordPaused: false }, { recordPaused: null },
    { recordTargetMatches: false }, { recordTargetMatches: null }, { recordIdentityMatches: false },
    { appVersionMatches: false }, { appStatusAvailable: false }, { recordPresent: false }]) {
    assert.equal(terminalReconciliationFailure({ ...failed, ...patch }, failed), false)
    assert.equal(terminalReconciliationFailure(failed, { ...failed, ...patch }), false)
  }
  assert.throws(() => terminalReconciliationFailure({ ...failed, token: 'private' }, failed))
  assert.throws(() => terminalReconciliationFailure(failed, { ...failed, recordPhase: 'raw private error' }))
})

test('parses only exact required absolute artifact and fixture paths', () => {
  assert.equal(parseDesktopAcceptanceArguments(valid)['baseline-version'], '1.0.6')
  for (const args of [[], [...valid, '--skip-signature', 'true'], [...valid, '--output', '/tmp/reused'],
    [...valid.slice(0, -1), 'relative'], [...valid, '--dangling'],
    valid.map(item => item === identity.releaseReceiptSha256 ? 'not-a-hash' : item)]) {
    assert.throws(() => parseDesktopAcceptanceArguments(args))
  }
})

test('candidate parser deliberately permits no preparation run, never a fake production run', () => {
  const args = valid.filter((value, index) => index !== 4 && index !== 5)
  assert.equal(parseDesktopAcceptanceArguments([...args, '--scope', 'candidate']).scope, 'candidate')
  assert.throws(() => parseDesktopAcceptanceArguments(args), /preparation-run/)
  assert.throws(() => parseDesktopAcceptanceArguments([...args, '--scope', 'release']), /preparation-run|scope/)
})

test('candidate fixture binds separately reviewed harness commit without replacing artifact source', () => {
  const harness = 'd'.repeat(40), env = { ...environment, GITHUB_SHA: harness }
  const candidate = { ...identity, kind: 'candidate' }
  assert.doesNotThrow(() => validateDesktopFixture({ ...fixture(), candidate: true, harnessSourceSha: harness }, candidate, env))
  assert.throws(() => validateDesktopFixture({ ...fixture(), candidate: true, harnessSourceSha: identity.sourceSha }, candidate, env), /harness checkout/)
  assert.throws(() => validateDesktopFixture({ ...fixture(), harnessSourceSha: harness }, candidate, env), /harness checkout/)
})

test('requires exact canonical disposable workflow context before native side effects', () => {
  assert.doesNotThrow(() => assertDesktopRunner(environment, 'darwin'))
  for (const patch of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF.replace('acceptance.yml', 'release.yml') },
    { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF.replace('refs/heads/release/candidate', 'refs/pull/44/merge') },
    { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_SHA: '' }, { RUNNER_TEMP: '/' }]) {
    assert.throws(() => assertDesktopRunner({ ...environment, ...patch }, 'darwin'))
  }
  assert.throws(() => assertDesktopRunner({ ...environment, RUNNER_OS: 'Linux' }, 'linux'))
})

test('developer-machine CLI refuses before opening fixture files or installing anything', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../product_desktop_acceptance.mjs'), ...valid], {
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /restricted to the canonical acceptance workflow/)
  assert.doesNotMatch(result.stderr, /ENOENT|codesign|keychain|download failed/)
})

test('baseline must actually precede candidate, including prerelease ordering', () => {
  for (const pair of [['1.0.6', identity.version], ['1.0.7-beta.16', identity.version], ['1.0.7-beta.17', '1.0.7']]) {
    assert.doesNotThrow(() => assertOlderVersion(...pair))
  }
  for (const pair of [[identity.version, identity.version], ['1.0.7', identity.version], ['1.0.8-beta.1', identity.version],
    ['1.0.7-beta.18', identity.version], ['1.0.3+local', identity.version]]) assert.throws(() => assertOlderVersion(...pair))
})

test('owned populated service fixture is bound to exact source, receipt and acceptance run', () => {
  assert.deepEqual(validateDesktopFixture(fixture(), identity, environment), fixture())
  for (const patch of [{ schema: 2 }, { sourceSha: 'd'.repeat(40) }, { releaseReceiptSha256: 'd'.repeat(64) },
    { runId: '124' }, { runAttempt: '2' }, { runAttempt: undefined }, { targetVersion: '1.0.7-beta.18' }, { baselineStateSha256: undefined },
    { baselineVersion: '1.0.8' }, { serverIdentity: '' }, { serverInstanceId: '' }, { token: 'a\nmalicious' },
    { installRoot: '.' }, { stateRoot: '' }]) {
    assert.throws(() => validateDesktopFixture({ ...fixture(), ...patch }, identity, environment))
  }
})

test('fixture refuses external, privileged, redirected or credential-bearing URLs', () => {
  for (const serverUrl of ['https://127.0.0.1:18753', 'http://example.com:18753', 'http://localhost:18753',
    'http://127.0.0.1:80', 'http://user:token@127.0.0.1:18753', 'http://127.0.0.1:18753/path',
    'http://127.0.0.1:18753/?token=x', 'http://127.0.0.1:18753/#fragment']) {
    assert.throws(() => validateDesktopFixture({ ...fixture(), serverUrl }, identity, environment))
  }
})

test('baseline archive checksum requires one exact canonical filename', () => {
  const line = `${'a'.repeat(64)}  AgentsDock-1.0.6-mac-universal.zip`
  assert.deepEqual(checksumForMacArchive(`${line}\n`, '1.0.6'), { name: 'AgentsDock-1.0.6-mac-universal.zip', sha256: 'a'.repeat(64) })
  for (const text of ['', line.replace('1.0.6', '1.0.5'), `${line}\n${line}`, line.replace(/^a/, 'z'),
    line.replace('  AgentsDock', ' \tAgentsDock'), ' '.repeat(65537)]) assert.throws(() => checksumForMacArchive(text, '1.0.6'))
})

test('completed production coordinator and actual new service must agree', () => {
  assert.equal(assertCurrentPairedServer(status(), health(), fixture(), identity.version).serviceInstanceChanged, true)
  for (const patch of [{ server_version: '1.0.6' }, { server_identity: 'different-server' }, { ok: false },
    { server_instance_id: fixture().serverInstanceId }, { gateway: { version: '1.0.6' } },
    { execution_service: { version: identity.version, maintenance_held: true } }]) {
    assert.throws(() => assertCurrentPairedServer(status(), { ...health(), ...patch }, fixture(), identity.version))
  }
  for (const patch of [{ phase: 'updating' }, { phase: 'failed' }, { paused: true }, { targetVersion: '1.0.7-beta.18' },
    { serverIdentity: 'another-server' }]) {
    assert.throws(() => assertCurrentPairedServer({ ...status(), serverUpdates: [{ ...record(), ...patch }] }, health(), fixture(), identity.version))
  }
})

test('rendered server status must match actual offline/current semantics', () => {
  const rows = [{ name: 'Acceptance legacy server', description: 'Cannot connect; reconnect to resume.', phaseLabel: 'Reconnect to resume' }]
  assert.deepEqual(assertVisibleCoordinatedRow(rows, 'offline'), rows[0])
  assert.doesNotThrow(() => assertVisibleCoordinatedRow([{ ...rows[0], phaseLabel: 'Up to date' }], 'current'))
  for (const values of [[], [...rows, ...rows], [{ ...rows[0], name: 'Other server' }],
    [{ ...rows[0], description: '' }], [{ ...rows[0], phaseLabel: 'Failed' }]]) {
    assert.throws(() => assertVisibleCoordinatedRow(values, 'offline'))
  }
})

test('Stable must complete discovery without offering a beta', () => {
  const base = { track: 'stable', state: 'not-available', checkedAt: '2026-09-27T00:00:00Z' }
  assert.equal(assertStableDiscovery(base, identity.version).availableVersion, null)
  for (const patch of [{ track: 'beta' }, { state: 'idle' }, { state: 'error' }, { state: 'downloading' },
    { availableVersion: identity.version }, { checkedAt: undefined }]) {
    assert.throws(() => assertStableDiscovery({ ...base, ...patch }, identity.version))
  }
  assert.doesNotThrow(() => assertStableDiscovery({ ...base, state: 'downloaded', availableVersion: '1.0.7' }, '1.0.7'))
  assert.throws(() => assertStableDiscovery(base, '1.0.7'))
})

test('multiple-client pass requires both actual receipts to identify one update operation and final instance', () => {
  assert.equal(assertSharedOperation(status(), status(), fixture(), identity.version).nativeClientCount, 2)
  for (const patch of [{ operationId: 'another-operation' }, { operationId: undefined }, { phase: 'offline' },
    { serverInstanceId: 'another-instance' }, { serverIdentity: 'other-server' }, { targetVersion: '1.0.6' }]) {
    assert.throws(() => assertSharedOperation(status(), { ...status(), serverUpdates: [{ ...record(), ...patch }] }, fixture(), identity.version))
  }
  const noReceipt = { ...status(), serverUpdates: [{ ...record(), operationId: undefined }] }
  assert.throws(() => assertSharedOperation(noReceipt, noReceipt, fixture(), identity.version))
})

test('shared receipts compare schedule and execution identifiers in their own namespaces', () => {
  const withReceipt = patch => ({ ...status(), serverUpdates: [{ ...record(), ...patch }] })
  const scheduleOnly = withReceipt({ operationId: undefined, scheduleId: 'common-reservation' })
  const both = withReceipt({ operationId: 'execution-operation', scheduleId: 'common-reservation' })
  for (const pair of [[scheduleOnly, both], [both, scheduleOnly]]) {
    const observed = assertSharedOperation(...pair, fixture(), identity.version)
    assert.equal(observed.sharedOperationKind, 'schedule')
    assert.equal(observed.sharedOperationObserved, true)
    assert.match(observed.sharedOperationSha256, /^[a-f0-9]{64}$/)
  }
  const executionOnly = withReceipt({ operationId: 'execution-operation' })
  for (const pair of [[executionOnly, both], [both, executionOnly]]) {
    assert.equal(assertSharedOperation(...pair, fixture(), identity.version).sharedOperationKind, 'update')
  }
  const commonTextDifferentTypes = [withReceipt({ operationId: 'same-text' }),
    withReceipt({ operationId: undefined, scheduleId: 'same-text' })]
  assert.throws(() => assertSharedOperation(...commonTextDifferentTypes, fixture(), identity.version))
  // Any contradictory jointly-present identifier rejects even a common ID of
  // the other type. A healthy/current server is not a substitute for joining.
  for (const patch of [{ scheduleId: 'different-reservation' }, { operationId: 'different-execution' }]) {
    assert.throws(() => assertSharedOperation(both, withReceipt({ operationId: 'execution-operation',
      scheduleId: 'common-reservation', ...patch }), fixture(), identity.version))
  }
})

test('shared-operation assertion rejects malformed, absent or ambiguous profile evidence', () => {
  const good = { ...status(), serverUpdates: [{ ...record(), scheduleId: 'common-reservation' }] }
  for (const field of ['operationId', 'scheduleId', 'serverInstanceId']) {
    for (const value of ['', ' ', 'line\nbreak', 'x'.repeat(513), 12, false, {}, []]) {
      const bad = { ...good, serverUpdates: [{ ...good.serverUpdates[0], [field]: value }] }
      assert.throws(() => assertSharedOperation(good, bad, fixture(), identity.version), `${field} must be a valid bounded identifier`)
    }
  }
  for (const bad of [null, {}, { serverUpdates: {} }, { serverUpdates: [] },
    { ...good, currentVersion: '1.0.6' }, { ...good, currentVersion: undefined },
    { ...good, serverUpdates: [record(), record()] },
    { ...good, serverUpdates: [{ ...record(), paused: true }] },
    { ...good, serverUpdates: [{ ...record(), profileId: 'other-profile' }] },
    { ...good, serverUpdates: [{ ...record(), serverIdentity: 'other-server' }] }]) {
    assert.throws(() => assertSharedOperation(good, bad, fixture(), identity.version))
    assert.throws(() => assertSharedOperation(bad, good, fixture(), identity.version))
  }
  const missing = { ...status(), serverUpdates: [{ ...record(), operationId: null, scheduleId: null }] }
  assert.throws(() => assertSharedOperation(missing, missing, fixture(), identity.version))
})

const sharedSnapshot = (second = status(), first = status(), stage = 'completed-wait') => collectSharedOperationSnapshot(
  () => first, () => second, () => ({ reachable: true, httpStatus: 200, health: health() }), fixture(), identity.version, stage)

test('paired diagnostics distinguish a late current client without a receipt from divergent operations or instances', async () => {
  const accepted = (await sharedSnapshot()).snapshot
  assert.equal(accepted.updateRelation, 'same')
  assert.equal(accepted.scheduleRelation, 'unavailable')
  assert.equal(accepted.instanceRelation, 'same')
  assert.equal(accepted.secondInstanceMatchesHealth, true)
  const missing = { ...status(), serverUpdates: [{ ...record(), operationId: undefined }] }
  const late = (await sharedSnapshot(missing)).snapshot
  assert.equal(late.second.recordPhase, 'current')
  assert.equal(late.second.operationPresent, false)
  assert.equal(late.secondOperationSource, 'missing')
  assert.equal(late.updateRelation, 'unavailable')
  assert.equal(late.scheduleRelation, 'unavailable')
  assert.equal(late.instanceRelation, 'same')
  assert.throws(() => assertSharedOperation(status(), missing, fixture(), identity.version),
    'Observing an already-current client without an operation must not become shared-operation acceptance')
  const different = (await sharedSnapshot({ ...status(), serverUpdates: [{ ...record(),
    operationId: 'another-operation', serverInstanceId: 'different-instance' }] })).snapshot
  assert.equal(different.updateRelation, 'different')
  assert.equal(different.instanceRelation, 'different')
  assert.equal(different.secondInstanceMatchesHealth, false)
  const schedule = (await sharedSnapshot({ ...status(), serverUpdates: [{ ...record(),
    operationId: undefined, scheduleId: record().operationId }] })).snapshot
  assert.equal(schedule.updateRelation, 'unavailable')
  assert.equal(schedule.scheduleRelation, 'unavailable')
  assert.equal(schedule.secondOperationSource, 'schedule')
})

test('paired diagnostics report schedule and execution equality separately without cross-type matches', async () => {
  const first = { ...status(), serverUpdates: [{ ...record(), operationId: undefined, scheduleId: 'PRIVATE-common-schedule' }] }
  const second = { ...status(), serverUpdates: [{ ...record(), operationId: 'PRIVATE-execution', scheduleId: 'PRIVATE-common-schedule' }] }
  const { snapshot } = await sharedSnapshot(second, first)
  assert.equal(snapshot.scheduleRelation, 'same')
  assert.equal(snapshot.updateRelation, 'unavailable')
  assert.equal(snapshot.firstOperationSource, 'schedule')
  assert.equal(snapshot.secondOperationSource, 'operation')
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/)
  const mismatch = (await sharedSnapshot({ ...second, serverUpdates: [{ ...second.serverUpdates[0],
    scheduleId: 'PRIVATE-different' }] }, first)).snapshot
  assert.equal(mismatch.scheduleRelation, 'different')
  assert.equal(mismatch.updateRelation, 'unavailable')
})

test('paired diagnostics retain each client phase and never expose private identifiers or raw errors', async () => {
  const secret = 'PRIVATE-TOKEN-https://private.example/profile'
  const privateStatus = { ...status(), error: secret, serverUpdates: [{ ...record(), operationId: secret,
    serverInstanceId: secret, name: secret, message: secret, phase: 'blocked', paused: true }] }
  const { snapshot } = await sharedSnapshot(privateStatus)
  assert.equal(snapshot.first.recordPhase, 'current')
  assert.equal(snapshot.second.recordPhase, 'blocked')
  assert.equal(snapshot.second.recordPaused, true)
  assert.equal(snapshot.updateRelation, 'different')
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|private\.example|server-identity-owned|one-production-operation|new-service-instance/)
  const oversized = (await sharedSnapshot({ ...status(), serverUpdates: [{ ...record(), operationId: 'x'.repeat(100_000) }] })).snapshot
  assert.equal(oversized.secondOperationSource, 'invalid')
  assert.equal(oversized.updateRelation, 'unavailable')
  assert(Buffer.byteLength(JSON.stringify(oversized)) < 12 * 1024)
})

test('stalled or rejected second-client observation preserves independent first-client and health evidence', async () => {
  const collect = readSecond => collectSharedOperationSnapshot(() => status(), readSecond,
    () => ({ reachable: true, httpStatus: 200, health: health() }), fixture(), identity.version, 'failure', 5)
  const stalled = await collect(() => new Promise(() => {}))
  assert.equal(stalled.snapshot.secondRead, 'timed-out')
  assert.equal(stalled.snapshot.firstRead, 'fulfilled')
  assert.equal(stalled.snapshot.healthRead, 'fulfilled')
  assert.equal(stalled.snapshot.first.recordPhase, 'current')
  assert.equal(stalled.snapshot.first.healthVersionMatches, true)
  assert.equal(stalled.snapshot.second.appStatusAvailable, false)
  const rejected = await collect(() => { throw new Error('PRIVATE renderer error') })
  assert.equal(rejected.snapshot.secondRead, 'rejected')
  assert.doesNotMatch(JSON.stringify(rejected.snapshot), /PRIVATE/)
  const noHealth = await collectSharedOperationSnapshot(() => status(), () => status(), () => new Promise(() => {}),
    fixture(), identity.version, 'failure', 5)
  assert.equal(noHealth.snapshot.healthRead, 'timed-out')
  assert.equal(noHealth.snapshot.updateRelation, 'same')
  assert.equal(noHealth.snapshot.firstInstanceMatchesHealth, null)
})

test('shared diagnostic parser rejects unknown fields, unbounded data and invalid nested evidence', async () => {
  const value = (await sharedSnapshot()).snapshot
  assert.deepEqual(parseSharedOperationSnapshot(JSON.stringify(value)), value)
  for (const patch of [{ token: 'secret' }, { schema: 2 }, { stage: 'raw-private-message' }, { firstRead: 'success' },
    { updateRelation: 'secret-id' }, { scheduleRelation: 'secret-id' }, { operationRelation: 'same' },
    { secondOperationSource: 'secret-id' }, { firstInstanceMatchesHealth: 'true' },
    { first: { ...value.first, rawStatus: 'private' } }]) {
    assert.throws(() => parseSharedOperationSnapshot(JSON.stringify({ ...value, ...patch })))
  }
  assert.throws(() => parseSharedOperationSnapshot(' '.repeat(12 * 1024 + 1)))
  assert.throws(() => parseSharedOperationSnapshot(JSON.stringify(null)))
  for (const milliseconds of [0, -1, 5001, 1.5]) {
    await assert.rejects(collectSharedOperationSnapshot(() => status(), () => status(), () => null,
      fixture(), identity.version, 'failure', milliseconds))
  }
})

test('paired diagnostic history is deduplicated, bounded and preserves the initial observation', async () => {
  const history = []
  const initial = (await sharedSnapshot(status(), status(), 'offline')).snapshot
  retainSharedOperationObservation(history, initial)
  retainSharedOperationObservation(history, initial)
  assert.equal(history.length, 1)
  for (let index = 0; index < 30; index += 1) {
    const snapshot = (await sharedSnapshot({ ...status(), serverUpdates: [{ ...record(),
      phase: index % 2 ? 'pending' : 'current' }] }, status(), 'reconciling')).snapshot
    retainSharedOperationObservation(history, snapshot)
  }
  assert.equal(history.length, 12)
  assert.deepEqual(history[0], initial)
  assert.equal(history.at(-1).second.recordPhase, 'pending')
  const before = JSON.stringify(history)
  assert.throws(() => retainSharedOperationObservation(history, { ...initial, secret: 'private' }))
  assert.equal(JSON.stringify(history), before)
})

test('empty persisted chat is not full legacy-history/native-ID preservation acceptance', () => {
  for (const snapshot of [undefined, { sessions: {} }, { sessions: { a: { identity: {}, eventHashes: [], queued: [] } } },
    { sessions: { a: { identity: {}, eventHashes: ['a'.repeat(64)] } } },
    { sessions: { a: { identity: { codex_thread_id: 'thread-owned' }, eventHashes: [] } } }]) {
    assert.equal(migrationCoverage(snapshot).populatedNativeHistoryObserved, false)
  }
  const coverage = migrationCoverage({ sessions: { a: { identity: { codex_thread_id: 'thread-owned' },
    eventHashes: ['a'.repeat(64)], queued: [{ id: 'queued-owned' }] } } })
  assert.equal(coverage.populatedNativeHistoryObserved, true)
  assert.equal(coverage.queuedMessageCount, 1)
})

test('native diagnostics are bounded and drain excess without terminating app streams', () => {
  const chunks = [], stream = { write: chunk => chunks.push(Buffer.from(chunk)), end: () => { stream.ended = true } }
  const logs = boundedNativeLog(stream, 8)
  logs.write('abcdef')
  logs.write(Buffer.from('ghijkl'))
  logs.write('more output')
  assert.equal(Buffer.concat(chunks).toString(), 'abcdefgh')
  assert.deepEqual(logs.counts, { bytesWritten: 8, bytesDropped: 15 })
  assert.equal(stream.ended, undefined)
  logs.end()
  logs.write('post-end')
  assert.equal(logs.counts.bytesWritten, 8)
  assert.equal(stream.ended, true)
  assert.doesNotThrow(() => logs.assertHealthy())
})
