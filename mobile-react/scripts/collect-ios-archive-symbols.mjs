import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function uuids(file) {
  const output = execFileSync('xcrun', ['dwarfdump', '--uuid', file], { encoding: 'utf8' })
  return [...output.matchAll(/UUID: ([0-9A-F-]{36}) /gi)].map(match => match[1].toUpperCase()).sort()
}

function symbolBundles(directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(directory, entry.name)
    if (entry.name.endsWith('.dSYM')) result.push(child)
    else result.push(...symbolBundles(child))
  }
  return result
}

export function collectSymbols(archive, pods, readUuids = uuids) {
  const app = path.join(archive, 'Products', 'Applications', 'AgentsDock.app')
  const destination = path.join(archive, 'dSYMs')
  assert.ok(existsSync(app), 'Expected a production AgentsDock archive')
  mkdirSync(destination, { recursive: true })
  const candidates = symbolBundles(pods)
  const result = { copied: [], present: [], unavailable: [] }
  for (const entry of readdirSync(path.join(app, 'Frameworks'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.framework')) continue
    const binary = path.join(app, 'Frameworks', entry.name, entry.name.slice(0, -'.framework'.length))
    const expected = readUuids(binary)
    assert.ok(expected.length > 0, `No UUID for ${entry.name}`)
    const matches = candidate => {
      const actual = readUuids(candidate)
      return expected.every(uuid => actual.includes(uuid))
    }
    const target = path.join(destination, `${entry.name}.dSYM`)
    if (existsSync(target)) {
      assert.ok(matches(target), `Archive dSYM UUID mismatch for ${entry.name}`)
      result.present.push(entry.name)
      continue
    }
    const candidate = candidates.find(file => path.basename(file) === `${entry.name}.dSYM` && matches(file))
    if (!candidate) {
      result.unavailable.push(entry.name)
      continue
    }
    cpSync(candidate, target, { recursive: true, force: false, errorOnExist: true })
    result.copied.push(entry.name)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , archive, pods] = process.argv
  assert.ok(archive && pods, 'Usage: collect-ios-archive-symbols.mjs <archive> <Pods>')
  console.log(JSON.stringify(collectSymbols(path.resolve(archive), path.resolve(pods)), null, 2))
}
