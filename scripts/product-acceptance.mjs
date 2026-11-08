#!/usr/bin/env node
// Collect native observations only; source tests cannot generate acceptance.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ACCEPTANCE_CHECKS, validateReceipt } from './product-release.mjs'

const need = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const encoded = value => JSON.stringify(value)
export const REQUIRED_NATIVE_REPORTS = ['server-linux', 'server-darwin', 'recovery-linux', 'rollback-linux', 'desktop-0755', 'desktop-0750']

export function validateNativeReport(report, receipt, receiptSha256, runId, runAttempt) {
  validateReceipt(receipt)
  need(report?.schema === 1 && report.version === receipt.version && report.sourceSha === receipt.sourceSha
    && report.releaseReceiptSha256 === receiptSha256 && report.runId === String(runId)
    && report.runAttempt === String(runAttempt), 'Native observations belong to another source, receipt, run or attempt.')
  need(['darwin', 'linux'].includes(report.platform), 'Native observations require a supported native platform.')
  need(Array.isArray(report.checks) && report.checks.length > 0 && report.checks.length <= ACCEPTANCE_CHECKS.length,
    'Native observations are missing.')
  const seen = new Set()
  for (const check of report.checks) {
    need(ACCEPTANCE_CHECKS.includes(check.name) && !seen.has(check.name), 'Unknown or duplicate native check.')
    seen.add(check.name)
    need(['passed', 'failed', 'blocked'].includes(check.status), 'Native check status is invalid.')
    need(check.observations && typeof check.observations === 'object' && !Array.isArray(check.observations)
      && Object.keys(check.observations).length > 0 && Buffer.byteLength(encoded(check.observations)) <= 32768,
    'Native check requires bounded structured observations, not a process exit alone.')
    need(!/"(?:token|password|authorization|privateKey|cookie)"\s*:/i.test(encoded(check.observations)),
      'Private fixture credentials must not enter acceptance artifacts.')
  }
  return report
}

export function collectAcceptance(receipt, receiptSha256, reports, runId, runAttempt) {
  need(/^[a-f0-9]{64}$/.test(receiptSha256) && /^[1-9]\d*$/.test(String(runId))
    && /^[1-9]\d*$/.test(String(runAttempt)), 'Exact receipt and run identity are required.')
  need(encoded(Object.keys(reports).sort()) === encoded([...REQUIRED_NATIVE_REPORTS].sort()),
    'All Linux/macOS fresh installs and both legacy permission layouts are required.')
  const evidence = REQUIRED_NATIVE_REPORTS.map(name => {
    const report = validateNativeReport(reports[name], receipt, receiptSha256, runId, runAttempt)
    need(report.platform === (name.endsWith('-linux') ? 'linux' : 'darwin'), 'Native report platform differs from its job.')
    const required = name.startsWith('server-') ? ['fresh-server-install'] : name === 'recovery-linux' ? ['interrupted-update-recovery']
      : name === 'rollback-linux' ? ['rollback-data-preservation']
      : ['native-app-update', 'legacy-server-upgrade', 'offline-server-reconnect', 'multiple-clients', 'stable-beta-channels']
    for (const check of required) need(report.checks.some(item => item.name === check && item.status === 'passed'),
      `Required native job observation has not passed: ${name}/${check}.`)
    return { name, sha256: hash(encoded(report)), report }
  })
  const checks = ACCEPTANCE_CHECKS.map(name => {
    const sources = evidence.filter(item => item.report.checks.some(check => check.name === name))
    need(sources.length > 0 && sources.every(item => item.report.checks.find(check => check.name === name).status === 'passed'),
      `Required product acceptance has not passed: ${name}.`)
    return { name, result: 'passed', evidence: sources.map(item => item.name) }
  })
  return { schema: 2, version: receipt.version, sourceSha: receipt.sourceSha, releaseReceiptSha256: receiptSha256,
    runId: String(runId), runAttempt: String(runAttempt), checks, evidence,
    boundary: 'Exact-artifact disposable native replay. Not public registry delivery, provider OAuth renewal, or reboot acceptance.' }
}

export function validateCollectedEvidence(report, receipt, receiptSha256, run) {
  need(report?.schema === 2 && report.runAttempt === String(run.run_attempt), 'Acceptance requires native evidence from this exact run attempt.')
  need(Array.isArray(report.evidence) && report.evidence.length === REQUIRED_NATIVE_REPORTS.length, 'Missing native evidence bundle.')
  const reports = {}
  for (const item of report.evidence) {
    need(REQUIRED_NATIVE_REPORTS.includes(item.name) && !Object.hasOwn(reports, item.name)
      && hash(encoded(item.report)) === item.sha256, 'Native evidence inventory is changed or duplicated.')
    reports[item.name] = item.report
  }
  const collected = collectAcceptance(receipt, receiptSha256, reports, run.id, run.run_attempt)
  need(encoded(report) === encoded(collected), 'Acceptance summary differs from its observed native evidence.')
  return true
}

function read(path) {
  const stat = lstatSync(path)
  need(stat.isFile() && stat.size <= 512 * 1024, 'Acceptance input must be a bounded regular file.')
  return readFileSync(path)
}

function main() {
  const [receiptPath, acceptedHash, reportsDirectory, output] = process.argv.slice(2)
  need(output && process.argv.length === 6, 'Usage: product-acceptance.mjs RECEIPT SHA256 REPORTS_DIRECTORY OUTPUT')
  need(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
    && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock'
    && /^ZhengyiLuo\/AgentsDock\/\.github\/workflows\/product-release-acceptance\.yml@refs\/heads\/(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(process.env.GITHUB_WORKFLOW_REF ?? ''),
  'Acceptance collection is restricted to the canonical acceptance workflow.')
  const bytes = read(receiptPath), receipt = JSON.parse(bytes)
  need(hash(bytes) === acceptedHash && receipt.sourceSha === process.env.GITHUB_SHA, 'Acceptance checkout or receipt differs from the exact product source.')
  const reports = Object.fromEntries(REQUIRED_NATIVE_REPORTS.map(name => [name, JSON.parse(read(resolve(reportsDirectory, `${name}.json`)))]))
  const report = collectAcceptance(receipt, acceptedHash, reports, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
