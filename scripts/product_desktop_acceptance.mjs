#!/usr/bin/env node
/**
 * Exact-artifact desktop acceptance on a disposable hosted macOS runner.
 * No updater patch, IPC mutation, provider stub, or server replacement is used.
 * Origin replay and the real populated legacy service are prepared separately.
 * This script never changes the developer machine's DNS or certificate trust.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, createWriteStream, existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertReplayRunner, createProductReplay, createCandidateReplay } from './product-release-replay.mjs'
import { assertCandidateCheckout, assertCandidateRunner } from './product-candidate-receipt.mjs'
import { appVersion, assertMigrationTrack, connect, freePort, hashFile, MIGRATION_INSTALL_BUTTON_NAMES,
  openMigrationUpdateSettings, processesFor, run, stopOwned, until, verifyApp } from './verify_electron_migration.mjs'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/
const HASH = /^[a-f0-9]{64}$/
const PROFILE_ID = 'product-acceptance-legacy'
const PROFILE_NAME = 'Acceptance legacy server'
const KEYCHAIN_SERVICE = 'com.zhengyiluo.AgentsDock'
const KEYCHAIN_ACCOUNT = `agent-access-token:${PROFILE_ID}`
const SERVER_HELPER = fileURLToPath(new URL('./product_server_acceptance.py', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function boundedNativeLog(stream, limit = 16 * 1024 * 1024) {
  assert(Number.isSafeInteger(limit) && limit > 0, 'Native log limit must be positive')
  const counts = { bytesWritten: 0, bytesDropped: 0 }
  let ended = false, failure
  stream.on?.('error', () => { failure = new Error('Private native acceptance log could not be written') })
  return {
    counts,
    write(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const remaining = ended ? 0 : Math.max(0, limit - counts.bytesWritten)
      const accepted = Math.min(remaining, bytes.length)
      if (accepted) stream.write(bytes.subarray(0, accepted))
      counts.bytesWritten += accepted
      counts.bytesDropped += bytes.length - accepted
    },
    assertHealthy() { if (failure) throw failure },
    end() { if (!ended) { ended = true; stream.end() } }
  }
}

const NATIVE_PROGRESS_PHASES = new Set(['baseline-artifact-verification-starting', 'baseline-artifact-verified',
  'candidate-artifact-verification-starting', 'candidate-artifact-verified', 'baseline-renderer-connecting',
  'updated-renderer-connecting', 'second-renderer-connecting', 'baseline-native-connected', 'stable-subscription-observed', 'beta-subscription-observed',
  'server-offline-before-app-install', 'trusted-native-input-restart-to-update', 'native-replacement-and-relaunch',
  'offline-pending-visible', 'second-native-client-waiting', 'owned-legacy-service-start-requested',
  'two-native-clients-share-one-completed-update', 'paired-service-current'])

export function emitNativeProgress(stage, at, write = line => process.stdout.write(line)) {
  assert(NATIVE_PROGRESS_PHASES.has(stage), 'Unknown native progress stage')
  assert(typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)
    && new Date(at).toISOString() === at, 'Invalid native progress timestamp')
  // Detailed observations remain in bounded evidence. Live logs contain no
  // profile values, updater messages, URLs, credentials or native process logs.
  write(`${JSON.stringify({ kind: 'native-acceptance-progress', stage, at })}\n`)
}

export function assertOlderVersion(previous, candidate) {
  assert(VERSION.test(previous) && VERSION.test(candidate), 'Invalid comparison version')
  const parts = version => {
    const [base, beta] = version.split('-beta.')
    return [...base.split('.').map(Number), beta === undefined ? Infinity : Number(beta)]
  }
  const a = parts(previous), b = parts(candidate)
  const firstDifference = a.findIndex((value, index) => value !== b[index])
  assert(firstDifference >= 0 && a[firstDifference] < b[firstDifference], 'Baseline must be strictly older than the candidate')
}

export function parseDesktopAcceptanceArguments(argv) {
  const required = ['receipt', 'receipt-sha256', 'preparation-run', 'server-directory', 'desktop-directory',
    'baseline-directory', 'baseline-version', 'server-fixture', 'output']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    assert(argv[i] === `--${key}` && [...required, 'scope'].includes(key) && argv[i + 1] && !Object.hasOwn(options, key),
      `Unknown, incomplete or duplicate argument: ${argv[i]}`)
    options[key] = argv[i + 1]
  }
  for (const key of required) if (!(options.scope === 'candidate' && key === 'preparation-run')) assert(options[key], `Missing --${key}`)
  assert(options.scope === undefined || options.scope === 'candidate', 'Unknown desktop acceptance scope')
  assert(HASH.test(options['receipt-sha256']), 'Invalid accepted receipt hash')
  assert(VERSION.test(options['baseline-version']), 'Invalid baseline version')
  for (const key of required.filter(key => !['receipt-sha256', 'baseline-version'].includes(key))) {
    if (!options[key]) continue
    assert(isAbsolute(options[key]), `--${key} must be absolute`)
    options[key] = resolve(options[key])
  }
  return options
}

export function assertDesktopRunner(env = process.env, platform = process.platform) {
  assertReplayRunner(env, platform)
  assert(platform === 'darwin' && env.RUNNER_OS === 'macOS', 'Desktop replacement acceptance requires a disposable macOS runner')
  assert(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Acceptance run identity is missing')
}

async function regularJSON(path, maximum = 32768) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    assert(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Expected bounded regular JSON file')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

async function assertInsideRunner(path, newDirectory = false) {
  const root = await realpath(process.env.RUNNER_TEMP)
  const actual = newDirectory ? join(await realpath(dirname(path)), basename(path)) : await realpath(path)
  const part = relative(root, actual)
  assert(root !== '/' && part && !part.startsWith('..') && !isAbsolute(part), 'Acceptance inputs and output must be inside RUNNER_TEMP')
  if (newDirectory) assert(!existsSync(actual), 'Refusing to reuse an acceptance output directory')
  else assert(!(await lstat(path)).isSymbolicLink(), 'Acceptance inputs cannot be symlinks')
  return actual
}

export function validateDesktopFixture(fixture, identity, env = process.env) {
  assert(fixture.schema === 1, 'Unsupported server fixture schema')
  assert(fixture.sourceSha === identity.sourceSha && fixture.releaseReceiptSha256 === identity.releaseReceiptSha256,
    'Server fixture belongs to another prepared source or receipt')
  assert(String(fixture.runId) === env.GITHUB_RUN_ID, 'Server fixture belongs to another acceptance run')
  assert(String(fixture.runAttempt) === env.GITHUB_RUN_ATTEMPT, 'Server fixture belongs to another acceptance run attempt')
  if (identity.kind === 'candidate') {
    assert(fixture.candidate === true && fixture.harnessSourceSha === env.GITHUB_SHA,
      'Server fixture belongs to another candidate harness checkout')
  }
  assert(fixture.targetVersion === identity.version && VERSION.test(fixture.baselineVersion)
    && fixture.baselineVersion !== fixture.targetVersion, 'An actual older server fixture is required')
  assertOlderVersion(fixture.baselineVersion, fixture.targetVersion)
  assert(typeof fixture.serverIdentity === 'string' && fixture.serverIdentity.length >= 8
    && typeof fixture.serverInstanceId === 'string' && fixture.serverInstanceId.length >= 8, 'Missing server fixture identity')
  assert(typeof fixture.token === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,511}$/.test(fixture.token),
    'Fixture requires its private, bounded disposable token')
  const url = new URL(fixture.serverUrl)
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port)
    && Number(url.port) > 1024 && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Only an owned loopback fixture is allowed')
  assert(HASH.test(fixture.baselineStateSha256 ?? ''), 'Populate and snapshot the real legacy server before desktop acceptance')
  for (const key of ['installRoot', 'stateRoot', 'configRoot', 'workDirectory']) assert(isAbsolute(fixture[key] ?? ''), `Missing fixture ${key}`)
  return fixture
}

export function checksumForMacArchive(text, version) {
  const name = `AgentsDock-${version}-mac-universal.zip`
  assert(Buffer.byteLength(text) <= 65536, 'Oversized baseline checksum manifest')
  const values = text.split(/\r?\n/).filter(line => line.slice(66).replace(/^\*/, '') === name)
  assert(values.length === 1 && HASH.test(values[0].slice(0, 64)) && values[0].slice(64, 66) === '  ',
    'Missing, malformed or duplicate baseline ZIP checksum')
  return { name, sha256: values[0].slice(0, 64) }
}

