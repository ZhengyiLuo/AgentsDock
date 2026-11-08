import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACCEPTANCE_CHECKS } from '../product-release.mjs'
import { collectAcceptance, REQUIRED_NATIVE_REPORTS, validateCollectedEvidence, validateNativeReport } from '../product-acceptance.mjs'

// Synthetic records exercise the collector contract only, never native acceptance.
function fixture() {
  const receipt = { schema: 1, version: '1.0.7-beta.17', track: 'beta', sourceSha: 'a'.repeat(40),
    sourceRef: 'release/test', workflowSha: 'a'.repeat(40), exportSha: 'b'.repeat(40),
    prepareRunId: '90', prepareRunNumber: '1', buildNumber: '5001', windowsSigning: 'unsigned',
    desktopManifestSha256: 'c'.repeat(64), npmManifestSha256: 'd'.repeat(64), legacyManifestSha256: 'e'.repeat(64),
    serverBundleSha256: 'f'.repeat(64) }
  const seal = '1'.repeat(64)
  const reports = Object.fromEntries(REQUIRED_NATIVE_REPORTS.map(name => [name, {
    schema: 1, version: receipt.version, sourceSha: receipt.sourceSha, releaseReceiptSha256: seal,
    runId: '100', runAttempt: '2', platform: name.endsWith('-linux') ? 'linux' : 'darwin',
    checks: ACCEPTANCE_CHECKS.map(check => ({ name: check, status: 'passed', observations: { unitFixture: true } }))
  }]))
  return { receipt, seal, reports }
}

test('collects only all required native reports from the same receipt/run/attempt', () => {
  const f = fixture(), report = collectAcceptance(f.receipt, f.seal, f.reports, '100', '2')
  assert.equal(report.schema, 2)
  assert.equal(report.checks.length, 9)
  assert.equal(validateCollectedEvidence(report, f.receipt, f.seal, { id: 100, run_attempt: 2 }), true)
  for (const name of REQUIRED_NATIVE_REPORTS) {
    const incomplete = { ...f.reports }; delete incomplete[name]
    assert.throws(() => collectAcceptance(f.receipt, f.seal, incomplete, '100', '2'), /required/)
  }
})

test('blocked, failed and missing observations cannot produce acceptance', () => {
  for (const status of ['blocked', 'failed']) {
    const f = fixture()
    f.reports['server-linux'].checks.find(check => check.name === 'busy-server-drain').status = status
    assert.throws(() => collectAcceptance(f.receipt, f.seal, f.reports, '100', '2'), /has not passed/)
  }
  const f = fixture()
  for (const report of Object.values(f.reports)) report.checks = report.checks.filter(check => check.name !== 'rollback-data-preservation')
  assert.throws(() => collectAcceptance(f.receipt, f.seal, f.reports, '100', '2'), /rollback-data-preservation/)
})

test('rejects stale attempts, foreign receipts and mismatched platform claims', () => {
  const f = fixture(), original = f.reports['server-linux']
  for (const change of [{ runAttempt: '1' }, { runId: '99' }, { sourceSha: '2'.repeat(40) },
    { version: '1.0.7' }, { releaseReceiptSha256: '3'.repeat(64) }]) {
    assert.throws(() => validateNativeReport({ ...original, ...change }, f.receipt, f.seal, '100', '2'))
  }
  f.reports['server-linux'] = { ...original, platform: 'darwin' }
  assert.throws(() => collectAcceptance(f.receipt, f.seal, f.reports, '100', '2'), /platform differs/)
})

test('plain pass flags, secret values and duplicate scenario records are refused', () => {
  for (const observations of [null, {}, [], { token: 'do-not-publish' }, { password: 'do-not-publish' }, { text: 'x'.repeat(32769) }]) {
    const f = fixture(), report = f.reports['server-linux']
    report.checks[0].observations = observations
    assert.throws(() => validateNativeReport(report, f.receipt, f.seal, '100', '2'))
  }
  const f = fixture(), report = f.reports['server-linux']
  report.checks[1] = report.checks[0]
  assert.throws(() => validateNativeReport(report, f.receipt, f.seal, '100', '2'), /duplicate/)
})

test('post-collection changes to observations or summaries invalidate acceptance', () => {
  const f = fixture()
  for (const mutate of [report => { report.evidence[0].report.checks[0].observations.unitFixture = false },
    report => { report.checks[0].evidence = [] }, report => { report.runAttempt = '3' },
    report => { report.evidence[1] = report.evidence[0] }]) {
    const report = collectAcceptance(f.receipt, f.seal, f.reports, '100', '2')
    const changed = structuredClone(report); mutate(changed)
    assert.throws(() => validateCollectedEvidence(changed, f.receipt, f.seal, { id: 100, run_attempt: 2 }))
  }
})
