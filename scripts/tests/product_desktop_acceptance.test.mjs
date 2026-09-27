import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertCurrentPairedServer, assertDesktopRunner, assertOlderVersion, assertSharedOperation, boundedNativeLog,
  assertStableDiscovery, assertVisibleCoordinatedRow, checksumForMacArchive,
  migrationCoverage, parseDesktopAcceptanceArguments, validateDesktopFixture } from '../product_desktop_acceptance.mjs'

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
