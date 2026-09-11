import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveIosWorkspace } from '../scripts/resolve-ios-workspace.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-workspace-resolution-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

for (const name of ['AgentsDock', 'AgentsDockReact', 'Custom App']) {
  test(`resolves the generated ${name} workspace`, t => {
    const root = fixture(t)
    fs.mkdirSync(path.join(root, `${name}.xcworkspace`))
    fs.mkdirSync(path.join(root, 'Pods', 'Pods.xcodeproj', 'project.xcworkspace'), { recursive: true })
    fs.writeFileSync(path.join(root, 'unrelated.xcworkspace'), '')
    assert.equal(resolveIosWorkspace(root), path.join(root, `${name}.xcworkspace`, 'contents.xcworkspacedata'))
  })
}

test('rejects missing and ambiguous generated workspaces', t => {
  const root = fixture(t)
  assert.throws(() => resolveIosWorkspace(path.join(root, 'missing')), /exactly one generated iOS workspace/)
  assert.throws(() => resolveIosWorkspace(root), /exactly one generated iOS workspace/)
  fs.mkdirSync(path.join(root, 'First.xcworkspace'))
  fs.mkdirSync(path.join(root, 'Second.xcworkspace'))
  assert.throws(() => resolveIosWorkspace(root), /exactly one generated iOS workspace/)
})
