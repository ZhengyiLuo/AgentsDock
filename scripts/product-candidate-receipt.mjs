#!/usr/bin/env node
// Offline seal for a scoped macOS + server rehearsal. NEVER a release receipt.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, open, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { verifyServerBundleIdentity } from './product-release.mjs'

const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const CANDIDATE_KIND = 'agentsdock-macos-candidate'

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
  assert(/^release\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.sourceRef) && !value.sourceRef.includes('..')
    && !value.sourceRef.includes('//') && !/[/.]$/.test(value.sourceRef)
    && !value.sourceRef.split('/').some(part => part.endsWith('.lock')), 'Candidate requires a reviewed release branch')
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

export function assertCandidateRunner(env = process.env, platform = process.platform) {
  assert(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && /^ZhengyiLuo\/AgentsDock\/\.github\/workflows\/ci\.yml@refs\/heads\/release\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(env.GITHUB_WORKFLOW_REF ?? '')
    && SHA.test(env.GITHUB_SHA ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')
    && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && platform === 'darwin' && env.RUNNER_OS === 'macOS',
  'Candidate replay requires an explicit canonical ci.yml dispatch on a disposable macOS release-branch runner')
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
  if (operation === 'inspect') {
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
  } else throw new Error('Expected inspect or seal')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
