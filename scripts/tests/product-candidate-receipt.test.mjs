import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { assertCandidateCheckout, CANDIDATE_HARNESS_PATHS } from '../product-candidate-receipt.mjs'

// Pure guard tests with disposable Git repositories. The injected CI metadata
// is synthetic; no native app/service/network/trust helper is ever invoked.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-checkout-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Candidate guard fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (name, content) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), content) }
  git('init', '-q')
  put('server/runtime.py', 'original server\n')
  put('electron/runtime.ts', 'original app\n')
  put('scripts/build_electron_release.sh', 'original build\n')
  put('scripts/product_server_acceptance.py', 'original harness\n')
  put('docs/PRODUCT_ACCEPTANCE.md', 'original docs\n')
  put('.gitignore', 'node_modules/\n')
  git('add', '.'); git('commit', '-qm', 'sealed source')
  const sourceSha = git('rev-parse', 'HEAD'), sourceRef = 'release/candidate-fixture'
  const identity = { sourceSha, sourceRef }
  const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${sourceRef}`,
    GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', RUNNER_OS: 'macOS' })
  const check = (env = environment(), value = identity) => assertCandidateCheckout(value, { env, platform: 'darwin', repositoryDirectory: root })
  return { root, git, put, identity, environment, check }
}

test('exact source and allowlisted descendant harness preserve separate truthful commit identities', t => {
  const f = fixture(t)
  assert.deepEqual(f.check().changedPaths, [])
  f.put('scripts/product_server_acceptance.py', 'fixed harness\n')
  f.git('add', '.'); f.git('commit', '-qm', 'harness-only retry')
  f.put('node_modules/ignored-dependency', 'dependency fixture')
  const observed = f.check()
  assert.equal(observed.sourceSha, f.identity.sourceSha)
  assert.equal(observed.harnessSourceSha, f.git('rev-parse', 'HEAD'))
  assert.notEqual(observed.harnessSourceSha, observed.sourceSha)
  assert.deepEqual(observed.changedPaths, ['scripts/product_server_acceptance.py'])
  assert.equal(observed.publicationEligible, false)
})

test('runtime, build payload and production authorization changes cannot be a harness-only retry', t => {
  for (const path of ['server/runtime.py', 'electron/runtime.ts', 'scripts/build_electron_release.sh',
    'scripts/product-release.mjs', '.github/workflows/product-release.yml', '.github/workflows/product-release-acceptance.yml']) {
    const f = fixture(t)
    f.put(path, 'changed\n'); f.git('add', '.'); f.git('commit', '-qm', 'forbidden change')
    assert.throws(() => f.check(), /non-allowlisted/)
    assert(!CANDIDATE_HARNESS_PATHS.includes(path))
  }
})

test('renaming runtime into allowed documentation still exposes the forbidden deletion', t => {
  const f = fixture(t)
  renameSync(join(f.root, 'server/runtime.py'), join(f.root, 'docs/PRODUCT_ACCEPTANCE.md'))
  f.git('add', '-A'); f.git('commit', '-qm', 'runtime rename must not evade scope')
  assert.throws(() => f.check(), /non-allowlisted/)
})

test('dirty tracked files and untracked source are rejected while ignored dependencies are permitted', t => {
  for (const path of ['docs/PRODUCT_ACCEPTANCE.md', 'untracked.py']) {
    const f = fixture(t)
    f.put(path, 'uncommitted\n')
    assert.throws(() => f.check(), /clean/)
  }
})

test('different branch, forged workflow commit and unrelated source ancestry are rejected', t => {
  const f = fixture(t), env = f.environment()
  assert.throws(() => f.check({ ...env, GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('candidate-fixture', 'unreviewed') }), /reviewed release branch/)
  assert.throws(() => f.check({ ...env, GITHUB_SHA: 'a'.repeat(40) }), /truthful/)
  assert.throws(() => f.check({ ...env, GITHUB_EVENT_NAME: 'pull_request' }), /explicit canonical/)
  f.git('checkout', '--orphan', 'unrelated-history')
  f.git('commit', '-qm', 'unrelated root')
  assert.throws(() => f.check(), /descend/)
})

test('root listener git inspection trusts only the explicit checkout and suppresses optional writes', t => {
  const f = fixture(t), calls = []
  assertCandidateCheckout(f.identity, { env: f.environment(), platform: 'darwin', repositoryDirectory: f.root,
    execute: (command, args, options) => { calls.push(args); return execFileSync(command, args, options) } })
  assert(calls.every(args => args[0] === '--no-optional-locks' && args[1] === '-c' && args[2] === `safe.directory=${f.root}`))
  const diff = calls.find(args => args.includes('diff'))
  assert(diff.includes('--no-renames') && diff.includes('-z') && diff.includes('--no-ext-diff'))
  assert(!calls.flat().includes('safe.directory=*'))
})

test('candidate workflow retains sealed artifact pins and supplies exact expected coordinated resources', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const inputs = readFileSync(new URL('../../.github/actions/product-candidate-inputs/action.yml', import.meta.url), 'utf8')
  const candidateJob = workflow.slice(workflow.indexOf('  candidate-native:'))
  assert.match(candidateJob, /fetch-depth: 0/)
  assert.match(candidateJob, /export AGENTSDOCK_COORDINATED_MANIFEST="\$RUNNER_TEMP\/candidate-inputs\/payload\/server\/npm\/agents-server-npm-manifest\.json"/)
  assert.match(candidateJob, /export AGENTSDOCK_COORDINATED_SIGNATURE="\$RUNNER_TEMP\/candidate-inputs\/payload\/server\/npm\/agents-server-npm-manifest\.sig"/)
  assert.match(inputs, /draft\.targetCommitish === receipt\.sourceSha/)
  assert.match(inputs, /validate-runner/)
  assert.match(inputs, /--source-sha "\$ARTIFACT_SOURCE_SHA" --candidate-rehearsal true/)
  assert.doesNotMatch(inputs, /export GITHUB_SHA=|GITHUB_SHA:|--source-sha "\$GITHUB_SHA"/)
})
