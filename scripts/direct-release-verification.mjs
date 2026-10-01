#!/usr/bin/env node

// Verify an already sealed canonical draft. This helper has no publication mode.
import { mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GitHubClient, ReleaseMirror, verifyAssets } from './direct-release-mirror.mjs'
import { validateElectronReleaseVersion } from './validate_electron_release_version.mjs'

export const CANONICAL_REPOSITORY = 'ZhengyiLuo/AgentsDock'
export const NATIVE_JOBS = ['verify-macos', 'verify-linux-x64', 'verify-linux-arm64', 'verify-windows-x64']

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function validatePins(options) {
  requireValue(options.verificationOnly === 'true', 'This helper requires verification-only=true; it cannot publish.')
  requireValue(/^[0-9a-f]{40}$/.test(options.expectedSourceSha ?? ''), 'Verification requires a full expected source SHA.')
  requireValue(/^[0-9a-f]{64}$/.test(options.expectedManifestSha256 ?? ''), 'Verification requires the expected full checksum-manifest SHA-256.')
  validateElectronReleaseVersion(options.version, options.track, [])
}

// Even though private draft reads need Contents write on GITHUB_TOKEN, only
// fixed canonical GET/download operations are available through this client.
export class VerificationGitHubClient extends GitHubClient {
  run(args) {
    const prefix = `repos/${CANONICAL_REPOSITORY}/`
    const readOne = args.length === 2 && args[0] === 'api' &&
      new RegExp(`^${prefix}(?:(?:releases/tags|git/ref/tags)/v\\d+\\.\\d+\\.\\d+(?:-beta\\.\\d+)?|git/tags/[0-9a-f]{40})$`).test(args[1])
    const readHistory = JSON.stringify(args) === JSON.stringify(['api', '--paginate', '--slurp', `${prefix}releases?per_page=100`])
    // download() has seven arguments, or nine with a fixed asset pattern.
    const readDownload = [7, 9].includes(args.length) && args[0] === 'release' && args[1] === 'download' &&
      /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(args[2]) && args[3] === '--repo' && args[4] === CANONICAL_REPOSITORY &&
      args[5] === '--dir' && typeof args[6] === 'string' &&
      (args.length === 7 || (args[7] === '--pattern' && ['SHA256SUMS', 'agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig'].includes(args[8])))
    requireValue(readOne || readHistory || readDownload, 'Verification permits only canonical draft GET/download operations.')
    return super.run(args)
  }
}

export async function inspectCanonicalDraft(options, { client = new VerificationGitHubClient(), publicKey } = {}) {
  validatePins(options)
  requireValue(typeof options.assets === 'string' && options.assets.length > 0, 'Verification requires an empty replay asset directory.')
  requireValue(['true', 'false'].includes(options.allowUnsignedWindows), 'Verification requires an explicit unsigned Windows policy.')
  const mirror = new ReleaseMirror(client, { publicKey })
  const accepted = await mirror.existing(CANONICAL_REPOSITORY, options, {
    sourceSha: options.expectedSourceSha,
    manifestSha256: options.expectedManifestSha256,
    coordinatedUpdates: true,
  })
  requireValue(accepted?.release.draft === true, 'Verification requires an existing canonical draft, not a published release.')
  if (options.track === 'stable' && accepted.windowsSigning === 'unsigned') {
    requireValue(options.allowUnsignedWindows === 'true', 'Unsigned stable verification requires allow_unsigned_windows.')
  }
  await mkdir(options.assets, { recursive: true })
  requireValue((await readdir(options.assets)).length === 0, 'Replay asset directory must be empty.')
  client.download(CANONICAL_REPOSITORY, `v${options.version}`, options.assets)
  const manifestSha256 = await verifyAssets(options.assets, options.version, options.track, { ...accepted, publicKey })
  requireValue(manifestSha256 === options.expectedManifestSha256, 'Canonical assets changed during verification download.')
  return accepted
}

