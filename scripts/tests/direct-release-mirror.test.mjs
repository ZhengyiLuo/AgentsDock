import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { signedFixture } from './coordinated-release-fixture.mjs'
import { COORDINATED_ASSETS } from '../coordinated-release.mjs'
import { expectedAssets, GitHubClient, releaseIdentity, releaseTag, ReleaseMirror, REPOSITORIES, verifyAssets } from '../direct-release-mirror.mjs'

const SHA = 'a'.repeat(40)
const VERSION = '1.0.0-beta.1'
const TRACK = 'beta'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t, version = VERSION, track = TRACK) {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-mirror-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const names = expectedAssets(version, track).filter(name => name !== 'SHA256SUMS')
  const lines = names.map(name => {
    const bytes = Buffer.from(`synthetic:${name}`)
    writeFileSync(join(directory, name), bytes)
    return `${digest(bytes)}  ${name}`
  })
  writeFileSync(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return directory
}

class FakeGitHub {
  constructor() { this.entries = new Map(); this.writes = []; this.downloads = []; this.extraHistory = []; this.failPublish = null }
  release(repo, tag) {
    const release = this.entries.get(repo)?.release
    return release && (!tag || release.tag_name === tag) ? structuredClone(release) : null
  }
  history(repo) { return [...this.extraHistory, ...(this.entries.has(repo) ? [this.release(repo)] : [])] }
  download(repo, tag, directory, pattern) {
    assert.equal(tag, this.entries.get(repo).release.tag_name)
    this.downloads.push({ repo, pattern })
    for (const [name, bytes] of this.entries.get(repo).bytes) if (!pattern || name === pattern) writeFileSync(join(directory, name), bytes)
  }
  create(repo, tag, directory, names, body, sourceSha) {
    assert.equal(this.entries.has(repo), false, 'must never overwrite a release')
    this.writes.push(['create', repo])
    this.entries.set(repo, {
      release: { tag_name: tag, draft: true, prerelease: false, body, target_commitish: repo === REPOSITORIES[0] ? sourceSha : 'main', assets: names.map((name, index) => ({ name, id: index + 1, state: 'uploaded', size: readFileSync(join(directory, name)).length, digest: `sha256:${digest(readFileSync(join(directory, name)))}` })) },
      bytes: new Map(names.map(name => [name, readFileSync(join(directory, name))]))
    })
  }
  publish(repo, tag, track) {
    assert.equal(tag, this.entries.get(repo).release.tag_name)
    if (repo === this.failPublish) throw new Error('synthetic publication interruption')
    this.writes.push(['publish', repo])
    Object.assign(this.entries.get(repo).release, { draft: false, prerelease: track === 'beta' })
  }
  verifySourceTag(release, sha) { assert.equal(release.target_commitish, sha, 'wrong public tag target') }
}

function options(assets, extra = {}) {
  return { version: VERSION, track: TRACK, sourceSha: SHA, sourceRef: 'release/1.0', windowsSigning: 'unsigned', assets, notes: 'Synthetic bridge.', ...extra }
}

async function staged(t, extra = {}) {
  const assets = fixture(t, extra.version ?? VERSION, extra.track ?? TRACK)
  const github = new FakeGitHub()
  const mirror = new ReleaseMirror(github)
  const accepted = await mirror.stage(options(assets, extra))
  return { github, mirror, assets, accepted }
}

test('creates canonical source-pinned draft and byte-identical legacy draft once', async t => {
  const { github, mirror, assets } = await staged(t)
  assert.deepEqual(github.writes, REPOSITORIES.map(repo => ['create', repo]))
  assert.equal(github.release(REPOSITORIES[0]).target_commitish, SHA)
  assert.equal(github.release(REPOSITORIES[1]).target_commitish, 'main')
  assert.deepEqual(github.entries.get(REPOSITORIES[0]).bytes, github.entries.get(REPOSITORIES[1]).bytes)
  assert.equal(github.entries.get(REPOSITORIES[0]).bytes.size, 14)
  await mirror.stage(options(assets))
  assert.equal(github.writes.length, 2)
})

test('rejects both newer legacy and newer canonical public releases before creation', async t => {
  const assets = fixture(t)
  for (const repo of REPOSITORIES) {
    const github = new FakeGitHub()
    github.history = candidate => candidate === repo ? [{ tag_name: 'v1.0.0-beta.2', draft: false }] : []
    await assert.rejects(new ReleaseMirror(github).stage(options(assets)), /must be greater/)
    assert.deepEqual(github.writes, [])
  }
})

test('accepts the major bridge above the old stable and beta lines', async t => {
  const github = new FakeGitHub()
  github.extraHistory = [{ tag_name: 'v0.2.12', draft: false }, { tag_name: 'v0.2.13-beta.33', draft: false }, { tag_name: 'android-v9.0.0', draft: false }]
  await new ReleaseMirror(github).stage(options(fixture(t)))
  assert.equal(github.writes.length, 2)
})

test('resumes a primary-published legacy-draft interruption without overwriting', async t => {
  const { github, mirror, accepted } = await staged(t)
  const publication = { ...accepted, assets: undefined }
  github.failPublish = REPOSITORIES[1]
  await assert.rejects(mirror.publish(publication), /synthetic publication interruption/)
  assert.equal(github.release(REPOSITORIES[0]).draft, false)
  assert.equal(github.release(REPOSITORIES[1]).draft, true)
  github.failPublish = null
  await mirror.publish(publication)
  await mirror.publish(publication)
  assert.deepEqual(github.writes, [...REPOSITORIES.map(repo => ['create', repo]), ...REPOSITORIES.map(repo => ['publish', repo])])
})

test('rejects source mismatch on a same-version published peer without writes', async t => {
  const { github, mirror, accepted } = await staged(t)
  github.entries.get(REPOSITORIES[1]).release.body = github.release(REPOSITORIES[1]).body.replace(SHA, 'b'.repeat(40))
  github.entries.get(REPOSITORIES[1]).release.draft = false
  github.entries.get(REPOSITORIES[1]).release.prerelease = true
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined }), /sourceSha changed/)
  assert.equal(github.writes.length, 2)
})

