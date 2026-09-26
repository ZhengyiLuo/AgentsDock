import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/server-npm-publish.yml', import.meta.url)), 'utf8')
const publish = workflow.slice(workflow.indexOf('\n  publish:\n'))

function runStep(name) {
  const section = publish.split(`      - name: ${name}\n`)[1]
  assert(section, `Missing workflow step: ${name}`)
  const block = section.split('        run: |\n')[1]
  assert(block, `Missing Bash body: ${name}`)
  const lines = []
  for (const line of block.split('\n')) {
    if (line && !line.startsWith('          ')) break
    lines.push(line.slice(10))
  }
  return lines.join('\n')
}

const identityGuard = runStep('Require the reviewed workflow and source commit')
const ancestryGuard = runStep('Bind accepted product source to the reviewed publishing workflow')
const registryVerification = runStep('Verify the public registry metadata and exact downloaded bytes')

function bash(script, env, cwd) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${script}\nprintf 'publication-authorized\\n'`], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  })
}

function pins(source, reviewed = source, changes = {}) {
  return {
    SOURCE_SHA: source,
    SOURCE_REF: 'release/1.0.4',
    REVIEWED_WORKFLOW_SHA: reviewed,
    WORKFLOW_SHA: reviewed,
    WORKFLOW_REF: 'refs/heads/release/1.0.4',
    ACCEPTED_MANIFEST_SHA256: 'c'.repeat(64),
    ...changes,
  }
}

function denied(result, label) {
  assert.notEqual(result.status, 0, `${label}: guard unexpectedly passed`)
  assert.doesNotMatch(result.stdout, /publication-authorized/, label)
}

function repository(t) {
  const base = mkdtempSync(join(tmpdir(), 'agentsdock-publish-pins-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const remote = join(base, 'remote.git')
  const checkout = join(base, 'checkout')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: base, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--bare', remote)
  git('init', checkout)
  const command = (...args) => git('-C', checkout, ...args)
  command('config', 'user.name', 'Publication fixture')
  command('config', 'user.email', 'publication-fixture@example.invalid')
  command('config', 'commit.gpgsign', 'false')
  command('remote', 'add', 'origin', remote)
  writeFileSync(join(checkout, 'accepted-verifier.txt'), 'accepted product verifier\n')
  command('add', 'accepted-verifier.txt')
  command('commit', '-m', 'accepted product source')
  const source = command('rev-parse', 'HEAD')
  writeFileSync(join(checkout, 'publishing-workflow.txt'), 'reviewed publication correction\n')
  command('add', 'publishing-workflow.txt')
  command('commit', '-m', 'reviewed publishing workflow')
  const reviewed = command('rev-parse', 'HEAD')
  command('push', 'origin', `${reviewed}:refs/heads/release/1.0.4`)
  command('checkout', '--detach', source)
  return { checkout, command, source, reviewed }
}

test('draft visibility is limited to publish, with an optional distinct workflow pin', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  assert.match(publish, /permissions:\n(?:      #[^\n]*\n)*      contents: write\n      id-token: write\n/)
  assert.match(publish, /if: inputs\.operation == 'publish' && github\.repository == 'ZhengyiLuo\/AgentsDock'/)
  assert.match(publish, /environment: npm-release/)
  assert.match(workflow, /workflow_sha:\n[^]*?type: string\n        required: false\n        default: ''\n/)
  assert.match(publish, /REVIEWED_WORKFLOW_SHA: \$\{\{ inputs\.workflow_sha \|\| inputs\.source_sha \}\}/)
})

test('checkout and publication verification remain pinned to the accepted product source', () => {
  assert.match(publish, /ref: \$\{\{ inputs\.source_sha \}\}\n          persist-credentials: false\n          fetch-depth: 0/)
  assert.doesNotMatch(publish, /ref: \$\{\{ inputs\.workflow_sha/)
  assert.match(publish, /verify_npm_publication\.mjs preflight "\$RUNNER_TEMP\/npm-candidate" "\$SOURCE_SHA" "\$ACCEPTED_MANIFEST_SHA256"/)
  assert.match(publish, /verify_npm_publication\.mjs verify "\$RUNNER_TEMP\/npm-candidate" "\$SOURCE_SHA" "\$ACCEPTED_MANIFEST_SHA256"/)
  assert.match(publish, /npm publish "\$ARCHIVE" --ignore-scripts --access public --tag "\$DIST_TAG"/)
  assert.doesNotMatch(publish, /npm (?:pack|dist-tag)|package_npm_release\.py --output/)
  assert(publish.indexOf('Bind accepted product source') < publish.indexOf('Download the accepted signed bundle'))
})

test('manual guard accepts equal pins and an explicitly reviewed workflow descendant', () => {
  for (const env of [pins('a'.repeat(40)), pins('a'.repeat(40), 'b'.repeat(40))]) {
    const result = bash(identityGuard, env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'publication-authorized\n')
  }
})

test('manual guard rejects missing or mismatched pins, manifest hashes and untrusted refs', () => {
  const base = pins('a'.repeat(40), 'b'.repeat(40))
  for (const change of [
    { SOURCE_SHA: '' }, { SOURCE_SHA: 'a'.repeat(39) },
    { REVIEWED_WORKFLOW_SHA: '' }, { REVIEWED_WORKFLOW_SHA: 'not-a-commit' },
    { WORKFLOW_SHA: '' }, { WORKFLOW_SHA: base.SOURCE_SHA },
    { WORKFLOW_REF: 'refs/tags/release/1.0.4' }, { WORKFLOW_REF: 'refs/heads/main' },
    { SOURCE_REF: 'feature/publish', WORKFLOW_REF: 'refs/heads/feature/publish' },
    { SOURCE_REF: 'release/../main', WORKFLOW_REF: 'refs/heads/release/../main' },
    { ACCEPTED_MANIFEST_SHA256: '' }, { ACCEPTED_MANIFEST_SHA256: 'c'.repeat(63) },
  ]) denied(bash(identityGuard, { ...base, ...change }), JSON.stringify(change))
})

test('real Git ancestry admits corrected workflow while keeping HEAD at accepted source', t => {
  const fixture = repository(t)
  for (const reviewed of [fixture.source, fixture.reviewed]) {
    const result = bash(`${identityGuard}\n${ancestryGuard}`, pins(fixture.source, reviewed), fixture.checkout)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fixture.command('rev-parse', 'HEAD'), fixture.source)
    assert.equal(readFileSync(join(fixture.checkout, 'accepted-verifier.txt'), 'utf8'), 'accepted product verifier\n')
  }
})

test('real Git ancestry rejects wrong checkout, unknown commits and unrelated workflow/source', t => {
  const fixture = repository(t)
  fixture.command('checkout', '--detach', fixture.reviewed)
  denied(bash(ancestryGuard, pins(fixture.source, fixture.reviewed), fixture.checkout), 'wrong checkout')
  fixture.command('checkout', '--detach', fixture.source)
  denied(bash(ancestryGuard, pins(fixture.source, 'f'.repeat(40)), fixture.checkout), 'unknown workflow')
  fixture.command('commit', '--allow-empty', '-m', 'unreviewed side history')
  const side = fixture.command('rev-parse', 'HEAD')
  denied(bash(ancestryGuard, pins(side, fixture.reviewed), fixture.checkout), 'source not in reviewed workflow')
  fixture.command('checkout', '--detach', fixture.source)
  denied(bash(ancestryGuard, pins(fixture.source, side), fixture.checkout), 'workflow not on reviewed branch')
})

test('fresh branch proof rejects removed ancestry and a missing reviewed branch', t => {
  const fixture = repository(t)
  fixture.command('push', '--force', 'origin', `${fixture.source}:refs/heads/release/1.0.4`)
  denied(bash(ancestryGuard, pins(fixture.source, fixture.reviewed), fixture.checkout), 'workflow removed from branch')
  denied(bash(ancestryGuard, pins(fixture.source, fixture.source, { SOURCE_REF: 'release/missing' }), fixture.checkout), 'missing branch')
})

function verificationFixture(t, visibleAfter) {
  const base = mkdtempSync(join(tmpdir(), 'agentsdock-registry-visibility-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const env = {
    ...pins('a'.repeat(40)),
    PATH: base,
    RUNNER_TEMP: join(base, 'runner temp'),
    QA_ATTEMPTS: join(base, 'attempts'),
    QA_ARGUMENTS: join(base, 'arguments'),
    QA_SLEEPS: join(base, 'sleeps'),
    QA_NPM: join(base, 'npm-called'),
    QA_VISIBLE_AFTER: String(visibleAfter),
  }
  writeFileSync(join(base, 'node'), `#!/bin/bash
