#!/usr/bin/env node
// Offline seal for a scoped macOS + server rehearsal. NEVER a release receipt.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, open, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyServerBundleIdentity } from './product-release.mjs'

const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const CANDIDATE_KIND = 'agentsdock-macos-candidate'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// This narrow list is for retrying test infrastructure against unchanged sealed
// artifacts. Runtime sources, build scripts/configuration and production gates
// are deliberately absent. Renames are enumerated as delete+add by the guard.
export const CANDIDATE_HARNESS_PATHS = Object.freeze([
  '.github/workflows/ci.yml',
  '.github/actions/product-candidate-inputs/action.yml',
  'scripts/product-candidate-receipt.mjs',
  'scripts/product-release-replay.mjs',
  'scripts/product_desktop_acceptance.mjs',
  'scripts/product_server_acceptance.py',
  'scripts/product_no_downgrade_server.py',
  'scripts/product_no_downgrade_desktop.mjs',
  'scripts/product_no_downgrade_relay.mjs',
  'scripts/product_acceptance_network.py',
  'scripts/extract_product_candidate.py',
  'scripts/import_product_server.mjs',
  'scripts/verify_electron_migration.mjs',
  'scripts/tests/product-candidate-receipt.test.mjs',
  'scripts/tests/product-release-replay.test.mjs',
  'scripts/tests/product_desktop_acceptance.test.mjs',
  'scripts/tests/verify_electron_migration.test.mjs',
  'scripts/tests/import_product_server.test.mjs',
  'scripts/tests/test_extract_product_candidate.py',
  'scripts/tests/test_product_acceptance_network.py',
  'scripts/tests/test_product_server_acceptance.py',
  'scripts/tests/test_product_no_downgrade_server.py',
  'scripts/tests/product_no_downgrade_desktop.test.mjs',
  'scripts/tests/product_no_downgrade_relay.test.mjs',
  'docs/PRODUCT_ACCEPTANCE.md', 'docs/PRODUCT_RELEASES.md', 'docs/CANDIDATE_REPLAY.md', 'docs/DEV_LOG.md'
])

function assertCandidateSource({ sourceSha, sourceRef }) {
  assert(SHA.test(sourceSha ?? ''), 'Candidate source pin must be a full commit SHA')
  assert(typeof sourceRef === 'string' && /^release\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sourceRef)
    && !sourceRef.includes('..') && !sourceRef.includes('//') && !/[/.]$/.test(sourceRef)
    && !sourceRef.split('/').some(part => part.endsWith('.lock')), 'Candidate requires a reviewed release branch')
}

async function regular(path, limit = 32768) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    assert(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Candidate input must be a bounded regular file')
    return await fd.readFile()
  } finally { await fd.close() }
}

async function fileIdentity(path) {
  const stat = await lstat(path)
  assert(stat.isFile() && stat.size > 0 && stat.size < 2 * 1024 ** 3, 'Candidate asset must be a bounded regular file')
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { size: stat.size, sha256: hash.digest('hex') }
}

export function candidateAssets(version, track) {
  return [`AgentsDock-${version}-mac-universal.zip`, `AgentsDock-${version}-mac-universal.zip.blockmap`,
    `AgentsDock-${version}-mac-universal.dmg`, `${track === 'beta' ? 'beta' : 'latest'}-mac.yml`,
    'agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig', 'SHA256SUMS'].sort()
}

export function validateCandidateReceipt(value) {
  assert(value?.schema === 1 && value.kind === CANDIDATE_KIND && value.scope === 'darwin-app-server'
    && value.publicationEligible === false, 'Not an explicitly non-publishing macOS candidate receipt')
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(value.version)
    && value.track === 'beta', 'Candidate rehearsal is restricted to an opt-in beta')
  assert(SHA.test(value.sourceSha) && SHA.test(value.exportSha), 'Candidate source/export pins must be full commit SHAs')
  assertCandidateSource(value)
  assert(/^[1-9]\d{0,3}$/.test(value.buildNumber), 'Candidate needs its explicit native build reservation')
  for (const name of ['npmManifestSha256', 'legacyManifestSha256', 'serverBundleSha256', 'desktopManifestSha256', 'serverImportSha256']) {
    assert(HASH.test(value[name]), `Missing candidate ${name}`)
  }
  assert(/^[1-9]\d*$/.test(value.signerRunId) && /^[1-9]\d*$/.test(value.signerRunAttempt), 'Missing candidate signing-run provenance')
  assert(/^sha256:[a-f0-9]{64}$/.test(value.signerArtifactDigest), 'Missing original signing artifact ZIP digest')
  assert.deepEqual(Object.keys(value.desktopAssets ?? {}).sort(), candidateAssets(value.version, value.track), 'Candidate desktop inventory is not exact')
  for (const asset of Object.values(value.desktopAssets)) assert(Number.isSafeInteger(asset.size) && asset.size > 0
    && asset.size < 2 * 1024 ** 3 && HASH.test(asset.sha256), 'Invalid candidate desktop asset identity')
  assert(value.desktopAssets.SHA256SUMS.sha256 === value.desktopManifestSha256, 'Candidate checksum manifest is not bound')
  return value
}

