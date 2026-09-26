import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../server/.github/workflows/server-npm-candidate.yml', import.meta.url), 'utf8')
const step = name => {
  const section = workflow.split(`      - name: ${name}\n`)[1]
  assert(section, `Missing signing step: ${name}`)
  return section.split(/\n      - (?:name:|uses:)/)[0]
}

test('product signing is opt-in on both existing entry points and retains read-only CI permissions', () => {
  assert.equal((workflow.match(/      product_bundle:\n/g) || []).length, 2)
  assert.equal((workflow.match(/      product_bundle:\n(?:        description:[^\n]*\n)?        type: boolean\n        default: false/g) || []).length, 2)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /group: agentsdock-npm-candidate-signing\n  cancel-in-progress: false/)
  assert.match(workflow, /github\.repository == 'ZhengyiLuo\/AgentsServer'/)
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|schedule|release):/m)
  assert.doesNotMatch(workflow, /contents: write|id-token: write|secrets: inherit|GH_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN/)
})

test('default npm preparation, signature, inspection and exact three-file artifact remain separate', () => {
  for (const name of ['Prepare the exact clean candidate once', 'Sign and verify the exact prepared descriptor',
    'Inspect the signed bundle without publication or acceptance', 'Preserve only the signed candidate bundle', 'Record preparation status']) {
    assert.match(step(name), /if: \$\{\{ !inputs\.product_bundle \}\}/)
  }
  assert.match(step('Prepare the exact clean candidate once'), /package_npm_release\.py --output "\$RUNNER_TEMP\/npm-candidate" --require-clean-source/)
  const original = step('Preserve only the signed candidate bundle')
  assert.match(original, /name: signed-npm-server-\$\{\{ inputs\.version \}\}-\$\{\{ inputs\.source_sha \}\}/)
  assert.equal((original.match(/\$\{\{ runner.temp \}\}\/npm-candidate\//g) || []).length, 3)
})

test('signer pins canonical SHA, branch ancestry, version, trust root and exact standalone export tree', () => {
  const inputs = step('Require controlled workflow branch and reviewed source inputs')
  assert(inputs.includes('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]'))
  assert(inputs.includes('git check-ref-format "refs/heads/$SOURCE_REF"'))
  const ancestry = step('Verify canonical ancestry, version and established signing key')
  for (const guard of ['test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/npm-reviewed',
    'test "$(cat server/VERSION)" = "$RELEASE_VERSION"',
    'cmp "$GITHUB_WORKSPACE/release-public-key.pem" server/release-public-key.pem',
    'git status --porcelain --untracked-files=normal']) assert(ancestry.includes(guard))
  const exported = step('Bind product signing workflow to the exact canonical server export')
  assert.match(exported, /if: inputs.product_bundle/)
  assert(exported.includes('git -C "$GITHUB_WORKSPACE" rev-parse \'HEAD^{tree}\''))
  assert(exported.includes('git rev-parse "$SOURCE_SHA:server"'))
})

test('secret is limited to signing; two clean preparations are independently compared before upload', () => {
  const tests = step('Test the product bundle helper and deterministic legacy packaging')
  assert.doesNotMatch(tests, /secrets\.|PRIVATE_KEY/)
  assert.match(tests, /test_prepare_product_server\.py/)
  assert.match(tests, /test_package_release_reproducibility\.py/)
  const signing = step('Prepare both signed formats twice from the exact clean canonical source')
  assert.match(signing, /if: inputs.product_bundle/)
  assert.match(signing, /working-directory: release-source/)
  assert.match(signing, /AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64: \$\{\{ secrets\.AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64 \}\}/)
  assert.equal((signing.match(/python3 scripts\/prepare_product_server.py --source-sha "\$SOURCE_SHA" --version "\$RELEASE_VERSION" --output "\$RUNNER_TEMP\/product-server(?:-repeat)?"/g) || []).length, 2)
  assert.doesNotMatch(signing, /set -x|echo.*PRIVATE|printf.*PRIVATE|base64 --decode/)
  const verification = step('Independently verify signatures, exact runtime and byte-identical preparation')
  assert.doesNotMatch(verification, /secrets\.|PRIVATE_KEY/)
  assert.match(verification, /await verifyLegacyCandidate\(/)
  assert.match(verification, /Object.keys\(receipt.artifacts\).sort\(\), assets/)
  assert.match(verification, /readFileSync\(join\(directory, name\)\).equals\(readFileSync\(join\(repeated, name\)\)\)/)
  assert.match(verification, /PRODUCT_SERVER_BUNDLE_SHA256=/)
})

test('artifact allowlist contains only six public assets and receipt, with immutable attempt-specific name', () => {
  const upload = step('Preserve only the seven public product server bundle files')
  assert.match(upload, /if: inputs.product_bundle/)
  assert.match(upload, /github.run_id \}\}-\$\{\{ github.run_attempt \}\}/)
  const paths = [...upload.matchAll(/\$\{\{ runner.temp \}\}\/product-server\/([^\n]+)/g)].map(match => match[1])
  assert.deepEqual(paths, ['product-server-bundle.json', 'npm/agents-server-npm-manifest.json', 'npm/agents-server-npm-manifest.sig',
    'npm/server-${{ inputs.version }}.tgz', 'legacy/agents-server-manifest.json', 'legacy/agents-server-manifest.sig',
    'legacy/agents-server-${{ inputs.version }}.tar.gz'])
  assert.doesNotMatch(upload, /\*|\.pem|PRIVATE_KEY|key_file|release-source|product-server-repeat|overwrite:/)
  assert.match(upload, /if-no-files-found: error/)
  assert(workflow.indexOf('Independently verify signatures') < workflow.indexOf('Preserve only the seven public'))
})

test('CI-only signer cannot publish, stage drafts, export source, install or deploy services', () => {
  assert.doesNotMatch(workflow, /gh\s+release|npm\s+(?:publish|login|dist-tag|unpublish)|git\s+(?:push|subtree)|(?:legacy-server-release|npm-candidate-release|direct-release-mirror)\.mjs\s+(?:stage|publish)/)
  assert.doesNotMatch(workflow, /(?:\.\/|bash\s+)(?:install|deploy)\.sh|systemctl|launchctl|ssh\s|scp\s/)
  assert.match(step('Record local-test-only product preparation'), /not native update acceptance/)
})
