import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { IDENTITY, NotarizationReader, parsePin, sanitizedReceipt, validateDraft, validateRequest, validateRunner } from '../notarize_frozen_macos.mjs'
import { signedFixture } from './coordinated-release-fixture.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const helper = readFileSync(new URL('../notarize_frozen_macos.mjs', import.meta.url), 'utf8')
const pinFixture = () => ({ stage: 'app', draftId: 402733638, requestSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64), harnessSha: 'c'.repeat(40) })
function environment(pin = pinFixture()) {
  const text = JSON.stringify(pin)
  return { NOTARIZE_PIN: text, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: IDENTITY.repository,
    GITHUB_REF: 'refs/heads/release/1.0.10-beta.2-harness', GITHUB_SHA: pin.harnessSha,
    GITHUB_WORKFLOW_REF: `${IDENTITY.repository}/.github/workflows/ci.yml@refs/heads/release/1.0.10-beta.2-harness`,
    GITHUB_RUN_ID: '40000000001', GITHUB_RUN_ATTEMPT: '1',
    NOTARIZE_OTHER_INPUTS: JSON.stringify({ npm_native_validation: false, npm_candidate_tag: '', npm_manifest_sha256: '', npm_source_sha: '',
      candidate_replay: false, candidate_server_rollback: false, candidate_tag: '', candidate_receipt_sha256: '', candidate_bundle_sha256: '', notarize: text }) }
}
function fixture(stage = 'app') {
  const base = signedFixture()
  const signed = signedFixture({ ...base.descriptor, version: IDENTITY.version, track: 'beta', prerelease: true, commit: IDENTITY.sourceSha,
    npm: { ...base.descriptor.npm, version: IDENTITY.version },
    archive: { ...base.descriptor.archive, name: `server-${IDENTITY.version}.tgz`, url: `https://registry.npmjs.org/@agentsdock/server/-/server-${IDENTITY.version}.tgz` } })
  const pin = { ...pinFixture(), stage }
  const request = { ...IDENTITY, stage, artifact: { name: `notary-input.${stage === 'app' ? 'zip' : 'dmg'}`, sha256: pin.inputSha256, size: 1000 },
    manifestSha256: hash(signed.bytes), signatureSha256: hash(signed.signature), appCDHashes: { arm64: 'd'.repeat(40), x86_64: 'e'.repeat(40) } }
  const names = ['notary-request.json', request.artifact.name, 'agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']
  const draft = { id: pin.draftId, draft: true, prerelease: true, tag_name: `notarize-v${IDENTITY.version}-${stage}`, target_commitish: IDENTITY.sourceSha,
    assets: names.map((name, index) => ({ id: index + 1, name, state: 'uploaded', size: 100, digest: `sha256:${'f'.repeat(64)}` })) }
  return { pin, request, signed, draft }
}
const checkRequest = f => validateRequest(f.request, f.pin, f.signed.bytes, f.signed.signature, f.signed.identity.publicKey)

test('only complete independent app/DMG pins are accepted', () => {
  for (const stage of ['app', 'dmg']) assert.equal(parsePin(JSON.stringify({ ...pinFixture(), stage })).stage, stage)
  for (const patch of [{ stage: 'publish' }, { draftId: '402733638' }, { draftId: -1 }, { requestSha256: '' }, { inputSha256: 'A'.repeat(64) }, { harnessSha: 'main' }, { sourceSha: IDENTITY.sourceSha }]) {
    assert.throws(() => parsePin(JSON.stringify({ ...pinFixture(), ...patch })))
  }
  assert.throws(() => parsePin(' '.repeat(3000)))
})

test('runner identity requires exact manual canonical harness SHA and exclusive inputs', () => {
  const pin = pinFixture(), env = environment(pin)
  validateRunner(pin, env)
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'fork/AgentsDock' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: 'a'.repeat(40) }, { GITHUB_WORKFLOW_REF: 'other' }, { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' }]) assert.throws(() => validateRunner(pin, { ...env, ...patch }))
  for (const [key, value] of Object.entries(JSON.parse(env.NOTARIZE_OTHER_INPUTS))) {
    if (key === 'notarize') continue
    const other = JSON.parse(env.NOTARIZE_OTHER_INPUTS)
    other[key] = typeof value === 'boolean' ? true : 'unexpected'
    assert.throws(() => validateRunner(pin, { ...env, NOTARIZE_OTHER_INPUTS: JSON.stringify(other) }), /mutually exclusive/)
  }
  assert.throws(() => validateRunner(pin, { ...env, NOTARIZE_OTHER_INPUTS: '{}' }))
})

test('GitHub may omit only optional empty strings, never booleans or unknown operation inputs', () => {
  const pin = pinFixture(), env = environment(pin)
  const actual = { npm_native_validation: false, candidate_replay: false,
    candidate_server_rollback: false, notarize: env.NOTARIZE_PIN }
  validateRunner(pin, { ...env, NOTARIZE_OTHER_INPUTS: JSON.stringify(actual) })
  for (const patch of [{ candidate_tag: 'unexpected' }, { candidate_tag: null },
    { candidate_tag: false }, { arbitrary: '' }, { npm_native_validation: undefined }]) {
    assert.throws(() => validateRunner(pin, { ...env, NOTARIZE_OTHER_INPUTS: JSON.stringify({ ...actual, ...patch }) }))
  }
})