test('rejects changed mirror payload even if the asset names still match', async t => {
  const { github, mirror, accepted } = await staged(t)
  const name = expectedAssets(VERSION, TRACK)[0]
  github.entries.get(REPOSITORIES[1]).bytes.set(name, Buffer.from('tampered'))
  github.entries.get(REPOSITORIES[1]).release.assets.find(asset => asset.name === name).digest = `sha256:${digest(Buffer.from('tampered'))}`
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined }), /Checksum mismatch/)
  assert.equal(github.writes.length, 2)
})

test('rejects a self-consistent but different mirror manifest', async t => {
  const { github, mirror, accepted } = await staged(t)
  const entry = github.entries.get(REPOSITORIES[1])
  const name = expectedAssets(VERSION, TRACK)[0]
  const oldHash = digest(entry.bytes.get(name))
  const bytes = Buffer.from('different signed build')
  entry.bytes.set(name, bytes)
  entry.bytes.set('SHA256SUMS', Buffer.from(entry.bytes.get('SHA256SUMS').toString().replace(oldHash, digest(bytes))))
  for (const asset of entry.release.assets) asset.digest = `sha256:${digest(entry.bytes.get(asset.name))}`
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined }), /manifest changed or conflicts/)
  assert.equal(github.writes.length, 2)
})

test('rejects an incomplete draft rather than repairing or replacing it', async t => {
  const { github, mirror, assets } = await staged(t)
  github.entries.get(REPOSITORIES[1]).release.assets.pop()
  await assert.rejects(mirror.stage(options(assets)), /incomplete or conflicting assets/)
  assert.equal(github.writes.length, 2)
})

test('can finish a missing mirror from the original sealed artifacts', async t => {
  const { github, mirror, assets } = await staged(t)
  github.entries.delete(REPOSITORIES[1])
  await mirror.stage(options(assets))
  assert.deepEqual(github.writes.at(-1), ['create', REPOSITORIES[1]])
})

test('rejects a moved public source tag', async t => {
  const { github, mirror } = await staged(t)
  github.entries.get(REPOSITORIES[0]).release.target_commitish = 'main'
  await assert.rejects(mirror.inspect({ version: VERSION, track: TRACK }), /wrong public tag target/)
})

test('rejects ambiguous provenance and provenance injected through release notes', async t => {
  const { github } = await staged(t)
  const release = github.release(REPOSITORIES[0])
  release.body += `Source commit: ${SHA}\n`
  assert.throws(() => releaseIdentity(release, VERSION, TRACK), /exactly one Source commit/)
  const fresh = new FakeGitHub()
  await assert.rejects(new ReleaseMirror(fresh).stage(options(fixture(t), { notes: `hello\nSource commit: ${SHA}` })), /must not override provenance/)
  assert.deepEqual(fresh.writes, [])
})

test('requires platform-verified manifest seal and rejects a changed seal', async t => {
  const { mirror, accepted } = await staged(t)
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined, manifestSha256: undefined }), /requires the platform-verified/)
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined, manifestSha256: '0'.repeat(64) }), /manifest changed or conflicts/)
})

test('unsigned stable needs separate publication approval; beta does not', async t => {
  const { github, mirror, accepted } = await staged(t, { version: '1.0.0', track: 'stable' })
  await assert.rejects(mirror.publish({ ...accepted, assets: undefined }), /requires allow_unsigned_windows/)
  await mirror.publish({ ...accepted, assets: undefined, allowUnsignedWindows: 'true' })
  assert.equal(github.release(REPOSITORIES[0]).prerelease, false)
})

test('legacy immutable-tag alias is explicit and limited to stable 1.0.0 in the approved mirror', () => {
  assert.equal(releaseTag(REPOSITORIES[0], '1.0.0', 'stable', '1.0.0'), 'v1.0.0')
  assert.equal(releaseTag(REPOSITORIES[1], '1.0.0', 'stable', '1.0.0'), '1.0.0')
  assert.equal(releaseTag(REPOSITORIES[1], '1.0.0', 'stable'), 'v1.0.0')
  for (const alias of ['v1.0.0', 'v1.0.0+build.1167', '1.0.1', '../1.0.0', '--draft=false', null, 0]) {
    assert.throws(() => releaseTag(REPOSITORIES[1], '1.0.0', 'stable', alias), /restricted/)
  }
  for (const [version, track] of [['1.0.0-beta.1', 'beta'], ['1.0.1', 'stable'], ['1.0.0', 'beta']]) {
    assert.throws(() => releaseTag(REPOSITORIES[1], version, track, '1.0.0'), /restricted/)
  }
  assert.throws(() => releaseTag('untrusted/other', '1.0.0', 'stable', '1.0.0'), /approved mirror/)
  assert.throws(() => new ReleaseMirror(new FakeGitHub()).checkVersion('1.0.0', 'stable', 'unapproved'), /restricted/)
})

