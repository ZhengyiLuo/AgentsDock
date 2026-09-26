#!/usr/bin/env node
// Product release identity and acceptance gates. No publishing or installation.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateDesktopBuildNumber } from './validate_desktop_build_number.mjs'
import { verifyCoordinatedDirectory, verifyLegacyBridge } from './coordinated-release.mjs'

const need = (condition, message) => { if (!condition) throw new Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const number = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
export const ACCEPTANCE_CHECKS = ['native-app-update', 'fresh-server-install', 'legacy-server-upgrade',
  'busy-server-drain', 'offline-server-reconnect', 'interrupted-update-recovery', 'rollback-data-preservation',
  'multiple-clients', 'stable-beta-channels']

function regular(path, maximum = 32768) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size <= maximum, 'Release input must be a bounded regular file.')
    const bytes = readFileSync(fd)
    need(bytes.length <= maximum, 'Release input exceeded its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

export function releaseIdentity(version, sourceSha, sourceRef, workflowSha) {
  need(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.[1-9]\d*)?$/.test(version), 'Product version must be x.y.z or x.y.z-beta.N.')
  need(commit(sourceSha) && commit(workflowSha), 'Product source and workflow require full reviewed commit SHAs.')
  need(typeof sourceRef === 'string' && /^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(sourceRef)
    && !sourceRef.includes('..') && !sourceRef.includes('//') && !/[/.]$/.test(sourceRef)
    && !sourceRef.split('/').some(part => part.endsWith('.lock')), 'Product source must be main or a reviewed release branch.')
  return { version, track: version.includes('-') ? 'beta' : 'stable', sourceSha, sourceRef, workflowSha }
}

export function validateReceipt(value) {
  need(value?.schema === 1, 'Unsupported product release receipt.')
  const identity = releaseIdentity(value.version, value.sourceSha, value.sourceRef, value.workflowSha)
  need(value.track === identity.track && commit(value.exportSha), 'Product channel or compatibility export identity differs.')
  need(number(value.prepareRunId) && number(value.prepareRunNumber), 'Invalid preparation run identity.')
  validateDesktopBuildNumber(value.buildNumber, value.prepareRunNumber, 'product')
  for (const name of ['desktopManifestSha256', 'npmManifestSha256', 'legacyManifestSha256', 'serverBundleSha256']) {
    need(digest(value[name]), `Invalid product ${name}.`)
  }
  need(['signed', 'unsigned'].includes(value.windowsSigning), 'Invalid Windows signing state.')
  return value
}

