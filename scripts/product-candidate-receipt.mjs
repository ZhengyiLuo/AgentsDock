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
import { validateDescriptor } from './stage_coordinated_release.mjs'
import { verifyArchiveBytes } from './verify_npm_publication.mjs'

const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const CANDIDATE_KIND = 'agentsdock-macos-candidate'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Stable support is deliberately scoped to this reviewed release, not an
// authorization to turn arbitrary stable packages into production acceptance.
export function candidateTrack(version) {
  if (version === '1.0.9') return 'stable'
  assert(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(version),
    'Candidate rehearsal requires a numbered beta or the reviewed stable 1.0.9')
  return 'beta'
}

const DESKTOP_106 = Object.freeze({ version: '1.0.6', track: 'stable', repository: 'AgentsDock-Releases',
  checksumSha256: '4bbe9fb4db61234542116f5de518872ebd4f2aa0805b1c06afd2032282eed828',
  zipSha256: '1ca6530cf72818d26e68af571f77d2eb0473e0e7b07923358f696b4a1673b7ee',
  metadataSha256: '88dfc858c4390eb1544603bb37c07cc43f4b1bf4e12ef1efd3567fa58008268e' })
export const STABLE_BASELINES = Object.freeze({
  stable108: Object.freeze({ desktop: DESKTOP_106, subscription: 'stable', server: Object.freeze({ version: '1.0.8', track: 'stable',
    sourceSha: '8a965007408c6ab9672d746366b9fc0bd58feff6',
    manifestSha256: '64881777ab0ebf8ad029ec1f4f1212e1699f9ee7a1d62420ae32e5f3dcfe7198',
    signatureSha256: 'e224f89215b2b0d047a49aa0264ff803ef96c3ea71a6a39985b68eef67b6f18d',
    archiveSha256: 'c9846ca863312478f64979cc579feea521902dc23c15f0f30ca5eebdb544808f', archiveBytes: 3721335 }) }),
  beta1085: Object.freeze({ desktop: Object.freeze({ version: '1.0.8-beta.5', track: 'beta', repository: 'AgentsDock',
    sourceSha: '85327b94a378c441949da5e775e265626743b6c6',
    checksumSha256: '07460d66d1f97713b83a8a0542c8e5f5e481ed8724fc9ef77b2a036690e366ae',
    zipSha256: 'dc481f894ef6fe4607f8d439722b7c526f1e795f8e0ac6ce13e7af070ef29299',
    metadataSha256: '767711f1a1cf8049f73feaa2a095f4d3905e1dc10ee54ff8d70b8d45d8961f6f' }), subscription: 'beta',
    server: Object.freeze({ version: '1.0.8-beta.5', track: 'beta', sourceSha: '85327b94a378c441949da5e775e265626743b6c6',
      manifestSha256: '43fc9b2ebbdca7df6040dcc0536adf96a8cdd408a4e88cf9e3e7809e8886d858',
      signatureSha256: '615187db81d9d56e6d3ae962d164087f1905cb95582207ae4e11562433eaf019',
      archiveSha256: '406a69593c78b8fc76d3fccf489c177c69316ef8e48c694f8a7263acc873a87d', archiveBytes: 3722548 }) })
})

export function stableBaselineProfile(name, candidateVersion) {
  assert(candidateVersion === '1.0.9' && Object.hasOwn(STABLE_BASELINES, name), 'Unknown stable 1.0.9 baseline profile')
  return STABLE_BASELINES[name]
}

// Public beta.1 bytes authenticated independently of every candidate receipt.
// Keep historical beta.2/beta.3 replay and the reviewed beta.4 journey exact;
// this is not a general mutable baseline selector or candidate acceptance.
export const BETA1101_CANDIDATE_VERSIONS = Object.freeze(['1.0.10-beta.2', '1.0.10-beta.3', '1.0.10-beta.4'])
export const BETA1101_BASELINE = Object.freeze({
  desktop: Object.freeze({ version: '1.0.10-beta.1', buildNumber: '1245', track: 'beta', repository: 'AgentsDock',
    sourceSha: '7790690fc91f0d6331b265820ef64234f5213abd',
    checksumSha256: 'bf692d32c2b86d1b117761b1a9bd46e9bbe285b11a3fa57be44f965585d4505c',
    zipSha256: '6ba42d86aa8bfd36f3c6abf8e90b385a16c4f5bf857ef171bb35453054e420d4',
    metadataSha256: 'b923370acefed234af4bdd107a92ebcfbf388b98b75d750813953ef3e751bea8' }),
  subscription: 'beta',
  server: Object.freeze({ version: '1.0.10-beta.1', track: 'beta', sourceSha: '7790690fc91f0d6331b265820ef64234f5213abd',
    manifestSha256: '01286c1d46b6c0673d849b23b258056ebba35068e195ae500e789eb82b21f3fc',
    signatureSha256: '52286edbd8bf9c40bee555ff9defb4e223ba002eec749d1043609d4171281986',
    archiveSha256: '050ddc103670df77b3fe31236cd119c71d7b933e0948b7cf85f92afe2ce2056b', archiveBytes: 3727576 })
})