test('alias publishes only the relocated legacy draft without changing canonical or payload identities', async t => {
  const { github, mirror, accepted } = await staged(t, { version: '1.0.0', track: 'stable' })
  github.entries.get(REPOSITORIES[0]).release.draft = false
  github.entries.get(REPOSITORIES[1]).release.tag_name = '1.0.0'
  const before = REPOSITORIES.map(repo => github.release(repo))
  const publication = { ...accepted, assets: undefined, allowUnsignedWindows: 'true', legacyTag: '1.0.0' }
  await mirror.publish(publication)
  await mirror.publish(publication)
  assert.deepEqual(github.writes, [...REPOSITORIES.map(repo => ['create', repo]), ['publish', REPOSITORIES[1]]])
  assert.deepEqual(github.release(REPOSITORIES[0]), before[0])
  assert.deepEqual(github.release(REPOSITORIES[1]), { ...before[1], draft: false })
  assert.deepEqual(github.entries.get(REPOSITORIES[0]).bytes, github.entries.get(REPOSITORIES[1]).bytes)
  assert.equal((await mirror.inspect(publication)).manifestSha256, accepted.manifestSha256)
})

test('alias cannot relabel the canonical source, bypass a seal or silently fall back to the frozen legacy tag', async t => {
  const { github, mirror, accepted } = await staged(t, { version: '1.0.0', track: 'stable' })
  const publication = { ...accepted, assets: undefined, allowUnsignedWindows: 'true', legacyTag: '1.0.0' }
  await assert.rejects(mirror.inspect(publication), /Legacy mirror is missing/)
  const canonical = github.release(REPOSITORIES[0])
  assert.throws(() => releaseIdentity({ ...canonical, tag_name: '1.0.0' }, '1.0.0', 'stable', REPOSITORIES[0], '1.0.0'), /tag does not match/)
  github.entries.get(REPOSITORIES[1]).release.tag_name = '1.0.0'
  await assert.rejects(mirror.publish({ ...publication, manifestSha256: '0'.repeat(64) }), /manifest changed or conflicts/)
  github.entries.get(REPOSITORIES[1]).release.body = canonical.body.replace(SHA, 'b'.repeat(40))
  await assert.rejects(mirror.publish(publication), /sourceSha changed/)
  assert.equal(github.writes.length, 2)
})

test('legacy no-v alias remains a monotonic version baseline outside its exact verified replay', async t => {
  const github = new FakeGitHub()
  github.history = repo => repo === REPOSITORIES[1] ? [{ tag_name: '1.0.0', draft: false }] : []
  const mirror = new ReleaseMirror(github)
  assert.throws(() => mirror.checkVersion('1.0.0', 'stable'), /must be greater/)
  assert.throws(() => mirror.checkVersion('1.0.0-beta.2', 'beta'), /must be greater/)
  assert.doesNotThrow(() => mirror.checkVersion('1.0.1', 'stable'))
  assert.deepEqual(github.writes, [])
})

test('publication sends the already-validated tag explicitly without touching target or assets', () => {
  const calls = []
  const client = new GitHubClient((_command, args) => { calls.push(args); return '' })
  client.publish(REPOSITORIES[1], '1.0.0', 'stable')
  assert.deepEqual(calls, [['release', 'edit', '1.0.0', '--repo', REPOSITORIES[1], '--tag', '1.0.0', '--draft=false', '--prerelease=false', '--latest']])
})

test('replay contains exactly the verified primary bytes', async t => {
  const { mirror, accepted } = await staged(t)
  const replay = mkdtempSync(join(tmpdir(), 'agentsdock-mirror-replay-'))
  t.after(() => rmSync(replay, { recursive: true, force: true }))
  await mirror.inspect({ version: VERSION, track: TRACK, assets: replay })
  assert.equal(await verifyAssets(replay, VERSION, TRACK), accepted.manifestSha256)
})

test('complete GitHub digests require only the small manifest outside platform replay', async t => {
  const { github, mirror } = await staged(t)
  await mirror.inspect({ version: VERSION, track: TRACK })
  assert.ok(github.downloads.every(download => download.pattern === 'SHA256SUMS'))
})

test('missing GitHub digest falls back to full-byte verification', async t => {
  const { github, mirror } = await staged(t)
  delete github.entries.get(REPOSITORIES[1]).release.assets[0].digest
  github.downloads = []
  await mirror.inspect({ version: VERSION, track: TRACK })
  assert.deepEqual(github.downloads.map(download => download.pattern), ['SHA256SUMS', undefined])
  github.entries.get(REPOSITORIES[1]).bytes.set(expectedAssets(VERSION, TRACK)[0], Buffer.from('tampered'))
  await assert.rejects(mirror.inspect({ version: VERSION, track: TRACK }), /Checksum mismatch/)
})

