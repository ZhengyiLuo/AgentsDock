import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ios-mobile-qa.yml', import.meta.url), 'utf8')
const shellBodies = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)]
  .map(match => match[1].split('\n').map(line => line.slice(10)).join('\n'))
const guard = shellBodies[0]

test('only a canonical manually dispatched exact SHA may prepare a native QA app', () => {
  assert.match(workflow, /branches: \[release\/mobile-goal-queue-190\]/)
  assert.match(workflow, /paths: \[\.github\/workflows\/ios-mobile-qa\.yml\]/)
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && github\.repository == 'ZhengyiLuo\/AgentsDock' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/heads\/release\/'\)\)/)
  assert.match(workflow, /runs-on: macos-26/)
  assert.match(workflow, /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.equal((workflow.match(/test "\$RUNNER_ENVIRONMENT" = github-hosted/g) ?? []).length, 2)
  assert.equal((workflow.match(/\[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/g) ?? []).length, 2)
  assert.equal((workflow.match(/test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/g) ?? []).length, 3)
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(match => match[1])
  assert.deepEqual(actions, [
    'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ])
})

test('dispatch shell guard rejects push, forks, unreviewed refs, mismatched SHA and self-hosted runners', () => {
  const valid = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'macOS',
    GITHUB_REF: 'refs/heads/release/mobile-goal-queue-190',
    SOURCE_SHA: 'a'.repeat(40),
    GITHUB_SHA: 'a'.repeat(40),
  }
  const check = changes => spawnSync('/bin/bash', ['--noprofile', '--norc'], {
    input: guard, encoding: 'utf8', env: { ...valid, ...changes },
  })
  assert.equal(check({}).status, 0)
  assert.equal(check({ GITHUB_REF: 'refs/heads/main' }).status, 0)
  for (const changes of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'example/AgentsDock' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Linux' },
    { GITHUB_REF: 'refs/heads/feature/native' },
    { GITHUB_REF: 'refs/tags/release/native' },
    { SOURCE_SHA: 'b'.repeat(40) },
    { SOURCE_SHA: 'a'.repeat(39), GITHUB_SHA: 'a'.repeat(39) },
    { SOURCE_SHA: 'A'.repeat(40), GITHUB_SHA: 'A'.repeat(40) },
    { SOURCE_SHA: `a${'\n'}${'a'.repeat(39)}`, GITHUB_SHA: `a${'\n'}${'a'.repeat(39)}` },
  ]) assert.notEqual(check(changes).status, 0, JSON.stringify(changes))
})

test('dependency generation and native verification precede an unsigned Simulator-only build', () => {
  assert.match(workflow, /contents: read/)
  assert.doesNotMatch(workflow, /(?:contents|packages|actions|id-token): write|secrets\.|environment:|APPLE_API|AUTHENTICATION|DEVELOPMENT_TEAM|allowProvisioningUpdates|altool|exportArchive|archivePath|github-script|gh release|npm publish|fastlane|appStoreVersionSubmissions|betaAppReviewSubmissions/)
  assert.match(workflow, /AGENTSDOCK_APP_VARIANT: production/)
  assert.match(workflow, /version: 11\.9\.0/)
  assert.match(workflow, /node-version: 24/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /pnpm typecheck/)
  assert.match(workflow, /pnpm exec expo prebuild --platform ios --no-install/)
  assert.match(workflow, /pod install --project-directory=ios/)
  assert.match(workflow, /pnpm verify:ios-native/)
  assert.match(workflow, /pnpm verify:ios-archive-abi "\$APP"/)
  assert.match(workflow, /-workspace ios\/AgentsDock\.xcworkspace -scheme AgentsDock/)
  assert.match(workflow, /-configuration Release -sdk iphonesimulator/)
  assert.match(workflow, /-destination 'generic\/platform=iOS Simulator'/)
  assert.match(workflow, /ARCHS=arm64 ONLY_ACTIVE_ARCH=YES/)
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= build/)
  assert.match(workflow, /-derivedDataPath "\$RUNNER_TEMP\/agentsdock-ios-qa-derived-data"/)
  assert.ok(workflow.indexOf('pnpm verify:ios-native') < workflow.indexOf('xcodebuild -quiet'))
  assert.ok(workflow.indexOf('pnpm verify:ios-archive-abi') < workflow.indexOf('uses: actions/upload-artifact@'))
})

test('artifact is exactly the app and manifest, with source and program hashes but no runtime state', () => {
  assert.equal((workflow.match(/uses: actions\/upload-artifact@/g) ?? []).length, 1)
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/agentsdock-ios-simulator-qa\.tar\.gz/)
  assert.match(workflow, /-C "\$STAGE" AgentsDock\.app manifest\.json/)
  assert.match(workflow, /sourceCommit: process\.env\.SOURCE_SHA/)
  assert.match(workflow, /javascriptSHA256: sha256\(path\.join\(app, 'main\.jsbundle'\)\)/)
  assert.match(workflow, /executableSHA256: sha256\(path\.join\(app, info\.CFBundleExecutable\)\)/)
  assert.match(workflow, /nativeAcceptance: 'pending'/)
  assert.match(workflow, /assert\.deepEqual\(info\.CFBundleSupportedPlatforms, \['iPhoneSimulator'\]\)/)
  assert.match(workflow, /if-no-files-found: error/)
  assert.match(workflow, /retention-days: 7/)
  const upload = workflow.slice(workflow.indexOf('      - name: Retain only'))
  assert.doesNotMatch(upload, /always\(\)|node_modules|Pods|DerivedData|\.env|QAConfig|\*\*/)
})

test('inline shell and manifest JavaScript parse without building, signing or network access', () => {
  assert.equal(shellBodies.length, 6)
  let javaScriptBodies = 0
  for (const body of shellBodies) {
    const bash = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n'], { input: body, encoding: 'utf8' })
    assert.equal(bash.status, 0, bash.stderr)
    const js = body.match(/node --input-type=module <<'JS'\n([^]*?)\nJS(?:\n|$)/)?.[1]
    if (!js) continue
    javaScriptBodies++
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: js, encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
  }
  assert.equal(javaScriptBodies, 1)
})
