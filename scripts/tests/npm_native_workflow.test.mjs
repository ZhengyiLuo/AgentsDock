import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `Missing job: ${name}`)
  const rest = workflow.slice(start + 1)
  const end = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

function runStep(source, name) {
  const section = source.split(`      - name: ${name}\n`)[1]
  assert(section, `Missing step: ${name}`)
  const body = section.split('        run: |\n')[1]
  assert(body, `Missing Bash body: ${name}`)
  const lines = []
  for (const line of body.split('\n')) {
    if (line && !line.startsWith('          ')) break
    lines.push(line.slice(10))
  }
  return lines.join('\n')
}

const tooling = job('release-tooling')
const native = job('npm-native')
const guard = runStep(tooling, 'Validate manual npm-native inputs before any installation')
const download = runStep(native, 'Download only the exact canonical npm draft assets')
const acceptance = runStep(native, 'Verify draft identity and signed bytes before real native npm validation')

function bash(script, env = {}, cwd) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${script}\nprintf 'step-completed\\n'`], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  })
}

function pins(changes = {}) {
  return {
    NPM_NATIVE_VALIDATION: 'true', CANDIDATE_REPLAY: 'false',
    NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.7', NPM_MANIFEST_SHA256: 'a'.repeat(64),
    CANDIDATE_TAG: '', CANDIDATE_RECEIPT_SHA256: '', CANDIDATE_BUNDLE_SHA256: '',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_REF: 'refs/heads/release/1.0.7', GITHUB_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/1.0.7',
    ...changes,
  }
}

function denied(result, label) {
  assert.notEqual(result.status, 0, `${label}: unexpectedly accepted`)
  assert.doesNotMatch(result.stdout, /step-completed/, label)
}

function fixture(t, command) {
  const base = mkdtempSync(join(tmpdir(), 'agentsdock-npm-native-workflow-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const bin = join(base, 'bin')
  const runner = join(base, 'runner temp')
  mkdirSync(bin)
  mkdirSync(runner)
  mkdirSync(join(base, 'server'))
  writeFileSync(join(base, 'server/VERSION'), '1.0.7\n')
  const args = join(base, 'arguments')
  writeFileSync(join(bin, command), '#!/bin/bash\nprintf \'%s\\0\' "$@" >> "$QA_ARGUMENTS"\nprintf \'{}\\n\'\n', { mode: 0o700 })
  return {
    base, runner, args,
    env: { ...pins(), PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, QA_ARGUMENTS: args },
    arguments() { return readFileSync(args, 'utf8').split('\0').slice(0, -1) },
  }
}

test('npm-only validation is explicit, non-cancelling, canonical and hosted on both native platforms', () => {
  assert.match(workflow, /npm_native_validation:\n        description: [^\n]+\n        type: boolean\n        default: false/)
  for (const name of ['npm_candidate_tag', 'npm_manifest_sha256']) {
    assert.match(workflow, new RegExp(`${name}:\\n        description: [^\\n]+\\n        type: string\\n        default: ''`))
  }
  assert.match(workflow, /group: verify-source-\$\{\{ github\.ref \}\}\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.npm_native_validation && '-npm-native' \|\| '' \}\}/)
  assert.match(workflow, /cancel-in-progress: \$\{\{ !\(github\.event_name == 'workflow_dispatch' && \(inputs\.candidate_replay \|\| inputs\.npm_native_validation\)\) \}\}/)
  assert.match(native, /if: github\.event_name == 'workflow_dispatch' && inputs\.npm_native_validation && !inputs\.candidate_replay && github\.repository == 'ZhengyiLuo\/AgentsDock' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/heads\/release\/'\)\)/)
  assert.match(native, /needs: \[release-tooling\]/)
  assert.match(native, /fail-fast: false/)
  assert.match(native, /runner: macos-15\n            platform: darwin/)
  assert.match(native, /runner: ubuntu-24.04\n            platform: linux/)
  assert.match(native, /runs-on: \$\{\{ matrix\.runner \}\}/)
  assert.doesNotMatch(native, /self-hosted|continue-on-error|environment: npm-release|id-token: write|secrets\./)
})

test('npm mode skips app jobs without weakening the existing candidate or product acceptance gates', () => {
  for (const name of ['electron', 'mobile-source']) {
    assert.match(job(name), /if: \$\{\{ !\(github\.event_name == 'workflow_dispatch' && \(inputs\.npm_native_validation \|\| inputs\.npm_candidate_tag != '' \|\| inputs\.npm_manifest_sha256 != ''\)\) \}\}/)
  }
  const candidate = job('candidate-native')
  assert.match(candidate, /inputs\.candidate_replay && !inputs\.npm_native_validation/)
  assert.match(candidate, /needs: \[release-tooling, electron, mobile-source\]/)
  assert.match(candidate, /kind: \[fresh, legacy\]/)
  assert.match(candidate, /product_server_acceptance\.py bootstrap --candidate/)
  assert.match(candidate, /product_desktop_acceptance\.mjs --scope candidate/)
  assert.match(tooling, /node --test scripts\/tests\/\*\.test\.mjs server\/npm\/cli\.test\.cjs/)
  assert.doesNotMatch(native, /product-acceptance\.mjs|product_desktop_acceptance|product_acceptance_network|--scope candidate|--kind legacy/)
})

test('the fail-closed manual guard runs before checkout, runtimes and any installation', () => {
  assert.match(tooling, /steps:\n      - name: Validate manual npm-native inputs before any installation\n        if: github\.event_name == 'workflow_dispatch'\n/)
  assert(tooling.indexOf('test "$NPM_NATIVE_VALIDATION" = true') < tooling.indexOf('uses: actions/checkout@'))
  assert.doesNotMatch(guard, /\$\{\{|npm install|uv python|brew |apt-get /)
  for (const ref of ['main', 'release/1.0.7', 'release/npm/stable-1.0.7']) {
    const result = bash(guard, pins({
      GITHUB_REF: `refs/heads/${ref}`,
      GITHUB_WORKFLOW_REF: `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${ref}`,
    }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'step-completed\n')
  }
  assert.equal(bash(guard, pins({ NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.7-beta.5' })).status, 0)
})

test('ordinary manual and candidate modes remain valid only without npm-only pins', () => {
  const ordinary = pins({ NPM_NATIVE_VALIDATION: 'false', NPM_CANDIDATE_TAG: '', NPM_MANIFEST_SHA256: '' })
  const candidate = { ...ordinary, CANDIDATE_REPLAY: 'true', CANDIDATE_TAG: 'candidate-replay-v1.0.7-beta.5',
    CANDIDATE_RECEIPT_SHA256: 'c'.repeat(64), CANDIDATE_BUNDLE_SHA256: 'd'.repeat(64) }
  for (const env of [ordinary, candidate]) {
    const result = bash(guard, env)
    assert.equal(result.status, 0, result.stderr)
    for (const change of [
      { NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.7' }, { NPM_MANIFEST_SHA256: 'a'.repeat(64) },
      { NPM_NATIVE_VALIDATION: '' }, { NPM_NATIVE_VALIDATION: 'invalid' },
      { CANDIDATE_REPLAY: '' }, { CANDIDATE_REPLAY: 'invalid' },
    ]) denied(bash(guard, { ...env, ...change }), JSON.stringify(change))
  }
})

test('manual guard rejects mixed modes, incompatible pins, foreign identities and malformed input', () => {
  for (const change of [
    { NPM_NATIVE_VALIDATION: 'false' }, { NPM_NATIVE_VALIDATION: '' },
    { CANDIDATE_REPLAY: 'true' }, { CANDIDATE_REPLAY: '' },
    { CANDIDATE_TAG: 'candidate-replay-v1.0.7-beta.5' },
    { CANDIDATE_RECEIPT_SHA256: 'a'.repeat(64) }, { CANDIDATE_BUNDLE_SHA256: 'a'.repeat(64) },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'someone/AgentsDock' },
    { GITHUB_REF: 'refs/heads/feature/npm' }, { GITHUB_REF: 'refs/tags/v1.0.7' },
    { GITHUB_REF: 'refs/heads/release/../main' }, { GITHUB_REF: 'refs/heads/release/a.lock' },
    { GITHUB_REF: 'refs/heads/release//other' }, { GITHUB_REF: 'refs/heads/release/a.' },
    { GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/server-npm-publish.yml@refs/heads/release/1.0.7' },
    { GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/main' },
    { GITHUB_SHA: '' }, { GITHUB_SHA: 'b'.repeat(39) }, { GITHUB_SHA: 'B'.repeat(40) },
    { NPM_CANDIDATE_TAG: '' }, { NPM_CANDIDATE_TAG: 'v1.0.7' },
    { NPM_CANDIDATE_TAG: 'npm-candidate-v01.0.7' }, { NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.7-beta.0' },
    { NPM_CANDIDATE_TAG: 'npm-candidate-v1.0.7; touch unexpected' },
    { NPM_MANIFEST_SHA256: '' }, { NPM_MANIFEST_SHA256: 'a'.repeat(63) }, { NPM_MANIFEST_SHA256: 'A'.repeat(64) },
  ]) denied(bash(guard, pins(change)), JSON.stringify(change))
})

test('draft reads have minimal authority and download exactly the signed descriptor, signature and versioned tarball', t => {
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  assert.match(native, /permissions:\n      contents: write # GitHub requires push access to read an unpublished draft\./)
  assert.equal((native.match(/GH_TOKEN:/g) ?? []).length, 1)
  assert.match(native, /name: Download only the exact canonical npm draft assets\n        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(native, /persist-credentials: false/)
  const f = fixture(t, 'gh')
  const result = bash(download, f.env, f.base)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.arguments(), [
    'release', 'view', 'npm-candidate-v1.0.7', '--repo', 'ZhengyiLuo/AgentsDock',
    '--json', 'tagName,isDraft,targetCommitish,body,assets',
    'release', 'download', 'npm-candidate-v1.0.7', '--repo', 'ZhengyiLuo/AgentsDock',
    '--dir', `${f.runner}/npm-native-inputs/npm`,
    '--pattern', 'agents-server-npm-manifest.json', '--pattern', 'agents-server-npm-manifest.sig', '--pattern', 'server-1.0.7.tgz',
  ])
  assert.equal(readFileSync(join(f.runner, 'npm-native-inputs/release.json'), 'utf8'), '{}\n')
  assert.doesNotMatch(download, /--clobber|\$\{\{|release (create|edit|upload|delete)/)
})

test('mismatched draft tags and unsafe source versions fail before any download or output directory creation', t => {
  const f = fixture(t, 'gh')
  for (const tag of ['', 'npm-candidate-v1.0.6', 'v1.0.7', 'npm-candidate-v1.0.7 --clobber']) {
    denied(bash(download, { ...f.env, NPM_CANDIDATE_TAG: tag }, f.base), tag)
  }
  for (const version of ['01.0.7', '../1.0.7', '1.0.7-beta.0', '1.0.7\nextra']) {
    writeFileSync(join(f.base, 'server/VERSION'), `${version}\n`)
    denied(bash(download, { ...f.env, NPM_CANDIDATE_TAG: `npm-candidate-v${version}` }, f.base), version)
  }
  assert.equal(existsSync(f.args), false)
  assert.equal(existsSync(join(f.runner, 'npm-native-inputs')), false)
})

test('native prerequisites use Node 24, uv and real hosted launchd/systemd without trust or routing changes', () => {
  assert.match(native, /uses: actions\/setup-node@[a-f0-9]{40}[^\n]*\n        with:\n          node-version: 24\n          package-manager-cache: false/)
  assert.match(native, /uses: astral-sh\/setup-uv@v6\n        with:\n          enable-cache: false/)
  assert.match(native, /uv python install 3\.13/)
  assert.match(native, /sudo apt-get install -y tmux/)
  assert.match(native, /sudo loginctl enable-linger "\$\(id -un\)"/)
  assert.match(native, /systemctl --user show-environment/)
  assert.match(native, /command -v tmux \|\| brew install tmux/)
  assert.match(native, /\/bin\/launchctl print "gui\/\$\(id -u\)"/)
  assert.doesNotMatch(native, /SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|\/etc\/hosts|add-trusted-cert|trust\.env|replay\.mjs|sudo env/)
})

test('only the guarded helper receives exact source and manifest pins, with a separate sanitized report', t => {
  const f = fixture(t, 'python3')
  const env = { ...f.env, GITHUB_REF_NAME: 'release/1.0.7', TEST_PLATFORM: 'linux' }
  const result = bash(acceptance, env, f.base)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.arguments(), [
    'scripts/npm_native_acceptance.py', '--assets', `${f.runner}/npm-native-inputs/npm`,
    '--release', `${f.runner}/npm-native-inputs/release.json`,
    '--source-sha', env.GITHUB_SHA, '--source-ref', env.GITHUB_REF_NAME,
    '--manifest-sha256', env.NPM_MANIFEST_SHA256,
    '--work', `${f.runner}/agentsdock-npm-native-linux`, '--report', `${f.runner}/npm-native-public/report-linux.json`,
  ])
  assert.match(native, /PYTHONDONTWRITEBYTECODE: '1'/)
  assert.match(native, /NPM_NATIVE_VALIDATION: \$\{\{ inputs\.npm_native_validation \}\}/)
  assert.match(native, /CANDIDATE_REPLAY: \$\{\{ inputs\.candidate_replay \}\}/)
  assert.doesNotMatch(native, /npm (install|publish|pack|dist-tag)|git push|release (create|edit|upload)|--fixture|--baseline/)
  assert.doesNotMatch(acceptance, /GH_TOKEN|\$\{\{/)
})

test('artifact upload contains only the scoped public report, never fixture state or credentials', () => {
  assert.equal((native.match(/uses: actions\/upload-artifact@/g) ?? []).length, 1)
  assert.match(native, /uses: actions\/upload-artifact@[a-f0-9]{40}[^\n]*\n        if: always\(\)/)
  assert.match(native, /name: npm-native-validation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.platform \}\}/)
  assert.deepEqual(native.split('\n').filter(line => /^          path:/.test(line)), [
    '          path: ${{ runner.temp }}/npm-native-public/report-${{ matrix.platform }}.json',
  ])
  assert.match(native, /if-no-files-found: warn\n          retention-days: 14/)
  assert.doesNotMatch(native, /cp |tee |upload-hidden-files|include-hidden-files/)
})

test('all added Bash bodies parse without executing native or network operations', () => {
  for (const script of [guard, download, acceptance, runStep(native, 'Prepare disposable native npm prerequisites')]) {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})