async function extractVerifiedApp(directory, version, destination) {
  const expected = checksumForMacArchive(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), version)
  const archive = join(directory, expected.name)
  assert((await lstat(archive)).isFile() && !(await lstat(archive)).isSymbolicLink(), 'ZIP must be a regular file')
  assert.equal(await hashFile(archive), expected.sha256, 'ZIP differs from its pinned checksum manifest')
  run('python3', [fileURLToPath(new URL('./verify_electron_app_zip.py', import.meta.url)), archive])
  await mkdir(destination)
  run('/usr/bin/ditto', ['-x', '-k', archive, destination])
  const app = join(destination, 'AgentsDock.app')
  verifyApp(app, version)
  return { app, zipSha256: expected.sha256, asarSha256: await hashFile(join(app, 'Contents/Resources/app.asar')) }
}

async function serverHealth(fixture) {
  const response = await fetch(`${fixture.serverUrl.replace(/\/$/, '')}/api/health`, {
    headers: { 'X-AgentsDock-Token': fixture.token }, redirect: 'error', signal: AbortSignal.timeout(2000)
  })
  assert(response.ok, `Owned service health failed (${response.status})`)
  const health = await response.json()
  assert(health.ok && health.server_identity === fixture.serverIdentity, 'Health belongs to a different server identity')
  return health
}

