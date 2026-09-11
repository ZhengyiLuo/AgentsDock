import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export function resolveIosWorkspace(iosDirectory) {
  const workspaces = fs.existsSync(iosDirectory)
    ? fs.readdirSync(iosDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.xcworkspace'))
      .map(entry => entry.name)
    : []
  assert.equal(workspaces.length, 1, 'Expected exactly one generated iOS workspace; run Expo prebuild and CocoaPods first')
  return path.join(iosDirectory, workspaces[0], 'contents.xcworkspacedata')
}
