#!/usr/bin/env node
// One frozen release, two notarization passes. No signing, execution, or publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { validateDescriptor } from './stage_coordinated_release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const IDENTITY = Object.freeze({
  schema: 'agentsdock-macos-notarization-v1', repository: 'ZhengyiLuo/AgentsDock',
  sourceSha: '8d5327a9077f69f9a0a14c58b8e087a80f7f1762', sourceRef: 'release/1.0.10-beta.2',
  version: '1.0.10-beta.2', buildNumber: '1246', track: 'beta', preparationRunId: '37159258614',
  transportRevision: 2,
})
const HARNESS_REF = 'refs/heads/release/1.0.10-beta.2-harness'
const MANIFEST = 'agents-server-npm-manifest.json', SIGNATURE = 'agents-server-npm-manifest.sig'
const MAX_INPUT = 2 * 1024 ** 3
const sha = value => createHash('sha256').update(value).digest('hex')
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
const need = (value, message) => { if (!value) throw new Error(message) }
const keys = (value, expected) => need(value && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), 'Unexpected object fields.')
const artifactName = stage => stage === 'app' ? 'notary-input.zip' : 'notary-input.dmg'
// Revision one remains preserved evidence, not an acceptable transport input.
const stageTag = stage => `notarize-v${IDENTITY.version}-${stage}-r2`

function regular(filename, maximum) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Expected a bounded regular input file.')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

async function fileHash(filename) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    need(before.isFile() && before.size > 0 && before.size <= MAX_INPUT, 'Invalid notarization artifact size/type.')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filename, { fd, autoClose: false })) hash.update(chunk)
    const after = fstatSync(fd)
    need(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Artifact changed while hashing.')
    return { sha256: hash.digest('hex'), size: before.size }
  } finally { closeSync(fd) }
}

export function parsePin(text) {
  need(typeof text === 'string' && text.length < 2048, 'A bounded notarization pin is required.')
  const pin = JSON.parse(text)
  keys(pin, ['stage', 'draftId', 'requestSha256', 'inputSha256', 'harnessSha'])
  need(['app', 'dmg'].includes(pin.stage), 'Invalid notarization stage.')
  need(Number.isSafeInteger(pin.draftId) && pin.draftId > 0, 'Expected numeric draft ID.')
  need(hex(pin.requestSha256, 64) && hex(pin.inputSha256, 64) && hex(pin.harnessSha, 40), 'Invalid independent notarization pins.')
  return pin
}

export function validateRunner(pin, env = process.env) {
  need(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REPOSITORY === IDENTITY.repository, 'Notarization requires canonical manual dispatch.')
  need(env.GITHUB_REF === HARNESS_REF && env.GITHUB_SHA === pin.harnessSha, 'The reviewed harness ref/SHA must match exactly.')
  need(env.GITHUB_WORKFLOW_REF === `${IDENTITY.repository}/.github/workflows/ci.yml@${HARNESS_REF}`, 'Unexpected notarization workflow.')
  need(/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || ''), 'Missing workflow run identity.')
  const other = JSON.parse(env.NOTARIZE_OTHER_INPUTS || '{}')
  const booleans = ['npm_native_validation', 'candidate_replay', 'candidate_server_rollback']
  const strings = ['npm_candidate_tag', 'npm_manifest_sha256', 'npm_source_sha', 'candidate_tag', 'candidate_receipt_sha256', 'candidate_bundle_sha256']
  // GitHub omits optional empty string inputs from toJSON(inputs), while
  // materializing boolean defaults. Absence here means the documented empty
  // default, never permission for an unknown or nonempty operation input.
  keys(other, [...booleans, ...strings.filter(key => Object.hasOwn(other, key)), 'notarize'])
  need(other.notarize === env.NOTARIZE_PIN, 'Dispatch notarization pin changed.')
  need(booleans.every(key => other[key] === false) && strings.every(key => !Object.hasOwn(other, key) || other[key] === ''), 'Notarization inputs are mutually exclusive with every other CI mode.')
}