async function assertOffline(fixture) {
  try {
    await fetch(`${fixture.serverUrl.replace(/\/$/, '')}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) })
    return false
  } catch { return true }
}

function serviceCommand(options, fixture, command, extra, evidenceName) {
  const args = [SERVER_HELPER, command, '--receipt', options.receipt, '--receipt-sha256', options['receipt-sha256'],
    ...(options['preparation-run'] ? ['--prepare-run', options['preparation-run']] : []),
    '--bundle', options['server-directory'], '--work', fixture.workDirectory,
    '--fixture', options['server-fixture'], '--evidence', join(options.output, evidenceName),
    ...(options.scope === 'candidate' ? ['--candidate'] : []), ...extra]
  const text = execFileSync('python3', args, { encoding: 'utf8', timeout: command === 'diagnose' ? 60_000 : 15 * 60_000, maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] })
  const observed = JSON.parse(text)
  assert(observed.observed === true && HASH.test(observed.evidenceSha256), 'Service helper did not return observed evidence')
  return observed
}

const RECONCILIATION_STATES = new Set(['disabled', 'idle', 'checking', 'available', 'downloading', 'downloaded', 'installing', 'not-available', 'error', 'unknown'])
const RECONCILIATION_PHASES = new Set(['checking', 'pending', 'updating', 'current', 'offline', 'blocked', 'failed', 'missing', 'unknown'])
const RECONCILIATION_CODES = new Set(['OBSERVED', 'APP_STATUS_UNAVAILABLE', 'APP_STATUS_INVALID', 'HEALTH_UNREACHABLE',
  'HEALTH_HTTP_ERROR', 'HEALTH_RESPONSE_INVALID', 'COORDINATOR_BLOCKED', 'COORDINATOR_FAILED'])
const RECONCILIATION_KEYS = ['schema', 'kind', 'code', 'appStatusAvailable', 'appState', 'appTrack', 'appVersionMatches',
  'recordPresent', 'recordPhase', 'recordTargetMatches', 'recordIdentityMatches', 'recordPaused', 'operationPresent',
  'healthReachable', 'healthHttpStatus', 'healthValid', 'healthOk', 'healthIdentityMatches', 'healthVersionMatches',
  'healthInstanceChanged', 'gatewayVersionMatches', 'executionVersionMatches', 'executionMaintenanceHeld']

export function parseReconciliationSnapshot(bytes) {
  assert(typeof bytes === 'string' || Buffer.isBuffer(bytes), 'Invalid reconciliation diagnostic bytes')
  assert(Buffer.byteLength(bytes) <= 4096, 'Reconciliation diagnostic exceeds bound')
  const value = JSON.parse(String(bytes))
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...RECONCILIATION_KEYS].sort().join('\0'), 'Invalid reconciliation diagnostic fields')
  assert(value.schema === 1 && value.kind === 'native-reconciliation-snapshot' && RECONCILIATION_CODES.has(value.code)
    && RECONCILIATION_STATES.has(value.appState) && ['stable', 'beta', 'unknown'].includes(value.appTrack)
    && RECONCILIATION_PHASES.has(value.recordPhase), 'Invalid reconciliation diagnostic enum')
  assert(value.healthHttpStatus === null || (Number.isInteger(value.healthHttpStatus) && value.healthHttpStatus >= 100
    && value.healthHttpStatus <= 599), 'Invalid reconciliation HTTP status')
  for (const key of ['appStatusAvailable', 'recordPresent', 'operationPresent', 'healthReachable', 'healthValid']) {
    assert(typeof value[key] === 'boolean', 'Invalid reconciliation observation flag')
  }
  for (const key of RECONCILIATION_KEYS.filter(key => key.endsWith('Matches') || key.endsWith('Changed')
    || ['recordPaused', 'healthOk', 'executionMaintenanceHeld'].includes(key))) {
    assert(value[key] === null || typeof value[key] === 'boolean', 'Invalid reconciliation comparison flag')
  }
  return value
}

export function reconciliationSnapshot(status, healthProbe, fixture, version) {
  const validStatus = status && typeof status === 'object' && !Array.isArray(status)
  const record = validStatus && Array.isArray(status.serverUpdates)
    ? status.serverUpdates.find(item => item && item.profileId === PROFILE_ID) : null
  const rawHealth = healthProbe?.health
  const health = rawHealth && typeof rawHealth === 'object' && !Array.isArray(rawHealth) ? rawHealth : null
  const compare = (value, expected) => typeof value === 'string' ? value === expected : null
  const bool = value => typeof value === 'boolean' ? value : null
  const httpStatus = Number.isInteger(healthProbe?.httpStatus) && healthProbe.httpStatus >= 100 && healthProbe.httpStatus <= 599
    ? healthProbe.httpStatus : null
  const reachable = healthProbe?.reachable === true
  const code = !status ? 'APP_STATUS_UNAVAILABLE' : !validStatus ? 'APP_STATUS_INVALID'
    : !reachable ? 'HEALTH_UNREACHABLE' : httpStatus === null || httpStatus < 200 || httpStatus >= 300 ? 'HEALTH_HTTP_ERROR'
    : !health ? 'HEALTH_RESPONSE_INVALID' : record?.phase === 'blocked' ? 'COORDINATOR_BLOCKED'
    : record?.phase === 'failed' ? 'COORDINATOR_FAILED' : 'OBSERVED'
  return parseReconciliationSnapshot(JSON.stringify({ schema: 1, kind: 'native-reconciliation-snapshot', code,
    appStatusAvailable: Boolean(validStatus), appState: RECONCILIATION_STATES.has(status?.state) ? status.state : 'unknown',
    appTrack: ['stable', 'beta'].includes(status?.track) ? status.track : 'unknown', appVersionMatches: compare(status?.currentVersion, version),
    recordPresent: Boolean(record), recordPhase: record ? (RECONCILIATION_PHASES.has(record.phase) ? record.phase : 'unknown') : 'missing',
    recordTargetMatches: compare(record?.targetVersion, version), recordIdentityMatches: compare(record?.serverIdentity, fixture.serverIdentity),
    recordPaused: bool(record?.paused), operationPresent: typeof (record?.operationId || record?.scheduleId) === 'string'
      && (record.operationId || record.scheduleId).length > 0,
    healthReachable: reachable, healthHttpStatus: httpStatus, healthValid: Boolean(health), healthOk: bool(health?.ok),
    healthIdentityMatches: compare(health?.server_identity, fixture.serverIdentity), healthVersionMatches: compare(health?.server_version, version),
    healthInstanceChanged: typeof health?.server_instance_id === 'string' ? health.server_instance_id !== fixture.serverInstanceId : null,
    gatewayVersionMatches: compare(health?.gateway?.version, version), executionVersionMatches: compare(health?.execution_service?.version, version),
    executionMaintenanceHeld: bool(health?.execution_service?.maintenance_held) }))
}

export async function collectReconciliationSnapshot(readStatus, readHealth, fixture, version) {
  const [appResult, healthResult] = await Promise.allSettled([
    Promise.resolve().then(readStatus), Promise.resolve().then(readHealth)])
  const status = appResult.status === 'fulfilled' ? appResult.value : null
  const probe = healthResult.status === 'fulfilled' ? healthResult.value : null
  return { status, probe, snapshot: reconciliationSnapshot(status, probe, fixture, version) }
}

const SHARED_SNAPSHOT_KEYS = ['schema', 'kind', 'stage', 'firstRead', 'secondRead', 'healthRead', 'first', 'second',
  'firstOperationSource', 'secondOperationSource', 'updateRelation', 'scheduleRelation', 'instanceRelation',
  'firstInstanceMatchesHealth', 'secondInstanceMatchesHealth']
const SHARED_READ_STATES = new Set(['fulfilled', 'rejected', 'timed-out'])
const SHARED_STAGES = new Set(['offline', 'reconciling', 'completed-wait', 'failure'])

export function parseSharedOperationSnapshot(bytes) {
  assert(typeof bytes === 'string' || Buffer.isBuffer(bytes), 'Invalid shared-operation diagnostic bytes')
  assert(Buffer.byteLength(bytes) <= 12 * 1024, 'Shared-operation diagnostic exceeds bound')
  const value = JSON.parse(String(bytes))
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...SHARED_SNAPSHOT_KEYS].sort().join('\0'), 'Invalid shared-operation fields')
  assert(value.schema === 1 && value.kind === 'native-shared-operation-snapshot' && SHARED_STAGES.has(value.stage),
    'Invalid shared-operation diagnostic enum')
  for (const key of ['firstRead', 'secondRead', 'healthRead']) assert(SHARED_READ_STATES.has(value[key]), 'Invalid shared read state')
  for (const key of ['firstOperationSource', 'secondOperationSource']) {
    assert(['operation', 'schedule', 'missing', 'invalid'].includes(value[key]), 'Invalid shared operation source')
  }
  for (const key of ['updateRelation', 'scheduleRelation', 'instanceRelation']) {
    assert(['same', 'different', 'unavailable'].includes(value[key]), 'Invalid shared comparison')
  }
  for (const key of ['firstInstanceMatchesHealth', 'secondInstanceMatchesHealth']) {
    assert(value[key] === null || typeof value[key] === 'boolean', 'Invalid shared instance comparison')
  }
  parseReconciliationSnapshot(JSON.stringify(value.first))
  parseReconciliationSnapshot(JSON.stringify(value.second))
  return value
}

async function boundedObservation(read, milliseconds) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(value => ({ state: 'fulfilled', value }), () => ({ state: 'rejected', value: null })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'timed-out', value: null }), milliseconds) })
    ])
  } finally { clearTimeout(timer) }
}

function sharedIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : null
}

export async function collectSharedOperationSnapshot(readFirst, readSecond, readHealth, fixture, version, stage, milliseconds = 5000) {
  assert(SHARED_STAGES.has(stage) && Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 5000,
    'Invalid shared-operation observation scope')
  // Read-only, independently bounded probes. A stalled/rejected second renderer
  // must not erase the first client's status or the authenticated health probe.
  // CDP also expires its underlying requests; this does not retry update IPC.
  const [a, b, h] = await Promise.all([readFirst, readSecond, readHealth].map(read => boundedObservation(read, milliseconds)))
  const record = status => Array.isArray(status?.serverUpdates) ? status.serverUpdates.find(item => item?.profileId === PROFILE_ID) : null
  const first = record(a.value), second = record(b.value)
  const operation = item => {
    const raw = item?.operationId ?? item?.scheduleId
    return { source: raw == null ? 'missing' : !sharedIdentifier(raw) ? 'invalid' : item?.operationId != null ? 'operation' : 'schedule' }
  }
  const one = operation(first), two = operation(second)
  const relation = (left, right) => !left || !right ? 'unavailable' : left === right ? 'same' : 'different'
  const firstInstance = sharedIdentifier(first?.serverInstanceId), secondInstance = sharedIdentifier(second?.serverInstanceId)
  const healthyInstance = sharedIdentifier(h.value?.health?.server_instance_id)
  const matches = value => value && healthyInstance ? value === healthyInstance : null
  const snapshot = parseSharedOperationSnapshot(JSON.stringify({ schema: 1, kind: 'native-shared-operation-snapshot', stage,
    firstRead: a.state, secondRead: b.state, healthRead: h.state,
    first: reconciliationSnapshot(a.value, h.value, fixture, version), second: reconciliationSnapshot(b.value, h.value, fixture, version),
    firstOperationSource: one.source, secondOperationSource: two.source,
    updateRelation: relation(sharedIdentifier(first?.operationId), sharedIdentifier(second?.operationId)),
    scheduleRelation: relation(sharedIdentifier(first?.scheduleId), sharedIdentifier(second?.scheduleId)),
    instanceRelation: relation(firstInstance, secondInstance), firstInstanceMatchesHealth: matches(firstInstance),
    secondInstanceMatchesHealth: matches(secondInstance) }))
  return { first: a.value, second: b.value, probe: h.value, snapshot }
}

export function retainSharedOperationObservation(history, snapshot) {
  const safe = parseSharedOperationSnapshot(JSON.stringify(snapshot))
  if (JSON.stringify(history.at(-1)) !== JSON.stringify(safe)) history.push(safe)
  // Retain the initial observation and the most recent eleven state changes.
  // No unbounded timeline, raw operation IDs, errors, URLs or provider data.
  if (history.length > 12) history.splice(1, history.length - 12)
}

export function terminalReconciliationFailure(previous, current) {
  if (!previous || !current) return false
  const terminal = snapshot => snapshot.appStatusAvailable && snapshot.appVersionMatches === true
    && snapshot.recordPresent && snapshot.recordPhase === 'failed' && snapshot.recordPaused === true
    && snapshot.recordTargetMatches === true && snapshot.recordIdentityMatches === true
  // A single transient observation is insufficient. Both observations must
  // describe the exact saved server/candidate and a paused terminal failure;
  // ordinary offline, blocked, pending and active-update states retain the
  // existing wait budget. This never turns a failed journey into acceptance.
  return terminal(parseReconciliationSnapshot(JSON.stringify(previous)))
    && terminal(parseReconciliationSnapshot(JSON.stringify(current)))
}

async function reconciliationHealth(fixture) {
  let response
  try {
    response = await fetch(`${fixture.serverUrl.replace(/\/$/, '')}/api/health`, { headers: { 'X-AgentsDock-Token': fixture.token },
      redirect: 'error', signal: AbortSignal.timeout(2000) })
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024) { await reader.cancel(); throw new Error('Health response exceeds bound') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return { reachable: true, httpStatus: response.status, health: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { reachable: Boolean(response), httpStatus: response?.status ?? null, health: null }
  }
}

export function assertCurrentPairedServer(status, health, fixture, version) {
  assert.equal(status.currentVersion, version, 'The app was not replaced')
  const record = status.serverUpdates?.find(item => item.profileId === PROFILE_ID)
  assert(record && record.phase === 'current' && record.serverIdentity === fixture.serverIdentity
    && record.targetVersion === version && record.paused !== true, 'Real coordinator has not completed the paired server update')
  assert(health.ok && health.server_identity === fixture.serverIdentity && health.server_version === version,
    'Real service does not report the exact paired version and original identity')
  if (health.gateway || health.execution_service) {
    assert(health.gateway?.version === version && health.execution_service?.version === version
      && health.execution_service?.maintenance_held !== true, 'Both installed service components must be current and active')
  }
  assert.notEqual(health.server_instance_id, fixture.serverInstanceId, 'The old service instance was never replaced')
  return { phase: record.phase, targetVersion: record.targetVersion, serverIdentityPreserved: true,
    serviceInstanceChanged: true, gatewayVersion: health.gateway?.version ?? null,
    executionVersion: health.execution_service?.version ?? health.server_version }
}

export function assertVisibleCoordinatedRow(rows, expectedPhase) {
  const matching = rows.filter(row => row.name === PROFILE_NAME)
  assert.equal(matching.length, 1, 'Expected one visible saved-server update row')
  assert(matching[0].description && matching[0].phaseLabel, 'Update row must show a status and phase')
  const phasePatterns = { offline: /offline|reconnect to resume/i, current: /up to date|current/i }
  assert(phasePatterns[expectedPhase]?.test(matching[0].phaseLabel), 'Visible server phase differs from actual coordinator state')
  return matching[0]
}

export function assertStableDiscovery(status, candidate) {
  assert.equal(status.track, 'stable', 'Stable test unexpectedly switched subscription')
  assert(status.checkedAt, 'Stable discovery has not completed a check')
  if (candidate.includes('-beta.')) {
    assert.equal(status.state, 'not-available', 'Stable subscription must finish without offering the beta')
    assert(!status.availableVersion || status.availableVersion !== candidate, 'Stable subscription offered the beta')
  } else {
    assert.equal(status.state, 'downloaded', 'Stable candidate must be offered and downloaded on Stable')
    assert.equal(status.availableVersion, candidate, 'Stable discovered another candidate')
  }
  return { state: status.state, track: status.track, availableVersion: status.availableVersion ?? null,
    checkedAt: status.checkedAt }
}

export function assertSharedOperation(first, second, fixture, version) {
  const matching = status => Array.isArray(status?.serverUpdates)
    ? status.serverUpdates.filter(item => item?.profileId === PROFILE_ID) : []
  const firstRecords = matching(first), secondRecords = matching(second)
  assert(firstRecords.length === 1 && secondRecords.length === 1, 'Each native client must have one unambiguous saved-server receipt')
  const [a] = firstRecords, [b] = secondRecords
  assert(first.currentVersion === version && second.currentVersion === version
    && a?.phase === 'current' && b?.phase === 'current' && a.paused !== true && b.paused !== true && a.serverIdentity === fixture.serverIdentity
    && b.serverIdentity === fixture.serverIdentity && a.targetVersion === version && b.targetVersion === version,
  'Both real app clients must reconcile the same saved server')
  let common
  for (const [field, kind] of [['operationId', 'update'], ['scheduleId', 'schedule']]) {
    for (const item of [a, b]) assert(item[field] == null || sharedIdentifier(item[field]), 'Malformed native update identifier')
    if (a[field] != null && b[field] != null) {
      assert(a[field] === b[field], 'Native clients observed conflicting same-type update identifiers')
      common ??= { kind, value: a[field] }
    }
  }
  // A reservation ID and its eventual execution ID are different namespaces.
  // Retaining a common reservation is sufficient even if only one client has
  // observed the execution ID; equal text across namespaces is never evidence.
  assert(common, 'Both native clients must observe one shared same-type update identifier')
  assert(sharedIdentifier(a.serverInstanceId) && sharedIdentifier(b.serverInstanceId)
    && a.serverInstanceId === b.serverInstanceId, 'Native clients observed different final service instances')
  return { nativeClientCount: 2, sharedOperationObserved: true, sharedOperationKind: common.kind,
    sharedOperationSha256: digest(`${common.kind}:${common.value}`),
    finalServiceInstanceShared: true, targetVersion: version }
}

export function migrationCoverage(snapshot) {
  const sessions = Object.values(snapshot?.sessions ?? {})
  const nativeFields = ['session_id', 'claude_session_id', 'codex_thread_id', 'cursor_session_id', 'opencode_session_id']
  const withNativeHistory = sessions.filter(session => Array.isArray(session.eventHashes) && session.eventHashes.length > 0
    && nativeFields.some(field => typeof session.identity?.[field] === 'string' && session.identity[field].trim()))
  return { populatedNativeHistoryObserved: withNativeHistory.length > 0, persistedSessionCount: sessions.length,
    sessionsWithHistory: sessions.filter(session => Array.isArray(session.eventHashes) && session.eventHashes.length > 0).length,
    sessionsWithNativeHistory: withNativeHistory.length,
    queuedMessageCount: sessions.reduce((sum, session) => sum + (Array.isArray(session.queued) ? session.queued.length : 0), 0) }
}

async function visibleServerRow(client, phase) {
  return until(`Visible ${phase} server status`, async () => {
    const rows = await client.evaluate(`Array.from(document.querySelectorAll('.coordinated-server-update-row'))
      .filter(row => row.getClientRects().length).map(row => ({name: row.querySelector('strong')?.textContent?.trim(),
        description: row.querySelector('[role="status"]')?.textContent?.trim(),
        phaseLabel: row.querySelector('.app-settings-value')?.textContent?.trim()}))`)
    try { return assertVisibleCoordinatedRow(rows, phase) } catch { return null }
  })
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDesktopAcceptanceArguments(argv)
  if (options.scope === 'candidate') assertCandidateRunner()
  else assertDesktopRunner()
  for (const key of ['receipt', 'preparation-run', 'server-directory', 'desktop-directory', 'baseline-directory', 'server-fixture']) {
    if (options[key]) await assertInsideRunner(options[key])
  }
  await assertInsideRunner(options.output, true)
  const replay = await (options.scope === 'candidate' ? createCandidateReplay : createProductReplay)({ receiptPath: options.receipt, acceptedReceiptSha256: options['receipt-sha256'],
    preparationRunPath: options['preparation-run'], serverDirectory: options['server-directory'], desktopDirectory: options['desktop-directory'],
    baselineDesktopDirectory: options['baseline-directory'], baselineVersion: options['baseline-version'] })
  const harness = options.scope === 'candidate' ? assertCandidateCheckout(replay.identity) : null
  if (!harness) assert.equal(replay.identity.sourceSha, process.env.GITHUB_SHA, 'Native acceptance must run at the exact prepared source')
  assertOlderVersion(options['baseline-version'], replay.identity.version)
  const fixtureStat = await lstat(options['server-fixture'])
  assert((fixtureStat.mode & 0o077) === 0, 'Server fixture token file must be private')
  const fixture = validateDesktopFixture(await regularJSON(options['server-fixture']), replay.identity)
  await assertInsideRunner(fixture.workDirectory)
  const outputPart = relative(fixture.workDirectory, options.output)
  assert(outputPart && !outputPart.startsWith('..') && !isAbsolute(outputPart), 'Desktop output must be inside the owned service fixture work directory')
  assert.equal(await realpath(fixture.home), await realpath(homedir()), 'Fixture must belong to the actual disposable runner account')
  const defaults = { installRoot: join(fixture.home, '.local/share/agents-server'), stateRoot: join(fixture.home, '.agentsdock'),
    configRoot: join(fixture.home, '.config/agents-server') }
  for (const [key, expected] of Object.entries(defaults)) {
    assert.equal(fixture[key], expected, 'Fixture service roots must be the disposable account defaults')
    const stat = await lstat(expected)
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022)
      && JSON.stringify(fixture.rootBindings?.[key]) === JSON.stringify([stat.dev, stat.ino]), 'Service fixture root ownership changed')
  }
  assert(!run('/bin/ps', ['-axo', 'command=']).includes('/AgentsDock.app/Contents/MacOS/AgentsDock'), 'An AgentsDock app is already running')
  await mkdir(options.output, { mode: 0o700 })
  const events = []
  const observed = (kind, details = {}) => {
    const at = new Date().toISOString()
    events.push({ kind, at, ...details })
    emitNativeProgress(kind, at)
  }
  const logs = boundedNativeLog(createWriteStream(join(options.output, 'native-private.log'), { flags: 'wx', mode: 0o600 }))
  let ownedApp, secondApp, client, secondClient, lastReconciliation = null, keychainCreated = false
  const sharedOperationObservations = []
  const observeShared = async stage => {
    const result = await collectSharedOperationSnapshot(
      () => client?.evaluate('window.agentsDock.updates.status()'),
      () => secondClient?.evaluate('window.agentsDock.updates.status()'),
      () => reconciliationHealth(fixture), fixture, replay.identity.version, stage)
    retainSharedOperationObservation(sharedOperationObservations, result.snapshot)
    return result
  }
  try {
    observed('baseline-artifact-verification-starting')
    const previous = await extractVerifiedApp(options['baseline-directory'], options['baseline-version'], join(options.output, 'installation'))
    observed('baseline-artifact-verified')
    observed('candidate-artifact-verification-starting')
    const expected = await extractVerifiedApp(options['desktop-directory'], replay.identity.version, join(options.output, 'expected'))
    observed('candidate-artifact-verified')
    ownedApp = previous.app
    // Compare the signed descriptor embedded in the real target, not a helper-generated copy.
    for (const name of ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']) {
      assert((await readFile(join(expected.app, 'Contents/Resources/coordinated-release', name)))
        .equals(await readFile(join(options['server-directory'], 'npm', name))), 'Native target contains a different paired server descriptor')
    }
    const initialHealth = await serverHealth(fixture)
    assert.equal(initialHealth.server_version, fixture.baselineVersion)
    // The workflow may have restarted this owned service to pick up its
    // ephemeral TLS trust. Fence against the currently authenticated baseline
    // instance, not the older bootstrap observation from before that restart.
    fixture.serverInstanceId = initialHealth.server_instance_id
    assert(typeof fixture.serverInstanceId === 'string' && fixture.serverInstanceId.length >= 8)
    const profileDirectory = join(options.output, 'profile')
    await mkdir(profileDirectory, { mode: 0o700 })
    const settings = { schemaVersion: 2, activeProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID, name: PROFILE_NAME,
      serverUrl: fixture.serverUrl, serverIdentity: fixture.serverIdentity, keychainAccessToken: true, serverSetupComplete: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }
    await writeFile(join(profileDirectory, 'settings.json'), JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
    await writeFile(join(profileDirectory, 'update-track'), 'stable\n', { flag: 'wx', mode: 0o600 })
    await writeFile(join(profileDirectory, 'app-language.json'), '{"preference":"en"}\n', { flag: 'wx', mode: 0o600 })
    // Refuse to replace any pre-existing keychain entry, even on an ephemeral runner.
    let alreadyStored = false
    try {
      execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
        { timeout: 5000, stdio: 'ignore' })
      alreadyStored = true
    } catch (error) { assert.equal(error.status, 44, 'Cannot safely inspect the isolated keychain account') }
    assert(!alreadyStored, 'Isolated keychain account already exists')
    // Synthetic service token goes over stdin, never process argv or evidence.
    execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${fixture.token}\n`,
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'ignore', 'pipe'] })
    keychainCreated = true
    const port = await freePort()
    const launch = (appPath = ownedApp, profilePath = profileDirectory, debugPort = port) => {
      const child = spawn(join(appPath, 'Contents/MacOS/AgentsDock'), [`--remote-debugging-port=${debugPort}`], {
        env: { ...process.env, AGENTSDOCK_USER_DATA: profilePath, AGENTSDOCK_DISABLE_ANALYTICS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', chunk => logs.write(chunk)); child.stderr.on('data', chunk => logs.write(chunk))
      child.on('error', () => logs.write('Owned app launch failed.\n'))
      return child
    }
    const original = launch()
    observed('baseline-renderer-connecting')
    client = await until('Baseline native renderer', () => connect(port))
    await client.call('Page.bringToFront')
    const before = await until('Baseline native transport connected', async () => {
      const state = await client.evaluate('window.agentsDock?.bootstrap()')
      return state?.health?.ok && state.health.server_identity === fixture.serverIdentity ? state : null
    })
    assert.equal(before.activeProfileId, PROFILE_ID)
    assert.equal(before.health.server_version, fixture.baselineVersion)
    const beforeStatus = await client.evaluate('window.agentsDock.updates.status()')
    assert.equal(beforeStatus.currentVersion, options['baseline-version'])
    assert.equal(beforeStatus.channel, 'direct')
    assertMigrationTrack('stable', beforeStatus, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    observed('baseline-native-connected', { appVersion: beforeStatus.currentVersion, serverVersion: before.health.server_version })
    await openMigrationUpdateSettings(client)
    const stableDiscovery = await until('Native Stable channel discovery', async () => {
      const status = await client.evaluate('window.agentsDock.updates.status()')
      try { return assertStableDiscovery(status, replay.identity.version) } catch { return null }
    }, 8 * 60_000)
    observed('stable-subscription-observed', stableDiscovery)
    await client.screenshot(join(options.output, '00-stable-channel.png'))
    if (stableDiscovery.state === 'downloaded') {
      // The production UI locks subscription changes while a download is ready.
      // Discard through the real control, never by deleting updater cache files.
      await client.clickButton(['Discard update'])
      await until('Stable download discarded', async () => (await client.evaluate('window.agentsDock.updates.status()')).state === 'idle')
    }
    await client.clickButton(['Beta'])
    const downloaded = await until('Exact prepared desktop downloaded', async () => {
      const status = await client.evaluate('window.agentsDock.updates.status()')
      return status.state === 'downloaded' ? status : null
    }, 8 * 60_000)
    assert.equal(downloaded.availableVersion, replay.identity.version)
    // Beta subscribers must also discover a stable product promotion. Track is
    // a subscription preference, not necessarily the candidate's prerelease tag.
    assertMigrationTrack('beta', downloaded, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    observed('beta-subscription-observed', { track: downloaded.track, state: downloaded.state, availableVersion: downloaded.availableVersion })
    serviceCommand(options, fixture, 'service', ['--action', 'stop'], 'server-stopped.json')
    await until('Owned legacy service offline', () => assertOffline(fixture))
    observed('server-offline-before-app-install')
    await client.screenshot(join(options.output, '01-ready-with-server-offline.png'))
    await client.clickButton(MIGRATION_INSTALL_BUTTON_NAMES)
    observed('trusted-native-input-restart-to-update')
    client.close(); client = null
    await until('Squirrel replaced installed app', () => appVersion(ownedApp) === replay.identity.version, 4 * 60_000)
    verifyApp(ownedApp, replay.identity.version)
    assert.equal(await hashFile(join(ownedApp, 'Contents/Resources/app.asar')), expected.asarSha256)
    const relaunched = await until('Squirrel relaunched app', () => processesFor(ownedApp).find(pid => pid !== original.pid))
    assert(await assertOffline(fixture), 'Server unexpectedly restarted before the app completed its own update')
    observed('native-replacement-and-relaunch', { installedVersion: appVersion(ownedApp), installedAsarSha256: expected.asarSha256,
      nativeRelaunchObserved: Boolean(relaunched), serverStillOffline: true })
    // Squirrel may discard diagnostic CLI arguments. First prove its relaunch,
    // then reopen the same unmodified installation solely for CDP observation.
    await stopOwned(ownedApp)
    launch()
    observed('updated-renderer-connecting')
    client = await until('Updated native renderer', () => connect(port))
    await client.call('Page.bringToFront')
    const offline = await until('Real coordinator reports offline server', async () => {
      const status = await client.evaluate('window.agentsDock?.updates.status()')
      return status?.currentVersion === replay.identity.version
        && status.serverUpdates?.some(item => item.profileId === PROFILE_ID && item.phase === 'offline') ? status : null
    })
    assertMigrationTrack('beta', offline, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    await openMigrationUpdateSettings(client)
    const offlineRow = await visibleServerRow(client, 'offline')
    await client.screenshot(join(options.output, '02-native-app-updated-server-offline.png'))
    observed('offline-pending-visible', { phase: 'offline', phaseLabel: offlineRow.phaseLabel })
    const secondProfile = join(options.output, 'second-profile')
    await mkdir(secondProfile, { mode: 0o700 })
    for (const [name, data] of [['settings.json', JSON.stringify(settings)], ['update-track', 'beta\n'],
      ['app-language.json', '{"preference":"en"}\n']]) {
      await writeFile(join(secondProfile, name), data, { flag: 'wx', mode: 0o600 })
    }
    secondApp = expected.app
    const secondPort = await freePort()
    const secondProcess = launch(secondApp, secondProfile, secondPort)
    observed('second-renderer-connecting')
    secondClient = await until('Second exact native candidate renderer', () => connect(secondPort))
    await until('Both real app instances observe the same offline server', async () => {
      const status = await secondClient.evaluate('window.agentsDock?.updates.status()')
      return status?.currentVersion === replay.identity.version && status.serverUpdates?.some(item =>
        item.profileId === PROFILE_ID && item.serverIdentity === fixture.serverIdentity && item.phase === 'offline')
    })
    assert(processesFor(ownedApp).length > 0 && processesFor(secondApp).includes(secondProcess.pid),
      'Two independent native app processes must coexist before service reconnection')
    observed('second-native-client-waiting', { independentProfile: true, nativeClientCount: 2 })
    await observeShared('offline')
    // No server-update IPC is invoked by this harness: reconnect is the only
    // action, and the installed production coordinator owns admission/retry.
    serviceCommand(options, fixture, 'service', ['--action', 'start'], 'server-reconnected.json')
    observed('owned-legacy-service-start-requested')
    const current = await until('Automatic paired server reconciliation', async () => {
      const { first: status, probe, snapshot: pairedSnapshot } = await observeShared('reconciling')
      const snapshot = pairedSnapshot.first
      const failed = terminalReconciliationFailure(lastReconciliation, snapshot)
      lastReconciliation = snapshot
      if (failed) return { terminalFailure: true }
      const health = probe?.httpStatus === 200 ? probe.health : null
      try { return { status, health, verification: assertCurrentPairedServer(status, health, fixture, replay.identity.version) } }
      catch { return null }
    }, 15 * 60_000)
    assert(!current.terminalFailure, 'Production coordinator paused after a failed update of the exact paired server')
    const currentRow = await visibleServerRow(client, 'current')
    await client.screenshot(join(options.output, '03-matched-app-and-server.png'))
    const shared = await until('Both real clients joined one server update operation', async () => {
      const { first: a, second: b } = await observeShared('completed-wait')
      try { return assertSharedOperation(a, b, fixture, replay.identity.version) } catch { return null }
    })
    observed('two-native-clients-share-one-completed-update', shared)
    const preservation = serviceCommand(options, fixture, 'verify', ['--expect-version', replay.identity.version], 'server-preservation.json')
    const persisted = await regularJSON(join(profileDirectory, 'settings.json'))
    const saved = persisted.profiles.find(profile => profile.id === PROFILE_ID)
    assert(saved?.serverIdentity === fixture.serverIdentity && saved.serverUrl === fixture.serverUrl && saved.name === PROFILE_NAME,
      'App profile identity, URL or name was lost')
    assert.equal(persisted.activeProfileId, PROFILE_ID)
    assert.equal((await regularJSON(join(profileDirectory, 'app-language.json'))).preference, 'en')
    assertMigrationTrack('beta', current.status, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    observed('paired-service-current', { ...current.verification, visiblePhaseLabel: currentRow.phaseLabel,
      preservationEvidenceSha256: preservation.evidenceSha256 })
    const coverage = migrationCoverage(fixture.snapshot)
    logs.assertHealthy()
    const evidence = { schema: 1,
      ...(harness ? { kind: 'scoped-macos-candidate-observations', publicationEligible: false, releaseAcceptance: false,
        harnessSourceSha: harness.harnessSourceSha } : {}),
      releaseReceiptSha256: replay.identity.releaseReceiptSha256, sourceSha: replay.identity.sourceSha,
      version: replay.identity.version, track: replay.identity.track, runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, platform: 'darwin', native: true,
      transport: 'exact-artifact-HTTPS-origin-replay-not-publication', baselineVersion: options['baseline-version'],
      baselineZipSha256: previous.zipSha256, targetZipSha256: expected.zipSha256, installedAsarSha256: expected.asarSha256,
      privateDiagnosticLog: { bounded: true, ...logs.counts },
      checks: [
        { name: 'native-app-update', status: 'passed', observations: { fromVersion: options['baseline-version'],
          toVersion: replay.identity.version, trustedNativeInput: true, nativeReplacementObserved: true,
          nativeRelaunchObserved: Boolean(relaunched), installedAsarSha256: expected.asarSha256,
          targetZipSha256: expected.zipSha256, appInstalledBeforeServerReconnection: true } },
        { name: 'legacy-server-upgrade', status: coverage.populatedNativeHistoryObserved ? 'passed' : 'blocked', observations: { ...current.verification,
          fromVersion: fixture.baselineVersion, toVersion: replay.identity.version,
          preservedStateSha256: fixture.baselineStateSha256, preservationEvidenceSha256: preservation.evidenceSha256,
          updateRequestedByProductionCoordinator: true, manualServerUpdateClicks: 0, ...coverage,
          ...(!coverage.populatedNativeHistoryObserved ? { remaining: ['Populated provider history and native session IDs were not exercised by the empty-chat fixture.'] } : {}) } },
        { name: 'offline-server-reconnect', status: 'passed', observations: { appInstalledWhileServerOffline: true,
          offlineVisiblePhase: offlineRow.phaseLabel, reconnectedVisiblePhase: currentRow.phaseLabel,
          reconciledAutomatically: true, manualRetryClicks: 0, originalServerIdentityPreserved: true } },
        { name: 'stable-beta-channels', status: 'passed', observations: { stable: stableDiscovery,
          beta: { track: downloaded.track, state: downloaded.state, availableVersion: downloaded.availableVersion },
          betaPreferencePreservedAfterRelaunch: true, discovery: 'synthetic-replay-not-publication' } },
        { name: 'multiple-clients', status: 'passed', observations: shared }
      ],
      events, limitations: ['No live-provider reply or natural OAuth renewal is claimed.',
        'This case does not establish reboot, busy-work, rollback or native Windows acceptance.'],
      completedAt: new Date().toISOString() }
    await writeFile(join(options.output, 'desktop-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ observed: true, checks: evidence.checks, evidenceSha256: digest(await readFile(join(options.output, 'desktop-evidence.json'))) }))
    return evidence
  } catch (error) {
    if (secondClient) await observeShared('failure').catch(() => {})
    let serviceDiagnostics = { status: 'unavailable' }
    try {
      const diagnostic = serviceCommand(options, fixture, 'diagnose', [], 'server-diagnostics.json')
      serviceDiagnostics = { status: 'written', evidenceSha256: diagnostic.evidenceSha256 }
    } catch { /* Public evidence must never contain raw service errors. */ }
    if (client) await client.screenshot(join(options.output, 'failure.png')).catch(() => {})
    await writeFile(join(options.output, 'failure-observations.json'), JSON.stringify({ schema: 1, status: 'failed',
      ...(harness ? { kind: 'scoped-macos-candidate-observations', publicationEligible: false, releaseAcceptance: false,
        harnessSourceSha: harness.harnessSourceSha } : {}),
      releaseReceiptSha256: replay.identity.releaseReceiptSha256, events, lastReconciliation,
      sharedOperationObservations, serviceDiagnostics }), { flag: 'wx', mode: 0o600 }).catch(() => {})
    throw error
  } finally {
    client?.close()
    secondClient?.close()
    if (secondApp) await stopOwned(secondApp)
    if (ownedApp) await stopOwned(ownedApp)
    if (keychainCreated) execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { timeout: 5000, stdio: 'ignore' })
    logs.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
