import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  assert.match(inputs, /--source-sha "\$ARTIFACT_SOURCE_SHA" --candidate-rehearsal true/)
  assert.doesNotMatch(inputs, /export GITHUB_SHA=|GITHUB_SHA:|--source-sha "\$GITHUB_SHA"/)
  assert.match(inputs, /for pair in AgentsDock-Releases:1\.0\.6 AgentsServer:1\.0\.7-beta\.21/)
  assert.match(inputs, /baseline\.isPrerelease === process\.argv\[3\]\.includes\('-beta\.'\)/)
  assert.match(inputs, /gh release download v1\.0\.7-beta\.21 --repo ZhengyiLuo\/AgentsServer/)
  assert.match(inputs, /gh release download v1\.0\.6 --repo ZhengyiLuo\/AgentsDock-Releases/)
  assert.doesNotMatch(inputs, /AgentsDock-Releases:1\.0\.7-beta|AgentsServer:1\.0\.3/)
  assert.match(candidateJob, /\$\{\{ matrix\.kind \}\}-\$\{\{ matrix\.legacy_mode \}\}/)
})

test('the real manual input gate keeps npm-only validation and candidate replay mutually exclusive', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.slice(workflow.indexOf('      - name: Validate mutually exclusive native inputs'),
    workflow.indexOf('      - uses: actions/checkout'))
  const script = section.split('        run: |\n')[1].replace(/^          /gm, '')
  const common = { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_REF: 'refs/heads/release/1.0.8-beta.1', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/1.0.8-beta.1',
    NPM_NATIVE_VALIDATION: 'false', CANDIDATE_REPLAY: 'false', NPM_CANDIDATE_TAG: '', NPM_MANIFEST_SHA256: '', NPM_SOURCE_SHA: '',
    CANDIDATE_TAG: '', CANDIDATE_RECEIPT_SHA256: '', CANDIDATE_BUNDLE_SHA256: '' }
  const candidate = { ...common, CANDIDATE_REPLAY: 'true', CANDIDATE_TAG: 'candidate-replay-v1.0.8-beta.1',
    CANDIDATE_RECEIPT_SHA256: 'b'.repeat(64), CANDIDATE_BUNDLE_SHA256: 'c'.repeat(64) }
  const npm = { ...common, NPM_NATIVE_VALIDATION: 'true', NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.8-beta.1',
    NPM_MANIFEST_SHA256: 'd'.repeat(64), NPM_SOURCE_SHA: 'a'.repeat(40) }
  const run = env => spawnSync('/bin/bash', ['-e', '-c', script], { env, encoding: 'utf8' })
  for (const env of [common, candidate, npm]) assert.equal(run(env).status, 0)
  for (const env of [{ ...candidate, NPM_NATIVE_VALIDATION: 'true' }, { ...npm, CANDIDATE_REPLAY: 'true' },
    { ...common, CANDIDATE_TAG: candidate.CANDIDATE_TAG }, { ...common, NPM_SOURCE_SHA: npm.NPM_SOURCE_SHA },
    { ...candidate, NPM_SOURCE_SHA: npm.NPM_SOURCE_SHA }, { ...candidate, CANDIDATE_RECEIPT_SHA256: '' },
    { ...candidate, CANDIDATE_TAG: 'candidate-replay-v1.0.8' }, { ...candidate, GITHUB_EVENT_NAME: 'pull_request' },
    { ...candidate, GITHUB_REPOSITORY: 'fork/AgentsDock' }, { ...candidate, GITHUB_REF: 'refs/heads/main' },
    { ...candidate, GITHUB_WORKFLOW_REF: `${candidate.GITHUB_WORKFLOW_REF}-other` },
    { ...candidate, GITHUB_SHA: 'main' }, { ...common, CANDIDATE_REPLAY: 'yes' }]) assert.notEqual(run(env).status, 0)
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
  const candidateJob = workflow.slice(workflow.indexOf('  candidate-native:'))
  assert.equal((candidateJob.match(/- kind: fresh/g) ?? []).length, 1)
  for (const kind of ['legacy', 'recovery']) for (const mode of ['0755', '0750']) {
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
  const negative = workflow.slice(workflow.indexOf('  candidate-no-downgrade:'))
  assert.match(negative, /github\.event_name == 'workflow_dispatch' && inputs\.candidate_replay && !inputs\.npm_native_validation/)
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
