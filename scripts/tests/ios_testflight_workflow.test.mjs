import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ios-testflight.yml', import.meta.url), 'utf8')

test('upload requires manual canonical hosted dispatch with an exact reviewed source pin', () => {
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && github.repository == 'ZhengyiLuo\/AgentsDock'/)
  assert.match(workflow, /environment: direct-production/)
  assert.match(workflow, /runs-on: macos-26/)
  assert.match(workflow, /test "\$RUNNER_ENVIRONMENT" = github-hosted/)
  assert.match(workflow, /test "\$SOURCE_SHA" = "\$GITHUB_SHA"/)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /branches: \[release\/mobile-goal-queue-190\]/)
  assert.match(workflow, /paths: \[\.github\/workflows\/ios-testflight\.yml\]/)
  assert.match(workflow, /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/)
  assert.equal((workflow.match(/test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/g) ?? []).length, 3)
  assert.doesNotMatch(workflow, /(?:contents|packages|actions): write/)
})

test('source guards fail closed on macOS Bash before any release action', () => {
  const body = workflow.match(/^        run: \|\n((?:          .*\n|\n)+)/m)[1]
    .split('\n').map(line => line.slice(10)).join('\n')
  const valid = {
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    GITHUB_REF: 'refs/heads/release/mobile-goal-queue-190',
    SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40),
  }
  const check = changes => spawnSync('/bin/bash', ['--noprofile', '--norc'], {
    input: body, encoding: 'utf8', env: { ...valid, ...changes },
  })
  assert.equal(check({}).status, 0)
  assert.equal(check({ GITHUB_REF: 'refs/heads/main' }).status, 0)
  for (const changes of [
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'example/AgentsDock' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'Linux' },
    { GITHUB_REF: 'refs/heads/feature/unchecked' }, { GITHUB_REF: 'refs/tags/release/native' },
    { SOURCE_SHA: 'b'.repeat(40) }, { SOURCE_SHA: 'a'.repeat(39), GITHUB_SHA: 'a'.repeat(39) },
  ]) assert.notEqual(check(changes).status, 0, JSON.stringify(changes))
})

test('production build validates native changes before upload and never submits App Store review', () => {
  assert.match(workflow, /AGENTSDOCK_APP_VARIANT: production/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /pnpm verify:ios-native/)
  assert.match(workflow, /pnpm verify:ios-archive-abi/)
  assert.doesNotMatch(workflow, /RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS/)
  assert.match(workflow, /reactnative-core-dSYM-release.tar.gz/)
  assert.match(workflow, /collect-ios-archive-symbols.mjs/)
  assert.match(workflow, /tar -xzf "\$SYMBOLS" -C ios\/Pods\/AgentsDockReleaseSymbols/)
  assert.match(workflow, /test -s "\$APP\/main.jsbundle"/)
  assert.match(workflow, /DEVELOPMENT_TEAM=KRR35MWWHD CODE_SIGN_STYLE=Automatic archive/)
  assert.ok(workflow.indexOf('Validate archive metadata') < workflow.indexOf('Cloud sign and upload'))
  assert.equal((workflow.match(/ios-testflight-metadata.mjs check/g) ?? []).length, 2)
  assert.match(workflow, /ios-testflight-metadata.mjs wait/)
  assert.match(workflow, /ios-testflight-metadata.mjs internal-group/)
  assert.equal((workflow.match(/xcodebuild -quiet -exportArchive/g) ?? []).length, 1)
  assert.match(workflow, /shasum -a 256 -c "\$RUNNER_TEMP\/ios-archive-sha256.txt"/)
  assert.ok(workflow.indexOf('ios-testflight-metadata.mjs wait') < workflow.indexOf('ios-testflight-metadata.mjs internal-group'))
  const uploadConfig = readFileSync(new URL('../config/ios-app-store-upload.plist', import.meta.url), 'utf8')
  assert.match(uploadConfig, /<key>destination<\/key>\s*<string>upload<\/string>/)
  assert.match(uploadConfig, /<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/)
  assert.match(uploadConfig, /<key>method<\/key>\s*<string>app-store-connect<\/string>/)
  assert.doesNotMatch(workflow, /appStoreVersionSubmissions|reviewSubmissions|betaAppReviewSubmissions|gh release|npm publish|upload-artifact/)
})

test('Apple credentials are step-local and disposable, not package-manager environment', () => {
  const install = workflow.split('name: Install locked dependencies')[1].split('      - name:')[0]
  assert.doesNotMatch(install, /secrets\.|APPLE_API/)
  assert.match(workflow, /mode: 0o600/)
  assert.match(workflow, /always\(\) && steps.key.outputs.directory != ''/)
  assert.match(workflow, /assert.ok\(!lstatSync\(directory\).isSymbolicLink\(\)\)/)
  assert.match(workflow, /assert.equal\(dirname\(realpathSync\(directory\)\), realpathSync\(process.env.RUNNER_TEMP\)\)/)
  assert.doesNotMatch(workflow, /MACOS_CERTIFICATE|AGENTSDOCK_RELEASE_TOKEN|set -x|--apple-id|--password/)
  const metadata = readFileSync(new URL('../../mobile-react/scripts/ios-testflight-metadata.mjs', import.meta.url), 'utf8')
  assert.match(metadata, /method: 'GET'/)
  assert.doesNotMatch(metadata, /method: '(?:POST|PATCH|PUT|DELETE)'|betaTesters|relationships\/builds/)
})

test('inline shell and JavaScript parse without running signing or upload', () => {
  const bodies = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)].map(match => match[1].split('\n').map(line => line.slice(10)).join('\n'))
  assert.equal(bodies.length, 9)
  for (const body of bodies) {
    const bash = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n'], { input: body, encoding: 'utf8' })
    assert.equal(bash.status, 0, bash.stderr)
    const js = body.match(/node --input-type=module <<'JS'\n([^]*?)\nJS(?:\n|$)/)?.[1]
    if (js) {
      const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: js, encoding: 'utf8' })
      assert.equal(syntax.status, 0, syntax.stderr)
    }
  }
})