export function validateRequest(request, pin, manifestBytes, signatureBytes, publicKey) {
  keys(request, [...Object.keys(IDENTITY), 'stage', 'artifact', 'manifestSha256', 'signatureSha256', 'appCDHashes'])
  for (const [key, value] of Object.entries(IDENTITY)) need(request[key] === value, `Frozen notarization ${key} changed.`)
  need(request.stage === pin.stage, 'Notarization stage changed.')
  keys(request.artifact, ['name', 'sha256', 'size'])
  need(request.artifact.name === artifactName(pin.stage) && request.artifact.sha256 === pin.inputSha256, 'Artifact name/hash differs from the independent pin.')
  need(Number.isSafeInteger(request.artifact.size) && request.artifact.size > 0 && request.artifact.size <= MAX_INPUT, 'Invalid artifact size.')
  keys(request.appCDHashes, ['arm64', 'x86_64'])
  need(Object.values(request.appCDHashes).every(value => hex(value, 40)), 'Both signed architecture CDHashes are required.')
  need(hex(request.manifestSha256, 64) && request.manifestSha256 === sha(manifestBytes), 'Signed descriptor hash changed.')
  need(hex(request.signatureSha256, 64) && request.signatureSha256 === sha(signatureBytes), 'Descriptor signature hash changed.')
  const descriptor = validateDescriptor(manifestBytes, signatureBytes, publicKey, IDENTITY.version)
  need(descriptor.commit === IDENTITY.sourceSha, 'Descriptor source does not match frozen application source.')
  return request
}

