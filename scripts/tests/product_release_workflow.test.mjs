import assert from 'node:assert/strict'
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
  assert.match(job('prepare-server'), /needs: \[validate, server-tests\]/)
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
