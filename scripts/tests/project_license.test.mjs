import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const json = (path) => JSON.parse(read(path))

test('project license is the unmodified Apache License 2.0 text', () => {
  // https://www.apache.org/licenses/LICENSE-2.0.txt
  assert.equal(
    createHash('sha256').update(read('LICENSE')).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
  )
  assert.match(read('NOTICE'), /Copyright 2026 Zhengyi Luo and contributors/)
  assert.match(read('README.md'), /\[Apache License 2\.0\]\(LICENSE\)/)
})

test('first-party package metadata declares Apache-2.0', () => {
  for (const path of ['electron/package.json', 'mobile-react/package.json', 'website/package.json']) {
    assert.equal(json(path).license, 'Apache-2.0', path)
  }
  assert.match(read('team-hub/pyproject.toml'), /^license = \{text = "Apache-2\.0"\}$/m)
})

test('Electron packages include project notices without replacing vendor licenses', () => {
  const resources = json('electron/package.json').build.extraResources
  for (const name of ['LICENSE', 'NOTICE']) {
    assert.ok(resources.some(resource =>
      resource.from === `../${name}` && resource.to === `licenses/AgentsDock-${name}`
    ), `${name} must be copied from the repository into the packaged resources`)
    assert.ok(read(name).length > 0)
  }
})

test('separately licensed mobile components retain their MIT notices', () => {
  assert.match(read('mobile-react/LICENSE'), /650 Industries, Inc\. \(aka Expo\)/)
  assert.match(read('mobile-react/LICENSE'), /Permission is hereby granted, free of charge/)
  assert.match(
    read('mobile-react/modules/agentsdock-native-terminal/ios/Vendor/SwiftTerm/LICENSE'),
    /Permission is hereby granted, free of charge/
  )
  for (const module of ['agentsdock-native-video', 'agentsdock-native-terminal', 'agentsdock-android-updater']) {
    assert.equal(json(`mobile-react/modules/${module}/package.json`).license, 'MIT')
    assert.ok(read('NOTICE').includes(module))
  }
})