printf '%s\\0' "$@" >> "$QA_ARGUMENTS"
attempt=0
if [[ -f "$QA_ATTEMPTS" ]]; then read -r attempt < "$QA_ATTEMPTS"; fi
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "$QA_ATTEMPTS"
if ((attempt < QA_VISIBLE_AFTER)); then exit 1; fi
exit 0
`, { mode: 0o700 })
  writeFileSync(join(base, 'sleep'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$QA_SLEEPS"\n', { mode: 0o700 })
  writeFileSync(join(base, 'npm'), '#!/bin/bash\nprintf \'unexpected npm call\\n\' >> "$QA_NPM"\nexit 99\n', { mode: 0o700 })
  return {
    run() { return bash(registryVerification, env, base) },
    assertCalls(attempts, sleeps) {
      assert.equal(Number(readFileSync(env.QA_ATTEMPTS, 'utf8')), attempts)
      const expectedArguments = [
        'scripts/verify_npm_publication.mjs', 'verify', `${env.RUNNER_TEMP}/npm-candidate`,
        env.SOURCE_SHA, env.ACCEPTED_MANIFEST_SHA256, `${env.RUNNER_TEMP}/npm-candidate-release.json`,
        `${env.RUNNER_TEMP}/npm-registry-before.json`,
      ]
      assert.deepEqual(readFileSync(env.QA_ARGUMENTS, 'utf8').split('\0').slice(0, -1), Array.from({ length: attempts }, () => expectedArguments).flat())
      assert.equal(existsSync(env.QA_SLEEPS) ? readFileSync(env.QA_SLEEPS, 'utf8') : '', '10\n'.repeat(sleeps))
      assert.equal(existsSync(env.QA_NPM), false, 'read-only verification must never publish or change tags')
    },
  }
}

test('registry verification immediately succeeds without sleeping or publishing again', t => {
  const fixture = verificationFixture(t, 1)
  assert.equal(fixture.run().status, 0)
  fixture.assertCalls(1, 0)
  assert.equal((publish.match(/run: npm publish /g) ?? []).length, 1)
  assert.match(publish, /name: Verify the public registry metadata and exact downloaded bytes\n        timeout-minutes: 11\n/)
})

test('registry visibility polling reuses exact verification pins and succeeds after visibility', t => {
  const fixture = verificationFixture(t, 3)
  assert.equal(fixture.run().status, 0)
  fixture.assertCalls(3, 2)
})

test('unverifiable registry bytes exhaust the bounded polling window and fail without republishing', t => {
  const fixture = verificationFixture(t, 100)
  const result = fixture.run()
  denied(result, 'registry verification exhausted')
  assert.match(result.stderr, /did not succeed within the bounded visibility window/)
  fixture.assertCalls(61, 60)
})