test('digest fast path refuses incomplete uploads, unsafe IDs and manifest digest mismatch', async t => {
  for (const mutation of ['state', 'id', 'duplicate-id', 'size', 'manifest']) {
    const { github, mirror } = await staged(t)
    const assets = github.entries.get(REPOSITORIES[1]).release.assets
    if (mutation === 'state') assets[0].state = 'starter'
    if (mutation === 'id') assets[0].id = -1
    if (mutation === 'duplicate-id') assets[0].id = assets[1].id
    if (mutation === 'size') assets[0].size = 0
    if (mutation === 'manifest') assets.find(asset => asset.name === 'SHA256SUMS').digest = `sha256:${'0'.repeat(64)}`
    await assert.rejects(mirror.inspect({ version: VERSION, track: TRACK }), /identities or upload states|Checksum mismatch/)
  }
})

test('real GitHub tag resolver handles absent draft tags and lightweight/annotated tags fail-closed', () => {
  for (const scenario of ['absent-draft', 'lightweight', 'annotated', 'wrong', 'missing-annotated', 'too-deep', 'absent-published']) {
    const client = new GitHubClient()
    client.run = args => {
      const endpoint = args[1]
      if (endpoint.includes('/git/ref/tags/')) {
        if (scenario.startsWith('absent')) throw Object.assign(new Error('404'), { notFound: true })
        return JSON.stringify({ object: { type: ['lightweight', 'wrong'].includes(scenario) ? 'commit' : 'tag', sha: scenario === 'wrong' ? 'b'.repeat(40) : SHA } })
      }
      if (scenario === 'missing-annotated') throw Object.assign(new Error('404'), { notFound: true })
      return JSON.stringify({ object: { type: scenario === 'too-deep' ? 'tag' : 'commit', sha: SHA } })
    }
    const release = { tag_name: `v${VERSION}`, target_commitish: SHA, draft: scenario === 'absent-draft' }
    if (['absent-draft', 'lightweight', 'annotated'].includes(scenario)) assert.doesNotThrow(() => client.verifySourceTag(release, SHA))
    else assert.throws(() => client.verifySourceTag(release, SHA), /no source tag|could not resolve/)
  }
})

test('GitHub failures identify the bounded operation/status without exposing stderr or arguments', () => {
  const privateText = 'PRIVATE_NOTE_AND_TOKEN_never_print_this'
  const client = new GitHubClient(() => {
    throw Object.assign(new Error(privateText), { status: 1, stderr: `HTTP 403: Resource not accessible by personal access token ${privateText}` })
  })
  assert.throws(() => client.run(['release', 'create', `v${VERSION}`, '--repo', REPOSITORIES[0], '--notes', privateText]), error => {
    assert.match(error.message, /GitHub create draft in ZhengyiLuo\/AgentsDock failed \(HTTP 403; exit 1; authorization denied\)/)
    assert.doesNotMatch(error.message, /PRIVATE_NOTE|personal access token|--notes/)
    return true
  })
})

test('GitHub CLI/version and bounded-output failures are separately diagnosable', () => {
  const unsupported = new GitHubClient(() => {
    throw Object.assign(new Error('ignored'), { status: 1, stderr: 'unknown flag: --slurp\nPRIVATE_HELP_TEXT' })
  })
  assert.throws(() => unsupported.history(REPOSITORIES[1]), /list releases in ZhengyiLuo\/AgentsDock-Releases failed \(exit 1; unsupported gh CLI option\)/)
  const overflow = new GitHubClient(() => { throw Object.assign(new Error('ignored'), { code: 'ENOBUFS', stderr: 'PRIVATE_RESPONSE' }) })
  assert.throws(() => overflow.history(REPOSITORIES[0]), /list releases in ZhengyiLuo\/AgentsDock failed \(ENOBUFS\)/)
})

test('only an HTTP 404 remains an optional-object miss; authorization failures propagate', () => {
  const missing = new GitHubClient(() => { throw Object.assign(new Error('ignored'), { status: 1, stderr: 'gh: Not Found (HTTP 404)' }) })
  assert.equal(missing.optional(`repos/${REPOSITORIES[0]}/releases/tags/v${VERSION}`), null)
  const denied = new GitHubClient(() => { throw Object.assign(new Error('ignored'), { status: 1, stderr: 'gh: Forbidden (HTTP 403)' }) })
  assert.throws(() => denied.release(REPOSITORIES[0], `v${VERSION}`), /read release.*HTTP 403/)
})

test('release lookup falls back from the published-only tag API to exact authenticated draft identity', () => {
  const draft = { id: 123, tag_name: `v${VERSION}`, draft: true, assets: [{ name: 'sealed-asset', id: 456 }] }
  const calls = []
  const client = new GitHubClient((_command, args) => {
    calls.push(args)
    if (args.includes('--slurp')) return JSON.stringify([[{ tag_name: 'v0.2.12' }], [draft]])
    throw Object.assign(new Error('ignored'), { status: 1, stderr: 'gh: Not Found (HTTP 404)' })
  })
  assert.deepEqual(client.release(REPOSITORIES[0], `v${VERSION}`), draft)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('--paginate'))
  assert.ok(calls[1].includes(`repos/${REPOSITORIES[0]}/releases?per_page=100`))
})