test('request verifies frozen release, signed descriptor and both CDHashes in either pass', () => {
  for (const stage of ['app', 'dmg']) checkRequest(fixture(stage))
  for (const change of [
    f => { f.request.sourceSha = 'a'.repeat(40) }, f => { f.request.sourceRef = 'main' },
    f => { f.request.version = '1.0.10-beta.3' }, f => { f.request.buildNumber = '1247' },
    f => { f.request.preparationRunId = '37159258615' }, f => { f.request.track = 'stable' },
    f => { f.request.stage = 'dmg' }, f => { f.request.artifact.name = '../notary-input.zip' },
    f => { f.request.artifact.sha256 = 'f'.repeat(64) }, f => { f.request.artifact.size = 0 },
    f => { f.request.artifact.size = 3 * 1024 ** 3 }, f => { delete f.request.appCDHashes.arm64 },
    f => { f.request.appCDHashes.x86_64 = 'F'.repeat(40) }, f => { f.request.manifestSha256 = 'a'.repeat(64) },
    f => { f.request.signatureSha256 = 'a'.repeat(64) }, f => { f.request.arbitrary = true },
  ]) { const f = fixture(); change(f); assert.throws(() => checkRequest(f)) }
})

test('descriptor signature and exact frozen source cannot be substituted', () => {
  const f = fixture()
  const changed = signedFixture({ ...f.signed.descriptor, commit: 'f'.repeat(40) })
  f.signed = changed
  f.request.manifestSha256 = hash(changed.bytes)
  f.request.signatureSha256 = hash(changed.signature)
  assert.throws(() => checkRequest(f), /Descriptor source/)
  const bad = fixture()
  bad.signed.signature[0] ^= 1
  bad.request.signatureSha256 = hash(bad.signed.signature)
  assert.throws(() => checkRequest(bad), /signature is invalid/)
})

test('only the exact private draft and four uploaded bounded assets are accepted', () => {
  for (const stage of ['app', 'dmg']) { const f = fixture(stage); validateDraft(f.draft, f.pin) }
  for (const change of [
    f => { f.draft.draft = false }, f => { f.draft.prerelease = false }, f => { f.draft.id++ },
    f => { f.draft.tag_name = 'v1.0.9' }, f => { f.draft.target_commitish = 'main' },
    f => { f.draft.assets.pop() }, f => { f.draft.assets.push({ ...f.draft.assets[0] }) },
    f => { f.draft.assets[0].digest = null }, f => { f.draft.assets[0].state = 'new' },
    f => { f.draft.assets[0].size = 20000 }, f => { f.draft.assets[0].id = f.draft.assets[1].id },
  ]) { const f = fixture(); change(f); assert.throws(() => validateDraft(f.draft, f.pin)) }
})

test('GitHub reader exposes only fixed canonical GETs; never release mutation or external URLs', t => {
  const calls = []
  const reader = new NotarizationReader((command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: '{}' } })
  reader.get(`repos/${IDENTITY.repository}/releases/123`)
  reader.get(`repos/${IDENTITY.repository}/actions/runs/${IDENTITY.preparationRunId}`)
  const temp = mkdtempSync(join(tmpdir(), 'notary-reader-test-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  reader.get(`repos/${IDENTITY.repository}/releases/assets/456`, join(temp, 'input'))
  assert.ok(calls.every(call => call.command === 'gh' && call.args[0] === 'api' && call.args[1] === '--method' && call.args[2] === 'GET'))
  const count = calls.length
  for (const endpoint of ['https://example.com/input', `repos/${IDENTITY.repository}/releases`, `repos/${IDENTITY.repository}/releases/123?method=DELETE`, 'repos/fork/AgentsDock/releases/123', `repos/${IDENTITY.repository}/actions/runs/1`]) assert.throws(() => reader.get(endpoint))
  assert.throws(() => reader.get(`repos/${IDENTITY.repository}/releases/assets/456`))
  assert.throws(() => reader.get(`repos/${IDENTITY.repository}/releases/123`, join(temp, 'metadata')))
  assert.equal(calls.length, count)
})

function receiptFixture() {
  const f = fixture()
  const submission = { id: '12345678-1234-1234-1234-123456789abc', status: 'Accepted', message: 'PRIVATE_SUBMISSION_DIAGNOSTIC', path: '/private/local/input' }
  const log = { jobId: submission.id, sha256: f.pin.inputSha256, archiveFilename: f.request.artifact.name, status: 'Accepted', statusCode: 0, issues: null, privateValue: 'MUST_NOT_EXPORT' }
  return { ...f, submission, log, env: environment(f.pin) }
}
const makeReceipt = f => sanitizedReceipt(f.request, f.pin, f.submission, f.log, Buffer.from(JSON.stringify(f.log)), f.env)

test('successful receipt seals accepted Apple input and allowlists identity without raw diagnostics', () => {
  const f = receiptFixture(), result = makeReceipt(f)
  assert.equal(result.schema, 'agentsdock-macos-notarization-receipt-v1')
  assert.equal(result.accepted, true)
  assert.equal(result.inputSha256, f.pin.inputSha256)
  assert.equal(result.workflowSha, f.pin.harnessSha)
  assert.equal(result.sourceSha, IDENTITY.sourceSha)
  assert.equal(result.logSha256, hash(Buffer.from(JSON.stringify(f.log))))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|MUST_NOT_EXPORT|\/private\/local/)
})

