import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { assertCandidateCheckout, assertCandidateServerCheckout, assertCandidateRunner, assertCandidateServerRunner,
  CANDIDATE_HARNESS_PATHS, CANDIDATE_PREREQUISITE_TEST_EXCEPTION, candidateAssets, candidateTrack, stableBaselineProfile, STABLE_BASELINES,
  candidateBaselineProfile, BETA1101_BASELINE, BETA1101_CANDIDATE_VERSIONS, verifyBaselineDesktop, verifyBaselineServer } from '../product-candidate-receipt.mjs'
import {STABLE_IDENTITY} from '../product_no_downgrade_desktop.mjs'

test('only reviewed stable 1.0.9 extends the nonpublishing beta candidate contract', () => {
  assert.equal(candidateTrack('1.0.9'), 'stable')
  assert.equal(candidateTrack('1.0.8-beta.5'), 'beta')
  for (const version of ['1.0.8', '1.0.10', '1.0.9-rc.1', '1.0.9+local', '1.0.9-beta.0']) assert.throws(() => candidateTrack(version))
  assert(candidateAssets('1.0.9', 'stable').includes('latest-mac.yml'))
  assert(!candidateAssets('1.0.9', 'stable').includes('beta-mac.yml'))
})

test('stable baseline profiles retain independent immutable source/archive identities', () => {
  const stable = stableBaselineProfile('stable108', '1.0.9')
  const {track, ...identity} = stable.server
  assert.deepEqual(identity, STABLE_IDENTITY)
  assert.equal(track, 'stable')
  assert.equal(stable.desktop.version, '1.0.6')
  assert.equal(stable.subscription, 'stable')
  const beta = stableBaselineProfile('beta1085', '1.0.9')
  assert.equal(beta.server.version, '1.0.8-beta.5')
  assert.equal(beta.desktop.sourceSha, beta.server.sourceSha)
  assert.equal(beta.subscription, 'beta')
  assert(Object.isFrozen(STABLE_BASELINES) && Object.isFrozen(beta.server) && Object.isFrozen(beta.desktop))
  for (const [name, version] of [['unknown', '1.0.9'], ['stable108', '1.0.8-beta.5'], ['beta1085', '1.0.10']]) assert.throws(() => stableBaselineProfile(name, version))
})

test('beta.1 baseline is independently pinned to build 1245 and exactly scoped to beta.2 and beta.3', () => {
  assert.deepEqual(BETA1101_CANDIDATE_VERSIONS, ['1.0.10-beta.2', '1.0.10-beta.3'])
  assert(Object.isFrozen(BETA1101_CANDIDATE_VERSIONS))
  const beta = candidateBaselineProfile('beta1101', '1.0.10-beta.2')
  assert.equal(beta, BETA1101_BASELINE)
  assert.equal(candidateBaselineProfile('beta1101', '1.0.10-beta.3'), beta)
  assert.equal(beta.desktop.version, '1.0.10-beta.1')
  assert.equal(beta.server.version, beta.desktop.version)
  assert.equal(beta.desktop.buildNumber, '1245')
  assert.equal(beta.desktop.sourceSha, '7790690fc91f0d6331b265820ef64234f5213abd')
  assert.equal(beta.server.sourceSha, beta.desktop.sourceSha)
  assert.equal(beta.subscription, 'beta')
  assert.equal(beta.desktop.zipSha256, '6ba42d86aa8bfd36f3c6abf8e90b385a16c4f5bf857ef171bb35453054e420d4')
  assert.equal(beta.server.manifestSha256, '01286c1d46b6c0673d849b23b258056ebba35068e195ae500e789eb82b21f3fc')
  assert.equal(beta.server.archiveSha256, '050ddc103670df77b3fe31236cd119c71d7b933e0948b7cf85f92afe2ce2056b')
  assert.equal(beta.server.archiveBytes, 3727576)
  assert(Object.isFrozen(beta) && Object.isFrozen(beta.server) && Object.isFrozen(beta.desktop))
  for (const version of ['1.0.9', '1.0.10', '1.0.10-beta.1', '1.0.10-beta.4', '1.0.10-beta.2+local', '1.0.10-beta.3+local']) {
    assert.throws(() => candidateBaselineProfile('beta1101', version))
  }
  for (const version of ['1.0.10-beta.2', '1.0.10-beta.3']) {
    for (const name of ['stable108', 'beta1085', 'unknown']) assert.throws(() => candidateBaselineProfile(name, version))
    assert.throws(() => stableBaselineProfile('beta1101', version))
  }
})

test('independent baseline verification rejects substituted bytes before trusting metadata', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'baseline-pins-unit-'))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  writeFileSync(join(directory, 'agents-server-npm-manifest.json'), '{}')
  writeFileSync(join(directory, 'agents-server-npm-manifest.sig'), Buffer.alloc(64))
  writeFileSync(join(directory, 'SHA256SUMS'), 'synthetic untrusted manifest')
  for (const [profile, version] of [['stable108', '1.0.9'], ['beta1085', '1.0.9'],
    ['beta1101', '1.0.10-beta.2'], ['beta1101', '1.0.10-beta.3']]) {
    await assert.rejects(() => verifyBaselineServer(profile, directory, version), /independently pinned/)
    await assert.rejects(() => verifyBaselineDesktop(profile, directory, version), /independently pinned/)
  }
})

