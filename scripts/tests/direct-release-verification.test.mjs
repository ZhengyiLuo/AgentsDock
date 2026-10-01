import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectedAssets } from '../direct-release-mirror.mjs'
import { CANONICAL_REPOSITORY, NATIVE_JOBS, VerificationGitHubClient, createVerificationReceipt, inspectCanonicalDraft } from '../direct-release-verification.mjs'
import { signedFixture } from './coordinated-release-fixture.mjs'

const SHA = 'a'.repeat(40), SEAL = 'b'.repeat(64)
const VERSION = '1.0.0-beta.1', TRACK = 'beta', REF = 'release/1.0'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const workflow = readFileSync(new URL('../../.github/workflows/direct-desktop-release-publish.yml', import.meta.url), 'utf8')

function fixture(t, version = VERSION, track = TRACK) {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-verification-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const base = signedFixture()
  const signed = signedFixture({ ...base.descriptor, version, track, prerelease: track === 'beta',
    npm: { ...base.descriptor.npm, version }, archive: { ...base.descriptor.archive, name: `server-${version}.tgz`, url: `https://registry.npmjs.org/@agentsdock/server/-/server-${version}.tgz` } })
  const files = new Map(expectedAssets(version, track, true).filter(name => name !== 'SHA256SUMS').map(name => [name, Buffer.from(`synthetic:${name}`)]))
  files.set('agents-server-npm-manifest.json', signed.bytes)
  files.set('agents-server-npm-manifest.sig', signed.signature)
  files.set('SHA256SUMS', Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join('\n') + '\n'))
  const release = { tag_name: `v${version}`, draft: true, prerelease: track === 'beta', target_commitish: SHA,
    body: `Source repository: ${CANONICAL_REPOSITORY}\nSource commit: ${SHA}\nSource ref: ${REF}\nUpdate track: ${track}\nWindows signing: unsigned\nCoordinated updates: npm-v1\n`,
    assets: [...files].map(([name, bytes], index) => ({ name, size: bytes.length, id: index + 1, state: 'uploaded', digest: `sha256:${hash(bytes)}` })) }
  const reads = []
  const client = {
    release(repo, tag) { reads.push(repo); assert.equal(repo, CANONICAL_REPOSITORY); assert.equal(tag, release.tag_name); return structuredClone(release) },
    verifySourceTag(value, sha) { assert.equal(value.target_commitish, sha, 'wrong source tag') },
    download(repo, tag, target, pattern) {
      reads.push(repo); assert.equal(repo, CANONICAL_REPOSITORY); assert.equal(tag, release.tag_name)
      for (const [name, bytes] of files) if (!pattern || pattern === name) writeFileSync(join(target, name), bytes)
    },
    create() { assert.fail('verification must not create') },
    publish() { assert.fail('verification must not publish') },
  }
  return { directory, files, release, reads, client, publicKey: signed.identity.publicKey,
    options: { verificationOnly: 'true', version, track, expectedSourceSha: SHA, expectedManifestSha256: hash(files.get('SHA256SUMS')), assets: join(directory, 'replay'), allowUnsignedWindows: 'true' } }
}

function receiptFixture() {
  const options = { verificationOnly: 'true', version: VERSION, track: TRACK, expectedSourceSha: SHA, expectedManifestSha256: SEAL,
    workflowSha: 'c'.repeat(40), workflowRef: `${CANONICAL_REPOSITORY}/.github/workflows/direct-desktop-release-publish.yml@refs/heads/${REF}`, runId: '123', runAttempt: '2' }
  const needs = Object.fromEntries(['inspect-draft', ...NATIVE_JOBS].map(job => [job, { result: 'success', outputs: { manifest_sha256: SEAL } }]))
  Object.assign(needs['inspect-draft'].outputs, { source_sha: SHA, source_ref: REF, coordinated_updates: 'true', windows_signing_policy: 'allow-unsigned' })
  return { options, needs }
}

test('reads only the canonical draft and verifies its exact complete coordinated assets', async t => {
  const f = fixture(t)
  const accepted = await inspectCanonicalDraft(f.options, f)
  assert.equal(accepted.manifestSha256, f.options.expectedManifestSha256)
  assert.equal(readdirSync(f.options.assets).length, 16)
  assert.ok(f.reads.length > 0 && f.reads.every(repo => repo === CANONICAL_REPOSITORY))
})