test('mismatched or incomplete Apple submission can never produce an accepted receipt', () => {
  for (const change of [
    f => { f.log.sha256 = 'a'.repeat(64) }, f => { f.log.archiveFilename = 'different.zip' },
    f => { f.log.jobId = '87654321-1234-1234-1234-123456789abc' }, f => { f.submission.id = 'invalid' },
    f => { f.log.status = 'In Progress' }, f => { f.submission.status = 'Invalid' },
  ]) { const f = receiptFixture(); change(f); assert.throws(() => makeReceipt(f)) }
  const f = receiptFixture()
  f.log.statusCode = 4000
  assert.equal(makeReceipt(f).accepted, false)
})

test('Apple rejection and warning issues are reduced to severity/code/architecture and hashes', () => {
  const f = receiptFixture()
  f.log.issues = [{ severity: 'warning', code: null, architecture: 'arm64', path: '/Users/private/person/SECRET_PATH', message: 'SECRET_VALUE and private diagnostics', arbitrary: 'PRIVATE' }]
  let result = makeReceipt(f)
  assert.equal(result.accepted, true)
  assert.deepEqual(Object.keys(result.issues[0]).sort(), ['architecture', 'code', 'messageSha256', 'pathSha256', 'severity'])
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|\/Users\/private/)
  f.submission.status = f.log.status = 'Invalid'
  f.log.statusCode = 4000
  f.log.issues[0].severity = 'error'
  result = makeReceipt(f)
  assert.equal(result.accepted, false)
  f.log.issues[0].architecture = 'PRIVATE_ARCH'
  assert.throws(() => makeReceipt(f))
})

test('notarization dispatch skips every unrelated job and uses exactly ten manual inputs', () => {
  const inputs = workflow.split('\npermissions:')[0].match(/^      [a-z0-9_]+:$/gm)
  assert.equal(inputs.length, 10)
  const sections = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n  ([a-z][a-z0-9-]*):\n/)
  const jobs = new Map()
  for (let index = 1; index < sections.length; index += 2) jobs.set(sections[index], sections[index + 1])
  assert.equal(jobs.size, 9)
  for (const [name, body] of jobs) {
    const condition = body.match(/^    if: (.+)$/m)?.[1]
    assert.ok(condition?.includes('inputs.notarize'), `${name} must explicitly gate notarization mode`)
    if (name === 'notarize-frozen-macos') assert.match(condition, /inputs\.notarize != ''/)
    else assert.ok(condition.includes("inputs.notarize == ''") || condition.includes("!(github.event_name == 'workflow_dispatch'"), `${name} must skip notarization mode`)
  }
})

test('Apple secrets occur only in submit step, no private output is uploaded, cleanup is unconditional', () => {
  const job = workflow.split('\n  notarize-frozen-macos:\n')[1]
  assert.match(job, /environment: direct-production/)
  const beforeSubmit = job.split('      - id: submit\n')[0]
  const submit = job.split('      - id: submit\n')[1].split('      - name: Create allowlisted')[0]
  const afterSubmit = job.split('      - name: Create allowlisted')[1]
  assert.doesNotMatch(beforeSubmit + afterSubmit, /secrets\./)
  assert.equal((submit.match(/secrets\./g) || []).length, 3)
  assert.match(submit, /set \+x/)
  assert.match(submit, /trap 'rm -f "\$KEY_PATH"' EXIT/)
  assert.match(submit, /--wait --timeout 30m --output-format json/)
  assert.match(submit, /> "\$PRIVATE_DIR\/submission\.json" 2> "\$PRIVATE_DIR\/submit-error\.txt"/)
  assert.match(afterSubmit, /Remove all private key material and raw Apple diagnostics\n        if: always\(\)/)
  assert.match(afterSubmit, /path: \$\{\{ runner.temp \}\}\/notary-input\/notary-receipt\.json/)
  assert.doesNotMatch(job, /MACOS_CERTIFICATE|AGENTSDOCK_RELEASE_TOKEN|gh release (?:create|upload|edit)|notarize_frozen_macos\.mjs publish/)
  assert.doesNotMatch(beforeSubmit, /--run|open -a|verify_electron_smoke/)
  assert.match(helper, /no raw diagnostics are exported/)
  assert.match(helper, /verify_electron_app_zip\.py/)
  assert.match(helper, /audit_electron_bundle\.sh/)
})