function assertCandidateRunnerContext(env, platform, expectedPlatform, expectedOs) {
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && /^ZhengyiLuo\/AgentsDock\/\.github\/workflows\/ci\.yml@refs\/heads\/release\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(env.GITHUB_WORKFLOW_REF ?? '')
    && SHA.test(env.GITHUB_SHA ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')
    && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && platform === expectedPlatform && env.RUNNER_OS === expectedOs,
  `Candidate replay requires an explicit canonical ci.yml dispatch on a disposable ${expectedOs} release-branch runner`)
}

export function assertCandidateRunner(env = process.env, platform = process.platform) {
  assertCandidateRunnerContext(env, platform, 'darwin', 'macOS')
}

// Separate server-only execution scope. The sealed macOS candidate is used as
// exact server provenance, never relabelled as a Linux desktop/production seal.
export function assertCandidateServerRunner(env = process.env, platform = process.platform) {
  assertCandidateRunnerContext(env, platform, 'linux', 'Linux')
  assert(env.GITHUB_JOB === 'candidate-server-rollback-linux', 'Linux replay requires its explicit server-only rollback job')
}

export function assertCandidateCheckout(identity, options = {}) {
  return assertCandidateCheckoutWithRunner(identity, options, assertCandidateRunner)
}

export function assertCandidateServerCheckout(identity, options = {}) {
  return { ...assertCandidateCheckoutWithRunner(identity, options, assertCandidateServerRunner),
    executionScope: 'candidate-server-linux', desktopAcceptance: false }
}

function assertCandidateCheckoutWithRunner(identity, { env = process.env, execute = execFileSync,
  repositoryDirectory = ROOT, platform = process.platform } = {}, runnerGuard) {
  runnerGuard(env, platform)
  assertCandidateSource(identity)
  assert(env.GITHUB_WORKFLOW_REF === `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${identity.sourceRef}`,
    'Candidate harness must run on the receipt\'s reviewed release branch')
  const directory = resolve(repositoryDirectory)
  // The TLS listener binds as root, then drops privileges. Trust only this
  // explicit checkout for read-only git queries, never global safe.directory=*.
  const git = (...args) => execute('git', ['--no-optional-locks', '-c', `safe.directory=${directory}`, '-C', directory, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  })
  const harnessSourceSha = git('rev-parse', '--verify', 'HEAD').trim()
  assert(harnessSourceSha === env.GITHUB_SHA, 'Candidate harness HEAD must equal the truthful workflow GITHUB_SHA')
  assert(git('rev-parse', '--verify', '--end-of-options', `${identity.sourceSha}^{commit}`).trim() === identity.sourceSha,
    'Candidate artifact source commit is not present locally')
  try { git('merge-base', '--is-ancestor', identity.sourceSha, harnessSourceSha) }
  catch { throw new Error('Candidate harness must descend from the sealed artifact source') }
  assert(git('status', '--porcelain', '--untracked-files=all').trim() === '', 'Candidate harness checkout must be clean')
  const changedPaths = git('diff', '--no-ext-diff', '--name-only', '--no-renames', '-z', identity.sourceSha, harnessSourceSha)
    .split('\0').filter(Boolean)
  assert(changedPaths.every(path => CANDIDATE_HARNESS_PATHS.includes(path)),
    'Candidate harness retry changed runtime, build payload or another non-allowlisted path')
  return { sourceSha: identity.sourceSha, harnessSourceSha, sourceRef: identity.sourceRef,
    changedPaths, publicationEligible: false }
}

export async function inspectCandidate({ receiptPath, receiptSha256, serverDirectory, desktopDirectory, publicKey }) {
  const bytes = await regular(receiptPath)
  assert(HASH.test(receiptSha256) && digest(bytes) === receiptSha256, 'Candidate receipt differs from independently accepted bytes')
  const receipt = validateCandidateReceipt(JSON.parse(bytes))
  verifyServerBundleIdentity(receipt, serverDirectory, publicKey)
  const importBytes = await regular(join(dirname(serverDirectory), 'server-import.json'))
  assert(digest(importBytes) === receipt.serverImportSha256, 'Server import report changed')
  const imported = JSON.parse(importBytes)
  assert(imported.schema === 1 && imported.kind === 'artifact-only-server-import' && imported.releaseAcceptance === false,
    'Candidate requires the verified artifact-only server import')
  for (const key of ['version', 'track', 'sourceSha', 'sourceRef', 'exportSha', 'signerRunId', 'signerRunAttempt',
    'signerArtifactDigest', 'npmManifestSha256', 'legacyManifestSha256', 'serverBundleSha256']) {
    assert(imported[key] === receipt[key], `Candidate server import ${key} differs`)
  }
  assert(`sha256:${(await fileIdentity(join(dirname(serverDirectory), 'signer-artifact.zip'))).sha256}` === receipt.signerArtifactDigest,
    'Original GitHub signing artifact ZIP changed')
  if (desktopDirectory) {
    assert((await lstat(desktopDirectory)).isDirectory(), 'Candidate desktop directory cannot be a symlink')
    assert.deepEqual((await readdir(desktopDirectory)).sort(), candidateAssets(receipt.version, receipt.track))
    for (const [name, expected] of Object.entries(receipt.desktopAssets)) {
      assert.deepEqual(await fileIdentity(join(desktopDirectory, name)), expected, 'Candidate desktop asset changed')
    }
    const sums = (await regular(join(desktopDirectory, 'SHA256SUMS'))).toString('utf8').trimEnd().split('\n')
    const expected = Object.entries(receipt.desktopAssets).filter(([name]) => name !== 'SHA256SUMS')
      .map(([name, asset]) => `${asset.sha256}  ${name}`).sort()
    assert.deepEqual(sums.sort(), expected, 'Candidate checksum manifest must cover the exact desktop asset set')
    for (const name of ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']) {
      assert((await regular(join(desktopDirectory, name))).equals(await regular(join(serverDirectory, 'npm', name))),
        'Candidate app/server descriptor bytes differ')
    }
  }
  return receipt
}