test('verification rejects wrong source, wrong seal, absent pins and invalid mode', async t => {
  for (const [patch, error] of [
    [{ expectedSourceSha: 'd'.repeat(40) }, /sourceSha changed/],
    [{ expectedManifestSha256: 'd'.repeat(64) }, /manifest changed/],
    [{ expectedSourceSha: '' }, /expected source SHA/],
    [{ expectedManifestSha256: undefined }, /expected full checksum/],
    [{ verificationOnly: 'false' }, /verification-only=true/],
    [{ verificationOnly: 'publish' }, /verification-only=true/],
    [{ allowUnsignedWindows: 'yes' }, /explicit unsigned/],
  ]) {
    const f = fixture(t)
    await assert.rejects(inspectCanonicalDraft({ ...f.options, ...patch }, f), error)
  }
})

test('verification rejects published, wrong-tag, incomplete and tampered drafts', async t => {
  for (const [change, error] of [
    [f => { f.release.draft = false }, /existing canonical draft/],
    [f => { f.release.target_commitish = 'main' }, /wrong source tag/],
    [f => { f.release.assets.pop() }, /incomplete or conflicting/],
    [f => { f.files.set(expectedAssets(VERSION, TRACK, true)[0], Buffer.from('tampered')) }, /Checksum mismatch/],
    [f => { f.release.body = f.release.body.replace(REF, 'feature/unreviewed') }, /reviewed release branch/],
  ]) {
    const f = fixture(t); change(f)
    await assert.rejects(inspectCanonicalDraft(f.options, f), error)
  }
})

test('stable unsigned verification retains the explicit policy gate', async t => {
  const f = fixture(t, '1.0.9', 'stable')
  await assert.rejects(inspectCanonicalDraft({ ...f.options, allowUnsignedWindows: 'false' }, f), /allow_unsigned_windows/)
  await inspectCanonicalDraft(f.options, f)
})

test('verification client refuses mutation commands and noncanonical reads before execution', () => {
  const calls = [], client = new VerificationGitHubClient((_command, args) => { calls.push(args); return '{}' })
  for (const args of [
    ['api', `repos/${CANONICAL_REPOSITORY}/releases`, '--method', 'POST'],
    ['api', `repos/${CANONICAL_REPOSITORY}/releases/tags/v1.0.9`, '-X', 'DELETE'],
    ['api', 'repos/ZhengyiLuo/AgentsDock-Releases/releases/tags/v1.0.9'],
    ['release', 'edit', 'v1.0.9', '--repo', CANONICAL_REPOSITORY, '--draft=false'],
    ['release', 'create', 'v1.0.9'],
    ['release', 'download', 'v1.0.9', '--repo', 'other/repo', '--dir', '/tmp/replay'],
  ]) assert.throws(() => client.run(args), /only canonical draft GET/)
  assert.equal(calls.length, 0)
  client.run(['api', `repos/${CANONICAL_REPOSITORY}/releases/tags/v1.0.9`])
  client.run(['api', '--paginate', '--slurp', `repos/${CANONICAL_REPOSITORY}/releases?per_page=100`])
  client.download(CANONICAL_REPOSITORY, 'v1.0.9', '/tmp/replay', 'SHA256SUMS')
  client.download(CANONICAL_REPOSITORY, 'v1.0.9', '/tmp/replay')
  assert.equal(calls.length, 4)
})

test('receipt binds all five real successful job seals and workflow provenance without acceptance claims', () => {
  const { options, needs } = receiptFixture()
  const receipt = createVerificationReceipt(options, needs)
  assert.equal(receipt.sourceSha, SHA)
  assert.equal(receipt.manifestSha256, SEAL)
  assert.equal(receipt.workflowSha, options.workflowSha)
  assert.equal(receipt.runId, '123')
  assert.equal(receipt.runAttempt, '2')
  assert.equal(Object.keys(receipt.jobs).length, 5)
  assert.equal('releaseAcceptance' in receipt, false)
  assert.equal('publicationEligible' in receipt, false)
})