export function verifyReceiptBundle(receipt, directory, publicKey) {
  validateReceipt(receipt)
  const npmDir = join(directory, 'npm'), legacyDir = join(directory, 'legacy')
  for (const path of [directory, npmDir, legacyDir]) need(lstatSync(path).isDirectory(), 'Server bundle directories must not be symlinks.')
  const npmBytes = regular(join(npmDir, 'agents-server-npm-manifest.json'), 8192)
  const legacyBytes = regular(join(legacyDir, 'agents-server-manifest.json'), 8192)
  const bundleBytes = regular(join(directory, 'product-server-bundle.json'))
  need(sha(npmBytes) === receipt.npmManifestSha256 && sha(legacyBytes) === receipt.legacyManifestSha256
    && sha(bundleBytes) === receipt.serverBundleSha256,
  'Server bundle differs from the accepted product receipt.')
  const manifest = verifyCoordinatedDirectory(npmDir, { ...receipt, publicKey })
  const legacy = verifyLegacyBridge(legacyBytes, regular(join(legacyDir, 'agents-server-manifest.sig'), 64), manifest, publicKey)
  need(legacy.commit === receipt.sourceSha, 'Legacy descriptor does not bind the canonical product source.')
  const bundle = JSON.parse(bundleBytes)
  need(bundle.schema === 1 && bundle.version === receipt.version && bundle.track === receipt.track
    && bundle.sourceSha === receipt.sourceSha && bundle.npmManifestSha256 === receipt.npmManifestSha256
    && bundle.legacyManifestSha256 === receipt.legacyManifestSha256, 'Server bundle inventory identity differs from the product receipt.')
  const names = ['npm/agents-server-npm-manifest.json', 'npm/agents-server-npm-manifest.sig', `npm/${manifest.archive.name}`,
    'legacy/agents-server-manifest.json', 'legacy/agents-server-manifest.sig', `legacy/${legacy.archive.name}`].sort()
  need(JSON.stringify(Object.keys(bundle.artifacts ?? {}).sort()) === JSON.stringify(names), 'Server bundle inventory must contain exactly six signed release assets.')
  need(JSON.stringify(readdirSync(directory).sort()) === JSON.stringify(['legacy', 'npm', 'product-server-bundle.json']), 'Unexpected server bundle root entry.')
  for (const component of ['npm', 'legacy']) {
    const expected = names.filter(name => name.startsWith(`${component}/`)).map(name => name.slice(component.length + 1)).sort()
    need(JSON.stringify(readdirSync(join(directory, component)).sort()) === JSON.stringify(expected), 'Unexpected server bundle asset.')
  }
  for (const name of names) {
    const bytes = regular(join(directory, name), 200 * 1024 * 1024), recorded = bundle.artifacts[name]
    need(recorded?.size === bytes.length && recorded.sha256 === sha(bytes), 'Server bundle inventory differs from its asset bytes.')
  }
  for (const [dir, descriptor] of [[npmDir, manifest], [legacyDir, legacy]]) {
    const bytes = regular(join(dir, descriptor.archive.name), 200 * 1024 * 1024)
    need(bytes.length === descriptor.archive.size && sha(bytes) === descriptor.archive.sha256, 'Product server archive differs from its signed identity.')
    if (descriptor.npm) need(`sha512-${createHash('sha512').update(bytes).digest('base64')}` === descriptor.npm.integrity, 'Product npm archive integrity differs.')
  }
  let parity
  try {
    parity = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./verify_server_runtime_parity.py', import.meta.url)),
      join(npmDir, manifest.archive.name), join(legacyDir, legacy.archive.name), receipt.version],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch { throw new Error('Product server archives must contain identical valid runtime contents and executable permissions.') }
  need(parity.identical === true && parity.version === receipt.version, 'Server runtime parity was not confirmed.')
  return receipt
}

export function validatePreparationRun(run, receipt) {
  validateReceipt(receipt)
  need(run?.id?.toString() === receipt.prepareRunId && run.run_number?.toString() === receipt.prepareRunNumber
    && run.conclusion === 'success' && run.status === 'completed' && run.event === 'workflow_dispatch'
    && run.head_sha === receipt.workflowSha && run.head_branch === receipt.sourceRef
    && run.head_repository?.full_name === 'ZhengyiLuo/AgentsDock'
    && run.path === '.github/workflows/product-release.yml', 'Preparation receipt is not from the accepted successful canonical workflow.')
  return true
}

export function validateAcceptance(report, receipt, receiptSha256, run) {
  validateReceipt(receipt)
  need(digest(receiptSha256), 'An accepted product receipt SHA-256 is required.')
  need(run?.conclusion === 'success' && run.status === 'completed'
    && run.head_sha === receipt.sourceSha && run.head_repository?.full_name === 'ZhengyiLuo/AgentsDock'
    && run.path === '.github/workflows/product-release-acceptance.yml'
    && ['workflow_dispatch', 'workflow_call'].includes(run.event), 'Acceptance must be a successful canonical product-acceptance workflow at the exact product source.')
  need(report?.schema === 1 && report.version === receipt.version && report.sourceSha === receipt.sourceSha
    && report.releaseReceiptSha256 === receiptSha256 && String(report.runId) === String(run.id), 'Acceptance evidence belongs to another release, run or payload.')
  need(Array.isArray(report.checks), 'Acceptance evidence is missing required native update checks.')
  for (const name of ACCEPTANCE_CHECKS) {
    const checks = report.checks.filter(check => check.name === name)
    need(checks.length === 1 && checks[0].result === 'passed', `Required product acceptance has not passed: ${name}.`)
  }
  return true
}