export function createVerificationReceipt(options, needs) {
  validatePins(options)
  const jobs = ['inspect-draft', ...NATIVE_JOBS]
  requireValue(needs && typeof needs === 'object' && JSON.stringify(Object.keys(needs).sort()) === JSON.stringify([...jobs].sort()), 'Receipt requires inspection and exactly four native jobs.')
  for (const job of jobs) {
    requireValue(needs[job]?.result === 'success', `Verification job did not succeed: ${job}`)
    requireValue(needs[job]?.outputs?.manifest_sha256 === options.expectedManifestSha256, `Verification checksum seal mismatch: ${job}`)
  }
  const inspected = needs['inspect-draft'].outputs
  requireValue(inspected.source_sha === options.expectedSourceSha, 'Verified source differs from the expected source.')
  requireValue(inspected.coordinated_updates === 'true', 'Verification receipt requires the complete coordinated asset set.')
  requireValue(/^(main|release\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(inspected.source_ref ?? '') &&
    !inspected.source_ref.includes('..') && !inspected.source_ref.includes('//') && !inspected.source_ref.endsWith('/') &&
    !inspected.source_ref.endsWith('.') && !inspected.source_ref.split('/').some(part => part.endsWith('.lock')), 'Invalid verified source ref.')
  requireValue(['require-signed', 'allow-unsigned'].includes(inspected.windows_signing_policy), 'Invalid verified Windows signing policy.')
  requireValue(/^[0-9a-f]{40}$/.test(options.workflowSha ?? ''), 'Receipt requires the actual workflow SHA.')
  requireValue(options.workflowRef === `${CANONICAL_REPOSITORY}/.github/workflows/direct-desktop-release-publish.yml@refs/heads/${inspected.source_ref}`, 'Receipt requires the canonical workflow on the verified source ref.')
  requireValue(/^[1-9]\d*$/.test(options.runId ?? '') && /^[1-9]\d*$/.test(options.runAttempt ?? ''), 'Receipt requires the actual workflow run and attempt.')
  return {
    schema: 1,
    kind: 'direct-desktop-platform-verification',
    mode: 'verification-only',
    repository: CANONICAL_REPOSITORY,
    workflowSha: options.workflowSha,
    workflowRef: options.workflowRef,
    runId: options.runId,
    runAttempt: options.runAttempt,
    runUrl: `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${options.runId}/attempts/${options.runAttempt}`,
    version: options.version,
    track: options.track,
    sourceSha: inspected.source_sha,
    sourceRef: inspected.source_ref,
    manifestSha256: options.expectedManifestSha256,
    coordinatedUpdates: true,
    windowsSigningPolicy: inspected.windows_signing_policy,
    jobs: Object.fromEntries(jobs.map(job => [job, { result: needs[job].result, manifestSha256: needs[job].outputs.manifest_sha256 }])),
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  requireValue(['inspect', 'receipt'].includes(command) && args.length % 2 === 0, 'Usage: direct-release-verification.mjs inspect|receipt --verification-only true [pinned options]')
  const allowed = new Set(['verification-only', 'version', 'track', 'expected-source-sha', 'expected-manifest-sha256',
    ...(command === 'inspect' ? ['assets', 'allow-unsigned-windows'] : ['workflow-sha', 'workflow-ref', 'run-id', 'run-attempt'])])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '')
    requireValue(args[index].startsWith('--') && allowed.has(name), 'Unknown verification option.')
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    requireValue(!(key in options), 'Duplicate verification option.')
    options[key] = args[index + 1]
  }
  if (command === 'inspect') {
    if (options.assets) options.assets = resolve(options.assets)
    const result = await inspectCanonicalDraft(options)
    process.stdout.write(`coordinated_updates=${result.coordinatedUpdates}\nsource_sha=${result.sourceSha}\nsource_ref=${result.sourceRef}\nmanifest_sha256=${result.manifestSha256}\nwindows_signing_policy=${result.windowsSigning === 'signed' ? 'require-signed' : 'allow-unsigned'}\n`)
  } else {
    const result = createVerificationReceipt(options, JSON.parse(process.env.DIRECT_RELEASE_VERIFICATION_NEEDS ?? '{}'))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
