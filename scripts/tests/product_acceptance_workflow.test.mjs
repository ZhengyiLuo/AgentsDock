import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/product-release-acceptance.yml', import.meta.url), 'utf8')
const inputs = readFileSync(new URL('../../.github/actions/product-acceptance-inputs/action.yml', import.meta.url), 'utf8')

test('native acceptance is explicit, hosted, exact-source and has no signing or publishing authority', () => {
  assert.match(workflow, /on:\n  workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m)
  assert.match(workflow, /contents: read\n  actions: read/)
  assert.doesNotMatch(workflow, /secrets\.|contents: write|id-token: write|self-hosted|npm publish|release create|continue-on-error/)
  assert.match(inputs, /grep -Fx "source_sha=\$GITHUB_SHA"/)
  assert.match(inputs, /product-release\.mjs inspect/)
  assert.match(inputs, /product-release-replay\.mjs inspect/)
  assert.match(inputs, /--name "AgentsDock-\$PRODUCT_VERSION-verified"/)
  assert.doesNotMatch(inputs, /npm publish|git push|--clobber/)
})

test('fresh installs and both legacy layouts run on actual native services and packages', () => {
  assert.match(workflow, /runner: ubuntu-24.04\n            platform: linux/)
  assert.match(workflow, /runner: macos-15\n            platform: darwin/)
  assert.match(workflow, /legacy_mode: \['0755', '0750'\]/)
  assert.match(workflow, /product_server_acceptance\.py bootstrap --kind fresh/)
  assert.match(workflow, /product_server_acceptance\.py bootstrap --kind legacy/)
  assert.match(workflow, /node scripts\/product_desktop_acceptance\.mjs/)
  assert.match(workflow, /--output "\$RUNNER_TEMP\/agentsdock-acceptance-legacy\/desktop"/)
  assert.match(workflow, /operation: failure-retry/)
  assert.match(workflow, /operation: rollback-retry/)
  assert.match(workflow, /product_server_acceptance\.py "\$RECOVERY_OPERATION"/)
})

test('only sanitized evidence is uploaded after owned trust and routing cleanup', () => {
  assert.match(workflow, /Restore native trust and routing before artifact upload\n        if: always\(\)/)
  assert.match(workflow, /product_acceptance_network\.py teardown/)
  assert.match(workflow, /kill -TERM "\$REPLAY_PID"/)
  assert.match(workflow, /launchctl unsetenv SSL_CERT_FILE/)
  assert.match(workflow, /tmux set-environment -gu SSL_CERT_FILE/)
  assert.match(workflow, /systemctl --user unset-environment SSL_CERT_FILE NODE_EXTRA_CA_CERTS/)
  for (const line of workflow.split('\n').filter(line => /^          path:/.test(line))) {
    assert(!line.includes('private.log') && !line.includes('network') && !line.includes('server.json'))
  }
})

test('collector requires successful native jobs and same-attempt reports before publishing acceptance', () => {
  assert.match(workflow, /needs: \[native-server, native-desktop, native-recovery\]/)
  assert.match(workflow, /pattern: native-acceptance-\$\{\{ github.run_attempt \}\}-\*/)
  assert.match(workflow, /node scripts\/product-acceptance\.mjs product\/release.json/)
  assert.match(workflow, /name: AgentsDock-\$\{\{ steps.report.outputs.version \}\}-acceptance/)
  assert.doesNotMatch(workflow, /checks:.*passed|echo.*passed|result.*passed/)
})