test('published release lookup does not unnecessarily list history', () => {
  const published = { id: 123, tag_name: `v${VERSION}`, draft: false }
  const calls = []
  const client = new GitHubClient((_command, args) => { calls.push(args); return JSON.stringify(published) })
  assert.deepEqual(client.release(REPOSITORIES[0], `v${VERSION}`), published)
  assert.equal(calls.length, 1)
})

test('draft fallback distinguishes absent, ambiguous and unauthorized release listings', () => {
  for (const scenario of ['absent', 'duplicate', 'denied']) {
    const client = new GitHubClient((_command, args) => {
      if (!args.includes('--slurp')) throw Object.assign(new Error('ignored'), { status: 1, stderr: 'HTTP 404' })
      if (scenario === 'denied') throw Object.assign(new Error('ignored'), { status: 1, stderr: 'HTTP 403 Forbidden' })
      if (scenario === 'absent') return '[[]]'
      return JSON.stringify([[{ tag_name: `v${VERSION}`, id: 1 }, { tag_name: `v${VERSION}`, id: 2 }]])
    })
    if (scenario === 'absent') assert.equal(client.release(REPOSITORIES[0], `v${VERSION}`), null)
    else assert.throws(() => client.release(REPOSITORIES[0], `v${VERSION}`), scenario === 'duplicate' ? /Multiple releases/ : /list releases.*HTTP 403/)
  }
})

test('manifest path traversal, duplicate entries and unrelated assets are rejected', async t => {
  for (const mutation of ['traversal', 'duplicate', 'extra']) {
    const assets = fixture(t)
    const manifest = join(assets, 'SHA256SUMS')
    const text = readFileSync(manifest, 'utf8')
    if (mutation === 'traversal') writeFileSync(manifest, text.replace(/  AgentsDock-/, '  ../AgentsDock-'))
    if (mutation === 'duplicate') writeFileSync(manifest, text + text.split('\n')[0] + '\n')
    if (mutation === 'extra') writeFileSync(join(assets, 'secret.txt'), 'must never be uploaded')
    await assert.rejects(verifyAssets(assets, VERSION, TRACK), /unsafe or duplicate|asset set is not exact/)
  }
})

test('workflows keep public source pinning, build once, guarded mirror writes and channel defaults', () => {
  const draft = readFileSync(new URL('../../.github/workflows/direct-desktop-release-draft.yml', import.meta.url), 'utf8')
  const publish = readFileSync(new URL('../../.github/workflows/direct-desktop-release-publish.yml', import.meta.url), 'utf8')
  assert.equal((draft.match(/p\.releaseBuildNumber=String\(n\)/g) ?? []).length, 4)
  assert.equal((draft.match(/p\.build\.buildVersion=String\(n\)/g) ?? []).length, 4)
  assert.equal((draft.match(/BUILD_NUMBER: \$\{\{ needs\.validate-request\.outputs\.build_number \}\}/g) ?? []).length, 4)
  assert.match(draft, /validate_desktop_build_number\.mjs/)
  assert.doesNotMatch(draft, /(?:n\+|BUILD_NUMBER \+ )100[05]/)
  assert.equal((draft.match(/AGENTSDOCK_EXPECTED_BUILD_NUMBER=/g) ?? []).length, 4)
  assert.match(draft, /\.permissions\.push/)
  assert.match(draft, /primary-releases\.json.*legacy-releases\.json/)
  assert.match(draft, /direct-release-mirror\.mjs stage/)
  assert.match(publish, /direct-release-mirror\.mjs inspect/)
  assert.match(publish, /direct-release-mirror\.mjs publish/)
  assert.match(publish, /for RELEASE_REPOSITORY in ZhengyiLuo\/AgentsDock ZhengyiLuo\/AgentsDock-Releases/)
  assert.match(publish, /platform verifiers observed different checksum manifests/)
  assert.equal((draft.match(/repository: ZhengyiLuo\/AgentsDock\n/g) ?? []).length, 5)
  assert.equal((publish.match(/repository: ZhengyiLuo\/AgentsDock\n/g) ?? []).length, 5)
  assert.match(publish, /ref: \$\{\{ inputs\.migration_qa_sha \}\}/)
  assert.match(publish, /needs: \[inspect-draft, publish\]/)
  assert.match(publish, /"\$RELEASE_VERSION" = 1\.0\.0-beta\.1/)
  assert.match(publish, /Stable 1\.0\.0 requires a reviewed native migration QA commit/)
  assert.match(publish, /"from":"0\.2\.12","track":"stable"/)
  assert.match(publish, /"from":"1\.0\.0-beta\.2","track":"beta"/)
  assert.match(publish, /--track "\$MIGRATION_TRACK"/)
  assert.equal((publish.match(/--legacy-tag "\$LEGACY_RELEASE_TAG"/g) ?? []).length, 2)
  assert.match(publish, /\[\[ "\$RELEASE_REPOSITORY" = ZhengyiLuo\/AgentsDock-Releases && -n "\$LEGACY_RELEASE_TAG" \]\]/)
  assert.match(publish, /"\$LATEST_TAG" = "\$RELEASE_TAG"/)
  assert.match(publish, /native-migration-\$\{\{ matrix\.journey\.from \}\}-\$\{\{ matrix\.journey\.track \}\}/)
  assert.doesNotMatch(`${draft}\n${publish}`, /--clobber|release upload|release delete|git push/)
})