function emit(values) {
  for (const [name, value] of Object.entries(values)) {
    need(!/[\r\n]/.test(String(value)), 'Unsafe workflow output.')
    process.stdout.write(`${name}=${value}\n`)
  }
}

export function receiptOutputs(value) {
  validateReceipt(value)
  return { version: value.version, track: value.track, source_sha: value.sourceSha, source_ref: value.sourceRef, workflow_sha: value.workflowSha,
    build_number: value.buildNumber, export_sha: value.exportSha, manifest_sha256: value.desktopManifestSha256,
    npm_manifest_sha256: value.npmManifestSha256, windows_signing: value.windowsSigning,
    candidate_tag: `npm-candidate-v${value.version}` }
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'identity') {
    need(args.length === 0, 'identity uses the pinned checkout and workflow environment.')
    const { SOURCE_SHA, SOURCE_REF, WORKFLOW_SHA, PREPARE_RUN_NUMBER } = process.env
    const value = releaseIdentity(readFileSync('server/VERSION', 'utf8').trim(), SOURCE_SHA, SOURCE_REF, WORKFLOW_SHA)
    need(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === SOURCE_SHA, 'Product checkout differs from its source pin.')
    execFileSync('git', ['merge-base', '--is-ancestor', SOURCE_SHA, WORKFLOW_SHA])
    const build = validateDesktopBuildNumber(String(5000 + Number(PREPARE_RUN_NUMBER)), PREPARE_RUN_NUMBER, 'product')
    emit({ version: value.version, track: value.track, build_number: build })
  } else if (command === 'seal') {
    need(args.length === 2, 'Usage: product-release.mjs seal SERVER_BUNDLE RECEIPT_JSON')
    const [directory, destination] = args
    const env = process.env
    const value = { schema: 1, ...releaseIdentity(env.RELEASE_VERSION, env.SOURCE_SHA, env.SOURCE_REF, env.WORKFLOW_SHA),
      prepareRunId: env.PREPARE_RUN_ID, prepareRunNumber: env.PREPARE_RUN_NUMBER, buildNumber: env.BUILD_NUMBER,
      exportSha: env.EXPORT_SHA, desktopManifestSha256: env.DESKTOP_MANIFEST_SHA256, windowsSigning: env.WINDOWS_SIGNING,
      npmManifestSha256: sha(regular(join(directory, 'npm/agents-server-npm-manifest.json'))),
      legacyManifestSha256: sha(regular(join(directory, 'legacy/agents-server-manifest.json'))),
      serverBundleSha256: sha(regular(join(directory, 'product-server-bundle.json'))) }
    verifyReceiptBundle(value, directory)
    const bytes = `${JSON.stringify(value, null, 2)}\n`
    writeFileSync(destination, bytes, { flag: 'wx' })
    emit({ receipt_sha256: sha(bytes) })
  } else if (command === 'inspect') {
    need(args.length === 4, 'Usage: product-release.mjs inspect RECEIPT_JSON SHA256 PREPARE_RUN_JSON SERVER_BUNDLE')
    const [path, acceptedHash, runPath, directory] = args, bytes = regular(path)
    need(digest(acceptedHash) && sha(bytes) === acceptedHash, 'Prepared receipt differs from the explicitly accepted hash.')
    const value = verifyReceiptBundle(JSON.parse(bytes), directory), run = JSON.parse(regular(runPath))
    validatePreparationRun(run, value)
    emit(receiptOutputs(value))
  } else if (command === 'acceptance') {
    need(args.length === 4, 'Usage: product-release.mjs acceptance REPORT_JSON RECEIPT_JSON RECEIPT_SHA256 RUN_JSON')
    const [reportPath, receiptPath, receiptHash, runPath] = args
    const bytes = regular(receiptPath)
    need(sha(bytes) === receiptHash, 'Acceptance receipt hash differs.')
    validateAcceptance(JSON.parse(regular(reportPath)), JSON.parse(bytes), receiptHash, JSON.parse(regular(runPath)))
    emit({ acceptance: 'passed' })
  } else throw new Error('Unknown product release operation.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
