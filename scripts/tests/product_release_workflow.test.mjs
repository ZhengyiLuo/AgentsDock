import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
const workflow = read('product-release.yml')
const job = name => {
  const section = workflow.split(`\n  ${name}:\n`)[1]
  assert(section, `Missing product job ${name}`)
  return section.split(/\n  [a-z][a-z-]+:\n/)[0]
}

test('only an explicit canonical manual release can prepare or publish', () => {
  assert.match(workflow, /on:\n  workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|workflow_run|schedule|release):/m)
  assert.match(job('validate'), /github\.repository == 'ZhengyiLuo\/AgentsDock'/)
  assert.match(job('validate'), /git merge-base --is-ancestor "\$SOURCE_SHA" "\$WORKFLOW_SHA"/)
  assert.match(job('validate'), /test "\$GITHUB_REF" = "refs\/heads\/\$SOURCE_REF"/)
  assert.match(workflow, /group: agentsdock-product-release\n  cancel-in-progress: false/)
  assert.doesNotMatch(workflow, /secrets: inherit|npm (?:dist-tag|unpublish)|--clobber|release delete/)
})

test('preparation derives version, runs server tests, signs both formats, and mandates pairing', () => {
  assert.match(job('validate'), /product-release\.mjs identity/)
  assert.match(job('server-tests'), /uses: \.\/\.github\/workflows\/server-source.yml/)
  assert.match(job('prepare-server'), /needs: \[validate, prepare-prerequisites, server-tests\]/)
  assert.match(job('prepare-server'), /environment: direct-production/)
  assert.match(job('prepare-server'), /AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64: \$\{\{ secrets\./)
  assert.match(job('prepare-server'), /prepare_product_server.py --source-sha "\$SOURCE_SHA"/)
  assert.match(job('prepare-server'), /--force-with-lease=\$EXPORT_REF:/)
  assert.match(job('prepare-server'), /test "\$EXISTING" = "\$EXPORT_SHA"/)
  assert.match(job('prepare-desktop'), /product_release: true/)
  assert.match(job('prepare-desktop'), /coordinated_manifest_base64:/)
  assert.match(job('prepare-desktop'), /coordinated_signature_base64:/)
  assert.doesNotMatch(job('prepare-server'), /npm publish|legacy-server-release\.mjs publish/)
  assert.doesNotMatch(job('seal-product'), /direct-release-mirror\.mjs publish/)
})

const preparationSecrets = [
  'MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY_P8_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'AGENTSDOCK_RELEASE_TOKEN', 'AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64',
]

test('protected presence-only prerequisites gate expensive preparation after source validation', () => {
  const prerequisites = job('prepare-prerequisites')
  assert.match(prerequisites, /if: inputs\.operation == 'prepare'\n    needs: validate/)
  assert.match(prerequisites, /environment: direct-production/)
  assert.match(prerequisites, /permissions: \{\}/)
  assert.match(prerequisites, /timeout-minutes: 5/)
  assert.doesNotMatch(prerequisites, /uses:|checkout|\bgh |\bcurl |printenv|set -x|GITHUB_OUTPUT|upload-artifact/)
  for (const name of preparationSecrets) {
    assert(prerequisites.includes(`${name}: \${{ secrets.${name} != '' }}`), `${name} must enter the runner as a presence boolean only`)
  }
  assert.equal((prerequisites.match(/\$\{\{ secrets\./g) || []).length, preparationSecrets.length)
  assert.match(job('server-tests'), /needs: \[validate, prepare-prerequisites\]/)
  assert.match(job('prepare-server'), /needs: \[validate, prepare-prerequisites, server-tests\]/)
  assert.match(job('prepare-desktop'), /needs: \[validate, prepare-prerequisites, prepare-server\]/)
  for (const name of ['inspect-product', 'verify-desktop', 'publish-npm', 'publish-product']) {
    assert.doesNotMatch(job(name), /prepare-prerequisites/)
  }
})

test('preparation preflight reports every missing name without printing values or implying validity', () => {
  const script = job('prepare-prerequisites').split('        run: |\n')[1]
    .split('\n').map(line => line.replace(/^          /, '')).join('\n')
  const run = overrides => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    env: { ...Object.fromEntries(preparationSecrets.map(name => [name, 'true'])), SERVER_SIGNING_RUN_ID: '', ...overrides },
    encoding: 'utf8',
  })
  const present = run({})
  assert.equal(present.status, 0, present.stderr)
  assert.match(present.stdout, /Presence does not validate credential contents, token scopes, certificate validity, or npm OIDC configuration/)
  assert.doesNotMatch(present.stdout + present.stderr, /::error::/)
  for (const name of preparationSecrets) {
    const missing = run({ [name]: 'false' })
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, new RegExp(`Missing required direct-production secret: ${name}\\.`))
    assert.equal((missing.stdout.match(/::error::/g) || []).length, 1)
  }
  const absent = run(Object.fromEntries(preparationSecrets.map(name => [name, 'sensitive-sentinel'])))
  assert.equal(absent.status, 1)
  for (const name of preparationSecrets) assert(absent.stdout.includes(`secret: ${name}.`))
  assert.doesNotMatch(absent.stdout + absent.stderr, /sensitive-sentinel|Required secrets are present/)
  const external = run({ AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64: 'false', SERVER_SIGNING_RUN_ID: '42' })
  assert.equal(external.status, 0, external.stdout + external.stderr)
  for (const invalid of ['0', '-1', 'latest', '42\n43']) {
    assert.notEqual(run({ SERVER_SIGNING_RUN_ID: invalid }).status, 0)
  }
})

test('optional external server signer reuses custody without skipping signature/provenance checks', () => {
  assert.match(workflow, /server_signing_run_id:\n        description: Prepare only;/)
  const preparation = job('prepare-server')
  assert.match(preparation, /Build and sign both server distributions[^\n]*\n        if: inputs.server_signing_run_id == ''/)
  assert.match(preparation, /Import exact existing-key server signing artifacts[^\n]*\n        if: inputs.server_signing_run_id != ''/)
  assert.match(preparation, /import_product_server\.mjs extract/)
  assert.match(preparation, /--source-sha "\$SOURCE_SHA" --source-ref "\$SOURCE_REF" --version "\$RELEASE_VERSION"/)
  assert.match(preparation, /--signer-run-id "\$SIGNER_RUN_ID"/)
  const imported = preparation.split('      - name: Import exact existing-key')[1].split('      - id: descriptor')[0]
  assert.doesNotMatch(imported, /PRIVATE_KEY|unzip|extractall|npm publish|gh release/)
  assert(preparation.indexOf('import_product_server.mjs extract') < preparation.indexOf('Expose only public signed descriptor bytes'))
})

test('publication cannot bypass exact receipt and native acceptance or publish npm before desktop verification', () => {
  assert.match(job('inspect-product'), /product-release\.mjs inspect/)
  assert.match(job('inspect-product'), /product-release\.mjs acceptance/)
  assert.match(job('inspect-product'), /legacy-server-release\.mjs inspect/)
  assert.match(job('inspect-product'), /git merge-base --is-ancestor "\$PREPARED_WORKFLOW_SHA" "\$GITHUB_SHA"/)
  assert.match(job('inspect-product'), /run-id: \$\{\{ inputs\.acceptance_run_id \}\}/)
  assert.match(job('verify-desktop'), /needs: inspect-product/)
  assert.match(job('verify-desktop'), /verify_only: true/)
  for (const pin of ['expected_source_sha', 'expected_source_ref', 'expected_manifest_sha256', 'expected_npm_manifest_sha256']) {
    assert(job('verify-desktop').includes(`${pin}:`))
  }
  assert.match(job('publish-npm'), /needs: \[inspect-product, verify-desktop\]/)
  assert.match(job('publish-npm'), /contents: write\n      id-token: write/)
  assert.match(job('publish-product'), /needs: \[inspect-product, verify-desktop, publish-npm\]/)
  const publication = job('publish-product')
  assert(publication.indexOf('legacy-server-release.mjs publish') < publication.indexOf('direct-release-mirror.mjs publish'))
  assert.match(publication, /--coordinated-updates true/)
  assert.match(publication, /--manifest-sha256 "\$DESKTOP_MANIFEST_SHA256"/)
  assert(publication.indexOf('direct-release-mirror.mjs publish') < publication.indexOf('verify_public_desktop_feed.mjs'))
  assert(publication.indexOf('verify_public_desktop_feed.mjs') < publication.indexOf('Record publication completion'))
})

test('reused workflows retain protected environments, distinct locks, exact outputs and cross-tag snapshot', () => {
  const draft = read('direct-desktop-release-draft.yml'), publish = read('direct-desktop-release-publish.yml'), npm = read('server-npm-publish.yml')
  for (const value of [draft, publish, npm]) assert.match(value, /workflow_call:/)
  assert.match(draft, /PIPELINE=product/)
  assert.match(draft, /manifest_sha256:\n        value: \$\{\{ jobs.create-draft.outputs.manifest_sha256 \}\}/)
  assert.match(publish, /verify-seals:/)
  assert.match(publish, /!inputs.verify_only/)
  assert.match(publish, /grep -Fx 'coordinated_updates=true'/)
  assert.match(publish, /EXPECTED_NPM_MANIFEST_SHA256/)
  assert.match(npm, /environment: npm-release/)
  assert.equal((npm.match(/"\$RUNNER_TEMP\/npm-registry-before.json"/g) || []).length, 2)
  assert.doesNotMatch(npm, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.match(job('publish-product'), /concurrency:\n      group: agentsdock-direct-release\n      cancel-in-progress: false/)
  assert.match(read('server-source.yml'), /format\('product-\{0\}', github.run_id\)/)
  assert.match(read('server-source.yml'), /cancel-in-progress: \$\{\{ !inputs.source_sha \}\}/)
})