test('receipt refuses failed, skipped, missing jobs and any mismatched platform seal', () => {
  for (const job of ['inspect-draft', ...NATIVE_JOBS]) {
    for (const result of ['failure', 'skipped', 'cancelled', undefined]) {
      const { options, needs } = receiptFixture(); needs[job].result = result
      assert.throws(() => createVerificationReceipt(options, needs), /did not succeed/)
    }
    const f = receiptFixture(); f.needs[job].outputs.manifest_sha256 = 'd'.repeat(64)
    assert.throws(() => createVerificationReceipt(f.options, f.needs), /seal mismatch/)
    const missing = receiptFixture(); delete missing.needs[job]
    assert.throws(() => createVerificationReceipt(missing.options, missing.needs), /exactly four native jobs/)
  }
})

test('receipt refuses wrong pins, invalid mode, source, workflow identity or signing policy', () => {
  for (const patch of [
    { verificationOnly: 'false' }, { expectedSourceSha: '' }, { expectedManifestSha256: '' },
    { expectedSourceSha: 'd'.repeat(40) }, { workflowSha: '' }, { runId: '0' }, { runAttempt: '' },
    { workflowRef: `${CANONICAL_REPOSITORY}/.github/workflows/direct-desktop-release-publish.yml@refs/heads/main` },
  ]) {
    const { options, needs } = receiptFixture()
    assert.throws(() => createVerificationReceipt({ ...options, ...patch }, needs))
  }
  const f = receiptFixture(); f.needs['inspect-draft'].outputs.windows_signing_policy = 'ignored'
  assert.throws(() => createVerificationReceipt(f.options, f.needs), /signing policy/)
})

test('CLI exposes no publish mode and requires verification pins before network reads', () => {
  for (const args of [['publish'], ['inspect', '--verification-only', 'false'], ['inspect', '--verification-only', 'true']]) {
    const result = spawnSync(process.execPath, [new URL('../direct-release-verification.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Usage:|verification-only=true|expected source SHA/)
  }
})

test('workflow keeps normal publishing and verification-only on the same four unchanged native jobs', () => {
  const section = name => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0]
  const inspect = section('inspect-draft'), publish = section('publish'), receipt = section('verification-receipt')
  assert.match(workflow, /verification_only:\n[\s\S]*?default: false/)
  assert.match(inspect, /GH_TOKEN: \$\{\{ inputs\.verification_only && github\.token \|\| secrets\.AGENTSDOCK_RELEASE_TOKEN \}\}/)
  assert.match(inspect, /if \[\[ "\$VERIFICATION_ONLY" = true \]\]; then[\s\S]*direct-release-verification\.mjs inspect[\s\S]*else[\s\S]*direct-release-mirror\.mjs inspect/)
  assert.match(inspect, /--expected-source-sha "\$EXPECTED_SOURCE_SHA"/)
  assert.match(inspect, /--expected-manifest-sha256 "\$EXPECTED_MANIFEST_SHA256"/)
  for (const body of [publish, receipt]) for (const job of ['inspect-draft', ...NATIVE_JOBS]) assert.ok(body.includes(`      - ${job}\n`))
  assert.match(publish, /^    if: .* && !inputs\.verification_only$/m)
  assert.match(publish, /GH_TOKEN: \$\{\{ secrets\.AGENTSDOCK_RELEASE_TOKEN \}\}/)
  assert.match(publish, /platform verifiers observed different checksum manifests/)
  assert.match(receipt, /^    if: .* && inputs\.verification_only$/m)
  assert.match(receipt, /DIRECT_RELEASE_VERIFICATION_NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
  assert.match(receipt, /--workflow-sha "\$GITHUB_WORKFLOW_SHA" --workflow-ref "\$GITHUB_WORKFLOW_REF"/)
  assert.match(receipt, /retention-days: 14/)
  assert.doesNotMatch(receipt, /direct-release-mirror|secrets\.|GH_TOKEN|contents: write/)
  assert.match(section('verify-native-migration'), /^    if: .* !inputs\.verification_only /m)
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1)
  assert.match(inspect, /^    permissions:\n      contents: write$/m)
  for (const job of NATIVE_JOBS) {
    const body = section(job)
    assert.match(body, /needs: inspect-draft/)
    assert.match(body, /ref: \$\{\{ needs\.inspect-draft\.outputs\.source_sha \}\}/)
    assert.match(body, /name: AgentsDock-\$\{\{ inputs\.version \}\}-draft-replay/)
    assert.match(body, /id: seal/)
    assert.doesNotMatch(body, /verification_only|continue-on-error/)
  }
})