export async function sealCandidate({ serverDirectory, desktopDirectory, destination, sourceSha, sourceRef,
  version, buildNumber, exportSha, signerRunId, signerRunAttempt }) {
  const desktopAssets = {}
  assert.deepEqual((await readdir(desktopDirectory)).sort(), candidateAssets(version, 'beta'))
  for (const name of candidateAssets(version, 'beta')) desktopAssets[name] = await fileIdentity(join(desktopDirectory, name))
  const importBytes = await regular(join(dirname(serverDirectory), 'server-import.json'))
  const imported = JSON.parse(importBytes)
  const receipt = { schema: 1, kind: CANDIDATE_KIND, scope: 'darwin-app-server', publicationEligible: false,
    version, track: 'beta', sourceSha, sourceRef, buildNumber, exportSha, signerRunId, signerRunAttempt,
    serverImportSha256: digest(importBytes), signerArtifactDigest: imported.signerArtifactDigest,
    npmManifestSha256: digest(await regular(join(serverDirectory, 'npm/agents-server-npm-manifest.json'))),
    legacyManifestSha256: digest(await regular(join(serverDirectory, 'legacy/agents-server-manifest.json'))),
    serverBundleSha256: digest(await regular(join(serverDirectory, 'product-server-bundle.json'))),
    desktopManifestSha256: desktopAssets.SHA256SUMS.sha256, desktopAssets }
  validateCandidateReceipt(receipt)
  verifyServerBundleIdentity(receipt, serverDirectory)
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  await inspectCandidate({ receiptPath: destination, receiptSha256: digest(bytes), serverDirectory, desktopDirectory })
  return { receipt, receiptSha256: digest(bytes) }
}

async function main() {
  const [operation, ...args] = process.argv.slice(2)
  if (operation === 'validate-runner' || operation === 'validate-server-runner') {
    assert(args.length === 2, 'Usage: product-candidate-receipt.mjs validate-runner RECEIPT SHA256')
    const bytes = await regular(args[0])
    assert(HASH.test(args[1]) && digest(bytes) === args[1], 'Candidate receipt differs from independently accepted bytes')
    const validate = operation === 'validate-server-runner' ? assertCandidateServerCheckout : assertCandidateCheckout
    console.log(JSON.stringify(validate(validateCandidateReceipt(JSON.parse(bytes)))))
  } else if (operation === 'inspect') {
    assert(args.length === 3 || args.length === 4, 'Usage: product-candidate-receipt.mjs inspect RECEIPT SHA256 SERVER_DIR [DESKTOP_DIR]')
    const receipt = await inspectCandidate({ receiptPath: args[0], receiptSha256: args[1], serverDirectory: args[2], desktopDirectory: args[3] })
    console.log(JSON.stringify(receipt))
  } else if (operation === 'seal') {
    assert(args.length === 3, 'Usage: product-candidate-receipt.mjs seal SERVER_DIR DESKTOP_DIR RECEIPT (identity via explicit environment)')
    assert(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === process.env.SOURCE_SHA, 'Seal requires the pinned source checkout')
    execFileSync('git', ['diff', '--quiet', 'HEAD'], { stdio: 'pipe' })
    const result = await sealCandidate({ serverDirectory: args[0], desktopDirectory: args[1], destination: args[2],
      sourceSha: process.env.SOURCE_SHA, sourceRef: process.env.SOURCE_REF, version: process.env.RELEASE_VERSION,
      buildNumber: process.env.BUILD_NUMBER, exportSha: process.env.EXPORT_SHA,
      signerRunId: process.env.SIGNER_RUN_ID, signerRunAttempt: process.env.SIGNER_RUN_ATTEMPT })
    console.log(JSON.stringify({ candidateReceiptSha256: result.receiptSha256, publicationEligible: false }))
  } else throw new Error('Expected inspect, validate-runner or seal')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