export function validateDraft(draft, pin) {
  need(draft.id === pin.draftId && draft.draft === true && draft.prerelease === true && draft.tag_name === stageTag(pin.stage) && draft.target_commitish === IDENTITY.sourceSha, 'Notarization requires the exact unpublished frozen-source draft.')
  const names = ['notary-request.json', artifactName(pin.stage), MANIFEST, SIGNATURE].sort()
  need(Array.isArray(draft.assets), 'Missing draft assets.')
  assert.deepEqual(draft.assets.map(asset => asset.name).sort(), names, 'Notarization draft asset set must be exact.')
  for (const asset of draft.assets) {
    need(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid draft asset metadata.')
    need(asset.size <= (asset.name === artifactName(pin.stage) ? MAX_INPUT : 16384), 'Draft asset exceeds its size bound.')
    need(/^sha256:[0-9a-f]{64}$/.test(asset.digest || ''), 'Draft asset must have a GitHub SHA-256 digest.')
  }
  need(new Set(draft.assets.map(asset => asset.id)).size === names.length, 'Duplicate draft asset IDs.')
}

// There is deliberately no arbitrary gh command, release mutation, or URL input.
export class NotarizationReader {
  constructor(execute = spawnSync) { this.execute = execute }
  get(endpoint, output) {
    need(new RegExp(`^repos/${IDENTITY.repository}/(?:releases/[1-9]\\d*|releases/assets/[1-9]\\d*|actions/runs/${IDENTITY.preparationRunId})$`).test(endpoint), 'Only allowlisted canonical GitHub GETs are available.')
    const args = ['api', '--method', 'GET', endpoint]
    if (output) {
      need(endpoint.includes('/releases/assets/'), 'Only an asset GET may stream bytes.')
      args.push('--header', 'Accept: application/octet-stream')
      const fd = openSync(output, 'wx', 0o600)
      try {
        const result = this.execute('gh', args, { stdio: ['ignore', fd, 'pipe'] })
        need(result.status === 0, 'Canonical draft asset download failed.')
      } finally { closeSync(fd) }
      return
    }
    need(!endpoint.includes('/releases/assets/'), 'Asset bytes require a destination file.')
    const result = this.execute('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    need(result.status === 0, 'Canonical GitHub metadata read failed.')
    return JSON.parse(result.stdout)
  }
}

async function loadRequest(directory, pin) {
  const bytes = regular(join(directory, 'notary-request.json'), 16384)
  need(sha(bytes) === pin.requestSha256, 'Independent request SHA-256 changed.')
  const request = validateRequest(JSON.parse(bytes), pin, regular(join(directory, MANIFEST), 8192), regular(join(directory, SIGNATURE), 64), regular(join(ROOT, 'server/release-public-key.pem'), 4096))
  assert.deepEqual(await fileHash(join(directory, request.artifact.name)), { sha256: request.artifact.sha256, size: request.artifact.size }, 'Input artifact bytes changed.')
  return request
}

export async function downloadInputs(directory, pin, client = new NotarizationReader()) {
  mkdirSync(directory, { mode: 0o700 })
  const endpoint = `repos/${IDENTITY.repository}/releases/${pin.draftId}`
  const draft = client.get(endpoint)
  validateDraft(draft, pin)
  const run = client.get(`repos/${IDENTITY.repository}/actions/runs/${IDENTITY.preparationRunId}`)
  need(String(run.id) === IDENTITY.preparationRunId && run.run_number === 29 && run.run_attempt === 1 && run.head_sha === IDENTITY.sourceSha && run.head_branch === IDENTITY.sourceRef && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success' && run.path === '.github/workflows/direct-desktop-release-draft.yml', 'Exact build-1246 preparation run identity changed.')
  for (const asset of draft.assets) {
    const target = join(directory, asset.name)
    client.get(`repos/${IDENTITY.repository}/releases/assets/${asset.id}`, target)
    const digest = await fileHash(target)
    need(digest.size === asset.size && `sha256:${digest.sha256}` === asset.digest, 'Downloaded bytes differ from GitHub asset metadata.')
  }
  const after = client.get(endpoint)
  validateDraft(after, pin)
  assert.deepEqual(after.assets.map(asset => [asset.id, asset.name, asset.digest, asset.size]).sort(), draft.assets.map(asset => [asset.id, asset.name, asset.digest, asset.size]).sort(), 'Draft changed during download.')
  return loadRequest(directory, pin)
}

function native(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  need(result.status === 0, `Native verification failed: ${command}`)
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function codeHashes(app) {
  const result = {}
  for (const architecture of ['arm64', 'x86_64']) {
    const report = native('/usr/bin/codesign', ['-d', '--verbose=4', '--arch', architecture, app])
    need(/^TeamIdentifier=KRR35MWWHD$/m.test(report) && /^Identifier=com\.zhengyiluo\.AgentsDock$/m.test(report) && /^Authority=Developer ID Application:/m.test(report) && /^Timestamp=.+$/m.test(report) && /flags=.*\(.*runtime.*\)/.test(report), 'Expected hardened Developer ID application identity.')
    const digest = report.match(/^CDHash=([0-9a-f]{40})$/m)?.[1]
    need(digest, 'Missing architecture-specific CDHash.')
    result[architecture] = digest
  }
  return result
}

export function validateUpdaterConfig(config) {
  need(config && typeof config === 'object' && !Array.isArray(config) &&
    config.provider === 'github' && config.owner === 'ZhengyiLuo' &&
    config.repo === 'AgentsDock' && config.channel === 'beta',
  'Packaged updater must select the canonical public beta feed.')
}

export function verifyPackagedUpdater(resources, loadYaml) {
  const entries = readdirSync(resources)
  need(!entries.includes('disable-auto-update') && !entries.includes('adhoc-isolated-user-data'),
    'Release app must not disable updates or override isolated user data.')
  const bytes = regular(join(resources, 'app-update.yml'), 8192)
  if (!loadYaml) {
    // Same locked audit dependency used by the full release verifier; load it
    // only in the pre-secret native job after --frozen-lockfile installation.
    const store = join(ROOT, 'electron/node_modules/.pnpm')
    const versions = readdirSync(store).filter(name => /^js-yaml@[0-9]/.test(name))
    need(versions.length === 1, 'Expected one locked YAML audit dependency.')
    loadYaml = createRequire(import.meta.url)(join(store, versions[0], 'node_modules/js-yaml/index.js')).load
  }
  validateUpdaterConfig(loadYaml(bytes.toString('utf8')))
  return { updater: 'github:ZhengyiLuo/AgentsDock:beta', updaterConfigSha256: sha(bytes) }
}

function verifyApp(app, request, directory) {
  need(lstatSync(app).isDirectory() && realpathSync(app) === app, 'Expected a real AgentsDock.app directory.')
  verifyPackagedUpdater(join(app, 'Contents/Resources'))
  const info = join(app, 'Contents/Info.plist')
  for (const [key, expected] of Object.entries({ CFBundleIdentifier: 'com.zhengyiluo.AgentsDock', CFBundleShortVersionString: IDENTITY.version, CFBundleVersion: IDENTITY.buildNumber })) need(native('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info]) === expected, `Packaged ${key} changed.`)
  native('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  assert.deepEqual(codeHashes(app), request.appCDHashes, 'Signed app CDHashes changed.')
  let machos = 0
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name)
      if (entry.isDirectory()) walk(filename)
      else if (entry.isFile() && native('/usr/bin/file', ['-b', filename]).includes('Mach-O')) {
        assert.deepEqual(native('/usr/bin/lipo', ['-archs', filename]).split(/\s+/).sort(), ['arm64', 'x86_64'], 'Every packaged Mach-O must be universal.')
        machos++
      }
    }
  }
  walk(join(app, 'Contents'))
  need(machos > 0, 'No packaged Mach-O binaries.')
  native(join(ROOT, 'scripts/audit_electron_bundle.sh'), [app], { ...process.env, AGENTSDOCK_COORDINATED_MANIFEST: join(directory, MANIFEST), AGENTSDOCK_COORDINATED_SIGNATURE: join(directory, SIGNATURE) })
  // The DMG must already contain the stapled app from pass one.
  if (request.stage === 'dmg') {
    native('/usr/bin/xcrun', ['stapler', 'validate', app])
    native('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
  }
}

async function verifyNative(directory, pin) {
  need(process.platform === 'darwin', 'Native notarization validation requires macOS.')
  const request = await loadRequest(directory, pin)
  const input = join(directory, request.artifact.name)
  if (pin.stage === 'app') {
    native('python3', [join(ROOT, 'scripts/verify_electron_app_zip.py'), input])
    const unpacked = join(directory, 'unpacked')
    mkdirSync(unpacked, { mode: 0o700 })
    native('/usr/bin/ditto', ['-x', '-k', input, unpacked])
    assert.deepEqual(readdirSync(unpacked), ['AgentsDock.app'], 'App submission ZIP must contain only AgentsDock.app.')
    verifyApp(join(unpacked, 'AgentsDock.app'), request, directory)
  } else {
    native('/usr/bin/codesign', ['--verify', '--strict', input])
    const report = native('/usr/bin/codesign', ['-d', '--verbose=4', input])
    need(/^TeamIdentifier=KRR35MWWHD$/m.test(report) && /^Authority=Developer ID Application:/m.test(report) && /^Timestamp=.+$/m.test(report), 'Outer DMG must have the expected timestamped Developer ID signature.')
    const mount = join(directory, 'mounted')
    mkdirSync(mount, { mode: 0o700 })
    native('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, input])
    try { verifyApp(join(mount, 'AgentsDock.app'), request, directory) }
    finally { native('/usr/bin/hdiutil', ['detach', mount]) }
  }
  await loadRequest(directory, pin)
  writeFileSync(join(directory, 'verified-input.json'), `${JSON.stringify({ requestSha256: pin.requestSha256, inputSha256: pin.inputSha256, appCDHashes: request.appCDHashes })}\n`, { flag: 'wx', mode: 0o600 })
}

export function sanitizedReceipt(request, pin, submission, log, logBytes, env = process.env) {
  validateRunner(pin, env)
  need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submission.id || ''), 'Missing valid Apple submission ID.')
  need(log.jobId?.toLowerCase() === submission.id.toLowerCase() && log.sha256 === pin.inputSha256 && log.archiveFilename === request.artifact.name, 'Apple log does not match the exact submitted artifact.')
  need(['Accepted', 'Invalid', 'Rejected'].includes(log.status) && submission.status === log.status, 'Incomplete or inconsistent notarization result.')
  const issues = log.issues ?? []
  need(Array.isArray(issues) && issues.length <= 1000, 'Invalid Apple issue list.')
  const safeIssues = issues.map(issue => {
    need(['warning', 'error'].includes(issue.severity), 'Unknown Apple issue severity.')
    need(issue.code === null || issue.code === undefined || Number.isSafeInteger(issue.code), 'Unexpected Apple issue code.')
    need(issue.architecture === undefined || issue.architecture === null || ['arm64', 'x86_64'].includes(issue.architecture), 'Unexpected Apple issue architecture.')
    need(typeof issue.message === 'string' && issue.message.length <= 16384 && typeof issue.path === 'string' && issue.path.length <= 16384, 'Invalid Apple issue text.')
    // Do not export raw Apple-controlled paths/messages or credential diagnostics.
    return { severity: issue.severity, code: issue.code ?? null, architecture: issue.architecture ?? null, messageSha256: sha(issue.message), pathSha256: sha(issue.path) }
  })
  const accepted = log.status === 'Accepted' && log.statusCode === 0 && !safeIssues.some(issue => issue.severity === 'error')
  return { ...IDENTITY, schema: 'agentsdock-macos-notarization-receipt-v1', kind: 'frozen-macos-notarization', stage: pin.stage, draftId: pin.draftId,
    requestSha256: pin.requestSha256, inputSha256: pin.inputSha256, appCDHashes: request.appCDHashes,
    manifestSha256: request.manifestSha256, signatureSha256: request.signatureSha256,
    workflowSha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    submissionId: submission.id.toLowerCase(), status: log.status, accepted, logSha256: sha(logBytes), issues: safeIssues,
    scope: 'Notarization only; no publication, package rebuild, or application execution.' }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'create-request') {
    need(args.length === 6 && ['app', 'dmg'].includes(args[0]), 'Usage: create-request app|dmg INPUT MANIFEST SIGNATURE SIGNED_APP OUTPUT_JSON')
    const [stage, input, manifest, signature, app, output] = args
    const request = { ...IDENTITY, stage, artifact: { name: artifactName(stage), ...await fileHash(resolve(input)) },
      manifestSha256: sha(regular(resolve(manifest), 8192)), signatureSha256: sha(regular(resolve(signature), 64)), appCDHashes: codeHashes(resolve(app)) }
    validateRequest(request, { stage, inputSha256: request.artifact.sha256 }, regular(resolve(manifest), 8192), regular(resolve(signature), 64), regular(join(ROOT, 'server/release-public-key.pem'), 4096))
    writeFileSync(resolve(output), `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return
  }
  const pin = parsePin(process.env.NOTARIZE_PIN)
  validateRunner(pin)
  if (command === 'validate-dispatch') { need(args.length === 0, 'Unexpected validation arguments.'); return }
  need(['download', 'verify', 'receipt'].includes(command) && args.length === 1, 'Usage: notarize_frozen_macos.mjs download|verify|receipt DIRECTORY')
  const directory = resolve(args[0])
  if (command === 'download') await downloadInputs(directory, pin)
  else if (command === 'verify') await verifyNative(directory, pin)
  else {
    const request = await loadRequest(directory, pin)
    assert.deepEqual(JSON.parse(regular(join(directory, 'verified-input.json'), 16384)), { requestSha256: pin.requestSha256, inputSha256: pin.inputSha256, appCDHashes: request.appCDHashes }, 'Missing native verification seal.')
    const logBytes = regular(join(directory, 'private/notary-log.json'), 4 * 1024 * 1024)
    const receipt = sanitizedReceipt(request, pin, JSON.parse(regular(join(directory, 'private/submission.json'), 16384)), JSON.parse(logBytes), logBytes)
    writeFileSync(join(directory, 'notary-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    need(receipt.accepted, 'Apple did not accept the pinned notarization submission; see sanitized receipt.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Frozen notarization failed closed; no raw diagnostics are exported.\n'); process.exitCode = 1 })
