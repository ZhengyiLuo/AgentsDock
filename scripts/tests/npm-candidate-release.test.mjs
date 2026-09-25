import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { signedFixture } from './coordinated-release-fixture.mjs'
import { COORDINATED_ASSETS } from '../coordinated-release.mjs'
import { npmCandidateTag, stageNpmCandidate, verifyNpmCandidate } from '../npm-candidate-release.mjs'

function fixture(t) {
  const f = signedFixture(), directory = mkdtempSync(join(tmpdir(), 'agentsdock-npm-handoff-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, COORDINATED_ASSETS[0]), f.bytes)
  writeFileSync(join(directory, COORDINATED_ASSETS[1]), f.signature)
  writeFileSync(join(directory, f.descriptor.archive.name), f.payload)
  return { ...f, options: { ...f.identity, assets: directory, sourceRef: 'release/1.0' } }
}

class CandidateGitHub {
  constructor() { this.value = null; this.files = new Map(); this.writes = [] }
  release(repo, tag) { assert.equal(repo, 'ZhengyiLuo/AgentsDock'); if (this.value) assert.equal(tag, this.value.tag_name); return structuredClone(this.value) }
  verifySourceTag(release, sha) { assert.equal(release.target_commitish, sha) }
  download(repo, tag, directory) { for (const [name, bytes] of this.files) writeFileSync(join(directory, name), bytes) }
  run(args) {
    this.writes.push(args)
    assert.deepEqual(args.slice(0, 2), ['release', 'create'])
    assert.ok(args.includes('--draft')); assert.ok(args.includes('--prerelease')); assert.ok(args.includes('--latest=false'))
    const names = args.slice(3, args.indexOf('--repo'))
    this.files = new Map(names.map(path => [basename(path), readFileSync(path)]))
    this.value = { tag_name: args[2], draft: true, target_commitish: args[args.indexOf('--target') + 1], body: args[args.indexOf('--notes') + 1], assets: names.map(path => ({ name: basename(path) })) }
  }
}

test('npm candidate stages exactly three source-pinned draft assets once without npm or release publication', async t => {
  const f = fixture(t), client = new CandidateGitHub()
  const verified = await verifyNpmCandidate(f.options.assets, f.options, f.identity.publicKey)
  assert.equal(verified.names.length, 3)
  const result = await stageNpmCandidate(f.options, { client, publicKey: f.identity.publicKey })
  assert.equal(result.tag, npmCandidateTag(f.identity.version))
  assert.equal(result.manifestSha256, verified.manifestSha256)
  assert.equal(client.writes.length, 1)
  await stageNpmCandidate(f.options, { client, publicKey: f.identity.publicKey })
  assert.equal(client.writes.length, 1)
  assert.match(client.value.body, /Candidate type: npm-server-v1/)
  assert.match(client.value.body, new RegExp(`Npm manifest SHA256: ${verified.manifestSha256}`))
})

test('refuses extra files, altered archive, signature, source or track before external writes', async t => {
  for (const mutation of ['extra', 'archive', 'signature', 'source', 'track', 'source-ref']) {
    const f = fixture(t), client = new CandidateGitHub()
    if (mutation === 'extra') writeFileSync(join(f.options.assets, 'SHA256SUMS'), 'not allowed')
    if (mutation === 'archive') writeFileSync(join(f.options.assets, f.descriptor.archive.name), Buffer.alloc(f.payload.length))
    if (mutation === 'signature') writeFileSync(join(f.options.assets, COORDINATED_ASSETS[1]), Buffer.alloc(64))
    if (mutation === 'source') f.options.sourceSha = 'b'.repeat(40)
    if (mutation === 'track') f.options.track = 'stable'
    if (mutation === 'source-ref') f.options.sourceRef = 'release/../main'
    await assert.rejects(stageNpmCandidate(f.options, { client, publicKey: f.identity.publicKey }))
    assert.equal(client.writes.length, 0)
  }
})

test('never repairs, replaces or republishes an existing conflicting candidate', async t => {
  for (const mutation of ['published', 'source', 'body', 'missing', 'bytes']) {
    const f = fixture(t), client = new CandidateGitHub()
    await stageNpmCandidate(f.options, { client, publicKey: f.identity.publicKey })
    if (mutation === 'published') client.value.draft = false
    if (mutation === 'source') client.value.target_commitish = 'b'.repeat(40)
    if (mutation === 'body') client.value.body += 'Source commit: changed\n'
    if (mutation === 'missing') client.value.assets.pop()
    if (mutation === 'bytes') client.files.set(f.descriptor.archive.name, Buffer.alloc(f.payload.length))
    await assert.rejects(stageNpmCandidate(f.options, { client, publicKey: f.identity.publicKey }))
    assert.equal(client.writes.length, 1)
  }
})

test('native preparation consumes signed inputs without provisioning or using a server signing key', () => {
  assert.equal(existsSync(new URL('../../.github/workflows/server-npm-candidate.yml', import.meta.url)), false)
  const text = readFileSync(new URL('../../.github/workflows/direct-desktop-release-draft.yml', import.meta.url), 'utf8')
  assert.match(text, /coordinated_manifest_base64:/)
  assert.match(text, /coordinated_signature_base64:/)
  assert.match(text, /cmp server\/release-public-key.pem release-source\/server\/release-public-key.pem/)
  assert.match(text, /node scripts\/coordinated-release.mjs prepare/)
  assert.doesNotMatch(text, /AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64|environment: npm-release|pkeyutl -sign|package_npm_release\.py|npm publish|npm login/)
})