// Pure guard tests with disposable Git repositories. The injected CI metadata
// is synthetic; no native app/service/network/trust helper is ever invoked.
function fixture(t, initialFiles = {}) {
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
  for (const [path, content] of Object.entries(initialFiles)) put(path, content)
  git('add', '.'); git('commit', '-qm', 'sealed source')
  const sourceSha = git('rev-parse', 'HEAD'), sourceRef = 'release/candidate-fixture'
  const identity = { sourceSha, sourceRef }
  const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${sourceRef}`,
    GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', RUNNER_OS: 'macOS' })
  const check = (env = environment(), value = identity) => assertCandidateCheckout(value, { env, platform: 'darwin', repositoryDirectory: root })
  return { root, git, put, identity, environment, check }
}

function reviewedTestBytes() {
  const exception = CANDIDATE_PREREQUISITE_TEST_EXCEPTION
  const [usage, peer] = Object.keys(exception.changes)
  const beforeUsage = "afterEach(() => { cleanup(); setLocale('en'); vi.useRealTimers(); Reflect.deleteProperty(window, 'agentsDock') })"
  const afterUsage = `afterEach(async () => {
  cleanup()
  // Radix dispatches its owned unmount-focus event on the next task. Complete
  // that work before Vitest restores globals/disposes this jsdom realm.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  setLocale('en')
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'agentsDock')
})`
  const beforePeer = "    await join()\n    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))\n    expect(teamHub.stopSecurePeerPairingCompletionWait).toHaveBeenCalledTimes(1)"
  const afterPeer = beforePeer.replace('    fireEvent.click',
    '    await waitFor(() => expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1))\n    fireEvent.click')
  const result = {}
  for (const [path, previous, next] of [[usage, beforeUsage, afterUsage], [peer, beforePeer, afterPeer]]) {
    const after = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    assert.equal(after.split(next).length, 2, 'Reviewed correction must occur exactly once')
    const before = after.replace(next, previous)
    const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
    assert.equal(blob(before), exception.changes[path].before, 'Original test bytes differ from the source-specific review')
    assert.equal(blob(after), exception.changes[path].after, 'Corrected test bytes differ from the source-specific review')
    result[path] = { before, after }
  }
  return result
}

function prerequisiteFixture(t) {
  const bytes = reviewedTestBytes(), exception = CANDIDATE_PREREQUISITE_TEST_EXCEPTION
  const f = fixture(t, Object.fromEntries(Object.entries(bytes).map(([path, value]) => [path, value.before])))
  // A synthetic source-identity adapter keeps these pure guard tests in owned
  // disposable repositories; all ancestry, cleanliness and raw tree deltas use
  // real Git. No hosted runner, native helper, service or trust is invoked.
  const execute = (command, args, options) => {
    const pin = `${exception.sourceSha}^{commit}`
    const mapped = args.map(arg => arg === exception.sourceSha ? f.identity.sourceSha
      : arg === pin ? `${f.identity.sourceSha}^{commit}` : arg)
    const output = execFileSync(command, mapped, options)
    return args.includes(pin) ? `${exception.sourceSha}\n` : output
  }
  const check = ({ identity = { sourceSha: exception.sourceSha, sourceRef: exception.sourceRef }, server = false, env = {} } = {}) => {
    const environment = { ...f.environment(),
      GITHUB_WORKFLOW_REF: `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${identity.sourceRef}`,
      ...(server ? { RUNNER_OS: 'Linux', GITHUB_JOB: 'candidate-server-rollback-linux' } : {}), ...env }
    return (server ? assertCandidateServerCheckout : assertCandidateCheckout)(identity,
      { env: environment, platform: server ? 'linux' : 'darwin', repositoryDirectory: f.root, execute })
  }
  const correct = (paths = Object.keys(bytes)) => { for (const path of paths) f.put(path, bytes[path].after) }
  const commit = () => { f.git('add', '-A'); f.git('commit', '-qm', 'owned prerequisite fixture delta') }
  const reseal = () => { commit(); f.identity.sourceSha = f.git('rev-parse', 'HEAD') }
  return { ...f, bytes, check, correct, commit, reseal }
}

test('only exact source-bound prerequisite blobs extend either candidate guard, never the generic allowlist', t => {
  const exception = CANDIDATE_PREREQUISITE_TEST_EXCEPTION, paths = Object.keys(exception.changes)
  assert.equal(exception.sourceSha, '33c21482170010108830aef8009831d5d1da624c')
  assert.equal(exception.sourceRef, 'release/1.0.9')
  assert.deepEqual(paths, ['electron/src/renderer/src/components/ProviderUsageIndicator.test.tsx',
    'electron/src/renderer/src/components/SecurePeerPanel.test.tsx'])
  assert(Object.isFrozen(exception) && Object.isFrozen(exception.changes))
  for (const path of paths) {
    assert(Object.isFrozen(exception.changes[path]))
    assert(!CANDIDATE_HARNESS_PATHS.includes(path))
  }
  for (const selected of [paths, ...paths.map(path => [path])]) {
    const f = prerequisiteFixture(t)
    f.correct(selected); f.commit()
    for (const server of [false, true]) {
      const result = f.check({ server })
      assert.deepEqual(result.changedPaths, [...selected].sort())
      assert.equal(result.sourceSha, exception.sourceSha)
      assert.equal(result.harnessSourceSha, f.git('rev-parse', 'HEAD'))
      assert.equal(result.publicationEligible, false)
      if (server) assert.equal(result.desktopAcceptance, false)
    }
  }
})

test('reviewed prerequisite deltas still reject another source/ref, forged HEAD and dirty checkout', t => {
  const f = prerequisiteFixture(t), exception = CANDIDATE_PREREQUISITE_TEST_EXCEPTION
  f.correct(); f.commit()
  assert.throws(() => f.check({ identity: { sourceSha: f.identity.sourceSha, sourceRef: exception.sourceRef } }), /non-allowlisted/)
  assert.throws(() => f.check({ identity: { sourceSha: exception.sourceSha, sourceRef: 'release/unreviewed' } }), /non-allowlisted/)
  assert.throws(() => f.check({ env: { GITHUB_SHA: 'b'.repeat(40) } }), /truthful/)
  f.put(Object.keys(f.bytes)[0], 'uncommitted test\n')
  assert.throws(() => f.check(), /clean/)
})

test('each prerequisite path rejects wrong original/corrected blobs and executable or symlink modes', t => {
  for (const path of Object.keys(CANDIDATE_PREREQUISITE_TEST_EXCEPTION.changes)) {
    for (const mutation of ['before-blob', 'after-blob', 'before-executable', 'after-executable', 'after-symlink']) {
      const f = prerequisiteFixture(t)
      if (mutation === 'before-blob') { f.put(path, `${f.bytes[path].before}\n`); f.reseal() }
      if (mutation === 'before-executable') { chmodSync(join(f.root, path), 0o755); f.reseal() }
      f.correct()
      if (mutation === 'after-blob') f.put(path, `${f.bytes[path].after}\n`)
      if (mutation === 'before-executable') chmodSync(join(f.root, path), 0o644)
      if (mutation === 'after-executable') chmodSync(join(f.root, path), 0o755)
      if (mutation === 'after-symlink') { rmSync(join(f.root, path)); symlinkSync('owned-fixture-target', join(f.root, path)) }
      f.commit()
      assert.throws(() => f.check(), /non-allowlisted/, mutation)
    }
  }
})

test('reviewed prerequisite paths cannot be added, deleted or renamed into allowed documentation', t => {
  for (const path of Object.keys(CANDIDATE_PREREQUISITE_TEST_EXCEPTION.changes)) {
    for (const mutation of ['add', 'delete', 'rename']) {
      const f = prerequisiteFixture(t)
      if (mutation === 'add') { f.git('rm', '--', path); f.reseal() }
      f.correct()
      if (mutation === 'delete') f.git('rm', '-f', '--', path)
      if (mutation === 'rename') renameSync(join(f.root, path), join(f.root, 'docs/PRODUCT_ACCEPTANCE.md'))
      f.commit()
      assert.throws(() => f.check(), /non-allowlisted/, mutation)
    }
  }
})

test('reviewed prerequisite fixes do not admit a third test, runtime, build or production gate change', t => {
  for (const path of ['electron/src/renderer/src/components/Unreviewed.test.tsx', 'electron/runtime.ts',
    'server/runtime.py', 'scripts/build_electron_release.sh', '.github/workflows/product-release.yml']) {
    const f = prerequisiteFixture(t)
    f.correct(); f.put(path, 'unreviewed bytes\n'); f.commit()
    assert.throws(() => f.check(), /non-allowlisted/)
    assert.throws(() => f.check({ server: true }), /non-allowlisted/)
  }
})

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

test('Linux server-only runner is separate from unchanged Darwin desktop scope and retains every checkout fence', t => {
  const f = fixture(t), env = {...f.environment(), RUNNER_OS: 'Linux', GITHUB_JOB: 'candidate-server-rollback-linux'}
  const check = (environment = env, platform = 'linux') => assertCandidateServerCheckout(f.identity,
    {env: environment, platform, repositoryDirectory: f.root})
  const result = check()
  assert.equal(result.executionScope, 'candidate-server-linux')
  assert.equal(result.desktopAcceptance, false)
  assert.equal(result.publicationEligible, false)
  assert.throws(() => assertCandidateRunner(env, 'linux'), /macOS/)
  assert.throws(() => assertCandidateServerRunner(f.environment(), 'darwin'), /Linux/)
  for (const change of [{RUNNER_OS: 'macOS'}, {GITHUB_JOB: 'release-tooling'}, {RUNNER_ENVIRONMENT: 'self-hosted'}, {GITHUB_EVENT_NAME: 'pull_request'},
    {GITHUB_REPOSITORY: 'fork/AgentsDock'}, {GITHUB_SHA: 'b'.repeat(40)},
    {GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('/release/', '/main/')}]) assert.throws(() => check({...env, ...change}))
  f.put('scripts/product_server_acceptance.py', 'scoped server harness\n'); f.git('add', '.'); f.git('commit', '-qm', 'reviewed QA')
  assert.equal(check({...env, GITHUB_SHA: f.git('rev-parse', 'HEAD')}).sourceSha, f.identity.sourceSha)
  f.put('server/runtime.py', 'changed runtime\n'); f.git('add', '.'); f.git('commit', '-qm', 'forbidden runtime')
  assert.throws(() => check({...env, GITHUB_SHA: f.git('rev-parse', 'HEAD')}), /non-allowlisted/)
})

test('runtime, build payload and production authorization changes cannot be a harness-only retry', t => {
  for (const path of ['scripts/product_no_downgrade_server.py', 'scripts/product_no_downgrade_desktop.mjs',
    'scripts/product_no_downgrade_relay.mjs', 'scripts/tests/test_product_no_downgrade_server.py',
    'scripts/tests/product_no_downgrade_desktop.test.mjs', 'scripts/tests/product_no_downgrade_relay.test.mjs']) {
    assert(CANDIDATE_HARNESS_PATHS.includes(path), 'Future no-downgrade QA must use only its six reviewed paths')
  }
  for (const path of ['server/runtime.py', 'electron/runtime.ts', 'scripts/build_electron_release.sh',
    'scripts/verify_electron_app_zip.py', 'scripts/product-release.mjs',
    '.github/workflows/product-release.yml', '.github/workflows/product-release-acceptance.yml']) {
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
  assert.match(inputs, /--source-sha "\$ARTIFACT_SOURCE_SHA" --candidate-rehearsal "\$IMPORT_SCOPE"/)
  assert.match(inputs, /candidate\)\n\s+RUNNER_OPERATION=validate-runner\n\s+IMPORT_SCOPE=true/)
  assert.doesNotMatch(inputs, /export GITHUB_SHA=|GITHUB_SHA:|--source-sha "\$GITHUB_SHA"/)
  assert.match(inputs, /BASELINE_PAIRS=\(AgentsServer:1\.0\.7-beta\.21\)/)
  assert.match(inputs, /if \[\[ "\$EXECUTION_SCOPE" == candidate \]\]; then BASELINE_PAIRS\+=\(AgentsDock-Releases:1\.0\.6\); fi/)
  assert.match(inputs, /baseline\.isPrerelease === process\.argv\[3\]\.includes\('-beta\.'\)/)
  assert.match(inputs, /gh release download v1\.0\.7-beta\.21 --repo ZhengyiLuo\/AgentsServer/)
  assert.match(inputs, /gh release download v1\.0\.6 --repo ZhengyiLuo\/AgentsDock-Releases/)
  assert.doesNotMatch(inputs, /AgentsDock-Releases:1\.0\.7-beta|AgentsServer:1\.0\.3/)
  assert.match(candidateJob, /\$\{\{ matrix\.kind \}\}-\$\{\{ matrix\.legacy_mode \}\}/)
})

test('exact stable, beta.2 and beta.3 matrices select independent npm baselines without changing publication guards', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const inputs = readFileSync(new URL('../../.github/actions/product-candidate-inputs/action.yml', import.meta.url), 'utf8')
  const job = workflow.slice(workflow.indexOf('  candidate-native:'), workflow.indexOf('  candidate-no-downgrade:'))
  assert.match(job, /baseline_profile: \$\{\{ fromJSON\(inputs\.candidate_tag == 'candidate-replay-v1\.0\.9' && '\["legacy","stable108","beta1085"\]' \|\| \(inputs\.candidate_tag == 'candidate-replay-v1\.0\.10-beta\.2' \|\| inputs\.candidate_tag == 'candidate-replay-v1\.0\.10-beta\.3'\) && '\["legacy","beta1101"\]' \|\| '\["legacy"\]'\) \}\}/)
  const negative = workflow.slice(workflow.indexOf('  candidate-no-downgrade:'))
  assert.match(negative, /startsWith\(inputs\.candidate_tag, 'candidate-replay-v1\.0\.8-beta\.'\)/)
  assert.match(job, /INSTALL_KIND=npm-baseline/)
  assert.match(job, /--baseline-profile "\$BASELINE_PROFILE" --baseline-npm-directory/)
  assert.match(job, /--baseline-version "\$BASELINE_DESKTOP_VERSION"/)
  assert.match(job, /steps\.candidate\.outputs\.track/)
  assert.match(inputs, /verify-baseline-server "\$BASELINE_PROFILE"/)
  assert.match(inputs, /verify-baseline-desktop "\$BASELINE_PROFILE"/)
  assert.match(inputs, /cmp "\$RUNNER_TEMP\/candidate-inputs\/baseline-registry\.tgz"/)
  assert.match(inputs, /if \(expected\.sourceSha\) assert\.equal\(release\.targetCommitish, expected\.sourceSha\)/)
  assert.match(inputs, /draft\.isDraft === true && draft\.isPrerelease === true/)
  assert.doesNotMatch(job, /product-acceptance\.mjs|product-release-acceptance\.yml|releaseAcceptance: true|publicationEligible: true/)
})

test('candidate composite shell parses and profile gates reject out-of-scope selections before tools run', () => {
  const inputs = readFileSync(new URL('../../.github/actions/product-candidate-inputs/action.yml', import.meta.url), 'utf8')
  const script = inputs.split('      run: |\n')[1].replace(/^        /gm, '')
  assert.equal(spawnSync('/bin/bash', ['-n'], {input: script}).status, 0)
  const gate = script.slice(0, script.indexOf('case "$EXECUTION_SCOPE"'))
  const env = {PATH: process.env.PATH, CANDIDATE_TAG: 'candidate-replay-v1.0.9', BASELINE_PROFILE: 'stable108',
    EXECUTION_SCOPE: 'candidate', RECEIPT_SHA256: 'a'.repeat(64), BUNDLE_SHA256: 'b'.repeat(64)}
  for (const change of [{}, {BASELINE_PROFILE: 'beta1085'}, {BASELINE_PROFILE: 'legacy'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.2'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.3'},
    {BASELINE_PROFILE: 'legacy', CANDIDATE_TAG: 'candidate-replay-v1.0.8-beta.5'}]) {
    assert.equal(spawnSync('/bin/bash', ['-c', gate], {env: {...env, ...change}}).status, 0)
  }
  for (const change of [{BASELINE_PROFILE: 'unknown'}, {CANDIDATE_TAG: 'candidate-replay-v1.0.8-beta.5'},
    {CANDIDATE_TAG: 'candidate-replay-v1.0.10'}, {EXECUTION_SCOPE: 'candidate-server-linux'}, {RECEIPT_SHA256: 'wrong'},
    {BASELINE_PROFILE: 'beta1101'}, {CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.2'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.4'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.3+local'},
    {CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.3'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.2', EXECUTION_SCOPE: 'candidate-server-linux'},
    {BASELINE_PROFILE: 'beta1101', CANDIDATE_TAG: 'candidate-replay-v1.0.10-beta.3', EXECUTION_SCOPE: 'candidate-server-linux'}]) {
    assert.notEqual(spawnSync('/bin/bash', ['-c', gate], {env: {...env, ...change}}).status, 0)
  }
})

test('Linux rollback job has only explicit server scope, exact signed input pins and non-publishing bounded reports', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const job = workflow.slice(workflow.indexOf('  candidate-server-rollback-linux:'), workflow.indexOf('  candidate-native:'))
  assert.match(job, /runs-on: ubuntu-24\.04/)
  assert.match(job, /legacy_mode: \['0755', '0750'\]/)
  assert.match(job, /execution_scope: candidate-server-linux/)
  assert.match(job, /rollback-retry --candidate-server-linux --kind legacy/)
  assert.match(job, /service --candidate-server-linux --kind legacy --action restart/)
  assert.match(job, /setup --candidate-server-linux/)
  assert.match(job, /teardown --candidate-server-linux/)
  assert.match(job, /serverOnly: true/)
  assert.match(job, /report\.executionScope !== 'candidate-server-linux'/)
  assert.match(job, /report\.publicationEligible !== false \|\| report\.releaseAcceptance !== false \|\| report\.desktopAcceptance !== false/)
  assert.match(job, /GITHUB_SHA="\$GITHUB_SHA" GITHUB_JOB="\$GITHUB_JOB"/)
  assert.doesNotMatch(job, /product_desktop_acceptance|verify_electron_release|--candidate(?:\s|$)|npm publish|gh release (?:edit|create)|export GITHUB_SHA=/m)
})

test('Linux evidence collector refuses cross-scope, publishing, desktop, secret and unbounded reports', t => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.slice(workflow.indexOf('      - name: Collect bounded non-publishing server-only observations'))
  const script = section.match(/<<'NODE'\n([\s\S]*?)\n          NODE/)[1].replace(/^          /gm, '')
  for (const kind of ['valid', 'private', 'eligible', 'acceptance', 'desktop', 'wrong-scope', 'oversized', 'symlink']) {
    const root = mkdtempSync(join(tmpdir(), 'linux-server-evidence-unit-'))
    t.after(() => rmSync(root, {recursive: true, force: true}))
    const source = join(root, 'source'), destination = join(root, 'public')
    mkdirSync(source)
    const report = {kind: 'candidate-server-observations', executionScope: 'candidate-server-linux',
      publicationEligible: false, releaseAcceptance: false, desktopAcceptance: false}
    if (kind === 'private') report.token = 'fixture-secret-never-published'
    if (kind === 'eligible') report.publicationEligible = true
    if (kind === 'acceptance') report.releaseAcceptance = true
    if (kind === 'desktop') report.desktopAcceptance = true
    if (kind === 'wrong-scope') report.executionScope = 'candidate'
    if (kind === 'oversized') report.extra = 'x'.repeat(512 * 1024)
    const bytes = JSON.stringify(report), target = join(source, 'rollback.json')
    if (kind === 'symlink') {writeFileSync(join(root, 'other'), bytes); symlinkSync(join(root, 'other'), target)}
    else writeFileSync(target, bytes)
    writeFileSync(join(source, 'server.json'), '{"token":"fixture-secret"}')
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-', source, destination],
      {input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']})
    if (kind === 'valid') {run(); assert.equal(readFileSync(join(destination, 'rollback.json'), 'utf8'), bytes)}
    else {assert.throws(run, error => error.status === 1 && !error.stderr.toString().includes('fixture-secret')); assert(!existsSync(join(destination, 'rollback.json')))}
    assert(!existsSync(join(destination, 'server.json')))
  }
})

test('the real manual input gate keeps npm-only validation and candidate replay mutually exclusive', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.slice(workflow.indexOf('      - name: Validate mutually exclusive native inputs'),
    workflow.indexOf('      - uses: actions/checkout'))
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  const common = { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_REF: 'refs/heads/release/1.0.8-beta.1', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/1.0.8-beta.1',
    NPM_NATIVE_VALIDATION: 'false', CANDIDATE_REPLAY: 'false', CANDIDATE_SERVER_ROLLBACK: 'false', NPM_CANDIDATE_TAG: '', NPM_MANIFEST_SHA256: '', NPM_SOURCE_SHA: '',
    CANDIDATE_TAG: '', CANDIDATE_RECEIPT_SHA256: '', CANDIDATE_BUNDLE_SHA256: '' }
  const candidate = { ...common, CANDIDATE_REPLAY: 'true', CANDIDATE_TAG: 'candidate-replay-v1.0.8-beta.1',
    CANDIDATE_RECEIPT_SHA256: 'b'.repeat(64), CANDIDATE_BUNDLE_SHA256: 'c'.repeat(64) }
  const npm = { ...common, NPM_NATIVE_VALIDATION: 'true', NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.8-beta.1',
    NPM_MANIFEST_SHA256: 'd'.repeat(64), NPM_SOURCE_SHA: 'a'.repeat(40) }
  const serverLinux = {...candidate, CANDIDATE_REPLAY: 'false', CANDIDATE_SERVER_ROLLBACK: 'true'}
  const run = env => spawnSync('/bin/bash', ['-e', '-c', script], { env, encoding: 'utf8' })
  for (const env of [common, candidate, npm, serverLinux, {...candidate, CANDIDATE_TAG: 'candidate-replay-v1.0.9'}]) assert.equal(run(env).status, 0)
  for (const env of [{ ...candidate, NPM_NATIVE_VALIDATION: 'true' }, { ...npm, CANDIDATE_REPLAY: 'true' },
    { ...common, CANDIDATE_TAG: candidate.CANDIDATE_TAG }, { ...common, NPM_SOURCE_SHA: npm.NPM_SOURCE_SHA },
    { ...candidate, NPM_SOURCE_SHA: npm.NPM_SOURCE_SHA }, { ...candidate, CANDIDATE_RECEIPT_SHA256: '' },
    { ...candidate, CANDIDATE_TAG: 'candidate-replay-v1.0.8' }, { ...candidate, CANDIDATE_TAG: 'candidate-replay-v1.0.10' },
    { ...candidate, GITHUB_EVENT_NAME: 'pull_request' },
    { ...candidate, GITHUB_REPOSITORY: 'fork/AgentsDock' }, { ...candidate, GITHUB_REF: 'refs/heads/main' },
    { ...candidate, GITHUB_WORKFLOW_REF: `${candidate.GITHUB_WORKFLOW_REF}-other` },
    { ...candidate, GITHUB_SHA: 'main' }, { ...common, CANDIDATE_REPLAY: 'yes' },
    {...serverLinux, CANDIDATE_REPLAY: 'true'}, {...serverLinux, NPM_NATIVE_VALIDATION: 'true'},
    {...serverLinux, CANDIDATE_SERVER_ROLLBACK: 'yes'}, {...serverLinux, CANDIDATE_RECEIPT_SHA256: ''}]) assert.notEqual(run(env).status, 0)
})

test('source CI materializes the pinned Electron runtime before concurrent test imports', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const electron = workflow.slice(workflow.indexOf('\n  electron:'), workflow.indexOf('\n  mobile-source:'))
  const install = electron.indexOf('run: pnpm install --frozen-lockfile')
  const materialize = electron.indexOf('run: node node_modules/electron/install.js')
  const test = electron.indexOf('run: pnpm test')
  assert(install >= 0 && install < materialize && materialize < test)
  assert.match(electron, /name: Materialize Electron runtime before parallel test imports\n        run: node node_modules\/electron\/install.js\n        working-directory: electron/)
})

test('candidate recovery rehearses one exact download failure and retry without production acceptance', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const candidateJob = workflow.slice(workflow.indexOf('  candidate-native:'), workflow.indexOf('  candidate-no-downgrade:'))
  assert.equal((candidateJob.match(/- kind: fresh/g) ?? []).length, 1)
  assert.match(candidateJob, /kind: \[legacy\]\n        legacy_mode: \['0755', '0750'\]/)
  for (const kind of ['recovery', 'stage-recovery']) for (const mode of ['0755', '0750']) {
    assert(candidateJob.includes(`- kind: ${kind}\n            legacy_mode: '${mode}'`))
  }
  assert.match(candidateJob, /--legacy-root-mode "\$LEGACY_MODE"/)
  assert.match(candidateJob, /agents-server-1\.0\.7-beta\.21\.tar\.gz/)
  assert.match(candidateJob, /runs-on: macos-15/)
  assert.match(candidateJob, /if \[\[ "\$CANDIDATE_KIND" == recovery \]\]; then INSTALL_KIND=legacy; fi/)
  assert.match(candidateJob, /bootstrap --candidate --kind "\$INSTALL_KIND"/)
  assert.match(candidateJob, /Configure exact-origin replay[^\n]*\n        if: matrix\.kind != 'fresh'/)
  assert.match(candidateJob, /if \[\[ "\$CANDIDATE_KIND" == recovery \]\]; then\n            fault_args=/)
  assert.match(candidateJob, /--pid-file "\$RUNNER_TEMP\/agentsdock-acceptance-network\/replay.pid" "\$\{fault_args\[@\]\}"/)
  for (const option of ['--fault-control', '--fault-observed']) {
    assert.equal(candidateJob.split(option).length - 1, 2, 'Replay and real failure-retry must share the exact fault paths')
  }
  assert.match(candidateJob, /failure-retry --candidate --kind legacy/)
  assert.match(candidateJob, /diagnose --candidate --kind legacy/)
  assert.match(candidateJob, /Restore disposable routing and trust[^\n]*\n        if: always\(\) && matrix\.kind != 'fresh'/)
  assert.match(candidateJob, /\['recovery.json', 'recovery.json'\]/)
  assert.match(candidateJob, /report\.publicationEligible !== false \|\| report\.releaseAcceptance !== false/)
  assert.match(candidateJob, /constants\.O_NOFOLLOW/)
  assert.match(candidateJob, /stat\.uid !== process\.getuid\(\)/)
  assert.match(candidateJob, /Private fields in public evidence/)
  assert.doesNotMatch(candidateJob, /rollback-retry|secrets\.|id-token: write|npm publish|release create|--clobber/)
  assert(candidateJob.indexOf('uses: ./.github/actions/product-candidate-inputs') < candidateJob.indexOf('bootstrap --candidate'))
  assert(candidateJob.indexOf('Restore disposable routing and trust') < candidateJob.indexOf('uses: actions/upload-artifact'))
})

test('candidate evidence collector only copies bounded sanitized non-publishing recovery observations', t => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.slice(workflow.indexOf('      - name: Collect bounded public observations'))
  const script = section.match(/<<'NODE'\n([\s\S]*?)\n          NODE/)[1].replace(/^          /gm, '')
  for (const kind of ['valid', 'private', 'eligible', 'oversized', 'symlink']) {
    const root = mkdtempSync(join(tmpdir(), 'candidate-evidence-unit-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = join(root, 'source'), output = join(root, 'public')
    mkdirSync(source)
    const report = { kind: 'candidate-server-observations', publicationEligible: false, releaseAcceptance: false }
    if (kind === 'private') report.token = 'fixture-secret-never-published'
    if (kind === 'eligible') report.publicationEligible = true
    if (kind === 'oversized') report.extra = 'x'.repeat(512 * 1024)
    const bytes = `${JSON.stringify(report)}\n`
    const target = join(source, 'recovery.json')
    if (kind === 'symlink') {
      writeFileSync(join(root, 'other.json'), bytes)
      symlinkSync(join(root, 'other.json'), target)
    } else writeFileSync(target, bytes)
    writeFileSync(join(source, 'server.json'), '{"token":"private-fixture"}\n')
    writeFileSync(join(source, 'diagnostics-private.log'), 'private log\n')
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-', source, output], {
      input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    })
    if (kind === 'valid') {
      assert.equal(JSON.parse(run()).publicEvidenceFiles, 1)
      assert.equal(readFileSync(join(output, 'recovery.json'), 'utf8'), bytes)
      assert.equal(statSync(join(output, 'recovery.json')).mode & 0o777, 0o600)
    } else {
      assert.throws(run, error => error.status === 1 && !error.stderr.toString().includes('fixture-secret'))
      assert(!existsSync(join(output, 'recovery.json')))
    }
    assert(!existsSync(join(output, 'server.json')))
    assert(!existsSync(join(output, 'diagnostics-private.log')))
  }
})

test('stable no-downgrade is an isolated pinned fixture, not a weakened positive migration', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const positive = workflow.slice(workflow.indexOf('  candidate-native:'), workflow.indexOf('  candidate-no-downgrade:'))
  const negative = workflow.slice(workflow.indexOf('  candidate-no-downgrade:')).split(/\n  [a-z][a-z0-9-]*:\n/)[0]
  assert.match(negative, /github\.event_name == 'workflow_dispatch'/)
  assert.match(negative, /inputs\.candidate_replay && startsWith\(inputs\.candidate_tag, 'candidate-replay-v1\.0\.8-beta\.'\) && !inputs\.npm_native_validation/)
  assert.match(negative, /github\.repository == 'ZhengyiLuo\/AgentsDock' && startsWith\(github\.ref, 'refs\/heads\/release\/'\)/)
  assert.match(negative, /needs: \[release-tooling, electron, mobile-source\]/)
  assert.match(negative, /runs-on: macos-15/)
  assert.match(negative, /fetch-depth: 0/)
  assert.match(negative, /uses: \.\/\.github\/actions\/product-candidate-inputs/)
  assert.match(negative, /gh release download npm-candidate-v1\.0\.8 --repo ZhengyiLuo\/AgentsDock/)
  assert.match(negative, /--pattern server-1\.0\.8\.tgz --pattern agents-server-npm-manifest\.json --pattern agents-server-npm-manifest\.sig/)
  assert.match(negative, /https:\/\/registry\.npmjs\.org\/@agentsdock\/server\/-\/server-1\.0\.8\.tgz/)
  assert.match(negative, /test "\$STATUS" = 200/)
  assert.match(negative, /cmp "\$RUNNER_TEMP\/no-downgrade-stable\/server-1\.0\.8\.tgz" "\$RUNNER_TEMP\/no-downgrade-registry-server-1\.0\.8\.tgz"/)
  assert.match(negative, /python3 scripts\/product_no_downgrade_server\.py bootstrap/)
  assert.match(negative, /node scripts\/product_no_downgrade_desktop\.mjs/)
  assert.equal(negative.split('--stable-directory "$RUNNER_TEMP/no-downgrade-stable"').length - 1, 2)
  assert.equal(negative.split('--receipt-sha256 "$RECEIPT_SHA256"').length - 1, 2)
  assert.match(negative, /scripts\/verify_electron_release\.sh "\$RUNNER_TEMP\/candidate-inputs\/payload\/desktop" "\$PRODUCT_VERSION" beta/)
  assert(negative.indexOf('gh release download npm-candidate-v1.0.8') < negative.indexOf('product_no_downgrade_server.py bootstrap'))
  assert(negative.indexOf('product_no_downgrade_server.py bootstrap') < negative.indexOf('node scripts/product_no_downgrade_desktop.mjs'))
  assert.doesNotMatch(negative, /product_acceptance_network|--legacy|product-release-replay|failure-retry|NODE_TLS_REJECT_UNAUTHORIZED|security add-trusted-cert|npm publish|release create|--clobber|secrets\./)
  assert.doesNotMatch(positive, /product_no_downgrade|no-downgrade-stable/)
  assert.match(positive, /bootstrap --candidate --kind "\$INSTALL_KIND"/)
})

test('no-downgrade collector admits only its separate bounded non-publishing observations', t => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.slice(workflow.indexOf('      - name: Collect only bounded non-publishing no-downgrade observations'))
  const script = section.match(/<<'NODE'\n([\s\S]*?)\n          NODE/)[1].replace(/^          /gm, '')
  for (const kind of ['valid', 'private', 'eligible', 'acceptance', 'wrong-kind', 'oversized', 'symlink']) {
    const root = mkdtempSync(join(tmpdir(), 'no-downgrade-evidence-unit-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = join(root, 'source'), output = join(root, 'public')
    mkdirSync(join(source, 'desktop'), { recursive: true })
    const report = { kind: 'candidate-no-downgrade-observations', publicationEligible: false, releaseAcceptance: false }
    if (kind === 'private') report.authorization = 'fixture-secret-never-published'
    if (kind === 'eligible') report.publicationEligible = true
    if (kind === 'acceptance') report.releaseAcceptance = true
    if (kind === 'wrong-kind') report.kind = 'candidate-server-observations'
    if (kind === 'oversized') report.extra = 'x'.repeat(512 * 1024)
    const bytes = `${JSON.stringify(report)}\n`
    const target = join(source, 'bootstrap.json')
    if (kind === 'symlink') {
      writeFileSync(join(root, 'other.json'), bytes)
      symlinkSync(join(root, 'other.json'), target)
    } else writeFileSync(target, bytes)
    if (kind === 'valid') {
      writeFileSync(join(source, 'desktop/no-downgrade.json'), bytes)
      writeFileSync(join(source, 'desktop/service-verification.json'), bytes)
    }
    writeFileSync(join(source, 'server.json'), '{"token":"private-fixture"}\n')
    writeFileSync(join(source, 'desktop/native.log'), 'private native log\n')
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-', source, output], {
      input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    })
    if (kind === 'valid') {
      assert.equal(JSON.parse(run()).publicEvidenceFiles, 3)
      for (const file of ['stable-bootstrap.json', 'no-downgrade.json', 'stable-verification.json']) {
        assert.equal(readFileSync(join(output, file), 'utf8'), bytes)
        assert.equal(statSync(join(output, file)).mode & 0o777, 0o600)
      }
    } else {
      assert.throws(run, error => error.status === 1 && !error.stderr.toString().includes('fixture-secret'))
      assert(!existsSync(join(output, 'stable-bootstrap.json')))
    }
    assert(!existsSync(join(output, 'server.json')))
    assert(!existsSync(join(output, 'native.log')))
  }
})