test('public native automation is manual, canonical, source-pinned and environment-gated before secrets', () => {
  const guard = "github.event_name == 'workflow_dispatch' && github.repository == 'ZhengyiLuo/AgentsDock' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/'))"
  for (const [name, expectedJobs] of [['draft', 6], ['publish', 7]]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/direct-desktop-release-${name}.yml`, import.meta.url), 'utf8')
    assert.match(workflow, /^on:\n  workflow_dispatch:/m)
    assert.doesNotMatch(workflow, /^  (?:pull_request(?:_target)?|push|workflow_run|workflow_call|schedule|release):/m)
    assert.match(workflow, /^permissions:\n  contents: read\n/m)
    assert.doesNotMatch(workflow, /contents: write|id-token: write|secrets: inherit|AgentsDock-Internal/)
    const jobs = workflow.split(/^  (?=[a-z][a-z0-9-]+:\n)/m).filter(section => /^[-a-z0-9]+:\n/.test(section) && /^    runs-on:/m.test(section))
    assert.equal(jobs.length, expectedJobs)
    for (const job of jobs) {
      const condition = job.match(/^    if: (.+)$/m)?.[1]
      assert.ok(condition?.includes(guard), `manual canonical trusted-ref guard missing from ${job.split('\n')[0]}`)
      if (job.includes('secrets.')) assert.match(job, /^    environment: direct-production$/m, `secret job is unprotected: ${job.split('\n')[0]}`)
    }
    const checkouts = workflow.split(/      - uses: actions\/checkout@[0-9a-f]+/).slice(1)
    for (const checkout of checkouts) assert.match(checkout.split(/\n      - /)[0], /persist-credentials: false/)
    assert.match(workflow, /git merge-base --is-ancestor "\$SOURCE_SHA" refs\/remotes\/origin\/reviewed-release/)
  }
})

test('actual workflow entry guards reject forks, pull requests, feature branches and tags', () => {
  for (const name of ['draft', 'publish']) {
    const workflow = readFileSync(new URL(`../../.github/workflows/direct-desktop-release-${name}.yml`, import.meta.url), 'utf8')
    const section = workflow.split('      - name: Require the canonical manual trusted release line\n')[1].split('\n      - ')[0]
    const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
    for (const [event, repository, ref, accepted] of [
      ['workflow_dispatch', 'ZhengyiLuo/AgentsDock', 'refs/heads/main', true],
      ['workflow_dispatch', 'ZhengyiLuo/AgentsDock', 'refs/heads/release/1.0', true],
      ['workflow_dispatch', 'someone/AgentsDock', 'refs/heads/main', false],
      ['pull_request', 'ZhengyiLuo/AgentsDock', 'refs/heads/main', false],
      ['pull_request_target', 'ZhengyiLuo/AgentsDock', 'refs/heads/main', false],
      ['workflow_dispatch', 'ZhengyiLuo/AgentsDock', 'refs/heads/feature/unreviewed', false],
      ['workflow_dispatch', 'ZhengyiLuo/AgentsDock', 'refs/tags/v1.0.4-beta.12', false],
      ['workflow_dispatch', 'ZhengyiLuo/AgentsDock', 'refs/heads/release/../main', false]
    ]) {
      const result = spawnSync('/bin/bash', ['-e', '-c', script], { encoding: 'utf8', env: {
        ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: repository, GITHUB_REF: ref
      } })
      assert.equal(result.status === 0, accepted, `${name}: ${event} ${repository} ${ref}`)
    }
  }
})

test('temporary Apple credentials are owner-only, loaded after dependencies and removed even if keychain cleanup fails', t => {
  const workflow = readFileSync(new URL('../../.github/workflows/direct-desktop-release-draft.yml', import.meta.url), 'utf8')
  const mac = workflow.split('  build-macos:\n')[1].split('  build-linux-x64:\n')[0]
  assert.ok(mac.indexOf('- name: Install dependencies') < mac.indexOf('- name: Import Developer ID certificate'))
  assert.equal((mac.match(/umask 077/g) ?? []).length, 2)
  const section = mac.split('      - name: Remove temporary Apple signing credentials\n')[1].split('\n      - ')[0]
  assert.match(section, /if: \$\{\{ always\(\) \}\}/)
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  for (const keychainStatus of [0, 1]) {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-signing-cleanup-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    for (const name of ['agentsdock-signing.keychain-db', 'agentsdock-release.p12', 'unrelated-file']) writeFileSync(join(directory, name), 'synthetic credential')
    mkdirSync(join(directory, 'agentsdock-private-keys'))
    writeFileSync(join(directory, 'agentsdock-private-keys', 'AuthKey_TEST.p8'), 'synthetic key')
    // Shadow the macOS command only for this subprocess; no real keychain is touched.
    const result = spawnSync('/bin/bash', ['-e', '-c', `security() { return ${keychainStatus}; }\n${script}`], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory } })
    assert.equal(result.status, keychainStatus, result.stderr)
    for (const name of ['agentsdock-signing.keychain-db', 'agentsdock-release.p12', 'agentsdock-private-keys']) assert.equal(existsSync(join(directory, name)), false)
    assert.equal(existsSync(join(directory, 'unrelated-file')), true)
  }
})

test('actual publication guard requires a pinned stable migration and rejects unrelated QA journeys', () => {
  const publish = readFileSync(new URL('../../.github/workflows/direct-desktop-release-publish.yml', import.meta.url), 'utf8')
  const section = publish.split('      - name: Validate the optional independently pinned migration QA\n')[1]
    .split('      - uses:')[0]
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  for (const [version, track, pin, accepted] of [
    ['1.0.0', 'stable', SHA, true], ['1.0.0', 'stable', '', false],
    ['1.0.0-beta.1', 'beta', SHA, true], ['1.0.0-beta.1', 'beta', '', true],
    ['1.0.0', 'beta', SHA, false], ['1.0.0-beta.1', 'stable', SHA, false],
    ['1.0.1', 'stable', SHA, false], ['1.0.1', 'stable', '', true],
    ['1.0.0', 'stable', 'not-a-sha', false],
  ]) {
    const child = spawnSync('/bin/bash', ['-e', '-c', script], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, RELEASE_VERSION: version, RELEASE_TRACK: track, MIGRATION_QA_SHA: pin, LEGACY_RELEASE_TAG: '' },
    })
    assert.equal(child.status === 0, accepted, `${version}/${track}/${pin}: ${child.stderr}`)
  }
})

test('actual workflow guard admits only the exact stable legacy alias before any GitHub write', () => {
  const publish = readFileSync(new URL('../../.github/workflows/direct-desktop-release-publish.yml', import.meta.url), 'utf8')
  const section = publish.split('      - name: Validate the optional independently pinned migration QA\n')[1].split('      - uses:')[0]
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  for (const [version, track, alias, accepted] of [
    ['1.0.0', 'stable', '1.0.0', true], ['1.0.0', 'stable', 'v1.0.0', false],
    ['1.0.0', 'stable', '1.0.0+build.1167', false], ['1.0.0', 'stable', '../1.0.0', false],
    ['1.0.0-beta.1', 'beta', '1.0.0', false], ['1.0.1', 'stable', '1.0.0', false],
  ]) {
    const child = spawnSync('/bin/bash', ['-e', '-c', script], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, RELEASE_VERSION: version, RELEASE_TRACK: track, MIGRATION_QA_SHA: SHA, LEGACY_RELEASE_TAG: alias },
    })
    assert.equal(child.status === 0, accepted, `${version}/${track}/${alias}: ${child.stderr}`)
  }
})

function enrolledFixture(t) {
  const assets = fixture(t), signed = signedFixture()
  for (const [name, bytes] of [[COORDINATED_ASSETS[0], signed.bytes], [COORDINATED_ASSETS[1], signed.signature]]) writeFileSync(join(assets, name), bytes)
  const lines = expectedAssets(VERSION, TRACK, true).filter(name => name !== 'SHA256SUMS').map(name => `${digest(readFileSync(join(assets, name)))}  ${name}`)
  writeFileSync(join(assets, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  const github = new FakeGitHub(), registryChecks = []
  const mirror = new ReleaseMirror(github, { publicKey: signed.identity.publicKey, publicationVerifier: async value => { registryChecks.push(value); assert.deepEqual(value, signed.descriptor) } })
  return { assets, signed, github, mirror, registryChecks }
}

test('enrolled release seals exactly 16 assets and rechecks the registry on publication', async t => {
  const { assets, github, mirror, registryChecks, signed } = enrolledFixture(t)
  const accepted = await mirror.stage(options(assets, { coordinatedUpdates: true }))
  assert.equal(registryChecks.length, 0)
  assert.equal(github.entries.get(REPOSITORIES[0]).bytes.size, 16)
  assert.match(github.release(REPOSITORIES[0]).body, /Coordinated updates: npm-v1/)
  const replay = mkdtempSync(join(tmpdir(), 'agentsdock-enrolled-replay-'))
  t.after(() => rmSync(replay, { recursive: true, force: true }))
  const inspected = await mirror.inspect({ version: VERSION, track: TRACK, assets: replay })
  assert.equal(inspected.coordinatedUpdates, true)
  assert.deepEqual(readFileSync(join(replay, COORDINATED_ASSETS[0])), signed.bytes)
  await mirror.publish({ ...accepted, assets: undefined })
  assert.equal(registryChecks.length, 1)
  assert.ok(REPOSITORIES.every(repo => !github.release(repo).draft))
  assert.ok(github.downloads.some(call => call.pattern === COORDINATED_ASSETS[0]))
})

test('cannot add or remove enrollment between staging, mirrors and publication', async t => {
  const f = enrolledFixture(t)
  await assert.rejects(f.mirror.stage(options(f.assets)), /asset set is not exact/)
  assert.deepEqual(f.github.writes, [])
  const accepted = await f.mirror.stage(options(f.assets, { coordinatedUpdates: true }))
  await assert.rejects(f.mirror.publish({ ...accepted, coordinatedUpdates: false, assets: undefined }), /enrollment changed/)
  const mirror = f.github.entries.get(REPOSITORIES[1]).release
  mirror.body = mirror.body.replace('Coordinated updates: npm-v1\n', '')
  await assert.rejects(f.mirror.inspect({ version: VERSION, track: TRACK }), /incomplete or conflicting/)
  assert.equal(f.github.writes.length, 2)
})

test('rejects corrupted, substituted or incomplete signed pair before any GitHub write', async t => {
  for (const mutation of ['signature', 'source', 'half', 'metadata']) {
    const f = enrolledFixture(t)
    if (mutation === 'signature') writeFileSync(join(f.assets, COORDINATED_ASSETS[1]), Buffer.alloc(64))
    if (mutation === 'source') writeFileSync(join(f.assets, COORDINATED_ASSETS[0]), signedFixture({ commit: 'b'.repeat(40) }).bytes)
    if (mutation === 'half') rmSync(join(f.assets, COORDINATED_ASSETS[1]))
    if (mutation === 'metadata') f.github.extraHistory = []
    if (mutation === 'metadata') await assert.rejects(f.mirror.stage(options(f.assets, { coordinatedUpdates: true, notes: 'Coordinated updates: npm-v1' })), /provenance/)
    else await assert.rejects(f.mirror.stage(options(f.assets, { coordinatedUpdates: true })), /Checksum mismatch|asset set is not exact/)
    assert.deepEqual(f.github.writes, [])
  }
})

test('enrolled staging can finish before either server path is public, while publication remains gated', async t => {
  const f = enrolledFixture(t)
  f.mirror.publicationVerifier = async () => { throw new Error('server paths unavailable') }
  const accepted = await f.mirror.stage(options(f.assets, { coordinatedUpdates: true }))
  assert.deepEqual(f.github.writes, REPOSITORIES.map(repo => ['create', repo]))
  await assert.rejects(f.mirror.publish({ ...accepted, assets: undefined }), /server paths unavailable/)
  assert.deepEqual(f.github.writes, REPOSITORIES.map(repo => ['create', repo]))
})

test('enrolled publish cannot proceed while the previously verified npm version is unavailable', async t => {
  const f = enrolledFixture(t)
  const accepted = await f.mirror.stage(options(f.assets, { coordinatedUpdates: true }))
  f.mirror.publicationVerifier = async () => { throw new Error('npm unavailable at publish') }
  await assert.rejects(f.mirror.publish({ ...accepted, assets: undefined }), /npm unavailable at publish/)
  assert.deepEqual(f.github.writes, REPOSITORIES.map(repo => ['create', repo]))
})

test('digest fast path still verifies descriptor signatures after a self-consistent malicious rewrite', async t => {
  const f = enrolledFixture(t)
  await f.mirror.stage(options(f.assets, { coordinatedUpdates: true }))
  const entry = f.github.entries.get(REPOSITORIES[0])
  entry.bytes.set(COORDINATED_ASSETS[1], Buffer.alloc(64))
  const lines = expectedAssets(VERSION, TRACK, true).filter(name => name !== 'SHA256SUMS').map(name => `${digest(entry.bytes.get(name))}  ${name}`)
  entry.bytes.set('SHA256SUMS', Buffer.from(`${lines.join('\n')}\n`))
  for (const asset of entry.release.assets) { asset.digest = `sha256:${digest(entry.bytes.get(asset.name))}`; asset.size = entry.bytes.get(asset.name).length }
  await assert.rejects(f.mirror.inspect({ version: VERSION, track: TRACK }), /signature/)
  assert.equal(f.github.writes.length, 2)
})

test('actual workflow sealing step produces exact legacy and enrolled checksum sets', async t => {
  const workflow = readFileSync(new URL('../../.github/workflows/direct-desktop-release-draft.yml', import.meta.url), 'utf8')
  const section = workflow.split('      - name: Seal the exact cross-platform asset set\n')[1].split('      - uses:')[0]
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  for (const enrolled of [false, true]) {
    const f = enrolled ? enrolledFixture(t) : { assets: fixture(t) }
    const work = mkdtempSync(join(tmpdir(), 'agentsdock-seal-workflow-'))
    t.after(() => rmSync(work, { recursive: true, force: true }))
    cpSync(f.assets, join(work, 'release'), { recursive: true })
    rmSync(join(work, 'release/SHA256SUMS'))
    symlinkSync(new URL('../', import.meta.url), join(work, 'scripts'), 'dir')
    const result = spawnSync('/bin/bash', ['-e', '-c', script], { cwd: work, encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: VERSION, RELEASE_TRACK: TRACK, COORDINATED_UPDATES: String(enrolled) } })
    assert.equal(result.status, 0, result.stderr)
    const seal = await verifyAssets(join(work, 'release'), VERSION, TRACK, { coordinatedUpdates: enrolled, sourceSha: SHA, publicKey: f.signed?.identity.publicKey })
    assert.match(seal, /^[0-9a-f]{64}$/)
  }
})