export function candidateBaselineProfile(name, candidateVersion) {
  if (name === 'beta1101') {
    assert(BETA1101_CANDIDATE_VERSIONS.includes(candidateVersion), 'Beta.1 baseline requires an exact reviewed beta.2, beta.3 or beta.4 candidate')
    return BETA1101_BASELINE
  }
  return stableBaselineProfile(name, candidateVersion)
}

export async function verifyBaselineServer(name, directory, candidateVersion) {
  const expected = candidateBaselineProfile(name, candidateVersion).server
  const manifest = await regular(join(directory, 'agents-server-npm-manifest.json'), 8192)
  const signature = await regular(join(directory, 'agents-server-npm-manifest.sig'), 64)
  assert.equal(digest(manifest), expected.manifestSha256, 'Baseline descriptor differs from independently pinned bytes')
  assert.equal(digest(signature), expected.signatureSha256, 'Baseline signature differs from independently pinned bytes')
  const descriptor = validateDescriptor(manifest, signature, await regular(join(ROOT, 'server/release-public-key.pem'), 4096), expected.version)
  assert(descriptor.commit === expected.sourceSha && descriptor.track === expected.track
    && descriptor.prerelease === (expected.track === 'beta') && descriptor.archive.sha256 === expected.archiveSha256
    && descriptor.archive.size === expected.archiveBytes, 'Baseline server identity differs')
  verifyArchiveBytes(await regular(join(directory, `server-${expected.version}.tgz`), expected.archiveBytes), descriptor)
  return { ...expected }
}

export async function verifyBaselineDesktop(name, directory, candidateVersion) {
  const expected = candidateBaselineProfile(name, candidateVersion).desktop
  assert.equal(digest(await regular(join(directory, 'SHA256SUMS'), 65536)), expected.checksumSha256,
    'Baseline public checksum manifest differs from independently pinned bytes')
  assert.equal((await fileIdentity(join(directory, `AgentsDock-${expected.version}-mac-universal.zip`))).sha256,
    expected.zipSha256, 'Baseline desktop ZIP differs from independently pinned bytes')
  assert.equal(digest(await regular(join(directory, `${expected.track === 'beta' ? 'beta' : 'latest'}-mac.yml`))),
    expected.metadataSha256, 'Baseline channel metadata differs from independently pinned bytes')
  return { ...expected }
}
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

// Two reviewed prerequisite-test lifecycle fixes for the already sealed 1.0.9
// source. These paths are NOT a general test allowlist. Only the exact original
// and corrected blobs, regular non-executable modes and modified-only deltas
// below may accompany a descendant harness; signed/runtime bytes stay fixed.
export const CANDIDATE_PREREQUISITE_TEST_EXCEPTION = Object.freeze({
  sourceSha: '33c21482170010108830aef8009831d5d1da624c',
  sourceRef: 'release/1.0.9',
  changes: Object.freeze({
    'electron/src/renderer/src/components/ProviderUsageIndicator.test.tsx': Object.freeze({
      before: '69fab9e26f994a1d50c10797887d3dc16f8492bb', after: 'b054eb3ed2b6bf9b08d8d0fec4c12c71dc9e64f7'
    }),
    'electron/src/renderer/src/components/SecurePeerPanel.test.tsx': Object.freeze({
      before: '9bdd50a7ddc761c843fc7eff36eaed23cf83709f', after: '6be941a7eb733169661685aac581096b576e1770'
    })
  })
})

function reviewedPrerequisiteTestChange(identity, harnessSourceSha, path, git) {
  const exception = CANDIDATE_PREREQUISITE_TEST_EXCEPTION
  if (identity.sourceSha !== exception.sourceSha || identity.sourceRef !== exception.sourceRef
      || !Object.hasOwn(exception.changes, path)) return false
  const { before, after } = exception.changes[path]
  const raw = git('diff', '--no-ext-diff', '--no-renames', '--raw', '--full-index', '--abbrev=40', '-z',
    identity.sourceSha, harnessSourceSha, '--', path)
  return raw === `:100644 100644 ${before} ${after} M\0${path}\0`
}

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
  assert(value.track === candidateTrack(value.version), 'Candidate version and track differ')
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
  assert(changedPaths.every(path => CANDIDATE_HARNESS_PATHS.includes(path)
    || reviewedPrerequisiteTestChange(identity, harnessSourceSha, path, git)),
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
  const track = candidateTrack(version)
  assert.deepEqual((await readdir(desktopDirectory)).sort(), candidateAssets(version, track))
  for (const name of candidateAssets(version, track)) desktopAssets[name] = await fileIdentity(join(desktopDirectory, name))
  const importBytes = await regular(join(dirname(serverDirectory), 'server-import.json'))
  const imported = JSON.parse(importBytes)
  const receipt = { schema: 1, kind: CANDIDATE_KIND, scope: 'darwin-app-server', publicationEligible: false,
    version, track, sourceSha, sourceRef, buildNumber, exportSha, signerRunId, signerRunAttempt,
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
  if (operation === 'verify-baseline-server' || operation === 'verify-baseline-desktop') {
    assert(args.length === 3, 'Usage: verify-baseline-{server|desktop} PROFILE DIRECTORY CANDIDATE_VERSION')
    console.log(JSON.stringify(await (operation === 'verify-baseline-server' ? verifyBaselineServer : verifyBaselineDesktop)(...args)))
  } else if (operation === 'validate-runner' || operation === 'validate-server-runner') {
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
